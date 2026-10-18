class _StorageManagerNodes:

    def _pin_ssh_host_key_if_needed(self, node, backend):
        if not node or node.node_type != 'ssh' or not isinstance(backend, _SSHBackend):
            return False
        config = node.get_config()
        if config.get('host_key') or config.get('host_key_sha256') or config.get('host_key_fingerprint'):
            return False
        fingerprint = backend.get_discovered_host_key_fingerprint()
        if not fingerprint:
            return False
        config['host_key_sha256'] = fingerprint
        algorithm = backend.get_discovered_host_key_algorithm()
        if algorithm:
            config['host_key_algorithm'] = algorithm
        node.set_config(config)
        print(f'[STORAGE] Pinned SSH host key fingerprint for node {node.name}: {fingerprint}')
        return True

    def _backfill_node_replicas(self, node_id):
        node = db.session.get(StorageNode, node_id)
        if not node or not node.is_enabled:
            return {'seeded': 0, 'promoted': 0, 'pending': 0}
        is_local_node = node.node_type == 'local'
        now = datetime.now(timezone.utc)
        seeded = 0
        promoted = 0
        pending = 0
        changes_since_commit = 0

        def _flush(force=False):
            nonlocal changes_since_commit
            if force or changes_since_commit >= 250:
                db.session.commit()
                changes_since_commit = 0

        all_file_ids = [fid for (fid,) in File.query.with_entities(File.id).all()]
        for fid in all_file_ids:
            if FileReplica.query.filter_by(file_id=fid, node_id=node.id).first():
                continue
            filename = f'{fid}.enc'
            if is_local_node:
                if self._local_backend.exists('files', filename):
                    db.session.add(FileReplica(
                        file_id=fid, node_id=node.id, status='synced',
                        verified_at=now, size_bytes=self._local_backend.size('files', filename),
                    ))
                    seeded += 1
                    changes_since_commit += 1
                    _flush()
                    continue
                cache_path = os.path.join(self._app.config['UPLOAD_FOLDER'], f'.cache_{filename}')
                if os.path.isfile(cache_path):
                    canonical_path = self._local_backend.get_path('files', filename)
                    # AUDIT FIX P2-7: validate the cache file against the DB
                    # payload_checksum/disk_size before promoting it to
                    # canonical — a stale cache from a corrupt/older remote
                    # fetch must not be blessed as a synced authoritative copy.
                    _file_obj = db.session.get(File, fid)
                    _exp_size = int(_file_obj.disk_size) if _file_obj and _file_obj.disk_size is not None else None
                    _exp_checksum = _file_obj.payload_checksum if _file_obj else None
                    # AUDIT FIX (unknown must not mean valid): with no
                    # authoritative expectation the cached payload can neither be
                    # promoted to canonical nor safely deleted -- leave it alone
                    # and queue the object as pending instead.
                    if not self._cache_expectations_known(_exp_size, _exp_checksum):
                        print(f'[STORAGE] [WARNING] Not promoting cached files/{filename} during backfill: '
                              f'no authoritative disk_size/payload_checksum to validate it against')
                    elif self._cache_payload_valid(cache_path, _exp_size, _exp_checksum, f'backfill files/{filename}'):
                        os.rename(cache_path, canonical_path)
                        db.session.add(FileReplica(
                            file_id=fid, node_id=node.id, status='synced',
                            verified_at=now, size_bytes=os.path.getsize(canonical_path),
                        ))
                        seeded += 1
                        promoted += 1
                        changes_since_commit += 1
                        _flush()
                        continue
                    else:
                        self._discard_cache_payload(cache_path)
            db.session.add(FileReplica(file_id=fid, node_id=node.id, status='pending'))
            pending += 1
            changes_since_commit += 1
            _flush()

        all_note_ids = [nid for (nid,) in Note.query.with_entities(Note.id).all()]
        for nid in all_note_ids:
            if NoteReplica.query.filter_by(note_id=nid, node_id=node.id).first():
                continue
            note_obj = db.session.get(Note, nid)
            note_version = int(note_obj.content_version or 1) if note_obj else 1
            note_checksum = note_obj.content_checksum if note_obj else None
            if is_local_node:
                if self._local_backend.exists('notes', nid):
                    db.session.add(NoteReplica(
                        note_id=nid,
                        node_id=node.id,
                        status='synced',
                        synced_version=note_version,
                        target_version=note_version,
                        checksum=note_checksum,
                        verified_at=now,
                    ))
                    seeded += 1
                    changes_since_commit += 1
                    _flush()
                    continue
                cache_path = os.path.join(NOTES_DIR, f'.cache_{nid}')
                if os.path.isfile(cache_path):
                    canonical_path = self._local_backend.get_path('notes', nid)
                    # AUDIT FIX P2-7: validate note cache before promoting.
                    _exp_size = int(note_obj.size) if note_obj and note_obj.size is not None else None
                    # AUDIT FIX (unknown must not mean valid): see the file branch.
                    if not self._cache_expectations_known(_exp_size, note_checksum):
                        print(f'[STORAGE] [WARNING] Not promoting cached notes/{nid} during backfill: '
                              f'no authoritative size/content_checksum to validate it against')
                    elif self._cache_payload_valid(cache_path, _exp_size, note_checksum, f'backfill notes/{nid}'):
                        os.rename(cache_path, canonical_path)
                        db.session.add(NoteReplica(
                            note_id=nid,
                            node_id=node.id,
                            status='synced',
                            synced_version=note_version,
                            target_version=note_version,
                            checksum=note_checksum,
                            verified_at=now,
                        ))
                        seeded += 1
                        promoted += 1
                        changes_since_commit += 1
                        _flush()
                        continue
                    else:
                        self._discard_cache_payload(cache_path)
            db.session.add(NoteReplica(
                note_id=nid,
                node_id=node.id,
                status='pending',
                target_version=note_version,
            ))
            pending += 1
            changes_since_commit += 1
            _flush()

        for fid in all_file_ids:
            for thumb_type, ext in [('jpg', '.jpg'), ('e2e', '.e2e')]:
                if ThumbnailReplica.query.filter_by(file_id=fid, thumb_type=thumb_type, node_id=node.id).first():
                    continue
                thumb_id = f'{fid}{ext}'
                has_source = self._local_backend and self._local_backend.exists('thumbnails', thumb_id)
                if not has_source and is_local_node:
                    cache_path = os.path.join(THUMBNAILS_DIR, f'.cache_{thumb_id}')
                    if os.path.isfile(cache_path):
                        # AUDIT FIX P2-2: validate the cache file against a recorded
                        # sibling checksum/size before promoting it to canonical, so
                        # a stale/corrupt cached thumbnail is not blessed as a synced
                        # authoritative copy (mirrors the file/note backfill paths).
                        _sib_thumb = ThumbnailReplica.query.filter(
                            ThumbnailReplica.file_id == fid,
                            ThumbnailReplica.thumb_type == thumb_type,
                            ThumbnailReplica.status == 'synced',
                            ThumbnailReplica.checksum.isnot(None),
                        ).order_by(ThumbnailReplica.verified_at.desc()).first()
                        _exp_thumb_cs = _sib_thumb.checksum if _sib_thumb else None
                        if not _exp_thumb_cs:
                            _exp_thumb_cs = self._tracked_thumbnail_checksum_hex(fid, thumb_type)
                        _exp_thumb_sz = int(_sib_thumb.size_bytes) if (_sib_thumb and _sib_thumb.size_bytes is not None) else None
                        # AUDIT FIX (unknown must not mean valid): previously a
                        # missing sibling checksum SHORT-CIRCUITED validation
                        # (`not _exp_thumb_cs or ...`) and promoted the cached
                        # thumbnail to canonical unchecked. Promote only on proof;
                        # discard only on disproof; otherwise leave it in place.
                        if not self._cache_expectations_known(_exp_thumb_sz, _exp_thumb_cs):
                            print(f'[STORAGE] [WARNING] Not promoting cached thumbnails/{thumb_id} during '
                                  f'backfill: no authoritative size/checksum to validate it against')
                        elif self._cache_payload_valid(
                            cache_path, _exp_thumb_sz, _exp_thumb_cs, f'backfill thumbnails/{thumb_id}'
                        ):
                            canonical_path = self._local_backend.get_path('thumbnails', thumb_id)
                            os.rename(cache_path, canonical_path)
                            has_source = True
                            promoted += 1
                        else:
                            self._discard_cache_payload(cache_path)
                if not has_source:
                    has_source = ThumbnailReplica.query.filter_by(file_id=fid, thumb_type=thumb_type, status='synced').first() is not None
                if not has_source:
                    continue
                if is_local_node and self._local_backend.exists('thumbnails', thumb_id):
                    db.session.add(ThumbnailReplica(
                        file_id=fid, thumb_type=thumb_type, node_id=node.id,
                        status='synced', verified_at=now,
                        size_bytes=self._local_backend.size('thumbnails', thumb_id),
                    ))
                    seeded += 1
                else:
                    db.session.add(ThumbnailReplica(file_id=fid, thumb_type=thumb_type, node_id=node.id, status='pending'))
                    pending += 1
                changes_since_commit += 1
                _flush()

        _flush(force=True)
        return {'seeded': seeded, 'promoted': promoted, 'pending': pending}

    def _backfill_node_replicas_background(self, node_id):
        with self._app.app_context():
            # AUDIT FIX (finding 6): this used to hold the global storage state
            # lock across the ENTIRE replica backfill (full File/Note/Thumbnail
            # scans plus per-row existence checks) AND the remote health check
            # (SSH connect alone can block up to _CONNECT_TIMEOUT = 120s),
            # convoying replication finalisation, deferred deletes and admin
            # actions behind it. The phases now mirror health_check_all():
            # a short locked node check, the slow DB/network work UNLOCKED,
            # and a short locked write-back that re-reads the node fresh so a
            # removal that raced the probe cannot be resurrected by a stale
            # status write.
            with self._state_lock:
                node = db.session.get(StorageNode, node_id)
                if not node or not node.is_enabled:
                    return

            result = None
            health_ok = None
            health_error = None
            probe_failed = False
            backend = None
            try:
                result = self._backfill_node_replicas(node_id)
                backends, _lb, _lnid, _v = self._backend_state_snapshot()
                backend = backends.get(node_id)
                if backend:
                    try:
                        health_ok = bool(backend.health_check())
                    except Exception as hc_err:
                        health_ok = False
                        health_error = hc_err
            except Exception as e:
                probe_failed = True
                health_error = e
                db.session.rollback()
                print(f'[STORAGE] Backfill failed for node {node_id}: {e}')

            with self._state_lock:
                try:
                    node = db.session.get(StorageNode, node_id)
                    if node is None:
                        # Node was removed while the backfill/probe ran
                        # unlocked: reap any replica rows this thread managed
                        # to (re)insert for the now-nonexistent node so no
                        # dangling bookkeeping claims bytes nobody tracks.
                        for _model in (FileReplica, NoteReplica, ThumbnailReplica):
                            db.session.query(_model).filter(
                                _model.node_id == node_id
                            ).delete(synchronize_session=False)
                        db.session.commit()
                        print(f'[STORAGE] Backfill for removed node {node_id} discarded')
                        return
                    if probe_failed:
                        node.status = 'error'
                    elif health_ok:
                        if backend and self._pin_ssh_host_key_if_needed(node, backend):
                            db.session.commit()
                        node.status = 'online'
                        node.last_seen_at = datetime.now(timezone.utc)
                    elif health_ok is False:
                        # Mirrors the original behaviour: a failed probe is
                        # 'offline', an exception raised by the probe is 'error'.
                        node.status = 'error' if health_error is not None else 'offline'
                    # health_ok is None (no backend built): leave status as-is,
                    # exactly like the previous code path.
                    db.session.commit()
                except Exception as e:
                    db.session.rollback()
                    node = db.session.get(StorageNode, node_id)
                    if node:
                        node.status = 'error'
                        try:
                            db.session.commit()
                        except Exception:
                            db.session.rollback()
                    health_error = e
                    probe_failed = True
                if probe_failed:
                    # AUDIT FIX P2-5: bump backends version on failure so other
                    # workers refresh their stale backend cache that may still
                    # include this node.
                    try:
                        self._bump_backends_version()
                    except Exception:
                        pass
            if result is not None and not probe_failed:
                print(
                    f'[STORAGE] Backfill completed for node {node_id}: '
                    f'{result["seeded"]} synced, {result["pending"]} queued, {result["promoted"]} cache promotions'
                )
            elif probe_failed and result is not None:
                print(f'[STORAGE] Backfill ran but status write-back failed for node {node_id}: {health_error}')

    def health_check_all(self):
        # AUDIT FIX P2-3: run the backend.health_check()/disk_usage() network
        # probes WITHOUT holding self._state_lock. Only the node snapshot
        # (Phase A) and the status write-back (Phase C) are serialized. A slow
        # or offline SSH/S3 node previously blocked replication finalize,
        # deferred deletes, and admin actions for the duration of every probe
        # (the SSH connect alone can take up to _CONNECT_TIMEOUT = 120s).
        # ── Phase A (locked): snapshot enabled nodes + their backends ──
        with self._state_lock:
            try:
                self._ensure_local_backend_ready()
                nodes = StorageNode.query.filter_by(is_enabled=True).all()
                state_backends, state_local_backend, state_local_node_id, _version = self._backend_state_snapshot()
                snapshot = []  # (node_id, node_type, backend)
                for node in nodes:
                    backend = state_backends.get(node.id)
                    if (not backend and node.node_type == 'local'
                            and node.id == state_local_node_id and state_local_backend):
                        backend = state_local_backend
                    snapshot.append((node.id, node.node_type, backend))
            except Exception as e:
                print(f'[STORAGE] Health check setup failed: {e}')
                return

        # ── Phase B (UNLOCKED): probe each backend ──
        results = {}  # node_id -> {reachable, disk, backend, error}
        for node_id, node_type, backend in snapshot:
            entry = {'reachable': False, 'disk': None, 'backend': backend, 'error': None}
            if backend is None:
                entry['reachable'] = None  # no backend at all
                results[node_id] = entry
                continue
            try:
                if backend.health_check():
                    entry['reachable'] = True
                    if node_type in ('local', 'ssh'):
                        try:
                            entry['disk'] = backend.disk_usage()
                        except Exception:
                            entry['disk'] = None
            except Exception as e:
                entry['reachable'] = False
                entry['error'] = str(e)
            results[node_id] = entry

        # ── Phase C (locked): write back statuses ──
        with self._state_lock:
            try:
                now = datetime.now(timezone.utc)
                for node_id, entry in results.items():
                    node = db.session.get(StorageNode, node_id)
                    if not node or not node.is_enabled:
                        continue
                    old_status = node.status
                    backend = entry['backend']
                    if entry['reachable'] is None or backend is None:
                        if old_status != 'error':
                            print(f'[STORAGE] Health check: {node.name} -> error (no backend)')
                        node.status = 'error'
                        continue
                    if entry['reachable']:
                        if self._pin_ssh_host_key_if_needed(node, backend):
                            db.session.commit()
                        node.status = 'online'
                        node.last_seen_at = now
                        # AUDIT FIX M7: reachable probe clears the failure streak.
                        node.consecutive_failures = 0
                        node.consecutive_successes = int(node.consecutive_successes or 0) + 1
                        if entry.get('disk'):
                            with self._disk_usage_lock:
                                self._disk_usage_cache[node_id] = {
                                    'data': entry['disk'],
                                    'cached_at': now.isoformat(),
                                }
                        # AUDIT FIX (exhausted-replica auto-recovery): a node that
                        # flapped enough to burn MAX_ERROR_RETRIES leaves its
                        # replicas stuck in 'error' forever — the triage loop
                        # skips exhausted rows and nothing else resets them, so
                        # that data stays permanently under-replicated until an
                        # admin runs reset_failed_replication_state. Now that the
                        # node is reachable again, give those exhausted replicas a
                        # fresh start so replication heals them automatically.
                        if old_status != 'online':
                            recovered = self._recover_exhausted_replicas_for_node(node_id)
                            if recovered:
                                print(f'[STORAGE] Node {node.name} back online — reset {recovered} exhausted replica(s) to pending')
                            # AUDIT FIX (parked tombstones revived only on manual
                            # re-enable): reactivate_pending_remote_deletes_for_node
                            # was wired ONLY to the admin node-ENABLE action, so a
                            # node that was never disabled but merely offline long
                            # enough to exhaust DEFERRED_DELETE_MAX_RETRIES kept its
                            # tombstones parked forever and the deleted objects
                            # stayed on it indefinitely. A node coming back online is
                            # exactly the event that should revive them.
                            _revived = self.reactivate_pending_remote_deletes_for_node(node_id)
                            if _revived:
                                print(f'[STORAGE] Node {node.name} back online — re-activated {_revived} '
                                      f'parked/deferred remote delete(s)')
                        # AUDIT FIX (F7 integrity visibility): persist the live
                        # backend integrity capability so admins can see which
                        # nodes only have size-only verification. Only overwrite
                        # when the capability is actually known (not None) so we
                        # never clobber a previously-discovered value with
                        # "unknown".
                        cap = self._backend_checksum_capability(backend)
                        if cap is not None and node.checksum_capable != cap:
                            node.checksum_capable = cap
                            print(f'[STORAGE] Node {node.name} integrity capability: '
                                  f'{"full SHA-256" if cap else "SIZE-ONLY"}')
                    else:
                        # AUDIT FIX M7: hysteresis — require N consecutive failed
                        # probes before flipping to 'offline'. A transient blip
                        # otherwise dropped the node from replication for up to a
                        # full health_check_interval. While "suspect" (below the
                        # threshold) the node keeps its prior status so replication
                        # keeps attempting it.
                        node.consecutive_successes = 0
                        node.consecutive_failures = int(node.consecutive_failures or 0) + 1
                        fail_threshold = max(1, get_numeric_setting('health_check_failure_threshold'))
                        if node.consecutive_failures >= fail_threshold:
                            node.status = 'offline'
                        elif old_status not in ('offline', 'error'):
                            print(f'[STORAGE] Health check: {node.name} probe failed '
                                  f'({node.consecutive_failures}/{fail_threshold}) — keeping '
                                  f'{old_status} until failure threshold'
                                  + (f" (exception: {entry['error']})" if entry.get('error') else ''))
                    if old_status != node.status:
                        if entry.get('error') and node.status == 'offline':
                            print(f"[STORAGE] Health check: {node.name} {old_status} -> offline (exception: {entry['error']})")
                        else:
                            print(f'[STORAGE] Health check: {node.name} {old_status} -> {node.status}')
                db.session.commit()
            except Exception as e:
                print(f'[STORAGE] Health check write-back failed: {e}')
                try:
                    db.session.rollback()
                except Exception:
                    pass

    def _backend_checksum_capability(self, backend):
        """Return the integrity capability of a backend for F7 admin visibility:
        True  -> full SHA-256 verification available
        False -> size-only (SSH node without sha256sum/shasum, or S3 provider
                 without ChecksumSHA256 support)
        None  -> not yet determined (no checksum operation has run yet)."""
        if isinstance(backend, _LocalBackend):
            return True
        if isinstance(backend, _SSHBackend):
            return getattr(backend, '_sha256sum_available', None)
        if isinstance(backend, _S3Backend):
            return getattr(backend, '_checksum_supported', None)
        return None

    def _recover_exhausted_replicas_for_node(self, node_id):
        """When a node returns to 'online', give its exhausted replicas
        (status='error' with error_count >= MAX_ERROR_RETRIES — which the
        replication triage loop skips forever) a fresh start so data
        re-replicates without manual admin intervention. Returns the number of
        replica rows reset. Caller is responsible for the surrounding commit."""
        total = 0
        for model in (FileReplica, NoteReplica, ThumbnailReplica):
            try:
                reset = db.session.query(model).filter(
                    model.node_id == node_id,
                    model.status == 'error',
                    model.error_count >= self.MAX_ERROR_RETRIES,
                ).update({
                    model.status: 'pending',
                    model.error_count: 0,
                    model.verified_at: None,
                    model.last_error: None,
                }, synchronize_session=False)
                total += reset or 0
            except Exception as e:
                print(f'[STORAGE] Failed to reset exhausted {model.__name__} rows for node {node_id}: {e}')
        return total

    def add_node(self, name, node_type, config, is_primary=False):
        # AUDIT FIX (finding 7): the initial health check (SSH connect up to
        # _CONNECT_TIMEOUT = 120s, S3 probes, MinIO/DNS timeouts) used to run
        # WHILE HOLDING the global storage state lock, blocking replication
        # finalisation, deferred deletes and every other admin action for the
        # duration. Phase A below is DB-only; the probe runs unlocked; Phase C
        # re-reads the node fresh so a concurrent removal cannot be
        # resurrected by a stale status write.
        node_pk = None
        backend = None
        created_node = None
        # ── Phase A (locked): validate + insert row + collapse primaries ──
        with self._state_lock:
            # AUDIT FIX (finding 1): fail-safe reject of an additional local
            # node inside the lock so two concurrent adds cannot both observe
            # zero local rows.
            if node_type == 'local':
                _existing_local = StorageNode.query.filter_by(node_type='local').count()
                _local_err = _validate_local_node_addition(_existing_local, config)
                if _local_err:
                    raise ValueError(_local_err)
            # AUDIT FIX L10: demote any existing primaries in the SAME
            # transaction as the insert so two simultaneous add_node calls
            # cannot leave the DB with two `is_primary=True` rows.
            node = StorageNode(
                name=name, node_type=node_type, is_primary=is_primary,
                is_enabled=True, status='syncing', created_at=datetime.now(timezone.utc),
            )
            node.set_config(config)
            created_node = node
            try:
                # AUDIT FIX (finding 8): ordered row locks first — a concurrent
                # set_primary/add_node in ANY worker then serialises behind
                # these rows instead of interleaving its own demote/set pair.
                self._lock_storage_node_rows()
                if is_primary:
                    StorageNode.query.filter_by(is_primary=True).update({'is_primary': False})
                db.session.add(node)
                db.session.commit()
            except Exception:
                db.session.rollback()
                raise
            # Idempotently collapse multi-primary state (defense-in-depth).
            try:
                primaries = StorageNode.query.filter_by(is_primary=True).order_by(
                    StorageNode.created_at.asc(), StorageNode.id.asc()
                ).all()
                if len(primaries) > 1:
                    keep = primaries[0]
                    for extra in primaries[1:]:
                        extra.is_primary = False
                        print(f'[STORAGE] Collapsed duplicate primary node {extra.id} (keeping {keep.id})')
                    db.session.commit()
            except Exception:
                db.session.rollback()
            try:
                backend = self._create_backend(node)
            except Exception as e:
                node.status = 'error'
                db.session.commit()
                self._bump_backends_version()
                self.refresh_backends()
                print(f'[STORAGE] Node added but backend init failed: {e}')
                return created_node
            node_pk = node.id

        # ── Phase B (UNLOCKED): initial network health check ──
        health_ok = None
        health_error = None
        try:
            health_ok = bool(backend.health_check())
        except Exception as hc_err:
            health_ok = False
            health_error = hc_err

        # ── Phase C (locked): status write-back + publish + backfill ──
        with self._state_lock:
            live = db.session.get(StorageNode, node_pk) if node_pk else None
            if live is None:
                # Removed concurrently while the probe ran unlocked.
                self._close_backend_set({node_pk: backend})
                print(f'[STORAGE] Node {node_pk} ({name}) was removed during add; skipping publish')
                return created_node
            try:
                if health_ok:
                    if self._pin_ssh_host_key_if_needed(live, backend):
                        db.session.commit()
                    live.last_seen_at = datetime.now(timezone.utc)
                    print(f'[STORAGE] Initial health check passed for {name}')
                elif health_error is not None:
                    live.status = 'offline'
                    print(f'[STORAGE] Initial health check error for {name}: {health_error}')
                else:
                    live.status = 'offline'
                    print(f'[STORAGE] Initial health check failed for {name} — marked offline')
                db.session.commit()
                self._bump_backends_version()
                self.refresh_backends()
                published_backends, _local_backend, _local_node_id, _version = self._backend_state_snapshot()
                if published_backends.get(node_pk) is not backend:
                    self._close_backend_set({node_pk: backend})
                worker = threading.Thread(target=self._backfill_node_replicas_background, args=(node_pk,), daemon=True)
                worker.start()
                print(f'[STORAGE] Added node: {name} ({node_type}) — backfill started in background')
            except Exception as e:
                db.session.rollback()
                live = db.session.get(StorageNode, node_pk)
                if live is not None:
                    live.status = 'error'
                    db.session.commit()
                self._bump_backends_version()
                self.refresh_backends()
                print(f'[STORAGE] Node added but backend init failed: {e}')
            return created_node

    def check_node_exclusive_data(self, node_id, verify_stale_evidence=False,
                                  verify_limit=500, max_verify_seconds=120,
                                  stale_after_seconds=None):
        """Check if a node holds the ONLY synced copy of any files/notes/thumbnails.

        By DEFAULT this uses DB replica status only — it does not actively probe
        remote backends, which would hang for minutes if an SSH node is offline.
        That keeps the admin "check removal" page fast.

        Pass verify_stale_evidence=True (as remove_node does before a
        NON-forced destructive removal) to live-verify every affected file and
        stale surviving note/thumbnail copies. See
        _verify_removal_redundancy() for why a DB-only answer is not sufficient
        to authorise a removal.

        AUDIT Tier 1: previously this ran one SELECT per synced item, so a
        node holding 50K files made 50K queries before the admin "remove
        node" page could render. We now use a single GROUP BY / HAVING per
        category to find ids whose ONLY synced replica is on this node,
        then a single local-backend listing for the fallback membership
        check. For notes, we additionally require the synced replica's
        synced_version to match the current Note.content_version, so a
        stale synced row on another node doesn't mask a true exclusive.
        """
        _backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        # ── Files exclusive to this node ──────────────────────────────
        # Find file_ids where (a) this node has a synced row AND (b) no
        # OTHER node has a *verified* synced row for the same file_id.
        #
        # AUDIT FIX (existence != integrity): the "other node has a copy" test
        # must require verification evidence (checksum IS NOT NULL). A synced
        # row with a NULL checksum is unverified — self-heal that recorded a
        # remote object from a directory listing, or a not-yet-scrubbed row —
        # and must NOT mask this node as safely removable. Counting only
        # checksum-bearing rows on other nodes means an unverified copy elsewhere
        # keeps the file flagged as exclusive here, forcing an explicit --force.
        exclusive_file_ids_query = db.session.query(FileReplica.file_id).filter(
            FileReplica.status == 'synced',
        ).group_by(FileReplica.file_id).having(
            db.and_(
                db.func.sum(case((FileReplica.node_id == node_id, 1), else_=0)) > 0,
                # AUDIT FIX (verified vs. merely recorded): a checksum recorded
                # for a SIZE-ONLY accepted write is not verification evidence, so
                # checksum_verified=False rows must not mask this node as
                # removable. NULL (legacy/unknown) keeps its prior meaning.
                db.func.sum(case((db.and_(FileReplica.node_id != node_id,
                                          FileReplica.checksum.isnot(None),
                                          FileReplica.checksum_verified.isnot(False)), 1), else_=0)) == 0,
            )
        )
        exclusive_file_ids = {fid for (fid,) in exclusive_file_ids_query.all()}

        # ── Notes exclusive to this node ──────────────────────────────
        # Notes need a version match: the node must have synced_version ==
        # Note.content_version, and no OTHER node may have a synced row
        # also matching the current version.
        # Bulk: pull (note_id, current content_version), then pull
        # synced replicas matching the current version, and compute
        # exclusivity in Python.
        all_note_versions = dict(
            db.session.query(Note.id, Note.content_version).all()
        )
        if all_note_versions:
            # Map: note_id -> set of node_ids that have synced row matching
            # current content_version.
            current_synced_nodes = {}
            synced_rows = db.session.query(
                NoteReplica.note_id, NoteReplica.node_id, NoteReplica.synced_version
            ).filter(
                NoteReplica.status == 'synced',
                NoteReplica.note_id.in_(all_note_versions.keys()),
            ).all()
            for nid, nodeid, sv in synced_rows:
                expected = int(all_note_versions.get(nid) or 1)
                if sv is not None and int(sv) == expected:
                    current_synced_nodes.setdefault(nid, set()).add(nodeid)
            exclusive_note_ids = {
                nid for nid, nodes in current_synced_nodes.items()
                if nodes == {node_id}
            }
        else:
            exclusive_note_ids = set()

        # ── Thumbnails exclusive to this node ─────────────────────────
        # AUDIT FIX (existence != integrity): thumbnails are not always
        # checksummed end-to-end, so size_bytes is the verification evidence
        # here. An OTHER-node synced row with NULL size_bytes is unverified
        # (existence-only self-heal or not-yet-scrubbed) and must NOT mask this
        # node as safely removable — only size-bearing rows count as redundant.
        exclusive_thumbs_query = db.session.query(
            ThumbnailReplica.file_id, ThumbnailReplica.thumb_type
        ).filter(
            ThumbnailReplica.status == 'synced',
        ).group_by(
            ThumbnailReplica.file_id, ThumbnailReplica.thumb_type
        ).having(
            db.and_(
                db.func.sum(case((ThumbnailReplica.node_id == node_id, 1), else_=0)) > 0,
                db.func.sum(case((db.and_(ThumbnailReplica.node_id != node_id, ThumbnailReplica.size_bytes.isnot(None)), 1), else_=0)) == 0,
            )
        )
        exclusive_thumb_keys = list(exclusive_thumbs_query.all())  # list of (file_id, thumb_type)

        # ── Local-disk fallback membership (single listing per category) ──
        local_files_set = set()
        local_notes_set = set()
        local_thumbs_set = set()
        if local_node_id != node_id and local_backend:
            try:
                local_files_set = set(local_backend.list_files('files') or [])
            except Exception:
                pass
            try:
                local_notes_set = set(local_backend.list_files('notes') or [])
            except Exception:
                pass
            try:
                local_thumbs_set = set(local_backend.list_files('thumbnails') or [])
            except Exception:
                pass

        exclusive_files = sum(
            1 for fid in exclusive_file_ids
            if f'{fid}.enc' not in local_files_set
        )
        exclusive_notes = sum(
            1 for nid in exclusive_note_ids
            if nid not in local_notes_set
        )
        exclusive_thumbs = 0
        for fid, ttype in exclusive_thumb_keys:
            ext = '.e2e' if ttype == 'e2e' else '.jpg'
            if f'{fid}{ext}' not in local_thumbs_set:
                exclusive_thumbs += 1

        result = {'exclusive_files': exclusive_files, 'exclusive_notes': exclusive_notes,
                  'exclusive_thumbnails': exclusive_thumbs,
                  'verification_performed': False,
                  'stale_evidence_checked': 0,
                  'stale_evidence_failed': 0,
                  'verification_incomplete': False}

        if verify_stale_evidence:
            result.update(self._verify_removal_redundancy(
                node_id,
                exclusive_file_ids, exclusive_note_ids, set(exclusive_thumb_keys),
                local_files_set, local_notes_set, local_thumbs_set,
                verify_limit=verify_limit,
                max_verify_seconds=max_verify_seconds,
                stale_after_seconds=stale_after_seconds,
            ))
        return result

    def _verify_removal_redundancy(self, node_id, exclusive_file_ids, exclusive_note_ids,
                                   exclusive_thumb_keys, local_files_set, local_notes_set,
                                   local_thumbs_set, verify_limit=500, max_verify_seconds=120,
                                   stale_after_seconds=None):
        """LIVE-verify file redundancy and stale note/thumbnail evidence.

        AUDIT FIX (week-stale rows trusted for node removal): the removal safety
        check is deliberately DB-only so the admin page cannot hang on an offline
        node. But `integrity_scrub_min_reverify_interval` defaults to 604800s
        (7 days) and `integrity_scrub_deep_verify_batch_size` defaults to 0, so a
        remote object that VANISHED can keep a 'synced' row for a week. An admin
        was therefore told a node's data was redundant when the only other copy
        no longer existed — and removing the node deleted the last tracking of
        the last copy. purge_local_copies() already does live re-verification
        before it destroys anything; this brings node removal to the same bar.

        Scope is deliberately narrow so the check stays affordable: only objects
        that (a) actually lose a copy when this node goes, (b) have NO local-disk
        copy to fall back on, and (c) whose surviving remote evidence is older
        than the re-verify floor (or was never verified at all). Anything we could
        not get to inside the limits sets verification_incomplete, which callers
        must treat as "refuse" — not as "fine"."""
        try:
            self._ensure_local_backend_ready()
            self._check_backends_freshness()
        except Exception as e:
            print(f'[STORAGE] Could not refresh backends before node-removal verification: {e}')
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        if stale_after_seconds is None:
            try:
                stale_after_seconds = max(0, get_numeric_setting('integrity_scrub_min_reverify_interval'))
            except Exception:
                stale_after_seconds = 604800
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=int(stale_after_seconds or 0))
        deadline = time.monotonic() + max_verify_seconds if max_verify_seconds and max_verify_seconds > 0 else None
        checked = 0
        failed = 0
        incomplete = False

        def _stale_clause(model):
            return db.or_(model.verified_at.is_(None), model.verified_at < cutoff)

        def _local_copy_matches(category, disk_id, expected_checksum):
            if not local_backend or not expected_checksum:
                return False
            try:
                local_path = local_backend.get_path(category, disk_id)
                return os.path.isfile(local_path) and self._sha256_file(local_path) == expected_checksum
            except Exception as e:
                print(f'[STORAGE] Local node-removal verification failed for {category}/{disk_id}: {e}')
                return False

        # ── files ──────────────────────────────────────────────────────────
        # Destructive removal needs current evidence for every file that loses
        # a copy. A recently verified row is not proof that the object still
        # exists, and a local filename is not proof that its bytes are intact.
        losing_file_ids = [fid for (fid,) in db.session.query(FileReplica.file_id).filter(
            FileReplica.node_id == node_id, FileReplica.status == 'synced'
        ).distinct().all()]
        for file_id in losing_file_ids:
            if checked >= verify_limit or (deadline is not None and time.monotonic() > deadline):
                incomplete = True
                break
            file_obj = db.session.get(File, file_id)
            expected_size = file_obj.disk_size if file_obj else None
            expected_checksum = file_obj.payload_checksum if file_obj else None
            if expected_size is None or not expected_checksum:
                failed += 1
                continue

            disk_id = f'{file_id}.enc'
            survivor_verified = False
            if local_node_id != node_id and local_backend:
                try:
                    if local_backend.exists('files', disk_id):
                        checked += 1
                        local_path = local_backend.get_path('files', disk_id)
                        survivor_verified = (
                            os.path.getsize(local_path) == int(expected_size)
                            and self._sha256_file(local_path) == expected_checksum
                        )
                        if survivor_verified:
                            local_replica = FileReplica.query.filter_by(
                                file_id=file_id, node_id=local_node_id).first()
                            if local_replica:
                                local_replica.status = 'synced'
                                local_replica.size_bytes = int(expected_size)
                                local_replica.checksum = expected_checksum
                                local_replica.checksum_verified = True
                                local_replica.verified_at = datetime.now(timezone.utc)
                                local_replica.last_error = None
                except Exception as e:
                    print(f'[STORAGE] Local node-removal verification failed for file {file_id}: {e}')

            if not survivor_verified:
                candidates = FileReplica.query.filter(
                    FileReplica.file_id == file_id,
                    FileReplica.node_id != node_id,
                    FileReplica.node_id != local_node_id,
                    FileReplica.status == 'synced',
                ).order_by(*_order_by_nulls_first_asc(FileReplica.verified_at)).all()
                for replica in candidates:
                    if checked >= verify_limit or (deadline is not None and time.monotonic() > deadline):
                        incomplete = True
                        break
                    backend = backends.get(replica.node_id)
                    if not backend:
                        continue
                    checked += 1
                    if self._verify_remote_replica_payload(
                        replica, backend, 'files', disk_id,
                        expected_size, expected_checksum,
                        'NODE REMOVAL SAFETY CHECK', update_replica=True,
                    ):
                        survivor_verified = True
                        break

            if not survivor_verified:
                failed += 1

        # ── notes ──────────────────────────────────────────────────────────
        # A local filename is not proof of intact bytes: only a local copy that
        # hashes to the authoritative checksum stands in for a remote survivor.
        node_note_ids = {nid for (nid,) in db.session.query(NoteReplica.note_id).filter(
            NoteReplica.node_id == node_id, NoteReplica.status == 'synced'
        ).distinct().all()}
        local_note_candidates = (node_note_ids | set(exclusive_note_ids)) & set(local_notes_set)
        verified_local_notes = set()
        for nid in local_note_candidates:
            checked += 1
            if _local_copy_matches('notes', nid, self._tracked_note_checksum_hex(nid, exclude_node_id=node_id)):
                verified_local_notes.add(nid)
        failed += len((set(exclusive_note_ids) & local_note_candidates) - verified_local_notes)
        losing_note_ids = {
            nid for nid in node_note_ids
            if nid not in exclusive_note_ids and nid not in verified_local_notes
        }
        if losing_note_ids:
            # Every losing note needs a survivor: fresh evidence or a live check
            # below, and only a copy of the CURRENT generation counts.
            _current_note = db.and_(
                NoteReplica.note_id == Note.id,
                NoteReplica.synced_version == db.func.coalesce(Note.content_version, 1),
                db.or_(Note.content_checksum.is_(None), NoteReplica.checksum == Note.content_checksum),
            )
            notes_with_survivor = {nid for (nid,) in db.session.query(NoteReplica.note_id).join(
                Note, _current_note
            ).filter(
                NoteReplica.note_id.in_(losing_note_ids),
                NoteReplica.node_id != node_id,
                NoteReplica.node_id != local_node_id,
                NoteReplica.status == 'synced',
                NoteReplica.checksum.isnot(None),
                NoteReplica.checksum_verified.isnot(False),
                db.not_(_stale_clause(NoteReplica)),
            ).distinct().all()}
            rows = NoteReplica.query.join(Note, _current_note).filter(
                NoteReplica.note_id.in_(losing_note_ids),
                NoteReplica.node_id != node_id,
                NoteReplica.status == 'synced',
                NoteReplica.checksum.isnot(None),
                NoteReplica.checksum_verified.isnot(False),
                _stale_clause(NoteReplica),
            ).order_by(*_order_by_nulls_first_asc(NoteReplica.verified_at)).limit(verify_limit + 1).all()
            if len(rows) > verify_limit:
                incomplete = True
                rows = rows[:verify_limit]
            for replica in rows:
                if deadline is not None and time.monotonic() > deadline:
                    incomplete = True
                    break
                if replica.node_id == local_node_id:
                    continue
                backend = backends.get(replica.node_id)
                if not backend:
                    incomplete = True
                    continue
                note_obj = db.session.get(Note, replica.note_id)
                checked += 1
                if self._verify_remote_replica_payload(
                    replica, backend, 'notes', replica.note_id,
                    int(note_obj.size) if note_obj and note_obj.size is not None else None,
                    self._tracked_note_checksum_hex(replica.note_id, exclude_node_id=node_id),
                    'NODE REMOVAL SAFETY CHECK', update_replica=True,
                ):
                    notes_with_survivor.add(replica.note_id)
                else:
                    failed += 1
            if not incomplete:
                failed += len(losing_note_ids - notes_with_survivor)

        # ── thumbnails ─────────────────────────────────────────────────────
        node_thumb_keys = {
            (fid, ttype) for fid, ttype in db.session.query(
                ThumbnailReplica.file_id, ThumbnailReplica.thumb_type
            ).filter(
                ThumbnailReplica.node_id == node_id, ThumbnailReplica.status == 'synced'
            ).distinct().all()
        }
        exclusive_thumb_set = {(fid, ttype) for fid, ttype in exclusive_thumb_keys}
        local_thumb_candidates = {
            (fid, ttype) for fid, ttype in node_thumb_keys | exclusive_thumb_set
            if f'{fid}.{"e2e" if ttype == "e2e" else "jpg"}' in local_thumbs_set
        }
        verified_local_thumbs = set()
        for fid, ttype in local_thumb_candidates:
            checked += 1
            if _local_copy_matches('thumbnails', f'{fid}.{"e2e" if ttype == "e2e" else "jpg"}',
                                   self._tracked_thumbnail_checksum_hex(fid, ttype, exclude_node_id=node_id)):
                verified_local_thumbs.add((fid, ttype))
        failed += len((exclusive_thumb_set & local_thumb_candidates) - verified_local_thumbs)
        losing_thumb_keys = {
            key for key in node_thumb_keys
            if key not in exclusive_thumb_set and key not in verified_local_thumbs
        }
        if losing_thumb_keys:
            thumbs_with_survivor = {
                (fid, ttype) for fid, ttype in db.session.query(
                    ThumbnailReplica.file_id, ThumbnailReplica.thumb_type
                ).filter(
                    ThumbnailReplica.file_id.in_({fid for fid, _ in losing_thumb_keys}),
                    ThumbnailReplica.node_id != node_id,
                    ThumbnailReplica.node_id != local_node_id,
                    ThumbnailReplica.status == 'synced',
                    ThumbnailReplica.checksum.isnot(None),
                    ThumbnailReplica.checksum_verified.isnot(False),
                    db.not_(_stale_clause(ThumbnailReplica)),
                ).distinct().all()
            }
            rows = ThumbnailReplica.query.filter(
                ThumbnailReplica.file_id.in_({fid for fid, _ in losing_thumb_keys}),
                ThumbnailReplica.node_id != node_id,
                ThumbnailReplica.status == 'synced',
                ThumbnailReplica.checksum.isnot(None),
                ThumbnailReplica.checksum_verified.isnot(False),
                _stale_clause(ThumbnailReplica),
            ).order_by(*_order_by_nulls_first_asc(ThumbnailReplica.verified_at)).limit(verify_limit + 1).all()
            if len(rows) > verify_limit:
                incomplete = True
                rows = rows[:verify_limit]
            for replica in rows:
                if (replica.file_id, replica.thumb_type) not in losing_thumb_keys:
                    continue
                if deadline is not None and time.monotonic() > deadline:
                    incomplete = True
                    break
                if replica.node_id == local_node_id:
                    continue
                backend = backends.get(replica.node_id)
                if not backend:
                    incomplete = True
                    continue
                ext = 'e2e' if replica.thumb_type == 'e2e' else 'jpg'
                checked += 1
                if self._verify_remote_replica_payload(
                    replica, backend, 'thumbnails', f'{replica.file_id}.{ext}',
                    self._thumbnail_size_bytes(replica.file_id, replica.thumb_type),
                    self._tracked_thumbnail_checksum_hex(
                        replica.file_id, replica.thumb_type, exclude_node_id=node_id),
                    'NODE REMOVAL SAFETY CHECK', update_replica=True,
                ):
                    thumbs_with_survivor.add((replica.file_id, replica.thumb_type))
                else:
                    failed += 1
            if not incomplete:
                failed += len(losing_thumb_keys - thumbs_with_survivor)

        try:
            db.session.commit()
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[STORAGE] Failed to persist node-removal verification results: {e}')
            incomplete = True

        if failed or incomplete:
            print(f'[STORAGE] [WARNING] Node {node_id} removal redundancy check: {checked} stale '
                  f'evidence row(s) re-verified, {failed} FAILED, incomplete={incomplete}')
        elif checked:
            print(f'[STORAGE] Node {node_id} removal redundancy check: re-verified {checked} '
                  f'stale evidence row(s), all healthy')
        return {
            'verification_performed': True,
            'stale_evidence_checked': checked,
            'stale_evidence_failed': failed,
            'verification_incomplete': incomplete,
        }
