# The service: one discovery thread, acquire threads and housekeeping, each
# checking the admin switches before every unit of work. Plus the CLI.

# Download threads per egress (YouTube limits each IP separately), up to the max.
ACQUIRE_THREADS_PER_EGRESS = 2
MAX_ACQUIRE_THREADS = 16
DISK_CHECK_EVERY = 300
HEARTBEAT_EVERY = 10
# A worker not seen for this long is offline (and loses the discovery role).
WORKER_ONLINE_S = 60
STARTED_AT = now()


def _due(meta_key, every):
    stamp = meta_get(meta_key)
    if not stamp:
        return True
    try:
        return now() - datetime.fromisoformat(stamp) >= every
    except ValueError:
        return True


_DISK = {'checked': 0.0, 'ok': True, 'why': ''}


def disk_ok():
    """False while the library is at its size cap or the pool is under 20% free."""
    if time.time() - _DISK['checked'] < DISK_CHECK_EVERY:
        return _DISK['ok'], _DISK['why']
    cap = setting_int('music_library_cap_gb') * 1024 ** 3
    used = lib_stats()['bytes']
    usage = shutil.disk_usage(LIB_DIR)
    ok, why = True, ''
    if used >= cap:
        ok, why = False, f'library is at its size limit ({used / 1024 ** 3:.1f} GB)'
    elif usage.free / usage.total < MIN_FREE_FRACTION:
        ok, why = False, f'disk is under {int(MIN_FREE_FRACTION * 100)}% free'
    if ok != _DISK['ok']:
        log(f'downloads {"resumed" if ok else "paused: " + why}')
    _DISK.update(checked=time.time(), ok=ok, why=why)
    return ok, why


def resume_at(error):
    """When work blocked by `error` can go on: soon if another egress is free."""
    try:
        pick(error.source)
        return time.time() + 5
    except SourcePaused as e:
        return e.until


def _wait_paused(error, cap=600):
    STOP.wait(max(5.0, min(resume_at(error) - time.time(), cap)))


def _no_connection():
    return None if egresses() else 'No connection: this server is off and no proxy is on'


def _until(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime('%H:%M UTC')


def heartbeat(stopping=False):
    """Report this worker's status and read back its admin toggles. Discovery
    runs only on the oldest online worker that has it on."""
    activity = dict(ACTIVITY)
    downloads = [activity[k] for k in sorted(activity) if k.startswith('acquire')]
    download_status = next((a for a in downloads if a.startswith('Downloading')), None) \
        or (downloads[0] if downloads else 'Starting')
    if not stopping:
        egress_refresh()
    t = now()
    with app.app_context():
        row = MusicWorker.query.filter_by(name=WORKER_NAME).first()
        if row is None:
            row = MusicWorker(name=WORKER_NAME)
            db.session.add(row)
        row.version = WORKER_VERSION
        row.started_at = STARTED_AT
        # A clean stop shows as offline at once instead of after WORKER_ONLINE_S.
        row.last_seen = t - timedelta(seconds=WORKER_ONLINE_S + 1) if stopping else t
        row.discover_status = ('Stopped' if stopping else activity.get('discovery', 'Starting'))[:300]
        row.download_status = ('Stopped' if stopping else download_status)[:300]
        db.session.commit()
        WORKER_FLAGS['discover'] = bool(row.discover_enabled)
        WORKER_FLAGS['download'] = bool(row.download_enabled)
        leader = MusicWorker.query.filter(MusicWorker.discover_enabled.is_(True),
                                          MusicWorker.last_seen >= t - timedelta(seconds=WORKER_ONLINE_S)) \
            .order_by(MusicWorker.id.asc()).first()
        WORKER_FLAGS['leader'] = bool(leader and leader.id == row.id and not stopping)


def heartbeat_loop():
    while not STOP.wait(HEARTBEAT_EVERY):
        try:
            heartbeat()
        except Exception as e:
            log(f'heartbeat error: {e}')


def _discovery_allowed():
    if not setting_on('music_discovery_enabled'):
        return 'Off'
    if not WORKER_FLAGS['discover']:
        return 'Off on this worker'
    if not WORKER_FLAGS['leader']:
        return 'Standing by: another worker runs discovery'
    return _no_connection()


def discovery_loop():
    floored = frozenset()
    while not STOP.is_set():
        try:
            blocked = _discovery_allowed()
            if blocked:
                set_activity(blocked)
            else:
                if _due('roster_at', ROSTER_EVERY) or meta_get('roster_rules') != rules_signature():
                    set_activity('Ranking artists')
                    roster_build()
                if _due('charts_at', CHARTS_EVERY):
                    set_activity('Checking the charts')
                    charts_scan()
                listened = _listened_artist_ids()
                if listened - floored:
                    listened_floors(listened - floored)
                floored = listened
                due = artists_due()
                for artist_id in due:
                    if STOP.is_set() or _discovery_allowed():
                        break
                    artist_sync(artist_id)
                if not _discovery_allowed():
                    left = artists_due_count()
                    set_activity(f'Scanning artists: {left:,} left' if left else 'Up to date')
        except DiscoveryStopped:
            continue
        except SourcePaused as e:
            log(f'discovery waiting: {e}')
            set_activity(f'Waiting for {e.source} until {_until(e.until)}')
            _wait_paused(e)
            continue
        except Exception:
            import traceback
            log(f'discovery error: {traceback.format_exc(limit=5)}')
            STOP.wait(60)
        STOP.wait(30)


def acquire_loop(index):
    while not STOP.is_set():
        try:
            if index >= ACQUIRE_THREADS_PER_EGRESS * max(1, len(egresses())):
                ACTIVITY.pop(threading.current_thread().name, None)
                STOP.wait(HEARTBEAT_EVERY)
                continue
            if not setting_on('music_downloads_enabled') or not WORKER_FLAGS['download']:
                set_activity('Off' if not setting_on('music_downloads_enabled') else 'Off on this worker')
                STOP.wait(HEARTBEAT_EVERY)
                continue
            ok, why = disk_ok()
            if not ok:
                set_activity(f'Paused: {why}')
                STOP.wait(60)
                continue
            if _no_connection():
                set_activity(_no_connection())
                STOP.wait(HEARTBEAT_EVERY)
                continue
            try:
                pick('youtube')
            except SourcePaused as e:
                capped = all(eg.sources['youtube'].capped() for eg in egresses())
                set_activity('Daily download limit reached on every connection' if capped
                             else f'Waiting for YouTube until {_until(e.until)}')
                _wait_paused(e, cap=60)
                continue
            jobs = jobs_lease(1)
            if not jobs:
                set_activity('Idle: nothing queued')
                STOP.wait(30)
                continue
            acquire(jobs[0])
        except Exception:
            import traceback
            log(f'acquire loop error: {traceback.format_exc(limit=5)}')
            STOP.wait(30)


def rescore_due(state):
    """Re-score the queue: all of it when a download-order setting or rule
    changed; hourly the boosted songs (boosts run out by the day) and the songs
    of artists that started or stopped counting as listened."""
    cfg = priority_config()
    signature = priority_signature(cfg)
    if signature != meta_get('prio_sig'):
        log(f'queue: settings changed; re-scored {jobs_rescore(cfg=cfg):,} songs')
        meta_set('prio_sig', signature)
        meta_set('listened_scored', json.dumps(sorted(cfg['listened_ids'])))
        state['hot'] = time.time()
    elif time.time() - state['hot'] >= 3600:
        changed = jobs_rescore(hot_only=True, cfg=cfg)
        if changed:
            log(f'queue: {changed} songs changed boost')
        moved = cfg['listened_ids'] ^ frozenset(json.loads(meta_get('listened_scored') or '[]'))
        if moved:
            changed = jobs_rescore(artists=moved, cfg=cfg)
            meta_set('listened_scored', json.dumps(sorted(cfg['listened_ids'])))
            if changed:
                log(f'queue: {changed} songs changed listened boost')
        state['hot'] = time.time()


def housekeeping_loop():
    last_report = 0.0
    rescore_state = {'hot': 0.0}
    while not STOP.wait(60):
        try:
            reaped = jobs_reap()
            if reaped:
                log(f'returned {reaped} expired leases to the queue')
            rescore_due(rescore_state)
            flush_budgets()
            if setting_on('music_downloads_enabled'):
                ytdlp_maybe_update()
            if time.time() - last_report >= 3600:
                last_report = time.time()
                s = status()
                log(f'status: library {s["library"]["songs"]} songs / {s["library"]["bytes"] / 1024 ** 3:.1f} GB; '
                    f'queue {s["jobs"]["open_by_bucket"]}; monitored artists {s["roster"]["monitored"]}')
        except Exception as e:
            log(f'housekeeping error: {e}')


def status():
    with app.app_context():
        artists = MusicArtist.query.all()
        modes = {}
        for artist in artists:
            mode = effective_mode(artist)
            modes[mode] = modes.get(mode, 0) + 1
    sources = {eg.label: {'status': eg.status, 'downloads_today': eg.sources['youtube'].used,
                          'requests_today': sum(s.used for n, s in eg.sources.items() if n != 'youtube'),
                          'paused': sorted(n for n, s in eg.sources.items() if s.paused_until > time.time())}
               for eg in egresses()}
    return {'library': lib_stats(), 'jobs': jobs_summary(),
            'roster': {'artists': len(artists), 'monitored': sum(n for m, n in modes.items() if m in MONITORED),
                       'modes': modes},
            'switches': {'discovery': setting_on('music_discovery_enabled'),
                         'downloads': setting_on('music_downloads_enabled')},
            'sources': sources}


def run():
    def stop(signum, _frame):
        log(f'stopping (signal {signum})')
        STOP.set()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    jobs_release_mine()
    heartbeat()
    log(f'worker {WORKER_NAME} ({WORKER_ID}) started; library {LIB_DIR}')
    # Before the download threads start, so no job's payload changes under them.
    jobs_migrate()
    threads = [threading.Thread(target=discovery_loop, name='discovery', daemon=True),
               threading.Thread(target=housekeeping_loop, name='housekeeping', daemon=True),
               threading.Thread(target=heartbeat_loop, name='heartbeat', daemon=True)]
    threads += [threading.Thread(target=acquire_loop, args=(i,), name=f'acquire-{i}', daemon=True)
                for i in range(MAX_ACQUIRE_THREADS)]
    for thread in threads:
        thread.start()
    while not STOP.wait(1):
        pass
    for thread in threads:
        thread.join(timeout=120)
    jobs_release_mine()
    flush_budgets()
    heartbeat(stopping=True)
    log('stopped')


def _ensure_artist_rule(dz_id, mode):
    info = dz_artist(dz_id)
    if not info:
        raise SystemExit(f'Deezer artist {dz_id} not found')
    with app.app_context():
        artist = MusicArtist.query.filter_by(deezer_id=int(dz_id)).first()
        if artist is None:
            artist = MusicArtist(deezer_id=int(dz_id), name=info['name'], nb_fan=info.get('nb_fan') or 0,
                                 created_at=now())
            db.session.add(artist)
        if mode:
            artist.rule_mode = mode
        if artist.monitored_since is None:
            artist.monitored_since = now()
        db.session.commit()
        return artist.id


def _out(text):
    """CLI output, bypassing the app's single-line stdout wrapper."""
    sys.__stdout__.write(f'{text}\n')
    sys.__stdout__.flush()


def main():
    args = sys.argv[1:] or ['run']
    command = args[0]
    lib_init()
    egress_refresh()
    try:
        if command == 'run':
            run()
        elif command == 'status':
            _out(json.dumps(status(), indent=2, default=str))
        elif command == 'roster':
            roster_build()
        elif command == 'sync-artist' and len(args) >= 2:
            mode = args[2] if len(args) > 2 else None
            if mode and mode not in MODE_RANK and mode != 'blocked':
                raise SystemExit(f'unknown mode {mode}; one of {", ".join(list(MODE_RANK) + ["blocked"])}')
            _out(f'queued {artist_sync(_ensure_artist_rule(args[1], mode))} songs')
        elif command == 'acquire' and len(args) >= 2:
            key = f'dz:{int(args[1])}'
            jobs_upsert([{'dedupe_key': key, 'norm_key': None, 'artist_dz': None, 'bucket': 0, 'priority': 1e9,
                          'payload': {'track_id': int(args[1]), 'version': None}}])
            with app.app_context():
                job = MusicJob.query.filter_by(dedupe_key=key).first()
                if job.state not in OPEN_STATES:
                    raise SystemExit(f'track already handled: {job.state} {job.song_id or ""} {job.error_code or ""}')
                job.state, job.run_after = 'ready', None
                db.session.commit()
            leased = [j for j in jobs_lease(5) if j['payload'].get('track_id') == int(args[1])]
            if not leased:
                raise SystemExit('could not lease the job (another worker has it?)')
            acquire(leased[0])
            with app.app_context():
                job = MusicJob.query.filter_by(dedupe_key=key).first()
                _out(json.dumps({'state': job.state, 'song_id': job.song_id, 'error': job.error_code,
                                 'detail': job.error_detail}, indent=2))
        else:
            _out(__doc__)
            raise SystemExit(2)
    finally:
        jobs_release_mine()
        flush_budgets()
