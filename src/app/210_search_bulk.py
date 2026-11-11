@app.route('/search', methods=['GET'])
@limiter.limit(search_rate_limit)
@login_required
def search_files():
    """Search files and folders"""
    user = _current_session_user()
    query = request.args.get('q', '').strip()
    
    if not query:
        return jsonify({'files': [], 'folders': []})

    now_utc = datetime.now(timezone.utc)

    # Search files (exclude trashed and expired). Filter expiration in SQL so the
    # limit(50) isn't eroded by dropping expired rows in Python afterward.
    active_files = File.query.filter(
        File.registered_user_id == user.id,
        File.is_temp_upload == False,
        File.is_trashed == False,
        File.orig_name.ilike(f'%{escape_like_pattern(query[:128])}%', escape='\\'),
        db.or_(File.expires_at == None, File.expires_at >= now_utc)
    ).order_by(File.upload_time.desc()).limit(50).all()

    # Search folders (exclude trashed)
    folders = Folder.query.filter(
        Folder.user_id == user.id,
        Folder.is_trashed == False,
        Folder.name.ilike(f'%{escape_like_pattern(query[:128])}%', escape='\\')
    ).order_by(Folder.name).limit(50).all()

    # Load only the ancestors needed for path labels — batched IN queries walk up
    # the tree in O(depth) instead of loading every folder the user owns.
    _folder_map = {}
    _needed_ids = {fld.id for fld in folders}
    for f in active_files:
        if f.folder_id:
            _needed_ids.add(f.folder_id)
    _to_load = set(_needed_ids)
    while _to_load:
        rows = Folder.query.filter(Folder.id.in_(list(_to_load)), Folder.user_id == user.id).all()
        parents_to_fetch = set()
        for fld in rows:
            _folder_map[fld.id] = fld
            if fld.parent_id and fld.parent_id not in _folder_map:
                parents_to_fetch.add(fld.parent_id)
        _to_load = parents_to_fetch

    def get_folder_path(folder):
        path_parts = []
        seen = set()
        current = folder
        while current and current.id not in seen and len(path_parts) < _MAX_FOLDER_WALK_STEPS:
            seen.add(current.id)
            path_parts.append(current.name)
            current = _folder_map.get(current.parent_id) if current.parent_id else None
        return ' / '.join(reversed(path_parts))

    def get_file_folder_path(file):
        if file.folder_id:
            fld = _folder_map.get(file.folder_id)
            if fld:
                return get_folder_path(fld)
        return 'Root'

    file_results = []
    for f in active_files:
        fentry = {
            'id': f.id,
            'name': f.orig_name,
            'size': format_bytes_for_filesize(f.size),
            'folder_path': get_file_folder_path(f),
            'folder_id': f.folder_id,
            'management_token': f.management_token,
            'uploaded': f.get_upload_time_aware().strftime('%b %d, %Y'),
            'is_e2e': f.is_e2e_encrypted,
            'has_thumbnail': f.has_thumbnail,
            'extension': _get_compound_ext(f.orig_name),
            'thumbnailable': (not f.is_e2e_encrypted) and _is_thumbnailable_name(f.orig_name),
        }
        if f.is_e2e_encrypted and f.encrypted_name:
            fentry['encrypted_name'] = f.encrypted_name
            fentry['name_nonce'] = f.name_nonce
        if f.is_e2e_encrypted and f.encrypted_file_key:
            fentry['encrypted_file_key'] = f.encrypted_file_key
            fentry['file_key_nonce'] = f.file_key_nonce
        if f.is_e2e_encrypted and f.has_thumbnail and f.encrypted_thumbnail_nonce:
            fentry['enc_thumb_nonce'] = f.encrypted_thumbnail_nonce
        file_results.append(fentry)
    
    folder_results = []
    for fld in folders:
        fld_entry = {
            'id': fld.id,
            'name': fld.name,
            'path': get_folder_path(fld),
            'parent_id': fld.parent_id,
            'is_e2e': fld.is_e2e is True,
        }
        if fld.is_e2e is True and fld.encrypted_name:
            fld_entry['encrypted_name'] = fld.encrypted_name
            fld_entry['name_nonce'] = fld.name_nonce
            fld_entry['encrypted_name_key'] = fld.encrypted_name_key
            fld_entry['name_key_nonce'] = fld.name_key_nonce
        folder_results.append(fld_entry)
    
    return jsonify({'files': file_results, 'folders': folder_results})

@app.route('/search/index', methods=['GET'])
@limiter.limit(search_rate_limit)
@login_required
def search_index():
    """Every active file and folder the user owns, for the Files page search.
    E2EE names only exist encrypted (orig_name/name hold a placeholder), so
    /search can never match them; the browser decrypts this index and matches
    names itself. Entries mirror /files/list so results render the same way."""
    user = _current_session_user()
    now_utc = datetime.now(timezone.utc)
    # ponytail: whole index in one response; page it if accounts reach ~100k files.
    files = File.query.filter(
        File.registered_user_id == user.id,
        File.is_temp_upload == False,
        File.is_trashed == False,
        db.or_(File.expires_at == None, File.expires_at >= now_utc)
    ).order_by(File.upload_time.desc()).all()
    folders = Folder.query.filter_by(user_id=user.id, is_trashed=False).all()

    file_results = []
    for f in files:
        uploaded = f.get_upload_time_aware()
        entry = {
            'id': f.id,
            'name': f.orig_name,
            'extension': _get_compound_ext(f.orig_name),
            'folder_id': f.folder_id,
            'size': f.size,
            'size_formatted': format_bytes_for_filesize(f.size),
            'upload_date': uploaded.strftime('%b %d, %Y'),
            'upload_date_iso': uploaded.strftime('%Y-%m-%dT%H:%M:%S'),
            'is_e2e': f.is_e2e_encrypted,
            'is_public': f.is_public,
            'has_thumbnail': f.has_thumbnail,
            'thumbnailable': (not f.is_e2e_encrypted) and _is_thumbnailable_name(f.orig_name),
        }
        if f.is_e2e_encrypted and f.encrypted_name:
            entry['encrypted_name'] = f.encrypted_name
            entry['name_nonce'] = f.name_nonce
        if f.is_e2e_encrypted and f.encrypted_file_key:
            entry['encrypted_file_key'] = f.encrypted_file_key
            entry['file_key_nonce'] = f.file_key_nonce
        if f.is_e2e_encrypted and f.has_thumbnail and f.encrypted_thumbnail_nonce:
            entry['enc_thumb_nonce'] = f.encrypted_thumbnail_nonce
        file_results.append(entry)

    folder_results = []
    for fld in folders:
        updated = fld.updated_at or fld.created_at
        entry = {
            'id': fld.id,
            'name': fld.name,
            'parent_id': fld.parent_id,
            'is_e2e': fld.is_e2e is True,
            'updated_at': updated.strftime('%b %d, %Y'),
            'updated_at_iso': updated.strftime('%Y-%m-%dT%H:%M:%S'),
        }
        if fld.is_e2e is True and fld.encrypted_name:
            entry['encrypted_name'] = fld.encrypted_name
            entry['name_nonce'] = fld.name_nonce
            entry['encrypted_name_key'] = fld.encrypted_name_key
            entry['name_key_nonce'] = fld.name_key_nonce
        folder_results.append(entry)

    return jsonify({'files': file_results, 'folders': folder_results})

_MAX_BULK_IDS = 1000

def _parse_bulk_id_list(value, cast=None, label='IDS'):
    """AUDIT FIX (finding 10): bulk endpoints used to feed request JSON
    straight into SQL .in_() / int() -- a non-list payload (a bare int,
    string or dict) or nested objects raised TypeError/DataError and turned a
    malformed client request into a 500. Returns (ids, None) on success or
    (None, error) for the caller to answer 400.

    cast=int  -> every entry must be int-able (folder ids)
    cast=None -> every entry must be a str/int scalar (file ids)"""
    if value is None:
        return [], None
    if not isinstance(value, list):
        return None, f'{label} MUST BE A JSON ARRAY'
    if len(value) > _MAX_BULK_IDS:
        return None, f'TOO MANY {label} (MAX {_MAX_BULK_IDS})'
    ids = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (str, int)):
            return None, f'INVALID {label} ENTRY'
        if cast is int:
            try:
                ids.append(int(item))
            except (TypeError, ValueError):
                return None, f'INVALID {label} ENTRY'
        else:
            ids.append(item)
    # Order-preserving dedupe: a repeated id must not be acted on (and counted) twice.
    return list(dict.fromkeys(ids)), None


@app.route('/bulk/delete', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def bulk_delete():
    """Bulk delete (move to trash) files and folders"""
    user = _current_session_user()
    
    data = _json_object_body()
    file_ids, id_error = _parse_bulk_id_list(data.get('file_ids'), label='FILE_IDS')
    if id_error:
        return jsonify({'error': id_error}), 400
    folder_ids, id_error = _parse_bulk_id_list(data.get('folder_ids'), cast=int, label='FOLDER_IDS')
    if id_error:
        return jsonify({'error': id_error}), 400
    
    trashed_files = 0
    deleted_folders = 0
    affected_folder_ids = set()

    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        if _backup_items_read_only(user.id, file_ids, folder_ids, subtree=True):
            return _backup_read_only_error()
        # AUDIT Tier 1: Bulk-load files and folders by ID in a single query each
        # instead of one .first() per ID. With 100 selected items this turns 200
        # round-trips into 2.
        trashed_at = datetime.now(timezone.utc)
        # Trash folders FIRST (recursive soft-delete - files and folders preserved
        # in trash), so selected items inside a selected folder go to the trash
        # with that folder instead of becoming separate trash roots.
        if folder_ids:
            try:
                folder_ids_int = [int(fid) for fid in folder_ids]
            except (TypeError, ValueError):
                folder_ids_int = []
            if folder_ids_int:
                folders_to_trash = Folder.query.filter(
                    Folder.id.in_(folder_ids_int),
                    Folder.user_id == user.id,
                    Folder.is_trashed == False,
                ).all()
                selected_folder_ids = {folder.id for folder in folders_to_trash}
                for folder in folders_to_trash:
                    # Already trashed with, or about to be trashed by, a selected ancestor.
                    if folder.is_trashed:
                        continue
                    ancestor_chain = _folder_ancestor_ids(folder.parent_id)
                    if _folder_ancestry_complete(ancestor_chain) and selected_folder_ids.intersection(ancestor_chain):
                        continue
                    if folder.parent_id:
                        affected_folder_ids.add(folder.parent_id)
                    trash_folder_recursive(folder.id)
                    # Detach top-level folder from parent so it doesn't show in file browser
                    folder.parent_id = None
                    deleted_folders += 1

        # Autoflush makes is_trashed == False skip files already trashed with a folder above.
        if file_ids:
            files_to_trash = File.query.filter(
                File.id.in_(file_ids),
                File.registered_user_id == user.id,
                File.is_trashed == False,
            ).all()
            for file in files_to_trash:
                if file.folder_id:
                    affected_folder_ids.add(file.folder_id)
                file.is_trashed = True
                file.trashed_at = trashed_at
                file.original_folder_id = file.folder_id
                # AUDIT FIX D11: explicitly trashed on its own, not via its folder.
                file.trashed_via_folder = False
                file.folder_id = None
                # Revoke sharing so trashed files are not accessible via share links
                file.is_public = False
                file.short_code = None
                trashed_files += 1

        for fid in affected_folder_ids:
            touch_folder(fid)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    print(f'[BULK] Trashed {trashed_files} files, trashed {deleted_folders} folders by user: {user.username}')
    return jsonify({'success': True, 'trashed_files': trashed_files, 'deleted_folders': deleted_folders})

@app.route('/bulk/move', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def bulk_move():
    """Bulk move files and/or folders to a target folder"""
    user = _current_session_user()
    
    data = _json_object_body()
    # AUDIT FIX (finding 10): validate id payload types up front -> clean 400.
    file_ids, id_error = _parse_bulk_id_list(data.get('file_ids'), label='FILE_IDS')
    if id_error:
        return jsonify({'error': id_error}), 400
    folder_ids, id_error = _parse_bulk_id_list(data.get('folder_ids'), cast=int, label='FOLDER_IDS')
    if id_error:
        return jsonify({'error': id_error}), 400
    target_folder_id = data.get('target_folder_id')
    try:
        target_folder_id = int(target_folder_id) if target_folder_id and target_folder_id != 'null' else None
    except (TypeError, ValueError):
        return jsonify({'error': 'INVALID FOLDER ID'}), 400
    
    moved_files = 0
    moved_folders = 0
    moved_e2e_ids = []
    moved_e2e_before = {}
    affected_folder_ids = set()

    # AUDIT FIX D3 (cycle TOCTOU): serialize this user's folder re-parenting so a
    # concurrent move cannot slip between the ancestor check and the assignment
    # and leave a parent cycle behind.
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    tree_lock = _acquire_user_folder_tree_lock(user.id)
    try:
        # Verify target folder (must not be trashed)
        if target_folder_id:
            target_folder = Folder.query.filter_by(id=target_folder_id, user_id=user.id, is_trashed=False).first()
            if not target_folder:
                return jsonify({'error': 'Target folder not found'}), 404
        if _backup_read_only(target_folder_id) or _backup_items_read_only(user.id, file_ids, folder_ids):
            return _backup_read_only_error()

        # Pre-compute the target's ancestor chain once (used to reject cycle-forming
        # moves). Cycle- and depth-bounded.
        target_ancestor_ids = set()
        target_ancestry_complete = True
        if target_folder_id is not None:
            _target_chain = _folder_ancestor_ids(target_folder_id)
            target_ancestor_ids = set(_target_chain)
            # A truncated chain cannot prove a folder is NOT an ancestor.
            target_ancestry_complete = _folder_ancestry_complete(_target_chain)

        # Move folders
        for fid in folder_ids:
            try:
                fid = int(fid)
            except (TypeError, ValueError):
                continue
            folder = Folder.query.filter_by(id=fid, user_id=user.id, is_trashed=False).first()
            if not folder:
                continue
            # Cannot move a folder into itself or into one of its descendants
            if target_folder_id == fid:
                continue
            if target_folder_id is not None and (fid in target_ancestor_ids or not target_ancestry_complete):
                continue
            if folder.parent_id:
                affected_folder_ids.add(folder.parent_id)
            tree_ids = _collect_descendant_folder_ids([fid], include_roots=True)
            # AUDIT FIX (finding 8): owner-filter -- stale foreign-owner rows
            # reachable through folder_id must not be pulled into this user's
            # E2EE share-info invalidation set.
            tree_files = File.query.filter(
                File.folder_id.in_(list(tree_ids)),
                File.registered_user_id == user.id,
                File.is_temp_upload == False,
                File.is_trashed == False,
                File.is_e2e_encrypted == True,
            ).all()
            for tree_file in tree_files:
                moved_e2e_before.setdefault(
                    tree_file.id,
                    (_effective_folder_share_info(tree_file.folder_id) or {}).get('share_token'),
                )
            folder.parent_id = target_folder_id
            folder.original_parent_id = None  # explicit move supersedes the restore breadcrumb
            folder.updated_at = datetime.now(timezone.utc)
            moved_folders += 1
            # A folder that just moved under the target becomes part of the
            # target's ancestor chain for any LATER folder in this same request.
            if target_folder_id is not None:
                target_ancestor_ids.add(fid)
        # Move files
        for file_id in file_ids:
            file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=False).first()
            if file:
                if file.folder_id:
                    affected_folder_ids.add(file.folder_id)
                if file.is_e2e_encrypted:
                    moved_e2e_before.setdefault(
                        file.id,
                        (_effective_folder_share_info(file.folder_id) or {}).get('share_token'),
                    )
                file.folder_id = target_folder_id
                file.original_folder_id = None  # explicit move supersedes the restore breadcrumb
                moved_files += 1

        for file_id, old_share_token in moved_e2e_before.items():
            moved_file = db.session.get(File, file_id)
            if not moved_file:
                continue
            new_share = _effective_folder_share_info(moved_file.folder_id)
            if old_share_token != (new_share or {}).get('share_token'):
                _clear_file_folder_link_key(moved_file)
                if new_share and moved_file.encrypted_file_key:
                    moved_e2e_ids.append(moved_file.id)

        for fid in affected_folder_ids:
            touch_folder(fid)
        touch_folder(target_folder_id)
        db.session.commit()
    finally:
        _release_user_folder_tree_lock(tree_lock)
        _release_lifecycle_lock(lifecycle_lock)
    
    total_moved = moved_files + moved_folders
    print(f'[BULK] Moved {moved_files} file(s) and {moved_folders} folder(s) to folder {target_folder_id} by user: {user.username}')
    
    # If E2E files moved into a shared folder tree, tell client to generate link keys
    result = {'success': True, 'moved': total_moved}
    if moved_e2e_ids and target_folder_id:
        ancestor_info = get_shared_ancestor_info(target_folder_id)
        if ancestor_info:
            result['needs_link_keys'] = True
            result['ancestor_share_token'] = ancestor_info['share_token']
            result['ancestor_folder_id'] = ancestor_info['folder_id']
            result['file_ids'] = moved_e2e_ids
    return jsonify(result)
