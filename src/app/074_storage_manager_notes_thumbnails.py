class _StorageManagerNotesThumbnails:

    def _current_note_state(self, note_id):
        note_obj = db.session.get(Note, note_id)
        if not note_obj:
            return None, None, None
        content_version = int(note_obj.content_version or 1)
        checksum = note_obj.content_checksum
        if not checksum:
            path = None
            try:
                path = self.get_note_path(note_id)
            except Exception:
                path = None
            if path and os.path.isfile(path):
                try:
                    checksum = self._sha256_file(path)
                except Exception:
                    checksum = None
            if checksum:
                note_obj.content_checksum = checksum
        return note_obj, content_version, checksum

    def _note_replica_is_current(self, replica, note_obj):
        if not replica or not note_obj:
            return False
        note_version = int(note_obj.content_version or 1)
        note_checksum = note_obj.content_checksum
        if replica.status != 'synced':
            return False
        if (replica.synced_version or 0) != note_version:
            return False
        if note_checksum and replica.checksum != note_checksum:
            return False
        if (replica.target_version or 0) not in (0, note_version):
            return False
        return True

    def queue_note_replication(self, note_id, verified_at=None):
        """Make the latest authoritative note copy authoritative in replica state.

        Prefers the canonical local note file when present. In cache mode or
        recovery scenarios where the local canonical copy is absent, falls back to
        any readable current source node and re-queues the remaining nodes.
        """
        self._ensure_local_backend_ready()
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        source_path = None
        source_node_id = None
        local_path = local_backend.get_path('notes', note_id) if local_backend else None
        # AUDIT FIX P2-1: verify the local copy is current (matches DB
        # content_checksum) before treating it as authoritative. A stale
        # local copy (e.g. from a failed partial write or replication race)
        # must not overwrite newer remote replicas.
        _local_is_current = False
        if local_path and os.path.isfile(local_path):
            _note_obj_pre = db.session.get(Note, note_id)
            _db_checksum = _note_obj_pre.content_checksum if _note_obj_pre else None
            if _db_checksum:
                try:
                    _local_hash = self._sha256_file(local_path)
                    _local_is_current = (_local_hash == _db_checksum)
                except Exception:
                    _local_is_current = False
            else:
                # No DB checksum to compare against — accept local as authoritative
                _local_is_current = True
        if local_path and os.path.isfile(local_path) and _local_is_current:
            source_path = local_path
            source_node_id = local_node_id
        else:
            if local_path and os.path.isfile(local_path) and not _local_is_current:
                print(f'[STORAGE] Local note {note_id} is stale (checksum mismatch); '
                      f'falling back to remote source for reconciliation')
            note_obj, _note_version, note_checksum, replicas = self._current_note_read_replicas(note_id)
            if not note_obj or not note_checksum:
                return None
            expected_size = int(note_obj.size) if note_obj.size is not None else None
            cache_path = os.path.join(NOTES_DIR, f'.cache_{note_id}')
            for replica in replicas:
                backend = backends.get(replica.node_id)
                if not backend:
                    continue
                try:
                    if expected_size is not None:
                        remote_size = backend.size('notes', note_id)
                        if remote_size is None:
                            print(f'[STORAGE] Skipping note reconcile source notes/{note_id} on node {replica.node_id}: remote size unavailable')
                            continue
                        if int(remote_size) != int(expected_size):
                            self._mark_replica_verification_error(
                                replica,
                                f'VERIFICATION FAILED DURING NOTE RECONCILE: notes/{note_id} SIZE MISMATCH ON NODE {replica.node_id}'
                            )
                            continue
                    remote_checksum = self._remote_checksum_hex(backend, 'notes', note_id)
                    if remote_checksum and remote_checksum != note_checksum:
                        self._mark_replica_verification_error(
                            replica,
                            f'VERIFICATION FAILED DURING NOTE RECONCILE: notes/{note_id} CHECKSUM MISMATCH ON NODE {replica.node_id}'
                        )
                        continue
                    if isinstance(backend, _LocalBackend):
                        candidate_path = backend.get_path('notes', note_id)
                    else:
                        backend.get('notes', note_id, cache_path)
                        candidate_path = cache_path
                    if self._cache_payload_valid(candidate_path, expected_size, note_checksum, f'notes/{note_id}'):
                        source_path = candidate_path
                        source_node_id = replica.node_id
                        break
                    self._discard_cache_payload(cache_path)
                    self._mark_replica_verification_error(
                        replica,
                        f'VERIFICATION FAILED DURING NOTE RECONCILE: notes/{note_id} DOWNLOADED CHECKSUM MISMATCH ON NODE {replica.node_id}'
                    )
                except Exception as e:
                    print(f'[STORAGE] Failed to reconcile note {note_id} from remote node {replica.node_id}: {e}')
        if not source_path or not os.path.isfile(source_path):
            return None

        note_obj, content_version, checksum = self._current_note_state(note_id)
        if not note_obj:
            return None

        if not checksum:
            try:
                checksum = self._sha256_file(source_path)
            except Exception:
                checksum = None

        local_size = os.path.getsize(source_path)
        size_changed = note_obj.size is None or int(note_obj.size) != int(local_size)
        if size_changed:
            note_obj.size = int(local_size)
        if not note_obj.content_version or int(note_obj.content_version) < 1:
            note_obj.content_version = 1
            content_version = 1
        if checksum and note_obj.content_checksum != checksum:
            note_obj.content_checksum = checksum

        enabled_nodes = StorageNode.query.filter_by(is_enabled=True).all()
        remote_reset = 0
        remote_current = 0
        local_marked = False

        for node in enabled_nodes:
            replica = NoteReplica.query.filter_by(note_id=note_id, node_id=node.id).first()
            if node.id == source_node_id:
                if not replica:
                    replica = NoteReplica(note_id=note_id, node_id=node.id)
                    db.session.add(replica)
                replica.status = 'synced'
                replica.synced_version = content_version
                replica.target_version = content_version
                replica.checksum = checksum
                replica.verified_at = verified_at or datetime.now(timezone.utc)
                replica.error_count = 0
                replica.last_error = None
                if node.id == local_node_id:
                    local_marked = True
                continue
            if replica and self._note_replica_is_current(replica, note_obj):
                replica.target_version = content_version
                remote_current += 1
                continue
            if not replica:
                replica = NoteReplica(note_id=note_id, node_id=node.id)
                db.session.add(replica)
            replica.status = 'pending'
            replica.target_version = content_version
            replica.verified_at = None
            replica.error_count = 0
            replica.last_error = None
            remote_reset += 1

        return {
            'note_id': note_id,
            'content_version': content_version,
            'content_checksum': checksum,
            'local_size': int(local_size),
            'size_changed': size_changed,
            'local_marked': local_marked,
            'source_node_id': source_node_id,
            'remote_reset': remote_reset,
            'remote_current': remote_current,
        }

    def _update_note_metadata_from_local(self, note_obj, local_path):
        """Backfill MISSING Note.size / Note.content_checksum from the local file.
        Returns True if DB changes were made and committed.

        AUDIT FIX P0-1: mirrors _update_file_disk_metadata_from_local — never
        overwrite an existing authoritative size/checksum from local bytes (a
        stale/corrupt local note must not poison the canonical metadata used to
        filter healthy remote replicas). Backfill only, with a consistency gate.
        """
        if not note_obj or not local_path or not os.path.isfile(local_path):
            return False
        if note_obj.size is not None and note_obj.content_checksum:
            return False
        try:
            local_size = os.path.getsize(local_path)
            local_checksum = self._sha256_file(local_path)
        except Exception as e:
            print(f'[STORAGE] Failed to compute local metadata for note {note_obj.id}: {e}')
            return False
        if note_obj.content_checksum and local_checksum != note_obj.content_checksum:
            print(f'[STORAGE] Refusing to backfill metadata for note {note_obj.id}: '
                  f'local copy does not match known content checksum')
            return False
        if note_obj.size is not None and int(note_obj.size) != int(local_size):
            print(f'[STORAGE] Refusing to backfill metadata for note {note_obj.id}: '
                  f'local size {local_size} != known size {note_obj.size}')
            return False
        changed = False
        if note_obj.size is None:
            note_obj.size = int(local_size)
            changed = True
        if not note_obj.content_checksum:
            note_obj.content_checksum = local_checksum
            changed = True
        if changed:
            try:
                db.session.commit()
                print(f'[STORAGE] Backfilled disk metadata for note {note_obj.id} from local copy')
            except Exception as e:
                db.session.rollback()
                print(f'[STORAGE] Failed to commit disk metadata backfill for {note_obj.id}: {e}')
                return False
        return changed

    def _local_note_corroborated(self, note_id, local_checksum, local_size):
        if not local_checksum:
            return False
        try:
            query = NoteReplica.query.filter(
                NoteReplica.note_id == note_id,
                NoteReplica.status == 'synced',
                NoteReplica.checksum == local_checksum,
                NoteReplica.checksum_verified.isnot(False),
            )
            if self._local_node_id:
                query = query.filter(NoteReplica.node_id != self._local_node_id)
            return query.first() is not None
        except Exception as e:
            print(f'[STORAGE] Could not look for a corroborating note replica for {note_id}: {e}')
        return False

    def _verify_local_note_integrity(self, note_obj, local_path, context):
        """Verify the local note matches the DB checksum. Returns True if OK.
        If checksum is missing, computes and stores it. If checksum mismatch,
        logs and returns False so caller can fall back to remote."""
        if not note_obj or not local_path or not os.path.isfile(local_path):
            return False
        try:
            local_size = os.path.getsize(local_path)
        except Exception:
            return False
        expected_size = int(note_obj.size) if note_obj.size is not None else None
        if expected_size is not None and int(local_size) != int(expected_size):
            print(f'[STORAGE] Local note size mismatch for {note_obj.id}: expected {expected_size}, got {local_size} ({context})')
            return False
        local_checksum = None
        try:
            local_checksum = self._sha256_file(local_path)
        except Exception as e:
            print(f'[STORAGE] Failed to checksum local note {note_obj.id}: {e}')
            return False
        if not note_obj.content_checksum:
            if self._local_note_corroborated(note_obj.id, local_checksum, local_size):
                note_obj.content_checksum = local_checksum
                try:
                    db.session.commit()
                    print(f'[STORAGE] Backfilled note checksum for {note_obj.id} from a corroborating replica ({context})')
                except Exception:
                    db.session.rollback()
            else:
                print(f'[WARNING] Note {note_obj.id} has no content_checksum and no replica corroborates the '
                      f'local copy; serving it but NOT adopting the local hash as authoritative ({context})')
            return True
        if local_checksum != note_obj.content_checksum:
            _log_payload_corruption(
                note_obj.id, 'local-note-payload',
                note_obj.content_checksum, local_checksum,
                source_path=local_path,
            )
            return False
        return True

    # ---- Note operations (notes/) ----

    def get_note_path(self, note_id):
        """Get local path for a note. Stages from remote if needed.
        Returns None if the note cannot be found on any backend."""
        _validate_storage_file_id(note_id)
        self._ensure_local_backend_ready()
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        # Track whether the local canonical copy was already proven corrupt
        # during the top-of-function check, so the final fallback does not
        # re-serve bytes that were just rejected. See AUDIT FIX P0-1.
        _local_corrupt = False
        # Check canonical path (when local node is configured)
        try:
            if local_backend and local_backend.exists('notes', note_id):
                local_path = local_backend.get_path('notes', note_id)
                note_obj = db.session.get(Note, note_id)
                if note_obj:
                    if self._verify_local_note_integrity(note_obj, local_path, 'GET_NOTE_PATH'):
                        return local_path
                    # corrupt local copy; fall through to remote sources
                    _local_corrupt = True
                else:
                    return local_path
        except Exception as e:
            print(f'[STORAGE] Failed to check local note {note_id}: {e}')

        note_obj, note_version, note_checksum, replicas = self._current_note_read_replicas(note_id)
        expected_size = int(note_obj.size) if note_obj and note_obj.size is not None else None

        # Check local cache (when local node is NOT configured), but only if it
        # matches the latest authoritative note version and checksum.
        cache_path = os.path.join(NOTES_DIR, f'.cache_{note_id}')
        if self._cache_payload_valid(cache_path, expected_size, note_checksum, f'notes/{note_id}'):
            return cache_path

        # AUDIT FIX (unknown must not mean valid): discard only what we proved
        # wrong; an unverifiable cache is kept on disk but never served.
        if self._cache_expectations_known(expected_size, note_checksum):
            self._discard_cache_payload(cache_path)
        if not note_obj or not note_checksum:
            return None

        # Fetch only from replicas for the latest DB content_version/checksum.
        for replica in replicas:
            backend = backends.get(replica.node_id)
            if not backend:
                continue
            # AUDIT FIX F1: skip the local node — the canonical local copy was
            # already integrity-checked at the top of this function, so this loop
            # only fetches from remote replicas (mirrors get_file_path/load_thumbnail).
            if local_node_id is not None and replica.node_id == local_node_id:
                continue
            try:
                if not self._remote_exists_verified(backend, 'notes', note_id):
                    self._mark_replica_verification_error(
                        replica,
                        f'VERIFICATION FAILED DURING REMOTE READ: notes/{note_id} MISSING ON NODE {replica.node_id}'
                    )
                    continue
                if expected_size is not None:
                    remote_size = backend.size('notes', note_id)
                    if remote_size is None:
                        print(f'[STORAGE] Skipping remote read of notes/{note_id} from node {replica.node_id}: remote size unavailable')
                        continue
                    if int(remote_size) != int(expected_size):
                        self._mark_replica_verification_error(
                            replica,
                            f'VERIFICATION FAILED DURING REMOTE READ: notes/{note_id} SIZE MISMATCH ON NODE {replica.node_id}'
                        )
                        continue
                remote_checksum = self._remote_checksum_hex(backend, 'notes', note_id)
                if remote_checksum and remote_checksum != note_checksum:
                    self._mark_replica_verification_error(
                        replica,
                        f'VERIFICATION FAILED DURING REMOTE READ: notes/{note_id} CHECKSUM MISMATCH ON NODE {replica.node_id}'
                    )
                    continue
                if isinstance(backend, _LocalBackend):
                    return backend.get_path('notes', note_id)
                if self._stage_remote_into_cache(backend, 'notes', note_id, cache_path,
                                                 expected_size, note_checksum, f'notes/{note_id}'):
                    return cache_path
                self._mark_replica_verification_error(
                    replica,
                    f'VERIFICATION FAILED DURING REMOTE READ: notes/{note_id} DOWNLOADED CHECKSUM MISMATCH ON NODE {replica.node_id}'
                )
            except Exception as e:
                print(f'[STORAGE] Failed to fetch note {note_id} from remote node {replica.node_id}: {e}')

        # AUDIT FIX P0-1: final fallback to local note as authoritative copy
        # even if there are no synced remote replicas (single-node / cache-only
        # / orphan cleanup edge cases). However, if the top-of-function
        # integrity check already proved the local copy is corrupt, do NOT
        # serve those corrupt bytes — return None instead.
        if not _local_corrupt:
            try:
                if local_backend and local_backend.exists('notes', note_id):
                    return local_backend.get_path('notes', note_id)
            except Exception:
                pass
        return None

    def read_note(self, note_id):
        try:
            path = self.get_note_path(note_id)
            if path and os.path.isfile(path):
                with open(path, 'r') as f:
                    return f.read()
        except Exception:
            pass
        return None

    def write_note(self, note_id, content):
        """Write note content atomically.
        Always writes to local disk first for speed."""
        self._invalidate_note_cache(note_id)
        self._local_backend.put_data_atomic('notes', note_id, content)

    def _note_stage_id(self, note_id, staging_id=None, suffix='new'):
        if staging_id:
            return f'{note_id}.{staging_id}.{suffix}'
        return f'{note_id}.{suffix}'

    def write_note_staged(self, note_id, content, staging_id=None):
        """Stage a note content update without replacing the original.
        Call finalize_staged_note() after DB commit, or rollback_staged_note() on failure."""
        self._invalidate_note_cache(note_id)
        self._local_backend.put_data_atomic('notes', self._note_stage_id(note_id, staging_id, 'new'), content)

    def mark_staged_note_committed(self, note_id, staging_id=None):
        """Write a .committed marker to indicate the DB commit succeeded for a staged note.
        Call this AFTER db.session.commit() succeeds but BEFORE finalize_staged_note().
        Startup recovery uses this marker to distinguish 'commit succeeded, finalize needed'
        from 'commit failed, discard the .new file'."""
        marker_path = self._local_backend.get_path('notes', self._note_stage_id(note_id, staging_id, 'committed'))
        try:
            with open(marker_path, 'wb') as f:
                f.flush()
                os.fsync(f.fileno())
        except OSError as e:
            print(f'[STORAGE] Warning: failed to write .committed marker for note {note_id}: {e}')

    def write_staged_note_metadata(self, note_id, metadata, staging_id=None):
        """Write expected DB metadata for a staged note before committing."""
        meta_path = self._local_backend.get_path('notes', self._note_stage_id(note_id, staging_id, 'meta'))
        tmp_path = meta_path + '.tmp'
        try:
            with open(tmp_path, 'w') as f:
                json.dump(metadata or {}, f, separators=(',', ':'))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, meta_path)
        except OSError as e:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
            print(f'[STORAGE] Warning: failed to write staged metadata for note {note_id}: {e}')

    def finalize_staged_note(self, note_id, staging_id=None):
        """Atomically replace the original note with the staged .new copy.
        Call this AFTER a successful DB commit (and mark_staged_note_committed)."""
        staged_path = self._local_backend.get_path('notes', self._note_stage_id(note_id, staging_id, 'new'))
        final_path = self._local_backend.get_path('notes', note_id)
        os.replace(staged_path, final_path)
        # AUDIT FIX (upload/download integrity): fsync the parent directory so the
        # rename survives power loss (see finalize_staged_file for the full
        # rationale). Logged, not raised -- the swap already happened.
        try:
            _fsync_path(os.path.dirname(final_path), kind='dir')
        except OSError as e:
            print(f'[ERROR] Could not flush directory entry after finalizing staged note {note_id}: {e}')
        self._invalidate_note_cache(note_id)
        # Clean up the .committed marker (no longer needed after successful finalize)
        marker_path = self._local_backend.get_path('notes', self._note_stage_id(note_id, staging_id, 'committed'))
        try:
            if os.path.exists(marker_path):
                os.remove(marker_path)
        except OSError:
            pass
        meta_path = self._local_backend.get_path('notes', self._note_stage_id(note_id, staging_id, 'meta'))
        try:
            if os.path.exists(meta_path):
                os.remove(meta_path)
        except OSError:
            pass

    def rollback_staged_note(self, note_id, staging_id=None):
        """Discard the staged .new note copy (e.g. on DB commit failure)."""
        staged_path = self._local_backend.get_path('notes', self._note_stage_id(note_id, staging_id, 'new'))
        try:
            if os.path.exists(staged_path):
                os.remove(staged_path)
        except OSError as e:
            print(f'[STORAGE] Failed to remove staged note {staged_path}: {e}')
        # Clean up the .committed marker if it exists (shouldn't on rollback, but be safe)
        marker_path = self._local_backend.get_path('notes', self._note_stage_id(note_id, staging_id, 'committed'))
        try:
            if os.path.exists(marker_path):
                os.remove(marker_path)
        except OSError:
            pass
        meta_path = self._local_backend.get_path('notes', self._note_stage_id(note_id, staging_id, 'meta'))
        try:
            if os.path.exists(meta_path):
                os.remove(meta_path)
        except OSError:
            pass

    def delete_note(self, note_id):
        """Delete a note: record the remote-delete intent + clear replica rows
        FIRST (atomic commit), then delete the local disk copy. AUDIT FIX M1:
        the irreversible local delete runs only after the DB commit succeeds, so
        a commit rollback can never leave a 'synced' replica row pointing at a
        note file that was already deleted."""
        # AUDIT FIX P0-2: tombstone + replica-row deletion in one transaction so
        # a locally-deleted note can never be left without a remote-delete
        # tombstone AND without replica rows (untracked remote orphan).
        try:
            self._queue_remote_delete('notes', note_id)
            NoteReplica.query.filter_by(note_id=note_id).delete()
            db.session.commit()
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[ERROR] Failed to atomically queue remote delete + clear replicas for notes/{note_id}: {e}')
            # Delete intent not durably recorded -- keep the note intact for retry.
            return False
        # Commit succeeded -- now remove the local disk copy + cache.
        if not self._local_backend.delete('notes', note_id):
            print(f'[STORAGE] Local delete failed for notes/{note_id}; left as orphan for cleanup')
        self._invalidate_note_cache(note_id)
        cache_path = os.path.join(NOTES_DIR, f'.cache_{note_id}')
        try:
            if os.path.isfile(cache_path):
                os.remove(cache_path)
        except OSError:
            pass
        return True

    def note_exists(self, note_id):
        # AUDIT FIX (absent vs. could-not-determine): see _object_exists_anywhere.
        return self._object_exists_anywhere('notes', note_id)

    def reconcile_note_to_local(self, note_id, verified_at=None):
        """Treat the local note file as authoritative and re-queue stale replicas."""
        return self.queue_note_replication(note_id, verified_at=verified_at)

    def list_notes(self):
        self._ensure_local_backend_ready()
        return self._local_backend.list_files('notes')

    # ---- Thumbnail operations (thumbnails/) ----

    def get_thumbnail_path(self, file_id, is_e2e=False):
        ext = '.e2e' if is_e2e else '.jpg'
        return self._local_backend.get_path('thumbnails', f'{file_id}{ext}')

    def _thumbnail_size_bytes(self, file_id, thumb_type):
        """Best-effort thumbnail size lookup from local disk only.
        Legacy DB blob columns are no longer consulted (dead columns per policy)."""
        ext = '.e2e' if thumb_type == 'e2e' else '.jpg'
        thumb_id = f'{file_id}{ext}'
        try:
            if self._local_backend and self._local_backend.exists('thumbnails', thumb_id):
                return self._local_backend.size('thumbnails', thumb_id)
        except Exception:
            pass
        return None

    def save_thumbnail(self, file_id, data, is_e2e=False):
        """Save thumbnail data.
        Always writes to local disk first for speed, then replicates asynchronously.

        Returns True on success and False when the thumbnail itself could not
        be produced (callers may proceed without a thumbnail). Raises
        ReplicaSessionRollbackError when the replica bookkeeping below rolled
        back the shared DB session: that rollback expunges the caller's
        pending objects (e.g. /upload's uncommitted File row), so the caller
        must abort instead of committing. AUDIT FIX H3."""
        ext = '.e2e' if is_e2e else '.jpg'
        thumb_id = f'{file_id}{ext}'
        thumb_type = 'e2e' if is_e2e else 'jpg'
        publication_lock = _acquire_thumbnail_publication_lock(file_id, thumb_type)
        try:
            backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
            # Always write to local disk first (fast path)
            local_backend.put_data_atomic('thumbnails', thumb_id, data)
            # AUDIT FIX H4: the thumbnail generation is alive again -- drop any
            # stale deferred-delete tombstone so the next cycle cannot delete
            # the freshly written payload (belt and braces; Phase B also checks).
            try:
                _clear_pending_remote_deletes_for('thumbnails', [thumb_id])
            except Exception as e:
                if not local_backend.delete('thumbnails', thumb_id):
                    print(f'[STORAGE] Failed to clean uncommitted thumbnail {thumb_id}')
                raise ReplicaSessionRollbackError(
                    f'thumbnail tombstone cleanup rolled back the DB session for {thumb_id}'
                ) from e
            # Replica tracking.
            # AUDIT FIX H3: the *_mark_replica_* helpers roll back the shared
            # DB session on error and re-raise as
            # ReplicaSessionRollbackError. A rollback expunges every pending
            # object -- e.g. /upload's uncommitted File row -- so this failure
            # is NOT a benign "proceed without thumbnail" case and must reach
            # the caller. Only non-DB failures (disk write, snapshot) stay
            # swallowed in the handler below.
            if local_node_id and local_node_id in backends:
                self._mark_replica_synced('thumbnail', f'{file_id}:{thumb_type}', local_node_id)
                self._mark_pending_replicas('thumbnail', f'{file_id}:{thumb_type}', local_node_id)
            else:
                # Cache mode — local disk is staging; mark all remote nodes as pending
                self._mark_pending_replicas('thumbnail', f'{file_id}:{thumb_type}', None)
            # Record the authoritative checksum after replica bookkeeping. This
            # keeps the transaction lock order aligned with permanent deletion
            # (replicas before File) and lets the caller's final commit handle a
            # file removed during rendering as a normal stale-thumbnail race.
            try:
                _thumb_sum = hashlib.sha256(data).hexdigest()
                _file_obj = db.session.get(File, file_id)
                if _file_obj is not None:
                    if is_e2e:
                        _file_obj.thumbnail_e2e_checksum = _thumb_sum
                    else:
                        _file_obj.thumbnail_checksum = _thumb_sum
                if local_node_id and local_node_id in backends:
                    # _mark_replica_synced above recorded the PREVIOUS authoritative
                    # checksum; the local row describes the bytes just written.
                    _local_thumb = ThumbnailReplica.query.filter_by(
                        file_id=file_id, thumb_type=thumb_type, node_id=local_node_id).first()
                    if _local_thumb is not None:
                        _local_thumb.checksum = _thumb_sum
            except Exception as _csum_err:
                print(f'[STORAGE] Could not record thumbnail checksum for {file_id}: {_csum_err}')
            return True
        except ReplicaSessionRollbackError:
            # AUDIT FIX H3: the session was rolled back inside replica
            # bookkeeping, expunging the caller's pending state (for /upload:
            # the uncommitted File row). Re-raise so the caller aborts with a
            # 500 + payload cleanup instead of committing an empty session and
            # answering HTTP 200 with tokens for a row that was never persisted.
            raise
        except Exception as e:
            print(f'[STORAGE] Failed to save thumbnail for {file_id}: {e}')
            return False
        finally:
            _release_thumbnail_publication_lock(publication_lock)

    def load_thumbnail(self, file_id, is_e2e=False):
        """Load thumbnail bytes. Local canonical first, then validated cache,
        then remote fetch into cache. Returns None if unavailable."""
        ext = '.e2e' if is_e2e else '.jpg'
        thumb_id = f'{file_id}{ext}'
        _validate_storage_file_id(thumb_id)
        thumb_type = 'e2e' if is_e2e else 'jpg'
        cache_path = os.path.join(THUMBNAILS_DIR, f'.cache_{thumb_id}')
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        try:
            # AUDIT FIX P0-1/P2-2: derive the authoritative expected checksum/size
            # from a RECORDED synced replica row (written at sync time) rather than
            # from the local on-disk bytes. This makes the values independent of a
            # possibly-corrupt local thumbnail, so they can be used both to detect
            # local bit-rot AND to validate the remote copy on failover.
            recorded_replica = ThumbnailReplica.query.filter(
                ThumbnailReplica.file_id == file_id,
                ThumbnailReplica.thumb_type == thumb_type,
                ThumbnailReplica.status == 'synced',
                ThumbnailReplica.checksum.isnot(None),
            ).order_by(ThumbnailReplica.verified_at.desc(), ThumbnailReplica.id.desc()).first()
            # AUDIT FIX F-2 (5th audit): the File row's recorded thumbnail
            # checksum is the strongest authority (set at generation, before any
            # replication), so prefer it over a replica-recorded checksum.
            expected_checksum = self._tracked_thumbnail_checksum_hex(file_id, thumb_type)
            if not expected_checksum and recorded_replica is not None:
                expected_checksum = recorded_replica.checksum
            if recorded_replica is not None and recorded_replica.size_bytes is not None:
                expected_size = int(recorded_replica.size_bytes)
            else:
                expected_size = self._thumbnail_size_bytes(file_id, thumb_type)

            # 1. Serve the canonical local thumbnail — but validate it against the
            # recorded checksum first. Previously the local thumbnail was returned
            # unconditionally, so local bit-rot was served to clients with no
            # failover (unlike files/notes, whose read paths verify integrity).
            if local_backend.exists('thumbnails', thumb_id):
                local_thumb_path = local_backend.get_path('thumbnails', thumb_id)
                if not expected_checksum or self._cache_payload_valid(
                    local_thumb_path, None, expected_checksum, f'thumbnails/{thumb_id}'
                ):
                    return local_backend.get_data('thumbnails', thumb_id)
                print(f'[STORAGE] Local thumbnail {thumb_id} failed checksum validation; attempting remote failover')
                if recorded_replica is None or recorded_replica.size_bytes is None:
                    # That size was read from the bytes that just failed validation.
                    expected_size = None
                if local_node_id is not None:
                    _local_thumb_replica = ThumbnailReplica.query.filter_by(
                        file_id=file_id, thumb_type=thumb_type, node_id=local_node_id
                    ).first()
                    if _local_thumb_replica is not None:
                        self._mark_replica_verification_error(
                            _local_thumb_replica,
                            f'LOCAL THUMBNAIL CHECKSUM MISMATCH for {thumb_id}'
                        )

            # 2. Validate any existing local cache against authoritative metadata
            if os.path.isfile(cache_path):
                if self._cache_payload_valid(cache_path, expected_size, expected_checksum, f'thumbnails/{thumb_id}'):
                    with open(cache_path, 'rb') as f:
                        return f.read()
                # AUDIT FIX (unknown must not mean valid): with no authoritative
                # size/checksum the cache is no longer *certified* here, but it is
                # also not proven bad -- keep it for the explicit no-authority
                # fallback in step 4 instead of deleting it.
                if self._cache_expectations_known(expected_size, expected_checksum):
                    self._discard_cache_payload(cache_path)

            # 3. Fetch from a remote backend into cache
            for nid, backend in backends.items():
                if nid == local_node_id:
                    continue
                try:
                    if not backend.exists('thumbnails', thumb_id):
                        continue
                    remote_size = backend.size('thumbnails', thumb_id)
                    remote_checksum = self._remote_checksum_hex(backend, 'thumbnails', thumb_id)
                    if expected_size is not None and remote_size is not None:
                        if int(remote_size) != int(expected_size):
                            print(f'[STORAGE] Thumbnail size mismatch on node {nid} for {thumb_id}')
                            continue
                    if expected_checksum and remote_checksum and remote_checksum != expected_checksum:
                        self._mark_replica_verification_error(
                            ThumbnailReplica.query.filter_by(file_id=file_id, thumb_type=thumb_type, node_id=nid).first(),
                            f'THUMBNAIL CHECKSUM MISMATCH ON NODE {nid}'
                        )
                        continue
                    if self._stage_remote_into_cache(backend, 'thumbnails', thumb_id, cache_path,
                                                     expected_size, expected_checksum, f'thumbnails/{thumb_id}'):
                        with open(cache_path, 'rb') as f:
                            return f.read()
                except Exception as e:
                    print(f'[STORAGE] Failed to fetch thumbnail {thumb_id} from node {nid}: {e}')

            # 4. Final fallback: only return an untracked cache file if we have
            # no authoritative checksum/size at all. If metadata exists and
            # the cache failed validation, serving it would return stale data.
            if not expected_checksum and expected_size is None and os.path.isfile(cache_path):
                with open(cache_path, 'rb') as f:
                    return f.read()
        except Exception as e:
            print(f'[STORAGE] Failed to load thumbnail for {file_id}: {e}')
        return None

    def delete_thumbnail(self, file_id):
        """Delete both thumbnail variants: record the remote-delete intent for
        BOTH extensions + clear the replica rows in ONE atomic transaction, then
        delete the local disk copies.

        AUDIT FIX M1/M2:
          - M1: the irreversible local delete runs only AFTER the DB commit.
          - M2: if queuing the tombstone for EITHER extension fails, abort the
            whole delete (rollback) instead of swallowing the per-extension
            failure and committing the replica-row deletion anyway. The old code
            only print()ed the failure (despite a comment claiming it was
            're-surfaced after the commit attempt'), then deleted both replica
            rows and committed -- so a failed '.jpg' tombstone left that remote
            thumbnail object orphaned with no tombstone and no replica row."""
        # AUDIT FIX P0-2: tombstones + replica-row deletion in one transaction.
        try:
            for ext in ('.jpg', '.e2e'):
                self._queue_remote_delete('thumbnails', f'{file_id}{ext}')
            ThumbnailReplica.query.filter_by(file_id=file_id).delete()
            db.session.commit()
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[ERROR] Failed to atomically queue remote delete + clear replicas for thumbnails/{file_id}: {e}')
            # Delete intent not durably recorded -- keep thumbnails intact for retry.
            return False
        # Commit succeeded -- now remove the local disk copies + cache (best effort).
        for ext in ('.jpg', '.e2e'):
            thumb_id = f'{file_id}{ext}'
            if not self._local_backend.delete('thumbnails', thumb_id):
                print(f'[STORAGE] Local delete failed for thumbnails/{thumb_id}; left as orphan for cleanup')
            cache_path = os.path.join(THUMBNAILS_DIR, f'.cache_{thumb_id}')
            try:
                if os.path.isfile(cache_path):
                    os.remove(cache_path)
            except OSError:
                pass
        return True

    def _delete_thumbnail_by_basename(self, basename):
        """Delete a single thumbnail variant from local disk immediately and
        queue the remote delete, honouring the P1-4 separate-commit invariant:
        the PendingRemoteDelete row is committed BEFORE the replica tracking
        rows are deleted, so a failure in either step leaves the other intact.
        Mirrors delete_file() / delete_note() for safe_remove_paths() callers
        that operate per-basename instead of per-file_id."""
        _thumb_fid = basename.rsplit('.', 1)[0] if '.' in basename else basename
        _thumb_type = 'e2e' if basename.endswith('.e2e') else 'jpg'
        # AUDIT FIX P0-2: tombstone insert + replica-row deletion must be ONE
        # atomic transaction. The previous two-commit ordering could record the
        # tombstone but fail to delete the replica rows, or (worse) roll the
        # tombstone back while still deleting the replica rows on a later commit,
        # producing untracked remote orphans. Doing both in a single commit
        # guarantees we never erase tracking without a durable delete intent.
        try:
            self._queue_remote_delete('thumbnails', basename)
            ThumbnailReplica.query.filter_by(file_id=_thumb_fid, thumb_type=_thumb_type).delete()
            db.session.commit()
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[ERROR] Failed to atomically queue remote delete + clear replicas for thumbnails/{basename}: {e}')
            return False
        self._ensure_local_backend_ready()
        if self._local_backend is not None and not self._local_backend.delete('thumbnails', basename):
            print(f'[STORAGE] Local delete failed for thumbnails/{basename}; left as orphan for cleanup')
        cache_path = os.path.join(THUMBNAILS_DIR, f'.cache_{basename}')
        try:
            if os.path.isfile(cache_path):
                os.remove(cache_path)
        except OSError:
            pass
        return True

    def thumbnail_exists(self, file_id, is_e2e=False):
        # AUDIT FIX (absent vs. could-not-determine): see _object_exists_anywhere.
        ext = '.e2e' if is_e2e else '.jpg'
        return self._object_exists_anywhere('thumbnails', f'{file_id}{ext}')

    def list_thumbnails(self):
        self._ensure_local_backend_ready()
        return self._local_backend.list_files('thumbnails')
