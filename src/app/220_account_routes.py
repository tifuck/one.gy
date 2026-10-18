@app.route('/avatar/<int:user_id>.svg')
def user_avatar_svg(user_id):
    """Generate an SVG avatar with a smiley face on a colored background.
    When a user has no customized color (or does not exist), fall back to a
    deterministic hash-derived color so callers cannot distinguish nonexistent
    user IDs from users with default avatars."""
    digest = hashlib.sha256(f'avatar:{user_id}'.encode()).hexdigest()
    color = f'#{digest[:6]}'
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <circle cx="50" cy="50" r="50" fill="{color}"/>
  <circle cx="35" cy="40" r="5" fill="#fff" opacity="0.9"/>
  <circle cx="65" cy="40" r="5" fill="#fff" opacity="0.9"/>
  <path d="M 30 58 Q 50 78 70 58" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.9"/>
</svg>'''
    from flask import Response
    return Response(svg, mimetype='image/svg+xml', headers={'Cache-Control': 'public, max-age=86400'})

@app.route('/account')
@limiter.limit(file_ops_rate_limit)
@login_required
def account():
    user = _current_session_user()
    if not user:
        session.pop('logged_in_user_id', None)
        return redirect(url_for('login'))
    
    file_count = File.query.filter_by(registered_user_id=user.id).count()
    folder_count = Folder.query.filter_by(user_id=user.id, is_trashed=False).count()
    e2e_file_count = File.query.filter_by(registered_user_id=user.id, is_e2e_encrypted=True).count()
    storage_used_gb = user.get_storage_used_gb()
    storage_limit_gb = user.storage_limit_gb
    storage_percent = round(storage_used_gb / storage_limit_gb * 100, 1) if storage_limit_gb > 0 else 0
    
    return render_template('account.html',
        user=user,
        file_count=file_count,
        folder_count=folder_count,
        e2e_file_count=e2e_file_count,
        storage_used_gb=round(storage_used_gb, 2),
        storage_limit_gb=storage_limit_gb,
        storage_percent=storage_percent,
    )

# ─── PREVIEW SCAFFOLD ROUTES REMOVED ─────────────────────────────────────────
# Former unauthenticated preview/scaffold routes fell back to
# `User.query.first()` when nobody was logged in, which handed an anonymous
# visitor a fully rendered app page for an arbitrary (usually the first/admin)
# account. Those pages are now the production UI served from the real,
# @login_required routes, so the previews are deleted rather than gated.
# Do NOT reintroduce a preview route that resolves a user from anything other
# than session['logged_in_user_id'].

@app.route('/account/api-keys', methods=['GET'])
@login_required
def list_api_keys():
    """List API keys for the current user (browser UI)."""
    if not get_setting('allow_api_keys'):
        return jsonify({'error': 'API key access is disabled by the administrator'}), 403

    user = _current_session_user()
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

@app.route('/account/api-keys', methods=['POST'])
@login_required
def create_api_key():
    """Generate a new API key (browser UI)."""
    user = _current_session_user()

    if not get_setting('allow_api_keys'):
        return jsonify({'error': 'API key access is disabled by the administrator'}), 403

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'INVALID REQUEST'}), 400
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

    if not _verify_user_credentials(user,
                                    password=data.get('password') or data.get('current_password'),
                                    auth_token=data.get('auth_token') or data.get('current_auth_token')):
        return jsonify({'error': 'PASSWORD IS REQUIRED TO CREATE AN API KEY'}), 403
    if user.two_factor_enabled:
        totp_code = (data.get('totp_code') or '').strip()
        if not totp_code:
            return jsonify({'error': '2FA CODE IS REQUIRED TO CREATE AN API KEY'}), 400
        totp = pyotp.TOTP(_decrypt_totp_secret(user.two_factor_secret, user))
        if not totp.verify(totp_code, valid_window=1):
            return jsonify({'error': 'INVALID 2FA CODE'}), 400

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

    print(f'[API] Created API key "{label}" for user: {user.username} (via browser)')
    return jsonify({
        'id': api_key.id,
        'key': raw_key,
        'label': label,
        'permissions': api_key.get_permissions_dict(),
        'allowed_ips': api_key.get_allowed_ips_list()
    }), 201

@app.route('/account/api-keys/<key_id>', methods=['PATCH'])
@login_required
def update_api_key(key_id):
    """Update permissions and/or IP whitelist on an existing API key (browser UI)."""
    if not get_setting('allow_api_keys'):
        return jsonify({'error': 'API key access is disabled by the administrator'}), 403

    user = _current_session_user()

    api_key = ApiKey.query.filter_by(id=key_id, user_id=user.id, is_active=True).first()
    if not api_key:
        return jsonify({'error': 'API key not found'}), 404

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'INVALID REQUEST'}), 400

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

    print(f'[API] Updated API key "{_log_safe(api_key.label)}" for user: {user.username} (via browser)')
    return jsonify({
        'id': api_key.id,
        'label': api_key.label,
        'permissions': api_key.get_permissions_dict(),
        'allowed_ips': api_key.get_allowed_ips_list()
    })

@app.route('/account/api-keys/<key_id>', methods=['DELETE'])
@login_required
def revoke_api_key(key_id):
    """Revoke an API key (browser UI)."""
    if not get_setting('allow_api_keys'):
        return jsonify({'error': 'API key access is disabled by the administrator'}), 403

    user = _current_session_user()

    api_key = ApiKey.query.filter_by(id=key_id, user_id=user.id, is_active=True).first()
    if not api_key:
        return jsonify({'error': 'API key not found'}), 404

    api_key.is_active = False
    db.session.commit()

    print(f'[API] Revoked API key "{_log_safe(api_key.label)}" for user: {user.username} (via browser)')
    return jsonify({'success': True})

@app.route('/api/view-preference', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def update_view_preference():
    """Update user's file browser view preference (list or grid)"""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'NOT AUTHENTICATED'}), 401
    
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or 'view' not in data:
        return jsonify({'error': 'MISSING VIEW PARAMETER'}), 400
    
    view = data['view']
    if view not in ('list', 'grid'):
        return jsonify({'error': 'INVALID VIEW. MUST BE list OR grid'}), 400
    
    user.view_preference = view
    db.session.commit()
    print(f'[PREFS] User {user.username} changed view preference to {view}')
    return jsonify({'ok': True, 'view': view})

@app.route('/api/files-background-preference', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def update_files_background_preference():
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'NOT AUTHENTICATED'}), 401

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or 'theme' not in data:
        return jsonify({'error': 'MISSING THEME PARAMETER'}), 400

    theme = str(data['theme'] or 'off')
    if theme not in FILES_BACKGROUND_THEMES:
        return jsonify({'error': 'INVALID THEME'}), 400

    user.files_background_theme = theme
    db.session.commit()
    print(f'[PREFS] User {user.username} changed files background theme to {theme}')
    return jsonify({'ok': True, 'theme': theme})

@app.route('/change-password', methods=['GET', 'POST'])
@limiter.limit("5 per minute")
@login_required
def change_password():
    # Decorator handles authentication
    
    user = _current_session_user()
    if not user:
        session.pop('logged_in_user_id', None)
        return redirect(url_for('login'))
    
    if request.method == 'GET':
        return redirect(url_for('account') + '#section-security')

    # POST handler (AJAX from account page)
    is_ajax = request.headers.get('X-Requested-With') == 'XMLHttpRequest'
    
    if is_ajax:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):  # a JSON array/scalar has no .get()
            data = None
        current_password = data.get('current_password') if data else None
        new_password = data.get('new_password') if data else None
        confirm_password = data.get('confirm_password') if data else None
        new_password_length = data.get('new_password_length') if data else None
        current_auth_token = data.get('current_auth_token') if data else None
        new_auth_token = data.get('new_auth_token') if data else None
        new_auth_salt = data.get('new_auth_salt') if data else None
    else:
        data = None
        current_password = request.form.get('current_password')
        new_password = request.form.get('new_password')
        confirm_password = request.form.get('confirm_password')
        new_password_length = None
        current_auth_token = None
        new_auth_token = None
        new_auth_salt = None

    def _chpw_fail(message, status):
        """Uniform failure exit. Nothing has been assigned to `user` at any point
        where this is called, so a rejection can never leave a partial update."""
        if is_ajax:
            return jsonify({'error': message}), status
        flash(message, 'error')
        return redirect(url_for('account') + '#section-security')

    if is_ajax and data is None:
        return _chpw_fail('INVALID REQUEST', 400)

    # AUDIT FIX C3: validate the client key blobs BEFORE anything is written.
    # /change-password never ran _validate_e2ee_fields at all.
    if is_ajax:
        _e2ee_err = _validate_e2ee_fields(data, [
            'encrypted_master_key', 'master_key_nonce', 'master_key_salt',
            'encrypted_private_key', 'private_key_nonce',
            'current_auth_token', 'new_auth_token', 'new_auth_salt',
        ])
        if _e2ee_err:
            return _chpw_fail(_e2ee_err, 400)

    # Verify current credentials: split-key auth_token or legacy password (same flow as login)
    if not _verify_user_credentials(user, password=current_password, auth_token=current_auth_token):
        return _chpw_fail('CURRENT PASSWORD IS INCORRECT', 403)

    # AUDIT FIX M10: one shared bounded length policy for register/change/recovery.
    if new_auth_token and new_auth_salt:
        _pw_len_ok, _pw_len_err = _validate_asserted_password_length(new_password_length, new_password)
        if not _pw_len_ok:
            return _chpw_fail(_pw_len_err, 400)
    else:
        if not new_password or not confirm_password:
            return _chpw_fail('ALL FIELDS ARE REQUIRED', 400)
        if new_password != confirm_password:
            return _chpw_fail('NEW PASSWORDS DO NOT MATCH', 400)
        _pw_len_ok, _pw_len_err = _validate_asserted_password_length(len(new_password))
        if not _pw_len_ok:
            return _chpw_fail(_pw_len_err, 400)

    # ── Build every new value, validate it all, THEN assign ───────────────
    pending = {}

    if new_auth_token and new_auth_salt:
        # Split-key: store hash of new auth token (client-derived)
        import hashlib as _hashlib_chpw2
        pending['auth_token_hash'] = _hashlib_chpw2.sha256(new_auth_token.encode('utf-8')).hexdigest()
        pending['auth_token_salt'] = new_auth_salt
        pending['split_key_version'] = 1
        pending['password_hash'] = 'split-key-v1'  # Placeholder
    elif user.split_key_version and user.split_key_version >= 1:
        # v1 user must provide new split-key credentials (client-derived).
        print(f'[AUTH] Change password rejected for split-key v1 user {user.username}: '
              'new_auth_token and new_auth_salt are required')
        return _chpw_fail('SPLIT-KEY CREDENTIALS REQUIRED FOR PASSWORD CHANGE', 400)
    else:
        # Legacy v0: store Werkzeug password hash
        pending['password_hash'] = generate_password_hash(new_password, method='pbkdf2:sha256')

    # ── AUDIT FIX C3 INVARIANT ────────────────────────────────────────────
    # Credentials are about to rotate. If the account holds E2EE keys, the
    # re-wrapped master key is MANDATORY: rotating the wrapping key without it
    # leaves encrypted_master_key sealed under the OLD key while the new
    # password derives a NEW one. The user would log in fine and every E2EE
    # file, folder name and note would be permanently undecryptable.
    # Reject with a clear 400 and change NOTHING.
    new_master_key = data.get('encrypted_master_key') if is_ajax and data else None
    new_master_nonce = data.get('master_key_nonce') if is_ajax and data else None
    new_master_salt = data.get('master_key_salt') if is_ajax and data else None
    new_private_key = data.get('encrypted_private_key') if is_ajax and data else None
    new_private_nonce = data.get('private_key_nonce') if is_ajax and data else None

    if user.has_e2ee_keys:
        if not (new_master_key and new_master_nonce and new_master_salt):
            print(f'[AUTH] Change password REJECTED for user {user.username}: credential rotation '
                  'without a re-wrapped master key would permanently brick the vault')
            return _chpw_fail(
                'RE-WRAPPED MASTER KEY IS REQUIRED (ENCRYPTED_MASTER_KEY, MASTER_KEY_NONCE, MASTER_KEY_SALT)', 400)
        if not all(isinstance(v, str) and v for v in (new_master_key, new_master_nonce, new_master_salt)):
            return _chpw_fail('RE-WRAPPED MASTER KEY IS MALFORMED', 400)
        pending['encrypted_master_key'] = new_master_key
        pending['master_key_nonce'] = new_master_nonce
        pending['master_key_salt'] = new_master_salt
        # Private key is wrapped by the master key (unchanged), but accept it if
        # the client re-sent it. Both halves must arrive together.
        if new_private_key or new_private_nonce:
            if not (isinstance(new_private_key, str) and new_private_key
                    and isinstance(new_private_nonce, str) and new_private_nonce):
                return _chpw_fail('RE-WRAPPED PRIVATE KEY IS MALFORMED', 400)
            pending['encrypted_private_key'] = new_private_key
            pending['private_key_nonce'] = new_private_nonce
    elif new_master_key:
        # No prior keys, but the client sent key material — accept it as setup,
        # still requiring the full triple so a half-written wrap is impossible.
        if not (isinstance(new_master_key, str) and new_master_key
                and isinstance(new_master_nonce, str) and new_master_nonce
                and isinstance(new_master_salt, str) and new_master_salt):
            return _chpw_fail('RE-WRAPPED MASTER KEY IS MALFORMED', 400)
        pending['encrypted_master_key'] = new_master_key
        pending['master_key_nonce'] = new_master_nonce
        pending['master_key_salt'] = new_master_salt
        if new_private_key or new_private_nonce:
            if not (isinstance(new_private_key, str) and new_private_key
                    and isinstance(new_private_nonce, str) and new_private_nonce):
                return _chpw_fail('RE-WRAPPED PRIVATE KEY IS MALFORMED', 400)
            pending['encrypted_private_key'] = new_private_key
            pending['private_key_nonce'] = new_private_nonce

    # ── Everything validated: assign and commit atomically ────────────────
    for attr, value in pending.items():
        setattr(user, attr, value)

    # AUDIT FIX M1: rotate the session epoch on password change so ALL OTHER
    # active sessions (e.g. a stolen/cloned session cookie the user is trying to
    # evict by changing their password) are immediately invalidated. The acting
    # session is re-synced to the new epoch below so the current user stays
    # logged in. Mirrors the recovery flow which already rotates session_epoch.
    user.session_epoch = db.func.coalesce(User.session_epoch, 0) + 1  # atomic in SQL: concurrent rotations must not collapse into one
    _deactivate_user_api_keys(user.id)

    try:
        db.session.commit()
    except Exception as _e:
        db.session.rollback()
        print(f'[ERROR] Password change commit failed for user {user.username}: {_e}')
        return _chpw_fail('PASSWORD CHANGE FAILED', 500)

    # Keep the CURRENT session valid; only OTHER sessions are evicted.
    session['session_epoch'] = int(user.session_epoch or 0)
    # AUDIT FIX H5: an abandoned 2FA enrolment must not survive a credential change.
    _clear_pending_2fa_setup()

    if 'encrypted_master_key' in pending:
        print(f'[AUTH] E2EE keys re-wrapped for user: {user.username} (split_key_v{user.split_key_version})')
    print(f'[AUTH] Password changed for user: {user.username} (session_epoch rotated -> all other sessions invalidated)')

    if is_ajax:
        return jsonify({'success': True, 'redirect': url_for('files')})

    flash('PASSWORD CHANGED SUCCESSFULLY', 'success')
    return redirect(url_for('account'))

@app.route('/delete-account', methods=['POST'])
@limiter.limit("3 per minute")
@login_required
def delete_account():
    """Allow a user to permanently delete their own account, files, and folders."""
    user = _current_session_user()
    if not user:
        session.pop('logged_in_user_id', None)
        return redirect(url_for('login'))

    is_ajax = request.headers.get('X-Requested-With') == 'XMLHttpRequest'

    # AUDIT FIX H6: get_json(silent=True) so a wrong/missing content type is a
    # clean 400 instead of a Flask 3 415 (the client used to send FormData here).
    if is_ajax:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):  # a JSON array/scalar has no .get()
            data = None
        elif not _json_string_fields_valid(data, ('password', 'auth_token', 'captcha')):
            return jsonify({'error': 'INVALID REQUEST'}), 400
        password = data.get('password') if data else None
        captcha_input = (data.get('captcha') or '').strip() if data else ''
    else:
        data = None
        password = request.form.get('password')
        captcha_input = (request.form.get('captcha') or '').strip()

    # Validate captcha
    captcha_ok, captcha_error = _validate_captcha_response(captcha_input)
    if not captcha_ok:
        if is_ajax:
            return jsonify({'error': captcha_error}), 400
        print(f'[AUTH] Delete account captcha failed for user {user.username}')
        flash(captcha_error, 'error')
        return redirect(url_for('account') + '#section-danger')

    # Validate password / auth_token (same flow as login)
    if is_ajax:
        auth_token = data.get('auth_token') if data else None
    else:
        auth_token = None

    if not password and not auth_token:
        if is_ajax:
            return jsonify({'error': 'PASSWORD IS REQUIRED'}), 400
        flash('PASSWORD IS REQUIRED', 'error')
        return redirect(url_for('account') + '#section-danger')

    # Same credential rules as /login, hmac.compare_digest throughout.
    auth_ok = _verify_user_credentials(user, password=password, auth_token=auth_token)

    if not auth_ok:
        print(f'[AUTH] Delete account password check failed for user {user.username}')
        if is_ajax:
            return jsonify({'error': 'INCORRECT PASSWORD'}), 403
        flash('INCORRECT PASSWORD', 'error')
        return redirect(url_for('account') + '#section-danger')

    username = user.username
    user_id = user.id
    admin_reduction_lock = None
    lifecycle_lock = None

    try:
        admin_reduction_lock = _acquire_admin_reduction_lock()
        lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
        _, user, reduction_error = _revalidate_admin_reduction(
            user_id, user_id, require_acting_admin=False)
        if reduction_error in ('actor_missing', 'target_missing'):
            session.clear()
            if is_ajax:
                return jsonify({'error': 'SESSION EXPIRED'}), 401
            flash('SESSION EXPIRED. PLEASE LOGIN AGAIN.', 'error')
            return redirect(url_for('login'))
        if reduction_error == 'last_admin':
            if is_ajax:
                return jsonify({'error': 'CANNOT DELETE THE LAST ADMINISTRATOR'}), 400
            flash('CANNOT DELETE THE LAST ADMINISTRATOR', 'error')
            return redirect(url_for('account') + '#section-danger')

        username = user.username
        # Collect disk paths to delete after DB commit
        paths_to_delete = []
        
        # AUDIT FIX (finding 4): DEFER the thumbnail BLOB columns -- this
        # delete only needs the payload keys, but the bare .all() loaded every
        # legacy thumbnail blob into memory. Row deletion and the atomic
        # stage+commit below are unchanged (deferred columns are simply never
        # read).
        user_files = File.query.filter_by(registered_user_id=user_id).options(
            db.defer(File.thumbnail_data),
            db.defer(File.encrypted_thumbnail_data),
        ).all()
        file_count = len(user_files)
        for file in user_files:
            paths_to_delete.extend(_file_payload_delete_keys(file))
            db.session.delete(file)

        # Delete all user's folders
        user_folders = Folder.query.filter_by(user_id=user_id).all()
        folder_count = len(user_folders)
        for folder in user_folders:
            db.session.delete(folder)

        # Delete all user's API keys
        ApiKey.query.filter_by(user_id=user_id).delete()

        # Delete all user's notes and notebooks + collect note file paths
        user_notes = Note.query.filter_by(user_id=user_id).all()
        note_count = len(user_notes)
        note_paths = []
        for note in user_notes:
            note_paths.append(_note_payload_delete_key(note.id))
            db.session.delete(note)
        Notebook.query.filter_by(user_id=user_id).delete()

        # Delete music records, pending notes, and notification dismissals.
        # AUDIT FIX D13: only the notes DELIVERED TO this user are theirs to
        # destroy. PendingNote.encrypted_content is wrapped with the RECIPIENT's
        # RSA key -- it is the recipient's data -- so notes this user SENT must
        # survive their account deletion and stay acceptable by the recipient.
        PendingNote.query.filter(PendingNote.recipient_id == user_id).delete(synchronize_session=False)
        _release_sent_pending_notes(user_id)
        _playlist_ids = [p.id for p in MusicPlaylist.query.filter_by(user_id=user_id).with_entities(MusicPlaylist.id).all()]
        if _playlist_ids:
            MusicPlaylistSong.query.filter(MusicPlaylistSong.playlist_id.in_(_playlist_ids)).delete(synchronize_session=False)
        MusicPlaylist.query.filter_by(user_id=user_id).delete()
        MusicLike.query.filter_by(user_id=user_id).delete()
        MusicSyncCommand.query.filter_by(user_id=user_id).delete(synchronize_session=False)
        MusicDevice.query.filter_by(user_id=user_id).delete()
        MusicSyncState.query.filter_by(user_id=user_id).delete()
        NotificationDismissal.query.filter(NotificationDismissal.user_id == user_id).delete(synchronize_session=False)
        # AUDIT FIX (finding 18): the user's prompt-feedback rows are theirs;
        # do not retain them after the account is destroyed.
        PromptFeedback.query.filter(PromptFeedback.user_id == user_id).delete(synchronize_session=False)

        # Delete the user record
        db.session.delete(user)

        # AUDIT FIX (atomic permanent delete): stage file + note remote-delete
        # tombstones and replica-row deletes into the SAME transaction as the
        # account metadata deletion so a crash can never orphan a payload on a
        # backup node with no delete intent. Local disk purged after the commit.
        local_targets = storage.stage_payload_deletes(paths_to_delete)
        local_targets += storage.stage_payload_deletes(note_paths)
        db.session.commit()

        _release_lifecycle_lock(lifecycle_lock)
        lifecycle_lock = None
        _release_admin_reduction_lock(admin_reduction_lock)
        admin_reduction_lock = None

        # DB commit succeeded -- now safe to remove local disk payloads
        _purge_staged_locals_with_note_locks(local_targets)

        print(f'[AUTH] Account self-deleted: {username} (ID: {user_id}, files: {file_count}, folders: {folder_count}, notes: {note_count})')

        # Clear session (log out)
        guest_user_id = session.get('user_id')
        session.clear()
        if guest_user_id:
            session['user_id'] = guest_user_id

        if is_ajax:
            return jsonify({'success': True, 'redirect': url_for('index')})

        flash('YOUR ACCOUNT HAS BEEN PERMANENTLY DELETED', 'success')
        return redirect(url_for('index'))

    except Exception as e:
        db.session.rollback()
        print(f'[ERROR] Account self-delete failed for {username}: {e}')
        if is_ajax:
            return jsonify({'error': 'ACCOUNT DELETION FAILED. PLEASE TRY AGAIN'}), 500
        flash('ACCOUNT DELETION FAILED. PLEASE TRY AGAIN', 'error')
        return redirect(url_for('account') + '#section-danger')
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_admin_reduction_lock(admin_reduction_lock)

