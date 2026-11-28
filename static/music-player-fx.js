// ─── ONE.GY Music Player: Web Audio graph, visualizer and chaos mode ───
// Loaded on first use (mp._loadPart): when the visualizer can show (core's
// _startFx stand-in) or on the first FX button click.
;(function(mp) {
  'use strict'

  const { _lsSet, audio, _setVolume } = mp
  const _FX_FRAME_MS = 30  // drawn at 30 fps: every other frame at 60 Hz

  // ─── Visualizer State ──────────────────────────────────────────
  let _analyser = null
  let _sourceNode = null
  let _fxRafId = null
  let _fxSmoothed = null  // smoothed band levels for silky animation
  let _fxRgb = [55, 182, 255]  // line colour, refreshed from --accent-rgb on resize
  // Kept between frames (set on resize): no per-frame allocation or layout read
  let _fxData = null      // analyser bins
  let _fxYs = null        // horizon points
  let _fxW = 0, _fxH = 0  // canvas size in CSS px
  let _fxFill = null      // horizon fill gradient
  let _fxStroke = ''
  let _fxResizeObs = null
  let _fxLastT = 0        // rAF time of the last drawn frame

  // ─── Chaos Mode State ──────────────────────────────────────────
  let _chaosClickTimes = []
  const _CHAOS_CLICKS = 10
  const _CHAOS_WINDOW = 2500 // ms
  const _CHAOS_PINK = [255, 61, 200]
  const _CHAOS_CYAN = [60, 242, 255]
  const _CHAOS_GOLD = [255, 211, 110]
  let _chaosStars = []
  let _chaosWaves = []
  let _chaosShooters = []
  let _chaosSpin = 0
  let _chaosPrevBass = 0
  let _chaosLastT = 0
  let _chaosLockedUntil = 0        // timestamp: ignore clicks until this time after activation

  // ─── Audio Visualizer ─────────────────────────────────────────
  function _toggleFx() {
    // ── Chaos mode cooldown: swallow all clicks for 3s after activation ──
    const now = Date.now()
    if (mp._chaosMode && now < _chaosLockedUntil) return

    // ── Easter egg: rapid-click detection for chaos mode ──
    _chaosClickTimes.push(now)
    if (_chaosClickTimes.length > _CHAOS_CLICKS) _chaosClickTimes.shift()
    if (_chaosClickTimes.length === _CHAOS_CLICKS &&
        now - _chaosClickTimes[0] <= _CHAOS_WINDOW) {
      _chaosClickTimes = []
      _toggleChaosMode()
      return  // don't toggle FX on/off during chaos activation
    }

    mp._fxEnabled = !mp._fxEnabled
    _lsSet('mp_fx', mp._fxEnabled ? '1' : '0')
    if (mp.fxBtn) mp.fxBtn.classList.toggle('mp-btn-active', mp._fxEnabled)

    if (mp._fxEnabled) {
      _startFx()
    } else {
      _stopFx()
    }
  }

  function _connectSource() {
    if (mp._fxConnected) return
    if (!mp._ensureAudioContext()) return
    try {
      if (!_analyser) {
        _analyser = mp._audioCtx.createAnalyser()
        _analyser.fftSize = 2048
        _analyser.smoothingTimeConstant = 0.6
        _analyser.minDecibels = -85
        _analyser.maxDecibels = -20
      }
      if (!_sourceNode) {
        _sourceNode = mp._audioCtx.createMediaElementSource(audio)
        // Once connected, volume is controlled via _gainNode -- keep
        // the element at full volume so the analyser sees full signal.
        audio.volume = 1
      }
      // Route: source -> analyser (full signal) -> gainNode (volume) -> speakers
      _sourceNode.connect(_analyser)
      _analyser.connect(mp._gainNode)
      mp._gainNode.connect(mp._audioCtx.destination)
      mp._fxConnected = true
      _setVolume(mp._desiredVolume)  // volume moves from the element to the gain node
      mp._resumeAudioContext()
    } catch (e) {
      console.warn('[MUSIC PLAYER] Failed to connect audio source:', e)
    }
  }

  // Only where the canvas shows (mp._fxShown), and never for a mirror: its
  // audio is a silent keepalive, if any. Called again on every 'playing'.
  function _startFx() {
    if (!mp._fxShown() || mp._syncPhantomMode || !mp._fxCanvas) return
    _connectSource()
    if (!mp._fxCtx) mp._fxCtx = mp._fxCanvas.getContext('2d')
    if (!mp._fxCtx || !_analyser) return
    if (mp.playerEl && mp.playerEl.classList.contains('mp-fx-active') && _fxFill) { _fxRun(); return }
    if (mp.playerEl) mp.playerEl.classList.add('mp-fx-active')
    // The canvas follows the bar's width and chaos mode's height
    if (!_fxResizeObs && typeof ResizeObserver === 'function') {
      _fxResizeObs = new ResizeObserver(function() { if (mp._fxEnabled) _resizeFxCanvas() })
      _fxResizeObs.observe(mp._fxCanvas)
    }

    // Wait a frame for CSS to apply (canvas needs height from .mp-fx-active)
    requestAnimationFrame(() => {
      _resizeFxCanvas()
      _fxSmoothed = null
      _fxRun()
    })
  }

  // Draw a frame; _fxLoop goes on only while audio plays (and until the line
  // has settled after a pause), never on phantom mode's silent keepalive.
  function _fxRun() {
    if (_fxRafId || !mp._fxShown() || !_analyser || !mp._fxCtx || !mp._fxCanvas) return
    _fxRafId = requestAnimationFrame(_fxLoop)
  }

  function _stopFx() {
    if (mp._chaosMode) _stopChaos()
    if (_fxRafId) {
      cancelAnimationFrame(_fxRafId)
      _fxRafId = null
    }
    if (mp.playerEl) mp.playerEl.classList.remove('mp-fx-active')
    // Clear canvas
    if (mp._fxCtx && mp._fxCanvas) {
      mp._fxCtx.clearRect(0, 0, mp._fxCanvas.width, mp._fxCanvas.height)
    }
  }

  function _stopFxLoop() {
    if (_fxRafId) {
      cancelAnimationFrame(_fxRafId)
      _fxRafId = null
    }
  }

  function _resizeFxCanvas() {
    if (!mp._fxCanvas || !mp._fxCtx) return
    const rect = mp._fxCanvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    _fxW = rect.width
    _fxH = rect.height
    mp._fxCanvas.width = rect.width * dpr
    mp._fxCanvas.height = rect.height * dpr
    mp._fxCtx.scale(dpr, dpr)
    // Bars use the theme accent (--accent-rgb, e.g. "55,182,255")
    var rgb = getComputedStyle(mp._fxCanvas).getPropertyValue('--accent-rgb').split(',').map(Number)
    if (rgb.length === 3 && rgb.every(function(n) { return n >= 0 && n <= 255 })) _fxRgb = rgb
    const r = _fxRgb[0], g = _fxRgb[1], b = _fxRgb[2]
    const base = _fxH - 0.75
    _fxFill = mp._fxCtx.createLinearGradient(0, base - Math.min(26, _fxH - 2), 0, base)
    _fxFill.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',0)')
    _fxFill.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0.22)')
    _fxStroke = 'rgba(' + r + ',' + g + ',' + b + ',0.9)'
    _fxRun()  // resizing cleared the canvas: a paused bar gets its resting line back
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

  function _fxLoop(t) {
    _fxRafId = null
    if (!mp._fxShown() || !_analyser || !mp._fxCtx || !mp._fxCanvas) return
    if (t - _fxLastT < _FX_FRAME_MS) { _fxRafId = requestAnimationFrame(_fxLoop); return }
    _fxLastT = t
    if (!_fxFill) _resizeFxCanvas()

    const bufLen = _analyser.frequencyBinCount   // 1024 bins (fftSize 2048)
    if (!_fxData || _fxData.length !== bufLen) _fxData = new Uint8Array(bufLen)
    const data = _fxData
    _analyser.getByteFrequencyData(data)

    const W = _fxW
    const H = _fxH
    mp._fxCtx.clearRect(0, 0, W, H)
    let peak = 0

    const barCount = 48
    if (!_fxSmoothed || _fxSmoothed.length !== barCount) {
      _fxSmoothed = new Float32Array(barCount)
    }

    // Derive bin boundaries from actual sample rate for accurate mapping.
    // fftSize=2048 -> 1024 bins. Each bin = sampleRate / fftSize Hz wide.
    const sampleRate = mp._audioCtx ? mp._audioCtx.sampleRate : 48000
    const binHz = sampleRate / 2048  // Hz per bin

    // Map bars to frequency range 30 Hz – 18 kHz using exponential (octave-based)
    // scaling. Each bar spans a roughly equal musical interval (~1/5 octave).
    const freqMin = 30
    const freqMax = 18000
    const logMin = Math.log(freqMin)
    const logMax = Math.log(freqMax)
    // Asymmetric smoothing, per 60 Hz frame (chaos mode: snappier attack for
    // punchier bass), applied twice per drawn frame at 30 fps
    const attack = 1 - Math.pow(1 - (mp._chaosMode ? 0.6 : 0.45), 2)
    const decay = 1 - Math.pow(1 - (mp._chaosMode ? 0.15 : 0.12), 2)

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
      const gain = mp._chaosMode
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
      const compPow = mp._chaosMode ? 0.92 : 0.85
      const compressed = cleaned > 0 ? Math.pow(cleaned, compPow) : 0
      const clamped = Math.min(1.0, compressed)

      const prev = _fxSmoothed[i]
      _fxSmoothed[i] = clamped > prev
        ? prev + (clamped - prev) * attack
        : prev + (clamped - prev) * decay
      if (_fxSmoothed[i] > peak) peak = _fxSmoothed[i]
    }

    _drawHorizon(mp._fxCtx, W, H)
    if (mp._chaosMode) _renderChaos(W, H, data, bufLen)
    // Paused (or mirroring): run on until the line has settled flat, then stop
    if ((!audio.paused && !mp._syncPhantomMode) || peak > 0.01) {
      if (!_fxRafId) _fxRafId = requestAnimationFrame(_fxLoop)
    }
  }

  // Band level at position 0..1 (0 = bass), interpolated between bands
  function _bandAt(pos) {
    const f = Math.max(0, Math.min(1, pos)) * (_fxSmoothed.length - 1)
    const i = Math.floor(f)
    const next = _fxSmoothed[Math.min(_fxSmoothed.length - 1, i + 1)]
    return _fxSmoothed[i] + (next - _fxSmoothed[i]) * (f - i)
  }

  // Horizon: the bar's top hairline becomes a spectrum line, bass in the
  // middle, rising at most 26px into the page.
  function _drawHorizon(ctx, W, H) {
    const base = H - 0.75
    const amp = Math.min(26, H - 2)
    const n = Math.max(48, Math.floor(W / 6))
    if (!_fxYs || _fxYs.length !== n + 1) _fxYs = new Float64Array(n + 1)
    for (let j = 0; j <= n; j++) {
      const x = j / n
      const v = _bandAt(Math.abs(x - 0.5) * 2)
      const taper = 0.35 + 0.65 * Math.sin(Math.PI * x)
      _fxYs[j] = base - v * v * amp * taper
    }
    ctx.beginPath()
    ctx.moveTo(0, base)
    for (let k = 0; k < n; k++) {
      const x0 = k / n * W, x1 = (k + 1) / n * W
      ctx.quadraticCurveTo(x0, _fxYs[k], (x0 + x1) / 2, (_fxYs[k] + _fxYs[k + 1]) / 2)
    }
    ctx.lineTo(W, base)
    ctx.fillStyle = _fxFill   // built in _resizeFxCanvas (height + accent)
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = _fxStroke
    ctx.stroke()
  }

  // ─── Chaos Mode (Easter Egg) ──────────────────────────────────
  // A neon spectrum ring around the cover with a warp starfield, shooting
  // stars and bass shockwaves. Nothing is filled: the page stays visible.

  function _toggleChaosMode() {
    mp._chaosMode = !mp._chaosMode
    _resetChaos()
    if (mp._chaosMode) {
      // Lock out clicks for 3s so the user doesn't accidentally toggle it off
      _chaosLockedUntil = Date.now() + 3000
      // Force FX on if it wasn't already
      if (!mp._fxEnabled) {
        mp._fxEnabled = true
        _lsSet('mp_fx', '1')
        if (mp.fxBtn) mp.fxBtn.classList.add('mp-btn-active')
        if (mp.isVisible) _startFx()
      }
      if (mp.playerEl) mp.playerEl.classList.add('mp-fx-chaos')
      mp._upgradePlayerArt()  // the ring draws the cover large
      _chaosWaves = [{ r: 0, a: 0.8 }, { r: -40, a: 0.8 }, { r: -80, a: 0.8 }]  // activation burst
      // Resize canvas after CSS transition for new height
      setTimeout(() => { _resizeFxCanvas() }, 350)
      // Button celebration wiggle
      if (mp.fxBtn) {
        mp.fxBtn.classList.add('mp-btn-chaos-wiggle')
        setTimeout(() => { mp.fxBtn.classList.remove('mp-btn-chaos-wiggle') }, 600)
      }
    } else {
      if (mp.playerEl) mp.playerEl.classList.remove('mp-fx-chaos')
      setTimeout(() => { _resizeFxCanvas() }, 350)
    }
  }

  function _resetChaos() {
    _chaosStars = []
    _chaosWaves = []
    _chaosShooters = []
    _chaosSpin = 0
    _chaosPrevBass = 0
    _chaosLastT = 0
  }

  function _stopChaos() {
    mp._chaosMode = false
    _resetChaos()
    if (mp.playerEl) mp.playerEl.classList.remove('mp-fx-chaos')
  }

  function _rgba(c, a) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'
  }

  function _renderChaos(W, H, freqData, bufLen) {
    const ctx = mp._fxCtx
    const now = performance.now()
    const dt = _chaosLastT ? Math.min(0.05, (now - _chaosLastT) / 1000) : 0.016
    _chaosLastT = now
    const bands = _chaosBands(freqData, bufLen)
    const bass = bands.bass

    // Bass transient detection
    const bassDelta = bass - _chaosPrevBass
    const isBassHit = bassDelta > 0.12 && bass > 0.3
    const isHardBassHit = bassDelta > 0.2 && bass > 0.5
    _chaosPrevBass = bass

    const cx = W / 2
    const cy = H * 0.55
    const R = Math.max(44, Math.min(W, H) * 0.12) + bass * 14
    _chaosSpin += dt * (0.15 + bands.mid * 0.8)

    _chaosDrawStars(ctx, W, H, cx, cy, bass, bands.treble, dt)
    _chaosDrawShooters(ctx, W, H, isHardBassHit, dt)
    _chaosDrawWaves(ctx, cx, cy, R, bass, isBassHit, dt)
    _chaosDrawRing(ctx, cx, cy, R, H)
    _chaosDrawCover(ctx, cx, cy, R)
  }

  // Average energy (0-1) of the bass, mid and treble bands
  function _chaosBands(freqData, bufLen) {
    const sampleRate = mp._audioCtx ? mp._audioCtx.sampleRate : 48000
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
    return { bass: bass, mid: mid, treble: treble }
  }

  // Warp starfield flying out of the ring; bass sets the speed
  function _chaosDrawStars(ctx, W, H, cx, cy, bass, treble, dt) {
    if (!_chaosStars.length) {
      for (let i = 0; i < 240; i++) {
        _chaosStars.push({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random(), c: i % 7 === 0 ? _CHAOS_PINK : i % 5 === 0 ? _CHAOS_CYAN : null })
      }
    }
    const speed = 0.06 + bass * bass * 0.9
    const fov = Math.max(W, H) * 0.15
    const white = [255, 255, 255]
    for (const s of _chaosStars) {
      const z0 = s.z
      s.z -= speed * dt
      if (s.z <= 0.02) {
        s.x = Math.random() * 2 - 1
        s.y = Math.random() * 2 - 1
        s.z = 1
        continue
      }
      const b = Math.min(1, (1 - s.z) * 1.3)
      ctx.strokeStyle = _rgba(s.c || white, b * (0.5 + treble * 0.4))
      ctx.lineWidth = 0.5 + b * 1.4
      ctx.beginPath()
      ctx.moveTo(cx + s.x / z0 * fov, cy + s.y / z0 * fov)
      ctx.lineTo(cx + s.x / s.z * fov, cy + s.y / s.z * fov)
      ctx.stroke()
    }
  }

  // Occasional shooting stars across the upper sky, more on hard hits
  function _chaosDrawShooters(ctx, W, H, isHardBassHit, dt) {
    if (_chaosShooters.length < 3 && (isHardBassHit || Math.random() < dt * 0.25)) {
      _chaosShooters.push({ x: W * (0.3 + Math.random() * 0.8), y: H * (0.1 + Math.random() * 0.3), vx: -(400 + Math.random() * 300), vy: 150 + Math.random() * 100, life: 1 })
    }
    _chaosShooters = _chaosShooters.filter(s => {
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.life -= dt * 0.9
      if (s.life <= 0) return false
      const len = 120 / Math.hypot(s.vx, s.vy)
      const tx = s.x - s.vx * len
      const ty = s.y - s.vy * len
      const tail = ctx.createLinearGradient(s.x, s.y, tx, ty)
      tail.addColorStop(0, 'rgba(255,255,255,' + s.life + ')')
      tail.addColorStop(1, _rgba(_CHAOS_PINK, 0))
      ctx.strokeStyle = tail
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(tx, ty)
      ctx.stroke()
      return true
    })
  }

  // Thin shockwaves leaving the ring on each kick
  function _chaosDrawWaves(ctx, cx, cy, R, bass, isBassHit, dt) {
    if (isBassHit && _chaosWaves.length < 6) _chaosWaves.push({ r: 0, a: 0.5 })
    ctx.lineWidth = 1.5
    _chaosWaves = _chaosWaves.filter(w => {
      w.r += (140 + bass * 200) * dt
      w.a -= 0.7 * dt
      if (w.a <= 0) return false
      if (w.r > 0) {
        ctx.strokeStyle = _rgba(_CHAOS_CYAN, w.a)
        ctx.beginPath()
        ctx.arc(cx, cy, R + w.r, 0, Math.PI * 2)
        ctx.stroke()
      }
      return true
    })
  }

  function _chaosRingPath(ctx, cx, cy, radiusAt, n) {
    const pts = []
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 - Math.PI / 2
      const r = radiusAt(i < n / 2 ? i / (n / 2) : (n - i) / (n / 2))  // mirrored: bass on top
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
    ctx.beginPath()
    ctx.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2)
    for (let k = 0; k < n; k++) {
      const p = pts[k]
      const q = pts[(k + 1) % n]
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
    }
    ctx.closePath()
  }

  // Spectrum ring: neon outer line, cyan inner echo and a slow dashed orbit
  function _chaosDrawRing(ctx, cx, cy, R, H) {
    const len = Math.min(H * 0.18, 110)
    let stroke = _rgba(_CHAOS_PINK, 0.95)
    if (ctx.createConicGradient) {
      stroke = ctx.createConicGradient(_chaosSpin, cx, cy)
      stroke.addColorStop(0, _rgba(_CHAOS_PINK, 0.95))
      stroke.addColorStop(0.33, _rgba(_CHAOS_GOLD, 0.95))
      stroke.addColorStop(0.66, _rgba(_CHAOS_CYAN, 0.95))
      stroke.addColorStop(1, _rgba(_CHAOS_PINK, 0.95))
    }
    ctx.save()
    ctx.shadowColor = _rgba(_CHAOS_PINK, 0.8)
    ctx.shadowBlur = 12
    ctx.lineWidth = 2
    ctx.strokeStyle = stroke
    _chaosRingPath(ctx, cx, cy, f => { const v = _bandAt(f); return R + 4 + v * v * len }, 96)
    ctx.stroke()
    ctx.restore()

    ctx.lineWidth = 1
    ctx.strokeStyle = _rgba(_CHAOS_CYAN, 0.6)
    _chaosRingPath(ctx, cx, cy, f => R + 2 + _bandAt(f) * len * 0.35, 96)
    ctx.stroke()

    const orbit = R + len * 0.8
    ctx.save()
    ctx.setLineDash([2, 10])
    ctx.lineDashOffset = -_chaosSpin * 40
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.beginPath()
    ctx.arc(cx, cy, orbit, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
    const sa = _chaosSpin * 2
    ctx.fillStyle = _rgba(_CHAOS_GOLD, 0.9)
    ctx.beginPath()
    ctx.arc(cx + Math.cos(sa) * orbit, cy + Math.sin(sa) * orbit, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // The current cover inside the ring, or a hairline circle without one
  function _chaosDrawCover(ctx, cx, cy, R) {
    const img = mp.playerEl && mp.playerEl.querySelector('.music-player-art img')
    const r = R - 6
    if (img && img.complete && img.naturalWidth) {
      ctx.save()
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2)
      ctx.restore()
    } else {
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // The canvas follows the bar through the ResizeObserver (_startFx); the
  // loop stops while paused and core's 'playing' listener (_startFx) picks it up again.
  Object.assign(mp, {
    _toggleFx,
    _startFx,
    _stopFxLoop,
    _stopChaos,
  })
})(window._mpCore)
