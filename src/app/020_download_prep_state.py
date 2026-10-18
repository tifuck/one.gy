import queue
import threading
import logging

def is_browser_request():
    """Detect if request comes from a real browser vs headless client (curl/wget/etc).
    Returns True for browsers, False for CLI tools and API clients."""
    ua = (request.headers.get('User-Agent') or '').lower()
    # Headless/CLI clients
    headless_patterns = ['curl/', 'wget/', 'httpie/', 'python-requests/', 'python-urllib/',
                         'libwww-perl/', 'go-http-client/', 'java/', 'okhttp/', 'apache-httpclient/',
                         'node-fetch/', 'axios/', 'postman', 'insomnia', 'powershell']
    for pattern in headless_patterns:
        if pattern in ua:
            return False
    # No User-Agent at all is likely a CLI tool
    if not ua:
        return False
    # Check Accept header - browsers send text/html
    accept = request.headers.get('Accept', '')
    if 'text/html' in accept:
        return True
    # If User-Agent looks like a browser engine but no text/html accept
    browser_patterns = ['mozilla/', 'chrome/', 'safari/', 'firefox/', 'edge/', 'opera/']
    for pattern in browser_patterns:
        if pattern in ua:
            return True
    return False

def _wants_raw_bytes():
    """XHR/fetch wants the payload, not the preparing-download HTML page."""
    if (request.headers.get('X-Requested-With') or '').lower() == 'xmlhttprequest':
        return True
    accept = (request.headers.get('Accept') or '').lower()
    return 'application/octet-stream' in accept


def _browser_cross_site_post_blocked():
    """AUDIT FIX: browser CSRF check for routes that are @csrf.exempt so that
    curl / the Go CLI keep working.

    Why a header check and not a CSRF token: non-browser clients cannot be
    given a token to obtain (they never load a page), so requiring one would
    break every programmatic flow the exempt routes exist for. Browsers, by
    contrast, ALWAYS attach Origin to a POST (same-origin included, Chrome/
    Firefox/Safari) or, on older engines, Sec-Fetch-Site:

      * Origin present and its authority == request.host (or the configured
        DOMAIN)  -> same-origin, allow.
      * Origin present but mismatched (or the opaque 'null' origin) -> this is
        a cross-site POST (or a hostile same-site subdomain) -> BLOCK.
      * No Origin but Sec-Fetch-Site: cross-site                 -> BLOCK.
      * Neither header present -> non-browser client (curl, Go CLI, tests)
        -> allow.

    This blocks anonymous cross-site POSTs to exempt endpoints from clobbering
    the victim's session / onegy_manager cookies via response Set-Cookie, and
    provides the missing CSRF validation for guest (cookie/session-owned)
    manage/delete flows, which the SameSite cookie attributes alone do not
    fully cover (same-site subdomains, older clients)."""
    origin = (request.headers.get('Origin') or '').strip()
    if origin:
        if origin.lower() == 'null':
            return True
        origin_host = (urllib.parse.urlparse(origin).netloc or '').lower()
        if not origin_host:
            return True
        allowed = {(request.host or '').lower()}
        try:
            configured = (urllib.parse.urlparse(f'https://{domain}').netloc or '').lower()
        except Exception:
            configured = ''
        if configured:
            allowed.add(configured)
        return origin_host not in allowed
    return (request.headers.get('Sec-Fetch-Site') or '').strip().lower() == 'cross-site'

# Track download preparation progress using filesystem-based state
# so all Gunicorn workers can share state across processes.
_PREP_STATE_DIR = os.path.join(os.path.abspath(os.path.dirname(__file__)), 'uploads', '.prep_state')
os.makedirs(_PREP_STATE_DIR, exist_ok=True)
# _download_prep_lock no longer needed: prep state is stored on disk with atomic writes

def _prep_state_path(prep_id):
    """Return the path to a prep state JSON file."""
    import re
    if not re.match(r'^[0-9a-f\-]+$', prep_id):
        return None
    return os.path.join(_PREP_STATE_DIR, f'{prep_id}.json')

def _read_prep_state(prep_id):
    """Read prep state from disk. Returns dict or None."""
    import json
    path = _prep_state_path(prep_id)
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, 'r') as f:
            state = json.load(f)
        return state if isinstance(state, dict) else None
    except Exception:
        return None

def _write_prep_state(prep_id, state):
    """Write prep state to disk atomically. Returns True on success.

    AUDIT FIX (residual torn-state): the temp path used to be the FIXED name
    `state.json.tmp`, so two writers racing on the same prep id (the decrypt
    thread's progress tick vs. a route's status transition) truncated and
    interleaved one shared file -- a reader could observe a half-written state
    and a crash between open() and os.replace() left that fixed name behind
    forever. The temp file is now unique per write (mkstemp, named
    `<prep_id>.<rand>.tmp` so the crash sweep's `*.tmp` glob sees it), fsynced
    so a replace() never publishes a zero-length/truncated state to a
    concurrent reader after a power cut, and removed on any failure."""
    import json
    path = _prep_state_path(prep_id)
    if not path:
        return False
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(
            prefix=f'{prep_id}.', suffix='.tmp', dir=_PREP_STATE_DIR)
        with os.fdopen(fd, 'w') as f:
            json.dump(state, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        tmp_path = None
        return True
    except Exception as e:
        print(f'[DOWNLOAD] Error writing prep state {prep_id}: {e}')
        return False
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

def _update_prep_state(prep_id, **kwargs):
    """Read-modify-write prep state with specific fields. Returns True on success.

    AUDIT FIX (upload/download integrity): this used to start from an EMPTY dict
    whenever _read_prep_state() returned None -- which it does for ANY read or
    JSON-parse failure, not just a missing file. The rewritten state then had no
    'session_id' and no 'created_at', and because the prepared-download routes
    only enforced the owner check `if prep_session_id and ...`, an ownerless
    state authorized EVERY requester holding the prep id to fetch the fully
    DECRYPTED plaintext temp file. The missing 'created_at' also made the state
    immortal for cleanup_stale_preps(), permanently leaking a concurrency slot.
    We now refuse to resurrect or rewrite a state we cannot read, so the owner
    field can never be silently dropped and a corrupt state is reaped instead."""
    prep_lock = _acquire_scoped_lock('prep_reservations', prefix='prep')
    try:
        reservations, changed = _active_prep_reservations_locked(
            _read_prep_reservations_locked())
        state = _read_prep_state(prep_id)
        if state is None:
            path = _prep_state_path(prep_id)
            if path and os.path.exists(path):
                print(f'[ERROR] Prep state {prep_id} is unreadable/corrupt; refusing to rewrite it without its owner')
            if changed:
                _write_prep_reservations_locked(reservations)
            return False
        kwargs.pop('session_id', None)
        kwargs.pop('created_at', None)
        kwargs.pop('reservation_id', None)
        kwargs.pop('reservation_bytes', None)
        kwargs.pop('reservation_held', None)
        state.update(kwargs)
        if changed:
            _write_prep_reservations_locked(reservations)
        return _write_prep_state(prep_id, state)
    finally:
        _release_scoped_lock(prep_lock)

def _delete_prep_state(prep_id):
    """Remove prep state file from disk."""
    path = _prep_state_path(prep_id)
    if path:
        try:
            os.remove(path)
        except OSError:
            pass

def _get_download_session_id():
    """Return a stable browser-session identifier for prepared downloads."""
    download_session_id = session.get('download_session_id')
    if not download_session_id:
        download_session_id = str(uuid.uuid4())
        session['download_session_id'] = download_session_id
    return download_session_id

# Minimum file size (in bytes) to show preparation page (100MB)
LARGE_FILE_THRESHOLD = 100 * 1024 * 1024
MAX_CONCURRENT_PREPS = 10

# AUDIT FIX (upload/download integrity): prepared-download slots used to leak
# permanently. _count_active_preps() counted every 'pending'/'decrypting' state
# file and NOTHING aged those out -- a worker SIGKILLed mid-decrypt left its
# state 'decrypting' forever, so after MAX_CONCURRENT_PREPS such events every
# large browser download returned 503 SERVER BUSY until an operator deleted
# files by hand. Active preps rewrite their state file on every progress tick,
# so an untouched state file is proof the producing thread is gone: staleness is
# measured from the state file's mtime (idle time), not just created_at.
# A 'ready' state additionally holds the fully DECRYPTED plaintext on disk, so
# it gets a much shorter TTL than the old blanket 30 minutes.
_PREP_STALL_SECONDS = int(os.environ.get('PREP_STALL_SECONDS', '600'))
_PREP_READY_TTL_SECONDS = int(os.environ.get('PREP_READY_TTL_SECONDS', '300'))
_PREP_MAX_AGE_SECONDS = int(os.environ.get('PREP_MAX_AGE_SECONDS', '1800'))
_PREP_DOWNLOAD_FREE_SPACE_RESERVE = int(os.environ.get(
    'PREP_DOWNLOAD_FREE_SPACE_RESERVE', str(5 * 1024 * 1024 * 1024)))
_PREP_RESERVATION_STATE_VERSION = 1


def _prep_reservation_state_path():
    os.makedirs(app.instance_path, exist_ok=True)
    return os.path.join(app.instance_path, 'prepared_download_reservations.json')


def _read_prep_reservations_locked():
    try:
        with open(_prep_reservation_state_path(), 'r') as state_file:
            state = json.load(state_file)
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as e:
        return _quarantine_and_rebuild_prep_reservations(f'unreadable ledger: {e}')
    if not isinstance(state, dict) or state.get('version') != _PREP_RESERVATION_STATE_VERSION:
        return _quarantine_and_rebuild_prep_reservations('unsupported ledger format')
    reservations = state.get('reservations')
    if not isinstance(reservations, list):
        return _quarantine_and_rebuild_prep_reservations('invalid reservation list')
    return reservations


def _rebuild_prep_reservations_from_states():
    """Reconstruct the ledger from the per-prep state files (the ground truth).

    AUDIT FIX: rebuild is only safe because each prep state file carries its
    OWN single reservation_id, so one state file contributes AT MOST ONE
    reservation row — double counting (two rows for one prep) is structurally
    impossible from a rebuild, and _active_prep_reservations_locked() then
    re-validates every row against its state file anyway. Rows whose owner
    identity is missing/died are dropped by that same validation, exactly as
    they would be from a healthy ledger."""
    rebuilt = []
    seen_prep_ids = set()
    for prep_id in list(_iter_prep_state_ids()):
        if prep_id in seen_prep_ids:
            continue
        info = _read_prep_state(prep_id)
        if not isinstance(info, dict) or not info.get('reservation_held'):
            continue
        reservation_id = info.get('reservation_id')
        owner_identity = info.get('producer_identity')
        try:
            owner_pid = int(info.get('producer_pid'))
            reserved_bytes = max(0, int(info.get('reservation_bytes', 0) or 0))
        except (TypeError, ValueError):
            continue
        if not reservation_id or not owner_identity or owner_pid is None:
            continue
        seen_prep_ids.add(prep_id)
        rebuilt.append({
            'id': str(reservation_id),
            'prep_id': str(prep_id),
            'owner_pid': owner_pid,
            'owner_identity': str(owner_identity),
            'reserved_bytes': reserved_bytes,
            'created_at': _prep_state_created_epoch(info) or time.time(),
        })
    return rebuilt


def _quarantine_and_rebuild_prep_reservations(cause):
    """Recover from a corrupt prepared-download reservation ledger.

    AUDIT FIX: the ledger is read on EVERY prep admission, count, transition
    and claim — a single corrupt byte used to make every read raise, so every
    prepared download failed (crashing every prep) until an operator deleted
    the file by hand. The corrupt file is quarantined (kept for forensics, out
    of the way) and the ledger is rebuilt from the per-prep state files: each
    state file yields at most one reservation, so no double reservation — and
    therefore no double disk reservation or slot inflation — can result.
    If quarantine or the rewrite itself fails, this raises RuntimeError and
    callers fail CLOSED rather than proceeding with unvalidated accounting.

    Caller must hold the prep_reservations flock (all read paths do)."""
    state_path = _prep_reservation_state_path()
    print(f'[ERROR] Prepared-download reservation ledger unusable ({cause}); '
          'quarantining and rebuilding from prep state files')
    try:
        quarantine_path = f'{state_path}.corrupt-{int(time.time())}'
        os.replace(state_path, quarantine_path)
        print(f'[ERROR] Quarantined corrupt prep ledger to '
              f'{os.path.basename(quarantine_path)}')
    except FileNotFoundError:
        pass  # Nothing on disk to quarantine; a plain rebuild is enough.
    except OSError as e:
        raise RuntimeError(f'could not quarantine corrupt prep ledger: {e}') from e
    rebuilt = _rebuild_prep_reservations_from_states()
    _write_prep_reservations_locked(rebuilt)
    print(f'[ERROR] Rebuilt prep reservation ledger with {len(rebuilt)} active reservation(s)')
    return rebuilt


def _write_prep_reservations_locked(reservations):
    state_path = _prep_reservation_state_path()
    temp_path = None
    try:
        fd, temp_path = tempfile.mkstemp(
            prefix='.prepared_download_reservations.', suffix='.tmp', dir=app.instance_path)
        with os.fdopen(fd, 'w') as state_file:
            json.dump({
                'version': _PREP_RESERVATION_STATE_VERSION,
                'reservations': reservations,
            }, state_file)
            state_file.flush()
            os.fsync(state_file.fileno())
        os.replace(temp_path, state_path)
        temp_path = None
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


def _prep_process_identity(pid):
    """Reuse the boot-scoped /proc identity used by ZIP admission."""
    return _zip_process_identity(pid)


def _prep_free_disk_bytes():
    """Free bytes on the filesystem holding prepared plaintext files."""
    try:
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
        return _statvfs_free_bytes(app.config['UPLOAD_FOLDER'])
    except Exception as e:
        print(f'[WARNING] Could not determine free disk space for a prepared download: {e}')
        return None


def _prep_state_mtime(prep_id):
    """Last-write time of a prep state file, or None."""
    path = _prep_state_path(prep_id)
    if not path:
        return None
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _prep_state_created_epoch(info):
    """Parse 'created_at' out of a prep state, or None when unusable."""
    created_str = (info or {}).get('created_at')
    if not created_str:
        return None
    try:
        created = datetime.fromisoformat(created_str)
    except (ValueError, TypeError):
        return None
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return created.timestamp()


def _prep_state_stale_reason(prep_id, info):
    """Return a human-readable reason when a prep state should be reaped, else None.

    Fails CLOSED: a state we cannot age (no created_at AND no mtime) or that
    carries no owner is treated as reapable rather than being kept forever."""
    if not info:
        return 'unreadable state'
    # AUDIT FIX: an ownerless state can never be authorized again (the routes
    # now fail closed), so it is pure leakage -- reap it.
    if not info.get('session_id'):
        return 'missing owner session_id'
    now = time.time()
    mtime = _prep_state_mtime(prep_id)
    created = _prep_state_created_epoch(info)
    if mtime is None and created is None:
        return 'undatable state'
    status = info.get('status', 'pending')
    idle = (now - mtime) if mtime is not None else None
    age = (now - created) if created is not None else idle
    if status in ('pending', 'decrypting'):
        owner_pid = info.get('producer_pid')
        owner_identity = info.get('producer_identity')
        if (not owner_identity
                or _prep_process_identity(owner_pid) != owner_identity):
            return f'stale producer with status={status}'
        if idle is not None and idle > _PREP_STALL_SECONDS:
            return f'stalled {int(idle)}s with status={status}'
        # AUDIT FIX (residual): the absolute age cap below used to fire for
        # EVERY status, so a HEALTHY decrypt owned by a live producer was
        # reaped after _PREP_MAX_AGE_SECONDS (30 min) -- a multi-GB
        # server-side decrypt that legitimately runs longer lost its state and
        # its reservation slot while its thread was still writing, and the
        # in-flight download 404'd. A live producer that is still ticking the
        # state file is proven healthy by the identity + stall checks above;
        # dead/unowned states are already caught by them, so the age cap only
        # needs to cover terminal/ownerless states below.
        return None
    elif status == 'ready':
        delivery_identity = info.get('delivery_identity')
        if delivery_identity:
            if _prep_process_identity(info.get('delivery_pid')) == delivery_identity:
                # The pathname may already be unlinked while this process still
                # streams its open descriptor. Keep both slot and bytes reserved
                # until the response finalizer closes that descriptor.
                return None
            return 'stale delivery owner'
        if idle is not None and idle > _PREP_READY_TTL_SECONDS:
            return f'unclaimed plaintext idle {int(idle)}s'
    elif status in ('consumed', 'error') and info.get('reservation_held'):
        # A terminal state only retains a reservation when plaintext removal
        # failed. Retry that removal immediately rather than losing accounting.
        return f'terminal status={status} still owns plaintext'
    else:
        if idle is not None and idle > _PREP_READY_TTL_SECONDS:
            return f'terminal status={status} idle {int(idle)}s'
    if age is not None and age > _PREP_MAX_AGE_SECONDS:
        return f'age {int(age)}s exceeds max'
    return None


def _remove_prep_plaintext(prep_id, info, reason):
    """Remove a prep's plaintext, returning False when accounting must remain."""
    tmp_path = (info or {}).get('temp_path')
    if not tmp_path:
        return True
    try:
        os.remove(tmp_path)
        print(f'[DOWNLOAD] Removed decrypted temp file for prep {prep_id} ({reason})')
        return True
    except FileNotFoundError:
        return True
    except Exception as e:
        print(f'[ERROR] Failed to remove decrypted temp file for prep {prep_id}: {e}')
        return False


def _reap_prep_state_locked(prep_id, info, reason):
    """Delete prep state only after its decrypted plaintext has been removed."""
    if info is None:
        info = _read_prep_state(prep_id) or {}
    if not _remove_prep_plaintext(prep_id, info, reason):
        return False
    _delete_prep_state(prep_id)
    print(f'[DOWNLOAD] Reaped prepared-download state {prep_id}: {reason}')
    return True


def _reservation_matches_prep(reservation, prep_id, reservation_id=None):
    if not isinstance(reservation, dict):
        return False
    if not hmac.compare_digest(str(reservation.get('prep_id', '')), str(prep_id)):
        return False
    if reservation_id is None:
        return True
    return hmac.compare_digest(str(reservation.get('id', '')), str(reservation_id))


def _active_prep_reservations_locked(reservations):
    """Drop stale owners while retaining ready plaintext across worker death."""
    active = []
    changed = False
    for reservation in reservations:
        if not isinstance(reservation, dict):
            changed = True
            continue
        prep_id = reservation.get('prep_id')
        reservation_id = reservation.get('id')
        try:
            reserved_bytes = max(0, int(reservation.get('reserved_bytes', 0) or 0))
            owner_pid = int(reservation.get('owner_pid'))
        except (TypeError, ValueError):
            changed = True
            continue
        if not prep_id or not reservation_id or not reservation.get('owner_identity'):
            changed = True
            continue
        info = _read_prep_state(str(prep_id))
        if (not info
                or not hmac.compare_digest(str(info.get('reservation_id', '')), str(reservation_id))
                or not info.get('reservation_held')):
            changed = True
            continue
        reason = _prep_state_stale_reason(str(prep_id), info)
        if reason:
            if _reap_prep_state_locked(str(prep_id), info, reason):
                changed = True
                continue
        active.append({
            'id': str(reservation_id),
            'prep_id': str(prep_id),
            'owner_pid': owner_pid,
            'owner_identity': str(reservation.get('owner_identity')),
            'reserved_bytes': reserved_bytes,
            'created_at': reservation.get('created_at'),
        })
    return active, changed


def _release_prep_reservation_locked(reservations, prep_id, reservation_id=None):
    remaining = [
        reservation for reservation in reservations
        if not _reservation_matches_prep(reservation, prep_id, reservation_id)
    ]
    return remaining, len(remaining) != len(reservations)


def _reap_prep_state(prep_id, info, reason):
    """Cross-process-safe state/plaintext cleanup and reservation release."""
    prep_lock = _acquire_scoped_lock('prep_reservations', prefix='prep')
    try:
        reservations, changed = _active_prep_reservations_locked(
            _read_prep_reservations_locked())
        current = _read_prep_state(prep_id)
        reaped = _reap_prep_state_locked(prep_id, current if current is not None else info, reason)
        if reaped:
            reservations, released = _release_prep_reservation_locked(reservations, prep_id)
            changed = changed or released
        if changed:
            _write_prep_reservations_locked(reservations)
        return reaped
    finally:
        _release_scoped_lock(prep_lock)


def _iter_prep_state_ids():
    import glob as _glob
    for state_file in _glob.glob(os.path.join(_PREP_STATE_DIR, '*.json')):
        yield os.path.basename(state_file)[:-len('.json')]


def reap_stale_prep_states():
    """Reap every prep state that can no longer make progress. Returns the count.

    Called from _count_active_preps() (so the slot pool self-heals exactly where
    it is contended), from cleanup_stale_preps() on the scheduler, and once at
    startup."""
    prep_lock = _acquire_scoped_lock('prep_reservations', prefix='prep')
    try:
        state_ids_before = set(_iter_prep_state_ids())
        reservations, changed = _active_prep_reservations_locked(
            _read_prep_reservations_locked())
        reaped = len(state_ids_before - set(_iter_prep_state_ids()))
        for prep_id in list(_iter_prep_state_ids()):
            info = _read_prep_state(prep_id)
            reason = _prep_state_stale_reason(prep_id, info)
            if reason and _reap_prep_state_locked(prep_id, info, reason):
                reservations, released = _release_prep_reservation_locked(reservations, prep_id)
                changed = changed or released
                reaped += 1
        if changed:
            _write_prep_reservations_locked(reservations)
        return reaped
    finally:
        _release_scoped_lock(prep_lock)


def purge_all_prep_states():
    """Drop every prep state + decrypted temp file. Startup-only.

    Startup maintenance runs as its own process BEFORE gunicorn binds the port,
    so no preparation can be in flight: anything still on disk is the residue of
    a previous process and both its slot and its plaintext must be released."""
    prep_lock = _acquire_scoped_lock('prep_reservations', prefix='prep')
    try:
        try:
            reservations = _read_prep_reservations_locked()
        except RuntimeError as e:
            print(f'[ERROR] Discarding unreadable prepared-download reservation ledger at startup: {e}')
            reservations = []
        purged = 0
        retained = []
        for prep_id in list(_iter_prep_state_ids()):
            info = _read_prep_state(prep_id)
            if _reap_prep_state_locked(prep_id, info, 'startup purge'):
                purged += 1
            else:
                retained.extend(
                    reservation for reservation in reservations
                    if _reservation_matches_prep(reservation, prep_id)
                )
        _write_prep_reservations_locked(retained)
    finally:
        _release_scoped_lock(prep_lock)
    if purged:
        print(f'[STARTUP] Purged {purged} leftover prepared-download state(s)')
    return purged


def _count_active_preps():
    """Return the number of in-progress download preparation jobs.

    Stale states are reaped in the same pass so a killed worker cannot hold a
    slot forever (see the module comment above)."""
    prep_lock = _acquire_scoped_lock('prep_reservations', prefix='prep')
    try:
        reservations, changed = _active_prep_reservations_locked(
            _read_prep_reservations_locked())
        if changed:
            _write_prep_reservations_locked(reservations)
        return len(reservations)
    finally:
        _release_scoped_lock(prep_lock)

def _can_start_prep_download():
    """Return (allowed, active_count) for prepared download jobs.

    AUDIT FIX: fails CLOSED — if the reservation ledger cannot even be read
    AND rebuilt (e.g. instance/ is read-only), reject new preps with an
    explicit error instead of letting the RuntimeError surface as a generic
    500 from the download route."""
    try:
        active_preps = _count_active_preps()
    except Exception as e:
        print(f'[ERROR] Prepared-download reservation ledger unavailable; '
              f'failing closed and refusing new preps: {e}')
        return False, MAX_CONCURRENT_PREPS
    return active_preps < MAX_CONCURRENT_PREPS, active_preps


def _reserve_prep_download_slot(prep_id, state):
    """Atomically reserve a host-wide slot and plaintext disk footprint."""
    prep_lock = _acquire_scoped_lock('prep_reservations', prefix='prep')
    try:
        reservations, changed = _active_prep_reservations_locked(
            _read_prep_reservations_locked())
        active_preps = len(reservations)
        if active_preps >= MAX_CONCURRENT_PREPS:
            if changed:
                _write_prep_reservations_locked(reservations)
            return False, active_preps
        reserved_bytes = max(0, int(state.get('orig_size', 0) or 0))
        already_reserved = sum(item['reserved_bytes'] for item in reservations)
        free = _prep_free_disk_bytes()
        if (reserved_bytes and free is not None
                and (free - already_reserved) < (reserved_bytes + _PREP_DOWNLOAD_FREE_SPACE_RESERVE)):
            if changed:
                _write_prep_reservations_locked(reservations)
            print(f'[DOWNLOAD] Rejected prepared download: needs {reserved_bytes} bytes, '
                  f'{free} free, {already_reserved} already reserved')
            return False, active_preps
        owner_pid = os.getpid()
        owner_identity = _prep_process_identity(owner_pid)
        if not owner_identity:
            raise RuntimeError('could not establish prepared-download process identity')
        reservation_id = uuid.uuid4().hex
        reservation = {
            'id': reservation_id,
            'prep_id': prep_id,
            'owner_pid': owner_pid,
            'owner_identity': owner_identity,
            'reserved_bytes': reserved_bytes,
            'created_at': time.time(),
        }
        reservations.append(reservation)
        _write_prep_reservations_locked(reservations)
        state.update({
            'reservation_id': reservation_id,
            'reservation_bytes': reserved_bytes,
            'reservation_held': True,
            'producer_pid': owner_pid,
            'producer_identity': owner_identity,
        })
        if not _write_prep_state(prep_id, state):
            _delete_prep_state(prep_id)
            reservations.pop()
            _write_prep_reservations_locked(reservations)
            return False, active_preps
        return True, active_preps
    except Exception as e:
        print(f'[ERROR] Could not reserve prepared-download capacity: {e}')
        return False, 0
    finally:
        _release_scoped_lock(prep_lock)


def _transition_prep_state(prep_id, expected_statuses, status=None,
                           release_reservation=False, **kwargs):
    """Apply one fenced prep transition and release its reservation at most once."""
    prep_lock = _acquire_scoped_lock('prep_reservations', prefix='prep')
    try:
        reservations, changed = _active_prep_reservations_locked(
            _read_prep_reservations_locked())
        state = _read_prep_state(prep_id)
        if not state:
            if changed:
                _write_prep_reservations_locked(reservations)
            return False
        current_status = state.get('status', 'pending')
        if expected_statuses and current_status not in tuple(expected_statuses):
            if changed:
                _write_prep_reservations_locked(reservations)
            return False
        kwargs.pop('session_id', None)
        kwargs.pop('created_at', None)
        kwargs.pop('reservation_id', None)
        kwargs.pop('reservation_bytes', None)
        kwargs.pop('reservation_held', None)
        state.update(kwargs)
        if status is not None:
            state['status'] = status
        released = False
        if release_reservation and state.get('reservation_held'):
            state['reservation_held'] = False
            state['reservation_released_at'] = time.time()
            reservations, released = _release_prep_reservation_locked(
                reservations, prep_id, state.get('reservation_id'))
        if not _write_prep_state(prep_id, state):
            return False
        if changed or released:
            _write_prep_reservations_locked(reservations)
        return True
    finally:
        _release_scoped_lock(prep_lock)


def _claim_prepared_download(prep_id, session_id):
    """Claim one ready plaintext for delivery without holding the lock while streaming."""
    prep_lock = _acquire_scoped_lock('prep_reservations', prefix='prep')
    try:
        reservations, changed = _active_prep_reservations_locked(
            _read_prep_reservations_locked())
        info = _read_prep_state(prep_id)
        if not info or info.get('status') != 'ready' or not info.get('reservation_held'):
            if changed:
                _write_prep_reservations_locked(reservations)
            return None, 'not_ready'
        prep_session_id = info.get('session_id')
        if not prep_session_id or prep_session_id != session_id:
            if changed:
                _write_prep_reservations_locked(reservations)
            return None, 'forbidden'
        delivery_identity = info.get('delivery_identity')
        if (delivery_identity
                and _prep_process_identity(info.get('delivery_pid')) == delivery_identity):
            if changed:
                _write_prep_reservations_locked(reservations)
            return None, 'not_ready'
        delivery_pid = os.getpid()
        info['delivery_pid'] = delivery_pid
        info['delivery_identity'] = _prep_process_identity(delivery_pid)
        info['delivery_claimed_at'] = time.time()
        if not info['delivery_identity'] or not _write_prep_state(prep_id, info):
            return None, 'not_ready'
        if changed:
            _write_prep_reservations_locked(reservations)
        return info, None
    finally:
        _release_scoped_lock(prep_lock)


# AUDIT FIX M2: anonymous ZIP folder downloads were unbounded — no concurrency
# gate, no size cap, no file-count cap. Anyone could trigger repeated multi-GB
# decrypt-to-disk + DEFLATE jobs on a public folder. We cap aggregate bytes,
# file count, and concurrent in-flight ZIP jobs to bound disk, CPU, and worker
# starvation pressure.
_ZIP_DOWNLOAD_MAX_FILES = int(os.environ.get('ZIP_DOWNLOAD_MAX_FILES', '5000'))
# Default 20 GB per ZIP — generous for legitimate use but bounded.
_ZIP_DOWNLOAD_MAX_BYTES = int(os.environ.get('ZIP_DOWNLOAD_MAX_BYTES', str(20 * 1024 * 1024 * 1024)))
_ZIP_DOWNLOAD_MAX_CONCURRENT = int(os.environ.get('ZIP_DOWNLOAD_MAX_CONCURRENT', '4'))
# AUDIT FIX P11: a ZIP build materialises the FULL archive plus one decrypted
# member on disk before a single byte is streamed, and the concurrency slot used
# to be released in the view's `finally` -- i.e. when the view RETURNED the
# streaming response, before transmission. Completed-but-unstreamed archives
# therefore piled up on disk while fresh builds were admitted. Two changes:
# (1) the slot is now held until the response has actually been streamed and its
# temp tree removed (see _build_zip_download_response), and (2) every build
# reserves its estimated disk footprint so concurrent builds cannot each
# independently conclude there is enough free space.
_ZIP_DOWNLOAD_FREE_SPACE_RESERVE = int(os.environ.get('ZIP_DOWNLOAD_FREE_SPACE_RESERVE', str(5 * 1024 * 1024 * 1024)))
_ZIP_RESERVATION_STATE_VERSION = 1


def _zip_reservation_state_path():
    os.makedirs(app.instance_path, exist_ok=True)
    return os.path.join(app.instance_path, 'zip_build_reservations.json')


def _zip_process_identity(pid):
    """Return a boot-scoped process identity that is safe against PID reuse."""
    try:
        with open('/proc/sys/kernel/random/boot_id', 'r') as boot_file:
            boot_id = boot_file.read().strip()
        with open(f'/proc/{int(pid)}/stat', 'r') as stat_file:
            stat_line = stat_file.read()
        # Fields after the final ')' start at proc field 3; starttime is field 22.
        stat_fields = stat_line.rsplit(')', 1)[1].split()
        if stat_fields[0] in ('Z', 'X'):
            return None
        start_ticks = stat_fields[19]
        return f'{boot_id}:{start_ticks}'
    except (OSError, TypeError, ValueError, IndexError):
        return None


def _read_zip_reservations_locked():
    try:
        with open(_zip_reservation_state_path(), 'r') as state_file:
            state = json.load(state_file)
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(f'could not read ZIP reservation state: {e}') from e
    if not isinstance(state, dict) or state.get('version') != _ZIP_RESERVATION_STATE_VERSION:
        raise RuntimeError('ZIP reservation state has an unsupported format')
    reservations = state.get('reservations')
    if not isinstance(reservations, list):
        raise RuntimeError('ZIP reservation state has an invalid reservation list')
    return reservations


def _write_zip_reservations_locked(reservations):
    state_path = _zip_reservation_state_path()
    temp_path = None
    try:
        fd, temp_path = tempfile.mkstemp(
            prefix='.zip_build_reservations.', suffix='.tmp', dir=app.instance_path)
        with os.fdopen(fd, 'w') as state_file:
            json.dump({
                'version': _ZIP_RESERVATION_STATE_VERSION,
                'reservations': reservations,
            }, state_file)
            state_file.flush()
            os.fsync(state_file.fileno())
        os.replace(temp_path, state_path)
        temp_path = None
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


def _active_zip_reservations_locked(reservations):
    """Return live reservations, dropping owners that died or were PID-reused."""
    active = []
    reaped = 0
    for reservation in reservations:
        if not isinstance(reservation, dict):
            reaped += 1
            continue
        owner_pid = reservation.get('owner_pid')
        owner_identity = reservation.get('owner_identity')
        reservation_id = reservation.get('id')
        try:
            estimated_bytes = max(0, int(reservation.get('estimated_bytes', 0) or 0))
        except (TypeError, ValueError):
            reaped += 1
            continue
        if (not reservation_id or not owner_identity
                or _zip_process_identity(owner_pid) != owner_identity):
            reaped += 1
            continue
        active.append({
            'id': str(reservation_id),
            'owner_pid': int(owner_pid),
            'owner_identity': str(owner_identity),
            'estimated_bytes': estimated_bytes,
            'created_at': reservation.get('created_at'),
        })
    if reaped:
        print(f'[ZIP] Reaped {reaped} stale ZIP build reservation(s)')
    return active, reaped


def _zip_entry_sizes(files_to_zip):
    """Yield the logical size of each ZIP member.

    `files_to_zip` is a list of tuples whose third element is the File ORM
    object (the existing layout used by all callers)."""
    for entry in files_to_zip:
        try:
            file_obj = entry[2]
        except (IndexError, TypeError):
            continue
        try:
            yield int(getattr(file_obj, 'size', 0) or 0)
        except (TypeError, ValueError):
            yield 0


def _enforce_zip_limits(files_to_zip):
    """Validate (count, total_size) caps before building a ZIP.
    Returns (ok, error_response_tuple_or_none)."""
    if len(files_to_zip) > _ZIP_DOWNLOAD_MAX_FILES:
        print(f'[ZIP] Rejected ZIP build: {len(files_to_zip)} files exceeds cap {_ZIP_DOWNLOAD_MAX_FILES}')
        return False, (jsonify({
            'error': 'TOO MANY FILES IN FOLDER. CONTACT THE OWNER FOR A DIRECT DOWNLOAD.',
            'limit': _ZIP_DOWNLOAD_MAX_FILES,
        }), 413)
    total_size = 0
    for size in _zip_entry_sizes(files_to_zip):
        total_size += size
        if total_size > _ZIP_DOWNLOAD_MAX_BYTES:
            print(f'[ZIP] Rejected ZIP build: aggregate >{_ZIP_DOWNLOAD_MAX_BYTES} bytes')
            return False, (jsonify({
                'error': 'FOLDER TOO LARGE FOR ZIP DOWNLOAD. CONTACT THE OWNER FOR A DIRECT DOWNLOAD.',
                'limit_bytes': _ZIP_DOWNLOAD_MAX_BYTES,
            }), 413)
    return True, None


def _zip_build_estimate_bytes(files_to_zip):
    """AUDIT FIX P11: estimated PEAK on-disk footprint of a ZIP build -- the
    stored archive (ZIP_STORED, so roughly the sum of member sizes) plus the
    single largest member, which is decrypted into its own temp file before
    being added."""
    total = 0
    largest = 0
    for size in _zip_entry_sizes(files_to_zip):
        total += size
        if size > largest:
            largest = size
    return total + largest


def _free_disk_bytes():
    """Free bytes on the filesystem that actually holds the ZIP work dirs
    (ONEGY_TEMP_ROOT -- NOT the application directory; they are often different
    filesystems). Returns None when it cannot be determined, in which case the
    caller must not block the build."""
    try:
        return _statvfs_free_bytes(_ensure_onegy_temp_root())
    except Exception as e:
        print(f'[WARNING] Could not determine free disk space for a ZIP build: {e}')
        return None


def _statvfs_free_bytes(path):
    stat = os.statvfs(path)
    return stat.f_frsize * stat.f_bavail


def _acquire_zip_slot(estimated_bytes=0):
    """Reserve a ZIP-build slot AND its estimated disk footprint.

    Returns (reservation_id_or_none, error_response_tuple_or_none). The caller
    MUST release that reservation once the archive has been streamed and its temp
    tree removed. The flock is held only for this ledger transaction, never for
    ZIP construction or streaming."""
    estimated_bytes = max(0, int(estimated_bytes or 0))
    reservation_lock = None
    try:
        reservation_lock = _acquire_scoped_lock('zip_build_reservations', prefix='zip')
        reservations, reaped = _active_zip_reservations_locked(
            _read_zip_reservations_locked())
        if len(reservations) >= _ZIP_DOWNLOAD_MAX_CONCURRENT:
            if reaped:
                _write_zip_reservations_locked(reservations)
            print(f'[ZIP] Rejected ZIP build: {len(reservations)} build(s) already in flight')
            return None, _zip_slot_busy_response()
        reserved_bytes = sum(item['estimated_bytes'] for item in reservations)
        if estimated_bytes:
            free = _free_disk_bytes()
            if free is not None and (free - reserved_bytes) < (estimated_bytes + _ZIP_DOWNLOAD_FREE_SPACE_RESERVE):
                if reaped:
                    _write_zip_reservations_locked(reservations)
                print(f'[ZIP] Rejected ZIP build: needs ~{estimated_bytes} bytes, '
                      f'{free} free, {reserved_bytes} already reserved by in-flight builds')
                return None, (jsonify({
                    'error': 'NOT ENOUGH SERVER DISK SPACE FOR THIS DOWNLOAD RIGHT NOW. PLEASE TRY AGAIN LATER.',
                }), 507)
        reservation_id = uuid.uuid4().hex
        owner_pid = os.getpid()
        owner_identity = _zip_process_identity(owner_pid)
        if not owner_identity:
            raise RuntimeError('could not establish ZIP reservation process identity')
        reservations.append({
            'id': reservation_id,
            'owner_pid': owner_pid,
            'owner_identity': owner_identity,
            'estimated_bytes': estimated_bytes,
            'created_at': time.time(),
        })
        _write_zip_reservations_locked(reservations)
        return reservation_id, None
    except Exception as e:
        print(f'[ERROR] Could not reserve ZIP build capacity: {e}')
        return None, (jsonify({
            'error': 'SERVER CANNOT START THIS DOWNLOAD RIGHT NOW. PLEASE TRY AGAIN LATER.',
        }), 503)
    finally:
        _release_scoped_lock(reservation_lock)


def _release_zip_slot(reservation_id):
    if not reservation_id:
        return
    reservation_lock = None
    try:
        reservation_lock = _acquire_scoped_lock('zip_build_reservations', prefix='zip')
        reservations, reaped = _active_zip_reservations_locked(
            _read_zip_reservations_locked())
        remaining = [
            item for item in reservations
            if not hmac.compare_digest(item['id'], str(reservation_id))
        ]
        if reaped or len(remaining) != len(reservations):
            _write_zip_reservations_locked(remaining)
    except Exception as e:
        print(f'[ERROR] Could not release ZIP build reservation {reservation_id}: {e}')
    finally:
        _release_scoped_lock(reservation_lock)


def _zip_slot_busy_response():
    return jsonify({
        'error': 'TOO MANY CONCURRENT FOLDER DOWNLOADS. PLEASE TRY AGAIN IN A MOMENT.',
    }), 429

