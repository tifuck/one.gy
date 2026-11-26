@app.route('/music')
@limiter.limit(music_api_rate_limit)
@login_required
@desktop_lock_free
def music_page():
    # Intentionally NOT gated by _music_required: when the allow_music setting
    # is off, the page must still load but render an empty shell (no library,
    # no player, no API calls). All /music/* data routes stay behind
    # _music_required and keep returning 403 while disabled.
    user = _current_session_user()
    if not user:
        session.clear()
        return redirect(url_for('login'))
    music_disabled = not get_setting('allow_music')
    if music_disabled:
        print(f'[MUSIC] Serving /music in disabled (empty shell) mode for user {user.id}')
    return render_template('music.html', user=user, music_disabled=music_disabled)


# ─── Music Asset Routes ─────────────────────────────────────────────────────

@app.route('/music/stream/<song_id>')
@limiter.limit(music_stream_rate_limit)
@_music_required
def music_stream(song_id):
    """Stream a song's audio (audio.opus, else audio.m4a) with Range request support."""
    from flask import Response
    from werkzeug.utils import secure_filename as _sf_music
    # Sanitize song_id to prevent path traversal, then verify it exists in the
    # known-good set (which was populated by scanning the actual filesystem).
    safe_song_id = _sf_music(song_id)
    if not safe_song_id or safe_song_id not in _AVAILABLE_SONG_IDS:
        return jsonify({'error': 'SONG NOT FOUND'}), 404
    song_id = safe_song_id
    audio_mimetype = 'audio/ogg'
    audio_path = os.path.join(MUSIC_LIBRARY_PATH, 'songs', song_id, 'audio.opus')
    if not os.path.isfile(audio_path):
        audio_mimetype = 'audio/mp4'
        audio_path = os.path.join(MUSIC_LIBRARY_PATH, 'songs', song_id, 'audio.m4a')
    if not os.path.isfile(audio_path):
        return jsonify({'error': 'AUDIO FILE NOT FOUND'}), 404
    file_size = os.path.getsize(audio_path)
    range_header = request.headers.get('Range')
    if range_header:
        # Same parser as sync content: malformed, multi-range or invalid
        # (last < first) ranges are ignored and the full file is served.
        byte_range = _sync_parse_range(range_header, file_size)
        # AUDIT FIX L9: per RFC 9110, an unsatisfiable range must return
        # 416 with a Content-Range header indicating the resource size.
        if byte_range == 'unsatisfiable':
            resp = Response(status=416, mimetype=audio_mimetype)
            resp.headers['Content-Range'] = f'bytes */{file_size}'
            return resp
        if byte_range:
            start, end = byte_range
            length = end - start + 1
            def generate():
                with open(audio_path, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk_size = min(65536, remaining)
                        data = f.read(chunk_size)
                        if not data:
                            break
                        remaining -= len(data)
                        yield data
            resp = Response(generate(), status=206, mimetype=audio_mimetype,
                            content_type=audio_mimetype)
            resp.headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
            resp.headers['Content-Length'] = str(length)
            resp.headers['Accept-Ranges'] = 'bytes'
            resp.headers['Cache-Control'] = 'private, max-age=86400'
            return resp
    # No range -- send full file
    def generate_full():
        with open(audio_path, 'rb') as f:
            while True:
                data = f.read(65536)
                if not data:
                    break
                yield data
    resp = Response(generate_full(), mimetype=audio_mimetype, content_type=audio_mimetype)
    resp.headers['Content-Length'] = str(file_size)
    resp.headers['Accept-Ranges'] = 'bytes'
    resp.headers['Cache-Control'] = 'private, max-age=86400'
    return resp


@app.route('/music/cover/<cover_id>')
@limiter.limit(music_cover_rate_limit)
@_music_required
def music_cover(cover_id):
    """Serve album or per-song cover JPEG.
    Checks album covers first, then falls back to per-song cover.jpg."""
    from werkzeug.utils import secure_filename as _sf
    safe_id = _sf(cover_id)
    # Album cover, then per-song cover (songs/<id>/cover.jpg), then artist
    # profile image (artists/<id>.jpg).
    for path in (os.path.join(MUSIC_LIBRARY_PATH, 'covers', f'{safe_id}.jpg'),
                 os.path.join(MUSIC_LIBRARY_PATH, 'songs', safe_id, 'cover.jpg'),
                 os.path.join(MUSIC_LIBRARY_PATH, 'artists', f'{safe_id}.jpg')):
        if os.path.isfile(path):
            resp = send_file(path, mimetype='image/jpeg', max_age=604800)  # 7 day cache
            # Auth-gated: shared caches must not store it.
            resp.cache_control.public = False
            resp.cache_control.private = True
            return resp
    return '', 204


# ─── Music Catalog API ──────────────────────────────────────────────────────

def _music_album_list(conn, rows):
    """Album card dicts (with album artists) for rows of id, name, year,
    release_date, album_type, total_tracks, cover_path, available_count, added_at."""
    result = [{
        'id': a['id'], 'name': a['name'], 'year': a['year'], 'release_date': a['release_date'],
        'album_type': a['album_type'], 'total_tracks': a['total_tracks'],
        'cover_path': _resolve_album_cover(conn, a['id'], a['cover_path']),
        'available_count': a['available_count'], 'added_at': a['added_at'],
    } for a in rows]
    artists_map = {}
    ids = [a['id'] for a in result]
    for chunk in _music_chunks(ids):
        a_ph = ','.join('?' for _ in chunk)
        for row in conn.execute(f'''
            SELECT aa.album_id, ar.id as artist_id, ar.name as artist_name
            FROM album_artists aa
            JOIN artists ar ON ar.id = aa.artist_id
            WHERE aa.album_id IN ({a_ph})
        ''', chunk).fetchall():
            artists_map.setdefault(row['album_id'], []).append({'id': row['artist_id'], 'name': row['artist_name']})
    for alb in result:
        alb['artists'] = artists_map.get(alb['id'], [])
    return result


_MUSIC_ALBUM_CARD_SELECT = '''
    SELECT a.id, a.name, a.year, a.release_date, a.album_type, a.total_tracks, a.cover_path,
           COUNT(DISTINCT s.id) as available_count, MAX(s.created_at) as added_at
    FROM albums a
    JOIN songs s ON s.album_id = a.id
'''


def _music_genre_tiles(conn, limit=None):
    """Genres of available songs, most songs first, each with a cover."""
    rows = conn.execute(f'''
        SELECT g.genre, COUNT(DISTINCT g.song_id) as song_count, COUNT(DISTINCT s.album_id) as album_count
        FROM song_genres g
        JOIN songs s ON s.id = g.song_id
        WHERE g.song_id IN {_MUSIC_AVAILABLE_SUBQUERY}
        GROUP BY g.genre
        ORDER BY song_count DESC, g.genre
    ''').fetchall()
    if limit:
        rows = rows[:limit]
    covers = {}
    for row in conn.execute(f'''
        SELECT g.genre, s.album_id, a.cover_path
        FROM song_genres g
        JOIN songs s ON s.id = g.song_id
        LEFT JOIN albums a ON a.id = s.album_id
        WHERE g.song_id IN {_MUSIC_AVAILABLE_SUBQUERY}
        ORDER BY a.release_date DESC
    ''').fetchall():
        if row['genre'] not in covers and row['album_id']:
            cover = _resolve_album_cover(conn, row['album_id'], row['cover_path'])
            if cover:
                covers[row['genre']] = cover
    return [{'name': r['genre'], 'song_count': r['song_count'], 'album_count': r['album_count'],
             'cover_path': covers.get(r['genre'])} for r in rows]


@app.route('/music/api/home')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_home():
    """Home page data: recently added and new albums, genres, top artists."""
    if not _AVAILABLE_SONG_IDS or not _music_library_available():
        return jsonify({'recently_added': [], 'new_releases': [], 'genres': [], 'top_artists': []})
    conn = _get_music_db(with_available=True)
    try:
        HOME_SHELF = 12
        recently_added = conn.execute(f'''{_MUSIC_ALBUM_CARD_SELECT}
            WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY a.id
            ORDER BY added_at DESC, a.name
            LIMIT ?
        ''', [HOME_SHELF]).fetchall()
        new_releases = conn.execute(f'''{_MUSIC_ALBUM_CARD_SELECT}
            WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY a.id
            ORDER BY a.release_date DESC, a.name
            LIMIT ?
        ''', [HOME_SHELF]).fetchall()
        # Top artists by available song count
        top_artists = conn.execute(f'''
            SELECT ar.id, ar.name, COUNT(DISTINCT sa.song_id) as song_count,
                   (SELECT a2.cover_path FROM albums a2
                    JOIN songs s2 ON s2.album_id = a2.id
                    JOIN song_artists sa2 ON sa2.song_id = s2.id AND sa2.artist_id = ar.id
                    WHERE a2.cover_path IS NOT NULL AND a2.cover_path != ''
                    LIMIT 1) as cover_path
            FROM artists ar
            JOIN song_artists sa ON sa.artist_id = ar.id AND sa.role = 'primary'
            WHERE sa.song_id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY ar.id
            HAVING song_count > 0
            ORDER BY song_count DESC, ar.name
            LIMIT 20
        ''').fetchall()
        artist_list = [{'id': a['id'], 'name': a['name'], 'song_count': a['song_count'],
                         'cover_path': _resolve_artist_cover(conn, a['id'], a['cover_path'])} for a in top_artists]
        return jsonify({
            'recently_added': _music_album_list(conn, recently_added),
            'new_releases': _music_album_list(conn, new_releases),
            'genres': _music_genre_tiles(conn, HOME_SHELF),
            'top_artists': artist_list,
        })
    finally:
        conn.close()


@app.route('/music/api/albums')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_albums():
    """All albums with available songs, newest release first."""
    artist_id = request.args.get('artist_id')
    if not _AVAILABLE_SONG_IDS or not _music_library_available():
        return jsonify([])
    conn = _get_music_db(with_available=True)
    try:
        if artist_id:
            albums = conn.execute(f'''{_MUSIC_ALBUM_CARD_SELECT}
                JOIN song_artists sa ON sa.song_id = s.id AND sa.artist_id = ?
                WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
                GROUP BY a.id
                ORDER BY a.release_date DESC, a.name
            ''', [artist_id]).fetchall()
        else:
            albums = conn.execute(f'''{_MUSIC_ALBUM_CARD_SELECT}
                WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
                GROUP BY a.id
                ORDER BY a.release_date DESC, a.name
            ''').fetchall()
        return jsonify(_music_album_list(conn, albums))
    finally:
        conn.close()


@app.route('/music/api/genres')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_genres():
    """All genres of available songs."""
    if not _AVAILABLE_SONG_IDS or not _music_library_available():
        return jsonify([])
    conn = _get_music_db(with_available=True)
    try:
        return jsonify(_music_genre_tiles(conn))
    finally:
        conn.close()


@app.route('/music/api/genre')
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_genre():
    """One genre (?name=, may contain '/'): its songs, albums and artists."""
    name = (request.args.get('name') or '').strip()
    if not name or not _AVAILABLE_SONG_IDS or not _music_library_available():
        return jsonify({'error': 'GENRE NOT FOUND'}), 404
    GENRE_SONGS_CAP, GENRE_ALBUMS_CAP, GENRE_ARTISTS_CAP = 200, 200, 50
    conn = _get_music_db(with_available=True)
    try:
        song_rows = conn.execute(f'''
            SELECT s.id FROM song_genres g
            JOIN songs s ON s.id = g.song_id
            LEFT JOIN albums a ON a.id = s.album_id
            WHERE g.genre = ? AND g.song_id IN {_MUSIC_AVAILABLE_SUBQUERY}
            ORDER BY a.release_date DESC, s.disc_number, s.track_number
        ''', [name]).fetchall()
        if not song_rows:
            return jsonify({'error': 'GENRE NOT FOUND'}), 404
        song_ids = [r['id'] for r in song_rows]
        albums = conn.execute(f'''{_MUSIC_ALBUM_CARD_SELECT}
            JOIN song_genres g ON g.song_id = s.id AND g.genre = ?
            WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY a.id
            ORDER BY a.release_date DESC, a.name
            LIMIT ?
        ''', [name, GENRE_ALBUMS_CAP]).fetchall()
        artists = conn.execute(f'''
            SELECT ar.id, ar.name, COUNT(DISTINCT sa.song_id) as song_count
            FROM song_genres g
            JOIN song_artists sa ON sa.song_id = g.song_id AND sa.role = 'primary'
            JOIN artists ar ON ar.id = sa.artist_id
            WHERE g.genre = ? AND g.song_id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY ar.id
            ORDER BY song_count DESC, ar.name
            LIMIT ?
        ''', [name, GENRE_ARTISTS_CAP]).fetchall()
        return jsonify({
            'genre': {'name': name, 'song_count': len(song_ids), 'album_count': len(albums)},
            'songs': _enrich_songs_from_library(song_ids[:GENRE_SONGS_CAP]),
            'albums': _music_album_list(conn, albums),
            'artists': [{'id': a['id'], 'name': a['name'], 'song_count': a['song_count'],
                         'cover_path': _resolve_artist_cover(conn, a['id'], None)} for a in artists],
        })
    finally:
        conn.close()


@app.route('/music/api/album/<album_id>')
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_album(album_id):
    """Album detail with track list."""
    if not _music_library_available():
        return jsonify({'error': 'ALBUM NOT FOUND'}), 404
    conn = _get_music_db()
    try:
        album = conn.execute('''
            SELECT a.id, a.name, a.year, a.release_date, a.album_type,
                   a.total_tracks, a.cover_path, a.label
            FROM albums a WHERE a.id = ?
        ''', [album_id]).fetchone()
        if not album:
            return jsonify({'error': 'ALBUM NOT FOUND'}), 404
        album_data = {
            'id': album['id'], 'name': album['name'], 'year': album['year'],
            'release_date': album['release_date'], 'album_type': album['album_type'],
            'total_tracks': album['total_tracks'], 'label': album['label'],
            'cover_path': _resolve_album_cover(conn, album['id'], album['cover_path']),
        }
        album_data['genres'] = [r['genre'] for r in conn.execute('''
            SELECT g.genre FROM song_genres g JOIN songs s ON s.id = g.song_id
            WHERE s.album_id = ? GROUP BY g.genre ORDER BY COUNT(*) DESC, g.genre
        ''', [album_id]).fetchall()]
        # Album artists
        album_artists = conn.execute('''
            SELECT ar.id, ar.name FROM album_artists aa
            JOIN artists ar ON ar.id = aa.artist_id
            WHERE aa.album_id = ?
        ''', [album_id]).fetchall()
        album_data['artists'] = [{'id': a['id'], 'name': a['name']} for a in album_artists]
        # Tracks
        tracks = conn.execute('''
            SELECT s.id, s.title, s.duration_ms, s.track_number, s.disc_number
            FROM songs s WHERE s.album_id = ?
            ORDER BY s.disc_number, s.track_number
        ''', [album_id]).fetchall()
        track_ids = [t['id'] for t in tracks]
        # Get artists for all tracks
        song_artists = {}
        if track_ids:
            t_ph = ','.join('?' for _ in track_ids)
            artist_rows = conn.execute(f'''
                SELECT sa.song_id, ar.id as artist_id, ar.name as artist_name, sa.role
                FROM song_artists sa
                JOIN artists ar ON ar.id = sa.artist_id
                WHERE sa.song_id IN ({t_ph})
            ''', track_ids).fetchall()
            for row in artist_rows:
                sid = row['song_id']
                if sid not in song_artists:
                    song_artists[sid] = []
                song_artists[sid].append({
                    'id': row['artist_id'], 'name': row['artist_name'], 'role': row['role']
                })
        track_list = []
        total_duration = 0
        resolved_album_cover = album_data['cover_path']
        for t in tracks:
            available = t['id'] in _AVAILABLE_SONG_IDS
            artists = song_artists.get(t['id'], [])
            primary = [a for a in artists if a['role'] == 'primary']
            featured = [a for a in artists if a['role'] == 'featured']
            dur = t['duration_ms'] or 0
            if available:
                total_duration += dur
            # Use album cover for all tracks; fall back to per-song cover
            track_cover = resolved_album_cover or _resolve_cover_path(None, t['id'])
            track_list.append({
                'id': t['id'], 'title': t['title'], 'duration_ms': dur,
                'track_number': t['track_number'], 'disc_number': t['disc_number'],
                'cover_path': track_cover,
                'artists': primary, 'featured_artists': featured,
                'available': available,
            })
        album_data['total_duration_ms'] = total_duration
        return jsonify({'album': album_data, 'tracks': track_list})
    finally:
        conn.close()


@app.route('/music/api/artists')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_artists():
    """All artists with available songs."""
    if not _AVAILABLE_SONG_IDS or not _music_library_available():
        return jsonify([])
    conn = _get_music_db(with_available=True)
    try:
        artists = conn.execute(f'''
            SELECT ar.id, ar.name, COUNT(DISTINCT sa.song_id) as song_count,
                   (SELECT a2.cover_path FROM albums a2
                    JOIN songs s2 ON s2.album_id = a2.id
                    JOIN song_artists sa2 ON sa2.song_id = s2.id AND sa2.artist_id = ar.id
                    WHERE a2.cover_path IS NOT NULL AND a2.cover_path != ''
                    LIMIT 1) as cover_path
            FROM artists ar
            JOIN song_artists sa ON sa.artist_id = ar.id AND sa.role = 'primary'
            WHERE sa.song_id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY ar.id
            HAVING song_count > 0
            ORDER BY song_count DESC, ar.name
        ''').fetchall()
        return jsonify([{
            'id': a['id'], 'name': a['name'],
            'song_count': a['song_count'],
            'cover_path': _resolve_artist_cover(conn, a['id'], a['cover_path'])
        } for a in artists])
    finally:
        conn.close()


@app.route('/music/api/artist/<artist_id>')
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_artist(artist_id):
    """Artist detail with albums, top songs, and featuring albums."""
    if not _music_library_available():
        return jsonify({'error': 'ARTIST NOT FOUND'}), 404
    conn = _get_music_db(with_available=True)
    try:
        artist = conn.execute('SELECT id, name FROM artists WHERE id = ?', [artist_id]).fetchone()
        if not artist:
            return jsonify({'error': 'ARTIST NOT FOUND'}), 404
        # Artist's available songs (include the role this artist plays on each song)
        songs = conn.execute(f'''
            SELECT s.id, s.title, s.duration_ms, s.track_number, s.album_id,
                   a.name as album_name, a.cover_path, sa.role as artist_role
            FROM songs s
            JOIN song_artists sa ON sa.song_id = s.id AND sa.artist_id = ?
            LEFT JOIN albums a ON a.id = s.album_id
            WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
            ORDER BY a.year DESC, s.track_number
        ''', [artist_id]).fetchall()
        # Get all artists for these songs
        song_ids = [s['id'] for s in songs]
        song_artists_map = {}
        if song_ids:
            s_ph = ','.join('?' for _ in song_ids)
            artist_rows = conn.execute(f'''
                SELECT sa.song_id, ar.id as artist_id, ar.name as artist_name, sa.role
                FROM song_artists sa JOIN artists ar ON ar.id = sa.artist_id
                WHERE sa.song_id IN ({s_ph})
            ''', song_ids).fetchall()
            for row in artist_rows:
                sid = row['song_id']
                if sid not in song_artists_map:
                    song_artists_map[sid] = []
                song_artists_map[sid].append({
                    'id': row['artist_id'], 'name': row['artist_name'], 'role': row['role']
                })
        song_list = []
        for s in songs:
            artists_all = song_artists_map.get(s['id'], [])
            primary = [a for a in artists_all if a['role'] == 'primary']
            featured = [a for a in artists_all if a['role'] == 'featured']
            song_list.append({
                'id': s['id'], 'title': s['title'], 'duration_ms': s['duration_ms'],
                'track_number': s['track_number'], 'album_id': s['album_id'],
                'album_name': s['album_name'],
                'cover_path': _resolve_cover_path(s['cover_path'], s['id']),
                'artists': primary, 'featured_artists': featured, 'available': True,
                'artist_role': s['artist_role'],
            })
        # All albums where this artist has available songs
        all_albums = conn.execute(f'''
            SELECT DISTINCT a.id, a.name, a.year, a.album_type, a.cover_path,
                   COUNT(DISTINCT s.id) as available_count
            FROM albums a
            JOIN songs s ON s.album_id = a.id
            JOIN song_artists sa ON sa.song_id = s.id AND sa.artist_id = ?
            WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY a.id
            ORDER BY a.year DESC
        ''', [artist_id]).fetchall()
        all_album_ids = [a['id'] for a in all_albums]
        # Determine which albums this artist is a primary album artist on (discography)
        own_album_ids = set()
        if all_album_ids:
            aa_ph = ','.join('?' for _ in all_album_ids)
            own_rows = conn.execute(f'''
                SELECT album_id FROM album_artists
                WHERE artist_id = ? AND album_id IN ({aa_ph})
            ''', [artist_id] + all_album_ids).fetchall()
            own_album_ids = {r['album_id'] for r in own_rows}
        # Get album artists for featuring albums (to show who the album belongs to)
        featuring_album_ids = [a['id'] for a in all_albums if a['id'] not in own_album_ids]
        featuring_artists_map = {}
        if featuring_album_ids:
            fa_ph = ','.join('?' for _ in featuring_album_ids)
            fa_rows = conn.execute(f'''
                SELECT aa.album_id, ar.id as artist_id, ar.name as artist_name
                FROM album_artists aa JOIN artists ar ON ar.id = aa.artist_id
                WHERE aa.album_id IN ({fa_ph})
            ''', featuring_album_ids).fetchall()
            for row in fa_rows:
                aid = row['album_id']
                if aid not in featuring_artists_map:
                    featuring_artists_map[aid] = []
                featuring_artists_map[aid].append({'id': row['artist_id'], 'name': row['artist_name']})
        # Split into discography (own) and featuring albums
        album_list = []
        featuring_list = []
        for a in all_albums:
            album_data = {
                'id': a['id'], 'name': a['name'], 'year': a['year'],
                'album_type': a['album_type'],
                'cover_path': _resolve_album_cover(conn, a['id'], a['cover_path']),
                'available_count': a['available_count'],
            }
            if a['id'] in own_album_ids:
                album_list.append(album_data)
            else:
                album_data['artists'] = featuring_artists_map.get(a['id'], [])
                featuring_list.append(album_data)
        artist_cover = _resolve_artist_cover(conn, artist['id'], None)
        return jsonify({
            'artist': {'id': artist['id'], 'name': artist['name'], 'song_count': len(song_list),
                        'cover_path': artist_cover, 'album_count': len(album_list)},
            'songs': song_list,
            'albums': album_list,
            'featuring_albums': featuring_list,
        })
    finally:
        conn.close()


@app.route('/music/api/search')
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_search():
    """Fuzzy search across songs, albums, and artists.
    Supports formats: 'don toliver - fw', 'fwu', 'ver fw', etc.
    All tokens must appear somewhere in the combined title + artist + album text."""
    query = request.args.get('q', '').strip()
    if not query or len(query) < 1:
        return jsonify({'songs': [], 'albums': [], 'artists': []})
    tokens = _music_search_tokenize(query)
    if not tokens:
        return jsonify({'songs': [], 'albums': [], 'artists': []})
    if not _AVAILABLE_SONG_IDS or not _music_library_available():
        return jsonify({'songs': [], 'albums': [], 'artists': []})
    conn = _get_music_db(with_available=True)
    try:
        # Search songs: get all available songs with their artists
        all_songs = conn.execute(f'''
            SELECT s.id, s.title, s.duration_ms, s.track_number, s.album_id,
                   a.name as album_name, a.cover_path
            FROM songs s
            LEFT JOIN albums a ON a.id = s.album_id
            WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
        ''').fetchall()
        # Get all artists for available songs
        all_song_artists = conn.execute(f'''
            SELECT sa.song_id, ar.name as artist_name, ar.id as artist_id, sa.role
            FROM song_artists sa
            JOIN artists ar ON ar.id = sa.artist_id
            WHERE sa.song_id IN {_MUSIC_AVAILABLE_SUBQUERY}
        ''').fetchall()
        # Build artist name map per song
        song_artist_names = {}
        song_artist_objs = {}
        for row in all_song_artists:
            sid = row['song_id']
            if sid not in song_artist_names:
                song_artist_names[sid] = []
                song_artist_objs[sid] = []
            song_artist_names[sid].append(row['artist_name'])
            song_artist_objs[sid].append({
                'id': row['artist_id'], 'name': row['artist_name'], 'role': row['role']
            })
        # Score and filter songs; covers (a stat per song) only for the kept 30.
        scored_songs = []
        for s in all_songs:
            artist_str = ' '.join(song_artist_names.get(s['id'], []))
            album_str = s['album_name'] or ''
            score = _music_search_score(tokens, s['title'] or '', artist_str, album_str)
            if score > 0:
                scored_songs.append((score, s))
        scored_songs.sort(key=lambda x: x[0], reverse=True)
        song_results = []
        for _score, s in scored_songs[:30]:
            all_artists = song_artist_objs.get(s['id'], [])
            primary = [a for a in all_artists if a['role'] == 'primary']
            featured = [a for a in all_artists if a['role'] == 'featured']
            song_results.append({
                'id': s['id'], 'title': s['title'], 'duration_ms': s['duration_ms'],
                'track_number': s['track_number'], 'album_id': s['album_id'],
                'album_name': s['album_name'],
                'cover_path': _resolve_cover_path(s['cover_path'], s['id']),
                'artists': primary, 'featured_artists': featured, 'available': True,
            })
        # Search albums
        all_albums = conn.execute(f'''
            SELECT DISTINCT a.id, a.name, a.year, a.album_type, a.cover_path,
                   COUNT(DISTINCT s.id) as available_count
            FROM albums a
            JOIN songs s ON s.album_id = a.id
            WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY a.id
        ''').fetchall()
        # Get album artists for matching
        album_ids_all = [a['id'] for a in all_albums]
        album_artist_map = {}
        if album_ids_all:
            a_ph = ','.join('?' for _ in album_ids_all)
            aa_rows = conn.execute(f'''
                SELECT aa.album_id, ar.name FROM album_artists aa
                JOIN artists ar ON ar.id = aa.artist_id
                WHERE aa.album_id IN ({a_ph})
            ''', album_ids_all).fetchall()
            for row in aa_rows:
                aid = row['album_id']
                if aid not in album_artist_map:
                    album_artist_map[aid] = []
                album_artist_map[aid].append(row['name'])
        matched_albums = []
        for a in all_albums:
            artist_str = ' '.join(album_artist_map.get(a['id'], []))
            if all(t in f"{a['name']} {artist_str}".lower() for t in tokens):
                matched_albums.append(a)
        album_results = [{
            'id': a['id'], 'name': a['name'], 'year': a['year'],
            'album_type': a['album_type'],
            'cover_path': _resolve_album_cover(conn, a['id'], a['cover_path']),
            'available_count': a['available_count'],
            'artists': [{'name': n} for n in album_artist_map.get(a['id'], [])],
        } for a in matched_albums[:10]]
        # Search artists
        all_artists = conn.execute(f'''
            SELECT ar.id, ar.name, COUNT(DISTINCT sa.song_id) as song_count,
                   (SELECT a2.cover_path FROM albums a2
                    JOIN songs s2 ON s2.album_id = a2.id
                    JOIN song_artists sa2 ON sa2.song_id = s2.id AND sa2.artist_id = ar.id
                    WHERE a2.cover_path IS NOT NULL AND a2.cover_path != ''
                    LIMIT 1) as cover_path
            FROM artists ar
            JOIN song_artists sa ON sa.artist_id = ar.id AND sa.role = 'primary'
            WHERE sa.song_id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY ar.id
            HAVING song_count > 0
        ''').fetchall()
        matched_artists = [ar for ar in all_artists if _music_fuzzy_match(tokens, ar['name'])]
        artist_results = [{
            'id': ar['id'], 'name': ar['name'],
            'song_count': ar['song_count'],
            'cover_path': _resolve_artist_cover(conn, ar['id'], ar['cover_path']),
        } for ar in matched_artists[:10]]
        return jsonify({
            'songs': song_results,
            'albums': album_results,
            'artists': artist_results,
        })
    finally:
        conn.close()


# ─── Music Random Songs API ─────────────────────────────────────────────────

@app.route('/music/api/random')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_random():
    """Return random available songs for auto-queue.
    Query params: count (default 20), exclude (comma-separated song IDs to skip)."""
    import random as _random
    # AUDIT FIX L9: tolerate non-numeric input instead of raising 500.
    try:
        count = int(request.args.get('count', 20))
    except (TypeError, ValueError):
        count = 20
    count = max(1, min(count, 50))
    exclude_raw = request.args.get('exclude', '')
    exclude_set = set(exclude_raw.split(',')) if exclude_raw else set()
    # Filter available songs minus excluded
    candidates = [sid for sid in _AVAILABLE_SONG_IDS if sid not in exclude_set]
    if not candidates:
        # If all excluded, allow repeats from the full set
        candidates = list(_AVAILABLE_SONG_IDS)
    selected = _random.sample(candidates, min(count, len(candidates)))
    songs = _enrich_songs_from_library(selected)
    # Shuffle the result (enrich preserves input order)
    _random.shuffle(songs)
    return jsonify({'songs': songs})


# ─── Music Suggested Songs API (Collaboration-Graph) ────────────────────────

@app.route('/music/api/suggest')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_suggest():
    """Return suggested songs based on artist collaboration graph.
    Query params:
      count         - number of songs to return (default 20, max 50)
      seed_artists  - comma-separated artist IDs from the current playlist
      exclude       - comma-separated song IDs already in queue
    Algorithm:
      1. Find artists who collaborate with seed artists (shared songs)
      2. Score by collaboration strength (primary=2pts, featured=1pt per shared song)
      3. Also boost artists who share albums with seed artists
      4. Pick songs from top related artists weighted by score
      5. Mix in ~20% deeper cuts from the seed artists themselves
      6. Fall back to random if not enough results
    """
    import random as _random
    # AUDIT FIX L9: tolerate non-numeric input instead of raising 500.
    try:
        count = int(request.args.get('count', 20))
    except (TypeError, ValueError):
        count = 20
    count = max(1, min(count, 50))
    seed_raw = request.args.get('seed_artists', '')
    seed_artists = [a.strip() for a in seed_raw.split(',') if a.strip()] if seed_raw else []
    exclude_raw = request.args.get('exclude', '')
    exclude_set = set(e.strip() for e in exclude_raw.split(',') if e.strip()) if exclude_raw else set()

    # If no seed artists provided, fall back to random
    if not seed_artists or not _music_library_available():
        candidates = [sid for sid in _AVAILABLE_SONG_IDS if sid not in exclude_set]
        if not candidates:
            candidates = list(_AVAILABLE_SONG_IDS)
        selected = _random.sample(candidates, min(count, len(candidates)))
        songs = _enrich_songs_from_library(selected)
        _random.shuffle(songs)
        return jsonify({'songs': songs})

    seed_artists = list(dict.fromkeys(seed_artists))
    seed_set = set(seed_artists)
    conn = _get_music_db()
    try:
        # Get all songs by seed artists. Every IN (...) below is chunked: seed
        # artists come from the client's whole queue and their songs are unbounded.
        seed_song_ids = {}
        for chunk in _music_chunks(seed_artists):
            seed_ph = ','.join('?' for _ in chunk)
            for r in conn.execute(f'''
                SELECT DISTINCT song_id FROM song_artists
                WHERE artist_id IN ({seed_ph})
            ''', chunk).fetchall():
                seed_song_ids[r['song_id']] = True
        seed_song_ids = list(seed_song_ids)

        if not seed_song_ids:
            # Seed artists have no songs -- fall back to random
            candidates = [sid for sid in _AVAILABLE_SONG_IDS if sid not in exclude_set]
            if not candidates:
                candidates = list(_AVAILABLE_SONG_IDS)
            selected = _random.sample(candidates, min(count, len(candidates)))
            songs = _enrich_songs_from_library(selected)
            _random.shuffle(songs)
            return jsonify({'songs': songs})

        # Find co-collaborators: other artists on the same songs as seed artists
        # Score: primary role = 2 points, featured/other = 1 point per shared song
        # (per-song sums add up across song chunks).
        artist_scores = {}
        for chunk in _music_chunks(seed_song_ids):
            song_ph = ','.join('?' for _ in chunk)
            for row in conn.execute(f'''
                SELECT sa.artist_id,
                       SUM(CASE WHEN sa.role = 'primary' THEN 2 ELSE 1 END) as score
                FROM song_artists sa
                WHERE sa.song_id IN ({song_ph})
                GROUP BY sa.artist_id
            ''', chunk).fetchall():
                aid = row['artist_id']
                if aid not in seed_set:
                    artist_scores[aid] = artist_scores.get(aid, 0) + row['score']

        # Also find artists on the same albums (weaker signal)
        for chunk in _music_chunks(seed_artists):
            seed_ph = ','.join('?' for _ in chunk)
            for row in conn.execute(f'''
                SELECT DISTINCT aa2.artist_id
                FROM song_artists sa
                JOIN songs s ON s.id = sa.song_id
                JOIN album_artists aa ON aa.album_id = s.album_id
                JOIN album_artists aa2 ON aa2.album_id = aa.album_id
                WHERE sa.artist_id IN ({seed_ph})
            ''', chunk).fetchall():
                aid = row['artist_id']
                if aid not in seed_set and aid not in artist_scores:
                    artist_scores[aid] = 0.5

        # Top 30 related artists by score
        related_sorted = sorted(artist_scores.items(), key=lambda x: x[1], reverse=True)
        top_related_ids = [a[0] for a in related_sorted[:30]]

        # Gather songs from related artists and score them
        suggested_ids = []
        if top_related_ids:
            rel_ph = ','.join('?' for _ in top_related_ids)
            rel_song_rows = conn.execute(f'''
                SELECT DISTINCT sa.song_id, sa.artist_id
                FROM song_artists sa
                WHERE sa.artist_id IN ({rel_ph})
                  AND sa.role IN ('primary', 'featured')
            ''', top_related_ids).fetchall()

            song_scores = {}
            for row in rel_song_rows:
                sid = row['song_id']
                if sid in exclude_set or sid not in _AVAILABLE_SONG_IDS:
                    continue
                if sid not in song_scores:
                    song_scores[sid] = 0
                song_scores[sid] += artist_scores.get(row['artist_id'], 0)

            scored = sorted(song_scores.items(), key=lambda x: x[1], reverse=True)
            suggested_ids = [s[0] for s in scored]

        # Mix: ~80% related, ~20% seed artist deeper cuts
        seed_cuts = [sid for sid in seed_song_ids
                     if sid not in exclude_set and sid in _AVAILABLE_SONG_IDS]
        _random.shuffle(seed_cuts)
        seed_count = max(1, count // 5)
        related_count = count - seed_count

        final_ids = []
        for sid in suggested_ids:
            if len(final_ids) >= related_count:
                break
            if sid not in final_ids:
                final_ids.append(sid)

        for sid in seed_cuts:
            if len(final_ids) >= count:
                break
            if sid not in final_ids:
                final_ids.append(sid)

        # Pad with random if still short
        if len(final_ids) < count:
            padding = [sid for sid in _AVAILABLE_SONG_IDS
                       if sid not in exclude_set and sid not in set(final_ids)]
            _random.shuffle(padding)
            final_ids.extend(padding[:count - len(final_ids)])

        _random.shuffle(final_ids)
        songs = _enrich_songs_from_library(final_ids)
        print(f'[MUSIC] Suggested {len(songs)} songs for seed artists {seed_artists[:5]} '
              f'(related artists found: {len(artist_scores)})')
        return jsonify({'songs': songs})

    finally:
        conn.close()


# ─── Music Likes API ────────────────────────────────────────────────────────

