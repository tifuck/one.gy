// ─── ONE.GY Music Player: Web Audio graph, visualizer and chaos mode ───
;(function(mp) {
  'use strict'

  const { _lsSet, audio, _setVolume } = mp

  // ─── Visualizer State ──────────────────────────────────────────
  let _analyser = null
  let _sourceNode = null
  let _fxRafId = null
  let _fxSmoothed = null  // smoothed bar heights for silky animation
  let _fxRgb = [55, 182, 255]  // bar colour, refreshed from --accent-rgb on resize

  // ─── Chaos Mode State ──────────────────────────────────────────
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

    if (mp._fxEnabled && mp.isVisible) {
      _startFx()
    } else {
      _stopFx()
    }
  }

  function _ensureAudioContext() {
    if (mp._audioCtx) return true
    try {
      mp._audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      _analyser = mp._audioCtx.createAnalyser()
      _analyser.fftSize = 2048
      _analyser.smoothingTimeConstant = 0.6
      _analyser.minDecibels = -85
      _analyser.maxDecibels = -20
      mp._gainNode = mp._audioCtx.createGain()
      mp._gainNode.gain.value = mp._desiredVolume
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
    if (mp._audioCtx && mp._audioCtx.state === 'suspended') {
      mp._audioCtx.resume().catch(function(err) {
        console.warn('[MUSIC PLAYER] AudioContext resume failed:', err)
      })
    }
  }

  function _connectSource() {
    if (mp._fxConnected) return
    if (!_ensureAudioContext()) return
    try {
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
      _resumeAudioContext()
    } catch (e) {
      console.warn('[MUSIC PLAYER] Failed to connect audio source:', e)
    }
  }

  function _startFx() {
    _connectSource()
    if (!mp._fxCanvas || !mp._fxCtx || !_analyser) return
    if (mp.playerEl) mp.playerEl.classList.add('mp-fx-active')

    // Wait a frame for CSS to apply (canvas needs height from .mp-fx-active)
    requestAnimationFrame(() => {
      _resizeFxCanvas()
      _fxSmoothed = null
      if (!_fxRafId) _fxLoop()
    })
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
    if (!mp._fxCanvas) return
    const rect = mp._fxCanvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    mp._fxCanvas.width = rect.width * dpr
    mp._fxCanvas.height = rect.height * dpr
    mp._fxCtx.scale(dpr, dpr)
    // Bars use the theme accent (--accent-rgb, e.g. "55,182,255")
    var rgb = getComputedStyle(mp._fxCanvas).getPropertyValue('--accent-rgb').split(',').map(Number)
    if (rgb.length === 3 && rgb.every(function(n) { return n >= 0 && n <= 255 })) _fxRgb = rgb
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
    if (!mp._fxEnabled || !_analyser || !mp._fxCtx || !mp._fxCanvas) return
    _fxRafId = requestAnimationFrame(_fxLoop)

    const bufLen = _analyser.frequencyBinCount   // 1024 bins (fftSize 2048)
    const data = new Uint8Array(bufLen)
    _analyser.getByteFrequencyData(data)

    const rect = mp._fxCanvas.getBoundingClientRect()
    const W = rect.width
    const H = rect.height
    mp._fxCtx.clearRect(0, 0, W, H)

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

      // Asymmetric smoothing: chaos mode has snappier attack for punchier bass
      const prev = _fxSmoothed[i]
      const attack = mp._chaosMode ? 0.6 : 0.45
      const decay  = mp._chaosMode ? 0.15 : 0.12
      _fxSmoothed[i] = clamped > prev
        ? prev + (clamped - prev) * attack
        : prev + (clamped - prev) * decay
    }

    // Draw bars with gradient and glow
    // In chaos mode the canvas is very tall; keep bars short at the bottom
    const barMaxH = mp._chaosMode ? Math.min(180, H * 0.22) : H * 0.98
    const barMinH = mp._chaosMode ? Math.min(4, H * 0.005) : H * 0.12
    const gap = 1.5
    const barW = (W - gap * (barCount - 1)) / barCount
    for (let i = 0; i < barCount; i++) {
      const val = _fxSmoothed[i]
      const barH = val > 0 ? Math.max(barMinH, val * barMaxH) : 2
      const x = i * (barW + gap)
      const y = H - barH

      // Color: theme accent, brighter with intensity
      const r = _fxRgb[0], g = _fxRgb[1], b = _fxRgb[2]
      const alpha = 0.55 + val * 0.45

      // Subtle glow on hot bars (skip in chaos mode for perf)
      if (!mp._chaosMode && val > 0.5) {
        mp._fxCtx.shadowColor = `rgba(${r}, ${g}, ${b}, ${(val - 0.5) * 0.6})`
        mp._fxCtx.shadowBlur = 6
      }

      // Gradient from bottom (bright) to top (dimmer)
      const grad = mp._fxCtx.createLinearGradient(x, H, x, y)
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`)
      grad.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${alpha * 0.7})`)
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${alpha * 0.3})`)
      mp._fxCtx.fillStyle = grad

      // Flat-top bar
      mp._fxCtx.fillRect(x, y, barW, barH)

      mp._fxCtx.shadowBlur = 0
    }

    // ── Chaos mode overlay (drawn on top of bars) ──
    if (mp._chaosMode) _renderChaos(W, H, data, bufLen)
  }

  // ─── Chaos Mode (Easter Egg) ──────────────────────────────────

  function _toggleChaosMode() {
    mp._chaosMode = !mp._chaosMode
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
      if (mp.fxBtn) {
        mp.fxBtn.classList.add('mp-btn-chaos-wiggle')
        setTimeout(() => { mp.fxBtn.classList.remove('mp-btn-chaos-wiggle') }, 600)
      }
    } else {
      if (mp.playerEl) mp.playerEl.classList.remove('mp-fx-chaos')
      _chaosParticles = []
      _chaosRings = []
      _chaosArcs = []
      _chaosFlash = 0
      setTimeout(() => { _resizeFxCanvas() }, 350)
    }
  }

  function _stopChaos() {
    mp._chaosMode = false
    _chaosParticles = []
    _chaosRings = []
    _chaosArcs = []
    _chaosFlash = 0
    if (mp.playerEl) mp.playerEl.classList.remove('mp-fx-chaos')
  }

  // HSL helper: convert hue (0-360), sat (0-100), light (0-100), alpha (0-1) to CSS
  function _hsla(h, s, l, a) {
    return 'hsla(' + (h % 360) + ',' + s + '%,' + l + '%,' + a + ')'
  }

  function _renderChaos(W, H, freqData, bufLen) {
    const ctx = mp._fxCtx
    const bands = _chaosBands(freqData, bufLen)
    const bass = bands.bass
    const mid = bands.mid
    const treble = bands.treble

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

    _chaosDrawGlow(ctx, W, H, bass)
    _chaosSpawnParticles(W, H, bass, energy, isBassHit, isHardBassHit)
    _chaosDrawParticles(ctx, W, H, bass, energy)
    _chaosDrawSparkles(ctx, W, H, treble)
    _chaosDrawVignette(ctx, W, H, bass)

    ctx.restore()
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

  function _chaosDrawGlow(ctx, W, H, bass) {
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
  }

  function _chaosSpawnParticles(W, H, bass, energy, isBassHit, isHardBassHit) {
    // ── Spawn particles from bar tops ──
    const barCount = 48
    const gap = 1.5
    const barW = (W - gap * (barCount - 1)) / barCount
    const spawnRate = isBassHit ? 14 : (2 + energy * 6)
    // Use the same bar height cap as the drawn bars so particles spawn from the visible tops
    const chaosBarMax = mp._chaosMode ? Math.min(180, H * 0.22) : H * 0.98
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
  }

  function _chaosDrawParticles(ctx, W, H, bass, energy) {
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
  }

  function _chaosDrawSparkles(ctx, W, H, treble) {
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
  }

  function _chaosDrawVignette(ctx, W, H, bass) {
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
  }

  // Re-trigger FX canvas measurement when window resizes
  window.addEventListener('resize', () => {
    if (mp._fxEnabled && mp._fxCanvas) _resizeFxCanvas()
  })

  Object.assign(mp, {
    _toggleFx,
    _ensureAudioContext,
    _resumeAudioContext,
    _startFx,
    _stopFxLoop,
    _stopChaos,
  })
})(window._mpCore)
