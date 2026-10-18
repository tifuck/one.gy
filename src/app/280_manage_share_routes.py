from functools import lru_cache

@lru_cache(maxsize=256)
def _qr_data_uri_for_share_url(share_url):
    """Base64 PNG QR code for a share URL, LRU-cached (the QR is a deterministic
    pure function of the URL, and the URL is stable per file, so regenerating it
    on every manage-page render was wasted CPU). SHARE URLS ONLY — the 2FA setup
    QR embeds a per-call TOTP secret and must NEVER go through a cache."""
    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(share_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    bio = io.BytesIO()
    img.save(bio, 'PNG')
    return base64.b64encode(bio.getvalue()).decode('utf-8')

@app.route('/manage/<token>')
@limiter.limit(file_ops_rate_limit)
def manage(token):
    file = File.query.filter_by(management_token=token).first_or_404()
    # Allow access if guest session matches OR cookie matches OR if logged-in user owns the file OR if admin
    guest_ok = file.registered_user_id is None and session.get('user_id') and session['user_id'] == file.user_id
    cookie_ok = file.registered_user_id is None and bool(file.manager_cookie_id) and hmac.compare_digest(request.cookies.get('onegy_manager') or '', file.manager_cookie_id or '')
    # AUDIT FIX H4: resolve the session user through the epoch-validating helper so
    # a revoked/stale cookie cannot claim ownership or admin here.
    requesting_user = _current_session_user()
    registered_ok = bool(requesting_user) and file.registered_user_id == requesting_user.id
    admin_ok = bool(requesting_user) and bool(requesting_user.is_admin)
    if not (guest_ok or cookie_ok or registered_ok or admin_ok):
        abort(403)

    # AUDIT FIX P15: file_manage_data_by_token() blocks a trashed file with a 404
    # but this page did not, so a token holder could render the manage page for a
    # trashed file (and POST public=on / expires / max_downloads against it),
    # mutating share state on an object the owner believes is deleted and which
    # the retention job will reap. Refuse it consistently.
    if file.is_trashed:
        print(f'[TRASH] Blocked manage page for trashed file: {file.orig_name}')
        abort(404)

    from datetime import datetime
    
    # Get source parameter to determine where to redirect back to
    source = request.args.get('source', '')
    
    selected_expire = None
    expires_at_aware = file.get_expires_at_aware()
    if expires_at_aware is None:
        # No expiration set - infinite retention
        selected_expire = 'never'
    elif expires_at_aware:
        remaining_seconds = (expires_at_aware - datetime.now(timezone.utc)).total_seconds()
        if abs(remaining_seconds - 1800) < 300:
            selected_expire = '30m'
        elif abs(remaining_seconds - 21600) < 1800:
            selected_expire = '6h'
        elif abs(remaining_seconds - 86400) < 7200:
            selected_expire = '1d'
        elif abs(remaining_seconds - 259200) < 21600:
            selected_expire = '3d'
        elif abs(remaining_seconds - 604800) < 43200:
            selected_expire = '7d'
    
    # Use configured domain for share URLs (always use long /f/ format)
    share_url = f'https://{domain}/f/{file.id}/{urllib.parse.quote(file.orig_name)}'
    qr_data = _qr_data_uri_for_share_url(share_url)
    # Check if file inherits public/browsable status from a parent folder
    inherited_public = is_file_in_public_folder(file) if not file.is_e2e_encrypted else None
    parent_is_browsable = is_file_in_browsable_folder(file) is not None
    # Back destination is computed here (not in the template) because Jinja
    # {% set %} is block-scoped: a value set inside {% block content %} is
    # Undefined inside {% block scripts %}, and |tojson on Undefined is a 500.
    if source == 'admin':
        back_url, back_label = url_for('admin'), 'Back to admin'
    elif source == 'temp' or file.is_temp_upload:
        back_url = url_for('share') if get_setting('allow_temp_uploads') else url_for('index')
        back_label = 'Back to quick share'
    elif session.get('logged_in_user_id'):
        back_url = url_for('files', folder_id=file.folder_id) if file.folder_id else url_for('files')
        back_label = 'Back to files'
    else:
        back_url, back_label = url_for('index'), 'Go home'

    return render_template('manage.html', is_folder=False, back_url=back_url, back_label=back_label, file=file, selected_expire=selected_expire, share_url=share_url, qr_data=qr_data, source=source, inherited_public=inherited_public, parent_is_browsable=parent_is_browsable)

@app.route('/manage/<token>', methods=['POST'])
@csrf.exempt
@limiter.limit(file_ops_rate_limit)
def manage_post(token):
    # AUDIT FIX: guest ownership here is proven by cookies (session user_id /
    # onegy_manager), and the route is @csrf.exempt for token-holders using
    # curl. The flask_wtf check below only runs for logged-in sessions, leaving
    # guest cookie auth without CSRF validation; the same browser origin check
    # as /upload closes that without breaking non-browser clients.
    if _browser_cross_site_post_blocked():
        print('[FILE] Blocked cross-site browser POST to manage endpoint (origin check)')
        abort(403)
    file = File.query.filter_by(management_token=token).first_or_404()
    guest_ok = file.registered_user_id is None and session.get('user_id') and session['user_id'] == file.user_id
    cookie_ok = file.registered_user_id is None and bool(file.manager_cookie_id) and hmac.compare_digest(request.cookies.get('onegy_manager') or '', file.manager_cookie_id or '')
    # AUDIT FIX H4: resolve the session user through the epoch-validating helper so
    # a revoked/stale cookie cannot claim ownership or admin here.
    requesting_user = _current_session_user()
    registered_ok = bool(requesting_user) and file.registered_user_id == requesting_user.id
    admin_ok = bool(requesting_user) and bool(requesting_user.is_admin)
    if not (guest_ok or cookie_ok or registered_ok or admin_ok):
        abort(403)
    if session.get('logged_in_user_id'):
        from flask_wtf.csrf import validate_csrf as _validate_csrf_manage
        _csrf_token = (request.form.get('csrf_token')
                       or request.headers.get('X-CSRFToken')
                       or request.headers.get('X-CSRF-Token'))
        try:
            _validate_csrf_manage(_csrf_token)
        except Exception:
            abort(400)

    lifecycle_lock = _acquire_file_lifecycle_lock(file)
    try:
        db.session.rollback()
        file = File.query.filter_by(management_token=token).first_or_404()
        # AUDIT FIX P15: never mutate share state (public / expires / max_downloads)
        # on a file the owner has already sent to trash.
        if file.is_trashed:
            print(f'[TRASH] Blocked manage POST for trashed file: {file.orig_name}')
            abort(404)

        expires = request.form.get('expires')

        # Only update public if the public field was explicitly submitted
        if 'public' in request.form:
            is_public = request.form.get('public') == 'on'
            file.is_public = is_public
            # Clear E2E link keys when shareable is turned OFF so that
            # toggling off then back on generates a fresh share URL
            if not is_public and file.is_e2e_encrypted:
                file.link_encrypted_file_key = None
                file.link_file_key_nonce = None
                file.link_secret = None
                file.is_link_shared = False

        if expires:
            now = datetime.now(timezone.utc)
            if expires == '30m':
                file.expires_at = now + timedelta(minutes=30)
            elif expires == '6h':
                file.expires_at = now + timedelta(hours=6)
            elif expires == '1d':
                file.expires_at = now + timedelta(days=1)
            elif expires == '3d':
                file.expires_at = now + timedelta(days=3)
            elif expires == '7d':
                file.expires_at = now + timedelta(days=7)
            elif expires == 'never':
                if file.is_temp_upload:
                    file.expires_at = now + timedelta(days=7)
                elif 'logged_in_user_id' in session and file.registered_user_id:
                    file.expires_at = None
                else:
                    file.expires_at = now + timedelta(days=7)

        max_downloads_str = request.form.get('max_downloads')
        if max_downloads_str:
            try:
                max_dl = int(max_downloads_str)
                # AUDIT FIX (finding 17): bound the value before it reaches an
                # INTEGER column -- an arbitrarily large int (e.g. 10**15)
                # passed the old `> 0` check and made the COMMIT fail with a
                # MySQL out-of-range error -> 500 after partial mutation.
                # Values beyond 1e6 are clamped; negatives stay ignored (same
                # as before) and 0 still means "unlimited".
                if max_dl > 0:
                    file.max_downloads = min(max_dl, 1000000)
                elif max_dl == 0:
                    file.max_downloads = None
            except (ValueError, TypeError):
                pass

        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return jsonify({
            'success': True,
            'has_password': file.password_hash is not None
        })
    
    flash('SETTINGS UPDATED', 'success')
    return redirect(url_for('manage', token=token))

@app.route('/delete/<token>', methods=['POST'])
@csrf.exempt
@limiter.limit(file_ops_rate_limit)
def delete_file(token):
    # AUDIT FIX: same cookie-auth + csrf.exempt situation as manage_post —
    # validate the browser's origin so guest (cookie-owned) deletes get CSRF
    # protection while curl/CLI callers (no Origin, no Sec-Fetch-Site) pass.
    if _browser_cross_site_post_blocked():
        print('[FILE] Blocked cross-site browser POST to delete endpoint (origin check)')
        abort(403)
    file = File.query.filter_by(management_token=token).first_or_404()
    guest_ok = file.registered_user_id is None and session.get('user_id') and session['user_id'] == file.user_id
    cookie_ok = file.registered_user_id is None and bool(file.manager_cookie_id) and hmac.compare_digest(request.cookies.get('onegy_manager') or '', file.manager_cookie_id or '')
    # AUDIT FIX H4: resolve the session user through the epoch-validating helper so
    # a revoked/stale cookie cannot claim ownership or admin here.
    requesting_user = _current_session_user()
    registered_ok = bool(requesting_user) and file.registered_user_id == requesting_user.id
    admin_ok = bool(requesting_user) and bool(requesting_user.is_admin)
    if not (guest_ok or cookie_ok or registered_ok or admin_ok):
        abort(403)
    if session.get('logged_in_user_id'):
        from flask_wtf.csrf import validate_csrf as _validate_csrf_del
        _csrf_token = (request.form.get('csrf_token')
                       or request.headers.get('X-CSRFToken')
                       or request.headers.get('X-CSRF-Token'))
        try:
            _validate_csrf_del(_csrf_token)
        except Exception:
            abort(400)
    
    # Get source parameter to determine where to redirect
    source = request.form.get('source', request.args.get('source', ''))
    
    lifecycle_lock = _acquire_file_lifecycle_lock(file)
    try:
        db.session.rollback()
        file = File.query.filter_by(management_token=token).first_or_404()
        file_name = file.orig_name
        file_size = file.size
        file_is_temp_upload = file.is_temp_upload
        file_registered_user_id = file.registered_user_id
        paths_to_delete = _file_payload_delete_keys(file)

        # Stage remote-delete intent with the metadata deletion.
        local_targets = storage.stage_payload_deletes(paths_to_delete)
        db.session.delete(file)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    storage.purge_staged_locals(local_targets)
    print(f'[DELETE] Deleted file: {file_name}')
    
    check_storage()
    
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return jsonify({'success': True})
    
    # Redirect based on source
    if source == 'admin':
        return redirect(url_for('admin'))
    elif source == 'temp':
        return redirect(url_for('share'))
    elif file_is_temp_upload:
        # Temp uploads always redirect to share page
        return redirect(url_for('share'))
    elif 'logged_in_user_id' in session and file_registered_user_id:
        return redirect(url_for('files'))
    else:
        return redirect(url_for('share'))

@app.route('/f/<share_token>/browse-data')
@limiter.limit(default_rate_limit)
def browse_folder_json(share_token):
    """JSON endpoint for SPA subfolder navigation in browsable shared folders."""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return jsonify({'error': 'ACCESS DENIED'}), 403
    
    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        ancestor = is_folder_in_browsable_ancestor(folder)
        if not ancestor:
            ancestor = is_folder_in_public_browsable_ancestor(folder)
        if ancestor:
            folder_is_browsable = True
    if not folder_is_browsable:
        return jsonify({'error': 'FOLDER NOT BROWSABLE'}), 403
    
    subfolder_id = request.args.get('folder')
    browse_folder_id = folder.id
    current_browse_folder = folder
    breadcrumbs = []
    
    if subfolder_id:
        try:
            subfolder_id = int(subfolder_id)
        except (ValueError, TypeError):
            return jsonify({'error': 'INVALID FOLDER ID'}), 400
        # AUDIT FIX P2: enforce sub-folder trash AND expiry (and that of every
        # folder up to the share root), not just containment.
        subfolder = _shared_subfolder_available(subfolder_id, folder)
        if not subfolder:
            return jsonify({'error': 'FOLDER NOT FOUND'}), 404
        browse_folder_id = subfolder.id
        current_browse_folder = subfolder
        breadcrumbs = build_browse_breadcrumbs(subfolder.id, folder)
    
    # Get files in current folder level
    current_files = File.query.filter_by(
        folder_id=browse_folder_id, is_temp_upload=False, is_trashed=False
    ).all()
    
    current_e2e_boundary = _e2e_upload_boundary_for_folder(current_browse_folder)
    visible_files = []
    for file in current_files:
        # AUDIT FIX P1: an expired file must not be listed through a folder token.
        if not _file_not_expired(file):
            continue
        if not is_owner and current_e2e_boundary and not file.is_e2e_encrypted:
            continue
        if not file.is_public and file.registered_user_id and not folder_is_browsable:
            if not is_owner:
                continue
        if file.password_hash:
            continue
        if file.is_e2e_encrypted and not is_owner and not _e2e_file_has_non_owner_key(file):
            continue
        visible_files.append(file)
    
    # Get subfolders in current level
    # AUDIT FIX P2: drop expired sub-folders from the listing so they are not
    # offered for browsing or ZIP download through the parent's token.
    current_subfolders = [
        sf for sf in Folder.query.filter_by(
            parent_id=browse_folder_id, is_trashed=False
        ).order_by(Folder.name).all()
        if _folder_not_expired(sf) and not _locked_folder_share(sf, folder)
    ]
    
    # Collect ALL subfolders recursively (for sidebar tree)
    all_subfolders = collect_browsable_folders(folder.id)
    all_files = collect_browsable_files(folder.id, is_owner, folder.is_public or folder_is_browsable, bool(folder.is_link_shared))
    
    # Build folder sizes, E2E counts, file counts, and mixed-status detection
    direct_sizes = {}
    direct_e2e = {}
    direct_file_counts = {}
    for f in all_files:
        fid = f.folder_id
        direct_sizes[fid] = direct_sizes.get(fid, 0) + (f.size or 0)
        direct_file_counts[fid] = direct_file_counts.get(fid, 0) + 1
        if f.is_e2e_encrypted:
            direct_e2e[fid] = direct_e2e.get(fid, 0) + 1
    children_map = {}
    for sf in all_subfolders:
        children_map.setdefault(sf.parent_id, []).append(sf.id)
    folder_sizes = {}
    def calc_browse_size(fld_id):
        if fld_id in folder_sizes:
            return folder_sizes[fld_id]
        total = direct_sizes.get(fld_id, 0)
        for child_id in children_map.get(fld_id, []):
            total += calc_browse_size(child_id)
        folder_sizes[fld_id] = total
        return total
    for sf in all_subfolders:
        calc_browse_size(sf.id)
    calc_browse_size(folder.id)
    
    # Recursive E2E and file counts (matching dashboard /files/list logic)
    browse_e2e_counts = {}
    browse_file_counts = {}
    def calc_browse_e2e(fld_id):
        if fld_id in browse_e2e_counts:
            return browse_e2e_counts[fld_id]
        total = direct_e2e.get(fld_id, 0)
        for child_id in children_map.get(fld_id, []):
            total += calc_browse_e2e(child_id)
        browse_e2e_counts[fld_id] = total
        return total
    def calc_browse_file_count(fld_id):
        if fld_id in browse_file_counts:
            return browse_file_counts[fld_id]
        total = direct_file_counts.get(fld_id, 0)
        for child_id in children_map.get(fld_id, []):
            total += calc_browse_file_count(child_id)
        browse_file_counts[fld_id] = total
        return total
    for sf in all_subfolders:
        calc_browse_e2e(sf.id)
        calc_browse_file_count(sf.id)
    calc_browse_e2e(folder.id)
    calc_browse_file_count(folder.id)
    
    # Mixed E2E detection (matching dashboard logic)
    browse_folder_e2e_flag = {sf.id: (sf.is_e2e is True) for sf in all_subfolders}
    browse_folder_e2e_flag[folder.id] = folder.is_e2e is True
    browse_has_mixed = {}
    def calc_browse_has_mixed(fld_id):
        if fld_id in browse_has_mixed:
            return browse_has_mixed[fld_id]
        parent_e2e = browse_folder_e2e_flag.get(fld_id, True)
        mixed = False
        for child_id in children_map.get(fld_id, []):
            if browse_folder_e2e_flag.get(child_id, True) != parent_e2e:
                mixed = True
                break
            if calc_browse_has_mixed(child_id):
                mixed = True
                break
        browse_has_mixed[fld_id] = mixed
        return mixed
    for sf in all_subfolders:
        calc_browse_has_mixed(sf.id)
    calc_browse_has_mixed(folder.id)
    
    # Serialize
    previewable_ext = ['jpg','jpeg','png','gif','bmp','svg','webp','mp4','webm','ogg','mov','m4v','mkv','mp3','wav','ogg','m4a','aac','flac','txt','md','log','csv','json','xml','yaml','yml','py','js','html','css','sh','ini','cfg','conf','c','cpp','h','hpp','lua','rb','rs','go','java','ts','tsx','jsx','toml','bat','ps1','sql','r','swift','kt','php','pl','diff','makefile','pdf']
    previewable_audio = ['mp3','wav','ogg','m4a','aac','flac']
    previewable_images = ['jpg','jpeg','png','gif','bmp','svg','webp']
    previewable_video = ['mp4','webm','ogg','mov','m4v','mkv']
    previewable_text = ['txt','md','log','csv','json','xml','yaml','yml','py','js','html','css','sh','ini','cfg','conf','c','cpp','h','hpp','lua','rb','rs','go','java','ts','tsx','jsx','toml','bat','ps1','sql','r','swift','kt','php','pl','diff','makefile']
    previewable_pdf = ['pdf']
    
    files_json = []
    for f in visible_files:
        ext = _get_compound_ext(f.orig_name)
        is_previewable = ext in previewable_ext
        is_e2e = f.is_e2e_encrypted
        # E2E files can be previewed client-side for all types (images, text, audio, video, PDF)
        e2e_previewable = is_e2e and (ext in previewable_images or ext in previewable_text or ext in previewable_audio or ext in previewable_video or ext in previewable_pdf)
        # Determine if this is a text file (for client-side text thumbnail generation)
        is_text_file = ext in previewable_text
        
        if is_e2e:
            download_url = f'/f/{f.id}/{f.orig_name}'
        else:
            download_url = f'/f/{share_token}/file/{f.id}/{f.orig_name}'
        
        browse_entry = {
            'id': f.id,
            'name': f.orig_name,
            'extension': ext,
            'size': f.size,
            'size_formatted': format_bytes_for_filesize(f.size),
            'upload_date': f.get_upload_time_aware().strftime('%b %d, %Y'),
            'upload_date_iso': f.get_upload_time_aware().strftime('%Y-%m-%dT%H:%M:%S'),
            'is_previewable': is_previewable,
            'is_e2e': is_e2e,
            'e2e_previewable': e2e_previewable,
            'has_thumbnail': f.has_thumbnail,
            'thumbnailable': (not is_e2e) and _is_thumbnailable_name(f.orig_name),
            'is_text_file': is_text_file,
            'has_link_key': bool(f.link_encrypted_file_key or getattr(f, 'folder_link_encrypted_file_key', None)),
            'download_url': download_url,
        }
        if is_e2e and f.has_thumbnail and f.encrypted_thumbnail_nonce:
            browse_entry['enc_thumb_nonce'] = f.encrypted_thumbnail_nonce
        if is_e2e and f.encrypted_name:
            browse_entry['encrypted_name'] = f.encrypted_name
            browse_entry['name_nonce'] = f.name_nonce
        # Owner/master-key-wrapped key material is only needed by the owner.
        # Share visitors should receive only link/passphrase-scoped material.
        if is_e2e and f.encrypted_file_key and is_owner:
            browse_entry['encrypted_file_key'] = f.encrypted_file_key
            browse_entry['file_key_nonce'] = f.file_key_nonce
        if is_e2e and f.link_encrypted_file_key:
            browse_entry['link_encrypted_file_key'] = f.link_encrypted_file_key
            browse_entry['link_file_key_nonce'] = f.link_file_key_nonce
        if is_e2e and getattr(f, 'folder_link_encrypted_file_key', None):
            browse_entry['folder_link_encrypted_file_key'] = f.folder_link_encrypted_file_key
            browse_entry['folder_link_file_key_nonce'] = f.folder_link_file_key_nonce
        files_json.append(browse_entry)

    folders_json = []
    for sf in current_subfolders:
        browse_url = f'/f/{share_token}?folder={sf.id}'
        sf_e2e = sf.is_e2e is True
        if sf_e2e:
            dl_url = None
        else:
            dl_url = f'/f/{share_token}/folder/{sf.id}/{sf.name}.zip'
        sf_entry = {
            'id': sf.id,
            'name': sf.name,
            'browse_url': browse_url,
            'download_url': dl_url,
            'is_e2e': sf_e2e,
            'size': folder_sizes.get(sf.id, 0),
            'size_formatted': format_bytes_for_filesize(folder_sizes.get(sf.id, 0)) if folder_sizes.get(sf.id, 0) > 0 else None,
            'file_count': browse_file_counts.get(sf.id, 0),
            'e2e_count': browse_e2e_counts.get(sf.id, 0),
            'has_mixed_e2e': browse_has_mixed.get(sf.id, False),
            'created_at': sf.created_at.strftime('%b %d, %Y'),
            'created_at_iso': sf.created_at.strftime('%Y-%m-%dT%H:%M:%S'),
            'updated_at': (sf.updated_at or sf.created_at).strftime('%b %d, %Y'),
            'updated_at_iso': (sf.updated_at or sf.created_at).strftime('%Y-%m-%dT%H:%M:%S'),
        }
        # Include encrypted folder name data for client-side decryption (browse visitors)
        if sf_e2e and sf.encrypted_name:
            sf_entry['encrypted_name'] = sf.encrypted_name
            sf_entry['name_nonce'] = sf.name_nonce
            if is_owner:
                sf_entry['encrypted_name_key'] = sf.encrypted_name_key
                sf_entry['name_key_nonce'] = sf.name_key_nonce
            if sf.link_encrypted_name_key:
                sf_entry['link_encrypted_name_key'] = sf.link_encrypted_name_key
                sf_entry['link_name_key_nonce'] = sf.link_name_key_nonce
        folders_json.append(sf_entry)
    
    # Sidebar folders
    sidebar_json = []
    for sf in all_subfolders:
        sb_entry = {
            'id': sf.id,
            'name': sf.name,
            'parent_id': sf.parent_id,
            'is_e2e': sf.is_e2e is True,
        }
        if sf.is_e2e is True and sf.encrypted_name:
            sb_entry['encrypted_name'] = sf.encrypted_name
            sb_entry['name_nonce'] = sf.name_nonce
            if is_owner:
                sb_entry['encrypted_name_key'] = sf.encrypted_name_key
                sb_entry['name_key_nonce'] = sf.name_key_nonce
            if sf.link_encrypted_name_key:
                sb_entry['link_encrypted_name_key'] = sf.link_encrypted_name_key
                sb_entry['link_name_key_nonce'] = sf.link_name_key_nonce
        sidebar_json.append(sb_entry)
    
    # Breadcrumbs
    breadcrumbs_json = []
    for bc in breadcrumbs:
        bc_entry = {'id': bc.id, 'name': bc.name}
        if bc.is_e2e is True and bc.encrypted_name:
            bc_entry['encrypted_name'] = bc.encrypted_name
            bc_entry['name_nonce'] = bc.name_nonce
            if is_owner:
                bc_entry['encrypted_name_key'] = bc.encrypted_name_key
                bc_entry['name_key_nonce'] = bc.name_key_nonce
            if bc.link_encrypted_name_key:
                bc_entry['link_encrypted_name_key'] = bc.link_encrypted_name_key
                bc_entry['link_name_key_nonce'] = bc.link_name_key_nonce
        breadcrumbs_json.append(bc_entry)
    
    # Root folder encrypted name data
    root_folder_enc = {}
    if folder.is_e2e is True and folder.encrypted_name:
        root_folder_enc['encrypted_name'] = folder.encrypted_name
        root_folder_enc['name_nonce'] = folder.name_nonce
        if is_owner:
            root_folder_enc['encrypted_name_key'] = folder.encrypted_name_key
            root_folder_enc['name_key_nonce'] = folder.name_key_nonce
        if folder.link_encrypted_name_key:
            root_folder_enc['link_encrypted_name_key'] = folder.link_encrypted_name_key
            root_folder_enc['link_name_key_nonce'] = folder.link_name_key_nonce
    
    return jsonify({
        'folders': folders_json,
        'files': files_json,
        'breadcrumbs': breadcrumbs_json,
        'current_folder_id': current_browse_folder.id if current_browse_folder else folder.id,
        'root_folder_id': folder.id,
        'root_folder_name': folder.name,
        'root_folder_encrypted': root_folder_enc if root_folder_enc else None,
        'sidebar_folders': sidebar_json,
        'total_file_count': len(all_files),
        'is_e2e_folder': any(f.is_e2e_encrypted for f in all_files),
    })

@app.route('/f/<share_token>/search')
@limiter.limit(search_rate_limit)
def browse_folder_search(share_token):
    """Search files and folders within a browsable shared folder."""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return jsonify({'error': 'ACCESS DENIED'}), 403

    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        ancestor = is_folder_in_browsable_ancestor(folder)
        if not ancestor:
            ancestor = is_folder_in_public_browsable_ancestor(folder)
        if ancestor:
            folder_is_browsable = True
    if not folder_is_browsable:
        return jsonify({'error': 'FOLDER NOT BROWSABLE'}), 403

    query = request.args.get('q', '').strip()
    if not query:
        return jsonify({'files': [], 'folders': []})

    # Collect all accessible files and folders recursively.
    # AUDIT FIX (finding 13): pass the ANCESTOR-DERIVED folder_is_browsable
    # flag -- the stale `folder.is_public or folder.is_browsable` dropped the
    # browsable-ancestor result this route had already resolved above, so a
    # share reached THROUGH a browsable ancestor searched fewer files than
    # the per-level listing showed.
    all_files = collect_browsable_files(folder.id, is_owner, folder.is_public or folder_is_browsable, bool(folder.is_link_shared))
    all_subfolders = collect_browsable_folders(folder.id)

    query_lower = query.lower()

    # Search files
    matched_files = [f for f in all_files if query_lower in f.orig_name.lower()][:50]

    # Search folders
    matched_folders = [sf for sf in all_subfolders if query_lower in sf.name.lower()][:50]

    # Pre-load subfolder map for path building (avoids N+1 lazy parent walks)
    _subfolder_map = {sf.id: sf for sf in all_subfolders}
    _subfolder_map[folder.id] = folder  # Include root

    def get_folder_path(fld):
        path_parts = []
        current = fld
        while current and current.id != folder.id:
            path_parts.insert(0, current.name)
            current = _subfolder_map.get(current.parent_id) if current.parent_id else None
        path_parts.insert(0, folder.name)
        return ' / '.join(path_parts)

    def get_file_folder_path(file):
        if file.folder_id and file.folder_id != folder.id:
            fld = _subfolder_map.get(file.folder_id)
            if fld:
                return get_folder_path(fld)
        return folder.name

    previewable_text = ['txt','md','log','csv','json','xml','yaml','yml','py','js','html','css','sh','ini','cfg','conf','c','cpp','h','hpp','lua','rb','rs','go','java','ts','tsx','jsx','toml','bat','ps1','sql','r','swift','kt','php','pl','diff','makefile']

    file_results = []
    for f in matched_files:
        fentry = {
            'id': f.id,
            'name': f.orig_name,
            'size': format_bytes_for_filesize(f.size),
            'folder_path': get_file_folder_path(f),
            'folder_id': f.folder_id,
            'is_e2e': f.is_e2e_encrypted,
            'has_thumbnail': f.has_thumbnail,
            'extension': _get_compound_ext(f.orig_name),
            'thumbnailable': (not f.is_e2e_encrypted) and _is_thumbnailable_name(f.orig_name),
            'is_text_file': _get_compound_ext(f.orig_name) in previewable_text
        }
        if f.is_e2e_encrypted and f.has_thumbnail and f.encrypted_thumbnail_nonce:
            fentry['enc_thumb_nonce'] = f.encrypted_thumbnail_nonce
        if f.is_e2e_encrypted and f.encrypted_name:
            fentry['encrypted_name'] = f.encrypted_name
            fentry['name_nonce'] = f.name_nonce
        file_results.append(fentry)

    folder_results = []
    for sf in matched_folders:
        sf_entry = {
            'id': sf.id,
            'name': sf.name,
            'path': get_folder_path(sf),
            'is_e2e': sf.is_e2e is True,
        }
        if sf.is_e2e is True and sf.encrypted_name:
            sf_entry['encrypted_name'] = sf.encrypted_name
            sf_entry['name_nonce'] = sf.name_nonce
            if is_owner:
                sf_entry['encrypted_name_key'] = sf.encrypted_name_key
                sf_entry['name_key_nonce'] = sf.name_key_nonce
            if sf.link_encrypted_name_key:
                sf_entry['link_encrypted_name_key'] = sf.link_encrypted_name_key
                sf_entry['link_name_key_nonce'] = sf.link_name_key_nonce
        folder_results.append(sf_entry)

    # Collect unique E2E folders referenced in paths for client-side path reconstruction
    path_folders_map = {}
    def collect_path_folders(fld):
        current = fld
        while current and current.id != folder.id:
            if current.id not in path_folders_map and current.is_e2e is True and current.encrypted_name:
                pf_entry = {
                    'id': current.id,
                    'name': current.name,
                    'parent_id': current.parent_id,
                    'encrypted_name': current.encrypted_name,
                    'name_nonce': current.name_nonce,
                }
                if is_owner:
                    pf_entry['encrypted_name_key'] = current.encrypted_name_key
                    pf_entry['name_key_nonce'] = current.name_key_nonce
                if current.link_encrypted_name_key:
                    pf_entry['link_encrypted_name_key'] = current.link_encrypted_name_key
                    pf_entry['link_name_key_nonce'] = current.link_name_key_nonce
                path_folders_map[current.id] = pf_entry
            current = current.parent if current.parent_id else None
    for sf in matched_folders:
        collect_path_folders(sf)
    for f in matched_files:
        if f.folder_id and f.folder_id != folder.id:
            fld_obj = db.session.get(Folder, f.folder_id)
            if fld_obj:
                collect_path_folders(fld_obj)

    resp = {'files': file_results, 'folders': folder_results}
    if path_folders_map:
        resp['path_folders'] = list(path_folders_map.values())
    return jsonify(resp)

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
        print(f'[BROWSE DOWNLOAD] Refused expired file through folder token: {file.orig_name}')
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
    print(f'[BROWSE DOWNLOAD] Serving file: {file.orig_name} from folder: {_log_safe(folder.name)}')
    
    if file.is_e2e_encrypted:
        if request.method == 'HEAD':
            import mimetypes
            head_mimetype, _ = mimetypes.guess_type(file.orig_name)
            return _build_streaming_response(
                lambda: iter(()), head_mimetype or 'application/octet-stream',
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
        import mimetypes
        mimetype, _ = mimetypes.guess_type(file.orig_name)
        if not mimetype:
            mimetype = 'application/octet-stream'
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
                print(f'[BROWSE DOWNLOAD] Streaming decrypted temp file to CLI: {file.orig_name} ({file.size} bytes)')
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

@app.route('/f/<share_token>/thumb/<file_id>')
@limiter.limit(thumbnail_rate_limit, deduct_when=_count_uncached_thumbnail)
def browse_folder_thumbnail(share_token, file_id):
    """Serve thumbnail for a file in a browsable shared folder"""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        abort(404)

    # Check if folder is browsable directly or via a browsable ancestor
    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        if not is_folder_in_browsable_ancestor(folder) and not is_folder_in_public_browsable_ancestor(folder):
            abort(404)
        folder_is_browsable = True

    file = db.session.get(File, file_id)
    if not file:
        abort(404)

    # AUDIT FIX P8: apply the SAME access filter the listing uses instead of a
    # bare containment test. The old check skipped the E2E upload boundary, the
    # is_temp_upload filter, the exhausted-max_downloads filter and expiry, and
    # used is_subfolder_of() which ignores is_trashed -- so containment succeeded
    # through trashed intermediate folders. That made this a content-preview
    # oracle for files the browse listing deliberately hides.
    is_thumb_owner = is_owner or _current_user_owns_file(file)
    if not _browse_file_accessible(file, folder, is_thumb_owner, folder_is_browsable, require_downloadable=True):
        abort(404)

    # E2E files: no server-side thumbnails (zero-knowledge)
    if file.is_e2e_encrypted:
        abort(404)

    # Serve an existing thumbnail even when has_thumbnail is stale/False
    # (jpg on disk, flag never healed). Owner-only fill generates a missing one.
    thumb_bytes = load_thumbnail_from_disk(file.id, is_e2e=False)
    if thumb_bytes:
        _heal_has_thumbnail_flag(file)
        return _send_cached_thumbnail(thumb_bytes)

    if not file.is_trashed and _is_thumbnailable_name(file.orig_name):
        generate_thumbnail(file, wait=False)
        thumb_bytes = load_thumbnail_from_disk(file.id, is_e2e=False)
        if thumb_bytes:
            return _send_cached_thumbnail(thumb_bytes)

    abort(404)

@app.route('/f/<share_token>/e2e-thumb/<file_id>')
@limiter.limit(thumbnail_rate_limit, deduct_when=_count_uncached_thumbnail)
def browse_folder_e2e_thumbnail(share_token, file_id):
    """Serve raw encrypted E2EE thumbnail bytes for a file in a browsable shared folder.
    Returns application/octet-stream for client-side decryption."""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        abort(404)

    # Check if folder is browsable directly or via a browsable ancestor
    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        if not is_folder_in_browsable_ancestor(folder) and not is_folder_in_public_browsable_ancestor(folder):
            abort(404)
        folder_is_browsable = True

    file = db.session.get(File, file_id)
    if not file:
        abort(404)

    # Only serve E2EE thumbnails through this endpoint
    if not file.is_e2e_encrypted:
        abort(404)

    # AUDIT FIX P8: same full listing-equivalent access filter as /thumb/<id>.
    is_thumb_owner = is_owner or _current_user_owns_file(file)
    if not _browse_file_accessible(file, folder, is_thumb_owner, folder_is_browsable, require_downloadable=True):
        abort(404)

    if not file.has_thumbnail or not file.encrypted_thumbnail_nonce:
        abort(404)

    thumb_bytes = load_thumbnail_from_disk(file.id, is_e2e=True)
    if not thumb_bytes:
        abort(404)

    # Serve raw encrypted bytes with HTTP caching (ETag + Cache-Control)
    etag = '"e2e-' + hashlib.md5(thumb_bytes).hexdigest() + '"'
    if request.if_none_match and etag.strip('"') in request.if_none_match:
        resp = make_response('', 304)
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = f'private, max-age={THUMBNAIL_CACHE_MAX_AGE}'
        return resp
    resp = make_response(send_file(io.BytesIO(thumb_bytes), mimetype='application/octet-stream'))
    resp.headers['Cache-Control'] = f'private, max-age={THUMBNAIL_CACHE_MAX_AGE}'
    resp.headers['ETag'] = etag
    return resp

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


