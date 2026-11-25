# library.db: what the site plays. The worker is its only writer; the app opens
# it read-only. Schema v7 keeps every v6 table and column the app reads and adds
# identity (song_isrcs, song_aliases) and inventory (files) tables.

LIB_SCHEMA_VERSION = '7'
LIB_LOCK = threading.Lock()

_LIB_TABLES = '''
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, spotify_id TEXT, spotify_url TEXT,
    image_url TEXT, image_path TEXT);
CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, year TEXT, release_date TEXT, album_type TEXT,
    total_tracks INTEGER, spotify_id TEXT, spotify_url TEXT, cover_url TEXT, cover_path TEXT);
CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, duration_ms INTEGER, year TEXT, release_date TEXT,
    isrc TEXT, spotify_id TEXT, spotify_url TEXT, youtube_url TEXT, album_id TEXT REFERENCES albums(id),
    track_number INTEGER, disc_number INTEGER, album_type TEXT, folder_path TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS song_artists (
    song_id TEXT NOT NULL REFERENCES songs(id), artist_id TEXT NOT NULL REFERENCES artists(id),
    role TEXT NOT NULL, PRIMARY KEY (song_id, artist_id, role));
CREATE TABLE IF NOT EXISTS album_artists (
    album_id TEXT NOT NULL REFERENCES albums(id), artist_id TEXT NOT NULL REFERENCES artists(id),
    PRIMARY KEY (album_id, artist_id));
CREATE TABLE IF NOT EXISTS song_genres (
    song_id TEXT NOT NULL REFERENCES songs(id), genre TEXT NOT NULL, PRIMARY KEY (song_id, genre));
CREATE TABLE IF NOT EXISTS song_isrcs (isrc TEXT PRIMARY KEY, song_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS song_aliases (
    kind TEXT NOT NULL, value TEXT NOT NULL, song_id TEXT NOT NULL, PRIMARY KEY (kind, value));
CREATE TABLE IF NOT EXISTS files (
    song_id TEXT PRIMARY KEY, path TEXT NOT NULL, codec TEXT, bitrate INTEGER, duration_ms INTEGER,
    size INTEGER, sha256 TEXT UNIQUE, source TEXT, source_ref TEXT, fp_ber REAL, worker TEXT,
    created_at TEXT);
'''
# Columns added to v6 tables (ALTER TABLE ADD COLUMN on older libraries).
_LIB_NEW_COLUMNS = {
    'artists': {'deezer_id': 'INTEGER', 'mbid': 'TEXT'},
    'albums': {'deezer_id': 'INTEGER', 'upc': 'TEXT', 'label': 'TEXT'},
    'songs': {'deezer_id': 'INTEGER', 'recording_mbid': 'TEXT', 'version_type': 'TEXT',
              'explicit': 'INTEGER', 'norm_key': 'TEXT', 'confidence': 'REAL', 'lyrics': 'TEXT'},
}
_LIB_INDEXES = '''
CREATE INDEX IF NOT EXISTS idx_song_artists_artist ON song_artists(artist_id);
CREATE INDEX IF NOT EXISTS idx_song_artists_song ON song_artists(song_id);
CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_albums_name ON albums(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(album_id);
CREATE INDEX IF NOT EXISTS idx_songs_isrc ON songs(isrc);
CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_songs_norm ON songs(norm_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_artists_deezer ON artists(deezer_id) WHERE deezer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_albums_deezer ON albums(deezer_id) WHERE deezer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_source_ref ON files(source_ref);
'''


class Duplicate(Exception):
    def __init__(self, song_id):
        super().__init__(song_id)
        self.song_id = song_id


def lib_connect():
    conn = sqlite3.connect(LIB_DB, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=NORMAL')
    return conn


def lib_init():
    """Create or upgrade library.db and the folders beside it."""
    for path in (LIB_DIR, SONGS_DIR, COVERS_DIR, ARTISTS_DIR, TMP_DIR):
        os.makedirs(path, exist_ok=True)
    with LIB_LOCK:
        conn = lib_connect()
        try:
            conn.executescript(_LIB_TABLES)
            for table, columns in _LIB_NEW_COLUMNS.items():
                have = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})')}
                for column, kind in columns.items():
                    if column not in have:
                        conn.execute(f'ALTER TABLE {table} ADD COLUMN {column} {kind}')
            conn.executescript(_LIB_INDEXES)
            conn.execute("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)", [LIB_SCHEMA_VERSION])
            conn.commit()
        finally:
            conn.close()


def meta_get(key, default=None):
    conn = lib_connect()
    try:
        row = conn.execute('SELECT value FROM _meta WHERE key = ?', [key]).fetchone()
        return row['value'] if row else default
    finally:
        conn.close()


def meta_set(key, value):
    with LIB_LOCK:
        conn = lib_connect()
        try:
            conn.execute('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [key, str(value)])
            conn.commit()
        finally:
            conn.close()


def lib_find(isrc=None, deezer_id=None, video_id=None):
    """Song id already held for any of the strong identity keys (plan 6.2, keys 2-4)."""
    conn = lib_connect()
    try:
        if isrc:
            row = conn.execute('SELECT song_id FROM song_isrcs WHERE isrc = ?', [isrc.upper()]).fetchone()
            if row:
                return row['song_id']
        if deezer_id:
            row = conn.execute("SELECT song_id FROM song_aliases WHERE kind = 'dz' AND value = ?",
                               [str(int(deezer_id))]).fetchone()
            if row:
                return row['song_id']
        if video_id:
            row = conn.execute('SELECT song_id FROM files WHERE source_ref = ?', [video_id]).fetchone()
            if row:
                return row['song_id']
        return None
    finally:
        conn.close()


def lib_songs_by_norm(norm_key):
    """[(song_id, duration_ms, audio path)] sharing an identity candidate key."""
    conn = lib_connect()
    try:
        rows = conn.execute('''SELECT s.id, s.duration_ms, f.path FROM songs s JOIN files f ON f.song_id = s.id
                               WHERE s.norm_key = ?''', [norm_key]).fetchall()
        return [(r['id'], r['duration_ms'], os.path.join(LIB_DIR, r['path'])) for r in rows]
    finally:
        conn.close()


def lib_norm_keys(artist_dz):
    """Identity keys of every song held for one artist."""
    conn = lib_connect()
    try:
        prefix = f'{int(artist_dz)}:'
        rows = conn.execute("SELECT norm_key FROM songs WHERE norm_key >= ? AND norm_key < ?",
                            [prefix, prefix + '\uffff']).fetchall()
        return {r['norm_key'] for r in rows}
    finally:
        conn.close()


def lib_add_aliases(song_id, isrc=None, deezer_id=None):
    """Remember another ISRC / Deezer id of a held song, so next time it is a direct hit."""
    with LIB_LOCK:
        conn = lib_connect()
        try:
            if isrc:
                conn.execute('INSERT OR IGNORE INTO song_isrcs (isrc, song_id) VALUES (?, ?)', [isrc.upper(), song_id])
            if deezer_id:
                conn.execute("INSERT OR IGNORE INTO song_aliases (kind, value, song_id) VALUES ('dz', ?, ?)",
                             [str(int(deezer_id)), song_id])
            conn.commit()
        finally:
            conn.close()


def lib_stats():
    conn = lib_connect()
    try:
        row = conn.execute('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files').fetchone()
        return {'songs': row['n'], 'bytes': row['bytes'],
                'artists': conn.execute('SELECT COUNT(*) FROM artists').fetchone()[0],
                'albums': conn.execute('SELECT COUNT(*) FROM albums').fetchone()[0]}
    finally:
        conn.close()


def _new_id(conn, table):
    while True:
        candidate = secrets.token_hex(6)
        if not conn.execute(f'SELECT 1 FROM {table} WHERE id = ?', [candidate]).fetchone():
            return candidate


def _write_file(path, data):
    tmp = f'{path}.part'
    with open(tmp, 'wb') as fp:
        fp.write(data)
    os.replace(tmp, path)


def _ensure_artist(conn, dz_id, name, image):
    row = conn.execute('SELECT id, image_path FROM artists WHERE deezer_id = ?', [int(dz_id)]).fetchone()
    if row:
        artist_id, image_path = row['id'], row['image_path']
    else:
        artist_id, image_path = _new_id(conn, 'artists'), None
        conn.execute('INSERT INTO artists (id, name, deezer_id) VALUES (?, ?, ?)', [artist_id, name, int(dz_id)])
    if image and not image_path:
        _write_file(os.path.join(ARTISTS_DIR, f'{artist_id}.jpg'), image)
        conn.execute('UPDATE artists SET image_path = ? WHERE id = ?', [f'artists/{artist_id}.jpg', artist_id])
    return artist_id


def _ensure_album(conn, album, cover):
    row = conn.execute('SELECT id, cover_path FROM albums WHERE deezer_id = ?', [int(album['id'])]).fetchone()
    if row:
        album_id, cover_path = row['id'], row['cover_path']
    else:
        album_id, cover_path = _new_id(conn, 'albums'), None
        release_date = album.get('release_date') or ''
        kind = album_kind(album.get('record_type'), album.get('title'))
        conn.execute('''INSERT INTO albums (id, name, year, release_date, album_type, total_tracks, cover_url,
                                            deezer_id, upc, label)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                     [album_id, album['title'], release_date[:4], release_date, kind, album.get('nb_tracks'),
                      album.get('cover_xl'), int(album['id']), album.get('upc'), album.get('label')])
    if cover and not cover_path:
        _write_file(os.path.join(COVERS_DIR, f'{album_id}.jpg'), cover)
        conn.execute('UPDATE albums SET cover_path = ? WHERE id = ?', [f'covers/{album_id}.jpg', album_id])
    return album_id


def lib_has_cover(dz_album_id):
    conn = lib_connect()
    try:
        row = conn.execute('SELECT cover_path FROM albums WHERE deezer_id = ?', [int(dz_album_id)]).fetchone()
        return bool(row and row['cover_path'])
    finally:
        conn.close()


def lib_has_artist_image(dz_artist_id):
    conn = lib_connect()
    try:
        row = conn.execute('SELECT image_path FROM artists WHERE deezer_id = ?', [int(dz_artist_id)]).fetchone()
        return bool(row and row['image_path'])
    finally:
        conn.close()


def lib_publish(card, album, audio, extras):
    """Add one verified song in a single transaction; returns its song id.

    card:   Deezer track + 'version', 'norm_key', 'artists' [(dz_id, name, role)]
    album:  Deezer album
    audio:  {'path', 'ext', 'codec', 'bitrate', 'duration_ms', 'size', 'sha256',
             'video_id', 'fp_ber', 'confidence'}
    extras: {'cover': bytes|None, 'artist_images': {dz_id: bytes}, 'lyrics': (synced, plain)|None,
             'genres': [names]}
    The resolver runs again inside the transaction, so two workers finishing
    the same song can never both publish it."""
    with LIB_LOCK:
        conn = lib_connect()
        song_dir = None
        try:
            conn.execute('BEGIN IMMEDIATE')
            existing = conn.execute('SELECT song_id FROM song_isrcs WHERE isrc = ?', [card['isrc']]).fetchone() \
                or conn.execute("SELECT song_id FROM song_aliases WHERE kind = 'dz' AND value = ?",
                                [str(card['id'])]).fetchone() \
                or conn.execute('SELECT song_id FROM files WHERE sha256 = ?', [audio['sha256']]).fetchone()
            if existing:
                raise Duplicate(existing['song_id'])
            artist_ids = []
            for dz_id, name, role in card['artists']:
                artist_ids.append((_ensure_artist(conn, dz_id, name, extras['artist_images'].get(dz_id)), role))
            album_id = _ensure_album(conn, album, extras.get('cover'))
            album_artist_dz = (album.get('artist') or {}).get('id') or card['artists'][0][0]
            album_artist = conn.execute('SELECT id FROM artists WHERE deezer_id = ?', [int(album_artist_dz)]).fetchone()
            if album_artist:
                conn.execute('INSERT OR IGNORE INTO album_artists (album_id, artist_id) VALUES (?, ?)',
                             [album_id, album_artist['id']])
            song_id = _new_id(conn, 'songs')
            song_dir = os.path.join(SONGS_DIR, song_id)
            os.makedirs(song_dir)
            audio_rel = f'songs/{song_id}/audio.{audio["ext"]}'
            shutil.move(audio['path'], os.path.join(LIB_DIR, audio_rel))
            lyrics_kind = None
            if extras.get('lyrics'):
                synced, plain = extras['lyrics']
                lyrics_kind = 'lrc' if synced else 'txt'
                with open(os.path.join(song_dir, f'lyrics.{lyrics_kind}'), 'w', encoding='utf-8') as fp:
                    fp.write(synced or plain)
            release_date = album.get('release_date') or card.get('release_date') or ''
            conn.execute('''INSERT INTO songs (id, title, duration_ms, year, release_date, isrc, youtube_url, album_id,
                                               track_number, disc_number, album_type, folder_path, created_at,
                                               deezer_id, version_type, explicit, norm_key, confidence, lyrics)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                         [song_id, card['title'], card['duration'] * 1000, release_date[:4], release_date,
                          card['isrc'], f'https://music.youtube.com/watch?v={audio["video_id"]}', album_id,
                          card.get('track_position'), card.get('disk_number'),
                          album_kind(album.get('record_type'), album.get('title')),
                          f'songs/{song_id}', now().isoformat(), card['id'], card['version'],
                          int(bool(card.get('explicit_lyrics'))), card['norm_key'], audio['confidence'], lyrics_kind])
            for artist_id, role in artist_ids:
                conn.execute('INSERT OR IGNORE INTO song_artists (song_id, artist_id, role) VALUES (?, ?, ?)',
                             [song_id, artist_id, role])
            for genre in extras.get('genres') or []:
                conn.execute('INSERT OR IGNORE INTO song_genres (song_id, genre) VALUES (?, ?)', [song_id, genre])
            conn.execute('INSERT INTO song_isrcs (isrc, song_id) VALUES (?, ?)', [card['isrc'], song_id])
            conn.execute("INSERT INTO song_aliases (kind, value, song_id) VALUES ('dz', ?, ?)", [str(card['id']), song_id])
            conn.execute('''INSERT INTO files (song_id, path, codec, bitrate, duration_ms, size, sha256, source,
                                               source_ref, fp_ber, worker, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 'youtube', ?, ?, ?, ?)''',
                         [song_id, audio_rel, audio['codec'], audio['bitrate'], audio['duration_ms'], audio['size'],
                          audio['sha256'], audio['video_id'], audio['fp_ber'], WORKER_NAME, now().isoformat()])
            conn.commit()
            return song_id
        except BaseException:
            conn.rollback()
            if song_dir and os.path.isdir(song_dir):
                shutil.rmtree(song_dir, ignore_errors=True)
            raise
        finally:
            conn.close()
