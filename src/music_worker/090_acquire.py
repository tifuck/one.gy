# Acquisition (plan section 11): song card -> identity check -> YouTube Music
# match -> audio-only download -> verification gates -> art, lyrics, genres ->
# publish. A song is published only after every gate passes.

ALBUM_MATCH_MIN = 0.85
ALBUM_MATCH_LEAD = 0.10
ALBUM_MATCH_RETRY = timedelta(days=7)
ATV, OMV = 'MUSIC_VIDEO_TYPE_ATV', 'MUSIC_VIDEO_TYPE_OMV'


def build_card(payload):
    """Deezer track + album, the song's version and identity key."""
    track = dz_track(payload['track_id'])
    if not track or not track.get('id'):
        raise AcquireError('no_card', 'track is no longer on Deezer')
    if not track.get('isrc'):
        raise AcquireError('no_card', 'track has no ISRC')
    album = dz_album(track['album']['id'])
    if not album:
        raise AcquireError('no_card', 'album is no longer on Deezer')
    main = track['artist']
    artists = [(int(main['id']), main['name'], 'primary')]
    for contributor in track.get('contributors') or []:
        if int(contributor['id']) != int(main['id']):
            role = 'primary' if contributor.get('role') == 'Main' else 'featured'
            artists.append((int(contributor['id']), contributor['name'], role))
    card = dict(track)
    card['isrc'] = track['isrc'].upper()
    card['version'] = classify(track['title'], track.get('title_version', ''), album.get('title', ''))
    card['norm_key'] = song_norm_key(main['id'], track['title'], card['version'])
    card['artists'] = artists
    return card, album


def _versions_match(title, version):
    return classify(title) == version


def _score_album(hit, full, album):
    """Album alignment score (plan 11.2)."""
    dz_tracks = (album.get('tracks') or {}).get('data') or []
    yt_tracks = full.get('tracks') or []
    artist = fold((album.get('artist') or {}).get('name'))
    # Full titles, edition words included: "(Drumless Edition)" must not tie with the original.
    score = 0.30 * SequenceMatcher(None, fold(hit.get('title') or full.get('title', '')), fold(album['title'])).ratio()
    if any(fold(a.get('name')) == artist for a in (full.get('artists') or hit.get('artists') or [])):
        score += 0.20
    if dz_tracks and len(yt_tracks) == len(dz_tracks):
        score += 0.15
    if dz_tracks:
        close = sum(1 for d, y in zip(dz_tracks, yt_tracks)
                    if abs((y.get('duration_seconds') or 0) - (d.get('duration') or 0)) <= DURATION_TOLERANCE_S)
        score += 0.25 * close / len(dz_tracks)
    try:
        if abs(int(full.get('year') or hit.get('year')) - int((album.get('release_date') or '')[:4])) <= 1:
            score += 0.10
    except (TypeError, ValueError):
        pass
    return score


def album_alignment(album):
    """[{videoId, videoType, title, duration}] by Deezer track position, and the
    alignment score; cached per album. Empty list when no album matched."""
    with app.app_context():
        cached = db.session.get(MusicAlbumMatch, int(album['id']))
        if cached and (cached.ytm_browse_id or (now() - cached.matched_at.replace(tzinfo=timezone.utc)) < ALBUM_MATCH_RETRY):
            return json.loads(cached.tracks_json or '[]'), cached.score
    artist = (album.get('artist') or {}).get('name', '')
    hits = [h for h in ytm_search_albums(f'{artist} {split_title(album["title"])[0]}') if h.get('browseId')]
    hits.sort(key=lambda h: similarity(h.get('title', ''), album['title']), reverse=True)
    scored = []
    for hit in hits[:3]:
        full = ytm_get_album(hit['browseId'])
        scored.append((_score_album(hit, full, album), hit['browseId'], full))
    scored.sort(key=lambda s: s[0], reverse=True)
    mapping, best_score, browse_id = [], 0.0, None
    if scored:
        lead = scored[0][0] - (scored[1][0] if len(scored) > 1 else 0.0)
        if scored[0][0] >= ALBUM_MATCH_MIN and lead >= ALBUM_MATCH_LEAD:
            best_score, browse_id, full = scored[0]
            mapping = [{'videoId': t.get('videoId'), 'videoType': t.get('videoType'), 'title': t.get('title'),
                        'duration': t.get('duration_seconds') or 0} for t in full.get('tracks') or []]
    with app.app_context():
        row = db.session.get(MusicAlbumMatch, int(album['id'])) or MusicAlbumMatch(deezer_album_id=int(album['id']))
        row.ytm_browse_id, row.score, row.tracks_json, row.matched_at = browse_id, best_score, json.dumps(mapping), now()
        db.session.merge(row)
        db.session.commit()
    return mapping, best_score


def find_candidate(card, album, deny):
    """(video_id, confidence, strict) for the card's audio, else AcquireError.
    strict: a music-video stream, which must match the duration within 1 s."""
    duration = card['duration']
    mapping, album_score = album_alignment(album)
    positions = [t.get('id') for t in (album.get('tracks') or {}).get('data') or []]
    if mapping and card['id'] in positions:
        pos = positions.index(card['id'])
        if pos < len(mapping):
            hit = mapping[pos]
            if hit['videoId'] and similarity(hit['title'], card['title']) >= 0.85 \
                    and abs(hit['duration'] - duration) <= DURATION_TOLERANCE_S \
                    and _versions_match(hit['title'], card['version']):
                if hit['videoType'] == ATV and hit['videoId'] not in deny:
                    return hit['videoId'], album_score, False
                if hit['videoType'] == OMV:
                    twin = ytm_counterpart(hit['videoId'])
                    if twin and twin['videoId'] not in deny \
                            and abs((twin.get('duration_seconds') or duration) - duration) <= DURATION_TOLERANCE_S:
                        return twin['videoId'], album_score, False
    main_artist = fold(card['artist']['name'])
    for hit in ytm_search_songs(f'{card["artist"]["name"]} {card.get("title_short") or card["title"]}'):
        if hit.get('videoType') != ATV or not hit.get('videoId') or hit['videoId'] in deny:
            continue
        if not any(fold(a.get('name')) == main_artist for a in hit.get('artists') or []):
            continue
        if similarity(hit.get('title', ''), card['title']) < 0.9 \
                or abs((hit.get('duration_seconds') or 0) - duration) > DURATION_TOLERANCE_S \
                or not _versions_match(hit.get('title', ''), card['version']):
            continue
        if 'isExplicit' in hit and bool(hit['isExplicit']) != bool(card.get('explicit_lyrics')):
            continue
        return hit['videoId'], 0.9, False
    # Last resort: the album's music-video stream, held to a 1 s duration match.
    if mapping and card['id'] in positions and positions.index(card['id']) < len(mapping):
        hit = mapping[positions.index(card['id'])]
        if hit['videoType'] == OMV and hit['videoId'] not in deny \
                and abs(hit['duration'] - duration) <= 1 and _versions_match(hit['title'], card['version']):
            return hit['videoId'], album_score, True
    raise AcquireError('no_ytm_track', f'{card["artist"]["name"]} - {card["title"]}')


def _probe(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                             'stream=codec_type,codec_name:format=duration,bit_rate', '-of', 'json', path],
                            capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise AcquireError('decode_failed', result.stderr[-300:])
    return json.loads(result.stdout)


def download_and_verify(card, video_id, preview_fp, confidence, strict):
    """Download one audio-only stream and run the gates (plan 11.5). Returns the
    audio dict for lib_publish; the file sits in a private folder under tmp/."""
    work = tempfile.mkdtemp(dir=TMP_DIR)
    try:
        path = ytdlp_download(video_id, work)
        probe = _probe(path)
        streams = probe.get('streams') or []
        audio_streams = [s for s in streams if s.get('codec_type') == 'audio']
        if len(audio_streams) != 1 or any(s.get('codec_type') == 'video' for s in streams):
            raise AcquireError('upload_rejected', f'streams: {[s.get("codec_type") for s in streams]}')
        codec = audio_streams[0].get('codec_name')
        if codec not in ('opus', 'aac'):
            raise AcquireError('upload_rejected', f'codec {codec}')
        duration = float((probe.get('format') or {}).get('duration') or 0)
        # +1 s: Deezer rounds durations down to whole seconds, the file is exact.
        if abs(duration - card['duration']) > (1 if strict else DURATION_TOLERANCE_S) + 1:
            raise AcquireError('duration_mismatch', f'{duration:.1f}s vs {card["duration"]}s')
        full_fp = fingerprint(path)
        ber = None
        if preview_fp is not None:
            ber = best_ber(preview_fp, full_fp)
            if FP_MATCH_BER <= ber <= FP_REJECT_BER:
                second = preview_fingerprint(itunes_preview_url(card['artist']['name'], card['title'], card['duration']))
                if second is not None:
                    ber = min(ber, best_ber(second, full_fp))
            if ber >= FP_MATCH_BER:
                raise AcquireError('fp_mismatch', f'{video_id} BER {ber:.3f}')
        elif confidence < 0.9:
            raise AcquireError('no_preview', 'no store preview and no strong album match')
        ext = 'opus' if codec == 'opus' else 'm4a'
        out = os.path.join(work, f'audio.{ext}')
        remux = ['ffmpeg', '-v', 'error', '-y', '-i', path, '-map', '0:a:0', '-c', 'copy', '-map_metadata', '-1']
        if ext == 'm4a':
            remux += ['-movflags', '+faststart']
        result = subprocess.run(remux + [out], capture_output=True, text=True, timeout=300)
        if result.returncode:
            raise AcquireError('decode_failed', result.stderr[-300:])
        digest = hashlib.sha256()
        with open(out, 'rb') as fp:
            for chunk in iter(lambda: fp.read(1 << 20), b''):
                digest.update(chunk)
        size = os.path.getsize(out)
        return {'path': out, 'work': work, 'ext': ext, 'codec': codec, 'size': size,
                'bitrate': int(float((probe.get('format') or {}).get('bit_rate') or 0)) or int(size * 8 / max(duration, 1)),
                'duration_ms': int(duration * 1000), 'sha256': digest.hexdigest(), 'video_id': video_id,
                'fp_ber': ber, 'confidence': round(confidence * (1 - (ber or 0)), 3)}
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise


def _jpeg(data, size):
    """Re-encode an image as a JPEG no larger than size x size."""
    from io import BytesIO
    from PIL import Image
    with Image.open(BytesIO(data)) as img:
        img = img.convert('RGB')
        img.thumbnail((size, size))
        out = BytesIO()
        img.save(out, 'JPEG', quality=90)
        return out.getvalue()


def _image(urls):
    for source, url in urls:
        if not url:
            continue
        try:
            return _jpeg(fetch_bytes(source, url), 1200)
        except (SourceError, OSError, ValueError):
            continue
    return None


def gather_extras(card, album):
    """Album art, artist images, lyrics and genres (plan section 12)."""
    cover = None
    if not lib_has_cover(album['id']):
        try:
            itunes = itunes_cover_url(album.get('upc'))
        except SourceError:
            itunes = None
        cover = _image([('itunes', itunes), ('deezer', album.get('cover_xl'))])
    artist_images = {}
    for dz_id, _name, _role in card['artists']:
        if not lib_has_artist_image(dz_id):
            info = dz_artist(dz_id) or {}
            image = _image([('deezer', info.get('picture_xl'))])
            if image:
                artist_images[dz_id] = image
    lyrics = None
    try:
        found = lrclib_lyrics(card['artist']['name'], card.get('title_short') or card['title'],
                              album.get('title', ''), card['duration'])
        if found and not found[2] and (found[0] or found[1]):
            lyrics = (found[0], found[1])
    except SourceError:
        pass
    genres = [g['name'] for g in (album.get('genres') or {}).get('data') or []]
    return {'cover': cover, 'artist_images': artist_images, 'lyrics': lyrics, 'genres': genres}


def acquire(job):
    """Run one leased acquire job to an end state, a retry or a park."""
    payload = job['payload']
    deny = set(payload.get('deny') or [])
    video_id = None
    audio = None
    try:
        set_activity('Preparing the next song')
        card, album = build_card(payload)
        set_activity(f'Downloading {card["artist"]["name"]} – {card["title"]}')
        if payload.get('version') in ORIGINAL_VERSIONS and card['version'] not in ORIGINAL_VERSIONS:
            job_finish(job['id'], 'skipped', code='version_mismatch', detail=f'card says {card["version"]}')
            return
        preview_fp = preview_fingerprint(card.get('preview'))
        state, song_id = resolve(card, preview_fp)
        if state != 'new':
            job_finish(job['id'], 'duplicate', song_id=song_id, code=state)
            return
        video_id, confidence, strict = find_candidate(card, album, deny)
        audio = download_and_verify(card, video_id, preview_fp, confidence, strict)
        extras = gather_extras(card, album)
        song_id = lib_publish(card, album, audio, extras)
        job_finish(job['id'], 'done', song_id=song_id)
        ber = f'{audio["fp_ber"]:.3f}' if audio['fp_ber'] is not None else 'n/a'
        log(f'added {card["artist"]["name"]} - {card["title"]} (P{job["bucket"]}, {audio["codec"]} '
            f'{audio["bitrate"] // 1000} kbps, BER {ber})')
    except SourcePaused as e:
        job_park(job['id'], resume_at(e))
    except Duplicate as e:
        job_finish(job['id'], 'duplicate', song_id=e.song_id, code='have')
    except AcquireError as e:
        if e.code in ('fp_mismatch', 'duration_mismatch', 'upload_rejected') and video_id:
            payload['deny'] = sorted(deny | {video_id})
        job_retry(job['id'], job['attempts'], e.code, e.detail, payload)
    except SourceError as e:
        job_retry(job['id'], job['attempts'], 'source_error', str(e))
    except Exception as e:
        import traceback
        log(f'job {job["id"]} crashed: {traceback.format_exc(limit=5)}')
        job_retry(job['id'], job['attempts'], 'internal', repr(e))
    finally:
        if audio:
            shutil.rmtree(audio['work'], ignore_errors=True)
