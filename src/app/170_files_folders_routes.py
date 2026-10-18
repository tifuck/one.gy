@app.route('/files')
@app.route('/files/folder/<int:folder_id>')
@login_required
def files(folder_id=None):
    # Decorator handles authentication - just get the user
    user = _current_session_user()
    
    # Get current folder if specified
    current_folder = None
    if folder_id:
        current_folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
        if not current_folder:
            flash('FOLDER NOT FOUND', 'error')
            return redirect(url_for('files'))
    
    # Get ALL user's non-trashed folders for the tree view
    all_folders = Folder.query.filter_by(user_id=user.id, is_trashed=False).order_by(Folder.name).all()
    
    # Get ALL user's files for the tree view (filter expired, temp uploads, and trashed)
    all_user_files = File.query.filter_by(registered_user_id=user.id, is_temp_upload=False, is_trashed=False).order_by(File.upload_time.desc()).all()
    all_active_files = [f for f in all_user_files if f.get_expires_at_aware() is None or f.get_expires_at_aware() >= datetime.now(timezone.utc)]
    
    # Get non-trashed folders in current directory (for main view)
    current_folders = Folder.query.filter_by(user_id=user.id, parent_id=folder_id, is_trashed=False).order_by(Folder.name).all()
    
    # Get user's files in current folder (exclude temp uploads and trashed)
    user_files = File.query.filter_by(registered_user_id=user.id, folder_id=folder_id, is_temp_upload=False, is_trashed=False).order_by(File.upload_time.desc()).all()
    
    # Filter out expired files
    active_files = [f for f in user_files if f.get_expires_at_aware() is None or f.get_expires_at_aware() >= datetime.now(timezone.utc)]
    
    # Build breadcrumb trail and check if any parent folder is public/browsable
    breadcrumbs = []
    parent_is_public = False
    parent_is_browsable = False
    if current_folder:
        # AUDIT FIX (finding 7): walk via the already-loaded folder map
        # (avoids one lazy-load SELECT per level) with a visited set, so a
        # corrupt parent_id cycle can never spin this request forever.
        _bc_folder_map = {fld.id: fld for fld in all_folders}
        folder = current_folder
        _bc_seen = set()
        while folder and folder.id not in _bc_seen:
            _bc_seen.add(folder.id)
            breadcrumbs.insert(0, folder)
            if folder.is_public:
                parent_is_public = True
            if folder.is_browsable:
                parent_is_browsable = True
            folder = _bc_folder_map.get(folder.parent_id) if folder.parent_id else None
    
    # Count trashed items for sidebar badge -- bulk load + in-memory BFS (1 query instead of O(N) recursive)
    _all_trash_folders = Folder.query.filter_by(user_id=user.id, is_trashed=True).all()
    _trash_top_folders = [f for f in _all_trash_folders if f.parent_id is None]
    trashed_folder_count = len(_trash_top_folders)
    _trash_ch_map = {}
    for _tf in _all_trash_folders:
        _trash_ch_map.setdefault(_tf.parent_id, []).append(_tf.id)
    trashed_folder_ids_set = set()
    _stk = [_tf.id for _tf in _trash_top_folders]
    while _stk:
        _fid = _stk.pop()
        trashed_folder_ids_set.add(_fid)
        _stk.extend(_trash_ch_map.get(_fid, []))
    all_trashed_files = File.query.filter_by(registered_user_id=user.id, is_trashed=True).all()
    standalone_trashed_file_count = sum(1 for f in all_trashed_files if f.folder_id not in trashed_folder_ids_set)
    trash_count = standalone_trashed_file_count + trashed_folder_count
    
    # Build folder sizes from already-loaded files (no extra queries)
    # Step 1: Sum direct file sizes per folder_id
    direct_sizes = {}
    direct_counts = {}
    for f in all_active_files:
        fid = f.folder_id
        direct_sizes[fid] = direct_sizes.get(fid, 0) + (f.size or 0)
        direct_counts[fid] = direct_counts.get(fid, 0) + 1
    
    # Step 2: Build parent->children map from all_folders
    children_map = {}
    for fld in all_folders:
        children_map.setdefault(fld.parent_id, []).append(fld.id)
    
    # Step 3: Recursive sum with memoization
    folder_sizes = {}
    folder_counts = {}
    _sizing = set()  # parent_id-cycle guard: a folder already on the stack adds nothing
    def calc_folder_size(fld_id):
        if fld_id in folder_sizes:
            return folder_sizes[fld_id], folder_counts[fld_id]
        if fld_id in _sizing:
            return 0, 0
        _sizing.add(fld_id)
        total_size = direct_sizes.get(fld_id, 0)
        total_count = direct_counts.get(fld_id, 0)
        for child_id in children_map.get(fld_id, []):
            child_size, child_count = calc_folder_size(child_id)
            total_size += child_size
            total_count += child_count
        folder_sizes[fld_id] = total_size
        folder_counts[fld_id] = total_count
        _sizing.discard(fld_id)
        return total_size, total_count
    
    for fld in _folders_deepest_first(all_folders):
        calc_folder_size(fld.id)
    
    # Compute folder depths for move modal indentation
    folder_depths = {}
    parent_map = {fld.id: fld.parent_id for fld in all_folders}
    for fld in all_folders:
        depth = 0
        current_pid = fld.parent_id
        visited = set()
        while current_pid is not None and current_pid not in visited:
            visited.add(current_pid)
            depth += 1
            current_pid = parent_map.get(current_pid)
        folder_depths[fld.id] = depth

    # Determine if current folder has E2E content despite is_e2e=False (mixed state)
    # Used by frontend to auto-select E2E upload instead of prompting
    current_folder_has_e2e_content = False
    if current_folder and not (current_folder.is_e2e is True):
        # Iterative: a recursive walk hit RecursionError (HTTP 500) on deep trees.
        subtree_ids = set(_bfs_folder_ids(current_folder.id, children_map))
        has_e2e_files = any(f.is_e2e_encrypted for f in all_active_files if f.folder_id in subtree_ids)
        has_e2e_subfolder = any(fld.is_e2e is True for fld in all_folders if fld.id in subtree_ids and fld.id != current_folder.id)
        current_folder_has_e2e_content = has_e2e_files or has_e2e_subfolder

    return render_template('files.html', user=user, files=active_files, folders=all_folders, all_files=all_active_files, current_folders=current_folders, current_folder=current_folder, breadcrumbs=breadcrumbs, parent_is_public=parent_is_public, parent_is_browsable=parent_is_browsable, datetime=datetime, timezone=timezone, timedelta=timedelta, is_trash_view=False, trash_count=trash_count, folder_sizes=folder_sizes, folder_counts=folder_counts, folder_depths=folder_depths, view_preference=user.view_preference or 'grid', files_background_theme=user.files_background_theme or 'topo', current_folder_has_e2e_content=current_folder_has_e2e_content, root_folder_name=user.root_folder_name or 'FILES')

@app.route('/files/list')
@app.route('/files/list/<int:folder_id>')
@login_required
def files_list_json(folder_id=None):
    """JSON endpoint returning files and folders for the dashboard file browser."""
    user = _current_session_user()

    current_folder = None
    if folder_id:
        current_folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
        if not current_folder:
            return jsonify({'error': 'FOLDER NOT FOUND'}), 404

    # Subfolders in current directory
    current_folders = Folder.query.filter_by(user_id=user.id, parent_id=folder_id, is_trashed=False).order_by(Folder.name).all()

    # Files in current folder
    user_files = File.query.filter_by(registered_user_id=user.id, folder_id=folder_id, is_temp_upload=False, is_trashed=False).order_by(File.upload_time.desc()).all()
    now_utc = datetime.now(timezone.utc)
    active_files = [f for f in user_files if f.get_expires_at_aware() is None or f.get_expires_at_aware() >= now_utc]

    # All non-trashed folders (lightweight)
    all_folders_list = Folder.query.filter_by(user_id=user.id, is_trashed=False).all()

    # Folder size/count/e2e aggregates via SQL GROUP BY (avoids loading all File objects)
    _agg_rows = db.session.query(
        File.folder_id,
        db.func.coalesce(db.func.sum(File.size), 0),
        db.func.count(File.id),
        db.func.sum(db.case((File.is_e2e_encrypted == True, 1), else_=0))
    ).filter(
        File.registered_user_id == user.id,
        File.is_temp_upload == False,
        File.is_trashed == False,
        db.or_(File.expires_at == None, File.expires_at >= now_utc)
    ).group_by(File.folder_id).all()

    direct_sizes = {}
    direct_file_counts = {}
    direct_e2e = {}
    for _fid, _sz, _cnt, _e2e in _agg_rows:
        direct_sizes[_fid] = int(_sz)
        direct_file_counts[_fid] = int(_cnt)
        direct_e2e[_fid] = int(_e2e)

    children_map = {}
    for fld in all_folders_list:
        children_map.setdefault(fld.parent_id, []).append(fld.id)

    # Memoised recursive aggregation over folder tree
    folder_sizes = {}
    folder_file_counts = {}
    folder_e2e_counts = {}
    _agg_stack = set()  # parent_id-cycle guard
    def _calc_agg(fld_id):
        if fld_id in folder_sizes:
            return
        _agg_stack.add(fld_id)
        sz = direct_sizes.get(fld_id, 0)
        cnt = direct_file_counts.get(fld_id, 0)
        e2e = direct_e2e.get(fld_id, 0)
        for child_id in children_map.get(fld_id, []):
            if child_id in _agg_stack:
                continue
            _calc_agg(child_id)
            sz += folder_sizes[child_id]
            cnt += folder_file_counts[child_id]
            e2e += folder_e2e_counts[child_id]
        folder_sizes[fld_id] = sz
        folder_file_counts[fld_id] = cnt
        folder_e2e_counts[fld_id] = e2e
        _agg_stack.discard(fld_id)  # finished: only folders still on the stack form a cycle
    for fld in _folders_deepest_first(all_folders_list):
        _calc_agg(fld.id)

    # Build folder is_e2e lookup for mixed-status detection
    folder_e2e_flag = {fld.id: (fld.is_e2e is True) for fld in all_folders_list}
    folder_has_mixed = {}
    _mixed_stack = set()  # parent_id-cycle guard
    def calc_has_mixed(fld_id):
        if fld_id in folder_has_mixed:
            return folder_has_mixed[fld_id]
        _mixed_stack.add(fld_id)
        parent_e2e = folder_e2e_flag.get(fld_id, True)
        mixed = False
        for child_id in children_map.get(fld_id, []):
            if folder_e2e_flag.get(child_id, True) != parent_e2e:
                mixed = True
                break
            if child_id not in _mixed_stack and calc_has_mixed(child_id):
                mixed = True
                break
        folder_has_mixed[fld_id] = mixed
        _mixed_stack.discard(fld_id)  # finished: only folders still on the stack form a cycle
        return mixed
    for fld in _folders_deepest_first(all_folders_list):
        calc_has_mixed(fld.id)

    # Parent folder ancestor checks — walk using the already-loaded folder map to avoid N+1
    parent_is_public = False
    parent_is_browsable = False
    if current_folder:
        _folder_by_id = {fld.id: fld for fld in all_folders_list}
        folder = current_folder
        # AUDIT FIX (finding 7): visited set so a parent_id cycle cannot
        # spin this walk forever.
        _anc_seen = set()
        while folder and folder.id not in _anc_seen:
            _anc_seen.add(folder.id)
            if folder.is_public:
                parent_is_public = True
            if folder.is_browsable:
                parent_is_browsable = True
            folder = _folder_by_id.get(folder.parent_id) if folder.parent_id else None

    # Trash count -- bulk load all trashed folders (1 query) + BFS in memory instead of recursive DB queries
    _all_trashed_folders_list = Folder.query.filter_by(user_id=user.id, is_trashed=True).all()
    _trash_top = [f for f in _all_trashed_folders_list if f.parent_id is None]
    trashed_folder_count = len(_trash_top)
    _trash_cm = {}
    for _tf in _all_trashed_folders_list:
        _trash_cm.setdefault(_tf.parent_id, []).append(_tf.id)
    trashed_folder_ids_set = set()
    _stk = [_tf.id for _tf in _trash_top]
    while _stk:
        _fid = _stk.pop()
        trashed_folder_ids_set.add(_fid)
        _stk.extend(_trash_cm.get(_fid, []))
    # Count standalone trashed files in SQL — avoid loading every trashed file row into memory
    _trashed_ids_list = list(trashed_folder_ids_set)
    if _trashed_ids_list:
        standalone_trashed = File.query.filter(
            File.registered_user_id == user.id,
            File.is_trashed == True,
            db.or_(File.folder_id == None, ~File.folder_id.in_(_trashed_ids_list))
        ).count()
    else:
        standalone_trashed = File.query.filter_by(registered_user_id=user.id, is_trashed=True).count()
    trash_count = standalone_trashed + trashed_folder_count

    # Serialize folders
    folders_json = []
    for fld in current_folders:
        exp_display = None
        if fld.expires_at:
            exp_aware = fld.get_expires_at_aware()
            remaining = (exp_aware - now_utc).total_seconds()
            if remaining > 0:
                exp_iso = exp_aware.strftime('%Y-%m-%dT%H:%M:%SZ')
                if remaining < 3600:
                    exp_display = {'value': int(round(remaining / 60)), 'unit': 'M', 'title': exp_aware.strftime('%b %d, %Y %H:%M UTC'), 'iso': exp_iso}
                elif remaining < 86400:
                    exp_display = {'value': int(round(remaining / 3600)), 'unit': 'H', 'title': exp_aware.strftime('%b %d, %Y %H:%M UTC'), 'iso': exp_iso}
                else:
                    exp_display = {'value': int(round(remaining / 86400)), 'unit': 'D', 'title': exp_aware.strftime('%b %d, %Y %H:%M UTC'), 'iso': exp_iso}
        fld_entry = {
            'id': fld.id,
            'name': fld.name,
            'share_token': fld.share_token or '',
            'is_browsable': fld.is_browsable or parent_is_browsable,
            'is_e2e': fld.is_e2e is True,
            'created_at': fld.created_at.strftime('%b %d, %Y'),
            'created_at_iso': fld.created_at.strftime('%Y-%m-%dT%H:%M:%S'),
            'updated_at': (fld.updated_at or fld.created_at).strftime('%b %d, %Y'),
            'updated_at_iso': (fld.updated_at or fld.created_at).strftime('%Y-%m-%dT%H:%M:%S'),
            'size': folder_sizes.get(fld.id, 0),
            'size_formatted': format_bytes_for_filesize(folder_sizes.get(fld.id, 0)) if folder_sizes.get(fld.id, 0) > 0 else None,
            'file_count': folder_file_counts.get(fld.id, 0),
            'e2e_count': folder_e2e_counts.get(fld.id, 0),
            'has_mixed_e2e': folder_has_mixed.get(fld.id, False),
            'expires': exp_display,
        }
        # Include encrypted folder name data for client-side decryption
        if fld.is_e2e is True and fld.encrypted_name:
            fld_entry['encrypted_name'] = fld.encrypted_name
            fld_entry['name_nonce'] = fld.name_nonce
            fld_entry['encrypted_name_key'] = fld.encrypted_name_key
            fld_entry['name_key_nonce'] = fld.name_key_nonce
        folders_json.append(fld_entry)

    # Serialize files
    files_json = []
    for f in active_files:
        ext = _get_compound_ext(f.orig_name)
        previewable_ext = ['jpg','jpeg','png','gif','bmp','svg','webp','mp4','webm','ogg','mov','m4v','mkv','mp3','wav','ogg','m4a','aac','flac','txt','md','log','csv','json','xml','yaml','yml','py','js','html','css','sh','ini','cfg','conf','c','cpp','h','hpp','lua','rb','rs','go','java','ts','tsx','jsx','toml','bat','ps1','sql','r','swift','kt','php','pl','diff','makefile','pdf']
        is_previewable = ext in previewable_ext

        exp_display = None
        if f.expires_at:
            exp_aware = f.get_expires_at_aware()
            remaining = (exp_aware - now_utc).total_seconds()
            if remaining > 0:
                exp_iso = exp_aware.strftime('%Y-%m-%dT%H:%M:%SZ')
                if remaining < 3600:
                    exp_display = {'value': int(round(remaining / 60)), 'unit': 'M', 'title': exp_aware.strftime('%b %d, %Y %H:%M UTC'), 'iso': exp_iso}
                elif remaining < 86400:
                    exp_display = {'value': int(round(remaining / 3600)), 'unit': 'H', 'title': exp_aware.strftime('%b %d, %Y %H:%M UTC'), 'iso': exp_iso}
                else:
                    exp_display = {'value': int(round(remaining / 86400)), 'unit': 'D', 'title': exp_aware.strftime('%b %d, %Y %H:%M UTC'), 'iso': exp_iso}

        file_entry = {
            'id': f.id,
            'name': f.orig_name,
            'extension': ext,
            'size': f.size,
            'size_formatted': format_bytes_for_filesize(f.size),
            'upload_date': f.get_upload_time_aware().strftime('%b %d, %Y'),
            'upload_date_iso': f.get_upload_time_aware().strftime('%Y-%m-%dT%H:%M:%S'),
            'management_token': f.management_token,
            'is_e2e': f.is_e2e_encrypted,
            'is_public': f.is_public or parent_is_public or parent_is_browsable,
            'has_thumbnail': f.has_thumbnail,
            'thumbnailable': (not f.is_e2e_encrypted) and _is_thumbnailable_name(f.orig_name),
            'is_previewable': is_previewable,
            'expires': exp_display,
        }
        # Include encrypted filename data + file key for client-side name decryption
        if f.is_e2e_encrypted and f.encrypted_name:
            file_entry['encrypted_name'] = f.encrypted_name
            file_entry['name_nonce'] = f.name_nonce
        if f.is_e2e_encrypted and f.encrypted_file_key:
            file_entry['encrypted_file_key'] = f.encrypted_file_key
            file_entry['file_key_nonce'] = f.file_key_nonce
        # Include E2E thumbnail nonce (thumbnail data fetched lazily via /file/<id>/e2e-thumbnail)
        if f.is_e2e_encrypted and f.has_thumbnail and f.encrypted_thumbnail_nonce:
            file_entry['enc_thumb_nonce'] = f.encrypted_thumbnail_nonce
        files_json.append(file_entry)

    # Sidebar folder tree data
    sidebar_folders = []
    for fld in all_folders_list:
        sf_entry = {
            'id': fld.id,
            'name': fld.name,
            'parent_id': fld.parent_id,
            'is_e2e': fld.is_e2e is True,
        }
        if fld.is_e2e is True and fld.encrypted_name:
            sf_entry['encrypted_name'] = fld.encrypted_name
            sf_entry['name_nonce'] = fld.name_nonce
            sf_entry['encrypted_name_key'] = fld.encrypted_name_key
            sf_entry['name_key_nonce'] = fld.name_key_nonce
        sidebar_folders.append(sf_entry)

    # Build breadcrumb trail for SPA navigation — walk via the folder map to avoid lazy-load SQL
    breadcrumbs_json = []
    if current_folder:
        _bc_map = {fld.id: fld for fld in all_folders_list}
        bc_folder = current_folder
        # AUDIT FIX (finding 7): visited set so a parent_id cycle cannot
        # spin this walk forever.
        _bcj_seen = set()
        while bc_folder and bc_folder.id not in _bcj_seen:
            _bcj_seen.add(bc_folder.id)
            bc_entry = {'id': bc_folder.id, 'name': bc_folder.name}
            if bc_folder.is_e2e is True and bc_folder.encrypted_name:
                bc_entry['encrypted_name'] = bc_folder.encrypted_name
                bc_entry['name_nonce'] = bc_folder.name_nonce
                bc_entry['encrypted_name_key'] = bc_folder.encrypted_name_key
                bc_entry['name_key_nonce'] = bc_folder.name_key_nonce
            breadcrumbs_json.insert(0, bc_entry)
            bc_folder = _bc_map.get(bc_folder.parent_id) if bc_folder.parent_id else None

    # Determine if current folder has E2E content despite is_e2e=False (mixed state)
    current_folder_has_e2e_content = False
    if current_folder and not (current_folder.is_e2e is True):
        e2e_cnt = folder_e2e_counts.get(current_folder.id, 0)
        has_mixed = folder_has_mixed.get(current_folder.id, False)
        current_folder_has_e2e_content = e2e_cnt > 0 or has_mixed

    storage_used = user.get_storage_used()
    return jsonify({
        'folders': folders_json,
        'files': files_json,
        'parent_is_public': parent_is_public,
        'parent_is_browsable': parent_is_browsable,
        'current_folder_is_e2e': current_folder.is_e2e if current_folder else True,
        'current_folder_has_e2e_content': current_folder_has_e2e_content,
        'trash_count': trash_count,
        'sidebar_folders': sidebar_folders,
        'breadcrumbs': breadcrumbs_json,
        'current_folder_id': current_folder.id if current_folder else None,
        'storage_used_gb': round(storage_used / (1024 ** 3), 2),
        'storage_used_bytes': storage_used,
        'storage_limit_gb': round(user.storage_limit_gb, 0),
        'root_folder_name': user.root_folder_name or 'FILES',
    })

@app.route('/trash/list')
@login_required
def trash_list_json():
    """JSON endpoint returning trashed files and folders."""
    user = _current_session_user()
    now_utc = datetime.now(timezone.utc)

    # Load all trashed data in bulk (2 queries total instead of O(N) recursive)
    _all_user_trashed_folders = Folder.query.filter_by(user_id=user.id, is_trashed=True).all()
    trashed_folders = sorted(
        [f for f in _all_user_trashed_folders if f.parent_id is None],
        key=lambda x: x.trashed_at or datetime.min, reverse=True
    )
    trashed_files = File.query.filter_by(registered_user_id=user.id, is_trashed=True).order_by(File.trashed_at.desc()).all()

    # Build in-memory tree for trashed folders: parent_id -> [child folder ids]
    _trash_children_map = {}
    for tf in _all_user_trashed_folders:
        _trash_children_map.setdefault(tf.parent_id, []).append(tf.id)

    # Collect all trashed folder IDs (including nested) via in-memory BFS
    trashed_folder_ids = set()
    _stack = [tf.id for tf in trashed_folders]
    while _stack:
        _fid = _stack.pop()
        if _fid in trashed_folder_ids:
            continue
        trashed_folder_ids.add(_fid)
        _stack.extend(_trash_children_map.get(_fid, []))

    standalone_files = [f for f in trashed_files if f.folder_id not in trashed_folder_ids]

    # Pre-compute per-folder file stats from already-loaded trashed files (0 extra queries)
    _trash_direct_file_count = {}
    _trash_direct_e2e_count = {}
    _trash_direct_size = {}
    for f in trashed_files:
        fid = f.folder_id
        _trash_direct_file_count[fid] = _trash_direct_file_count.get(fid, 0) + 1
        if f.is_e2e_encrypted:
            _trash_direct_e2e_count[fid] = _trash_direct_e2e_count.get(fid, 0) + 1
        _trash_direct_size[fid] = _trash_direct_size.get(fid, 0) + (f.size or 0)

    # Recursive accumulation with memoization (in-memory only, no DB)
    _trash_folder_file_counts = {}
    _trash_folder_e2e_counts = {}
    _trash_folder_sizes = {}
    _calc_trash_in_progress = set()
    def _calc_trash_stats(fid):
        if fid in _trash_folder_file_counts:
            return
        if fid in _calc_trash_in_progress:
            # AUDIT FIX D3: a parent_id cycle would otherwise recurse until
            # RecursionError (and then KeyError on the missing memo entry),
            # breaking the ONE page the user needs to recover their data.
            print(f'[WARNING] Trash listing hit a folder cycle at folder {fid}; counting its subtree as empty')
            _trash_folder_file_counts[fid] = 0
            _trash_folder_e2e_counts[fid] = 0
            _trash_folder_sizes[fid] = 0
            return
        _calc_trash_in_progress.add(fid)
        fc = _trash_direct_file_count.get(fid, 0)
        ec = _trash_direct_e2e_count.get(fid, 0)
        sz = _trash_direct_size.get(fid, 0)
        for child_id in _trash_children_map.get(fid, []):
            _calc_trash_stats(child_id)
            fc += _trash_folder_file_counts[child_id]
            ec += _trash_folder_e2e_counts[child_id]
            sz += _trash_folder_sizes[child_id]
        _trash_folder_file_counts[fid] = fc
        _trash_folder_e2e_counts[fid] = ec
        _trash_folder_sizes[fid] = sz
    for tf in _folders_deepest_first(_all_user_trashed_folders):
        _calc_trash_stats(tf.id)

    folders_json = []
    for fld in trashed_folders:
        remaining_hours = 0
        if fld.trashed_at:
            trashed_aware = fld.trashed_at if fld.trashed_at.tzinfo else fld.trashed_at.replace(tzinfo=timezone.utc)
            delete_at = trashed_aware + timedelta(hours=get_trash_retention_hours())
            remaining = (delete_at - now_utc).total_seconds()
            remaining_hours = remaining / 3600
        fld_file_count = _trash_folder_file_counts.get(fld.id, 0)
        fld_e2e_count = _trash_folder_e2e_counts.get(fld.id, 0)
        fld_size = _trash_folder_sizes.get(fld.id, 0)
        trash_fld_entry = {
            'id': fld.id,
            'name': fld.name,
            'is_e2e': fld.is_e2e is True,
            'file_count': fld_file_count,
            'e2e_count': fld_e2e_count,
            'size': fld_size,
            'size_formatted': format_bytes_for_filesize(fld_size),
            'remaining_hours': remaining_hours,
            'trashed_at': fld.trashed_at.strftime('%b %d, %Y') if fld.trashed_at else '',
            'trashed_at_iso': fld.trashed_at.strftime('%Y-%m-%dT%H:%M:%S') if fld.trashed_at else '',
        }
        if fld.is_e2e is True and fld.encrypted_name:
            trash_fld_entry['encrypted_name'] = fld.encrypted_name
            trash_fld_entry['name_nonce'] = fld.name_nonce
            trash_fld_entry['encrypted_name_key'] = fld.encrypted_name_key
            trash_fld_entry['name_key_nonce'] = fld.name_key_nonce
        folders_json.append(trash_fld_entry)

    previewable_ext = ['jpg','jpeg','png','gif','bmp','svg','webp','mp4','webm','ogg','mov','m4v','mkv','mp3','wav','ogg','m4a','aac','flac','txt','md','log','csv','json','xml','yaml','yml','py','js','html','css','sh','ini','cfg','conf','c','cpp','h','hpp','lua','rb','rs','go','java','ts','tsx','jsx','toml','bat','ps1','sql','r','swift','kt','php','pl','diff','makefile','pdf']
    files_json = []
    for f in standalone_files:
        ext = _get_compound_ext(f.orig_name)
        remaining_hours = 0
        if f.trashed_at:
            trashed_aware = f.trashed_at if f.trashed_at.tzinfo else f.trashed_at.replace(tzinfo=timezone.utc)
            delete_at = trashed_aware + timedelta(hours=get_trash_retention_hours())
            remaining = (delete_at - now_utc).total_seconds()
            remaining_hours = remaining / 3600
        trash_entry = {
            'id': f.id,
            'name': f.orig_name,
            'extension': ext,
            'size': f.size,
            'size_formatted': format_bytes_for_filesize(f.size),
            'is_e2e': f.is_e2e_encrypted,
            'has_thumbnail': f.has_thumbnail,
            'thumbnailable': (not f.is_e2e_encrypted) and _is_thumbnailable_name(f.orig_name),
            'is_previewable': ext in previewable_ext,
            'remaining_hours': remaining_hours,
            'trashed_at_iso': f.trashed_at.strftime('%Y-%m-%dT%H:%M:%S') if f.trashed_at else '',
        }
        if f.is_e2e_encrypted and f.encrypted_name:
            trash_entry['encrypted_name'] = f.encrypted_name
            trash_entry['name_nonce'] = f.name_nonce
        if f.is_e2e_encrypted and f.encrypted_file_key:
            trash_entry['encrypted_file_key'] = f.encrypted_file_key
            trash_entry['file_key_nonce'] = f.file_key_nonce
        if f.is_e2e_encrypted and f.has_thumbnail and f.encrypted_thumbnail_nonce:
            trash_entry['enc_thumb_nonce'] = f.encrypted_thumbnail_nonce
        files_json.append(trash_entry)

    # Sidebar folder tree data (non-trashed folders for consistent sidebar)
    all_sidebar_folders = Folder.query.filter_by(user_id=user.id, is_trashed=False).all()
    sidebar_folders = []
    for fld in all_sidebar_folders:
        sf_entry = {
            'id': fld.id,
            'name': fld.name,
            'parent_id': fld.parent_id,
            'is_e2e': fld.is_e2e is True,
        }
        if fld.is_e2e is True and fld.encrypted_name:
            sf_entry['encrypted_name'] = fld.encrypted_name
            sf_entry['name_nonce'] = fld.name_nonce
            sf_entry['encrypted_name_key'] = fld.encrypted_name_key
            sf_entry['name_key_nonce'] = fld.name_key_nonce
        sidebar_folders.append(sf_entry)

    storage_used = user.get_storage_used()
    return jsonify({
        'folders': folders_json,
        'files': files_json,
        'trash_count': len(folders_json) + len(files_json),
        'sidebar_folders': sidebar_folders,
        'storage_used_gb': round(storage_used / (1024 ** 3), 2),
        'storage_used_bytes': storage_used,
        'storage_limit_gb': round(user.storage_limit_gb, 0),
    })

def _validate_client_folder_dedupe_token(value):
    if value is None:
        return None, None
    if not isinstance(value, str):
        return None, 'Client folder token must be text'
    token = value.strip()
    if not token:
        return None, None
    if len(token) > 64:
        return None, 'Client folder token too long (max 64 characters)'
    return token, None


def _find_live_folder_creation_winner(user_id, parent_id, client_token,
                                      plaintext_name):
    if client_token:
        winner = Folder.query.filter_by(
            user_id=user_id,
            parent_id=parent_id,
            client_dedupe_token=client_token,
            is_trashed=False,
        ).order_by(Folder.id.asc()).first()
        if winner:
            return winner

    if plaintext_name is None:
        return None
    normalized_name = _normalize_plaintext_folder_name(plaintext_name)
    candidates = Folder.query.filter(
        Folder.user_id == user_id,
        Folder.parent_id.is_(None) if parent_id is None else Folder.parent_id == parent_id,
        Folder.is_trashed == False,
        Folder.encrypted_name.is_(None),
    ).order_by(Folder.id.asc()).all()
    for candidate in candidates:
        if _normalize_plaintext_folder_name(candidate.name) == normalized_name:
            return candidate
    return None


def _release_trashed_folder_dedupe_tokens(user_id, parent_id, client_token):
    """Release the dedupe token on TRASHED duplicate folder rows (M9).

    uq_folder_dedupe_sibling covers trashed rows while
    _find_live_folder_creation_winner() only matches live ones, so a trashed
    row would block every same-token retry forever. Dedup semantics only ever
    match live rows, so releasing the token on trashed rows cannot change any
    lookup outcome. Returns the number of rows released."""
    if not client_token:
        return 0
    try:
        released = db.session.query(Folder).filter(
            Folder.user_id == user_id,
            Folder.client_dedupe_token == client_token,
            Folder.is_trashed == True,
            Folder.parent_id.is_(None) if parent_id is None else Folder.parent_id == parent_id,
        ).update({'client_dedupe_token': None}, synchronize_session=False)
        db.session.commit()
    except Exception as e:
        try:
            db.session.rollback()
        except Exception:
            pass
        print(f'[WARNING] Could not release trashed folder dedupe tokens: {e}')
        return 0
    released = int(released or 0)
    if released:
        print(f'[DB] Released client_dedupe_token on {released} trashed folder row(s) '
              f'blocking the unique index')
    return released


def _create_folder_once(user, parent_id, folder_name, folder_is_e2e,
                        encrypted_fields, client_token):
    """Create or reuse one live sibling while holding its placement scope."""
    creation_lock = _acquire_folder_creation_lock(user.id, parent_id)
    lifecycle_lock = None
    try:
        lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
        # Auth and parent validation may have opened an old REPEATABLE READ
        # snapshot before this request waited for the winning creator.
        db.session.rollback()
        if not _lock_live_folder_for_placement(parent_id, user.id):
            return None, False, 'parent_not_found'

        plaintext_name = None if encrypted_fields else folder_name
        winner = _find_live_folder_creation_winner(
            user.id, parent_id, client_token, plaintext_name)
        if winner:
            return winner, True, None

        folder = Folder(
            name=folder_name,
            user_id=user.id,
            parent_id=parent_id,
            is_e2e=folder_is_e2e,
            share_token=str(uuid.uuid4()),
            client_dedupe_token=client_token,
        )
        if encrypted_fields:
            folder.encrypted_name = encrypted_fields['encrypted_name']
            folder.name_nonce = encrypted_fields['name_nonce']
            folder.encrypted_name_key = encrypted_fields['encrypted_name_key']
            folder.name_key_nonce = encrypted_fields['name_key_nonce']
            folder.name = f'encrypted_folder_{uuid.uuid4().hex[:8]}'
        db.session.add(folder)
        touch_folder(parent_id)
        try:
            db.session.commit()
        except _IdempotencyIntegrityError as _token_err:
            # AUDIT FIX M9: uq_folder_dedupe_sibling is the DB-level backstop
            # behind the folder creation lock. Losing that race is an idempotent
            # retry, not a failure: return the live sibling the winner created
            # (or release trashed duplicates and retry once) instead of 500-ing.
            if not client_token or 'client_dedupe_token' not in str(getattr(_token_err, 'orig', _token_err)).lower():
                raise
            db.session.rollback()
            winner = _find_live_folder_creation_winner(user.id, parent_id, client_token, plaintext_name)
            if not winner and _release_trashed_folder_dedupe_tokens(user.id, parent_id, client_token):
                db.session.add(folder)
                touch_folder(parent_id)
                try:
                    db.session.commit()
                    print(f'[FOLDER] Committed folder after releasing trashed duplicate dedupe tokens (user {user.id})')
                    return folder, False, None
                except _IdempotencyIntegrityError:
                    db.session.rollback()
                    winner = _find_live_folder_creation_winner(user.id, parent_id, client_token, plaintext_name)
            if winner:
                print(f'[FOLDER] Reused existing folder {winner.id} for dedupe token after DB unique backstop')
                return winner, True, None
            raise
        return folder, False, None
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_folder_creation_lock(creation_lock)


@app.route('/folder/create', methods=['POST'])
@limiter.limit(folder_ops_rate_limit)
@login_required
def create_folder():
    user = _current_session_user()
    folder_name = request.form.get('name')
    parent_id = request.form.get('parent_id')

    if not folder_name:
        return jsonify({'error': 'Folder name required'}), 400
    if len(folder_name) > 255:
        return jsonify({'error': 'FOLDER NAME TOO LONG (MAX 255 CHARACTERS)'}), 400

    try:
        parent_id = int(parent_id) if parent_id and parent_id != 'null' else None
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid parent folder'}), 400

    if parent_id is not None:
        parent_folder = Folder.query.filter_by(
            id=parent_id, user_id=user.id, is_trashed=False).first()
        if not parent_folder:
            return jsonify({'error': 'Parent folder not found'}), 404

    enc_folder_name = request.form.get('encrypted_name')
    enc_folder_name_nonce = request.form.get('name_nonce')
    enc_folder_name_key = request.form.get('encrypted_name_key')
    enc_folder_name_key_nonce = request.form.get('name_key_nonce')
    encrypted_fields_present = any((
        enc_folder_name, enc_folder_name_nonce,
        enc_folder_name_key, enc_folder_name_key_nonce,
    ))
    has_encrypted_name = bool(
        enc_folder_name and enc_folder_name_nonce
        and enc_folder_name_key and enc_folder_name_key_nonce)
    if encrypted_fields_present:
        if not has_encrypted_name:
            return jsonify({'error': 'INCOMPLETE ENCRYPTED FOLDER NAME'}), 400
        valid, err_msg = validate_encrypted_folder_name_fields(
            enc_folder_name, enc_folder_name_nonce,
            enc_folder_name_key, enc_folder_name_key_nonce)
        if not valid:
            print(f'[FOLDER] Rejected create with invalid encrypted name: {err_msg}')
            return jsonify({'error': err_msg}), 400

    raw_client_token = (
        request.form.get('client_dedupe_token')
        if 'client_dedupe_token' in request.form
        else request.form.get('client_folder_token')
    )
    if raw_client_token is None:
        raw_client_token = request.headers.get('Idempotency-Key')
    client_folder_token, token_error = _validate_client_folder_dedupe_token(
        raw_client_token)
    if token_error:
        return jsonify({'error': token_error}), 400

    encrypted_fields = None
    if has_encrypted_name:
        encrypted_fields = {
            'encrypted_name': enc_folder_name,
            'name_nonce': enc_folder_name_nonce,
            'encrypted_name_key': enc_folder_name_key,
            'name_key_nonce': enc_folder_name_key_nonce,
        }
    try:
        folder, existing, create_error = _create_folder_once(
            user,
            parent_id,
            folder_name,
            # AUDIT FIX (finding 6): derive the real E2EE flag from the input
            # instead of hardcoding True. A plaintext folder used to be stored
            # with is_e2e=True, which skewed the E2E/mixed-state detection the
            # browse + files collectors rely on (and made a plaintext folder
            # masquerade as an E2EE boundary candidate).
            bool(has_encrypted_name),
            encrypted_fields,
            client_folder_token,
        )
    except RuntimeError as e:
        print(f'[FOLDER] Folder creation lock unavailable for user {user.id}: {e}')
        return jsonify({'error': 'Folder creation is busy. Please try again.'}), 503
    if create_error == 'parent_not_found':
        return jsonify({'error': 'Parent folder not found'}), 404
    if existing:
        return jsonify({'success': True, 'folder_id': folder.id, 'existing': True})

    print(f'[FOLDER] Created folder: {_log_safe(folder.name)} by user: {user.username}')
    return jsonify({'success': True, 'folder_id': folder.id})

# AUDIT FIX D3 (recursive folder walks must provably terminate): a single bad
# `parent_id` row (a cycle) used to hang any walker that lacked a visited set --
# including trash_folder_recursive(), which the cleanup scheduler calls, so one
# looped folder wedged the ENTIRE cleanup job (expired temp files never reaped,
# orphans never reaped, trash purge stalled) while the worker grew until OOM.
# These bounds are defensive: they cap the damage of a pre-existing bad row so it
# degrades into a logged warning instead of an unkillable request thread.
_MAX_FOLDER_TREE_NODES = 200000
_MAX_FOLDER_WALK_STEPS = 10000

def _bfs_folder_ids(start_id, children_map):
    """BFS a prebuilt {parent_id: [child_id, ...]} map with cycle + size guards.
    Returns the visited folder ids (start_id first), never repeating an id."""
    ordered = []
    visited = set()
    stack = [start_id]
    while stack:
        fid = stack.pop()
        if fid in visited:
            continue
        visited.add(fid)
        ordered.append(fid)
        if len(ordered) > _MAX_FOLDER_TREE_NODES:
            print(f'[WARNING] Folder subtree walk from {start_id} exceeded {_MAX_FOLDER_TREE_NODES} nodes; truncating walk')
            break
        stack.extend(children_map.get(fid, []))
    return ordered

def _folder_ancestor_ids(folder_id):
    """Return folder_id plus every ancestor id, walking parent_id upwards.

    Terminates on a cycle (logging it) and on a pathological depth, so callers
    can never spin forever on a corrupt row."""
    chain = []
    seen = set()
    current_id = folder_id
    steps = 0
    while current_id is not None:
        steps += 1
        if steps > _MAX_FOLDER_WALK_STEPS:
            print(f'[WARNING] Folder ancestor walk from {folder_id} exceeded {_MAX_FOLDER_WALK_STEPS} steps; aborting walk')
            break
        if current_id in seen:
            print(f'[WARNING] Folder parent cycle detected at folder {current_id} (walk started at folder {folder_id})')
            break
        seen.add(current_id)
        chain.append(current_id)
        current = db.session.get(Folder, current_id)
        if not current:
            break
        current_id = current.parent_id
    return chain

def _folder_ancestry_complete(chain):
    """True when a _folder_ancestor_ids() chain reached a root (not cut off by a
    cycle or the depth limit), so absence from it really proves non-ancestry."""
    if not chain:
        return True
    last = db.session.get(Folder, chain[-1])
    return last is None or last.parent_id is None

def _acquire_user_folder_tree_lock(user_id):
    """Serialize folder re-parenting for one user across workers.

    AUDIT FIX D3 (move TOCTOU): the ancestor walk that rejects a cycle-forming
    move and the `parent_id` assignment are separate, non-atomic steps. Two
    concurrent moves (A -> B and B -> A) could each observe a legal tree, both
    pass validation, and commit a parent cycle that no later walk can escape."""
    if user_id is None:
        return None
    lock_path = os.path.join(_advisory_lock_dir(), f'folder_tree_user_{int(user_id)}.lock')
    lock_file = _open_flock_exclusive(lock_path)
    # Start a fresh read snapshot: under REPEATABLE READ this transaction could
    # otherwise still see the tree as it was BEFORE the move we just waited on.
    try:
        db.session.rollback()
    except Exception as e:
        print(f'[WARNING] Could not refresh snapshot after taking folder tree lock: {e}')
    return lock_file

def _release_user_folder_tree_lock(lock_file):
    if not lock_file:
        return
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        try:
            lock_file.close()
        except Exception:
            pass

def _collect_descendant_folder_ids(root_ids, include_roots=True, trashed=False):
    """Return a set of all descendant folder IDs of the given roots.
    Uses BFS with batched IN queries — O(tree depth) DB round-trips instead of O(folder count).
    `trashed` filters on Folder.is_trashed; roots must already match this filter if included."""
    if isinstance(root_ids, int):
        root_ids = [root_ids]
    root_ids = [r for r in root_ids if r is not None]
    if not root_ids:
        return set()
    collected = set(root_ids) if include_roots else set()
    frontier = set(root_ids)
    while frontier:
        rows = db.session.query(Folder.id).filter(
            Folder.parent_id.in_(list(frontier)),
            Folder.is_trashed == trashed
        ).all()
        next_frontier = set()
        for (fid,) in rows:
            if fid not in collected:
                collected.add(fid)
                next_frontier.add(fid)
        frontier = next_frontier
    return collected

def _effective_folder_share_info(folder_id):
    """Resolve a folder's active share context without request-local caching."""
    current_id = folder_id
    visited = set()
    nearest_info = None
    while current_id is not None and current_id not in visited:
        visited.add(current_id)
        folder = db.session.get(Folder, current_id)
        if not folder or folder.is_trashed:
            break
        if folder.is_link_shared:
            info = {'share_token': folder.share_token, 'folder_id': folder.id}
            if nearest_info is None:
                nearest_info = info
            if folder.is_browsable:
                return info
        current_id = folder.parent_id
    return nearest_info


def _clear_file_folder_link_key(file):
    """Clear only the key derived from a containing folder's share token."""
    if not (getattr(file, 'folder_link_encrypted_file_key', None) or
            getattr(file, 'folder_link_file_key_nonce', None)):
        return False
    file.folder_link_encrypted_file_key = None
    file.folder_link_file_key_nonce = None
    if not file.link_encrypted_file_key:
        file.is_link_shared = False
    return True


def _clear_e2e_link_keys_for_folder_tree(folder_id):
    folder_ids = _collect_descendant_folder_ids([folder_id], include_roots=True, trashed=False)
    if not folder_ids:
        return 0
    files = File.query.filter(
        File.folder_id.in_(list(folder_ids)),
        File.is_temp_upload == False,
        File.is_trashed == False,
        File.is_e2e_encrypted == True
    ).all()
    cleared = 0
    for f in files:
        if _clear_file_folder_link_key(f):
            cleared += 1
    return cleared

def trash_folder_recursive(folder_id, trashed_at=None):
    """Recursively trash a folder, all its subfolders, and their files.
    Files remain in their folders (folder_id preserved) so structure is retained in trash.
    Uses bulk-load + BFS instead of per-subfolder recursive queries."""
    if trashed_at is None:
        trashed_at = datetime.now(timezone.utc)

    # Bulk-load all non-trashed folders for this user and BFS to find descendants
    root_folder = db.session.get(Folder, folder_id)
    if not root_folder:
        return
    all_folders = Folder.query.filter_by(user_id=root_folder.user_id, is_trashed=False).all()
    children_map = {}
    for fld in all_folders:
        children_map.setdefault(fld.parent_id, []).append(fld.id)

    # BFS to collect all descendant folder IDs (including root).
    # AUDIT FIX D3: cycle/size guarded -- this runs inside the cleanup scheduler.
    all_folder_ids = _bfs_folder_ids(folder_id, children_map)

    # Bulk-update files in all affected folders.
    # AUDIT FIX (finding 8): owner-filter the mutation -- a STALE folder_id
    # pointing into this tree from another user's row must never be trashed
    # by this user's folder delete (same rule permanently_delete_folder_recursive
    # already applies).
    files_in_folders = File.query.filter(
        File.folder_id.in_(all_folder_ids),
        File.registered_user_id == root_folder.user_id,
        File.is_trashed == False,
    ).options(
        db.defer(File.thumbnail_data),
        db.defer(File.encrypted_thumbnail_data),
    ).all()
    for file in files_in_folders:
        file.is_trashed = True
        file.trashed_at = trashed_at
        file.original_folder_id = file.folder_id
        # AUDIT FIX D11: record explicitly that this file was trashed as part of
        # a FOLDER trash operation, so restore is deterministic instead of
        # depending on a 1-second timestamp-comparison heuristic.
        file.trashed_via_folder = True
        file.is_public = False
        file.short_code = None

    # AUDIT FIX (finding 8): DETACH the foreign-owner rows instead of leaving
    # them behind -- a live file whose folder_id points into a now-trashed
    # folder is invisible to BOTH owners (its owner's drive listing only shows
    # root files + folders in its own tree). Clearing folder_id restores it to
    # the foreign owner's drive root; no foreign row is trashed or deleted.
    stale_rows = File.query.filter(
        File.folder_id.in_(all_folder_ids),
        db.or_(File.registered_user_id.is_(None),
               File.registered_user_id != root_folder.user_id),
    ).options(
        db.defer(File.thumbnail_data),
        db.defer(File.encrypted_thumbnail_data),
    ).all()
    for file in stale_rows:
        print(f'[TRASH] Detaching stale foreign-owner file {file.id} from folder tree {folder_id} '
              f'(owner {file.registered_user_id} != {root_folder.user_id})')
        file.folder_id = None

    # Bulk-update all affected folders
    folder_map = {fld.id: fld for fld in all_folders}
    for fid in all_folder_ids:
        fld = folder_map.get(fid)
        if fld:
            fld.is_trashed = True
            fld.trashed_at = trashed_at
            fld.original_parent_id = fld.parent_id
            fld.is_public = False
            fld.is_browsable = False

@app.route('/folder/<int:folder_id>/delete', methods=['POST'])
@limiter.limit(folder_ops_rate_limit)
@login_required
def delete_folder(folder_id):
    # Decorator handles authentication
    user = _current_session_user()
    
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
        if not folder:
            return jsonify({'error': 'Folder not found'}), 404

        folder_name = folder.name
        parent_id_before = folder.parent_id

        # Recursively trash folder and all contents (soft-delete)
        trash_folder_recursive(folder_id)

        # Detach the top-level folder from its parent so it doesn't show in file browser
        folder.parent_id = None

        touch_folder(parent_id_before)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    print(f'[FOLDER] Trashed folder: {_log_safe(folder_name)} and all contents by user: {user.username}')
    return jsonify({'success': True})

@app.route('/folder/<int:folder_id>/rename', methods=['POST'])
@limiter.limit(folder_ops_rate_limit)
@login_required
def rename_folder(folder_id):
    # Decorator handles authentication
    user = _current_session_user()
    
    folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
    if not folder:
        return jsonify({'error': 'Folder not found'}), 404
    
    new_name = request.form.get('name')
    if not new_name:
        return jsonify({'error': 'Folder name required'}), 400
    if len(new_name) > 255:
        return jsonify({'error': 'FOLDER NAME TOO LONG (MAX 255 CHARACTERS)'}), 400
    
    # E2EE encrypted folder name fields
    enc_folder_name = request.form.get('encrypted_name')
    enc_folder_name_nonce = request.form.get('name_nonce')
    submitted_name_key = request.form.get('encrypted_name_key')
    submitted_name_key_nonce = request.form.get('name_key_nonce')
    enc_folder_name_key = submitted_name_key or folder.encrypted_name_key
    enc_folder_name_key_nonce = submitted_name_key_nonce or folder.name_key_nonce
    encrypted_fields_present = any((enc_folder_name, enc_folder_name_nonce, submitted_name_key, submitted_name_key_nonce))
    has_encrypted_name = bool(enc_folder_name and enc_folder_name_nonce and enc_folder_name_key and enc_folder_name_key_nonce)

    # Renaming ciphertext does not rotate the folder name key, so the browser
    # normally sends only encrypted_name + nonce. Reuse the existing wrapped key
    # and reject malformed partial payloads instead of silently clearing E2EE.
    if encrypted_fields_present:
        if not has_encrypted_name:
            return jsonify({'error': 'INCOMPLETE ENCRYPTED FOLDER NAME'}), 400
        if bool(submitted_name_key) != bool(submitted_name_key_nonce):
            return jsonify({'error': 'INCOMPLETE ENCRYPTED FOLDER NAME'}), 400
        valid, err_msg = validate_encrypted_folder_name_fields(
            enc_folder_name, enc_folder_name_nonce,
            enc_folder_name_key, enc_folder_name_key_nonce,
        )
        if not valid:
            print(f'[FOLDER] Rejected rename with invalid encrypted name for folder {folder_id}: {err_msg}')
            return jsonify({'error': err_msg}), 400
    
    # Check if folder with same name exists in same parent (exclude trashed)
    # For E2EE folders with encrypted names, server cannot detect duplicates -- client handles this
    # The check and the commit hold the sibling placement lock folder creation
    # uses, so two concurrent renames (or a rename racing a create) cannot both
    # pass the check.
    name_lock = None if has_encrypted_name else _acquire_folder_creation_lock(user.id, folder.parent_id)
    try:
        if not has_encrypted_name:
            db.session.rollback()  # fresh snapshot: see siblings committed while waiting
            folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
            if not folder:
                return jsonify({'error': 'Folder not found'}), 404
            # Same canonical key as folder creation (_find_live_folder_creation_winner):
            # raw SQL equality let ' Alpha' or 'ＡＬＰＨＡ' sit beside 'Alpha'.
            new_key = _normalize_plaintext_folder_name(new_name)
            siblings = Folder.query.filter(
                Folder.user_id == user.id,
                Folder.parent_id.is_(None) if folder.parent_id is None else Folder.parent_id == folder.parent_id,
                Folder.is_trashed == False,
                Folder.encrypted_name.is_(None),
                Folder.id != folder_id,
            ).all()
            if any(_normalize_plaintext_folder_name(s.name) == new_key for s in siblings):
                return jsonify({'error': 'Folder with this name already exists'}), 400

        old_name = folder.name
        if has_encrypted_name:
            folder.encrypted_name = enc_folder_name
            folder.name_nonce = enc_folder_name_nonce
            if submitted_name_key:
                folder.encrypted_name_key = submitted_name_key
                folder.name_key_nonce = submitted_name_key_nonce
            folder.name = f'encrypted_folder_{folder.id}'
            if submitted_name_key:
                # A new name key invalidates the link-wrapped copy of the old one.
                folder.link_encrypted_name_key = None
                folder.link_name_key_nonce = None
        else:
            folder.name = new_name
            # Clear encrypted name fields if renaming as plaintext
            folder.encrypted_name = None
            folder.name_nonce = None
            folder.encrypted_name_key = None
            folder.name_key_nonce = None
            folder.link_encrypted_name_key = None
            folder.link_name_key_nonce = None
        folder.updated_at = datetime.now(timezone.utc)
        db.session.commit()
    finally:
        _release_folder_creation_lock(name_lock)
    
    # Zero-knowledge: log only placeholder name for E2EE folders, never the plaintext name
    log_name = folder.name if has_encrypted_name else new_name
    print(f'[FOLDER] Renamed folder: {_log_safe(old_name)} -> {_log_safe(log_name)} by user: {user.username}')
    return jsonify({'success': True})

@app.route('/root-folder-name', methods=['POST'])
@limiter.limit(folder_ops_rate_limit)
@login_required
def rename_root_folder():
    """Rename the user's virtual root folder (displayed as 'FILES' by default)."""
    user = _current_session_user()
    new_name = request.form.get('name', '').strip()
    if not new_name:
        return jsonify({'error': 'Name required'}), 400
    if len(new_name) > 80:
        return jsonify({'error': 'Name too long (max 80 characters)'}), 400
    old_name = user.root_folder_name or 'FILES'
    user.root_folder_name = new_name
    db.session.commit()
    print(f'[FOLDER] Root folder renamed: {_log_safe(old_name)} -> {_log_safe(new_name)} by user: {user.username}')
    return jsonify({'success': True, 'name': new_name})

@app.route('/folder/<int:folder_id>/track-download', methods=['POST'])
@limiter.limit(folder_ops_rate_limit)
@login_required
def track_folder_download(folder_id):
    """Increment download counts for a folder and all its sub-folders (owner only, called by dashboard)."""
    # AUDIT FIX H4: epoch-validated user resolution.
    _track_user = _current_session_user()
    if not _track_user:
        return jsonify({'error': 'SESSION_EXPIRED'}), 401
    folder = Folder.query.filter_by(id=folder_id, user_id=_track_user.id, is_trashed=False).first()
    if not folder:
        return jsonify({'error': 'NOT FOUND'}), 404
    increment_folder_download_counts(folder_id)
    return jsonify({'ok': True})

@app.route('/delete-all-files', methods=['POST'])
@limiter.limit("3 per minute")
@login_required
def delete_all_files():
    """Delete all of a user's DRIVE files and folders (requires password + captcha).

    AUDIT FIX D14: SCOPE IS FILES AND FOLDERS ONLY. Notes, notebooks and their
    encrypted payloads in notes/ are NOT touched (only /delete-account removes
    those). The docstring used to say "ALL user files and folders", and the
    response said nothing about scope, so a user could reasonably believe their
    notes had been erased too. The scope is deliberately NOT broadened here --
    silently expanding a destructive route is worse than an honest one -- but the
    response now states exactly what was and was not deleted."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'SESSION_EXPIRED', 'redirect': url_for('login')}), 401
    # AUDIT FIX H6 (same defect as /delete-account): the client posted FormData
    # while request.get_json() raises 415 on a multipart body under Flask 3, so
    # this route could never succeed from the UI. silent=True turns a bad body
    # into a clean 400 and the client now sends JSON.
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not _json_string_fields_valid(data, ('password', 'auth_token', 'captcha')):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    password = data.get('password')
    auth_token = data.get('auth_token')
    captcha_input = (data.get('captcha') or '').strip()

    # Validate captcha
    captcha_ok, captcha_error = _validate_captcha_response(captcha_input)
    if not captcha_ok:
        print(f'[AUTH] Delete all files captcha failed for user {user.username}')
        return jsonify({'error': captcha_error}), 400

    # Validate password / auth_token (same flow as login)
    if not password and not auth_token:
        return jsonify({'error': 'PASSWORD IS REQUIRED'}), 400

    auth_ok = _verify_user_credentials(user, password=password, auth_token=auth_token)

    if not auth_ok:
        print(f'[AUTH] Delete all files password check failed for user {user.username}')
        return jsonify({'error': 'INCORRECT PASSWORD'}), 403

    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        # Collect disk paths to delete after DB commit
        paths_to_delete = []
        
        user_files = File.query.filter_by(registered_user_id=user.id).all()
        file_count = len(user_files)
        for file in user_files:
            paths_to_delete.extend(_file_payload_delete_keys(file))
            db.session.delete(file)

        # Delete all user's folders
        user_folders = Folder.query.filter_by(user_id=user.id).all()
        folder_count = len(user_folders)
        for folder in user_folders:
            db.session.delete(folder)

        # AUDIT FIX (atomic permanent delete): tombstones + replica deletes ride
        # the same commit as the metadata deletions; local disk purged afterwards.
        local_targets = storage.stage_payload_deletes(paths_to_delete)
        db.session.commit()
        _release_lifecycle_lock(lifecycle_lock)
        lifecycle_lock = None

        # DB commit succeeded -- now safe to remove local disk payloads
        storage.purge_staged_locals(local_targets)
        
        # AUDIT FIX D14: report the ACTUAL scope so the caller cannot believe
        # notes were removed as well.
        _remaining_notes = Note.query.filter_by(user_id=user.id).count()
        _remaining_notebooks = Notebook.query.filter_by(user_id=user.id).count()
        print(f'[DELETE] All drive files deleted for user {user.username}: {file_count} files, {folder_count} folders '
              f'(notes NOT affected: {_remaining_notes} notes in {_remaining_notebooks} notebooks retained)')
        return jsonify({
            'success': True,
            'scope': 'files_and_folders',
            'deleted_files': file_count,
            'deleted_folders': folder_count,
            'notes_deleted': False,
            'notes_retained': _remaining_notes,
            'notebooks_retained': _remaining_notebooks,
            'message': f'DELETED {file_count} FILES AND {folder_count} FOLDERS. '
                       f'NOTES AND NOTEBOOKS WERE NOT DELETED ({_remaining_notes} NOTES RETAINED) — '
                       f'USE DELETE ACCOUNT TO REMOVE THOSE.',
        })
    except Exception as e:
        db.session.rollback()
        print(f'[ERROR] Delete all files failed for {user.username}: {e}')
        return jsonify({'error': 'FAILED TO DELETE FILES'}), 500
    finally:
        _release_lifecycle_lock(lifecycle_lock)

