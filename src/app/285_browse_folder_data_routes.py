# Public shared-folder browse (/f/<share_token>): listing JSON, search, file lists and thumbnails. Downloads live in 290.

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
    
    folder_sizes, browse_e2e_counts, browse_file_counts, browse_has_mixed = _browse_tree_stats(
        folder, all_subfolders, all_files)
    
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


@app.route('/f/<share_token>/folder/<int:subfolder_id>/files')
@limiter.limit(download_rate_limit)
def browse_folder_list_files(share_token, subfolder_id):
    """List files in a subfolder of a browsable shared folder (JSON).
    Used by client-side E2E ZIP download to discover files before decrypting."""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return jsonify({'error': 'ACCESS DENIED'}), 403
    
    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        ancestor = is_folder_in_browsable_ancestor(folder)
        if not ancestor:
            ancestor = is_folder_in_public_browsable_ancestor(folder)
        if not ancestor:
            return jsonify({'error': 'NOT BROWSABLE'}), 403
    
    # AUDIT FIX P2: enforce sub-folder trash AND expiry, not just containment.
    if not _shared_subfolder_available(subfolder_id, folder):
        return jsonify({'error': 'NOT FOUND'}), 404
    
    _fl_folder_name_map = []
    # Bulk-load the subtree + files up front, then walk in-memory in the same
    # DFS order as the old recursive version (2 queries per folder -> 2 total).
    def collect_files_json(root_id):
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

        def _walk(fld_obj, path_prefix):
            fld_e2e_boundary = _e2e_upload_boundary_for_folder(fld_obj)
            for f in files_by_folder.get(fld_obj.id, []):
                # AUDIT FIX P1: do not offer an expired file to the client-side
                # ZIP builder either.
                if not _file_not_expired(f):
                    continue
                if not is_owner and fld_e2e_boundary and not f.is_e2e_encrypted:
                    continue
                if f.password_hash:
                    continue
                # Hide E2EE files without link/passphrase-scoped keys from non-owners.
                if f.is_e2e_encrypted and not is_owner and not _e2e_file_has_non_owner_key(f):
                    continue
                entry = {
                    'id': f.id,
                    # AUDIT FIX P14: this fed a CLIENT-SIDE E2EE ZIP builder from
                    # RAW orig_name / folder name, so traversal neutralisation
                    # depended entirely on the consumer -- and the server-side ZIP
                    # path for the same data DID sanitise, which is exactly how a
                    # zip-slip regression gets reintroduced. Sanitise at the source.
                    'name': build_safe_browse_path(path_prefix, f.orig_name),
                    'is_e2e': f.is_e2e_encrypted,
                    'size': f.size
                }
                entry.update(_client_zip_file_fields(f, is_owner, share_token))
                result.append(entry)
            for sf in children_map.get(fld_obj.id, []):
                # AUDIT FIX P2: an expired sub-folder cuts off everything below it.
                if not _folder_not_expired(sf) or _locked_folder_share(sf, folder):
                    continue
                safe_sf_name = safe_zip_entry_name(sf.name)
                sf_path = build_safe_browse_path(path_prefix, sf.name)
                # Track encrypted folder name data for client-side path reconstruction.
                # `placeholder` must be the SANITISED segment so it still matches the
                # path segments emitted above (AUDIT FIX P14).
                if sf.is_e2e is True and sf.encrypted_name:
                    fn_entry = {'id': sf.id, 'placeholder': safe_sf_name, 'encrypted_name': sf.encrypted_name, 'name_nonce': sf.name_nonce}
                    if is_owner:
                        fn_entry['encrypted_name_key'] = sf.encrypted_name_key
                        fn_entry['name_key_nonce'] = sf.name_key_nonce
                    if sf.link_encrypted_name_key:
                        fn_entry['link_encrypted_name_key'] = sf.link_encrypted_name_key
                        fn_entry['link_name_key_nonce'] = sf.link_name_key_nonce
                    _fl_folder_name_map.append(fn_entry)
                _walk(sf, sf_path)

        _walk(root_obj, '')
        return result
    
    files = collect_files_json(subfolder_id)
    resp = {'files': files}
    # AUDIT FIX P12: a single-use, signed ticket the client must echo back to
    # /track-folder-download after it finishes its client-side ZIP build. See
    # _issue_folder_download_ticket().
    resp['download_ticket'] = _issue_folder_download_ticket(share_token, subfolder_id)
    if _fl_folder_name_map:
        resp['folder_names'] = _fl_folder_name_map
    return jsonify(resp)

@app.route('/f/<share_token>/all-files')
@limiter.limit(download_rate_limit)
def browse_folder_all_files(share_token):
    """List ALL files in the root shared folder recursively (JSON).
    Used by client-side E2E 'Download All' to discover files before decrypting."""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return jsonify({'error': 'ACCESS DENIED'}), 403

    folder_is_browsable = folder.is_browsable
    if not folder_is_browsable:
        ancestor = is_folder_in_browsable_ancestor(folder)
        if not ancestor:
            ancestor = is_folder_in_public_browsable_ancestor(folder)
        if not ancestor:
            return jsonify({'error': 'NOT BROWSABLE'}), 403

    _af_folder_name_map = []
    # Bulk-load the subtree + files up front, then walk in-memory in the same
    # DFS order as the old recursive version (2 queries per folder -> 2 total).
    def collect_all_files_json(root_id):
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

        def _walk(fld_obj, path_prefix):
            fld_e2e_boundary = _e2e_upload_boundary_for_folder(fld_obj)
            for f in files_by_folder.get(fld_obj.id, []):
                # AUDIT FIX P1: expired files are not offered for download-all.
                if not _file_not_expired(f):
                    continue
                if not is_owner and fld_e2e_boundary and not f.is_e2e_encrypted:
                    continue
                if f.password_hash:
                    continue
                if f.is_e2e_encrypted and not is_owner and not _e2e_file_has_non_owner_key(f):
                    continue
                entry = {
                    'id': f.id,
                    # AUDIT FIX P14: sanitise at the source (see browse_folder_list_files).
                    'name': build_safe_browse_path(path_prefix, f.orig_name),
                    'is_e2e': f.is_e2e_encrypted,
                    'size': f.size
                }
                entry.update(_client_zip_file_fields(f, is_owner, share_token))
                result.append(entry)
            for sf in children_map.get(fld_obj.id, []):
                # AUDIT FIX P2: an expired sub-folder cuts off everything below it.
                if not _folder_not_expired(sf) or _locked_folder_share(sf, folder):
                    continue
                safe_sf_name = safe_zip_entry_name(sf.name)
                sf_path = build_safe_browse_path(path_prefix, sf.name)
                if sf.is_e2e is True and sf.encrypted_name:
                    fn_entry = {'id': sf.id, 'placeholder': safe_sf_name, 'encrypted_name': sf.encrypted_name, 'name_nonce': sf.name_nonce}
                    if is_owner:
                        fn_entry['encrypted_name_key'] = sf.encrypted_name_key
                        fn_entry['name_key_nonce'] = sf.name_key_nonce
                    if sf.link_encrypted_name_key:
                        fn_entry['link_encrypted_name_key'] = sf.link_encrypted_name_key
                        fn_entry['link_name_key_nonce'] = sf.link_name_key_nonce
                    _af_folder_name_map.append(fn_entry)
                _walk(sf, sf_path)

        _walk(root_obj, '')
        return result

    files = collect_all_files_json(folder.id)
    print(f'[BROWSE DOWNLOAD] Listed all files for download-all: {len(files)} files in folder {_log_safe(folder.name)}')
    resp = {'files': files, 'folder_name': folder.name}
    # AUDIT FIX P12: single-use ticket for /track-folder-download (see below).
    resp['download_ticket'] = _issue_folder_download_ticket(share_token, folder.id)
    # Include root folder encrypted name data
    if folder.is_e2e is True and folder.encrypted_name:
        resp['folder_name_encrypted'] = folder.encrypted_name
        resp['folder_name_nonce'] = folder.name_nonce
        if is_owner:
            resp['folder_name_key'] = folder.encrypted_name_key
            resp['folder_name_key_nonce'] = folder.name_key_nonce
        if folder.link_encrypted_name_key:
            resp['folder_link_name_key'] = folder.link_encrypted_name_key
            resp['folder_link_name_key_nonce'] = folder.link_name_key_nonce
    if _af_folder_name_map:
        resp['folder_names'] = _af_folder_name_map
    return jsonify(resp)
