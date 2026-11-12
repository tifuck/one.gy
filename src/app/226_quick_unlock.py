# Quick unlock: sign in and open the website's E2EE keys in one browser with a
# fingerprint or face (a passkey's PRF output) or a PIN instead of the password
# (static/quick-unlock.js). It follows the desktop app's PIN:
#   - The browser keeps the master key wrapped under a secret derived from the
#     passkey or PIN plus a share only the server has. The server hands the share
#     out for the right proof, which is derived from the same passkey or PIN and a
#     salt that never leaves that browser, so it cannot be guessed from here.
#   - The proof also signs the browser in when its session has ended. Setting it up
#     took a signed-in session (password and 2FA) plus the password again.
#   - It works for desktop_pin_max_age_days after the password was entered in that
#     browser; five wrong proofs in a row erase it; signing out there removes it;
#     anything that moves session_epoch (password change, recovery, 2FA enrolment,
#     signing out everywhere) ends every quick unlock of the account.

QUICK_UNLOCK_METHODS = ('passkey', 'pin')
QUICK_UNLOCK_MAX_FAILURES = 5
QUICK_UNLOCK_MAX_PER_USER = 20


def _quick_unlock_gone():
    return jsonify({'error': 'QUICK UNLOCK IS OFF ON THIS DEVICE. USE YOUR PASSWORD'}), 404


def _quick_unlock_expires_at(row):
    verified = _utc_aware(row.password_verified_at)
    return verified + timedelta(days=get_numeric_setting('desktop_pin_max_age_days')) if verified else None


def _quick_unlock_row(unlock_id, for_update=False):
    """(row, user) while the row can still work, else (None, None). A row that never
    can again is deleted: its account is gone or moved to another session_epoch, or
    it expired."""
    query = QuickUnlock.query.filter_by(id=unlock_id)
    if for_update:
        query = query.populate_existing().with_for_update()
    row = query.first()
    if row is None:
        return None, None
    user = db.session.get(User, row.user_id)
    expires = _quick_unlock_expires_at(row)
    if (user is None or not row.proof_hash or row.session_epoch != int(user.session_epoch or 0)
            or expires is None or expires <= datetime.now(timezone.utc)):
        db.session.delete(row)
        db.session.commit()
        return None, None
    return row, user


def _quick_unlock_sign_in(user):
    """Start a session for user, the way /login does after a password."""
    guest_id = session.get('user_id')
    session.clear()
    if guest_id:
        session['user_id'] = guest_id
    session['logged_in_user_id'] = user.id
    session['session_epoch'] = int(user.session_epoch or 0)
    session['username'] = user.username
    session['avatar_color'] = user.avatar_color or '#555'
    _mint_session_sid()
    session.permanent = True
    session['just_logged_in'] = True
    user.login_count = (user.login_count or 0) + 1


@app.route('/account/quick-unlock', methods=['POST'])
@limiter.limit("10 per minute")
@login_required
def quick_unlock_enroll():
    """{"method", "auth_token", "proof"} -> {"id", "share"}. The password proof keeps
    a borrowed session from planting its own PIN, and starts the row's lifetime."""
    user = _current_session_user()
    if not user:
        return jsonify({'error': 'USER NOT FOUND'}), 404
    data = _json_object_body()
    if not _json_string_fields_valid(data, ('method', 'auth_token', 'proof')):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    proof = data.get('proof') or ''
    if data.get('method') not in QUICK_UNLOCK_METHODS or len(proof) < 32:
        return jsonify({'error': 'INVALID REQUEST'}), 400
    if not user.has_e2ee_keys:
        return jsonify({'error': 'THIS ACCOUNT HAS NO ENCRYPTION KEYS'}), 409
    if not _verify_user_credentials(user, auth_token=data.get('auth_token')):
        return jsonify({'error': 'INCORRECT PASSWORD'}), 403
    epoch = int(user.session_epoch or 0)
    QuickUnlock.query.filter(QuickUnlock.user_id == user.id, QuickUnlock.session_epoch != epoch).delete(synchronize_session=False)
    # A browser whose storage was cleared leaves its row behind and nothing lists
    # them, so the oldest make room: that browser asks for the password again.
    rows = QuickUnlock.query.filter_by(user_id=user.id).order_by(QuickUnlock.created_at, QuickUnlock.id).all()
    for oldest in rows[:max(0, len(rows) - QUICK_UNLOCK_MAX_PER_USER + 1)]:
        db.session.delete(oldest)
    row = QuickUnlock(user_id=user.id, method=data['method'], session_epoch=epoch,
                      share=base64.b64encode(secrets.token_bytes(32)).decode('ascii'),
                      proof_hash=hashlib.sha256(proof.encode('utf-8')).hexdigest(),
                      password_verified_at=datetime.now(timezone.utc))
    db.session.add(row)
    db.session.commit()
    print(f'[AUTH] Quick unlock ({row.method}) set up for user: {user.username}')
    return jsonify({'id': row.id, 'share': row.share})


@app.route('/account/quick-unlock/<unlock_id>', methods=['GET'])
@login_required
def quick_unlock_status(unlock_id):
    row, user = _quick_unlock_row(unlock_id)
    if row is None or user.id != session.get('logged_in_user_id'):
        return _quick_unlock_gone()
    return jsonify({'id': row.id, 'method': row.method,
                    'attempts_left': QUICK_UNLOCK_MAX_FAILURES - int(row.failures or 0),
                    'expires_at': _quick_unlock_expires_at(row).isoformat()})


@app.route('/account/quick-unlock/<unlock_id>/unlock', methods=['POST'])
@limiter.limit("10 per minute")
def quick_unlock_unlock(unlock_id):
    """{"proof"} -> {"share", "signed_in", "redirect"}. No session needed: the right
    proof also signs this browser in (the sign-in page), like the desktop app's PIN."""
    data = _json_object_body()
    if not _json_string_fields_valid(data, ('proof',)):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    current = _current_session_user()
    # Locked current read: concurrent wrong proofs must each count.
    row, user = _quick_unlock_row(unlock_id, for_update=True)
    if row is None or (current is not None and current.id != user.id):
        return _quick_unlock_gone()
    method = row.method
    proof_hash = hashlib.sha256((data.get('proof') or '').encode('utf-8')).hexdigest()
    if not hmac.compare_digest(proof_hash, row.proof_hash):
        row.failures = int(row.failures or 0) + 1
        left = QUICK_UNLOCK_MAX_FAILURES - row.failures
        if left <= 0:
            db.session.delete(row)
        db.session.commit()
        print(f'[AUTH] Wrong quick unlock {method} for user {user.username} ({max(left, 0)} attempts left)')
        if left <= 0:
            return jsonify({'error': 'TOO MANY WRONG TRIES. USE YOUR PASSWORD'}), 404
        if method == 'pin':
            return jsonify({'error': f'WRONG PIN. {left} {"TRY" if left == 1 else "TRIES"} LEFT', 'attempts_left': left}), 401
        return jsonify({'error': 'QUICK UNLOCK FAILED. TRY AGAIN OR USE YOUR PASSWORD', 'attempts_left': left}), 401
    row.failures = 0
    share = row.share
    signed_in = current is None
    if signed_in:
        _quick_unlock_sign_in(user)
        print(f'[AUTH] User signed in with quick unlock ({method}): {user.username}')
    db.session.commit()
    return jsonify({'share': share, 'signed_in': signed_in, 'redirect': url_for('files')})


@app.route('/account/quick-unlock/<unlock_id>', methods=['DELETE'])
@login_required
def quick_unlock_remove(unlock_id):
    QuickUnlock.query.filter_by(id=unlock_id, user_id=session.get('logged_in_user_id')).delete(synchronize_session=False)
    db.session.commit()
    return jsonify({'success': True})
