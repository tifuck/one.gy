# Cross-worker locks: flock files under the advisory lock dir plus MariaDB GET_LOCK for quota, rewrites, lifecycle, placement, thumbnails, upload idempotency, folder creation and admin reduction.

def _advisory_lock_dir():
    lock_dir = os.path.join(app.instance_path, 'locks')
    os.makedirs(lock_dir, exist_ok=True)
    return lock_dir


def _open_flock_exclusive(lock_path, blocking=True, timeout=None):
    """Open a lock file and take its exclusive flock, tolerating a concurrent reap.

    AUDIT FIX A8: advisory lock files accumulated forever (one per file id, per
    upload id, per scope) because nothing ever removed them -- instance/locks
    already held >2600 entries in DEV and grew with total lifetime uploads until
    inode exhaustion. cleanup_stale_lock_files() now reaps provably-idle ones,
    which introduces the classic unlink-under-flock hazard: if the reaper unlinks
    the file between our open() and our flock(), we would hold an exclusive lock
    on an unlinked inode while the next caller creates a FRESH file at the same
    path -- mutual exclusion silently lost. Re-check that the descriptor we
    locked is still the file at that path, and retry if it is not.

    AUDIT FIX: timeout (seconds) bounds the wait — polling LOCK_NB until the
    deadline, then returning None. Callers MUST treat None as "not acquired"
    and fail closed (e.g. 503), because a thread parked forever on LOCK_EX
    pins a gunicorn gthread for the holder's whole critical section (up to the
    2h worker timeout) — trivially triggerable thread exhaustion. timeout=None
    keeps the historical unbounded behaviour for callers whose critical
    sections are known-short."""
    if timeout is not None:
        deadline = time.monotonic() + max(0.0, float(timeout))
        while True:
            lock_file = open(lock_path, 'a+')
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                lock_file.close()
                if time.monotonic() >= deadline:
                    return None
                time.sleep(0.05)
                continue
            # Same unlink-under-flock re-check as the unbounded path below.
            try:
                if os.stat(lock_path).st_ino == os.fstat(lock_file.fileno()).st_ino:
                    return lock_file
            except OSError:
                pass
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                lock_file.close()
            except OSError:
                pass
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.05)
    for _ in range(5):
        lock_file = open(lock_path, 'a+')
        try:
            flags = fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
            fcntl.flock(lock_file.fileno(), flags)
        except BlockingIOError:
            lock_file.close()
            return None
        try:
            if os.stat(lock_path).st_ino == os.fstat(lock_file.fileno()).st_ino:
                return lock_file
        except OSError:
            pass
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            lock_file.close()
        except OSError:
            pass
    # Extremely unlikely; take the lock anyway rather than failing the request.
    lock_file = open(lock_path, 'a+')
    try:
        flags = fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
        fcntl.flock(lock_file.fileno(), flags)
    except BlockingIOError:
        lock_file.close()
        return None
    return lock_file


def _acquire_user_quota_lock(user_id, timeout=None):
    """Serialize quota-affecting mutations for one user across workers.

    timeout=None keeps the historical blocking behaviour; a bounded timeout
    returns None (NOT acquired) for callers that must fail closed instead of
    parking a worker thread."""
    if user_id is None:
        return None
    lock_path = os.path.join(_advisory_lock_dir(), f'quota_user_{int(user_id)}.lock')
    return _open_flock_exclusive(lock_path, timeout=timeout)

def _release_user_quota_lock(lock_file):
    if not lock_file:
        return
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        try:
            lock_file.close()
        except Exception:
            pass

def _refresh_quota_snapshot():
    """Start a NEW read transaction so a quota check performed under the quota
    lock cannot be answered from a snapshot opened BEFORE the lock was taken.

    AUDIT FIX (upload/download integrity): the per-user quota flock is now
    acquired LATE -- after the body transfer -- on /upload, make-public and
    make-private, so the exclusive lock is not held across the network transfer.
    MariaDB's default REPEATABLE READ isolation pins a transaction's snapshot at
    its FIRST read, and these requests read (session user, File rows, folder
    rows) long before the lock is taken. Without resetting the snapshot the
    has_storage_available() call under the lock would still see the pre-lock
    view and miss a concurrent commit -- precisely the race the lock exists to
    prevent. Callers MUST have no pending writes in the session when calling
    this; every call site sits before its first mutation."""
    try:
        db.session.rollback()
    except Exception as e:
        print(f'[WARNING] Could not refresh the quota read snapshot: {e}')
        raise RuntimeError('Could not refresh quota transaction snapshot') from e

def _acquire_file_rewrite_lock(file_id):
    """Serialize destructive rewrites of a SINGLE file across workers/threads.

    AUDIT FIX (5th audit, concurrent staged rewrites): the staged-replace
    helpers (store_file_staged / write_staged_file_metadata /
    mark_staged_file_committed / finalize_staged_file) all use the SAME sibling
    slot — '<filename>.new', '.committed', '.meta'. Multiple rewrite routes
    (make-public / make-private E2E conversions, save-content) reuse that one
    shared slot with no per-file lock, so two overlapping edits of the same file
    could overwrite each other's staged payload/metadata and finalize bytes that
    don't match the committed DB row. This exclusive flock (keyed by file id,
    held across stage -> commit -> finalize) makes same-file rewrites mutually
    exclusive while leaving different files fully concurrent."""
    if not file_id:
        return None
    safe_id = secure_filename(str(file_id)) or 'unknown'
    lock_path = os.path.join(_advisory_lock_dir(), f'rewrite_file_{safe_id}.lock')
    return _open_flock_exclusive(lock_path)

def _release_file_rewrite_lock(lock_file):
    if not lock_file:
        return
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        try:
            lock_file.close()
        except Exception:
            pass

def _acquire_note_rewrite_lock(note_id):
    """Serialize publication of one note generation across workers."""
    if not note_id:
        return None
    safe_id = secure_filename(str(note_id)) or 'unknown'
    lock_path = os.path.join(_advisory_lock_dir(), f'rewrite_note_{safe_id}.lock')
    return _open_flock_exclusive(lock_path)


def _release_note_rewrite_lock(lock_file):
    _release_file_rewrite_lock(lock_file)


def _acquire_user_lifecycle_lock(user_id):
    """Serialize one user's lifecycle and parent-placement finalizations.

    Canonical nested lock order is item rewrite -> quota -> lifecycle -> folder
    tree. The local-purge run lock is never nested with these locks; its per-item
    rewrite locks remain outermost. Batch/tree operations take one user lock,
    so they never acquire a client-ordered set of item locks.

    Keep this lock around the final eligibility recheck, metadata commit, and
    the local payload publication tied to them: upload takes it before the File
    INSERT can autoflush parent-folder row locks, so store_file (a local rename)
    and the E2E thumbnail write run inside it, as does regenerate-link's
    payload/thumbnail copy. Upload parsing, encryption, and post-commit local
    purge must happen outside it.
    """
    if user_id is None:
        return None
    return _acquire_scoped_lock(f'lifecycle_user_{int(user_id)}', prefix='lifecycle')


def _acquire_file_lifecycle_lock(file):
    """Use the owner scope for drive files and an item scope for guest files."""
    if not file:
        return None
    if file.registered_user_id is not None:
        return _acquire_user_lifecycle_lock(file.registered_user_id)
    return _acquire_scoped_lock(f'lifecycle_file_{file.id}', prefix='lifecycle')


def _release_lifecycle_lock(lock_file):
    _release_scoped_lock(lock_file)


def _lock_live_folder_for_placement(folder_id, user_id):
    """Return the current live parent under a DB row lock, or None.

    SELECT FOR UPDATE is a current read on MariaDB, avoiding an old REPEATABLE
    READ snapshot when upload/note payload work has already touched the session.
    The surrounding lifecycle lock prevents a trash commit after this check and
    before the child metadata commit.
    """
    if folder_id is None:
        return True
    return Folder.query.filter_by(
        id=folder_id, user_id=user_id, is_trashed=False
    ).populate_existing().with_for_update().first()


def _lock_live_notebook_for_placement(notebook_id, user_id):
    if notebook_id is None:
        return True
    return Notebook.query.filter_by(
        id=notebook_id, user_id=user_id, is_trashed=False
    ).populate_existing().with_for_update().first()


def _acquire_thumbnail_generation_lock(file_id, wait=True):
    """Serialize rendering of one thumbnail across workers and threads."""
    if not file_id:
        return None
    safe_id = secure_filename(str(file_id)) or 'unknown'
    lock_path = os.path.join(_advisory_lock_dir(), f'thumbnail_{safe_id}.lock')
    return _open_flock_exclusive(lock_path, blocking=wait)

def _release_thumbnail_generation_lock(lock_file):
    _release_file_rewrite_lock(lock_file)


def _acquire_thumbnail_publication_lock(file_id, thumb_type):
    """Serialize publication or purge of one thumbnail variant."""
    if not file_id:
        return None
    safe_id = secure_filename(str(file_id)) or 'unknown'
    safe_type = 'e2e' if thumb_type == 'e2e' else 'jpg'
    lock_path = os.path.join(
        _advisory_lock_dir(), f'rewrite_thumbnail_{safe_id}_{safe_type}.lock')
    return _open_flock_exclusive(lock_path)


def _release_thumbnail_publication_lock(lock_file):
    _release_file_rewrite_lock(lock_file)

def _acquire_upload_idempotency_lock(scope_key, timeout=None):
    """Bounded-wait upload flock: timeout=None keeps the historical blocking
    behaviour; otherwise returns None (not acquired) at the deadline so the
    caller can fail closed with a retryable status."""
    if not scope_key:
        return None
    lock_name = hashlib.sha256(scope_key.encode('utf-8')).hexdigest()
    lock_path = os.path.join(_advisory_lock_dir(), f'upload_idempotency_{lock_name}.lock')
    return _open_flock_exclusive(lock_path, timeout=timeout)

def _release_upload_idempotency_lock(lock_file):
    if not lock_file:
        return
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        try:
            lock_file.close()
        except Exception:
            pass


_UPLOAD_IDEMPOTENCY_DB_LOCK_SLICE_SECONDS = 30
# AUDIT FIX: both the host flock and the MariaDB GET_LOCK for one upload
# idempotency scope used to wait essentially forever (flock: unbounded; DB
# lock: 2 hours). With 8 gthreads per worker, waiters pinned every thread for
# the whole duration of the holder's upload + zip + encryption + commit, and
# the worker stopped serving everyone — trivial unauthenticated thread
# exhaustion by retrying a single upload_id. Both waits are now bounded and
# the route fails CLOSED with 503 + Retry-After on timeout, which is always
# safe for an idempotent client (a later retry returns the completed
# upload's reuse payload instead of a duplicate).
_UPLOAD_IDEMPOTENCY_WAIT_SECONDS = max(
    5, int(os.environ.get('UPLOAD_IDEMPOTENCY_WAIT_SECONDS', '300')))
_UPLOAD_IDEMPOTENCY_DB_LOCK_WAIT_SECONDS = _UPLOAD_IDEMPOTENCY_WAIT_SECONDS
# Per-user quota + guest temp cap flocks in the finalize window (bounded the
# same way for the same thread-pinning reason).
_UPLOAD_QUOTA_FLOCK_WAIT_SECONDS = max(
    5, int(os.environ.get('UPLOAD_QUOTA_FLOCK_WAIT_SECONDS', '300')))


def _acquire_upload_idempotency_database_lock(scope_key):
    """Serialize one upload key through MariaDB as well as the host flock."""
    if not scope_key or get_database_backend_name() != 'mysql':
        return None
    lock_name = 'onegy_upload_' + hashlib.sha256(
        scope_key.encode('utf-8')).hexdigest()[:51]
    connection = db.engine.connect()
    deadline = time.monotonic() + _UPLOAD_IDEMPOTENCY_DB_LOCK_WAIT_SECONDS
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Timed out waiting for upload idempotency database lock')
            wait_seconds = min(
                _UPLOAD_IDEMPOTENCY_DB_LOCK_SLICE_SECONDS,
                max(int(remaining), 1),
            )
            acquired = connection.execute(
                text('SELECT GET_LOCK(:lock_name, :wait_seconds)'),
                {'lock_name': lock_name, 'wait_seconds': wait_seconds},
            ).scalar()
            if acquired == 1:
                return connection, lock_name
            if acquired is None:
                raise RuntimeError('MariaDB upload idempotency lock is unavailable')
    except Exception:
        connection.close()
        raise


def _release_upload_idempotency_database_lock(lock_handle):
    if not lock_handle:
        return
    connection, lock_name = lock_handle
    try:
        released = connection.execute(
            text('SELECT RELEASE_LOCK(:lock_name)'),
            {'lock_name': lock_name},
        ).scalar()
        if released != 1:
            print(f'[WARNING] Upload idempotency database lock was not owned at release: {lock_name}')
    except Exception as e:
        print(f'[WARNING] Could not release upload idempotency database lock {lock_name}: {e}')
    finally:
        connection.close()


_FOLDER_CREATION_DB_LOCK_WAIT_SECONDS = 30


def _folder_creation_scope(user_id, parent_id):
    parent_scope = 'root' if parent_id is None else str(int(parent_id))
    return f'folder-create:{int(user_id)}:{parent_scope}'


def _acquire_folder_creation_lock(user_id, parent_id):
    """Serialize sibling creation locally and across MariaDB app hosts."""
    scope_key = _folder_creation_scope(user_id, parent_id)
    local_lock = _acquire_scoped_lock(scope_key, prefix='folder_create')
    database_lock = None
    if get_database_backend_name() != 'mysql':
        return local_lock, None

    lock_name = 'onegy_folder_' + hashlib.sha256(
        scope_key.encode('utf-8')).hexdigest()[:51]
    connection = db.engine.connect()
    try:
        acquired = connection.execute(
            text('SELECT GET_LOCK(:lock_name, :wait_seconds)'),
            {
                'lock_name': lock_name,
                'wait_seconds': _FOLDER_CREATION_DB_LOCK_WAIT_SECONDS,
            },
        ).scalar()
        if acquired != 1:
            raise RuntimeError('Timed out waiting for folder creation database lock')
        database_lock = (connection, lock_name)
        return local_lock, database_lock
    except Exception:
        connection.close()
        _release_scoped_lock(local_lock)
        raise


def _release_folder_creation_lock(lock_handle):
    if not lock_handle:
        return
    local_lock, database_lock = lock_handle
    if database_lock:
        connection, lock_name = database_lock
        try:
            released = connection.execute(
                text('SELECT RELEASE_LOCK(:lock_name)'),
                {'lock_name': lock_name},
            ).scalar()
            if released != 1:
                print(f'[WARNING] Folder creation database lock was not owned at release: {lock_name}')
        except Exception as e:
            print(f'[WARNING] Could not release folder creation database lock {lock_name}: {e}')
        finally:
            connection.close()
    _release_scoped_lock(local_lock)


def _acquire_scoped_lock(scope_key, prefix='scoped'):
    if not scope_key:
        return None
    lock_name = hashlib.sha256(str(scope_key).encode('utf-8')).hexdigest()
    lock_path = os.path.join(_advisory_lock_dir(), f'{prefix}_{lock_name}.lock')
    return _open_flock_exclusive(lock_path)


def _release_scoped_lock(lock_file):
    if not lock_file:
        return
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        try:
            lock_file.close()
        except Exception:
            pass


_ADMIN_REDUCTION_DB_LOCK_NAME = 'onegy_admin_reduction'
_ADMIN_REDUCTION_DB_LOCK_SLICE_SECONDS = 30
_ADMIN_REDUCTION_DB_LOCK_WAIT_SECONDS = 120


def _acquire_admin_reduction_database_lock():
    """AUDIT FIX M10: take a MariaDB GET_LOCK so the last-admin revalidation
    is serialized across every app host sharing the database, not just across
    the workers of one host (the flock alone is host-local). Skipped on
    non-mysql backends, which fall back to flock-only with a log line."""
    if get_database_backend_name() != 'mysql':
        print(f'[INFO] Admin reduction: no DB advisory lock on backend '
              f'{get_database_backend_name().upper()}, flock-only fallback')
        return None
    connection = db.engine.connect()
    deadline = time.monotonic() + _ADMIN_REDUCTION_DB_LOCK_WAIT_SECONDS
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Timed out waiting for admin reduction database lock')
            wait_seconds = min(
                _ADMIN_REDUCTION_DB_LOCK_SLICE_SECONDS,
                max(int(remaining), 1),
            )
            acquired = connection.execute(
                text('SELECT GET_LOCK(:lock_name, :wait_seconds)'),
                {
                    'lock_name': _ADMIN_REDUCTION_DB_LOCK_NAME,
                    'wait_seconds': wait_seconds,
                },
            ).scalar()
            if acquired == 1:
                return connection, _ADMIN_REDUCTION_DB_LOCK_NAME
            if acquired is None:
                raise RuntimeError('MariaDB admin reduction lock is unavailable')
    except Exception:
        connection.close()
        raise


def _release_admin_reduction_database_lock(database_lock):
    if not database_lock:
        return
    connection, lock_name = database_lock
    try:
        released = connection.execute(
            text('SELECT RELEASE_LOCK(:lock_name)'),
            {'lock_name': lock_name},
        ).scalar()
        if released != 1:
            print(f'[WARNING] Admin reduction database lock was not owned at release: {lock_name}')
    except Exception as e:
        print(f'[WARNING] Could not release admin reduction database lock {lock_name}: {e}')
    finally:
        connection.close()


def _acquire_admin_reduction_lock():
    """Serialize admin demotions and deletions across every local worker.

    AUDIT FIX M10: the host-local flock alone cannot protect the last-admin
    invariant against a second app host (or any writer that forgets the
    flock), so a DB-wide MariaDB GET_LOCK named 'onegy_admin_reduction' is
    layered on top before this returns. Callers run their revalidation count
    query only afterwards, so the check-and-demote sequence is serialized
    database-wide and only one host can reduce the final admin at a time.

    Returns (flock_handle, db_lock_handle); pass the whole pair back to
    _release_admin_reduction_lock(). Fails closed: if the DB lock cannot be
    taken, the flock is dropped and the error propagates.
    """
    lock_path = os.path.join(_advisory_lock_dir(), 'admin_reduction.lock')
    lock_file = _open_flock_exclusive(lock_path)
    try:
        database_lock = _acquire_admin_reduction_database_lock()
    except Exception:
        _release_scoped_lock(lock_file)
        raise
    return lock_file, database_lock


def _release_admin_reduction_lock(lock_handle):
    if not lock_handle:
        return
    lock_file, database_lock = lock_handle
    try:
        _release_admin_reduction_database_lock(database_lock)
    finally:
        _release_scoped_lock(lock_file)


def _revalidate_admin_reduction(actor_id, target_id, require_acting_admin=True):
    """Return fresh actor/target rows and reject removal of the final admin.

    Call only while holding _acquire_admin_reduction_lock(), which on MariaDB
    means both the host flock AND the DB-wide GET_LOCK: the count query below
    runs after the GET_LOCK is held, so two hosts can never both pass it (M10).
    Rolling back here starts a current read after any competing reduction has
    committed instead of reusing a MariaDB REPEATABLE READ snapshot opened by an
    auth decorator.
    """
    db.session.rollback()
    actor = db.session.get(User, actor_id, populate_existing=True)
    if not actor:
        return None, None, 'actor_missing'
    if require_acting_admin and not actor.is_admin:
        return actor, None, 'actor_not_admin'

    target = db.session.get(User, target_id, populate_existing=True)
    if not target:
        return actor, None, 'target_missing'
    if target.is_admin:
        another_admin = db.session.query(User.id).filter(
            User.is_admin == True,
            User.id != target.id,
        ).first()
        if another_admin is None:
            return actor, target, 'last_admin'
    return actor, target, None
