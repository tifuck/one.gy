# ─── Music taste: listening history, taste profile, Home "For you" ─────────
# docs/music-taste.md. The device that plays a song reports the play once
# (POST /music/api/listen); the server classifies it (outcome, weight) and adds
# the weight to the user's MusicAffinity rows for the song, its album, artists
# and genres. Each row keeps two exponentially decayed sums stored as of
# updated_at: writers decay them before adding, readers decay them to now.
# Likes, playlist adds and hides add explicit weights (_music_taste_signal).
# /music/api/foryou builds Home's personal part from them.
#
# Caches are per process and keyed by a per-user taste version that every
# taste write bumps. With several gunicorn workers another worker's copy can
# lag by its TTL (prefs and hides 60 s, the feed one spotlight ttl).

_MUSIC_LISTEN_BATCH_MAX = 20
_MUSIC_LISTEN_ID_MAX = 36            # MusicListen.client_id / device_id
_MUSIC_CONTEXT_MAX = 100             # MusicListen.context
_MUSIC_AFFINITY_KEY_MAX = 100        # MusicAffinity.key
_MUSIC_START_REASONS = ('pick', 'next', 'prev', 'auto', 'autoplay', 'remote', 'repeat', 'restore')
_MUSIC_END_REASONS = ('done', 'next', 'prev', 'pick', 'stop', 'unload', 'handoff', 'error', 'remote')
_MUSIC_CONTEXT_WORDS = ('liked', 'autoplay', 'queue')
_MUSIC_CONTEXT_PREFIXES = ('album:', 'playlist:', 'artist:', 'genre:', 'search:')
# A reported play must have started in [now - past, now + future]: page
# backlogs flush late, client clocks drift.
_MUSIC_LISTEN_PAST = timedelta(days=7)
_MUSIC_LISTEN_FUTURE = timedelta(minutes=5)
_MUSIC_LISTEN_SLACK_MS = 60000
_MUSIC_LISTEN_MIN_MS = 1000
_MUSIC_SEEKS_MAX = 10000
_MUSIC_DAY_MS = 24 * 3600 * 1000
_MUSIC_CHECKPOINT_FINAL_AFTER = timedelta(hours=6)
_MUSIC_QUALIFIED = ('complete', 'listen', 'skip_late', 'away')
_MUSIC_SKIP_ENDS = ('next', 'pick', 'remote')
_MUSIC_SKIP_WEIGHTS = {'autoplay': -1.0, 'auto': -0.3, 'next': -0.3, 'prev': -0.3, 'remote': -0.3, 'pick': -0.2}
_MUSIC_BROWSE_WINDOW = timedelta(seconds=60)
_MUSIC_DAMPING_WINDOW = timedelta(hours=24)
_MUSIC_REPLAY_WINDOW = timedelta(minutes=10)
# Explicit signals: (song, album, artists, genres split across the song's genres).
_MUSIC_TASTE_SIGNALS = {
    'like': (5.0, 2.0, 3.0, 2.0),
    'unlike': (-5.0, -2.0, -3.0, -2.0),
    'playlist_add': (3.0, 1.0, 2.0, 1.0),
    'playlist_remove': (-1.0, 0.0, 0.0, 0.0),
    'hide': (-10.0, -1.0, -2.0, -0.5),
    'unhide': (10.0, 1.0, 2.0, 0.5),
}
_MUSIC_HIDE_ARTIST_WEIGHT = -10.0
_MUSIC_DISMISS_ARTIST_WEIGHT = -1.0
_MUSIC_HIDE_KINDS = ('song', 'album', 'artist')
_MUSIC_PRIVATE_MAX_MINUTES = 24 * 60
_MUSIC_PREFS_CACHE_TTL = 60
_MUSIC_TASTE_CACHE_TTL = 900
_MUSIC_SONG_META_MAX = 5000
# Retention (cleanup_music_taste, from cleanup_job): at most once a day, ~20 s.
_MUSIC_TASTE_PRUNE_INTERVAL = 86400
_MUSIC_TASTE_PRUNE_SECONDS = 20
_MUSIC_TASTE_PRUNE_CHUNK = 5000
_MUSIC_AFFINITY_FLOOR = 0.01
# Affinity rows written this recently are left alone (an in-flight play may be adding to them).
_MUSIC_AFFINITY_PRUNE_IDLE = timedelta(days=14)

# user id -> (monotonic time, autoplay, private_until)
_MUSIC_PREFS_CACHE = {}
# user id -> {'ts', 'sets': {'song'|'album'|'artist': set}, 'songs_key', 'songs'}
_MUSIC_HIDES_CACHE = {}
# user id -> taste version (bumped on every taste write); feeds and taste reads are cached under it
_MUSIC_TASTE_VERSIONS = {}
_MUSIC_TASTE_SEQ = 0
_MUSIC_TASTE_SEQ_LOCK = threading.Lock()
# user id -> (version, monotonic time, taste)
_MUSIC_TASTE_CACHE = {}
# song id -> (album_id, duration_ms, primary artist ids, featured artist ids, genre keys) or None,
# for the library snapshot _MUSIC_SONG_META_KEY
_MUSIC_SONG_META = {}
_MUSIC_SONG_META_KEY = None
_MUSIC_TASTE_PRUNED_AT = None


def _music_taste_bump(user_id):
    global _MUSIC_TASTE_SEQ
    with _MUSIC_TASTE_SEQ_LOCK:
        _MUSIC_TASTE_SEQ += 1
        _MUSIC_TASTE_VERSIONS[user_id] = _MUSIC_TASTE_SEQ


def _music_taste_forget(user_id):
    """Drop every cached view of a user's taste (history cleared, user deleted)."""
    for cache in (_MUSIC_PREFS_CACHE, _MUSIC_HIDES_CACHE, _MUSIC_TASTE_CACHE, _MUSIC_FORYOU_CACHE):
        cache.pop(user_id, None)
    _music_taste_bump(user_id)


def _delete_music_taste_of(user_id):
    """Delete a user's listening history, taste, hides, spotlight and prefs rows
    (account deletion; the caller commits)."""
    for model in (MusicListen, MusicAffinity, MusicHide, MusicSpotlightSeen, MusicUserPref):
        model.query.filter(model.user_id == user_id).delete(synchronize_session=False)
    _music_taste_forget(user_id)


def _music_number(value):
    """A finite JSON number as an int, else None (bools, strings, NaN, Infinity)."""
    import math
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return int(value)


def _music_half_lives():
    return (get_float_setting('music_taste_half_life_short_days'),
            get_float_setting('music_taste_half_life_long_days'))


def _music_decay(value, updated_at, now, half_life_days):
    """value stored as of updated_at, decayed to now."""
    if not value or not updated_at or half_life_days <= 0:
        return value or 0.0
    days = max(0.0, (now - _utc_aware(updated_at)).total_seconds() / 86400.0)
    return value * 0.5 ** (days / half_life_days)


def _music_user_prefs(user_id):
    """(autoplay, private_until) of a user; no row means autoplay on and no private session."""
    entry = _MUSIC_PREFS_CACHE.get(user_id)
    if entry is not None and time.monotonic() - entry[0] < _MUSIC_PREFS_CACHE_TTL:
        return entry[1], entry[2]
    row = db.session.query(MusicUserPref.autoplay, MusicUserPref.private_until).filter(
        MusicUserPref.user_id == user_id).first()
    autoplay, private_until = (bool(row[0]), _utc_aware(row[1])) if row else (True, None)
    _MUSIC_PREFS_CACHE[user_id] = (time.monotonic(), autoplay, private_until)
    return autoplay, private_until


def _music_prefs_payload(autoplay, private_until, now):
    active = private_until is not None and private_until > now
    return {'autoplay': autoplay, 'private_until': private_until.isoformat() if active else None}


def _music_hides_entry(user_id):
    entry = _MUSIC_HIDES_CACHE.get(user_id)
    if entry is not None and time.monotonic() - entry['ts'] < _MUSIC_PREFS_CACHE_TTL:
        return entry
    sets = {kind: set() for kind in _MUSIC_HIDE_KINDS}
    for kind, key in db.session.query(MusicHide.kind, MusicHide.key).filter(MusicHide.user_id == user_id).all():
        if kind in sets:
            sets[kind].add(key)
    entry = {'ts': time.monotonic(), 'sets': sets}
    _MUSIC_HIDES_CACHE[user_id] = entry
    return entry


def _music_hidden(user_id):
    """{'song': ids, 'album': ids, 'artist': ids} the user marked "Not for me"."""
    return _music_hides_entry(user_id)['sets']


def _music_hidden_song_ids(user_id):
    """Songs kept out of autoplay: hidden songs, the songs of hidden albums and
    the songs whose primary artist is hidden."""
    entry = _music_hides_entry(user_id)
    if entry.get('songs_key', ()) == _MUSIC_CATALOG_KEY:
        return entry['songs']
    hidden = entry['sets']
    songs = set(hidden['song'])
    if (hidden['artist'] or hidden['album']) and _music_library_available():
        conn = _get_music_db()
        try:
            for chunk in _music_chunks(sorted(hidden['artist'])):
                songs.update(row[0] for row in conn.execute(
                    f"SELECT song_id FROM song_artists WHERE role = 'primary' AND artist_id IN "
                    f"({','.join('?' for _ in chunk)})", chunk))
            for chunk in _music_chunks(sorted(hidden['album'])):
                songs.update(row[0] for row in conn.execute(
                    f"SELECT id FROM songs WHERE album_id IN ({','.join('?' for _ in chunk)})", chunk))
        finally:
            conn.close()
    entry['songs'] = frozenset(songs)
    entry['songs_key'] = _MUSIC_CATALOG_KEY
    return entry['songs']


def _music_song_meta(song_ids):
    """song id -> (album_id, duration_ms, primary artist ids, featured artist ids,
    genre keys), or None for a song library.db does not know. Cached per library
    snapshot; misses cost one library.db connection."""
    global _MUSIC_SONG_META, _MUSIC_SONG_META_KEY
    if _MUSIC_SONG_META_KEY != _MUSIC_CATALOG_KEY:
        _MUSIC_SONG_META = {}
        _MUSIC_SONG_META_KEY = _MUSIC_CATALOG_KEY
    cache = _MUSIC_SONG_META
    result = {}
    missing = []
    for song_id in dict.fromkeys(song_ids):
        if song_id in cache:
            result[song_id] = cache[song_id]
        else:
            missing.append(song_id)
    if not missing:
        return result
    found = {}
    if _music_library_available():
        conn = _get_music_db()
        try:
            for chunk in _music_chunks(missing):
                ph = ','.join('?' for _ in chunk)
                for row in conn.execute(f'SELECT id, album_id, duration_ms FROM songs WHERE id IN ({ph})', chunk):
                    found[row['id']] = (row['album_id'], int(row['duration_ms'] or 0), [], [], [])
                for row in conn.execute(f'SELECT song_id, artist_id, role FROM song_artists WHERE song_id IN ({ph})',
                                        chunk):
                    entry = found.get(row['song_id'])
                    if entry is not None:
                        entry[2 if row['role'] == 'primary' else 3].append(row['artist_id'])
                for row in conn.execute(f'SELECT song_id, genre FROM song_genres WHERE song_id IN ({ph})', chunk):
                    entry = found.get(row['song_id'])
                    genre = (row['genre'] or '').strip().lower()[:_MUSIC_AFFINITY_KEY_MAX]
                    if entry is not None and genre and genre not in entry[4]:
                        entry[4].append(genre)
        finally:
            conn.close()
    # shortcut: the whole cache is dropped when full; an LRU only pays off with far more active songs.
    if len(cache) + len(missing) > _MUSIC_SONG_META_MAX:
        cache.clear()
    for song_id in missing:
        entry = found.get(song_id)
        if entry is not None:
            entry = (entry[0], entry[1], tuple(entry[2]), tuple(a for a in entry[3] if a not in entry[2]),
                     tuple(entry[4]))
        cache[song_id] = entry
        result[song_id] = entry
    return result


# ─── Taste writes ───────────────────────────────────────────────────────────

def _music_add_targets(acc, song_id, meta, song_w, album_w, artist_w, genre_w, plays=0, skips=0, at=None):
    """Add one song's weights to acc ((kind, key) -> [delta, plays, skips,
    last_played_at, last_skip_at]): featured artists get half the artist weight,
    the genre weight is split across the song's genres. Counters go to the song
    and its primary artists."""
    album_id, _, primary, featured, genres = meta

    def add(kind, key, weight, counters):
        if not key:
            return
        entry = acc.setdefault((kind, str(key)[:_MUSIC_AFFINITY_KEY_MAX]), [0.0, 0, 0, None, None])
        entry[0] += weight
        if counters:
            entry[1] += plays
            entry[2] += skips
            if at is not None and plays > 0:
                entry[3] = max(entry[3] or at, at)
            if at is not None and skips > 0:
                entry[4] = max(entry[4] or at, at)

    add('song', song_id, song_w, True)
    add('album', album_id, album_w, False)
    for artist_id in primary:
        add('artist', artist_id, artist_w, True)
    for artist_id in featured:
        add('artist', artist_id, artist_w / 2, False)
    for genre in genres:
        add('genre', genre, genre_w / len(genres), False)


def _music_apply_taste(user_id, acc, now):
    """Apply accumulated deltas: one locking read of the affected rows, then
    updates and inserts (the caller commits)."""
    acc = {target: entry for target, entry in acc.items() if entry[0] or entry[1] or entry[2]}
    if not acc:
        return
    half_short, half_long = _music_half_lives()
    rows = MusicAffinity.query.filter(
        MusicAffinity.user_id == user_id,
        MusicAffinity.kind.in_(sorted({kind for kind, _ in acc})),
        MusicAffinity.key.in_(sorted({key for _, key in acc})),
    ).with_for_update().all()
    by_target = {(row.kind, row.key): row for row in rows}
    for target, (delta, plays, skips, played_at, skipped_at) in acc.items():
        row = by_target.get(target)
        if row is None:
            row = MusicAffinity(user_id=user_id, kind=target[0], key=target[1], short=0.0, long=0.0,
                                plays=0, skips=0)
            db.session.add(row)
        else:
            row.short = _music_decay(row.short, row.updated_at, now, half_short)
            row.long = _music_decay(row.long, row.updated_at, now, half_long)
        row.short = (row.short or 0.0) + delta
        row.long = (row.long or 0.0) + delta
        row.updated_at = now
        row.plays = max(0, (row.plays or 0) + plays)
        row.skips = max(0, (row.skips or 0) + skips)
        if played_at is not None and (row.last_played_at is None or _utc_aware(row.last_played_at) < played_at):
            row.last_played_at = played_at
        if skipped_at is not None and (row.last_skip_at is None or _utc_aware(row.last_skip_at) < skipped_at):
            row.last_skip_at = skipped_at


def _music_commit_taste(user_id, acc):
    """Apply and commit deltas on their own (after the action that caused them
    committed). Never raises: taste is secondary to the action."""
    from sqlalchemy.exc import IntegrityError as _IntegrityError, OperationalError as _OperationalError
    for attempt in range(2):
        try:
            _music_apply_taste(user_id, acc, datetime.now(timezone.utc))
            db.session.commit()
            _music_taste_bump(user_id)
            return
        except (_IntegrityError, _OperationalError) as e:
            # A concurrent first write of the same row won the unique key: read it and retry once.
            db.session.rollback()
            if attempt:
                print(f'[MUSIC] Taste update failed for user {user_id}: {type(e).__name__}')
        except Exception as e:
            db.session.rollback()
            print(f'[MUSIC] Taste update failed for user {user_id}: {type(e).__name__}: {e}')
            return


def _music_taste_signal(user_id, song_id, signal):
    """Explicit signal (like, unlike, playlist add/remove, hide, unhide) on a song."""
    if not get_setting('music_taste_enabled'):
        return
    meta = _music_song_meta([song_id]).get(song_id)
    if not meta:
        return
    acc = {}
    _music_add_targets(acc, song_id, meta, *_MUSIC_TASTE_SIGNALS[signal])
    _music_commit_taste(user_id, acc)


# ─── Listen reports ─────────────────────────────────────────────────────────

def _music_listen_context(value):
    """A known context form, else None. Search contexts are cut to fit."""
    if not isinstance(value, str):
        return None
    if value in _MUSIC_CONTEXT_WORDS:
        return value
    if not value.startswith(_MUSIC_CONTEXT_PREFIXES) or value.endswith(':'):
        return None
    if value.startswith('search:'):
        value = value[:_MUSIC_CONTEXT_MAX]
    return value if len(value) <= _MUSIC_CONTEXT_MAX else None


def _music_parse_listen(raw, now):
    """One reported play, validated, or None to drop it."""
    if not isinstance(raw, dict):
        return None
    client_id = raw.get('client_id')
    song_id = raw.get('song_id')
    start_reason = raw.get('start_reason')
    end_reason = raw.get('end_reason')
    if not (isinstance(client_id, str) and 0 < len(client_id) <= _MUSIC_LISTEN_ID_MAX) \
            or not _music_valid_song_id(song_id) \
            or start_reason not in _MUSIC_START_REASONS or end_reason not in _MUSIC_END_REASONS:
        return None
    started_ms = _music_number(raw.get('started_at'))
    ms_played = _music_number(raw.get('ms_played'))
    if started_ms is None or ms_played is None:
        return None
    try:
        started_at = datetime.fromtimestamp(started_ms / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    if not now - _MUSIC_LISTEN_PAST <= started_at <= now + _MUSIC_LISTEN_FUTURE:
        return None
    device_id = raw.get('device_id')

    def clamp(name, high):
        return max(0, min(_music_number(raw.get(name)) or 0, high))

    return {
        'client_id': client_id, 'song_id': song_id,
        'device_id': device_id if isinstance(device_id, str) and 0 < len(device_id) <= _MUSIC_LISTEN_ID_MAX else None,
        'started_at': started_at, 'ms_played': max(0, ms_played),
        'duration_ms': clamp('duration_ms', _MUSIC_DAY_MS),
        'seek_fwd': clamp('seek_fwd', _MUSIC_SEEKS_MAX), 'seek_back': clamp('seek_back', _MUSIC_SEEKS_MAX),
        'muted_ms': clamp('muted_ms', 8 * _MUSIC_DAY_MS), 'idle_ms': clamp('idle_ms', 8 * _MUSIC_DAY_MS),
        'start_reason': start_reason, 'end_reason': end_reason,
        'context': _music_listen_context(raw.get('context')),
        'final': raw.get('final') is not False,
    }


def _music_finalize_listen(item, meta, now):
    """Use the library's length and cap what was heard by the length and by the
    time since the play started. False when too little is left to count."""
    duration = meta[1] or item['duration_ms']
    wall = max(0, int((now - item['started_at']).total_seconds() * 1000)) + _MUSIC_LISTEN_SLACK_MS
    cap = min(wall, int(duration * 1.2) + _MUSIC_LISTEN_SLACK_MS) if duration > 0 else wall
    item['duration_ms'] = duration
    item['ms_played'] = min(item['ms_played'], cap)
    item['muted_ms'] = min(item['muted_ms'], wall)
    return item['ms_played'] >= _MUSIC_LISTEN_MIN_MS


def _music_classify_listen(item, picks_before, plays_before, replay, away_ms):
    """(outcome, weight) of a play, docs/music-taste.md §1 steps 3-8.

    picks_before: the user's 'pick' starts in the 60 s before this one;
    plays_before: their qualified plays of this song in the 24 h before it;
    replay: their previous play was this song and ended at most 10 min before."""
    p, d = item['ms_played'], item['duration_ms']
    start, end = item['start_reason'], item['end_reason']
    if item['muted_ms'] >= p / 2:
        return 'muted', 0.0
    if d <= 0:
        qualified = p >= 240000
    elif d > 30000:
        qualified = p >= min(d / 2, 240000)
    else:
        qualified = p >= 0.8 * d
    if qualified:
        if (d > 0 and p >= 0.9 * d) or (end == 'done' and not item['seek_fwd']):
            outcome, weight = 'complete', 1.5
        elif end in _MUSIC_SKIP_ENDS:
            outcome, weight = 'skip_late', 0.5
        else:
            outcome, weight = 'listen', 1.0
    elif start == 'pick' and (p < 5000 or picks_before >= 2):
        outcome, weight = 'sample', 0.0
    elif end in _MUSIC_SKIP_ENDS and p < 30000:
        outcome, weight = 'skip', _MUSIC_SKIP_WEIGHTS.get(start, 0.0)
    else:
        outcome, weight = 'partial', 0.0
    if start in ('auto', 'autoplay') and item['idle_ms'] >= away_ms:
        weight = weight * 0.25 if weight > 0 else 0.0
        if qualified:
            outcome = 'away'
    if weight > 0:
        weight /= 1 + 0.5 * plays_before
    if replay and start == 'pick' and outcome not in ('muted', 'sample', 'skip'):
        weight += 1.0
    return outcome, round(weight, 4)


def _music_listen_history_stats(history, item):
    """(picks_before, plays_before, replay) for item from history:
    client_id -> (started_at, ended_at, song_id, start_reason, outcome)."""
    started, song_id = item['started_at'], item['song_id']
    picks = plays = 0
    previous = None
    for client_id, (h_started, h_ended, h_song, h_start, h_outcome) in history.items():
        if client_id == item['client_id'] or h_started >= started:
            continue
        if h_start == 'pick' and started - h_started <= _MUSIC_BROWSE_WINDOW:
            picks += 1
        if h_song == song_id and h_outcome in _MUSIC_QUALIFIED and started - h_started <= _MUSIC_DAMPING_WINDOW:
            plays += 1
        if previous is None or h_started > previous[0]:
            previous = (h_started, h_ended, h_song)
    replay = previous is not None and previous[2] == song_id and started - previous[1] <= _MUSIC_REPLAY_WINDOW
    return picks, plays, replay


def _music_counted(outcome, weight):
    """(counts as a play, counts as a skip) for a stored listen row's taste counters."""
    return outcome in _MUSIC_QUALIFIED and weight > 0, outcome == 'skip' and weight < 0


def _music_excluded_contexts(user_id, items):
    """The 'playlist:<id>' contexts in items whose playlist is the user's and excluded from taste."""
    ids = set()
    for item in items:
        context = item['context'] or ''
        ref = context[len('playlist:'):]
        if context.startswith('playlist:') and ref.isascii() and ref.isdigit() and len(ref) <= 18:
            ids.add(int(ref))
    if not ids:
        return set()
    return {f'playlist:{pid}' for (pid,) in db.session.query(MusicPlaylist.id).filter(
        MusicPlaylist.user_id == user_id, MusicPlaylist.id.in_(sorted(ids)),
        MusicPlaylist.exclude_taste.is_(True)).all()}


def _music_store_listens(user_id, items, meta, excluded, now):
    """Upsert the plays and apply their taste deltas (the caller commits).
    True when a row was written."""
    away_ms = max(0, get_numeric_setting('music_away_idle_minutes')) * 60000
    since = min(item['started_at'] for item in items) - _MUSIC_DAMPING_WINDOW - timedelta(milliseconds=_MUSIC_LISTEN_SLACK_MS)
    # One locking read serves re-reports, damping, browsing and replay checks.
    rows = MusicListen.query.filter(
        MusicListen.user_id == user_id,
        db.or_(MusicListen.started_at >= since, MusicListen.client_id.in_(sorted({i['client_id'] for i in items}))),
    ).with_for_update().all()
    by_client = {row.client_id: row for row in rows}
    history = {row.client_id: (_utc_aware(row.started_at), _utc_aware(row.ended_at), row.song_id,
                               row.start_reason, row.outcome) for row in rows}
    acc = {}
    stored = False
    for item in sorted(items, key=lambda i: (i['started_at'], i['final'])):
        client_id = item['client_id']
        row = by_client.get(client_id)
        if row is not None:
            if row.song_id != item['song_id'] or (row.final and not item['final']):
                continue
            if not row.final and _utc_aware(row.ended_at) < now - _MUSIC_CHECKPOINT_FINAL_AFTER:
                continue  # a checkpoint left this long is final as it is
            if item['start_reason'] == 'restore':
                item['start_reason'] = row.start_reason
        picks, plays, replay = _music_listen_history_stats(history, item)
        outcome, weight = _music_classify_listen(item, picks, plays, replay, away_ms)
        if item['context'] in excluded:
            weight = 0.0
        old_weight = (row.weight or 0.0) if row is not None else 0.0
        old_play, old_skip = _music_counted(row.outcome, old_weight) if row is not None else (False, False)
        if row is None:
            row = MusicListen(user_id=user_id, client_id=client_id, song_id=item['song_id'])
            db.session.add(row)
            by_client[client_id] = row
        ended_at = max(item['started_at'], now)
        row.album_id = meta[item['song_id']][0]
        row.device_id = item['device_id']
        row.started_at = item['started_at']
        row.ended_at = ended_at
        for name in ('ms_played', 'duration_ms', 'seek_fwd', 'seek_back', 'muted_ms', 'idle_ms',
                     'start_reason', 'end_reason', 'context', 'final'):
            setattr(row, name, item[name])
        row.outcome = outcome
        row.weight = weight
        stored = True
        history[client_id] = (item['started_at'], ended_at, item['song_id'], item['start_reason'], outcome)
        new_play, new_skip = _music_counted(outcome, weight)
        delta = weight - old_weight
        plays_delta = int(new_play) - int(old_play)
        skips_delta = int(new_skip) - int(old_skip)
        if delta or plays_delta or skips_delta:
            _music_add_targets(acc, item['song_id'], meta[item['song_id']], delta, delta, delta, delta,
                               plays_delta, skips_delta, item['started_at'])
    _music_apply_taste(user_id, acc, now)
    return stored


@app.route('/music/api/listen', methods=['POST'])
@limiter.limit(music_stream_rate_limit)
@_music_required
def music_api_listen():
    """Report plays: {listens: [...]} (≤ 20), docs/music-taste.md §1. 204.
    Bad items are dropped silently; only a malformed body is a 400."""
    from sqlalchemy.exc import IntegrityError as _IntegrityError, OperationalError as _OperationalError
    data = request.get_json(silent=True)
    listens = data.get('listens') if isinstance(data, dict) else None
    if not isinstance(listens, list):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    user_id = session['logged_in_user_id']
    now = datetime.now(timezone.utc)
    if not get_setting('music_taste_enabled'):
        return '', 204
    private_until = _music_user_prefs(user_id)[1]
    if private_until is not None and private_until > now:
        return '', 204
    items = [item for item in (_music_parse_listen(raw, now) for raw in listens[:_MUSIC_LISTEN_BATCH_MAX]) if item]
    meta = _music_song_meta([item['song_id'] for item in items]) if items else {}
    items = [item for item in items if meta.get(item['song_id']) and _music_finalize_listen(item, meta[item['song_id']], now)]
    if not items:
        return '', 204
    excluded = _music_excluded_contexts(user_id, items)
    for attempt in range(2):
        try:
            stored = _music_store_listens(user_id, items, meta, excluded, now)
            db.session.commit()
            break
        except (_IntegrityError, _OperationalError) as e:
            # A concurrent report inserted the same play or taste row first: redo it on top of theirs.
            db.session.rollback()
            if attempt:
                print(f'[MUSIC] Listen report failed for user {user_id}: {type(e).__name__}')
                return jsonify({'error': 'PLEASE TRY AGAIN'}), 503
    if stored:
        _music_taste_bump(user_id)
    return '', 204


# ─── Prefs, clear, hide ─────────────────────────────────────────────────────

@app.route('/music/api/taste/prefs')
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_taste_prefs():
    """{autoplay, private_until} (ISO, or null when no private session is on)."""
    autoplay, private_until = _music_user_prefs(session['logged_in_user_id'])
    return jsonify(_music_prefs_payload(autoplay, private_until, datetime.now(timezone.utc)))


@app.route('/music/api/taste/prefs', methods=['PUT'])
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_taste_prefs_update():
    """{autoplay?: bool, private_minutes?: int}: private_minutes starts a private
    session for that long (at most 24 h); 0 ends it. Returns the prefs."""
    from sqlalchemy.exc import IntegrityError as _IntegrityError
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    autoplay = data.get('autoplay')
    minutes = None
    if 'autoplay' in data and not isinstance(autoplay, bool):
        return jsonify({'error': 'AUTOPLAY MUST BE TRUE OR FALSE'}), 400
    if 'private_minutes' in data:
        minutes = _music_number(data.get('private_minutes'))
        if minutes is None or minutes < 0:
            return jsonify({'error': 'PRIVATE_MINUTES MUST BE A NUMBER OF MINUTES'}), 400
        minutes = min(minutes, _MUSIC_PRIVATE_MAX_MINUTES)
    user_id = session['logged_in_user_id']
    now = datetime.now(timezone.utc)
    if autoplay is None and minutes is None:
        return jsonify(_music_prefs_payload(*_music_user_prefs(user_id), now))
    for attempt in range(2):
        try:
            pref = MusicUserPref.query.filter_by(user_id=user_id).with_for_update().first()
            if pref is None:
                pref = MusicUserPref(user_id=user_id, autoplay=True)
                db.session.add(pref)
            if autoplay is not None:
                pref.autoplay = autoplay
            if minutes is not None:
                pref.private_until = now + timedelta(minutes=minutes) if minutes else None
            pref.updated_at = now
            values = (bool(pref.autoplay), _utc_aware(pref.private_until))
            db.session.commit()
            break
        except _IntegrityError:
            db.session.rollback()  # a concurrent first save created the row: update it instead
            if attempt:
                raise
    _MUSIC_PREFS_CACHE[user_id] = (time.monotonic(),) + values
    payload = _music_prefs_payload(values[0], values[1], now)
    print(f'[MUSIC] User {user_id} set music prefs: autoplay={payload["autoplay"]}, '
          f'private until {payload["private_until"] or "off"}')
    return jsonify(payload)


@app.route('/music/api/taste/clear', methods=['POST'])
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_taste_clear():
    """Delete the user's listening history, taste profile and spotlight state
    (hides and prefs stay). 204."""
    user_id = session['logged_in_user_id']
    plays = MusicListen.query.filter(MusicListen.user_id == user_id).delete(synchronize_session=False)
    MusicAffinity.query.filter(MusicAffinity.user_id == user_id).delete(synchronize_session=False)
    MusicSpotlightSeen.query.filter(MusicSpotlightSeen.user_id == user_id).delete(synchronize_session=False)
    db.session.commit()
    _music_taste_forget(user_id)
    print(f'[MUSIC] User {user_id} cleared their listening history and taste ({plays} plays)')
    return '', 204


def _music_library_has(kind, key):
    if kind == 'song':
        return bool(_music_song_meta([key]).get(key))
    if not _music_library_available():
        return False
    conn = _get_music_db()
    try:
        table = 'albums' if kind == 'album' else 'artists'
        return conn.execute(f'SELECT 1 FROM {table} WHERE id = ?', [key]).fetchone() is not None
    finally:
        conn.close()


@app.route('/music/api/hide', methods=['POST'])
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_hide():
    """"Not for me": {kind: song|album|artist, key, hidden: bool} -> {hidden}.
    Hidden items stay out of autoplay and the spotlight; hiding a song or an
    artist also lowers its taste (unhiding gives it back)."""
    from sqlalchemy.exc import IntegrityError as _IntegrityError
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    kind, key, hidden = data.get('kind'), data.get('key'), data.get('hidden', True)
    if kind not in _MUSIC_HIDE_KINDS or not _music_valid_song_id(key) or not isinstance(hidden, bool):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    user_id = session['logged_in_user_id']
    existing = MusicHide.query.filter_by(user_id=user_id, kind=kind, key=key).first()
    changed = False
    if hidden and existing is None:
        if not _music_library_has(kind, key):
            return jsonify({'error': 'NOT FOUND'}), 404
        db.session.add(MusicHide(user_id=user_id, kind=kind, key=key, created_at=datetime.now(timezone.utc)))
        try:
            db.session.commit()
            changed = True
        except _IntegrityError:
            db.session.rollback()  # a concurrent request hid it first
    elif not hidden and existing is not None:
        MusicHide.query.filter_by(user_id=user_id, kind=kind, key=key).delete(synchronize_session=False)
        db.session.commit()
        changed = True
    if changed:
        _MUSIC_HIDES_CACHE.pop(user_id, None)
        _music_taste_bump(user_id)
        if kind == 'song':
            _music_taste_signal(user_id, key, 'hide' if hidden else 'unhide')
        elif kind == 'artist' and get_setting('music_taste_enabled'):
            weight = _MUSIC_HIDE_ARTIST_WEIGHT if hidden else -_MUSIC_HIDE_ARTIST_WEIGHT
            _music_commit_taste(user_id, {('artist', key): [weight, 0, 0, None, None]})
    return jsonify({'hidden': hidden})


# ─── Taste reads ────────────────────────────────────────────────────────────

def _music_taste(user_id, now):
    """{'artist': {id: entry}, 'genre': {key: entry}}, entry = (taste, short,
    long, plays, last_played_at) decayed to now, taste = 0.6 long + 0.4 short.
    Cached under the user's taste version."""
    version = _MUSIC_TASTE_VERSIONS.get(user_id, 0)
    entry = _MUSIC_TASTE_CACHE.get(user_id)
    if entry is not None and entry[0] == version and time.monotonic() - entry[1] < _MUSIC_TASTE_CACHE_TTL:
        return entry[2]
    half_short, half_long = _music_half_lives()
    taste = {'artist': {}, 'genre': {}}
    for kind, key, short, long_, updated_at, plays, last_played_at in db.session.query(
            MusicAffinity.kind, MusicAffinity.key, MusicAffinity.short, MusicAffinity.long,
            MusicAffinity.updated_at, MusicAffinity.plays, MusicAffinity.last_played_at,
    ).filter(MusicAffinity.user_id == user_id, MusicAffinity.kind.in_(('artist', 'genre'))).all():
        short = _music_decay(short, updated_at, now, half_short)
        long_ = _music_decay(long_, updated_at, now, half_long)
        taste[kind][key] = (0.6 * long_ + 0.4 * short, short, long_, plays or 0, _utc_aware(last_played_at))
    _MUSIC_TASTE_CACHE[user_id] = (version, time.monotonic(), taste)
    return taste


# ─── Retention ──────────────────────────────────────────────────────────────

def cleanup_music_taste():
    """cleanup_job task: prune listening history and faded taste rows, at most once a day."""
    global _MUSIC_TASTE_PRUNED_AT
    started = time.monotonic()
    if _MUSIC_TASTE_PRUNED_AT is not None and started - _MUSIC_TASTE_PRUNED_AT < _MUSIC_TASTE_PRUNE_INTERVAL:
        return None
    _MUSIC_TASTE_PRUNED_AT = started
    return _prune_music_taste(datetime.now(timezone.utc), started + _MUSIC_TASTE_PRUNE_SECONDS)


def _prune_music_taste(now, deadline):
    """Delete listens older than music_listen_retention_days (0 keeps them),
    affinity rows decayed below _MUSIC_AFFINITY_FLOOR in both sums with no
    counters, and spotlight rows of albums long out of the spotlight; in chunks,
    stopping at deadline (monotonic). Returns (listens, affinity rows) deleted."""
    listens = faded = 0
    retention_days = get_numeric_setting('music_listen_retention_days')
    if retention_days > 0:
        cutoff = now - timedelta(days=retention_days)
        while time.monotonic() < deadline:
            ids = [row[0] for row in db.session.query(MusicListen.id).filter(
                MusicListen.started_at < cutoff).order_by(MusicListen.id).limit(_MUSIC_TASTE_PRUNE_CHUNK).all()]
            if not ids:
                break
            listens += MusicListen.query.filter(MusicListen.id.in_(ids)).delete(synchronize_session=False) or 0
            db.session.commit()
    half_short, half_long = _music_half_lives()
    idle_before = now - _MUSIC_AFFINITY_PRUNE_IDLE
    last_id = 0
    while time.monotonic() < deadline:
        rows = db.session.query(MusicAffinity.id, MusicAffinity.short, MusicAffinity.long, MusicAffinity.updated_at).filter(
            MusicAffinity.id > last_id, MusicAffinity.plays == 0, MusicAffinity.skips == 0,
            MusicAffinity.updated_at < idle_before,
        ).order_by(MusicAffinity.id).limit(_MUSIC_TASTE_PRUNE_CHUNK).all()
        if not rows:
            break
        last_id = rows[-1][0]
        dead = [row_id for row_id, short, long_, updated_at in rows
                if abs(_music_decay(short, updated_at, now, half_short)) < _MUSIC_AFFINITY_FLOOR
                and abs(_music_decay(long_, updated_at, now, half_long)) < _MUSIC_AFFINITY_FLOOR]
        if dead:
            # Re-checked in the DELETE: a row a play touched meanwhile is no longer idle.
            faded += MusicAffinity.query.filter(
                MusicAffinity.id.in_(dead), MusicAffinity.plays == 0, MusicAffinity.skips == 0,
                MusicAffinity.updated_at < idle_before,
            ).delete(synchronize_session=False) or 0
            db.session.commit()
    seen = MusicSpotlightSeen.query.filter(
        MusicSpotlightSeen.first_seen < now - timedelta(days=_MUSIC_TASTE_CATALOG_DAYS),
    ).delete(synchronize_session=False) or 0
    db.session.commit()
    if listens or faded or seen:
        print(f'[CLEANUP] Music taste: removed {listens} old plays, {faded} faded taste rows, '
              f'{seen} old spotlight rows')
    return listens, faded


# ─── Home: For you ──────────────────────────────────────────────────────────

# Release window of the cached album pool; music_spotlight_new_days is capped to it.
_MUSIC_TASTE_CATALOG_DAYS = 120
_MUSIC_NEW_FOR_YOU_DAYS = 60
_MUSIC_NEW_FOR_YOU_MAX = 12
_MUSIC_RECENT_MAX = 8
_MUSIC_RECENT_SCAN = 200
_MUSIC_POPULAR_WINDOW = timedelta(days=7)
_MUSIC_POPULAR_MIN_USERS = 2
_MUSIC_SPOTLIGHT_EVENTS_MAX = 50
_MUSIC_SPOTLIGHT_EVENT_TYPES = ('impression', 'click', 'dismiss')
_MUSIC_SPOTLIGHT_MIN_SLIDES = 2
_MUSIC_SPOTLIGHT_AGE_HALF_LIFE = 10.0  # days
_MUSIC_SPOTLIGHT_KIND_WEIGHTS = {'new_release': 1.0, 'lapsed': 0.8, 'discover': 0.6, 'popular': 0.5, 'latest': 0.3}
_MUSIC_SPOTLIGHT_CAP_DAYS = 3
# Lapsed fan: long taste at least this, short below this share of it, no play for this long.
_MUSIC_LAPSED_MIN_LONG = 3.0
_MUSIC_LAPSED_SHORT_SHARE = 0.35
_MUSIC_LAPSED_AFTER = timedelta(days=30)
_MUSIC_SPOTLIGHT_KICKERS = {'single': 'New single', 'album': 'New album', 'ep': 'New EP'}
_MUSIC_SPOTLIGHT_REASONS = {
    'new_release': 'Because you listen to {artist}',
    'lapsed': "You haven't played {artist} in a while",
    'discover': 'Because you like {genre}',
    'popular': 'Popular on ONE.GY this week',
    'latest': 'New in the library',
}
# user id -> (key, etag, payload)
_MUSIC_FORYOU_CACHE = {}
# 'entry' -> ((library snapshot, ttl window, release window), {album id: users})
_MUSIC_POPULAR_CACHE = {}
# (library snapshot, {artist id: cover_path}): spotlight avatars, resolved when first shown
_MUSIC_ARTIST_COVERS = (None, {})


def _music_release_date(value):
    """date of a release_date 'YYYY-MM-DD' or 'YYYY-MM' (first of the month); None for a bare year."""
    if not isinstance(value, str):
        return None
    for fmt, size in (('%Y-%m-%d', 10), ('%Y-%m', 7)):
        try:
            return datetime.strptime(value[:size], fmt).date()
        except ValueError:
            continue
    return None


def _music_day_start(day):
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)


def _music_build_taste_albums(conn):
    """Available albums released in the last _MUSIC_TASTE_CATALOG_DAYS days (or
    dated later), newest first, as album cards with release date and genres:
    the pool of the spotlight and of "new from artists you play". Library-wide;
    filtered by today's date on every read."""
    since = (datetime.now(timezone.utc).date() - timedelta(days=_MUSIC_TASTE_CATALOG_DAYS)).isoformat()
    cards = _music_album_list(conn, conn.execute(f'''{_MUSIC_ALBUM_CARD_SELECT}
        WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY} AND a.release_date >= ?
        GROUP BY a.id
        ORDER BY a.release_date DESC, a.name
    ''', [since]).fetchall())
    genres = {}
    for chunk in _music_chunks([card['id'] for card in cards]):
        for row in conn.execute(f'''
            SELECT DISTINCT s.album_id, g.genre FROM songs s
            JOIN song_genres g ON g.song_id = s.id
            WHERE s.album_id IN ({','.join('?' for _ in chunk)})
        ''', chunk).fetchall():
            name = (row['genre'] or '').strip()
            if name:
                genres.setdefault(row['album_id'], {})[name.lower()[:_MUSIC_AFFINITY_KEY_MAX]] = name
    albums = []
    for card in cards:
        released = _music_release_date(card['release_date'])
        if released is not None:
            albums.append({'card': card, 'released': released, 'genres': genres.get(card['id'], {})})
    return {'albums': albums, 'by_id': {album['card']['id']: album for album in albums}}


def _music_artist_covers(artist_ids):
    """artist id -> cover_path, cached per library snapshot."""
    global _MUSIC_ARTIST_COVERS
    if _MUSIC_ARTIST_COVERS[0] != _MUSIC_CATALOG_KEY:
        _MUSIC_ARTIST_COVERS = (_MUSIC_CATALOG_KEY, {})
    covers = _MUSIC_ARTIST_COVERS[1]
    missing = [artist_id for artist_id in artist_ids if artist_id not in covers]
    if missing and _music_library_available():
        conn = _get_music_db()
        try:
            for artist_id in missing:
                covers[artist_id] = _resolve_artist_cover(conn, artist_id, None)
        finally:
            conn.close()
    return {artist_id: covers.get(artist_id) for artist_id in artist_ids}


def _music_taste_pool():
    if not _AVAILABLE_SONG_IDS or not _music_library_available():
        return None
    return _music_catalog('taste_albums', _music_build_taste_albums)[1]


def _music_popular(candidates, now, ttl, new_days):
    """album id -> distinct users with a qualified play in the last 7 days, for
    spotlight candidates that at least _MUSIC_POPULAR_MIN_USERS users played.
    All users, counts only; cached for the ttl window."""
    key = (_MUSIC_CATALOG_KEY, int(now.timestamp()) // ttl, new_days)
    entry = _MUSIC_POPULAR_CACHE.get('entry')
    if entry is not None and entry[0] == key:
        return entry[1]
    counts = {}
    for chunk in _music_chunks([album['card']['id'] for album in candidates]):
        for album_id, users in db.session.query(
                MusicListen.album_id, db.func.count(MusicListen.user_id.distinct()),
        ).filter(
            MusicListen.started_at >= now - _MUSIC_POPULAR_WINDOW,
            MusicListen.outcome.in_(_MUSIC_QUALIFIED),
            MusicListen.album_id.in_(chunk),
        ).group_by(MusicListen.album_id).all():
            if users >= _MUSIC_POPULAR_MIN_USERS:
                counts[album_id] = int(users)
    _MUSIC_POPULAR_CACHE['entry'] = (key, counts)
    return counts


def _music_albums_reached(user_id, albums):
    """Ids of albums the user had a qualified play from since their release."""
    if not albums:
        return set()
    released = {album['card']['id']: _music_day_start(album['released']) for album in albums}
    rows = db.session.query(MusicListen.album_id, db.func.max(MusicListen.started_at)).filter(
        MusicListen.user_id == user_id,
        MusicListen.album_id.in_(sorted(released)),
        MusicListen.outcome.in_(_MUSIC_QUALIFIED),
    ).group_by(MusicListen.album_id).all()
    return {album_id for album_id, last in rows if last is not None and _utc_aware(last) >= released[album_id]}


def _music_spotlight(user_id, now, ttl, visible, taste):
    """Spotlight slides (docs/music-taste.md "Spotlight ranking")."""
    import math
    new_days = max(1, min(get_numeric_setting('music_spotlight_new_days'), _MUSIC_TASTE_CATALOG_DAYS))
    max_slides = max(0, get_numeric_setting('music_spotlight_max_slides'))
    today = now.date()
    candidates = [album for album in visible if (today - album['released']).days <= new_days]
    if not max_slides:
        return []
    seen = {row.item: row for row in MusicSpotlightSeen.query.filter(MusicSpotlightSeen.user_id == user_id).all()}
    reached = _music_albums_reached(user_id, candidates)
    artists, genres = taste['artist'], taste['genre']
    top_genres = [key for key, entry in sorted(genres.items(), key=lambda kv: -kv[1][0]) if entry[0] > 0][:3]

    def artist_taste(artist):
        entry = artists.get(artist['id'])
        return entry[0] if entry else 0.0

    def blocked(card, reached):
        row = seen.get(f'album:{card["id"]}')
        return card['id'] in reached or (row is not None and (
            row.dismissed_at is not None or (row.snoozed_until is not None and _utc_aware(row.snoozed_until) > now)))

    eligible, rest = [], []
    for album in candidates:
        card = album['card']
        if blocked(card, reached):
            continue
        slide = {'album': album, 'kind': None, 'artist': card['artists'][0] if card['artists'] else None,
                 'genre': None, 'taste': 0.0}
        for artist in card['artists']:
            entry = artists.get(artist['id'])
            if entry and entry[2] >= _MUSIC_LAPSED_MIN_LONG and entry[1] < _MUSIC_LAPSED_SHORT_SHARE * entry[2] \
                    and entry[4] is not None and entry[4] < now - _MUSIC_LAPSED_AFTER:
                slide.update(kind='lapsed', artist=artist, taste=entry[0])
                break
        best = max(card['artists'], key=artist_taste, default=None)
        if slide['kind'] is None and best is not None and artist_taste(best) > 0:
            slide.update(kind='new_release', artist=best, taste=artist_taste(best))
        if slide['kind'] is None and card['artists'] and not any(a['id'] in artists for a in card['artists']):
            genre = next((key for key in top_genres if key in album['genres']), None)
            if genre is not None:
                slide.update(kind='discover', genre=album['genres'][genre], taste=genres[genre][0])
        if slide['kind'] is not None:
            eligible.append(slide)
        elif best is None or artist_taste(best) >= 0:
            rest.append(slide)
    popular = _music_popular(candidates, now, ttl, new_days)
    top = max((s for s in rest if s['album']['card']['id'] in popular),
              key=lambda s: popular[s['album']['card']['id']], default=None)
    if top is not None:
        top['kind'] = 'popular'
        rest.remove(top)
        eligible.append(top)
    for slide in eligible:
        age = (today - slide['album']['released']).days
        slide['score'] = (_MUSIC_SPOTLIGHT_KIND_WEIGHTS[slide['kind']] * 0.5 ** (age / _MUSIC_SPOTLIGHT_AGE_HALF_LIFE)
                          * (1 + math.log1p(max(0.0, slide['taste']))))
    # Weighted shuffle (Efraimidis-Spirakis), seeded per user and ttl window: the first slide rotates.
    rng = random.Random(f'{user_id}:{int(now.timestamp()) // ttl}')
    order = sorted(eligible, key=lambda s: math.log(rng.random() or 1e-12) / s['score'], reverse=True)
    slides, capped = [], set()
    for slide in order:
        if len(slides) >= max_slides:
            break
        if slide['kind'] == 'discover':
            if 'discover' in capped:
                continue
            capped.add('discover')
        slides.append(slide)
    want = min(_MUSIC_SPOTLIGHT_MIN_SLIDES, max_slides)
    if len(slides) + len(rest) < want:
        # Nothing that new in the library: the newest releases before the window
        before = [album for album in visible if (today - album['released']).days > new_days][:want * 4]
        before_reached = _music_albums_reached(user_id, before)
        for album in before:
            card = album['card']
            best = max(card['artists'], key=artist_taste, default=None)
            if not blocked(card, before_reached) and (best is None or artist_taste(best) >= 0):
                rest.append({'album': album, 'kind': None, 'artist': best, 'genre': None, 'taste': 0.0})
    for slide in rest:  # newest first
        if len(slides) >= want:
            break
        slide['kind'] = 'latest'
        slides.append(slide)
    covers = _music_artist_covers([slide['artist']['id'] for slide in slides if slide['artist']])
    result = []
    for slide in slides:
        card, artist = slide['album']['card'], slide['artist']
        older = (today - slide['album']['released']).days > new_days
        kicker = 'Latest release' if slide['kind'] == 'lapsed' or older else \
            _MUSIC_SPOTLIGHT_KICKERS.get((card.get('album_type') or '').lower(), 'Latest release')
        result.append({
            'item': f'album:{card["id"]}', 'kind': slide['kind'], 'kicker': kicker,
            'reason': 'Recently released' if older else _MUSIC_SPOTLIGHT_REASONS[slide['kind']].format(
                artist=artist['name'] if artist else '', genre=slide['genre'] or ''),
            'album': card,
            'artist': {'id': artist['id'], 'name': artist['name'],
                       'cover_path': covers.get(artist['id'])} if artist else None,
        })
    return result


def _music_recent_contexts(user_id):
    """The user's last distinct play contexts (albums, playlists, liked songs,
    artists; other plays count as their album), newest first."""
    keys = []
    for context, album_id in db.session.query(MusicListen.context, MusicListen.album_id).filter(
            MusicListen.user_id == user_id).order_by(MusicListen.started_at.desc()).limit(_MUSIC_RECENT_SCAN).all():
        kind, _, ref = (context or '').partition(':')
        if context == 'liked':
            key = 'liked'
        elif kind in ('album', 'playlist', 'artist') and ref:
            key = context
        elif album_id:
            key = f'album:{album_id}'
        else:
            continue
        if key not in keys:
            keys.append(key)
            # Some may be gone (deleted playlist, album left the library): look up a few spare.
            if len(keys) >= 2 * _MUSIC_RECENT_MAX:
                break
    found = {}
    album_ids = [key[len('album:'):] for key in keys if key.startswith('album:')]
    artist_ids = [key[len('artist:'):] for key in keys if key.startswith('artist:')]
    if (album_ids or artist_ids) and _music_library_available():
        conn = _get_music_db()
        try:
            if album_ids:
                for row in conn.execute(f'SELECT id, name, cover_path FROM albums WHERE id IN '
                                        f'({",".join("?" for _ in album_ids)})', album_ids).fetchall():
                    found[f'album:{row["id"]}'] = (row['name'], _resolve_album_cover(conn, row['id'], row['cover_path']))
            if artist_ids:
                for row in conn.execute(f'SELECT id, name FROM artists WHERE id IN '
                                        f'({",".join("?" for _ in artist_ids)})', artist_ids).fetchall():
                    found[f'artist:{row["id"]}'] = (row['name'], _resolve_artist_cover(conn, row['id'], None))
        finally:
            conn.close()
    if any(key.startswith('playlist:') for key in keys):
        for playlist in _music_playlists_payload(user_id):
            found[f'playlist:{playlist["id"]}'] = (playlist['name'], playlist['cover_path'])
    if 'liked' in keys:
        found['liked'] = ('Liked songs', None)
    return [{'context': key, 'name': found[key][0], 'cover_path': found[key][1]}
            for key in keys if key in found][:_MUSIC_RECENT_MAX]


def _music_spotlight_ttl():
    return max(60, min(get_numeric_setting('music_spotlight_ttl_seconds'), 86400))


def _music_build_foryou(user_id, now, ttl):
    payload = {'ttl': ttl, 'spotlight': [], 'new_for_you': [], 'recent': _music_recent_contexts(user_id)}
    pool = _music_taste_pool()
    if pool is None:
        return payload
    taste = _music_taste(user_id, now)
    hidden = _music_hidden(user_id)
    today = now.date()
    visible = [album for album in pool['albums']
               if album['released'] <= today and album['card']['id'] not in hidden['album']
               and not any(artist['id'] in hidden['artist'] for artist in album['card']['artists'])]

    def liked_artist(album):
        return any(taste['artist'].get(artist['id'], (0.0,))[0] > 0 for artist in album['card']['artists'])

    payload['new_for_you'] = [album['card'] for album in visible
                              if (today - album['released']).days <= _MUSIC_NEW_FOR_YOU_DAYS
                              and liked_artist(album)][:_MUSIC_NEW_FOR_YOU_MAX]
    payload['spotlight'] = _music_spotlight(user_id, now, ttl, visible, taste)
    return payload


@app.route('/music/api/foryou')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_foryou():
    """Home's personal part: spotlight, new_for_you, recent (docs/music-taste.md
    §3). Cached per user for ttl (library snapshot, taste version); ETag -> 304."""
    from flask import Response
    user_id = session['logged_in_user_id']
    now = datetime.now(timezone.utc)
    ttl = _music_spotlight_ttl()
    key = (_MUSIC_CATALOG_KEY, _MUSIC_TASTE_VERSIONS.get(user_id, 0), int(now.timestamp()) // ttl, ttl)
    entry = _MUSIC_FORYOU_CACHE.get(user_id)
    if entry is None or entry[0] != key:
        payload = _music_build_foryou(user_id, now, ttl)
        body = json.dumps(payload, sort_keys=True, separators=(',', ':'), default=str)
        entry = (key, 'fy-' + hashlib.sha256(body.encode('utf-8')).hexdigest()[:32], payload)
        _MUSIC_FORYOU_CACHE[user_id] = entry
    # Flask-Compress sends the tag as "<etag>:<algorithm>"; match either form.
    sent = {tag.split(':')[0] for tag in request.if_none_match.as_set(include_weak=True)}
    resp = Response(status=304) if entry[1] in sent else jsonify(entry[2])
    resp.set_etag(entry[1])
    resp.cache_control.private = True
    resp.cache_control.no_cache = True
    return resp


def _music_record_spotlight(user_id, wanted, pool, now):
    """Apply spotlight events (the caller commits). True when an item was
    snoozed or dismissed, which changes the feed."""
    rows = {row.item: row for row in MusicSpotlightSeen.query.filter(
        MusicSpotlightSeen.user_id == user_id, MusicSpotlightSeen.item.in_(sorted(wanted))).with_for_update().all()}
    cap = get_numeric_setting('music_spotlight_impression_cap')
    snooze = timedelta(days=max(0, get_numeric_setting('music_spotlight_snooze_days')))
    acc = {}
    changed = False
    for item, types in wanted.items():
        row = rows.get(item)
        if row is None:
            row = MusicSpotlightSeen(user_id=user_id, item=item, impressions=0, days=0, clicks=0, first_seen=now)
            db.session.add(row)
        if 'impression' in types:
            last_seen = _utc_aware(row.last_seen)
            if last_seen is None or last_seen.date() != now.date():
                row.days = (row.days or 0) + 1
            row.impressions = (row.impressions or 0) + 1
            row.last_seen = now
            if cap > 0 and not row.clicks and row.impressions >= cap and row.days >= _MUSIC_SPOTLIGHT_CAP_DAYS:
                # Snoozed with a fresh count: after the snooze it gets another full cap.
                row.snoozed_until = now + snooze
                row.impressions = 0
                row.days = 0
                changed = True
        if 'click' in types:
            row.clicks = (row.clicks or 0) + 1
        if 'dismiss' in types and row.dismissed_at is None:
            row.dismissed_at = now
            changed = True
            for artist in pool['by_id'][item[len('album:'):]]['card']['artists']:
                acc.setdefault(('artist', artist['id']), [0.0, 0, 0, None, None])[0] += _MUSIC_DISMISS_ARTIST_WEIGHT
    if acc and get_setting('music_taste_enabled'):
        _music_apply_taste(user_id, acc, now)
    return changed


@app.route('/music/api/spotlight/seen', methods=['POST'])
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_spotlight_seen():
    """{events: [{item: 'album:<id>', type: impression|click|dismiss}]} (≤ 50) -> 204.
    Items outside the spotlight's album pool are ignored."""
    from sqlalchemy.exc import IntegrityError as _IntegrityError, OperationalError as _OperationalError
    data = request.get_json(silent=True)
    events = data.get('events') if isinstance(data, dict) else None
    if not isinstance(events, list):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    pool = _music_taste_pool()
    if pool is None:
        return '', 204
    wanted = {}
    for ev in events[:_MUSIC_SPOTLIGHT_EVENTS_MAX]:
        if not isinstance(ev, dict):
            continue
        item, kind = ev.get('item'), ev.get('type')
        if kind in _MUSIC_SPOTLIGHT_EVENT_TYPES and isinstance(item, str) and item.startswith('album:') \
                and item[len('album:'):] in pool['by_id']:
            wanted.setdefault(item, set()).add(kind)
    if not wanted:
        return '', 204
    user_id = session['logged_in_user_id']
    now = datetime.now(timezone.utc)
    for attempt in range(2):
        try:
            changed = _music_record_spotlight(user_id, wanted, pool, now)
            db.session.commit()
            break
        except (_IntegrityError, _OperationalError) as e:
            db.session.rollback()  # a concurrent first event created the row: update it instead
            if attempt:
                print(f'[MUSIC] Spotlight events failed for user {user_id}: {type(e).__name__}')
                return jsonify({'error': 'PLEASE TRY AGAIN'}), 503
    if changed:
        _music_taste_bump(user_id)
    return '', 204
