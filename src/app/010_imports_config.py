import os
import uuid
import io
import time
import json
import zipfile
import subprocess
import tempfile
import shutil
import random
import secrets
import base64
import hashlib
import hmac
import re
import unicodedata
import urllib.parse
import functools
import click
import qrcode
import pyotp
import fcntl
from datetime import datetime, timedelta, timezone
from flask import Flask, request, render_template, redirect, url_for, abort, send_file, send_from_directory, flash, jsonify, session, make_response, g, has_app_context, has_request_context
from flask_sqlalchemy import SQLAlchemy
from cryptography.fernet import Fernet, MultiFernet
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
from apscheduler.schedulers.background import BackgroundScheduler
from flask.cli import with_appcontext
from flask_wtf.csrf import CSRFProtect, generate_csrf
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_compress import Compress
from sqlalchemy import MetaData, case, create_engine, event, inspect, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.orm.exc import StaleDataError, ObjectDeletedError

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))
import logging

app = Flask(__name__)

# HTTP response compression (gzip/brotli) -- reduces transfer sizes by 70-80%
app.config['COMPRESS_MIMETYPES'] = [
    'text/html', 'text/css', 'text/xml', 'text/plain',
    'application/javascript', 'application/json',
    'application/xml', 'image/svg+xml',
]
app.config['COMPRESS_MIN_SIZE'] = 256       # Don't compress tiny responses
app.config['COMPRESS_LEVEL'] = 6            # Balanced speed vs. compression ratio
Compress(app)

# ── Static file cache busting ─────────────────────────────────────────────
# Compute content hashes at startup for versioned static URLs.
# Templates use versioned_static('style.css') instead of url_for('static',...)
# which appends ?v=<hash8> for automatic cache busting on file changes.
_static_hashes = {}
_static_dir = os.path.join(os.path.dirname(__file__), 'static')
for _root, _dirs, _files in os.walk(_static_dir):
    for _fname in _files:
        _fpath = os.path.join(_root, _fname)
        _rel = os.path.relpath(_fpath, _static_dir).replace('\\', '/')
        try:
            _h = hashlib.md5()
            with open(_fpath, 'rb') as _fp:
                for _chunk in iter(lambda: _fp.read(65536), b''):
                    _h.update(_chunk)
            _static_hashes[_rel] = _h.hexdigest()[:8]
        except OSError:
            pass

def versioned_static(filename):
    """Return URL for a static file with cache-busting hash query parameter."""
    v = _static_hashes.get(filename, '')
    base_url = url_for('static', filename=filename)
    return f'{base_url}?v={v}' if v else base_url

app.jinja_env.globals['versioned_static'] = versioned_static

_secret_key = os.environ.get('SECRET_KEY', '')
if not _secret_key or _secret_key == 'devkey-change-me':
    import warnings as _warnings
    if (os.environ.get('FLASK_ENV') == 'testing'
            or (os.environ.get('TESTING', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')):
        # AUDIT FIX M12: NEVER fall back to a hardcoded constant. SECRET_KEY keys
        # the captcha HMAC, the opaque pre-login salt/version, the recovery-key
        # verifier and the share-access marker — a publicly known constant makes
        # all of them forgeable by anyone who can read this file. A stray
        # TESTING=1 in production used to be enough to turn that on. Generate a
        # random per-process key instead: still usable for a single-process test
        # run, but worthless to an attacker and unusable across restarts.
        _secret_key = secrets.token_urlsafe(64)
        print('[WARNING] SECRET_KEY is unset/default and TESTING/FLASK_ENV=testing is set — '
              'using a RANDOM PER-PROCESS SECRET_KEY. Sessions, captchas and share unlocks '
              'will NOT survive a restart and will NOT work across workers. '
              'Set a strong SECRET_KEY before running anything but a throwaway test process.')
    else:
        _warnings.warn(
            'SECRET_KEY is not set or is the insecure default. '
            'Set a strong SECRET_KEY environment variable before running in production.',
            stacklevel=2
        )
        raise RuntimeError('SECRET_KEY must be set to a strong non-default value before starting the app')
app.config['SECRET_KEY'] = _secret_key

# Session cookie security hardening
app.config['SESSION_COOKIE_SECURE'] = True      # Only send over HTTPS
app.config['SESSION_COOKIE_HTTPONLY'] = True     # Not accessible via JavaScript
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'   # Prevent CSRF via cross-site requests
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=6)

# Trust reverse proxy headers only when explicitly configured.
# Default DEV/standalone Gunicorn deployments terminate TLS directly and must NOT
# trust client-supplied X-Forwarded-* headers.
try:
    TRUSTED_PROXY_HOPS = max(0, int(os.environ.get('TRUSTED_PROXY_HOPS', '0') or '0'))
except ValueError:
    TRUSTED_PROXY_HOPS = 0

if TRUSTED_PROXY_HOPS > 0:
    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=TRUSTED_PROXY_HOPS,
        x_proto=TRUSTED_PROXY_HOPS,
        x_host=TRUSTED_PROXY_HOPS,
    )

# Force HTTPS: redirect HTTP requests to HTTPS.
# SESSION_COOKIE_SECURE=True requires HTTPS — without this redirect, users arriving
# via HTTP get no session cookie, causing CSRF failures and broken auth.
# ProxyFix above ensures request.scheme reflects the real protocol from X-Forwarded-Proto.
#
# 308 preserves the request method and body, unlike 301/302/303.
# TLS-terminating proxies must forward X-Forwarded-Proto and configure
# TRUSTED_PROXY_HOPS correctly to avoid redirect loops.
# Explicit configuration: FORCE_HTTPS=0|false|no|off disables the upgrade
# entirely (plain-HTTP deployments/testing); any other value (or unset) keeps
# the historical always-on default.
_FORCE_HTTPS_RAW = (os.environ.get('FORCE_HTTPS', '') or '').strip().lower()
FORCE_HTTPS = _FORCE_HTTPS_RAW not in ('0', 'false', 'no', 'off')


@app.before_request
def force_https():
    if not FORCE_HTTPS or request.scheme != 'http':
        return None
    target = request.full_path if request.query_string else request.path
    url = f'https://{domain}{target}'
    return redirect(url, code=308)

# Initialize CSRF Protection
csrf = CSRFProtect(app)
# Disable automatic form rendering, we'll add input manually
app.config['WTF_CSRF_CHECK_DEFAULT'] = True
app.config['WTF_CSRF_HEADERS'] = ['X-CSRFToken', 'X-CSRF-Token']

def _rate_limit_session_is_live():
    try:
        return _current_session_user() is not None
    except Exception:
        return False


# Dynamic rate limits: higher limits for logged-in users
def upload_rate_limit():
    """Return higher upload rate limit for logged-in users"""
    if _rate_limit_session_is_live():
        return "1000 per minute"
    return "30 per minute"

def download_rate_limit():
    """Return higher download rate limit for logged-in users"""
    if _rate_limit_session_is_live():
        return "2000 per minute"
    return "60 per minute"

def thumbnail_rate_limit():
    """Return higher thumbnail rate limit for logged-in users"""
    if _rate_limit_session_is_live():
        return "60000 per minute"
    return "4000 per minute"

def _count_uncached_thumbnail(response):
    return response.status_code != 304

def default_rate_limit():
    """Return higher default rate limit for logged-in users"""
    if _rate_limit_session_is_live():
        return "3000 per minute"
    return "200 per minute"

def folder_ops_rate_limit():
    """Return higher rate limit for folder operations for logged-in users"""
    if _rate_limit_session_is_live():
        return "600 per minute"
    return "20 per minute"

def file_ops_rate_limit():
    """Return higher rate limit for file management operations for logged-in users"""
    if _rate_limit_session_is_live():
        return "600 per minute"
    return "20 per minute"

def search_rate_limit():
    """Return higher rate limit for search for logged-in users"""
    if _rate_limit_session_is_live():
        return "300 per minute"
    return "30 per minute"

def admin_rate_limit():
    """Return higher rate limit for admin operations"""
    if _rate_limit_session_is_live():
        return "300 per minute"
    return "10 per minute"

def music_api_rate_limit():
    """Return higher rate limit for music catalog API endpoints for logged-in users (3x)"""
    if _rate_limit_session_is_live():
        return "90 per minute"
    return "30 per minute"

def music_detail_rate_limit():
    """Return higher rate limit for music detail/search/playlist endpoints for logged-in users (3x)"""
    if _rate_limit_session_is_live():
        return "180 per minute"
    return "60 per minute"

def music_stream_rate_limit():
    """Return higher rate limit for music streaming/playback endpoints for logged-in users (3x)"""
    if _rate_limit_session_is_live():
        return "360 per minute"
    return "120 per minute"

def music_cover_rate_limit():
    """Return higher rate limit for music cover art endpoints for logged-in users (3x)"""
    if _rate_limit_session_is_live():
        return "600 per minute"
    return "200 per minute"

# Rate limit bypass for automated testing (set via env var)
RATELIMIT_BYPASS_KEY = os.environ.get('RATELIMIT_BYPASS_KEY', '')
ALLOW_LOGIN_LOCKOUT_BYPASS = os.environ.get('ALLOW_LOGIN_LOCKOUT_BYPASS', '').strip().lower() in ('1', 'true', 'yes')


def _compute_ratelimit_bypass_allowed():
    """AUDIT FIX M13: possessing RATELIMIT_BYPASS_KEY must NOT be sufficient.

    The header previously skipped EVERY limiter (including 10/min on /login) and
    also disabled the per-username login lockout, so a single leak of the key
    from CI, a test fixture or a shell history turned the app into an
    unthrottled credential-stuffing target. The bypass now additionally requires
    an explicit NON-PRODUCTION deployment signal that an external attacker
    cannot supply:

      * TESTING / FLASK_ENV=testing|development, or
      * ALLOW_RATELIMIT_BYPASS=1 (explicit operator opt-in), or
      * the app is running from a *_DEV working directory, or
      * DOMAIN is a dev/localhost host.

    A DEV deployment (a *_DEV directory, DOMAIN=dev.<domain>) matches on the
    last two, so testsv2 keeps working unchanged. Production matches none of
    them, so the header is inert there even if the key leaks.
    """
    # AUDIT FIX: os.environ.get('TESTING') is truthy for ANY non-empty value,
    # including TESTING='0' / 'false' — spellings operators use to mean "off".
    # That silently re-enabled the whole bypass chain. Only explicit truthy
    # spellings count as a testing signal; everything else falls through to the
    # remaining (independently checked) signals below.
    _testing_env = (os.environ.get('TESTING', '') or '').strip().lower()
    if _testing_env in ('1', 'true', 'yes', 'on'):
        return True, 'TESTING env var'
    if (os.environ.get('FLASK_ENV', '') or '').strip().lower() in ('testing', 'development'):
        return True, 'FLASK_ENV'
    if (os.environ.get('ALLOW_RATELIMIT_BYPASS', '') or '').strip().lower() in ('1', 'true', 'yes'):
        return True, 'ALLOW_RATELIMIT_BYPASS env var'
    _app_dir = os.path.basename(os.path.abspath(os.path.dirname(__file__)))
    if _app_dir.lower().endswith('_dev'):
        return True, f'non-production app directory ({_app_dir})'
    _domain_hint = (os.environ.get('DOMAIN', '') or '').strip().lower()
    if _domain_hint.startswith('dev.') or _domain_hint.startswith('localhost') or _domain_hint.startswith('127.0.0.1'):
        return True, f'non-production DOMAIN ({_domain_hint})'
    return False, None


RATELIMIT_BYPASS_ALLOWED, _RATELIMIT_BYPASS_REASON = _compute_ratelimit_bypass_allowed()

if RATELIMIT_BYPASS_KEY and RATELIMIT_BYPASS_ALLOWED:
    print(f'[WARNING] X-RateLimit-Bypass header is ACTIVE (reason: {_RATELIMIT_BYPASS_REASON}). '
          'Anyone holding RATELIMIT_BYPASS_KEY can skip every rate limit on this instance. '
          'This MUST NOT be true in production.')
elif RATELIMIT_BYPASS_KEY:
    print('[AUTH] RATELIMIT_BYPASS_KEY is set but the bypass is DISABLED '
          '(no non-production signal). The X-RateLimit-Bypass header will be ignored.')

# Keep the configured backend untouched. memory:// remains the only safe default
# when no external rate-limit service is guaranteed to exist.
RATELIMIT_STORAGE_URI = os.environ.get('RATELIMIT_STORAGE_URI', 'memory://').strip() or 'memory://'

# AUDIT FIX H2: warn loudly when running with multiple Gunicorn workers and
# memory:// rate-limit storage. The per-worker counters fragment so the
# effective rate-limit cap is multiplied by worker count, undermining
# brute-force defenses. Don't crash — just warn so the operator sees it.
try:
    _gunicorn_workers_announced = int(os.environ.get('GUNICORN_WORKERS', '1'))
except ValueError:
    _gunicorn_workers_announced = 1
if _gunicorn_workers_announced > 1 and RATELIMIT_STORAGE_URI.lower().startswith('memory'):
    print('[WARNING] GUNICORN_WORKERS>1 with RATELIMIT_STORAGE_URI=memory:// — '
          'rate-limit counters are per-worker and will fragment across processes. '
          'Set RATELIMIT_STORAGE_URI to a shared backend for accurate generic limits. '
          'Application login, 2FA, captcha, share-password and folder-ticket checks '
          'remain cross-worker authoritative.')

# Thumbnail HTTP cache max-age in seconds (default: 15 minutes)
THUMBNAIL_CACHE_MAX_AGE = int(os.environ.get('THUMBNAIL_CACHE_MAX_AGE', '900'))

# Initialize Rate Limiter
# AUDIT FIX: the key_func used to be get_remote_address (IP only) for every
# caller. Two problems this fixes, without adding any new infrastructure:
#   1. Every user behind one NAT/proxy shared ONE bucket, so one noisy client
#      starved everyone egressing from the same address.
#   2. An authenticated attacker keyed on IP could rotate addresses to reset
#      their budget on authenticated endpoints.
# The key is now the signed session's user id when present, else the client
# IP. The session cookie is signed with SECRET_KEY so the id cannot be forged,
# and this reads NO database (it runs on every limited request). Anonymous
# callers keep the historical IP key, so guest limits are unchanged.
#
# Cross-worker coherence (AUDIT FIX H2, see the warning below): the default
# RATELIMIT_STORAGE_URI is memory://, whose counters are per-process. This
# deployment runs GUNICORN_WORKERS=1 (gthread, 8 threads), so memory:// IS
# process-wide and authoritative here — no Redis (or any other service) is
# required. CONDITIONAL deployment note: only if an operator actually scales
# GUNICORN_WORKERS above 1 must RATELIMIT_STORAGE_URI point at a shared
# backend of their choice (e.g. redis:// when available) — the code does not
# require one, and the app-level username/TOTP/captcha/lockout counters are
# file-backed under instance/locks and stay cross-worker authoritative
# regardless of this setting.
def _rate_limit_key():
    try:
        uid = session.get('logged_in_user_id')
        if uid is not None and uid != '':
            return f'user:{uid}'
    except Exception:
        pass
    return f'ip:{get_remote_address()}'

limiter = Limiter(
    app=app,
    key_func=_rate_limit_key,
    default_limits=[default_rate_limit],
    storage_uri=RATELIMIT_STORAGE_URI,
    strategy="fixed-window",
    headers_enabled=True,  # Return X-RateLimit headers to clients
)

@limiter.request_filter
def _ratelimit_request_filter():
    """Return True to SKIP rate limiting for this request."""
    # AUDIT FIX M7: constant-time comparison to eliminate timing oracle on
    # the bypass key. A short-circuit `==` leaks the byte-by-byte match
    # progress over network jitter; hmac.compare_digest is constant-time.
    # AUDIT FIX M13: the key alone is no longer enough — the deployment must also
    # carry an explicit non-production signal (see _compute_ratelimit_bypass_allowed).
    if RATELIMIT_BYPASS_KEY and RATELIMIT_BYPASS_ALLOWED:
        import hmac as _hmac_rl_bypass
        provided = request.headers.get('X-RateLimit-Bypass', '') or ''
        if _hmac_rl_bypass.compare_digest(provided.encode('utf-8'), RATELIMIT_BYPASS_KEY.encode('utf-8')):
            return True
    return False

