# File versions: hidden previous payloads of a drive file (desktop/docs/sync-api.md, "Versions").
#
# A content rewrite (sync replace, website save-content, version restore) of a
# file whose owner keeps versions first turns the current payload into a hidden
# File row: version_of_id = live id, no owner, folder or expiry, payload
# <version id>.enc. The payload is hard-linked to that name before the rewrite
# commits, so the staged swap of <live id>.enc leaves the old inode with the
# version (no copy). Storage is keyed by File.id, so replication, scrub, backup
# and orphan cleanup treat a version like any file row: remotes receive it as a
# new object while the live object is overwritten as before (no egress).
# Crash safety: a stray link left by a rewrite that never committed is reaped by
# cleanup_orphaned_files; a committed version whose replica rows were never
# queued is picked up by the replication self-heal.
# Versions count toward the owner's quota (User.get_storage_used), never appear
# in listings, search, trash or /changes (no registered_user_id) and are pruned
# by _cleanup_file_versions() (cleanup_job).
#
# Lock order matches 376: file rewrite (live id) -> quota -> lifecycle -> user row -> file row.


def _file_versions_enabled(user):
    """True when content rewrites of user's files keep the previous version."""
    return bool(user and user.keep_file_versions) and get_numeric_setting('file_version_retention_count') > 0


def _link_or_copy(src, dst):
    """Durably make dst a hard link to src, or a copy when linking fails."""
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)
        with open(dst, 'rb') as f:
            os.fsync(f.fileno())
    _fsync_path(os.path.dirname(dst), kind='dir')


def _snapshot_file_version(file, new_disk_size):
    """Before a content rewrite of file commits (the caller holds its rewrite and
    quota locks and has not changed its columns yet): keep the current payload as
    a version when the owner keeps versions and the new payload fits beside it.
    Adds the row to the session for the caller's commit; returns it or None."""
    if not file.registered_user_id or file.is_temp_upload is not False or file.version_of_id:
        return None
    user = db.session.get(User, file.registered_user_id)
    if not _file_versions_enabled(user):
        return None
    if not user.has_storage_available(new_disk_size or 0):
        print(f'[VERSIONS] Not keeping a version of {file.id}: no room for it beside the new content')
        return None
    src = storage._local_backend.get_path('files', file.filename)
    if not os.path.isfile(src):
        src = storage.get_file_path(file.filename)  # cache mode: staged from a remote copy
    if not src or not _payload_disk_size_matches(src, file.disk_size):
        print(f'[VERSIONS] [WARNING] Not keeping a version of {file.id}: current payload unavailable')
        return None
    version_id = str(uuid.uuid4())
    version = File(
        id=version_id,
        filename=f'{version_id}.enc',
        version_of_id=file.id,
        orig_name=file.orig_name,
        size=file.size,
        disk_size=file.disk_size,
        content_hash=file.content_hash,
        payload_checksum=file.payload_checksum,
        content_version=int(file.content_version or 1),
        encrypted_meta=file.encrypted_meta,
        meta_nonce=file.meta_nonce,
        is_e2e_encrypted=file.is_e2e_encrypted,
        is_legacy_encrypted=file.is_legacy_encrypted,
        encrypted_file_key=file.encrypted_file_key,
        file_key_nonce=file.file_key_nonce,
        file_key_salt=file.file_key_salt,
        encrypted_name=file.encrypted_name,
        name_nonce=file.name_nonce,
        stored_extension=file.stored_extension,
        management_token=str(uuid.uuid4()),
        user_id=str(uuid.uuid4()),
        registered_user_id=None,
        folder_id=None,
        is_temp_upload=False,
        is_public=False,
        expires_at=None,
        upload_time=datetime.now(timezone.utc),
    )
    _link_or_copy(src, storage._local_backend.get_path('files', version.filename))
    db.session.add(version)
    return version


def _file_version_committed(version):
    """After the rewrite committed and finalized: record the version's local
    replica and queue its remote copies. Best effort (replication self-heals)."""
    if version is None:
        return
    version_id = version.id
    try:
        storage.queue_file_replication(version_id, verified_at=datetime.now(timezone.utc))
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f'[VERSIONS] Queueing replication of version {version_id} failed (self-heals): {e}')


def _file_version_discard(version):
    """The rewrite failed before committing: drop the version's payload link."""
    if version is not None:
        storage._local_backend.delete('files', version.filename)


# ─── Shared route logic (device and website) ─────────────────────────────────

def _version_json(version, live):
    is_e2e = bool(version.is_e2e_encrypted)
    return {
        'version_id': version.id,
        'content_version': int(version.content_version or 1),
        'size': version.size,
        'disk_size': version.disk_size,
        'payload_checksum': version.payload_checksum,
        'encrypted_meta': version.encrypted_meta if is_e2e else None,
        'meta_nonce': version.meta_nonce if is_e2e else None,
        'encrypted_file_key': version.encrypted_file_key if is_e2e else None,
        'file_key_nonce': version.file_key_nonce if is_e2e else None,
        'same_key': not is_e2e or version.encrypted_file_key == live.encrypted_file_key,
        'created_at': _sync_iso(version.get_upload_time_aware()),
    }


def _versions_live_file(user_id, file_id, for_update=False):
    """The user's live (non-trashed) drive file, or None."""
    if not isinstance(file_id, str) or not file_id or len(file_id) > 36:
        return None
    query = File.query.filter(
        File.id == file_id, File.registered_user_id == user_id,
        File.is_temp_upload == False, File.is_trashed == False,
    ).options(db.defer(File.thumbnail_data), db.defer(File.encrypted_thumbnail_data))
    if for_update:
        query = query.populate_existing().with_for_update()
    return query.first()


def _versions_load(live_id, version_id):
    if not isinstance(version_id, str) or not version_id or len(version_id) > 36:
        return None
    return File.query.filter(File.id == version_id, File.version_of_id == live_id).options(
        db.defer(File.thumbnail_data), db.defer(File.encrypted_thumbnail_data)).first()


def _versions_list_response(user_id, file_id):
    live = _versions_live_file(user_id, file_id)
    if not live:
        return _sync_error(404, 'not_found', 'File not found')
    versions = File.query.filter(File.version_of_id == live.id).options(
        db.defer(File.thumbnail_data), db.defer(File.encrypted_thumbnail_data)
    ).order_by(File.content_version.desc(), File.upload_time.desc()).all()
    return jsonify({
        'file_id': live.id,
        'content_version': int(live.content_version or 1),
        'versions': [_version_json(v, live) for v in versions],
    })


def _versions_content_response(user_id, file_id, version_id):
    """(version, response): the stored payload with /content semantics."""
    live = _versions_live_file(user_id, file_id)
    version = _versions_load(live.id, version_id) if live else None
    if not version:
        return None, _sync_error(404, 'not_found', 'Version not found')
    return version, _sync_send_content(version, _version_json(version, live))


_RESTORE_STRING_FIELDS = ('encrypted_name', 'name_nonce', 'link_encrypted_file_key', 'link_file_key_nonce',
                          'folder_link_encrypted_file_key', 'folder_link_file_key_nonce',
                          'encrypted_meta', 'meta_nonce')


def _restore_key_error(live, body):
    """When the version's file key differs from the live one (a website edit
    rotated it), restore installs the version's key, so the live name and link
    wraps must arrive re-encrypted under it. Returns an error response or None."""
    pairs = []
    if live.encrypted_name:
        pairs.append(('encrypted_name', 'name_nonce', None))
    if live.link_encrypted_file_key:
        pairs.append(('link_encrypted_file_key', 'link_file_key_nonce', 48))
    if live.folder_link_encrypted_file_key or (live.folder_id and get_shared_ancestor_info(live.folder_id)):
        pairs.append(('folder_link_encrypted_file_key', 'folder_link_file_key_nonce', 48))
    for value_field, nonce_field, _size in pairs:
        if not body.get(value_field) or not body.get(nonce_field):
            return _sync_error(400, 'bad_request', f'This version uses another file key: {value_field} and '
                               f'{nonce_field} re-encrypted under it are required', field=value_field,
                               key_changed=True)
    fields = []
    for value_field, nonce_field, size in pairs:
        fields += [(value_field, body[value_field], size), (nonce_field, body[nonce_field], 12)]
    return _sync_wrap_field_error(fields)


def _restore_file_version(user_id, file_id, version_id, body, label):
    """Make a version the live content as a replace: content_version + 1, the
    current content becomes a version when kept, the restored version stays.
    body: optional base_content_version, encrypted_meta + meta_nonce, and the
    _restore_key_error() fields. Returns (response, restored live file or None)."""
    base_version = body.get('base_content_version')
    if base_version is not None and (isinstance(base_version, bool) or not isinstance(base_version, int)):
        return _sync_error(400, 'bad_request', 'base_content_version must be an integer',
                           field='base_content_version'), None
    for name in _RESTORE_STRING_FIELDS:
        if body.get(name) is not None and not isinstance(body[name], str):
            return _sync_error(400, 'bad_request', f'{name} must be a string', field=name), None
    if bool(body.get('encrypted_meta')) != bool(body.get('meta_nonce')):
        return _sync_error(400, 'bad_request', 'encrypted_meta and meta_nonce go together', field='encrypted_meta'), None
    error = _sync_wrap_field_error((('encrypted_meta', body.get('encrypted_meta'), None),
                                    ('meta_nonce', body.get('meta_nonce'), 12)))
    if error:
        return error, None

    rewrite_lock = _acquire_file_rewrite_lock(file_id)
    quota_lock = lifecycle_lock = new_version = work_dir = None
    try:
        quota_lock = _acquire_finalize_quota_lock(user_id)
        if quota_lock is None:
            return _sync_busy(), None
        lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
        _sync_lock_user_row(user_id)
        live = _versions_live_file(user_id, file_id, for_update=True)
        version = _versions_load(live.id, version_id) if live else None
        if not version:
            return _sync_error(404, 'not_found', 'Version not found'), None
        if _backup_read_only(live.folder_id):
            return _backup_read_only_error(), None
        if base_version is not None and base_version != int(live.content_version or 1):
            return _sync_error(409, 'conflict', 'The file changed on the server', current=_sync_file_node(live)), None
        if bool(version.is_e2e_encrypted) != bool(live.is_e2e_encrypted):
            return _sync_error(400, 'bad_request', 'This version uses another encryption mode'), None
        same_key = not live.is_e2e_encrypted or version.encrypted_file_key == live.encrypted_file_key
        if not same_key:
            error = _restore_key_error(live, body)
            if error:
                return error, None
        if not live.is_e2e_encrypted and body.get('encrypted_meta'):
            return _sync_error(400, 'bad_request', 'encrypted_meta requires an E2EE file', field='encrypted_meta'), None
        delta = int(version.disk_size or 0) - _quota_bytes_for_file(live)
        if delta > 0 and not db.session.get(User, user_id).has_storage_available(delta):
            return _sync_error(413, 'quota_exceeded', 'Storage limit exceeded'), None

        src = storage.get_file_path(version.filename)
        if not src or not _payload_disk_size_matches(src, version.disk_size):
            print(f'[ERROR] [VERSIONS] Payload of version {version.id} missing or wrong size; restore refused')
            return _sync_error(500, 'integrity_error', 'The stored version failed an integrity check'), None
        work_dir = create_work_dir('version_restore_')
        payload = os.path.join(work_dir, 'payload')
        shutil.copyfile(src, payload)
        if version.payload_checksum and _sha256_file(payload) != version.payload_checksum:
            print(f'[ERROR] [VERSIONS] Checksum mismatch on version {version.id}; restore refused')
            return _sync_error(500, 'integrity_error', 'The stored version failed an integrity check'), None

        new_version = _snapshot_file_version(live, version.disk_size)
        filename = live.filename
        storage.store_file_staged(filename, payload)
        try:
            live.size = version.size
            live.disk_size = version.disk_size
            live.content_hash = version.content_hash
            live.payload_checksum = version.payload_checksum
            live.content_version = int(live.content_version or 1) + 1
            live.encrypted_meta = body.get('encrypted_meta') or None
            live.meta_nonce = body.get('meta_nonce') or None
            live.has_thumbnail = False
            live.encrypted_thumbnail_nonce = None
            meta = {'file_id': live.id, 'size': live.size, 'disk_size': live.disk_size,
                    'content_hash': live.content_hash, 'payload_checksum': live.payload_checksum}
            if not same_key:
                live.encrypted_file_key = version.encrypted_file_key
                live.file_key_nonce = version.file_key_nonce
                live.file_key_salt = version.file_key_salt
                if live.encrypted_name:
                    live.encrypted_name = body['encrypted_name']
                    live.name_nonce = body['name_nonce']
                if live.link_encrypted_file_key:
                    live.link_encrypted_file_key = body['link_encrypted_file_key']
                    live.link_file_key_nonce = body['link_file_key_nonce']
                if body.get('folder_link_encrypted_file_key'):
                    live.folder_link_encrypted_file_key = body['folder_link_encrypted_file_key']
                    live.folder_link_file_key_nonce = body['folder_link_file_key_nonce']
                    live.is_link_shared = True
                meta.update(encrypted_name=live.encrypted_name, name_nonce=live.name_nonce,
                            encrypted_file_key=live.encrypted_file_key, file_key_nonce=live.file_key_nonce)
            prep_error = _prepare_staged_rewrite_commit(live, meta)
            if prep_error:
                db.session.rollback()
                _file_version_discard(new_version)
                return _sync_busy('Could not stage the restored content, try again later'), None
            db.session.commit()
        except BaseException:
            db.session.rollback()
            storage.rollback_staged_file(filename)
            _file_version_discard(new_version)
            raise
        storage.mark_staged_file_committed(filename)
        storage.finalize_staged_file(filename)
        _commit_file_post_finalize_state(file_id, label)
        _file_version_committed(new_version)
        delete_thumbnail_from_disk(file_id)
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)
        _release_file_rewrite_lock(rewrite_lock)
        if work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)
    live = _versions_live_file(user_id, file_id)
    print(f'[VERSIONS] Restored version {version_id} of file {file_id} -> content version '
          f'{live.content_version if live else "?"} ({label})')
    if live and not live.is_e2e_encrypted:
        _schedule_thumbnail_bg(file_id, log_prefix='VERSIONS')
    check_storage()
    return None, live


def _delete_file_version(user_id, file_id, version_id):
    """Delete one version row and its payload. Returns an error response or None."""
    rewrite_lock = _acquire_file_rewrite_lock(file_id)
    lifecycle_lock = None
    local_targets = []
    try:
        lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
        db.session.rollback()
        live = _versions_live_file(user_id, file_id)
        version = _versions_load(live.id, version_id) if live else None
        if not version:
            return _sync_error(404, 'not_found', 'Version not found')
        if _backup_read_only(live.folder_id):
            return _backup_read_only_error()
        local_targets = storage.stage_payload_deletes(_file_payload_delete_keys(version))
        db.session.delete(version)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_file_rewrite_lock(rewrite_lock)
    storage.purge_staged_locals(local_targets)
    print(f'[VERSIONS] Deleted version {version_id} of file {file_id}')
    return None


def _session_versions_user():
    user = _current_session_user()
    return user.id if user else None


# ─── Device routes ───────────────────────────────────────────────────────────

@app.route('/apiv1/sync/files/<file_id>/versions', methods=['GET'])
@csrf.exempt
@device_auth_required
def apiv1_sync_file_versions(file_id):
    return _versions_list_response(g.api_user.id, file_id)


@app.route('/apiv1/sync/files/<file_id>/versions/<version_id>/content', methods=['GET'])
@csrf.exempt
@limiter.limit(download_rate_limit)
@device_auth_required
def apiv1_sync_file_version_content(file_id, version_id):
    return _versions_content_response(g.api_user.id, file_id, version_id)[1]


@app.route('/apiv1/sync/files/<file_id>/versions/<version_id>/restore', methods=['POST'])
@csrf.exempt
@limiter.limit(upload_rate_limit)
@device_auth_required
def apiv1_sync_file_version_restore(file_id, version_id):
    body, error = _sync_body_or_error()
    if error:
        return error
    error, live = _restore_file_version(g.api_user.id, file_id, version_id, body,
                                        f'SYNC VERSION RESTORE (device {g.device.id})')
    if error:
        return error
    return jsonify(_sync_file_node(live)) if live else _sync_error(404, 'not_found', 'File not found')


@app.route('/apiv1/sync/files/<file_id>/versions/<version_id>', methods=['DELETE'])
@csrf.exempt
@device_auth_required
def apiv1_sync_file_version_delete(file_id, version_id):
    return _delete_file_version(g.api_user.id, file_id, version_id) or ('', 204)


# ─── Website routes (session) ────────────────────────────────────────────────

@app.route('/file/<file_id>/versions', methods=['GET'])
@limiter.limit(file_ops_rate_limit)
@login_required
def file_versions(file_id):
    return _versions_list_response(_session_versions_user(), file_id)


@app.route('/file/<file_id>/versions/<version_id>/content', methods=['GET'])
@limiter.limit(download_rate_limit)
@login_required
def file_version_content(file_id, version_id):
    """E2EE: the raw container (the page decrypts it). Standard: a plaintext download."""
    version, resp = _versions_content_response(_session_versions_user(), file_id, version_id)
    if version is not None and resp.status_code == 200 and not version.is_e2e_encrypted:
        resp.headers['Content-Disposition'] = safe_content_disposition('attachment', version.orig_name)
    return resp


@app.route('/file/<file_id>/versions/<version_id>/restore', methods=['POST'])
@limiter.limit(upload_rate_limit)
@login_required
def file_version_restore(file_id, version_id):
    body = request.get_json(silent=True)
    if body is None and not request.get_data(cache=True):
        body = {}
    if not isinstance(body, dict):
        return _sync_error(400, 'bad_request', 'JSON object body required')
    error, _live = _restore_file_version(_session_versions_user(), file_id, version_id, body,
                                         'WEB VERSION RESTORE')
    return error or jsonify({'success': True})


@app.route('/file/<file_id>/versions/<version_id>/delete', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def file_version_delete(file_id, version_id):
    return _delete_file_version(_session_versions_user(), file_id, version_id) or jsonify({'success': True})


# ─── Retention (cleanup_job, 350_scheduler.py) ───────────────────────────────

def _cleanup_file_versions():
    """Delete versions beyond file_version_retention_count per file, older than
    file_version_retention_days, or whose live file is gone."""
    keep = max(0, get_numeric_setting('file_version_retention_count'))
    days = max(0, get_numeric_setting('file_version_retention_days'))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days) if days else None
    live = db.aliased(File)
    try:
        # ponytail: scans every version row per tick; page by version_of_id if versions reach millions.
        rows = db.session.query(File.id, File.version_of_id, File.upload_time, live.id).outerjoin(
            live, live.id == File.version_of_id
        ).filter(File.version_of_id.isnot(None)).order_by(
            File.version_of_id, File.content_version.desc(), File.upload_time.desc()).all()
        db.session.rollback()
    except Exception as e:
        db.session.rollback()
        print(f'[VERSIONS] Retention scan failed: {e}')
        return 0
    doomed, rank, previous = [], 0, None
    for version_id, live_id, uploaded, live_exists in rows:
        rank = rank + 1 if live_id == previous else 1
        previous = live_id
        if live_exists is None or rank > keep or (cutoff and uploaded and _sync_aware(uploaded) < cutoff):
            doomed.append((version_id, live_id))
    removed = 0
    for version_id, live_id in _take_capped_batch(doomed, 'file versions past retention'):
        rewrite_lock = _acquire_file_rewrite_lock(live_id)
        local_targets = []
        try:
            db.session.rollback()
            version = File.query.filter(File.id == version_id, File.version_of_id == live_id).first()
            if not version:
                continue
            local_targets = storage.stage_payload_deletes(_file_payload_delete_keys(version))
            db.session.delete(version)
            db.session.commit()
            removed += 1
        except Exception as e:
            db.session.rollback()
            local_targets = []
            print(f'[VERSIONS] Could not delete version {version_id}: {e}')
        finally:
            _release_file_rewrite_lock(rewrite_lock)
        storage.purge_staged_locals(local_targets)
    if removed:
        print(f'[VERSIONS] Removed {removed} file version(s) past retention (keep {keep}, {days or "no"} day limit)')
    return removed
