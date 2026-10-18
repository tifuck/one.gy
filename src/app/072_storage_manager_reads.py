class _StorageManagerReads:

    def _mark_replica_verification_error(self, replica, message):
        # AUDIT FIX F-6 (5th audit): this is called from the READ/failover path,
        # which runs inside arbitrary web requests. The previous implementation
        # mutated the ORM object and called db.session.commit(), which would also
        # flush ANY other pending state in the request's session — a subtle way
        # for a download handler to commit unrelated half-built changes. Persist
        # the verdict on a SEPARATE short-lived engine transaction (a fresh
        # pooled connection) so the caller's session is never touched. The
        # in-memory ORM object is deliberately left alone (callers `continue`
        # past it and never re-read its status in the same pass).
        _msg = str(message)[:500]
        _now = datetime.now(timezone.utc)
        # AUDIT FIX F-6 (5th audit): persist the verdict on a SEPARATE short-lived
        # engine transaction (a fresh pooled connection) so the caller's (web
        # request) session is never committed by this read/failover-path helper.
        rid = getattr(replica, 'id', None)
        if rid is None:
            return
        try:
            model = type(replica)
            tbl = model.__table__
            observed_status = getattr(replica, 'status', None)
            with db.engine.begin() as conn:
                stmt = tbl.update().where(tbl.c.id == rid)
                if observed_status is not None:
                    stmt = stmt.where(tbl.c.status == observed_status)
                result = conn.execute(
                    stmt.values(
                        status='error',
                        last_error=_msg,
                        verified_at=_now,
                    )
                )
            if result.rowcount:
                from sqlalchemy.orm.attributes import set_committed_value
                set_committed_value(replica, 'status', 'error')
                set_committed_value(replica, 'last_error', _msg)
                set_committed_value(replica, 'verified_at', _now)
        except Exception as e:
            print(f'[STORAGE] Failed to mark replica verification error: {e}')

    def _remote_exists_verified(self, backend, category, disk_id):
        if hasattr(backend, 'exists_verified'):
            return backend.exists_verified(category, disk_id)
        return backend.exists(category, disk_id)

    def _remote_checksum_hex(self, backend, category, disk_id):
        if not hasattr(backend, 'checksum'):
            return None
        try:
            return backend.checksum(category, disk_id)
        except Exception as e:
            print(f'[STORAGE] Remote checksum failed for {category}/{disk_id}: {e}')
            return None

    def _verify_remote_replica_payload(self, replica, backend, category, disk_id,
                                       expected_size, expected_checksum, context,
                                       update_replica=False):
        try:
            if not self._remote_exists_verified(backend, category, disk_id):
                self._mark_replica_verification_error(
                    replica,
                    f'VERIFICATION FAILED DURING {context}: {category}/{disk_id} MISSING ON NODE {replica.node_id}'
                )
                return False
        except Exception as e:
            print(f'[STORAGE] Skipping {context} for {category}/{disk_id}: remote node {replica.node_id} unreachable: {e}')
            return False

        remote_size = None
        if expected_size is not None:
            try:
                remote_size = backend.size(category, disk_id)
            except Exception as e:
                print(f'[STORAGE] Skipping {context} for {category}/{disk_id}: remote size check failed on node {replica.node_id}: {e}')
                return False
            # size() returns None on any backend error: unknown, not a mismatch.
            if remote_size is None:
                print(f'[STORAGE] Skipping {context} for {category}/{disk_id}: remote size unavailable on node {replica.node_id}')
                return False
            if int(remote_size) != int(expected_size):
                self._mark_replica_verification_error(
                    replica,
                    f'VERIFICATION FAILED DURING {context}: {category}/{disk_id} SIZE MISMATCH ON NODE {replica.node_id}'
                )
                return False

        if not expected_checksum:
            print(f'[STORAGE] Skipping {context} for {category}/{disk_id}: expected checksum unavailable')
            return False
        remote_checksum = self._remote_checksum_hex(backend, category, disk_id)
        if not remote_checksum:
            print(f'[STORAGE] Skipping {context} for {category}/{disk_id}: remote checksum unavailable on node {replica.node_id}')
            return False
        if remote_checksum != expected_checksum:
            self._mark_replica_verification_error(
                replica,
                f'VERIFICATION FAILED DURING {context}: {category}/{disk_id} CHECKSUM MISMATCH ON NODE {replica.node_id}'
            )
            return False

        if update_replica:
            replica.checksum = expected_checksum
            # AUDIT FIX (size-only replicas excluded from failover): we just
            # compared a LIVE remote hash against the authoritative checksum, so
            # this replica is now genuinely verified — record that explicitly.
            replica.checksum_verified = True
            replica.verified_at = datetime.now(timezone.utc)
            replica.last_error = None
            if hasattr(replica, 'size_bytes') and remote_size is not None:
                replica.size_bytes = int(remote_size)
        return True

    @staticmethod
    def _cache_expectations_known(expected_size, expected_checksum):
        """True when we hold at least ONE authoritative expectation to test a
        payload against. Callers use this to tell 'this payload is wrong' apart
        from 'we cannot say' -- the two must lead to different actions (discard
        vs. keep-but-refuse-to-serve)."""
        return expected_size is not None or bool(expected_checksum)

    def _cache_payload_valid(self, cache_path, expected_size, expected_checksum, label):
        """Validate a cached/staged payload against authoritative expectations.

        AUDIT FIX (unknown must not mean valid): with expected_size None and a
        falsy expected_checksum this used to fall through to `return True` after
        only an os.path.isfile() test, so an arbitrary -- possibly truncated or
        stale -- file was certified as authoritative. That reached
        load_thumbnail()'s cache step whenever the thumbnail checksum columns
        were NULL, and, worse, _stage_remote_into_cache() used the same helper to
        decide whether a freshly downloaded remote object could be published into
        the SHARED cache, so unverified remote bytes were promoted wholesale.
        Absence of evidence is not evidence of integrity: with nothing to check
        against we now return False."""
        if not cache_path or not os.path.isfile(cache_path):
            return False
        if not self._cache_expectations_known(expected_size, expected_checksum):
            print(f'[STORAGE] [WARNING] Refusing to treat {label} as valid: no authoritative '
                  f'size or checksum is recorded, so its integrity cannot be established')
            return False
        try:
            if expected_size is not None and os.path.getsize(cache_path) != int(expected_size):
                return False
            if expected_checksum:
                return self._sha256_file(cache_path) == expected_checksum
        except Exception as e:
            print(f'[STORAGE] Cache validation failed for {label}: {e}')
            return False
        return True

    def _discard_cache_payload(self, cache_path):
        try:
            if cache_path and os.path.isfile(cache_path):
                os.remove(cache_path)
        except OSError:
            pass

    def _log_size_only_read_warning(self, category, disk_id, node_id):
        key = (category, disk_id, node_id)
        now = time.monotonic()
        with self._size_only_read_warnings_lock:
            last = self._size_only_read_warnings.get(key)
            if last is not None and (now - last) < self.SIZE_ONLY_READ_WARN_COOLDOWN_SECONDS:
                return
            self._size_only_read_warnings[key] = now
            if len(self._size_only_read_warnings) > 2048:
                self._size_only_read_warnings = {key: now}
        print(
            f'[STORAGE] [WARNING] Serving {category}/{disk_id} from {self._node_name(node_id)} '
            f'with SIZE-ONLY verification (remote checksum unavailable)'
        )

    def _stage_remote_into_cache(self, backend, category, disk_id, cache_path,
                                 expected_size, expected_checksum, label):
        """AUDIT FIX F6: fetch a remote object into a UNIQUE temp file, validate it,
        then atomically publish it to the shared .cache_<id> path. Returns True on
        success (cache_path holds a verified copy) or False on validation failure.

        Previously the read path called backend.get(category, id, cache_path) with a
        fixed cache_path; the SSH/S3 backends stage to '<cache_path>.sftp_tmp' /
        '.s3_tmp' (also fixed), so two concurrent cold reads of the same object
        could clobber each other's staging file and corrupt the cache. The unique
        '.remote_*' temp (recognized as an internal artifact) makes each reader's
        staging private; os.replace publishes atomically."""
        import tempfile as _tempfile
        cache_dir = os.path.dirname(cache_path) or '.'
        tmp_fd, tmp_path = _tempfile.mkstemp(prefix='.remote_', dir=cache_dir)
        os.close(tmp_fd)
        try:
            backend.get(category, disk_id, tmp_path)
            if not self._cache_payload_valid(tmp_path, expected_size, expected_checksum, label):
                self._discard_cache_payload(tmp_path)
                return False
            os.replace(tmp_path, cache_path)
            return True
        except Exception:
            self._discard_cache_payload(tmp_path)
            raise

    def _current_file_read_replicas(self, filename):
        """Ordered read sources for a file: fully-matching replicas first, then
        genuinely-synced-but-unverified ones as a last-resort failover.

        AUDIT FIX (size-only replicas excluded from failover): this query used to
        require `checksum IS NOT NULL` AND `checksum == File.payload_checksum`.
        Any target that could not confirm its hash end-to-end recorded
        checksum=NULL, so a perfectly healthy remote mirror was INVISIBLE to
        failover: if the local copy went missing or corrupt, get_file_path()
        returned None (404) even though the bytes existed on the backup node.
        Failover was therefore silently disabled precisely for the nodes that
        needed it most.

        Unverified rows are now returned as a SECOND-CHOICE tier, and only when
        File.payload_checksum is known -- get_file_path() re-hashes the fetched
        bytes against it before serving, so unverified bytes are never handed to
        a client unchecked."""
        file_id = filename.replace('.enc', '') if filename.endswith('.enc') else filename
        file_obj = db.session.get(File, file_id)
        if not file_obj:
            return file_id, None, []
        base = FileReplica.query.filter(
            FileReplica.file_id == file_id,
            FileReplica.status == 'synced',
        )
        query = base.filter(
            FileReplica.size_bytes.isnot(None),
            FileReplica.checksum.isnot(None),
        )
        if file_obj.disk_size is not None:
            query = query.filter(FileReplica.size_bytes == int(file_obj.disk_size))
        if file_obj.payload_checksum:
            query = query.filter(FileReplica.checksum == file_obj.payload_checksum)
        # AUDIT FIX: include the local node as a valid read source. In
        # single-node and cache-only deployments the local file is the
        # authoritative copy; excluding it here caused 404s when no remote
        # synced rows existed.
        replicas = query.order_by(FileReplica.verified_at.desc(), FileReplica.id.desc()).all()
        ordered = self._order_read_replicas(replicas)
        if file_obj.payload_checksum:
            fallback_query = base.filter(FileReplica.checksum.is_(None))
            if file_obj.disk_size is not None:
                fallback_query = fallback_query.filter(db.or_(
                    FileReplica.size_bytes.is_(None),
                    FileReplica.size_bytes == int(file_obj.disk_size),
                ))
            fallback = fallback_query.order_by(
                FileReplica.verified_at.desc(), FileReplica.id.desc()).all()
            if fallback:
                ordered = ordered + self._order_read_replicas(fallback)
        return file_id, file_obj, ordered

    def _current_note_read_replicas(self, note_id):
        note_obj = db.session.get(Note, note_id)
        if not note_obj:
            return None, None, None, []
        note_version = int(note_obj.content_version or 1)
        note_checksum = note_obj.content_checksum
        if not note_checksum:
            return note_obj, note_version, note_checksum, []
        base = NoteReplica.query.filter(
            NoteReplica.note_id == note_id,
            NoteReplica.status == 'synced',
            NoteReplica.synced_version == note_version,
            db.or_(
                NoteReplica.target_version.is_(None),
                NoteReplica.target_version == 0,
                NoteReplica.target_version == note_version,
            ),
        )
        query = base.filter(NoteReplica.checksum == note_checksum)
        # AUDIT FIX: include the local node as a valid read source.
        replicas = query.order_by(NoteReplica.verified_at.desc(), NoteReplica.id.desc()).all()
        ordered = self._order_read_replicas(replicas)
        # AUDIT FIX (size-only replicas excluded from failover): a note written
        # to a target that could not confirm its hash records checksum=NULL. Such
        # a replica is genuinely synced at the right version, so it must remain
        # usable for failover -- appended AFTER the checksum-matching tier, and
        # only ever served after get_note_path() re-hashes the fetched bytes
        # against the canonical note_checksum.
        fallback = base.filter(NoteReplica.checksum.is_(None)).order_by(
            NoteReplica.verified_at.desc(), NoteReplica.id.desc()).all()
        if fallback:
            ordered = ordered + self._order_read_replicas(fallback)
        return note_obj, note_version, note_checksum, ordered

    def _get_read_node(self, category, file_id):
        """Find best node to read from. Tries primary, then any node."""
        self._ensure_local_backend_ready()
        self._check_backends_freshness()
        backends, _local_backend, _local_node_id, _version = self._backend_state_snapshot()
        primary_id = self._get_primary_node_id(backends)
        if primary_id and primary_id in backends:
            backend = backends[primary_id]
            try:
                if backend.exists(category, file_id):
                    return primary_id, backend
            except Exception:
                pass
        for nid, backend in backends.items():
            if nid == primary_id:
                continue
            try:
                if backend.exists(category, file_id):
                    return nid, backend
            except Exception:
                continue
        return None, None

    def _get_write_node(self):
        """Find best node for operations that can route writes.

        Upload/store paths intentionally write local-first and do not call this
        helper; the health gate here applies to routed/fallback write users.
        """
        self._ensure_local_backend_ready()
        self._check_backends_freshness()
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        # AUDIT FIX P1-8: check StorageNode.status before routing writes to a
        # node — an offline/error node should not accept uploads because the
        # replication cycle won't use it as a source, causing silent stalls.
        def _node_ok(nid):
            if nid is None:
                return False
            try:
                node = db.session.get(StorageNode, nid)
                return node is not None and node.status not in ('offline', 'error')
            except Exception:
                return False
        if local_node_id and local_node_id in backends and _node_ok(local_node_id):
            return local_node_id, backends[local_node_id]
        if local_backend and local_node_id and _node_ok(local_node_id):
            return local_node_id, local_backend
        primary_id = self._get_primary_node_id(backends)
        # AUDIT FIX L10: previously this used `self._backends[primary_id]`
        # which can raise KeyError if a concurrent worker is in the middle
        # of refreshing/removing the backend after _get_primary_node_id read.
        # Use `.get()` and fall through to any other available backend.
        if primary_id and _node_ok(primary_id):
            backend = backends.get(primary_id)
            if backend is not None:
                return primary_id, backend
        # Fall back to any online/syncing backend
        if backends:
            for nid, backend in backends.items():
                if _node_ok(nid):
                    return nid, backend
        return None, None

    # ---- File operations (uploads/) ----

    def _update_file_disk_metadata_from_local(self, file_obj, local_path):
        """Backfill MISSING File.disk_size / File.payload_checksum from the local
        file. Returns True if DB changes were made and committed.

        AUDIT FIX P0-1: this must NEVER overwrite an existing authoritative
        disk_size/payload_checksum with values derived from the local bytes. A
        truncated or bit-rotted local copy would otherwise poison the canonical
        metadata, and because the remote read path filters synced replicas by
        File.disk_size/File.payload_checksum (see _current_file_read_replicas),
        a poisoned size/checksum would make every HEALTHY remote replica fail to
        match — turning a recoverable local-corruption event into an unreadable
        file. We therefore only fill a field that is currently unset, and only
        when the local copy is consistent with whichever authoritative field is
        already present.
        """
        if not file_obj or not local_path or not os.path.isfile(local_path):
            return False
        # Nothing to backfill — both authoritative fields already present.
        if file_obj.disk_size is not None and file_obj.payload_checksum:
            return False
        try:
            local_size = os.path.getsize(local_path)
            local_checksum = self._sha256_file(local_path)
        except Exception as e:
            print(f'[STORAGE] Failed to compute local metadata for {file_obj.id}: {e}')
            return False
        # If one authoritative field is known, require the local copy to agree
        # with it before trusting the local bytes to fill the other one.
        if file_obj.payload_checksum and local_checksum != file_obj.payload_checksum:
            print(f'[STORAGE] Refusing to backfill metadata for file {file_obj.id}: '
                  f'local copy does not match known payload checksum')
            return False
        if file_obj.disk_size is not None and int(file_obj.disk_size) != int(local_size):
            print(f'[STORAGE] Refusing to backfill metadata for file {file_obj.id}: '
                  f'local size {local_size} != known disk_size {file_obj.disk_size}')
            return False
        changed = False
        if file_obj.disk_size is None:
            file_obj.disk_size = int(local_size)
            changed = True
        if not file_obj.payload_checksum:
            file_obj.payload_checksum = local_checksum
            changed = True
        if changed:
            try:
                db.session.commit()
                print(f'[STORAGE] Backfilled disk metadata for file {file_obj.id} from local copy')
            except Exception as e:
                db.session.rollback()
                print(f'[STORAGE] Failed to commit disk metadata backfill for {file_obj.id}: {e}')
                return False
        return changed

    def _local_payload_corroborated(self, file_id, local_checksum, local_size):
        """True when a synced replica on ANOTHER node reports exactly these bytes.

        AUDIT FIX (upload/download integrity): used to decide whether local bytes
        may be promoted to the authoritative File.payload_checksum. A second,
        independent copy agreeing on the SHA-256 is the only evidence available
        server-side that the local copy is not silently bit-rotted."""
        if not local_checksum:
            return False
        try:
            query = FileReplica.query.filter(
                FileReplica.file_id == file_id,
                FileReplica.status == 'synced',
                FileReplica.checksum == local_checksum,
                # AUDIT FIX (verified vs. merely recorded): a replica whose write
                # was accepted on SIZE ONLY records the checksum we intended to
                # write, not one the node confirmed. It therefore corroborates
                # nothing and must not be allowed to bless local bytes as the
                # authoritative File.payload_checksum. NULL (legacy/unknown) is
                # still accepted so this cannot regress pre-existing behaviour.
                FileReplica.checksum_verified.isnot(False),
            )
            if self._local_node_id:
                query = query.filter(FileReplica.node_id != self._local_node_id)
            for replica in query.all():
                if replica.size_bytes is None or int(replica.size_bytes) == int(local_size):
                    return True
        except Exception as e:
            print(f'[STORAGE] Could not look for a corroborating replica for {file_id}: {e}')
        return False

    def _verify_local_file_integrity(self, file_obj, local_path, context):
        """Verify the local file matches the DB checksum. Returns True if OK.
        If checksum mismatch, logs and returns False so caller can fall back to
        remote.

        AUDIT FIX (upload/download integrity): when File.payload_checksum was
        empty this used to write whatever the local bytes hashed to and COMMIT
        it -- on EVERY download, since get_file_path() calls this on the read
        path. That permanently blessed whatever happened to be on disk as the
        canonical checksum, which is exactly the metadata poisoning that
        _update_file_disk_metadata_from_local() documents as forbidden: the
        healthy-replica filter in _current_file_read_replicas() matches remote
        replicas against File.payload_checksum/disk_size, so a poisoned value
        turns a recoverable local-corruption event into an unreadable file.
        A read path now only backfills when a replica on another node
        CORROBORATES the local bytes; otherwise the column stays NULL and the
        gap is logged for the scrub to resolve."""
        if not file_obj or not local_path or not os.path.isfile(local_path):
            return False
        try:
            local_size = os.path.getsize(local_path)
        except Exception:
            return False
        expected_size = int(file_obj.disk_size) if file_obj.disk_size is not None else None
        if expected_size is not None and int(local_size) != int(expected_size):
            print(f'[STORAGE] Local file size mismatch for {file_obj.id}: expected {expected_size}, got {local_size} ({context})')
            return False
        local_checksum = None
        try:
            local_checksum = self._sha256_file(local_path)
        except Exception as e:
            print(f'[STORAGE] Failed to checksum local file {file_obj.id}: {e}')
            return False
        if not file_obj.payload_checksum:
            if self._local_payload_corroborated(file_obj.id, local_checksum, local_size):
                file_obj.payload_checksum = local_checksum
                try:
                    db.session.commit()
                    print(f'[STORAGE] Backfilled payload checksum for {file_obj.id} from a corroborating replica ({context})')
                except Exception:
                    db.session.rollback()
            else:
                print(f'[WARNING] File {file_obj.id} has no payload_checksum and no replica corroborates the '
                      f'local copy; serving it but NOT adopting the local hash as authoritative ({context})')
            return True
        if local_checksum != file_obj.payload_checksum:
            _log_payload_corruption(
                file_obj.id, 'local-payload',
                file_obj.payload_checksum, local_checksum,
                source_path=local_path,
            )
            return False
        return True

    def get_file_path(self, filename):
        """Get local path for a file. Stages from remote if needed.
        Returns None if the file cannot be found on any backend."""
        _validate_storage_file_id(filename)
        try:
            self._ensure_local_backend_ready()
        except Exception as e:
            print(f'[STORAGE] Failed to initialize local backend before reading files/{filename}: {e}')
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        # Track whether the local canonical copy was already proven corrupt
        # during the top-of-function check, so the final fallback does not
        # re-serve bytes that were just rejected. See AUDIT FIX P0-1.
        _local_corrupt = False
        # Check canonical path (when local node is configured)
        try:
            if local_backend and local_backend.exists('files', filename):
                local_path = local_backend.get_path('files', filename)
                file_id = filename.replace('.enc', '') if filename.endswith('.enc') else filename
                file_obj = db.session.get(File, file_id)
                if file_obj:
                    if not self._verify_local_file_integrity(file_obj, local_path, 'GET_FILE_PATH'):
                        # Local copy is corrupt; fall through to remote sources
                        _local_corrupt = True
                    else:
                        return local_path
                else:
                    return local_path
        except Exception as e:
            print(f'[STORAGE] Failed to check local file files/{filename}: {e}')

        file_id, file_obj, replicas = self._current_file_read_replicas(filename)
        first_replica = replicas[0] if replicas else None
        expected_cache_size = None
        expected_cache_checksum = file_obj.payload_checksum if file_obj and file_obj.payload_checksum else (first_replica.checksum if first_replica else None)
        if file_obj and file_obj.disk_size is not None:
            expected_cache_size = int(file_obj.disk_size)
        elif first_replica and first_replica.size_bytes is not None:
            expected_cache_size = int(first_replica.size_bytes)

        # Check local cache (when local node is NOT configured), but only if it
        # still matches a current synced replica's size/checksum metadata.
        cache_path = os.path.join(self._app.config['UPLOAD_FOLDER'], f'.cache_{filename}')
        if self._cache_payload_valid(cache_path, expected_cache_size, expected_cache_checksum, f'files/{filename}'):
            return cache_path
        # AUDIT FIX (unknown must not mean valid): only DISCARD a cached payload
        # we were actually able to prove wrong. When no authoritative size or
        # checksum exists we can neither serve it nor condemn it, so leave the
        # bytes on disk (they may be the last copy) and refuse to serve them.
        if self._cache_expectations_known(expected_cache_size, expected_cache_checksum):
            self._discard_cache_payload(cache_path)

        # A committed staged rewrite updates the authoritative checksum/size in
        # the DB just before finalize_staged_file() atomically renames .new into
        # place. If a read lands in that narrow window, the canonical local file
        # still holds the old bytes and fails integrity. Serve the staged .new
        # copy only when it matches the committed checksum.
        if expected_cache_checksum and local_backend:
            try:
                staged_path = local_backend.get_path('files', filename + '.new')
            except Exception:
                staged_path = None
            if self._cache_payload_valid(staged_path, expected_cache_size, expected_cache_checksum, f'files/{filename}.new'):
                print(f'[STORAGE] Serving committed staged file window for files/{filename}')
                return staged_path

        # Fetch only from replicas marked current and synced.
        for replica in replicas:
            backend = backends.get(replica.node_id)
            if not backend:
                continue
            # AUDIT FIX F1: the canonical local copy was already integrity-checked
            # at the top of this function. If it was valid we returned it; if it
            # was corrupt (_local_corrupt) we must NOT re-serve it here. Skip the
            # local node so this loop only fetches from remote replicas, mirroring
            # load_thumbnail(). _LocalBackend now also exposes checksum() as a
            # second layer of defense for any caller that does reach it.
            if local_node_id is not None and replica.node_id == local_node_id:
                continue
            if file_obj and file_obj.disk_size is not None:
                expected_size = int(file_obj.disk_size)
            elif replica.size_bytes is not None:
                expected_size = int(replica.size_bytes)
            else:
                expected_size = None
            expected_checksum = file_obj.payload_checksum if file_obj and file_obj.payload_checksum else replica.checksum
            # AUDIT FIX (never serve unverified bytes): a replica from the
            # unverified failover tier has checksum=NULL, so the ONLY way to
            # prove the fetched bytes are correct is the authoritative
            # File.payload_checksum. Without it we cannot check anything and must
            # refuse rather than hand over unvalidated data.
            if not expected_checksum:
                print(f'[STORAGE] [WARNING] Skipping remote read of files/{filename} from '
                      f'{self._node_name(replica.node_id)}: no authoritative checksum to verify against')
                continue
            _replica_unverified = not replica.checksum
            try:
                if not self._remote_exists_verified(backend, 'files', filename):
                    self._mark_replica_verification_error(
                        replica,
                        f'VERIFICATION FAILED DURING REMOTE READ: files/{filename} MISSING ON NODE {replica.node_id}'
                    )
                    continue
                remote_size = backend.size('files', filename)
                if expected_size is not None and remote_size is None:
                    print(f'[STORAGE] Skipping remote read of files/{filename} from node {replica.node_id}: remote size unavailable')
                    continue
                if expected_size is not None and int(remote_size) != int(expected_size):
                    self._mark_replica_verification_error(
                        replica,
                        f'VERIFICATION FAILED DURING REMOTE READ: files/{filename} SIZE MISMATCH ON NODE {replica.node_id}'
                    )
                    continue
                remote_checksum = self._remote_checksum_hex(backend, 'files', filename)
                if remote_checksum and remote_checksum != expected_checksum:
                    self._mark_replica_verification_error(
                        replica,
                        f'VERIFICATION FAILED DURING REMOTE READ: files/{filename} CHECKSUM MISMATCH ON NODE {replica.node_id}'
                    )
                    continue
                if isinstance(backend, _LocalBackend):
                    return backend.get_path('files', filename)
                # _stage_remote_into_cache re-hashes the downloaded bytes against
                # expected_checksum before publishing, so an unverified-tier
                # replica is proven correct here before it is ever served.
                if self._stage_remote_into_cache(backend, 'files', filename, cache_path,
                                                 expected_size, expected_checksum, f'files/{filename}'):
                    if not remote_checksum:
                        self._log_size_only_read_warning('files', filename, replica.node_id)
                    if _replica_unverified:
                        print(f'[STORAGE] [WARNING] Served files/{filename} via failover from '
                              f'{self._node_name(replica.node_id)} whose replica row carried NO recorded '
                              f'checksum; bytes were re-hashed against the authoritative payload checksum '
                              f'before serving')
                    return cache_path
                self._mark_replica_verification_error(
                    replica,
                    f'VERIFICATION FAILED DURING REMOTE READ: files/{filename} DOWNLOADED CHECKSUM MISMATCH ON NODE {replica.node_id}'
                )
            except Exception as e:
                print(f'[STORAGE] Failed to fetch file {filename} from remote node {replica.node_id}: {e}')

        # AUDIT FIX P0-1: final fallback to local file as authoritative copy
        # even if there are no synced remote replicas (single-node / cache-only
        # / orphan cleanup edge cases). Metadata was already updated/verified
        # above if the file existed at the top; this catches concurrent writes
        # and races. However, if the top-of-function integrity check already
        # proved the local copy is corrupt, do NOT serve those corrupt bytes
        # — return None (download gets 404 / triggers repair) instead.
        if not _local_corrupt:
            try:
                if local_backend and local_backend.exists('files', filename):
                    local_path = local_backend.get_path('files', filename)
                    # A copy that appeared after the top-of-function check has
                    # not been verified yet; hold it to the same bar.
                    if file_obj is None or self._verify_local_file_integrity(file_obj, local_path, 'GET_FILE_PATH'):
                        return local_path
            except Exception:
                pass
        return None

    def _object_exists_anywhere(self, category, disk_id):
        """Existence probe across local + every remote backend.

        AUDIT FIX (absent vs. could-not-determine): these helpers used to
        dereference self._local_backend with NO null guard (an AttributeError on
        an uninitialised worker) and then call backend.exists(), whose SSH/S3
        implementations `except Exception: return False` — so an auth failure, a
        timeout or an unreachable node reported "the object does not exist".
        Callers use that answer to decide whether a payload still needs deleting
        or may be treated as gone, and answering "no" for a node we could not
        reach is the dangerous direction. We now use exists_verified() (which
        raises instead of lying) where available and return True when ANY node is
        indeterminate, i.e. "it may exist" — the fail-closed answer."""
        self._ensure_local_backend_ready()
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        if local_backend is not None:
            try:
                if local_backend.exists(category, disk_id):
                    return True
            except Exception as e:
                print(f'[STORAGE] Local existence check failed for {category}/{disk_id}: {e}')
                return True
        indeterminate = False
        for nid, backend in backends.items():
            if nid == local_node_id or backend is None:
                continue
            try:
                if self._remote_exists_verified(backend, category, disk_id):
                    return True
            except Exception as e:
                indeterminate = True
                print(f'[STORAGE] [WARNING] Could not determine whether {category}/{disk_id} exists on '
                      f'{self._node_name(nid)}: {e}')
        if indeterminate:
            print(f'[STORAGE] [WARNING] Reporting {category}/{disk_id} as POSSIBLY PRESENT because at '
                  f'least one node could not be reached — refusing to report a payload absent on a '
                  f'connectivity failure')
            return True
        return False

    def file_exists(self, filename):
        return self._object_exists_anywhere('files', filename)

    def file_size(self, filename):
        """Size of a file payload, or None when it cannot be determined.

        AUDIT FIX (absent vs. could-not-determine): this returned 0 both for
        "the object is genuinely empty/absent" and for "every backend errored",
        and dereferenced self._local_backend without a null guard."""
        self._ensure_local_backend_ready()
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        if local_backend is not None:
            try:
                sz = local_backend.size('files', filename)
                if sz is not None:
                    return sz
            except Exception as e:
                print(f'[STORAGE] Local size check failed for files/{filename}: {e}')
        for nid, backend in backends.items():
            if nid == local_node_id or backend is None:
                continue
            try:
                sz = backend.size('files', filename)
                if sz is not None:
                    return sz
            except Exception:
                continue
        return None

    def _tracked_file_size_bytes(self, file_id, exclude_node_id=None):
        # AUDIT FIX P0-1: prefer the DB-authoritative disk_size and any verified
        # sibling replica over the raw local on-disk size. A corrupt/truncated
        # local copy must never become the "expected" size used to validate
        # healthy remote replicas (read path + integrity scrub). The local disk
        # is only consulted as a last resort when no authoritative value exists.
        file_obj = db.session.get(File, file_id)
        if file_obj and file_obj.disk_size is not None:
            return int(file_obj.disk_size)
        try:
            sibling_query = FileReplica.query.filter(
                FileReplica.file_id == file_id,
                FileReplica.status == 'synced',
                FileReplica.size_bytes.isnot(None)
            )
            if exclude_node_id is not None:
                sibling_query = sibling_query.filter(FileReplica.node_id != exclude_node_id)
            sibling = sibling_query.order_by(FileReplica.verified_at.desc(), FileReplica.id.desc()).first()
            if sibling and sibling.size_bytes is not None:
                return int(sibling.size_bytes)
        except Exception:
            pass
        filename = f'{file_id}.enc'
        try:
            if self._local_backend and self._local_backend.exists('files', filename):
                local_size = self._local_backend.size('files', filename)
                if local_size is not None:
                    return int(local_size)
        except Exception:
            pass
        return None

    def _tracked_file_checksum_hex(self, file_id, exclude_node_id=None):
        # AUDIT FIX P0-1: prefer the DB-authoritative payload_checksum and any
        # verified sibling replica checksum over re-hashing the local copy. With
        # the previous local-first ordering, the integrity scrub's local-file
        # audit derived the "expected" checksum from the very file it was
        # auditing (exclude_node_id=local still hit the local disk first), so it
        # compared the local copy against itself and could NEVER detect local
        # bit-rot. The local disk is now only a last-resort fallback.
        file_obj = db.session.get(File, file_id)
        if file_obj and file_obj.payload_checksum:
            return file_obj.payload_checksum
        try:
            sibling_query = FileReplica.query.filter(
                FileReplica.file_id == file_id,
                FileReplica.status == 'synced',
                FileReplica.checksum.isnot(None),
                # AUDIT FIX (verified vs. merely recorded): this value becomes
                # the "expected" checksum for integrity decisions (scrub verdicts,
                # local-purge gating). A size-only-accepted replica's checksum was
                # never confirmed against the stored bytes, so it must not define
                # the truth. NULL stays accepted (legacy rows).
                FileReplica.checksum_verified.isnot(False),
            )
            if exclude_node_id is not None:
                sibling_query = sibling_query.filter(FileReplica.node_id != exclude_node_id)
            sibling = sibling_query.order_by(FileReplica.verified_at.desc(), FileReplica.id.desc()).first()
            if sibling and sibling.checksum:
                return sibling.checksum
        except Exception:
            pass
        filename = f'{file_id}.enc'
        try:
            if self._local_backend and self._local_backend.exists('files', filename):
                local_path = self._local_backend.get_path('files', filename)
                if local_path and os.path.isfile(local_path):
                    return self._sha256_file(local_path)
        except Exception:
            pass
        return None

    def _tracked_note_checksum_hex(self, note_id, exclude_node_id=None):
        # AUDIT FIX P0-1: DB content_checksum is authoritative; a verified
        # sibling replica is the next-best source. The local on-disk note is the
        # last resort so a corrupt local copy cannot define the expected value.
        note_obj = db.session.get(Note, note_id)
        if note_obj and note_obj.content_checksum:
            return note_obj.content_checksum
        try:
            sibling_query = NoteReplica.query.filter(
                NoteReplica.note_id == note_id,
                NoteReplica.status == 'synced',
                NoteReplica.checksum.isnot(None),
                # AUDIT FIX (verified vs. merely recorded): see _tracked_file_checksum_hex.
                NoteReplica.checksum_verified.isnot(False),
            )
            if exclude_node_id is not None:
                sibling_query = sibling_query.filter(NoteReplica.node_id != exclude_node_id)
            sibling = sibling_query.order_by(NoteReplica.verified_at.desc(), NoteReplica.id.desc()).first()
            if sibling and sibling.checksum:
                return sibling.checksum
        except Exception:
            pass
        try:
            if self._local_backend and self._local_backend.exists('notes', note_id):
                local_path = self._local_backend.get_path('notes', note_id)
                if local_path and os.path.isfile(local_path):
                    return self._sha256_file(local_path)
        except Exception:
            pass
        return None

    def _thumbnail_checksum_hex(self, file_id, thumb_type):
        """Return SHA-256 of the local thumbnail file, or None if not present.
        Legacy DB blob columns are no longer consulted (dead columns per policy)."""
        ext = '.e2e' if thumb_type == 'e2e' else '.jpg'
        thumb_id = f'{file_id}{ext}'
        try:
            if self._local_backend and self._local_backend.exists('thumbnails', thumb_id):
                local_path = self._local_backend.get_path('thumbnails', thumb_id)
                if local_path and os.path.isfile(local_path):
                    return self._sha256_file(local_path)
        except Exception:
            pass
        return None

    def _tracked_thumbnail_checksum_hex(self, file_id, thumb_type, exclude_node_id=None):
        # AUDIT FIX F-2 (5th audit): prefer the DB-authoritative thumbnail
        # checksum recorded on the File row at generation time. This is the
        # strongest authority — independent of any replica/local disk — so a
        # first-synced corrupt thumbnail can never define the expected value.
        # AUDIT FIX P0-1 / P2-2: failing that, prefer a verified sibling
        # replica's recorded checksum over re-hashing the local on-disk
        # thumbnail (with the old local-first ordering the scrub's
        # local-thumbnail audit compared the local disk against itself, so
        # local thumbnail corruption was undetectable). The local disk hash is
        # only used as a last resort when no authoritative value exists.
        try:
            file_obj = db.session.get(File, file_id)
            if file_obj is not None:
                _db_sum = file_obj.thumbnail_e2e_checksum if thumb_type == 'e2e' else file_obj.thumbnail_checksum
                if _db_sum:
                    return _db_sum
        except Exception:
            pass
        try:
            sibling_query = ThumbnailReplica.query.filter(
                ThumbnailReplica.file_id == file_id,
                ThumbnailReplica.thumb_type == thumb_type,
                ThumbnailReplica.status == 'synced',
                ThumbnailReplica.checksum.isnot(None),
                # AUDIT FIX (verified vs. merely recorded): see _tracked_file_checksum_hex.
                ThumbnailReplica.checksum_verified.isnot(False),
            )
            if exclude_node_id is not None:
                sibling_query = sibling_query.filter(ThumbnailReplica.node_id != exclude_node_id)
            sibling = sibling_query.order_by(ThumbnailReplica.verified_at.desc(), ThumbnailReplica.id.desc()).first()
            if sibling and sibling.checksum:
                return sibling.checksum
        except Exception:
            pass
        return self._thumbnail_checksum_hex(file_id, thumb_type)
