@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.static_folder, 'logos'), 'favicon.ico', mimetype='image/x-icon')

# robots.txt — served dynamically so it stays in sync with the app and removes
# the steady stream of 404s for /robots.txt seen in PROD logs. It also stops
# well-behaved crawlers from following the SPA's dynamic /file/... and /static/
# JS URLs: GPTBot was scraping a thumbnail URL out of the JS source and
# requesting it un-interpolated, which previously produced a 500. NOTE: this is
# a machine-readable protocol file, so paths MUST stay lowercase to match real
# URLs — the UPPERCASE user-facing-text convention does not apply here.
_ROBOTS_TXT = """User-agent: *
Disallow: /file/
Disallow: /f/
Disallow: /static/
Disallow: /dashboard
Disallow: /notes
Disallow: /music
Disallow: /account
Disallow: /admin
Disallow: /api
Disallow: /apiv1
Disallow: /login
Disallow: /register
Disallow: /logout
Disallow: /temp-upload
Disallow: /manage

# AI / LLM scrapers: this is a privacy-focused file tool, so no crawling.
User-agent: GPTBot
Disallow: /

User-agent: ChatGPT-User
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: anthropic-ai
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: PerplexityBot
Disallow: /
"""

@app.route('/robots.txt')
def robots_txt():
    resp = make_response(_ROBOTS_TXT)
    resp.headers['Content-Type'] = 'text/plain; charset=utf-8'
    resp.headers['Cache-Control'] = 'public, max-age=86400'
    return resp

@app.route('/')
def index():
    landing_stats = get_public_landing_stats()
    return render_template('landing_frost_hybrid.html',
                           landing_stats=landing_stats, max_size_gb=max_gb,
                           temp_max_gb=get_float_setting('temp_max_gb'))

@app.route('/temp-upload')
def temp_upload_redirect():
    """Backward-compat redirect for old bookmarks / cached links."""
    return redirect(url_for('share'), code=301)

@app.route('/share')
def share():
    if not get_setting('allow_temp_uploads'):
        if 'logged_in_user_id' not in session:
            flash('SHARING IS DISABLED. PLEASE LOGIN TO UPLOAD FILES.', 'error')
            return redirect(url_for('login'))
        return redirect(url_for('files'))

    # Get user's temporary uploads (both logged-in and guest)
    # Uses BOTH session-based ID and cookie-based manager identity for resilience
    temp_files = []
    seen_ids = set()
    now = datetime.now(timezone.utc)

    # Account-based lookup keeps signed-in quick shares bound to the account,
    # even if the guest/session identity or manager cookie later changes.
    requesting_user = _current_session_user()
    if requesting_user:
        for f in File.query.filter_by(registered_user_id=requesting_user.id, is_temp_upload=True, pending_delete_at=None).order_by(File.upload_time.desc()).all():
            if f.get_expires_at_aware() is None or f.get_expires_at_aware() >= now:
                temp_files.append(f)
                seen_ids.add(f.id)

    # Session-based lookup for anonymous uploads.
    if 'user_id' in session:
        user_id = session['user_id']
        for f in File.query.filter_by(user_id=user_id, registered_user_id=None, is_temp_upload=True, pending_delete_at=None).order_by(File.upload_time.desc()).all():
            if f.id not in seen_ids and (f.get_expires_at_aware() is None or f.get_expires_at_aware() >= now):
                temp_files.append(f)
                seen_ids.add(f.id)

    # Cookie-based lookup (survives session loss, new tabs, etc.)
    manager_cookie = request.cookies.get('onegy_manager')
    cookie_added = False
    if manager_cookie:
        for f in File.query.filter_by(manager_cookie_id=manager_cookie, registered_user_id=None, is_temp_upload=True, pending_delete_at=None).order_by(File.upload_time.desc()).all():
            if f.id not in seen_ids and (f.get_expires_at_aware() is None or f.get_expires_at_aware() >= now):
                temp_files.append(f)
                seen_ids.add(f.id)
                cookie_added = True
        # Re-sort combined list by upload time descending if we merged from both sources
        if cookie_added:
            # AUDIT FIX (residual): `f.upload_time or datetime.min` compared a
            # naive sentinel against rows that can carry tzinfo (freshly
            # created) -> TypeError on a mixed list, and a NULL upload_time was
            # only safe by luck. get_upload_time_aware() always returns an
            # aware datetime (epoch for NULL), so the ordering is total.
            temp_files.sort(key=lambda f: f.get_upload_time_aware(), reverse=True)
    
    previewable_exts = [
        'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg',
        'txt', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml',
        'py', 'js', 'html', 'css', 'sh', 'ini', 'cfg', 'conf',
        'c', 'cpp', 'h', 'hpp', 'lua', 'rb', 'rs', 'go', 'java',
        'ts', 'tsx', 'jsx', 'toml', 'bat', 'ps1', 'sql', 'r',
        'swift', 'kt', 'php', 'pl', 'diff', 'makefile',
        'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac',
        'mp4', 'webm', 'mov', 'm4v', 'mkv', 'pdf',
    ]
    temp_max = get_float_setting('temp_max_gb')
    return render_template('share.html', max_gb=max_gb, temp_max_gb=temp_max, temp_files=temp_files, previewable_exts=previewable_exts)

def generate_captcha_image(text):
    """Generate a captcha image with math expression text, returns PNG bytes"""
    from PIL import Image, ImageDraw, ImageFont
    import math
    # AUDIT FIX L1: use the CSPRNG (`secrets`) for any value that contributes
    # to anti-automation. `random` (Mersenne Twister) is not designed to resist
    # state recovery; using `secrets` raises the bar without changing the look
    # or layout of the captcha.
    import secrets as _secrets_cap

    width, height = 200, 60
    img = Image.new('RGB', (width, height), color=(20, 20, 20))
    draw = ImageDraw.Draw(img)

    # Load font
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 28)
    except Exception:
        font = ImageFont.load_default()

    # Measure text to center it
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (width - tw) // 2
    y = (height - th) // 2 - bbox[1]

    # Draw subtle grid lines for visual noise
    for i in range(0, width, 12):
        draw.line([(i, 0), (i, height)], fill=(30, 30, 30), width=1)
    for i in range(0, height, 12):
        draw.line([(0, i), (width, i)], fill=(30, 30, 30), width=1)

    # Draw random dots as noise
    for _ in range(60):
        dx = _secrets_cap.randbelow(width)
        dy = _secrets_cap.randbelow(height)
        c = 40 + _secrets_cap.randbelow(41)
        draw.point((dx, dy), fill=(c, c, c))

    # Draw a few wavy lines through the image
    for _ in range(2):
        points = []
        ly = 10 + _secrets_cap.randbelow(height - 20) if height > 20 else height // 2
        for lx in range(0, width, 4):
            phase = (_secrets_cap.randbelow(1000) / 1000.0) * 3.0
            points.append((lx, ly + int(6 * math.sin(lx * 0.05 + phase))))
        c = 50 + _secrets_cap.randbelow(41)
        draw.line(points, fill=(c, c, c), width=1)

    # Draw each character individually with slight random offsets for a natural look
    char_x = x
    for ch in text:
        offset_y = _secrets_cap.randbelow(5) - 2  # -2..+2
        char_color = (
            190 + _secrets_cap.randbelow(51),
            190 + _secrets_cap.randbelow(51),
            190 + _secrets_cap.randbelow(51),
        )
        draw.text((char_x, y + offset_y), ch, font=font, fill=char_color)
        ch_bbox = draw.textbbox((0, 0), ch, font=font)
        char_x += ch_bbox[2] - ch_bbox[0] + 1 + _secrets_cap.randbelow(4)

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return buf.getvalue()

def _captcha_answer_mac(nonce, answer):
    if nonce is None or answer is None:
        return None
    secret = app.config['SECRET_KEY'].encode('utf-8')
    payload = f'{nonce}:{answer}'.encode('utf-8')
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()

def _store_captcha_challenge(answer):
    captcha_nonce = secrets.token_urlsafe(16)
    session['captcha_nonce'] = captcha_nonce
    session['captcha_mac'] = _captcha_answer_mac(captcha_nonce, str(answer))
    session['captcha_time'] = time.time()

def _pop_captcha_challenge():
    return (
        session.pop('captcha_nonce', None),
        session.pop('captcha_mac', None),
        session.pop('captcha_time', None),
    )

# AUDIT FIX M2: server-side single-use store for solved captcha nonces. The
# challenge itself lives only in the cookie session, so "popping" it merely
# rewrites the client's cookie — an attacker who retains the pre-pop cookie can
# replay the same solved nonce+answer indefinitely (until the 300s expiry),
# neutralizing the captcha as an anti-automation control on registration,
# account deletion and adaptive login. Tracking consumed nonces here makes each
# solved captcha usable exactly once. The dict is a process-local observability
# mirror only; per-nonce flocked state is authoritative across workers.
_captcha_consumed_nonces = {}   # nonce -> expiry epoch (non-authoritative mirror)
_captcha_consumed_lock = threading.Lock()

# DEAD CODE REMOVED (residual audit item k): _captcha_mark_consumed() had ZERO
# callers; _captcha_try_consume() is the atomic check-and-insert every verify
# path uses, and it maintains the same mirror dict + flocked state.

def _captcha_is_consumed(nonce):
    if not nonce:
        return False
    now = time.time()
    locks = _acquire_security_state_locks([('captcha', nonce)])
    try:
        state = _read_security_state('captcha', nonce)
        if not _security_state_fresh(state, now):
            _write_security_state('captcha', nonce, None)
            with _captcha_consumed_lock:
                _captcha_consumed_nonces.pop(nonce, None)
            return False
        return True
    finally:
        _release_security_state_locks(locks)

def _captcha_try_consume(nonce, ttl=360):
    """Atomically mark a captcha nonce as consumed iff it is not already.
    Returns True if THIS caller won the race (nonce was unused), False if a
    concurrent request already consumed it. The check-and-insert happen under a
    single lock acquisition so two concurrent requests sharing one solved nonce
    cannot both succeed."""
    if not nonce:
        return True
    now = time.time()
    expiry = now + ttl
    locks = _acquire_security_state_locks([('captcha', nonce)])
    try:
        state = _read_security_state('captcha', nonce)
        if _security_state_fresh(state, now):
            return False
        _write_security_state('captcha', nonce, {
            'expires': expiry,
            'retain_until': expiry,
        })
    finally:
        _release_security_state_locks(locks)
    with _captcha_consumed_lock:
        _captcha_consumed_nonces[nonce] = expiry
        if len(_captcha_consumed_nonces) > 4096:
            _captcha_consumed_nonces.clear()
    return True

def _validate_captcha_response(captcha_input):
    """Verify a captcha answer, burning the challenge on the FIRST attempt.

    AUDIT FIX M9: the answer space is only ~0-40 and the challenge is popped from
    an ATTACKER-CONTROLLED cookie, so re-sending the pre-pop cookie replayed the
    same nonce+MAC. Because the nonce was previously burned only on SUCCESS, an
    attacker could enumerate all ~40 answers against a single challenge and be
    guaranteed a solve — the captcha provided no anti-automation value at all.

    The nonce is now consumed on the first verification ATTEMPT regardless of
    outcome, so one issued challenge buys exactly one guess. The HMAC
    construction is unchanged."""
    captcha_nonce, captcha_mac, captcha_time = _pop_captcha_challenge()
    if not captcha_mac or not captcha_input or not captcha_nonce:
        return False, 'PLEASE COMPLETE THE CAPTCHA'
    # Burn FIRST. _captcha_try_consume is an atomic check-and-insert, so the
    # loser of a concurrent race (and every later replay of the same cookie)
    # is rejected before the answer is even looked at.
    if not _captcha_try_consume(captcha_nonce):
        return False, 'CAPTCHA ALREADY USED. PLEASE TRY AGAIN'
    if captcha_time and (time.time() - captcha_time) > 300:
        return False, 'CAPTCHA EXPIRED. PLEASE TRY AGAIN'
    expected_mac = _captcha_answer_mac(captcha_nonce, str(captcha_input))
    if not expected_mac or not hmac.compare_digest(captcha_mac, expected_mac):
        return False, 'INCORRECT CAPTCHA ANSWER. PLEASE TRY AGAIN'
    return True, None

@app.route('/captcha')
@limiter.limit("30 per minute")
def captcha():
    """Generate a math captcha image and store the answer in the session"""
    import secrets as _secrets_cap
    # AUDIT FIX L1: CSPRNG-backed problem generation.
    op = _secrets_cap.choice(('+', '-'))
    if op == '+':
        a = 1 + _secrets_cap.randbelow(20)
        b = 1 + _secrets_cap.randbelow(20)
        answer = a + b
    else:
        a = 5 + _secrets_cap.randbelow(26)
        b = 1 + _secrets_cap.randbelow(a)
        answer = a - b

    display_text = f'{a} {op} {b} = ?'
    _store_captcha_challenge(answer)

    img_bytes = generate_captcha_image(display_text)
    # AUDIT FIX L2: do NOT log the captcha problem (it contains the answer)
    # — these logs are forwarded to the external log monitor + Discord.
    print('[AUTH] Captcha generated')

    return send_file(
        io.BytesIO(img_bytes),
        mimetype='image/png',
        download_name='captcha.png'
    )

