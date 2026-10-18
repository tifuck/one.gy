@app.route('/music/api/likes')
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_likes():
    """Return all liked song IDs for the current user."""
    user_id = session['logged_in_user_id']
    likes = MusicLike.query.filter_by(user_id=user_id).all()
    return jsonify([l.song_id for l in likes])


@app.route('/music/api/likes/<song_id>', methods=['POST'])
@limiter.limit(music_stream_rate_limit)
@_music_required
def music_api_toggle_like(song_id):
    """Toggle like on a song. Returns {liked: bool}."""
    user_id = session['logged_in_user_id']
    # AUDIT FIX L9: bound song_id length so a pathological client cannot
    # persist arbitrary multi-KB junk into the likes table.
    if not isinstance(song_id, str) or len(song_id) == 0 or len(song_id) > 128:
        return jsonify({'error': 'INVALID SONG ID'}), 400
    existing = MusicLike.query.filter_by(user_id=user_id, song_id=song_id).first()
    if existing:
        db.session.delete(existing)
        db.session.commit()
        print(f'[MUSIC] User {user_id} unliked song {song_id}')
        return jsonify({'liked': False})
    else:
        like = MusicLike(user_id=user_id, song_id=song_id, liked_at=datetime.now(timezone.utc))
        db.session.add(like)
        db.session.commit()
        print(f'[MUSIC] User {user_id} liked song {song_id}')
        return jsonify({'liked': True})


@app.route('/music/api/liked-songs')
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_liked_songs():
    """Full liked songs list with metadata, ordered by liked_at DESC."""
    user_id = session['logged_in_user_id']
    likes = MusicLike.query.filter_by(user_id=user_id).order_by(MusicLike.liked_at.desc()).all()
    song_ids = [l.song_id for l in likes]
    songs = _enrich_songs_from_library(song_ids)
    return jsonify(songs)


# ─── Music Playlists API ────────────────────────────────────────────────────

@app.route('/music/api/playlists')
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_playlists():
    """List current user's playlists with song count.

    AUDIT Tier 1: previously this issued 2 SQL queries + 1 SQLite library
    lookup per playlist (COUNT, first song, enrich). 30 playlists = 90
    round-trips. We now compute counts and first-song-id via a single
    GROUP BY on MusicPlaylistSong and enrich all first songs in one batch.
    """
    user_id = session['logged_in_user_id']
    playlists = MusicPlaylist.query.filter_by(user_id=user_id).order_by(MusicPlaylist.updated_at.desc()).all()
    if not playlists:
        return jsonify([])

    playlist_ids = [p.id for p in playlists]

    # Single query: song count per playlist
    count_rows = db.session.query(
        MusicPlaylistSong.playlist_id, db.func.count(MusicPlaylistSong.song_id)
    ).filter(
        MusicPlaylistSong.playlist_id.in_(playlist_ids)
    ).group_by(MusicPlaylistSong.playlist_id).all()
    counts_by_playlist = {pid: int(cnt) for pid, cnt in count_rows}

    # Single query: lowest-position song per playlist (the "cover" song).
    # Group by playlist_id and take MIN(position) to find which row to fetch.
    min_pos_rows = db.session.query(
        MusicPlaylistSong.playlist_id, db.func.min(MusicPlaylistSong.position)
    ).filter(
        MusicPlaylistSong.playlist_id.in_(playlist_ids)
    ).group_by(MusicPlaylistSong.playlist_id).all()
    min_pos_pairs = [(pid, mp) for pid, mp in min_pos_rows if mp is not None]

    first_song_by_playlist = {}
    if min_pos_pairs:
        # Build an OR query: (playlist_id=X AND position=Y) OR ...
        # In practice the pair count is small (one per playlist).
        first_song_rows = db.session.query(
            MusicPlaylistSong.playlist_id, MusicPlaylistSong.song_id, MusicPlaylistSong.position
        ).filter(
            MusicPlaylistSong.playlist_id.in_([pid for pid, _ in min_pos_pairs])
        ).all()
        # Pick the (playlist_id, song_id) that matches the MIN(position) per playlist.
        min_pos_map = dict(min_pos_pairs)
        for pid, sid, pos in first_song_rows:
            if pos == min_pos_map.get(pid) and pid not in first_song_by_playlist:
                first_song_by_playlist[pid] = sid

    # Single enrich call with all first-song ids
    all_first_song_ids = list(first_song_by_playlist.values())
    cover_path_by_song_id = {}
    if all_first_song_ids:
        enriched = _enrich_songs_from_library(all_first_song_ids)
        for entry in enriched:
            sid = entry.get('id') or entry.get('song_id')
            if sid is not None:
                cover_path_by_song_id[sid] = entry.get('cover_path')

    result = []
    for p in playlists:
        first_song_id = first_song_by_playlist.get(p.id)
        cover_path = cover_path_by_song_id.get(first_song_id) if first_song_id is not None else None
        result.append({
            'id': p.id, 'name': p.name, 'description': p.description,
            'song_count': counts_by_playlist.get(p.id, 0),
            'cover_path': cover_path,
            'created_at': p.created_at.isoformat() if p.created_at else None,
            'updated_at': p.updated_at.isoformat() if p.updated_at else None,
        })
    return jsonify(result)


@app.route('/music/api/playlists', methods=['POST'])
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_create_playlist():
    """Create a new playlist."""
    data = _json_object_body()
    # AUDIT FIX A17: {"name": null} used to reach None.strip() -> 500.
    name = _music_json_str(data.get('name'), truncate_to=200)
    if not name:
        return jsonify({'error': 'PLAYLIST NAME IS REQUIRED'}), 400
    user_id = session['logged_in_user_id']
    description = _music_json_str(data.get('description'), truncate_to=500) or None
    playlist = MusicPlaylist(
        user_id=user_id, name=name, description=description,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc)
    )
    db.session.add(playlist)
    db.session.commit()
    print(f'[MUSIC] User {user_id} created playlist "{name}" (id={playlist.id})')
    return jsonify({
        'id': playlist.id, 'name': playlist.name, 'description': playlist.description,
        'song_count': 0, 'cover_path': None,
        'created_at': playlist.created_at.isoformat(),
        'updated_at': playlist.updated_at.isoformat(),
    }), 201


@app.route('/music/api/playlist/<int:playlist_id>')
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_playlist_detail(playlist_id):
    """Get playlist with enriched songs."""
    user_id = session['logged_in_user_id']
    playlist = MusicPlaylist.query.filter_by(id=playlist_id, user_id=user_id).first()
    if not playlist:
        return jsonify({'error': 'PLAYLIST NOT FOUND'}), 404
    song_entries = MusicPlaylistSong.query.filter_by(playlist_id=playlist_id).order_by(MusicPlaylistSong.position).all()
    song_ids = [s.song_id for s in song_entries]
    songs = _enrich_songs_from_library(song_ids)
    total_duration = sum(s.get('duration_ms', 0) for s in songs)
    return jsonify({
        'id': playlist.id, 'name': playlist.name, 'description': playlist.description,
        'song_count': len(songs), 'total_duration_ms': total_duration,
        'songs': songs,
        'created_at': playlist.created_at.isoformat() if playlist.created_at else None,
        'updated_at': playlist.updated_at.isoformat() if playlist.updated_at else None,
    })


@app.route('/music/api/playlist/<int:playlist_id>', methods=['PUT'])
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_update_playlist(playlist_id):
    """Update playlist name/description."""
    user_id = session['logged_in_user_id']
    playlist = MusicPlaylist.query.filter_by(id=playlist_id, user_id=user_id).first()
    if not playlist:
        return jsonify({'error': 'PLAYLIST NOT FOUND'}), 404
    data = _json_object_body()
    if not data:
        return jsonify({'error': 'INVALID REQUEST'}), 400
    # AUDIT FIX A17: {"name": null} used to reach None.strip() -> 500.
    if 'name' in data:
        new_name = _music_json_str(data.get('name'), truncate_to=200)
        if new_name:
            playlist.name = new_name
    if 'description' in data:
        playlist.description = _music_json_str(data.get('description'), truncate_to=500) or None
    playlist.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    print(f'[MUSIC] User {user_id} updated playlist {playlist_id}')
    return jsonify({'success': True})


@app.route('/music/api/playlist/<int:playlist_id>', methods=['DELETE'])
@limiter.limit(music_api_rate_limit)
@_music_required
def music_api_delete_playlist(playlist_id):
    """Delete a playlist."""
    user_id = session['logged_in_user_id']
    playlist = MusicPlaylist.query.filter_by(id=playlist_id, user_id=user_id).first()
    if not playlist:
        return jsonify({'error': 'PLAYLIST NOT FOUND'}), 404
    db.session.delete(playlist)
    db.session.commit()
    print(f'[MUSIC] User {user_id} deleted playlist {playlist_id}')
    return jsonify({'success': True})


@app.route('/music/api/playlist/<int:playlist_id>/songs', methods=['POST'])
@limiter.limit(music_stream_rate_limit)
@_music_required
def music_api_playlist_songs(playlist_id):
    """Add, remove, or reorder songs in a playlist.
    Actions: {action: 'add', song_id}, {action: 'remove', song_id}, {action: 'reorder', song_ids: [...]}"""
    user_id = session['logged_in_user_id']
    playlist = MusicPlaylist.query.filter_by(id=playlist_id, user_id=user_id).first()
    if not playlist:
        return jsonify({'error': 'PLAYLIST NOT FOUND'}), 404
    data = request.get_json()
    if not data or 'action' not in data:
        return jsonify({'error': 'INVALID REQUEST'}), 400
    action = data['action']
    if action == 'add':
        song_id = data.get('song_id')
        if not song_id:
            return jsonify({'error': 'SONG ID REQUIRED'}), 400
        # AUDIT FIX L9: bound song_id length.
        if not isinstance(song_id, str) or len(song_id) > 128:
            return jsonify({'error': 'INVALID SONG ID'}), 400
        # Check if already in playlist
        existing = MusicPlaylistSong.query.filter_by(playlist_id=playlist_id, song_id=song_id).first()
        if existing:
            return jsonify({'error': 'SONG ALREADY IN PLAYLIST'}), 409
        # Get next position
        max_pos = db.session.query(db.func.max(MusicPlaylistSong.position)).filter_by(playlist_id=playlist_id).scalar() or 0
        entry = MusicPlaylistSong(
            playlist_id=playlist_id, song_id=song_id,
            position=max_pos + 1, added_at=datetime.now(timezone.utc)
        )
        db.session.add(entry)
        playlist.updated_at = datetime.now(timezone.utc)
        db.session.commit()
        print(f'[MUSIC] Added song {song_id} to playlist {playlist_id}')
        return jsonify({'success': True, 'position': entry.position})
    elif action == 'remove':
        song_id = data.get('song_id')
        if not song_id:
            return jsonify({'error': 'SONG ID REQUIRED'}), 400
        entry = MusicPlaylistSong.query.filter_by(playlist_id=playlist_id, song_id=song_id).first()
        if not entry:
            return jsonify({'error': 'SONG NOT IN PLAYLIST'}), 404
        db.session.delete(entry)
        playlist.updated_at = datetime.now(timezone.utc)
        db.session.commit()
        print(f'[MUSIC] Removed song {song_id} from playlist {playlist_id}')
        return jsonify({'success': True})
    elif action == 'reorder':
        song_ids = data.get('song_ids', [])
        if not song_ids:
            return jsonify({'error': 'SONG IDS REQUIRED'}), 400
        # AUDIT FIX M5: cap list length + batch via single IN-query lookup.
        if not isinstance(song_ids, list) or len(song_ids) > 5000:
            return jsonify({'error': 'TOO MANY SONG IDS (MAX 5000)'}), 413
        desired_positions = {}
        for i, sid in enumerate(song_ids):
            if isinstance(sid, str) and sid:
                desired_positions.setdefault(sid, i + 1)
        if not desired_positions:
            return jsonify({'success': True})
        if len(song_ids) != len(desired_positions):
            return jsonify({'error': 'SONG IDS MUST BE A COMPLETE PLAYLIST PERMUTATION'}), 400
        entries = MusicPlaylistSong.query.filter_by(playlist_id=playlist_id).all()
        existing_ids = {entry.song_id for entry in entries}
        if set(desired_positions.keys()) != existing_ids:
            return jsonify({'error': 'SONG IDS MUST BE A COMPLETE PLAYLIST PERMUTATION'}), 400
        for entry in entries:
            entry.position = desired_positions[entry.song_id]
        playlist.updated_at = datetime.now(timezone.utc)
        db.session.commit()
        return jsonify({'success': True})
    else:
        return jsonify({'error': 'UNKNOWN ACTION'}), 400


# ─── Music Cross-Device Sync (Spotify Connect-style) ───────────────────────

@app.route('/music/api/sync', methods=['POST'])
@limiter.limit(music_stream_rate_limit)
@_music_required
def music_api_sync_push():
    """Push playback state from the active device. Also upserts device record."""
    user_id = session['logged_in_user_id']
    data = _json_object_body()
    # AUDIT FIX A17: null / non-string values used to raise AttributeError -> 500.
    device_id = _music_json_str(data.get('device_id'))
    device_name = _music_json_str(data.get('device_name'), default='Unknown Device',
                                  truncate_to=_MUSIC_DEVICE_NAME_MAX) or 'Unknown Device'
    state = data.get('state')

    if not _music_valid_device_id(device_id):
        return jsonify({'error': 'DEVICE ID REQUIRED'}), 400

    now = datetime.now(timezone.utc)

    # Upsert device record
    device = MusicDevice.query.filter_by(user_id=user_id, device_id=device_id).first()
    if device:
        device.last_seen = now
        if device_name and device_name != 'Unknown Device':
            device.device_name = device_name
    else:
        device = MusicDevice(user_id=user_id, device_id=device_id, device_name=device_name, last_seen=now, created_at=now)
        db.session.add(device)

    import json as _json
    is_accepted_active = False

    # Store a command result durably, then claim at most one FIFO command for
    # this active target. The per-user lock also gives SQLite test databases the
    # serialization that MariaDB's row lock provides in production.
    command_result_acknowledged = None
    pending_command = None
    mailbox_lock = _music_mailbox_lock(user_id)
    try:
        db.session.flush()
        # Upsert sync state -- only claim active if no other device holds it
        # recently. Decided on the locked, current row: deciding on an earlier
        # plain read let two devices both claim a stale session.
        sync = MusicSyncState.query.filter_by(user_id=user_id).populate_existing().with_for_update().first()
        if sync:
            current_active = sync.active_device_id
            updated = sync.updated_at.replace(tzinfo=timezone.utc) if sync.updated_at and sync.updated_at.tzinfo is None else sync.updated_at
            is_stale = not updated or (now - updated).total_seconds() > 15
            # This device can claim active if: it's already active, or the session is stale, or force flag
            if current_active == device_id or is_stale or data.get('force_active'):
                sync.active_device_id = device_id
                sync.state_json = _json.dumps(state) if state else None
                sync.updated_at = now
                is_accepted_active = True
            # If another device is active and not stale, just update last_seen (don't overwrite)
        else:
            sync = MusicSyncState(user_id=user_id, active_device_id=device_id, state_json=_json.dumps(state) if state else None, updated_at=now)
            db.session.add(sync)
            db.session.flush()
            is_accepted_active = True
        _prune_music_sync_commands(user_id=user_id, now=now)
        command_result = data.get('command_result')
        if command_result and isinstance(command_result, dict):
            command_result_acknowledged = _music_store_command_result(
                user_id, device_id, command_result, now)
        if is_accepted_active and sync.active_device_id == device_id:
            pending_command = _music_claim_next_command(user_id, device_id, now)
        db.session.commit()
    finally:
        _music_mailbox_unlock(mailbox_lock)

    # Check for transfer request.
    transfer_to = sync.transfer_to

    # Build device list (only devices seen in last 30 seconds are "online")
    online_cutoff = now - timedelta(seconds=30)
    all_devices = MusicDevice.query.filter_by(user_id=user_id).filter(MusicDevice.last_seen >= online_cutoff).all()

    # If the active device hasn't been seen in 30s, clear it from sync state
    if sync.active_device_id:
        active_still_online = any(d.device_id == sync.active_device_id for d in all_devices)
        if not active_still_online and sync.active_device_id != device_id:
            sync = _music_clear_stale_active_device(user_id, online_cutoff) or sync
            db.session.commit()

    device_list = []
    for d in all_devices:
        device_list.append({
            'device_id': d.device_id,
            'device_name': d.device_name,
            'is_self': d.device_id == device_id,
            'is_active': d.device_id == sync.active_device_id,
            'last_seen': d.last_seen.isoformat() if d.last_seen else None,
        })

    # Return active_device_id so client knows if it was accepted
    result = {
        'ok': True,
        'is_active': is_accepted_active,
        'active_device_id': sync.active_device_id,
        'transfer_to': transfer_to,
        'pending_command': pending_command,
        'command_result_acknowledged': command_result_acknowledged,
        'devices': device_list,
    }
    # If this device was NOT accepted as active, also return the current state so it can enter phantom
    if not is_accepted_active and sync.state_json:
        try:
            result['state'] = _json.loads(sync.state_json)
        except Exception:
            pass
        # Find active device name
        for d in all_devices:
            if d.device_id == sync.active_device_id:
                result['active_device_name'] = d.device_name
                break

    return jsonify(result)


@app.route('/music/api/sync', methods=['GET'])
@limiter.limit(music_stream_rate_limit)
@_music_required
def music_api_sync_poll():
    """Poll for current playback state and device list. Used by all devices."""
    user_id = session['logged_in_user_id']
    device_id = (request.args.get('device_id') or '').strip()

    # AUDIT FIX A17: reject an over-long id here instead of at the String(36)
    # column as a DataError 500.
    if not _music_valid_device_id(device_id):
        return jsonify({'error': 'DEVICE ID REQUIRED'}), 400

    now = datetime.now(timezone.utc)

    # Update this device's last_seen (upsert)
    device = MusicDevice.query.filter_by(user_id=user_id, device_id=device_id).first()
    if device:
        device.last_seen = now
    else:
        device_name = ((request.args.get('device_name') or 'Unknown Device').strip()[:_MUSIC_DEVICE_NAME_MAX]
                       or 'Unknown Device')
        device = MusicDevice(user_id=user_id, device_id=device_id, device_name=device_name, last_seen=now, created_at=now)
        db.session.add(device)

    # Get sync state
    import json as _json
    sync = MusicSyncState.query.filter_by(user_id=user_id).first()

    # Build device list (only devices seen in last 30 seconds are "online")
    online_cutoff = now - timedelta(seconds=30)
    all_devices = MusicDevice.query.filter_by(user_id=user_id).filter(MusicDevice.last_seen >= online_cutoff).all()

    # If the active device hasn't been seen in 30s, clear it from sync state
    if sync and sync.active_device_id:
        active_still_online = any(d.device_id == sync.active_device_id for d in all_devices)
        if not active_still_online:
            sync = _music_clear_stale_active_device(user_id, online_cutoff)

    # Helper to make naive datetimes comparable with aware ones
    def _aware(dt):
        if dt and dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt

    device_list = []
    for d in all_devices:
        device_list.append({
            'device_id': d.device_id,
            'device_name': d.device_name,
            'is_self': d.device_id == device_id,
            'is_active': sync and sync.active_device_id == d.device_id and sync.updated_at and (now - _aware(sync.updated_at)).total_seconds() < 30,
            'last_seen': d.last_seen.isoformat() if d.last_seen else None,
        })

    # Build state response
    state_data = None
    active_device_name = None
    state_updated_at = None
    is_stale = True
    if sync and sync.state_json and sync.updated_at:
        staleness = (now - _aware(sync.updated_at)).total_seconds()
        is_stale = staleness > 10
        state_updated_at = _aware(sync.updated_at).isoformat()
        if not is_stale:
            try:
                state_data = _json.loads(sync.state_json)
            except Exception:
                state_data = None
            # Find active device name
            for d in all_devices:
                if d.device_id == sync.active_device_id:
                    active_device_name = d.device_name
                    break

    # Results are requester-addressed and remain durable until an explicit ack.
    pending_result = _music_pending_result(user_id, device_id, now)

    db.session.commit()

    return jsonify({
        'active': not is_stale and state_data is not None,
        'active_device_id': sync.active_device_id if sync and not is_stale else None,
        'active_device_name': active_device_name,
        'state': state_data,
        'state_updated_at': state_updated_at,
        'devices': device_list,
        'transfer_to': sync.transfer_to if sync else None,
        'pending_result': pending_result,
    })


@app.route('/music/api/sync/transfer', methods=['POST'])
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_sync_transfer():
    """Request playback transfer to a target device. Empty target_device_id clears the transfer."""
    user_id = session['logged_in_user_id']
    data = _json_object_body()
    # AUDIT FIX A17: null / non-string values used to raise AttributeError -> 500.
    target_device_id = _music_json_str(data.get('target_device_id'))
    if target_device_id and not _music_valid_device_id(target_device_id):
        return jsonify({'error': 'INVALID TARGET DEVICE ID'}), 400

    sync = MusicSyncState.query.filter_by(user_id=user_id).first()
    if not sync:
        return jsonify({'error': 'NO ACTIVE SYNC SESSION'}), 404

    if target_device_id:
        # AUDIT FIX A17: the caller-supplied target used to be written straight
        # into sync.transfer_to / sync.active_device_id with NO ownership or
        # existence check, so any string wedged playback for the account by
        # pointing it at a device that does not exist.
        target_device = MusicDevice.query.filter_by(
            user_id=user_id, device_id=target_device_id).first()
        if not target_device:
            return jsonify({'error': 'DEVICE NOT FOUND'}), 404
        # Request transfer to target device — also update active_device_id immediately
        # so the target device's first force-push is accepted without delay
        sync.transfer_to = target_device_id
        sync.active_device_id = target_device_id
        sync.updated_at = datetime.now(timezone.utc)
        print(f'[MUSIC] User {user_id} requested transfer to device {target_device_id[:8]}')
    else:
        # Clear transfer flag (called by accepting device after it takes over)
        sync.transfer_to = None

    db.session.commit()
    return jsonify({'ok': True})


@app.route('/music/api/sync/command', methods=['POST'])
@limiter.limit(music_stream_rate_limit)
@_music_required
def music_api_sync_command():
    """Send a remote command to the active device (from phantom device)."""
    user_id = session['logged_in_user_id']
    data = _json_object_body()
    command = data.get('command')

    if not command or not isinstance(command, dict):
        return jsonify({'error': 'COMMAND REQUIRED'}), 400

    action = command.get('action', '')
    if action not in ('play', 'pause', 'next', 'prev', 'seek', 'set_volume', 'play_tracks'):
        return jsonify({'error': 'UNKNOWN COMMAND'}), 400

    requester_device_id = _music_json_str(data.get('requester_device_id'))
    if not _music_valid_device_id(requester_device_id):
        return jsonify({'error': 'REQUESTER DEVICE ID REQUIRED'}), 400
    payload_json = _music_command_payload(command)
    if payload_json is None:
        return jsonify({'error': 'COMMAND PAYLOAD TOO LARGE OR INVALID'}), 413

    now = datetime.now(timezone.utc)
    mailbox_lock = _music_mailbox_lock(user_id)
    try:
        sync = MusicSyncState.query.filter_by(user_id=user_id).with_for_update().first()
        if not sync or not sync.active_device_id:
            return jsonify({'error': 'NO ACTIVE SYNC SESSION'}), 404

        updated = sync.updated_at
        if updated and updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        target_device_id = sync.active_device_id
        target_device = MusicDevice.query.filter_by(
            user_id=user_id, device_id=target_device_id).first()
        requester_device = MusicDevice.query.filter_by(
            user_id=user_id, device_id=requester_device_id).first()
        if not requester_device:
            return jsonify({'error': 'REQUESTER DEVICE NOT FOUND'}), 404
        if not target_device or not updated or (now - updated).total_seconds() > 30:
            return jsonify({'error': 'NO ACTIVE SYNC SESSION'}), 404
        if target_device_id == requester_device_id:
            return jsonify({'error': 'COMMAND TARGET MUST BE A REMOTE DEVICE'}), 400

        _prune_music_sync_commands(user_id=user_id, now=now)
        live_count = MusicSyncCommand.query.filter(
            MusicSyncCommand.user_id == user_id,
            MusicSyncCommand.status.in_(('pending', 'claimed', 'completed')),
        ).count()
        if live_count >= _MUSIC_COMMAND_MAX_LIVE_PER_USER:
            db.session.rollback()
            return jsonify({'error': 'MUSIC COMMAND MAILBOX FULL'}), 429

        command_row = MusicSyncCommand(
            command_id=str(uuid.uuid4()),
            user_id=user_id,
            requester_device_id=requester_device_id,
            target_device_id=target_device_id,
            payload_json=payload_json,
            status='pending',
            created_at=now,
            expires_at=now + _MUSIC_COMMAND_TTL,
        )
        db.session.add(command_row)
        db.session.commit()
        return jsonify({
            'ok': True,
            'command_id': command_row.command_id,
            'requester_device_id': requester_device_id,
            'target_device_id': target_device_id,
        })
    finally:
        _music_mailbox_unlock(mailbox_lock)


@app.route('/music/api/sync/command/ack', methods=['POST'])
@limiter.limit(music_stream_rate_limit)
@_music_required
def music_api_sync_command_ack():
    """Acknowledge consumption of one result by its requesting device."""
    user_id = session['logged_in_user_id']
    data = _json_object_body()
    command_id = _music_json_str(data.get('command_id'))
    requester_device_id = _music_json_str(data.get('device_id'))
    if not command_id or not _music_valid_device_id(requester_device_id):
        return jsonify({'error': 'COMMAND ID AND DEVICE ID REQUIRED'}), 400

    mailbox_lock = _music_mailbox_lock(user_id)
    try:
        command = MusicSyncCommand.query.filter_by(
            user_id=user_id,
            command_id=command_id,
            requester_device_id=requester_device_id,
        ).with_for_update().first()
        if not command or command.status not in ('completed', 'acknowledged'):
            return jsonify({'error': 'COMMAND RESULT NOT FOUND'}), 404
        if command.status == 'completed':
            now = datetime.now(timezone.utc)
            command.status = 'acknowledged'
            command.acknowledged_at = now
            command.consumed_at = now
            db.session.commit()
        return jsonify({'ok': True, 'command_id': command.command_id})
    finally:
        _music_mailbox_unlock(mailbox_lock)


@app.route('/music/api/sync/device', methods=['PUT'])
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_sync_device_rename():
    """Rename a device."""
    user_id = session['logged_in_user_id']
    data = _json_object_body()
    # AUDIT FIX A17: null / non-string values used to raise AttributeError -> 500.
    device_id = _music_json_str(data.get('device_id'))
    name = _music_json_str(data.get('name'), truncate_to=_MUSIC_DEVICE_NAME_MAX)

    if not _music_valid_device_id(device_id) or not name:
        return jsonify({'error': 'DEVICE ID AND NAME REQUIRED'}), 400

    device = MusicDevice.query.filter_by(user_id=user_id, device_id=device_id).first()
    if not device:
        return jsonify({'error': 'DEVICE NOT FOUND'}), 404

    device.device_name = name
    db.session.commit()
    print(f'[MUSIC] User {user_id} renamed device {device_id} to {name}')

    return jsonify({'ok': True, 'name': name})


@app.route('/music/api/sync/device', methods=['DELETE'])
@limiter.limit(music_detail_rate_limit)
@_music_required
def music_api_sync_device_delete():
    """Delete a device from the user's device list."""
    user_id = session['logged_in_user_id']
    data = _json_object_body()
    # AUDIT FIX A17: null / non-string values used to raise AttributeError -> 500.
    device_id = _music_json_str(data.get('device_id'))

    if not _music_valid_device_id(device_id):
        return jsonify({'error': 'DEVICE ID REQUIRED'}), 400

    device = MusicDevice.query.filter_by(user_id=user_id, device_id=device_id).first()
    if not device:
        return jsonify({'error': 'DEVICE NOT FOUND'}), 404

    db.session.delete(device)

    # If this was the active device, clear sync state
    sync = MusicSyncState.query.filter_by(user_id=user_id).first()
    if sync and sync.active_device_id == device_id:
        sync.active_device_id = None
        sync.state_json = None
        sync.transfer_to = None

    db.session.commit()
    print(f'[MUSIC] User {user_id} deleted device {device_id}')

    return jsonify({'ok': True})


