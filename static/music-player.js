// ─── ONE.GY Music Player: Public API (window.MusicPlayer) and init ───
;(function(mp) {
  'use strict'

  const { _jsonHeaders, _lsGet, _lsSet, audio, _silentBlobUrl, _volCurve, _setVolume } = mp

  let _audioPlayPrimed = false      // true = audio.play() has been called in a user gesture context
  let _singletonEventsBound = false
  // DOM references only init's bindings use (shared ones live on mp)
  let prevBtn, nextBtn, volumeSlider, closeBtn, mobileCloseBtn

  // ─── Public API ─────────────────────────────────────────────────
  const MusicPlayer = {
    init,
    open: mp.open,
    playMusicLibrary: mp.playMusicLibrary,
    isActive: () => mp.isVisible,
    hasAudio: () => mp.isVisible && (mp.currentIndex >= 0 || !audio.paused),
    getContext: () => mp._context,
    getCurrentTrackId: () => (mp.currentIndex >= 0 && mp.playlist[mp.currentIndex]) ? mp.playlist[mp.currentIndex].id : null,
    getPlaylist: () => mp.playlist.slice(),
    getCurrentIndex: () => mp.currentIndex,
    onFolderChanged: mp.onFolderChanged,
    getAudioElement: () => audio,
    close: mp.closePlayer,
    setFsHeartState: mp._setFsHeartState,
    setBarHeartState: mp._setBarHeartState,
    isFullscreen: () => mp._isFullscreen,
    isPhantomMode: () => mp._syncPhantomMode,
    sendSyncCommand: mp._syncSendCommand,
    updatePhantomTrack: mp._syncPhantomUpdateTrack,
  }

  function init(context, shareToken) {
    mp._context = context || 'dashboard'
    mp._browseShareToken = shareToken || ''

    mp.playerEl = document.getElementById('musicPlayer')
    if (!mp.playerEl) return
    _bindDomRefs()

    if (mp.playerEl._mpInitialized) {
      mp._updateOwnLibraryState()
      return
    }
    mp.playerEl._mpInitialized = true

    _restructureBar()

    // Set initial own-library state based on context
    mp._updateOwnLibraryState()

    _restoreToggles()
    _bindTransportControls()
    _bindVolumeControls()
    _bindProgressScrub()
    _bindPlaylistToggle()
    mp._bindSwipeDismiss()
    _bindAudioEvents()
    _bindTitleLinks()

    // ── Mobile fullscreen "Now Playing" setup (music page only) ──
    try { mp._initFullscreen() } catch(e) { console.warn('[MUSIC PLAYER] Fullscreen init error:', e) }

    // ── Media Session API (lock screen / notification controls) ──
    mp._initMediaSession()

    // ── Cross-device sync setup ──
    _initSyncControls()

    // Try to restore playback state from a previous page
    mp._restoreState()

    // Start sync polling after restore (so we know if we're already playing)
    if (mp._context === 'music-library' && mp._syncLoggedIn && mp._syncEnabled) {
      mp._syncStart()
    }

    _bindAutoplayPrimer()
  }

  function _bindDomRefs() {
    mp.titleEl = document.getElementById('mpTitle')
    mp.titleInner = mp.titleEl ? mp.titleEl.querySelector('.mp-title-inner') : null
    mp.artistEl = document.getElementById('mpArtist')
    mp.currentTimeEl = document.getElementById('mpCurrentTime')
    mp.durationEl = document.getElementById('mpDuration')
    mp.progressEl = document.getElementById('mpProgress')
    mp.playBtn = document.getElementById('mpPlay')
    prevBtn = document.getElementById('mpPrev')
    nextBtn = document.getElementById('mpNext')
    mp.shuffleBtn = document.getElementById('mpShuffle')
    mp.repeatBtn = document.getElementById('mpRepeat')
    mp.volumeBtn = document.getElementById('mpVolBtn')
    volumeSlider = document.getElementById('mpVolume')
    closeBtn = document.getElementById('mpClose')
    mobileCloseBtn = document.getElementById('mpMobileClose')
    mp.playlistBtn = document.getElementById('mpPlaylistBtn')
    mp.playlistPanel = document.getElementById('mpPlaylistPanel')
    mp.fxBtn = document.getElementById('mpFxBtn')
    mp.autoplayBtn = document.getElementById('mpAutoplay')
    mp.devicesBtn = document.getElementById('mpDevicesBtn')
    mp.devicesPanel = document.getElementById('mpDevicesPanel')
    mp.devicesList = document.getElementById('mpDevicesList')
    mp.phantomLabel = document.getElementById('mpPhantomLabel')
    mp.miniDevicesBtn = document.getElementById('mpMiniDevices')
    mp.fsDevicesBtn = document.getElementById('mpFsDevicesBtn')
    mp._fxCanvas = document.getElementById('mpVisualizer')
    if (mp._fxCanvas) mp._fxCtx = mp._fxCanvas.getContext('2d')
  }

  // Restructure player layout for Spotify-style bar (all pages)
  function _restructureBar() {
    var mainGrid = mp.playerEl.querySelector('.music-player-main')
    var progWrap = mp.playerEl.querySelector('.music-player-progress-wrap')
    var controlsEl = mp.playerEl.querySelector('.music-player-controls')
    var rightEl = mp.playerEl.querySelector('.music-player-right')
    var volumeEl = mp.playerEl.querySelector('.music-player-volume')

    // Move progress bar to be a direct grid child (centered under controls)
    if (mainGrid && progWrap) {
      progWrap.classList.add('mp-progress-center')
      if (controlsEl && controlsEl.nextSibling) {
        mainGrid.insertBefore(progWrap, controlsEl.nextSibling)
      } else {
        mainGrid.appendChild(progWrap)
      }
    }

    // Move volume from controls into the right group (before playlist btn)
    if (rightEl && volumeEl) {
      rightEl.insertBefore(volumeEl, rightEl.firstChild)
    }
    // Autoplay is a queue setting, not a transport control: right group too
    var autoplayEl = document.getElementById('mpAutoplay')
    if (rightEl && autoplayEl) rightEl.insertBefore(autoplayEl, rightEl.firstChild)

    // Add heart + "add to playlist" buttons inside info area, next to title/artist
    var infoEl = mp.playerEl.querySelector('.music-player-info')
    if (infoEl) _addBarTrackButtons(infoEl)

    // Move FX button to right group (top-right of player) and hide its divider
    var fxBtnEl = document.getElementById('mpFxBtn')
    if (fxBtnEl && rightEl) {
      // Remove the divider that follows the FX button
      var divider = fxBtnEl.nextElementSibling
      if (divider && divider.classList.contains('mp-controls-divider')) {
        divider.remove()
      }
      // Move FX button to end of right group
      rightEl.appendChild(fxBtnEl)
    }
  }

  // Heart + "add to playlist" buttons inside the info area, next to title/artist
  function _addBarTrackButtons(infoEl) {
    // Heart (like) button — left of the + button
    var barHeartBtn = document.createElement('button')
    barHeartBtn.className = 'mp-btn mp-btn-sm mp-bar-heart'
    barHeartBtn.id = 'mpBarHeart'
    barHeartBtn.title = 'Like'
    barHeartBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    infoEl.appendChild(barHeartBtn)

    // Add-to-playlist button
    var addBtn = document.createElement('button')
    addBtn.className = 'mp-btn mp-btn-sm mp-add-to-playlist'
    addBtn.id = 'mpAddToPlaylist'
    addBtn.title = 'Add to playlist'
    addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'
    infoEl.appendChild(addBtn)
    // Same "add to playlist" menu as the fullscreen + button (music.js owns it)
    addBtn.addEventListener('click', function(e) {
      e.stopPropagation()
      var trackId = MusicPlayer.getCurrentTrackId()
      if (trackId) document.dispatchEvent(new CustomEvent('musicplayer:fsadd', { detail: { id: trackId, button: addBtn } }))
    })

    // Heart button click: on the music page music.js owns like state and
    // queues the requests (same path as the fullscreen heart); elsewhere call
    // the API directly, one request at a time so a double click is not lost.
    barHeartBtn.addEventListener('click', function(e) {
      e.stopPropagation()
      var trackId = (mp.currentIndex >= 0 && mp.playlist[mp.currentIndex]) ? mp.playlist[mp.currentIndex].id : null
      if (!trackId) return
      if (window.MusicBrowse) {
        document.dispatchEvent(new CustomEvent('musicplayer:fslike', { detail: { id: trackId, button: barHeartBtn } }))
        return
      }
      if (barHeartBtn._busy) return
      barHeartBtn._busy = true
      // Ask for the state the heart shows the user, not a server-side toggle.
      fetch('/music/api/likes/' + encodeURIComponent(trackId), {
        method: 'POST',
        headers: _jsonHeaders(),
        credentials: 'same-origin',
        body: JSON.stringify({ liked: !barHeartBtn.classList.contains('liked') })
      })
        .then(function(r) {
          if (!r.ok) throw new Error('like failed: ' + r.status)
          return r.json()
        })
        .then(function(data) {
          if (typeof data.liked !== 'boolean') throw new Error('like failed')
          if (MusicPlayer.getCurrentTrackId() === trackId) {
            mp._setBarHeartState(data.liked)
            mp._setFsHeartState(data.liked)
          }
          // Notify music.js (if loaded) to sync browse list hearts + liked count
          document.dispatchEvent(new CustomEvent('musicplayer:likechanged', { detail: { id: trackId, liked: data.liked } }))
        })
        .catch(function() {
          if (typeof showToast === 'function') showToast('COULD NOT UPDATE LIKE', 'error')
        })
        .then(function() { barHeartBtn._busy = false })
    })
  }

  function _restoreToggles() {
    // Restore FX toggle state (default: on for new users)
    const savedFx = _lsGet('mp_fx')
    mp._fxEnabled = savedFx === null ? true : savedFx === '1'
    if (mp.fxBtn && mp._fxEnabled) mp.fxBtn.classList.add('mp-btn-active')

    // Autoplay toggle (default: on)
    if (mp.autoplayBtn) {
      if (mp._autoplayEnabled) mp.autoplayBtn.classList.add('mp-btn-active')
      mp.autoplayBtn.addEventListener('click', mp._toggleAutoplay)
    }

    // Set initial volume from saved state (slider shows linear position, not curved volume)
    if (volumeSlider) {
      volumeSlider.value = Math.round(mp._volSlider * 100)
      audio.muted = mp._volSlider === 0
      mp._updateVolumeIcon()
    }
  }

  function _bindTransportControls() {
    // Mini play button for mobile music mini bar
    mp.miniPlayBtn = document.getElementById('mpMiniPlay')
    if (mp.miniPlayBtn) {
      mp.miniPlayBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        mp.togglePlay()
      })
    }

    // Fullscreen action buttons (heart + add to playlist)
    mp.fsHeartBtn = document.getElementById('mpFsHeart')
    mp.fsAddBtn = document.getElementById('mpFsAdd')

    // Bind controls
    if (mp.playBtn) mp.playBtn.addEventListener('click', mp.togglePlay)
    if (prevBtn) prevBtn.addEventListener('click', mp.playPrevious)
    if (nextBtn) nextBtn.addEventListener('click', mp.playNext)
    if (mp.shuffleBtn) mp.shuffleBtn.addEventListener('click', mp.toggleShuffle)
    if (mp.repeatBtn) mp.repeatBtn.addEventListener('click', mp.cycleRepeat)
    if (closeBtn) closeBtn.addEventListener('click', mp.closePlayer)
    if (mobileCloseBtn) mobileCloseBtn.addEventListener('click', mp.closePlayer)
    if (mp.fxBtn) mp.fxBtn.addEventListener('click', mp._toggleFx)
  }

  function _bindVolumeControls() {
    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        mp._volSlider = e.target.value / 100
        _setVolume(_volCurve(mp._volSlider))
        audio.muted = mp._volSlider === 0
        _lsSet('mp_volume', mp._volSlider)
        mp._updateVolumeIcon()
      })
    }

    if (mp.volumeBtn) {
      mp.volumeBtn.addEventListener('click', () => {
        if (mp._volSlider > 0) {
          mp.volumeBtn._prevSlider = mp._volSlider
          mp._volSlider = 0
          _setVolume(0)
          audio.muted = true
        } else {
          mp._volSlider = mp.volumeBtn._prevSlider || 0.5
          _setVolume(_volCurve(mp._volSlider))
          audio.muted = false
        }
        if (volumeSlider) volumeSlider.value = Math.round(mp._volSlider * 100)
        _lsSet('mp_volume', mp._volSlider)
        mp._updateVolumeIcon()
      })
    }
  }

  // Scrubbing: the thumb follows the pointer and only the release seeks.
  // timeupdate / phantom interpolation rewrote the value mid-drag (the thumb
  // fought the pointer) and every input event seeked, or in phantom mode sent
  // a remote seek command. Keyboard steps still seek one by one.
  function _bindProgressScrub() {
    if (mp.progressEl) {
      mp.progressEl.addEventListener('pointerdown', function() {
        mp._scrubbing = true
        document.addEventListener('pointerup', function() { setTimeout(function() { mp._scrubbing = false }, 0) }, { once: true })
      })
      mp.progressEl.addEventListener('input', function() {
        mp._updateProgressFill()
        if (!mp._scrubbing) { mp._seekToProgress(); return }
        var dur = mp._syncPhantomMode ? mp._syncPhantomDuration : audio.duration
        if (mp.currentTimeEl && dur > 0 && isFinite(dur)) mp.currentTimeEl.textContent = mp._formatTime((mp.progressEl.value / 1000) * dur)
      })
      mp.progressEl.addEventListener('change', function() {
        if (mp._scrubbing) mp._seekToProgress()
        mp._scrubbing = false
      })
    }
  }

  // Playlist panel toggle
  function _bindPlaylistToggle() {
    if (mp.playlistBtn) {
      mp.playlistBtn.addEventListener('click', () => {
        if (mp.playlistPanel) {
          mp.playlistPanel.classList.toggle('mp-playlist-visible')
          mp.playlistBtn.classList.toggle('mp-btn-active')
          // Close devices panel when playlist opens
          if (mp.devicesPanel) mp.devicesPanel.classList.remove('mp-devices-visible')
        }
      })
    }
  }

  function _bindAudioEvents() {
    if (!_singletonEventsBound) {
      audio.addEventListener('timeupdate', mp._onTimeUpdate)
      audio.addEventListener('loadedmetadata', mp._onMetadataLoaded)
      audio.addEventListener('ended', mp._onTrackEnded)
      audio.addEventListener('play', mp._onAudioPlay)
      audio.addEventListener('pause', mp._onAudioPause)
      audio.addEventListener('error', mp._onError)
      // Only real playback ends an error streak (not the silent keepalive loop).
      audio.addEventListener('playing', function () { if (!audio.loop) mp._errorSkipCount = 0 })
      document.addEventListener('keydown', mp._onGlobalKeydown)
      _singletonEventsBound = true
    }
  }

  // Clickable title (-> album) and artist links (-> artist) for music library tracks
  // On mobile mini bar, these are disabled so taps expand to fullscreen instead
  function _bindTitleLinks() {
    if (mp.titleEl) {
      mp.titleEl.addEventListener('click', function() {
        if (!mp._isFullscreen && window.matchMedia('(max-width: 850px)').matches) return
        var albumId = mp.titleEl.dataset.albumId
        if (albumId) mp._navigateMusic('album', albumId)
      })
    }
    if (mp.artistEl) {
      mp.artistEl.addEventListener('click', function(e) {
        if (!mp._isFullscreen && window.matchMedia('(max-width: 850px)').matches) return
        var link = e.target.closest('.mp-artist-link')
        if (link && link.dataset.artistId) {
          mp._navigateMusic('artist', link.dataset.artistId)
        }
      })
    }
  }

  function _initSyncControls() {
    // _nav.html renders the account-menu avatar button only for a signed-in user.
    mp._syncLoggedIn = !!document.querySelector('.rd-avatar-btn')
    mp._initSyncDeviceId()
    if (mp.devicesBtn) {
      mp.devicesBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        mp._toggleDevicesPanel()
      })
    }
    if (mp.miniDevicesBtn) {
      mp.miniDevicesBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        e.preventDefault()
        mp._toggleDevicesPanel()
      })
    }
    if (mp.fsDevicesBtn) {
      mp.fsDevicesBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        mp._toggleDevicesPanel()
      })
    }
    // Show devices buttons for music-library context when logged in
    if (mp._context === 'music-library' && mp._syncLoggedIn) {
      if (mp.devicesBtn) mp.devicesBtn.style.display = ''
      if (mp.miniDevicesBtn) mp.miniDevicesBtn.style.display = ''
      if (mp.fsDevicesBtn) mp.fsDevicesBtn.style.display = ''
    }
  }

  // ── Pre-warm autoplay permission for phantom mode ──
  // Mobile browsers require a user gesture to allow audio.play().
  // Phantom mode enters from a fetch() callback (no gesture), so the
  // silent keepalive may be blocked by autoplay policy.  On the very
  // first user interaction, resume the AudioContext and play+pause the
  // silent blob on a throwaway element. The shared element is never
  // touched: this capture-phase click may be the one starting a track, or
  // a restored track may already own it.
  function _bindAutoplayPrimer() {
    if (_silentBlobUrl && mp._context === 'music-library' && mp._syncLoggedIn && mp._syncEnabled) {
      document.addEventListener('click', function _primeAutoplay() {
        if (_audioPlayPrimed) return
        _audioPlayPrimed = true
        if (mp._ensureAudioContext()) mp._resumeAudioContext()
        if (mp.currentIndex >= 0 || !audio.paused || mp._syncPhantomKeepaliveActive) return
        try {
          var primer = new Audio(_silentBlobUrl)
          primer.play().then(function() { primer.pause() }).catch(function() {})
        } catch (e) {}
      }, { once: true, capture: true })
    }
  }

  // ─── Expose globally ───────────────────────────────────────────
  window.MusicPlayer = MusicPlayer
})(window._mpCore)
