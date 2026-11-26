# Small host-local authority for security state that must be coherent across
# Gunicorn workers. State and lock names are hashes, so attacker-controlled keys
# cannot escape the directory or create oversized filenames. Every key has its
# own flock: unrelated users/nonces/resources do not serialize behind one global
# lock. Atomic replace keeps readers from observing partial JSON after a crash.
_SECURITY_STATE_MAX_BYTES = 64 * 1024
_SECURITY_STATE_CLEANUP_MAX_PER_PASS = 4000
# Longest window any caller keeps state for (TOTP lockout decay, 24 h). An
# unreadable file older than this can no longer hold anything a caller honours.
_SECURITY_STATE_CORRUPT_HOLD_SECONDS = 24 * 3600


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
    state = None
    if len(payload) <= _SECURITY_STATE_MAX_BYTES:
        try:
            state = json.loads(payload.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
    if not isinstance(state, dict):
        return _corrupt_security_state(path)
    return state


def _corrupt_security_state(path):
    """An unreadable state file fails closed (RuntimeError): it may hold a
    consumed nonce or a lockout. Once it is older than every window a caller
    keeps state for, nothing in it can still apply, so it is moved aside and
    the key starts fresh instead of failing forever."""
    name = os.path.basename(path)
    try:
        age = time.time() - os.stat(path).st_mtime
    except FileNotFoundError:
        return {}
    if age < _SECURITY_STATE_CORRUPT_HOLD_SECONDS:
        print(f'[ERROR] [SECURITY] Unreadable security state {name}; failing closed until it is '
              f'{_SECURITY_STATE_CORRUPT_HOLD_SECONDS // 3600} h old')
        raise RuntimeError(f'Invalid security state file: {name}')
    quarantine = f'{path}.corrupt-{int(time.time())}'
    os.replace(path, quarantine)
    print(f'[ERROR] [SECURITY] Moved unreadable security state {name} aside to '
          f'{os.path.basename(quarantine)}; the key starts fresh')
    return {}


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
