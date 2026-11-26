# Device security for ONE.GY Desktop (desktop/docs/sync-api.md "Device security"):
# request signing keys, the server half of the at-rest key (unlock_share), the
# app lock PIN and system unlock (Windows Hello, fingerprint), unlock grants, the sync scope a locked device is limited to,
# and one-use tickets that sign the app's website view in.
# The request-time checks live in 110_auth_decorators.py.

DEVICE_GRANT_TTL_SECONDS = 15 * 60
DEVICE_PIN_MAX_FAILURES = 5
DEVICE_WEB_TICKET_TTL_SECONDS = 60
DEVICE_SCOPE_MAX_FOLDERS = 500
DEVICE_PIN_CHANGE_FRESH_SECONDS = 10 * 60  # a password unlock this recent also allows PIN changes
DEVICE_SYSTEM_UNLOCK_KINDS = ('hello', 'fingerprint')
DEVICE_SYSTEM_UNLOCK_SKEW_SECONDS = 300


def _valid_pop_public_key(value):
    """True for a base64 DER SubjectPublicKeyInfo of a P-256 key."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    try:
        key = serialization.load_der_public_key(base64.b64decode(value, validate=True))
    except (ValueError, TypeError):
        return False
    return isinstance(key, ec.EllipticCurvePublicKey) and isinstance(key.curve, ec.SECP256R1)


def _valid_hello_public_key(value):
    """True for a base64 DER SubjectPublicKeyInfo of an RSA key of 2048 bits or more
    (Windows Hello keys are RSA 2048)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    try:
        key = serialization.load_der_public_key(base64.b64decode(value, validate=True))
    except (ValueError, TypeError):
        return False
    return isinstance(key, rsa.RSAPublicKey) and key.key_size >= 2048


def _device_hello_signature_ok(device, signature_b64, ts):
    """RSA PKCS#1 v1.5 / SHA-256 over 'onegy-system-unlock-v1\n<device id>\n<ts>'
    with the device's Windows Hello key."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    try:
        key = serialization.load_der_public_key(base64.b64decode(device.system_unlock_key))
        key.verify(base64.b64decode(signature_b64, validate=True),
                   f'onegy-system-unlock-v1\n{device.id}\n{ts}'.encode('utf-8'),
                   padding.PKCS1v15(), hashes.SHA256())
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def _device_pin_expires_at(device):
    """The PIN and the system unlock work until the password was last entered +
    desktop_pin_max_age_days."""
    verified = _utc_aware(device.password_verified_at)
    if not (device.pin_verifier_hash or device.system_unlock_kind) or verified is None:
        return None
    return verified + timedelta(days=get_numeric_setting('desktop_pin_max_age_days'))


def _device_security_json(device):
    expires = _device_pin_expires_at(device)
    return {
        'lock_enabled': bool(device.lock_enabled),
        'pin_set': bool(device.pin_verifier_hash),
        'pin_expires_at': _sync_iso(expires) if expires else None,
        'pin_strict': bool(device.pin_strict),
        'pin_attempts_left': max(0, DEVICE_PIN_MAX_FAILURES - int(device.pin_failures or 0)),
        'pin_erased_at': _sync_iso(_utc_aware(device.pin_erased_at)) if device.pin_erased_at else None,
        'system_unlock': device.system_unlock_kind or None,
        'signed_requests': bool(device.pop_public_key),
    }


def _sha256_hex(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _device_require_grant():
    """403 grant_required unless this request carries the device's live grant."""
    if _request_has_device_grant(g.device):
        return None
    return _sync_error(403, 'grant_required', 'Unlock ONE.GY Desktop first')


def _device_issue_grant(device):
    raw = 'dgr_' + secrets.token_urlsafe(32)
    device.grant_hash = _sha256_hex(raw)
    device.grant_expires_at = datetime.now(timezone.utc) + timedelta(seconds=DEVICE_GRANT_TTL_SECONDS)
    return raw


def _device_unlock_share(device):
    if not device.unlock_share:
        device.unlock_share = base64.b64encode(secrets.token_bytes(32)).decode('ascii')
    return device.unlock_share


def _device_master_share(device):
    """The share that opens the device's sealed master key: given out only with
    the PIN or the password, never to a locked device on its own."""
    if not device.master_share:
        device.master_share = base64.b64encode(secrets.token_bytes(32)).decode('ascii')
    return device.master_share


def _device_row_for_update():
    """The current device row under a row lock: concurrent wrong PINs must each
    count (a read-modify-write on a snapshot let a burst cost one failure)."""
    device_id = g.device.id
    db.session.rollback()
    return Device.query.filter_by(id=device_id, is_active=True).populate_existing().with_for_update().first()


def _device_count_failures(device, user, what, count=1):
    """Wrong PINs and failed system unlocks (also ones the app saw locally, such
    as a wrong finger) share one count: the fifth in a row erases the PIN and
    the system unlock and ends the grant. Commits; returns the attempts left."""
    device.pin_failures = int(device.pin_failures or 0) + count
    left = max(0, DEVICE_PIN_MAX_FAILURES - device.pin_failures)
    if left == 0:
        device.pin_verifier_hash = None
        device.system_unlock_kind = None
        device.system_unlock_key = None
        device.pin_erased_at = datetime.now(timezone.utc)
        device.grant_hash = None
        device.grant_expires_at = None
        device.web_ticket_hash = None
    db.session.commit()
    print(f'[DEVICE] {what} for device {device.id} ({left} attempts left, user: {user.username})')
    if left == 0:
        print(f'[DEVICE] PIN and system unlock erased after {DEVICE_PIN_MAX_FAILURES} failed unlocks for device {device.id} (user: {user.username})')
    return left


def _device_check_system_proof(device, user, proof, ts):
    """None when the system unlock proof is right: a Windows Hello signature over
    a fresh, never reused timestamp, or the fingerprint token. Else the error
    response; a wrong proof counts as a failed unlock."""
    if not device.system_unlock_kind:
        return _sync_error(409, 'pin_locked' if device.pin_erased_at else 'system_unlock_not_set',
                           'Use your password to unlock this computer')
    expires = _device_pin_expires_at(device)
    if expires is None or expires <= datetime.now(timezone.utc):
        return _sync_error(409, 'pin_expired', 'Enter your password once to keep using quick unlock')
    if device.system_unlock_kind == 'hello':
        ok = (isinstance(ts, int) and not isinstance(ts, bool)
              and abs(ts) < 2 ** 53
              and abs(time.time() - ts) <= DEVICE_SYSTEM_UNLOCK_SKEW_SECONDS
              and ts > int(device.system_unlock_ts or 0)
              and _device_hello_signature_ok(device, proof, ts))
        if ok:
            device.system_unlock_ts = ts
    else:
        ok = hmac.compare_digest(_sha256_hex(proof), device.system_unlock_key or '')
    if ok:
        return None
    left = _device_count_failures(device, user, 'Failed system unlock')
    if left == 0:
        return _sync_error(409, 'pin_locked', 'Too many failed unlocks. Use your password to unlock this computer')
    return _sync_error(401, 'system_unlock_failed', 'System unlock failed', attempts_left=left)


def _device_check_credential(device, user, pin_proof, auth_token, system_proof='', system_ts=None):
    """None when auth_token (password, split-key), else system_proof, else
    pin_proof is right for this device (row locked by the caller), else the
    error response. A right password restarts the PIN's lifetime; wrong PINs and
    system proofs count and the fifth erases both (and the grant); the login
    lockout applies to the password."""
    if auth_token:
        normalized = (user.username or '').lower()
        locked, remaining = _login_lockout_status(normalized)
        if locked:
            resp = _sync_error(429, 'rate_limited', 'Too many failed sign-in attempts')
            resp.headers['Retry-After'] = str(remaining)
            return resp
        stored = user.auth_token_hash if user.split_key_version and user.split_key_version >= 1 and user.auth_token_hash else '0' * 64
        if not hmac.compare_digest(_sha256_hex(auth_token), stored):
            _record_failed_login(normalized)
            print(f'[DEVICE] Password check failed for device {device.id} (user: {user.username})')
            return _sync_error(401, 'invalid_credentials', 'Wrong password')
        _clear_failed_login(normalized)
        device.password_verified_at = datetime.now(timezone.utc)
        device.lock_enabled = True
    elif system_proof:
        err = _device_check_system_proof(device, user, system_proof, system_ts)
        if err:
            return err
    else:
        if not device.pin_verifier_hash:
            return _sync_error(409, 'pin_locked' if device.pin_failures else 'pin_not_set',
                               'Use your password to unlock this computer')
        expires = _device_pin_expires_at(device)
        if expires is None or expires <= datetime.now(timezone.utc):
            return _sync_error(409, 'pin_expired', 'Your PIN has expired. Enter your password once to keep using it')
        if not hmac.compare_digest(_sha256_hex(pin_proof), device.pin_verifier_hash):
            left = _device_count_failures(device, user, 'Wrong PIN')
            if left == 0:
                return _sync_error(409, 'pin_locked', 'Too many wrong PINs. Use your password to unlock this computer')
            return _sync_error(401, 'invalid_pin', 'Wrong PIN', attempts_left=left)
    device.pin_failures = 0
    return None


def _device_pin_change_allowed(device, data):
    """Changing or removing the PIN needs more than an unlocked app: the current
    PIN or the password in the body, or a password unlock in the last 10 minutes
    (sign-in and the lock screen's "PIN from now on"). None or the error response."""
    if not _json_string_fields_valid(data, ('current_pin_proof', 'auth_token')):
        return _sync_error(400, 'bad_request', 'Invalid request')
    pin_proof = data.get('current_pin_proof') or ''
    auth_token = data.get('auth_token') or ''
    if pin_proof or auth_token:
        return _device_check_credential(device, g.api_user, pin_proof, auth_token)
    verified = _utc_aware(device.password_verified_at)
    if verified and (datetime.now(timezone.utc) - verified).total_seconds() <= DEVICE_PIN_CHANGE_FRESH_SECONDS:
        return None
    return _sync_error(401, 'credential_required', 'Enter your current PIN or your password')


@app.route('/apiv1/devices/self/pop-key', methods=['POST'])
@csrf.exempt
@limiter.limit("10 per minute")
@device_auth_required
def apiv1_device_pop_key():
    """Enroll a request-signing key for a device authorized before signing existed.
    Only once: a device that has a key keeps it until it is removed."""
    data = _sync_json_body()
    if data is None or not _json_string_fields_valid(data, ('public_key',)):
        return _sync_error(400, 'bad_request', 'Invalid request')
    device = g.device
    if device.pop_public_key:
        return _sync_error(409, 'conflict', 'This device already signs its requests')
    # A stolen token must not enroll its own key first, lock or no lock: the
    # grant proves the password or PIN (AUDIT FIX C5). A lock-less device gets
    # one with its first password unlock, which also turns the lock on.
    err = _device_require_grant()
    if err:
        return err
    if not _valid_pop_public_key(data.get('public_key') or ''):
        return _sync_error(400, 'bad_request', 'public_key must be a base64 P-256 public key', field='public_key')
    device.pop_public_key = data['public_key']
    db.session.commit()
    print(f'[DEVICE] Device {device.id} enrolled a request-signing key (user: {g.api_user.username})')
    return jsonify(_device_security_json(device))


@app.route('/apiv1/devices/self/unlock', methods=['POST'])
@csrf.exempt
@limiter.limit("10 per minute")
@device_auth_required
def apiv1_device_unlock():
    """{} -> unlock_share (not with pin_strict); {"pin_proof"}, {"system_proof",
    "system_ts"?} or {"auth_token"} (password) -> unlock_share + a grant. The PIN is a stand-in for the password
    with two limits: it works only desktop_pin_max_age_days after the password
    was last entered here (a PIN unlock never extends that), and five wrong PINs
    in a row erase it. Either way only the password unlocks until then. The first
    password unlock turns the app lock on for good (new clients)."""
    data = _sync_json_body()
    if data is None or not _json_string_fields_valid(data, ('pin_proof', 'auth_token', 'system_proof')):
        return _sync_error(400, 'bad_request', 'Invalid request')
    pin_proof = data.get('pin_proof') or ''
    auth_token = data.get('auth_token') or ''
    system_proof = data.get('system_proof') or ''
    device = _device_row_for_update()
    if device is None:
        return _sync_error(401, 'device_revoked', 'This device was removed')

    if not pin_proof and not auth_token and not system_proof:
        if device.pin_strict:
            return _sync_error(401, 'pin_required', 'Enter your PIN to unlock this computer')
        share = _device_unlock_share(device)
        db.session.commit()
        return jsonify({'unlock_share': share, **_device_security_json(device)})

    err = _device_check_credential(device, g.api_user, pin_proof, auth_token, system_proof, data.get('system_ts'))
    if err:
        return err
    grant = _device_issue_grant(device)
    share = _device_unlock_share(device)
    master_share = _device_master_share(device)
    db.session.commit()
    return jsonify({'unlock_share': share, 'master_share': master_share, 'grant': grant,
                    'grant_expires_at': _sync_iso(device.grant_expires_at), **_device_security_json(device)})


@app.route('/apiv1/devices/self/grant', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_device_grant_refresh():
    """Keep the app unlocked: slide the grant's expiry."""
    err = _device_require_grant()
    if err:
        return err
    g.device.grant_expires_at = datetime.now(timezone.utc) + timedelta(seconds=DEVICE_GRANT_TTL_SECONDS)
    db.session.commit()
    return jsonify({'grant_expires_at': _sync_iso(g.device.grant_expires_at)})


@app.route('/apiv1/devices/self/grant', methods=['DELETE'])
@csrf.exempt
@device_auth_required
def apiv1_device_grant_drop():
    """App locked: the grant ends, and the website sessions it signed in keep only the lock-free routes (music)."""
    g.device.grant_hash = None
    g.device.grant_expires_at = None
    g.device.web_ticket_hash = None
    db.session.commit()
    return '', 204


@app.route('/apiv1/devices/self/pin', methods=['PUT'])
@csrf.exempt
@limiter.limit("10 per minute")
@device_auth_required
def apiv1_device_set_pin():
    """{"pin_proof", "strict"?} with a grant: set or change the app lock PIN (opt-in;
    without one the app lock asks for the password). Also needs the current PIN or
    the password (_device_pin_change_allowed). Setting a PIN does not extend its
    lifetime: that runs from the last password unlock."""
    err = _device_require_grant()
    if err:
        return err
    if g.device.password_verified_at is None:
        return _sync_error(409, 'password_required', 'Enter your password on this computer first')
    data = _sync_json_body()
    if data is None or not _json_string_fields_valid(data, ('pin_proof',)):
        return _sync_error(400, 'bad_request', 'Invalid request')
    pin_proof = data.get('pin_proof') or ''
    strict = data.get('strict', g.device.pin_strict)
    if len(pin_proof) < 32 or not isinstance(strict, bool):
        return _sync_error(400, 'bad_request', 'pin_proof and a boolean strict are required')
    device = _device_row_for_update()
    if device is None:
        return _sync_error(401, 'device_revoked', 'This device was removed')
    err = _device_pin_change_allowed(device, data)
    if err:
        return err
    device.pin_verifier_hash = _sha256_hex(pin_proof)
    device.pin_failures = 0
    device.pin_erased_at = None
    device.pin_strict = strict
    device.lock_enabled = True
    db.session.commit()
    print(f'[DEVICE] App lock PIN set for device {device.id} (strict={strict}, user: {g.api_user.username})')
    return jsonify(_device_security_json(device))


@app.route('/apiv1/devices/self/pin', methods=['DELETE'])
@csrf.exempt
@limiter.limit("10 per minute")
@device_auth_required
def apiv1_device_remove_pin():
    """With a grant and the current PIN or password ({"current_pin_proof"} or
    {"auth_token"}, see _device_pin_change_allowed): stop using a PIN; the app
    lock then asks for the password."""
    err = _device_require_grant()
    if err:
        return err
    data = _sync_json_body() or {}
    device = _device_row_for_update()
    if device is None:
        return _sync_error(401, 'device_revoked', 'This device was removed')
    err = _device_pin_change_allowed(device, data)
    if err:
        return err
    device.pin_verifier_hash = None
    device.pin_failures = 0
    device.pin_strict = False
    db.session.commit()
    print(f'[DEVICE] App lock PIN removed for device {device.id} (user: {g.api_user.username})')
    return jsonify(_device_security_json(device))


@app.route('/apiv1/devices/self/system-unlock', methods=['PUT'])
@csrf.exempt
@limiter.limit("10 per minute")
@device_auth_required
def apiv1_device_set_system_unlock():
    """{"kind": "hello", "public_key"} (Windows Hello RSA key) or {"kind":
    "fingerprint", "token"} with a grant, plus the current PIN or password like a
    PIN change: unlock with the operating system's own check. It shares the
    PIN's lifetime and its count of failed unlocks."""
    err = _device_require_grant()
    if err:
        return err
    if g.device.password_verified_at is None:
        return _sync_error(409, 'password_required', 'Enter your password on this computer first')
    data = _sync_json_body()
    if data is None or not _json_string_fields_valid(data, ('kind', 'public_key', 'token')):
        return _sync_error(400, 'bad_request', 'Invalid request')
    kind = data.get('kind') or ''
    if kind == 'hello' and _valid_hello_public_key(data.get('public_key') or ''):
        key = data['public_key']
    elif kind == 'fingerprint' and len(data.get('token') or '') >= 32:
        key = _sha256_hex(data['token'])
    else:
        return _sync_error(400, 'bad_request', 'kind hello with an RSA public_key, or fingerprint with a token')
    device = _device_row_for_update()
    if device is None:
        return _sync_error(401, 'device_revoked', 'This device was removed')
    err = _device_pin_change_allowed(device, data)
    if err:
        return err
    device.system_unlock_kind = kind
    device.system_unlock_key = key
    device.system_unlock_ts = 0
    device.pin_failures = 0
    device.lock_enabled = True
    db.session.commit()
    print(f'[DEVICE] System unlock ({kind}) turned on for device {device.id} (user: {g.api_user.username})')
    return jsonify(_device_security_json(device))


@app.route('/apiv1/devices/self/system-unlock', methods=['DELETE'])
@csrf.exempt
@limiter.limit("10 per minute")
@device_auth_required
def apiv1_device_remove_system_unlock():
    """With a grant: stop unlocking with the operating system's check."""
    err = _device_require_grant()
    if err:
        return err
    device = g.device
    device.system_unlock_kind = None
    device.system_unlock_key = None
    db.session.commit()
    print(f'[DEVICE] System unlock turned off for device {device.id} (user: {g.api_user.username})')
    return jsonify(_device_security_json(device))


@app.route('/apiv1/devices/self/unlock-failed', methods=['POST'])
@csrf.exempt
@limiter.limit("10 per minute")
@device_auth_required
def apiv1_device_unlock_failed():
    """{"count": 1..5}: failed unlocks the app saw itself (a wrong finger). They
    count like wrong PINs, so the fifth erases the PIN and the system unlock. No
    grant needed: it can only lock the device down."""
    data = _sync_json_body()
    count = data.get('count', 1) if data is not None else None
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= DEVICE_PIN_MAX_FAILURES:
        return _sync_error(400, 'bad_request', 'count must be 1 to 5')
    device = _device_row_for_update()
    if device is None:
        return _sync_error(401, 'device_revoked', 'This device was removed')
    if device.pin_verifier_hash or device.system_unlock_kind:
        _device_count_failures(device, g.api_user, f'{count} failed local unlock(s)', count)
    return jsonify(_device_security_json(device))


@app.route('/apiv1/devices/self/scope', methods=['PUT'])
@csrf.exempt
@device_auth_required
def apiv1_device_set_scope():
    """{"root": bool, "folders": [folder ids]} with a grant: what this device may
    read and write while its app is locked (its sync and backup roots)."""
    err = _device_require_grant()
    if err:
        return err
    data = _sync_json_body()
    if data is None:
        return _sync_error(400, 'bad_request', 'Invalid request')
    root = data.get('root', False)
    folders = data.get('folders', [])
    if (not isinstance(root, bool) or not isinstance(folders, list) or len(folders) > DEVICE_SCOPE_MAX_FOLDERS
            or not all(isinstance(f, int) and not isinstance(f, bool) and f > 0 for f in folders)):
        return _sync_error(400, 'bad_request', 'root must be a boolean and folders a list of folder ids')
    folders = sorted(set(folders))
    if folders:
        owned = {row[0] for row in db.session.query(Folder.id).filter(
            Folder.id.in_(folders), Folder.user_id == g.api_user.id)}
        if owned != set(folders):
            return _sync_error(404, 'not_found', 'Folder not found')
    g.device.sync_scope = json.dumps({'root': root, 'folders': folders})
    db.session.commit()
    return jsonify({'root': root, 'folders': folders})


@app.route('/apiv1/devices/self/web-session', methods=['POST'])
@csrf.exempt
@limiter.limit("30 per minute")
@device_auth_required
def apiv1_device_web_session():
    """With a grant: a one-use ticket (60 s) for GET /desktop/session."""
    err = _device_require_grant()
    if err:
        return err
    raw = 'wst_' + secrets.token_urlsafe(32)
    g.device.web_ticket_hash = _sha256_hex(raw)
    g.device.web_ticket_expires_at = datetime.now(timezone.utc) + timedelta(seconds=DEVICE_WEB_TICKET_TTL_SECONDS)
    db.session.commit()
    return jsonify({'ticket': raw, 'expires_in': DEVICE_WEB_TICKET_TTL_SECONDS})


TREE_KEYS_MAX_ITEMS = 500


def _tree_wrap_field_ok(wrap, nonce):
    """A key-tree wrap is AES-256-GCM of a 32-byte key: 48 bytes + a 12-byte nonce."""
    try:
        return (len(base64.b64decode(wrap or '', validate=True)) == 48
                and len(base64.b64decode(nonce or '', validate=True)) == 12)
    except (ValueError, TypeError):
        return False


def _tree_scope_allows(folder_id):
    """Inside this request's reach: unlocked, or within the device's sync scope."""
    if g.device_unlocked:
        return True
    try:
        scope = json.loads(g.device.sync_scope or '{}')
    except ValueError:
        scope = {}
    if scope.get('root') is True:
        return True
    roots = {f for f in (scope.get('folders') or []) if isinstance(f, int)}
    return folder_id is not None and bool(roots.intersection(_folder_ancestor_ids(folder_id)))


@app.route('/apiv1/sync/tree-keys', methods=['POST'])
@csrf.exempt
# The engine calls this once per file and folder it creates, so the limit sits
# above uploads (1000/min) plus folder creates (600/min): at 120 a first sync
# of many small files stopped for the rest of every minute.
@limiter.limit("2000 per minute")
@device_auth_required
def apiv1_sync_tree_keys():
    """Store key-tree wraps (sync-api.md "Key tree"). Key material only: no name,
    content or place changes, so backups do not restrict it. A locked app may
    write only inside its scope. A folder key is compare-and-set
    (if_tree_key_wrap = the wrap the client read, null for none), so two devices
    never wrap children under different folder keys; on a mismatch that folder
    (and its name-key wrap) is skipped and reported in conflicts."""
    data = _sync_json_body()
    folders = data.get('folders', []) if data is not None else None
    files = data.get('files', []) if data is not None else None
    if not isinstance(folders, list) or not isinstance(files, list) or len(folders) + len(files) > TREE_KEYS_MAX_ITEMS:
        return _sync_error(400, 'bad_request', f'folders and files: lists of at most {TREE_KEYS_MAX_ITEMS} items')
    uid = g.api_user.id
    # The if_tree_key_wrap compare-and-set needs current reads under locks, in
    # the sync lock order (user row, then folder rows); otherwise two devices
    # both see no wrap and both write one.
    db.session.rollback()
    _sync_lock_user_row(uid)
    out_folders, out_files, conflicts = [], [], []

    def parent_ref(item, key):
        v = item.get(key)
        return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None

    for item in folders:
        if not isinstance(item, dict) or not isinstance(item.get('id'), int):
            return _sync_error(400, 'bad_request', 'folder items need an id')
        folder = _sync_load_owned_folder(item['id'], for_update=True)
        if folder is None:
            return _sync_error(404, 'not_found', f'Folder {item["id"]} not found')
        if not _tree_scope_allows(folder.id):
            return _sync_error(403, 'locked', 'ONE.GY Desktop is locked; unlock it to reach files outside your synced folders')
        if 'tree_key_wrap' in item:
            parent = parent_ref(item, 'tree_key_parent_id')
            if parent is None or not _tree_wrap_field_ok(item.get('tree_key_wrap'), item.get('tree_key_nonce')):
                return _sync_error(400, 'bad_request', 'tree_key_wrap, tree_key_nonce and tree_key_parent_id are required', field='tree_key_wrap')
            if item.get('if_tree_key_wrap', folder.tree_key_wrap) != folder.tree_key_wrap:
                conflicts.append(folder.id)
                out_folders.append(folder)
                continue
            folder.tree_key_wrap, folder.tree_key_nonce, folder.tree_key_parent_id = item['tree_key_wrap'], item['tree_key_nonce'], parent
        if 'tree_name_key_wrap' in item:
            if not _tree_wrap_field_ok(item.get('tree_name_key_wrap'), item.get('tree_name_key_nonce')):
                return _sync_error(400, 'bad_request', 'tree_name_key_wrap and tree_name_key_nonce must be a key wrap', field='tree_name_key_wrap')
            folder.tree_name_key_wrap, folder.tree_name_key_nonce = item['tree_name_key_wrap'], item['tree_name_key_nonce']
        out_folders.append(folder)
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str):
            return _sync_error(400, 'bad_request', 'file items need an id')
        file = _sync_owned_files_query(uid).filter(File.id == item['id']).first()
        if file is None or not file.is_e2e_encrypted:
            return _sync_error(404, 'not_found', f'File {item["id"]} not found')
        if not _tree_scope_allows(file.folder_id):
            return _sync_error(403, 'locked', 'ONE.GY Desktop is locked; unlock it to reach files outside your synced folders')
        parent = parent_ref(item, 'tree_key_folder_id')
        if parent is None or not _tree_wrap_field_ok(item.get('tree_file_key_wrap'), item.get('tree_file_key_nonce')):
            return _sync_error(400, 'bad_request', 'tree_file_key_wrap, tree_file_key_nonce and tree_key_folder_id are required', field='tree_file_key_wrap')
        file.tree_file_key_wrap, file.tree_file_key_nonce, file.tree_key_folder_id = item['tree_file_key_wrap'], item['tree_file_key_nonce'], parent
        out_files.append(file)
    db.session.commit()
    return jsonify({'folders': [_sync_folder_node(f) for f in out_folders],
                    'files': [_sync_file_node(f) for f in out_files], 'conflicts': conflicts})


@app.route('/desktop/whoami', methods=['GET'])
@login_required
def desktop_whoami():
    """The signed-in website user, for the desktop app's site bridge: it hands the
    page the device's key only when this matches the device's account."""
    return jsonify({'user_id': session['logged_in_user_id'], 'device_id': session.get('device_id')})


@app.route('/desktop/session', methods=['GET'])
@limiter.limit("30 per minute")
def desktop_session():
    """Sign the desktop app's website view in with a ticket from
    /apiv1/devices/self/web-session, sent in X-Onegy-Desktop-Ticket (a header, so
    a link or a cross-site form can never log anyone in). The session is bound
    to the device: it ends when the device is removed, and while its app is
    locked it reaches only the lock-free routes (desktop_lock_free)."""
    raw = request.headers.get('X-Onegy-Desktop-Ticket', '')
    ticket_hash = _sha256_hex(raw) if raw else None
    device = Device.query.filter_by(web_ticket_hash=ticket_hash).first() if raw else None
    expires = _utc_aware(device.web_ticket_expires_at) if device else None
    if device is not None:
        # One use: only the request whose UPDATE clears the ticket may sign in.
        consumed = Device.query.filter_by(id=device.id, web_ticket_hash=ticket_hash).update(
            {Device.web_ticket_hash: None, Device.web_ticket_expires_at: None}, synchronize_session=False)
        db.session.commit()
        if consumed != 1:
            device = None
    if (device is None or not device.is_active or not expires or expires < datetime.now(timezone.utc)
            or not _device_grant_live(device) or not get_setting('allow_desktop_sync')):
        flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
        return redirect(url_for('login'))
    user = db.session.get(User, device.user_id)
    if user is None:
        return redirect(url_for('login'))
    guest_id = session.get('user_id')
    session.clear()
    if guest_id:
        session['user_id'] = guest_id
    session['logged_in_user_id'] = user.id
    session['session_epoch'] = int(user.session_epoch or 0)
    session['username'] = user.username
    session['avatar_color'] = user.avatar_color or '#555'
    session['device_id'] = device.id
    _mint_session_sid()
    session.permanent = True
    print(f'[AUTH] User signed in through desktop device {device.id}: {user.username}')
    return redirect(_safe_next_path(request.args.get('next')))
