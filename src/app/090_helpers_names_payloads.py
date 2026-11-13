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

    AUDIT FIX (residual): a segment starting with a Windows drive prefix has its
    colon replaced (`C:evil` -> `C_evil`, `C:/Windows/x` -> `C_/Windows/x`), so
    it is a plain relative name on a Windows extractor instead of an
    absolute/drive-relative path, and a name such as 'S:1 report.txt' keeps its
    first letter instead of losing it -- and
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
        # by a separator, drive-relative when not). Replace the colon so the
        # whole name travels as a relative one.
        if _WINDOWS_DRIVE_RE.match(part):
            part = part[0] + '_' + part[2:]
        # '' comes from an absolute path or a doubled separator; '.' and '..'
        # are the actual traversal segments. Everything else is a real name.
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
    name = ''.join(
        ch for ch in str(name)
        if unicodedata.category(ch) != 'Cc' and ch not in '\u2028\u2029'
    ).strip()
    if not name:
        return ''
    name = name.replace('/', '_').replace('\\', '_')
    name = name.replace('..', '_')
    if len(name) <= max_length:
        return name
    # Cut the stem, not the extension: 'long….docx' must stay a .docx.
    stem, dot, ext = name.rpartition('.')
    if stem and len(ext) <= min(16, max_length - 2):
        return stem[:max_length - len(dot + ext)] + dot + ext
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
    value = str(value).strip().lower()
    if not value:
        return None
    if not re.fullmatch(r'\.?[a-z0-9]{1,10}', value):
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

def safe_served_mimetype(filename):
    """MIME type for serving user content from this origin. Only types that
    cannot run script here keep their real type; html, svg, js, css, every
    +xml flavour, ... become application/octet-stream, so an uploaded file can
    never satisfy script-src 'self' (a <script src> ignores Content-Disposition)."""
    import mimetypes
    mimetype, _ = mimetypes.guess_type(filename or '')
    if mimetype and (
        mimetype in ('application/pdf', 'text/plain')
        or mimetype.startswith(('audio/', 'video/'))
        or (mimetype.startswith('image/') and mimetype != 'image/svg+xml')
    ):
        return mimetype
    return 'application/octet-stream'

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
# static/crypto.js:encryptFileData() and client/e2ee/crypto.go:
#
#   [1 byte version][4 bytes chunk_count BE][12 bytes base nonce]  = 17 byte header
#   then exactly chunk_count records of: [4 bytes length BE][length bytes ciphertext]
#
# Each record's ciphertext is one AES-256-GCM token: <= 64 MiB of plaintext plus
# a 128-bit tag, so its length is bounded by [16, 64 MiB + 16]. An empty file
# still produces exactly one 16-byte (tag-only) chunk. The walk uses seek(), so
# validating a multi-GB container costs a handful of 4-byte reads.
#
# Every producer (crypto.js in the page or its worker, crypto.go)
# writes full 64 MiB chunks and only the LAST one may be short. Tiny chunks are
# therefore only possible in a crafted upload, where they would turn the walk
# into tens of millions of Python seek+read iterations. The declared count is
# capped as if every non-final chunk carried at least 1 MiB of plaintext.
_E2EE_FILE_FORMAT_VERSIONS = frozenset((1, 2))
_E2EE_HEADER_SIZE = 1 + 4 + 12
_E2EE_GCM_TAG_SIZE = 16
_E2EE_MAX_PLAINTEXT_CHUNK = 64 * 1024 * 1024
_E2EE_MAX_CHUNK_RECORD = _E2EE_MAX_PLAINTEXT_CHUNK + _E2EE_GCM_TAG_SIZE
_E2EE_MIN_NONFINAL_CHUNK_RECORD = 1024 * 1024 + _E2EE_GCM_TAG_SIZE


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
            # and every non-final chunk at least the 1 MiB floor above, so a
            # declared count that cannot fit is rejected before we walk anything.
            payload_size = total_size - _E2EE_HEADER_SIZE
            max_possible = min(
                payload_size // (4 + _E2EE_GCM_TAG_SIZE),
                payload_size // (4 + _E2EE_MIN_NONFINAL_CHUNK_RECORD) + 1,
            )
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
                storage._forget_local_integrity(file_path)
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
        storage._forget_local_integrity(file_path)
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
            storage._forget_local_integrity(file_path)
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
