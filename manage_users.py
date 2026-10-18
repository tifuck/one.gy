#!/usr/bin/env python3
"""CLI tool for managing users in the ONE.GY database."""

import math
import re
import sys
from datetime import datetime, timezone

from werkzeug.security import generate_password_hash

from app import (
    DEFAULT_USER_STORAGE_GB,
    ApiKey,
    File,
    Folder,
    MusicDevice,
    MusicLike,
    MusicPlaylist,
    MusicPlaylistSong,
    MusicSyncState,
    Note,
    Notebook,
    Notification,
    NotificationDismissal,
    PendingNote,
    User,
    _acquire_admin_reduction_lock,
    _acquire_user_lifecycle_lock,
    _file_payload_delete_keys,
    _note_payload_delete_key,
    _purge_staged_locals_with_note_locks,
    _release_admin_reduction_lock,
    _release_lifecycle_lock,
    _release_sent_pending_notes,
    _revalidate_admin_reduction,
    app,
    db,
    redact_database_uri,
    storage,
)


USERNAME_RE = re.compile(r'^[A-Za-z0-9_.-]+$')


def validate_new_username(username):
    if not username or len(username) > 80 or not USERNAME_RE.fullmatch(username):
        print('Error: Username may only contain letters, numbers, underscores, hyphens, and dots (max 80 characters).')
        sys.exit(1)


def cmd_list(args):
    """List all users."""
    users = User.query.order_by(User.id).all()

    if not users:
        print('No users found.')
        return

    print(f'{"ID":<5} {"USERNAME":<20} {"EMAIL":<30} {"ADMIN":<7} {"STORAGE (GB)":<14} {"CREATED"}')
    print('-' * 100)
    for user in users:
        admin = 'Yes' if user.is_admin else 'No'
        email = user.email or '-'
        storage = f'{float(user.storage_limit_gb or 0):.1f}'
        created = user.created_at or '-'
        print(f'{user.id:<5} {user.username:<20} {email:<30} {admin:<7} {storage:<14} {created}')

    print(f'\nTotal: {len(users)} user(s)')


def cmd_add(args):
    """Add a new user."""
    if len(args) < 1:
        print('Usage: manage_users.py add <username> [--admin] [--email <email>]')
        print('  Password is read securely from the terminal.')
        sys.exit(1)

    username = args[0]
    validate_new_username(username)
    email = None
    if '--email' in args:
        idx = args.index('--email')
        # Never take the next option (e.g. --admin) as the address.
        if idx + 1 >= len(args) or args[idx + 1].startswith('--'):
            print('Error: --email requires a value.')
            sys.exit(1)
        email = args[idx + 1]
    import getpass
    password = getpass.getpass('Password: ')
    if not password:
        print('Error: Password cannot be empty.')
        sys.exit(1)

    is_admin = '--admin' in args
    if is_admin:
        confirm_admin = input(f'Create "{username}" as an administrator? [y/N]: ').strip().lower()
        if confirm_admin != 'y':
            print('Cancelled.')
            sys.exit(1)

    if len(password) < 6:
        print('Error: Password must be at least 6 characters.')
        sys.exit(1)

    existing = User.query.filter_by(username=username).first()
    if existing:
        print(f'Error: User "{username}" already exists.')
        sys.exit(1)

    if email and User.query.filter_by(email=email).first():
        print(f'Error: Email "{email}" is already in use.')
        sys.exit(1)

    user = User(
        username=username,
        email=email,
        password_hash=generate_password_hash(password, method='pbkdf2:sha256'),
        is_admin=is_admin,
        storage_limit_gb=DEFAULT_USER_STORAGE_GB,
        created_at=datetime.now(timezone.utc),
        split_key_version=0,
        auth_token_hash=None,
        auth_token_salt=None,
    )
    db.session.add(user)
    db.session.commit()

    role = 'admin' if is_admin else 'user'
    print(f'User "{username}" created successfully ({role}).')


def cmd_delete(args):
    """Delete a user and optionally their files."""
    if len(args) < 1:
        print('Usage: manage_users.py delete <username> [--keep-files]')
        sys.exit(1)

    username = args[0]
    keep_files = '--keep-files' in args

    user = User.query.filter_by(username=username).first()
    if not user:
        print(f'Error: User "{username}" not found.')
        sys.exit(1)

    user_files = File.query.filter_by(registered_user_id=user.id).all()
    user_folders = Folder.query.filter_by(user_id=user.id).all()
    user_notes = Note.query.filter_by(user_id=user.id).all()

    print(f'User: {username} (ID: {user.id})')
    print(f'Files: {len(user_files)}, Folders: {len(user_folders)}, Notes: {len(user_notes)}')

    if user.is_admin and User.query.filter_by(is_admin=True).count() <= 1:
        print('Error: Refusing to delete the last remaining admin.')
        sys.exit(1)

    confirm = input(f'Are you sure you want to delete "{username}"? [y/N]: ').strip().lower()
    if confirm != 'y':
        print('Cancelled.')
        return

    user_id = user.id
    admin_reduction_lock = _acquire_admin_reduction_lock()
    lifecycle_lock = None
    local_targets = []
    deleted = False
    try:
        lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
        _, user, reduction_error = _revalidate_admin_reduction(
            user_id, user_id, require_acting_admin=False)
        if reduction_error in ('actor_missing', 'target_missing'):
            print(f'Error: User "{username}" was deleted concurrently.')
            return
        if reduction_error == 'last_admin':
            print('Error: Refusing to delete the last remaining admin.')
            return
        user_files = File.query.filter_by(registered_user_id=user_id).all()
        user_folders = Folder.query.filter_by(user_id=user_id).all()
        user_notes = Note.query.filter_by(user_id=user_id).all()
        paths_to_delete = []
        note_paths = []

        if not keep_files:
            for file_obj in user_files:
                paths_to_delete.extend(_file_payload_delete_keys(file_obj))
                db.session.delete(file_obj)
            print(f'Deleting {len(user_files)} file(s) and {len(user_folders)} folder(s).')
        else:
            for file_obj in user_files:
                file_obj.registered_user_id = None
                file_obj.folder_id = None
            print('Files kept (unlinked from user and folders). Folders will be deleted.')

        for folder in user_folders:
            db.session.delete(folder)

        ApiKey.query.filter_by(user_id=user_id).delete(synchronize_session=False)

        for note in user_notes:
            note_paths.append(_note_payload_delete_key(note.id))
            db.session.delete(note)
        Notebook.query.filter_by(user_id=user_id).delete(synchronize_session=False)

        PendingNote.query.filter(PendingNote.recipient_id == user_id).delete(synchronize_session=False)
        _release_sent_pending_notes(user_id)
        playlist_ids = [p.id for p in MusicPlaylist.query.filter_by(user_id=user_id).with_entities(MusicPlaylist.id).all()]
        if playlist_ids:
            MusicPlaylistSong.query.filter(MusicPlaylistSong.playlist_id.in_(playlist_ids)).delete(synchronize_session=False)
        MusicPlaylist.query.filter_by(user_id=user_id).delete(synchronize_session=False)
        MusicLike.query.filter_by(user_id=user_id).delete(synchronize_session=False)
        MusicDevice.query.filter_by(user_id=user_id).delete(synchronize_session=False)
        MusicSyncState.query.filter_by(user_id=user_id).delete(synchronize_session=False)
        NotificationDismissal.query.filter(NotificationDismissal.user_id == user_id).delete(synchronize_session=False)
        Notification.query.filter(Notification.created_by == user_id).update({'created_by': None}, synchronize_session=False)

        db.session.delete(user)

        local_targets = storage.stage_payload_deletes(paths_to_delete)
        local_targets += storage.stage_payload_deletes(note_paths)
        db.session.commit()
        deleted = True
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_admin_reduction_lock(admin_reduction_lock)

    if not deleted:
        return
    _purge_staged_locals_with_note_locks(local_targets)
    print(f'User "{username}" deleted. Related API keys, notes, music state, pending shares, and dismissals were cleaned up.')


def cmd_password(args):
    """Change a user's password."""
    if len(args) < 1:
        print('Usage: manage_users.py password <username>')
        print('  Password is read securely from the terminal.')
        sys.exit(1)

    username = args[0]
    import getpass
    new_password = getpass.getpass('New password: ')
    if not new_password:
        print('Error: Password cannot be empty.')
        sys.exit(1)

    if len(new_password) < 6:
        print('Error: Password must be at least 6 characters.')
        sys.exit(1)

    user = User.query.filter_by(username=username).first()
    if not user:
        print(f'Error: User "{username}" not found.')
        sys.exit(1)

    if (user.split_key_version and user.split_key_version >= 1) or user.has_e2ee_keys:
        print('Error: This account has E2EE key material. CLI password reset cannot rewrap it.')
        print('Use the browser password-change flow while logged in, or the recovery-key flow.')
        sys.exit(1)

    user.password_hash = generate_password_hash(new_password, method='pbkdf2:sha256')
    user.session_epoch = int(user.session_epoch or 0) + 1

    db.session.commit()
    print(f'Password updated for "{username}". All existing sessions were invalidated.')


def cmd_reset_2fa(args):
    """Clear two-factor authentication for a user.

    AUDIT FIX H5: 2FA was a permanent, unrecoverable lockout. Disabling requires
    a valid CURRENT TOTP code, there are no backup codes anywhere in the
    codebase, and there is no admin route for it — so a lost authenticator meant
    manual DB surgery. This is the operator escape hatch.
    """
    if len(args) < 1:
        print('Usage: manage_users.py reset-2fa <username>')
        sys.exit(1)

    username = args[0]
    user = User.query.filter_by(username=username).first()
    if not user:
        print(f'Error: User "{username}" not found.')
        sys.exit(1)

    if not user.two_factor_enabled and not user.two_factor_secret:
        print(f'User "{username}" does not have 2FA enabled.')
        return

    confirm = input(f'Disable 2FA for "{username}"? [y/N]: ').strip().lower()
    if confirm != 'y':
        print('Cancelled.')
        return

    user.two_factor_enabled = False
    user.two_factor_secret = None
    # Evict every existing session so a hijacker who bound the removed factor
    # cannot keep using a live cookie.
    user.session_epoch = int(user.session_epoch or 0) + 1
    db.session.commit()

    print(f'2FA reset for "{username}". All existing sessions were invalidated; the user must sign in again.')


def cmd_promote(args):
    """Promote a user to admin."""
    if len(args) < 1:
        print('Usage: manage_users.py promote <username>')
        sys.exit(1)

    username = args[0]
    user = User.query.filter_by(username=username).first()
    if not user:
        print(f'Error: User "{username}" not found.')
        sys.exit(1)

    if user.is_admin:
        print(f'User "{username}" is already an admin.')
        return

    user.is_admin = True
    db.session.commit()
    print(f'User "{username}" promoted to admin.')


def cmd_demote(args):
    """Demote an admin to regular user."""
    if len(args) < 1:
        print('Usage: manage_users.py demote <username>')
        sys.exit(1)

    username = args[0]
    user = User.query.filter_by(username=username).first()
    if not user:
        print(f'Error: User "{username}" not found.')
        sys.exit(1)

    if not user.is_admin:
        print(f'User "{username}" is not an admin.')
        return

    # Same serialization as the web UI and cmd_delete: count and demote under the
    # shared admin-reduction lock, on fresh rows, so concurrent reductions cannot
    # each see "another admin exists" and together remove every admin.
    user_id = user.id
    admin_reduction_lock = _acquire_admin_reduction_lock()
    try:
        _, user, reduction_error = _revalidate_admin_reduction(
            user_id, user_id, require_acting_admin=False)
        if reduction_error in ('actor_missing', 'target_missing'):
            print(f'Error: User "{username}" was deleted concurrently.')
            sys.exit(1)
        if reduction_error == 'last_admin':
            print('Error: Refusing to demote the last remaining admin.')
            sys.exit(1)
        if not user.is_admin:
            print(f'User "{username}" is not an admin.')
            return
        user.is_admin = False
        db.session.commit()
    finally:
        _release_admin_reduction_lock(admin_reduction_lock)
    print(f'User "{username}" demoted to regular user.')


def cmd_storage(args):
    """Set a user's storage limit."""
    if len(args) < 2:
        print('Usage: manage_users.py storage <username> <limit_gb>')
        sys.exit(1)

    username = args[0]
    try:
        limit_gb = float(args[1])
    except ValueError:
        print('Error: Storage limit must be a number (in GB).')
        sys.exit(1)

    if not math.isfinite(limit_gb) or limit_gb <= 0 or limit_gb > 1000000:
        print('Error: Storage limit must be a finite positive number no greater than 1000000 GB.')
        sys.exit(1)

    user = User.query.filter_by(username=username).first()
    if not user:
        print(f'Error: User "{username}" not found.')
        sys.exit(1)

    user.storage_limit_gb = limit_gb
    db.session.commit()
    print(f'Storage limit for "{username}" set to {limit_gb:.1f} GB.')


def cmd_info(args):
    """Show detailed info about a user."""
    if len(args) < 1:
        print('Usage: manage_users.py info <username>')
        sys.exit(1)

    username = args[0]
    user = User.query.filter_by(username=username).first()
    if not user:
        print(f'Error: User "{username}" not found.')
        sys.exit(1)

    storage_used_bytes = int(user.get_storage_used() or 0)
    storage_used_gb = storage_used_bytes / (1024 * 1024 * 1024)
    storage_limit_gb = float(user.storage_limit_gb or 0)
    file_count = File.query.filter_by(registered_user_id=user.id).count()
    folder_count = Folder.query.filter_by(user_id=user.id).count()

    print(f'User: {user.username}')
    print(f'ID: {user.id}')
    print(f'Email: {user.email or "-"}')
    print(f'Admin: {"Yes" if user.is_admin else "No"}')
    print(f'Created: {user.created_at or "-"}')
    print(f'Storage Limit: {storage_limit_gb:.1f} GB')
    print(f'Storage Used: {storage_used_gb:.3f} GB ({storage_used_bytes:,} bytes)')
    print(f'Storage Remaining: {storage_limit_gb - storage_used_gb:.3f} GB')
    print(f'Files: {file_count}')
    print(f'Folders: {folder_count}')


def cmd_email(args):
    """Set or clear a user's email."""
    if len(args) < 1:
        print('Usage: manage_users.py email <username> [new_email]')
        print('  Omit new_email to clear it.')
        sys.exit(1)

    username = args[0]
    new_email = args[1] if len(args) > 1 else None

    user = User.query.filter_by(username=username).first()
    if not user:
        print(f'Error: User "{username}" not found.')
        sys.exit(1)

    if new_email:
        existing = User.query.filter(User.email == new_email, User.id != user.id).first()
        if existing:
            print(f'Error: Email "{new_email}" is already in use.')
            sys.exit(1)

    user.email = new_email
    db.session.commit()

    if new_email:
        print(f'Email for "{username}" set to "{new_email}".')
    else:
        print(f'Email cleared for "{username}".')


COMMANDS = {
    'list': (cmd_list, 'List all users'),
    'add': (cmd_add, 'Add a new user: add <username> [--admin] [--email <email>] '
                     '(password is read securely from the terminal — any password given as an argument is IGNORED)'),
    'delete': (cmd_delete, 'Delete a user: delete <username> [--keep-files]'),
    'password': (cmd_password, 'Change password: password <username> '
                               '(new password is read securely from the terminal — an argv password is IGNORED)'),
    'reset-2fa': (cmd_reset_2fa, 'Disable 2FA for a locked-out user: reset-2fa <username>'),
    'promote': (cmd_promote, 'Promote user to admin: promote <username>'),
    'demote': (cmd_demote, 'Demote admin to user: demote <username>'),
    'storage': (cmd_storage, 'Set storage limit: storage <username> <limit_gb>'),
    'info': (cmd_info, 'Show user details: info <username>'),
    'email': (cmd_email, 'Set/clear email: email <username> [new_email]'),
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help', 'help'):
        print('ONE.GY User Management')
        print(f'Database: {redact_database_uri()}\n')
        print('Commands:')
        for name, (_, desc) in COMMANDS.items():
            print(f'  {name:<12} {desc}')
        print(f'\nUsage: python {sys.argv[0]} <command> [args...]')
        sys.exit(0)

    cmd = sys.argv[1]
    if cmd not in COMMANDS:
        print(f'Unknown command: {cmd}')
        print(f'Run "python {sys.argv[0]} help" for available commands.')
        sys.exit(1)

    with app.app_context():
        COMMANDS[cmd][0](sys.argv[2:])


if __name__ == '__main__':
    main()
