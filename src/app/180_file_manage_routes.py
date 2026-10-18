@app.route('/folder/<int:folder_id>/manage', methods=['GET', 'POST'])
@login_required
def manage_folder(folder_id):
    # Decorator handles authentication
    user = _current_session_user()
    if not user:
        return redirect(url_for('login'))
    
    folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
    if not folder:
        abort(404)
    
    # Generate share token if not exists
    if not folder.share_token:
        folder.share_token = str(uuid.uuid4())
        db.session.commit()
    
    # Bulk-load folder stats: 2 queries + BFS instead of 7N recursive queries
    _all_folders = Folder.query.filter_by(user_id=user.id, is_trashed=False).all()
    _children_map = {}
    for _f in _all_folders:
        _children_map.setdefault(_f.parent_id, []).append(_f.id)
    # AUDIT FIX D3: cycle/size guarded BFS -- the old loop added ids to a set but
    # still re-queued them, so a parent_id cycle looped forever.
    _subtree_ids = set(_bfs_folder_ids(folder.id, _children_map))
    _file_stats = db.session.query(
        db.func.count(File.id),
        db.func.coalesce(db.func.sum(File.size), 0),
        db.func.sum(db.case((File.is_e2e_encrypted == True, 1), else_=0))
    ).filter(
        File.folder_id.in_(_subtree_ids),
        File.is_temp_upload == False,
        File.is_trashed == False
    ).one()
    file_count = _file_stats[0]
    folder_size = _file_stats[1]
    e2e_count = _file_stats[2] or 0
    
    if request.method == 'POST':
        lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
        try:
            db.session.rollback()
            folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
            if not folder:
                abort(404)

            # Handle share settings update - only update fields that are explicitly submitted
            if 'expires' in request.form:
                expires_input = request.form.get('expires', 'never')
                if expires_input == 'never':
                    folder.expires_at = None
                else:
                    now = datetime.now(timezone.utc)
                    if expires_input == '30m':
                        folder.expires_at = now + timedelta(minutes=30)
                    elif expires_input == '6h':
                        folder.expires_at = now + timedelta(hours=6)
                    elif expires_input == '1d':
                        folder.expires_at = now + timedelta(days=1)
                    elif expires_input == '3d':
                        folder.expires_at = now + timedelta(days=3)
                    elif expires_input == '7d':
                        folder.expires_at = now + timedelta(days=7)
        
            # Check if folder inherits browsable from an ancestor
            root_browsable = get_root_browsable_ancestor(folder)
            folder_inherited_browsable = root_browsable is not None

            # Update public setting if explicitly submitted
            if 'public' in request.form:
                is_public = request.form.get('public') == 'on'
                folder.is_public = is_public

            if 'browsable' in request.form:
                if not folder_inherited_browsable:
                    is_browsable = request.form.get('browsable') == 'on'
                    folder.is_browsable = is_browsable
                    # Clear E2E link keys when browsable is turned OFF so that
                    # toggling off then back on generates a fresh share URL
                    if not is_browsable:
                        folder.link_secret = None
                        folder.is_link_shared = False
                        cleared = _clear_e2e_link_keys_for_folder_tree(folder.id)
                        if cleared:
                            print(f'[FOLDER] Cleared {cleared} descendant E2E file link key(s) for folder {folder.id}')
                else:
                    print(f'[FOLDER] Blocked browsable toggle on folder {_log_safe(folder.name)} — inherited from ancestor')

            # Update stored E2EE flag when explicitly toggled (cascades to all subfolders)
            if 'e2e' in request.form:
                new_e2e = request.form.get('e2e') == 'on'
                folder.is_e2e = new_e2e
                # Cascade to all descendant subfolders
                # Iterative with a visited set: recursion hit RecursionError on
                # ~1000-deep trees and never ended on a parent_id cycle.
                pending_ids, seen_ids = [folder.id], {folder.id}
                while pending_ids:
                    children = Folder.query.filter_by(parent_id=pending_ids.pop(), user_id=user.id, is_trashed=False).all()
                    for child in children:
                        # Keep subfolders whose names are still encrypted readable.
                        child.is_e2e = new_e2e or bool(child.encrypted_name)
                        if child.id not in seen_ids:
                            seen_ids.add(child.id)
                            pending_ids.append(child.id)
                print(f'[FOLDER] E2E flag set to {new_e2e} on folder {_log_safe(folder.name)} (and all subfolders) by user {user.username}')

            folder.updated_at = datetime.now(timezone.utc)
            db.session.commit()
        finally:
            _release_lifecycle_lock(lifecycle_lock)
        
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return jsonify({'success': True})
        
        flash('FOLDER SETTINGS UPDATED', 'success')
        return redirect(url_for('manage_folder', folder_id=folder_id))
    
    # Determine selected expiration based on remaining time from now
    selected_expire = 'never'
    if folder.expires_at:
        expires_aware = folder.get_expires_at_aware()
        remaining_seconds = (expires_aware - datetime.now(timezone.utc)).total_seconds()
        
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
    
    # Check if folder inherits public status from a parent folder
    inherited_public = is_folder_in_public_ancestor(folder)
    
    # Check if folder inherits browsable status from a parent folder
    root_browsable = get_root_browsable_ancestor(folder)
    
    # Generate share URL (browsable gets clean URL, zip download gets .zip suffix)
    safe_folder_name = secure_filename(folder.name)
    if folder.is_browsable or root_browsable is not None:
        share_url = f'https://{domain}/f/{folder.share_token}'
    else:
        share_url = f'https://{domain}/f/{folder.share_token}/{urllib.parse.quote(safe_folder_name)}.zip'
    inherited_browsable = root_browsable is not None
    
    # Back destination is computed here (not in the template) because Jinja
    # {% set %} is block-scoped: a value set inside {% block content %} is
    # Undefined inside {% block scripts %}, and |tojson on Undefined is a 500.
    back_url = url_for('files', folder_id=folder.parent_id) if folder.parent_id else url_for('files')

    return render_template('manage.html',
                         is_folder=True,
                         back_url=back_url,
                         back_label='Back to files',
                         folder=folder, 
                         share_url=share_url, 
                         selected_expire=selected_expire,
                         file_count=file_count,
                         folder_size=folder_size,
                         e2e_count=e2e_count,
                         inherited_public=inherited_public,
                         inherited_browsable=inherited_browsable,
                         inherited_e2e=False)

@app.route('/folder/<int:folder_id>/files', methods=['GET'])
@login_required
def folder_files_list(folder_id):
    """Return a list of all files in a folder (recursively) for batch re-encryption."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'NOT AUTHENTICATED'}), 401

    folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
    if not folder:
        return jsonify({'error': 'FOLDER NOT FOUND'}), 404
    
    def collect_files(fid):
        # AUDIT FIX (finding 7): bulk-load the whole subtree (O(depth) IN
        # queries) instead of 2 queries per folder, and walk it iteratively
        # with a visited/size guard so a parent_id cycle or a very large tree
        # can neither recurse forever nor trigger an N+1 query storm.
        subtree_ids = _collect_descendant_folder_ids([fid], include_roots=True, trashed=False)
        if not subtree_ids:
            return []
        sub_folders = Folder.query.filter(
            Folder.id.in_(list(subtree_ids)),
            Folder.user_id == user.id,
            Folder.is_trashed == False,
        ).all()
        children_map = {}
        for fld in sub_folders:
            children_map.setdefault(fld.parent_id, []).append(fld.id)
        files_by_folder = {}
        for f in File.query.filter(
            File.folder_id.in_(list(subtree_ids)),
            File.registered_user_id == user.id,
            File.is_temp_upload == False,
            File.is_trashed == False,
        ).all():
            files_by_folder.setdefault(f.folder_id, []).append(f)

        result = []
        stack = [fid]
        visited = set()
        while stack:
            cur = stack.pop()
            if cur in visited:
                continue
            visited.add(cur)
            if len(visited) > _MAX_FOLDER_TREE_NODES:
                print(f'[WARNING] folder_files_list walk exceeded {_MAX_FOLDER_TREE_NODES} folders; truncating')
                break
            for f in files_by_folder.get(cur, []):
                result.append({
                    'id': f.id,
                    'name': f.orig_name,
                    'is_e2e': f.is_e2e_encrypted,
                    'is_public': f.is_public,
                    'size': f.size,
                    'encrypted_name': f.encrypted_name if f.is_e2e_encrypted and f.encrypted_name else None,
                    'name_nonce': f.name_nonce if f.is_e2e_encrypted and f.encrypted_name else None,
                    'encrypted_file_key': f.encrypted_file_key if f.is_e2e_encrypted else None,
                    'file_key_nonce': f.file_key_nonce if f.is_e2e_encrypted else None,
                })
            kids = children_map.get(cur, [])
            # reversed() so children pop in their original (name) order,
            # matching the old depth-first recursion.
            stack.extend(reversed(kids))
        return result
    
    files = collect_files(folder.id)
    print(f'[FOLDER] Listed {len(files)} files in folder {_log_safe(folder.name)} for user {user.username}')
    return jsonify({'files': files})

@app.route('/files/audio-recursive')
@app.route('/files/audio-recursive/<int:folder_id>')
@login_required
def files_audio_recursive(folder_id=None):
    """Return audio files from all subfolders (recursively) of the given folder.
    Used by the music player to build playlists that include subfolder tracks.
    Does NOT include files in the current folder (those are already in the DOM)."""
    audio_exts = {'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'}
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'NOT AUTHENTICATED'}), 401

    # Get immediate subfolders of the target folder
    subfolders = Folder.query.filter_by(user_id=user.id, parent_id=folder_id, is_trashed=False).all()
    if not subfolders:
        return jsonify({'files': []})

    now_utc = datetime.now(timezone.utc)

    # AUDIT FIX (finding 7): bulk-load the subtree under each immediate
    # subfolder (O(depth) IN queries) and walk it iteratively with a visited
    # guard, instead of 2 queries per folder with unbounded recursion.
    def _collect_audio_from(roots):
        root_ids = [sf.id for sf in roots]
        subtree_ids = set()
        for _rid in root_ids:
            subtree_ids |= _collect_descendant_folder_ids([_rid], include_roots=True, trashed=False)
        if not subtree_ids:
            return []
        sub_folders = Folder.query.filter(
            Folder.id.in_(list(subtree_ids)),
            Folder.user_id == user.id,
            Folder.is_trashed == False,
        ).all()
        children_map = {}
        for fld in sub_folders:
            children_map.setdefault(fld.parent_id, []).append(fld.id)
        files_by_folder = {}
        for f in File.query.filter(
            File.folder_id.in_(list(subtree_ids)),
            File.registered_user_id == user.id,
            File.is_temp_upload == False,
            File.is_trashed == False,
        ).all():
            files_by_folder.setdefault(f.folder_id, []).append(f)

        result = []
        stack = list(reversed(root_ids))
        visited = set()
        while stack:
            cur = stack.pop()
            if cur in visited:
                continue
            visited.add(cur)
            if len(visited) > _MAX_FOLDER_TREE_NODES:
                print(f'[WARNING] audio-recursive walk exceeded {_MAX_FOLDER_TREE_NODES} folders; truncating')
                break
            for f in files_by_folder.get(cur, []):
                if f.get_expires_at_aware() is not None and f.get_expires_at_aware() < now_utc:
                    continue
                ext = _get_compound_ext(f.orig_name)
                if ext not in audio_exts:
                    continue
                result.append({
                    'id': f.id,
                    'name': f.orig_name,
                    'extension': ext,
                    'is_e2e': f.is_e2e_encrypted,
                })
            stack.extend(reversed(children_map.get(cur, [])))
        return result

    audio_files = _collect_audio_from(subfolders)

    print(f'[MUSIC] Found {len(audio_files)} audio files in subfolders of folder_id={folder_id} for user {user.username}')
    return jsonify({'files': audio_files})

@app.route('/file/<file_id>/move', methods=['POST'])
@login_required
def move_file(file_id):
    # Decorator handles authentication
    user = _current_session_user()
    
    target_folder_id = request.form.get('folder_id')
    try:
        target_folder_id = int(target_folder_id) if target_folder_id and target_folder_id != 'null' else None
    except (TypeError, ValueError):
        return jsonify({'error': 'INVALID FOLDER ID'}), 400
    
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
        if not file:
            return jsonify({'error': 'File not found'}), 404
        if not _lock_live_folder_for_placement(target_folder_id, user.id):
            return jsonify({'error': 'Target folder not found'}), 404

        # E2E mixing is allowed — users can freely move files regardless of encryption type
        source_folder_id = file.folder_id
        old_share = _effective_folder_share_info(source_folder_id)
        new_share = _effective_folder_share_info(target_folder_id)
        file.folder_id = target_folder_id
        file.original_folder_id = None  # explicit move supersedes the restore breadcrumb
        if file.is_e2e_encrypted and (old_share or {}).get('share_token') != (new_share or {}).get('share_token'):
            _clear_file_folder_link_key(file)
        touch_folder(source_folder_id)
        touch_folder(target_folder_id)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    print(f'[FILE] Moved file {file.orig_name} to folder {target_folder_id}')
    
    # If E2E file moved into a shared folder tree, tell client to generate link key
    result = {'success': True}
    if file.is_e2e_encrypted and file.encrypted_file_key and target_folder_id:
        ancestor_info = get_shared_ancestor_info(target_folder_id)
        if ancestor_info:
            result['needs_link_key'] = True
            result['ancestor_share_token'] = ancestor_info['share_token']
            result['ancestor_folder_id'] = ancestor_info['folder_id']
            result['file_id'] = file.id
    return jsonify(result)

@app.route('/folder/<int:folder_id>/move', methods=['POST'])
@login_required
def move_folder(folder_id):
    """Move a folder to a new parent folder"""
    user = _current_session_user()

    data = request.get_json(silent=True) if request.is_json else None
    if data is not None and not isinstance(data, dict):
        # Must not fall through to the form branch, which reads as 'move to root'.
        return jsonify({'error': 'INVALID REQUEST'}), 400
    if data:
        target_folder_id = data.get('target_folder_id')
    else:
        target_folder_id = request.form.get('folder_id')
    try:
        target_folder_id = int(target_folder_id) if target_folder_id and str(target_folder_id) != 'null' else None
    except (TypeError, ValueError):
        return jsonify({'error': 'INVALID FOLDER ID'}), 400

    # AUDIT FIX D3 (cycle TOCTOU): the descendant check below and the parent_id
    # assignment are not atomic, so two concurrent moves (A -> B and B -> A) could
    # each see a legal tree and together commit a parent cycle -- which then hangs
    # every recursive folder walk, including the cleanup scheduler. Serialize all
    # of this user's re-parenting under one lock.
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    tree_lock = _acquire_user_folder_tree_lock(user.id)
    try:
        folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
        if not folder:
            return jsonify({'error': 'Folder not found'}), 404

        # Cannot move a folder into itself
        if target_folder_id == folder_id:
            return jsonify({'error': 'Cannot move a folder into itself'}), 400

        # Cannot move to a descendant (would create a cycle).
        # _folder_ancestor_ids is cycle- and depth-bounded.
        if target_folder_id is not None:
            target_chain = _folder_ancestor_ids(target_folder_id)
            if folder_id in target_chain or not _folder_ancestry_complete(target_chain):
                return jsonify({'error': 'Cannot move a folder into one of its subfolders'}), 400

        # Verify target folder exists and belongs to user
        if target_folder_id is not None:
            target_folder = Folder.query.filter_by(id=target_folder_id, user_id=user.id, is_trashed=False).first()
            if not target_folder:
                return jsonify({'error': 'Target folder not found'}), 404

        tree_ids = _collect_descendant_folder_ids([folder.id], include_roots=True)
        tree_files = File.query.filter(
            File.folder_id.in_(list(tree_ids)),
            File.is_temp_upload == False,
            File.is_trashed == False,
            File.is_e2e_encrypted == True,
        ).all()
        old_share_tokens = {
            f.id: (_effective_folder_share_info(f.folder_id) or {}).get('share_token')
            for f in tree_files
        }

        # E2E mixing is allowed — users can freely move folders regardless of encryption types
        source_parent_id = folder.parent_id
        folder.parent_id = target_folder_id
        folder.original_parent_id = None  # explicit move supersedes the restore breadcrumb
        folder.updated_at = datetime.now(timezone.utc)
        moved_e2e_ids = []
        for tree_file in tree_files:
            new_share = _effective_folder_share_info(tree_file.folder_id)
            if old_share_tokens.get(tree_file.id) != (new_share or {}).get('share_token'):
                _clear_file_folder_link_key(tree_file)
                if new_share and tree_file.encrypted_file_key:
                    moved_e2e_ids.append(tree_file.id)
        touch_folder(source_parent_id)
        touch_folder(target_folder_id)
        db.session.commit()
    finally:
        _release_user_folder_tree_lock(tree_lock)
        _release_lifecycle_lock(lifecycle_lock)

    print(f'[FOLDER] Moved folder {_log_safe(folder.name)} to parent {target_folder_id}')
    
    # If folder moved into a shared tree, collect all E2E files needing link keys
    result = {'success': True}
    if target_folder_id is not None:
        ancestor_info = get_shared_ancestor_info(target_folder_id)
        if ancestor_info:
            if moved_e2e_ids:
                result['needs_link_keys'] = True
                result['ancestor_share_token'] = ancestor_info['share_token']
                result['ancestor_folder_id'] = ancestor_info['folder_id']
                result['file_ids'] = moved_e2e_ids
    return jsonify(result)

@app.route('/file/<file_id>/properties', methods=['GET'])
@login_required
def file_properties(file_id):
    # Decorator handles authentication
    user = _current_session_user()
    
    file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
    if not file:
        return jsonify({'error': 'File not found'}), 404
    
    return jsonify({
        'id': file.id,
        'name': file.orig_name,
        'size': file.size,
        'size_formatted': format_bytes_for_filesize(file.size),
        'uploaded': file.get_upload_time_aware().strftime('%Y-%m-%d %H:%M UTC'),
        'expires': file.get_expires_at_aware().strftime('%Y-%m-%d %H:%M UTC') if file.expires_at else 'Never',
        'downloads': file.download_count,
        'max_downloads': file.max_downloads if file.max_downloads else 'Unlimited',
        'encrypted': file.is_e2e_encrypted,
        'is_public': file.is_public,
        'has_password': file.password_hash is not None,
        'locked_e2e': False
    })

@app.route('/file/<file_id>/manage-data', methods=['GET'])
@login_required
def file_manage_data(file_id):
    """Return JSON data needed to render inline manage modal for a file."""
    user = _current_session_user()
    file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
    if not file:
        return jsonify({'error': 'File not found'}), 404

    # Don't serve manage data for trashed files
    if file.is_trashed:
        return jsonify({'error': 'File is in trash'}), 404

    # Calculate selected expiry
    selected_expire = None
    expires_at_aware = file.get_expires_at_aware()
    if expires_at_aware is None:
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

    # Build share URL (always use long /f/ format)
    share_url = f'https://{domain}/f/{file.id}/{urllib.parse.quote(file.orig_name)}'

    # Check inherited statuses
    inherited_public = is_file_in_public_folder(file) if not file.is_e2e_encrypted else None
    parent_is_browsable = is_file_in_browsable_folder(file) is not None

    # For E2E files in shared folders, include ancestor share_token for HKDF derivation
    ancestor_share_token = None
    if file.is_e2e_encrypted and file.folder_id:
        ancestor_info = get_shared_ancestor_info(file.folder_id)
        if ancestor_info:
            ancestor_share_token = ancestor_info['share_token']

    return jsonify({
        'id': file.id,
        'name': file.orig_name,
        'size': file.size,
        'size_formatted': format_bytes_for_filesize(file.size),
        'uploaded': file.get_upload_time_aware().strftime('%b %d, %Y %H:%M'),
        'expires': file.get_expires_at_aware().strftime('%b %d, %Y %H:%M') if file.expires_at else 'NEVER',
        'expires_at': file.expires_at.isoformat() if file.expires_at else None,
        'selected_expire': selected_expire,
        'is_e2e': file.is_e2e_encrypted,
        'is_public': file.is_public,
        'has_password': file.password_hash is not None,
        'has_thumbnail': file.has_thumbnail,
        'thumbnailable': (not file.is_e2e_encrypted) and _is_thumbnailable_name(file.orig_name),
        'management_token': file.management_token,
        'share_url': share_url,
        'download_url': f'/f/{file.id}/{urllib.parse.quote(file.orig_name)}',
        'parent_is_browsable': parent_is_browsable,
        'inherited_public': bool(inherited_public) if inherited_public is not None else False,
        'locked_e2e': False,
        'download_count': file.download_count,
        'max_downloads': file.max_downloads,
        'is_temp': file.is_temp_upload,
        'folder_id': file.folder_id,
        'is_link_shared': bool(file.is_link_shared),
        'has_file_link_key': bool(file.link_encrypted_file_key),
        'has_folder_link_key': bool(getattr(file, 'folder_link_encrypted_file_key', None)),
        'ancestor_share_token': ancestor_share_token,
        'enc_thumb': (lambda _tb: base64.b64encode(_tb).decode('ascii') if _tb else None)(load_thumbnail_from_disk(file.id, is_e2e=True)) if file.is_e2e_encrypted and file.has_thumbnail and file.encrypted_thumbnail_nonce else None,
        'enc_thumb_nonce': file.encrypted_thumbnail_nonce if file.is_e2e_encrypted and file.has_thumbnail and file.encrypted_thumbnail_nonce else None,
        'encrypted_name': file.encrypted_name if file.is_e2e_encrypted and file.encrypted_name else None,
        'name_nonce': file.name_nonce if file.is_e2e_encrypted and file.encrypted_name else None,
        'encrypted_file_key': file.encrypted_file_key if file.is_e2e_encrypted else None,
        'file_key_nonce': file.file_key_nonce if file.is_e2e_encrypted else None,
        'file_key_salt': file.file_key_salt if file.is_e2e_encrypted else None,
    })

@app.route('/file/manage-data-by-token/<token>', methods=['GET'])
@limiter.limit(file_ops_rate_limit)
def file_manage_data_by_token(token):
    """Return JSON data for manage modal, authenticated by management_token.
    Works for both logged-in users and anonymous guest uploads."""
    file = File.query.filter_by(management_token=token).first()
    if not file:
        return jsonify({'error': 'File not found'}), 404

    # Auth: same logic as manage() route
    guest_ok = file.registered_user_id is None and session.get('user_id') and session['user_id'] == file.user_id
    cookie_ok = file.registered_user_id is None and bool(file.manager_cookie_id) and hmac.compare_digest(request.cookies.get('onegy_manager') or '', file.manager_cookie_id or '')
    # AUDIT FIX H4: resolve the session user through the epoch-validating helper so
    # a revoked/stale cookie cannot claim ownership or admin here.
    requesting_user = _current_session_user()
    registered_ok = bool(requesting_user) and file.registered_user_id == requesting_user.id
    admin_ok = bool(requesting_user) and bool(requesting_user.is_admin)
    if not (guest_ok or cookie_ok or registered_ok or admin_ok):
        return jsonify({'error': 'ACCESS DENIED'}), 403

    if file.is_trashed:
        return jsonify({'error': 'File is in trash'}), 404

    # Calculate selected expiry
    selected_expire = None
    expires_at_aware = file.get_expires_at_aware()
    if expires_at_aware is None:
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

    # Use short URL when file has a short_code (share page uploads with short URL enabled)
    if file.short_code:
        share_url = f'https://{domain}/s/{file.short_code}'
    else:
        share_url = f'https://{domain}/f/{file.id}/{urllib.parse.quote(file.orig_name)}'

    inherited_public = is_file_in_public_folder(file) if not file.is_e2e_encrypted else None
    parent_is_browsable = is_file_in_browsable_folder(file) is not None

    return jsonify({
        'id': file.id,
        'name': file.orig_name,
        'size': file.size,
        'size_formatted': format_bytes_for_filesize(file.size),
        'uploaded': file.get_upload_time_aware().strftime('%b %d, %Y %H:%M'),
        'expires': file.get_expires_at_aware().strftime('%b %d, %Y %H:%M') if file.expires_at else 'NEVER',
        'expires_at': file.expires_at.isoformat() if file.expires_at else None,
        'selected_expire': selected_expire,
        'is_e2e': file.is_e2e_encrypted,
        'is_public': file.is_public,
        'has_password': file.password_hash is not None,
        'has_thumbnail': file.has_thumbnail,
        'thumbnailable': (not file.is_e2e_encrypted) and _is_thumbnailable_name(file.orig_name),
        'management_token': file.management_token,
        'share_url': share_url,
        'download_url': f'/f/{file.id}/{urllib.parse.quote(file.orig_name)}',
        'parent_is_browsable': parent_is_browsable,
        'inherited_public': bool(inherited_public) if inherited_public is not None else False,
        'locked_e2e': False,
        'download_count': file.download_count,
        'max_downloads': file.max_downloads,
        'is_temp': file.is_temp_upload,
        'folder_id': file.folder_id,
        'is_link_shared': bool(file.is_link_shared),
        'has_file_link_key': bool(file.link_encrypted_file_key),
        'has_folder_link_key': bool(getattr(file, 'folder_link_encrypted_file_key', None)),
        'ancestor_share_token': (
            (get_shared_ancestor_info(file.folder_id) or {}).get('share_token')
            if file.is_e2e_encrypted and file.folder_id else None
        ),
        'enc_thumb': (lambda _tb: base64.b64encode(_tb).decode('ascii') if _tb else None)(load_thumbnail_from_disk(file.id, is_e2e=True)) if file.is_e2e_encrypted and file.has_thumbnail and file.encrypted_thumbnail_nonce else None,
        'enc_thumb_nonce': file.encrypted_thumbnail_nonce if file.is_e2e_encrypted and file.has_thumbnail and file.encrypted_thumbnail_nonce else None,
        'encrypted_name': file.encrypted_name if file.is_e2e_encrypted and file.encrypted_name else None,
        'name_nonce': file.name_nonce if file.is_e2e_encrypted and file.encrypted_name else None,
        'encrypted_file_key': file.encrypted_file_key if file.is_e2e_encrypted else None,
        'file_key_nonce': file.file_key_nonce if file.is_e2e_encrypted else None,
        'file_key_salt': file.file_key_salt if file.is_e2e_encrypted else None,
    })

@app.route('/folder/<int:folder_id>/manage-data', methods=['GET'])
@login_required
def folder_manage_data(folder_id):
    """Return JSON data needed to render inline manage modal for a folder."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'NOT AUTHENTICATED'}), 401

    folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
    if not folder:
        return jsonify({'error': 'FOLDER NOT FOUND'}), 404

    # Generate share token if not exists
    if not folder.share_token:
        folder.share_token = str(uuid.uuid4())
        db.session.commit()

    # Bulk-load all user's non-trashed folders and aggregate file stats per folder
    # in 2 queries + in-memory BFS instead of 7N recursive queries
    _all_folders = Folder.query.filter_by(user_id=user.id, is_trashed=False).all()
    _children_map = {}
    _folder_map = {}
    for _f in _all_folders:
        _folder_map[_f.id] = _f
        _children_map.setdefault(_f.parent_id, []).append(_f.id)

    # Collect subtree folder IDs via BFS
    # AUDIT FIX D3: cycle/size guarded.
    _subtree_ids = set(_bfs_folder_ids(folder.id, _children_map))

    # Aggregate file stats for subtree in a single query
    _file_stats = db.session.query(
        db.func.count(File.id),
        db.func.coalesce(db.func.sum(File.size), 0),
        db.func.sum(db.case((File.is_e2e_encrypted == True, 1), else_=0))
    ).filter(
        File.folder_id.in_(_subtree_ids),
        File.is_temp_upload == False,
        File.is_trashed == False
    ).one()
    file_count = _file_stats[0]
    folder_size = _file_stats[1]
    e2e_count = _file_stats[2] or 0

    # Check mixed E2E: any descendant subfolder with different is_e2e setting
    _parent_e2e = folder.is_e2e is True
    has_mixed_e2e = any(
        (_folder_map[fid].is_e2e is True) != _parent_e2e
        for fid in _subtree_ids if fid != folder.id
    )

    # Determine selected expiration
    selected_expire = 'never'
    if folder.expires_at:
        expires_aware = folder.get_expires_at_aware()
        remaining_seconds = (expires_aware - datetime.now(timezone.utc)).total_seconds()
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

    # Check inherited statuses
    inherited_public = is_folder_in_public_ancestor(folder)
    root_browsable = get_root_browsable_ancestor(folder)
    inherited_browsable = root_browsable is not None

    # Build share URL
    safe_folder_name = secure_filename(folder.name)
    if folder.is_browsable or root_browsable is not None:
        share_url = f'https://{domain}/f/{folder.share_token}'
    else:
        share_url = f'https://{domain}/f/{folder.share_token}/{urllib.parse.quote(safe_folder_name)}.zip'

    # For E2E subfolders inside a browsable tree, provide the browsable root's
    # share info so the client can build the correct browse URL with the root's secret
    browsable_ancestor_info = None
    if root_browsable is not None and not folder.is_browsable:
        browsable_ancestor_info = {
            'id': root_browsable.id,
            'share_token': root_browsable.share_token,
            'is_link_shared': bool(root_browsable.is_link_shared),
            'share_url': f'https://{domain}/f/{root_browsable.share_token}',
            'encrypted_name_key': root_browsable.encrypted_name_key,
            'name_key_nonce': root_browsable.name_key_nonce,
        }

    manage_data = {
        'id': folder.id,
        'name': folder.name,
        'share_token': folder.share_token,
        'is_browsable': folder.is_browsable,
        'is_public': folder.is_public,
        'is_e2e': folder.is_e2e is True,
        'created_at': folder.created_at.strftime('%b %d, %Y %H:%M'),
        'expires_at': folder.expires_at.isoformat() if folder.expires_at else None,
        'expires_display': folder.expires_at.strftime('%b %d, %Y %H:%M') if folder.expires_at else 'NEVER',
        'selected_expire': selected_expire,
        'file_count': file_count,
        'folder_size': folder_size,
        'folder_size_formatted': format_bytes_for_filesize(folder_size),
        'download_count': folder.download_count or 0,
        'e2e_count': e2e_count,
        'has_mixed_e2e': has_mixed_e2e,
        'share_url': share_url,
        'inherited_public': bool(inherited_public),
        'inherited_browsable': inherited_browsable,
        'inherited_e2e': False,
        'parent_id': folder.parent_id,
        'is_link_shared': bool(folder.is_link_shared),
        # AUDIT FIX P9: surfaced so a manage-modal control can render the current
        # state of the (now settable) folder share password.
        'has_password': folder.password_hash is not None,
        'browsable_ancestor': browsable_ancestor_info
    }
    # Include encrypted folder name data for client-side decryption
    if folder.is_e2e is True and folder.encrypted_name:
        manage_data['encrypted_name'] = folder.encrypted_name
        manage_data['name_nonce'] = folder.name_nonce
        manage_data['encrypted_name_key'] = folder.encrypted_name_key
        manage_data['name_key_nonce'] = folder.name_key_nonce
    return jsonify(manage_data)

@app.route('/file/<file_id>/toggle-visibility', methods=['POST'])
@login_required
def toggle_file_visibility(file_id):
    # Decorator handles authentication
    user = _current_session_user()
    
    file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
    if not file:
        return jsonify({'error': 'File not found'}), 404
    
    # For E2E files, don't allow simple toggle — requires re-encryption via /make-public or /make-private
    if file.is_e2e_encrypted:
        return jsonify({'error': 'E2E files require re-encryption to change visibility', 'requires_reencrypt': True}), 400
    
    # Toggle visibility for non-E2E (Fernet) files only
    file.is_public = not file.is_public
    db.session.commit()
    
    print(f'[FILE] Toggled visibility for {file.orig_name} to {"public" if file.is_public else "private"}')
    return jsonify({'success': True, 'is_public': file.is_public})

@app.route('/file/<file_id>/set-password', methods=['POST'])
@login_required
def set_file_password(file_id):
    """Set or remove a password on a file from the dashboard properties modal."""
    user = _current_session_user()
    
    file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
    if not file:
        return jsonify({'error': 'File not found'}), 404
    
    # E2E files should not have passwords (they use client-side encryption)
    if file.is_e2e_encrypted:
        return jsonify({'error': 'E2E encrypted files do not support passwords'}), 400
    
    password = request.form.get('password', '').strip()
    
    if password:
        # AUDIT FIX L5: pin pbkdf2:sha256 to stay consistent with the rest
        # of the codebase (user/recovery hashes) and avoid silent algorithm
        # drift if the Werkzeug default changes across versions.
        file.password_hash = generate_password_hash(password, method='pbkdf2:sha256')
        print(f'[FILE] Password set for {file.orig_name} by user: {user.username}')
    else:
        file.password_hash = None
        print(f'[FILE] Password removed for {file.orig_name} by user: {user.username}')
    
    db.session.commit()
    return jsonify({'success': True, 'has_password': file.password_hash is not None})

@app.route('/folder/<int:folder_id>/set-password', methods=['POST'])
@login_required
@limiter.limit(file_ops_rate_limit)
def set_folder_password(folder_id):
    """Set or remove the share password on a folder.

    AUDIT FIX P9: Folder.password_hash was declared on the model but NEVER
    assigned anywhere in the codebase -- there was no route and no UI field. The
    whole server-side gate (_folder_share_password_ok, _remember_folder_share_access,
    the _share_pw_* lockout, the pw.html is_folder=True branch) was therefore
    unreachable, and EVERY shared folder was unconditionally readable by anyone
    holding the token. This exposes the capability; it follows the same shape as
    set_file_password(). NOTE: the manage modal still needs a control
    wired to this endpoint (see folder_manage_data's `has_password`).

    The password gates NON-OWNER access only; the owner always reaches the folder
    through their own dashboard."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'NOT AUTHENTICATED'}), 401

    folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
    if not folder:
        return jsonify({'error': 'FOLDER NOT FOUND'}), 404

    password = request.form.get('password', '').strip()

    if password:
        # AUDIT FIX L5: pin pbkdf2:sha256 to stay consistent with the rest of the
        # codebase and avoid silent algorithm drift across Werkzeug versions.
        folder.password_hash = generate_password_hash(password, method='pbkdf2:sha256')
        print(f'[FOLDER] Share password set for {_log_safe(folder.name)} by user: {user.username}')
    else:
        folder.password_hash = None
        print(f'[FOLDER] Share password removed for {_log_safe(folder.name)} by user: {user.username}')

    # Any marker minted against the OLD password hash stops matching because the
    # hash is part of the HMAC input (_share_access_marker), so changing or
    # clearing the password re-locks every previously unlocked visitor session.
    folder.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    _share_pw_clear('folder', folder.id)
    return jsonify({'success': True, 'has_password': folder.password_hash is not None})

@app.route('/f/<file_id>/make-public', methods=['POST'])
@login_required
@limiter.limit(upload_rate_limit)
def make_file_public(file_id):
    """Convert an E2E-encrypted file to server-side Fernet encryption (public).
    
    The client decrypts the file in the browser, then re-uploads the plaintext.
    The server Fernet-encrypts it and stores it, clearing E2E metadata.
    """
    from werkzeug.exceptions import RequestEntityTooLarge
    user = _current_session_user()
    file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
    if not file:
        return jsonify({'error': 'FILE NOT FOUND'}), 404
    
    if not file.is_e2e_encrypted:
        # Already non-E2E, nothing to convert
        return jsonify({'success': True})

    # AUDIT FIX (upload/download integrity): this route had NO request cap at
    # all, unlike /upload, apiv1_upload and save-content. It writes the new
    # payload's disk_size straight into quota accounting, so an unbounded body
    # could be spooled and a small file converted into a multi-GB one with the
    # quota never consulted. Bound the body to what the user could actually
    # store: their remaining quota plus whatever this file already occupies
    # (the conversion REPLACES the payload, so the old bytes are reclaimed).
    # MUST run before anything touches request.form / request.files.
    _existing_quota_bytes = _quota_bytes_for_file(file)
    _remaining_bytes = max(
        int(user.storage_limit_gb * 1024 * 1024 * 1024) - user.get_storage_used(), 0
    ) + _existing_quota_bytes
    if _multipart_body_exceeds(_remaining_bytes):
        return _storage_limit_json(user)
    _set_request_upload_cap(_remaining_bytes)

    if file.encrypted_name and not request.form.get('real_name'):
        return jsonify({'error': 'REAL FILENAME REQUIRED'}), 400
    
    if 'file' not in request.files:
        return jsonify({'error': 'NO FILE DATA PROVIDED'}), 400
    
    uploaded = request.files['file']
    temp_dir = None
    quota_lock = None
    rewrite_committed = False
    # AUDIT FIX (5th audit, concurrent staged rewrites): serialize rewrites of
    # this file so the shared .new/.committed/.meta staging slot cannot be
    # clobbered by an overlapping conversion/edit of the same file.
    _rewrite_lock = _acquire_file_rewrite_lock(file.id)
    
    try:
        temp_dir = create_work_dir(f'reencrypt_{file_id}_')
        temp_plain_path = os.path.join(temp_dir, 'plaintext')
        temp_encrypted_path = os.path.join(temp_dir, f'{file_id}.enc')
        
        # Save the decrypted data from the client
        uploaded.save(temp_plain_path)
        plain_size = os.path.getsize(temp_plain_path)
        
        print(f'[FILE] make-public: received {plain_size} bytes of decrypted data for {file.orig_name}')
        
        # Fernet-encrypt the plaintext (hashes computed in the same pass)
        plain_hash, fernet_payload_checksum = encrypt_file_chunked(temp_plain_path, temp_encrypted_path)
        fernet_disk_size = os.path.getsize(temp_encrypted_path)

        # AUDIT FIX (upload/download integrity): take the per-user quota flock
        # ONLY now -- after the (slow) body transfer and encryption -- and hold
        # it across the check-and-commit window, exactly like the other write
        # paths. Acquiring it before the transfer would serialize every upload
        # by this user for the whole transfer (the /upload DoS documented at the
        # guest path). Lock ORDER is rewrite-lock then quota-lock everywhere.
        quota_lock = _acquire_user_quota_lock(user.id)
        _refresh_quota_snapshot()
        user = db.session.get(User, user.id)
        file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
        if not file or not file.is_e2e_encrypted:
            return jsonify({'error': 'FILE CHANGED DURING CONVERSION'}), 409
        _size_delta = fernet_disk_size - _quota_bytes_for_file(file)
        if _size_delta > 0 and not user.has_storage_available(_size_delta):
            return _storage_limit_json(user)

        # Stage the new file alongside the original (writes to {filename}.new)
        # The original E2E file is preserved until DB commit succeeds
        storage.store_file_staged(file.filename, temp_encrypted_path)
        
        # Update file record — only change encryption method, preserve visibility
        file.is_e2e_encrypted = False
        file.is_legacy_encrypted = False
        file.encrypted_file_key = None
        file.file_key_nonce = None
        file.file_key_salt = None
        file.e2e_salt = None
        file.e2e_iv = None
        # Clear thumbnail metadata (disk deletion deferred to after commit to preserve
        # the E2E thumbnail if the commit fails — it cannot be regenerated server-side)
        file.encrypted_thumbnail_nonce = None
        file.has_thumbnail = False
        # Clear link-wrapped keys — they reference the old E2E file key and are now invalid
        file.link_encrypted_file_key = None
        file.link_file_key_nonce = None
        file.folder_link_encrypted_file_key = None
        file.folder_link_file_key_nonce = None
        # Clear encrypted filename (reverting to plaintext)
        if file.encrypted_name:
            # Restore real filename from form data if client provided it.
            # AUDIT FIX (upload/download integrity): this is the ONE place a
            # filename crosses from ciphertext into a server-trusted plaintext
            # column, and it used to be assigned raw -- no length cap, no
            # '/' '\' '..' NUL stripping, unlike rename_file(). Sanitize it the
            # same way and refuse a name that sanitizes away to nothing.
            real_name = sanitize_plaintext_name(request.form.get('real_name'))
            if not real_name:
                storage.rollback_staged_file(file.filename)
                db.session.rollback()
                return jsonify({'error': 'INVALID REAL FILENAME'}), 400
            file.orig_name = real_name
            file.encrypted_name = None
            file.name_nonce = None
            file.stored_extension = None
        file.size = plain_size
        file.disk_size = fernet_disk_size
        file.content_hash = plain_hash
        file.payload_checksum = fernet_payload_checksum
        _prep_err = _prepare_staged_rewrite_commit(file, {
            'file_id': file.id,
            'size': plain_size,
            'disk_size': fernet_disk_size,
            'content_hash': plain_hash,
            'payload_checksum': fernet_payload_checksum,
            'encrypted_name': file.encrypted_name,
            'name_nonce': file.name_nonce,
            'encrypted_file_key': file.encrypted_file_key,
            'file_key_nonce': file.file_key_nonce,
        })
        if _prep_err:
            return _prep_err
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            storage.rollback_staged_file(file.filename)
            raise
        
        rewrite_committed = True
        # DB commit succeeded — write marker so crash recovery knows this was committed,
        # then atomically replace the original file with the staged copy
        storage.mark_staged_file_committed(file.filename)
        storage.finalize_staged_file(file.filename)

        _commit_file_post_finalize_state(file.id, 'E2E TO FERNET CONVERSION')
        
        # Now safe to delete old E2E thumbnail from disk (after successful commit)
        delete_thumbnail_from_disk(file.id)
        
        # Generate thumbnail in the bounded background queue.
        _schedule_thumbnail_bg(file_id, log_prefix='FILE')
        
        print(f'[FILE] Converted {file.orig_name} from E2E to Fernet (server-side)')
        return jsonify({'success': True})
    
    except RequestEntityTooLarge:
        if rewrite_committed:
            print(f'[ERROR] Conversion failed after commit for {file_id}; preserving staged recovery artifacts')
            return jsonify({'error': 'RE-ENCRYPTION FAILED'}), 500
        # AUDIT FIX (upload/download integrity): the per-request quota cap fired.
        try:
            db.session.rollback()
        except Exception:
            pass
        try:
            storage.rollback_staged_file(file.filename)
        except Exception:
            pass
        return _storage_limit_json(user)
    except Exception as e:
        print(f'[ERROR] make-public failed for {file_id}: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({'error': 'RE-ENCRYPTION FAILED'}), 500
    finally:
        _release_user_quota_lock(quota_lock)
        _release_file_rewrite_lock(_rewrite_lock)
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

@app.route('/f/<file_id>/make-private', methods=['POST'])
@login_required
@limiter.limit(upload_rate_limit)
def make_file_private(file_id):
    """Convert a server-side Fernet-encrypted file to E2E encryption (private).
    
    The client downloads and decrypts the file, re-encrypts it with a new
    per-file key (wrapped by master key), then uploads the E2E-encrypted data.
    """
    from werkzeug.exceptions import RequestEntityTooLarge
    user = _current_session_user()
    file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
    if not file:
        return jsonify({'error': 'FILE NOT FOUND'}), 404
    
    if file.is_e2e_encrypted:
        # Already E2E, just make it private
        file.is_public = False
        db.session.commit()
        return jsonify({'success': True})

    # AUDIT FIX (upload/download integrity): this route had NO request cap, no
    # quota check and no quota lock, yet it writes disk_size straight into quota
    # accounting -- a 1 KB file could be converted into a multi-GB one with the
    # quota never consulted, and the missing cap also let a single request force
    # an unbounded spool (and an unbounded thumbnail read, see below). Bound the
    # body to the user's remaining quota plus what this file already occupies,
    # BEFORE anything touches request.form / request.files.
    _existing_quota_bytes = _quota_bytes_for_file(file)
    _remaining_bytes = max(
        int(user.storage_limit_gb * 1024 * 1024 * 1024) - user.get_storage_used(), 0
    ) + _existing_quota_bytes
    if _multipart_body_exceeds(_remaining_bytes):
        return _storage_limit_json(user)
    _set_request_upload_cap(_remaining_bytes)

    if 'file' not in request.files:
        return jsonify({'error': 'NO FILE DATA PROVIDED'}), 400
    
    encrypted_file_key = request.form.get('encrypted_file_key')
    file_key_nonce = request.form.get('file_key_nonce')
    mp_enc_name = request.form.get('encrypted_name')
    mp_name_nonce = request.form.get('name_nonce')
    mp_stored_ext = normalize_stored_extension(request.form.get('stored_extension'))
    
    if not encrypted_file_key or not file_key_nonce:
        return jsonify({'error': 'MISSING E2E KEY METADATA'}), 400
    if not mp_enc_name or not mp_name_nonce:
        return jsonify({'error': 'ENCRYPTED FILENAME METADATA REQUIRED'}), 400
    _wrap_err = _e2ee_wrap_field_error((
        ('encrypted_file_key', encrypted_file_key, 48),
        ('file_key_nonce', file_key_nonce, 12),
        ('encrypted_name', mp_enc_name, None),
        ('name_nonce', mp_name_nonce, 12),
    ))
    if _wrap_err:
        return _wrap_err

    uploaded = request.files['file']
    temp_dir = None
    quota_lock = None
    rewrite_committed = False
    # AUDIT FIX (5th audit, concurrent staged rewrites): serialize same-file rewrites.
    _rewrite_lock = _acquire_file_rewrite_lock(file.id)
    
    try:
        temp_dir = create_work_dir(f'reencrypt_{file_id}_')
        temp_e2e_path = os.path.join(temp_dir, f'{file_id}.enc')
        
        # Save the E2E-encrypted data from the client
        uploaded.save(temp_e2e_path)
        e2e_size = os.path.getsize(temp_e2e_path)

        # ── AUDIT FIX (upload/download integrity): VALIDATE BEFORE DESTROYING ──
        # This route stages the uploaded blob and then finalize_staged_file()
        # atomically REPLACES the Fernet ciphertext -- the only copy the server
        # can decrypt. There was no validation whatsoever: a 0-byte body, a
        # half-finished client-side encrypt, or an aborted crypto pass silently
        # and IRREVERSIBLY replaced the user's file with garbage, and the
        # staged-commit machinery made that corruption durable. The server holds
        # no key, so we cannot decrypt -- but we CAN prove the container is
        # structurally complete: 17-byte header (version in {1,2}, chunk count,
        # base nonce) followed by exactly `chunk_count` well-framed AES-GCM
        # records with no shortfall and no trailing bytes. Anything else is
        # rejected with a 400 and the ORIGINAL FILE IS LEFT UNTOUCHED (nothing
        # has been staged or committed at this point).
        _container_ok, _container_err = validate_e2ee_container(temp_e2e_path)
        if not _container_ok:
            print(f'[ERROR] make-private REJECTED for {file_id}: uploaded blob is not a well-formed '
                  f'E2EE container ({_container_err}); original file left untouched')
            return jsonify({
                'error': f'UPLOADED DATA IS NOT A VALID ENCRYPTED FILE: {_container_err}'
            }), 400

        e2e_hash = _sha256_file(temp_e2e_path)
        
        print(f'[FILE] make-private: received {e2e_size} bytes of E2E data for {file.orig_name}')

        # AUDIT FIX (upload/download integrity): quota flock taken only now, so
        # it is NOT held across the network transfer, and held through the
        # check -> commit window. Lock order is rewrite-lock then quota-lock.
        quota_lock = _acquire_user_quota_lock(user.id)
        _refresh_quota_snapshot()
        user = db.session.get(User, user.id)
        file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
        if not file or file.is_e2e_encrypted:
            return jsonify({'error': 'FILE CHANGED DURING CONVERSION'}), 409
        _size_delta = e2e_size - _quota_bytes_for_file(file)
        if _size_delta > 0 and not user.has_storage_available(_size_delta):
            return _storage_limit_json(user)

        # Stage the new file alongside the original (writes to {filename}.new)
        # The original Fernet file is preserved until DB commit succeeds
        storage.store_file_staged(file.filename, temp_e2e_path)
        
        # Update file record
        was_public = file.is_public
        file.is_e2e_encrypted = True
        file.is_public = False
        file.is_legacy_encrypted = False
        file.encrypted_file_key = encrypted_file_key
        file.file_key_nonce = file_key_nonce
        file.file_key_salt = None  # Master key wrapped, no salt needed
        file.e2e_salt = None
        file.e2e_iv = None
        # Clear stale link-wrapped keys — the file key changed, so any old link key is invalid.
        # The client will generate fresh link keys after this call if the folder is shared.
        file.link_encrypted_file_key = None
        file.link_file_key_nonce = None
        file.folder_link_encrypted_file_key = None
        file.folder_link_file_key_nonce = None
        file.size = e2e_size
        file.disk_size = e2e_size
        file.content_hash = e2e_hash
        file.payload_checksum = e2e_hash
        
        file.encrypted_name = mp_enc_name
        file.name_nonce = mp_name_nonce
        file.stored_extension = mp_stored_ext
        ext_part = file.stored_extension or ''
        file.orig_name = f'encrypted_{file.id[:8]}{ext_part}'

        _prep_err = _prepare_staged_rewrite_commit(file, {
            'file_id': file.id,
            'size': e2e_size,
            'disk_size': e2e_size,
            'content_hash': e2e_hash,
            'payload_checksum': e2e_hash,
            'encrypted_name': file.encrypted_name,
            'name_nonce': file.name_nonce,
            'encrypted_file_key': encrypted_file_key,
            'file_key_nonce': file_key_nonce,
        })
        if _prep_err:
            return _prep_err

        # Save E2E encrypted thumbnail if provided (before commit so flag is correct)
        mp_enc_thumb = request.files.get('encrypted_thumbnail')
        mp_enc_thumb_nonce = request.form.get('thumbnail_nonce')
        _new_e2e_thumb_saved = False
        if mp_enc_thumb and mp_enc_thumb_nonce:
            try:
                # AUDIT FIX (upload/download integrity): bounded read -- the old
                # `mp_enc_thumb.read()` materialised the WHOLE part in the worker
                # heap and only then compared its length, which on this
                # previously-uncapped route was an OOM kill that aborted every
                # other in-flight upload and download on the worker.
                mp_thumb_bytes, mp_thumb_oversized = read_bounded_upload_part(
                    mp_enc_thumb, _MAX_ENCRYPTED_THUMBNAIL_BYTES)
                if mp_thumb_oversized:
                    print(f'[THUMBNAIL] E2E thumbnail for {file.id} exceeds '
                          f'{_MAX_ENCRYPTED_THUMBNAIL_BYTES} bytes, skipping')
                    file.has_thumbnail = False
                elif mp_thumb_bytes and save_thumbnail_to_disk(file.id, mp_thumb_bytes, is_e2e=True):
                    file.encrypted_thumbnail_nonce = mp_enc_thumb_nonce
                    file.has_thumbnail = True
                    _new_e2e_thumb_saved = True
                else:
                    file.has_thumbnail = False
            except ReplicaSessionRollbackError:
                # AUDIT FIX H3: replica bookkeeping rolled back the shared DB
                # session (expunging this request's pending changes). Aborting
                # is the only safe move -- the outer handler fails the request
                # and discards the staged rewrite.
                raise
            except Exception as e:
                print(f'[FILE] E2E thumbnail save failed (non-critical): {e}')
                file.has_thumbnail = False
        else:
            file.encrypted_thumbnail_nonce = None
            file.has_thumbnail = False

        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            storage.rollback_staged_file(file.filename)
            # Clean up new E2E thumbnail written before the failed commit
            if _new_e2e_thumb_saved:
                try:
                    delete_thumbnail_from_disk(file.id)
                except Exception:
                    pass
            raise

        rewrite_committed = True
        # DB commit succeeded — safe to delete old plaintext thumbnail
        # Only delete the .jpg variant (old Fernet thumbnail), not .e2e (new E2E thumbnail)
        #
        # AUDIT FIX (stale thumb_type row could destroy an un-regenerable E2E
        # thumbnail): this used to delete the local '<id>.jpg' and queue its
        # remote tombstone but LEAVE the ThumbnailReplica rows with
        # thumb_type='jpg' behind, still marked 'synced', describing an object
        # that no longer existed anywhere. The scrub then errored those rows, the
        # replication triage read has_source=False and cleared File.has_thumbnail,
        # and the next cycle's has_thumbnail=False sweep deleted ALL thumbnail
        # replica rows for the file — including the healthy '.e2e' ones. E2E
        # thumbnails cannot be regenerated server-side, so that was permanent
        # loss. _delete_thumbnail_by_basename() removes the local file, purges the
        # cache, queues the tombstone AND deletes exactly the jpg replica rows in
        # ONE atomic commit, so no stale tracking survives the conversion.
        try:
            storage._delete_thumbnail_by_basename(f'{file.id}.jpg')
        except Exception as e:
            print(f'[STORAGE] Failed to clean up old thumbnail {file.id}.jpg after conversion: {e}')

        # Write marker so crash recovery knows this was committed,
        # then atomically replace the original file with the staged copy
        storage.mark_staged_file_committed(file.filename)
        storage.finalize_staged_file(file.filename)

        _commit_file_post_finalize_state(file.id, 'FERNET TO E2E CONVERSION')

        print(f'[FILE] Converted {file.orig_name} from Fernet to E2E (private)')

        # Check if this file is in a shared folder — if so, the client needs
        # to generate a link key for browse page access
        result = {'success': True, 'was_public': was_public}
        if file.folder_id:
            ancestor_info = get_shared_ancestor_info(file.folder_id)
            if ancestor_info:
                result['needs_link_key'] = True
                result['ancestor_share_token'] = ancestor_info['share_token']
                result['ancestor_folder_id'] = ancestor_info['folder_id']
                result['file_id'] = file_id
        
        return jsonify(result)
    
    except RequestEntityTooLarge:
        if rewrite_committed:
            print(f'[ERROR] Conversion failed after commit for {file_id}; preserving staged recovery artifacts')
            return jsonify({'error': 'RE-ENCRYPTION FAILED'}), 500
        # AUDIT FIX (upload/download integrity): the per-request quota cap fired.
        try:
            db.session.rollback()
        except Exception:
            pass
        try:
            storage.rollback_staged_file(file.filename)
        except Exception:
            pass
        return _storage_limit_json(user)
    except Exception as e:
        print(f'[ERROR] make-private failed for {file_id}: {e}')
        import traceback
        traceback.print_exc()
        if not rewrite_committed:
            try:
                storage.rollback_staged_file(file.filename)
            except Exception:
                pass
        else:
            # Startup verifies the committed checksum even without a .committed marker.
            print(f'[ERROR] make-private failed after commit for {file_id}; preserving staged recovery artifacts')
        return jsonify({'error': 'RE-ENCRYPTION FAILED'}), 500
    finally:
        _release_user_quota_lock(quota_lock)
        _release_file_rewrite_lock(_rewrite_lock)
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

