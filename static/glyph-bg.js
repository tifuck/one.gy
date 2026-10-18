/* ============================================================================
   glyph-bg.js — subtle "live rewrite" glyph field for the landing's lower
   sections. Mounts on any <canvas class="rd-lowbg-canvas">. A quiet grid of
   monospace glyphs that rewrite in place and drift right→left, drawn very
   faintly in the theme ink/accent so it reads as background texture behind
   the copy. Respects prefers-reduced-motion.
   ========================================================================== */
;(function () {
  'use strict'
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var GLY = '0123456789ABCDEF/\\<>=+*{}[]$#§?'
  var FS = 17, CW = FS * 0.62, CH = FS * 1.32
  var BASE_OPACITY = 0.06   // subtle by design — nudge here to taste

  function hsh () { var h = 2166136261 >>> 0; for (var i = 0; i < arguments.length; i++) { h ^= arguments[i] | 0; h = Math.imul(h, 16777619) >>> 0 } return h }

  function mount (canvas) {
    var ctx = canvas.getContext('2d')
    var dpr = Math.min(window.devicePixelRatio || 1, 2)
    var W = 0, H = 0
    function size () {
      var r = canvas.getBoundingClientRect()
      W = Math.max(1, r.width); H = Math.max(1, r.height)
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    size()
    window.addEventListener('resize', size, { passive: true })

    function colors () {
      var s = getComputedStyle(document.documentElement)
      return { ink: (s.getPropertyValue('--ink-rgb').trim() || '15,23,32'),
               accent: (s.getPropertyValue('--accent-rgb').trim() || '14,143,214') }
    }

    function draw (t) {
      var c = colors()
      ctx.clearRect(0, 0, W, H)
      ctx.font = '700 ' + FS + 'px "JetBrains Mono",ui-monospace,monospace'
      ctx.textBaseline = 'top'
      var shift = t * 9, first = Math.floor(shift / CW), frac = shift % CW
      var cols = Math.ceil(W / CW) + 2, rows = Math.ceil(H / CH) + 1
      for (var r = 0; r < rows; r++) {
        for (var i = 0; i < cols; i++) {
          var ac = first + i, ph = (hsh(r, ac) % 1000) / 1000
          var g = GLY[hsh(r, ac, Math.floor(t * 4 + ph * 12)) % GLY.length]
          var hi = (hsh(r, ac) % 44 === 0)          // sparse accent flecks
          var a = BASE_OPACITY * (hi ? 1.7 : 1) * (0.42 + 0.58 * Math.sin(t * 2.2 + ph * 6.283))
          if (a <= 0.002) continue
          ctx.fillStyle = 'rgba(' + (hi ? c.accent : c.ink) + ',' + a.toFixed(3) + ')'
          ctx.fillText(g, i * CW - frac, r * CH)
        }
      }
    }

    if (reduced) { draw(0); return }
    function frame (ts) { draw(ts / 1000); requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
  }

  function init () { document.querySelectorAll('.rd-lowbg-canvas').forEach(mount) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
