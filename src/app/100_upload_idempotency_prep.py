def _build_upload_idempotency_scope(upload_key, registered_user_id=None, user_id=None, manager_cookie=None):
    if not upload_key:
        return None
    if registered_user_id:
        return f'registered:{registered_user_id}:{upload_key}'
    if manager_cookie:
        return f'guest-manager:{manager_cookie}:{upload_key}'
    return f'guest-session:{user_id or ""}:{upload_key}'

def _find_existing_upload_by_key(upload_key, registered_user_id=None, user_id=None, manager_cookie=None):
    if not upload_key:
        return None
    query = File.query.filter_by(
        upload_idempotency_key=upload_key,
        is_trashed=False,
    ).populate_existing()
    if registered_user_id:
        return query.filter_by(registered_user_id=registered_user_id).order_by(File.upload_time.desc()).first()
    if manager_cookie:
        existing = query.filter_by(manager_cookie_id=manager_cookie, registered_user_id=None, is_temp_upload=True).order_by(File.upload_time.desc()).first()
        if existing:
            return existing
    if user_id:
        return query.filter_by(user_id=user_id, registered_user_id=None, is_temp_upload=True).order_by(File.upload_time.desc()).first()
    return None


# AUDIT FIX M9: DB-level backstop for the upload idempotency locks. The key is
# CLIENT-SUPPLIED (upload_id / progress id), so uniqueness is per OWNER, never
# global -- one user's key must not block another's. The three owner scopes
# _find_existing_upload_by_key() resolves a retry by each get their own UNIQUE
# index (declared on the File model; applied to existing databases by
# _ensure_unique_indexes). NULLs are DISTINCT in MariaDB, so a nullable owner
# column only constrains rows that actually carry it.
from sqlalchemy.exc import IntegrityError as _IdempotencyIntegrityError


def _release_trashed_upload_idempotency_keys(upload_key, registered_user_id=None,
                                             user_id=None, manager_cookie=None):
    """Release the idempotency key on TRASHED duplicate file rows (M9).

    The per-owner unique indexes cover rows in the trash too, while
    _find_existing_upload_by_key() only ever matches live rows
    (is_trashed=False), so a trashed row would block every same-key retry
    forever even though no lookup can ever find it again. Dedup semantics only
    ever match live rows, so releasing the key on trashed rows cannot change
    any lookup outcome; it just lets the winner's insert succeed. Returns the
    number of rows released."""
    if not upload_key:
        return 0
    scope_conditions = []
    bind_params = {'key': upload_key}
    if registered_user_id:
        scope_conditions.append('registered_user_id = :registered_user_id')
        bind_params['registered_user_id'] = registered_user_id
    if manager_cookie:
        scope_conditions.append('(registered_user_id IS NULL AND manager_cookie_id = :manager_cookie)')
        bind_params['manager_cookie'] = manager_cookie
    if user_id:
        scope_conditions.append('(registered_user_id IS NULL AND user_id = :user_id)')
        bind_params['user_id'] = user_id
    if not scope_conditions:
        return 0
    sql = text(
        'UPDATE file SET upload_idempotency_key = NULL '
        'WHERE upload_idempotency_key = :key AND is_trashed = 1 '
        'AND (' + ' OR '.join(scope_conditions) + ')'
    )
    try:
        result = db.session.execute(sql, bind_params)
        db.session.commit()
    except Exception as e:
        try:
            db.session.rollback()
        except Exception:
            pass
        print(f'[WARNING] Could not release trashed duplicate idempotency keys: {e}')
        return 0
    released = int(result.rowcount or 0)
    if released:
        print(f'[DB] Released upload idempotency key on {released} trashed file row(s) '
              f'blocking the unique index')
    return released


def _resolve_upload_key_unique_conflict(upload_key, registered_user_id=None,
                                        user_id=None, manager_cookie=None):
    """Resolve an IntegrityError from a per-owner upload idempotency index (M9).

    Callers must have rolled the session back already, so the lookups below run
    in a fresh transaction and can see the winner's committed row. Returns
    (existing_file_or_None, action):
      'reused'   -- a live winner exists in scope; serve it (the lock-bypass
                    race-loser case the DB backstop exists for)
      'retry'    -- only trashed rows held the key; they were released and the
                    caller may safely re-commit its pending insert once
      'conflict' -- a live row outside this request's dedup scope still holds
                    the key; do NOT retry (it would collide again)"""
    if not upload_key:
        return None, 'conflict'
    existing_upload = _find_existing_upload_by_key(
        upload_key,
        registered_user_id=registered_user_id,
        user_id=user_id,
        manager_cookie=manager_cookie,
    )
    if existing_upload:
        return existing_upload, 'reused'
    if _release_trashed_upload_idempotency_keys(
            upload_key,
            registered_user_id=registered_user_id,
            user_id=user_id,
            manager_cookie=manager_cookie):
        return None, 'retry'
    return None, 'conflict'


def _refresh_upload_idempotency_snapshot(registered_user_id=None):
    """End any pre-lock snapshot and safely re-resolve invalidated ORM state."""
    try:
        db.session.rollback()
    except Exception as e:
        print(f'[WARNING] Could not refresh the upload idempotency snapshot: {e}')
        raise RuntimeError('Could not refresh upload idempotency transaction snapshot') from e
    if registered_user_id is None:
        return None
    user = _current_session_user()
    if not user or user.id != registered_user_id:
        return None
    return user

def _build_upload_response_payload(file_record):
    if file_record.short_code:
        download_url = f'https://{domain}/s/{file_record.short_code}'
    else:
        download_url = f'https://{domain}/f/{file_record.id}/{urllib.parse.quote(file_record.orig_name)}'
    payload = {
        'redirect': url_for('manage', token=file_record.management_token),
        'download_url': download_url,
        'management_token': file_record.management_token,
        'file_id': file_record.id,
    }
    if file_record.is_e2e_encrypted and file_record.encrypted_file_key and file_record.folder_id:
        ancestor_info = get_shared_ancestor_info(file_record.folder_id)
        if ancestor_info:
            payload['needs_link_key'] = True
            payload['ancestor_share_token'] = ancestor_info['share_token']
            payload['ancestor_folder_id'] = ancestor_info['folder_id']
    return payload

def _upload_idempotent_reuse_response(existing_upload, manager_cookie=None):
    """M9: build the idempotent-reuse upload response. Shared by the pre-check
    path and the DB unique-index backstop path so both stay identical."""
    upload_result = _build_upload_response_payload(existing_upload)
    resp = make_response(jsonify(upload_result))
    if existing_upload.is_temp_upload and manager_cookie:
        resp.set_cookie(
            'onegy_manager', manager_cookie,
            max_age=7 * 24 * 3600,
            secure=True,
            samesite='Strict',
            httponly=False,
            path='/'
        )
    return resp

def _acquire_upload_key_locks(upload_scope):
    """Host flock + MariaDB GET_LOCK for one upload idempotency scope, both with
    bounded waits. Returns (flock, db_lock, busy). busy=True means fail closed
    with 503 + Retry-After; the caller still releases whatever was returned."""
    flock = _acquire_upload_idempotency_lock(upload_scope, timeout=_UPLOAD_IDEMPOTENCY_WAIT_SECONDS)
    if upload_scope and flock is None:
        print(f'[UPLOAD] Timed out after {_UPLOAD_IDEMPOTENCY_WAIT_SECONDS}s waiting for '
              'the upload idempotency lock; failing closed with 503')
        return None, None, True
    try:
        db_lock = _acquire_upload_idempotency_database_lock(upload_scope)
    except RuntimeError as db_lock_err:
        print(f'[UPLOAD] Upload idempotency database lock not acquired ({db_lock_err}); '
              'failing closed with 503')
        return flock, None, True
    return flock, db_lock, False


def _acquire_finalize_quota_lock(user_id):
    """Per-user quota flock for the short finalize+commit window only (bounded
    wait, never across the body transfer), then a fresh read snapshot so the
    authoritative quota check sees concurrent commits. Returns the lock, or None
    on timeout: fail closed, proceeding would race the check-and-commit."""
    quota_lock = _acquire_user_quota_lock(user_id, timeout=_UPLOAD_QUOTA_FLOCK_WAIT_SECONDS)
    if quota_lock is None:
        print('[UPLOAD] Timed out waiting for the per-user quota lock; '
              'failing closed with 503')
        return None
    _refresh_quota_snapshot()
    return quota_lock


def _cleanup_failed_upload_artifacts(encrypted_filename, file_id, payload_written, thumbnail_written):
    """Remove payload/thumbnail artifacts left behind by a failed upload.

    AUDIT FIX D15: the upload failure handlers used to run these deletes inside
    bare `try/except Exception: pass` blocks guarded by `'name' in dir()` string
    probes, so a written payload silently stayed on disk (and on every replica)
    with nothing in the log. Failures are logged with [ERROR] and each artifact
    is gated on an explicit sentinel."""
    if payload_written and encrypted_filename:
        try:
            storage.delete_file(encrypted_filename)
        except Exception as e:
            print(f'[ERROR] Upload cleanup failed to remove payload {encrypted_filename}: {e}')
    if thumbnail_written and file_id:
        try:
            delete_thumbnail_from_disk(file_id)
        except Exception as e:
            print(f'[ERROR] Upload cleanup failed to remove thumbnail for {file_id}: {e}')


def _commit_new_upload(file_record, staged_path, owner_id, key_scope,
                       thumbnail_part=None, thumbnail_nonce=None, log_prefix='UPLOAD'):
    """Publish a staged payload and commit its new File row. Shared by /upload
    and the desktop sync uploads (376_apiv1_sync_uploads.py).

    The caller holds the upload-key locks and, for a registered owner, the quota
    lock with the authoritative quota check done. This takes the owner's
    lifecycle lock for the publish + commit window (before the INSERT can
    autoflush parent-folder row locks). key_scope holds the owner kwargs of
    _find_existing_upload_by_key() for the DB unique-index backstop.
    thumbnail_part is any object with read(n) (E2EE only).

    Returns (outcome, row): ('committed', file_record), ('reused', winner) when
    another request committed the idempotency key first, ('folder_missing',
    None) or ('db_error', None). Unless committed, the session is rolled back
    and nothing this call wrote is left behind, also when it raises."""
    file_id = file_record.id
    encrypted_filename = file_record.filename
    upload_key = file_record.upload_idempotency_key
    folder_id = file_record.folder_id
    is_e2e = bool(file_record.is_e2e_encrypted)
    payload_written = False
    thumbnail_written = False
    lifecycle_lock = _acquire_user_lifecycle_lock(owner_id) if owner_id else None
    try:
        # AUDIT FIX P0-2/P1-13: add the File row BEFORE store_file so
        # _mark_replica_synced (called inside store_file) sees the pending row
        # through the identity map and back-fills the local FileReplica.
        db.session.add(file_record)
        # AUDIT FIX H4: drop any stale tombstone for this key before the row can
        # replicate (belt and braces; Phase B also checks).
        _clear_pending_remote_deletes_for('files', [encrypted_filename, file_id])
        touch_folder(folder_id)
        payload_written = True  # from here on a payload may exist under encrypted_filename
        storage.store_file(encrypted_filename, staged_path)
        print(f'[{log_prefix}] Saved file: {encrypted_filename}, content size: {file_record.size} bytes')
        if is_e2e and thumbnail_part and thumbnail_nonce:
            try:
                # AUDIT FIX (upload/download integrity): bounded read, never the
                # whole part into the worker heap.
                thumb_data, thumb_oversized = read_bounded_upload_part(
                    thumbnail_part, _MAX_ENCRYPTED_THUMBNAIL_BYTES)
                if thumb_oversized:
                    print(f'[{log_prefix}] E2E thumbnail exceeds {_MAX_ENCRYPTED_THUMBNAIL_BYTES} bytes, skipping')
                elif len(thumbnail_nonce) > 255:
                    # encrypted_thumbnail_nonce is String(255): an oversized value
                    # would fail the File commit, not just the thumbnail.
                    print(f'[{log_prefix}] E2E thumbnail nonce exceeds 255 characters, skipping thumbnail')
                elif thumb_data and save_thumbnail_to_disk(file_id, thumb_data, is_e2e=True):
                    thumbnail_written = True
                    file_record.encrypted_thumbnail_nonce = thumbnail_nonce
                    file_record.has_thumbnail = True
            except ReplicaSessionRollbackError as thumb_db_err:
                # AUDIT FIX H3: replica bookkeeping rolled back the shared session,
                # which expunged the pending File row. Committing would persist
                # nothing while reporting success; abort and clean up instead.
                print(f'[{log_prefix}] E2E thumbnail bookkeeping rolled back the DB session; aborting upload {file_id}: {thumb_db_err}')
                try:
                    db.session.rollback()
                except Exception:
                    pass
                _cleanup_failed_upload_artifacts(encrypted_filename, file_id, payload_written, True)
                payload_written = thumbnail_written = False
                return 'db_error', None
            except Exception as e:
                print(f'[{log_prefix}] E2E thumbnail save failed (non-critical): {e}')

        if owner_id and not _lock_live_folder_for_placement(folder_id, owner_id):
            db.session.rollback()
            _cleanup_failed_upload_artifacts(encrypted_filename, file_id, payload_written, thumbnail_written)
            payload_written = thumbnail_written = False
            return 'folder_missing', None

        try:
            # AUDIT FIX H3: refuse to commit unless the File row is still tracked
            # by the session (an internal rollback may have expunged it).
            _file_row_state = inspect(file_record)
            if not (_file_row_state.pending or _file_row_state.persistent):
                raise RuntimeError(
                    f'UPLOAD ABORT: File row {file_id} was expunged from the DB '
                    'session by an internal rollback before commit; refusing to '
                    'report success for a row that was never committed'
                )
            # AUDIT FIX A20: retry on a short_code uniqueness collision instead of
            # failing an upload whose payload is already written and encrypted.
            _commit_with_short_code_retry(file_record)
        except _IdempotencyIntegrityError as _key_err:
            # AUDIT FIX M9: the per-owner UNIQUE indexes on upload_idempotency_key
            # back the flock + GET_LOCK locks. Losing that race is an idempotent
            # retry: serve the winner's row (or release trashed duplicates and
            # retry once) instead of failing after the payload was written.
            if not upload_key or 'upload_idempotency_key' not in str(getattr(_key_err, 'orig', _key_err)).lower():
                raise
            db.session.rollback()
            existing_upload, conflict_action = _resolve_upload_key_unique_conflict(upload_key, **key_scope)
            if conflict_action == 'retry':
                print(f'[{log_prefix}] Released trashed duplicate idempotency rows for key {upload_key}; retrying insert')
                db.session.add(file_record)
                _clear_pending_remote_deletes_for('files', [encrypted_filename, file_id])
                touch_folder(folder_id)
                _commit_with_short_code_retry(file_record)
            elif conflict_action == 'reused':
                # This attempt's payload is an orphan: the winner's row owns the key.
                _cleanup_failed_upload_artifacts(encrypted_filename, file_id, payload_written, thumbnail_written)
                payload_written = thumbnail_written = False
                print(f'[{log_prefix}] Reused existing upload for idempotency key (DB unique backstop): {upload_key}')
                return 'reused', existing_upload
            else:
                raise RuntimeError(
                    f'UPLOAD CONFLICT: idempotency key {upload_key} is held by a live file row '
                    f'outside this request\'s dedup scope; refusing to create a duplicate'
                )
        # The committed row now owns the payload and thumbnail.
        payload_written = thumbnail_written = False
        return 'committed', file_record
    except BaseException:
        try:
            db.session.rollback()
        except Exception:
            pass
        _cleanup_failed_upload_artifacts(encrypted_filename, file_id, payload_written, thumbnail_written)
        raise
    finally:
        _release_lifecycle_lock(lifecycle_lock)


def _storage_limit_json(user):
    return jsonify({'error': f'STORAGE LIMIT EXCEEDED. YOU HAVE {user.get_storage_remaining_gb():.2f}GB REMAINING.'}), 413

def _request_content_length_exceeds(limit_bytes):
    content_length = request.content_length
    return content_length is not None and limit_bytes is not None and int(content_length) > int(limit_bytes)

_UPLOAD_MULTIPART_OVERHEAD_BYTES = 10 * 1024 * 1024

def _multipart_body_exceeds(payload_limit_bytes):
    """Early reject for multipart uploads: allow the same framing overhead as
    _set_request_upload_cap; final payload checks stay authoritative."""
    return _request_content_length_exceeds(int(payload_limit_bytes) + _UPLOAD_MULTIPART_OVERHEAD_BYTES)

# AUDIT FIX (upload/download integrity): ceiling for /file/create-blank. A blank
# file's E2EE container is a few dozen bytes; 5 MB is a generous headroom that
# still stops the route from spooling multi-GB bodies.
MAX_BLANK_FILE_BYTES = 5 * 1024 * 1024

def _set_request_upload_cap(limit_bytes):
    """Bound the request body to a per-request cap BEFORE request.files /
    request.get_data() is read.

    AUDIT FIX: `request.max_content_length` is a READ-ONLY property in
    Flask 3.x (it returns app.config['MAX_CONTENT_LENGTH'] and has no setter),
    so the previous assignment always raised
    "property 'max_content_length' ... has no setter" (caught below) and the
    tighter per-request cap was silently never enforced. Instead we wrap the
    raw WSGI input stream in a LimitedStream(is_max=True) -- exactly what
    Werkzeug's own get_input_stream() does when max_content_length is set --
    so both the multipart parser (request.files) and raw body reads
    (request.get_data()) raise RequestEntityTooLarge (413) once the cap is
    exceeded, including chunked uploads that carry no Content-Length. The
    global @app.errorhandler(413) turns that into the normal 413 response."""
    if limit_bytes is None:
        return
    from werkzeug.exceptions import RequestEntityTooLarge
    try:
        cap = int(limit_bytes) + _UPLOAD_MULTIPART_OVERHEAD_BYTES
        global_cap = app.config.get('MAX_CONTENT_LENGTH')
        if global_cap:
            cap = min(cap, int(global_cap))
        cap = max(cap, _UPLOAD_MULTIPART_OVERHEAD_BYTES)
        from werkzeug.wsgi import LimitedStream
        environ = request.environ
        wsgi_input = environ.get('wsgi.input')
        if wsgi_input is None:
            return
        # Reject early when the declared Content-Length already exceeds the cap
        # (mirrors get_input_stream()), without reading the body.
        content_length = request.content_length
        if content_length is not None and int(content_length) > cap:
            raise RequestEntityTooLarge()
        # Only wrap once, and only if not already wrapped by a prior call.
        if not environ.get('onegy.upload_cap_applied'):
            environ['wsgi.input'] = LimitedStream(wsgi_input, cap, is_max=True)
            environ['onegy.upload_cap_applied'] = True
    except RequestEntityTooLarge:
        # Let the 413 propagate so the global 413 handler / caller reports it.
        raise
    except Exception as e:
        # AUDIT FIX: this used to swallow the failure and let the request
        # continue WITHOUT the per-route cap (fail-OPEN — a broken cap meant
        # "unbounded body up to the global MAX_CONTENT_LENGTH"). Fail closed:
        # reject with the same 413 the cap itself would have produced, so an
        # inability to establish the cap can never mean "no cap".
        print(f'[UPLOAD] Could not set request upload cap; failing closed: {e}')
        raise RequestEntityTooLarge() from e

# ────────────────────────────────────────────────────────────────────
# AUDIT FIX (upload/download integrity): multipart truncation detection
# ────────────────────────────────────────────────────────────────────
# Werkzeug's multipart parser stops when the stream ends and only appends a
# FileStorage once its CLOSING boundary has arrived. It also parses with
# silent=True, so a body cut short mid-part raises nothing: in a multi-file
# upload truncated at part N, parts 1..N-1 were zipped, committed and
# acknowledged with HTTP 200 while the rest were silently absent -- the user's
# UI reported success for a batch that is missing files.
#
# There is no supported hook to ask the parser "did you see the terminator", so
# we count the bytes actually pulled off the socket and compare them to the
# client's own Content-Length. The counter is installed as the INNERMOST wrapper
# (before _set_request_upload_cap's LimitedStream) so every read passes through
# it. Deliberately no readinto(): LimitedStream falls back to read() when the
# wrapped stream has none, which keeps the accounting in one place.
class _CountingInputStream:
    """WSGI input wrapper that records how many body bytes were actually read."""

    def __init__(self, stream):
        self._stream = stream
        self.bytes_read = 0

    def read(self, size=-1):
        data = self._stream.read(size)
        if data:
            self.bytes_read += len(data)
        return data

    def readline(self, size=-1):
        data = self._stream.readline(size)
        if data:
            self.bytes_read += len(data)
        return data

    def readlines(self, hint=-1):
        lines = self._stream.readlines(hint)
        for line in lines:
            self.bytes_read += len(line)
        return lines

    def __iter__(self):
        for chunk in self._stream:
            if chunk:
                self.bytes_read += len(chunk)
            yield chunk

    def readable(self):
        return True

    def close(self):
        # The WSGI server owns the underlying stream's lifetime.
        return None


def _install_request_body_counter():
    """Wrap wsgi.input so the body length can be verified after parsing.

    MUST be called before anything touches request.form / request.files, and
    before _set_request_upload_cap() so the counter sits underneath the cap."""
    try:
        environ = request.environ
        if environ.get('onegy.body_counter') is not None:
            return
        wsgi_input = environ.get('wsgi.input')
        if wsgi_input is None:
            return
        counter = _CountingInputStream(wsgi_input)
        environ['wsgi.input'] = counter
        environ['onegy.body_counter'] = counter
    except Exception as e:
        print(f'[UPLOAD] Could not install request body counter: {e}')


def _request_body_was_truncated():
    """True when the client sent fewer body bytes than its own Content-Length.

    Returns False when the request carries no Content-Length (chunked bodies)
    or the counter could not be installed -- i.e. fails OPEN only where no
    verification is possible at all, never on a body we did measure."""
    try:
        declared = request.content_length
        if declared is None:
            return False
        counter = request.environ.get('onegy.body_counter')
        if counter is None:
            return False
        # Drain whatever the parser left behind (trailing CRLF after the closing
        # boundary, epilogue, ...) so the count is exact for a COMPLETE body.
        stream = request.environ.get('wsgi.input')
        if stream is not None:
            try:
                while counter.bytes_read < declared:
                    buf = stream.read(65536)
                    if not buf:
                        break
            except Exception as e:
                print(f'[UPLOAD] Request body drain aborted ({e}); treating body as truncated')
                return True
        if counter.bytes_read < int(declared):
            print(f'[UPLOAD] Truncated request body: received {counter.bytes_read} of '
                  f'{declared} declared bytes')
            return True
        return False
    except Exception as e:
        print(f'[UPLOAD] Could not verify request body length: {e}')
        return False


def _zip_skip_if_e2e(file_obj, zip_path, pre_skipped):
    """Server ZIPs cannot decrypt E2EE members. Omit them without consuming slots."""
    if file_obj and file_obj.is_e2e_encrypted:
        pre_skipped.append(_zip_skip_entry(zip_path, 'E2EE FILE: DOWNLOAD INDIVIDUALLY'))
        return True
    return False


def _reserve_zip_download_slot(file_obj):
    """Reserve a download slot for a ZIP member.

    AUDIT FIX D8: returns the reservation token (truthy) instead of a bare True,
    so the caller can release exactly the slot it took if the member later fails
    to decrypt.

    AUDIT FIX P5: returns (reservation, skip_reason). Callers used to just
    `continue` on a failed reservation, which skipped the skipped_names bookkeeping
    entirely -- so a member dropped because it had hit its max_downloads limit (by
    far the most common skip reason) appeared in neither _DOWNLOAD_ERRORS.txt nor
    the X-Incomplete-Archive header. The reason string must now be recorded."""
    if file_obj and file_obj.is_e2e_encrypted:
        return None, 'E2EE FILE: DOWNLOAD INDIVIDUALLY'
    success, error, reservation = check_and_reserve_download(file_obj)
    if success:
        return reservation, None
    if error == 'limit_reached':
        print(f'[ZIP DOWNLOAD] Skipping file at download limit: {file_obj.orig_name}')
        return None, 'DOWNLOAD LIMIT REACHED'
    print(f'[ZIP DOWNLOAD] Skipping unavailable file: {file_obj.orig_name} ({error})')
    return None, 'FILE UNAVAILABLE'

def _finalize_zip_download_slots(file_ids, completed):
    for fid in file_ids:
        finalize_reserved_download(fid, completed)

def _zip_skip_entry(name, reason):
    """Format one line of the in-archive skip manifest."""
    return f'{name}  [{reason}]' if reason else str(name)

_ZIP_SKIP_MANIFEST_NAME = '_DOWNLOAD_ERRORS.txt'

def _write_zip_skip_manifest(zf, skipped_names, used_names=None):
    """AUDIT FIX H5: record files that could NOT be added to a download ZIP
    inside the archive itself, so the recipient is not silently handed an
    incomplete ZIP that looks complete. Best-effort: a failure to write the
    manifest must not abort the (partial) download.

    AUDIT FIX P6: the manifest used a FIXED root path, so a shared folder holding
    a genuine `_DOWNLOAD_ERRORS.txt` produced a duplicate-name archive where the
    user's real file and the manifest fought over one entry -- the
    failure-reporting mechanism was itself a source of data loss. It now goes
    through the same arcname allocator as every real member, so it can only ever
    land on a free name."""
    if not skipped_names:
        return
    lines = ['THE FOLLOWING FILES COULD NOT BE INCLUDED AND ARE MISSING FROM THIS ARCHIVE:', '']
    lines.extend(skipped_names)
    entry_name = _unique_zip_entry_name(_ZIP_SKIP_MANIFEST_NAME, used_names)
    try:
        zf.writestr(entry_name, '\n'.join(lines) + '\n')
    except Exception as e:
        print(f'[ZIP] Warning: failed to write skip manifest: {e}')

def _build_zip_download_response(temp_zip_path, temp_zip_dir, zip_filename, file_ids, log_prefix,
                                 incomplete_count=0, release_zip_reservation=None):
    zip_size = os.path.getsize(temp_zip_path)

    def _finalize(completed):
        # AUDIT FIX P11: the ZIP concurrency slot (and its disk reservation) is
        # released HERE -- after the archive has actually been streamed and its
        # temp tree removed -- not when the view returned the response. Wrapped
        # so a cleanup failure can never leak the slot.
        try:
            _finalize_zip_download_slots(file_ids, completed)
            try:
                shutil.rmtree(temp_zip_dir)
                print(f'{log_prefix} Cleaned up ZIP temp dir: {temp_zip_dir}')
            except Exception as e:
                print(f'{log_prefix} Warning: Failed to cleanup temp dir: {e}')
        finally:
            if release_zip_reservation is not None:
                _release_zip_slot(release_zip_reservation)

    # AUDIT FIX H5: surface partial archives to the client via a response header
    # (in addition to the in-archive _DOWNLOAD_ERRORS.txt manifest) so callers
    # can detect that some requested files were omitted.
    extra_headers = None
    if incomplete_count and incomplete_count > 0:
        extra_headers = {'X-Incomplete-Archive': str(incomplete_count)}

    return _build_streaming_response(
        lambda: _iter_file_chunks(temp_zip_path),
        'application/zip',
        disposition='attachment',
        filename=zip_filename,
        content_length=zip_size,
        headers=extra_headers,
        on_finalize=_finalize
    )

def _finalize_download_with_temp_cleanup(file_id, cleanup_fn):
    """Build an on_finalize callback that ALWAYS removes the decrypted temp file.

    AUDIT FIX (upload/download integrity): the large-file/CLI download paths used
    `on_finalize=lambda completed: (finalize_reserved_download(...), _cleanup_tmp(...))`.
    Python evaluates the tuple elements left to right, so ANY exception out of
    finalize_reserved_download() (a DB error, a StaleDataError during the
    burn-after-N delete, ...) skipped the cleanup entirely and left the fully
    DECRYPTED plaintext of an at-rest-encrypted file on disk. The cleanup now
    runs in a finally, and _build_streaming_response logs a failure here with
    [ERROR] rather than a soft warning."""
    def _finalize(completed):
        try:
            if file_id:
                finalize_reserved_download(file_id, completed)
        finally:
            cleanup_fn(completed)
    return _finalize


def _prepare_sync_download(encrypted_path, file):
    prep_id = str(uuid.uuid4())
    state = {
        'status': 'ready',
        'ready': False,
        'temp_path': None,
        'orig_size': file.size or 0,
        'file_id': file.id,
        'session_id': _get_download_session_id(),
        'created_at': datetime.now(timezone.utc).isoformat(),
        'delivery_pid': os.getpid(),
        'delivery_identity': _prep_process_identity(os.getpid()),
    }
    reserved, active_preps = _reserve_prep_download_slot(prep_id, state)
    if not reserved:
        print(f'[DOWNLOAD] Synchronous preparation rejected ({active_preps} active preparations)')
        return None, None

    def cleanup(_completed=False):
        if _remove_prep_plaintext(prep_id, state, 'synchronous delivery finalized'):
            _reap_prep_state(prep_id, state, 'synchronous delivery finalized')
        else:
            _transition_prep_state(prep_id, ('ready', 'error'), status='error',
                                   temp_path=state.get('temp_path'))

    try:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix='.dec', dir=app.config['UPLOAD_FOLDER'])
        state['temp_path'] = tmp_path
        with os.fdopen(tmp_fd, 'wb') as tmp_file:
            if not _transition_prep_state(prep_id, ('ready',), temp_path=tmp_path):
                raise RuntimeError('Could not record synchronous download plaintext path')
            for chunk in decrypt_file_chunked(
                    encrypted_path, expected_size=file.size,
                    expected_payload_checksum=file.payload_checksum,
                    expected_disk_size=file.disk_size, file_id=file.id):
                tmp_file.write(chunk)
            if tmp_file.tell() != file.size:
                raise ValueError(f'Decrypted size mismatch: expected {file.size} bytes, got {tmp_file.tell()}')
        return tmp_path, cleanup
    except Exception:
        cleanup()
        raise


def _payload_disk_size_matches(encrypted_path, expected_disk_size):
    """AUDIT FIX S3: cheap pre-flight check that the on-disk encrypted payload
    size matches the committed disk_size BEFORE a streaming Response (200 +
    Content-Length) is constructed. The size pre-check inside decrypt_file_chunked
    runs lazily -- only when the WSGI server pulls the first chunk, i.e. AFTER the
    200 + Content-Length headers were already emitted -- so a corrupt/truncated
    stored payload otherwise yields a body shorter than the advertised length
    (a truncated 'success'). Doing the stat up front lets the route return a
    proper error status instead.

    Returns True only when the on-disk size matches the committed disk_size.
    Missing size, zero, or stat errors fail closed."""
    if expected_disk_size is None:
        return False
    try:
        expected = int(expected_disk_size)
    except (TypeError, ValueError):
        return False
    if expected < 0:
        return False
    try:
        return os.path.getsize(encrypted_path) == expected
    except OSError:
        return False


def _build_streaming_response(chunk_iter_factory, mimetype, disposition=None, filename=None,
                              content_length=None, headers=None, on_success=None,
                              on_finalize=None):
    """Build a streaming response that can run success/finalizer callbacks."""
    from flask import Response

    finalized = False

    def finalize(stream_completed=False):
        nonlocal finalized
        if finalized:
            return
        finalized = True
        if stream_completed and on_success:
            try:
                with app.app_context():
                    on_success()
            except Exception as e:
                print(f'[ERROR] Download completion hook failed: {e}')
        if on_finalize:
            try:
                with app.app_context():
                    on_finalize(stream_completed)
            except Exception as e:
                print(f'[ERROR] Download finalizer hook failed: {e}')

    def generate():
        stream_completed = False
        try:
            for chunk in chunk_iter_factory():
                yield chunk
            stream_completed = True
        finally:
            finalize(stream_completed)

    from werkzeug.wsgi import ClosingIterator
    response = Response(ClosingIterator(generate(), finalize), mimetype=mimetype,
                        direct_passthrough=True)
    response.call_on_close(finalize)
    if disposition and filename:
        response.headers['Content-Disposition'] = safe_content_disposition(disposition, filename)
    if content_length is not None:
        response.headers['Content-Length'] = content_length
    if headers:
        for key, value in headers.items():
            response.headers[key] = value
    return response

