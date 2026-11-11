# Cached public landing stats, admin live stats, metrics snapshots and stats history.

# In-memory cache for the public landing stats: the landing page is anonymous
# and crawler-exposed, and each render otherwise runs 3+N aggregate queries
# (per-node SUM joins + a GROUP BY/HAVING replica-count subquery). Same
# concurrency rationale as _SETTINGS_CACHE (entries replaced whole, GIL-atomic,
# per-process). Staleness up to the TTL is fine for a marketing counter.
_LANDING_STATS_CACHE = {}
_LANDING_STATS_CACHE_TTL = 60  # seconds
# AUDIT FIX A6: the anonymous landing path had no refresh lock (the admin
# equivalent grew one for exactly this reason). At every TTL boundary EVERY
# concurrent request on '/' ran the full aggregate set -- a per-node SUM over
# FileReplica JOIN File plus a GROUP BY/HAVING replica-count subquery -- in
# parallel, so a crawler could pin all 8 gthreads. '/' has no route-specific
# rate limit. Only one request now recomputes; the rest serve the previous value.
_LANDING_STATS_LOCK = threading.Lock()
_LANDING_STATS_LOCK_TIMEOUT = 20.0

def get_public_landing_stats():
    """Return sanitized replication stats for the landing page.
    Public stats intentionally avoid revealing storage topology. Totals use active
    file payloads only (no notes, thumbnails, backend config, or per-node details).
    Results are cached for _LANDING_STATS_CACHE_TTL seconds; the exception
    fallback below is intentionally NOT cached so a transient DB error does not
    pin zeroed stats for a full TTL window.

    The refresh is single-flighted (AUDIT FIX A6): a request that arrives while
    another is already recomputing serves the previous value instead of running
    the aggregates again."""
    cached = _LANDING_STATS_CACHE.get('stats')
    if cached and (time.monotonic() - cached['ts']) < _LANDING_STATS_CACHE_TTL:
        return cached['value']
    stale_value = cached['value'] if cached else None
    if stale_value is not None:
        if not _LANDING_STATS_LOCK.acquire(blocking=False):
            return stale_value
    elif not _LANDING_STATS_LOCK.acquire(timeout=_LANDING_STATS_LOCK_TIMEOUT):
        print('[LANDING] Stats refresh lock timed out; serving the unavailable fallback')
        return _landing_stats_unavailable()
    try:
        return _compute_public_landing_stats()
    finally:
        _LANDING_STATS_LOCK.release()


def _landing_stats_unavailable():
    """Fallback payload used when the stats cannot be built right now."""
    return {
        'files_fully_synced': 0,
        'files_fully_synced_label': '0',
        'total_active_files': 0,
        'total_active_files_label': '0',
        'backup_completion_percent': 0.0,
        'backup_completion_percent_label': '0%',
        'backup_completion_status': 'error',
        'backup_completion_sub': 'LANDING STATS UNAVAILABLE',
        'total_display_file_bytes': 0,
        'total_display_file_bytes_formatted': '0 B',
        'total_display_file_bytes_sub': 'FILE PAYLOAD ACROSS ACTIVE STORAGE NODES',
    }


def _compute_public_landing_stats():
    """Build the landing stats. Callers MUST hold _LANDING_STATS_LOCK."""
    # Re-check under the lock: another thread may have just refreshed it.
    cached = _LANDING_STATS_CACHE.get('stats')
    if cached and (time.monotonic() - cached['ts']) < _LANDING_STATS_CACHE_TTL:
        return cached['value']
    now_utc = datetime.now(timezone.utc)
    try:
        active_file_filters = [
            File.is_trashed == False,
            db.or_(File.expires_at.is_(None), File.expires_at >= now_utc)
        ]

        display_node_ids = []
        total_display_file_bytes = 0
        for node in StorageNode.query.filter(
            StorageNode.is_enabled == True
        ).order_by(StorageNode.created_at.asc(), StorageNode.id.asc()).all():
            if node.node_type not in ('local', 's3', 'ssh'):
                continue

            node_file_bytes = db.session.query(
                db.func.coalesce(db.func.sum(db.func.coalesce(File.size, FileReplica.size_bytes, 0)), 0)
            ).select_from(FileReplica).join(File, File.id == FileReplica.file_id).filter(
                FileReplica.node_id == node.id,
                FileReplica.status == 'synced',
                *active_file_filters
            ).scalar() or 0
            node_file_bytes = int(node_file_bytes)
            total_display_file_bytes += node_file_bytes
            display_node_ids.append(node.id)

        display_node_count = len(display_node_ids)
        total_active_files = File.query.filter(*active_file_filters).count()

        files_fully_synced = 0
        if display_node_count > 0:
            files_fully_synced = db.session.query(db.func.count()).select_from(
                db.session.query(File.id).outerjoin(
                    FileReplica,
                    db.and_(
                        FileReplica.file_id == File.id,
                        FileReplica.status == 'synced',
                        FileReplica.node_id.in_(display_node_ids)
                    )
                ).filter(*active_file_filters).group_by(File.id).having(
                    db.func.count(db.distinct(FileReplica.node_id)) == display_node_count
                ).subquery()
            ).scalar() or 0

        if total_active_files == 0:
            backup_completion_percent = 100.0
            backup_completion_sub = 'NO ACTIVE FILES TO MIRROR'
        elif display_node_count == 0:
            backup_completion_percent = 0.0
            backup_completion_sub = 'NO ACTIVE STORAGE NODES'
        else:
            backup_completion_percent = (files_fully_synced / total_active_files) * 100.0
            backup_completion_sub = (
                f'{files_fully_synced:,} OF {total_active_files:,} FILES '
                f'FULLY MIRRORED ACROSS ACTIVE STORAGE NODES'
            )

        if total_active_files == 0 or files_fully_synced == total_active_files:
            backup_completion_status = 'ok'
        elif backup_completion_percent < 99:
            backup_completion_status = 'error'
        else:
            backup_completion_status = 'warn'

        stats = {
            'files_fully_synced': int(files_fully_synced),
            'files_fully_synced_label': f'{int(files_fully_synced):,}',
            'total_active_files': int(total_active_files),
            'total_active_files_label': f'{int(total_active_files):,}',
            'backup_completion_percent': backup_completion_percent,
            'backup_completion_percent_label': format_percent_for_display(backup_completion_percent),
            'backup_completion_status': backup_completion_status,
            'backup_completion_sub': backup_completion_sub,
            'total_display_file_bytes': total_display_file_bytes,
            'total_display_file_bytes_formatted': format_bytes_for_filesize(total_display_file_bytes),
            'total_display_file_bytes_sub': 'FILE PAYLOAD ACROSS ACTIVE STORAGE NODES',
        }
        _LANDING_STATS_CACHE['stats'] = {'value': stats, 'ts': time.monotonic()}
        return stats
    except Exception as e:
        print(f'[LANDING] Failed to build public landing stats: {e}')
        try:
            db.session.rollback()
        except Exception:
            pass
        return _landing_stats_unavailable()


ADMIN_STATS_WINDOWS = {
    '30m': {'delta': timedelta(minutes=30), 'bucket': timedelta(minutes=5), 'label': '5M'},
    '6h': {'delta': timedelta(hours=6), 'bucket': timedelta(minutes=15), 'label': '15M'},
    '1d': {'delta': timedelta(days=1), 'bucket': timedelta(hours=1), 'label': '1H'},
    '7d': {'delta': timedelta(days=7), 'bucket': timedelta(hours=6), 'label': '6H'},
    '30d': {'delta': timedelta(days=30), 'bucket': timedelta(days=1), 'label': '1D'},
}


def _round_datetime_floor(dt, bucket_delta):
    bucket_seconds = max(60, int(bucket_delta.total_seconds()))
    epoch_seconds = int(dt.timestamp())
    rounded = epoch_seconds - (epoch_seconds % bucket_seconds)
    return datetime.fromtimestamp(rounded, tz=timezone.utc)

def _format_admin_bucket_label(dt, window_key):
    if window_key in ('30m', '6h'):
        return dt.strftime('%H:%M')
    if window_key == '1d':
        return dt.strftime('%H:00')
    if window_key == '7d':
        return dt.strftime('%d %b %H:%M').upper()
    return dt.strftime('%d %b').upper()

# AUDIT Tier 1: TTL cache for the admin live-stats payload. The full build
# fires ~25 aggregate queries plus a file_types scan + replication status
# rollup; admin pages and the metrics snapshot job both call it. With this
# 15s cache the cost is amortized across all callers within a 15s window.
# capture_system_metrics_snapshot() and other callers that need a fresh
# snapshot can pass use_cache=False.
_ADMIN_LIVE_STATS_CACHE = {'payload': None, 'computed_at': 0.0}
_ADMIN_LIVE_STATS_TTL_SECONDS = 15.0
_ADMIN_LIVE_STATS_LOCK = threading.Lock()
# AUDIT FIX A5: an admin request with no cached payload at all may wait for the
# in-flight refresh, but never indefinitely.
_ADMIN_LIVE_STATS_LOCK_TIMEOUT = 20.0


def _file_type_histogram(limit=8):
    """Top file extensions for the admin dashboard, aggregated in SQL.

    AUDIT FIX A5: this used to be `db.session.query(File.orig_name).all()` --
    one Python string per file in the ENTIRE system, materialised every 5
    minutes by metrics_snapshot_job whether or not an admin was looking, purely
    to build an 8-entry histogram.

    The grouping now happens in the database. _COMPOUND_EXT_PREFIXES contains
    only 'tar', so a second small grouped query reassigns 'gz' -> 'tar.gz' etc.
    and the result stays byte-identical to _get_compound_ext(). Non-MySQL
    dialects (only reachable with ALLOW_SQLITE_APP_DB=true) fall back to a
    streaming scan that never holds more than one batch in memory."""
    from collections import defaultdict

    dialect_name = ''
    try:
        dialect_name = db.engine.dialect.name or ''
    except Exception:
        dialect_name = ''

    if dialect_name not in ('mysql', 'mariadb'):
        type_counts = defaultdict(int)
        try:
            for row in db.session.query(File.orig_name).yield_per(5000):
                type_counts[_get_compound_ext(row[0]) or 'other'] += 1
        except Exception as e:
            print(f'[ADMIN] Failed to build file type histogram: {e}')
            return []
        return sorted(type_counts.items(), key=lambda item: item[1], reverse=True)[:limit]

    try:
        last_segment = db.func.substring_index(File.orig_name, '.', -1)
        plain_ext = case(
            (File.orig_name.notlike('%.%'), 'other'),
            else_=db.func.lower(last_segment),
        )
        counts = defaultdict(int)
        # All groups (one row per distinct extension): any preliminary cut can
        # drop the true winner once the compound correction below moves counts.
        for ext, cnt in db.session.query(plain_ext.label('ext'), db.func.count()).group_by(
            'ext'
        ).all():
            counts[(ext or 'other')] += int(cnt or 0)

        # Compound ('.tar.<x>') correction: move those rows out of the plain
        # '<x>' bucket and into a 'tar.<x>' bucket.
        second_last = db.func.lower(
            db.func.substring_index(db.func.substring_index(File.orig_name, '.', -2), '.', 1)
        )
        compound_ext = db.func.lower(db.func.concat('tar.', last_segment))
        compound_rows = db.session.query(compound_ext.label('ext'), db.func.count()).filter(
            File.orig_name.like('%.tar.%'),
            second_last == 'tar',
        ).group_by('ext').all()
        for ext, cnt in compound_rows:
            cnt = int(cnt or 0)
            if not ext or cnt <= 0:
                continue
            # Same 'other' bucket the first pass used for an empty extension.
            plain = (ext.split('.', 1)[1] if '.' in ext else ext) or 'other'
            counts[ext] += cnt
            if plain in counts:
                counts[plain] -= cnt
                if counts[plain] <= 0:
                    counts.pop(plain, None)
        return sorted(counts.items(), key=lambda item: item[1], reverse=True)[:limit]
    except Exception as e:
        print(f'[ADMIN] Failed to aggregate file type histogram: {e}')
        try:
            db.session.rollback()
        except Exception:
            pass
        return []


def _build_admin_live_stats(use_cache=True):
    import time as _time

    if use_cache:
        cached = _ADMIN_LIVE_STATS_CACHE
        stale_payload = cached.get('payload')
        if (
            stale_payload is not None
            and (_time.monotonic() - cached.get('computed_at', 0.0)) < _ADMIN_LIVE_STATS_TTL_SECONDS
        ):
            return stale_payload
        # AUDIT FIX A5: single-flight the refresh WITHOUT parking every other
        # request thread on the lock for the duration of the ~25-query rebuild.
        # The lock used to be acquired blocking and then held across the whole
        # recursive rebuild; with read_timeout=60 per statement that stalled every
        # concurrent admin request for up to a minute. Now a loser thread serves
        # the marginally-stale payload immediately, and only a caller that has
        # NOTHING to serve waits at all (with a bounded timeout).
        if stale_payload is not None:
            if not _ADMIN_LIVE_STATS_LOCK.acquire(blocking=False):
                return stale_payload
        elif not _ADMIN_LIVE_STATS_LOCK.acquire(timeout=_ADMIN_LIVE_STATS_LOCK_TIMEOUT):
            print('[ADMIN] Live-stats refresh lock timed out; building an uncached snapshot')
            return _build_admin_live_stats(use_cache=False)
        try:
            # Re-check under lock: another thread may have just refreshed it.
            cached = _ADMIN_LIVE_STATS_CACHE
            if (
                cached.get('payload') is not None
                and (_time.monotonic() - cached.get('computed_at', 0.0)) < _ADMIN_LIVE_STATS_TTL_SECONDS
            ):
                return cached['payload']
            payload = _build_admin_live_stats(use_cache=False)
            _ADMIN_LIVE_STATS_CACHE['payload'] = payload
            _ADMIN_LIVE_STATS_CACHE['computed_at'] = _time.monotonic()
            return payload
        finally:
            _ADMIN_LIVE_STATS_LOCK.release()

    now = datetime.now(timezone.utc)

    total_users = User.query.count()
    admin_users = User.query.filter_by(is_admin=True).count()
    e2e_users = User.query.filter(User.has_e2ee_keys == True).count()

    total_files = File.query.count()
    registered_file_count = File.query.filter_by(is_temp_upload=False).count()
    temp_file_count = File.query.filter(
        File.is_temp_upload == True,
        db.or_(File.expires_at.is_(None), File.expires_at >= now)
    ).count()
    e2e_file_count = File.query.filter_by(is_e2e_encrypted=True).count()
    total_folders = Folder.query.filter_by(is_trashed=False).count()

    total_downloads = int(db.session.query(db.func.coalesce(db.func.sum(File.download_count), 0)).scalar() or 0)
    total_file_size = int(db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).scalar() or 0)
    registered_file_payload_bytes = int((db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).filter(
        File.is_temp_upload == False
    ).scalar() or 0))
    temp_file_payload_bytes = int((db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).filter(
        File.is_temp_upload == True,
        db.or_(File.expires_at.is_(None), File.expires_at >= now)
    ).scalar() or 0))
    unique_visitors = int((db.session.query(db.func.count(db.func.distinct(File.user_id))).filter(
        File.is_temp_upload == True,
        db.or_(File.expires_at.is_(None), File.expires_at >= now)
    ).scalar() or 0))

    local_node = StorageNode.query.filter_by(node_type='local', is_enabled=True).first()
    local_tracked = storage.get_node_tracked_storage_breakdown(local_node.id) if local_node else None
    tracked_registered_bytes = int((local_tracked or {}).get('registered_bytes', 0) or 0)
    tracked_temp_bytes = int((local_tracked or {}).get('temp_bytes', 0) or 0)
    tracked_total_bytes = int((local_tracked or {}).get('tracked_total_bytes', 0) or 0)
    note_bytes = int((local_tracked or {}).get('note_bytes', 0) or 0)
    registered_thumb_bytes = int((local_tracked or {}).get('registered_thumb_bytes', 0) or 0)
    temp_thumb_bytes = int((local_tracked or {}).get('temp_thumb_bytes', 0) or 0)
    disk = shutil.disk_usage('/')

    # AUDIT FIX A5: aggregated in SQL instead of pulling every filename.
    file_types = _file_type_histogram(limit=8)

    live_status = storage.get_replication_status()
    enabled_nodes = StorageNode.query.filter_by(is_enabled=True).all()
    online_nodes = sum(1 for node in enabled_nodes if node.status == 'online')
    offline_nodes = sum(1 for node in enabled_nodes if node.status == 'offline')
    error_nodes = sum(1 for node in enabled_nodes if node.status == 'error')
    syncing_nodes = sum(1 for node in enabled_nodes if node.status == 'syncing')
    pending_files = int(live_status.get('pending_files', 0) or 0)
    pending_notes = int(live_status.get('pending_notes', 0) or 0)
    pending_thumbnails = int(live_status.get('pending_thumbnails', 0) or 0)
    error_files = FileReplica.query.filter_by(status='error').count()
    error_notes = NoteReplica.query.filter_by(status='error').count()
    error_thumbnails = ThumbnailReplica.query.filter_by(status='error').count()
    synced_file_replicas = FileReplica.query.filter_by(status='synced').count()
    synced_note_replicas = NoteReplica.query.filter_by(status='synced').count()
    synced_thumbnail_replicas = ThumbnailReplica.query.filter_by(status='synced').count()
    pending_remote_deletes = PendingRemoteDelete.query.count()
    avg_sync_percent = 100.0
    if live_status.get('per_node'):
        avg_sync_percent = round(sum((node.get('sync_percent') or 0) for node in live_status['per_node']) / len(live_status['per_node']), 1)

    replication_config = {
        'speed': str(get_setting_value('replication_speed') or 'steady').upper(),
        'source': str(get_setting_value('replication_source') or 'primary_fallback').replace('_', ' ').upper(),
        'workers': get_numeric_setting('replication_workers'),
        'checksum': str(get_setting_value('replication_verify_checksum') or 'false').lower() in ('true', '1', 'yes'),
    }

    return {
        'overview': {
            'total_users': total_users,
            'admin_users': admin_users,
            'regular_users': total_users - admin_users,
            'total_files': total_files,
            'registered_files': registered_file_count,
            'temp_files': temp_file_count,
            'total_folders': total_folders,
            'e2e_files': e2e_file_count,
            'e2e_users': e2e_users,
            'unique_visitors': unique_visitors,
            'total_downloads': total_downloads,
        },
        'storage': {
            'app_used_gb': round(tracked_total_bytes / (1024**3), 2),
            'disk_total_gb': round(disk.total / (1024**3), 1),
            'disk_free_gb': round(disk.free / (1024**3), 1),
            'disk_percent': round((disk.total - disk.free) / disk.total * 100, 1) if disk.total > 0 else 0,
            'total_file_size_gb': round(total_file_size / (1024**3), 2),
            'total_file_size_bytes': total_file_size,
            'temp_file_size_gb': round(temp_file_payload_bytes / (1024**3), 2),
            'total_storage_bytes': tracked_total_bytes,
            'tracked_registered_bytes': tracked_registered_bytes,
            'tracked_temp_bytes': tracked_temp_bytes,
            'tracked_total_bytes': tracked_total_bytes,
            'registered_file_payload_bytes': registered_file_payload_bytes,
            'temp_file_payload_bytes': temp_file_payload_bytes,
            'disk_total_bytes': int(disk.total),
            'disk_free_bytes': int(disk.free),
            'note_bytes': note_bytes,
            'registered_thumb_bytes': registered_thumb_bytes,
            'temp_thumb_bytes': temp_thumb_bytes,
        },
        'replication': {
            'overview': {
                'nodes': len(enabled_nodes),
                'online_nodes': online_nodes,
                'offline_nodes': offline_nodes,
                'error_nodes': error_nodes,
                'syncing_nodes': syncing_nodes,
                'avg_sync_percent': avg_sync_percent,
                'pending_items': pending_files + pending_notes + pending_thumbnails,
                'error_items': error_files + error_notes + error_thumbnails,
                'pending_files': pending_files,
                'pending_notes': pending_notes,
                'pending_thumbnails': pending_thumbnails,
                'error_files': error_files,
                'error_notes': error_notes,
                'error_thumbnails': error_thumbnails,
                'synced_file_replicas': synced_file_replicas,
                'synced_note_replicas': synced_note_replicas,
                'synced_thumbnail_replicas': synced_thumbnail_replicas,
                'pending_remote_deletes': pending_remote_deletes,
                'fully_synced': bool(live_status.get('fully_synced')),
            },
            'config': replication_config,
            'per_node': live_status.get('per_node', []),
        },
        'details': {
            'file_types': [{'ext': ext, 'count': cnt} for ext, cnt in file_types],
        }
    }

_metrics_snapshot_lock = threading.Lock()


def capture_system_metrics_snapshot(force=False):
    # AUDIT FIX (finding 20, perf): serialize the read-check-then-insert. The
    # admin history builders and the 5-minute scheduler job all call this with
    # force=False; without the lock two concurrent callers both passed the
    # "no recent snapshot" check and inserted duplicate rows for the same
    # window. Single gunicorn worker -> a module lock is sufficient.
    with _metrics_snapshot_lock:
        now = datetime.now(timezone.utc)
        latest = SystemMetricSnapshot.query.order_by(SystemMetricSnapshot.captured_at.desc()).first()
        if latest and not force:
            latest_ts = _utc_aware(latest.captured_at)
            if latest_ts and (now - latest_ts) < timedelta(minutes=4):
                return latest

        live = _build_admin_live_stats()
        overview = live['overview']
        storage_data = live['storage']
        repl = live['replication']['overview']

        snapshot = SystemMetricSnapshot(
        captured_at=now,
        total_users=overview['total_users'],
        admin_users=overview['admin_users'],
        e2e_users=overview['e2e_users'],
        total_files=overview['total_files'],
        registered_files=overview['registered_files'],
        temp_files=overview['temp_files'],
        total_folders=overview['total_folders'],
        e2e_files=overview['e2e_files'],
        total_downloads=overview['total_downloads'],
        total_file_size_bytes=storage_data['total_file_size_bytes'],
        registered_file_payload_bytes=storage_data['registered_file_payload_bytes'],
        temp_file_payload_bytes=storage_data['temp_file_payload_bytes'],
        tracked_registered_bytes=storage_data['tracked_registered_bytes'],
        tracked_temp_bytes=storage_data['tracked_temp_bytes'],
        tracked_total_bytes=storage_data['tracked_total_bytes'],
        disk_total_bytes=storage_data['disk_total_bytes'],
        disk_free_bytes=storage_data['disk_free_bytes'],
        replication_nodes=repl['nodes'],
        replication_online_nodes=repl['online_nodes'],
        replication_offline_nodes=repl['offline_nodes'],
        replication_error_nodes=repl['error_nodes'],
        replication_pending_files=repl['pending_files'],
        replication_pending_notes=repl['pending_notes'],
        replication_pending_thumbnails=repl['pending_thumbnails'],
        replication_error_files=repl['error_files'],
        replication_error_notes=repl['error_notes'],
        replication_error_thumbnails=repl['error_thumbnails'],
        pending_remote_deletes=repl['pending_remote_deletes'],
        )
        db.session.add(snapshot)

        cutoff = now - timedelta(days=45)
        SystemMetricSnapshot.query.filter(SystemMetricSnapshot.captured_at < cutoff).delete(synchronize_session=False)
        db.session.commit()
        print(f'[ADMIN] Captured system metrics snapshot at {now.isoformat()}')
        return snapshot

def build_admin_stats_history(window_key):
    cfg = ADMIN_STATS_WINDOWS.get(window_key) or ADMIN_STATS_WINDOWS['1d']
    now = datetime.now(timezone.utc)
    capture_system_metrics_snapshot(force=False)
    start = now - cfg['delta']
    aligned_start = _round_datetime_floor(start, cfg['bucket'])
    query_start = aligned_start - cfg['bucket']
    snapshots = SystemMetricSnapshot.query.filter(
        SystemMetricSnapshot.captured_at >= query_start
    ).order_by(SystemMetricSnapshot.captured_at.asc()).all()

    series = []
    point_time = aligned_start + cfg['bucket']
    snap_idx = 0
    current = None
    prev_point = None
    # Baseline for the first bucket's download delta: latest snapshot at/before the window start.
    while snap_idx < len(snapshots) and _utc_aware(snapshots[snap_idx].captured_at) <= aligned_start:
        prev_point = snapshots[snap_idx]
        current = prev_point
        snap_idx += 1
    while point_time <= now + timedelta(seconds=1):
        while snap_idx < len(snapshots) and _utc_aware(snapshots[snap_idx].captured_at) <= point_time:
            current = snapshots[snap_idx]
            snap_idx += 1

        downloads_value = 0
        if current and prev_point:
            downloads_value = max(0, int(current.total_downloads or 0) - int(prev_point.total_downloads or 0))

        pending_items = None
        error_items = None
        files_value = None
        bytes_value = None
        online_node_percent = None
        if current:
            pending_items = int(current.replication_pending_files or 0) + int(current.replication_pending_notes or 0) + int(current.replication_pending_thumbnails or 0)
            error_items = int(current.replication_error_files or 0) + int(current.replication_error_notes or 0) + int(current.replication_error_thumbnails or 0)
            files_value = int(current.total_files or 0)
            bytes_value = int(current.tracked_total_bytes or 0)
            if int(current.replication_nodes or 0) > 0:
                online_node_percent = round(max(0, min(100, ((int(current.replication_online_nodes or 0) / max(1, int(current.replication_nodes or 0))) * 100))), 1)

        series.append({
            'ts': point_time.isoformat(),
            'label': _format_admin_bucket_label(point_time, window_key),
            'files': files_value,
            'bytes': bytes_value,
            'downloads': downloads_value,
            'pending_items': pending_items,
            'error_items': error_items,
            # Node availability, not replication completion (snapshots do not
            # record synced totals) -- named for what it measures.
            'online_node_percent': online_node_percent,
        })

        if current:
            prev_point = current
        point_time += cfg['bucket']

    first_snapshot = snapshots[0] if snapshots else None
    latest_snapshot = snapshots[-1] if snapshots else None
    return {
        'window': window_key if window_key in ADMIN_STATS_WINDOWS else '1d',
        'bucket_label': cfg['label'],
        'series': series,
        'availability': {
            'has_data': bool(series and any(point['files'] is not None for point in series)),
            'first_snapshot_at': _utc_aware(first_snapshot.captured_at).isoformat() if first_snapshot else None,
            'latest_snapshot_at': _utc_aware(latest_snapshot.captured_at).isoformat() if latest_snapshot else None,
        }
    }
