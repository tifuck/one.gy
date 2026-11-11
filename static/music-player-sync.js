// ─── ONE.GY Music Player: Cross-device sync engine (polling, pushing, commands, transfers) ───
;(function(mp) {
  'use strict'

  const { _jsonHeaders, _lsSet, _ssSet, audio, _coverUrl } = mp

  // ─── Sync Engine State (shared sync state lives in core) ────────
  const _SYNC_QUEUE_RADIUS = 100    // tracks pushed on each side of the current one
  let _syncTimer = null             // setTimeout handle for the next sync tick
  let _syncRunning = false          // sync loop wanted (logged in, enabled, music-library)
  let _syncErrorCount = 0           // consecutive failed sync requests (exponential backoff)
  let _syncPollInFlight = false     // at most one GET poll at a time
  let _syncRegisterInFlight = false
  let _syncPushedQueueJson = null   // queue window the server holds under _syncQueueKey
  let _syncQueueKey = null
  let _syncLastPollData = null      // last poll response from server
  let _syncPushPending = false      // debounce flag for push
  let _syncCommandResult = null     // command result to send with next push (e.g. play failure)
  let _syncResultAckPending = null  // requester result retained until ack POST succeeds
  let _syncResultAckInFlight = false
  let _syncKeepAliveTimer = null    // setInterval handle for silent audio keepalive

  // ─── Cross-Device Sync Engine ─────────────────────────────────

  function _initSyncDeviceId() {
    if (!mp._syncDeviceId) {
      mp._syncDeviceId = crypto.randomUUID ? crypto.randomUUID() : ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
      }))
      _ssSet('mp_device_id', mp._syncDeviceId)
    }
    if (!mp._syncDeviceName) {
      mp._syncDeviceName = _detectDeviceName()
      _lsSet('mp_device_name', mp._syncDeviceName)
    }
  }

  function _detectDeviceName() {
    var ua = navigator.userAgent || ''
    var platform = ''
    var browser = ''
    // Detect platform
    if (/iPad/.test(ua)) platform = 'iPad'
    else if (/iPhone/.test(ua)) platform = 'iPhone'
    else if (/Android/.test(ua)) platform = 'Android'
    else if (/Mac OS X/.test(ua)) platform = 'Mac'
    else if (/Windows/.test(ua)) platform = 'Windows'
    else if (/Linux/.test(ua)) platform = 'Linux'
    else if (/CrOS/.test(ua)) platform = 'ChromeOS'
    else platform = 'Device'
    // Detect browser
    if (/Edg\//.test(ua)) browser = 'Edge'
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera'
    else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'Chrome'
    else if (/Firefox\//.test(ua)) browser = 'Firefox'
    else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari'
    else browser = 'Browser'
    return browser + ' on ' + platform
  }

  // Sync runs as one setTimeout chain whose delay follows the current role.
  // Calling it again (local play, panel open) runs a tick right away.
  function _syncStart() {
    if (!mp._syncLoggedIn || !mp._syncEnabled) return
    _syncRunning = true
    _syncKick()
  }

  function _syncStop() {
    _syncRunning = false
    if (_syncTimer) {
      clearTimeout(_syncTimer)
      _syncTimer = null
    }
    _syncStopKeepAlive()
  }

  function _syncKick() {
    if (!_syncRunning) return
    if (_syncTimer) clearTimeout(_syncTimer)
    _syncTick()
  }

  function _syncTick() {
    _syncTimer = null
    if (!_syncRunning) return
    var delay = _syncNextDelay()
    if (delay === null) return  // hidden and idle: visibilitychange kicks it again
    _syncPoll()
    _syncTimer = setTimeout(_syncTick, delay)
  }

  // Fast only while there is something to follow: this device is the active
  // one (heartbeat under the server's 10 s staleness + remote commands), it
  // mirrors a remote one, or another device is online. Idle: slow while
  // visible, stopped while hidden. Failures back off exponentially.
  function _syncNextDelay() {
    var others = mp._syncDevices.some(function(d) { return !d.is_self })
    var pushing = mp._syncIsActive && mp._context === 'music-library' && (mp.isPlaying || (mp.isVisible && mp.currentIndex >= 0))
    var delay
    if (pushing) delay = others ? 1000 : 3000
    else if (mp._syncPhantomMode) delay = document.hidden ? 5000 : 1000
    else if (document.hidden) return null
    else delay = others ? 3000 : 15000
    if (_syncErrorCount) delay = Math.max(delay, Math.min(30000, 1000 * Math.pow(2, _syncErrorCount)))
    return delay
  }

  // fetch + JSON with a timeout, so an in-flight flag can never stick.
  function _syncFetch(url, options) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null
    var timer = controller ? setTimeout(function() { controller.abort() }, 10000) : null
    if (controller) options.signal = controller.signal
    return fetch(url, options).then(function(r) {
      if (!r.ok) {
        var err = new Error('sync request failed: ' + r.status)
        err.status = r.status
        throw err
      }
      return r.json()
    }).finally(function() {
      if (timer) clearTimeout(timer)
    })
  }

  function _syncOnError(err) {
    if (err && (err.status === 401 || err.status === 403)) {
      _syncStop()  // signed out or music disabled: polling cannot succeed
      return
    }
    _syncErrorCount++
  }

  // Polls never create device rows server-side; register this tab once the
  // server reports it unknown (first poll, or after a device removal).
  function _syncRegisterDevice() {
    if (_syncRegisterInFlight) return
    _syncRegisterInFlight = true
    _syncFetch('/music/api/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ device_id: mp._syncDeviceId, device_name: mp._syncDeviceName, register_only: true }),
    }).catch(function() {}).then(function() {
      _syncRegisterInFlight = false
    })
  }

  function _syncNum(v) {
    return Number.isFinite(v) ? v : 0
  }

  // Remote sync state is untrusted: rebuild each track from validated fields.
  // The stream URL is derived from the song id, never taken from the state.
  function _syncTracksFromState(state) {
    if (!state || !Array.isArray(state.playlist) || !state.playlist.length) return null
    var tracks = []
    for (var i = 0; i < state.playlist.length; i++) {
      var t = state.playlist[i]
      if (!t || typeof t.id !== 'string' || !/^[\w.-]{1,36}$/.test(t.id)) return null
      var artists = (Array.isArray(t.artists) ? t.artists : []).filter(function(a) {
        return a && typeof a.name === 'string' && (typeof a.id === 'string' || typeof a.id === 'number')
      }).map(function(a) { return { id: a.id, name: a.name } })
      tracks.push({
        id: t.id,
        name: typeof t.name === 'string' ? t.name : 'Unknown',
        extension: 'opus',
        isE2E: false,
        sourceUrl: '/music/stream/' + encodeURIComponent(t.id),
        blobUrl: null,
        coverPath: _coverUrl(t.coverPath) ? t.coverPath : null,
        artistName: artists.map(function(a) { return a.name }).join(', '),
        artistIds: artists.map(function(a) { return a.id }),
        artists: artists,
        albumId: (typeof t.albumId === 'string' || typeof t.albumId === 'number') ? t.albumId : null,
        suggested: t.suggested === true,
      })
    }
    return tracks
  }

  // Silent audio keepalive — plays a tiny silent buffer every 25s to prevent
  // the browser from revoking autoplay permission when the active device is
  // paused.  Without this, remote play commands fail because
  // audio.play() is blocked by autoplay policy when there is no recent user
  // gesture and no recent audio output.
  function _syncStartKeepAlive() {
    if (_syncKeepAliveTimer) return  // already running
    function ping() {
      if (!mp._ensureAudioContext()) return
      if (mp._audioCtx.state === 'suspended') {
        mp._audioCtx.resume().catch(function() {})
      }
      try {
        // Create a silent oscillator (gain = 0) for a brief moment
        var osc = mp._audioCtx.createOscillator()
        var silent = mp._audioCtx.createGain()
        silent.gain.value = 0
        osc.connect(silent)
        silent.connect(mp._audioCtx.destination)
        osc.start()
        osc.stop(mp._audioCtx.currentTime + 0.05)  // 50ms silent blip
        osc.onended = function() {
          osc.disconnect()
          silent.disconnect()
        }
      } catch (e) {
        // Ignore — AudioContext may be in a bad state
      }
    }
    ping()  // fire immediately
    _syncKeepAliveTimer = setInterval(ping, 25000)  // then every 25s
    console.log('[MUSIC PLAYER] Sync keepalive started')
  }

  function _syncStopKeepAlive() {
    if (_syncKeepAliveTimer) {
      clearInterval(_syncKeepAliveTimer)
      _syncKeepAliveTimer = null
      console.log('[MUSIC PLAYER] Sync keepalive stopped')
    }
  }

  function _syncPoll() {
    if (!mp._syncLoggedIn || !mp._syncEnabled || !mp._syncDeviceId) return

    if (_syncResultAckPending) _syncAcknowledgeCommandResult()

    // If this device is actively playing music-library content, push state
    if (mp._syncIsActive && mp._context === 'music-library' && mp.isPlaying) {
      _syncStopKeepAlive()  // not needed while actively playing
      _syncPushState()
      return
    }
    // If this device is active but paused, still push (so other devices see paused state)
    if (mp._syncIsActive && mp._context === 'music-library' && mp.isVisible && mp.currentIndex >= 0) {
      _syncStartKeepAlive()  // keep audio context warm so remote commands can play
      _syncPushState()
      return
    }

    // Otherwise, poll for remote state: one GET at a time, and a response that
    // predates a local play / transfer / phantom exit is dropped (it would
    // otherwise undo that action, e.g. throw "play here" back into phantom).
    if (_syncPollInFlight) return
    _syncPollInFlight = true
    var epoch = mp._syncEpoch
    _syncFetch('/music/api/sync?device_id=' + encodeURIComponent(mp._syncDeviceId), {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    }).then(function(data) {
      _syncPollInFlight = false
      _syncErrorCount = 0
      if (data.registered === false) _syncRegisterDevice()
      if (epoch !== mp._syncEpoch) return
      _syncLastPollData = data
      mp._syncDevices = data.devices || []

      // Check if we were requested to transfer to ourselves
      if (data.transfer_to === mp._syncDeviceId) {
        _syncAcceptTransfer(data)
        return
      }

      // If there is an active session on ANOTHER device
      if (data.active && data.active_device_id && data.active_device_id !== mp._syncDeviceId && data.state) {
        mp._syncEnterPhantom(data)
      } else if (mp._syncPhantomMode) {
        // Remote device stopped updating — check if we should pause phantom or exit
        if (data.state_updated_at && !mp._syncPhantomStale) {
          // State existed but server says it's stale (>10s no update) — pause phantom
          mp._syncPausePhantom()
        } else if (!data.state_updated_at) {
          // No state at all — exit phantom entirely
          mp._syncExitPhantom()
        }
        // If already stale, stay paused (don't keep re-entering or exiting)
      }

      // Results remain on the server until this requesting device acknowledges
      // them. Retain the local ack state as well when the POST fails.
      if (data.pending_result && data.pending_result.command_id) {
        if (!_syncResultAckPending || _syncResultAckPending.command_id !== data.pending_result.command_id) {
          _syncResultAckPending = data.pending_result
          _syncHandleCommandResult(data.pending_result)
        }
        _syncAcknowledgeCommandResult()
      }

      mp._syncUpdateDevicesButton()
    }).catch(function(err) {
      _syncPollInFlight = false
      _syncOnError(err)
    })
  }

  function _syncPushState() {
    if (_syncPushPending) return
    _syncPushPending = true

    // Only a window around the current track is pushed (a queue can be
    // hundreds of tracks), and only when it changed: otherwise the server
    // reuses the window it stored under _syncQueueKey.
    var start = Math.max(0, mp.currentIndex - _SYNC_QUEUE_RADIUS)
    var end = Math.min(mp.playlist.length, mp.currentIndex + _SYNC_QUEUE_RADIUS + 1)
    var queue = mp.playlist.slice(start, end).map(function(t) {
      return {
        id: t.id, name: t.name, coverPath: t.coverPath || null,
        artists: (t.artists || []).map(function(a) { return { id: a.id, name: a.name } }),
        albumId: t.albumId || null, suggested: !!t.suggested,
      }
    })
    var queueJson = JSON.stringify(queue)
    var windowOrder = mp.shuffleOrder.filter(function(i) { return i >= start && i < end })
      .map(function(i) { return i - start })
    var statePayload = {
      currentIndex: mp.currentIndex - start,
      currentTime: audio.currentTime || 0,
      duration: (!isNaN(audio.duration) && isFinite(audio.duration)) ? audio.duration : 0,
      isPlaying: mp.isPlaying,
      shuffleMode: mp.shuffleMode,
      repeatMode: mp.repeatMode,
      shuffleOrder: windowOrder,
      shufflePos: windowOrder.indexOf(mp.currentIndex - start),
      suggestedStartIndex: mp._suggestedStartIndex < 0 ? -1 : Math.min(queue.length, Math.max(0, mp._suggestedStartIndex - start)),
    }

    var pushBody = {
      device_id: mp._syncDeviceId,
      device_name: mp._syncDeviceName,
      state: statePayload,
    }
    if (mp._syncForceActive) {
      pushBody.force_active = true
      mp._syncForceActive = false
    }
    var sendsQueue = !!pushBody.force_active || !_syncQueueKey || queueJson !== _syncPushedQueueJson
    if (sendsQueue) statePayload.playlist = queue
    else statePayload.queueKey = _syncQueueKey
    var sentCommandResult = _syncCommandResult
    if (sentCommandResult) pushBody.command_result = sentCommandResult
    var epoch = mp._syncEpoch

    _syncFetch('/music/api/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify(pushBody),
    }).then(function(data) {
      _syncPushPending = false
      _syncErrorCount = 0

      if (sentCommandResult && data.command_result_acknowledged === sentCommandResult.command_id && _syncCommandResult === sentCommandResult) {
        _syncCommandResult = null
      }
      if (sendsQueue && data.queue_key) {
        _syncPushedQueueJson = queueJson
        _syncQueueKey = data.queue_key
      }

      // Update devices list from POST response
      if (data.devices) {
        mp._syncDevices = data.devices
        mp._syncUpdateDevicesButton()
      }

      // Sent before a local play / transfer: only run a command the server
      // already claimed for us (an unanswered claim blocks the mailbox).
      if (epoch !== mp._syncEpoch) {
        if (data.pending_command) _syncExecuteCommand(data.pending_command)
        return
      }

      // The server no longer holds our queue window: send it right away.
      if (data.need_playlist) {
        _syncQueueKey = null
        setTimeout(_syncPushState, 0)
      }

      // Server rejected us as active — another device holds the active slot
      if (data.is_active === false && data.active_device_id && data.active_device_id !== mp._syncDeviceId) {
        mp._syncIsActive = false
        _syncStopKeepAlive()
        mp._wasPlayingBeforeBackground = false
        audio.pause()
        if (data.state) {
          mp._syncEnterPhantom(data)
        }
        console.log('[MUSIC PLAYER] Server rejected active claim, entering phantom mode')
        return
      }

      // Handle transfer request
      if (data.transfer_to && data.transfer_to !== mp._syncDeviceId) {
        _syncYieldToDevice(data.transfer_to)
      }

      // Handle pending remote command
      if (data.pending_command) {
        _syncExecuteCommand(data.pending_command)
      }
    }).catch(function(err) {
      _syncPushPending = false
      if (pushBody.force_active) mp._syncForceActive = true  // the claim never reached the server
      _syncOnError(err)
    })
  }

  function _syncExecuteCommand(cmd) {
    if (!cmd || !cmd.action || !cmd.command_id) return
    try {
      switch (cmd.action) {
        case 'play':
          mp._resumeAudioContext()
          audio.play().then(function() {
            console.log('[MUSIC PLAYER] Remote play: started OK')
            _syncSetCommandResult(cmd, { ok: true })
          }).catch(function(err) {
            console.warn('[MUSIC PLAYER] Remote play: blocked:', err.name)
            _syncSetCommandResult(cmd, {
              error: 'PLAYBACK BLOCKED ON REMOTE DEVICE - TAP PLAY ON THAT DEVICE FIRST',
              error_code: 'autoplay_blocked'
            })
          })
          break
        case 'pause':
          mp._wasPlayingBeforeBackground = false
          audio.pause()
          _syncSetCommandResult(cmd, { ok: true })
          break
        case 'next':
          mp.playNext()
          _syncSetCommandResult(cmd, { ok: true })
          break
        case 'prev':
          mp.playPrevious()
          _syncSetCommandResult(cmd, { ok: true })
          break
        case 'seek':
          if (Number.isFinite(cmd.seekTime) && cmd.seekTime >= 0 && !isNaN(audio.duration)) {
            audio.currentTime = Math.min(cmd.seekTime, audio.duration)
          }
          _syncSetCommandResult(cmd, { ok: true })
          break
        default:
          // Answer anyway: an unanswered claimed command blocks the mailbox.
          _syncSetCommandResult(cmd, { error: 'UNSUPPORTED REMOTE COMMAND', error_code: 'invalid_command' })
      }
    } catch (err) {
      _syncSetCommandResult(cmd, {
        error: 'REMOTE COMMAND FAILED',
        error_code: 'execution_failed'
      })
    }
  }

  function _syncSetCommandResult(cmd, result) {
    result.command_id = cmd.command_id
    result.action = cmd.action
    _syncCommandResult = result
  }

  function _syncAcceptTransfer(data) {
    var state = data.state
    var remoteTracks = _syncTracksFromState(state)
    if (!remoteTracks) return
    mp._syncEpoch++

    // Clear transfer flag on server
    fetch('/music/api/sync/transfer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ target_device_id: '' }),
    }).catch(function() {})

    // Exit phantom mode and clean up interpolation
    mp._syncPhantomMode = false
    mp._syncPhantomTrackId = null
    mp._syncPhantomStale = false
    mp._syncPhantomStateTs = null
    mp._syncPhantomKeepaliveActive = false
    if (mp._syncPhantomRAF) { cancelAnimationFrame(mp._syncPhantomRAF); mp._syncPhantomRAF = null }
    if (mp._syncPhantomPositionTimer) { clearInterval(mp._syncPhantomPositionTimer); mp._syncPhantomPositionTimer = null }
    if (mp.playerEl) mp.playerEl.classList.remove('mp-phantom')
    if (mp.phantomLabel) mp.phantomLabel.textContent = ''

    // Stop silent keepalive — real audio is about to play
    audio.loop = false

    // Load the remote playlist and start playing
    mp._context = 'music-library'
    mp.playlist = remoteTracks
    mp._suggestedStartIndex = Number.isInteger(state.suggestedStartIndex) ? state.suggestedStartIndex : -1
    mp.shuffleMode = state.shuffleMode === true
    mp.repeatMode = (state.repeatMode === 'all' || state.repeatMode === 'one') ? state.repeatMode : 'none'
    mp.shuffleOrder = Array.isArray(state.shuffleOrder) ? state.shuffleOrder.filter(function(i) {
      return Number.isInteger(i) && i >= 0 && i < remoteTracks.length
    }) : []
    mp.shufflePos = Number.isInteger(state.shufflePos) ? state.shufflePos : -1

    // Update shuffle/repeat UI
    if (mp.shuffleBtn) mp.shuffleBtn.classList.toggle('mp-btn-active', mp.shuffleMode)
    mp._updateRepeatButton()

    mp._showPlayer()
    mp._renderPlaylist()

    var idx = state.currentIndex
    if (!Number.isInteger(idx) || idx < 0 || idx >= mp.playlist.length) idx = 0
    var seekTo = _syncNum(state.currentTime)

    mp._syncIsActive = true  // This device is now the active one
    mp._syncForceActive = true  // Force claim — explicit transfer
    mp._loadTrack(idx)
    var transferSeq = mp._loadSeq

    // Seek to the remote position after the track loads (unless another
    // track was started first)
    var onCanPlay = function() {
      audio.removeEventListener('canplay', onCanPlay)
      if (transferSeq !== mp._loadSeq) return
      if (seekTo > 0 && !isNaN(audio.duration) && seekTo < audio.duration) {
        audio.currentTime = seekTo
      }
    }
    audio.addEventListener('canplay', onCanPlay)

    if (mp.devicesBtn) mp.devicesBtn.style.display = ''
    mp._syncUpdateDevicesButton()
    // Immediately push state so the old active device sees us as active
    setTimeout(function() { _syncPushState() }, 300)
    console.log('[MUSIC PLAYER] Accepted playback transfer from remote device')
  }

  function _syncYieldToDevice(targetDeviceId) {
    // Another device is taking over
    mp._syncIsActive = false
    mp._syncForceActive = false
    _syncStopKeepAlive()
    mp._wasPlayingBeforeBackground = false
    audio.pause()
    console.log('[MUSIC PLAYER] Yielding playback to device:', targetDeviceId)
    // Immediately poll to enter phantom mode instead of waiting for next 3s cycle
    setTimeout(function() { _syncPoll() }, 200)
  }

  function _syncHandleCommandResult(result) {
    if (!result) return
    if (result.error) {
      // Show error to user — revert optimistic UI
      if (result.error_code === 'autoplay_blocked') {
        // Remote device couldn't auto-play — show paused state
        mp._syncPhantomPlaying = false
        mp.isPlaying = false
        mp._updatePlayButton()
      }
      if (typeof showToast === 'function') {
        showToast(result.error, 'error')
      }
      console.warn('[MUSIC PLAYER] Command result error:', result.error)
    }
  }

  function _syncAcknowledgeCommandResult() {
    if (!_syncResultAckPending || _syncResultAckInFlight) return
    var pending = _syncResultAckPending
    _syncResultAckInFlight = true
    fetch('/music/api/sync/command/ack', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ command_id: pending.command_id, device_id: mp._syncDeviceId }),
    }).then(function(r) {
      if (!r.ok) throw new Error('Result acknowledgement failed')
      return r.json()
    }).then(function(data) {
      if (data.command_id === pending.command_id && _syncResultAckPending === pending) {
        _syncResultAckPending = null
      }
      _syncResultAckInFlight = false
    }).catch(function() {
      _syncResultAckInFlight = false
    })
  }

  function _syncSendCommand(action, extra) {
    var cmd = { action: action }
    if (extra) {
      for (var k in extra) cmd[k] = extra[k]
    }
    fetch('/music/api/sync/command', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ command: cmd, requester_device_id: mp._syncDeviceId }),
    }).catch(function() {})
  }

  function _syncRequestTransfer() {
    // Request that playback be transferred TO this device (called from phantom)
    mp._syncEpoch++
    fetch('/music/api/sync/transfer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ target_device_id: mp._syncDeviceId }),
    }).then(function() {
      console.log('[MUSIC PLAYER] Requested playback transfer to this device')
    }).catch(function() {})
  }

  function _syncTransferToDevice(targetDeviceId) {
    // Push playback to a remote device (called from active device)
    mp._syncEpoch++
    fetch('/music/api/sync/transfer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ target_device_id: targetDeviceId }),
    }).then(function() {
      console.log('[MUSIC PLAYER] Pushed playback to device:', targetDeviceId)
      // Yield immediately — don't wait for next poll cycle
      _syncYieldToDevice(targetDeviceId)
    }).catch(function() {})
  }

  // Hook into the audio play event to mark this device as active
  audio.addEventListener('play', function() {
    if (mp._syncPhantomMode) return  // silent keepalive — do not claim active
    if (mp._context === 'music-library' && mp._syncLoggedIn && mp._syncEnabled && !mp._syncPhantomMode) {
      if (!mp._syncIsActive) {
        // Local playback claims the session: drop in-flight responses and
        // start pushing now rather than after the idle poll delay.
        mp._syncIsActive = true
        mp._syncEpoch++
        _syncKick()
      }
      // Show devices button if not already shown
      if (mp.devicesBtn) mp.devicesBtn.style.display = ''
    }
  })

  Object.assign(mp, {
    _initSyncDeviceId,
    _syncStart,
    _syncStop,
    _syncKick,
    _syncNum,
    _syncTracksFromState,
    _syncStopKeepAlive,
    _syncSendCommand,
    _syncRequestTransfer,
    _syncTransferToDevice,
  })
})(window._mpCore)
