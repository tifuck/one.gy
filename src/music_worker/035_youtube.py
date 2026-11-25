# YouTube Music: metadata through ytmusicapi, audio through yt-dlp. No login,
# no cookies. Audio-only streams only: itag 251 (Opus) then 140 (AAC).


class AcquireError(Exception):
    """A song could not be acquired this time; `code` is the error enum."""
    def __init__(self, code, detail=''):
        super().__init__(f'{code}: {detail}' if detail else code)
        self.code = code
        self.detail = str(detail)[:500]


def ytm_call(method, *args, **kwargs):
    """One ytmusicapi call through the best egress; proxy failures move on."""
    for _attempt in range(4):
        egress = pick('ytm')
        src = egress.sources['ytm']
        src.wait()
        try:
            result = getattr(egress.ytm(), method)(*args, **kwargs)
        except Exception as e:
            text = str(e)
            if egress.proxy and isinstance(e, requests.RequestException):
                egress.broken(text)
                continue
            if '429' in text or 'Too Many Requests' in text:
                try:
                    src.penalize(text[:120], label=egress.label)
                except SourcePaused:
                    continue
            src.note_error(text[:200])
            raise SourceError(f'ytm {method}: {text[:200]}')
        if egress.proxy:
            egress.worked()
        src.ok()
        return result
    raise SourcePaused('ytm', time.time() + 30)


def ytm_search_albums(query):
    return ytm_call('search', query, filter='albums', limit=5)[:5]


def ytm_get_album(browse_id):
    return ytm_call('get_album', browse_id)


def ytm_search_songs(query):
    return ytm_call('search', query, filter='songs', limit=10)


def ytm_counterpart(video_id):
    """Album-audio (ATV) twin of a music video, if YouTube Music links one."""
    playlist = ytm_call('get_watch_playlist', video_id, limit=1)
    tracks = (playlist or {}).get('tracks') or []
    counterpart = tracks[0].get('counterpart') if tracks else None
    if counterpart and counterpart.get('videoType') == 'MUSIC_VIDEO_TYPE_ATV':
        return counterpart
    return None


_YTDLP_RATE_LIMIT = ("content isn't available, try again later", 'http error 429', 'too many requests',
                     'confirm you’re not a bot', "confirm you're not a bot")
# yt-dlp error text that means the proxy, not YouTube, failed.
_YTDLP_PROXY_FAILURE = ('proxy', 'socks', 'tunnel', 'timed out', 'connection refused', 'connection reset',
                        'unable to connect', 'network is unreachable', 'name or service not known')


def ytdlp_download(video_id, dest_dir):
    """Download one audio-only stream into dest_dir. Returns the file path."""
    import yt_dlp
    egress = pick('youtube')
    src = egress.sources['youtube']
    src.wait()
    opts = {
        'proxy': egress.proxy or '',
        'format': '251/140',
        'outtmpl': os.path.join(dest_dir, 'download.%(ext)s'),
        'quiet': True, 'no_warnings': True, 'noprogress': True,
        'noplaylist': True, 'cachedir': False, 'retries': 2,
        'logger': _QuietLogger(),
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f'https://music.youtube.com/watch?v={video_id}', download=True)
    except yt_dlp.utils.DownloadError as e:
        text = str(e).lower()
        if egress.proxy and any(marker in text for marker in _YTDLP_PROXY_FAILURE):
            egress.broken(str(e)[:200])
            raise SourcePaused('youtube', time.time() + 5)
        if any(marker in text for marker in _YTDLP_RATE_LIMIT):
            src.penalize(str(e)[:160], 3600 if 'bot' in text else None, egress.label)
        src.note_error(str(e)[:200])
        if 'requested format is not available' in text:
            raise AcquireError('no_audio_stream', video_id)
        if 'country' in text:
            raise AcquireError('region_locked', video_id)
        if 'unavailable' in text or 'removed' in text or 'private video' in text:
            raise AcquireError('removed', video_id)
        raise AcquireError('download_failed', str(e)[:300])
    if egress.proxy:
        egress.worked()
    src.ok()
    path = (info.get('requested_downloads') or [{}])[0].get('filepath')
    if not path or not os.path.isfile(path):
        raise AcquireError('download_failed', 'yt-dlp wrote no file')
    return path


class _QuietLogger:
    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass


def ytdlp_maybe_update():
    """YouTube changes break old yt-dlp releases; update it in this venv daily."""
    marker = os.path.join(TMP_DIR, '.ytdlp-updated')
    try:
        if time.time() - os.path.getmtime(marker) < 86400:
            return
    except OSError:
        pass
    import importlib.metadata
    os.makedirs(TMP_DIR, exist_ok=True)
    before = importlib.metadata.version('yt-dlp')
    result = subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', '-U', 'yt-dlp'],
                            capture_output=True, text=True, timeout=600)
    with open(marker, 'w') as fp:
        fp.write(str(result.returncode))
    if result.returncode:
        log(f'yt-dlp update failed: {result.stderr.strip()[-200:]}')
        return
    after = importlib.metadata.version('yt-dlp')
    if after != before:
        # The loaded module is still the old one; systemd restarts the service.
        log(f'yt-dlp updated {before} -> {after}; restarting to load it')
        STOP.set()
