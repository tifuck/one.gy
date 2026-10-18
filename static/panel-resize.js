/* ============================================================================
   panel-resize.js — drag-to-resize + collapse for the app rails.

   Drives three panes through two CSS custom properties on <html>:
     --rd-side-w   the library rail   (Files tree · Notes rail · Music library)
     --rd-list-w   the Notes "all notes" list pane

   Because the library rail on all three pages reads the SAME variable, the
   pages cannot drift out of sync — there is one stored width, not three.

   State lives entirely on <html> (custom props + data-rd-side / data-rd-list)
   rather than on the rail elements, because notes.js rebuilds #ntRail.innerHTML
   on every render and would otherwise wipe per-element classes. All listeners
   are delegated on document for the same reason.

   Restored before first paint by the inline snippet in _app_base.html.
   ========================================================================== */
;(function () {
  'use strict'

  /* Defaults are viewport-proportional — see the long comment in app-shell.css.
     Keep these numbers in sync with the :root block there AND with the
     pre-paint snippet in _app_base.html. */
  function prop (frac, lo, hi) {
    return Math.round(Math.max(lo, Math.min(hi, window.innerWidth * frac)))
  }

  var SIDE = {
    key: 'side',
    cssVar: '--rd-side-w',
    lsWidth: 'onegy_rd_side_w',
    lsCollapsed: 'onegy_rd_side_collapsed',
    def: function () { return prop(0.17, 280, 460) },
    min: 150, max: 560
  }
  var LIST = {
    key: 'list',
    cssVar: '--rd-list-w',
    lsWidth: 'onegy_rd_list_w',
    lsCollapsed: 'onegy_rd_list_collapsed',
    def: function () { return prop(0.19, 320, 520) },
    min: 200, max: 620
  }
  var PANES = { side: SIDE, list: LIST }

  var COLLAPSED_W = 44
  var SNAP = 110          // drag narrower than this -> snap collapsed
  var MIN_CONTENT = 340   // px the main content area must always keep
  var STEP = 16, STEP_BIG = 48

  var root = document.documentElement
  var drag = null
  var rafId = 0

  /* ---- storage ---------------------------------------------------------- */

  function readNum (key, fallback) {
    try {
      var v = parseInt(localStorage.getItem(key), 10)
      return isFinite(v) && v > 0 ? v : fallback
    } catch (e) { return fallback }
  }
  function writeNum (key, v) {
    try { localStorage.setItem(key, String(Math.round(v))) } catch (e) {}
  }
  function writeFlag (key, on) {
    try { localStorage.setItem(key, on ? '1' : '0') } catch (e) {}
  }

  /* ---- which panes exist on this page ----------------------------------- */

  function shell () {
    return document.querySelector('.fx-shell, .nt-shell, .mu-shell')
  }
  function hasPane (key) {
    if (key === 'list') return !!document.querySelector('.nt-shell')
    return !!shell()
  }
  /* Resizing is desktop-only; each page drops to a drawer at its own width.
     Ask the DOM rather than hardcoding breakpoints so CSS stays the source
     of truth (a hidden handle means "not resizable right now"). */
  function resizable (key) {
    var h = document.querySelector('.rd-resizer[data-rd-resize="' + key + '"]')
    return !!(h && h.offsetParent !== null)
  }

  function isCollapsed (key) {
    return root.getAttribute('data-rd-' + key) === 'collapsed'
  }

  function widthOf (key) {
    if (isCollapsed(key)) return COLLAPSED_W
    var p = PANES[key]
    var v = parseInt(root.style.getPropertyValue(p.cssVar), 10)
    if (!isFinite(v) || v <= 0) {
      v = parseInt(getComputedStyle(root).getPropertyValue(p.cssVar), 10)
    }
    return isFinite(v) && v > 0 ? v : p.def()
  }

  /* Width consumed by the other pane, so the two Notes panes can't gang up
     and squeeze the editor out of existence. */
  function siblingW (key) {
    var other = key === 'side' ? 'list' : 'side'
    if (!hasPane(other)) return 0
    // A rail in drawer mode is out of flow and costs no horizontal space.
    if (other === 'side' && !resizable('side') && hasPane('list')) return 0
    return widthOf(other)
  }

  function maxFor (key) {
    var p = PANES[key]
    var room = window.innerWidth - MIN_CONTENT - siblingW(key)
    return Math.max(p.min, Math.min(p.max, room))
  }

  function clamp (key, w) {
    return Math.max(PANES[key].min, Math.min(maxFor(key), Math.round(w)))
  }

  /* ---- apply ------------------------------------------------------------ */

  function applyWidth (key, w, persist) {
    root.style.setProperty(PANES[key].cssVar, w + 'px')
    if (persist) writeNum(PANES[key].lsWidth, w)
    syncHandle(key, w)
  }

  function syncHandle (key, w) {
    var h = document.querySelector('.rd-resizer[data-rd-resize="' + key + '"]')
    if (!h) return
    h.setAttribute('aria-valuenow', String(w))
    h.setAttribute('aria-valuemin', String(PANES[key].min))
    h.setAttribute('aria-valuemax', String(maxFor(key)))
  }

  function setCollapsed (key, on, persist) {
    if (on) root.setAttribute('data-rd-' + key, 'collapsed')
    else root.removeAttribute('data-rd-' + key)
    if (persist) writeFlag(PANES[key].lsCollapsed, on)
    reclamp()
  }

  function toggle (key) {
    if (!resizable(key)) return
    setCollapsed(key, !isCollapsed(key), true)
  }

  /* Re-clamp stored preferences against the current viewport. The preferred
     width always comes from storage, so a pane squeezed by a narrow window
     springs back to the user's choice when the space returns. Two passes so
     the two Notes panes settle against each other. */
  function reclamp () {
    if (drag) return
    for (var pass = 0; pass < 2; pass++) {
      for (var key in PANES) {
        if (!PANES.hasOwnProperty(key) || !hasPane(key)) continue
        applyWidth(key, clamp(key, readNum(PANES[key].lsWidth, PANES[key].def())), false)
      }
    }
  }

  function restore () {
    for (var key in PANES) {
      if (!PANES.hasOwnProperty(key) || !hasPane(key)) continue
      var p = PANES[key]
      applyWidth(key, clamp(key, readNum(p.lsWidth, p.def())), false)
    }
    reclamp()
  }

  /* ---- drag ------------------------------------------------------------- */

  function flush () {
    rafId = 0
    if (!drag) return
    var key = drag.key
    var raw = drag.startW + (drag.lastX - drag.startX)

    if (raw < SNAP) {
      // Snap shut, leaving the stored width alone so expanding restores it.
      if (!isCollapsed(key)) root.setAttribute('data-rd-' + key, 'collapsed')
    } else {
      if (isCollapsed(key)) root.removeAttribute('data-rd-' + key)
      applyWidth(key, clamp(key, raw), false)
    }
  }

  function onDown (e) {
    var h = e.target.closest && e.target.closest('.rd-resizer')
    if (!h) return
    var key = h.getAttribute('data-rd-resize')
    if (!PANES[key] || !resizable(key)) return
    if (e.pointerType === 'mouse' && e.button !== 0) return

    e.preventDefault()
    drag = {
      key: key,
      handle: h,
      startX: e.clientX,
      lastX: e.clientX,
      startW: isCollapsed(key) ? COLLAPSED_W : widthOf(key),
      pointerId: e.pointerId
    }
    try { h.setPointerCapture(e.pointerId) } catch (err) {}
    try { h.focus({ preventScroll: true }) } catch (err) {}
    h.classList.add('is-drag')
    root.classList.add('rd-resizing')
  }

  function onMove (e) {
    if (!drag || e.pointerId !== drag.pointerId) return
    drag.lastX = e.clientX
    if (!rafId) rafId = requestAnimationFrame(flush)
  }

  function onUp () {
    if (!drag) return
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
    flush()

    var key = drag.key
    try { drag.handle.releasePointerCapture(drag.pointerId) } catch (err) {}
    drag.handle.classList.remove('is-drag')
    root.classList.remove('rd-resizing')

    var collapsed = isCollapsed(key)
    writeFlag(PANES[key].lsCollapsed, collapsed)
    if (!collapsed) writeNum(PANES[key].lsWidth, widthOf(key))

    drag = null
    reclamp()
  }

  /* ---- keyboard --------------------------------------------------------- */

  function onKey (e) {
    var h = e.target
    if (!h || !h.classList || !h.classList.contains('rd-resizer')) return
    var key = h.getAttribute('data-rd-resize')
    if (!PANES[key] || !resizable(key)) return

    var step = e.shiftKey ? STEP_BIG : STEP
    var handled = true

    switch (e.key) {
      case 'ArrowLeft':
        if (isCollapsed(key)) break
        if (widthOf(key) - step < PANES[key].min) setCollapsed(key, true, true)
        else applyWidth(key, clamp(key, widthOf(key) - step), true)
        break
      case 'ArrowRight':
        if (isCollapsed(key)) { setCollapsed(key, false, true); break }
        applyWidth(key, clamp(key, widthOf(key) + step), true)
        break
      case 'Home':
        setCollapsed(key, false, true); applyWidth(key, PANES[key].min, true); break
      case 'End':
        setCollapsed(key, false, true); applyWidth(key, maxFor(key), true); break
      case 'Enter': case ' ':
        toggle(key); break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }

  /* ---- clicks ----------------------------------------------------------- */

  function onClick (e) {
    if (!e.target.closest) return
    if (e.target.closest('.rd-resizer')) return   // dblclick handles this

    var label = e.target.closest('.rd-rail-label')
    if (label) {
      e.preventDefault()
      setCollapsed(label.getAttribute('data-rd-label'), false, true)
      return
    }
    var btn = e.target.closest('[data-rd-collapse]')
    if (btn) {
      e.preventDefault()
      toggle(btn.getAttribute('data-rd-collapse'))
    }
  }

  function onDbl (e) {
    var h = e.target.closest && e.target.closest('.rd-resizer')
    if (!h) return
    e.preventDefault()
    toggle(h.getAttribute('data-rd-resize'))
  }

  /* ---- viewport --------------------------------------------------------- */

  var rt = 0
  function onResize () {
    if (rt) clearTimeout(rt)
    rt = setTimeout(function () { rt = 0; reclamp() }, 80)
  }

  /* ---- wiring ----------------------------------------------------------- */

  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('pointercancel', onUp, true)
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('dblclick', onDbl, true)
  window.addEventListener('resize', onResize)
  window.addEventListener('orientationchange', onResize)
  window.addEventListener('blur', function () { if (drag) onUp() })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore)
  } else {
    restore()
  }

  window.RdPanels = {
    restore: restore, reclamp: reclamp,
    toggle: toggle, isCollapsed: isCollapsed, width: widthOf
  }
})()
