# =============================================================================
# MONITORING: storage replication, durability, background jobs and backups
# =============================================================================
# One collector (_monitor_state) feeds three consumers:
#   * /metrics            Prometheus text format (needs METRICS_TOKEN)
#   * /admin/api/monitoring  the admin console's Monitoring tab
#   * capture_system_metrics_snapshot()  5-minute history rows
# Issues are derived from the same state in one place (_monitor_issues), so the
# admin banner, /metrics (onegy_issue) and monitor_check.py alert on the same rules.

METRICS_TOKEN = (os.environ.get('METRICS_TOKEN', '') or '').strip()
MONITOR_STATE_TTL_SECONDS = 15
MONITOR_HISTORY_POINTS = 240
MONITOR_RANGES = {'24h': timedelta(hours=24), '7d': timedelta(days=7), '30d': timedelta(days=30)}
MONITOR_BACKUP_WINDOW = timedelta(days=30)
MONITOR_NODE_SNAPSHOT_RETENTION = timedelta(days=45)
MONITOR_BACKUP_RUN_RETENTION = timedelta(days=400)
MONITOR_EVENT_LIMIT = 30   # resolved issues listed per history request
# Issue thresholds. Backups run every 6h (db) and daily (full) from cron.
MONITOR_HEARTBEAT_STALE_SECONDS = 120
MONITOR_DB_BACKUP_MAX_AGE = 13 * 3600
MONITOR_FULL_BACKUP_MAX_AGE = 50 * 3600
MONITOR_DISK_WARN_PERCENT = 90
_MONITOR_KINDS = ('file', 'note', 'thumbnail')
_monitor_cache = {'at': 0.0, 'state': None}
_monitor_cache_lock = threading.Lock()


def _epoch(dt):
    dt = _utc_aware(dt) if dt is not None else None
    return int(dt.timestamp()) if dt else 0


def _replica_models():
    return ((FileReplica, 'file'), (NoteReplica, 'note'), (ThumbnailReplica, 'thumbnail'))


def _collect_node_replica_stats(nodes, enabled_ids, now):
    """Per-node replica counts, bytes, verification and verification-age
    buckets: a fixed handful of GROUP BY queries whatever the node count."""
    retries = storage.MAX_ERROR_RETRIES
    for model, kind in _replica_models():
        if not enabled_ids:
            break
        on_enabled = model.node_id.in_(enabled_ids)
        has_size = hasattr(model, 'size_bytes')
        cols = [model.node_id, model.status, db.func.count()]
        if has_size:
            cols.append(db.func.coalesce(db.func.sum(model.size_bytes), 0))
        for row in db.session.query(*cols).filter(on_enabled).group_by(model.node_id, model.status).all():
            n = nodes.get(row[0])
            if not n:
                continue
            state = row[1] or 'unknown'
            n['replicas'][kind][state] = n['replicas'][kind].get(state, 0) + int(row[2])
            if has_size and state == 'synced':
                n['synced_bytes'] += int(row[3] or 0)
        # Unconfirmed copies split by whether the node ever reported a hash:
        # without one (e.g. an S3 object stored without ChecksumSHA256) only a
        # deep verify can confirm it; with one the scrub confirms it in its window.
        no_hash = model.checksum.is_(None)
        for nid, hashless, count in db.session.query(model.node_id, no_hash, db.func.count()).filter(
            on_enabled, model.status == 'synced',
            db.or_(no_hash, model.checksum_verified.isnot(True)),
        ).group_by(model.node_id, no_hash).all():
            nodes[nid]['unverified'][kind] += int(count)
            if hashless:
                nodes[nid]['no_hash'][kind] += int(count)
        for nid, count in db.session.query(model.node_id, db.func.count()).filter(
            on_enabled, model.status == 'error', model.error_count >= retries,
        ).group_by(model.node_id).all():
            nodes[nid]['parked'][kind] = int(count)
        age = db.case(
            (model.verified_at.is_(None), 'never'),
            (model.verified_at >= now - timedelta(days=1), 'd1'),
            (model.verified_at >= now - timedelta(days=7), 'd7'),
            (model.verified_at >= now - timedelta(days=30), 'd30'),
            else_='older',
        )
        for nid, bucket, count, oldest in db.session.query(
            model.node_id, age, db.func.count(), db.func.min(model.verified_at),
        ).filter(on_enabled, model.status == 'synced').group_by(model.node_id, age).all():
            n = nodes[nid]
            n['verify_age'][bucket] = n['verify_age'].get(bucket, 0) + int(count)
            ts = _epoch(oldest)
            if ts and (not n['oldest_verified'] or ts < n['oldest_verified']):
                n['oldest_verified'] = ts


def _collect_backup_state():
    out = {}
    for kind in ('db', 'full'):
        last = BackupRun.query.filter_by(kind=kind).order_by(BackupRun.started_at.desc()).first()
        last_ok = BackupRun.query.filter_by(kind=kind, status='ok').order_by(BackupRun.started_at.desc()).first()
        out[kind] = {'last': _backup_run_dict(last) if last else None,
                     'last_ok': _backup_run_dict(last_ok) if last_ok else None}
    return out


def _backup_run_dict(run):
    started, finished = _epoch(run.started_at), _epoch(run.finished_at)
    return {'kind': run.kind, 'status': run.status, 'started': started, 'finished': finished,
            'duration': max(0, finished - started) if finished else None,
            'bytes': int(run.archive_bytes or 0), 'offsite_ok': run.offsite_ok,
            'error': run.error}


def _build_monitor_state():
    now = datetime.now(timezone.utc)
    state = {'at': int(now.timestamp())}
    all_nodes = StorageNode.query.order_by(StorageNode.id).all()
    enabled_ids = [n.id for n in all_nodes if n.is_enabled]
    nodes = {}
    for n in all_nodes:
        nodes[n.id] = {
            'id': n.id, 'name': n.name, 'type': n.node_type, 'enabled': bool(n.is_enabled),
            'primary': bool(n.is_primary), 'status': n.status or 'unknown',
            'up': n.status in ('online', 'syncing'),
            'checksum': None if n.checksum_capable is None else bool(n.checksum_capable),
            'failures': int(n.consecutive_failures or 0), 'last_seen': _epoch(n.last_seen_at),
            'replicas': {k: {} for k in _MONITOR_KINDS}, 'synced_bytes': 0,
            'unverified': {k: 0 for k in _MONITOR_KINDS}, 'no_hash': {k: 0 for k in _MONITOR_KINDS},
            'parked': {k: 0 for k in _MONITOR_KINDS},
            'verify_age': {}, 'oldest_verified': 0,
        }
    _collect_node_replica_stats(nodes, enabled_ids, now)
    for n in nodes.values():
        reps = n['replicas']
        n['synced'] = sum(r.get('synced', 0) for r in reps.values())
        n['pending'] = sum(r.get('pending', 0) + r.get('syncing', 0) for r in reps.values())
        n['errors'] = sum(r.get('error', 0) for r in reps.values())
        n['missing'] = sum(r.get('missing', 0) for r in reps.values())
        replicable = n['synced'] + n['pending'] + n['errors'] + n['missing']
        n['coverage'] = round(100.0 * n['synced'] / replicable, 2) if replicable else 100.0
    state['nodes'] = list(nodes.values())

    enabled = [n for n in state['nodes'] if n['enabled']]
    state['backlog'] = {k: sum(n['replicas'][k].get('pending', 0) + n['replicas'][k].get('syncing', 0) for n in enabled)
                        for k in _MONITOR_KINDS}
    state['parked'] = sum(sum(n['parked'].values()) for n in enabled)
    state['unverified'] = sum(sum(n['unverified'].values()) for n in enabled)
    state['unverified_no_hash'] = sum(sum(n['no_hash'].values()) for n in enabled)
    state['missing'] = sum(n['missing'] for n in enabled)
    state['errors'] = sum(n['errors'] for n in enabled)

    # Fresh, not the storage manager's 5-minute cache: this state is itself
    # cached for MONITOR_STATE_TTL_SECONDS and the admin page polls it live.
    snap = storage._single_copy_snapshot(force=True)
    state['multi_node'] = bool(snap.get('multi_node'))
    state['payloads'] = {'file': File.query.count(), 'note': Note.query.count()}
    state['single_copy'] = {k: int(snap.get(f'single_copy_{k}s', 0) or 0) for k in _MONITOR_KINDS}
    state['zero_copy'] = {k: int(snap.get(f'zero_copy_{k}s', 0) or 0) for k in ('file', 'note')}
    state['aged_single_copy'] = {k: int(snap.get(f'aged_single_copy_{k}s', 0) or 0) for k in ('file', 'note')}
    state['single_copy_grace'] = int(snap.get('single_copy_alert_after_seconds', 0) or 0)

    state['remote_deletes'] = {
        'queued': PendingRemoteDelete.query.count(),
        'stalled': PendingRemoteDelete.query.filter(
            PendingRemoteDelete.retry_count >= storage.DEFERRED_DELETE_WARN_RETRIES).count(),
        'oldest': _epoch(db.session.query(db.func.min(PendingRemoteDelete.created_at)).scalar()),
    }

    lease = db.session.get(AppSetting, _SCHEDULER_LEASE_KEY)
    try:
        heartbeat = int(float(lease.value.rsplit(':', 1)[1])) if lease and lease.value else 0
    except Exception:
        heartbeat = 0
    state['jobs'] = {
        'scheduler': {'last': heartbeat, 'interval': SCHEDULER_HEARTBEAT_INTERVAL},
        'health_check': {'last': int(_load_job_timestamp('last_health_check_at')),
                         'interval': int(get_numeric_setting('health_check_interval') or 0)},
        'integrity_scrub': {'last': int(_load_job_timestamp('last_integrity_scrub_at')),
                            'interval': int(get_numeric_setting('integrity_scrub_interval') or 0)},
    }
    state['backups'] = _collect_backup_state()
    try:
        disk = shutil.disk_usage(app.config['UPLOAD_FOLDER'])
        state['disk'] = {'total': int(disk.total), 'free': int(disk.free)}
    except OSError:
        state['disk'] = None
    state['issues'] = _monitor_issues(state)
    opened = {(e.code, e.subject): _epoch(e.opened_at)
              for e in MonitorIssueEvent.query.filter(MonitorIssueEvent.resolved_at.is_(None)).all()}
    for issue in state['issues']:
        issue['since'] = opened.get((issue['code'], issue['subject']), 0)
    return state


def _monitor_state(max_age=MONITOR_STATE_TTL_SECONDS):
    """Cached state; one rebuild at a time per worker (others wait briefly)."""
    with _monitor_cache_lock:
        cached = _monitor_cache['state']
        if cached is not None and time.monotonic() - _monitor_cache['at'] < max_age:
            return cached
        state = _build_monitor_state()
        _monitor_cache['state'] = state
        _monitor_cache['at'] = time.monotonic()
        return state


def _plural(n, word, many=None):
    return f'{n:,} {word if n == 1 else many or word + "s"}'


def _monitor_issues(state):
    """Problems worth a human's attention, worst first. Codes are stable:
    monitor_check.py alerts on changes to the (code, subject) set."""
    now = state['at']
    issues = []

    def add(severity, code, summary, subject=''):
        issues.append({'severity': severity, 'code': code, 'summary': summary, 'subject': subject})

    zero = state['zero_copy']
    if zero['file'] or zero['note']:
        parts = [_plural(zero[k], k) for k in ('file', 'note') if zero[k]]
        add('critical', 'zero_copy', f'{" and ".join(parts)} {"has" if sum(zero.values()) == 1 else "have"} '
            'no synced copy on any enabled node')
    aged = state['aged_single_copy']
    if aged['file'] or aged['note']:
        add('critical', 'aged_single_copy', f'{_plural(aged["file"] + aged["note"], "payload")} have had only one copy '
            f'for longer than {state["single_copy_grace"] // 60} min')
    for n in state['nodes']:
        if n['enabled'] and not n['up']:
            add('critical', 'node_down', f'{n["name"]} is {n["status"]}', n['name'])
    hb = state['jobs']['scheduler']['last']
    if not hb or now - hb > MONITOR_HEARTBEAT_STALE_SECONDS:
        add('critical', 'scheduler_stalled', 'Scheduler heartbeat is stale: replication, scrub and deletes have stopped')
    for kind, limit, label in (('db', MONITOR_DB_BACKUP_MAX_AGE, 'DB'), ('full', MONITOR_FULL_BACKUP_MAX_AGE, 'Full')):
        b = state['backups'][kind]
        if b['last'] and b['last']['status'] != 'ok':
            add('critical', 'backup_failed', f'Last {label} backup failed: {b["last"]["error"] or "unknown error"}', kind)
        elif b['last'] and b['last']['offsite_ok'] is False:
            add('warning', 'backup_offsite_failed', f'Last {label} backup did not reach every remote node', kind)
        if b['last_ok'] and now - b['last_ok']['finished'] > limit:
            add('critical', 'backup_stale', f'No successful {label} backup for {(now - b["last_ok"]["finished"]) // 3600} h', kind)
        elif not b['last']:
            add('info', 'backup_unrecorded', f'No {label} backup run recorded yet', kind)
    for n in state['nodes']:
        if n['enabled'] and n.get('missing'):
            add('warning', 'missing_replicas', f'{n["name"]} is missing {_plural(n["missing"], "copy", "copies")} and has no source to re-copy from', n['name'])
        if n['enabled'] and n.get('verify_age', {}).get('older'):
            add('warning', 'scrub_behind', f'{_plural(n["verify_age"]["older"], "copy", "copies")} on {n["name"]} not checked for over 30 days', n['name'])
    if state['parked']:
        add('warning', 'parked_replicas', f'{_plural(state["parked"], "replica")} stopped retrying and need an admin retry')
    if state['remote_deletes']['stalled']:
        add('warning', 'remote_delete_stalled', f'{_plural(state["remote_deletes"]["stalled"], "remote delete")} keep failing')
    for job, label in (('health_check', 'Health check'), ('integrity_scrub', 'Integrity scrub')):
        j = state['jobs'][job]
        if j['interval'] > 0 and (not j['last'] or now - j['last'] > 3 * j['interval'] + 120):
            add('warning', 'job_overdue', f'{label} has not run for {(now - j["last"]) // 60 if j["last"] else "?"} min', job)
    disk = state['disk']
    if disk and disk['total'] and 100 * (disk['total'] - disk['free']) / disk['total'] >= MONITOR_DISK_WARN_PERCENT:
        add('warning', 'disk_full', f'Local disk is {round(100 * (disk["total"] - disk["free"]) / disk["total"])}% full')
    for n in state['nodes']:
        if n['enabled'] and n['checksum'] is False:
            add('info', 'size_only_node', f'{n["name"]} can only verify sizes, not SHA-256', n['name'])
    order = {'critical': 0, 'warning': 1, 'info': 2}
    issues.sort(key=lambda i: order[i['severity']])
    return issues


# ---- Prometheus /metrics ----------------------------------------------------

_METRIC_HELP = {
    'onegy_storage_node_info': 'Storage node labels (always 1)',
    'onegy_storage_node_up': '1 when the node status is online or syncing',
    'onegy_storage_node_enabled': '1 when the node takes part in replication',
    'onegy_storage_node_checksum_capable': '1 full SHA-256 verify, 0 size-only, -1 unknown',
    'onegy_storage_node_consecutive_failures': 'Consecutive failed health probes',
    'onegy_storage_node_last_seen_timestamp_seconds': 'Last successful health probe',
    'onegy_replicas': 'Replica rows on enabled nodes by kind and state',
    'onegy_replica_bytes': 'Bytes of synced file and thumbnail replicas',
    'onegy_replicas_unverified': 'Synced replicas not hash-confirmed on the node',
    'onegy_replicas_no_hash': 'Unverified synced replicas whose node never reported a hash',
    'onegy_replicas_exhausted_errors': 'Errored replicas past the retry limit (parked)',
    'onegy_replica_oldest_verified_timestamp_seconds': 'Oldest verified_at among synced replicas',
    'onegy_payloads': 'Payload objects in the DB by kind',
    'onegy_payloads_single_copy': 'Payloads with exactly one synced copy',
    'onegy_payloads_aged_single_copy': 'Single-copy payloads older than the alert grace window',
    'onegy_payloads_zero_copy': 'Payloads with no synced copy on any enabled node',
    'onegy_remote_delete_queue': 'Deferred remote deletes waiting',
    'onegy_remote_delete_stalled': 'Deferred remote deletes past the warning retry count',
    'onegy_remote_delete_oldest_timestamp_seconds': 'Creation time of the oldest deferred delete',
    'onegy_job_last_run_timestamp_seconds': 'Last start of a scheduled storage job',
    'onegy_scheduler_heartbeat_timestamp_seconds': 'Last scheduler lease heartbeat',
    'onegy_backup_latest_timestamp_seconds': 'Finish time of the latest successful backup',
    'onegy_backup_latest_bytes': 'Archive size of the latest successful backup',
    'onegy_backup_last_run_ok': '1 when the most recent backup run succeeded',
    'onegy_backup_last_run_offsite_ok': '1 offsite copy verified, 0 failed, -1 local only',
    'onegy_backup_last_run_duration_seconds': 'Duration of the most recent backup run',
    'onegy_local_disk_bytes': 'Local upload disk size and free space',
    'onegy_issue': 'Open monitoring issue (always 1)',
    'onegy_issues': 'Open monitoring issues by severity',
    'onegy_metrics_collect_seconds': 'Time spent building the monitoring state',
}


def _metric_label_value(value):
    return str(value).replace('\\', '\\\\').replace('\n', '\\n').replace('"', '\\"')


def build_metrics_text(state):
    samples = {}

    def add(name, value, labels=None):
        label_text = ''
        if labels:
            label_text = '{' + ','.join(f'{k}="{_metric_label_value(v)}"' for k, v in labels.items()) + '}'
        samples.setdefault(name, []).append(f'{name}{label_text} {value}')

    for n in state['nodes']:
        labels = {'node': n['name'], 'type': n['type']}
        add('onegy_storage_node_info', 1, dict(labels, node_id=n['id'], status=n['status'],
                                               primary='1' if n['primary'] else '0'))
        add('onegy_storage_node_up', int(n['up']), labels)
        add('onegy_storage_node_enabled', int(n['enabled']), labels)
        add('onegy_storage_node_checksum_capable', -1 if n['checksum'] is None else int(n['checksum']), labels)
        add('onegy_storage_node_consecutive_failures', n['failures'], labels)
        add('onegy_storage_node_last_seen_timestamp_seconds', n['last_seen'], labels)
        if not n['enabled']:
            continue
        for kind in _MONITOR_KINDS:
            kl = dict(labels, kind=kind)
            for st, count in n['replicas'][kind].items():
                add('onegy_replicas', count, dict(kl, state=st))
            add('onegy_replicas_unverified', n['unverified'][kind], kl)
            add('onegy_replicas_no_hash', n['no_hash'][kind], kl)
            add('onegy_replicas_exhausted_errors', n['parked'][kind], kl)
        add('onegy_replica_bytes', n['synced_bytes'], labels)
        if n['oldest_verified']:
            add('onegy_replica_oldest_verified_timestamp_seconds', n['oldest_verified'], labels)

    for kind, count in state['payloads'].items():
        add('onegy_payloads', count, {'kind': kind})
    for kind in _MONITOR_KINDS:
        add('onegy_payloads_single_copy', state['single_copy'][kind], {'kind': kind})
    for kind in ('file', 'note'):
        add('onegy_payloads_aged_single_copy', state['aged_single_copy'][kind], {'kind': kind})
        add('onegy_payloads_zero_copy', state['zero_copy'][kind], {'kind': kind})

    rd = state['remote_deletes']
    add('onegy_remote_delete_queue', rd['queued'])
    add('onegy_remote_delete_stalled', rd['stalled'])
    add('onegy_remote_delete_oldest_timestamp_seconds', rd['oldest'])

    for job in ('health_check', 'integrity_scrub'):
        add('onegy_job_last_run_timestamp_seconds', state['jobs'][job]['last'], {'task': job})
    add('onegy_scheduler_heartbeat_timestamp_seconds', state['jobs']['scheduler']['last'])

    for kind, b in state['backups'].items():
        labels = {'type': kind}
        if b['last_ok']:
            add('onegy_backup_latest_timestamp_seconds', b['last_ok']['finished'], labels)
            add('onegy_backup_latest_bytes', b['last_ok']['bytes'], labels)
        if b['last']:
            add('onegy_backup_last_run_ok', int(b['last']['status'] == 'ok'), labels)
            off = b['last']['offsite_ok']
            add('onegy_backup_last_run_offsite_ok', -1 if off is None else int(off), labels)
            if b['last']['duration'] is not None:
                add('onegy_backup_last_run_duration_seconds', b['last']['duration'], labels)

    if state['disk']:
        add('onegy_local_disk_bytes', state['disk']['total'], {'kind': 'total'})
        add('onegy_local_disk_bytes', state['disk']['free'], {'kind': 'free'})

    counts = {'critical': 0, 'warning': 0, 'info': 0}
    for issue in state['issues']:
        counts[issue['severity']] += 1
        add('onegy_issue', 1, {'code': issue['code'], 'severity': issue['severity'],
                               'subject': issue['subject'], 'summary': issue['summary']})
    for severity, count in counts.items():
        add('onegy_issues', count, {'severity': severity})
    add('onegy_metrics_collect_seconds', state.get('collect_seconds', 0))

    out = []
    for name, lines in samples.items():
        out.append(f'# HELP {name} {_METRIC_HELP.get(name, "")}')
        out.append(f'# TYPE {name} gauge')
        out.extend(lines)
    return '\n'.join(out) + '\n'


@app.route('/metrics')
@limiter.exempt
@csrf.exempt
def prometheus_metrics():
    if not METRICS_TOKEN:
        abort(404)
    auth = request.headers.get('Authorization', '')
    supplied = auth[7:].strip() if auth.startswith('Bearer ') else ''
    if not hmac.compare_digest(supplied.encode(), METRICS_TOKEN.encode()):
        resp = make_response('unauthorized\n', 401)
        resp.headers['Content-Type'] = 'text/plain'
        resp.headers['WWW-Authenticate'] = 'Bearer'
        return resp
    started = time.monotonic()
    try:
        state = _monitor_state()
    except Exception as e:
        db.session.rollback()
        print(f'[METRICS] Monitoring state failed: {e}')
        return make_response('monitoring state unavailable\n', 503)
    state = dict(state, collect_seconds=round(time.monotonic() - started, 3))
    resp = make_response(build_metrics_text(state))
    resp.headers['Content-Type'] = 'text/plain; version=0.0.4'
    resp.headers['Cache-Control'] = 'no-store'
    return resp


# ---- History snapshots --------------------------------------------------------

def _add_monitor_snapshot_rows(snapshot, now):
    """Fill the monitoring columns of a SystemMetricSnapshot being captured and
    add one StorageNodeMetricSnapshot per enabled node (same transaction)."""
    state = _monitor_state(max_age=0)
    snapshot.single_copy_files = state['single_copy']['file']
    snapshot.single_copy_notes = state['single_copy']['note']
    snapshot.single_copy_thumbnails = state['single_copy']['thumbnail']
    snapshot.aged_single_copy_payloads = state['aged_single_copy']['file'] + state['aged_single_copy']['note']
    snapshot.zero_copy_files = state['zero_copy']['file']
    snapshot.zero_copy_notes = state['zero_copy']['note']
    snapshot.unverified_replicas = state['unverified']
    snapshot.parked_replicas = state['parked']
    snapshot.stalled_remote_deletes = state['remote_deletes']['stalled']
    for n in state['nodes']:
        if not n['enabled']:
            continue
        db.session.add(StorageNodeMetricSnapshot(
            captured_at=now, node_id=n['id'], node_name=n['name'], node_type=n['type'], is_up=n['up'],
            synced_replicas=n['synced'], synced_bytes=n['synced_bytes'], pending_replicas=n['pending'],
            error_replicas=n['errors'], unverified_replicas=sum(n['unverified'].values()),
        ))
    _record_issue_events(state['issues'], now)
    StorageNodeMetricSnapshot.query.filter(
        StorageNodeMetricSnapshot.captured_at < now - MONITOR_NODE_SNAPSHOT_RETENTION).delete(synchronize_session=False)
    MonitorIssueEvent.query.filter(
        MonitorIssueEvent.resolved_at < now - MONITOR_NODE_SNAPSHOT_RETENTION).delete(synchronize_session=False)
    BackupRun.query.filter(BackupRun.started_at < now - MONITOR_BACKUP_RUN_RETENTION).delete(synchronize_session=False)


def _record_issue_events(issues, now):
    """Open a MonitorIssueEvent for each new critical/warning issue and close
    the ones that are gone (same transaction as the snapshot being captured)."""
    still_open = {(e.code, e.subject): e
                  for e in MonitorIssueEvent.query.filter(MonitorIssueEvent.resolved_at.is_(None)).all()}
    for issue in issues:
        if issue['severity'] == 'info':
            continue
        event = still_open.pop((issue['code'], issue['subject'][:120]), None)
        if event is None:
            event = MonitorIssueEvent(code=issue['code'], subject=issue['subject'][:120], opened_at=now)
            db.session.add(event)
        event.severity = issue['severity']
        event.summary = issue['summary'][:500]
    for event in still_open.values():
        event.resolved_at = now


def _downsample(rows, start, end, ts_index=0, peak=False, low=()):
    """One row per MONITOR_HISTORY_POINTS equal buckets: the bucket's last row.
    peak=True keeps each column's maximum instead and `low` lists columns that
    keep their minimum, so a short spike or outage still shows in the 7- and
    30-day views."""
    if not rows:
        return []
    width = max(1.0, (end - start) / MONITOR_HISTORY_POINTS)
    kept = {}
    for row in rows:
        k = int((_epoch(row[ts_index]) - start) // width)
        prev = kept.get(k)
        if prev is not None and (peak or low):
            row = tuple(min(v or 0, p or 0) if i in low else max(v or 0, p or 0) if peak and i != ts_index else v
                        for i, (v, p) in enumerate(zip(row, prev)))
        kept[k] = row
    return [kept[k] for k in sorted(kept)]


def _monitor_history(range_key):
    now = datetime.now(timezone.utc)
    since = now - MONITOR_RANGES[range_key]
    start, end = int(since.timestamp()), int(now.timestamp())
    S = SystemMetricSnapshot
    rows = db.session.query(
        S.captured_at, S.replication_pending_files, S.replication_pending_notes, S.replication_pending_thumbnails,
        S.replication_error_files, S.replication_error_notes, S.replication_error_thumbnails,
        S.pending_remote_deletes, S.stalled_remote_deletes, S.single_copy_files, S.single_copy_notes,
        S.single_copy_thumbnails, S.zero_copy_files, S.zero_copy_notes, S.parked_replicas, S.unverified_replicas,
    ).filter(S.captured_at >= since).order_by(S.captured_at).all()
    rows = _downsample(rows, start, end, peak=True)
    cols = ['t', 'backlog_file', 'backlog_note', 'backlog_thumbnail', 'errors_file', 'errors_note',
            'errors_thumbnail', 'remote_deletes', 'remote_deletes_stalled', 'single_copy_file', 'single_copy_note',
            'single_copy_thumbnail', 'zero_copy_file', 'zero_copy_note', 'parked', 'unverified']
    system = {c: [] for c in cols}
    for row in rows:
        system['t'].append(_epoch(row[0]))
        for c, v in zip(cols[1:], row[1:]):
            system[c].append(int(v or 0))

    N = StorageNodeMetricSnapshot
    node_rows = db.session.query(
        N.node_id, N.captured_at, N.node_name, N.node_type, N.is_up, N.synced_bytes, N.synced_replicas,
        N.pending_replicas, N.error_replicas, N.unverified_replicas,
    ).filter(N.captured_at >= since).order_by(N.node_id, N.captured_at).all()
    by_node = {}
    for row in node_rows:
        by_node.setdefault(row[0], []).append(row)
    nodes = []
    for nid, items in by_node.items():
        items = _downsample(items, start, end, ts_index=1, low=(4,))
        nodes.append({
            'id': nid, 'name': items[-1][2], 'type': items[-1][3],
            't': [_epoch(r[1]) for r in items], 'up': [1 if r[4] else 0 for r in items],
            'bytes': [int(r[5] or 0) for r in items], 'synced': [int(r[6] or 0) for r in items],
            'pending': [int(r[7] or 0) for r in items], 'errors': [int(r[8] or 0) for r in items],
            'unverified': [int(r[9] or 0) for r in items],
        })

    runs = BackupRun.query.filter(BackupRun.started_at >= now - MONITOR_BACKUP_WINDOW).order_by(BackupRun.started_at).all()
    E = MonitorIssueEvent
    events = E.query.filter(E.resolved_at >= since).order_by(E.resolved_at.desc()).limit(MONITOR_EVENT_LIMIT).all()
    return {'range': range_key, 'start': start, 'end': end, 'system': system, 'nodes': nodes,
            'events': [{'code': e.code, 'subject': e.subject, 'severity': e.severity, 'summary': e.summary,
                        'opened': _epoch(e.opened_at), 'resolved': _epoch(e.resolved_at)} for e in events],
            'backups': {'start': int((now - MONITOR_BACKUP_WINDOW).timestamp()),
                        'runs': [_backup_run_dict(r) for r in runs]}}


@app.route('/admin/api/monitoring')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_monitoring():
    range_key = request.args.get('range', '24h', type=str)
    if range_key not in MONITOR_RANGES:
        range_key = '24h'
    live = request.args.get('live') == '1'
    try:
        state = _monitor_state()
        history = None if live else _monitor_history(range_key)
    except Exception as e:
        db.session.rollback()
        print(f'[ADMIN] Monitoring data failed: {e}')
        return jsonify({'error': 'MONITORING DATA UNAVAILABLE'}), 500
    return jsonify(state=state, history=history, now=int(time.time()), state_ttl=MONITOR_STATE_TTL_SECONDS,
                   thresholds={'heartbeat': MONITOR_HEARTBEAT_STALE_SECONDS, 'db_backup': MONITOR_DB_BACKUP_MAX_AGE,
                               'full_backup': MONITOR_FULL_BACKUP_MAX_AGE, 'disk': MONITOR_DISK_WARN_PERCENT})
