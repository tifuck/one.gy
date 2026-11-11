def get_shared_ancestor_link_secret(folder_id):
    """Walk up the folder tree from folder_id to find the best link_secret for sharing.
    DEPRECATED: Only used during migration. New code should use get_shared_ancestor_info().
    Returns the link_secret string if found, else None."""
    current_id = folder_id
    visited = set()
    nearest_secret = None
    while current_id is not None and current_id not in visited:
        visited.add(current_id)
        folder = db.session.get(Folder, current_id)
        if not folder or folder.is_trashed:
            break
        if folder.link_secret:
            if nearest_secret is None:
                nearest_secret = folder.link_secret
            if folder.is_browsable:
                return folder.link_secret
        current_id = folder.parent_id
    return nearest_secret

def _walker_cache(name):
    """Return the per-request memoization dict for a walker function (keyed by folder id).
    Survives only for the current request via flask.g; avoids repeated tree walks."""
    attr = f'_walker_cache_{name}'
    cache = getattr(g, attr, None)
    if cache is None:
        cache = {}
        try:
            setattr(g, attr, cache)
        except RuntimeError:
            # No request context; return a throwaway dict
            return {}
    return cache

def get_shared_ancestor_info(folder_id):
    """Walk up the folder tree from folder_id to find the shared ancestor.
    Returns { 'share_token': str, 'folder_id': int } of the browsable ancestor
    that has is_link_shared=True, or None if no shared ancestor exists.
    The client uses the share_token to derive the link secret via HKDF."""
    cache = _walker_cache('shared_ancestor_info')
    if folder_id in cache:
        return cache[folder_id]
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
                cache[folder_id] = info
                return info
        current_id = folder.parent_id
    cache[folder_id] = nearest_info
    return nearest_info

def is_folder_in_public_ancestor(folder, require_password=True):
    """Check if a folder has a public ancestor in its tree (browsable not required).
    Returns the ancestor folder if found, else None."""
    cache = _walker_cache('public_ancestor' if require_password else 'public_ancestor_nopw')
    key = folder.id if folder else None
    if key in cache:
        return cache[key]
    current_id = folder.parent_id
    visited = set()
    result = None
    while current_id is not None and current_id not in visited:
        visited.add(current_id)
        ancestor = db.session.get(Folder, current_id)
        # An expired folder cuts off inherited access for everything below it.
        if not _folder_not_expired(ancestor):
            break
        if ancestor.is_public:
            if require_password and ancestor.password_hash:
                break
            result = ancestor
            break
        current_id = ancestor.parent_id
    cache[key] = result
    return result

def is_folder_in_public_browsable_ancestor(folder):
    """Check if a folder has a public+browsable ancestor in its tree.
    Returns the ancestor folder if found, else None."""
    cache = _walker_cache('public_browsable_ancestor')
    key = folder.id if folder else None
    if key in cache:
        return cache[key]
    current_id = folder.parent_id
    visited = set()
    result = None
    while current_id is not None and current_id not in visited:
        visited.add(current_id)
        ancestor = db.session.get(Folder, current_id)
        if not _folder_not_expired(ancestor):
            break
        if ancestor.is_public and ancestor.is_browsable:
            result = ancestor
            break
        current_id = ancestor.parent_id
    cache[key] = result
    return result

def is_folder_in_browsable_ancestor(folder, require_password=True):
    """Check if a folder has a browsable ancestor (public or E2E) in its tree.
    Returns the ancestor folder if found, else None.

    AUDIT FIX P9: `require_password=False` finds the ancestor whose share EXISTS
    without demanding the share password first. ONLY check_folder_access() may
    use it, because it immediately runs _folder_share_password_ok() on the
    returned ancestor and renders the password prompt. Every other caller keeps
    the default, so no route becomes reachable without the password."""
    cache = _walker_cache('browsable_ancestor' if require_password else 'browsable_ancestor_nopw')
    key = folder.id if folder else None
    if key in cache:
        return cache[key]
    current_id = folder.parent_id
    visited = set()
    result = None
    while current_id is not None and current_id not in visited:
        visited.add(current_id)
        ancestor = db.session.get(Folder, current_id)
        if not _folder_not_expired(ancestor):
            break
        if _folder_has_active_non_owner_share(ancestor, require_browsable=True, require_password=require_password):
            result = ancestor
            break
        current_id = ancestor.parent_id
    cache[key] = result
    return result

def get_root_browsable_ancestor(folder):
    """Find the highest browsable ancestor of a folder.
    Returns the root browsable ancestor if found, else None.
    This is the folder whose browsable/E2E settings dictate policy for all children."""
    cache = _walker_cache('root_browsable_ancestor')
    key = folder.id if folder else None
    if key in cache:
        return cache[key]
    root_browsable = None
    current_id = folder.parent_id
    visited = set()
    while current_id is not None and current_id not in visited:
        visited.add(current_id)
        ancestor = db.session.get(Folder, current_id)
        if not _folder_not_expired(ancestor):
            break
        if ancestor.is_browsable:
            root_browsable = ancestor
        current_id = ancestor.parent_id
    cache[key] = root_browsable
    return root_browsable

def _locked_folder_share(folder, root_folder):
    """Return the first locked folder between the target and its share root."""
    user = _current_session_user()
    if user and user.id == root_folder.user_id:
        return None
    chains = _walker_cache('folder_share_chains')
    if folder.id not in chains:
        chains[folder.id] = _folder_ancestor_ids(folder.id)
    chain = chains[folder.id]
    if root_folder.id not in chain:
        return root_folder
    checks = _walker_cache('folder_share_password_checks')
    for fid in chain:
        current = folder if fid == folder.id else db.session.get(Folder, fid)
        if not current:
            return root_folder
        if current.password_hash:
            key = (current.id, current.password_hash)
            if key not in checks:
                checks[key] = _folder_share_password_ok(current)
            if not checks[key]:
                return current
        if fid == root_folder.id:
            break
    return None


def check_folder_access(share_token):
    """Verify access to a shared folder. Returns (folder, is_owner, error_response) tuple.
    If error_response is not None, return it immediately."""
    folder = Folder.query.filter_by(share_token=share_token, is_trashed=False).first()
    if not folder:
        return None, False, (render_template('notfound.html',
            title='FOLDER NOT FOUND',
            subtitle='THE SHARED FOLDER YOU ARE LOOKING FOR DOES NOT EXIST',
            detail='THE LINK MAY BE INVALID OR THE FOLDER MAY HAVE BEEN DELETED'), 404)
    
    # Check expiration
    if folder.expires_at:
        expires_aware = folder.get_expires_at_aware()
        if expires_aware and expires_aware < datetime.now(timezone.utc):
            return None, False, (render_template('notfound.html',
                title='FOLDER EXPIRED',
                subtitle='THIS SHARED FOLDER HAS PASSED ITS EXPIRATION DATE',
                detail='THE FOLDER OWNER CAN RE-SHARE IT WITH A NEW LINK'), 404)
    
    # Check if user owns the folder
    is_owner = False
    if 'logged_in_user_id' in session and folder.user_id:
        user = _current_session_user()
        if user and user.id == folder.user_id:
            is_owner = True
    
    # AUDIT FIX M6: centralized share-password gate. The previous logic
    # short-circuited `folder.is_public` without checking `password_hash`,
    # creating a latent share-password bypass. We now require the password
    # for any password-protected folder (or password-protected ancestor)
    # before the caller can read it, regardless of public/browsable mode.
    # The prompt always posts back to the REQUESTED token: rendering the locked
    # ancestor's token handed a sub-folder visitor the ancestor's link, and the
    # password they needed anyway then unlocked the whole ancestor tree.
    def _pw_block():
        return None, False, (render_template('pw.html', token=share_token, is_folder=True, error=bool(_get_share_password())), 401)

    # Check access permissions
    if not folder.is_public:
        # Folder is not public itself - check if it has an active browsable share.
        # AUDIT FIX P9 (ordering): ask only whether the share EXISTS, then run the
        # password gate below. Folding the password into this predicate made a
        # password-protected browsable share fall THROUGH to the login redirect,
        # so the visitor was never shown the prompt and the share was permanently
        # unusable (and the gate two lines down was dead code).
        if not is_owner and _folder_has_active_non_owner_share(folder, require_browsable=True, require_password=False):
            # E2E browsable folder: allow access (decryption happens client-side)
            if _locked_folder_share(folder, folder):
                return _pw_block()
            print(f'[FOLDER] E2E browsable folder accessed: {_log_safe(folder.name)}')
            return folder, is_owner, None
        # Check if it's inside a public or browsable ancestor
        public_ancestor = is_folder_in_public_ancestor(folder, require_password=False)
        if public_ancestor:
            if _locked_folder_share(folder, public_ancestor):
                return _pw_block()
            print(f'[FOLDER] Subfolder {_log_safe(folder.name)} accessible via public ancestor: {_log_safe(public_ancestor.name)}')
            return folder, is_owner, None
        # Check if inside a browsable ancestor (same ordering fix as above).
        browsable_ancestor = is_folder_in_browsable_ancestor(folder, require_password=False)
        if browsable_ancestor:
            if _locked_folder_share(folder, browsable_ancestor):
                return _pw_block()
            print(f'[FOLDER] Subfolder {_log_safe(folder.name)} accessible via browsable ancestor: {_log_safe(browsable_ancestor.name)}')
            return folder, is_owner, None
        if not is_owner:
            return None, False, (render_template('notfound.html',
                title='FILE NOT FOUND',
                subtitle='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED',
                detail='THE LINK MAY BE INVALID OR THE FILE MAY HAVE BEEN REMOVED'), 404)
    # Public folders fall through here. Gate on the password if set.
    if _locked_folder_share(folder, folder):
        return _pw_block()

    return folder, is_owner, None

def _browse_subtree_maps(root_folder_id):
    """Load ONLY the shared subtree rooted at root_folder_id, once per request.

    Returns (folder_map, children_map). Expired (and trashed) folders are pruned
    together with everything beneath them, so no BFS built on children_map can
    reach into an expired branch.

    AUDIT FIX P13: collect_browsable_files() and collect_browsable_folders() each
    issued `Folder.query.filter_by(user_id=..., is_trashed=False).all()` -- the
    OWNER'S ENTIRE folder table, not the shared subtree -- and browse_folder_json
    calls both on every request, as do browse_folder_search and the HTML render.
    An anonymous visitor at 200 req/min turned every page load into two full-table
    scans of somebody else's drive. Now scoped to the subtree and memoized per
    request through the existing _walker_cache pattern.

    AUDIT FIX P2: pruning expired folders here is what makes sub-folder expiry
    stick on the listing/collection paths."""
    cache = _walker_cache('browse_subtree')
    if root_folder_id in cache:
        return cache[root_folder_id]
    subtree_ids = _collect_descendant_folder_ids([root_folder_id], include_roots=True, trashed=False)
    folders = []
    if subtree_ids:
        folders = Folder.query.filter(Folder.id.in_(list(subtree_ids))).all()
    folder_map = {fld.id: fld for fld in folders}
    children_map = {}
    for fld in folders:
        # The root itself is validated by check_folder_access(); every DESCENDANT
        # must independently be non-trashed and unexpired to stay reachable.
        if fld.id == root_folder_id:
            continue
        if not _folder_not_expired(fld) or _locked_folder_share(fld, folder_map[root_folder_id]):
            continue
        children_map.setdefault(fld.parent_id, []).append(fld.id)
    result = (folder_map, children_map)
    cache[root_folder_id] = result
    return result

def _shared_subfolder_available(subfolder_id, root_folder):
    """Resolve a sub-folder inside a shared tree, or None.

    AUDIT FIX P2: every sub-folder-scoped route used to resolve its target with
    nothing but `Folder.query.filter_by(id=..., is_trashed=False)`. _folder_not_expired()
    had exactly ONE caller, so an owner who set expires_at on a sub-folder inside
    a shared tree got NO enforcement -- it stayed browsable and ZIP-downloadable
    through the parent's token forever. This enforces trash AND expiry on the
    sub-folder AND on every folder between it and the share root (an expired
    intermediate folder must cut off everything beneath it too).

    Containment is checked the same way is_subfolder_of() does, so this is a
    strict tightening of the old `is_subfolder_of(...) + filter_by(is_trashed=False)`
    pair it replaces."""
    if subfolder_id is None or not root_folder:
        return None
    chain = _folder_ancestor_ids(subfolder_id)
    if root_folder.id not in chain:
        return None
    for fid in chain:
        if fid == root_folder.id:
            break
        if not _folder_not_expired(db.session.get(Folder, fid)):
            return None
    subfolder = db.session.get(Folder, subfolder_id)
    if _locked_folder_share(subfolder, root_folder):
        return None
    return subfolder

# AUDIT FIX P12: single-use, signed proof that a client actually enumerated a
# shared folder before it reports a client-side ZIP download. Handed out by
# /f/<token>/all-files and /f/<token>/folder/<id>/files (the exact endpoints the
# client-side E2EE ZIP builder calls first) and redeemed exactly once by
# /f/<token>/track-folder-download. Per-nonce flocked state makes redemption
# atomic across workers.
_FOLDER_DL_TICKET_TTL_SECONDS = 3600
_folder_dl_used_tickets = {}   # nonce -> expiry epoch (non-authoritative mirror)
_folder_dl_ticket_lock = threading.Lock()

def _folder_download_ticket_signature(share_token, folder_id, issued, nonce):
    secret = app.config['SECRET_KEY'].encode('utf-8')
    payload = f'{share_token}:{folder_id}:{issued}:{nonce}'.encode('utf-8')
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()

def _issue_folder_download_ticket(share_token, folder_id):
    issued = int(time.time())
    nonce = secrets.token_hex(8)
    return f'{issued}.{nonce}.{_folder_download_ticket_signature(share_token, folder_id, issued, nonce)}'

def _consume_folder_download_ticket(ticket, share_token, folder_id):
    """Verify and burn a download ticket. Returns True exactly once per ticket."""
    if not ticket or not isinstance(ticket, str):
        return False
    parts = ticket.split('.')
    if len(parts) != 3:
        return False
    issued_raw, nonce, signature = parts
    try:
        issued = int(issued_raw)
    except (TypeError, ValueError):
        return False
    now = int(time.time())
    if not (0 <= (now - issued) < _FOLDER_DL_TICKET_TTL_SECONDS):
        return False
    expected = _folder_download_ticket_signature(share_token, folder_id, issued, nonce)
    # Bytes: compare_digest raises TypeError on str input with non-ASCII characters.
    if not hmac.compare_digest(signature.encode('utf-8'), expected.encode('utf-8')):
        return False
    expiry = issued + _FOLDER_DL_TICKET_TTL_SECONDS
    locks = _acquire_security_state_locks([('folder_dl_ticket', nonce)])
    try:
        state = _read_security_state('folder_dl_ticket', nonce)
        if _security_state_fresh(state, now):
            return False
        _write_security_state('folder_dl_ticket', nonce, {
            'expires': expiry,
            'retain_until': expiry,
        })
    finally:
        _release_security_state_locks(locks)
    with _folder_dl_ticket_lock:
        _folder_dl_used_tickets[nonce] = expiry
        if len(_folder_dl_used_tickets) > 8192:
            _folder_dl_used_tickets.clear()
    return True

def _browse_file_accessible(file, root_folder, is_owner, folder_is_browsable, require_downloadable=False):
    """Single-file equivalent of the collect_browsable_files() access filter.

    AUDIT FIX P8: the thumbnail routes applied a much weaker filter than the
    listing they serve -- containment only -- skipping the E2E upload boundary,
    the is_temp_upload filter, the exhausted-max_downloads filter and the expiry
    check, and using is_subfolder_of() (which does not inspect is_trashed) so
    containment succeeded through trashed intermediate folders. That turned them
    into a content-preview oracle for files the browse listing deliberately hides."""
    if not file or file.is_trashed or file.is_temp_upload:
        return False
    if not _file_not_expired(file):
        return False
    if not file.folder_id:
        return False
    file_folder = _shared_subfolder_available(file.folder_id, root_folder)
    if not file_folder:
        return False
    if not is_owner and _e2e_upload_boundary_for_folder(file_folder) and not file.is_e2e_encrypted:
        return False
    if not file.is_public and file.registered_user_id and not (root_folder.is_public or folder_is_browsable):
        if not is_owner:
            return False
    if file.password_hash:
        return False
    if file.is_e2e_encrypted and not is_owner and not _e2e_file_has_non_owner_key(file):
        return False
    if require_downloadable and file.max_downloads and (file.download_count or 0) >= file.max_downloads:
        return False
    return True

def collect_browsable_files(folder_id, is_owner, folder_is_public, root_has_link_secret=False):
    """Collect file objects from a folder tree for the browse view.
    Uses bulk queries + BFS instead of per-folder recursive queries."""
    root_folder = db.session.get(Folder, folder_id)
    if not root_folder or root_folder.is_trashed:
        return []

    # AUDIT FIX P13: memoize the whole result per request -- browse_folder_json
    # calls this AND collect_browsable_folders on every request, as do the search
    # endpoint and the HTML render.
    cache_key = (folder_id, bool(is_owner), bool(folder_is_public))
    cache = _walker_cache('browse_files')
    if cache_key in cache:
        return cache[cache_key]

    # AUDIT FIX P13: subtree-scoped + request-memoized (was a full-table scan of
    # the owner's whole drive on every call).
    _folder_map, _children_map = _browse_subtree_maps(folder_id)
    # AUDIT FIX D3: cycle/size guarded BFS.
    _subtree_ids = set(_bfs_folder_ids(folder_id, _children_map))

    # Bulk-load all files in the subtree (single query)
    all_files = File.query.filter(
        File.folder_id.in_(_subtree_ids),
        File.is_temp_upload == False,
        File.is_trashed == False
    ).all()

    # Apply access filtering in memory
    def _under_e2e_boundary(fid):
        current_id = fid
        visited = set()
        while current_id is not None and current_id not in visited:
            visited.add(current_id)
            # Keep walking above the share root: an enforcing ancestor of a
            # child-token root bounds that root's files too.
            current = _folder_map.get(current_id) or db.session.get(Folder, current_id)
            if not current:
                break
            current_requires_e2e = current.is_e2e is True and bool(current.encrypted_name or current.encrypted_name_key)
            # Same rule as _e2e_upload_boundary_for_folder: an ancestor only
            # enforces E2EE when it is browsable (or is the file's own folder).
            if current_requires_e2e and (current_id == fid or current.is_browsable):
                return True
            current_id = current.parent_id
        return False

    result = []
    for file in all_files:
        # AUDIT FIX P1: an expired file must not even be OFFERED through a folder
        # token -- this collector backs the listing, the single-file download and
        # the download-selected allow-list.
        if not _file_not_expired(file):
            continue
        if not is_owner and not file.is_e2e_encrypted and _under_e2e_boundary(file.folder_id):
            continue
        if not file.is_public and file.registered_user_id and not folder_is_public:
            if not is_owner:
                continue
        if file.password_hash:
            continue
        if file.is_e2e_encrypted and not is_owner and not _e2e_file_has_non_owner_key(file):
            continue
        result.append(file)
    cache[cache_key] = result
    return result

def collect_browsable_folders(folder_id):
    """Collect all descendant folder objects using bulk query + BFS."""
    root_folder = db.session.get(Folder, folder_id)
    if not root_folder:
        return []
    # AUDIT FIX P13/P2: subtree-scoped, request-memoized, expired branches pruned.
    _folder_map, _children_map = _browse_subtree_maps(folder_id)
    # AUDIT FIX D3: cycle/size guarded BFS (was a bare queue.extend loop).
    _subtree_ids = [fid for fid in _bfs_folder_ids(folder_id, _children_map) if fid != folder_id]
    return [_folder_map[fid] for fid in _subtree_ids if fid in _folder_map]

def is_subfolder_of(child_id, root_id):
    """Check if child_id is a descendant of root_id.
    AUDIT FIX D3: cycle- and depth-bounded (was an unbounded parent walk).

    NOTE: containment ONLY -- it does not inspect is_trashed or expires_at. Any
    token-scoped route resolving a sub-folder must use
    _shared_subfolder_available() instead (AUDIT FIX P2)."""
    return root_id in _folder_ancestor_ids(child_id)

def build_browse_breadcrumbs(current_folder_id, root_folder):
    """Build breadcrumb trail from root folder to current subfolder.
    AUDIT FIX D3: a visited set + step bound so a corrupt parent_id cycle can
    never spin this request thread forever."""
    crumbs = []
    seen = set()
    steps = 0
    current = db.session.get(Folder, current_folder_id)
    while current and current.id != root_folder.id:
        steps += 1
        if current.id in seen or steps > _MAX_FOLDER_WALK_STEPS:
            print(f'[WARNING] Breadcrumb walk from folder {current_folder_id} hit a cycle or depth bound; truncating trail')
            break
        seen.add(current.id)
        crumbs.insert(0, current)
        if current.parent_id is None:
            break
        current = db.session.get(Folder, current.parent_id)
    return crumbs


def _browse_tree_stats(folder, all_subfolders, all_files):
    """Per-folder totals over a shared tree rooted at folder: recursive size, E2EE file count,
    file count, and whether a folder mixes E2EE and plain subfolders.
    Returns (folder_sizes, e2e_counts, file_counts, has_mixed), keyed by folder id."""
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
    return folder_sizes, browse_e2e_counts, browse_file_counts, browse_has_mixed
