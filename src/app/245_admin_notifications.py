# Admin notifications, prompt feedback and the per-session notification trigger helpers.

@app.route('/admin/api/notifications')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications():
    """List all notifications for admin management"""
    notifs = Notification.query.order_by(Notification.created_at.desc()).all()
    result = []
    for n in notifs:
        result.append({
            'id': n.id,
            'title': n.title,
            'message': n.message,
            'bg_color': n.bg_color or '#DE1833',
            'display_trigger': n.display_trigger,
            'auto_dismiss': n.auto_dismiss,
            'dismiss_seconds': n.dismiss_seconds,
            'is_active': n.is_active,
            'expires_at': n.expires_at.isoformat() if n.expires_at else None,
            'created_at': n.created_at.isoformat() if n.created_at else None,
            'created_by': n.created_by,
        })
    return jsonify(result)

def _parse_notification_expiry(value):
    """ISO-8601 expiry -> aware UTC datetime, or None when unparseable or
    outside what the DATETIME column / UTC conversion can represent."""
    try:
        expires_at = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        expires_at = expires_at.astimezone(timezone.utc)
    except (ValueError, AttributeError, OverflowError):
        return None
    if not 1970 <= expires_at.year <= 9999:
        return None
    return expires_at

@app.route('/admin/api/notifications', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications_create():
    """Create a new notification"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    message = data.get('message')
    title = data.get('title', '')
    if not isinstance(message, str) or not message.strip():
        return jsonify({'error': 'MESSAGE IS REQUIRED'}), 400
    # AUDIT FIX (finding 18): bound both fields -- notification rows are
    # loaded wholesale on every page render, so an unbounded message (or
    # title) let one admin call bloat every subsequent response.
    if len(message) > 5000:
        return jsonify({'error': 'MESSAGE TOO LONG (MAX 5000 CHARACTERS)'}), 400
    if not isinstance(title, str):
        return jsonify({'error': 'TITLE MUST BE TEXT'}), 400
    if len(title) > 120:
        return jsonify({'error': 'TITLE TOO LONG (MAX 120 CHARACTERS)'}), 400
    title = title.strip()
    if len(title) > 120:
        return jsonify({'error': 'TITLE TOO LONG (MAX 120 CHARACTERS)'}), 400

    valid_triggers = {'always', 'on_register', 'first_login', 'every_login', 'once_login'}
    trigger = data.get('display_trigger', 'always')
    if not isinstance(trigger, str) or trigger not in valid_triggers:
        return jsonify({'error': 'INVALID DISPLAY TRIGGER'}), 400

    bg_color_value = data.get('bg_color', '#DE1833')
    if not isinstance(bg_color_value, str):
        return jsonify({'error': 'BACKGROUND COLOR MUST BE TEXT'}), 400
    bg_color = bg_color_value.strip()
    if not bg_color or len(bg_color) != 7 or not bg_color.startswith('#'):
        bg_color = '#DE1833'

    expires_at = None
    if data.get('expires_at'):
        expires_at = _parse_notification_expiry(data['expires_at'])
        if expires_at is None:
            return jsonify({'error': 'INVALID EXPIRY DATE FORMAT'}), 400

    auto_dismiss = data.get('auto_dismiss', False)
    if not isinstance(auto_dismiss, bool):
        return jsonify({'error': 'AUTO_DISMISS MUST BE A BOOLEAN'}), 400
    dismiss_seconds = None
    if auto_dismiss:
        try:
            dismiss_seconds = int(data.get('dismiss_seconds', 10))
            if dismiss_seconds < 1:
                dismiss_seconds = 1
            if dismiss_seconds > 3600:
                dismiss_seconds = 3600
        except (ValueError, TypeError, OverflowError):
            dismiss_seconds = 10

    notif = Notification(
        title=title or None,
        message=message.strip(),
        bg_color=bg_color,
        display_trigger=trigger,
        auto_dismiss=auto_dismiss,
        dismiss_seconds=dismiss_seconds,
        is_active=True,
        expires_at=expires_at,
        created_by=session.get('logged_in_user_id'),
    )
    db.session.add(notif)
    db.session.commit()

    print(f'[ADMIN] Notification created: id={notif.id}, trigger={trigger}, by user {session.get("logged_in_user_id")}')

    return jsonify({
        'success': True,
        'id': notif.id,
        'title': notif.title,
        'message': notif.message,
        'bg_color': notif.bg_color or '#DE1833',
        'display_trigger': notif.display_trigger,
        'auto_dismiss': notif.auto_dismiss,
        'dismiss_seconds': notif.dismiss_seconds,
        'is_active': notif.is_active,
        'expires_at': notif.expires_at.isoformat() if notif.expires_at else None,
        'created_at': notif.created_at.isoformat() if notif.created_at else None,
    }), 201

@app.route('/admin/api/notifications/<int:notif_id>', methods=['PUT'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications_update(notif_id):
    """Update an existing notification"""
    notif = db.session.get(Notification, notif_id)
    if not notif:
        return jsonify({'error': 'NOTIFICATION NOT FOUND'}), 404

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400

    if 'message' in data:
        if not isinstance(data['message'], str):
            return jsonify({'error': 'MESSAGE MUST BE TEXT'}), 400
        msg = data['message'].strip()
        if not msg:
            return jsonify({'error': 'MESSAGE IS REQUIRED'}), 400
        # AUDIT FIX (finding 18): same bound as the create route.
        if len(msg) > 5000:
            return jsonify({'error': 'MESSAGE TOO LONG (MAX 5000 CHARACTERS)'}), 400
        notif.message = msg

    if 'title' in data:
        if not isinstance(data['title'], str):
            return jsonify({'error': 'TITLE MUST BE TEXT'}), 400
        title = data['title'].strip()
        if len(title) > 120:
            return jsonify({'error': 'TITLE TOO LONG (MAX 120 CHARACTERS)'}), 400
        notif.title = title or None

    if 'bg_color' in data:
        if not isinstance(data['bg_color'], str):
            return jsonify({'error': 'BACKGROUND COLOR MUST BE TEXT'}), 400
        bg = data['bg_color'].strip()
        if bg and len(bg) == 7 and bg.startswith('#'):
            notif.bg_color = bg

    if 'display_trigger' in data:
        valid_triggers = {'always', 'on_register', 'first_login', 'every_login', 'once_login'}
        if not isinstance(data['display_trigger'], str) or data['display_trigger'] not in valid_triggers:
            return jsonify({'error': 'INVALID DISPLAY TRIGGER'}), 400
        notif.display_trigger = data['display_trigger']

    if 'auto_dismiss' in data:
        if not isinstance(data['auto_dismiss'], bool):
            return jsonify({'error': 'AUTO_DISMISS MUST BE A BOOLEAN'}), 400
        notif.auto_dismiss = data['auto_dismiss']
    # The timer is updatable on its own, and enabling auto-dismiss without one
    # gets the create route's default instead of a NULL (never-dismissing) timer.
    if notif.auto_dismiss:
        if 'dismiss_seconds' in data:
            try:
                ds = int(data['dismiss_seconds'])
                notif.dismiss_seconds = max(1, min(3600, ds))
            except (ValueError, TypeError, OverflowError):
                notif.dismiss_seconds = 10
        elif not notif.dismiss_seconds:
            notif.dismiss_seconds = 10
    elif 'auto_dismiss' in data:
        notif.dismiss_seconds = None

    if 'expires_at' in data:
        if data['expires_at']:
            exp = _parse_notification_expiry(data['expires_at'])
            if exp is None:
                db.session.rollback()
                return jsonify({'error': 'INVALID EXPIRY DATE FORMAT'}), 400
            notif.expires_at = exp
        else:
            notif.expires_at = None

    db.session.commit()
    print(f'[ADMIN] Notification updated: id={notif.id}')

    return jsonify({
        'success': True,
        'id': notif.id,
        'title': notif.title,
        'message': notif.message,
        'bg_color': notif.bg_color or '#DE1833',
        'display_trigger': notif.display_trigger,
        'auto_dismiss': notif.auto_dismiss,
        'dismiss_seconds': notif.dismiss_seconds,
        'is_active': notif.is_active,
        'expires_at': notif.expires_at.isoformat() if notif.expires_at else None,
        'created_at': notif.created_at.isoformat() if notif.created_at else None,
    })

@app.route('/admin/api/notifications/<int:notif_id>', methods=['DELETE'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications_delete(notif_id):
    """Delete a notification and all its dismissals"""
    notif = db.session.get(Notification, notif_id)
    if not notif:
        return jsonify({'error': 'NOTIFICATION NOT FOUND'}), 404

    db.session.delete(notif)
    db.session.commit()
    print(f'[ADMIN] Notification deleted: id={notif_id}')

    return jsonify({'success': True})

@app.route('/admin/api/notifications/<int:notif_id>/toggle', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications_toggle(notif_id):
    """Toggle active/inactive state"""
    notif = db.session.get(Notification, notif_id)
    if not notif:
        return jsonify({'error': 'NOTIFICATION NOT FOUND'}), 404

    notif.is_active = not notif.is_active
    db.session.commit()
    state = 'ACTIVATED' if notif.is_active else 'DEACTIVATED'
    print(f'[ADMIN] Notification {state}: id={notif.id}')

    return jsonify({'success': True, 'is_active': notif.is_active})

@app.route('/admin/api/prompt-feedback')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_prompt_feedback():
    page, per_page = _clamp_pagination(request.args.get('page'), request.args.get('per_page') or 25)
    q = PromptFeedback.query
    search = (request.args.get('search') or '').strip()[:80]
    if search:
        like = '%' + escape_like_pattern(search) + '%'
        q = q.filter(db.or_(
            PromptFeedback.message.like(like, escape='\\'),
            PromptFeedback.prompt_id.like(like, escape='\\'),
            PromptFeedback.kind.like(like, escape='\\'),
        ))
    total = q.count()
    pages = max(1, (total + per_page - 1) // per_page)
    if page > pages:
        page = pages
    rows = q.order_by(PromptFeedback.created_at.desc()).offset((page - 1) * per_page).limit(per_page).all()
    user_ids = [r.user_id for r in rows if r.user_id]
    names = {}
    if user_ids:
        for u in User.query.filter(User.id.in_(user_ids)).all():
            names[u.id] = u.username
    items = []
    for r in rows:
        created = r.created_at
        if created and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        items.append({
            'id': r.id,
            'kind': r.kind,
            'prompt_id': r.prompt_id,
            'message': r.message,
            'username': names.get(r.user_id) if r.user_id else None,
            'created_at': created.isoformat() if created else None,
        })
    return jsonify({'items': items, 'page': page, 'pages': pages, 'total': total})

@app.route('/admin/api/prompt-feedback/<int:fid>', methods=['DELETE'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_prompt_feedback_delete(fid):
    row = db.session.get(PromptFeedback, fid)
    if not row:
        return jsonify({'error': 'FEEDBACK NOT FOUND'}), 404
    db.session.delete(row)
    db.session.commit()
    print(f'[ADMIN] Prompt feedback deleted: id={fid}')
    return jsonify({'success': True})

# ─── Public Notification Endpoints ────────────────────────────────────

_NOTIF_SESSION_TRIGGERS = frozenset(('every_login', 'once_login'))
_NOTIF_ONCE_EVER_TRIGGERS = frozenset(('on_register', 'first_login'))


def _session_id_set(key):
    raw = session.get(key) or []
    try:
        return {int(x) for x in raw}
    except (TypeError, ValueError):
        return set()


def _session_id_add(key, nid):
    lst = list(session.get(key) or [])
    if nid not in lst:
        lst.append(nid)
        session[key] = lst


def _notif_nocache(resp):
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    return resp
