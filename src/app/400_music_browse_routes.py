@app.route('/music')
@limiter.limit(music_api_rate_limit)
@login_required
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
    """Stream audio.opus for a song with Range request support."""
    from flask import Response
    import re as _re
    from werkzeug.utils import secure_filename as _sf_music
    # Sanitize song_id to prevent path traversal, then verify it exists in the
    # known-good set (which was populated by scanning the actual filesystem).
    safe_song_id = _sf_music(song_id)
    if not safe_song_id or safe_song_id not in _AVAILABLE_SONG_IDS:
        return jsonify({'error': 'SONG NOT FOUND'}), 404
    song_id = safe_song_id
    audio_path = os.path.join(MUSIC_LIBRARY_PATH, 'songs', song_id, 'audio.opus')
    if not os.path.isfile(audio_path):
        return jsonify({'error': 'AUDIO FILE NOT FOUND'}), 404
    file_size = os.path.getsize(audio_path)
    range_header = request.headers.get('Range')
    if range_header:
        m = _re.search(r'bytes=(\d*)-(\d*)', range_header)
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else file_size - 1
            else:
                # Suffix form "bytes=-N": the last N bytes (N=0 is unsatisfiable).
                start = max(file_size - int(m.group(2)), 0) if int(m.group(2)) else file_size
                end = file_size - 1
            end = min(end, file_size - 1)
            # AUDIT FIX L9: per RFC 9110, an unsatisfiable range must return
            # 416 with a Content-Range header indicating the resource size.
            if start >= file_size or start > end:
                from flask import Response
                resp = Response(status=416, mimetype='audio/ogg')
                resp.headers['Content-Range'] = f'bytes */{file_size}'
                return resp
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
            resp = Response(generate(), status=206, mimetype='audio/ogg',
                            content_type='audio/ogg')
            resp.headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
            resp.headers['Content-Length'] = str(length)
            resp.headers['Accept-Ranges'] = 'bytes'
            resp.headers['Cache-Control'] = 'public, max-age=86400'
            return resp
    # No range -- send full file
    def generate_full():
        with open(audio_path, 'rb') as f:
            while True:
                data = f.read(65536)
                if not data:
                    break
                yield data
    resp = Response(generate_full(), mimetype='audio/ogg', content_type='audio/ogg')
    resp.headers['Content-Length'] = str(file_size)
    resp.headers['Accept-Ranges'] = 'bytes'
    resp.headers['Cache-Control'] = 'public, max-age=86400'
    return resp


@app.route('/music/cover/<cover_id>')
@limiter.limit(music_cover_rate_limit)
@_music_required
def music_cover(cover_id):
    """Serve album or per-song cover JPEG.
    Checks album covers first, then falls back to per-song cover.jpg."""
    from werkzeug.utils import secure_filename as _sf
    safe_id = _sf(cover_id)
    # Try album cover first
    cover_path = os.path.join(MUSIC_LIBRARY_PATH, 'covers', f'{safe_id}.jpg')
    if os.path.isfile(cover_path):
        return send_file(cover_path, mimetype='image/jpeg',
                         max_age=604800)  # 7 day cache
    # Fallback: per-song cover (songs/<id>/cover.jpg)
    song_cover_path = os.path.join(MUSIC_LIBRARY_PATH, 'songs', safe_id, 'cover.jpg')
    if os.path.isfile(song_cover_path):
        return send_file(song_cover_path, mimetype='image/jpeg',
                         max_age=604800)  # 7 day cache
    # Fallback: artist profile image (artists/<id>.jpg)
    artist_path = os.path.join(MUSIC_LIBRARY_PATH, 'artists', f'{safe_id}.jpg')
    if os.path.isfile(artist_path):
        return send_file(artist_path, mimetype='image/jpeg',
                         max_age=604800)  # 7 day cache
    return '', 204


# ─── Music Catalog API ──────────────────────────────────────────────────────

@app.route('/music/api/home')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_home():
    """Home page data: recently added albums, top artists, featured albums."""
    if not _AVAILABLE_SONG_IDS:
        return jsonify({'recently_added': [], 'top_artists': [], 'all_albums': []})
    conn = _get_music_db(with_available=True)
    try:
        # Get albums that have available songs.
        # Capped to avoid unbounded payloads on very large libraries — the dedicated
        # /music/api/albums endpoint is the canonical source for full listings.
        HOME_ALBUMS_CAP = 500
        albums = conn.execute(f'''
            SELECT DISTINCT a.id, a.name, a.year, a.release_date, a.album_type,
                   a.total_tracks, a.cover_path,
                   COUNT(DISTINCT s.id) as available_count
            FROM albums a
            JOIN songs s ON s.album_id = a.id
            WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
            GROUP BY a.id
            ORDER BY a.release_date DESC, a.name
            LIMIT ?
        ''', [HOME_ALBUMS_CAP]).fetchall()
        album_list = []
        album_ids = []
        for a in albums:
            album_ids.append(a['id'])
            album_list.append({
                'id': a['id'], 'name': a['name'], 'year': a['year'],
                'album_type': a['album_type'], 'total_tracks': a['total_tracks'],
                'cover_path': _resolve_album_cover(conn, a['id'], a['cover_path']),
                'available_count': a['available_count'],
            })
        # Get album artists
        if album_ids:
            a_ph = ','.join('?' for _ in album_ids)
            album_artist_rows = conn.execute(f'''
                SELECT aa.album_id, ar.id as artist_id, ar.name as artist_name
                FROM album_artists aa
                JOIN artists ar ON ar.id = aa.artist_id
                WHERE aa.album_id IN ({a_ph})
            ''', album_ids).fetchall()
            album_artists_map = {}
            for row in album_artist_rows:
                aid = row['album_id']
                if aid not in album_artists_map:
                    album_artists_map[aid] = []
                album_artists_map[aid].append({'id': row['artist_id'], 'name': row['artist_name']})
            for alb in album_list:
                alb['artists'] = album_artists_map.get(alb['id'], [])
        else:
            for alb in album_list:
                alb['artists'] = []
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
            ORDER BY song_count DESC
            LIMIT 20
        ''').fetchall()
        artist_list = [{'id': a['id'], 'name': a['name'], 'song_count': a['song_count'],
                         'cover_path': _resolve_artist_cover(conn, a['id'], a['cover_path'])} for a in top_artists]
        # Recently added = newest release_date albums (top 10)
        recently_added = album_list[:10]
        return jsonify({
            'recently_added': recently_added,
            'top_artists': artist_list,
            'all_albums': album_list,
        })
    finally:
        conn.close()


@app.route('/music/api/albums')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_albums():
    """All albums with available songs."""
    artist_id = request.args.get('artist_id')
    if not _AVAILABLE_SONG_IDS:
        return jsonify([])
    conn = _get_music_db(with_available=True)
    try:
        if artist_id:
            albums = conn.execute(f'''
                SELECT DISTINCT a.id, a.name, a.year, a.album_type, a.total_tracks, a.cover_path,
                       COUNT(DISTINCT s.id) as available_count
                FROM albums a
                JOIN songs s ON s.album_id = a.id
                JOIN song_artists sa ON sa.song_id = s.id AND sa.artist_id = ?
                WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
                GROUP BY a.id
                ORDER BY a.year DESC, a.name
            ''', [artist_id]).fetchall()
        else:
            albums = conn.execute(f'''
                SELECT DISTINCT a.id, a.name, a.year, a.album_type, a.total_tracks, a.cover_path,
                       COUNT(DISTINCT s.id) as available_count
                FROM albums a
                JOIN songs s ON s.album_id = a.id
                WHERE s.id IN {_MUSIC_AVAILABLE_SUBQUERY}
                GROUP BY a.id
                ORDER BY a.year DESC, a.name
            ''').fetchall()
        result = []
        album_ids = []
        for a in albums:
            album_ids.append(a['id'])
            result.append({
                'id': a['id'], 'name': a['name'], 'year': a['year'],
                'album_type': a['album_type'], 'total_tracks': a['total_tracks'],
                'cover_path': _resolve_album_cover(conn, a['id'], a['cover_path']),
                'available_count': a['available_count'],
            })
        # Get album artists
        if album_ids:
            a_ph = ','.join('?' for _ in album_ids)
            artist_rows = conn.execute(f'''
                SELECT aa.album_id, ar.id as artist_id, ar.name as artist_name
                FROM album_artists aa
                JOIN artists ar ON ar.id = aa.artist_id
                WHERE aa.album_id IN ({a_ph})
            ''', album_ids).fetchall()
            artists_map = {}
            for row in artist_rows:
                aid = row['album_id']
                if aid not in artists_map:
                    artists_map[aid] = []
                artists_map[aid].append({'id': row['artist_id'], 'name': row['artist_name']})
            for alb in result:
                alb['artists'] = artists_map.get(alb['id'], [])
        return jsonify(result)
    finally:
        conn.close()


@app.route('/music/api/album/<album_id>')
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_album(album_id):
    """Album detail with track list."""
    conn = _get_music_db()
    try:
        album = conn.execute('''
            SELECT a.id, a.name, a.year, a.release_date, a.album_type,
                   a.total_tracks, a.cover_path
            FROM albums a WHERE a.id = ?
        ''', [album_id]).fetchone()
        if not album:
            return jsonify({'error': 'ALBUM NOT FOUND'}), 404
        album_data = {
            'id': album['id'], 'name': album['name'], 'year': album['year'],
            'release_date': album['release_date'], 'album_type': album['album_type'],
            'total_tracks': album['total_tracks'],
            'cover_path': _resolve_album_cover(conn, album['id'], album['cover_path']),
        }
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
    if not _AVAILABLE_SONG_IDS:
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
    if not _AVAILABLE_SONG_IDS:
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
        # Score and filter songs
        scored_songs = []
        for s in all_songs:
            artist_str = ' '.join(song_artist_names.get(s['id'], []))
            album_str = s['album_name'] or ''
            score = _music_search_score(tokens, s['title'] or '', artist_str, album_str)
            if score > 0:
                all_artists = song_artist_objs.get(s['id'], [])
                primary = [a for a in all_artists if a['role'] == 'primary']
                featured = [a for a in all_artists if a['role'] == 'featured']
                scored_songs.append((score, {
                    'id': s['id'], 'title': s['title'], 'duration_ms': s['duration_ms'],
                    'track_number': s['track_number'], 'album_id': s['album_id'],
                    'album_name': s['album_name'],
                    'cover_path': _resolve_cover_path(s['cover_path'], s['id']),
                    'artists': primary, 'featured_artists': featured, 'available': True,
                }))
        scored_songs.sort(key=lambda x: x[0], reverse=True)
        song_results = [s[1] for s in scored_songs[:30]]
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
        album_results = []
        for a in all_albums:
            artist_str = ' '.join(album_artist_map.get(a['id'], []))
            combined = f"{a['name']} {artist_str}".lower()
            if all(t in combined for t in tokens):
                album_results.append({
                    'id': a['id'], 'name': a['name'], 'year': a['year'],
                    'album_type': a['album_type'],
                    'cover_path': _resolve_album_cover(conn, a['id'], a['cover_path']),
                    'available_count': a['available_count'],
                    'artists': [{'name': n} for n in album_artist_map.get(a['id'], [])],
                })
        album_results = album_results[:10]
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
        artist_results = []
        for ar in all_artists:
            if _music_fuzzy_match(tokens, ar['name']):
                artist_results.append({
                    'id': ar['id'], 'name': ar['name'],
                    'song_count': ar['song_count'],
                    'cover_path': _resolve_artist_cover(conn, ar['id'], ar['cover_path']),
                })
        artist_results = artist_results[:10]
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
    if not seed_artists:
        candidates = [sid for sid in _AVAILABLE_SONG_IDS if sid not in exclude_set]
        if not candidates:
            candidates = list(_AVAILABLE_SONG_IDS)
        selected = _random.sample(candidates, min(count, len(candidates)))
        songs = _enrich_songs_from_library(selected)
        _random.shuffle(songs)
        return jsonify({'songs': songs})

    conn = _get_music_db()
    try:
        seed_ph = ','.join('?' for _ in seed_artists)

        # Get all songs by seed artists
        seed_song_rows = conn.execute(f'''
            SELECT DISTINCT song_id FROM song_artists
            WHERE artist_id IN ({seed_ph})
        ''', seed_artists).fetchall()
        seed_song_ids = [r['song_id'] for r in seed_song_rows]

        if not seed_song_ids:
            # Seed artists have no songs -- fall back to random
            candidates = [sid for sid in _AVAILABLE_SONG_IDS if sid not in exclude_set]
            if not candidates:
                candidates = list(_AVAILABLE_SONG_IDS)
            selected = _random.sample(candidates, min(count, len(candidates)))
            songs = _enrich_songs_from_library(selected)
            _random.shuffle(songs)
            return jsonify({'songs': songs})

        song_ph = ','.join('?' for _ in seed_song_ids)

        # Find co-collaborators: other artists on the same songs as seed artists
        # Score: primary role = 2 points, featured/other = 1 point per shared song
        collab_rows = conn.execute(f'''
            SELECT sa.artist_id,
                   SUM(CASE WHEN sa.role = 'primary' THEN 2 ELSE 1 END) as score
            FROM song_artists sa
            WHERE sa.song_id IN ({song_ph})
              AND sa.artist_id NOT IN ({seed_ph})
            GROUP BY sa.artist_id
            ORDER BY score DESC
        ''', seed_song_ids + seed_artists).fetchall()

        # Also find artists on the same albums (weaker signal)
        album_collab_rows = conn.execute(f'''
            SELECT DISTINCT aa2.artist_id
            FROM song_artists sa
            JOIN songs s ON s.id = sa.song_id
            JOIN album_artists aa ON aa.album_id = s.album_id
            JOIN album_artists aa2 ON aa2.album_id = aa.album_id
            WHERE sa.artist_id IN ({seed_ph})
              AND aa2.artist_id NOT IN ({seed_ph})
        ''', seed_artists + seed_artists).fetchall()

        # Merge collaboration scores
        artist_scores = {}
        for row in collab_rows:
            artist_scores[row['artist_id']] = row['score']
        for row in album_collab_rows:
            aid = row['artist_id']
            if aid not in artist_scores:
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

