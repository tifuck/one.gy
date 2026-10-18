class _StorageManagerFiles:

    def store_file(self, filename, source_path):
        """Store a file from source_path (move semantics for local).
        Always writes to local disk first, then replicates asynchronously.

        This intentionally returns after the LOCAL durable write succeeds.
        Remote replicas are created by the background replication cycle, so
        there is a brief single-copy durability window until the first remote
        sync completes. Local reclaim is conservative and only happens after
        multiple live-verified remote mirrors exist.
        """
        # Uploads intentionally bypass _get_write_node() and land on local disk
        # first; that helper only governs operations that can route writes.
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        local_backend.put_move('files', filename, source_path)
        # Replica tracking
        if local_node_id and local_node_id in backends:
            self._mark_replica_synced('file', filename, local_node_id)
            self._mark_pending_replicas('file', filename, local_node_id)
        else:
            # Cache mode — local disk is staging; mark all remote nodes as pending
            self._mark_pending_replicas('file', filename, None)

    def store_file_copy(self, filename, source_path):
        """Store a file from source_path (copy semantics).
        Always writes to local disk first, then replicates asynchronously.

        Like store_file(), this is a local-first durability tradeoff: the caller
        gets success after the local write, and the replication cycle fans the
        payload out to remote nodes afterward.
        """
        # Upload/regenerate paths intentionally stay local-first; see store_file().
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        local_backend.put('files', filename, source_path)
        # Replica tracking
        if local_node_id and local_node_id in backends:
            self._mark_replica_synced('file', filename, local_node_id)
            self._mark_pending_replicas('file', filename, local_node_id)
        else:
            # Cache mode — local disk is staging; mark all remote nodes as pending
            self._mark_pending_replicas('file', filename, None)

    def store_file_staged(self, filename, source_path):
        """Stage a file replacement: move source to a .new staging path WITHOUT overwriting
        the existing file. Call finalize_staged_file() after DB commit to atomically
        replace the original, or rollback_staged_file() to discard the staged copy.
        This prevents data loss if the DB commit fails after a destructive overwrite."""
        staged_filename = filename + '.new'
        self._local_backend.put_move('files', staged_filename, source_path)

    def mark_staged_file_committed(self, filename):
        """Write a .committed marker to indicate the DB commit succeeded for a staged file.
        Call this AFTER db.session.commit() succeeds but BEFORE finalize_staged_file().
        Startup recovery uses this marker to distinguish 'commit succeeded, finalize needed'
        from 'commit failed, discard the .new file'."""
        marker_path = self._local_backend.get_path('files', filename + '.committed')
        try:
            with open(marker_path, 'wb') as f:
                f.flush()
                os.fsync(f.fileno())
        except OSError as e:
            # Non-fatal: if the marker can't be written, finalize still proceeds normally.
            # The marker only matters for crash recovery, which is an edge case of an edge case.
            print(f'[STORAGE] Warning: failed to write .committed marker for {filename}: {e}')

    def write_staged_file_metadata(self, filename, metadata):
        """Write expected DB metadata for a staged file before committing.
        Startup recovery uses this to recover the DB-committed/window-before-marker case."""
        meta_path = self._local_backend.get_path('files', filename + '.meta')
        tmp_path = meta_path + '.tmp'
        try:
            with open(tmp_path, 'w') as f:
                json.dump(metadata or {}, f, separators=(',', ':'))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, meta_path)
            return True
        except OSError as e:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
            print(f'[STORAGE] Failed to write staged metadata for {filename}: {e}')
            return False

    def finalize_staged_file(self, filename):
        """Atomically replace the original file with the staged .new copy.
        Call this AFTER a successful DB commit (and mark_staged_file_committed).

        Replica-state requeue is intentionally separate so callers can commit
        it explicitly after the on-disk swap succeeds."""
        staged_path = self._local_backend.get_path('files', filename + '.new')
        final_path = self._local_backend.get_path('files', filename)
        os.replace(staged_path, final_path)
        # AUDIT FIX (upload/download integrity): fsync the parent directory so the
        # rename itself survives power loss -- every other durability-sensitive
        # path (_LocalBackend.put / put_move / put_data / put_data_atomic) already
        # does this, and the staged-rewrite finalize did not. make_file_public /
        # make_file_private commit the NEW payload_checksum + disk_size BEFORE
        # calling finalize, so a power loss in that window left the DB describing
        # the new payload while the inode still held the old one -- and
        # queue_file_replication had already reset the remote replicas to pending
        # with checksum=NULL, leaving no eligible failover source.
        # The rename has already been applied and cannot be rolled back, so a
        # failure here is logged loudly rather than raised: the caller has no
        # corrective action, but log monitoring must see a failing disk.
        try:
            _fsync_path(os.path.dirname(final_path), kind='dir')
        except OSError as e:
            print(f'[ERROR] Could not flush directory entry after finalizing staged file {filename}: {e}')
        # Clean up the .committed marker (no longer needed after successful finalize)
        marker_path = self._local_backend.get_path('files', filename + '.committed')
        try:
            if os.path.exists(marker_path):
                os.remove(marker_path)
        except OSError:
            pass
        meta_path = self._local_backend.get_path('files', filename + '.meta')
        try:
            if os.path.exists(meta_path):
                os.remove(meta_path)
        except OSError:
            pass

    def rollback_staged_file(self, filename):
        """Discard the staged .new copy (e.g. on DB commit failure).
        The original file remains untouched."""
        staged_path = self._local_backend.get_path('files', filename + '.new')
        try:
            if os.path.exists(staged_path):
                os.remove(staged_path)
        except OSError as e:
            print(f'[STORAGE] Failed to remove staged file {staged_path}: {e}')
        # Clean up the .committed marker if it exists (shouldn't on rollback, but be safe)
        marker_path = self._local_backend.get_path('files', filename + '.committed')
        try:
            if os.path.exists(marker_path):
                os.remove(marker_path)
        except OSError:
            pass
        meta_path = self._local_backend.get_path('files', filename + '.meta')
        try:
            if os.path.exists(meta_path):
                os.remove(meta_path)
        except OSError:
            pass

    def store_file_data(self, filename, data):
        """Store file from in-memory data (atomic write).
        Always writes to local disk first, then replicates asynchronously.

        The local write is the only copy guaranteed at return time; remote
        durability is provided by the replication cycle after this call.
        """
        # Always write to local disk first (fast path) — use atomic write to prevent
        # partial-write corruption on crash or disk-full
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        local_backend.put_data_atomic('files', filename, data)
        # Replica tracking
        if local_node_id and local_node_id in backends:
            self._mark_replica_synced('file', filename, local_node_id)
            self._mark_pending_replicas('file', filename, local_node_id)
        else:
            # Cache mode — local disk is staging; mark all remote nodes as pending
            self._mark_pending_replicas('file', filename, None)

    def _normalize_pending_remote_delete_node_ids(self, raw_ids):
        normalized = set()
        for raw_id in raw_ids or []:
            try:
                normalized.add(int(raw_id))
            except (TypeError, ValueError):
                pass
        return normalized

    def _decode_pending_remote_delete_node_ids(self, raw_json):
        try:
            decoded = json.loads(raw_json or '')
        except (TypeError, ValueError):
            return None
        if not isinstance(decoded, list):
            return None
        return self._normalize_pending_remote_delete_node_ids(decoded)

    def _remote_delete_target_node_ids(self):
        """Return the remote node IDs that may need deferred cleanup.

        Disabled nodes are INCLUDED so a delete intent is retained until the
        node is re-enabled. The deferred-delete worker keeps those tombstones
        queued without burning retry_count while the node stays disabled, and
        only treats a target as vanished once its StorageNode row is gone.

        AUDIT FIX H1: this MUST NOT swallow a query failure into an empty list.
        An empty list is the caller's signal that there are genuinely no remote
        nodes, which lets _queue_remote_delete return without a tombstone and
        lets callers drop replica tracking rows. A transient SELECT failure
        (lock-wait timeout, dropped pooled connection) flattened to [] would
        therefore erase replica rows for objects that DO still live on remote
        nodes -- leaving untracked remote orphans with no tombstone and no way
        to reclaim them on SSH/non-versioned S3. Let the exception propagate so
        _queue_remote_delete and its callers roll back the whole delete
        transaction and retry instead of confirming a delete that never ran.
        """
        return [
            n.id for n in StorageNode.query.all()
            if n.id != self._local_node_id
        ]

    def reactivate_pending_remote_deletes_for_node(self, node_id):
        """Clear deferred-delete backoff for a node that was re-enabled."""
        with self._state_lock:
            reset = 0
            try:
                existing_remote_node_ids = {
                    n.id for n in StorageNode.query.all()
                    if n.id != self._local_node_id
                }
                for row in PendingRemoteDelete.query.all():
                    target_node_ids = self._decode_pending_remote_delete_node_ids(row.target_node_ids)
                    if not target_node_ids:
                        target_node_ids = set(existing_remote_node_ids)
                        if target_node_ids:
                            row.target_node_ids = json.dumps(sorted(target_node_ids))
                    if node_id not in target_node_ids:
                        continue
                    try:
                        deleted_node_ids = self._normalize_pending_remote_delete_node_ids(
                            json.loads(row.deleted_node_ids or '[]')
                        )
                    except Exception:
                        deleted_node_ids = set()
                    if node_id in deleted_node_ids:
                        continue
                    if (row.retry_count or 0) != 0 or row.last_attempt is not None:
                        row.retry_count = 0
                        row.last_attempt = None
                        reset += 1
                if reset > 0:
                    db.session.commit()
            except Exception as e:
                print(f'[STORAGE] Failed to reactivate deferred deletes for node {node_id}: {e}')
                try:
                    db.session.rollback()
                except Exception:
                    pass
                return 0
            return reset

    def _current_delete_generation(self, category, object_id):
        """AUDIT FIX H4: identity marker of the LIVE row behind a delete key.

        Returns a stable per-generation marker string while the row exists, and
        None when there is no live row (the object really is gone, so its
        remote payload should be deleted as planned). Markers:
          - files:      File.upload_time (set once at upload, immutable-ish)
          - notes:      Note.content_version + updated_at
          - thumbnails: parent File row's per-variant thumbnail checksum,
                        with upload_time as the identity fallback (catches a
                        re-created File row and a regenerated thumbnail)
        Best-effort by design for CAPTURE callers: any lookup failure returns
        None so a tombstone can still be recorded. AUDIT FIX (finding 9): a
        lookup failure now PROPAGATES to the deferred-delete dispatcher
        instead of being flattened to None — Phase B must be able to tell
        "no live row (safe to delete)" apart from "DB error (unknown)" so a
        transient error cannot authorise deleting remote bytes."""
        try:
            if category == 'files':
                fid = object_id[:-4] if object_id.endswith('.enc') else object_id
                row = db.session.get(File, fid)
                if row is None or row.upload_time is None:
                    return None
                return f'file:ut={row.upload_time.isoformat()}'
            if category == 'notes':
                row = db.session.get(Note, object_id)
                if row is None:
                    return None
                updated = row.updated_at.isoformat() if row.updated_at else ''
                return f'note:v{getattr(row, "content_version", None)}:{updated}'
            if category == 'thumbnails':
                base = object_id.rsplit('.', 1)[0] if '.' in object_id else object_id
                row = db.session.get(File, base)
                if row is None:
                    return None
                checksum = (getattr(row, 'thumbnail_e2e_checksum', None)
                            if object_id.endswith('.e2e')
                            else getattr(row, 'thumbnail_checksum', None))
                upload = row.upload_time.isoformat() if row.upload_time else ''
                return f'thumb:ck={checksum}:ut={upload}'
        except Exception as e:
            print(f'[STORAGE] Delete-generation lookup failed for {category}/{object_id}: {e}')
            raise
        return None

    def _capture_delete_generation(self, category, object_id):
        """AUDIT FIX H4: snapshot the live row's generation marker at tombstone
        creation time, so Phase B can tell the deleted generation apart from any
        object later re-created under the same key. Best-effort: runs with
        autoflush disabled so a caller's pending metadata DELETE is not flushed
        out from under the read; when the row is already gone the marker is
        None and the tombstone is processed with legacy (delete) behavior."""
        try:
            with db.session.no_autoflush:
                return self._current_delete_generation(category, object_id)
        except Exception:
            return None

    def _queue_remote_delete(self, category, file_id):
        """Queue a deferred remote delete. Local disk is cleaned immediately;
        remote backends are cleaned asynchronously by the background job.

        Raises ValueError on invalid arguments (programmer error) and
        propagates DB/other exceptions so the caller can roll back the whole
        tombstone + replica-row transaction atomically. Returns normally only
        when there is genuinely nothing to queue (no remote nodes configured)
        — in that case there is no tombstone to record and callers may safely
        drop replica rows, since no remote payload exists."""
        # AUDIT FIX C2/M1: validate at insert time so a future caller that
        # somehow forwards user-influenced data cannot smuggle path traversal
        # or shell metacharacters through the queue and into remote operations.
        _validate_storage_args(category, file_id)  # raises ValueError on bad input
        target_node_ids = self._remote_delete_target_node_ids()
        if not target_node_ids:
            return
        # Let exceptions propagate so callers roll back the replica-row
        # deletion together with the failed tombstone insert, preserving the
        # atomic-delete invariant. Previously this swallowed the failure and
        # callers proceeded to delete replica rows + commit, orphaning the
        # remote payload with no PendingRemoteDelete tombstone.
        db.session.add(PendingRemoteDelete(
            category=category,
            file_id=file_id,
            target_node_ids=json.dumps(target_node_ids),
            deleted_node_ids=json.dumps([]),
            created_at=datetime.now(timezone.utc),
            generation=self._capture_delete_generation(category, file_id)
        ))

    def delete_file(self, filename):
        """Delete a file: record the remote-delete intent + clear replica rows
        FIRST (atomic commit), then delete the local disk copy.

        AUDIT FIX M1: the on-disk delete is irreversible, so it must run only
        AFTER the DB transaction commits. The benign failure direction is a
        local orphan (file still on disk, tracking rows gone) which
        cleanup_orphaned_files reaps; the dangerous direction -- which the old
        'delete disk first' ordering allowed on a commit rollback -- is a
        committed 'local replica synced' row pointing at a file that was already
        deleted."""
        fid = filename.replace('.enc', '') if filename.endswith('.enc') else filename
        # AUDIT FIX P0-2: queue the PendingRemoteDelete tombstone AND delete the
        # replica tracking rows in a SINGLE transaction so they are atomic. We
        # never erase the replica rows unless the remote-delete intent was
        # durably recorded.
        try:
            self._queue_remote_delete('files', filename)
            FileReplica.query.filter_by(file_id=fid).delete()
            ThumbnailReplica.query.filter_by(file_id=fid).delete()
            db.session.commit()
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[ERROR] Failed to atomically queue remote delete + clear replicas for files/{filename}: {e}')
            # Delete intent was NOT durably recorded -- leave the payload and
            # tracking rows intact so the delete is retried, rather than losing
            # the file with no record of the delete.
            return False
        # Commit succeeded -- now remove the local disk copy. A failure here
        # only leaves a benign local orphan (tracking already gone) that
        # cleanup_orphaned_files reaps.
        if not self._local_backend.delete('files', filename):
            print(f'[STORAGE] Local delete failed for files/{filename}; left as orphan for cleanup_orphaned_files')
        # Clean up any .cache_ temp copy
        cache_path = os.path.join(self._app.config['UPLOAD_FOLDER'], f'.cache_{filename}')
        try:
            if os.path.isfile(cache_path):
                os.remove(cache_path)
        except OSError:
            pass
        return True

    def delete_files(self, filenames):
        for fn in filenames:
            self.delete_file(fn)

    def safe_remove_paths(self, paths):
        """Remove a list of paths. Local disk is cleaned immediately;
        remote backend deletes are queued for async processing.
        None values in the paths list are silently skipped."""
        upload_dir = self._app.config['UPLOAD_FOLDER']
        for path in paths:
            if path is None:
                continue
            try:
                path_str = str(path)
                if path_str.startswith('storage://'):
                    try:
                        category, object_id = path_str[len('storage://'):].split('/', 1)
                    except ValueError:
                        print(f'[STORAGE] Invalid logical delete key: {path_str}')
                        continue
                    object_id = os.path.basename(object_id)
                    if category == 'files':
                        self.delete_file(object_id)
                    elif category == 'notes':
                        self.delete_note(object_id)
                    elif category == 'thumbnails':
                        self._delete_thumbnail_by_basename(object_id)
                    else:
                        print(f'[STORAGE] Unknown logical delete category: {category}')
                    continue

                if THUMBNAILS_DIR in path_str:
                    basename = os.path.basename(path)
                    if basename.startswith('.cache_'):
                        basename = basename[len('.cache_'):]
                    self._delete_thumbnail_by_basename(basename)
                elif NOTES_DIR in path_str:
                    basename = os.path.basename(path)
                    if basename.startswith('.cache_'):
                        basename = basename[len('.cache_'):]
                    self.delete_note(basename)
                elif upload_dir in path_str:
                    basename = os.path.basename(path)
                    if basename.startswith('.cache_'):
                        basename = basename[len('.cache_'):]
                    self.delete_file(basename)
                else:
                    if os.path.exists(path_str):
                        os.remove(path_str)
            except Exception as e:
                print(f'[STORAGE] Failed to remove {path}: {e}')
        # Commit queued remote deletes and replica cleanup in one batch
        try:
            db.session.commit()
        except Exception as e:
            print(f'[STORAGE] Failed to commit deferred deletes: {e}')
            try:
                db.session.rollback()
            except Exception:
                pass

    def stage_payload_deletes(self, delete_keys):
        """Stage payload removal so the REMOTE-delete tombstones and replica-row
        deletions join the CALLER'S still-open transaction (NO commit here).

        AUDIT FIX (atomic expired-file delete): callers that delete metadata rows
        (e.g. cleanup_expired_files) previously committed the row deletion and
        only afterwards queued the remote-delete tombstones via
        _safe_remove_paths(). A crash in that window left remote payload objects
        orphaned on every backup node with NO delete intent recorded (a permanent
        storage leak, since cleanup_remote_storage is admin/dry-run by default).
        Staging the tombstones + replica-row deletes into the same transaction as
        the metadata delete makes the whole thing atomic. Local disk objects are
        returned for the caller to purge AFTER its commit succeeds (a local
        orphan from a crash there is the benign direction — cleanup_orphaned_files
        reaps it). Returns a list of (category, object_id) tuples; category is
        None for raw local filesystem paths.

        AUDIT FIX (swallowed staging failures): the per-key body used to be
        wrapped in `except Exception: print(); continue`. _queue_remote_delete is
        documented to PROPAGATE so callers can roll back — delete_file(),
        delete_note() and delete_thumbnail() all honour that — but this function
        swallowed it, and all 25+ callers then committed the metadata deletion
        regardless. The result was the worst possible combination: the DB row
        gone, the payload still present on every remote node, and NO
        PendingRemoteDelete tombstone to ever reclaim it (an unreclaimable leak,
        since cleanup_remote_storage is admin/dry-run by default). It was also
        transaction-unsafe: a raised query error leaves the session in an aborted
        state while the loop kept issuing further deletes on it. Failures now
        propagate so the caller's transaction rolls back and the delete is
        retried, exactly like the other three delete paths."""
        local_targets = []
        for key in delete_keys or []:
            if key is None:
                continue
            s = str(key)
            if not s.startswith('storage://'):
                local_targets.append((None, s))
                continue
            try:
                category, object_id = s[len('storage://'):].split('/', 1)
            except ValueError:
                print(f'[STORAGE] Invalid logical delete key: {s}')
                continue
            object_id = os.path.basename(object_id)
            try:
                _validate_storage_args(category, object_id)
            except ValueError as _ve:
                print(f'[STORAGE] Refusing to stage delete for {category}/{object_id!r}: {_ve}')
                continue
            try:
                # Queue remote tombstone + delete replica tracking rows WITHOUT
                # committing -- the caller's commit makes it atomic with the
                # metadata-row deletion.
                self._queue_remote_delete(category, object_id)
                if category == 'files':
                    fid = object_id[:-4] if object_id.endswith('.enc') else object_id
                    FileReplica.query.filter_by(file_id=fid).delete()
                    ThumbnailReplica.query.filter_by(file_id=fid).delete()
                elif category == 'thumbnails':
                    base = object_id.rsplit('.', 1)[0] if '.' in object_id else object_id
                    ttype = 'e2e' if object_id.endswith('.e2e') else 'jpg'
                    ThumbnailReplica.query.filter_by(file_id=base, thumb_type=ttype).delete()
                elif category == 'notes':
                    NoteReplica.query.filter_by(note_id=object_id).delete()
                local_targets.append((category, object_id))
            except Exception as e:
                # AUDIT FIX (swallowed staging failures): PROPAGATE. The delete
                # intent was not durably staged, so the caller MUST roll back
                # rather than commit a metadata deletion whose payload can never
                # be reclaimed.
                print(f'[ERROR] Failed to stage payload delete for {category}/{object_id}; '
                      f'aborting so the caller rolls back instead of orphaning the remote payload: {e}')
                raise
        return local_targets

    def purge_staged_locals(self, local_targets):
        """Remove local disk payloads for keys staged by stage_payload_deletes(),
        AFTER the caller's transaction has committed. Best-effort: any local
        orphan left by a crash here is reaped by cleanup_orphaned_files."""
        upload_dir = self._app.config['UPLOAD_FOLDER']
        cache_dirs = {'files': upload_dir, 'notes': NOTES_DIR, 'thumbnails': THUMBNAILS_DIR}
        for category, object_id in local_targets or []:
            try:
                if category is None:
                    if object_id and os.path.exists(object_id):
                        os.remove(object_id)
                    continue
                self._local_backend.delete(category, object_id)
                cdir = cache_dirs.get(category)
                if cdir:
                    cpath = os.path.join(cdir, f'.cache_{object_id}')
                    if os.path.isfile(cpath):
                        os.remove(cpath)
                if category == 'notes':
                    self._invalidate_note_cache(object_id)
            except Exception as e:
                print(f'[STORAGE] Failed to purge local payload {category}/{object_id}: {e}')

    # Listings are the LOCAL disk inventory: their only callers (orphan and
    # reverse-orphan cleanup) compare them against local payload paths, so a
    # write-routing fallback to a remote node would mark local copies missing.
    def list_files(self):
        self._ensure_local_backend_ready()
        return self._local_backend.list_files('files')

    def get_files_total_size(self):
        if isinstance(self._local_backend, _LocalBackend):
            return self._local_backend.total_size('files')
        return 0

    def open_file(self, filename, mode='rb'):
        path = self.get_file_path(filename)
        return open(path, mode)

    def save_uploaded_file(self, filename, uploaded_file):
        """Save a Flask uploaded file object.
        Always writes to local disk first for speed, then replicates asynchronously."""
        # Always write to local disk first (fast path)
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        local_backend.save_upload('files', filename, uploaded_file)
        # Replica tracking
        if local_node_id and local_node_id in backends:
            self._mark_replica_synced('file', filename, local_node_id)
            self._mark_pending_replicas('file', filename, local_node_id)
        else:
            # Cache mode — local disk is staging; mark all remote nodes as pending
            self._mark_pending_replicas('file', filename, None)

    def rename_file(self, old_filename, new_filename):
        backends, local_backend, _local_node_id, _version = self._backend_state_snapshot()
        local_handled = False
        for nid, backend in backends.items():
            try:
                if isinstance(backend, _LocalBackend):
                    local_handled = True
                    if backend.exists('files', old_filename):
                        backend.rename('files', old_filename, new_filename)
                else:
                    if backend.exists('files', old_filename):
                        tmp_fd, tmp = tempfile.mkstemp(prefix='rename_', dir=self._app.config['UPLOAD_FOLDER'])
                        os.close(tmp_fd)
                        try:
                            backend.get('files', old_filename, tmp)
                            expected_size = os.path.getsize(tmp)
                            backend.put('files', new_filename, tmp)
                            remote_size = backend.size('files', new_filename)
                            if remote_size is not None and int(remote_size) != int(expected_size):
                                raise IOError(f'Rename verify failed for {new_filename}: expected {expected_size}, got {remote_size}')
                            try:
                                backend.delete('files', old_filename)
                            except Exception as delete_err:
                                # AUDIT FIX P1-9: if the old-copy delete fails
                                # after the new copy was successfully written,
                                # queue a deferred remote delete so the orphan
                                # is cleaned up by the background job instead of
                                # persisting forever as an untracked divergent
                                # replica.
                                print(f'[STORAGE] Rename cleanup left old remote copy on node {nid}, queuing deferred delete: {delete_err}')
                                try:
                                    self._queue_remote_delete('files', old_filename)
                                    db.session.commit()
                                except Exception:
                                    try:
                                        db.session.rollback()
                                    except Exception:
                                        pass
                        finally:
                            try:
                                os.remove(tmp)
                            except OSError:
                                pass
            except Exception as e:
                print(f'[STORAGE] Rename failed on node {nid}: {e}')
        # Also rename on local disk if local node is not in self._backends (e.g. removed from config)
        if not local_handled:
            try:
                if local_backend.exists('files', old_filename):
                    local_backend.rename('files', old_filename, new_filename)
            except Exception as e:
                print(f'[STORAGE] Rename failed on local backend: {e}')

    # AUDIT FIX D1 (fail-closed orphan grace window): these helpers used to
    # swallow every error and return 0 (the epoch). Callers compute
    # `age = time.time() - mtime` and skip young objects, so a 0 turned into an
    # age of ~1.7e9 seconds -- the "young orphan" protection silently evaporated
    # and the `except: continue` fail-safe below it became dead code, because
    # nothing ever raised. Returning None instead makes "unknown" distinct from
    # "epoch 0" so callers can refuse to delete what they cannot age.
    def get_file_mtime(self, filename):
        """Get file modification time (local backend only, for cleanup).
        Returns None when the mtime cannot be determined."""
        try:
            value = self._local_backend.getmtime('files', filename)
        except Exception as e:
            print(f'[STORAGE] Could not read mtime for files/{filename}: {e}')
            return None
        return value if value else None

    def get_note_mtime(self, note_id):
        """Get note file modification time (local backend only, for cleanup).
        Returns None when the mtime cannot be determined."""
        try:
            value = self._local_backend.getmtime('notes', note_id)
        except Exception as e:
            print(f'[STORAGE] Could not read mtime for notes/{note_id}: {e}')
            return None
        return value if value else None

    def get_thumbnail_mtime(self, thumb_id):
        """Get thumbnail modification time (local backend only, for cleanup).
        Returns None when the mtime cannot be determined."""
        try:
            value = self._local_backend.getmtime('thumbnails', thumb_id)
        except Exception as e:
            print(f'[STORAGE] Could not read mtime for thumbnails/{thumb_id}: {e}')
            return None
        return value if value else None

    def queue_file_replication(self, file_id, verified_at=None):
        """Treat the local file payload as authoritative and re-queue remotes."""
        self._ensure_local_backend_ready()
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        filename = f'{file_id}.enc'
        local_path = local_backend.get_path('files', filename) if local_backend else None
        if not local_path or not os.path.isfile(local_path):
            return None

        file_obj = db.session.get(File, file_id)
        if not file_obj:
            return None

        file_size = os.path.getsize(local_path)
        checksum = file_obj.payload_checksum

        # AUDIT FIX (finding 11): the local replica row used to be blessed
        # 'synced' with File.payload_checksum copied straight from the DB —
        # never compared against the bytes on disk — so a corrupted local
        # payload was recorded as a VERIFIED copy and then re-replicated to
        # every remote as if it were good. Hash the local payload first; a
        # mismatch fails safe (local replica marked 'error', remotes left
        # untouched, nothing queued for replication from the corrupt source).
        if checksum:
            actual_checksum = self._sha256_file(local_path)
            if actual_checksum != checksum:
                mismatch_msg = ('LOCAL PAYLOAD HASH DOES NOT MATCH File.payload_checksum — '
                                'refusing to claim a verified local replica or replicate the '
                                'possibly-corrupt source')
                replica = None
                if local_node_id and local_node_id in backends:
                    replica = FileReplica.query.filter_by(file_id=file_id, node_id=local_node_id).first()
                    if replica is None:
                        replica = FileReplica(file_id=file_id, node_id=local_node_id)
                        db.session.add(replica)
                if replica is not None:
                    replica.status = 'error'
                    replica.verified_at = None
                    replica.error_count = (replica.error_count or 0) + 1
                    replica.last_error = mismatch_msg[:500]
                    # Clear (never transfer) any recorded evidence: it no
                    # longer describes bytes that exist on this disk.
                    replica.checksum = None
                    replica.checksum_verified = None
                    replica.size_bytes = int(file_size)
                print(f'[STORAGE] [WARNING] queue_file_replication({file_id}): {mismatch_msg}')
                return {
                    'file_id': file_id,
                    'local_size': int(file_size),
                    'checksum': None,
                    'local_marked': False,
                    'remote_reset': 0,
                    'checksum_mismatch': True,
                    'error': mismatch_msg,
                }

        remote_reset = 0
        local_marked = False
        local_verified_at = verified_at or datetime.now(timezone.utc)

        for node in StorageNode.query.all():
            replica = FileReplica.query.filter_by(file_id=file_id, node_id=node.id).first()
            if node.id == local_node_id and local_node_id in backends:
                if not replica:
                    replica = FileReplica(file_id=file_id, node_id=node.id)
                    db.session.add(replica)
                replica.status = 'synced'
                replica.error_count = 0
                replica.last_error = None
                replica.verified_at = local_verified_at
                replica.size_bytes = int(file_size)
                if checksum:
                    replica.checksum = checksum
                    # AUDIT FIX (finding 11): the disk hash was just compared
                    # against payload_checksum above, so this IS an
                    # end-to-end verified local copy — record that honestly
                    # instead of leaving the verification flag unknown.
                    replica.checksum_verified = True
                else:
                    # No authoritative checksum exists: never let a stale
                    # recorded checksum ride along on a fresh 'synced' claim.
                    replica.checksum = None
                    replica.checksum_verified = None
                local_marked = True
                continue

            if not replica:
                if node.is_enabled:
                    db.session.add(FileReplica(file_id=file_id, node_id=node.id, status='pending'))
                    remote_reset += 1
                continue

            # AUDIT FIX (5th audit, stale integrity evidence): the local payload is
            # authoritative and has (potentially) changed, so any checksum/size
            # recorded for a remote node is now stale. Reset to pending AND clear
            # that evidence so a subsequent size-only re-replication can't leave a
            # synced row claiming a checksum that predates the new content.
            if (replica.status != 'pending' or replica.verified_at is not None
                    or (replica.error_count or 0) != 0 or replica.last_error
                    or replica.checksum is not None or replica.size_bytes is not None):
                replica.status = 'pending'
                replica.verified_at = None
                replica.error_count = 0
                replica.last_error = None
                replica.checksum = None
                # AUDIT FIX (size-only replicas excluded from failover): the
                # trust flag describes the checksum being cleared, so it must be
                # cleared with it — never left asserting a stale verification.
                replica.checksum_verified = None
                replica.size_bytes = None
                remote_reset += 1

        return {
            'file_id': file_id,
            'local_size': int(file_size),
            'checksum': checksum,
            'local_marked': local_marked,
            'remote_reset': remote_reset,
        }

    def _reset_remote_file_replicas_pending(self, file_id):
        """Mark every non-local replica pending and wipe stale evidence. No commit."""
        backends, _local_backend, local_node_id, _version = self._backend_state_snapshot()
        reset = 0
        for node in StorageNode.query.all():
            if node.id == local_node_id and local_node_id in backends:
                continue
            replica = FileReplica.query.filter_by(file_id=file_id, node_id=node.id).first()
            if not replica:
                if node.is_enabled:
                    db.session.add(FileReplica(file_id=file_id, node_id=node.id, status='pending'))
                    reset += 1
                continue
            replica.status = 'pending'
            replica.verified_at = None
            replica.error_count = 0
            replica.last_error = None
            replica.checksum = None
            replica.checksum_verified = None
            replica.size_bytes = None
            reset += 1
        return reset

    def _invalidate_note_cache(self, note_id):
        cache_path = os.path.join(NOTES_DIR, f'.cache_{note_id}')
        try:
            if os.path.isfile(cache_path):
                os.remove(cache_path)
        except OSError:
            pass
