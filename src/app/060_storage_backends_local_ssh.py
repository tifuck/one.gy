class _StorageBackend:
    """Abstract base for storage backends."""

    def put(self, category, file_id, local_path):
        raise NotImplementedError

    def get(self, category, file_id, local_path):
        raise NotImplementedError

    def delete(self, category, file_id):
        raise NotImplementedError

    def exists(self, category, file_id):
        raise NotImplementedError

    def size(self, category, file_id):
        raise NotImplementedError

    def list_files(self, category):
        raise NotImplementedError

    def health_check(self):
        raise NotImplementedError

    def disk_usage(self):
        """Return disk usage stats for this storage backend, or None if not supported.
        Returns dict with total_bytes, used_bytes, free_bytes, percent."""
        return None


class _LocalBackend(_StorageBackend):
    """Local disk storage backend."""

    def __init__(self, base_paths):
        self._paths = base_paths
        for p in self._paths.values():
            os.makedirs(p, exist_ok=True)

    def _resolve(self, category, file_id):
        # AUDIT FIX L3: defense-in-depth path-traversal containment.
        # Every backend caller is expected to pass DB-derived UUIDs, but
        # validate strictly + containment-check so any future caller that
        # forwards an unvalidated id cannot escape the storage root.
        _validate_storage_args(category, file_id)
        base = self._paths.get(category)
        if not base:
            raise ValueError(f'Unknown storage category: {category}')
        base_real = os.path.realpath(base)
        candidate = os.path.realpath(os.path.join(base_real, file_id))
        if candidate != base_real and not candidate.startswith(base_real + os.sep):
            raise ValueError(f'PATH TRAVERSAL BLOCKED: {category}/{file_id!r}')
        return os.path.join(base, file_id)

    @staticmethod
    def _fsync_file(path):
        """Flush a file's data + metadata to stable storage.

        AUDIT FIX (upload/download integrity): this used to be
        `except Exception: pass`, which swallowed EIO too. On Linux a failed
        writeback is reported by fsync ONCE and then the error flag is cleared,
        so the swallow meant put_move() went on to os.replace() and returned
        success, /upload committed the row and answered 200 -- the user was told
        the upload succeeded for bytes that never reached stable storage. Real
        I/O errors now propagate so the caller fails the write; only the
        genuinely benign 'this platform/filesystem cannot fsync this object'
        errnos are tolerated."""
        _fsync_path(path, kind='file')

    @staticmethod
    def _fsync_dir(dir_path):
        """Flush a directory entry so a create/rename survives power loss.

        AUDIT FIX (upload/download integrity): see _fsync_file. Directory fsync
        legitimately fails with EINVAL/EACCES/EPERM on some filesystems, so
        those stay tolerated; EIO/ENOSPC/EDQUOT/ENODEV now propagate."""
        _fsync_path(dir_path, kind='dir')

    @staticmethod
    def _new_staging_path(dest):
        """Create a UNIQUE staging path next to `dest` and return it.

        AUDIT FIX (concurrent local writers): put(), put_move() and
        put_data_atomic() all staged to the DETERMINISTIC path `dest + '.tmp'`.
        Two concurrent writes to the same object id therefore interleaved on one
        shared temp file and the first os.replace() published whatever mixture of
        both streams happened to be there -- a silently corrupt payload that the
        writer then reported as a successful, durable write.
        _stage_remote_into_cache() already solved this with mkstemp(); do the
        same here so each writer's staging area is private and os.replace()
        publishes exactly the bytes that writer flushed.

        The '.tmp' suffix is preserved so _is_internal_storage_artifact()
        recognises the file (never replicated) and the temp sweeps still reap a
        leftover from a crashed write."""
        import tempfile as _tempfile_local
        dest_dir = os.path.dirname(dest) or '.'
        tmp_fd, tmp_path = _tempfile_local.mkstemp(
            prefix=f'.{os.path.basename(dest)}.', suffix='.tmp', dir=dest_dir)
        os.close(tmp_fd)
        # mkstemp creates 0600; the previous open()/copy2() staging produced the
        # umask default. Keep the published file's mode unchanged so this fix is
        # purely about uniqueness, not permissions.
        try:
            os.chmod(tmp_path, 0o644)
        except OSError:
            pass
        return tmp_path

    def put(self, category, file_id, local_path):
        # AUDIT FIX P1-2: atomic write via .tmp + os.replace so a crash or
        # concurrent reader never sees a partial file at the destination.
        # AUDIT FIX (durability): fsync the staged data BEFORE the rename and
        # fsync the parent directory AFTER, so a power loss can't leave a
        # replica marked 'synced' (checksum read back from page cache) while the
        # on-disk bytes are truncated/absent.
        dest = self._resolve(category, file_id)
        if os.path.abspath(local_path) == os.path.abspath(dest):
            return
        tmp_path = self._new_staging_path(dest)
        try:
            shutil.copy2(local_path, tmp_path)
            self._fsync_file(tmp_path)
            os.replace(tmp_path, dest)
            self._fsync_dir(os.path.dirname(dest))
        except Exception:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
            raise

    def put_move(self, category, file_id, local_path):
        # AUDIT FIX P1-2: atomic move via .tmp + os.replace. shutil.move
        # falls back to copy+delete across filesystems which is non-atomic;
        # writing to a .tmp sibling on the destination filesystem then
        # os.replace is atomic regardless of the source filesystem.
        # AUDIT FIX (durability): fsync data before rename + parent dir after.
        dest = self._resolve(category, file_id)
        if os.path.abspath(local_path) == os.path.abspath(dest):
            return
        tmp_path = self._new_staging_path(dest)
        try:
            # mkstemp already created the (empty) staging file; os.replace()
            # inside shutil.move overwrites it atomically on the same filesystem
            # and copy2 truncates it on the cross-filesystem fallback.
            shutil.move(local_path, tmp_path)
            self._fsync_file(tmp_path)
            os.replace(tmp_path, dest)
            self._fsync_dir(os.path.dirname(dest))
        except Exception:
            # AUDIT FIX (finding 2): shutil.move has already CONSUMED the
            # staging source once it returns, so deleting tmp_path here turned
            # a post-move fsync/replace failure into permanent data loss —
            # neither the source nor the destination existed afterwards.
            # Preserve a recoverable copy instead: move the staged bytes back
            # to the caller's source path when it is free; if that restore
            # fails, leave the .tmp sibling in place (it is reaped by the age-
            # guarded temp sweep only after 10 minutes) rather than destroying
            # the only remaining copy. Only a tmp file that was never
            # populated (source still present) is safe to remove.
            if os.path.exists(tmp_path):
                if not os.path.exists(local_path):
                    try:
                        shutil.move(tmp_path, local_path)
                    except OSError as restore_err:
                        print(f'[STORAGE] [WARNING] put_move failed and restore to '
                              f'{local_path} also failed ({restore_err}); staged copy '
                              f'left at {tmp_path}')
                else:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
            raise

    def put_data(self, category, file_id, data):
        # AUDIT FIX (durability): fsync the file data + parent directory so a
        # direct write survives power loss.
        dest = self._resolve(category, file_id)
        mode = 'w' if isinstance(data, str) else 'wb'
        with open(dest, mode) as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        self._fsync_dir(os.path.dirname(dest))

    def put_data_atomic(self, category, file_id, data):
        """Write data atomically: write to .tmp file then os.replace() to final path.
        Prevents partial-write corruption on crash or disk-full."""
        dest = self._resolve(category, file_id)
        tmp_path = self._new_staging_path(dest)
        mode = 'w' if isinstance(data, str) else 'wb'
        try:
            with open(tmp_path, mode) as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, dest)
            # AUDIT FIX (durability): fsync the parent directory so the rename
            # itself survives power loss (the file fsync above only covers data).
            self._fsync_dir(os.path.dirname(dest))
        except Exception:
            # Clean up partial temp file on failure
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
            raise

    def get(self, category, file_id, local_path):
        src = self._resolve(category, file_id)
        if os.path.abspath(src) != os.path.abspath(local_path):
            shutil.copy2(src, local_path)

    def get_path(self, category, file_id):
        return self._resolve(category, file_id)

    def get_data(self, category, file_id, mode='rb'):
        path = self._resolve(category, file_id)
        with open(path, mode) as f:
            return f.read()

    def delete(self, category, file_id):
        """Delete a payload. Returns True on success (deleted or already absent),
        False if the on-disk delete failed — callers that delete DB tracking
        rows (e.g. purge_local_copies) MUST check the return value so they do
        not erase tracking while the file still exists on disk (an untracked
        local orphan that cleanup_orphaned_files will not reap because the
        File row still references it)."""
        path = self._resolve(category, file_id)
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError as e:
            print(f'[STORAGE] Failed to delete {path}: {e}')
            return False
        return True

    def exists(self, category, file_id):
        return os.path.exists(self._resolve(category, file_id))

    def size(self, category, file_id):
        path = self._resolve(category, file_id)
        try:
            return os.path.getsize(path)
        except OSError:
            return None

    def checksum(self, category, file_id, use_thread_conn=False):
        """Return the SHA-256 hex digest of the local on-disk copy, or None if
        the file is missing/unreadable. AUDIT FIX F1: without this, read-path
        replica verification silently skipped the local node (no checksum
        method), so same-size local bit-rot could be served instead of failing
        over to a healthy remote replica. use_thread_conn is accepted for
        signature parity with remote backends and ignored."""
        path = self._resolve(category, file_id)
        try:
            return _sha256_file(path)
        except OSError:
            return None

    def rename(self, category, old_id, new_id):
        old_path = self._resolve(category, old_id)
        new_path = self._resolve(category, new_id)
        os.rename(old_path, new_path)

    def list_files(self, category):
        base = self._paths.get(category)
        if not base or not os.path.exists(base):
            return []
        return [f for f in os.listdir(base) if os.path.isfile(os.path.join(base, f))]

    def health_check(self):
        try:
            for p in self._paths.values():
                if not os.path.isdir(p):
                    return False
            return True
        except Exception:
            return False

    def total_size(self, category):
        base = self._paths.get(category)
        if not base or not os.path.exists(base):
            return 0
        total = 0
        for fn in os.listdir(base):
            fp = os.path.join(base, fn)
            if os.path.isfile(fp):
                total += os.path.getsize(fp)
        return total

    def disk_usage(self):
        """Return disk usage for the local filesystem hosting storage files."""
        try:
            # Use the 'files' directory path for the statvfs call
            path = self._paths.get('files', '/')
            disk = shutil.disk_usage(path)
            percent = round((disk.used / disk.total) * 100, 1) if disk.total > 0 else 0
            return {
                'total_bytes': disk.total,
                'used_bytes': disk.used,
                'free_bytes': disk.free,
                'percent': percent
            }
        except Exception as e:
            print(f'[STORAGE] Local disk_usage failed: {e}')
            return None

    def open_file(self, category, file_id, mode='rb'):
        return open(self._resolve(category, file_id), mode)

    def save_upload(self, category, file_id, uploaded_file):
        # AUDIT FIX (finding 13): FileStorage.save() wrote directly to the
        # final path, so a crash / disk-full mid-stream left a truncated file
        # at the canonical location that every reader and the replica
        # bookkeeping treated as complete. Stage to a unique sibling, fsync,
        # then os.replace() atomically (same discipline as put()/put_move()).
        dest = self._resolve(category, file_id)
        tmp_path = self._new_staging_path(dest)
        try:
            uploaded_file.save(tmp_path)
            self._fsync_file(tmp_path)
            os.replace(tmp_path, dest)
            self._fsync_dir(os.path.dirname(dest))
        except Exception:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
            raise

    def getmtime(self, category, file_id):
        return os.path.getmtime(self._resolve(category, file_id))


def _serialize_shared_ssh_connection(use_thread_position=None):
    """Serialize operations that use an SSH backend's shared connection."""
    def decorate(func):
        @functools.wraps(func)
        def wrapped(self, *args, **kwargs):
            use_thread_conn = False
            if use_thread_position is not None:
                if 'use_thread_conn' in kwargs:
                    use_thread_conn = bool(kwargs['use_thread_conn'])
                elif len(args) > use_thread_position:
                    use_thread_conn = bool(args[use_thread_position])
            if use_thread_conn:
                return func(self, *args, **kwargs)
            with self._operation_lock:
                return func(self, *args, **kwargs)
        return wrapped
    return decorate


class _SSHBackend(_StorageBackend):
    """SSH/SFTP remote storage backend using paramiko."""

    def __init__(self, node_config):
        self._config = node_config
        self._transport = None
        self._sftp = None
        self._discovered_host_key_algorithm = None
        self._discovered_host_key_base64 = None
        self._discovered_host_key_fingerprint = None
        # Track whether remote supports atomic rename (assumed true, disabled on first failure)
        self._atomic_rename_supported = True
        # Track whether remote supports sha256sum for post-transfer hash verification
        # None = not yet tested, True = available, False = not available
        self._sha256sum_available = None
        # Thread-local storage for per-thread SFTP connections (used in parallel replication)
        import threading as _threading
        self._thread_local = _threading.local()
        self._lock = _threading.Lock()
        # Paramiko SFTPClient/Transport instances are not safe for concurrent
        # channel use or close. Parallel replication uses per-thread connections
        # and bypasses this lock; all shared-connection operations are serialized.
        self._operation_lock = _threading.RLock()
        self._thread_connections = []

    # SSH socket timeout for initial connect/handshake (seconds).
    _CONNECT_TIMEOUT = 120
    # SSH keepalive interval (seconds). Sends a keepalive packet to detect
    # dead connections even when no data is flowing.
    _KEEPALIVE_INTERVAL = 30
    # Adaptive timeout bounds (seconds)
    _TIMEOUT_SMALL = 30      # thumbnails, notes (<1MB typical)
    _TIMEOUT_DEFAULT = 120   # regular files
    _TIMEOUT_MAX = 1800      # 30 min cap for very large files
    _MIN_BANDWIDTH = 1024 * 1024  # 1 MB/s assumed minimum for timeout estimation

    def _timeout_for_category(self, category, local_path=None):
        """Calculate an adaptive socket timeout based on category and file size.
        Small items (thumbnails, notes) get shorter timeouts to avoid blocking
        the replication thread. Large files get proportionally longer timeouts."""
        if category in ('thumbnails', 'notes'):
            return self._TIMEOUT_SMALL
        if local_path:
            try:
                file_size = os.path.getsize(local_path)
                estimated = max(self._TIMEOUT_DEFAULT, int(file_size / self._MIN_BANDWIDTH) + 30)
                return min(estimated, self._TIMEOUT_MAX)
            except OSError:
                pass
        return self._TIMEOUT_DEFAULT

    def _set_channel_timeout(self, sftp, timeout):
        """Set the SFTP channel timeout for the current operation."""
        try:
            channel = sftp.get_channel()
            if channel:
                channel.settimeout(timeout)
        except Exception:
            pass

    def _normalize_host_key_fingerprint(self, value):
        if value is None:
            return None
        normalized = str(value).strip()
        if not normalized:
            return None
        if normalized.upper().startswith('SHA256:'):
            return 'SHA256:' + normalized.split(':', 1)[1].strip().rstrip('=')
        return normalized.replace(':', '').lower()

    def _fingerprint_for_server_key(self, server_key):
        import base64 as _base64
        import hashlib as _hashlib
        return 'SHA256:' + _base64.b64encode(_hashlib.sha256(server_key.asbytes()).digest()).decode('ascii').rstrip('=')

    def _verify_transport_host_key(self, transport):
        hostname = self._config.get('hostname', 'unknown-host')
        server_key = transport.get_remote_server_key()
        if not server_key:
            raise ValueError(f'SSH SERVER {hostname} DID NOT PRESENT A HOST KEY')
        self._discovered_host_key_algorithm = server_key.get_name()
        self._discovered_host_key_base64 = server_key.get_base64()
        self._discovered_host_key_fingerprint = self._fingerprint_for_server_key(server_key)
        expected_key = (self._config.get('host_key') or '').strip()
        expected_fingerprint = self._normalize_host_key_fingerprint(
            self._config.get('host_key_sha256') or self._config.get('host_key_fingerprint')
        )
        if expected_key and expected_key != self._discovered_host_key_base64:
            raise ValueError(f'SSH HOST KEY MISMATCH FOR {hostname}')
        if expected_fingerprint:
            actual_fingerprint = self._normalize_host_key_fingerprint(self._discovered_host_key_fingerprint)
            if actual_fingerprint != expected_fingerprint:
                raise ValueError(f'SSH HOST KEY FINGERPRINT MISMATCH FOR {hostname}')
        elif not expected_key:
            # AUDIT FIX F-5: no host key pinned. Refuse in strict mode (closes the
            # first-connect MITM window); otherwise trust-on-first-use as before.
            if STORAGE_SSH_STRICT_HOST_KEY:
                raise ValueError(
                    f'SSH HOST KEY NOT PINNED FOR {hostname} AND STRICT MODE IS ENABLED '
                    f'(set STORAGE_SSH_STRICT_HOST_KEY=false or pin the host key via test connection)'
                )
            print(f'[STORAGE] SSH node {hostname} has no pinned host key fingerprint yet; trusting first successful connection')

    def _authenticate_transport(self, transport, username):
        import paramiko
        auth_method = str(self._config.get('auth_method') or 'password').strip().lower()
        if auth_method not in ('password', 'key'):
            raise ValueError('INVALID SSH AUTH_METHOD. MUST BE: password, key')
        if auth_method == 'key':
            key_data = self._config.get('key_data')
            key_path = self._config.get('key_path')
            key_passphrase = self._config.get('key_passphrase')
            # AUDIT FIX (finding 14): the loader was hard-wired to
            # paramiko.RSAKey, so a perfectly valid Ed25519 or ECDSA private
            # key configured by the operator failed with a cryptic parser
            # error. Try every key type paramiko knows, in strength/freshness
            # order; only a key no candidate can parse is rejected.
            if key_data:
                import io as _io
                pkey = self._load_paramiko_private_key(
                    lambda cls: cls.from_private_key(_io.StringIO(key_data),
                                                     password=key_passphrase))
            elif key_path:
                pkey = self._load_paramiko_private_key(
                    lambda cls: cls.from_private_key_file(key_path,
                                                          password=key_passphrase))
            else:
                raise ValueError('SSH KEY AUTH SELECTED BUT NO PRIVATE KEY DATA OR KEY PATH WAS PROVIDED')
            transport.auth_publickey(username, pkey)
        else:
            password = self._config.get('password', '')
            transport.auth_password(username, password)

    @staticmethod
    def _load_paramiko_private_key(opener):
        """AUDIT FIX (finding 14): parse a private key with Ed25519, ECDSA and
        RSA candidates (whichever paramiko version provides) instead of RSA
        only. `opener(cls)` attempts one key class; per-candidate parse errors
        are collected and only re-raised when no candidate succeeded."""
        import paramiko
        errors = []
        for key_type in ('Ed25519Key', 'ECDSAKey', 'RSAKey'):
            key_cls = getattr(paramiko, key_type, None)
            if key_cls is None:
                continue
            try:
                return opener(key_cls)
            except Exception as e:
                errors.append(f'{key_type}: {e}')
        raise ValueError(
            'UNSUPPORTED OR CORRUPT SSH PRIVATE KEY (expected OpenSSH Ed25519/ECDSA/RSA; '
            + '; '.join(errors)[:400] + ')'
        )

    def get_discovered_host_key_fingerprint(self):
        return self._discovered_host_key_fingerprint

    def get_discovered_host_key_algorithm(self):
        return self._discovered_host_key_algorithm

    @_serialize_shared_ssh_connection()
    def _connect(self):
        if self._sftp is not None:
            try:
                self._sftp.stat('.')
                return self._sftp
            except Exception:
                self._close()
        import paramiko
        import socket as _socket
        hostname = self._config['hostname']
        port = self._config.get('port', 22)
        username = self._config['username']
        remote_base = self._config.get('remote_path', '/opt/onegy-storage')
        # Create a socket with a connect timeout to avoid blocking forever
        sock = _socket.create_connection((hostname, port), timeout=self._CONNECT_TIMEOUT)
        try:
            self._transport = paramiko.Transport(sock)
            self._transport.set_keepalive(self._KEEPALIVE_INTERVAL)
            self._transport.start_client(timeout=self._CONNECT_TIMEOUT)
            self._verify_transport_host_key(self._transport)
            self._authenticate_transport(self._transport, username)
            self._sftp = paramiko.SFTPClient.from_transport(self._transport)
        except Exception:
            try:
                sock.close()
            except Exception:
                pass
            self._close()
            raise
        # Set a default channel timeout
        self._set_channel_timeout(self._sftp, self._TIMEOUT_DEFAULT)
        for cat in ('files', 'notes', 'thumbnails'):
            cat_path = f'{remote_base}/{cat}'
            try:
                self._sftp.stat(cat_path)
            except FileNotFoundError:
                self._mkdir_p(cat_path)
        return self._sftp

    def _connect_thread(self):
        """Get or create a per-thread SFTP connection for parallel replication."""
        sftp = getattr(self._thread_local, 'sftp', None)
        transport = getattr(self._thread_local, 'transport', None)
        if sftp is not None:
            try:
                sftp.stat('.')
                return sftp
            except Exception:
                self._close_thread()
        import paramiko
        import socket as _socket
        hostname = self._config['hostname']
        port = self._config.get('port', 22)
        username = self._config['username']
        remote_base = self._config.get('remote_path', '/opt/onegy-storage')
        sock = _socket.create_connection((hostname, port), timeout=self._CONNECT_TIMEOUT)
        try:
            transport = paramiko.Transport(sock)
            transport.set_keepalive(self._KEEPALIVE_INTERVAL)
            transport.start_client(timeout=self._CONNECT_TIMEOUT)
            self._verify_transport_host_key(transport)
            self._authenticate_transport(transport, username)
            sftp = paramiko.SFTPClient.from_transport(transport)
        except Exception:
            try:
                sock.close()
            except Exception:
                pass
            try:
                transport.close()
            except Exception:
                pass
            raise
        try:
            self._set_channel_timeout(sftp, self._TIMEOUT_DEFAULT)
            for cat in ('files', 'notes', 'thumbnails'):
                cat_path = f'{remote_base}/{cat}'
                try:
                    sftp.stat(cat_path)
                except FileNotFoundError:
                    self._mkdir_p_sftp(sftp, cat_path)
        except Exception:
            # Not tracked yet, so neither _close_thread() nor close_all_threads()
            # would ever reach these handles.
            for handle in (sftp, transport):
                try:
                    handle.close()
                except Exception:
                    pass
            raise
        self._thread_local.sftp = sftp
        self._thread_local.transport = transport
        with self._lock:
            self._thread_connections.append((sftp, transport))
        return sftp

    def _close_thread(self):
        """Close the per-thread SFTP connection."""
        sftp = getattr(self._thread_local, 'sftp', None)
        transport = getattr(self._thread_local, 'transport', None)
        with self._lock:
            self._thread_connections = [
                (tracked_sftp, tracked_transport)
                for tracked_sftp, tracked_transport in self._thread_connections
                if tracked_sftp is not sftp and tracked_transport is not transport
            ]
        if sftp:
            try:
                sftp.close()
            except Exception:
                pass
            self._thread_local.sftp = None
        if transport:
            try:
                transport.close()
            except Exception:
                pass
            self._thread_local.transport = None

    def close_all_threads(self):
        """Close all thread-local connections. Called after parallel replication cycle."""
        with self._lock:
            connections = self._thread_connections[:]
            self._thread_connections = []
        for sftp, transport in connections:
            try:
                sftp.close()
            except Exception:
                pass
            try:
                transport.close()
            except Exception:
                pass
        self._close_thread()

    def _mkdir_p(self, remote_path):
        self._mkdir_p_sftp(self._sftp, remote_path)

    def _mkdir_p_sftp(self, sftp, remote_path):
        dirs_to_create = []
        path = remote_path
        while True:
            try:
                sftp.stat(path)
                break
            except FileNotFoundError:
                dirs_to_create.append(path)
                parent = os.path.dirname(path)
                if parent == path:
                    break
                path = parent
        for d in reversed(dirs_to_create):
            try:
                sftp.mkdir(d)
            except Exception:
                pass

    @_serialize_shared_ssh_connection()
    def _close(self):
        if self._sftp:
            try:
                self._sftp.close()
            except Exception:
                pass
            self._sftp = None
        if self._transport:
            try:
                self._transport.close()
            except Exception:
                pass
            self._transport = None

    def _remote_path(self, category, file_id):
        # AUDIT FIX C2/M1: strict validation prevents path traversal in
        # remote keys and shell metacharacters reaching ssh exec commands.
        _validate_storage_args(category, file_id)
        remote_base = self._config.get('remote_path', '/opt/onegy-storage')
        if '..' in str(remote_base) or '\x00' in str(remote_base):
            raise ValueError(f'UNSAFE SSH REMOTE_BASE: {remote_base!r}')
        return f'{remote_base}/{category}/{file_id}'

    @_serialize_shared_ssh_connection(use_thread_position=1)
    def _remote_sha256(self, remote_path, use_thread_conn=False):
        """Execute sha256sum on the remote host and return the hex digest.
        Uses the SSH transport's exec channel (separate from SFTP).
        Caches availability — if sha256sum is not found on the remote,
        logs one warning per node lifetime and returns None for all future calls."""
        if self._sha256sum_available is False:
            return None
        try:
            if use_thread_conn:
                transport = getattr(self._thread_local, 'transport', None)
            else:
                transport = self._transport
            if not transport or not transport.is_active():
                return None
            # AUDIT FIX C2: shlex.quote() the path so $, backticks, quotes,
            # and backslashes embedded in remote_path (or in admin-configured
            # remote_base) cannot break out of the argument and execute
            # arbitrary commands on the SSH host.
            import shlex as _shlex_ssh
            quoted_path = _shlex_ssh.quote(remote_path)
            # Try sha256sum first, fall back to shasum -a 256
            for cmd in (f'sha256sum {quoted_path}', f'shasum -a 256 {quoted_path}'):
                channel = transport.open_session()
                try:
                    channel.settimeout(300)  # 5 min timeout for hashing large files
                    channel.exec_command(cmd)
                    # recv_exit_status() waits forever (settimeout does not apply
                    # to it), so a stalled remote filesystem would hang this thread.
                    if not channel.status_event.wait(300):
                        raise TimeoutError(f'{cmd.split()[0]} did not exit within 300s')
                    exit_status = channel.recv_exit_status()
                    if exit_status == 0:
                        stdout = channel.makefile('r').read().strip()
                        # Paramiko may return bytes — ensure we have a str
                        if isinstance(stdout, bytes):
                            stdout = stdout.decode('utf-8', errors='replace')
                        # sha256sum output format: "<hash>  <path>" or "<hash> *<path>"
                        hex_digest = stdout.split()[0] if stdout else None
                        if hex_digest and len(hex_digest) == 64:
                            self._sha256sum_available = True
                            return hex_digest
                    # Exit status 127 = command not found; try next command
                    stderr = channel.makefile_stderr('r').read().strip()
                    if isinstance(stderr, bytes):
                        stderr = stderr.decode('utf-8', errors='replace')
                    if exit_status == 127 or 'not found' in stderr.lower():
                        continue
                    # Other non-zero exit (e.g. file not found) — don't try fallback
                    return None
                finally:
                    channel.close()
            # Neither sha256sum nor shasum found on remote
            self._sha256sum_available = False
            hostname = self._config.get('hostname', '?')
            print(f'[STORAGE] SSH node {hostname}: sha256sum/shasum not available on remote — '
                  f'hash verification disabled for this node (size verification still active)')
            return None
        except Exception as e:
            print(f'[STORAGE] SSH remote sha256 exec failed for {remote_path}: {e}')
            return None

    @_serialize_shared_ssh_connection(use_thread_position=2)
    def checksum(self, category, file_id, use_thread_conn=False):
        """Return the remote SHA-256 hex digest when available, else None."""
        return self._remote_sha256(
            self._remote_path(category, file_id),
            use_thread_conn=use_thread_conn,
        )

    def _verify_remote_hash(self, remote_file_path, local_hash, use_thread_conn, label):
        """Compare local_hash against a remote sha256sum result.

        Returns True ONLY when a remote hash was actually computed FOR THIS
        OBJECT and matched. Returns False when the remote hash could not be
        obtained (sha256sum absent, transport inactive, exec failed, non-zero
        exit) -- the transfer is then accepted on the size check alone.
        Raises IOError on a definite hash mismatch.

        AUDIT FIX (per-object checksum confirmation): this used to return None
        in both the "matched" and the "could not check" cases, and put() then
        inferred confirmation from the NODE-WIDE `_sha256sum_available` flag.
        _remote_sha256() returns None on ANY exception, on a non-zero non-127
        exit, and when the transport is inactive -- none of which reset that
        flag. So once a single earlier file had hashed successfully on the node,
        every later transfer whose hash call merely FAILED was reported as
        checksum-confirmed, stamping a replica 'synced' with a checksum the
        server never verified (which then qualified as a read source and passed
        the scrub precheck). Confirmation is now per-object evidence only."""
        if not local_hash:
            return False
        remote_hash = self._remote_sha256(remote_file_path, use_thread_conn=use_thread_conn)
        if remote_hash is None:
            return False  # hash unobtainable for THIS object — fall back to size-only
        if remote_hash != local_hash:
            raise IOError(
                f'SFTP SHA-256 mismatch after {label}: local={local_hash}, remote={remote_hash}'
            )
        return True

    @_serialize_shared_ssh_connection(use_thread_position=3)
    def put(self, category, file_id, local_path, use_thread_conn=False,
            verify_checksum=False, local_hash=None):
        """Upload a file to the remote via SFTP.
        Uses atomic temp-file + rename to prevent partial/corrupt files on the remote.
        Falls back to direct overwrite if the remote filesystem doesn't support rename.
        After transfer, verifies the remote file size matches the local source.
        If verify_checksum=True and local_hash is provided, also verifies the SHA-256
        hash by running sha256sum on the remote host and comparing."""
        if _is_internal_storage_artifact(file_id):
            raise ValueError(f'REFUSING TO UPLOAD INTERNAL STORAGE ARTIFACT: {category}/{file_id}')
        # AUDIT FIX (per-object checksum confirmation): tracks whether THIS
        # object's remote hash was actually computed and matched. Never inferred
        # from a node-wide capability flag.
        _hash_confirmed = False
        try:
            sftp = self._connect_thread() if use_thread_conn else self._connect()
            timeout = self._timeout_for_category(category, local_path)
            self._set_channel_timeout(sftp, timeout)
            final_path = self._remote_path(category, file_id)
            local_size = os.path.getsize(local_path)

            if self._atomic_rename_supported:
                # Atomic write: upload to .tmp file, then rename
                import secrets as _secrets
                tmp_suffix = _secrets.token_hex(4)
                tmp_path = f'{final_path}.tmp.{tmp_suffix}'
                try:
                    sftp.put(local_path, tmp_path)
                    # Verify size before rename
                    remote_stat = sftp.stat(tmp_path)
                    if remote_stat.st_size != local_size:
                        try:
                            sftp.remove(tmp_path)
                        except Exception:
                            pass
                        raise IOError(f'SFTP size mismatch after upload: local={local_size}, remote={remote_stat.st_size}')
                    # Verify SHA-256 hash on remote before rename (if enabled)
                    if verify_checksum and local_hash:
                        try:
                            _hash_confirmed = self._verify_remote_hash(
                                tmp_path, local_hash, use_thread_conn, 'upload')
                        except IOError:
                            try:
                                sftp.remove(tmp_path)
                            except Exception:
                                pass
                            raise
                    # AUDIT FIX P1-3: best-effort fsync of the temp file
                    # before the atomic rename, so the data is durable on
                    # the remote filesystem before the old file is replaced.
                    # Paramiko's SFTPClient exposes fsync() on newer versions;
                    # if unavailable, the size/hash verification above is the
                    # remaining safeguard.
                    try:
                        sftp.fsync(tmp_path)
                    except (AttributeError, IOError, OSError):
                        pass
                    # Atomic rename (POSIX rename overwrites existing file atomically)
                    try:
                        sftp.posix_rename(tmp_path, final_path)
                    except (AttributeError, IOError, OSError) as posix_err:
                        # A regular SFTP rename is safe only for a new key. Never
                        # remove or overwrite a known-good destination merely
                        # because atomic replacement is unavailable.
                        destination_missing = False
                        try:
                            sftp.stat(final_path)
                        except FileNotFoundError:
                            destination_missing = True
                        except OSError as stat_err:
                            destination_missing = stat_err.errno == 2
                        if not destination_missing:
                            try:
                                sftp.remove(tmp_path)
                            except Exception:
                                pass
                            raise IOError(
                                f'SFTP atomic replacement unavailable; existing destination preserved: {final_path}'
                            ) from posix_err
                        try:
                            sftp.rename(tmp_path, final_path)
                        except Exception as rename_err:
                            try:
                                sftp.remove(tmp_path)
                            except Exception:
                                pass
                            raise IOError(f'SFTP rename failed for new destination: {rename_err}') from rename_err
                except Exception:
                    # Clean up temp file on any transfer failure (IOError included:
                    # it aliases OSError, so most SFTP failures land here).
                    try:
                        sftp.remove(tmp_path)
                    except Exception:
                        pass
                    raise
            else:
                # Direct write (fallback when atomic rename is not supported)
                sftp.put(local_path, final_path)
                remote_stat = sftp.stat(final_path)
                if remote_stat.st_size != local_size:
                    try:
                        sftp.remove(final_path)
                    except Exception:
                        pass
                    raise IOError(f'SFTP size mismatch after upload: local={local_size}, remote={remote_stat.st_size}')
                # Verify hash after direct write
                if verify_checksum and local_hash:
                    try:
                        _hash_confirmed = self._verify_remote_hash(
                            final_path, local_hash, use_thread_conn, 'upload (direct)')
                    except IOError:
                        try:
                            sftp.remove(final_path)
                        except Exception:
                            pass
                        raise
        except Exception:
            if use_thread_conn:
                self._close_thread()
            else:
                self._close()
            raise
        # AUDIT FIX (per-object checksum confirmation): report ONLY what was
        # proven for THIS object. Previously this returned
        # `self._sha256sum_available is True`, a NODE-WIDE latch that stayed True
        # after a single earlier success, so any later transfer whose hash call
        # transiently failed was reported as checksum-confirmed. `_hash_confirmed`
        # is set exclusively by the _verify_remote_hash() call that ran for this
        # object and returned a genuine match.
        if verify_checksum and local_hash and not _hash_confirmed:
            hostname = self._config.get('hostname', '?')
            print(f'[STORAGE] [WARNING] SSH node {hostname}: {category}/{file_id} accepted with '
                  f'SIZE-ONLY verification (remote SHA-256 could not be computed for this object)')
        return bool(_hash_confirmed)

    @_serialize_shared_ssh_connection(use_thread_position=3)
    def get(self, category, file_id, local_path, use_thread_conn=False,
            verify_checksum=False):
        """Download a file from the remote via SFTP.
        Uses atomic temp-file + rename locally to prevent serving partial downloads.
        Verifies downloaded file size matches the remote source.
        If verify_checksum=True, also computes SHA-256 of the downloaded file and
        compares against a remote sha256sum of the source file."""
        try:
            sftp = self._connect_thread() if use_thread_conn else self._connect()
            timeout = self._timeout_for_category(category, local_path)
            self._set_channel_timeout(sftp, timeout)
            remote_path = self._remote_path(category, file_id)
            remote_stat = sftp.stat(remote_path)
            remote_size = remote_stat.st_size
            # Download to a UNIQUE temp sibling first, then rename locally
            # (atomic local write). AUDIT FIX (finding 12): the old fixed
            # '.sftp_tmp' name let two concurrent downloads of the same
            # destination clobber one shared staging file.
            tmp_local = _unique_download_tmp_path(local_path)
            try:
                sftp.get(remote_path, tmp_local)
                local_size = os.path.getsize(tmp_local)
                if local_size != remote_size:
                    try:
                        os.remove(tmp_local)
                    except OSError:
                        pass
                    raise IOError(f'SFTP size mismatch after download: remote={remote_size}, local={local_size}')
                # Verify SHA-256 hash: compute locally on downloaded file, compare against remote
                if verify_checksum:
                    local_hash = _sha256_file(tmp_local)
                    remote_hash = self._remote_sha256(remote_path, use_thread_conn=use_thread_conn)
                    if remote_hash is not None and local_hash != remote_hash:
                        try:
                            os.remove(tmp_local)
                        except OSError:
                            pass
                        raise IOError(f'SFTP SHA-256 mismatch after download: local={local_hash}, remote={remote_hash}')
                # Atomic local rename
                os.replace(tmp_local, local_path)
            except Exception:
                try:
                    os.remove(tmp_local)
                except OSError:
                    pass
                raise
        except Exception:
            if use_thread_conn:
                self._close_thread()
            else:
                self._close()
            raise

    @_serialize_shared_ssh_connection()
    def delete(self, category, file_id):
        try:
            sftp = self._connect()
            sftp.remove(self._remote_path(category, file_id))
        except FileNotFoundError:
            pass

    @_serialize_shared_ssh_connection()
    def exists(self, category, file_id):
        try:
            sftp = self._connect()
            sftp.stat(self._remote_path(category, file_id))
            return True
        except FileNotFoundError:
            return False
        except Exception:
            return False

    @_serialize_shared_ssh_connection()
    def exists_verified(self, category, file_id):
        """Like exists() but raises on connection errors instead of returning False.
        Returns True if found, False if confirmed missing.
        Raises Exception if the remote is unreachable (cannot determine status)."""
        sftp = self._connect()
        try:
            sftp.stat(self._remote_path(category, file_id))
            return True
        except FileNotFoundError:
            return False

    @_serialize_shared_ssh_connection()
    def size(self, category, file_id):
        try:
            sftp = self._connect()
            stat = sftp.stat(self._remote_path(category, file_id))
            return stat.st_size
        except Exception:
            return None

    @_serialize_shared_ssh_connection()
    def list_files(self, category):
        try:
            sftp = self._connect()
            remote_base = self._config.get('remote_path', '/opt/onegy-storage')
            return sftp.listdir(f'{remote_base}/{category}')
        except Exception as e:
            if getattr(e, 'errno', None) == 2:
                return []  # category directory not created yet
            # Never report a failed listing as an empty one.
            raise IOError(f'SSH listing failed for {category}: {e}') from e

    @_serialize_shared_ssh_connection()
    def health_check(self):
        try:
            sftp = self._connect()
            sftp.stat('.')
            return True
        except Exception:
            return False

    @_serialize_shared_ssh_connection()
    def disk_usage(self):
        """Return disk usage for the remote filesystem via SSH df command."""
        try:
            # Do not open a fresh SSH connection just to render admin metrics;
            # slow/offline SSH nodes must not block the disk-usage API.
            if not self._transport or not self._transport.is_active():
                return None
            remote_base = self._config.get('remote_path', '/opt/onegy-storage')
            if '..' in str(remote_base) or '\x00' in str(remote_base):
                return None
            # AUDIT FIX C2: shlex.quote to prevent command injection via the
            # admin-configured remote_base (which is user-controlled string).
            import shlex as _shlex_du
            cmd = f'df -P -k {_shlex_du.quote(remote_base)} | tail -1'
            channel = self._transport.open_session()
            try:
                channel.settimeout(15)
                channel.exec_command(cmd)
                if not channel.status_event.wait(15):
                    raise TimeoutError('df did not exit within 15s')
                exit_status = channel.recv_exit_status()
                if exit_status != 0:
                    return None
                stdout = channel.makefile('r').read().strip()
                if isinstance(stdout, bytes):
                    stdout = stdout.decode('utf-8', errors='replace')
                # df -P output: Filesystem 1024-blocks Used Available Capacity Mounted-on
                parts = stdout.split()
                if len(parts) < 4:
                    return None
                total_kb = int(parts[1])
                used_kb = int(parts[2])
                avail_kb = int(parts[3])
                total = total_kb * 1024
                used = used_kb * 1024
                free = avail_kb * 1024
                percent = round((used / total) * 100, 1) if total > 0 else 0
                return {
                    'total_bytes': total,
                    'used_bytes': used,
                    'free_bytes': free,
                    'percent': percent
                }
            finally:
                channel.close()
        except Exception as e:
            hostname = self._config.get('hostname', '?')
            print(f'[STORAGE] SSH disk_usage failed for {hostname}: {e}')
            return None


