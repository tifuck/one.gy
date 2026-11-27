# Discovery (plan section 8): which artists are monitored, and which of their
# songs are wanted. The roster is rebuilt weekly from free popularity data;
# each monitored artist's catalogue is re-scanned on a schedule; every missing
# wanted song is queued with a score (075_priority.py) and every queued one is
# re-scored.

# Effective mode order, for floors ("at least Essentials").
MODE_RANK = {'off': 0, 'new_only': 1, 'top_tracks': 2, 'essentials': 3, 'discography': 4, 'everything': 5}
MONITORED = ('new_only', 'top_tracks', 'essentials', 'discography', 'everything')
CHART_REGIONS = ('us', 'gb', 'ca', 'au')
ROSTER_EVERY = timedelta(days=7)
CHARTS_EVERY = timedelta(hours=6)
# A chart song gives its artist at least Top tracks for this long.
CHART_FLOOR_DAYS = 90
TOP_LIMIT = {'top_tracks': 10, 'essentials': 25}


class DiscoveryStopped(Exception):
    """The admin turned discovery off mid-scan; the artist is scanned again later."""


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


def artist_weight(rule_weight, genres, genre_weights, ruled=False):
    """Admin artist weight x the genre weight. The main genre (the first) sets it
    when it has a rule; other genres can only raise it, so a side genre never
    downgrades an artist. A blocked main genre gives 0, unless the artist has an
    admin rule (plan 10)."""
    ruled_genres = [genre_weights.get(fold(g)) for g in (genres or '').split(',') if g]
    main = ruled_genres[0] if ruled_genres else None
    if main == 0 and not ruled:
        return 0.0
    genre = main or max([w for w in ruled_genres[1:] if w and w > 1] or [1.0])
    return (rule_weight or 1.0) * genre


def roster_tiers():
    """((rank limit, mode), ...): the admin's tier sizes, each at least the one before."""
    with app.app_context():
        discography = get_numeric_setting('music_tier_discography')
        essentials = max(discography, get_numeric_setting('music_tier_essentials'))
        top_tracks = max(essentials, get_numeric_setting('music_tier_top_tracks'))
    return ((discography, 'discography'), (essentials, 'essentials'), (top_tracks, 'top_tracks'))


def rules_signature():
    """Changes when an admin edits a genre or artist weight or the tier sizes, so
    the roster is re-ranked and the queue re-scored."""
    with app.app_context():
        genres = sorted([fold(r.genre), r.weight] for r in MusicGenreRule.query.all())
        artists = sorted([a.deezer_id, a.rule_weight] for a in MusicArtist.query.filter(MusicArtist.rule_weight != 1.0))
    return hashlib.sha256(json.dumps([genres, artists, roster_tiers()]).encode()).hexdigest()[:16]


def _aware(value):
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


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
    rules = rules_signature()
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
    tiers = roster_tiers()
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
        for artist in rows.values():
            if artist.charted_at is None and 'chart' in (artist.seeds or ''):
                artist.charted_at = artist.created_at or t  # charted before charted_at existed
        scored = []
        for dz_id, c in cands.items():
            artist = rows.get(dz_id)
            if artist is None:
                artist = MusicArtist(deezer_id=dz_id, name=c['name'], created_at=t)
                db.session.add(artist)
                rows[dz_id] = artist
            if 'chart' in c['seeds']:
                artist.charted_at = t
            artist.nb_fan = c['nb_fan']
            artist.lb_listens = max(artist.lb_listens or 0, c['lb'])
            artist.mbid = artist.mbid or c['mbid']
            artist.seeds = ','.join(sorted(c['seeds']))[:200]
            if c.get('genre_seed') and not artist.genres:
                artist.genres = c['genre_seed']
            current = 0.5 * fan_pct.get(c['nb_fan'], 0.0) + 0.5 * c['current']
            weight = artist_weight(artist.rule_weight, artist.genres, genre_weights, bool(artist.rule_mode))
            artist.score = (0.5 * c['all_time'] + 0.5 * current) * weight
            scored.append(artist)
        for artist in rows.values():
            if artist.deezer_id not in cands:
                artist.score = 0.0
        ranked = sorted((a for a in scored if a.score > 0), key=lambda a: a.score, reverse=True)
        tier_of = {}
        for rank, artist in enumerate(ranked):
            tier_of[artist.deezer_id] = next((mode for limit, mode in tiers if rank < limit), 'off')
        for artist in rows.values():
            artist.auto_mode = tier_of.get(artist.deezer_id, 'off')
            floor = None
            if artist.deezer_id in liked:
                floor = 'essentials'
            elif artist.charted_at and t - _aware(artist.charted_at) <= timedelta(days=CHART_FLOOR_DAYS):
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
    meta_set('roster_rules', rules)
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


def _entries(wants):
    return [entry for slots in wants.values() for entry in slots]


def _want(wants, track, album, reason, mode, fresh_until=None, ref=0):
    """Add one candidate track to wants ({identity key: [entry]}). Copies of one
    song (album and single, explicit and clean) merge into one entry; songs that
    share a key but not a length (two different "Intro" tracks) stay apart.
    Returns the entry, or None when the mode does not want the track."""
    duration = track.get('duration') or 0
    version = classify(track.get('title', ''), track.get('title_version', ''), album.get('title', ''))
    if mode != 'everything' and (version not in ORIGINAL_VERSIONS or not MIN_TRACK_S <= duration <= MAX_TRACK_S):
        return None
    artist = track.get('artist') or {}
    if not artist.get('id') or not track.get('id'):
        return None
    key = song_norm_key(artist['id'], track['title'], version)
    payload = {'track_id': track['id'], 'title': track['title'], 'artist': artist.get('name'),
               'artist_dz': artist['id'], 'album_id': album.get('id'), 'album_title': album.get('title'),
               'duration': duration, 'explicit': bool(track.get('explicit_lyrics')), 'version': version,
               'rank': track.get('rank') or 0, 'reason': reason}
    if fresh_until:
        payload.update(fresh_until=fresh_until, ref=ref)
    # Better copy: explicit over clean, album over single, earliest release.
    order = (not payload['explicit'], {'album': 0, 'ep': 1, 'single': 2}.get(album.get('record_type'), 3),
             album.get('release_date') or '9999')
    slots = wants.setdefault(key, [])
    entry = next((e for e in slots if same_length(e['payload']['duration'], duration)), None)
    if entry is None:
        entry = {'key': key, 'order': order, 'payload': payload}
        slots.append(entry)
        return entry
    old = entry['payload']
    if order < entry['order']:
        entry['order'], entry['payload'] = order, dict(payload)
    merged = entry['payload']
    merged['rank'] = max(old['rank'], payload['rank'])
    merged['reason'] = min(old['reason'], payload['reason'])
    for field in ('fresh_until', 'chart_until', 'ref', 'chart'):
        values = [p[field] for p in (old, payload) if p.get(field)]
        if values:
            merged[field] = max(values)
    return entry


# ListenBrainz answers 401 for uncached artists without a user token (since
# 2026); after one, the boost is skipped for a day instead of failing every artist.
_LB_CLASSICS_OFF_UNTIL = [0.0]


def _want_classics(wants, dz_id, mbid, mode):
    """Best effort: the artist's all-time top 10 by ListenBrainz listens count as
    top-10 songs, so old hits rank with current ones."""
    if time.time() < _LB_CLASSICS_OFF_UNTIL[0]:
        return
    try:
        top = lb_top_recordings(mbid)[:10]
    except SourceError as e:
        if 'HTTP 401' in str(e):
            _LB_CLASSICS_OFF_UNTIL[0] = time.time() + 86400
            log('ListenBrainz popularity needs a token for this artist; classics boost off for 24 h')
        return
    for entry in top:
        title = entry.get('recording_name') or ''
        held = [e for e in _entries(wants) if norm_title(e['payload']['title']) == norm_title(title)]
        for e in held:
            e['payload']['reason'] = P_TOP10
        if held:
            continue
        for hit in dz_search_track(entry.get('artist_name') or '', title):
            if int(hit['artist']['id']) == int(dz_id) and similarity(hit['title'], title) >= 0.9:
                _want(wants, hit, hit.get('album') or {}, P_TOP10, mode)
                break


def _foreign_album(full, dz_id):
    """Another artist's album listed under this one, or a sampler filed under
    them (most tracks credited to other artists, like label samplers under a
    composer)."""
    if int((full.get('artist') or {}).get('id') or 0) != int(dz_id):
        return True
    tracks = (full.get('tracks') or {}).get('data') or []
    others = sum(1 for t in tracks if int((t.get('artist') or {}).get('id') or dz_id) != int(dz_id))
    return others > max(2, len(tracks) // 2)


def _queue(entries, src_dz, cfg, weights, blocked, own):
    """Split wanted entries into new rows and re-scores of open jobs; drop held
    songs and songs of blocked artists. own: the scan is src_dz's own (its
    reasons replace older ones). Returns (rows, {job id: fields}, held)."""
    today = now().strftime('%Y-%m-%d')
    entries = [e for e in entries if int(e['payload']['artist_dz']) not in blocked]
    artists = {int(e['payload']['artist_dz']) for e in entries}
    held = {a: lib_norm_keys(a) for a in artists}
    queued = jobs_open(artists)
    rows, refresh = [], {}
    for entry in entries:
        payload, key = entry['payload'], entry['key']
        artist_dz, duration = int(payload['artist_dz']), payload['duration']
        if any(same_length(d, duration) for d in held[artist_dz].get(key, [])):
            continue
        job = next((j for j in queued.get(key, []) if same_length(j[1], duration)), None)
        fields = {k: payload[k] for k in SCORE_FIELDS if k in payload}
        if job:
            fields['own'] = own and job[2] == src_dz
            refresh[job[0]] = fields
            continue
        bucket, score = job_score(payload, weights.get(src_dz, 1.0), cfg, today)
        rows.append({'dedupe_key': f'dz:{payload["track_id"]}', 'norm_key': key, 'artist_dz': artist_dz,
                     'src_dz': src_dz, 'payload': payload, 'bucket': bucket, 'priority': score})
    return rows, refresh, held


def artist_sync(artist_row_id):
    """Scan one artist's catalogue on Deezer: queue every missing wanted song,
    re-score the queued ones and, after a mode change, skip queued songs the
    new mode no longer wants."""
    with app.app_context():
        artist = db.session.get(MusicArtist, artist_row_id)
        if artist is None:
            return 0
        mode = effective_mode(artist)
        dz_id = artist.deezer_id
        set_activity(f'Scanning {artist.name}')
        mode_changed = artist.mode_synced != mode
        seen = set() if mode_changed else set(json.loads(artist.albums_seen or '[]'))
        since = (artist.monitored_since or now()).strftime('%Y-%m-%d')
        genre_weights = _genre_weights()
        rule_weight, genres = artist.rule_weight, artist.genres
        has_mode_rule = bool(artist.rule_mode)
        # Any admin rule (mode or weight) lifts the per-artist song cap.
        has_rule = has_mode_rule or (rule_weight or 1.0) != 1.0
        mbid = artist.mbid
        name = artist.name
    weight = artist_weight(rule_weight, genres, genre_weights, has_mode_rule)
    today = now().strftime('%Y-%m-%d')
    if mode not in MONITORED or weight == 0:
        code = 'blocked' if weight == 0 or mode == 'blocked' else 'unwanted'
        # Not followed: songs it queued go, except current chart songs. Blocked: all of
        # them, and its songs queued through other artists too.
        drop = [job_id for job_id, payload in jobs_of_source(dz_id)
                if code == 'blocked' or (payload.get('chart_until') or '') < today]
        if code == 'blocked':
            drop += [j[0] for jobs in jobs_open([dz_id]).values() for j in jobs]
        skipped = jobs_skip(set(drop), code)
        if skipped:
            log(f'{name}: {"blocked" if code == "blocked" else "not followed"}; skipped {skipped} queued songs')
        with app.app_context():
            artist = db.session.get(MusicArtist, artist_row_id)
            artist.next_scan_at = now() + timedelta(days=30)
            artist.mode_synced = mode
            # Following again rescans every album, which queues the skipped songs again.
            artist.albums_seen = '[]'
            artist.wanted = 0
            db.session.commit()
        return 0
    cfg = priority_config()
    weights, blocked = artist_weights()
    info = dz_artist(dz_id)
    top = dz_artist_top(dz_id, 50)
    albums = dz_artist_albums(dz_id)
    fresh_from = (now() - timedelta(days=cfg['fresh_days'])).strftime('%Y-%m-%d')
    # A new release has no Deezer rank yet: it counts as the artist's usual hit
    # (median rank of their top 10) while it is new.
    hit_ranks = sorted(t.get('rank') or 0 for t in top[:10])
    ref = hit_ranks[len(hit_ranks) // 2] if hit_ranks else 0
    fresh_albums = {}
    for album in albums:
        released = album.get('release_date') or ''
        if fresh_from <= released <= today and (mode != 'new_only' or released >= since):
            until = datetime.strptime(released, '%Y-%m-%d') + timedelta(days=cfg['fresh_days'])
            fresh_albums[album['id']] = until.strftime('%Y-%m-%d')
    # New releases in full only from artists at the admin's level or above; below
    # it a new song is queued once it reaches the artist's top tracks.
    full_fresh = mode in ('new_only', 'everything') or MODE_RANK[mode] >= MODE_RANK.get(cfg['fresh_full_mode'], MODE_RANK['essentials'])
    wants = {}
    top_limit = TOP_LIMIT.get(mode, 50)
    if mode != 'new_only':
        for i, track in enumerate(top[:top_limit]):
            reason = P_TOP10 if i < 10 else (P_ESSENTIALS if mode == 'essentials' else P_DISCOGRAPHY)
            album_id = (track.get('album') or {}).get('id')
            _want(wants, track, track.get('album') or {}, reason, mode, fresh_albums.get(album_id), ref)
        if mbid:
            _want_classics(wants, dz_id, mbid, mode)
    top_album_hits = {}
    for track in top[:25]:
        album_id = (track.get('album') or {}).get('id')
        top_album_hits[album_id] = top_album_hits.get(album_id, 0) + 1
    picked = []
    for album in albums:
        released = album.get('release_date') or ''
        if released > today:
            continue  # future release: picked up on a later scan, after its date
        fresh = album['id'] in fresh_albums
        kind = album_kind(album.get('record_type'), album.get('title'))
        if mode == 'everything':
            wanted = True
        elif mode == 'discography':
            wanted = kind in ('album', 'ep', 'single')
        elif mode == 'essentials':
            wanted = top_album_hits.get(album['id'], 0) >= 2 and kind in ('album', 'ep', 'single')
        elif mode == 'new_only':
            wanted = released >= since and kind != 'compilation'
        else:
            wanted = False
        if fresh and full_fresh and kind != 'compilation':
            wanted = True
        if wanted and (album['id'] not in seen or fresh):
            picked.append((album, kind))
    genre_ids = {}
    reason = P_ESSENTIALS if mode == 'essentials' else P_DISCOGRAPHY
    for album, kind in picked:
        # Only the service's discovery thread obeys the switches; a CLI sync-artist is never the leader.
        if STOP.is_set() or (threading.current_thread().name == 'discovery' and _discovery_allowed()):
            raise DiscoveryStopped()
        full = dz_album(album['id'])
        if not full:
            continue
        if mode != 'everything' and _foreign_album(full, dz_id):
            seen.add(album['id'])
            continue
        for genre in (full.get('genres') or {}).get('data') or []:
            genre_ids[genre['name']] = genre_ids.get(genre['name'], 0) + 1
        for track in (full.get('tracks') or {}).get('data') or []:
            track.setdefault('artist', full.get('artist') or {})
            if int(track['artist'].get('id') or 0) != int(dz_id):
                continue  # someone else's song on this album: theirs to follow
            _want(wants, track, full, reason, mode, fresh_albums.get(album['id']), ref)
        seen.add(album['id'])
    top_album = (top[0].get('album') or {}).get('id') if top else None
    if not genre_ids and not genres and top_album:
        # No album read this scan (Top tracks mode): take genres from the top song's album.
        for genre in ((dz_album(top_album) or {}).get('genres') or {}).get('data') or []:
            genre_ids[genre['name']] = genre_ids.get(genre['name'], 0) + 1
    if genre_ids:
        genres = ','.join(sorted(genre_ids, key=genre_ids.get, reverse=True)[:3])[:300]
    # Genres are only known after the scan, so the weight is applied here.
    weight = artist_weight(rule_weight, genres, genre_weights, has_mode_rule)
    if weight == 0:
        with app.app_context():
            artist = db.session.get(MusicArtist, artist_row_id)
            artist.genres = genres
            db.session.commit()
        return artist_sync(artist_row_id)
    weights[dz_id] = weight
    rows, refresh, held = _queue(_entries(wants), dz_id, cfg, weights, blocked, own=True)
    jobs_refresh(refresh, cfg, weights)
    own_jobs = jobs_of_source(dz_id)
    skipped = 0
    if mode_changed:
        # Every album the new mode wants was read, so a queued song not found is unwanted.
        skipped = jobs_skip({job_id for job_id, payload in own_jobs if job_id not in refresh
                             and (payload.get('chart_until') or '') < today}, 'unwanted')
        if skipped:
            log(f'{name} [{mode}]: skipped {skipped} queued songs the mode no longer wants')
    rows.sort(key=lambda r: -r['priority'])
    have = sum(len(d) for d in held.get(dz_id, {}).values())
    room = cfg['song_cap'] - have - (len(own_jobs) - skipped)
    if cfg['song_cap'] and not has_rule and len(rows) > room:
        cut, rows = rows[max(room, 0):], rows[:max(room, 0)]
        # Albums with songs left out are read again, so the songs follow if the cap lifts.
        seen -= {r['payload'].get('album_id') for r in cut}
        log(f'{artist_name_safe(info, dz_id)}: {len(rows) + len(cut)} wanted, capped at {max(room, 0)} (add an artist rule to lift it)')
    created = jobs_upsert(rows)
    last_release = max((a.get('release_date') or '' for a in albums if (a.get('release_date') or '') <= today), default=None)
    with app.app_context():
        artist = db.session.get(MusicArtist, artist_row_id)
        if info:
            artist.name = info.get('name') or artist.name
            artist.nb_fan = info.get('nb_fan') or artist.nb_fan
        artist.genres = genres
        artist.albums_seen = json.dumps(sorted(seen))
        artist.mode_synced = mode
        artist.last_release = last_release
        artist.scanned_at = now()
        artist.next_scan_at = now() + _scan_interval(mode, last_release)
        artist.have = have
        artist.wanted = len(own_jobs) - skipped + created
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


def artists_due_count():
    with app.app_context():
        return MusicArtist.query.filter(MusicArtist.next_scan_at.isnot(None), MusicArtist.next_scan_at <= now()).count()


def _chart_track(artist_name, title):
    """Deezer track for an Apple chart entry: first credited artist, close title,
    the same version ("Last Christmas" is not its Pudding Mix), most popular."""
    first_artist = re.split(r',| & | x | feat\.? ', artist_name, flags=re.I)[0].strip()
    version = classify(title)
    best = None
    for hit in dz_search_track(first_artist, split_title(title)[0]):
        if fold(hit['artist']['name']) == fold(first_artist) and similarity(hit['title'], title) >= 0.85 \
                and classify(hit['title'], hit.get('title_version', ''), (hit.get('album') or {}).get('title', '')) == version \
                and (best is None or (hit.get('rank') or 0) > (best.get('rank') or 0)):
            best = hit
    return best


def charts_scan():
    """Boost current chart songs: queue the missing ones, re-boost the queued
    ones, and give their artists at least Top tracks."""
    entries = [(t, chart_pop(i)) for i, t in enumerate(dz_chart_tracks())]
    for region in CHART_REGIONS:
        try:
            for i, item in enumerate(apple_most_played(region)):
                hit = _chart_track(item.get('artistName', ''), item.get('name', ''))
                if hit:
                    entries.append((hit, chart_pop(i)))
        except SourceError as e:
            log(f'charts: apple {region} failed: {e}')
    cfg = priority_config()
    weights, blocked = artist_weights()
    until = (now() + timedelta(days=CHART_HOLD_DAYS)).strftime('%Y-%m-%d')
    wants = {}
    for track, pop in entries:
        entry = _want(wants, track, track.get('album') or {}, P_OTHER, 'everything')
        if entry:
            entry['payload']['chart'] = max(entry['payload'].get('chart') or 0, pop)
            entry['payload']['chart_until'] = until
    rows, refresh, by_artist = [], {}, {}
    for entry in _entries(wants):
        by_artist.setdefault(int(entry['payload']['artist_dz']), []).append(entry)
    for artist_dz, artist_entries in by_artist.items():
        new, found, _held = _queue(artist_entries, artist_dz, cfg, weights, blocked, own=False)
        rows += new
        refresh.update({job_id: {k: v for k, v in fields.items() if k in ('rank', 'chart', 'chart_until')}
                        for job_id, fields in found.items()})
    jobs_refresh(refresh, cfg, weights)
    created = jobs_upsert(rows)
    t = now()
    with app.app_context():
        for track, _pop in entries:
            dz_id = int(track['artist']['id'])
            artist = MusicArtist.query.filter_by(deezer_id=dz_id).first()
            if artist is None:
                artist = MusicArtist(deezer_id=dz_id, name=track['artist']['name'], created_at=t, seeds='chart')
                db.session.add(artist)
                db.session.flush()
            if 'chart' not in (artist.seeds or ''):
                artist.seeds = ','.join(filter(None, [artist.seeds, 'chart']))[:200]
            artist.charted_at = t
            if MODE_RANK.get(artist.floor_mode or 'off', 0) < MODE_RANK['top_tracks']:
                artist.floor_mode = 'top_tracks'
                artist.next_scan_at = t
            if artist.monitored_since is None and effective_mode(artist) in MONITORED:
                artist.monitored_since = t
        db.session.commit()
    meta_set('charts_at', t.isoformat())
    log(f'charts: {len(entries)} entries, queued {created} songs, re-boosted {len(refresh)}')
    return created
