// ─── ONE.GY Music Player: Phantom mode: mirroring a remote device's playback ───
;(function(mp) {
  'use strict'

  const { audio, _silentUrl, _clearAudioSrc } = mp

  let _syncPhantomQueueKey = null   // remote queue ids last rendered in the playlist panel
  let _syncPhantomShownKey = null   // state_key + device of the remote state last shown
  let _syncPhantomShownAt = 0       // Date.now() when it was shown

  function _syncResetForLocalPlayback() {
    mp._syncRemoteTarget = null
    mp._syncPhantomDeviceId = null
    if (!mp._syncPhantomMode && !mp._syncPhantomKeepaliveActive && !mp._syncPhantomTimer && !mp._syncPhantomPositionTimer && !audio.loop &&
        !(mp.playerEl && mp.playerEl.classList.contains('mp-phantom'))) return

    mp._syncPhantomMode = false
    mp._syncPhantomTrackId = null
    mp._syncPhantomPlaying = false
    mp._syncPhantomStale = false
    mp._syncPhantomStateTs = null
    mp._syncPhantomKeepaliveActive = false
    _syncPhantomStopInterpolation()
    if (mp._syncPhantomPositionTimer) { clearInterval(mp._syncPhantomPositionTimer); mp._syncPhantomPositionTimer = null }
    if (mp.playerEl) mp.playerEl.classList.remove('mp-phantom')
    if (mp.phantomLabel) mp.phantomLabel.textContent = ''
    audio.loop = false
    audio.pause()
    _clearAudioSrc()
    audio.muted = mp._volSlider === 0
  }

  function _syncEnterPhantom(data) {
    // Polls repeat an unchanged remote state (same state_key): the mirror shows
    // it already. Not after a command (its optimistic UI waits for the answer),
    // when stale, or while the silent keepalive still has to start.
    var shownKey = data.state_key ? [data.state_key, data.active_device_id, data.active_device_name].join('|') : null
    if (mp._syncPhantomMode && !mp._syncPhantomStale && shownKey && shownKey === _syncPhantomShownKey &&
        (mp._syncCommandSentAt || 0) < _syncPhantomShownAt && (mp._syncPhantomKeepaliveActive || !_silentUrl())) return
    var state = data.state
    var remoteTracks = mp._syncTracksFromState(state)
    if (!remoteTracks || !Number.isInteger(state.currentIndex) ||
        state.currentIndex < 0 || state.currentIndex >= remoteTracks.length) return
    // Keep the optimistic UI of a command just sent until a state pushed after
    // it arrives (state_age_ms is server-measured), at most 3 s.
    var sentAt = mp._syncCommandSentAt || 0
    if (mp._syncPhantomMode && Date.now() - sentAt < 3000 && Date.now() - mp._syncNum(data.state_age_ms) < sentAt) return
    var remoteTrack = remoteTracks[state.currentIndex]
    var remotePlaying = state.isPlaying === true

    mp._syncPhantomMode = true
    mp._syncPhantomDeviceId = data.active_device_id
    mp._syncRemoteTarget = null
    // Library tracks: hearts, art and links work on every page
    if (mp._context !== 'music-library') {
      mp._context = 'music-library'
      mp._updateOwnLibraryState()
    }
    mp._syncShowDevicesButtons()
    mp._syncIsActive = false
    mp._syncStopKeepAlive()

    // Start silent audio keepalive so the browser shows Media Session
    // notification/lock-screen controls even though no real audio is playing.
    // The play/pause/timeupdate event handlers are guarded to skip in phantom mode.
    // Only set audio.src on the FIRST entry — subsequent poll-driven re-entries
    // skip this to avoid constant load/play cycling that confuses the browser.
    var silentUrl = _silentUrl()
    if (silentUrl && !mp._syncPhantomKeepaliveActive) {
      mp._syncPhantomKeepaliveActive = true
      audio.loop = true
      audio.muted = false
      audio.src = silentUrl
      // Ensure volume is nonzero — Chrome may suppress notifications for
      // muted/zero-volume audio.  If the GainNode controls volume, audio.volume
      // is already 1; otherwise set a barely-audible floor.
      if (!mp._fxConnected && audio.volume === 0) audio.volume = 0.01

      // iOS (WebKit) needs metadata + action handlers set BEFORE audio.play()
      // for the Now Playing widget to show full controls (next/prev/seek).
      // Set metadata eagerly here; it will be refreshed in .then() and on polls.
      if ('mediaSession' in navigator) {
        mp._updateMediaSession(remoteTrack)
        // Provide a valid position state immediately — iOS won't show
        // next/prev/scrubber without one.  Use actual duration if available,
        // otherwise a fallback of 180s (typical song length).
        var dur = mp._syncNum(state.duration) || 180
        var pos = Math.min(mp._syncNum(state.currentTime), dur)
        try {
          navigator.mediaSession.setPositionState({ duration: dur, playbackRate: 1, position: pos })
        } catch(e) {}
        navigator.mediaSession.playbackState = remotePlaying ? 'playing' : 'paused'
      }

      mp._resumeAudioContext()
      audio.play().then(function() {
        // Audio is now actually playing — re-set Media Session state so
        // browsers that ignore pre-play metadata pick it up now.
        if ('mediaSession' in navigator) {
          mp._updateMediaSession(remoteTrack)
          navigator.mediaSession.playbackState = remotePlaying ? 'playing' : 'paused'
        }
        mp._updateMediaSessionPositionState()
      }).catch(function(e) {
        console.warn('[MUSIC PLAYER] Phantom silent keepalive play failed:', e.name)
        mp._syncPhantomKeepaliveActive = false
      })
    } else if (!silentUrl && !audio.paused) {
      audio.pause()
    }

    // Show the player if not visible
    if (!mp.isVisible) mp._showPlayer()

    // Update UI with remote state
    mp.playerEl.classList.add('mp-phantom')
    if (mp.phantomLabel) {
      mp.phantomLabel.textContent = 'Playing on ' + String(data.active_device_name || 'another device')
    }

    // Store the remote playlist/index FIRST so _setTitle() can read artist info
    mp.playlist = remoteTracks
    mp.currentIndex = state.currentIndex

    // Update track display from remote state (detect track change)
    var track = mp.playlist[mp.currentIndex]
    var trackId = track ? track.id : null
    var trackChanged = trackId !== mp._syncPhantomTrackId
    mp._syncPhantomTrackId = trackId
    if (track) {
      if (trackChanged) {
        mp._setTitle(track.name)
        if (mp._context === 'music-library' || track.suggested) mp._updatePlayerArt(track)
        mp._updateMediaSession(track)
        // music.js sets the like hearts for the new track
        try {
          document.dispatchEvent(new CustomEvent('musicplayer:trackchange', { detail: { id: track.id, name: track.name } }))
        } catch(e) {}
      }
    }
    mp.shuffleMode = state.shuffleMode === true
    mp.repeatMode = (state.repeatMode === 'all' || state.repeatMode === 'one') ? state.repeatMode : 'none'
    mp.shuffleOrder = Array.isArray(state.shuffleOrder) ? state.shuffleOrder.slice() : []  // the poll keeps state for reuse
    mp.shufflePos = Number.isInteger(state.shufflePos) ? state.shufflePos : -1
    mp._suggestedStartIndex = Number.isInteger(state.suggestedStartIndex) ? state.suggestedStartIndex : -1
    mp._renderModeButtons()

    // Track state freshness — reset stale flag on fresh data
    mp._syncPhantomStateTs = data.state_updated_at || null
    mp._syncPhantomStale = false

    // Update interpolation state from poll (the state was pushed state_age_ms ago)
    mp._syncPhantomTime = mp._syncNum(state.currentTime) + (remotePlaying ? mp._syncNum(data.state_age_ms) / 1000 : 0)
    mp._syncPhantomDuration = mp._syncNum(state.duration)
    mp._syncPhantomPlaying = remotePlaying
    mp._syncPhantomPollTs = Date.now()

    // Update progress display immediately
    _syncPhantomUpdateUI()

    // Show playing state visually
    mp.isPlaying = remotePlaying
    mp._updatePlayButton()

    // Interpolate the progress while the remote plays
    if (remotePlaying) _syncPhantomStartInterpolation()
    else _syncPhantomStopInterpolation()

    mp._syncUpdateDevicesButton()
    // The remote queue can grow (suggestions) without a track change.
    var queueKey = mp.playlist.map(function(t) { return t.id }).join(',')
    if (trackChanged || queueKey !== _syncPhantomQueueKey) mp._renderPlaylist()
    _syncPhantomQueueKey = queueKey

    // Explicitly set Media Session state for lock-screen/notification controls
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = remotePlaying ? 'playing' : 'paused'
    }
    mp._updateMediaSessionPositionState()

    // Keep lock-screen position updated via setInterval — unlike rAF this
    // continues to fire (~1/sec) when the app is backgrounded on mobile,
    // which keeps the iOS scrubber and Android notification progress alive.
    if (!mp._syncPhantomPositionTimer) {
      mp._syncPhantomPositionTimer = setInterval(function() {
        if (!mp._syncPhantomMode) return
        mp._updateMediaSessionPositionState()
      }, 4000)
    }
    _syncPhantomShownKey = shownKey
    _syncPhantomShownAt = Date.now()
  }

  // Optimistic phantom track update (called from music-browse.js when sending play_tracks)
  function _syncPhantomUpdateTrack(track) {
    if (!mp._syncPhantomMode || !track) return
    // Update playlist entry so _setTitle() can read artist info
    if (mp.currentIndex >= 0 && mp.currentIndex < mp.playlist.length) {
      var artists = track.artists || []
      mp.playlist[mp.currentIndex] = Object.assign({}, mp.playlist[mp.currentIndex], {
        id: track.id || mp.playlist[mp.currentIndex].id,
        name: track.title || track.name || mp.playlist[mp.currentIndex].name,
        artistName: artists.map(function(a) { return a.name }).join(', '),
        artists: artists,
        artistIds: artists.map(function(a) { return a.id }),
        albumId: track.album_id || track.albumId || mp.playlist[mp.currentIndex].albumId,
        coverPath: track.cover_path || track.coverPath || mp.playlist[mp.currentIndex].coverPath,
      })
    }
    mp._setTitle(track.title || track.name || 'Unknown')
    var coverPath = track.cover_path || track.coverPath || null
    if (coverPath) mp._updatePlayerArt({ coverPath: coverPath })
    // Reset progress to 0 for new track
    mp._syncPhantomTime = 0
    mp._syncPhantomDuration = 0
    mp._syncPhantomPlaying = true
    mp._syncPhantomPollTs = Date.now()
    mp._syncPhantomTrackId = track.id || null
    _syncPhantomRenderProgress(0, 1)
    _syncPhantomStartInterpolation()
    mp.isPlaying = true
    mp._updatePlayButton()
    // Update lock-screen metadata for the new track
    var updatedTrack = (mp.currentIndex >= 0 && mp.currentIndex < mp.playlist.length) ? mp.playlist[mp.currentIndex] : null
    if (updatedTrack) mp._updateMediaSession(updatedTrack)
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
  }

  // Progress interpolation for phantom mode: 4 updates a second while the
  // remote plays (the bar has 1000 steps, the clock shows seconds), none while
  // it is paused. Every call site that sets _syncPhantomPlaying starts it.
  function _syncPhantomStartInterpolation() {
    if (mp._syncPhantomTimer || !mp._syncPhantomMode || !mp._syncPhantomPlaying) return
    mp._syncPhantomTimer = setInterval(_syncPhantomTick, 250)
  }

  function _syncPhantomStopInterpolation() {
    if (mp._syncPhantomTimer) { clearInterval(mp._syncPhantomTimer); mp._syncPhantomTimer = null }
  }

  function _syncPhantomTick() {
    if (!mp._syncPhantomMode || !mp._syncPhantomPlaying) { _syncPhantomStopInterpolation(); return }
    if (!(mp._syncPhantomDuration > 0)) return
    var elapsed = (Date.now() - mp._syncPhantomPollTs) / 1000
    // Client-side staleness check: if no fresh poll data in 10s, pause phantom
    if (elapsed > 10 && !mp._syncPhantomStale) {
      _syncPausePhantom()
      return  // stops interpolation
    }
    var interpolated = mp._syncPhantomTime + elapsed
    if (interpolated > mp._syncPhantomDuration) interpolated = mp._syncPhantomDuration
    if (!document.hidden) _syncPhantomRenderProgress(interpolated, mp._syncPhantomDuration)
    // Update lock-screen position state periodically (every ~5s)
    var now = Date.now()
    if (now - mp._lastPositionUpdate > 5000) {
      mp._lastPositionUpdate = now
      mp._updateMediaSessionPositionState()
    }
  }

  function _syncPhantomRenderProgress(time, duration) {
    if (mp._scrubbing) return
    if (mp.progressEl && duration > 0) {
      mp.progressEl.value = Math.round((time / duration) * 1000)
      mp._updateProgressFill()
    }
    if (mp.currentTimeEl) mp.currentTimeEl.textContent = mp._formatTime(time)
    if (mp.durationEl && duration > 0) mp.durationEl.textContent = mp._formatTime(duration)
  }

  function _syncPhantomUpdateUI() {
    _syncPhantomRenderProgress(mp._syncPhantomTime, mp._syncPhantomDuration)
  }

  function _syncExitPhantom() {
    mp._syncPhantomMode = false
    mp._syncPhantomDeviceId = null
    mp._syncPhantomTrackId = null
    mp._syncPhantomStale = false
    mp._syncPhantomStateTs = null
    mp._syncPhantomKeepaliveActive = false
    _syncPhantomStopInterpolation()
    if (mp._syncPhantomPositionTimer) { clearInterval(mp._syncPhantomPositionTimer); mp._syncPhantomPositionTimer = null }
    if (mp.playerEl) mp.playerEl.classList.remove('mp-phantom')
    if (mp.phantomLabel) mp.phantomLabel.textContent = ''

    // Stop silent keepalive audio — restore audio element for normal use
    audio.loop = false
    audio.pause()
    _clearAudioSrc()
    mp._syncEpoch++

    // The playlist and index were the remote device's (copied in by
    // _syncEnterPhantom): drop them so nothing here can resume or auto-advance
    // through them, and hide the now-empty player.
    mp.playlist = []
    mp.currentIndex = -1
    mp.shuffleOrder = []
    mp.shufflePos = -1
    mp._suggestedStartIndex = -1
    mp.isPlaying = false
    if (mp.isVisible) mp.closePlayer()
    mp._syncUpdateDevicesButton()
  }

  function _syncPausePhantom() {
    // Remote device stopped updating — pause phantom display but keep it visible
    mp._syncPhantomStale = true
    mp._syncPhantomPlaying = false
    mp.isPlaying = false
    mp._updatePlayButton()

    // Stop the interpolation so the seek bar freezes
    _syncPhantomStopInterpolation()

    // Update lock-screen to show paused (silent keepalive stays running to
    // keep the notification visible so the user can still tap play)
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'

    // Update phantom label to reflect disconnected state
    // Extract the device name from the current label ("Playing on <name>") or use fallback
    var prevName = 'remote device'
    if (mp.phantomLabel && mp.phantomLabel.textContent) {
      var match = mp.phantomLabel.textContent.match(/^Playing on (.+)$/)
      if (match) prevName = match[1]
    }
    if (mp.phantomLabel) {
      mp.phantomLabel.textContent = 'Paused: ' + prevName + ' disconnected'
    }

    mp._syncUpdateDevicesButton()
  }

  Object.assign(mp, {
    _syncResetForLocalPlayback,
    _syncEnterPhantom,
    _syncPhantomUpdateTrack,
    _syncPhantomStartInterpolation,
    _syncPhantomStopInterpolation,
    _syncPhantomRenderProgress,
    _syncExitPhantom,
    _syncPausePhantom,
  })
})(window._mpCore)
