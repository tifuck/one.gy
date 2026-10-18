@app.route('/api/notifications/active')
@limiter.limit("30 per minute")
@csrf.exempt
def api_notifications_active():
    """Return active notifications for the current user/visitor.

    Triggers:
      always      — every page until the user clicks × (permanent DB dismissal)
      every_login / once_login — every page of THIS login until × (session only;
                    comes back on the next login)
      on_register — first authenticated session after register, until × (permanent)
      first_login — first login ever, until × (permanent)
    """
    now = datetime.now(timezone.utc)

    query = Notification.query.filter(
        Notification.is_active == True,
        db.or_(Notification.expires_at == None, Notification.expires_at > now)
    )

    notifs = query.order_by(Notification.created_at.desc()).all()

    # AUDIT FIX H4: epoch-validating helper so a revoked session does not get
    # user-targeted notifications.
    user = _current_session_user()
    logged_in_user_id = user.id if user else None
    visitor_id = session.get('user_id')

    # Read one-shot flags without consuming them on anonymous pages — a fetch
    # from /login after registration must not swallow on_register.
    just_logged_in = bool(logged_in_user_id and session.get('just_logged_in'))
    just_registered = bool(logged_in_user_id and session.get('just_registered'))
    if logged_in_user_id:
        session.pop('just_logged_in', None)
        session.pop('just_registered', None)

    session_dismissed = _session_id_set('_session_notif_dismissed')
    session_active = _session_id_set('_session_notif_active')

    dismissed_ids = set()
    if logged_in_user_id:
        dismissed_ids = {d.notification_id for d in NotificationDismissal.query.filter_by(user_id=logged_in_user_id).all()}
        if visitor_id:
            dismissed_ids |= {d.notification_id for d in NotificationDismissal.query.filter_by(visitor_id=visitor_id).all()}
    elif visitor_id:
        dismissed_ids = {d.notification_id for d in NotificationDismissal.query.filter_by(visitor_id=visitor_id).all()}

    result = []
    active_changed = False
    for n in notifs:
        trigger = n.display_trigger or 'always'

        if trigger == 'always':
            if n.id in dismissed_ids:
                continue
        elif trigger in _NOTIF_SESSION_TRIGGERS:
            if not logged_in_user_id:
                continue
            if n.id in session_dismissed:
                continue
        elif trigger == 'on_register':
            if not logged_in_user_id:
                continue
            if n.id in dismissed_ids or n.id in session_dismissed:
                continue
            if not (just_registered or n.id in session_active):
                continue
            if n.id not in session_active:
                session_active.add(n.id)
                active_changed = True
        elif trigger == 'first_login':
            if not logged_in_user_id:
                continue
            if n.id in dismissed_ids or n.id in session_dismissed:
                continue
            in_window = just_logged_in and (user.login_count or 0) == 1
            if not (in_window or n.id in session_active):
                continue
            if n.id not in session_active:
                session_active.add(n.id)
                active_changed = True
        else:
            continue

        result.append({
            'id': n.id,
            'title': n.title or 'NOTICE',
            'message': n.message,
            'bg_color': n.bg_color or '#DE1833',
            'auto_dismiss': n.auto_dismiss,
            'dismiss_seconds': n.dismiss_seconds,
            'display_trigger': trigger,
        })

    if active_changed:
        session['_session_notif_active'] = list(session_active)

    return _notif_nocache(jsonify(result))

@app.route('/api/notifications/<int:notif_id>/dismiss', methods=['POST'])
@limiter.limit("60 per minute")
# AUDIT FIX L4: this endpoint is session-authenticated and state-changing;
# removing the CSRF exemption closes a cross-site forgery vector. The
# first-party SPA already sends X-CSRFToken via getCSRFToken().
def api_notifications_dismiss(notif_id):
    """Record that the current user/visitor dismissed a notification.

    always / on_register / first_login → permanent DB row (never again).
    every_login / once_login → this login session only (session cookie), so
    the banner can return on the next login.
    """
    notif = db.session.get(Notification, notif_id)
    if not notif:
        return _notif_nocache(jsonify({'error': 'NOT FOUND'})), 404

    trigger = notif.display_trigger or 'always'
    _session_id_add('_session_notif_dismissed', notif_id)

    if trigger in _NOTIF_SESSION_TRIGGERS:
        return _notif_nocache(jsonify({'success': True}))

    # AUDIT FIX H4: epoch-validated user resolution.
    _dismiss_user = _current_session_user()
    logged_in_user_id = _dismiss_user.id if _dismiss_user else None
    visitor_id = session.get('user_id')

    # Anonymous visitors on public pages (landing, docs, …) have no guest
    # user_id until they upload. Mint one so an `always` dismiss actually
    # sticks instead of returning success and re-showing on the next page.
    if not logged_in_user_id and not visitor_id:
        visitor_id = str(uuid.uuid4())
        session['user_id'] = visitor_id

    existing = None
    if logged_in_user_id:
        existing = NotificationDismissal.query.filter_by(
            notification_id=notif_id, user_id=logged_in_user_id
        ).first()
    elif visitor_id:
        existing = NotificationDismissal.query.filter_by(
            notification_id=notif_id, visitor_id=visitor_id
        ).first()

    if not existing:
        dismissal = NotificationDismissal(
            notification_id=notif_id,
            user_id=logged_in_user_id,
            visitor_id=visitor_id if not logged_in_user_id else None,
        )
        db.session.add(dismissal)
        from sqlalchemy.exc import IntegrityError as _IntegrityError
        try:
            db.session.commit()
        except _IntegrityError:
            db.session.rollback()
        except Exception as e:
            db.session.rollback()
            print(f'[WARNING] Failed to record notification dismissal {notif_id}: {e}')

    return _notif_nocache(jsonify({'success': True}))

@app.route('/docs')
def docs():
    temp_max = get_float_setting('temp_max_gb')
    return render_template('docs.html', domain=domain, max_size_gb=max_gb, temp_max_gb=temp_max)

@app.route('/prompts')
def prompts_page():
    return render_template('prompts.html')

@app.route('/prompts/catalog')
def prompts_catalog():
    path = os.path.join(app.static_folder, 'prompts-catalog.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f'[PROMPTS] Failed to load catalog: {e}')
        return jsonify({'error': 'Catalog unavailable'}), 500
    categories = data.get('categories') or []
    total = 0
    tags = set()
    for cat in categories:
        prompts = cat.get('prompts') or []
        cat['count'] = len(prompts)
        total += len(prompts)
        for p in prompts:
            body = p.get('body') or ''
            if isinstance(body, str):
                p['body'] = body.strip('\n')
            for t in (p.get('tags') or []):
                tags.add(t)
    return jsonify({
        'total': total,
        'tags': sorted(tags),
        'categories': categories,
    })

_PROMPT_ID_CACHE = {'mtime': None, 'ids': frozenset()}

def _prompt_catalog_ids():
    path = os.path.join(app.static_folder, 'prompts-catalog.json')
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return _PROMPT_ID_CACHE['ids']
    if _PROMPT_ID_CACHE['mtime'] == mtime:
        return _PROMPT_ID_CACHE['ids']
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return _PROMPT_ID_CACHE['ids']
    ids = set()
    for cat in data.get('categories') or []:
        for p in cat.get('prompts') or []:
            pid = p.get('id')
            if pid:
                ids.add(str(pid))
    _PROMPT_ID_CACHE['mtime'] = mtime
    _PROMPT_ID_CACHE['ids'] = frozenset(ids)
    return _PROMPT_ID_CACHE['ids']

def _prompts_feedback_ip_hash():
    ip = (request.remote_addr or '').strip()
    if not ip:
        return None
    key = app.config.get('SECRET_KEY') or ''
    if isinstance(key, bytes):
        key = key.decode('utf-8', 'ignore')
    return hmac.new(key.encode('utf-8'), ip.encode('utf-8'), hashlib.sha256).hexdigest()

def _prompts_feedback_client_ok(data):
    if request.headers.get('X-Requested-With') != 'XMLHttpRequest':
        return False
    origin = (request.headers.get('Origin') or '').strip()
    if origin:
        try:
            parsed = urllib.parse.urlparse(origin)
            if parsed.netloc and parsed.netloc != request.host:
                return False
        except Exception:
            return False
    fetch_site = (request.headers.get('Sec-Fetch-Site') or '').strip()
    if fetch_site and fetch_site != 'same-origin':
        return False
    website = data.get('website')
    # Honeypot: any filled value (string or not) marks a bot; non-strings have no .strip().
    if website and (not isinstance(website, str) or website.strip()):
        return False
    sig = data.get('signals')
    if not isinstance(sig, dict):
        return False
    if sig.get('webdriver') is True:
        return False
    if sig.get('headlessUA') is True:
        return False
    if sig.get('interacted') is not True:
        return False
    try:
        dwell = int(data.get('dwell_ms') or 0)
    except (TypeError, ValueError):
        dwell = 0
    if dwell < 1200:
        return False
    return True

@app.route('/prompts/feedback', methods=['POST'])
@limiter.limit('1 per minute')
def prompts_feedback():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not _prompts_feedback_client_ok(data):
        return jsonify({'error': 'Could not send feedback.'}), 400
    kind = data.get('kind')
    kind = kind.strip() if isinstance(kind, str) else ''
    if kind not in ('general', 'prompt'):
        return jsonify({'error': 'Could not send feedback.'}), 400
    message = (data.get('message') or '')
    if not isinstance(message, str):
        return jsonify({'error': 'Could not send feedback.'}), 400
    message = message.strip()
    if len(message) < 8:
        return jsonify({'error': 'Write a little more.'}), 400
    if len(message) > 2000:
        message = message[:2000]
    prompt_id = None
    if kind == 'prompt':
        raw_id = data.get('prompt_id')
        raw_id = raw_id.strip()[:80] if isinstance(raw_id, str) else ''
        if raw_id not in _prompt_catalog_ids():
            return jsonify({'error': 'Could not send feedback.'}), 400
        prompt_id = raw_id
    ip_hash = _prompts_feedback_ip_hash()
    if ip_hash:
        now = datetime.now(timezone.utc)
        if PromptFeedback.query.filter(
            PromptFeedback.ip_hash == ip_hash,
            PromptFeedback.created_at >= now - timedelta(seconds=60),
        ).count() >= 1:
            return jsonify({'error': 'Too many submissions. Try again later.'}), 429
        if PromptFeedback.query.filter(
            PromptFeedback.ip_hash == ip_hash,
            PromptFeedback.created_at >= now - timedelta(hours=24),
        ).count() >= 8:
            return jsonify({'error': 'Too many submissions. Try again later.'}), 429
    user = _current_session_user()
    row = PromptFeedback(
        kind=kind,
        prompt_id=prompt_id,
        message=message,
        user_id=user.id if user else None,
        visitor_id=None if user else session.get('user_id'),
        ip_hash=ip_hash,
        created_at=datetime.now(timezone.utc),
    )
    db.session.add(row)
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f'[PROMPTS] Feedback save failed: {e}')
        return jsonify({'error': 'Could not send feedback.'}), 500
    print(f'[PROMPTS] Feedback id={row.id} kind={kind} prompt={prompt_id or "-"}')
    return jsonify({'success': True}), 201

@app.route('/debug-session')
@admin_required
def debug_session():
    """Debug route to check session data - restricted to admin users only"""
    user = _current_session_user()
    return jsonify({
        'session_data': {
            'logged_in_user_id': session.get('logged_in_user_id'),
            'username': session.get('username'),
        },
        'user_from_db': {
            'id': user.id if user else None,
            'username': user.username if user else None,
            'is_admin': user.is_admin if user else None
        } if user else None
    })

