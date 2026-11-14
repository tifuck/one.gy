# Desktop sync change feed: per-user sync_seq allocation and tombstones (desktop/docs/sync-api.md).
#
# Every sync-relevant File/Folder change gets the next user-wide sequence number,
# stamped on the row's change_seq. A hard delete leaves a SyncTombstone carrying
# the sequence. The allocation UPDATE takes the user's row lock and holds it to
# commit, so concurrent writers of one user commit in sequence order and a reader
# can never see seq N+1 before N.
#
# ORM writes are covered by the before_flush listener below. Bulk
# query.update()/delete() and raw SQL bypass ORM events, so those call sites call
# _bump_sync_seq_bulk() themselves (tests/test_audit_sync_feed.py enforces it).

# Attributes that appear in a sync node (or decide whether the row is one).
_SYNC_FILE_FIELDS = frozenset({
    'registered_user_id', 'is_temp_upload', 'folder_id', 'orig_name', 'filename',
    'encrypted_name', 'name_nonce', 'stored_extension', 'encrypted_file_key',
    'file_key_nonce', 'payload_checksum', 'size', 'disk_size', 'content_version',
    'encrypted_meta', 'meta_nonce', 'is_trashed', 'trashed_by_device_id',
    'tree_file_key_wrap', 'tree_file_key_nonce', 'tree_key_folder_id',
})
_SYNC_FOLDER_FIELDS = frozenset({
    'user_id', 'parent_id', 'name', 'is_e2e', 'encrypted_name', 'name_nonce',
    'encrypted_name_key', 'name_key_nonce', 'is_trashed', 'is_backup', 'backup_device_id',
    'tree_key_wrap', 'tree_key_nonce', 'tree_key_parent_id', 'tree_name_key_wrap', 'tree_name_key_nonce',
})


def _tree_wraps_drop_stale(session):
    """A key-tree wrap of a file key or folder name key that just changed (website
    edit, version restore, encryption change) wraps the old key: drop it, unless
    the same change wrote a new one. Desktop clients rebuild it."""
    for obj in session.dirty:
        if isinstance(obj, File):
            key, wrap = 'encrypted_file_key', ('tree_file_key_wrap', 'tree_file_key_nonce', 'tree_key_folder_id')
        elif isinstance(obj, Folder):
            key, wrap = 'encrypted_name_key', ('tree_name_key_wrap', 'tree_name_key_nonce')
        else:
            continue
        state = inspect(obj)
        if state.attrs[key].history.has_changes() and not state.attrs[wrap[0]].history.has_changes():
            for name in wrap:
                setattr(obj, name, None)


def _sync_file_owner(file):
    """Owner id when the file is a synced drive file, else None (guest/temp)."""
    if file.registered_user_id and file.is_temp_upload is False:
        return file.registered_user_id
    return None


def _sync_changed_fields(state, fields):
    """True when a loaded row has a net change in one of fields. committed_state
    narrows the check to attributes that were actually assigned."""
    candidates = fields.intersection(state.committed_state)
    return any(state.attrs[name].history.has_changes() for name in candidates)


def _sync_previous_value(state, name):
    deleted = state.attrs[name].history.deleted
    return deleted[0] if deleted else getattr(state.obj(), name)


def _allocate_sync_seq(session, user_id):
    """Next sequence for user_id on session's transaction. The UPDATE row lock is
    held until commit, which serializes this user's writers in seq order."""
    table = User.__table__
    conn = session.connection()
    conn.execute(table.update().where(table.c.id == user_id).values(sync_seq=table.c.sync_seq + 1))
    return int(conn.execute(db.select(table.c.sync_seq).where(table.c.id == user_id)).scalar() or 0)


def _sync_collect(session):
    """Return ({user_id: [rows to stamp]}, {user_id: [(type, id)]}) for this flush."""
    stamps = {}
    tombstones = {}
    for obj in session.new:
        if isinstance(obj, File):
            owner = _sync_file_owner(obj)
        elif isinstance(obj, Folder):
            owner = obj.user_id
        else:
            continue
        if owner:
            stamps.setdefault(owner, []).append(obj)
    for obj in session.dirty:
        if isinstance(obj, File):
            fields, kind = _SYNC_FILE_FIELDS, 'file'
        elif isinstance(obj, Folder):
            fields, kind = _SYNC_FOLDER_FIELDS, 'folder'
        else:
            continue
        state = inspect(obj)
        if state.deleted or not _sync_changed_fields(state, fields):
            continue
        if kind == 'file':
            owner = _sync_file_owner(obj)
            old_owner = _sync_previous_value(state, 'registered_user_id')
            old_temp = _sync_previous_value(state, 'is_temp_upload')
            if old_owner and old_owner != owner and old_temp is False:
                tombstones.setdefault(old_owner, []).append(('file', obj.id))
        else:
            owner = obj.user_id
        if owner:
            stamps.setdefault(owner, []).append(obj)
    for obj in session.deleted:
        if isinstance(obj, File):
            owner, kind = _sync_file_owner(obj), 'file'
        elif isinstance(obj, Folder):
            owner, kind = obj.user_id, 'folder'
        else:
            continue
        if owner:
            tombstones.setdefault(owner, []).append((kind, str(obj.id)))
    # A user deleted in this same flush takes its feed with it.
    for obj in session.deleted:
        if isinstance(obj, User):
            stamps.pop(obj.id, None)
            tombstones.pop(obj.id, None)
    return stamps, tombstones


@event.listens_for(db.session, 'before_flush')
def _sync_feed_before_flush(session, flush_context, instances):
    # Runs on every flush: bail out before any work unless a File/Folder is pending.
    if session.info.get('_sync_feed_busy'):
        return
    if not any(isinstance(obj, (File, Folder))
               for group in (session.new, session.dirty, session.deleted) for obj in group):
        return
    _tree_wraps_drop_stale(session)
    _retire_file_ids(session, [obj.id for obj in session.deleted if isinstance(obj, File)])
    stamps, tombstones = _sync_collect(session)
    if not stamps and not tombstones:
        return
    session.info['_sync_feed_busy'] = True
    try:
        # Sorted so two multi-user flushes always lock user rows in the same order.
        for user_id in sorted(set(stamps) | set(tombstones)):
            seq = _allocate_sync_seq(session, user_id)
            for obj in stamps.get(user_id, ()):
                obj.change_seq = seq
            for kind, object_id in tombstones.get(user_id, ()):
                session.add(SyncTombstone(user_id=user_id, object_type=kind,
                                          object_id=object_id, change_seq=seq))
    finally:
        session.info.pop('_sync_feed_busy', None)


def _retire_file_ids(session, ids):
    """Record hard-deleted File ids (RetiredFileId) in session's transaction so
    the id is never handed out again (376 _sync_check_target). Covers every File
    hard delete: ORM deletes via the flush listener, bulk/raw ones via
    _bump_sync_seq_bulk(deleted=True)."""
    ids = {str(i) for i in ids if i}
    if not ids:
        return
    ids -= {row[0] for row in session.query(RetiredFileId.id).filter(RetiredFileId.id.in_(ids))}
    session.add_all([RetiredFileId(id=i) for i in sorted(ids)])


def _bump_sync_seq_bulk(user_id, model, ids, deleted=False):
    """Seq bump for bulk query.update()/delete() or raw SQL on File/Folder, which
    bypass the flush listener. Call it in the same transaction as the write.

    deleted=True records tombstones for ids (rows already gone; caller checks
    they were synced rows). Otherwise every listed row owned by user_id (synced
    drive files only) is stamped; user_id=None stamps each row under its own
    owner. Returns the last allocated seq or None."""
    ids = list({i for i in (ids or []) if i is not None})
    if not ids:
        return None
    kind = 'file' if model is File else 'folder'
    if deleted:
        if model is File:
            _retire_file_ids(db.session, ids)
        if not user_id:
            return None
        seq = _allocate_sync_seq(db.session, user_id)
        db.session.add_all([SyncTombstone(user_id=user_id, object_type=kind,
                                          object_id=str(i), change_seq=seq) for i in ids])
        return seq
    table = model.__table__
    owner_col = table.c.registered_user_id if model is File else table.c.user_id
    scope = [table.c.id.in_(ids)]
    if model is File:
        scope.append(table.c.is_temp_upload == False)
    conn = db.session.connection()
    if user_id:
        owners = [user_id]
    else:
        owners = sorted(row[0] for row in conn.execute(
            db.select(owner_col).where(*scope, owner_col.isnot(None)).distinct()))
    seq = None
    for owner in owners:
        seq = _allocate_sync_seq(db.session, owner)
        conn.execute(table.update().where(*scope, owner_col == owner).values(change_seq=seq))
    return seq


def _prune_sync_tombstones():
    """Drop tombstones older than sync_tombstone_retention_days and raise each
    affected user's sync_min_seq, so older cursors get 410 cursor_expired.
    Called from cleanup_job."""
    days = max(1, get_numeric_setting('sync_tombstone_retention_days'))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    try:
        expired = db.session.query(
            SyncTombstone.user_id, db.func.max(SyncTombstone.change_seq)
        ).filter(SyncTombstone.created_at < cutoff).group_by(SyncTombstone.user_id).all()
        if not expired:
            return 0
        table = User.__table__
        for user_id, max_seq in expired:
            db.session.execute(table.update().where(
                table.c.id == user_id, table.c.sync_min_seq < max_seq
            ).values(sync_min_seq=max_seq))
        removed = SyncTombstone.query.filter(SyncTombstone.created_at < cutoff).delete(synchronize_session=False)
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f'[SYNC] Tombstone prune failed: {e}')
        return 0
    print(f'[SYNC] Pruned {removed} sync tombstone(s) older than {days} day(s)')
    return removed
