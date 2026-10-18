class _StorageManagerReplication:

    # ---- Replication tracking ----

    def _mark_replica_synced(self, resource_type, resource_id, node_id):
        if node_id is None:
            return
        try:
            if resource_type == 'file':
                fid = resource_id.replace('.enc', '') if resource_id.endswith('.enc') else resource_id
                file_size = self._tracked_file_size_bytes(fid)
                file_checksum = self._tracked_file_checksum_hex(fid)
                file_obj = db.session.get(File, fid)
                if file_obj and file_checksum and not file_obj.payload_checksum:
                    file_obj.payload_checksum = file_checksum
                replica = FileReplica.query.filter_by(file_id=fid, node_id=node_id).first()
                if replica:
                    replica.status = 'synced'
                    replica.error_count = 0
                    replica.last_error = None
                    replica.verified_at = datetime.now(timezone.utc)
                    if file_size is not None:
                        replica.size_bytes = file_size
                    if file_checksum:
                        replica.checksum = file_checksum
                else:
                    db.session.add(FileReplica(
                        file_id=fid, node_id=node_id, status='synced',
                        verified_at=datetime.now(timezone.utc), size_bytes=file_size, checksum=file_checksum,
                    ))
            elif resource_type == 'note':
                note_obj = db.session.get(Note, resource_id)
                note_version = int(note_obj.content_version or 1) if note_obj else 1
                note_checksum = note_obj.content_checksum if note_obj else None
                replica = NoteReplica.query.filter_by(note_id=resource_id, node_id=node_id).first()
                if replica:
                    replica.status = 'synced'
                    replica.synced_version = note_version
                    replica.target_version = note_version
                    replica.checksum = note_checksum
                    replica.error_count = 0
                    replica.last_error = None
                    replica.verified_at = datetime.now(timezone.utc)
                else:
                    db.session.add(NoteReplica(
                        note_id=resource_id,
                        node_id=node_id,
                        status='synced',
                        synced_version=note_version,
                        target_version=note_version,
                        checksum=note_checksum,
                        verified_at=datetime.now(timezone.utc),
                    ))
            elif resource_type == 'thumbnail':
                parts = resource_id.split(':')
                fid, ttype = parts[0], parts[1] if len(parts) > 1 else 'jpg'
                thumb_size = self._thumbnail_size_bytes(fid, ttype)
                # AUDIT FIX M3: persist the thumbnail checksum at sync time so
                # load_thumbnail() and the scrub can verify replicas without a
                # lazy re-hash. Files and notes already did this; thumbnails
                # were the only replica type that left checksum null at write.
                thumb_checksum = self._tracked_thumbnail_checksum_hex(fid, ttype)
                replica = ThumbnailReplica.query.filter_by(file_id=fid, thumb_type=ttype, node_id=node_id).first()
                if replica:
                    replica.status = 'synced'
                    replica.error_count = 0
                    replica.last_error = None
                    replica.verified_at = datetime.now(timezone.utc)
                    if thumb_size is not None:
                        replica.size_bytes = thumb_size
                    if thumb_checksum:
                        replica.checksum = thumb_checksum
                else:
                    db.session.add(ThumbnailReplica(
                        file_id=fid, thumb_type=ttype, node_id=node_id, status='synced',
                        verified_at=datetime.now(timezone.utc), size_bytes=thumb_size,
                        checksum=thumb_checksum,
                    ))
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[ERROR] Failed to mark replica synced for {resource_type}/{resource_id} on node {node_id}: {e}')
            # AUDIT FIX H3: the rollback above expunged every pending object in
            # the session (e.g. an in-flight upload's uncommitted File row).
            # Raise a distinct type so callers can tell "DB state was rolled
            # back -- ABORT" apart from a benign per-artifact failure instead
            # of committing whatever survived the rollback.
            raise ReplicaSessionRollbackError(
                f'replica synced-marking failed for {resource_type}/{resource_id} on node {node_id}: {e}'
            ) from e

    def _mark_pending_replicas(self, resource_type, resource_id, exclude_node_id):
        try:
            nodes = StorageNode.query.all()
            for node in nodes:
                if node.id == exclude_node_id:
                    continue
                if resource_type == 'file':
                    fid = resource_id.replace('.enc', '') if resource_id.endswith('.enc') else resource_id
                    existing = FileReplica.query.filter_by(file_id=fid, node_id=node.id).first()
                    if not existing:
                        if node.is_enabled:
                            db.session.add(FileReplica(file_id=fid, node_id=node.id, status='pending'))
                    # AUDIT FIX (5th audit): include 'syncing' so a concurrent
                    # rewrite re-queues an in-flight replication (mirrors notes);
                    # the cycle's conditional UPDATE WHERE status='syncing' then
                    # safely abandons the stale upload.
                    elif existing.status in ('synced', 'syncing', 'error', 'missing'):
                        existing.status = 'pending'
                        existing.verified_at = None
                        existing.error_count = 0
                        existing.last_error = None
                        # AUDIT FIX (5th audit, stale integrity evidence): a content
                        # change invalidates the recorded checksum/size for this node.
                        # Clear them so node-removal safety and read-replica selection
                        # never trust a checksum that predates the new payload (esp.
                        # when the next write lands on a size-only backend that cannot
                        # refresh it).
                        existing.checksum = None
                        existing.size_bytes = None
                        # AUDIT FIX (size-only replicas excluded from failover):
                        # clear the trust flag with the checksum it describes.
                        existing.checksum_verified = None
                elif resource_type == 'note':
                    note_obj = db.session.get(Note, resource_id)
                    note_version = int(note_obj.content_version or 1) if note_obj else 1
                    existing = NoteReplica.query.filter_by(note_id=resource_id, node_id=node.id).first()
                    if not existing:
                        if node.is_enabled:
                            db.session.add(NoteReplica(
                                note_id=resource_id,
                                node_id=node.id,
                                status='pending',
                                target_version=note_version,
                            ))
                    elif existing.status in ('synced', 'error', 'missing', 'syncing') or (existing.target_version or 0) != note_version:
                        existing.status = 'pending'
                        existing.target_version = note_version
                        existing.verified_at = None
                        existing.error_count = 0
                        existing.last_error = None
                        # AUDIT FIX (size-only replicas excluded from failover):
                        # a content change invalidates any prior verification.
                        existing.checksum = None
                        existing.checksum_verified = None
                elif resource_type == 'thumbnail':
                    parts = resource_id.split(':')
                    fid, ttype = parts[0], parts[1] if len(parts) > 1 else 'jpg'
                    existing = ThumbnailReplica.query.filter_by(file_id=fid, thumb_type=ttype, node_id=node.id).first()
                    if not existing:
                        if node.is_enabled:
                            db.session.add(ThumbnailReplica(file_id=fid, thumb_type=ttype, node_id=node.id, status='pending'))
                    # AUDIT FIX (5th audit): include 'syncing' (mirrors notes/files)
                    # and clear stale integrity evidence on the pending transition.
                    elif existing.status in ('synced', 'syncing', 'error', 'missing'):
                        existing.status = 'pending'
                        existing.verified_at = None
                        existing.error_count = 0
                        existing.last_error = None
                        existing.checksum = None
                        existing.size_bytes = None
                        # AUDIT FIX (size-only replicas excluded from failover):
                        # clear the trust flag with the checksum it describes.
                        existing.checksum_verified = None
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[REPLICATION] Failed to mark pending replicas for {resource_type}/{resource_id} (exclude node {exclude_node_id}): {e}')
            # AUDIT FIX H3: typed failure signal -- see _mark_replica_synced.
            # The rollback above expunged all pending session objects; callers
            # with uncommitted work must abort rather than commit.
            raise ReplicaSessionRollbackError(
                f'pending-replica marking failed for {resource_type}/{resource_id} (exclude node {exclude_node_id}): {e}'
            ) from e

    def _all_remote_nodes_verified(self, category, item_id, remote_node_ids, thumb_type=None):
        backends, local_backend, _local_node_id, _version = self._backend_state_snapshot()
        expected_size = None
        expected_checksum = None
        if category == 'files':
            disk_id = f'{item_id}.enc'
            file_obj = db.session.get(File, item_id)
            if not file_obj or not file_obj.payload_checksum:
                return False
            expected_checksum = file_obj.payload_checksum
            if file_obj.disk_size is not None:
                expected_size = int(file_obj.disk_size)
            else:
                expected_size = self._tracked_file_size_bytes(item_id)
        elif category == 'notes':
            disk_id = item_id
            note_obj = db.session.get(Note, item_id)
            if not note_obj:
                return False
            expected_size = int(note_obj.size) if note_obj.size is not None else None
            expected_checksum = note_obj.content_checksum
            if not expected_checksum:
                try:
                    local_path = local_backend.get_path('notes', disk_id)
                    if os.path.isfile(local_path):
                        expected_checksum = self._sha256_file(local_path)
                        note_obj.content_checksum = expected_checksum
                except Exception:
                    expected_checksum = None
        else:
            disk_id = f'{item_id}.{"e2e" if thumb_type == "e2e" else "jpg"}'
            expected_size = self._thumbnail_size_bytes(item_id, thumb_type or 'jpg')
            try:
                local_path = local_backend.get_path('thumbnails', disk_id)
                if os.path.isfile(local_path):
                    expected_checksum = self._sha256_file(local_path)
            except Exception:
                expected_checksum = None
            if not expected_checksum:
                expected_checksum = self._tracked_thumbnail_checksum_hex(item_id, thumb_type or 'jpg')

        if not expected_checksum:
            return False

        for node_id in remote_node_ids:
            backend = backends.get(node_id)
            if not backend:
                return False
            if category == 'files':
                replica = FileReplica.query.filter_by(file_id=item_id, node_id=node_id, status='synced').first()
            elif category == 'notes':
                note_obj = db.session.get(Note, item_id)
                note_version = int(note_obj.content_version or 1) if note_obj else 1
                replica = NoteReplica.query.filter_by(
                    note_id=item_id,
                    node_id=node_id,
                    status='synced',
                    synced_version=note_version,
                    checksum=expected_checksum,
                ).first()
            else:
                replica = ThumbnailReplica.query.filter_by(file_id=item_id, thumb_type=thumb_type, node_id=node_id, status='synced').first()
            if not replica:
                return False
            if category == 'notes':
                note_obj = db.session.get(Note, item_id)
                if not note_obj:
                    return False
                note_version = int(note_obj.content_version or 1)
                note_checksum = note_obj.content_checksum
                if (replica.synced_version or 0) != note_version:
                    return False
                if (replica.target_version or 0) not in (0, note_version):
                    return False
                if note_checksum and replica.checksum != note_checksum:
                    return False
            if not self._verify_remote_replica_payload(
                replica,
                backend,
                category,
                disk_id,
                expected_size,
                expected_checksum,
                'LOCAL CACHE CLEANUP',
                update_replica=True,
            ):
                return False
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            return False
        return True

    def _resource_exists_for_replication(self, category, item_id):
        try:
            if category == 'files':
                return db.session.get(File, item_id) is not None
            if category == 'notes':
                return db.session.get(Note, item_id) is not None
            if category == 'thumbnails':
                file_id = item_id.rsplit('.', 1)[0]
                file_obj = db.session.get(File, file_id)
                return file_obj is not None and bool(file_obj.has_thumbnail)
        except Exception as e:
            # AUDIT FIX P2-6: distinguish DB connection errors (OperationalError)
            # from genuine not-found. On a DB error, re-raise so the caller
            # treats the item as retriable (status='error') instead of
            # 'exists=True', which would strand it in 'missing' forever when
            # the DB comes back and the resource is actually gone.
            try:
                from sqlalchemy.exc import OperationalError as _OpErr
                if isinstance(e, _OpErr):
                    raise
            except ImportError:
                pass
            return True
        return True

    def get_replication_status(self):
        try:
            enabled_nodes = StorageNode.query.filter_by(is_enabled=True).all()
            node_count = len(enabled_nodes)
            # AUDIT FIX P2-1: scope the global backlog/error counts to ENABLED
            # nodes. The replication cycle only ever processes enabled+active
            # nodes (see _active_node_ids), but a disabled node still keeps its
            # FileReplica/NoteReplica/ThumbnailReplica rows. _mark_pending_replicas
            # can reset those rows to 'pending' on a later write, so counting all
            # nodes made replication look permanently "stuck" with a backlog that
            # is intentionally not being processed. Counting only enabled-node
            # rows reflects the work that will actually be done.
            enabled_node_ids = [n.id for n in enabled_nodes]
            if enabled_node_ids:
                pending_files = FileReplica.query.filter(
                    FileReplica.status.in_(['pending', 'syncing']),
                    FileReplica.node_id.in_(enabled_node_ids),
                ).count()
                pending_notes = NoteReplica.query.filter(
                    NoteReplica.status.in_(['pending', 'syncing']),
                    NoteReplica.node_id.in_(enabled_node_ids),
                ).count()
                pending_thumbs = ThumbnailReplica.query.filter(
                    ThumbnailReplica.status.in_(['pending', 'syncing']),
                    ThumbnailReplica.node_id.in_(enabled_node_ids),
                ).count()
                # AUDIT FIX (size-only replicas excluded from failover): a
                # size-only-accepted write now RECORDS its checksum, so
                # "checksum IS NULL" no longer captures the unverified set.
                # Count anything that is not positively hash-confirmed.
                unverified_file_replicas = FileReplica.query.filter(
                    FileReplica.status == 'synced',
                    db.or_(FileReplica.checksum.is_(None), FileReplica.checksum_verified.isnot(True)),
                    FileReplica.node_id.in_(enabled_node_ids),
                ).count()
                unverified_note_replicas = NoteReplica.query.filter(
                    NoteReplica.status == 'synced',
                    db.or_(NoteReplica.checksum.is_(None), NoteReplica.checksum_verified.isnot(True)),
                    NoteReplica.node_id.in_(enabled_node_ids),
                ).count()
                unverified_thumb_replicas = ThumbnailReplica.query.filter(
                    ThumbnailReplica.status == 'synced',
                    db.or_(ThumbnailReplica.checksum.is_(None), ThumbnailReplica.checksum_verified.isnot(True)),
                    ThumbnailReplica.node_id.in_(enabled_node_ids),
                ).count()
            else:
                pending_files = pending_notes = pending_thumbs = 0
                unverified_file_replicas = unverified_note_replicas = unverified_thumb_replicas = 0
            pending_remote_deletes = PendingRemoteDelete.query.count()
            stalled_remote_deletes = PendingRemoteDelete.query.filter(
                PendingRemoteDelete.retry_count >= self.DEFERRED_DELETE_WARN_RETRIES
            ).count()
            # AUDIT FIX P2-4: expose the oldest pending remote delete age so
            # operators can detect a stuck queue without manual DB queries.
            oldest_pending_delete_age_hours = 0
            try:
                _oldest = PendingRemoteDelete.query.order_by(PendingRemoteDelete.created_at).first()
                if _oldest and _oldest.created_at:
                    _oldest_dt = _oldest.created_at
                    if _oldest_dt.tzinfo is None:
                        _oldest_dt = _oldest_dt.replace(tzinfo=timezone.utc)
                    oldest_pending_delete_age_hours = round(
                        (datetime.now(timezone.utc) - _oldest_dt).total_seconds() / 3600, 1
                    )
            except Exception:
                pass
            # AUDIT FIX P2-9: count pending replicas blocked by offline/error
            # nodes so operators can see the backlog instead of a flat
            # 'pending_files' number that hides the cause.
            offline_node_ids = [n.id for n in enabled_nodes if n.status in ('offline', 'error')]
            blocked_files = 0
            blocked_notes = 0
            blocked_thumbs = 0
            if offline_node_ids:
                blocked_files = FileReplica.query.filter(
                    FileReplica.status.in_(['pending', 'syncing']),
                    FileReplica.node_id.in_(offline_node_ids)
                ).count()
                blocked_notes = NoteReplica.query.filter(
                    NoteReplica.status.in_(['pending', 'syncing']),
                    NoteReplica.node_id.in_(offline_node_ids)
                ).count()
                blocked_thumbs = ThumbnailReplica.query.filter(
                    ThumbnailReplica.status.in_(['pending', 'syncing']),
                    ThumbnailReplica.node_id.in_(offline_node_ids)
                ).count()
            # AUDIT FIX P2-1: only count exhausted errors on enabled nodes — a
            # disabled node's stale 'error' rows are not actionable backlog.
            _err_file_q = FileReplica.query.filter(
                FileReplica.status == 'error',
                FileReplica.error_count >= self.MAX_ERROR_RETRIES,
            )
            _err_note_q = NoteReplica.query.filter(
                NoteReplica.status == 'error',
                NoteReplica.error_count >= self.MAX_ERROR_RETRIES,
            )
            _err_thumb_q = ThumbnailReplica.query.filter(
                ThumbnailReplica.status == 'error',
                ThumbnailReplica.error_count >= self.MAX_ERROR_RETRIES,
            )
            # Unconditional: with no enabled node, nothing is actionable (an empty
            # IN matches no rows instead of counting every disabled node).
            _err_file_q = _err_file_q.filter(FileReplica.node_id.in_(enabled_node_ids))
            _err_note_q = _err_note_q.filter(NoteReplica.node_id.in_(enabled_node_ids))
            _err_thumb_q = _err_thumb_q.filter(ThumbnailReplica.node_id.in_(enabled_node_ids))
            exhausted_error_files = _err_file_q.count()
            exhausted_error_notes = _err_note_q.count()
            exhausted_error_thumbs = _err_thumb_q.count()
            total_files = File.query.count()
            total_notes = Note.query.count()
            # Count files that have data on at least one node (excludes files with missing data)
            # A 'missing' row only makes the object unreplicable when no other
            # replica of it is still synced.
            missing_f = db.session.query(FileReplica.file_id).filter(
                FileReplica.status == 'missing',
                ~FileReplica.file_id.in_(db.session.query(FileReplica.file_id).filter(FileReplica.status == 'synced')),
            ).distinct().count()
            replicable_files = total_files - missing_f
            missing_n = db.session.query(NoteReplica.note_id).filter(
                NoteReplica.status == 'missing',
                ~NoteReplica.note_id.in_(db.session.query(NoteReplica.note_id).filter(NoteReplica.status == 'synced')),
            ).distinct().count()
            replicable_notes = total_notes - missing_n
            # Count total unique thumbnails tracked in the system
            total_thumbnails = ThumbnailReplica.query.with_entities(
                ThumbnailReplica.file_id, ThumbnailReplica.thumb_type
            ).distinct().count()
            per_node = []
            for node in enabled_nodes:
                synced_files = FileReplica.query.filter_by(node_id=node.id, status='synced').count()
                pending_f = FileReplica.query.filter(FileReplica.node_id == node.id, FileReplica.status.in_(['pending', 'syncing'])).count()
                error_f = FileReplica.query.filter_by(node_id=node.id, status='error').count()
                missing_files = FileReplica.query.filter_by(node_id=node.id, status='missing').count()
                # Note counts per node
                synced_n = NoteReplica.query.filter_by(node_id=node.id, status='synced').count()
                pending_n = NoteReplica.query.filter(NoteReplica.node_id == node.id, NoteReplica.status.in_(['pending', 'syncing'])).count()
                error_n = NoteReplica.query.filter_by(node_id=node.id, status='error').count()
                # Thumbnail counts per node
                synced_t = ThumbnailReplica.query.filter_by(node_id=node.id, status='synced').count()
                pending_t = ThumbnailReplica.query.filter(ThumbnailReplica.node_id == node.id, ThumbnailReplica.status.in_(['pending', 'syncing'])).count()
                error_t = ThumbnailReplica.query.filter_by(node_id=node.id, status='error').count()
                total_t_node = ThumbnailReplica.query.filter_by(node_id=node.id).count()
                unverified_f = FileReplica.query.filter(
                    FileReplica.node_id == node.id,
                    FileReplica.status == 'synced',
                    db.or_(FileReplica.checksum.is_(None), FileReplica.checksum_verified.isnot(True)),
                ).count()
                unverified_n = NoteReplica.query.filter(
                    NoteReplica.node_id == node.id,
                    NoteReplica.status == 'synced',
                    db.or_(NoteReplica.checksum.is_(None), NoteReplica.checksum_verified.isnot(True)),
                ).count()
                unverified_t = ThumbnailReplica.query.filter(
                    ThumbnailReplica.node_id == node.id,
                    ThumbnailReplica.status == 'synced',
                    db.or_(ThumbnailReplica.checksum.is_(None), ThumbnailReplica.checksum_verified.isnot(True)),
                ).count()
                # Combined sync percentage across files, notes, and thumbnails
                replicable_f_node = synced_files + pending_f + error_f
                replicable_n_node = synced_n + pending_n + error_n
                replicable_t_node = synced_t + pending_t + error_t
                total_replicable = replicable_f_node + replicable_n_node + replicable_t_node
                total_synced = synced_files + synced_n + synced_t
                pct = (total_synced / total_replicable * 100) if total_replicable > 0 else 100
                per_node.append({
                    'node_id': node.id, 'name': node.name, 'type': node.node_type,
                    'status': node.status, 'sync_percent': round(pct, 1),
                    'synced_files': synced_files, 'total_files': replicable_files,
                    'pending_files': pending_f, 'error_files': error_f,
                    'missing_files': missing_files,
                    'synced_notes': synced_n, 'total_notes': replicable_notes,
                    'pending_notes': pending_n, 'error_notes': error_n,
                    'synced_thumbnails': synced_t, 'total_thumbnails': total_t_node,
                    'pending_thumbnails': pending_t, 'error_thumbnails': error_t,
                    'unverified_checksum_replicas': unverified_f + unverified_n + unverified_t,
                    'last_seen': node.last_seen_at.isoformat() if node.last_seen_at else None,
                })
            # AUDIT FIX: single-node deployments previously reported
            # fully_synced=True even with pending writes, which was misleading.
            # fully_synced now honestly reflects whether any replication work
            # remains, and single_node_mode is exposed so the UI can explain.
            # Errored replicas (retryable or exhausted) are missing mirrors too.
            error_replicas = sum(p['error_files'] + p['error_notes'] + p['error_thumbnails'] for p in per_node)
            fully_synced = (
                pending_files == 0 and pending_notes == 0 and pending_thumbs == 0 and pending_remote_deletes == 0
                and error_replicas == 0
            )
            # AUDIT FIX (single-copy residency was invisible): surface the
            # under-replicated payload counts through the existing storage-status
            # API so the admin UI can show them. TTL-cached so polling this
            # endpoint cannot re-run the GROUP BY scans on every request.
            _single_copy = self._single_copy_snapshot()
            return {
                'nodes': node_count,
                'single_node_mode': node_count <= 1,
                'fully_synced': fully_synced,
                'pending_files': pending_files, 'pending_notes': pending_notes,
                'pending_thumbnails': pending_thumbs,
                'pending_remote_deletes': pending_remote_deletes,
                'stalled_remote_deletes': stalled_remote_deletes,
                'oldest_pending_delete_age_hours': oldest_pending_delete_age_hours,
                'exhausted_error_files': exhausted_error_files,
                'exhausted_error_notes': exhausted_error_notes,
                'exhausted_error_thumbnails': exhausted_error_thumbs,
                'distinct_missing_files': missing_f,
                'blocked_files': blocked_files,
                'blocked_notes': blocked_notes,
                'blocked_thumbnails': blocked_thumbs,
                'unverified_checksum_replicas': (
                    unverified_file_replicas + unverified_note_replicas + unverified_thumb_replicas
                ),
                'single_copy_files': _single_copy.get('single_copy_files', 0),
                'single_copy_notes': _single_copy.get('single_copy_notes', 0),
                'single_copy_thumbnails': _single_copy.get('single_copy_thumbnails', 0),
                'aged_single_copy_files': _single_copy.get('aged_single_copy_files', 0),
                'aged_single_copy_notes': _single_copy.get('aged_single_copy_notes', 0),
                'zero_copy_files': _single_copy.get('zero_copy_files', 0),
                'zero_copy_notes': _single_copy.get('zero_copy_notes', 0),
                'single_copy_alert_after_seconds': _single_copy.get('single_copy_alert_after_seconds', 0),
                'per_node': per_node,
            }
        except Exception as e:
            print(f'[STORAGE] Failed to get replication status: {e}')
            return {
                'nodes': 0,
                'single_node_mode': True,
                'fully_synced': False,
                'pending_files': 0,
                'pending_notes': 0,
                'pending_thumbnails': 0,
                'pending_remote_deletes': 0,
                'stalled_remote_deletes': 0,
                'exhausted_error_files': 0,
                'exhausted_error_notes': 0,
                'exhausted_error_thumbnails': 0,
                'distinct_missing_files': 0,
                'blocked_files': 0,
                'blocked_notes': 0,
                'blocked_thumbnails': 0,
                'unverified_checksum_replicas': 0,
                'single_copy_files': 0,
                'single_copy_notes': 0,
                'single_copy_thumbnails': 0,
                'aged_single_copy_files': 0,
                'aged_single_copy_notes': 0,
                'zero_copy_files': 0,
                'zero_copy_notes': 0,
                'single_copy_alert_after_seconds': 0,
                'per_node': [],
            }

    def _compute_single_copy_snapshot(self):
        """Count payloads that currently have fewer than TWO synced copies.

        AUDIT FIX (single-copy residency was invisible): a payload with one
        synced replica is one disk failure away from total loss, and because
        backup_prod.py excludes the payload directories on the assumption that
        replication is complete, there is no other safety net. Nothing counted or
        surfaced this. `zero_copy_*` (no synced replica at all) is strictly worse
        and is broken out separately.

        Only ENABLED nodes count, matching what replication will actually do."""
        result = {
            'multi_node': False,
            'single_copy_files': 0, 'single_copy_notes': 0, 'single_copy_thumbnails': 0,
            'zero_copy_files': 0, 'zero_copy_notes': 0,
            'aged_single_copy_files': 0, 'aged_single_copy_notes': 0,
            'single_copy_alert_after_seconds': self.SINGLE_COPY_ALERT_AFTER_SECONDS,
        }
        try:
            enabled_node_ids = [n.id for n in StorageNode.query.filter_by(is_enabled=True).all()]
            if len(enabled_node_ids) < 2:
                # Single-node deployment: "one copy" is the configured topology,
                # not a replication failure. Nothing to alert on.
                return result
            result['multi_node'] = True
            try:
                alert_after = max(0, get_numeric_setting('single_copy_alert_seconds',
                                                         default=self.SINGLE_COPY_ALERT_AFTER_SECONDS))
            except Exception:
                alert_after = self.SINGLE_COPY_ALERT_AFTER_SECONDS
            result['single_copy_alert_after_seconds'] = alert_after
            cutoff = datetime.now(timezone.utc) - timedelta(seconds=int(alert_after))

            file_sub = db.session.query(FileReplica.file_id.label('rid')).filter(
                FileReplica.status == 'synced',
                FileReplica.node_id.in_(enabled_node_ids),
            ).group_by(FileReplica.file_id).having(
                db.func.count(db.distinct(FileReplica.node_id)) < 2
            ).subquery()
            result['single_copy_files'] = db.session.query(db.func.count()).select_from(file_sub).scalar() or 0
            result['aged_single_copy_files'] = File.query.filter(
                File.id.in_(db.session.query(file_sub.c.rid)),
                File.upload_time.isnot(None),
                File.upload_time < cutoff,
            ).count()
            result['zero_copy_files'] = File.query.filter(
                ~File.id.in_(db.session.query(FileReplica.file_id).filter(
                    FileReplica.status == 'synced',
                    FileReplica.node_id.in_(enabled_node_ids),
                ))
            ).count()

            note_sub = db.session.query(NoteReplica.note_id.label('rid')).filter(
                NoteReplica.status == 'synced',
                NoteReplica.node_id.in_(enabled_node_ids),
            ).group_by(NoteReplica.note_id).having(
                db.func.count(db.distinct(NoteReplica.node_id)) < 2
            ).subquery()
            result['single_copy_notes'] = db.session.query(db.func.count()).select_from(note_sub).scalar() or 0
            result['aged_single_copy_notes'] = Note.query.filter(
                Note.id.in_(db.session.query(note_sub.c.rid)),
                Note.updated_at.isnot(None),
                Note.updated_at < cutoff,
            ).count()
            result['zero_copy_notes'] = Note.query.filter(
                ~Note.id.in_(db.session.query(NoteReplica.note_id).filter(
                    NoteReplica.status == 'synced',
                    NoteReplica.node_id.in_(enabled_node_ids),
                ))
            ).count()

            thumb_sub = db.session.query(
                ThumbnailReplica.file_id, ThumbnailReplica.thumb_type
            ).filter(
                ThumbnailReplica.status == 'synced',
                ThumbnailReplica.node_id.in_(enabled_node_ids),
            ).group_by(ThumbnailReplica.file_id, ThumbnailReplica.thumb_type).having(
                db.func.count(db.distinct(ThumbnailReplica.node_id)) < 2
            ).subquery()
            result['single_copy_thumbnails'] = db.session.query(db.func.count()).select_from(thumb_sub).scalar() or 0
        except Exception as e:
            print(f'[STORAGE] Failed to compute single-copy snapshot: {e}')
        return result

    def _single_copy_snapshot(self, force=False):
        """Cached wrapper around _compute_single_copy_snapshot (TTL-bounded so an
        admin status poll cannot re-run the GROUP BY scans on every request)."""
        now = time.monotonic()
        cached = self._single_copy_cache
        if not force and cached and (now - cached['ts']) < self.SINGLE_COPY_SNAPSHOT_TTL_SECONDS:
            return cached['value']
        value = self._compute_single_copy_snapshot()
        self._single_copy_cache = {'ts': now, 'value': value}
        return value

    def _audit_single_copy_payloads(self):
        """Emit prefixed alerts for under-replicated payloads and parked replicas.

        AUDIT FIX (single-copy residency was invisible): the external log monitor
        parses the `[PREFIX]` lines this app prints, so making the condition
        LOGGED is what makes it alertable. Throttled to
        SINGLE_COPY_AUDIT_INTERVAL_SECONDS so the 10s replication cycle does not
        spam. Neither silently retries forever nor silently gives up: a parked
        replica is reported as `[ERROR]` every pass until an operator clears it."""
        now = time.monotonic()
        if (now - self._single_copy_audit_at) < self.SINGLE_COPY_AUDIT_INTERVAL_SECONDS:
            return
        self._single_copy_audit_at = now
        try:
            snap = self._single_copy_snapshot(force=True)
            if not snap.get('multi_node'):
                return
            zero_total = snap.get('zero_copy_files', 0) + snap.get('zero_copy_notes', 0)
            if zero_total:
                print(f'[ERROR] [STORAGE] {snap.get("zero_copy_files", 0)} file(s) and '
                      f'{snap.get("zero_copy_notes", 0)} note(s) have NO synced replica on any enabled '
                      f'storage node — these payloads are untracked on every mirror and may be '
                      f'unrecoverable if the local disk is lost')
            aged = snap.get('aged_single_copy_files', 0) + snap.get('aged_single_copy_notes', 0)
            if aged:
                print(f'[WARNING] [STORAGE] {snap.get("aged_single_copy_files", 0)} file(s) and '
                      f'{snap.get("aged_single_copy_notes", 0)} note(s) have been SINGLE-COPY for longer '
                      f'than {snap.get("single_copy_alert_after_seconds")}s. The backup deliberately '
                      f'excludes payload directories because replication is assumed complete, so each of '
                      f'these currently has exactly one copy on Earth. Check node health and the '
                      f'replication backlog.')
            elif snap.get('single_copy_files') or snap.get('single_copy_notes') or snap.get('single_copy_thumbnails'):
                print(f'[STORAGE] Replication backlog: {snap.get("single_copy_files", 0)} file(s), '
                      f'{snap.get("single_copy_notes", 0)} note(s), '
                      f'{snap.get("single_copy_thumbnails", 0)} thumbnail(s) still have a single synced copy '
                      f'(within the alert grace window)')

            # Permanently-parked replicas: the triage loop skips these forever.
            parked_nodes = {}
            for model, label in ((FileReplica, 'file'), (NoteReplica, 'note'), (ThumbnailReplica, 'thumbnail')):
                for node_id, count in db.session.query(
                    model.node_id, db.func.count()
                ).filter(
                    model.status == 'error',
                    model.error_count >= self.MAX_ERROR_RETRIES,
                ).group_by(model.node_id).all():
                    parked_nodes.setdefault(node_id, {})[label] = count
            for node_id, counts in parked_nodes.items():
                print(f'[ERROR] [REPLICATION] {self._node_name(node_id)} has PERMANENTLY PARKED replicas '
                      f'({counts}) after {self.MAX_ERROR_RETRIES} failed attempts — replication will NOT '
                      f'retry them without admin action (admin storage retry-errors). Until then that data '
                      f'is not mirrored to this node.')
        except Exception as e:
            print(f'[STORAGE] Single-copy audit failed: {e}')

    def _node_name(self, node_id):
        """Helper to get a human-readable node label for log messages."""
        node = db.session.get(StorageNode, node_id)
        return f'{node.name} (id={node_id})' if node else f'node_id={node_id}'

    @staticmethod
    def _sha256_file(path):
        """Compute SHA-256 hex digest of a file in 64MB chunks (memory-safe).
        Delegates to the module-level _sha256_file() helper."""
        return _sha256_file(path)

    def _is_checksum_enabled(self):
        """Check if post-transfer checksum verification is enabled."""
        try:
            val = get_setting_value('replication_verify_checksum') or 'false'
            return val.lower() in ('true', '1', 'yes')
        except Exception:
            return False

    def _get_replication_workers(self):
        """Read the replication_workers count from AppSetting."""
        try:
            val = get_numeric_setting('replication_workers')
            return max(1, min(val, 10))
        except Exception:
            return 3

    # Replication speed presets: (batch_size, delay_between_items)
    # Rate = batch * 3_categories * 6_cycles_per_min / (1 + delay * batch)
    REPLICATION_PRESETS = {
        'steady':     {'batch': 1,   'delay': 0.0,  'approx': 20},    # ~18 items/min
        'smooth':     {'batch': 10,  'delay': 0.2,  'approx': 50},    # ~60 items/min
        'aggressive': {'batch': 20,  'delay': 0.1,  'approx': 100},   # ~120 items/min
        'unlimited':  {'batch': 500, 'delay': 0.01, 'approx': 2500},  # ~2500 items/min
    }

    # Replication source modes: where to pull data from when local disk doesn't have it
    REPLICATION_SOURCE_MODES = {
        'primary':          'Pull only from the primary node',
        'primary_fallback': 'Try primary first, fall back to any synced node',
        'any':              'Pull from any node that has a synced copy',
    }

    def _get_replication_preset(self):
        """Read the current replication speed preset from AppSetting."""
        try:
            speed = get_setting_value('replication_speed') or 'steady'
            if speed not in self.REPLICATION_PRESETS:
                speed = 'steady'
            return speed, self.REPLICATION_PRESETS[speed]
        except Exception:
            return 'steady', self.REPLICATION_PRESETS['steady']

    def _get_replication_source_mode(self):
        """Read the current replication source mode from AppSetting."""
        try:
            mode = get_setting_value('replication_source') or 'primary_fallback'
            if mode not in self.REPLICATION_SOURCE_MODES:
                mode = 'primary_fallback'
            return mode
        except Exception:
            return 'primary_fallback'

    def _find_replication_sources(self, replica_query, source_mode, primary_id, skip_nodes=None):
        """Find an ordered list of source replicas to pull data from based on the configured mode.
        Returns multiple candidates so callers can fall back if the first source fails.

        Args:
            replica_query: A SQLAlchemy query filtered to status='synced' for the target item
                           (e.g. FileReplica.query.filter_by(file_id=X, status='synced'))
            source_mode: 'primary', 'primary_fallback', or 'any'
            primary_id: The current primary node ID (or None)
            skip_nodes: set of node IDs to exclude (e.g. nodes that failed earlier in this cycle)

        Returns:
            List of replica objects with .node_id, ordered by preference. May be empty.
        """
        all_synced = replica_query.all()
        if skip_nodes:
            all_synced = [r for r in all_synced if r.node_id not in skip_nodes]
        if not all_synced:
            return []
        if source_mode == 'primary' and primary_id:
            return [r for r in all_synced if r.node_id == primary_id]
        elif source_mode == 'primary_fallback' and primary_id:
            primary = [r for r in all_synced if r.node_id == primary_id]
            others = [r for r in all_synced if r.node_id != primary_id]
            return primary + others
        else:
            # 'any' mode or no primary configured
            return all_synced

    # Maximum wall-clock time (seconds) for a single replication cycle.
    # If exceeded, the cycle breaks early and logs a warning. This prevents
    # any single cycle from blocking the replication thread indefinitely
    # (e.g. if a remote node is extremely slow but not fully stalled).
    _CYCLE_TIMEOUT = 900  # 15 minutes

    def _fresh_authority_checksum(self, category, item_id):
        """Current DB-authoritative checksum, read in a fresh transaction."""
        db.session.rollback()
        if category == 'files':
            row = db.session.query(File.payload_checksum).filter_by(id=item_id).first()
        elif category == 'notes':
            row = db.session.query(Note.content_checksum).filter_by(id=item_id).first()
        else:
            base, _, ext = item_id.rpartition('.')
            col = File.thumbnail_e2e_checksum if ext == 'e2e' else File.thumbnail_checksum
            row = db.session.query(col).filter_by(id=base).first()
        return row[0] if row else None

    def _acquire_object_rewrite_lock(self, category, item_id):
        if category == 'files':
            return _acquire_file_rewrite_lock(item_id)
        if category == 'notes':
            return _acquire_note_rewrite_lock(item_id)
        base, _, ext = item_id.rpartition('.')
        return _acquire_thumbnail_publication_lock(base, ext)

    def _release_object_rewrite_lock(self, category, lock_file):
        _release_file_rewrite_lock(lock_file)

    def _repair_stale_file_put(self, category, item_id, disk_id, put_checksum, local_backend, target_put):
        """If File.payload_checksum moved after this put, overwrite with current local bytes.

        A timed-out cycle can finish a put after a rewrite already marked remotes
        synced with the new checksum. Repair so the remote cannot keep stale bytes.
        Returns (checksum, still_current, repair_verified); repair_verified is
        None when no repair put happened.
        """
        if category != 'files' or not put_checksum:
            return put_checksum, True, None
        try:
            row = db.session.query(File.payload_checksum).filter_by(id=item_id).first()
        except Exception:
            return put_checksum, True, None
        current = row[0] if row else None
        if not current or current == put_checksum:
            return put_checksum, True, None
        print(f'[REPLICATION] Stale put landed for files/{item_id}; attempting repair')
        if local_backend and local_backend.exists('files', disk_id):
            repair_path = local_backend.get_path('files', disk_id)
            try:
                repair_hash = self._sha256_file(repair_path)
            except Exception:
                repair_hash = None
            if repair_hash == current:
                try:
                    return repair_hash, True, bool(target_put(repair_path, repair_hash))
                except Exception as e:
                    print(f'[REPLICATION] Repair put failed for files/{item_id}: {e}')
        return put_checksum, False, None

    def _replicate_single_item(self, replica_id, category, item_id, target_node_id,
                               source_mode, primary_id, verify_checksum, use_threads=False,
                               expected_version=None, expected_checksum=None):
        """Replicate a single file/note/thumbnail to a target node.
        Designed to be called from a thread pool for parallel replication.
        Returns a dict with 'status' ('ok', 'error', 'missing'), 'node_id', and optional 'checksum'.

        When verify_checksum is True, the source file SHA-256 is computed locally and then
        passed to the target backend's put() for end-to-end verification:
        - SSH targets: remote sha256sum is executed and compared against the local hash
        - S3 targets: ChecksumSHA256 is sent with the upload for server-side verification
        Downloads from remote sources also verify checksums when enabled.
        """
        result = {
            'status': 'error',
            'node_id': target_node_id,
            'checksum': None,
            # AUDIT FIX (size-only replicas excluded from failover): report the
            # trust level of `checksum` SEPARATELY instead of encoding "not
            # verified" as checksum=None. Overloading NULL made the replica
            # invisible to read failover, which is the exact opposite of what an
            # unverified-but-present mirror should be worth.
            'checksum_verified': False,
            'size_bytes': None,
            'error': None,
            'expected_version': expected_version,
            'expected_checksum': expected_checksum,
        }
        try:
            backends, local_backend, _local_node_id, _version = self._backend_state_snapshot()
            target_backend = backends.get(target_node_id)
            if not target_backend:
                print(f'[REPLICATION] No backend for {self._node_name(target_node_id)}, skipping {category}/{item_id}')
                return result

            note_obj = None
            file_obj = None
            if category == 'files':
                file_obj = db.session.get(File, item_id)
                if not file_obj:
                    result['status'] = 'deleted'
                    result['error'] = f'RESOURCE DELETED DURING REPLICATION: {category}/{item_id}'
                    return result
                if expected_checksum is None:
                    expected_checksum = file_obj.payload_checksum
                    result['expected_checksum'] = expected_checksum
            if category == 'notes':
                note_obj = db.session.get(Note, item_id)
                if not note_obj:
                    result['status'] = 'deleted'
                    result['error'] = f'RESOURCE DELETED DURING REPLICATION: {category}/{item_id}'
                    return result
                current_version = int(note_obj.content_version or 1)
                current_checksum = note_obj.content_checksum
                if expected_version is None:
                    expected_version = current_version
                    result['expected_version'] = expected_version
                if expected_checksum is None:
                    expected_checksum = current_checksum
                    result['expected_checksum'] = expected_checksum
                if current_version != int(expected_version or 0):
                    result['status'] = 'stale'
                    result['error'] = f'NOTE VERSION ADVANCED DURING REPLICATION: expected v{expected_version}, now v{current_version}'
                    return result
                if current_checksum and expected_checksum and current_checksum != expected_checksum:
                    result['status'] = 'stale'
                    result['error'] = f'NOTE CHECKSUM ADVANCED DURING REPLICATION: {item_id}'
                    return result
            if category == 'thumbnails' and expected_checksum is None:
                # AUDIT FIX (finding 4): thumbnails replicated from the local
                # source never consulted the DB authority
                # (File.thumbnail_checksum / thumbnail_e2e_checksum), so a
                # corrupt local thumbnail was copied to every node as if it
                # were good. Resolve the authoritative checksum for this
                # variant so the local-source path below can compare it.
                _thumb_base = item_id.rsplit('.', 1)[0] if '.' in item_id else item_id
                _thumb_ext = item_id.rsplit('.', 1)[1] if '.' in item_id else ''
                _trow = db.session.get(File, _thumb_base)
                if _trow is not None:
                    expected_checksum = (
                        _trow.thumbnail_e2e_checksum if _thumb_ext == 'e2e'
                        else _trow.thumbnail_checksum
                    )
                    result['expected_checksum'] = expected_checksum

            # Determine the file identifier for disk operations
            if category == 'files':
                disk_id = f'{item_id}.enc'
            elif category == 'thumbnails':
                # item_id is already like "uuid.jpg" or "uuid.e2e"
                disk_id = item_id
            else:
                disk_id = item_id  # notes use note_id directly

            # Determine temp directory based on category
            if category == 'files':
                tmp_dir = self._app.config['UPLOAD_FOLDER']
            elif category == 'notes':
                tmp_dir = NOTES_DIR
            else:
                tmp_dir = THUMBNAILS_DIR

            source_path = None
            source_checksum = None
            tmp_fd = None
            tmp_path = None
            use_thread_conn = use_threads and isinstance(target_backend, _SSHBackend)
            _always_checksum = category in ('files', 'notes')

            # Helper to call target_backend.put() with appropriate params.
            # Returns True when the backend confirmed the object's checksum
            # end-to-end; False when the write was accepted on size-only.
            def _target_put(src_path, put_hash=None):
                # put_hash: hash of the bytes in src_path when they differ from
                # the cycle's source (the stale-put repair re-uploads newer bytes).
                expected_hash = put_hash if put_hash is not None else source_checksum
                if isinstance(target_backend, _SSHBackend):
                    return bool(target_backend.put(category, disk_id, src_path,
                                       use_thread_conn=use_thread_conn,
                                       verify_checksum=verify_checksum,
                                       local_hash=expected_hash))
                elif isinstance(target_backend, _S3Backend):
                    return bool(target_backend.put(category, disk_id, src_path,
                                       verify_checksum=verify_checksum,
                                       local_hash=expected_hash))
                else:
                    target_backend.put(category, disk_id, src_path)
                    if expected_hash:
                        # AUDIT FIX (findings 1+4): a local-to-local copy used
                        # to be asserted 'verified' unconditionally. When we
                        # know the source hash, prove the copy end-to-end by
                        # re-hashing the destination; only then report True.
                        try:
                            target_hash = target_backend.checksum(category, disk_id)
                        except Exception:
                            return False
                        # False means "could not verify"; a hash we DID read that
                        # differs is a failed copy and must not become 'synced'.
                        if target_hash and target_hash != expected_hash:
                            raise RuntimeError(f'TARGET CHECKSUM MISMATCH AFTER COPY: {category}/{disk_id}')
                        return bool(target_hash)
                    return True  # no known source hash: byte copy, unverified

            # Helper to call source_backend.get() with appropriate params
            def _source_get(src_backend, dest_path):
                if isinstance(src_backend, _SSHBackend):
                    use_src_thread = use_threads and isinstance(src_backend, _SSHBackend)
                    src_backend.get(category, disk_id, dest_path,
                                    use_thread_conn=use_src_thread,
                                    verify_checksum=verify_checksum)
                elif isinstance(src_backend, _S3Backend):
                    src_backend.get(category, disk_id, dest_path,
                                    verify_checksum=verify_checksum)
                else:
                    src_backend.get(category, disk_id, dest_path)

            local_mismatch = False
            # Try local source first
            if local_backend and local_backend.exists(category, disk_id):
                source_path = local_backend.get_path(category, disk_id)
                try:
                    # AUDIT FIX (finding 4): hash the local source whenever a
                    # DB-authoritative checksum exists (thumbnails previously
                    # only hashed under verify_checksum/always-checksum and
                    # then propagated blind).
                    if verify_checksum or _always_checksum or expected_checksum:
                        source_checksum = self._sha256_file(source_path)
                    local_mismatch = bool(expected_checksum and source_checksum != expected_checksum)
                    if local_mismatch and self._fresh_authority_checksum(category, item_id) != expected_checksum:
                        result['status'] = 'stale'
                        result['error'] = f'LOCAL {category.upper()} CHECKSUM ADVANCED DURING REPLICATION: {item_id}'
                        return result
                    if local_mismatch:
                        # Authority unchanged: the local bytes are corrupt, not newer.
                        print(f'[REPLICATION] Local {category}/{item_id} does not match its recorded checksum; '
                              f'trying remote sources')
                        source_path = None
                        source_checksum = None
                    else:
                        _verified = _target_put(source_path)
                        result['size_bytes'] = local_backend.size(category, disk_id)
                        # AUDIT FIX (size-only replicas excluded from failover):
                        # ALWAYS record the checksum of the bytes we sent, and record
                        # separately whether the target confirmed them end-to-end.
                        # Previously an unconfirmed write stored checksum=NULL, and
                        # _current_file_read_replicas() filtered those rows out — so
                        # a healthy remote mirror could not rescue a lost/corrupt
                        # local copy. Destructive paths gate on checksum_verified
                        # instead, and the read path re-hashes before serving.
                        source_checksum, still_current, _repair_verified = self._repair_stale_file_put(
                            category, item_id, disk_id, source_checksum, local_backend, _target_put
                        )
                        if not still_current:
                            result['status'] = 'stale'
                            result['error'] = f'STALE PUT AFTER REWRITE: {item_id}'
                            result['checksum'] = source_checksum
                            return result
                        result['checksum'] = source_checksum
                        result['checksum_verified'] = bool((_verified if _repair_verified is None else _repair_verified) and source_checksum)
                        result['status'] = 'ok'
                        return result
                except OSError as e:
                    import errno as _errno
                    if e.errno == _errno.ENOENT:
                        if not self._resource_exists_for_replication(category, item_id):
                            result['status'] = 'deleted'
                            result['error'] = f'RESOURCE DELETED DURING REPLICATION: {category}/{item_id}'
                            return result
                        print(f'[REPLICATION] Local source missing for {category}/{item_id}; falling back to remote synced replica')
                        source_path = None
                    else:
                        raise

            # Fall back to remote sources
            # Note: _find_replication_sources queries the DB — safe from threads with Flask-SQLAlchemy scoped sessions
            if not self._resource_exists_for_replication(category, item_id):
                result['status'] = 'deleted'
                result['error'] = f'RESOURCE DELETED DURING REPLICATION: {category}/{item_id}'
                return result
            if category == 'files':
                sources_query = FileReplica.query.filter_by(file_id=item_id, status='synced')
                if expected_checksum:
                    sources_query = sources_query.filter_by(checksum=expected_checksum)
            elif category == 'notes':
                sources_query = NoteReplica.query.filter_by(
                    note_id=item_id,
                    status='synced',
                    synced_version=expected_version,
                )
                if expected_checksum:
                    sources_query = sources_query.filter_by(checksum=expected_checksum)
            else:
                # For thumbnails, item_id is "uuid.ext", split to get file_id and thumb_type
                _thumb_file_id = item_id.rsplit('.', 1)[0]
                _thumb_type = 'e2e' if item_id.endswith('.e2e') else 'jpg'
                sources_query = ThumbnailReplica.query.filter_by(
                    file_id=_thumb_file_id, thumb_type=_thumb_type, status='synced'
                )
            sources = self._find_replication_sources(sources_query, source_mode, primary_id, skip_nodes={target_node_id})
            if not sources and local_mismatch:
                # Nothing better than the mismatching local copy: requeue as
                # before rather than reporting the object missing.
                result['status'] = 'stale'
                result['error'] = f'LOCAL {category.upper()} CHECKSUM MISMATCH AND NO OTHER SOURCE: {item_id}'
                return result
            if not sources:
                result['status'] = 'missing'
                result['error'] = f'NO SYNCED SOURCE AVAILABLE FOR {category}/{item_id}'
                return result

            for source_replica in sources:
                source_backend = backends.get(source_replica.node_id)
                if not source_backend:
                    continue
                # Use mkstemp for secure temp file creation
                try:
                    tmp_fd, tmp_path = tempfile.mkstemp(prefix=f'repl_{category[:4]}_', dir=tmp_dir)
                    os.close(tmp_fd)
                    tmp_fd = None
                except Exception:
                    continue
                _source_read_ok = False
                try:
                    if isinstance(source_backend, _LocalBackend):
                        source_path = source_backend.get_path(category, disk_id)
                        if verify_checksum or _always_checksum or expected_checksum:
                            source_checksum = self._sha256_file(source_path)
                        if expected_checksum and source_checksum != expected_checksum:
                            source_replica.status = 'error'
                            source_replica.last_error = f'STALE {category.upper()} CHECKSUM ON SOURCE {source_replica.node_id}'[:500]
                            db.session.commit()
                            continue
                        _source_read_ok = os.path.isfile(source_path)
                        _verified = _target_put(source_path)
                    else:
                        # Download from remote source (with hash verification on the download)
                        _source_get(source_backend, tmp_path)
                        if verify_checksum or _always_checksum or expected_checksum:
                            source_checksum = self._sha256_file(tmp_path)
                        if expected_checksum and source_checksum != expected_checksum:
                            source_replica.status = 'error'
                            source_replica.last_error = f'STALE {category.upper()} CHECKSUM ON SOURCE {source_replica.node_id}'[:500]
                            db.session.commit()
                            continue
                        _source_read_ok = True
                        # Upload to target (with hash verification on the upload)
                        if target_node_id == _local_node_id:
                            # Never let a repair overwrite a concurrent local rewrite.
                            _rw_lock = self._acquire_object_rewrite_lock(category, item_id)
                            try:
                                if expected_checksum and self._fresh_authority_checksum(category, item_id) != expected_checksum:
                                    result['status'] = 'stale'
                                    result['error'] = f'{category.upper()} CHECKSUM ADVANCED DURING REPLICATION: {item_id}'
                                    return result
                                _verified = _target_put(tmp_path)
                            finally:
                                self._release_object_rewrite_lock(category, _rw_lock)
                        else:
                            _verified = _target_put(tmp_path)
                    # AUDIT FIX (size-only replicas excluded from failover):
                    # record the checksum of the bytes sent plus the separate
                    # confirmation flag (see the local-source branch above).
                    source_checksum, still_current, _repair_verified = self._repair_stale_file_put(
                        category, item_id, disk_id, source_checksum, local_backend, _target_put
                    )
                    if not still_current:
                        result['status'] = 'stale'
                        result['error'] = f'STALE PUT AFTER REWRITE: {item_id}'
                        result['checksum'] = source_checksum
                        return result
                    result['checksum'] = source_checksum
                    result['checksum_verified'] = bool((_verified if _repair_verified is None else _repair_verified) and source_checksum)
                    result['size_bytes'] = os.path.getsize(source_path) if source_path and os.path.isfile(source_path) else (os.path.getsize(tmp_path) if tmp_path and os.path.isfile(tmp_path) else None)
                    result['status'] = 'ok'
                    return result
                except Exception as src_err:
                    import errno as _errno
                    if isinstance(src_err, OSError) and src_err.errno == _errno.ENOENT:
                        if not self._resource_exists_for_replication(category, item_id):
                            result['status'] = 'deleted'
                            result['error'] = f'RESOURCE DELETED DURING REPLICATION: {category}/{item_id}'
                            return result
                    result['error'] = str(src_err)
                    print(f'[REPLICATION] Source {self._node_name(source_replica.node_id)} failed for {category}/{item_id}: {src_err}')
                    # If the file provably doesn't exist on the source node,
                    # mark that source replica as error so it's no longer
                    # treated as a valid synced source (prevents infinite retry loops).
                    # Covers SFTP (OSError errno=ENOENT) and S3 (ClientError 404/NoSuchKey).
                    # Important: only treat ENOENT as "not found on remote" if the
                    # error references a remote path — local temp-file ENOENT
                    # (e.g. os.replace race) must not mark the remote replica stale.
                    _is_not_found = False
                    import errno as _errno
                    if isinstance(src_err, OSError) and src_err.errno == _errno.ENOENT:
                        _err_path = str(src_err.filename) if src_err.filename else str(src_err)
                        if not _err_path.startswith(tmp_dir):
                            _is_not_found = True
                    else:
                        try:
                            from botocore.exceptions import ClientError as _CE
                            if isinstance(src_err, _CE) and src_err.response['Error']['Code'] in ('404', 'NoSuchKey'):
                                _is_not_found = True
                        except (ImportError, KeyError, AttributeError):
                            pass
                    # A not-found raised by the TARGET write must not condemn the
                    # source replica the bytes were just read from.
                    if _is_not_found and not _source_read_ok:
                        try:
                            source_replica.status = 'error'
                            db.session.commit()
                            print(f'[REPLICATION] Marked stale synced replica on {self._node_name(source_replica.node_id)} as error for {category}/{item_id} (not found on remote)')
                        except Exception:
                            db.session.rollback()
                finally:
                    if tmp_path:
                        try:
                            os.remove(tmp_path)
                        except OSError:
                            pass
                    tmp_path = None

            # All sources failed
            result['status'] = 'error'
            return result
        except Exception as e:
            result['error'] = str(e)
            print(f'[REPLICATION] Error replicating {category}/{item_id} -> {self._node_name(target_node_id)}: {e}')
            return result

    def run_replication_cycle(self):
        """Run one replication cycle.

        Internally:
          - Phase A (setup) runs under self._state_lock — orphan cleanup,
            self-heal, error triage, work-item gathering, mark items as
            'syncing'. These are bulk DB writes that must be serialized
            against other StorageManager operations.
          - Phase B (per-item replication / network I/O) runs WITHOUT the
            lock. Items are already marked 'syncing' so concurrent code
            won't reprocess them. This unblocks process_pending_remote_deletes,
            health_check_all, add_node, admin actions, and the deferred delete
            queue during long-running transfers. See AUDIT Tier 0 #3.
          - Phase C (finalize: node online-promotion) reacquires the lock.
        """
        return self._run_replication_cycle_locked()
