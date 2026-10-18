class _StorageManagerScrub:

    def process_pending_remote_deletes(self):
        """Process queued remote deletions in batches. Called by the background job.
        Deletes files/notes/thumbnails from ALL remote backends, then removes the queue row.
        Failed items are retried with a cooldown and remain visible for operator action
        instead of being silently dropped.

        AUDIT FIX P2-3: the actual backend.delete() network calls run WITHOUT
        holding self._state_lock. Phase A (snapshot the batch + current backend
        set) and Phase C (persist results) run under the lock; the network I/O in
        between does not. Previously the whole loop held the lock across every
        remote delete, so a single slow/offline node could block replication
        finalize, health checks, and admin actions for the entire batch."""
        # ── Phase A (locked): snapshot the work items + current backend set ──
        _now = datetime.now(timezone.utc)
        work = []
        backends_snapshot = {}
        with self._state_lock:
            try:
                batch = PendingRemoteDelete.query.filter(
                    # AUDIT FIX M6: skip parked tombstones (exhausted retries) so
                    # a permanently-failing target cannot churn the LIMIT-100
                    # batch every cycle and starve real deletes. Parked rows stay
                    # for admin visibility; an operator reset re-activates them.
                    PendingRemoteDelete.retry_count < self.DEFERRED_DELETE_MAX_RETRIES,
                    db.or_(
                        PendingRemoteDelete.last_attempt.is_(None),
                        PendingRemoteDelete.last_attempt < _now - self.DEFERRED_DELETE_RETRY_COOLDOWN,
                    )
                ).order_by(PendingRemoteDelete.id).limit(100).all()
                if not batch:
                    return
                self._check_backends_freshness()
                state_backends, _local_backend, state_local_node_id, _version = self._backend_state_snapshot()
                existing_remote_node_ids = {
                    n.id for n in StorageNode.query.all()
                    if n.id != state_local_node_id
                }
                enabled_remote_node_ids = {
                    n.id for n in StorageNode.query.filter_by(is_enabled=True).all()
                    if n.id != state_local_node_id
                }
                # AUDIT FIX (parked tombstones): a target that is merely OFFLINE
                # is not a failing delete, it is a delete that has not been
                # attempted yet. Snapshot node health so Phase C can tell the two
                # apart and stop burning the retry budget on unreachable nodes.
                unreachable_node_ids = {
                    n.id for n in StorageNode.query.filter_by(is_enabled=True).all()
                    if n.id != state_local_node_id and n.status in ('offline', 'error')
                }
                backends_snapshot = state_backends
                drop_ids = []
                normalized_targets = 0
                skipped_claims = 0  # BUG FIX M6: rows claimed by another scheduler owner
                for item in batch:
                    # AUDIT FIX C2/M1: refuse to dispatch any queued delete whose
                    # category/file_id fails strict validation; drop it so it can
                    # never stall the queue forever.
                    try:
                        _validate_storage_args(item.category, item.file_id)
                    except ValueError as _ve:
                        print(f'[STORAGE] Dropping unsafe pending delete {item.id} '
                              f'({item.category}/{item.file_id!r}): {_ve}')
                        drop_ids.append(item.id)
                        continue
                    target_node_ids = self._decode_pending_remote_delete_node_ids(item.target_node_ids)
                    if not target_node_ids:
                        # Legacy/malformed rows may predate persisted targets. Every
                        # extant remote node remains a possible owner, including a
                        # disabled node that cannot be contacted yet.
                        target_node_ids = set(existing_remote_node_ids)
                    if not target_node_ids:
                        drop_ids.append(item.id)
                        continue
                    normalized_json = json.dumps(sorted(target_node_ids))
                    if item.target_node_ids != normalized_json:
                        item.target_node_ids = normalized_json
                        normalized_targets += 1
                    try:
                        deleted_node_ids = self._normalize_pending_remote_delete_node_ids(json.loads(item.deleted_node_ids or '[]'))
                    except Exception:
                        deleted_node_ids = set()
                    # Partition still-needed targets into vanished nodes (the
                    # StorageNode row is gone), disabled nodes that must stay
                    # queued, and enabled nodes we can contact now.
                    vanished = set()
                    waiting_disabled = set()
                    attempt_nodes = []
                    for nid in sorted(target_node_ids):
                        if nid in deleted_node_ids:
                            continue
                        if nid not in existing_remote_node_ids:
                            vanished.add(nid)
                            continue
                        if nid not in enabled_remote_node_ids:
                            waiting_disabled.add(nid)
                            continue
                        attempt_nodes.append(nid)
                    # BUG FIX M6 (scheduler split-brain): claim the tombstone row
                    # atomically BEFORE any Phase-B work, re-using the exact
                    # eligibility predicate the batch SELECT above used. InnoDB
                    # re-evaluates the WHERE on a current read under the row
                    # lock, so if another scheduler owner claimed the row after
                    # our snapshot, rowcount is 0 and we skip it — only ONE
                    # owner ever runs backend.delete() and the Phase-C
                    # retry_count/deleted_node_ids bookkeeping for a tombstone
                    # (no more last-writer-wins progress regression). The claim
                    # writes last_attempt=now, so a row whose owner dies
                    # mid-flight is naturally invisible to the next batch until
                    # the normal retry cooldown expires.
                    _claim = db.session.execute(
                        update(PendingRemoteDelete)
                        .where(
                            PendingRemoteDelete.id == item.id,
                            PendingRemoteDelete.retry_count < self.DEFERRED_DELETE_MAX_RETRIES,
                            db.or_(
                                PendingRemoteDelete.last_attempt.is_(None),
                                PendingRemoteDelete.last_attempt < _now - self.DEFERRED_DELETE_RETRY_COOLDOWN,
                            ),
                        )
                        .values(last_attempt=_now)
                        # The default 'auto' session sync re-evaluates this WHERE
                        # in Python against loaded rows (naive DB datetimes vs the
                        # aware _now) and raises, failing every retried tombstone.
                        .execution_options(synchronize_session=False)
                    )
                    if _claim.rowcount != 1:
                        skipped_claims += 1
                        continue
                    work.append({
                        'id': item.id,
                        'category': item.category,
                        'file_id': item.file_id,
                        'generation': item.generation,
                        'target': set(target_node_ids),
                        'deleted': set(deleted_node_ids),
                        'vanished': vanished,
                        'waiting_disabled': waiting_disabled,
                        'attempt_nodes': attempt_nodes,
                        'unreachable_nodes': set(unreachable_node_ids),
                    })
                if skipped_claims:
                    print(f'[STORAGE] Deferred delete: skipped {skipped_claims} tombstone(s) '
                          f'already claimed by another scheduler owner this cycle')
                processed = 0
                for _id in drop_ids:
                    _row = db.session.get(PendingRemoteDelete, _id)
                    if _row is not None:
                        db.session.delete(_row)
                        processed += 1
                if processed or normalized_targets or work:
                    db.session.commit()
            except Exception as e:
                print(f'[STORAGE] Failed to stage pending remote deletes: {e}')
                try:
                    db.session.rollback()
                except Exception:
                    pass
                return

        # ── Phase B (UNLOCKED): perform the remote delete network I/O ──
        errors = 0
        for entry in work:
            newly_deleted = set(entry['vanished'])
            attempt_error_count = 0
            # AUDIT FIX (parked tombstones): count an UNREACHABLE target
            # separately from a genuine delete failure. retry_count used to be
            # incremented on every cycle whenever attempt_nodes was non-empty --
            # including when the only obstacle was a node that was simply offline
            # -- so an outage lasting DEFERRED_DELETE_MAX_RETRIES (50) cycles
            # permanently parked the tombstone and the deleted objects stayed on
            # that node forever.
            attempt_unreachable_count = 0
            attempt_deferred_count = 0
            disk_id = self._inflight_remote_disk_id(entry['category'], entry['file_id'])
            _unreachable = entry.get('unreachable_nodes', set())
            for nid in entry['vanished']:
                print(f'[STORAGE] Deferred delete target node {nid} no longer exists; '
                      f"marking impossible for {entry['category']}/{entry['file_id']}")
            for nid in sorted(entry.get('waiting_disabled', set())):
                print(f'[STORAGE] Deferred delete waiting for disabled node {nid} '
                      f"for {entry['category']}/{entry['file_id']}")
            # AUDIT FIX H4: a tombstone outlives the row it deleted. If a live
            # row now exists under the same key but with a DIFFERENT generation
            # marker (re-created object, DB restore, regenerated thumbnail), the
            # tombstone is stale: blindly deleting would destroy the new
            # generation's remote copies (which then re-replicate as 'synced',
            # leaving the scrub's 7-day reverify floor to self-heal very slowly).
            # Drop the stale tombstone instead of deleting. NULL generation =
            # legacy tombstone: keep the old delete-anyway behavior, logged.
            if not entry.get('generation'):
                print(f'[STORAGE] Deferred delete for {entry["category"]}/{entry["file_id"]} '
                      f'has no generation marker (legacy tombstone); deleting without a re-creation check')
            else:
                _stale = False
                try:
                    with db.session.no_autoflush:
                        _live = self._current_delete_generation(entry['category'], entry['file_id'])
                    if _live is not None and _live != entry['generation']:
                        _stale = True
                except Exception as _gen_err:
                    # AUDIT FIX (finding 9): a generation-lookup ERROR used to
                    # fail open ('proceeding with delete') — an unknown DB
                    # state authorised deleting remote bytes, which could
                    # destroy a re-created object's only copies. Fail closed:
                    # defer this cycle without burning retry budget; the next
                    # cycle re-checks with a healthy DB.
                    print(f'[STORAGE] Generation check failed for {entry["category"]}/{entry["file_id"]}; '
                          f'DEFERRING remote delete this cycle (fail-closed): {_gen_err}')
                    entry['generation_check_failed'] = True
                    entry['newly_deleted'] = set()
                    entry['attempt_error_count'] = 0
                    entry['attempt_unreachable_count'] = 0
                    continue
                if _stale:
                    print(f'[STORAGE] AUDIT FIX H4: skipping deferred delete for '
                          f"{entry['category']}/{entry['file_id']}: live row generation differs from the "
                          f'tombstone (object re-created after delete); dropping stale tombstone')
                    entry['stale_tombstone'] = True
                    entry['newly_deleted'] = set()
                    entry['attempt_error_count'] = 0
                    entry['attempt_unreachable_count'] = 0
                    continue
            for nid in entry['attempt_nodes']:
                backend = backends_snapshot.get(nid)
                if not backend:
                    errors += 1
                    attempt_unreachable_count += 1
                    print(f'[STORAGE] Deferred delete waiting for unavailable node {nid} '
                          f"for {entry['category']}/{entry['file_id']}")
                    continue
                acquired = False
                try:
                    acquired = self._try_acquire_inflight_write(entry['category'], disk_id, nid)
                    if not acquired:
                        attempt_deferred_count += 1
                        continue
                    backend.delete(entry['category'], entry['file_id'])
                    newly_deleted.add(nid)
                except Exception as e:
                    print(f'[STORAGE] Deferred delete failed on node {nid} '
                          f"for {entry['category']}/{entry['file_id']}: {e}")
                    errors += 1
                    if nid in _unreachable:
                        attempt_unreachable_count += 1
                    else:
                        attempt_error_count += 1
                finally:
                    if acquired:
                        self._release_inflight_write(entry['category'], disk_id, nid)
            entry['newly_deleted'] = newly_deleted
            entry['attempt_error_count'] = attempt_error_count
            entry['attempt_unreachable_count'] = attempt_unreachable_count
            entry['attempt_deferred_count'] = attempt_deferred_count

        # ── Phase C (locked): persist results ──
        with self._state_lock:
            processed = 0
            queued = 0
            warned = 0
            try:
                _now2 = datetime.now(timezone.utc)
                for entry in work:
                    item = db.session.get(PendingRemoteDelete, entry['id'])
                    if item is None:
                        continue  # removed concurrently — nothing to persist
                    if entry.get('stale_tombstone'):
                        # AUDIT FIX H4: the target object was re-created under
                        # the same storage key after this tombstone was queued;
                        # drop the stale tombstone without touching the new
                        # generation's remote copies.
                        db.session.delete(item)
                        processed += 1
                        continue
                    deleted_node_ids = entry['deleted'] | entry.get('newly_deleted', set())
                    item.deleted_node_ids = json.dumps(sorted(deleted_node_ids))
                    if entry['target'].issubset(deleted_node_ids):
                        db.session.delete(item)
                        processed += 1
                        continue
                    item.last_attempt = _now2
                    queued += 1
                    if entry.get('generation_check_failed'):
                        # AUDIT FIX (finding 9): the cycle was deferred because
                        # the generation lookup errored, not because a delete
                        # failed — keep it queued without burning retry budget.
                        print(f'[STORAGE] Deferred delete for {item.category}/{item.file_id} deferred '
                              f'without penalty: generation lookup unavailable this cycle')
                        continue
                    waiting_only = bool(entry.get('waiting_disabled')) and entry.get('attempt_error_count', 0) == 0 and not entry['attempt_nodes']
                    if waiting_only:
                        continue
                    # AUDIT FIX (parked tombstones): an outage is not a failed
                    # delete attempt. If nothing succeeded but every obstacle was
                    # an unreachable/offline node, keep the tombstone queued
                    # WITHOUT burning retry budget -- otherwise a node that was
                    # never disabled but merely offline for ~4 hours (50 cycles x
                    # the 5-minute cooldown) parked its tombstones permanently and
                    # the deleted objects were never reclaimed.
                    if (entry.get('attempt_error_count', 0) == 0
                            and (entry.get('attempt_unreachable_count', 0) > 0
                                 or entry.get('attempt_deferred_count', 0) > 0)):
                        print(f'[STORAGE] Deferred delete for {item.category}/{item.file_id} deferred '
                              f'without penalty: target node(s) unreachable or busy this cycle')
                        continue
                    item.retry_count = (item.retry_count or 0) + 1
                    if item.retry_count >= self.DEFERRED_DELETE_MAX_RETRIES:
                        # AUDIT FIX M6: terminal park — stop re-attempting this
                        # tombstone (it is excluded from future batches) but keep
                        # the row for operator action.
                        warned += 1
                        print(
                            f'[STORAGE] [WARNING] Deferred delete PARKED for {item.category}/{item.file_id} '
                            f'after {item.retry_count} failed attempts; no longer retried automatically — '
                            f'fix the target node and run admin remote-cleanup / reset to re-activate'
                        )
                    elif item.retry_count == self.DEFERRED_DELETE_WARN_RETRIES:
                        warned += 1
                        print(
                            f'[STORAGE] Deferred delete backlog warning for {item.category}/{item.file_id}: '
                            f'{item.retry_count} failed attempts; keeping it queued until remote cleanup succeeds'
                        )
                    elif item.retry_count > self.DEFERRED_DELETE_WARN_RETRIES and item.retry_count % 5 == 0:
                        print(
                            f'[STORAGE] Deferred delete still pending for {item.category}/{item.file_id} '
                            f'after {item.retry_count} failed attempts'
                        )
                db.session.commit()
                if processed > 0 or queued > 0 or warned > 0:
                    print(
                        f'[STORAGE] Processed {processed} deferred remote deletes '
                        f'({errors} backend errors, {queued} still queued)'
                    )
            except Exception as e:
                print(f'[STORAGE] Failed to persist pending remote deletes: {e}')
                try:
                    db.session.rollback()
                except Exception:
                    pass

    def reset_failed_replication_state(self, exhausted_only=False, include_deferred_deletes=True):
        """Reset failed replica state so replication can resume after an operator fix."""
        with self._state_lock:
            counts = {
                'files': 0,
                'notes': 0,
                'thumbnails': 0,
                'deferred_deletes': 0,
            }

            def _reset_query(query, category_name):
                rows = query.all()
                for row in rows:
                    row.status = 'pending'
                    row.error_count = 0
                    row.last_error = None
                    row.verified_at = None
                counts[category_name] = len(rows)

            file_query = FileReplica.query.filter_by(status='error')
            note_query = NoteReplica.query.filter_by(status='error')
            thumb_query = ThumbnailReplica.query.filter_by(status='error')
            if exhausted_only:
                file_query = file_query.filter(FileReplica.error_count >= self.MAX_ERROR_RETRIES)
                note_query = note_query.filter(NoteReplica.error_count >= self.MAX_ERROR_RETRIES)
                thumb_query = thumb_query.filter(ThumbnailReplica.error_count >= self.MAX_ERROR_RETRIES)

            _reset_query(file_query, 'files')
            _reset_query(note_query, 'notes')
            _reset_query(thumb_query, 'thumbnails')

            if include_deferred_deletes:
                delete_query = PendingRemoteDelete.query
                if exhausted_only:
                    delete_query = delete_query.filter(PendingRemoteDelete.retry_count >= self.DEFERRED_DELETE_WARN_RETRIES)
                delete_rows = delete_query.all()
                for row in delete_rows:
                    row.retry_count = 0
                    row.last_attempt = None
                counts['deferred_deletes'] = len(delete_rows)

            db.session.commit()
            return counts

    def run_integrity_scrub(self, max_items=100, max_checksum_items=10, max_deep_verify_items=2, max_seconds=0, min_reverify_age_seconds=0):
        # AUDIT FIX (scrub lock release): previously this wrapped the ENTIRE
        # scrub in `with self._state_lock`, holding the lock across every remote
        # network probe (SSH connect up to 120s, remote sha256sum up to 300s per
        # file, S3 head_object). On a slow/unreachable backup node a single pass
        # could freeze the replication cycle, deferred deletes, health checks and
        # admin add/remove-node for minutes. The scrub now mirrors the 3-phase
        # lock-release pattern used by run_replication_cycle / health_check_all:
        #   Phase A (locked)   -- snapshot the replica batch + expected values
        #   Phase B (UNLOCKED) -- run all remote/local probes (the slow part)
        #   Phase C (locked)   -- apply verdicts with concurrency-safe conditional
        #                         UPDATEs (skip rows a concurrent writer moved out
        #                         of 'synced'), self-heal notes, then commit.
        return self._run_integrity_scrub_locked(
            max_items=max_items, max_checksum_items=max_checksum_items,
            max_deep_verify_items=max_deep_verify_items, max_seconds=max_seconds,
            min_reverify_age_seconds=min_reverify_age_seconds)

    def _scrub_persist(self, model, replica, values):
        """Apply a scrub verdict to a replica with a concurrency-safe conditional
        UPDATE: the write only lands while the row is still 'synced'. During the
        unlocked probe phase a concurrent HTTP-path re-upload may have reset the
        remote replica to 'pending' (or a delete may have removed it); in that
        case we must NOT clobber the fresher state with a stale verdict. Returns
        True if the row was updated. `values` maps model attribute NAMES to new
        values."""
        rid = getattr(replica, 'id', None)
        if rid is None:
            return False
        try:
            update_cols = {getattr(model, k): v for k, v in values.items()}
            rows = db.session.query(model).filter(
                model.id == rid,
                model.status == 'synced',
            ).update(update_cols, synchronize_session=False)
            db.session.commit()
            return bool(rows)
        except Exception as e:
            print(f'[SCRUB] Failed to persist verdict for {model.__name__} {rid}: {e}')
            try:
                db.session.rollback()
            except Exception:
                pass
            return False

    def _run_integrity_scrub_locked(self, max_items=100, max_checksum_items=10, max_deep_verify_items=2, max_seconds=0, min_reverify_age_seconds=0):
        """3-phase integrity scrub (method name retained for the regression
        suite). Audits synced REMOTE and LOCAL replicas for existence/size/
        checksum drift. Phase A snapshots the batch under self._state_lock,
        Phase B performs the slow probes WITHOUT the lock, and Phase C applies
        verdicts under the lock using concurrency-safe conditional UPDATEs.

        Any mismatch is marked 'error' so the normal replication loop heals it;
        notes self-heal from the local authoritative copy before being errored.

        The local-replica audit detects local disk corruption (bit rot, partial
        writes) by comparing the local copy against remote sibling sizes and the
        canonical checksum. Without it, corrupted local data would become the
        "source of truth" and silently propagate to every remote node."""
        audited = 0
        corrupted = 0
        metadata_fixed = 0
        checksum_verified = 0
        local_audited = 0
        note_self_healed = 0
        # AUDIT FIX F-1 (5th audit): bounded "deep verify" budget. Mutable list so
        # the unlocked Phase-B probe loop can decrement it. Counts how many
        # checksum-incapable remote objects (SSH without sha256sum / S3 multipart
        # composite checksum) are downloaded-back and re-hashed this pass.
        deep_verify_budget = [max(0, int(max_deep_verify_items or 0))]
        deep_verified = 0
        checksum_enabled = self._is_checksum_enabled()

        # S3 COST FIX: optional re-verification floor. When >0, replicas whose
        # verified_at is newer than this many seconds are skipped this pass, so a
        # healthy object is not re-probed (a billable S3 head_object each) every
        # 15 min forever. A replica that has never been verified (verified_at IS
        # NULL) is always eligible, so freshly-synced data is still checked
        # promptly. 0 = no floor (every synced replica is eligible — the original
        # behavior, which the unit tests exercise via direct calls).
        _reverify_cutoff = None
        if min_reverify_age_seconds and int(min_reverify_age_seconds) > 0:
            _reverify_cutoff = datetime.now(timezone.utc) - timedelta(seconds=int(min_reverify_age_seconds))

        def _reverify_clause(model):
            if _reverify_cutoff is None:
                return db.true()
            return db.or_(model.verified_at.is_(None), model.verified_at < _reverify_cutoff)

        _replica_models = {
            'files': FileReplica,
            'notes': NoteReplica,
            'thumbnails': ThumbnailReplica,
        }

        # ─────────────────────────── Phase A (locked) ───────────────────────────
        # Snapshot the replica batch and compute the currently-authoritative
        # expected size/checksum/version for each, plus a per-category checksum
        # budget assignment. No network I/O here.
        work = []
        self._state_lock.acquire()
        try:
            try:
                self._check_backends_freshness()
            except Exception:
                pass
            backends, _local_backend, local_node_id, _version = self._backend_state_snapshot()

            _file_size_cache = {}
            _file_checksum_cache = {}
            _thumb_size_cache = {}

            def _expected_file_size(file_id, exclude_node_id):
                key = (file_id, exclude_node_id)
                if key not in _file_size_cache:
                    _file_size_cache[key] = self._tracked_file_size_bytes(
                        file_id, exclude_node_id=exclude_node_id)
                return _file_size_cache[key]

            def _expected_file_checksum(file_id, exclude_node_id):
                key = (file_id, exclude_node_id)
                if key not in _file_checksum_cache:
                    _file_checksum_cache[key] = self._tracked_file_checksum_hex(
                        file_id, exclude_node_id=exclude_node_id)
                return _file_checksum_cache[key]

            def _expected_thumb_size(file_id, thumb_type):
                key = (file_id, thumb_type)
                if key not in _thumb_size_cache:
                    _thumb_size_cache[key] = self._thumbnail_size_bytes(file_id, thumb_type)
                return _thumb_size_cache[key]

            # AUDIT FIX P1-6: split the checksum budget per category so one
            # category cannot starve the others (mutable lists so closures can
            # decrement the local budgets).
            _total_checksum_budget = max(0, int(max_checksum_items or 0))
            # AUDIT FIX F-3 (5th audit): give each LOCAL category its own budget
            # instead of one shared bucket. Previously all three local categories
            # shared a single budget while each remote category got a full one, so
            # local bit-rot checksum coverage ran at ~1/3 the rate of any single
            # remote category. There are now 6 independent buckets (3 remote + 3
            # local); the total still stays bounded by integrity_scrub_checksum_batch_size.
            _base_budget, _remainder = divmod(_total_checksum_budget, 6)
            _category_budgets = [
                _base_budget + (1 if index < _remainder else 0)
                for index in range(6)
            ]
            file_csum_budget, note_csum_budget, thumb_csum_budget = _category_budgets[:3]
            local_file_csum_budget = [_category_budgets[3]]
            local_note_csum_budget = [_category_budgets[4]]
            local_thumb_csum_budget = [_category_budgets[5]]

            # ---- remote files ----
            for r in FileReplica.query.filter(
                FileReplica.status == 'synced',
                FileReplica.node_id != local_node_id,
                _reverify_clause(FileReplica),
            ).order_by(*_order_by_nulls_first_asc(FileReplica.verified_at), db.func.rand()).limit(max_items).all():
                backend = backends.get(r.node_id)
                if not backend:
                    continue
                exp_sum = _expected_file_checksum(r.file_id, r.node_id) if checksum_enabled else None
                want_csum = bool(checksum_enabled and exp_sum and file_csum_budget > 0
                                 and hasattr(backend, 'checksum'))
                if want_csum:
                    file_csum_budget -= 1
                work.append({
                    'kind': 'remote_file', 'replica': r, 'node_id': r.node_id,
                    'backend': backend, 'cat': 'files',
                    'disk_id': f'{r.file_id}.enc', 'resource_id': r.file_id,
                    'cur_size': r.size_bytes, 'cur_checksum': r.checksum,
                    'exp_size': _expected_file_size(r.file_id, r.node_id),
                    'exp_checksum': exp_sum, 'want_csum': want_csum,
                    'deep_verify_eligible': bool(want_csum and hasattr(backend, 'get')),
                })

            # ---- remote notes ----
            for r in NoteReplica.query.filter(
                NoteReplica.status == 'synced',
                NoteReplica.node_id != local_node_id,
                _reverify_clause(NoteReplica),
            ).order_by(*_order_by_nulls_first_asc(NoteReplica.verified_at), db.func.rand()).limit(max_items).all():
                backend = backends.get(r.node_id)
                if not backend:
                    continue
                note_obj = db.session.get(Note, r.note_id)
                if not note_obj:
                    continue
                note_version = int(note_obj.content_version or 1)
                exp_sum = note_obj.content_checksum or self._tracked_note_checksum_hex(
                    r.note_id, exclude_node_id=r.node_id)
                # DB-only prechecks (version / recorded checksum) -- no network.
                precheck_bad = (
                    (r.synced_version or 0) != note_version
                    or (r.target_version or 0) not in (0, note_version)
                    or bool(exp_sum and r.checksum != exp_sum)
                )
                want_csum = bool(checksum_enabled and not precheck_bad and exp_sum
                                 and note_csum_budget > 0 and hasattr(backend, 'checksum'))
                if want_csum:
                    note_csum_budget -= 1
                work.append({
                    'kind': 'remote_note', 'replica': r, 'node_id': r.node_id,
                    'backend': backend, 'cat': 'notes',
                    'disk_id': r.note_id, 'resource_id': r.note_id,
                    'note_version': note_version, 'note_size': note_obj.size,
                    'cur_checksum': r.checksum, 'exp_checksum': exp_sum,
                    'precheck_bad': precheck_bad, 'want_csum': want_csum,
                    'deep_verify_eligible': bool(want_csum and hasattr(backend, 'get')),
                })

            # ---- remote thumbnails ----
            for r in ThumbnailReplica.query.filter(
                ThumbnailReplica.status == 'synced',
                ThumbnailReplica.node_id != local_node_id,
                _reverify_clause(ThumbnailReplica),
            ).order_by(*_order_by_nulls_first_asc(ThumbnailReplica.verified_at), db.func.rand()).limit(max_items).all():
                backend = backends.get(r.node_id)
                if not backend:
                    continue
                ttype = 'e2e' if r.thumb_type == 'e2e' else 'jpg'
                exp_sum = (self._tracked_thumbnail_checksum_hex(r.file_id, r.thumb_type, exclude_node_id=r.node_id)
                           if checksum_enabled else None)
                want_csum = bool(checksum_enabled and exp_sum and thumb_csum_budget > 0
                                 and hasattr(backend, 'checksum'))
                if want_csum:
                    thumb_csum_budget -= 1
                work.append({
                    'kind': 'remote_thumb', 'replica': r, 'node_id': r.node_id,
                    'backend': backend, 'cat': 'thumbnails',
                    'disk_id': f'{r.file_id}.{ttype}', 'resource_id': r.file_id,
                    'thumb_type': r.thumb_type,
                    'cur_size': r.size_bytes, 'cur_checksum': r.checksum,
                    'exp_size': _expected_thumb_size(r.file_id, r.thumb_type),
                    'exp_checksum': exp_sum, 'want_csum': want_csum,
                    'deep_verify_eligible': bool(want_csum and hasattr(backend, 'get')),
                })

            # ---- local replicas (detect local bit-rot) ----
            if local_node_id:
                for r in FileReplica.query.filter_by(
                    node_id=local_node_id, status='synced',
                ).filter(_reverify_clause(FileReplica)).order_by(*_order_by_nulls_first_asc(FileReplica.verified_at), db.func.rand()).limit(max_items).all():
                    exp_sum = _expected_file_checksum(r.file_id, local_node_id) if checksum_enabled else None
                    want_csum = bool(checksum_enabled and exp_sum and local_file_csum_budget[0] > 0)
                    if want_csum:
                        local_file_csum_budget[0] -= 1
                    sib = FileReplica.query.filter(
                        FileReplica.file_id == r.file_id,
                        FileReplica.status == 'synced',
                        FileReplica.node_id != local_node_id,
                        FileReplica.size_bytes.isnot(None),
                    ).order_by(FileReplica.verified_at.desc()).first()
                    # AUDIT FIX (M1 local size coverage): capture the DB-authoritative
                    # File.disk_size as a fallback expected size. With no remote
                    # sibling (single-node deployment) the size check previously had
                    # no reference and silently skipped, so a truncated local copy
                    # went undetected by the scrub unless a stored checksum existed.
                    # File.disk_size is authoritative (never derived from the local
                    # bytes — see _update_file_disk_metadata_from_local / P0-1), so
                    # comparing against it cannot turn into a compare-against-self.
                    _lf = db.session.get(File, r.file_id)
                    _db_size = int(_lf.disk_size) if _lf and _lf.disk_size is not None else None
                    work.append({
                        'kind': 'local_file', 'replica': r, 'node_id': local_node_id,
                        'cat': 'files',
                        'disk_id': f'{r.file_id}.enc', 'resource_id': r.file_id,
                        'cur_size': r.size_bytes, 'cur_checksum': r.checksum,
                        'sibling_size': int(sib.size_bytes) if sib and sib.size_bytes is not None else None,
                        'db_size': _db_size,
                        'exp_checksum': exp_sum, 'want_csum': want_csum,
                    })

                for r in NoteReplica.query.filter_by(
                    node_id=local_node_id, status='synced',
                ).filter(_reverify_clause(NoteReplica)).order_by(*_order_by_nulls_first_asc(NoteReplica.verified_at), db.func.rand()).limit(max_items).all():
                    note_obj = db.session.get(Note, r.note_id)
                    note_version = int(note_obj.content_version or 1) if note_obj else 1
                    exp_sum = note_obj.content_checksum if note_obj else None
                    precheck_bad = (
                        (r.synced_version or 0) != note_version
                        or (r.target_version or 0) not in (0, note_version)
                    )
                    want_csum = bool(checksum_enabled and not precheck_bad and exp_sum and local_note_csum_budget[0] > 0)
                    if want_csum:
                        local_note_csum_budget[0] -= 1
                    work.append({
                        'kind': 'local_note', 'replica': r, 'node_id': local_node_id,
                        'cat': 'notes',
                        'disk_id': r.note_id, 'resource_id': r.note_id,
                        'note_version': note_version, 'note_size': note_obj.size if note_obj else None,
                        'cur_checksum': r.checksum, 'exp_checksum': exp_sum,
                        'precheck_bad': precheck_bad, 'want_csum': want_csum,
                    })

                for r in ThumbnailReplica.query.filter_by(
                    node_id=local_node_id, status='synced',
                ).filter(_reverify_clause(ThumbnailReplica)).order_by(*_order_by_nulls_first_asc(ThumbnailReplica.verified_at), db.func.rand()).limit(max_items).all():
                    ttype = 'e2e' if r.thumb_type == 'e2e' else 'jpg'
                    exp_sum = (self._tracked_thumbnail_checksum_hex(r.file_id, r.thumb_type, exclude_node_id=local_node_id)
                               if checksum_enabled else None)
                    want_csum = bool(checksum_enabled and exp_sum and local_thumb_csum_budget[0] > 0)
                    if want_csum:
                        local_thumb_csum_budget[0] -= 1
                    sib = ThumbnailReplica.query.filter(
                        ThumbnailReplica.file_id == r.file_id,
                        ThumbnailReplica.thumb_type == r.thumb_type,
                        ThumbnailReplica.status == 'synced',
                        ThumbnailReplica.node_id != local_node_id,
                        ThumbnailReplica.size_bytes.isnot(None),
                    ).order_by(ThumbnailReplica.verified_at.desc()).first()
                    work.append({
                        'kind': 'local_thumb', 'replica': r, 'node_id': local_node_id,
                        'cat': 'thumbnails',
                        'disk_id': f'{r.file_id}.{ttype}', 'resource_id': r.file_id,
                        'thumb_type': r.thumb_type,
                        'cur_size': r.size_bytes, 'cur_checksum': r.checksum,
                        'sibling_size': int(sib.size_bytes) if sib and sib.size_bytes is not None else None,
                        'exp_checksum': exp_sum, 'want_csum': want_csum,
                    })
        except Exception as e:
            print(f'[SCRUB] Integrity scrub setup failed: {e}')
            try:
                db.session.rollback()
            except Exception:
                pass
            work = []
        finally:
            try:
                self._state_lock.release()
            except RuntimeError:
                pass

        # ─────────────────────────── Phase B (UNLOCKED) ─────────────────────────
        # All remote/local probes happen here WITHOUT holding self._state_lock,
        # so slow/unreachable nodes cannot freeze replication / deletes / health
        # checks / admin node ops.
        # AUDIT FIX M8: enforce an optional wall-clock budget. Previously Phase B
        # had NO aggregate deadline, so a slow/large backend could make a single
        # scrub pass run for many minutes. With the scrub now on its own
        # scheduler job this no longer starves health checks, but a deadline
        # still bounds the pass so verdicts are committed promptly and the next
        # pass resumes from the oldest-verified rows. Items not reached this pass
        # are simply left untouched (their verified_at stays older, so the
        # nulls-first ordering picks them up next pass).
        _scrub_deadline = (time.monotonic() + max_seconds) if max_seconds and max_seconds > 0 else None
        _scrub_budget_hit = False
        local_backend = self._local_backend
        for item in work:
            if _scrub_deadline is not None and time.monotonic() > _scrub_deadline:
                if not _scrub_budget_hit:
                    _scrub_budget_hit = True
                    print(f'[SCRUB] Time budget ({max_seconds}s) reached — committing verdicts '
                          f'gathered so far; remaining replicas will be checked next pass')
                # Mark the rest as not-probed so Phase C leaves them untouched.
                item['probe_error'] = None
                item['p_exists'] = None
                item['_skipped_budget'] = True
                continue
            kind = item['kind']
            item['probe_error'] = None
            item['p_exists'] = None
            item['p_size'] = None
            item['p_checksum'] = None
            try:
                if kind.startswith('remote_'):
                    backend = item['backend']
                    cat = item['cat']
                    _want_csum = bool(item.get('want_csum') and hasattr(backend, 'checksum'))
                    # S3 COST FIX: for the S3 backend, fetch existence + size +
                    # checksum from ONE head_object (via stat()) instead of the
                    # previous 2-3 separate HEAD requests (exists_verified + size
                    # + checksum). Identical verification coverage, ~2-3x fewer S3
                    # HEAD calls per replica per scrub pass. Gated on the concrete
                    # type (not hasattr) so duck-typed test mocks still exercise
                    # the per-method path.
                    _use_stat = isinstance(backend, _S3Backend)
                    if _use_stat:
                        _st = backend.stat(cat, item['disk_id'], want_checksum=_want_csum)
                        item['p_exists'] = _st.get('exists')
                        if item['p_exists']:
                            item['p_size'] = _st.get('size')
                            if _want_csum:
                                item['p_checksum'] = _st.get('checksum')
                    elif hasattr(backend, 'exists_verified'):
                        item['p_exists'] = backend.exists_verified(cat, item['disk_id'])
                    else:
                        item['p_exists'] = backend.exists(cat, item['disk_id'])
                    if item['p_exists']:
                        if not _use_stat:
                            item['p_size'] = backend.size(cat, item['disk_id'])
                            if _want_csum:
                                item['p_checksum'] = backend.checksum(cat, item['disk_id'])
                        # AUDIT FIX F-1 (5th audit): throttled deep verify. When we
                        # WANTED a checksum but the backend could not produce one
                        # (SSH node without sha256sum/shasum, or an S3 multipart
                        # object whose ChecksumSHA256 is a composite "-" value),
                        # length-preserving corruption would otherwise be invisible
                        # to the scrub forever. For a bounded number of such objects
                        # per pass, download the bytes and re-hash locally so the
                        # Phase-C verdict can compare against the authoritative
                        # checksum. Skip when the size already mismatches (Phase C
                        # flags that without spending bandwidth) or the object is
                        # absent.
                        if (item['p_checksum'] is None and item.get('deep_verify_eligible')
                                and item.get('exp_checksum') and deep_verify_budget[0] > 0
                                and hasattr(backend, 'get')):
                            _dv_exp_size = item.get('exp_size')
                            if _dv_exp_size is None:
                                _dv_exp_size = item.get('note_size')
                            _dv_size_ok = (
                                _dv_exp_size is None or item.get('p_size') is None
                                or int(item['p_size']) == int(_dv_exp_size)
                            )
                            if _dv_size_ok:
                                _dv_tmp = None
                                try:
                                    _dv_dir = (self._app.config['UPLOAD_FOLDER'] if cat == 'files'
                                               else NOTES_DIR if cat == 'notes' else THUMBNAILS_DIR)
                                    _dv_fd, _dv_tmp = tempfile.mkstemp(prefix='.scrub_dv_', dir=_dv_dir)
                                    os.close(_dv_fd)
                                    # The budget caps egress, so a failed download spends it too.
                                    deep_verify_budget[0] -= 1
                                    backend.get(cat, item['disk_id'], _dv_tmp)
                                    item['p_checksum'] = self._sha256_file(_dv_tmp)
                                    item['deep_verified'] = True
                                    deep_verified += 1
                                except Exception as _dv_err:
                                    print(f'[SCRUB] Deep verify download failed for {cat}/{item["disk_id"]} '
                                          f'on node {item["node_id"]}: {_dv_err}')
                                finally:
                                    if _dv_tmp:
                                        try:
                                            os.remove(_dv_tmp)
                                        except OSError:
                                            pass
                else:
                    cat = item['cat']
                    path = local_backend.get_path(cat, item['disk_id']) if local_backend else None
                    if not path or not os.path.isfile(path):
                        item['p_exists'] = False
                    else:
                        item['p_exists'] = True
                        item['p_size'] = os.path.getsize(path)
                        if item.get('want_csum'):
                            item['p_checksum'] = self._sha256_file(path)
            except Exception as e:
                item['probe_error'] = e

        # ─────────────────────────── Phase C (locked) ───────────────────────────
        self._state_lock.acquire()
        try:
            _now = datetime.now(timezone.utc)
            _healed_note_ids = set()

            def _mark_error(item, model, label, reason):
                nonlocal corrupted
                # AUDIT FIX F3: do NOT increment error_count here -- corruption
                # detection is not a failed delivery attempt. The conditional
                # UPDATE also guarantees we never clobber a row a concurrent
                # re-upload already moved to 'pending' during the probe window.
                if self._scrub_persist(model, item['replica'], {'status': 'error', 'last_error': reason[:500]}):
                    print(f'[SCRUB] {label}: {reason}')
                    corrupted += 1

            def _heal_note(item, model, label, reason):
                """Self-heal a drifted note from the local authoritative copy
                before erroring it. Returns True (always handled)."""
                nonlocal metadata_fixed, note_self_healed
                nid = item['resource_id']
                repaired = self.reconcile_note_to_local(nid, verified_at=_now)
                if repaired:
                    # Reconciliation only stages ORM mutations. Commit before
                    # claiming a heal so the final work item cannot roll back.
                    db.session.commit()
                    if repaired.get('size_changed'):
                        metadata_fixed += 1
                    if nid not in _healed_note_ids:
                        _healed_note_ids.add(nid)
                        note_self_healed += 1
                    return True
                _mark_error(item, model, label, reason)
                return True

            for item in work:
                kind = item['kind']
                model = (_replica_models['files'] if 'file' in kind else
                         _replica_models['notes'] if 'note' in kind else
                         _replica_models['thumbnails'])
                try:
                    if item.get('_skipped_budget'):
                        # AUDIT FIX M8: this replica was not probed because the
                        # Phase B time budget elapsed. Leave it completely
                        # untouched (do NOT treat the absent probe as "missing")
                        # so the next pass picks it up via the nulls-first order.
                        continue
                    if item.get('probe_error') is not None:
                        # Probe raised (e.g. node unreachable mid-cycle) -- leave
                        # the replica as-is; health checks and the next cycle
                        # handle node availability. Do not penalize a healthy
                        # replica for a transient connectivity blip.
                        print(f'[SCRUB] Probe error for {kind} {item["disk_id"]} on node {item["node_id"]}: {item["probe_error"]}')
                        continue

                    # ===== FILE (remote or local) =====
                    if kind in ('remote_file', 'local_file'):
                        if not item.get('p_exists'):
                            label = 'MISSING LOCAL FILE' if kind == 'local_file' else 'MISSING FILE REPLICA'
                            _mark_error(item, model, label, f'{item["resource_id"]} on node {item["node_id"]}')
                            continue
                        # AUDIT FIX (M1 local size coverage): for the local-file
                        # audit, prefer a verified remote sibling's size but fall
                        # back to the DB-authoritative File.disk_size so single-node
                        # local truncation is detected (mirrors the read path's
                        # _verify_local_file_integrity size check).
                        if kind == 'local_file':
                            exp_size = item.get('sibling_size')
                            if exp_size is None:
                                exp_size = item.get('db_size')
                        else:
                            exp_size = item.get('exp_size')
                        p_size = item.get('p_size')
                        if exp_size is not None and p_size is None:
                            print(f'[SCRUB] File size probe indeterminate for {item["disk_id"]} on node {item["node_id"]}')
                            continue
                        if exp_size is not None and p_size is not None and int(p_size) != int(exp_size):
                            label = 'LOCAL FILE SIZE MISMATCH' if kind == 'local_file' else 'FILE SIZE MISMATCH'
                            _mark_error(item, model, label,
                                        f'{item["resource_id"]} on node {item["node_id"]} expected {exp_size} bytes, got {p_size}')
                            continue
                        if item.get('want_csum') and item.get('p_checksum') and item.get('exp_checksum'):
                            if item['p_checksum'] != item['exp_checksum']:
                                label = 'LOCAL FILE CHECKSUM MISMATCH' if kind == 'local_file' else 'FILE CHECKSUM MISMATCH'
                                _mark_error(item, model, label,
                                            f'{item["resource_id"]} on node {item["node_id"]} expected {item["exp_checksum"][:16]}..., got {item["p_checksum"][:16]}...')
                                continue
                            checksum_verified += 1
                        vals = {'verified_at': _now}
                        if p_size is not None and (item.get('cur_size') is None or int(item['cur_size']) != int(p_size)):
                            vals['size_bytes'] = int(p_size)
                            metadata_fixed += 1
                        if item.get('p_checksum') and item.get('cur_checksum') != item['p_checksum']:
                            vals['checksum'] = item['p_checksum']
                            metadata_fixed += 1
                        # AUDIT FIX (size-only replicas excluded from failover):
                        # the scrub is where an unverified replica EARNS its trust.
                        # A hash we computed/read for this object and matched
                        # against the authoritative value promotes the row to
                        # checksum_verified=True, so it becomes usable as evidence
                        # for destructive redundancy decisions.
                        if item.get('want_csum') and item.get('p_checksum') and item.get('exp_checksum'):
                            vals['checksum_verified'] = True
                        if self._scrub_persist(model, item['replica'], vals):
                            audited += 1
                            if kind == 'local_file':
                                local_audited += 1
                        continue

                    # ===== THUMBNAIL (remote or local) =====
                    if kind in ('remote_thumb', 'local_thumb'):
                        if not item.get('p_exists'):
                            label = 'MISSING LOCAL THUMBNAIL' if kind == 'local_thumb' else 'MISSING THUMBNAIL REPLICA'
                            _mark_error(item, model, label, f'{item["disk_id"]} on node {item["node_id"]}')
                            continue
                        exp_size = item.get('sibling_size') if kind == 'local_thumb' else item.get('exp_size')
                        p_size = item.get('p_size')
                        if exp_size is not None and p_size is None:
                            print(f'[SCRUB] Thumbnail size probe indeterminate for {item["disk_id"]} on node {item["node_id"]}')
                            continue
                        if exp_size is not None and p_size is not None and int(p_size) != int(exp_size):
                            label = 'LOCAL THUMBNAIL SIZE MISMATCH' if kind == 'local_thumb' else 'THUMBNAIL SIZE MISMATCH'
                            _mark_error(item, model, label,
                                        f'{item["disk_id"]} on node {item["node_id"]} expected {exp_size} bytes, got {p_size}')
                            continue
                        if item.get('want_csum') and item.get('p_checksum') and item.get('exp_checksum'):
                            if item['p_checksum'] != item['exp_checksum']:
                                label = 'LOCAL THUMBNAIL CHECKSUM MISMATCH' if kind == 'local_thumb' else 'THUMBNAIL CHECKSUM MISMATCH'
                                _mark_error(item, model, label,
                                            f'{item["disk_id"]} on node {item["node_id"]} expected {item["exp_checksum"][:16]}..., got {item["p_checksum"][:16]}...')
                                continue
                            checksum_verified += 1
                        vals = {'verified_at': _now}
                        if p_size is not None and (item.get('cur_size') is None or int(item['cur_size']) != int(p_size)):
                            vals['size_bytes'] = int(p_size)
                            metadata_fixed += 1
                        if item.get('p_checksum') and item.get('cur_checksum') != item['p_checksum']:
                            vals['checksum'] = item['p_checksum']
                            metadata_fixed += 1
                        # AUDIT FIX (size-only replicas excluded from failover):
                        # the scrub is where an unverified replica EARNS its trust.
                        # A hash we computed/read for this object and matched
                        # against the authoritative value promotes the row to
                        # checksum_verified=True, so it becomes usable as evidence
                        # for destructive redundancy decisions.
                        if item.get('want_csum') and item.get('p_checksum') and item.get('exp_checksum'):
                            vals['checksum_verified'] = True
                        if self._scrub_persist(model, item['replica'], vals):
                            audited += 1
                            if kind == 'local_thumb':
                                local_audited += 1
                        continue

                    # ===== NOTE (remote or local) =====
                    if kind in ('remote_note', 'local_note'):
                        nid = item['resource_id']
                        if nid in _healed_note_ids:
                            continue
                        if item.get('precheck_bad'):
                            label = ('LOCAL NOTE VERSION MISMATCH' if kind == 'local_note'
                                     else 'STALE NOTE VERSION/CHECKSUM')
                            _heal_note(item, model, label, f'{nid} on node {item["node_id"]} drifted from canonical v{item.get("note_version")}')
                            continue
                        if not item.get('p_exists'):
                            label = 'MISSING LOCAL NOTE' if kind == 'local_note' else 'MISSING NOTE REPLICA'
                            _heal_note(item, model, label, f'{nid} on node {item["node_id"]}')
                            continue
                        p_size = item.get('p_size')
                        nsize = item.get('note_size')
                        if nsize is not None and p_size is None:
                            print(f'[SCRUB] Note size probe indeterminate for {item["disk_id"]} on node {item["node_id"]}')
                            continue
                        if p_size is not None and nsize is not None and int(p_size) != int(nsize):
                            label = 'LOCAL NOTE SIZE MISMATCH' if kind == 'local_note' else 'NOTE SIZE MISMATCH'
                            _heal_note(item, model, label, f'{nid} on node {item["node_id"]} expected {nsize} bytes, got {p_size}')
                            continue
                        if item.get('want_csum') and item.get('p_checksum') and item.get('exp_checksum'):
                            if item['p_checksum'] != item['exp_checksum']:
                                label = 'LOCAL NOTE CHECKSUM MISMATCH' if kind == 'local_note' else 'NOTE CHECKSUM MISMATCH'
                                _heal_note(item, model, label, f'{nid} on node {item["node_id"]} checksum drift')
                                continue
                            checksum_verified += 1
                        elif kind == 'remote_note' and item.get('exp_checksum') and item.get('cur_checksum') != item['exp_checksum']:
                            # NOTE CHECKSUM UNKNOWN: recorded checksum disagrees
                            # with the canonical and we could not verify remotely.
                            _mark_error(item, model, 'NOTE CHECKSUM UNKNOWN',
                                        f'{nid} on node {item["node_id"]} lacks a verified checksum for the current version')
                            continue
                        vals = {'verified_at': _now}
                        if item.get('p_checksum') and item.get('cur_checksum') != item['p_checksum']:
                            vals['checksum'] = item['p_checksum']
                            metadata_fixed += 1
                        # AUDIT FIX (size-only replicas excluded from failover):
                        # promote a hash-confirmed note replica to verified.
                        if item.get('want_csum') and item.get('p_checksum') and item.get('exp_checksum'):
                            vals['checksum_verified'] = True
                        if self._scrub_persist(model, item['replica'], vals):
                            audited += 1
                            if kind == 'local_note':
                                local_audited += 1
                        continue
                except Exception as e:
                    print(f'[SCRUB] Error applying verdict for {kind} {item.get("disk_id")}: {e}')
                    try:
                        db.session.rollback()
                    except Exception:
                        pass

            if audited or corrupted or metadata_fixed or checksum_verified or note_self_healed or deep_verified:
                local_note = f', {local_audited} local' if local_audited > 0 else ''
                deep_note = f', deep-verified {deep_verified}' if deep_verified > 0 else ''
                print(
                    f'[SCRUB] Audited {audited} replicas ({audited - local_audited} remote{local_note}), '
                    f'fixed {metadata_fixed} metadata rows, '
                    f'checksum-verified {checksum_verified}{deep_note}, found {corrupted} mismatches'
                )
            if note_self_healed > 0:
                print(f'[SCRUB] Self-healed {note_self_healed} note(s) from local authoritative data')
        except Exception as e:
            print(f'[SCRUB] Integrity scrub failed: {e}')
            try:
                db.session.rollback()
            except Exception:
                pass
        finally:
            try:
                self._state_lock.release()
            except RuntimeError:
                pass
        return corrupted
