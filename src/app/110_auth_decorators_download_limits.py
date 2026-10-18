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
        session.permanent = True
        return f(*args, **kwargs)
    return decorated_function

# ────────────────────────────────────────────────────────────────────
# AUDIT FIX M14: per-session revocation (see the RevokedSession model)
# ────────────────────────────────────────────────────────────────────
# Process-local positive cache of revoked sid hashes. A positive is permanent
# for the worker lifetime because the cookie expires no later than its DB row;
# misses always consult the shared DB authority so every worker observes logout.
_revoked_sid_cache = set()
_revoked_sid_lock = threading.Lock()
_revoked_sid_loaded = False


def _hash_session_sid(sid):
    return hashlib.sha256(str(sid).encode('utf-8')).hexdigest()


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
    with _revoked_sid_lock:
        _revoked_sid_cache.update(fresh)
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

    DB failures fail closed once the revocation table should exist. The one
    exception is an explicitly missing table while db-upgrade is creating the
    schema; treating that as revoked would make every request fail during the
    startup migration window.
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
        return True
    if revoked:
        with _revoked_sid_lock:
            _revoked_sid_cache.add(sid_hash)
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
        _revoked_sid_cache.add(sid_hash)
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
    if _is_session_revoked():
        user = None
    else:
        user = db.session.get(User, user_id)
        if user and int(session.get('session_epoch', 0) or 0) != int(user.session_epoch or 0):
            user = None
    if _request_g is not None:
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
        if _is_session_revoked():
            session.clear()
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))

        # CRITICAL: Always check admin status from database, never trust session cache
        user = db.session.get(User, session['logged_in_user_id'])
        if not user:
            session.clear()
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))
        if int(session.get('session_epoch', 0) or 0) != int(user.session_epoch or 0):
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

def _file_payload_delete_keys(file):
    """Return logical storage keys that should be removed with a file record."""
    if not file:
        return []
    keys = [f'storage://files/{file.filename}']
    for _ext in ('.jpg', '.e2e'):
        keys.append(f'storage://thumbnails/{file.id}{_ext}')
    return keys

def _note_payload_delete_key(note_id):
    return f'storage://notes/{note_id}'


def _purge_staged_locals_with_note_locks(local_targets):
    """Purge committed deletes, serializing note payload removal with saves."""
    for target in local_targets or []:
        category, object_id = target
        if category != 'notes':
            storage.purge_staged_locals([target])
            continue
        note_lock = _acquire_note_rewrite_lock(object_id)
        try:
            db.session.rollback()
            if db.session.get(Note, object_id) is not None:
                print(f'[STORAGE] Skipping local note purge for {object_id}: Note row still exists')
                continue
            storage.purge_staged_locals([target])
        finally:
            _release_note_rewrite_lock(note_lock)


def _delete_immediately_expired_file(file):
    """Recheck and atomically delete an expired file under its lifecycle lock."""
    lifecycle_lock = _acquire_file_lifecycle_lock(file)
    local_targets = []
    deleted_name = None
    fresh_file = None
    try:
        db.session.rollback()
        fresh_file = db.session.get(File, file.id, populate_existing=True)
        if not fresh_file:
            return None, None
        expires_at = fresh_file.get_expires_at_aware()
        if not expires_at or expires_at >= datetime.now(timezone.utc):
            return fresh_file, None
        deleted_name = fresh_file.orig_name
        local_targets = storage.stage_payload_deletes(_file_payload_delete_keys(fresh_file))
        db.session.delete(fresh_file)
        db.session.commit()
        fresh_file = None
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    storage.purge_staged_locals(local_targets)
    return fresh_file, deleted_name


def _download_cleanup_paths(file):
    """Return logical payload keys that should be removed with a file record."""
    return _file_payload_delete_keys(file)

def _mark_file_for_download_limit_delete(file):
    """Burn-after-N reached: mark the file for DEFERRED deletion (M7 FIX).

    This used to hard-delete the File row and its payload the instant the
    reserved download count hit max_downloads. That raced any OTHER request
    that had legally reserved an earlier slot and was still mid-stream: the
    reaper unlinked the payload, the stream's next read (or lazy re-open by
    path) failed with OSError, and the client received a truncated body under
    an already-sent 200 + Content-Length.

    The row is now only MARKED (pending_delete_at = now):
    - check_download_allowed() / check_and_reserve_download() treat a marked
      row as exhausted, so it immediately stops serving NEW downloads;
    - in-flight streams drain from the still-intact payload;
    - cleanup_expired_files() hard-deletes the row + payload (with remote
      delete tombstones, via the same atomic staging as every other delete)
      once DOWNLOAD_LIMIT_DELETE_GRACE has elapsed. Burn-after-N semantics
      hold -- just deferred past the longest legal stream.

    The stamp is a compare-and-swap so concurrent finalizes cannot move the
    marker later and thereby extend the grace window."""
    if not file:
        return

    file_id = file.id
    orig_name = file.orig_name

    try:
        marked = db.session.query(File).filter(
            File.id == file_id,
            File.pending_delete_at.is_(None),
        ).update(
            {'pending_delete_at': datetime.now(timezone.utc)},
            synchronize_session=False
        )
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f'[LIMIT] Failed to mark exhausted file {orig_name} ({file_id}) for deferred deletion: {e}')
        return

    if marked:
        print(f'[LIMIT] Download limit reached for {orig_name} ({file_id}) -- deletion deferred to cleanup (grace: {DOWNLOAD_LIMIT_DELETE_GRACE})')
    else:
        print(f'[LIMIT] Download limit reached for {orig_name} ({file_id}) -- already marked for deferred deletion')

def check_download_allowed(file):
    """Check whether a file can still be downloaded without consuming a count yet."""
    if not file.max_downloads:
        return True, None

    fresh = db.session.get(File, file.id)
    if not fresh:
        return False, 'limit_reached'

    # M7 FIX: a burned row (limit reached, deletion deferred via
    # pending_delete_at) serves nothing -- including during the grace window
    # and even if rollback_reserved_download() later pulls the counter back
    # below the cap for an undelivered slot.
    if fresh.pending_delete_at is not None:
        return False, 'limit_reached'

    current_count = fresh.download_count or 0
    # AUDIT FIX (finding 2): refresh reads against the DB column -- a
    # concurrent limit removal made `count < fresh.max_downloads` a
    # TypeError (int < None) and turned a legal download into a 500.
    if not fresh.max_downloads or current_count < fresh.max_downloads:
        return True, None

    return False, 'limit_reached'

# DEAD CODE REMOVED (residual audit item k): record_completed_download() had
# ZERO callers anywhere in the repository. Downloads are counted by
# check_and_reserve_download() / check_and_increment_download() (reserve) plus
# finalize_reserved_download() (commit), which enforce max_downloads
# atomically; a second, unreferenced counting path only invited double counts.

def check_and_reserve_download(file):
    """
    Atomically reserve a download slot by incrementing count.
    Returns (success, error_message, reservation) where `reservation` is an
    opaque token identifying THE SLOT THIS CALL TOOK. Pass it to
    rollback_reserved_download() to release that specific slot.

    AUDIT FIX D8: the token lives in the caller's own stack frame, so a request
    can only ever release a slot it actually reserved.
    """
    if not file:
        return False, 'unavailable', None

    # AUDIT FIX (finding 2): the reservation guard must compare the DB COLUMN
    # File.max_downloads, never the Python attribute fetched earlier in this
    # request -- an admin edit (or a concurrent request) may have changed or
    # removed the limit after the ORM object was loaded, and this UPDATE is
    # the authoritative under-concurrency decision:
    #   * unlimited row  -> plain increment (matches the old unlimited path,
    #     including rows with pending_delete_at set);
    #   * limited row    -> pending_delete_at guard + count < max DOWN IN SQL.
    # The old code bound the STALE Python value into the comparison, so a
    # removed limit evaluated `count < NULL` -> no match -> and then raised
    # TypeError in the refresh below; an added limit was bypassed entirely.
    for _attempt in range(2):
        result = db.session.query(File).filter(
            File.id == file.id,
            db.or_(
                File.max_downloads.is_(None),
                db.and_(
                    File.pending_delete_at.is_(None),
                    db.func.coalesce(File.download_count, 0) < File.max_downloads,
                ),
            ),
        ).update(
            {"download_count": db.func.coalesce(File.download_count, 0) + 1},
            synchronize_session=False
        )
        db.session.commit()

        if result:
            return True, None, _build_download_reservation(file.id)

        # Refreshed reads for the failure classification (the commit above
        # expired the identity map, so this re-read hits the DB).
        fresh = db.session.get(File, file.id)
        if not fresh:
            return False, 'unavailable', None
        if fresh.max_downloads:
            if fresh.pending_delete_at is not None or (fresh.download_count or 0) >= fresh.max_downloads:
                return False, 'limit_reached', None
        # The row changed between the UPDATE and this refresh (limit removed,
        # or a concurrent rollback freed a slot): retry once against the
        # refreshed row before giving up.
    return False, 'unavailable', None

def _build_download_reservation(file_id):
    """Capture the counter position a just-taken reservation occupies.

    Read back AFTER the commit; under concurrency another reservation may have
    landed in between, which only makes the recorded position HIGHER and so
    makes the release check below stricter (fail closed = the slot stays
    consumed), never looser."""
    reserved_count = None
    try:
        fresh = db.session.get(File, file_id)
        if fresh:
            reserved_count = int(fresh.download_count or 0)
    except Exception as e:
        print(f'[DOWNLOAD] Could not read back reserved slot position for {file_id}: {e}')
    return {'file_id': file_id, 'count': reserved_count}

def check_and_increment_download(file):
    """
    Atomically reserve a download slot by incrementing count.
    Returns (success, error_message) tuple.
    - If successful, returns (True, None)
    - If limit reached, returns (False, 'limit_reached')
    Streaming routes must call finalize_reserved_download() when the response closes.
    Callers that may need to RELEASE the slot again should use
    check_and_reserve_download() instead and keep the reservation token.
    """
    success, error, _reservation = check_and_reserve_download(file)
    return success, error

def rollback_reserved_download(file_id, reservation=None):
    """Release a reserved download slot THIS REQUEST holds.

    AUDIT FIX H3: use this ONLY for pre-delivery failures where NOTHING was
    streamed to the client (e.g. a file that could not be decrypted/added to a
    ZIP, or an error while building the response before any bytes were sent).
    It rolls the reserved count back so a server-side exclusion never consumes a
    limited/one-time link. Do NOT use it for a client-controlled mid-stream abort
    -- that path must consume the slot (see finalize_reserved_download).

    AUDIT FIX D8: the decrement used to be unconditional (`count > 0`), with no
    proof that this request owned a slot at all. During a ZIP build a failed
    member could therefore release a slot belonging to a CONCURRENT direct
    download, letting a max_downloads=1 burn-after-reading link be consumed
    twice. The caller must now present the reservation token returned by
    check_and_reserve_download(), and the decrement only applies while the
    counter is still at or above the position that reservation took."""
    if not reservation or reservation.get('file_id') != file_id:
        print(f'[WARNING] Refusing to release a download slot for {file_id} without a matching reservation token')
        return
    # AUDIT FIX (finding 2): a reservation with NO recorded slot position
    # (count=None/0 -- the read-back in _build_download_reservation failed)
    # cannot prove WHICH slot this request owns, so the positional guard below
    # would be skipped and the decrement could undo a CONCURRENT request's
    # slot (letting a max_downloads=1 link be consumed twice). Fail closed:
    # an unprovable slot stays consumed.
    try:
        reserved_count = int(reservation.get('count'))
    except (TypeError, ValueError):
        reserved_count = None
    if reserved_count is None or reserved_count < 1:
        print(f'[WARNING] Reservation token for {file_id} carries no usable slot position '
              f'(count={reservation.get("count")!r}); refusing to release a slot this request cannot prove it owns')
        return
    try:
        query = db.session.query(File).filter(
            File.id == file_id,
            db.func.coalesce(File.download_count, 0) > 0,
            db.func.coalesce(File.download_count, 0) >= reserved_count,
        )
        result = query.update(
            {"download_count": db.func.coalesce(File.download_count, 0) - 1},
            synchronize_session=False
        )
        if result:
            db.session.commit()
            print(f'[DOWNLOAD] Released reserved (undelivered) download slot for {file_id}')
        else:
            # No commit and no rollback: the conditional UPDATE matched nothing,
            # so there is nothing to persist and no caller state to discard.
            print(f'[DOWNLOAD] Reserved slot for {file_id} was already consumed or superseded; leaving the counter alone')
    except Exception as e:
        db.session.rollback()
        print(f'[DOWNLOAD] Failed to roll back reserved download for {file_id}: {e}')

def finalize_reserved_download(file_id, completed):
    """Finalize a download slot reserved by check_and_increment_download when a
    streaming response closes.

    AUDIT FIX H3: for files WITH a max_downloads limit (view-once / burn-after-N)
    a reserved slot is treated as CONSUMED even if the client aborts the stream.
    Previously ANY incomplete stream rolled the counter back, so an attacker
    could pull almost the entire payload and then drop the connection before the
    final chunk to avoid consuming the slot -- the limited/one-time link then
    stayed live indefinitely. Now a limited link burns on first delivery attempt.
    Only UNLIMITED files (no max_downloads, where the counter is a pure download
    statistic) still roll back an incomplete stream for count honesty.

    Pre-delivery/server-side exclusions must use rollback_reserved_download()
    instead so they never consume a limited link."""
    try:
        file = db.session.get(File, file_id)
        if not file:
            return
        if file.max_downloads:
            # Limited link: the slot is consumed on reservation regardless of
            # whether the client fully drained the stream. Burn the file once the
            # reserved count has reached the cap.
            # M7 FIX: the burn only MARKS the row (pending_delete_at) so an
            # in-flight stream holding an earlier slot can finish; the actual
            # row+payload delete is deferred to cleanup_expired_files().
            if (file.download_count or 0) >= file.max_downloads:
                _mark_file_for_download_limit_delete(file)
            return
        # Unlimited file: download_count is a statistic only -> roll back an
        # incomplete stream so the count reflects completed downloads.
        if not completed:
            result = db.session.query(File).filter(
                File.id == file_id,
                db.func.coalesce(File.download_count, 0) > 0
            ).update(
                {"download_count": db.func.coalesce(File.download_count, 0) - 1},
                synchronize_session=False
            )
            if result:
                db.session.commit()
                print(f'[DOWNLOAD] Rolled back incomplete download count for {file_id}')
    except Exception as e:
        db.session.rollback()
        print(f'[DOWNLOAD] Failed to finalize reserved download for {file_id}: {e}')

def increment_folder_download_counts(root_folder_id):
    """
    Increment download_count for a folder and all its non-trashed sub-folders.
    Uses BFS to collect all folder IDs in the tree, then a single bulk UPDATE.
    File download_counts are NOT touched -- those are handled by individual file download routes.
    """
    try:
        # AUDIT FIX D3: visited set + size bound. Without them a parent_id cycle
        # turned this into an unbounded DB-query loop.
        folder_ids = []
        visited = set()
        queue = [root_folder_id]
        while queue:
            parent_id = queue.pop(0)
            if parent_id in visited:
                continue
            visited.add(parent_id)
            folder_ids.append(parent_id)
            if len(visited) > _MAX_FOLDER_TREE_NODES:
                print(f'[WARNING] Folder download-count walk from {root_folder_id} exceeded {_MAX_FOLDER_TREE_NODES} folders; truncating')
                break
            sub_ids = [f.id for f in Folder.query.filter_by(parent_id=parent_id, is_trashed=False).with_entities(Folder.id).all()]
            queue.extend(sub_ids)

        Folder.query.filter(Folder.id.in_(folder_ids)).update(
            {Folder.download_count: db.func.coalesce(Folder.download_count, 0) + 1},
            synchronize_session=False
        )
        db.session.commit()
        print(f'[FOLDER DOWNLOAD] Incremented download count for {len(folder_ids)} folder(s) (root: {root_folder_id})')
    except Exception as e:
        db.session.rollback()
        print(f'[FOLDER DOWNLOAD] Warning: Failed to increment folder download counts: {e}')

def check_storage():
    try:
        stat = os.statvfs(basedir)
        total = stat.f_frsize * stat.f_blocks
        used = stat.f_frsize * (stat.f_blocks - stat.f_bavail)
        percent = (used / total) * 100
        print(f'[STORAGE] Disk usage: {percent:.1f}% ({used / (1024**3):.2f} GB / {total / (1024**3):.2f} GB)')
    except Exception as e:
        print(f'[STORAGE] Failed to check storage: {e}')

