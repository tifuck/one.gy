/* ============================================================================
   theme-switch.js — runtime theme switching for every page.
   A tiny inline snippet in the shell <head> applies the saved theme before
   first paint (no FOUC). This file exposes window.OneGyTheme and wires any
   [data-set-theme="<name>"] control. Persists to localStorage (server-side
   persistence is a later backend follow-up).
   ========================================================================== */
;(function () {
  'use strict'
  var KEY = 'onegy_theme', DEFAULT = 'frost'
  var THEMES = [
    { id: 'frost',      label: 'Frost',      dark: false },
    { id: 'frost-dark', label: 'Frost Dark', dark: true }
  ]
  var IDS = THEMES.map(function (t) { return t.id })

  function get () {
    try { var t = localStorage.getItem(KEY); return IDS.indexOf(t) >= 0 ? t : DEFAULT }
    catch (e) { return DEFAULT }
  }
  function apply (t) { document.documentElement.setAttribute('data-theme', t) }
  function set (t) {
    if (IDS.indexOf(t) < 0) return
    try { localStorage.setItem(KEY, t) } catch (e) {}
    apply(t)
    mark()
    document.dispatchEvent(new CustomEvent('onegy:themechange', { detail: t }))
  }
  function mark () {
    var cur = get()
    document.querySelectorAll('[data-set-theme]').forEach(function (el) {
      el.setAttribute('aria-pressed', el.getAttribute('data-set-theme') === cur ? 'true' : 'false')
    })
  }

  apply(get())
  window.OneGyTheme = { get: get, set: set, list: THEMES }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-set-theme]')
    if (b) { e.preventDefault(); set(b.getAttribute('data-set-theme')) }
  })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mark)
  else mark()
})()
