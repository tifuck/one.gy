# Discovery (plan section 8): which artists are monitored, and which of their
# songs are wanted. The roster is rebuilt weekly from free popularity data;
# each monitored artist's catalogue is re-scanned on a schedule and every
# missing song is queued in a priority bucket.

# Effective mode order, for floors ("at least Essentials").
MODE_RANK = {'off': 0, 'new_only': 1, 'top_tracks': 2, 'essentials': 3, 'discography': 4, 'everything': 5}
MONITORED = ('new_only', 'top_tracks', 'essentials', 'discography', 'everything')
# Discovery modes by roster rank.
ROSTER_TIERS = ((500, 'discography'), (2500, 'essentials'), (7500, 'top_tracks'))
CHART_REGIONS = ('us', 'gb', 'ca', 'au')
ROSTER_EVERY = timedelta(days=7)
CHARTS_EVERY = timedelta(hours=6)
FRESH_DAYS = 14
# Buckets (plan 8.4). P0 user requests and P6 re-checks are not produced yet.
P_FRESH, P_TOP10, P_DISCOGRAPHY, P_ESSENTIALS, P_TOP_TRACKS = 1, 2, 3, 4, 5
TOP_LIMIT = {'top_tracks': 10, 'essentials': 25}


def effective_mode(artist):
    if artist.rule_mode:
        return artist.rule_mode
    mode = artist.auto_mode or 'off'
    if artist.floor_mode and MODE_RANK.get(artist.floor_mode, 0) > MODE_RANK.get(mode, 0):
        mode = artist.floor_mode
    return mode


def _genre_weights():
    with app.app_context():
        return {fold(r.genre): r.weight for r in MusicGenreRule.query.all()}


def artist_weight(artist, genre_weights):
    """Admin artist weight x the strongest weight among the artist's genres (0 = blocked genre)."""
    weight = artist.rule_weight or 1.0
    genres = [fold(g) for g in (artist.genres or '').split(',') if g]
    matched = [genre_weights[g] for g in genres if g in genre_weights]
    if matched:
        weight *= 0.0 if min(matched) == 0 else max(matched)
    return weight


def _dz_artist_for(name, mbid, known):
    """Deezer artist for a ListenBrainz artist: the exact name with the most fans.
    shortcut: matches by name only; add an ISRC overlap check if namesakes show up in the roster."""
    if mbid and mbid in known:
        return known[mbid]
    folded = fold(name)
    best = None
    for hit in dz_search_artist(name):
        if fold(hit.get('name')) == folded and (best is None or hit.get('nb_fan', 0) > best.get('nb_fan', 0)):
            best = hit
    return {'id': best['id'], 'name': best['name'], 'nb_fan': best.get('nb_fan', 0)} if best else None


def _liked_artist_ids():
    """Deezer ids of the primary artists of every liked or playlisted song."""
    with app.app_context():
        song_ids = {r[0] for r in db.session.query(MusicLike.song_id).distinct()}
        song_ids |= {r[0] for r in db.session.query(MusicPlaylistSong.song_id).distinct()}
    if not song_ids or not os.path.isfile(LIB_DB):
        return set()
    conn = lib_connect()
    try:
        found = set()
        ids = list(song_ids)
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            rows = conn.execute(f'''SELECT DISTINCT a.deezer_id FROM song_artists sa JOIN artists a ON a.id = sa.artist_id
                                    WHERE sa.role = 'primary' AND a.deezer_id IS NOT NULL
                                    AND sa.song_id IN ({','.join('?' * len(chunk))})''', chunk).fetchall()
            found |= {r[0] for r in rows}
        return found
    finally:
        conn.close()


def _percentiles(values):
    """value -> percentile in [0, 1] (1 = highest)."""
    ordered = sorted(set(values))
    if len(ordered) < 2:
        return {v: 1.0 for v in ordered}
    return {v: i / (len(ordered) - 1) for i, v in enumerate(ordered)}


def roster_build():
    """Rank candidate artists and set their discovery modes."""
    log('roster: rebuilding')
    with app.app_context():
        known = {a.mbid: {'id': a.deezer_id, 'name': a.name, 'nb_fan': a.nb_fan}
                 for a in MusicArtist.query.filter(MusicArtist.mbid.isnot(None)).all()}
    cands = {}

    def cand(dz_id, name, nb_fan=0):
        c = cands.setdefault(int(dz_id), {'name': name, 'nb_fan': 0, 'mbid': None, 'lb': 0,
                                          'all_time': 0.0, 'current': 0.0, 'seeds': set()})
        c['nb_fan'] = max(c['nb_fan'], nb_fan or 0)
        return c

    for stats_range, field in (('all_time', 'all_time'), ('year', 'current')):
        listed = lb_sitewide_artists(stats_range)
        for i, entry in enumerate(listed):
            hit = _dz_artist_for(entry['artist_name'], entry.get('artist_mbid'), known)
            if not hit:
                continue
            c = cand(hit['id'], hit['name'], hit['nb_fan'])
            c[field] = max(c[field], 1 - i / len(listed))
            c['mbid'] = c['mbid'] or entry.get('artist_mbid')
            c['lb'] = max(c['lb'], entry.get('listen_count') or 0)
            c['seeds'].add('listenbrainz')
            if entry.get('artist_mbid'):
                known[entry['artist_mbid']] = hit
    for track in dz_chart_tracks():
        c = cand(track['artist']['id'], track['artist']['name'])
        c['current'] = 1.0
        c['seeds'].add('chart')
    genre_weights = _genre_weights()
    boosted = {g for g, w in genre_weights.items() if w > 1}
    if boosted:
        for genre in dz_genres():
            if fold(genre['name']) in boosted:
                for hit in dz_genre_artists(genre['id']):
                    cand(hit['id'], hit['name']).setdefault('genre_seed', genre['name'])
                    cands[int(hit['id'])]['seeds'].add('genre')
    for dz_id, c in cands.items():
        if not c['nb_fan']:
            info = dz_artist(dz_id)
            c['nb_fan'] = (info or {}).get('nb_fan') or 0
    fan_pct = _percentiles([c['nb_fan'] for c in cands.values()])
    liked = _liked_artist_ids()
    t = now()
    with app.app_context():
        rows = {a.deezer_id: a for a in MusicArtist.query.all()}
        scored = []
        for dz_id, c in cands.items():
            artist = rows.get(dz_id)
            if artist is None:
                artist = MusicArtist(deezer_id=dz_id, name=c['name'], created_at=t)
                db.session.add(artist)
                rows[dz_id] = artist
            artist.nb_fan = c['nb_fan']
            artist.lb_listens = max(artist.lb_listens or 0, c['lb'])
            artist.mbid = artist.mbid or c['mbid']
            artist.seeds = ','.join(sorted(c['seeds']))[:200]
            if c.get('genre_seed') and not artist.genres:
                artist.genres = c['genre_seed']
            current = 0.5 * fan_pct.get(c['nb_fan'], 0.0) + 0.5 * c['current']
            artist.score = (0.5 * c['all_time'] + 0.5 * current) * artist_weight(artist, genre_weights)
            scored.append(artist)
        for artist in rows.values():
            if artist.deezer_id not in cands:
                artist.score = 0.0
        ranked = sorted((a for a in scored if a.score > 0), key=lambda a: a.score, reverse=True)
        tier_of = {}
        for rank, artist in enumerate(ranked):
            tier_of[artist.deezer_id] = next((mode for limit, mode in ROSTER_TIERS if rank < limit), 'off')
        for artist in rows.values():
            artist.auto_mode = tier_of.get(artist.deezer_id, 'off')
            floor = None
            if artist.deezer_id in liked:
                floor = 'essentials'
            elif 'chart' in (artist.seeds or ''):
                floor = 'top_tracks'
            artist.floor_mode = floor
            mode = effective_mode(artist)
            if mode in MONITORED:
                if artist.monitored_since is None:
                    artist.monitored_since = t
                if artist.mode_synced != mode:
                    artist.next_scan_at = t
        db.session.commit()
        monitored = sum(1 for a in rows.values() if effective_mode(a) in MONITORED)
    meta_set('roster_at', t.isoformat())
    log(f'roster: {len(cands)} candidates, {monitored} monitored artists')


def _scan_interval(mode, last_release):
    if mode == 'top_tracks':
        return timedelta(days=7)
    try:
        age = (now().date() - datetime.strptime(last_release, '%Y-%m-%d').date()).days
    except (TypeError, ValueError):
        age = 99999
    if age <= 3 * 365:
        return timedelta(days=1)
    return timedelta(days=7) if age <= 10 * 365 else timedelta(days=30)


def _want(wants, track, album, bucket, priority, mode):
    """Add one candidate track to `wants`, keeping the best copy per identity key."""
    duration = track.get('duration') or 0
    version = classify(track.get('title', ''), track.get('title_version', ''), album.get('title', ''))
    if mode != 'everything' and (version not in ORIGINAL_VERSIONS or not MIN_TRACK_S <= duration <= MAX_TRACK_S):
        return
    artist = track.get('artist') or {}
    if not artist.get('id') or not track.get('id'):
        return
    key = song_norm_key(artist['id'], track['title'], version)
    payload = {'track_id': track['id'], 'title': track['title'], 'artist': artist.get('name'),
               'artist_dz': artist['id'], 'album_id': album.get('id'), 'album_title': album.get('title'),
               'duration': duration, 'explicit': bool(track.get('explicit_lyrics')), 'version': version}
    # Better copy: lower bucket, explicit over clean, album over single, earliest release.
    order = (bucket, not payload['explicit'],
             {'album': 0, 'ep': 1, 'single': 2}.get(album.get('record_type'), 3), album.get('release_date') or '9999')
    current = wants.get(key)
    if current is None or order < current['order']:
        wants[key] = {'order': order, 'payload': payload, 'bucket': min(bucket, (current or {}).get('bucket', 9)),
                      'priority': max(priority, (current or {}).get('priority', 0))}
    else:
        current['bucket'] = min(current['bucket'], bucket)
        current['priority'] = max(current['priority'], priority)


# ListenBrainz answers 401 for uncached artists without a user token (since
# 2026); after one, the boost is skipped for a day instead of failing every artist.
_LB_CLASSICS_OFF_UNTIL = [0.0]


def _want_classics(wants, dz_id, mbid, weight, mode):
    """Best effort: the artist's all-time top 10 by ListenBrainz listens join the
    top-10 bucket, so old hits rank with current ones."""
    if time.time() < _LB_CLASSICS_OFF_UNTIL[0]:
        return
    try:
        top = lb_top_recordings(mbid)[:10]
    except SourceError as e:
        if 'HTTP 401' in str(e):
            _LB_CLASSICS_OFF_UNTIL[0] = time.time() + 86400
            log('ListenBrainz popularity needs a token for this artist; classics boost off for 24 h')
        return
    have = {key.split(':', 2)[1] for key in wants}
    for entry in top:
        title = entry.get('recording_name') or ''
        if norm_title(title) in have:
            for key, w in wants.items():
                if key.split(':', 2)[1] == norm_title(title):
                    w['bucket'] = min(w['bucket'], P_TOP10)
            continue
        for hit in dz_search_track(entry.get('artist_name') or '', title):
            if int(hit['artist']['id']) == int(dz_id) and similarity(hit['title'], title) >= 0.9:
                _want(wants, hit, hit.get('album') or {}, P_TOP10, (hit.get('rank') or 0) * weight, mode)
                break


def artist_sync(artist_row_id):
    """Scan one artist's catalogue on Deezer and queue every missing wanted song."""
    with app.app_context():
        artist = db.session.get(MusicArtist, artist_row_id)
        if artist is None:
            return 0
        mode = effective_mode(artist)
        dz_id = artist.deezer_id
        set_activity(f'Scanning {artist.name}')
        seen = set(json.loads(artist.albums_seen or '[]')) if artist.mode_synced == mode else set()
        since = (artist.monitored_since or now()).strftime('%Y-%m-%d')
        weight = artist_weight(artist, _genre_weights())
        is_rule = bool(artist.rule_mode)
        mbid = artist.mbid
    if mode not in MONITORED or weight == 0:
        with app.app_context():
            artist = db.session.get(MusicArtist, artist_row_id)
            artist.next_scan_at = now() + timedelta(days=30)
            artist.mode_synced = mode
            db.session.commit()
        return 0
    info = dz_artist(dz_id)
    top = dz_artist_top(dz_id, 50)
    albums = dz_artist_albums(dz_id)
    today = now().strftime('%Y-%m-%d')
    fresh_from = (now() - timedelta(days=FRESH_DAYS)).strftime('%Y-%m-%d')
    wants = {}
    top_limit = TOP_LIMIT.get(mode, 50)
    if mode != 'new_only':
        for i, track in enumerate(top[:top_limit]):
            bucket = P_TOP10 if i < 10 else {'essentials': P_ESSENTIALS, 'top_tracks': P_TOP_TRACKS}.get(mode, P_DISCOGRAPHY)
            _want(wants, track, track.get('album') or {}, bucket, (track.get('rank') or 0) * weight, mode)
    if mode != 'new_only' and mbid:
        _want_classics(wants, dz_id, mbid, weight, mode)
    top_album_hits = {}
    for track in top[:25]:
        album_id = (track.get('album') or {}).get('id')
        top_album_hits[album_id] = top_album_hits.get(album_id, 0) + 1
    picked = []
    for album in albums:
        released = album.get('release_date') or ''
        if released > today:
            continue  # future release: picked up on a later scan, after its date
        fresh = released >= fresh_from and released >= since
        kind = album_kind(album.get('record_type'), album.get('title'))
        if mode == 'everything':
            wanted = True
        elif mode == 'discography':
            wanted = kind in ('album', 'ep', 'single')
        elif mode == 'essentials':
            wanted = top_album_hits.get(album['id'], 0) >= 2 and kind in ('album', 'ep', 'single')
        else:
            wanted = False
        if fresh and kind != 'compilation':
            wanted = True
        if wanted and (album['id'] not in seen or fresh):
            picked.append((album, fresh, kind))
    genre_ids = {}
    for album, fresh, kind in picked:
        full = dz_album(album['id'])
        if not full:
            continue
        for genre in (full.get('genres') or {}).get('data') or []:
            genre_ids[genre['name']] = genre_ids.get(genre['name'], 0) + 1
        bucket = P_FRESH if fresh else (P_ESSENTIALS if mode == 'essentials' else P_DISCOGRAPHY)
        for track in (full.get('tracks') or {}).get('data') or []:
            track.setdefault('artist', full.get('artist') or {})
            _want(wants, track, full, bucket, (track.get('rank') or 0) * weight, mode)
        seen.add(album['id'])
    held = lib_norm_keys(dz_id) if os.path.isfile(LIB_DB) else set()
    queued = jobs_open_norm_keys(dz_id)
    rows = [{'dedupe_key': f'dz:{w["payload"]["track_id"]}', 'norm_key': key, 'artist_dz': w['payload']['artist_dz'],
             'payload': w['payload'], 'bucket': w['bucket'], 'priority': w['priority']}
            for key, w in wants.items() if key not in held and key not in queued]
    rows.sort(key=lambda r: (r['bucket'], -r['priority']))
    room = ARTIST_SONG_CAP - len(held) - len(queued)
    if not is_rule and len(rows) > room:
        log(f'{info.get("name") if info else dz_id}: {len(rows)} wanted, capped at {max(room, 0)} (add an artist rule to lift it)')
        rows = rows[:max(room, 0)]
    created = jobs_upsert(rows)
    last_release = max((a.get('release_date') or '' for a in albums if (a.get('release_date') or '') <= today), default=None)
    with app.app_context():
        artist = db.session.get(MusicArtist, artist_row_id)
        if info:
            artist.name = info.get('name') or artist.name
            artist.nb_fan = info.get('nb_fan') or artist.nb_fan
        if genre_ids:
            artist.genres = ','.join(sorted(genre_ids, key=genre_ids.get, reverse=True)[:3])[:300]
        artist.albums_seen = json.dumps(sorted(seen))
        artist.mode_synced = mode
        artist.last_release = last_release
        artist.scanned_at = now()
        artist.next_scan_at = now() + _scan_interval(mode, last_release)
        artist.have = len(held)
        artist.wanted = len(queued) + created
        db.session.commit()
    if created:
        log(f'{artist_name_safe(info, dz_id)} [{mode}]: queued {created} songs')
    return created


def artist_name_safe(info, dz_id):
    return (info or {}).get('name') or f'deezer:{dz_id}'


def artists_due(limit=20):
    with app.app_context():
        rows = MusicArtist.query.filter(MusicArtist.next_scan_at.isnot(None), MusicArtist.next_scan_at <= now()) \
            .order_by(MusicArtist.score.desc()).limit(limit).all()
        return [a.id for a in rows]


def _chart_track(artist_name, title):
    """Deezer track for an Apple chart entry (first credited artist, close title)."""
    first_artist = re.split(r',| & | x | feat\.? ', artist_name, flags=re.I)[0].strip()
    for hit in dz_search_track(first_artist, split_title(title)[0]):
        if fold(hit['artist']['name']) == fold(first_artist) and similarity(hit['title'], title) >= 0.85:
            return hit
    return None


def charts_scan():
    """Queue current chart songs (bucket P1) and put their artists on the roster."""
    entries = [(t, None) for t in dz_chart_tracks()]
    for region in CHART_REGIONS:
        try:
            for item in apple_most_played(region):
                hit = _chart_track(item.get('artistName', ''), item.get('name', ''))
                if hit:
                    entries.append((hit, region))
        except SourceError as e:
            log(f'charts: apple {region} failed: {e}')
    wants = {}
    for position, (track, _region) in enumerate(entries):
        _want(wants, track, track.get('album') or {}, P_FRESH, 1_000_000 - position, 'everything')
    held_by_artist = {}
    rows = []
    for key, w in wants.items():
        artist_dz = w['payload']['artist_dz']
        if artist_dz not in held_by_artist:
            held_by_artist[artist_dz] = (lib_norm_keys(artist_dz) if os.path.isfile(LIB_DB) else set()) | jobs_open_norm_keys(artist_dz)
        if key not in held_by_artist[artist_dz]:
            rows.append({'dedupe_key': f'dz:{w["payload"]["track_id"]}', 'norm_key': key, 'artist_dz': artist_dz,
                         'payload': w['payload'], 'bucket': w['bucket'], 'priority': w['priority']})
    created = jobs_upsert(rows)
    t = now()
    with app.app_context():
        for track, _region in entries:
            dz_id = int(track['artist']['id'])
            artist = MusicArtist.query.filter_by(deezer_id=dz_id).first()
            if artist is None:
                artist = MusicArtist(deezer_id=dz_id, name=track['artist']['name'], created_at=t, seeds='chart')
                db.session.add(artist)
                db.session.flush()
            if 'chart' not in (artist.seeds or ''):
                artist.seeds = ','.join(filter(None, [artist.seeds, 'chart']))[:200]
            if MODE_RANK.get(artist.floor_mode or 'off', 0) < MODE_RANK['top_tracks']:
                artist.floor_mode = 'top_tracks'
                artist.next_scan_at = t
            if artist.monitored_since is None and effective_mode(artist) in MONITORED:
                artist.monitored_since = t
        db.session.commit()
    meta_set('charts_at', t.isoformat())
    log(f'charts: {len(entries)} entries, queued {created} songs')
    return created
