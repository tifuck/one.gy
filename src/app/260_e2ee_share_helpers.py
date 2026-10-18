@app.route('/guest-files')
def guest_files():
    if 'user_id' not in session:
        return redirect(url_for('index'))
    
    user_id = session['user_id']
    # AUDIT FIX (finding 4 + 5): filter trash + expiry in SQL instead of
    # loading every row and filtering in Python, and DEFER the thumbnail BLOB
    # columns -- the old bare .all() pulled every legacy thumbnail blob into
    # memory just to render a list, and listed trashed rows the user had
    # already thrown away. The expiry predicate mirrors the Python
    # get_expires_at_aware() >= now comparison (NULL = never expires).
    now_utc = datetime.now(timezone.utc)
    user_files = File.query.filter(
        File.user_id == user_id,
        File.registered_user_id.is_(None),
        File.is_temp_upload == True,
        File.is_trashed == False,
        db.or_(File.expires_at.is_(None), File.expires_at >= now_utc),
    ).options(
        db.defer(File.thumbnail_data),
        db.defer(File.encrypted_thumbnail_data),
    ).order_by(File.upload_time.desc()).all()

    return render_template('guest_files.html', files=user_files)

def encrypt_file_chunked(input_path, output_path, file_id=None):
    """Encrypt a large file in chunks to avoid memory issues.
    
    Uses 8MB chunks for optimal CPU cache performance (~2x faster than 64MB).
    If file_id is provided, reports progress via the upload progress tracker
    so the frontend can poll for status updates.

    Returns (plain_hash, payload_checksum): SHA-256 hex digests of the
    plaintext input and of the encrypted output as written to disk
    (length prefixes + Fernet tokens). Computing both inside this single
    read/write pass replaces the separate _sha256_file() passes callers
    used to make before and after encryption (3 full reads -> 1).
    The digests are byte-identical to hashing the files separately.
    """
    chunk_size = 8 * 1024 * 1024  # 8MB chunks - better CPU cache utilization than 64MB
    file_size = os.path.getsize(input_path)
    total_chunks = max(1, (file_size + chunk_size - 1) // chunk_size)
    chunk_num = 0
    bytes_processed = 0
    start_time = time.time()
    last_progress_update = 0
    plain_hasher = hashlib.sha256()
    payload_hasher = hashlib.sha256()
    with open(input_path, 'rb') as infile, open(output_path, 'wb') as outfile:
        while True:
            chunk = infile.read(chunk_size)
            if not chunk:
                break
            plain_hasher.update(chunk)
            encrypted_chunk = fernet.encrypt(chunk)
            # Write length of encrypted chunk (4 bytes) followed by the chunk
            len_bytes = len(encrypted_chunk).to_bytes(4, 'big')
            outfile.write(len_bytes)
            outfile.write(encrypted_chunk)
            payload_hasher.update(len_bytes)
            payload_hasher.update(encrypted_chunk)
            chunk_num += 1
            bytes_processed += len(chunk)
            elapsed = time.time() - start_time
            speed = bytes_processed / (elapsed * 1024 * 1024) if elapsed > 0 else 0
            percent = min(99, bytes_processed * 100 // file_size) if file_size > 0 else 100
            
            # Update progress tracker for frontend polling (every 0.5s to avoid lock contention)
            now = time.time()
            if file_id and (now - last_progress_update >= 0.5):
                last_progress_update = now
                set_upload_progress(file_id, 'encrypting', percent, round(speed, 1))
            
            # Log every ~256MB for server-side visibility without spamming
            if chunk_num % 32 == 0 or chunk_num == total_chunks:
                print(f'[UPLOAD] Encryption progress: {percent}% ({bytes_processed // (1024*1024)}MB / {file_size // (1024*1024)}MB) - {speed:.1f} MB/s')
    
    elapsed = time.time() - start_time
    speed = bytes_processed / (elapsed * 1024 * 1024) if elapsed > 0 else 0
    print(f'[UPLOAD] Encryption complete: {chunk_num} chunks, {bytes_processed // (1024*1024)}MB in {elapsed:.1f}s ({speed:.1f} MB/s)')
    return plain_hasher.hexdigest(), payload_hasher.hexdigest()

def decrypt_file_chunked(input_path, expected_size=None,
                         expected_payload_checksum=None, expected_disk_size=None,
                         file_id=None):
    """Decrypt a file that was encrypted in chunks — yields decrypted chunks.

    This function should ONLY be used for server-side encrypted files.
    E2E encrypted files should NOT use this function.
    Raises FileNotFoundError if the file was deleted (e.g. by cleanup job).

    If expected_size is provided, raises ValueError when total decrypted bytes
    don't match, detecting silent truncation or corruption at chunk boundaries.

    If expected_payload_checksum is provided, accumulate SHA-256 of the
    on-disk encrypted bytes (length prefixes + Fernet tokens) and raise
    ValueError if it doesn't match File.payload_checksum recorded at upload.
    If expected_disk_size is provided, pre-check the encrypted file's size
    against it BEFORE starting decryption (cheap up-front truncation check).
    See AUDIT Tier 0 #1.

    AUDIT FIX (upload/download integrity) -- LAST-CHUNK HOLDBACK:
    the decrypted-size and payload-checksum verifications can only run once the
    whole ciphertext has been read, and this generator used to have already
    YIELDED every byte by then. A mismatch therefore reached the client as a
    complete, well-formed body that terminated normally -- indistinguishable
    from success. Buffering a multi-GB file to verify before sending is not an
    option, so instead we hold back the MOST RECENT decrypted chunk and only
    release it after the integrity checks pass. On a mismatch we raise without
    ever emitting that final chunk, so the client receives strictly fewer bytes
    than the advertised Content-Length and the connection is torn down
    mid-body: curl reports "transfer closed with N bytes remaining", browsers
    report a failed download, and the on-disk consumers (prepared download, CLI
    temp file, audio preview) hit the exception before the file is served. The
    failure is also logged via _log_payload_corruption() with [ERROR].
    Memory cost is one Fernet chunk, the same working set the loop already had.
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f'Encrypted file not found: {input_path}')
    file_size = os.path.getsize(input_path)

    # Cheap up-front truncation check against File.disk_size (if provided)
    if expected_disk_size is not None and file_size != expected_disk_size:
        _log_payload_corruption(
            file_id, 'fernet-disk-size',
            expected_payload_checksum or '(none)', '(none)',
            expected_size=expected_disk_size, actual_size=file_size,
            source_path=input_path,
        )
        raise ValueError(
            f'Encrypted disk size mismatch for file {file_id!r}: '
            f'expected {expected_disk_size} bytes, found {file_size}'
        )

    print(f'[DECRYPT] Starting chunked decryption of {input_path}, file size: {file_size} bytes')

    total_decrypted = 0
    payload_hasher = hashlib.sha256() if expected_payload_checksum else None
    # AUDIT FIX (see docstring): the most recently decrypted chunk is withheld
    # until the trailing integrity checks pass, so a mismatch can never present
    # to the client as a cleanly-terminated body.
    held_back_chunk = None
    with open(input_path, 'rb') as f:
        chunk_num = 0
        while True:
            # Read length of the next encrypted chunk (4 bytes)
            length_bytes = f.read(4)
            if not length_bytes:
                break  # End of file
            if payload_hasher is not None:
                payload_hasher.update(length_bytes)

            # Defensive: incomplete length header (rare; happens on truncated file).
            if len(length_bytes) != 4:
                print(f'[DECRYPT] ERROR: Truncated chunk length header at chunk #{chunk_num} (got {len(length_bytes)} bytes)')
                raise ValueError(f'Truncated chunk length header: got {len(length_bytes)} bytes')

            token_length = int.from_bytes(length_bytes, 'big')
            current_pos = f.tell()

            # Sanity check: if token_length is unreasonably large, this is likely not a chunked file
            if token_length > 100 * 1024 * 1024:  # > 100MB for a single chunk
                print(f'[DECRYPT] ERROR: Suspiciously large chunk size {token_length} at position {current_pos-4}')
                print(f'[DECRYPT] This file may be E2E encrypted or corrupted. File should use server-side chunked encryption.')
                raise ValueError(f"Invalid chunk size: {token_length} bytes. This file may not be server-side encrypted with chunking.")

            # Read the encrypted chunk
            token = f.read(token_length)
            if payload_hasher is not None:
                payload_hasher.update(token)
            if len(token) != token_length:
                remaining_in_file = file_size - current_pos
                print(f'[DECRYPT] ERROR: Incomplete chunk #{chunk_num} at position {current_pos}')
                print(f'[DECRYPT] Expected {token_length} bytes, got {len(token)} bytes, remaining in file: {remaining_in_file} bytes')
                raise ValueError(f"Incomplete encrypted chunk: expected {token_length} bytes, got {len(token)}")

            try:
                decrypted = fernet.decrypt(token)
                chunk_num += 1
            except Exception as e:
                print(f'[DECRYPT] ERROR: Failed to decrypt chunk #{chunk_num}: {e}')
                raise

            total_decrypted += len(decrypted)
            # Excess plaintext is already provable here; checking only after the
            # loop would first release a complete advertised body to the client.
            if expected_size is not None and total_decrypted > expected_size:
                print(f'[DECRYPT] ERROR: Size mismatch! Expected {expected_size} bytes, got more than that at chunk #{chunk_num} (corrupted)')
                _log_payload_corruption(
                    file_id, 'fernet-plaintext-size',
                    expected_payload_checksum or '(none)', '(none)',
                    expected_size=expected_size, actual_size=total_decrypted,
                    source_path=input_path,
                )
                raise ValueError(f"Decrypted size mismatch: more than the expected {expected_size} bytes")
            # Release the PREVIOUS chunk now that this one decrypted cleanly;
            # keep the newest one back until the trailing checks below pass.
            if held_back_chunk is not None:
                yield held_back_chunk
            held_back_chunk = decrypted

        print(f'[DECRYPT] Successfully decrypted {chunk_num} chunks, {total_decrypted} bytes')

    # Validate decrypted size matches expected size if provided (detects silent truncation)
    if expected_size is not None and total_decrypted != expected_size:
        print(f'[DECRYPT] ERROR: Size mismatch! Expected {expected_size} bytes, got {total_decrypted} bytes (truncated or corrupted)')
        _log_payload_corruption(
            file_id, 'fernet-plaintext-size',
            expected_payload_checksum or '(none)', '(none)',
            expected_size=expected_size, actual_size=total_decrypted,
            source_path=input_path,
        )
        # held_back_chunk is intentionally DISCARDED: the client must not be able
        # to observe a normally-terminated body for a payload we know is bad.
        raise ValueError(f"Decrypted size mismatch: expected {expected_size} bytes, got {total_decrypted} bytes")

    # Validate on-disk payload checksum matches what was recorded at upload time.
    # Fernet's AEAD already rejects per-chunk corruption; this additionally
    # catches bit-rot that still happens to form a valid Fernet token AND
    # produces a forensic [ERROR] log line so log monitoring can detect the
    # corruption and we can repair from a healthy replica. Because the final
    # chunk is still withheld at this point, a mismatch aborts the response
    # mid-body instead of completing it.
    if payload_hasher is not None:
        actual_checksum = payload_hasher.hexdigest()
        if actual_checksum != expected_payload_checksum:
            _log_payload_corruption(
                file_id, 'fernet-payload',
                expected_payload_checksum, actual_checksum,
                source_path=input_path,
            )
            raise ValueError(
                f'Fernet payload checksum mismatch for file {file_id!r}: '
                f'expected {expected_payload_checksum}, got {actual_checksum}'
            )

    # All integrity checks passed -- the withheld final chunk is now safe to send.
    if held_back_chunk is not None:
        yield held_back_chunk


def _e2e_upload_boundary_for_folder(folder):
    """Return the folder that requires uploads to be E2EE, or None.
    Memoized per request via _walker_cache (this was the only ancestor walker
    without one; the browse/ZIP collectors call it once per folder)."""
    if not folder:
        return None
    cache = _walker_cache('e2e_upload_boundary')
    if folder.id in cache:
        return cache[folder.id]
    current = folder
    visited = set()
    result = None
    while current and current.id not in visited:
        visited.add(current.id)
        current_requires_e2e = current.is_e2e is True and bool(current.encrypted_name or current.encrypted_name_key)
        if current_requires_e2e:
            if current.id == folder.id or current.is_browsable:
                result = current
                break
        if current.parent_id is None:
            break
        current = db.session.get(Folder, current.parent_id)
    cache[folder.id] = result
    return result


def _e2e_file_has_non_owner_key(file):
    """Return True if a non-owner can plausibly decrypt this E2EE file."""
    return bool(file and (
        file.link_encrypted_file_key
        or getattr(file, 'folder_link_encrypted_file_key', None)
        or file.file_key_salt
        or file.e2e_salt
    ))

def _folder_not_expired(folder):
    if not folder or folder.is_trashed:
        return False
    expires_aware = folder.get_expires_at_aware() if folder.expires_at else None
    return not (expires_aware and expires_aware < datetime.now(timezone.utc))

def _file_not_expired(file):
    """AUDIT FIX P1: file expiry was enforced by download_file_logic() and
    /f/<id>/encrypted but by NOTHING on the token-scoped /f/<share_token>/...
    surface -- browse_folder_download_file() only consulted
    check_download_allowed(), which inspects max_downloads and nothing else. A
    visitor holding a folder token could therefore keep pulling an expired file
    through /f/<token>/file/<id>, /download-all, /download-selected and the
    sub-folder ZIP until the 5-minute cleanup job happened to reap it. Every
    token-scoped collector and data path now runs this check.

    Deliberately does NOT delete the expired row (unlike download_file_logic):
    these are read paths reachable by anonymous visitors, so they fail closed and
    leave reaping to cleanup_job."""
    if not file:
        return False
    expires_aware = file.get_expires_at_aware()
    return not (expires_aware and expires_aware < datetime.now(timezone.utc))

def _share_access_marker(resource_type, resource_id, password_hash):
    secret = app.config['SECRET_KEY'].encode('utf-8')
    marker_input = f'{resource_type}:{resource_id}:{password_hash or ""}'.encode('utf-8')
    return hmac.new(secret, marker_input, hashlib.sha256).hexdigest()

# AUDIT FIX P10: share-unlock markers live in the CLIENT-SIDE session cookie and
# used to be a plain {resource_id: marker} dict that was never pruned and never
# expired. At ~110 bytes per entry roughly 30 unlocks pushed the cookie past the
# 4093-byte browser limit; Werkzeug logs a warning and the BROWSER SILENTLY DROPS
# the cookie -- destroying the whole session, including logged_in_user_id for an
# authenticated visitor. Markers are now stamped with their issue time, capped in
# number (oldest evicted first) and expired.
_SHARE_UNLOCK_MAX_ENTRIES = 12
_SHARE_UNLOCK_TTL_SECONDS = 6 * 3600

def _parse_share_unlock_entry(value):
    """Split a stored '<marker>.<issued_epoch>' entry. Returns (marker, issued)
    or None. Legacy entries (bare marker, no timestamp) are treated as invalid
    so they expire out of the cookie instead of living forever; the visitor
    simply re-enters the share password once."""
    if not isinstance(value, str) or '.' not in value:
        return None
    marker, _, issued = value.rpartition('.')
    if not marker:
        return None
    try:
        return marker, int(issued)
    except (TypeError, ValueError):
        return None

def _remember_share_unlock(session_key, resource_id, marker):
    store = session.get(session_key)
    if not isinstance(store, dict):
        store = {}
    now = int(time.time())
    pruned = {}
    for key, value in store.items():
        parsed = _parse_share_unlock_entry(value)
        if parsed and 0 <= (now - parsed[1]) < _SHARE_UNLOCK_TTL_SECONDS:
            pruned[key] = value
    pruned[str(resource_id)] = f'{marker}.{now}'
    if len(pruned) > _SHARE_UNLOCK_MAX_ENTRIES:
        ordered = sorted(pruned.items(), key=lambda kv: (_parse_share_unlock_entry(kv[1]) or ('', 0))[1])
        for key, _value in ordered[:len(pruned) - _SHARE_UNLOCK_MAX_ENTRIES]:
            pruned.pop(key, None)
        print(f'[WARNING] Evicted oldest share-unlock marker(s) from {session_key} to keep the session cookie bounded')
    session[session_key] = pruned
    session.modified = True

def _share_unlock_valid(session_key, resource_id, expected_marker):
    store = session.get(session_key)
    if not isinstance(store, dict):
        return False
    parsed = _parse_share_unlock_entry(store.get(str(resource_id)))
    if not parsed:
        return False
    stored_marker, issued = parsed
    now = int(time.time())
    if not (0 <= (now - issued) < _SHARE_UNLOCK_TTL_SECONDS):
        return False
    return hmac.compare_digest(stored_marker, expected_marker)

def _remember_folder_share_access(folder):
    if not folder or not folder.password_hash:
        return
    _remember_share_unlock('unlocked_folder_shares', folder.id,
                           _share_access_marker('folder', folder.id, folder.password_hash))

# AUDIT FIX M11: per-resource + per-IP lockout for share-password verification.
# Share-password checks use a constant-time hash compare, but attempts flow
# through download/browse routes whose only throttle is the generic per-IP
# download limiter (60/min anon). With no resource-scoped counter a weak share
# password could be brute-forced at ≥60 guesses/min/IP. This adds an escalating
# lockout keyed on (resource, client IP), backed by per-resource/per-address
# flocked files so every worker shares the same attempt budget.
#
# AUDIT FIX P16: the per-IP key alone is not a budget -- an attacker rotating
# source addresses got a fresh 10-attempt allowance per address, bounded only by
# the generic limiter. Each attempt also ran check_password_hash (a full PBKDF2
# KDF) BEFORE the failure was recorded, so an authenticated attacker could pin
# the CPU. There is now ALSO a per-resource global budget, and BOTH lockouts are
# consulted before any KDF work happens, so the total number of KDF evaluations
# an unauthenticated caller can force against one resource is bounded.
_share_pw_failure_map = {}   # non-authoritative process-local mirror
_share_pw_lock = threading.Lock()
SHARE_PW_MAX_ATTEMPTS = 10
SHARE_PW_LOCKOUT_SECONDS = 300
SHARE_PW_GLOBAL_MAX_ATTEMPTS = 50
SHARE_PW_GLOBAL_LOCKOUT_SECONDS = 900
SHARE_PW_FAILURE_RESET_AFTER = SHARE_PW_GLOBAL_LOCKOUT_SECONDS

def _share_pw_lockout_key(kind, resource_id):
    return f'{kind}:{resource_id}:{get_remote_address()}'

def _share_pw_global_lockout_key(kind, resource_id):
    """Per-resource budget shared by ALL source addresses."""
    return f'{kind}:{resource_id}:*'


def _read_share_pw_failure_state(key, now):
    state = _read_security_state('share_pw_failure', key)
    if (not _security_state_fresh(state, now)
            or (float(state.get('last', 0)) + SHARE_PW_FAILURE_RESET_AFTER < now
                and float(state.get('until', 0)) < now)):
        _write_security_state('share_pw_failure', key, None)
        return {}
    return state


def _write_share_pw_failure_state(key, state):
    if state:
        state['retain_until'] = max(
            float(state.get('last', 0)) + SHARE_PW_FAILURE_RESET_AFTER,
            float(state.get('until', 0)),
        )
    _write_security_state('share_pw_failure', key, state)

def _share_pw_is_locked(kind, resource_id):
    now = time.time()
    keys = (_share_pw_lockout_key(kind, resource_id),
            _share_pw_global_lockout_key(kind, resource_id))
    locks = _acquire_security_state_locks(
        [('share_pw_failure', key) for key in keys])
    try:
        for key in keys:
            entry = _read_share_pw_failure_state(key, now)
            if entry and entry.get('until', 0) > now:
                return True
        return False
    finally:
        _release_security_state_locks(locks)

def _share_pw_begin_attempt(kind, resource_id):
    """Charge one attempt to both budgets BEFORE the KDF runs, or return False
    while locked out. Check and charge share one critical section, so concurrent
    requests cannot all pass the check and overrun the budget; a correct
    password then clears the charge via _share_pw_clear()."""
    return _share_pw_record_failure(kind, resource_id, require_unlocked=True)

def _share_pw_record_failure(kind, resource_id, require_unlocked=False):
    now = time.time()
    scoped_key = _share_pw_lockout_key(kind, resource_id)
    global_key = _share_pw_global_lockout_key(kind, resource_id)
    entries = (
        (scoped_key, SHARE_PW_MAX_ATTEMPTS, SHARE_PW_LOCKOUT_SECONDS,
         get_remote_address()),
        (global_key, SHARE_PW_GLOBAL_MAX_ATTEMPTS,
         SHARE_PW_GLOBAL_LOCKOUT_SECONDS, 'all addresses'),
    )
    locks = _acquire_security_state_locks(
        [('share_pw_failure', key) for key in (scoped_key, global_key)])
    try:
        if require_unlocked:
            for key in (scoped_key, global_key):
                entry = _read_share_pw_failure_state(key, now)
                if entry and entry.get('until', 0) > now:
                    return False
        for key, max_attempts, lockout_seconds, scope in entries:
            entry = _read_share_pw_failure_state(key, now) or {'count': 0, 'until': 0, 'last': 0}
            entry['count'] = entry.get('count', 0) + 1
            entry['last'] = now
            if entry['count'] >= max_attempts:
                over = entry['count'] - max_attempts
                entry['until'] = now + min(lockout_seconds * (2 ** min(over, 4)), 3600)
                print(f'[RATELIMIT] Share-password lockout for {kind} {resource_id} '
                      f'(attempt {entry["count"]} from {scope})')
            _write_share_pw_failure_state(key, entry)
            with _share_pw_lock:
                _share_pw_failure_map[key] = dict(entry)
                if len(_share_pw_failure_map) > 8192:
                    _share_pw_failure_map.clear()
        return True
    finally:
        _release_security_state_locks(locks)

def _share_pw_clear(kind, resource_id):
    keys = (_share_pw_lockout_key(kind, resource_id),
            _share_pw_global_lockout_key(kind, resource_id))
    locks = _acquire_security_state_locks(
        [('share_pw_failure', key) for key in keys])
    try:
        for key in keys:
            _write_share_pw_failure_state(key, None)
            with _share_pw_lock:
                _share_pw_failure_map.pop(key, None)
    finally:
        _release_security_state_locks(locks)

def _folder_share_password_ok(folder):
    if not folder or not folder.password_hash:
        return True
    expected_marker = _share_access_marker('folder', folder.id, folder.password_hash)
    # AUDIT FIX P10: bounded + expiring unlock markers.
    if _share_unlock_valid('unlocked_folder_shares', folder.id, expected_marker):
        return True
    password = _get_share_password()
    if password:
        # AUDIT FIX M11/P16: reject (without running the KDF) while locked out,
        # either per-IP or against the per-resource global budget.
        if not _share_pw_begin_attempt('folder', folder.id):
            return False
        if check_password_hash(folder.password_hash, password):
            _share_pw_clear('folder', folder.id)
            _remember_folder_share_access(folder)
            return True
    return False

def _folder_has_active_non_owner_share(folder, require_browsable=False, require_password=True):
    """Whether a non-owner has an ACTIVE share on this folder.

    AUDIT FIX P9 (ordering): `require_password=False` reports only whether the
    share EXISTS, leaving the caller to run the password gate itself. With the
    password folded in unconditionally, a folder that was
    (is_public=False, is_link_shared=True, is_browsable=True) + password made
    this return False until the password was supplied -- so check_folder_access
    skipped the browsable branch entirely, the ancestor lookups missed, and the
    visitor was redirected to /login instead of ever being shown the password
    prompt. That made such a share permanently unusable. Callers that do NOT run
    their own password gate must keep the default."""
    if not _folder_not_expired(folder):
        return False
    if require_browsable and not folder.is_browsable:
        return False
    if not (folder.is_public or folder.is_link_shared):
        return False
    if not require_password:
        return True
    return _folder_share_password_ok(folder)


def _validate_upload_context(registered_user, raw_folder_id, is_temp_requested, is_e2e_upload=None):
    """Validate whether an upload target is allowed for this requester."""
    folder_id = None
    if raw_folder_id and raw_folder_id != 'null':
        try:
            folder_id = int(raw_folder_id)
        except (TypeError, ValueError):
            return None, None, (jsonify({'error': 'INVALID FOLDER ID'}), 400)

    if folder_id is not None:
        if not registered_user:
            return None, None, (jsonify({'error': 'LOGIN REQUIRED TO UPLOAD INTO FOLDERS'}), 401)
        if is_temp_requested:
            return None, None, (jsonify({'error': 'TEMPORARY UPLOADS CANNOT BE STORED IN FOLDERS'}), 400)
        folder = Folder.query.filter_by(id=folder_id, user_id=registered_user.id, is_trashed=False).first()
        if not folder:
            return None, None, (jsonify({'error': 'FOLDER NOT FOUND'}), 404)
        e2e_boundary = _e2e_upload_boundary_for_folder(folder)
        if e2e_boundary and is_e2e_upload is False:
            return None, None, (jsonify({'error': 'E2EE FOLDERS REQUIRE E2EE UPLOADS'}), 400)

    if not registered_user and not is_temp_requested:
        return None, None, (jsonify({'error': 'LOGIN REQUIRED FOR PERMANENT UPLOADS'}), 401)

    return folder_id, is_temp_requested, None


def _guest_temp_storage_used_bytes(now=None):
    current_time = now or datetime.now(timezone.utc)
    guest_used = db.session.query(db.func.coalesce(db.func.sum(File.disk_size), 0)).filter(
        File.is_temp_upload == True,
        File.is_trashed == False,
        db.or_(File.expires_at.is_(None), File.expires_at > current_time)
    ).scalar() or 0
    return int(guest_used or 0)


# AUDIT FIX H4: in-flight guest-upload reservation. The authoritative global-cap
# check (under the guest_temp_cap flock at finalize) only accounts for COMMITTED
# rows in the DB, not bodies of OTHER uploads that are currently streaming to
# disk. N concurrent guest uploads therefore all read the same committed total,
# all pass, and all write their full bodies to disk before any commits — a
# transient on-disk spike of up to K x temp_max_gb regardless of the configured
# global cap. This ledger tracks bytes reserved by uploads that are still
# streaming so the start-of-request check bounds (committed + in-flight + this
# request) <= cap.
#
# AUDIT FIX (upload/download integrity): the ledger used to be a module global
# behind a threading.Lock — PROCESS-LOCAL — while the authoritative finalize
# check is flock-protected and therefore cross-process. With GUNICORN_WORKERS>1
# each worker independently admitted up to the full cap, so the exact transient
# on-disk spike this reservation exists to prevent came back multiplied by the
# worker count. The ledger now lives in a small JSON file guarded by the same
# kind of flock the finalize check uses, so reservations are consistent across
# workers. Entries carry a timestamp and are expired defensively, so a worker
# killed mid-upload cannot strand budget forever.
_GUEST_TEMP_INFLIGHT_SCOPE = 'guest_temp_inflight'
# Upper bound on how long one upload may hold a reservation. Matches the 2h
# gunicorn request timeout, past which no request can still be streaming.
_GUEST_TEMP_INFLIGHT_TTL_SECONDS = int(os.environ.get('GUEST_TEMP_INFLIGHT_TTL', str(2 * 3600)))


def _guest_temp_inflight_path():
    lock_dir = os.path.join(app.instance_path, 'locks')
    os.makedirs(lock_dir, exist_ok=True)
    return os.path.join(lock_dir, 'guest_temp_inflight.json')


def _read_guest_temp_inflight_entries():
    """Return the live (non-expired) reservation entries. Caller holds the lock."""
    path = _guest_temp_inflight_path()
    try:
        with open(path, 'r') as f:
            entries = json.load(f)
    except Exception:
        return []
    if not isinstance(entries, list):
        return []
    now = time.time()
    live = []
    for entry in entries:
        try:
            if now - float(entry.get('ts', 0)) > _GUEST_TEMP_INFLIGHT_TTL_SECONDS:
                continue
            if int(entry.get('bytes', 0)) <= 0 or not entry.get('id'):
                continue
        except (TypeError, ValueError):
            continue
        live.append(entry)
    return live


def _write_guest_temp_inflight_entries(entries):
    """Atomically persist the reservation ledger. Caller holds the lock."""
    path = _guest_temp_inflight_path()
    tmp_path = path + '.tmp'
    try:
        with open(tmp_path, 'w') as f:
            json.dump(entries, f, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception as e:
        print(f'[WARNING] Could not persist guest temp in-flight ledger: {e}')
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        # Propagate: a reservation that was never recorded must not be granted.
        raise


def _sum_guest_temp_inflight(entries):
    total = 0
    for entry in entries:
        try:
            total += int(entry.get('bytes', 0))
        except (TypeError, ValueError):
            continue
    return total


def _reserve_guest_temp_inflight(reserve_bytes, total_cap_bytes):
    """Try to reserve reserve_bytes of in-flight guest temp storage.

    Returns an opaque reservation token the caller MUST pass to
    _release_guest_temp_inflight(), or None when the cap would be exceeded."""
    reserve_bytes = int(reserve_bytes)
    if reserve_bytes <= 0:
        return None
    lock = _acquire_scoped_lock(_GUEST_TEMP_INFLIGHT_SCOPE, prefix='guest')
    try:
        entries = _read_guest_temp_inflight_entries()
        committed = _guest_temp_storage_used_bytes()
        if committed + _sum_guest_temp_inflight(entries) + reserve_bytes > int(total_cap_bytes):
            return None
        token = str(uuid.uuid4())
        entries.append({'id': token, 'bytes': reserve_bytes, 'ts': time.time()})
        _write_guest_temp_inflight_entries(entries)
        return token
    except Exception as e:
        print(f'[WARNING] Guest temp in-flight reservation failed: {e}')
        return None
    finally:
        _release_scoped_lock(lock)


def _release_guest_temp_inflight(token):
    """Release the reservation identified by token (a no-op for None)."""
    if not token:
        return
    lock = _acquire_scoped_lock(_GUEST_TEMP_INFLIGHT_SCOPE, prefix='guest')
    try:
        entries = [e for e in _read_guest_temp_inflight_entries() if e.get('id') != token]
        _write_guest_temp_inflight_entries(entries)
    except Exception as e:
        print(f'[WARNING] Could not release guest temp in-flight reservation: {e}')
    finally:
        _release_scoped_lock(lock)


def _guest_temp_remaining_bytes(total_cap_bytes):
    """Best-effort remaining guest budget = cap - committed - in-flight (>= 0)."""
    lock = _acquire_scoped_lock(_GUEST_TEMP_INFLIGHT_SCOPE, prefix='guest')
    try:
        inflight = _sum_guest_temp_inflight(_read_guest_temp_inflight_entries())
    except Exception:
        inflight = 0
    finally:
        _release_scoped_lock(lock)
    committed = _guest_temp_storage_used_bytes()
    return max(int(total_cap_bytes) - committed - inflight, 0)



