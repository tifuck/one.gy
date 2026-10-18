@app.route('/apiv1/keys', methods=['GET'])
@csrf.exempt
@api_key_required
@api_permission_required('manage_keys')
def apiv1_list_keys():
    """List all API keys for the authenticated user."""
    user = g.api_user
    keys = ApiKey.query.filter_by(user_id=user.id, is_active=True).order_by(ApiKey.created_at.desc()).all()
    return jsonify({
        'keys': [{
            'id': k.id,
            'label': k.label,
            'permissions': k.get_permissions_dict(),
            'allowed_ips': k.get_allowed_ips_list(),
            'created_at': k.created_at.strftime('%Y-%m-%dT%H:%M:%SZ') if k.created_at else None,
            'last_used_at': k.last_used_at.strftime('%Y-%m-%dT%H:%M:%SZ') if k.last_used_at else None
        } for k in keys]
    })

@app.route('/apiv1/keys', methods=['POST'])
@csrf.exempt
@api_key_required
@api_permission_required('manage_keys')
def apiv1_create_key():
    """Create a new API key for the authenticated user."""
    user = g.api_user
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Invalid request'}), 400
    label_value = data.get('label', 'API Key')
    if not isinstance(label_value, str):
        return jsonify({'error': 'Label must be text'}), 400
    label = label_value.strip()
    if not label:
        label = 'API Key'
    if len(label) > 80:
        return jsonify({'error': 'Label too long (max 80 characters)'}), 400

    # Parse permissions (all default to False)
    perms = _parse_permissions_from_data(data)

    # Prevent privilege escalation: a key cannot grant permissions it doesn't hold
    for perm in ApiKey.VALID_PERMISSIONS:
        col = f'perm_{perm}'
        if perms.get(col) is True and not g.api_key.has_permission(perm):
            return jsonify({'error': f'Cannot grant permission "{perm}" — your API key does not hold it'}), 403

    # Parse and validate IP whitelist
    allowed_ips_raw = data.get('allowed_ips')
    allowed_ips_json = None
    if allowed_ips_raw is not None:
        if not isinstance(allowed_ips_raw, list):
            return jsonify({'error': 'allowed_ips must be an array'}), 400
        cleaned_ips, ip_error = _validate_ip_whitelist(allowed_ips_raw)
        if ip_error:
            return jsonify({'error': ip_error}), 400
        if cleaned_ips:
            allowed_ips_json = json.dumps(cleaned_ips)

    raw_key, api_key = _create_user_api_key(user.id, label, allowed_ips_json, perms)
    if api_key is None:
        return jsonify({'error': 'Maximum of 10 active API keys reached'}), 400

    print(f'[API] Created API key "{label}" for user: {user.username}')
    return jsonify({
        'id': api_key.id,
        'key': raw_key,
        'label': label,
        'permissions': api_key.get_permissions_dict(),
        'allowed_ips': api_key.get_allowed_ips_list(),
        'message': 'Store this key securely. It cannot be retrieved again.'
    }), 201

@app.route('/apiv1/keys/<key_id>', methods=['DELETE'])
@csrf.exempt
@api_key_required
@api_permission_required('manage_keys')
def apiv1_revoke_key(key_id):
    """Revoke (deactivate) an API key."""
    user = g.api_user
    api_key = ApiKey.query.filter_by(id=key_id, user_id=user.id, is_active=True).first()
    if not api_key:
        return jsonify({'error': 'API key not found'}), 404

    api_key.is_active = False
    db.session.commit()

    print(f'[API] Revoked API key "{_log_safe(api_key.label)}" for user: {user.username}')
    return jsonify({'success': True})

@app.route('/apiv1/keys/<key_id>', methods=['PATCH'])
@csrf.exempt
@api_key_required
@api_permission_required('manage_keys')
def apiv1_update_key(key_id):
    """Update permissions and/or IP whitelist on an existing API key."""
    user = g.api_user
    api_key = ApiKey.query.filter_by(id=key_id, user_id=user.id, is_active=True).first()
    if not api_key:
        return jsonify({'error': 'API key not found'}), 404

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Invalid request'}), 400

    # Update label if provided
    if 'label' in data:
        label = str(data['label']).strip()
        if not label:
            return jsonify({'error': 'Label cannot be empty'}), 400
        if len(label) > 80:
            return jsonify({'error': 'Label too long (max 80 characters)'}), 400
        api_key.label = label

    # Update permissions if provided
    if 'permissions' in data:
        perms = _parse_permissions_from_data(data)
        # Prevent privilege escalation: caller cannot grant perms they don't hold
        for perm in ApiKey.VALID_PERMISSIONS:
            col = f'perm_{perm}'
            if perms.get(col) is True and not g.api_key.has_permission(perm):
                return jsonify({'error': f'Cannot grant permission "{perm}" — your API key does not hold it'}), 403
        for col, val in perms.items():
            setattr(api_key, col, val)

    # Update IP whitelist if provided
    if 'allowed_ips' in data:
        allowed_ips_raw = data['allowed_ips']
        if allowed_ips_raw is None or (isinstance(allowed_ips_raw, list) and len(allowed_ips_raw) == 0):
            api_key.allowed_ips = None
        else:
            if not isinstance(allowed_ips_raw, list):
                return jsonify({'error': 'allowed_ips must be an array or null'}), 400
            cleaned_ips, ip_error = _validate_ip_whitelist(allowed_ips_raw)
            if ip_error:
                return jsonify({'error': ip_error}), 400
            api_key.allowed_ips = json.dumps(cleaned_ips) if cleaned_ips else None

    db.session.commit()

    print(f'[API] Updated API key "{_log_safe(api_key.label)}" for user: {user.username}')
    return jsonify({
        'id': api_key.id,
        'label': api_key.label,
        'permissions': api_key.get_permissions_dict(),
        'allowed_ips': api_key.get_allowed_ips_list()
    })

@app.route('/apiv1/upload', methods=['POST'])
@csrf.exempt
@limiter.limit(upload_rate_limit)
@api_key_required
@api_permission_required('write')
def apiv1_upload():
    """Upload a file via API key. Non-E2E only (server-side Fernet encryption)."""
    from werkzeug.exceptions import RequestEntityTooLarge
    user = g.api_user
    temp_dir = None
    quota_lock = None
    lifecycle_lock = None
    upload_idempotency_lock = None
    upload_idempotency_database_lock = None
    file_id = str(uuid.uuid4())
    management_token = str(uuid.uuid4())
    encrypted_filename = f'{file_id}.enc'

    try:
        _install_request_body_counter()

        def _api_upload_payload(record):
            return {
                'file_id': record.id,
                'name': record.orig_name,
                'size': record.size,
                'download_url': f'https://{domain}/f/{record.id}/{urllib.parse.quote(record.orig_name)}',
                'management_token': record.management_token,
            }

        # A retry of an upload that already committed must get that file back
        # even when the commit used up the remaining quota. Only a header key can
        # be resolved before the body is parsed against that quota.
        _header_upload_id = (request.headers.get('X-Upload-Id') or '').strip()
        if _header_upload_id:
            _header_key = _header_upload_id if len(_header_upload_id) <= 64 else hashlib.sha256(_header_upload_id.encode('utf-8')).hexdigest()
            _existing_upload = _find_existing_upload_by_key(_header_key, registered_user_id=user.id)
            if _existing_upload:
                print(f'[API] Reused existing upload for idempotency key before body parse: {_header_key}')
                return jsonify(_api_upload_payload(_existing_upload)), 200

        remaining_bytes = max(int(user.storage_limit_gb * 1024 * 1024 * 1024) - user.get_storage_used(), 0)
        if _multipart_body_exceeds(remaining_bytes):
            return jsonify({'error': f'Storage limit exceeded. You have {user.get_storage_remaining_gb():.2f}GB remaining.'}), 413
        # AUDIT FIX S2: bound the multipart parser to the user's remaining quota
        # BEFORE reading request.files, so a chunked upload (no Content-Length)
        # cannot spool up to the global 10 GB cap for a user with little quota.
        _set_request_upload_cap(remaining_bytes)

        if 'file' in request.files:
            files = [request.files['file']]
        elif 'files' in request.files:
            files = request.files.getlist('files')
        else:
            return jsonify({'error': 'No file provided. Use multipart field name "file" or "files".'}), 400

        if not files or not any(f.filename for f in files):
            return jsonify({'error': 'No files selected'}), 400

        client_upload_id = (request.form.get('upload_id') or request.headers.get('X-Upload-Id') or '').strip() or None

        folder_id, _, upload_error = _validate_upload_context(
            user,
            request.form.get('folder_id'),
            False,
            False
        )
        if upload_error is not None:
            return upload_error

        if client_upload_id:
            upload_key = client_upload_id if len(client_upload_id) <= 64 else hashlib.sha256(client_upload_id.encode('utf-8')).hexdigest()
            upload_scope = _build_upload_idempotency_scope(upload_key, registered_user_id=user.id)
            upload_idempotency_lock = _acquire_upload_idempotency_lock(upload_scope)
            upload_idempotency_database_lock = _acquire_upload_idempotency_database_lock(upload_scope)
            existing_upload = _find_existing_upload_by_key(upload_key, registered_user_id=user.id)
            if existing_upload:
                print(f'[API] Reused existing upload for idempotency key: {upload_key}')
                return jsonify(_api_upload_payload(existing_upload)), 200

        # AUDIT FIX S2: stage under UPLOAD_FOLDER (same filesystem as final)
        # storage) instead of the default /tmp, which may be a small/RAM-backed
        # tmpfs -- mirrors the main /upload route's staging location.
        temp_dir = tempfile.mkdtemp(prefix=f'api_upload_{file_id}_', dir=app.config['UPLOAD_FOLDER'])
        total_files = 0
        saved_file_paths = []
        total_size = 0

        for file in files:
            if file and file.filename:
                safe_name = secure_filename(file.filename)
                if not safe_name:
                    safe_name = f'file_{total_files + 1}'
                temp_file_path = os.path.join(temp_dir, f'raw_{total_files}_{safe_name}')
                file.save(temp_file_path)
                size = os.path.getsize(temp_file_path)
                display_name = sanitize_plaintext_name(file.filename) or safe_name
                saved_file_paths.append((temp_file_path, safe_name, display_name))
                total_files += 1
                total_size += size

        if _request_body_was_truncated():
            return jsonify({'error': 'UPLOAD WAS CUT SHORT BEFORE ALL FILES ARRIVED. NOTHING WAS SAVED.'}), 400

        if total_files == 0:
            return jsonify({'error': 'No valid files'}), 400

        # --- Quota critical section 1: check + reserve (advisory) under lock ---
        # The per-user quota flock serializes only the brief quota recheck and
        # commit windows. ZIP creation, Fernet encryption, and storage I/O run
        # OUTSIDE the lock so a large API upload cannot convoy other quota-
        # affecting operations for this user. The authoritative enforcement is
        # the recheck at commit (critical section 2); a concurrent same-user
        # upload that commits between the two windows is visible there and is
        # rejected if it would push the user over quota. Lock ordering
        # (quota -> lifecycle -> folder tree) is preserved: the lifecycle lock
        # taken in critical section 2 is acquired while holding the quota lock.
        quota_lock = _acquire_user_quota_lock(user.id)
        try:
            _refresh_quota_snapshot()
            user = db.session.get(User, user.id)
            if not user.has_storage_available(total_size):
                return jsonify({'error': f'Storage limit exceeded. You have {user.get_storage_remaining_gb():.2f}GB remaining.'}), 413
        finally:
            _release_user_quota_lock(quota_lock)
            quota_lock = None

        # --- I/O OUTSIDE the quota lock: ZIP, Fernet encrypt, publish to storage ---
        temp_encrypted_path = os.path.join(temp_dir, encrypted_filename)

        # Server-side Fernet encryption (API uploads are never E2E)
        temp_zip_path = os.path.join(temp_dir, 'temp.zip')
        if total_files == 1:
            src_path = saved_file_paths[0][0]
            shutil.move(src_path, temp_zip_path)
        else:
            used_arcnames = set()
            with zipfile.ZipFile(temp_zip_path, 'w', zipfile.ZIP_STORED) as zipf:
                for idx, (file_path, safe_name, orig_filename) in enumerate(saved_file_paths):
                    if safe_name:
                        zipf.write(file_path, _unique_zip_entry_name(safe_name, used_arcnames))

        total_zip_size = os.path.getsize(temp_zip_path)
        # Hashes computed inside the encrypt pass (was 3 full reads, now 1)
        api_content_hash, api_payload_checksum = encrypt_file_chunked(temp_zip_path, temp_encrypted_path)
        api_disk_size = os.path.getsize(temp_encrypted_path)
        orig_name = f'files_{total_files}.zip' if total_files > 1 else sanitize_plaintext_name(saved_file_paths[0][2] if saved_file_paths else 'upload.zip')
        if not client_upload_id:
            upload_key = hashlib.sha256(
                f'apiv1:{user.id}:{folder_id if folder_id is not None else "root"}:{orig_name}:{api_content_hash}'.encode('utf-8')
            ).hexdigest()
            upload_scope = _build_upload_idempotency_scope(upload_key, registered_user_id=user.id)
            upload_idempotency_lock = _acquire_upload_idempotency_lock(upload_scope)
            upload_idempotency_database_lock = _acquire_upload_idempotency_database_lock(upload_scope)
            existing_upload = _find_existing_upload_by_key(upload_key, registered_user_id=user.id)
            if existing_upload:
                print(f'[API] Reused existing upload for implicit idempotency key: {upload_key}')
                return jsonify(_api_upload_payload(existing_upload)), 200
        storage.store_file(encrypted_filename, temp_encrypted_path)

        # --- Quota critical section 2: recheck + commit under lock ---
        # Re-acquire the per-user quota flock for the authoritative recheck and
        # metadata commit. If a concurrent same-user upload committed during the
        # I/O window and there is no longer room, release the staged payload and
        # reject. Both quota_lock and lifecycle_lock are released by the outer
        # finally (lifecycle first, then quota) to keep LIFO release order.
        quota_lock = _acquire_user_quota_lock(user.id)
        _refresh_quota_snapshot()
        user = db.session.get(User, user.id)
        if not user.has_storage_available(api_disk_size):
            storage.delete_file(encrypted_filename)
            return jsonify({'error': f'Storage limit exceeded. You have {user.get_storage_remaining_gb():.2f}GB remaining.'}), 413
        lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
        if not _lock_live_folder_for_placement(folder_id, user.id):
            db.session.rollback()
            _release_lifecycle_lock(lifecycle_lock)
            lifecycle_lock = None
            storage.delete_file(encrypted_filename)
            return jsonify({'error': 'Folder not found'}), 404

        file_record = File(
            id=file_id,
            orig_name=orig_name,
            filename=encrypted_filename,
            size=total_zip_size,
            expires_at=None,
            is_public=False,
            management_token=management_token,
            user_id=str(uuid.uuid4()),
            registered_user_id=user.id,
            folder_id=folder_id,
            is_e2e_encrypted=False,
            is_legacy_encrypted=True,
            is_temp_upload=False,
            upload_idempotency_key=upload_key,
            content_hash=api_content_hash,
            payload_checksum=api_payload_checksum,
            disk_size=api_disk_size
        )
        db.session.add(file_record)
        # AUDIT FIX H4: drop any stale tombstone for this key before the row can
        # replicate (belt and braces; Phase B also checks).
        _clear_pending_remote_deletes_for('files', [file_record.filename, file_record.id])
        touch_folder(folder_id)
        try:
            db.session.commit()
        except _IdempotencyIntegrityError as _key_err:
            # AUDIT FIX M9: uq_file_upload_key_registered is the DB-level
            # backstop behind the flock + GET_LOCK idempotency locks. Losing
            # that race is an idempotent retry, not a failure: serve the row
            # the winner committed (or release trashed duplicates and retry
            # once) instead of failing after the payload was stored.
            if not upload_key or 'upload_idempotency_key' not in str(getattr(_key_err, 'orig', _key_err)).lower():
                db.session.rollback()
                storage.delete_file(encrypted_filename)
                raise
            db.session.rollback()
            existing_upload, conflict_action = _resolve_upload_key_unique_conflict(
                upload_key, registered_user_id=user.id)
            if conflict_action == 'retry':
                print(f'[API] Released trashed duplicate idempotency rows for key {upload_key}; retrying insert')
                db.session.add(file_record)
                _clear_pending_remote_deletes_for('files', [file_record.filename, file_record.id])
                touch_folder(folder_id)
                try:
                    db.session.commit()
                except Exception:
                    db.session.rollback()
                    storage.delete_file(encrypted_filename)
                    raise
            elif existing_upload is not None:
                storage.delete_file(encrypted_filename)
                print(f'[API] Reused existing upload for idempotency key (DB unique backstop): {upload_key}')
                return jsonify(_api_upload_payload(existing_upload)), 200
            else:
                storage.delete_file(encrypted_filename)
                raise RuntimeError(
                    f'API UPLOAD CONFLICT: idempotency key {upload_key} is held by a live file row outside '
                    f'this request\'s dedup scope; refusing to create a duplicate')
        except Exception:
            db.session.rollback()
            storage.delete_file(encrypted_filename)
            raise

        if total_files == 1:
            _schedule_thumbnail_bg(file_id, log_prefix='API')

        check_storage()

        print(f'[API] Upload: {orig_name} ({format_bytes_for_filesize(total_zip_size)}) by user: {user.username}')
        return jsonify(_api_upload_payload(file_record)), 201

    except RequestEntityTooLarge:
        # AUDIT FIX S2: the per-request quota/parser cap fired.
        try:
            db.session.rollback()
        except Exception:
            pass
        try:
            storage.delete_file(encrypted_filename)
        except Exception:
            pass
        return jsonify({'error': f'Storage limit exceeded. You have {user.get_storage_remaining_gb():.2f}GB remaining.'}), 413
    except MemoryError:
        try:
            db.session.rollback()
        except Exception:
            pass
        try:
            storage.delete_file(encrypted_filename)
        except Exception:
            pass
        return jsonify({'error': 'Server ran out of memory'}), 413
    except (IOError, OSError) as e:
        # AUDIT FIX M4: only report 507 for genuine out-of-space errors; other
        # I/O errors (permission, vanished source, read error) are not "disk
        # full" and must not be mislabeled as such.
        import errno as _errno
        try:
            db.session.rollback()
        except Exception:
            pass
        try:
            storage.delete_file(encrypted_filename)
        except Exception:
            pass
        if getattr(e, 'errno', None) in (_errno.ENOSPC, getattr(_errno, 'EDQUOT', None)):
            print(f'[API] Upload failed -- disk full / quota: {e}')
            return jsonify({'error': 'Storage error. The disk may be full.'}), 507
        print(f'[API] Upload I/O error: {e}')
        return jsonify({'error': 'Upload could not be stored due to a storage I/O error.'}), 500
    except Exception as e:
        import traceback; traceback.print_exc()
        try:
            db.session.rollback()
        except Exception:
            pass
        try:
            storage.delete_file(encrypted_filename)
        except Exception:
            pass
        return jsonify({'error': 'Upload failed'}), 500
    finally:
        if temp_dir and os.path.exists(temp_dir):
            try:
                shutil.rmtree(temp_dir)
            except Exception as e:
                print(f'[API] Warning: Failed to cleanup temp directory: {e}')
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)
        _release_upload_idempotency_database_lock(upload_idempotency_database_lock)
        _release_upload_idempotency_lock(upload_idempotency_lock)

@app.route('/apiv1/download/<file_id>', methods=['GET'])
@csrf.exempt
@limiter.limit(download_rate_limit)
@api_key_required
@api_permission_required('download')
def apiv1_download(file_id):
    """Download a file owned by the authenticated user. Non-E2E files only."""
    user = g.api_user

    file = File.query.filter_by(id=file_id, registered_user_id=user.id).first()
    if not file:
        return jsonify({'error': 'File not found'}), 404

    if file.is_trashed:
        return jsonify({'error': 'File is in trash'}), 404

    # Check expiration
    expires_at_aware = file.get_expires_at_aware()
    if expires_at_aware and expires_at_aware < datetime.now(timezone.utc):
        return jsonify({'error': 'File has expired'}), 404

    if file.is_e2e_encrypted:
        return jsonify({'error': 'E2E encrypted files cannot be downloaded via API. Use the browser client.'}), 400

    encrypted_path = storage.get_file_path(file.filename)
    if not encrypted_path or not os.path.exists(encrypted_path):
        return jsonify({'error': 'File data not found on disk'}), 404

    success, error = check_download_allowed(file)
    if not success:
        if error == 'limit_reached':
            return jsonify({'error': 'Download limit reached'}), 410
        return jsonify({'error': 'File no longer available'}), 404

    import mimetypes
    mimetype, _ = mimetypes.guess_type(file.orig_name)
    if not mimetype:
        mimetype = 'application/octet-stream'

    if request.method == 'HEAD':
        return _build_streaming_response(
            lambda: iter(()), mimetype, disposition='attachment',
            filename=file.orig_name, content_length=file.size,
            headers={'Cache-Control': 'no-cache, no-store, must-revalidate'})
    orig_size = file.size or 0
    if orig_size > LARGE_FILE_THRESHOLD:
        # Large file: decrypt to temp file, then stream
        tmp_path = None
        _cleanup_tmp = None
        try:
            tmp_path, _cleanup_tmp = _prepare_sync_download(encrypted_path, file)
            if tmp_path is None:
                return 'SERVER BUSY - TOO MANY DOWNLOADS IN PROGRESS. PLEASE TRY AGAIN LATER.', 503

            success, error = check_and_increment_download(file)
            if not success:
                _cleanup_tmp(False)
                if error == 'limit_reached':
                    return jsonify({'error': 'Download limit reached'}), 410
                return jsonify({'error': 'File no longer available'}), 404
            return _build_streaming_response(
                lambda: _iter_file_chunks(tmp_path, chunk_size=64 * 1024),
                mimetype,
                disposition='attachment',
                filename=file.orig_name,
                content_length=file.size,
                headers={'Cache-Control': 'no-cache, no-store, must-revalidate'},
                on_finalize=_finalize_download_with_temp_cleanup(file.id, _cleanup_tmp)
            )
        except Exception as e:
            if _cleanup_tmp:
                _cleanup_tmp(False)
            print(f'[API] Download decryption/integrity failure for {file.id}: {e}')
            return jsonify({'error': 'File failed decryption or an integrity check and cannot be served.'}), 500
    else:
        # AUDIT FIX S3: reject a corrupt/truncated stored payload before emitting
        # the 200 + Content-Length, so the API client gets a proper JSON error
        # instead of a body shorter than the advertised length.
        if not _payload_disk_size_matches(encrypted_path, file.disk_size):
            print(f'[API] Disk-size mismatch for {file.id} -- refusing to stream truncated download')
            return jsonify({'error': 'File failed an integrity check and cannot be served.'}), 500
        # Small file: stream Fernet decryption directly (with integrity check)
        success, error = check_and_increment_download(file)
        if not success:
            if error == 'limit_reached':
                return jsonify({'error': 'Download limit reached'}), 410
            return jsonify({'error': 'File no longer available'}), 404
        return _build_streaming_response(
            lambda: decrypt_file_chunked(
                encrypted_path,
                expected_size=file.size,
                expected_payload_checksum=file.payload_checksum,
                expected_disk_size=file.disk_size,
                file_id=file.id,
            ),
            mimetype,
            disposition='attachment',
            filename=file.orig_name,
            content_length=file.size,
            headers={'Cache-Control': 'no-cache, no-store, must-revalidate'},
            on_finalize=lambda completed: finalize_reserved_download(file.id, completed)
        )

@app.route('/apiv1/files', methods=['GET'])
@app.route('/apiv1/files/<int:folder_id>', methods=['GET'])
@csrf.exempt
@api_key_required
@api_permission_required('read')
def apiv1_list_files(folder_id=None):
    """List files and folders in a directory."""
    user = g.api_user

    if folder_id:
        folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
        if not folder:
            return jsonify({'error': 'Folder not found'}), 404

    # Pagination (opt-in via ?page=&per_page=); defaults cap the response to avoid
    # unbounded payloads for very large folders.
    try:
        page = max(1, int(request.args.get('page', 1)))
    except (TypeError, ValueError):
        page = 1
    try:
        per_page = int(request.args.get('per_page', 100))
    except (TypeError, ValueError):
        per_page = 100
    per_page = max(1, min(per_page, 500))

    now_utc = datetime.now(timezone.utc)

    folders_q = Folder.query.filter_by(user_id=user.id, parent_id=folder_id, is_trashed=False).order_by(Folder.name)
    files_q = File.query.filter(
        File.registered_user_id == user.id,
        File.folder_id == folder_id,
        File.is_temp_upload == False,
        File.is_trashed == False,
        db.or_(File.expires_at == None, File.expires_at >= now_utc)
    ).order_by(File.upload_time.desc())

    total_folders = folders_q.count()
    total_files = files_q.count()
    offset = (page - 1) * per_page
    folders = folders_q.offset(offset).limit(per_page).all()
    active_files = files_q.offset(offset).limit(per_page).all()

    folders_json = []
    for fld in folders:
        fld_entry = {
            'id': fld.id,
            'name': fld.name,
            'created_at': fld.created_at.strftime('%Y-%m-%dT%H:%M:%SZ') if fld.created_at else None,
            'updated_at': (fld.updated_at or fld.created_at).strftime('%Y-%m-%dT%H:%M:%SZ') if (fld.updated_at or fld.created_at) else None,
            'is_e2e': fld.is_e2e is True,
            'is_public': fld.is_public,
            'is_browsable': fld.is_browsable
        }
        if fld.is_e2e is True and fld.encrypted_name:
            fld_entry['encrypted_name'] = fld.encrypted_name
            fld_entry['name_nonce'] = fld.name_nonce
            fld_entry['encrypted_name_key'] = fld.encrypted_name_key
            fld_entry['name_key_nonce'] = fld.name_key_nonce
        folders_json.append(fld_entry)

    files_json = []
    for f in active_files:
        entry = {
            'id': f.id,
            'name': f.orig_name,
            'size': f.size,
            'size_formatted': format_bytes_for_filesize(f.size),
            'uploaded_at': f.get_upload_time_aware().strftime('%Y-%m-%dT%H:%M:%SZ'),
            'is_e2e': f.is_e2e_encrypted,
            'is_public': f.is_public,
            'download_url': f'https://{domain}/f/{f.id}/{urllib.parse.quote(f.orig_name)}',
            'downloads': f.download_count
        }
        if f.is_e2e_encrypted:
            entry.update({
                'encrypted_name': f.encrypted_name,
                'name_nonce': f.name_nonce,
                'encrypted_file_key': f.encrypted_file_key,
                'file_key_nonce': f.file_key_nonce,
                'stored_extension': f.stored_extension,
            })
        files_json.append(entry)

    return jsonify({
        'folder_id': folder_id,
        'folders': folders_json,
        'files': files_json,
        'pagination': {
            'page': page,
            'per_page': per_page,
            'total_folders': total_folders,
            'total_files': total_files,
            'has_more': (offset + per_page) < max(total_folders, total_files)
        }
    })

@app.route('/apiv1/files/<file_id>/properties', methods=['GET'])
@csrf.exempt
@api_key_required
@api_permission_required('read')
def apiv1_file_properties(file_id):
    """Get detailed properties of a file."""
    user = g.api_user

    file = File.query.filter_by(id=file_id, registered_user_id=user.id).first()
    if not file:
        return jsonify({'error': 'File not found'}), 404

    result = {
        'id': file.id,
        'name': file.orig_name,
        'size': file.size,
        'size_formatted': format_bytes_for_filesize(file.size),
        'uploaded_at': file.get_upload_time_aware().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'expires_at': file.get_expires_at_aware().strftime('%Y-%m-%dT%H:%M:%SZ') if file.expires_at else None,
        'downloads': file.download_count,
        'max_downloads': file.max_downloads,
        'is_e2e': file.is_e2e_encrypted,
        'is_public': file.is_public,
        'has_password': file.password_hash is not None,
        'is_trashed': file.is_trashed,
        'folder_id': file.folder_id,
        'download_url': f'https://{domain}/f/{file.id}/{urllib.parse.quote(file.orig_name)}'
    }
    if file.is_e2e_encrypted:
        result.update({
            'encrypted_name': file.encrypted_name,
            'name_nonce': file.name_nonce,
            'encrypted_file_key': file.encrypted_file_key,
            'file_key_nonce': file.file_key_nonce,
            'stored_extension': file.stored_extension,
        })
    return jsonify(result)

@app.route('/apiv1/files/<file_id>', methods=['DELETE'])
@csrf.exempt
@api_key_required
@api_permission_required('delete')
def apiv1_delete_file(file_id):
    """Move a file to trash (soft delete)."""
    user = g.api_user

    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
        if not file:
            return jsonify({'error': 'File not found'}), 404

        file.is_trashed = True
        file.trashed_at = datetime.now(timezone.utc)
        file.original_folder_id = file.folder_id
        file.trashed_via_folder = False
        source_folder_id = file.folder_id
        file.folder_id = None
        file.is_public = False
        file.short_code = None
        touch_folder(source_folder_id)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)

    print(f'[API] Moved to trash: {file.orig_name} by user: {user.username}')
    return jsonify({'success': True})

@app.route('/apiv1/folders', methods=['POST'])
@csrf.exempt
@api_key_required
@api_permission_required('write')
def apiv1_create_folder():
    """Create a new folder."""
    user = g.api_user
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Invalid request'}), 400
    folder_name = sanitize_plaintext_name(data.get('name', ''))
    parent_id = data.get('parent_id')

    if not folder_name:
        return jsonify({'error': 'Folder name required'}), 400
    if len(folder_name) > 255:
        return jsonify({'error': 'Folder name too long (max 255 characters)'}), 400

    try:
        parent_id = int(parent_id) if parent_id else None
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid parent folder'}), 400

    if parent_id is not None:
        parent_folder = Folder.query.filter_by(id=parent_id, user_id=user.id, is_trashed=False).first()
        if not parent_folder:
            return jsonify({'error': 'Parent folder not found'}), 404

    # Check for E2EE folder name fields
    encrypted_name = data.get('encrypted_name')
    name_nonce = data.get('name_nonce')
    encrypted_name_key = data.get('encrypted_name_key')
    name_key_nonce = data.get('name_key_nonce')
    encrypted_fields_present = any((
        encrypted_name, name_nonce, encrypted_name_key, name_key_nonce,
    ))
    is_e2e = bool(encrypted_name and name_nonce and encrypted_name_key and name_key_nonce)
    if encrypted_fields_present:
        if not is_e2e:
            return jsonify({'error': 'Incomplete encrypted folder name'}), 400
        valid, err_msg = validate_encrypted_folder_name_fields(
            encrypted_name, name_nonce, encrypted_name_key, name_key_nonce)
        if not valid:
            return jsonify({'error': err_msg}), 400

    raw_client_token = data.get('client_dedupe_token')
    if raw_client_token is None:
        raw_client_token = data.get('client_folder_token')
    if raw_client_token is None:
        raw_client_token = request.headers.get('Idempotency-Key')
    client_folder_token, token_error = _validate_client_folder_dedupe_token(
        raw_client_token)
    if token_error:
        return jsonify({'error': token_error}), 400

    encrypted_fields = None
    if is_e2e:
        encrypted_fields = {
            'encrypted_name': encrypted_name,
            'name_nonce': name_nonce,
            'encrypted_name_key': encrypted_name_key,
            'name_key_nonce': name_key_nonce,
        }
    try:
        folder, existing, create_error = _create_folder_once(
            user,
            parent_id,
            folder_name,
            is_e2e,
            encrypted_fields,
            client_folder_token,
        )
    except RuntimeError as e:
        print(f'[API] Folder creation lock unavailable for user {user.id}: {e}')
        return jsonify({'error': 'Folder creation is busy. Please try again.'}), 503
    if create_error == 'parent_not_found':
        return jsonify({'error': 'Parent folder not found'}), 404

    resp = {'id': folder.id, 'name': folder.name}
    if folder.encrypted_name:
        resp['encrypted_name'] = folder.encrypted_name
        resp['name_nonce'] = folder.name_nonce
        resp['encrypted_name_key'] = folder.encrypted_name_key
        resp['name_key_nonce'] = folder.name_key_nonce
    if existing:
        resp['existing'] = True
        return jsonify(resp)

    print(f'[API] Created folder: {_log_safe(folder.name)} (e2e={is_e2e}) by user: {user.username}')
    return jsonify(resp), 201

@app.route('/apiv1/folders/<int:folder_id>', methods=['DELETE'])
@csrf.exempt
@api_key_required
@api_permission_required('delete')
def apiv1_delete_folder(folder_id):
    """Move a folder and its contents to trash (soft delete)."""
    user = g.api_user

    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
        if not folder:
            return jsonify({'error': 'Folder not found'}), 404

        folder_name = folder.name
        parent_id_before = folder.parent_id

        trash_folder_recursive(folder_id)
        folder.parent_id = None
        touch_folder(parent_id_before)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)

    print(f'[API] Trashed folder: {_log_safe(folder_name)} and all contents by user: {user.username}')
    return jsonify({'success': True})

@app.route('/apiv1/search', methods=['GET'])
@csrf.exempt
@api_key_required
@api_permission_required('read')
def apiv1_search():
    """Search files and folders by name."""
    user = g.api_user
    query = request.args.get('q', '').strip()

    if not query:
        return jsonify({'files': [], 'folders': []})

    # AUDIT FIX (finding 16): push the expiry filter into SQL BEFORE the
    # LIMIT -- the old Python filter ran after `.limit(50)`, so up to 50
    # expired rows could crowd the result down to nothing.
    now_utc = datetime.now(timezone.utc)
    files = File.query.filter(
        File.registered_user_id == user.id,
        File.is_temp_upload == False,
        File.is_trashed == False,
        db.or_(File.expires_at.is_(None), File.expires_at >= now_utc),
        File.orig_name.ilike(f'%{escape_like_pattern(query[:128])}%', escape='\\')
    ).order_by(File.upload_time.desc()).limit(50).all()

    folders = Folder.query.filter(
        Folder.user_id == user.id,
        Folder.is_trashed == False,
        Folder.name.ilike(f'%{escape_like_pattern(query[:128])}%', escape='\\')
    ).order_by(Folder.name).limit(50).all()

    files_json = [{
        'id': f.id,
        'name': f.orig_name,
        'size': f.size,
        'size_formatted': format_bytes_for_filesize(f.size),
        'folder_id': f.folder_id,
        'uploaded_at': f.get_upload_time_aware().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'is_e2e': f.is_e2e_encrypted,
        'download_url': f'https://{domain}/f/{f.id}/{urllib.parse.quote(f.orig_name)}',
        **({'encrypted_name': f.encrypted_name, 'name_nonce': f.name_nonce} if f.is_e2e_encrypted else {}),
    } for f in files]

    folders_json = []
    for fld in folders:
        fld_entry = {
            'id': fld.id,
            'name': fld.name,
            'parent_id': fld.parent_id
        }
        if fld.is_e2e is True and fld.encrypted_name:
            fld_entry['encrypted_name'] = fld.encrypted_name
            fld_entry['name_nonce'] = fld.name_nonce
            fld_entry['encrypted_name_key'] = fld.encrypted_name_key
            fld_entry['name_key_nonce'] = fld.name_key_nonce
        folders_json.append(fld_entry)

    return jsonify({'files': files_json, 'folders': folders_json})

@app.route('/apiv1/trash', methods=['GET'])
@csrf.exempt
@api_key_required
@api_permission_required('read')
def apiv1_list_trash():
    """List trashed files and folders."""
    user = g.api_user
    now_utc = datetime.now(timezone.utc)

    trashed_folders = Folder.query.filter_by(user_id=user.id, is_trashed=True, parent_id=None).order_by(Folder.trashed_at.desc()).all()
    trashed_files = File.query.filter_by(registered_user_id=user.id, is_trashed=True).order_by(File.trashed_at.desc()).all()

    # Collect all trashed folder IDs (including descendants) in O(depth) queries
    trashed_folder_ids = _collect_descendant_folder_ids(
        [tf.id for tf in trashed_folders], include_roots=True, trashed=True
    )
    standalone_files = [f for f in trashed_files if f.folder_id not in trashed_folder_ids]

    folders_json = []
    for fld in trashed_folders:
        remaining_hours = 0
        if fld.trashed_at:
            trashed_aware = fld.trashed_at if fld.trashed_at.tzinfo else fld.trashed_at.replace(tzinfo=timezone.utc)
            delete_at = trashed_aware + timedelta(hours=get_trash_retention_hours())
            remaining = (delete_at - now_utc).total_seconds()
            remaining_hours = max(0, remaining / 3600)
        fld_entry = {
            'id': fld.id,
            'name': fld.name,
            'remaining_hours': round(remaining_hours, 1),
            'trashed_at': fld.trashed_at.strftime('%Y-%m-%dT%H:%M:%SZ') if fld.trashed_at else None
        }
        if fld.is_e2e is True and fld.encrypted_name:
            fld_entry['encrypted_name'] = fld.encrypted_name
            fld_entry['name_nonce'] = fld.name_nonce
            fld_entry['encrypted_name_key'] = fld.encrypted_name_key
            fld_entry['name_key_nonce'] = fld.name_key_nonce
        folders_json.append(fld_entry)

    files_json = []
    for f in standalone_files:
        remaining_hours = 0
        if f.trashed_at:
            trashed_aware = f.trashed_at if f.trashed_at.tzinfo else f.trashed_at.replace(tzinfo=timezone.utc)
            delete_at = trashed_aware + timedelta(hours=get_trash_retention_hours())
            remaining = (delete_at - now_utc).total_seconds()
            remaining_hours = max(0, remaining / 3600)
        files_json.append({
            'id': f.id,
            'name': f.orig_name,
            'size': f.size,
            'remaining_hours': round(remaining_hours, 1),
            'trashed_at': f.trashed_at.strftime('%Y-%m-%dT%H:%M:%SZ') if f.trashed_at else None,
            **({'encrypted_name': f.encrypted_name, 'name_nonce': f.name_nonce} if f.is_e2e_encrypted else {}),
        })

    return jsonify({'folders': folders_json, 'files': files_json})

@app.route('/apiv1/trash/<file_id>/restore', methods=['POST'])
@csrf.exempt
@api_key_required
@api_permission_required('restore')
def apiv1_restore_file(file_id):
    """Restore a file from trash."""
    user = g.api_user
    quota_lock = _acquire_user_quota_lock(user.id)
    lifecycle_lock = None
    try:
        _refresh_quota_snapshot()
        lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
        db.session.rollback()
        user = db.session.get(User, user.id)
        file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=True).first()
        if not file:
            # AUDIT FIX (finding 16): the trash listing includes trashed
            # FOLDERS, but this restore endpoint only ever matched file rows,
            # so an API client could list a folder and then never restore it
            # (nested subtrees included -- restore_folder_recursive brings the
            # whole subtree back). Fall back to a trashed-folder restore,
            # mirroring /trash/restore-folder/<id>.
            folder_restore_id = None
            try:
                folder_restore_id = int(file_id)
            except (TypeError, ValueError):
                folder_restore_id = None
            folder = None
            if folder_restore_id is not None:
                folder = Folder.query.filter_by(
                    id=folder_restore_id, user_id=user.id, is_trashed=True).first()
            if not folder:
                return jsonify({'error': 'File not found in trash'}), 404
            _, required_bytes = _folder_restore_file_ids_and_size(folder)
            if required_bytes > 0 and not user.has_storage_available(required_bytes):
                return jsonify({'error': f'Storage limit exceeded. You have {user.get_storage_remaining_gb():.2f}GB remaining.'}), 413
            _restore_folder_to_original_parent(folder, user)
            restore_folder_recursive(folder.id)
            touch_folder(folder.parent_id)
            db.session.commit()
            print(f'[API] Restored folder subtree: {_log_safe(folder.name)} (id {folder.id}) by user: {user.username}')
            return jsonify({'success': True, 'restored': 'folder', 'id': folder.id})

        if not user.has_storage_available(_quota_bytes_for_file(file)):
            return jsonify({'error': f'Storage limit exceeded. You have {user.get_storage_remaining_gb():.2f}GB remaining.'}), 413

        if file.original_folder_id:
            original_folder = Folder.query.filter_by(id=file.original_folder_id, user_id=user.id).first()
            if original_folder and not original_folder.is_trashed:
                file.folder_id = file.original_folder_id
                file.original_folder_id = None  # breadcrumb fulfilled
            elif original_folder:
                # AUDIT FIX (finding 11): folder exists but is still trashed --
                # restore to root, KEEP the breadcrumb for the folder restore.
                file.folder_id = None
            else:
                file.folder_id = None
                file.original_folder_id = None  # folder gone; breadcrumb dead
        else:
            file.folder_id = None

        file.is_trashed = False
        file.trashed_at = None
        file.trashed_via_folder = False
        touch_folder(file.folder_id)
        db.session.commit()

        print(f'[API] Restored file: {file.orig_name} by user: {user.username}')
        return jsonify({'success': True})
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)

@app.route('/apiv1/trash/<file_id>', methods=['DELETE'])
@csrf.exempt
@api_key_required
@api_permission_required('delete')
def apiv1_permanent_delete_file(file_id):
    """Permanently delete a file from trash."""
    user = g.api_user

    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=True).first()
        if not file:
            return jsonify({'error': 'File not found in trash'}), 404

        paths_to_delete = _file_payload_delete_keys(file)
        orig_name = file.orig_name
        local_targets = storage.stage_payload_deletes(paths_to_delete)
        db.session.delete(file)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    storage.purge_staged_locals(local_targets)

    print(f'[API] Permanently deleted: {orig_name} by user: {user.username}')
    return jsonify({'success': True})

@app.route('/apiv1/trash/empty', methods=['DELETE'])
@csrf.exempt
@api_key_required
@api_permission_required('delete')
def apiv1_empty_trash():
    """Permanently delete all items in trash."""
    user = g.api_user

    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        trashed_files = File.query.filter_by(registered_user_id=user.id, is_trashed=True).all()
        trashed_folders = Folder.query.filter_by(user_id=user.id, is_trashed=True).all()

        if not trashed_files and not trashed_folders:
            return jsonify({'success': True, 'deleted_files': 0, 'deleted_folders': 0})

        paths_to_delete = []
        file_count = len(trashed_files)
        folder_count = len(trashed_folders)

        for f in trashed_files:
            paths_to_delete.extend(_file_payload_delete_keys(f))
            db.session.delete(f)

        top_level_trashed = [fld for fld in trashed_folders if fld.parent_id is None]
        for fld in top_level_trashed:
            permanently_delete_folder_recursive(fld.id, paths_to_delete)

        remaining_trashed = Folder.query.filter_by(user_id=user.id, is_trashed=True).all()
        for fld in remaining_trashed:
            db.session.delete(fld)

        local_targets = storage.stage_payload_deletes(paths_to_delete)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    storage.purge_staged_locals(local_targets)

    print(f'[API] Emptied trash: {file_count} files, {folder_count} folders by user: {user.username}')
    return jsonify({'success': True, 'deleted_files': file_count, 'deleted_folders': folder_count})

# ─── CLI Tool Routes ──────────────────────────────────────────────────────
# Endpoints for the onegy E2EE CLI tool (auto-update + bootstrap script)

