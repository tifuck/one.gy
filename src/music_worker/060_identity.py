# Identity: "do we already have this song?" (plan section 6) and the audio
# fingerprints that settle it. Fingerprints come from ffmpeg's built-in
# Chromaprint; a store's 30 s preview is slid along a full track and the lowest
# bit error rate (BER) wins.
import numpy as np

# A 30 s preview yields ~240 frames; fewer than this is too little to judge.
MIN_PREVIEW_FRAMES = 100


def fingerprint(path):
    """Raw Chromaprint frames of an audio file (uint32 array)."""
    result = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '2', '-ar', '44100',
                             '-f', 'chromaprint', '-fp_format', 'raw', '-'],
                            capture_output=True, timeout=600)
    if result.returncode:
        raise AcquireError('decode_failed', result.stderr.decode('utf-8', 'replace')[-300:])
    return np.frombuffer(result.stdout, dtype='<u4')


def best_ber(short, long):
    """Lowest bit error rate of `short` at any offset inside `long` (1.0 = no overlap)."""
    n = len(short)
    if n == 0 or len(long) < n:
        return 1.0
    windows = np.lib.stride_tricks.sliding_window_view(long, n)
    bits = np.bitwise_count(np.bitwise_xor(windows, short)).sum(axis=1, dtype=np.int64)
    return float(bits.min()) / (32.0 * n)


def preview_fingerprint(url):
    """Fingerprint of a store preview, or None when it is missing or too short."""
    if not url:
        return None
    os.makedirs(TMP_DIR, exist_ok=True)
    fd, path = tempfile.mkstemp(dir=TMP_DIR, suffix='.preview')
    try:
        with os.fdopen(fd, 'wb') as fp:
            fp.write(fetch_bytes('preview', url, max_bytes=5 * 1024 * 1024))
        frames = fingerprint(path)
    except (SourceError, AcquireError):
        return None
    finally:
        os.unlink(path)
    return frames if len(frames) >= MIN_PREVIEW_FRAMES else None


def resolve(card, preview_fp):
    """('have' | 'equivalent' | 'new', song_id).

    have:        the ISRC or Deezer id is already in the library.
    equivalent:  a held song with the same artist, base title and version, a
                 duration within 3 s and a matching fingerprint. Its ids are
                 recorded as aliases so the next lookup is a direct hit."""
    song_id = lib_find(isrc=card['isrc'], deezer_id=card['id'])
    if song_id:
        return 'have', song_id
    if preview_fp is None:
        return 'new', None
    for song_id, duration_ms, path in lib_songs_by_norm(card['norm_key']):
        if abs((duration_ms or 0) / 1000 - card['duration']) > 3 or not os.path.isfile(path):
            continue
        if best_ber(preview_fp, fingerprint(path)) < FP_MATCH_BER:
            lib_add_aliases(song_id, isrc=card['isrc'], deezer_id=card['id'])
            return 'equivalent', song_id
    return 'new', None
