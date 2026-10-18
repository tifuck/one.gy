@app.route('/s/<short_code>/resolve', methods=['GET'])
@csrf.exempt
@limiter.limit("30 per minute")
def short_resolve(short_code):
    """Resolve a short code to the underlying file ID.
    Used by the CLI tool to translate /s/<code> URLs into /f/<file_id> URLs
    so it can call /f/<id>/key-info and /f/<id>/encrypted."""
    file = File.query.filter_by(short_code=short_code, is_trashed=False).first()
    if not file:
        return jsonify({'error': 'SHORT LINK NOT FOUND'}), 404
    if not _can_access_file_via_short_code(file):
        return jsonify({'error': 'SHORT LINK NOT FOUND'}), 404
    return jsonify({'file_id': file.id, 'orig_name': file.orig_name})

@app.route('/s/<short_code>', methods=['GET', 'POST'])
@csrf.exempt
@limiter.limit(download_rate_limit)
def short_download(short_code):
    """Serve file directly via short code (no redirect).
    Handles both browser and CLI requests identically to /f/<id>.
    No redirect ensures URL fragments (E2EE keys) are preserved for browsers
    and curl/wget work without following redirects."""
    file = File.query.filter_by(short_code=short_code, is_trashed=False).first()
    if not file:
        return render_template('notfound.html',
            title='LINK NOT FOUND',
            subtitle='THIS SHORT LINK DOES NOT MATCH ANY EXISTING FILE',
            detail='THE FILE MAY HAVE EXPIRED OR BEEN DELETED'), 404
    return download_file_logic(file.id)

def _check_file_folder_access(file):
    """Single ancestor walk returning (public_folder, browsable_folder).
    Combines is_file_in_public_folder + is_file_in_browsable_folder to
    avoid walking the same parent chain twice (they are always called in pairs)."""
    if not file.folder_id:
        return None, None
    public_folder = None
    browsable_folder = None
    current_id = file.folder_id
    visited = set()
    now_utc = datetime.now(timezone.utc)
    file_folder = db.session.get(Folder, file.folder_id)
    while current_id is not None and current_id not in visited:
        visited.add(current_id)
        folder = db.session.get(Folder, current_id)
        if not folder or folder.is_trashed:
            return public_folder, browsable_folder
        # Check expiry once for both
        expired = False
        if folder.expires_at:
            expires_aware = folder.get_expires_at_aware()
            if expires_aware and expires_aware < now_utc:
                expired = True
        if expired:
            # An expired folder cuts off inherited access for everything below it.
            break
        if not expired and folder.is_public and public_folder is None:
            # AUDIT FIX H2: verify the inherited folder share-password through
            # _folder_share_password_ok() so this file-inheritance path honors
            # the SAME per-resource/per-IP brute-force lockout (M11) as the
            # folder-browse path. Previously it did a bare check_password_hash
            # with no lockout, so the folder password could be brute-forced by
            # attacking a contained file URL (/f/<file_id> + X-Share-Password)
            # instead of the folder URL. _folder_share_password_ok also honors
            # an existing session unlock marker.
            if not _locked_folder_share(file_folder, folder):
                public_folder = folder
        if not expired and _folder_has_active_non_owner_share(folder, require_browsable=True, require_password=False) and browsable_folder is None:
            if not _locked_folder_share(file_folder, folder):
                browsable_folder = folder
        # If both found, no need to continue walking
        if public_folder and browsable_folder:
            break
        current_id = folder.parent_id
    return public_folder, browsable_folder

def _get_share_password():
    """Return a share password from form data or an explicit request header."""
    return (
        request.form.get('pw')
        or request.form.get('password')
        or request.headers.get('X-Share-Password')
    )

def _current_user_owns_file(file):
    # AUDIT FIX H4: resolve through the epoch-validating helper so a revoked
    # session cookie cannot silently unlock a password-protected share.
    owner = _current_session_user()
    return bool(owner and file.registered_user_id and file.registered_user_id == owner.id)

def _file_share_access_marker(file):
    return _share_access_marker('file', file.id, file.password_hash)

def _remember_file_share_access(file):
    if not file.password_hash:
        return
    # AUDIT FIX P10: bounded + expiring unlock markers (see _remember_share_unlock).
    _remember_share_unlock('unlocked_file_shares', file.id, _file_share_access_marker(file))

def _file_share_password_ok(file, is_owner=None):
    """Return True if the current request/session satisfies a file share password."""
    if is_owner is None:
        is_owner = _current_user_owns_file(file)
    if is_owner or not file.password_hash:
        return True

    expected_marker = _file_share_access_marker(file)
    if _share_unlock_valid('unlocked_file_shares', file.id, expected_marker):
        return True

    password = _get_share_password()
    if password:
        # AUDIT FIX M11/P16: per-IP AND per-resource lockout to stop share-password
        # brute force. Reject (without running the KDF) while locked out.
        if not _share_pw_begin_attempt('file', file.id):
            return False
        if check_password_hash(file.password_hash, password):
            _share_pw_clear('file', file.id)
            _remember_file_share_access(file)
            return True
    return False

def _can_access_file_via_short_code(file):
    """Return True when the current request is allowed to resolve a short link."""
    if not file or file.is_trashed:
        return False

    expires_at_aware = file.get_expires_at_aware()
    if expires_at_aware and expires_at_aware < datetime.now(timezone.utc):
        return False

    is_owner = _current_user_owns_file(file)

    if file.is_e2e_encrypted and not is_owner and not _e2e_file_has_non_owner_key(file):
        return False

    if not _file_share_password_ok(file, is_owner):
        return False

    if not file.is_public:
        public_folder, browsable_folder = _check_file_folder_access(file)
        if public_folder or browsable_folder:
            return True
        if file.password_hash:
            return True
        return is_owner

    return True

def is_file_in_public_folder(file):
    """Check if a file resides in (or under) a public folder.
    Delegates to _check_file_folder_access for combined walk."""
    public_folder, _ = _check_file_folder_access(file)
    return public_folder

def is_file_in_browsable_folder(file):
    """Check if a file resides in (or under) a browsable folder.
    Delegates to _check_file_folder_access for combined walk."""
    _, browsable_folder = _check_file_folder_access(file)
    return browsable_folder

def is_file_locked_by_ancestor_e2e(file):
    """Check if a file is inside a browsable folder that enforces E2E encryption.
    Walks the full tree to find the root (highest) browsable ancestor. If any
    browsable ancestor in the chain has E2E enabled, the file is locked.
    Returns the E2E browsable folder if found, else None."""
    if not file.folder_id:
        return None
    # First check the file's immediate folder
    immediate = db.session.get(Folder, file.folder_id)
    if not immediate or immediate.is_trashed:
        return None
    # Walk the full tree from the file's folder upward, collecting all browsable ancestors
    root_browsable_e2e = None
    current_id = file.folder_id
    visited = set()
    while current_id is not None and current_id not in visited:
        visited.add(current_id)
        folder = db.session.get(Folder, current_id)
        if not folder or folder.is_trashed:
            break
        if folder.is_browsable:
            if folder.expires_at:
                expires_aware = folder.get_expires_at_aware()
                if expires_aware and expires_aware < datetime.now(timezone.utc):
                    break
            if folder.is_e2e:
                root_browsable_e2e = folder
        current_id = folder.parent_id
    return root_browsable_e2e

def download_file_logic(file_id):
    file = db.session.get(File, file_id)
    if not file:
        return render_template('notfound.html',
            title='FILE NOT FOUND',
            subtitle='THE FILE YOU ARE LOOKING FOR DOES NOT EXIST',
            detail='THE FILE ID IS INVALID OR THE FILE HAS BEEN REMOVED'), 404

    # Block download of trashed files
    if file.is_trashed:
        print(f'[DOWNLOAD] Blocked download of trashed file: {file.orig_name}')
        return render_template('notfound.html',
            title='FILE NOT FOUND',
            subtitle='THIS FILE HAS BEEN DELETED BY ITS OWNER'), 404

    print(f'[DOWNLOAD] Request for file_id: {file_id}')
    print(f'[DOWNLOAD] Found file: {file.orig_name} (filename: {file.filename})')

    # Check expiration FIRST
    expires_at_aware = file.get_expires_at_aware()
    if expires_at_aware and expires_at_aware < datetime.now(timezone.utc):
        file, deleted_name = _delete_immediately_expired_file(file)
        if deleted_name:
            print(f'[DOWNLOAD] File expired, deleted: {deleted_name}')
            return render_template('notfound.html',
                title='FILE EXPIRED',
                subtitle='THIS FILE HAS PASSED ITS EXPIRATION DATE AND HAS BEEN REMOVED',
                detail='EXPIRED FILES ARE AUTOMATICALLY DELETED FOR SECURITY'), 404
        if not file:
            return render_template('notfound.html',
                title='FILE NOT FOUND',
                subtitle='THE FILE YOU ARE LOOKING FOR DOES NOT EXIST'), 404

    # Check if user owns the file
    is_owner = _current_user_owns_file(file)

    if not _file_share_password_ok(file, is_owner):
        return render_template('pw.html', file_id=file_id, error=bool(_get_share_password()))

    # Check access permissions
    # First check if the file itself is public
    # If not, check if it's inside a public or browsable folder (folder inherits access)
    if not file.is_public:
        # Check if file is accessible via a public or browsable parent folder
        public_folder = is_file_in_public_folder(file)
        browsable_folder = is_file_in_browsable_folder(file)
        if public_folder:
            # File is accessible through its public folder
            print(f'[DOWNLOAD] File {file.orig_name} accessible via public folder: {_log_safe(public_folder.name)}')
        elif browsable_folder:
            # File is accessible through its browsable folder (E2E + browsable)
            print(f'[DOWNLOAD] File {file.orig_name} accessible via browsable folder: {_log_safe(browsable_folder.name)}')
        elif not is_owner and not file.password_hash:
            return render_template('notfound.html',
                title='FILE NOT FOUND',
                subtitle='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED',
                detail='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED'), 404
        if ((public_folder or browsable_folder) and not is_owner and not file.is_e2e_encrypted
                and _e2e_upload_boundary_for_folder(db.session.get(Folder, file.folder_id))):
            return render_template('notfound.html',
                title='FILE NOT FOUND',
                subtitle='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED',
                detail='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED'), 404

    encrypted_path = storage.get_file_path(file.filename)
    if not encrypted_path or not os.path.exists(encrypted_path):
        print(f'[DOWNLOAD] Encrypted file not found: {encrypted_path}')
        return render_template('notfound.html',
            title='FILE UNAVAILABLE',
            subtitle='THE FILE DATA COULD NOT BE LOCATED ON THE SERVER',
            detail='THE FILE RECORD EXISTS BUT THE DATA IS MISSING'), 404

    if file.is_e2e_encrypted:
        if not is_owner and not _e2e_file_has_non_owner_key(file):
            return render_template('notfound.html',
                title='FILE NOT FOUND',
                subtitle='THE FILE YOU ARE LOOKING FOR DOES NOT EXIST',
                detail='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED'), 404
        # E2E: Render page for client-side decryption.
        # Download count is handled by /f/{id}/encrypted when the actual data streams,
        # using check_and_increment_download for atomic TOCTOU-safe enforcement.
        success, error = check_download_allowed(file)
        if not success:
            if error == 'limit_reached':
                return 'Download limit reached', 410
            return render_template('notfound.html',
                title='DOWNLOAD UNAVAILABLE',
                subtitle='THIS FILE COULD NOT BE DOWNLOADED AT THIS TIME',
                detail='THE DOWNLOAD CHECK FAILED. THE FILE MAY HAVE BEEN REMOVED'), 404
        print(f'[DOWNLOAD] E2E file, rendering decryption page: {file.orig_name}')
        return render_template('e2e_download.html', file=file)

    success, error = check_download_allowed(file)
    if not success:
        if error == 'limit_reached':
            return 'Download limit reached', 410
        return render_template('notfound.html',
            title='DOWNLOAD UNAVAILABLE',
            subtitle='THIS FILE COULD NOT BE DOWNLOADED AT THIS TIME',
            detail='THE DOWNLOAD CHECK FAILED. THE FILE MAY HAVE BEEN REMOVED'), 404

    # Server encryption - decrypt and send
    # IMPORTANT: This path is ONLY for server-side encrypted files (non-E2E)
    # The file will be decrypted on the server using Fernet before sending to client
    try:
        print(f'[DOWNLOAD] Decrypting server-side encrypted file: {file.orig_name}')
        print(f'[DOWNLOAD] File is_e2e_encrypted: {file.is_e2e_encrypted}')
        print(f'[DOWNLOAD] Encrypted file size: {os.path.getsize(encrypted_path)} bytes')

        import mimetypes
        if file.orig_name.endswith('.zip'):
            mimetype = 'application/zip'
        else:
            mimetype, _ = mimetypes.guess_type(file.orig_name)
            if not mimetype:
                mimetype = 'application/octet-stream'

        # For large files, decrypt to a temp file first then serve.
        # Streaming decryption directly over SSL causes "bad record mac" errors
        # for long-running transfers (especially with CLI clients like wget/curl).
        if request.method == 'HEAD':
            return _build_streaming_response(
                lambda: iter(()), mimetype, disposition='attachment',
                filename=file.orig_name, content_length=file.size,
                headers={'Cache-Control': 'no-cache, no-store, must-revalidate',
                         'Pragma': 'no-cache', 'Expires': '0', 'X-Accel-Buffering': 'no'})
        orig_size = file.size or 0
        if orig_size > LARGE_FILE_THRESHOLD:
            if is_browser_request() and not _wants_raw_bytes():
                prep_id = str(uuid.uuid4())
                prep_state = {
                    'progress': 0,
                    'status': 'pending',
                    'temp_path': None,
                    'ready': False,
                    'error': None,
                    'orig_name': file.orig_name,
                    'mimetype': mimetype,
                    'orig_size': orig_size,
                    'file_id': file.id,
                    'created_at': datetime.now(timezone.utc).isoformat(),
                    'session_id': _get_download_session_id(),
                }
                reserved, active_preps = _reserve_prep_download_slot(prep_id, prep_state)
                if not reserved:
                    print(f'[DOWNLOAD] Too many concurrent preparations ({active_preps}), rejecting')
                    return 'SERVER BUSY - TOO MANY DOWNLOADS IN PROGRESS. PLEASE TRY AGAIN LATER.', 503

                # Browser: show a progress page with async polling
                print(f'[DOWNLOAD] Large file ({orig_size} bytes) from browser, showing progress page. prep_id={prep_id}')
                # Start background decryption thread
                thread = threading.Thread(
                    target=_prepare_download_background,
                    args=(prep_id, encrypted_path, orig_size),
                    kwargs={
                        'file_id': file.id,
                        'expected_payload_checksum': file.payload_checksum,
                        'expected_disk_size': file.disk_size,
                    },
                    daemon=True
                )
                thread.start()
                return render_template('preparing_download.html',
                                       filename=file.orig_name,
                                       prep_id=prep_id,
                                       download_url=url_for('download_prepared_file', prep_id=prep_id))
            else:
                # CLI client (wget/curl/etc): decrypt to temp file synchronously, then serve.
                # This avoids SSL corruption from long-running streaming decryption.
                print(f'[DOWNLOAD] Large file ({orig_size} bytes) from CLI client, decrypting to temp file first')
                tmp_path, _cleanup_tmp = _prepare_sync_download(encrypted_path, file)
                if tmp_path is None:
                    return 'SERVER BUSY - TOO MANY DOWNLOADS IN PROGRESS. PLEASE TRY AGAIN LATER.', 503

                try:
                    print(f'[DOWNLOAD] Streaming decrypted temp file to CLI: {file.orig_name} ({file.size} bytes)')
                    success, error = check_and_increment_download(file)
                    if not success:
                        _cleanup_tmp(False)
                        if error == 'limit_reached':
                            return 'Download limit reached', 410
                        return render_template('notfound.html',
                            title='DOWNLOAD UNAVAILABLE',
                            subtitle='THIS FILE COULD NOT BE DOWNLOADED AT THIS TIME',
                            detail='THE DOWNLOAD CHECK FAILED. THE FILE MAY HAVE BEEN REMOVED'), 404
                    return _build_streaming_response(
                        lambda: _iter_file_chunks(tmp_path),
                        mimetype,
                        disposition='attachment',
                        filename=file.orig_name,
                        content_length=file.size,
                        headers={
                            'Cache-Control': 'no-cache, no-store, must-revalidate',
                            'Pragma': 'no-cache',
                            'Expires': '0',
                            'X-Accel-Buffering': 'no'
                        },
                        on_finalize=_finalize_download_with_temp_cleanup(file.id, _cleanup_tmp)
                    )
                except Exception:
                    _cleanup_tmp(False)
                    raise

        # Small files: stream decryption directly with payload-checksum +
        # disk-size verification. AUDIT Tier 0 #1.
        print(f'[DOWNLOAD] Streaming file ({orig_size} bytes) with Content-Length')

        # AUDIT FIX S3: reject a corrupt/truncated stored payload BEFORE emitting
        # the 200 + Content-Length headers, so the client gets a proper error
        # instead of a body shorter than the advertised length.
        if not _payload_disk_size_matches(encrypted_path, file.disk_size):
            print(f'[ERROR] [DOWNLOAD] Disk-size mismatch for {file.id} -- refusing to stream truncated download')
            return render_template('notfound.html',
                title='DOWNLOAD UNAVAILABLE',
                subtitle='THIS FILE COULD NOT BE DOWNLOADED AT THIS TIME',
                detail='THE STORED FILE FAILED AN INTEGRITY CHECK'), 500

        print(f'[DOWNLOAD] Streaming decrypted file: {file.orig_name} (original size: {file.size} bytes)')
        success, error = check_and_increment_download(file)
        if not success:
            if error == 'limit_reached':
                return 'Download limit reached', 410
            return render_template('notfound.html',
                title='DOWNLOAD UNAVAILABLE',
                subtitle='THIS FILE COULD NOT BE DOWNLOADED AT THIS TIME',
                detail='THE DOWNLOAD CHECK FAILED. THE FILE MAY HAVE BEEN REMOVED'), 404
        # Stream decryption with payload-checksum + disk-size verification.
        # AUDIT Tier 0 #1.
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
            headers={
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'X-Accel-Buffering': 'no'
            },
            on_finalize=lambda completed: finalize_reserved_download(file.id, completed)
        )

    except Exception as e:
        logging.error(f'[DOWNLOAD] Decryption error: {str(e)}', exc_info=True)
        return render_template('notfound.html',
            title='DECRYPTION FAILED',
            subtitle='THE FILE COULD NOT BE DECRYPTED BY THE SERVER',
            detail='THE FILE DATA MAY BE CORRUPTED OR THE ENCRYPTION KEY IS INVALID'), 500


def _prepare_download_background(prep_id, encrypted_path, file_size,
                                 file_id=None, expected_payload_checksum=None,
                                 expected_disk_size=None):
    """Background thread: decrypt a large file to a temp file while tracking progress.

    AUDIT FIX P1-1: large browser ("prepared") downloads now verify the same
    on-disk payload checksum + disk-size that the direct/CLI download paths
    verify, instead of only checking the decrypted plaintext length. Without
    this, a large-file browser download skipped the [ERROR] payload-corruption
    detection/abort that small and CLI downloads already perform.
    """
    # AUDIT FIX (upload/download integrity): track the temp path in a LOCAL so
    # the error handler can always delete the decrypted plaintext. It used to
    # re-read the path back out of the prep state, which returns None whenever
    # the state was unreadable or already reaped -- leaking the plaintext of an
    # at-rest-encrypted file onto disk with nothing pointing at it.
    tmp_path = None
    try:
        if not _transition_prep_state(
                prep_id, ('pending',), status='decrypting', progress=0):
            print(f'[DOWNLOAD] Prep {prep_id} vanished before decryption started; aborting')
            _reap_prep_state(prep_id, None, 'failed to persist worker start')
            return

        tmp_fd, tmp_path = tempfile.mkstemp(suffix='.dec', dir=app.config['UPLOAD_FOLDER'])
        if not _transition_prep_state(
                prep_id, ('decrypting',), temp_path=tmp_path):
            print(f'[DOWNLOAD] Prep {prep_id} vanished before its temp path could be recorded; aborting')
            os.close(tmp_fd)
            raise RuntimeError(f'Prep state {prep_id} disappeared')

        total_written = 0
        with os.fdopen(tmp_fd, 'wb') as tmp_file:
            for decrypted_chunk in decrypt_file_chunked(
                encrypted_path,
                expected_size=file_size,
                expected_payload_checksum=expected_payload_checksum,
                expected_disk_size=expected_disk_size,
                file_id=file_id,
            ):
                tmp_file.write(decrypted_chunk)
                total_written += len(decrypted_chunk)
                pct = min(99, (total_written / file_size) * 100) if file_size > 0 else 50
                # Each tick also refreshes the state file's mtime, which is what
                # marks this prep as still alive for the stale-slot reaper.
                if not _transition_prep_state(
                        prep_id, ('decrypting',), progress=pct):
                    raise RuntimeError(f'Prep state {prep_id} could not record progress')

        if total_written != file_size:
            raise ValueError(f'Decrypted size mismatch in prep {prep_id}: expected {file_size} bytes, got {total_written}')

        if not _transition_prep_state(
                prep_id, ('decrypting',), status='ready', progress=100, ready=True):
            raise RuntimeError(f'Prep state {prep_id} disappeared before it could be marked ready')

        print(f'[DOWNLOAD] Prepared download {prep_id}: {total_written} bytes decrypted to temp file')

    except Exception as e:
        print(f'[ERROR] Failed preparing download {prep_id}: {e}')
        # Clean up the decrypted plaintext on error, using the LOCAL path.
        plaintext_removed = _remove_prep_plaintext(
            prep_id, {'temp_path': tmp_path}, 'preparation failed')
        error_recorded = _transition_prep_state(
            prep_id,
            ('pending', 'decrypting'),
            status='error',
            ready=False,
            error='Download preparation failed',
            temp_path=None if plaintext_removed else tmp_path,
            release_reservation=plaintext_removed,
        )
        if not error_recorded:
            _reap_prep_state(prep_id, None, 'failed to persist worker error')


@app.route('/download/progress/<prep_id>')
@csrf.exempt
def download_progress_poll(prep_id):
    """JSON polling endpoint: return current decryption progress."""
    info = _read_prep_state(prep_id)

    if not info:
        return jsonify({'status': 'error', 'error': 'UNKNOWN PREPARATION ID', 'progress': 0})

    # AUDIT FIX (upload/download integrity): FAIL CLOSED. This used to read
    # `if prep_session_id and ...`, so a state file with NO session_id skipped
    # the ownership check entirely -- and _update_prep_state() produced exactly
    # such ownerless states whenever a read/parse failure made it restart from
    # an empty dict. A prep with no recorded owner is now always rejected.
    prep_session_id = info.get('session_id')
    if not prep_session_id or session.get('download_session_id') != prep_session_id:
        return jsonify({'status': 'error', 'error': 'FORBIDDEN', 'progress': 0}), 403

    status = info.get('status', 'pending')
    progress = info.get('progress', 0)

    if status == 'ready':
        return jsonify({'status': 'ready', 'progress': 100})
    elif status == 'error':
        return jsonify({'status': 'error', 'error': info.get('error', 'DECRYPTION FAILED'), 'progress': progress})
    else:
        return jsonify({'status': status, 'progress': round(progress, 1)})


@app.route('/download/prepared/<prep_id>')
@csrf.exempt
def download_prepared_file(prep_id):
    """Serve a fully decrypted temp file, then clean up."""
    if request.method == 'HEAD':
        info = _read_prep_state(prep_id)
        if not info or info.get('status') != 'ready' or not info.get('reservation_held'):
            return 'NOT READY', 404
        if not info.get('session_id') or info.get('session_id') != session.get('download_session_id'):
            return 'FORBIDDEN', 403
        return _build_streaming_response(
            lambda: iter(()), info.get('mimetype', 'application/octet-stream'),
            disposition='attachment', filename=info.get('orig_name', 'download'),
            content_length=info.get('orig_size') or None,
            headers={'Cache-Control': 'no-cache, no-store, must-revalidate', 'X-Accel-Buffering': 'no'})
    info, claim_error = _claim_prepared_download(
        prep_id, session.get('download_session_id'))
    if claim_error == 'not_ready':
        return 'NOT READY', 404
    if claim_error == 'forbidden':
        print(f'[DOWNLOAD] Prepared download rejected for {prep_id}: missing or mismatched owner session')
        return 'FORBIDDEN', 403

    tmp_path = info.get('temp_path')
    orig_name = info.get('orig_name', 'download')
    mimetype = info.get('mimetype', 'application/octet-stream')
    file_size = info.get('orig_size', 0)
    file_id = info.get('file_id')

    if not tmp_path:
        _reap_prep_state(prep_id, info, 'ready state has no plaintext path')
        return 'FILE NOT FOUND', 404

    # AUDIT FIX (upload/download integrity): OPEN THE PLAINTEXT NOW and stream
    # from that descriptor. The previous code checked os.path.exists() and then
    # let _iter_file_chunks() re-open the path lazily on the first pull -- by
    # which time the headers (including Content-Length) were already on the wire.
    # The orphan reaper (and now the much shorter prep TTL) can unlink a stale
    # .dec between those two moments, which produced a truncated 200 the client
    # could not distinguish from success. Holding the fd open means an unlink is
    # harmless: POSIX keeps the inode alive until the last descriptor closes, so
    # the stream always delivers exactly the bytes we size-checked here.
    try:
        tmp_handle = open(tmp_path, 'rb')
    except OSError:
        _reap_prep_state(prep_id, info, 'plaintext missing before delivery')
        return 'FILE NOT FOUND', 404

    try:
        actual_size = os.fstat(tmp_handle.fileno()).st_size
    except OSError:
        tmp_handle.close()
        _reap_prep_state(prep_id, info, 'could not inspect plaintext before delivery')
        return 'FILE NOT FOUND', 404

    if file_size and int(actual_size) != int(file_size):
        tmp_handle.close()
        print(f'[ERROR] Prepared download {prep_id} plaintext is {actual_size} bytes but '
              f'{file_size} were expected; refusing to serve a truncated body')
        _reap_prep_state(prep_id, info, 'plaintext size mismatch')
        return 'DOWNLOAD PREPARATION FAILED', 500

    if file_id:
        file = db.session.get(File, file_id)
        if not file or not _can_access_file_via_short_code(file):
            tmp_handle.close()
            _reap_prep_state(prep_id, info, 'access revoked before delivery')
            return 'FORBIDDEN', 403
        success, error = check_and_increment_download(file) if file else (False, 'limit_reached')
        if not success:
            tmp_handle.close()
            _reap_prep_state(prep_id, info, 'download reservation rejected before delivery')
            if error == 'limit_reached':
                return 'Download limit reached', 410
            return 'FILE NOT FOUND', 404

    def _cleanup_tmp():
        try:
            tmp_handle.close()
        except Exception:
            pass
        plaintext_removed = _remove_prep_plaintext(
            prep_id, {'temp_path': tmp_path}, 'delivery finalized')
        transitioned = _transition_prep_state(
            prep_id,
            ('ready',),
            status='consumed',
            ready=False,
            temp_path=None if plaintext_removed else tmp_path,
            release_reservation=plaintext_removed,
        )
        if not transitioned and plaintext_removed:
            _reap_prep_state(prep_id, info, 'delivery finalized after state changed')

    def _finalize_prepared(completed):
        # AUDIT FIX (upload/download integrity): the decrypted plaintext MUST be
        # removed even when the DB side raises. Previously a failure in
        # finalize_reserved_download() skipped the cleanup entirely, leaving the
        # plaintext of an at-rest-encrypted file on disk.
        try:
            if file_id:
                finalize_reserved_download(file_id, completed)
        finally:
            _cleanup_tmp()

    return _build_streaming_response(
        lambda: _iter_open_file_chunks(tmp_handle),
        mimetype,
        disposition='attachment',
        filename=orig_name,
        content_length=file_size if file_size else actual_size,
        headers={
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'X-Accel-Buffering': 'no'
        },
        on_finalize=_finalize_prepared
    )


