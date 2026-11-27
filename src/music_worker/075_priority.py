# Download order (plan 8.4): every queued song has one score; the highest goes
# first.
#
#   score = popularity x reason weight x artist weight x boosts
#
# popularity  the track's Deezer rank (0 to about 1,000,000). A new release has
#             no rank yet, so while it is new it counts as at least the artist's
#             usual hit (median rank of their top 10); a chart song as at least
#             what its chart position is worth.
# reason      why the song is wanted: top 10, essentials or discography.
# artist      the admin artist weight x the genre weight (artist_weight).
# boosts      new release (for music_fresh_days) and current chart song.
#
# Weights, boosts and the new-release window are admin settings (Music tab,
# Priorities). The inputs are kept in the job payload, so a settings or rule
# change re-scores the whole queue without new lookups.

# MusicJob.bucket: why a song is queued, for the admin. P_HOT while a boost runs.
P_HOT, P_TOP10, P_DISCOGRAPHY, P_ESSENTIALS, P_OTHER = 1, 2, 3, 4, 5
# A chart song stays boosted until the day after its last chart appearance.
CHART_HOLD_DAYS = 1
# What a chart position is worth as popularity: #1 1,000,000, #100 500,000.
CHART_TOP_POP = 1_000_000
# Payload scoring format; open jobs queued before it are migrated once.
PRIO_VERSION = '2'
SCORE_FIELDS = ('rank', 'ref', 'chart', 'reason', 'fresh_until', 'chart_until')


def priority_config():
    """The admin's download-order settings."""
    with app.app_context():
        return {
            'chart': get_float_setting('music_boost_chart'),
            'fresh': get_float_setting('music_boost_fresh'),
            'reason': {P_TOP10: get_float_setting('music_weight_top10'),
                       P_ESSENTIALS: get_float_setting('music_weight_essentials'),
                       P_DISCOGRAPHY: get_float_setting('music_weight_discography'),
                       P_OTHER: 1.0},
            'fresh_days': get_numeric_setting('music_fresh_days'),
            'fresh_full_mode': get_setting_value('music_fresh_full_mode'),
            'song_cap': get_numeric_setting('music_artist_song_cap'),
        }


def priority_signature(cfg):
    """Changes when a setting or rule that scores the queue changes."""
    scoring = [cfg['chart'], cfg['fresh'], sorted(cfg['reason'].items())]
    return hashlib.sha256(json.dumps([scoring, rules_signature()]).encode()).hexdigest()[:16]


def job_score(payload, weight, cfg, today):
    """(bucket, score) of one queued song. today: 'YYYY-MM-DD'."""
    fresh = (payload.get('fresh_until') or '') >= today
    chart = (payload.get('chart_until') or '') >= today
    pop = payload.get('rank') or 0
    if fresh:
        pop = max(pop, payload.get('ref') or 0)
    if chart:
        pop = max(pop, payload.get('chart') or 0)
    reason = payload.get('reason') or P_OTHER
    score = max(pop, 1) * cfg['reason'].get(reason, 1.0) * weight
    if fresh:
        score *= cfg['fresh']
    if chart:
        score *= cfg['chart']
    return (P_HOT if fresh or chart else reason), round(score, 3)


def merge_score(payload, fields, cfg):
    """Fold newer scoring inputs into a queued song's payload. Boost windows only
    grow. The reason is replaced by the artist that queued the song ('own') and
    otherwise kept if it already weighs more."""
    for key in ('rank', 'ref', 'chart'):
        if key in fields:
            payload[key] = fields[key]
    for key in ('fresh_until', 'chart_until'):
        if fields.get(key):
            payload[key] = max(payload.get(key) or '', fields[key])
    if 'reason' in fields:
        old = payload.get('reason')
        if fields.get('own') or old is None or cfg['reason'].get(fields['reason'], 1.0) > cfg['reason'].get(old, 1.0):
            payload['reason'] = fields['reason']
    return payload


def chart_pop(position):
    """Popularity a chart position is worth (position 0 = #1)."""
    return CHART_TOP_POP * (1 - min(position, 100) / 200)


def artist_weights():
    """({deezer id: weight}, {blocked deezer ids}) over the whole roster."""
    genre_weights = _genre_weights()
    weights, blocked = {}, set()
    with app.app_context():
        rows = MusicArtist.query.with_entities(MusicArtist.deezer_id, MusicArtist.rule_mode,
                                               MusicArtist.rule_weight, MusicArtist.genres).all()
    for dz_id, rule_mode, rule_weight, genres in rows:
        weight = artist_weight(rule_weight, genres, genre_weights, bool(rule_mode))
        if rule_mode == 'blocked' or weight == 0:
            blocked.add(dz_id)
        weights[dz_id] = weight
    return weights, blocked


def _open_batches(*filters):
    """Open acquire jobs in id order, 2,000 at a time (manual P0 jobs excluded)."""
    last_id = 0
    while True:
        with app.app_context():
            rows = MusicJob.query.with_entities(
                MusicJob.id, MusicJob.state, MusicJob.artist_dz, MusicJob.src_dz, MusicJob.bucket,
                MusicJob.priority, MusicJob.payload, MusicJob.norm_key, MusicJob.created_at,
            ).filter(MusicJob.state.in_(OPEN_STATES), MusicJob.kind == 'acquire', MusicJob.bucket > 0,
                     MusicJob.id > last_id, *filters).order_by(MusicJob.id).limit(2000).all()
        if not rows:
            return
        last_id = rows[-1].id
        yield rows


def _apply(updates, skips):
    """Write score updates [{'id', ...columns}] and skips {job id: code} (ready jobs only)."""
    with app.app_context():
        if updates:
            db.session.bulk_update_mappings(MusicJob, updates)
        for code in set(skips.values()):
            ids = [i for i, c in skips.items() if c == code]
            MusicJob.query.filter(MusicJob.id.in_(ids), MusicJob.state == 'ready').update(
                {MusicJob.state: 'skipped', MusicJob.error_code: code}, synchronize_session=False)
        db.session.commit()


def jobs_rescore(hot_only=False):
    """Re-score open jobs from their payloads: all of them after a settings or
    rule change, the boosted ones when a boost may have run out. Songs of a
    blocked artist are skipped. Returns how many changed."""
    cfg = priority_config()
    weights, blocked = artist_weights()
    today = now().strftime('%Y-%m-%d')
    changed = 0
    for rows in _open_batches(*([MusicJob.bucket == P_HOT] if hot_only else [])):
        updates, skips = [], {}
        for row in rows:
            src = row.src_dz or row.artist_dz
            if row.artist_dz in blocked or src in blocked:
                skips[row.id] = 'blocked'
                continue
            bucket, score = job_score(json.loads(row.payload), weights.get(src, 1.0), cfg, today)
            if bucket != row.bucket or abs(score - row.priority) > 1e-6 * max(score, 1.0):
                updates.append({'id': row.id, 'bucket': bucket, 'priority': score})
        _apply(updates, skips)
        changed += len(updates) + len(skips)
    return changed


def jobs_migrate():
    """Once: open jobs queued before scores get their scoring inputs, src_dz and
    the current identity key. A new-release job whose artist is not on the
    roster came from someone else's album (a label sampler filed under a
    composer, a guest EP) and is skipped."""
    if meta_get('prio_version') == PRIO_VERSION:
        return
    weights, _blocked = artist_weights()
    fresh_days = priority_config()['fresh_days']
    migrated = dropped = 0
    for rows in _open_batches():
        updates, skips = [], {}
        for row in rows:
            payload = json.loads(row.payload)
            if 'reason' in payload:
                continue
            base = row.priority / (weights.get(row.artist_dz) or 1.0)
            if row.bucket == P_HOT and row.artist_dz not in weights:
                skips[row.id] = 'unwanted'
                continue
            if row.bucket == P_HOT and 999_000 <= base <= CHART_TOP_POP:
                # shortcut: old chart jobs stored 1,000,000 - position, not a Deezer rank; the
                # next chart scan (6 h) re-boosts the ones still charting with real numbers.
                payload.update(rank=CHART_TOP_POP // 2, reason=P_OTHER)
            elif row.bucket == P_HOT:
                created = (row.created_at or now()).replace(tzinfo=timezone.utc)
                payload.update(rank=base, reason=P_DISCOGRAPHY,
                               fresh_until=(created + timedelta(days=fresh_days)).strftime('%Y-%m-%d'))
            else:
                payload.update(rank=base, reason=row.bucket if row.bucket in (P_TOP10, P_DISCOGRAPHY, P_ESSENTIALS) else P_OTHER)
            update = {'id': row.id, 'payload': json.dumps(payload), 'src_dz': row.artist_dz}
            if payload.get('title') and payload.get('artist_dz') and payload.get('version'):
                update['norm_key'] = song_norm_key(payload['artist_dz'], payload['title'], payload['version'])
            updates.append(update)
        _apply(updates, skips)
        migrated += len(updates)
        dropped += len(skips)
    meta_set('prio_version', PRIO_VERSION)
    log(f'queue: scores added to {migrated} songs; skipped {dropped} songs from other artists\' albums')
