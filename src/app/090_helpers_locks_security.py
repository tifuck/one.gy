# Global storage manager instance
storage = StorageManager(app)


def touch_folder(folder_id):
    """Update a folder's updated_at timestamp to now (UTC).
    Silently does nothing if folder_id is None or folder not found."""
    if not folder_id:
        return
    try:
        folder = db.session.get(Folder, int(folder_id))
        if folder:
            folder.updated_at = datetime.now(timezone.utc)
    except Exception as e:
        print(f'[FOLDER] Failed to update timestamp for folder {folder_id}: {e}')

def validate_encrypted_folder_name_fields(enc_name, enc_nonce, enc_key, enc_key_nonce):
    """Apply the shared structural E2EE checks to encrypted folder names."""
    if not all((enc_name, enc_nonce, enc_key, enc_key_nonce)):
        return False, 'INCOMPLETE ENCRYPTED FOLDER NAME'
    error = _e2ee_wrap_field_error((
        ('encrypted_name', enc_name, None),
        ('name_nonce', enc_nonce, 12),
        ('encrypted_name_key', enc_key, 48),
        ('name_key_nonce', enc_key_nonce, 12),
    ))
    if error:
        response, _status = error
        return False, response.get_json()['error']
    return True, None

def generate_short_code(length=8):
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    while True:
        code = "".join(secrets.choice(chars) for _ in range(length))
        if not File.query.filter_by(short_code=code).first():
            return code


# AUDIT FIX A20: generate_short_code() is a check-then-insert race -- it returns
# a candidate with no reservation, and File.short_code is unique=True. Two
# concurrent uploads that draw the same code produced an IntegrityError at
# COMMIT, and the upload route's handler rolled back and returned a generic 500
# AFTER the payload had already been written and encrypted. The correct response
# to a code collision is a new code, not a failed upload.
_SHORT_CODE_COMMIT_ATTEMPTS = 6


def _commit_with_short_code_retry(file_record):
    """Commit the session, redrawing File.short_code on a uniqueness collision.

    The code is deliberately assigned in TWO steps:

      1. Flush the row with short_code NULL. NULLs are distinct in a unique
         index, so this write can never collide.
      2. Assign the code inside a SAVEPOINT and flush again (an UPDATE). A
         collision rolls back ONLY that UPDATE, leaving the session usable, and
         we redraw and retry.

    Step 1 is what makes this work: Session.begin_nested() FLUSHES pending
    changes while taking its snapshot, so wrapping the original INSERT in a
    savepoint would run the failing INSERT *outside* the savepoint and leave the
    session in an unusable state -- exactly the 500 this fix exists to prevent.

    Once step 2's flush succeeds, this transaction holds the unique-index entry,
    so the outer COMMIT cannot collide."""
    from sqlalchemy.exc import IntegrityError as _IntegrityError
    desired_code = getattr(file_record, 'short_code', None)
    if not desired_code:
        db.session.commit()
        return
    file_record.short_code = None
    db.session.flush()
    for attempt in range(_SHORT_CODE_COMMIT_ATTEMPTS):
        savepoint = db.session.begin_nested()
        try:
            file_record.short_code = desired_code
            db.session.flush()
            savepoint.commit()
        except _IntegrityError as e:
            try:
                savepoint.rollback()
            except Exception:
                raise e
            message = str(getattr(e, 'orig', e)).lower()
            if 'short_code' not in message:
                raise
            desired_code = generate_short_code()
            print(f'[UPLOAD] Short code collision for {file_record.id}; redrew a fresh code '
                  f'(attempt {attempt + 1}/{_SHORT_CODE_COMMIT_ATTEMPTS})')
            continue
        db.session.commit()
        return
    raise RuntimeError('COULD NOT ALLOCATE A UNIQUE SHORT CODE')

# AUDIT FIX (residual zip-slip): a Windows drive prefix survives the segment
# walk above. After '\' -> '/' normalisation 'C:\evil.txt' becomes the two
# segments 'C:' + 'evil.txt', and the joined result 'C:/evil.txt' is still an
# ABSOLUTE path on Windows (and 'C:evil.txt' is drive-relative) -- extractors
# such as Explorer/7-Zip on Windows then write outside the target directory.
# Same class: Windows reserved device names ('CON', 'NUL', 'COM1', ...), which
# resolve to devices instead of files (a write can hang or corrupt a console).
_WINDOWS_DRIVE_RE = re.compile(r'^[A-Za-z]:')
_WINDOWS_RESERVED_NAMES = frozenset(
    ['con', 'prn', 'aux', 'nul']
    + [f'com{i}' for i in range(1, 10)]
    + [f'lpt{i}' for i in range(1, 10)]
)


def safe_zip_entry_name(name):
    """Sanitize a filename/folder name before using it as a ZIP entry path component.

    Neutralises traversal (`..`, absolute paths, backslash separators, NUL) so
    that extracting the ZIP cannot write outside the target directory. Returns a
    non-empty string or 'unnamed'.

    AUDIT FIX P3: this used to `lstrip('.')` EVERY segment, which is not
    traversal neutralisation -- it silently renamed every legitimate dotfile
    (`.env` -> `env`, `.gitignore` -> `gitignore`, `.ssh/config` ->
    `ssh/config`), handing recipients files that no longer work, and collapsed
    any dot-only name to 'unnamed' so several distinct entries collided into one.
    A leading dot is NOT a traversal; only the segments `.` and `..` are.

    AUDIT FIX (residual): each segment additionally has any Windows drive prefix
    (`C:`) stripped -- 'C:/Windows/x' and 'C:evil' both become plain relative
    names instead of absolute/drive-relative paths on a Windows extractor -- and
    Windows reserved device names (CON, NUL, AUX, PRN, COM1-9, LPT1-9, with or
    without an extension) are rewritten with a leading underscore so the entry
    can never resolve to a device. Ordinary Unix/Windows file names are
    byte-for-byte unchanged."""
    if not name:
        return 'unnamed'
    name = str(name)
    # Normalise separators to forward-slash only, then drop NUL and other
    # control characters (a NUL truncates the path in some extractors and
    # CR/LF corrupt archive listings). '/' is kept as the segment separator.
    name = name.replace('\\', '/')
    name = ''.join(ch for ch in name if ch == '/' or ord(ch) >= 32)
    parts = []
    for part in name.split('/'):
        part = part.strip()
        # 'C:...' is a Windows drive prefix (absolute when it ends up followed
        # by a separator, drive-relative when not). Strip it so only the
        # remainder travels as a relative name.
        # Loop: stripping 'C:' from 'C:C:x' would otherwise expose a new prefix.
        while _WINDOWS_DRIVE_RE.match(part):
            part = part[2:].lstrip('/')
        # '' comes from an absolute path, a doubled separator or a bare 'C:';
        # '.' and '..' are the actual traversal segments. Everything else is a
        # real name.
        if not part or part == '.' or part == '..':
            continue
        # Windows reserved device names apply to the basename with or without
        # an extension ('CON' and 'CON.txt' both resolve to the console).
        base_name = part.split('.', 1)[0].rstrip(' ')
        if base_name.lower() in _WINDOWS_RESERVED_NAMES:
            part = '_' + part
        parts.append(part)
    return '/'.join(parts) if parts else 'unnamed'

def _unique_zip_entry_name(name, used_names):
    """Return an archive member name that has not been used yet, recording it.

    AUDIT FIX P4: neither File.orig_name nor Folder.name is unique, so two
    members of one archive can legitimately compute the SAME arcname. zipfile
    only emits a UserWarning and writes BOTH, and extraction keeps whichever
    landed last -- files vanished from the archive while the response was a
    clean 200 with nothing in the log, the X-Incomplete-Archive header, or
    _DOWNLOAD_ERRORS.txt. Duplicates now get a ' (1)', ' (2)', ... suffix
    inserted before the extension.

    Matching is case-insensitive on purpose: the recipient may extract onto a
    case-insensitive filesystem, where 'README' and 'readme' shadow each other
    just as badly."""
    candidate = name or 'unnamed'
    if used_names is None:
        return candidate
    # A file and a directory cannot share a path either: rename any directory
    # segment that an earlier FILE member already owns (deterministically, so
    # every member under it lands in the same renamed directory).
    parts = candidate.split('/')
    for i in range(len(parts) - 1):
        if '/'.join(parts[:i + 1]).lower() in used_names:
            segment = parts[i]
            parts[i] = f'{segment} (folder)'
            n = 2
            # The replacement may itself be an existing file member.
            while '/'.join(parts[:i + 1]).lower() in used_names:
                parts[i] = f'{segment} (folder {n})'
                n += 1
    candidate = '/'.join(parts)

    def _taken(member):
        return member.lower() in used_names or member.lower() + '/' in used_names

    def _record(member):
        used_names.add(member.lower())
        segs = member.split('/')
        for i in range(1, len(segs)):
            used_names.add('/'.join(segs[:i]).lower() + '/')

    if not _taken(candidate):
        _record(candidate)
        return candidate
    directory, _, base = candidate.rpartition('/')
    stem, dot, ext = base.partition('.')
    if not stem:
        # Dotfile such as '.env': there is no stem to suffix, so treat the whole
        # segment as the stem rather than mangling the leading dot.
        stem, dot, ext = base, '', ''
    counter = 1
    while counter <= 100000:
        new_base = f'{stem} ({counter}){dot}{ext}'
        new_name = f'{directory}/{new_base}' if directory else new_base
        if not _taken(new_name):
            _record(new_name)
            print(f'[ZIP] Duplicate archive entry "{candidate}" written as "{new_name}"')
            return new_name
        counter += 1
    fallback = f'{directory}/{uuid.uuid4().hex}_{base}' if directory else f'{uuid.uuid4().hex}_{base}'
    _record(fallback)
    print(f'[WARNING] Could not de-duplicate archive entry "{candidate}"; using "{fallback}"')
    return fallback

def sanitize_plaintext_name(name, max_length=255):
    """Sanitize a user-visible file/folder name without destroying Unicode."""
    if name is None:
        return ''
    name = str(name).strip()
    if not name:
        return ''
    name = name.replace('/', '_').replace('\\', '_')
    name = name.replace('..', '_')
    name = name.replace('\x00', '')
    return name[:max_length]


def _normalize_plaintext_folder_name(name):
    """Canonical comparison key for visible sibling names only."""
    return unicodedata.normalize('NFKC', str(name or '')).strip().casefold()


def build_safe_browse_path(path_prefix, name):
    safe_prefix = safe_zip_entry_name(path_prefix) if path_prefix else ''
    safe_name = safe_zip_entry_name(name)
    if safe_prefix:
        return f'{safe_prefix}/{safe_name}'
    return safe_name

def normalize_stored_extension(value):
    if not value:
        return None
    value = str(value).strip()
    if not value:
        return None
    if not re.fullmatch(r'\.?[A-Za-z0-9]{1,16}', value):
        return None
    return value if value.startswith('.') else f'.{value}'

def safe_content_disposition(disposition, filename):
    """Build a safe Content-Disposition header using RFC 6266 encoding.
    Sanitizes the ASCII fallback and adds a UTF-8 filename* parameter."""
    # ASCII fallback: replace any characters that could break the header
    ascii_name = filename.encode('ascii', 'replace').decode('ascii')
    ascii_name = ascii_name.replace('"', '_').replace('\\', '_').replace('\r', '').replace('\n', '')
    # RFC 5987 UTF-8 encoded filename
    utf8_name = urllib.parse.quote(filename, safe='')
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}"

def escape_like_pattern(value):
    if value is None:
        return ''
    value = str(value)
    return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def _note_content_checksum(content):
    """Return the SHA-256 hex digest for encrypted note content text."""
    if content is None:
        content = ''
    if isinstance(content, bytes):
        payload = content
    else:
        payload = str(content).encode('utf-8')
    return hashlib.sha256(payload).hexdigest()

# ────────────────────────────────────────────────────────────────────
# AUDIT FIX (upload/download integrity): client-side E2EE container validation
# ────────────────────────────────────────────────────────────────────
# /f/<id>/make-private accepts an opaque blob from the client and then uses the
# staged-commit machinery to atomically REPLACE the file's Fernet ciphertext --
# destroying the only copy the server can decrypt. There was no validation at
# all: a 0-byte body, a truncated encrypt, or an aborted client-side crypto pass
# silently and irreversibly replaced the user's file with garbage.
#
# The server cannot decrypt an E2EE container (that is the whole point), so this
# is STRUCTURAL validation only, matching the on-disk format produced by
# static/crypto.js:encryptFileData() and cli_E2EE_binary/crypto.go:
#
#   [1 byte version][4 bytes chunk_count BE][12 bytes base nonce]  = 17 byte header
#   then exactly chunk_count records of: [4 bytes length BE][length bytes ciphertext]
#
# Each record's ciphertext is one AES-256-GCM token: <= 64 MiB of plaintext plus
# a 128-bit tag, so its length is bounded by [16, 64 MiB + 16]. An empty file
# still produces exactly one 16-byte (tag-only) chunk. The walk uses seek(), so
# validating a multi-GB container costs a handful of 4-byte reads.
_E2EE_FILE_FORMAT_VERSIONS = frozenset((1, 2))
_E2EE_HEADER_SIZE = 1 + 4 + 12
_E2EE_GCM_TAG_SIZE = 16
_E2EE_MAX_PLAINTEXT_CHUNK = 64 * 1024 * 1024
_E2EE_MAX_CHUNK_RECORD = _E2EE_MAX_PLAINTEXT_CHUNK + _E2EE_GCM_TAG_SIZE


def validate_e2ee_container(path):
    """Structurally validate a client-encrypted E2EE container on disk.

    Returns (True, None) when the framing is complete and self-consistent, or
    (False, 'REASON') otherwise. NEVER decrypts -- the server holds no key."""
    try:
        total_size = os.path.getsize(path)
    except OSError as e:
        return False, f'UNREADABLE UPLOAD ({e.errno})'

    if total_size < _E2EE_HEADER_SIZE:
        return False, f'TOO SHORT FOR AN ENCRYPTED CONTAINER ({total_size} BYTES)'

    try:
        with open(path, 'rb') as f:
            header = f.read(_E2EE_HEADER_SIZE)
            if len(header) != _E2EE_HEADER_SIZE:
                return False, 'TRUNCATED CONTAINER HEADER'
            version = header[0]
            if version not in _E2EE_FILE_FORMAT_VERSIONS:
                return False, f'UNSUPPORTED CONTAINER VERSION {version}'
            chunk_count = int.from_bytes(header[1:5], 'big')
            if chunk_count < 1:
                return False, 'CONTAINER DECLARES ZERO CHUNKS'
            # Every chunk costs at least 4 (length prefix) + 16 (GCM tag) bytes,
            # so a declared count that cannot physically fit is rejected before
            # we walk anything.
            max_possible = (total_size - _E2EE_HEADER_SIZE) // (4 + _E2EE_GCM_TAG_SIZE)
            if chunk_count > max_possible:
                return False, (f'CONTAINER DECLARES {chunk_count} CHUNKS BUT ONLY '
                               f'{max_possible} CAN FIT IN {total_size} BYTES')

            offset = _E2EE_HEADER_SIZE
            for index in range(chunk_count):
                f.seek(offset)
                length_bytes = f.read(4)
                if len(length_bytes) != 4:
                    return False, f'TRUNCATED LENGTH PREFIX AT CHUNK {index}'
                chunk_len = int.from_bytes(length_bytes, 'big')
                if chunk_len < _E2EE_GCM_TAG_SIZE:
                    return False, f'CHUNK {index} IS SHORTER THAN THE GCM TAG ({chunk_len} BYTES)'
                if chunk_len > _E2EE_MAX_CHUNK_RECORD:
                    return False, f'CHUNK {index} LENGTH {chunk_len} EXCEEDS THE FORMAT MAXIMUM'
                offset += 4 + chunk_len
                if offset > total_size:
                    return False, (f'CHUNK {index} RUNS PAST END OF UPLOAD '
                                   f'(NEEDS {offset} BYTES, HAVE {total_size})')
            if offset != total_size:
                return False, (f'{total_size - offset} TRAILING BYTES AFTER THE DECLARED '
                               f'{chunk_count} CHUNK(S)')
    except OSError as e:
        return False, f'UNREADABLE UPLOAD ({e})'
    return True, None


# AUDIT FIX (upload/download integrity): encrypted-thumbnail parts were read
# with a bare `part.read()` and only THEN length-checked, so an oversized part
# was fully materialised in the worker heap before being rejected -- on a route
# with no request cap (make-private) that is an OOM kill that aborts every other
# in-flight upload and download on the worker. Read one byte past the limit so an
# oversized part is detected without ever being fully materialised.
_MAX_ENCRYPTED_THUMBNAIL_BYTES = 512 * 1024


def read_bounded_upload_part(part, max_bytes):
    """Read at most max_bytes from a multipart part.

    Returns (data, oversized). When the part is larger than max_bytes, returns
    (None, True) without materialising the rest of it."""
    if part is None:
        return None, False
    data = part.read(max_bytes + 1)
    if data is None:
        return None, False
    if len(data) > max_bytes:
        return None, True
    return data, False


def _log_payload_corruption(file_id, kind, expected_checksum, actual_checksum, expected_size=None, actual_size=None, source_path=None):
    """Log a payload-corruption event with enough detail for forensic follow-up.

    Used by download/serve paths when a checksum or disk-size mismatch is
    detected against the value recorded at upload time. AUDIT Tier 0 #1.
    """
    suffix = ''
    if expected_size is not None and actual_size is not None and expected_size != actual_size:
        suffix = f' size_expected={expected_size} size_actual={actual_size}'
    if source_path:
        suffix += f' path={source_path}'
    print(
        f'[ERROR] Payload {kind} corruption detected for file {file_id!r}: '
        f'expected_sha256={expected_checksum} actual_sha256={actual_checksum}{suffix}'
    )

def _iter_file_chunks(file_path, chunk_size=64 * 1024 * 1024,
                     expected_checksum=None, expected_size=None,
                     file_id=None, corruption_kind='payload'):
    """Yield file data in large chunks without buffering the whole file.

    If expected_size is provided, pre-check the file size against it and
    raise ValueError on mismatch BEFORE streaming any bytes (cheap up-front
    truncation detection).

    If expected_checksum is provided, accumulate SHA-256 of the bytes being
    read from disk and raise ValueError when the totals don't match. The last
    chunk is held back until the hash matches so a mismatch cannot present as
    a complete body (same last-chunk holdback as decrypt_file_chunked).
    See AUDIT Tier 0 #1.
    """
    hasher = hashlib.sha256() if expected_checksum else None
    read_size = (1024 * 1024) if hasher is not None else chunk_size
    # AUDIT FIX (5th audit, validation/open TOCTOU): open the file FIRST, then
    # size-check the OPEN descriptor via fstat. Previously the size pre-check used
    # os.path.getsize(path) and THEN open(path) as two separate path resolutions;
    # a concurrent os.replace() (e.g. a staged rewrite finalizing) between them
    # could let us validate one inode but stream a different one. Opening first
    # and fstat'ing the same fd makes the size check and the streamed bytes refer
    # to the exact same inode, so whatever we serve is what we verified.
    try:
        f = open(file_path, 'rb')
    except OSError as e:
        raise FileNotFoundError(f'File not found for streaming: {file_path}') from e
    total_bytes = 0
    held_back_chunk = None
    try:
        if expected_size is not None:
            actual_size = os.fstat(f.fileno()).st_size
            if actual_size != expected_size:
                _log_payload_corruption(
                    file_id, corruption_kind, expected_checksum or '(none)', '(none)',
                    expected_size=expected_size, actual_size=actual_size, source_path=file_path,
                )
                raise ValueError(
                    f'Disk size mismatch for file {file_id!r}: '
                    f'expected {expected_size} bytes, found {actual_size}'
                )
        try:
            while True:
                chunk = f.read(read_size)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if hasher is not None:
                    hasher.update(chunk)
                    if held_back_chunk is not None:
                        yield held_back_chunk
                    held_back_chunk = chunk
                else:
                    yield chunk
        except OSError as _ose:
            # AUDIT FIX P1-12 / 5th audit: the file may have been deleted or become
            # unreadable mid-stream (e.g. cleanup_expired_files racing the stream).
            # Previously this was swallowed and the generator returned NORMALLY, so
            # _build_streaming_response() set stream_completed=True and ran on_success
            # — incrementing/confirming a download count (and, for max_downloads
            # files, even DELETING the file) for a TRUNCATED response. Re-raise so
            # the stream is treated as incomplete (on_success skipped, count rolled
            # back). This is raised from inside the response generator, exactly like
            # the existing checksum-mismatch raise below, so the WSGI server handles
            # it without crashing the worker.
            print(f'[DOWNLOAD] File vanished/unreadable mid-stream ({file_id}): {_ose}')
            raise IOError(f'Stream aborted mid-transfer for file {file_id!r}: {_ose}') from _ose
    finally:
        try:
            f.close()
        except Exception:
            pass
    if expected_size is not None and total_bytes != expected_size:
        _log_payload_corruption(
            file_id, corruption_kind, expected_checksum or '(none)', '(none)',
            expected_size=expected_size, actual_size=total_bytes, source_path=file_path,
        )
        raise ValueError(
            f'Streamed size mismatch for file {file_id!r}: '
            f'expected {expected_size} bytes, read {total_bytes}'
        )
    if hasher is not None:
        actual_checksum = hasher.hexdigest()
        if actual_checksum != expected_checksum:
            _log_payload_corruption(
                file_id, corruption_kind, expected_checksum, actual_checksum,
                source_path=file_path,
            )
            raise ValueError(
                f'Payload checksum mismatch for file {file_id!r}: '
                f'expected {expected_checksum}, got {actual_checksum}'
            )
        if held_back_chunk is not None:
            yield held_back_chunk
def _iter_open_file_chunks(handle, chunk_size=64 * 1024 * 1024):
    """Stream an ALREADY-OPEN file handle in large chunks, then close it.

    AUDIT FIX (upload/download integrity): used by the prepared-download path so
    the decrypted plaintext is pinned by an open descriptor for the whole
    response. _iter_file_chunks() re-opens by PATH on the first lazy pull, which
    happens after the 200 + Content-Length headers are already on the wire, so a
    reaper unlinking the file in that window produced a truncated 200. An open
    fd cannot be truncated by unlink -- POSIX keeps the inode alive until the
    last descriptor closes."""
    try:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            yield chunk
    except OSError as e:
        # Mirror _iter_file_chunks: re-raise so the stream counts as INCOMPLETE
        # and on_success/download-count confirmation is skipped.
        print(f'[DOWNLOAD] Prepared plaintext became unreadable mid-stream: {e}')
        raise IOError(f'Stream aborted mid-transfer: {e}') from e
    finally:
        try:
            handle.close()
        except Exception:
            pass


def _release_sent_pending_notes(user_id):
    """Detach still-pending notes SENT by a user whose account is being deleted.

    AUDIT FIX D13: account deletion used to run
    `PendingNote.query.filter(or_(recipient_id == uid, sender_id == uid)).delete()`,
    silently destroying every note the user had sent that the recipient had not
    accepted yet -- content the RECIPIENT owns (it is wrapped with the
    recipient's RSA public key and cannot even be read by the sender any more).
    The payload is preserved here; only the sender attribution is dropped.
    sender_id is NOT NULL with a FK to user.id, so it is repointed at the
    recipient (the row's real owner) and flagged with sender_deleted so it never
    counts against that recipient's outgoing-note quota."""
    try:
        sent = PendingNote.query.filter(
            PendingNote.sender_id == user_id,
            PendingNote.recipient_id != user_id,
        ).all()
        for pending in sent:
            pending.sender_id = pending.recipient_id
            pending.sender_deleted = True
            original_sender = (pending.sender_username or 'UNKNOWN')[:139]
            if not original_sender.endswith('(deleted)'):
                pending.sender_username = f'{original_sender} (deleted)'
        if sent:
            # Flush now so the sender_id re-point is written BEFORE the User row
            # is deleted -- pending_note.sender_id carries a FK to user.id.
            db.session.flush()
            print(f'[NOTES] Preserved {len(sent)} pending note(s) sent by deleted user {user_id} for their recipients')
        return len(sent)
    except Exception as e:
        print(f'[ERROR] Failed to preserve pending notes sent by user {user_id}: {e}')
        raise

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

    Keep this lock around the final eligibility recheck and metadata commit only.
    Upload parsing, encryption, payload publication, and post-commit local purge
    must happen outside it.
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


# Small host-local authority for security state that must be coherent across
# Gunicorn workers. State and lock names are hashes, so attacker-controlled keys
# cannot escape the directory or create oversized filenames. Every key has its
# own flock: unrelated users/nonces/resources do not serialize behind one global
# lock. Atomic replace keeps readers from observing partial JSON after a crash.
_SECURITY_STATE_MAX_BYTES = 64 * 1024
_SECURITY_STATE_CLEANUP_MAX_PER_PASS = 4000


def _security_state_dir():
    state_dir = os.path.join(app.instance_path, 'security_state')
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    return state_dir


def _security_state_identity(namespace, key):
    raw = f'{namespace}\0{key}'.encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def _security_state_path(namespace, key):
    digest = _security_state_identity(namespace, key)
    return os.path.join(_security_state_dir(), f'{namespace}--{digest}.json')


def _acquire_security_state_locks(items):
    """Acquire per-key locks in stable order and return them for finally-release."""
    identities = sorted({
        (str(namespace), _security_state_identity(namespace, key))
        for namespace, key in items
    })
    locks = []
    try:
        for namespace, digest in identities:
            locks.append(_acquire_scoped_lock(
                f'{namespace}:{digest}', prefix='security'))
        return locks
    except Exception:
        for lock_file in reversed(locks):
            _release_scoped_lock(lock_file)
        raise


def _release_security_state_locks(locks):
    for lock_file in reversed(locks or []):
        _release_scoped_lock(lock_file)


def _read_security_state_path(path):
    try:
        with open(path, 'rb') as state_file:
            payload = state_file.read(_SECURITY_STATE_MAX_BYTES + 1)
    except FileNotFoundError:
        return {}
    if len(payload) > _SECURITY_STATE_MAX_BYTES:
        raise RuntimeError(f'Oversized security state file: {os.path.basename(path)}')
    try:
        state = json.loads(payload.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise RuntimeError(f'Invalid security state file: {os.path.basename(path)}') from e
    if not isinstance(state, dict):
        raise RuntimeError(f'Invalid security state object: {os.path.basename(path)}')
    return state


def _read_security_state(namespace, key):
    """Read one state object. Caller must hold its security-state lock."""
    return _read_security_state_path(_security_state_path(namespace, key))


def _write_security_state(namespace, key, state):
    """Atomically replace or remove one state object under its held lock."""
    path = _security_state_path(namespace, key)
    if not state:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return
    payload = json.dumps(state, separators=(',', ':'), sort_keys=True).encode('utf-8')
    if len(payload) > _SECURITY_STATE_MAX_BYTES:
        raise RuntimeError(f'Security state exceeds {_SECURITY_STATE_MAX_BYTES} bytes')
    fd, temp_path = tempfile.mkstemp(prefix='.security-', dir=_security_state_dir())
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as state_file:
            fd = None
            state_file.write(payload)
            state_file.flush()
        os.replace(temp_path, path)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass


def _security_state_fresh(state, now):
    try:
        return float(state.get('retain_until', 0)) > now
    except (TypeError, ValueError):
        return False

