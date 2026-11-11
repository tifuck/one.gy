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
        print(f'[TRASH] Blocked manage page for trashed file: {_log_safe(file.orig_name)}')
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
            print(f'[TRASH] Blocked manage POST for trashed file: {_log_safe(file.orig_name)}')
            abort(404)

        expires = request.form.get('expires')
        # An expiry would let cleanup delete a file of a read-only backup.
        if expires and expires != 'never' and _backup_read_only(file.folder_id):
            return _backup_read_only_error()

        # Only update public if the public field was explicitly submitted
        if 'public' in request.form:
            is_public = request.form.get('public') == 'on'
            file.is_public = is_public
            # Clear E2E link keys when shareable is turned OFF. Turning it back
            # on does NOT give a fresh URL: the link secret is
            # HKDF(master, 'file:' + id), so only regenerate-link (which rotates
            # the id) invalidates a URL that was already handed out.
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
            # Temp uploads never outlive MAX_RETENTION from their upload time,
            # however often the expiry is re-extended.
            if file.is_temp_upload and file.expires_at is not None:
                retention_cap = file.get_upload_time_aware() + app.config['MAX_RETENTION']
                if file.get_expires_at_aware() > retention_cap:
                    file.expires_at = retention_cap

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
        if _backup_read_only(file.folder_id):
            return _backup_read_only_error()
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
    print(f'[DELETE] Deleted file: {_log_safe(file_name)}')
    
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
