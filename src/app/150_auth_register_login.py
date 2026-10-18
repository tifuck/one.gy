def create_welcome_folder(user):
    """Create a 'Sample Files' folder with demo files for a newly registered user.
    
    Reads files from default_usercreation_files/ directory. If a WELCOME.txt
    template exists, replaces %username% with the user's name and adds it as
    welcome.txt. All other files are added as-is. WELCOME.txt itself is not
    added as a sample file (it is consumed as a template).
    
    Files are Fernet-encrypted server-side (not E2EE) so thumbnails and
    previews work out of the box.
    
    This function is safe to call during registration — all errors are caught
    and logged, never propagated to the caller.
    """
    if not get_setting('welcome_folder_enabled'):
        return
    
    try:
        import tempfile as _wf_tempfile
        
        sample_dir = os.path.join(basedir, 'default_usercreation_files')
        if not os.path.isdir(sample_dir):
            print(f'[AUTH] Welcome folder: default_usercreation_files/ directory not found, skipping')
            return
        
        # Create the welcome folder (non-E2EE so server can generate thumbnails)
        # Expires in 1 day so sample files auto-clean if the user ignores them
        welcome_expires = datetime.now(timezone.utc) + timedelta(days=1)
        
        folder = Folder(
            name='Sample Files',
            user_id=user.id,
            parent_id=None,
            is_e2e=False,
            share_token=str(uuid.uuid4()),
            expires_at=welcome_expires
        )
        db.session.add(folder)
        db.session.flush()  # Get folder.id without full commit
        
        # Build the list of files to add
        files_to_add = []
        
        # 1) Check for WELCOME.txt template — generates personalized welcome.txt
        #    Use %username% as a placeholder in the template file.
        welcome_template_path = os.path.join(sample_dir, 'WELCOME.txt')
        if os.path.isfile(welcome_template_path):
            try:
                with open(welcome_template_path, 'r', encoding='utf-8') as f:
                    template_text = f.read()
                welcome_text = template_text.replace('%username%', user.username)
                files_to_add.append(('welcome.txt', welcome_text.encode('utf-8')))
            except Exception as e:
                print(f'[AUTH] Welcome folder: failed to read WELCOME.txt template: {e}')
        
        # 2) All other files from the directory (skip the WELCOME.txt template)
        for entry in sorted(os.listdir(sample_dir)):
            if entry == 'WELCOME.txt':
                continue  # Template file, already handled above
            entry_path = os.path.join(sample_dir, entry)
            if os.path.isfile(entry_path):
                try:
                    with open(entry_path, 'rb') as f:
                        file_data = f.read()
                    files_to_add.append((entry, file_data))
                except Exception as e:
                    print(f'[AUTH] Welcome folder: failed to read {entry}: {e}')
        
        if not files_to_add:
            print(f'[AUTH] Welcome folder: no files found in default_usercreation_files/, skipping')
            db.session.rollback()
            return
        
        # 3) Create File records for each file
        created_count = 0
        encrypted_paths = []  # Track for cleanup on failure
        for orig_name, file_bytes in files_to_add:
            try:
                file_id = str(uuid.uuid4())
                encrypted_filename = f'{file_id}.enc'
                
                # Write raw bytes to a temp file, Fernet-encrypt, then store via StorageManager
                # (creates FileReplica rows so replication tracks these files)
                tmp_fd, tmp_path = _wf_tempfile.mkstemp(suffix='.tmp', dir=app.config['UPLOAD_FOLDER'])
                tmp_enc_path = tmp_path + '.enc'
                try:
                    with os.fdopen(tmp_fd, 'wb') as tmp_f:
                        tmp_f.write(file_bytes)
                    encrypt_file_chunked(tmp_path, tmp_enc_path)
                    storage.store_file(encrypted_filename, tmp_enc_path)
                finally:
                    for _p in (tmp_path, tmp_enc_path):
                        if os.path.exists(_p):
                            os.unlink(_p)
                
                encrypted_paths.append(encrypted_filename)
                
                file_record = File(
                    id=file_id,
                    orig_name=orig_name,
                    filename=encrypted_filename,
                    size=len(file_bytes),
                    expires_at=welcome_expires,
                    is_public=False,
                    management_token=str(uuid.uuid4()),
                    user_id=f'system_welcome_{user.id}',
                    registered_user_id=user.id,
                    folder_id=folder.id,
                    is_e2e_encrypted=False,
                    is_legacy_encrypted=False,
                    is_temp_upload=False,
                )
                db.session.add(file_record)
                # AUDIT FIX H4: drop any stale tombstone for this key before the
                # row can replicate (belt and braces; Phase B also checks).
                _clear_pending_remote_deletes_for('files', [file_record.filename, file_record.id])
                db.session.flush()
                
                # Generate thumbnail for eligible file types (images, text, code)
                try:
                    generate_thumbnail(file_record, refresh_snapshot=False)
                except Exception as e:
                    print(f'[AUTH] Welcome folder: thumbnail failed for {orig_name}: {e}')
                
                created_count += 1
            except Exception as e:
                print(f'[AUTH] Welcome folder: failed to create file {orig_name}: {e}')
                # DB error poisons the session — must rollback and abort all remaining files
                db.session.rollback()
                # Clean up all encrypted files created so far (via StorageManager)
                for enc_fn in encrypted_paths:
                    try:
                        storage.delete_file(enc_fn)
                    except Exception:
                        pass
                print(f'[AUTH] Welcome folder: aborted due to error, cleaned up {len(encrypted_paths)} files')
                return
        
        db.session.commit()
        print(f'[AUTH] Created welcome folder with {created_count} files for user: {user.username}')
        
    except Exception as e:
        print(f'[AUTH] Failed to create welcome folder for user {user.username}: {e}')
        try:
            db.session.rollback()
        except Exception:
            pass

@app.route('/register', methods=['GET', 'POST'])
@limiter.limit("5 per minute", methods=["POST"])
def register():
    # Check if registration is enabled
    if not get_setting('allow_registration'):
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return jsonify({'error': 'REGISTRATION IS CURRENTLY DISABLED'}), 403
        flash('REGISTRATION IS CURRENTLY DISABLED', 'error')
        return redirect(url_for('login'))

    if request.method == 'POST':
        # Check if this is an AJAX request with E2EE keys
        is_ajax = request.headers.get('X-Requested-With') == 'XMLHttpRequest'
        
        if is_ajax:
            # AJAX registration with E2EE key material
            data = request.get_json(silent=True)
            if not isinstance(data, dict) or not data:
                return jsonify({'error': 'INVALID REQUEST'}), 400
            # AUDIT FIX: JSON fields can be numbers/objects/arrays — validate
            # types up front so `len(username)` / `.strip()` / DB inserts can
            # never raise an unhandled 500.
            if not _json_string_fields_valid(data, (
                    'username', 'email', 'password', 'confirm_password',
                    'captcha', 'auth_token', 'auth_salt')):
                return jsonify({'error': 'INVALID REQUEST'}), 400
            username = data.get('username')
            email = data.get('email')
            password = data.get('password')
            confirm_password = data.get('confirm_password')
            password_length = data.get('password_length')
            captcha_input = (data.get('captcha') or '').strip()
        else:
            username = request.form.get('username')
            email = request.form.get('email')
            password = request.form.get('password')
            confirm_password = request.form.get('confirm_password')
            password_length = None
            captcha_input = request.form.get('captcha', '').strip()
        
        # SECURITY: Validate captcha before anything else (if captcha is enabled)
        if get_setting('captcha_enabled'):
            captcha_ok, captcha_error = _validate_captcha_response(captcha_input)
            if not captcha_ok:
                print('[AUTH] Captcha failed (registration)')
                if is_ajax:
                    return jsonify({'error': captcha_error}), 400
                flash(captcha_error, 'error')
                return redirect(url_for('register'))
        
        # Split-key registration: password is not required when auth_token is provided
        # (zero-knowledge: password length validation is done client-side)
        has_auth_token = bool(data.get('auth_token') and data.get('auth_salt')) if is_ajax else False
        
        if not username or (not password and not has_auth_token):
            if is_ajax:
                return jsonify({'error': 'USERNAME AND PASSWORD ARE REQUIRED'}), 400
            flash('USERNAME AND PASSWORD ARE REQUIRED', 'error')
            return redirect(url_for('register'))
        
        # SECURITY: Validate username format and length
        import re as _re_username
        if len(username) > 80:
            if is_ajax:
                return jsonify({'error': 'USERNAME MUST BE 80 CHARACTERS OR LESS'}), 400
            flash('USERNAME MUST BE 80 CHARACTERS OR LESS', 'error')
            return redirect(url_for('register'))
        if len(username) < 3:
            if is_ajax:
                return jsonify({'error': 'USERNAME MUST BE AT LEAST 3 CHARACTERS'}), 400
            flash('USERNAME MUST BE AT LEAST 3 CHARACTERS', 'error')
            return redirect(url_for('register'))
        if not _re_username.fullmatch(r'[a-zA-Z0-9_\-.]+', username):
            if is_ajax:
                return jsonify({'error': 'USERNAME MAY ONLY CONTAIN LETTERS, NUMBERS, UNDERSCORES, HYPHENS, AND DOTS'}), 400
            flash('USERNAME MAY ONLY CONTAIN LETTERS, NUMBERS, UNDERSCORES, HYPHENS, AND DOTS', 'error')
            return redirect(url_for('register'))
        
        # Password validation only when password is provided (legacy or non-split-key registration)
        if password:
            # SECURITY: Password confirmation validation
            if password != confirm_password:
                if is_ajax:
                    return jsonify({'error': 'PASSWORDS DO NOT MATCH'}), 400
                flash('PASSWORDS DO NOT MATCH', 'error')
                return redirect(url_for('register'))
            
            # SECURITY: Enforce minimum password length
            if len(password) < 6:
                if is_ajax:
                    return jsonify({'error': 'PASSWORD MUST BE AT LEAST 6 CHARACTERS'}), 400
                flash('PASSWORD MUST BE AT LEAST 6 CHARACTERS', 'error')
                return redirect(url_for('register'))
        elif has_auth_token:
            # AUDIT FIX M10: bounded sanity check on the CLIENT-ASSERTED length.
            # See the PASSWORD_MIN_LENGTH block for the residual limitation —
            # this is not a real server-side password policy.
            _pw_len_ok, _pw_len_err = _validate_asserted_password_length(password_length)
            if not _pw_len_ok:
                if is_ajax:
                    return jsonify({'error': _pw_len_err}), 400
                flash(_pw_len_err, 'error')
                return redirect(url_for('register'))

        # AUDIT FIX M11: validate email format AND length against the bounded
        # db.String(120) column BEFORE any insert. A 200-character value used to
        # reach the INSERT and surface as a MariaDB DataError 500.
        email, _email_err = _validate_email_value(email)
        if _email_err:
            if is_ajax:
                return jsonify({'error': _email_err}), 400
            flash(_email_err, 'error')
            return redirect(url_for('register'))

        if User.query.filter_by(username=username).first():
            if is_ajax:
                return jsonify({'error': 'USERNAME ALREADY EXISTS'}), 409
            flash('USERNAME ALREADY EXISTS', 'error')
            return redirect(url_for('register'))
        
        if email and User.query.filter_by(email=email).first():
            if is_ajax:
                return jsonify({'error': 'EMAIL ALREADY EXISTS'}), 409
            flash('EMAIL ALREADY EXISTS', 'error')
            return redirect(url_for('register'))
        
        # Split-key auth: client sends auth_token (derived via HKDF) instead of raw password
        auth_token = data.get('auth_token') if is_ajax else None
        auth_salt = data.get('auth_salt') if is_ajax else None
        
        # AUDIT FIX M11: bound the client-supplied split-key material against the
        # real column widths before it reaches the INSERT.
        if is_ajax:
            _auth_field_err = _validate_e2ee_fields(data, ['auth_token', 'auth_salt'])
            if _auth_field_err:
                return jsonify({'error': _auth_field_err}), 400

        if auth_token and auth_salt:
            # New split-key registration: hash the auth token for storage
            import hashlib as _hashlib_reg
            auth_token_hash = _hashlib_reg.sha256(auth_token.encode('utf-8')).hexdigest()
            user = User(
                username=username,
                email=email if email else None,
                password_hash='split-key-v1',  # Placeholder — real auth via auth_token_hash
                auth_token_hash=auth_token_hash,
                auth_token_salt=auth_salt,
                split_key_version=1,
                storage_limit_gb=DEFAULT_USER_STORAGE_GB,
                avatar_color=random_avatar_color()
            )
        else:
            # Legacy registration (non-JS fallback)
            user = User(
                username=username,
                email=email if email else None,
                password_hash=generate_password_hash(password, method='pbkdf2:sha256'),
                storage_limit_gb=DEFAULT_USER_STORAGE_GB,
                avatar_color=random_avatar_color()
            )
        
        # Store E2EE key material if provided (AJAX registration)
        if is_ajax and data.get('encrypted_master_key'):
            _e2ee_err = _validate_e2ee_fields(data, [
                'encrypted_master_key', 'master_key_nonce', 'master_key_salt',
                'public_key', 'encrypted_private_key', 'private_key_nonce', 'recovery_key_hash',
                'recovery_wrapped_master_key', 'recovery_key_nonce'
            ])
            if _e2ee_err:
                return jsonify({'error': _e2ee_err}), 400
            # _validate_e2ee_fields checks present fields only; the six indexed
            # below are all mandatory (as for /api/keys initial setup).
            if any(not data.get(f) for f in (
                    'encrypted_master_key', 'master_key_nonce', 'master_key_salt',
                    'public_key', 'encrypted_private_key', 'private_key_nonce')):
                return jsonify({'error': 'INCOMPLETE E2EE KEY MATERIAL'}), 400
            user.encrypted_master_key = data['encrypted_master_key']
            user.master_key_nonce = data['master_key_nonce']
            user.master_key_salt = data['master_key_salt']
            user.public_key = data['public_key']
            user.encrypted_private_key = data['encrypted_private_key']
            user.private_key_nonce = data['private_key_nonce']
            user.recovery_key_verifier = _recovery_key_server_verifier(data.get('recovery_key_hash'))
            user.recovery_key_hash = None
            # AUDIT FIX M3: the recovery key is now an INDEPENDENT secret, so the
            # server stores the master key wrapped under it — without this wrap a
            # decoupled recovery key could never recover anything. Absent fields
            # (stale cached client) keep the legacy semantics: the recovery key
            # IS the master key and recovery needs no wrap.
            _wrap_err = _e2ee_wrap_field_error([
                ('recovery_wrapped_master_key', data.get('recovery_wrapped_master_key'), 48),
                ('recovery_key_nonce', data.get('recovery_key_nonce'), 12),
            ])
            if _wrap_err:
                return _wrap_err
            if data.get('recovery_wrapped_master_key') and data.get('recovery_key_nonce'):
                user.recovery_wrapped_master_key = data['recovery_wrapped_master_key']
                user.recovery_key_nonce = data['recovery_key_nonce']
            user.has_e2ee_keys = True
            print(f'[AUTH] E2EE keys generated for new user: {username} (split_key_v{user.split_key_version})')
        
        # AUDIT FIX M11: the uniqueness checks above are a check-then-insert with
        # no transaction guard, so two concurrent registrations for the same
        # username/email both pass and the loser's commit() raises IntegrityError
        # as an unhandled 500 with a poisoned session. Catch it, roll back, and
        # return the same clean 409 the pre-check returns.
        from sqlalchemy.exc import IntegrityError as _IntegrityError, DataError as _DataError
        try:
            db.session.add(user)
            db.session.commit()
        except _IntegrityError:
            db.session.rollback()
            print(f'[AUTH] Registration race lost for username={username!r} (IntegrityError)')
            conflict = 'EMAIL ALREADY EXISTS' if (email and User.query.filter_by(email=email).first()) else 'USERNAME ALREADY EXISTS'
            if is_ajax:
                return jsonify({'error': conflict}), 409
            flash(conflict, 'error')
            return redirect(url_for('register'))
        except _DataError as _de:
            db.session.rollback()
            print(f'[ERROR] Registration rejected by database constraints for username={username!r}: {_de}')
            if is_ajax:
                return jsonify({'error': 'REGISTRATION DATA IS INVALID'}), 400
            flash('REGISTRATION DATA IS INVALID', 'error')
            return redirect(url_for('register'))

        print(f'[AUTH] New user registered: {username}')
        
        # Create welcome folder with sample files if enabled
        create_welcome_folder(user)
        
        # Set flag so notification system can detect fresh registration after login
        session['just_registered'] = True
        
        if is_ajax:
            return jsonify({'success': True, 'redirect': url_for('login')})
        
        flash('REGISTRATION SUCCESSFUL. PLEASE LOGIN.', 'success')
        return redirect(url_for('login'))
    
    return render_template('register.html')

_E2EE_FIELD_MAX_LEN = 10240  # 10 KB max per E2EE key field

# AUDIT FIX M11: these request fields land in db.String(255) columns, not db.Text.
# The blanket 10 KB cap above is far too loose for them — a longer value passes
# validation and then raises a MariaDB DataError 500 under strict mode. Bound
# them to the real column width so an over-long value is a clean 400.
_E2EE_VARCHAR255_FIELDS = {
    'master_key_nonce', 'master_key_salt', 'private_key_nonce',
    'auth_salt', 'new_auth_salt', 'recovery_key_hash',
    'recovery_key_nonce', 'new_recovery_key_hash', 'new_recovery_key_nonce',
}
_E2EE_VARCHAR255_MAX_LEN = 255

def _e2ee_wrap_field_error(fields):
    """Reject wrap/filename metadata that is not valid base64 of the expected size.

    fields: iterable of (name, value, exact_size_or_None). None means ciphertext
    with a 17-byte minimum (1+ byte + 16-byte GCM tag). Missing/empty values are
    skipped — the caller enforces required fields. Returns a 400 response or None.
    """
    fields = tuple(fields)
    size_error = _validate_e2ee_fields(
        {field_name: field_value for field_name, field_value, _exact_size in fields},
        [field_name for field_name, _field_value, _exact_size in fields],
    )
    if size_error:
        return jsonify({'error': size_error}), 400
    for field_name, field_value, exact_size in fields:
        if not field_value:
            continue
        try:
            decoded = base64.b64decode(field_value, validate=True)
        except Exception:
            return jsonify({'error': f'INVALID {field_name.upper()}'}), 400
        if base64.b64encode(decoded).decode('ascii') != field_value:
            return jsonify({'error': f'INVALID {field_name.upper()}'}), 400
        if (exact_size is not None and len(decoded) != exact_size) or (exact_size is None and len(decoded) < 17):
            return jsonify({'error': f'INVALID {field_name.upper()}'}), 400
    return None


def _validate_e2ee_fields(data, fields):
    """Validate that E2EE key fields are strings within the size limit.
    Returns an error string if validation fails, or None if OK."""
    for field in fields:
        value = data.get(field)
        if value is None:
            continue
        if not isinstance(value, str):
            return f'{field.upper()} EXCEEDS MAXIMUM SIZE'
        limit = _E2EE_VARCHAR255_MAX_LEN if field in _E2EE_VARCHAR255_FIELDS else _E2EE_FIELD_MAX_LEN
        if len(value) > limit:
            return f'{field.upper()} EXCEEDS MAXIMUM SIZE'
    return None

def _recovery_key_server_verifier(recovery_key_hash):
    """Return a server-side verifier for the client recovery-key hash."""
    if not recovery_key_hash or not isinstance(recovery_key_hash, str):
        return None
    secret = app.config['SECRET_KEY'].encode('utf-8')
    payload = ('recovery-key-v1:' + recovery_key_hash).encode('utf-8')
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()

def _verify_user_credentials(user, password=None, auth_token=None):
    """Verify a user's CURRENT login credentials, using exactly the same rules as
    /login: split-key auth_token for split_key_version >= 1, legacy Werkzeug
    password hash for split_key_version 0.

    Every secret comparison goes through hmac.compare_digest so no byte-by-byte
    timing oracle is exposed. Returns True only on a positive match.

    Used by every route that must re-prove credential knowledge before touching
    key material or second-factor state (/api/keys, /change-password,
    /account/2fa/*, /delete-account)."""
    if not user:
        return False
    # AUDIT FIX: non-string credential proofs (JSON numbers/objects/arrays)
    # used to reach auth_token.encode() and raise an unhandled AttributeError
    # 500. A proof that is not text cannot match anything — reject it as a
    # normal credential failure instead of crashing the route.
    if password is not None and not isinstance(password, str):
        return False
    if auth_token is not None and not isinstance(auth_token, str):
        return False
    import hashlib as _hashlib_verify
    import hmac as _hmac_verify
    if auth_token and user.split_key_version and user.split_key_version >= 1 and user.auth_token_hash:
        provided_hash = _hashlib_verify.sha256(auth_token.encode('utf-8')).hexdigest()
        return _hmac_verify.compare_digest(provided_hash, user.auth_token_hash)
    if password:
        if not user.split_key_version or user.split_key_version == 0:
            if not user.password_hash:
                return False
            try:
                return check_password_hash(user.password_hash, password)
            except Exception:
                return False
        print(f'[AUTH] Raw-password credential proof rejected for split-key user: {user.username}')
        return False
    return False


# ────────────────────────────────────────────────────────────────────
# AUDIT FIX M10: server-side password-length sanity bounds.
#
# RESIDUAL LIMITATION — READ BEFORE TREATING THIS AS A CONTROL.
# In split-key mode the server NEVER receives the password: the client derives
# auth_token + wrapping_key locally and only the token is transmitted. The
# `password_length` / `new_password_length` integer is therefore a CLIENT
# ASSERTION, not a measurement. A `curl` caller can send
# {"password_length": 99} together with a token derived from a 1-character
# password and it will be accepted. That is inherent to the zero-knowledge
# design and CANNOT be fixed server-side without breaking the guarantee.
#
# What IS enforced here is that the asserted value is a plausible integer inside
# sane bounds, applied IDENTICALLY on register / change-password / recovery so
# the three paths cannot disagree about the policy. Real enforcement lives in
# the browser (register.html / login.html / account.js) and is honest-client
# only. Do not mistake this for a server-side password policy.
# ────────────────────────────────────────────────────────────────────
PASSWORD_MIN_LENGTH = 6
PASSWORD_MAX_LENGTH = 1024


def _validate_asserted_password_length(raw_length, fallback_password=None):
    """Validate a client-asserted password length. Returns (ok, error_message).

    `fallback_password` is used when the caller did send a raw password (legacy
    non-split-key path), where the length can actually be measured."""
    if raw_length is None and isinstance(fallback_password, str):
        raw_length = len(fallback_password)
    try:
        length = int(raw_length)
    except (TypeError, ValueError, OverflowError):  # JSON 1e309 decodes to inf
        return False, 'PASSWORD LENGTH IS INVALID'
    if length < PASSWORD_MIN_LENGTH:
        return False, f'PASSWORD MUST BE AT LEAST {PASSWORD_MIN_LENGTH} CHARACTERS'
    if length > PASSWORD_MAX_LENGTH:
        return False, f'PASSWORD MUST BE {PASSWORD_MAX_LENGTH} CHARACTERS OR LESS'
    return True, None


_EMAIL_RE = re.compile(r'^[^@\s]{1,64}@[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+$')
_EMAIL_MAX_LEN = 120  # must match User.email db.String(120)


def _validate_email_value(email):
    """Validate an optional user-supplied email against format AND the bounded
    column width. Returns (cleaned_or_None, error_message).

    AUDIT FIX M11: an over-length or malformed value used to reach the INSERT and
    surface as a MariaDB DataError 500 with a poisoned session."""
    if email is None:
        return None, None
    if not isinstance(email, str):
        return None, 'EMAIL IS INVALID'
    email = email.strip()
    if not email:
        return None, None
    if len(email) > _EMAIL_MAX_LEN:
        return None, f'EMAIL MUST BE {_EMAIL_MAX_LEN} CHARACTERS OR LESS'
    if not _EMAIL_RE.fullmatch(email):
        return None, 'EMAIL IS NOT A VALID ADDRESS'
    return email, None


def _json_string_fields_valid(data, fields):
    """AUDIT FIX: reject non-string JSON field types with a clean 400 instead
    of an unhandled AttributeError/TypeError 500.

    JSON (unlike form encoding) delivers numbers, booleans, lists and objects
    for any field name — e.g. {"username": 123} hit `(username or '').strip()`
    and {"totp_code": [1]} hit `.strip()` on a list, crashing login, register
    and the 2FA routes with a 500. `data` must already be known to be a dict;
    absent/None fields pass through so each route's own required-field checks
    still produce the right error message."""
    if not isinstance(data, dict):
        return False
    for field in fields:
        value = data.get(field)
        if value is not None and not isinstance(value, str):
            return False
    return True


def _build_opaque_prelogin_salt(username):
    """Return a deterministic pseudo-salt for opaque pre-login responses.

    This prevents username enumeration via /auth/pre-login response shape while
    still allowing real split-key users to receive their stored auth salt."""
    import hmac as _hmac_prelogin
    secret = app.config['SECRET_KEY'].encode('utf-8')
    normalized_username = (username or '').strip().lower().encode('utf-8')
    digest = _hmac_prelogin.new(secret, b'prelogin:' + normalized_username, hashlib.sha256).digest()
    return base64.b64encode(digest).decode('utf-8')


def _build_opaque_prelogin_version(username):
    """Return a DETERMINISTIC pseudo split_key_version (0 or 1) for a username
    that does not exist.

    AUDIT FIX C1: /auth/pre-login used to hardcode split_key_version=1 for every
    username in order to stop enumeration. That forced the client down the
    split-key branch for EVERY account, so the 166 legacy (split_key_version=0)
    accounts derived an auth_token the server would never accept and never sent
    a password either — locking them out permanently and self-locking them via
    the failed-login counter.

    Real accounts now get their REAL version. Unknown usernames get a stable
    HMAC-derived pseudo-version so the response is (a) indistinguishable in shape
    from a real one, (b) identical on every probe of the same username, and
    (c) unpredictable without SECRET_KEY. Enumeration resistance is preserved."""
    import hmac as _hmac_prelogin_ver
    secret = app.config['SECRET_KEY'].encode('utf-8')
    normalized_username = (username or '').strip().lower().encode('utf-8')
    digest = _hmac_prelogin_ver.new(secret, b'prelogin-version:' + normalized_username, hashlib.sha256).digest()
    return digest[0] & 1

# ────────────────────────────────────────────────────────────────────
# AUDIT FIX H2 / M8: login brute-force throttling
# ────────────────────────────────────────────────────────────────────
# AUDIT FIX M8: the counter used to be keyed ONLY on the normalized username, so
# 10 wrong passwords from ANY source locked that account out globally for 300s.
# Usernames are enumerable, which made it a trivial targeted-DoS against any
# account (including `admin`). The primary key is now (normalized_username,
# client_ip): one attacker can only lock themselves out. A much higher
# per-username-only counter is retained as a backstop against a distributed
# guessing campaign, so the account is not left unprotected.
#
# Both counters retain the same tuple keys ('' == the global per-username
# backstop row). The dict is only a process-local mirror; flocked files are the
# cross-worker authority.
_LOGIN_FAILURE_THRESHOLD = 5         # captcha required after this many failures (per username+IP)
_LOGIN_FAILURE_LOCK_AT = 10          # hard lockout after this many failures (per username+IP)
_LOGIN_GLOBAL_FAILURE_THRESHOLD = 50   # captcha required after this many failures (username, any IP)
_LOGIN_GLOBAL_FAILURE_LOCK_AT = 100    # hard lockout after this many failures (username, any IP)
_LOGIN_LOCK_DURATION = 300           # 5 minute lockout
_LOGIN_FAILURE_RESET_AFTER = 1800    # forget failures older than 30 min
# AUDIT FIX M8: hard cap. The map is keyed on ATTACKER-SUPPLIED usernames with a
# 30-minute TTL and used to have no bound at all, while _login_failure_purge_locked
# is an O(n) scan under a global lock — an attacker could grow it without limit
# and turn every login into a long lock-held scan. Mirrors the caps already used
# by _captcha_consumed_nonces (4096) and _share_pw_failure_map (8192).
_LOGIN_FAILURE_MAP_MAX = 8192
_login_failure_lock = threading.Lock()
_login_failure_map = {}  # non-authoritative mirror


def _login_client_ip():
    """Best-effort client IP for lockout keying (ProxyFix-aware via Flask-Limiter's
    get_remote_address). Returns '' outside a request context."""
    try:
        return get_remote_address() or ''
    except Exception:
        return ''


def _login_failure_keys(normalized_username):
    """Return (scoped_key, global_key) for this username.
    scoped_key throttles a single (username, IP) pair; global_key is the
    higher-threshold backstop across all source IPs."""
    if not normalized_username:
        return None, None
    return (normalized_username, _login_client_ip()), (normalized_username, '')


def _login_failure_purge_locked():
    """Caller must hold _login_failure_lock."""
    now = time.time()
    stale = [u for u, entry in _login_failure_map.items()
             if entry.get('last_fail', 0) + _LOGIN_FAILURE_RESET_AFTER < now
             and entry.get('lock_until', 0) < now]
    for u in stale:
        _login_failure_map.pop(u, None)
    # AUDIT FIX M8: bound total growth. If the map is still over the cap after
    # dropping stale rows, evict the oldest (least recently failed) entries.
    if len(_login_failure_map) > _LOGIN_FAILURE_MAP_MAX:
        evictable = sorted(
            (k for k, e in _login_failure_map.items() if e.get('lock_until', 0) < now),
            key=lambda k: _login_failure_map[k].get('last_fail', 0)
        )
        for k in evictable[:len(_login_failure_map) - _LOGIN_FAILURE_MAP_MAX]:
            _login_failure_map.pop(k, None)


def _login_failure_state_key(key):
    return json.dumps([key[0], key[1]], separators=(',', ':'))


def _read_login_failure_state(key, now):
    state_key = _login_failure_state_key(key)
    state = _read_security_state('login_failure', state_key)
    if (not _security_state_fresh(state, now)
            or (float(state.get('last_fail', 0)) + _LOGIN_FAILURE_RESET_AFTER < now
                and float(state.get('lock_until', 0)) < now)):
        _write_security_state('login_failure', state_key, None)
        return {}
    # AUDIT FIX: a FINISHED lock must start a fresh window. `fails` used to
    # survive lock expiry, and since the arm condition is
    # `fails >= lock_at and lock_until <= now`, the FIRST failure after the
    # 300 s cooldown instantly re-armed a full 300 s lock — and every post-
    # expiry failure re-armed it again, while each failure also refreshed
    # last_fail and pushed the 30-minute decay further away. The result was
    # effectively INDEFINITE: one wrong password every five minutes kept a
    # username locked forever (an attacker could pin any account, and a
    # legitimate user with a typo could never get back in). The counter now
    # resets when the lock has expired, so post-expiry attempts count from
    # one and the threshold must be reached again to re-lock. Applies to BOTH
    # the (username, IP) row and the global per-username backstop row — both
    # are read through this helper.
    try:
        lock_until = float(state.get('lock_until', 0) or 0)
    except (TypeError, ValueError):
        lock_until = 0
    if state and 0 < lock_until <= now:
        state = dict(state)
        state['fails'] = 0
        state['lock_until'] = 0
        _write_login_failure_state(key, state)
    return state


def _write_login_failure_state(key, state):
    state_key = _login_failure_state_key(key)
    if state:
        state['retain_until'] = max(
            float(state.get('last_fail', 0)) + _LOGIN_FAILURE_RESET_AFTER,
            float(state.get('lock_until', 0)),
        )
    _write_security_state('login_failure', state_key, state)


def _login_bypass_active():
    """Return True if this request carries a valid X-RateLimit-Bypass header.
    Tests use this header to disable the global rate limit; the login
    lockout shares the same gate so test fixtures aren't tripped by
    intentional bad-password coverage."""
    # AUDIT FIX M13: additionally requires a non-production deployment signal so
    # a leaked key cannot disable the login lockout on the production instance.
    if not ALLOW_LOGIN_LOCKOUT_BYPASS or not RATELIMIT_BYPASS_KEY or not RATELIMIT_BYPASS_ALLOWED:
        return False
    try:
        import hmac as _hmac_lock_bypass
        provided = request.headers.get('X-RateLimit-Bypass', '') or ''
        return _hmac_lock_bypass.compare_digest(provided, RATELIMIT_BYPASS_KEY)
    except Exception:
        return False


def _login_lockout_status(normalized_username):
    """Return (locked, remaining_seconds_int).
    Locked when EITHER the (username, IP) counter or the higher global
    per-username backstop counter is in cooldown."""
    if not normalized_username:
        return False, 0
    if _login_bypass_active():
        return False, 0
    scoped_key, global_key = _login_failure_keys(normalized_username)
    now = time.time()
    remaining = 0
    lock_items = [('login_failure', _login_failure_state_key(key))
                  for key in (scoped_key, global_key)]
    locks = _acquire_security_state_locks(lock_items)
    try:
        for key in (scoped_key, global_key):
            entry = _read_login_failure_state(key, now)
            if not entry:
                continue
            lock_until = entry.get('lock_until', 0)
            if lock_until > now:
                remaining = max(remaining, int(lock_until - now))
    finally:
        _release_security_state_locks(locks)
    if remaining > 0:
        return True, max(1, remaining)
    return False, 0


def _login_requires_captcha(normalized_username):
    if not normalized_username:
        return False
    if _login_bypass_active():
        return False
    scoped_key, global_key = _login_failure_keys(normalized_username)
    now = time.time()
    lock_items = [('login_failure', _login_failure_state_key(key))
                  for key in (scoped_key, global_key)]
    locks = _acquire_security_state_locks(lock_items)
    try:
        scoped = _read_login_failure_state(scoped_key, now)
        glob = _read_login_failure_state(global_key, now)
        return (int(scoped.get('fails', 0)) >= _LOGIN_FAILURE_THRESHOLD
                or int(glob.get('fails', 0)) >= _LOGIN_GLOBAL_FAILURE_THRESHOLD)
    finally:
        _release_security_state_locks(locks)


def _record_failed_login(normalized_username):
    """Record a CREDENTIAL failure. Do NOT call this for a missing/invalid
    captcha (AUDIT FIX M8) — that let an attacker lock any account out with zero
    password guesses."""
    if not normalized_username:
        return
    if _login_bypass_active():
        return
    scoped_key, global_key = _login_failure_keys(normalized_username)
    now = time.time()
    lock_items = [('login_failure', _login_failure_state_key(key))
                  for key in (scoped_key, global_key)]
    locks = _acquire_security_state_locks(lock_items)
    try:
        for key, lock_at in ((scoped_key, _LOGIN_FAILURE_LOCK_AT),
                             (global_key, _LOGIN_GLOBAL_FAILURE_LOCK_AT)):
            entry = _read_login_failure_state(key, now) or {'fails': 0}
            entry['fails'] = int(entry.get('fails', 0)) + 1
            entry['last_fail'] = now
            if entry['fails'] >= lock_at and entry.get('lock_until', 0) <= now:
                entry['lock_until'] = now + _LOGIN_LOCK_DURATION
                scope = 'username+ip' if key[1] else 'username (global backstop)'
                print(f'[AUTH] Locked out username={normalized_username!r} scope={scope} '
                      f'for {_LOGIN_LOCK_DURATION}s after {entry["fails"]} failed attempts')
            _write_login_failure_state(key, entry)
            with _login_failure_lock:
                _login_failure_map[key] = dict(entry)
                _login_failure_purge_locked()
    finally:
        _release_security_state_locks(locks)


def _clear_failed_login(normalized_username):
    if not normalized_username:
        return
    scoped_key, global_key = _login_failure_keys(normalized_username)
    lock_items = [('login_failure', _login_failure_state_key(key))
                  for key in (scoped_key, global_key)]
    locks = _acquire_security_state_locks(lock_items)
    try:
        for key in (scoped_key, global_key):
            _write_login_failure_state(key, None)
            with _login_failure_lock:
                _login_failure_map.pop(key, None)
    finally:
        _release_security_state_locks(locks)


@app.route('/auth/pre-login', methods=['POST'])
@limiter.limit("15 per minute")
def pre_login():
    """Return an opaque split-key pre-login response for any username.

    To avoid username enumeration, this endpoint always returns the same JSON
    shape, in the same field order, after exactly ONE database query, for every
    username — existing or not.

    AUDIT FIX C1: the version is no longer hardcoded to 1. Real accounts get
    their REAL split_key_version (legacy v0 accounts previously could not log in
    at all, because the client was forced down the split-key branch and never
    sent a password). Unknown usernames get a deterministic HMAC-derived
    pseudo-version + pseudo-salt, so an attacker cannot tell the two apart:
    both branches are one query, one HMAC, and one identically shaped response."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:
        return jsonify({'error': 'USERNAME REQUIRED'}), 400

    username = str(data.get('username') or '').strip()
    if not username:
        return jsonify({'error': 'USERNAME REQUIRED'}), 400

    # Exactly one DB query on BOTH branches so the query count is not a signal.
    user = User.query.filter_by(username=username).first()

    if user and user.split_key_version and user.split_key_version >= 1 and user.auth_token_salt:
        # Real split-key account: real version + real stored salt.
        split_key_version = int(user.split_key_version)
        auth_token_salt = user.auth_token_salt
        # Compute (and discard) the opaque values anyway so both branches do the
        # same amount of HMAC work — the timing profile stays flat.
        _build_opaque_prelogin_version(username)
        _build_opaque_prelogin_salt(username)
    elif user:
        # Real LEGACY (v0) account, or a v1 row missing its salt: report the real
        # version so the client takes the password branch and can log in + be
        # upgraded to split-key. The salt is still opaque (there is none stored).
        split_key_version = int(user.split_key_version or 0)
        auth_token_salt = _build_opaque_prelogin_salt(username)
        _build_opaque_prelogin_version(username)
    else:
        # Unknown username: stable, unpredictable pseudo-version + pseudo-salt.
        split_key_version = _build_opaque_prelogin_version(username)
        auth_token_salt = _build_opaque_prelogin_salt(username)

    return jsonify({
        'split_key_version': split_key_version,
        'auth_token_salt': auth_token_salt,
    })

@app.route('/login', methods=['GET', 'POST'])
@limiter.limit("10 per minute", methods=["POST"])
def login():
    if request.method == 'POST':
        is_ajax = request.headers.get('X-Requested-With') == 'XMLHttpRequest'
        
        if is_ajax:
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                return jsonify({'error': 'INVALID REQUEST'}), 400
            # AUDIT FIX: guard against non-string username/password/auth_token/
            # captcha (JSON numbers/objects), which used to 500 on .strip() /
            # .encode() inside the auth paths below.
            if not _json_string_fields_valid(data, (
                    'username', 'password', 'auth_token', 'captcha')):
                return jsonify({'error': 'INVALID REQUEST'}), 400
            username = data.get('username') if data else None
            password = data.get('password') if data else None
            auth_token = data.get('auth_token') if data else None
        else:
            username = request.form.get('username')
            password = request.form.get('password')
            auth_token = None

        # AUDIT FIX H2: per-username brute-force lockout. The IP-keyed
        # Flask-Limiter cap is not enough on its own (multi-worker memory://
        # fragments the counter; distributed attacks rotate IPs). We track
        # failures per normalized username and require either a captcha or
        # a cooldown after a configurable threshold.
        normalized_login_user = (username or '').strip().lower()
        login_lockout_active, login_lockout_remaining = _login_lockout_status(normalized_login_user)
        if login_lockout_active:
            print(f'[AUTH] Login lockout active for username={normalized_login_user!r} '
                  f'({login_lockout_remaining}s remaining)')
            if is_ajax:
                return jsonify({
                    'error': f'TOO MANY FAILED LOGIN ATTEMPTS. TRY AGAIN IN {login_lockout_remaining} SECONDS.',
                    'lockout_seconds': login_lockout_remaining,
                }), 429
            flash(f'TOO MANY FAILED LOGIN ATTEMPTS. TRY AGAIN IN {login_lockout_remaining} SECONDS.', 'error')
            return redirect(url_for('login'))

        # If failure count is past the captcha threshold, require captcha even
        # if captcha is otherwise disabled. Reuse the existing math captcha.
        if _login_requires_captcha(normalized_login_user):
            if is_ajax:
                captcha_input = (data.get('captcha', '') or '').strip() if data else ''
            else:
                captcha_input = (request.form.get('captcha', '') or '').strip()
            captcha_ok = False
            if captcha_input:
                captcha_ok, _ = _validate_captcha_response(captcha_input)
            if not captcha_ok:
                # AUDIT FIX M8: a missing or wrong captcha is NOT a credential
                # failure. Counting it here let an attacker escalate any account
                # straight into a 300s lockout without guessing a single
                # password. The captcha gate itself already blocks the attempt.
                print(f'[AUTH] Captcha required/failed on login for username={normalized_login_user!r} '
                      '(not counted as a credential failure)')
                if is_ajax:
                    return jsonify({'error': 'CAPTCHA REQUIRED. SOLVE THE CAPTCHA AND RETRY.', 'captcha_required': True}), 401
                flash('CAPTCHA REQUIRED. SOLVE THE CAPTCHA AND RETRY.', 'error')
                return redirect(url_for('login'))

        user = User.query.filter_by(username=username).first()
        
        # Authenticate: try split-key auth_token first, then fall back to legacy password
        auth_ok = False
        if user and auth_token and user.split_key_version and user.split_key_version >= 1 and user.auth_token_hash:
            # Split-key auth: compare SHA-256(auth_token) with stored hash.
            # Use hmac.compare_digest for constant-time comparison to prevent timing attacks.
            import hashlib as _hashlib_login
            import hmac as _hmac_login
            provided_hash = _hashlib_login.sha256(auth_token.encode('utf-8')).hexdigest()
            auth_ok = _hmac_login.compare_digest(provided_hash, user.auth_token_hash)
            if not auth_ok:
                print(f'[AUTH] Split-key auth failed for user: {username}')
        elif user and password:
            # Legacy auth: Werkzeug password hash (only valid for split_key_version=0 users)
            if not user.split_key_version or user.split_key_version == 0:
                auth_ok = check_password_hash(user.password_hash, password)
            else:
                print(f'[AUTH] Split-key v1 user attempted raw-password login: {username}')
                check_password_hash(_dummy_password_hash(), password or 'x')
                auth_ok = False
        else:
            check_password_hash(_dummy_password_hash(), password or 'x')
            if auth_token:
                import hashlib as _hashlib_login_dummy
                import hmac as _hmac_login_dummy
                _hmac_login_dummy.compare_digest(
                    _hashlib_login_dummy.sha256(auth_token.encode('utf-8')).hexdigest(),
                    _hashlib_login_dummy.sha256(b'onegy-timing-dummy').hexdigest(),
                )
        
        if auth_ok:
            # Check if 2FA is enabled — require TOTP verification before completing login
            if user.two_factor_enabled:
                # Store pending 2FA user ID in session (not fully logged in yet)
                session['2fa_pending_user_id'] = user.id
                session['2fa_pending_username'] = user.username
                session['2fa_pending_started_at'] = time.time()
                session['2fa_pending_epoch'] = int(user.session_epoch or 0)
                print(f'[AUTH] 2FA required for user: {username}')
                if is_ajax:
                    return jsonify({'success': False, 'two_factor_required': True, 'redirect': url_for('verify_2fa')})
                return redirect(url_for('verify_2fa'))

            # SECURITY FIX: Prevent session fixation attack by regenerating session
            # Preserve guest session ID if it exists
            _clear_failed_login(normalized_login_user)
            old_guest_id = session.get('user_id')
            was_just_registered = session.get('just_registered', False)
            
            # Clear old session to prevent session fixation
            session.clear()
            
            # Restore guest session if it existed
            if old_guest_id:
                session['user_id'] = old_guest_id
            
            # Set authenticated user data
            session['logged_in_user_id'] = user.id
            session['session_epoch'] = int(user.session_epoch or 0)
            session['username'] = user.username
            session['avatar_color'] = user.avatar_color or '#555'
            # AUDIT FIX M14: mint a per-session id so /logout can revoke exactly
            # THIS session without signing the user out of their other devices.
            _mint_session_sid()
            # SECURITY: Do NOT cache is_admin - always check from database via decorators
            session.permanent = True  # Regenerate session ID
            
            # Notification trigger flags
            user.login_count = (user.login_count or 0) + 1
            db.session.commit()
            session['just_logged_in'] = True
            session.pop('_served_login_notifs', None)
            session.pop('_session_notif_dismissed', None)
            session.pop('_session_notif_active', None)
            if was_just_registered:
                session['just_registered'] = True
            
            print(f'[AUTH] User logged in: {username}')
            
            if is_ajax:
                # Return encrypted key material for client-side key unlock
                key_data = {}
                if user.has_e2ee_keys:
                    key_data = {
                        'has_e2ee_keys': True,
                        'encrypted_master_key': user.encrypted_master_key,
                        'master_key_nonce': user.master_key_nonce,
                        'master_key_salt': user.master_key_salt,
                        'encrypted_private_key': user.encrypted_private_key,
                        'private_key_nonce': user.private_key_nonce,
                        'public_key': user.public_key
                    }
                else:
                    key_data = {'has_e2ee_keys': False}
                return jsonify({'success': True, 'redirect': url_for('files'), 'csrf_token': generate_csrf(), **key_data})
            
            return redirect(url_for('files'))
        else:
            # AUDIT FIX H2: record failed login for per-username throttling.
            _record_failed_login(normalized_login_user)
            captcha_required_next = _login_requires_captcha(normalized_login_user)
            if is_ajax:
                return jsonify({
                    'error': 'INVALID USERNAME OR PASSWORD',
                    'captcha_required': captcha_required_next,
                }), 401
            flash('INVALID USERNAME OR PASSWORD', 'error')
            return redirect(url_for('login'))
    
    return render_template('login.html')

@app.route('/logout', methods=['GET', 'POST'])
def logout():
    if request.method == 'GET':
        return redirect(url_for('index'))

    username = None
    if 'logged_in_user_id' in session:
        try:
            user = db.session.get(User, session['logged_in_user_id'])
            if user:
                username = user.username
        except Exception as e:
            print(f'[AUTH] Could not resolve username during logout: {e}')
            try:
                db.session.rollback()
            except Exception:
                pass

    # AUDIT FIX M14: session.clear() only hands THIS browser a fresh cookie. A
    # cookie captured before logout stayed valid for the rest of
    # PERMANENT_SESSION_LIFETIME, and because session.permanent is re-set on
    # every request the attacker could renew that window indefinitely. Persist a
    # revocation record for this specific session id so the old cookie is dead
    # everywhere — WITHOUT touching session_epoch, which would sign the user out
    # of all their other devices too.
    revoked = _revoke_current_session()

    # SECURITY FIX: Preserve guest session ID if it exists (for temp uploads)
    guest_user_id = session.get('user_id')

    # Clear entire session (more secure than popping individual keys)
    session.clear()

    # Restore guest session for anonymous uploads
    if guest_user_id:
        session['user_id'] = guest_user_id

    if revoked:
        print(f'[AUTH] User logged out: {username} (session revoked)')
        flash('YOU HAVE BEEN LOGGED OUT', 'success')
    else:
        print(f'[ERROR] Local logout completed for {username}, but server-side sign-out was not recorded')
        flash('LOCAL SESSION CLEARED, BUT SERVER-SIDE SIGN-OUT COULD NOT BE RECORDED. PLEASE SIGN IN AND TRY AGAIN.', 'error')
    return redirect(url_for('index'))

# ─── Two-Factor Authentication (TOTP) ────────────────────────────────

# ─── TOTP secret encryption helpers ──────────────────────────────────────────
# TOTP secrets are encrypted at rest using the application's Fernet key.
# Legacy plaintext secrets (stored before this change) are detected by attempting
# Fernet decryption — if that raises an InvalidToken error, the value is plaintext
# and is re-encrypted transparently on first use.

