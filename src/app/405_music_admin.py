# ─── Admin: Music tab ───────────────────────────────────────────────────────
# Status and controls for the music pipeline. The music worker
# (music_worker.py) does the work; these routes read its state and write the
# controls it obeys: the global switches are AppSettings
# (music_discovery_enabled / music_downloads_enabled, saved through
# /admin/api/settings), the per-worker toggles are MusicWorker rows.

# Matches WORKER_ONLINE_S in src/music_worker/100_runner.py.
_MUSIC_WORKER_ONLINE_S = 60
_MUSIC_MONITORED_MODES = ('new_only', 'top_tracks', 'essentials', 'discography', 'everything')
# Matches MODE_RANK in src/music_worker/080_discovery.py.
_MUSIC_MODE_RANK = {'off': 0, 'new_only': 1, 'top_tracks': 2, 'essentials': 3, 'discography': 4, 'everything': 5}
_MUSIC_RULE_MODES = ('blocked',) + tuple(_MUSIC_MODE_RANK)
_MUSIC_MAX_WEIGHT = 5.0
_MUSIC_TOP_ARTISTS = 50
_MUSIC_SEARCH_LIMIT = 20
_MUSIC_GENRE_HINTS = 80
_MUSIC_PROXY_SCHEMES = ('socks5h', 'socks5', 'socks4a', 'socks4', 'http', 'https')
_MUSIC_PROXY_MAX_LINES = 500


def _music_parse_proxy(line):
    """(url, label) for one proxy line, or ValueError. Accepts a URL
    (socks5://user:pass@host:port), host:port, user:pass@host:port or
    host:port:user:pass; no scheme means socks5h (DNS through the proxy)."""
    from urllib.parse import quote, unquote, urlsplit
    text = line.strip()
    if '://' not in text:
        parts = text.split(':')
        if '@' not in text and len(parts) == 4:
            text = f'{parts[2]}:{parts[3]}@{parts[0]}:{parts[1]}'
        text = f'socks5h://{text}'
    try:
        parsed = urlsplit(text)
        port = parsed.port
    except ValueError:
        raise ValueError('INVALID PORT')
    scheme = parsed.scheme.lower()
    if scheme not in _MUSIC_PROXY_SCHEMES:
        raise ValueError(f'UNSUPPORTED TYPE {scheme.upper()}; USE SOCKS5, SOCKS4 OR HTTP')
    host = parsed.hostname
    if not host or not port:
        raise ValueError('NEEDS HOST AND PORT')
    host_part = f'[{host}]' if ':' in host else host
    user = unquote(parsed.username) if parsed.username else ''
    password = unquote(parsed.password) if parsed.password else ''
    auth = f'{quote(user, safe="")}:{quote(password, safe="")}@' if user else ''
    return f'{scheme}://{auth}{host_part}:{port}', f'{scheme}://{user + "@" if user else ""}{host_part}:{port}'


def _music_proxy_json(row, now):
    paused = row.paused_until.replace(tzinfo=timezone.utc) if row.paused_until else None
    today = row.day == now.date()
    return {'id': row.id, 'label': row.label, 'enabled': bool(row.enabled), 'status': row.status,
            'last_error': row.last_error, 'paused_until': paused.isoformat() if paused and paused > now else None,
            'requests_today': row.requests_today if today else 0,
            'downloads_today': row.downloads_today if today else 0}


def _music_library_snapshot():
    """Counts, songs added today per worker, recent additions and the last
    roster build, read from library.db."""
    snap = {'songs': 0, 'artists': 0, 'albums': 0, 'bytes': 0, 'added_today': 0,
            'added_by_worker': {}, 'recent': [], 'roster_at': None, 'charts_at': None}
    if not _music_library_available():
        return snap
    conn = _get_music_db()
    try:
        snap['artists'] = conn.execute('SELECT COUNT(*) FROM artists').fetchone()[0]
        snap['albums'] = conn.execute('SELECT COUNT(*) FROM albums').fetchone()[0]
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'").fetchone():
            snap['songs'] = conn.execute('SELECT COUNT(*) FROM songs').fetchone()[0]
            return snap
        count, size = conn.execute('SELECT COUNT(*), COALESCE(SUM(size), 0) FROM files').fetchone()
        snap['songs'], snap['bytes'] = count, size
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        snap['added_by_worker'] = {row[0]: row[1] for row in conn.execute(
            'SELECT worker, COUNT(*) FROM files WHERE created_at >= ? GROUP BY worker', [today])}
        snap['added_today'] = sum(snap['added_by_worker'].values())
        snap['recent'] = [dict(row) for row in conn.execute('''
            SELECT s.id, s.title, f.created_at AS added, a.cover_path,
                   (SELECT ar.name FROM song_artists sa JOIN artists ar ON ar.id = sa.artist_id
                    WHERE sa.song_id = s.id AND sa.role = 'primary' LIMIT 1) AS artist
            FROM files f JOIN songs s ON s.id = f.song_id LEFT JOIN albums a ON a.id = s.album_id
            ORDER BY f.created_at DESC LIMIT 8''')]
        for key in ('roster_at', 'charts_at'):
            meta = conn.execute('SELECT value FROM _meta WHERE key = ?', [key]).fetchone()
            snap[key] = meta[0] if meta else None
        return snap
    finally:
        conn.close()


def _music_effective_mode(artist):
    """Same rule as effective_mode() in the worker: admin rule, else discovery's
    mode raised to its floor."""
    if artist.rule_mode:
        return artist.rule_mode
    mode = artist.auto_mode or 'off'
    if artist.floor_mode and _MUSIC_MODE_RANK.get(artist.floor_mode, 0) > _MUSIC_MODE_RANK.get(mode, 0):
        mode = artist.floor_mode
    return mode


def _music_iso(value):
    return value.replace(tzinfo=timezone.utc).isoformat() if value else None


def _music_artist_json(artist):
    return {'id': artist.id, 'name': artist.name, 'score': round(artist.score or 0, 3),
            'mode': _music_effective_mode(artist), 'rule_mode': artist.rule_mode,
            'rule_weight': artist.rule_weight, 'genres': artist.genres, 'seeds': artist.seeds,
            'fans': artist.nb_fan, 'have': artist.have, 'wanted': artist.wanted,
            'scanned_at': _music_iso(artist.scanned_at)}


@app.route('/admin/api/music')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music():
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(seconds=_MUSIC_WORKER_ONLINE_S)
    library = _music_library_snapshot()
    workers = []
    discovery_worker = None
    for row in MusicWorker.query.order_by(MusicWorker.id.asc()).all():
        seen = row.last_seen.replace(tzinfo=timezone.utc) if row.last_seen else None
        online = bool(seen and seen >= cutoff)
        if online and row.discover_enabled and discovery_worker is None:
            discovery_worker = row.id
        workers.append({
            'id': row.id, 'name': row.name, 'version': row.version, 'online': online,
            'seen_ago': int((now - seen).total_seconds()) if seen else None,
            'discover_enabled': bool(row.discover_enabled), 'download_enabled': bool(row.download_enabled),
            'discover_status': row.discover_status, 'download_status': row.download_status,
            'added_today': library['added_by_worker'].get(row.name, 0),
        })
    for worker in workers:
        worker['runs_discovery'] = worker['id'] == discovery_worker

    open_states = ('ready', 'leased')
    by_bucket = {int(bucket): count for bucket, count in db.session.query(MusicJob.bucket, db.func.count())
                 .filter(MusicJob.state.in_(open_states)).group_by(MusicJob.bucket).all()}
    retrying = MusicJob.query.filter(MusicJob.state == 'ready', MusicJob.attempts > 0,
                                     MusicJob.run_after > now).count()
    working = MusicJob.query.filter(MusicJob.state == 'leased').count()
    problems = [{'code': code, 'count': count} for code, count in db.session.query(MusicJob.error_code, db.func.count())
                .filter(MusicJob.state.in_(open_states), MusicJob.attempts > 0, MusicJob.error_code.isnot(None))
                .group_by(MusicJob.error_code).order_by(db.func.count().desc()).all()]
    artists = MusicArtist.query.with_entities(MusicArtist.rule_mode, MusicArtist.auto_mode, MusicArtist.floor_mode,
                                              MusicArtist.genres).all()
    modes, genre_counts = {}, {}
    for artist in artists:
        mode = _music_effective_mode(artist)
        modes[mode] = modes.get(mode, 0) + 1
        for genre in (artist.genres or '').split(','):
            if genre.strip():
                genre_counts[genre.strip()] = genre_counts.get(genre.strip(), 0) + 1
    due = MusicArtist.query.filter(MusicArtist.next_scan_at.isnot(None), MusicArtist.next_scan_at <= now).count()
    top = MusicArtist.query.filter(MusicArtist.score > 0).order_by(MusicArtist.score.desc()).limit(_MUSIC_TOP_ARTISTS).all()
    ruled = MusicArtist.query.filter(db.or_(MusicArtist.rule_mode.isnot(None), MusicArtist.rule_weight != 1.0)) \
        .order_by(MusicArtist.name).all()
    q = (request.args.get('q') or '').strip()[:100]
    found = None
    if q:
        pattern = '%' + q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        found = [_music_artist_json(a) for a in MusicArtist.query.filter(MusicArtist.name.ilike(pattern, escape='\\'))
                 .order_by(MusicArtist.score.desc()).limit(_MUSIC_SEARCH_LIMIT).all()]
    genre_rules = MusicGenreRule.query.order_by(MusicGenreRule.weight.desc(), MusicGenreRule.genre).all()
    sources = [{'source': b.source, 'used': b.used, 'errors': b.errors, 'slow': b.slow,
                'paused_until': b.paused_until.replace(tzinfo=timezone.utc).isoformat()
                if b.paused_until and b.paused_until.replace(tzinfo=timezone.utc) > now else None}
               for b in MusicSourceBudget.query.filter_by(day=now.date()).order_by(MusicSourceBudget.source).all()]
    return jsonify({
        'switches': {'discovery': bool(get_setting('music_discovery_enabled')),
                     'downloads': bool(get_setting('music_downloads_enabled'))},
        'limits': {'daily': get_numeric_setting('music_dl_daily_cap'),
                   'size_gb': get_numeric_setting('music_library_cap_gb')},
        'workers': workers,
        'library': {k: library[k] for k in ('songs', 'artists', 'albums', 'bytes', 'added_today', 'recent')},
        'queue': {'buckets': by_bucket, 'total': sum(by_bucket.values()), 'retrying': retrying, 'working': working},
        'problems': problems,
        'roster': {'artists': len(artists), 'monitored': sum(n for m, n in modes.items() if m in _MUSIC_MONITORED_MODES),
                   'modes': modes, 'due': due, 'built_at': library['roster_at'], 'charts_at': library['charts_at'],
                   'top': [_music_artist_json(a) for a in top]},
        'rules': {'artists': [_music_artist_json(a) for a in ruled],
                  'genres': [{'id': r.id, 'genre': r.genre, 'weight': r.weight} for r in genre_rules],
                  'genre_hints': sorted(genre_counts, key=genre_counts.get, reverse=True)[:_MUSIC_GENRE_HINTS],
                  'search': found},
        'sources': sources,
        'direct': bool(get_setting('music_proxy_direct')),
        'proxies': [_music_proxy_json(p, now) for p in MusicProxy.query.order_by(MusicProxy.id.asc()).all()],
    })


@app.route('/admin/api/music/workers/<int:worker_id>', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_worker_update(worker_id):
    """Turn discovery and/or downloads on or off for one worker."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    changes = {}
    for key in ('discover_enabled', 'download_enabled'):
        if key in data:
            if not isinstance(data[key], bool):
                return jsonify({'error': f'{key.upper()} MUST BE A BOOLEAN'}), 400
            changes[key] = data[key]
    if not changes:
        return jsonify({'error': 'NOTHING TO CHANGE'}), 400
    worker = db.session.get(MusicWorker, worker_id)
    if worker is None:
        return jsonify({'error': 'WORKER NOT FOUND'}), 404
    for key, value in changes.items():
        setattr(worker, key, value)
    db.session.commit()
    print(f'[ADMIN] Music worker {worker.name}: {changes}')
    return jsonify({'success': True})


@app.route('/admin/api/music/workers/<int:worker_id>', methods=['DELETE'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_worker_remove(worker_id):
    """Forget an offline worker (it re-registers if it comes back)."""
    worker = db.session.get(MusicWorker, worker_id)
    if worker is None:
        return jsonify({'error': 'WORKER NOT FOUND'}), 404
    seen = worker.last_seen.replace(tzinfo=timezone.utc) if worker.last_seen else None
    if seen and seen >= datetime.now(timezone.utc) - timedelta(seconds=_MUSIC_WORKER_ONLINE_S):
        return jsonify({'error': 'WORKER IS ONLINE. TURN IT OFF OR STOP IT FIRST.'}), 409
    db.session.delete(worker)
    db.session.commit()
    print(f'[ADMIN] Music worker {worker.name} removed')
    return jsonify({'success': True})


@app.route('/admin/api/music/retry', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_retry():
    """Make every song waiting for a retry due now."""
    count = MusicJob.query.filter(MusicJob.state == 'ready', MusicJob.attempts > 0,
                                  MusicJob.run_after > datetime.now(timezone.utc)) \
        .update({MusicJob.run_after: None}, synchronize_session=False)
    db.session.commit()
    print(f'[ADMIN] Music: {count} songs set to retry now')
    return jsonify({'success': True, 'count': count})


@app.route('/admin/api/music/proxies', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_proxies_add():
    """Add proxies, one per line. Valid lines are added; the rest are reported."""
    data = request.get_json(silent=True)
    text = data.get('text') if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip():
        return jsonify({'error': 'PASTE AT LEAST ONE PROXY'}), 400
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith('#')]
    if len(lines) > _MUSIC_PROXY_MAX_LINES:
        return jsonify({'error': f'AT MOST {_MUSIC_PROXY_MAX_LINES} PROXIES AT ONCE'}), 400
    known = {p.label for p in MusicProxy.query.with_entities(MusicProxy.label).all()}
    added, duplicates, rejected = 0, 0, []
    for number, line in enumerate(lines, 1):
        try:
            url, label = _music_parse_proxy(line)
        except ValueError as e:
            rejected.append({'line': number, 'error': str(e)})
            continue
        if label in known:
            duplicates += 1
            continue
        known.add(label)
        db.session.add(MusicProxy(url_enc=fernet.encrypt(url.encode()).decode(), label=label[:300]))
        added += 1
    db.session.commit()
    print(f'[ADMIN] Music proxies: {added} added, {duplicates} already listed, {len(rejected)} rejected')
    return jsonify({'success': True, 'added': added, 'duplicates': duplicates, 'rejected': rejected})


@app.route('/admin/api/music/proxies/<int:proxy_id>', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_proxy_update(proxy_id):
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get('enabled'), bool):
        return jsonify({'error': 'ENABLED MUST BE A BOOLEAN'}), 400
    proxy = db.session.get(MusicProxy, proxy_id)
    if proxy is None:
        return jsonify({'error': 'PROXY NOT FOUND'}), 404
    proxy.enabled = data['enabled']
    db.session.commit()
    print(f'[ADMIN] Music proxy {proxy.label} {"enabled" if proxy.enabled else "disabled"}')
    return jsonify({'success': True})


@app.route('/admin/api/music/proxies/<int:proxy_id>', methods=['DELETE'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_proxy_remove(proxy_id):
    proxy = db.session.get(MusicProxy, proxy_id)
    if proxy is None:
        return jsonify({'error': 'PROXY NOT FOUND'}), 404
    db.session.delete(proxy)
    db.session.commit()
    print(f'[ADMIN] Music proxy {proxy.label} removed')
    return jsonify({'success': True})


def _music_weight(value):
    """A rule weight from JSON, or None when it is not a number in (0, _MUSIC_MAX_WEIGHT]."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if 0 < value <= _MUSIC_MAX_WEIGHT else None


@app.route('/admin/api/music/artists/<int:artist_id>', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_artist_rule(artist_id):
    """Set an artist's rule: mode (null = discovery decides) and/or weight.
    The artist is re-scanned on the worker's next pass."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not ('mode' in data or 'weight' in data):
        return jsonify({'error': 'NOTHING TO CHANGE'}), 400
    mode = data.get('mode')
    if 'mode' in data and mode is not None and mode not in _MUSIC_RULE_MODES:
        return jsonify({'error': 'UNKNOWN MODE'}), 400
    weight = _music_weight(data.get('weight')) if 'weight' in data else None
    if 'weight' in data and weight is None:
        return jsonify({'error': f'WEIGHT MUST BE A NUMBER ABOVE 0 AND AT MOST {_MUSIC_MAX_WEIGHT:g}'}), 400
    artist = db.session.get(MusicArtist, artist_id)
    if artist is None:
        return jsonify({'error': 'ARTIST NOT FOUND'}), 404
    now = datetime.now(timezone.utc)
    if 'mode' in data:
        artist.rule_mode = mode
    if weight is not None:
        artist.rule_weight = weight
    artist.next_scan_at = now
    if artist.monitored_since is None and _music_effective_mode(artist) in _MUSIC_MONITORED_MODES:
        artist.monitored_since = now
    db.session.commit()
    print(f'[ADMIN] Music artist {artist.name}: mode {artist.rule_mode or "auto"}, weight {artist.rule_weight:g}')
    return jsonify({'success': True, 'artist': _music_artist_json(artist)})


@app.route('/admin/api/music/genres', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_genre_rule():
    """Set a genre weight (0 blocks the genre; 1 removes the rule)."""
    data = request.get_json(silent=True)
    genre = data.get('genre') if isinstance(data, dict) else None
    if not isinstance(genre, str) or not genre.strip() or len(genre.strip()) > 64:
        return jsonify({'error': 'GENRE NAME IS REQUIRED (AT MOST 64 CHARACTERS)'}), 400
    genre = genre.strip()
    value = data.get('weight')
    weight = 0.0 if value == 0 and not isinstance(value, bool) else _music_weight(value)
    if weight is None:
        return jsonify({'error': f'WEIGHT MUST BE 0 TO {_MUSIC_MAX_WEIGHT:g}'}), 400
    rule = MusicGenreRule.query.filter(db.func.lower(MusicGenreRule.genre) == genre.lower()).first()
    if weight == 1.0:
        if rule is not None:
            db.session.delete(rule)
    elif rule is None:
        db.session.add(MusicGenreRule(genre=genre, weight=weight))
    else:
        rule.weight = weight
    db.session.commit()
    print(f'[ADMIN] Music genre {genre}: weight {weight:g}')
    return jsonify({'success': True})


@app.route('/admin/api/music/genres/<int:rule_id>', methods=['DELETE'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_genre_remove(rule_id):
    rule = db.session.get(MusicGenreRule, rule_id)
    if rule is None:
        return jsonify({'error': 'GENRE RULE NOT FOUND'}), 404
    db.session.delete(rule)
    db.session.commit()
    print(f'[ADMIN] Music genre rule {rule.genre} removed')
    return jsonify({'success': True})
