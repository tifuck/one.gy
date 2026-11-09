# Desktop sync API: one-shot uploads, upload sessions and replace (desktop/docs/sync-api.md).
#
# Every upload ends in _sync_commit_upload(): creates go through
# _commit_new_upload() (100, shared with /upload); replaces go through the
# staged-rewrite pipeline (store_file_staged -> commit -> finalize) under the
# file's rewrite lock, so a crash never leaves a half-written payload; the
# previous payload becomes a file version (377_file_versions.py). Session
# parts are staged in <UPLOAD_FOLDER>/.sync-sessions/<session id>/ (never
# replicated) and assembled there, on the payload's filesystem. upload_id is the
# idempotency key (File.upload_idempotency_key, unique per user) and every write
# for one key runs under the upload-key locks. Lock order: upload key -> file
# rewrite -> quota -> lifecycle -> user row -> file row. E2EE names are never logged.

_SYNC_SESSIONS_DIRNAME = '.sync-sessions'
_SYNC_UPLOAD_ID_RE = re.compile(r'[\x21-\x7e]{1,64}')
_SYNC_SHA256_RE = re.compile(r'[0-9a-f]{64}')
_SYNC_INT_RE = re.compile(r'[0-9]{1,18}')
# One framed E2EE chunk: len BE32 || ciphertext || tag.
_SYNC_MAX_E2EE_PART = 4 + _E2EE_MAX_CHUNK_RECORD
# Non-final parts carry at least 1 MiB (the floor validate_e2ee_container()
# assumes), which bounds chunk_count and so the number of part files.
_SYNC_MIN_PART_PAYLOAD = 1024 * 1024
# Orphaned staging dirs (no session row) are kept at least this long.
_SYNC_ORPHAN_MIN_AGE_SECONDS = 3600
_SYNC_META_KEYS = ('encrypted_file_key', 'file_key_nonce', 'encrypted_name', 'name_nonce',
                   'stored_extension', 'encrypted_meta', 'meta_nonce', 'name') + _SYNC_FOLDER_LINK_FIELDS
_SYNC_E2EE_KEY_FIELDS = ('encrypted_file_key', 'file_key_nonce', 'encrypted_name', 'name_nonce', 'stored_extension')


def _sync_sessions_root():
    root = os.path.join(app.config['UPLOAD_FOLDER'], _SYNC_SESSIONS_DIRNAME)
    os.makedirs(root, exist_ok=True)
    return root


def _sync_session_dir(session_id):
    return os.path.join(_sync_sessions_root(), session_id)


def _sync_remove_dir(path):
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass
    except OSError as e:
        print(f'[SYNC-UPLOAD] Could not remove staging dir {path}: {e}')


def _sync_aware(dt):
    return dt.replace(tzinfo=timezone.utc) if dt is not None and dt.tzinfo is None else dt


def _sync_busy(message='Server busy, try again later'):
    resp = _sync_error(503, 'busy', message)
    resp.headers['Retry-After'] = '30'
    return resp


def _sync_existing_response(file):
    return jsonify({'existing': True, 'node': _sync_file_node(file)})


def _sync_is_uuid4(value):
    try:
        parsed = uuid.UUID(value)
    except (TypeError, ValueError, AttributeError):
        return False
    return parsed.version == 4 and str(parsed) == value


def _sync_int_field(data, name):
    """Optional non-negative integer from JSON (int) or a form (digit string).
    Returns (value or None, error)."""
    value = data.get(name)
    if value is None or value == '':
        return None, None
    if isinstance(value, str) and _SYNC_INT_RE.fullmatch(value):
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None, _sync_error(400, 'bad_request', f'{name} must be a non-negative integer', field=name)
    return value, None


# ─── Upload spec (fields shared by one-shot and session uploads) ─────────────

def _sync_parse_spec(data):
    """Validate the upload fields of a form or JSON body. Returns (spec, error);
    spec is a flat dict that also carries the _SYNC_META_KEYS values."""
    for name in ('upload_id', 'file_id', 'mode', 'replace_file_id') + _SYNC_META_KEYS:
        if data.get(name) is not None and not isinstance(data.get(name), str):
            return None, _sync_error(400, 'bad_request', f'{name} must be a string', field=name)
    upload_id = data.get('upload_id') or ''
    if not _SYNC_UPLOAD_ID_RE.fullmatch(upload_id):
        return None, _sync_error(400, 'bad_request', 'upload_id must be 1-64 printable characters', field='upload_id')
    mode = data.get('mode')
    if mode not in ('e2ee', 'standard'):
        return None, _sync_error(400, 'bad_request', 'mode must be e2ee or standard', field='mode')
    folder_id, error = _sync_int_field(data, 'folder_id')
    if error:
        return None, error
    base_version, error = _sync_int_field(data, 'base_content_version')
    if error:
        return None, error
    _wrap, error = _sync_folder_link_wrap(data)
    if error:
        return None, error
    spec = {key: data.get(key) or None for key in _SYNC_META_KEYS}
    spec.update(upload_id=upload_id, mode=mode, folder_id=folder_id or None,
                replace_file_id=data.get('replace_file_id') or None,
                base_content_version=base_version, file_id=data.get('file_id') or None)
    is_e2e = mode == 'e2ee'

    if spec['replace_file_id']:
        if len(spec['replace_file_id']) > 36:
            return None, _sync_error(400, 'bad_request', 'Invalid replace_file_id', field='replace_file_id')
        if base_version is None:
            return None, _sync_error(400, 'bad_request', 'base_content_version is required', field='base_content_version')
        # The client re-encrypted with the existing key: names, keys and link wraps stay as they are.
        for name in _SYNC_E2EE_KEY_FIELDS + _SYNC_FOLDER_LINK_FIELDS + ('name',):
            if spec[name]:
                return None, _sync_error(400, 'bad_request', f'{name} cannot change on replace', field=name)
        spec['file_id'] = spec['replace_file_id']
    elif spec['file_id'] and not _sync_is_uuid4(spec['file_id']):
        return None, _sync_error(400, 'bad_request', 'file_id must be a UUID v4', field='file_id')

    if is_e2e:
        if bool(spec['encrypted_meta']) != bool(spec['meta_nonce']):
            return None, _sync_error(400, 'bad_request', 'encrypted_meta and meta_nonce go together', field='encrypted_meta')
        if not spec['replace_file_id']:
            for name in ('encrypted_file_key', 'file_key_nonce', 'encrypted_name', 'name_nonce'):
                if not spec[name]:
                    return None, _sync_error(400, 'bad_request', f'{name} is required', field=name)
            spec['stored_extension'] = normalize_stored_extension(spec['stored_extension'])
        error = _sync_wrap_field_error((
            ('encrypted_file_key', spec['encrypted_file_key'], 48),
            ('file_key_nonce', spec['file_key_nonce'], 12),
            ('encrypted_name', spec['encrypted_name'], None),
            ('name_nonce', spec['name_nonce'], 12),
            ('encrypted_meta', spec['encrypted_meta'], None),
            ('meta_nonce', spec['meta_nonce'], 12),
        ))
        if error:
            return None, error
    else:
        for name in _SYNC_E2EE_KEY_FIELDS + _SYNC_FOLDER_LINK_FIELDS + ('encrypted_meta', 'meta_nonce'):
            if spec[name]:
                return None, _sync_error(400, 'bad_request', f'{name} requires mode e2ee', field=name)
        if not spec['replace_file_id']:
            spec['name'] = sanitize_plaintext_name(spec['name'])
            if not spec['name']:
                return None, _sync_error(400, 'bad_request', 'name is required', field='name')
    return spec, None


def _sync_replace_error(file, spec):
    """Why a replace of file may not proceed, or None."""
    if not file or file.is_trashed:
        return _sync_error(404, 'not_found', 'File not found')
    if bool(file.is_e2e_encrypted) != (spec['mode'] == 'e2ee'):
        return _sync_error(400, 'bad_request', 'Replace cannot change the encryption mode', field='mode')
    if _backup_read_only(file.folder_id):
        return _backup_read_only_error()
    if int(file.content_version or 1) != spec['base_content_version']:
        return _sync_error(409, 'conflict', 'The file changed on the server', current=_sync_file_node(file))
    return None


def _sync_check_target(spec):
    """Create: folder live and writable, mode allowed there, file_id free.
    Replace: see _sync_replace_error. Returns an error response or None."""
    if spec['replace_file_id']:
        return _sync_replace_error(_sync_load_owned_file(spec['replace_file_id']), spec)
    folder_id = spec['folder_id']
    _, _, error = _validate_upload_context(g.api_user, str(folder_id) if folder_id else None,
                                           False, spec['mode'] == 'e2ee')
    if error:
        resp, status = error
        return _sync_error(status, 'not_found' if status == 404 else 'bad_request', resp.get_json()['error'])
    if _backup_read_only(folder_id):
        return _backup_read_only_error()
    if spec['file_id'] and db.session.query(File.id).filter(File.id == spec['file_id']).first():
        return _sync_error(409, 'conflict', 'file_id is already taken', field='file_id')
    return None


def _sync_find_existing(upload_id):
    return _find_existing_upload_by_key(upload_id, registered_user_id=g.api_user.id)


# ─── Commit (create or replace) ──────────────────────────────────────────────

def _sync_commit_upload(spec, staged_path, work_dir, thumbnail_part=None, thumbnail_nonce=None,
                        payload_sha256=None):
    """Validate and commit a staged upload. staged_path is the container (E2EE)
    or the plaintext (standard) and is consumed. The caller holds the upload-key
    locks and found no existing upload for spec['upload_id'].
    Returns (response, committed file id or None)."""
    is_e2e = spec['mode'] == 'e2ee'
    if is_e2e:
        ok, reason = validate_e2ee_container(staged_path)
        if not ok:
            print(f'[SYNC-UPLOAD] Rejected container for upload {spec["upload_id"]}: {reason}')
            return _sync_error(400, 'bad_request', f'Not a valid encrypted container: {reason}', field='file'), None
        payload_path = staged_path
        size = disk_size = os.path.getsize(staged_path)
        content_hash = payload_checksum = payload_sha256 or _sha256_file(staged_path)
    else:
        payload_path = os.path.join(work_dir, 'payload.enc')
        size = os.path.getsize(staged_path)
        content_hash, payload_checksum = encrypt_file_chunked(staged_path, payload_path)
        disk_size = os.path.getsize(payload_path)
    sums = (size, disk_size, content_hash, payload_checksum)
    if spec['replace_file_id']:
        return _sync_replace_file(spec, payload_path, sums, thumbnail_part, thumbnail_nonce)
    return _sync_create_file(spec, payload_path, sums, thumbnail_part, thumbnail_nonce)


def _sync_create_file(spec, payload_path, sums, thumbnail_part, thumbnail_nonce):
    size, disk_size, content_hash, payload_checksum = sums
    uid = g.api_user.id
    is_e2e = spec['mode'] == 'e2ee'
    file_id = spec['file_id'] or str(uuid.uuid4())
    # The payload is published as <file_id>.enc before the INSERT commits, so two
    # uploads proposing one file_id must never overlap: the loser would overwrite
    # and then clean up the winner's payload. The rewrite lock serializes them and
    # the re-check below (fresh snapshot) turns the loser into a 409.
    id_lock = _acquire_file_rewrite_lock(file_id)
    quota_lock = None
    try:
        db.session.rollback()
        error = _sync_check_target(spec)
        if error:
            return error, None
        quota_lock = _acquire_finalize_quota_lock(uid)
        if quota_lock is None:
            return _sync_busy(), None
        if not db.session.get(User, uid).has_storage_available(disk_size):
            return _sync_error(413, 'quota_exceeded', 'Storage limit exceeded'), None
        file_record = File(
            id=file_id,
            orig_name=f'encrypted_{file_id[:8]}{spec["stored_extension"] or ""}' if is_e2e else spec['name'],
            filename=f'{file_id}.enc',
            size=size,
            expires_at=None,
            is_public=False,
            management_token=str(uuid.uuid4()),
            user_id=str(uuid.uuid4()),
            registered_user_id=uid,
            folder_id=spec['folder_id'],
            is_e2e_encrypted=is_e2e,
            encrypted_file_key=spec['encrypted_file_key'],
            file_key_nonce=spec['file_key_nonce'],
            encrypted_name=spec['encrypted_name'],
            name_nonce=spec['name_nonce'],
            stored_extension=spec['stored_extension'],
            is_legacy_encrypted=not is_e2e,
            is_temp_upload=False,
            upload_idempotency_key=spec['upload_id'],
            content_hash=content_hash,
            payload_checksum=payload_checksum,
            disk_size=disk_size,
            content_version=1,
            encrypted_meta=spec['encrypted_meta'],
            meta_nonce=spec['meta_nonce'],
        )
        _sync_apply_folder_link_wrap(file_record, _sync_folder_link_wrap(spec)[0])
        try:
            outcome, row = _commit_new_upload(file_record, payload_path, uid, {'registered_user_id': uid},
                                              thumbnail_part=thumbnail_part, thumbnail_nonce=thumbnail_nonce,
                                              log_prefix='SYNC-UPLOAD')
        except _IdempotencyIntegrityError as e:
            # A concurrent upload took the proposed file_id after the check above.
            if 'primary' not in str(getattr(e, 'orig', e)).lower():
                raise
            return _sync_error(409, 'conflict', 'file_id is already taken', field='file_id'), None
    finally:
        _release_user_quota_lock(quota_lock)
        _release_file_rewrite_lock(id_lock)
    if outcome == 'folder_missing':
        return _sync_error(404, 'not_found', 'Folder not found'), None
    if outcome == 'db_error':
        return _sync_busy(), None
    if outcome == 'reused':
        return _sync_existing_response(row), row.id
    print(f'[SYNC-UPLOAD] Created file {file_id} ({spec["mode"]}, {disk_size} bytes) in folder '
          f'{spec["folder_id"]} (device {g.device.id})')
    if not is_e2e:
        _schedule_thumbnail_bg(file_id, log_prefix='SYNC-UPLOAD')
    check_storage()
    resp = jsonify(_sync_file_node(row))
    resp.status_code = 201
    return resp, row.id


def _sync_replace_file(spec, payload_path, sums, thumbnail_part, thumbnail_nonce):
    """Swap the file's payload through the staged-rewrite pipeline. Keys, names
    and link wraps stay (the client re-encrypted under the existing file key)."""
    size, disk_size, content_hash, payload_checksum = sums
    uid = g.api_user.id
    file_id = spec['replace_file_id']
    # The per-owner unique index also covers trashed rows; release their claim
    # on this key before the row below takes it (commits on its own).
    _release_trashed_upload_idempotency_keys(spec['upload_id'], registered_user_id=uid)
    rewrite_lock = _acquire_file_rewrite_lock(file_id)
    quota_lock = lifecycle_lock = None
    try:
        quota_lock = _acquire_finalize_quota_lock(uid)
        if quota_lock is None:
            return _sync_busy(), None
        lifecycle_lock = _acquire_user_lifecycle_lock(uid)
        _sync_lock_user_row(uid)
        file = _sync_load_owned_file(file_id, for_update=True)
        error = _sync_replace_error(file, spec)
        if error:
            return error, None
        delta = disk_size - _quota_bytes_for_file(file)
        if delta > 0 and not db.session.get(User, uid).has_storage_available(delta):
            return _sync_error(413, 'quota_exceeded', 'Storage limit exceeded'), None
        version = _snapshot_file_version(file, disk_size)
        filename = file.filename
        storage.store_file_staged(filename, payload_path)
        try:
            file.size = size
            file.disk_size = disk_size
            file.content_hash = content_hash
            file.payload_checksum = payload_checksum
            file.encrypted_meta = spec['encrypted_meta']
            file.meta_nonce = spec['meta_nonce']
            file.content_version = int(file.content_version or 1) + 1
            file.upload_idempotency_key = spec['upload_id']
            # The old thumbnail shows old content; a new one is published after the swap.
            file.has_thumbnail = False
            file.encrypted_thumbnail_nonce = None
            prep_error = _prepare_staged_rewrite_commit(file, {
                'file_id': file.id,
                'size': size,
                'disk_size': disk_size,
                'content_hash': content_hash,
                'payload_checksum': payload_checksum,
            })
            if prep_error:
                db.session.rollback()
                _file_version_discard(version)
                return _sync_busy('Could not stage the new content, try again later'), None
            db.session.commit()
        except BaseException:
            db.session.rollback()
            storage.rollback_staged_file(filename)
            _file_version_discard(version)
            raise
        storage.mark_staged_file_committed(filename)
        storage.finalize_staged_file(filename)
        _commit_file_post_finalize_state(file_id, 'SYNC REPLACE')
        _file_version_committed(version)
        _sync_publish_replaced_thumbnail(file, thumbnail_part, thumbnail_nonce)
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)
        _release_file_rewrite_lock(rewrite_lock)
    print(f'[SYNC-UPLOAD] Replaced content of file {file_id} -> version {file.content_version} '
          f'({disk_size} bytes, device {g.device.id})')
    if not file.is_e2e_encrypted:
        _schedule_thumbnail_bg(file_id, log_prefix='SYNC-UPLOAD')
    check_storage()
    return jsonify(_sync_file_node(file)), file_id


def _sync_publish_replaced_thumbnail(file, thumbnail_part, thumbnail_nonce):
    """After a committed replace: publish the new E2EE thumbnail or drop the
    stale one. Best effort; a thumbnail never fails a replace."""
    try:
        data = None
        if file.is_e2e_encrypted and thumbnail_part and thumbnail_nonce and len(thumbnail_nonce) <= 255:
            data, _oversized = read_bounded_upload_part(thumbnail_part, _MAX_ENCRYPTED_THUMBNAIL_BYTES)
        if data and save_thumbnail_to_disk(file.id, data, is_e2e=True):
            file.encrypted_thumbnail_nonce = thumbnail_nonce
            file.has_thumbnail = True
            db.session.commit()
        else:
            delete_thumbnail_from_disk(file.id)
    except Exception as e:
        db.session.rollback()
        print(f'[SYNC-UPLOAD] Thumbnail update for {file.id} failed (non-critical): {e}')


def _sync_with_upload_key(upload_id, work):
    """Run work() under the upload-key locks; 503 when they are busy."""
    scope = _build_upload_idempotency_scope(upload_id, registered_user_id=g.api_user.id)
    flock, db_lock, busy = _acquire_upload_key_locks(scope)
    try:
        if busy:
            return _sync_busy()
        db.session.rollback()  # fresh snapshot after the wait
        return work()
    finally:
        _release_upload_idempotency_database_lock(db_lock)
        _release_upload_idempotency_lock(flock)


# ─── One-shot upload ─────────────────────────────────────────────────────────

@app.route('/apiv1/sync/files', methods=['POST'])
@csrf.exempt
@limiter.limit(upload_rate_limit)
@device_auth_required
def apiv1_sync_upload_file():
    """Create or replace one file from a single multipart body (<= small_upload_max)."""
    from werkzeug.exceptions import RequestEntityTooLarge
    work_dir = None
    try:
        _install_request_body_counter()
        _set_request_upload_cap(SYNC_SMALL_UPLOAD_MAX + _MAX_ENCRYPTED_THUMBNAIL_BYTES)
        spec, error = _sync_parse_spec(request.form)
        if error:
            return error
        part = request.files.get('file')
        if part is None:
            return _sync_error(400, 'bad_request', 'file part is required', field='file')
        if _request_body_was_truncated():
            return _sync_error(400, 'bad_request', 'Upload was cut short; nothing was saved')
        thumb_part = request.files.get('encrypted_thumbnail')
        thumb_nonce = request.form.get('thumbnail_nonce')

        def work():
            nonlocal work_dir
            existing = _sync_find_existing(spec['upload_id'])
            if existing:
                return _sync_existing_response(existing)
            error = _sync_check_target(spec)
            if error:
                return error
            work_dir = tempfile.mkdtemp(prefix='oneshot_', dir=_sync_sessions_root())
            staged_path = os.path.join(work_dir, 'upload')
            part.save(staged_path)
            if os.path.getsize(staged_path) > SYNC_SMALL_UPLOAD_MAX:
                return _sync_error(400, 'bad_request', 'File too large for a one-shot upload; use an upload session', field='file')
            resp, _file_id = _sync_commit_upload(spec, staged_path, work_dir, thumb_part, thumb_nonce)
            return resp

        return _sync_with_upload_key(spec['upload_id'], work)
    except RequestEntityTooLarge:
        return _sync_error(400, 'bad_request', 'File too large for a one-shot upload; use an upload session', field='file')
    finally:
        if work_dir:
            _sync_remove_dir(work_dir)


# ─── Upload sessions ─────────────────────────────────────────────────────────

def _sync_parts(session):
    """{index: (sha256, size)} of the parts received so far."""
    try:
        entries = json.loads(session.parts_received or '[]')
        return {int(i): (sha, int(n)) for i, sha, n in entries}
    except (TypeError, ValueError):
        return {}


def _sync_session_json(session):
    return {
        'session_id': session.id,
        'file_id': session.file_id,
        'parts_received': sorted(_sync_parts(session)),
        'expires_at': _sync_iso(session.expires_at),
    }


def _sync_session_payload_size(session):
    """Bytes the parts must add up to (the container minus its header in E2EE)."""
    return int(session.cipher_size) - (_E2EE_HEADER_SIZE if session.mode == 'e2ee' else 0)


def _sync_session_spec(session):
    spec = dict(json.loads(session.meta_json or '{}'))
    spec.update(upload_id=session.upload_id, file_id=session.file_id, folder_id=session.folder_id,
                mode=session.mode, replace_file_id=session.replace_file_id,
                base_content_version=session.base_content_version)
    return spec


def _sync_load_session(session_id, for_update=False):
    if not isinstance(session_id, str) or len(session_id) > 36:
        return None
    query = SyncUploadSession.query.filter_by(id=session_id, user_id=g.api_user.id)
    if for_update:
        query = query.populate_existing().with_for_update()
    return query.first()


def _sync_session_open(session):
    return (session is not None and session.state == 'open'
            and _sync_aware(session.expires_at) > datetime.now(timezone.utc))


def _sync_session_expiry():
    return datetime.now(timezone.utc) + timedelta(seconds=max(60, get_numeric_setting('sync_upload_session_ttl')))


def _sync_committed_session_response(session):
    file = _sync_load_owned_file(session.committed_file_id) if session.committed_file_id else None
    if not file:
        return _sync_error(404, 'not_found', 'The uploaded file no longer exists')
    return _sync_existing_response(file)


def _sync_mark_session(session, state, file_id=None):
    """Close a session (committed or aborted) and drop its staged parts."""
    session.state = state
    session.committed_file_id = file_id
    session.parts_received = '[]'
    session.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    _sync_remove_dir(_sync_session_dir(session.id))


@app.route('/apiv1/sync/uploads', methods=['POST'])
@csrf.exempt
@limiter.limit(upload_rate_limit)
@device_auth_required
def apiv1_sync_upload_session_create():
    body, error = _sync_body_or_error()
    if error:
        return error
    spec, error = _sync_parse_spec(body)
    if error:
        return error
    chunk_count, error = _sync_int_field(body, 'chunk_count')
    if error:
        return error
    if not chunk_count:
        return _sync_error(400, 'bad_request', 'chunk_count must be at least 1', field='chunk_count')
    cipher_sha256 = body.get('cipher_sha256')
    if not isinstance(cipher_sha256, str) or not _SYNC_SHA256_RE.fullmatch(cipher_sha256.lower()):
        return _sync_error(400, 'bad_request', 'cipher_sha256 must be a SHA-256 hex digest', field='cipher_sha256')
    cipher_sha256 = cipher_sha256.lower()
    cipher_size, error = _sync_int_field(body, 'cipher_size')
    if error:
        return error
    header_b64 = None
    if spec['mode'] == 'e2ee':
        header_b64 = body.get('header_b64')
        try:
            header = base64.b64decode(header_b64, validate=True) if isinstance(header_b64, str) else b''
        except ValueError:
            header = b''
        if (len(header) != _E2EE_HEADER_SIZE or header[0] not in _E2EE_FILE_FORMAT_VERSIONS
                or int.from_bytes(header[1:5], 'big') != chunk_count):
            return _sync_error(400, 'bad_request', 'header_b64 must be the 17-byte container header for chunk_count chunks',
                               field='header_b64')
        if cipher_size is None:
            return _sync_error(400, 'bad_request', 'cipher_size is required', field='cipher_size')
        low = _E2EE_HEADER_SIZE + chunk_count * (4 + _E2EE_GCM_TAG_SIZE)
        high = _E2EE_HEADER_SIZE + chunk_count * _SYNC_MAX_E2EE_PART
        if not low <= cipher_size <= high:
            return _sync_error(400, 'bad_request', 'cipher_size does not fit chunk_count', field='cipher_size')
    else:
        plain_size, error = _sync_int_field(body, 'plain_size')
        if error:
            return error
        if plain_size is None or (cipher_size is not None and cipher_size != plain_size):
            return _sync_error(400, 'bad_request', 'plain_size is required (and equals cipher_size in standard mode)',
                               field='plain_size')
        cipher_size = plain_size
        if chunk_count < max(1, -(-plain_size // SYNC_CHUNK_SIZE)):
            return _sync_error(400, 'bad_request', 'chunk_count too small for chunk_size', field='chunk_count')
    if cipher_size > app.config['MAX_CONTENT_LENGTH']:
        return _sync_error(400, 'bad_request', 'File exceeds max_upload', field='cipher_size')
    payload_size = cipher_size - (_E2EE_HEADER_SIZE if spec['mode'] == 'e2ee' else 0)
    if chunk_count > payload_size // _SYNC_MIN_PART_PAYLOAD + 1:
        return _sync_error(400, 'bad_request', 'Too many chunks for this size', field='chunk_count')

    uid = g.api_user.id

    def work():
        existing = _sync_find_existing(spec['upload_id'])
        if existing:
            return _sync_existing_response(existing)
        session = SyncUploadSession.query.filter_by(user_id=uid, upload_id=spec['upload_id']).first()
        if session is not None:
            if session.state == 'committed':
                return _sync_committed_session_response(session)
            if _sync_session_open(session):
                return jsonify(_sync_session_json(session))
            # Aborted or expired: start over under the same upload_id.
            stale_id = session.id
            db.session.delete(session)
            db.session.commit()
            _sync_remove_dir(_sync_session_dir(stale_id))
        error = _sync_check_target(spec)
        if error:
            return error

        # Advisory quota check; the authoritative one runs at complete under the
        # quota lock. Open sessions of this user count as in-flight bytes.
        user = db.session.get(User, uid)
        needed = cipher_size
        if spec['replace_file_id']:
            needed -= _quota_bytes_for_file(_sync_load_owned_file(spec['replace_file_id']))
        in_flight = db.session.query(db.func.coalesce(db.func.sum(SyncUploadSession.cipher_size), 0)).filter(
            SyncUploadSession.user_id == uid, SyncUploadSession.state == 'open',
            SyncUploadSession.expires_at > datetime.now(timezone.utc)).scalar() or 0
        if needed > 0 and not user.has_storage_available(int(in_flight) + needed):
            return _sync_error(413, 'quota_exceeded', 'Storage limit exceeded')

        session = SyncUploadSession(
            user_id=uid, device_id=g.device.id, upload_id=spec['upload_id'],
            file_id=spec['file_id'] or str(uuid.uuid4()), folder_id=spec['folder_id'],
            replace_file_id=spec['replace_file_id'], base_content_version=spec['base_content_version'],
            mode=spec['mode'], chunk_count=chunk_count, cipher_size=cipher_size, cipher_sha256=cipher_sha256,
            header_b64=header_b64, meta_json=json.dumps({key: spec[key] for key in _SYNC_META_KEYS}),
            parts_received='[]', expires_at=_sync_session_expiry(), state='open')
        db.session.add(session)
        db.session.commit()
        os.makedirs(_sync_session_dir(session.id), exist_ok=True)
        print(f'[SYNC-UPLOAD] Opened session {session.id} for file {session.file_id} ({spec["mode"]}, '
              f'{chunk_count} part(s), {cipher_size} bytes, replace={bool(spec["replace_file_id"])}, device {g.device.id})')
        resp = jsonify(_sync_session_json(session))
        resp.status_code = 201
        return resp

    return _sync_with_upload_key(spec['upload_id'], work)


@app.route('/apiv1/sync/uploads/<session_id>', methods=['GET'])
@csrf.exempt
@device_auth_required
def apiv1_sync_upload_session_status(session_id):
    session = _sync_load_session(session_id)
    if session is None or session.state == 'aborted' or (session.state == 'open' and not _sync_session_open(session)):
        return _sync_error(404, 'not_found', 'Upload session not found')
    return jsonify(_sync_session_json(session))


@app.route('/apiv1/sync/uploads/<session_id>/parts/<int:index>', methods=['PUT'])
@csrf.exempt
@limiter.limit(upload_rate_limit)
@device_auth_required
def apiv1_sync_upload_part(session_id, index):
    """Store one part: written to a temp name, fsynced, hash-verified, renamed."""
    session = _sync_load_session(session_id)
    if not _sync_session_open(session):
        return _sync_error(404, 'not_found', 'Upload session not found')
    if not 0 <= index < session.chunk_count:
        return _sync_error(400, 'bad_request', 'Part index out of range', field='index')
    expected = (request.headers.get('X-Content-SHA256') or '').strip().lower()
    if not _SYNC_SHA256_RE.fullmatch(expected):
        return _sync_error(400, 'bad_request', 'X-Content-SHA256 must be a SHA-256 hex digest', field='X-Content-SHA256')
    is_e2e = session.mode == 'e2ee'
    length = request.content_length
    max_part = _SYNC_MAX_E2EE_PART if is_e2e else SYNC_CHUNK_SIZE
    min_part = 4 + _E2EE_GCM_TAG_SIZE if is_e2e else 0
    if length is None:
        return _sync_error(400, 'bad_request', 'Content-Length is required')
    if not min_part <= length <= max_part:
        return _sync_error(400, 'bad_request', f'Part size must be between {min_part} and {max_part} bytes')
    _set_request_upload_cap(max_part)
    parts = _sync_parts(session)
    payload_size = _sync_session_payload_size(session)
    if index in parts or sum(n for _sha, n in parts.values()) + length > payload_size:
        # Read the (size-checked) body first: answering mid-upload resets the
        # client's connection instead of delivering the answer.
        while request.stream.read(1024 * 1024):
            pass
        if index not in parts:
            return _sync_error(400, 'bad_request', 'Parts exceed the declared size')
        if parts[index][0] != expected:
            return _sync_error(409, 'conflict', 'A different part was already stored at this index')
        return jsonify(_sync_session_json(session))
    sid = session.id
    part_dir = _sync_session_dir(sid)
    os.makedirs(part_dir, exist_ok=True)
    # No transaction or row lock is held across the body read.
    db.session.rollback()
    tmp_path = os.path.join(part_dir, f'{index}.tmp-{secrets.token_hex(4)}')
    try:
        hasher = hashlib.sha256()
        written = 0
        prefix = b''
        with open(tmp_path, 'wb') as out:
            while written < length:
                chunk = request.stream.read(min(1024 * 1024, length - written))
                if not chunk:
                    break
                if len(prefix) < 4:
                    prefix += chunk[:4 - len(prefix)]
                hasher.update(chunk)
                out.write(chunk)
                written += len(chunk)
            out.flush()
            os.fsync(out.fileno())
        if written != length:
            return _sync_error(400, 'bad_request', 'Body shorter than Content-Length')
        if hasher.hexdigest() != expected:
            return _sync_error(400, 'bad_request', 'Part does not match X-Content-SHA256', field='X-Content-SHA256')
        if is_e2e and int.from_bytes(prefix, 'big') != length - 4:
            return _sync_error(400, 'bad_request', 'Chunk length prefix does not match the part size')

        # Publish under the session row lock so concurrent parts never lose an entry.
        session = _sync_load_session(sid, for_update=True)
        if not _sync_session_open(session):
            return _sync_error(404, 'not_found', 'Upload session not found')
        parts = _sync_parts(session)
        if index in parts:
            if parts[index][0] != expected:
                return _sync_error(409, 'conflict', 'A different part was already stored at this index')
            return jsonify(_sync_session_json(session))
        if sum(n for _sha, n in parts.values()) + length > payload_size:
            return _sync_error(400, 'bad_request', 'Parts exceed the declared size')
        os.replace(tmp_path, os.path.join(part_dir, str(index)))
        tmp_path = None
        _fsync_path(part_dir, kind='dir')
        parts[index] = (expected, length)
        session.parts_received = json.dumps(sorted([i, sha, n] for i, (sha, n) in parts.items()))
        session.updated_at = datetime.now(timezone.utc)
        session.expires_at = _sync_session_expiry()
        db.session.commit()
        return jsonify(_sync_session_json(session))
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


def _sync_assemble(session, parts, out_path):
    """Header (E2EE) + parts in order into out_path, streamed. Returns (sha256, size)."""
    part_dir = _sync_session_dir(session.id)
    hasher = hashlib.sha256()
    size = 0
    with open(out_path, 'wb') as out:
        if session.mode == 'e2ee':
            header = base64.b64decode(session.header_b64)
            out.write(header)
            hasher.update(header)
            size += len(header)
        for index in range(session.chunk_count):
            with open(os.path.join(part_dir, str(index)), 'rb') as part:
                if os.fstat(part.fileno()).st_size != parts[index][1]:
                    raise ValueError(f'part {index} of session {session.id} changed size on disk')
                while True:
                    chunk = part.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    hasher.update(chunk)
                    size += len(chunk)
        out.flush()
        os.fsync(out.fileno())
    return hasher.hexdigest(), size


@app.route('/apiv1/sync/uploads/<session_id>/complete', methods=['POST'])
@csrf.exempt
@limiter.limit(upload_rate_limit)
@device_auth_required
def apiv1_sync_upload_complete(session_id):
    body = _sync_json_body()
    if body is None:
        if request.get_data(cache=True):
            return _sync_error(400, 'bad_request', 'JSON object body required')
        body = {}
    thumb_part = None
    thumb_nonce = body.get('thumbnail_nonce')
    thumb_b64 = body.get('encrypted_thumbnail_b64')
    if thumb_b64 is not None or thumb_nonce is not None:
        if not isinstance(thumb_b64, str) or not isinstance(thumb_nonce, str):
            return _sync_error(400, 'bad_request', 'encrypted_thumbnail_b64 and thumbnail_nonce must be strings',
                               field='encrypted_thumbnail_b64')
        try:
            thumb_part = io.BytesIO(base64.b64decode(thumb_b64, validate=True))
        except ValueError:
            return _sync_error(400, 'bad_request', 'Invalid encrypted_thumbnail_b64', field='encrypted_thumbnail_b64')
    session = _sync_load_session(session_id)
    if session is None or session.state == 'aborted':
        return _sync_error(404, 'not_found', 'Upload session not found')

    def work():
        session = _sync_load_session(session_id)
        if session is None or session.state == 'aborted':
            return _sync_error(404, 'not_found', 'Upload session not found')
        if session.state == 'committed':
            return _sync_committed_session_response(session)
        if not _sync_session_open(session):
            return _sync_error(404, 'not_found', 'Upload session not found')
        existing = _sync_find_existing(session.upload_id)
        if existing:
            # Committed before the session row was updated (crash, lost response).
            _sync_mark_session(session, 'committed', existing.id)
            return _sync_existing_response(existing)
        parts = _sync_parts(session)
        missing = [i for i in range(session.chunk_count) if i not in parts]
        if missing:
            return _sync_error(400, 'bad_request', 'Parts are missing', missing=missing[:1000])
        part_dir = _sync_session_dir(session.id)
        assembled = os.path.join(part_dir, 'assembled')
        try:
            digest, size = _sync_assemble(session, parts, assembled)
            if size != int(session.cipher_size) or digest != session.cipher_sha256:
                print(f'[SYNC-UPLOAD] Session {session.id} assembled to a different size/sha256; aborting it')
                _sync_mark_session(session, 'aborted')
                return _sync_error(400, 'bad_request', 'Assembled upload does not match cipher_size/cipher_sha256',
                                   field='cipher_sha256')
            if session.mode == 'e2ee':
                ok, reason = validate_e2ee_container(assembled)
                if not ok:
                    print(f'[SYNC-UPLOAD] Session {session.id} is not a valid container ({reason}); aborting it')
                    _sync_mark_session(session, 'aborted')
                    return _sync_error(400, 'bad_request', f'Not a valid encrypted container: {reason}')
            sid = session.id
            resp, file_id = _sync_commit_upload(_sync_session_spec(session), assembled, part_dir,
                                                thumb_part, thumb_nonce,
                                                payload_sha256=digest if session.mode == 'e2ee' else None)
            if file_id:
                session = _sync_load_session(sid)
                if session is not None:
                    _sync_mark_session(session, 'committed', file_id)
            return resp
        finally:
            for leftover in (assembled, os.path.join(part_dir, 'payload.enc')):
                if os.path.exists(leftover):
                    os.remove(leftover)

    return _sync_with_upload_key(session.upload_id, work)


@app.route('/apiv1/sync/uploads/<session_id>', methods=['DELETE'])
@csrf.exempt
@device_auth_required
def apiv1_sync_upload_session_delete(session_id):
    session = _sync_load_session(session_id)
    if session is None:
        return _sync_error(404, 'not_found', 'Upload session not found')

    def work():
        session = _sync_load_session(session_id)
        if session is None:
            return _sync_error(404, 'not_found', 'Upload session not found')
        sid = session.id
        db.session.delete(session)
        db.session.commit()
        _sync_remove_dir(_sync_session_dir(sid))
        print(f'[SYNC-UPLOAD] Deleted session {sid} (device {g.device.id})')
        return '', 204

    return _sync_with_upload_key(session.upload_id, work)


# ─── Cleanup (cleanup_job, 350_scheduler.py) ─────────────────────────────────

def _cleanup_expired_sync_upload_sessions():
    """Delete sessions idle past sync_upload_session_ttl with their parts, then
    staging dirs no session row owns (one-shot work dirs, crash leftovers)."""
    now = datetime.now(timezone.utc)
    try:
        expired = [row[0] for row in db.session.query(SyncUploadSession.id).filter(
            SyncUploadSession.expires_at < now).all()]
        if expired:
            SyncUploadSession.query.filter(SyncUploadSession.id.in_(expired)).delete(synchronize_session=False)
            db.session.commit()
        live = {row[0] for row in db.session.query(SyncUploadSession.id).all()}
        db.session.rollback()
    except Exception as e:
        db.session.rollback()
        print(f'[SYNC-UPLOAD] Session cleanup failed: {e}')
        return 0
    root = _sync_sessions_root()
    for sid in expired:
        _sync_remove_dir(os.path.join(root, sid))
    min_idle = max(get_numeric_setting('sync_upload_session_ttl'), _SYNC_ORPHAN_MIN_AGE_SECONDS)
    orphans = 0
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if name in live or not os.path.isdir(path):
            continue
        last_activity = _work_dir_last_activity(path)
        if last_activity is not None and time.time() - last_activity > min_idle:
            _sync_remove_dir(path)
            orphans += 1
    if expired or orphans:
        print(f'[SYNC-UPLOAD] Removed {len(expired)} expired upload session(s) and {orphans} orphaned staging dir(s)')
    return len(expired)
