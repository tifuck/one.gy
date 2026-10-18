@app.route('/admin/api/storage/nodes')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_nodes():
    """List all storage nodes with status"""
    nodes = StorageNode.query.order_by(StorageNode.created_at).all()
    result = []
    for node in nodes:
        config = node.get_config()
        # Sanitize config — never expose secrets
        safe_config = {}
        if node.node_type == 'ssh':
            safe_config = {
                'hostname': config.get('hostname', ''),
                'port': config.get('port', 22),
                'username': config.get('username', ''),
                'remote_path': config.get('remote_path', '/opt/onegy-storage'),
                'auth_method': config.get('auth_method', 'password'),
                'host_key_sha256': config.get('host_key_sha256', config.get('host_key_fingerprint', '')),
                'host_key_algorithm': config.get('host_key_algorithm', ''),
            }
        elif node.node_type == 's3':
            safe_config = {
                'endpoint_url': config.get('endpoint_url', ''),
                'bucket': config.get('bucket', ''),
                'region': config.get('region', 'us-east-1'),
                'prefix': config.get('prefix', ''),
            }
        elif node.node_type == 'local':
            safe_config = {'path': config.get('path', '')}

        result.append({
            'id': node.id,
            'name': node.name,
            'node_type': node.node_type,
            'config': safe_config,
            'is_primary': node.is_primary,
            'is_enabled': node.is_enabled,
            'status': node.status,
            'created_at': node.created_at.isoformat() if node.created_at else None,
            'last_seen_at': node.last_seen_at.isoformat() if node.last_seen_at else None,
            # F7: 'full' SHA-256, 'size-only', or 'unknown' (not yet probed)
            'integrity': ('full' if node.checksum_capable is True
                          else 'size-only' if node.checksum_capable is False
                          else 'unknown'),
        })
    return jsonify({'nodes': result})

@app.route('/admin/api/storage/nodes', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_nodes_create():
    """Add a new storage node"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Invalid request'}), 400
    if not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400

    # AUDIT FIX A15/A17: a null/non-string name used to reach None.strip() -> 500.
    # StorageNode.name is String(100).
    name = data.get('name')
    name = name.strip()[:100] if isinstance(name, str) else ''
    node_type = data.get('node_type')
    node_type = node_type.strip() if isinstance(node_type, str) else ''
    is_primary = data.get('is_primary', False)
    if not isinstance(is_primary, bool):
        return jsonify({'error': 'IS_PRIMARY MUST BE A BOOLEAN'}), 400

    if not name:
        return jsonify({'error': 'NAME IS REQUIRED'}), 400
    if node_type not in ('local', 'ssh', 's3'):
        return jsonify({'error': 'INVALID NODE TYPE. MUST BE: local, ssh, s3'}), 400

    config = data.get('config') or {}
    if not isinstance(config, dict):
        return jsonify({'error': 'INVALID NODE CONFIG'}), 400

    # AUDIT FIX (finding 1): a second 'local' node used to be accepted (with
    # any config path) while _create_backend aliased the SAME canonical local
    # backend — every "replica" on it was the primary disk itself. Fail-safe
    # reject: unless a true separate-path backend exists (it does not), only
    # one local node may ever be configured.
    if node_type == 'local':
        _existing_local = StorageNode.query.filter_by(node_type='local').count()
        _local_err = _validate_local_node_addition(_existing_local, config)
        if _local_err:
            return jsonify({'error': _local_err}), 400

    # Validate config based on type
    if node_type == 'ssh':
        if not config.get('hostname'):
            return jsonify({'error': 'SSH HOSTNAME IS REQUIRED'}), 400
        if not config.get('username'):
            return jsonify({'error': 'SSH USERNAME IS REQUIRED'}), 400
        # AUDIT FIX H1: SSRF / metadata-endpoint defense
        host_ok, host_err = _validate_storage_node_host(config.get('hostname'))
        if not host_ok:
            return jsonify({'error': f'SSH HOSTNAME REJECTED: {host_err}'}), 400
        # Require a pinned host key fingerprint for password auth so the
        # first-contact password is not exposed to a MITM. Key-based auth is
        # still permitted to use TOFU but operators are encouraged to pin.
        auth_method = str(config.get('auth_method') or 'password').strip().lower()
        if auth_method not in ('password', 'key'):
            return jsonify({'error': 'INVALID SSH AUTH_METHOD. MUST BE: password, key'}), 400
        config['auth_method'] = auth_method
        if auth_method == 'password':
            if not (config.get('host_key') or config.get('host_key_sha256')
                    or config.get('host_key_fingerprint')):
                return jsonify({'error': 'SSH PASSWORD AUTH REQUIRES A PINNED HOST_KEY OR HOST_KEY_SHA256 FINGERPRINT'}), 400
    elif node_type == 's3':
        if not config.get('bucket'):
            return jsonify({'error': 'S3 BUCKET NAME IS REQUIRED'}), 400
        if not config.get('access_key'):
            return jsonify({'error': 'S3 ACCESS KEY IS REQUIRED'}), 400
        if not config.get('secret_key'):
            return jsonify({'error': 'S3 SECRET KEY IS REQUIRED'}), 400
        # AUDIT FIX H1: SSRF defense for the S3 endpoint_url (if a custom
        # endpoint was supplied — e.g. for B2, Wasabi, MinIO).
        endpoint_url = (config.get('endpoint_url') or '').strip()
        if endpoint_url:
            # AUDIT FIX (finding 15): scheme presence + explicit plaintext
            # opt-in are checked together; http:// now requires
            # STORAGE_S3_ALLOW_HTTP=true regardless of the private-host
            # allowlist (which only controls WHO may be contacted).
            _scheme_error = _s3_endpoint_scheme_error(endpoint_url)
            if _scheme_error:
                return jsonify({'error': _scheme_error}), 400
            host_ok, host_err = _validate_storage_node_host(endpoint_url)
            if not host_ok:
                return jsonify({'error': f'S3 ENDPOINT REJECTED: {host_err}'}), 400

    try:
        node = storage.add_node(name, node_type, config, is_primary=is_primary)
        print(f'[ADMIN] Added storage node: {name} ({node_type})')
        return jsonify({'success': True, 'node_id': node.id, 'message': 'NODE ADDED. BACKFILL STARTED.'})
    except ValueError as e:
        # Fail-safe validation refusals (duplicate local node, unknown type,
        # http S3 endpoint without opt-in) reach the operator verbatim.
        print(f'[ADMIN] Rejected storage node add: {e}')
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        print(f'[ADMIN] Failed to add storage node: {e}')
        return jsonify({'error': 'FAILED TO ADD NODE'}), 500

@app.route('/admin/api/storage/nodes/<int:node_id>', methods=['PUT'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_nodes_update(node_id):
    """Update a storage node configuration"""
    # AUDIT FIX M11a: serialize the config read-modify-write per node. A plain
    # fetch let two concurrent PUTs read the same config_json, each merge its
    # own keys, and both write back -- the second write silently dropped the
    # first request's new config keys. SELECT ... FOR UPDATE pins the row until
    # the commit below (a DB row lock, unlike a host-local flock, so it also
    # serializes across app hosts), so a concurrent PUT re-reads the first
    # PUT's merged config. Mirrors the populate_existing().with_for_update()
    # idiom used by the folder/notebook placement locks.
    node = (
        StorageNode.query
        .filter_by(id=node_id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if not node:
        return jsonify({'error': 'NODE NOT FOUND'}), 404

    data = _json_object_body()
    if not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400

    was_enabled = bool(node.is_enabled)

    # AUDIT FIX A15/A17: null/non-string values used to raise AttributeError -> 500.
    if 'name' in data:
        new_name = data.get('name')
        new_name = new_name.strip()[:100] if isinstance(new_name, str) else ''
        if not new_name:
            return jsonify({'error': 'NAME IS REQUIRED'}), 400
        node.name = new_name
    if 'is_enabled' in data:
        # bool('false') is True: only a real JSON boolean may toggle the node.
        if not isinstance(data['is_enabled'], bool):
            return jsonify({'error': 'IS_ENABLED MUST BE A BOOLEAN'}), 400
        node.is_enabled = data['is_enabled']
    if 'config' in data:
        # Merge with existing config (so secrets don't need to be resent)
        existing_config = node.get_config()
        new_config = data.get('config') or {}
        if not isinstance(new_config, dict):
            return jsonify({'error': 'INVALID NODE CONFIG'}), 400
        for k, v in new_config.items():
            # Blank otherwise means "keep the stored value" (secrets are never
            # sent back); an S3 prefix, though, can legitimately be cleared.
            if ((v is not None and v != '') or (node.node_type == 'ssh' and k == 'auth_method')
                    or (v == '' and k == 'prefix')):
                existing_config[k] = v
        # AUDIT FIX H1: re-validate any host/endpoint changes against the
        # SSRF allowlist before persisting.
        if 'hostname' in new_config and new_config.get('hostname'):
            ok, err = _validate_storage_node_host(new_config.get('hostname'))
            if not ok:
                return jsonify({'error': f'HOSTNAME REJECTED: {err}'}), 400
        if 'endpoint_url' in new_config and new_config.get('endpoint_url'):
            endpoint_url = str(new_config.get('endpoint_url') or '').strip()
            if endpoint_url:
                # AUDIT FIX (finding 15): same explicit opt-in rule as create.
                _scheme_error = _s3_endpoint_scheme_error(endpoint_url)
                if _scheme_error:
                    return jsonify({'error': _scheme_error}), 400
                ok, err = _validate_storage_node_host(endpoint_url)
                if not ok:
                    return jsonify({'error': f'S3 ENDPOINT REJECTED: {err}'}), 400
        # AUDIT FIX (finding 19): mirror the CREATE rule -- an SSH config
        # using password auth must carry a pinned host key (host_key /
        # host_key_sha256 / host_key_fingerprint), otherwise the FIRST
        # connection after this update sends the (possibly new) password to
        # whoever answers the TCP connection (MITM). Key-based auth may still
        # TOFU, exactly like create.
        if getattr(node, 'node_type', None) == 'ssh':
            _auth_method = str(existing_config.get('auth_method') or 'password').strip().lower()
            if _auth_method not in ('password', 'key'):
                return jsonify({'error': 'INVALID SSH AUTH_METHOD. MUST BE: password, key'}), 400
            existing_config['auth_method'] = _auth_method
            if _auth_method == 'password' and not (
                    existing_config.get('host_key') or existing_config.get('host_key_sha256')
                    or existing_config.get('host_key_fingerprint')):
                print(f'[ADMIN] Rejected unpinned SSH password auth update for node {node_id}')
                return jsonify({'error': 'SSH PASSWORD AUTH REQUIRES A PINNED HOST_KEY OR HOST_KEY_SHA256 FINGERPRINT'}), 400
        node.set_config(existing_config)

    db.session.commit()
    storage._bump_backends_version()
    # Refresh backend if config changed
    storage.refresh_backends()
    if not was_enabled and node.is_enabled:
        reset = storage.reactivate_pending_remote_deletes_for_node(node.id)
        if reset > 0:
            print(f'[ADMIN] Re-activated {reset} deferred delete(s) for re-enabled node {node_id}')
    print(f'[ADMIN] Updated storage node {node_id}: {node.name}')
    return jsonify({'success': True})

@app.route('/admin/api/storage/nodes/<int:node_id>/check-removal', methods=['GET'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_nodes_check_removal(node_id):
    """Check what data would be at risk if a node is removed"""
    try:
        node = db.session.get(StorageNode, node_id)
        if not node:
            return jsonify({'error': 'NODE NOT FOUND'}), 404
        exclusive = storage.check_node_exclusive_data(node_id)
        exclusive['is_local'] = node.node_type == 'local'
        exclusive['is_primary'] = node.is_primary
        exclusive['node_name'] = node.name
        return jsonify(exclusive)
    except Exception as e:
        print(f'[ADMIN] Failed to check removal for node {node_id}: {e}')
        return jsonify({'error': 'FAILED TO CHECK NODE REMOVAL SAFETY'}), 500

@app.route('/admin/api/storage/nodes/<int:node_id>', methods=['DELETE'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_nodes_delete(node_id):
    """Remove a storage node"""
    try:
        node = db.session.get(StorageNode, node_id)
        if not node:
            return jsonify({'error': 'NODE NOT FOUND'}), 404
        data = _json_object_body()
        force = request.args.get('force', '').lower() == 'true' or str(data.get('force', '')).lower() in ('true', '1', 'yes')
        if force:
            confirm_node_name = (data.get('confirm_node_name') or request.args.get('confirm_node_name') or '').strip()
            confirm_phrase = (data.get('confirm_phrase') or request.args.get('confirm_phrase') or '').strip().upper()
            if confirm_node_name != node.name or confirm_phrase != 'REMOVE EXCLUSIVE DATA RISK':
                return jsonify({'error': 'FORCE REMOVAL REQUIRES THE EXACT NODE NAME AND THE PHRASE REMOVE EXCLUSIVE DATA RISK'}), 400
        is_local = node and node.node_type == 'local'
        storage.remove_node(node_id, force=force)
        if is_local:
            print(f'[ADMIN] WARNING: Removed local disk storage node {node_id} — new writes will go to remote backends')
        else:
            print(f'[ADMIN] Removed storage node {node_id}')
        return jsonify({'success': True, 'warning': 'REMOTE DATA ON THE REMOVED NODE WAS NOT DELETED'})
    except ValueError as e:
        return jsonify({'error': str(e).upper()}), 400
    except Exception as e:
        print(f'[ADMIN] Failed to remove storage node {node_id}: {e}')
        return jsonify({'error': 'FAILED TO REMOVE NODE'}), 500

@app.route('/admin/api/storage/nodes/<int:node_id>/test', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_nodes_test(node_id):
    """Test connection to a storage node"""
    success, message = storage.test_connection(node_id)
    return jsonify({'success': success, 'message': message.upper()})

@app.route('/admin/api/storage/nodes/<int:node_id>/disk-usage')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_nodes_disk_usage(node_id):
    """Get host disk and tracked-data stats for a storage node"""
    node = db.session.get(StorageNode, node_id)
    if not node:
        return jsonify({'error': 'NODE NOT FOUND'}), 404
    tracked = storage.get_node_tracked_storage_breakdown(node_id) or {}
    payload = {
        'supported': True,
        'node_type': node.node_type,
        'tracked_total_bytes': tracked.get('tracked_total_bytes', 0),
        'tracked_breakdown': {
            'registered_bytes': tracked.get('registered_bytes', 0),
            'temp_bytes': tracked.get('temp_bytes', 0),
            'note_bytes': tracked.get('note_bytes', 0),
            'registered_thumb_bytes': tracked.get('registered_thumb_bytes', 0),
            'temp_thumb_bytes': tracked.get('temp_thumb_bytes', 0),
        }
    }
    if node.node_type in ('local', 'ssh'):
        result = storage.get_node_disk_usage(node_id)
        if result and result.get('data'):
            payload['cached_at'] = result.get('cached_at')
            payload['host_disk'] = {
                'total_bytes': result['data']['total_bytes'],
                'used_bytes': result['data']['used_bytes'],
                'free_bytes': result['data']['free_bytes'],
                'percent': result['data']['percent'],
            }
    return jsonify(payload)

@app.route('/admin/api/storage/nodes/<int:node_id>/set-primary', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_nodes_set_primary(node_id):
    """Set a node as the primary read node"""
    try:
        storage.set_primary(node_id)
    except ValueError as e:
        return jsonify({'error': str(e).upper()}), 400
    return jsonify({'success': True})

@app.route('/admin/api/storage/status')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_status():
    """Get replication status overview"""
    status = storage.get_replication_status()
    return jsonify(status)

@app.route('/admin/api/storage/retry-errors', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_retry_errors():
    """Reset failed replica state so replication and deferred deletes can be retried."""
    data = _json_object_body()
    exhausted_only = str(data.get('exhausted_only', 'false')).lower() in ('true', '1', 'yes')
    include_deferred_deletes = str(data.get('include_deferred_deletes', 'true')).lower() in ('true', '1', 'yes')
    try:
        counts = storage.reset_failed_replication_state(
            exhausted_only=exhausted_only,
            include_deferred_deletes=include_deferred_deletes,
        )
        print(f'[ADMIN] Reset failed storage state: {counts}')
        return jsonify({'success': True, 'reset': counts})
    except Exception as e:
        db.session.rollback()
        print(f'[ADMIN] Failed to reset failed storage state: {e}')
        return jsonify({'error': 'FAILED TO RESET FAILED STORAGE STATE'}), 500

@app.route('/admin/api/storage/replication-speed')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_replication_speed_get():
    """Get current replication speed preset"""
    speed = get_setting_value('replication_speed') or 'steady'
    if speed not in StorageManager.REPLICATION_PRESETS:
        speed = 'steady'
    presets = {}
    for name, cfg in StorageManager.REPLICATION_PRESETS.items():
        presets[name] = {'batch': cfg['batch'], 'delay': cfg['delay'], 'approx_per_min': cfg['approx']}
    return jsonify({'speed': speed, 'presets': presets})

@app.route('/admin/api/storage/replication-speed', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_replication_speed_set():
    """Set replication speed preset"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or 'speed' not in data:
        return jsonify({'error': 'SPEED PRESET REQUIRED'}), 400
    speed = data['speed']
    valid_presets = list(StorageManager.REPLICATION_PRESETS.keys())
    if speed not in valid_presets:
        return jsonify({'error': f'INVALID PRESET. VALID: {", ".join(valid_presets).upper()}'}), 400
    try:
        # AUDIT FIX A1: route through set_setting() so _invalidate_settings_cache()
        # runs. Writing the AppSetting row directly left the 60s _SETTINGS_CACHE
        # entry in place, so the change was a no-op for up to a minute AND the
        # matching GET read back the stale old value (the toggle appeared to
        # revert and the admin re-clicked).
        set_setting('replication_speed', speed)
        print(f'[ADMIN] Replication speed changed to: {speed}')
        return jsonify({'success': True, 'speed': speed})
    except Exception as e:
        db.session.rollback()
        print(f'[ADMIN] Failed to set replication speed: {e}')
        return jsonify({'error': 'FAILED TO UPDATE SETTING'}), 500

@app.route('/admin/api/storage/replication-source')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_replication_source_get():
    """Get current replication source mode"""
    mode = get_setting_value('replication_source') or 'primary_fallback'
    if mode not in StorageManager.REPLICATION_SOURCE_MODES:
        mode = 'primary_fallback'
    modes = {}
    for name, desc in StorageManager.REPLICATION_SOURCE_MODES.items():
        modes[name] = {'description': desc}
    return jsonify({'mode': mode, 'modes': modes})

@app.route('/admin/api/storage/replication-source', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_replication_source_set():
    """Set replication source mode"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or 'mode' not in data:
        return jsonify({'error': 'SOURCE MODE REQUIRED'}), 400
    mode = data['mode']
    valid_modes = list(StorageManager.REPLICATION_SOURCE_MODES.keys())
    if mode not in valid_modes:
        return jsonify({'error': f'INVALID MODE. VALID: {", ".join(valid_modes).upper()}'}), 400
    try:
        # AUDIT FIX A1: set_setting() invalidates the settings cache; the direct
        # row write did not.
        set_setting('replication_source', mode)
        print(f'[ADMIN] Replication source mode changed to: {mode}')
        return jsonify({'success': True, 'mode': mode})
    except Exception as e:
        db.session.rollback()
        print(f'[ADMIN] Failed to set replication source mode: {e}')
        return jsonify({'error': 'FAILED TO UPDATE SETTING'}), 500

HEALTH_CHECK_PRESETS = {
    'frequent': {'seconds': 60,   'label': '1 MINUTE',   'approx_per_day': 1440},
    'normal':   {'seconds': 300,  'label': '5 MINUTES',  'approx_per_day': 288},
    'relaxed':  {'seconds': 900,  'label': '15 MINUTES', 'approx_per_day': 96},
    'minimal':  {'seconds': 3600, 'label': '1 HOUR',     'approx_per_day': 24},
}

@app.route('/admin/api/storage/health-check-interval')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_health_check_interval_get():
    """Get current health check interval preset"""
    current_seconds = get_numeric_setting('health_check_interval')
    # Find matching preset name or default to 'normal'
    current_preset = 'normal'
    for name, cfg in HEALTH_CHECK_PRESETS.items():
        if cfg['seconds'] == current_seconds:
            current_preset = name
            break
    presets = {}
    for name, cfg in HEALTH_CHECK_PRESETS.items():
        presets[name] = {'seconds': cfg['seconds'], 'label': cfg['label'], 'approx_per_day': cfg['approx_per_day']}
    return jsonify({'preset': current_preset, 'seconds': current_seconds, 'presets': presets})

@app.route('/admin/api/storage/health-check-interval', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_health_check_interval_set():
    """Set health check interval preset"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or 'preset' not in data:
        return jsonify({'error': 'HEALTH CHECK PRESET REQUIRED'}), 400
    preset = data['preset']
    valid_presets = list(HEALTH_CHECK_PRESETS.keys())
    if preset not in valid_presets:
        return jsonify({'error': f'INVALID PRESET. VALID: {", ".join(valid_presets).upper()}'}), 400
    seconds = HEALTH_CHECK_PRESETS[preset]['seconds']
    try:
        # AUDIT FIX A1: set_setting() invalidates the settings cache; the direct
        # row write did not.
        set_setting('health_check_interval', seconds)
        print(f'[ADMIN] Health check interval changed to: {preset} ({seconds}s)')
        return jsonify({'success': True, 'preset': preset, 'seconds': seconds})
    except Exception as e:
        db.session.rollback()
        print(f'[ADMIN] Failed to set health check interval: {e}')
        return jsonify({'error': 'FAILED TO UPDATE SETTING'}), 500

@app.route('/admin/api/storage/verify-checksum')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_verify_checksum_get():
    """Get current checksum verification setting"""
    enabled = (get_setting_value('replication_verify_checksum') or 'false').lower() in ('true', '1', 'yes')
    return jsonify({'enabled': enabled})

@app.route('/admin/api/storage/verify-checksum', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_verify_checksum_set():
    """Toggle checksum verification for replication transfers"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or 'enabled' not in data:
        return jsonify({'error': 'ENABLED FIELD REQUIRED'}), 400
    if not isinstance(data['enabled'], bool):
        return jsonify({'error': 'ENABLED MUST BE A BOOLEAN'}), 400
    enabled = data['enabled']
    try:
        # AUDIT FIX A1: set_setting() invalidates the settings cache. Previously
        # turning checksum verification ON after a corruption incident silently
        # did nothing for up to 60 seconds.
        set_setting('replication_verify_checksum', 'true' if enabled else 'false')
        state = 'ENABLED' if enabled else 'DISABLED'
        print(f'[ADMIN] Replication checksum verification {state}')
        return jsonify({'success': True, 'enabled': enabled})
    except Exception as e:
        db.session.rollback()
        print(f'[ADMIN] Failed to set checksum verification: {e}')
        return jsonify({'error': 'FAILED TO UPDATE SETTING'}), 500

REPLICATION_WORKER_PRESETS = {
    '1':  {'workers': 1,  'label': '1 WORKER',   'desc': 'SEQUENTIAL TRANSFERS'},
    '2':  {'workers': 2,  'label': '2 WORKERS',  'desc': 'LIGHT PARALLELISM'},
    '3':  {'workers': 3,  'label': '3 WORKERS',  'desc': 'BALANCED (DEFAULT)'},
    '5':  {'workers': 5,  'label': '5 WORKERS',  'desc': 'HIGHER THROUGHPUT'},
    '10': {'workers': 10, 'label': '10 WORKERS', 'desc': 'MAXIMUM PARALLELISM'},
}

@app.route('/admin/api/storage/replication-workers')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_replication_workers_get():
    """Get current replication worker count"""
    workers = get_numeric_setting('replication_workers')
    workers = max(1, min(workers, 10))
    presets = {}
    for name, cfg in REPLICATION_WORKER_PRESETS.items():
        presets[name] = {'workers': cfg['workers'], 'label': cfg['label'], 'desc': cfg['desc']}
    return jsonify({'workers': workers, 'presets': presets})

@app.route('/admin/api/storage/replication-workers', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_replication_workers_set():
    """Set replication worker count"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or 'workers' not in data:
        return jsonify({'error': 'WORKERS COUNT REQUIRED'}), 400
    workers = str(data['workers'])
    if workers not in REPLICATION_WORKER_PRESETS:
        return jsonify({'error': f'INVALID WORKERS COUNT. VALID: {", ".join(REPLICATION_WORKER_PRESETS.keys())}'}), 400
    try:
        # AUDIT FIX A1: set_setting() invalidates the settings cache; the direct
        # row write did not.
        set_setting('replication_workers', workers)
        print(f'[ADMIN] Replication workers changed to: {workers}')
        return jsonify({'success': True, 'workers': int(workers)})
    except Exception as e:
        db.session.rollback()
        print(f'[ADMIN] Failed to set replication workers: {e}')
        return jsonify({'error': 'FAILED TO UPDATE SETTING'}), 500

def _purge_local_background(app_ref, storage_ref, run_id):
    """Background thread: purge local copies with progress tracking."""
    with app_ref.app_context():
        def on_progress(phase, current, total, results):
            _write_purge_progress({
                'status': 'running',
                'phase': phase,
                'current': current,
                'total': total,
                'purged_files': results.get('purged_files', 0),
                'purged_notes': results.get('purged_notes', 0),
                'purged_thumbnails': results.get('purged_thumbnails', 0),
                'skipped_files': results.get('skipped_files', 0),
                'skipped_notes': results.get('skipped_notes', 0),
                'skipped_thumbnails': results.get('skipped_thumbnails', 0),
                'bytes_freed': results.get('bytes_freed', 0),
                'updated_at': time.time()
            }, run_id=run_id)
        try:
            result = storage_ref.purge_local_copies(progress_callback=on_progress)
            if 'error' in result:
                _write_purge_progress(
                    {'status': 'error', 'error': result['error'], 'updated_at': time.time()},
                    run_id=run_id)
                print(f'[ADMIN] Background purge error: {result["error"]}')
            else:
                _write_purge_progress({
                    'status': 'completed',
                    'purged_files': result.get('purged_files', 0),
                    'purged_notes': result.get('purged_notes', 0),
                    'purged_thumbnails': result.get('purged_thumbnails', 0),
                    'skipped_files': result.get('skipped_files', 0),
                    'skipped_notes': result.get('skipped_notes', 0),
                    'skipped_thumbnails': result.get('skipped_thumbnails', 0),
                    'bytes_freed': result.get('bytes_freed', 0),
                    'updated_at': time.time()
                }, run_id=run_id)
                total = result['purged_files'] + result['purged_notes'] + result['purged_thumbnails']
                print(f'[ADMIN] Background purge completed: {result["purged_files"]} files, {result["purged_notes"]} notes, {result["purged_thumbnails"]} thumbnails ({result["bytes_freed"]} bytes freed)')
        except Exception as e:
            _write_purge_progress(
                {'status': 'error', 'error': str(e), 'updated_at': time.time()},
                run_id=run_id)
            print(f'[ADMIN] Background purge failed: {e}')

@app.route('/admin/api/storage/purge-local', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_purge_local():
    """Start a background purge of local copies that are synced to at least one remote node."""
    start_lock = _acquire_purge_start_lock()
    try:
        progress = _read_purge_progress()
        if progress.get('status') == 'running':
            # Allow restart if stale (no update in 2 minutes)
            if time.time() - progress.get('updated_at', 0) < 120:
                return jsonify({'error': 'PURGE ALREADY IN PROGRESS'}), 409
            print(f'[ADMIN] Stale purge detected (last update {time.time() - progress.get("updated_at", 0):.0f}s ago), allowing restart')
        run_id = uuid.uuid4().hex
        initial_state = {
            'run_id': run_id,
            'status': 'running', 'phase': 'starting',
            'current': 0, 'total': 0,
            'purged_files': 0, 'purged_notes': 0, 'purged_thumbnails': 0,
            'skipped_files': 0, 'skipped_notes': 0, 'skipped_thumbnails': 0, 'bytes_freed': 0,
            'updated_at': time.time()
        }
        if not _write_purge_progress(initial_state, lock_held=True):
            return jsonify({'error': 'FAILED TO INITIALIZE PURGE'}), 500
        t = threading.Thread(
            target=_purge_local_background, args=(app, storage, run_id), daemon=True)
        try:
            t.start()
        except Exception as e:
            _write_purge_progress({
                'status': 'error', 'error': str(e), 'updated_at': time.time()
            }, run_id=run_id, lock_held=True)
            print(f'[ADMIN] Failed to start background local purge: {e}')
            return jsonify({'error': 'FAILED TO START PURGE'}), 500
    finally:
        _release_scoped_lock(start_lock)
    print(f'[ADMIN] Started background local purge')
    return jsonify({'success': True, 'status': 'started'})

@app.route('/admin/api/storage/purge-local/progress')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_storage_purge_local_progress():
    """Poll progress of a running background purge."""
    progress = _read_purge_progress()
    # Auto-clear completed/error states older than 60 seconds
    if progress.get('status') in ('completed', 'error'):
        if time.time() - progress.get('updated_at', 0) > 60:
            if not _clear_purge_progress(run_id=progress.get('run_id')):
                return jsonify(_read_purge_progress())
            return jsonify({'status': 'idle'})
    # Detect stale running state (no update in 2 minutes = thread died)
    if progress.get('status') == 'running':
        if time.time() - progress.get('updated_at', 0) > 120:
            updated = _write_purge_progress(
                {'status': 'error', 'error': 'PURGE TIMED OUT (WORKER MAY HAVE RESTARTED)', 'updated_at': time.time()},
                run_id=progress.get('run_id'))
            if not updated:
                return jsonify(_read_purge_progress())
            return jsonify({'status': 'error', 'error': 'PURGE TIMED OUT (WORKER MAY HAVE RESTARTED)'})
    return jsonify(progress)

@app.route('/admin/api/music/rescan', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_music_rescan():
    """Force a re-scan of the on-disk music library.

    AUDIT FIX A16: _scan_available_songs() previously ran ONCE at import with no
    way to re-run it, so a newly added album stayed invisible and a deleted one
    kept 404ing until `systemctl restart`. The cleanup job now re-scans on a
    timer; this is the manual override."""
    try:
        maybe_rescan_available_songs(force=True)
    except Exception as e:
        print(f'[ADMIN] Music library rescan failed: {e}')
        return jsonify({'error': 'MUSIC LIBRARY RESCAN FAILED'}), 500
    available = len(_AVAILABLE_SONG_IDS)
    print(f'[ADMIN] Music library rescan complete: {available} song(s) available on disk')
    return jsonify({'success': True, 'available_songs': available})

# ─── Admin Notification CRUD Endpoints ────────────────────────────────

@app.route('/admin/api/notifications')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications():
    """List all notifications for admin management"""
    notifs = Notification.query.order_by(Notification.created_at.desc()).all()
    result = []
    for n in notifs:
        result.append({
            'id': n.id,
            'title': n.title,
            'message': n.message,
            'bg_color': n.bg_color or '#DE1833',
            'display_trigger': n.display_trigger,
            'auto_dismiss': n.auto_dismiss,
            'dismiss_seconds': n.dismiss_seconds,
            'is_active': n.is_active,
            'expires_at': n.expires_at.isoformat() if n.expires_at else None,
            'created_at': n.created_at.isoformat() if n.created_at else None,
            'created_by': n.created_by,
        })
    return jsonify(result)

@app.route('/admin/api/notifications', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications_create():
    """Create a new notification"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'INVALID REQUEST'}), 400
    message = data.get('message')
    title = data.get('title', '')
    if not isinstance(message, str) or not message.strip():
        return jsonify({'error': 'MESSAGE IS REQUIRED'}), 400
    # AUDIT FIX (finding 18): bound both fields -- notification rows are
    # loaded wholesale on every page render, so an unbounded message (or
    # title) let one admin call bloat every subsequent response.
    if len(message) > 5000:
        return jsonify({'error': 'MESSAGE TOO LONG (MAX 5000 CHARACTERS)'}), 400
    if not isinstance(title, str):
        return jsonify({'error': 'TITLE MUST BE TEXT'}), 400
    if len(title) > 120:
        return jsonify({'error': 'TITLE TOO LONG (MAX 120 CHARACTERS)'}), 400
    title = title.strip()
    if len(title) > 120:
        return jsonify({'error': 'TITLE TOO LONG (MAX 120 CHARACTERS)'}), 400

    valid_triggers = {'always', 'on_register', 'first_login', 'every_login', 'once_login'}
    trigger = data.get('display_trigger', 'always')
    if not isinstance(trigger, str) or trigger not in valid_triggers:
        return jsonify({'error': 'INVALID DISPLAY TRIGGER'}), 400

    bg_color_value = data.get('bg_color', '#DE1833')
    if not isinstance(bg_color_value, str):
        return jsonify({'error': 'BACKGROUND COLOR MUST BE TEXT'}), 400
    bg_color = bg_color_value.strip()
    if not bg_color or len(bg_color) != 7 or not bg_color.startswith('#'):
        bg_color = '#DE1833'

    expires_at = None
    if data.get('expires_at'):
        try:
            expires_at = datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00'))
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            expires_at = expires_at.astimezone(timezone.utc)
        except (ValueError, AttributeError):
            return jsonify({'error': 'INVALID EXPIRY DATE FORMAT'}), 400

    auto_dismiss = data.get('auto_dismiss', False)
    if not isinstance(auto_dismiss, bool):
        return jsonify({'error': 'AUTO_DISMISS MUST BE A BOOLEAN'}), 400
    dismiss_seconds = None
    if auto_dismiss:
        try:
            dismiss_seconds = int(data.get('dismiss_seconds', 10))
            if dismiss_seconds < 1:
                dismiss_seconds = 1
            if dismiss_seconds > 3600:
                dismiss_seconds = 3600
        except (ValueError, TypeError):
            dismiss_seconds = 10

    notif = Notification(
        title=title or None,
        message=message.strip(),
        bg_color=bg_color,
        display_trigger=trigger,
        auto_dismiss=auto_dismiss,
        dismiss_seconds=dismiss_seconds,
        is_active=True,
        expires_at=expires_at,
        created_by=session.get('logged_in_user_id'),
    )
    db.session.add(notif)
    db.session.commit()

    print(f'[ADMIN] Notification created: id={notif.id}, trigger={trigger}, by user {session.get("logged_in_user_id")}')

    return jsonify({
        'success': True,
        'id': notif.id,
        'title': notif.title,
        'message': notif.message,
        'bg_color': notif.bg_color or '#DE1833',
        'display_trigger': notif.display_trigger,
        'auto_dismiss': notif.auto_dismiss,
        'dismiss_seconds': notif.dismiss_seconds,
        'is_active': notif.is_active,
        'expires_at': notif.expires_at.isoformat() if notif.expires_at else None,
        'created_at': notif.created_at.isoformat() if notif.created_at else None,
    }), 201

@app.route('/admin/api/notifications/<int:notif_id>', methods=['PUT'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications_update(notif_id):
    """Update an existing notification"""
    notif = db.session.get(Notification, notif_id)
    if not notif:
        return jsonify({'error': 'NOTIFICATION NOT FOUND'}), 404

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400

    if 'message' in data:
        if not isinstance(data['message'], str):
            return jsonify({'error': 'MESSAGE MUST BE TEXT'}), 400
        msg = data['message'].strip()
        if not msg:
            return jsonify({'error': 'MESSAGE IS REQUIRED'}), 400
        # AUDIT FIX (finding 18): same bound as the create route.
        if len(msg) > 5000:
            return jsonify({'error': 'MESSAGE TOO LONG (MAX 5000 CHARACTERS)'}), 400
        notif.message = msg

    if 'title' in data:
        if not isinstance(data['title'], str):
            return jsonify({'error': 'TITLE MUST BE TEXT'}), 400
        title = data['title'].strip()
        if len(title) > 120:
            return jsonify({'error': 'TITLE TOO LONG (MAX 120 CHARACTERS)'}), 400
        notif.title = title or None

    if 'bg_color' in data:
        if not isinstance(data['bg_color'], str):
            return jsonify({'error': 'BACKGROUND COLOR MUST BE TEXT'}), 400
        bg = data['bg_color'].strip()
        if bg and len(bg) == 7 and bg.startswith('#'):
            notif.bg_color = bg

    if 'display_trigger' in data:
        valid_triggers = {'always', 'on_register', 'first_login', 'every_login', 'once_login'}
        if not isinstance(data['display_trigger'], str) or data['display_trigger'] not in valid_triggers:
            return jsonify({'error': 'INVALID DISPLAY TRIGGER'}), 400
        notif.display_trigger = data['display_trigger']

    if 'auto_dismiss' in data:
        if not isinstance(data['auto_dismiss'], bool):
            return jsonify({'error': 'AUTO_DISMISS MUST BE A BOOLEAN'}), 400
        notif.auto_dismiss = data['auto_dismiss']
    # The timer is updatable on its own, and enabling auto-dismiss without one
    # gets the create route's default instead of a NULL (never-dismissing) timer.
    if notif.auto_dismiss:
        if 'dismiss_seconds' in data:
            try:
                ds = int(data['dismiss_seconds'])
                notif.dismiss_seconds = max(1, min(3600, ds))
            except (ValueError, TypeError):
                notif.dismiss_seconds = 10
        elif not notif.dismiss_seconds:
            notif.dismiss_seconds = 10
    elif 'auto_dismiss' in data:
        notif.dismiss_seconds = None

    if 'expires_at' in data:
        if data['expires_at']:
            try:
                exp = datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00'))
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                notif.expires_at = exp.astimezone(timezone.utc)
            except (ValueError, AttributeError):
                db.session.rollback()
                return jsonify({'error': 'INVALID EXPIRY DATE FORMAT'}), 400
        else:
            notif.expires_at = None

    db.session.commit()
    print(f'[ADMIN] Notification updated: id={notif.id}')

    return jsonify({
        'success': True,
        'id': notif.id,
        'title': notif.title,
        'message': notif.message,
        'bg_color': notif.bg_color or '#DE1833',
        'display_trigger': notif.display_trigger,
        'auto_dismiss': notif.auto_dismiss,
        'dismiss_seconds': notif.dismiss_seconds,
        'is_active': notif.is_active,
        'expires_at': notif.expires_at.isoformat() if notif.expires_at else None,
        'created_at': notif.created_at.isoformat() if notif.created_at else None,
    })

@app.route('/admin/api/notifications/<int:notif_id>', methods=['DELETE'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications_delete(notif_id):
    """Delete a notification and all its dismissals"""
    notif = db.session.get(Notification, notif_id)
    if not notif:
        return jsonify({'error': 'NOTIFICATION NOT FOUND'}), 404

    db.session.delete(notif)
    db.session.commit()
    print(f'[ADMIN] Notification deleted: id={notif_id}')

    return jsonify({'success': True})

@app.route('/admin/api/notifications/<int:notif_id>/toggle', methods=['POST'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_notifications_toggle(notif_id):
    """Toggle active/inactive state"""
    notif = db.session.get(Notification, notif_id)
    if not notif:
        return jsonify({'error': 'NOTIFICATION NOT FOUND'}), 404

    notif.is_active = not notif.is_active
    db.session.commit()
    state = 'ACTIVATED' if notif.is_active else 'DEACTIVATED'
    print(f'[ADMIN] Notification {state}: id={notif.id}')

    return jsonify({'success': True, 'is_active': notif.is_active})

@app.route('/admin/api/prompt-feedback')
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_prompt_feedback():
    page, per_page = _clamp_pagination(request.args.get('page'), request.args.get('per_page') or 25)
    q = PromptFeedback.query
    search = (request.args.get('search') or '').strip()[:80]
    if search:
        like = '%' + escape_like_pattern(search) + '%'
        q = q.filter(db.or_(
            PromptFeedback.message.like(like, escape='\\'),
            PromptFeedback.prompt_id.like(like, escape='\\'),
            PromptFeedback.kind.like(like, escape='\\'),
        ))
    total = q.count()
    pages = max(1, (total + per_page - 1) // per_page)
    if page > pages:
        page = pages
    rows = q.order_by(PromptFeedback.created_at.desc()).offset((page - 1) * per_page).limit(per_page).all()
    user_ids = [r.user_id for r in rows if r.user_id]
    names = {}
    if user_ids:
        for u in User.query.filter(User.id.in_(user_ids)).all():
            names[u.id] = u.username
    items = []
    for r in rows:
        created = r.created_at
        if created and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        items.append({
            'id': r.id,
            'kind': r.kind,
            'prompt_id': r.prompt_id,
            'message': r.message,
            'username': names.get(r.user_id) if r.user_id else None,
            'created_at': created.isoformat() if created else None,
        })
    return jsonify({'items': items, 'page': page, 'pages': pages, 'total': total})

@app.route('/admin/api/prompt-feedback/<int:fid>', methods=['DELETE'])
@limiter.limit(admin_rate_limit)
@admin_required
def admin_api_prompt_feedback_delete(fid):
    row = db.session.get(PromptFeedback, fid)
    if not row:
        return jsonify({'error': 'FEEDBACK NOT FOUND'}), 404
    db.session.delete(row)
    db.session.commit()
    print(f'[ADMIN] Prompt feedback deleted: id={fid}')
    return jsonify({'success': True})

# ─── Public Notification Endpoints ────────────────────────────────────

_NOTIF_SESSION_TRIGGERS = frozenset(('every_login', 'once_login'))
_NOTIF_ONCE_EVER_TRIGGERS = frozenset(('on_register', 'first_login'))


def _session_id_set(key):
    raw = session.get(key) or []
    try:
        return {int(x) for x in raw}
    except (TypeError, ValueError):
        return set()


def _session_id_add(key, nid):
    lst = list(session.get(key) or [])
    if nid not in lst:
        lst.append(nid)
        session[key] = lst


def _notif_nocache(resp):
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    return resp


