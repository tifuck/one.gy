# Rate limits, back-off and daily budgets (plan section 4), and the one HTTP
# helper every source client uses.
#
# An egress is one way out to the internet: this server's own connection
# ('direct') or one of the admin's proxies (MusicProxy). YouTube and most APIs
# limit per IP address, so every egress has its own limiter for every source
# (including its own YouTube daily cap), and each request goes to the egress
# that can serve it soonest. A proxy that fails to connect is paused and the
# others carry on.
import requests

from app import fernet, MusicProxy


class SourcePaused(Exception):
    """No egress can serve the source now; retry after `until` (epoch seconds)."""
    def __init__(self, source, until):
        super().__init__(f'{source} paused until {datetime.fromtimestamp(until, timezone.utc):%H:%M:%S} UTC')
        self.source = source
        self.until = until


class SourceError(Exception):
    """A request failed for a reason other than rate limiting."""


class Source:
    """Token-spacing limiter with adaptive back-off, for one source on one egress.

    Calls are spaced `interval * slow` seconds apart. A rate-limit answer
    pauses the source (Retry-After, else 60 s doubling up to 6 h) and halves
    its rate; after an hour without errors the rate recovers 10% per hour."""

    def __init__(self, name, per_second, jitter=0.0, daily_setting=None):
        self.name = name
        self.interval = 1.0 / per_second
        self.jitter = jitter
        self.daily_setting = daily_setting
        self.lock = threading.Lock()
        self.next_at = 0.0
        self.slow = 1.0
        self.strikes = 0
        self.paused_until = 0.0
        self.clean_since = time.time()
        self.day = None
        self.used = 0
        self.errors = 0
        self.last_error = None
        self.dirty = False

    def _roll_day(self):
        today = now().date()
        if self.day != today:
            self.day, self.used, self.errors, self.dirty = today, 0, 0, True

    def capped(self):
        return bool(self.daily_setting) and self.used >= setting_int(self.daily_setting)

    def check(self):
        """Raise SourcePaused while paused or over the daily cap."""
        with self.lock:
            self._roll_day()
            if time.time() < self.paused_until:
                raise SourcePaused(self.name, self.paused_until)
        if self.capped():
            tomorrow = datetime.combine(self.day + timedelta(days=1), datetime.min.time(), timezone.utc)
            raise SourcePaused(self.name, tomorrow.timestamp())

    def wait(self):
        with self.lock:
            t = time.time()
            spacing = self.interval * self.slow * (1 + random.uniform(-self.jitter, self.jitter))
            delay = max(0.0, self.next_at - t)
            self.next_at = max(t, self.next_at) + spacing
            self.used += 1
            self.dirty = True
        if delay:
            STOP.wait(delay)

    def ok(self):
        with self.lock:
            t = time.time()
            if self.slow > 1.0 and t - self.clean_since >= 3600:
                self.slow = max(1.0, self.slow / 1.1)
                self.clean_since = t
            if self.slow == 1.0:
                self.strikes = 0

    def penalize(self, reason, retry_after=None, label=''):
        with self.lock:
            t = time.time()
            self.strikes += 1
            pause = retry_after if retry_after else min(60 * 2 ** (self.strikes - 1), 6 * 3600)
            self.paused_until = max(self.paused_until, t + pause)
            self.slow = min(self.slow * 2, 16.0)
            self.clean_since = self.paused_until
            self.errors += 1
            self.last_error = str(reason)[:300]
            self.dirty = True
        log(f'{self.name}{" via " + label if label else ""}: rate limited ({reason}); paused {int(pause)} s, rate x{1 / self.slow:.2f}')
        raise SourcePaused(self.name, self.paused_until)

    def note_error(self, reason):
        with self.lock:
            self.errors += 1
            self.last_error = str(reason)[:300]
            self.dirty = True


# name: (requests per second, jitter, daily cap setting) for each egress.
SOURCE_SPECS = {
    'deezer': (4, 0.0, None),
    'preview': (2, 0.0, None),
    'listenbrainz': (1, 0.0, None),
    'apple_rss': (0.2, 0.0, None),
    'itunes': (0.25, 0.0, None),
    'lrclib': (1, 0.0, None),
    'ytm': (1 / 3, 0.0, None),
    # About 150 downloads an hour: half of YouTube's guest limit per IP.
    'youtube': (1 / 24, 0.3, 'music_dl_daily_cap'),
}


class Egress:
    """This server's connection or one proxy, with its own limiters."""

    def __init__(self, key, proxy=None, label='This server'):
        self.key = key
        self.proxy = proxy
        self.label = label
        self.sources = {name: Source(name, *spec) for name, spec in SOURCE_SPECS.items()}
        self.session = requests.Session()
        self.session.headers['User-Agent'] = USER_AGENT
        if proxy:
            self.session.proxies = {'http': proxy, 'https': proxy}
        self.lock = threading.Lock()
        self.paused_until = 0.0
        self.strikes = 0
        self.status = 'new' if proxy else 'ok'
        self.last_error = None
        self.last_ok = None
        # Only a change is written back, so an idle copy of a proxy in another
        # process (a CLI run) never overwrites what the service recorded.
        self.dirty = False
        self._ytm = None

    def budget_key(self, source):
        return source if self.key == 'direct' else f'{source}#{self.key[1:]}'

    def broken(self, reason):
        """The proxy itself failed (connect, auth, tunnel): pause it, 2 min doubling to 1 h."""
        with self.lock:
            self.strikes += 1
            pause = min(120 * 2 ** (self.strikes - 1), 3600)
            self.paused_until = time.time() + pause
            self.status, self.last_error, self.dirty = 'failing', str(reason)[:300], True
        log(f'proxy {self.label} failed ({str(reason)[:160]}); paused {pause} s')

    def worked(self):
        with self.lock:
            self.last_ok = now()
            if self.status != 'ok' or self.strikes:
                self.status, self.strikes, self.last_error, self.dirty = 'ok', 0, None, True

    def ytm(self):
        with self.lock:
            if self._ytm is None:
                from ytmusicapi import YTMusic
                self._ytm = YTMusic(proxies=self.session.proxies or None)
            return self._ytm


EGRESSES = {}
EGRESS_LOCK = threading.Lock()


def egress_refresh():
    """Match the pool to the admin's proxy list and the direct-connection switch."""
    wanted = {}
    if setting_on('music_proxy_direct'):
        wanted['direct'] = (None, 'This server')
    with app.app_context():
        for row in MusicProxy.query.filter_by(enabled=True).order_by(MusicProxy.id.asc()).all():
            try:
                wanted[f'p{row.id}'] = (fernet.decrypt(row.url_enc.encode()).decode(), row.label)
            except Exception:
                log(f'proxy {row.label}: stored URL cannot be decrypted; skipped')
    added = []
    with EGRESS_LOCK:
        for key in list(EGRESSES):
            if key not in wanted or EGRESSES[key].proxy != wanted[key][0]:
                del EGRESSES[key]
        for key, (proxy, label) in wanted.items():
            if key not in EGRESSES:
                EGRESSES[key] = Egress(key, proxy, label)
                added.append(EGRESSES[key])
    for egress in added:
        load_budgets(egress)
    return len(wanted)


def egresses():
    with EGRESS_LOCK:
        return list(EGRESSES.values())


def pick(source):
    """The egress that can serve `source` soonest, or SourcePaused until one can."""
    t = time.time()
    best, best_at, soonest = None, None, None
    for egress in egresses():
        if t < egress.paused_until:
            soonest = min(soonest or egress.paused_until, egress.paused_until)
            continue
        try:
            egress.sources[source].check()
        except SourcePaused as e:
            soonest = min(soonest or e.until, e.until)
            continue
        at = egress.sources[source].next_at
        if best is None or at < best_at:
            best, best_at = egress, at
    if best is None:
        raise SourcePaused(source, soonest or t + 60)
    return best


def load_budgets(egress):
    """Restore an egress's counters and pauses for today after a restart."""
    with app.app_context():
        rows = {r.source: r for r in MusicSourceBudget.query.filter_by(day=now().date()).all()}
    for name, src in egress.sources.items():
        row = rows.get(egress.budget_key(name))
        if row is None:
            continue
        src.day, src.used, src.errors = row.day, row.used, row.errors
        src.slow = max(1.0, row.slow or 1.0)
        if row.paused_until:
            src.paused_until = row.paused_until.replace(tzinfo=timezone.utc).timestamp()


def flush_budgets():
    """Persist counters and back-off state per source and egress, and each
    proxy's health and usage for the admin Music tab."""
    pool = egresses()
    with app.app_context():
        for egress in pool:
            used_changed = False
            for name, src in egress.sources.items():
                with src.lock:
                    if not src.dirty or src.day is None:
                        continue
                    used_changed = True
                    state = dict(used=src.used, errors=src.errors, slow=src.slow, last_error=src.last_error,
                                 paused_until=datetime.fromtimestamp(src.paused_until, timezone.utc)
                                 if src.paused_until > time.time() else None)
                    day = src.day
                    src.dirty = False
                key = egress.budget_key(name)
                row = MusicSourceBudget.query.filter_by(source=key, day=day).first()
                if not row:
                    row = MusicSourceBudget(source=key, day=day)
                    db.session.add(row)
                for field, value in state.items():
                    setattr(row, field, value)
                row.updated_at = now()
            if egress.proxy and (egress.dirty or used_changed):
                row = db.session.get(MusicProxy, int(egress.key[1:]))
                if row is None:
                    continue
                with egress.lock:
                    egress.dirty = False
                    if egress.status != 'new':
                        row.status, row.last_error = egress.status, egress.last_error
                    row.paused_until = datetime.fromtimestamp(egress.paused_until, timezone.utc) \
                        if egress.paused_until > time.time() else None
                    if egress.last_ok:
                        row.last_ok = egress.last_ok
                row.day = now().date()
                row.downloads_today = egress.sources['youtube'].used
                row.requests_today = sum(s.used for n, s in egress.sources.items() if n != 'youtube')
        db.session.commit()


def _retry_after(value):
    try:
        return max(1, int(float(value)))
    except (TypeError, ValueError):
        return None


def http_get(source, url, params=None, as_json=True, allow_404=False, timeout=30):
    """GET through the best egress for `source`. Returns parsed JSON (or bytes),
    None for a 404 when allow_404; raises SourcePaused when every egress is
    limited, SourceError otherwise. Proxy failures move to another egress."""
    for attempt in range(4):
        egress = pick(source)
        src = egress.sources[source]
        src.wait()
        try:
            resp = egress.session.get(url, params=params, timeout=timeout,
                                      headers={'Accept': 'application/json' if as_json else '*/*'})
        except requests.RequestException as e:
            if egress.proxy:
                egress.broken(e)
                continue
            if attempt < 2:
                STOP.wait(2 ** attempt)
                continue
            src.note_error(e)
            raise SourceError(f'{source}: {e}')
        if egress.proxy:
            egress.worked()
        remaining = resp.headers.get('X-RateLimit-Remaining')
        if remaining == '0':
            with src.lock:
                src.next_at = max(src.next_at, time.time() + (_retry_after(resp.headers.get('X-RateLimit-Reset-In')) or 10))
        code = resp.status_code
        if code == 404 and allow_404:
            src.ok()
            return None
        if code in (429, 503):
            try:
                src.penalize(f'HTTP {code}', _retry_after(resp.headers.get('Retry-After')), egress.label)
            except SourcePaused:
                continue
        if code >= 500 and attempt < 2:
            STOP.wait(2 ** attempt)
            continue
        if code >= 400:
            src.note_error(f'HTTP {code}')
            raise SourceError(f'{source}: HTTP {code} for {url[:120]}')
        src.ok()
        if not as_json:
            return resp.content
        try:
            data = resp.json()
        except ValueError:
            src.note_error('invalid JSON')
            raise SourceError(f'{source}: invalid JSON from {url[:120]}')
        if source == 'deezer' and isinstance(data, dict) and isinstance(data.get('error'), dict):
            error_code = data['error'].get('code')
            if error_code == 4:
                try:
                    src.penalize('quota exceeded', 5, egress.label)
                except SourcePaused:
                    continue
            if error_code == 800:
                return None
            src.note_error(data['error'])
            raise SourceError(f'deezer: {data["error"]}')
        return data
    raise SourcePaused(source, time.time() + 30)
