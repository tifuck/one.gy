class _StorageManagerReplicationCycle:

    def _run_replication_cycle_locked(self):
        """Run one replication cycle — copy pending files/notes/thumbnails.
        Uses a thread pool for parallel replication to multiple nodes simultaneously.

        The state lock is acquired here for Phase A (setup) and Phase C
        (finalize), and *released* around Phase B (per-item network I/O) so
        long-running transfers don't block deferred deletes, health checks,
        or admin actions. See run_replication_cycle docstring."""
        import time as _time
        from concurrent.futures import ThreadPoolExecutor, as_completed
        _cycle_start = _time.monotonic()
        self._state_lock.acquire()
        _lock_held = True
        try:
            enabled_nodes = StorageNode.query.filter_by(is_enabled=True).all()
            if len(enabled_nodes) <= 1:
                return

            # Detect backend staleness (another worker may have added/removed nodes)
            db_node_ids = {n.id for n in enabled_nodes}
            cycle_backends, cycle_local_backend, cycle_local_node_id, _cycle_version = self._backend_state_snapshot()
            mem_node_ids = set(cycle_backends.keys())
            if db_node_ids != mem_node_ids:
                print(f'[REPLICATION] Backend state stale (DB: {sorted(db_node_ids)}, mem: {sorted(mem_node_ids)}), refreshing...')
                self.refresh_backends()
                # Re-query after refresh
                enabled_nodes = StorageNode.query.filter_by(is_enabled=True).all()
                if len(enabled_nodes) <= 1:
                    return
                cycle_backends, cycle_local_backend, cycle_local_node_id, _cycle_version = self._backend_state_snapshot()

            # Read pacing config from admin setting
            _preset_name, _preset = self._get_replication_preset()
            _batch_size = _preset['batch']
            _item_delay = _preset['delay']

            # Read replication source mode and primary node
            _source_mode = self._get_replication_source_mode()
            _primary_id = self._get_primary_node_id()

            # Read parallel workers config and checksum setting
            _num_workers = self._get_replication_workers()
            _verify_checksum = self._is_checksum_enabled()
            _use_threads = _num_workers > 1

            # Reset interrupted 'syncing' replicas back to 'pending' (e.g. after a restart)
            _stale_syncing = FileReplica.query.filter_by(status='syncing').count()
            _stale_syncing += NoteReplica.query.filter_by(status='syncing').count()
            _stale_syncing += ThumbnailReplica.query.filter_by(status='syncing').count()
            if _stale_syncing > 0:
                FileReplica.query.filter_by(status='syncing').update({'status': 'pending'})
                NoteReplica.query.filter_by(status='syncing').update({'status': 'pending'})
                ThumbnailReplica.query.filter_by(status='syncing').update({'status': 'pending'})
                db.session.commit()
                print(f'[REPLICATION] Reset {_stale_syncing} interrupted syncing replica(s) to pending')

            # Clean up orphan replicas (file/note/thumbnail deleted but replica rows remain)
            orphan_file_replicas = FileReplica.query.filter(
                ~FileReplica.file_id.in_(db.session.query(File.id))
            ).all()
            if orphan_file_replicas:
                for r in orphan_file_replicas:
                    db.session.delete(r)
                print(f'[REPLICATION] Cleaned {len(orphan_file_replicas)} orphan file replicas')
            orphan_note_replicas = NoteReplica.query.filter(
                ~NoteReplica.note_id.in_(db.session.query(Note.id))
            ).all()
            if orphan_note_replicas:
                for r in orphan_note_replicas:
                    db.session.delete(r)
                print(f'[REPLICATION] Cleaned {len(orphan_note_replicas)} orphan note replicas')
            orphan_thumb_replicas = ThumbnailReplica.query.filter(
                ~ThumbnailReplica.file_id.in_(db.session.query(File.id))
            ).all()
            if orphan_thumb_replicas:
                for r in orphan_thumb_replicas:
                    db.session.delete(r)
                print(f'[REPLICATION] Cleaned {len(orphan_thumb_replicas)} orphan thumbnail replicas')
            # Also clean up thumbnail replicas for files that no longer have thumbnails
            # AUDIT FIX (stale thumb_type row could destroy an un-regenerable E2E
            # thumbnail): this sweep used to delete EVERY ThumbnailReplica row of
            # a file whose has_thumbnail flag was False. Combined with the triage
            # below (which cleared that flag from a stale row of the OTHER
            # thumb_type), a Fernet->E2E conversion produced this chain: the
            # leftover '.jpg' rows point at an object that no longer exists ->
            # the scrub marks them 'error' -> triage sees has_source=False and
            # clears has_thumbnail -> this sweep deletes the HEALTHY '.e2e' rows
            # too. E2E thumbnails cannot be regenerated server-side, so that was
            # permanent, unrecoverable loss.
            # We now never delete tracking for a replica we still believe holds a
            # payload: only non-'synced' rows are reaped here. A 'synced' row on a
            # file claiming no thumbnail is a contradiction that the scrub must
            # resolve first (it will mark the row 'error' if the object is really
            # gone, after which this sweep reaps it).
            _no_thumb_ids = [row[0] for row in db.session.query(File.id).filter_by(has_thumbnail=False).all()]
            if _no_thumb_ids:
                _stale_thumb_replicas = ThumbnailReplica.query.filter(
                    ThumbnailReplica.file_id.in_(_no_thumb_ids),
                    ThumbnailReplica.status != 'synced',
                ).all()
                if _stale_thumb_replicas:
                    for r in _stale_thumb_replicas:
                        db.session.delete(r)
                    print(f'[REPLICATION] Cleaned {len(_stale_thumb_replicas)} stale thumbnail replicas (file has_thumbnail=False)')
                _contradictory_thumb_replicas = ThumbnailReplica.query.filter(
                    ThumbnailReplica.file_id.in_(_no_thumb_ids),
                    ThumbnailReplica.status == 'synced',
                ).count()
                if _contradictory_thumb_replicas:
                    print(f'[REPLICATION] [WARNING] {_contradictory_thumb_replicas} SYNCED thumbnail replica row(s) '
                          f'belong to file(s) with has_thumbnail=False — keeping the tracking rows so a live '
                          f'payload can never be orphaned; the integrity scrub will resolve them')

            # Clean up replicas pointing to deleted/non-existent storage nodes
            _valid_node_ids = db.session.query(StorageNode.id)
            _orphan_node_file = FileReplica.query.filter(~FileReplica.node_id.in_(_valid_node_ids)).all()
            _orphan_node_note = NoteReplica.query.filter(~NoteReplica.node_id.in_(_valid_node_ids)).all()
            _orphan_node_thumb = ThumbnailReplica.query.filter(~ThumbnailReplica.node_id.in_(_valid_node_ids)).all()
            _orphan_node_total = len(_orphan_node_file) + len(_orphan_node_note) + len(_orphan_node_thumb)
            if _orphan_node_total:
                for r in _orphan_node_file:
                    db.session.delete(r)
                for r in _orphan_node_note:
                    db.session.delete(r)
                for r in _orphan_node_thumb:
                    db.session.delete(r)
                print(f'[REPLICATION] Cleaned {_orphan_node_total} replica(s) referencing non-existent storage nodes '
                      f'(file={len(_orphan_node_file)}, note={len(_orphan_node_note)}, thumb={len(_orphan_node_thumb)})')

            # Persist orphan replica cleanup before proceeding to self-healing
            if orphan_file_replicas or orphan_note_replicas or orphan_thumb_replicas or _orphan_node_total:
                db.session.commit()

            # Self-heal: create missing replica rows for any enabled node, even
            # when the file already has at least one replica row.
            #
            # KNOWN BENIGN RACE (M2): stage_payload_deletes() (the HTTP delete
            # path) does NOT hold _state_lock and runs in its own transaction. If
            # a delete is staged-but-not-yet-committed while this self-heal runs,
            # the tombstone below is not yet visible AND the File row still
            # exists, so this loop can re-create a replica row for a file that is
            # about to be deleted. That transient orphan row is harmless: the
            # caller's commit removes the File row, and the orphan-replica cleanup
            # at the top of the very next cycle (~FileReplica.file_id.in_(File.id))
            # reaps it. We accept this eventual-consistency window deliberately
            # rather than taking _state_lock on every delete (which would
            # serialize all deletes behind long replication cycles).
            all_file_ids = set(r[0] for r in File.query.with_entities(File.id).all())
            _pending_delete_file_ids = {
                r[0].replace('.enc', '') if r[0].endswith('.enc') else r[0]
                for r in db.session.query(PendingRemoteDelete.file_id)
                    .filter(PendingRemoteDelete.category == 'files').all()
            }
            if _pending_delete_file_ids:
                _skip = all_file_ids & _pending_delete_file_ids
                if _skip:
                    print(f'[REPLICATION] Skipping replica-row reconciliation for {len(_skip)} file(s) '
                          f'with pending remote deletes (tombstone guard)')
                    all_file_ids = all_file_ids - _skip
            if all_file_ids:
                _existing_file_pairs = {
                    (fid, nid) for fid, nid in db.session.query(
                        FileReplica.file_id, FileReplica.node_id
                    ).filter(
                        FileReplica.file_id.in_(all_file_ids),
                        FileReplica.node_id.in_([node.id for node in enabled_nodes])
                    ).all()
                }
                # AUDIT FIX H1: previously this performed a full backend
                # list_files('files') for EVERY enabled remote node on every
                # 10s replication cycle (S3 paginated list_objects_v2 / SSH
                # listdir) purely to compute `exists_on_node` — but BOTH the
                # exists and not-exists branches added an identical
                # status='pending' row, so the listing had zero effect on
                # behavior. The missing row is always created as 'pending' and
                # the replication/scrub loop then verifies size + checksum
                # before promoting it to 'synced'. Dropping the dead listing
                # removes constant, pointless remote API cost on every cycle.
                healed = 0
                healed_rows = 0
                for fid in all_file_ids:
                    repaired_any = False
                    for node in enabled_nodes:
                        if (fid, node.id) in _existing_file_pairs:
                            continue
                        db.session.add(FileReplica(file_id=fid, node_id=node.id, status='pending'))
                        repaired_any = True
                        healed_rows += 1
                    if repaired_any:
                        healed += 1
                if healed_rows:
                    db.session.commit()
                    print(f'[REPLICATION] Reconciled {healed_rows} missing file replica row(s) across {healed} file(s)')

            all_note_ids = set(r[0] for r in Note.query.with_entities(Note.id).all())
            _pending_note_delete_ids = {
                r[0] for r in db.session.query(PendingRemoteDelete.file_id)
                    .filter(PendingRemoteDelete.category == 'notes').all()
            }
            if _pending_note_delete_ids:
                _skip_n = all_note_ids & _pending_note_delete_ids
                if _skip_n:
                    print(f'[REPLICATION] Skipping replica-row reconciliation for {len(_skip_n)} note(s) '
                          f'with pending remote deletes (tombstone guard)')
                    all_note_ids = all_note_ids - _skip_n
            if all_note_ids:
                _existing_note_pairs = {
                    (nid, nodeid) for nid, nodeid in db.session.query(
                        NoteReplica.note_id, NoteReplica.node_id
                    ).filter(
                        NoteReplica.note_id.in_(all_note_ids),
                        NoteReplica.node_id.in_([node.id for node in enabled_nodes])
                    ).all()
                }
                # AUDIT FIX H1: dropped the per-cycle full backend
                # list_files('notes') for every node — like the file path, both
                # branches created an identical status='pending' row, so the
                # listing was dead weight. Missing rows are created 'pending'
                # and verified by the replication/scrub loop before promotion.
                _note_versions_map = {
                    nid: int(ver or 1)
                    for nid, ver in db.session.query(Note.id, Note.content_version).filter(
                        Note.id.in_(all_note_ids)
                    ).all()
                }
                healed_n = 0
                healed_note_rows = 0
                for nid in all_note_ids:
                    if all((nid, node.id) in _existing_note_pairs for node in enabled_nodes):
                        # Fully tracked: version/checksum drift is handled by the
                        # stale pass below and failures by error triage. Reconciling
                        # here reset every errored replica to pending each cycle.
                        continue
                    repaired_any = False
                    repaired = self.reconcile_note_to_local(nid, verified_at=datetime.now(timezone.utc))
                    if repaired:
                        healed_n += 1
                        continue
                    note_version = _note_versions_map.get(nid, 1)
                    for node in enabled_nodes:
                        if (nid, node.id) in _existing_note_pairs:
                            continue
                        db.session.add(NoteReplica(
                            note_id=nid,
                            node_id=node.id,
                            status='pending',
                            target_version=note_version,
                        ))
                        repaired_any = True
                        healed_note_rows += 1
                    if repaired_any:
                        healed_n += 1
                if healed_note_rows:
                    db.session.commit()
                    print(f'[REPLICATION] Reconciled {healed_note_rows} missing note replica row(s) across {healed_n} note(s)')

            stale_note_ids = [
                nid for (nid,) in db.session.query(Note.id).join(
                    NoteReplica, NoteReplica.note_id == Note.id
                ).filter(
                    db.or_(
                        NoteReplica.target_version.is_(None),
                        NoteReplica.target_version != Note.content_version,
                        db.and_(
                            NoteReplica.status == 'synced',
                            db.or_(
                                NoteReplica.synced_version.is_(None),
                                NoteReplica.synced_version != Note.content_version,
                                db.and_(
                                    Note.content_checksum.isnot(None),
                                    NoteReplica.checksum.isnot(None),
                                    NoteReplica.checksum != Note.content_checksum,
                                ),
                            ),
                        ),
                    )
                ).distinct().limit(max(_batch_size * 10, 50)).all()
            ]
            if stale_note_ids:
                repaired_stale_notes = 0
                for nid in stale_note_ids:
                    repaired = self.reconcile_note_to_local(nid, verified_at=datetime.now(timezone.utc))
                    if repaired:
                        repaired_stale_notes += 1
                if repaired_stale_notes > 0:
                    db.session.commit()
                    print(f'[REPLICATION] Re-queued {repaired_stale_notes} stale note replication state entrie(s)')

            # Self-heal: create missing thumbnail replica rows for any enabled
            # node, not just files with zero thumbnail replica rows.
            thumb_file_rows = db.session.query(File.id, File.is_e2e_encrypted).filter_by(has_thumbnail=True).all()
            _pending_delete_thumb_fids = {
                (r[0].rsplit('.', 1)[0] if '.' in r[0] else r[0])
                for r in db.session.query(PendingRemoteDelete.file_id)
                    .filter(PendingRemoteDelete.category == 'thumbnails').all()
            }
            if _pending_delete_thumb_fids:
                _skip_t = {fid for fid, _ in thumb_file_rows if fid in _pending_delete_thumb_fids}
                if _skip_t:
                    print(f'[REPLICATION] Skipping thumbnail replica-row reconciliation for {len(_skip_t)} item(s) '
                          f'with pending remote deletes (tombstone guard)')
                    thumb_file_rows = [(fid, is_e2e) for fid, is_e2e in thumb_file_rows if fid not in _skip_t]
            if thumb_file_rows:
                _thumb_fids = {fid for fid, _ in thumb_file_rows}
                _existing_thumb_triples = {
                    (fid, ttype, nid)
                    for fid, ttype, nid in db.session.query(
                        ThumbnailReplica.file_id,
                        ThumbnailReplica.thumb_type,
                        ThumbnailReplica.node_id,
                    ).filter(
                        ThumbnailReplica.file_id.in_(_thumb_fids),
                        ThumbnailReplica.node_id.in_([node.id for node in enabled_nodes])
                    ).all()
                }
                # AUDIT FIX H1: dropped the per-cycle full backend
                # list_files('thumbnails') for every node — identical-branch
                # dead code like the file/note paths above. Missing rows are
                # created 'pending' and verified before promotion to 'synced'.
                healed_t = 0
                healed_thumb_rows = 0
                for fid, is_e2e in thumb_file_rows:
                    thumb_type = 'e2e' if is_e2e else 'jpg'
                    repaired_any = False
                    for node in enabled_nodes:
                        if (fid, thumb_type, node.id) in _existing_thumb_triples:
                            continue
                        db.session.add(ThumbnailReplica(file_id=fid, thumb_type=thumb_type, node_id=node.id, status='pending'))
                        repaired_any = True
                        healed_thumb_rows += 1
                    if repaired_any:
                        healed_t += 1
                if healed_thumb_rows:
                    db.session.commit()
                    print(f'[REPLICATION] Reconciled {healed_thumb_rows} missing thumbnail replica row(s) across {healed_t} file(s)')

            # Bulk-mark replicas as 'missing' where source data doesn't exist on any node.
            # Use 5-minute cooldown and max retry count to prevent infinite retry loops.
            # AUDIT Tier 1: previously this issued 2-3 follow-up SELECTs per error
            # replica (filter_by(file_id, status='synced').first() etc.). With 1000
            # error replicas that was ~3000 round-trips every 10 seconds. We now
            # bulk-prefetch the (file_id|note_id) of any sibling row with
            # status='synced' into a Python set once per category, then look up
            # in O(1).
            _error_cooldown = timedelta(minutes=5)
            _MAX_ERROR_RETRIES = self.MAX_ERROR_RETRIES
            # AUDIT FIX (naive/aware datetime mix could stall ALL replication):
            # this used to be `datetime.now(timezone.utc).replace(tzinfo=None)`.
            # The intent was to match the NAIVE datetimes MariaDB/SQLite hand back
            # on read, but earlier statements in this same phase assign AWARE
            # values to LIVE ORM objects — reconcile_note_to_local(...,
            # verified_at=datetime.now(timezone.utc)) and
            # _mark_replica_verification_error(). Every db.session.commit() that
            # would expire those objects back to naive DB values is CONDITIONAL,
            # so when none of them fired, `_now - r.verified_at` evaluated
            # naive-minus-aware and raised TypeError. That propagated to the
            # cycle-wide handler, which only printed 'Cycle failed' and rolled
            # back — replication then did NOTHING every 10s until the state
            # happened to clear. Per AGENTS.md we now use AWARE UTC everywhere and
            # normalise whatever the DB returns via _utc_aware() at each
            # comparison, so the two can never be mixed again.
            _now = datetime.now(timezone.utc)
            missing_marked = 0
            exhausted_count = 0
            note_self_healed = 0
            _healed_note_ids = set()

            # ── File replica error triage ─────────────────────────────────
            error_file_replicas = FileReplica.query.filter_by(status='error').all()
            if error_file_replicas:
                _error_file_ids = {r.file_id for r in error_file_replicas}
                # Bulk-prefetch: which of these file_ids have ANY status='synced'
                # sibling row anywhere? Single SELECT replaces N first()s.
                _synced_file_ids = {
                    fid for (fid,) in db.session.query(FileReplica.file_id).filter(
                        FileReplica.file_id.in_(_error_file_ids),
                        FileReplica.status == 'synced',
                    ).distinct().all()
                }
                # Bulk local-backend presence check: list the local files dir once
                # into a set, then check membership in O(1) instead of one
                # os.path.exists per replica.
                _local_files_set = set()
                if cycle_local_backend:
                    try:
                        _local_files_set = set(cycle_local_backend.list_files('files') or [])
                    except Exception:
                        _local_files_set = set()
                for r in error_file_replicas:
                    filename = f'{r.file_id}.enc'
                    has_source = (filename in _local_files_set) or (r.file_id in _synced_file_ids)
                    if has_source:
                        if (r.error_count or 0) >= _MAX_ERROR_RETRIES:
                            exhausted_count += 1
                            continue  # Leave as 'error' — admin must investigate
                        if r.verified_at and (_now - _utc_aware(r.verified_at)) < _error_cooldown:
                            continue
                        r.status = 'pending'
                        r.verified_at = _now
                        # AUDIT FIX F3: do not increment here — rescheduling a
                        # retry is not a failed attempt. The increment happens
                        # once in _update_replica_status if the transfer fails.
                        # Cooldown spacing is enforced via verified_at above.
                    else:
                        r.status = 'missing'
                        r.verified_at = _now
                        missing_marked += 1

            # ── Note replica error triage ────────────────────────────────
            error_note_replicas = NoteReplica.query.filter_by(status='error').all()
            if error_note_replicas:
                _error_note_ids = {r.note_id for r in error_note_replicas}
                # Bulk-prefetch note versions, synced sibling versions, and local
                # presence in one pass each. Replaces per-replica first() calls.
                _note_versions = {
                    nid: int(ver or 1)
                    for nid, ver in db.session.query(Note.id, Note.content_version).filter(
                        Note.id.in_(_error_note_ids)
                    ).all()
                }
                _synced_note_versions = {}  # note_id -> set of synced_version values
                for nid, sv in db.session.query(NoteReplica.note_id, NoteReplica.synced_version).filter(
                    NoteReplica.note_id.in_(_error_note_ids),
                    NoteReplica.status == 'synced',
                ).all():
                    _synced_note_versions.setdefault(nid, set()).add(sv)
                _local_notes_set = set()
                if cycle_local_backend:
                    try:
                        _local_notes_set = set(cycle_local_backend.list_files('notes') or [])
                    except Exception:
                        _local_notes_set = set()
                for r in error_note_replicas:
                    if r.note_id in _healed_note_ids:
                        continue
                    # AUDIT FIX (note self-heal backoff): gate the expensive
                    # reconcile_note_to_local (full local re-hash + DB writes +
                    # remote fetch) behind the cooldown check, mirroring the
                    # file/thumbnail triage. Previously reconcile ran for every
                    # errored note replica on every 10s cycle before the
                    # cooldown was consulted, driving a re-hash storm on
                    # persistently-unhealable notes. The exhausted check still
                    # skips replicas at the retry cap.
                    if (r.error_count or 0) >= _MAX_ERROR_RETRIES:
                        exhausted_count += 1
                        continue
                    if r.verified_at and (_now - _utc_aware(r.verified_at)) < _error_cooldown:
                        continue
                    repaired = self.reconcile_note_to_local(r.note_id, verified_at=_now)
                    if repaired:
                        _healed_note_ids.add(r.note_id)
                        note_self_healed += 1
                        print(
                            f'[REPLICATION] Self-healed note {r.note_id} from local '
                            f'({repaired["local_size"]} bytes, reset {repaired["remote_reset"]} remote replicas)'
                        )
                        continue
                    has_source = r.note_id in _local_notes_set
                    if not has_source:
                        note_version = _note_versions.get(r.note_id, 1)
                        has_source = note_version in _synced_note_versions.get(r.note_id, set())
                    if has_source:
                        r.status = 'pending'
                        r.verified_at = _now
                        # AUDIT FIX F3: no increment on reschedule (see file triage).
                    else:
                        r.status = 'missing'
                        r.verified_at = _now

            # ── Thumbnail replica error triage ────────────────────────────
            thumb_missing_marked = 0
            thumb_flag_cleared = 0
            error_thumb_replicas = ThumbnailReplica.query.filter_by(status='error').all()
            if error_thumb_replicas:
                # Bulk-prefetch: which (file_id, thumb_type) pairs have a
                # status='synced' sibling? Use a set of tuples.
                _error_thumb_ids = {r.file_id for r in error_thumb_replicas}
                _synced_thumb_pairs = {
                    (fid, ttype)
                    for fid, ttype in db.session.query(
                        ThumbnailReplica.file_id, ThumbnailReplica.thumb_type
                    ).filter(
                        ThumbnailReplica.file_id.in_(_error_thumb_ids),
                        ThumbnailReplica.status == 'synced',
                    ).distinct().all()
                }
                _local_thumbs_set = set()
                if cycle_local_backend:
                    try:
                        _local_thumbs_set = set(cycle_local_backend.list_files('thumbnails') or [])
                    except Exception:
                        _local_thumbs_set = set()
                # Bulk-load File rows we may need to clear has_thumbnail on
                _thumb_files = {
                    f.id: f for f in File.query.filter(File.id.in_(_error_thumb_ids)).all()
                }
                for r in error_thumb_replicas:
                    thumb_disk_id = f'{r.file_id}.{"e2e" if r.thumb_type == "e2e" else "jpg"}'
                    has_source = (
                        thumb_disk_id in _local_thumbs_set
                        or (r.file_id, r.thumb_type) in _synced_thumb_pairs
                    )
                    if has_source:
                        if (r.error_count or 0) >= _MAX_ERROR_RETRIES:
                            continue
                        if r.verified_at and (_now - _utc_aware(r.verified_at)) < _error_cooldown:
                            continue
                        r.status = 'pending'
                        r.verified_at = _now
                        # AUDIT FIX F3: no increment on reschedule (see file triage).
                    else:
                        r.status = 'missing'
                        r.verified_at = _now
                        thumb_missing_marked += 1
                        _thumb_file = _thumb_files.get(r.file_id)
                        # AUDIT FIX (stale thumb_type row could destroy an
                        # un-regenerable E2E thumbnail): only the thumb_type that
                        # matches the file's CURRENT encryption mode describes its
                        # live thumbnail. After a Fernet->E2E conversion the
                        # leftover '.jpg' rows are stale by construction and their
                        # (correct) "no source" verdict must NOT be allowed to
                        # clear has_thumbnail — doing so declared the healthy
                        # '.e2e' thumbnail nonexistent and got its replica rows
                        # swept, permanently losing a thumbnail the server cannot
                        # regenerate. A stale-type row now only marks ITSELF
                        # missing and is reported for cleanup.
                        _current_ttype = 'e2e' if (_thumb_file and _thumb_file.is_e2e_encrypted) else 'jpg'
                        if _thumb_file and r.thumb_type != _current_ttype:
                            print(f'[REPLICATION] [WARNING] Stale {r.thumb_type} thumbnail replica for file '
                                  f'{r.file_id} (current thumbnail type is {_current_ttype}) has no source; '
                                  f'marking only this row missing and leaving has_thumbnail untouched')
                        elif _thumb_file and _thumb_file.has_thumbnail:
                            _thumb_file.has_thumbnail = False
                            thumb_flag_cleared += 1
            db.session.commit()
            if missing_marked > 0:
                print(f'[REPLICATION] Marked {missing_marked} file replicas as missing (source data gone)')
            if thumb_missing_marked > 0:
                print(f'[REPLICATION] Marked {thumb_missing_marked} thumbnail replicas as missing (source data gone)')
            if thumb_flag_cleared > 0:
                print(f'[REPLICATION] Cleared has_thumbnail flag on {thumb_flag_cleared} file(s) with no thumbnail source on any node')
            if note_self_healed > 0:
                print(f'[REPLICATION] Self-healed {note_self_healed} note(s) from local authoritative data')
            if exhausted_count > 0:
                print(f'[REPLICATION] {exhausted_count} file replicas exceeded max retries ({_MAX_ERROR_RETRIES}) — skipping (admin action required)')

            replicated = 0
            errors = 0
            _succeeded_targets = set()  # Track target nodes that accepted writes (proves online)

            # Collect all pending replicas across categories for parallel processing
            _timed_out = False
            _work_items = []    # list of (replica_obj, category, item_id, disk_id) — ORM objects for pre-marking only
            _thread_args = []   # list of (replica_id, category, item_id, disk_id, node_id, expected_version, expected_checksum)
            _active_node_ids = {
                n.id for n in enabled_nodes
                if n.status not in ('offline', 'error') and n.id in cycle_backends
            }
            # AUDIT FIX (single-copy residency was invisible): a node excluded
            # here receives NOTHING, for as long as it stays offline/error, with
            # no bound and previously no notice. Report the exclusion (throttled
            # via the audit interval) so an operator can see that replication is
            # not merely idle but blocked.
            _excluded_nodes = [n for n in enabled_nodes if n.id not in _active_node_ids]
            if _excluded_nodes:
                self._audit_single_copy_payloads()
                print(f'[WARNING] [REPLICATION] {len(_excluded_nodes)} enabled node(s) are excluded from '
                      f'this cycle and are receiving NO new data: '
                      + ', '.join(f'{n.name} (status={n.status})' for n in _excluded_nodes))
            if not _active_node_ids:
                return

            # Model lookup for re-querying replicas by ID in the main thread
            _replica_models = {'files': FileReplica, 'notes': NoteReplica, 'thumbnails': ThumbnailReplica}

            # Gather file replicas
            pending_files = FileReplica.query.filter(
                FileReplica.status == 'pending',
                FileReplica.node_id.in_(_active_node_ids),
            ).limit(_batch_size).all()
            for r in pending_files:
                # AUDIT FIX (in-flight write guard): skip a target a detached
                # worker from a prior cycle is still writing — it stays pending
                # and is retried once that worker drains, so we never start a
                # second concurrent write to the same remote object.
                if self._is_inflight_write('files', f'{r.file_id}.enc', r.node_id):
                    continue
                _work_items.append((r, 'files', r.file_id, f'{r.file_id}.enc'))
                _thread_args.append((r.id, 'files', r.file_id, f'{r.file_id}.enc', r.node_id, None, None))

            # Gather note replicas
            if not _timed_out:
                pending_notes = NoteReplica.query.filter(
                    NoteReplica.status == 'pending',
                    NoteReplica.node_id.in_(_active_node_ids),
                ).limit(_batch_size).all()
                for r in pending_notes:
                    note_obj = db.session.get(Note, r.note_id)
                    if not note_obj:
                        continue
                    # In-flight write guard: skip targets still owned by a worker.
                    if self._is_inflight_write('notes', r.note_id, r.node_id):
                        continue
                    current_version = int(note_obj.content_version or 1)
                    if (r.target_version or 0) != current_version:
                        r.target_version = current_version
                    _work_items.append((r, 'notes', r.note_id, r.note_id))
                    _thread_args.append((r.id, 'notes', r.note_id, r.note_id, r.node_id, current_version, note_obj.content_checksum))

            # Gather thumbnail replicas
            if not _timed_out:
                pending_thumbs = ThumbnailReplica.query.filter(
                    ThumbnailReplica.status == 'pending',
                    ThumbnailReplica.node_id.in_(_active_node_ids),
                ).limit(_batch_size).all()
                for r in pending_thumbs:
                    ext = '.e2e' if r.thumb_type == 'e2e' else '.jpg'
                    thumb_disk_id = f'{r.file_id}{ext}'
                    # In-flight write guard: skip targets still owned by a worker.
                    if self._is_inflight_write('thumbnails', thumb_disk_id, r.node_id):
                        continue
                    _work_items.append((r, 'thumbnails', thumb_disk_id, thumb_disk_id))
                    _thread_args.append((r.id, 'thumbnails', thumb_disk_id, thumb_disk_id, r.node_id, None, None))

            if not _work_items:
                return

            # Mark all items as 'syncing' before starting (main thread only, safe)
            for replica, _cat, _iid, _did in _work_items:
                replica.status = 'syncing'
            db.session.commit()

            # Release ORM objects — all further access uses _thread_args (plain data)
            del _work_items

            def _do_replicate(thread_tuple):
                """Worker function for thread pool. Accepts and returns only plain data
                (no ORM objects) to avoid cross-thread session contamination.
                Returns (replica_id, category, result_dict)."""
                with self._app.app_context():
                    replica_id, category, item_id, disk_id, node_id, expected_version, expected_checksum = thread_tuple
                    # AUDIT FIX (in-flight write guard): only ONE worker may write
                    # a given (category, disk_id, node_id) target at a time. If
                    # another (possibly detached/timed-out) worker still owns this
                    # target, defer — the row is requeued to pending and a later
                    # cycle retries once the stale worker drains. This is what
                    # prevents a stale transfer (left running by a cycle-timeout
                    # pool.shutdown(wait=False)) from finishing last and
                    # overwriting newer remote data outside DB awareness.
                    if not self._try_acquire_inflight_write(category, disk_id, node_id):
                        return (replica_id, category, {'status': 'deferred', 'node_id': node_id})
                    try:
                        # item_id for _replicate_single_item: file_id for files, note_id for notes, disk_id for thumbnails
                        if category in ('files', 'notes'):
                            repl_item_id = item_id
                        else:
                            repl_item_id = disk_id  # thumbnails pass disk_id (e.g. "uuid.jpg")
                        res = self._replicate_single_item(
                            replica_id, category, repl_item_id, node_id,
                            _source_mode, _primary_id, _verify_checksum, use_threads=_use_threads,
                            expected_version=expected_version, expected_checksum=expected_checksum,
                        )
                    finally:
                        self._release_inflight_write(category, disk_id, node_id)
                    return (replica_id, category, res)

            def _update_replica_status(replica_id, category, res):
                """Update replica status in the main thread by re-querying from DB.
                Returns True if a target node accepted a write (for online promotion)."""
                model = _replica_models[category]
                replica = db.session.get(model, replica_id)
                if not replica:
                    return False
                if res.get('status') == 'deferred':
                    # AUDIT FIX (in-flight write guard): another worker still owns
                    # this target. Requeue to pending WITHOUT counting an error,
                    # conditional on the row still being 'syncing' so we never
                    # clobber a concurrent re-upload/reset.
                    if replica.status == 'syncing':
                        db.session.query(model).filter(
                            model.id == replica_id,
                            model.status == 'syncing',
                        ).update({model.status: 'pending'}, synchronize_session=False)
                        db.session.commit()
                    return False
                if category == 'notes':
                    note_obj = db.session.get(Note, replica.note_id)
                    note_version = int(note_obj.content_version or 1) if note_obj else None
                    note_checksum = note_obj.content_checksum if note_obj else None
                    expected_version = int(res.get('expected_version') or replica.target_version or 0)
                    if res['status'] == 'ok':
                        if not note_obj:
                            db.session.delete(replica)
                            db.session.commit()
                            return False
                        if note_version != expected_version or (replica.target_version or 0) != note_version:
                            replica.status = 'pending'
                            replica.target_version = note_version
                            replica.verified_at = None
                            replica.last_error = None
                            db.session.commit()
                            return False
                        if note_checksum and res.get('checksum') and res['checksum'] != note_checksum:
                            replica.status = 'pending'
                            replica.target_version = note_version
                            replica.verified_at = None
                            replica.last_error = None
                            db.session.commit()
                            return False
                        replica.status = 'synced'
                        replica.synced_version = note_version
                        replica.target_version = note_version
                        replica.error_count = 0
                        replica.last_error = None
                        replica.verified_at = datetime.now(timezone.utc)
                        # AUDIT FIX (size-only replicas excluded from failover):
                        # persist the checksum of the bytes we wrote AND, in a
                        # dedicated column, whether the target actually confirmed
                        # them. Previously an unconfirmed write stored NULL here,
                        # which removed the replica from the read-failover query
                        # entirely. The trust level now lives in checksum_verified;
                        # destructive paths honour it, reads re-hash before serving.
                        replica.checksum = res.get('checksum')
                        replica.checksum_verified = bool(res.get('checksum_verified'))
                        db.session.commit()
                        _succeeded_targets.add(replica.node_id)
                        return True
                    if res['status'] == 'stale':
                        if not note_obj:
                            db.session.delete(replica)
                            db.session.commit()
                            return False
                        replica.status = 'pending'
                        replica.target_version = note_version
                        replica.verified_at = None
                        replica.error_count = 0
                        replica.last_error = None
                        db.session.commit()
                        return False
                    if res['status'] == 'missing':
                        if note_obj and cycle_local_backend and cycle_local_backend.exists('notes', replica.note_id):
                            replica.status = 'pending'
                            replica.target_version = note_version
                            replica.verified_at = None
                            replica.error_count = 0
                            replica.last_error = None
                            db.session.commit()
                            return False
                        replica.status = 'missing'
                        replica.last_error = (res.get('error') or f'MISSING SOURCE FOR {category}/{replica_id}')[:500]
                        db.session.commit()
                        return False
                if res['status'] == 'ok':
                    # AUDIT FIX H4: cross-worker race protection. The note
                    # branch above re-checks version/checksum before committing
                    # 'synced'; mirror that for files/thumbnails so a concurrent
                    # overwrite that happened mid-replication is not silently
                    # blessed with the stale-payload checksum.
                    #
                    # Use a conditional UPDATE that only fires when the row is
                    # still in 'syncing' state, so a parallel HTTP request that
                    # has already reset the row back to 'pending' (re-upload,
                    # rename, etc) wins.
                    res_checksum = res.get('checksum')
                    res_size = res.get('size_bytes')
                    expected_size = None
                    expected_checksum_now = None
                    if category == 'files':
                        try:
                            _f = db.session.get(File, replica.file_id)
                            if _f and _f.disk_size is not None:
                                expected_size = int(_f.disk_size)
                            if _f and _f.payload_checksum:
                                expected_checksum_now = _f.payload_checksum
                        except Exception:
                            pass
                    elif category == 'thumbnails':
                        try:
                            expected_size = self._thumbnail_size_bytes(
                                replica.file_id, getattr(replica, 'thumb_type', 'jpg')
                            )
                        except Exception:
                            expected_size = None
                    # Hard mismatch on expected size means the local payload
                    # changed under us — requeue and let the next cycle re-upload.
                    size_mismatch = (
                        res_size is not None and expected_size is not None
                        and int(res_size) != int(expected_size)
                    )
                    checksum_mismatch = (
                        res_checksum and expected_checksum_now
                        and res_checksum != expected_checksum_now
                    )
                    if size_mismatch or checksum_mismatch:
                        replica.status = 'pending'
                        replica.verified_at = None
                        replica.last_error = (
                            f'STALE UPLOAD RESULT (size/checksum drift): '
                            f'res_size={res_size} expected_size={expected_size}'
                        )[:500]
                        db.session.commit()
                        print(f'[REPLICATION] Detected stale upload result for {category}/{replica_id} — requeuing')
                        return False
                    # Conditional UPDATE: only flip syncing->synced; if a
                    # concurrent writer already moved us to pending/error, do
                    # NOT clobber that state.
                    now_ts = datetime.now(timezone.utc)
                    update_values = {
                        model.status: 'synced',
                        model.error_count: 0,
                        model.last_error: None,
                        model.verified_at: now_ts,
                        # AUDIT FIX (5th audit, backend honesty persisted): record the
                        # checksum of the payload written by THIS transfer, replacing
                        # any prior (now stale) value.
                        # AUDIT FIX (size-only replicas excluded from failover): the
                        # trust level is carried by checksum_verified, NOT by nulling
                        # the checksum — a size-only-accepted replica stays a legal
                        # read-failover source (verified on read) while remaining
                        # excluded from destructive redundancy decisions.
                        model.checksum: res_checksum,
                        model.checksum_verified: bool(res.get('checksum_verified')),
                    }
                    if hasattr(model, 'size_bytes') and res_size is not None:
                        update_values[model.size_bytes] = res_size
                    rows = db.session.query(model).filter(
                        model.id == replica_id,
                        model.status == 'syncing',
                    ).update(update_values, synchronize_session=False)
                    db.session.commit()
                    if rows == 0:
                        # Another worker raced ahead. Leave their state intact.
                        print(f'[REPLICATION] Replica {category}/{replica_id} no longer in syncing state — '
                              f'leaving concurrent update intact')
                        return False
                    _succeeded_targets.add(replica.node_id)
                    return True
                elif res['status'] == 'stale':
                    # AUDIT FIX (5th audit): the local file/thumbnail payload changed
                    # mid-cycle (its checksum no longer matches the value captured when
                    # the work item was gathered). This is NOT a backend failure — the
                    # new content will be re-replicated — so requeue to 'pending' WITHOUT
                    # incrementing error_count (mirrors the notes branch). Previously
                    # file/thumbnail 'stale' results fell through to the generic error
                    # branch and burned the MAX_ERROR_RETRIES budget on hot files,
                    # eventually stalling replication until a manual reset.
                    # Files also reset when no longer syncing: a detached timed-out
                    # put can finish after a rewrite already marked the row synced.
                    stale_filter = [model.id == replica_id]
                    if category != 'files':
                        stale_filter.append(model.status == 'syncing')
                    rows = db.session.query(model).filter(*stale_filter).update({
                        model.status: 'pending',
                        model.verified_at: None,
                        model.checksum: None,
                        model.checksum_verified: None,
                        model.last_error: None,
                    }, synchronize_session=False)
                    if rows and hasattr(model, 'size_bytes'):
                        db.session.query(model).filter(model.id == replica_id).update(
                            {model.size_bytes: None}, synchronize_session=False)
                    db.session.commit()
                    return False
                elif res['status'] == 'missing':
                    # For thumbnails: if the file no longer exists or has no thumbnail,
                    # delete the orphan replica row instead of endlessly retrying
                    if category == 'thumbnails' and hasattr(replica, 'file_id'):
                        file_obj = File.query.filter_by(id=replica.file_id).first()
                        if not file_obj or not file_obj.has_thumbnail:
                            db.session.delete(replica)
                            db.session.commit()
                            return False
                        # Self-heal: source missing from this node and no cross-node source was found.
                        # Check if ALL replicas for this thumbnail are now missing/absent —
                        # if so, clear the file's has_thumbnail flag so orphan rows get cleaned up.
                        _replica_ttype = getattr(replica, 'thumb_type', 'jpg')
                        _any_synced_or_pending = ThumbnailReplica.query.filter(
                            ThumbnailReplica.file_id == replica.file_id,
                            ThumbnailReplica.thumb_type == _replica_ttype,
                            ThumbnailReplica.status.in_(['synced', 'pending', 'syncing']),
                            ThumbnailReplica.id != replica.id
                        ).first()
                        # AUDIT FIX (stale thumb_type row could destroy an
                        # un-regenerable E2E thumbnail): a missing '.jpg' left
                        # behind by a Fernet->E2E conversion says nothing about
                        # the live '.e2e' thumbnail, so it must never clear
                        # has_thumbnail (which would then get every '.e2e'
                        # replica row swept). Only the thumb_type matching the
                        # file's current encryption mode may clear the flag.
                        _current_ttype = 'e2e' if file_obj.is_e2e_encrypted else 'jpg'
                        if not _any_synced_or_pending and _replica_ttype != _current_ttype:
                            print(f'[REPLICATION] [WARNING] Stale {_replica_ttype} thumbnail for file '
                                  f'{replica.file_id} has no source (current type is {_current_ttype}); '
                                  f'leaving has_thumbnail untouched')
                        elif not _any_synced_or_pending:
                            file_obj.has_thumbnail = False
                            db.session.commit()
                            print(f'[REPLICATION] Cleared has_thumbnail for file {replica.file_id} — no thumbnail source on any node')
                    replica.status = 'missing'
                    replica.last_error = (res.get('error') or f'MISSING SOURCE FOR {category}/{replica_id}')[:500]
                    db.session.commit()
                    return False
                elif res['status'] == 'deleted':
                    db.session.delete(replica)
                    db.session.commit()
                    return False
                else:
                    replica.status = 'error'
                    replica.error_count = (replica.error_count or 0) + 1
                    replica.last_error = (res.get('error') or f'REPLICATION FAILED FOR {category}/{replica_id}')[:500]
                    db.session.commit()
                    # AUDIT FIX (silent permanent park): crossing MAX_ERROR_RETRIES
                    # means the triage loop will skip this replica FOREVER, so the
                    # payload stops being mirrored to this node with no further
                    # notice. Emit an explicit prefixed [ERROR] at the moment of
                    # the transition so the external log monitor can alert on it —
                    # "do not silently give up".
                    if replica.error_count == self.MAX_ERROR_RETRIES:
                        print(f'[ERROR] [REPLICATION] {category}/{replica_id} on '
                              f'{self._node_name(replica.node_id)} has now failed '
                              f'{replica.error_count} times and is PERMANENTLY PARKED — it will not be '
                              f'retried automatically. This payload is no longer being mirrored to that '
                              f'node; admin action is required (storage retry-errors). Last error: '
                              f'{replica.last_error}')
                    return False

            # ──────────────────────────────────────────────────────
            # Release the state lock BEFORE Phase B (per-item network I/O).
            # Items have been committed as 'syncing' above, so no other code
            # path will redundantly pick them up. Releasing the lock here
            # unblocks process_pending_remote_deletes, health_check_all,
            # add_node, remove_node, and admin actions during long transfers
            # — previously these were all starved for up to _CYCLE_TIMEOUT (15min).
            # ──────────────────────────────────────────────────────
            try:
                self._state_lock.release()
                _lock_held = False
            except RuntimeError:
                pass  # Not held — shouldn't happen but guard against re-entry

            # Execute replication — parallel if workers > 1, sequential otherwise
            if _use_threads and len(_thread_args) > 1:
                import concurrent.futures as _cf
                # AUDIT FIX P0-3: do NOT use `with ThreadPoolExecutor(...) as pool:`.
                # The context manager's __exit__ calls shutdown(wait=True), which
                # blocks the scheduler thread on any still-running transfer — an
                # SSH socket can take up to _TIMEOUT_MAX (30min) to error out, far
                # past the 15-min cycle budget. We instead bound the ENTIRE
                # result-collection wait with as_completed(timeout=...) and shut
                # the pool down WITHOUT waiting (cancel_futures) in a finally, so a
                # stuck remote can never block the replication loop (and, behind
                # it, deferred deletes / health checks / admin actions) past the
                # cycle deadline.
                pool = ThreadPoolExecutor(max_workers=_num_workers)
                future_map = {}
                reset_to_pending = []
                _timed_out_during_wait = False
                try:
                    for i, targ in enumerate(_thread_args):
                        if _time.monotonic() - _cycle_start > self._CYCLE_TIMEOUT:
                            _timed_out = True
                            reset_to_pending = _thread_args[i:]
                            break
                        if i > 0:
                            _time.sleep(_item_delay)
                        future = pool.submit(_do_replicate, targ)
                        future_map[future] = targ  # plain data tuple for error logging

                    # AUDIT FIX P0-3/P1-7: bound the whole completion wait with a
                    # single deadline. Previously as_completed() had no timeout,
                    # so if every in-flight worker was stuck (no completion to
                    # yield) the scheduler thread blocked until a socket timeout
                    # fired — potentially double the cycle budget. The iterator
                    # now raises TimeoutError once the remaining budget is gone.
                    _wait_budget = max(1, self._CYCLE_TIMEOUT - (_time.monotonic() - _cycle_start))
                    try:
                        for future in as_completed(future_map, timeout=_wait_budget):
                            _remaining_budget = self._CYCLE_TIMEOUT - (_time.monotonic() - _cycle_start)
                            if _remaining_budget <= 0:
                                _timed_out = True
                                _timed_out_during_wait = True
                                break
                            try:
                                replica_id, category, res = future.result(timeout=max(1, _remaining_budget))
                                try:
                                    ok = _update_replica_status(replica_id, category, res)
                                    if ok:
                                        replicated += 1
                                    else:
                                        # 'deferred' = in-flight guard requeue, not an error.
                                        if res['status'] not in ('ok', 'stale', 'deferred'):
                                            errors += 1
                                except (StaleDataError, ObjectDeletedError):
                                    # Replica row was deleted concurrently (e.g.
                                    # the file/note/thumbnail was removed by a
                                    # request while Phase B was running). Benign —
                                    # the replica is gone, nothing to update.
                                    # StaleDataError = 0-row UPDATE during flush;
                                    # ObjectDeletedError = expired row refresh after
                                    # commit finds the row already gone. Both mean
                                    # the same thing here and must not count as errors.
                                    try:
                                        db.session.rollback()
                                    except Exception:
                                        pass
                                except Exception as db_err:
                                    print(f'[REPLICATION] DB error updating {category}/{replica_id}: {db_err}')
                                    try:
                                        db.session.rollback()
                                    except Exception:
                                        pass
                                    errors += 1
                            except Exception as fut_err:
                                targ = future_map[future]
                                if isinstance(fut_err, _cf.TimeoutError):
                                    # AUDIT FIX P1-7: a future that timed out should
                                    # be requeued to pending, not marked error — the
                                    # transfer may still be in progress.
                                    try:
                                        model = _replica_models[targ[1]]
                                        replica = db.session.get(model, targ[0])
                                        if replica and replica.status == 'syncing':
                                            replica.status = 'pending'
                                            db.session.commit()
                                    except Exception:
                                        try:
                                            db.session.rollback()
                                        except Exception:
                                            pass
                                    _timed_out = True
                                else:
                                    print(f'[REPLICATION] Thread error for {targ[1]}/{targ[2]}: {fut_err}')
                                    try:
                                        model = _replica_models[targ[1]]
                                        replica = db.session.get(model, targ[0])
                                        if replica:
                                            replica.status = 'error'
                                            replica.error_count = (replica.error_count or 0) + 1
                                            replica.last_error = str(fut_err)[:500]
                                            db.session.commit()
                                    except Exception:
                                        try:
                                            db.session.rollback()
                                        except Exception:
                                            pass
                                    errors += 1
                    except _cf.TimeoutError:
                        # Overall completion deadline reached with workers still
                        # in flight. Flag the cycle as timed out; the in-flight
                        # 'syncing' rows are requeued below (and any straggler the
                        # next cycle's stale-syncing reset will recover).
                        _timed_out = True
                        _timed_out_during_wait = True

                    if _timed_out and reset_to_pending:
                        for remaining in reset_to_pending:
                            model = _replica_models[remaining[1]]
                            replica = db.session.get(model, remaining[0])
                            if replica and replica.status == 'syncing':
                                replica.status = 'pending'
                        db.session.commit()
                    if _timed_out_during_wait:
                        # Requeue any futures that never completed back to pending
                        for f, targ in future_map.items():
                            if not f.done():
                                f.cancel()
                                try:
                                    model = _replica_models[targ[1]]
                                    replica = db.session.get(model, targ[0])
                                    if replica and replica.status == 'syncing':
                                        replica.status = 'pending'
                                except Exception:
                                    pass
                        db.session.commit()
                        print(f'[REPLICATION] Cycle timed out ({self._CYCLE_TIMEOUT}s) with in-flight workers requeued')
                finally:
                    # AUDIT FIX P0-3: never wait on stuck transfers. Cancel queued
                    # futures and let any already-running ones drain in the
                    # background instead of blocking the scheduler.
                    pool.shutdown(wait=False, cancel_futures=True)

                # Clean up thread-local SSH connections after the cycle
                for _nid, backend in cycle_backends.items():
                    if isinstance(backend, _SSHBackend):
                        backend.close_all_threads()
            else:
                # Sequential replication (single worker or single item)
                for i, targ in enumerate(_thread_args):
                    if _time.monotonic() - _cycle_start > self._CYCLE_TIMEOUT:
                        print(f'[REPLICATION] Cycle timeout ({self._CYCLE_TIMEOUT}s) reached after {replicated} items, will resume next cycle')
                        _timed_out = True
                        # Reset remaining items back to pending
                        for remaining in _thread_args[i:]:
                            model = _replica_models[remaining[1]]
                            r = db.session.get(model, remaining[0])
                            if r:
                                r.status = 'pending'
                        db.session.commit()
                        break
                    if i > 0:
                        _time.sleep(_item_delay)
                    replica_id, category, res = _do_replicate(targ)
                    try:
                        ok = _update_replica_status(replica_id, category, res)
                        if ok:
                            replicated += 1
                        else:
                            # 'deferred' = in-flight guard requeue, not an error.
                            if res['status'] not in ('ok', 'stale', 'deferred'):
                                errors += 1
                    except (StaleDataError, ObjectDeletedError):
                        # Replica row deleted concurrently (file/note/thumbnail
                        # removed by a request mid-cycle). Benign — skip.
                        # ObjectDeletedError covers the expired-row-refresh-after-
                        # commit case that StaleDataError (0-row flush) doesn't.
                        try:
                            db.session.rollback()
                        except Exception:
                            pass
                    except Exception as e:
                        print(f'[REPLICATION] Error updating replica status for {category}/{targ[2]}: {e}')
                        try:
                            db.session.rollback()
                            model = _replica_models[category]
                            replica = db.session.get(model, replica_id)
                            if replica:
                                replica.status = 'error'
                                db.session.commit()
                        except Exception:
                            try:
                                db.session.rollback()
                            except Exception:
                                pass
                        errors += 1

            # ──────────────────────────────────────────────────────
            # Re-acquire the state lock for Phase C (finalize: online promotion).
            # This is a quick DB-only phase so blocking is brief.
            # ──────────────────────────────────────────────────────
            self._state_lock.acquire()
            _lock_held = True

            # Promote nodes that accepted writes to 'online' — successful puts
            # prove the node is reachable even if head_bucket health checks fail
            if _succeeded_targets:
                promoted = []
                for nid in _succeeded_targets:
                    node = db.session.get(StorageNode, nid)
                    if node and node.status != 'online':
                        old = node.status
                        node.status = 'online'
                        node.last_seen_at = datetime.now(timezone.utc)
                        promoted.append(f'{node.name} ({old} -> online)')
                if promoted:
                    db.session.commit()
                    print(f'[REPLICATION] Promoted nodes to online (successful writes): {", ".join(promoted)}')
                # AUDIT FIX (exhausted-replica recovery on write success): a node
                # that stays 'online' (so the health-check offline->online path
                # never fires) but failed writes long enough to burn
                # MAX_ERROR_RETRIES leaves its replicas stuck in 'error' forever
                # — the triage loop skips exhausted rows and nothing else resets
                # them. A successful write THIS cycle proves the node is accepting
                # writes again, so give its exhausted replicas a fresh start now,
                # not only on a health status transition.
                recovered_total = 0
                for nid in _succeeded_targets:
                    recovered_total += self._recover_exhausted_replicas_for_node(nid)
                # AUDIT FIX (parked tombstones revived only on manual re-enable):
                # a successful write this cycle proves the node is reachable, so
                # its parked delete tombstones deserve the same fresh start as its
                # exhausted replicas — without waiting for an admin to toggle the
                # node off and on again.
                for nid in _succeeded_targets:
                    try:
                        _revived = self.reactivate_pending_remote_deletes_for_node(nid)
                        if _revived:
                            print(f'[REPLICATION] Re-activated {_revived} parked/deferred remote delete(s) '
                                  f'for {self._node_name(nid)} after successful writes')
                    except Exception as e:
                        print(f'[REPLICATION] Failed to re-activate deferred deletes for node {nid}: {e}')
                if recovered_total:
                    try:
                        db.session.commit()
                        print(f'[REPLICATION] Reset {recovered_total} exhausted replica(s) to pending after successful writes')
                    except Exception as e:
                        try:
                            db.session.rollback()
                        except Exception:
                            pass
                        print(f'[REPLICATION] Failed to commit exhausted-replica reset: {e}')
            # AUDIT FIX (single-copy residency was invisible): audit + alert on
            # under-replicated payloads and permanently-parked replicas. Self-
            # throttled to SINGLE_COPY_AUDIT_INTERVAL_SECONDS, so calling it on
            # every 10s cycle is cheap.
            self._audit_single_copy_payloads()
            _elapsed = round(_time.monotonic() - _cycle_start, 1)
            if replicated > 0 or errors > 0 or _timed_out:
                timeout_note = ' (TIMED OUT)' if _timed_out else ''
                workers_note = f' [{_num_workers} workers]' if _use_threads else ''
                # AUDIT FIX M8: be honest about checksum coverage. If
                # verify-checksum is on but any active backend reports
                # `_checksum_supported is False`, the per-replica verification
                # silently degrades to size-only on that backend. Mark this
                # explicitly in the cycle log so operators do not assume full
                # end-to-end hash coverage.
                if _verify_checksum:
                    _any_size_only = False
                    for _b in cycle_backends.values():
                        if getattr(_b, '_sha256sum_available', None) is False:
                            _any_size_only = True
                            break
                        if getattr(_b, '_checksum_supported', None) is False:
                            _any_size_only = True
                            break
                    checksum_note = ' [sha256-verified (size-only on some nodes)]' if _any_size_only else ' [sha256-verified]'
                else:
                    checksum_note = ''
                print(f'[REPLICATION] Cycle: {replicated} replicated, {errors} errors in {_elapsed}s{timeout_note}{workers_note}{checksum_note}')
        except Exception as e:
            print(f'[REPLICATION] Cycle failed: {e}')
            try:
                db.session.rollback()
            except Exception:
                pass
        finally:
            # Always release the lock on exit, regardless of whether Phase B
            # raised mid-flight (in which case _lock_held may be False —
            # avoid double-release).
            if _lock_held:
                try:
                    self._state_lock.release()
                except RuntimeError:
                    pass
