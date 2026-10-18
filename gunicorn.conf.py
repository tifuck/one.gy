"""Gunicorn configuration for ONE.GY file sharing server.

Optimized for handling large file uploads (up to 10GB) with server-side
Fernet encryption. The Flask dev server cannot handle multi-GB uploads
reliably due to Werkzeug's 64KB multipart read buffer and lack of socket
tuning, causing TCP resets (NS_ERROR_NET_RESET) on large transfers.
"""
import os
import multiprocessing
from dotenv import load_dotenv

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))

# --- Bind ---
bind_host = os.environ.get('BIND_HOST', '0.0.0.0')
web_port = os.environ.get('WEB_PORT', '5000')
bind = f'{bind_host}:{web_port}'

# --- SSL ---
certfile = os.path.join(basedir, 'cert.pem')
keyfile = os.path.join(basedir, 'key.pem')

# --- Workers ---
# gthread worker class: threaded workers handle concurrent uploads without
# blocking each other. sync workers would block the entire worker during
# multi-minute encryption of large files.
worker_class = 'gthread'
workers = int(os.environ.get('GUNICORN_WORKERS', '1'))
threads = int(os.environ.get('GUNICORN_THREADS', '8'))

# --- Timeouts ---
# A 10GB upload at 10 MB/s = ~17 minutes transfer, plus up to 30 minutes
# for Fernet encryption = ~47 minutes. Set timeout generously.
# This is the max time a worker can be silent (no response sent) before
# being killed. Must cover: upload transfer + encryption + zip + disk I/O.
timeout = 7200  # 2 hours - covers worst case 10GB upload on slow connection + encryption
graceful_timeout = 300  # 5 minutes for worker to finish after SIGTERM

# --- Request limits ---
# No limit on request line or header size beyond defaults
limit_request_line = 8190
limit_request_field_size = 8190

# --- Logging ---
accesslog = '-'  # stdout
errorlog = '-'   # stderr
loglevel = 'info'

# --- Access-log token redaction (AUDIT OPS FIX 5) -------------------------------
# The default access format logs "%(r)s" (method + RAW_URI + protocol), which
# would write bearer credentials straight into journald:
#   * share/manage/delete tokens in the path (/f/<token>, /manage/<token>,
#     /delete/<token>, /file/manage-data-by-token/<token>), and
#   * secrets in query strings (?token=..., ?password=..., opaque 16+ char
#     values), plus tokens echoed in the Referer atom.
# A token in these URLs grants access to the shared resource, so logs become a
# second credential store. gunicorn has no format-string escape for this, so a
# custom Logger subclass redacts RAW_URI / PATH_INFO / QUERY_STRING /
# HTTP_REFERER *before* the atoms are built. Every other access-log field
# (method, status, bytes, timings, user-agent) is preserved, and `errorlog`
# (operational logs) is completely untouched. If redaction itself ever fails,
# the line is logged only with inert fields (fail closed — never a raw URI).
import re as _re
from urllib.parse import unquote_plus as _unquote_plus

from gunicorn.glogging import Logger as _GunicornLogger

_REDACTED = '[REDACTED]'
# Query keys whose VALUE is always redacted (substring/anchor match, case-insensitive).
_SENSITIVE_QKEY = _re.compile(
    r'(?i)(token|secret|password|passwd|apikey|api[_-]?key|session'
    r'|^key$|^auth$|^code$|^pw$|^pass$|^otp$|nonce|^sig$|^hash$)')
# Opaque random-looking values (share ids, tokens) even under an innocent key.
_TOKENISH_VALUE = _re.compile(r'^[A-Za-z0-9_\-]{16,}$')
# Path segments whose NEXT segment is a bearer token.
_TOKEN_PATH_PREFIXES = frozenset(('f', 'manage', 'delete', 'manage-data-by-token'))


def redact_query_string(query):
    """Redact sensitive and token-like values, keeping key names visible."""
    if not query:
        return query or ''
    parts = []
    for part in str(query).split('&'):
        if not part:
            parts.append(part)
            continue
        key, sep, value = part.partition('=')
        if not sep:
            # Bare parameter (no '='): redact only if it looks like a token.
            parts.append(_REDACTED if _TOKENISH_VALUE.match(_unquote_plus(part)) else part)
            continue
        # Match on the DECODED key/value: '%70assword' is 'password' to the app.
        if _SENSITIVE_QKEY.search(_unquote_plus(key)) or _TOKENISH_VALUE.match(_unquote_plus(value)):
            parts.append(f'{key}={_REDACTED}')
        else:
            parts.append(part)
    return '&'.join(parts)


def redact_uri(uri):
    """Redact token-bearing path segments and query values of a request URI.
    Also safe on absolute URIs (e.g. Referer)."""
    if not uri:
        return uri or ''
    try:
        path, sep, query = str(uri).partition('?')
        segments = path.split('/')
        for i in range(len(segments) - 1):
            if segments[i] in _TOKEN_PATH_PREFIXES and segments[i + 1]:
                segments[i + 1] = _REDACTED
        redacted = '/'.join(segments)
        if sep:
            redacted = f'{redacted}?{redact_query_string(query)}'
        return redacted
    except Exception:
        # Fail closed: better to lose the URI than to log a token.
        return _REDACTED


def redact_environ(environ):
    """Shallow copy of the WSGI environ with every token-bearing field redacted."""
    out = dict(environ)
    for key in ('RAW_URI', 'PATH_INFO', 'HTTP_REFERER'):
        if key in out:
            out[key] = redact_uri(out.get(key))
    if 'QUERY_STRING' in out:
        out['QUERY_STRING'] = redact_query_string(out.get('QUERY_STRING'))
    return out


class _RedactingAccessLogger(_GunicornLogger):
    """Access logger that never writes bearer tokens to the log."""

    def access(self, resp, req, environ, request_time):
        try:
            environ = redact_environ(environ)
        except Exception:
            # Fail closed: keep only the inert fields rather than a raw URI.
            try:
                environ = {k: v for k, v in dict(environ).items()
                           if k in ('REQUEST_METHOD', 'SERVER_PROTOCOL', 'REMOTE_ADDR')}
                environ['RAW_URI'] = _REDACTED
                environ['PATH_INFO'] = _REDACTED
                environ['QUERY_STRING'] = _REDACTED
            except Exception:
                return  # drop this one line rather than leak a token
        super().access(resp, req, environ, request_time)


logger_class = _RedactingAccessLogger

# --- Server hooks ---
def on_starting(server):
    """Generate self-signed SSL certificate if not present."""
    if not os.path.exists(certfile) or not os.path.exists(keyfile):
        import subprocess
        print('[GUNICORN] Generating self-signed SSL certificate...')
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:4096',
            '-keyout', keyfile,
            '-out', certfile,
            '-days', '365',
            '-nodes',
            '-subj', '/CN=localhost'
        ], check=True)
        try:
            os.chmod(keyfile, 0o600)
        except OSError:
            pass
        print(f'[GUNICORN] SSL certificate created: {certfile}, {keyfile}')

def post_fork(server, worker):
    """Initialize worker-local storage and start the scheduler failover watchdog
    in EVERY worker.

    AUDIT FIX H2: the old design grabbed an flock here and ran the scheduler only
    in the lock-holding worker. flock releases only when the owning PROCESS
    EXITS, so a worker that HUNG (deadlocked scheduler thread, wedged DB/SSH
    socket) but stayed alive kept the lock forever and no other worker took over
    — all background jobs silently stopped with no failover. Leader election now
    lives inside start_scheduler()'s watchdog thread, which uses a DB heartbeat
    lease (detects hangs) plus the flock (instant failover on clean death). Every
    worker runs the watchdog; exactly one wins the lease and runs the scheduler."""
    try:
        from app import app, storage
        with app.app_context():
            storage.init()
        print(f'[GUNICORN] Worker {worker.pid} initialized storage')
    except Exception as e:
        print(f'[GUNICORN] Worker {worker.pid} storage init failed: {e}')
        raise

    try:
        from app import start_scheduler
        start_scheduler()
        print(f'[GUNICORN] Worker {worker.pid} started scheduler failover watchdog')
    except Exception as e:
        print(f'[GUNICORN] Worker {worker.pid} failed to start scheduler watchdog: {e}')
        raise

def post_worker_init(worker):
    """Wrap the worker's SIGTERM handler so APScheduler is stopped cleanly the
    moment a graceful shutdown begins — BEFORE the interpreter tears down
    concurrent.futures' thread pool.

    Why here and not post_fork: gunicorn installs its own signal handlers in
    Worker.init_process() -> init_signals(), which runs AFTER post_fork but
    BEFORE post_worker_init. Wrapping in post_fork would be overwritten.

    Why SIGTERM specifically: on graceful stop (systemd restart) gunicorn's
    handle_exit only sets alive=False with no worker-side callback, so the
    daemon BackgroundScheduler thread keeps firing the 10s replication/scrub
    jobs during teardown -> a burst of 'cannot schedule new futures after
    shutdown' tracebacks (seen in PROD on Jun 27). SIGINT/SIGQUIT already route
    through handle_quit -> worker_int (handled below)."""
    import signal
    try:
        from app import shutdown_scheduler_for_exit
    except Exception as e:
        print(f'[GUNICORN] Worker {worker.pid} scheduler shutdown hook unavailable: {e}')
        return
    try:
        _gunicorn_sigterm = signal.getsignal(signal.SIGTERM)
        def _sigterm_with_scheduler_stop(signum, frame):
            try:
                shutdown_scheduler_for_exit('SIGTERM')
            except Exception:
                pass
            if callable(_gunicorn_sigterm):
                return _gunicorn_sigterm(signum, frame)
        signal.signal(signal.SIGTERM, _sigterm_with_scheduler_stop)
        # Preserve gunicorn's behavior: SIGTERM must NOT interrupt active request
        # syscalls (e.g. multi-GB uploads). signal.signal() can reset this, so
        # re-apply siginterrupt(False) exactly as init_signals() does.
        try:
            signal.siginterrupt(signal.SIGTERM, False)
        except Exception:
            pass
        print(f'[GUNICORN] Worker {worker.pid} installed scheduler-aware SIGTERM handler')
    except Exception as e:
        print(f'[GUNICORN] Worker {worker.pid} could not wrap SIGTERM handler: {e}')

def worker_int(worker):
    """SIGINT/SIGQUIT path: gunicorn calls this from handle_quit before the
    worker exits. Stop the scheduler here too so the same teardown race is
    avoided on those signals."""
    try:
        from app import shutdown_scheduler_for_exit
        shutdown_scheduler_for_exit('worker_int')
    except Exception as e:
        try:
            print(f'[GUNICORN] Worker {worker.pid} worker_int scheduler stop failed: {e}')
        except Exception:
            pass
