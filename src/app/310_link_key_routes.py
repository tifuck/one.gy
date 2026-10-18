@app.route('/file/<file_id>/regenerate-link', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
def regenerate_file_link(file_id):
    """Regenerate the share link for a file by rotating its UUID (primary key),
    renaming the physical file on disk, rotating short_code if present,
    and clearing link-wrapped keys. This fully invalidates the old share URL."""
    file = File.query.get(file_id)
    if not file:
        return jsonify({'error': 'FILE NOT FOUND'}), 404

    # Auth: logged-in owner, guest session, cookie, or admin
    guest_ok = file.registered_user_id is None and session.get('user_id') and session['user_id'] == file.user_id
    cookie_ok = file.registered_user_id is None and bool(file.manager_cookie_id) and hmac.compare_digest(request.cookies.get('onegy_manager') or '', file.manager_cookie_id or '')
    # AUDIT FIX H4: resolve the session user through the epoch-validating helper so
    # a revoked/stale cookie cannot claim ownership or admin here.
    requesting_user = _current_session_user()
    registered_ok = bool(requesting_user) and file.registered_user_id == requesting_user.id
    admin_ok = bool(requesting_user) and bool(requesting_user.is_admin)
    if not (guest_ok or cookie_ok or registered_ok or admin_ok):
        return jsonify({'error': 'ACCESS DENIED'}), 403

    old_id = file.id
    old_filename = file.filename
    old_code = file.short_code
    new_id = str(uuid.uuid4())
    new_filename = f'{new_id}.enc'
    new_short_code = generate_short_code() if file.short_code else None

    # Copy physical file to new name (keeps original until DB commit succeeds).
    # The StorageManager call also creates replica rows for the new object and
    # queues remote nodes to copy new_filename instead of inheriting stale rows.
    #
    # AUDIT FIX (F6 connectivity-aware existence): do NOT gate on
    # storage.file_exists(), which swallows per-backend connectivity errors and
    # reports a healthy-but-unreachable remote replica as "missing" — that would
    # 404 a regenerate even though the file exists on a temporarily unreachable
    # node. Resolve the source through get_file_path() instead, which performs
    # verified local/remote failover and only returns None when no node can
    # actually serve the bytes.
    try:
        old_path = storage.get_file_path(old_filename)
        if old_path and os.path.exists(old_path):
            storage.store_file_copy(new_filename, old_path)
        else:
            print(f'[FILE] Warning: physical file not retrievable during regenerate: {old_filename}')
            return jsonify({'error': 'FAILED TO REGENERATE LINK — FILE DATA UNAVAILABLE'}), 404
    except Exception as e:
        print(f'[FILE] Error copying file during regenerate: {e}')
        return jsonify({'error': 'FAILED TO REGENERATE LINK — FILE SYSTEM ERROR'}), 500

    # Copy thumbnail files to new names (mirrors the file copy-first approach)
    _thumb_copies = []  # list of (old_thumb_path, new_thumb_path) for rollback
    _thumb_copy_failed = False  # AUDIT FIX (finding 15)
    if file.has_thumbnail:
        for _ext in ('.jpg', '.e2e'):
            _old_tp = os.path.join(THUMBNAILS_DIR, f'{old_id}{_ext}')
            if os.path.exists(_old_tp):
                _new_tp = os.path.join(THUMBNAILS_DIR, f'{new_id}{_ext}')
                try:
                    shutil.copy2(_old_tp, _new_tp)
                    _thumb_copies.append((_old_tp, _new_tp))
                    _thumb_type = 'e2e' if _ext == '.e2e' else 'jpg'
                    if storage._local_node_id and storage._local_node_id in storage._backends:
                        storage._mark_replica_synced('thumbnail', f'{new_id}:{_thumb_type}', storage._local_node_id)
                        storage._mark_pending_replicas('thumbnail', f'{new_id}:{_thumb_type}', storage._local_node_id)
                    else:
                        storage._mark_pending_replicas('thumbnail', f'{new_id}:{_thumb_type}', None)
                except OSError as e:
                    # AUDIT FIX (finding 15): a failed copy used to be a bare
                    # warning -- the row then kept has_thumbnail=True under the
                    # NEW id while the new-id thumb file never existed (broken
                    # thumbnail for the file, with the old thumb about to be
                    # tombstoned). Record it; has_thumbnail is cleared below
                    # after the PK rotation so the response never advertises a
                    # thumbnail that is not there.
                    _thumb_copy_failed = True
                    print(f'[FILE] Warning: failed to copy thumbnail {_ext} during regenerate: {e}')

    # Update PK + filename via raw SQL (SQLAlchemy ORM does not support PK mutation)
    # Also update replica tracking tables that reference file.id
    _old_local_targets = []
    try:
        db.session.execute(
            db.text('UPDATE file SET id = :new_id, filename = :new_filename WHERE id = :old_id'),
            {'new_id': new_id, 'new_filename': new_filename, 'old_id': old_id}
        )
        # AUDIT FIX (regenerate atomic tombstone): the old object has been
        # rotated away to new_id/new_filename. Stage the OLD file + OLD thumbnail
        # remote-delete tombstones AND the old replica-row deletions into THIS
        # transaction so they commit atomically with the PK rotation. Previously
        # the old replica rows were deleted, the metadata committed, and the old
        # object was only tombstoned afterwards via an `if file_existed:` branch
        # whose variable was never defined — so the post-commit cleanup always
        # raised NameError -> 500 while the regenerate had actually succeeded,
        # leaving the old local/remote payload untracked with NO delete intent
        # (a permanent backup-node orphan). stage_payload_deletes() also removes
        # the old file_replica + thumbnail_replica rows for old_id, so the prior
        # raw DELETE statements are folded into this single atomic step.
        _old_delete_keys = [f'storage://files/{old_filename}']
        for _old_tp, _new_tp in _thumb_copies:
            _old_delete_keys.append(f'storage://thumbnails/{os.path.basename(_old_tp)}')
        _old_local_targets = storage.stage_payload_deletes(_old_delete_keys)

        db.session.expire_all()
        file = db.session.get(File, new_id)

        # AUDIT FIX (finding 15): fail safe when a thumbnail copy failed --
        # the new id has no thumb file on disk, so stop advertising one
        # (unless a legacy in-DB blob can still serve it).
        if _thumb_copy_failed and file.has_thumbnail and not (
                file.thumbnail_data or file.encrypted_thumbnail_data):
            print(f'[FILE] Clearing has_thumbnail for {new_id}: thumbnail copy failed during regenerate '
                  f'and no in-DB thumbnail blob is available')
            file.has_thumbnail = False

        # Rotate short_code if present
        if new_short_code:
            file.short_code = new_short_code

        # Clear any existing link-wrapped keys (they reference the old URL context)
        file.link_encrypted_file_key = None
        file.link_file_key_nonce = None
        file.link_secret = None
        file.is_link_shared = False

        # AUDIT FIX A20: same check-then-insert race as the upload path -- redraw
        # the code on a uniqueness collision instead of 500ing a regenerate whose
        # payload copy has already been written.
        _commit_with_short_code_retry(file)
    except Exception as e:
        db.session.rollback()
        # Remove the copy since the DB update failed (original file is still intact)
        try:
            if storage.file_exists(new_filename):
                storage.delete_file(new_filename)
        except Exception:
            pass
        # Remove thumbnail copies since the DB update failed
        for _old_tp, _new_tp in _thumb_copies:
            try:
                if os.path.exists(_new_tp):
                    os.remove(_new_tp)
            except OSError:
                pass
        print(f'[FILE] Error updating database during regenerate: {e}')
        return jsonify({'error': 'FAILED TO REGENERATE LINK — DATABASE ERROR'}), 500

    # DB commit succeeded: the new object is tracked and the OLD file + thumbnail
    # objects were tombstoned and un-tracked atomically above. Purge the OLD
    # local disk payloads best-effort. A crash here only leaves a benign local
    # orphan (reaped by cleanup_orphaned_files) and can NEVER 500 the request.
    try:
        storage.purge_staged_locals(_old_local_targets)
    except Exception as e:
        print(f'[FILE] Warning: failed to purge old local payloads after regenerate: {e}')

    if file.short_code:
        new_share_url = f'https://{domain}/s/{file.short_code}'
    else:
        new_share_url = f'https://{domain}/f/{new_id}/{urllib.parse.quote(file.orig_name)}'
    print(f'[FILE] Regenerated share link for file: {file.orig_name} (old id: {old_id}, new id: {new_id}, old code: {old_code}, new code: {file.short_code})')
    return jsonify({'success': True, 'share_url': new_share_url, 'short_code': file.short_code, 'new_id': new_id})

@app.route('/folder/<int:folder_id>/regenerate-link', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def regenerate_folder_link(folder_id):
    """Regenerate the share link for a folder by assigning a new share_token.
    This invalidates the old share URL."""
    user = _current_session_user()
    folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
    if not folder:
        return jsonify({'error': 'FOLDER NOT FOUND'}), 404

    old_token = folder.share_token
    folder.share_token = str(uuid.uuid4())
    folder.link_secret = None
    folder.is_link_shared = False
    folder.updated_at = datetime.now(timezone.utc)
    # Clear link-wrapped folder name key (new share token invalidates old link key)
    folder.link_encrypted_name_key = None
    folder.link_name_key_nonce = None

    cleared = _clear_e2e_link_keys_for_folder_tree(folder.id)
    if cleared:
        print(f'[FOLDER] Cleared {cleared} descendant E2E file link key(s) during link regeneration')
    # Clear link-wrapped name keys on all subfolders recursively.
    # AUDIT FIX D3: iterative + visited-guarded (was unbounded recursion that a
    # parent_id cycle turned into an infinite loop).
    def clear_subfolder_link_name_keys(root_id):
        visited = set()
        stack = [root_id]
        while stack:
            fid = stack.pop()
            if fid in visited:
                continue
            visited.add(fid)
            if len(visited) > _MAX_FOLDER_TREE_NODES:
                print(f'[WARNING] Link-key clearing walk from folder {root_id} exceeded {_MAX_FOLDER_TREE_NODES} folders; truncating')
                break
            for sf in Folder.query.filter_by(parent_id=fid, is_trashed=False).all():
                if sf.link_encrypted_name_key:
                    sf.link_encrypted_name_key = None
                    sf.link_name_key_nonce = None
                stack.append(sf.id)
    clear_subfolder_link_name_keys(folder.id)

    db.session.commit()

    new_share_url = f'https://{domain}/f/{folder.share_token}'
    print(f'[FOLDER] Regenerated share link for folder: {_log_safe(folder.name)} (old token: {old_token}, new token: {folder.share_token})')
    return jsonify({'success': True, 'share_url': new_share_url, 'share_token': folder.share_token})

@app.route('/f/<file_id>/link-key', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def set_link_key(file_id):
    """Store a link-wrapped file key for share link decryption.
    The file key is re-wrapped with a link-specific secret (stored in URL fragment).
    This allows anyone with the share link to decrypt without needing the user's master key."""
    file = db.session.get(File, file_id)
    if not file or not file.is_e2e_encrypted:
        return jsonify({'error': 'FILE NOT FOUND'}), 404
    
    # Verify the current user owns this file (AUDIT FIX H4: epoch-validated)
    _link_key_user = _current_session_user()
    if not file.registered_user_id or not _link_key_user or file.registered_user_id != _link_key_user.id:
        return jsonify({'error': 'ACCESS DENIED'}), 403
    
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data.get('encrypted_file_key') or not data.get('file_key_nonce'):
        return jsonify({'error': 'INVALID REQUEST'}), 400

    if 'scope' not in data or data.get('scope') is None:
        scope = 'file'
    elif not isinstance(data.get('scope'), str):
        return jsonify({'error': 'INVALID LINK KEY SCOPE'}), 400
    else:
        scope = data.get('scope').strip().lower()
        if scope not in ('file', 'folder'):
            return jsonify({'error': 'INVALID LINK KEY SCOPE'}), 400
    _wrap_err = _e2ee_wrap_field_error((
        ('encrypted_file_key', data['encrypted_file_key'], 48),
        ('file_key_nonce', data['file_key_nonce'], 12),
    ))
    if _wrap_err:
        return _wrap_err
    
    # Store link-wrapped key in separate columns (does NOT overwrite the primary key)
    # The primary encrypted_file_key stays master-key-wrapped for the owner's own access
    if scope == 'folder':
        file.folder_link_encrypted_file_key = data['encrypted_file_key']
        file.folder_link_file_key_nonce = data['file_key_nonce']
    else:
        file.link_encrypted_file_key = data['encrypted_file_key']
        file.link_file_key_nonce = data['file_key_nonce']
    file.is_link_shared = True
    # link_secret is no longer stored server-side — derived client-side via HKDF
    db.session.commit()
    
    print(f'[FILE] Link key set for file: {file.orig_name}')
    return jsonify({'success': True})

@app.route('/folder/<int:folder_id>/link-secret', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def set_folder_link_secret(folder_id):
    """Mark a folder as having an active E2E link share.
    The link secret is now derived client-side via HKDF from the master key + share_token,
    so the server no longer stores or returns it.
    
    If this folder is a child of a browsable ancestor, the ancestor is marked instead."""
    user = _current_session_user()
    folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
    if not folder:
        return jsonify({'error': 'FOLDER NOT FOUND'}), 404
    
    # If this folder is inside a browsable ancestor's tree, mark the ancestor
    target_folder = folder
    if not folder.is_browsable:
        browsable_ancestor = is_folder_in_browsable_ancestor(folder)
        if browsable_ancestor:
            if browsable_ancestor.is_link_shared:
                # Ancestor already marked — return its share_token for HKDF derivation
                print(f'[FOLDER] Subfolder {_log_safe(folder.name)} is in browsable tree of {_log_safe(browsable_ancestor.name)} — ancestor already shared')
                return jsonify({'success': True, 'redirected_to_ancestor': True, 'ancestor_share_token': browsable_ancestor.share_token})
            target_folder = browsable_ancestor
    
    target_folder.is_link_shared = True
    db.session.commit()
    
    if target_folder.id != folder_id:
        print(f'[FOLDER] Link shared set for browsable ancestor {_log_safe(target_folder.name)} (requested for child {_log_safe(folder.name)})')
    else:
        print(f'[FOLDER] Link shared set for folder: {_log_safe(folder.name)}')
    return jsonify({'success': True, 'share_token': target_folder.share_token})

@app.route('/folder/<int:folder_id>/name-link-key', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def set_folder_name_link_key(folder_id):
    """Store a link-wrapped folder name key for share link visitors.
    The folder name key is re-wrapped with the link-specific secret (URL fragment).
    This allows anyone with the share link to decrypt the folder name."""
    user = _current_session_user()
    folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
    if not folder:
        return jsonify({'error': 'FOLDER NOT FOUND'}), 404
    if not folder.encrypted_name_key:
        return jsonify({'error': 'FOLDER HAS NO ENCRYPTED NAME'}), 400
    
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data.get('encrypted_name_key') or not data.get('nonce'):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    _wrap_err = _e2ee_wrap_field_error((
        ('encrypted_name_key', data['encrypted_name_key'], 48),
        ('name_key_nonce', data['nonce'], 12),
    ))
    if _wrap_err:
        return _wrap_err
    
    folder.link_encrypted_name_key = data['encrypted_name_key']
    folder.link_name_key_nonce = data['nonce']
    db.session.commit()
    
    print(f'[FOLDER] Link name key set for folder: {_log_safe(folder.name)} (id={folder.id})')
    return jsonify({'success': True})

@app.route('/folder/<int:folder_id>/encrypt-name', methods=['POST'])
@limiter.limit(file_ops_rate_limit)
@login_required
def encrypt_folder_name(folder_id):
    """Encrypt an existing folder's plaintext name (migration for pre-existing E2EE folders).
    Called by the client-side auto-migration flow on dashboard load."""
    user = _current_session_user()
    folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_trashed=False).first()
    if not folder:
        return jsonify({'error': 'FOLDER NOT FOUND'}), 404
    if folder.encrypted_name:
        # Already encrypted — skip
        return jsonify({'success': True, 'already_encrypted': True})
    
    enc_name = request.form.get('encrypted_name')
    enc_nonce = request.form.get('name_nonce')
    enc_key = request.form.get('encrypted_name_key')
    enc_key_nonce = request.form.get('name_key_nonce')
    
    if not (enc_name and enc_nonce and enc_key and enc_key_nonce):
        return jsonify({'error': 'MISSING ENCRYPTED NAME DATA'}), 400
    
    # Validate that encrypted fields are real base64, not 'undefined' from JS bugs
    valid, err_msg = validate_encrypted_folder_name_fields(enc_name, enc_nonce, enc_key, enc_key_nonce)
    if not valid:
        print(f'[FOLDER] Rejected encrypt-name for folder id={folder_id}: {err_msg}')
        return jsonify({'error': err_msg}), 400
    
    folder.encrypted_name = enc_name
    folder.name_nonce = enc_nonce
    folder.encrypted_name_key = enc_key
    folder.name_key_nonce = enc_key_nonce
    folder.name = f'encrypted_folder_{folder.id}'
    folder.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    
    print(f'[FOLDER] Encrypted folder name for folder id={folder.id} by user: {user.username}')
    return jsonify({'success': True})

@app.route('/files/shared-folders-needing-keys')
@limiter.limit(default_rate_limit)
@login_required
def shared_folders_needing_keys():
    """Return shared E2E folders that have unkeyed files.
    Called by the dashboard on load to auto-key files that were uploaded
    after the folder share link was generated.
    
    Skips subfolders that are descendants of a browsable folder — the browsable
    root handles its entire tree and is_link_shared flags the shared state."""
    user = _current_session_user()
    if not user:
        return jsonify({'folders': []})
    
    # Find all E2E folders marked as link-shared owned by this user
    shared_folders = Folder.query.filter(
        Folder.user_id == user.id,
        Folder.is_trashed == False,
        Folder.is_link_shared == True
    ).all()
    
    # Build a set of browsable folder IDs and their full subtrees
    # so we can skip subfolders that belong to a browsable parent
    browsable_folder_ids = [f.id for f in shared_folders if f.is_browsable]
    browsable_subtree_ids = _collect_descendant_folder_ids(browsable_folder_ids, include_roots=False)

    result = []
    for folder in shared_folders:
        # Skip non-browsable folders that are inside a browsable folder's tree
        # (the browsable root will handle keying for the entire tree)
        if not folder.is_browsable and folder.id in browsable_subtree_ids:
            continue

        # Use the browsable ancestor's share_token for HKDF derivation
        ancestor_info = get_shared_ancestor_info(folder.id)
        effective_share_token = ancestor_info['share_token'] if ancestor_info else folder.share_token

        # Count unkeyed E2E files across the entire folder subtree in a single query
        subtree_ids = _collect_descendant_folder_ids([folder.id], include_roots=True)
        unkeyed_count = File.query.filter(
            File.folder_id.in_(list(subtree_ids)),
            File.is_temp_upload == False,
            File.is_trashed == False,
            File.is_e2e_encrypted == True,
            (File.folder_link_encrypted_file_key == None) | (File.folder_link_encrypted_file_key == '')
        ).count()
        # Also check if the folder itself needs its name key wrapped for link sharing
        needs_name_key = bool(folder.encrypted_name and not folder.link_encrypted_name_key)
        if unkeyed_count > 0 or needs_name_key:
            fld_entry = {
                'folder_id': folder.id,
                'share_token': effective_share_token,
                'name': folder.name,
                'unkeyed_count': unkeyed_count,
                'needs_name_key': needs_name_key,
            }
            if folder.is_e2e is True and folder.encrypted_name:
                fld_entry['encrypted_name'] = folder.encrypted_name
                fld_entry['name_nonce'] = folder.name_nonce
                fld_entry['encrypted_name_key'] = folder.encrypted_name_key
                fld_entry['name_key_nonce'] = folder.name_key_nonce
            result.append(fld_entry)
    
    if result:
        print(f'[AUTO-KEY] User {user.username} has {len(result)} shared folder(s) with unkeyed files')
    return jsonify({'folders': result})

@app.route('/files/e2ee-folders-needing-name-encryption')
@limiter.limit(default_rate_limit)
@login_required
def e2ee_folders_needing_name_encryption():
    """Return E2E folders owned by the current user that have no encrypted_name set.
    Used for auto-migration: existing E2E folders created before folder name encryption
    still have their real name in plaintext. The client encrypts and stores via /folder/<id>/encrypt-name."""
    user = _current_session_user()
    if not user:
        return jsonify({'folders': []})

    folders = Folder.query.filter(
        Folder.user_id == user.id,
        Folder.is_trashed == False,
        Folder.is_e2e == True,
        (Folder.encrypted_name == None) | (Folder.encrypted_name == '')
    ).all()

    result = []
    for f in folders:
        # Skip folders whose name already looks like a placeholder
        if f.name and f.name.startswith('encrypted_folder_'):
            continue
        result.append({
            'id': f.id,
            'name': f.name,
        })

    if result:
        print(f'[FOLDER-NAME-MIGRATION] User {user.username} has {len(result)} E2E folder(s) needing name encryption')
    return jsonify({'folders': result})

@app.route('/f/<share_token>/unkeyed-e2e-files')
@limiter.limit(default_rate_limit)
@login_required
def browse_folder_unkeyed_e2e_files(share_token):
    """Return all E2E files in a shared folder tree that lack link_encrypted_file_key.
    Owner-only. Used by _autoKeyUnkeyedFiles to key files across all subfolders."""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return jsonify({'error': 'ACCESS DENIED'}), 403
    if not is_owner:
        return jsonify({'error': 'OWNER ONLY'}), 403

    subtree_ids = _collect_descendant_folder_ids([folder.id], include_roots=True)
    files = File.query.filter(
        File.folder_id.in_(list(subtree_ids)),
        File.is_temp_upload == False,
        File.is_trashed == False,
        File.is_e2e_encrypted == True,
        (File.folder_link_encrypted_file_key == None) | (File.folder_link_encrypted_file_key == '')
    ).all()
    unkeyed = [{'id': f.id, 'name': f.orig_name} for f in files if f.encrypted_file_key]

    print(f'[AUTO-KEY] Found {len(unkeyed)} unkeyed E2E file(s) in folder tree: {_log_safe(folder.name)}')
    return jsonify({'files': unkeyed})

@app.route('/f/<share_token>/unkeyed-e2e-folders')
@limiter.limit(default_rate_limit)
@login_required
def browse_folder_unkeyed_e2e_folders(share_token):
    """Return all E2E folders in a shared folder tree that lack link_encrypted_name_key.
    Owner-only. Used by _autoKeyUnkeyedFolderNames to wrap folder name keys for
    share link visitors (so they can decrypt folder names in the browse view)."""
    folder, is_owner, error = check_folder_access(share_token)
    if error is not None:
        return jsonify({'error': 'ACCESS DENIED'}), 403
    if not is_owner:
        return jsonify({'error': 'OWNER ONLY'}), 403

    # Load the entire subtree (including root) in batched queries, then filter in Python
    subtree_ids = _collect_descendant_folder_ids([folder.id], include_roots=True)
    subtree_folders = Folder.query.filter(
        Folder.id.in_(list(subtree_ids)),
        Folder.is_e2e == True,
        Folder.is_trashed == False
    ).all()
    unkeyed = [
        {
            'id': f.id,
            'name': f.name,
            'encrypted_name_key': f.encrypted_name_key,
            'name_key_nonce': f.name_key_nonce,
        }
        for f in subtree_folders
        if f.encrypted_name_key and not f.link_encrypted_name_key
    ]

    if unkeyed:
        print(f'[AUTO-KEY] Found {len(unkeyed)} unkeyed E2E folder(s) in folder tree: {_log_safe(folder.name)}')
    return jsonify({'folders': unkeyed})

@app.route('/f/<file_id>/key-info')
@limiter.limit(thumbnail_rate_limit)
def file_key_info(file_id):
    """Return the E2EE key metadata for a file (JSON).
    Used by the client to determine which decryption method to use
    before fetching the (potentially large) encrypted file data."""
    file = File.query.get(file_id)
    if not file:
        return jsonify({'error': 'FILE NOT FOUND'}), 404

    is_owner = _current_user_owns_file(file)
    if file.is_trashed and not is_owner:
        return jsonify({'error': 'FILE NOT FOUND'}), 404
    if not is_owner:
        if not _file_not_expired(file):
            return jsonify({'error': 'FILE NOT FOUND'}), 404
        if not _file_share_password_ok(file, is_owner):
            return jsonify({'error': 'FILE NOT FOUND'}), 404
        if not file.is_public:
            public_folder = is_file_in_public_folder(file)
            browsable_folder = is_file_in_browsable_folder(file) if not public_folder else None
            # Same rule as download_encrypted: a share password grants access
            # to a private file outside shared folders.
            if not public_folder and not browsable_folder and not file.password_hash:
                return jsonify({'error': 'FILE NOT FOUND'}), 404
        if file.is_e2e_encrypted and not _e2e_file_has_non_owner_key(file):
            return jsonify({'error': 'FILE NOT FOUND'}), 404

    if not file.is_e2e_encrypted:
        return jsonify({'is_e2e': False})
    
    include_primary_key = is_owner or bool(file.file_key_salt)
    result = {
        'is_e2e': True,
        'has_file_key': bool(file.encrypted_file_key and include_primary_key),
        'has_link_key': bool(file.link_encrypted_file_key),
        'has_folder_link_key': bool(getattr(file, 'folder_link_encrypted_file_key', None)),
        'has_legacy_passphrase': bool(file.e2e_salt and file.e2e_iv),
    }
    
    if file.encrypted_file_key and include_primary_key:
        result['encrypted_file_key'] = file.encrypted_file_key
        result['file_key_nonce'] = file.file_key_nonce
        result['file_key_salt'] = file.file_key_salt  # None for master-key-wrapped, present for passphrase-wrapped
    
    # Link-wrapped key (for share links) — separate from the primary key
    if file.link_encrypted_file_key:
        result['link_encrypted_file_key'] = file.link_encrypted_file_key
        result['link_file_key_nonce'] = file.link_file_key_nonce
    if getattr(file, 'folder_link_encrypted_file_key', None):
        result['folder_link_encrypted_file_key'] = file.folder_link_encrypted_file_key
        result['folder_link_file_key_nonce'] = file.folder_link_file_key_nonce
    
    if file.e2e_salt:
        result['e2e_salt'] = file.e2e_salt
    if file.e2e_iv:
        result['e2e_iv'] = file.e2e_iv
    
    # Encrypted filename for client-side decryption
    if file.encrypted_name:
        result['encrypted_name'] = file.encrypted_name
        result['name_nonce'] = file.name_nonce
    
    return jsonify(result)

@app.route('/f/batch-key-info', methods=['POST'])
@limiter.limit("30 per minute")
@login_required
def batch_file_key_info():
    """Return E2EE key metadata for multiple files in a single request.
    Avoids N+1 /f/<id>/key-info fetches when generating link keys for shared folders.
    Only returns keys for files owned by the logged-in user."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get('file_ids'), list):
        return jsonify({'error': 'MISSING FILE_IDS ARRAY'}), 400
    # AUDIT FIX (finding 10): a list of non-scalar entries (dicts/objects)
    # reached File.id.in_() and raised a DBAPIError -> 500. Validate types
    # and answer 400 instead.
    file_ids, id_error = _parse_bulk_id_list(data['file_ids'], label='FILE_IDS')
    if id_error:
        return jsonify({'error': id_error}), 400
    file_ids = file_ids[:200]  # Cap at 200 files per batch
    # AUDIT FIX H4: epoch-validated user resolution.
    _batch_user = _current_session_user()
    if not _batch_user:
        return jsonify({'error': 'SESSION_EXPIRED'}), 401
    user_id = _batch_user.id
    files = File.query.filter(
        File.id.in_(file_ids),
        File.registered_user_id == user_id,
        File.is_e2e_encrypted == True
    ).all()
    results = {}
    for f in files:
        entry = {
            'is_e2e': True,
            'has_file_key': bool(f.encrypted_file_key),
        }
        if f.encrypted_file_key:
            entry['encrypted_file_key'] = f.encrypted_file_key
            entry['file_key_nonce'] = f.file_key_nonce
            entry['file_key_salt'] = f.file_key_salt
        if f.encrypted_name:
            entry['encrypted_name'] = f.encrypted_name
            entry['name_nonce'] = f.name_nonce
        results[f.id] = entry
    return jsonify({'keys': results})

@app.route('/f/<file_id>/encrypted')
@limiter.limit(download_rate_limit)
def download_encrypted(file_id):
    """Download endpoint for E2E encrypted files - returns raw encrypted data
    
    IMPORTANT: This endpoint serves the file exactly as stored on disk.
    E2E files have NO server-side encryption - only client-side encryption.
    The client will decrypt the file using the user's passphrase.
    """
    file = File.query.get(file_id)
    if not file or not file.is_e2e_encrypted:
        return render_template('notfound.html',
            title='FILE NOT FOUND',
            subtitle='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED',
            detail='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED'), 404

    # Block trashed files unless the logged-in user owns them (for trash preview)
    if file.is_trashed:
        # AUDIT FIX H4: epoch-validated ownership, not a bare cookie read.
        _trash_owner = _current_session_user()
        is_owner = bool(_trash_owner) and file.registered_user_id == _trash_owner.id
        if not is_owner:
            return render_template('notfound.html',
                title='FILE NOT FOUND',
                subtitle='THIS FILE HAS BEEN DELETED BY ITS OWNER'), 404

    # Check expiration FIRST (before counting downloads)
    expires_at_aware = file.get_expires_at_aware()
    if expires_at_aware and expires_at_aware < datetime.now(timezone.utc):
        file, deleted_name = _delete_immediately_expired_file(file)
        if deleted_name:
            print(f'[ENCRYPTED] File expired, deleted: {deleted_name}')
            return render_template('notfound.html',
                title='FILE EXPIRED',
                subtitle='THIS FILE HAS PASSED ITS EXPIRATION DATE AND HAS BEEN REMOVED',
                detail='EXPIRED FILES ARE AUTOMATICALLY DELETED FOR SECURITY'), 404
        if not file:
            return render_template('notfound.html',
                title='FILE NOT FOUND',
                subtitle='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED'), 404

    # Check if user owns the file
    is_owner = _current_user_owns_file(file)

    if not _file_share_password_ok(file, is_owner):
        return render_template('pw.html', file_id=file_id, error=bool(_get_share_password()))

    # Check access permissions
    # Also check if file is inside a public or browsable folder (folder inherits access)
    if not file.is_public:
        public_folder = is_file_in_public_folder(file)
        browsable_folder = is_file_in_browsable_folder(file)
        if public_folder:
            print(f'[ENCRYPTED] File {file.orig_name} accessible via public folder: {_log_safe(public_folder.name)}')
        elif browsable_folder:
            print(f'[ENCRYPTED] File {file.orig_name} accessible via browsable folder: {_log_safe(browsable_folder.name)}')
        elif not is_owner and not file.password_hash:
            return render_template('notfound.html',
                title='FILE NOT FOUND',
                subtitle='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED',
                detail='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED'), 404

        if not is_owner and not _e2e_file_has_non_owner_key(file):
            return render_template('notfound.html',
                title='FILE NOT FOUND',
                subtitle='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED',
                detail='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED'), 404

    encrypted_path = storage.get_file_path(file.filename)
    if not encrypted_path or not os.path.exists(encrypted_path):
        return render_template('notfound.html',
            title='FILE UNAVAILABLE',
            subtitle='THE ENCRYPTED FILE DATA COULD NOT BE LOCATED ON THE SERVER',
            detail='THE FILE RECORD EXISTS BUT THE DATA IS MISSING'), 404

    # AUDIT FIX S3: reject a corrupt/truncated E2EE payload before emitting the
    # 200 + Content-Length headers (checked against the committed disk_size, BEFORE
    # the metadata-backfill below which would otherwise overwrite a missing size).
    if not _payload_disk_size_matches(encrypted_path, file.disk_size):
        print(f'[ERROR] [ENCRYPTED] Disk-size mismatch for {file.id} -- refusing to stream truncated download')
        return render_template('notfound.html',
            title='FILE UNAVAILABLE',
            subtitle='THE ENCRYPTED FILE FAILED AN INTEGRITY CHECK',
            detail='THE STORED FILE DATA DOES NOT MATCH ITS RECORDED SIZE'), 500

    if request.method == 'HEAD':
        return _build_streaming_response(
            lambda: iter(()), 'application/octet-stream', content_length=file.disk_size)

    # Owner preview/play must not consume share-link slots. Deliberate downloads
    # omit ?preview=1 and still increment. Visitors cannot skip the counter.
    owner_preview = is_owner and request.args.get('preview') == '1'
    if not owner_preview:
        success, error = check_and_increment_download(file)
        if not success:
            if error == 'limit_reached':
                return 'Download limit reached', 410
            return render_template('notfound.html',
                title='DOWNLOAD UNAVAILABLE',
                subtitle='THIS FILE COULD NOT BE DOWNLOADED AT THIS TIME',
                detail='THE DOWNLOAD CHECK FAILED. THE FILE MAY HAVE BEEN REMOVED'), 404

    # Send the raw encrypted data back to client for decryption.
    # E2E files are NOT Fernet encrypted - they're stored as-is from client encryption.
    response_headers = {}
    # Legacy E2E metadata (old passphrase-based system)
    if file.e2e_salt:
        response_headers['X-E2E-Salt'] = file.e2e_salt
    if file.e2e_iv:
        response_headers['X-E2E-IV'] = file.e2e_iv
    # MEGA-style E2EE metadata (new per-file key system)
    include_primary_key_header = is_owner or bool(file.file_key_salt)
    if file.encrypted_file_key and include_primary_key_header:
        response_headers['X-Encrypted-File-Key'] = file.encrypted_file_key
    if file.file_key_nonce and include_primary_key_header:
        response_headers['X-File-Key-Nonce'] = file.file_key_nonce
    if file.file_key_salt:
        response_headers['X-File-Key-Salt'] = file.file_key_salt
    
    expose_headers = 'X-E2E-Salt, X-E2E-IV, X-Encrypted-File-Key, X-File-Key-Nonce, X-File-Key-Salt'
    response_headers['Access-Control-Expose-Headers'] = expose_headers
    # Download count was already atomically incremented above.
    # Verify on-disk size + SHA-256 matches what was recorded at upload time
    # so silent corruption of the encrypted blob produces an [ERROR] log line
    # and aborts the response. AUDIT Tier 0 #1.
    return _build_streaming_response(
        lambda: _iter_file_chunks(
            encrypted_path,
            expected_checksum=file.payload_checksum,
            expected_size=file.disk_size,
            file_id=file.id,
            corruption_kind='e2ee-payload',
        ),
        'application/octet-stream',
        # AUDIT FIX (finding 14): this endpoint streams the ENCRYPTED
        # container, so Content-Length must be the on-disk disk_size (the
        # bytes actually sent, already integrity-checked above) -- file.size
        # is the PLAINTEXT size and clients saw a body shorter/longer than
        # the advertised length whenever the E2EE framing overhead differed.
        content_length=file.disk_size,
        headers=response_headers,
        on_finalize=(None if owner_preview else (lambda completed: finalize_reserved_download(file.id, completed)))
    )

