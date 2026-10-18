# AUDIT FIX A4: the 5-minute cleanup job used to materialise WHOLE TABLES as ORM
# instances -- every file that has ever had an expiry, every trashed file, every
# folder with an expiry -- and then compare timestamps in Python, even though
# File.expires_at / Folder.expires_at are indexed. The comparisons are now
# pushed into SQL, the dead LargeBinary thumbnail columns are deferred (they are
# never read here), and each phase is capped so a large backlog is drained over
# consecutive ticks instead of loaded in one allocation.
CLEANUP_DELETE_BATCH_SIZE = 500

# M7 FIX: how long a burned (max_downloads reached) file lingers after it is
# marked pending_delete_at before cleanup_expired_files() hard-deletes the
# row and payload. The grace exists purely so streams that legitimately
# reserved a slot BEFORE the cap was hit can finish draining; the marker
# already stops all NEW download attempts immediately. Sized to exceed the
# longest stream a worker can legally keep open -- gunicorn.conf.py uses
# timeout=7200s (it kills any longer request itself) plus
# graceful_timeout=300s -- so no stream that WOULD have finished can ever be
# truncated by the deferred delete. If the gunicorn timeout is raised,
# raise this with it.
DOWNLOAD_LIMIT_DELETE_GRACE = timedelta(seconds=7200 + 300 + 300)


def _file_query_without_blobs():
    """File query with the legacy LargeBinary thumbnail columns deferred.

    Those columns are dead (thumbnails live on disk) but SQLAlchemy still SELECTs
    them for a plain File.query, pulling megabytes per row over the wire for
    callers that only need id/filename/timestamps."""
    return File.query.options(
        db.defer(File.thumbnail_data),
        db.defer(File.encrypted_thumbnail_data),
    )


def _take_capped_batch(rows, label):
    """Trim a (cap + 1)-sized result to the cap and log when more work remains."""
    if len(rows) > CLEANUP_DELETE_BATCH_SIZE:
        print(f'[CLEANUP] {label}: more than {CLEANUP_DELETE_BATCH_SIZE} item(s) pending; '
              f'processing the first batch and resuming on the next tick')
        return rows[:CLEANUP_DELETE_BATCH_SIZE]
    return rows


def cleanup_expired_files():
    now = datetime.now(timezone.utc)
    # Expiry comparison happens in SQL against the indexed expires_at column.
    # DB values are naive UTC and `now` is aware UTC; the driver formats only the
    # naive components, so this matches the old get_expires_at_aware() semantics.
    expired = _take_capped_batch(
        _file_query_without_blobs().filter(
            File.expires_at.isnot(None),
            File.expires_at < now
        ).order_by(File.expires_at.asc()).limit(CLEANUP_DELETE_BATCH_SIZE + 1).all(),
        'expired files'
    )

    count = 0
    for candidate in expired:
        candidate_id = candidate.id
        candidate_was_trashed = bool(candidate.is_trashed)
        lifecycle_lock = _acquire_file_lifecycle_lock(candidate)
        item_targets = []
        try:
            db.session.rollback()
            file = _file_query_without_blobs().filter(
                File.id == candidate_id,
                File.expires_at.isnot(None),
                File.expires_at < now,
                File.is_trashed == candidate_was_trashed,
            ).first()
            if not file:
                continue
            item_targets = storage.stage_payload_deletes(_file_payload_delete_keys(file))
            print(f'[CLEANUP] Expired file queued for deletion: {file.orig_name} (ID: {file.id})')
            db.session.delete(file)
            db.session.commit()
            count += 1
        finally:
            _release_lifecycle_lock(lifecycle_lock)
        storage.purge_staged_locals(item_targets)

    if count > 0:
        print(f'[CLEANUP] Cleaned up {count} expired files')

    # M7 FIX: hard-delete files burned at their download limit whose grace
    # window has elapsed. The burn itself (see
    # _mark_file_for_download_limit_delete) only stamps pending_delete_at so
    # an in-flight stream holding an earlier slot can finish; THIS is where
    # the actual row+payload deletion happens, so burn-after-N semantics
    # still hold, just delayed. Same capped-batch + lifecycle-lock + atomic
    # staging pattern as the expired-file branch above.
    burned = _take_capped_batch(
        _file_query_without_blobs().filter(
            File.pending_delete_at.isnot(None),
            File.pending_delete_at < now - DOWNLOAD_LIMIT_DELETE_GRACE
        ).order_by(File.pending_delete_at.asc()).limit(CLEANUP_DELETE_BATCH_SIZE + 1).all(),
        'download-limit burned files'
    )

    burned_count = 0
    for candidate in burned:
        candidate_id = candidate.id
        lifecycle_lock = _acquire_file_lifecycle_lock(candidate)
        item_targets = []
        try:
            db.session.rollback()
            file = _file_query_without_blobs().filter(
                File.id == candidate_id,
                File.pending_delete_at.isnot(None),
                File.pending_delete_at < now - DOWNLOAD_LIMIT_DELETE_GRACE,
            ).first()
            if not file:
                continue
            item_targets = storage.stage_payload_deletes(_file_payload_delete_keys(file))
            print(f'[CLEANUP] Download-limit burned file deleting: {file.orig_name} (ID: {file.id})')
            db.session.delete(file)
            db.session.commit()
            burned_count += 1
        finally:
            _release_lifecycle_lock(lifecycle_lock)
        storage.purge_staged_locals(item_targets)

    if burned_count > 0:
        print(f'[CLEANUP] Cleaned up {burned_count} download-limit burned files')
    
    # Trash expired folders (set is_trashed, disable sharing)
    # Also recursively trash all files and subfolders within, and set parent_id=None
    # so the folder is found by the auto-purge query (which filters parent_id IS NULL)
    expired_folders = _take_capped_batch(
        Folder.query.filter(
            Folder.expires_at.isnot(None),
            Folder.is_trashed == False,
            Folder.expires_at < now
        ).order_by(Folder.expires_at.asc()).limit(CLEANUP_DELETE_BATCH_SIZE + 1).all(),
        'expired folders'
    )
    folder_count = 0
    for candidate in expired_folders:
        lifecycle_lock = _acquire_user_lifecycle_lock(candidate.user_id)
        try:
            db.session.rollback()
            folder = Folder.query.filter(
                Folder.id == candidate.id,
                Folder.expires_at.isnot(None),
                Folder.is_trashed == False,
                Folder.expires_at < now,
            ).first()
            if not folder:
                continue
            trash_folder_recursive(folder.id, trashed_at=now)
            folder.original_parent_id = folder.parent_id
            folder.parent_id = None
            folder.is_public = False
            folder.is_browsable = False
            print(f'[CLEANUP] Trashed expired folder: {_log_safe(folder.name)} (ID: {folder.id})')
            db.session.commit()
            folder_count += 1
        finally:
            _release_lifecycle_lock(lifecycle_lock)

    if folder_count > 0:
        print(f'[CLEANUP] Trashed {folder_count} expired folders')
    
    # Auto-purge trash items past the configured retention window.
    # AUDIT FIX D5: the window is an AppSetting (default 48h) instead of a magic
    # constant, and EVERY item is now measured against its OWN trashed_at --
    # previously the folder branch destroyed every descendant file using only the
    # ROOT folder's timer, so a file trashed an hour ago inside a folder trashed
    # 49 hours ago lost 47 hours of its retention.
    retention_hours = get_trash_retention_hours()
    trash_cutoff = now - timedelta(hours=retention_hours)
    
    # Purge trashed folders whose own retention window has elapsed.
    # AUDIT FIX A4: the retention comparison is in SQL, not a Python scan of
    # every trashed folder.
    trashed_folders = _take_capped_batch(
        Folder.query.filter(
            Folder.is_trashed == True,
            Folder.trashed_at.isnot(None),
            Folder.parent_id.is_(None),
            Folder.trashed_at < trash_cutoff
        ).order_by(Folder.trashed_at.asc()).limit(CLEANUP_DELETE_BATCH_SIZE + 1).all(),
        'trashed folders past retention'
    )
    trash_folder_count = 0
    for candidate in trashed_folders:
        lifecycle_lock = _acquire_user_lifecycle_lock(candidate.user_id)
        folder_local_targets = []
        try:
            db.session.rollback()
            folder = Folder.query.filter(
                Folder.id == candidate.id,
                Folder.is_trashed == True,
                Folder.trashed_at.isnot(None),
                Folder.parent_id.is_(None),
                Folder.trashed_at < trash_cutoff,
            ).first()
            if not folder:
                continue
            folder_paths_to_delete = permanently_delete_folder_recursive(
                folder.id, retention_cutoff=trash_cutoff)
            folder_local_targets = storage.stage_payload_deletes(folder_paths_to_delete)
            db.session.commit()
            trash_folder_count += 1
        finally:
            _release_lifecycle_lock(lifecycle_lock)
        storage.purge_staged_locals(folder_local_targets)

    if trash_folder_count > 0:
        print(f'[CLEANUP] Purged {trash_folder_count} folders from trash (older than {retention_hours} hours)')
    
    # Purge trashed files whose own retention window has elapsed.
    # AUDIT FIX A4: SQL-side retention filter + deferred blob columns instead of
    # materialising every trashed file row.
    trashed_files = _take_capped_batch(
        _file_query_without_blobs().filter(
            File.is_trashed == True,
            File.trashed_at.isnot(None),
            File.trashed_at < trash_cutoff
        ).order_by(File.trashed_at.asc()).limit(CLEANUP_DELETE_BATCH_SIZE + 1).all(),
        'trashed files past retention'
    )
    trash_count = 0
    for candidate in trashed_files:
        lifecycle_lock = _acquire_file_lifecycle_lock(candidate)
        trash_local_targets = []
        try:
            db.session.rollback()
            file = _file_query_without_blobs().filter(
                File.id == candidate.id,
                File.is_trashed == True,
                File.trashed_at.isnot(None),
                File.trashed_at < trash_cutoff,
            ).first()
            if not file:
                continue
            trash_local_targets = storage.stage_payload_deletes(_file_payload_delete_keys(file))
            db.session.delete(file)
            db.session.commit()
            trash_count += 1
        finally:
            _release_lifecycle_lock(lifecycle_lock)
        storage.purge_staged_locals(trash_local_targets)

    if trash_count > 0:
        print(f'[CLEANUP] Purged {trash_count} files from trash (older than {retention_hours} hours)')

# AUDIT FIX A8: advisory lock files are per-file-id / per-upload-id / per-scope
# and were only ever close()d, never unlinked. Reap ones that are provably
# unheld AND untouched for a long time. A lock file is cheap to recreate, and
# _open_flock_exclusive() makes the acquire path safe against a concurrent reap.
_LOCK_FILE_REAP_AGE_SECONDS = 24 * 3600
_LOCK_FILE_REAP_MAX_PER_PASS = 2000


def cleanup_stale_lock_files():
    """Remove idle advisory lock files from instance/locks."""
    lock_dir = os.path.join(app.instance_path, 'locks')
    if not os.path.isdir(lock_dir):
        return 0
    now = time.time()
    reaped = 0
    try:
        entries = list(os.scandir(lock_dir))
    except Exception as e:
        print(f'[CLEANUP] Could not scan the advisory lock directory: {e}')
        return 0
    for entry in entries:
        if reaped >= _LOCK_FILE_REAP_MAX_PER_PASS:
            break
        try:
            if not entry.name.endswith('.lock') or not entry.is_file(follow_symlinks=False):
                continue
            stat_result = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        if (now - max(stat_result.st_mtime, stat_result.st_atime)) < _LOCK_FILE_REAP_AGE_SECONDS:
            continue
        try:
            probe = open(entry.path, 'a+')
        except OSError:
            continue
        locked = False
        try:
            try:
                fcntl.flock(probe.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except OSError:
                # Someone holds it right now -- never touch a live lock.
                continue
            # Re-verify under the lock: same inode, still idle.
            try:
                current = os.stat(entry.path)
            except OSError:
                continue
            if current.st_ino != os.fstat(probe.fileno()).st_ino:
                continue
            if (now - max(current.st_mtime, current.st_atime)) < _LOCK_FILE_REAP_AGE_SECONDS:
                continue
            os.unlink(entry.path)
            reaped += 1
        except OSError:
            continue
        finally:
            if locked:
                try:
                    fcntl.flock(probe.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
            try:
                probe.close()
            except OSError:
                pass
    if reaped > 0:
        print(f'[CLEANUP] Reaped {reaped} idle advisory lock file(s) from instance/locks')
    return reaped


def cleanup_stale_security_state():
    """Remove expired anti-abuse/replay files without racing live mutations."""
    state_dir = os.path.join(app.instance_path, 'security_state')
    if not os.path.isdir(state_dir):
        return 0
    now = time.time()
    removed = 0
    try:
        entries = list(os.scandir(state_dir))
    except OSError as e:
        print(f'[CLEANUP] Could not scan security state: {e}')
        return 0
    for entry in entries:
        if removed >= _SECURITY_STATE_CLEANUP_MAX_PER_PASS:
            break
        if entry.name.startswith('.security-'):
            try:
                if now - entry.stat(follow_symlinks=False).st_mtime > 3600:
                    os.unlink(entry.path)
                    removed += 1
            except OSError:
                pass
            continue
        match = re.fullmatch(r'([a-z0-9_]+)--([0-9a-f]{64})\.json', entry.name)
        if not match or not entry.is_file(follow_symlinks=False):
            continue
        namespace, digest = match.groups()
        lock_file = _acquire_scoped_lock(f'{namespace}:{digest}', prefix='security')
        try:
            state = _read_security_state_path(entry.path)
            if _security_state_fresh(state, now):
                continue
            try:
                os.unlink(entry.path)
                removed += 1
            except FileNotFoundError:
                pass
        except RuntimeError as e:
            # Corrupt state fails closed on request paths. Do not erase it and
            # accidentally make a consumed nonce or ticket reusable.
            print(f'[CLEANUP] Retaining unreadable security state: {e}')
        finally:
            _release_scoped_lock(lock_file)
    if removed:
        print(f'[CLEANUP] Removed {removed} expired security state file(s)')
    return removed


# AUDIT FIX A9: NotificationDismissal grew without bound. A visitor_id-keyed row
# is created for every anonymous session that dismisses a banner and was ONLY
# ever deleted by account deletion -- which by definition never matches an
# anonymous row. The table is read on every page render.
NOTIFICATION_DISMISSAL_VISITOR_RETENTION_DAYS = 90
NOTIFICATION_DISMISSAL_EXPIRED_GRACE_DAYS = 7


def cleanup_stale_notification_dismissals():
    """Drop dismissal rows that can never affect what a visitor sees again."""
    now = datetime.now(timezone.utc)
    removed = 0
    try:
        # Rows whose notification is gone (the FK cascade should prevent this,
        # but a legacy row or a manual delete can leave one behind).
        orphaned = NotificationDismissal.query.filter(
            ~NotificationDismissal.notification_id.in_(db.session.query(Notification.id))
        ).delete(synchronize_session=False)
        removed += int(orphaned or 0)

        # Rows for notifications that expired long enough ago that the banner can
        # never be shown again.
        expired_cutoff = now - timedelta(days=NOTIFICATION_DISMISSAL_EXPIRED_GRACE_DAYS)
        expired_notif_ids = db.session.query(Notification.id).filter(
            Notification.expires_at.isnot(None),
            Notification.expires_at < expired_cutoff
        )
        expired_rows = NotificationDismissal.query.filter(
            NotificationDismissal.notification_id.in_(expired_notif_ids)
        ).delete(synchronize_session=False)
        removed += int(expired_rows or 0)

        # Anonymous (visitor-keyed) rows past the retention window: the guest
        # session that created them is long gone.
        visitor_cutoff = now - timedelta(days=NOTIFICATION_DISMISSAL_VISITOR_RETENTION_DAYS)
        visitor_rows = NotificationDismissal.query.filter(
            NotificationDismissal.user_id.is_(None),
            NotificationDismissal.visitor_id.isnot(None),
            NotificationDismissal.dismissed_at.isnot(None),
            NotificationDismissal.dismissed_at < visitor_cutoff
        ).delete(synchronize_session=False)
        removed += int(visitor_rows or 0)

        db.session.commit()
    except Exception as e:
        try:
            db.session.rollback()
        except Exception:
            pass
        print(f'[CLEANUP] Notification dismissal cleanup failed: {e}')
        return 0
    if removed > 0:
        print(f'[CLEANUP] Removed {removed} stale notification dismissal row(s)')
    return removed


def _payload_age_seconds(mtime):
    """Return the age in seconds of a storage payload, or None when unknown.

    AUDIT FIX D1: storage.get_*_mtime() now returns None when the modification
    time cannot be read. Callers MUST treat None as 'do not delete' -- an
    unreadable mtime means we cannot prove the object is not a write that is
    still in flight, and deleting it queues PendingRemoteDelete tombstones that
    destroy the payload on EVERY mirror."""
    if mtime is None:
        return None
    try:
        mtime = float(mtime)
    except (TypeError, ValueError):
        return None
    # A non-positive mtime is not a real timestamp (it would yield a ~54-year
    # "age" and defeat every young-orphan guard). Treat it as unknown.
    if mtime <= 0:
        return None
    return time.time() - mtime

def _refresh_db_read_snapshot():
    """Start a fresh read snapshot before an orphan re-check.

    AUDIT FIX D2: MariaDB defaults to REPEATABLE READ, so re-querying inside the
    long-running transaction that produced the original DB snapshot would return
    that same stale snapshot and the re-check would be worthless. The orphan
    scanners hold no pending writes at the point they re-check, so ending the
    read transaction here is safe."""
    try:
        db.session.rollback()
    except Exception as e:
        print(f'[CLEANUP] Could not refresh DB read snapshot: {e}')

def _file_filename_still_orphaned(filename):
    """Re-check that no File row references this stored filename."""
    _refresh_db_read_snapshot()
    return db.session.query(File.id).filter(File.filename == filename).first() is None

def _file_id_still_orphaned(file_id):
    """Re-check that no File row exists with this id (thumbnail owner check)."""
    _refresh_db_read_snapshot()
    return db.session.query(File.id).filter(File.id == file_id).first() is None

def _note_id_still_orphaned(note_id):
    """Re-check that no Note row exists with this id."""
    _refresh_db_read_snapshot()
    return db.session.query(Note.id).filter(Note.id == note_id).first() is None

def _path_held_open_by_any_process(path):
    """True when ANY process on this host still holds `path` open.

    AUDIT FIX (residual): the orphan reaper decided abandonment from age and a
    DB re-check alone. That is not enough for two cases:
      * a `.dec` plaintext temp file that a CLI/browser download has been
        streaming for longer than the 30-minute age guard -- unlinking it
        mid-stream truncates the response the recipient is still reading;
      * a payload that a live reader/writer opened in the window between the
        DB re-check and the delete.
    On Linux `/proc/<pid>/fd` answers it directly: scan every process's
    descriptors and compare (device, inode) with the target. A descriptor on
    the SAME inode means someone is still using it, so the caller defers the
    delete to the next scan (a truly leaked file has no descriptors and is
    reaped by the normal age guard). Returns False when the path is absent or
    `/proc` is unavailable, which preserves the previous age/DB-only
    behaviour on platforms that cannot answer the question."""
    try:
        target = os.stat(path)
    except OSError:
        return False
    try:
        pids = os.listdir('/proc')
    except OSError:
        return False
    for pid in pids:
        if not pid.isdigit():
            continue
        # Includes THIS process: with GUNICORN_WORKERS=1 the streaming thread
        # and the scheduler thread usually share a pid.
        fd_dir = f'/proc/{pid}/fd'
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd in fds:
            try:
                st = os.stat(os.path.join(fd_dir, fd))
            except OSError:
                continue
            if st.st_ino == target.st_ino and st.st_dev == target.st_dev:
                return True
    return False


def _local_payload_path(filename):
    """Best-effort local path for a storage key (download/dec temp files and
    local-mode payloads all live in UPLOAD_FOLDER). May not exist in remote
    modes -- callers treat 'absent' as 'cannot answer'."""
    return os.path.join(app.config['UPLOAD_FOLDER'], filename)


def cleanup_orphaned_files():
    # Only load needed columns (id, filename) -- avoids loading LargeBinary thumbnail data
    _file_rows = db.session.query(File.id, File.filename).all()
    db_filenames = {row[1] for row in _file_rows}
    
    count = 0
    
    try:
        for filename in storage.list_files():
            if filename not in db_filenames:
                # Skip .dec temp files used by in-progress large file downloads
                if filename.endswith('.dec'):
                    age = _payload_age_seconds(storage.get_file_mtime(filename))
                    if age is None or age < 1800:
                        continue
                    # AUDIT FIX (residual): age alone does not prove the .dec is
                    # dead -- a CLI download of a multi-GB plaintext can stream
                    # for far longer than 30 minutes while the age guard counts
                    # up. Any open descriptor on that inode means a live
                    # decrypt/stream still owns it; defer to the next scan.
                    if _path_held_open_by_any_process(_local_payload_path(filename)):
                        print(f'[CLEANUP] Skipping active .dec temp file {filename}: still open by a live transfer')
                        continue
                # Skip internal storage manager temp/cache/staged files
                if _is_internal_storage_artifact(filename):
                    continue
                # Skip .prep_state directory marker
                if filename == '.prep_state':
                    continue
                # Skip staged save artifacts. Startup recovery owns these files;
                # cleanup must not delete an old .new whose DB commit already landed.
                if filename.endswith('.new') or filename.endswith('.committed') or filename.endswith('.meta'):
                    continue
                # Skip young orphans: protects the window between store_file() and
                # db.session.commit() in the upload route, plus any other short-lived
                # write-then-commit flow. A legitimate orphan will still be reaped on
                # the next scan once it ages past the threshold.
                # AUDIT FIX D1: an UNKNOWN age (None) now fails CLOSED.
                age = _payload_age_seconds(storage.get_file_mtime(filename))
                if age is None:
                    print(f'[CLEANUP] [WARNING] Unknown mtime for {filename}; refusing to delete it as an orphan')
                    continue
                if age < 300:
                    continue
                # AUDIT FIX D2: db_filenames was snapshotted BEFORE the (possibly
                # multi-minute, paginated remote) storage listing above. A file
                # committed after that snapshot would look like an orphan here.
                # Re-check against a fresh snapshot immediately before deleting.
                if not _file_filename_still_orphaned(filename):
                    print(f'[CLEANUP] Skipping {filename}: a File row now references it (committed during the scan)')
                    continue
                # AUDIT FIX (residual delete race): even after the fresh DB
                # re-check, an in-flight reader/writer that opened the payload
                # a moment ago would have its file pulled out from under it.
                # 'Held open' is the liveness signal the re-check cannot give,
                # and taking it INSIDE the storage lock makes the probe and the
                # unlink one critical section against every in-process storage
                # writer that uses the same lock; cross-process writers are
                # covered by their own flock/atomic-replace.
                try:
                    with storage._state_lock:
                        if _path_held_open_by_any_process(_local_payload_path(filename)):
                            print(f'[CLEANUP] Skipping orphaned file {filename}: still open by a live reader/writer')
                            continue
                        deleted = storage.delete_file(filename)
                    if deleted:
                        print(f'[CLEANUP] Deleted orphaned file: {filename}')
                        count += 1
                    else:
                        print(f'[CLEANUP] Could not durably schedule deletion for orphaned file: {filename}')
                except Exception as e:
                    print(f'[CLEANUP] Failed to delete orphaned file {filename}: {e}')
    except Exception as e:
        print(f'[CLEANUP] Error listing files for orphan cleanup: {e}')
    
    if count > 0:
        print(f'[CLEANUP] Cleaned up {count} orphaned files')
    
    # Cleanup orphaned thumbnails
    db_file_ids = {row[0] for row in _file_rows}
    thumb_count = 0
    
    try:
        for filename in storage.list_thumbnails():
            file_id_part = filename.rsplit('.', 1)[0] if '.' in filename else filename
            if file_id_part not in db_file_ids:
                # AUDIT FIX D1: unknown mtime fails CLOSED (never delete).
                age = _payload_age_seconds(storage.get_thumbnail_mtime(filename))
                if age is None:
                    print(f'[CLEANUP] [WARNING] Unknown mtime for thumbnail {filename}; refusing to delete it as an orphan')
                    continue
                if age < 300:
                    continue
                # AUDIT FIX D2: re-check the DB right before deleting -- the id
                # set was snapshotted before the storage listing ran.
                if not _file_id_still_orphaned(file_id_part):
                    print(f'[CLEANUP] Skipping thumbnail {filename}: its File row now exists (committed during the scan)')
                    continue
                try:
                    with storage._state_lock:
                        deleted = storage._delete_thumbnail_by_basename(filename)
                    if deleted:
                        print(f'[CLEANUP] Deleted orphaned thumbnail: {filename}')
                        thumb_count += 1
                    else:
                        print(f'[CLEANUP] Could not durably schedule deletion for orphaned thumbnail: {filename}')
                except Exception as e:
                    print(f'[CLEANUP] Failed to delete orphaned thumbnail {filename}: {e}')
    except Exception as e:
        print(f'[CLEANUP] Error listing thumbnails for orphan cleanup: {e}')
    
    if thumb_count > 0:
        print(f'[CLEANUP] Cleaned up {thumb_count} orphaned thumbnails')
    
    # Detect reverse orphans: DB records whose local payload is missing.
    # Preserve metadata; the row may still be recoverable from a remote mirror,
    # and deleting metadata would make an otherwise valid remote payload unusable.
    disk_filenames = set()
    try:
        disk_filenames = set(storage.list_files())
    except Exception as e:
        print(f'[CLEANUP] Error listing files for reverse-orphan check: {e}')
    
    reverse_count = 0
    reverse_changed = False
    if disk_filenames:
        for file_id, filename in _file_rows:
            if filename not in disk_filenames:
                try:
                    file_record = db.session.get(File, file_id)
                    if not file_record:
                        continue
                    local_node_id = getattr(storage, '_local_node_id', None)
                    if local_node_id:
                        local_replica = FileReplica.query.filter_by(file_id=file_id, node_id=local_node_id).first()
                        if local_replica and local_replica.status != 'missing':
                            local_replica.status = 'missing'
                            local_replica.last_error = 'LOCAL PAYLOAD MISSING DURING CLEANUP; METADATA PRESERVED'
                            local_replica.verified_at = datetime.now(timezone.utc)
                            reverse_changed = True

                    # If a synced remote replica exists, the file is still valid;
                    # it is simply not present on the current local/cache node.
                    remote_query = FileReplica.query.filter_by(file_id=file_id, status='synced')
                    if local_node_id:
                        remote_query = remote_query.filter(FileReplica.node_id != local_node_id)
                    remote_synced = remote_query.first()
                    if remote_synced:
                        continue

                    reverse_count += 1
                    print(f'[CLEANUP] File metadata preserved but no local or synced remote payload was found: {file_id}')
                except Exception as e:
                    print(f'[CLEANUP] Error checking reverse-orphan DB record {file_id}: {e}')
        if reverse_changed:
            try:
                db.session.commit()
            except Exception as e:
                db.session.rollback()
                print(f'[CLEANUP] Failed to commit reverse-orphan file replica state: {e}')
        if reverse_count > 0:
            print(f'[CLEANUP] Preserved {reverse_count} file DB records with missing payloads for admin review')
    
    return count + thumb_count + reverse_count

def cleanup_orphaned_notes():
    """Remove note files from storage that have no matching DB record,
    and DB records whose note file is missing from disk."""
    # AUDIT FIX D2: snapshot the columns phase 2 needs as plain tuples. The
    # orphan re-check below ends the read transaction to get a fresh snapshot,
    # which expires every ORM instance; touching a since-deleted instance
    # afterwards would raise and abort the whole scan.
    _note_rows = db.session.query(Note.id, Note.content_version, Note.content_checksum).all()
    db_note_ids = {row[0] for row in _note_rows}
    count = 0
    
    # Phase 1: disk files with no DB record
    try:
        for filename in storage.list_notes():
            if filename not in db_note_ids:
                # Skip staged save artifacts. Startup recovery owns these files;
                # cleanup must not delete an old .new whose DB commit already landed.
                if filename.endswith('.new') or filename.endswith('.committed') or filename.endswith('.meta'):
                    continue
                # AUDIT FIX D1: unknown mtime fails CLOSED (never delete).
                age = _payload_age_seconds(storage.get_note_mtime(filename))
                if age is None:
                    print(f'[CLEANUP] [WARNING] Unknown mtime for note {filename}; refusing to delete it as an orphan')
                    continue
                if age < 300:
                    continue
                note_lock = _acquire_note_rewrite_lock(filename)
                try:
                    # The row can be published while the storage listing is in
                    # flight. Recheck under the same lock used by note saves.
                    if not _note_id_still_orphaned(filename):
                        print(f'[CLEANUP] Skipping note {filename}: its Note row now exists (committed during the scan)')
                        continue
                    with storage._state_lock:
                        deleted = storage.delete_note(filename)
                    if deleted:
                        print(f'[CLEANUP] Deleted orphaned note file: {filename}')
                        count += 1
                    else:
                        print(f'[CLEANUP] Could not durably schedule deletion for orphaned note: {filename}')
                except Exception as e:
                    print(f'[CLEANUP] Failed to delete orphaned note {filename}: {e}')
                finally:
                    _release_note_rewrite_lock(note_lock)
    except Exception as e:
        print(f'[CLEANUP] Error listing notes for orphan cleanup: {e}')
    if count > 0:
        print(f'[CLEANUP] Cleaned up {count} orphaned note files')
    
    # Phase 2: DB records with no local note file (reverse orphans)
    disk_note_ids = set()
    try:
        disk_note_ids = set(storage.list_notes())
    except Exception as e:
        print(f'[CLEANUP] Error listing notes for reverse-orphan check: {e}')
    
    reverse_count = 0
    reverse_changed = False
    if disk_note_ids:
        for note_id, note_content_version, note_content_checksum in _note_rows:
            if note_id not in disk_note_ids:
                try:
                    local_node_id = getattr(storage, '_local_node_id', None)
                    if local_node_id:
                        local_replica = NoteReplica.query.filter_by(note_id=note_id, node_id=local_node_id).first()
                        if local_replica and local_replica.status != 'missing':
                            local_replica.status = 'missing'
                            local_replica.last_error = 'LOCAL NOTE PAYLOAD MISSING DURING CLEANUP; METADATA PRESERVED'
                            local_replica.verified_at = datetime.now(timezone.utc)
                            reverse_changed = True

                    # If a current synced remote replica exists, the note is valid;
                    # it is simply not present on the current local/cache node.
                    note_version = int(note_content_version or 1)
                    remote_query = NoteReplica.query.filter_by(
                        note_id=note_id,
                        status='synced',
                        synced_version=note_version,
                    )
                    if note_content_checksum:
                        remote_query = remote_query.filter_by(checksum=note_content_checksum)
                    if local_node_id:
                        remote_query = remote_query.filter(NoteReplica.node_id != local_node_id)
                    remote_synced = remote_query.first()
                    if remote_synced:
                        continue

                    reverse_count += 1
                    print(f'[CLEANUP] Note metadata preserved but no local or current synced remote payload was found: {note_id}')
                except Exception as e:
                    print(f'[CLEANUP] Error checking reverse-orphan note {note_id}: {e}')
        if reverse_changed:
            try:
                db.session.commit()
            except Exception as e:
                db.session.rollback()
                print(f'[CLEANUP] Failed to commit reverse-orphan note replica state: {e}')
        if reverse_count > 0:
            print(f'[CLEANUP] Preserved {reverse_count} note DB records with missing payloads for admin review')
    
    return count + reverse_count

def cleanup_stale_music_sync():
    """Remove stale music sync state, mailbox records, and old devices."""
    now = datetime.now(timezone.utc)
    pruned_commands = _prune_music_sync_commands(now=now)
    if pruned_commands:
        db.session.commit()
        print(f'[CLEANUP] Removed {pruned_commands} old music sync commands')
    # Stale sync states (no push in 24 hours)
    stale_cutoff = now - timedelta(hours=24)
    stale_syncs = MusicSyncState.query.filter(MusicSyncState.updated_at < stale_cutoff).all()
    for s in stale_syncs:
        db.session.delete(s)
    if stale_syncs:
        db.session.commit()
        print(f'[CLEANUP] Removed {len(stale_syncs)} stale music sync states')
    # Old devices (not seen in 30 days)
    device_cutoff = now - timedelta(days=30)
    old_devices = MusicDevice.query.filter(MusicDevice.last_seen < device_cutoff).all()
    for d in old_devices:
        db.session.delete(d)
    if old_devices:
        db.session.commit()
        print(f'[CLEANUP] Removed {len(old_devices)} stale music devices')

