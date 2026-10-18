class _StorageManagerNodeAdmin:

    # Both waits are bounded. The state lock serializes this process's storage
    # bookkeeping; the drain lock waits for target puts in every worker.
    REMOVE_NODE_LOCK_TIMEOUT_SECONDS = 120
    REMOVE_NODE_DRAIN_TIMEOUT_SECONDS = 120

    def _pending_deletes_targeting(self, node_id):
        """AUDIT FIX (finding 10): deferred remote deletes still NEEDING this
        node's backend — i.e. tombstones whose target set contains node_id and
        whose confirmed-deleted set does not. Legacy rows with an empty/malformed
        target list implicitly target every extant remote node, so node_id
        counts if it is a remote node at all."""
        rows = []
        fallback_targets = None
        for row in PendingRemoteDelete.query.all():
            targets = self._decode_pending_remote_delete_node_ids(row.target_node_ids)
            if not targets:
                if fallback_targets is None:
                    fallback_targets = {
                        n.id for n in StorageNode.query.all()
                        if n.id != self._local_node_id
                    }
                targets = fallback_targets
            deleted = self._decode_pending_remote_delete_node_ids(row.deleted_node_ids) or set()
            if node_id in (set(targets) - set(deleted)):
                rows.append(row)
        return rows

    def _write_removed_node_delete_manifest(self, node, rows):
        """AUDIT FIX (finding 10): record, durably, exactly which deferred
        remote deletes a force-removed node still owned, so the bytes are
        never silently forgotten (the deferred-delete worker drops tombstones
        whose target node has vanished). One JSON line per removal, appended
        and fsynced; path overridable via STORAGE_REMOVED_NODE_MANIFEST.
        Raises ValueError when the manifest cannot be persisted — the removal
        must then fail safe rather than orphan undeleted bytes."""
        entries = [{
            'tombstone_id': row.id,
            'category': row.category,
            'file_id': row.file_id,
            'generation': row.generation,
            'target_node_ids': sorted(
                self._decode_pending_remote_delete_node_ids(row.target_node_ids) or []),
            'deleted_node_ids': sorted(
                self._decode_pending_remote_delete_node_ids(row.deleted_node_ids) or []),
        } for row in rows]
        payload = json.dumps({
            'node_id': node.id,
            'node_name': node.name,
            'node_type': node.node_type,
            'removed_at': datetime.now(timezone.utc).isoformat(),
            'reason': 'force removal with outstanding deferred remote deletes',
            'outstanding_deletes': entries,
        }, sort_keys=True)
        path = os.environ.get('STORAGE_REMOVED_NODE_MANIFEST') or os.path.join(
            self._app.instance_path, 'removed_node_pending_deletes.jsonl')
        try:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, 'a', encoding='utf-8') as fh:
                fh.write(payload + '\n')
                fh.flush()
                os.fsync(fh.fileno())
        except Exception as e:
            raise ValueError(
                f'FORCE REMOVAL REFUSED: could not persist the durable manifest of '
                f'{len(entries)} outstanding remote delete(s) to {path}: {e}')
        print(f'[STORAGE] Recorded {len(entries)} outstanding remote delete(s) for node '
              f'{node.id} ({node.name}) in {path}')

    def remove_node(self, node_id, force=False):
        lock_acquired = self._state_lock.acquire(timeout=self.REMOVE_NODE_LOCK_TIMEOUT_SECONDS)
        if not lock_acquired:
            raise ValueError(
                'STORAGE SUBSYSTEM IS BUSY — could not acquire the storage state lock within '
                f'{self.REMOVE_NODE_LOCK_TIMEOUT_SECONDS}s. Node removal is destructive and will '
                'not proceed without it; retry once the current replication/scrub cycle finishes.'
            )
        drain_lock = None
        drain_started = False
        removal_committed = False
        original_enabled = None
        original_status = None
        try:
            node = db.session.get(StorageNode, node_id)
            if not node:
                raise ValueError(f'Node {node_id} not found')
            # Only an ENABLED target can be the last enabled node; removing a
            # disabled node leaves the enabled set untouched.
            enabled_count = StorageNode.query.filter_by(is_enabled=True).count()
            if node.is_enabled and enabled_count <= 1:
                raise ValueError('Cannot remove the last storage node')

            # AUDIT FIX (finding 10): a node that still owns pending remote
            # deletes must not be dropped silently — once its StorageNode row
            # is gone the deferred-delete worker treats those tombstone targets
            # as 'vanished' and discards them, leaving the bytes undeleted and
            # untracked forever. Refuse unless the operator forces removal
            # (which first writes a durable manifest of what would be lost).
            outstanding = self._pending_deletes_targeting(node_id)
            if outstanding and not force:
                raise ValueError(
                    f'Node has {len(outstanding)} pending remote delete(s) targeting it — '
                    'removing it now would orphan undeleted remote bytes (the tombstones can '
                    'never be replayed without this node). Run remote cleanup first, or force '
                    'removal to write a durable manifest and proceed.')

            exclusive = None
            if not force:
                # AUDIT FIX P1-3: use the canonical exclusivity checker instead
                # of an ad-hoc query. The previous inline check (a) ignored
                # NoteReplica.synced_version, so a STALE 'synced' row on another
                # node masked a node that held the only CURRENT copy of a note,
                # and (b) did not consider thumbnails at all — both of which
                # could let an operator delete the last good copy of data.
                # check_node_exclusive_data() requires the sibling note replica
                # to match the current content_version and also audits thumbnails
                # and local-disk membership.
                #
                # AUDIT FIX (week-stale rows trusted for node removal): the
                # DB-only answer is NOT sufficient authorisation. With
                # integrity_scrub_min_reverify_interval defaulting to 7 days and
                # deep verification off, a vanished remote object keeps a 'synced'
                # row long enough for an admin to be told the data is redundant
                # when the other copy is already gone. verify_stale_evidence=True
                # re-probes, live, the surviving copies whose evidence has aged
                # out — and an incomplete or failing verification is treated as a
                # refusal, exactly like a positive exclusivity finding.
                #
                # AUDIT FIX (finding 7): that live re-verification probes slow
                # SSH/S3 nodes and used to run WHILE HOLDING the global state
                # lock, freezing this worker's storage bookkeeping for up to
                # minutes. Release the lock for the probe and re-acquire it
                # before any mutation. Safety is preserved: nothing here has
                # been mutated yet, the drain fence has not been published, and
                # the whole verdict is re-checked against fresh DB state under
                # the re-acquired lock below (cross-process safety was never
                # provided by this in-process lock anyway — the DB row locks in
                # set_primary/add_node/remove are what fence other workers).
                self._state_lock.release()
                lock_acquired = False
                try:
                    exclusive = self.check_node_exclusive_data(
                        node_id, verify_stale_evidence=True)
                finally:
                    lock_acquired = self._state_lock.acquire(
                        timeout=self.REMOVE_NODE_LOCK_TIMEOUT_SECONDS)
                if not lock_acquired:
                    raise ValueError(
                        'STORAGE SUBSYSTEM IS BUSY — the storage state lock could not be '
                        're-acquired after the live redundancy re-verification. Node removal '
                        'is refused without any mutation; retry once the current '
                        'replication/scrub cycle finishes.')

            # ── Re-validate under the (re)acquired lock before mutating ──
            # End the probe's transaction first: the unlocked re-verification
            # ran DB reads, and REPEATABLE READ would otherwise keep serving
            # the pre-probe snapshot (a concurrent fence/primary change made
            # while the lock was released must be visible here).
            db.session.rollback()
            node = db.session.query(StorageNode).filter_by(id=node_id).populate_existing().first()
            if not node:
                raise ValueError(f'Node {node_id} not found (removed concurrently)')
            enabled_count = StorageNode.query.filter_by(is_enabled=True).count()
            if node.is_enabled and enabled_count <= 1:
                raise ValueError('Cannot remove the last storage node')
            if node.status == 'draining':
                raise ValueError(f'Node {node.name} is already being removed (drain in progress)')
            outstanding = self._pending_deletes_targeting(node_id)
            if outstanding:
                if not force:
                    raise ValueError(
                        f'Node has {len(outstanding)} pending remote delete(s) targeting it — '
                        'removing it now would orphan undeleted remote bytes. Run remote '
                        'cleanup first, or force removal to proceed.')
                # AUDIT FIX (finding 10): force path — persist what this removal
                # is about to forget, BEFORE anything destructive happens.
                self._write_removed_node_delete_manifest(node, outstanding)

            if exclusive is not None:
                if (exclusive.get('exclusive_files')
                        or exclusive.get('exclusive_notes')
                        or exclusive.get('exclusive_thumbnails')):
                    raise ValueError(
                        'Node has data with no other synced copy '
                        f"(files={exclusive.get('exclusive_files', 0)}, "
                        f"notes={exclusive.get('exclusive_notes', 0)}, "
                        f"thumbnails={exclusive.get('exclusive_thumbnails', 0)}). "
                        'Wait for replication to complete or force removal to proceed.'
                    )
                if exclusive.get('stale_evidence_failed'):
                    raise ValueError(
                        f"{exclusive['stale_evidence_failed']} surviving remote cop(ies) of this "
                        'node\'s data FAILED live re-verification — the redundancy the DB claims '
                        'does not exist. Repair replication first, or force removal to proceed.'
                    )
                if exclusive.get('verification_incomplete'):
                    raise ValueError(
                        'Could not finish live re-verification of the surviving copies (node '
                        'unreachable, or too many stale replica rows to check within the time '
                        'budget). Refusing a destructive removal on unverified evidence — run the '
                        'integrity scrub first, or force removal to proceed.'
                    )

            # Publish the drain fence atomically before waiting. New reservations
            # take the shared node lock and then read these fields from a fresh DB
            # transaction, so none can pass once this commit is visible. Existing
            # reservations retain the shared lock through target_backend.put().
            original_enabled = bool(node.is_enabled)
            original_status = node.status
            drain_started = True
            node.is_enabled = False
            node.status = 'draining'
            db.session.commit()

            drain_lock = self._acquire_node_drain_lock(
                node_id, self.REMOVE_NODE_DRAIN_TIMEOUT_SECONDS)
            if not drain_lock:
                raise ValueError(
                    'NODE DRAIN TIMED OUT — one or more storage writes are still in flight after '
                    f'{self.REMOVE_NODE_DRAIN_TIMEOUT_SECONDS}s. No replica or node rows were removed; '
                    'the node was restored and removal was refused.'
                )

            was_primary = None
            # AUDIT FIX (finding 8): fence this delete+promote transaction
            # against set_primary/add_node running in OTHER workers — the
            # in-process state lock cannot serialise them. The locking read
            # runs FIRST so it also establishes this transaction's snapshot:
            # a set_primary that committed before we took the locks is
            # visible here, and one that arrives afterwards blocks until this
            # commit — either way the promote below cannot race a demote into
            # two primaries.
            _locked_for_delete = self._lock_storage_node_rows()
            was_primary = next(
                (bool(r.is_primary) for r in _locked_for_delete if r.id == node_id),
                False)
            node_name = node.name
            node_type = node.node_type
            # AUDIT FIX M11b: promote the replacement primary in the SAME
            # transaction as the replica-row deletes + node delete. The old
            # code committed the deletion first and only then promoted a
            # replacement, so a crash between the two commits left the DB with
            # zero is_primary=True rows (degraded primary selection). Compute
            # the successor before the commit and stage the flag; one commit
            # now flips delete + promote atomically.
            new_primary_name = None
            if was_primary:
                new_primary = StorageNode.query.filter(
                    StorageNode.id != node_id
                ).filter_by(is_enabled=True).order_by(
                    StorageNode.created_at.asc(), StorageNode.id.asc()
                ).first()
                if new_primary:
                    new_primary.is_primary = True
                    new_primary_name = new_primary.name
            FileReplica.query.filter_by(node_id=node_id).delete()
            NoteReplica.query.filter_by(node_id=node_id).delete()
            ThumbnailReplica.query.filter_by(node_id=node_id).delete()
            db.session.delete(node)
            db.session.commit()
            removal_committed = True

            if new_primary_name:
                print(f'[STORAGE] Auto-promoted "{new_primary_name}" to primary after removing primary node')

            self._bump_backends_version()
            published_version = self._read_backends_version()
            with self._backends_lock:
                updated_backends = dict(self._backends)
                backend = updated_backends.pop(node_id, None)
                self._backends = updated_backends
                if self._local_node_id == node_id:
                    self._local_node_id = None
                self._backends_version = published_version
            # Shared SSH operations hold the backend operation RLock, so close
            # waits for an active use without holding either storage state lock.
            self._close_backend_set({node_id: backend} if backend else {})
            print(f'[STORAGE] Removed node: {node_name} ({node_type}) — remote bytes on that node were left untouched')
        finally:
            if drain_started and not removal_committed:
                # Refusal is non-destructive: roll back any uncommitted deletes,
                # then restore the exact eligibility/status that preceded drain.
                try:
                    db.session.rollback()
                    current_node = db.session.get(StorageNode, node_id)
                    if current_node:
                        current_node.is_enabled = original_enabled
                        current_node.status = original_status
                        db.session.commit()
                except Exception as e:
                    try:
                        db.session.rollback()
                    except Exception:
                        pass
                    print(f'[STORAGE] [ERROR] Failed to restore node {node_id} after refused drain: {e}')
            self._release_storage_write_lock(drain_lock)
            if lock_acquired:
                self._state_lock.release()

    def purge_local_copies(self, progress_callback=None):
        """Delete local files/notes/thumbnails only after multiple verified remote replicas exist.
        Returns dict with counts of purged items. Only removes from local disk — never remote.
        If progress_callback is provided, it is called with (phase, current, total, results_dict)
        after each item to report progress for background task tracking."""
        purged_files = 0
        purged_notes = 0
        purged_thumbs = 0
        skipped_files = 0
        skipped_notes = 0
        skipped_thumbs = 0
        bytes_freed = 0
        required_remote_copies = self.LOCAL_PURGE_MIN_VERIFIED_REMOTE_COPIES
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()

        def _results():
            return {'purged_files': purged_files, 'purged_notes': purged_notes,
                    'purged_thumbnails': purged_thumbs, 'skipped_files': skipped_files,
                    'skipped_notes': skipped_notes, 'skipped_thumbnails': skipped_thumbs,
                    'bytes_freed': bytes_freed,
                    'required_remote_copies': required_remote_copies}

        def _verified_synced_replicas(replica_query, category, item_id, expected_size, expected_checksum):
            verified = []
            for replica in replica_query.all():
                backend = backends.get(replica.node_id)
                if not backend:
                    continue
                if self._verify_remote_replica_payload(
                    replica,
                    backend,
                    category,
                    item_id,
                    expected_size,
                    expected_checksum,
                    'LOCAL PURGE',
                    update_replica=True,
                ):
                    verified.append(replica)
                if len(verified) >= required_remote_copies:
                    break
            return verified

        def _remotes_still_held(replica_query, expected_checksum):
            """AUDIT FIX (finding 5): remote redundancy was proven BEFORE the
            per-item rewrite/publication lock was taken. remove_node can drain
            a remote node inside that window (fence published, replica rows
            deleted at commit), so by the time the local copy was destroyed
            the 'verified' remotes could be gone from the DB. Called WITH the
            lock held: re-query the replica rows fresh and require enough of
            them to still be synced, checksum-matched, verification-not-refuted
            and backed by a node that is still enabled and not draining."""
            rows = replica_query.all()
            if not rows:
                return False
            node_rows = StorageNode.query.filter(
                StorageNode.id.in_([r.node_id for r in rows])
            ).all()
            node_map = {n.id: n for n in node_rows}
            held = 0
            for rep in rows:
                n = node_map.get(rep.node_id)
                if n is None or not n.is_enabled or n.status == 'draining':
                    continue
                if expected_checksum and rep.checksum != expected_checksum:
                    continue
                if rep.checksum_verified is False:
                    continue
                held += 1
                if held >= required_remote_copies:
                    return True
            return False

        def _local_payload_snapshot(category, item_id):
            """Hash one stable inode and return (size, checksum, stat signature)."""
            path = local_backend.get_path(category, item_id)
            before = os.stat(path)
            checksum = self._sha256_file(path)
            after = os.stat(path)
            before_sig = (before.st_dev, before.st_ino, before.st_size,
                          before.st_mtime_ns, before.st_ctime_ns)
            after_sig = (after.st_dev, after.st_ino, after.st_size,
                         after.st_mtime_ns, after.st_ctime_ns)
            if before_sig != after_sig:
                raise RuntimeError('local payload changed while it was being hashed')
            return int(after.st_size), checksum, after_sig

        # Find remote node IDs (any node that is NOT the local node)
        remote_node_ids = [nid for nid in backends if nid != local_node_id]
        # Purge files
        all_files = File.query.with_entities(File.id).all()
        total_files = len(all_files)
        if progress_callback:
            progress_callback('files', 0, total_files, _results())
        for i, (fid,) in enumerate(all_files):
            filename = f'{fid}.enc'
            if not local_backend.exists('files', filename):
                if progress_callback:
                    progress_callback('files', i + 1, total_files, _results())
                continue
            try:
                local_size, local_checksum, local_signature = _local_payload_snapshot('files', filename)
            except Exception as e:
                print(f'[STORAGE] Skipping local purge for file {filename}: local snapshot failed: {e}')
                skipped_files += 1
                if progress_callback:
                    progress_callback('files', i + 1, total_files, _results())
                continue
            # AUDIT FIX (purge verified remotes against the doomed local copy):
            # the expected checksum used to be `local_checksum` — the hash of the
            # very copy about to be DELETED. If the local file had drifted and the
            # drift was replicated (easy while File.payload_checksum is NULL,
            # because _tracked_file_checksum_hex falls back to a sibling replica's
            # checksum), both remotes "verified" against the corrupt hash and the
            # local copy plus its replica row were destroyed. The read path then
            # requires checksum == File.payload_checksum, so nothing was servable:
            # total loss. Notes already gated on note_obj.content_checksum; files
            # now gate on the equally authoritative File.payload_checksum, and we
            # REFUSE to purge when no authoritative checksum exists at all.
            _file_obj = db.session.get(File, fid)
            authoritative_checksum = _file_obj.payload_checksum if _file_obj else None
            if not authoritative_checksum:
                print(f'[STORAGE] Skipping local purge for file {filename}: no authoritative '
                      f'File.payload_checksum recorded — refusing to reclaim the local copy on the '
                      f'strength of its own hash')
                skipped_files += 1
                if progress_callback:
                    progress_callback('files', i + 1, total_files, _results())
                continue
            if authoritative_checksum != local_checksum:
                print(f'[STORAGE] Skipping local purge for file {filename}: local copy does not match '
                      f'the authoritative payload checksum (local corruption or an in-flight rewrite)')
                skipped_files += 1
                if progress_callback:
                    progress_callback('files', i + 1, total_files, _results())
                continue
            authoritative_size = int(_file_obj.disk_size) if _file_obj.disk_size is not None else local_size
            if authoritative_size is not None and int(authoritative_size) != int(local_size):
                print(f'[STORAGE] Skipping local purge for file {filename}: local size {local_size} '
                      f'does not match the authoritative disk_size {authoritative_size}')
                skipped_files += 1
                if progress_callback:
                    progress_callback('files', i + 1, total_files, _results())
                continue
            remote_synced_query = FileReplica.query.filter(
                FileReplica.file_id == fid,
                FileReplica.node_id.in_(remote_node_ids),
                FileReplica.status == 'synced'
            )
            verified_remote = _verified_synced_replicas(
                remote_synced_query,
                'files',
                filename,
                authoritative_size,
                authoritative_checksum,
            )
            if len(verified_remote) >= required_remote_copies:
                size = local_size or 0
                rewrite_lock = _acquire_file_rewrite_lock(fid)
                try:
                    # Remote verification deliberately happens before this lock.
                    # Start a fresh transaction, then prove the DB generation and
                    # exact local inode are still the ones verified above.
                    db.session.rollback()
                    fresh_file = db.session.get(File, fid)
                    fresh_size = int(fresh_file.disk_size) if fresh_file and fresh_file.disk_size is not None else local_size
                    final_size, final_checksum, final_signature = _local_payload_snapshot('files', filename)
                    generation_changed = (
                        fresh_file is None
                        or fresh_file.payload_checksum != authoritative_checksum
                        or int(fresh_size) != int(authoritative_size)
                        or final_signature != local_signature
                        or final_size != local_size
                        or final_checksum != authoritative_checksum
                    )
                    if generation_changed:
                        print(f'[STORAGE] Skipping local purge for file {filename}: payload generation changed after remote verification')
                        skipped_files += 1
                    elif not _remotes_still_held(remote_synced_query, authoritative_checksum):
                        # AUDIT FIX (finding 5): the remote verification above ran
                        # BEFORE this lock; a node removal/drain that landed in the
                        # window deleted those replica rows. Re-checked fresh under
                        # the lock — do not destroy the local copy on stale evidence.
                        print(f'[STORAGE] Skipping local purge for file {filename}: '
                              f'verified remote copies vanished or were fenced after '
                              f'remote verification (node removal/drain race)')
                        skipped_files += 1
                    else:
                        deleted_ok = local_backend.delete('files', filename)
                        if not deleted_ok:
                            # On-disk delete failed — do NOT erase the local replica
                            # row, or the file becomes an untracked local orphan that
                            # cleanup_orphaned_files will not reap (its File row still
                            # references it). Skip this entry; it will retry next cycle.
                            skipped_files += 1
                        else:
                            purged_files += 1
                            bytes_freed += size
                            # Remove local replica row since the local copy is gone
                            # AUDIT FIX P2-8: commit immediately after each purge so a
                            # crash mid-purge does not leave the DB saying the local
                            # copy is still 'synced' when the file is already deleted.
                            if local_node_id:
                                local_replica = FileReplica.query.filter_by(file_id=fid, node_id=local_node_id).first()
                                if local_replica:
                                    db.session.delete(local_replica)
                            db.session.commit()
                except Exception as e:
                    print(f'[STORAGE] Purge failed for file {filename}: {e}')
                    try:
                        db.session.rollback()
                    except Exception:
                        pass
                finally:
                    _release_file_rewrite_lock(rewrite_lock)
            else:
                skipped_files += 1
            if progress_callback:
                progress_callback('files', i + 1, total_files, _results())
        # Purge notes
        all_notes = Note.query.with_entities(Note.id).all()
        total_notes = len(all_notes)
        if progress_callback:
            progress_callback('notes', 0, total_notes, _results())
        for i, (note_id,) in enumerate(all_notes):
            if not local_backend.exists('notes', note_id):
                if progress_callback:
                    progress_callback('notes', i + 1, total_notes, _results())
                continue
            note_obj = db.session.get(Note, note_id)
            if not note_obj:
                if progress_callback:
                    progress_callback('notes', i + 1, total_notes, _results())
                continue
            try:
                note_size, local_checksum, note_signature = _local_payload_snapshot('notes', note_id)
            except Exception as e:
                print(f'[STORAGE] Skipping local purge for note {note_id}: local snapshot failed: {e}')
                skipped_notes += 1
                if progress_callback:
                    progress_callback('notes', i + 1, total_notes, _results())
                continue
            expected_checksum = note_obj.content_checksum
            if not expected_checksum:
                print(f'[STORAGE] Skipping local purge for note {note_id}: no authoritative '
                      f'Note.content_checksum recorded — refusing to reclaim the local copy on the '
                      f'strength of its own hash')
                skipped_notes += 1
                if progress_callback:
                    progress_callback('notes', i + 1, total_notes, _results())
                continue
            if expected_checksum != local_checksum:
                print(f'[STORAGE] Skipping local purge for note {note_id}: local checksum does not match latest DB checksum')
                skipped_notes += 1
                if progress_callback:
                    progress_callback('notes', i + 1, total_notes, _results())
                continue
            if note_size is not None and (note_obj.size is None or int(note_obj.size) != int(note_size)):
                note_obj.size = int(note_size)
            note_version = int(note_obj.content_version or 1)
            remote_synced_query = NoteReplica.query.filter(
                NoteReplica.note_id == note_id,
                NoteReplica.node_id.in_(remote_node_ids),
                NoteReplica.status == 'synced',
                NoteReplica.synced_version == note_version,
                NoteReplica.checksum == expected_checksum,
                db.or_(
                    NoteReplica.target_version.is_(None),
                    NoteReplica.target_version == 0,
                    NoteReplica.target_version == note_version,
                ),
            )
            verified_remote = _verified_synced_replicas(
                remote_synced_query,
                'notes',
                note_id,
                note_size,
                expected_checksum,
            )
            if len(verified_remote) >= required_remote_copies:
                note_lock = _acquire_note_rewrite_lock(note_id)
                try:
                    db.session.rollback()
                    fresh_note = db.session.get(Note, note_id)
                    final_size, final_checksum, final_signature = _local_payload_snapshot('notes', note_id)
                    generation_changed = (
                        fresh_note is None
                        or int(fresh_note.content_version or 1) != note_version
                        or fresh_note.content_checksum != expected_checksum
                        or final_signature != note_signature
                        or final_size != note_size
                        or final_checksum != expected_checksum
                    )
                    if generation_changed:
                        print(f'[STORAGE] Skipping local purge for note {note_id}: content generation changed after remote verification')
                        skipped_notes += 1
                    elif not _remotes_still_held(remote_synced_query, expected_checksum):
                        # AUDIT FIX (finding 5): same window as the file loop —
                        # re-verify remote redundancy fresh, under the lock.
                        print(f'[STORAGE] Skipping local purge for note {note_id}: '
                              f'verified remote copies vanished or were fenced after '
                              f'remote verification (node removal/drain race)')
                        skipped_notes += 1
                    else:
                        if fresh_note.size is None or int(fresh_note.size) != final_size:
                            fresh_note.size = final_size
                        deleted_ok = local_backend.delete('notes', note_id)
                        if not deleted_ok:
                            skipped_notes += 1
                        else:
                            purged_notes += 1
                            bytes_freed += note_size or 0
                            # Remove local replica row since the local copy is gone
                            # AUDIT FIX P2-8: commit immediately after each purge.
                            if local_node_id:
                                local_replica = NoteReplica.query.filter_by(note_id=note_id, node_id=local_node_id).first()
                                if local_replica:
                                    db.session.delete(local_replica)
                            db.session.commit()
                except Exception as e:
                    print(f'[STORAGE] Purge failed for note {note_id}: {e}')
                    try:
                        db.session.rollback()
                    except Exception:
                        pass
                finally:
                    _release_note_rewrite_lock(note_lock)
            else:
                skipped_notes += 1
            if progress_callback:
                progress_callback('notes', i + 1, total_notes, _results())
        # Purge thumbnails
        total_thumbs = len(all_files)  # one pass per file (checking both .jpg and .e2e variants)
        if progress_callback:
            progress_callback('thumbnails', 0, total_thumbs, _results())
        for i, (fid,) in enumerate(all_files):
            for thumb_type, ext in [('jpg', '.jpg'), ('e2e', '.e2e')]:
                thumb_id = f'{fid}{ext}'
                if not local_backend.exists('thumbnails', thumb_id):
                    continue
                try:
                    thumb_size, thumb_checksum, thumb_signature = _local_payload_snapshot('thumbnails', thumb_id)
                except Exception as e:
                    print(f'[STORAGE] Skipping local purge for thumbnail {thumb_id}: local snapshot failed: {e}')
                    skipped_thumbs += 1
                    continue
                # AUDIT FIX (purge verified remotes against the doomed local
                # copy): same defect as the file loop above. save_thumbnail()
                # records File.thumbnail_checksum / thumbnail_e2e_checksum at
                # generation time, independent of any replica or the local disk —
                # that is the authority. E2E thumbnails cannot be regenerated
                # server-side, so with no authoritative checksum we refuse to
                # reclaim the local copy rather than trust its own hash.
                _thumb_file_obj = db.session.get(File, fid)
                authoritative_thumb_checksum = None
                if _thumb_file_obj is not None:
                    authoritative_thumb_checksum = (
                        _thumb_file_obj.thumbnail_e2e_checksum if thumb_type == 'e2e'
                        else _thumb_file_obj.thumbnail_checksum
                    )
                if not authoritative_thumb_checksum:
                    print(f'[STORAGE] Skipping local purge for thumbnail {thumb_id}: no authoritative '
                          f'thumbnail checksum recorded on the File row')
                    skipped_thumbs += 1
                    continue
                if authoritative_thumb_checksum != thumb_checksum:
                    print(f'[STORAGE] Skipping local purge for thumbnail {thumb_id}: local copy does not '
                          f'match the authoritative thumbnail checksum')
                    skipped_thumbs += 1
                    continue
                thumb_checksum = authoritative_thumb_checksum
                remote_synced_query = ThumbnailReplica.query.filter(
                    ThumbnailReplica.file_id == fid,
                    ThumbnailReplica.thumb_type == thumb_type,
                    ThumbnailReplica.node_id.in_(remote_node_ids),
                    ThumbnailReplica.status == 'synced'
                )
                verified_remote = _verified_synced_replicas(
                    remote_synced_query,
                    'thumbnails',
                    thumb_id,
                    thumb_size,
                    thumb_checksum,
                )
                if len(verified_remote) >= required_remote_copies:
                    size = thumb_size or 0
                    publication_lock = _acquire_thumbnail_publication_lock(fid, thumb_type)
                    try:
                        db.session.rollback()
                        fresh_thumb_file = db.session.get(File, fid)
                        fresh_thumb_checksum = None
                        if fresh_thumb_file is not None:
                            fresh_thumb_checksum = (
                                fresh_thumb_file.thumbnail_e2e_checksum if thumb_type == 'e2e'
                                else fresh_thumb_file.thumbnail_checksum
                            )
                        final_size, final_checksum, final_signature = _local_payload_snapshot('thumbnails', thumb_id)
                        generation_changed = (
                            fresh_thumb_checksum != authoritative_thumb_checksum
                            or final_signature != thumb_signature
                            or final_size != thumb_size
                            or final_checksum != authoritative_thumb_checksum
                        )
                        if generation_changed:
                            print(f'[STORAGE] Skipping local purge for thumbnail {thumb_id}: generation changed after remote verification')
                            skipped_thumbs += 1
                        elif not _remotes_still_held(remote_synced_query, authoritative_thumb_checksum):
                            # AUDIT FIX (finding 5): same window as the file
                            # loop — re-verify remote redundancy under the lock.
                            print(f'[STORAGE] Skipping local purge for thumbnail {thumb_id}: '
                                  f'verified remote copies vanished or were fenced after '
                                  f'remote verification (node removal/drain race)')
                            skipped_thumbs += 1
                        else:
                            deleted_ok = local_backend.delete('thumbnails', thumb_id)
                            if not deleted_ok:
                                skipped_thumbs += 1
                            else:
                                purged_thumbs += 1
                                bytes_freed += size
                                # Remove local replica row since the local copy is gone
                                # AUDIT FIX P2-8: commit immediately after each purge.
                                if local_node_id:
                                    local_replica = ThumbnailReplica.query.filter_by(
                                        file_id=fid, thumb_type=thumb_type, node_id=local_node_id
                                    ).first()
                                    if local_replica:
                                        db.session.delete(local_replica)
                                db.session.commit()
                    except Exception as e:
                        print(f'[STORAGE] Purge failed for thumbnail {thumb_id}: {e}')
                        try:
                            db.session.rollback()
                        except Exception:
                            pass
                    finally:
                        _release_thumbnail_publication_lock(publication_lock)
                else:
                    skipped_thumbs += 1
            if progress_callback:
                progress_callback('thumbnails', i + 1, total_thumbs, _results())
        # Commit replica row deletions from the purge above
        try:
            db.session.commit()
        except Exception as e:
            db.session.rollback()
            print(f'[STORAGE] Failed to commit replica cleanup after purge: {e}')
        # Live-object caches may be the only recoverable copy.
        if progress_callback:
            progress_callback('cleanup', 0, 0, _results())
        _temp_prefixes = ('.cache_', '.remote_', 'repl_')
        _temp_suffixes = ('.sftp_tmp', '.tmp')
        _temp_max_age = 600  # 10 minutes
        _now_ts = time.time()
        for category, directory in [('files', self._app.config['UPLOAD_FOLDER']),
                                    ('notes', NOTES_DIR), ('thumbnails', THUMBNAILS_DIR)]:
            try:
                for fname in os.listdir(directory):
                    is_temp = any(fname.startswith(p) for p in _temp_prefixes) or \
                              any(fname.endswith(s) for s in _temp_suffixes)
                    if not is_temp:
                        continue
                    fpath = os.path.join(directory, fname)
                    try:
                        # Age guard: skip files newer than _temp_max_age
                        fstat = os.stat(fpath)
                        if _now_ts - fstat.st_mtime < _temp_max_age:
                            continue
                        if _path_held_open_by_any_process(fpath):
                            continue
                        if fname.startswith('.cache_'):
                            disk_id = fname[len('.cache_'):]
                            if category == 'files':
                                orphaned = _file_filename_still_orphaned(disk_id)
                            elif category == 'notes':
                                orphaned = _note_id_still_orphaned(disk_id)
                            else:
                                orphaned = _file_id_still_orphaned(disk_id.rsplit('.', 1)[0])
                            if not orphaned:
                                continue
                        sz = fstat.st_size
                        os.remove(fpath)
                        bytes_freed += sz
                    except Exception:
                        pass
            except Exception:
                pass
        total = purged_files + purged_notes + purged_thumbs
        if total > 0:
            mb_freed = bytes_freed / (1024 * 1024)
            print(f'[STORAGE] Purged {purged_files} files, {purged_notes} notes, {purged_thumbs} thumbnails from local disk ({mb_freed:.1f} MB freed)')
        else:
            print(
                f'[STORAGE] No local copies to purge '
                f'(skipped {skipped_files} files, {skipped_notes} notes, {skipped_thumbs} thumbnails without {required_remote_copies} verified remote mirrors)'
            )
        return {
            'purged_files': purged_files, 'purged_notes': purged_notes, 'purged_thumbnails': purged_thumbs,
            'skipped_files': skipped_files, 'skipped_notes': skipped_notes, 'skipped_thumbnails': skipped_thumbs,
            'bytes_freed': bytes_freed,
            'required_remote_copies': required_remote_copies,
        }

    def _lock_storage_node_rows(self):
        """AUDIT FIX (finding 8): cross-process primary/row fencing.

        Takes InnoDB row locks on EVERY StorageNode row in a deterministic id
        order. Two concurrent set_primary/add_node transactions in DIFFERENT
        gunicorn workers then serialise on these locks (the in-process
        ``_state_lock`` never protected against another worker), and the
        consistent id order keeps the lockers deadlock-free with each other.
        Under REPEATABLE READ the full-range locking read also gap-locks the
        primary key, so a concurrent INSERT (add_node) blocks until the
        locker commits — closing the insert-vs-demote interleaving that could
        otherwise finish with two is_primary=True rows. Returns the fresh row
        objects. (A no-op on SQLite, which is fine: single-writer tests.)"""
        return StorageNode.query.order_by(StorageNode.id.asc()).with_for_update().all()

    def set_primary(self, node_id):
        # AUDIT FIX (finding 8): this used to be read-check + demote-all +
        # set-one with no row locks at all. Two workers racing here each
        # cleared the other's freshly-set primary and both commits landed,
        # leaving TWO is_primary=True rows (degraded read-ordering and
        # primary-selection logic everywhere downstream). The ordered
        # locking read fences the whole read-modify-write across processes.
        # It also refreshes every row in this transaction, so the target is
        # selected from that fresh set (a bare session.get could return a
        # stale identity-map instance).
        locked_rows = self._lock_storage_node_rows()
        node = next((n for n in locked_rows if n.id == node_id), None)
        if not node:
            raise ValueError(f'Storage node {node_id} not found')
        if not node.is_enabled:
            raise ValueError(f'Storage node {node.name} is disabled — enable it before setting as primary')
        node_tbl = StorageNode.__table__
        db.session.execute(
            node_tbl.update().where(node_tbl.c.is_primary == True).values(is_primary=False)
        )
        # Core UPDATE (not the ORM attribute): re-setting the CURRENT primary
        # must still land — an ORM assignment of an unchanged value would not
        # flush, and the demote above would then leave ZERO primaries.
        db.session.execute(
            node_tbl.update().where(node_tbl.c.id == node_id).values(is_primary=True)
        )
        db.session.expire(node, ('is_primary',))
        db.session.commit()
        # Post-commit invariant guard (defense-in-depth): collapse any
        # duplicate primaries a non-fenced legacy writer may have left.
        try:
            primaries = StorageNode.query.filter_by(is_primary=True).order_by(
                StorageNode.id.asc()
            ).all()
            if len(primaries) > 1:
                for extra in primaries[1:]:
                    extra.is_primary = False
                db.session.commit()
        except Exception:
            db.session.rollback()
        print(f'[STORAGE] Set primary node: {node.name}')

    def test_connection(self, node_id):
        # AUDIT FIX (finding 7): the health probe used to run while holding
        # the global state lock — a single unreachable SSH node (120s connect
        # timeout) froze every storage operation in this worker. Only the
        # node/backend snapshot and the status write-back stay locked; the
        # probe itself runs unlocked and the write-back re-reads the node
        # fresh so a drain fence published meanwhile is never overwritten.
        node_pk = None
        backend = None
        with self._state_lock:
            node = db.session.get(StorageNode, node_id)
            if not node:
                return False, 'Node not found'
            node_pk = node.id
            try:
                backend = self._backends.get(node_id)
                if not backend:
                    backend = self._create_backend(node)
            except Exception as e:
                node.status = 'error'
                db.session.commit()
                print(f'[STORAGE] Connection test failed for node {node_id}: {e}')
                return False, 'Connection test failed'

        health_ok = None
        health_error = None
        try:
            health_ok = bool(backend.health_check())
        except Exception as e:
            health_ok = False
            health_error = e

        with self._state_lock:
            # End the pre-probe transaction: otherwise get() returns the cached
            # row from the old snapshot and a concurrent drain/removal is missed.
            db.session.rollback()
            node = db.session.get(StorageNode, node_pk)
            if node is None:
                return False, 'Node removed during connection test'
            try:
                if node.status == 'draining':
                    # remove_node's fence owns this row; do not resurrect it.
                    db.session.rollback()
                    return (True, 'Connection successful') if health_ok else (False, 'Health check failed')
                if health_ok:
                    if self._pin_ssh_host_key_if_needed(node, backend):
                        db.session.commit()
                    node.status = 'online'
                    node.last_seen_at = datetime.now(timezone.utc)
                    db.session.commit()
                    return True, 'Connection successful'
                if health_ok is False and health_error is None:
                    node.status = 'offline'
                    db.session.commit()
                    return False, 'Health check failed'
                node.status = 'error'
                db.session.commit()
                print(f'[STORAGE] Connection test failed for node {node_id}: {health_error}')
                return False, 'Connection test failed'
            except Exception as e:
                # A failed commit needs a rollback before any further write.
                db.session.rollback()
                node = db.session.get(StorageNode, node_pk)
                if node is None:
                    return False, 'Node removed during connection test'
                node.status = 'error'
                db.session.commit()
                print(f'[STORAGE] Connection test failed for node {node_id}: {e}')
                return False, 'Connection test failed'

    def _expected_remote_disk_ids(self):
        files = set()
        notes = set()
        thumbnails = set()

        for (filename,) in db.session.query(File.filename).filter(File.filename.isnot(None)).all():
            if filename:
                files.add(filename)

        for (note_id,) in db.session.query(Note.id).all():
            if note_id:
                notes.add(note_id)

        thumb_rows = db.session.query(File.id, File.is_e2e_encrypted).filter_by(has_thumbnail=True).all()
        for file_id, is_e2e in thumb_rows:
            thumbnails.add(f'{file_id}.{"e2e" if is_e2e else "jpg"}')

        return {
            'files': files,
            'notes': notes,
            'thumbnails': thumbnails,
        }

    def _is_expected_storage_id(self, category, disk_id):
        """AUDIT FIX (findings 3+16): point-lookup replacement for membership
        in a full _expected_remote_disk_ids() snapshot. One PK-rooted query
        answers 'is this disk id currently live in the DB?', which is exactly
        what snapshot membership answered — but computed FRESH at delete time
        (not minutes earlier, before a long listing) and O(1) instead of a
        full-table scan per recheck. Semantics mirror the snapshot exactly:

          files:        File.filename == disk_id (PK lookup when the key has
                        the canonical '<id>.enc' shape, exact-match query for
                        any other shape)
          notes:        Note.id == disk_id (PK)
          thumbnails:   parent File.has_thumbnail with the matching variant
                        extension (.jpg / .e2e), mirroring how the snapshot
                        constructs thumbnail ids

        Raises on DB failure so callers can FAIL CLOSED; an id that simply
        cannot name a DB row (validation failure, unknown shape) is answered
        False, same as the snapshot would."""
        try:
            _validate_storage_args(category, disk_id)
        except ValueError:
            # Not a name the DB could ever hold (e.g. internal artifact key).
            return False
        if category == 'files':
            fid = disk_id[:-4] if disk_id.endswith('.enc') else None
            if fid:
                row = db.session.query(File.filename).filter(File.id == fid).first()
                return bool(row and row[0] == disk_id)
            # Non-canonical key shape: fall back to the exact set-membership
            # question (rare; correctness over speed).
            return db.session.query(File.id).filter(File.filename == disk_id).first() is not None
        if category == 'notes':
            return db.session.query(Note.id).filter(Note.id == disk_id).first() is not None
        if category == 'thumbnails':
            if '.' not in disk_id:
                return False
            base, ext = disk_id.rsplit('.', 1)
            if ext not in ('jpg', 'e2e'):
                return False
            row = db.session.query(File.has_thumbnail, File.is_e2e_encrypted).filter(
                File.id == base).first()
            if not row or not row[0]:
                return False
            return bool(row[1]) == (ext == 'e2e')
        return False

    def _cleanup_target_blocked(self, category, disk_id, node_id, fresh_expected=None):
        """CONVOY FIX reconciliation: return (blocked, reason) for a cleanup
        delete target. A target is blocked (must NOT be deleted) when a
        concurrent write has made it current since the planning snapshot, or
        when an in-flight per-target write lock is held for it. This is what
        prevents cleanup from deleting a concurrently created / current object
        from stale planning evidence.

        AUDIT FIX (findings 3+16): the expected-id question is now answered
        by a FRESH point lookup taken immediately before each delete — the old
        code re-queried the whole expected-id set ONCE per node (stale after a
        long listing) and, worse, on requery failure substituted EMPTY sets
        (fail-open: every live object looked orphaned). A lookup failure now
        blocks the delete. The ``fresh_expected`` parameter is
        accepted for call-site compatibility and ignored: the point lookup is
        strictly fresher and cheaper than any pre-built set."""
        if self._is_inflight_write(category, disk_id, node_id):
            return True, 'inflight_write'
        # An SSH put stages '<key>.tmp.<8 hex>' under the CANONICAL key's write
        # reservation, which may be held by another worker on this host.
        staged = re.match(r'^(.+)\.tmp\.[0-9a-f]{8}$', str(disk_id or ''))
        if staged:
            canonical = staged.group(1)
            if self._is_inflight_write(category, canonical, node_id):
                return True, 'inflight_write'
            probe = self._open_storage_write_lock(
                self._storage_write_lock_path(node_id, category, canonical), fcntl.LOCK_EX)
            if probe is None:
                return True, 'inflight_write'
            self._release_storage_write_lock(probe)
        try:
            if self._is_expected_storage_id(category, disk_id):
                return True, 'concurrent_create'
        except Exception as e:
            # FAIL CLOSED: if we cannot prove the object is dead, do not
            # delete it. A transient DB error must never authorise a purge.
            return True, f'expected_id_check_failed: {e}'
        return False, None

    def cleanup_remote_storage(self, node_ids=None, apply=False):
        """Clean stale remote temp keys and B2 version history.
        Dry-run by default; when apply=True the cleanup is executed.

        CONVOY FIX: ``_state_lock`` is held ONLY for short snapshots (backend
        set, node rows, expected-id set, report skeleton). All remote listing
        and delete network I/O runs WITHOUT the lock, so a single slow/offline
        node can no longer block replication finalization, health checks, the
        deferred-delete worker, or storage admin operations for the duration of
        remote I/O.

        Safety: before each apply-delete the current expected-id set is
        re-queried (unlocked) and the per-target in-flight write guard is
        re-checked via ``_cleanup_target_blocked``. A node whose drain fence
        has engaged (status == 'draining') or that was disabled since the
        snapshot is skipped via ``_target_node_accepts_writes`` so cleanup
        cannot race a remove_node drain or operate on a node an admin just
        disabled. Purge deletes of orphan keys are deferred when the key has
        become current; prune deletes target only the captured non-latest
        S3 version IDs and are likewise deferred while an in-flight write owns
        the target. The report shape is unchanged so callers/UI are unaffected.
        """
        # ── Phase A (locked): snapshot backends + node rows + expected ids ──
        with self._state_lock:
            self._check_backends_freshness()
            selected_node_ids = set(node_ids or [])
            expected_ids = self._expected_remote_disk_ids()
            nodes_query = StorageNode.query.filter(
                StorageNode.is_enabled == True,
                StorageNode.node_type != 'local',
            ).order_by(StorageNode.id)
            if selected_node_ids:
                nodes_query = nodes_query.filter(StorageNode.id.in_(selected_node_ids))
            nodes = nodes_query.all()

            report = {
                'apply': bool(apply),
                'nodes': [],
                'totals': {
                    'nodes_seen': len(nodes),
                    'nodes_cleaned': 0,
                    'version_entries_seen': 0,
                    'keys_with_actions': 0,
                    'versions_deleted': 0,
                    'current_artifacts_deleted': 0,
                    'errors': 0,
                    'skipped': 0,
                },
            }

            # Snapshot node identity as plain data so no ORM row is touched
            # outside the lock, and snapshot the live backend references from
            # the published backend dict. refresh_backends() only closes the
            # OLD backend set AFTER publishing a new one, so these references
            # stay valid for the lifetime of this call.
            node_specs = [
                {
                    'id': node.id,
                    'name': node.name,
                    'node_type': node.node_type,
                    'status': node.status,
                }
                for node in nodes
            ]
            state_backends, _local_backend, _local_node_id, _version = self._backend_state_snapshot()
            snapshot_expected = {k: set(v) for k, v in expected_ids.items()}
            node_backends = {spec['id']: state_backends.get(spec['id']) for spec in node_specs}

        # ── Phase B (UNLOCKED): listings + planning + reconciliation + I/O ──
        for spec in node_specs:
            node_id = spec['id']
            backend = node_backends.get(node_id)
            node_report = {
                'node_id': node_id,
                'node_name': spec['name'],
                'node_type': spec['node_type'],
                'status': 'ok',
                'mode': 'artifact_only',
                'categories': {},
                'errors': [],
            }
            report['nodes'].append(node_report)

            if not backend:
                node_report['status'] = 'error'
                node_report['errors'].append('NO BACKEND AVAILABLE')
                report['totals']['errors'] += 1
                continue

            # Drain-fence / disabled-since-snapshot recheck (fresh, unlocked).
            # A draining node is being evacuated by remove_node(); a node an
            # admin just disabled must not be cleaned. _target_node_accepts_writes
            # rolls back any detached snapshot before consulting the fence.
            if not self._target_node_accepts_writes(node_id):
                node_report['status'] = 'error'
                node_report['errors'].append('NODE DRAINING / UNAVAILABLE')
                report['totals']['errors'] += 1
                continue

            # AUDIT FIX (findings 3+16): the per-node full expected-id requery
            # that used to run here was BOTH stale (taken once, before this
            # node's long listing) and fail-open (its except branch
            # substituted empty sets, making every live object look orphaned).
            # _cleanup_target_blocked now performs a fresh, O(1), fail-closed
            # point lookup immediately before every actual delete.

            if isinstance(backend, _S3Backend) and backend._is_backblaze_b2():
                node_report['mode'] = 'b2_versions'
                client = backend._get_client()
                for category in ('files', 'notes', 'thumbnails'):
                    category_report = {
                        'version_entries_seen': 0,
                        'keys_seen': 0,
                        'keys_purged': 0,
                        'keys_pruned': 0,
                        'keys_skipped': 0,
                        'versions_deleted': 0,
                        'actions': [],
                    }
                    node_report['categories'][category] = category_report
                    try:
                        entries = backend.list_object_versions(category)
                        plans = _plan_s3_version_cleanup(entries, snapshot_expected.get(category, set()))
                        category_report['version_entries_seen'] = len(entries)
                        category_report['keys_seen'] = len(plans)
                        report['totals']['version_entries_seen'] += len(entries)
                        for plan in plans:
                            if plan['action'] == 'noop':
                                continue
                            report['totals']['keys_with_actions'] += 1
                            disk_id = plan.get('file_id')

                            # Reconciliation: never delete a target a concurrent
                            # write has made current. Applies to whole-key purges
                            # and to version pruning alike; prune version IDs are
                            # only ever non-latest, but we still defer while an
                            # in-flight write owns the target so cleanup cannot
                            # race a landing upload's version history.
                            blocked, reason = (False, None)
                            if apply and disk_id is not None and plan.get('action') in ('purge', 'prune'):
                                # AUDIT FIX (finding 3): this recheck happens
                                # PER DELETE with a fresh point lookup and
                                # fails closed — no stale per-node snapshot.
                                if plan.get('action') == 'prune':
                                    # Pruning only removes non-latest versions of a
                                    # live key, so only an in-flight write blocks it.
                                    if self._is_inflight_write(category, disk_id, node_id):
                                        blocked, reason = True, 'inflight_write'
                                else:
                                    blocked, reason = self._cleanup_target_blocked(
                                        category, disk_id, node_id)

                            if blocked:
                                plan['action'] = 'skip'
                                plan['reason'] = reason or 'blocked'
                                category_report['actions'].append(plan)
                                category_report['keys_skipped'] += 1
                                report['totals']['skipped'] += 1
                                continue

                            category_report['actions'].append(plan)
                            if plan['action'] == 'skip':
                                category_report['keys_skipped'] += 1
                                report['totals']['skipped'] += 1
                                continue
                            if apply and plan['delete_version_ids']:
                                for version_id in plan['delete_version_ids']:
                                    client.delete_object(Bucket=backend._bucket, Key=plan['key'], VersionId=version_id)
                            delete_count = len(plan['delete_version_ids'])
                            category_report['versions_deleted'] += delete_count
                            report['totals']['versions_deleted'] += delete_count
                            if plan['action'] == 'purge':
                                category_report['keys_purged'] += 1
                            elif plan['action'] == 'prune':
                                category_report['keys_pruned'] += 1
                    except Exception as e:
                        node_report['status'] = 'error'
                        node_report['errors'].append(f'{category.upper()}: {e}')
                        report['totals']['errors'] += 1
            else:
                for category in ('files', 'notes', 'thumbnails'):
                    category_report = {
                        'artifact_keys_seen': 0,
                        'artifact_keys_deleted': 0,
                        'actions': [],
                    }
                    node_report['categories'][category] = category_report
                    try:
                        current_ids = backend.list_files(category)
                        for file_id in current_ids:
                            if not _is_internal_storage_artifact(file_id):
                                continue
                            category_report['artifact_keys_seen'] += 1
                            action = {
                                'file_id': file_id,
                                'key': file_id,
                                'action': 'purge',
                                'reason': 'internal_artifact',
                            }

                            # Reconciliation before delete: defer if a
                            # concurrent write owns this target. Internal
                            # artifact names are never real uploads, but the
                            # guard keeps the stale-evidence invariant uniform
                            # across both code paths.
                            if apply:
                                # AUDIT FIX (finding 3): fresh fail-closed
                                # point lookup per delete (see above).
                                blocked, reason = self._cleanup_target_blocked(
                                    category, file_id, node_id)
                                if blocked:
                                    action['action'] = 'skip'
                                    action['reason'] = reason or 'blocked'
                                    category_report['actions'].append(action)
                                    report['totals']['keys_with_actions'] += 1
                                    report['totals']['skipped'] += 1
                                    continue

                            category_report['actions'].append(action)
                            report['totals']['keys_with_actions'] += 1
                            if apply:
                                backend.delete(category, file_id)
                            category_report['artifact_keys_deleted'] += 1
                            report['totals']['current_artifacts_deleted'] += 1
                    except Exception as e:
                        node_report['status'] = 'error'
                        node_report['errors'].append(f'{category.upper()}: {e}')
                        report['totals']['errors'] += 1

            if node_report['status'] == 'ok':
                report['totals']['nodes_cleaned'] += 1

        return report

    def get_node_tracked_storage_breakdown(self, node_id):
        """Return DB-tracked bytes for a node without hitting remote providers.
        Used for accurate admin metrics and S3 node storage totals."""
        node = db.session.get(StorageNode, node_id)
        if not node:
            return None
        registered_file_bytes = db.session.query(
            db.func.coalesce(db.func.sum(db.func.coalesce(FileReplica.size_bytes, File.size, 0)), 0)
        ).select_from(FileReplica).join(File, File.id == FileReplica.file_id).filter(
            FileReplica.node_id == node_id,
            FileReplica.status == 'synced',
            File.is_temp_upload == False,
        ).scalar() or 0
        temp_file_bytes = db.session.query(
            db.func.coalesce(db.func.sum(db.func.coalesce(FileReplica.size_bytes, File.size, 0)), 0)
        ).select_from(FileReplica).join(File, File.id == FileReplica.file_id).filter(
            FileReplica.node_id == node_id,
            FileReplica.status == 'synced',
            File.is_temp_upload == True,
        ).scalar() or 0
        note_bytes = db.session.query(
            db.func.coalesce(db.func.sum(Note.size), 0)
        ).join(NoteReplica, Note.id == NoteReplica.note_id).filter(
            NoteReplica.node_id == node_id,
            NoteReplica.status == 'synced',
            NoteReplica.synced_version == Note.content_version,
        ).scalar() or 0
        registered_thumb_bytes = db.session.query(
            db.func.coalesce(db.func.sum(ThumbnailReplica.size_bytes), 0)
        ).select_from(ThumbnailReplica).join(File, File.id == ThumbnailReplica.file_id).filter(
            ThumbnailReplica.node_id == node_id,
            ThumbnailReplica.status == 'synced',
            File.is_temp_upload == False,
        ).scalar() or 0
        temp_thumb_bytes = db.session.query(
            db.func.coalesce(db.func.sum(ThumbnailReplica.size_bytes), 0)
        ).select_from(ThumbnailReplica).join(File, File.id == ThumbnailReplica.file_id).filter(
            ThumbnailReplica.node_id == node_id,
            ThumbnailReplica.status == 'synced',
            File.is_temp_upload == True,
        ).scalar() or 0
        registered_bytes = int(registered_file_bytes) + int(note_bytes) + int(registered_thumb_bytes)
        temp_bytes = int(temp_file_bytes) + int(temp_thumb_bytes)
        return {
            'registered_file_bytes': int(registered_file_bytes),
            'temp_file_bytes': int(temp_file_bytes),
            'note_bytes': int(note_bytes),
            'registered_thumb_bytes': int(registered_thumb_bytes),
            'temp_thumb_bytes': int(temp_thumb_bytes),
            'registered_bytes': registered_bytes,
            'temp_bytes': temp_bytes,
            'tracked_total_bytes': registered_bytes + temp_bytes,
        }

    def get_node_disk_usage(self, node_id):
        """Get disk usage for a storage node. Returns cached data if available
        and fresh (within TTL), otherwise queries the backend live. Returns
        None for unsupported backends (S3)."""
        # AUDIT FIX P2-3: enforce a TTL on the disk-usage cache so stale
        # entries (e.g. after a node goes offline or disk fills) are not
        # served indefinitely.
        _DU_CACHE_TTL = 60  # seconds
        node = db.session.get(StorageNode, node_id)
        if not node:
            return None
        if node.node_type == 's3':
            # For S3-compatible storage, avoid expensive provider API calls (HEAD/listing).
            # Instead, compute app-managed used bytes from replica metadata already in the DB.
            tracked = self.get_node_tracked_storage_breakdown(node_id) or {}
            return {
                'data': {
                    'metric_type': 'used_only',
                    'used_bytes': tracked.get('tracked_total_bytes', 0),
                },
                'cached_at': datetime.now(timezone.utc).isoformat()
            }
        # Check cache first — but honor TTL (CONCURRENCY FIX F3: under lock)
        with self._disk_usage_lock:
            cached = self._disk_usage_cache.get(node_id)
        if cached:
            try:
                cached_at = datetime.fromisoformat(cached.get('cached_at', ''))
                if (datetime.now(timezone.utc) - cached_at).total_seconds() < _DU_CACHE_TTL:
                    return cached
            except Exception:
                pass  # Malformed cache entry — fall through to live query
        # Query live (outside the lock — backend.disk_usage() may be slow)
        try:
            backend = self._backends.get(node_id)
            if not backend:
                backend = self._create_backend(node)
            result = backend.disk_usage()
            if result:
                cached_at = datetime.now(timezone.utc).isoformat()
                entry = {'data': result, 'cached_at': cached_at}
                with self._disk_usage_lock:
                    self._disk_usage_cache[node_id] = entry
                return entry
        except Exception as e:
            print(f'[STORAGE] disk_usage query failed for node {node_id}: {e}')
        return None
