// ─── ONE.GY Music Player: Cross-device sync engine (polling, pushing, commands, transfers) ───
;(function(mp) {
  'use strict'

  const { _jsonHeaders, _lsGet, _lsSet, _ssSet, audio, _coverUrl } = mp

  // ─── Sync Engine State (shared sync state lives in core) ────────
  const _SYNC_QUEUE_RADIUS = 100    // tracks pushed on each side of the current one
  const _SYNC_REMOTE_QUEUE_MAX = 200  // tracks sent with a play_tracks command (server cap)
  const _SYNC_HEARTBEAT_MS = 4000   // unchanged state is re-pushed this often (server: stale after 10 s)
  const _SYNC_LEASE_MS = 120000     // a tab holding the browser's device id renews it well within this
  const _SYNC_ALONE_MS = 15000      // idle heartbeat with no other device online (server online window: 30 s)
  const _SYNC_TABS_KEY = 'mp_sync_tabs'  // this browser's tabs: {device id: last renewal}
  const _SYNC_TAB_TTL_MS = 60000    // a tab renews its entry every few ticks, well within this
  const _SYNC_KICK_KEY = 'mp_sync_kick'  // written after a command / transfer: sibling tabs poll at once
  const _AUTO_NAME_RE = /^(Edge|Opera|Chrome|Firefox|Safari|Browser|ONE\.GY Desktop) on (iPad|iPhone|Android|Mac|Windows|Linux|ChromeOS|Device)$/
  let _syncTimer = null             // setTimeout handle for the next sync tick
  let _syncDueAt = 0                // when the scheduled tick runs (0: none scheduled)
  let _syncTicker = null            // Worker timer for hidden pages (null: not tried, false: unavailable)
  let _syncLeaseAt = 0              // when this tab last renewed the device id lease
  let _syncClaimInFlight = false
  let _syncLastPushSig = null       // state signature, time and position of the last accepted push
  let _syncLastPushAt = 0
  let _syncLastPushPos = 0
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
  let _syncKnownState = null        // {key, state}: the last full state a poll returned (sent back as state_key)
  let _syncTabAt = 0                // when this tab last renewed its sibling-registry entry
  let _syncSiblingKicked = false    // a sibling tab sent a command or transfer

  // ─── Cross-Device Sync Engine ─────────────────────────────────

  function _newDeviceId() {
    return crypto.randomUUID ? crypto.randomUUID() : ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    }))
  }

  // One id per browser, so the devices list keeps one row per browser across
  // reloads and restarts. A tab opened while another holds the id (its lease is
  // fresh) gets an id of its own for its session.
  function _initSyncDeviceId() {
    if (!mp._syncDeviceId) {
      var stable = _lsGet('mp_device_id')
      var leaseAge = Date.now() - (parseInt(_lsGet('mp_device_lease'), 10) || 0)
      mp._syncDeviceId = (stable && leaseAge > _SYNC_LEASE_MS) ? stable : _newDeviceId()
      if (!stable) _lsSet('mp_device_id', mp._syncDeviceId)
      _ssSet('mp_device_id', mp._syncDeviceId)
    }
    _syncRenewLease()
    // Only renames are stored; detected names are refreshed (older builds stored them).
    if (!mp._syncDeviceName || _AUTO_NAME_RE.test(mp._syncDeviceName)) {
      mp._syncDeviceName = _detectDeviceName()
    }
  }

  function _syncOwnsStableId() {
    return !!mp._syncDeviceId && mp._syncDeviceId === _lsGet('mp_device_id')
  }

  function _syncRenewLease() {
    if (Date.now() - _syncLeaseAt < _SYNC_LEASE_MS / 4 || !_syncOwnsStableId()) return
    _syncLeaseAt = Date.now()
    _lsSet('mp_device_lease', String(_syncLeaseAt))
  }

  // Release on leave: the next page of this tab keeps the id (sessionStorage),
  // and a later tab may take it.
  window.addEventListener('pagehide', function() {
    _syncDropTab()
    if (!_syncOwnsStableId()) return
    _syncLeaseAt = 0
    _lsSet('mp_device_lease', '0')
  })

  // Tabs of this browser are separate devices to the server, but another tab
  // is no reason to poll fast: each keeps a leased entry in a shared registry
  // and the poll rate only counts devices outside it. Commands and transfers
  // between tabs wake the others through a storage event instead.
  function _syncReadTabs() {
    try {
      var tabs = JSON.parse(_lsGet(_SYNC_TABS_KEY) || '{}')
      return tabs && typeof tabs === 'object' ? tabs : {}
    } catch (e) { return {} }
  }

  function _syncRenewTab() {
    var now = Date.now()
    if (!mp._syncDeviceId || now - _syncTabAt < _SYNC_TAB_TTL_MS / 6) return
    _syncTabAt = now
    var tabs = _syncReadTabs()
    for (var id in tabs) if (!(now - tabs[id] < _SYNC_TAB_TTL_MS)) delete tabs[id]
    tabs[mp._syncDeviceId] = now
    _lsSet(_SYNC_TABS_KEY, JSON.stringify(tabs))
  }

  function _syncDropTab() {
    _syncTabAt = 0
    var tabs = _syncReadTabs()
    if (!(mp._syncDeviceId in tabs)) return
    delete tabs[mp._syncDeviceId]
    _lsSet(_SYNC_TABS_KEY, JSON.stringify(tabs))
  }

  function _syncSiblingIds() {
    var tabs = _syncReadTabs(), now = Date.now(), ids = {}
    for (var id in tabs) if (id !== mp._syncDeviceId && now - tabs[id] < _SYNC_TAB_TTL_MS) ids[id] = true
    return ids
  }

  function _syncKickSiblings() {
    for (var id in _syncSiblingIds()) {
      _lsSet(_SYNC_KICK_KEY, Date.now() + ':' + Math.random())
      return
    }
  }

  window.addEventListener('storage', function(e) {
    if (e.key !== _SYNC_KICK_KEY || !_syncRunning) return
    _syncSiblingKicked = true
    _syncKick()
  })

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
    if (/ONEGY-Desktop\//.test(ua)) browser = 'ONE.GY Desktop'
    else if (/Edg\//.test(ua)) browser = 'Edge'
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
    _syncClearTimers()
    _syncStopKeepAlive()
  }

  function _syncKick() {
    if (!_syncRunning) return
    _syncClearTimers()
    _syncTick()
  }

  function _syncClearTimers() {
    if (_syncTimer) {
      clearTimeout(_syncTimer)
      _syncTimer = null
    }
    if (_syncTicker) _syncTicker.postMessage(0)
  }

  function _syncTick() {
    _syncTimer = null
    _syncDueAt = 0
    if (!_syncRunning) return
    _syncPoll()
    _syncSchedule(_syncNextDelay())
  }

  // Hidden pages time the loop in a worker: Chrome throttles a background
  // page's own timers to one wake-up a minute after 5 minutes, which would
  // drop an idle, minimized player off the devices list.
  function _syncSchedule(delay) {
    _syncDueAt = Date.now() + delay
    if (document.hidden) {
      if (_syncTicker === null) {
        _syncTicker = false
        var url = mp.playerEl && mp.playerEl.dataset.ticker
        try {
          if (url && typeof Worker === 'function') {
            _syncTicker = new Worker(url)
            _syncTicker.onmessage = function() { _syncTick() }
          }
        } catch (e) {}
      }
      if (_syncTicker) {
        _syncTicker.postMessage(delay)
        return
      }
    }
    _syncTimer = setTimeout(_syncTick, delay)
  }

  // The next tick was timed before this poll's answer arrived (as if alone,
  // say). When the answer calls for a shorter wait (a mirror to keep fresh,
  // another device online), bring the tick forward.
  function _syncTightenSchedule() {
    if (!_syncRunning || !_syncDueAt) return
    var delay = _syncNextDelay()
    if (Date.now() + delay < _syncDueAt) {
      _syncClearTimers()
      _syncSchedule(delay)
    }
  }

  function _syncOthersOnline() {
    var siblings = null
    return mp._syncDevices.some(function(d) {
      if (d.is_self) return false
      if (!siblings) siblings = _syncSiblingIds()
      return !siblings[d.device_id]
    })
  }

  // This device outputs the session's audio and publishes its state.
  function _syncPushing() {
    return mp._syncIsActive && !mp._syncPhantomMode && mp._context === 'music-library' &&
      (mp.isPlaying || (mp.isVisible && mp.currentIndex >= 0))
  }

  // Every signed-in page polls, so each open device is listed and can be
  // controlled. Fast (1 s) only while someone waits on this device: it plays
  // with another device online, it mirrors or controls a remote one, or its
  // devices panel is open. Another device online with nothing to follow: 3 s
  // (10 s hidden). Alone it only heartbeats under the server's 30 s online
  // window. Failures back off exponentially.
  function _syncNextDelay() {
    var others = _syncOthersOnline()
    var delay
    if (_syncPushing()) delay = others ? 1000 : 3000
    else if (mp._syncPhantomMode || mp._syncRemoteTarget) delay = document.hidden ? 5000 : 1000
    else if (mp.devicesPanel && mp.devicesPanel.classList.contains('mp-devices-visible')) delay = 1000
    else if (others) delay = document.hidden ? 10000 : 3000
    else delay = _SYNC_ALONE_MS
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

    _syncRenewLease()
    _syncRenewTab()
    if (_syncResultAckPending) _syncAcknowledgeCommandResult()
    var kicked = _syncSiblingKicked
    _syncSiblingKicked = false

    var pushing = _syncPushing()
    if (pushing) {
      // Paused: keep the audio context warm so remote commands can play
      if (mp.isPlaying) _syncStopKeepAlive()
      else _syncStartKeepAlive()
      // A changed state goes out at once, an unchanged one as a heartbeat; in
      // between a cheap GET watches for commands and transfers (with no other
      // device online none can arrive).
      var built = _syncBuildState()
      // A sibling tab's command is claimed by the push response
      if (_syncPushDue(built) || kicked) {
        _syncPushState(built)
        return
      }
      if (!_syncOthersOnline()) return
    } else if (_syncCommandResult) {
      _syncClaim()  // deliver a result (e.g. a refused command) from a device that does not push
      return
    }

    // Poll for remote state: one GET at a time, and a response that predates a
    // local play / transfer / phantom exit is dropped (it would otherwise undo
    // that action, e.g. throw "play here" back into phantom).
    if (_syncPollInFlight) return
    _syncPollInFlight = true
    var epoch = mp._syncEpoch
    var url = '/music/api/sync?device_id=' + encodeURIComponent(mp._syncDeviceId)
    // The server leaves out a state this page already holds (state_unchanged)
    var known = _syncKnownState
    if (known) url += '&state_key=' + encodeURIComponent(known.key)
    _syncFetch(url, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    }).then(function(data) {
      _syncPollInFlight = false
      _syncErrorCount = 0
      if (data.state_unchanged === true) {
        // Not the state sent as state_key: drop it, the next poll gets it in full
        if (!known || data.state_key !== known.key) { _syncKnownState = null; return }
        data.state = known.state
      } else if (data.state && typeof data.state_key === 'string') {
        _syncKnownState = { key: data.state_key, state: data.state }
      }
      if (data.registered === false) _syncRegisterDevice()
      if (epoch !== mp._syncEpoch) return
      _syncLastPollData = data
      mp._syncDevices = data.devices || []

      // A command waits for this device: the active one claims it with a push
      if (data.has_command) {
        if (_syncPushing()) _syncPushState(_syncBuildState())
        else _syncClaim()
      }

      // Check if we were requested to transfer to ourselves
      if (data.transfer_to === mp._syncDeviceId) {
        if (_syncPushing()) _syncClearTransfer()  // already playing here
        else _syncAcceptTransfer(data)
        return
      }

      if (_syncPushing()) {
        if (data.transfer_to) _syncYieldToDevice(data.transfer_to)
        // Another device claimed the session: the push response hands this one over
        else if (data.active && data.active_device_id && data.active_device_id !== mp._syncDeviceId) _syncPushState(_syncBuildState())
        mp._syncUpdateDevicesButton()
        return
      }

      // The picked remote device went offline
      if (mp._syncRemoteTarget && !mp._syncDevices.some(function(d) { return d.device_id === mp._syncRemoteTarget.id })) {
        _syncClearRemoteTarget()
      }

      var remoteActive = data.active && data.active_device_id && data.active_device_id !== mp._syncDeviceId && data.state
      if (!remoteActive || data.active_device_id !== mp._syncPhantomDismissed) mp._syncPhantomDismissed = null
      // Own files playing (or paused) in the bar are not replaced by a mirror
      var ownPlayback = mp.isVisible && !mp._syncPhantomMode && mp.currentIndex >= 0 && mp._context !== 'music-library'

      if (remoteActive && !mp._syncPhantomDismissed && !ownPlayback) {
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
    }).then(_syncTightenSchedule).catch(function(err) {
      _syncPollInFlight = false
      _syncOnError(err)
    })
  }

  // Only a window around the current track is pushed (a queue can be
  // hundreds of tracks), and only when it changed: otherwise the server
  // reuses the window it stored under _syncQueueKey.
  function _syncBuildState() {
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
      // audio.paused flips in play() itself; the play event (isPlaying) comes later
      isPlaying: mp.isPlaying || !audio.paused,
      shuffleMode: mp.shuffleMode,
      repeatMode: mp.repeatMode,
      shuffleOrder: windowOrder,
      shufflePos: windowOrder.indexOf(mp.currentIndex - start),
      suggestedStartIndex: mp._suggestedStartIndex < 0 ? -1 : Math.min(queue.length, Math.max(0, mp._suggestedStartIndex - start)),
    }
    var sig = [queueJson, statePayload.currentIndex, statePayload.isPlaying, statePayload.shuffleMode,
      statePayload.repeatMode, statePayload.shufflePos, statePayload.suggestedStartIndex, Math.round(statePayload.duration)].join('|')
    return { queue: queue, queueJson: queueJson, state: statePayload, sig: sig }
  }

  // Push when the state changed, a seek moved the playhead off its expected
  // position, something must reach the server, or the heartbeat is due.
  function _syncPushDue(built) {
    var now = Date.now()
    var s = built.state
    var expected = _syncLastPushPos + (s.isPlaying ? (now - _syncLastPushAt) / 1000 : 0)
    return mp._syncForceActive || !!_syncCommandResult || built.sig !== _syncLastPushSig ||
      now - _syncLastPushAt >= _SYNC_HEARTBEAT_MS || Math.abs(s.currentTime - expected) > 1.5
  }

  function _syncPushState(built) {
    if (_syncPushPending) return
    _syncPushPending = true

    var queue = built.queue
    var queueJson = built.queueJson
    var statePayload = built.state
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
      _syncLastPushSig = built.sig
      _syncLastPushAt = Date.now()
      _syncLastPushPos = statePayload.currentTime

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
        setTimeout(function() { _syncPushState(_syncBuildState()) }, 0)
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
      if (data.transfer_to === mp._syncDeviceId) _syncClearTransfer()  // already playing here
      else if (data.transfer_to) _syncYieldToDevice(data.transfer_to)

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
    // Transport commands need a local session; play_tracks starts one
    var hasLocal = !mp._syncPhantomMode && mp._context === 'music-library' && mp.currentIndex >= 0
    try {
      if (cmd.action === 'play_tracks') {
        var tracks = _syncTracksFromState({ playlist: cmd.tracks })
        if (!tracks || !Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= tracks.length) {
          _syncSetCommandResult(cmd, { error: 'INVALID TRACKS', error_code: 'invalid_command' })
        } else {
          mp._playLibraryTracks(tracks, cmd.index)
          _syncSetCommandResult(cmd, { ok: true })
        }
        return
      }
      if (!hasLocal) {
        _syncSetCommandResult(cmd, { error: 'NOTHING IS PLAYING ON THAT DEVICE', error_code: 'not_active' })
        return
      }
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
        case 'shuffle':
          if (cmd.on !== mp.shuffleMode) mp.toggleShuffle()
          _syncSetCommandResult(cmd, { ok: true })
          break
        case 'repeat':
          if (cmd.mode === 'none' || cmd.mode === 'all' || cmd.mode === 'one') {
            mp.repeatMode = cmd.mode
            if (cmd.mode === 'one' && mp._crossfadeActive) mp._cancelCrossfade()
            mp._updateRepeatButton()
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
    setTimeout(_syncKick, 0)  // report it (and the new state) now, not on the next tick
  }

  // Claim the next command addressed to this device while it is not the
  // active one, delivering the previous command's result on the way.
  function _syncClaim() {
    if (_syncClaimInFlight) return
    _syncClaimInFlight = true
    var sent = _syncCommandResult
    var body = { device_id: mp._syncDeviceId, device_name: mp._syncDeviceName, claim_only: true }
    if (sent) body.command_result = sent
    _syncFetch('/music/api/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify(body),
    }).then(function(data) {
      _syncClaimInFlight = false
      _syncErrorCount = 0
      if (sent && data.command_result_acknowledged === sent.command_id && _syncCommandResult === sent) {
        _syncCommandResult = null
      }
      if (data.pending_command) _syncExecuteCommand(data.pending_command)
    }).catch(function(err) {
      _syncClaimInFlight = false
      _syncOnError(err)
    })
  }

  function _syncClearTransfer() {
    fetch('/music/api/sync/transfer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ target_device_id: '' }),
    }).catch(function() {})
  }

  function _syncAcceptTransfer(data) {
    var state = data.state
    var remoteTracks = _syncTracksFromState(state)
    // Clear transfer flag on server (also when there is nothing to take over)
    _syncClearTransfer()
    if (!remoteTracks) return
    mp._syncEpoch++
    mp._syncRemoteTarget = null

    // Exit phantom mode and clean up interpolation
    mp._syncPhantomMode = false
    mp._syncPhantomTrackId = null
    mp._syncPhantomStale = false
    mp._syncPhantomStateTs = null
    mp._syncPhantomKeepaliveActive = false
    mp._syncPhantomStopInterpolation()
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
    setTimeout(_syncKick, 300)
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

  // Commands go to the active device unless a target is given. Mirrors keep
  // their optimistic UI until a state pushed after the command arrives.
  function _syncSendCommand(action, extra, targetDeviceId) {
    var cmd = { action: action }
    if (extra) {
      for (var k in extra) cmd[k] = extra[k]
    }
    var body = { command: cmd, requester_device_id: mp._syncDeviceId }
    if (targetDeviceId) body.target_device_id = targetDeviceId
    mp._syncCommandSentAt = Date.now()
    fetch('/music/api/sync/command', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify(body),
    }).then(function(r) {
      if (r.ok) return
      return r.json().then(function(data) {
        if (data && data.error && typeof showToast === 'function') showToast(data.error, 'error')
      })
    }).catch(function() {}).then(function() {
      _syncKickSiblings()  // the target may be another tab of this browser
      _syncKick()  // pick up the result soon
    })
  }

  // Play a queue on the device this page controls: the one it mirrors, or the
  // one picked in the devices panel. Returns false when there is none.
  function _syncPlayOnRemote(tracks, startIndex) {
    if (!mp._syncLoggedIn || !mp._syncEnabled || !tracks.length) return false
    var target = mp._syncPhantomMode ? null : (mp._syncRemoteTarget && mp._syncRemoteTarget.id)
    if (!mp._syncPhantomMode && !target) return false
    var index = Math.min(Math.max(0, startIndex || 0), tracks.length - 1)
    var from = Math.max(0, Math.min(index - 50, tracks.length - _SYNC_REMOTE_QUEUE_MAX))
    var sent = tracks.slice(from, from + _SYNC_REMOTE_QUEUE_MAX).map(function(t) {
      return {
        id: t.id, name: t.name, coverPath: t.coverPath || null,
        artists: (t.artists || []).map(function(a) { return { id: a.id, name: a.name } }),
        albumId: t.albumId || null, suggested: !!t.suggested,
      }
    })
    _syncSendCommand('play_tracks', { tracks: sent, index: index - from }, target)
    if (mp._syncPhantomMode) {
      mp._syncPhantomUpdateTrack(tracks[index])
    } else {
      mp._setTitle(tracks[index].name)
      if (mp.phantomLabel) mp.phantomLabel.textContent = 'Starting on ' + mp._syncRemoteTarget.name
    }
    return true
  }

  // Control an idle remote device: the bar shows it, and what is played here
  // next starts there.
  function _syncSetRemoteTarget(device) {
    mp._syncRemoteTarget = { id: device.device_id, name: String(device.device_name || 'another device') }
    mp._showPlayer()
    if (mp.playerEl) mp.playerEl.classList.add('mp-phantom')
    if (mp.phantomLabel) mp.phantomLabel.textContent = 'Connected to ' + mp._syncRemoteTarget.name
    if (mp.currentIndex < 0) mp._setTitle('Pick something to play')
    mp._syncShowDevicesButtons()
    mp._syncUpdateDevicesButton()
    _syncKick()
  }

  function _syncClearRemoteTarget() {
    if (!mp._syncRemoteTarget) return
    mp._syncRemoteTarget = null
    if (mp._syncPhantomMode) return
    if (mp.playerEl) mp.playerEl.classList.remove('mp-phantom')
    if (mp.phantomLabel) mp.phantomLabel.textContent = ''
    if (mp.isVisible && mp.currentIndex < 0) mp.closePlayer()
    mp._syncUpdateDevicesButton()
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
      _syncKickSiblings()
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
      _syncKickSiblings()
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
    if (_syncPushing() && _syncOthersOnline()) _syncKick()  // mirrors see it now, not next tick
  })
  audio.addEventListener('pause', function() {
    if (_syncPushing() && _syncOthersOnline()) _syncKick()
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
    _syncPlayOnRemote,
    _syncSetRemoteTarget,
    _syncClearRemoteTarget,
    _syncPushing,
    _syncRequestTransfer,
    _syncTransferToDevice,
  })
})(window._mpCore)
