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
app.config['MAX_RETENTION'] = timedelta(days=7)

# Upload processing progress tracking
# Tracks server-side processing progress (encryption, zipping) per upload
# so the frontend can poll for status updates during the processing phase.
# Uses file-based storage in the temp dir so progress is shared across Gunicorn
# workers. Temp paths carry a tag derived from basedir: PROD and DEV share one
# host and must never share (or clean up) each other's progress/work files.
import threading

_APP_TMP_TAG = hashlib.sha256(basedir.encode('utf-8')).hexdigest()[:12]
_PROGRESS_DIR = os.path.join(tempfile.gettempdir(), f'fileshare_progress_{_APP_TMP_TAG}')
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
ONEGY_TEMP_ROOT = os.path.join(tempfile.gettempdir(), f'onegy_work_{_APP_TMP_TAG}')
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

app.jinja_env.filters['filesize'] = format_bytes_for_filesize
app.jinja_env.filters['b64encode'] = lambda data: base64.b64encode(data).decode('ascii') if data else ''
app.jinja_env.globals['get_compound_ext'] = _get_compound_ext
app.jinja_env.globals['split_name_ext'] = _split_name_ext

def _utc_aware(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

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
    if TRUSTED_PROXY_HOPS > 0 and TRUST_CDN_HEADERS and 'werkzeug.proxy_fix.orig' in request.environ:
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
    if request.is_json or request.path.startswith('/apiv1/'):
        return jsonify({'error': 'REQUEST BODY TOO LARGE', 'code': 'bad_request'}), 413
    flash(f'FILE TOO LARGE. MAXIMUM UPLOAD SIZE IS {max_gb}GB.', 'error')
    return _safe_referrer_redirect()

# Rate limit exceeded error handler
@app.errorhandler(429)
def ratelimit_handler(e):
    """JSON for XHR; branded 429 page for browser navigations (never bounce to /)."""
    ip = get_real_ip()
    print(f'[RATELIMIT] {ip} {request.method} {_log_safe_path(request.path)} - Rate limit exceeded: {e.description}')
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest' or request.is_json:
        return jsonify({'error': 'TOO MANY REQUESTS. PLEASE SLOW DOWN.', 'retry_after': e.description}), 429
    return render_template('notfound.html',
        error_code='4',
        error_code_mid='2',
        error_code_end='9',
        title='TOO MANY REQUESTS',
        subtitle='PLEASE SLOW DOWN AND TRY AGAIN IN A MOMENT'), 429

@app.errorhandler(CSRFError)
def csrf_error_handler(e):
    """JSON for XHR/JSON callers so the frontend can show the error; HTML otherwise."""
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest' or request.is_json:
        return jsonify({'error': 'SECURITY TOKEN MISSING OR EXPIRED. PLEASE REFRESH THE PAGE AND TRY AGAIN.'}), 400
    return e

# 404 Not Found error handler
@app.errorhandler(404)
def page_not_found(e):
    """Return branded 404 page for all not-found errors"""
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest' or (request.content_type and 'application/json' in request.content_type):
        return jsonify({'error': 'NOT FOUND'}), 404
    return render_template('notfound.html',
        title='PAGE NOT FOUND',
        subtitle='THE PAGE YOU ARE LOOKING FOR DOES NOT EXIST OR HAS BEEN MOVED'), 404

# 403 Forbidden: branded page instead of the bare Werkzeug one (e.g. /manage/<token> opened by a non-owner)
@app.errorhandler(403)
def forbidden(e):
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest' or request.is_json:
        return jsonify({'error': 'FORBIDDEN'}), 403
    return render_template('notfound.html',
        error_code='4',
        error_code_mid='0',
        error_code_end='3',
        title='ACCESS DENIED',
        subtitle='YOU DO NOT HAVE PERMISSION TO VIEW THIS PAGE. SIGN IN WITH THE ACCOUNT THAT OWNS IT'), 403

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


# Endpoints that legitimately take large bodies and bound them themselves
# (_set_request_upload_cap, or the notes JSON limits in _load_notes_json_request).
_LARGE_BODY_ENDPOINTS = frozenset({
    'upload', 'apiv1_upload',
    'apiv1_sync_upload_file', 'apiv1_sync_upload_part',
    'make_file_public', 'make_file_private',
    'file_create_blank', 'file_save_content',
    'notes_create_note', 'notes_update_note', 'notes_send_to_user',
})
_DEFAULT_REQUEST_BODY_CAP = 2 * 1024 * 1024  # _set_request_upload_cap adds 10 MiB framing headroom


def _cap_small_request_body():
    """Every other endpoint only parses small JSON/form bodies: bound them so
    get_json()/get_data()/form parsing cannot buffer up to MAX_CONTENT_LENGTH."""
    if request.endpoint not in _LARGE_BODY_ENDPOINTS:
        _set_request_upload_cap(_DEFAULT_REQUEST_BODY_CAP)


# Must run first: CSRFProtect's hook (registered in 010) already parses request.form.
app.before_request_funcs.setdefault(None, []).insert(0, _cap_small_request_body)


@app.context_processor
def _inject_csp_nonce():
    return {'csp_nonce': getattr(g, 'csp_nonce', '')}


# Log requests with real client IP
# C0/C1 control characters plus the Unicode line/paragraph separators
# -- every one of them can split a line in a downstream log pipeline.
_LOG_UNSAFE_RE = re.compile('[\x00-\x1f\x7f-\x9f\u2028\u2029]')
# Path segments whose NEXT segment is a bearer token (same rule as
# gunicorn.conf.py's access-log redaction).
_LOG_TOKEN_PATH_PREFIXES = frozenset((
    'f', 's', 'manage', 'delete', 'manage-data-by-token', 'prepared', 'progress'))


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
    return _LOG_UNSAFE_RE.sub(' ', text)


def _log_safe_path(path):
    """Request path for log lines: bearer tokens redacted, controls neutralised."""
    segments = str(path or '').split('/')
    for i in range(len(segments) - 1):
        if segments[i] in _LOG_TOKEN_PATH_PREFIXES and segments[i + 1]:
            segments[i + 1] = '[REDACTED]'
    return _log_safe('/'.join(segments))


@app.after_request
def log_request_info(response):
    """Log each request with the real client IP for reverse proxy environments."""
    # Only log non-static, non-trivial requests (every open page polls /api/build)
    if not request.path.startswith('/static/') and request.path != '/api/build':
        ip = get_real_ip()
        print(f'[REQUEST] {ip} {request.method} {_log_safe_path(request.path)} -> {response.status_code}')
    # Static file caching: 1 year TTL (cache-busted by ?v=hash query param)
    if request.path.startswith('/static/'):
        # Only real assets are immutable; a 404 must not be pinned for a year,
        # nor today's file under another build's ?v= (a page loaded just before
        # a promote, or a rollback that makes that ?v= current again).
        v = request.args.get('v')
        current = not v or v == _static_hashes.get(request.path[len('/static/'):])
        response.headers['Cache-Control'] = (
            'public, max-age=31536000, immutable' if response.status_code < 400 and current else 'no-store')
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
    _csp = (
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
    # User content opened from /file/<id>/preview runs in an opaque origin.
    # Chrome refuses to render a sandboxed PDF, so PDFs keep the plain policy.
    if request.endpoint == 'file_preview' and response.mimetype != 'application/pdf':
        _csp += '; sandbox'
    response.headers['Content-Security-Policy'] = _csp
    # HSTS: instruct browsers to only connect over HTTPS for the next year.
    # includeSubDomains and preload are omitted intentionally — those require
    # operator opt-in and careful consideration of all subdomains.
    response.headers['Strict-Transport-Security'] = 'max-age=31536000'
    return response

# Default storage limit for registered users
DEFAULT_USER_STORAGE_GB = float(os.environ.get('DEFAULT_USER_STORAGE_GB', '50.0'))
