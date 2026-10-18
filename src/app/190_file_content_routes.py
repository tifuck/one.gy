@app.route('/file/<file_id>/delete', methods=['POST'])
@login_required
def delete_user_file(file_id):
    # Decorator handles authentication
    user = _current_session_user()
    
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
        if not file:
            return jsonify({'error': 'File not found'}), 404

        # Move to trash instead of permanent delete
        file.is_trashed = True
        file.trashed_at = datetime.now(timezone.utc)
        file.original_folder_id = file.folder_id
        # AUDIT FIX D11: trashed on its own -- restoring its old folder must NOT
        # silently drag it back out of the trash.
        file.trashed_via_folder = False
        source_folder_id = file.folder_id
        file.folder_id = None  # Remove from folder view
        # Revoke sharing so trashed files are not accessible via share links
        file.is_public = False
        file.short_code = None
        touch_folder(source_folder_id)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    print(f'[FILE] Moved to trash: {file.orig_name} by user: {user.username}')
    return jsonify({'success': True})

@app.route('/file/<file_id>/rename', methods=['POST'])
@login_required
def rename_file(file_id):
    """Rename a file"""
    user = _current_session_user()
    
    file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
    if not file:
        return jsonify({'error': 'File not found'}), 404
    
    new_name = request.form.get('name')
    if not new_name:
        return jsonify({'error': 'File name required'}), 400
    
    # Sanitize filename: strip whitespace and remove path traversal sequences
    new_name = new_name.strip()
    if not new_name:
        return jsonify({'error': 'File name required'}), 400
    
    # Remove path separators and traversal sequences
    new_name = new_name.replace('/', '_').replace('\\', '_')
    new_name = new_name.replace('..', '_')
    # Remove null bytes
    new_name = new_name.replace('\x00', '')
    # Limit length to prevent excessively long names
    if len(new_name) > 255:
        new_name = new_name[:255]
    if not new_name:
        return jsonify({'error': 'Invalid file name'}), 400
    
    old_name = file.orig_name
    
    # For E2EE files with encrypted filenames: accept updated encrypted name from client
    enc_name = request.form.get('encrypted_name')
    enc_nonce = request.form.get('name_nonce')
    stored_ext = normalize_stored_extension(request.form.get('stored_extension'))
    if file.is_e2e_encrypted:
        if not (enc_name and enc_nonce):
            return jsonify({'error': 'INCOMPLETE ENCRYPTED FILE NAME'}), 400
        _wrap_err = _e2ee_wrap_field_error((
            ('encrypted_name', enc_name, None),
            ('name_nonce', enc_nonce, 12),
        ))
        if _wrap_err:
            return _wrap_err
        file.encrypted_name = enc_name
        file.name_nonce = enc_nonce
        file.stored_extension = stored_ext
        ext_part = stored_ext or ''
        file.orig_name = f'encrypted_{file.id[:8]}{ext_part}'
    else:
        file.orig_name = new_name
    db.session.commit()
    
    # Zero-knowledge: log only placeholder name for E2EE files, never the plaintext name
    log_name = file.orig_name if file.is_e2e_encrypted else new_name
    print(f'[FILE] Renamed file: {old_name} -> {log_name} by user: {user.username}')
    return jsonify({'success': True, 'new_name': file.orig_name if file.is_e2e_encrypted else new_name})

@app.route('/file/<file_id>/preview')
@limiter.limit(download_rate_limit)
def file_preview(file_id):
    """Serve decrypted file content for inline preview (logged-in users and temp upload owners)"""
    file = None

    # Logged-in user: check files owned by this user
    if 'logged_in_user_id' in session:
        user = _current_session_user()
        if user:
            file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()

    # Guest: check temp uploads owned by this guest session
    if not file and 'user_id' in session:
        file = File.query.filter_by(id=file_id, user_id=session['user_id'], registered_user_id=None, is_temp_upload=True).first()

    # Cookie-based: check temp uploads owned by this manager cookie
    if not file:
        manager_cookie = request.cookies.get('onegy_manager')
        if manager_cookie:
            file = File.query.filter_by(id=file_id, manager_cookie_id=manager_cookie, registered_user_id=None, is_temp_upload=True).first()

    if not file:
        abort(404)
    
    # Don't preview E2E encrypted files (can't decrypt server-side)
    if file.is_e2e_encrypted:
        abort(403)
    
    encrypted_path = storage.get_file_path(file.filename)
    if not encrypted_path or not os.path.exists(encrypted_path):
        abort(404)

    # AUDIT FIX (upload/download integrity): download_file_logic,
    # download_encrypted and apiv1_download all run this pre-flight BEFORE
    # constructing the response, precisely so a mismatched payload cannot be
    # served as a short body under an advertised Content-Length. The preview
    # route did not: decrypt_file_chunked() is a generator whose size/checksum
    # checks only fire once the WSGI server pulls the first chunk -- i.e. after
    # the 200 + Content-Length headers were already on the wire -- so a corrupt
    # payload produced a truncated 200 the client could not distinguish from
    # success. Fail with a real error status instead.
    if not _payload_disk_size_matches(encrypted_path, file.disk_size):
        _log_payload_corruption(
            file.id, 'preview-disk-size', file.payload_checksum or '(none)', '(none)',
            expected_size=file.disk_size, actual_size=os.path.getsize(encrypted_path),
            source_path=encrypted_path,
        )
        print(f'[PREVIEW] Refusing to preview {file.id}: on-disk payload size does not match disk_size')
        abort(500)

    import mimetypes
    mimetype, _ = mimetypes.guess_type(file.orig_name)
    if not mimetype:
        mimetype = 'application/octet-stream'

    # MIME types that can execute scripts when served inline on the same origin.
    # Force these to attachment so the browser downloads rather than renders them.
    _inline_dangerous_mimes = {
        'text/html', 'application/xhtml+xml',
        'image/svg+xml',
        'text/xml', 'application/xml',
        'text/javascript', 'application/javascript', 'application/x-javascript',
        'text/css',
    }
    _preview_disposition = 'attachment' if mimetype in _inline_dangerous_mimes else 'inline'

    # Owner previews must not consume download slots intended for shared links.
    # Audio plays are counted via the dedicated /file/<id>/track-play endpoint
    # to avoid double-counting (browsers send both non-Range and Range requests
    # for <audio> elements, and seeking also triggers additional requests).
    audio_mimes_set = {'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac'}
    if not request.headers.get('Range') and mimetype not in audio_mimes_set:
        pass
    
    try:
        # For audio files, support Range requests (needed for seeking in the music player).
        # We must serve from a concrete file path so that Flask/Werkzeug can correctly
        # emit 206 Partial Content with the right byte offsets — send_file(BytesIO, ...)
        # does not support partial-content responses.  We decrypt to a temp file once,
        # serve it, then delete it via call_on_close.
        # A 50 MB size guard prevents unbounded disk use from very large uploads that
        # happen to have an audio MIME type.
        audio_mimes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac']
        if mimetype in audio_mimes and request.headers.get('Range'):
            MAX_AUDIO_PREVIEW_BYTES = 50 * 1024 * 1024  # 50 MB
            if file.size > MAX_AUDIO_PREVIEW_BYTES:
                abort(403)
            import tempfile as _tempfile
            temp_dir = create_work_dir('audio_preview_')
            temp_path = os.path.join(temp_dir, 'preview')
            try:
                with open(temp_path, 'wb') as tf:
                    for chunk in decrypt_file_chunked(
                        encrypted_path,
                        expected_size=file.size,
                        expected_payload_checksum=file.payload_checksum,
                        expected_disk_size=file.disk_size,
                        file_id=file.id,
                    ):
                        tf.write(chunk)
                response = send_file(temp_path, mimetype=mimetype, conditional=True)
                response.direct_passthrough = False
                response.headers['Content-Disposition'] = safe_content_disposition(_preview_disposition, file.orig_name)
                response.headers['Accept-Ranges'] = 'bytes'

                @response.call_on_close
                def cleanup_temp():
                    try:
                        os.remove(temp_path)
                        os.rmdir(temp_dir)
                    except OSError:
                        pass

                return response
            except Exception:
                try:
                    os.remove(temp_path)
                    os.rmdir(temp_dir)
                except OSError:
                    pass
                raise

        # Stream all files using chunked decryption to avoid memory issues.
        # Pass the integrity args (size, checksum, disk_size) so a corrupted/
        # truncated payload is detected instead of silently served as a short
        # body under a stale Content-Length — matching the download path.
        def generate():
            for chunk in decrypt_file_chunked(
                encrypted_path,
                expected_size=file.size,
                expected_payload_checksum=file.payload_checksum,
                expected_disk_size=file.disk_size,
                file_id=file.id,
            ):
                yield chunk
        
        from flask import Response
        response = Response(generate(), mimetype=mimetype, direct_passthrough=True)
        response.headers['Content-Disposition'] = safe_content_disposition(_preview_disposition, file.orig_name)
        response.headers['Content-Length'] = file.size
        # Indicate Range support for audio files
        if mimetype in audio_mimes:
            response.headers['Accept-Ranges'] = 'bytes'
        return response
    except Exception as e:
        from werkzeug.exceptions import HTTPException
        if isinstance(e, HTTPException):
            raise  # intentional abort(403) size limit / Range errors keep their status
        print(f'[PREVIEW] Error previewing file {file.orig_name}: {e}')
        abort(500)

@app.route('/file/<file_id>/track-play', methods=['POST'])
@limiter.limit(download_rate_limit)
def file_track_play(file_id):
    """Increment download count when an audio file is played via the music player.
    
    The /file/<id>/preview endpoint skips counting for Range requests (to avoid
    double-counting from audio seeking).  When the music player sets audio.src to
    that endpoint, the browser always sends a Range header, so the play is never
    counted.  This lightweight POST endpoint fills that gap.
    """
    file = None
    is_registered_owner = False

    # Logged-in user: check files owned by this user
    if 'logged_in_user_id' in session:
        user = _current_session_user()
        if user:
            file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
            if file:
                is_registered_owner = True

    # Guest: check temp uploads owned by this guest session
    if not file and 'user_id' in session:
        file = File.query.filter_by(id=file_id, user_id=session['user_id'], registered_user_id=None, is_temp_upload=True).first()

    # Cookie-based: check temp uploads owned by this manager cookie
    if not file:
        manager_cookie = request.cookies.get('onegy_manager')
        if manager_cookie:
            file = File.query.filter_by(id=file_id, manager_cookie_id=manager_cookie, registered_user_id=None, is_temp_upload=True).first()

    if not file:
        return jsonify({'error': 'NOT FOUND'}), 404

    # AUDIT FIX M5: a registered owner playing their own audio in the music
    # player is NOT a download. [tool-probe] Counting it consumed burn-after-N
    # (max_downloads) slots and could hard-delete the owner's own file via
    # finalize_reserved_download() -> _mark_file_for_download_limit_delete(), and
    # every repeat play inflated download_count. Owner plays skip both the
    # increment and the finalize entirely. Guests / share viewers keep the
    # counting behavior below (their plays are downloads), including the
    # limit-reached 410.
    if is_registered_owner:
        print(f'[PLAY] Owner play not counted as download for: {file.orig_name}')
        return jsonify({'ok': True})

    success, error = check_and_increment_download(file)
    if not success:
        if error == 'limit_reached':
            return jsonify({'error': 'LIMIT REACHED'}), 410
        return jsonify({'error': 'UNAVAILABLE'}), 404
    finalize_reserved_download(file.id, True)

    print(f'[PLAY] Counted play as download for: {file.orig_name}')
    return jsonify({'ok': True})


@app.route('/file/create-blank', methods=['POST'])
@login_required
@limiter.limit(upload_rate_limit)
def file_create_blank():
    """Create a blank file in the user's cloud drive (supports both Fernet and E2EE)."""
    import tempfile as _tempfile
    from werkzeug.exceptions import RequestEntityTooLarge

    user = _current_session_user()
    if not user:
        return jsonify({'error': 'SESSION_EXPIRED'}), 401

    # AUDIT FIX (upload/download integrity): this route set no request cap at
    # all, so the "blank" file's encrypted_blob part was bounded only by the
    # global 10 GB MAX_CONTENT_LENGTH. Bound it to the smaller of a sane blank
    # -file ceiling and the user's remaining quota, BEFORE request.form is read.
    _blank_cap = min(MAX_BLANK_FILE_BYTES,
                     max(int(user.storage_limit_gb * 1024 * 1024 * 1024) - user.get_storage_used(), 0))
    if _multipart_body_exceeds(_blank_cap):
        return jsonify({'error': 'BLANK FILE PAYLOAD TOO LARGE'}), 413
    _set_request_upload_cap(_blank_cap)

    filename = request.form.get('filename', '').strip()
    if not filename:
        return jsonify({'error': 'FILENAME IS REQUIRED'}), 400

    # Sanitize filename
    from werkzeug.utils import secure_filename as _secure_filename
    safe_name = _secure_filename(filename)
    if not safe_name:
        return jsonify({'error': 'INVALID FILENAME'}), 400

    folder_id = request.form.get('folder_id')
    try:
        folder_id = int(folder_id) if folder_id and folder_id != 'null' else None
    except (TypeError, ValueError):
        return jsonify({'error': 'INVALID FOLDER ID'}), 400

    # Validate folder ownership if specified
    if folder_id is not None:
        folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
        if not folder:
            return jsonify({'error': 'FOLDER NOT FOUND'}), 404

    is_e2e = request.form.get('e2e') == 'true'
    file_id = str(uuid.uuid4())
    management_token = str(uuid.uuid4())
    encrypted_filename = f'{file_id}.enc'

    temp_dir = None  # AUDIT FIX S4: track E2EE staging dir for unconditional cleanup
    # AUDIT FIX (upload/download integrity): this route called
    # has_storage_available() three times but never held the per-user quota
    # flock, so its check-then-write raced /upload and save-content (which both
    # do hold it) and could overshoot the limit. Hold the lock across the whole
    # check -> store -> commit window. The request body is already capped and
    # bounded by MAX_BLANK_FILE_BYTES, so holding it here cannot stall a worker
    # the way holding it across a multi-GB transfer would.
    # Lock order note: this route never takes the per-file rewrite lock.
    quota_lock = _acquire_user_quota_lock(user.id)
    lifecycle_lock = None
    _refresh_quota_snapshot()
    try:
        # Storage quota check (blank files are tiny but still check)
        if not user.has_storage_available(1):
            return jsonify({'error': f'STORAGE LIMIT EXCEEDED. YOU HAVE {user.get_storage_remaining_gb():.2f}GB REMAINING.'}), 413

        if is_e2e:
            # E2EE: client sends pre-encrypted blob + key metadata
            encrypted_file_key = request.form.get('encrypted_file_key')
            file_key_nonce = request.form.get('file_key_nonce')
            e2e_encrypted_name = request.form.get('encrypted_name')
            e2e_name_nonce = request.form.get('name_nonce')
            e2e_stored_extension = normalize_stored_extension(request.form.get('stored_extension'))

            if not encrypted_file_key or not file_key_nonce:
                return jsonify({'error': 'E2EE KEY METADATA REQUIRED'}), 400
            if not e2e_encrypted_name or not e2e_name_nonce:
                return jsonify({'error': 'ENCRYPTED FILENAME METADATA REQUIRED'}), 400
            _wrap_err = _e2ee_wrap_field_error((
                ('encrypted_file_key', encrypted_file_key, 48),
                ('file_key_nonce', file_key_nonce, 12),
                ('encrypted_name', e2e_encrypted_name, None),
                ('name_nonce', e2e_name_nonce, 12),
            ))
            if _wrap_err:
                return _wrap_err

            # Save encrypted blob via StorageManager
            blob = request.files.get('encrypted_blob')
            if blob:
                temp_dir = create_work_dir(f'blank_e2e_{file_id}_')
                temp_blob_path = os.path.join(temp_dir, encrypted_filename)
                blob.save(temp_blob_path)
                _container_ok, _container_err = validate_e2ee_container(temp_blob_path)
                if not _container_ok:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    return jsonify({
                        'error': f'UPLOADED DATA IS NOT A VALID ENCRYPTED FILE: {_container_err}'
                    }), 400
                file_size = os.path.getsize(temp_blob_path)
                content_hash = _sha256_file(temp_blob_path)
                payload_checksum = content_hash
                if not user.has_storage_available(file_size):
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    return jsonify({'error': f'STORAGE LIMIT EXCEEDED. YOU HAVE {user.get_storage_remaining_gb():.2f}GB REMAINING.'}), 413
                storage.store_file(encrypted_filename, temp_blob_path)
                try:
                    shutil.rmtree(temp_dir)
                except Exception:
                    pass
            else:
                return jsonify({'error': 'ENCRYPTED BLOB REQUIRED'}), 400

            # Build placeholder orig_name (server never sees real name for E2EE)
            ext_part = e2e_stored_extension or ''
            orig_name = f'encrypted_{file_id[:8]}{ext_part}'

            file_record = File(
                id=file_id,
                orig_name=orig_name,
                filename=encrypted_filename,
                size=file_size,
                expires_at=None,
                is_public=False,
                management_token=management_token,
                user_id=session.get('user_id', ''),
                registered_user_id=user.id,
                folder_id=folder_id,
                is_e2e_encrypted=True,
                encrypted_file_key=encrypted_file_key,
                file_key_nonce=file_key_nonce,
                encrypted_name=e2e_encrypted_name,
                name_nonce=e2e_name_nonce,
                stored_extension=e2e_stored_extension,
                is_legacy_encrypted=False,
                is_temp_upload=False,
                content_hash=content_hash,
                payload_checksum=payload_checksum,
                disk_size=file_size
            )
        else:
            # Fernet: encrypt empty content server-side
            tmp_fd, tmp_path = _tempfile.mkstemp(suffix='.tmp', dir=app.config['UPLOAD_FOLDER'])
            temp_encrypted_path = tmp_path + '.enc'
            try:
                os.close(tmp_fd)
                # Write empty bytes
                with open(tmp_path, 'wb') as f:
                    pass
                _, payload_checksum = encrypt_file_chunked(tmp_path, temp_encrypted_path)
                file_disk_size = os.path.getsize(temp_encrypted_path)
                if not user.has_storage_available(file_disk_size):
                    return jsonify({'error': f'STORAGE LIMIT EXCEEDED. YOU HAVE {user.get_storage_remaining_gb():.2f}GB REMAINING.'}), 413
                storage.store_file(encrypted_filename, temp_encrypted_path)
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                if os.path.exists(temp_encrypted_path):
                    os.remove(temp_encrypted_path)

            orig_name = safe_name

            file_record = File(
                id=file_id,
                orig_name=orig_name,
                filename=encrypted_filename,
                size=0,
                expires_at=None,
                is_public=False,
                management_token=management_token,
                user_id=session.get('user_id', ''),
                registered_user_id=user.id,
                folder_id=folder_id,
                is_e2e_encrypted=False,
                is_legacy_encrypted=True,
                is_temp_upload=False,
                content_hash=hashlib.sha256(b'').hexdigest(),
                payload_checksum=payload_checksum,
                disk_size=file_disk_size
            )

        lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
        if not _lock_live_folder_for_placement(folder_id, user.id):
            db.session.rollback()
            _release_lifecycle_lock(lifecycle_lock)
            lifecycle_lock = None
            storage.delete_file(encrypted_filename)
            return jsonify({'error': 'FOLDER NOT FOUND'}), 404
        db.session.add(file_record)
        # AUDIT FIX H4: drop any stale tombstone for this key before the row can
        # replicate (belt and braces; Phase B also checks).
        _clear_pending_remote_deletes_for('files', [file_record.filename, file_record.id])
        touch_folder(folder_id)
        db.session.commit()

        print(f'[FILE] Created blank file: {file_id} -> {orig_name}, E2E: {is_e2e}, folder: {folder_id}')

        result = {
            'success': True,
            'file_id': file_id,
            'filename': orig_name,
            'management_token': management_token
        }
        if is_e2e and folder_id:
            ancestor_info = get_shared_ancestor_info(folder_id)
            if ancestor_info:
                result['needs_link_key'] = True
                result['ancestor_share_token'] = ancestor_info['share_token']
                result['ancestor_folder_id'] = ancestor_info['folder_id']
        return jsonify(result)

    except RequestEntityTooLarge:
        # AUDIT FIX (upload/download integrity): the per-request cap fired.
        try:
            db.session.rollback()
        except Exception:
            pass
        try:
            storage.delete_file(encrypted_filename)
        except Exception:
            pass
        return jsonify({'error': 'BLANK FILE PAYLOAD TOO LARGE'}), 413
    except Exception as e:
        print(f'[ERROR] Failed to create blank file: {e}')
        db.session.rollback()
        try:
            storage.delete_file(encrypted_filename)
        except Exception:
            pass
        return jsonify({'error': 'FAILED TO CREATE FILE'}), 500
    finally:
        # AUDIT FIX S4: the E2EE branch staged the uploaded blob in temp_dir;
        # clean it up on EVERY exit path (success, early return, or exception)
        # so a failed creation does not leak an orphaned staging directory under
        # uploads/. (The old code only removed temp_dir on the success path.)
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)


@app.route('/file/<file_id>/save-content', methods=['POST'])
@limiter.limit(upload_rate_limit)
def file_save_content(file_id):
    """Save edited text content for a file (logged-in users and temp upload owners)"""
    import tempfile
    from werkzeug.exceptions import RequestEntityTooLarge
    file = None
    quota_lock = None
    # AUDIT FIX M4: lifecycle lock acquired inside the try (canonical order
    # rewrite -> quota -> lifecycle), released in the finally below.
    lifecycle_lock = None

    # Logged-in user: check files owned by this user
    if 'logged_in_user_id' in session:
        user = _current_session_user()
        if user:
            file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()

    # Guest: check temp uploads owned by this guest session
    if not file and 'user_id' in session:
        file = File.query.filter_by(id=file_id, user_id=session['user_id'], registered_user_id=None, is_temp_upload=True).first()

    # Cookie-based: check temp uploads owned by this manager cookie
    if not file:
        manager_cookie = request.cookies.get('onegy_manager')
        if manager_cookie:
            file = File.query.filter_by(id=file_id, manager_cookie_id=manager_cookie, registered_user_id=None, is_temp_upload=True).first()

    if not file:
        return jsonify({'error': 'FILE NOT FOUND'}), 404

    # Check if file is in trash
    # AUDIT FIX M4: test the authoritative is_trashed flag; trashed_at alone
    # is not the trash marker. The race-safe version of this check is the
    # post-lock re-check inside the try below.
    if file.is_trashed:
        return jsonify({'error': 'CANNOT EDIT TRASHED FILES'}), 400

    MAX_EDIT_SIZE = 5 * 1024 * 1024  # 5 MB limit for text editing

    # AUDIT FIX H6/S1: bound the request body BEFORE reading request.files /
    # request.get_data(). The E2EE path previously trusted the client-claimed
    # original_size and the Fernet path trusted request.content_length (which is
    # absent under chunked transfer-encoding), so a client could spool up to the
    # global 10 GB MAX_CONTENT_LENGTH into memory/disk while claiming a tiny
    # size. All save-content clients send the CSRF token via the X-CSRFToken
    # header (not a form field), so the body is untouched until this view reads
    # it -- making this parser cap effective for both the multipart (E2EE) and
    # raw (Fernet) request bodies.
    _set_request_upload_cap(MAX_EDIT_SIZE)

    # Check storage quota for registered users before accepting edited content.
    # This prevents users from growing files beyond their storage limit via repeated edits.
    registered_owner = None
    if file.registered_user_id:
        registered_owner = db.session.get(User, file.registered_user_id)

    # AUDIT FIX M4 (TOCTOU vs concurrent trash/delete): capture the identity
    # keys the post-lock re-check needs -- after the session rollback below,
    # attribute access on a row deleted by a concurrent commit would raise
    # ObjectDeletedError before the route can answer 404/410.
    _m4_file_pk = file.id
    _m4_staged_name = file.filename
    _m4_owner_id = registered_owner.id if registered_owner is not None else None

    # AUDIT FIX (5th audit, concurrent staged rewrites): serialize same-file
    # rewrites so the shared .new/.committed/.meta staging slot is exclusive.
    # AUDIT FIX (upload/download integrity): the per-user quota flock is now
    # acquired AFTER this one. make-public / make-private also take both locks,
    # and taking them in opposite orders would deadlock two requests touching
    # the same file+user. Canonical order across the whole app:
    # rewrite-lock -> quota-lock.
    _rewrite_lock = _acquire_file_rewrite_lock(file.id)
    if registered_owner:
        quota_lock = _acquire_user_quota_lock(registered_owner.id)
        _refresh_quota_snapshot()
    temp_dir = None
    try:
        # AUDIT FIX M4 (TOCTOU vs concurrent trash/delete): the resolution and
        # trashed check above ran BEFORE the rewrite/quota locks, so a
        # lifecycle-lock holder (delete_user_file, permanent_delete_file,
        # empty_trash) could trash or permanently delete the row between that
        # check and the db.session.commit() below -- committing new size/
        # content onto an already-trashed row, or finalizing a staged .new
        # payload for a row that no longer exists (orphaned .enc with no DB
        # row). Canonical nested lock order is rewrite -> quota -> lifecycle
        # (see _acquire_user_lifecycle_lock), so take the lifecycle lock here
        # and re-fetch + re-verify the row before anything is staged.
        if _m4_owner_id is not None:
            lifecycle_lock = _acquire_user_lifecycle_lock(_m4_owner_id)
        else:
            # Guest/temp upload: the item scope _acquire_file_lifecycle_lock
            # uses for files without a registered owner.
            lifecycle_lock = _acquire_scoped_lock(
                f'lifecycle_file_{_m4_file_pk}', prefix='lifecycle')
        db.session.rollback()
        registered_owner = (
            db.session.get(User, _m4_owner_id, populate_existing=True)
            if _m4_owner_id is not None else None)
        file = db.session.get(File, _m4_file_pk, populate_existing=True)
        if file is None:
            # Row permanently deleted since resolution (trash emptied /
            # permanent delete won the race). Drop any stale staged payload
            # from an earlier crashed rewrite of this same slot; this request
            # has staged nothing yet.
            storage.rollback_staged_file(_m4_staged_name)
            return jsonify({'error': 'FILE NOT FOUND'}), 404
        _m4_session_owner_id = None
        if 'logged_in_user_id' in session:
            _m4_user = _current_session_user()
            if _m4_user is not None:
                _m4_session_owner_id = _m4_user.id
        _m4_cookie = request.cookies.get('onegy_manager')
        _m4_still_owned = (
            (_m4_session_owner_id is not None
             and file.registered_user_id == _m4_session_owner_id)
            or ('user_id' in session
                and file.registered_user_id is None
                 and file.is_temp_upload and file.user_id == session['user_id'])
            or (_m4_cookie
                and file.registered_user_id is None
                and file.is_temp_upload and file.manager_cookie_id == _m4_cookie))
        if not _m4_still_owned:
            storage.rollback_staged_file(_m4_staged_name)
            return jsonify({'error': 'FILE NOT FOUND'}), 404
        if file.is_trashed:
            storage.rollback_staged_file(_m4_staged_name)
            return jsonify({'error': 'CANNOT EDIT TRASHED FILES'}), 410

        if file.is_e2e_encrypted:
            # E2E: client sends pre-encrypted blob + key metadata
            if 'file' not in request.files:
                return jsonify({'error': 'NO FILE DATA PROVIDED'}), 400

            uploaded = request.files['file']
            original_size = request.form.get('original_size', type=int)
            encrypted_file_key = request.form.get('encrypted_file_key')
            file_key_nonce = request.form.get('file_key_nonce')
            new_enc_name = request.form.get('encrypted_name')
            new_name_nonce = request.form.get('name_nonce')
            new_link_key = request.form.get('link_encrypted_file_key')
            new_link_nonce = request.form.get('link_file_key_nonce')
            new_folder_link_key = request.form.get('folder_link_encrypted_file_key')
            new_folder_link_nonce = request.form.get('folder_link_file_key_nonce')
            existing_file_link = bool(file.link_encrypted_file_key)
            existing_folder_link = bool(file.folder_link_encrypted_file_key)
            needs_folder_wrap = existing_folder_link
            if not needs_folder_wrap and file.folder_id:
                needs_folder_wrap = bool(get_shared_ancestor_info(file.folder_id))

            if original_size is None or not encrypted_file_key or not file_key_nonce:
                return jsonify({'error': 'MISSING E2E METADATA'}), 400

            if file.encrypted_name and not (new_enc_name and new_name_nonce):
                return jsonify({'error': 'ENCRYPTED FILENAME METADATA REQUIRED'}), 400

            if existing_file_link and not (new_link_key and new_link_nonce):
                return jsonify({'error': 'LINK KEY METADATA REQUIRED'}), 400

            if needs_folder_wrap and not (new_folder_link_key and new_folder_link_nonce):
                return jsonify({'error': 'FOLDER LINK KEY METADATA REQUIRED'}), 400

            _wrap_err = _e2ee_wrap_field_error((
                ('encrypted_file_key', encrypted_file_key, 48),
                ('file_key_nonce', file_key_nonce, 12),
                ('encrypted_name', new_enc_name, None),
                ('name_nonce', new_name_nonce, 12),
                ('file_key_salt', request.form.get('file_key_salt'), 32),
                ('link_encrypted_file_key', new_link_key, 48),
                ('link_file_key_nonce', new_link_nonce, 12),
                ('folder_link_encrypted_file_key', new_folder_link_key, 48),
                ('folder_link_file_key_nonce', new_folder_link_nonce, 12),
            ))
            if _wrap_err:
                return _wrap_err

            if original_size > MAX_EDIT_SIZE:
                return jsonify({'error': 'FILE TOO LARGE TO SAVE (5 MB LIMIT)'}), 413

            temp_dir = create_work_dir(f'edit_e2e_{file_id}_')
            temp_path = os.path.join(temp_dir, f'{file_id}.enc')
            uploaded.save(temp_path)
            _container_ok, _container_err = validate_e2ee_container(temp_path)
            if not _container_ok:
                print(f'[ERROR] save-content REJECTED for {file_id}: {_container_err}')
                return jsonify({
                    'error': f'UPLOADED DATA IS NOT A VALID ENCRYPTED FILE: {_container_err}'
                }), 400

            # Update metadata — store encrypted blob size (not plaintext) for correct
            # Content-Length when streaming via /f/<id>/encrypted (matches initial upload behavior)
            encrypted_size = os.path.getsize(temp_path)
            # AUDIT FIX H6: enforce the limit on the ACTUAL uploaded blob, not the
            # client-claimed original_size (which a malicious client can set to a
            # tiny value while uploading a huge blob). Allow a small margin over
            # MAX_EDIT_SIZE for AES-GCM/chunk framing overhead.
            if encrypted_size > MAX_EDIT_SIZE + (1024 * 1024):
                return jsonify({'error': 'FILE TOO LARGE TO SAVE (5 MB LIMIT)'}), 413
            encrypted_hash = _sha256_file(temp_path)

            # Stage the new file alongside the original (preserves original until DB commit succeeds)
            storage.store_file_staged(file.filename, temp_path)

            # Check quota: reject if the size increase would exceed the user's storage limit
            if registered_owner:
                size_delta = encrypted_size - _quota_bytes_for_file(file)
                if size_delta > 0 and not registered_owner.has_storage_available(size_delta):
                    storage.rollback_staged_file(file.filename)
                    return jsonify({'error': f'Storage limit exceeded. You have {registered_owner.get_storage_remaining_gb():.2f}GB remaining.'}), 413

            file.size = encrypted_size
            file.disk_size = encrypted_size
            file.content_hash = encrypted_hash
            file.payload_checksum = encrypted_hash
            file.encrypted_file_key = encrypted_file_key
            file.file_key_nonce = file_key_nonce

            # Preserve file_key_salt for passphrase-wrapped keys (guest E2E uploads)
            file_key_salt = request.form.get('file_key_salt')
            if file_key_salt:
                file.file_key_salt = file_key_salt

            # Update encrypted filename (new file key requires re-encrypted name)
            if new_enc_name and new_name_nonce:
                file.encrypted_name = new_enc_name
                file.name_nonce = new_name_nonce

            if new_link_key and new_link_nonce:
                file.link_encrypted_file_key = new_link_key
                file.link_file_key_nonce = new_link_nonce
                file.is_link_shared = True

            if new_folder_link_key and new_folder_link_nonce:
                file.folder_link_encrypted_file_key = new_folder_link_key
                file.folder_link_file_key_nonce = new_folder_link_nonce
                file.is_link_shared = True

            # Save updated E2E encrypted thumbnail if provided
            save_enc_thumb = request.files.get('encrypted_thumbnail')
            save_enc_thumb_nonce = request.form.get('thumbnail_nonce')
            has_thumb = False
            # The new thumbnail replaces the canonical one BEFORE the commit; keep
            # the previous bytes so a failed save can put them back to match the
            # rolled-back key/nonce instead of leaving no usable thumbnail.
            thumb_file_id = file.id
            prev_e2e_thumb = None
            if save_enc_thumb and save_enc_thumb_nonce and file.has_thumbnail:
                try:
                    prev_e2e_thumb = load_thumbnail_from_disk(thumb_file_id, is_e2e=True)
                except Exception:
                    prev_e2e_thumb = None

            def _undo_thumbnail_write():
                try:
                    if prev_e2e_thumb:
                        storage._local_backend.put_data_atomic('thumbnails', f'{thumb_file_id}.e2e', prev_e2e_thumb)
                    else:
                        delete_thumbnail_from_disk(thumb_file_id)
                except Exception as _thumb_err:
                    print(f'[FILE] Could not restore previous thumbnail for {thumb_file_id}: {_thumb_err}')

            if save_enc_thumb and save_enc_thumb_nonce:
                try:
                    # AUDIT FIX (upload/download integrity): bounded read so an
                    # oversized part is rejected without being materialised.
                    thumb_bytes, thumb_oversized = read_bounded_upload_part(
                        save_enc_thumb, _MAX_ENCRYPTED_THUMBNAIL_BYTES)
                    if thumb_oversized:
                        print(f'[THUMBNAIL] E2E thumbnail for {file.id} exceeds '
                              f'{_MAX_ENCRYPTED_THUMBNAIL_BYTES} bytes, skipping')
                    elif thumb_bytes and save_thumbnail_to_disk(file.id, thumb_bytes, is_e2e=True):
                        file.encrypted_thumbnail_nonce = save_enc_thumb_nonce
                        has_thumb = True
                except ReplicaSessionRollbackError:
                    # AUDIT FIX H3: replica bookkeeping rolled back the shared
                    # DB session (expunging this request's pending changes).
                    # Abort -- the outer handler fails the request with a 500
                    # before any staged rewrite has been prepared.
                    raise
                except Exception as e:
                    print(f'[FILE] E2E thumbnail update failed (non-critical): {e}')
            if not has_thumb:
                file.encrypted_thumbnail_nonce = None
            file.has_thumbnail = has_thumb

            _prep_err = _prepare_staged_rewrite_commit(file, {
                'file_id': file.id,
                'size': encrypted_size,
                'disk_size': encrypted_size,
                'content_hash': encrypted_hash,
                'payload_checksum': encrypted_hash,
                'encrypted_name': file.encrypted_name,
                'name_nonce': file.name_nonce,
                'encrypted_file_key': encrypted_file_key,
                'file_key_nonce': file_key_nonce,
            })
            if _prep_err:
                if has_thumb:
                    _undo_thumbnail_write()
                return _prep_err

            try:
                db.session.commit()
            except Exception:
                db.session.rollback()
                storage.rollback_staged_file(file.filename)
                # Restore the thumbnail replaced before the failed commit
                if has_thumb:
                    _undo_thumbnail_write()
                raise

            # DB commit succeeded — safe to delete old thumbnail (no new one provided)
            if not has_thumb:
                delete_thumbnail_from_disk(file.id)

            # Write marker so crash recovery knows this was committed,
            # then atomically replace the original file
            storage.mark_staged_file_committed(file.filename)
            storage.finalize_staged_file(file.filename)

            _commit_file_post_finalize_state(file.id, 'E2E SAVE-CONTENT')

            print(f'[FILE] Saved edited E2E content for {file.orig_name} (plain {original_size}, encrypted {encrypted_size} bytes)')
            return jsonify({'success': True, 'new_size': encrypted_size, 'new_size_formatted': format_bytes_for_filesize(encrypted_size), 'has_thumbnail': has_thumb})

        else:
            # Server-side Fernet: client sends plaintext, server re-encrypts
            content_length = request.content_length or 0
            if content_length > MAX_EDIT_SIZE:
                return jsonify({'error': 'FILE TOO LARGE TO SAVE (5 MB LIMIT)'}), 413

            # Read the raw body content
            raw_data = request.get_data()
            if len(raw_data) > MAX_EDIT_SIZE:
                return jsonify({'error': 'FILE TOO LARGE TO SAVE (5 MB LIMIT)'}), 413

            plain_size = len(raw_data)
            print(f'[FILE] save-content: received {plain_size} bytes for {file.orig_name}')

            temp_dir = create_work_dir(f'edit_{file_id}_')
            temp_plain_path = os.path.join(temp_dir, 'plaintext')
            temp_encrypted_path = os.path.join(temp_dir, f'{file_id}.enc')

            with open(temp_plain_path, 'wb') as f:
                f.write(raw_data)

            # Fernet-encrypt the new content (hashes computed in the same pass)
            content_hash, payload_checksum = encrypt_file_chunked(temp_plain_path, temp_encrypted_path)
            encrypted_disk_size = os.path.getsize(temp_encrypted_path)

            # Stage the new file alongside the original (preserves original until DB commit succeeds)
            storage.store_file_staged(file.filename, temp_encrypted_path)

            # Check quota: reject if the size increase would exceed the user's storage limit
            if registered_owner:
                size_delta = encrypted_disk_size - _quota_bytes_for_file(file)
                if size_delta > 0 and not registered_owner.has_storage_available(size_delta):
                    storage.rollback_staged_file(file.filename)
                    return jsonify({'error': f'Storage limit exceeded. You have {registered_owner.get_storage_remaining_gb():.2f}GB remaining.'}), 413

            # Update file size
            file.size = plain_size
            file.disk_size = encrypted_disk_size
            file.content_hash = content_hash
            file.payload_checksum = payload_checksum

            # Mark thumbnail as cleared (disk deletion deferred to after commit)
            file.has_thumbnail = False
            _prep_err = _prepare_staged_rewrite_commit(file, {
                'file_id': file.id,
                'size': plain_size,
                'disk_size': encrypted_disk_size,
                'content_hash': content_hash,
                'payload_checksum': payload_checksum,
            })
            if _prep_err:
                return _prep_err
            try:
                db.session.commit()
            except Exception:
                db.session.rollback()
                storage.rollback_staged_file(file.filename)
                raise

            # DB commit succeeded — safe to delete old thumbnail from disk
            delete_thumbnail_from_disk(file.id)

            # Write marker so crash recovery knows this was committed,
            # then atomically replace the original file
            storage.mark_staged_file_committed(file.filename)
            storage.finalize_staged_file(file.filename)

            _commit_file_post_finalize_state(file.id, 'FERNET SAVE-CONTENT')

            # Regenerate thumbnail in the bounded background queue.
            _schedule_thumbnail_bg(file_id, log_prefix='FILE')

            print(f'[FILE] Saved edited content for {file.orig_name} ({plain_size} bytes)')
            return jsonify({'success': True, 'new_size': plain_size, 'new_size_formatted': format_bytes_for_filesize(plain_size), 'has_thumbnail': False})

    except RequestEntityTooLarge:
        # AUDIT FIX H6/S1: the parser cap fired -- return a clean 413 with the
        # edit-specific message instead of letting it fall through to a 500.
        return jsonify({'error': 'FILE TOO LARGE TO SAVE (5 MB LIMIT)'}), 413
    except Exception as e:
        print(f'[ERROR] save-content failed for {file_id}: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({'error': 'SAVE FAILED'}), 500
    finally:
        # AUDIT FIX M4: release every lock on every exit path, in reverse
        # acquisition order (rewrite -> quota -> lifecycle).
        _release_lifecycle_lock(lifecycle_lock)
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)
        _release_user_quota_lock(quota_lock)
        _release_file_rewrite_lock(_rewrite_lock)

