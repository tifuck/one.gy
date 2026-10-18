class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=True)
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    storage_limit_gb = db.Column(db.Float, default=DEFAULT_USER_STORAGE_GB)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    files = db.relationship('File', backref='owner', lazy=True, foreign_keys='File.registered_user_id')
    api_keys = db.relationship('ApiKey', backref='user', lazy='dynamic')
    
    # E2EE Key Hierarchy (MEGA-style zero-knowledge)
    # Master key: random AES-256 key, encrypted with password-derived key (PBKDF2 -> AES-GCM)
    encrypted_master_key = db.Column(db.Text, nullable=True)      # Base64 of AES-GCM ciphertext wrapping master key
    master_key_nonce = db.Column(db.String(255), nullable=True)    # Base64 of AES-GCM nonce used for master key wrapping
    master_key_salt = db.Column(db.String(255), nullable=True)     # Base64 of PBKDF2 salt for password -> wrapping key
    # RSA-OAEP 4096-bit keypair for sharing (file key encrypted to recipient's public key)
    public_key = db.Column(db.Text, nullable=True)                 # JWK JSON of RSA-OAEP public key
    encrypted_private_key = db.Column(db.Text, nullable=True)      # Base64 of AES-GCM ciphertext wrapping PKCS8 private key
    private_key_nonce = db.Column(db.String(255), nullable=True)   # Base64 of AES-GCM nonce used for private key wrapping
    # Recovery: server-side verifier for SHA-256(raw master key) supplied by the client.
    recovery_key_hash = db.Column(db.String(255), nullable=True)   # Legacy raw client hash; cleared after verifier backfill
    recovery_key_verifier = db.Column(db.String(255), nullable=True)  # HMAC(server secret, client recovery hash)
    recovery_wrapped_master_key = db.Column(db.Text, nullable=True)   # AUDIT FIX M3: master key AES-GCM-wrapped under the independent recovery key (base64); NULL = legacy account whose recovery key IS the master key
    recovery_key_nonce = db.Column(db.String(255), nullable=True)     # AUDIT FIX M3: 12-byte nonce (base64) for recovery_wrapped_master_key
    # Key setup flag
    has_e2ee_keys = db.Column(db.Boolean, default=False)           # Whether user has completed E2EE key setup
    # Split-key auth (Finding 2+6): server never sees raw password
    auth_token_hash = db.Column(db.String(255), nullable=True)     # SHA-256(auth_token) hex — replaces password_hash for auth
    auth_token_salt = db.Column(db.String(255), nullable=True)     # Base64 of PBKDF2 salt used for split-key derivation
    split_key_version = db.Column(db.Integer, default=0)           # 0=legacy (password), 1=split-key (auth_token)
    session_epoch = db.Column(db.Integer, default=0, nullable=False)
    # Profile
    avatar_color = db.Column(db.String(7), nullable=True)            # Hex color for avatar background (e.g. '#A855F7')
    # Preferences
    view_preference = db.Column(db.String(10), nullable=True, default='grid')  # 'list' or 'grid' for file browser view
    files_background_theme = db.Column(db.String(32), nullable=True, default='topo')  # 'off' or ASCII theme key for dashboard background
    root_folder_name = db.Column(db.String(80), nullable=True)  # Custom name for root folder (default: 'FILES')
    two_factor_secret = db.Column(db.String(255), nullable=True)  # TOTP secret for 2FA
    two_factor_enabled = db.Column(db.Boolean, default=False)  # Flag for 2FA enablement
    login_count = db.Column(db.Integer, default=0, nullable=True)  # Track total login count for notification triggers
    
    def get_storage_used(self):
        """Calculate total storage used by this user in bytes (files + notes).
        Excludes trashed items so users can free quota by trashing files.
        Uses disk_size (actual on-disk encrypted size) when available for accurate
        quota tracking; falls back to size (logical/plaintext size) for older files."""
        file_total = db.session.query(
            db.func.sum(db.func.coalesce(File.disk_size, File.size))
        ).filter(
            File.registered_user_id == self.id,
            File.is_trashed == False
        ).scalar() or 0
        note_total = db.session.query(db.func.sum(Note.size)).filter(
            Note.user_id == self.id,
            Note.is_trashed == False
        ).scalar() or 0
        return int(file_total or 0) + int(note_total or 0)
    
    def get_storage_used_gb(self):
        """Get storage used in GB"""
        return self.get_storage_used() / (1024 * 1024 * 1024)
    
    def get_storage_remaining_gb(self):
        """Get remaining storage in GB"""
        return self.storage_limit_gb - self.get_storage_used_gb()
    
    def has_storage_available(self, file_size_bytes):
        """Check if user has enough storage for a file"""
        return self.get_storage_used() + file_size_bytes <= (self.storage_limit_gb * 1024 * 1024 * 1024)

# Avatar color palette — muted, dark-theme-friendly colors
AVATAR_COLORS = [
    '#E05555', '#E07C55', '#D4A843', '#6BBF6B', '#4ABFBF',
    '#5599E0', '#7C6BE0', '#A855F7', '#D45DA8', '#8B7355',
    '#E06B8A', '#55B3B3', '#7BAF55', '#C27038', '#6B8EBF',
]

FILES_BACKGROUND_THEMES = {
    'off',
    'neonCyan', 'spiral', 'diagonal', 'turbulent', 'topo',
    'radial', 'matrix', 'fire', 'glitch'
}

def random_avatar_color():
    return random.choice(AVATAR_COLORS)

class Folder(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    parent_id = db.Column(db.Integer, db.ForeignKey('folder.id'), nullable=True, index=True)  # For nested folders
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, nullable=True)  # Last modification time (content or property change)
    files = db.relationship('File', backref='folder_ref', lazy=True, foreign_keys='File.folder_id')
    subfolders = db.relationship('Folder', backref=db.backref('parent', remote_side=[id]), lazy=True)
    
    # Sharing fields
    is_public = db.Column(db.Boolean, default=False)
    is_browsable = db.Column(db.Boolean, default=False)
    password_hash = db.Column(db.String(255), nullable=True)
    share_token = db.Column(db.String(36), unique=True, nullable=True)
    # AUDIT Tier 1: cleanup scheduler scans expires_at on every tick.
    expires_at = db.Column(db.DateTime, nullable=True, index=True)
    short_code = db.Column(db.String(10), unique=True, nullable=True)
    link_secret = db.Column(db.String(255), nullable=True)  # DEPRECATED: legacy link secret storage (being migrated out)
    is_link_shared = db.Column(db.Boolean, default=False, nullable=True)  # Whether this folder has an active E2E link share
    
    # E2EE flag -- new folders default to encrypted unless parent is non-E2E
    is_e2e = db.Column(db.Boolean, default=True, nullable=True)
    
    # Encrypted folder name (E2EE zero-knowledge): real folder name encrypted with per-folder name key
    encrypted_name = db.Column(db.Text, nullable=True)            # Base64 AES-GCM ciphertext of real folder name
    name_nonce = db.Column(db.String(255), nullable=True)          # Base64 nonce for name encryption
    encrypted_name_key = db.Column(db.Text, nullable=True)        # Per-folder name key wrapped by master key (base64)
    name_key_nonce = db.Column(db.String(255), nullable=True)      # Nonce for name key wrapping (base64)
    link_encrypted_name_key = db.Column(db.Text, nullable=True)   # Per-folder name key wrapped by link key (base64, for share links)
    link_name_key_nonce = db.Column(db.String(255), nullable=True) # Nonce for link name key wrapping (base64)
    
    # Download tracking
    download_count = db.Column(db.Integer, default=0, nullable=True)

    # AUDIT FIX M3: client-supplied idempotency token for folder creation. Bulk
    # folder upload retries on network errors; E2EE folders cannot be deduped by
    # name server-side (the encrypted name differs per attempt), so a retry after
    # a committed-but-lost response would create a duplicate folder. A stable
    # per-folder token lets /folder/create return the already-created folder.
    client_dedupe_token = db.Column(db.String(64), nullable=True, index=True)
    # M9 FIX: DB-level backstop behind the folder-creation advisory lock. The
    # sibling lookup scopes dedup by (user_id, parent_id, client_dedupe_token)
    # among LIVE (non-trashed) rows. LIMITATIONS (documented, not fixable in
    # MariaDB without a sentinel column): (1) NULLs are DISTINCT in unique
    # indexes, so ROOT-level folders (parent_id IS NULL) are NOT enforced by
    # this index -- they still rely on _acquire_folder_creation_lock(), and
    # duplicates there are logged loudly at startup by
    # _warn_unenforced_idempotency_scopes(). (2) Trashed rows participate in
    # the index although the lookup ignores them; the writer releases the
    # token on trashed duplicates (which no lookup can ever match again) and
    # retries the insert once.
    __table_args__ = (
        db.Index('uq_folder_dedupe_sibling', 'user_id', 'parent_id',
                 'client_dedupe_token', unique=True),
    )
    
    # Trash / Recycle Bin fields
    is_trashed = db.Column(db.Boolean, default=False, index=True)
    trashed_at = db.Column(db.DateTime, nullable=True)
    original_parent_id = db.Column(db.Integer, nullable=True)  # For restoring folder to original parent
    
    def get_expires_at_aware(self):
        """Return expires_at as timezone-aware datetime (UTC)"""
        if self.expires_at is None:
            return None
        if self.expires_at.tzinfo is None:
            return self.expires_at.replace(tzinfo=timezone.utc)
        return self.expires_at

class File(db.Model):
    id = db.Column(db.String(36), primary_key=True)
    orig_name = db.Column(db.String(255), nullable=False)
    filename = db.Column(db.String(255), nullable=False)
    size = db.Column(db.BigInteger)
    # AUDIT Tier 1: upload_time is the default ORDER BY for dashboard/temp
    # listings; expires_at drives the cleanup scheduler scan.
    upload_time = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    expires_at = db.Column(db.DateTime, nullable=True, index=True)
    is_public = db.Column(db.Boolean, default=False)
    password_hash = db.Column(db.String(255), nullable=True)
    management_token = db.Column(db.String(36), unique=True, nullable=False)
    # AUDIT Tier 1: user_id is the session-based ID used by guest temp-file
    # listings — without an index every guest manage-page hit scans the
    # whole `file` table.
    user_id = db.Column(db.String(36), nullable=False, index=True)  # Session-based ID for guest uploads
    registered_user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True, index=True)  # For registered users
    folder_id = db.Column(db.Integer, db.ForeignKey('folder.id'), nullable=True, index=True)  # Folder organization
    is_e2e_encrypted = db.Column(db.Boolean, default=False)
    e2e_salt = db.Column(db.String(255), nullable=True)
    e2e_iv = db.Column(db.String(255), nullable=True)
    # MEGA-style E2EE: per-file random AES-256 key, wrapped (encrypted) for storage
    # For registered users: file key wrapped with user's master key (AES-GCM)
    # For guests: file key wrapped with passphrase-derived key (PBKDF2 -> AES-GCM)
    # For share links: file key wrapped with link key (embedded in URL fragment)
    encrypted_file_key = db.Column(db.Text, nullable=True)         # Base64 of wrapped file key ciphertext
    file_key_nonce = db.Column(db.String(255), nullable=True)      # Base64 of AES-GCM nonce used for file key wrapping
    file_key_salt = db.Column(db.String(255), nullable=True)       # Base64 of PBKDF2 salt (guest passphrase-wrapped keys only)
    link_encrypted_file_key = db.Column(db.Text, nullable=True)    # Base64 of link-wrapped file key (for share links)
    link_file_key_nonce = db.Column(db.String(255), nullable=True) # Base64 of link-wrapping nonce
    folder_link_encrypted_file_key = db.Column(db.Text, nullable=True)
    folder_link_file_key_nonce = db.Column(db.String(255), nullable=True)
    link_secret = db.Column(db.String(255), nullable=True)         # DEPRECATED: legacy link secret storage (being migrated out)
    is_link_shared = db.Column(db.Boolean, default=False, nullable=True)  # Whether this file has an active E2E link share
    # Encrypted filename (E2EE zero-knowledge): real filename encrypted with file key
    encrypted_name = db.Column(db.Text, nullable=True)             # Base64 AES-GCM ciphertext of real filename
    name_nonce = db.Column(db.String(255), nullable=True)          # Base64 nonce for filename decryption
    stored_extension = db.Column(db.String(32), nullable=True)     # Unencrypted extension for MIME detection (e.g. ".pdf")
    is_legacy_encrypted = db.Column(db.Boolean, default=False)     # True for old Fernet-encrypted files
    short_code = db.Column(db.String(10), unique=True, nullable=True)
    download_count = db.Column(db.Integer, default=0)
    max_downloads = db.Column(db.Integer, nullable=True)
    is_temp_upload = db.Column(db.Boolean, default=True, index=True)  # True for temp uploads, False for cloud drive
    has_thumbnail = db.Column(db.Boolean, default=False)  # Whether a thumbnail was generated
    thumbnail_data = db.Column(db.LargeBinary, nullable=True)  # Plaintext JPEG thumbnail for regular (Fernet) files
    # E2E encrypted thumbnail (stored in DB, decrypted client-side — zero-knowledge)
    encrypted_thumbnail_data = db.Column(db.LargeBinary, nullable=True)  # AES-GCM encrypted JPEG
    encrypted_thumbnail_nonce = db.Column(db.String(255), nullable=True) # Base64 nonce for decryption
    # AUDIT FIX F-2 (5th replication audit): authoritative SHA-256 of the on-disk
    # thumbnail payload so thumbnail integrity decisions (read failover + scrub)
    # have a DB authority like files (payload_checksum) and notes
    # (content_checksum), instead of trusting sibling replicas / local bytes which
    # could let a first-synced corrupt thumbnail become "authoritative".
    thumbnail_checksum = db.Column(db.String(64), nullable=True)      # SHA-256 of thumbnails/<id>.jpg
    thumbnail_e2e_checksum = db.Column(db.String(64), nullable=True)  # SHA-256 of thumbnails/<id>.e2e
    # Cookie-based manager identity for temp uploads (persists across sessions/tabs)
    manager_cookie_id = db.Column(db.String(64), nullable=True, index=True)
    upload_idempotency_key = db.Column(db.String(64), nullable=True, index=True)
    # M9 FIX: DB-level backstop behind the upload idempotency locks. The key is
    # CLIENT-SUPPLIED (upload_id / progress id), so it must only be unique PER
    # OWNER, never globally -- one user's key must not block another's.
    # _find_existing_upload_by_key() resolves a retry by exactly one of three
    # owner scopes, and each gets its own index:
    #   registered users -> (registered_user_id, upload_idempotency_key)
    #   guest manager    -> (manager_cookie_id, upload_idempotency_key)
    #   guest session    -> (user_id, upload_idempotency_key)
    # NULLs are DISTINCT in MariaDB unique indexes, so each nullable owner
    # column only constrains rows that actually carry it -- matching the lookup
    # scopes exactly. LIMITATION vs the lookup: trashed rows participate in the
    # index although the lookup ignores them; the upload writers resolve this
    # by releasing the key on trashed duplicates and retrying the insert once.
    __table_args__ = (
        db.Index('uq_file_upload_key_registered', 'registered_user_id',
                 'upload_idempotency_key', unique=True),
        db.Index('uq_file_upload_key_manager', 'manager_cookie_id',
                 'upload_idempotency_key', unique=True),
        db.Index('uq_file_upload_key_guest', 'user_id',
                 'upload_idempotency_key', unique=True),
    )
    # Content integrity: SHA-256 hash computed at upload time.
    # For Fernet files: hash of plaintext (before encryption). For E2E files: hash of encrypted blob (at-rest integrity).
    content_hash = db.Column(db.String(64), nullable=True)
    # SHA-256 of the encrypted payload stored/replicated as files/<id>.enc.
    payload_checksum = db.Column(db.String(64), nullable=True)
    # Actual on-disk file size in bytes (encrypted size for Fernet, encrypted blob size for E2E).
    # Used for accurate quota calculations. File.size stores the "logical" size for Content-Length headers.
    disk_size = db.Column(db.BigInteger, nullable=True)
    # Trash / Recycle Bin fields
    is_trashed = db.Column(db.Boolean, default=False, index=True)
    trashed_at = db.Column(db.DateTime, nullable=True)
    original_folder_id = db.Column(db.Integer, nullable=True)  # For restoring from trash
    # AUDIT FIX D11: explicit marker replacing the old timestamp heuristic. True
    # when the file was trashed as part of a FOLDER trash operation (so restoring
    # that folder must restore it too); False when the user trashed the file on
    # its own (so it must STAY in trash when the folder is restored).
    # Deliberately declared with NO default so the automatic
    # `ALTER TABLE ... ADD COLUMN` leaves existing rows NULL -- MariaDB backfills
    # a column's DEFAULT into existing rows, and stamping every already-trashed
    # file as "not trashed via folder" would change how the current trash
    # restores. NULL means "unknown/legacy" and falls back to the old timestamp
    # heuristic in _file_trashed_with_folder(); no backfill is required.
    trashed_via_folder = db.Column(db.Boolean, nullable=True)
    # M7 FIX: burn-after-N deferral marker. Stamped by
    # _mark_file_for_download_limit_delete() when the reserved download
    # count reaches max_downloads. A marked row stops serving NEW downloads
    # immediately (check_download_allowed / check_and_reserve_download treat
    # it as exhausted), but the actual row+payload deletion is deferred to
    # cleanup_expired_files() until DOWNLOAD_LIMIT_DELETE_GRACE has elapsed,
    # so a concurrent stream that legally reserved an earlier slot can finish
    # instead of dying on an unlink()ed payload under an already-sent
    # 200 + Content-Length. Naive UTC like the other File timestamps;
    # NULL = not burned.
    pending_delete_at = db.Column(db.DateTime, nullable=True, index=True)

    def get_expires_at_aware(self):
        """Return expires_at as timezone-aware datetime (UTC)"""
        if self.expires_at is None:
            return None
        if self.expires_at.tzinfo is None:
            # If naive, assume it's UTC and make it aware
            return self.expires_at.replace(tzinfo=timezone.utc)
        return self.expires_at
    
    def get_upload_time_aware(self):
        """Return upload_time as timezone-aware datetime (UTC).

        AUDIT FIX (residual): upload_time is a NULLABLE column (legacy rows and
        any direct/fixture insert can leave it unset) but EVERY caller formats
        the result immediately (`...get_upload_time_aware().strftime(...)`), so
        None became an AttributeError -> HTTP 500 on an otherwise valid
        listing/share/API response. NULL now falls back to the Unix epoch in
        UTC: sortable, comparable with the aware values the rest of this
        method returns, and never crashes a response."""
        if self.upload_time is None:
            return datetime(1970, 1, 1, tzinfo=timezone.utc)
        if self.upload_time.tzinfo is None:
            # If naive, assume it's UTC and make it aware
            return self.upload_time.replace(tzinfo=timezone.utc)
        return self.upload_time

class RevokedSession(db.Model):
    """AUDIT FIX M14: server-side revocation record for ONE logged-out session.

    Flask sessions are client-side signed cookies, so session.clear() on /logout
    only hands the CURRENT browser a fresh cookie — a cookie captured before
    logout kept authenticating for the remainder of PERMANENT_SESSION_LIFETIME
    (and `session.permanent = True` is re-set on every request, so an attacker
    could renew that 6-hour window indefinitely). session_epoch is the only other
    revocation lever and it signs the user out of ALL devices, which is not what
    logout should do.

    Each login now mints a random per-session id (`sid`) that travels in the
    cookie. Logout stores SHA-256(sid) here; every authenticated request rejects
    a session whose sid has been revoked. Only the logged-out session dies —
    other devices are untouched.

    Rows are pruned by cleanup_job once past expires_at (the point at which the
    cookie could no longer be valid anyway).
    """
    id = db.Column(db.Integer, primary_key=True)
    sid_hash = db.Column(db.String(64), unique=True, nullable=False, index=True)
    user_id = db.Column(db.Integer, nullable=True)
    revoked_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=True)
    # AUDIT FIX (residual): _prune_revoked_sessions() (cleanup_job) and the
    # cache warm-up filter on expires_at, but the column had no index, so both
    # scanned the whole table every cycle. Additive index only -- created
    # non-fatally by _ensure_model_indexes() on the next db-upgrade; no column
    # changes. (The PendingRemoteDelete composite (category, file_id) asked for
    # in the same pass is ALREADY present as ix_pendingdelete_category_fileid.)
    expires_at = db.Column(db.DateTime, nullable=True, index=True)

class AppSetting(db.Model):
    """Key-value store for runtime-configurable application settings.
    Allows admins to override .env defaults without restarting the service."""
    key = db.Column(db.String(64), primary_key=True)
    value = db.Column(db.String(255), nullable=False)
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

class ApiKey(db.Model):
    """API keys for programmatic access via /apiv1/ endpoints."""
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # AUDIT Tier 1: user_id is queried for every "list my keys" call.
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    key_hash = db.Column(db.String(64), nullable=False, index=True)   # SHA-256 hex digest of the raw key
    label = db.Column(db.String(80), nullable=False, default='Default')
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    last_used_at = db.Column(db.DateTime, nullable=True)
    is_active = db.Column(db.Boolean, default=True)
    # Per-key permissions (all disabled by default)
    perm_read = db.Column(db.Boolean, default=False)           # list files/folders, properties, search, list trash
    perm_download = db.Column(db.Boolean, default=False)       # download files
    perm_write = db.Column(db.Boolean, default=False)          # upload files, create folders
    perm_delete = db.Column(db.Boolean, default=False)         # trash/permanent delete files/folders, empty trash
    perm_restore = db.Column(db.Boolean, default=False)        # restore files from trash
    perm_manage_keys = db.Column(db.Boolean, default=False)    # list/create/revoke API keys via /apiv1/keys
    # IP whitelist: JSON array of IPv4 addresses/CIDRs, NULL = allow all IPs
    allowed_ips = db.Column(db.Text, nullable=True)

    VALID_PERMISSIONS = ('read', 'download', 'write', 'delete', 'restore', 'manage_keys')

    def has_permission(self, perm):
        """Check if this key has a specific permission."""
        return getattr(self, f'perm_{perm}', False) is True

    def get_permissions_dict(self):
        """Return all permissions as a dict."""
        return {p: self.has_permission(p) for p in self.VALID_PERMISSIONS}

    def get_allowed_ips_list(self):
        """Return the allowed IPs as a Python list, or empty list if None."""
        if not self.allowed_ips:
            return []
        try:
            return json.loads(self.allowed_ips)
        except (json.JSONDecodeError, TypeError):
            return []

    def check_ip_allowed(self, ip_str):
        """Return True if ip_str is allowed by this key's whitelist.
        If allowed_ips is NULL/empty, all IPs are allowed.

        AUDIT FIX: a whitelist that EXISTS but cannot be used used to fall
        through to `return True` (fail OPEN) — corrupting the column (a
        truncated write, a hand-edited row) silently switched off the IP
        restriction for that key. A non-empty allowed_ips value now fails
        CLOSED: unparseable JSON, a non-list payload, an empty list, or a
        list whose entries are all invalid all deny the caller (and log)."""
        if not self.allowed_ips:
            return True
        import ipaddress
        try:
            ip_list = json.loads(self.allowed_ips)
        except (json.JSONDecodeError, TypeError) as e:
            print(f'[API] API key {self.id}: allowed_ips is corrupt ({e}); denying (fail closed)')
            return False
        if not isinstance(ip_list, list) or not ip_list:
            print(f'[API] API key {self.id}: allowed_ips is not a non-empty list; denying (fail closed)')
            return False
        try:
            client_ip = ipaddress.IPv4Address(ip_str)
        except (ipaddress.AddressValueError, ValueError):
            return False
        for entry in ip_list:
            if not isinstance(entry, str):
                # Corrupt entry type: skip it. If every entry is invalid the
                # loop ends without a match and the final return denies.
                continue
            try:
                if '/' in entry:
                    network = ipaddress.IPv4Network(entry, strict=False)
                    if client_ip in network:
                        return True
                else:
                    if client_ip == ipaddress.IPv4Address(entry):
                        return True
            except (ipaddress.AddressValueError, ipaddress.NetmaskValueError, ValueError, TypeError):
                continue
        return False

class Notification(db.Model):
    """Admin-created notification banners shown to users across the site."""
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(120), nullable=True)          # Custom title (NULL = default "NOTICE")
    message = db.Column(db.Text, nullable=False)              # Notification body text
    bg_color = db.Column(db.String(7), nullable=True)         # Hex color e.g. "#DE1833" (NULL = default)
    display_trigger = db.Column(db.String(32), nullable=False, default='always')
    # Triggers: 'always', 'on_register', 'first_login', 'every_login', 'once_login'
    auto_dismiss = db.Column(db.Boolean, default=False)
    dismiss_seconds = db.Column(db.Integer, nullable=True)    # Seconds before auto-dismiss (NULL = manual only)
    is_active = db.Column(db.Boolean, default=True)
    expires_at = db.Column(db.DateTime, nullable=True)        # Server-side expiry (NULL = never)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    created_by = db.Column(db.Integer, nullable=True)         # Admin user ID who created it
    dismissals = db.relationship('NotificationDismissal', backref='notification', lazy='dynamic', cascade='all, delete-orphan')

class NotificationDismissal(db.Model):
    """Tracks which users/visitors have dismissed which notifications.

    AUDIT FIX A9: the (notification_id, user_id) / (notification_id, visitor_id)
    pairs are UNIQUE. api_notifications_dismiss() did a .first() existence check
    followed by an unlocked insert, so two concurrent dismisses both inserted.
    NULLs are distinct in a unique index, so the visitor rows (user_id NULL) and
    the user rows (visitor_id NULL) do not collide with each other.
    On an EXISTING database the index is applied by _ensure_unique_indexes(),
    which pre-checks for duplicates and skips (with a loud warning) rather than
    aborting startup."""
    __table_args__ = (
        db.Index('uq_notifdismiss_notif_user', 'notification_id', 'user_id', unique=True),
        db.Index('uq_notifdismiss_notif_visitor', 'notification_id', 'visitor_id', unique=True),
    )
    id = db.Column(db.Integer, primary_key=True)
    notification_id = db.Column(db.Integer, db.ForeignKey('notification.id'), nullable=False)
    user_id = db.Column(db.Integer, nullable=True)            # Registered user ID
    visitor_id = db.Column(db.String(36), nullable=True)      # Guest session visitor ID
    dismissed_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

class PromptFeedback(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    kind = db.Column(db.String(16), nullable=False, default='general', index=True)
    prompt_id = db.Column(db.String(80), nullable=True, index=True)
    message = db.Column(db.Text, nullable=False)
    user_id = db.Column(db.Integer, nullable=True, index=True)
    visitor_id = db.Column(db.String(36), nullable=True, index=True)
    ip_hash = db.Column(db.String(64), nullable=True, index=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), index=True)

class Notebook(db.Model):
    """Notebook container for organizing E2EE notes.

    AUDIT FIX A19: (user_id, system_key) is UNIQUE. system_key is NULL for
    ordinary notebooks and NULLs are distinct in a unique index, so only the
    reserved system notebooks (currently 'shared_inbox') are constrained -- which
    is exactly the invariant a notes-SPA bootstrap racing a pending-note accept
    used to break, leaving two shared_inbox notebooks and a nondeterministic
    delivery target."""
    __table_args__ = (
        db.Index('uq_notebook_user_system_key', 'user_id', 'system_key', unique=True),
    )
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    encrypted_name = db.Column(db.Text, nullable=False)           # AES-256-GCM encrypted notebook name (base64)
    name_nonce = db.Column(db.String(255), nullable=False)         # Nonce for name encryption (base64)
    encrypted_name_key = db.Column(db.Text, nullable=False)       # Notebook name key wrapped by master key (base64)
    name_key_nonce = db.Column(db.String(255), nullable=False)     # Nonce for key wrapping (base64)
    color = db.Column(db.String(7), nullable=True)                # Hex color label e.g. "#DE1833"
    system_key = db.Column(db.String(32), nullable=True)          # Reserved system notebook key e.g. 'shared_inbox'
    position = db.Column(db.Integer, default=0)                   # Sort order
    is_trashed = db.Column(db.Boolean, default=False)
    trashed_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    notes = db.relationship('Note', backref='notebook', lazy=True, cascade='all, delete-orphan')

class Note(db.Model):
    """E2EE encrypted note with per-note key wrapped by master key."""
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    notebook_id = db.Column(db.Integer, db.ForeignKey('notebook.id'), nullable=True, index=True)  # NULL = unfiled
    encrypted_title = db.Column(db.Text, nullable=True)           # AES-256-GCM encrypted title (base64)
    title_nonce = db.Column(db.String(255), nullable=True)         # Nonce for title encryption (base64)
    encrypted_content = db.Column(db.Text, nullable=True)         # AES-256-GCM encrypted HTML content (base64)
    content_nonce = db.Column(db.String(255), nullable=True)       # Nonce for content encryption (base64)
    encrypted_note_key = db.Column(db.Text, nullable=False)       # Per-note AES key wrapped by master key (base64)
    note_key_nonce = db.Column(db.String(255), nullable=False)     # Nonce for key wrapping (base64)
    note_type = db.Column(db.String(16), default='document')     # 'document' or 'canvas'
    is_pinned = db.Column(db.Boolean, default=False)
    is_trashed = db.Column(db.Boolean, default=False)
    trashed_via_notebook = db.Column(db.Boolean, default=False)    # True when trashed by notebook trash action
    trashed_at = db.Column(db.DateTime, nullable=True)
    color = db.Column(db.String(7), nullable=True)                # Hex color label
    size = db.Column(db.Integer, default=0, nullable=True)         # Content file size in bytes (on disk in notes/<id>)
    content_version = db.Column(db.Integer, default=1, nullable=False)  # Monotonic content revision for replication safety
    content_checksum = db.Column(db.String(64), nullable=True)     # SHA-256 hex digest of encrypted note content on disk
    encrypted_tags = db.Column(db.Text, nullable=True)                # AES-256-GCM encrypted JSON array of {name,color} tags (base64)
    tags_nonce = db.Column(db.String(255), nullable=True)             # Nonce for tags encryption (base64)
    position = db.Column(db.Integer, default=0)                      # Manual sort order (0 = default)
    received_from = db.Column(db.String(150), nullable=True)         # Username of sender (for received notes)
    is_read = db.Column(db.Boolean, default=True)                     # False for new received notes
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

class PendingNote(db.Model):
    """Pending note sent from another user, awaiting acceptance."""
    id = db.Column(db.Integer, primary_key=True)
    recipient_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    sender_username = db.Column(db.String(150), nullable=False)
    note_type = db.Column(db.String(16), default='document')         # 'document' or 'canvas'
    encrypted_title = db.Column(db.Text, nullable=True)              # AES-256-GCM encrypted title (base64)
    title_nonce = db.Column(db.String(255), nullable=True)
    # LONGTEXT: sends accept up to NOTES_PENDING_MAX_CONTENT_SIZE (25 MiB); TEXT caps at 64 KiB.
    encrypted_content = db.Column(db.Text().with_variant(LONGTEXT(), 'mysql', 'mariadb'), nullable=True)
    content_nonce = db.Column(db.String(255), nullable=True)
    rsa_encrypted_note_key = db.Column(db.Text, nullable=False)      # Per-note key wrapped with recipient's RSA pubkey
    color = db.Column(db.String(7), nullable=True)
    is_pinned = db.Column(db.Boolean, default=False)
    encrypted_tags = db.Column(db.Text, nullable=True)
    tags_nonce = db.Column(db.String(255), nullable=True)
    content_size = db.Column(db.Integer, default=0)                  # Size of encrypted content in bytes
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    # AUDIT FIX D13: True when the SENDER's account was deleted while this note
    # was still pending. The row belongs to the RECIPIENT (encrypted_content is
    # wrapped with the recipient's RSA key), so it must survive the sender's
    # deletion. sender_id is NOT NULL with a FK to user.id, so on sender deletion
    # it is repointed at the recipient to satisfy the constraint; this flag marks
    # that the sender attribution is no longer meaningful and keeps the row out
    # of the recipient's SENDER-side pending byte quota.
    sender_deleted = db.Column(db.Boolean, default=False, nullable=True)

# ─── Music Library Models ───────────────────────────────────────────────────
class MusicPlaylist(db.Model):
    """User-created music playlist referencing songs from the external music library."""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    name = db.Column(db.String(200), nullable=False)
    description = db.Column(db.String(500), nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    songs = db.relationship('MusicPlaylistSong', backref='playlist', lazy=True,
                            cascade='all, delete-orphan', order_by='MusicPlaylistSong.position')

class MusicPlaylistSong(db.Model):
    """Song entry within a user playlist. References library.db songs.id."""
    id = db.Column(db.Integer, primary_key=True)
    playlist_id = db.Column(db.Integer, db.ForeignKey('music_playlist.id'), nullable=False, index=True)
    song_id = db.Column(db.String(36), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)
    added_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    __table_args__ = (db.UniqueConstraint('playlist_id', 'song_id', name='uq_playlist_song'),)

class MusicLike(db.Model):
    """Liked song for a user. References library.db songs.id."""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    song_id = db.Column(db.String(36), nullable=False)
    liked_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    __table_args__ = (db.UniqueConstraint('user_id', 'song_id', name='uq_user_song_like'),)

class MusicDevice(db.Model):
    """Known device for cross-device music sync (Spotify Connect-style)."""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    device_id = db.Column(db.String(36), nullable=False)  # UUID generated client-side
    device_name = db.Column(db.String(100), nullable=False, default='Unknown Device')
    last_seen = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    __table_args__ = (db.UniqueConstraint('user_id', 'device_id', name='uq_user_device'),)

class MusicSyncState(db.Model):
    """Current music playback state for cross-device sync. One row per user."""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, unique=True, index=True)
    active_device_id = db.Column(db.String(36), nullable=True)  # Which device is outputting audio
    state_json = db.Column(db.Text, nullable=True)  # JSON blob of playback state
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    transfer_to = db.Column(db.String(36), nullable=True)  # Device ID that requested transfer
    pending_command = db.Column(db.Text, nullable=True)  # JSON: {action, seekTime?} from phantom device
    pending_result = db.Column(db.Text, nullable=True)  # JSON: command execution result for phantom to read

class MusicSyncCommand(db.Model):
    """Durable FIFO command/result mailbox for cross-device music sync."""
    id = db.Column(db.Integer, primary_key=True)
    command_id = db.Column(db.String(36), nullable=False, unique=True, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False, index=True)
    requester_device_id = db.Column(db.String(36), nullable=False)
    target_device_id = db.Column(db.String(36), nullable=False)
    # LONGTEXT: commands accept up to _MUSIC_COMMAND_PAYLOAD_MAX (1 MiB); TEXT caps at 64 KiB.
    payload_json = db.Column(db.Text().with_variant(LONGTEXT(), 'mysql', 'mariadb'), nullable=False)
    status = db.Column(db.String(20), nullable=False, default='pending', index=True)
    result_json = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    expires_at = db.Column(db.DateTime, nullable=True)
    claimed_at = db.Column(db.DateTime, nullable=True)
    completed_at = db.Column(db.DateTime, nullable=True)
    result_delivered_at = db.Column(db.DateTime, nullable=True)
    acknowledged_at = db.Column(db.DateTime, nullable=True)
    consumed_at = db.Column(db.DateTime, nullable=True)
    __table_args__ = (
        db.Index('ix_music_command_target_fifo', 'user_id', 'target_device_id', 'status', 'id'),
        db.Index('ix_music_command_requester_result', 'user_id', 'requester_device_id', 'status', 'id'),
    )

# Default values for all toggleable settings (used when no DB override exists)
_SETTING_DEFAULTS = {
    'allow_registration': allow_registration,
    'captcha_enabled': captcha_enabled,
    'allow_temp_uploads': allow_temp_uploads,
    'allow_api_keys': allow_api_keys,
    'welcome_folder_enabled': welcome_folder_enabled,
    'allow_music': allow_music,
    'replication_speed': 'steady',
    'replication_source': 'primary_fallback',
    'health_check_interval': '300',
    'integrity_scrub_interval': '900',
    'integrity_scrub_batch_size': '500',
    'integrity_scrub_checksum_batch_size': '50',
    # S3 COST FIX: minimum age (seconds) before an already-verified replica is
    # re-probed by the scrub. Every replica is checksum-validated at UPLOAD time
    # (put() confirms the bytes end-to-end before the row is marked synced), so
    # re-probing it is only useful to detect the object DISAPPEARING — stored
    # objects do not silently rewrite themselves, and S3/B2 maintain their own
    # internal integrity. Default 604800s (7 days): a synced object is re-checked
    # (one cheap head_object) at most once a week. Set to 0 to re-verify every
    # pass (the old, expensive behavior).
    'integrity_scrub_min_reverify_interval': '604800',
    # How many checksum-incapable remote objects (SSH without sha256sum / S3
    # multipart composite checksum) the scrub DOWNLOADS BACK and re-hashes per
    # pass. DISABLED by default (0): the bytes are already confirmed at upload
    # (single-part via server-side SHA-256, multipart via s3_multipart_verify_write
    # download-back), and re-downloading whole objects forever just to re-hash
    # them is expensive egress for near-zero benefit. Raise it only if you have a
    # specific reason to continuously re-hash size-only backends.
    'integrity_scrub_deep_verify_batch_size': '0',
    'replication_verify_checksum': 'true',
    'replication_workers': '3',
    's3_multipart_verify_write': 'true',
    # AUDIT FIX D5: how long a trashed item is retained before the unattended
    # auto-purge destroys it. Was a hardcoded 48 in cleanup_expired_files().
    'trash_retention_hours': '48',
    'health_check_failure_threshold': '3',
    'integrity_scrub_max_seconds': '600',
    'storage_cache_ttl_minutes': '30',
    'temp_max_gb': '1.0',
    'temp_total_max_gb': '0',
}

# In-memory settings cache: avoids hitting DB on every page view.
# Each entry stores {'value': raw_string_or_None, 'ts': timestamp}.
# TTL of 60 seconds means at most 1 DB query per setting per minute.
#
# This cache is PER-PROCESS. Restrictive security gates bypass it below so a
# worker cannot keep allowing access after another worker disables a feature.
# Other settings retain the bounded 60-second visibility tradeoff.
_SETTINGS_CACHE = {}
_SETTINGS_CACHE_TTL = 60  # seconds

def _settings_cache_get(key):
    """Return cached raw string value for key, or _SENTINEL if stale/missing."""
    entry = _SETTINGS_CACHE.get(key)
    if entry and (time.monotonic() - entry['ts']) < _SETTINGS_CACHE_TTL:
        return entry['value']
    return _SENTINEL

def _settings_cache_set(key, raw_value):
    """Store a raw string value in the cache."""
    _SETTINGS_CACHE[key] = {'value': raw_value, 'ts': time.monotonic()}

_SENTINEL = object()
_DB_ERROR_SENTINEL = object()

# Boolean toggles that gate security-sensitive access (registration, temp
# uploads, API keys, captcha). When the DB is unreachable these must fail
# CLOSED (deny) rather than reverting to a possibly-permissive .env default --
# an admin who tightened one of these in the DB must not have it silently
# relaxed for a minute on a transient DB error. Non-listed booleans keep
# falling back to their .env default on DB error.
_SECURITY_RESTRICTIVE_SETTINGS = frozenset({
    'allow_registration',
    'allow_temp_uploads',
    'allow_api_keys',
    'captcha_enabled',
})

def _invalidate_settings_cache(key=None):
    """Invalidate one or all cached settings."""
    if key:
        _SETTINGS_CACHE.pop(key, None)
    else:
        _SETTINGS_CACHE.clear()
    if has_request_context():
        request_cache = getattr(g, '_security_setting_cache', None)
        if request_cache is not None:
            if key:
                request_cache.pop(key, None)
            else:
                request_cache.clear()

def _get_raw_setting(key):
    """Fetch raw string value from cache or DB. Returns None if not in DB.
    On a DB read failure returns _DB_ERROR_SENTINEL (not cached) so callers can
    fail closed instead of being poisoned by a transient error for 60s."""
    if key in _SECURITY_RESTRICTIVE_SETTINGS:
        request_cache = None
        if has_request_context():
            request_cache = getattr(g, '_security_setting_cache', None)
            if request_cache is None:
                request_cache = {}
                g._security_setting_cache = request_cache
            if key in request_cache:
                return request_cache[key]
        try:
            raw = db.session.query(AppSetting.value).filter(AppSetting.key == key).scalar()
        except Exception as e:
            print(f'[SETTINGS] Failed to read setting {key}: {e}')
            return _DB_ERROR_SENTINEL
        if request_cache is not None:
            request_cache[key] = raw
        return raw

    cached = _settings_cache_get(key)
    if cached is not _SENTINEL:
        return cached
    try:
        row = db.session.get(AppSetting, key)
        raw = row.value if row is not None else None
    except Exception as e:
        print(f'[SETTINGS] Failed to read setting {key}: {e}')
        return _DB_ERROR_SENTINEL
    _settings_cache_set(key, raw)
    return raw

def get_setting(key):
    """Get a boolean setting value. DB value overrides .env default.
    Returns True/False for known boolean settings.
    On a DB read failure, security-restrictive toggles fail CLOSED (False)
    instead of reverting to a possibly-permissive .env default; other toggles
    fall back to their .env default as before."""
    raw = _get_raw_setting(key)
    if raw is _DB_ERROR_SENTINEL:
        if key in _SECURITY_RESTRICTIVE_SETTINGS:
            # For captcha the restrictive value is ON; for the allow_* gates it is OFF.
            return key == 'captcha_enabled'
        return _SETTING_DEFAULTS.get(key, False)
    if raw is not None:
        return raw.lower() in ('true', '1', 'yes')
    return _SETTING_DEFAULTS.get(key, False)

def get_setting_value(key):
    """Get a raw string setting value (for non-boolean settings like replication_speed).
    Returns the stored string or the default from _SETTING_DEFAULTS.
    On a DB read failure, falls back to the .env default."""
    raw = _get_raw_setting(key)
    if raw is _DB_ERROR_SENTINEL:
        default = _SETTING_DEFAULTS.get(key)
        return str(default) if default is not None else None
    if raw is not None:
        return raw
    default = _SETTING_DEFAULTS.get(key)
    return str(default) if default is not None else None

def get_numeric_setting(key, default=None):
    """Get an integer setting value from AppSetting; falls back to default, else _SETTING_DEFAULTS."""
    if default is None:
        default = int(_SETTING_DEFAULTS.get(key, 30))
    raw = _get_raw_setting(key)
    if raw is not None:
        try:
            return int(raw)
        except (ValueError, TypeError):
            pass
    return default

def get_float_setting(key, default=None):
    """Get a float setting value from AppSetting; falls back to default, else _SETTING_DEFAULTS."""
    if default is None:
        default = float(_SETTING_DEFAULTS.get(key, 1.0))
    raw = _get_raw_setting(key)
    if raw is not None:
        try:
            return float(raw)
        except (ValueError, TypeError):
            pass
    return default

def get_trash_retention_hours():
    """Hours a trashed file/folder is kept before the auto-purge destroys it.

    AUDIT FIX D5: this used to be a magic `timedelta(hours=48)` inside
    cleanup_expired_files(). It is now an AppSetting so operators can lengthen
    the safety net without a code change. Clamped to at least 1 hour so a bad
    value can never turn the trash into an instant shredder."""
    try:
        hours = get_numeric_setting('trash_retention_hours')
    except Exception:
        hours = 48
    if not hours or hours < 1:
        return 48
    return hours

# AUDIT FIX A10: must match AppSetting.key / AppSetting.value column widths.
# Under MariaDB strict mode an over-long value raises DataError (caught,
# rolled back, re-raised -> HTTP 500); under non-strict mode it is SILENTLY
# TRUNCATED, which for a value the app later parses is config corruption.
# Validate before the write and fail with a clean, actionable error instead.
_APP_SETTING_KEY_MAX_CHARS = 64
_APP_SETTING_VALUE_MAX_CHARS = 255


def _validate_app_setting(key, normalized_value):
    """Raise ValueError when a setting key/value would not fit the column."""
    if not key or not str(key).strip():
        raise ValueError('SETTING KEY REQUIRED')
    if len(str(key)) > _APP_SETTING_KEY_MAX_CHARS:
        raise ValueError(f'SETTING KEY TOO LONG (MAX {_APP_SETTING_KEY_MAX_CHARS} CHARACTERS)')
    if len(normalized_value) > _APP_SETTING_VALUE_MAX_CHARS:
        raise ValueError(f'SETTING VALUE TOO LONG (MAX {_APP_SETTING_VALUE_MAX_CHARS} CHARACTERS)')


def _stage_setting(key, value):
    """AUDIT FIX M8: validate and stage ONE setting on the session WITHOUT
    committing. Lets multi-key writers (admin settings POST) apply every key
    in a single transaction; set_setting() remains the committing single-key
    wrapper used by the replication preset routes.

    Raises ValueError when the key/value would not fit the AppSetting columns.
    Returns the normalized value that was staged."""
    # AUDIT FIX L6: only lowercase boolean-typed settings. Lowercasing every
    # value would silently corrupt case-sensitive strings (S3 endpoints,
    # tokens, etc.) if they were ever routed through this setter.
    raw_str = str(value)
    normalized = raw_str.lower() if raw_str.lower() in ('true', 'false', '0', '1', 'yes', 'no') else raw_str
    # AUDIT FIX A10: validate BEFORE opening a write so an over-long value can
    # never be truncated by a non-strict server or blow up as a 500.
    _validate_app_setting(key, normalized)
    try:
        row = db.session.get(AppSetting, key)
        if row:
            row.value = normalized
            row.updated_at = datetime.now(timezone.utc)
        else:
            row = AppSetting(key=key, value=normalized)
            db.session.add(row)
        return normalized
    except Exception:
        db.session.rollback()
        raise


# AUDIT FIX: settings values are echoed to stdout by set_setting() (captured
# by journald and shipped to Discord by the external log monitor). Values of
# secret-shaped keys — tokens, passwords, credentials, encryption/API keys —
# must never land in log aggregation.
_SECRET_SETTING_KEY_RE = re.compile(
    r'(secret|password|passphrase|credential|token|apikey|api_key|access_key'
    r'|private_key|encryption_key|_key$)',
    re.IGNORECASE)


def _redact_setting_log_value(key, value):
    """Return value for logging, or a length-only redaction for secret keys."""
    try:
        if _SECRET_SETTING_KEY_RE.search(str(key)):
            return f'<redacted:{len(str(value))} chars>'
    except Exception:
        return '<redacted>'
    return value


def set_setting(key, value):
    """Set a setting value in the database (persists across restarts).
    Also invalidates the in-memory cache for immediate consistency.

    Raises ValueError when the key/value would not fit the AppSetting columns
    (AUDIT FIX A10) -- callers that surface an admin error should catch it."""
    try:
        _stage_setting(key, value)
        db.session.commit()
    except ValueError as e:
        print(f'[SETTINGS] Rejected {key}: {e}')
        raise
    except Exception as e:
        db.session.rollback()
        print(f'[SETTINGS] Failed to set {key}: {e}')
        raise
    _invalidate_settings_cache(key)
    print(f'[SETTINGS] Updated {key} = {_redact_setting_log_value(key, value)}')

def _persist_job_timestamp(key, value):
    """AUDIT FIX F5: best-effort, QUIET persistence of a scheduled job's last-run
    epoch timestamp into AppSetting (no '[SETTINGS] Updated' log spam every tick).
    Lets health-check / integrity-scrub timers survive a restart so a crash-loop
    does not re-trigger an immediate full scrub on every process start. Never raises."""
    try:
        row = db.session.get(AppSetting, key)
        if row:
            row.value = str(value)
            row.updated_at = datetime.now(timezone.utc)
        else:
            db.session.add(AppSetting(key=key, value=str(value)))
        db.session.commit()
        _invalidate_settings_cache(key)
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass

def _load_job_timestamp(key):
    """AUDIT FIX F5: read a persisted job last-run epoch timestamp from AppSetting,
    bypassing the settings cache. Returns a float (0.0 if absent/invalid)."""
    try:
        row = db.session.get(AppSetting, key)
        if row and row.value:
            return float(row.value)
    except Exception:
        pass
    return 0.0

# =============================================================================
# STORAGE NODE MODELS & MULTI-BACKEND STORAGE MANAGER
# =============================================================================

# AUDIT FIX F-4 (5th audit): throttle config-decrypt failure warnings per node
# (epoch seconds of last warning) so a frequently-built bad node doesn't spam logs.
_CONFIG_DECRYPT_WARN_AT = {}

class StorageNode(db.Model):
    """Represents a storage backend (local disk, SSH/SFTP, or S3-compatible).
    All configured nodes receive a full mirror of all file/note data."""
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    node_type = db.Column(db.String(20), nullable=False)           # 'local', 'ssh', 's3'
    config_json = db.Column(db.Text, nullable=True)                # Fernet-encrypted JSON with connection details
    is_primary = db.Column(db.Boolean, default=False)
    is_enabled = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    last_seen_at = db.Column(db.DateTime, nullable=True)
    status = db.Column(db.String(20), default='online')            # online, offline, syncing, draining, error
    # AUDIT FIX (F7 integrity visibility): records whether this node can provide
    # full SHA-256 verification or only size-only integrity. None = unknown (not
    # yet probed), True = full checksum verification available, False = size-only
    # (SSH node missing sha256sum/shasum, or S3 provider without ChecksumSHA256).
    # Populated from the live backend capability during health checks so admins
    # can see which nodes carry a weaker integrity guarantee.
    checksum_capable = db.Column(db.Boolean, nullable=True, default=None)
    # AUDIT FIX M7: health-check hysteresis counters. A single failed probe no
    # longer flips a node to 'offline' (which would drop it from replication for
    # up to a full health_check_interval). The node is only marked offline after
    # `health_check_failure_threshold` (default 3) CONSECUTIVE failed probes;
    # until then it stays in its prior (replication-eligible) status. Additive,
    # auto-migrated (scalar default=0).
    consecutive_failures = db.Column(db.Integer, nullable=True, default=0)
    consecutive_successes = db.Column(db.Integer, nullable=True, default=0)

    def get_config(self):
        if not self.config_json:
            return {}
        try:
            decrypted = fernet.decrypt(self.config_json.encode()).decode()
            return json.loads(decrypted)
        except Exception as e:
            # AUDIT FIX F-4 (5th audit): a non-empty config_json that fails to
            # decrypt almost always means the FERNET_KEY changed (rotation /
            # wrong .env) or the row is corrupt — NOT that the node has no
            # config. Returning {} keeps callers from crashing, but the backend
            # build will then fail with an opaque KeyError on a required field
            # (hostname/bucket/access_key) and the node is marked 'error'. Emit a
            # clear, actionable, throttled message so operators can diagnose it.
            now = time.time()
            last = _CONFIG_DECRYPT_WARN_AT.get(self.id, 0)
            if now - last >= 300:
                _CONFIG_DECRYPT_WARN_AT[self.id] = now
                print(f'[STORAGE] [WARNING] Could not decrypt config for node {self.id} '
                      f'({self.name!r}, type={self.node_type}): {e}. This usually means the '
                      f'FERNET_KEY changed or the config row is corrupt — the node will be '
                      f'marked error and its data left untouched until the key/config is fixed.')
            return {}

    def set_config(self, config_dict):
        if self.node_type == 'ssh':
            config_dict = dict(config_dict)
            auth_method = str(config_dict.get('auth_method') or 'password').strip().lower()
            if auth_method not in ('password', 'key'):
                raise ValueError('INVALID SSH AUTH_METHOD. MUST BE: password, key')
            config_dict['auth_method'] = auth_method
        raw = json.dumps(config_dict)
        self.config_json = fernet.encrypt(raw.encode()).decode()

class FileReplica(db.Model):
    """Tracks which files exist on which storage nodes."""
    id = db.Column(db.Integer, primary_key=True)
    file_id = db.Column(db.String(36), nullable=False, index=True)
    node_id = db.Column(db.Integer, db.ForeignKey('storage_node.id'), nullable=False, index=True)
    verified_at = db.Column(db.DateTime, nullable=True)
    size_bytes = db.Column(db.BigInteger, nullable=True)
    checksum = db.Column(db.String(64), nullable=True)             # SHA-256 hex digest of synced file
    # AUDIT FIX (size-only replicas excluded from failover): explicitly separate
    # "this checksum was CONFIRMED end-to-end against the object on that node"
    # from "this checksum is what we believe we wrote". Previously an unconfirmed
    # write recorded checksum=NULL, which made the replica invisible to the read
    # failover query -- so a perfectly good remote mirror could not rescue a
    # corrupt/missing local copy. Now the checksum is always recorded and this
    # tri-state carries the trust level:
    #   True  -> the target backend proved the stored bytes hash to `checksum`
    #   False -> written and size-checked only (NOT hash-confirmed)
    #   None  -> unknown (legacy row written before this column existed)
    # Consumers that make DESTRUCTIVE decisions (node removal, local purge,
    # corroboration of an unknown payload checksum) must exclude `False`.
    # Read failover MAY use a False/None row but must re-hash before serving.
    checksum_verified = db.Column(db.Boolean, nullable=True, default=None)
    status = db.Column(db.String(20), default='pending')           # synced, pending, syncing, error
    error_count = db.Column(db.Integer, default=0)                 # Number of consecutive replication failures
    last_error = db.Column(db.String(500), nullable=True)
    __table_args__ = (db.UniqueConstraint('file_id', 'node_id', name='uq_file_node'),)

class NoteReplica(db.Model):
    """Tracks which notes exist on which storage nodes."""
    id = db.Column(db.Integer, primary_key=True)
    note_id = db.Column(db.String(36), nullable=False, index=True)
    node_id = db.Column(db.Integer, db.ForeignKey('storage_node.id'), nullable=False, index=True)
    verified_at = db.Column(db.DateTime, nullable=True)
    checksum = db.Column(db.String(64), nullable=True)             # SHA-256 hex digest of synced note
    # AUDIT FIX (size-only replicas excluded from failover): see FileReplica.
    checksum_verified = db.Column(db.Boolean, nullable=True, default=None)
    status = db.Column(db.String(20), default='pending')
    synced_version = db.Column(db.Integer, nullable=True)          # Version currently confirmed on this node
    target_version = db.Column(db.Integer, nullable=True)          # Version this node still needs to reach
    error_count = db.Column(db.Integer, default=0)
    last_error = db.Column(db.String(500), nullable=True)
    __table_args__ = (db.UniqueConstraint('note_id', 'node_id', name='uq_note_node'),)

class ThumbnailReplica(db.Model):
    """Tracks which thumbnails exist on which storage nodes."""
    id = db.Column(db.Integer, primary_key=True)
    file_id = db.Column(db.String(36), nullable=False, index=True)
    thumb_type = db.Column(db.String(4), nullable=False)           # 'jpg' or 'e2e'
    node_id = db.Column(db.Integer, db.ForeignKey('storage_node.id'), nullable=False, index=True)
    verified_at = db.Column(db.DateTime, nullable=True)
    size_bytes = db.Column(db.BigInteger, nullable=True)
    checksum = db.Column(db.String(64), nullable=True)             # SHA-256 hex digest of synced thumbnail
    # AUDIT FIX (size-only replicas excluded from failover): see FileReplica.
    checksum_verified = db.Column(db.Boolean, nullable=True, default=None)
    status = db.Column(db.String(20), default='pending')
    error_count = db.Column(db.Integer, default=0)
    last_error = db.Column(db.String(500), nullable=True)
    __table_args__ = (db.UniqueConstraint('file_id', 'thumb_type', 'node_id', name='uq_thumb_node'),)


class PendingRemoteDelete(db.Model):
    """Queue for deferred remote storage deletions. Files/thumbnails/notes are deleted
    from local disk immediately but remote backend deletes are queued here and processed
    asynchronously by the background replication job to avoid blocking HTTP requests."""
    id = db.Column(db.Integer, primary_key=True)
    category = db.Column(db.String(20), nullable=False, index=True)  # 'files', 'notes', 'thumbnails'
    file_id = db.Column(db.String(100), nullable=False)            # e.g. 'abc123.enc', 'abc123.jpg'
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    retry_count = db.Column(db.Integer, default=0)                 # Number of failed attempts
    last_attempt = db.Column(db.DateTime, nullable=True)           # Last processing attempt time
    target_node_ids = db.Column(db.Text, nullable=True)            # JSON array of remote node IDs that must delete this object
    deleted_node_ids = db.Column(db.Text, nullable=True)           # JSON array of target node IDs already confirmed deleted
    # AUDIT FIX H4: identity marker of the live row captured when the tombstone
    # was queued (e.g. 'file:ut=<upload_time isoformat>'). Phase B of the
    # deferred-delete worker refuses to delete when a live row with the same id
    # carries a DIFFERENT marker (object re-created / DB restore / thumbnail
    # regenerated) and drops the tombstone instead. NULL = legacy tombstone:
    # processed with the old delete-anyway behavior.
    generation = db.Column(db.String(150), nullable=True)


def _clear_pending_remote_deletes_for(category, object_ids):
    """AUDIT FIX H4 (belt and braces): drop any still-queued deferred-delete
    tombstones matching the storage keys of an object that is being created.

    A PendingRemoteDelete tombstone outlives the row it deleted; if the same
    storage key ever comes back (re-created note with a reused id, operator DB
    restore), a stale tombstone could otherwise delete the NEW generation's
    remote copies during the next deferred-delete cycle. Callers run this on
    the upload/create paths; the delete joins the caller's open transaction,
    so a later rollback restores the tombstone together with the failed create."""
    ids = [oid for oid in (object_ids or []) if oid]
    if not ids:
        return
    try:
        matched = PendingRemoteDelete.query.filter(
            PendingRemoteDelete.category == category,
            PendingRemoteDelete.file_id.in_(ids),
        ).delete(synchronize_session=False)
        if matched:
            print(f'[STORAGE] AUDIT FIX H4: cleared {matched} stale pending remote-delete '
                  f'tombstone(s) for re-created {category} object(s) {sorted(set(ids))}')
    except Exception as e:
        try:
            db.session.rollback()
        except Exception:
            pass
        print(f'[STORAGE] Failed to clear pending remote-delete tombstones for {category}/{ids}: {e}')
        raise


class SystemMetricSnapshot(db.Model):
    """Periodic system-wide admin metrics snapshot for historical charts."""
    id = db.Column(db.Integer, primary_key=True)
    captured_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    total_users = db.Column(db.Integer, default=0)
    admin_users = db.Column(db.Integer, default=0)
    e2e_users = db.Column(db.Integer, default=0)
    total_files = db.Column(db.Integer, default=0)
    registered_files = db.Column(db.Integer, default=0)
    temp_files = db.Column(db.Integer, default=0)
    total_folders = db.Column(db.Integer, default=0)
    e2e_files = db.Column(db.Integer, default=0)
    total_downloads = db.Column(db.Integer, default=0)
    total_file_size_bytes = db.Column(db.BigInteger, default=0)
    registered_file_payload_bytes = db.Column(db.BigInteger, default=0)
    temp_file_payload_bytes = db.Column(db.BigInteger, default=0)
    tracked_registered_bytes = db.Column(db.BigInteger, default=0)
    tracked_temp_bytes = db.Column(db.BigInteger, default=0)
    tracked_total_bytes = db.Column(db.BigInteger, default=0)
    disk_total_bytes = db.Column(db.BigInteger, default=0)
    disk_free_bytes = db.Column(db.BigInteger, default=0)
    replication_nodes = db.Column(db.Integer, default=0)
    replication_online_nodes = db.Column(db.Integer, default=0)
    replication_offline_nodes = db.Column(db.Integer, default=0)
    replication_error_nodes = db.Column(db.Integer, default=0)
    replication_pending_files = db.Column(db.Integer, default=0)
    replication_pending_notes = db.Column(db.Integer, default=0)
    replication_pending_thumbnails = db.Column(db.Integer, default=0)
    replication_error_files = db.Column(db.Integer, default=0)
    replication_error_notes = db.Column(db.Integer, default=0)
    replication_error_thumbnails = db.Column(db.Integer, default=0)
    pending_remote_deletes = db.Column(db.Integer, default=0)


