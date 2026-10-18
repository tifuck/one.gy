NOTES_SHARED_INBOX_KEY = 'shared_inbox'
NOTES_PENDING_LIMIT = 100
NOTES_PENDING_MAX_CONTENT_SIZE = 25 * 1024 * 1024
NOTES_PENDING_AGGREGATE_MAX_BYTES = 100 * 1024 * 1024
NOTES_NOTE_CONTENT_MAX_BYTES = 100 * 1024 * 1024
# These fields live in MariaDB TEXT columns (max 65,535 bytes, strict mode
# rejects more), so the limits must not exceed that: 64 * 1024 was one byte
# over and 128 KiB tags could never be stored.
_MARIADB_TEXT_MAX_BYTES = 65535
NOTES_ENCRYPTED_FIELD_MAX_BYTES = _MARIADB_TEXT_MAX_BYTES
NOTES_ENCRYPTED_TAGS_MAX_BYTES = _MARIADB_TEXT_MAX_BYTES
NOTES_WRAPPED_KEY_MAX_BYTES = _MARIADB_TEXT_MAX_BYTES
NOTES_NONCE_MAX_BYTES = 2048
NOTES_JSON_ENVELOPE_MAX_BYTES = (
    NOTES_ENCRYPTED_FIELD_MAX_BYTES +
    NOTES_ENCRYPTED_TAGS_MAX_BYTES +
    NOTES_WRAPPED_KEY_MAX_BYTES +
    (NOTES_NONCE_MAX_BYTES * 4) +
    (256 * 1024)
)


def _notes_request_limit_bytes(max_content_bytes=0):
    return int(max_content_bytes or 0) + NOTES_JSON_ENVELOPE_MAX_BYTES


def _load_notes_json_request(max_content_bytes, error_message):
    limit_bytes = _notes_request_limit_bytes(max_content_bytes)
    if _request_content_length_exceeds(limit_bytes):
        return None, (jsonify({'error': error_message}), 413)
    try:
        raw = request.get_data(cache=True)
    except Exception:
        return None, (jsonify({'error': error_message}), 413)
    if raw and len(raw) > limit_bytes:
        return None, (jsonify({'error': error_message}), 413)
    if not raw:
        return {}, None
    try:
        return json.loads(raw.decode('utf-8')), None
    except Exception:
        return None, None


def _acquire_pending_note_user_locks(user_ids):
    locks = []
    for user_id in sorted({int(uid) for uid in user_ids if uid is not None}):
        locks.append(_acquire_scoped_lock(f'pending_note_user_{user_id}', prefix='pending_note'))
    return locks


def _release_pending_note_user_locks(locks):
    for lock_file in reversed(list(locks or [])):
        _release_scoped_lock(lock_file)


def _acquire_pending_note_decision_lock(pending_id):
    return _acquire_scoped_lock(
        f'pending_note_decision_{int(pending_id)}', prefix='pending_note')


def _lock_current_pending_note_for_decision(pending_id, recipient_id):
    """Fetch the current pending row after the shared decision lock is held."""
    db.session.rollback()
    return PendingNote.query.filter_by(
        id=pending_id, recipient_id=recipient_id
    ).populate_existing().with_for_update().first()


def _notes_text_size(value):
    if value is None:
        return 0
    return len(value.encode('utf-8'))

def _notes_validate_text_field(data, key, label, max_bytes, required=False):
    if key not in data:
        if required:
            raise ValueError(f'{label} REQUIRED')
        return
    value = data.get(key)
    if value is None:
        if required:
            raise ValueError(f'{label} REQUIRED')
        return
    if not isinstance(value, str):
        raise ValueError(f'INVALID {label}')
    if required and not value:
        raise ValueError(f'{label} REQUIRED')
    if _notes_text_size(value) > max_bytes:
        raise ValueError(f'{label} TOO LARGE')

def _notes_validate_content_field(data, max_bytes=NOTES_NOTE_CONTENT_MAX_BYTES, required=False):
    # H2 FIX: content and nonce are one wrapped pair. The PUT handler writes
    # data.get('content_nonce') straight into Note.content_nonce, so accepting
    # ciphertext without its nonce committed an undecryptable note. Validate
    # them as a unit, exactly like title/nonce, tags/nonce and note-key/nonce.
    # A lone content_nonce (no encrypted_content) is rejected too: the handlers
    # only apply it alongside a content write, so it would silently desync.
    _notes_validate_wrapped_field_pair(
        data, 'encrypted_content', 'content_nonce', 'NOTE CONTENT',
        required=required, value_max_bytes=max_bytes,
        nonce_max_bytes=NOTES_NONCE_MAX_BYTES)

def _notes_pending_total_bytes(field_name, value):
    query = db.session.query(db.func.sum(PendingNote.content_size)).filter_by(**{field_name: value})
    if field_name == 'sender_id':
        # AUDIT FIX D13: rows repointed here by a sender-account deletion are not
        # this user's outgoing notes and must not count against their send quota.
        query = query.filter(db.or_(PendingNote.sender_deleted.is_(None),
                                    PendingNote.sender_deleted == False))
    total = query.scalar() or 0
    return int(total or 0)

def _notes_normalize_color(color):
    if color is None:
        return None
    if not isinstance(color, str):
        raise ValueError('INVALID COLOR')
    color = color.strip()
    if not color:
        return None
    if not re.match(r'^#[0-9A-Fa-f]{6}$', color):
        raise ValueError('INVALID COLOR')
    return color.upper()

def _notes_parse_position(value, field_name='POSITION'):
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):  # JSON 1e309 decodes to inf
        raise ValueError(f'INVALID {field_name}')

def _notes_validate_wrapped_field_pair(data, value_key, nonce_key, label, required=False, value_max_bytes=NOTES_ENCRYPTED_FIELD_MAX_BYTES, nonce_max_bytes=NOTES_NONCE_MAX_BYTES):
    has_value = value_key in data
    has_nonce = nonce_key in data
    value = data.get(value_key)
    nonce = data.get(nonce_key)
    if required and (not value or not nonce):
        raise ValueError(f'{label} REQUIRED')
    if has_value != has_nonce:
        raise ValueError(f'{label} REQUIRED')
    if has_value and bool(value) != bool(nonce):
        raise ValueError(f'{label} REQUIRED')
    if has_value and value_key == 'encrypted_note_key' and not value:
        raise ValueError(f'{label} REQUIRED')
    # Type-check every supplied value except the explicit empties (None / ''):
    # a falsy non-string such as false or 0 must not slip through as "empty".
    if has_value and value not in (None, ''):
        if not isinstance(value, str):
            raise ValueError(f'INVALID {label}')
        if value_max_bytes is not None and _notes_text_size(value) > value_max_bytes:
            raise ValueError(f'{label} TOO LARGE')
    if has_nonce and nonce not in (None, ''):
        if not isinstance(nonce, str):
            raise ValueError(f'INVALID {label}')
        if nonce_max_bytes is not None and _notes_text_size(nonce) > nonce_max_bytes:
            raise ValueError(f'{label} TOO LARGE')

def _notes_normalize_system_key(system_key):
    if system_key is None:
        return None
    if not isinstance(system_key, str):
        raise ValueError('INVALID SYSTEM NOTEBOOK')
    system_key = system_key.strip().lower()
    if not system_key:
        return None
    if system_key != NOTES_SHARED_INBOX_KEY:
        raise ValueError('INVALID SYSTEM NOTEBOOK')
    return system_key

def _notes_is_system_notebook(notebook):
    return bool(notebook and notebook.system_key == NOTES_SHARED_INBOX_KEY)

@app.route('/notes')
@login_required
def notes_page():
    """Serve the notes SPA page."""
    user = _current_session_user()
    return render_template('notes.html', user=user)

@app.route('/notes/api/notebooks', methods=['GET'])
@login_required
def notes_list_notebooks():
    """List all notebooks for the current user."""
    user_id = session['logged_in_user_id']
    notebooks = Notebook.query.filter_by(user_id=user_id, is_trashed=False).order_by(Notebook.position.asc(), Notebook.created_at.asc()).all()
    result = []
    for nb in notebooks:
        note_count = Note.query.filter_by(notebook_id=nb.id, is_trashed=False).count()
        result.append({
            'id': nb.id,
            'encrypted_name': nb.encrypted_name,
            'name_nonce': nb.name_nonce,
            'encrypted_name_key': nb.encrypted_name_key,
            'name_key_nonce': nb.name_key_nonce,
            'color': nb.color,
            'system_key': nb.system_key,
            'position': nb.position,
            'note_count': note_count,
            'created_at': nb.created_at.isoformat() if nb.created_at else None,
            'updated_at': nb.updated_at.isoformat() if nb.updated_at else None,
        })
    # Include aggregate counts for sidebar
    total_notes = Note.query.filter_by(user_id=user_id, is_trashed=False).count()
    trash_notes = Note.query.filter_by(user_id=user_id, is_trashed=True).count()
    trash_notebooks = Notebook.query.filter_by(user_id=user_id, is_trashed=True).count()
    # Storage figures so the notes rail can show the same footer meter as the files sidebar
    user = db.session.get(User, user_id)
    storage_used = user.get_storage_used() if user else None
    storage_limit_gb = round(user.storage_limit_gb, 2) if user else None
    return jsonify({
        'notebooks': result,
        'total_notes': total_notes,
        'trash_count': trash_notes + trash_notebooks,
        'storage_used_gb': round(storage_used / (1024 ** 3), 2) if user else None,
        'storage_used_bytes': storage_used,
        'storage_limit_gb': storage_limit_gb,
    })

@app.route('/notes/api/notebooks', methods=['POST'])
@login_required
def notes_create_notebook():
    """Create a new notebook."""
    user_id = session['logged_in_user_id']
    data = _json_object_body()
    if not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400
    try:
        _notes_validate_wrapped_field_pair(data, 'encrypted_name', 'name_nonce', 'ENCRYPTED NAME', required=True)
        _notes_validate_wrapped_field_pair(data, 'encrypted_name_key', 'name_key_nonce', 'ENCRYPTED KEY', required=True, value_max_bytes=NOTES_WRAPPED_KEY_MAX_BYTES)
        color = _notes_normalize_color(data.get('color'))
        system_key = _notes_normalize_system_key(data.get('system_key'))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    if system_key:
        existing = Notebook.query.filter_by(user_id=user_id, system_key=system_key).first()
        if existing:
            if existing.is_trashed:
                existing.is_trashed = False
                existing.trashed_at = None
                existing.updated_at = datetime.now(timezone.utc)
                db.session.commit()
                print(f'[NOTES] User {user_id} restored system notebook {existing.id} ({system_key})')
            return jsonify({'id': existing.id, 'position': existing.position, 'system_key': existing.system_key}), 200
    max_pos = db.session.query(db.func.max(Notebook.position)).filter_by(user_id=user_id, is_trashed=False).scalar() or 0
    nb = Notebook(
        user_id=user_id,
        encrypted_name=data['encrypted_name'],
        name_nonce=data['name_nonce'],
        encrypted_name_key=data['encrypted_name_key'],
        name_key_nonce=data['name_key_nonce'],
        color=color,
        system_key=system_key,
        position=max_pos + 1,
    )
    db.session.add(nb)
    from sqlalchemy.exc import IntegrityError as _IntegrityError
    try:
        db.session.commit()
    except _IntegrityError:
        # AUDIT FIX A19: the system_key existence check above is a check-then-insert
        # race (a notes-SPA bootstrap concurrent with a pending-note accept). The
        # unique index on (user_id, system_key) rejects the loser; return the row
        # the winner created so both callers agree on ONE delivery target.
        db.session.rollback()
        if system_key:
            winner = Notebook.query.filter_by(user_id=user_id, system_key=system_key).first()
            if winner:
                if winner.is_trashed:
                    winner.is_trashed = False
                    winner.trashed_at = None
                    winner.updated_at = datetime.now(timezone.utc)
                    db.session.commit()
                print(f'[NOTES] User {user_id} lost the system notebook create race for {system_key}; '
                      f'returning existing notebook {winner.id}')
                return jsonify({'id': winner.id, 'position': winner.position, 'system_key': winner.system_key}), 200
        print(f'[ERROR] [NOTES] Failed to create notebook for user {user_id} (integrity error)')
        return jsonify({'error': 'NOTEBOOK CREATE FAILED'}), 409
    print(f'[NOTES] User {user_id} created notebook {nb.id}')
    return jsonify({'id': nb.id, 'position': nb.position, 'system_key': nb.system_key}), 201

@app.route('/notes/api/notebooks/<int:notebook_id>', methods=['PUT'])
@login_required
def notes_update_notebook(notebook_id):
    """Update a notebook (rename, color, reorder)."""
    user_id = session['logged_in_user_id']
    nb = Notebook.query.filter_by(id=notebook_id, user_id=user_id).first()
    if not nb:
        return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404
    data = _json_object_body()
    if not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400
    if 'system_key' in data:
        return jsonify({'error': 'SYSTEM NOTEBOOK CANNOT BE MODIFIED'}), 403
    try:
        _notes_validate_wrapped_field_pair(data, 'encrypted_name', 'name_nonce', 'ENCRYPTED NAME')
        _notes_validate_wrapped_field_pair(data, 'encrypted_name_key', 'name_key_nonce', 'ENCRYPTED KEY', value_max_bytes=NOTES_WRAPPED_KEY_MAX_BYTES)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    if _notes_is_system_notebook(nb) and any(k in data for k in ('encrypted_name', 'name_nonce', 'encrypted_name_key', 'name_key_nonce')):
        return jsonify({'error': 'SYSTEM NOTEBOOK CANNOT BE RENAMED'}), 403
    if 'encrypted_name' in data:
        nb.encrypted_name = data['encrypted_name']
        nb.name_nonce = data['name_nonce']
    if 'encrypted_name_key' in data:
        nb.encrypted_name_key = data['encrypted_name_key']
        nb.name_key_nonce = data['name_key_nonce']
    if 'color' in data:
        try:
            nb.color = _notes_normalize_color(data.get('color'))
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
    if 'position' in data:
        try:
            nb.position = _notes_parse_position(data.get('position'), 'POSITION')
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
    nb.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    print(f'[NOTES] User {user_id} updated notebook {notebook_id}')
    return jsonify({'success': True})

@app.route('/notes/api/notebooks/<int:notebook_id>', methods=['DELETE'])
@login_required
def notes_delete_notebook(notebook_id):
    """Trash or permanently delete a notebook."""
    user_id = session['logged_in_user_id']
    permanent = request.args.get('permanent', 'false').lower() == 'true'
    note_local_targets = []
    lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
    try:
        db.session.rollback()
        nb = Notebook.query.filter_by(id=notebook_id, user_id=user_id).first()
        if not nb:
            return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404
        if _notes_is_system_notebook(nb):
            return jsonify({'error': 'SYSTEM NOTEBOOK CANNOT BE DELETED'}), 403
        if permanent:
            if not nb.is_trashed:
                return jsonify({'error': 'NOTEBOOK MUST BE IN TRASH BEFORE PERMANENT DELETION'}), 409
            # Live notes are detached to unfiled; only trashed notes are deleted.
            detached = Note.query.filter(
                Note.user_id == user_id,
                Note.notebook_id == notebook_id,
                Note.is_trashed == False,
            ).update({'notebook_id': None}, synchronize_session=False)
            if detached:
                print(f'[NOTES] Detached {detached} live note(s) from permanently deleted notebook {notebook_id} to unfiled')
            notebook_notes = Note.query.filter_by(
                notebook_id=notebook_id, user_id=user_id, is_trashed=True
            ).all()
            note_ids = [n.id for n in notebook_notes]
            note_local_targets = storage.stage_payload_deletes(
                [_note_payload_delete_key(nid) for nid in note_ids]
            )
            for n in notebook_notes:
                db.session.delete(n)
            db.session.flush()
            db.session.expire_all()
            db.session.delete(nb)
            db.session.commit()
            print(f'[NOTES] User {user_id} permanently deleted notebook {notebook_id} ({len(note_ids)} notes)')
        else:
            # Soft delete - trash the notebook and its notes
            now = datetime.now(timezone.utc)
            nb.is_trashed = True
            nb.trashed_at = now
            nb.updated_at = now
            Note.query.filter_by(notebook_id=notebook_id, user_id=user_id, is_trashed=False).update({
                'is_trashed': True,
                'trashed_at': now,
                'trashed_via_notebook': True,
            })
            db.session.commit()
            print(f'[NOTES] User {user_id} trashed notebook {notebook_id}')
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    if permanent:
        _purge_staged_locals_with_note_locks(note_local_targets)
    return jsonify({'success': True})

@app.route('/notes/api/notebooks/<int:notebook_id>/restore', methods=['POST'])
@login_required
def notes_restore_notebook(notebook_id):
    """Restore a trashed notebook and its notes."""
    user_id = session['logged_in_user_id']
    quota_lock = _acquire_user_quota_lock(user_id)
    lifecycle_lock = None
    try:
        _refresh_quota_snapshot()
        lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
        db.session.rollback()
        user = db.session.get(User, user_id)
        nb = Notebook.query.filter_by(id=notebook_id, user_id=user_id, is_trashed=True).first()
        if not nb:
            return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404
        required_bytes = db.session.query(db.func.coalesce(db.func.sum(Note.size), 0)).filter_by(
            notebook_id=notebook_id,
            user_id=user_id,
            is_trashed=True,
            trashed_via_notebook=True,
        ).scalar() or 0
        if required_bytes > 0 and not user.has_storage_available(int(required_bytes)):
            return jsonify({'error': 'STORAGE LIMIT EXCEEDED'}), 413
        nb.is_trashed = False
        nb.trashed_at = None
        nb.updated_at = datetime.now(timezone.utc)
        Note.query.filter_by(notebook_id=notebook_id, user_id=user_id, is_trashed=True, trashed_via_notebook=True).update({
            'is_trashed': False,
            'trashed_at': None,
            'trashed_via_notebook': False,
        })
        db.session.commit()
        print(f'[NOTES] User {user_id} restored notebook {notebook_id}')
        return jsonify({'success': True})
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)

@app.route('/notes/api/notes', methods=['GET'])
@login_required
def notes_list_notes():
    """List all notes for the current user (metadata only, no content)."""
    user_id = session['logged_in_user_id']
    notebook_id = request.args.get('notebook_id')
    show_trash = request.args.get('trash', 'false').lower() == 'true'
    show_received = request.args.get('received', 'false').lower() == 'true'
    query = Note.query.filter_by(user_id=user_id, is_trashed=show_trash)
    if show_received:
        query = query.filter(Note.received_from.isnot(None))
    elif notebook_id is not None:
        if notebook_id == 'unfiled':
            query = query.filter(Note.notebook_id.is_(None))
        else:
            try:
                query = query.filter_by(notebook_id=int(notebook_id))
            except (ValueError, TypeError):
                return jsonify({'error': 'INVALID NOTEBOOK ID'}), 400
    notes = query.order_by(Note.is_pinned.desc(), Note.updated_at.desc()).all()
    result = []
    for n in notes:
        result.append({
            'id': n.id,
            'notebook_id': n.notebook_id,
            'encrypted_title': n.encrypted_title,
            'title_nonce': n.title_nonce,
            'encrypted_note_key': n.encrypted_note_key,
            'note_key_nonce': n.note_key_nonce,
            'note_type': n.note_type or 'document',
            'is_pinned': n.is_pinned,
            'color': n.color,
            'size': n.size or 0,
            'content_version': int(n.content_version or 1),
            'position': n.position or 0,
            'encrypted_tags': n.encrypted_tags,
            'tags_nonce': n.tags_nonce,
            'received_from': n.received_from,
            'is_read': n.is_read if n.is_read is not None else True,
            'is_trashed': n.is_trashed,
            'created_at': n.created_at.isoformat() if n.created_at else None,
            'updated_at': n.updated_at.isoformat() if n.updated_at else None,
        })
    return jsonify({'notes': result})

@app.route('/notes/api/notes/<string:note_id>', methods=['GET'])
@login_required
def notes_get_note(note_id):
    """Get a single note with encrypted content (read from disk)."""
    user_id = session['logged_in_user_id']
    if not Note.query.filter_by(id=note_id, user_id=user_id).first():
        return jsonify({'error': 'NOTE NOT FOUND'}), 404
    # A concurrent PUT commits new metadata and then swaps the payload while it
    # holds this lock; reading under it keeps metadata, key and ciphertext from
    # one generation (and never catches the committed-but-unfinalized window).
    rewrite_lock = _acquire_note_rewrite_lock(note_id)
    try:
        return _notes_get_note_locked(note_id, user_id)
    finally:
        _release_note_rewrite_lock(rewrite_lock)


def _notes_get_note_locked(note_id, user_id):
    db.session.rollback()  # fresh snapshot taken after the writer finished
    n = Note.query.filter_by(id=note_id, user_id=user_id).first()
    if not n:
        return jsonify({'error': 'NOTE NOT FOUND'}), 404
    # Read encrypted content from storage
    encrypted_content = None
    try:
        encrypted_content = storage.read_note(n.id)
    except Exception as e:
        print(f'[NOTES] Error reading note file {n.id}: {e}')
    if encrypted_content is None:
        print(f'[NOTES] Missing note content for note {n.id}')
        return jsonify({'error': 'FAILED TO READ NOTE CONTENT'}), 500
    # Auto-mark received notes as read when opened
    if n.received_from and not n.is_read:
        n.is_read = True
        db.session.commit()
    return jsonify({
        'id': n.id,
        'notebook_id': n.notebook_id,
        'encrypted_title': n.encrypted_title,
        'title_nonce': n.title_nonce,
        'encrypted_content': encrypted_content,
        'content_nonce': n.content_nonce,
        'encrypted_note_key': n.encrypted_note_key,
        'note_key_nonce': n.note_key_nonce,
        'note_type': n.note_type or 'document',
        'is_pinned': n.is_pinned,
        'color': n.color,
        'size': n.size or 0,
        'content_version': int(n.content_version or 1),
        'position': n.position or 0,
        'encrypted_tags': n.encrypted_tags,
        'tags_nonce': n.tags_nonce,
        'received_from': n.received_from,
        'is_read': n.is_read if n.is_read is not None else True,
        'is_trashed': n.is_trashed,
        'created_at': n.created_at.isoformat() if n.created_at else None,
        'updated_at': n.updated_at.isoformat() if n.updated_at else None,
    })

@app.route('/notes/api/notes', methods=['POST'])
@login_required
def notes_create_note():
    """Create a new note."""
    user_id = session['logged_in_user_id']
    data, limit_error = _load_notes_json_request(NOTES_NOTE_CONTENT_MAX_BYTES, 'NOTE CONTENT TOO LARGE')
    if limit_error is not None:
        return limit_error
    data = data if isinstance(data, dict) else {}  # a JSON array/scalar has no .get()
    if not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400
    try:
        _notes_validate_wrapped_field_pair(data, 'encrypted_note_key', 'note_key_nonce', 'ENCRYPTED KEY', required=True, value_max_bytes=NOTES_WRAPPED_KEY_MAX_BYTES)
        _notes_validate_wrapped_field_pair(data, 'encrypted_title', 'title_nonce', 'ENCRYPTED TITLE')
        _notes_validate_wrapped_field_pair(data, 'encrypted_tags', 'tags_nonce', 'ENCRYPTED TAGS', value_max_bytes=NOTES_ENCRYPTED_TAGS_MAX_BYTES)
        _notes_validate_content_field(data)
        color = _notes_normalize_color(data.get('color'))
        position = _notes_parse_position(data.get('position', 0), 'POSITION') if 'position' in data else 0
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    # Validate notebook ownership if specified
    notebook_id = data.get('notebook_id')
    if notebook_id is not None:
        nb = Notebook.query.filter_by(id=notebook_id, user_id=user_id, is_trashed=False).first()
        if not nb:
            return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404
    note_type = data.get('note_type', 'document')
    if note_type not in ('document', 'canvas'):
        note_type = 'document'
    encrypted_content = data.get('encrypted_content', '')
    content_size = len(encrypted_content.encode('utf-8')) if encrypted_content else 0
    content_checksum = _note_content_checksum(encrypted_content or '')
    quota_lock = _acquire_user_quota_lock(user_id)
    lifecycle_lock = None
    n = None
    created_id = None
    committed = False
    try:
        _refresh_quota_snapshot()
        user = db.session.get(User, user_id)
        if user and content_size > 0 and not user.has_storage_available(content_size):
            return jsonify({'error': 'STORAGE LIMIT EXCEEDED'}), 413
        n = Note(
            id=str(uuid.uuid4()),
            user_id=user_id,
            notebook_id=notebook_id,
            encrypted_title=data.get('encrypted_title'),
            title_nonce=data.get('title_nonce'),
            content_nonce=data.get('content_nonce'),
            encrypted_note_key=data['encrypted_note_key'],
            note_key_nonce=data['note_key_nonce'],
            note_type=note_type,
            is_pinned=data.get('is_pinned', False),
            color=color,
            size=content_size,
            content_version=1,
            content_checksum=content_checksum,
            encrypted_tags=data.get('encrypted_tags'),
            tags_nonce=data.get('tags_nonce'),
            position=position,
        )
        # Write content first, then commit its metadata while the quota lock is held.
        db.session.add(n)
        # AUDIT FIX H4: drop any stale tombstone for this key before the note can
        # replicate (belt and braces; Phase B also checks).
        try:
            _clear_pending_remote_deletes_for('notes', [n.id])
        except Exception:
            return jsonify({'error': 'FAILED TO CREATE NOTE'}), 500
        storage.write_note(n.id, encrypted_content or '')
        created_id = n.id
        repaired = storage.reconcile_note_to_local(n.id, verified_at=datetime.now(timezone.utc))
        if not repaired:
            db.session.rollback()
            storage.delete_note(n.id)
            created_id = None
            return jsonify({'error': 'FAILED TO TRACK NOTE REPLICATION'}), 500
        lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
        if not _lock_live_notebook_for_placement(notebook_id, user_id):
            db.session.rollback()
            _release_lifecycle_lock(lifecycle_lock)
            lifecycle_lock = None
            storage.delete_note(n.id)
            created_id = None
            return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404
        try:
            db.session.commit()
            committed = True
        except Exception:
            db.session.rollback()
            storage.delete_note(n.id)
            created_id = None
            raise
        print(f'[NOTES] User {user_id} created note {n.id} (type={note_type}, size={content_size})')
        return jsonify({'id': n.id, 'note_type': note_type, 'created_at': n.created_at.isoformat(), 'updated_at': n.updated_at.isoformat(), 'size': n.size or 0, 'content_version': int(n.content_version or 1)}), 201
    except Exception:
        if created_id and not committed:
            try:
                db.session.rollback()
            except Exception:
                pass
            try:
                storage.delete_note(created_id)
            except Exception:
                pass
        raise
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)

@app.route('/notes/api/notes/<string:note_id>', methods=['PUT'])
@login_required
def notes_update_note(note_id):
    """Update a note (title, content, move, pin, color)."""
    user_id = session['logged_in_user_id']
    n = Note.query.filter_by(id=note_id, user_id=user_id).first()
    if not n:
        return jsonify({'error': 'NOTE NOT FOUND'}), 404
    if n.is_trashed:
        return jsonify({'error': 'TRASHED NOTES ARE READ ONLY'}), 409
    data, limit_error = _load_notes_json_request(NOTES_NOTE_CONTENT_MAX_BYTES, 'NOTE CONTENT TOO LARGE')
    if limit_error is not None:
        return limit_error
    data = data if isinstance(data, dict) else {}  # a JSON array/scalar has no .get()
    if not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400
    try:
        _notes_validate_wrapped_field_pair(data, 'encrypted_title', 'title_nonce', 'ENCRYPTED TITLE')
        _notes_validate_wrapped_field_pair(data, 'encrypted_note_key', 'note_key_nonce', 'ENCRYPTED KEY', value_max_bytes=NOTES_WRAPPED_KEY_MAX_BYTES)
        _notes_validate_wrapped_field_pair(data, 'encrypted_tags', 'tags_nonce', 'ENCRYPTED TAGS', value_max_bytes=NOTES_ENCRYPTED_TAGS_MAX_BYTES)
        _notes_validate_content_field(data)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    if 'position' in data:
        try:
            parsed_position = _notes_parse_position(data.get('position'), 'POSITION')
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
    else:
        parsed_position = None
    if 'color' in data:
        try:
            normalized_color = _notes_normalize_color(data.get('color'))
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
    else:
        normalized_color = None
    notebook_id = data.get('notebook_id') if 'notebook_id' in data else None
    if 'notebook_id' in data and notebook_id is not None:
        nb = Notebook.query.filter_by(id=notebook_id, user_id=user_id, is_trashed=False).first()
        if not nb:
            return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404

    content_update = 'encrypted_content' in data
    content_size = n.size or 0
    content_staged = False
    staging_id = None

    if content_update:
        try:
            expected_version = int(data.get('expected_content_version'))
        except (TypeError, ValueError):
            return jsonify({'error': 'NOTE VERSION REQUIRED'}), 409
        current_version = int(n.content_version or 1)
        if expected_version != current_version:
            return jsonify({'error': 'NOTE CHANGED ELSEWHERE', 'content_version': current_version}), 409
        encrypted_content = data['encrypted_content'] or ''
        content_size = len(encrypted_content.encode('utf-8')) if encrypted_content else 0
        content_checksum = _note_content_checksum(encrypted_content)
        # Stage content to a per-request path so concurrent saves cannot share
        # the same .new file.
        staging_id = uuid.uuid4().hex
        try:
            storage.write_note_staged(n.id, encrypted_content, staging_id=staging_id)
            content_staged = True
        except Exception as e:
            print(f'[NOTES] Error writing note file {n.id}: {e}')
            return jsonify({'error': 'FAILED TO SAVE NOTE CONTENT'}), 500

        # Publication lock precedes quota everywhere: note rewrite -> quota.
        # Staging is request-unique and may happen unlocked, but the DB generation
        # change and final rename must be indivisible from local purge's view.
        note_lock = _acquire_note_rewrite_lock(note_id)
        quota_lock = None
        lifecycle_lock = None
        db_committed = False
        try:
            quota_lock = _acquire_user_quota_lock(user_id)
            _refresh_quota_snapshot()
            lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
            db.session.rollback()
            n = Note.query.filter_by(id=note_id, user_id=user_id, is_trashed=False).first()
            if not n:
                storage.rollback_staged_note(note_id, staging_id=staging_id)
                return jsonify({'error': 'NOTE NOT FOUND'}), 404
            current_version = int(n.content_version or 1)
            if expected_version != current_version:
                storage.rollback_staged_note(n.id, staging_id=staging_id)
                return jsonify({'error': 'NOTE CHANGED ELSEWHERE', 'content_version': current_version}), 409
            if not _lock_live_notebook_for_placement(notebook_id, user_id):
                storage.rollback_staged_note(n.id, staging_id=staging_id)
                return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404
            user = db.session.get(User, user_id)
            old_size = int(n.size or 0)
            net_increase = max(content_size - old_size, 0)
            if user and net_increase > 0 and not user.has_storage_available(net_increase):
                storage.rollback_staged_note(n.id, staging_id=staging_id)
                return jsonify({'error': 'STORAGE LIMIT EXCEEDED'}), 413

            new_version = expected_version + 1
            now = datetime.now(timezone.utc)
            update_values = {
                Note.size: content_size,
                Note.content_version: new_version,
                Note.content_checksum: content_checksum,
                Note.content_nonce: data.get('content_nonce'),
                Note.updated_at: now,
            }
            if 'encrypted_title' in data:
                update_values[Note.encrypted_title] = data['encrypted_title']
                update_values[Note.title_nonce] = data.get('title_nonce')
            if 'encrypted_note_key' in data:
                update_values[Note.encrypted_note_key] = data['encrypted_note_key']
                update_values[Note.note_key_nonce] = data.get('note_key_nonce')
            if 'notebook_id' in data:
                update_values[Note.notebook_id] = notebook_id
            if 'is_pinned' in data:
                update_values[Note.is_pinned] = bool(data['is_pinned'])
            if 'color' in data:
                update_values[Note.color] = normalized_color
            if 'encrypted_tags' in data:
                update_values[Note.encrypted_tags] = data['encrypted_tags']
                update_values[Note.tags_nonce] = data.get('tags_nonce')
            if parsed_position is not None:
                update_values[Note.position] = parsed_position

            storage.write_staged_note_metadata(n.id, {
                'note_id': n.id,
                'size': content_size,
                'content_version': new_version,
                'content_checksum': content_checksum,
            }, staging_id=staging_id)
            updated = Note.query.filter(
                Note.id == note_id,
                Note.user_id == user_id,
                Note.content_version == expected_version,
            ).update(update_values, synchronize_session=False)
            if updated != 1:
                db.session.rollback()
                storage.rollback_staged_note(n.id, staging_id=staging_id)
                latest = db.session.get(Note, note_id)
                latest_version = int(latest.content_version or 1) if latest else current_version
                return jsonify({'error': 'NOTE CHANGED ELSEWHERE', 'content_version': latest_version}), 409
            db.session.commit()
            db_committed = True
        except Exception:
            db.session.rollback()
            storage.rollback_staged_note(note_id, staging_id=staging_id)
            raise
        finally:
            if not db_committed:
                _release_lifecycle_lock(lifecycle_lock)
                _release_user_quota_lock(quota_lock)
                _release_note_rewrite_lock(note_lock)

        # DB commit succeeded — write marker so crash recovery knows this was committed,
        # then finalize the staged content file associated with this request.
        try:
            storage.mark_staged_note_committed(n.id, staging_id=staging_id)
            storage.finalize_staged_note(n.id, staging_id=staging_id)
            try:
                repaired = storage.reconcile_note_to_local(n.id, verified_at=datetime.now(timezone.utc))
                if repaired:
                    db.session.commit()
            except Exception as e:
                try:
                    db.session.rollback()
                except Exception:
                    pass
                print(f'[NOTES] Warning: note {n.id} saved locally but replication re-queue failed: {e}')
        finally:
            _release_lifecycle_lock(lifecycle_lock)
            _release_user_quota_lock(quota_lock)
            _release_note_rewrite_lock(note_lock)
        return jsonify({'success': True, 'updated_at': now.isoformat(), 'size': content_size, 'content_version': new_version})

    # AUDIT FIX M4: optimistic-concurrency control for metadata-only PUTs.
    # Previously the metadata branch (title/key/notebook/pin/color/tags) did a
    # plain read-modify-write with no version check, which silently last-writer-
    # wins on concurrent edits. Worst case: encrypted_note_key/note_key_nonce
    # could be overwritten by a stale client, desyncing the wrapped key from
    # the current content and bricking the note for its owner.
    #
    # We now reject any write that touches encrypted_note_key/note_key_nonce
    # without an expected_content_version that matches the DB. The other
    # metadata fields use a conditional UPDATE so a concurrent commit cannot
    # be clobbered without being noticed.
    is_key_change = 'encrypted_note_key' in data
    current_version = int(n.content_version or 1)
    expected_metadata_version = data.get('expected_content_version')
    try:
        expected_v = int(expected_metadata_version)
    except (TypeError, ValueError):
        return jsonify({'error': 'NOTE VERSION REQUIRED',
                        'content_version': current_version}), 409
    if expected_v != current_version:
        return jsonify({'error': 'NOTE CHANGED ELSEWHERE',
                        'content_version': current_version}), 409

    metadata_updates = {}
    if 'encrypted_title' in data:
        metadata_updates[Note.encrypted_title] = data['encrypted_title']
        metadata_updates[Note.title_nonce] = data.get('title_nonce')
    if is_key_change:
        metadata_updates[Note.encrypted_note_key] = data['encrypted_note_key']
        metadata_updates[Note.note_key_nonce] = data.get('note_key_nonce')
    if 'notebook_id' in data:
        metadata_updates[Note.notebook_id] = notebook_id
    if 'is_pinned' in data:
        metadata_updates[Note.is_pinned] = bool(data['is_pinned'])
    if 'color' in data:
        metadata_updates[Note.color] = normalized_color
    if 'encrypted_tags' in data:
        metadata_updates[Note.encrypted_tags] = data['encrypted_tags']
        metadata_updates[Note.tags_nonce] = data.get('tags_nonce')
    if parsed_position is not None:
        metadata_updates[Note.position] = parsed_position
    now_ts = datetime.now(timezone.utc)
    metadata_updates[Note.updated_at] = now_ts
    new_metadata_version = current_version + 1
    metadata_updates[Note.content_version] = new_metadata_version

    lifecycle_lock = None
    try:
        if 'notebook_id' in data:
            lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
            db.session.rollback()
            fresh_note = Note.query.filter_by(id=note_id, user_id=user_id, is_trashed=False).first()
            if not fresh_note:
                return jsonify({'error': 'NOTE NOT FOUND'}), 404
            if int(fresh_note.content_version or 1) != expected_v:
                return jsonify({'error': 'NOTE CHANGED ELSEWHERE',
                                'content_version': int(fresh_note.content_version or 1)}), 409
            if not _lock_live_notebook_for_placement(notebook_id, user_id):
                return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404

        # Conditional update: only succeed if content_version is still what we read.
        rows = Note.query.filter(
            Note.id == note_id,
            Note.user_id == user_id,
            Note.content_version == expected_v,
        ).update(metadata_updates, synchronize_session=False)
        if rows == 0:
            db.session.rollback()
            latest = db.session.get(Note, note_id)
            latest_version = int(latest.content_version or 1) if latest else current_version
            return jsonify({'error': 'NOTE CHANGED ELSEWHERE', 'content_version': latest_version}), 409

        # Metadata-only changes leave replica bytes unchanged. Advance every target,
        # but only carry synced_version forward for replicas already confirmed synced.
        NoteReplica.query.filter(
            NoteReplica.note_id == note_id,
        ).update({NoteReplica.target_version: new_metadata_version}, synchronize_session=False)
        NoteReplica.query.filter(
            NoteReplica.note_id == note_id,
            NoteReplica.status == 'synced',
            NoteReplica.synced_version == expected_v,
        ).update({NoteReplica.synced_version: new_metadata_version}, synchronize_session=False)
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    return jsonify({'success': True, 'updated_at': now_ts.isoformat(), 'size': content_size, 'content_version': new_metadata_version})

_NOTES_REORDER_MAX_ITEMS = 5000


@app.route('/notes/api/notes/reorder', methods=['PATCH'])
@login_required
def notes_reorder():
    """Batch update note positions for manual sort order."""
    user_id = session['logged_in_user_id']
    data = _json_object_body()
    if not data or 'order' not in data:
        return jsonify({'error': 'INVALID REQUEST'}), 400
    order = data['order']  # [{id, position}, ...]
    if not isinstance(order, list):
        return jsonify({'error': 'INVALID ORDER'}), 400
    # AUDIT FIX M5: cap list length so a malicious 100k-element request cannot
    # trigger 100k DB round-trips inside a single request transaction.
    if len(order) > _NOTES_REORDER_MAX_ITEMS:
        return jsonify({'error': f'TOO MANY ITEMS (MAX {_NOTES_REORDER_MAX_ITEMS})'}), 413
    # Parse + dedupe id -> position in one pass. Then do a single bulk lookup
    # of the user's notes and apply positions via a single UPDATE-per-row over
    # an in-memory result set (avoids per-item Note.query).
    desired = {}
    for item in order:
        if not isinstance(item, dict):
            continue
        note_id = item.get('id')
        if not note_id or not isinstance(note_id, str):  # a list id is unhashable below
            continue
        try:
            position = _notes_parse_position(item.get('position', 0), 'POSITION')
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        desired[note_id] = position
    if not desired:
        return jsonify({'success': True})
    target_notes = Note.query.filter(
        Note.user_id == user_id,
        Note.is_trashed == False,
        Note.id.in_(list(desired.keys())),
    ).all()
    for n in target_notes:
        n.position = desired[n.id]
    db.session.commit()
    return jsonify({'success': True})

@app.route('/notes/api/notes/<string:note_id>', methods=['DELETE'])
@login_required
def notes_delete_note(note_id):
    """Trash or permanently delete a note."""
    user_id = session['logged_in_user_id']
    permanent = request.args.get('permanent', 'false').lower() == 'true'
    note_local_targets = []
    lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
    try:
        db.session.rollback()
        n = Note.query.filter_by(id=note_id, user_id=user_id).first()
        if not n:
            return jsonify({'error': 'NOTE NOT FOUND'}), 404
        if permanent:
            if not n.is_trashed:
                return jsonify({'error': 'NOTE MUST BE IN TRASH BEFORE PERMANENT DELETION'}), 409
            note_local_targets = storage.stage_payload_deletes([_note_payload_delete_key(note_id)])
            db.session.delete(n)
            db.session.commit()
            print(f'[NOTES] User {user_id} permanently deleted note {note_id}')
        else:
            n.is_trashed = True
            n.trashed_via_notebook = False
            n.trashed_at = datetime.now(timezone.utc)
            db.session.commit()
            print(f'[NOTES] User {user_id} trashed note {note_id}')
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    if permanent:
        _purge_staged_locals_with_note_locks(note_local_targets)
    return jsonify({'success': True})

@app.route('/notes/api/notes/<string:note_id>/restore', methods=['POST'])
@login_required
def notes_restore_note(note_id):
    """Restore a trashed note."""
    user_id = session['logged_in_user_id']
    quota_lock = _acquire_user_quota_lock(user_id)
    lifecycle_lock = None
    try:
        _refresh_quota_snapshot()
        lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
        db.session.rollback()
        user = db.session.get(User, user_id)
        n = Note.query.filter_by(id=note_id, user_id=user_id, is_trashed=True).first()
        if not n:
            return jsonify({'error': 'NOTE NOT FOUND'}), 404
        if not user.has_storage_available(int(n.size or 0)):
            return jsonify({'error': 'STORAGE LIMIT EXCEEDED'}), 413
        # If the note's notebook was also trashed, move it to unfiled
        if n.notebook_id:
            nb = Notebook.query.filter_by(id=n.notebook_id, user_id=user_id).first()
            if nb and nb.is_trashed:
                n.notebook_id = None
        n.is_trashed = False
        n.trashed_via_notebook = False
        n.trashed_at = None
        db.session.commit()
        print(f'[NOTES] User {user_id} restored note {note_id}')
        return jsonify({'success': True})
    finally:
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)

@app.route('/notes/api/trash', methods=['DELETE'])
@login_required
def notes_empty_trash():
    """Permanently delete all trashed notes and notebooks."""
    user_id = session['logged_in_user_id']
    lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
    try:
        db.session.rollback()
        note_ids = set()
        trashed_notes = Note.query.filter_by(user_id=user_id, is_trashed=True).all()
        for n in trashed_notes:
            note_ids.add(n.id)
            db.session.delete(n)
        trashed_notebooks = Notebook.query.filter_by(user_id=user_id, is_trashed=True).all()
    # AUDIT FIX D6: a trashed notebook can still hold LIVE notes -- they were
    # never listed in the trash view, so destroying them here was silent data
    # loss. Detach them to "unfiled" first. The loop above already deleted every
    # genuinely trashed note, so after the flush below the notebook's
    # cascade='all, delete-orphan' relationship has nothing left to take with it.
        detached_total = 0
        for nb in trashed_notebooks:
            detached_total += Note.query.filter(
                Note.user_id == user_id,
                Note.notebook_id == nb.id,
                Note.is_trashed == False,
            ).update({'notebook_id': None}, synchronize_session=False) or 0
    # Flush the deletes + detaches, then drop cached relationship state so the
    # cascade reloads Notebook.notes from the DB instead of a stale collection.
        db.session.flush()
        db.session.expire_all()
        for nb in trashed_notebooks:
            db.session.delete(nb)
        if detached_total:
            print(f'[NOTES] User {user_id} emptied trash: detached {detached_total} live note(s) from trashed notebooks to unfiled')
        note_count = len(note_ids)
        nb_count = len(trashed_notebooks)
    # AUDIT FIX (atomic permanent delete): tombstones + replica deletes ride the
    # same commit as the metadata deletions; local note files purged afterwards.
        note_local_targets = storage.stage_payload_deletes(
            [_note_payload_delete_key(nid) for nid in note_ids]
        )
        db.session.commit()
    finally:
        _release_lifecycle_lock(lifecycle_lock)
    _purge_staged_locals_with_note_locks(note_local_targets)
    print(f'[NOTES] User {user_id} emptied trash: {note_count} notes, {nb_count} notebooks')
    return jsonify({'success': True, 'deleted_notes': note_count, 'deleted_notebooks': nb_count})

@app.route('/notes/api/trash', methods=['GET'])
@login_required
def notes_list_trash():
    """List all trashed notes and notebooks."""
    user_id = session['logged_in_user_id']
    trashed_notes = Note.query.filter_by(user_id=user_id, is_trashed=True).order_by(Note.trashed_at.desc()).all()
    trashed_notebooks = Notebook.query.filter_by(user_id=user_id, is_trashed=True).order_by(Notebook.trashed_at.desc()).all()
    notes_result = [{
        'id': n.id,
        'type': 'note',
        'notebook_id': n.notebook_id,
        'encrypted_title': n.encrypted_title,
        'title_nonce': n.title_nonce,
        'encrypted_note_key': n.encrypted_note_key,
        'note_key_nonce': n.note_key_nonce,
        'note_type': n.note_type or 'document',
        'is_pinned': n.is_pinned,
        'color': n.color,
        'size': n.size or 0,
        'content_version': int(n.content_version or 1),
        'position': n.position or 0,
        'trashed_at': n.trashed_at.isoformat() if n.trashed_at else None,
        'created_at': n.created_at.isoformat() if n.created_at else None,
    } for n in trashed_notes]
    notebooks_result = [{
        'id': nb.id,
        'type': 'notebook',
        'encrypted_name': nb.encrypted_name,
        'name_nonce': nb.name_nonce,
        'encrypted_name_key': nb.encrypted_name_key,
        'name_key_nonce': nb.name_key_nonce,
        'color': nb.color,
        'system_key': nb.system_key,
        'trashed_at': nb.trashed_at.isoformat() if nb.trashed_at else None,
    } for nb in trashed_notebooks]
    return jsonify({'items': notes_result + notebooks_result})

# ──────────────────────────────────────────────────────────────
# Notes Sharing, Export/Import Routes
# ──────────────────────────────────────────────────────────────

@app.route('/notes/api/users/search', methods=['GET'])
@login_required
def notes_search_users():
    """Search for users with E2EE keys (for sending notes)."""
    q = request.args.get('q', '').strip()
    if not q or len(q) < 2:
        return jsonify({'users': []})
    user_id = session['logged_in_user_id']
    results = User.query.filter(
        User.username.ilike(f'%{escape_like_pattern(q[:128])}%', escape='\\'),
        User.has_e2ee_keys == True,
        User.id != user_id
    ).limit(10).all()
    return jsonify({'users': [{'username': u.username} for u in results]})

@app.route('/notes/api/notes/send', methods=['POST'])
@login_required
def notes_send_to_user():
    """Send an E2EE note copy to another user. Creates a PendingNote for acceptance."""
    sender_id = session['logged_in_user_id']
    sender = db.session.get(User, sender_id)
    if not sender:
        return jsonify({'error': 'UNAUTHORIZED'}), 401
    data, limit_error = _load_notes_json_request(NOTES_PENDING_MAX_CONTENT_SIZE, 'NOTE TOO LARGE TO SEND')
    if limit_error is not None:
        return limit_error
    data = data if isinstance(data, dict) else {}  # a JSON array/scalar has no .get()
    if not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400
    recipient_username = data.get('recipient_username', '').strip()
    if not recipient_username:
        return jsonify({'error': 'RECIPIENT USERNAME REQUIRED'}), 400
    recipient = User.query.filter_by(username=recipient_username).first()
    # Conflate "user not found" and "user has no E2EE keys" into a single response
    # to avoid leaking which of the two is the case (user enumeration).
    if not recipient or not recipient.has_e2ee_keys or not recipient.public_key:
        return jsonify({'error': 'RECIPIENT CANNOT RECEIVE NOTES'}), 404
    if recipient.id == sender_id:
        return jsonify({'error': 'CANNOT SEND TO YOURSELF'}), 400
    rsa_encrypted_note_key = data.get('rsa_encrypted_note_key')
    if not rsa_encrypted_note_key:
        return jsonify({'error': 'ENCRYPTED NOTE KEY REQUIRED'}), 400
    source_note_id = data.get('source_note_id')
    if not source_note_id:
        return jsonify({'error': 'SOURCE NOTE REQUIRED'}), 400
    source_note = Note.query.filter_by(id=source_note_id, user_id=sender_id, is_trashed=False).first()
    if not source_note:
        return jsonify({'error': 'SOURCE NOTE NOT FOUND'}), 404
    note_type = data.get('note_type', 'document')
    if note_type not in ('document', 'canvas'):
        note_type = 'document'
    if (source_note.note_type or 'document') != note_type:
        return jsonify({'error': 'SOURCE NOTE TYPE MISMATCH'}), 400
    try:
        _notes_validate_wrapped_field_pair(data, 'encrypted_title', 'title_nonce', 'ENCRYPTED TITLE')
        _notes_validate_wrapped_field_pair(data, 'encrypted_tags', 'tags_nonce', 'ENCRYPTED TAGS', value_max_bytes=NOTES_ENCRYPTED_TAGS_MAX_BYTES)
        _notes_validate_text_field(data, 'rsa_encrypted_note_key', 'ENCRYPTED NOTE KEY', NOTES_WRAPPED_KEY_MAX_BYTES, required=True)
        _notes_validate_content_field(data, max_bytes=NOTES_PENDING_MAX_CONTENT_SIZE)
        color = _notes_normalize_color(data.get('color'))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    encrypted_content = data.get('encrypted_content', '')
    content_size = len(encrypted_content.encode('utf-8')) if encrypted_content else 0
    if content_size > NOTES_PENDING_MAX_CONTENT_SIZE:
        return jsonify({'error': 'NOTE TOO LARGE TO SEND'}), 413
    recipient_id = recipient.id
    pending_locks = _acquire_pending_note_user_locks([sender_id, recipient_id])
    try:
        # End the snapshot opened by the reads above: under REPEATABLE READ the
        # counts below would otherwise miss rows committed while we waited.
        db.session.rollback()
        if PendingNote.query.filter_by(recipient_id=recipient.id).count() >= NOTES_PENDING_LIMIT:
            return jsonify({'error': 'RECIPIENT HAS TOO MANY PENDING NOTES'}), 429
        sender_pending_bytes = _notes_pending_total_bytes('sender_id', sender_id)
        recipient_pending_bytes = _notes_pending_total_bytes('recipient_id', recipient.id)
        if sender_pending_bytes + content_size > NOTES_PENDING_AGGREGATE_MAX_BYTES:
            return jsonify({'error': 'TOO MANY PENDING NOTE BYTES'}), 429
        if recipient_pending_bytes + content_size > NOTES_PENDING_AGGREGATE_MAX_BYTES:
            return jsonify({'error': 'RECIPIENT HAS TOO MANY PENDING NOTE BYTES'}), 429
        pending = PendingNote(
            recipient_id=recipient.id,
            sender_id=sender_id,
            sender_username=sender.username,
            note_type=note_type,
            encrypted_title=data.get('encrypted_title'),
            title_nonce=data.get('title_nonce'),
            encrypted_content=encrypted_content,
            content_nonce=data.get('content_nonce'),
            rsa_encrypted_note_key=rsa_encrypted_note_key,
            color=color,
            is_pinned=bool(data.get('is_pinned')),
            encrypted_tags=data.get('encrypted_tags'),
            tags_nonce=data.get('tags_nonce'),
            content_size=content_size,
        )
        db.session.add(pending)
        db.session.commit()
    finally:
        _release_pending_note_user_locks(pending_locks)
    print(f'[NOTES] User {sender.username} sent note to {recipient_username} (pending_id={pending.id}, type={note_type}, size={content_size})')
    return jsonify({'success': True, 'pending_id': pending.id}), 201

@app.route('/notes/api/pending', methods=['GET'])
@login_required
def notes_list_pending():
    """List all pending notes for the current user."""
    user_id = session['logged_in_user_id']
    pending = PendingNote.query.filter_by(recipient_id=user_id).order_by(PendingNote.created_at.desc()).all()
    result = [{
        'id': p.id,
        'sender_username': p.sender_username,
        'note_type': p.note_type or 'document',
        'encrypted_title': p.encrypted_title,
        'title_nonce': p.title_nonce,
        'rsa_encrypted_note_key': p.rsa_encrypted_note_key,
        'color': p.color,
        'is_pinned': p.is_pinned,
        'content_size': p.content_size or 0,
        'created_at': p.created_at.isoformat() if p.created_at else None,
    } for p in pending]
    return jsonify({'pending': result})

@app.route('/notes/api/pending/<int:pending_id>/accept', methods=['POST'])
@login_required
def notes_accept_pending(pending_id):
    """Accept a pending note: creates a real Note in the recipient's account."""
    user_id = session['logged_in_user_id']
    data, limit_error = _load_notes_json_request(0, 'INVALID REQUEST')
    if limit_error is not None:
        return limit_error
    pending_lock = _acquire_pending_note_decision_lock(pending_id)
    quota_lock = _acquire_user_quota_lock(user_id)
    lifecycle_lock = None
    note_id = None
    payload_needs_cleanup = False
    try:
        _refresh_quota_snapshot()
        pending = _lock_current_pending_note_for_decision(pending_id, user_id)
        if not pending:
            return jsonify({'error': 'PENDING NOTE NOT FOUND'}), 404
        data = data if isinstance(data, dict) else {}  # a JSON array/scalar has no .get()
        # Client sends the re-wrapped note key (wrapped with recipient's master key)
        encrypted_note_key = data.get('encrypted_note_key')
        note_key_nonce = data.get('note_key_nonce')
        if not encrypted_note_key or not note_key_nonce:
            return jsonify({'error': 'RE-WRAPPED NOTE KEY REQUIRED'}), 400
        try:
            _notes_validate_wrapped_field_pair(data, 'encrypted_note_key', 'note_key_nonce', 'ENCRYPTED KEY', required=True, value_max_bytes=NOTES_WRAPPED_KEY_MAX_BYTES)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        # Check storage quota
        user = db.session.get(User, user_id)
        content_size = pending.content_size or 0
        if user and content_size > 0 and not user.has_storage_available(content_size):
            return jsonify({'error': 'STORAGE LIMIT EXCEEDED'}), 413
        # Place into specified notebook (e.g. SHARED) or unfiled
        notebook_id = data.get('notebook_id')
        if notebook_id is not None:
            nb = Notebook.query.filter_by(id=notebook_id, user_id=user_id, is_trashed=False).first()
            if not nb:
                return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404
        # Create the actual note
        content_checksum = _note_content_checksum(pending.encrypted_content or '')
        n = Note(
            id=str(uuid.uuid4()),
            user_id=user_id,
            notebook_id=notebook_id,
            encrypted_title=pending.encrypted_title,
            title_nonce=pending.title_nonce,
            content_nonce=pending.content_nonce,
            encrypted_note_key=encrypted_note_key,
            note_key_nonce=note_key_nonce,
            note_type=pending.note_type or 'document',
            color=pending.color,
            is_pinned=bool(pending.is_pinned),
            encrypted_tags=pending.encrypted_tags,
            tags_nonce=pending.tags_nonce,
            size=content_size,
            content_version=1,
            content_checksum=content_checksum,
            received_from=pending.sender_username,
            is_read=False,
        )
        note_id = n.id
        db.session.add(n)
        # AUDIT FIX H4: drop any stale tombstone for this key before the note can
        # replicate (belt and braces; Phase B also checks).
        try:
            _clear_pending_remote_deletes_for('notes', [n.id])
        except Exception:
            return jsonify({'error': 'FAILED TO ACCEPT NOTE'}), 500
        payload_needs_cleanup = True
        storage.write_note(n.id, pending.encrypted_content or '')
        repaired = storage.reconcile_note_to_local(n.id, verified_at=datetime.now(timezone.utc))
        if not repaired:
            db.session.rollback()
            return jsonify({'error': 'FAILED TO TRACK NOTE REPLICATION'}), 500
        lifecycle_lock = _acquire_user_lifecycle_lock(user_id)
        if not _lock_live_notebook_for_placement(notebook_id, user_id):
            db.session.rollback()
            return jsonify({'error': 'NOTEBOOK NOT FOUND'}), 404
        db.session.delete(pending)
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        payload_needs_cleanup = False
        print(f'[NOTES] User {user_id} accepted pending note {pending_id} -> note {n.id} from {pending.sender_username}')
        return jsonify({'success': True, 'note_id': n.id}), 201
    finally:
        if payload_needs_cleanup and note_id:
            db.session.rollback()
            try:
                if not storage.delete_note(note_id):
                    print(f'[ERROR] Could not clean uncommitted accepted-note payload {note_id}')
            except Exception as e:
                print(f'[ERROR] Could not clean uncommitted accepted-note payload {note_id}: {e}')
        _release_lifecycle_lock(lifecycle_lock)
        _release_user_quota_lock(quota_lock)
        _release_scoped_lock(pending_lock)

@app.route('/notes/api/pending/<int:pending_id>/reject', methods=['POST'])
@login_required
def notes_reject_pending(pending_id):
    """Reject and delete a pending note."""
    user_id = session['logged_in_user_id']
    pending_lock = _acquire_pending_note_decision_lock(pending_id)
    try:
        pending = _lock_current_pending_note_for_decision(pending_id, user_id)
        if not pending:
            return jsonify({'error': 'PENDING NOTE NOT FOUND'}), 404
        sender = pending.sender_username
        db.session.delete(pending)
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        print(f'[NOTES] User {user_id} rejected pending note {pending_id} from {sender}')
        return jsonify({'success': True})
    finally:
        _release_scoped_lock(pending_lock)

@app.route('/notes/api/unread-count', methods=['GET'])
@login_required
def notes_unread_count():
    """Return the count of unread received notes + pending notes."""
    user_id = session['logged_in_user_id']
    unread = Note.query.filter_by(user_id=user_id, is_read=False, is_trashed=False).count()
    pending = PendingNote.query.filter_by(recipient_id=user_id).count()
    return jsonify({'unread': unread, 'pending': pending, 'total': unread + pending})

# ──────────────────────────────────────────────────────────────
# API v1 Routes (/apiv1/) - Programmatic access via API keys
# ──────────────────────────────────────────────────────────────

