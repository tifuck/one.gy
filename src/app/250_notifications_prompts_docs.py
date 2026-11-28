# Whether any notification is live. Every page asks (core.js) and there is
# almost never one, so the answer is cached in-process: a commit that touches
# a Notification drops it (listeners below), the TTL covers other processes
# and expiry.
_NOTIF_LIVE_TTL_SECONDS = 30
_notif_live = {'gen': 0, 'state': None}


def _notifications_live():
    state = _notif_live['state']
    if state is not None and time.monotonic() - state[0] < _NOTIF_LIVE_TTL_SECONDS:
        return state[1]
    gen = _notif_live['gen']
    now = datetime.now(timezone.utc)
    live = db.session.query(Notification.id).filter(
        Notification.is_active == True,
        db.or_(Notification.expires_at == None, Notification.expires_at > now)
    ).first() is not None
    # An admin edit committed meanwhile: this answer may predate it.
    if _notif_live['gen'] == gen:
        _notif_live['state'] = (time.monotonic(), live)
    return live


def _notifications_changed():
    _notif_live['gen'] += 1
    _notif_live['state'] = None


@event.listens_for(db.session, 'before_flush')
def _notif_live_mark(session, flush_context, instances):
    if any(isinstance(obj, Notification)
           for group in (session.new, session.dirty, session.deleted) for obj in group):
        session.info['_notif_changed'] = True


@event.listens_for(db.session, 'after_commit')
def _notif_live_drop(session):
    if session.info.pop('_notif_changed', False):
        _notifications_changed()


@app.context_processor
def _inject_notifications_live():
    # False lets core.js skip GET /api/notifications/active (_nav.html data-none):
    # nothing is live and no one-shot trigger flag waits for that call to consume it.
    if session.get('just_logged_in') or session.get('just_registered'):
        return {'notifications_live': True}
    try:
        return {'notifications_live': _notifications_live()}
    except Exception:
        db.session.rollback()
        return {'notifications_live': True}


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

    notifs = []
    if _notifications_live():
        query = Notification.query.filter(
            Notification.is_active == True,
            db.or_(Notification.expires_at == None, Notification.expires_at > now)
        )
        notifs = query.order_by(Notification.created_at.desc()).all()
    # The usual case: nothing to show and no one-shot flag for the code below to consume.
    if not notifs and not (session.get('just_logged_in') or session.get('just_registered')):
        return _notif_nocache(jsonify([]))

    # AUDIT FIX H4: epoch-validating helper so a revoked session does not get
    # user-targeted notifications.
    user = _current_session_user()
    logged_in_user_id = user.id if user else None
    visitor_id = session.get('user_id')

    # Read one-shot flags without consuming them on anonymous pages — a fetch
    # from /login after registration must not swallow on_register.
    just_logged_in = bool(logged_in_user_id and session.get('just_logged_in'))
    just_registered = bool(logged_in_user_id and session.get('just_registered'))
    # AUDIT FIX (N2): this GET is CSRF-exempt; a cross-site request must not
    # consume the one-shot flags (or the session state below) for the real page.
    first_party = (request.headers.get('Sec-Fetch-Site') in ('same-origin', 'none')
                   or request.headers.get('X-Requested-With') == 'XMLHttpRequest')
    if logged_in_user_id and first_party:
        session.pop('just_logged_in', None)
        session.pop('just_registered', None)
    if not notifs:
        return _notif_nocache(jsonify([]))

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

    if active_changed and first_party:
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
    try:
        catalog_url = url_for('prompts_catalog', v=_prompt_catalog_payload()[2])
    except Exception:
        catalog_url = url_for('prompts_catalog')
    return render_template('prompts.html', catalog_url=catalog_url)

# (mtime_ns, JSON body, etag), replaced whole like _PROMPT_ID_CACHE below.
_PROMPT_CATALOG_CACHE = (None, b'', '')

def _prompt_catalog_payload():
    """The /prompts/catalog body, rebuilt only when the file changes. Raises on
    a missing or unreadable catalog."""
    global _PROMPT_CATALOG_CACHE
    path = os.path.join(app.static_folder, 'prompts-catalog.json')
    mtime = os.stat(path).st_mtime_ns
    cached = _PROMPT_CATALOG_CACHE
    if cached[0] == mtime:
        return cached
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
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
    body = app.json.dumps({
        'total': total,
        'tags': sorted(tags),
        'categories': categories,
    }).encode('utf-8')
    _PROMPT_CATALOG_CACHE = (mtime, body, hashlib.sha256(body).hexdigest()[:16])
    return _PROMPT_CATALOG_CACHE

@app.route('/prompts/catalog')
def prompts_catalog():
    try:
        _mtime, body, etag = _prompt_catalog_payload()
    except Exception as e:
        print(f'[PROMPTS] Failed to load catalog: {e}')
        return jsonify({'error': 'Catalog unavailable'}), 500
    # Flask-Compress sends the ETag back as "<etag>:<encoding>".
    if any(t.split(':', 1)[0] == etag for t in request.if_none_match.as_set()):
        resp = app.response_class(status=304, mimetype='application/json')
    else:
        resp = app.response_class(body, mimetype='application/json')
    resp.set_etag(etag)
    # The page links ?v=<etag>, so a matching URL never changes content.
    resp.headers['Cache-Control'] = (
        'public, max-age=31536000, immutable' if request.args.get('v') == etag else 'no-cache')
    return resp

# (mtime, ids), replaced whole so a reader never pairs a new mtime with old ids.
_PROMPT_ID_CACHE = (None, frozenset())

def _prompt_catalog_ids():
    global _PROMPT_ID_CACHE
    cached_mtime, cached_ids = _PROMPT_ID_CACHE
    path = os.path.join(app.static_folder, 'prompts-catalog.json')
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return cached_ids
    if cached_mtime == mtime:
        return cached_ids
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return cached_ids
    ids = set()
    for cat in data.get('categories') or []:
        for p in cat.get('prompts') or []:
            pid = p.get('id')
            if pid:
                ids.add(str(pid))
    ids = frozenset(ids)
    _PROMPT_ID_CACHE = (mtime, ids)
    return ids

def _prompts_feedback_ip_hash():
    ip = (get_real_ip() or '').strip()
    if not ip or ip == 'unknown':
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

