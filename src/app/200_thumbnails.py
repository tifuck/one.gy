def _send_cached_thumbnail(thumb_bytes):
    """Serve thumbnail bytes with HTTP caching headers (ETag + Cache-Control).
    Returns 304 Not Modified if the client already has the current version."""
    etag = '"' + hashlib.md5(thumb_bytes).hexdigest() + '"'
    if request.if_none_match and etag.strip('"') in request.if_none_match:
        resp = make_response('', 304)
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = f'private, max-age={THUMBNAIL_CACHE_MAX_AGE}'
        return resp
    resp = make_response(send_file(io.BytesIO(thumb_bytes), mimetype='image/jpeg'))
    resp.headers['Cache-Control'] = f'private, max-age={THUMBNAIL_CACHE_MAX_AGE}'
    resp.headers['ETag'] = etag
    return resp

def _thumbnail_path(file_id, is_e2e=False):
    """Return the disk path for a thumbnail file. Delegates to storage manager."""
    return storage.get_thumbnail_path(file_id, is_e2e)

def save_thumbnail_to_disk(file_id, data, is_e2e=False):
    """Write thumbnail bytes. Delegates to storage manager."""
    return storage.save_thumbnail(file_id, data, is_e2e)

def load_thumbnail_from_disk(file_id, is_e2e=False):
    """Read thumbnail bytes. Delegates to storage manager."""
    return storage.load_thumbnail(file_id, is_e2e)

def delete_thumbnail_from_disk(file_id):
    """Remove thumbnail files. Delegates to storage manager."""
    storage.delete_thumbnail(file_id)


def _prepare_staged_rewrite_commit(file_obj, meta):
    """Write .meta and reset remotes before the checksum commit. No commit."""
    if not storage.write_staged_file_metadata(file_obj.filename, meta):
        storage.rollback_staged_file(file_obj.filename)
        return jsonify({'error': 'COULD NOT PERSIST STAGED FILE METADATA'}), 500
    storage._reset_remote_file_replicas_pending(file_obj.id)
    return None


def _commit_file_post_finalize_state(file_id, action_label):
    """Persist file replica requeue after a staged local swap succeeds."""
    try:
        storage.queue_file_replication(file_id, verified_at=datetime.now(timezone.utc))
        db.session.commit()
    except Exception as e:
        try:
            db.session.rollback()
        except Exception:
            pass
        print(f'[FILE] Warning: {action_label} for {file_id} saved locally but post-finalize replication commit failed: {e}')

def preload_e2e_thumbnails(files):
    """Pre-load E2EE thumbnail data from disk for template rendering.
    Sets file._thumb_b64 (base64 string) on each file that has an E2EE thumbnail."""
    for f in files:
        f._thumb_b64 = None
        if f.is_e2e_encrypted and f.has_thumbnail and f.encrypted_thumbnail_nonce:
            data = load_thumbnail_from_disk(f.id, is_e2e=True)
            if data:
                f._thumb_b64 = base64.b64encode(data).decode('ascii')

@app.route('/file/<file_id>/e2e-thumbnail')
@limiter.limit(thumbnail_rate_limit, deduct_when=_count_uncached_thumbnail)
def file_e2e_thumbnail(file_id):
    """Serve raw encrypted E2EE thumbnail bytes for client-side decryption.
    Returns the encrypted thumbnail as application/octet-stream with HTTP caching."""
    file = None

    # Logged-in user: check files owned by this user
    if 'logged_in_user_id' in session:
        user = _current_session_user()
        if user:
            file = File.query.filter_by(id=file_id, registered_user_id=user.id).first()

    # Guest: check temp uploads owned by this guest session
    if not file and 'user_id' in session:
        file = File.query.filter_by(id=file_id, user_id=session['user_id'], registered_user_id=None, is_temp_upload=True).first()

    # Cookie-based: check temp uploads owned by this manager cookie
    if not file:
        manager_cookie = request.cookies.get('onegy_manager')
        if manager_cookie:
            file = File.query.filter_by(id=file_id, manager_cookie_id=manager_cookie, registered_user_id=None, is_temp_upload=True).first()

    if not file:
        abort(404)

    # Only serve E2EE thumbnails through this endpoint
    if not file.is_e2e_encrypted:
        abort(404)

    if not file.has_thumbnail or not file.encrypted_thumbnail_nonce:
        abort(404)

    thumb_bytes = load_thumbnail_from_disk(file.id, is_e2e=True)
    if not thumb_bytes:
        abort(404)

    # Serve raw encrypted bytes with HTTP caching (ETag + Cache-Control)
    etag = '"e2e-' + hashlib.md5(thumb_bytes).hexdigest() + '"'
    if request.if_none_match and etag.strip('"') in request.if_none_match:
        resp = make_response('', 304)
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = f'private, max-age={THUMBNAIL_CACHE_MAX_AGE}'
        return resp
    resp = make_response(send_file(io.BytesIO(thumb_bytes), mimetype='application/octet-stream'))
    resp.headers['Cache-Control'] = f'private, max-age={THUMBNAIL_CACHE_MAX_AGE}'
    resp.headers['ETag'] = etag
    return resp

@app.route('/file/<file_id>/thumbnail')
@limiter.limit(thumbnail_rate_limit, deduct_when=_count_uncached_thumbnail)
def file_thumbnail(file_id):
    """Serve thumbnail for a file (logged-in users see their files, guests see their temp uploads)"""
    # Validate the URL parameter before it reaches the storage layer. A real
    # file_id is always a UUID; a malformed value (e.g. a crawler following an
    # un-interpolated `${data.id}` template literal) can never match a real row,
    # so reject it with a clean 404 instead of letting _validate_storage_file_id
    # raise an uncaught ValueError -> 500.
    try:
        _validate_storage_file_id(file_id)
    except ValueError:
        abort(404)
    # Fast-path: check local storage to skip remote probes for files without thumbnails
    _thumb_id = f'{file_id}.jpg'
    _local_exists = storage._local_backend.exists('thumbnails', _thumb_id)
    if not _local_exists:
        _cache_path = os.path.join(THUMBNAILS_DIR, f'.cache_{_thumb_id}')
        _local_exists = os.path.isfile(_cache_path)

    file = None
    
    # Logged-in user: check files owned by this user
    if 'logged_in_user_id' in session:
        user = _current_session_user()
        if user:
            file = File.query.filter_by(id=file_id, registered_user_id=user.id).first()
    
    # Guest: check temp uploads owned by this guest session
    if not file and 'user_id' in session:
        file = File.query.filter_by(id=file_id, user_id=session['user_id'], registered_user_id=None, is_temp_upload=True).first()
    
    # Cookie-based: check temp uploads owned by this manager cookie
    if not file:
        manager_cookie = request.cookies.get('onegy_manager')
        if manager_cookie:
            file = File.query.filter_by(id=file_id, manager_cookie_id=manager_cookie, registered_user_id=None, is_temp_upload=True).first()
    
    if not file:
        abort(404)
    
    # E2E files: no server-side thumbnails (zero-knowledge)
    if file.is_e2e_encrypted:
        abort(404)

    # Serve an existing thumbnail (local or remote). The old early-return when
    # has_thumbnail was False skipped BOTH remote probes AND on-demand
    # generation, so a Fernet txt/image/video whose background render lost the
    # semaphore (or whose flag was never healed) stayed icon-only forever.
    if _local_exists or file.has_thumbnail:
        thumb_bytes = load_thumbnail_from_disk(file.id, is_e2e=False)
        if thumb_bytes:
            _heal_has_thumbnail_flag(file)
            return _send_cached_thumbnail(thumb_bytes)

    # Fill: generate on first view for previewable Fernet files.
    if not file.is_trashed and _is_thumbnailable_name(file.orig_name):
        generate_thumbnail(file, wait=False)
        thumb_bytes = load_thumbnail_from_disk(file.id, is_e2e=False)
        if thumb_bytes:
            return _send_cached_thumbnail(thumb_bytes)

    abort(404)

# AUDIT FIX A18: bound the cost of thumbnail generation.
#   * Video thumbnails used to write a FULL plaintext copy of the whole video to
#     a temp dir before invoking ffmpeg, with no size cap ("ffmpeg only reads a
#     few frames" was true of ffmpeg, not of the decrypt that fed it), no disk
#     check and no thread pool -- N concurrent multi-GB video uploads each spawn
#     a daemon thread writing a full copy and can fill the filesystem that also
#     hosts MariaDB.
#   * ffmpeg only needs the head of the container to grab an early frame, so we
#     materialise a bounded prefix first and only fall back to a full copy for
#     files small enough to be harmless (some MOV/MP4 files keep the moov atom at
#     the end and cannot be decoded from a prefix).
VIDEO_THUMB_HEAD_BYTES = 64 * 1024 * 1024
VIDEO_THUMB_FULL_MAX_BYTES = 512 * 1024 * 1024
THUMBNAIL_DISK_FREE_RESERVE_BYTES = 2 * 1024 * 1024 * 1024
THUMBNAIL_MAX_CONCURRENT = 2
THUMBNAIL_SLOT_TIMEOUT_SECONDS = 30.0
THUMBNAIL_SAME_FILE_WAIT_SECONDS = 1.0
_THUMBNAIL_SEMAPHORE = threading.BoundedSemaphore(THUMBNAIL_MAX_CONCURRENT)

# AUDIT FIX A18: 'svg' is NOT in the image set. Pillow cannot decode SVG, so
# every SVG upload used to burn a full decrypt plus a thread on a guaranteed
# UnidentifiedImageError that was then swallowed by the outer handler.
_THUMB_IMAGE_EXTS = frozenset({'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'})
_THUMB_TEXT_EXTS = frozenset({
    'txt', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'py', 'js', 'html',
    'css', 'sh', 'bat', 'ini', 'cfg', 'conf', 'c', 'cpp', 'h', 'hpp', 'lua',
    'rb', 'rs', 'go', 'java', 'ts', 'tsx', 'jsx', 'toml', 'ps1', 'sql', 'r',
    'swift', 'kt', 'php', 'pl', 'diff', 'makefile', 'env',
})
_THUMB_VIDEO_EXTS = frozenset({
    'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v', '3gp',
})


def _is_dotenv_filename(filename):
    """True for .env, .env.local, production.env, etc."""
    base = os.path.basename(filename or '').lower()
    return base == '.env' or base.startswith('.env.') or _get_compound_ext(base) == 'env'


def _is_thumbnailable_name(filename):
    ext = _get_compound_ext(filename or '')
    return (
        ext in _THUMB_IMAGE_EXTS
        or ext in _THUMB_TEXT_EXTS
        or ext in _THUMB_VIDEO_EXTS
        or _is_dotenv_filename(filename)
    )


app.jinja_env.globals['is_thumbnailable_name'] = _is_thumbnailable_name


_THUMBNAIL_BG_PENDING = set()
_THUMBNAIL_BG_LOCK = threading.Lock()
# Counts both queued and currently running background renders in this worker.
THUMBNAIL_BG_PENDING_LIMIT = 32
_THUMBNAIL_BG_QUEUE = queue.Queue(maxsize=THUMBNAIL_BG_PENDING_LIMIT)
_THUMBNAIL_BG_WORKERS = []


def _run_thumbnail_bg(file_id):
    with app.app_context():
        file_record = db.session.get(File, file_id)
        if file_record and not file_record.is_e2e_encrypted and not file_record.is_trashed:
            generate_thumbnail(file_record, wait=True)


def _thumbnail_bg_worker(work_queue):
    while True:
        task = work_queue.get()
        if task is None:
            work_queue.task_done()
            return
        file_id, log_prefix = task
        try:
            _run_thumbnail_bg(file_id)
        except Exception as e:
            print(f'[{log_prefix}] Background thumbnail failed for {file_id}: {e}')
        finally:
            with _THUMBNAIL_BG_LOCK:
                _THUMBNAIL_BG_PENDING.discard(file_id)
            work_queue.task_done()


def _start_thumbnail_bg_workers():
    # This queue and its cap are intentionally per process (one pool per Gunicorn
    # worker). Cross-process rendering of the same file remains coalesced by the
    # existing thumbnail generation flock, which is not held while work waits.
    for index in range(THUMBNAIL_MAX_CONCURRENT):
        worker = threading.Thread(
            target=_thumbnail_bg_worker,
            args=(_THUMBNAIL_BG_QUEUE,),
            name=f'thumbnail-bg-{index + 1}',
            daemon=True,
        )
        worker.start()
        _THUMBNAIL_BG_WORKERS.append(worker)


def _schedule_thumbnail_bg(file_id, log_prefix='THUMBNAIL'):
    """Admit a render without blocking; a full per-worker queue retries on a later request."""
    if not file_id:
        return False
    with _THUMBNAIL_BG_LOCK:
        if file_id in _THUMBNAIL_BG_PENDING:
            return True
        if len(_THUMBNAIL_BG_PENDING) >= THUMBNAIL_BG_PENDING_LIMIT:
            print(f'[{log_prefix}] Background thumbnail queue full; skipping {file_id} '
                  '(a later request can retry)')
            return False
        _THUMBNAIL_BG_PENDING.add(file_id)
        try:
            _THUMBNAIL_BG_QUEUE.put_nowait((file_id, log_prefix))
        except queue.Full:
            _THUMBNAIL_BG_PENDING.discard(file_id)
            print(f'[{log_prefix}] Background thumbnail queue full; skipping {file_id} '
                  '(a later request can retry)')
            return False
        except Exception:
            _THUMBNAIL_BG_PENDING.discard(file_id)
            raise
    return True


_start_thumbnail_bg_workers()


def _heal_has_thumbnail_flag(file_record):
    """Set has_thumbnail when we just served bytes for a file whose flag was stale."""
    if file_record is None or file_record.has_thumbnail:
        return
    try:
        file_record.has_thumbnail = True
        db.session.commit()
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass


def _thumbnail_disk_space_ok(target_dir, needed_bytes):
    """True when writing needed_bytes into target_dir keeps a safety reserve free.

    Fails CLOSED (no thumbnail) when the free space cannot be determined -- a
    missing thumbnail is cosmetic, a full filesystem takes the database down."""
    try:
        usage = shutil.disk_usage(target_dir)
    except Exception as e:
        print(f'[THUMBNAIL] Could not determine free space for {target_dir}: {e}')
        return False
    if usage.free < (int(needed_bytes) + THUMBNAIL_DISK_FREE_RESERVE_BYTES):
        print(f'[WARNING] [THUMBNAIL] Skipping thumbnail: only {usage.free} bytes free, need '
              f'{int(needed_bytes)} plus a {THUMBNAIL_DISK_FREE_RESERVE_BYTES} byte reserve')
        return False
    return True


def _write_decrypted_prefix(encrypted_path, output_path, max_bytes=None):
    """Decrypt into output_path, stopping after max_bytes (None = whole file).

    Returns the number of plaintext bytes written."""
    written = 0
    with open(output_path, 'wb') as out:
        for chunk in decrypt_file_chunked(encrypted_path):
            if max_bytes is not None and written + len(chunk) >= max_bytes:
                out.write(chunk[:max_bytes - written])
                written = max_bytes
                break
            out.write(chunk)
            written += len(chunk)
    return written


def generate_thumbnail(file_record, wait=True, refresh_snapshot=True):
    """Generate a thumbnail for a file if it's a previewable type (image, text, or video)

    wait=True (upload/save background threads): block up to
    THUMBNAIL_SLOT_TIMEOUT_SECONDS for a render slot.
    wait=False (HTTP GET fill): never wait on the global render queue, but allow
    up to one second for an upload-time render of this SAME file to commit. The
    next visible-tile request retries longer work. refresh_snapshot=False is
    reserved for the welcome-file path, where the File row is still part of a
    larger uncommitted transaction that must not be rolled back before rendering."""
    file_id = getattr(file_record, 'id', None)
    generation_lock = _acquire_thumbnail_generation_lock(file_id, wait=wait)
    if not generation_lock and not wait:
        deadline = time.monotonic() + THUMBNAIL_SAME_FILE_WAIT_SECONDS
        while not generation_lock and time.monotonic() < deadline:
            time.sleep(0.05)
            generation_lock = _acquire_thumbnail_generation_lock(file_id, wait=False)
    if not generation_lock:
        if not wait:
            _schedule_thumbnail_bg(file_id)
        return False
    try:
        # A second request may have loaded this row before waiting on the flock.
        # End that old MariaDB snapshot after taking the lock so it sees the first
        # renderer's committed replica instead of trying the same unique insert.
        if refresh_snapshot:
            db.session.rollback()
            file_record = db.session.get(File, file_id)
            if file_record is None or file_record.is_trashed:
                return False
            if file_record.has_thumbnail:
                thumb_id = f'{file_id}.jpg'
                if storage._local_backend.exists('thumbnails', thumb_id):
                    return True

        timeout = THUMBNAIL_SLOT_TIMEOUT_SECONDS if wait else 0
        if not _THUMBNAIL_SEMAPHORE.acquire(timeout=timeout):
            print(f'[THUMBNAIL] All {THUMBNAIL_MAX_CONCURRENT} render slots busy; skipping '
                  f'thumbnail for {getattr(file_record, "orig_name", "?")} (queued for background render)')
            if not wait:
                _schedule_thumbnail_bg(file_id)
            return False
        try:
            return _generate_thumbnail_locked(file_record)
        finally:
            _THUMBNAIL_SEMAPHORE.release()
    finally:
        _release_thumbnail_generation_lock(generation_lock)


def _generate_thumbnail_locked(file_record):
    """Thumbnail render body. Callers MUST hold a _THUMBNAIL_SEMAPHORE slot."""
    # Capture identity + name while the instance is still attached to the session.
    # The file may be deleted (trashed/purged) by another thread while this
    # background render runs, which would detach the instance — using these
    # snapshots keeps logging/cleanup safe even after that happens.
    file_id = file_record.id
    safe_name = file_record.orig_name
    extension = _get_compound_ext(file_record.orig_name)
    expected_content_hash = file_record.content_hash
    image_extensions = _THUMB_IMAGE_EXTS
    image_formats = sorted({'JPEG' if ext in ('jpg', 'jpeg') else ext.upper()
                            for ext in image_extensions})
    text_extensions = _THUMB_TEXT_EXTS
    video_extensions = _THUMB_VIDEO_EXTS

    is_dotenv = _is_dotenv_filename(safe_name)
    if (
        extension not in image_extensions
        and extension not in text_extensions
        and extension not in video_extensions
        and not is_dotenv
    ):
        return False
    
    if file_record.is_e2e_encrypted:
        return False
    
    encrypted_path = storage.get_file_path(file_record.filename)
    if not encrypted_path or not os.path.exists(encrypted_path):
        return False
    
    # Skip thumbnail generation for very large image/text files to avoid OOM.
    # Video is exempt from THIS cap because ffmpeg only reads a few frames -- but
    # the DECRYPT that feeds ffmpeg is separately bounded below (AUDIT FIX A18);
    # it used to write a full plaintext copy of the whole video with no cap.
    if extension not in video_extensions:
        max_thumbnail_size = 20 * 1024 * 1024  # 20MB
        if file_record.size and file_record.size > max_thumbnail_size:
            print(f'[THUMBNAIL] Skipping thumbnail for large file: {file_record.orig_name} ({file_record.size} bytes)')
            return False
    
    try:
        import tempfile as _thumb_tempfile
        
        thumb_buffer = io.BytesIO()
        
        if extension in video_extensions:
            # Generate video thumbnail using ffmpeg
            # Check that ffmpeg is available
            if not shutil.which('ffmpeg'):
                print(f'[THUMBNAIL] ffmpeg not found, skipping video thumbnail for: {file_record.orig_name}')
                return False
            
            # AUDIT FIX A18: materialise only a BOUNDED prefix of the plaintext
            # video. ffmpeg only reads a few frames near the start, so a head is
            # normally enough; a full copy is written only as a fallback and only
            # for files small enough that N of them cannot fill the disk.
            try:
                encrypted_size = os.path.getsize(encrypted_path)
            except OSError:
                encrypted_size = 0
            head_bytes = min(encrypted_size, VIDEO_THUMB_HEAD_BYTES) if encrypted_size else VIDEO_THUMB_HEAD_BYTES
            temp_root = _ensure_onegy_temp_root()
            if not _thumbnail_disk_space_ok(temp_root, head_bytes):
                return False

            # Decrypt video to a temp file (ffmpeg needs file access)
            tmp_dir = create_work_dir('vidthumb_')
            tmp_video_path = os.path.join(tmp_dir, f'input.{extension}')
            tmp_frame_path = os.path.join(tmp_dir, 'frame.jpg')
            try:
                materialised_full = False
                _write_decrypted_prefix(encrypted_path, tmp_video_path, max_bytes=VIDEO_THUMB_HEAD_BYTES)

                def _try_extract_frame():
                    # Try extracting a frame at 2 seconds (avoids common black intro frames)
                    for seek_time in ['2', '0']:
                        result = subprocess.run(
                            ['ffmpeg', '-y', '-ss', seek_time, '-i', tmp_video_path,
                             '-frames:v', '1', '-f', 'image2', tmp_frame_path],
                            capture_output=True, timeout=30
                        )
                        if result.returncode == 0 and os.path.exists(tmp_frame_path) and os.path.getsize(tmp_frame_path) > 0:
                            return True
                        # If seeking to 2s failed, remove any partial output and retry at 0s
                        if os.path.exists(tmp_frame_path):
                            os.remove(tmp_frame_path)
                    return False

                frame_extracted = _try_extract_frame()

                if not frame_extracted and encrypted_size > VIDEO_THUMB_HEAD_BYTES:
                    # Containers that keep their index (moov atom) at the end
                    # cannot be decoded from a prefix. Retry with the whole file,
                    # but only when it is small enough to be safe.
                    if encrypted_size > VIDEO_THUMB_FULL_MAX_BYTES:
                        print(f'[THUMBNAIL] Skipping video thumbnail for {file_record.orig_name}: '
                              f'the {VIDEO_THUMB_HEAD_BYTES} byte head was not decodable and the file '
                              f'({encrypted_size} bytes) is too large to materialise in full')
                        return False
                    if not _thumbnail_disk_space_ok(temp_root, encrypted_size):
                        return False
                    _write_decrypted_prefix(encrypted_path, tmp_video_path, max_bytes=None)
                    materialised_full = True
                    frame_extracted = _try_extract_frame()

                if not frame_extracted:
                    print(f'[THUMBNAIL] ffmpeg failed to extract frame from: {file_record.orig_name} '
                          f'({"full copy" if materialised_full else "bounded head"})')
                    return False
                
                # Resize the extracted frame with Pillow (same as image thumbnails)
                from PIL import Image
                # AUDIT FIX M3: catch DecompressionBombError so a maliciously
                # large frame does not OOM the worker.
                try:
                    img = Image.open(tmp_frame_path, formats=['JPEG'])
                    img.thumbnail((200, 200), Image.LANCZOS)
                except (Image.DecompressionBombError, Image.DecompressionBombWarning) as _bomb_err:
                    print(f'[THUMBNAIL] Rejected oversized video frame for {file_record.orig_name}: {_bomb_err}')
                    return False
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                img.save(thumb_buffer, 'JPEG', quality=80)
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)
        
        else:
            # Image and text thumbnails use SpooledTemporaryFile (decrypt in memory)
            with _thumb_tempfile.SpooledTemporaryFile(max_size=10 * 1024 * 1024) as spooled:
                for chunk in decrypt_file_chunked(encrypted_path):
                    spooled.write(chunk)
                spooled.seek(0)
                
                if extension in image_extensions:
                    # Generate image thumbnail
                    from PIL import Image
                    # AUDIT FIX M3: hard-reject decompression-bomb images so a
                    # crafted upload cannot exhaust worker memory during decode.
                    try:
                        img = Image.open(spooled, formats=image_formats)
                        img.thumbnail((200, 200), Image.LANCZOS)
                    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as _bomb_err:
                        print(f'[THUMBNAIL] Rejected decompression bomb for {file_record.orig_name}: {_bomb_err}')
                        return False
                    # Convert to RGB if necessary (e.g., PNG with alpha)
                    if img.mode in ('RGBA', 'P', 'LA'):
                        background = Image.new('RGB', img.size, (26, 26, 26))
                        if img.mode == 'P':
                            img = img.convert('RGBA')
                        background.paste(img, mask=img.split()[-1] if img.mode in ('RGBA', 'LA') else None)
                        img = background
                    elif img.mode != 'RGB':
                        img = img.convert('RGB')
                    img.save(thumb_buffer, 'JPEG', quality=80)
                
                elif extension in text_extensions or is_dotenv:
                    # Generate syntax-highlighted text preview thumbnail using Pygments
                    from PIL import Image, ImageDraw, ImageFont
                    from pygments.lexers import get_lexer_by_name, TextLexer
                    from pygments.token import Token
                    
                    # Read first 2000 bytes of text content
                    text_bytes = spooled.read(2000)
                    try:
                        text_content = text_bytes.decode('utf-8', errors='replace')
                    except Exception:
                        text_content = text_bytes.decode('latin-1', errors='replace')
                    
                    # Create thumbnail image (200x140 matches tile container aspect ratio
                    # so object-fit:cover won't crop text content)
                    img = Image.new('RGB', (200, 140), (26, 26, 26))
                    draw = ImageDraw.Draw(img)
                    
                    # Use default font
                    try:
                        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 10)
                    except Exception:
                        font = ImageFont.load_default()
                    
                    # Map file extension to Pygments lexer (mirrors getHighlightLanguage() in dashboard.js)
                    _ext_to_lexer = {
                        'py': 'python', 'js': 'javascript', 'ts': 'typescript', 'tsx': 'typescript', 'jsx': 'javascript',
                        'json': 'json', 'xml': 'xml', 'html': 'html', 'css': 'css', 'yaml': 'yaml', 'yml': 'yaml',
                        'sh': 'bash', 'bat': 'batch', 'c': 'c', 'cpp': 'cpp', 'h': 'c', 'hpp': 'cpp',
                        'lua': 'lua', 'rb': 'ruby', 'rs': 'rust', 'go': 'go', 'java': 'java',
                        'kt': 'kotlin', 'swift': 'swift', 'php': 'php', 'pl': 'perl', 'r': 'r',
                        'sql': 'sql', 'md': 'markdown', 'diff': 'diff', 'makefile': 'makefile',
                        'toml': 'toml', 'ini': 'ini', 'cfg': 'ini', 'conf': 'ini',
                        'ps1': 'powershell', 'env': 'ini',
                    }
                    
                    lexer_name = _ext_to_lexer.get(extension)
                    if is_dotenv:
                        lexer_name = 'ini'
                    try:
                        lexer = get_lexer_by_name(lexer_name) if lexer_name else TextLexer()
                    except Exception:
                        lexer = TextLexer()
                    
                    # GitHub Dark color scheme — matching github-dark.min.css
                    # Maps Pygments token types to RGB tuples
                    _token_colors = {
                        Token.Comment:              (139, 148, 158),  # #8b949e — .hljs-comment
                        Token.Keyword:              (255, 123, 114),  # #ff7b72 — .hljs-keyword,.hljs-type
                        Token.Keyword.Constant:     (121, 192, 255),  # #79c0ff — .hljs-literal
                        Token.Keyword.Type:         (255, 123, 114),  # #ff7b72 — .hljs-type
                        Token.Operator:             (121, 192, 255),  # #79c0ff — .hljs-operator
                        Token.Punctuation:          (139, 148, 158),  # #8b949e — .hljs-punctuation
                        Token.Literal.String:       (165, 214, 255),  # #a5d6ff — .hljs-string
                        Token.Literal.Number:       (121, 192, 255),  # #79c0ff — .hljs-number
                        Token.Name.Tag:             (126, 231, 135),  # #7ee787 — .hljs-name,.hljs-selector-tag
                        Token.Name.Attribute:       (121, 192, 255),  # #79c0ff — .hljs-attr
                        Token.Name.Variable:        (121, 192, 255),  # #79c0ff — .hljs-variable
                        Token.Name.Function:        (210, 168, 255),  # #d2a8ff — .hljs-title.function_
                        Token.Name.Function.Magic:  (210, 168, 255),  # #d2a8ff
                        Token.Name.Decorator:       (121, 192, 255),  # #79c0ff — .hljs-meta
                        Token.Name.Builtin:         (255, 166, 87),   # #ffa657 — .hljs-built_in
                        Token.Name.Builtin.Pseudo:  (255, 166, 87),   # #ffa657
                        Token.Name.Class:           (210, 168, 255),  # #d2a8ff — .hljs-title.class_
                        Token.Name.Property:        (121, 192, 255),  # #79c0ff — .hljs-property
                        Token.Generic.Deleted:      (255, 220, 215),  # #ffdcd7 — .hljs-deletion
                        Token.Generic.Inserted:     (175, 245, 180),  # #aff5b4 — .hljs-addition
                        Token.Generic.Heading:      (31, 111, 235),   # #1f6feb — .hljs-section
                        Token.Generic.Subheading:   (31, 111, 235),   # #1f6feb
                    }
                    _default_color = (201, 209, 217)  # #c9d1d9
                    
                    def _get_token_color(token_type):
                        """Walk up the token type hierarchy to find a matching color."""
                        while token_type:
                            if token_type in _token_colors:
                                return _token_colors[token_type]
                            token_type = token_type.parent
                        return _default_color
                    
                    # Measure character width (monospace font, all chars equal width)
                    char_width = font.getlength('A')
                    max_chars = 35
                    max_lines = 10
                    x_start = 8
                    y = 4
                    line_height = 13
                    line_count = 0
                    
                    # Tokenize and render with syntax colors
                    x = x_start
                    col = 0
                    for token_type, token_value in lexer.get_tokens(text_content):
                        if line_count >= max_lines or y > 130:
                            break
                        
                        color = _get_token_color(token_type)
                        
                        for ch in token_value:
                            if line_count >= max_lines or y > 130:
                                break
                            
                            if ch == '\n':
                                # Move to next line
                                y += line_height
                                x = x_start
                                col = 0
                                line_count += 1
                                continue
                            
                            if ch == '\t':
                                # Expand tab to spaces (up to next 4-stop)
                                spaces = 4 - (col % 4)
                                col += spaces
                                x = x_start + col * char_width
                                continue
                            
                            if col >= max_chars:
                                # Line full, skip remaining chars until newline
                                continue
                            
                            draw.text((x, y), ch, fill=color, font=font)
                            col += 1
                            x = x_start + col * char_width
                    
                    img.save(thumb_buffer, 'JPEG', quality=80)
        
        thumb_bytes = thumb_buffer.getvalue()
        # Re-check the file hash before publishing the thumbnail so an older
        # render cannot overwrite or delete a newer valid thumbnail. The file may
        # also have been deleted (trashed/purged) while this render ran, so guard
        # the refresh against a concurrently-removed row (ObjectDeletedError).
        try:
            db.session.refresh(file_record)
        except Exception:
            db.session.rollback()
            print(f'[THUMBNAIL] Skipping thumbnail for {safe_name} — file removed during generation')
            return False
        if expected_content_hash and file_record.content_hash != expected_content_hash:
            print(f'[THUMBNAIL] Skipping stale thumbnail for {safe_name} — content changed during generation')
            return False
        if save_thumbnail_to_disk(file_record.id, thumb_bytes, is_e2e=False):
            file_record.has_thumbnail = True
            # The row can still vanish between the refresh and the flush; a 0-row
            # UPDATE raises StaleDataError. Roll back and drop the orphan thumbnail
            # we just wrote so nothing dangles on disk.
            try:
                db.session.commit()
            except Exception:
                db.session.rollback()
                try:
                    delete_thumbnail_from_disk(file_id)
                except Exception:
                    pass
                print(f'[THUMBNAIL] Skipping thumbnail for {safe_name} — file removed during commit')
                return False
            print(f'[THUMBNAIL] Generated thumbnail for: {safe_name}')
            return True
        return False
        
    except Exception as e:
        print(f'[THUMBNAIL] Error generating thumbnail for {safe_name}: {e}')
        try:
            db.session.rollback()
        except Exception:
            pass
        return False

