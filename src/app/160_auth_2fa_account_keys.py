def _encrypt_totp_secret(plaintext_secret):
    """Encrypt a plaintext TOTP secret with the app Fernet key.
    Returns a string (base64 Fernet token)."""
    return fernet.encrypt(plaintext_secret.encode('utf-8')).decode('utf-8')

def _decrypt_totp_secret(stored_secret, user=None):
    """Decrypt a stored TOTP secret.
    Handles legacy plaintext secrets (pre-encryption migration) transparently:
    if Fernet decryption raises InvalidToken or ValueError, the value is ONLY
    treated as a legacy plaintext secret when it is a valid base32 string (the
    format pyotp uses). A Fernet token that fails to decrypt because FERNET_KEY
    was rotated/misconfigured is NOT base32 (it is base64url and starts with
    'gAAAAA'), so it is rejected instead of being mistaken for plaintext —
    otherwise re-encrypting the ciphertext would permanently corrupt the
    stored secret and lock the user out of 2FA with no recovery path.
    Any other exception (unexpected runtime error) propagates so it is not
    silently swallowed and mistaken for a valid secret."""
    if not stored_secret:
        return None
    from cryptography.fernet import InvalidToken as _InvalidToken
    try:
        return fernet.decrypt(stored_secret.encode('utf-8')).decode('utf-8')
    except (_InvalidToken, ValueError):
        # Only treat as legacy plaintext if the value looks like a real TOTP
        # secret (valid base32). pyotp secrets are base32 (A-Z2-7, optional
        # padding); Fernet tokens are base64url and start with 'gAAAAA'.
        if not _looks_like_base32_totp_secret(stored_secret):
            # This is almost certainly an encrypted token we cannot decrypt
            # (FERNET_KEY rotation/mismatch). Re-encrypting the ciphertext
            # would corrupt it permanently, so surface the error instead.
            print(f'[AUTH] TOTP secret could not be decrypted and is not a legacy plaintext base32 secret — '
                  f'likely FERNET_KEY rotation/mismatch for user {getattr(user, "username", "?")}. Refusing to corrupt it.')
            raise
        # Legacy plaintext secret — migrate to encrypted form in-place
        if user is not None:
            try:
                user.two_factor_secret = _encrypt_totp_secret(stored_secret)
                db.session.commit()
                print(f'[AUTH] Migrated plaintext TOTP secret to encrypted form for user: {user.username}')
            except Exception as _e:
                db.session.rollback()
                print(f'[AUTH] Warning: failed to migrate TOTP secret for user {getattr(user, "username", "?")}): {_e}')
        return stored_secret

def _looks_like_base32_totp_secret(value):
    """Heuristic: True if value is a plausible legacy plaintext TOTP secret
    (base32 string, no base64url-only chars). Fernet tokens contain '-_/' and
    start with 'gAAAAA', so they never match here."""
    if not value or not isinstance(value, str):
        return False
    # Fernet tokens always start with the version byte 0x80 -> base64 'g' followed
    # by timestamp high bits ('AAAAA'). A real base32 secret never starts this way.
    if value.startswith('gAAAAA'):
        return False
    import string as _string
    b32_alphabet = set(_string.ascii_uppercase + '234567=')
    # Must be non-empty, all base32, and a reasonable secret length (16-128).
    if not (8 <= len(value) <= 128):
        return False
    return all(c in b32_alphabet for c in value)

# TOTP replay prevention: track recently used codes per user. The in-memory maps
# are non-authoritative mirrors; per-user flocked files provide worker coherence.
# Maps user_id -> {totp_code: expiry_timestamp}.
# A code is valid for at most 90 s (valid_window=1 allows ±1 step of 30 s each).
# We keep entries for 90 s to cover the full acceptance window, then they expire.
import threading as _totp_threading
_totp_used_codes = {}       # non-authoritative mirror
_totp_used_codes_lock = _totp_threading.Lock()
_totp_failure_map = {}      # non-authoritative mirror
_totp_failure_lock = _totp_threading.Lock()
_TOTP_FAILURE_THRESHOLD = 5
_TOTP_LOCK_DURATION = 300
_TOTP_FAILURE_RESET_AFTER = 900

def _totp_is_replayed(user_id, code):
    """Return True if this TOTP code has already been used for this user recently."""
    import time as _time
    now = _time.time()
    state_key = str(user_id)
    locks = _acquire_security_state_locks([('totp_replay', state_key)])
    try:
        state = _read_security_state('totp_replay', state_key)
        user_codes = {
            str(c): float(exp) for c, exp in (state.get('codes') or {}).items()
            if float(exp) > now
        }
        if user_codes:
            _write_security_state('totp_replay', state_key, {
                'codes': user_codes,
                'retain_until': max(user_codes.values()),
            })
        else:
            _write_security_state('totp_replay', state_key, None)
        with _totp_used_codes_lock:
            _totp_used_codes[user_id] = dict(user_codes)
        return str(code) in user_codes
    finally:
        _release_security_state_locks(locks)

# DEAD CODE REMOVED (residual audit item k): _totp_mark_used() had ZERO
# callers; _totp_try_consume() (used by both 2FA verify paths) is the atomic
# check-and-mark and keeps identical state.

def _totp_try_consume(user_id, code):
    """Atomically record a TOTP code as used iff it has not already been used.
    Returns True if THIS caller won the race (code was unused), False if a
    concurrent request already consumed it. The purge, replay check, and insert
    all happen under a single lock acquisition so two concurrent requests with
    the same valid code cannot both complete login."""
    # pyotp NFKC-normalizes before comparing, so fullwidth digits verify while
    # being a different replay key. Only plain ASCII codes may be consumed.
    if not re.fullmatch(r'[0-9]{6}', str(code)):
        return False
    import time as _time
    now = _time.time()
    expiry = now + 90
    state_key = str(user_id)
    locks = _acquire_security_state_locks([('totp_replay', state_key)])
    try:
        state = _read_security_state('totp_replay', state_key)
        user_codes = {
            str(c): float(exp) for c, exp in (state.get('codes') or {}).items()
            if float(exp) > now
        }
        if str(code) in user_codes:
            with _totp_used_codes_lock:
                _totp_used_codes[user_id] = dict(user_codes)
            return False
        user_codes[str(code)] = expiry
        _write_security_state('totp_replay', state_key, {
            'codes': user_codes,
            'retain_until': max(user_codes.values()),
        })
        with _totp_used_codes_lock:
            _totp_used_codes[user_id] = dict(user_codes)
        return True
    finally:
        _release_security_state_locks(locks)

def _totp_failure_purge_locked():
    now = time.time()
    stale = [uid for uid, entry in _totp_failure_map.items()
             if entry.get('last_fail', 0) + _TOTP_FAILURE_RESET_AFTER < now
             and entry.get('lock_until', 0) < now]
    for uid in stale:
        _totp_failure_map.pop(uid, None)

def _totp_lockout_remaining(user_id):
    now = time.time()
    state_key = str(user_id)
    locks = _acquire_security_state_locks([('totp_failure', state_key)])
    try:
        entry = _read_security_state('totp_failure', state_key)
        if (not _security_state_fresh(entry, now)
                or (float(entry.get('last_fail', 0)) + _TOTP_FAILURE_RESET_AFTER < now
                    and float(entry.get('lock_until', 0)) < now)):
            _write_security_state('totp_failure', state_key, None)
            with _totp_failure_lock:
                _totp_failure_map.pop(user_id, None)
            return 0
        if not entry:
            return 0
        remaining = int(entry.get('lock_until', 0) - now)
        return remaining if remaining > 0 else 0
    finally:
        _release_security_state_locks(locks)

def _record_failed_totp(user_id):
    now = time.time()
    state_key = str(user_id)
    locks = _acquire_security_state_locks([('totp_failure', state_key)])
    try:
        entry = _read_security_state('totp_failure', state_key) or {'fails': 0}
        # A FINISHED lock starts a fresh window (same rule as login lockouts);
        # otherwise every post-cooldown mistake would re-arm a full lock.
        if (entry.get('last_fail', 0) + _TOTP_FAILURE_RESET_AFTER < now
                or 0 < float(entry.get('lock_until', 0) or 0) <= now):
            entry = {'fails': 0}
        entry['fails'] = int(entry.get('fails', 0)) + 1
        entry['last_fail'] = now
        if entry['fails'] >= _TOTP_FAILURE_THRESHOLD:
            entry['lock_until'] = now + _TOTP_LOCK_DURATION
        entry['retain_until'] = max(
            entry['last_fail'] + _TOTP_FAILURE_RESET_AFTER,
            entry.get('lock_until', 0),
        )
        _write_security_state('totp_failure', state_key, entry)
        with _totp_failure_lock:
            _totp_failure_map[user_id] = dict(entry)
            _totp_failure_purge_locked()
    finally:
        _release_security_state_locks(locks)

def _clear_failed_totp(user_id):
    state_key = str(user_id)
    locks = _acquire_security_state_locks([('totp_failure', state_key)])
    try:
        _write_security_state('totp_failure', state_key, None)
        with _totp_failure_lock:
            _totp_failure_map.pop(user_id, None)
    finally:
        _release_security_state_locks(locks)

@app.route('/verify-2fa', methods=['GET', 'POST'])
@limiter.limit("10 per minute", methods=["POST"])
def verify_2fa():
    """Second step of login — verify TOTP code for users with 2FA enabled."""
    pending_user_id = session.get('2fa_pending_user_id')
    if not pending_user_id:
        return redirect(url_for('login'))
    pending_started_at = session.get('2fa_pending_started_at')
    try:
        pending_age = time.time() - float(pending_started_at)
    except (TypeError, ValueError):
        pending_age = 301
    if pending_age > 300:
        session.pop('2fa_pending_user_id', None)
        session.pop('2fa_pending_username', None)
        session.pop('2fa_pending_started_at', None)
        session.pop('2fa_pending_epoch', None)
        return redirect(url_for('login'))

    user = db.session.get(User, pending_user_id)
    pending_epoch = session.get('2fa_pending_epoch')
    if not user or pending_epoch != int(user.session_epoch or 0):
        session.pop('2fa_pending_user_id', None)
        session.pop('2fa_pending_username', None)
        session.pop('2fa_pending_started_at', None)
        session.pop('2fa_pending_epoch', None)
        return redirect(url_for('login'))
    
    if request.method == 'POST':
        is_ajax = request.headers.get('X-Requested-With') == 'XMLHttpRequest'
        
        if is_ajax:
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                return jsonify({'error': 'INVALID REQUEST'}), 400
            # AUDIT FIX: a JSON totp_code that is not a string (number, list)
            # used to raise AttributeError on .strip() -> 500.
            if not _json_string_fields_valid(data, ('totp_code',)):
                return jsonify({'error': 'INVALID REQUEST'}), 400
            totp_code = (data.get('totp_code') or '').strip() if data else ''
        else:
            totp_code = request.form.get('totp_code', '').strip()
        
        if not user.two_factor_enabled or not user.two_factor_secret:
            session.pop('2fa_pending_user_id', None)
            session.pop('2fa_pending_username', None)
            session.pop('2fa_pending_started_at', None)
            session.pop('2fa_pending_epoch', None)
            if is_ajax:
                return jsonify({'error': 'INVALID SESSION. PLEASE LOGIN AGAIN'}), 400
            flash('INVALID SESSION. PLEASE LOGIN AGAIN', 'error')
            return redirect(url_for('login'))

        lock_remaining = _totp_lockout_remaining(user.id)
        if lock_remaining > 0:
            print(f'[AUTH] 2FA lockout active for user: {user.username} ({lock_remaining}s remaining)')
            if is_ajax:
                return jsonify({'error': f'TOO MANY INVALID 2FA CODES. TRY AGAIN IN {lock_remaining} SECONDS.'}), 429
            flash(f'TOO MANY INVALID 2FA CODES. TRY AGAIN IN {lock_remaining} SECONDS.', 'error')
            return render_template('verify_2fa.html')
        
        totp = pyotp.TOTP(_decrypt_totp_secret(user.two_factor_secret, user))
        print(f'[AUTH] 2FA verify attempt for {user.username}')
        # Check replay: reject a code that was already accepted in the last 90 s
        if _totp_is_replayed(user.id, totp_code):
            print(f'[AUTH] 2FA replay attempt blocked for user: {user.username}')
            _record_failed_totp(user.id)
            if is_ajax:
                return jsonify({'error': 'INVALID 2FA CODE. PLEASE TRY AGAIN'}), 401
            flash('INVALID 2FA CODE. PLEASE TRY AGAIN', 'error')
            return render_template('verify_2fa.html')
        if not totp.verify(totp_code, valid_window=1):
            print(f'[AUTH] 2FA verification failed for user: {user.username}')
            _record_failed_totp(user.id)
            if is_ajax:
                return jsonify({'error': 'INVALID 2FA CODE. PLEASE TRY AGAIN'}), 401
            flash('INVALID 2FA CODE. PLEASE TRY AGAIN', 'error')
            return render_template('verify_2fa.html')
        # Atomically consume the code so two concurrent requests sharing one
        # valid code cannot both complete login. The loser is treated as a replay.
        if not _totp_try_consume(user.id, totp_code):
            print(f'[AUTH] 2FA replay attempt blocked (concurrent consume) for user: {user.username}')
            _record_failed_totp(user.id)
            if is_ajax:
                return jsonify({'error': 'INVALID 2FA CODE. PLEASE TRY AGAIN'}), 401
            flash('INVALID 2FA CODE. PLEASE TRY AGAIN', 'error')
            return render_template('verify_2fa.html')
        _clear_failed_totp(user.id)
        # AUDIT FIX H2: clear failure counter on completed login.
        _clear_failed_login((user.username or '').strip().lower())

        # 2FA verified — complete login
        old_guest_id = session.get('user_id')
        was_just_registered = session.get('just_registered', False)
        session.clear()
        if old_guest_id:
            session['user_id'] = old_guest_id
        
        session['logged_in_user_id'] = user.id
        session['session_epoch'] = pending_epoch
        session['username'] = user.username
        session['avatar_color'] = user.avatar_color or '#555'
        # AUDIT FIX M14: per-session id for precise logout revocation.
        _mint_session_sid()
        session.permanent = True
        
        # Notification trigger flags
        user.login_count = (user.login_count or 0) + 1
        db.session.commit()
        session['just_logged_in'] = True
        session.pop('_served_login_notifs', None)
        session.pop('_session_notif_dismissed', None)
        session.pop('_session_notif_active', None)
        if was_just_registered:
            session['just_registered'] = True
        
        print(f'[AUTH] User logged in (2FA verified): {user.username}')
        
        if is_ajax:
            key_data = {}
            if user.has_e2ee_keys:
                key_data = {
                    'has_e2ee_keys': True,
                    'encrypted_master_key': user.encrypted_master_key,
                    'master_key_nonce': user.master_key_nonce,
                    'master_key_salt': user.master_key_salt,
                    'encrypted_private_key': user.encrypted_private_key,
                    'private_key_nonce': user.private_key_nonce,
                    'public_key': user.public_key
                }
            else:
                key_data = {'has_e2ee_keys': False}
            return jsonify({'success': True, 'redirect': url_for('files'), 'csrf_token': generate_csrf(), **key_data})
        
        return redirect(url_for('files'))
    
    return render_template('verify_2fa.html')

# ─── Pending 2FA enrolment state ─────────────────────────────────────────────
# AUDIT FIX H5: the pending TOTP secret lives in the SIGNED (not encrypted) Flask
# session cookie. It used to have no expiry and was popped only on a successful
# confirm, so an abandoned setup left a readable, still-live secret riding on
# every single request indefinitely. It now carries a short TTL, is cleared on
# logout, on any failed/abandoned confirm, and on a credential change.
_2FA_SETUP_TTL_SECONDS = 600  # 10 minutes to scan the QR and enter a code


def _clear_pending_2fa_setup():
    session.pop('2fa_setup_secret', None)
    session.pop('2fa_setup_started_at', None)


def _get_pending_2fa_setup():
    """Return the pending TOTP secret, or None if absent/expired.
    Expired state is cleared as a side effect so the secret stops riding along."""
    secret = session.get('2fa_setup_secret')
    if not secret:
        _clear_pending_2fa_setup()
        return None
    started_at = session.get('2fa_setup_started_at')
    try:
        age = time.time() - float(started_at)
    except (TypeError, ValueError):
        age = _2FA_SETUP_TTL_SECONDS + 1
    if age > _2FA_SETUP_TTL_SECONDS:
        _clear_pending_2fa_setup()
        return None
    try:
        return _decrypt_totp_secret(secret)
    except Exception:
        _clear_pending_2fa_setup()
        return None


@app.route('/account/2fa/setup', methods=['POST'])
@limiter.limit("5 per minute")
@login_required
def setup_2fa():
    """Generate a TOTP secret and return a QR code for authenticator app setup.

    AUDIT FIX H5: requires proof of the CURRENT credentials. Without it, a
    session hijacker could bind their own TOTP secret to the victim's account
    and — since disabling requires a valid CURRENT code, there are no backup
    codes and no admin reset — permanently lock the real owner out."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'USER NOT FOUND'}), 404

    if user.two_factor_enabled:
        return jsonify({'error': '2FA IS ALREADY ENABLED'}), 400

    data = _json_object_body()
    if not _verify_user_credentials(user,
                                    password=data.get('password'),
                                    auth_token=data.get('auth_token')):
        print(f'[AUTH] 2FA setup REJECTED for user {user.username}: missing/invalid credential proof')
        return jsonify({'error': 'PASSWORD IS REQUIRED TO SET UP TWO-FACTOR AUTHENTICATION'}), 403

    # Generate a new TOTP secret
    secret = pyotp.random_base32()

    # Store secret temporarily in session until user confirms with a valid code
    session['2fa_setup_secret'] = _encrypt_totp_secret(secret)
    session['2fa_setup_started_at'] = time.time()
    
    # Generate provisioning URI for QR code
    totp = pyotp.TOTP(secret)
    provisioning_uri = totp.provisioning_uri(
        name=user.username,
        issuer_name=f'ONE.GY ({domain})'
    )
    
    # Generate QR code as base64 PNG
    qr = qrcode.QRCode(version=1, box_size=6, border=2, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(provisioning_uri)
    qr.make(fit=True)
    img = qr.make_image(fill_color='white', back_color='#0a0a0a')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    qr_b64 = base64.b64encode(buf.read()).decode('utf-8')
    
    print(f'[AUTH] 2FA setup initiated for user: {user.username}')
    
    return jsonify({
        'secret': secret,
        'qr_code': f'data:image/png;base64,{qr_b64}'
    })

@app.route('/account/2fa/confirm', methods=['POST'])
@limiter.limit("10 per minute")
@login_required
def confirm_2fa():
    """Verify a TOTP code and enable 2FA for the user.

    AUDIT FIX H5: requires proof of the CURRENT credentials, matching
    /account/2fa/disable, so a hijacked session cannot bind a second factor."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'USER NOT FOUND'}), 404

    if user.two_factor_enabled:
        _clear_pending_2fa_setup()
        return jsonify({'error': '2FA IS ALREADY ENABLED'}), 400

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    # AUDIT FIX: validate JSON field types up front (a non-string password /
    # auth_token / totp_code used to 500 inside .strip()/.encode()).
    if not _json_string_fields_valid(data, ('password', 'auth_token', 'totp_code')):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    if not _verify_user_credentials(user,
                                    password=data.get('password'),
                                    auth_token=data.get('auth_token')):
        print(f'[AUTH] 2FA confirm REJECTED for user {user.username}: missing/invalid credential proof')
        # Abandon the enrolment so the pending secret stops riding on the cookie.
        _clear_pending_2fa_setup()
        return jsonify({'error': 'PASSWORD IS REQUIRED TO ENABLE TWO-FACTOR AUTHENTICATION'}), 403

    secret = _get_pending_2fa_setup()
    if not secret:
        return jsonify({'error': 'NO 2FA SETUP IN PROGRESS. PLEASE START AGAIN'}), 400

    totp_code = (data.get('totp_code') or '').strip()

    if not totp_code:
        return jsonify({'error': 'PLEASE ENTER A 2FA CODE'}), 400

    totp = pyotp.TOTP(secret)
    if not totp.verify(totp_code, valid_window=1):
        # Failed enrolment: burn the pending secret rather than leaving it live
        # in the signed cookie. The user restarts setup with a fresh secret.
        _clear_pending_2fa_setup()
        print(f'[AUTH] 2FA confirm failed for user {user.username}: pending secret discarded')
        return jsonify({'error': 'INVALID CODE. PLEASE START SETUP AGAIN'}), 400

    # Code verified — save secret (encrypted at rest) and enable 2FA
    user.two_factor_secret = _encrypt_totp_secret(secret)
    user.two_factor_enabled = True
    db.session.commit()

    _clear_pending_2fa_setup()

    print(f'[AUTH] 2FA enabled for user: {user.username}')

    return jsonify({'success': True, 'message': '2FA HAS BEEN ENABLED'})

@app.route('/account/2fa/disable', methods=['POST'])
@limiter.limit("5 per minute")
@login_required
def disable_2fa():
    """Disable 2FA for the user after verifying their password and current TOTP code."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'USER NOT FOUND'}), 404
    
    if not user.two_factor_enabled:
        return jsonify({'error': '2FA IS NOT ENABLED'}), 400
    
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    # AUDIT FIX: non-string password/auth_token/totp_code JSON values used to
    # raise AttributeError/TypeError inside .strip() and the auth helpers -> 500.
    if not _json_string_fields_valid(data, ('password', 'auth_token', 'totp_code')):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    password = data.get('password') or ''
    auth_token = data.get('auth_token') or ''
    totp_code = (data.get('totp_code') or '').strip()

    if not password and not auth_token:
        return jsonify({'error': 'PASSWORD IS REQUIRED'}), 400
    if not totp_code:
        return jsonify({'error': '2FA CODE IS REQUIRED'}), 400

    # Authenticate: split-key auth_token or legacy password (same flow as login)
    if not _verify_user_credentials(user, password=password, auth_token=auth_token):
        print(f'[AUTH] Disable 2FA credential proof failed for user {user.username}')
        return jsonify({'error': 'INCORRECT PASSWORD'}), 403

    # AUDIT FIX: disabling 2FA used to call totp.verify() directly, bypassing
    # BOTH shared controls that /verify-2fa enforces — the per-user failure
    # LOCKOUT (so the 6-digit code could be brute-forced at the route rate
    # limit forever) and the REPLAY guard (so a code already observed/used at
    # login could be replayed to switch the second factor off). Route every
    # code through the same atomic helpers: lockout check, replay check,
    # verify, atomic consume, and failure recording on every rejection.
    lock_remaining = _totp_lockout_remaining(user.id)
    if lock_remaining > 0:
        print(f'[AUTH] 2FA disable blocked by lockout for user: {user.username} ({lock_remaining}s remaining)')
        return jsonify({'error': f'TOO MANY INVALID 2FA CODES. TRY AGAIN IN {lock_remaining} SECONDS.'}), 429

    totp = pyotp.TOTP(_decrypt_totp_secret(user.two_factor_secret, user))
    if _totp_is_replayed(user.id, totp_code):
        print(f'[AUTH] 2FA disable replay attempt blocked for user: {user.username}')
        _record_failed_totp(user.id)
        return jsonify({'error': 'INVALID 2FA CODE'}), 400
    if not totp.verify(totp_code, valid_window=1):
        _record_failed_totp(user.id)
        return jsonify({'error': 'INVALID 2FA CODE'}), 400
    if not _totp_try_consume(user.id, totp_code):
        print(f'[AUTH] 2FA disable replay attempt blocked (concurrent consume) for user: {user.username}')
        _record_failed_totp(user.id)
        return jsonify({'error': 'INVALID 2FA CODE'}), 400
    _clear_failed_totp(user.id)

    user.two_factor_secret = None
    user.two_factor_enabled = False
    db.session.commit()

    _clear_pending_2fa_setup()
    print(f'[AUTH] 2FA disabled for user: {user.username}')

    return jsonify({'success': True, 'message': '2FA HAS BEEN DISABLED'})

@app.route('/account/sign-out-all', methods=['POST'])
@limiter.limit("5 per minute")
@login_required
def sign_out_all_devices():
    """AUDIT FIX M14 (companion): explicit 'sign out everywhere' action.

    /logout revokes only the acting session (see _revoke_current_session). This
    bumps session_epoch, which invalidates EVERY other session for the account —
    the app's only global revocation lever, previously reachable only as a side
    effect of a password change (and there was no password-change UI at all).
    The acting session is re-synced to the new epoch so the user stays logged in
    here."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'USER NOT FOUND'}), 404

    data = _json_object_body()
    if not _verify_user_credentials(user,
                                    password=data.get('password'),
                                    auth_token=data.get('auth_token')):
        print(f'[AUTH] Sign-out-all REJECTED for user {user.username}: missing/invalid credential proof')
        return jsonify({'error': 'PASSWORD IS REQUIRED'}), 403

    user.session_epoch = db.func.coalesce(User.session_epoch, 0) + 1  # atomic in SQL: concurrent rotations must not collapse into one
    _deactivate_user_api_keys(user.id)
    db.session.commit()
    session['session_epoch'] = int(user.session_epoch or 0)
    print(f'[AUTH] Sign-out-all for user: {user.username} (session_epoch rotated -> all other sessions invalidated)')
    return jsonify({'success': True, 'message': 'SIGNED OUT ON ALL OTHER DEVICES'})

@app.route('/account/2fa/status', methods=['GET'])
@login_required
def get_2fa_status():
    """Return the 2FA status for the current user."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'USER NOT FOUND'}), 404
    return jsonify({'two_factor_enabled': user.two_factor_enabled})

# ─── E2EE Key Management API ────────────────────────────────────────

@app.route('/api/keys', methods=['GET'])
@limiter.limit(default_rate_limit)
@login_required
def api_get_keys():
    """Return the current user's encrypted E2EE key material.
    The server never sees the raw keys — only encrypted blobs."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'USER NOT FOUND'}), 404
    
    if not user.has_e2ee_keys:
        return jsonify({
            'has_e2ee_keys': False,
            'split_key_version': user.split_key_version or 0,
            'auth_token_salt': user.auth_token_salt,
        })
    
    return jsonify({
        'has_e2ee_keys': True,
        'encrypted_master_key': user.encrypted_master_key,
        'master_key_nonce': user.master_key_nonce,
        'master_key_salt': user.master_key_salt,
        'public_key': user.public_key,
        'encrypted_private_key': user.encrypted_private_key,
        'private_key_nonce': user.private_key_nonce,
        'recovery_key_configured': bool(user.recovery_key_verifier or user.recovery_key_hash),
        'split_key_version': user.split_key_version or 0,
        'auth_token_salt': user.auth_token_salt
    })

def _user_has_e2ee_protected_content(user_id):
    """True when the account owns ANY resource whose access depends on the master key.

    AUDIT FIX C2: this used to require `Folder.encrypted_name IS NOT NULL`, so an
    E2EE folder created before filename encryption (or one whose name blob was
    never written) was invisible to the check — the folder's wrapped name key and
    every file inside it are still master-key-dependent. Any `is_e2e` folder now
    counts. Notes sent to this user as sender are also counted, since the
    pending blob is wrapped to this account's key material."""
    if File.query.filter_by(registered_user_id=user_id, is_e2e_encrypted=True).first():
        return True
    if Folder.query.filter(
        Folder.user_id == user_id,
        Folder.is_e2e == True
    ).first():
        return True
    if Note.query.filter_by(user_id=user_id).first():
        return True
    if Notebook.query.filter_by(user_id=user_id).first():
        return True
    if PendingNote.query.filter(
        db.or_(PendingNote.recipient_id == user_id, PendingNote.sender_id == user_id)
    ).first():
        return True
    return False

@app.route('/api/keys', methods=['POST'])
@limiter.limit("10 per minute")
@login_required
def api_update_keys():
    """INITIAL E2EE key setup for an account that has none.

    AUDIT FIX C2: this endpoint was @login_required ONLY. A stolen session cookie
    could POST one JSON body and irreversibly overwrite encrypted_master_key,
    encrypted_private_key, public_key, recovery_key_verifier AND rotate
    auth_token_hash / auth_token_salt / split_key_version / password_hash. The
    only gate was `has_e2ee_keys AND _user_has_e2ee_protected_content(...)`,
    which short-circuited entirely for has_e2ee_keys=0 accounts. session_epoch
    was not rotated either, so the attacker kept their session.

    Now:
      * Every caller must re-prove knowledge of the CURRENT credentials (same
        auth_token / password proof as /login, compared with
        hmac.compare_digest). No proof -> 403, nothing written.
      * _user_has_e2ee_protected_content stays as an ADDITIONAL, unconditional
        refusal — a re-key is never allowed to strand real encrypted data.
      * Auth credentials (auth_token_hash / auth_token_salt / split_key_version /
        password_hash) are ONLY rotated during genuine initial setup. Replacing
        key material never touches them as a side effect.
      * Every accepted write bumps session_epoch so every other session is
        evicted while the acting session remains valid.
    """
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'USER NOT FOUND'}), 404

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:  # a JSON array/scalar has no .get()
        return jsonify({'error': 'INVALID REQUEST'}), 400

    required = ['encrypted_master_key', 'master_key_nonce', 'master_key_salt',
                'public_key', 'encrypted_private_key', 'private_key_nonce']
    for field in required:
        if not data.get(field):
            return jsonify({'error': f'MISSING FIELD: {field.upper()}'}), 400

    _e2ee_err = _validate_e2ee_fields(
        data, required + ['recovery_key_hash', 'auth_token', 'auth_salt', 'current_auth_token'])
    if _e2ee_err:
        return jsonify({'error': _e2ee_err}), 400

    # AUDIT FIX M2: the initial-setup decision and the write below are wrapped in
    # the same per-user flock used by _create_user_api_key
    # (f'api_keys_user_<id>', prefix 'api_keys'). Previously
    # `is_initial_setup = not user.has_e2ee_keys` was evaluated on a stale
    # REPEATABLE READ snapshot: two concurrent POSTs (double-click, retry,
    # second tab) both saw has_e2ee_keys=0, both assigned
    # encrypted_master_key / auth_token_hash / auth_token_salt /
    # password_hash='split-key-v1', and the second commit silently overwrote
    # the first — the losing client was left holding a master key + auth token
    # the server no longer recognized (lockout + orphaned ciphertext).
    stale_snapshot_says_initial = not user.has_e2ee_keys
    user_id = user.id
    lock_file = _acquire_scoped_lock(f'api_keys_user_{int(user_id)}', prefix='api_keys')
    try:
        # End this request's REPEATABLE READ snapshot so the re-read below sees
        # any concurrent setup that committed while we waited for the lock.
        db.session.rollback()
        user = db.session.get(User, user_id, populate_existing=True)
        if not user:
            return jsonify({'error': 'USER NOT FOUND'}), 404

        is_initial_setup = not user.has_e2ee_keys
        if stale_snapshot_says_initial and not is_initial_setup:
            # A concurrent request completed initial setup while this one waited
            # on the lock. Never overwrite the winner's key material: the losing
            # client still derives everything from its own (now unknown) key.
            print(f'[AUTH] /api/keys initial setup CONFLICT for user {user.username}: '
                  'keys were already set up by a concurrent request')
            return jsonify({'error': 'E2EE KEYS WERE ALREADY SET UP BY ANOTHER REQUEST'}), 409

        if not is_initial_setup:
            # Existing keys: refuse outright if any master-key-dependent data exists.
            if _user_has_e2ee_protected_content(user.id):
                print(f'[AUTH] /api/keys overwrite BLOCKED for user {user.username}: E2EE data exists')
                return jsonify({'error': 'KEY OVERWRITE BLOCKED BECAUSE E2EE DATA ALREADY EXISTS'}), 409
        proof_password = data.get('current_password') or data.get('password')
        proof_token = data.get('current_auth_token')
        if not _verify_user_credentials(user, password=proof_password, auth_token=proof_token):
            action = 'INITIALIZE' if is_initial_setup else 'REPLACE'
            print(f'[AUTH] /api/keys {action.lower()} REJECTED for user {user.username}: '
                  'missing/invalid credential proof')
            return jsonify({'error': f'CURRENT CREDENTIALS ARE REQUIRED TO {action} ENCRYPTION KEYS'}), 403

        # Build every new value first, then assign — nothing is written before all
        # validation has passed.
        new_recovery_verifier = None
        new_recovery_wrap = None
        if data.get('recovery_key_hash'):
            new_recovery_verifier = _recovery_key_server_verifier(data['recovery_key_hash'])
            if not new_recovery_verifier:
                return jsonify({'error': 'RECOVERY KEY HASH IS INVALID'}), 400
            # AUDIT FIX M3: a recovery key now ships the server-side wrap of the
            # master key (it no longer IS the master key). Both fields arrive
            # together or not at all — a half-sent wrap is a client bug.
            _r_wrap = data.get('recovery_wrapped_master_key')
            _r_nonce = data.get('recovery_key_nonce')
            if bool(_r_wrap) != bool(_r_nonce):
                return jsonify({'error': 'RECOVERY KEY WRAP AND NONCE MUST BE SENT TOGETHER'}), 400
            if _r_wrap and _r_nonce:
                _wrap_err = _e2ee_wrap_field_error([
                    ('recovery_wrapped_master_key', _r_wrap, 48),
                    ('recovery_key_nonce', _r_nonce, 12),
                ])
                if _wrap_err:
                    return _wrap_err
                new_recovery_wrap = (_r_wrap, _r_nonce)

        new_auth_token_hash = None
        new_auth_salt = None
        auth_token = data.get('auth_token')
        auth_salt = data.get('auth_salt')
        if auth_token and auth_salt:
            if is_initial_setup:
                import hashlib as _hashlib_keys
                new_auth_token_hash = _hashlib_keys.sha256(auth_token.encode('utf-8')).hexdigest()
                new_auth_salt = auth_salt
            else:
                print(f'[AUTH] /api/keys ignored auth credential rotation for user {user.username} '
                      '(use /change-password)')
        elif is_initial_setup:
            return jsonify({'error': 'AUTH TOKEN AND SALT ARE REQUIRED FOR INITIAL KEY SETUP'}), 400

        # Conditional write: `user` was re-read INSIDE the lock and
        # is_initial_setup was recomputed from that fresh row, so this
        # assign->commit block only runs for the setup attempt that actually
        # won the race (and the auth-credential rotation only for a row that is
        # still has_e2ee_keys-falsy at write time).
        user.encrypted_master_key = data['encrypted_master_key']
        user.master_key_nonce = data['master_key_nonce']
        user.master_key_salt = data['master_key_salt']
        user.public_key = data['public_key']
        user.encrypted_private_key = data['encrypted_private_key']
        user.private_key_nonce = data['private_key_nonce']
        if new_recovery_verifier:
            user.recovery_key_verifier = new_recovery_verifier
            user.recovery_key_hash = None
            # AUDIT FIX M3: keep (verifier, wrap) coherent — a wrap belongs to the
            # key the verifier was derived from, never to a previously rotated one.
            if new_recovery_wrap:
                user.recovery_wrapped_master_key = new_recovery_wrap[0]
                user.recovery_key_nonce = new_recovery_wrap[1]
            else:
                user.recovery_wrapped_master_key = None
                user.recovery_key_nonce = None
        elif not is_initial_setup:
            # Replaced keys without new recovery material: the stored recovery
            # wrap belongs to the OLD master key, and recovering with it would
            # silently reinstall that key. Invalidate it instead.
            user.recovery_key_verifier = None
            user.recovery_key_hash = None
            user.recovery_wrapped_master_key = None
            user.recovery_key_nonce = None
        user.has_e2ee_keys = True
        if is_initial_setup and new_auth_token_hash and new_auth_salt:
            user.auth_token_hash = new_auth_token_hash
            user.auth_token_salt = new_auth_salt
            user.split_key_version = 1
            user.password_hash = 'split-key-v1'

        user.session_epoch = db.func.coalesce(User.session_epoch, 0) + 1  # atomic in SQL: concurrent rotations must not collapse into one

        db.session.commit()
        session['session_epoch'] = int(user.session_epoch or 0)

        if not is_initial_setup:
            print(f'[AUTH] E2EE keys REPLACED for user: {user.username} after credential re-proof '
                   '(session_epoch rotated -> all other sessions invalidated)')
        else:
            print(f'[AUTH] E2EE keys initialized for user: {user.username} '
                  f'(split_key_v{user.split_key_version}; session_epoch rotated)')
        return jsonify({'success': True})
    finally:
        _release_scoped_lock(lock_file)

@app.route('/api/keys/recovery/challenge', methods=['POST'])
@limiter.limit("5 per minute")
def api_recovery_key_challenge():
    """AUDIT FIX M3, step 1 of 2: pre-auth challenge for recovery-key recovery.

    The recovery key used to BE the master key, which made it unrotatable: file
    keys and folder/notebook name keys are wrapped directly under the master key
    and no recovery flow can re-encrypt them server-side. The recovery key is
    now an INDEPENDENT client secret and the server stores the master key
    wrapped under it (recovery_wrapped_master_key / recovery_key_nonce).

    Recovery therefore needs that wrap back before the client can re-wrap the
    master key under the new password. This endpoint releases it ONLY after the
    caller proves the CURRENT recovery key (same keyed-verifier comparison as
    the recovery POST, constant-time, same "5 per minute" limit). Legacy
    accounts (recovery key == master key, no stored wrap) answer
    {'legacy_recovery_key': True} so the client takes the direct-import path;
    after their first recovery they are migrated to the decoupled scheme.
    Failures return the same uniform 403 as the recovery POST — no enumeration."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:  # a JSON array/scalar has no .get()
        return jsonify({'error': 'INVALID REQUEST'}), 400

    username = data.get('username')
    provided_verifier = _recovery_key_server_verifier(data.get('recovery_key_hash'))
    if not username or not provided_verifier:
        return jsonify({'error': 'RECOVERY FAILED'}), 403

    user = User.query.filter_by(username=username).first()
    if not user or not user.has_e2ee_keys or not (user.recovery_key_verifier or user.recovery_key_hash):
        return jsonify({'error': 'RECOVERY FAILED'}), 403

    stored_verifier = user.recovery_key_verifier
    if not stored_verifier and user.recovery_key_hash:
        stored_verifier = _recovery_key_server_verifier(user.recovery_key_hash)
    if not stored_verifier or not hmac.compare_digest(provided_verifier, stored_verifier):
        return jsonify({'error': 'RECOVERY FAILED'}), 403

    if user.recovery_wrapped_master_key and user.recovery_key_nonce:
        return jsonify({
            'legacy_recovery_key': False,
            'recovery_wrapped_master_key': user.recovery_wrapped_master_key,
            'recovery_key_nonce': user.recovery_key_nonce,
        })
    return jsonify({'legacy_recovery_key': True})


@app.route('/api/keys/recovery', methods=['POST'])
@limiter.limit("5 per minute")
def api_recovery_key_login():
    """Recover account access using a recovery key, set a new password, and
    ROTATE the recovery key.

    AUDIT FIX M3: recovery_key_verifier used to be left untouched, so a
    compromised recovery key stayed a permanent backdoor — it could recover the
    account forever, and every recovery wiped 2FA again. Recovery now REQUIRES
    the client to generate a fresh recovery key and submit:
      * new_recovery_key_hash           — SHA-256 of the new key (base64),
        verified into recovery_key_verifier with the same
        _recovery_key_server_verifier derivation as setup;
      * new_recovery_wrapped_master_key — the master key wrapped under the NEW
        key (the key no longer IS the master key, so this wrap is the only way
        the new key can actually recover anything);
      * new_recovery_key_nonce.
    All three are mandatory (400 without them) and are stored in the SAME
    commit as the credential rotation, so the old recovery key stops verifying
    atomically with the rotation.

    AUDIT FIX M3 (concurrency): the write is wrapped in the same per-user flock
    ('api_keys_user_<id>') used by /api/keys and _create_user_api_key. This
    path used to be a bare check-then-write; now the authoritative recovery-key
    verification and every branch decision run against a FRESH row re-read
    inside the lock, so a recovery that loses a race against another recovery
    (or a credential change) fails closed instead of overwriting the winner's
    rotation.

    AUDIT FIX C3 (kept): the re-wrapped master key is MANDATORY whenever
    credentials rotate on an account with E2EE keys; values are built and
    validated before ANY assignment; the whole update commits atomically.

    AUDIT FIX H5 (kept): recovery also clears 2FA — there are no backup codes
    and no admin reset path."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:  # a JSON array/scalar has no .get()
        return jsonify({'error': 'INVALID REQUEST'}), 400

    username = data.get('username')
    new_password = data.get('new_password')
    new_password_length = data.get('new_password_length')
    new_encrypted_master_key = data.get('encrypted_master_key')
    new_master_key_nonce = data.get('master_key_nonce')
    new_master_key_salt = data.get('master_key_salt')

    new_auth_token = data.get('auth_token')
    new_auth_salt = data.get('auth_salt')

    # AUDIT FIX M3: the rotated recovery key is mandatory on every recovery.
    new_recovery_key_hash = data.get('new_recovery_key_hash')
    new_recovery_wrap = data.get('new_recovery_wrapped_master_key')
    new_recovery_nonce = data.get('new_recovery_key_nonce')

    if not username:
        return jsonify({'error': 'ALL FIELDS ARE REQUIRED'}), 400

    if not (new_recovery_key_hash and new_recovery_wrap and new_recovery_nonce):
        return jsonify({
            'error': 'NEW RECOVERY KEY IS REQUIRED '
                     '(NEW_RECOVERY_KEY_HASH, NEW_RECOVERY_WRAPPED_MASTER_KEY, NEW_RECOVERY_KEY_NONCE)'
        }), 400

    # AUDIT FIX M10: identical bounded password-length policy on all three paths.
    if new_auth_token and new_auth_salt:
        _pw_len_ok, _pw_len_err = _validate_asserted_password_length(new_password_length, new_password)
    else:
        _pw_len_ok, _pw_len_err = _validate_asserted_password_length(
            len(new_password) if isinstance(new_password, str) else None)
    if not _pw_len_ok:
        return jsonify({'error': _pw_len_err}), 400

    user = User.query.filter_by(username=username).first()
    if not user or not user.has_e2ee_keys or not (user.recovery_key_verifier or user.recovery_key_hash):
        return jsonify({'error': 'RECOVERY FAILED'}), 403

    # The client hashes the recovery key; the server compares only a keyed verifier.
    # AUDIT FIX M3: this is the FAST-PATH check only (cheap rejection before the
    # lock). The authoritative check runs again against a freshly-read row
    # inside the per-user lock below.
    provided_hash = data.get('recovery_key_hash')
    provided_verifier = _recovery_key_server_verifier(provided_hash)
    stored_verifier = user.recovery_key_verifier
    if not stored_verifier and user.recovery_key_hash:
        stored_verifier = _recovery_key_server_verifier(user.recovery_key_hash)
    if not provided_verifier or not stored_verifier or not hmac.compare_digest(provided_verifier, stored_verifier):
        return jsonify({'error': 'RECOVERY FAILED'}), 403

    # Validate size/type of re-wrapped key material before storing anything.
    _e2ee_err = _validate_e2ee_fields(data, [
        'encrypted_master_key', 'master_key_nonce', 'master_key_salt',
        'auth_token', 'auth_salt',
        'new_recovery_key_hash', 'new_recovery_wrapped_master_key', 'new_recovery_key_nonce',
    ])
    if _e2ee_err:
        return jsonify({'error': _e2ee_err}), 400

    # AUDIT FIX M3: exact decoded sizes for the rotated recovery material —
    # hash = 32-byte SHA-256, wrap = 32-byte master key + 16-byte GCM tag,
    # nonce = 12 bytes.
    _wrap_err = _e2ee_wrap_field_error([
        ('new_recovery_key_hash', new_recovery_key_hash, 32),
        ('new_recovery_wrapped_master_key', new_recovery_wrap, 48),
        ('new_recovery_key_nonce', new_recovery_nonce, 12),
    ])
    if _wrap_err:
        return _wrap_err

    # ── Build + validate EVERYTHING before touching the User row ──────────
    rotates_credentials = bool((new_auth_token and new_auth_salt) or new_password)

    # AUDIT FIX C3 INVARIANT (fast path): rotating credentials on an account
    # with E2EE keys REQUIRES the re-wrapped master key.
    if rotates_credentials:
        if not (new_encrypted_master_key and new_master_key_nonce and new_master_key_salt):
            print(f'[AUTH] Recovery REJECTED for user {username}: credential rotation without '
                  're-wrapped master key would permanently brick the vault')
            return jsonify({
                'error': 'RE-WRAPPED MASTER KEY IS REQUIRED (ENCRYPTED_MASTER_KEY, MASTER_KEY_NONCE, MASTER_KEY_SALT)'
            }), 400
        if not all(isinstance(v, str) and v for v in
                   (new_encrypted_master_key, new_master_key_nonce, new_master_key_salt)):
            return jsonify({'error': 'RE-WRAPPED MASTER KEY IS MALFORMED'}), 400

    # AUDIT FIX M3: serialize the whole read-decide-write per user with the same
    # scoped flock the /api/keys POST and _create_user_api_key use.
    user_id_for_lock = user.id
    lock_file = _acquire_scoped_lock(f'api_keys_user_{int(user_id_for_lock)}', prefix='api_keys')
    try:
        # End this request's REPEATABLE READ snapshot so the re-read below sees
        # any concurrent recovery/credential change that committed while this
        # request waited on the lock.
        db.session.rollback()
        user = db.session.get(User, user_id_for_lock, populate_existing=True)
        if not user or not user.has_e2ee_keys or not (user.recovery_key_verifier or user.recovery_key_hash):
            return jsonify({'error': 'RECOVERY FAILED'}), 403

        # Re-verify the CURRENT recovery key against the fresh row: a concurrent
        # recovery already rotated it, and the old key must not win the race.
        stored_verifier = user.recovery_key_verifier
        if not stored_verifier and user.recovery_key_hash:
            stored_verifier = _recovery_key_server_verifier(user.recovery_key_hash)
        if not stored_verifier or not hmac.compare_digest(provided_verifier, stored_verifier):
            print(f'[AUTH] Recovery REJECTED for user {username}: recovery key was '
                  'rotated by a concurrent change while this request waited on the lock')
            return jsonify({'error': 'RECOVERY FAILED'}), 403

        pending = {}
        if new_auth_token and new_auth_salt:
            import hashlib as _hashlib_recovery
            pending['auth_token_hash'] = _hashlib_recovery.sha256(new_auth_token.encode('utf-8')).hexdigest()
            pending['auth_token_salt'] = new_auth_salt
            pending['split_key_version'] = 1
            pending['password_hash'] = 'split-key-v1'
        elif user.split_key_version and user.split_key_version >= 1:
            print(f'[AUTH] Recovery rejected for split-key v1 user {username}: '
                  'new auth_token and auth_salt are required')
            return jsonify({'error': 'SPLIT-KEY CREDENTIALS REQUIRED FOR RECOVERY'}), 400
        else:
            pending['password_hash'] = generate_password_hash(new_password, method='pbkdf2:sha256')

        if new_encrypted_master_key:
            pending['encrypted_master_key'] = new_encrypted_master_key
            pending['master_key_nonce'] = new_master_key_nonce
            pending['master_key_salt'] = new_master_key_salt

        # AUDIT FIX M3: rotate the recovery credential in the SAME commit as the
        # credential rotation. The legacy recovery_key_hash column is cleared and
        # the verifier is always authoritative afterwards.
        pending['recovery_key_verifier'] = _recovery_key_server_verifier(new_recovery_key_hash)
        pending['recovery_key_hash'] = None
        pending['recovery_wrapped_master_key'] = new_recovery_wrap
        pending['recovery_key_nonce'] = new_recovery_nonce

        # ── Everything validated: assign and commit atomically ────────────
        for attr, value in pending.items():
            setattr(user, attr, value)

        had_2fa = bool(user.two_factor_enabled or user.two_factor_secret)
        user.two_factor_enabled = False
        user.two_factor_secret = None

        user.session_epoch = db.func.coalesce(User.session_epoch, 0) + 1  # atomic in SQL: concurrent rotations must not collapse into one
        _deactivate_user_api_keys(user.id)

        try:
            db.session.commit()
        except Exception as _e:
            db.session.rollback()
            print(f'[ERROR] Recovery commit failed for user {username}: {_e}')
            return jsonify({'error': 'RECOVERY FAILED'}), 500

        if had_2fa:
            print(f'[AUTH] 2FA cleared during recovery-key recovery for user: {username}')
        print(f'[AUTH] Account recovered via recovery key for user: {username} '
              f'(split_key_v{user.split_key_version}; recovery key rotated, session_epoch bumped)')
        return jsonify({'success': True})
    finally:
        _release_scoped_lock(lock_file)

@app.route('/api/user/<username>/public-key', methods=['GET'])
@limiter.limit(search_rate_limit)
@login_required
def api_get_user_public_key(username):
    """Get another user's public key for sharing encrypted files to them.
    Uses a tight (search-class) rate limit to slow username enumeration probes."""
    user = User.query.filter_by(username=username).first()
    if not user or not user.has_e2ee_keys or not user.public_key:
        return jsonify({'error': 'USER NOT FOUND OR NO E2EE KEYS'}), 404
    return jsonify({'username': user.username, 'public_key': user.public_key})

