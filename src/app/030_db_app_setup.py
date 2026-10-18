basedir = os.path.abspath(os.path.dirname(__file__))
if not os.path.exists(os.path.join(basedir, 'instance')):
    os.makedirs(os.path.join(basedir, 'instance'))
if not os.path.exists(os.path.join(basedir, 'uploads')):
    os.makedirs(os.path.join(basedir, 'uploads'))
if not os.path.exists(os.path.join(basedir, 'notes')):
    os.makedirs(os.path.join(basedir, 'notes'))
if not os.path.exists(os.path.join(basedir, 'thumbnails')):
    os.makedirs(os.path.join(basedir, 'thumbnails'))

DEFAULT_SQLITE_DB_PATH = os.path.join(basedir, 'instance', 'app.db')
DEFAULT_SQLITE_DATABASE_URI = f'sqlite:///{DEFAULT_SQLITE_DB_PATH}'
ALLOW_SQLITE_APP_DB = os.environ.get('ALLOW_SQLITE_APP_DB', 'false').lower() in ('true', '1', 'yes')
PRIMARY_DATABASE_BACKENDS = {'mysql'}

def get_configured_database_uri():
    configured = os.environ.get('DATABASE_URL')
    if configured:
        return configured
    if ALLOW_SQLITE_APP_DB:
        print('[DB] WARNING: DATABASE_URL is missing; falling back to SQLite because ALLOW_SQLITE_APP_DB is enabled')
        return DEFAULT_SQLITE_DATABASE_URI
    raise RuntimeError(
        'DATABASE_URL IS REQUIRED. MAIN APP DATA MUST USE MARIADB/MYSQL; SQLITE IS RESERVED ONLY FOR THE MUSIC LIBRARY.'
    )

def get_database_url(uri=None):
    try:
        return make_url(uri or app.config['SQLALCHEMY_DATABASE_URI'])
    except Exception:
        return None

def get_database_backend_name(uri=None):
    db_url = get_database_url(uri)
    return db_url.get_backend_name() if db_url else 'unknown'

def redact_database_uri(uri=None):
    db_url = get_database_url(uri)
    if db_url:
        return db_url.render_as_string(hide_password=True)
    # Unparseable: the raw string may still carry credentials.
    return '<unparseable database URI>'

app.config['SQLALCHEMY_DATABASE_URI'] = get_configured_database_uri()
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# AUDIT Tier 1: explicit pool sizing for MariaDB. Defaults (pool_size=5,
# max_overflow=10) can be saturated by Gunicorn (8 threads) + APScheduler
# replication workers (up to 10 in 'unlimited' preset) running in parallel.
# pool_pre_ping detects stale connections; pool_recycle=3600 forestalls
# wait_timeout disconnects on MariaDB.
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'pool_pre_ping': True,
    'pool_size': 10,
    'max_overflow': 20,
    'pool_timeout': 30,
}
if get_database_backend_name() == 'mysql':
    app.config['SQLALCHEMY_ENGINE_OPTIONS']['pool_recycle'] = 3600
    app.config['SQLALCHEMY_ENGINE_OPTIONS']['connect_args'] = {
        'connect_timeout': 10,
        'read_timeout': 60,
        'write_timeout': 60,
    }
elif not ALLOW_SQLITE_APP_DB:
    raise RuntimeError(
        f'MAIN APP DATABASE MUST USE MARIADB/MYSQL, GOT {get_database_backend_name().upper()} ({redact_database_uri()})'
    )
app.config['UPLOAD_FOLDER'] = os.path.join(basedir, 'uploads')
NOTES_DIR = os.path.join(basedir, 'notes')
THUMBNAILS_DIR = os.path.join(basedir, 'thumbnails')

# AUDIT FIX M3: tighten Pillow's decompression-bomb threshold for ALL Image
# operations the app performs (thumbnail generation, captcha, etc.). Pillow's
# default (~89 MP soft warn, ~178 MP hard reject) still lets a ~12000×12000
# image consume hundreds of MB during decode, which can OOM the worker.
# 40 MP allows a 6.4Kx6.4K image (well above any realistic uploaded photo)
# while bounding worst-case memory at ~160 MB per decode. Operators can raise
# this via PILLOW_MAX_IMAGE_PIXELS if they need to.
try:
    from PIL import Image as _PIL_Image_init
    _pillow_max_pixels_env = int(os.environ.get('PILLOW_MAX_IMAGE_PIXELS', str(40 * 1000 * 1000)))
    _PIL_Image_init.MAX_IMAGE_PIXELS = max(1_000_000, _pillow_max_pixels_env)
    # Treat the warning as a real exception so we can catch it cleanly.
    import warnings as _warnings_pillow
    _warnings_pillow.simplefilter('error', _PIL_Image_init.DecompressionBombWarning)
except Exception as _pil_init_err:
    print(f'[WARNING] Failed to set Pillow MAX_IMAGE_PIXELS: {_pil_init_err}')

db = SQLAlchemy(app)

# Enable WAL mode for SQLite -- allows concurrent readers alongside a single
# writer, preventing "database is locked" errors under concurrent load.
# Use Engine.connect event via the SQLAlchemy Engine class (not db.engine which
# requires app context at module-load time under Flask-SQLAlchemy).
with app.app_context():
    if db.engine.url.get_backend_name() == 'sqlite':
        @event.listens_for(db.engine, "connect")
        def _set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")          # Safe with WAL; reduces fsync overhead
            cursor.execute("PRAGMA cache_size=-65536")            # 64 MB page cache (negative = KB)
            cursor.execute("PRAGMA mmap_size=268435456")          # 256 MB memory-mapped I/O
            cursor.execute("PRAGMA temp_store=memory")            # Temp tables/indexes in RAM
            cursor.execute("PRAGMA foreign_keys=ON")              # Enforce FK constraints
            cursor.execute("PRAGMA busy_timeout=5000")              # Wait up to 5s for locks instead of failing immediately
            cursor.close()

# Config
max_gb = float(os.environ.get('MAX_SIZE_GB', '10.0'))
if not (0.001 <= max_gb <= 100):
    raise ValueError('MAX_SIZE_GB out of range (1MB-100GB)')
app.config['MAX_CONTENT_LENGTH'] = int(max_gb * 1024 * 1024 * 1024)

# Large file upload support: configure Werkzeug to spool uploads to disk
# MAX_FORM_MEMORY_SIZE: form fields (non-file) over this size go to disk
# This prevents memory exhaustion for multi-GB file uploads
app.config['MAX_FORM_MEMORY_SIZE'] = 10 * 1024 * 1024  # 10MB - form fields over this go to disk

# Configure request body handling for large files
# Werkzeug's multipart parser already spools file uploads to temp files on disk,
# but we explicitly set the threshold low to ensure large uploads don't consume RAM
app.config['MAX_FORM_PARTS'] = 1000  # Max number of multipart form parts

# AUDIT FIX: Flask 3.x never reads MAX_FORM_MEMORY_SIZE / MAX_FORM_PARTS out of
# app.config — the multipart parser takes them from attributes on the REQUEST
# CLASS (Werkzeug defaults: 500_000 bytes buffered per non-file field, 1000
# parts). Setting only app.config was silently ignored, so the configured
# limits were not the ones actually enforced. Subclass the request class so
# the configured values take effect: a non-file form field larger than
# MAX_FORM_MEMORY_SIZE and a body with more than MAX_FORM_PARTS parts now
# raise 413 (RequestEntityTooLarge) via the normal Werkzeug path, and both
# stay bounded — as does total body size — by MAX_CONTENT_LENGTH.
from flask import Request as _FlaskRequest


class _OneGYRequest(_FlaskRequest):
    max_form_memory_size = int(app.config['MAX_FORM_MEMORY_SIZE'])
    max_form_parts = int(app.config['MAX_FORM_PARTS'])


app.request_class = _OneGYRequest
domain = os.environ.get('DOMAIN', f"localhost:{os.environ.get('WEB_PORT', '5000')}")
allow_temp_uploads = os.environ.get('ALLOW_TEMP_UPLOADS', 'true').lower() in ('true', '1', 'yes')
allow_registration = os.environ.get('ALLOW_REGISTRATION', 'true').lower() in ('true', '1', 'yes')
captcha_enabled = os.environ.get('CAPTCHA_ENABLED', 'true').lower() in ('true', '1', 'yes')
allow_api_keys = os.environ.get('ALLOW_API_KEYS', 'false').lower() in ('true', '1', 'yes')
welcome_folder_enabled = os.environ.get('WELCOME_FOLDER_ENABLED', 'false').lower() in ('true', '1', 'yes')
allow_music = os.environ.get('ALLOW_MUSIC', 'true').lower() in ('true', '1', 'yes')
MUSIC_LIBRARY_PATH = os.environ.get('MUSIC_LIBRARY_PATH', os.path.join(os.path.expanduser('~'), 'music'))

fernet_key_b64 = os.environ.get('FERNET_KEY')
if not fernet_key_b64:
    raise ValueError('FERNET_KEY not found in .env file. Please set FERNET_KEY in .env before starting the application.')
fernet_keys = [part.strip() for part in str(fernet_key_b64).split(',') if part.strip()]
if not fernet_keys:
    raise ValueError('FERNET_KEY does not contain any usable key material.')
fernet = MultiFernet([Fernet(key.encode()) for key in fernet_keys])
app.config['FERNET'] = fernet
_DUMMY_PASSWORD_HASH = None


def _dummy_password_hash():
    global _DUMMY_PASSWORD_HASH
    if _DUMMY_PASSWORD_HASH is None:
        _DUMMY_PASSWORD_HASH = generate_password_hash('__onegy-timing-dummy__', method='pbkdf2:sha256')
    return _DUMMY_PASSWORD_HASH
app.config['MAX_RETENTION'] = timedelta(days=7)

# Upload processing progress tracking
# Tracks server-side processing progress (encryption, zipping) per upload
# so the frontend can poll for status updates during the processing phase.
# Uses file-based storage in /tmp so progress is shared across Gunicorn workers.
import threading

_PROGRESS_DIR = os.path.join('/tmp', 'fileshare_progress')
os.makedirs(_PROGRESS_DIR, exist_ok=True)

# ─── Namespaced working directories ───────────────────────────────────────────
# AUDIT FIX D7: working directories used to be created straight in /tmp with
# generic prefixes ('upload_', 'edit_', ...), and cleanup_temp_dirs() deleted any
# match older than 30 minutes based on the DIRECTORY's mtime. Two problems:
#   1. a directory's mtime only advances when an ENTRY IS CREATED in it, not
#      while a single large file inside it is being written -- so a >30 min
#      upload or a multi-GB ZIP build had its working directory deleted out from
#      under it, mid-write;
#   2. the generic prefixes matched unrelated processes' /tmp directories.
# Working dirs now live under one namespaced root and carry a liveness marker
# that active operations refresh, and the age check uses the newest mtime found
# anywhere inside the directory (which DOES advance during a long write).
ONEGY_TEMP_ROOT = os.path.join(tempfile.gettempdir(), 'onegy_work')
_WORK_DIR_ALIVE_MARKER = '.onegy_alive'

def _ensure_onegy_temp_root():
    try:
        os.makedirs(ONEGY_TEMP_ROOT, exist_ok=True)
    except Exception as e:
        print(f'[WARNING] Could not create work-dir root {ONEGY_TEMP_ROOT}: {e}')
        return tempfile.gettempdir()
    return ONEGY_TEMP_ROOT

def touch_work_dir(path):
    """Refresh a working directory's liveness marker.

    Call this periodically from long-running operations (per ZIP member, per
    upload chunk group, ...) so the cleanup job can always tell an in-use
    directory from an abandoned one."""
    if not path:
        return
    try:
        marker = os.path.join(path, _WORK_DIR_ALIVE_MARKER)
        with open(marker, 'a'):
            os.utime(marker, None)
    except Exception as e:
        print(f'[WARNING] Could not refresh liveness marker for {path}: {e}')

def create_work_dir(prefix):
    """Create a namespaced working directory with a liveness marker."""
    path = tempfile.mkdtemp(prefix=prefix, dir=_ensure_onegy_temp_root())
    touch_work_dir(path)
    return path

def _work_dir_last_activity(path):
    """Newest mtime anywhere in a working directory (the dir itself, its liveness
    marker, and its contents). Returns None when it cannot be determined, which
    callers MUST treat as 'still in use' and refuse to delete."""
    newest = None
    try:
        newest = os.path.getmtime(path)
    except OSError:
        return None
    try:
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                try:
                    mtime = os.path.getmtime(os.path.join(root, name))
                except OSError:
                    continue
                if newest is None or mtime > newest:
                    newest = mtime
    except Exception as e:
        print(f'[WARNING] Could not scan work dir {path} for activity: {e}')
        return None
    return newest

def _progress_path(file_id):
    """Return path to progress file for a given upload, sanitizing the file_id"""
    import re
    if not re.match(r'^[0-9a-zA-Z_\-]+$', file_id):
        return os.path.join(_PROGRESS_DIR, 'invalid.json')
    return os.path.join(_PROGRESS_DIR, file_id + '.json')

def _progress_owner_token():
    # /upload pins the identity the browser had BEFORE it minted a guest id,
    # so polls carrying the old cookie still match.
    pinned = getattr(g, '_progress_owner_token', None) if has_request_context() else None
    if pinned:
        return pinned
    sid = session.get('sid') or ''
    guest = session.get('user_id') or ''
    uid = session.get('logged_in_user_id') or ''
    mgr = request.cookies.get('onegy_manager') or ''
    return hashlib.sha256(f'{sid}:{guest}:{uid}:{mgr}'.encode('utf-8')).hexdigest()[:32]


def set_upload_progress(file_id, phase, percent, speed=None):
    """Update progress for an in-flight upload (shared across workers via filesystem)

    AUDIT FIX (residual torn-state/leak): the temp path used to be the FIXED
    name `<id>.json.tmp`, so two concurrent writers for one upload (the
    encryption tick vs. the finalize tick) truncated/interleaved the same temp
    file -- a reader could get a partial document -- and a crash between
    open() and replace() stranded that fixed name in the progress directory.
    Each write now owns a unique mkstemp file, is fsynced before it is renamed
    into place (so a reader never sees a truncated JSON after a power cut), and
    the temp file is removed if anything fails."""
    tmp_path = None
    try:
        data = json.dumps({
            'phase': phase,
            'percent': percent,
            'speed': speed,
            'timestamp': time.time(),
            'owner': _progress_owner_token(),
        })
        path = _progress_path(file_id)
        fd, tmp_path = tempfile.mkstemp(
            prefix=f'.{os.path.basename(path)}.', suffix='.tmp', dir=_PROGRESS_DIR)
        with os.fdopen(fd, 'w') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        tmp_path = None
    except Exception as e:
        print(f'[ERROR] Failed to write upload progress for {file_id}: {e}')
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

def get_upload_progress(file_id):
    """Get current progress for an upload (reads from shared filesystem)"""
    try:
        path = _progress_path(file_id)
        with open(path, 'r') as f:
            data = json.loads(f.read())
        owner = data.get('owner')
        if owner and not hmac.compare_digest(str(owner), _progress_owner_token()):
            return None
        data.pop('owner', None)
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    except Exception as e:
        print(f'[ERROR] Failed to read upload progress for {file_id}: {e}')
        return None

def clear_upload_progress(file_id):
    """Remove progress tracking for a completed upload"""
    try:
        os.remove(_progress_path(file_id))
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f'[ERROR] Failed to clear upload progress for {file_id}: {e}')

# ─── Purge progress tracking (background local purge) ──────────────────
_PURGE_PROGRESS_FILE = os.path.join(_PROGRESS_DIR, 'purge_local.json')
_PURGE_RUN_UNSET = object()

def _acquire_purge_start_lock():
    """Serialize purge startup and run-scoped progress writes across workers."""
    lock_path = os.path.join(_advisory_lock_dir(), 'purge_local_start.lock')
    return _open_flock_exclusive(lock_path)


def _write_purge_progress(state, run_id=_PURGE_RUN_UNSET, lock_held=False):
    """Atomically write progress, refusing updates from a superseded run."""
    progress_lock = None
    tmp = None
    try:
        if not lock_held:
            progress_lock = _acquire_purge_start_lock()
        if run_id is not _PURGE_RUN_UNSET:
            current = _read_purge_progress()
            if current.get('run_id') != run_id:
                return False
            state = dict(state)
            if run_id is not None:
                state['run_id'] = run_id
        fd, tmp = tempfile.mkstemp(
            prefix='.purge_local.', suffix='.tmp', dir=_PROGRESS_DIR)
        with os.fdopen(fd, 'w') as f:
            json.dump(state, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, _PURGE_PROGRESS_FILE)
        tmp = None
        return True
    except Exception as e:
        print(f'[ERROR] Failed to write purge progress: {e}')
        return False
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass
        if progress_lock:
            _release_scoped_lock(progress_lock)

def _read_purge_progress():
    """Read current purge progress. Returns {'status': 'idle'} if no purge is active."""
    try:
        with open(_PURGE_PROGRESS_FILE, 'r') as f:
            return json.loads(f.read())
    except (FileNotFoundError, json.JSONDecodeError):
        return {'status': 'idle'}
    except Exception as e:
        print(f'[ERROR] Failed to read purge progress: {e}')
        return {'status': 'idle'}

def _clear_purge_progress(run_id=_PURGE_RUN_UNSET):
    """Remove purge progress unless it belongs to a newer run."""
    progress_lock = _acquire_purge_start_lock()
    try:
        if (run_id is not _PURGE_RUN_UNSET
                and _read_purge_progress().get('run_id') != run_id):
            return False
        os.remove(_PURGE_PROGRESS_FILE)
        return True
    except FileNotFoundError:
        return True
    except Exception as e:
        print(f'[ERROR] Failed to clear purge progress: {e}')
        return False
    finally:
        _release_scoped_lock(progress_lock)

_COMPOUND_EXT_PREFIXES = {'tar'}

def _get_compound_ext(filename):
    """Extract the full compound extension from a filename.
    For 'archive.tar.gz' returns 'tar.gz', for 'photo.jpg' returns 'jpg'.
    For 'noext' returns ''. Always lowercase."""
    if '.' not in filename:
        return ''
    parts = filename.rsplit('.', 2)
    if len(parts) == 3 and parts[1].lower() in _COMPOUND_EXT_PREFIXES:
        return (parts[1] + '.' + parts[2]).lower()
    return parts[-1].lower()

def _split_name_ext(filename):
    """Split filename into (base, ext_with_dot) respecting compound extensions.
    For 'archive.tar.gz' returns ('archive', '.tar.gz').
    For 'photo.jpg' returns ('photo', '.jpg').
    For 'noext' returns ('noext', '')."""
    if '.' not in filename:
        return filename, ''
    parts = filename.rsplit('.', 2)
    if len(parts) == 3 and parts[1].lower() in _COMPOUND_EXT_PREFIXES:
        return parts[0], '.' + parts[1] + '.' + parts[2]
    idx = filename.rfind('.')
    return filename[:idx], filename[idx:]

def format_bytes_for_filesize(size_bytes):
    if size_bytes < 1024:
        return f'{size_bytes} B'
    size_bytes /= 1024
    if size_bytes < 1024:
        return f'{size_bytes:.2f} KB'
    size_bytes /= 1024
    if size_bytes < 1024:
        return f'{size_bytes:.2f} MB'
    size_bytes /= 1024
    if size_bytes < 1024:
        return f'{size_bytes:.2f} GB'
    size_bytes /= 1024
    return f'{size_bytes:.2f} TB'

def format_percent_for_display(percent_value):
    percent_value = max(0.0, min(float(percent_value), 100.0))
    if percent_value >= 100:
        return '100%'
    trimmed_value = int(percent_value * 10) / 10
    return f"{trimmed_value:.1f}".rstrip('0').rstrip('.') + '%'

# In-memory cache for the public landing stats: the landing page is anonymous
# and crawler-exposed, and each render otherwise runs 3+N aggregate queries
# (per-node SUM joins + a GROUP BY/HAVING replica-count subquery). Same
# concurrency rationale as _SETTINGS_CACHE (entries replaced whole, GIL-atomic,
# per-process). Staleness up to the TTL is fine for a marketing counter.
_LANDING_STATS_CACHE = {}
_LANDING_STATS_CACHE_TTL = 60  # seconds
# AUDIT FIX A6: the anonymous landing path had no refresh lock (the admin
# equivalent grew one for exactly this reason). At every TTL boundary EVERY
# concurrent request on '/' ran the full aggregate set -- a per-node SUM over
# FileReplica JOIN File plus a GROUP BY/HAVING replica-count subquery -- in
# parallel, so a crawler could pin all 8 gthreads. '/' has no route-specific
# rate limit. Only one request now recomputes; the rest serve the previous value.
_LANDING_STATS_LOCK = threading.Lock()
_LANDING_STATS_LOCK_TIMEOUT = 20.0

def get_public_landing_stats():
    """Return sanitized replication stats for the landing page.
    Public stats intentionally avoid revealing storage topology. Totals use active
    file payloads only (no notes, thumbnails, backend config, or per-node details).
    Results are cached for _LANDING_STATS_CACHE_TTL seconds; the exception
    fallback below is intentionally NOT cached so a transient DB error does not
    pin zeroed stats for a full TTL window.

    The refresh is single-flighted (AUDIT FIX A6): a request that arrives while
    another is already recomputing serves the previous value instead of running
    the aggregates again."""
    cached = _LANDING_STATS_CACHE.get('stats')
    if cached and (time.monotonic() - cached['ts']) < _LANDING_STATS_CACHE_TTL:
        return cached['value']
    stale_value = cached['value'] if cached else None
    if stale_value is not None:
        if not _LANDING_STATS_LOCK.acquire(blocking=False):
            return stale_value
    elif not _LANDING_STATS_LOCK.acquire(timeout=_LANDING_STATS_LOCK_TIMEOUT):
        print('[LANDING] Stats refresh lock timed out; serving the unavailable fallback')
        return _landing_stats_unavailable()
    try:
        return _compute_public_landing_stats()
    finally:
        _LANDING_STATS_LOCK.release()


def _landing_stats_unavailable():
    """Fallback payload used when the stats cannot be built right now."""
    return {
        'files_fully_synced': 0,
        'files_fully_synced_label': '0',
        'total_active_files': 0,
        'total_active_files_label': '0',
        'backup_completion_percent': 0.0,
        'backup_completion_percent_label': '0%',
        'backup_completion_status': 'error',
        'backup_completion_sub': 'LANDING STATS UNAVAILABLE',
        'total_display_file_bytes': 0,
        'total_display_file_bytes_formatted': '0 B',
        'total_display_file_bytes_sub': 'FILE PAYLOAD ACROSS ACTIVE STORAGE NODES',
    }


def _compute_public_landing_stats():
    """Build the landing stats. Callers MUST hold _LANDING_STATS_LOCK."""
    # Re-check under the lock: another thread may have just refreshed it.
    cached = _LANDING_STATS_CACHE.get('stats')
    if cached and (time.monotonic() - cached['ts']) < _LANDING_STATS_CACHE_TTL:
        return cached['value']
    now_utc = datetime.now(timezone.utc)
    try:
        active_file_filters = [
            File.is_trashed == False,
            db.or_(File.expires_at.is_(None), File.expires_at >= now_utc)
        ]

        display_node_ids = []
        total_display_file_bytes = 0
        for node in StorageNode.query.filter(
            StorageNode.is_enabled == True
        ).order_by(StorageNode.created_at.asc(), StorageNode.id.asc()).all():
            if node.node_type not in ('local', 's3', 'ssh'):
                continue

            node_file_bytes = db.session.query(
                db.func.coalesce(db.func.sum(db.func.coalesce(File.size, FileReplica.size_bytes, 0)), 0)
            ).select_from(FileReplica).join(File, File.id == FileReplica.file_id).filter(
                FileReplica.node_id == node.id,
                FileReplica.status == 'synced',
                *active_file_filters
            ).scalar() or 0
            node_file_bytes = int(node_file_bytes)
            total_display_file_bytes += node_file_bytes
            display_node_ids.append(node.id)

        display_node_count = len(display_node_ids)
        total_active_files = File.query.filter(*active_file_filters).count()

        files_fully_synced = 0
        if display_node_count > 0:
            files_fully_synced = db.session.query(db.func.count()).select_from(
                db.session.query(File.id).outerjoin(
                    FileReplica,
                    db.and_(
                        FileReplica.file_id == File.id,
                        FileReplica.status == 'synced',
                        FileReplica.node_id.in_(display_node_ids)
                    )
                ).filter(*active_file_filters).group_by(File.id).having(
                    db.func.count(db.distinct(FileReplica.node_id)) == display_node_count
                ).subquery()
            ).scalar() or 0

        if total_active_files == 0:
            backup_completion_percent = 100.0
            backup_completion_sub = 'NO ACTIVE FILES TO MIRROR'
        elif display_node_count == 0:
            backup_completion_percent = 0.0
            backup_completion_sub = 'NO ACTIVE STORAGE NODES'
        else:
            backup_completion_percent = (files_fully_synced / total_active_files) * 100.0
            backup_completion_sub = (
                f'{files_fully_synced:,} OF {total_active_files:,} FILES '
                f'FULLY MIRRORED ACROSS ACTIVE STORAGE NODES'
            )

        if total_active_files == 0 or files_fully_synced == total_active_files:
            backup_completion_status = 'ok'
        elif backup_completion_percent < 99:
            backup_completion_status = 'error'
        else:
            backup_completion_status = 'warn'

        stats = {
            'files_fully_synced': int(files_fully_synced),
            'files_fully_synced_label': f'{int(files_fully_synced):,}',
            'total_active_files': int(total_active_files),
            'total_active_files_label': f'{int(total_active_files):,}',
            'backup_completion_percent': backup_completion_percent,
            'backup_completion_percent_label': format_percent_for_display(backup_completion_percent),
            'backup_completion_status': backup_completion_status,
            'backup_completion_sub': backup_completion_sub,
            'total_display_file_bytes': total_display_file_bytes,
            'total_display_file_bytes_formatted': format_bytes_for_filesize(total_display_file_bytes),
            'total_display_file_bytes_sub': 'FILE PAYLOAD ACROSS ACTIVE STORAGE NODES',
        }
        _LANDING_STATS_CACHE['stats'] = {'value': stats, 'ts': time.monotonic()}
        return stats
    except Exception as e:
        print(f'[LANDING] Failed to build public landing stats: {e}')
        try:
            db.session.rollback()
        except Exception:
            pass
        return _landing_stats_unavailable()

app.jinja_env.filters['filesize'] = format_bytes_for_filesize
app.jinja_env.filters['b64encode'] = lambda data: base64.b64encode(data).decode('ascii') if data else ''
app.jinja_env.globals['get_compound_ext'] = _get_compound_ext
app.jinja_env.globals['split_name_ext'] = _split_name_ext

ADMIN_STATS_WINDOWS = {
    '30m': {'delta': timedelta(minutes=30), 'bucket': timedelta(minutes=5), 'label': '5M'},
    '6h': {'delta': timedelta(hours=6), 'bucket': timedelta(minutes=15), 'label': '15M'},
    '1d': {'delta': timedelta(days=1), 'bucket': timedelta(hours=1), 'label': '1H'},
    '7d': {'delta': timedelta(days=7), 'bucket': timedelta(hours=6), 'label': '6H'},
    '30d': {'delta': timedelta(days=30), 'bucket': timedelta(days=1), 'label': '1D'},
}

def _utc_aware(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

def _round_datetime_floor(dt, bucket_delta):
    bucket_seconds = max(60, int(bucket_delta.total_seconds()))
    epoch_seconds = int(dt.timestamp())
    rounded = epoch_seconds - (epoch_seconds % bucket_seconds)
    return datetime.fromtimestamp(rounded, tz=timezone.utc)

def _format_admin_bucket_label(dt, window_key):
    if window_key in ('30m', '6h'):
        return dt.strftime('%H:%M')
    if window_key == '1d':
        return dt.strftime('%H:00')
    if window_key == '7d':
        return dt.strftime('%d %b %H:%M').upper()
    return dt.strftime('%d %b').upper()

# AUDIT Tier 1: TTL cache for the admin live-stats payload. The full build
# fires ~25 aggregate queries plus a file_types scan + replication status
# rollup; admin pages and the metrics snapshot job both call it. With this
# 15s cache the cost is amortized across all callers within a 15s window.
# capture_system_metrics_snapshot() and other callers that need a fresh
# snapshot can pass use_cache=False.
_ADMIN_LIVE_STATS_CACHE = {'payload': None, 'computed_at': 0.0}
_ADMIN_LIVE_STATS_TTL_SECONDS = 15.0
_ADMIN_LIVE_STATS_LOCK = threading.Lock()
# AUDIT FIX A5: an admin request with no cached payload at all may wait for the
# in-flight refresh, but never indefinitely.
_ADMIN_LIVE_STATS_LOCK_TIMEOUT = 20.0


def _file_type_histogram(limit=8):
    """Top file extensions for the admin dashboard, aggregated in SQL.

    AUDIT FIX A5: this used to be `db.session.query(File.orig_name).all()` --
    one Python string per file in the ENTIRE system, materialised every 5
    minutes by metrics_snapshot_job whether or not an admin was looking, purely
    to build an 8-entry histogram.

    The grouping now happens in the database. _COMPOUND_EXT_PREFIXES contains
    only 'tar', so a second small grouped query reassigns 'gz' -> 'tar.gz' etc.
    and the result stays byte-identical to _get_compound_ext(). Non-MySQL
    dialects (only reachable with ALLOW_SQLITE_APP_DB=true) fall back to a
    streaming scan that never holds more than one batch in memory."""
    from collections import defaultdict

    dialect_name = ''
    try:
        dialect_name = db.engine.dialect.name or ''
    except Exception:
        dialect_name = ''

    if dialect_name not in ('mysql', 'mariadb'):
        type_counts = defaultdict(int)
        try:
            for row in db.session.query(File.orig_name).yield_per(5000):
                type_counts[_get_compound_ext(row[0]) or 'other'] += 1
        except Exception as e:
            print(f'[ADMIN] Failed to build file type histogram: {e}')
            return []
        return sorted(type_counts.items(), key=lambda item: item[1], reverse=True)[:limit]

    try:
        last_segment = db.func.substring_index(File.orig_name, '.', -1)
        plain_ext = case(
            (File.orig_name.notlike('%.%'), 'other'),
            else_=db.func.lower(last_segment),
        )
        counts = defaultdict(int)
        # All groups (one row per distinct extension): any preliminary cut can
        # drop the true winner once the compound correction below moves counts.
        for ext, cnt in db.session.query(plain_ext.label('ext'), db.func.count()).group_by(
            'ext'
        ).all():
            counts[(ext or 'other')] += int(cnt or 0)

        # Compound ('.tar.<x>') correction: move those rows out of the plain
        # '<x>' bucket and into a 'tar.<x>' bucket.
        second_last = db.func.lower(
            db.func.substring_index(db.func.substring_index(File.orig_name, '.', -2), '.', 1)
        )
        compound_ext = db.func.lower(db.func.concat('tar.', last_segment))
        compound_rows = db.session.query(compound_ext.label('ext'), db.func.count()).filter(
            File.orig_name.like('%.tar.%'),
            second_last == 'tar',
        ).group_by('ext').all()
        for ext, cnt in compound_rows:
            cnt = int(cnt or 0)
            if not ext or cnt <= 0:
                continue
            # Same 'other' bucket the first pass used for an empty extension.
            plain = (ext.split('.', 1)[1] if '.' in ext else ext) or 'other'
            counts[ext] += cnt
            if plain in counts:
                counts[plain] -= cnt
                if counts[plain] <= 0:
                    counts.pop(plain, None)
        return sorted(counts.items(), key=lambda item: item[1], reverse=True)[:limit]
    except Exception as e:
        print(f'[ADMIN] Failed to aggregate file type histogram: {e}')
        try:
            db.session.rollback()
        except Exception:
            pass
        return []


def _build_admin_live_stats(use_cache=True):
    import time as _time

    if use_cache:
        cached = _ADMIN_LIVE_STATS_CACHE
        stale_payload = cached.get('payload')
        if (
            stale_payload is not None
            and (_time.monotonic() - cached.get('computed_at', 0.0)) < _ADMIN_LIVE_STATS_TTL_SECONDS
        ):
            return stale_payload
        # AUDIT FIX A5: single-flight the refresh WITHOUT parking every other
        # request thread on the lock for the duration of the ~25-query rebuild.
        # The lock used to be acquired blocking and then held across the whole
        # recursive rebuild; with read_timeout=60 per statement that stalled every
        # concurrent admin request for up to a minute. Now a loser thread serves
        # the marginally-stale payload immediately, and only a caller that has
        # NOTHING to serve waits at all (with a bounded timeout).
        if stale_payload is not None:
            if not _ADMIN_LIVE_STATS_LOCK.acquire(blocking=False):
                return stale_payload
        elif not _ADMIN_LIVE_STATS_LOCK.acquire(timeout=_ADMIN_LIVE_STATS_LOCK_TIMEOUT):
            print('[ADMIN] Live-stats refresh lock timed out; building an uncached snapshot')
            return _build_admin_live_stats(use_cache=False)
        try:
            # Re-check under lock: another thread may have just refreshed it.
            cached = _ADMIN_LIVE_STATS_CACHE
            if (
                cached.get('payload') is not None
                and (_time.monotonic() - cached.get('computed_at', 0.0)) < _ADMIN_LIVE_STATS_TTL_SECONDS
            ):
                return cached['payload']
            payload = _build_admin_live_stats(use_cache=False)
            _ADMIN_LIVE_STATS_CACHE['payload'] = payload
            _ADMIN_LIVE_STATS_CACHE['computed_at'] = _time.monotonic()
            return payload
        finally:
            _ADMIN_LIVE_STATS_LOCK.release()

    now = datetime.now(timezone.utc)

    total_users = User.query.count()
    admin_users = User.query.filter_by(is_admin=True).count()
    e2e_users = User.query.filter(User.has_e2ee_keys == True).count()

    total_files = File.query.count()
    registered_file_count = File.query.filter_by(is_temp_upload=False).count()
    temp_file_count = File.query.filter(
        File.is_temp_upload == True,
        db.or_(File.expires_at.is_(None), File.expires_at >= now)
    ).count()
    e2e_file_count = File.query.filter_by(is_e2e_encrypted=True).count()
    total_folders = Folder.query.filter_by(is_trashed=False).count()

    total_downloads = int(db.session.query(db.func.coalesce(db.func.sum(File.download_count), 0)).scalar() or 0)
    total_file_size = int(db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).scalar() or 0)
    registered_file_payload_bytes = int((db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).filter(
        File.is_temp_upload == False
    ).scalar() or 0))
    temp_file_payload_bytes = int((db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).filter(
        File.is_temp_upload == True,
        db.or_(File.expires_at.is_(None), File.expires_at >= now)
    ).scalar() or 0))
    unique_visitors = int((db.session.query(db.func.count(db.func.distinct(File.user_id))).filter(
        File.is_temp_upload == True,
        db.or_(File.expires_at.is_(None), File.expires_at >= now)
    ).scalar() or 0))

    local_node = StorageNode.query.filter_by(node_type='local', is_enabled=True).first()
    local_tracked = storage.get_node_tracked_storage_breakdown(local_node.id) if local_node else None
    tracked_registered_bytes = int((local_tracked or {}).get('registered_bytes', 0) or 0)
    tracked_temp_bytes = int((local_tracked or {}).get('temp_bytes', 0) or 0)
    tracked_total_bytes = int((local_tracked or {}).get('tracked_total_bytes', 0) or 0)
    note_bytes = int((local_tracked or {}).get('note_bytes', 0) or 0)
    registered_thumb_bytes = int((local_tracked or {}).get('registered_thumb_bytes', 0) or 0)
    temp_thumb_bytes = int((local_tracked or {}).get('temp_thumb_bytes', 0) or 0)
    disk = shutil.disk_usage('/')

    # AUDIT FIX A5: aggregated in SQL instead of pulling every filename.
    file_types = _file_type_histogram(limit=8)

    live_status = storage.get_replication_status()
    enabled_nodes = StorageNode.query.filter_by(is_enabled=True).all()
    online_nodes = sum(1 for node in enabled_nodes if node.status == 'online')
    offline_nodes = sum(1 for node in enabled_nodes if node.status == 'offline')
    error_nodes = sum(1 for node in enabled_nodes if node.status == 'error')
    syncing_nodes = sum(1 for node in enabled_nodes if node.status == 'syncing')
    pending_files = int(live_status.get('pending_files', 0) or 0)
    pending_notes = int(live_status.get('pending_notes', 0) or 0)
    pending_thumbnails = int(live_status.get('pending_thumbnails', 0) or 0)
    error_files = FileReplica.query.filter_by(status='error').count()
    error_notes = NoteReplica.query.filter_by(status='error').count()
    error_thumbnails = ThumbnailReplica.query.filter_by(status='error').count()
    synced_file_replicas = FileReplica.query.filter_by(status='synced').count()
    synced_note_replicas = NoteReplica.query.filter_by(status='synced').count()
    synced_thumbnail_replicas = ThumbnailReplica.query.filter_by(status='synced').count()
    pending_remote_deletes = PendingRemoteDelete.query.count()
    avg_sync_percent = 100.0
    if live_status.get('per_node'):
        avg_sync_percent = round(sum((node.get('sync_percent') or 0) for node in live_status['per_node']) / len(live_status['per_node']), 1)

    replication_config = {
        'speed': str(get_setting_value('replication_speed') or 'steady').upper(),
        'source': str(get_setting_value('replication_source') or 'primary_fallback').replace('_', ' ').upper(),
        'workers': get_numeric_setting('replication_workers'),
        'checksum': str(get_setting_value('replication_verify_checksum') or 'false').lower() in ('true', '1', 'yes'),
    }

    return {
        'overview': {
            'total_users': total_users,
            'admin_users': admin_users,
            'regular_users': total_users - admin_users,
            'total_files': total_files,
            'registered_files': registered_file_count,
            'temp_files': temp_file_count,
            'total_folders': total_folders,
            'e2e_files': e2e_file_count,
            'e2e_users': e2e_users,
            'unique_visitors': unique_visitors,
            'total_downloads': total_downloads,
        },
        'storage': {
            'app_used_gb': round(tracked_total_bytes / (1024**3), 2),
            'disk_total_gb': round(disk.total / (1024**3), 1),
            'disk_free_gb': round(disk.free / (1024**3), 1),
            'disk_percent': round((disk.total - disk.free) / disk.total * 100, 1) if disk.total > 0 else 0,
            'total_file_size_gb': round(total_file_size / (1024**3), 2),
            'total_file_size_bytes': total_file_size,
            'temp_file_size_gb': round(temp_file_payload_bytes / (1024**3), 2),
            'total_storage_bytes': tracked_total_bytes,
            'tracked_registered_bytes': tracked_registered_bytes,
            'tracked_temp_bytes': tracked_temp_bytes,
            'tracked_total_bytes': tracked_total_bytes,
            'registered_file_payload_bytes': registered_file_payload_bytes,
            'temp_file_payload_bytes': temp_file_payload_bytes,
            'disk_total_bytes': int(disk.total),
            'disk_free_bytes': int(disk.free),
            'note_bytes': note_bytes,
            'registered_thumb_bytes': registered_thumb_bytes,
            'temp_thumb_bytes': temp_thumb_bytes,
        },
        'replication': {
            'overview': {
                'nodes': len(enabled_nodes),
                'online_nodes': online_nodes,
                'offline_nodes': offline_nodes,
                'error_nodes': error_nodes,
                'syncing_nodes': syncing_nodes,
                'avg_sync_percent': avg_sync_percent,
                'pending_items': pending_files + pending_notes + pending_thumbnails,
                'error_items': error_files + error_notes + error_thumbnails,
                'pending_files': pending_files,
                'pending_notes': pending_notes,
                'pending_thumbnails': pending_thumbnails,
                'error_files': error_files,
                'error_notes': error_notes,
                'error_thumbnails': error_thumbnails,
                'synced_file_replicas': synced_file_replicas,
                'synced_note_replicas': synced_note_replicas,
                'synced_thumbnail_replicas': synced_thumbnail_replicas,
                'pending_remote_deletes': pending_remote_deletes,
                'fully_synced': bool(live_status.get('fully_synced')),
            },
            'config': replication_config,
            'per_node': live_status.get('per_node', []),
        },
        'details': {
            'file_types': [{'ext': ext, 'count': cnt} for ext, cnt in file_types],
        }
    }

_metrics_snapshot_lock = threading.Lock()


def capture_system_metrics_snapshot(force=False):
    # AUDIT FIX (finding 20, perf): serialize the read-check-then-insert. The
    # admin history builders and the 5-minute scheduler job all call this with
    # force=False; without the lock two concurrent callers both passed the
    # "no recent snapshot" check and inserted duplicate rows for the same
    # window. Single gunicorn worker -> a module lock is sufficient.
    with _metrics_snapshot_lock:
        now = datetime.now(timezone.utc)
        latest = SystemMetricSnapshot.query.order_by(SystemMetricSnapshot.captured_at.desc()).first()
        if latest and not force:
            latest_ts = _utc_aware(latest.captured_at)
            if latest_ts and (now - latest_ts) < timedelta(minutes=4):
                return latest

        live = _build_admin_live_stats()
        overview = live['overview']
        storage_data = live['storage']
        repl = live['replication']['overview']

        snapshot = SystemMetricSnapshot(
        captured_at=now,
        total_users=overview['total_users'],
        admin_users=overview['admin_users'],
        e2e_users=overview['e2e_users'],
        total_files=overview['total_files'],
        registered_files=overview['registered_files'],
        temp_files=overview['temp_files'],
        total_folders=overview['total_folders'],
        e2e_files=overview['e2e_files'],
        total_downloads=overview['total_downloads'],
        total_file_size_bytes=storage_data['total_file_size_bytes'],
        registered_file_payload_bytes=storage_data['registered_file_payload_bytes'],
        temp_file_payload_bytes=storage_data['temp_file_payload_bytes'],
        tracked_registered_bytes=storage_data['tracked_registered_bytes'],
        tracked_temp_bytes=storage_data['tracked_temp_bytes'],
        tracked_total_bytes=storage_data['tracked_total_bytes'],
        disk_total_bytes=storage_data['disk_total_bytes'],
        disk_free_bytes=storage_data['disk_free_bytes'],
        replication_nodes=repl['nodes'],
        replication_online_nodes=repl['online_nodes'],
        replication_offline_nodes=repl['offline_nodes'],
        replication_error_nodes=repl['error_nodes'],
        replication_pending_files=repl['pending_files'],
        replication_pending_notes=repl['pending_notes'],
        replication_pending_thumbnails=repl['pending_thumbnails'],
        replication_error_files=repl['error_files'],
        replication_error_notes=repl['error_notes'],
        replication_error_thumbnails=repl['error_thumbnails'],
        pending_remote_deletes=repl['pending_remote_deletes'],
        )
        db.session.add(snapshot)

        cutoff = now - timedelta(days=45)
        SystemMetricSnapshot.query.filter(SystemMetricSnapshot.captured_at < cutoff).delete(synchronize_session=False)
        db.session.commit()
        print(f'[ADMIN] Captured system metrics snapshot at {now.isoformat()}')
        return snapshot

def build_admin_stats_history(window_key):
    cfg = ADMIN_STATS_WINDOWS.get(window_key) or ADMIN_STATS_WINDOWS['1d']
    now = datetime.now(timezone.utc)
    capture_system_metrics_snapshot(force=False)
    start = now - cfg['delta']
    aligned_start = _round_datetime_floor(start, cfg['bucket'])
    query_start = aligned_start - cfg['bucket']
    snapshots = SystemMetricSnapshot.query.filter(
        SystemMetricSnapshot.captured_at >= query_start
    ).order_by(SystemMetricSnapshot.captured_at.asc()).all()

    series = []
    point_time = aligned_start + cfg['bucket']
    snap_idx = 0
    current = None
    prev_point = None
    # Baseline for the first bucket's download delta: latest snapshot at/before the window start.
    while snap_idx < len(snapshots) and _utc_aware(snapshots[snap_idx].captured_at) <= aligned_start:
        prev_point = snapshots[snap_idx]
        current = prev_point
        snap_idx += 1
    while point_time <= now + timedelta(seconds=1):
        while snap_idx < len(snapshots) and _utc_aware(snapshots[snap_idx].captured_at) <= point_time:
            current = snapshots[snap_idx]
            snap_idx += 1

        downloads_value = 0
        if current and prev_point:
            downloads_value = max(0, int(current.total_downloads or 0) - int(prev_point.total_downloads or 0))

        pending_items = None
        error_items = None
        files_value = None
        bytes_value = None
        online_node_percent = None
        if current:
            pending_items = int(current.replication_pending_files or 0) + int(current.replication_pending_notes or 0) + int(current.replication_pending_thumbnails or 0)
            error_items = int(current.replication_error_files or 0) + int(current.replication_error_notes or 0) + int(current.replication_error_thumbnails or 0)
            files_value = int(current.total_files or 0)
            bytes_value = int(current.tracked_total_bytes or 0)
            if int(current.replication_nodes or 0) > 0:
                online_node_percent = round(max(0, min(100, ((int(current.replication_online_nodes or 0) / max(1, int(current.replication_nodes or 0))) * 100))), 1)

        series.append({
            'ts': point_time.isoformat(),
            'label': _format_admin_bucket_label(point_time, window_key),
            'files': files_value,
            'bytes': bytes_value,
            'downloads': downloads_value,
            'pending_items': pending_items,
            'error_items': error_items,
            # Node availability, not replication completion (snapshots do not
            # record synced totals) -- named for what it measures.
            'online_node_percent': online_node_percent,
        })

        if current:
            prev_point = current
        point_time += cfg['bucket']

    first_snapshot = snapshots[0] if snapshots else None
    latest_snapshot = snapshots[-1] if snapshots else None
    return {
        'window': window_key if window_key in ADMIN_STATS_WINDOWS else '1d',
        'bucket_label': cfg['label'],
        'series': series,
        'availability': {
            'has_data': bool(series and any(point['files'] is not None for point in series)),
            'first_snapshot_at': _utc_aware(first_snapshot.captured_at).isoformat() if first_snapshot else None,
            'latest_snapshot_at': _utc_aware(latest_snapshot.captured_at).isoformat() if latest_snapshot else None,
        }
    }

# AUDIT FIX L7: only trust CDN-specific headers (CF-Connecting-IP, etc.) when
# the operator opts in via TRUST_CDN_HEADERS=true. ProxyFix already sanitizes
# X-Forwarded-For; CDN-specific headers are spoofable unless the front proxy
# is known to strip them. The default DEV/standalone deployment now ignores
# them so log attribution cannot be poisoned by a forged header.
TRUST_CDN_HEADERS = os.environ.get('TRUST_CDN_HEADERS', 'false').strip().lower() in ('1', 'true', 'yes')


def get_real_ip():
    """Get the real client IP, checking reverse proxy headers.
    CDN/proxy headers are only trusted when both TRUSTED_PROXY_HOPS is enabled
    AND the operator has explicitly opted into trusting CDN-specific headers."""
    if TRUSTED_PROXY_HOPS > 0 and TRUST_CDN_HEADERS:
        for header in ('CF-Connecting-IP', 'True-Client-IP', 'X-Real-IP'):
            ip = request.headers.get(header)
            if ip:
                return ip.split(',')[0].strip()
    return request.remote_addr or 'unknown'

# Context processor for template helpers
@app.context_processor
def utility_processor():
    """Provide utility functions to all templates"""
    def get_user(user_id):
        """Get user from database - used for checking admin status in templates"""
        if user_id:
            try:
                return db.session.get(User, user_id)
            except Exception as e:
                print(f'[ERROR] Failed to get user {user_id}: {e}')
                return None
        return None
    return dict(
        get_user=get_user,
        domain=domain,
        allow_temp_uploads=get_setting('allow_temp_uploads'),
        allow_registration=get_setting('allow_registration'),
        captcha_enabled=get_setting('captcha_enabled'),
        allow_api_keys=get_setting('allow_api_keys'),
        allow_music=get_setting('allow_music'),
    )

def _folders_deepest_first(folders):
    """Children before parents, so memoized subtree folds recurse one level at a time."""
    parent = {f.id: f.parent_id for f in folders}
    depth = {}
    for fid in parent:
        chain = []
        cur = fid
        while cur in parent and cur not in depth and cur not in chain:
            chain.append(cur)
            cur = parent[cur]
        base = depth.get(cur, -1)
        for node in reversed(chain):
            base += 1
            depth[node] = base
    return sorted(folders, key=lambda f: depth[f.id], reverse=True)

def _json_object_body():
    """Request JSON as a dict; any other JSON type is treated as an empty body."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}

def _safe_referrer_redirect():
    """Redirect to the HTTP Referer only if it is same-origin, otherwise fall back to index.
    Prevents open-redirect attacks via a maliciously crafted Referer header."""
    from urllib.parse import urlparse
    referrer = request.referrer
    if referrer:
        try:
            ref = urlparse(referrer)
            req = urlparse(request.url)
            # Accept same scheme+host+port only
            if ref.scheme == req.scheme and ref.netloc == req.netloc:
                return redirect(referrer)
        except Exception:
            pass
    return redirect(url_for('index'))

# Request entity too large error handler
@app.errorhandler(413)
def request_entity_too_large(e):
    """Return JSON error for uploads that exceed the size limit"""
    ip = get_real_ip()
    print(f'[UPLOAD] {ip} Request entity too large: {request.content_length} bytes')
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest' or request.content_type and 'multipart/form-data' in request.content_type:
        return jsonify({'error': f'File too large. Maximum upload size is {max_gb}GB.'}), 413
    flash(f'FILE TOO LARGE. MAXIMUM UPLOAD SIZE IS {max_gb}GB.', 'error')
    return _safe_referrer_redirect()

# Rate limit exceeded error handler
@app.errorhandler(429)
def ratelimit_handler(e):
    """JSON for XHR; branded 429 page for browser navigations (never bounce to /)."""
    ip = get_real_ip()
    print(f'[RATELIMIT] {ip} {request.method} {request.path} - Rate limit exceeded: {e.description}')
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest' or request.content_type == 'application/json':
        return jsonify({'error': 'TOO MANY REQUESTS. PLEASE SLOW DOWN.', 'retry_after': e.description}), 429
    return render_template('notfound.html',
        error_code='4',
        error_code_mid='2',
        error_code_end='9',
        title='TOO MANY REQUESTS',
        subtitle='PLEASE SLOW DOWN AND TRY AGAIN IN A MOMENT'), 429

# 404 Not Found error handler
@app.errorhandler(404)
def page_not_found(e):
    """Return branded 404 page for all not-found errors"""
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest' or (request.content_type and 'application/json' in request.content_type):
        return jsonify({'error': 'NOT FOUND'}), 404
    return render_template('notfound.html',
        title='PAGE NOT FOUND',
        subtitle='THE PAGE YOU ARE LOOKING FOR DOES NOT EXIST OR HAS BEEN MOVED'), 404

# Safety net: rollback dirty DB sessions on unhandled exceptions.
# Without this, a failed db.session.commit() leaves the session in an invalid
# state, causing cascading 500 errors on all subsequent requests in that thread.
@app.teardown_appcontext
def shutdown_session(exception=None):
    if exception:
        db.session.rollback()
    db.session.remove()

@app.before_request
def _assign_csp_nonce():
    if request.path == '/static/cli.sh':
        return 'CLI bootstrap script not available', 404
    g.csp_nonce = secrets.token_hex(16)


@app.context_processor
def _inject_csp_nonce():
    return {'csp_nonce': getattr(g, 'csp_nonce', '')}


# Log requests with real client IP
# C0/C1 control characters plus the Unicode line/paragraph separators and NEL
# -- every one of them can split a line in a downstream log pipeline.
_LOG_UNSAFE_CHARS = frozenset({'\x7f', '\x85', '\u2028', '\u2029'})


def _log_safe(value):
    """Neutralise CR/LF and other control characters in client-controlled text
    before it is interpolated into a log line.

    AUDIT FIX (log forgery): folder names and API-key labels are attacker-
    chosen strings. A name containing '\\r\\n' split the emitted line in two,
    so journald/syslog recorded a forged follow-up line (fake '[ADMIN]'/
    '[API]' entries) that a later reader would take for real application
    output. Control characters are replaced with a space -- the visual length
    of the message is preserved and NOTHING that is not control noise is
    touched, so an operator can still recognise the offending value."""
    text = value if isinstance(value, str) else str(value)
    return ''.join(
        ' ' if (ch < ' ' or ch in _LOG_UNSAFE_CHARS) else ch for ch in text)


@app.after_request
def log_request_info(response):
    """Log each request with the real client IP for reverse proxy environments."""
    # Only log non-static, non-trivial requests
    if not request.path.startswith('/static/'):
        ip = get_real_ip()
        print(f'[REQUEST] {ip} {request.method} {request.path} -> {response.status_code}')
    # Static file caching: 1 year TTL (cache-busted by ?v=hash query param)
    if request.path.startswith('/static/'):
        # Only real assets are immutable; a 404 must not be pinned for a year.
        response.headers['Cache-Control'] = (
            'public, max-age=31536000, immutable' if response.status_code < 400 else 'no-store')
    elif 'Cache-Control' not in response.headers:
        # AUDIT FIX (residual): dynamic pages/API responses carried NO
        # Cache-Control at all, so browsers (and any shared/forward proxy in
        # front of the app) were free to heuristically cache authenticated,
        # per-user HTML and JSON. A shared cache could then serve one user's
        # drive listing, share page or API payload to the next requester.
        # Every route that deliberately picks its own policy (downloads
        # 'no-cache, no-store', thumbnails/previews 'private, max-age=...',
        # static assets above) already set the header and is left untouched --
        # this only fills the gap for responses that never set one, and it is
        # deliberately limited to HTML/JSON so media, range/download and
        # conditional-request semantics are unchanged.
        if response.mimetype in ('text/html', 'application/json'):
            response.headers['Cache-Control'] = 'no-store, private'
    # Security headers
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    # AUDIT FIX (residual): X-Frame-Options said SAMEORIGIN while the CSP said
    # frame-ancestors 'none'. Modern browsers honour the CSP directive and
    # IGNORE X-Frame-Options when both are present, so the stricter of the two
    # won -- which broke the app's own same-origin framing (the prepared-
    # download page drives its download through a hidden same-origin iframe,
    # see templates/preparing_download.html) while X-Frame-Options claimed it
    # was allowed. 'self' keeps cross-origin framing blocked exactly as
    # before and makes the two headers agree.
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    _csp_nonce = getattr(g, 'csp_nonce', '') or ''
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        f"script-src 'self' 'nonce-{_csp_nonce}'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "connect-src 'self'; "
        "worker-src 'self'; "
        "frame-src 'self' blob:; "
        "frame-ancestors 'self'; "
        "form-action 'self'; "
        "object-src 'none'; "
        "base-uri 'self'"
    )
    # HSTS: instruct browsers to only connect over HTTPS for the next year.
    # includeSubDomains and preload are omitted intentionally — those require
    # operator opt-in and careful consideration of all subdomains.
    response.headers['Strict-Transport-Security'] = 'max-age=31536000'
    return response

# Default storage limit for registered users
DEFAULT_USER_STORAGE_GB = float(os.environ.get('DEFAULT_USER_STORAGE_GB', '50.0'))

