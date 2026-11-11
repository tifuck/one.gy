# Authentication decorators for security
from functools import wraps

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        is_ajax = request.headers.get('X-Requested-With') == 'XMLHttpRequest'
        if 'logged_in_user_id' not in session:
            if is_ajax:
                return jsonify({'error': 'SESSION_EXPIRED', 'redirect': url_for('login')}), 401
            flash('PLEASE LOGIN TO ACCESS THIS PAGE', 'error')
            return redirect(url_for('login'))
        # AUDIT FIX M14: reject a session that was explicitly revoked by /logout.
        revoked = _is_session_revoked()
        if revoked is _REVOCATION_CHECK_FAILED:
            if is_ajax:
                return jsonify({'error': 'SERVICE TEMPORARILY UNAVAILABLE. PLEASE TRY AGAIN.'}), 503
            return 'SERVICE TEMPORARILY UNAVAILABLE. PLEASE TRY AGAIN.', 503
        if revoked:
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
        if int(session.get('session_epoch', 0) or 0) != int(user.session_epoch or 0) or not _session_device_ok():
            session.clear()
            if is_ajax:
                return jsonify({'error': 'SESSION_EXPIRED', 'redirect': url_for('login')}), 401
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))
        session.permanent = True
        return f(*args, **kwargs)
    return decorated_function

# ────────────────────────────────────────────────────────────────────
# AUDIT FIX M14: per-session revocation (see the RevokedSession model)
# ────────────────────────────────────────────────────────────────────
# Process-local positive cache of revoked sid hashes; misses always consult the
# shared DB authority so every worker observes logout. Each entry is kept until
# no cookie it could match can still be valid (one session lifetime after it was
# last seen revoked) and is then evicted by the cleanup_job refresh.
_revoked_sid_cache = set()
_revoked_sid_expiry = {}  # sid_hash -> time.time() after which it may be evicted
_revoked_sid_lock = threading.Lock()
_revoked_sid_loaded = False
# Truthy, so callers that only test truthiness still fail closed.
_REVOCATION_CHECK_FAILED = object()


def _hash_session_sid(sid):
    return hashlib.sha256(str(sid).encode('utf-8')).hexdigest()


def _remember_revoked_sid_locked(sid_hash, now):
    """Caller must hold _revoked_sid_lock."""
    _revoked_sid_cache.add(sid_hash)
    _revoked_sid_expiry[sid_hash] = now + app.config['PERMANENT_SESSION_LIFETIME'].total_seconds()


def _load_revoked_sids(force=False):
    """Merge active DB revocations into the process-local positive cache."""
    global _revoked_sid_loaded
    with _revoked_sid_lock:
        if _revoked_sid_loaded and not force:
            return
    try:
        now = datetime.now(timezone.utc)
        rows = db.session.query(RevokedSession.sid_hash).filter(
            db.or_(RevokedSession.expires_at.is_(None), RevokedSession.expires_at > now)
        ).all()
        fresh = {r[0] for r in rows if r[0]}
    except Exception as e:
        # Table not created yet (pre `flask db-upgrade`) or a transient DB error.
        # Mark as loaded anyway so this is not retried on every single request;
        # cleanup_job force-refreshes every cycle.
        print(f'[AUTH] Warning: could not load revoked session ids: {e}')
        try:
            db.session.rollback()
        except Exception:
            pass
        with _revoked_sid_lock:
            _revoked_sid_loaded = True
        return
    now = time.time()
    with _revoked_sid_lock:
        for sid_hash in fresh:
            _remember_revoked_sid_locked(sid_hash, now)
        for sid_hash, expires in list(_revoked_sid_expiry.items()):
            if expires <= now:
                _revoked_sid_expiry.pop(sid_hash, None)
                _revoked_sid_cache.discard(sid_hash)
        _revoked_sid_loaded = True


def _revoked_session_table_is_missing(error):
    """True only for a pre-migration missing revoked_session table error."""
    original = getattr(error, 'orig', None)
    args = getattr(original, 'args', ())
    if args and args[0] == 1146:
        return 'revoked_session' in str(original).lower()
    message = str(original or error).lower()
    return 'revoked_session' in message and (
        'no such table' in message or "doesn't exist" in message
    )


def _is_session_revoked():
    """True if the CURRENT request's session id has been explicitly revoked.

    DB failures fail closed once the revocation table should exist, returning
    the truthy _REVOCATION_CHECK_FAILED so the auth decorators can answer 503
    instead of clearing a session that was never revoked. The one exception is
    an explicitly missing table while db-upgrade is creating the schema;
    treating that as revoked would make every request fail during the startup
    migration window.
    """
    sid = session.get('sid')
    if not sid:
        # Sessions minted before this change carry no sid. They stay valid
        # (no behaviour change) until their next login, which mints one.
        return False
    sid_hash = _hash_session_sid(sid)
    with _revoked_sid_lock:
        if sid_hash in _revoked_sid_cache:
            return True
    try:
        now = datetime.now(timezone.utc)
        revoked = db.session.query(RevokedSession.id).filter(
            RevokedSession.sid_hash == sid_hash,
            db.or_(RevokedSession.expires_at.is_(None), RevokedSession.expires_at > now),
        ).first() is not None
    except Exception as e:
        try:
            db.session.rollback()
        except Exception:
            pass
        if _revoked_session_table_is_missing(e):
            print(f'[AUTH] Warning: revoked-session table is not available during schema migration: {e}')
            return False
        print(f'[AUTH] Revoked-session authority check failed closed: {e}')
        return _REVOCATION_CHECK_FAILED
    if revoked:
        with _revoked_sid_lock:
            _remember_revoked_sid_locked(sid_hash, time.time())
    return revoked


def _mint_session_sid():
    """Assign a fresh per-session id. Call right after a successful login."""
    sid = secrets.token_urlsafe(24)
    session['sid'] = sid
    return sid


def _revoke_current_session():
    """Persist a revocation record for the CURRENT session id (logout)."""
    sid = session.get('sid')
    if not sid:
        return True
    sid_hash = _hash_session_sid(sid)
    with _revoked_sid_lock:
        _remember_revoked_sid_locked(sid_hash, time.time())
    try:
        if not RevokedSession.query.filter_by(sid_hash=sid_hash).first():
            db.session.add(RevokedSession(
                sid_hash=sid_hash,
                user_id=session.get('logged_in_user_id'),
                revoked_at=datetime.now(timezone.utc),
                expires_at=datetime.now(timezone.utc) + app.config['PERMANENT_SESSION_LIFETIME'],
            ))
            db.session.commit()
        return True
    except Exception as e:
        print(f'[AUTH] Failed to persist session revocation; revoking all account sessions: {e}')
        try:
            db.session.rollback()
            user_id = session.get('logged_in_user_id')
            if user_id is None:
                return False
            User.query.filter_by(id=user_id).update(
                {User.session_epoch: db.func.coalesce(User.session_epoch, 0) + 1},
                synchronize_session=False)
            db.session.commit()
            print(f'[AUTH] Revoked all sessions for user {user_id} after session revocation failure')
            return True
        except Exception as fallback_error:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[ERROR] Could not record server-side sign-out: {fallback_error}')
            return False


def _prune_revoked_sessions():
    """Drop revocation rows whose cookie could no longer be valid anyway, and
    refresh the process-local cache. Called from cleanup_job."""
    removed = 0
    try:
        now = datetime.now(timezone.utc)
        stale = RevokedSession.query.filter(
            RevokedSession.expires_at.isnot(None),
            RevokedSession.expires_at < now
        ).all()
        for row in stale:
            db.session.delete(row)
        removed = len(stale)
        if removed:
            db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f'[CLEANUP] Warning: revoked-session prune failed: {e}')
    _load_revoked_sids(force=True)
    if removed:
        print(f'[CLEANUP] Pruned {removed} expired session revocation record(s)')
    return removed


def _current_session_user():
    """Resolve the logged-in User from the session AND enforce session_epoch.

    AUDIT FIX H4: session_epoch (the app's only session-revocation mechanism) used
    to be validated ONLY inside @login_required / @admin_required / @_music_required.
    Routes that resolve the user themselves with a bare
    `db.session.get(User, session['logged_in_user_id'])` — file preview,
    save-content, thumbnails, regenerate-link, manage-data-by-token, /upload, ... —
    silently skipped that check, so a session the victim tried to evict by
    changing their password (or by recovering the account) still streamed
    server-decrypted plaintext and could overwrite file content.

    Returns the User on success, or None when there is no session, the user row
    is gone, or the cookie's epoch no longer matches the stored epoch. Behaviour
    is byte-for-byte identical to the old lookup whenever the epoch matches.

    AUDIT FIX (finding 20, perf): the dynamic rate-limit callables run on EVERY
    request (before the view) and each called this helper again from the view,
    costing a revocation SELECT + user SELECT per call. The result is memoized
    on flask.g, keyed by everything that could invalidate it (the raw session
    user id + the session's epoch), so one resolution serves the limiter and
    the view. No route mutates session_epoch/session user id and then relies on
    a DIFFERENT answer from a later call within the same request."""
    user_id = session.get('logged_in_user_id')
    if user_id is None:
        return None
    memo_key = (user_id, session.get('session_epoch'))
    try:
        from flask import g as _request_g
        cached = getattr(_request_g, '_current_session_user_cache', None)
        if cached is not None and cached[0] == memo_key:
            cached_user = cached[1]
            if cached_user is None:
                return None
            # Re-validate the epoch on every hit (attribute access refreshes
            # after a commit), so a mid-request session_epoch bump still kills
            # this session exactly as the uncached lookup would.
            if int(session.get('session_epoch', 0) or 0) != int(cached_user.session_epoch or 0):
                return None
            return cached_user
    except (RuntimeError, AttributeError):
        _request_g = None  # no request context -> no memoization
    except ObjectDeletedError:
        # The memoized account was deleted mid-request; the uncached lookup
        # below then resolves it to None like any missing user.
        _request_g = None
    # AUDIT FIX M14: a session explicitly revoked by /logout is dead everywhere.
    revoked = _is_session_revoked()
    if revoked:
        user = None
    else:
        user = db.session.get(User, user_id)
        if user and (int(session.get('session_epoch', 0) or 0) != int(user.session_epoch or 0)
                     or not _session_device_ok()):
            user = None
    if _request_g is not None and revoked is not _REVOCATION_CHECK_FAILED:
        try:
            _request_g._current_session_user_cache = (memo_key, user)
        except (RuntimeError, AttributeError):
            pass
    return user


def admin_required(f):
    """Decorator to require admin privileges - ALWAYS checks database, never trusts session"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'logged_in_user_id' not in session:
            flash('ADMIN ACCESS REQUIRED', 'error')
            return redirect(url_for('login'))
        # AUDIT FIX M14: reject a session that was explicitly revoked by /logout.
        revoked = _is_session_revoked()
        if revoked is _REVOCATION_CHECK_FAILED:
            return 'SERVICE TEMPORARILY UNAVAILABLE. PLEASE TRY AGAIN.', 503
        if revoked:
            session.clear()
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))

        # CRITICAL: Always check admin status from database, never trust session cache
        user = db.session.get(User, session['logged_in_user_id'])
        if not user:
            session.clear()
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))
        if int(session.get('session_epoch', 0) or 0) != int(user.session_epoch or 0) or not _session_device_ok():
            session.clear()
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))
        
        if not user.is_admin:
            flash('ADMIN ACCESS REQUIRED', 'error')
            return redirect(url_for('index'))
        
        return f(*args, **kwargs)
    return decorated_function

def _validate_api_key(raw_key):
    """Validate a raw API key string and return (User, ApiKey) tuple, or (None, None).
    Updates last_used_at on successful validation."""
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    api_key = ApiKey.query.filter_by(key_hash=key_hash, is_active=True).first()
    if not api_key:
        return None, None
    user = db.session.get(User, api_key.user_id)
    if not user:
        return None, None
    # AUDIT FIX H3: throttle last_used_at writes to avoid a hot-row UPDATE
    # + COMMIT on every API request. We only persist a new timestamp when
    # the existing one is stale (>= 60s), which collapses repeated polling
    # into a single write per minute per key while still providing useful
    # liveness data in the admin UI.
    now = datetime.now(timezone.utc)
    last = api_key.last_used_at
    if last is None or last.tzinfo is None:
        # Treat naive timestamps as stale (forces one write to normalize).
        last_aware = last.replace(tzinfo=timezone.utc) if last else None
    else:
        last_aware = last
    if last_aware is None or (now - last_aware).total_seconds() >= 60:
        try:
            api_key.last_used_at = now
            db.session.commit()
        except Exception:
            db.session.rollback()
    return user, api_key

def _validate_ip_whitelist(ip_list):
    """Validate a list of IPv4 addresses/CIDRs for API key IP whitelist.
    Returns (cleaned_list, error_message). If error_message is not None, validation failed."""
    import ipaddress
    if not isinstance(ip_list, list):
        return None, 'allowed_ips must be an array'
    if len(ip_list) > 10:
        return None, 'Maximum of 10 IP addresses/subnets per key'
    cleaned = []
    for entry in ip_list:
        if not isinstance(entry, str):
            return None, f'Invalid IP entry: must be a string'
        entry = entry.strip()
        if not entry:
            continue
        try:
            if '/' in entry:
                network = ipaddress.IPv4Network(entry, strict=False)
                prefix = network.prefixlen
                if prefix < 24:
                    return None, f'Subnet {entry} is too large. Minimum prefix length is /24'
                cleaned.append(str(network))
            else:
                addr = ipaddress.IPv4Address(entry)
                cleaned.append(str(addr))
        except (ipaddress.AddressValueError, ipaddress.NetmaskValueError, ValueError):
            return None, f'Invalid IPv4 address or CIDR: {entry}'
    return cleaned, None

def _parse_permissions_from_data(data):
    """Extract permission booleans from a request data dict.
    Returns a dict of permission column names to boolean values."""
    perms = {}
    perms_input = data.get('permissions', {})
    if not isinstance(perms_input, dict):
        perms_input = {}
    for perm in ApiKey.VALID_PERMISSIONS:
        if perm in perms_input:
            value = perms_input[perm]
            if isinstance(value, str):
                perms[f'perm_{perm}'] = value.strip().lower() in ('1', 'true', 'yes', 'on')
            else:
                perms[f'perm_{perm}'] = bool(value)
    return perms

def _generate_api_key_token():
    return 'onegy_' + secrets.token_urlsafe(32)


def _create_user_api_key(user_id, label, allowed_ips_json, permissions):
    """Create one key while enforcing the per-user active-key limit."""
    lock_file = _acquire_scoped_lock(f'api_keys_user_{int(user_id)}', prefix='api_keys')
    try:
        db.session.rollback()
        if ApiKey.query.filter_by(user_id=user_id, is_active=True).count() >= 10:
            return None, None
        raw_key = _generate_api_key_token()
        api_key = ApiKey(
            user_id=user_id,
            key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
            label=label,
            allowed_ips=allowed_ips_json,
            **permissions
        )
        db.session.add(api_key)
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        return raw_key, api_key
    finally:
        _release_scoped_lock(lock_file)


def _deactivate_user_api_keys(user_id):
    if not user_id:
        return 0
    return ApiKey.query.filter_by(user_id=user_id, is_active=True).update(
        {ApiKey.is_active: False}, synchronize_session=False)

def api_key_required(f):
    """Decorator to require a valid API key via Bearer token.
    Sets g.api_user to the authenticated User object and g.api_key to the ApiKey object.
    Enforces IP whitelist restrictions.
    Returns JSON errors (never redirects)."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not get_setting('allow_api_keys'):
            return jsonify({'error': 'API key access is disabled'}), 403

        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'error': 'Missing or invalid Authorization header. Use: Bearer YOUR_API_KEY'}), 401

        raw_key = auth_header[7:].strip()
        if not raw_key:
            return jsonify({'error': 'Empty API key'}), 401

        user, api_key = _validate_api_key(raw_key)
        if not user or not api_key:
            return jsonify({'error': 'Invalid or revoked API key'}), 401

        # Enforce IP whitelist
        # Use request.remote_addr which ProxyFix has already sanitized from X-Forwarded-For.
        # Do NOT re-read X-Forwarded-For directly — it can be spoofed by any client
        # and would trivially bypass the whitelist.
        client_ip = request.remote_addr or ''
        if not api_key.check_ip_allowed(client_ip):
            print(f'[API] IP {client_ip} blocked by whitelist for key "{_log_safe(api_key.label)}" (user: {user.username})')
            return jsonify({'error': f'IP address {client_ip} is not allowed for this API key'}), 403

        g.api_user = user
        g.api_key = api_key
        return f(*args, **kwargs)
    return decorated_function

def api_permission_required(*perms):
    """Decorator to require specific permissions on the API key.
    Must be used AFTER @api_key_required (so g.api_key is set)."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            for perm in perms:
                if not g.api_key.has_permission(perm):
                    return jsonify({'error': f'API key lacks required permission: {perm}'}), 403
            return f(*args, **kwargs)
        return decorated_function
    return decorator

# ─── Desktop device tokens (desktop/docs/sync-api.md) ─────────────────────────
DEVICE_TOKEN_PREFIX = 'dev_'
# Devices get every API permission except key management.
DEVICE_PERMISSIONS = frozenset({'read', 'download', 'write', 'delete', 'restore'})
MIN_DESKTOP_CLIENT_VERSION = '0.1.0'


def _generate_device_token():
    return DEVICE_TOKEN_PREFIX + secrets.token_urlsafe(32)


def _hash_device_token(raw_token):
    return hashlib.sha256(raw_token.encode('utf-8')).hexdigest()


def _request_has_device_token():
    return request.headers.get('Authorization', '').startswith('Bearer ' + DEVICE_TOKEN_PREFIX)


def _request_device_auth():
    """Resolve this request's Bearer dev_ token once (cached on g; the rate
    limiter and the decorator both ask). Returns (device, user, error_code) with
    error_code None, 'invalid_token' or 'device_revoked'; (None, None, None) when
    the request carries no device token."""
    cached = getattr(g, '_device_auth', None)
    if cached is not None:
        return cached
    result = (None, None, None)
    if _request_has_device_token():
        raw_token = request.headers['Authorization'][7:].strip()
        device = Device.query.filter_by(token_hash=_hash_device_token(raw_token)).first()
        if device is None:
            result = (None, None, 'invalid_token')
        elif not device.is_active:
            result = (None, None, 'device_revoked')
        elif device.pop_public_key and not _device_pop_signature_ok(device):
            result = (None, None, 'invalid_signature')
        else:
            user = db.session.get(User, device.user_id)
            result = (device, user, None) if user else (None, None, 'invalid_token')
    g._device_auth = result
    return result


DEVICE_POP_MAX_SKEW_SECONDS = 300


def _device_pop_message():
    """What a device signs: '<unix ts>\\n<METHOD>\\n<path>[?<raw query>]' (decoded path)."""
    path = request.path
    if request.query_string:
        path += '?' + request.query_string.decode('latin-1')
    return f"{request.headers.get('X-Onegy-Pop-Ts', '')}\n{request.method}\n{path}".encode('utf-8')


def _device_pop_signature_ok(device):
    """Verify X-Onegy-Pop-Sig (base64 DER ECDSA P-256/SHA-256 over _device_pop_message)
    with the device's key, and that X-Onegy-Pop-Ts is within the allowed skew.
    A device token copied off the computer is useless without the private key.
    ponytail: no nonce cache; a signature replays for the same method+path within
    the skew window, which needs a TLS break to capture."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    try:
        ts = int(request.headers.get('X-Onegy-Pop-Ts', ''))
        if abs(time.time() - ts) > DEVICE_POP_MAX_SKEW_SECONDS:
            return False
        signature = base64.b64decode(request.headers.get('X-Onegy-Pop-Sig', ''), validate=True)
        key = serialization.load_der_public_key(base64.b64decode(device.pop_public_key))
        key.verify(signature, _device_pop_message(), ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def _device_grant_live(device):
    """True while the desktop app holding this device is unlocked (a grant exists and has not expired)."""
    expires = _utc_aware(device.grant_expires_at)
    return bool(device.grant_hash and expires and expires > datetime.now(timezone.utc))


def _request_has_device_grant(device):
    raw = request.headers.get('X-Onegy-Grant', '')
    if not raw or not _device_grant_live(device):
        return False
    return hmac.compare_digest(hashlib.sha256(raw.encode('utf-8')).hexdigest(), device.grant_hash)


def _session_device_ok():
    """A website session minted by a desktop device (/desktop/session) lives only
    while that device is active and its app is unlocked."""
    device_id = session.get('device_id')
    if not device_id:
        return True
    device = db.session.get(Device, device_id)
    return bool(device and device.is_active and _device_grant_live(device))


def _scope_folder_value(value):
    """A folder id from a request field; None = drive root. Anything that is
    not a positive id counts as the root, so it is denied unless the scope has it."""
    if isinstance(value, bool):
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _device_request_folder_targets():
    """Folder ids (None = drive root) this device request reads content from or writes to."""
    targets = []
    view_args = request.view_args or {}

    def file_folder(file_id):
        file = db.session.get(File, file_id) if file_id else None
        if file is not None and file.registered_user_id == g.api_user.id:
            targets.append(file.folder_id)

    file_folder(view_args.get('file_id'))
    if 'folder_id' in view_args:
        targets.append(_scope_folder_value(view_args['folder_id']))
    # is_json, not mimetype == 'application/json': routes parse +json bodies too.
    if request.is_json:
        body = request.get_json(silent=True)
    elif request.mimetype in ('multipart/form-data', 'application/x-www-form-urlencoded'):
        # Before the first body read, or the route's truncation check counts 0 bytes.
        _install_request_body_counter()
        # Parsing the form here reads the whole body, so the route's own cap
        # would come too late. The one-shot upload is the sync API's only form
        # route: apply its cap (raises RequestEntityTooLarge).
        _set_request_upload_cap(SYNC_SMALL_UPLOAD_MAX + _MAX_ENCRYPTED_THUMBNAIL_BYTES)
        body = request.form
    else:
        body = None
    if hasattr(body, 'get'):
        for key in ('folder_id', 'parent_id'):
            if key in body:
                targets.append(_scope_folder_value(body.get(key)))
        file_folder(body.get('replace_file_id'))
    return targets


def _device_scope_error():
    """403 locked when a device whose app is locked (no grant) reads file content
    or writes outside its sync scope (sync-api.md "Device security"). Metadata
    reads (feed, tree, listings) stay open: names are E2EE and the engine needs
    them to sync. ponytail: scope is server-enforced, not cryptographic; the
    engine still holds the master key while running (key tree = later layer)."""
    if request.method == 'GET' and not (request.url_rule and request.url_rule.rule.endswith('/content')):
        return None
    try:
        scope = json.loads(g.device.sync_scope or '{}')
    except ValueError:
        scope = {}
    if not isinstance(scope, dict):
        scope = {}
    if scope.get('root') is True:
        return None
    roots = {f for f in (scope.get('folders') or []) if isinstance(f, int) and not isinstance(f, bool)}
    for folder_id in _device_request_folder_targets():
        if folder_id is None or not roots.intersection(_folder_ancestor_ids(folder_id)):
            return _sync_error(403, 'locked', 'ONE.GY Desktop is locked; unlock it to reach files outside your synced folders')
    return None


def _device_client_too_old():
    """True when X-Onegy-Client names a desktop version below the minimum."""
    match = re.match(r'onegy-desktop/(\d+)\.(\d+)\.(\d+)', request.headers.get('X-Onegy-Client', ''))
    if not match:
        return False
    minimum = tuple(int(part) for part in MIN_DESKTOP_CLIENT_VERSION.split('.'))
    return tuple(int(part) for part in match.groups()) < minimum


def _touch_device_last_seen(device):
    """Record liveness at most once per 60 s per device (same throttle as API keys)."""
    now = datetime.now(timezone.utc)
    last = device.last_seen_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    if last is not None and (now - last).total_seconds() < 60:
        return
    ip = (get_real_ip() or '').strip()
    secret = app.config.get('SECRET_KEY') or ''
    if isinstance(secret, bytes):
        secret = secret.decode('utf-8', 'ignore')
    try:
        device.last_seen_at = now
        if ip and ip != 'unknown':
            device.last_ip_hash = hmac.new(secret.encode('utf-8'), ip.encode('utf-8'), hashlib.sha256).hexdigest()
        db.session.commit()
    except Exception:
        db.session.rollback()


def device_auth_required(f):
    """Require an active device token. Sets g.api_user and g.device. JSON errors
    in the sync API shape (never redirects)."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not get_setting('allow_desktop_sync'):
            return _sync_error(403, 'sync_disabled', 'Desktop sync is disabled on this server')
        device, user, error = _request_device_auth()
        if error == 'device_revoked':
            return _sync_error(401, 'device_revoked', 'This device was removed')
        if error == 'invalid_signature':
            return _sync_error(401, 'invalid_signature', 'Request signature missing, stale or invalid')
        if device is None:
            return _sync_error(401, 'invalid_token', 'Missing or invalid device token')
        if _device_client_too_old():
            return _sync_error(426, 'client_too_old', 'Please update ONE.GY Desktop',
                               min_client_version=MIN_DESKTOP_CLIENT_VERSION)
        _touch_device_last_seen(device)
        g.api_user = user
        g.device = device
        g.device_unlocked = not device.lock_enabled or _request_has_device_grant(device)
        if not g.device_unlocked:
            from werkzeug.exceptions import RequestEntityTooLarge
            try:
                scope_error = _device_scope_error()
            except RequestEntityTooLarge:
                # Same answer as apiv1_sync_upload_file gives an unlocked device.
                return _sync_error(400, 'bad_request', 'File too large for a one-shot upload; use an upload session', field='file')
            if scope_error:
                return scope_error
        return f(*args, **kwargs)
    return decorated_function


def api_or_device_auth(*perms):
    """Accept an API key holding perms (api_key_required semantics) or a device
    token (DEVICE_PERMISSIONS). Lets reused /apiv1 routes serve the desktop client."""
    def decorator(f):
        api_view = api_key_required(api_permission_required(*perms)(f))
        device_view = device_auth_required(f)

        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not _request_has_device_token():
                return api_view(*args, **kwargs)
            if not DEVICE_PERMISSIONS.issuperset(perms):
                return _sync_error(403, 'forbidden', 'Device tokens cannot use this endpoint')
            return device_view(*args, **kwargs)
        return decorated_function
    return decorator
