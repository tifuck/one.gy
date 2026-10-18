# Available song IDs cache -- only songs with audio.opus on disk
_AVAILABLE_SONG_IDS = set()
# AUDIT FIX A16: _scan_available_songs() used to run exactly ONCE at import with
# no scheduler job, CLI command or admin route to re-run it, so songs added to
# disk were invisible until `systemctl restart` and deleted songs stayed listed
# and 404'd on stream. The cleanup job now re-scans on this interval.
_AVAILABLE_SONGS_SCAN_LOCK = threading.Lock()
_AVAILABLE_SONGS_SCANNED_AT = 0.0
MUSIC_RESCAN_INTERVAL_SECONDS = 300
# Name of the per-connection TEMP table holding the available song ids. Using a
# temp table instead of inlining every id as a bind parameter keeps every music
# query independent of library size.
_MUSIC_AVAILABLE_TABLE = 'available_song_ids'

def _scan_available_songs():
    """Scan the music library directory for songs with audio files on disk."""
    global _AVAILABLE_SONG_IDS, _AVAILABLE_SONGS_SCANNED_AT
    songs_dir = os.path.join(MUSIC_LIBRARY_PATH, 'songs')
    if not os.path.isdir(songs_dir):
        print(f'[MUSIC] Songs directory not found: {songs_dir}')
        return
    available = set()
    try:
        for entry in os.scandir(songs_dir):
            if entry.is_dir():
                audio_path = os.path.join(entry.path, 'audio.opus')
                if os.path.isfile(audio_path):
                    available.add(entry.name)
    except Exception as e:
        print(f'[MUSIC] Error scanning songs directory: {e}')
        return
    previous = len(_AVAILABLE_SONG_IDS)
    # Replaced whole (GIL-atomic) so readers never observe a partial set.
    _AVAILABLE_SONG_IDS = available
    _AVAILABLE_SONGS_SCANNED_AT = time.monotonic()
    if previous != len(available):
        print(f'[MUSIC] Found {len(available)} songs with audio on disk (was {previous})')
    else:
        print(f'[MUSIC] Found {len(available)} songs with audio on disk')

def maybe_rescan_available_songs(force=False):
    """Re-scan the music library at most once per MUSIC_RESCAN_INTERVAL_SECONDS.

    AUDIT FIX A16: called from the 5-minute cleanup job so the library stays in
    sync with the disk without a restart. Never raises -- the cleanup tick must
    not fail because the music share is unavailable."""
    global _AVAILABLE_SONGS_SCANNED_AT
    try:
        interval = get_numeric_setting('music_rescan_interval_seconds', MUSIC_RESCAN_INTERVAL_SECONDS)
    except Exception:
        interval = MUSIC_RESCAN_INTERVAL_SECONDS
    if interval <= 0 and not force:
        return False
    if not force and (time.monotonic() - _AVAILABLE_SONGS_SCANNED_AT) < interval:
        return False
    # Non-blocking: if a scan is already in flight, skip this tick.
    if not _AVAILABLE_SONGS_SCAN_LOCK.acquire(blocking=False):
        return False
    try:
        if not force and (time.monotonic() - _AVAILABLE_SONGS_SCANNED_AT) < interval:
            return False
        _scan_available_songs()
        return True
    except Exception as e:
        print(f'[MUSIC] Library re-scan failed: {e}')
        return False
    finally:
        _AVAILABLE_SONGS_SCAN_LOCK.release()

def _get_music_db(with_available=False):
    """Open a read-only connection to the music library database.

    AUDIT FIX A16: pass with_available=True to get a TEMP table named
    _MUSIC_AVAILABLE_TABLE holding the ids of songs that actually exist on disk.
    Every music API used to build `','.join('?' for _ in available_list)` over
    ALL ~8700 ids (four times per request in /music/api/search). SQLite's
    SQLITE_MAX_VARIABLE_NUMBER is 32766, so past ~32k songs EVERY music API
    hard-failed with `too many SQL variables`. A TEMP table has no such limit
    (~5ms to populate 8700 ids) and it lives in the connection's private temp
    database, so it works even though the main database is opened read-only."""
    import sqlite3
    db_path = os.path.join(MUSIC_LIBRARY_PATH, 'library.db')
    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    if with_available:
        try:
            conn.execute(
                f'CREATE TEMP TABLE {_MUSIC_AVAILABLE_TABLE} (id TEXT PRIMARY KEY) WITHOUT ROWID')
            snapshot = _AVAILABLE_SONG_IDS
            conn.executemany(
                f'INSERT OR IGNORE INTO {_MUSIC_AVAILABLE_TABLE} (id) VALUES (?)',
                ((song_id,) for song_id in snapshot))
        except Exception:
            conn.close()
            raise
    return conn

# SQL fragment every catalog query uses in place of an inlined IN (...) list.
_MUSIC_AVAILABLE_SUBQUERY = f'(SELECT id FROM {_MUSIC_AVAILABLE_TABLE})'

# MusicDevice.device_id / MusicSyncState.active_device_id / .transfer_to are all
# String(36); MusicDevice.device_name is String(100).
_MUSIC_DEVICE_ID_MAX = 36
_MUSIC_DEVICE_NAME_MAX = 100
_MUSIC_COMMAND_PAYLOAD_MAX = 1024 * 1024
_MUSIC_COMMAND_RESULT_MAX = 16 * 1024
_MUSIC_COMMAND_MAX_LIVE_PER_USER = 200
_MUSIC_COMMAND_TTL = timedelta(minutes=30)
_MUSIC_COMMAND_RESULT_RETENTION = timedelta(hours=24)
_MUSIC_COMMAND_CONSUMED_RETENTION = timedelta(hours=1)


def _music_json_str(value, default='', truncate_to=None):
    """Coerce a JSON body field to a trimmed string.

    AUDIT FIX A17: `data.get('device_id', '').strip()` returns the PRESENT
    value, so a body of {"device_id": null} produced None.strip() ->
    AttributeError -> HTTP 500. Non-string values (numbers, lists, dicts) fall
    back to the default rather than being coerced."""
    if value is None or not isinstance(value, str):
        return default
    value = value.strip()
    if truncate_to is not None:
        value = value[:truncate_to]
    return value


def _music_valid_device_id(device_id):
    """A device id must be present and fit MusicDevice.device_id (String(36)).

    AUDIT FIX A17: an over-long id used to reach the column as a DataError 500."""
    return bool(device_id) and len(device_id) <= _MUSIC_DEVICE_ID_MAX


def _music_mailbox_lock(user_id):
    return _acquire_scoped_lock(f'music-sync-mailbox:{int(user_id)}', prefix='music_sync')


def _music_mailbox_unlock(lock_file):
    _release_scoped_lock(lock_file)


def _music_clear_stale_active_device(user_id, online_cutoff):
    """Clear the sync state of an active device not seen since online_cutoff.

    Re-decided under the mailbox lock on locking (current) reads: the caller's
    earlier snapshot may predate a push from a device that just resumed, whose
    fresh state must not be erased. Returns the refreshed row; caller commits."""
    mailbox_lock = _music_mailbox_lock(user_id)
    try:
        db.session.flush()
        sync = MusicSyncState.query.filter_by(user_id=user_id).with_for_update().populate_existing().first()
        stale_id = sync.active_device_id if sync else None
        if stale_id and not MusicDevice.query.filter(
                MusicDevice.user_id == user_id,
                MusicDevice.device_id == stale_id,
                MusicDevice.last_seen >= online_cutoff,
        ).with_for_update().populate_existing().first():
            print(f'[MUSIC] Active device {stale_id[:8]} stale (>30s), clearing sync state for user {user_id}')
            sync.active_device_id = None
            sync.state_json = None
            sync.transfer_to = None
        return sync
    finally:
        _music_mailbox_unlock(mailbox_lock)


def _music_command_payload(command):
    import json as _json
    try:
        payload_json = _json.dumps(command, separators=(',', ':'))
    except (TypeError, ValueError):
        return None
    if len(payload_json.encode('utf-8')) > _MUSIC_COMMAND_PAYLOAD_MAX:
        return None
    return payload_json


def _prune_music_sync_commands(user_id=None, now=None):
    """Expire abandoned work and bound retained result/ack records."""
    now = now or datetime.now(timezone.utc)
    query = MusicSyncCommand.query
    if user_id is not None:
        query = query.filter(MusicSyncCommand.user_id == user_id)

    expired = query.filter(
        MusicSyncCommand.status.in_(('pending', 'claimed')),
        MusicSyncCommand.expires_at.isnot(None),
        MusicSyncCommand.expires_at < now,
    ).update({
        MusicSyncCommand.status: 'expired',
        MusicSyncCommand.consumed_at: now,
    }, synchronize_session=False)

    delete_query = MusicSyncCommand.query
    if user_id is not None:
        delete_query = delete_query.filter(MusicSyncCommand.user_id == user_id)
    deleted = delete_query.filter(
        db.or_(
            db.and_(
                MusicSyncCommand.consumed_at.isnot(None),
                MusicSyncCommand.consumed_at < now - _MUSIC_COMMAND_CONSUMED_RETENTION,
            ),
            db.and_(
                MusicSyncCommand.created_at < now - _MUSIC_COMMAND_RESULT_RETENTION,
                MusicSyncCommand.status.in_(('completed', 'acknowledged', 'expired')),
            ),
        )
    ).delete(synchronize_session=False)
    return int(expired or 0) + int(deleted or 0)


def _music_claim_next_command(user_id, target_device_id, now):
    """Claim one target-specific FIFO command exactly once."""
    outstanding = MusicSyncCommand.query.filter_by(
        user_id=user_id,
        target_device_id=target_device_id,
        status='claimed',
    ).first()
    if outstanding:
        return None

    while True:
        command = MusicSyncCommand.query.filter(
            MusicSyncCommand.user_id == user_id,
            MusicSyncCommand.target_device_id == target_device_id,
            MusicSyncCommand.status == 'pending',
            db.or_(MusicSyncCommand.expires_at.is_(None), MusicSyncCommand.expires_at >= now),
        ).order_by(MusicSyncCommand.id.asc()).first()
        if not command:
            return None
        claimed = MusicSyncCommand.query.filter_by(
            id=command.id,
            status='pending',
        ).update({
            MusicSyncCommand.status: 'claimed',
            MusicSyncCommand.claimed_at: now,
        }, synchronize_session=False)
        if claimed:
            db.session.flush()
            command = MusicSyncCommand.query.populate_existing().filter_by(id=command.id).first()
            try:
                payload = json.loads(command.payload_json)
            except Exception:
                command.status = 'expired'
                command.consumed_at = now
                continue
            payload['command_id'] = command.command_id
            payload['requester_device_id'] = command.requester_device_id
            payload['target_device_id'] = command.target_device_id
            payload['created_at'] = command.created_at.isoformat() if command.created_at else None
            return payload
        db.session.expire_all()


def _music_store_command_result(user_id, target_device_id, result, now):
    """Persist a target device's result idempotently and return its command id."""
    if not isinstance(result, dict):
        return None
    command_id = _music_json_str(result.get('command_id'))
    if not command_id:
        return None
    command = MusicSyncCommand.query.filter_by(
        user_id=user_id,
        command_id=command_id,
        target_device_id=target_device_id,
    ).first()
    if not command or command.status not in ('claimed', 'completed', 'acknowledged'):
        return None
    if command.status in ('completed', 'acknowledged'):
        return command.command_id

    stored_result = dict(result)
    stored_result['command_id'] = command.command_id
    stored_result['action'] = stored_result.get('action') or json.loads(command.payload_json).get('action')
    try:
        result_json = json.dumps(stored_result, separators=(',', ':'))
    except (TypeError, ValueError):
        return None
    if len(result_json.encode('utf-8')) > _MUSIC_COMMAND_RESULT_MAX:
        return None
    command.result_json = result_json
    command.status = 'completed'
    command.completed_at = now
    return command.command_id


def _music_pending_result(user_id, requester_device_id, now):
    command = MusicSyncCommand.query.filter_by(
        user_id=user_id,
        requester_device_id=requester_device_id,
        status='completed',
    ).order_by(MusicSyncCommand.id.asc()).first()
    if not command:
        return None
    try:
        result = json.loads(command.result_json)
    except Exception:
        command.status = 'expired'
        command.consumed_at = now
        return None
    command.result_delivered_at = now
    result['command_id'] = command.command_id
    result['target_device_id'] = command.target_device_id
    result['completed_at'] = command.completed_at.isoformat() if command.completed_at else None
    return result

def _music_search_tokenize(query):
    """Tokenize and normalize a search query for fuzzy matching.
    Supports formats like 'don toliver - fw', 'fwu', 'ver fw'.
    Splits on spaces and hyphens, lowercases everything."""
    import re
    q = query.lower().strip()
    # Split on whitespace, hyphens, commas
    tokens = re.split(r'[\s\-,]+', q)
    return [t for t in tokens if t]

def _music_fuzzy_match(tokens, text):
    """Check if all tokens match somewhere in the text (substring match).
    This gives very loose but accurate matching: 'fw' matches 'FWU', 'don' matches 'Don Toliver'."""
    text_lower = text.lower()
    for token in tokens:
        if token not in text_lower:
            return False
    return True

def _music_search_score(tokens, song_title, artist_names, album_name):
    """Score a search match. Higher = better match. Returns 0 if no match.
    Supports 'artist - title' format and loose substring matching across all fields."""
    combined = f'{song_title} {artist_names} {album_name}'.lower()
    # All tokens must appear somewhere in the combined text
    for token in tokens:
        if token not in combined:
            return 0
    # Scoring: prioritize title matches, then artist, then album
    score = 0
    title_lower = song_title.lower()
    artist_lower = artist_names.lower()
    for token in tokens:
        if token in title_lower:
            score += 10
            if title_lower.startswith(token):
                score += 5
        if token in artist_lower:
            score += 7
            if artist_lower.startswith(token):
                score += 3
        if token in album_name.lower():
            score += 2
    # Bonus for exact title match
    if song_title.lower() == ' '.join(tokens):
        score += 50
    return score

def _enrich_songs_from_library(song_ids):
    """Given a list of song IDs, return enriched song data from library.db."""
    if not song_ids:
        return []
    song_ids = list(song_ids)
    conn = _get_music_db()
    try:
        # AUDIT FIX A16: chunk the bind parameters. song_ids comes from playlists
        # and liked-song lists, which are user-controlled and unbounded; a single
        # IN (...) over all of them would eventually trip SQLITE_MAX_VARIABLE_NUMBER.
        chunk_size = 500
        rows = []
        artist_rows = []
        # Query each id once: a repeat in a later chunk appended its artist rows
        # a second time. song_ids (duplicates included) still drives the output.
        unique_ids = list(dict.fromkeys(song_ids))
        for start in range(0, len(unique_ids), chunk_size):
            chunk = unique_ids[start:start + chunk_size]
            placeholders = ','.join('?' for _ in chunk)
            rows.extend(conn.execute(f'''
                SELECT s.id, s.title, s.duration_ms, s.track_number, s.disc_number,
                       s.album_id, a.name as album_name, a.cover_path
                FROM songs s
                LEFT JOIN albums a ON a.id = s.album_id
                WHERE s.id IN ({placeholders})
            ''', chunk).fetchall())
            # Get artists for these songs
            artist_rows.extend(conn.execute(f'''
                SELECT sa.song_id, ar.id as artist_id, ar.name as artist_name, sa.role
                FROM song_artists sa
                JOIN artists ar ON ar.id = sa.artist_id
                WHERE sa.song_id IN ({placeholders})
                ORDER BY sa.role, ar.name
            ''', chunk).fetchall())
        # Group artists by song
        song_artists = {}
        for ar in artist_rows:
            sid = ar['song_id']
            if sid not in song_artists:
                song_artists[sid] = []
            song_artists[sid].append({
                'id': ar['artist_id'],
                'name': ar['artist_name'],
                'role': ar['role']
            })
        # Build result preserving input order
        song_map = {}
        for r in rows:
            artists = song_artists.get(r['id'], [])
            primary = [a for a in artists if a['role'] == 'primary']
            featured = [a for a in artists if a['role'] == 'featured']
            song_map[r['id']] = {
                'id': r['id'],
                'title': r['title'],
                'duration_ms': r['duration_ms'],
                'track_number': r['track_number'],
                'disc_number': r['disc_number'],
                'album_id': r['album_id'],
                'album_name': r['album_name'],
                'cover_path': _resolve_cover_path(r['cover_path'], r['id']),
                'artists': primary,
                'featured_artists': featured,
                'available': r['id'] in _AVAILABLE_SONG_IDS,
            }
        return [song_map[sid] for sid in song_ids if sid in song_map]
    finally:
        conn.close()

def _resolve_cover_path(album_cover_path, song_id):
    """Return the best available cover_path for a song.
    If the album has a cover_path, use it. Otherwise check if the song
    has a per-song cover.jpg and return a synthetic cover_path using the song ID.
    The /music/cover/<id> route resolves it to songs/<id>/cover.jpg."""
    if album_cover_path:
        return album_cover_path
    if song_id:
        song_cover = os.path.join(MUSIC_LIBRARY_PATH, 'songs', song_id, 'cover.jpg')
        if os.path.isfile(song_cover):
            return f'covers/{song_id}.jpg'
    return None

def _resolve_album_cover(conn, album_id, album_cover_path):
    """For an album with no cover_path, find a per-song cover from its first track."""
    if album_cover_path:
        return album_cover_path
    songs = conn.execute(
        'SELECT id FROM songs WHERE album_id = ? ORDER BY disc_number, track_number LIMIT 10',
        [album_id]
    ).fetchall()
    for s in songs:
        song_cover = os.path.join(MUSIC_LIBRARY_PATH, 'songs', s['id'], 'cover.jpg')
        if os.path.isfile(song_cover):
            return f'covers/{s["id"]}.jpg'
    return None

def _resolve_artist_cover(conn, artist_id, current_cover_path):
    """For an artist, prefer their profile image from artists/ folder,
    then fall back to album cover or per-song cover."""
    # Check artist profile picture first
    artist_img = os.path.join(MUSIC_LIBRARY_PATH, 'artists', f'{artist_id}.jpg')
    if os.path.isfile(artist_img):
        return f'artists/{artist_id}.jpg'
    if current_cover_path:
        return current_cover_path
    first_songs = conn.execute('''
        SELECT s.id FROM songs s
        JOIN song_artists sa ON sa.song_id = s.id AND sa.artist_id = ?
        LIMIT 10
    ''', [artist_id]).fetchall()
    for s in first_songs:
        song_cover = os.path.join(MUSIC_LIBRARY_PATH, 'songs', s['id'], 'cover.jpg')
        if os.path.isfile(song_cover):
            return f'covers/{s["id"]}.jpg'
    return None

# Scan available songs on startup
_scan_available_songs()


def _music_required(f):
    """Decorator: login_required + music feature must be enabled.

    AUDIT FIX H1: previously this trusted session['logged_in_user_id'] alone —
    no DB reload and no session_epoch check — so a stale/stolen cookie that the
    victim tried to evict via password change/recovery (which bump
    user.session_epoch) still authenticated to every /music/* endpoint, and a
    deleted user's cookie kept working. Mirror login_required exactly: reload the
    User and enforce session_epoch so the session-eviction guarantee holds here
    too.
    """
    from functools import wraps
    @wraps(f)
    def decorated_function(*args, **kwargs):
        is_ajax = request.headers.get('X-Requested-With') == 'XMLHttpRequest'
        if 'logged_in_user_id' not in session:
            if is_ajax:
                return jsonify({'error': 'LOGIN REQUIRED'}), 401
            return redirect(url_for('login'))
        # AUDIT FIX M14: reject a session that was explicitly revoked by /logout.
        if _is_session_revoked():
            session.clear()
            if is_ajax:
                return jsonify({'error': 'SESSION_EXPIRED', 'redirect': url_for('login')}), 401
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))
        user = db.session.get(User, session['logged_in_user_id'])
        if not user:
            session.clear()
            if is_ajax:
                return jsonify({'error': 'SESSION_EXPIRED', 'redirect': url_for('login')}), 401
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))
        if int(session.get('session_epoch', 0) or 0) != int(user.session_epoch or 0):
            session.clear()
            if is_ajax:
                return jsonify({'error': 'SESSION_EXPIRED', 'redirect': url_for('login')}), 401
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))
        if not get_setting('allow_music'):
            if is_ajax:
                return jsonify({'error': 'MUSIC LIBRARY IS DISABLED'}), 403
            flash('MUSIC LIBRARY IS CURRENTLY DISABLED', 'error')
            return redirect(url_for('index'))
        session.permanent = True
        return f(*args, **kwargs)
    return decorated_function


# ─── Music Page Route ───────────────────────────────────────────────────────

