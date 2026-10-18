// ─── ONE.GY Music Player ─────────────────────────────────────────────
// A persistent floating music player that survives SPA folder navigation.
// Builds playlists from sibling audio files in the current folder view.
// Supports both server-encrypted and E2E encrypted audio files.

;(function() {
  'use strict'

  const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']
  const AUDIO_MIME = {
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac'
  }

  function _csrfToken() {
    var input = document.getElementById('csrf_token') || document.querySelector('input[name="csrf_token"]')
    if (input && input.value) return input.value
    var meta = document.querySelector('meta[name="csrf-token"]')
    return meta ? meta.getAttribute('content') : ''
  }

  function _jsonHeaders() {
    return {
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json',
      'X-CSRFToken': _csrfToken()
    }
  }

  // ─── State ──────────────────────────────────────────────────────
  let playlist = []          // [{id, name, extension, isE2E, sourceUrl, blobUrl}]
  let currentIndex = -1
  let shuffleMode = false
  let repeatMode = 'none'    // 'none' | 'all' | 'one'
  let shuffleOrder = []
  let shufflePos = -1
  let isVisible = false
  let isPlaying = false
  let _context = 'dashboard' // 'dashboard' | 'browse'
  let _browseShareToken = ''
  let _currentBlobUrl = null
  let _autoplayEnabled = localStorage.getItem('mp_autoplay') !== '0'  // default: on
  let _suggestedStartIndex = -1  // index where suggested tracks begin in playlist
  let _crossfadeActive = false
  let _crossfadeAudio = null
  let _crossfadeTimer = null
  let _crossfadeProgress = 0
  let _crossfadeTriggered = false  // prevents re-triggering crossfade for same boundary
  let _isFullscreen = false        // mobile fullscreen "now playing" state
  let _fsMql = null                // matchMedia listener for mobile breakpoint
  let _errorSkipCount = 0          // consecutive error-skip counter (prevents infinite loops)
  let _lastPositionUpdate = 0      // timestamp of last Media Session position update
  let _loadSeq = 0

  // ─── Cross-Device Sync State ───────────────────────────────────
  let _syncEnabled = localStorage.getItem('mp_sync_enabled') !== '0'  // on by default
  let _syncDeviceId = localStorage.getItem('mp_device_id') || null
  let _syncDeviceName = localStorage.getItem('mp_device_name') || ''
  let _syncInterval = null          // setInterval handle for polling
  let _syncIsActive = false         // true = this device is outputting audio
  let _syncPhantomMode = false      // true = showing remote state, no local audio
  let _syncLastPollData = null      // last poll response from server
  let _syncDevices = []             // list of known devices from server
  let _syncPushPending = false      // debounce flag for push
  let _syncForceActive = false      // send force_active on next push (explicit user action)
  let _syncLoggedIn = false         // whether user is logged in (set in init)
  let _syncFastMode = false          // true = 1s polling (multi-device active), false = 3s
  let _syncPhantomTime = 0          // interpolated current time for phantom progress
  let _syncPhantomDuration = 0      // duration from last phantom state
  let _syncPhantomPlaying = false   // whether remote is playing (for interpolation)
  let _syncPhantomPollTs = 0        // Date.now() when last phantom state was received
  let _syncPhantomTrackId = null    // track ID to detect track changes
  let _syncPhantomRAF = null        // requestAnimationFrame handle for interpolation
  let _syncPhantomStateTs = null    // ISO timestamp of last state update from active device
  let _syncPhantomStale = false     // true = remote device stopped updating (>10s)
  let _syncCommandResult = null     // command result to send with next push (e.g. play failure)
  let _syncResultAckPending = null  // requester result retained until ack POST succeeds
  let _syncResultAckInFlight = false
  let _syncKeepAliveTimer = null    // setInterval handle for silent audio keepalive
  let _syncPhantomKeepaliveActive = false  // true = silent WAV is looping on audio element for Media Session
  let _syncPhantomPositionTimer = null  // setInterval for lock-screen position updates (survives background)
  let _audioPlayPrimed = false      // true = audio.play() has been called in a user gesture context
  let _singletonEventsBound = false

  // ─── Visualizer State ──────────────────────────────────────────
  let _fxEnabled = false
  let _audioCtx = null
  let _analyser = null
  let _gainNode = null   // volume control via Web Audio (keeps analyser full-strength)
  let _sourceNode = null
  let _fxRafId = null
  let _fxCanvas = null
  let _fxCtx = null
  let _fxConnected = false
  let _fxSmoothed = null  // smoothed bar heights for silky animation

  // ─── Chaos Mode (Easter Egg) ────────────────────────────────────
  let _chaosMode = false
  let _chaosClickTimes = []
  const _CHAOS_CLICKS = 10
  const _CHAOS_WINDOW = 2500 // ms
  let _chaosParticles = []
  let _chaosRings = []
  let _chaosArcs = []
  let _chaosHue = 0
  let _chaosPrevBass = 0
  let _chaosShakeX = 0
  let _chaosShakeY = 0
  let _chaosFlash = 0
  let _chaosLockedUntil = 0        // timestamp: ignore clicks until this time after activation

  // ─── iOS Detection ────────────────────────────────────────────
  // iOS Safari suspends audio when the page is backgrounded and requires
  // special handling to maintain background playback and Media Session controls.
  var _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  var _wasPlayingBeforeBackground = false  // tracks if audio was playing when page was hidden
  var _iosBackgroundRetryTimer = null      // retry timer for iOS background resume

  // ─── Audio Element (singleton, never destroyed) ─────────────────
  // Appended to the DOM (hidden) so iOS Safari treats it as a proper
  // media element eligible for background playback and Media Session.
  const audio = new Audio()
  audio.preload = 'auto'
  // iOS requires the element to be in the DOM for background audio privileges.
  // Setting display:none would cause some browsers to deprioritise the element,
  // so we use dimensions 0 + hidden visibility instead.
  audio.style.position = 'absolute'
  audio.style.width = '0'
  audio.style.height = '0'
  audio.style.overflow = 'hidden'
  audio.style.opacity = '0'
  audio.style.pointerEvents = 'none'
  audio.setAttribute('playsinline', '')
  audio.setAttribute('webkit-playsinline', '')
  // Append to <body> as soon as DOM is ready
  if (document.body) {
    document.body.appendChild(audio)
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      document.body.appendChild(audio)
    })
  }

  // ─── Silent audio blob for phantom mode Media Session keepalive ─
  // Mobile browsers only show notification/lock-screen media controls when
  // an <audio> element is actively playing.  In phantom (remote-control)
  // mode we have no real audio to play, so we loop a tiny silent WAV to
  // keep the Media Session alive and the notification controls visible.
  var _silentBlobUrl = null
  ;(function _createSilentBlob() {
    try {
      // 10 seconds of near-silence, mono, 44100 Hz, 16-bit PCM WAV.
      // Chrome Android classifies audio <= 5s as "Transient" and will NEVER
      // show a media notification for it.  Duration must exceed 5s to get
      // "Persistent" classification which triggers the lock-screen controls.
      var sampleRate = 44100, seconds = 10, channels = 1, bitsPerSample = 16
      var numSamples = sampleRate * seconds
      var dataSize = numSamples * channels * (bitsPerSample / 8)
      var buffer = new ArrayBuffer(44 + dataSize)
      var view = new DataView(buffer)
      // RIFF header
      var writeStr = function(offset, str) { for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)) }
      writeStr(0, 'RIFF')
      view.setUint32(4, 36 + dataSize, true)
      writeStr(8, 'WAVE')
      // fmt sub-chunk
      writeStr(12, 'fmt ')
      view.setUint32(16, 16, true)         // sub-chunk size
      view.setUint16(20, 1, true)          // PCM format
      view.setUint16(22, channels, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true) // byte rate
      view.setUint16(32, channels * (bitsPerSample / 8), true)             // block align
      view.setUint16(34, bitsPerSample, true)
      // data sub-chunk — near-silent samples (amplitude 1/32767).
      // Pure zero-energy silence may not activate Media Session on some
      // mobile browsers that use audio energy detection.  Amplitude 1 is
      // completely inaudible but registers as non-zero energy.
      writeStr(36, 'data')
      view.setUint32(40, dataSize, true)
      for (var s = 0; s < numSamples; s++) {
        view.setInt16(44 + s * 2, 1, true)
      }
      _silentBlobUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
    } catch(e) {
      console.warn('[MUSIC PLAYER] Could not create silent audio blob:', e)
    }
  })()

  // Perceptual volume curve: slider position (0-1 linear) -> actual volume.
  // Quadratic curve with a 15% linear baseline so low slider positions are
  // still audible. 10% slider -> 4.2%, 30% -> 12.2%, 50% -> 28.8%, 75% -> 59%.
  function _volCurve(x) { return x <= 0 ? 0 : 0.15 * x + 0.85 * x * x }
  function _volCurveInv(v) {
    if (v <= 0) return 0
    // Solve 0.85x^2 + 0.15x - v = 0 via quadratic formula
    return (-0.15 + Math.sqrt(0.0225 + 3.4 * v)) / 1.7
  }
  // _volSlider tracks the slider position (0-1 linear, pre-curve).
  // localStorage stores this value so the slider restores to the same position.
  var _volSlider = parseFloat(localStorage.getItem('mp_volume') || '0.5')
  var _desiredVolume = _volCurve(_volSlider)
  audio.volume = _desiredVolume
  audio.muted = _volSlider === 0

  // Set the playback volume. Once the Web Audio graph is connected, volume is
  // controlled via the GainNode (so the analyser always sees full-strength
  // signal). Before that, we fall back to audio.volume.
  function _applyOutputVolume(v) {
    if (_gainNode) {
      _gainNode.gain.value = v
      audio.volume = 1  // keep element at full so analyser gets full signal
    } else {
      audio.volume = v
    }
  }

  function _applyCrossfadeVolumes(progress) {
    var fadeOut = Math.cos(progress * Math.PI * 0.5)
    var fadeIn = Math.sin(progress * Math.PI * 0.5)
    _applyOutputVolume(_desiredVolume * fadeOut)
    if (_crossfadeAudio) _crossfadeAudio.volume = _desiredVolume * fadeIn
  }

  function _setVolume(v) {
    _desiredVolume = Math.max(0, Math.min(1, v))
    if (_crossfadeActive) {
      _applyCrossfadeVolumes(_crossfadeProgress)
    } else {
      _applyOutputVolume(_desiredVolume)
    }
  }

  function _stripAudioExtension(name) {
    if (!name) return ''
    var dotIdx = name.lastIndexOf('.')
    if (dotIdx <= 0) return name
    var ext = name.substring(dotIdx + 1).toLowerCase()
    if (AUDIO_EXTS.includes(ext)) return name.substring(0, dotIdx)
    return name
  }

  // ─── DOM References (set in init) ──────────────────────────────
  let playerEl, titleEl, titleInner, artistEl, currentTimeEl, durationEl, progressEl
  let playBtn, prevBtn, nextBtn, shuffleBtn, repeatBtn
  let volumeBtn, volumeSlider, closeBtn, playlistBtn, playlistPanel, fxBtn, autoplayBtn, miniPlayBtn, mobileCloseBtn
  let fsHeartBtn, fsAddBtn
  let devicesBtn, devicesPanel, devicesList, phantomLabel, miniDevicesBtn, fsDevicesBtn

  // ─── Public API ─────────────────────────────────────────────────
  const MusicPlayer = {
    init,
    open,
    playMusicLibrary,
    isActive: () => isVisible,
    hasAudio: () => isVisible && (currentIndex >= 0 || !audio.paused),
    getContext: () => _context,
    getCurrentTrackId: () => (currentIndex >= 0 && playlist[currentIndex]) ? playlist[currentIndex].id : null,
    getPlaylist: () => playlist.slice(),
    getCurrentIndex: () => currentIndex,
    onFolderChanged,
    getAudioElement: () => audio,
    close: closePlayer,
    setFsHeartState: _setFsHeartState,
    setBarHeartState: _setBarHeartState,
    isFullscreen: () => _isFullscreen,
    isPhantomMode: () => _syncPhantomMode,
    sendSyncCommand: _syncSendCommand,
    updatePhantomTrack: _syncPhantomUpdateTrack,
  }

  /**
   * Play tracks from the music library catalog.
   * @param {Array} tracks - [{id, title, artists, album_name, cover_path, duration_ms, ...}]
   * @param {number} startIndex - Index to start playing from
   */
  function playMusicLibrary(tracks, startIndex) {
    if (!tracks || !tracks.length) return
    _resumeAudioContext()
    _context = 'music-library'
    _updateOwnLibraryState()

    // Build playlist from provided tracks
    playlist = tracks.map(t => ({
      id: t.id,
      name: (t.title || 'UNKNOWN').toUpperCase(),
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

    currentIndex = -1
    _suggestedStartIndex = -1
    _suggestApiUnavailable = false
    _crossfadeTriggered = false
    _cancelCrossfade()
    if (shuffleMode) {
      _generateShuffleOrder()
      // currentIndex is -1 here, so _generateShuffleOrder() skips its own
      // shufflePos reset. Anchor shufflePos to the starting track's position
      // in the freshly-generated order (mirrors open()), otherwise a stale
      // shufflePos from a previous playlist can be out of range and playback
      // stops after one track.
      _anchorShuffleAt(startIndex || 0)
    }
    _showPlayer()
    _loadTrack(startIndex || 0)
    _renderPlaylist()

    // Update album art in player
    _updatePlayerArt(playlist[startIndex || 0])

    // Mark this device as actively playing for sync (force claim — explicit user action)
    if (_syncLoggedIn && _syncEnabled) {
      _syncIsActive = true
      _syncForceActive = true
      if (devicesBtn) devicesBtn.style.display = ''
      _syncStart()  // ensure polling is running
    }
  }

  function _updatePlayerArt(track) {
    var artEl = playerEl ? playerEl.querySelector('.music-player-art') : null
    if (!artEl) return
    if (track && track.coverPath) {
      var coverId = track.coverPath.replace('covers/', '').replace('.jpg', '')
      artEl.innerHTML = '<img src="/music/cover/' + coverId + '" style="width:100%;height:100%;object-fit:cover;border-radius:8px" alt="">'
    } else {
      artEl.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
    }
  }

  // ─── Media Session API (lock screen / notification controls) ────
  function _updateMediaSession(track) {
    if (!('mediaSession' in navigator) || !track) return
    var title = _stripAudioExtension(track.name || '')
    var artwork = []
    if (track.coverPath) {
      var coverId = track.coverPath.replace('covers/', '').replace('.jpg', '')
      artwork = [{ src: '/music/cover/' + coverId, type: 'image/jpeg' }]
    }
    var artist = ''
    if (track.artists && track.artists.length > 0) {
      artist = track.artists.map(function(a) { return a.name }).join(', ')
    } else if (track.artistName) {
      artist = track.artistName
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title,
      artist: artist,
      artwork: artwork,
    })
    _updateMediaSessionPositionState()
  }

  function _onAudioPlay() {
    if (_syncPhantomMode) return  // silent keepalive — phantom manages its own state
    isPlaying = true
    _updatePlayButton()
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    try { document.dispatchEvent(new CustomEvent('musicplayer:playpause', { detail: { playing: true } })) } catch(e) {}
  }

  function _onAudioPause() {
    if (_syncPhantomMode) {
      if (_syncPhantomKeepaliveActive) {
        audio.play().then(function() {
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
          }
        }).catch(function() {})
      }
      return
    }
    if (_isIOS && document.visibilityState === 'hidden' && _wasPlayingBeforeBackground) {
      audio.play().catch(function() {})
      return
    }
    isPlaying = false
    _updatePlayButton()
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    try { document.dispatchEvent(new CustomEvent('musicplayer:playpause', { detail: { playing: false } })) } catch(e) {}
  }

  function _onGlobalKeydown(e) {
    if (!isVisible) return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return

    if (e.key === ' ' && !e.target.closest('.preview-modal') && !e.target.closest('.modal') && !e.target.closest('.music-modal-overlay')) {
      e.preventDefault()
      togglePlay()
    }
  }

  function _syncResetForLocalPlayback() {
    if (!_syncPhantomMode && !_syncPhantomKeepaliveActive && !_syncPhantomRAF && !_syncPhantomPositionTimer && !audio.loop) return

    _syncPhantomMode = false
    _syncPhantomTrackId = null
    _syncPhantomPlaying = false
    _syncPhantomStale = false
    _syncPhantomStateTs = null
    _syncPhantomKeepaliveActive = false
    if (_syncPhantomRAF) { cancelAnimationFrame(_syncPhantomRAF); _syncPhantomRAF = null }
    if (_syncPhantomPositionTimer) { clearInterval(_syncPhantomPositionTimer); _syncPhantomPositionTimer = null }
    if (playerEl) playerEl.classList.remove('mp-phantom')
    if (phantomLabel) phantomLabel.textContent = ''
    audio.loop = false
    audio.pause()
    audio.src = ''
    audio.muted = _volSlider === 0
  }

  function _updateMediaSessionPositionState() {
    if (!('mediaSession' in navigator)) return
    if (_syncPhantomMode) {
      // Use phantom interpolation data instead of the silent keepalive audio.
      // Always provide a valid duration — iOS won't show next/prev/scrubber
      // controls without one.  Fall back to 180s if the real duration is
      // unknown (e.g. first poll before loadedmetadata fires on remote).
      var dur = _syncPhantomDuration > 0 ? _syncPhantomDuration : 180
      var elapsed = _syncPhantomPlaying ? (Date.now() - _syncPhantomPollTs) / 1000 : 0
      var pos = Math.min(_syncPhantomTime + elapsed, dur)
      try {
        navigator.mediaSession.setPositionState({
          duration: dur,
          playbackRate: 1,
          position: pos,
        })
      } catch(e) {}
      return
    }
    if (!isNaN(audio.duration) && audio.duration > 0 && isFinite(audio.duration)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(audio.currentTime, audio.duration),
        })
      } catch(e) {}
    }
  }

  function _initMediaSession() {
    if (!('mediaSession' in navigator)) return
    var actions = {
      play: function() {
        if (_syncPhantomMode) {
          _syncSendCommand('play')
          isPlaying = true; _syncPhantomPlaying = true; _syncPhantomPollTs = Date.now()
          _updatePlayButton()
          navigator.mediaSession.playbackState = 'playing'
          _syncPhantomStartInterpolation()
          // Restart the silent keepalive if iOS killed it via native pause
          if (_syncPhantomKeepaliveActive && audio.paused) {
            audio.play().catch(function() {})
          }
          return
        }
        _resumeAudioContext()
        // On iOS, the Media Session play handler fires from Control Center /
        // lock screen but the AudioContext may still be suspended and the audio
        // element may have been released.  Retry aggressively with fallbacks.
        audio.play().then(function() {
          console.log('[MUSIC PLAYER] Media Session play: OK')
          _wasPlayingBeforeBackground = false
        }).catch(function(err) {
          console.warn('[MUSIC PLAYER] Media Session play failed:', err.message, '- retrying')
          // Retry 1: Resume AudioContext first, then play after a tick
          _resumeAudioContext()
          setTimeout(function() {
            audio.play().then(function() {
              console.log('[MUSIC PLAYER] Media Session play retry 1: OK')
              _wasPlayingBeforeBackground = false
            }).catch(function(err2) {
              console.warn('[MUSIC PLAYER] Media Session play retry 1 failed:', err2.message, '- resetting src')
              // Retry 2: Re-set audio source (iOS may have released the resource)
              var track = playlist[currentIndex]
              if (track) {
                var savedTime = audio.currentTime || 0
                var src = track.blobUrl || _currentBlobUrl || track.sourceUrl
                if (src) {
                  audio.src = src
                  audio.currentTime = savedTime
                  _resumeAudioContext()
                  audio.play().then(function() {
                    console.log('[MUSIC PLAYER] Media Session play retry 2 (src reset): OK')
                    _wasPlayingBeforeBackground = false
                  }).catch(function(err3) {
                    console.warn('[MUSIC PLAYER] Media Session play: all retries failed:', err3.message)
                  })
                }
              }
            })
          }, 100)
        })
      },
      pause: function() {
        if (_syncPhantomMode) {
          _syncSendCommand('pause')
          isPlaying = false; _syncPhantomPlaying = false
          _updatePlayButton()
          navigator.mediaSession.playbackState = 'paused'
          // iOS natively pauses the <audio> element when the user taps pause
          // on the lock screen.  After a microtask delay (to let iOS finish
          // its native pause), restart the silent keepalive so the Media
          // Session stays alive and controls remain responsive.
          if (_syncPhantomKeepaliveActive) {
            Promise.resolve().then(function() {
              if (_syncPhantomMode && audio.paused) {
                audio.play().then(function() {
                  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
                }).catch(function() {})
              }
            })
          }
          return
        }
        // User explicitly paused via Control Center / lock screen
        _wasPlayingBeforeBackground = false
        _stopIOSBackgroundKeepalive()
        audio.pause()
      },
      nexttrack: function() {
        if (_syncPhantomMode) { _syncSendCommand('next'); return }
        playNext()
      },
      previoustrack: function() {
        if (_syncPhantomMode) { _syncSendCommand('prev'); return }
        playPrevious()
      },
      seekto: function(details) {
        if (_syncPhantomMode) {
          if (details.seekTime != null && _syncPhantomDuration > 0) {
            var t = Math.min(details.seekTime, _syncPhantomDuration)
            _syncSendCommand('seek', { seekTime: t })
            _syncPhantomTime = t; _syncPhantomPollTs = Date.now()
            _syncPhantomRenderProgress(t, _syncPhantomDuration)
            _updateMediaSessionPositionState()
          }
          return
        }
        if (!isNaN(audio.duration) && details.seekTime != null) {
          audio.currentTime = Math.min(details.seekTime, audio.duration)
          _updateMediaSessionPositionState()
        }
      },
      seekforward: function(details) {
        if (_syncPhantomMode) {
          var fwd = details.seekOffset || 10
          var t = Math.min(_syncPhantomTime + fwd, _syncPhantomDuration || Infinity)
          _syncSendCommand('seek', { seekTime: t })
          _syncPhantomTime = t; _syncPhantomPollTs = Date.now()
          _syncPhantomRenderProgress(t, _syncPhantomDuration)
          _updateMediaSessionPositionState()
          return
        }
        var offset = details.seekOffset || 10
        audio.currentTime = Math.min(audio.currentTime + offset, audio.duration || Infinity)
        _updateMediaSessionPositionState()
      },
      seekbackward: function(details) {
        if (_syncPhantomMode) {
          var bwd = details.seekOffset || 10
          var t = Math.max(_syncPhantomTime - bwd, 0)
          _syncSendCommand('seek', { seekTime: t })
          _syncPhantomTime = t; _syncPhantomPollTs = Date.now()
          _syncPhantomRenderProgress(t, _syncPhantomDuration)
          _updateMediaSessionPositionState()
          return
        }
        var offset = details.seekOffset || 10
        audio.currentTime = Math.max(audio.currentTime - offset, 0)
        _updateMediaSessionPositionState()
      },
    }
    for (var action in actions) {
      try { navigator.mediaSession.setActionHandler(action, actions[action]) } catch(e) {}
    }
  }

  function init(context, shareToken) {
    _context = context || 'dashboard'
    _browseShareToken = shareToken || ''

    playerEl = document.getElementById('musicPlayer')
    if (!playerEl) return

    titleEl = document.getElementById('mpTitle')
    titleInner = titleEl ? titleEl.querySelector('.mp-title-inner') : null
    artistEl = document.getElementById('mpArtist')
    currentTimeEl = document.getElementById('mpCurrentTime')
    durationEl = document.getElementById('mpDuration')
    progressEl = document.getElementById('mpProgress')
    playBtn = document.getElementById('mpPlay')
    prevBtn = document.getElementById('mpPrev')
    nextBtn = document.getElementById('mpNext')
    shuffleBtn = document.getElementById('mpShuffle')
    repeatBtn = document.getElementById('mpRepeat')
    volumeBtn = document.getElementById('mpVolBtn')
    volumeSlider = document.getElementById('mpVolume')
    closeBtn = document.getElementById('mpClose')
    mobileCloseBtn = document.getElementById('mpMobileClose')
    playlistBtn = document.getElementById('mpPlaylistBtn')
    playlistPanel = document.getElementById('mpPlaylistPanel')
    fxBtn = document.getElementById('mpFxBtn')
    autoplayBtn = document.getElementById('mpAutoplay')
    devicesBtn = document.getElementById('mpDevicesBtn')
    devicesPanel = document.getElementById('mpDevicesPanel')
    devicesList = document.getElementById('mpDevicesList')
    phantomLabel = document.getElementById('mpPhantomLabel')
    miniDevicesBtn = document.getElementById('mpMiniDevices')
    fsDevicesBtn = document.getElementById('mpFsDevicesBtn')
    _fxCanvas = document.getElementById('mpVisualizer')
    if (_fxCanvas) _fxCtx = _fxCanvas.getContext('2d')

    if (playerEl._mpInitialized) {
      _updateOwnLibraryState()
      return
    }
    playerEl._mpInitialized = true

    // Restructure player layout for Spotify-style bar (all pages)
    if (playerEl) {
      var mainGrid = playerEl.querySelector('.music-player-main')
      var progWrap = playerEl.querySelector('.music-player-progress-wrap')
      var controlsEl = playerEl.querySelector('.music-player-controls')
      var rightEl = playerEl.querySelector('.music-player-right')
      var volumeEl = playerEl.querySelector('.music-player-volume')

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

      // Add heart + "add to playlist" buttons inside info area, next to title/artist
      var infoEl = playerEl.querySelector('.music-player-info')
      if (infoEl) {
        // Heart (like) button — left of the + button
        var barHeartBtn = document.createElement('button')
        barHeartBtn.className = 'mp-btn mp-btn-sm mp-bar-heart'
        barHeartBtn.id = 'mpBarHeart'
        barHeartBtn.title = 'LIKE'
        barHeartBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
        infoEl.appendChild(barHeartBtn)

        // Add-to-playlist button
        var addBtn = document.createElement('button')
        addBtn.className = 'mp-btn mp-btn-sm mp-add-to-playlist'
        addBtn.id = 'mpAddToPlaylist'
        addBtn.title = 'ADD TO PLAYLIST'
        addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'
        infoEl.appendChild(addBtn)

        // Heart button click — call like API directly (works on all pages)
        barHeartBtn.addEventListener('click', function(e) {
          e.stopPropagation()
          var trackId = (currentIndex >= 0 && playlist[currentIndex]) ? playlist[currentIndex].id : null
          if (!trackId) return
          fetch('/music/api/likes/' + trackId, {
            method: 'POST',
            headers: _jsonHeaders(),
            credentials: 'same-origin'
          })
            .then(function(r) { return r.json() })
            .then(function(data) {
              _setBarHeartState(data.liked)
              _setFsHeartState(data.liked)
              // Notify music-browse.js (if loaded) to sync browse list hearts + liked count
              document.dispatchEvent(new CustomEvent('musicplayer:likechanged', { detail: { id: trackId, liked: data.liked } }))
            })
            .catch(function() {})
        })
      }

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

    // Set initial own-library state based on context
    _updateOwnLibraryState()

    // Restore FX toggle state (default: on for new users)
    const savedFx = localStorage.getItem('mp_fx')
    _fxEnabled = savedFx === null ? true : savedFx === '1'
    if (fxBtn && _fxEnabled) fxBtn.classList.add('mp-btn-active')

    // Autoplay toggle (default: on)
    if (autoplayBtn) {
      if (_autoplayEnabled) autoplayBtn.classList.add('mp-btn-active')
      autoplayBtn.addEventListener('click', _toggleAutoplay)
    }

    // Set initial volume from saved state (slider shows linear position, not curved volume)
    if (volumeSlider) {
      volumeSlider.value = Math.round(_volSlider * 100)
      audio.muted = _volSlider === 0
      _updateVolumeIcon()
    }

    // Mini play button for mobile music mini bar
    miniPlayBtn = document.getElementById('mpMiniPlay')
    if (miniPlayBtn) {
      miniPlayBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        togglePlay()
      })
    }

    // Fullscreen action buttons (heart + add to playlist)
    fsHeartBtn = document.getElementById('mpFsHeart')
    fsAddBtn = document.getElementById('mpFsAdd')

    // Bind controls
    if (playBtn) playBtn.addEventListener('click', togglePlay)
    if (prevBtn) prevBtn.addEventListener('click', playPrevious)
    if (nextBtn) nextBtn.addEventListener('click', playNext)
    if (shuffleBtn) shuffleBtn.addEventListener('click', toggleShuffle)
    if (repeatBtn) repeatBtn.addEventListener('click', cycleRepeat)
    if (closeBtn) closeBtn.addEventListener('click', closePlayer)
    if (mobileCloseBtn) mobileCloseBtn.addEventListener('click', closePlayer)
    if (fxBtn) fxBtn.addEventListener('click', _toggleFx)

    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        _volSlider = e.target.value / 100
        _setVolume(_volCurve(_volSlider))
        audio.muted = _volSlider === 0
        localStorage.setItem('mp_volume', _volSlider)
        _updateVolumeIcon()
      })
    }

    if (volumeBtn) {
      volumeBtn.addEventListener('click', () => {
        if (_volSlider > 0) {
          volumeBtn._prevSlider = _volSlider
          _volSlider = 0
          _setVolume(0)
          audio.muted = true
        } else {
          _volSlider = volumeBtn._prevSlider || 0.5
          _setVolume(_volCurve(_volSlider))
          audio.muted = false
        }
        if (volumeSlider) volumeSlider.value = Math.round(_volSlider * 100)
        localStorage.setItem('mp_volume', _volSlider)
        _updateVolumeIcon()
      })
    }

    if (progressEl) {
      progressEl.addEventListener('input', (e) => {
        if (!isNaN(audio.duration) && audio.duration > 0) {
          audio.currentTime = (e.target.value / 1000) * audio.duration
        }
        _updateProgressFill()
      })
    }

    // Playlist panel toggle
    if (playlistBtn) {
      playlistBtn.addEventListener('click', () => {
        if (playlistPanel) {
          playlistPanel.classList.toggle('mp-playlist-visible')
          playlistBtn.classList.toggle('mp-btn-active')
          // Close devices panel when playlist opens
          if (devicesPanel) devicesPanel.classList.remove('mp-devices-visible')
        }
      })
    }

    // Swipe-down-to-dismiss on mobile (mini player: close; fullscreen: collapse with drag)
    // Use touch events with passive:false to prevent browser pull-to-refresh
    let _touchStartY = 0
    let _touchStartX = 0
    let _touchStarted = false
    let _touchStartTime = 0
    let _fsDragging = false      // true when actively dragging the fullscreen player
    let _fsScrolledAtStart = false  // whether the fullscreen player was scrolled when touch started

    const _setupSwipeDismiss = () => {
      if (!playerEl) return
      
      playerEl.addEventListener('touchstart', (e) => {
        // Don't capture if touching interactive elements
        if (e.target.closest('button, input, a, .music-player-progress, .mp-playlist-panel')) return

        _touchStartY = e.touches[0].clientY
        _touchStartX = e.touches[0].clientX
        _touchStartTime = Date.now()
        _touchStarted = true
        _fsDragging = false

        if (_isFullscreen) {
          // Check if the fullscreen player is scrolled (e.g. long playlist visible)
          _fsScrolledAtStart = playerEl.scrollTop > 0
        }
      }, { passive: false })

      playerEl.addEventListener('touchmove', (e) => {
        if (!_touchStarted) return
        const currentY = e.touches[0].clientY
        const currentX = e.touches[0].clientX
        const deltaY = currentY - _touchStartY
        const deltaX = Math.abs(currentX - _touchStartX)

        if (_isFullscreen) {
          // When not scrolled and moving downward, ALWAYS preventDefault to block
          // browser pull-to-refresh / native overscroll before it claims the gesture
          if (!_fsScrolledAtStart && deltaY > 0) {
            e.preventDefault()
          }
          // If we're already dragging the fullscreen panel, keep tracking
          if (_fsDragging) {
            var dragY = Math.max(0, deltaY) * 0.85  // resistance factor
            playerEl.style.transform = 'translateY(' + dragY + 'px)'
            // Fade opacity as user drags further (1.0 at 0px, ~0.6 at full screen height)
            var opacity = Math.max(0.4, 1 - (dragY / (window.innerHeight * 0.8)))
            playerEl.style.opacity = opacity
            return
          }
          // Start visual drag after small threshold, mostly vertical
          if (deltaY > 8 && deltaX < deltaY && !_fsScrolledAtStart) {
            _fsDragging = true
            playerEl.classList.add('mp-fs-dragging')
            return
          }
        } else {
          // Mini player: prevent pull-to-refresh when dragging down
          if (currentY > _touchStartY) {
            e.preventDefault()
          }
        }
      }, { passive: false })

      playerEl.addEventListener('touchend', (e) => {
        if (!_touchStarted) return
        _touchStarted = false

        if (_isFullscreen && _fsDragging) {
          _fsDragging = false
          var touchEndY = e.changedTouches[0].clientY
          var dragDistance = Math.max(0, (touchEndY - _touchStartY) * 0.85)
          var velocity = (touchEndY - _touchStartY) / Math.max(1, Date.now() - _touchStartTime)
          var threshold = window.innerHeight * 0.2  // 20% of screen height

          // Dismiss if dragged far enough or flicked fast enough
          if (dragDistance > threshold || velocity > 0.5) {
            // Animate out from current position
            playerEl.style.transition = 'transform 0.25s ease-in, opacity 0.25s ease-in'
            playerEl.style.transform = 'translateY(100%)'
            playerEl.style.opacity = '0'
            // After animation, clean up and actually collapse
            setTimeout(function() {
              playerEl.style.transition = ''
              playerEl.style.transform = ''
              playerEl.style.opacity = ''
              playerEl.classList.remove('mp-fs-dragging')
              // Collapse instantly (the visual slide-out already happened)
              _collapseFullscreen(true)
            }, 260)
          } else {
            // Snap back to original position
            playerEl.style.transition = 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
            playerEl.style.transform = 'translateY(0)'
            playerEl.style.opacity = '1'
            setTimeout(function() {
              playerEl.style.transition = ''
              playerEl.style.transform = ''
              playerEl.style.opacity = ''
              playerEl.classList.remove('mp-fs-dragging')
            }, 260)
          }
          return
        }

        if (_isFullscreen) return  // fullscreen but wasn't dragging, ignore

        // Mini player: dismiss on downward swipe > 50px
        var touchEndY2 = e.changedTouches[0].clientY
        var touchEndX2 = e.changedTouches[0].clientX
        var dY = touchEndY2 - _touchStartY
        var dX = Math.abs(touchEndX2 - _touchStartX)
        if (dY > 50 && dX < 50) {
          e.preventDefault()
          closePlayer()
        }
      }, { passive: false })
    }
    
    _setupSwipeDismiss()

    if (!_singletonEventsBound) {
      audio.addEventListener('timeupdate', _onTimeUpdate)
      audio.addEventListener('loadedmetadata', _onMetadataLoaded)
      audio.addEventListener('ended', _onTrackEnded)
      audio.addEventListener('play', _onAudioPlay)
      audio.addEventListener('pause', _onAudioPause)
      audio.addEventListener('error', _onError)
      // Only real playback ends an error streak (not the silent keepalive loop).
      audio.addEventListener('playing', function () { if (!audio.loop) _errorSkipCount = 0 })
      document.addEventListener('keydown', _onGlobalKeydown)
      _singletonEventsBound = true
    }

    // Clickable title (-> album) and artist links (-> artist) for music library tracks
    // On mobile mini bar, these are disabled so taps expand to fullscreen instead
    if (titleEl) {
      titleEl.addEventListener('click', function() {
        if (!_isFullscreen && window.matchMedia('(max-width: 850px)').matches) return
        var albumId = titleEl.dataset.albumId
        if (albumId) _navigateMusic('album', albumId)
      })
    }
    if (artistEl) {
      artistEl.addEventListener('click', function(e) {
        if (!_isFullscreen && window.matchMedia('(max-width: 850px)').matches) return
        var link = e.target.closest('.mp-artist-link')
        if (link && link.dataset.artistId) {
          _navigateMusic('artist', link.dataset.artistId)
        }
      })
    }

    // ── Mobile fullscreen "Now Playing" setup (music page only) ──
    try { _initFullscreen() } catch(e) { console.warn('[MUSIC PLAYER] Fullscreen init error:', e) }

    // ── Media Session API (lock screen / notification controls) ──
    _initMediaSession()

    // ── Cross-device sync setup ──
    // _nav.html renders the account-menu avatar button only for a signed-in user.
    _syncLoggedIn = !!document.querySelector('.rd-avatar-btn')
    _initSyncDeviceId()
    if (devicesBtn) {
      devicesBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        _toggleDevicesPanel()
      })
    }
    if (miniDevicesBtn) {
      miniDevicesBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        e.preventDefault()
        _toggleDevicesPanel()
      })
    }
    if (fsDevicesBtn) {
      fsDevicesBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        _toggleDevicesPanel()
      })
    }
    // Show devices buttons for music-library context when logged in
    if (_context === 'music-library' && _syncLoggedIn) {
      if (devicesBtn) devicesBtn.style.display = ''
      if (miniDevicesBtn) miniDevicesBtn.style.display = ''
      if (fsDevicesBtn) fsDevicesBtn.style.display = ''
    }

    // Try to restore playback state from a previous page
    _restoreState()

    // Start sync polling after restore (so we know if we're already playing)
    if (_context === 'music-library' && _syncLoggedIn && _syncEnabled) {
      _syncStart()
    }

    // Patch control buttons for phantom mode interception
    _patchSyncControls()

    // ── Pre-warm autoplay permission for phantom mode ──
    // Mobile browsers require a user gesture to allow audio.play().
    // Phantom mode enters from a fetch() callback (no gesture), so the
    // silent keepalive may be blocked by autoplay policy.  On the very
    // first user interaction, we briefly play+pause the silent blob to
    // establish autoplay permission before phantom mode is ever needed.
    if (_silentBlobUrl && _context === 'music-library' && _syncLoggedIn && _syncEnabled) {
      document.addEventListener('click', function _primeAutoplay() {
        if (_audioPlayPrimed || _syncPhantomKeepaliveActive) return
        // If audio is already playing locally, autoplay is established
        if (!audio.paused) { _audioPlayPrimed = true; return }
        _audioPlayPrimed = true
        _resumeAudioContext()
        audio.src = _silentBlobUrl
        audio.play().then(function() {
          // Autoplay permission established — clean up
          audio.pause()
          audio.src = ''
        }).catch(function() {
          // Not critical — permission may still work via MEI
          audio.src = ''
        })
      }, { once: true, capture: true })
    }
  }

  // ─── Open player with a specific track ──────────────────────────
  function open(fileId, fileName, extension, isE2E, options) {
    fileId = String(fileId)
    // When a user clicks a file to play from the dashboard/browse page,
    // switch context back from music-library so dashboard behavior takes over
    if (_context === 'music-library') {
      // Determine correct context from page: check if we're on browse or dashboard
      if (document.querySelector('.browse-container')) {
        _context = 'browse'
      } else {
        _context = 'dashboard'
      }
    }

    // Cross-device sync is only for the music-library experience.
    // Stop remote polling so dashboard/browse playback cannot be overwritten
    // by phantom updates from an earlier music-library session.
    _syncIsActive = false
    _syncForceActive = false
    _syncStop()
    if (devicesPanel) devicesPanel.classList.remove('mp-devices-visible')
    if (devicesBtn) devicesBtn.style.display = 'none'
    if (miniDevicesBtn) miniDevicesBtn.style.display = 'none'
    if (fsDevicesBtn) fsDevicesBtn.style.display = 'none'

    _updateOwnLibraryState()
    _suggestApiUnavailable = false
    _suggestedStartIndex = -1
    var singleTrack = options && options.singleTrack

    if (singleTrack) {
      // Single-track mode: play only this file, no playlist scanning
      playlist = [{ id: fileId, name: fileName, extension, isE2E, sourceUrl: _buildSourceUrl(fileId, fileName, isE2E) }]
      currentIndex = -1
      if (shuffleMode) _generateShuffleOrder()
      _showPlayer()
      _loadTrack(0)
      _renderPlaylist()
      return
    }

    buildPlaylist(options && options.tracks)
    
    // Find the track in the playlist
    let idx = playlist.findIndex(t => t.id === fileId)
    if (idx === -1) {
      // Track not in playlist (e.g., different folder), add it
      playlist = [{ id: fileId, name: fileName, extension, isE2E, sourceUrl: _buildSourceUrl(fileId, fileName, isE2E) }]
      idx = 0
    }

    if (shuffleMode) {
      _generateShuffleOrder()
      // Place the selected track at the current position
      _anchorShuffleAt(idx)
    }

    _showPlayer()
    _loadTrack(idx)
    _renderPlaylist()

    // Fetch audio files from subfolders in the background and append to playlist
    if (_context === 'dashboard') {
      _appendSubfolderAudio(options && options.folderId)
    }
  }

  // ─── Fetch audio files from subfolders and append to playlist ──
  async function _appendSubfolderAudio(folderId) {
    const targetPlaylist = playlist  // replaced (not mutated) when another playlist opens
    try {
      const url = folderId
        ? `/files/audio-recursive/${folderId}`
        : '/files/audio-recursive'
      const resp = await fetch(url)
      if (!resp.ok) return
      const data = await resp.json()
      if (playlist !== targetPlaylist) return
      if (!data.files || data.files.length === 0) return

      // Collect IDs already in the playlist (from the current folder DOM)
      const existingIds = new Set(playlist.map(t => t.id))
      let added = 0

      for (const f of data.files) {
        if (existingIds.has(f.id)) continue
        playlist.push({
          id: f.id,
          name: f.name,
          extension: f.extension,
          isE2E: f.is_e2e === true,
          sourceUrl: _buildSourceUrl(f.id, f.name, f.is_e2e === true),
        })
        added++
      }

      if (added > 0) {
        if (shuffleMode) _generateShuffleOrder()
        _renderPlaylist()
      }
    } catch (err) {
      console.error('[MusicPlayer] Failed to fetch subfolder audio:', err)
    }
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
    const oldIds = playlist.map(t => t.id).join(',')
    if (newIds !== oldIds) {
      // Preserve current track if it exists in new playlist
      const currentTrack = currentIndex >= 0 && currentIndex < playlist.length ? playlist[currentIndex] : null
      playlist = newPlaylist
      if (currentTrack) {
        const newIdx = playlist.findIndex(t => t.id === currentTrack.id)
        if (newIdx !== -1) {
          currentIndex = newIdx
        }
      }
      if (shuffleMode) _generateShuffleOrder()
      _renderPlaylist()
    }
  }

  // ─── Folder changed callback (from SPA navigation) ─────────────
  function onFolderChanged() {
    // If a track is loaded, keep the current playlist intact so music
    // continues playing when the user navigates to a different folder.
    // The playlist will rebuild naturally when the user clicks a new
    // audio file via open().
    if (currentIndex >= 0 && playlist.length > 0) return
    buildPlaylist()
  }

  // ─── Track Loading ──────────────────────────────────────────────
  async function _loadTrack(index) {
    if (!Number.isInteger(index) || index < 0 || index >= playlist.length) return
    const loadSeq = ++_loadSeq

    _syncResetForLocalPlayback()

    // Cancel any in-progress crossfade (e.g. user skipped manually)
    if (_crossfadeActive) _cancelCrossfade()
    _crossfadeTriggered = false  // allow crossfade to re-trigger for new tracks

    currentIndex = index
    const track = playlist[index]

    // Update UI immediately
    _setTitle(track.name)
    _updatePlayButton()
    _highlightPlaylistItem()
    if (progressEl) { progressEl.value = 0; progressEl.max = 1000 }
    _updateProgressFill()
    if (currentTimeEl) currentTimeEl.textContent = '0:00'
    if (durationEl) durationEl.textContent = '0:00'

    // Revoke previous blob URL
    if (_currentBlobUrl) {
      URL.revokeObjectURL(_currentBlobUrl)
      _currentBlobUrl = null
    }

    _resumeAudioContext()

    if (track.isE2E) {
      await _loadE2ETrack(track, loadSeq)
      // A newer _loadTrack started while decrypting: it owns the metadata and
      // trackchange events, so this superseded load must not publish them.
      if (loadSeq !== _loadSeq) return
    } else {
      if (loadSeq !== _loadSeq) return
      // For dashboard/temp context, the preview endpoint skips download counting
      // on Range requests (which the <audio> element always sends).  Fire a
      // lightweight POST so the play is counted as a download.
      if (_context === 'dashboard' || _context === 'temp') {
        fetch(`/file/${track.id}/track-play`, {
          method: 'POST',
          headers: { 'X-CSRFToken': _csrfToken() }
        }).catch(() => {})
      }
      audio.src = track.sourceUrl
      audio.play().then(function() {
        console.log('[MUSIC PLAYER] Play started OK for:', track.name)
      }).catch(function(err) {
        console.warn('[MUSIC PLAYER] Play failed:', err.name, err.message)
      })
    }

    // Update player art for music library tracks (including suggested tracks in any context)
    if (_context === 'music-library' || track.suggested) {
      _updatePlayerArt(track)
    }

    // Update Media Session (lock screen / notification controls)
    _updateMediaSession(track)

    // Fire track change event for music-browse.js
    try {
      document.dispatchEvent(new CustomEvent('musicplayer:trackchange', { detail: { id: track.id, name: track.name } }))
    } catch(e) {}
  }

  async function _loadE2ETrack(track, loadSeq) {
    _setTitle(track.name + ' (DECRYPTING...)')

    try {
      if (_context === 'dashboard') {
        if (typeof OneGyCrypto === 'undefined' || !OneGyCrypto.hasSessionKeys()) {
          _setTitle(track.name + ' (E2E KEYS UNAVAILABLE)')
          return
        }
        const masterKey = await OneGyCrypto.getMasterKeyFromSession()
        if (loadSeq !== _loadSeq) return
        if (!masterKey) {
          _setTitle(track.name + ' (MASTER KEY UNAVAILABLE)')
          return
        }
        const keyResp = await fetch(`/f/${track.id}/key-info`)
        if (loadSeq !== _loadSeq) return
        const keyInfo = await keyResp.json()
        if (!keyInfo.encrypted_file_key) {
          _setTitle(track.name + ' (FILE KEY NOT FOUND)')
          return
        }
        const encResp = await fetch(`/f/${track.id}/encrypted?preview=1`)
        if (!encResp.ok) {
          _setTitle(track.name + ' (FETCH FAILED)')
          return
        }
        const encData = await encResp.arrayBuffer()
        if (loadSeq !== _loadSeq) return
        const decrypted = await OneGyCrypto.decryptFileForDownload(
          encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
        )
        if (loadSeq !== _loadSeq) return
        const blob = new Blob([decrypted], { type: AUDIO_MIME[track.extension] || 'audio/mpeg' })
        const blobUrl = URL.createObjectURL(blob)
        if (loadSeq !== _loadSeq) {
          URL.revokeObjectURL(blobUrl)
          return
        }
        _currentBlobUrl = blobUrl
        audio.src = _currentBlobUrl
        _setTitle(track.name)
        audio.play().catch(err => console.warn('[MUSIC PLAYER] E2E play failed:', err.message))

      } else if (_context === 'temp') {
        // Temp upload page E2E: supports both passphrase and master-key wrapped files
        if (typeof OneGyCrypto === 'undefined') {
          _setTitle(track.name + ' (CRYPTO UNAVAILABLE)')
          return
        }
        var keyResp = await fetch('/f/' + track.id + '/key-info')
        if (loadSeq !== _loadSeq) return
        var keyInfo = await keyResp.json()
        if (!keyInfo.encrypted_file_key) {
          _setTitle(track.name + ' (FILE KEY NOT FOUND)')
          return
        }
        var encResp = await fetch('/f/' + track.id + '/encrypted?preview=1')
        if (!encResp.ok) {
          _setTitle(track.name + ' (FETCH FAILED)')
          return
        }
        var encData = await encResp.arrayBuffer()
        if (loadSeq !== _loadSeq) return
        var decrypted
        if (keyInfo.file_key_salt) {
          // Passphrase-wrapped: try per-file keychain first, then global sessionStorage
          var passphrase = null
          if (typeof TempKeychain !== 'undefined') {
            try { passphrase = await TempKeychain.get(track.id) } catch (e) {}
          }
          if (!passphrase) {
            try { passphrase = sessionStorage.getItem('e2e_passphrase') } catch (e) {}
          }
          if (!passphrase) {
            _setTitle(track.name + ' (PASSPHRASE UNAVAILABLE)')
            return
          }
          decrypted = await OneGyCrypto.decryptFileForGuestDownload(
            encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, keyInfo.file_key_salt, passphrase
          )
        } else if (OneGyCrypto.hasSessionKeys()) {
          // Master-key-wrapped
          var masterKey = await OneGyCrypto.getMasterKeyFromSession()
          decrypted = await OneGyCrypto.decryptFileForDownload(
            encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
          )
        } else {
          _setTitle(track.name + ' (KEYS UNAVAILABLE)')
          return
        }
        if (loadSeq !== _loadSeq) return
        var blob = new Blob([decrypted], { type: AUDIO_MIME[track.extension] || 'audio/mpeg' })
        var blobUrl = URL.createObjectURL(blob)
        if (loadSeq !== _loadSeq) {
          URL.revokeObjectURL(blobUrl)
          return
        }
        _currentBlobUrl = blobUrl
        audio.src = _currentBlobUrl
        _setTitle(track.name)
        audio.play().catch(function(err) { console.warn('[MUSIC PLAYER] E2E temp play failed:', err.message) })

      } else if (_context === 'browse') {
        // Browse page E2E uses link secret
        if (typeof OneGyCrypto === 'undefined') {
          _setTitle(track.name + ' (CRYPTO UNAVAILABLE)')
          return
        }
        const linkSecret = window._mpLinkSecret || ''
        if (!linkSecret || linkSecret.length < 10) {
          _setTitle(track.name + ' (LINK KEY UNAVAILABLE)')
          return
        }
        const keyResp = await fetch(`/f/${track.id}/key-info`)
        if (loadSeq !== _loadSeq) return
        const keyInfo = await keyResp.json()
        const encKey = keyInfo.link_encrypted_file_key || keyInfo.encrypted_file_key
        const encNonce = keyInfo.link_file_key_nonce || keyInfo.file_key_nonce
        if (!encKey) {
          _setTitle(track.name + ' (FILE KEY NOT FOUND)')
          return
        }
        const encResp = await fetch(`/f/${track.id}/encrypted?preview=1`)
        if (!encResp.ok) {
          _setTitle(track.name + ' (FETCH FAILED)')
          return
        }
        const encData = await encResp.arrayBuffer()
        if (loadSeq !== _loadSeq) return
        const decrypted = await OneGyCrypto.decryptFileFromLink(encData, encKey, encNonce, linkSecret)
        if (loadSeq !== _loadSeq) return
        const blob = new Blob([decrypted], { type: AUDIO_MIME[track.extension] || 'audio/mpeg' })
        const blobUrl = URL.createObjectURL(blob)
        if (loadSeq !== _loadSeq) {
          URL.revokeObjectURL(blobUrl)
          return
        }
        _currentBlobUrl = blobUrl
        audio.src = _currentBlobUrl
        _setTitle(track.name)
        audio.play().catch(err => console.warn('[MUSIC PLAYER] E2E browse play failed:', err.message))
      }
    } catch (err) {
      console.error('[MUSIC PLAYER] E2E decrypt error:', err)
      _setTitle(track.name + ' (DECRYPT FAILED)')
    }
  }

  // ─── Playback Controls ─────────────────────────────────────────
  function togglePlay() {
    _resumeAudioContext()
    if (audio.paused) {
      audio.play().catch(function(err) {
        console.warn('[MUSIC PLAYER] togglePlay failed:', err.name, err.message)
      })
    } else {
      // User explicitly paused — don't auto-resume on foreground return
      _wasPlayingBeforeBackground = false
      _stopIOSBackgroundKeepalive()
      audio.pause()
    }
  }

  function playNext() {
    if (playlist.length === 0) return
    _resumeAudioContext()
    if (repeatMode === 'one') {
      audio.currentTime = 0
      audio.play().catch(() => {})
      return
    }

    let nextIdx
    if (shuffleMode) {
      shufflePos++
      if (shufflePos >= shuffleOrder.length) {
        if (repeatMode === 'all') {
          _generateShuffleOrder()
          // The new order is anchored on the track that just ended; start the
          // next cycle past it instead of replaying it (as the auto-queue path does).
          shufflePos = (shuffleOrder.length > 1 && shuffleOrder[0] === currentIndex) ? 1 : 0
        } else if (_canAutoQueueSuggested()) {
          // Nothing loaded yet: keep the cursor on the last track so Previous
          // still steps back (a successful auto-queue re-anchors it below).
          shufflePos = shuffleOrder.length - 1
          // Auto-queue suggested songs from the music library
          var seqAtQueue = _loadSeq
          _autoQueueSuggested().then(function(added) {
            // Bail if a newer load started during the fetch (e.g. the user
            // clicked a different track), otherwise we'd clobber their choice.
            if (seqAtQueue !== _loadSeq) return
            if (added) {
              // _autoQueueSuggested already called _generateShuffleOrder().
              // shuffleOrder[0] is currentIndex (the track that just ended),
              // so advance past it to play a new track.
              shufflePos = 0
              if (shuffleOrder.length > 1 && shuffleOrder[0] === currentIndex) {
                shufflePos = 1
              }
              _loadTrack(shuffleOrder[shufflePos])
            } else {
              audio.pause()
            }
          })
          return
        } else {
          shufflePos = shuffleOrder.length - 1
          audio.pause()
          return
        }
      }
      nextIdx = shuffleOrder[shufflePos]
    } else {
      nextIdx = currentIndex + 1
      if (nextIdx >= playlist.length) {
        if (repeatMode === 'all') {
          nextIdx = 0
        } else if (_canAutoQueueSuggested()) {
          // Auto-queue suggested songs from the music library
          var seqAtQueueSeq = _loadSeq
          _autoQueueSuggested().then(function(added) {
            // Bail if a newer load started during the fetch (e.g. the user
            // clicked a different track), otherwise we'd clobber their choice.
            if (seqAtQueueSeq !== _loadSeq) return
            if (added) {
              // Use currentIndex + 1 (not a pre-captured index) because
              // _autoQueueSuggested may trim played tracks from the front,
              // shifting all indices. currentIndex is adjusted during trim.
              _loadTrack(currentIndex + 1)
            } else {
              audio.pause()
            }
          })
          return
        } else {
          audio.pause()
          return
        }
      }
    }
    _loadTrack(nextIdx)
  }

  function playPrevious() {
    if (playlist.length === 0) return
    // If more than 3 seconds in, restart current track
    if (audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }

    let prevIdx
    if (shuffleMode) {
      shufflePos--
      if (shufflePos < 0) {
        if (repeatMode === 'all') {
          shufflePos = shuffleOrder.length - 1
        } else {
          shufflePos = 0
          audio.currentTime = 0
          return
        }
      }
      prevIdx = shuffleOrder[shufflePos]
    } else {
      prevIdx = currentIndex - 1
      if (prevIdx < 0) {
        if (repeatMode === 'all') {
          prevIdx = playlist.length - 1
        } else {
          audio.currentTime = 0
          return
        }
      }
    }
    _loadTrack(prevIdx)
  }

  function _canAutoQueueSuggested() {
    return _autoplayEnabled && _context === 'music-library'
  }

  function toggleShuffle() {
    shuffleMode = !shuffleMode
    if (shuffleBtn) {
      shuffleBtn.classList.toggle('mp-btn-active', shuffleMode)
    }
    if (shuffleMode) {
      _generateShuffleOrder()
    }
  }

  function cycleRepeat() {
    if (repeatMode === 'none') {
      repeatMode = 'all'
    } else if (repeatMode === 'all') {
      repeatMode = 'one'
      if (_crossfadeActive) _cancelCrossfade()
    } else {
      repeatMode = 'none'
    }
    _updateRepeatButton()
  }

  function closePlayer() {
    _loadSeq++  // invalidate any in-flight track load (e.g. a pending decrypt)
    if (_isFullscreen) _collapseFullscreen(true)
    _cancelCrossfade()
    _stopIOSBackgroundKeepalive()
    _wasPlayingBeforeBackground = false
    audio.loop = false  // clear silent keepalive loop flag if set
    audio.pause()
    audio.src = ''
    if (_currentBlobUrl) {
      URL.revokeObjectURL(_currentBlobUrl)
      _currentBlobUrl = null
    }
    if (_chaosMode) _stopChaos()
    _stopFxLoop()
    // Reset sync state
    _syncIsActive = false
    _syncStop()
    _syncPhantomMode = false
    _syncPhantomTrackId = null
    _syncPhantomKeepaliveActive = false
    if (_syncPhantomRAF) { cancelAnimationFrame(_syncPhantomRAF); _syncPhantomRAF = null }
    if (_syncPhantomPositionTimer) { clearInterval(_syncPhantomPositionTimer); _syncPhantomPositionTimer = null }
    if (playerEl) playerEl.classList.remove('mp-phantom')
    if (phantomLabel) phantomLabel.textContent = ''
    if (devicesPanel) devicesPanel.classList.remove('mp-devices-visible')
    isVisible = false
    isPlaying = false
    currentIndex = -1
    playlist = []
    sessionStorage.removeItem('mp_state')
    _suggestedStartIndex = -1
    _suggestApiUnavailable = false
    _autoQueueLoading = false
    _autoQueuePromise = null
    _crossfadeTriggered = false
    if (playerEl) {
      playerEl.classList.remove('mp-visible', 'mp-fx-active', 'mp-fx-chaos')
      playerEl.classList.add('mp-hiding')
      playerEl.addEventListener('animationend', function handler() {
        playerEl.classList.remove('mp-hiding')
        playerEl.removeEventListener('animationend', handler)
      }, { once: true })
    }
    // Remove body padding adjustment
    document.body.classList.remove('music-player-active')
  }

  // ─── Progress bar fill ──────────────────────────────────────────
  function _updateProgressFill() {
    if (!progressEl) return
    var pct = (progressEl.value / progressEl.max) * 100
    var fillColor = _isFullscreen ? '#fff' : 'rgba(222,24,51,0.85)'
    var trackColor = _isFullscreen ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.08)'
    progressEl.style.background = 'linear-gradient(to right, ' + fillColor + ' ' + pct + '%, ' + trackColor + ' ' + pct + '%)'
  }

  // ─── Audio Event Handlers ──────────────────────────────────────
  function _onTimeUpdate() {
    if (_syncPhantomMode) return  // phantom mode drives progress via interpolation, not the silent keepalive
    if (!isNaN(audio.duration) && audio.duration > 0) {
      if (progressEl) progressEl.value = Math.round((audio.currentTime / audio.duration) * 1000)
      if (currentTimeEl) currentTimeEl.textContent = _formatTime(audio.currentTime)
      _updateProgressFill()

      // Update Media Session position state (throttled to ~every 5s)
      var now = Date.now()
      if (now - _lastPositionUpdate > 5000) {
        _lastPositionUpdate = now
        _updateMediaSessionPositionState()
      }

      // Crossfade: detect when approaching the autoplay boundary (never under
      // repeat-one, which must replay the current track instead of advancing)
      if (_canAutoQueueSuggested() && repeatMode !== 'one' && !_crossfadeActive && !_crossfadeTriggered) {
        var timeRemaining = audio.duration - audio.currentTime
        var isAtSuggestedBoundary = false

        if (_suggestedStartIndex > 0 && !shuffleMode) {
          // Non-shuffle: we are at the boundary if currentIndex is one before suggested start
          isAtSuggestedBoundary = (currentIndex === _suggestedStartIndex - 1)
        } else if (_suggestedStartIndex > 0 && shuffleMode) {
          // In shuffle: check if next shufflePos would enter suggested territory
          var nextShuffleIdx = shufflePos + 1
          if (nextShuffleIdx < shuffleOrder.length) {
            isAtSuggestedBoundary = playlist[shuffleOrder[nextShuffleIdx]] && playlist[shuffleOrder[nextShuffleIdx]].suggested
                                     && playlist[currentIndex] && !playlist[currentIndex].suggested
          }
        } else if (repeatMode !== 'all' && !shuffleMode && currentIndex === playlist.length - 1) {
          // Last track with no suggested tracks yet -- crossfade will happen after auto-queue
          // Pre-fetch suggestions so crossfade can work
          if (timeRemaining <= 10 && !_autoQueueLoading) {
            _autoQueueSuggested()
          }
        }

        if (isAtSuggestedBoundary && timeRemaining <= 5 && timeRemaining > 0.5) {
          _startCrossfade()
        }
      }
    }
  }

  function _onMetadataLoaded() {
    if (_syncPhantomMode) return  // silent keepalive — phantom manages duration display
    if (durationEl && !isNaN(audio.duration)) {
      durationEl.textContent = _formatTime(audio.duration)
    }
    if (progressEl) progressEl.max = 1000
    _updateMediaSessionPositionState()
  }

  function _onTrackEnded() {
    if (_syncPhantomMode) return  // silent keepalive loops — should never fire ended, but guard anyway
    if (_crossfadeActive) {
      // Crossfade is in progress -- finalize the transition
      _finalizeCrossfade()
      return
    }
    if (repeatMode === 'one') {
      _resumeAudioContext()
      audio.currentTime = 0
      audio.play().catch(() => {})
    } else {
      playNext()
    }
  }

  function _onError(e) {
    if (_syncPhantomMode) return  // silent keepalive — ignore errors
    console.error('[MUSIC PLAYER] Audio error:', e)
    var track = playlist[currentIndex]
    if (track) _setTitle(track.name + ' (PLAYBACK ERROR)')

    // Reset playing state so the UI accurately reflects that nothing is playing
    isPlaying = false
    _updatePlayButton()

    // Auto-advance to next track after a brief delay, but cap consecutive
    // error-skips to prevent infinite loops (e.g. total connectivity loss)
    _errorSkipCount++
    if (_errorSkipCount <= 3 && playlist.length > 1) {
      const skipSeq = _loadSeq
      setTimeout(function() {
        if (skipSeq === _loadSeq) playNext()  // a newer load/close supersedes the skip
      }, 1500)
    } else if (_errorSkipCount > 3) {
      console.warn('[MUSIC PLAYER] Too many consecutive errors, stopping auto-advance')
      _errorSkipCount = 0
    }
  }

  // ─── UI Helpers ─────────────────────────────────────────────────

  // Toggle heart/+ button visibility based on context.
  // When playing from user's own library (dashboard), hide the like/add buttons
  // since those files are already in the user's library.
  function _updateOwnLibraryState() {
    if (!playerEl) return
    if (_context === 'dashboard') {
      playerEl.classList.add('mp-own-library')
    } else {
      playerEl.classList.remove('mp-own-library')
    }
  }

  function _showPlayer() {
    if (isVisible) return
    isVisible = true
    if (playerEl) {
      playerEl.classList.remove('mp-hiding')
      playerEl.classList.add('mp-visible')
      if (_fxEnabled) {
        _startFx()
      }
    }
    document.body.classList.add('music-player-active')
    _updateOwnLibraryState()
  }

  // ─── Mobile Fullscreen "Now Playing" ─────────────────────────
  function _initFullscreen() {
    if (!playerEl) return

    // Collapse button in fullscreen header
    var collapseBtn = document.getElementById('mpFsCollapse')
    if (collapseBtn) {
      collapseBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        _collapseFullscreen()
      })
    }

    // Playlist button in fullscreen header
    var fsPlaylistBtn = document.getElementById('mpFsPlaylistBtn')
    if (fsPlaylistBtn) {
      fsPlaylistBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        if (playlistPanel) {
          playlistPanel.classList.toggle('mp-playlist-visible')
          if (playlistBtn) playlistBtn.classList.toggle('mp-btn-active')
          fsPlaylistBtn.classList.toggle('mp-btn-active')
          // Close devices panel when playlist opens
          if (devicesPanel) devicesPanel.classList.remove('mp-devices-visible')
        }
      })
    }

    // Tap on mini player bar (art or info area) to expand -- only on mobile
    var artEl = playerEl.querySelector('.music-player-art')
    var infoEl = playerEl.querySelector('.music-player-info')
    var expandTargets = [artEl, infoEl]
    expandTargets.forEach(function(el) {
      if (!el) return
      el.addEventListener('click', function(e) {
        if (_isFullscreen) return
        // Only expand on mobile
        if (!window.matchMedia('(max-width: 850px)').matches) return
        // Don't expand if clicking interactive children (buttons only)
        if (e.target.closest('button') || e.target.closest('a')) return
        e.stopPropagation()
        _expandFullscreen()
      })
    })

    // Fullscreen heart button -- dispatch event for music-browse.js to handle
    if (fsHeartBtn) {
      fsHeartBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        var trackId = (currentIndex >= 0 && playlist[currentIndex]) ? playlist[currentIndex].id : null
        if (!trackId) return
        document.dispatchEvent(new CustomEvent('musicplayer:fslike', { detail: { id: trackId, button: fsHeartBtn } }))
      })
    }

    // Fullscreen add-to-playlist button -- dispatch event for music-browse.js to handle
    if (fsAddBtn) {
      fsAddBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        var trackId = (currentIndex >= 0 && playlist[currentIndex]) ? playlist[currentIndex].id : null
        if (!trackId) return
        document.dispatchEvent(new CustomEvent('musicplayer:fsadd', { detail: { id: trackId, button: fsAddBtn } }))
      })
    }

    // Touch tap feedback for fullscreen controls.
    // CSS pseudo-classes (:active/:hover) stick on mobile Chromium after touch.
    // Use inline style.opacity for tap feedback — fully under JS control.
    var _tapBtn = null
    var _tapTimer = null
    function _clearTap() {
      if (_tapBtn) {
        _tapBtn.style.opacity = ''
        _tapBtn.style.transform = ''
        _tapBtn = null
      }
      if (_tapTimer) { clearTimeout(_tapTimer); _tapTimer = null }
    }
    var controlsEl = playerEl.querySelector('.music-player-controls')
    if (controlsEl) {
      controlsEl.addEventListener('touchstart', function(e) {
        _clearTap()
        var btn = e.target.closest('.mp-btn')
        if (btn) {
          _tapBtn = btn
          btn.style.opacity = btn.classList.contains('mp-btn-play') ? '0.7' : '0.4'
          if (btn.classList.contains('mp-btn-play')) btn.style.transform = 'scale(0.95)'
        }
      }, { passive: true })
      controlsEl.addEventListener('touchend', function() {
        var btn = _tapBtn
        if (btn) {
          _tapTimer = setTimeout(function() { _clearTap() }, 120)
        }
      }, { passive: true })
      controlsEl.addEventListener('touchcancel', function() {
        _clearTap()
      }, { passive: true })
    }

    // Back gesture / hardware back button collapses fullscreen instead of navigating away
    window.addEventListener('popstate', function(e) {
      if (_isFullscreen) {
        // The history entry we pushed was already popped, so just collapse visually
        window._mpHandledPopstate = true  // signal to music-browse.js to skip this popstate
        _collapseFullscreen(false, true)
      }
    })

    // Listen for viewport crossing the 850px threshold -- auto-collapse if resized to desktop
    _fsMql = window.matchMedia('(max-width: 850px)')
    _fsMql.addEventListener('change', function(e) {
      if (!e.matches && _isFullscreen) {
        _collapseFullscreen(true) // instant, no animation
      }
    })
  }

  function _setFsHeartState(liked) {
    if (!fsHeartBtn) return
    fsHeartBtn.classList.toggle('liked', !!liked)
    fsHeartBtn.title = liked ? 'UNLIKE' : 'LIKE'
    if (liked) {
      fsHeartBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    } else {
      fsHeartBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    }
  }

  function _setBarHeartState(liked) {
    var btn = document.getElementById('mpBarHeart')
    if (!btn) return
    btn.classList.toggle('liked', !!liked)
    btn.title = liked ? 'UNLIKE' : 'LIKE'
    if (liked) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    } else {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    }
  }

  function _expandFullscreen() {
    if (_isFullscreen || !playerEl) return
    _isFullscreen = true
    playerEl.classList.remove('mp-fs-closing')
    playerEl.classList.add('mp-fullscreen')
    document.body.classList.add('mp-fs-open')
    // Store scroll position before locking
    document.body.dataset.mpScrollY = window.scrollY
    document.body.style.top = '-' + window.scrollY + 'px'
    // Push history state so mobile back gesture collapses instead of navigating away
    history.pushState({ mpFullscreen: true }, '')
    // Repaint progress fill with fullscreen colors
    _updateProgressFill()
  }

  function _collapseFullscreen(instant, fromPopstate) {
    if (!_isFullscreen || !playerEl) return
    _isFullscreen = false

    // Pop the history entry we pushed on expand (unless triggered by popstate -- already popped)
    if (!fromPopstate) {
      history.back()
    }

    // Repaint progress fill with default colors
    _updateProgressFill()

    // Close playlist if open
    if (playlistPanel && playlistPanel.classList.contains('mp-playlist-visible')) {
      playlistPanel.classList.remove('mp-playlist-visible')
      if (playlistBtn) playlistBtn.classList.remove('mp-btn-active')
      var fsPlaylistBtn = document.getElementById('mpFsPlaylistBtn')
      if (fsPlaylistBtn) fsPlaylistBtn.classList.remove('mp-btn-active')
    }

    // Close devices panel if open
    if (devicesPanel && devicesPanel.classList.contains('mp-devices-visible')) {
      devicesPanel.classList.remove('mp-devices-visible')
    }

    // Restore scroll
    document.body.classList.remove('mp-fs-open')
    var scrollY = parseInt(document.body.dataset.mpScrollY || '0', 10)
    document.body.style.top = ''
    window.scrollTo(0, scrollY)

    if (instant) {
      playerEl.classList.remove('mp-fullscreen', 'mp-fs-closing')
      return
    }

    playerEl.classList.add('mp-fs-closing')
    var cleaned = false
    function cleanup() {
      if (cleaned) return
      cleaned = true
      playerEl.classList.remove('mp-fullscreen', 'mp-fs-closing')
    }
    playerEl.addEventListener('animationend', function handler(e) {
      if (e.target !== playerEl) return // ignore bubbled events from children
      cleanup()
      playerEl.removeEventListener('animationend', handler)
    }, { once: true })
    // Safety fallback in case animationend never fires
    setTimeout(cleanup, 350)
  }

  function _setTitle(text) {
    if (!titleEl) return
    // Strip file extension for display (keep status suffixes like "(DECRYPTING...)")
    let display = text
    const statusMatch = display.match(/^(.+?)(\s*\([^)]+\))$/)
    let baseName = statusMatch ? statusMatch[1] : display
    const suffix = statusMatch ? statusMatch[2] : ''
    baseName = _stripAudioExtension(baseName)
    display = (baseName + suffix).toUpperCase()
    titleEl.title = text

    // Update artist subtitle (works for music-library tracks and suggested tracks in any context)
    var track = (currentIndex >= 0 && currentIndex < playlist.length) ? playlist[currentIndex] : null
    if (artistEl) {
      if (track && track.artists && track.artists.length > 0) {
        // Render each artist as a separate clickable link
        var artistHtml = track.artists.map(function(a) {
          return '<span class="mp-artist-link" data-artist-id="' + _escMp(a.id) + '">' + _escMp(a.name.toUpperCase()) + '</span>'
        }).join('<span class="mp-artist-sep">, </span>')
        artistEl.innerHTML = artistHtml
        artistEl.style.display = ''
      } else if (track && track.artistName) {
        artistEl.textContent = track.artistName.toUpperCase()
        artistEl.style.display = ''
      } else {
        artistEl.textContent = ''
        artistEl.style.display = 'none'
      }
    }

    // Make title clickable to album when track has album info
    if (titleEl) {
      if (track && track.albumId) {
        titleEl.classList.add('mp-title-clickable')
        titleEl.dataset.albumId = track.albumId
      } else {
        titleEl.classList.remove('mp-title-clickable')
        delete titleEl.dataset.albumId
      }
    }

    // Always use static ellipsis (no marquee scroll) -- consistent across all pages
    const inner = titleInner || titleEl
    inner.textContent = display
    titleEl.classList.remove('mp-title-scrolling')
  }

  function _updatePlayButton() {
    if (!playBtn) return
    if (isPlaying) {
      playBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
      playBtn.title = 'PAUSE'
    } else {
      playBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      playBtn.title = 'PLAY'
    }
    // Sync mini play button icon
    if (miniPlayBtn) {
      if (isPlaying) {
        miniPlayBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
        miniPlayBtn.title = 'PAUSE'
      } else {
        miniPlayBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
        miniPlayBtn.title = 'PLAY'
      }
    }
  }

  function _updateVolumeIcon() {
    if (!volumeBtn) return
    // Use slider position for icon thresholds (perceptual, not curved)
    const s = _volSlider
    if (s === 0) {
      volumeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
    } else if (s < 0.5) {
      volumeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
    } else {
      volumeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
    }
  }

  function _updateRepeatButton() {
    if (!repeatBtn) return
    repeatBtn.classList.remove('mp-btn-active', 'mp-btn-accent')
    if (repeatMode === 'all') {
      repeatBtn.classList.add('mp-btn-active')
      repeatBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>'
      repeatBtn.title = 'REPEAT ALL'
    } else if (repeatMode === 'one') {
      repeatBtn.classList.add('mp-btn-active', 'mp-btn-accent')
      repeatBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="16" text-anchor="middle" fill="currentColor" stroke="none" font-size="8" font-weight="bold">1</text></svg>'
      repeatBtn.title = 'REPEAT ONE'
    } else {
      repeatBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>'
      repeatBtn.title = 'REPEAT OFF'
    }
  }

  function _formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return mins + ':' + (secs < 10 ? '0' : '') + secs
  }

  function _buildSourceUrl(fileId, fileName, isE2E) {
    if (isE2E) return '' // E2E tracks need decryption, no direct URL
    if (_context === 'dashboard' || _context === 'temp') {
      return `/file/${fileId}/preview`
    } else {
      return `/f/${_browseShareToken}/file/${fileId}/${encodeURIComponent(fileName)}`
    }
  }

  // ─── Shuffle ────────────────────────────────────────────────────
  // Start a fresh shuffle at `idx`: move it to the front so every other track
  // still plays once after it (anchoring mid-order would skip the ones before).
  function _anchorShuffleAt(idx) {
    const pos = shuffleOrder.indexOf(idx)
    if (pos > 0) {
      ;[shuffleOrder[0], shuffleOrder[pos]] = [shuffleOrder[pos], shuffleOrder[0]]
    }
    shufflePos = 0
  }

  function _generateShuffleOrder() {
    shuffleOrder = Array.from({ length: playlist.length }, (_, i) => i)
    // Fisher-Yates shuffle
    for (let i = shuffleOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]]
    }
    // Put current track at the beginning
    if (currentIndex >= 0) {
      const pos = shuffleOrder.indexOf(currentIndex)
      if (pos > 0) {
        ;[shuffleOrder[0], shuffleOrder[pos]] = [shuffleOrder[pos], shuffleOrder[0]]
      }
      shufflePos = 0
    }
  }

  // ─── Playlist Panel ─────────────────────────────────────────────
  function _renderPlaylist() {
    if (!playlistPanel) return
    const list = playlistPanel.querySelector('.mp-playlist-list')
    if (!list) return

    if (playlist.length === 0) {
      list.innerHTML = '<div class="mp-playlist-empty">NO AUDIO FILES IN THIS FOLDER</div>'
      return
    }

    let html = ''
    let insertedDivider = false
    for (let i = 0; i < playlist.length; i++) {
      const track = playlist[i]
      const isCurrent = i === currentIndex
      const nameparts = _splitTrackName(track.name)
      // Insert "UP NEXT — SUGGESTED" divider before the first suggested track
      if (!insertedDivider && track.suggested) {
        html += '<div class="mp-playlist-divider"><span>UP NEXT &mdash; SUGGESTED</span></div>'
        insertedDivider = true
      }
      var artistHtml = (track.artistName) ? `<span class="mp-playlist-artist" style="display:block;font-size:9px;color:#555;margin-top:1px">${_escMp(track.artistName)}</span>` : ''
      html += `<div class="mp-playlist-item${isCurrent ? ' mp-playlist-current' : ''}${track.suggested ? ' mp-playlist-suggested' : ''}" data-index="${i}">
        <span class="mp-playlist-num">${i + 1}</span>
        <span class="mp-playlist-name">${_escMp(nameparts.base)}<span class="mp-playlist-ext">${_escMp(nameparts.ext)}</span>${artistHtml}</span>
        ${track.isE2E ? '<span class="mp-playlist-e2e">E2E</span>' : ''}
      </div>`
    }
    list.innerHTML = html

    // Event delegation for playlist clicks (single listener instead of per-item)
    if (!list._mpDelegated) {
      list._mpDelegated = true
      list.addEventListener('click', (e) => {
        const item = e.target.closest('.mp-playlist-item')
        if (!item) return
        const idx = parseInt(item.dataset.index)
        if (!isNaN(idx)) {
          if (shuffleMode) {
            shufflePos = shuffleOrder.indexOf(idx)
            if (shufflePos === -1) shufflePos = 0
          }
          _loadTrack(idx)
        }
      })
    }
  }

  function _highlightPlaylistItem() {
    if (!playlistPanel) return
    playlistPanel.querySelectorAll('.mp-playlist-item').forEach(item => {
      item.classList.toggle('mp-playlist-current', parseInt(item.dataset.index) === currentIndex)
    })
    // Scroll the current track into view within the playlist panel
    var currentEl = playlistPanel.querySelector('.mp-playlist-current')
    if (currentEl) {
      try { currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } catch(e) {}
    }
  }

  function _splitTrackName(name) {
    if (!name || !name.includes('.')) return { base: name || '', ext: '' }
    const lastDot = name.lastIndexOf('.')
    return { base: name.substring(0, lastDot), ext: name.substring(lastDot) }
  }

  function _measureText(text) {
    // Measure text width using a hidden span with same font as title
    const span = document.createElement('span')
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:inherit'
    span.textContent = text
    if (titleEl) titleEl.appendChild(span)
    else document.body.appendChild(span)
    const w = span.offsetWidth
    span.remove()
    return w
  }

  function _escMp(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  }

  // ─── Audio Visualizer ─────────────────────────────────────────
  function _toggleFx() {
    // ── Chaos mode cooldown: swallow all clicks for 3s after activation ──
    const now = Date.now()
    if (_chaosMode && now < _chaosLockedUntil) return

    // ── Easter egg: rapid-click detection for chaos mode ──
    _chaosClickTimes.push(now)
    if (_chaosClickTimes.length > _CHAOS_CLICKS) _chaosClickTimes.shift()
    if (_chaosClickTimes.length === _CHAOS_CLICKS &&
        now - _chaosClickTimes[0] <= _CHAOS_WINDOW) {
      _chaosClickTimes = []
      _toggleChaosMode()
      return  // don't toggle FX on/off during chaos activation
    }

    _fxEnabled = !_fxEnabled
    localStorage.setItem('mp_fx', _fxEnabled ? '1' : '0')
    if (fxBtn) fxBtn.classList.toggle('mp-btn-active', _fxEnabled)

    if (_fxEnabled && isVisible) {
      _startFx()
    } else {
      _stopFx()
    }
  }

  function _ensureAudioContext() {
    if (_audioCtx) return true
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      _analyser = _audioCtx.createAnalyser()
      _analyser.fftSize = 2048
      _analyser.smoothingTimeConstant = 0.6
      _analyser.minDecibels = -85
      _analyser.maxDecibels = -20
      _gainNode = _audioCtx.createGain()
      _gainNode.gain.value = _desiredVolume
      return true
    } catch (e) {
      console.warn('[MUSIC PLAYER] Web Audio not available:', e)
      return false
    }
  }

  /**
   * Resume the AudioContext if it exists and is suspended.
   * Browsers suspend AudioContexts after inactivity or when the tab is
   * backgrounded.  Once createMediaElementSource(audio) has been called,
   * ALL audio output is routed through the AudioContext — if it stays
   * suspended, the user hears nothing even though audio.play() succeeds.
   * Calling resume() when already 'running' is a harmless no-op.
   */
  function _resumeAudioContext() {
    if (_audioCtx && _audioCtx.state === 'suspended') {
      _audioCtx.resume().catch(function(err) {
        console.warn('[MUSIC PLAYER] AudioContext resume failed:', err)
      })
    }
  }

  // ─── iOS Background Audio Keepalive ────────────────────────────
  // iOS Safari aggressively suspends audio when the page is backgrounded.
  // This keepalive periodically tries to resume playback in the background.
  // iOS allows limited JS execution via setInterval for ~30s after
  // backgrounding, and the Media Session play action can also trigger it.
  // The keepalive starts when the page goes hidden (if audio was playing)
  // and stops when the page returns to the foreground.
  function _startIOSBackgroundKeepalive() {
    if (_iosBackgroundRetryTimer) return
    if (!_isIOS) return
    var attempts = 0
    var maxAttempts = 15  // ~30s of retries at 2s intervals
    _iosBackgroundRetryTimer = setInterval(function() {
      attempts++
      if (attempts > maxAttempts || !_wasPlayingBeforeBackground) {
        _stopIOSBackgroundKeepalive()
        return
      }
      if (audio.paused && _wasPlayingBeforeBackground) {
        _resumeAudioContext()
        audio.play().catch(function() {})
      }
    }, 2000)
  }

  function _stopIOSBackgroundKeepalive() {
    if (_iosBackgroundRetryTimer) {
      clearInterval(_iosBackgroundRetryTimer)
      _iosBackgroundRetryTimer = null
    }
  }

  function _connectSource() {
    if (_fxConnected) return
    if (!_ensureAudioContext()) return
    try {
      if (!_sourceNode) {
        _sourceNode = _audioCtx.createMediaElementSource(audio)
        // Once connected, volume is controlled via _gainNode -- keep
        // the element at full volume so the analyser sees full signal.
        audio.volume = 1
      }
      // Route: source -> analyser (full signal) -> gainNode (volume) -> speakers
      _sourceNode.connect(_analyser)
      _analyser.connect(_gainNode)
      _gainNode.connect(_audioCtx.destination)
      _fxConnected = true
      _resumeAudioContext()
    } catch (e) {
      console.warn('[MUSIC PLAYER] Failed to connect audio source:', e)
    }
  }

  function _startFx() {
    _connectSource()
    if (!_fxCanvas || !_fxCtx || !_analyser) return
    if (playerEl) playerEl.classList.add('mp-fx-active')

    // Wait a frame for CSS to apply (canvas needs height from .mp-fx-active)
    requestAnimationFrame(() => {
      _resizeFxCanvas()
      _fxSmoothed = null
      if (!_fxRafId) _fxLoop()
    })
  }

  function _stopFx() {
    if (_chaosMode) _stopChaos()
    if (_fxRafId) {
      cancelAnimationFrame(_fxRafId)
      _fxRafId = null
    }
    if (playerEl) playerEl.classList.remove('mp-fx-active')
    // Clear canvas
    if (_fxCtx && _fxCanvas) {
      _fxCtx.clearRect(0, 0, _fxCanvas.width, _fxCanvas.height)
    }
  }

  function _stopFxLoop() {
    if (_fxRafId) {
      cancelAnimationFrame(_fxRafId)
      _fxRafId = null
    }
  }

  function _resizeFxCanvas() {
    if (!_fxCanvas) return
    const rect = _fxCanvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    _fxCanvas.width = rect.width * dpr
    _fxCanvas.height = rect.height * dpr
    _fxCtx.scale(dpr, dpr)
  }

  // Frequency-dependent gain to balance the visualizer so all bars contribute
  // evenly. Music naturally has ~10-15dB more energy in bass than treble, so we
  // compensate by progressively boosting higher frequencies. This is a gentle
  // tilt, not a full A-weighting curve — the goal is a balanced visual, not
  // scientific accuracy.
  // Returns a gain multiplier for a given center frequency (Hz).
  function _freqGain(freqHz) {
    // Log-based tilt: 0.55 at 30Hz, 1.0 at ~1kHz, 1.6 at 18kHz
    // This counteracts the natural spectral slope of music.
    const logPos = Math.log(freqHz / 30) / Math.log(18000 / 30)  // 0..1
    return 0.55 + logPos * 1.05
  }

  function _fxLoop() {
    if (!_fxEnabled || !_analyser || !_fxCtx || !_fxCanvas) return
    _fxRafId = requestAnimationFrame(_fxLoop)

    const bufLen = _analyser.frequencyBinCount   // 1024 bins (fftSize 2048)
    const data = new Uint8Array(bufLen)
    _analyser.getByteFrequencyData(data)

    const rect = _fxCanvas.getBoundingClientRect()
    const W = rect.width
    const H = rect.height
    _fxCtx.clearRect(0, 0, W, H)

    const barCount = 48
    if (!_fxSmoothed || _fxSmoothed.length !== barCount) {
      _fxSmoothed = new Float32Array(barCount)
    }

    // Derive bin boundaries from actual sample rate for accurate mapping.
    // fftSize=2048 -> 1024 bins. Each bin = sampleRate / fftSize Hz wide.
    const sampleRate = _audioCtx ? _audioCtx.sampleRate : 48000
    const binHz = sampleRate / 2048  // Hz per bin

    // Map bars to frequency range 30 Hz – 18 kHz using exponential (octave-based)
    // scaling. Each bar spans a roughly equal musical interval (~1/5 octave).
    const freqMin = 30
    const freqMax = 18000
    const logMin = Math.log(freqMin)
    const logMax = Math.log(freqMax)

    for (let i = 0; i < barCount; i++) {
      // Exponential frequency boundaries for this bar
      const fLow  = Math.exp(logMin + (logMax - logMin) * (i / barCount))
      const fHigh = Math.exp(logMin + (logMax - logMin) * ((i + 1) / barCount))
      const fCenter = (fLow + fHigh) / 2

      // Convert frequencies to bin indices
      const binLow  = Math.max(1, Math.floor(fLow / binHz))
      const binHigh = Math.min(bufLen - 1, Math.ceil(fHigh / binHz))

      // Average the FFT bins for this bar (use peak for single-bin bars)
      let sum = 0
      let count = 0
      for (let b = binLow; b <= binHigh; b++) {
        sum += data[b]
        count++
      }
      const rawLinear = count > 0 ? sum / count / 255 : 0

      // Apply frequency-dependent gain to balance bass vs treble visually
      // In chaos mode: flatter bass gain so low-end has more dynamic range
      const gain = _chaosMode
        ? (0.85 + (_freqGain(fCenter) - 0.55) * 0.7)  // 0.85 at 30Hz, ~1.3 at 18kHz
        : _freqGain(fCenter)
      // Gentle edge taper on the first 4 bars so the left side doesn't start abruptly
      const edgeTaper = i < 4 ? 0.4 + 0.6 * (i / 4) : 1
      const weighted = rawLinear * gain * edgeTaper

      // No volume scaling — the analyser receives full-strength signal
      // (volume is applied after the analyser via GainNode), so the
      // visualizer reacts identically at any volume level.

      // Noise floor: cut off very low values to prevent jitter on silence
      const noiseFloor = 0.008
      const cleaned = weighted < noiseFloor ? 0 : weighted

      // Compression: chaos mode uses lighter compression to preserve bass dynamics
      const compPow = _chaosMode ? 0.92 : 0.85
      const compressed = cleaned > 0 ? Math.pow(cleaned, compPow) : 0
      const clamped = Math.min(1.0, compressed)

      // Asymmetric smoothing: chaos mode has snappier attack for punchier bass
      const prev = _fxSmoothed[i]
      const attack = _chaosMode ? 0.6 : 0.45
      const decay  = _chaosMode ? 0.15 : 0.12
      _fxSmoothed[i] = clamped > prev
        ? prev + (clamped - prev) * attack
        : prev + (clamped - prev) * decay
    }

    // Draw bars with gradient and glow
    // In chaos mode the canvas is very tall; keep bars short at the bottom
    const barMaxH = _chaosMode ? Math.min(180, H * 0.22) : H * 0.98
    const barMinH = _chaosMode ? Math.min(4, H * 0.005) : H * 0.12
    const gap = 1.5
    const barW = (W - gap * (barCount - 1)) / barCount
    for (let i = 0; i < barCount; i++) {
      const val = _fxSmoothed[i]
      const barH = val > 0 ? Math.max(barMinH, val * barMaxH) : 2
      const x = i * (barW + gap)
      const y = H - barH

      // Color: deep red to hot pink/white based on frequency position + intensity
      const freq = i / barCount
      const r = Math.round(222 + (255 - 222) * freq * val)
      const g = Math.round(24 + (80 - 24) * val * val)
      const b = Math.round(51 + (180 - 51) * freq)
      const alpha = 0.55 + val * 0.45

      // Subtle glow on hot bars (skip in chaos mode for perf)
      if (!_chaosMode && val > 0.5) {
        _fxCtx.shadowColor = `rgba(${r}, ${g}, ${b}, ${(val - 0.5) * 0.6})`
        _fxCtx.shadowBlur = 6
      }

      // Gradient from bottom (bright) to top (dimmer)
      const grad = _fxCtx.createLinearGradient(x, H, x, y)
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`)
      grad.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${alpha * 0.7})`)
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${alpha * 0.3})`)
      _fxCtx.fillStyle = grad

      // Flat-top bar
      _fxCtx.fillRect(x, y, barW, barH)

      _fxCtx.shadowBlur = 0
    }

    // ── Chaos mode overlay (drawn on top of bars) ──
    if (_chaosMode) _renderChaos(W, H, data, bufLen)
  }

  // ─── Chaos Mode (Easter Egg) ──────────────────────────────────

  function _toggleChaosMode() {
    _chaosMode = !_chaosMode
    if (_chaosMode) {
      // Lock out clicks for 3s so the user doesn't accidentally toggle it off
      _chaosLockedUntil = Date.now() + 3000
      // Force FX on if it wasn't already
      if (!_fxEnabled) {
        _fxEnabled = true
        localStorage.setItem('mp_fx', '1')
        if (fxBtn) fxBtn.classList.add('mp-btn-active')
        if (isVisible) _startFx()
      }
      if (playerEl) playerEl.classList.add('mp-fx-chaos')
      _chaosParticles = []
      _chaosRings = []
      _chaosArcs = []
      _chaosHue = 0
      _chaosPrevBass = 0
      _chaosShakeX = 0
      _chaosShakeY = 0
      _chaosFlash = 1.0  // trigger activation flash
      // Resize canvas after CSS transition for new height
      setTimeout(() => { _resizeFxCanvas() }, 350)
      // Button celebration wiggle
      if (fxBtn) {
        fxBtn.classList.add('mp-btn-chaos-wiggle')
        setTimeout(() => { fxBtn.classList.remove('mp-btn-chaos-wiggle') }, 600)
      }
    } else {
      if (playerEl) playerEl.classList.remove('mp-fx-chaos')
      _chaosParticles = []
      _chaosRings = []
      _chaosArcs = []
      _chaosFlash = 0
      setTimeout(() => { _resizeFxCanvas() }, 350)
    }
  }

  function _stopChaos() {
    _chaosMode = false
    _chaosParticles = []
    _chaosRings = []
    _chaosArcs = []
    _chaosFlash = 0
    if (playerEl) playerEl.classList.remove('mp-fx-chaos')
  }

  // HSL helper: convert hue (0-360), sat (0-100), light (0-100), alpha (0-1) to CSS
  function _hsla(h, s, l, a) {
    return 'hsla(' + (h % 360) + ',' + s + '%,' + l + '%,' + a + ')'
  }

  function _renderChaos(W, H, freqData, bufLen) {
    const ctx = _fxCtx
    const sampleRate = _audioCtx ? _audioCtx.sampleRate : 48000
    const binHz = sampleRate / 2048

    // ── Extract energy bands ──
    // Bass: 30-150 Hz
    const bassLow = Math.max(1, Math.floor(30 / binHz))
    const bassHigh = Math.min(bufLen - 1, Math.ceil(150 / binHz))
    let bassSum = 0
    for (let b = bassLow; b <= bassHigh; b++) bassSum += freqData[b]
    const bass = bassSum / ((bassHigh - bassLow + 1) * 255)

    // Mid: 400-4000 Hz
    const midLow = Math.floor(400 / binHz)
    const midHigh = Math.min(bufLen - 1, Math.ceil(4000 / binHz))
    let midSum = 0
    for (let b = midLow; b <= midHigh; b++) midSum += freqData[b]
    const mid = midSum / ((midHigh - midLow + 1) * 255)

    // Treble: 6000-18000 Hz
    const trebLow = Math.floor(6000 / binHz)
    const trebHigh = Math.min(bufLen - 1, Math.ceil(18000 / binHz))
    let trebSum = 0
    for (let b = trebLow; b <= trebHigh; b++) trebSum += freqData[b]
    const treble = trebSum / ((trebHigh - trebLow + 1) * 255)

    // Overall energy
    const energy = bass * 0.5 + mid * 0.3 + treble * 0.2

    // Bass transient detection
    const bassDelta = bass - _chaosPrevBass
    const isBassHit = bassDelta > 0.12 && bass > 0.3
    const isHardBassHit = bassDelta > 0.2 && bass > 0.5
    _chaosPrevBass = bass

    // ── Hue rotation ──
    _chaosHue += 0.3 + energy * 2
    if (isBassHit) _chaosHue += 30 + Math.random() * 30

    // ── Screen shake ──
    if (isHardBassHit) {
      _chaosShakeX = (Math.random() - 0.5) * 8
      _chaosShakeY = (Math.random() - 0.5) * 6
    }
    _chaosShakeX *= 0.8
    _chaosShakeY *= 0.8
    if (Math.abs(_chaosShakeX) < 0.2) _chaosShakeX = 0
    if (Math.abs(_chaosShakeY) < 0.2) _chaosShakeY = 0

    ctx.save()
    ctx.translate(_chaosShakeX, _chaosShakeY)

    // ── Activation flash ──
    if (_chaosFlash > 0) {
      ctx.fillStyle = 'rgba(222,24,51,' + (_chaosFlash * 0.4) + ')'
      ctx.fillRect(-5, -5, W + 10, H + 10)
      _chaosFlash *= 0.92
      if (_chaosFlash < 0.01) _chaosFlash = 0
    }

    // ── Ambient glow (bass-reactive aura, radiates upward from bottom) ──
    if (bass > 0.2) {
      // Glow centered at bottom, reaching up ~60% of canvas height
      const glowReach = H * 0.6
      const glowGrad = ctx.createRadialGradient(W / 2, H, 0, W / 2, H - glowReach, glowReach)
      glowGrad.addColorStop(0, _hsla(_chaosHue, 80, 30, bass * 0.3))
      glowGrad.addColorStop(0.5, _hsla(_chaosHue + 40, 70, 20, bass * 0.1))
      glowGrad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = glowGrad
      ctx.fillRect(0, H * 0.3, W, H * 0.7)
    }

    // ── Spawn particles from bar tops ──
    const barCount = 48
    const gap = 1.5
    const barW = (W - gap * (barCount - 1)) / barCount
    const spawnRate = isBassHit ? 14 : (2 + energy * 6)
    // Use the same bar height cap as the drawn bars so particles spawn from the visible tops
    const chaosBarMax = _chaosMode ? Math.min(180, H * 0.22) : H * 0.98
    const pCap = 350

    for (let s = 0; s < spawnRate; s++) {
      if (_chaosParticles.length >= pCap) break
      const barIdx = Math.floor(Math.random() * barCount)
      const barVal = _fxSmoothed ? _fxSmoothed[barIdx] || 0 : 0
      if (barVal < 0.05) continue
      const barX = barIdx * (barW + gap) + barW / 2
      const barH = barVal * chaosBarMax
      const barY = H - barH

      const speed = 1.5 + barVal * 5 + (isBassHit ? 4 : 0)
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.9
      const freq = barIdx / barCount
      const hue = _chaosHue + freq * 120

      _chaosParticles.push({
        x: barX + (Math.random() - 0.5) * barW,
        y: barY,
        vx: Math.cos(angle) * speed * (0.8 + Math.random() * 0.4),
        vy: Math.sin(angle) * speed * (0.8 + Math.random() * 0.4),
        life: 1.0,
        decay: 0.005 + Math.random() * 0.008,
        size: 1.5 + barVal * 3 + Math.random() * 2,
        hue: hue,
        sat: 70 + Math.random() * 30,
        glow: barVal > 0.6
      })
    }

    // ── Bass burst: explosive center particle spray on hard hits ──
    if (isHardBassHit) {
      const burstCount = 20 + Math.floor(bass * 30)
      for (let b = 0; b < burstCount; b++) {
        if (_chaosParticles.length >= pCap) break
        const angle = -Math.PI * Math.random()
        const speed = 3 + Math.random() * 7 * bass
        _chaosParticles.push({
          x: W / 2 + (Math.random() - 0.5) * W * 0.4,
          y: H - chaosBarMax * 0.5 + (Math.random() - 0.5) * chaosBarMax,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 2,
          life: 1.0,
          decay: 0.007 + Math.random() * 0.008,
          size: 2 + Math.random() * 4,
          hue: _chaosHue + Math.random() * 60 - 30,
          sat: 80 + Math.random() * 20,
          glow: true
        })
      }
    }

    // ── Update & render particles (perf: no shadowBlur, swap-and-pop removal) ──
    let pLen = _chaosParticles.length
    let writeIdx = 0
    for (let i = 0; i < pLen; i++) {
      const p = _chaosParticles[i]
      p.vy -= 0.04 + bass * 0.12
      p.vy += 0.015
      p.vx *= 0.997
      p.vy *= 0.997
      p.x += p.vx
      p.y += p.vy
      p.life -= p.decay

      if (p.life <= 0 || p.y > H + 20 || p.x < -40 || p.x > W + 40) continue

      // Keep particle (compact array in-place)
      _chaosParticles[writeIdx++] = p

      const yRatio = p.y / H
      const vertFade = yRatio > 0.15 ? 1.0 : (yRatio / 0.15)
      const alpha = p.life * (0.6 + energy * 0.4) * vertFade
      if (alpha < 0.01) continue

      const radius = p.size * p.life

      // Cheap glow: larger dim circle behind (no shadowBlur needed)
      if (p.glow && alpha > 0.1) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, radius * 2.5, 0, Math.PI * 2)
        ctx.fillStyle = _hsla(p.hue, p.sat, 50, alpha * 0.15)
        ctx.fill()
      }

      // Main particle
      ctx.beginPath()
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
      ctx.fillStyle = _hsla(p.hue, p.sat, 50 + p.life * 30, alpha)
      ctx.fill()

      // Bright core on large particles
      if (p.size > 3.5) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, radius * 0.3, 0, Math.PI * 2)
        ctx.fillStyle = _hsla(p.hue, 30, 90, alpha * 0.7)
        ctx.fill()
      }
    }
    _chaosParticles.length = writeIdx

    // ── Treble sparkles (tiny bright dots scattered across canvas) ──
    if (treble > 0.15) {
      const sparkleCount = Math.floor(treble * 20)
      for (let s = 0; s < sparkleCount; s++) {
        const sx = Math.random() * W
        const sy = H * 0.1 + Math.random() * H * 0.7
        const yFade = sy / H < 0.3 ? (sy / H / 0.3) : 1.0
        const sAlpha = treble * (0.3 + Math.random() * 0.5) * yFade
        const sSize = 0.5 + Math.random() * 1.5
        ctx.beginPath()
        ctx.arc(sx, sy, sSize, 0, Math.PI * 2)
        ctx.fillStyle = _hsla(_chaosHue + 60 + Math.random() * 60, 50, 85, sAlpha)
        ctx.fill()
      }
    }


    // ── Vignette glow on edges (bass-reactive, full height) ──
    if (bass > 0.15) {
      const vigAlpha = bass * 0.15
      // Left edge
      const vigL = ctx.createLinearGradient(0, 0, W * 0.12, 0)
      vigL.addColorStop(0, _hsla(_chaosHue, 80, 40, vigAlpha))
      vigL.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = vigL
      ctx.fillRect(0, 0, W * 0.12, H)
      // Right edge
      const vigR = ctx.createLinearGradient(W, 0, W * 0.88, 0)
      vigR.addColorStop(0, _hsla(_chaosHue + 180, 80, 40, vigAlpha))
      vigR.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = vigR
      ctx.fillRect(W * 0.88, 0, W * 0.12, H)
    }

    ctx.restore()
  }

  // ─── Cross-page playback persistence ────────────────────────────

  /**
   * Save player state to sessionStorage so playback can resume after
   * a full page navigation.  Only music-library and non-E2E dashboard
   * tracks are saveable (E2E tracks need in-memory decryption keys).
   */
  function _saveState() {
    if (!isVisible || currentIndex < 0 || playlist.length === 0) {
      sessionStorage.removeItem('mp_state')
      return
    }
    // Don't persist phantom mode state (it's remote, not local)
    if (_syncPhantomMode) {
      sessionStorage.removeItem('mp_state')
      return
    }
    // Don't persist E2E playlists (can't restore without keys)
    var hasE2E = playlist.some(function(t) { return t.isE2E })
    if (hasE2E) {
      sessionStorage.removeItem('mp_state')
      return
    }
    try {
      var state = {
        context: _context,
        browseShareToken: _browseShareToken,
        playlist: playlist.map(function(t) {
          return {
            id: t.id,
            name: t.name,
            extension: t.extension || 'opus',
            isE2E: false,
            sourceUrl: t.sourceUrl,
            coverPath: t.coverPath || null,
            artistName: t.artistName || '',
            artistIds: t.artistIds || [],
            artists: t.artists || [],
            albumId: t.albumId || null,
            suggested: t.suggested || false,
          }
        }),
        suggestedStartIndex: _suggestedStartIndex,
        currentIndex: currentIndex,
        currentTime: audio.currentTime || 0,
        isPlaying: isPlaying,
        shuffleMode: shuffleMode,
        repeatMode: repeatMode,
        shuffleOrder: shuffleOrder,
        shufflePos: shufflePos,
        ts: Date.now(),
      }
      sessionStorage.setItem('mp_state', JSON.stringify(state))
    } catch(e) {
      // sessionStorage full or disabled — ignore
    }
  }

  /**
   * Attempt to restore player state from sessionStorage.
   * Called at the end of init().  If state is found and valid,
   * the player re-appears with the saved playlist and resumes playback.
   */
  function _restoreState() {
    var raw = sessionStorage.getItem('mp_state')
    if (!raw) return false
    sessionStorage.removeItem('mp_state')
    try {
      var state = JSON.parse(raw)
      var requestedContext = _context || 'dashboard'
      var requestedBrowseShareToken = _browseShareToken || ''
      // Discard stale state (>4 hours old)
      if (Date.now() - state.ts > 4 * 60 * 60 * 1000) return false
      if (!state.playlist || !state.playlist.length) return false
      if ((state.context || 'dashboard') !== requestedContext) return false
      if (requestedContext === 'browse' && (state.browseShareToken || '') !== requestedBrowseShareToken) return false

      _context = state.context || 'dashboard'
      _browseShareToken = state.browseShareToken || ''
      playlist = state.playlist.map(function(t) {
        return {
          id: t.id,
          name: t.name,
          extension: t.extension || 'opus',
          isE2E: false,
          sourceUrl: t.sourceUrl,
          blobUrl: null,
          coverPath: t.coverPath || null,
          artistName: t.artistName || '',
          artistIds: t.artistIds || [],
          artists: t.artists || [],
          albumId: t.albumId || null,
          suggested: t.suggested || false,
        }
      })
      _suggestedStartIndex = (typeof state.suggestedStartIndex === 'number' ? state.suggestedStartIndex : -1)
      shuffleMode = !!state.shuffleMode
      repeatMode = state.repeatMode || 'none'
      shuffleOrder = state.shuffleOrder || []
      shufflePos = (typeof state.shufflePos === 'number' ? state.shufflePos : -1)

      // Update shuffle/repeat UI
      if (shuffleBtn) shuffleBtn.classList.toggle('mp-btn-active', shuffleMode)
      _updateRepeatButton()

      // Show the player
      _showPlayer()

      // Load the track and seek to saved position
      currentIndex = -1  // reset so _loadTrack runs
      var idx = state.currentIndex
      if (idx < 0 || idx >= playlist.length) idx = 0
      var savedTime = state.currentTime || 0
      var shouldPlay = state.isPlaying

      currentIndex = idx
      var track = playlist[idx]
      _setTitle(track.name)
      _updatePlayButton()
      _highlightPlaylistItem()
      _renderPlaylist()

      // Update player art for music library or suggested tracks
      if (_context === 'music-library' || track.suggested) {
        _updatePlayerArt(track)
      }

      // Update Media Session (lock screen / notification controls)
      _updateMediaSession(track)

      // Fire track change event
      try {
        document.dispatchEvent(new CustomEvent('musicplayer:trackchange', { detail: { id: track.id, name: track.name } }))
      } catch(e) {}

      // Set up the audio source and seek
      _resumeAudioContext()
      audio.src = track.sourceUrl
      var onCanPlay = function() {
        audio.removeEventListener('canplay', onCanPlay)
        if (savedTime > 0 && !isNaN(audio.duration) && savedTime < audio.duration) {
          audio.currentTime = savedTime
        }
        if (shouldPlay) {
          _resumeAudioContext()
          audio.play().catch(function(err) {
            console.warn('[MUSIC PLAYER] Auto-resume blocked:', err.message)
          })
        }
      }
      audio.addEventListener('canplay', onCanPlay)
      // Also handle the case where canplay fires before we attach the listener
      if (audio.readyState >= 3) {
        audio.removeEventListener('canplay', onCanPlay)
        if (savedTime > 0) audio.currentTime = savedTime
        if (shouldPlay) {
          _resumeAudioContext()
          audio.play().catch(function() {})
        }
      }

      return true
    } catch(e) {
      console.warn('[MUSIC PLAYER] Failed to restore state:', e)
      return false
    }
  }

  // Save state before page unload (navigation away)
  window.addEventListener('beforeunload', _saveState)

  // Also save on visibility change (tab close, mobile switch)
  // On iOS, this is also where we handle background audio suspension and
  // foreground resume — iOS Safari aggressively suspends audio when the
  // page is backgrounded and the AudioContext + audio element need to be
  // explicitly resumed when the page returns to the foreground.
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') {
      if (isVisible) _saveState()

      // ── Track whether audio was playing when backgrounded ──
      // Used to auto-resume on foreground return.
      if (isPlaying && !_syncPhantomMode) {
        _wasPlayingBeforeBackground = true
        // On iOS, try to keep audio alive by re-calling play().
        // iOS Safari sometimes allows a brief play() call from the
        // visibilitychange handler (it's technically still in the
        // foreground when 'hidden' fires).
        if (_isIOS) {
          _resumeAudioContext()
          audio.play().catch(function() {})
          // Start periodic keepalive retries for iOS background
          _startIOSBackgroundKeepalive()
        }
      }
    } else if (document.visibilityState === 'visible') {
      // ── Foreground resume ──
      _stopIOSBackgroundKeepalive()
      if (_wasPlayingBeforeBackground && !_syncPhantomMode) {
        _wasPlayingBeforeBackground = false
        _resumeAudioContext()
        // iOS may have suspended the audio element — re-trigger play.
        // If the audio source was released, re-set it.
        if (audio.paused) {
          audio.play().then(function() {
            console.log('[MUSIC PLAYER] Foreground resume: play OK')
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
          }).catch(function(err) {
            console.warn('[MUSIC PLAYER] Foreground resume failed, retrying with src reset:', err.message)
            // Last resort: re-set the source and retry.  iOS sometimes
            // releases the audio resource after prolonged backgrounding.
            var track = playlist[currentIndex]
            if (track) {
              var savedTime = audio.currentTime || 0
              var src = track.blobUrl || _currentBlobUrl || track.sourceUrl
              if (src) {
                audio.src = src
                audio.currentTime = savedTime
                audio.play().then(function() {
                  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
                }).catch(function() {})
              }
            }
          })
        } else {
          // Audio was not paused (sometimes iOS resumes automatically)
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
        }
        _updateMediaSessionPositionState()
      }
    }
  })

  // ─── Music Library Navigation (clickable title/artist) ──────────

  function _navigateMusic(type, id) {
    if (!type || !id) return
    var onMusicPage = !!document.querySelector('.music-app')
    if (onMusicPage) {
      // Dispatch event for music-browse.js to handle
      try {
        document.dispatchEvent(new CustomEvent('musicplayer:navigate', {
          detail: { type: type, id: id }
        }))
      } catch(e) {}
    } else {
      // Navigate to the music page with hash for deep-link
      window.location.href = '/music#' + type + ':' + id
    }
  }

  // ─── Autoplay Toggle ────────────────────────────────────────────

  function _toggleAutoplay() {
    _autoplayEnabled = !_autoplayEnabled
    localStorage.setItem('mp_autoplay', _autoplayEnabled ? '1' : '0')
    if (autoplayBtn) {
      autoplayBtn.classList.toggle('mp-btn-active', _autoplayEnabled)
      autoplayBtn.title = _autoplayEnabled ? 'AUTOPLAY ON' : 'AUTOPLAY OFF'
    }
  }

  // ─── Auto-queue suggested songs (music-library only) ───────────

  var _autoQueueLoading = false
  var _autoQueuePromise = null       // in-flight promise so callers can piggyback
  var _suggestApiUnavailable = false  // set true on 401/403 to avoid repeated failed calls

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
    if (_autoQueueLoading && _autoQueuePromise) return _autoQueuePromise
    if (_suggestApiUnavailable) return Promise.resolve(false)
    _autoQueueLoading = true

    var basePlaylist = playlist  // replaced (not mutated) when another playlist opens
    // Build exclude list from current playlist (avoid repeats)
    var excludeIds = playlist.map(function(t) { return t.id })

    // Extract unique seed artist IDs from the current playlist
    var seedArtistSet = {}
    playlist.forEach(function(t) {
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

    _autoQueuePromise = fetch(url, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
    .then(function(r) {
      if (r.status === 401 || r.status === 403) {
        // Music library unavailable (not logged in or disabled) -- stop retrying
        _suggestApiUnavailable = true
        _autoQueueLoading = false
        _autoQueuePromise = null
        return null
      }
      return r.json()
    })
    .then(function(data) {
      if (!data) return false  // API was unavailable
      _autoQueueLoading = false
      _autoQueuePromise = null
      if (playlist !== basePlaylist) return false  // a different playlist is playing now
      if (!data.songs || !data.songs.length) return false

      // Mark the boundary where suggestions begin
      if (_suggestedStartIndex < 0) {
        _suggestedStartIndex = playlist.length
      }

      var newTracks = data.songs.map(function(t) {
        return {
          id: t.id,
          name: (t.title || 'UNKNOWN').toUpperCase(),
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
      playlist = playlist.concat(newTracks)

      // Cap playlist at 200 tracks -- trim already-played tracks from the front
      if (playlist.length > 200 && currentIndex > 20) {
        var trimCount = currentIndex - 5  // keep 5 tracks before current for "previous"
        if (trimCount > 0) {
          playlist = playlist.slice(trimCount)
          currentIndex -= trimCount
          if (_suggestedStartIndex >= 0) _suggestedStartIndex = Math.max(0, _suggestedStartIndex - trimCount)
        }
      }

      if (shuffleMode) _generateShuffleOrder()
      _renderPlaylist()
      return true
    })
    .catch(function() {
      _autoQueueLoading = false
      _autoQueuePromise = null
      return false
    })

    return _autoQueuePromise
  }

  // ─── Crossfade (autoplay transitions only) ────────────────────

  function _startCrossfade() {
    if (_crossfadeActive || _crossfadeTriggered) return
    _crossfadeTriggered = true
    _crossfadeActive = true
    _crossfadeProgress = 0

    // Determine which track to crossfade into
    var nextIdx
    if (shuffleMode) {
      var nextShufflePos = shufflePos + 1
      if (nextShufflePos >= shuffleOrder.length) return _cancelCrossfade()
      nextIdx = shuffleOrder[nextShufflePos]
    } else {
      nextIdx = currentIndex + 1
      if (nextIdx >= playlist.length) return _cancelCrossfade()
    }

    var nextTrack = playlist[nextIdx]
    if (!nextTrack || !nextTrack.sourceUrl) return _cancelCrossfade()

    // Create a second audio element for the incoming track
    _crossfadeAudio = new Audio()
    _crossfadeAudio.preload = 'auto'
    _crossfadeAudio.volume = 0
    _crossfadeAudio.src = nextTrack.sourceUrl

    // Connect crossfade audio to AudioContext if visualizer is active
    // (skip for now -- visualizer stays on main audio)

    _resumeAudioContext()
    _crossfadeAudio.play().catch(function() {
      _cancelCrossfade()
    })

    // Animate the crossfade over ~5 seconds (50 steps, 100ms each)
    var steps = 50
    var step = 0
    _crossfadeTimer = setInterval(function() {
      step++
      var progress = step / steps
      _crossfadeProgress = progress
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

    if (!_crossfadeAudio) {
      _crossfadeActive = false
      return
    }

    // Advance to the next track index
    if (shuffleMode) {
      shufflePos++
      if (shufflePos < shuffleOrder.length) {
        currentIndex = shuffleOrder[shufflePos]
      }
    } else {
      currentIndex = currentIndex + 1
    }

    // Swap: take over from crossfade audio
    audio.pause()
    audio.src = _crossfadeAudio.src
    audio.currentTime = _crossfadeAudio.currentTime
    _crossfadeProgress = 1
    _applyOutputVolume(_desiredVolume)

    // Play the main audio from where the crossfade audio is
    _resumeAudioContext()
    audio.play().catch(function(err) {
      console.warn('[MUSIC PLAYER] Crossfade finalize play failed:', err.message)
      // Fallback: try loading the track cleanly
      var track = playlist[currentIndex]
      if (track) {
        audio.src = track.sourceUrl
        audio.play().catch(function() {})
      }
    })

    // Clean up crossfade audio
    _crossfadeAudio.pause()
    _crossfadeAudio.src = ''
    _crossfadeAudio = null
    _crossfadeActive = false
    _crossfadeProgress = 0

    // Update UI for the new track
    var track = playlist[currentIndex]
    if (track) {
      _setTitle(track.name)
      _updatePlayButton()
      _highlightPlaylistItem()
      if (_context === 'music-library' || track.suggested) _updatePlayerArt(track)
      _updateMediaSession(track)
      try {
        document.dispatchEvent(new CustomEvent('musicplayer:trackchange', { detail: { id: track.id, name: track.name } }))
      } catch(e) {}
    }

    // Reset crossfade trigger for next boundary
    _crossfadeTriggered = false
  }

  function _cancelCrossfade() {
    if (_crossfadeTimer) {
      clearInterval(_crossfadeTimer)
      _crossfadeTimer = null
    }
    if (_crossfadeAudio) {
      _crossfadeAudio.pause()
      _crossfadeAudio.src = ''
      _crossfadeAudio = null
    }
    _crossfadeActive = false
    _crossfadeProgress = 0
    _applyOutputVolume(_desiredVolume)
  }

  // Re-trigger FX canvas measurement when window resizes
  window.addEventListener('resize', () => {
    if (_fxEnabled && _fxCanvas) _resizeFxCanvas()
  })

  // ─── Cross-Device Sync Engine ─────────────────────────────────

  function _initSyncDeviceId() {
    if (!_syncDeviceId) {
      _syncDeviceId = crypto.randomUUID ? crypto.randomUUID() : ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
      }))
      localStorage.setItem('mp_device_id', _syncDeviceId)
    }
    if (!_syncDeviceName) {
      _syncDeviceName = _detectDeviceName()
      localStorage.setItem('mp_device_name', _syncDeviceName)
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

  function _syncStart() {
    if (_syncInterval) return  // already running
    if (!_syncLoggedIn || !_syncEnabled) return
    // Poll immediately, then at the current interval
    _syncPoll()
    var ms = _syncFastMode ? 1000 : 3000
    _syncInterval = setInterval(_syncPoll, ms)
  }

  function _syncStop() {
    if (_syncInterval) {
      clearInterval(_syncInterval)
      _syncInterval = null
    }
    _syncFastMode = false
    _syncStopKeepAlive()
  }

  // Switch between fast (1s) and slow (3s) polling based on multi-device activity
  function _syncAdjustInterval() {
    var shouldFast = _syncDevices.length > 1 || _syncPhantomMode
    if (shouldFast === _syncFastMode) return  // no change
    _syncFastMode = shouldFast
    // Restart the interval with the new rate
    if (_syncInterval) {
      clearInterval(_syncInterval)
      var ms = _syncFastMode ? 1000 : 3000
      _syncInterval = setInterval(_syncPoll, ms)
    }
  }

  // Silent audio keepalive — plays a tiny silent buffer every 25s to prevent
  // the browser from revoking autoplay permission when the active device is
  // paused.  Without this, remote play/play_tracks commands fail because
  // audio.play() is blocked by autoplay policy when there is no recent user
  // gesture and no recent audio output.
  function _syncStartKeepAlive() {
    if (_syncKeepAliveTimer) return  // already running
    function ping() {
      if (!_ensureAudioContext()) return
      if (_audioCtx.state === 'suspended') {
        _audioCtx.resume().catch(function() {})
      }
      try {
        // Create a silent oscillator (gain = 0) for a brief moment
        var osc = _audioCtx.createOscillator()
        var silent = _audioCtx.createGain()
        silent.gain.value = 0
        osc.connect(silent)
        silent.connect(_audioCtx.destination)
        osc.start()
        osc.stop(_audioCtx.currentTime + 0.05)  // 50ms silent blip
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
    if (!_syncLoggedIn || !_syncEnabled || !_syncDeviceId) return

    if (_syncResultAckPending) _syncAcknowledgeCommandResult()

    // If this device is actively playing music-library content, push state
    if (_syncIsActive && _context === 'music-library' && isPlaying) {
      _syncStopKeepAlive()  // not needed while actively playing
      _syncPushState()
      return
    }
    // If this device is active but paused, still push (so other devices see paused state)
    if (_syncIsActive && _context === 'music-library' && isVisible && currentIndex >= 0) {
      _syncStartKeepAlive()  // keep audio context warm so remote commands can play
      _syncPushState()
      return
    }

    // Otherwise, poll for remote state
    fetch('/music/api/sync?device_id=' + encodeURIComponent(_syncDeviceId) + '&device_name=' + encodeURIComponent(_syncDeviceName), {
      credentials: 'same-origin',
    }).then(function(r) { return r.json() }).then(function(data) {
      _syncLastPollData = data
      _syncDevices = data.devices || []

      // Check if we were requested to transfer to ourselves
      if (data.transfer_to === _syncDeviceId) {
        _syncAcceptTransfer(data)
        return
      }

      // If there is an active session on ANOTHER device
      if (data.active && data.active_device_id && data.active_device_id !== _syncDeviceId && data.state) {
        _syncEnterPhantom(data)
      } else if (_syncPhantomMode) {
        // Remote device stopped updating — check if we should pause phantom or exit
        if (data.state_updated_at && !_syncPhantomStale) {
          // State existed but server says it's stale (>10s no update) — pause phantom
          _syncPausePhantom()
        } else if (!data.state_updated_at) {
          // No state at all — exit phantom entirely
          _syncExitPhantom()
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

      // Update devices button indicator and adjust polling speed
      _syncUpdateDevicesButton()
      _syncAdjustInterval()
    }).catch(function() {
      // Network error — ignore silently
    })
  }

  function _syncPushState() {
    if (_syncPushPending) return
    _syncPushPending = true

    var statePayload = {
      playlist: playlist.map(function(t) {
        return {
          id: t.id, name: t.name, extension: t.extension || 'opus',
          sourceUrl: t.sourceUrl, coverPath: t.coverPath || null,
          artistName: t.artistName || '', artistIds: t.artistIds || [],
          artists: t.artists || [], albumId: t.albumId || null,
          suggested: t.suggested || false,
        }
      }),
      currentIndex: currentIndex,
      currentTime: audio.currentTime || 0,
      duration: (!isNaN(audio.duration) && isFinite(audio.duration)) ? audio.duration : 0,
      isPlaying: isPlaying,
      shuffleMode: shuffleMode,
      repeatMode: repeatMode,
      shuffleOrder: shuffleOrder,
      shufflePos: shufflePos,
      suggestedStartIndex: _suggestedStartIndex,
    }

    var pushBody = {
      device_id: _syncDeviceId,
      device_name: _syncDeviceName,
      state: statePayload,
    }
    if (_syncForceActive) {
      pushBody.force_active = true
      _syncForceActive = false
    }
    var sentCommandResult = _syncCommandResult
    if (sentCommandResult) pushBody.command_result = sentCommandResult

    fetch('/music/api/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify(pushBody),
    }).then(function(r) { return r.json() }).then(function(data) {
      _syncPushPending = false

      if (sentCommandResult && data.command_result_acknowledged === sentCommandResult.command_id && _syncCommandResult === sentCommandResult) {
        _syncCommandResult = null
      }

      // Update devices list from POST response
      if (data.devices) {
        _syncDevices = data.devices
        _syncUpdateDevicesButton()
        _syncAdjustInterval()
      }

      // Server rejected us as active — another device holds the active slot
      if (data.is_active === false && data.active_device_id && data.active_device_id !== _syncDeviceId) {
        _syncIsActive = false
        _syncStopKeepAlive()
        audio.pause()
        if (data.state) {
          _syncEnterPhantom(data)
        }
        console.log('[MUSIC PLAYER] Server rejected active claim, entering phantom mode')
        return
      }

      // Handle transfer request
      if (data.transfer_to && data.transfer_to !== _syncDeviceId) {
        _syncYieldToDevice(data.transfer_to)
      }

      // Handle pending remote command
      if (data.pending_command) {
        _syncExecuteCommand(data.pending_command)
      }
    }).catch(function() {
      _syncPushPending = false
    })
  }

  function _syncExecuteCommand(cmd) {
    if (!cmd || !cmd.action || !cmd.command_id) return
    try {
      switch (cmd.action) {
        case 'play':
          _resumeAudioContext()
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
          audio.pause()
          _syncSetCommandResult(cmd, { ok: true })
          break
        case 'next':
          playNext()
          _syncSetCommandResult(cmd, { ok: true })
          break
        case 'prev':
          playPrevious()
          _syncSetCommandResult(cmd, { ok: true })
          break
        case 'seek':
          if (cmd.seekTime != null && !isNaN(audio.duration)) {
            audio.currentTime = Math.min(cmd.seekTime, audio.duration)
          }
          _syncSetCommandResult(cmd, { ok: true })
          break
        case 'set_volume':
          if (cmd.volume != null) {
            var v = Math.max(0, Math.min(1, cmd.volume))
            _volSlider = v
            _setVolume(_volCurve(v))
            audio.muted = v === 0
            if (volumeSlider) volumeSlider.value = Math.round(v * 100)
            localStorage.setItem('mp_volume', _volSlider)
            _updateVolumeIcon()
          }
          _syncSetCommandResult(cmd, { ok: true })
          break
        case 'play_tracks':
          if (!cmd.tracks || !cmd.tracks.length) {
            _syncSetCommandResult(cmd, { error: 'NO TRACKS PROVIDED', error_code: 'invalid_command' })
            break
          }
          _resumeAudioContext()
          playMusicLibrary(cmd.tracks, cmd.startIndex || 0)
          // Ensure playback starts even if the player was paused.
          setTimeout(function() {
            if (!audio.paused) {
              _syncSetCommandResult(cmd, { ok: true })
              return
            }
            _resumeAudioContext()
            audio.play().then(function() {
              console.log('[MUSIC PLAYER] Remote play_tracks: retry succeeded')
              _syncSetCommandResult(cmd, { ok: true })
            }).catch(function(err) {
              console.warn('[MUSIC PLAYER] Remote play_tracks: play blocked:', err.name)
              _syncSetCommandResult(cmd, {
                error: 'PLAYBACK BLOCKED ON REMOTE DEVICE - TAP PLAY ON THAT DEVICE FIRST',
                error_code: 'autoplay_blocked'
              })
            })
          }, 500)
          break
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

  function _syncEnterPhantom(data) {
    var state = data.state
    if (!state || !state.playlist || !state.playlist.length) return

    _syncPhantomMode = true
    _syncIsActive = false
    _syncStopKeepAlive()

    // Start silent audio keepalive so the browser shows Media Session
    // notification/lock-screen controls even though no real audio is playing.
    // The play/pause/timeupdate event handlers are guarded to skip in phantom mode.
    // Only set audio.src on the FIRST entry — subsequent poll-driven re-entries
    // skip this to avoid constant load/play cycling that confuses the browser.
    if (_silentBlobUrl && !_syncPhantomKeepaliveActive) {
      _syncPhantomKeepaliveActive = true
      audio.loop = true
      audio.muted = false
      audio.src = _silentBlobUrl
      // Ensure volume is nonzero — Chrome may suppress notifications for
      // muted/zero-volume audio.  If a GainNode controls volume, audio.volume
      // is already 1; otherwise set a barely-audible floor.
      if (!_gainNode && audio.volume === 0) audio.volume = 0.01

      // iOS (WebKit) needs metadata + action handlers set BEFORE audio.play()
      // for the Now Playing widget to show full controls (next/prev/seek).
      // Set metadata eagerly here; it will be refreshed in .then() and on polls.
      if ('mediaSession' in navigator) {
        var firstTrack = state.playlist[state.currentIndex]
        if (firstTrack) {
          _updateMediaSession({
            name: firstTrack.name, coverPath: firstTrack.coverPath || null,
            artists: firstTrack.artists || [],
            artistName: firstTrack.artistName || '',
          })
        }
        // Provide a valid position state immediately — iOS won't show
        // next/prev/scrubber without one.  Use actual duration if available,
        // otherwise a fallback of 180s (typical song length).
        var dur = state.duration || 180
        var pos = Math.min(state.currentTime || 0, dur)
        try {
          navigator.mediaSession.setPositionState({ duration: dur, playbackRate: 1, position: pos })
        } catch(e) {}
        navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused'
      }

      _resumeAudioContext()
      audio.play().then(function() {
        // Audio is now actually playing — re-set Media Session state so
        // browsers that ignore pre-play metadata pick it up now.
        if ('mediaSession' in navigator) {
          var t = state.playlist[state.currentIndex]
          if (t) _updateMediaSession(t)
          navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused'
        }
        _updateMediaSessionPositionState()
      }).catch(function(e) {
        console.warn('[MUSIC PLAYER] Phantom silent keepalive play failed:', e.name)
        _syncPhantomKeepaliveActive = false
      })
    } else if (!_silentBlobUrl && !audio.paused) {
      audio.pause()
    }

    // Show the player if not visible
    if (!isVisible) _showPlayer()

    // Update UI with remote state
    playerEl.classList.add('mp-phantom')
    if (phantomLabel) {
      phantomLabel.textContent = 'PLAYING ON ' + (data.active_device_name || 'ANOTHER DEVICE').toUpperCase()
    }

    // Store the remote playlist/index FIRST so _setTitle() can read artist info
    playlist = state.playlist.map(function(t) {
      return {
        id: t.id, name: t.name, extension: t.extension || 'opus',
        isE2E: false, sourceUrl: t.sourceUrl || '/music/stream/' + t.id,
        blobUrl: null, coverPath: t.coverPath || null,
        artistName: t.artistName || '', artistIds: t.artistIds || [],
        artists: t.artists || [], albumId: t.albumId || null,
        suggested: t.suggested || false,
      }
    })
    currentIndex = state.currentIndex

    // Update track display from remote state (detect track change)
    var track = playlist[currentIndex]
    var trackId = track ? track.id : null
    var trackChanged = trackId !== _syncPhantomTrackId
    _syncPhantomTrackId = trackId
    if (track) {
      if (trackChanged) {
        _setTitle(track.name)
        if (_context === 'music-library' || track.suggested) _updatePlayerArt(track)
        _updateMediaSession(track)
      }
    }
    shuffleMode = !!state.shuffleMode
    repeatMode = state.repeatMode || 'none'
    shuffleOrder = state.shuffleOrder || []
    shufflePos = (typeof state.shufflePos === 'number' ? state.shufflePos : -1)
    _suggestedStartIndex = (typeof state.suggestedStartIndex === 'number' ? state.suggestedStartIndex : -1)

    // Track state freshness — reset stale flag on fresh data
    _syncPhantomStateTs = data.state_updated_at || null
    _syncPhantomStale = false

    // Update interpolation state from poll
    _syncPhantomTime = state.currentTime || 0
    _syncPhantomDuration = state.duration || 0
    _syncPhantomPlaying = !!state.isPlaying
    _syncPhantomPollTs = Date.now()

    // Update progress display immediately
    _syncPhantomUpdateUI()

    // Show playing state visually
    isPlaying = state.isPlaying
    _updatePlayButton()

    // Start interpolation animation if playing
    _syncPhantomStartInterpolation()

    _syncUpdateDevicesButton()
    if (trackChanged) _renderPlaylist()

    // Explicitly set Media Session state for lock-screen/notification controls
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused'
    }
    _updateMediaSessionPositionState()

    // Keep lock-screen position updated via setInterval — unlike rAF this
    // continues to fire (~1/sec) when the app is backgrounded on mobile,
    // which keeps the iOS scrubber and Android notification progress alive.
    if (!_syncPhantomPositionTimer) {
      _syncPhantomPositionTimer = setInterval(function() {
        if (!_syncPhantomMode) return
        _updateMediaSessionPositionState()
      }, 4000)
    }
  }

  // Optimistic phantom track update (called from music-browse.js when sending play_tracks)
  function _syncPhantomUpdateTrack(track) {
    if (!_syncPhantomMode || !track) return
    // Update playlist entry so _setTitle() can read artist info
    if (currentIndex >= 0 && currentIndex < playlist.length) {
      var artists = track.artists || []
      playlist[currentIndex] = Object.assign({}, playlist[currentIndex], {
        id: track.id || playlist[currentIndex].id,
        name: track.title || track.name || playlist[currentIndex].name,
        artistName: artists.map(function(a) { return a.name }).join(', '),
        artists: artists,
        artistIds: artists.map(function(a) { return a.id }),
        albumId: track.album_id || track.albumId || playlist[currentIndex].albumId,
        coverPath: track.cover_path || track.coverPath || playlist[currentIndex].coverPath,
      })
    }
    _setTitle((track.title || track.name || 'UNKNOWN').toUpperCase())
    var coverPath = track.cover_path || track.coverPath || null
    if (coverPath) _updatePlayerArt({ coverPath: coverPath })
    // Reset progress to 0 for new track
    _syncPhantomTime = 0
    _syncPhantomDuration = 0
    _syncPhantomPlaying = true
    _syncPhantomPollTs = Date.now()
    _syncPhantomTrackId = track.id || null
    _syncPhantomRenderProgress(0, 1)
    isPlaying = true
    _updatePlayButton()
    // Update lock-screen metadata for the new track
    var updatedTrack = (currentIndex >= 0 && currentIndex < playlist.length) ? playlist[currentIndex] : null
    if (updatedTrack) _updateMediaSession(updatedTrack)
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
  }

  // Smooth progress interpolation for phantom mode
  function _syncPhantomStartInterpolation() {
    // Cancel any existing animation
    if (_syncPhantomRAF) { cancelAnimationFrame(_syncPhantomRAF); _syncPhantomRAF = null }

    function tick() {
      if (!_syncPhantomMode) return
      if (_syncPhantomPlaying && _syncPhantomDuration > 0) {
        var elapsed = (Date.now() - _syncPhantomPollTs) / 1000
        // Client-side staleness check: if no fresh poll data in 10s, pause phantom
        if (elapsed > 10 && !_syncPhantomStale) {
          _syncPausePhantom()
          return  // stop interpolation
        }
        var interpolated = _syncPhantomTime + elapsed
        if (interpolated > _syncPhantomDuration) interpolated = _syncPhantomDuration
        _syncPhantomRenderProgress(interpolated, _syncPhantomDuration)
        // Update lock-screen position state periodically (every ~5s)
        var now = Date.now()
        if (now - _lastPositionUpdate > 5000) {
          _lastPositionUpdate = now
          _updateMediaSessionPositionState()
        }
      }
      _syncPhantomRAF = requestAnimationFrame(tick)
    }
    _syncPhantomRAF = requestAnimationFrame(tick)
  }

  function _syncPhantomRenderProgress(time, duration) {
    if (progressEl && duration > 0) {
      progressEl.value = Math.round((time / duration) * 1000)
      _updateProgressFill()
    }
    if (currentTimeEl) currentTimeEl.textContent = _formatTime(time)
    if (durationEl && duration > 0) durationEl.textContent = _formatTime(duration)
  }

  function _syncPhantomUpdateUI() {
    _syncPhantomRenderProgress(_syncPhantomTime, _syncPhantomDuration)
  }

  function _syncExitPhantom() {
    _syncPhantomMode = false
    _syncPhantomTrackId = null
    _syncPhantomStale = false
    _syncPhantomStateTs = null
    _syncPhantomKeepaliveActive = false
    if (_syncPhantomRAF) { cancelAnimationFrame(_syncPhantomRAF); _syncPhantomRAF = null }
    if (_syncPhantomPositionTimer) { clearInterval(_syncPhantomPositionTimer); _syncPhantomPositionTimer = null }
    if (playerEl) playerEl.classList.remove('mp-phantom')
    if (phantomLabel) phantomLabel.textContent = ''

    // Stop silent keepalive audio — restore audio element for normal use
    audio.loop = false
    audio.pause()
    audio.src = ''

    // If we have no local playlist, hide the player
    if (currentIndex < 0 || playlist.length === 0) {
      if (isVisible) closePlayer()
    } else {
      // Restore local state display
      _updatePlayButton()
    }
    _syncUpdateDevicesButton()
  }

  function _syncPausePhantom() {
    // Remote device stopped updating — pause phantom display but keep it visible
    _syncPhantomStale = true
    _syncPhantomPlaying = false
    isPlaying = false
    _updatePlayButton()

    // Stop the interpolation animation so the seek bar freezes
    if (_syncPhantomRAF) { cancelAnimationFrame(_syncPhantomRAF); _syncPhantomRAF = null }

    // Update lock-screen to show paused (silent keepalive stays running to
    // keep the notification visible so the user can still tap play)
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'

    // Update phantom label to reflect disconnected state
    // Extract the device name from the current label ("PLAYING ON <NAME>") or use fallback
    var prevName = 'REMOTE DEVICE'
    if (phantomLabel && phantomLabel.textContent) {
      var match = phantomLabel.textContent.match(/^PLAYING ON (.+)$/)
      if (match) prevName = match[1]
    }
    if (phantomLabel) {
      phantomLabel.textContent = 'PAUSED - ' + prevName + ' DISCONNECTED'
    }

    _syncUpdateDevicesButton()
  }

  function _syncAcceptTransfer(data) {
    var state = data.state
    if (!state || !state.playlist || !state.playlist.length) return

    // Clear transfer flag on server
    fetch('/music/api/sync/transfer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ target_device_id: '' }),
    }).catch(function() {})

    // Exit phantom mode and clean up interpolation
    _syncPhantomMode = false
    _syncPhantomTrackId = null
    _syncPhantomStale = false
    _syncPhantomStateTs = null
    _syncPhantomKeepaliveActive = false
    if (_syncPhantomRAF) { cancelAnimationFrame(_syncPhantomRAF); _syncPhantomRAF = null }
    if (_syncPhantomPositionTimer) { clearInterval(_syncPhantomPositionTimer); _syncPhantomPositionTimer = null }
    if (playerEl) playerEl.classList.remove('mp-phantom')
    if (phantomLabel) phantomLabel.textContent = ''

    // Stop silent keepalive — real audio is about to play
    audio.loop = false

    // Load the remote playlist and start playing
    _context = 'music-library'
    playlist = state.playlist.map(function(t) {
      return {
        id: t.id, name: t.name, extension: t.extension || 'opus',
        isE2E: false, sourceUrl: t.sourceUrl || '/music/stream/' + t.id,
        blobUrl: null, coverPath: t.coverPath || null,
        artistName: t.artistName || '', artistIds: t.artistIds || [],
        artists: t.artists || [], albumId: t.albumId || null,
        suggested: t.suggested || false,
      }
    })
    _suggestedStartIndex = (typeof state.suggestedStartIndex === 'number' ? state.suggestedStartIndex : -1)
    shuffleMode = !!state.shuffleMode
    repeatMode = state.repeatMode || 'none'
    shuffleOrder = state.shuffleOrder || []
    shufflePos = (typeof state.shufflePos === 'number' ? state.shufflePos : -1)

    // Update shuffle/repeat UI
    if (shuffleBtn) shuffleBtn.classList.toggle('mp-btn-active', shuffleMode)
    _updateRepeatButton()

    _showPlayer()
    _renderPlaylist()

    var idx = state.currentIndex
    if (idx < 0 || idx >= playlist.length) idx = 0
    var seekTo = state.currentTime || 0

    _syncIsActive = true  // This device is now the active one
    _syncForceActive = true  // Force claim — explicit transfer
    _loadTrack(idx)

    // Seek to the remote position after the track loads
    var onCanPlay = function() {
      audio.removeEventListener('canplay', onCanPlay)
      if (seekTo > 0 && !isNaN(audio.duration) && seekTo < audio.duration) {
        audio.currentTime = seekTo
      }
    }
    audio.addEventListener('canplay', onCanPlay)

    if (devicesBtn) devicesBtn.style.display = ''
    _syncUpdateDevicesButton()
    // Immediately push state so the old active device sees us as active
    setTimeout(function() { _syncPushState() }, 300)
    console.log('[MUSIC PLAYER] Accepted playback transfer from remote device')
  }

  function _syncYieldToDevice(targetDeviceId) {
    // Another device is taking over
    _syncIsActive = false
    _syncForceActive = false
    _syncStopKeepAlive()
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
        _syncPhantomPlaying = false
        isPlaying = false
        _updatePlayButton()
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
      body: JSON.stringify({ command_id: pending.command_id, device_id: _syncDeviceId }),
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
      body: JSON.stringify({ command: cmd, requester_device_id: _syncDeviceId }),
    }).catch(function() {})
  }

  function _syncRequestTransfer() {
    // Request that playback be transferred TO this device (called from phantom)
    fetch('/music/api/sync/transfer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ target_device_id: _syncDeviceId }),
    }).then(function() {
      console.log('[MUSIC PLAYER] Requested playback transfer to this device')
    }).catch(function() {})
  }

  function _syncTransferToDevice(targetDeviceId) {
    // Push playback to a remote device (called from active device)
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

  function _syncUpdateDevicesButton() {
    var hasRemoteActive = _syncPhantomMode || (_syncDevices.length > 1 && _syncDevices.some(function(d) { return d.is_active && !d.is_self }))
    if (devicesBtn) devicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (miniDevicesBtn) miniDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (fsDevicesBtn) fsDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
  }

  // ─── Devices Panel UI ──────────────────────────────────────────

  function _toggleDevicesPanel() {
    if (!devicesPanel) return
    var isVis = devicesPanel.classList.contains('mp-devices-visible')
    if (isVis) {
      devicesPanel.classList.remove('mp-devices-visible')
    } else {
      // Close playlist panel if open
      if (playlistPanel) playlistPanel.classList.remove('mp-playlist-visible')
      if (playlistBtn) playlistBtn.classList.remove('mp-btn-active')
      var fsPl = document.getElementById('mpFsPlaylistBtn')
      if (fsPl) fsPl.classList.remove('mp-btn-active')
      _renderDevicesPanel()
      devicesPanel.classList.add('mp-devices-visible')
    }
  }

  function _renderDevicesPanel() {
    if (!devicesList) return
    var devices = _syncDevices.length ? _syncDevices : [{ device_id: _syncDeviceId, device_name: _syncDeviceName, is_self: true, is_active: _syncIsActive }]
    var html = ''

    // Sync toggle
    html += '<div class="mp-devices-sync-toggle">'
    html += '<span class="mp-devices-sync-label">CROSS-DEVICE SYNC</span>'
    html += '<button class="mp-sync-toggle' + (_syncEnabled ? ' mp-sync-on' : '') + '" id="mpSyncToggle" title="' + (_syncEnabled ? 'DISABLE' : 'ENABLE') + ' SYNC"></button>'
    html += '</div>'

    for (var i = 0; i < devices.length; i++) {
      var d = devices[i]
      var isActive = d.is_active
      var isSelf = d.is_self
      html += '<div class="mp-device-item' + (isActive ? ' mp-device-active' : '') + '" data-device-id="' + _escMp(d.device_id) + '">'

      // Device icon
      html += '<div class="mp-device-icon">'
      if (/iPhone|Android/.test(d.device_name)) {
        html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'
      } else if (/iPad/.test(d.device_name)) {
        html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'
      } else {
        html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
      }
      html += '</div>'

      // Info
      html += '<div class="mp-device-info">'
      html += '<div class="mp-device-name">' + _escMp(d.device_name) + '</div>'
      var badge = ''
      if (isActive && isSelf) {
        badge = '<span class="mp-device-badge mp-device-badge-active">THIS DEVICE &middot; PLAYING</span>'
      } else if (isActive && !isSelf) {
        badge = '<span class="mp-device-badge mp-device-badge-active">PLAYING</span>'
      } else if (isSelf && _syncPhantomMode) {
        badge = '<span class="mp-device-badge mp-device-badge-transfer">TAP TO PLAY HERE</span>'
      } else if (isSelf) {
        badge = '<span class="mp-device-badge">THIS DEVICE</span>'
      } else if (!isSelf && _syncIsActive) {
        badge = '<span class="mp-device-badge mp-device-badge-transfer">TAP TO TRANSFER</span>'
      }
      html += badge
      html += '</div>'

      // Actions
      html += '<div class="mp-device-actions">'
      html += '<button class="mp-device-action-btn" data-action="rename" title="RENAME"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>'
      if (!isSelf) {
        html += '<button class="mp-device-action-btn" data-action="remove" title="REMOVE"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>'
      }
      html += '</div>'
      html += '</div>'
    }

    devicesList.innerHTML = html

    // Bind events
    var syncToggle = document.getElementById('mpSyncToggle')
    if (syncToggle) {
      syncToggle.addEventListener('click', function() {
        _syncEnabled = !_syncEnabled
        localStorage.setItem('mp_sync_enabled', _syncEnabled ? '1' : '0')
        if (_syncEnabled) {
          _syncStart()
        } else {
          _syncStop()
          if (_syncPhantomMode) _syncExitPhantom()
        }
        _renderDevicesPanel()
      })
    }

    // Click on a device item to transfer playback to/from it
    var deviceItems = devicesList.querySelectorAll('.mp-device-item')
    for (var di = 0; di < deviceItems.length; di++) {
      deviceItems[di].addEventListener('click', function(e) {
        // Don't trigger transfer if clicking action buttons
        if (e.target.closest('.mp-device-action-btn') || e.target.closest('.mp-device-rename-input')) return
        var item = e.currentTarget
        var devId = item.dataset.deviceId
        if (!devId) return

        if (devId === _syncDeviceId) {
          // Clicked on self — "play on this device" (pull from remote)
          if (_syncPhantomMode) {
            _syncRequestTransfer()
            devicesPanel.classList.remove('mp-devices-visible')
          }
        } else {
          // Clicked on a remote device — push playback to it
          _syncTransferToDevice(devId)
          devicesPanel.classList.remove('mp-devices-visible')
        }
      })
    }

    // Rename/remove action buttons
    var actionBtns = devicesList.querySelectorAll('.mp-device-action-btn')
    for (var j = 0; j < actionBtns.length; j++) {
      actionBtns[j].addEventListener('click', function(e) {
        e.stopPropagation()
        var btn = e.currentTarget
        var item = btn.closest('.mp-device-item')
        var devId = item ? item.dataset.deviceId : ''
        var action = btn.dataset.action
        if (action === 'rename') {
          _syncRenameDevice(devId, item)
        } else if (action === 'remove') {
          _syncRemoveDevice(devId)
        }
      })
    }
  }

  function _syncRenameDevice(devId, itemEl) {
    if (!itemEl) return
    var nameEl = itemEl.querySelector('.mp-device-name')
    if (!nameEl) return
    var currentName = nameEl.textContent
    nameEl.innerHTML = '<input class="mp-device-rename-input" type="text" value="' + _escMp(currentName) + '" maxlength="100">'
    var input = nameEl.querySelector('input')
    if (!input) return
    input.focus()
    input.select()
    var submitted = false
    var submit = function() {
      if (submitted) return
      submitted = true
      var newName = input.value.trim()
      if (!newName || newName === currentName) {
        nameEl.textContent = currentName
        return
      }
      nameEl.textContent = newName
      // Update server
      fetch('/music/api/sync/device', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: _jsonHeaders(),
        body: JSON.stringify({ device_id: devId, name: newName }),
      }).then(function(r) { return r.json() }).then(function(data) {
        if (data.ok && devId === _syncDeviceId) {
          _syncDeviceName = newName
          localStorage.setItem('mp_device_name', newName)
        }
      }).catch(function() {})
    }
    input.addEventListener('blur', submit)
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); input.blur() }
      if (e.key === 'Escape') { submitted = true; nameEl.textContent = currentName }
    })
  }

  function _syncRemoveDevice(devId) {
    fetch('/music/api/sync/device', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ device_id: devId }),
    }).then(function() {
      _syncDevices = _syncDevices.filter(function(d) { return d.device_id !== devId })
      _renderDevicesPanel()
    }).catch(function() {})
  }

  // Close devices panel when clicking outside
  document.addEventListener('click', function(e) {
    if (devicesPanel && devicesPanel.classList.contains('mp-devices-visible')) {
      if (!devicesPanel.contains(e.target) && e.target !== devicesBtn && (!devicesBtn || !devicesBtn.contains(e.target))) {
        devicesPanel.classList.remove('mp-devices-visible')
      }
    }
  })

  // ─── Override play/pause/next/prev for phantom mode ─────────────

  // We need to intercept the control buttons when in phantom mode.
  // Instead of patching existing functions, we hook into the button
  // click handlers. The existing handlers call togglePlay/playNext/etc.
  // We wrap those to check phantom mode first.

  // Wrap after init runs. We use a MutationObserver-style approach:
  // patch on first call or defer until playBtn exists.
  function _patchSyncControls() {
    // Patch togglePlay
    function _phantomTogglePlay(e) {
      if (_syncPhantomMode) {
        e.stopImmediatePropagation()
        if (isPlaying) {
          _syncSendCommand('pause')
          // Optimistic UI update
          isPlaying = false
          _syncPhantomPlaying = false
          _updatePlayButton()
        } else {
          _syncSendCommand('play')
          isPlaying = true
          _syncPhantomPlaying = true
          _syncPhantomPollTs = Date.now()
          _updatePlayButton()
        }
      }
    }
    if (playBtn && !playBtn._syncPatched) {
      playBtn._syncPatched = true
      playBtn.addEventListener('click', _phantomTogglePlay, true)
    }
    if (miniPlayBtn && !miniPlayBtn._syncPatched) {
      miniPlayBtn._syncPatched = true
      miniPlayBtn.addEventListener('click', _phantomTogglePlay, true)
    }
    if (nextBtn && !nextBtn._syncPatched) {
      nextBtn._syncPatched = true
      nextBtn.addEventListener('click', function(e) {
        if (_syncPhantomMode) {
          e.stopImmediatePropagation()
          _syncSendCommand('next')
        }
      }, true)
    }
    if (prevBtn && !prevBtn._syncPatched) {
      prevBtn._syncPatched = true
      prevBtn.addEventListener('click', function(e) {
        if (_syncPhantomMode) {
          e.stopImmediatePropagation()
          _syncSendCommand('prev')
        }
      }, true)
    }
    // Progress bar seek in phantom mode
    if (progressEl && !progressEl._syncPatched) {
      progressEl._syncPatched = true
      progressEl.addEventListener('input', function(e) {
        if (_syncPhantomMode && _syncPhantomDuration > 0) {
          var seekTime = (e.target.value / 1000) * _syncPhantomDuration
          _syncSendCommand('seek', { seekTime: seekTime })
          // Optimistic update — reset interpolation origin
          _syncPhantomTime = seekTime
          _syncPhantomPollTs = Date.now()
        }
      }, true)
    }
  }

  // Hook into the audio play event to mark this device as active
  audio.addEventListener('play', function() {
    if (_syncPhantomMode) return  // silent keepalive — do not claim active
    if (_context === 'music-library' && _syncLoggedIn && _syncEnabled && !_syncPhantomMode) {
      _syncIsActive = true
      // Show devices button if not already shown
      if (devicesBtn) devicesBtn.style.display = ''
    }
  })

  // ─── Expose globally ───────────────────────────────────────────
  window.MusicPlayer = MusicPlayer
})()
