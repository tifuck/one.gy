// ─── ONE.GY Music Player: Playlists, shuffle, autoplay suggestions and crossfade ───
;(function(mp) {
  'use strict'

  const { AUDIO_EXTS, _lsSet, audio, _applyOutputVolume, _applyCrossfadeVolumes } = mp

  let _crossfadeTimer = null

  /**
   * Play tracks from the music library catalog.
   * @param {Array} tracks - [{id, title, artists, album_name, cover_path, duration_ms, ...}]
   * @param {number} startIndex - Index to start playing from
   */
  function playMusicLibrary(tracks, startIndex) {
    if (!tracks || !tracks.length) return
    mp._resumeAudioContext()
    mp._context = 'music-library'
    mp._updateOwnLibraryState()

    // Build playlist from provided tracks
    mp.playlist = tracks.map(t => ({
      id: t.id,
      name: t.title || 'Unknown',
      extension: 'opus',
      isE2E: false,
      sourceUrl: '/music/stream/' + t.id,
      blobUrl: null,
      coverPath: t.cover_path || null,
      artistName: (t.artists || []).map(a => a.name).join(', '),
      artistIds: (t.artists || []).map(a => a.id),
      artists: (t.artists || []).map(a => ({ id: a.id, name: a.name })),
      albumId: t.album_id || null,
      suggested: false,
    }))

    mp.currentIndex = -1
    mp._suggestedStartIndex = -1
    mp._suggestApiUnavailable = false
    mp._autoQueueFailures = 0
    mp._autoQueueRetryAt = 0
    mp._crossfadeTriggered = false
    _cancelCrossfade()
    if (mp.shuffleMode) {
      _generateShuffleOrder()
      // currentIndex is -1 here, so _generateShuffleOrder() skips its own
      // shufflePos reset. Anchor shufflePos to the starting track's position
      // in the freshly-generated order (mirrors open()), otherwise a stale
      // shufflePos from a previous playlist can be out of range and playback
      // stops after one track.
      _anchorShuffleAt(startIndex || 0)
    }
    mp._showPlayer()
    mp._loadTrack(startIndex || 0)
    mp._renderPlaylist()

    // Update album art in player
    mp._updatePlayerArt(mp.playlist[startIndex || 0])

    // Mark this device as actively playing for sync (force claim — explicit user action)
    if (mp._syncLoggedIn && mp._syncEnabled) {
      mp._syncEpoch++
      mp._syncIsActive = true
      mp._syncForceActive = true
      if (mp.devicesBtn) mp.devicesBtn.style.display = ''
      mp._syncStart()  // ensure polling is running
    }
  }

  // ─── Open player with a specific track ──────────────────────────
  function open(fileId, fileName, extension, isE2E, options) {
    fileId = String(fileId)
    // When a user clicks a file to play from the dashboard/browse page,
    // switch context back from music-library so dashboard behavior takes over
    if (mp._context === 'music-library') {
      // Determine correct context from page: check if we're on browse or dashboard
      if (document.querySelector('.browse-container')) {
        mp._context = 'browse'
      } else {
        mp._context = 'dashboard'
      }
    }

    // Cross-device sync is only for the music-library experience.
    // Stop remote polling so dashboard/browse playback cannot be overwritten
    // by phantom updates from an earlier music-library session.
    mp._syncIsActive = false
    mp._syncForceActive = false
    mp._syncStop()
    if (mp.devicesPanel) mp.devicesPanel.classList.remove('mp-devices-visible')
    if (mp.devicesBtn) mp.devicesBtn.style.display = 'none'
    if (mp.miniDevicesBtn) mp.miniDevicesBtn.style.display = 'none'
    if (mp.fsDevicesBtn) mp.fsDevicesBtn.style.display = 'none'

    mp._updateOwnLibraryState()
    mp._suggestApiUnavailable = false
    mp._suggestedStartIndex = -1
    var singleTrack = options && options.singleTrack

    if (singleTrack) {
      // Single-track mode: play only this file, no playlist scanning
      mp.playlist = [{ id: fileId, name: fileName, extension, isE2E, sourceUrl: _buildSourceUrl(fileId, fileName, isE2E) }]
      mp.currentIndex = -1
      if (mp.shuffleMode) _generateShuffleOrder()
      mp._showPlayer()
      mp._loadTrack(0)
      mp._renderPlaylist()
      return
    }

    buildPlaylist(options && options.tracks)
    
    // Find the track in the playlist
    let idx = mp.playlist.findIndex(t => t.id === fileId)
    if (idx === -1) {
      // Track not in playlist (e.g., different folder), add it
      mp.playlist = [{ id: fileId, name: fileName, extension, isE2E, sourceUrl: _buildSourceUrl(fileId, fileName, isE2E) }]
      idx = 0
    }

    if (mp.shuffleMode) {
      _generateShuffleOrder()
      // Place the selected track at the current position
      _anchorShuffleAt(idx)
    }

    mp._showPlayer()
    mp._loadTrack(idx)
    mp._renderPlaylist()

    // Fetch audio files from subfolders in the background and append to playlist
    if (mp._context === 'dashboard') {
      _appendSubfolderAudio(options && options.folderId)
    }
  }

  // ─── Fetch audio files from subfolders and append to playlist ──
  async function _appendSubfolderAudio(folderId) {
    const targetPlaylist = mp.playlist  // replaced (not mutated) when another playlist opens
    try {
      const url = folderId
        ? `/files/audio-recursive/${folderId}`
        : '/files/audio-recursive'
      const resp = await fetch(url)
      if (!resp.ok) return
      const data = await resp.json()
      if (mp.playlist !== targetPlaylist) return
      if (!data.files || data.files.length === 0) return

      // E2EE names arrive as server placeholders ("encrypted_<id>.mp3"):
      // decrypt them with the session keys, as the file list does.
      let masterKey = null
      if (data.files.some(f => f.is_e2e) && typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys()) {
        try { masterKey = await OneGyCrypto.getMasterKeyFromSession() } catch (e) {}
      }
      const names = await Promise.all(data.files.map(f => _subfolderTrackName(f, masterKey)))
      if (mp.playlist !== targetPlaylist) return
      // After the last await: an overlapping append for the same playlist
      // (two quick opens in one folder keep its identity) has pushed by now.
      const existingIds = new Set(mp.playlist.map(t => t.id))
      let added = 0
      const firstNew = mp.playlist.length

      for (const [i, f] of data.files.entries()) {
        if (existingIds.has(f.id)) continue
        mp.playlist.push({
          id: f.id,
          name: names[i],
          extension: f.extension,
          isE2E: f.is_e2e === true,
          sourceUrl: _buildSourceUrl(f.id, f.name, f.is_e2e === true),
        })
        added++
      }

      if (added > 0) {
        // Queue the new tracks after the existing order; reshuffling everything
        // reset the position and replayed tracks already heard.
        if (mp.shuffleMode) _appendShuffleOrder(firstNew)
        mp._renderPlaylist()
      }
    } catch (err) {
      console.error('[MusicPlayer] Failed to fetch subfolder audio:', err)
    }
  }

  async function _subfolderTrackName(f, masterKey) {
    if (!f.is_e2e) return f.name
    if (masterKey && f.encrypted_name && f.name_nonce && f.encrypted_file_key) {
      try {
        const fileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(f.encrypted_file_key, f.file_key_nonce, masterKey)
        const name = fileKey && await OneGyCrypto.decryptFileName(f.encrypted_name, f.name_nonce, fileKey)
        if (name) return name
      } catch (e) {}
    }
    return 'Encrypted file.' + f.extension
  }

  // ─── Build playlist from current folder view ───────────────────
  function buildPlaylist(tracks) {
    const newPlaylist = []
    if (Array.isArray(tracks)) {
      tracks.forEach(track => {
        const ext = String(track.extension || '').toLowerCase()
        if (!AUDIO_EXTS.includes(ext) || !track.id || !track.name) return
        const id = String(track.id)
        const isE2E = track.isE2E === true || track.is_e2e === true
        newPlaylist.push({ id, name: track.name, extension: ext, isE2E, sourceUrl: _buildSourceUrl(id, track.name, isE2E) })
      })
    }
    const rows = document.querySelectorAll('.file-row, .file-tile')

    if (!newPlaylist.length) rows.forEach(row => {
      const ext = (row.dataset.extension || '').toLowerCase()
      if (!AUDIO_EXTS.includes(ext)) return
      // Skip non-previewable audio (shouldn't happen but safety check)
      const fileId = row.dataset.fileId
      const fileName = row.dataset.fileName
      const isE2E = row.dataset.e2e === 'true' || row.dataset.isE2e === 'true'

      if (!fileId || !fileName) return

      newPlaylist.push({
        id: fileId,
        name: fileName,
        extension: ext,
        isE2E,
        sourceUrl: _buildSourceUrl(fileId, fileName, isE2E),
      })
    })

    // Only update if the playlist actually changed
    const newIds = newPlaylist.map(t => t.id).join(',')
    const oldIds = mp.playlist.map(t => t.id).join(',')
    if (newIds !== oldIds) {
      // Preserve current track if it exists in new playlist
      const currentTrack = mp.currentIndex >= 0 && mp.currentIndex < mp.playlist.length ? mp.playlist[mp.currentIndex] : null
      mp.playlist = newPlaylist
      if (currentTrack) {
        const newIdx = mp.playlist.findIndex(t => t.id === currentTrack.id)
        if (newIdx !== -1) {
          mp.currentIndex = newIdx
        }
      }
      if (mp.shuffleMode) _generateShuffleOrder()
      mp._renderPlaylist()
    }
  }

  // ─── Folder changed callback (from SPA navigation) ─────────────
  function onFolderChanged() {
    // If a track is loaded, keep the current playlist intact so music
    // continues playing when the user navigates to a different folder.
    // The playlist will rebuild naturally when the user clicks a new
    // audio file via open().
    if (mp.currentIndex >= 0 && mp.playlist.length > 0) return
    buildPlaylist()
  }

  function _canAutoQueueSuggested() {
    return mp._autoplayEnabled && mp._context === 'music-library'
  }

  function _buildSourceUrl(fileId, fileName, isE2E) {
    if (isE2E) return '' // E2E tracks need decryption, no direct URL
    if (mp._context === 'dashboard' || mp._context === 'temp') {
      return `/file/${fileId}/preview`
    } else {
      return `/f/${mp._browseShareToken}/file/${fileId}/${encodeURIComponent(fileName)}`
    }
  }

  // ─── Shuffle ────────────────────────────────────────────────────
  // Start a fresh shuffle at `idx`: move it to the front so every other track
  // still plays once after it (anchoring mid-order would skip the ones before).
  function _anchorShuffleAt(idx) {
    const pos = mp.shuffleOrder.indexOf(idx)
    if (pos > 0) {
      ;[mp.shuffleOrder[0], mp.shuffleOrder[pos]] = [mp.shuffleOrder[pos], mp.shuffleOrder[0]]
    }
    mp.shufflePos = 0
  }

  function _generateShuffleOrder() {
    mp.shuffleOrder = Array.from({ length: mp.playlist.length }, (_, i) => i)
    // Fisher-Yates shuffle
    for (let i = mp.shuffleOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[mp.shuffleOrder[i], mp.shuffleOrder[j]] = [mp.shuffleOrder[j], mp.shuffleOrder[i]]
    }
    // Put current track at the beginning
    if (mp.currentIndex >= 0) {
      const pos = mp.shuffleOrder.indexOf(mp.currentIndex)
      if (pos > 0) {
        ;[mp.shuffleOrder[0], mp.shuffleOrder[pos]] = [mp.shuffleOrder[pos], mp.shuffleOrder[0]]
      }
      mp.shufflePos = 0
    }
  }

  // Shuffle only the tracks appended from `start` and queue them after the
  // existing order: played and already-queued tracks keep their places.
  function _appendShuffleOrder(start) {
    var added = []
    for (var i = start; i < mp.playlist.length; i++) added.push(i)
    for (var j = added.length - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1))
      var tmp = added[j]; added[j] = added[k]; added[k] = tmp
    }
    mp.shuffleOrder = mp.shuffleOrder.concat(added)
  }

  // ─── Autoplay Toggle ────────────────────────────────────────────

  function _toggleAutoplay() {
    mp._autoplayEnabled = !mp._autoplayEnabled
    _lsSet('mp_autoplay', mp._autoplayEnabled ? '1' : '0')
    if (mp.autoplayBtn) {
      mp.autoplayBtn.classList.toggle('mp-btn-active', mp._autoplayEnabled)
      mp.autoplayBtn.title = mp._autoplayEnabled ? 'Autoplay on' : 'Autoplay off'
    }
  }

  // ─── Auto-queue suggested songs (music-library only) ───────────

  /**
   * When the playlist runs out of songs, fetch collaboration-graph-based
   * suggestions from the music library and append to the queue.
   * Runs only for the music-library player context.
   * If the music library API is unavailable (not logged in, music disabled),
   * the flag _suggestApiUnavailable is set so we don't retry until a new
   * playlist is started.
   * Returns a promise that resolves to true if songs were added.
   * If a request is already in flight, returns the existing promise so
   * callers can await the same result (avoids race conditions between
   * the pre-fetch in _onTimeUpdate and playNext).
   */
  function _autoQueueSuggested() {
    if (!_canAutoQueueSuggested()) return Promise.resolve(false)
    if (mp._autoQueueLoading && mp._autoQueuePromise) return mp._autoQueuePromise
    if (mp._suggestApiUnavailable) return Promise.resolve(false)
    if (Date.now() < mp._autoQueueRetryAt) return Promise.resolve(false)
    mp._autoQueueLoading = true

    var basePlaylist = mp.playlist  // replaced (not mutated) when another playlist opens
    // Build exclude list from current playlist (avoid repeats)
    var excludeIds = mp.playlist.map(function(t) { return t.id })

    // Extract unique seed artist IDs from the current playlist
    var seedArtistSet = {}
    mp.playlist.forEach(function(t) {
      if (t.artistIds) {
        t.artistIds.forEach(function(aid) { seedArtistSet[aid] = true })
      }
    })
    var seedArtists = Object.keys(seedArtistSet)

    var url = '/music/api/suggest?count=20'
    if (seedArtists.length > 0) {
      url += '&seed_artists=' + encodeURIComponent(seedArtists.join(','))
    }
    if (excludeIds.length > 0) {
      url += '&exclude=' + encodeURIComponent(excludeIds.join(','))
    }

    mp._autoQueuePromise = fetch(url, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
    .then(function(r) {
      if (r.status === 401 || r.status === 403) {
        // Music library unavailable (not logged in or disabled) -- stop retrying
        mp._suggestApiUnavailable = true
        return null
      }
      if (!r.ok) throw new Error('suggest failed: ' + r.status)
      return r.json()
    })
    .then(function(data) {
      mp._autoQueueLoading = false
      mp._autoQueuePromise = null
      if (!data) return false  // API was unavailable
      if (mp.playlist !== basePlaylist) return false  // a different playlist is playing now
      if (!data.songs || !data.songs.length) throw new Error('no suggestions')
      mp._autoQueueFailures = 0

      // Mark the boundary where suggestions begin
      if (mp._suggestedStartIndex < 0) {
        mp._suggestedStartIndex = mp.playlist.length
      }

      var newTracks = data.songs.map(function(t) {
        return {
          id: t.id,
          name: t.title || 'Unknown',
          extension: 'opus',
          isE2E: false,
          sourceUrl: '/music/stream/' + t.id,
          blobUrl: null,
          coverPath: t.cover_path || null,
          artistName: (t.artists || []).map(function(a) { return a.name }).join(', '),
          artistIds: (t.artists || []).map(function(a) { return a.id }),
          artists: (t.artists || []).map(function(a) { return { id: a.id, name: a.name } }),
          albumId: t.album_id || null,
          suggested: true,
        }
      })
      var firstNewIndex = mp.playlist.length
      mp.playlist = mp.playlist.concat(newTracks)
      if (mp.shuffleMode) _appendShuffleOrder(firstNewIndex)

      // Cap playlist at 200 tracks -- trim already-played tracks from the front
      if (mp.playlist.length > 200 && mp.currentIndex > 20) {
        var trimCount = mp.currentIndex - 5  // keep 5 tracks before current for "previous"
        if (trimCount > 0) {
          mp.playlist = mp.playlist.slice(trimCount)
          mp.currentIndex -= trimCount
          if (mp._suggestedStartIndex >= 0) mp._suggestedStartIndex = Math.max(0, mp._suggestedStartIndex - trimCount)
          mp.shuffleOrder = mp.shuffleOrder.filter(function(i) { return i >= trimCount }).map(function(i) { return i - trimCount })
          if (mp.shuffleMode) mp.shufflePos = mp.shuffleOrder.indexOf(mp.currentIndex)
        }
      }

      mp._renderPlaylist()
      return true
    })
    .catch(function() {
      mp._autoQueueLoading = false
      mp._autoQueuePromise = null
      // Back off (2 s, 4 s, ... 60 s) instead of retrying on every caller.
      mp._autoQueueFailures++
      mp._autoQueueRetryAt = Date.now() + Math.min(60000, 1000 * Math.pow(2, mp._autoQueueFailures))
      return false
    })

    return mp._autoQueuePromise
  }

  // ─── Crossfade (autoplay transitions only) ────────────────────

  function _startCrossfade() {
    if (mp._crossfadeActive || mp._crossfadeTriggered) return
    mp._crossfadeTriggered = true
    mp._crossfadeActive = true
    mp._crossfadeProgress = 0

    // Determine which track to crossfade into
    var nextIdx
    if (mp.shuffleMode) {
      var nextShufflePos = mp.shufflePos + 1
      if (nextShufflePos >= mp.shuffleOrder.length) return _cancelCrossfade()
      nextIdx = mp.shuffleOrder[nextShufflePos]
    } else {
      nextIdx = mp.currentIndex + 1
      if (nextIdx >= mp.playlist.length) return _cancelCrossfade()
    }

    var nextTrack = mp.playlist[nextIdx]
    if (!nextTrack || !nextTrack.sourceUrl) return _cancelCrossfade()

    // Create a second audio element for the incoming track
    mp._crossfadeAudio = new Audio()
    mp._crossfadeAudio.preload = 'auto'
    mp._crossfadeAudio.volume = 0
    mp._crossfadeAudio.src = nextTrack.sourceUrl

    // Connect crossfade audio to AudioContext if visualizer is active
    // (skip for now -- visualizer stays on main audio)

    mp._resumeAudioContext()
    mp._crossfadeAudio.play().catch(function() {
      _cancelCrossfade()
    })

    // Animate the crossfade over ~5 seconds (50 steps, 100ms each)
    var steps = 50
    var step = 0
    _crossfadeTimer = setInterval(function() {
      step++
      var progress = step / steps
      mp._crossfadeProgress = progress
      _applyCrossfadeVolumes(progress)

      if (step >= steps) {
        _finalizeCrossfade()
      }
    }, 100)
  }

  function _finalizeCrossfade() {
    if (_crossfadeTimer) {
      clearInterval(_crossfadeTimer)
      _crossfadeTimer = null
    }

    if (!mp._crossfadeAudio) {
      mp._crossfadeActive = false
      return
    }

    // Advance to the next track index
    if (mp.shuffleMode) {
      mp.shufflePos++
      if (mp.shufflePos < mp.shuffleOrder.length) {
        mp.currentIndex = mp.shuffleOrder[mp.shufflePos]
      }
    } else {
      mp.currentIndex = mp.currentIndex + 1
    }

    // Swap: take over from crossfade audio
    audio.pause()
    audio.src = mp._crossfadeAudio.src
    audio.currentTime = mp._crossfadeAudio.currentTime
    mp._crossfadeProgress = 1
    _applyOutputVolume(mp._desiredVolume)

    // Play the main audio from where the crossfade audio is
    mp._resumeAudioContext()
    audio.play().catch(function(err) {
      console.warn('[MUSIC PLAYER] Crossfade finalize play failed:', err.message)
      // Fallback: try loading the track cleanly
      var track = mp.playlist[mp.currentIndex]
      if (track) {
        audio.src = track.sourceUrl
        audio.play().catch(function() {})
      }
    })

    // Clean up crossfade audio
    mp._crossfadeAudio.pause()
    mp._crossfadeAudio.src = ''
    mp._crossfadeAudio = null
    mp._crossfadeActive = false
    mp._crossfadeProgress = 0

    // Update UI for the new track
    var track = mp.playlist[mp.currentIndex]
    if (track) {
      mp._setTitle(track.name)
      mp._updatePlayButton()
      mp._highlightPlaylistItem()
      if (mp._context === 'music-library' || track.suggested) mp._updatePlayerArt(track)
      mp._updateMediaSession(track)
      try {
        document.dispatchEvent(new CustomEvent('musicplayer:trackchange', { detail: { id: track.id, name: track.name } }))
      } catch(e) {}
    }

    // Reset crossfade trigger for next boundary
    mp._crossfadeTriggered = false
  }

  function _cancelCrossfade() {
    if (_crossfadeTimer) {
      clearInterval(_crossfadeTimer)
      _crossfadeTimer = null
    }
    if (mp._crossfadeAudio) {
      mp._crossfadeAudio.pause()
      mp._crossfadeAudio.src = ''
      mp._crossfadeAudio = null
    }
    mp._crossfadeActive = false
    mp._crossfadeProgress = 0
    _applyOutputVolume(mp._desiredVolume)
  }

  Object.assign(mp, {
    playMusicLibrary,
    open,
    onFolderChanged,
    _canAutoQueueSuggested,
    _generateShuffleOrder,
    _toggleAutoplay,
    _autoQueueSuggested,
    _startCrossfade,
    _finalizeCrossfade,
    _cancelCrossfade,
  })
})(window._mpCore)
