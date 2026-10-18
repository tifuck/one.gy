# AUDIT FIX (upload/download integrity): errnos that mean "this object cannot be
# fsynced on this platform/filesystem", as opposed to "the write FAILED". Only
# these may be tolerated -- anything else (EIO, ENOSPC, EDQUOT, ENODEV, ...) is a
# real durability failure the caller must see. Directory fsync is additionally
# allowed to fail with EACCES/EPERM/EISDIR/EBADF because several filesystems and
# container runtimes reject O_RDONLY fsync on directories outright.
import errno as _errno_fsync
_FSYNC_BENIGN_FILE_ERRNOS = frozenset(
    e for e in (
        _errno_fsync.EINVAL,
        getattr(_errno_fsync, 'ENOTSUP', None),
        getattr(_errno_fsync, 'EOPNOTSUPP', None),
        getattr(_errno_fsync, 'ENOSYS', None),
    ) if e is not None
)
_FSYNC_BENIGN_DIR_ERRNOS = _FSYNC_BENIGN_FILE_ERRNOS | frozenset(
    e for e in (
        _errno_fsync.EACCES,
        _errno_fsync.EPERM,
        _errno_fsync.EISDIR,
        _errno_fsync.EBADF,
    ) if e is not None
)


def _fsync_path(path, kind='file'):
    """fsync a file or directory, propagating REAL I/O failures.

    Raises OSError when the flush genuinely failed, so the caller can fail the
    write instead of acknowledging bytes that never reached stable storage."""
    benign = _FSYNC_BENIGN_DIR_ERRNOS if kind == 'dir' else _FSYNC_BENIGN_FILE_ERRNOS
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError as e:
        if e.errno in benign:
            print(f'[WARNING] Could not open {kind} {path} for fsync (errno {e.errno}); treating as unsupported')
            return
        print(f'[ERROR] Cannot open {kind} {path} to flush it to stable storage: {e}')
        raise
    try:
        os.fsync(fd)
    except OSError as e:
        if e.errno in benign:
            print(f'[WARNING] fsync unsupported for {kind} {path} (errno {e.errno}); continuing')
            return
        print(f'[ERROR] fsync FAILED for {kind} {path}: {e} -- the write is NOT durable')
        raise
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _sha256_file(path):
    """Compute SHA-256 hex digest of a file in 64MB chunks (memory-safe).
    Module-level helper used by storage backends and the replication manager."""
    import hashlib as _hashlib
    h = _hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            chunk = f.read(64 * 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _unique_download_tmp_path(final_path):
    """AUDIT FIX (finding 12): unique staging sibling for downloads.

    The old deterministic names (`<path>.sftp_tmp` / `<path>.s3_tmp`) let two
    concurrent downloads of the SAME final path interleave on one shared temp
    file: whichever os.replace() ran first published a mixture of both
    streams, and the second writer's rename then failed or published garbage.
    A pid+random middle keeps every writer's staging file private while the
    '.tmp' suffix preserves internal-artifact recognition (never replicated)
    and the temp-sweep reaping."""
    return f'{final_path}.{os.getpid()}.{uuid.uuid4().hex}.tmp'


# AUDIT FIX (health-probe artifact): '.health_probe' is the object
# _S3Backend.health_check() writes and then deletes as its tier-3 reachability
# probe. If that delete throws (throttle, transient 5xx) the key persists.
# Because it was not recognised as an internal artifact, NO cleanup path removed
# it on a non-versioned node, while a B2 node classified the very same key as an
# `orphan_key` and purged it -- inconsistent handling of an object we ourselves
# created. Recognising it here makes every backend treat it as an internal
# artifact: refuse to replicate it, and purge it during remote cleanup.
_INTERNAL_STORAGE_ARTIFACT_PREFIXES = ('.cache_', '.remote_', 'repl_', '.health_probe')
_INTERNAL_STORAGE_ARTIFACT_SUFFIXES = ('.sftp_tmp', '.s3_tmp', '.tmp', '.new', '.committed', '.meta',
                                       '.health_probe')

# AUDIT FIX C2/M1/L3: Strict object-id and category validators used throughout
# the storage layer to defend against path traversal in remote keys, SSH shell
# argument injection, and arbitrary local file overwrites via _LocalBackend.
_VALID_STORAGE_CATEGORIES = frozenset(('files', 'notes', 'thumbnails'))
import re as _re_storage_validate
# Allowed file_id chars: hex/uuid + dot/dash/underscore + colon (used as
# `<file_id>:<thumb_type>` for pending replicas). No slashes, no `..`, no
# whitespace, no shell metacharacters.
_VALID_STORAGE_FILE_ID = _re_storage_validate.compile(r'^[A-Za-z0-9._\-:]{1,128}$')


def _validate_storage_category(category):
    if category not in _VALID_STORAGE_CATEGORIES:
        raise ValueError(f'INVALID STORAGE CATEGORY: {category!r}')


def _validate_storage_file_id(file_id):
    """Strict whitelist validation for any object identifier passed to a
    storage backend. Rejects path traversal, slashes, and shell metacharacters.
    Empty/None is rejected. Length is bounded.
    """
    if file_id is None:
        raise ValueError('STORAGE FILE_ID IS REQUIRED')
    sval = str(file_id)
    if '..' in sval or '\x00' in sval:
        raise ValueError(f'UNSAFE STORAGE FILE_ID: {sval!r}')
    if not _VALID_STORAGE_FILE_ID.match(sval):
        raise ValueError(f'INVALID STORAGE FILE_ID: {sval!r}')


def _validate_storage_args(category, file_id):
    _validate_storage_category(category)
    _validate_storage_file_id(file_id)


# AUDIT FIX H1: SSRF defense. Admin-configured storage node hostnames and S3
# endpoint_urls would otherwise allow the server to issue arbitrary outbound
# connections to internal/metadata services. We reject loopback, link-local,
# multicast, broadcast, and private-range targets unless an explicit env-var
# allowlist is set (e.g. `STORAGE_NODE_ALLOW_PRIVATE_HOSTS=true` for
# intra-LAN deployments).
STORAGE_NODE_ALLOW_PRIVATE_HOSTS = os.environ.get(
    'STORAGE_NODE_ALLOW_PRIVATE_HOSTS', 'true'
).strip().lower() in ('1', 'true', 'yes')

# AUDIT FIX F-5 (5th audit): optional strict SSH host-key checking. By default
# (false) an SSH node with no pinned host key is trusted on first connection
# (trust-on-first-use) and the discovered key is pinned afterwards — preserving
# existing behaviour. When STORAGE_SSH_STRICT_HOST_KEY=true, a connection to an
# SSH node that has NO pinned host_key / host_key_sha256 is refused, closing the
# first-connect MITM window for high-security deployments. Operators must pin the
# key at add time (test_connection discovers + pins it) before strict applies.
STORAGE_SSH_STRICT_HOST_KEY = os.environ.get(
    'STORAGE_SSH_STRICT_HOST_KEY', 'false'
).strip().lower() in ('1', 'true', 'yes')

# AUDIT FIX (finding 15): plaintext HTTP S3 endpoints used to be accepted by
# DEFAULT whenever STORAGE_NODE_ALLOW_PRIVATE_HOSTS was true (its default) —
# credentials and payloads then crossed the network unencrypted. Transport
# security is now gated by its OWN explicit opt-in, independent of the private
# host allowlist: set STORAGE_S3_ALLOW_HTTP=true to intentionally allow an
# unencrypted endpoint (the typical local MinIO deployment). https:// remains
# allowed regardless, and STORAGE_NODE_ALLOW_PRIVATE_HOSTS continues to
# control only WHO the node may connect to, not WHETHER it is encrypted.
STORAGE_S3_ALLOW_HTTP = os.environ.get(
    'STORAGE_S3_ALLOW_HTTP', 'false'
).strip().lower() in ('1', 'true', 'yes')


def _s3_endpoint_scheme_error(endpoint_url):
    """Return an error string when the S3 endpoint URL must be rejected,
    else None. Enforced at node create/update AND in _S3Backend.__init__ so a
    pre-existing http:// config row cannot silently keep running unencrypted."""
    value = str(endpoint_url or '').strip()
    if not value:
        return None
    if not (value.startswith('https://') or value.startswith('http://')):
        return 'S3 ENDPOINT_URL MUST INCLUDE A SCHEME'
    if value.startswith('http://') and not STORAGE_S3_ALLOW_HTTP:
        return ('PLAINTEXT HTTP S3 ENDPOINT REJECTED — set STORAGE_S3_ALLOW_HTTP=true '
                'to explicitly allow unencrypted S3 endpoints (e.g. a local MinIO instance)')
    return None


def _validate_local_node_addition(existing_local_count, config):
    """AUDIT FIX (finding 1): fail-safe validation for adding a 'local' node.

    _create_backend() binds every 'local' row to the SAME canonical local
    backend, so an additional local node would claim replicas that share one
    disk (false replica verification, unsafe node-removal decisions). Reject
    the addition outright; also reject a config 'path' that differs from the
    real upload folder, because such a path is silently IGNORED and would
    mislead the operator into believing writes land elsewhere."""
    if existing_local_count > 0:
        return ('ADDITIONAL LOCAL STORAGE NODE REJECTED: a second local node would alias the '
                'same primary disk and report false replicas. Add an SSH or S3 node instead')
    path = str((config or {}).get('path') or '').strip()
    if path:
        return ('LOCAL NODE CONFIG PATH IS NOT SUPPORTED: the local node always stores in the '
                'server upload directory; remove the "path" setting or add an SSH/S3 node for '
                'a separate storage location')
    return None


def _validate_storage_node_host(host_or_url):
    """Validate that the given hostname or URL does not target a
    metadata/internal endpoint. Returns (ok, reason). If reason is non-empty,
    the host was rejected; ok is False in that case.

    By default we ALLOW RFC1918 private targets because the typical ONE.GY
    deployment replicates between hosts on the same LAN; this behaviour is
    controlled by STORAGE_NODE_ALLOW_PRIVATE_HOSTS. Cloud-metadata endpoints
    (169.254.169.254 in particular) and obviously-unsafe targets (loopback,
    multicast, link-local) are always rejected unless the operator has flipped
    the explicit env override.
    """
    import ipaddress as _ipaddress_ssrf
    from urllib.parse import urlparse as _urlparse_ssrf
    if not host_or_url:
        return False, 'EMPTY HOSTNAME'
    value = str(host_or_url).strip()
    if not value:
        return False, 'EMPTY HOSTNAME'
    # If a full URL was supplied (S3 endpoint_url), parse host out of it.
    if '://' in value:
        try:
            parsed = _urlparse_ssrf(value)
        except Exception:
            return False, 'MALFORMED URL'
        host = parsed.hostname
    else:
        host = value
    if not host:
        return False, 'EMPTY HOSTNAME'
    host = host.strip().lower()
    if host in ('localhost', 'localhost.localdomain'):
        return False, 'LOOPBACK HOSTNAME NOT ALLOWED'
    # If it's an IP literal, run it through ipaddress to classify.
    try:
        ip = _ipaddress_ssrf.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None and getattr(ip, 'ipv4_mapped', None):
        ip = ip.ipv4_mapped  # ::ffff:127.0.0.1 is 127.0.0.1
    if ip is not None:
        # Cloud-metadata endpoints are ALWAYS rejected. They route to the
        # hypervisor, not the network, so even an opt-in private allowlist
        # should not unlock them.
        if str(ip) == '169.254.169.254' or str(ip) == 'fd00:ec2::254':
            return False, 'CLOUD METADATA ENDPOINT NOT ALLOWED'
        if ip.is_loopback or ip.is_multicast or ip.is_unspecified or ip.is_link_local:
            return False, 'LOOPBACK/MULTICAST/LINK-LOCAL ADDRESS NOT ALLOWED'
        if (ip.is_private or ip.is_reserved) and not STORAGE_NODE_ALLOW_PRIVATE_HOSTS:
            return False, ('PRIVATE/RESERVED ADDRESS NOT ALLOWED — set '
                           'STORAGE_NODE_ALLOW_PRIVATE_HOSTS=true to opt in for LAN deployments')
        return True, None
    # Hostname: resolve to detect metadata/loopback targets that are merely
    # disguised by a DNS name. Use getaddrinfo to also catch IPv6.
    try:
        import socket as _socket_ssrf
        infos = _socket_ssrf.getaddrinfo(host, None)
    except Exception:
        return False, 'HOSTNAME COULD NOT BE RESOLVED'
    seen = set()
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        ip_str = sockaddr[0]
        if ip_str in seen:
            continue
        seen.add(ip_str)
        try:
            ip = _ipaddress_ssrf.ip_address(ip_str.split('%', 1)[0])
        except ValueError:
            continue
        if getattr(ip, 'ipv4_mapped', None):
            ip = ip.ipv4_mapped
        if str(ip) in ('169.254.169.254', 'fd00:ec2::254'):
            return False, f'HOSTNAME RESOLVES TO CLOUD METADATA ENDPOINT ({ip})'
        if ip.is_loopback or ip.is_multicast or ip.is_unspecified or ip.is_link_local:
            return False, f'HOSTNAME RESOLVES TO LOOPBACK/MULTICAST/LINK-LOCAL ({ip})'
        if (ip.is_private or ip.is_reserved) and not STORAGE_NODE_ALLOW_PRIVATE_HOSTS:
            return False, (f'HOSTNAME RESOLVES TO PRIVATE/RESERVED ADDRESS ({ip}) — '
                           'set STORAGE_NODE_ALLOW_PRIVATE_HOSTS=true to opt in')
    return True, None


def _is_internal_storage_artifact(file_id):
    """Return True for internal cache/temp/staging object names.
    These names must never be uploaded to remote storage nodes."""
    name = os.path.basename(str(file_id or ''))
    if not name:
        return False
    if any(name.startswith(prefix) for prefix in _INTERNAL_STORAGE_ARTIFACT_PREFIXES):
        return True
    if any(name.endswith(suffix) for suffix in _INTERNAL_STORAGE_ARTIFACT_SUFFIXES):
        return True
    if '.tmp.' in name:
        return True
    return False


def _plan_s3_version_cleanup(entries, expected_file_ids):
    """Plan version-history cleanup for a category on a versioned S3 backend.
    Keeps only the latest live version for expected current objects, purges all
    history for orphan/internal keys, and skips expected keys whose latest entry
    is a delete marker so a later replication cycle can repair them safely."""
    grouped = {}
    for entry in entries:
        file_id = entry.get('file_id')
        if not file_id:
            continue
        grouped.setdefault(file_id, []).append(entry)

    plans = []
    for file_id in sorted(grouped.keys()):
        versions = grouped[file_id]
        latest_entry = next((item for item in versions if item.get('is_latest')), versions[0])
        delete_version_ids = [item.get('version_id') for item in versions if item.get('version_id')]
        plan = {
            'file_id': file_id,
            'key': latest_entry.get('key') or versions[0].get('key'),
            'versions_total': len(versions),
            'latest_is_delete_marker': bool(latest_entry.get('is_delete_marker')),
            'delete_version_ids': [],
            'action': 'noop',
            'reason': 'current_single_version',
        }

        if _is_internal_storage_artifact(file_id):
            plan['action'] = 'purge'
            plan['reason'] = 'internal_artifact'
            plan['delete_version_ids'] = delete_version_ids
        elif file_id not in expected_file_ids:
            plan['action'] = 'purge'
            plan['reason'] = 'orphan_key'
            plan['delete_version_ids'] = delete_version_ids
        elif latest_entry.get('is_delete_marker'):
            plan['action'] = 'skip'
            plan['reason'] = 'expected_live_delete_marker'
        else:
            stale_version_ids = [
                item.get('version_id')
                for item in versions
                if item.get('version_id') and not item.get('is_latest')
            ]
            if stale_version_ids:
                plan['action'] = 'prune'
                plan['reason'] = 'stale_versions'
                plan['delete_version_ids'] = stale_version_ids

        plans.append(plan)

    return plans


