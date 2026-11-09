# Desktop sync API: devices, change feed, tree, content and mutations (desktop/docs/sync-api.md).
#
# Device routes authenticate with Bearer dev_ tokens (device_auth_required, part 110).
# Sequence numbers come from 045_sync_feed.py. Mutations reuse the website's
# helpers and locks. Lock order: flocks in their canonical order (quota ->
# lifecycle -> folder tree; folder creation -> lifecycle), then the user row
# (_sync_lock_user_row), then file/folder rows. The flush listener locks the user
# row before writing data rows, so taking it first here keeps one order and makes
# if_seq checks exact. E2EE names are never logged.

SYNC_PROTOCOL = 1
SYNC_CHUNK_SIZE = 64 * 1024 * 1024
SYNC_SMALL_UPLOAD_MAX = 8 * 1024 * 1024
SYNC_MAX_PARALLEL_TRANSFERS = 2
SYNC_POLL_MIN_SECONDS = 5
_SYNC_PLATFORMS = ('windows', 'linux')
_SYNC_CLIENT_VERSION_RE = re.compile(r'[0-9A-Za-z.+-]{1,32}')
_SYNC_CHANGES_DEFAULT_LIMIT = 500
_SYNC_CHANGES_MAX_LIMIT = 1000
_SYNC_TREE_DEFAULT_LIMIT = 1000
_SYNC_TREE_MAX_LIMIT = 2000


# ─── Shared helpers (also used by 376_apiv1_sync_uploads.py) ─────────────────

def _sync_error(http_status, code, message, **extra):
    """JSON error in the sync API shape; returns a Response so callers can add headers."""
    resp = jsonify({'error': message, 'code': code, **extra})
    resp.status_code = http_status
    return resp


def _sync_iso(dt):
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def _sync_json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


def _sync_folder_node(folder):
    is_e2e = folder.is_e2e is True and bool(folder.encrypted_name)
    return {
        'type': 'folder',
        'id': folder.id,
        'parent_id': folder.parent_id,
        'seq': int(folder.change_seq or 0),
        'is_trashed': bool(folder.is_trashed),
        'is_e2e': is_e2e,
        'name': folder.name,
        'encrypted_name': folder.encrypted_name if is_e2e else None,
        'name_nonce': folder.name_nonce if is_e2e else None,
        'encrypted_name_key': folder.encrypted_name_key if is_e2e else None,
        'name_key_nonce': folder.name_key_nonce if is_e2e else None,
        'is_backup': bool(folder.is_backup),
        'backup_device_id': folder.backup_device_id,
        'updated_at': _sync_iso(folder.updated_at or folder.created_at),
        'folder_link_share_token': _sync_folder_link_token(folder.id),
    }


def _sync_file_node(file):
    is_e2e = bool(file.is_e2e_encrypted)
    link_token = _sync_folder_link_token(file.folder_id)
    return {
        'type': 'file',
        'id': file.id,
        'folder_id': file.folder_id,
        'seq': int(file.change_seq or 0),
        'is_trashed': bool(file.is_trashed),
        'is_e2e': is_e2e,
        'name': file.orig_name,
        'encrypted_name': file.encrypted_name if is_e2e else None,
        'name_nonce': file.name_nonce if is_e2e else None,
        'encrypted_file_key': file.encrypted_file_key if is_e2e else None,
        'file_key_nonce': file.file_key_nonce if is_e2e else None,
        'stored_extension': file.stored_extension,
        'size': file.size,
        'disk_size': file.disk_size,
        'payload_checksum': file.payload_checksum,
        'content_version': int(file.content_version or 1),
        'encrypted_meta': file.encrypted_meta if is_e2e else None,
        'meta_nonce': file.meta_nonce if is_e2e else None,
        'uploaded_at': _sync_iso(file.get_upload_time_aware()),
        'trashed_by_device_id': file.trashed_by_device_id,
        'folder_link_share_token': link_token,
        'needs_folder_link_key': bool(is_e2e and link_token and file.encrypted_file_key
                                      and not file.folder_link_encrypted_file_key),
    }


# ─── Link-shared folders (sync-api.md "Link-shared folders") ─────────────────

_SYNC_FOLDER_LINK_FIELDS = ('folder_link_encrypted_file_key', 'folder_link_file_key_nonce', 'folder_link_share_token')


def _sync_folder_link_token(folder_id):
    """Share token whose link key must wrap the keys of E2EE files placed directly
    in folder_id (the website's get_shared_ancestor_info rule), or None. Computed
    on read: an ancestor's share change does not bump seq."""
    if folder_id is None:
        return None
    info = get_shared_ancestor_info(folder_id)
    return info['share_token'] if info else None


def _sync_folder_link_wrap(data):
    """The optional folder-link wrap of a request: the three _SYNC_FOLDER_LINK_FIELDS,
    all or none. Returns (dict or None, error)."""
    values = {name: data.get(name) or None for name in _SYNC_FOLDER_LINK_FIELDS}
    if not any(values.values()):
        return None, None
    for name, value in values.items():
        if not isinstance(value, str):
            return None, _sync_error(400, 'bad_request', 'folder_link_encrypted_file_key, folder_link_file_key_nonce '
                                     'and folder_link_share_token go together as strings', field=name)
    if len(values['folder_link_share_token']) > 64:
        return None, _sync_error(400, 'bad_request', 'Invalid folder_link_share_token', field='folder_link_share_token')
    error = _sync_wrap_field_error((
        ('folder_link_encrypted_file_key', values['folder_link_encrypted_file_key'], 48),
        ('folder_link_file_key_nonce', values['folder_link_file_key_nonce'], 12),
    ))
    return (None, error) if error else (values, None)


def _sync_apply_folder_link_wrap(file, wrap):
    """Store wrap (validated by _sync_folder_link_wrap) on an E2EE file when it was
    made for the share token that now governs the file's folder; otherwise the file
    stays unkeyed and its node says needs_folder_link_key. True when stored."""
    if not wrap or not file.is_e2e_encrypted or file.folder_id is None:
        return False
    token = (_effective_folder_share_info(file.folder_id) or {}).get('share_token')
    if not token or not hmac.compare_digest(token, wrap['folder_link_share_token']):
        return False
    # Same fields as the website's /f/<id>/link-key with scope=folder.
    file.folder_link_encrypted_file_key = wrap['folder_link_encrypted_file_key']
    file.folder_link_file_key_nonce = wrap['folder_link_file_key_nonce']
    file.is_link_shared = True
    return True


def _sync_owned_files_query(user_id):
    """The user's synced drive files (no guest/temp rows), thumbnails deferred."""
    return File.query.filter(
        File.registered_user_id == user_id,
        File.is_temp_upload == False,
    ).options(db.defer(File.thumbnail_data), db.defer(File.encrypted_thumbnail_data))


def _sync_load_owned_file(file_id, for_update=False):
    """The caller's synced file by id, or None. for_update takes a current-read
    row lock (call _sync_lock_user_row first)."""
    if not isinstance(file_id, str) or not file_id or len(file_id) > 36:
        return None
    query = _sync_owned_files_query(g.api_user.id).filter(File.id == file_id)
    if for_update:
        query = query.populate_existing().with_for_update()
    return query.first()


def _sync_load_owned_folder(folder_id, for_update=False):
    query = Folder.query.filter(Folder.id == folder_id, Folder.user_id == g.api_user.id)
    if for_update:
        query = query.populate_existing().with_for_update()
    return query.first()


def _sync_lock_user_row(user_id):
    """Take the user row lock the seq allocator needs, before any data row lock."""
    db.session.execute(db.select(User.id).where(User.id == user_id).with_for_update())


def _sync_check_if_seq(obj, body):
    """412 (with current node) when body carries an if_seq that differs from the
    node's seq; 400 when it is not an integer; None when the write may go ahead."""
    if body.get('if_seq') is None:
        return None
    if_seq = body['if_seq']
    if isinstance(if_seq, bool) or not isinstance(if_seq, int):
        return _sync_error(400, 'bad_request', 'if_seq must be an integer', field='if_seq')
    if if_seq != int(obj.change_seq or 0):
        node = _sync_file_node(obj) if isinstance(obj, File) else _sync_folder_node(obj)
        return _sync_error(412, 'precondition_failed', 'The item changed on the server', current=node)
    return None


def _sync_optional_folder_id(body, field):
    """Parse a folder id field that may be null (drive root). Returns (id, error)."""
    if field not in body:
        return None, _sync_error(400, 'bad_request', f'{field} is required', field=field)
    value = body[field]
    if value is None:
        return None, None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None, _sync_error(400, 'bad_request', f'{field} must be a folder id or null', field=field)
    return value, None


def _sync_wrap_field_error(fields):
    """Run _e2ee_wrap_field_error() and convert its error to the sync shape."""
    for name, value, _size in fields:
        if value is not None and not isinstance(value, str):
            return _sync_error(400, 'bad_request', f'{name} must be a string', field=name)
    error = _e2ee_wrap_field_error(fields)
    if error:
        return _sync_error(400, 'bad_request', error[0].get_json()['error'])
    return None


def _sync_int_arg(name, default, low, high):
    """Integer query arg within [low, high]. Returns (value, error)."""
    raw = request.args.get(name)
    if raw is None or raw == '':
        return default, None
    try:
        value = int(raw)
    except ValueError:
        return None, _sync_error(400, 'bad_request', f'{name} must be an integer', field=name)
    if not low <= value <= high:
        return None, _sync_error(400, 'bad_request', f'{name} must be between {low} and {high}', field=name)
    return value, None


# ─── Backups: read-only enforcement (shared by every mutation route) ─────────

def _backup_writer_device_id():
    """Id of the device whose sync token authenticated this request, else None
    (website session, API key)."""
    device = getattr(g, 'device', None)
    return device.id if device is not None else None


def _backup_read_only(folder_id):
    """True when folder_id is, or lies inside, a backup folder this request may
    not write: everyone except the owning device's sync token is read-only.
    None (drive root) is never read-only."""
    device_id = _backup_writer_device_id()
    for current_id in _folder_ancestor_ids(folder_id):
        folder = db.session.get(Folder, current_id)
        if folder and folder.is_backup and (device_id is None or folder.backup_device_id != device_id):
            return True
    return False


def _backup_subtree_read_only(folder_id):
    """_backup_read_only(folder_id), or a backup folder of another writer anywhere
    below it (trashing or deleting folder_id would take that backup along)."""
    if _backup_read_only(folder_id):
        return True
    below = _collect_descendant_folder_ids([folder_id], include_roots=False)
    if not below:
        return False
    query = db.session.query(Folder.id).filter(Folder.id.in_(list(below)), Folder.is_backup == True)
    device_id = _backup_writer_device_id()
    if device_id:
        query = query.filter(db.or_(Folder.backup_device_id.is_(None), Folder.backup_device_id != device_id))
    return query.first() is not None


def _backup_items_read_only(user_id, file_ids, folder_ids, subtree=False):
    """True when one of the user's listed live files (by its folder) or folders
    (with its subtree when subtree, e.g. for a trash) is read-only."""
    file_folders = {row[0] for row in db.session.query(File.folder_id).filter(
        File.id.in_(list(file_ids) or ['']), File.registered_user_id == user_id, File.is_trashed == False)}
    folders = [row[0] for row in db.session.query(Folder.id).filter(
        Folder.id.in_(list(folder_ids) or [-1]), Folder.user_id == user_id, Folder.is_trashed == False)]
    check = _backup_subtree_read_only if subtree else _backup_read_only
    return any(_backup_read_only(fid) for fid in file_folders) or any(check(fid) for fid in folders)


def _backup_read_only_error():
    """403 read_only in the sync error shape (also used by website and API-key routes)."""
    return _sync_error(403, 'read_only', 'This folder is a read-only desktop backup. '
                       'Stop the backup in Devices to change it.')


def _sync_device_json(device):
    return {
        'id': device.id,
        'name': device.name,
        'platform': device.platform,
        'client_version': device.client_version,
        'created_at': _sync_iso(device.created_at),
        'last_seen_at': _sync_iso(device.last_seen_at),
    }


# ─── Devices ─────────────────────────────────────────────────────────────────

def _sync_verify_totp(user, code):
    """The /verify-2fa checks (lockout, replay, verify, atomic consume). Returns
    an error response or None."""
    if not code:
        return _sync_error(401, 'totp_required', 'Two-factor code required')
    remaining = _totp_lockout_remaining(user.id)
    if remaining > 0:
        resp = _sync_error(429, 'rate_limited', 'Too many invalid two-factor codes')
        resp.headers['Retry-After'] = str(remaining)
        return resp
    if not user.two_factor_secret:
        return _sync_error(401, 'invalid_totp', 'Invalid two-factor code')
    totp = pyotp.TOTP(_decrypt_totp_secret(user.two_factor_secret, user))
    if (_totp_is_replayed(user.id, code) or not totp.verify(code, valid_window=1)
            or not _totp_try_consume(user.id, code)):
        _record_failed_totp(user.id)
        print(f'[DEVICE] 2FA verification failed for user: {user.username}')
        return _sync_error(401, 'invalid_totp', 'Invalid two-factor code')
    _clear_failed_totp(user.id)
    return None


@app.route('/apiv1/devices/pre-login', methods=['POST'])
@csrf.exempt
@limiter.limit("15 per minute")
def apiv1_device_pre_login():
    """/auth/pre-login for clients without a CSRF session (same opaque response)."""
    if not get_setting('allow_desktop_sync'):
        return _sync_error(403, 'sync_disabled', 'Desktop sync is disabled on this server')
    return pre_login()


@app.route('/apiv1/devices/authorize', methods=['POST'])
@csrf.exempt
@limiter.limit("10 per minute")
def apiv1_device_authorize():
    """Exchange split-key credentials (+ TOTP) for a device token. Same lockout,
    captcha threshold and constant-time check as /login."""
    if not get_setting('allow_desktop_sync'):
        return _sync_error(403, 'sync_disabled', 'Desktop sync is disabled on this server')
    data = _sync_json_body()
    fields = ('username', 'auth_token', 'totp_code', 'device_name', 'platform', 'client_version')
    if data is None or not _json_string_fields_valid(data, fields):
        return _sync_error(400, 'bad_request', 'Invalid request')
    username = (data.get('username') or '').strip()
    auth_token = data.get('auth_token') or ''
    device_name = sanitize_plaintext_name(data.get('device_name'), max_length=80)
    platform = (data.get('platform') or '').strip().lower()
    client_version = (data.get('client_version') or '').strip() or None
    for field, value in (('username', username), ('auth_token', auth_token), ('device_name', device_name)):
        if not value:
            return _sync_error(400, 'bad_request', f'{field} is required', field=field)
    if platform not in _SYNC_PLATFORMS:
        return _sync_error(400, 'bad_request', 'platform must be windows or linux', field='platform')
    if client_version and not _SYNC_CLIENT_VERSION_RE.fullmatch(client_version):
        return _sync_error(400, 'bad_request', 'Invalid client_version', field='client_version')

    normalized = username.lower()
    locked, remaining = _login_lockout_status(normalized)
    if locked:
        resp = _sync_error(429, 'rate_limited', 'Too many failed sign-in attempts')
        resp.headers['Retry-After'] = str(remaining)
        return resp
    if _login_requires_captcha(normalized):
        return _sync_error(403, 'captcha_required', 'Sign in on the website once, then try again')

    user = User.query.filter_by(username=username).first()
    # Same comparison as /login: unknown users compare against a dummy hash.
    stored_hash = '0' * 64
    if user and user.split_key_version and user.split_key_version >= 1 and user.auth_token_hash:
        stored_hash = user.auth_token_hash
    provided_hash = hashlib.sha256(auth_token.encode('utf-8')).hexdigest()
    if not hmac.compare_digest(provided_hash, stored_hash):
        _record_failed_login(normalized)
        print(f'[DEVICE] Authorization failed for username={normalized!r}')
        return _sync_error(401, 'invalid_credentials', 'Invalid username or password',
                           captcha_required=_login_requires_captcha(normalized))
    if user.two_factor_enabled:
        totp_error = _sync_verify_totp(user, (data.get('totp_code') or '').strip())
        if totp_error:
            return totp_error
    _clear_failed_login(normalized)

    user_id = user.id
    lock = _acquire_scoped_lock(f'devices_user_{user_id}', prefix='devices')
    try:
        db.session.rollback()
        if Device.query.filter_by(user_id=user_id, is_active=True).count() >= get_numeric_setting('max_devices_per_user'):
            return _sync_error(409, 'device_limit', 'Device limit reached. Remove a device in Devices first.')
        raw_token = _generate_device_token()
        device = Device(user_id=user_id, name=device_name, platform=platform,
                        client_version=client_version, token_hash=_hash_device_token(raw_token))
        db.session.add(device)
        db.session.commit()
    finally:
        _release_scoped_lock(lock)
    user = db.session.get(User, user_id)
    print(f'[DEVICE] Authorized device {device.id} ({platform}, {_log_safe(device_name)}) for user: {user.username}')
    return jsonify({
        'device_id': device.id,
        'device_token': raw_token,
        'user': {'id': user.id, 'username': user.username},
    }), 201


@app.route('/apiv1/devices/keys', methods=['GET'])
@csrf.exempt
@device_auth_required
def apiv1_device_keys():
    return jsonify(_user_key_material(g.api_user))


@app.route('/apiv1/me', methods=['GET'])
@csrf.exempt
@device_auth_required
def apiv1_me():
    user = g.api_user
    return jsonify({
        'user_id': user.id,
        'username': user.username,
        'storage_used': user.get_storage_used(),
        'storage_limit': int((user.storage_limit_gb or 0) * 1024 * 1024 * 1024),
        'has_e2ee_keys': bool(user.has_e2ee_keys),
        'versioning': _file_versions_enabled(user),
        'device': {
            'id': g.device.id,
            'name': g.device.name,
            'platform': g.device.platform,
            'created_at': _sync_iso(g.device.created_at),
        },
    })


@app.route('/apiv1/devices/self', methods=['PATCH'])
@csrf.exempt
@device_auth_required
def apiv1_device_update_self():
    data = _sync_json_body()
    if data is None or not _json_string_fields_valid(data, ('name', 'client_version')):
        return _sync_error(400, 'bad_request', 'Invalid request')
    device = g.device
    if data.get('name') is not None:
        name = sanitize_plaintext_name(data['name'], max_length=80)
        if not name:
            return _sync_error(400, 'bad_request', 'name must not be empty', field='name')
        device.name = name
    if data.get('client_version') is not None:
        client_version = data['client_version'].strip()
        if not _SYNC_CLIENT_VERSION_RE.fullmatch(client_version):
            return _sync_error(400, 'bad_request', 'Invalid client_version', field='client_version')
        device.client_version = client_version
    db.session.commit()
    return jsonify(_sync_device_json(device))


@app.route('/apiv1/devices/self', methods=['DELETE'])
@csrf.exempt
@device_auth_required
def apiv1_device_delete_self():
    device = g.device
    device.is_active = False
    device.revoked_at = datetime.now(timezone.utc)
    db.session.commit()
    print(f'[DEVICE] Device {device.id} signed out by itself (user: {g.api_user.username})')
    return '', 204


# ─── Change feed ─────────────────────────────────────────────────────────────

@app.route('/apiv1/sync/capabilities', methods=['GET'])
@csrf.exempt
@device_auth_required
def apiv1_sync_capabilities():
    return jsonify({
        'protocol': SYNC_PROTOCOL,
        'chunk_size': SYNC_CHUNK_SIZE,
        'small_upload_max': SYNC_SMALL_UPLOAD_MAX,
        'max_upload': app.config['MAX_CONTENT_LENGTH'],
        'max_parallel_transfers': SYNC_MAX_PARALLEL_TRANSFERS,
        'poll_min_seconds': SYNC_POLL_MIN_SECONDS,
        'versioning': get_numeric_setting('file_version_retention_count') > 0,
        'backups': True,
        'min_client_version': MIN_DESKTOP_CLIENT_VERSION,
    })


@app.route('/apiv1/sync/cursor', methods=['GET'])
@csrf.exempt
@device_auth_required
def apiv1_sync_cursor():
    seq = int(db.session.query(User.sync_seq).filter(User.id == g.api_user.id).scalar() or 0)
    etag = f'"seq-{seq}"'
    if request.headers.get('If-None-Match') == etag:
        resp = app.response_class(status=304)
    else:
        resp = jsonify({'seq': seq})
    resp.headers['ETag'] = etag
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.route('/apiv1/sync/changes', methods=['GET'])
@csrf.exempt
@device_auth_required
def apiv1_sync_changes():
    uid = g.api_user.id
    cursor, error = _sync_int_arg('cursor', None, 0, 2 ** 62)
    if error:
        return error
    if cursor is None:
        return _sync_error(400, 'bad_request', 'cursor is required', field='cursor')
    limit, error = _sync_int_arg('limit', _SYNC_CHANGES_DEFAULT_LIMIT, 1, _SYNC_CHANGES_MAX_LIMIT)
    if error:
        return error
    current_seq, min_seq = db.session.query(User.sync_seq, User.sync_min_seq).filter(User.id == uid).one()
    # A cursor below the pruned range lost tombstones; one above the current seq
    # comes from another server state (restore, wipe). Both need a fresh snapshot.
    if cursor < int(min_seq or 0) or cursor > int(current_seq or 0):
        return _sync_error(410, 'cursor_expired', 'Cursor is no longer valid; take a new snapshot',
                           min_cursor=int(min_seq or 0))

    def fetch(seq_filter, bounded):
        folders = Folder.query.filter(Folder.user_id == uid, seq_filter(Folder.change_seq)).order_by(
            Folder.change_seq, Folder.id)
        files = _sync_owned_files_query(uid).filter(seq_filter(File.change_seq)).order_by(
            File.change_seq, File.id)
        tombs = SyncTombstone.query.filter(SyncTombstone.user_id == uid,
                                           seq_filter(SyncTombstone.change_seq)).order_by(
            SyncTombstone.change_seq, SyncTombstone.id)
        if bounded:
            folders, files, tombs = folders.limit(limit + 1), files.limit(limit + 1), tombs.limit(limit + 1)
        items = ([(f.change_seq, 0, f) for f in folders] + [(f.change_seq, 1, f) for f in files]
                 + [(t.change_seq, 2, t) for t in tombs])
        items.sort(key=lambda item: (item[0], item[1]))
        return items

    items = fetch(lambda col: col > cursor, True)
    has_more = len(items) > limit
    if has_more:
        # Never split one seq across pages: the next cursor would skip the rest.
        boundary = items[limit][0]
        items = [item for item in items[:limit] if item[0] < boundary]
        if not items:
            # A single change (e.g. a large folder trash) exceeds limit: send it whole.
            items = fetch(lambda col: col == boundary, False)
    changes, tombstones = [], []
    for seq, kind, obj in items:
        if kind == 0:
            changes.append(_sync_folder_node(obj))
        elif kind == 1:
            changes.append(_sync_file_node(obj))
        else:
            tombstones.append({'type': obj.object_type, 'id': int(obj.object_id) if obj.object_type == 'folder' else obj.object_id,
                               'seq': int(obj.change_seq)})
    return jsonify({
        'changes': changes,
        'tombstones': tombstones,
        'next_cursor': int(items[-1][0]) if items else cursor,
        'has_more': has_more,
    })


def _sync_decode_tree_token(token, root_id):
    """Opaque page token -> (as_of_seq, phase, after) or None when invalid."""
    try:
        data = json.loads(base64.urlsafe_b64decode(token.encode('ascii') + b'=' * (-len(token) % 4)))
        as_of, phase, after = data['s'], data['p'], data['a']
    except Exception:
        return None
    if data.get('r') != root_id or not isinstance(as_of, int) or isinstance(as_of, bool) or as_of < 0:
        return None
    if phase == 'd' and (after is None or (isinstance(after, int) and not isinstance(after, bool))):
        return as_of, phase, after
    if phase == 'f' and (after is None or (isinstance(after, str) and len(after) <= 36)):
        return as_of, phase, after
    return None


def _sync_encode_tree_token(as_of, phase, after, root_id):
    raw = json.dumps({'s': as_of, 'p': phase, 'a': after, 'r': root_id}, separators=(',', ':'))
    return base64.urlsafe_b64encode(raw.encode('utf-8')).decode('ascii').rstrip('=')


@app.route('/apiv1/sync/tree', methods=['GET'])
@csrf.exempt
@device_auth_required
def apiv1_sync_tree():
    """Non-trashed subtree under root, folders first, keyset-paginated by id.
    Changes made while paging are picked up by /changes?cursor=as_of_seq."""
    uid = g.api_user.id
    root_id, error = _sync_int_arg('root', 0, 0, 2 ** 62)
    if error:
        return error
    limit, error = _sync_int_arg('limit', _SYNC_TREE_DEFAULT_LIMIT, 1, _SYNC_TREE_MAX_LIMIT)
    if error:
        return error
    token = request.args.get('page_token')
    if token:
        decoded = _sync_decode_tree_token(token, root_id)
        if decoded is None:
            return _sync_error(400, 'bad_request', 'Invalid page_token', field='page_token')
        as_of, phase, after = decoded
    else:
        as_of = int(db.session.query(User.sync_seq).filter(User.id == uid).scalar() or 0)
        phase, after = 'd', None

    root = None
    folder_q = Folder.query.filter(Folder.user_id == uid, Folder.is_trashed == False)
    file_q = _sync_owned_files_query(uid).filter(File.is_trashed == False)
    if root_id:
        root = Folder.query.filter_by(id=root_id, user_id=uid, is_trashed=False).first()
        if not root:
            return _sync_error(404, 'not_found', 'Folder not found')
        scope_ids = list(_collect_descendant_folder_ids([root_id], include_roots=True))
        folder_q = folder_q.filter(Folder.id.in_([fid for fid in scope_ids if fid != root_id] or [-1]))
        file_q = file_q.filter(File.folder_id.in_(scope_ids))

    folders, files, next_token = [], [], None
    if phase == 'd':
        if after is not None:
            folder_q = folder_q.filter(Folder.id > after)
        rows = folder_q.order_by(Folder.id).limit(limit + 1).all()
        if len(rows) > limit:
            folders = rows[:limit]
            next_token = ('d', folders[-1].id)
        else:
            folders, after = rows, None
    if next_token is None:
        room = limit - len(folders)
        if room == 0:
            next_token = ('f', None)
        else:
            if after is not None:
                file_q = file_q.filter(File.id > after)
            rows = file_q.order_by(File.id).limit(room + 1).all()
            if len(rows) > room:
                files = rows[:room]
                next_token = ('f', files[-1].id)
            else:
                files = rows
    return jsonify({
        'as_of_seq': as_of,
        'root': _sync_folder_node(root) if root else None,
        'folders': [_sync_folder_node(f) for f in folders],
        'files': [_sync_file_node(f) for f in files],
        'next_page_token': _sync_encode_tree_token(as_of, next_token[0], next_token[1], root_id) if next_token else None,
    })


# ─── Content ─────────────────────────────────────────────────────────────────

def _sync_etag_matches(if_match, checksum):
    """If-Match against payload_checksum; quoted or bare tags, '*' matches any."""
    tags = [tag.strip().removeprefix('W/').strip('"') for tag in if_match.split(',')]
    return '*' in tags or (bool(checksum) and checksum in tags)


def _sync_iter_range(path, start, length, expected_size):
    """Yield bytes [start, start+length) of the payload; the open descriptor is
    size-checked first so a concurrently replaced payload is never mixed in."""
    with open(path, 'rb') as f:
        if os.fstat(f.fileno()).st_size != expected_size:
            raise ValueError(f'payload size changed while serving range of {path}')
        f.seek(start)
        remaining = length
        while remaining > 0:
            data = f.read(min(1024 * 1024, remaining))
            if not data:
                raise ValueError(f'short read while serving range of {path}')
            remaining -= len(data)
            yield data


def _sync_parse_range(header, size):
    """Single 'bytes=a-b' range -> (start, end), 'unsatisfiable', or None to
    ignore (malformed or multi-range: serve the full body)."""
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', header.strip())
    if not match or not (match.group(1) or match.group(2)):
        return None
    if match.group(1):
        start = int(match.group(1))
        end = min(int(match.group(2)) if match.group(2) else size - 1, size - 1)
    else:
        suffix = int(match.group(2))
        start, end = (max(size - suffix, 0), size - 1) if suffix else (size, size - 1)
    if start >= size or start > end:
        return 'unsatisfiable'
    return start, end


@app.route('/apiv1/sync/files/<file_id>/content', methods=['GET'])
@csrf.exempt
@limiter.limit(download_rate_limit)
@device_auth_required
def apiv1_sync_file_content(file_id):
    """Owner download for sync. Never touches download_count / max_downloads."""
    file = _sync_load_owned_file(file_id)
    if not file:
        return _sync_error(404, 'not_found', 'File not found')
    return _sync_send_content(file, _sync_file_node(file))


def _sync_send_content(file, current):
    """Serve file's stored payload with the /content semantics (also used for
    versions). current is the node returned with a 412."""
    if_match = request.headers.get('If-Match')
    if if_match and not _sync_etag_matches(if_match, file.payload_checksum):
        return _sync_error(412, 'precondition_failed', 'The file changed on the server', current=current)
    path = storage.get_file_path(file.filename)
    if not path or not os.path.exists(path):
        return _sync_error(404, 'not_found', 'File data not found')
    if not _payload_disk_size_matches(path, file.disk_size):
        print(f'[ERROR] [SYNC] Disk-size mismatch for {file.id} -- refusing to serve sync content')
        return _sync_error(500, 'integrity_error', 'File failed an integrity check')
    headers = {'Cache-Control': 'no-store'}
    if file.payload_checksum:
        headers['ETag'] = f'"{file.payload_checksum}"'

    if file.is_e2e_encrypted:
        size = int(file.disk_size)
        headers['Accept-Ranges'] = 'bytes'
        byte_range = _sync_parse_range(request.headers['Range'], size) if request.headers.get('Range') else None
        if byte_range == 'unsatisfiable':
            resp = _sync_error(416, 'bad_request', 'Range not satisfiable')
            resp.headers['Content-Range'] = f'bytes */{size}'
            return resp
        if byte_range:
            start, end = byte_range
            resp = _build_streaming_response(
                lambda: _sync_iter_range(path, start, end - start + 1, size),
                'application/octet-stream', content_length=end - start + 1, headers=headers)
            resp.status_code = 206
            resp.headers['Content-Range'] = f'bytes {start}-{end}/{size}'
            return resp
        return _build_streaming_response(
            lambda: _iter_file_chunks(path, expected_checksum=file.payload_checksum, expected_size=size,
                                      file_id=file.id, corruption_kind='e2ee-payload'),
            'application/octet-stream', content_length=size, headers=headers)

    # Standard (server-encrypted) file: decrypted plaintext, full body only.
    if (file.size or 0) > LARGE_FILE_THRESHOLD:
        try:
            tmp_path, cleanup = _prepare_sync_download(path, file)
        except Exception as e:
            print(f'[SYNC] Decryption/integrity failure for {file.id}: {e}')
            return _sync_error(500, 'integrity_error', 'File failed decryption or an integrity check')
        if tmp_path is None:
            resp = _sync_error(503, 'busy', 'Server busy, try again later')
            resp.headers['Retry-After'] = '30'
            return resp
        return _build_streaming_response(
            lambda: _iter_file_chunks(tmp_path, chunk_size=64 * 1024),
            'application/octet-stream', content_length=file.size, headers=headers,
            on_finalize=_finalize_download_with_temp_cleanup(None, cleanup))
    return _build_streaming_response(
        lambda: decrypt_file_chunked(path, expected_size=file.size,
                                     expected_payload_checksum=file.payload_checksum,
                                     expected_disk_size=file.disk_size, file_id=file.id),
        'application/octet-stream', content_length=file.size, headers=headers)


# ─── Mutations ───────────────────────────────────────────────────────────────

def _sync_body_or_error():
    body = _sync_json_body()
    if body is None:
        return None, _sync_error(400, 'bad_request', 'JSON object body required')
    return body, None


@app.route('/apiv1/sync/files/<file_id>/move', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_file_move(file_id):
    body, error = _sync_body_or_error()
    if error:
        return error
    target_id, error = _sync_optional_folder_id(body, 'folder_id')
    if error:
        return error
    wrap, error = _sync_folder_link_wrap(body)
    if error:
        return error
    uid = g.api_user.id
    lifecycle_lock = _acquire_user_lifecycle_lock(uid)
    try:
        db.session.rollback()
        _sync_lock_user_row(uid)
        file = _sync_load_owned_file(file_id, for_update=True)
        if not file or file.is_trashed:
            return _sync_error(404, 'not_found', 'File not found')
        error = _sync_check_if_seq(file, body)
        if error:
            return error
        if wrap and not file.is_e2e_encrypted:
            return _sync_error(400, 'bad_request', 'Folder-link keys are only stored for E2EE files',
                               field='folder_link_encrypted_file_key')
        if _backup_read_only(file.folder_id) or _backup_read_only(target_id):
            return _backup_read_only_error()
        if not _lock_live_folder_for_placement(target_id, uid):
            return _sync_error(404, 'not_found', 'Target folder not found')
        _move_file_to_folder(file, target_id)
        _sync_apply_folder_link_wrap(file, wrap)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    print(f'[SYNC] Moved file {file.id} to folder {target_id} (device {g.device.id})')
    return jsonify(_sync_file_node(file))


@app.route('/apiv1/sync/files/<file_id>/rename', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_file_rename(file_id):
    body, error = _sync_body_or_error()
    if error:
        return error
    uid = g.api_user.id
    db.session.rollback()
    _sync_lock_user_row(uid)
    file = _sync_load_owned_file(file_id, for_update=True)
    if not file or file.is_trashed:
        return _sync_error(404, 'not_found', 'File not found')
    error = _sync_check_if_seq(file, body)
    if error:
        return error
    if _backup_read_only(file.folder_id):
        return _backup_read_only_error()
    if file.is_e2e_encrypted:
        enc_name, enc_nonce = body.get('encrypted_name'), body.get('name_nonce')
        if not enc_name or not enc_nonce:
            return _sync_error(400, 'bad_request', 'encrypted_name and name_nonce are required', field='encrypted_name')
        error = _sync_wrap_field_error((('encrypted_name', enc_name, None), ('name_nonce', enc_nonce, 12)))
        if error:
            return error
        stored_ext = body.get('stored_extension')
        if stored_ext is not None and not isinstance(stored_ext, str):
            return _sync_error(400, 'bad_request', 'stored_extension must be a string', field='stored_extension')
        stored_ext = normalize_stored_extension(stored_ext)
        file.encrypted_name = enc_name
        file.name_nonce = enc_nonce
        file.stored_extension = stored_ext
        file.orig_name = f'encrypted_{file.id[:8]}{stored_ext or ""}'
    else:
        name = body.get('name')
        name = sanitize_plaintext_name(name) if isinstance(name, str) else ''
        if not name:
            return _sync_error(400, 'bad_request', 'name is required', field='name')
        file.orig_name = name
    db.session.commit()
    print(f'[SYNC] Renamed file {file.id} (device {g.device.id})')
    return jsonify(_sync_file_node(file))


@app.route('/apiv1/sync/files/<file_id>/trash', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_file_trash(file_id):
    body, error = _sync_body_or_error()
    if error:
        return error
    uid = g.api_user.id
    lifecycle_lock = _acquire_user_lifecycle_lock(uid)
    try:
        db.session.rollback()
        _sync_lock_user_row(uid)
        file = _sync_load_owned_file(file_id, for_update=True)
        if not file or file.is_trashed:
            return _sync_error(404, 'not_found', 'File not found')
        error = _sync_check_if_seq(file, body)
        if error:
            return error
        if _backup_read_only(file.folder_id):
            return _backup_read_only_error()
        # Same fields as the website's /file/<id>/delete, plus the device tag.
        source_folder_id = file.folder_id
        file.is_trashed = True
        file.trashed_at = datetime.now(timezone.utc)
        file.original_folder_id = source_folder_id
        file.trashed_via_folder = False
        file.folder_id = None
        file.is_public = False
        file.short_code = None
        file.trashed_by_device_id = g.device.id
        touch_folder(source_folder_id)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    print(f'[SYNC] Trashed file {file.id} (device {g.device.id})')
    return jsonify(_sync_file_node(file))


@app.route('/apiv1/sync/files/<file_id>/restore', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_file_restore(file_id):
    uid = g.api_user.id
    quota_lock = _acquire_user_quota_lock(uid)
    lifecycle_lock = None
    try:
        _refresh_quota_snapshot()
        lifecycle_lock = _acquire_user_lifecycle_lock(uid)
        db.session.rollback()
        _sync_lock_user_row(uid)
        user = db.session.get(User, uid)
        file = _sync_load_owned_file(file_id, for_update=True)
        if not file or not file.is_trashed:
            return _sync_error(404, 'not_found', 'File not found in trash')
        if not user.has_storage_available(_quota_bytes_for_file(file)):
            return _sync_error(413, 'quota_exceeded', 'Storage limit exceeded')
        _restore_trashed_file(file, user)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)
    print(f'[SYNC] Restored file {file.id} (device {g.device.id})')
    return jsonify(_sync_file_node(file))


@app.route('/apiv1/sync/files/<file_id>/meta', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_file_meta(file_id):
    """Store client-encrypted metadata for the file's current content_version."""
    body, error = _sync_body_or_error()
    if error:
        return error
    enc_meta, meta_nonce = body.get('encrypted_meta'), body.get('meta_nonce')
    if_content_version = body.get('if_content_version')
    if not enc_meta or not meta_nonce:
        return _sync_error(400, 'bad_request', 'encrypted_meta and meta_nonce are required', field='encrypted_meta')
    if isinstance(if_content_version, bool) or not isinstance(if_content_version, int):
        return _sync_error(400, 'bad_request', 'if_content_version must be an integer', field='if_content_version')
    error = _sync_wrap_field_error((('encrypted_meta', enc_meta, None), ('meta_nonce', meta_nonce, 12)))
    if error:
        return error
    uid = g.api_user.id
    db.session.rollback()
    _sync_lock_user_row(uid)
    file = _sync_load_owned_file(file_id, for_update=True)
    if not file:
        return _sync_error(404, 'not_found', 'File not found')
    if not file.is_e2e_encrypted:
        return _sync_error(400, 'bad_request', 'Encrypted metadata is only stored for E2EE files')
    if _backup_read_only(file.folder_id):
        return _backup_read_only_error()
    if if_content_version != int(file.content_version or 1):
        return _sync_error(412, 'precondition_failed', 'The file content changed on the server',
                           current=_sync_file_node(file))
    file.encrypted_meta = enc_meta
    file.meta_nonce = meta_nonce
    db.session.commit()
    return jsonify(_sync_file_node(file))


@app.route('/apiv1/sync/files/<file_id>/folder-link-key', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_file_folder_link_key(file_id):
    """Backfill the folder-link wrap of a live E2EE file (node needs_folder_link_key)."""
    body, error = _sync_body_or_error()
    if error:
        return error
    wrap, error = _sync_folder_link_wrap(body)
    if error:
        return error
    if not wrap:
        return _sync_error(400, 'bad_request', 'folder_link_encrypted_file_key, folder_link_file_key_nonce and '
                           'folder_link_share_token are required', field='folder_link_encrypted_file_key')
    uid = g.api_user.id
    db.session.rollback()
    _sync_lock_user_row(uid)
    file = _sync_load_owned_file(file_id, for_update=True)
    if not file or file.is_trashed:
        return _sync_error(404, 'not_found', 'File not found')
    if not file.is_e2e_encrypted:
        return _sync_error(400, 'bad_request', 'Folder-link keys are only stored for E2EE files')
    if _backup_read_only(file.folder_id):
        return _backup_read_only_error()
    if not _sync_apply_folder_link_wrap(file, wrap):
        # No shared ancestor, or the share token changed: the client re-derives.
        node = _sync_file_node(file)
        db.session.rollback()
        return _sync_error(409, 'conflict', 'folder_link_share_token is not the token of this file\'s shared folder',
                           current=node)
    db.session.commit()
    print(f'[SYNC] Folder-link key set for file {file.id} (device {g.device.id})')
    return jsonify(_sync_file_node(file))


@app.route('/apiv1/sync/folders/<int:folder_id>/move', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_folder_move(folder_id):
    body, error = _sync_body_or_error()
    if error:
        return error
    target_id, error = _sync_optional_folder_id(body, 'parent_id')
    if error:
        return error
    uid = g.api_user.id
    lifecycle_lock = _acquire_user_lifecycle_lock(uid)
    tree_lock = _acquire_user_folder_tree_lock(uid)
    try:
        _sync_lock_user_row(uid)
        folder = _sync_load_owned_folder(folder_id, for_update=True)
        if not folder or folder.is_trashed:
            return _sync_error(404, 'not_found', 'Folder not found')
        error = _sync_check_if_seq(folder, body)
        if error:
            return error
        if _backup_read_only(folder.id) or _backup_read_only(target_id):
            return _backup_read_only_error()
        move_error, move_status, _moved = _move_folder_to_parent(folder, target_id, uid)
        if move_error:
            return _sync_error(move_status, 'not_found' if move_status == 404 else 'bad_request', move_error)
        db.session.commit()
    finally:
        _release_user_folder_tree_lock(tree_lock)
        _release_lifecycle_lock(lifecycle_lock)
    print(f'[SYNC] Moved folder {folder.id} to parent {target_id} (device {g.device.id})')
    return jsonify(_sync_folder_node(folder))


@app.route('/apiv1/sync/folders/<int:folder_id>/rename', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_folder_rename(folder_id):
    body, error = _sync_body_or_error()
    if error:
        return error
    for field in ('name', 'encrypted_name', 'name_nonce'):
        if body.get(field) is not None and not isinstance(body[field], str):
            return _sync_error(400, 'bad_request', f'{field} must be a string', field=field)
    uid = g.api_user.id
    folder = _sync_load_owned_folder(folder_id)
    if not folder or folder.is_trashed:
        return _sync_error(404, 'not_found', 'Folder not found')
    is_encrypted = bool(body.get('encrypted_name') or body.get('name_nonce'))
    # E2EE renames keep the folder's name key (the website does the same).
    fields = {
        'name': f'encrypted_folder_{folder.id}' if is_encrypted else sanitize_plaintext_name(body.get('name')),
        'encrypted_name': body.get('encrypted_name'),
        'name_nonce': body.get('name_nonce'),
    }
    # Plaintext names must be unique among siblings: hold the same placement
    # lock as folder creation and the website rename.
    name_lock = None if is_encrypted else _acquire_folder_creation_lock(uid, folder.parent_id)
    try:
        db.session.rollback()
        _sync_lock_user_row(uid)
        folder = _sync_load_owned_folder(folder_id, for_update=True)
        if not folder or folder.is_trashed:
            return _sync_error(404, 'not_found', 'Folder not found')
        error = _sync_check_if_seq(folder, body)
        if error:
            return error
        if _backup_read_only(folder.id):
            return _backup_read_only_error()
        rename, rename_error = _parse_folder_rename(folder, fields)
        if rename_error:
            return _sync_error(400, 'bad_request', rename_error)
        if not is_encrypted and _plaintext_folder_name_taken(folder, rename['name']):
            return _sync_error(409, 'conflict', 'Folder with this name already exists',
                               current=_sync_folder_node(folder))
        _apply_folder_rename(folder, rename)
        db.session.commit()
    finally:
        _release_folder_creation_lock(name_lock)
    print(f'[SYNC] Renamed folder {folder.id} (device {g.device.id})')
    return jsonify(_sync_folder_node(folder))


@app.route('/apiv1/sync/folders/<int:folder_id>/trash', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_folder_trash(folder_id):
    body, error = _sync_body_or_error()
    if error:
        return error
    uid = g.api_user.id
    lifecycle_lock = _acquire_user_lifecycle_lock(uid)
    try:
        db.session.rollback()
        _sync_lock_user_row(uid)
        folder = _sync_load_owned_folder(folder_id, for_update=True)
        if not folder or folder.is_trashed:
            return _sync_error(404, 'not_found', 'Folder not found')
        error = _sync_check_if_seq(folder, body)
        if error:
            return error
        if _backup_subtree_read_only(folder.id):
            return _backup_read_only_error()
        parent_id_before = folder.parent_id
        subtree_ids = list(_collect_descendant_folder_ids([folder.id], include_roots=True))
        files_in_subtree = _sync_owned_files_query(uid).filter(
            File.folder_id.in_(subtree_ids), File.is_trashed == False).all()
        trash_folder_recursive(folder.id)
        for file in files_in_subtree:
            if file.is_trashed:
                file.trashed_by_device_id = g.device.id
        # Detached from its parent like the website trash, so it lists at the top of trash.
        folder.parent_id = None
        touch_folder(parent_id_before)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    print(f'[SYNC] Trashed folder {folder.id} and its contents (device {g.device.id})')
    return jsonify(_sync_folder_node(folder))


@app.route('/apiv1/sync/folders/<int:folder_id>/restore', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_folder_restore(folder_id):
    uid = g.api_user.id
    quota_lock = _acquire_user_quota_lock(uid)
    lifecycle_lock = None
    tree_lock = None
    try:
        _refresh_quota_snapshot()
        lifecycle_lock = _acquire_user_lifecycle_lock(uid)
        tree_lock = _acquire_user_folder_tree_lock(uid)
        _sync_lock_user_row(uid)
        user = db.session.get(User, uid)
        folder = _sync_load_owned_folder(folder_id, for_update=True)
        if not folder or not folder.is_trashed:
            return _sync_error(404, 'not_found', 'Folder not found in trash')
        _, required_bytes = _folder_restore_file_ids_and_size(folder)
        if required_bytes > 0 and not user.has_storage_available(required_bytes):
            return _sync_error(413, 'quota_exceeded', 'Storage limit exceeded')
        _restore_folder_to_original_parent(folder, user)
        restore_folder_recursive(folder.id)
        touch_folder(folder.parent_id)
        db.session.commit()
    finally:
        _release_user_folder_tree_lock(tree_lock)
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)
    print(f'[SYNC] Restored folder {folder.id} and its contents (device {g.device.id})')
    return jsonify(_sync_folder_node(folder))


# ─── Backups ─────────────────────────────────────────────────────────────────

@app.route('/apiv1/sync/folders/<int:folder_id>/backup', methods=['POST'])
@csrf.exempt
@device_auth_required
def apiv1_sync_folder_backup(folder_id):
    """{"enabled": true} marks a folder as a read-only backup of the calling
    device; {"enabled": false} turns this device's backup into a normal folder.
    Backups never nest. Idempotent."""
    body, error = _sync_body_or_error()
    if error:
        return error
    enabled = body.get('enabled')
    if not isinstance(enabled, bool):
        return _sync_error(400, 'bad_request', 'enabled must be true or false', field='enabled')
    uid = g.api_user.id
    # The tree lock keeps a concurrent move from nesting two backups.
    tree_lock = _acquire_user_folder_tree_lock(uid)
    try:
        _sync_lock_user_row(uid)
        folder = _sync_load_owned_folder(folder_id, for_update=True)
        if not folder or folder.is_trashed:
            return _sync_error(404, 'not_found', 'Folder not found')
        error = _sync_check_if_seq(folder, body)
        if error:
            return error
        if folder.is_backup and folder.backup_device_id != g.device.id:
            return _backup_read_only_error()
        if enabled and not folder.is_backup:
            above = [db.session.get(Folder, fid) for fid in _folder_ancestor_ids(folder.parent_id)]
            below = _collect_descendant_folder_ids([folder.id], include_roots=False)
            if any(f is not None and f.is_backup for f in above) or (below and db.session.query(Folder.id).filter(
                    Folder.id.in_(list(below)), Folder.is_backup == True).first()):
                return _sync_error(409, 'conflict', 'Backups cannot be nested inside other backups',
                                   current=_sync_folder_node(folder))
            folder.is_backup = True
            folder.backup_device_id = g.device.id
        elif not enabled and folder.is_backup:
            folder.is_backup = None
            folder.backup_device_id = None
        else:
            return jsonify(_sync_folder_node(folder))
        folder.updated_at = datetime.now(timezone.utc)
        db.session.commit()
    finally:
        _release_user_folder_tree_lock(tree_lock)
    print(f'[SYNC] Folder {folder.id} backup {"enabled" if enabled else "disabled"} (device {g.device.id})')
    return jsonify(_sync_folder_node(folder))
