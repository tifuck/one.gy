@app.route('/admin')
@limiter.limit(admin_rate_limit)
@admin_required
def admin():
    # Decorator handles authentication and admin check from database
    return render_template('admin.html')

# AUDIT FIX A11: bounds for an admin-set per-user storage limit. The lower bound
# keeps an admin from accidentally locking a user out of every upload with a
# stray '-1' or '0'; the upper bound keeps an absurd value (1e30) out of the DB.
ADMIN_MIN_USER_STORAGE_GB = 0.001
ADMIN_MAX_USER_STORAGE_GB = 1048576  # 1 PiB


ADMIN_LIST_MAX_PER_PAGE = 100


def _clamp_pagination(page, per_page, max_per_page=ADMIN_LIST_MAX_PER_PAGE):
    """Clamp page/per_page to sane minimums AND maximums.

    AUDIT FIX A12: `per_page = min(per_page, 100)` set no floor, so ?per_page=0
    produced a ZeroDivisionError in the page-count arithmetic and ?page=0 (or a
    negative page) produced a negative OFFSET -- both 500s from a query string."""
    try:
        page = int(page)
    except (TypeError, ValueError):
        page = 1
    try:
        per_page = int(per_page)
    except (TypeError, ValueError):
        per_page = 20
    page = max(1, page)
    per_page = max(1, min(per_page, max_per_page))
    return page, per_page


def _is_ajax_request():
    """True when the caller expects JSON rather than a redirect + flash.

    AUDIT FIX A13: the admin console calls these routes with fetch(); a 302 that
    fetch() transparently follows looks like success no matter what happened."""
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return True
    accept = request.headers.get('Accept') or ''
    return 'application/json' in accept and 'text/html' not in accept


@app.route('/admin/user/<int:user_id>/edit', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_edit_user(user_id):
    # Decorator handles authentication and admin check from database
    import math as _math

    user = User.query.get_or_404(user_id)
    is_ajax = _is_ajax_request()

    # AUDIT FIX A11: `if storage_limit:` silently skipped the update for an empty
    # string (and for '0') while still reporting success, and a supplied value
    # went straight into float() with no bounds at all -- negatives locked the
    # user out of every upload, and inf/nan (both accepted by float()) made every
    # `used > limit` comparison False, silently granting unlimited storage.
    raw_storage_limit = request.form.get('storage_limit_gb')
    if raw_storage_limit is None or not str(raw_storage_limit).strip():
        if is_ajax:
            return jsonify({'error': 'STORAGE LIMIT REQUIRED'}), 400
        flash('STORAGE LIMIT REQUIRED', 'error')
        return redirect(url_for('admin'))

    try:
        storage_limit_gb = float(str(raw_storage_limit).strip())
    except (ValueError, TypeError, OverflowError):
        if is_ajax:
            return jsonify({'error': 'INVALID STORAGE LIMIT'}), 400
        flash('INVALID STORAGE LIMIT', 'error')
        return redirect(url_for('admin'))

    if not _math.isfinite(storage_limit_gb):
        print(f'[ADMIN] Rejected non-finite storage limit for {user.username}')
        if is_ajax:
            return jsonify({'error': 'INVALID STORAGE LIMIT'}), 400
        flash('INVALID STORAGE LIMIT', 'error')
        return redirect(url_for('admin'))

    if storage_limit_gb < ADMIN_MIN_USER_STORAGE_GB:
        message = f'STORAGE LIMIT MUST BE AT LEAST {ADMIN_MIN_USER_STORAGE_GB} GB'
        if is_ajax:
            return jsonify({'error': message}), 400
        flash(message, 'error')
        return redirect(url_for('admin'))

    if storage_limit_gb > ADMIN_MAX_USER_STORAGE_GB:
        print(f'[ADMIN] Clamped storage limit for {user.username} from {storage_limit_gb} to '
              f'{ADMIN_MAX_USER_STORAGE_GB} GB')
        storage_limit_gb = float(ADMIN_MAX_USER_STORAGE_GB)

    storage_limit_gb = round(storage_limit_gb, 3)
    try:
        user.storage_limit_gb = storage_limit_gb
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f'[ERROR] Failed to update storage limit for {user.username}: {e}')
        if is_ajax:
            return jsonify({'error': 'FAILED TO UPDATE STORAGE LIMIT'}), 500
        flash('FAILED TO UPDATE STORAGE LIMIT', 'error')
        return redirect(url_for('admin'))

    print(f'[ADMIN] Updated storage limit for {user.username} to {storage_limit_gb}GB')
    if is_ajax:
        return jsonify({'success': True, 'storage_limit_gb': user.storage_limit_gb})
    flash(f'UPDATED STORAGE LIMIT FOR {user.username.upper()}', 'success')
    return redirect(url_for('admin'))

@app.route('/admin/user/<int:user_id>/delete', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_delete_user(user_id):
    # Decorator handles authentication and admin check from database
    # AUDIT FIX A13: this route used to end EVERY path in redirect(url_for('admin'))
    # with the real outcome only in flash(). admin.js called it via fetch(), saw
    # the followed redirect as r.ok, swallowed the JSON parse error and
    # unconditionally toasted 'USER DELETED' -- so when the delete threw and
    # rolled back, the admin was told the account and all its data were destroyed
    # while nothing had changed. AJAX callers now get the real result as JSON.
    is_ajax = _is_ajax_request()

    # Don't allow deleting yourself
    if user_id == session['logged_in_user_id']:
        if is_ajax:
            return jsonify({'error': 'CANNOT DELETE YOUR OWN ACCOUNT'}), 400
        flash('CANNOT DELETE YOUR OWN ACCOUNT', 'error')
        return redirect(url_for('admin'))

    admin_reduction_lock = None
    lifecycle_lock = None
    try:
        admin_reduction_lock = _acquire_admin_reduction_lock()
        lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
        _, user, reduction_error = _revalidate_admin_reduction(
            session['logged_in_user_id'], user_id)
        if reduction_error in ('actor_missing', 'actor_not_admin'):
            if is_ajax:
                return jsonify({'error': 'ADMIN ACCESS REQUIRED'}), 403
            flash('ADMIN ACCESS REQUIRED', 'error')
            return redirect(url_for('index'))
        if reduction_error == 'target_missing':
            if is_ajax:
                return jsonify({'error': 'USER NOT FOUND'}), 404
            flash('USER NOT FOUND', 'error')
            return redirect(url_for('admin'))
        if reduction_error == 'last_admin':
            if is_ajax:
                return jsonify({'error': 'CANNOT DELETE THE LAST ADMINISTRATOR'}), 400
            flash('CANNOT DELETE THE LAST ADMINISTRATOR', 'error')
            return redirect(url_for('admin'))

        # Collect disk paths to delete after DB commit
        paths_to_delete = []
        
        # AUDIT FIX (finding 4): defer thumbnail BLOB columns (see
        # delete_account); the delete itself and the stage+commit stay atomic.
        user_files = File.query.filter_by(registered_user_id=user.id).options(
            db.defer(File.thumbnail_data),
            db.defer(File.encrypted_thumbnail_data),
        ).all()
        for file in user_files:
            paths_to_delete.extend(_file_payload_delete_keys(file))
            db.session.delete(file)
        
        # Delete all user's folders
        user_folders = Folder.query.filter_by(user_id=user.id).all()
        for folder in user_folders:
            db.session.delete(folder)
        print(f'[ADMIN] Deleted {len(user_folders)} folders for user {user.username}')
        
        # Delete all user's notes and notebooks + collect note file paths
        user_notes = Note.query.filter_by(user_id=user.id).all()
        note_paths = [_note_payload_delete_key(n.id) for n in user_notes]
        for n in user_notes:
            db.session.delete(n)
        Notebook.query.filter_by(user_id=user.id).delete()
        print(f'[ADMIN] Deleted {len(user_notes)} notes for user {user.username}')
        
        # Delete API keys, music records, pending notes, and notification dismissals
        ApiKey.query.filter_by(user_id=user.id).delete()
        # AUDIT FIX D13: see _release_sent_pending_notes -- notes this user SENT
        # belong to their recipients and must survive an admin deleting them.
        PendingNote.query.filter(PendingNote.recipient_id == user.id).delete(synchronize_session=False)
        _release_sent_pending_notes(user.id)
        _playlist_ids = [p.id for p in MusicPlaylist.query.filter_by(user_id=user.id).with_entities(MusicPlaylist.id).all()]
        if _playlist_ids:
            MusicPlaylistSong.query.filter(MusicPlaylistSong.playlist_id.in_(_playlist_ids)).delete(synchronize_session=False)
        MusicPlaylist.query.filter_by(user_id=user.id).delete()
        MusicLike.query.filter_by(user_id=user.id).delete()
        MusicSyncCommand.query.filter_by(user_id=user.id).delete(synchronize_session=False)
        MusicDevice.query.filter_by(user_id=user.id).delete()
        MusicSyncState.query.filter_by(user_id=user.id).delete()
        NotificationDismissal.query.filter(NotificationDismissal.user_id == user.id).delete(synchronize_session=False)
        # AUDIT FIX (finding 18): the user's prompt-feedback rows are theirs --
        # retaining them after an account deletion left personal notes keyed
        # to a user_id that no longer exists.
        PromptFeedback.query.filter(PromptFeedback.user_id == user.id).delete(synchronize_session=False)
        
        username = user.username
        db.session.delete(user)

        # AUDIT FIX (atomic permanent delete): stage file + note remote-delete
        # tombstones and replica-row deletes into the SAME transaction as the
        # account metadata deletion; local disk purged after the commit succeeds.
        local_targets = storage.stage_payload_deletes(paths_to_delete)
        local_targets += storage.stage_payload_deletes(note_paths)
        db.session.commit()

        _release_lifecycle_lock(lifecycle_lock)
        lifecycle_lock = None
        _release_admin_reduction_lock(admin_reduction_lock)
        admin_reduction_lock = None

        # DB commit succeeded -- now safe to remove local disk payloads
        _purge_staged_locals_with_note_locks(local_targets)
        
        print(f'[ADMIN] Deleted user: {username}')
        if is_ajax:
            return jsonify({'success': True, 'deleted_user_id': user_id, 'username': username})
        flash(f'DELETED USER {username.upper()}', 'success')
    except Exception as e:
        db.session.rollback()
        print(f'[ERROR] Admin delete user failed for {user_id}: {e}')
        if is_ajax:
            return jsonify({'error': 'USER DELETION FAILED. PLEASE TRY AGAIN'}), 500
        flash('USER DELETION FAILED. PLEASE TRY AGAIN', 'error')
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_admin_reduction_lock(admin_reduction_lock)
    return redirect(url_for('admin'))

@app.route('/admin/delete-user-files/<user_id>', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_delete_user_files(user_id):
    # Decorator handles authentication and admin check from database
    # AUDIT FIX A13: AJAX callers get the real outcome as JSON.
    is_ajax = _is_ajax_request()

    # Get all files for this user_id (session-based, for temp uploads).
    # The dead LargeBinary thumbnail columns are never read here.
    user_files = _file_query_without_blobs().filter_by(user_id=user_id, is_temp_upload=True).all()
    
    deleted_count = 0
    paths_to_delete = []
    for file in user_files:
        paths_to_delete.extend(_file_payload_delete_keys(file))
        db.session.delete(file)
        deleted_count += 1
    
    try:
        # AUDIT FIX (atomic permanent delete): tombstones + replica deletes ride the
        # same commit as the metadata deletions; local disk purged afterwards.
        local_targets = storage.stage_payload_deletes(paths_to_delete)
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f'[ERROR] Admin delete of visitor files failed for {user_id}: {e}')
        if is_ajax:
            return jsonify({'error': 'FILE DELETION FAILED. PLEASE TRY AGAIN'}), 500
        flash('FILE DELETION FAILED. PLEASE TRY AGAIN', 'error')
        return redirect(url_for('admin'))
    
    storage.purge_staged_locals(local_targets)
    check_storage()
    
    print(f'[ADMIN] Deleted {deleted_count} temp files from user {user_id[:8]}...')
    if is_ajax:
        return jsonify({'success': True, 'deleted': deleted_count})
    flash(f'DELETED {deleted_count} FILES FROM VISITOR', 'success')
    return redirect(url_for('admin'))

@app.route('/admin/user/<int:user_id>/toggle_admin', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_toggle_admin(user_id):
    # Decorator handles authentication and admin check from database
    # AUDIT FIX A13: report the real outcome to AJAX callers instead of a 302
    # that fetch() follows and the console reads as unconditional success.
    is_ajax = _is_ajax_request()

    user = User.query.get_or_404(user_id)
    
    # Don't allow removing your own admin status
    if user.id == session['logged_in_user_id']:
        if is_ajax:
            return jsonify({'error': 'CANNOT MODIFY YOUR OWN ADMIN STATUS'}), 400
        flash('CANNOT MODIFY YOUR OWN ADMIN STATUS', 'error')
        return redirect(url_for('admin'))

    # Optional client expectation: admin.js sends the is_admin value it
    # rendered, so a double submit or a concurrent flip fails loudly instead
    # of toggling twice. Callers that omit it keep plain toggle semantics.
    expected_raw = None
    payload = request.get_json(silent=True)
    if isinstance(payload, dict):
        expected_raw = payload.get('expected_current')
    if expected_raw is None:
        expected_raw = request.form.get('expected_current')
    expected_current = None
    if expected_raw is not None:
        expected_flag = str(expected_raw).strip().lower()
        if expected_flag in ('1', 'true', 'yes', 'on'):
            expected_current = True
        elif expected_flag in ('0', 'false', 'no', 'off'):
            expected_current = False

    admin_reduction_lock = None
    try:
        # AUDIT FIX H1: the lock now guards every admin-status change (grant
        # and revoke), not just demotions. Taking it unconditionally closes
        # the window where a concurrent demote between get_or_404 and the old
        # `if user.is_admin:` check skipped the lock entirely, and the
        # in-lock re-fetch (populate_existing) keeps the flip off a stale
        # ORM value.
        admin_reduction_lock = _acquire_admin_reduction_lock()
        _, user, reduction_error = _revalidate_admin_reduction(
            session['logged_in_user_id'], user_id)
        if reduction_error in ('actor_missing', 'actor_not_admin'):
            if is_ajax:
                return jsonify({'error': 'ADMIN ACCESS REQUIRED'}), 403
            flash('ADMIN ACCESS REQUIRED', 'error')
            return redirect(url_for('index'))
        if reduction_error == 'target_missing':
            if is_ajax:
                return jsonify({'error': 'USER NOT FOUND'}), 404
            flash('USER NOT FOUND', 'error')
            return redirect(url_for('admin'))
        if reduction_error == 'last_admin':
            if is_ajax:
                return jsonify({'error': 'CANNOT DEMOTE THE LAST ADMINISTRATOR'}), 400
            flash('CANNOT DEMOTE THE LAST ADMINISTRATOR', 'error')
            return redirect(url_for('admin'))

        if expected_current is not None and bool(user.is_admin) != expected_current:
            if is_ajax:
                return jsonify({'error': 'ADMIN STATUS CHANGED, PLEASE RETRY'}), 409
            flash('ADMIN STATUS CHANGED, PLEASE RETRY', 'error')
            return redirect(url_for('admin'))

        user.is_admin = not user.is_admin
        is_admin = user.is_admin
        username = user.username
        db.session.commit()

        _release_admin_reduction_lock(admin_reduction_lock)
        admin_reduction_lock = None
    except Exception as e:
        db.session.rollback()
        print(f'[ERROR] Failed to toggle admin status for user {user_id}: {e}')
        if is_ajax:
            return jsonify({'error': 'FAILED TO UPDATE ADMIN STATUS'}), 500
        flash('FAILED TO UPDATE ADMIN STATUS', 'error')
        return redirect(url_for('admin'))
    finally:
        _release_admin_reduction_lock(admin_reduction_lock)

    status = 'ADMIN' if is_admin else 'USER'
    print(f'[ADMIN] Set {username} to {status}')
    if is_ajax:
        return jsonify({'success': True, 'is_admin': is_admin, 'username': username})
    flash(f'SET {username.upper()} TO {status}', 'success')
    return redirect(url_for('admin'))


@app.route('/admin/user/<int:user_id>/revoke-access', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_revoke_user_access(user_id):
    """Invalidate a user's sessions and active API keys without deleting data."""
    if user_id == session['logged_in_user_id']:
        return jsonify({'error': 'CANNOT REVOKE YOUR OWN ACCESS'}), 400

    lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
    try:
        user = db.session.get(User, user_id)
        if not user:
            return jsonify({'error': 'USER NOT FOUND'}), 404

        user.session_epoch = db.func.coalesce(User.session_epoch, 0) + 1  # atomic in SQL: concurrent rotations must not collapse into one
        revoked_keys = _deactivate_user_api_keys(user.id)
        db.session.commit()
        print(f'[ADMIN] Admin {session["logged_in_user_id"]} revoked sessions and '
              f'{revoked_keys} API key(s) for user {user.id} ({user.username})')
        return jsonify({
            'success': True,
            'username': user.username,
            'sessions_revoked': True,
            'api_keys_revoked': revoked_keys,
        })
    except Exception as e:
        db.session.rollback()
        print(f'[ERROR] Failed to revoke access for user {user_id}: {e}')
        return jsonify({'error': 'FAILED TO REVOKE USER ACCESS'}), 500
    finally:
        _release_lifecycle_lock(lifecycle_lock)

@app.route('/admin/api/stats')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_stats():
    """Return comprehensive admin statistics as JSON."""
    snapshot = capture_system_metrics_snapshot(force=False)
    payload = _build_admin_live_stats()
    payload['history'] = {
        'latest_snapshot_at': _utc_aware(snapshot.captured_at).isoformat() if snapshot else None,
        'windows': list(ADMIN_STATS_WINDOWS.keys()),
    }
    return jsonify(payload)

@app.route('/admin/api/stats/history')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_stats_history():
    """Return bucketed admin metrics history for charts."""
    window = request.args.get('window', '1d', type=str)
    if window not in ADMIN_STATS_WINDOWS:
        window = '1d'
    return jsonify(build_admin_stats_history(window))

@app.route('/admin/api/users')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_users():
    """Return paginated user list as JSON"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)
    search = request.args.get('search', '', type=str).strip()
    sort_by = request.args.get('sort', 'created_at', type=str)
    sort_dir = request.args.get('dir', 'desc', type=str)
    
    # AUDIT FIX A12: min() capped the upper bound but set no floor, so
    # ?per_page=0 reached `(total + per_page - 1) // per_page` -> ZeroDivisionError
    # -> 500, and ?page=0 (or a negative page) produced .offset(-20) -> a MariaDB
    # syntax error -> 500.
    page, per_page = _clamp_pagination(page, per_page)
    
    query = User.query
    if search:
        query = query.filter(
            db.or_(
                User.username.ilike(f'%{escape_like_pattern(search[:128])}%', escape='\\'),
                User.email.ilike(f'%{escape_like_pattern(search[:128])}%', escape='\\')
            )
        )
    
    # Sorting (whitelist to prevent probing model attributes)
    _user_sort_whitelist = {'username', 'email', 'created_at', 'is_admin', 'storage_limit_gb'}
    if sort_by not in _user_sort_whitelist:
        sort_by = 'created_at'
    sort_column = getattr(User, sort_by, User.created_at)
    if sort_dir == 'asc':
        query = query.order_by(sort_column.asc())
    else:
        query = query.order_by(sort_column.desc())
    
    total = query.count()
    users = query.offset((page - 1) * per_page).limit(per_page).all()

    # Batch-fetch account metadata instead of issuing per-user aggregate queries.
    # These storage expressions intentionally match User.get_storage_used().
    user_ids = [u.id for u in users]
    if user_ids:
        _file_counts = dict(db.session.query(
            File.registered_user_id, db.func.count(File.id)
        ).filter(File.registered_user_id.in_(user_ids), File.is_trashed == False)
         .group_by(File.registered_user_id).all())
        _trashed_file_counts = dict(db.session.query(
            File.registered_user_id, db.func.count(File.id)
        ).filter(File.registered_user_id.in_(user_ids), File.is_trashed == True)
         .group_by(File.registered_user_id).all())
        _folder_counts = dict(db.session.query(
            Folder.user_id, db.func.count(Folder.id)
        ).filter(Folder.user_id.in_(user_ids), Folder.is_trashed == False).group_by(Folder.user_id).all())
        _note_counts = dict(db.session.query(
            Note.user_id, db.func.count(Note.id)
        ).filter(Note.user_id.in_(user_ids), Note.is_trashed == False)
         .group_by(Note.user_id).all())
        _file_storage_sums = dict(db.session.query(
            File.registered_user_id,
            db.func.coalesce(db.func.sum(db.func.coalesce(File.disk_size, File.size)), 0)
        ).filter(File.registered_user_id.in_(user_ids), File.is_trashed == False)
         .group_by(File.registered_user_id).all())
        _note_storage_sums = dict(db.session.query(
            Note.user_id, db.func.coalesce(db.func.sum(Note.size), 0)
        ).filter(Note.user_id.in_(user_ids), Note.is_trashed == False)
         .group_by(Note.user_id).all())
        _active_api_key_counts = dict(db.session.query(
            ApiKey.user_id, db.func.count(ApiKey.id)
        ).filter(ApiKey.user_id.in_(user_ids), ApiKey.is_active == True)
         .group_by(ApiKey.user_id).all())
    else:
        _file_counts = {}
        _trashed_file_counts = {}
        _folder_counts = {}
        _note_counts = {}
        _file_storage_sums = {}
        _note_storage_sums = {}
        _active_api_key_counts = {}

    def _admin_user_payload(user):
        storage_used = int(_file_storage_sums.get(user.id, 0) or 0) + int(
            _note_storage_sums.get(user.id, 0) or 0)
        storage_limit = int(float(user.storage_limit_gb or 0) * (1024 ** 3))
        storage_percent = (storage_used / storage_limit * 100) if storage_limit else 0
        return {
            'id': user.id,
            'username': user.username,
            'email': user.email or '',
            'is_admin': user.is_admin,
            'file_count': _file_counts.get(user.id, 0),
            'trashed_file_count': _trashed_file_counts.get(user.id, 0),
            'folder_count': _folder_counts.get(user.id, 0),
            'note_count': _note_counts.get(user.id, 0),
            'storage_used_bytes': storage_used,
            'storage_limit_bytes': storage_limit,
            'storage_remaining_bytes': max(0, storage_limit - storage_used),
            'storage_percent': round(storage_percent, 1),
            'over_quota': storage_used > storage_limit,
            # Retained for existing API consumers.
            'storage_used_gb': round(storage_used / (1024 ** 3), 2),
            'storage_limit_gb': user.storage_limit_gb,
            'has_e2ee_keys': user.has_e2ee_keys,
            'split_key_version': user.split_key_version or 0,
            'two_factor_enabled': bool(user.two_factor_enabled),
            'login_count': user.login_count or 0,
            'active_api_key_count': _active_api_key_counts.get(user.id, 0),
            'created_at': user.created_at.strftime('%Y-%m-%d %H:%M') if user.created_at else '',
            'avatar_color': user.avatar_color,
        }

    return jsonify({
        'users': [_admin_user_payload(u) for u in users],
        'total': total,
        'page': page,
        'per_page': per_page,
        'pages': (total + per_page - 1) // per_page,
    })

@app.route('/admin/api/temp-files')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_temp_files():
    """Return paginated temp files list as JSON"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)
    search = request.args.get('search', '', type=str).strip()
    sort_by = request.args.get('sort', 'upload_time', type=str)
    sort_dir = request.args.get('dir', 'desc', type=str)
    
    # AUDIT FIX A12: clamp both bounds (see admin_api_users).
    page, per_page = _clamp_pagination(page, per_page)
    
    query = _file_query_without_blobs().filter_by(is_temp_upload=True)
    # Only active (not expired)
    query = query.filter(
        db.or_(
            File.expires_at == None,
            File.expires_at >= datetime.now(timezone.utc)
        )
    )
    
    if search:
        query = query.filter(File.orig_name.ilike(f'%{escape_like_pattern(search[:128])}%', escape='\\'))
    
    # Sorting (whitelist to prevent probing model attributes)
    _file_sort_whitelist = {'orig_name', 'upload_time', 'size', 'download_count'}
    if sort_by not in _file_sort_whitelist:
        sort_by = 'upload_time'
    sort_column = getattr(File, sort_by, File.upload_time)
    if sort_dir == 'asc':
        query = query.order_by(sort_column.asc())
    else:
        query = query.order_by(sort_column.desc())
    
    total = query.count()
    files = query.offset((page - 1) * per_page).limit(per_page).all()
    
    return jsonify({
        'files': [{
            'id': f.id,
            'orig_name': f.orig_name,
            'size': f.size,
            'user_id': f.user_id[:8] + '...' if f.user_id else '',
            'full_user_id': f.user_id,
            'upload_time': f.get_upload_time_aware().strftime('%Y-%m-%d %H:%M'),
            'expires_at': f.get_expires_at_aware().strftime('%Y-%m-%d %H:%M') if f.expires_at else None,
            'download_count': f.download_count or 0,
            'max_downloads': f.max_downloads,
            'is_public': f.is_public,
            'is_e2e_encrypted': f.is_e2e_encrypted,
            'has_password': f.password_hash is not None,
            'management_token': f.management_token,
            'short_code': f.short_code,
        } for f in files],
        'total': total,
        'page': page,
        'per_page': per_page,
        'pages': (total + per_page - 1) // per_page,
    })

@app.route('/admin/api/cleanup', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_cleanup():
    """Run cleanup tasks and return results"""
    try:
        cleanup_expired_files()
        cleanup_orphaned_files()
        cleanup_orphaned_notes()
        cleanup_stale_preps()
        cleanup_stale_progress()
        cleanup_remote_staging_files()
        cleanup_local_staged_files()
        cleanup_temp_dirs()
        cleanup_stale_music_sync()
        print('[ADMIN] Manual cleanup triggered')
        return jsonify({'success': True, 'message': 'CLEANUP COMPLETE'})
    except Exception as e:
        print(f'[ADMIN] Cleanup error: {e}')
        return jsonify({'error': 'CLEANUP FAILED'}), 500

@app.route('/admin/api/settings')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_settings():
    """Return current values for all toggleable settings"""
    return jsonify({
        'allow_registration': get_setting('allow_registration'),
        'captcha_enabled': get_setting('captcha_enabled'),
        'allow_temp_uploads': get_setting('allow_temp_uploads'),
        'allow_api_keys': get_setting('allow_api_keys'),
        'welcome_folder_enabled': get_setting('welcome_folder_enabled'),
        'allow_music': get_setting('allow_music'),
        'storage_cache_ttl_minutes': get_numeric_setting('storage_cache_ttl_minutes'),
        # AUDIT FIX D5: trash retention is a setting now, not a magic constant.
        'trash_retention_hours': get_trash_retention_hours(),
        'temp_max_gb': get_float_setting('temp_max_gb'),
    })

@app.route('/admin/api/settings', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_settings_update():
    """Update one or more toggleable settings.

    AUDIT FIX M8: two-phase write. Every key is validated BEFORE anything is
    persisted; then all valid keys are staged and committed in ONE transaction
    (single commit, single cache-invalidation pass). Previously each key
    committed independently inside the loop, so a mid-loop error returned an
    error AFTER earlier keys were already persisted -- a partial config was
    applied while the admin saw a failure -- and unparseable numeric/float
    values were silently `continue`d, making a rejected value look identical
    to an ignored one. Now any bad key rejects the WHOLE request up front with
    a 400 naming each rejected key (all-or-nothing). The admin.js client
    (`jsend`/`failToast`) only surfaces `data.error` on non-2xx and ignores
    extra fields on 2xx, so rejecting the request is the only contract it can
    actually show; `rejected` is still included for API consumers."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400

    import math as _math

    boolean_keys = {'allow_registration', 'captcha_enabled', 'allow_temp_uploads', 'allow_api_keys', 'welcome_folder_enabled', 'allow_music'}
    numeric_keys = {'storage_cache_ttl_minutes', 'trash_retention_hours'}
    float_keys = {'temp_max_gb'}

    # AUDIT FIX A10/A11: clamp numeric input to sane bounds and reject
    # non-finite floats. `float('inf')`/`float('nan')` parse fine in Python and
    # would otherwise be persisted as config.
    numeric_bounds = {
        'storage_cache_ttl_minutes': (1, 10080),
        'trash_retention_hours': (1, 8760),
    }
    float_bounds = {'temp_max_gb': (0.01, 1024.0)}

    # Phase 1 -- validate ALL keys; persist nothing.
    rejections = {}   # key -> reason
    prepared = []     # (key, normalized_value) cleared for phase 2
    for key, value in data.items():
        if key in boolean_keys:
            if not isinstance(value, bool):
                rejections[key] = 'MUST BE A BOOLEAN'
                continue
            prepared.append((key, value))
        elif key in numeric_keys:
            try:
                int_val = int(value)
            except (ValueError, TypeError, OverflowError):
                rejections[key] = 'MUST BE AN INTEGER'
                continue
            low, high = numeric_bounds.get(key, (1, 10 ** 9))
            prepared.append((key, max(low, min(int_val, high))))
        elif key in float_keys:
            try:
                float_val = float(value)
            except (ValueError, TypeError, OverflowError):
                rejections[key] = 'MUST BE A NUMBER'
                continue
            if not _math.isfinite(float_val):
                rejections[key] = 'MUST BE A FINITE NUMBER'
                continue
            low, high = float_bounds.get(key, (0.01, 10 ** 9))
            prepared.append((key, round(max(low, min(float_val, high)), 2)))

    if rejections:
        # M8: nothing has been written -- fail the whole request (all or
        # nothing) and name every rejected key so the admin toast is concrete.
        detail = '; '.join(f'{k.upper()} {reason}' for k, reason in rejections.items())
        print(f'[ADMIN] Rejected settings update: {detail}')
        return jsonify({'error': f'REJECTED SETTINGS: {detail}', 'rejected': rejections}), 400

    # Phase 2 -- stage every key on ONE transaction, commit once.
    updated = []
    try:
        for key, value in prepared:
            _stage_setting(key, value)
            updated.append(key)
        db.session.commit()
    except ValueError as e:
        # AUDIT FIX A10: over-long value -> clean 400 instead of a DataError 500.
        db.session.rollback()
        print(f'[ADMIN] Rejected settings update: {e}')
        return jsonify({'error': str(e).upper()}), 400
    except Exception as e:
        # M8: rollback the whole transaction so zero keys persist.
        db.session.rollback()
        print(f'[ADMIN] Failed to update settings: {e}')
        return jsonify({'error': 'FAILED TO UPDATE SETTINGS'}), 500

    for key, value in prepared:
        _invalidate_settings_cache(key)
        print(f'[ADMIN] Setting {key} changed to {value}')

    if not updated:
        return jsonify({'error': 'NO VALID SETTINGS PROVIDED'}), 400

    return jsonify({'success': True, 'updated': updated})

# ─── Admin Storage Node Management Endpoints ──────────────────────────

