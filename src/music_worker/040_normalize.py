# Title normalization and version classification (plan sections 7 and 11.1).
#
# Version words are read only from bracketed parts, " - " suffixes and Deezer's
# title_version, never from the bare title: "Live Forever" is not a live song.

# First match wins. 'original' tags (remaster, mono, original mix) are stripped
# without making the song a different version.
VERSION_RULES = (
    ('karaoke', r'karaoke|made famous by|originally performed|in the style of|tribute'),
    ('sped_up', r'sped[ -]?up|speed(ed)? up|nightcore|\b8d\b'),
    ('slowed', r'slowed|reverb'),
    ('instrumental', r'instrumental|\binst\.?$|backing track'),
    ('a_cappella', r'a ?cap+el+a'),
    ('original', r'original mix|original version|album version|remaster|\bmono\b|\bstereo\b|single version|explicit|clean'),
    ('extended', r'extended|club mix|12"|12 inch'),
    ('remix', r'remix|\brmx\b|\bvip\b|\bbootleg\b|\bflip\b|\brework\b|\bmix\b'),
    ('live', r'\blive\b|en vivo|ao vivo|en directo|in concert|unplugged|\bsession\b'),
    ('acoustic', r'acoustic|ac[uú]stic[oa]|stripped|piano version'),
    ('demo', r'\bdemo\b|rough|early version|alternate (take|version)|\btake \d'),
    ('radio_edit', r'radio edit|\bedit\b|short version'),
    ('rerecording', r"taylor'?s version|re-?recorded|rerecorded"),
)
_VERSION_RES = tuple((name, re.compile(rx, re.I)) for name, rx in VERSION_RULES)
# Versions held by the default modes; the others need the Everything mode or a request.
ORIGINAL_VERSIONS = ('original', 'rerecording')
_FEAT_RE = re.compile(r'\b(feat|ft|featuring|with|prod)\b\.?', re.I)
# In a bare title only these start a credit: "Dancing with Myself" keeps its "with".
_BARE_FEAT_RE = re.compile(r'\s(feat|ft|featuring)\b\.?', re.I)
_BRACKET_RE = re.compile(r'[\(\[\{]([^\)\]\}]*)[\)\]\}]')
_LIVE_ALBUM_RE = re.compile(r'^(live (at|in|from|on)\b)|\b(live (at|in|from)|in concert|unplugged|mtv live)\b', re.I)


def fold(text):
    """Lowercase, NFKC, accents stripped, '&'/'x'/'+' as 'and', alphanumerics only."""
    text = unicodedata.normalize('NFKC', text or '').lower()
    text = ''.join(c for c in unicodedata.normalize('NFKD', text) if not unicodedata.combining(c))
    text = re.sub(r'\s(&|\+|x)\s', ' and ', text)
    text = re.sub(r"['’`]", '', text)
    return re.sub(r'[^\w]+', ' ', text).strip()


def split_title(title):
    """(base title, tag strings) where tags are bracketed parts and ' - ' suffixes."""
    title = title or ''
    tags = [t.strip() for t in _BRACKET_RE.findall(title) if t.strip()]
    base = _BRACKET_RE.sub(' ', title)
    parts = re.split(r'\s+[-–—]\s+', base)
    base, tags = parts[0], tags + [p.strip() for p in parts[1:] if p.strip()]
    return base.strip(), tags


def tag_version(tag):
    """Version a single tag string announces, or None (features, unknown words)."""
    if _FEAT_RE.match(tag.strip()):
        return None
    for name, rx in _VERSION_RES:
        if rx.search(tag):
            return name
    return None


def classify(title, title_version='', album_title=''):
    """Version type of a track: the first non-original tag wins."""
    _, tags = split_title(title)
    if title_version:
        tags += split_title(f'x ({title_version.strip("() ")})')[1]
    for tag in tags:
        version = tag_version(tag)
        if version and version != 'original':
            return version
    if album_title:
        album_base, album_tags = split_title(album_title)
        if _LIVE_ALBUM_RE.search(album_base) or any(tag_version(t) == 'live' for t in album_tags):
            return 'live'
    return 'original'


def norm_title(title):
    """Comparable base title: no brackets, features or version suffixes."""
    base, _ = split_title(title)
    base = _BARE_FEAT_RE.split(base)[0]
    return fold(base) or fold(title)


def song_norm_key(artist_dz, title, version):
    """Identity candidate key: same artist, same base title, same version."""
    return f'{int(artist_dz)}:{norm_title(title)[:150]}:{version}'


def similarity(a, b):
    a, b = norm_title(a), norm_title(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def album_kind(record_type, title):
    """'album' | 'ep' | 'single' | 'compilation' | 'live' for an album row."""
    if classify('', album_title=title) == 'live':
        return 'live'
    if record_type == 'compile':
        return 'compilation'
    return record_type if record_type in ('album', 'ep', 'single') else 'album'
