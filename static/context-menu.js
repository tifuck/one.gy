/* ============================================================================
   context-menu.js — shared right-click context menu for the logged-in app.
   One styled menu, reused everywhere (Files cards, sidebar, empty space, …).

   window.RdMenu.open(x, y, items)
     items: array of
       { label, icon?, action?, danger?, disabled?, hint? }   // a row
       { sep: true }                                           // divider
       { header: 'TEXT' }                                      // section label
       { swatches: [{ color, label, active? }], onPick }       // colour picker row
   `icon` is the inner markup of a 24x24 stroke SVG (paths only).
   A swatch with a falsy `color` renders as the "clear colour" chip and calls
   onPick(null).
   window.RdMenu.close()
   ========================================================================== */
(function () {
  'use strict'
  var menu = null
  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }

  function ensure () {
    if (menu) return menu
    menu = document.createElement('div')
    menu.className = 'rd-cmenu'
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    document.addEventListener('mousedown', function (e) { if (!e.target.closest('.rd-cmenu')) close() }, true)
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close() })
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    document.addEventListener('scroll', close, true)
    return menu
  }

  function open (x, y, items) {
    var m = ensure()
    var acts = []
    var swatchSets = []
    m.innerHTML = (items || []).map(function (it) {
      if (it.sep) return '<div class="rd-cmenu-sep"></div>'
      if (it.header) return '<div class="rd-cmenu-header">' + esc(it.header) + '</div>'
      if (it.swatches) {
        var gi = swatchSets.length
        swatchSets.push(it)
        return '<div class="rd-cmenu-swatches" data-sw-group="' + gi + '">' + it.swatches.map(function (sw, si) {
          var lbl = esc(sw.label || '')
          return '<button type="button" class="rd-cmenu-sw' + (sw.color ? '' : ' is-none') + (sw.active ? ' is-active' : '') + '"' +
            ' data-sw="' + si + '" title="' + lbl + '" aria-label="' + lbl + '"' +
            (sw.color ? ' style="background:' + esc(sw.color) + '"' : '') + '></button>'
        }).join('') + '</div>'
      }
      acts.push(it)
      var ico = it.icon
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + it.icon + '</svg>'
        : '<span class="rd-cmenu-ico"></span>'
      return '<button class="rd-cmenu-item' + (it.danger ? ' rd-cmenu-danger' : '') + '"' + (it.disabled ? ' disabled' : '') + '>' +
        ico + '<span class="rd-cmenu-label">' + esc(it.label) + '</span>' +
        (it.hint ? '<span class="rd-cmenu-hint">' + esc(it.hint) + '</span>' : '') + '</button>'
    }).join('')
    Array.prototype.forEach.call(m.querySelectorAll('.rd-cmenu-item'), function (b, i) {
      b.addEventListener('click', function () { if (b.disabled) return; close(); if (acts[i] && acts[i].action) acts[i].action() })
    })
    Array.prototype.forEach.call(m.querySelectorAll('.rd-cmenu-swatches'), function (row) {
      var grp = swatchSets[parseInt(row.getAttribute('data-sw-group'), 10)]
      if (!grp) return
      row.addEventListener('click', function (e) {
        var b = e.target.closest('.rd-cmenu-sw'); if (!b) return
        var sw = grp.swatches[parseInt(b.getAttribute('data-sw'), 10)]
        close()
        if (grp.onPick) grp.onPick(sw && sw.color ? sw.color : null)
      })
    })
    // Show off-screen to measure, then place with edge-flip.
    m.style.left = '-9999px'; m.style.top = '-9999px'
    m.classList.add('is-open')
    var mw = m.offsetWidth, mh = m.offsetHeight
    var px = (x + mw + 8 > window.innerWidth) ? Math.max(8, x - mw) : x
    var py = (y + mh + 8 > window.innerHeight) ? Math.max(8, window.innerHeight - mh - 8) : y
    m.style.left = Math.max(8, px) + 'px'
    m.style.top = Math.max(8, py) + 'px'
  }
  function close () { if (menu) menu.classList.remove('is-open') }

  window.RdMenu = { open: open, close: close }
})()
