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
        current = folder
        while current:
            path_parts.insert(0, current.name)
            current = _folder_map.get(current.parent_id) if current.parent_id else None
        return ' / '.join(path_parts)

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
        # AUDIT Tier 1: Bulk-load files and folders by ID in a single query each
        # instead of one .first() per ID. With 100 selected items this turns 200
        # round-trips into 2.
        trashed_at = datetime.now(timezone.utc)
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

        # Trash folders (recursive soft-delete - files and folders preserved in trash)
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
                for folder in folders_to_trash:
                    if folder.parent_id:
                        affected_folder_ids.add(folder.parent_id)
                    trash_folder_recursive(folder.id)
                    # Detach top-level folder from parent so it doesn't show in file browser
                    folder.parent_id = None
                    deleted_folders += 1

        for fid in affected_folder_ids:
            touch_folder(fid)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    print(f'[BULK] Trashed {trashed_files} files, trashed {deleted_folders} folders by user: {user.username}')
    return jsonify({'success': True, 'trashed_files': trashed_files, 'deleted_folders': deleted_folders})

def _safe_remove_paths(paths):
    """Remove a list of file paths from disk, ignoring missing files.
    Used after a successful db.session.commit() to clean up disk files
    whose DB records have already been deleted.
    NOTE: Delegates to storage.safe_remove_paths for multi-node awareness."""
    storage.safe_remove_paths(paths)

def _quota_bytes_for_file(file):
    if not file:
        return 0
    try:
        if file.disk_size is not None:
            return int(file.disk_size or 0)
    except (TypeError, ValueError):
        pass
    try:
        return int(file.size or 0)
    except (TypeError, ValueError):
        return 0

def _aware_utc(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt

def _file_trashed_with_folder(file, root_folder):
    """Return True when a trashed file was trashed as part of root_folder's trash.

    AUDIT FIX D11: this used to be a pure timestamp comparison with a 1-second
    fudge factor, so which files came back out of the trash with their folder
    depended on clock granularity. trash_folder_recursive() now stamps an
    explicit File.trashed_via_folder marker, which is authoritative when present.
    Rows trashed BEFORE that column existed have NULL and keep the old heuristic
    -- no backfill is required for correctness, and those rows age out of the
    trash on their own within the retention window."""
    if file is not None and file.trashed_via_folder is not None:
        return bool(file.trashed_via_folder)
    root_trashed_at = _aware_utc(root_folder.trashed_at) if root_folder else None
    file_trashed_at = _aware_utc(file.trashed_at) if file else None
    if not root_trashed_at or not file_trashed_at:
        return True
    return file_trashed_at >= (root_trashed_at - timedelta(seconds=1))

def _order_folders_ancestors_first(folders):
    """Order trashed folders so an ancestor is always restored before any of its
    descendants.

    AUDIT FIX D10: bulk restore used to process folders in CLIENT-SUPPLIED order.
    Restoring [child, parent] restored the child while its parent was still
    trashed, so the child took the 'parent gone -> drive root' branch AND had its
    original_parent_id cleared; the parent then came back with no record that the
    child belonged to it. The subtree landed at the root, unrecoverably."""
    by_id = {f.id: f for f in folders if f is not None}
    ordered = []
    emitted = set()
    for folder in folders:
        if folder is None or folder.id in emitted:
            continue
        chain = []
        seen = set()
        current = folder
        while current is not None and current.id not in emitted and current.id not in seen:
            seen.add(current.id)
            chain.append(current)
            if len(chain) > _MAX_FOLDER_WALK_STEPS:
                print(f'[WARNING] Restore ordering walk from folder {folder.id} exceeded {_MAX_FOLDER_WALK_STEPS} steps; restoring remaining folders as-is')
                break
            parent_id = current.original_parent_id if current.original_parent_id is not None else current.parent_id
            current = by_id.get(parent_id)
        for fld in reversed(chain):
            if fld.id not in emitted:
                emitted.add(fld.id)
                ordered.append(fld)
    # Anything a cycle prevented us from ordering is still restored.
    for folder in folders:
        if folder is not None and folder.id not in emitted:
            emitted.add(folder.id)
            ordered.append(folder)
    return ordered

def _restore_folder_to_original_parent(folder, user):
    """Re-parent a folder that is coming out of the trash.

    AUDIT FIX D10: original_parent_id is only cleared once the re-parent has
    ACTUALLY succeeded. When the original parent is gone or still trashed the
    folder lands at the drive root but keeps the breadcrumb, so the association
    can still be recovered instead of being erased."""
    if not folder or not folder.original_parent_id:
        return
    original_parent = Folder.query.filter_by(id=folder.original_parent_id, user_id=user.id).first()
    if original_parent and not original_parent.is_trashed:
        # While this folder sat detached in the trash, a retried creation may have
        # reused its dedupe token under the same parent; re-parenting would then
        # violate uq_folder_dedupe_sibling. The token only dedupes live creation
        # retries, so the restored row can give it up.
        if folder.client_dedupe_token and Folder.query.filter(
                Folder.user_id == folder.user_id,
                Folder.parent_id == folder.original_parent_id,
                Folder.client_dedupe_token == folder.client_dedupe_token,
                Folder.id != folder.id,
        ).first():
            folder.client_dedupe_token = None
        folder.parent_id = folder.original_parent_id
        folder.original_parent_id = None
    else:
        print(f'[TRASH] Original parent {folder.original_parent_id} of folder {folder.id} is unavailable; '
              f'restoring to drive root and KEEPING the original-parent reference')
        folder.parent_id = None

def _folder_restore_file_ids_and_size(folder, counted_ids=None):
    """Return (file_ids, bytes) for a trashed folder subtree.

    AUDIT FIX (finding 9): pass a shared counted_ids set (in/out) so nested
    selections -- [parent, child] where the parent's subtree already contains
    the child -- count each file's quota at most once instead of summing the
    overlapping subtrees (which could false-block a legal restore at the
    storage limit).

    AUDIT FIX (finding 8): owner-filtered -- a stale foreign-owner row
    reachable through folder_id must not inflate THIS user's quota check."""
    if not folder:
        return set(), 0
    folder_ids = _collect_descendant_folder_ids([folder.id], include_roots=True, trashed=True)
    if not folder_ids:
        return set(), 0
    files = File.query.filter(
        File.folder_id.in_(list(folder_ids)),
        File.registered_user_id == folder.user_id,
        File.is_trashed == True,
    ).options(
        db.defer(File.thumbnail_data),
        db.defer(File.encrypted_thumbnail_data),
    ).all()
    file_ids = set()
    total_size = 0
    for file in files:
        if not _file_trashed_with_folder(file, folder):
            continue
        file_ids.add(file.id)
        if counted_ids is not None:
            if file.id in counted_ids:
                continue
            counted_ids.add(file.id)
        total_size += _quota_bytes_for_file(file)
    return file_ids, total_size

def permanently_delete_folder_recursive(folder_id, _paths_to_delete=None, retention_cutoff=None):
    """Delete a folder, its subfolders, and all files from DB. Collects disk
    paths into the provided list instead of deleting immediately -- callers
    must commit the DB changes first, then call _safe_remove_paths().
    Uses bulk-load + BFS instead of per-subfolder recursive queries.

    retention_cutoff (AUDIT FIX D5): when set (the unattended auto-purge), any
    descendant folder or file whose OWN trashed_at is newer than the cutoff has
    not served its retention window yet. It is detached to the drive root and
    left in the trash instead of being destroyed on the root folder's timer.
    Explicit user actions (empty trash / permanent delete) pass None and keep
    deleting the whole trashed subtree, which is what the user asked for.

    Returns the list of disk paths that need to be cleaned up."""
    if _paths_to_delete is None:
        _paths_to_delete = []

    root_folder = db.session.get(Folder, folder_id)
    if not root_folder:
        return _paths_to_delete
    # AUDIT FIX D4: refuse to hard-delete a live folder tree. Every caller is a
    # trash-purge path (manual permanent delete, empty trash, bulk permanent
    # delete, and the unattended auto-purge), so a non-trashed root here means
    # the caller is wrong -- destroying it would be unrecoverable.
    if not root_folder.is_trashed:
        print(f'[WARNING] Refusing to permanently delete folder {folder_id}: it is NOT in the trash')
        return _paths_to_delete

    # Bulk-load this user's TRASHED folders and BFS to find descendants.
    # AUDIT FIX D4: the query used to load ALL of the user's folders, so any
    # LIVE folder whose parent_id pointed into the trashed subtree was hard
    # deleted along with it -- including by the unattended auto-purge.
    all_folders = Folder.query.filter_by(user_id=root_folder.user_id, is_trashed=True).all()
    children_map = {}
    folder_map = {}
    for fld in all_folders:
        children_map.setdefault(fld.parent_id, []).append(fld.id)
        folder_map[fld.id] = fld

    # AUDIT FIX D3: cycle/size guarded BFS (was a bare stack.extend loop).
    # AUDIT FIX D5: skip (and detach) any descendant folder that still has
    # retention left, together with its whole subtree.
    all_folder_ids = []
    visited = set()
    stack = [folder_id]
    while stack:
        fid = stack.pop()
        if fid in visited:
            continue
        visited.add(fid)
        if len(visited) > _MAX_FOLDER_TREE_NODES:
            print(f'[WARNING] Permanent-delete walk from folder {folder_id} exceeded {_MAX_FOLDER_TREE_NODES} folders; truncating')
            break
        fld = folder_map.get(fid)
        if fld is None:
            continue
        if retention_cutoff is not None and fid != folder_id:
            fld_trashed_at = _aware_utc(fld.trashed_at)
            if fld_trashed_at is None or fld_trashed_at >= retention_cutoff:
                print(f'[CLEANUP] Folder {fid} still has trash retention left; detaching it from purged tree {folder_id} instead of destroying it')
                # It becomes a trash root of its own and is purged on its own
                # timer. Its subtree is pruned from this purge entirely.
                fld.parent_id = None
                fld.original_parent_id = None
                continue
        all_folder_ids.append(fid)
        stack.extend(children_map.get(fid, []))

    # Bulk-load and delete files in all affected folders.
    # AUDIT FIX D4: restrict to TRASHED files owned by this user. A live file
    # sitting in a trashed folder (e.g. left behind by a partial restore) must
    # not be destroyed, and the ownership filter stops another user's row from
    # ever being reachable through a stale folder_id.
    if all_folder_ids:
        files_in_folders = File.query.filter(
            File.folder_id.in_(all_folder_ids),
            File.registered_user_id == root_folder.user_id,
            File.is_trashed == True,
        ).all()
        for file in files_in_folders:
            # AUDIT FIX D5: honour each FILE's own retention window.
            if retention_cutoff is not None:
                file_trashed_at = _aware_utc(file.trashed_at)
                if file_trashed_at is None or file_trashed_at >= retention_cutoff:
                    print(f'[CLEANUP] File {file.id} still has trash retention left; detaching it from purged folder tree {folder_id} instead of destroying it')
                    if file.original_folder_id is None:
                        file.original_folder_id = file.folder_id
                    file.folder_id = None
                    continue
            _paths_to_delete.extend(_file_payload_delete_keys(file))
            db.session.delete(file)

        # Detach any surviving (live, or other-owner) rows so the folder delete
        # below cannot orphan them behind a dangling folder_id.
        _stranded = File.query.filter(
            File.folder_id.in_(all_folder_ids),
            db.or_(
                File.is_trashed == False,
                File.registered_user_id != root_folder.user_id,
                File.registered_user_id.is_(None),
            ),
        ).all()
        for file in _stranded:
            print(f'[WARNING] File {file.id} survived permanent delete of folder tree {folder_id}; detaching to root instead of destroying it')
            file.folder_id = None

        # Same for LIVE subfolders parented into the trashed subtree: move them
        # to the drive root instead of leaving a dangling parent_id.
        _stranded_folders = Folder.query.filter(
            Folder.parent_id.in_(all_folder_ids),
            Folder.is_trashed == False,
        ).all()
        for fld in _stranded_folders:
            print(f'[WARNING] Folder {fld.id} survived permanent delete of folder tree {folder_id}; detaching to root instead of destroying it')
            fld.parent_id = None

    # Delete all affected folder records
    for fid in all_folder_ids:
        fld = folder_map.get(fid)
        if fld:
            db.session.delete(fld)

    return _paths_to_delete

def restore_folder_recursive(folder_id):
    """Recursively restore a folder, its subfolders, and their files from trash.
    Uses bulk-load + BFS instead of per-subfolder recursive queries."""
    root_folder = db.session.get(Folder, folder_id)
    if not root_folder:
        return

    # Bulk-load all trashed folders for this user and BFS to find descendants
    all_trashed = Folder.query.filter_by(user_id=root_folder.user_id, is_trashed=True).all()
    children_map = {}
    folder_map = {}
    for fld in all_trashed:
        children_map.setdefault(fld.parent_id, []).append(fld.id)
        folder_map[fld.id] = fld

    # AUDIT FIX D3: cycle/size guarded BFS (was a bare stack.extend loop).
    all_folder_ids = _bfs_folder_ids(folder_id, children_map)

    # Bulk-restore files in all affected folders. Membership is decided BEFORE
    # the folders' trashed_at is cleared below: the legacy (NULL marker) branch
    # of _file_trashed_with_folder compares against root_folder.trashed_at.
    files_in_folders = File.query.filter(
        File.folder_id.in_(all_folder_ids),
        File.registered_user_id == root_folder.user_id,
        File.is_trashed == True,
    ).options(
        db.defer(File.thumbnail_data),
        db.defer(File.encrypted_thumbnail_data),
    ).all()
    trashed_with_root = {f.id for f in files_in_folders if _file_trashed_with_folder(f, root_folder)}

    # Bulk-restore folders.
    # AUDIT FIX D10: the ROOT's original_parent_id must survive until the caller
    # has actually re-parented it, otherwise a failed/late re-parent loses the
    # only record of where the subtree belonged. Descendants keep their live
    # parent_id, so clearing theirs is safe.
    for fid in all_folder_ids:
        fld = folder_map.get(fid)
        if fld:
            fld.is_trashed = False
            fld.trashed_at = None
            if fid != folder_id:
                fld.original_parent_id = None

    # AUDIT FIX (finding 8): detach foreign-owner rows from the restored tree
    # (they stay in whatever trash state they were in; only the dangling
    # folder_id reference into someone else's tree is cleared).
    stale_rows = File.query.filter(
        File.folder_id.in_(all_folder_ids),
        db.or_(File.registered_user_id.is_(None),
               File.registered_user_id != root_folder.user_id),
    ).options(
        db.defer(File.thumbnail_data),
        db.defer(File.encrypted_thumbnail_data),
    ).all()
    for file in stale_rows:
        print(f'[TRASH] Detaching stale foreign-owner file {file.id} from restored folder tree {folder_id} '
              f'(owner {file.registered_user_id} != {root_folder.user_id})')
        file.folder_id = None
    # AUDIT FIX (finding 11): files that were restored to the drive root
    # EARLIER, while this folder was still trashed, kept their
    # original_folder_id breadcrumb -- re-join them now that the tree is live.
    # Only rows still sitting at the root qualify; a file the user moved
    # elsewhere keeps its new location. (Live rows with original_folder_id set
    # can only come from that breadcrumb-preserving restore path.)
    rejoin_rows = File.query.filter(
        File.original_folder_id.in_(all_folder_ids),
        File.registered_user_id == root_folder.user_id,
        File.is_trashed == False,
        File.folder_id.is_(None),
    ).options(
        db.defer(File.thumbnail_data),
        db.defer(File.encrypted_thumbnail_data),
    ).all()
    for file in rejoin_rows:
        print(f'[TRASH] Re-joining file {file.id} to restored folder {file.original_folder_id} (retained breadcrumb)')
        file.folder_id = file.original_folder_id
        file.original_folder_id = None
    # Same for subfolders restored to the root earlier (child restored before parent).
    for fld in Folder.query.filter(
        Folder.original_parent_id.in_(all_folder_ids),
        Folder.user_id == root_folder.user_id,
        Folder.is_trashed == False,
        Folder.parent_id.is_(None),
        Folder.id != folder_id,
    ).all():
        print(f'[TRASH] Re-joining folder {fld.id} to restored folder {fld.original_parent_id} (retained breadcrumb)')
        fld.parent_id = fld.original_parent_id
        fld.original_parent_id = None
    for file in files_in_folders:
        if file.id not in trashed_with_root:
            # AUDIT FIX D11: this file was trashed on its own, so it must stay in
            # the trash -- but leaving is_trashed=True while folder_id points at a
            # now-LIVE folder left it in a limbo state. Detach it to the drive
            # root so it is unambiguously a standalone trash item; its
            # original_folder_id still records where it came from.
            if file.folder_id is not None:
                print(f'[TRASH] File {file.id} was trashed separately; keeping it in trash and detaching it from restored folder {file.folder_id}')
                if file.original_folder_id is None:
                    file.original_folder_id = file.folder_id
                file.folder_id = None
            continue
        file.is_trashed = False
        file.trashed_at = None
        file.original_folder_id = None
        file.trashed_via_folder = False

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

# Trash / Recycle Bin routes
@app.route('/trash')
@login_required
def trash():
    """Trash view.

    Renders the Files page with is_trash_view=True; the page sets
    window.__FX_INITIAL_TRASH__ and files.js opens its trash view and
    populates it from /trash/list. The legacy dashboard.html trash screen this
    route used to render is gone -- all the counts/sizes it computed server-side
    are supplied by /trash/list, so recomputing them here was dead work.
    """
    user = _current_session_user()
    if not user:
        session.pop('logged_in_user_id', None)
        return redirect(url_for('login'))

    return render_template('files.html',
                           user=user,
                           is_trash_view=True,
                           current_folder=None,
                           root_folder_name=user.root_folder_name or 'FILES')

@app.route('/trash/restore/<file_id>', methods=['POST'])
@login_required
def restore_file(file_id):
    """Restore a file from trash"""
    user = _current_session_user()
    quota_lock = _acquire_user_quota_lock(user.id)
    lifecycle_lock = None
    try:
        _refresh_quota_snapshot()
        lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
        db.session.rollback()
        user = db.session.get(User, user.id)
        file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=True).first()
        if not file:
            return jsonify({'error': 'File not found in trash'}), 404

        if not user.has_storage_available(_quota_bytes_for_file(file)):
            return _storage_limit_json(user)
    
        # Restore to original folder if it still exists and is not trashed
        if file.original_folder_id:
            original_folder = Folder.query.filter_by(id=file.original_folder_id, user_id=user.id).first()
            if original_folder and not original_folder.is_trashed:
                file.folder_id = file.original_folder_id
                file.original_folder_id = None  # breadcrumb fulfilled
            elif original_folder:
                # AUDIT FIX (finding 11): the folder still EXISTS (merely
                # trashed). Restore the file to the drive root but KEEP the
                # original_folder_id breadcrumb so the later folder restore
                # can re-associate it, instead of erasing where it came from.
                file.folder_id = None
            else:
                # Folder is gone entirely -- the breadcrumb is dead.
                file.folder_id = None
                file.original_folder_id = None
        else:
            file.folder_id = None
    
        file.is_trashed = False
        file.trashed_at = None
        file.trashed_via_folder = False
        touch_folder(file.folder_id)
        db.session.commit()
    
        print(f'[TRASH] Restored file: {file.orig_name} by user: {user.username}')
        return jsonify({'success': True})
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)

@app.route('/trash/restore-all', methods=['POST'])
@login_required
def restore_all_files():
    """Restore all files and folders from trash"""
    user = _current_session_user()

    # AUDIT FIX D9: hold the per-user quota lock across the check AND the apply.
    # Without it two concurrent restores each measured pre-restore usage, both
    # passed, and the account ended up over its storage limit.
    quota_lock = _acquire_user_quota_lock(user.id)
    lifecycle_lock = None
    try:
        _refresh_quota_snapshot()
        lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
        db.session.rollback()
        user = db.session.get(User, user.id)
        restored_files = 0
        restored_folders = 0
        required_bytes = 0
        folder_file_ids = set()
        # AUDIT FIX (finding 9): shared counted-id set (see bulk_restore).
        counted_quota_ids = set()

        # Restore top-level trashed folders first (recursively restores contents)
        trashed_folders = Folder.query.filter_by(
            user_id=user.id,
            is_trashed=True,
            parent_id=None
        ).all()

        for folder in trashed_folders:
            file_ids, folder_bytes = _folder_restore_file_ids_and_size(folder, counted_quota_ids)
            folder_file_ids.update(file_ids)
            required_bytes += folder_bytes

        for file in File.query.filter_by(registered_user_id=user.id, is_trashed=True).all():
            if file.id not in folder_file_ids:
                required_bytes += _quota_bytes_for_file(file)

        if required_bytes > 0 and not user.has_storage_available(required_bytes):
            return _storage_limit_json(user)

        # AUDIT FIX D10: restore ancestors before descendants so a child never
        # re-parents itself to the root just because its parent is still trashed.
        for folder in _order_folders_ancestors_first(trashed_folders):
            _restore_folder_to_original_parent(folder, user)
            restore_folder_recursive(folder.id)
            touch_folder(folder.parent_id)
            restored_folders += 1

        # Restore standalone trashed files (not inside trashed folders)
        trashed_files = File.query.filter_by(
            registered_user_id=user.id,
            is_trashed=True
        ).all()

        for file in trashed_files:
            if file.original_folder_id:
                original_folder = Folder.query.filter_by(id=file.original_folder_id, user_id=user.id).first()
                if original_folder and not original_folder.is_trashed:
                    file.folder_id = file.original_folder_id
                    file.original_folder_id = None  # breadcrumb fulfilled
                elif original_folder:
                    # AUDIT FIX (finding 11): folder exists but is still
                    # trashed -- restore to root, KEEP the breadcrumb so the
                    # folder restore can re-associate this file.
                    file.folder_id = None
                else:
                    file.folder_id = None
                    file.original_folder_id = None  # folder gone; breadcrumb dead
            else:
                file.folder_id = None

            file.is_trashed = False
            file.trashed_at = None
            file.trashed_via_folder = False
            touch_folder(file.folder_id)
            restored_files += 1

        db.session.commit()

        print(f'[TRASH] Restored all: {restored_files} files, {restored_folders} folders by user: {user.username}')
        return jsonify({'success': True, 'restored': restored_files + restored_folders})
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)

@app.route('/trash/empty', methods=['POST'])
@limiter.limit("5 per minute")
@login_required
def empty_trash():
    """Permanently delete all trashed files and folders"""
    user = _current_session_user()
    
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        # Collect all disk paths to delete AFTER the DB commit succeeds.
        paths_to_delete = []

        # Delete all trashed file DB records, collect their disk paths
        trashed_files = File.query.filter_by(
            registered_user_id=user.id,
            is_trashed=True
        ).all()

        deleted_files = 0
        for file in trashed_files:
            paths_to_delete.extend(_file_payload_delete_keys(file))
            db.session.delete(file)
            deleted_files += 1

        # Delete all trashed folder DB records (top-level ones cascade via recursive helper)
        trashed_folders = Folder.query.filter_by(
            user_id=user.id,
            is_trashed=True,
            parent_id=None
        ).all()

        deleted_folders = 0
        for folder in trashed_folders:
            permanently_delete_folder_recursive(folder.id, paths_to_delete)
            deleted_folders += 1

        # Also clean up any orphaned trashed subfolders.
        # AUDIT FIX (finding 11): these stranded trash subtrees used to be
        # hard-deleted bare, leaving file rows pointing at folder rows that
        # no longer exist (dangling folder_id/original_folder_id). Route them
        # through the same recursive purge as the top-level roots (deletes +
        # stages any remaining trashed contents), then detach every file row
        # that still references a destroyed folder id -- including
        # foreign-owner rows, which are NOT this user's to delete but whose
        # FK into the destroyed subtree must be cleared.
        remaining_trashed = Folder.query.filter_by(user_id=user.id, is_trashed=True).all()
        stranded_folder_ids = [fld.id for fld in remaining_trashed]
        for folder in remaining_trashed:
            permanently_delete_folder_recursive(folder.id, paths_to_delete)
        if stranded_folder_ids:
            for ref_file in File.query.filter(
                db.or_(
                    File.folder_id.in_(stranded_folder_ids),
                    File.original_folder_id.in_(stranded_folder_ids),
                )
            ).options(
                db.defer(File.thumbnail_data),
                db.defer(File.encrypted_thumbnail_data),
            ).all():
                if ref_file.folder_id in stranded_folder_ids:
                    print(f'[TRASH] Detaching file {ref_file.id} from destroyed stray folder {ref_file.folder_id}')
                    ref_file.folder_id = None
                if ref_file.original_folder_id in stranded_folder_ids:
                    ref_file.original_folder_id = None

        # AUDIT FIX (atomic permanent delete): tombstones + replica-row deletes ride
        # the same commit as the metadata-row deletions; local disk purged later.
        local_targets = storage.stage_payload_deletes(paths_to_delete)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    storage.purge_staged_locals(local_targets)
    
    print(f'[TRASH] Permanently deleted {deleted_files} files and {deleted_folders} folders by user: {user.username}')
    return jsonify({'success': True, 'deleted': deleted_files + deleted_folders})

@app.route('/trash/delete/<file_id>', methods=['POST'])
@login_required
def permanent_delete_file(file_id):
    """Permanently delete a single file from trash"""
    user = _current_session_user()
    
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        file = File.query.filter_by(id=file_id, registered_user_id=user.id, is_trashed=True).first()
        if not file:
            return jsonify({'error': 'File not found in trash'}), 404

        paths_to_delete = _file_payload_delete_keys(file)
        orig_name = file.orig_name

        # Stage delete intent atomically with the metadata deletion.
        local_targets = storage.stage_payload_deletes(paths_to_delete)
        db.session.delete(file)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    storage.purge_staged_locals(local_targets)
    
    print(f'[TRASH] Permanently deleted file: {orig_name} by user: {user.username}')
    return jsonify({'success': True})

@app.route('/trash/restore-folder/<int:folder_id>', methods=['POST'])
@login_required
def restore_folder(folder_id):
    """Restore a folder and its entire contents from trash"""
    user = _current_session_user()
    
    # AUDIT FIX D9: hold the per-user quota lock across the check AND the apply
    # so two concurrent folder restores cannot both pass a pre-restore check.
    quota_lock = _acquire_user_quota_lock(user.id)
    lifecycle_lock = None
    try:
        _refresh_quota_snapshot()
        lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
        db.session.rollback()
        user = db.session.get(User, user.id)
        folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=True).first()
        if not folder:
            return jsonify({'error': 'Folder not found in trash'}), 404

        _, required_bytes = _folder_restore_file_ids_and_size(folder)
        if required_bytes > 0 and not user.has_storage_available(required_bytes):
            return _storage_limit_json(user)

        folder_name = folder.name

        # Restore to original parent if it exists and is not trashed
        _restore_folder_to_original_parent(folder, user)

        # Recursively restore the folder and all its contents
        restore_folder_recursive(folder.id)

        touch_folder(folder.parent_id)
        db.session.commit()

        print(f'[TRASH] Restored folder: {_log_safe(folder_name)} and all contents by user: {user.username}')
        return jsonify({'success': True})
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)

@app.route('/trash/delete-folder/<int:folder_id>', methods=['POST'])
@login_required
def permanent_delete_folder(folder_id):
    """Permanently delete a folder and all its contents from trash"""
    user = _current_session_user()
    
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=True).first()
        if not folder:
            return jsonify({'error': 'Folder not found in trash'}), 404

        folder_name = folder.name

        # Collect disk paths, delete DB records
        paths_to_delete = permanently_delete_folder_recursive(folder.id)

        # Tombstones + replica deletes ride the metadata commit.
        local_targets = storage.stage_payload_deletes(paths_to_delete)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    
    # DB commit succeeded -- now safe to remove local disk payloads
    storage.purge_staged_locals(local_targets)
    
    print(f'[TRASH] Permanently deleted folder: {_log_safe(folder_name)} and all contents by user: {user.username}')
    return jsonify({'success': True})

@app.route('/trash/bulk-restore', methods=['POST'])
@login_required
def bulk_restore():
    """Bulk restore files and folders from trash"""
    user = _current_session_user()
    
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    # AUDIT FIX (finding 10): validate id payload types up front -> clean 400.
    file_ids, id_error = _parse_bulk_id_list(data.get('file_ids'), label='FILE_IDS')
    if id_error:
        return jsonify({'error': id_error}), 400
    folder_ids, id_error = _parse_bulk_id_list(data.get('folder_ids'), cast=int, label='FOLDER_IDS')
    if id_error:
        return jsonify({'error': id_error}), 400

    # AUDIT FIX D9: hold the per-user quota lock across the check AND the apply.
    quota_lock = _acquire_user_quota_lock(user.id)
    lifecycle_lock = None
    try:
        _refresh_quota_snapshot()
        lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
        db.session.rollback()
        user = db.session.get(User, user.id)
        restored = 0
        required_bytes = 0
        folder_file_ids = set()
        # AUDIT FIX (finding 9): shared counted-id set so nested folder
        # selections [parent, child] count overlapping subtree bytes once
        # instead of double-blocking a legal restore at the storage limit.
        counted_quota_ids = set()

        # AUDIT Tier 1: bulk-load trashed folders and files once instead of one
        # SELECT per ID across the quota-check pass + the restore pass, and
        # bulk-load the original-parent folders we need to validate in a single
        # query.
        try:
            folder_ids_int = [int(fid) for fid in folder_ids]
        except (TypeError, ValueError):
            folder_ids_int = []
        folders_map = {}
        if folder_ids_int:
            folders_map = {
                f.id: f for f in Folder.query.filter(
                    Folder.id.in_(folder_ids_int),
                    Folder.user_id == user.id,
                    Folder.is_trashed == True,
                ).all()
            }
        files_map = {}
        if file_ids:
            files_map = {
                f.id: f for f in File.query.filter(
                    File.id.in_(file_ids),
                    File.registered_user_id == user.id,
                    File.is_trashed == True,
                ).all()
            }

        for folder in folders_map.values():
            file_id_set, folder_bytes = _folder_restore_file_ids_and_size(folder, counted_quota_ids)
            folder_file_ids.update(file_id_set)
            required_bytes += folder_bytes

        for file in files_map.values():
            if file.id not in folder_file_ids:
                required_bytes += _quota_bytes_for_file(file)

        if required_bytes > 0 and not user.has_storage_available(required_bytes):
            return _storage_limit_json(user)

        # Bulk-load all original-parent folders we'll need to validate, in one query.
        _original_folder_ids = {
            file.original_folder_id for file in files_map.values()
            if file.original_folder_id
        }
        _parent_lookup = {}
        if _original_folder_ids:
            _parent_lookup = {
                f.id: f for f in Folder.query.filter(
                    Folder.id.in_(_original_folder_ids),
                    Folder.user_id == user.id,
                ).all()
            }

        # Restore folders first (recursively restores their contents).
        # AUDIT FIX D10: ancestors BEFORE descendants -- never the raw
        # client-supplied order, which could restore a child while its parent was
        # still trashed and permanently lose the parent association.
        for folder in _order_folders_ancestors_first(
            [folders_map[fid] for fid in folder_ids_int if fid in folders_map]
        ):
            _restore_folder_to_original_parent(folder, user)
            restore_folder_recursive(folder.id)
            touch_folder(folder.parent_id)
            restored += 1

        # Restore standalone files
        for file_id in file_ids:
            file = files_map.get(file_id)
            if not file or not file.is_trashed:
                continue
            if file.original_folder_id:
                original_folder = _parent_lookup.get(file.original_folder_id)
                if original_folder and not original_folder.is_trashed:
                    file.folder_id = file.original_folder_id
                    file.original_folder_id = None  # breadcrumb fulfilled
                elif original_folder:
                    # AUDIT FIX (finding 11): folder exists but is still
                    # trashed -- restore to root, KEEP the breadcrumb so the
                    # folder restore can re-associate this file.
                    file.folder_id = None
                else:
                    file.folder_id = None
                    file.original_folder_id = None  # folder gone; breadcrumb dead
            else:
                file.folder_id = None
            file.is_trashed = False
            file.trashed_at = None
            file.trashed_via_folder = False
            touch_folder(file.folder_id)
            restored += 1

        db.session.commit()
        print(f'[TRASH] Bulk restored {restored} items by user: {user.username}')
        return jsonify({'success': True, 'restored': restored})
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)

@app.route('/trash/bulk-delete', methods=['POST'])
@login_required
def bulk_permanent_delete():
    """Bulk permanently delete files and folders from trash"""
    user = _current_session_user()
    
    data = _json_object_body()
    # AUDIT FIX (finding 10): validate id payload types up front -> clean 400.
    file_ids, id_error = _parse_bulk_id_list(data.get('file_ids'), label='FILE_IDS')
    if id_error:
        return jsonify({'error': id_error}), 400
    folder_ids, id_error = _parse_bulk_id_list(data.get('folder_ids'), cast=int, label='FOLDER_IDS')
    if id_error:
        return jsonify({'error': id_error}), 400
    
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        deleted = 0
        paths_to_delete = []

        # AUDIT Tier 1: bulk-load trashed folders and files instead of one
        # SELECT per ID.
        try:
            folder_ids_int = [int(fid) for fid in folder_ids]
        except (TypeError, ValueError):
            folder_ids_int = []
        if folder_ids_int:
            folders_to_purge = Folder.query.filter(
                Folder.id.in_(folder_ids_int),
                Folder.user_id == user.id,
                Folder.is_trashed == True,
            ).all()
            for folder in folders_to_purge:
                permanently_delete_folder_recursive(folder.id, paths_to_delete)
                deleted += 1

        if file_ids:
            files_to_purge = File.query.filter(
                File.id.in_(file_ids),
                File.registered_user_id == user.id,
                File.is_trashed == True,
            ).all()
            for file in files_to_purge:
                paths_to_delete.extend(_file_payload_delete_keys(file))
                db.session.delete(file)
                deleted += 1

        local_targets = storage.stage_payload_deletes(paths_to_delete)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)

    storage.purge_staged_locals(local_targets)

    print(f'[TRASH] Bulk permanently deleted {deleted} items by user: {user.username}')
    return jsonify({'success': True, 'deleted': deleted})

