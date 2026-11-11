def _run_isolated_task(prefix, name, task_fn):
    """Run a scheduler sub-task with isolated error handling.

    If the task raises, the exception is caught and logged with the given
    prefix, the DB session is rolled back, and execution returns normally so
    later sub-tasks in the same scheduler tick still run."""
    try:
        task_fn()
    except Exception as e:
        try:
            db.session.rollback()
        except Exception:
            pass
        print(f'[{prefix}] Sub-task {name!r} failed: {e}')

def _skip_if_already_running(job_fn):
    """Skip a job invocation while a previous run of it is still executing.

    APScheduler's max_instances=1 is per BackgroundScheduler instance, but the
    lease watchdog stops a scheduler with shutdown(wait=False) and may build a
    fresh one while the old instance's jobs are still running, so the guard
    has to be process-wide."""
    lock = threading.Lock()

    @functools.wraps(job_fn)
    def wrapper():
        if not lock.acquire(blocking=False):
            print(f'[SCHEDULER] Skipping {job_fn.__name__}: previous run still in progress')
            return None
        try:
            return job_fn()
        finally:
            lock.release()
    return wrapper

def cleanup_job():
    # BUG FIX M6 (scheduler split-brain): the DB lease can be stolen by another
    # worker while this (hung/slow) owner's in-flight APScheduler jobs keep
    # running for up to SCHEDULER_HEARTBEAT_INTERVAL plus the remaining job
    # time. These sub-tasks do destructive work (expired-file deletion, orphan
    # reaping) with only process-local guards, so verify THIS worker still owns
    # the lease before starting — and again before every sub-task, since a long
    # cycle can outlive the steal. Read-only check: it never refreshes or
    # re-steals the lease, it just bails out.
    with app.app_context():
        if not _scheduler_started or not _scheduler_owns_lease():
            print('[CLEANUP] Skipping cycle: scheduler lease no longer owned by this worker')
            return
        # Shared with the admin "run cleanup" endpoint and `flask cleanup`, and
        # also covers an old scheduler instance's run still in flight.
        run_lock = _acquire_cleanup_run_lock()
        if run_lock is None:
            print('[CLEANUP] Skipping cycle: another cleanup run is still in progress')
            return
        try:
            for name, fn in (
                ('expired_files',          cleanup_expired_files),
                ('orphaned_files',         cleanup_orphaned_files),
                ('orphaned_notes',         cleanup_orphaned_notes),
                ('stale_preps',            cleanup_stale_preps),
                ('stale_progress',         cleanup_stale_progress),
                ('remote_staging_files',   cleanup_remote_staging_files),
                ('local_staged_files',     cleanup_local_staged_files),
                ('temp_dirs',              cleanup_temp_dirs),
                ('stale_music_sync',       cleanup_stale_music_sync),
                # AUDIT FIX M14: drop expired session-revocation rows and refresh the
                # process-local revoked-sid cache (so extra Gunicorn workers converge).
                ('revoked_sessions',       _prune_revoked_sessions),
                ('security_state',         cleanup_stale_security_state),
                # AUDIT FIX A8: reap advisory lock files that nothing has held for a day.
                ('stale_lock_files',       cleanup_stale_lock_files),
                # AUDIT FIX A9: drop dismissal rows that can never matter again.
                ('notification_dismissals', cleanup_stale_notification_dismissals),
                # Desktop sync: expire old tombstones (older cursors then get 410).
                ('sync_tombstones',        _prune_sync_tombstones),
                # Desktop sync: idle upload sessions and their staged parts.
                ('sync_upload_sessions',   _cleanup_expired_sync_upload_sessions),
                # File versions past retention or whose live file is gone.
                ('file_versions',          _cleanup_file_versions),
                # Note versions whose note was deleted.
                ('note_versions',          _cleanup_note_versions),
                # AUDIT FIX A16: pick up songs added to / removed from disk without a restart.
                ('music_library_rescan',   maybe_rescan_available_songs),
            ):
                # BUG FIX M6: re-verify ownership at every sub-task boundary.
                if not _scheduler_owns_lease():
                    print(f'[CLEANUP] Aborting cycle before {name!r}: scheduler lease lost mid-run')
                    break
                _run_isolated_task('CLEANUP', name, fn)
        finally:
            _release_cleanup_run_lock(run_lock)
            # Ensure no half-applied session state leaks into the next tick.
            try:
                db.session.remove()
            except Exception:
                pass

@_skip_if_already_running
def replication_job():
    """Background replication cycle — copies pending files to other storage nodes
    and processes deferred remote deletions."""
    with app.app_context():
        # BUG FIX M6 (scheduler split-brain) applied to this job too: the two
        # sub-tasks below do DESTRUCTIVE work (process_pending_remote_deletes
        # unlinks payload bytes on every mirror) and previously ran with no
        # ownership check at all, so a hung/slow old owner whose lease had been
        # stolen kept replicating and deleting alongside the new owner. Same
        # fail-closed fence as cleanup_job: read-only, re-checked before each
        # sub-task because a long cycle can outlive the steal.
        if not _scheduler_started or not _scheduler_owns_lease():
            print('[REPLICATION] Skipping cycle: scheduler lease not owned by this worker')
            return
        _run_isolated_task('REPLICATION', 'run_replication_cycle', storage.run_replication_cycle)
        if not _scheduler_owns_lease():
            print('[REPLICATION] Aborting cycle: scheduler lease lost mid-run')
        else:
            _run_isolated_task('REPLICATION', 'process_pending_remote_deletes',
                               storage.process_pending_remote_deletes)
        try:
            db.session.remove()
        except Exception:
            pass

@_skip_if_already_running
def metrics_snapshot_job():
    """Background metrics snapshot for admin history charts."""
    with app.app_context():
        if not _scheduler_started or not _scheduler_owns_lease():
            print('[ADMIN] Skipping metrics snapshot: scheduler lease not owned by this worker')
            return
        try:
            capture_system_metrics_snapshot(force=False)
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[ADMIN] Metrics snapshot job failed: {e}')
        finally:
            try:
                db.session.remove()
            except Exception:
                pass

# One timer and one loaded flag per job: the two jobs fire on the same tick in
# separate pool threads, and a shared flag let one job gate on a timer the other
# had not loaded yet, then have its own fresh value overwritten by that load.
_last_health_check_time = 0.0
_last_integrity_scrub_time = 0.0
_health_check_time_loaded = False
_integrity_scrub_time_loaded = False

@_skip_if_already_running
def health_check_job():
    """Periodic health check for storage nodes, gated by the configurable
    health_check_interval AppSetting (default 300s / 5 min).
    Scheduled to tick every 60s but only runs the actual check when enough
    time has elapsed, so the interval can be changed at runtime without
    restarting the scheduler.

    AUDIT FIX M8: the replica integrity scrub used to run synchronously inside
    THIS job (max_instances=1), so a long scrub against a slow backend starved
    the 60s health-check ticks exactly when node up/down detection mattered. The
    scrub now lives in its own scheduler job (integrity_scrub_job) so the two
    cannot block each other."""
    global _last_health_check_time, _health_check_time_loaded
    import time as _time
    with app.app_context():
        if not _scheduler_started or not _scheduler_owns_lease():
            print('[HEALTH] Skipping tick: scheduler lease not owned by this worker')
            return
        now = _time.time()
        # AUDIT FIX F5: seed the last-run timer from its persisted AppSetting value
        # once per process. Without this, the module global resets to 0.0 on every
        # restart, so a health check fired on the first 60s tick after each
        # restart. The timestamp is wall-clock epoch (same basis as _time.time()),
        # so elapsed time is measured correctly across restarts.
        if not _health_check_time_loaded:
            _last_health_check_time = _load_job_timestamp('last_health_check_at')
            _health_check_time_loaded = True
        # Health check gate
        try:
            interval = get_numeric_setting('health_check_interval')
            # AUDIT FIX F4: require interval > 0. Previously a health_check_interval
            # of 0 made `now - last >= 0` always true, running on every 60s tick.
            if interval > 0 and now - _last_health_check_time >= interval:
                _last_health_check_time = now
                _persist_job_timestamp('last_health_check_at', now)
                _run_isolated_task('HEALTH', 'health_check_all', storage.health_check_all)
        except Exception as e:
            print(f'[HEALTH] Sub-task scheduling failed: {e}')
        try:
            db.session.remove()
        except Exception:
            pass

@_skip_if_already_running
def integrity_scrub_job():
    """Replica integrity scrub on its own timer (default 900s / 15 min), gated
    by the configurable integrity_scrub_interval AppSetting. Runs as a SEPARATE
    scheduler job from health_check_job (AUDIT FIX M8) with its own
    max_instances=1, so a slow scrub pass can never starve health checks. Each
    pass is also bounded by a wall-clock budget (integrity_scrub_max_seconds)."""
    global _last_integrity_scrub_time, _integrity_scrub_time_loaded
    import time as _time
    with app.app_context():
        if not _scheduler_started or not _scheduler_owns_lease():
            print('[SCRUB] Skipping tick: scheduler lease not owned by this worker')
            return
        now = _time.time()
        if not _integrity_scrub_time_loaded:
            _last_integrity_scrub_time = _load_job_timestamp('last_integrity_scrub_at')
            _integrity_scrub_time_loaded = True
        try:
            scrub_interval = get_numeric_setting('integrity_scrub_interval')
            if scrub_interval > 0 and now - _last_integrity_scrub_time >= scrub_interval:
                _last_integrity_scrub_time = now
                _persist_job_timestamp('last_integrity_scrub_at', now)
                scrub_batch_size = max(1, get_numeric_setting('integrity_scrub_batch_size'))
                scrub_checksum_batch_size = max(0, get_numeric_setting('integrity_scrub_checksum_batch_size'))
                # S3 COST FIX: deep-verify (download-back + re-hash for
                # checksum-incapable size-only backends) is DISABLED by default
                # (0). The bytes are already confirmed at UPLOAD time (single-part
                # via server-side SHA-256; multipart via s3_multipart_verify_write
                # download-back), so continuously re-downloading whole objects to
                # re-hash them is expensive egress for near-zero benefit — stored
                # objects do not silently rewrite themselves. Raise via AppSetting
                # only if a specific size-only backend needs ongoing re-hashing.
                scrub_deep_verify_batch_size = max(0, get_numeric_setting('integrity_scrub_deep_verify_batch_size'))
                # AUDIT FIX M8: wall-clock budget for a single scrub pass (0 =
                # unlimited). Default ~10 min keeps a pass from running unbounded
                # against slow backends; the next pass resumes from oldest-verified.
                scrub_max_seconds = max(0, get_numeric_setting('integrity_scrub_max_seconds'))
                # S3 COST FIX: skip replicas already verified within this window so
                # a healthy object is not re-probed every pass. Default 7 days.
                scrub_min_reverify = max(0, get_numeric_setting('integrity_scrub_min_reverify_interval'))
                _run_isolated_task('SCRUB', 'run_integrity_scrub',
                    lambda: storage.run_integrity_scrub(
                        max_items=scrub_batch_size,
                        max_checksum_items=scrub_checksum_batch_size,
                        max_deep_verify_items=scrub_deep_verify_batch_size,
                        max_seconds=scrub_max_seconds,
                        min_reverify_age_seconds=scrub_min_reverify,
                    ))
        except Exception as e:
            print(f'[SCRUB] Sub-task scheduling failed: {e}')
        try:
            db.session.remove()
        except Exception:
            pass

# ─── Scheduler leader election (AUDIT FIX H2) ───────────────────────────────
# Previously the scheduler owner was chosen by an flock held for the whole
# process lifetime (gunicorn.conf.py post_fork). flock only releases when the
# owning PROCESS EXITS, so if that worker HUNG but stayed alive (deadlocked
# APScheduler thread, wedged DB/SSH socket) it kept the lock forever and no
# other worker ever took over — replication, deferred deletes, integrity scrub
# and cleanup silently stopped with no failover and no alert.
#
# We now use a DB heartbeat LEASE combined with the flock as a fast death-path:
#   * Every worker runs a lightweight watchdog thread.
#   * The watchdog periodically claims/refreshes the lease via an atomic
#     SELECT ... FOR UPDATE conditional write. The lease owner rewrites its
#     heartbeat each tick. The watchdog loop IS the heartbeat — if the owner
#     (or the whole process) stalls and stops heart-beating for longer than the
#     lease timeout, another worker takes over. This detects HANGS, which flock
#     cannot.
#   * A lease is only ever stolen once its heartbeat is stale (a flock-only
#     steal let a hung owner take a fresh lease back). A worker that exits
#     cleanly marks its own lease stale (_scheduler_release_lease), so a restart
#     fails over on the next worker's first pass instead of waiting out the
#     lease timeout; after a crash the timeout applies. The flock only labels
#     the takeover in the log.
_scheduler = None
_scheduler_started = False
_scheduler_shutting_down = False  # set once the worker begins shutting down (see shutdown_scheduler_for_exit)
_scheduler_watchdog_thread = None
_scheduler_flock_fd = None
_scheduler_lease_confirmed_at = 0.0  # time.monotonic() of the last successful lease claim/refresh
_SCHEDULER_LEASE_KEY = 'scheduler_lease'
_SCHEDULER_LOCK_PATH = os.path.join(os.path.abspath(os.path.dirname(__file__)), '.scheduler.lock')
SCHEDULER_HEARTBEAT_INTERVAL = 15   # seconds between lease refresh attempts
SCHEDULER_LEASE_TIMEOUT = 60        # owner considered dead/hung after this long without a heartbeat
_SCHEDULER_INSTANCE_ID = f'{os.getpid()}:{uuid.uuid4().hex[:12]}'

def _build_and_start_scheduler_jobs():
    global _scheduler, _scheduler_started
    if _scheduler_started or _scheduler_shutting_down:
        return
    # job_defaults: coalesce missed runs into a single execution, ensure only
    # one instance of each job runs at a time, and tolerate up to 1 hour of
    # scheduling lag before silently skipping. Prior config relied on
    # APScheduler defaults (misfire_grace_time=1) which would silently drop
    # any replication tick that took >1s — causing replication to appear
    # frozen under load. See AUDIT Tier 0 #2.
    scheduler = BackgroundScheduler(job_defaults={
        'coalesce': True,
        'max_instances': 1,
        'misfire_grace_time': 3600,
    })
    scheduler.add_job(func=cleanup_job,          trigger='interval', minutes=5,  id='cleanup_job',          replace_existing=True)
    scheduler.add_job(func=replication_job,      trigger='interval', seconds=10, id='replication_job',      replace_existing=True)
    scheduler.add_job(func=metrics_snapshot_job, trigger='interval', minutes=5,  id='metrics_snapshot_job', replace_existing=True)
    scheduler.add_job(func=health_check_job,     trigger='interval', seconds=60, id='health_check_job',     replace_existing=True)
    # AUDIT FIX M8: integrity scrub is now its own job (was folded into
    # health_check_job), so a slow scrub pass can never starve health checks.
    scheduler.add_job(func=integrity_scrub_job,  trigger='interval', seconds=60, id='integrity_scrub_job',  replace_existing=True)
    scheduler.start()
    _scheduler = scheduler
    _scheduler_started = True
    # SIGTERM can land while the scheduler was being built: its handler then saw
    # nothing to stop. Both sides write their own flag before reading the
    # other's, so at least one of them sees the other and stops the jobs.
    if _scheduler_shutting_down:
        _stop_scheduler_jobs()
        return
    print('[SCHEDULER] Jobs started: cleanup(5m) + replication(10s) + metrics(5m) + health check(60s tick, default 5m) + integrity scrub(60s tick, default 15m) (coalesce=True, max_instances=1, misfire_grace_time=3600s)')

def _stop_scheduler_jobs():
    global _scheduler, _scheduler_started
    if not _scheduler_started:
        return
    try:
        if _scheduler is not None:
            _scheduler.shutdown(wait=False)
    except Exception as e:
        print(f'[SCHEDULER] Error shutting down scheduler: {e}')
    finally:
        _scheduler = None
        _scheduler_started = False

def shutdown_scheduler_for_exit(reason='exit'):
    """Stop APScheduler cleanly when the worker is shutting down, BEFORE the
    interpreter tears down concurrent.futures' thread pool.

    Without this, the daemon BackgroundScheduler thread keeps firing the 10s
    replication/scrub jobs while concurrent.futures._python_exit has already set
    the pool's _shutdown flag, producing a burst of
    'RuntimeError: cannot schedule new futures after shutdown' tracebacks during
    every restart (observed in PROD on Jun 27). gunicorn's SIGTERM path only
    sets alive=False with no worker-side hook, so this is wired up from the
    gunicorn post_worker_init / worker_int hooks (and atexit for the dev
    __main__ path). Idempotent and best-effort."""
    global _scheduler_shutting_down
    if _scheduler_shutting_down:
        return
    _scheduler_shutting_down = True
    try:
        _stop_scheduler_jobs()
        print(f'[SCHEDULER] Stopped scheduler for shutdown ({reason})')
    except Exception as e:
        print(f'[SCHEDULER] Error stopping scheduler for shutdown ({reason}): {e}')

def _scheduler_try_flock():
    """Fast death-detection fast-path: try to grab the process-level scheduler
    flock. Returns True if WE hold it. flock releases automatically when the
    owning process exits, giving instant failover on clean death/restart; the
    DB lease additionally handles HANGS that flock cannot detect."""
    global _scheduler_flock_fd
    if _scheduler_flock_fd is not None:
        return True
    fd = None
    try:
        fd = open(_SCHEDULER_LOCK_PATH, 'w')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _scheduler_flock_fd = fd
        return True
    except (IOError, OSError):
        if fd is not None:
            try:
                fd.close()
            except Exception:
                pass
        return False
    except Exception:
        if fd is not None:
            try:
                fd.close()
            except Exception:
                pass
        return False

def _scheduler_acquire_or_refresh_lease():
    """Atomically claim or refresh the scheduler lease. Returns True if THIS
    instance owns the lease after the call, False if another instance holds a
    fresh lease, and None when the DB call failed (ownership unknown)."""
    now = int(time.time())
    have_flock = _scheduler_try_flock()
    try:
        row = db.session.query(AppSetting).filter_by(key=_SCHEDULER_LEASE_KEY).with_for_update().first()
        if _scheduler_shutting_down:
            # Checked under the row lock: a heartbeat racing the exit hook must
            # not write a fresh lease for a worker that is going away.
            db.session.rollback()
            return False
        if row is None:
            db.session.add(AppSetting(key=_SCHEDULER_LEASE_KEY, value=f'{_SCHEDULER_INSTANCE_ID}:{now}'))
            db.session.commit()
            return True
        try:
            owner, hb_s = (row.value or '').rsplit(':', 1)
            hb = int(hb_s)
        except Exception:
            owner, hb = '', 0
        if owner == _SCHEDULER_INSTANCE_ID:
            row.value = f'{_SCHEDULER_INSTANCE_ID}:{now}'
            row.updated_at = datetime.now(timezone.utc)
            db.session.commit()
            return True
        # Steal only when the lease is stale. Flock-only steal let a hung
        # owner (still holding flock) yank a fresh lease back from the
        # failover worker and run two schedulers.
        if (now - hb) > SCHEDULER_LEASE_TIMEOUT:
            row.value = f'{_SCHEDULER_INSTANCE_ID}:{now}'
            row.updated_at = datetime.now(timezone.utc)
            db.session.commit()
            reason = 'previous owner dead (flock free)' if have_flock else f'stale heartbeat {now - hb}s > {SCHEDULER_LEASE_TIMEOUT}s'
            print(f'[SCHEDULER] Lease acquired from {owner or "<none>"} ({reason})')
            return True
        db.session.rollback()
        return False
    except Exception as e:
        try:
            db.session.rollback()
        except Exception:
            pass
        print(f'[SCHEDULER] Lease acquire/refresh error: {e}')
        return None

def _scheduler_release_lease():
    """Mark this instance's lease stale so the next worker takes over on its
    first watchdog pass. Without it every clean restart ran without background
    jobs until the dead worker's heartbeat aged past SCHEDULER_LEASE_TIMEOUT.
    Runs at interpreter exit, after the jobs have stopped. Best effort."""
    try:
        table = AppSetting.__table__
        with app.app_context():
            with db.engine.begin() as conn:
                released = conn.execute(table.update().where(
                    table.c.key == _SCHEDULER_LEASE_KEY,
                    table.c.value.startswith(f'{_SCHEDULER_INSTANCE_ID}:', autoescape=True),
                ).values(value=f'{_SCHEDULER_INSTANCE_ID}:0')).rowcount
        if released:
            print('[SCHEDULER] Released the scheduler lease for the next worker')
    except Exception as e:
        print(f'[SCHEDULER] Could not release the scheduler lease at exit: {e}')

def _scheduler_exit_hook():
    """atexit: stop the jobs (the dev-server path has no signal hooks), then
    hand the lease over."""
    shutdown_scheduler_for_exit('atexit')
    _scheduler_release_lease()

def _scheduler_owns_lease():
    """BUG FIX M6 (scheduler split-brain): read-only lease check for job
    fences. Returns True only if the lease row currently names THIS instance.
    Unlike _scheduler_acquire_or_refresh_lease it NEVER writes the lease, so a
    job thread cannot refresh or re-steal ownership the watchdog has already
    conceded; and it fails CLOSED (False) on any DB error, because its callers
    are about to do destructive work that must not race a second owner. This
    closes the residual window in which a hung/slow old owner keeps executing
    scheduled jobs until its watchdog next polls (up to
    SCHEDULER_HEARTBEAT_INTERVAL s) and notices the steal."""
    try:
        # Own short-lived connection: the job session's identity map and
        # REPEATABLE READ snapshot would keep returning the lease as it was when
        # the cycle started, so a steal mid-cycle would go unnoticed.
        with db.engine.connect() as conn:
            value = conn.execute(
                db.select(AppSetting.value).where(AppSetting.key == _SCHEDULER_LEASE_KEY)
            ).scalar()
        if value is None:
            return False
        try:
            owner, _hb = value.rsplit(':', 1)
        except Exception:
            owner, _hb = '', 0
        return owner == _SCHEDULER_INSTANCE_ID
    except Exception as e:
        print(f'[SCHEDULER] Lease ownership check failed (failing closed): {e}')
        return False

def _scheduler_watchdog_loop():
    """Per-worker watchdog: keep trying to own the lease; run the scheduler iff
    we own it. The loop itself IS the heartbeat — if this thread (or the whole
    process) stalls, the lease goes stale and another worker takes over."""
    global _scheduler_lease_confirmed_at
    while True:
        # Worker is shutting down: stop running/re-starting the scheduler and
        # let this watchdog thread exit so it can't resurrect jobs mid-teardown.
        if _scheduler_shutting_down:
            return
        owns = None
        try:
            with app.app_context():
                owns = _scheduler_acquire_or_refresh_lease()
                try:
                    db.session.remove()
                except Exception:
                    pass
        except Exception as e:
            print(f'[SCHEDULER] Watchdog iteration error: {e}')
        if owns:
            _scheduler_lease_confirmed_at = time.monotonic()
        elif owns is None:
            # Ownership unknown (transient DB error): keep the current state.
            # Jobs stay fenced by _scheduler_owns_lease(); only give up once no
            # refresh has succeeded for as long as other workers wait before
            # treating our heartbeat as stale.
            if _scheduler_started and time.monotonic() - _scheduler_lease_confirmed_at > SCHEDULER_LEASE_TIMEOUT:
                print(f'[SCHEDULER] Lease not refreshed for over {SCHEDULER_LEASE_TIMEOUT}s')
                owns = False
            else:
                owns = _scheduler_started
        try:
            if _scheduler_shutting_down:
                return
            if owns and not _scheduler_started:
                _build_and_start_scheduler_jobs()
            elif not owns and _scheduler_started:
                print('[SCHEDULER] Lost lease — stopping local scheduler to avoid double-scheduling')
                _stop_scheduler_jobs()
        except Exception as e:
            print(f'[SCHEDULER] Watchdog start/stop error: {e}')
        time.sleep(SCHEDULER_HEARTBEAT_INTERVAL)

def start_scheduler():
    """Entry point (called once per worker from gunicorn post_fork and from the
    dev-server __main__ path). Starts the failover watchdog thread; the watchdog
    decides — via the DB lease + flock — whether THIS worker runs the scheduler."""
    global _scheduler_watchdog_thread
    if _scheduler_watchdog_thread is not None and _scheduler_watchdog_thread.is_alive():
        return
    _scheduler_watchdog_thread = threading.Thread(
        target=_scheduler_watchdog_loop, name='scheduler-watchdog', daemon=True)
    _scheduler_watchdog_thread.start()
    print(f'[SCHEDULER] Failover watchdog started (instance={_SCHEDULER_INSTANCE_ID}, '
          f'lease_timeout={SCHEDULER_LEASE_TIMEOUT}s, heartbeat={SCHEDULER_HEARTBEAT_INTERVAL}s)')
    # Fallback for the dev-server __main__ path (no gunicorn worker hooks). For
    # gunicorn workers the SIGTERM/SIGINT handlers wired in gunicorn.conf.py stop
    # the scheduler earlier, while the interpreter is still fully alive; the
    # lease release is a DB write and so always waits for this exit hook.
    try:
        import atexit as _atexit
        _atexit.register(_scheduler_exit_hook)
    except Exception:
        pass

# ──────────────────────────────────────────────────────────────
# Notes App Routes (/notes/) - E2EE encrypted notes
# ──────────────────────────────────────────────────────────────

