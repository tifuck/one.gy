@app.route('/f/<share_token>/file/<file_id>/<filename>')
@app.route('/f/<share_token>/file/<file_id>')
@limiter.limit(download_rate_limit)
def browse_folder_download_file(share_token, file_id, filename=None):
    """Download a single file from a browsable shared folder"""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return error
    
    # Check if folder is browsable directly (public+browsable or E2E+browsable) or via ancestor
    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        ancestor = is_folder_in_browsable_ancestor(folder)
        if not ancestor:
            ancestor = is_folder_in_public_browsable_ancestor(folder)
        if not ancestor:
            abort(403)
        folder_is_browsable = True
    
    # Verify file belongs to this folder tree
    allowed_files = collect_browsable_files(folder.id, is_owner, folder_is_browsable, bool(folder.is_link_shared))
    allowed_ids = {f.id for f in allowed_files}
    
    if file_id not in allowed_ids:
        abort(404)
    
    file = db.session.get(File, file_id)
    if not file:
        abort(404)

    # AUDIT FIX P1: check_download_allowed() inspects max_downloads and NOTHING
    # else, so expiry was never enforced on any /f/<share_token>/... route. The
    # collector above now filters expired files too, but re-check explicitly here
    # so this delivery path fails closed on its own. Unlike download_file_logic()
    # this does NOT delete the row: an anonymous read path must not destroy data.
    if not _file_not_expired(file):
        print(f'[BROWSE DOWNLOAD] Refused expired file through folder token: {_log_safe(file.orig_name)}')
        return render_template('notfound.html',
            title='FILE EXPIRED',
            subtitle='THIS FILE HAS PASSED ITS EXPIRATION DATE',
            detail='EXPIRED FILES ARE AUTOMATICALLY DELETED FOR SECURITY'), 404

    file_path = storage.get_file_path(file.filename)
    if not file_path or not os.path.exists(file_path):
        abort(404)
    
    success, error = check_download_allowed(file)
    if not success:
        if error == 'limit_reached':
            return 'Download limit reached', 410
        return render_template('notfound.html',
            title='DOWNLOAD UNAVAILABLE',
            subtitle='THIS FILE COULD NOT BE DOWNLOADED AT THIS TIME',
            detail='THE DOWNLOAD CHECK FAILED. THE FILE MAY HAVE BEEN REMOVED'), 404
    
    # Decrypt and serve
    print(f'[BROWSE DOWNLOAD] Serving file: {_log_safe(file.orig_name)} from folder: {_log_safe(folder.name)}')
    
    if file.is_e2e_encrypted:
        if request.method == 'HEAD':
            return _build_streaming_response(
                lambda: iter(()), safe_served_mimetype(file.orig_name),
                disposition='attachment', filename=file.orig_name, content_length=file.size,
                headers={'Cache-Control': 'no-cache, no-store, must-revalidate', 'X-Accel-Buffering': 'no'})
        success, error = check_and_increment_download(file)
        if not success:
            if error == 'limit_reached':
                return 'Download limit reached', 410
            return render_template('notfound.html',
                title='DOWNLOAD UNAVAILABLE',
                subtitle='THIS FILE COULD NOT BE DOWNLOADED AT THIS TIME',
                detail='THE DOWNLOAD CHECK FAILED. THE FILE MAY HAVE BEEN REMOVED'), 404
        # E2E files are stored as-is, serve directly.
        # AUDIT Tier 0 #1: verify on-disk size + payload SHA-256.
        mimetype = safe_served_mimetype(file.orig_name)
        return _build_streaming_response(
            lambda: _iter_file_chunks(
                file_path,
                expected_checksum=file.payload_checksum,
                expected_size=file.disk_size,
                file_id=file.id,
                corruption_kind='e2ee-payload-browse',
            ),
            mimetype,
            disposition='attachment',
            filename=file.orig_name,
            content_length=file.size,
            headers={
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-Accel-Buffering': 'no'
            },
            on_finalize=lambda completed: finalize_reserved_download(file.id, completed)
        )
    
    # Stream decrypted file directly (no temp file needed)
    from flask import Response
    if file.orig_name.endswith('.zip'):
        mimetype = 'application/zip'
    else:
        mimetype = safe_served_mimetype(file.orig_name)
    
    # For large files, decrypt to a temp file first then serve.
    # Streaming decryption directly over SSL causes "bad record mac" errors
    # for long-running transfers (especially with CLI clients like wget/curl).
    if request.method == 'HEAD':
        return _build_streaming_response(
            lambda: iter(()), mimetype, disposition='attachment',
            filename=file.orig_name, content_length=file.size,
            headers={'Cache-Control': 'no-cache, no-store, must-revalidate', 'X-Accel-Buffering': 'no'})
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
                print(f'[BROWSE DOWNLOAD] Too many concurrent preparations ({active_preps}), rejecting')
                return 'SERVER BUSY - TOO MANY DOWNLOADS IN PROGRESS. PLEASE TRY AGAIN LATER.', 503

            # Browser: show a progress page with async polling
            print(f'[BROWSE DOWNLOAD] Large file ({orig_size} bytes) from browser, showing progress page. prep_id={prep_id}')
            thread = threading.Thread(
                target=_prepare_download_background,
                args=(prep_id, file_path, orig_size),
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
            # CLI client (wget/curl/etc): decrypt to temp file synchronously, then serve
            print(f'[BROWSE DOWNLOAD] Large file ({orig_size} bytes) from CLI client, decrypting to temp file first')
            tmp_path, _cleanup_tmp = _prepare_sync_download(file_path, file)
            if tmp_path is None:
                return 'SERVER BUSY - TOO MANY DOWNLOADS IN PROGRESS. PLEASE TRY AGAIN LATER.', 503

            try:
                print(f'[BROWSE DOWNLOAD] Streaming decrypted temp file to CLI: {_log_safe(file.orig_name)} ({file.size} bytes)')
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
                        'X-Accel-Buffering': 'no'
                    },
                    on_finalize=_finalize_download_with_temp_cleanup(file.id, _cleanup_tmp)
                )
            except Exception:
                _cleanup_tmp(False)
                raise

    # AUDIT FIX S3: reject a corrupt/truncated stored payload before emitting the
    # 200 + Content-Length, so a known-bad file returns a proper error instead of
    # a truncated 'success' body.
    if not _payload_disk_size_matches(file_path, file.disk_size):
        print(f'[ERROR] [BROWSE DOWNLOAD] Disk-size mismatch for {file.id} -- refusing to stream truncated download')
        abort(500)
    # Small files: stream decryption directly (with integrity check)
    success, error = check_and_increment_download(file)
    if not success:
        if error == 'limit_reached':
            return 'Download limit reached', 410
        return render_template('notfound.html',
            title='DOWNLOAD UNAVAILABLE',
            subtitle='THIS FILE COULD NOT BE DOWNLOADED AT THIS TIME',
            detail='THE DOWNLOAD CHECK FAILED. THE FILE MAY HAVE BEEN REMOVED'), 404
    return _build_streaming_response(
        lambda: decrypt_file_chunked(
            file_path,
            expected_size=file.size,
            expected_payload_checksum=file.payload_checksum,
            expected_disk_size=file.disk_size,
            file_id=file.id,
        ),
        mimetype,
        disposition='attachment',
        filename=file.orig_name,
        content_length=file.size,
        headers={'X-Accel-Buffering': 'no'},
        on_finalize=lambda completed: finalize_reserved_download(file.id, completed)
    )

@app.route('/f/<share_token>/folder/<int:subfolder_id>/<foldername>.zip')
@app.route('/f/<share_token>/folder/<int:subfolder_id>')
@limiter.limit(download_rate_limit)
def browse_folder_download_subfolder(share_token, subfolder_id, foldername=None):
    """Download a subfolder from a browsable shared folder as a ZIP file"""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return error

    # Check if folder is browsable directly or via a browsable ancestor
    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        ancestor = is_folder_in_browsable_ancestor(folder)
        if not ancestor:
            ancestor = is_folder_in_public_browsable_ancestor(folder)
        if not ancestor:
            abort(403)
        folder_is_browsable = True

    # Verify subfolder belongs to this folder tree.
    # AUDIT FIX P2: enforce trash AND expiry on the sub-folder and every folder
    # between it and the share root, not just containment.
    subfolder = _shared_subfolder_available(subfolder_id, folder)
    if not subfolder:
        abort(404)

    if request.method == 'HEAD':
        return _build_streaming_response(
            lambda: iter(()), 'application/zip', disposition='attachment',
            filename=f'{secure_filename(subfolder.name)}.zip')

    print(f'[BROWSE DOWNLOAD] Downloading subfolder as ZIP: {_log_safe(subfolder.name)} (id={subfolder_id}) from shared folder: {_log_safe(folder.name)}')

    # AUDIT FIX P5: files dropped by the PRE-FILTERS (download limit exhausted,
    # payload missing on disk) were previously invisible -- not in the log, not in
    # _DOWNLOAD_ERRORS.txt, not in the X-Incomplete-Archive header. They are now
    # recorded. Access-control exclusions are deliberately NOT recorded: telling
    # an anonymous visitor which hidden files exist would be an information leak.
    pre_skipped = []

    # Collect files recursively from the subfolder.
    # Bulk-load the folder subtree + all its files up front (O(depth)+2 queries
    # instead of 2 per folder), then walk the in-memory maps in the same DFS
    # order as the old recursive version.
    def collect_subfolder_files(root_id):
        files_to_zip = []
        root_obj = db.session.get(Folder, root_id)
        if not root_obj or root_obj.is_trashed:
            return files_to_zip
        subtree_ids = _collect_descendant_folder_ids([root_id], include_roots=True)
        subtree_folders = Folder.query.filter(Folder.id.in_(list(subtree_ids)), Folder.is_trashed == False).all()
        children_map = {}
        for fld in subtree_folders:
            children_map.setdefault(fld.parent_id, []).append(fld)
        files_by_folder = {}
        for f in File.query.filter(
            File.folder_id.in_(list(subtree_ids)),
            File.is_temp_upload == False,
            File.is_trashed == False
        ).all():
            files_by_folder.setdefault(f.folder_id, []).append(f)

        def _walk(fld_obj, path_prefix):
            fld_e2e_boundary = _e2e_upload_boundary_for_folder(fld_obj)
            for file in files_by_folder.get(fld_obj.id, []):
                # AUDIT FIX P1: never ZIP an expired file through a folder token.
                if not _file_not_expired(file):
                    continue
                if not is_owner and fld_e2e_boundary and not file.is_e2e_encrypted:
                    continue
                if not file.is_public and file.registered_user_id and not folder.is_public and not folder_is_browsable:
                    if not is_owner:
                        continue
                if file.password_hash:
                    continue
                # Hide E2EE files without link/passphrase-scoped keys from non-owners.
                if file.is_e2e_encrypted and not is_owner and not _e2e_file_has_non_owner_key(file):
                    continue
                zip_path = os.path.join(path_prefix, safe_zip_entry_name(file.orig_name))
                # Skip files that have exhausted their max_downloads limit
                if file.max_downloads and (file.download_count or 0) >= file.max_downloads:
                    pre_skipped.append(_zip_skip_entry(zip_path, 'DOWNLOAD LIMIT REACHED'))
                    continue
                if _zip_skip_if_e2e(file, zip_path, pre_skipped):
                    continue
                file_path = storage.get_file_path(file.filename)
                if file_path and os.path.exists(file_path):
                    files_to_zip.append((file_path, zip_path, file))
                else:
                    pre_skipped.append(_zip_skip_entry(zip_path, 'PAYLOAD NOT AVAILABLE'))
            for sf in children_map.get(fld_obj.id, []):
                # AUDIT FIX P2: an expired sub-folder cuts off everything below it.
                if not _folder_not_expired(sf) or _locked_folder_share(sf, folder):
                    continue
                sf_path = os.path.join(path_prefix, safe_zip_entry_name(sf.name))
                _walk(sf, sf_path)

        _walk(root_obj, '')
        return files_to_zip

    files_to_zip = collect_subfolder_files(subfolder_id)
    print(f'[BROWSE DOWNLOAD] Total files in subfolder ZIP: {len(files_to_zip)} ({len(pre_skipped)} pre-skipped)')

    if not files_to_zip:
        flash('FOLDER IS EMPTY', 'error')
        return render_template('notfound.html',
            title='EMPTY FOLDER',
            subtitle='THIS FOLDER DOES NOT CONTAIN ANY DOWNLOADABLE FILES',
            detail='THE FOLDER EXISTS BUT HAS NO FILES TO DOWNLOAD'), 404

    ok, err_resp = _enforce_zip_limits(files_to_zip)
    if not ok:
        return err_resp
    # AUDIT FIX P11: reserve the estimated disk footprint with the slot.
    zip_estimate = _zip_build_estimate_bytes(files_to_zip)
    zip_reservation, err_resp = _acquire_zip_slot(zip_estimate)
    if not zip_reservation:
        return err_resp

    try:
        temp_zip_dir = create_work_dir('browse_subfolder_dl_')
    except Exception:
        _release_zip_slot(zip_reservation)
        raise
    temp_zip_path = os.path.join(temp_zip_dir, 'folder.zip')
    slot_handed_off = False

    try:
        files_added = 0
        added_file_ids = []
        added_reservations = []  # AUDIT FIX (finding 1): (id, reservation) for pre-response rollback
        skipped_names = list(pre_skipped)  # AUDIT FIX H5/P5: every omission, whatever the reason
        used_names = set()                 # AUDIT FIX P4: no member may shadow another
        with zipfile.ZipFile(temp_zip_path, 'w', zipfile.ZIP_STORED) as zf:
            for file_path, zip_path, file_obj in files_to_zip:
                reserved = None
                entry_name = zip_path
                try:
                    # AUDIT FIX D7: keep the work dir provably alive while a long
                    # ZIP build is running.
                    touch_work_dir(temp_zip_dir)
                    reserved, skip_reason = _reserve_zip_download_slot(file_obj)
                    if not reserved:
                        skipped_names.append(_zip_skip_entry(zip_path, skip_reason))
                        continue
                    entry_name = _unique_zip_entry_name(zip_path, used_names)
                    if file_obj.is_e2e_encrypted:
                        zf.write(file_path, entry_name)
                        files_added += 1
                    else:
                        temp_decrypted_path = os.path.join(temp_zip_dir, f'dec_{files_added}')
                        with open(temp_decrypted_path, 'wb') as dec_f:
                            for chunk in decrypt_file_chunked(
                                file_path,
                                expected_size=file_obj.size,
                                expected_payload_checksum=file_obj.payload_checksum,
                                expected_disk_size=file_obj.disk_size,
                                file_id=file_obj.id,
                            ):
                                dec_f.write(chunk)
                        zf.write(temp_decrypted_path, entry_name)
                        files_added += 1
                        os.remove(temp_decrypted_path)
                    added_file_ids.append(file_obj.id)
                    added_reservations.append((file_obj.id, reserved))
                except Exception as e:
                    if reserved:
                        rollback_reserved_download(file_obj.id, reserved)
                    skipped_names.append(_zip_skip_entry(entry_name, 'DECRYPTION OR INTEGRITY FAILURE'))
                    print(f'[BROWSE DOWNLOAD] Error adding file {entry_name} to ZIP: {e}')
                    continue
            _write_zip_skip_manifest(zf, skipped_names, used_names)

        # AUDIT FIX H5: a ZIP where every file failed to decrypt/verify must not
        # be returned as a clean 200 -- surface a server error instead.
        if files_added == 0:
            raise RuntimeError('NO FILES COULD BE ADDED TO THE DOWNLOAD ARCHIVE')

        print(f'[BROWSE DOWNLOAD] Subfolder ZIP created with {files_added} files ({len(skipped_names)} skipped)')
        
        # Track subfolder + its sub-folder download counts (cascading)
        increment_folder_download_counts(subfolder.id)
        
        safe_name = secure_filename(subfolder.name)
        zip_filename = f'{safe_name}.zip'

        response = _build_zip_download_response(temp_zip_path, temp_zip_dir, zip_filename, added_file_ids,
                                                '[BROWSE DOWNLOAD]', incomplete_count=len(skipped_names),
                                                release_zip_reservation=zip_reservation)
        # Slot ownership now belongs to the response finalizer (AUDIT FIX P11).
        slot_handed_off = True
        return response
    except Exception as e:
        # AUDIT FIX (finding 1): a pre-response failure must give back every
        # member slot already reserved, or a max_downloads link burns slots
        # without ever delivering a ZIP. Members that failed mid-build were
        # already rolled back per-member and never enter added_reservations
        # (no double rollback); once slot_handed_off the stream finalizer
        # owns the slots and this block can no longer run.
        if not slot_handed_off:
            for _fid, _res in added_reservations:
                rollback_reserved_download(_fid, _res)
        try:
            shutil.rmtree(temp_zip_dir)
        except Exception:
            pass
        print(f'[BROWSE DOWNLOAD] Error creating subfolder ZIP: {e}')
        raise
    finally:
        if not slot_handed_off:
            _release_zip_slot(zip_reservation)

def _client_zip_file_fields(f, is_owner, share_token):
    """Key + name material the client ZIP builder needs to decrypt E2EE members."""
    extra = {}
    if f.is_e2e_encrypted:
        extra['download_url'] = f'/f/{f.id}/{f.orig_name}'
        if f.encrypted_name:
            extra['encrypted_name'] = f.encrypted_name
            extra['name_nonce'] = f.name_nonce
        if f.encrypted_file_key and is_owner:
            extra['encrypted_file_key'] = f.encrypted_file_key
            extra['file_key_nonce'] = f.file_key_nonce
        if f.link_encrypted_file_key:
            extra['link_encrypted_file_key'] = f.link_encrypted_file_key
            extra['link_file_key_nonce'] = f.link_file_key_nonce
        if getattr(f, 'folder_link_encrypted_file_key', None):
            extra['folder_link_encrypted_file_key'] = f.folder_link_encrypted_file_key
            extra['folder_link_file_key_nonce'] = f.folder_link_file_key_nonce
    else:
        extra['download_url'] = f'/f/{share_token}/file/{f.id}/{f.orig_name}'
    return extra


@app.route('/f/<share_token>/download-all')
@limiter.limit(download_rate_limit)
def browse_folder_download_all(share_token):
    """Download the entire shared root folder as a ZIP file (non-E2E files only)."""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return error

    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        ancestor = is_folder_in_browsable_ancestor(folder)
        if not ancestor:
            ancestor = is_folder_in_public_browsable_ancestor(folder)
        if not ancestor:
            abort(403)
        folder_is_browsable = True

    if request.method == 'HEAD':
        return _build_streaming_response(
            lambda: iter(()), 'application/zip', disposition='attachment',
            filename=f'{secure_filename(folder.name)}.zip')

    # Load the entire folder subtree in O(depth) queries rather than recursive per-folder calls
    subtree_ids = _collect_descendant_folder_ids([folder.id], include_roots=True)
    subtree_folders = Folder.query.filter(Folder.id.in_(list(subtree_ids)), Folder.is_trashed == False).all()
    children_map = {}
    for fld in subtree_folders:
        children_map.setdefault(fld.parent_id, []).append(fld)
    subtree_folder_map = {fld.id: fld for fld in subtree_folders}

    # Build per-folder path prefixes via BFS from the root.
    # AUDIT FIX P2: an expired sub-folder is never given a path prefix, so it and
    # everything beneath it drops out of the archive entirely.
    path_prefixes = {folder.id: ''}
    queue = [folder.id]
    while queue:
        pid = queue.pop(0)
        parent_prefix = path_prefixes[pid]
        for child in children_map.get(pid, []):
            if child.id not in path_prefixes and _folder_not_expired(child) and not _locked_folder_share(child, folder):
                path_prefixes[child.id] = os.path.join(parent_prefix, safe_zip_entry_name(child.name))
                queue.append(child.id)

    reachable_ids = list(path_prefixes.keys())
    all_files = File.query.filter(
        File.folder_id.in_(reachable_ids),
        File.is_temp_upload == False,
        File.is_trashed == False
    ).all()

    # AUDIT FIX P5: record pre-filter omissions (see browse_folder_download_subfolder).
    pre_skipped = []
    files_to_zip = []
    for file in all_files:
        # AUDIT FIX P1: never ZIP an expired file through a folder token.
        if not _file_not_expired(file):
            continue
        file_folder = subtree_folder_map.get(file.folder_id)
        if not is_owner and _e2e_upload_boundary_for_folder(file_folder) and not file.is_e2e_encrypted:
            continue
        if not file.is_public and file.registered_user_id and not folder.is_public and not folder_is_browsable:
            if not is_owner:
                continue
        if file.password_hash:
            continue
        if file.is_e2e_encrypted and not is_owner and not _e2e_file_has_non_owner_key(file):
            continue
        zip_path = os.path.join(path_prefixes.get(file.folder_id, ''), safe_zip_entry_name(file.orig_name))
        if file.max_downloads and (file.download_count or 0) >= file.max_downloads:
            pre_skipped.append(_zip_skip_entry(zip_path, 'DOWNLOAD LIMIT REACHED'))
            continue
        if _zip_skip_if_e2e(file, zip_path, pre_skipped):
            continue
        file_path = storage.get_file_path(file.filename)
        if file_path and os.path.exists(file_path):
            files_to_zip.append((file_path, zip_path, file))
        else:
            pre_skipped.append(_zip_skip_entry(zip_path, 'PAYLOAD NOT AVAILABLE'))
    print(f'[BROWSE DOWNLOAD] Download-all ZIP: {len(files_to_zip)} files in folder {_log_safe(folder.name)} '
          f'({len(pre_skipped)} pre-skipped)')

    if not files_to_zip:
        return jsonify({'error': 'FOLDER IS EMPTY'}), 404

    # AUDIT FIX M2: enforce per-ZIP and concurrent-ZIP caps to bound
    # anonymous DoS via public folder downloads.
    ok, err_resp = _enforce_zip_limits(files_to_zip)
    if not ok:
        return err_resp
    # AUDIT FIX P11: reserve the estimated disk footprint with the slot.
    zip_estimate = _zip_build_estimate_bytes(files_to_zip)
    zip_reservation, err_resp = _acquire_zip_slot(zip_estimate)
    if not zip_reservation:
        return err_resp

    try:
        temp_zip_dir = create_work_dir('browse_all_dl_')
    except Exception:
        _release_zip_slot(zip_reservation)
        raise
    temp_zip_path = os.path.join(temp_zip_dir, 'folder.zip')
    slot_handed_off = False

    try:
        files_added = 0
        added_file_ids = []
        added_reservations = []  # AUDIT FIX (finding 1): (id, reservation) for pre-response rollback
        skipped_names = list(pre_skipped)  # AUDIT FIX H5/P5: every omission, whatever the reason
        used_names = set()                 # AUDIT FIX P4: no member may shadow another
        # AUDIT FIX M2: ZIP_STORED instead of ZIP_DEFLATED — the data is
        # already encrypted/random so compression yields ~0%; switching to
        # STORED cuts CPU substantially under load.
        with zipfile.ZipFile(temp_zip_path, 'w', zipfile.ZIP_STORED) as zf:
            for file_path, zip_path, file_obj in files_to_zip:
                reserved = None
                entry_name = zip_path
                try:
                    # AUDIT FIX D7: keep the work dir provably alive while a long
                    # ZIP build is running.
                    touch_work_dir(temp_zip_dir)
                    reserved, skip_reason = _reserve_zip_download_slot(file_obj)
                    if not reserved:
                        skipped_names.append(_zip_skip_entry(zip_path, skip_reason))
                        continue
                    entry_name = _unique_zip_entry_name(zip_path, used_names)
                    if file_obj.is_e2e_encrypted:
                        zf.write(file_path, entry_name)
                        files_added += 1
                    else:
                        temp_decrypted_path = os.path.join(temp_zip_dir, f'dec_{files_added}')
                        with open(temp_decrypted_path, 'wb') as dec_f:
                            for chunk in decrypt_file_chunked(
                                file_path,
                                expected_size=file_obj.size,
                                expected_payload_checksum=file_obj.payload_checksum,
                                expected_disk_size=file_obj.disk_size,
                                file_id=file_obj.id,
                            ):
                                dec_f.write(chunk)
                        zf.write(temp_decrypted_path, entry_name)
                        files_added += 1
                        os.remove(temp_decrypted_path)
                    added_file_ids.append(file_obj.id)
                    added_reservations.append((file_obj.id, reserved))
                except Exception as e:
                    if reserved:
                        rollback_reserved_download(file_obj.id, reserved)
                    skipped_names.append(_zip_skip_entry(entry_name, 'DECRYPTION OR INTEGRITY FAILURE'))
                    print(f'[BROWSE DOWNLOAD] Error adding file {entry_name} to ZIP: {e}')
                    continue
            _write_zip_skip_manifest(zf, skipped_names, used_names)

        # AUDIT FIX H5: a ZIP where every file failed to decrypt/verify must not
        # be returned as a clean 200 -- surface a server error instead.
        if files_added == 0:
            raise RuntimeError('NO FILES COULD BE ADDED TO THE DOWNLOAD ARCHIVE')

        print(f'[BROWSE DOWNLOAD] Download-all ZIP created with {files_added} files ({len(skipped_names)} skipped)')
        
        # Track folder + sub-folder download counts (cascading)
        increment_folder_download_counts(folder.id)
        
        safe_name = secure_filename(folder.name)
        zip_filename = f'{safe_name}.zip'

        response = _build_zip_download_response(temp_zip_path, temp_zip_dir, zip_filename, added_file_ids,
                                                '[BROWSE DOWNLOAD]', incomplete_count=len(skipped_names),
                                                release_zip_reservation=zip_reservation)
        # Slot ownership now belongs to the response finalizer (AUDIT FIX P11).
        slot_handed_off = True
        return response
    except Exception as e:
        # AUDIT FIX (finding 1): release member slots reserved by this
        # build -- see browse_folder_download_subfolder. Failed members were
        # already rolled back per-member; hand-off hands slots to the finalizer.
        if not slot_handed_off:
            for _fid, _res in added_reservations:
                rollback_reserved_download(_fid, _res)
        try:
            shutil.rmtree(temp_zip_dir)
        except Exception:
            pass
        print(f'[BROWSE DOWNLOAD] Error creating download-all ZIP: {e}')
        abort(500)
    finally:
        if not slot_handed_off:
            _release_zip_slot(zip_reservation)

@app.route('/f/<share_token>/track-folder-download', methods=['POST'])
@limiter.limit("30 per minute")
@csrf.exempt
def browse_track_folder_download(share_token):
    """Increment download counts for a folder downloaded client-side (E2E decrypt+ZIP).
    Called by the browse page after a client-side ZIP build completes.

    AUDIT FIX P12: this route was @csrf.exempt, required only check_folder_access
    (no browsable check, unlike every sibling route), accepted an arbitrary
    in-tree subfolder_id and called increment_folder_download_counts(), which
    bumps download_count for the folder AND every non-trashed descendant. At
    30 req/min an anonymous visitor could arbitrarily corrupt the owner's
    analytics with no correlation to an actual download. It now (a) requires the
    same browsable access level as its siblings, (b) enforces sub-folder trash +
    expiry like the other sub-folder routes, and (c) requires the single-use
    download ticket handed out by /all-files or /folder/<id>/files -- so an
    increment must be preceded by a real listing for that exact folder and can
    only be redeemed once."""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return jsonify({'error': 'NOT FOUND'}), 404

    # AUDIT FIX P12: same access level as every sibling route.
    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        ancestor = is_folder_in_browsable_ancestor(folder)
        if not ancestor:
            ancestor = is_folder_in_public_browsable_ancestor(folder)
        if not ancestor:
            return jsonify({'error': 'NOT BROWSABLE'}), 403

    data = _json_object_body()
    subfolder_id = data.get('subfolder_id')
    ticket = data.get('download_ticket')

    target_id = folder.id
    target_name = folder.name
    if subfolder_id:
        try:
            subfolder_id = int(subfolder_id)
        except (ValueError, TypeError):
            return jsonify({'error': 'INVALID SUBFOLDER ID'}), 400
        # AUDIT FIX P2: trash AND expiry, not just containment.
        subfolder = _shared_subfolder_available(subfolder_id, folder)
        if not subfolder:
            return jsonify({'error': 'NOT FOUND'}), 404
        target_id = subfolder.id
        target_name = subfolder.name

    if not _consume_folder_download_ticket(ticket, share_token, target_id):
        print(f'[WARNING] Rejected untracked folder-download report for folder {target_id} '
              f'(share {share_token}): missing or invalid download ticket')
        return jsonify({'error': 'DOWNLOAD TICKET REQUIRED'}), 400

    increment_folder_download_counts(target_id)
    print(f'[BROWSE DOWNLOAD] Tracked client-side folder download: {_log_safe(target_name)} (id={target_id})')

    return jsonify({'ok': True})

@app.route('/f/<share_token>/download-selected', methods=['POST'])
@limiter.limit(download_rate_limit)
@csrf.exempt
def browse_folder_download_selected(share_token):
    """Download selected files from a browsable folder as a ZIP"""
    # AUDIT FIX (finding 12): this route is @csrf.exempt (browser form POST
    # + curl/CLI parity) AND reserves max_downloads member slots, so a
    # cross-site page could forge the POST and burn a limited link's slots
    # without delivering anything. Same origin/Sec-Fetch-Site validation the
    # cookie-authenticated csrf-exempt manage/delete routes already use:
    # same-origin browser POSTs and header-less non-browser clients pass,
    # cross-site browser POSTs are blocked. (A single-use listing ticket like
    # /track-folder-download would additionally require the frontend form in
    # static/browse.js to carry the token, which is outside this change.)
    if _browser_cross_site_post_blocked():
        print('[BROWSE DOWNLOAD] Blocked cross-site browser POST to download-selected (origin check)')
        abort(403)
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return error
    
    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        ancestor = is_folder_in_browsable_ancestor(folder)
        if not ancestor:
            ancestor = is_folder_in_public_browsable_ancestor(folder)
        if not ancestor:
            abort(403)
        # AUDIT FIX P7: unlike its four sibling routes this block never set the
        # flag after successfully locating a browsable ancestor. The stale False
        # then flowed into collect_browsable_files() and the per-file filter
        # below, so for a share reached THROUGH an ancestor every non-is_public
        # file that browse-data happily listed was excluded -- the visitor picked
        # N files and got an archive missing them (or 'NO VALID FILES SELECTED').
        folder_is_browsable = True
    
    file_ids = request.form.getlist('file_ids')
    folder_ids = request.form.getlist('folder_ids')
    if not file_ids and not folder_ids:
        flash('NO FILES SELECTED', 'error')
        return redirect(f'/f/{share_token}')
    
    # AUDIT FIX P5: record pre-filter omissions (see browse_folder_download_subfolder).
    pre_skipped = []

    # Verify all requested files belong to this folder tree
    allowed_files = collect_browsable_files(folder.id, is_owner, folder.is_public or folder.is_browsable or folder_is_browsable, bool(folder.is_link_shared))
    allowed_map = {f.id: f for f in allowed_files}
    
    files_to_download = []
    for fid in file_ids:
        if fid in allowed_map:
            file = allowed_map[fid]
            entry = safe_zip_entry_name(file.orig_name)
            if file.max_downloads and (file.download_count or 0) >= file.max_downloads:
                pre_skipped.append(_zip_skip_entry(entry, 'DOWNLOAD LIMIT REACHED'))
                continue
            if _zip_skip_if_e2e(file, entry, pre_skipped):
                continue
            file_path = storage.get_file_path(file.filename)
            if file_path and os.path.exists(file_path):
                files_to_download.append((file_path, entry, file))
            else:
                pre_skipped.append(_zip_skip_entry(entry, 'PAYLOAD NOT AVAILABLE'))
    
    # Collect files from selected folders recursively.
    # Bulk-load the subtree + files up front, then walk in-memory in the same
    # DFS order as the old recursive version (2 queries per folder -> 2 per
    # selected folder).
    def collect_folder_files_for_zip(root_id, path_prefix=''):
        result = []
        root_obj = db.session.get(Folder, root_id)
        if not root_obj or root_obj.is_trashed:
            return result
        subtree_ids = _collect_descendant_folder_ids([root_id], include_roots=True)
        subtree_folders = Folder.query.filter(Folder.id.in_(list(subtree_ids)), Folder.is_trashed == False).all()
        children_map = {}
        for fld in subtree_folders:
            children_map.setdefault(fld.parent_id, []).append(fld)
        files_by_folder = {}
        for f in File.query.filter(
            File.folder_id.in_(list(subtree_ids)),
            File.is_temp_upload == False,
            File.is_trashed == False
        ).all():
            files_by_folder.setdefault(f.folder_id, []).append(f)

        def _walk(fld_obj, prefix):
            fld_e2e_boundary = _e2e_upload_boundary_for_folder(fld_obj)
            for f in files_by_folder.get(fld_obj.id, []):
                # AUDIT FIX P1: never ZIP an expired file through a folder token.
                if not _file_not_expired(f):
                    continue
                if not is_owner and fld_e2e_boundary and not f.is_e2e_encrypted:
                    continue
                if not f.is_public and f.registered_user_id and not folder.is_public and not folder_is_browsable:
                    if not is_owner:
                        continue
                if f.password_hash:
                    continue
                # Hide E2EE files without link/passphrase-scoped keys from non-owners.
                if f.is_e2e_encrypted and not is_owner and not _e2e_file_has_non_owner_key(f):
                    continue
                zip_path = os.path.join(prefix, safe_zip_entry_name(f.orig_name))
                # Skip files that have exhausted their max_downloads limit
                if f.max_downloads and (f.download_count or 0) >= f.max_downloads:
                    pre_skipped.append(_zip_skip_entry(zip_path, 'DOWNLOAD LIMIT REACHED'))
                    continue
                if _zip_skip_if_e2e(f, zip_path, pre_skipped):
                    continue
                fp = storage.get_file_path(f.filename)
                if fp and os.path.exists(fp):
                    result.append((fp, zip_path, f))
                else:
                    pre_skipped.append(_zip_skip_entry(zip_path, 'PAYLOAD NOT AVAILABLE'))
            for sf in children_map.get(fld_obj.id, []):
                # AUDIT FIX P2: an expired sub-folder cuts off everything below it.
                if not _folder_not_expired(sf) or _locked_folder_share(sf, folder):
                    continue
                sf_path = os.path.join(prefix, safe_zip_entry_name(sf.name))
                _walk(sf, sf_path)

        _walk(root_obj, path_prefix)
        return result
    
    for fid in dict.fromkeys(folder_ids):
        try:
            fid_int = int(fid)
        except (ValueError, TypeError):
            continue
        # AUDIT FIX P2: trash AND expiry on the selected sub-folder and every
        # folder between it and the share root.
        subfolder_obj = _shared_subfolder_available(fid_int, folder)
        if not subfolder_obj:
            continue
        folder_files = collect_folder_files_for_zip(fid_int, safe_zip_entry_name(subfolder_obj.name))
        files_to_download.extend(folder_files)

    # One member (and one download-limit reservation) per physical file, even
    # when it was selected twice or both directly and through its folder.
    _deduped, _seen_file_ids = [], set()
    for item in files_to_download:
        if item[2].id not in _seen_file_ids:
            _seen_file_ids.add(item[2].id)
            _deduped.append(item)
    files_to_download = _deduped
    
    if not files_to_download:
        flash('NO VALID FILES SELECTED', 'error')
        return redirect(f'/f/{share_token}')
    
    print(f'[BROWSE DOWNLOAD] Creating ZIP with {len(files_to_download)} selected files/folders from folder: {_log_safe(folder.name)}')

    # AUDIT FIX M2: bound ZIP work — count, bytes, concurrent jobs.
    ok, err_resp = _enforce_zip_limits(files_to_download)
    if not ok:
        return err_resp
    # AUDIT FIX P11: reserve the estimated disk footprint with the slot.
    zip_estimate = _zip_build_estimate_bytes(files_to_download)
    zip_reservation, err_resp = _acquire_zip_slot(zip_estimate)
    if not zip_reservation:
        return err_resp

    try:
        temp_zip_dir = create_work_dir('browse_zip_')
    except Exception:
        _release_zip_slot(zip_reservation)
        raise
    temp_zip_path = os.path.join(temp_zip_dir, 'selected.zip')
    slot_handed_off = False
    
    try:
        files_added = 0
        added_file_ids = []
        added_reservations = []  # AUDIT FIX (finding 1): (id, reservation) for pre-response rollback
        skipped_names = list(pre_skipped)  # AUDIT FIX H5/P5: every omission, whatever the reason
        used_names = set()                 # AUDIT FIX P4: no member may shadow another
        with zipfile.ZipFile(temp_zip_path, 'w', zipfile.ZIP_STORED) as zf:
            for file_path, orig_name, file_obj in files_to_download:
                reserved = None
                entry_name = orig_name
                try:
                    # AUDIT FIX D7: keep the work dir provably alive while a long
                    # ZIP build is running.
                    touch_work_dir(temp_zip_dir)
                    reserved, skip_reason = _reserve_zip_download_slot(file_obj)
                    if not reserved:
                        skipped_names.append(_zip_skip_entry(orig_name, skip_reason))
                        continue
                    entry_name = _unique_zip_entry_name(orig_name, used_names)
                    if file_obj.is_e2e_encrypted:
                        zf.write(file_path, entry_name)
                    else:
                        temp_dec = os.path.join(temp_zip_dir, f'dec_{files_added}')
                        with open(temp_dec, 'wb') as f:
                            for chunk in decrypt_file_chunked(
                                file_path,
                                expected_size=file_obj.size,
                                expected_payload_checksum=file_obj.payload_checksum,
                                expected_disk_size=file_obj.disk_size,
                                file_id=file_obj.id,
                            ):
                                f.write(chunk)
                        zf.write(temp_dec, entry_name)
                        os.remove(temp_dec)
                    files_added += 1
                    added_file_ids.append(file_obj.id)
                    added_reservations.append((file_obj.id, reserved))
                except Exception as e:
                    if reserved:
                        rollback_reserved_download(file_obj.id, reserved)
                    skipped_names.append(_zip_skip_entry(entry_name, 'DECRYPTION OR INTEGRITY FAILURE'))
                    print(f'[BROWSE DOWNLOAD] Error adding {entry_name}: {e}')
                    continue
            _write_zip_skip_manifest(zf, skipped_names, used_names)

        # AUDIT FIX H5: do not return a ZIP with zero real files as a clean 200.
        if files_added == 0:
            raise RuntimeError('NO FILES COULD BE ADDED TO THE DOWNLOAD ARCHIVE')
        
        # Track download counts: increment root folder + cascade each selected sub-folder
        try:
            # AUDIT FIX D8: atomic SQL increment (was a Python read-modify-write
            # that lost concurrent updates).
            Folder.query.filter(Folder.id == folder.id).update(
                {Folder.download_count: db.func.coalesce(Folder.download_count, 0) + 1},
                synchronize_session=False
            )
            db.session.commit()
            print(f'[BROWSE DOWNLOAD] Incremented download count for root folder {folder.id} to {folder.download_count}')
        except Exception as e:
            db.session.rollback()
            print(f'[BROWSE DOWNLOAD] Warning: Failed to increment root folder download count: {e}')
        counted_folder_ids = set()
        for fid in folder_ids:
            try:
                fid_int = int(fid)
            except (ValueError, TypeError):
                continue
            if fid_int in counted_folder_ids:
                continue
            counted_folder_ids.add(fid_int)
            # AUDIT FIX P2: only count folders that were actually downloadable.
            if _shared_subfolder_available(fid_int, folder):
                increment_folder_download_counts(fid_int)
        
        safe_name = secure_filename(folder.name)
        response = _build_zip_download_response(temp_zip_path, temp_zip_dir, f'{safe_name}_selected.zip',
                                                added_file_ids, '[BROWSE DOWNLOAD]',
                                                incomplete_count=len(skipped_names),
                                                release_zip_reservation=zip_reservation)
        # Slot ownership now belongs to the response finalizer (AUDIT FIX P11).
        slot_handed_off = True
        return response
    except Exception as e:
        # AUDIT FIX (finding 1): release member slots reserved by this
        # build -- see browse_folder_download_subfolder. Failed members were
        # already rolled back per-member; hand-off hands slots to the finalizer.
        if not slot_handed_off:
            for _fid, _res in added_reservations:
                rollback_reserved_download(_fid, _res)
        try:
            shutil.rmtree(temp_zip_dir)
        except Exception:
            pass
        print(f'[BROWSE DOWNLOAD] ZIP error: {e}')
        abort(500)
    finally:
        if not slot_handed_off:
            _release_zip_slot(zip_reservation)
