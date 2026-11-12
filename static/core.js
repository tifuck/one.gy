/* ============================================================================
   ONE.GY REDESIGN — core.js
   Shared behavior for every concept: nav, reveal-on-scroll, stat count-up,
   modal controller. Token/theme-agnostic. Respects prefers-reduced-motion.
   ========================================================================== */
;(function () {
  'use strict'
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---- Nav: scrolled state + mobile drawer -------------------------------
  function initNav () {
    var nav = document.querySelector('.rd-nav')
    var root = document.documentElement
    var toggle = document.querySelector('.rd-nav-toggle')
    if (nav) {
      var scroller = document.querySelector('.rd-scroll')
      var onScroll = function () { nav.classList.toggle('rd-scrolled', window.scrollY > 12 || (!!scroller && scroller.scrollTop > 12)) }
      window.addEventListener('scroll', onScroll, { passive: true })
      if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true })
      // Keys scroll the focused element's scroller: with nothing focused, hand
      // scroll keys to the page scroller (Tab still starts at the nav).
      if (scroller && getComputedStyle(scroller).overflowY === 'auto') {
        scroller.tabIndex = -1
        var scrollKeys = [' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End']
        document.addEventListener('keydown', function (e) {
          if (document.activeElement === document.body && scrollKeys.indexOf(e.key) >= 0) scroller.focus({ preventScroll: true })
        }, true)
      }
      onScroll()
    }
    if (toggle) {
      toggle.addEventListener('click', function (e) {
        e.stopPropagation()
        root.classList.toggle('rd-nav-open')
        toggle.setAttribute('aria-expanded', root.classList.contains('rd-nav-open') ? 'true' : 'false')
      })
      document.addEventListener('click', function (e) {
        if (!root.classList.contains('rd-nav-open')) return
        var drawer = document.querySelector('.rd-nav-drawer')
        if (drawer && !drawer.contains(e.target) && !toggle.contains(e.target)) {
          root.classList.remove('rd-nav-open')
          toggle.setAttribute('aria-expanded', 'false')
        }
      })
    }

    function closeMenus (except) {
      document.querySelectorAll('.rd-menu.is-open').forEach(function (m) {
        if (m === except) return
        m.classList.remove('is-open')
        var b = m.querySelector('[data-menu-btn]')
        if (b) b.setAttribute('aria-expanded', 'false')
      })
    }
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-menu-btn]')
      if (btn) {
        var m = btn.closest('.rd-menu')
        var open = m.classList.contains('is-open')
        closeMenus(m)
        if (!open) { m.classList.add('is-open'); btn.setAttribute('aria-expanded', 'true') }
        else { m.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false') }
        return
      }
      if (!e.target.closest('.rd-menu-pop')) closeMenus(null)
    })
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return
      closeMenus(null)
      root.classList.remove('rd-nav-open')
      if (toggle) toggle.setAttribute('aria-expanded', 'false')
    })

    var nb = document.getElementById('notesNavBadge')
    if (nb && window.fetch) {
      fetch('/notes/api/unread-count', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then(function (r) { return r.json() })
        .then(function (d) {
          // Pending (not yet accepted) notes have no accept/reject UI to clear them.
          var n = d.unread || 0
          if (n > 0) { nb.textContent = n; nb.hidden = false }
        })
        .catch(function () {})
    }
  }

  // ---- Admin notification banners (overlay the shared nav on every page) --
  function initNotifs () {
    var host = document.getElementById('rdNotifBanners')
    if (!host || !window.fetch) return

    var SS_KEY = 'onegy_notif_dismissed_session'
    var LS_KEY = 'onegy_notif_dismissed_always'

    function readIds (storage, key) {
      try {
        var v = JSON.parse(storage.getItem(key) || '[]')
        return Array.isArray(v) ? v : []
      } catch (e) { return [] }
    }
    function addId (storage, key, id) {
      var ids = readIds(storage, key)
      if (ids.indexOf(id) < 0) {
        ids.push(id)
        try { storage.setItem(key, JSON.stringify(ids)) } catch (e) {}
      }
    }
    function rememberDismiss (n) {
      if (!n || n.id == null) return
      if ((n.display_trigger || 'always') === 'always') addId(localStorage, LS_KEY, n.id)
      else addId(sessionStorage, SS_KEY, n.id)
    }

    function esc (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      })
    }
    function safeColor (v) {
      return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '')) ? String(v) : ''
    }
    function fgFor (hex) {
      var h = hex.slice(1)
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2)
      var lin = [0, 2, 4].map(function (i) {
        var v = parseInt(h.slice(i, i + 2), 16) / 255
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      })
      return (0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]) > 0.45 ? '#101010' : '#ffffff'
    }
    function csrfToken () {
      var m = document.querySelector('meta[name="csrf-token"]')
      return m ? m.getAttribute('content') : ''
    }
    function drop (bar) {
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar)
    }

    function render (list) {
      var sessionDismissed = readIds(sessionStorage, SS_KEY)
      var alwaysDismissed = readIds(localStorage, LS_KEY)
      list.forEach(function (n) {
        if (!n || n.id == null || !n.message) return
        var trigger = n.display_trigger || 'always'
        if (trigger === 'always' && alwaysDismissed.indexOf(n.id) >= 0) return
        if (trigger !== 'always' && sessionDismissed.indexOf(n.id) >= 0) return
        var bar = document.createElement('div')
        bar.className = 'rd-notif'
        var bg = safeColor(n.bg_color)
        if (bg) { bar.style.background = bg; bar.style.color = fgFor(bg) }
        bar.innerHTML = '<div class="rd-notif-inner">' +
          '<div class="rd-notif-copy">' +
            '<p class="rd-notif-msg">' + esc(n.message) + '</p>' +
          '</div>' +
          '<button class="rd-notif-x" type="button" aria-label="Dismiss notification">&times;</button>' +
        '</div>'
        bar.querySelector('.rd-notif-x').addEventListener('click', function () {
          rememberDismiss(n)
          drop(bar)
          fetch('/api/notifications/' + encodeURIComponent(n.id) + '/dismiss', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrfToken() }
          }).catch(function () {})
        })
        host.appendChild(bar)
        fitCopy(bar.querySelector('.rd-notif-copy'))
        var secs = parseInt(n.dismiss_seconds, 10)
        if (n.auto_dismiss && isFinite(secs) && secs > 0) setTimeout(function () { drop(bar) }, secs * 1000)
      })
    }

    function fitCopy (copy) {
      if (!copy) return
      var max = 15, min = 10, fs = max
      copy.style.setProperty('--rd-notif-fs', fs + 'px')
      while (fs > min && (copy.scrollWidth > copy.parentNode.clientWidth || copy.scrollHeight > copy.parentNode.clientHeight)) {
        fs -= 0.5
        copy.style.setProperty('--rd-notif-fs', fs + 'px')
      }
    }
    function fitAll () {
      host.querySelectorAll('.rd-notif-copy').forEach(fitCopy)
    }
    window.addEventListener('resize', fitAll)

    fetch('/api/notifications/active', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.ok ? r.json() : [] })
      .then(function (d) { if (Array.isArray(d) && d.length) render(d) })
      .catch(function () {})
  }

  // ---- Reveal on scroll --------------------------------------------------
  function initReveal () {
    var els = document.querySelectorAll('.rd-reveal')
    if (!els.length) return
    if (reduced || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('rd-in') })
      return
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('rd-in'); io.unobserve(entry.target) }
      })
    }, { threshold: 0.14, rootMargin: '0px 0px -48px 0px' })
    els.forEach(function (el) { io.observe(el) })
  }

  // ---- Stat count-up -----------------------------------------------------
  function initCountUp () {
    var nums = document.querySelectorAll('.rd-count')
    if (!nums.length || reduced || !('IntersectionObserver' in window)) return
    function animate (el) {
      var finalText = el.getAttribute('data-final') || el.textContent
      var m = finalText.match(/([\d.,]+)/)
      if (!m) return
      var clean = m[1].replace(/,/g, '')
      var target = parseFloat(clean)
      if (!isFinite(target) || target <= 0) return
      var decimals = (clean.split('.')[1] || '').length
      var thousands = m[1].indexOf(',') !== -1
      var DUR = 1400, start = null
      function fmt (v) {
        var s = v.toFixed(decimals)
        if (thousands) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        return s
      }
      function tick (ts) {
        if (start === null) start = ts
        var p = Math.min((ts - start) / DUR, 1)
        var eased = 1 - Math.pow(1 - p, 3)
        if (p < 1) { el.textContent = finalText.replace(m[1], fmt(target * eased)); requestAnimationFrame(tick) }
        else { el.textContent = finalText }
      }
      el.textContent = finalText.replace(m[1], fmt(0))
      requestAnimationFrame(tick)
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { animate(entry.target); io.unobserve(entry.target) }
      })
    }, { threshold: 0.5 })
    nums.forEach(function (el) { io.observe(el) })
  }

  // ---- Modal controller --------------------------------------------------
  // Open:  <button data-rd-modal-open="MODAL_ID">
  // Close: any element inside with data-rd-modal-close, the overlay, or Esc.
  function initModals () {
    var lastFocus = null
    function open (id) {
      var modal = document.getElementById(id)
      if (!modal) return
      lastFocus = document.activeElement
      modal.classList.add('rd-open')
      modal.setAttribute('aria-hidden', 'false')
      var focusable = modal.querySelector('[autofocus], button, a[href], input, .rd-modal-close')
      if (focusable) focusable.focus()
      document.documentElement.style.overflow = 'hidden'
    }
    function close (modal) {
      if (!modal) return
      modal.classList.remove('rd-open')
      modal.setAttribute('aria-hidden', 'true')
      document.documentElement.style.overflow = ''
      if (lastFocus && lastFocus.focus) lastFocus.focus()
    }
    document.addEventListener('click', function (e) {
      var opener = e.target.closest('[data-rd-modal-open]')
      if (opener) { e.preventDefault(); open(opener.getAttribute('data-rd-modal-open')); return }
      if (e.target.closest('[data-rd-modal-close]') || e.target.classList.contains('rd-modal-overlay')) {
        close(e.target.closest('.rd-modal'))
      }
    })
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return
      var open = document.querySelector('.rd-modal.rd-open')
      if (open) close(open)
    })
    // Focus trap
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return
      var modal = document.querySelector('.rd-modal.rd-open')
      if (!modal) return
      var f = modal.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])')
      if (!f.length) return
      var first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    })
  }

  // ---- Marquee: seamless on ANY screen width -----------------------------
  // The CSS fallback shifts by -50% across two groups, which only loops
  // cleanly when one group is wider than the viewport. On wide screens that
  // leaves a gap. Here we measure one group, clone it until the track fills
  // the viewport plus one group, then shift by exactly one group width — so
  // after each cycle the content is identical (seamless) at any size.
  function initMarquee () {
    var marquees = document.querySelectorAll('.rd-marquee')
    if (!marquees.length) return
    var SPEED = 55 // px per second — constant visual speed regardless of width

    function build (m) {
      var track = m.querySelector('.rd-marquee-track')
      if (!track) return
      var groups = track.querySelectorAll('.rd-marquee-group')
      if (!groups.length) return
      // Reset to a single reference group, then (re)build.
      for (var i = groups.length - 1; i >= 1; i--) groups[i].remove()
      track.classList.remove('rd-marquee-js')
      track.style.animationDuration = ''
      if (reduced) { track.style.animation = 'none'; return }

      var base = track.querySelector('.rd-marquee-group')
      var unit = base.getBoundingClientRect().width
      if (!unit) return
      // Fill the viewport plus one unit (so the viewport is always covered as
      // the leading unit scrolls out), and never fewer than two copies.
      var need = m.getBoundingClientRect().width + unit
      var total = unit, copies = 1
      while (total < need || copies < 2) {
        track.appendChild(base.cloneNode(true))
        total += unit
        copies++
      }
      track.style.setProperty('--rd-marquee-shift', unit + 'px')
      track.style.animationDuration = (unit / SPEED) + 's'
      track.classList.add('rd-marquee-js')
    }

    function buildAll () { marquees.forEach(build) }
    buildAll()
    // Fonts change measured widths — rebuild once they're ready.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildAll)
    var t
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(buildAll, 200) }, { passive: true })
  }

  // ---- New UI build: reload into it at a safe moment ---------------------
  // <meta name="onegy-build"> is the build this page came from; GET /api/build
  // the server's. A new build seen twice a minute apart (a promote that rolls
  // back does not count) is applied at once when the page is hidden or idle
  // and nothing is in progress; else a toast offers it and it waits. A breaking
  // build (old pages break on the new API) reloads once nothing is in
  // progress, even while someone looks. Pages poll at their own phase, so
  // their reloads spread over CHECK_MS by themselves. A build the server has
  // run for STABLE_S is past any rollback and needs no second look, so a page
  // someone comes back to (a phone resuming a frozen tab) reloads at once.
  // The reload keeps the place: scroll positions and what pages add on
  // 'onegy:update' come back as OneGyUpdate.resume.
  var Update = (function () {
    var CHECK_MS = 10 * 60 * 1000, MIN_GAP_MS = 60 * 1000, CONFIRM_MS = 75 * 1000, STABLE_S = 300
    var IDLE_MS = 5 * 60 * 1000, TICK_MS = 30 * 1000, TYPED_MS = 30 * 60 * 1000, BACK_MS = 5000
    var RESUME_KEY = 'onegy_update_resume', RESUME_MS = 60 * 1000, SCROLL_TRIES = 50
    var TEXT = 'textarea, input:not([type=search]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color])'
    var meta = document.querySelector('meta[name="onegy-build"]')
    var nativeFetch = window.fetch
    var lastCheck = 0, lastInput = Date.now(), seen = null, ready = null, toast = null, tick = null, net = 0
    var typed = null, typedAt = 0, back = 0

    // What the page before an update reload left for this one (same URL, just now).
    var resume = null
    try {
      resume = JSON.parse(sessionStorage.getItem(RESUME_KEY))
      sessionStorage.removeItem(RESUME_KEY)
    } catch (e) {}
    if (!resume || resume.at !== location.pathname + location.search || Date.now() - resume.t > RESUME_MS) resume = null

    function keepPlace () {
      var keep = { at: location.pathname + location.search, t: Date.now(), scroll: {} }
      ;[].forEach.call(document.querySelectorAll('[id]'), function (el) { if (el.scrollTop > 0) keep.scroll[el.id] = el.scrollTop })
      if (window.scrollY > 0) keep.scroll[''] = window.scrollY
      window.dispatchEvent(new CustomEvent('onegy:update', { detail: keep }))
      try { sessionStorage.setItem(RESUME_KEY, JSON.stringify(keep)) } catch (e) {}
    }

    // Lists render after their data arrives: keep trying until each position
    // holds, the tries run out or someone scrolls.
    function restoreScroll (map) {
      var tries = 0, events = ['wheel', 'touchstart', 'keydown', 'pointerdown']
      var stop = function () {
        clearInterval(timer)
        events.forEach(function (t) { document.removeEventListener(t, stop, true) })
      }
      var timer = setInterval(function () {
        Object.keys(map).forEach(function (id) {
          var el = id ? document.getElementById(id) : document.scrollingElement
          if (!el) return
          el.scrollTop = map[id]
          if (Math.abs(el.scrollTop - map[id]) <= 1) delete map[id]
        })
        if (!Object.keys(map).length || ++tries >= SCROLL_TRIES) stop()
      }, 100)
      events.forEach(function (t) { document.addEventListener(t, stop, { capture: true, passive: true }) })
    }

    // Network work in flight: uploads (XHR) and fetches until their body is read.
    function hold (p) {
      net++
      var done = function () { net-- }
      p.then(done, done)
      return p
    }
    if (window.XMLHttpRequest) {
      var send = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.send = function () {
        var open = true
        var end = function () { if (open) { open = false; net-- } }
        net++
        this.addEventListener('loadend', end, { once: true })
        try { return send.apply(this, arguments) } catch (e) { end(); throw e }
      }
    }
    if (nativeFetch) {
      window.fetch = function () {
        return hold(nativeFetch.apply(window, arguments)).then(function (r) {
          ['arrayBuffer', 'blob', 'json', 'text', 'formData'].forEach(function (m) {
            var read = r[m]
            if (read) r[m] = function () { return hold(read.apply(r, arguments)) }
          })
          return r
        })
      }
    }

    // The field someone typed in last (a script filling a field in is not typing).
    document.addEventListener('input', function (e) {
      if (e.isTrusted && e.target.matches && e.target.matches(TEXT)) { typed = e.target; typedAt = Date.now() }
    }, true)
    function shown (el) {
      return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0
    }

    // What must never be reloaded under its user is marked data-update-hold
    // while it is on screen (the "Preparing download" page, a key shown once,
    // a page that answered a form post).
    function busy () {
      if (net > 0 || [].some.call(document.querySelectorAll('[data-update-hold]'), shown)) return true
      if (window.OneGyCrypto && OneGyCrypto.busy && OneGyCrypto.busy()) return true
      // Every page's unsaved-work and upload guard is a cancelling beforeunload listener.
      var ev = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(ev)
      if (ev.defaultPrevented) return true
      if ([].some.call(document.querySelectorAll('audio, video'), function (m) { return !m.paused })) return true
      // Text typed a short while ago and still on screen: a form not sent yet.
      return !!typed && Date.now() - typedAt < TYPED_MS && !!typed.value && typed.isConnected && shown(typed)
    }

    function fetchBuild () {
      return nativeFetch('/api/build', { cache: 'no-store', credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null })
        .catch(function () { return null })
    }

    // Never into a server that does not answer (mid-promote: the tab would sit
    // on an error page); back on this page's build (a rollback) there is nothing to do.
    function reload () {
      fetchBuild().then(function (d) {
        if (!d || !d.build) return
        if (d.build !== meta.content) { keepPlace(); location.reload(); return }
        clearInterval(tick)
        if (toast) toast.remove()
        ready = seen = toast = null
      })
    }

    function showNotice () {
      if (toast && toast.isConnected) return
      var host = document.getElementById('toastContainer')
      if (!host) return
      toast = document.createElement('div')
      toast.className = 'toast-message toast-info'
      toast.setAttribute('role', 'status')
      toast.textContent = ready.breaking ? 'ONE.GY was updated and reloads in a moment' : 'ONE.GY was updated'
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'rd-btn rd-btn-ghost rd-btn-sm'
      btn.textContent = 'Reload'
      btn.addEventListener('click', function () { keepPlace(); location.reload() })
      toast.appendChild(btn)
      host.appendChild(toast)
    }

    function apply () {
      if (!ready) return
      var now = Date.now(), returning = now - back < BACK_MS
      var idle = document.hidden || now - lastInput >= IDLE_MS || returning
      // A breaking build waits one tick with its notice up.
      if ((idle || (ready.breaking && toast)) && !busy()) { reload(); return }
      // The page's own refresh on coming back is still in flight.
      if (returning) { setTimeout(apply, 500); return }
      showNotice()
    }

    function check (force) {
      var now = Date.now()
      if (ready || (!force && now - lastCheck < MIN_GAP_MS)) return
      lastCheck = now
      fetchBuild().then(function (d) {
        if (!d || !d.build || ready) return
        if (d.build === meta.content) { seen = null; return }
        if (!(d.age >= STABLE_S)) {
          if (!seen || seen.build !== d.build) {
            seen = { build: d.build, at: now }
            setTimeout(function () { check(true) }, CONFIRM_MS)
            return
          }
          if (now - seen.at < MIN_GAP_MS) return
        }
        ready = { breaking: String(d.breaking) !== meta.getAttribute('data-breaking') }
        tick = setInterval(apply, TICK_MS)
        apply()
      })
    }

    function init () {
      if (resume && resume.scroll) restoreScroll(resume.scroll)
      if (!meta || !nativeFetch) return
      var touch = function () { lastInput = Date.now() }
      ;['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (t) {
        document.addEventListener(t, touch, { capture: true, passive: true })
      })
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { apply(); return }
        // Back after a while away: the moment to reload, before the first click.
        if (Date.now() - lastInput >= IDLE_MS) back = Date.now()
        if (ready) apply(); else check()
      })
      window.addEventListener('focus', function () { check() })
      window.addEventListener('pageshow', function (e) { if (e.persisted) check() })
      window.addEventListener('online', function () { check() })
      setInterval(function () { check() }, CHECK_MS)
    }

    return { init: init, busy: busy, resume: resume }
  })()
  // ONE.GY Desktop asks before an update restart (desktop/docs/site-bridge.md).
  window.OneGyUpdate = { busy: Update.busy, resume: Update.resume }

    document.addEventListener('submit', function (e) {
      var form = e.target && e.target.closest ? e.target.closest('form.js-logout-form') : null
      if (!form) return
      try { if (window.OneGyCrypto && OneGyCrypto.clearSessionKeys) OneGyCrypto.clearSessionKeys() } catch (err) {}
      try { sessionStorage.clear() } catch (err) {}
    })

    function boot () { initNav(); initNotifs(); initReveal(); initCountUp(); initModals(); initMarquee(); Update.init() }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()

  window.OneGyRedesign = { initNav: initNav, initNotifs: initNotifs, initReveal: initReveal, initCountUp: initCountUp, initModals: initModals, initMarquee: initMarquee, reduced: reduced }
})()
