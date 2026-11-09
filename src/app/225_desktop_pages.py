# Website pages for the desktop app: /desktop download page and /account/devices
# (devices, their read-only backup folders, the keep-versions preference).

# Release assets keep stable names, so /releases/latest/download/<name> always
# serves the newest CI build.
DESKTOP_REPO_URL = 'https://github.com/tifuck/one.gy'
DESKTOP_RELEASES_URL = DESKTOP_REPO_URL + '/releases/latest'
DESKTOP_DOWNLOADS = {
    'windows': DESKTOP_RELEASES_URL + '/download/ONE.GY-Desktop-Setup.exe',
    'appimage': DESKTOP_RELEASES_URL + '/download/ONE.GY-Desktop-x86_64.AppImage',
    'deb': DESKTOP_RELEASES_URL + '/download/onegy-desktop_amd64.deb',
}
DEVICE_NAME_MAX = 80


def _desktop_platform_from_ua(user_agent):
    """'windows', 'linux' or None (macOS, mobile, unknown) from a User-Agent."""
    ua = (user_agent or '').lower()
    if 'windows' in ua:
        return 'windows'
    if 'linux' in ua and 'android' not in ua:
        return 'linux'
    return None


@app.route('/desktop')
def desktop_page():
    return render_template('desktop.html',
                           platform=_desktop_platform_from_ua(request.headers.get('User-Agent')),
                           downloads=DESKTOP_DOWNLOADS,
                           releases_url=DESKTOP_RELEASES_URL,
                           repo_url=DESKTOP_REPO_URL)


@app.route('/account/devices')
@limiter.limit(file_ops_rate_limit)
@login_required
def account_devices():
    user = _current_session_user()
    if not user:
        session.pop('logged_in_user_id', None)
        return redirect(url_for('login'))
    devices = (Device.query.filter_by(user_id=user.id, is_active=True)
               .order_by(Device.last_seen_at.desc(), Device.created_at.desc()).all())
    # Backups of removed devices are listed too: only Stop backup frees them.
    device_names = {d.id: d.name for d in devices}
    backups = (Folder.query.filter_by(user_id=user.id, is_backup=True, is_trashed=False)
               .order_by(Folder.id).all())
    return render_template('account_devices.html', user=user, devices=devices,
                           device_name_max=DEVICE_NAME_MAX, backups=backups,
                           device_names=device_names)


def _owned_active_device(user, device_id):
    return Device.query.filter_by(id=device_id, user_id=user.id, is_active=True).first()


@app.route('/account/devices/<device_id>/rename', methods=['POST'])
@limiter.limit("20 per minute")
@login_required
def rename_device(device_id):
    user = _current_session_user()
    if not user:
        session.pop('logged_in_user_id', None)
        return redirect(url_for('login'))
    device = _owned_active_device(user, device_id)
    if not device:
        flash('DEVICE NOT FOUND', 'error')
        return redirect(url_for('account_devices'))
    name = (request.form.get('name') or '').strip()
    if not name or len(name) > DEVICE_NAME_MAX or _LOG_UNSAFE_RE.search(name):
        flash(f'DEVICE NAME MUST BE 1 TO {DEVICE_NAME_MAX} CHARACTERS', 'error')
        return redirect(url_for('account_devices'))
    old_name = device.name
    device.name = name
    db.session.commit()
    print(f'[DEVICE] Renamed device {device.id} "{_log_safe(old_name)}" -> "{_log_safe(name)}" for user: {user.username}')
    flash('DEVICE RENAMED', 'success')
    return redirect(url_for('account_devices'))


@app.route('/account/devices/<device_id>/revoke', methods=['POST'])
@limiter.limit("20 per minute")
@login_required
def revoke_device(device_id):
    user = _current_session_user()
    if not user:
        session.pop('logged_in_user_id', None)
        return redirect(url_for('login'))
    device = _owned_active_device(user, device_id)
    if not device:
        flash('DEVICE NOT FOUND', 'error')
        return redirect(url_for('account_devices'))
    device.is_active = False
    device.revoked_at = datetime.now(timezone.utc)
    db.session.commit()
    print(f'[DEVICE] Removed device {device.id} "{_log_safe(device.name)}" for user: {user.username} (via browser)')
    flash('DEVICE REMOVED. IT IS SIGNED OUT AND STOPS SYNCING', 'success')
    return redirect(url_for('account_devices'))


@app.route('/account/devices/backups/<int:folder_id>/stop', methods=['POST'])
@limiter.limit("20 per minute")
@login_required
def stop_backup(folder_id):
    """Stop a desktop backup: keep it as a normal folder (action=keep) or move
    it to the trash (action=trash). The one website write a backup allows."""
    user = _current_session_user()
    if not user:
        session.pop('logged_in_user_id', None)
        return redirect(url_for('login'))
    action = request.form.get('action')
    if action not in ('keep', 'trash'):
        flash('INVALID REQUEST', 'error')
        return redirect(url_for('account_devices'))
    lifecycle_lock = _acquire_user_lifecycle_lock(user.id)
    try:
        db.session.rollback()
        folder = Folder.query.filter_by(id=folder_id, user_id=user.id, is_backup=True, is_trashed=False).first()
        if not folder:
            flash('BACKUP NOT FOUND', 'error')
            return redirect(url_for('account_devices'))
        device_id = folder.backup_device_id
        folder.is_backup = None
        folder.backup_device_id = None
        folder.updated_at = datetime.now(timezone.utc)
        if action == 'trash':
            parent_id_before = folder.parent_id
            trash_folder_recursive(folder.id)
            folder.parent_id = None
            touch_folder(parent_id_before)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    print(f'[DEVICE] Stopped backup folder {folder_id} of device {device_id} ({action}) for user: {user.username}')
    flash('BACKUP MOVED TO TRASH' if action == 'trash' else 'BACKUP STOPPED. IT IS A NORMAL FOLDER NOW', 'success')
    return redirect(url_for('account_devices'))


@app.route('/account/file-versions', methods=['POST'])
@limiter.limit("20 per minute")
@login_required
def set_keep_file_versions():
    user = _current_session_user()
    if not user:
        session.pop('logged_in_user_id', None)
        return redirect(url_for('login'))
    user.keep_file_versions = request.form.get('keep_file_versions') == 'on'
    db.session.commit()
    print(f'[ACCOUNT] keep_file_versions={user.keep_file_versions} for user: {user.username}')
    flash('PREVIOUS VERSIONS ARE KEPT' if user.keep_file_versions else 'PREVIOUS VERSIONS ARE NO LONGER KEPT', 'success')
    return redirect(url_for('account_devices'))
