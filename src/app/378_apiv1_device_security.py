# Device security for ONE.GY Desktop (desktop/docs/sync-api.md "Device security"):
# request signing keys, the server half of the at-rest key (unlock_share), the
# app lock PIN, unlock grants, the sync scope a locked device is limited to,
# and one-use tickets that sign the app's website view in.
# The request-time checks live in 110_auth_decorators.py.

DEVICE_GRANT_TTL_SECONDS = 15 * 60
DEVICE_PIN_MAX_FAILURES = 5
DEVICE_WEB_TICKET_TTL_SECONDS = 60
DEVICE_SCOPE_MAX_FOLDERS = 500


def _valid_pop_public_key(value):
    """True for a base64 DER SubjectPublicKeyInfo of a P-256 key."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    try:
        key = serialization.load_der_public_key(base64.b64decode(value, validate=True))
    except (ValueError, TypeError):
        return False
    return isinstance(key, ec.EllipticCurvePublicKey) and isinstance(key.curve, ec.SECP256R1)


def _device_pin_expires_at(device):
    """The PIN works until the password was last entered + desktop_pin_max_age_days."""
    verified = _utc_aware(device.password_verified_at)
    if not device.pin_verifier_hash or verified is None:
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
    """{} -> unlock_share (not with pin_strict); {"pin_proof"} or {"auth_token"}
    (password) -> unlock_share + a grant. The PIN is a stand-in for the password
    with two limits: it works only desktop_pin_max_age_days after the password
    was last entered here (a PIN unlock never extends that), and five wrong PINs
    in a row erase it. Either way only the password unlocks until then. The first
    password unlock turns the app lock on for good (new clients)."""
    data = _sync_json_body()
    if data is None or not _json_string_fields_valid(data, ('pin_proof', 'auth_token')):
        return _sync_error(400, 'bad_request', 'Invalid request')
    pin_proof = data.get('pin_proof') or ''
    auth_token = data.get('auth_token') or ''
    # Current read under the device row lock: concurrent wrong PINs must each
    # count (a read-modify-write on a snapshot let a burst cost one failure).
    device_id = g.device.id
    db.session.rollback()
    device = Device.query.filter_by(id=device_id, is_active=True).populate_existing().with_for_update().first()
    if device is None:
        return _sync_error(401, 'device_revoked', 'This device was removed')
    user = g.api_user

    if not pin_proof and not auth_token:
        if device.pin_strict:
            return _sync_error(401, 'pin_required', 'Enter your PIN to unlock this computer')
        share = _device_unlock_share(device)
        db.session.commit()
        return jsonify({'unlock_share': share, **_device_security_json(device)})

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
            print(f'[DEVICE] Password unlock failed for device {device.id} (user: {user.username})')
            return _sync_error(401, 'invalid_credentials', 'Wrong password')
        _clear_failed_login(normalized)
        device.password_verified_at = datetime.now(timezone.utc)
        device.lock_enabled = True
    else:
        if not device.pin_verifier_hash:
            return _sync_error(409, 'pin_locked' if device.pin_failures else 'pin_not_set',
                               'Use your password to unlock this computer')
        expires = _device_pin_expires_at(device)
        if expires is None or expires <= datetime.now(timezone.utc):
            return _sync_error(409, 'pin_expired', 'Your PIN has expired. Enter your password once to keep using it')
        if not hmac.compare_digest(_sha256_hex(pin_proof), device.pin_verifier_hash):
            device.pin_failures = int(device.pin_failures or 0) + 1
            left = DEVICE_PIN_MAX_FAILURES - device.pin_failures
            if left <= 0:
                device.pin_verifier_hash = None
                device.grant_hash = None
                device.grant_expires_at = None
            db.session.commit()
            print(f'[DEVICE] Wrong PIN for device {device.id} ({max(left, 0)} attempts left, user: {user.username})')
            if left <= 0:
                return _sync_error(409, 'pin_locked', 'Too many wrong PINs. Use your password to unlock this computer')
            return _sync_error(401, 'invalid_pin', 'Wrong PIN', attempts_left=left)
    device.pin_failures = 0
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
    """App locked: the grant and every website session it signed in stop working."""
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
    without one the app lock asks for the password). Setting a PIN does not extend
    its lifetime: that runs from the last password unlock."""
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
    device = g.device
    device.pin_verifier_hash = _sha256_hex(pin_proof)
    device.pin_failures = 0
    device.pin_strict = strict
    device.lock_enabled = True
    db.session.commit()
    print(f'[DEVICE] App lock PIN set for device {device.id} (strict={strict}, user: {g.api_user.username})')
    return jsonify(_device_security_json(device))


@app.route('/apiv1/devices/self/pin', methods=['DELETE'])
@csrf.exempt
@device_auth_required
def apiv1_device_remove_pin():
    """With a grant: stop using a PIN; the app lock then asks for the password."""
    err = _device_require_grant()
    if err:
        return err
    device = g.device
    device.pin_verifier_hash = None
    device.pin_failures = 0
    device.pin_strict = False
    db.session.commit()
    print(f'[DEVICE] App lock PIN removed for device {device.id} (user: {g.api_user.username})')
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
    to the device: it ends when the device is removed or its app locks."""
    raw = request.headers.get('X-Onegy-Desktop-Ticket', '')
    device = Device.query.filter_by(web_ticket_hash=_sha256_hex(raw)).first() if raw else None
    expires = _utc_aware(device.web_ticket_expires_at) if device else None
    if device is not None:
        device.web_ticket_hash = None
        device.web_ticket_expires_at = None
        db.session.commit()
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
    target = request.args.get('next') or ''
    if not target.startswith('/') or target.startswith('//') or '\\' in target:
        target = url_for('files')
    return redirect(target)
