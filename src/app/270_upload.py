@app.route('/upload/progress/<file_id>')
@csrf.exempt
@limiter.limit("300 per minute")
def upload_progress(file_id):
    """Poll endpoint for server-side processing progress during upload"""
    progress = get_upload_progress(file_id)
    if progress is None:
        return jsonify({'error': 'NOT FOUND'}), 404
    return jsonify(progress), 200


def _cleanup_failed_upload_artifacts(encrypted_filename, file_id, payload_written, thumbnail_written):
    """Remove payload/thumbnail artifacts left behind by a failed upload.

    AUDIT FIX D15: the three upload failure handlers used to run these deletes
    inside bare `try/except Exception: pass` blocks guarded by `'name' in dir()`
    string probes. Any error -- including a NameError from an unbound local --
    was swallowed, so the written payload silently stayed on disk (and on every
    replica) with nothing in the log to say so. Failures are now logged with
    [ERROR] and each artifact is gated on an explicit sentinel."""
    if payload_written and encrypted_filename:
        try:
            storage.delete_file(encrypted_filename)
        except Exception as e:
            print(f'[ERROR] Upload cleanup failed to remove payload {encrypted_filename}: {e}')
    if thumbnail_written and file_id:
        try:
            delete_thumbnail_from_disk(file_id)
        except Exception as e:
            print(f'[ERROR] Upload cleanup failed to remove thumbnail for {file_id}: {e}')

@app.route('/upload', methods=['POST'])
@csrf.exempt
@limiter.limit(upload_rate_limit)
def upload():
    from werkzeug.exceptions import RequestEntityTooLarge
    upload_start_time = time.time()
    temp_dir = None
    quota_lock = None
    lifecycle_lock = None
    guest_temp_cap_lock = None
    guest_temp_reserved = None  # AUDIT FIX H4: cross-process in-flight reservation token
    upload_idempotency_lock = None
    upload_idempotency_database_lock = None
    registered_user = None
    # Use client-provided file_id for progress tracking only
    # Always generate our own file_id for DB storage to prevent PK collisions
    progress_id = None
    upload_idempotency_key = None
    file_id = str(uuid.uuid4())
    management_token = str(uuid.uuid4())
    
    encrypted_filename = f'{file_id}.enc'
    # AUDIT FIX D15: explicit sentinels for the failure handlers below. They used
    # to probe local names by STRING (`'is_e2e' in dir()`), which is fragile and
    # silently skipped cleanup; worse, the handlers swallowed every exception
    # with a bare `except: pass`, so a NameError (e.g. encrypted_filename unbound)
    # meant the written payload was never cleaned up and nothing was logged.
    is_e2e = False
    payload_written = False
    thumbnail_written = False
    
    try:
        # AUDIT FIX (upload/download integrity): install the body-byte counter as
        # the innermost wsgi.input wrapper BEFORE the cap and before anything
        # parses the multipart body, so a client that disconnects mid-multipart
        # can be detected instead of silently committing a partial batch.
        _install_request_body_counter()

        # AUDIT FIX: /upload is @csrf.exempt for curl/Go-CLI flows, which also
        # let an ANONYMOUS cross-site browser POST arrive, get processed, and
        # SET fresh session / onegy_manager cookies on the response — clobbering
        # the victim's guest-ownership cookies and enabling CSRF-style abuse of
        # an exempt mutation endpoint. Browser requests must be same-origin;
        # non-browser clients send neither Origin nor Sec-Fetch-Site and stay
        # exempt, so the Go CLI and curl are unaffected. Runs BEFORE any session
        # mutation so a blocked request can never write cookies.
        if _browser_cross_site_post_blocked():
            print('[UPLOAD] Blocked cross-site browser POST to /upload (origin check)')
            return jsonify({'error': 'Cross-site request blocked'}), 403

        # Reject clearly over-limit requests before Werkzeug parses multipart bodies to temp disk.
        if not get_setting('allow_temp_uploads') and 'logged_in_user_id' not in session:
            return jsonify({'error': 'Login required to upload files'}), 401

        if 'logged_in_user_id' in session:
            registered_user = _current_session_user()
            if not registered_user:
                return jsonify({'error': 'User not found'}), 404
            # AUDIT FIX (upload/download integrity): the per-user quota flock is
            # NO LONGER taken here. _acquire_user_quota_lock() is a BLOCKING
            # fcntl.flock(LOCK_EX) with no timeout, and taking it before the
            # multipart body is parsed held it across the entire transfer +
            # encryption -- budgeted at up to the 2h gunicorn timeout. flock is
            # per open-file-description, so threads in one worker block each
            # other: 9 concurrent uploads from one user pinned all 8 gthreads and
            # the worker stopped serving everyone. This is the same DoS the C1
            # comment below already fixed for the GUEST path. The check below is
            # advisory; the authoritative check-and-commit runs under the lock in
            # the short finalize window further down.
            # A retry of an upload that already committed must get that upload
            # back even when the commit used up the remaining quota. Only a
            # header key can be resolved before the body is parsed against it.
            _header_upload_id = (request.headers.get('X-Upload-Id') or '').strip()
            if _header_upload_id:
                _existing_upload = _find_existing_upload_by_key(
                    _header_upload_id, registered_user_id=registered_user.id)
                if _existing_upload:
                    print(f'[UPLOAD] Reused existing upload for idempotency key before body parse: {_header_upload_id}')
                    return _upload_idempotent_reuse_response(_existing_upload)
            remaining_bytes = max(int(registered_user.storage_limit_gb * 1024 * 1024 * 1024) - registered_user.get_storage_used(), 0)
            if _multipart_body_exceeds(remaining_bytes):
                return jsonify({'error': f'Storage limit exceeded. You have {registered_user.get_storage_remaining_gb():.2f}GB remaining.'}), 413
            _set_request_upload_cap(remaining_bytes)
        else:
            temp_limit_gb = get_float_setting('temp_max_gb')
            temp_limit_bytes = int(temp_limit_gb * 1024 * 1024 * 1024)
            if _multipart_body_exceeds(temp_limit_bytes):
                return jsonify({'error': f'File too large. Maximum temp upload size is {temp_limit_gb:.1f}GB.'}), 413
            # AUDIT FIX C1: advisory early-reject on the global guest cap WITHOUT
            # holding a lock across the (slow) body read + encryption. Previously
            # a single global blocking flock was taken here and held until the
            # finally block, serializing ALL guest uploads system-wide — a slow
            # uploader could stall every request thread (trivial unauthenticated
            # DoS). The authoritative, race-free reservation still happens at
            # finalize time under a briefly-held flock (see below).
            # AUDIT FIX P2-11: global guest storage cap to prevent disk
            # exhaustion via many concurrent guest uploads. Sums disk_size of
            # all non-trashed temp uploads that haven't expired yet.
            # AUDIT FIX H4: additionally take an in-flight, non-blocking
            # reservation (committed + in-flight + this request <= cap) so N
            # concurrent guest uploads can't each pass a committed-only pre-check
            # and then all stream full bodies to disk (a transient K x temp_max_gb
            # spike). The reservation lock is held only for an O(1) counter
            # update — the slow body read runs WITHOUT it, preserving the C1 fix.
            # NOTE: temp_total_max_gb defaults to 0 (disabled) = no aggregate guest
            # cap; operators handling untrusted anonymous uploads should set it.
            _stream_cap_bytes = temp_limit_bytes
            try:
                _temp_total_gb = get_float_setting('temp_total_max_gb')
                if _temp_total_gb > 0:
                    _temp_total_bytes = int(_temp_total_gb * 1024 * 1024 * 1024)
                    # Reserve the client-declared size, or the per-file cap when no
                    # Content-Length is provided (e.g. chunked bodies).
                    _reserve = int(request.content_length or temp_limit_bytes)
                    # AUDIT FIX (upload/download integrity): the reservation is
                    # now a cross-process ledger entry identified by a token, so
                    # extra Gunicorn workers share one budget.
                    guest_temp_reserved = _reserve_guest_temp_inflight(_reserve, _temp_total_bytes)
                    if not guest_temp_reserved:
                        return jsonify({'error': 'Temp upload storage is full. Please try again later.'}), 507
                    # Bound this request's actual on-disk write to whatever budget
                    # is left, so even a client that ignores its own Content-Length
                    # can't push committed+in-flight past the cap.
                    _remaining = _guest_temp_remaining_bytes(_temp_total_bytes) + _reserve
                    _stream_cap_bytes = max(min(temp_limit_bytes, _remaining), 0)
            except Exception as _guest_err:
                print(f'[UPLOAD] Guest storage cap check failed (non-fatal): {_guest_err}')
            _set_request_upload_cap(_stream_cap_bytes)

        # AUDIT FIX M4: /upload is @csrf.exempt to support anonymous curl/CLI
        # temp uploads, but a session-authenticated upload mutates the user's
        # cloud drive + consumes their quota and therefore MUST be CSRF-protected.
        # Enforce CSRF only when a session cookie is presenting authentication
        # (anonymous/token/CLI uploads stay exempt). The per-request size cap is
        # already set above, so the form parse triggered here still honors it.
        # The first-party SPA already appends csrf_token to the upload FormData.
        if 'logged_in_user_id' in session:
            from flask_wtf.csrf import validate_csrf as _validate_csrf
            _csrf_token = (request.form.get('csrf_token')
                           or request.headers.get('X-CSRFToken')
                           or request.headers.get('X-CSRF-Token'))
            try:
                _validate_csrf(_csrf_token)
            except Exception:
                print('[UPLOAD] CSRF validation failed for session-authenticated upload')
                return jsonify({'error': 'CSRF validation failed. Please refresh and try again.'}), 400

        progress_id = request.form.get('file_id') or str(uuid.uuid4())
        upload_idempotency_key = (request.form.get('upload_id') or progress_id or '').strip() or None

        # Handle both 'files' (multiple) and 'file' (single, e.g., E2E encrypted blob)
        if 'files' in request.files:
            files = request.files.getlist('files')
        elif 'file' in request.files:
            files = [request.files['file']]
        else:
            return jsonify({'error': 'No files'}), 400
        
        if not files or not any(f.filename for f in files):
            return jsonify({'error': 'No files selected'}), 400

        is_e2e = request.form.get('e2e') == 'true'
        payload_written = True  # from here on a payload may exist under encrypted_filename
        e2e_salt = request.form.get('e2e_salt') if is_e2e else None
        e2e_iv = request.form.get('e2e_iv') if is_e2e else None
        # Normalize salt/IV to comma-separated decimal format for consistent storage
        # Accept both base64-encoded and comma-separated byte values
        if e2e_salt and ',' not in e2e_salt:
            try:
                decoded = base64.b64decode(e2e_salt)
                e2e_salt = ','.join(str(b) for b in decoded)
            except Exception:
                pass
        if e2e_iv and ',' not in e2e_iv:
            try:
                decoded = base64.b64decode(e2e_iv)
                e2e_iv = ','.join(str(b) for b in decoded)
            except Exception:
                pass
        
        # MEGA-style E2EE: per-file wrapped key metadata (new system)
        # These are base64 strings — the server stores them opaquely (never decrypted server-side)
        # AUDIT FIX (finding 17): only read the modern E2EE metadata when the
        # upload actually declares e2e=true. A non-E2EE upload used to accept
        # junk encrypted_file_key / encrypted_name fields and persist them on a
        # plaintext row, which then surfaced as bogus key material in key-info
        # and manage responses (and skewed is_legacy/converted-state detection).
        encrypted_file_key = request.form.get('encrypted_file_key') if is_e2e else None
        file_key_nonce = request.form.get('file_key_nonce') if is_e2e else None
        file_key_salt = request.form.get('file_key_salt') if is_e2e else None  # Only for guest passphrase-wrapped keys
        # E2EE encrypted filename (zero-knowledge: server never sees real filename)
        e2e_encrypted_name = request.form.get('encrypted_name') if is_e2e else None
        e2e_name_nonce = request.form.get('name_nonce') if is_e2e else None
        e2e_stored_extension = normalize_stored_extension(request.form.get('stored_extension')) if is_e2e else None  # Unencrypted extension for MIME detection

        modern_e2e_present = any((
            encrypted_file_key, file_key_nonce, file_key_salt,
            e2e_encrypted_name, e2e_name_nonce,
        ))
        modern_e2e_complete = all((
            encrypted_file_key, file_key_nonce,
            e2e_encrypted_name, e2e_name_nonce,
        ))
        legacy_e2e_present = bool(e2e_salt or e2e_iv)
        legacy_e2e_complete = bool(e2e_salt and e2e_iv)
        if is_e2e:
            if modern_e2e_present and not modern_e2e_complete:
                return jsonify({'error': 'INCOMPLETE E2EE KEY OR FILENAME METADATA'}), 400
            if legacy_e2e_present and not legacy_e2e_complete:
                return jsonify({'error': 'INCOMPLETE LEGACY E2EE METADATA'}), 400
            if not modern_e2e_complete and not legacy_e2e_complete:
                return jsonify({'error': 'E2EE KEY METADATA REQUIRED'}), 400
            if modern_e2e_complete:
                _wrap_err = _e2ee_wrap_field_error((
                    ('encrypted_file_key', encrypted_file_key, 48),
                    ('file_key_nonce', file_key_nonce, 12),
                    ('encrypted_name', e2e_encrypted_name, None),
                    ('name_nonce', e2e_name_nonce, 12),
                    ('file_key_salt', file_key_salt, 32),
                ))
                if _wrap_err:
                    return _wrap_err
            if legacy_e2e_complete:
                try:
                    salt_bytes = bytes(int(value) for value in e2e_salt.split(','))
                    iv_bytes = bytes(int(value) for value in e2e_iv.split(','))
                except (TypeError, ValueError):
                    return jsonify({'error': 'INVALID LEGACY E2EE METADATA'}), 400
                if len(salt_bytes) != 16 or len(iv_bytes) != 12:
                    return jsonify({'error': 'INVALID LEGACY E2EE METADATA'}), 400

        # Handle both guest and registered users
        registered_user_id = None
        if registered_user:
            # AUDIT FIX H4: take the id from the epoch-validated User object, not
            # straight from the cookie.
            registered_user_id = registered_user.id

        # AUDIT FIX (upload/download integrity): `is_temp` used to default to
        # 'true' for EVERYONE. _validate_upload_context() only rejects
        # temp+folder, so a REGISTERED user uploading to their drive ROOT
        # without the flag got is_public=True and a 24h expiry, after which
        # cleanup_expired_files() permanently deleted the file. Only
        # static/files.js sends is_temp=false, so any script,
        # integration or hand-rolled curl silently lost data. An authenticated
        # request with no explicit flag now defaults to a NON-expiring, private
        # drive upload; genuinely anonymous/guest requests keep the old
        # temp-upload default (they have no drive to upload to).
        _raw_is_temp = request.form.get('is_temp')
        if _raw_is_temp is None:
            requested_is_temp = registered_user is None
            if not requested_is_temp:
                print('[UPLOAD] No is_temp flag from an authenticated client; defaulting to a '
                      'permanent cloud-drive upload instead of a 24h temp upload')
        else:
            requested_is_temp = str(_raw_is_temp).strip().lower() == 'true'
        folder_id, is_temp, upload_error = _validate_upload_context(
            registered_user,
            request.form.get('folder_id'),
            requested_is_temp,
            is_e2e
        )
        if upload_error is not None:
            return upload_error
        
        g._progress_owner_token = _progress_owner_token()
        if 'user_id' not in session:
            # AUDIT FIX H5: session['user_id'] is a guest's OWNERSHIP KEY for
            # temp uploads -- /manage/<token>, /manage POST and /delete/<token>
            # all grant access when it equals file.user_id. It must therefore
            # never come from the request: any client able to write it could
            # adopt a victim's UUID (a bearer identifier) and then list, manage
            # or delete the victim's guest files, or replay the victim's
            # upload_id through the idempotent-reuse path to receive the
            # victim's management_token. The old client-supplied fallback served
            # no legitimate flow: no static/ JS or template sends a user_id
            # form field, and the Go CLI sends its 64-hex-char uploadID, which
            # uuid.UUID() always rejected. Idempotent continuity across
            # reloads/retries comes from server-set state: the signed session
            # cookie (user_id survives session.clear() on login/logout) and the
            # onegy_manager cookie. Always mint a fresh server-side id here.
            session['user_id'] = str(uuid.uuid4())

        user_id = session['user_id']

        # Cookie-based manager identity for temp uploads (persists across sessions/tabs)
        manager_cookie = request.cookies.get('onegy_manager')
        manager_cookie_from_request = manager_cookie
        if not manager_cookie:
            manager_cookie = secrets.token_hex(32)

        upload_scope = _build_upload_idempotency_scope(
            upload_idempotency_key,
            registered_user_id=registered_user_id,
            user_id=user_id,
            manager_cookie=manager_cookie_from_request if is_temp else None,
        )
        # NOTE (audit re-confirm): the multipart body is FULLY parsed above —
        # the first request.form / request.files access triggers Werkzeug's
        # parse — BEFORE any flock is taken below, so no lock here is ever held
        # across the slow body read; the locks cover only the save/encrypt/
        # finalize section, and every wait on them is bounded (fail closed with
        # 503) so a stalled holder cannot pin worker threads indefinitely.
        upload_idempotency_lock = _acquire_upload_idempotency_lock(
            upload_scope, timeout=_UPLOAD_IDEMPOTENCY_WAIT_SECONDS)
        if upload_scope and upload_idempotency_lock is None:
            print(f'[UPLOAD] Timed out after {_UPLOAD_IDEMPOTENCY_WAIT_SECONDS}s waiting for '
                  'the upload idempotency lock; failing closed with 503')
            _resp = jsonify({'error': 'UPLOAD BUSY. PLEASE RETRY SHORTLY.'})
            _resp.headers['Retry-After'] = '30'
            return _resp, 503
        try:
            upload_idempotency_database_lock = _acquire_upload_idempotency_database_lock(upload_scope)
        except RuntimeError as _db_lock_err:
            print(f'[UPLOAD] Upload idempotency database lock not acquired ({_db_lock_err}); '
                  'failing closed with 503')
            _resp = jsonify({'error': 'UPLOAD BUSY. PLEASE RETRY SHORTLY.'})
            _resp.headers['Retry-After'] = '30'
            return _resp, 503
        registered_user = _refresh_upload_idempotency_snapshot(registered_user_id)
        if registered_user_id is not None and registered_user is None:
            return jsonify({'error': 'User not found'}), 404
        # Rollback above invalidates ORM instances read while parsing and validating
        # the request. Re-run target validation against the new post-lock snapshot.
        folder_id, is_temp, upload_error = _validate_upload_context(
            registered_user,
            request.form.get('folder_id'),
            requested_is_temp,
            is_e2e,
        )
        if upload_error is not None:
            return upload_error
        existing_upload = _find_existing_upload_by_key(
            upload_idempotency_key,
            registered_user_id=registered_user_id,
            user_id=user_id,
            manager_cookie=manager_cookie if is_temp else None,
        )
        if existing_upload:
            if existing_upload.folder_id != folder_id or bool(existing_upload.is_temp_upload) != bool(is_temp) or bool(existing_upload.is_e2e_encrypted) != bool(is_e2e):
                return jsonify({'error': 'UPLOAD RETRY CONFLICT. START A NEW UPLOAD.'}), 409
            print(f'[UPLOAD] Reused existing upload for idempotency key: {upload_idempotency_key}')
            return _upload_idempotent_reuse_response(existing_upload, manager_cookie)

        total_files = 0
        individual_file_sizes = []
        total_size = 0
        
        # Create temp directory for this upload INSIDE the upload folder so that
        # the final move (shutil.move → os.rename) is always a same-filesystem
        # atomic rename. Cross-filesystem moves fall back to copy+delete which
        # is non-atomic and can leave partial files on crash. AUDIT FIX P0-2/P3-3.
        temp_dir = tempfile.mkdtemp(prefix=f'upload_{file_id}_', dir=app.config['UPLOAD_FOLDER'])
        
        # Save files to disk first, then get sizes from disk
        # This avoids buffering entire files in memory for size checks
        # Uses Werkzeug's file.save() which efficiently handles the already-spooled
        # temp files without redundant read-write cycles
        saved_file_paths = []
        
        for file in files:
            if file and file.filename:
                # AUDIT FIX (upload/download integrity): a name that
                # secure_filename() reduces to '' used to hit `continue`, which
                # DROPPED the file from the batch without incrementing
                # total_files -- and the response was still 200, so the user was
                # told an upload succeeded for a file that was never stored.
                # Never silently drop a member: fall back to a generated name.
                safe_name = secure_filename(file.filename)
                if not safe_name:
                    safe_name = f'file_{total_files + 1}'
                    print(f'[UPLOAD] Filename sanitized away to empty; using generated name {safe_name}')
                temp_file_path = os.path.join(temp_dir, f'raw_{total_files}_{safe_name}')
                # Use Werkzeug's save() which efficiently moves/copies the already-spooled
                # temp file to our target path, avoiding a redundant full read-write cycle
                file.save(temp_file_path)
                
                size = os.path.getsize(temp_file_path)
                individual_file_sizes.append((safe_name, size))
                saved_file_paths.append((temp_file_path, safe_name, file.filename))
                total_files += 1
                total_size += size
                # Zero-knowledge: log generic name for E2EE uploads, never the plaintext filename
                log_filename = 'encrypted.bin' if is_e2e else file.filename
                print(f'[UPLOAD] File: {log_filename}, Size: {size} bytes (saved to disk)')

        # AUDIT FIX (upload/download integrity): Werkzeug stops parsing when the
        # stream ends and only appends a FileStorage once its CLOSING boundary
        # has arrived, and it parses with silent=True -- so a multi-file upload
        # truncated at part N had parts 1..N-1 zipped, committed and ACKed with
        # HTTP 200 while the rest were silently absent. Verify the client
        # actually delivered the body length it declared before we commit
        # anything. Runs after the parse (so the parser has consumed the body)
        # and before any storage/DB mutation.
        if _request_body_was_truncated():
            clear_upload_progress(progress_id)
            print('[ERROR] Upload REJECTED: client disconnected mid-multipart; '
                  'refusing to commit a partial batch')
            return jsonify({
                'error': 'UPLOAD WAS CUT SHORT BEFORE ALL FILES ARRIVED. NOTHING WAS SAVED — PLEASE RETRY.'
            }), 400

        if total_files == 0:
            return jsonify({'error': 'No valid files'}), 400
        if is_e2e and total_files != 1:
            return jsonify({'error': 'E2EE UPLOADS REQUIRE EXACTLY ONE ENCRYPTED FILE PART'}), 400
        
        save_elapsed = time.time() - upload_start_time
        print(f'[UPLOAD] Files saved to disk in {save_elapsed:.1f}s')
        set_upload_progress(progress_id, 'saving', 100)
        
        # Check temp upload size limit for guest/temp uploads (configurable via admin)
        if not registered_user:
            temp_limit_gb = get_float_setting('temp_max_gb')
            temp_limit_bytes = int(temp_limit_gb * 1024 * 1024 * 1024)
            if total_size > temp_limit_bytes:
                clear_upload_progress(progress_id)
                print(f'[UPLOAD] Temp upload rejected: {total_size} bytes exceeds temp limit of {temp_limit_gb}GB')
                return jsonify({
                    'error': f'File too large. Maximum temp upload size is {temp_limit_gb:.1f}GB.'
                }), 413

        # Check storage limit for registered users
        if registered_user:
            if not registered_user.has_storage_available(total_size):
                clear_upload_progress(progress_id)
                return jsonify({
                    'error': f'Storage limit exceeded. You have {registered_user.get_storage_remaining_gb():.2f}GB remaining.'
                }), 413

        temp_encrypted_path = os.path.join(temp_dir, encrypted_filename)

        upload_content_hash = None  # SHA-256 integrity hash computed during upload
        upload_payload_checksum = None  # SHA-256 of encrypted payload stored on disk/remote

        if is_e2e:
            # E2E: File is already encrypted client-side, just move the temp file
            # IMPORTANT: NO server-side encryption is applied to E2E files
            # The file is stored on disk exactly as received from the client (already encrypted)
            print(f'[UPLOAD] E2E: {total_files} file(s) saved to disk WITHOUT server-side encryption')
            
            # E2E uploads arrive as a single encrypted blob (single files are raw, multi-file are pre-zipped by client)
            src_path = saved_file_paths[0][0]
            shutil.move(src_path, temp_encrypted_path)
            if modern_e2e_complete:
                _container_ok, _container_err = validate_e2ee_container(temp_encrypted_path)
                if not _container_ok:
                    print(f'[UPLOAD] E2E container rejected: {_container_err}')
                    return jsonify({
                        'error': f'UPLOADED DATA IS NOT A VALID ENCRYPTED FILE: {_container_err}'
                    }), 400
            elif os.path.getsize(temp_encrypted_path) < _E2EE_GCM_TAG_SIZE:
                return jsonify({'error': 'LEGACY E2EE PAYLOAD IS TOO SHORT'}), 400
            total_zip_size = os.path.getsize(temp_encrypted_path)
            # Hash encrypted blob for at-rest integrity (server cannot access plaintext)
            upload_content_hash = _sha256_file(temp_encrypted_path)
            upload_payload_checksum = upload_content_hash
            
            print(f'[UPLOAD] E2E: total_zip_size = {total_zip_size}')
        else:
            # Server encryption - need to create zip first, then encrypt in chunks
            # IMPORTANT: Server-side encryption applies Fernet encryption to protect data at rest
            # This is ONLY used for non-E2E files
            print(f'[UPLOAD] Server encryption: processing {total_files} file(s)')
            set_upload_progress(progress_id, 'zipping', 0)
            
            temp_zip_path = os.path.join(temp_dir, 'temp.zip')
            # Create zip file - streaming approach for multiple files
            if total_files == 1:
                # Single file - already saved to disk, just rename
                src_path = saved_file_paths[0][0]
                shutil.move(src_path, temp_zip_path)
            else:
                # Multiple files - create zip using chunked reads from disk
                # NOTE: Files uploaded with folder structure will already have paths in their filenames
                # from the client-side zip creation. The server just needs to extract and re-zip.
                # Use ZIP_STORED (no compression) - compression is pointless since the zip gets
                # Fernet-encrypted afterward, and it saves significant CPU time on large uploads
                # AUDIT FIX (upload/download integrity): the on-disk staging path
                # was uniquified with `raw_{total_files}_` but the ZIP arcname was
                # the BARE safe_name, so two inputs normalising to the same string
                # produced duplicate ZIP entries and most extractors keep only the
                # last one -- silent data loss inside a "successful" upload.
                # De-duplicate arcnames so no member can be shadowed.
                used_arcnames = set()
                with zipfile.ZipFile(temp_zip_path, 'w', zipfile.ZIP_STORED) as zipf:
                    for idx, (file_path, safe_name, orig_filename) in enumerate(saved_file_paths):
                        if safe_name:
                            arcname = safe_name
                            if arcname in used_arcnames:
                                stem, dot, ext = safe_name.rpartition('.')
                                suffix = 1
                                while arcname in used_arcnames:
                                    if dot:
                                        arcname = f'{stem}_{suffix}.{ext}'
                                    else:
                                        arcname = f'{safe_name}_{suffix}'
                                    suffix += 1
                                print(f'[UPLOAD] Duplicate ZIP entry name {safe_name!r}; storing it as {arcname!r}')
                            used_arcnames.add(arcname)
                            zipf.write(file_path, arcname)
                            set_upload_progress(progress_id, 'zipping', (idx + 1) * 100 // total_files)
            
            total_zip_size = os.path.getsize(temp_zip_path)
            print(f'[UPLOAD] Server encryption: zip size = {total_zip_size}')

            # Encrypt the zip file in chunks. Plaintext + encrypted-payload SHA-256
            # are computed inside the same pass (was 3 full reads, now 1).
            print(f'[UPLOAD] Encrypting {total_zip_size} bytes in chunks...')
            set_upload_progress(progress_id, 'encrypting', 0)
            upload_content_hash, upload_payload_checksum = encrypt_file_chunked(temp_zip_path, temp_encrypted_path, file_id=progress_id)
            print(f'[UPLOAD] Encryption complete')

        # Compute actual on-disk size (encrypted) before moving to final location
        upload_disk_size = os.path.getsize(temp_encrypted_path)

        # Repeat the authoritative lookup immediately before quota work, payload
        # publication and insertion. This is normally a no-op while the database
        # lock is held, but also closes the race if a prior implementation or a
        # host without the database guard committed while this body was staged.
        registered_user = _refresh_upload_idempotency_snapshot(registered_user_id)
        if registered_user_id is not None and registered_user is None:
            return jsonify({'error': 'User not found'}), 404
        existing_upload = _find_existing_upload_by_key(
            upload_idempotency_key,
            registered_user_id=registered_user_id,
            user_id=user_id,
            manager_cookie=manager_cookie if is_temp else None,
        )
        if existing_upload:
            if existing_upload.folder_id != folder_id or bool(existing_upload.is_temp_upload) != bool(is_temp) or bool(existing_upload.is_e2e_encrypted) != bool(is_e2e):
                return jsonify({'error': 'UPLOAD RETRY CONFLICT. START A NEW UPLOAD.'}), 409
            print(f'[UPLOAD] Reused existing upload for idempotency key before finalization: {upload_idempotency_key}')
            return _upload_idempotent_reuse_response(existing_upload, manager_cookie)

        # AUDIT FIX (upload/download integrity): take the per-user quota flock
        # HERE, for the short finalize+commit critical section only, mirroring
        # what AUDIT FIX C1 already did for the guest global cap. The slow
        # transfer + encryption above now runs WITHOUT the exclusive lock, so
        # concurrent uploads from one user no longer pin every worker thread,
        # while the authoritative has_storage_available() check below and the
        # db.session.commit() that follows it remain serialized. Released in the
        # finally block.
        if registered_user:
            quota_lock = _acquire_user_quota_lock(
                registered_user.id, timeout=_UPLOAD_QUOTA_FLOCK_WAIT_SECONDS)
            if quota_lock is None:
                # Fail closed: proceeding without the lock would race the
                # authoritative quota check-and-commit.
                print('[UPLOAD] Timed out waiting for the per-user quota lock; '
                      'failing closed with 503')
                _resp = jsonify({'error': 'UPLOAD BUSY. PLEASE RETRY SHORTLY.'})
                _resp.headers['Retry-After'] = '30'
                return _resp, 503
            _refresh_quota_snapshot()

        if not registered_user:
            try:
                _temp_total_gb = get_float_setting('temp_total_max_gb')
                if _temp_total_gb > 0:
                    # AUDIT FIX C1: acquire the global guest-cap lock ONLY here,
                    # for the short finalize+commit critical section, so the
                    # used-bytes read and the row commit form an atomic
                    # reservation without serializing the slow transfer phase.
                    # Released in the finally block. Skipped entirely when the
                    # cap is disabled (temp_total_max_gb == 0).
                    guest_temp_cap_lock = _acquire_upload_idempotency_lock(
                        'guest_temp_cap', timeout=_UPLOAD_QUOTA_FLOCK_WAIT_SECONDS)
                    if guest_temp_cap_lock is None:
                        # Fail closed: a cap check without the lock would race
                        # concurrent guest uploads past the aggregate budget.
                        print('[UPLOAD] Timed out waiting for the guest temp cap lock; '
                              'failing closed with 503')
                        _resp = jsonify({'error': 'Temp upload storage is busy. Please try again later.'})
                        _resp.headers['Retry-After'] = '30'
                        return _resp, 503
                    _temp_total_bytes = int(_temp_total_gb * 1024 * 1024 * 1024)
                    # Like the registered path: the flock serializes execution, but
                    # this request's REPEATABLE READ snapshot predates a concurrent
                    # upload's commit unless it is refreshed after acquiring it.
                    _refresh_quota_snapshot()
                    _guest_used = _guest_temp_storage_used_bytes()
                    if int(_guest_used) + int(upload_disk_size) > _temp_total_bytes:
                        clear_upload_progress(progress_id)
                        print(f'[UPLOAD] Guest temp cap rejected finalized upload: used={_guest_used} new={upload_disk_size} cap={_temp_total_bytes}')
                        return jsonify({'error': 'Temp upload storage is full. Please try again later.'}), 507
            except Exception as _guest_err:
                print(f'[UPLOAD] Guest storage cap finalize check failed (non-fatal): {_guest_err}')

        if registered_user and not registered_user.has_storage_available(upload_disk_size):
            clear_upload_progress(progress_id)
            return jsonify({
                'error': f'Storage limit exceeded. You have {registered_user.get_storage_remaining_gb():.2f}GB remaining.'
            }), 413

        print(f'[UPLOAD] Individual files: {[f"{name} ({size} B)" for name, size in individual_file_sizes]}')
        print(f'[UPLOAD] Total files: {total_files}, Total size: {total_size} B, Total zip size: {total_zip_size} B, Disk size: {upload_disk_size} B')

        # Store file via StorageManager (move semantics for local, put for remote)
        set_upload_progress(progress_id, 'finalizing', 100)

        orig_name = f'files_{total_files}.zip' if total_files > 1 else sanitize_plaintext_name(saved_file_paths[0][2] if saved_file_paths else 'upload.zip')
        
        # For E2EE files with encrypted filenames: use placeholder orig_name so server never stores real name
        if is_e2e and e2e_encrypted_name:
            ext_part = e2e_stored_extension or ''
            orig_name = f'encrypted_{file_id[:8]}{ext_part}'

        # Note: Folder E2E setting is enforced client-side (shouldUseE2E checks folder.is_e2e).
        # Server cannot override E2E flag here because the file data is already client-encrypted
        # before upload — overriding would cause double-encryption and data loss.
        
        # Set defaults based on upload type
        if is_temp:
            # Temporary uploads: public by default, 1 day retention
            is_public = True
            expires_at = datetime.now(timezone.utc) + timedelta(days=1)
        else:
            # Cloud drive uploads: private by default, infinite retention
            is_public = False if registered_user_id else True
            expires_at = None  # Infinite retention for cloud drive
        
        is_short = request.form.get('short_url') == 'true'
        
        # Determine if this upload is legacy (non-E2E server-side Fernet) for backward compat
        is_legacy = (not is_e2e and not encrypted_file_key)
        
        file_record = File(
            id=file_id,
            orig_name=orig_name,
            filename=encrypted_filename,
            size=total_zip_size,
            expires_at=expires_at,
            is_public=is_public,
            management_token=management_token,
            user_id=user_id,
            registered_user_id=registered_user_id,
            folder_id=folder_id,
            is_e2e_encrypted=is_e2e,
            e2e_salt=e2e_salt,
            e2e_iv=e2e_iv,
            encrypted_file_key=encrypted_file_key,
            file_key_nonce=file_key_nonce,
            file_key_salt=file_key_salt,
            encrypted_name=e2e_encrypted_name,
            name_nonce=e2e_name_nonce,
            stored_extension=e2e_stored_extension,
            is_legacy_encrypted=is_legacy,
            short_code=generate_short_code() if is_short else None,
            is_temp_upload=is_temp,
            manager_cookie_id=manager_cookie if is_temp else None,
            upload_idempotency_key=upload_idempotency_key,
            content_hash=upload_content_hash,
            payload_checksum=upload_payload_checksum,
            disk_size=upload_disk_size
        )
        # AUDIT FIX P0-2/P1-13: add the File row to the session BEFORE
        # store_file so _mark_replica_synced (called inside store_file) can
        # see the pending File instance via SQLAlchemy's identity map and
        # back-fill size_bytes/checksum on the local FileReplica row. The
        # row is not persisted until db.session.commit() below, but the
        # identity map makes it visible to same-session queries.
        db.session.add(file_record)
        # AUDIT FIX H4: drop any stale tombstone for this key before the row can
        # replicate (belt and braces; Phase B also checks).
        _clear_pending_remote_deletes_for('files', [file_record.filename, file_record.id])
        touch_folder(folder_id)
        # Now store the file — the pending File row is visible to _mark_replica_synced.
        storage.store_file(encrypted_filename, temp_encrypted_path)
        print(f'[UPLOAD] Saved file: {encrypted_filename}, content size: {total_zip_size} bytes')
        # Save E2E encrypted thumbnail if provided (stored on disk, decrypted client-side)
        enc_thumb_file = request.files.get('encrypted_thumbnail')
        enc_thumb_nonce = request.form.get('thumbnail_nonce')
        if is_e2e and enc_thumb_file and enc_thumb_nonce:
            try:
                # AUDIT FIX (upload/download integrity): bounded read -- the old
                # `enc_thumb_file.read()` pulled the ENTIRE part into the worker
                # heap and only then compared its length.
                thumb_data, thumb_oversized = read_bounded_upload_part(
                    enc_thumb_file, _MAX_ENCRYPTED_THUMBNAIL_BYTES)
                if thumb_oversized:
                    print(f'[UPLOAD] E2E thumbnail exceeds {_MAX_ENCRYPTED_THUMBNAIL_BYTES} bytes, skipping')
                elif thumb_data and save_thumbnail_to_disk(file_id, thumb_data, is_e2e=True):
                    thumbnail_written = True  # AUDIT FIX D15
                    file_record.encrypted_thumbnail_nonce = enc_thumb_nonce
                    file_record.has_thumbnail = True
            except ReplicaSessionRollbackError as _thumb_db_err:
                # AUDIT FIX H3: replica bookkeeping rolled back the shared DB
                # session, which expunged the pending File row. Continuing to
                # the commit below would persist NOTHING yet answer HTTP 200
                # with management_token and download_url for a row that does
                # not exist -- the payload would sit orphaned on disk until
                # reaped and the upload would silently vanish after reporting
                # success. Abort loudly and clean up the payload + the
                # thumbnail that was already written to local disk.
                print(f'[UPLOAD] E2E thumbnail bookkeeping rolled back the DB session; aborting upload {file_id}: {_thumb_db_err}')
                try:
                    db.session.rollback()
                except Exception:
                    pass
                try:
                    storage.delete_file(encrypted_filename)
                except Exception as _cleanup_err:
                    print(f'[ERROR] Upload cleanup failed to remove payload {encrypted_filename}: {_cleanup_err}')
                payload_written = False
                try:
                    delete_thumbnail_from_disk(file_id)
                except Exception as _cleanup_err:
                    print(f'[ERROR] Upload cleanup failed to remove thumbnail for {file_id}: {_cleanup_err}')
                thumbnail_written = False
                return jsonify({'error': 'Upload failed due to a database error. Please try again.'}), 500
            except Exception as e:
                print(f'[UPLOAD] E2E thumbnail save failed (non-critical): {e}')

        if registered_user:
            lifecycle_lock = _acquire_user_lifecycle_lock(registered_user.id)
            if not _lock_live_folder_for_placement(folder_id, registered_user.id):
                db.session.rollback()
                _release_lifecycle_lock(lifecycle_lock)
                lifecycle_lock = None
                _cleanup_failed_upload_artifacts(encrypted_filename, file_id,
                                                 payload_written, thumbnail_written)
                payload_written = False
                thumbnail_written = False
                return jsonify({'error': 'FOLDER NOT FOUND'}), 404

        try:
            # AUDIT FIX H3: a helper above (store_file / save_thumbnail replica
            # bookkeeping) may have executed a session-wide rollback, which
            # expunges the pending File row. Committing would then persist
            # nothing while the response still reports success (management_token
            # / download_url) and the payload sits orphaned on disk until
            # reaped. Refuse to commit unless the File row is still tracked by
            # the session (pending before the first flush, persistent after an
            # autoflush); the handler below reuses the commit-failure cleanup.
            _file_row_state = inspect(file_record)
            if not (_file_row_state.pending or _file_row_state.persistent):
                raise RuntimeError(
                    f'UPLOAD ABORT: File row {file_id} was expunged from the DB '
                    'session by an internal rollback before commit; refusing to '
                    'report success for a row that was never committed'
                )
            # AUDIT FIX A20: retry on a short_code uniqueness collision instead of
            # failing an upload whose payload is already written and encrypted.
            _commit_with_short_code_retry(file_record)
        except _IdempotencyIntegrityError as _key_err:
            # AUDIT FIX M9: the per-owner UNIQUE indexes on upload_idempotency_key
            # are the DB-level backstop behind the flock + GET_LOCK idempotency
            # locks. Losing that race is an idempotent retry, not a failure:
            # serve the row the winner committed (or release trashed duplicates
            # and retry once) instead of failing after the payload was written.
            if not upload_idempotency_key or 'upload_idempotency_key' not in str(getattr(_key_err, 'orig', _key_err)).lower():
                raise
            db.session.rollback()
            existing_upload, conflict_action = _resolve_upload_key_unique_conflict(
                upload_idempotency_key,
                registered_user_id=registered_user_id,
                user_id=user_id,
                manager_cookie=manager_cookie if is_temp else None,
            )
            if conflict_action == 'retry':
                # Trashed duplicates released; the staged payload is still the
                # one true upload, so re-commit the pending row as-is.
                print(f'[UPLOAD] Released trashed duplicate idempotency rows for key {upload_idempotency_key}; retrying insert')
                db.session.add(file_record)
                _clear_pending_remote_deletes_for('files', [file_record.filename, file_record.id])
                touch_folder(folder_id)
                _commit_with_short_code_retry(file_record)
            else:
                # This attempt's payload is an orphan now -- the winner's row
                # (or nothing, on an unresolvable conflict) owns the key.
                try:
                    storage.delete_file(encrypted_filename)
                except Exception as _cleanup_err:
                    print(f'[ERROR] Upload cleanup failed to remove payload {encrypted_filename} after idempotency conflict: {_cleanup_err}')
                payload_written = False
                if is_e2e and getattr(file_record, 'has_thumbnail', False):
                    try:
                        delete_thumbnail_from_disk(file_id)
                    except Exception as _cleanup_err:
                        print(f'[ERROR] Upload cleanup failed to remove thumbnail for {file_id} after idempotency conflict: {_cleanup_err}')
                    thumbnail_written = False
                if conflict_action == 'reused':
                    print(f'[UPLOAD] Reused existing upload for idempotency key (DB unique backstop): {upload_idempotency_key}')
                    if (existing_upload.folder_id != folder_id
                            or bool(existing_upload.is_temp_upload) != bool(is_temp)
                            or bool(existing_upload.is_e2e_encrypted) != bool(is_e2e)):
                        return jsonify({'error': 'UPLOAD RETRY CONFLICT. START A NEW UPLOAD.'}), 409
                    return _upload_idempotent_reuse_response(existing_upload, manager_cookie if is_temp else None)
                raise RuntimeError(
                    f'UPLOAD CONFLICT: idempotency key {upload_idempotency_key} is held by a live file row '
                    f'outside this request\'s dedup scope; refusing to create a duplicate'
                )
        except Exception:
            db.session.rollback()
            # AUDIT FIX D15: log cleanup failures instead of swallowing them, and
            # clear the sentinels so the outer handler does not try to delete the
            # same artifacts (and queue duplicate remote tombstones) a second time.
            try:
                storage.delete_file(encrypted_filename)
            except Exception as _cleanup_err:
                print(f'[ERROR] Upload cleanup failed to remove payload {encrypted_filename} after failed commit: {_cleanup_err}')
            payload_written = False
            # Clean up E2E thumbnail written before the failed commit
            if is_e2e and getattr(file_record, 'has_thumbnail', False):
                try:
                    delete_thumbnail_from_disk(file_id)
                except Exception as _cleanup_err:
                    print(f'[ERROR] Upload cleanup failed to remove thumbnail for {file_id} after failed commit: {_cleanup_err}')
            thumbnail_written = False
            raise
        # The committed row now owns the payload and thumbnail: a later failure
        # (response building, progress, quota refresh) must not delete them.
        payload_written = False
        thumbnail_written = False
        print(f'[UPLOAD] DB saved: {file_id} -> {orig_name}, Size: {total_zip_size} bytes, E2E: {is_e2e}, Legacy: {is_legacy}')

        # Generate thumbnail for previewable single files (non-E2E only)
        # Run in background thread to avoid blocking the upload response
        if not is_e2e and total_files == 1:
            _schedule_thumbnail_bg(file_id, log_prefix='UPLOAD')

        check_storage()

        total_elapsed = time.time() - upload_start_time
        print(f'[UPLOAD] Complete: {file_id} ({total_zip_size} bytes) in {total_elapsed:.1f}s')
        set_upload_progress(progress_id, 'complete', 100)
        upload_result = _build_upload_response_payload(file_record)
        
        resp = make_response(jsonify(upload_result))
        # Set manager cookie for temp uploads (enables cross-tab/session file ownership)
        if is_temp and manager_cookie:
            resp.set_cookie(
                'onegy_manager', manager_cookie,
                max_age=7 * 24 * 3600,  # 7 days (matches max temp file lifetime)
                secure=True,
                samesite='Strict',
                httponly=False,  # JS must read this for client-side keychain encryption
                path='/'
            )
        return resp

    except RequestEntityTooLarge:
        # AUDIT FIX (upload/download integrity): _set_request_upload_cap()
        # deliberately raises RequestEntityTooLarge so the global 413 handler can
        # format it, but the broad `except Exception` below used to catch it
        # first and return a generic 500 -- a user over quota got a
        # retryable-looking 500 and retried forever. apiv1_upload and
        # save-content both handle it explicitly; do the same here.
        print('[UPLOAD] Request body exceeded the per-request cap')
        try:
            db.session.rollback()
        except Exception:
            pass
        _cleanup_failed_upload_artifacts(encrypted_filename, file_id,
                                         payload_written, thumbnail_written)
        if registered_user:
            return jsonify({
                'error': f'Storage limit exceeded. You have {registered_user.get_storage_remaining_gb():.2f}GB remaining.'
            }), 413
        _temp_limit_gb = get_float_setting('temp_max_gb')
        return jsonify({
            'error': f'File too large. Maximum temp upload size is {_temp_limit_gb:.1f}GB.'
        }), 413

    except MemoryError as e:
        print(f'[UPLOAD] Memory error: {str(e)}')
        # AUDIT FIX P3-3: explicitly rollback the pending file_record add so
        # cleanup is self-contained and does not rely on teardown rollback.
        try:
            db.session.rollback()
        except Exception:
            pass
        # AUDIT FIX D15/P3-2: sentinel-driven cleanup with logged failures.
        _cleanup_failed_upload_artifacts(encrypted_filename, file_id,
                                         payload_written, thumbnail_written)
        return jsonify({'error': 'Server ran out of memory. The file may be too large to process. Try using end-to-end encryption or a smaller file.'}), 413
    
    except (IOError, OSError) as e:
        # AUDIT FIX M4: only report 507 "disk may be full" for genuine
        # out-of-space errors. In Python 3 IOError is an alias for OSError, so
        # this previously mislabeled permission errors, vanished source files,
        # and interrupted reads as "disk full" with a 507 status, misdirecting
        # users and log monitoring about the true cause.
        import errno as _errno
        print(f'[UPLOAD] IO error: {str(e)}')
        try:
            db.session.rollback()
        except Exception:
            pass
        # AUDIT FIX D15: sentinel-driven cleanup with logged failures.
        _cleanup_failed_upload_artifacts(encrypted_filename, file_id,
                                         payload_written, thumbnail_written)
        if getattr(e, 'errno', None) in (_errno.ENOSPC, getattr(_errno, 'EDQUOT', None)):
            return jsonify({'error': 'Storage error. The disk may be full.'}), 507
        return jsonify({'error': 'Upload could not be stored due to a storage I/O error.'}), 500
    
    except Exception as e:
        print(f'[UPLOAD] Unexpected error: {str(e)}')
        import traceback
        traceback.print_exc()
        try:
            db.session.rollback()
        except Exception:
            pass
        # AUDIT FIX D15: sentinel-driven cleanup with logged failures.
        _cleanup_failed_upload_artifacts(encrypted_filename, file_id,
                                         payload_written, thumbnail_written)
        return jsonify({'error': 'Upload failed. Please try again.'}), 500
    
    finally:
        # Clean up progress tracking (delayed slightly so final poll can see 'complete')
        if progress_id:
            def _delayed_clear(fid):
                time.sleep(10)
                clear_upload_progress(fid)
            threading.Thread(target=_delayed_clear, args=(progress_id,), daemon=True).start()
        # Clean up temp directory
        if temp_dir and os.path.exists(temp_dir):
            try:
                shutil.rmtree(temp_dir)
                print(f'[UPLOAD] Cleaned up temp directory: {temp_dir}')
            except Exception as e:
                print(f'[UPLOAD] Warning: Failed to cleanup temp directory: {e}')
        _release_lifecycle_lock(lifecycle_lock)
        _release_upload_idempotency_database_lock(upload_idempotency_database_lock)
        _release_upload_idempotency_lock(upload_idempotency_lock)
        _release_upload_idempotency_lock(guest_temp_cap_lock)
        _release_user_quota_lock(quota_lock)
        # AUDIT FIX H4: release any in-flight guest-temp reservation held for this
        # request so the budget is freed once the body is committed or aborted.
        _release_guest_temp_inflight(guest_temp_reserved)

