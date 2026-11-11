// ─── ONE.GY Music Player ─────────────────────────────────────────────
// A persistent floating music player that survives SPA folder navigation.
// Builds playlists from sibling audio files in the current folder view.
// Supports both server-encrypted and E2E encrypted audio files.
//
// The player is split into classic scripts that load in this order (see
// templates/files.html and templates/music.html):
//   music-player-core.js        namespace, shared state, helpers, <audio>
//   music-player-ui.js          player bar rendering, playlist panel
//   music-player-fullscreen.js  mobile fullscreen view, swipe gestures
//   music-player-fx.js          Web Audio graph, visualizer, chaos mode
//   music-player-session.js     Media Session, iOS background, persistence
//   music-player-e2e.js         E2E encrypted track loading
//   music-player-playback.js    track loading, transport, <audio> events
//   music-player-queue.js       playlists, shuffle, autoplay, crossfade
//   music-player-sync.js        cross-device sync engine
//   music-player-phantom.js     phantom mode (mirroring a remote device)
//   music-player-devices.js     devices panel
//   music-player.js             window.MusicPlayer and init (load last)
// Every file is an IIFE over the shared namespace `mp` (window._mpCore).
// State used by more than one file lives on `mp` (mp.playlist, ...);
// functions another file calls are exported with Object.assign(mp, ...) at
// the end of their file and called as mp.fn(). The immutable helpers and
// the <audio> element exported here are destructured at the top of each file.

;(function() {
  'use strict'

  var mp = window._mpCore = {}

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

  // Web Storage throws when disabled (privacy modes, sandboxed frames) or full;
  // that must never take the whole player down.
  function _lsGet(key) { try { return localStorage.getItem(key) } catch (e) { return null } }
  function _lsSet(key, value) { try { localStorage.setItem(key, value) } catch (e) {} }
  function _ssGet(key) { try { return sessionStorage.getItem(key) } catch (e) { return null } }
  function _ssSet(key, value) { try { sessionStorage.setItem(key, value) } catch (e) {} }
  function _ssRemove(key) { try { sessionStorage.removeItem(key) } catch (e) {} }

  // ─── State ──────────────────────────────────────────────────────
  mp.playlist = []          // [{id, name, extension, isE2E, sourceUrl, blobUrl}]
  mp.currentIndex = -1
  mp.shuffleMode = false
  mp.repeatMode = 'none'    // 'none' | 'all' | 'one'
  mp.shuffleOrder = []
  mp.shufflePos = -1
  mp.isVisible = false
  mp.isPlaying = false
  mp._context = 'dashboard' // 'dashboard' | 'browse'
  mp._browseShareToken = ''
  mp._currentBlobUrl = null
  mp._autoplayEnabled = _lsGet('mp_autoplay') !== '0'  // default: on
  mp._suggestedStartIndex = -1  // index where suggested tracks begin in playlist
  mp._crossfadeActive = false
  mp._crossfadeAudio = null
  mp._crossfadeProgress = 0
  mp._crossfadeTriggered = false  // prevents re-triggering crossfade for same boundary
  mp._isFullscreen = false        // mobile fullscreen "now playing" state
  mp._errorSkipCount = 0          // consecutive error-skip counter (prevents infinite loops)
  mp._lastPositionUpdate = 0      // timestamp of last Media Session position update
  mp._loadSeq = 0
  mp._scrubbing = false            // the user is dragging the progress thumb

  // ─── Auto-queue State ───────────────────────────────────────────
  mp._autoQueueLoading = false
  mp._autoQueuePromise = null       // in-flight promise so callers can piggyback
  mp._suggestApiUnavailable = false  // set true on 401/403 to avoid repeated failed calls
  mp._autoQueueFailures = 0          // consecutive failed fetches (exponential backoff)
  mp._autoQueueRetryAt = 0           // Date.now() before which no new fetch is started

  // ─── Cross-Device Sync State ───────────────────────────────────
  mp._syncEnabled = _lsGet('mp_sync_enabled') !== '0'  // on by default
  // Per tab (sessionStorage): two tabs are two players and must not share an id.
  mp._syncDeviceId = _ssGet('mp_device_id') || null
  mp._syncDeviceName = _lsGet('mp_device_name') || ''
  mp._syncEpoch = 0                // bumped on local play / transfer / phantom exit: older responses are dropped
  mp._syncIsActive = false         // true = this device is outputting audio
  mp._syncPhantomMode = false      // true = showing remote state, no local audio
  mp._syncDevices = []             // list of known devices from server
  mp._syncForceActive = false      // send force_active on next push (explicit user action)
  mp._syncLoggedIn = false         // whether user is logged in (set in init)
  mp._syncPhantomTime = 0          // interpolated current time for phantom progress
  mp._syncPhantomDuration = 0      // duration from last phantom state
  mp._syncPhantomPlaying = false   // whether remote is playing (for interpolation)
  mp._syncPhantomPollTs = 0        // Date.now() when last phantom state was received
  mp._syncPhantomTrackId = null    // track ID to detect track changes
  mp._syncPhantomRAF = null        // requestAnimationFrame handle for interpolation
  mp._syncPhantomStateTs = null    // ISO timestamp of last state update from active device
  mp._syncPhantomStale = false     // true = remote device stopped updating (>10s)
  mp._syncPhantomKeepaliveActive = false  // true = silent WAV is looping on audio element for Media Session
  mp._syncPhantomPositionTimer = null  // setInterval for lock-screen position updates (survives background)

  // ─── Visualizer State ──────────────────────────────────────────
  mp._fxEnabled = false
  mp._audioCtx = null
  mp._gainNode = null   // volume control via Web Audio (keeps analyser full-strength)
  mp._fxCanvas = null
  mp._fxCtx = null
  mp._fxConnected = false

  // ─── Chaos Mode (Easter Egg) ────────────────────────────────────
  mp._chaosMode = false

  // ─── iOS Detection ────────────────────────────────────────────
  // iOS Safari suspends audio when the page is backgrounded and requires
  // special handling to maintain background playback and Media Session controls.
  var _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  mp._wasPlayingBeforeBackground = false  // tracks if audio was playing when page was hidden

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
  mp._volSlider = parseFloat(_lsGet('mp_volume') || '0.5')
  if (!(mp._volSlider >= 0 && mp._volSlider <= 1)) mp._volSlider = 0.5
  mp._desiredVolume = _volCurve(mp._volSlider)
  audio.volume = mp._desiredVolume
  audio.muted = mp._volSlider === 0

  // Set the playback volume. Once the element is routed through the Web Audio
  // graph, volume is controlled via the GainNode (so the analyser always sees
  // full-strength signal). Before that -- even if the sync keepalive already
  // created the context and gain node -- we use audio.volume.
  function _applyOutputVolume(v) {
    if (mp._fxConnected) {
      mp._gainNode.gain.value = v
      audio.volume = 1  // keep element at full so analyser gets full signal
    } else {
      audio.volume = v
    }
  }

  function _applyCrossfadeVolumes(progress) {
    var fadeOut = Math.cos(progress * Math.PI * 0.5)
    var fadeIn = Math.sin(progress * Math.PI * 0.5)
    _applyOutputVolume(mp._desiredVolume * fadeOut)
    if (mp._crossfadeAudio) mp._crossfadeAudio.volume = mp._desiredVolume * fadeIn
  }

  function _setVolume(v) {
    mp._desiredVolume = Math.max(0, Math.min(1, v))
    if (mp._crossfadeActive) {
      _applyCrossfadeVolumes(mp._crossfadeProgress)
    } else {
      _applyOutputVolume(mp._desiredVolume)
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

  // ─── DOM References (set by init in music-player.js) ────────────
  // mp.playerEl, mp.titleEl, mp.titleInner, mp.artistEl, mp.currentTimeEl, mp.durationEl, mp.progressEl
  // mp.playBtn, mp.shuffleBtn, mp.repeatBtn
  // mp.volumeBtn, mp.playlistBtn, mp.playlistPanel, mp.fxBtn, mp.autoplayBtn, mp.miniPlayBtn
  // mp.fsHeartBtn, mp.fsAddBtn
  // mp.devicesBtn, mp.devicesPanel, mp.devicesList, mp.phantomLabel, mp.miniDevicesBtn, mp.fsDevicesBtn
  // (references only one file uses are kept in that file)

  // Cover paths also arrive in remote sync state: only a library cover path
  // ("covers/<id>.jpg" or "artists/<id>.jpg") ever becomes an image URL.
  function _coverUrl(coverPath) {
    var m = typeof coverPath === 'string' ? /^(covers|artists)\/([\w-]+)\.jpg$/.exec(coverPath) : null
    return m ? '/music/cover/' + encodeURIComponent(m[2]) : ''
  }

  // Detach the media resource without an error event. `audio.src = ''` loads
  // the page URL as media, fails, and _onError would then auto-skip.
  function _clearAudioSrc() {
    audio.removeAttribute('src')
    audio.load()
  }

  Object.assign(mp, {
    AUDIO_EXTS,
    AUDIO_MIME,
    _csrfToken,
    _jsonHeaders,
    _lsGet,
    _lsSet,
    _ssGet,
    _ssSet,
    _ssRemove,
    _isIOS,
    audio,
    _silentBlobUrl,
    _volCurve,
    _applyOutputVolume,
    _applyCrossfadeVolumes,
    _setVolume,
    _stripAudioExtension,
    _coverUrl,
    _clearAudioSrc,
  })
})()
