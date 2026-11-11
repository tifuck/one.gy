# Download limits: reserve/finalize/rollback per-file download counts and delete files that hit max downloads.

def _file_payload_delete_keys(file):
    """Return logical storage keys that should be removed with a file record."""
    if not file:
        return []
    keys = [f'storage://files/{file.filename}']
    for _ext in ('.jpg', '.e2e'):
        keys.append(f'storage://thumbnails/{file.id}{_ext}')
    return keys

def _note_payload_delete_key(note_id):
    return f'storage://notes/{note_id}'


def _purge_staged_locals_with_note_locks(local_targets):
    """Purge committed deletes, serializing note payload removal with saves."""
    for target in local_targets or []:
        category, object_id = target
        if category != 'notes':
            storage.purge_staged_locals([target])
            continue
        note_lock = _acquire_note_rewrite_lock(object_id)
        try:
            db.session.rollback()
            if db.session.get(Note, object_id) is not None:
                print(f'[STORAGE] Skipping local note purge for {object_id}: Note row still exists')
                continue
            storage.purge_staged_locals([target])
        finally:
            _release_note_rewrite_lock(note_lock)


def _delete_immediately_expired_file(file):
    """Recheck and atomically delete an expired file under its lifecycle lock."""
    lifecycle_lock = _acquire_file_lifecycle_lock(file)
    local_targets = []
    deleted_name = None
    fresh_file = None
    try:
        db.session.rollback()
        fresh_file = db.session.get(File, file.id, populate_existing=True)
        if not fresh_file:
            return None, None
        expires_at = fresh_file.get_expires_at_aware()
        if not expires_at or expires_at >= datetime.now(timezone.utc):
            return fresh_file, None
        deleted_name = fresh_file.orig_name
        local_targets = storage.stage_payload_deletes(_file_payload_delete_keys(fresh_file))
        db.session.delete(fresh_file)
        db.session.commit()
        fresh_file = None
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    storage.purge_staged_locals(local_targets)
    return fresh_file, deleted_name


def _download_cleanup_paths(file):
    """Return logical payload keys that should be removed with a file record."""
    return _file_payload_delete_keys(file)

def _mark_file_for_download_limit_delete(file):
    """Burn-after-N reached: mark the file for DEFERRED deletion (M7 FIX).

    This used to hard-delete the File row and its payload the instant the
    reserved download count hit max_downloads. That raced any OTHER request
    that had legally reserved an earlier slot and was still mid-stream: the
    reaper unlinked the payload, the stream's next read (or lazy re-open by
    path) failed with OSError, and the client received a truncated body under
    an already-sent 200 + Content-Length.

    The row is now only MARKED (pending_delete_at = now):
    - check_download_allowed() / check_and_reserve_download() treat a marked
      row as exhausted, so it immediately stops serving NEW downloads;
    - in-flight streams drain from the still-intact payload;
    - cleanup_expired_files() hard-deletes the row + payload (with remote
      delete tombstones, via the same atomic staging as every other delete)
      once DOWNLOAD_LIMIT_DELETE_GRACE has elapsed. Burn-after-N semantics
      hold -- just deferred past the longest legal stream.

    The stamp is a compare-and-swap so concurrent finalizes cannot move the
    marker later and thereby extend the grace window."""
    if not file:
        return

    file_id = file.id
    orig_name = file.orig_name

    try:
        marked = db.session.query(File).filter(
            File.id == file_id,
            File.pending_delete_at.is_(None),
        ).update(
            {'pending_delete_at': datetime.now(timezone.utc)},
            synchronize_session=False
        )
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f'[LIMIT] Failed to mark exhausted file {orig_name} ({file_id}) for deferred deletion: {e}')
        return

    if marked:
        print(f'[LIMIT] Download limit reached for {orig_name} ({file_id}) -- deletion deferred to cleanup (grace: {DOWNLOAD_LIMIT_DELETE_GRACE})')
    else:
        print(f'[LIMIT] Download limit reached for {orig_name} ({file_id}) -- already marked for deferred deletion')

def check_download_allowed(file):
    """Check whether a file can still be downloaded without consuming a count yet."""
    if not file.max_downloads:
        return True, None

    fresh = db.session.get(File, file.id, populate_existing=True)
    if not fresh:
        return False, 'limit_reached'

    # M7 FIX: a burned row (limit reached, deletion deferred via
    # pending_delete_at) serves nothing -- including during the grace window
    # and even if rollback_reserved_download() later pulls the counter back
    # below the cap for an undelivered slot.
    if fresh.pending_delete_at is not None:
        return False, 'limit_reached'

    current_count = fresh.download_count or 0
    # AUDIT FIX (finding 2): refresh reads against the DB column -- a
    # concurrent limit removal made `count < fresh.max_downloads` a
    # TypeError (int < None) and turned a legal download into a 500.
    if not fresh.max_downloads or current_count < fresh.max_downloads:
        return True, None

    return False, 'limit_reached'

# DEAD CODE REMOVED (residual audit item k): record_completed_download() had
# ZERO callers anywhere in the repository. Downloads are counted by
# check_and_reserve_download() / check_and_increment_download() (reserve) plus
# finalize_reserved_download() (commit), which enforce max_downloads
# atomically; a second, unreferenced counting path only invited double counts.

def check_and_reserve_download(file):
    """
    Atomically reserve a download slot by incrementing count.
    Returns (success, error_message, reservation) where `reservation` is an
    opaque token identifying THE SLOT THIS CALL TOOK. Pass it to
    rollback_reserved_download() to release that specific slot.

    AUDIT FIX D8: the token lives in the caller's own stack frame, so a request
    can only ever release a slot it actually reserved.
    """
    if not file:
        return False, 'unavailable', None

    # AUDIT FIX (finding 2): the reservation guard must compare the DB COLUMN
    # File.max_downloads, never the Python attribute fetched earlier in this
    # request -- an admin edit (or a concurrent request) may have changed or
    # removed the limit after the ORM object was loaded, and this UPDATE is
    # the authoritative under-concurrency decision:
    #   * unlimited row  -> plain increment (matches the old unlimited path,
    #     including rows with pending_delete_at set);
    #   * limited row    -> pending_delete_at guard + count < max DOWN IN SQL.
    # The old code bound the STALE Python value into the comparison, so a
    # removed limit evaluated `count < NULL` -> no match -> and then raised
    # TypeError in the refresh below; an added limit was bypassed entirely.
    for _attempt in range(2):
        result = db.session.query(File).filter(
            File.id == file.id,
            db.or_(
                File.max_downloads.is_(None),
                db.and_(
                    File.pending_delete_at.is_(None),
                    db.func.coalesce(File.download_count, 0) < File.max_downloads,
                ),
            ),
        ).update(
            {"download_count": db.func.coalesce(File.download_count, 0) + 1},
            synchronize_session=False
        )
        db.session.commit()

        if result:
            return True, None, _build_download_reservation(file.id)

        # Refreshed reads for the failure classification (the commit above
        # expired the identity map, so this re-read hits the DB).
        fresh = db.session.get(File, file.id)
        if not fresh:
            return False, 'unavailable', None
        if fresh.max_downloads:
            if fresh.pending_delete_at is not None or (fresh.download_count or 0) >= fresh.max_downloads:
                return False, 'limit_reached', None
        # The row changed between the UPDATE and this refresh (limit removed,
        # or a concurrent rollback freed a slot): retry once against the
        # refreshed row before giving up.
    return False, 'unavailable', None

def _build_download_reservation(file_id):
    """Capture the counter position a just-taken reservation occupies.

    Read back AFTER the commit; under concurrency another reservation may have
    landed in between, which only makes the recorded position HIGHER and so
    makes the release check below stricter (fail closed = the slot stays
    consumed), never looser."""
    reserved_count = None
    try:
        fresh = db.session.get(File, file_id)
        if fresh:
            reserved_count = int(fresh.download_count or 0)
    except Exception as e:
        print(f'[DOWNLOAD] Could not read back reserved slot position for {file_id}: {e}')
    return {'file_id': file_id, 'count': reserved_count}

def check_and_increment_download(file):
    """
    Atomically reserve a download slot by incrementing count.
    Returns (success, error_message) tuple.
    - If successful, returns (True, None)
    - If limit reached, returns (False, 'limit_reached')
    Streaming routes must call finalize_reserved_download() when the response closes.
    Callers that may need to RELEASE the slot again should use
    check_and_reserve_download() instead and keep the reservation token.
    """
    success, error, _reservation = check_and_reserve_download(file)
    return success, error

def rollback_reserved_download(file_id, reservation=None):
    """Release a reserved download slot THIS REQUEST holds.

    AUDIT FIX H3: use this ONLY for pre-delivery failures where NOTHING was
    streamed to the client (e.g. a file that could not be decrypted/added to a
    ZIP, or an error while building the response before any bytes were sent).
    It rolls the reserved count back so a server-side exclusion never consumes a
    limited/one-time link. Do NOT use it for a client-controlled mid-stream abort
    -- that path must consume the slot (see finalize_reserved_download).

    AUDIT FIX D8: the decrement used to be unconditional (`count > 0`), with no
    proof that this request owned a slot at all. During a ZIP build a failed
    member could therefore release a slot belonging to a CONCURRENT direct
    download, letting a max_downloads=1 burn-after-reading link be consumed
    twice. The caller must now present the reservation token returned by
    check_and_reserve_download(), and the decrement only applies while the
    counter is still at or above the position that reservation took."""
    if not reservation or reservation.get('file_id') != file_id:
        print(f'[WARNING] Refusing to release a download slot for {file_id} without a matching reservation token')
        return
    # AUDIT FIX (finding 2): a reservation with NO recorded slot position
    # (count=None/0 -- the read-back in _build_download_reservation failed)
    # cannot prove WHICH slot this request owns, so the positional guard below
    # would be skipped and the decrement could undo a CONCURRENT request's
    # slot (letting a max_downloads=1 link be consumed twice). Fail closed:
    # an unprovable slot stays consumed.
    try:
        reserved_count = int(reservation.get('count'))
    except (TypeError, ValueError):
        reserved_count = None
    if reserved_count is None or reserved_count < 1:
        print(f'[WARNING] Reservation token for {file_id} carries no usable slot position '
              f'(count={reservation.get("count")!r}); refusing to release a slot this request cannot prove it owns')
        return
    try:
        query = db.session.query(File).filter(
            File.id == file_id,
            db.func.coalesce(File.download_count, 0) > 0,
            db.func.coalesce(File.download_count, 0) >= reserved_count,
        )
        result = query.update(
            {"download_count": db.func.coalesce(File.download_count, 0) - 1},
            synchronize_session=False
        )
        if result:
            db.session.commit()
            print(f'[DOWNLOAD] Released reserved (undelivered) download slot for {file_id}')
        else:
            # No commit and no rollback: the conditional UPDATE matched nothing,
            # so there is nothing to persist and no caller state to discard.
            print(f'[DOWNLOAD] Reserved slot for {file_id} was already consumed or superseded; leaving the counter alone')
    except Exception as e:
        db.session.rollback()
        print(f'[DOWNLOAD] Failed to roll back reserved download for {file_id}: {e}')

def finalize_reserved_download(file_id, completed):
    """Finalize a download slot reserved by check_and_increment_download when a
    streaming response closes.

    AUDIT FIX H3: for files WITH a max_downloads limit (view-once / burn-after-N)
    a reserved slot is treated as CONSUMED even if the client aborts the stream.
    Previously ANY incomplete stream rolled the counter back, so an attacker
    could pull almost the entire payload and then drop the connection before the
    final chunk to avoid consuming the slot -- the limited/one-time link then
    stayed live indefinitely. Now a limited link burns on first delivery attempt.
    Only UNLIMITED files (no max_downloads, where the counter is a pure download
    statistic) still roll back an incomplete stream for count honesty.

    Pre-delivery/server-side exclusions must use rollback_reserved_download()
    instead so they never consume a limited link."""
    try:
        file = db.session.get(File, file_id)
        if not file:
            return
        if file.max_downloads:
            # Limited link: the slot is consumed on reservation regardless of
            # whether the client fully drained the stream. Burn the file once the
            # reserved count has reached the cap.
            # M7 FIX: the burn only MARKS the row (pending_delete_at) so an
            # in-flight stream holding an earlier slot can finish; the actual
            # row+payload delete is deferred to cleanup_expired_files().
            if (file.download_count or 0) >= file.max_downloads:
                _mark_file_for_download_limit_delete(file)
            return
        # Unlimited file: download_count is a statistic only -> roll back an
        # incomplete stream so the count reflects completed downloads.
        if not completed:
            result = db.session.query(File).filter(
                File.id == file_id,
                db.func.coalesce(File.download_count, 0) > 0
            ).update(
                {"download_count": db.func.coalesce(File.download_count, 0) - 1},
                synchronize_session=False
            )
            if result:
                db.session.commit()
                print(f'[DOWNLOAD] Rolled back incomplete download count for {file_id}')
    except Exception as e:
        db.session.rollback()
        print(f'[DOWNLOAD] Failed to finalize reserved download for {file_id}: {e}')

def increment_folder_download_counts(root_folder_id):
    """
    Increment download_count for a folder and all its non-trashed sub-folders.
    Uses BFS to collect all folder IDs in the tree, then a single bulk UPDATE.
    File download_counts are NOT touched -- those are handled by individual file download routes.
    """
    try:
        # AUDIT FIX D3: visited set + size bound. Without them a parent_id cycle
        # turned this into an unbounded DB-query loop.
        folder_ids = []
        visited = set()
        queue = [root_folder_id]
        while queue:
            parent_id = queue.pop(0)
            if parent_id in visited:
                continue
            visited.add(parent_id)
            folder_ids.append(parent_id)
            if len(visited) > _MAX_FOLDER_TREE_NODES:
                print(f'[WARNING] Folder download-count walk from {root_folder_id} exceeded {_MAX_FOLDER_TREE_NODES} folders; truncating')
                break
            sub_ids = [f.id for f in Folder.query.filter_by(parent_id=parent_id, is_trashed=False).with_entities(Folder.id).all()]
            queue.extend(sub_ids)

        Folder.query.filter(Folder.id.in_(folder_ids)).update(
            {Folder.download_count: db.func.coalesce(Folder.download_count, 0) + 1},
            synchronize_session=False
        )
        db.session.commit()
        print(f'[FOLDER DOWNLOAD] Incremented download count for {len(folder_ids)} folder(s) (root: {root_folder_id})')
    except Exception as e:
        db.session.rollback()
        print(f'[FOLDER DOWNLOAD] Warning: Failed to increment folder download counts: {e}')

def check_storage():
    try:
        stat = os.statvfs(basedir)
        total = stat.f_frsize * stat.f_blocks
        used = stat.f_frsize * (stat.f_blocks - stat.f_bavail)
        percent = (used / total) * 100
        print(f'[STORAGE] Disk usage: {percent:.1f}% ({used / (1024**3):.2f} GB / {total / (1024**3):.2f} GB)')
    except Exception as e:
        print(f'[STORAGE] Failed to check storage: {e}')
