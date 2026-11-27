# The download queue (MariaDB music_job): one row per wanted song, leased by
# workers, retried on a schedule, never deleted (plan sections 8.4 and 13).

# Retry delays after each failed attempt; afterwards every 30 days, forever.
RETRY_DELAYS = (3600, 6 * 3600, 86400, 7 * 86400, 7 * 86400, 7 * 86400, 7 * 86400)
RETRY_LATER = 30 * 86400
LEASE_SECONDS = 15 * 60
OPEN_STATES = ('ready', 'leased')


def retry_delay(attempts):
    """Seconds before the next try after `attempts` failures."""
    return RETRY_DELAYS[attempts - 1] if attempts <= len(RETRY_DELAYS) else RETRY_LATER


# Skip reasons that end when the song is wanted again (artist unblocked, mode raised).
REVIVABLE = ('blocked', 'unwanted')


def jobs_upsert(rows):
    """Queue wanted songs. rows: dicts with dedupe_key, norm_key, artist_dz,
    src_dz (optional), payload, bucket, priority. A finished key keeps its state;
    an open job takes the new score; a job skipped because it was blocked or no
    longer wanted is queued again. Returns how many were new or revived."""
    if not rows:
        return 0
    with app.app_context():
        existing = {}
        keys = [r['dedupe_key'] for r in rows]
        for start in range(0, len(keys), 500):
            for job in MusicJob.query.filter(MusicJob.dedupe_key.in_(keys[start:start + 500])).all():
                existing[job.dedupe_key] = job
        created = 0
        t = now()
        for row in rows:
            job = existing.get(row['dedupe_key'])
            if job is None:
                job = MusicJob(kind='acquire', dedupe_key=row['dedupe_key'], norm_key=row['norm_key'],
                               artist_dz=row['artist_dz'], src_dz=row.get('src_dz'), payload=json.dumps(row['payload']),
                               bucket=row['bucket'], priority=row['priority'], state='ready',
                               created_at=t, updated_at=t)
                db.session.add(job)
                existing[row['dedupe_key']] = job
                created += 1
                continue
            revive = job.state == 'skipped' and job.error_code in REVIVABLE
            if not revive and job.state not in OPEN_STATES:
                continue
            payload = json.loads(job.payload)
            payload.update({k: row['payload'][k] for k in SCORE_FIELDS if k in row['payload']})
            job.payload, job.bucket, job.priority, job.updated_at = json.dumps(payload), row['bucket'], row['priority'], t
            job.src_dz = row.get('src_dz') or job.src_dz
            if revive:
                job.state, job.error_code, job.run_after = 'ready', None, None
                created += 1
        db.session.commit()
        return created


def jobs_open(artist_ids):
    """{norm_key: [(job id, duration s, src_dz)]} of the open jobs of these artists."""
    found = {}
    ids = [int(a) for a in artist_ids]
    with app.app_context():
        for start in range(0, len(ids), 500):
            for job in MusicJob.query.with_entities(MusicJob.id, MusicJob.norm_key, MusicJob.artist_dz, MusicJob.src_dz,
                                                    MusicJob.payload).filter(
                    MusicJob.artist_dz.in_(ids[start:start + 500]), MusicJob.state.in_(OPEN_STATES)):
                if job.norm_key:
                    duration = json.loads(job.payload).get('duration') or 0
                    found.setdefault(job.norm_key, []).append((job.id, duration, job.src_dz or job.artist_dz))
    return found


def jobs_of_source(src_dz):
    """[(job id, payload)] of the open jobs an artist's scans queued."""
    with app.app_context():
        rows = MusicJob.query.with_entities(MusicJob.id, MusicJob.payload).filter(
            MusicJob.state.in_(OPEN_STATES), MusicJob.bucket > 0,
            db.or_(MusicJob.src_dz == int(src_dz), db.and_(MusicJob.src_dz.is_(None), MusicJob.artist_dz == int(src_dz)))).all()
    return [(r.id, json.loads(r.payload)) for r in rows]


def jobs_refresh(updates, cfg, weights):
    """Re-score open jobs a scan found again. updates: {job id: scoring fields
    (merge_score)}. weights: {deezer id: artist weight}."""
    if not updates:
        return
    today = now().strftime('%Y-%m-%d')
    with app.app_context():
        ids = list(updates)
        for start in range(0, len(ids), 500):
            for job in MusicJob.query.filter(MusicJob.id.in_(ids[start:start + 500]), MusicJob.state.in_(OPEN_STATES)):
                payload = merge_score(json.loads(job.payload), updates[job.id], cfg)
                job.payload = json.dumps(payload)
                job.bucket, job.priority = job_score(payload, weights.get(job.src_dz or job.artist_dz, 1.0), cfg, today)
                job.updated_at = now()
        db.session.commit()


def jobs_skip(job_ids, code):
    """Skip not-yet-leased jobs: 'blocked' or 'unwanted' (queued again when wanted)."""
    if not job_ids:
        return 0
    n = 0
    ids = list(job_ids)
    with app.app_context():
        for start in range(0, len(ids), 500):
            n += MusicJob.query.filter(MusicJob.id.in_(ids[start:start + 500]), MusicJob.state == 'ready').update(
                {MusicJob.state: 'skipped', MusicJob.error_code: code}, synchronize_session=False)
        db.session.commit()
    return n


def jobs_lease(limit=1):
    """Lease up to `limit` ready acquire jobs, highest score first."""
    with app.app_context():
        t = now()
        query = MusicJob.query.filter(
            MusicJob.state == 'ready', MusicJob.kind == 'acquire',
            db.or_(MusicJob.run_after.is_(None), MusicJob.run_after <= t),
        ).order_by(MusicJob.priority.desc(), MusicJob.id.desc()).limit(limit)  # id desc: ix_music_job_lease serves the order
        if db.engine.dialect.name in ('mysql', 'mariadb'):
            query = query.with_for_update(skip_locked=True)
        leased = []
        for job in query.all():
            job.state = 'leased'
            job.lease_owner = WORKER_ID
            job.lease_expires = t + timedelta(seconds=LEASE_SECONDS)
            job.updated_at = t
            leased.append({'id': job.id, 'bucket': job.bucket, 'attempts': job.attempts,
                           'payload': json.loads(job.payload)})
        db.session.commit()
        return leased


def _job_update(job_id, **fields):
    with app.app_context():
        job = db.session.get(MusicJob, job_id)
        if job is None:
            return None
        for key, value in fields.items():
            setattr(job, key, value)
        job.lease_owner = None
        job.lease_expires = None
        job.updated_at = now()
        db.session.commit()
        return job


def job_finish(job_id, state, song_id=None, code=None, detail=None):
    """Close a job: done (published), duplicate (already held) or skipped."""
    _job_update(job_id, state=state, song_id=song_id, error_code=code, error_detail=detail)


def job_retry(job_id, attempts, code, detail='', payload=None):
    """Failed attempt: back to ready after the retry delay."""
    fields = dict(state='ready', attempts=attempts + 1, error_code=code, error_detail=str(detail)[:500],
                  run_after=now() + timedelta(seconds=retry_delay(attempts + 1)))
    if payload is not None:
        fields['payload'] = json.dumps(payload)
    _job_update(job_id, **fields)


def job_park(job_id, until_ts, code='rate_limited'):
    """A source is backing off: back to ready after it, without counting an attempt."""
    # Long waits get jitter so parked jobs do not all wake at once.
    jitter = random.randint(0, 120) if until_ts - time.time() > 60 else 0
    _job_update(job_id, state='ready', error_code=code,
                run_after=datetime.fromtimestamp(until_ts, timezone.utc) + timedelta(seconds=jitter))


def jobs_reap():
    """Return leases that outlived their holder."""
    with app.app_context():
        n = MusicJob.query.filter(MusicJob.state == 'leased', MusicJob.lease_expires < now()).update(
            {MusicJob.state: 'ready', MusicJob.error_code: 'lease_expired',
             MusicJob.lease_owner: None, MusicJob.lease_expires: None}, synchronize_session=False)
        db.session.commit()
        return n


def jobs_release_mine():
    with app.app_context():
        MusicJob.query.filter(MusicJob.state == 'leased', MusicJob.lease_owner == WORKER_ID).update(
            {MusicJob.state: 'ready', MusicJob.lease_owner: None, MusicJob.lease_expires: None},
            synchronize_session=False)
        db.session.commit()


def jobs_summary():
    with app.app_context():
        by_state = dict(db.session.query(MusicJob.state, db.func.count()).group_by(MusicJob.state).all())
        by_bucket = dict(db.session.query(MusicJob.bucket, db.func.count()).filter(
            MusicJob.state.in_(OPEN_STATES)).group_by(MusicJob.bucket).all())
        errors = dict(db.session.query(MusicJob.error_code, db.func.count()).filter(
            MusicJob.state.in_(OPEN_STATES), MusicJob.error_code.isnot(None)).group_by(MusicJob.error_code).all())
        return {'states': by_state, 'open_by_bucket': by_bucket, 'open_errors': errors}
