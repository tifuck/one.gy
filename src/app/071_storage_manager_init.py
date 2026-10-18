class _StorageManagerInit:

    MAX_ERROR_RETRIES = 20
    DEFERRED_DELETE_RETRY_COOLDOWN = timedelta(minutes=5)
    DEFERRED_DELETE_WARN_RETRIES = 10
    # AUDIT FIX M6: terminal cap for deferred remote deletes. Once a tombstone
    # has failed this many times it is "parked" — it stops being re-attempted
    # every cycle (so a persistently-unreachable/misconfigured node cannot make
    # the queue churn forever and grow unbounded) but the row is RETAINED for
    # operator visibility via the admin remote-cleanup tooling. An operator fix
    # + reset_failed_replication_state() re-activates it.
    DEFERRED_DELETE_MAX_RETRIES = 50
    LOCAL_PURGE_MIN_VERIFIED_REMOTE_COPIES = 2
    SIZE_ONLY_READ_WARN_COOLDOWN_SECONDS = 300
    # AUDIT FIX (single-copy residency was invisible): store_file*() returns as
    # soon as the LOCAL write lands and merely marks remotes 'pending';
    # _active_node_ids skips offline/error nodes with no time bound; and
    # MAX_ERROR_RETRIES parks a replica in 'error' permanently with NO alert.
    # Because backup_prod.py deliberately EXCLUDES uploads/, thumbnails/ and
    # notes/ on the assumption that replication makes them redundant, a payload
    # stuck at one copy is a file whose only copy on Earth is the local disk —
    # and nothing said so. These bound how often the audit runs, how stale the
    # cached snapshot may be, and how long a payload may sit single-copy before
    # it is reported. The alert threshold is overridable via the
    # `single_copy_alert_seconds` AppSetting.
    SINGLE_COPY_SNAPSHOT_TTL_SECONDS = 300
    SINGLE_COPY_AUDIT_INTERVAL_SECONDS = 900
    SINGLE_COPY_ALERT_AFTER_SECONDS = 3600

    def __init__(self, app_instance):
        self._app = app_instance
        # Guards publication and short snapshots of the complete backend state.
        # It is never held across backend/network operations.
        self._backends_lock = threading.RLock()
        self._backends = {}
        self._local_backend = None
        self._local_node_id = None
        self._initialized = False
        self._backends_version = 0  # Tracks staleness across workers
        self._disk_usage_cache = {}  # {node_id: {'data': {...}, 'cached_at': datetime}}
        # _state_lock is process-local. Remote target writes additionally use
        # host-wide flock fencing below because a stale scheduler owner can leave
        # detached transfer threads alive after a new worker takes the DB lease.
        self._state_lock = threading.RLock()
        # Maps local reservations to their node-shared and target-exclusive flock
        # handles. flock supplies the cross-Gunicorn-worker fence; this dict only
        # closes the same-process check/acquire race and owns the descriptors.
        self._inflight_writes = {}
        self._inflight_lock = threading.Lock()
        self._size_only_read_warnings = {}
        self._size_only_read_warnings_lock = threading.Lock()
        # CONCURRENCY FIX F3: guards _disk_usage_cache. The health-check thread
        # wrote this dict under _state_lock while request threads read+wrote it
        # with NO lock — a genuine data race (stale clobber). Dedicated short
        # lock so cache reads never block behind replication Phase A.
        self._disk_usage_lock = threading.Lock()
        # AUDIT FIX (single-copy residency was invisible): cached snapshot of how
        # many payloads currently have fewer than two synced copies, plus the
        # monotonic timestamp of the last alert pass (so the replication cycle
        # does not re-log the same warning every 10 seconds).
        self._single_copy_cache = None
        self._single_copy_audit_at = 0.0

    def _backend_state_snapshot(self):
        """Return one consistent, operation-local backend state snapshot."""
        with self._backends_lock:
            return (
                dict(self._backends),
                self._local_backend,
                self._local_node_id,
                self._backends_version,
            )

    def _close_backend_set(self, backends, keep=()):
        """Close SSH backends after publication, outside the publication lock."""
        keep_ids = {id(backend) for backend in keep}
        closed = set()
        for backend in (backends or {}).values():
            if (not isinstance(backend, _SSHBackend) or id(backend) in keep_ids
                    or id(backend) in closed):
                continue
            closed.add(id(backend))
            try:
                # _SSHBackend._close() shares its operation RLock with every
                # shared-connection operation, so an in-flight use drains first.
                backend._close()
            except Exception:
                pass

    def _inflight_remote_disk_id(self, category, item_id):
        """Canonical remote object name for the in-flight guard key. Files store
        '<id>.enc'; notes use the bare note_id; thumbnails already pass the
        '<id>.jpg'/'<id>.e2e' disk id as item_id."""
        if category == 'files':
            return item_id if str(item_id).endswith('.enc') else f'{item_id}.enc'
        return item_id

    def _storage_write_lock_path(self, node_id, category=None, disk_id=None):
        if category is None:
            return os.path.join(_advisory_lock_dir(), f'storage_node_{int(node_id)}.lock')
        target_hash = hashlib.sha256(
            f'{category}\0{disk_id}'.encode('utf-8', errors='surrogatepass')
        ).hexdigest()
        return os.path.join(
            _advisory_lock_dir(), f'storage_target_{int(node_id)}_{target_hash}.lock')

    def _open_storage_write_lock(self, lock_path, operation, timeout=0):
        """Acquire a host-local flock with an optional bounded wait.

        These locks fence Gunicorn workers only when they share this host and
        instance/locks filesystem with working POSIX flock semantics. A future
        multi-host app deployment must replace them with DB/distributed leases
        held through put(); local filesystems on separate hosts do not fence one
        another. The inode check makes acquisition safe against stale-lock-file
        cleanup unlinking and recreating the path concurrently.
        """
        wait_seconds = max(0, float(timeout or 0))
        deadline = time.monotonic() + wait_seconds
        while True:
            lock_file = open(lock_path, 'a+')
            try:
                fcntl.flock(lock_file.fileno(), operation | fcntl.LOCK_NB)
            except (BlockingIOError, OSError):
                lock_file.close()
                if wait_seconds <= 0 or time.monotonic() >= deadline:
                    return None
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
                continue
            try:
                if os.stat(lock_path).st_ino == os.fstat(lock_file.fileno()).st_ino:
                    return lock_file
            except OSError:
                pass
            self._release_storage_write_lock(lock_file)
            if wait_seconds <= 0 or time.monotonic() >= deadline:
                return None

    def _release_storage_write_lock(self, lock_file):
        if not lock_file:
            return
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            lock_file.close()
        except OSError:
            pass

    def _target_node_accepts_writes(self, node_id):
        """Read fresh node eligibility after the host locks are held."""
        # Real replication workers always run under app_context(). Keeping the
        # no-context behavior supports low-level lock tests without making a DB
        # RuntimeError in production fail open.
        if not has_app_context():
            return True
        try:
            # A detached worker may retain an old REPEATABLE READ snapshot. It
            # has no pending DB mutations at reservation time, so start a fresh
            # transaction before consulting the drain fence.
            db.session.rollback()
            node = db.session.get(StorageNode, node_id)
            return bool(node and node.is_enabled and node.status != 'draining')
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[REPLICATION] Could not verify write eligibility for node {node_id}: {e}')
            return False

    def _try_acquire_inflight_write(self, category, disk_id, node_id):
        """Reserve one target across threads and Gunicorn workers on this host."""
        key = (category, disk_id, node_id)
        with self._inflight_lock:
            if key in self._inflight_writes:
                return False
            self._inflight_writes[key] = None

        node_lock = None
        target_lock = None
        acquired = None
        try:
            # Shared node ownership lets different targets run concurrently but
            # lets remove_node() wait for all target puts with one exclusive lock.
            node_lock = self._open_storage_write_lock(
                self._storage_write_lock_path(node_id), fcntl.LOCK_SH)
            if not node_lock:
                return False
            target_lock = self._open_storage_write_lock(
                self._storage_write_lock_path(node_id, category, disk_id), fcntl.LOCK_EX)
            if not target_lock:
                return False
            # Removal commits draining before waiting for the node lock. Checking
            # eligibility while holding the shared lock closes both orderings:
            # either we observe draining and leave, or removal must wait for put.
            if not self._target_node_accepts_writes(node_id):
                return False
            with self._inflight_lock:
                self._inflight_writes[key] = (node_lock, target_lock)
                acquired = self._inflight_writes[key]
            return True
        finally:
            if acquired is None:
                with self._inflight_lock:
                    self._inflight_writes.pop(key, None)
                self._release_storage_write_lock(target_lock)
                self._release_storage_write_lock(node_lock)

    def _release_inflight_write(self, category, disk_id, node_id):
        key = (category, disk_id, node_id)
        with self._inflight_lock:
            locks = self._inflight_writes.pop(key, None)
        if locks:
            node_lock, target_lock = locks
            self._release_storage_write_lock(target_lock)
            self._release_storage_write_lock(node_lock)

    def _is_inflight_write(self, category, disk_id, node_id):
        with self._inflight_lock:
            return (category, disk_id, node_id) in self._inflight_writes

    def _acquire_node_drain_lock(self, node_id, timeout):
        return self._open_storage_write_lock(
            self._storage_write_lock_path(node_id), fcntl.LOCK_EX, timeout=timeout)

    def init(self):
        with self._backends_lock:
            if self._initialized:
                return
        self.refresh_backends()
        backends, _local_backend, _local_node_id, _version = self._backend_state_snapshot()
        print(f'[STORAGE] Initialized {len(backends)} storage node(s)')

    def _ensure_local_backend_ready(self):
        """Ensure this worker can always reach local storage."""
        backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        if local_backend is None or not self._initialized:
            self.init()
            backends, local_backend, local_node_id, _version = self._backend_state_snapshot()
        if local_backend is None:
            return False
        if local_node_id and local_node_id in backends:
            return True
        try:
            local_node = StorageNode.query.filter_by(node_type='local', is_enabled=True).first()
            if local_node:
                with self._backends_lock:
                    updated_backends = dict(self._backends)
                    updated_backends[local_node.id] = self._local_backend
                    self._backends = updated_backends
                    self._local_node_id = local_node.id
                return True
        except Exception as e:
            print(f'[STORAGE] Failed to ensure local backend readiness: {e}')
        return local_backend is not None

    def _load_backends_into_self(self):
        self.refresh_backends()

    @staticmethod
    def _canonical_local_node_id(local_rows=None):
        """AUDIT FIX (finding 11/F1): exactly ONE StorageNode row may own the
        canonical local disk backend. Deterministic across workers: the local
        row with the lowest id (the auto-created/original row; ids are
        monotonic). Any other 'local' row would alias the same primary disk
        and manufacture false replicas, so callers must exclude it."""
        if local_rows is None:
            local_rows = StorageNode.query.filter_by(node_type='local').all()
        if not local_rows:
            return None
        return min(r.id for r in local_rows)

    def _build_backend_state(self):
        local_paths = {
            'files': self._app.config['UPLOAD_FOLDER'],
            'notes': NOTES_DIR,
            'thumbnails': THUMBNAILS_DIR,
        }
        new_local_backend = _LocalBackend(local_paths)
        new_backends = {}
        new_local_node_id = None
        try:
            # AUDIT FIX (finding 1): previously EVERY enabled 'local' row was
            # handed the SAME _LocalBackend and new_local_node_id was simply
            # overwritten by whichever row iterated last — with two local rows
            # the "local node id" was arbitrary and both rows looked like
            # independent replicas of one disk. Canonical selection is now
            # deterministic (lowest id) and additional local rows are
            # excluded from the backend set entirely (fail-safe: replication
            # to them can never report a false synced copy).
            #
            # Node rows come from a FRESH transaction: refresh_backends() labels
            # this build with a version read on its own connection, while the
            # caller's session may still hold an older REPEATABLE READ snapshot
            # (a disabled node would then be published under the new version).
            from sqlalchemy.orm import Session as _FreshSession
            with _FreshSession(db.engine) as fresh_session:
                all_local_rows = fresh_session.query(StorageNode).filter_by(node_type='local').all()
                nodes = fresh_session.query(StorageNode).filter_by(is_enabled=True).all()
            canonical_local_id = self._canonical_local_node_id(all_local_rows)
            if len(all_local_rows) > 1:
                # Existing-DB-rows repair: a legacy duplicate local row may
                # already carry 'synced' replica rows whose bytes live on the
                # canonical disk. Trust checks (exclusivity, purge redundancy,
                # removal safety) would count that one disk twice. Demote those
                # rows to 'error' with an explanatory reason — idempotent, only
                # runs while duplicates exist.
                extra_local_ids = [r.id for r in all_local_rows if r.id != canonical_local_id]
                _dup_msg = 'NODE ALIASES THE PRIMARY LOCAL DISK — NOT A SEPARATE COPY'
                try:
                    changed = 0
                    for _model in (FileReplica, NoteReplica, ThumbnailReplica):
                        changed += db.session.query(_model).filter(
                            _model.node_id.in_(extra_local_ids),
                            _model.status == 'synced',
                        ).update({
                            _model.status: 'error',
                            _model.verified_at: None,
                            _model.last_error: _dup_msg,
                        }, synchronize_session=False) or 0
                    if changed:
                        print(f'[STORAGE] Demoted {changed} false synced replica row(s) on '
                              f'additional local node(s) {extra_local_ids}: {_dup_msg}')
                except Exception as _dup_err:
                    db.session.rollback()
                    print(f'[STORAGE] Failed to demote duplicate-local replica rows: {_dup_err}')
            failed_node_ids = []
            for node in nodes:
                try:
                    if node.node_type == 'local':
                        if node.id != canonical_local_id:
                            raise ValueError(
                                'ADDITIONAL LOCAL STORAGE NODE ALIASES THE PRIMARY LOCAL DISK '
                                f'(canonical local node id={canonical_local_id}); a separate '
                                'path local backend is not supported — use an SSH or S3 node')
                        backend = new_local_backend
                        new_local_node_id = node.id
                    else:
                        backend = self._create_backend(node)
                    new_backends[node.id] = backend
                except Exception as e:
                    print(f'[STORAGE] Failed to init backend for node {node.id} ({node.name}): {e}')
                    failed_node_ids.append(node.id)
            if failed_node_ids:
                StorageNode.query.filter(StorageNode.id.in_(failed_node_ids)).update(
                    {StorageNode.status: 'error'})
            db.session.commit()
        except Exception as e:
            print(f'[STORAGE] Failed to load storage nodes: {e}')
        if not new_backends:
            try:
                local_node = StorageNode.query.filter_by(node_type='local').order_by(
                    StorageNode.id.asc()).first()
                if not local_node:
                    try:
                        local_node = StorageNode(
                            name='Local Disk', node_type='local', is_primary=True, is_enabled=True,
                            status='online', last_seen_at=datetime.now(timezone.utc),
                        )
                        local_node.set_config({'path': self._app.config['UPLOAD_FOLDER']})
                        db.session.add(local_node)
                        db.session.commit()
                        print('[STORAGE] Auto-created local disk storage node')
                    except Exception:
                        db.session.rollback()
                        local_node = StorageNode.query.filter_by(node_type='local').order_by(
                            StorageNode.id.asc()).first()
                        if not local_node:
                            raise
                new_backends[local_node.id] = new_local_backend
                new_local_node_id = local_node.id
            except Exception as e:
                print(f'[STORAGE] Failed to ensure local node during refresh: {e}')
        return new_local_backend, new_backends, new_local_node_id

    def _read_backends_version(self):
        """Read the storage_backends_version counter from AppSetting."""
        try:
            table = AppSetting.__table__
            statement = table.select().with_only_columns(table.c.value).where(
                table.c.key == 'storage_backends_version')
            # Use a separate one-statement transaction. The request/session
            # identity map and MariaDB REPEATABLE READ snapshot must not hide a
            # version committed by another worker during a backend build.
            with db.engine.connect() as connection:
                value = connection.execute(statement).scalar_one_or_none()
            return int(value) if value is not None else 0
        except Exception as e:
            print(f'[STORAGE] Failed to read backends version: {e}')
            raise

    def _bump_backends_version(self):
        """Increment the storage_backends_version counter so other workers detect staleness.
        CONCURRENCY FIX F5: uses SELECT ... FOR UPDATE so two workers bumping
        concurrently cannot lose an increment (previously a non-atomic RMW)."""
        try:
            row = db.session.query(AppSetting).filter_by(key='storage_backends_version').with_for_update().first()
            if row:
                row.value = str(int(row.value) + 1)
                row.updated_at = datetime.now(timezone.utc)
            else:
                row = AppSetting(key='storage_backends_version', value='1')
                db.session.add(row)
            db.session.commit()
            # AUDIT FIX A1: _read_backends_version() reads the row directly (not
            # through _get_raw_setting), so this counter is not cache-served
            # today. Invalidate anyway so a future caller that switches to
            # get_numeric_setting() cannot silently read a stale version.
            _invalidate_settings_cache('storage_backends_version')
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[STORAGE] Failed to bump backends version: {e}')

    def _check_backends_freshness(self):
        """Check if this worker's backends are stale and refresh if needed.
        Uses a single PK lookup — cheap enough for request-time use."""
        try:
            current_version = self._read_backends_version()
            _backends, _local_backend, _local_node_id, published_version = self._backend_state_snapshot()
            if current_version != published_version:
                print(f'[STORAGE] Worker backends stale (have v{published_version}, DB v{current_version}), refreshing...')
                self.refresh_backends()
        except Exception as e:
            print(f'[STORAGE] Backend freshness check failed: {e}')

    def _ensure_local_node(self):
        try:
            local_node = StorageNode.query.filter_by(node_type='local').first()
            if not local_node:
                try:
                    local_node = StorageNode(
                        name='Local Disk', node_type='local', is_primary=True, is_enabled=True,
                        status='online', last_seen_at=datetime.now(timezone.utc),
                    )
                    local_node.set_config({'path': self._app.config['UPLOAD_FOLDER']})
                    db.session.add(local_node)
                    db.session.commit()
                    print('[STORAGE] Auto-created local disk storage node')
                except Exception:
                    # Race condition: another worker created it first
                    db.session.rollback()
                    local_node = StorageNode.query.filter_by(node_type='local').first()
                    if not local_node:
                        raise
            with self._backends_lock:
                updated_backends = dict(self._backends)
                updated_backends[local_node.id] = self._local_backend
                self._backends = updated_backends
                self._local_node_id = local_node.id
        except Exception as e:
            print(f'[STORAGE] Failed to ensure local node: {e}')
            raise

    def _seed_local_replicas(self):
        """One-time: create 'synced' FileReplica/NoteReplica/ThumbnailReplica rows for the local node for data on disk."""
        nid = self._local_node_id
        now = datetime.now(timezone.utc)

        # --- Seed any file/note rows missing from the local replica index ---
        try:
            # AUDIT FIX P1-10: bulk-prefetch existing file_ids for this node
            # and check per-fid before inserting, so a concurrent upload that
            # inserts a row mid-seed does not cause a batch IntegrityError
            # that rolls back all seeded rows.
            existing_file_ids = set()
            for r in FileReplica.query.filter_by(node_id=nid).with_entities(FileReplica.file_id).all():
                existing_file_ids.add(r[0])
            existing_note_ids = set()
            for r in NoteReplica.query.filter_by(node_id=nid).with_entities(NoteReplica.note_id).all():
                existing_note_ids.add(r[0])
            # The membership sets keep refreshes cheap while still repairing a
            # partially seeded index after an interrupted migration or repair.
            seeded = 0
            all_files = File.query.with_entities(File.id).all()
            for (fid,) in all_files:
                if fid in existing_file_ids:
                    continue
                filename = f'{fid}.enc'
                if self._local_backend.exists('files', filename):
                    file_size = self._local_backend.size('files', filename)
                    if file_size and file_size > 0:
                        db.session.add(FileReplica(
                            file_id=fid, node_id=nid, status='synced',
                            verified_at=now, size_bytes=file_size,
                        ))
                        seeded += 1
                    else:
                        db.session.add(FileReplica(
                            file_id=fid, node_id=nid, status='error',
                        ))
                        print(f'[STORAGE] Seed: skipped zero-byte/unreadable file {filename}')
                    existing_file_ids.add(fid)
            db.session.commit()
            if seeded > 0:
                print(f'[STORAGE] Seeded {seeded} local file replicas')

            seeded_notes = 0
            all_notes = Note.query.with_entities(Note.id).all()
            for (note_id,) in all_notes:
                if note_id in existing_note_ids:
                    continue
                if self._local_backend.exists('notes', note_id):
                    note_obj = db.session.get(Note, note_id)
                    note_version = int(note_obj.content_version or 1) if note_obj else 1
                    note_checksum = note_obj.content_checksum if note_obj else None
                    db.session.add(NoteReplica(
                        note_id=note_id,
                        node_id=nid,
                        status='synced',
                        synced_version=note_version,
                        target_version=note_version,
                        checksum=note_checksum,
                        verified_at=now,
                    ))
                    existing_note_ids.add(note_id)
                    seeded_notes += 1
            db.session.commit()
            if seeded_notes > 0:
                print(f'[STORAGE] Seeded {seeded_notes} local note replicas')
        except Exception as e:
            db.session.rollback()
            print(f'[STORAGE] Failed to seed local file/note replicas: {e}')

        # --- Seed thumbnails (independent — only creates rows that don't already exist) ---
        # AUDIT Tier 1: previously this unconditionally re-stat'd every
        # thumbnail file on disk on every backend refresh (which fires on
        # every request that touches storage via _check_backends_freshness).
        # Now we (a) skip entirely if existing_thumbs covers every File row
        # AND (b) restrict the inner exists() loop to files that DON'T yet
        # have rows for both thumb_type variants.
        try:
            existing_thumbs = set()
            for r in ThumbnailReplica.query.filter_by(node_id=nid).with_entities(ThumbnailReplica.file_id, ThumbnailReplica.thumb_type).all():
                existing_thumbs.add((r.file_id, r.thumb_type))
            seeded_thumbs = 0
            # Only consider files that currently HAVE a thumbnail. The
            # reconciliation clean-pass deletes ThumbnailReplica rows for any
            # file with has_thumbnail=False (see "[REPLICATION] Cleaned N stale
            # thumbnail replicas (file has_thumbnail=False)"), so seeding a row
            # for such a file just gets reconciled away ~10s later, producing a
            # perpetual seed-then-clean churn at every boot for any file that
            # still has a stale thumbnail blob on disk. Gating the seed on
            # has_thumbnail=True keeps it consistent with that authoritative
            # filter and stops the churn.
            thumb_file_ids = [fid for (fid,) in File.query.with_entities(File.id).filter_by(has_thumbnail=True).all()]
            # Early skip: if every (file_id, thumb_type) pair this node could
            # ever care about already has a row, there's nothing to seed.
            # Otherwise, restrict the disk-stat loop to files that are still
            # missing at least one row.
            files_needing_check = [
                fid for fid in thumb_file_ids
                if (fid, 'jpg') not in existing_thumbs or (fid, 'e2e') not in existing_thumbs
            ]
            if not files_needing_check:
                return
            # Single directory listing replaces N os.path.exists calls.
            try:
                disk_thumb_set = set(self._local_backend.list_files('thumbnails') or [])
            except Exception:
                disk_thumb_set = None  # fall back to per-item exists()
            for fid in files_needing_check:
                for thumb_type, ext in [('jpg', '.jpg'), ('e2e', '.e2e')]:
                    if (fid, thumb_type) in existing_thumbs:
                        continue
                    thumb_id = f'{fid}{ext}'
                    on_disk = (
                        thumb_id in disk_thumb_set
                        if disk_thumb_set is not None
                        else self._local_backend.exists('thumbnails', thumb_id)
                    )
                    if on_disk:
                        thumb_size = self._local_backend.size('thumbnails', thumb_id)
                        db.session.add(ThumbnailReplica(
                            file_id=fid, thumb_type=thumb_type, node_id=nid,
                            status='synced', verified_at=now, size_bytes=thumb_size,
                        ))
                        seeded_thumbs += 1
            if seeded_thumbs > 0:
                db.session.commit()
                print(f'[STORAGE] Seeded {seeded_thumbs} local thumbnail replicas')
        except Exception as e:
            db.session.rollback()
            print(f'[STORAGE] Failed to seed local thumbnail replicas: {e}')

    def _create_backend(self, node):
        if node.node_type == 'local':
            # AUDIT FIX (finding 1): a config 'path' on a local node used to be
            # accepted while this factory silently returned the SAME canonical
            # local backend for every local row — a second "local" node
            # reported independent replicas that shared one disk. Fail safe:
            # only the canonical (lowest-id) local row may bind the canonical
            # backend; any other local row raises so the caller marks it
            # 'error' instead of tracking false replicas.
            canonical_id = self._canonical_local_node_id()
            if canonical_id is not None and node.id is not None and node.id != canonical_id:
                raise ValueError(
                    f'Local storage node {node.id} ({node.name}) aliases the primary local disk '
                    f'(canonical local node id={canonical_id}); additional local nodes are not '
                    'supported — remove this node and use an SSH or S3 node instead')
            _backends, local_backend, _local_node_id, _version = self._backend_state_snapshot()
            return local_backend
        elif node.node_type == 'ssh':
            return _SSHBackend(node.get_config())
        elif node.node_type == 's3':
            return _S3Backend(node.get_config())
        else:
            raise ValueError(f'Unknown node type: {node.node_type}')

    def refresh_backends(self):
        # A build is valid only for the DB generation observed before it began.
        # Recheck both before and inside the short publication critical section;
        # a stale/out-of-order builder is discarded rather than labelled with a
        # newer version it never observed.
        while True:
            build_version = self._read_backends_version()
            new_local_backend, new_backends, new_local_node_id = self._build_backend_state()
            try:
                current_version = self._read_backends_version()
            except Exception:
                self._close_backend_set(new_backends)
                raise
            if current_version != build_version:
                self._close_backend_set(new_backends)
                continue

            old_backends = None
            publish_drifted = False
            try:
                with self._backends_lock:
                    current_version = self._read_backends_version()
                    if current_version != build_version:
                        publish_drifted = True
                    else:
                        old_backends = self._backends
                        self._backends = dict(new_backends)
                        self._local_backend = new_local_backend
                        self._local_node_id = new_local_node_id
                        self._backends_version = build_version
                        self._initialized = True
            except Exception:
                self._close_backend_set(new_backends)
                raise
            if publish_drifted:
                self._close_backend_set(new_backends)
                continue
            self._close_backend_set(old_backends, keep=new_backends.values())
            break

        if new_local_node_id:
            self._seed_local_replicas()

    def _get_primary_node_id(self, backends=None):
        if backends is None:
            backends, _local_backend, _local_node_id, _version = self._backend_state_snapshot()
        try:
            primary = StorageNode.query.filter_by(is_primary=True, is_enabled=True).first()
            if primary and primary.id in backends:
                return primary.id
        except Exception:
            pass
        if backends:
            return next(iter(backends))
        return None

    def _order_read_replicas(self, replicas):
        primary_id = self._get_primary_node_id()
        if not primary_id:
            return replicas
        primary = [r for r in replicas if r.node_id == primary_id]
        others = [r for r in replicas if r.node_id != primary_id]
        return primary + others
