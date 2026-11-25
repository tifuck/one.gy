# Metadata sources (all free, no keys): Deezer, ListenBrainz, Apple Music RSS,
# iTunes, LRCLIB.

DEEZER = 'https://api.deezer.com'
LISTENBRAINZ = 'https://api.listenbrainz.org/1'


def dz(path, **params):
    return http_get('deezer', f'{DEEZER}/{path}', params or None)


def dz_paged(path, limit=100, max_items=1000):
    """All items of a paged Deezer list."""
    items, index = [], 0
    while len(items) < max_items:
        page = dz(path, limit=limit, index=index)
        if not page or not page.get('data'):
            break
        items.extend(page['data'])
        if not page.get('next'):
            break
        index += limit
    return items[:max_items]


def dz_track(track_id):
    return dz(f'track/{int(track_id)}')


def dz_track_by_isrc(isrc):
    return dz(f'track/isrc:{isrc}')


def dz_album(album_id):
    """Album with its full track list (the embedded list can be truncated)."""
    album = dz(f'album/{int(album_id)}')
    if album and len((album.get('tracks') or {}).get('data') or []) < (album.get('nb_tracks') or 0):
        album['tracks'] = {'data': dz_paged(f'album/{int(album_id)}/tracks', limit=100, max_items=500)}
    return album


def dz_artist(artist_id):
    return dz(f'artist/{int(artist_id)}')


def dz_artist_top(artist_id, limit=50):
    page = dz(f'artist/{int(artist_id)}/top', limit=limit)
    return (page or {}).get('data') or []


def dz_artist_albums(artist_id):
    return dz_paged(f'artist/{int(artist_id)}/albums', limit=100, max_items=500)


def dz_search_artist(name):
    page = dz('search/artist', q=name, limit=10)
    return (page or {}).get('data') or []


def dz_search_track(artist, title):
    page = dz('search', q=f'artist:"{artist}" track:"{title}"', limit=10)
    return (page or {}).get('data') or []


def dz_chart_tracks():
    page = dz('chart/0/tracks', limit=100)
    return (page or {}).get('data') or []


def dz_genres():
    page = dz('genre')
    return (page or {}).get('data') or []


def dz_genre_artists(genre_id):
    page = dz(f'genre/{int(genre_id)}/artists')
    return (page or {}).get('data') or []


def lb_sitewide_artists(stats_range):
    data = http_get('listenbrainz', f'{LISTENBRAINZ}/stats/sitewide/artists',
                    {'range': stats_range, 'count': 1000}, allow_404=True)
    return ((data or {}).get('payload') or {}).get('artists') or []


def lb_top_recordings(artist_mbid):
    return http_get('listenbrainz', f'{LISTENBRAINZ}/popularity/top-recordings-for-artist/{artist_mbid}',
                    allow_404=True) or []


def apple_most_played(region):
    data = http_get('apple_rss', f'https://rss.marketingtools.apple.com/api/v2/{region}/music/most-played/100/songs.json')
    return ((data or {}).get('feed') or {}).get('results') or []


def itunes_cover_url(upc):
    """Official album art at 3000 px, by barcode."""
    if not upc:
        return None
    data = http_get('itunes', 'https://itunes.apple.com/lookup', {'upc': upc, 'entity': 'album'})
    for result in (data or {}).get('results') or []:
        art = result.get('artworkUrl100')
        if art and '100x100bb' in art:
            return art.replace('100x100bb', '3000x3000bb')
    return None


def itunes_preview_url(artist, title, duration_s):
    """iTunes 30 s preview of the same song (second opinion for fingerprints)."""
    data = http_get('itunes', 'https://itunes.apple.com/search',
                    {'term': f'{artist} {title}', 'entity': 'song', 'limit': 10})
    for result in (data or {}).get('results') or []:
        length = (result.get('trackTimeMillis') or 0) / 1000
        if result.get('previewUrl') and abs(length - duration_s) <= DURATION_TOLERANCE_S \
                and similarity(result.get('trackName', ''), title) >= 0.9:
            return result['previewUrl']
    return None


def lrclib_lyrics(artist, title, album, duration_s):
    """(synced_lrc, plain_text, instrumental) or None."""
    data = http_get('lrclib', 'https://lrclib.net/api/get',
                    {'artist_name': artist, 'track_name': title, 'album_name': album,
                     'duration': int(round(duration_s))}, allow_404=True)
    if not data:
        return None
    return data.get('syncedLyrics'), data.get('plainLyrics'), bool(data.get('instrumental'))


def fetch_bytes(source, url, max_bytes=30 * 1024 * 1024):
    body = http_get(source, url, as_json=False, timeout=60)
    if body is None or len(body) > max_bytes:
        raise SourceError(f'{source}: download too large or empty')
    return body
