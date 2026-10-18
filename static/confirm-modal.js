/**
 * Universal Confirmation Modal — ONE.GY
 * Self-contained module: creates its own DOM on first use.
 * Usage: const ok = await showConfirm(title, message, confirmText, icon, variant)
 * Variants: null (danger), 'confirm-permanent', 'confirm-e2e-warn', 'confirm-no-e2e', 'confirm-warn'
 */
;(function() {
  'use strict'

  var _COMPOUND_EXTS = new Set(['tar'])
  var _modal = null
  var _resolveRef = null

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  }

  // ─── AUDIT FIX F10: rich-message sanitizer ───────────────────────────
  // The 'confirm-e2e-warn' / 'confirm-no-e2e' variants used to assign the
  // message to innerHTML verbatim. Current call sites _esc() filenames, but
  // the modal must not have to trust its callers: the markup is parsed
  // inertly (template, never script-executing), then reduced to a tiny
  // presentation allowlist — only SPAN/BR/STRONG/EM/B/I/U/SMALL/DIV survive,
  // with a single attribute (class, character-sanitized); active content
  // (script/style/img/svg/iframe/form/...) is dropped WITH its content, other
  // unknown elements are unwrapped into their text, comments are removed.
  // The cleaned nodes are moved into place directly (no innerHTML re-parse of
  // an attacker-influenced string).
  var _RICH_ALLOWED = { SPAN: 1, BR: 1, STRONG: 1, EM: 1, B: 1, I: 1, U: 1, SMALL: 1, DIV: 1 }
  var _RICH_DROP = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1, BASE: 1, FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, LABEL: 1, SVG: 1, MATH: 1, IMG: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, TEMPLATE: 1, NOSCRIPT: 1 }

  function _sanitizeRichInto(el, html) {
    el.textContent = ''
    var tpl = document.createElement('template')
    tpl.innerHTML = (html === null || html === undefined) ? '' : String(html)

    var els = []
    var w = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT)
    while (w.nextNode()) els.push(w.currentNode)

    var doomed = []
    var unwrap = []
    els.forEach(function (node) {
      var tag = node.tagName
      if (_RICH_DROP[tag]) { doomed.push(node); return }
      if (!_RICH_ALLOWED[tag]) { unwrap.push(node); return }
      // Keep only a sanitized class attribute on allowed elements.
      var cls = ''
      if (node.hasAttribute('class')) {
        cls = (node.getAttribute('class') || '').replace(/[^A-Za-z0-9 _-]/g, '')
      }
      while (node.attributes.length) node.removeAttribute(node.attributes[0].name)
      if (cls) node.setAttribute('class', cls)
    })
    doomed.forEach(function (node) { if (node.parentNode) node.parentNode.removeChild(node) })
    unwrap.forEach(function (node) {
      var parent = node.parentNode
      if (!parent) return
      while (node.firstChild) parent.insertBefore(node.firstChild, node)
      parent.removeChild(node)
    })
    var comments = []
    var cw = document.createTreeWalker(tpl.content, NodeFilter.SHOW_COMMENT)
    while (cw.nextNode()) comments.push(cw.currentNode)
    comments.forEach(function (c) { if (c.parentNode) c.parentNode.removeChild(c) })

    el.appendChild(tpl.content)
  }

  function _splitNameExt(filename) {
    if (!filename || !filename.includes('.')) return { base: filename || '', ext: '' }
    var parts = filename.split('.')
    if (parts.length >= 3 && _COMPOUND_EXTS.has(parts[parts.length - 2].toLowerCase())) {
      var ext = '.' + parts[parts.length - 2] + '.' + parts[parts.length - 1]
      return { base: filename.substring(0, filename.length - ext.length), ext: ext }
    }
    var lastDot = filename.lastIndexOf('.')
    return { base: filename.substring(0, lastDot), ext: filename.substring(lastDot) }
  }

  function _ensureDOM() {
    if (_modal) return
    var div = document.createElement('div')
    div.innerHTML =
      '<div class="ucm-overlay" id="ucmOverlay">' +
        '<div class="ucm-dialog" id="ucmDialog">' +
          '<div class="ucm-icon-wrap" id="ucmIconWrap"></div>' +
          '<h3 class="ucm-title" id="ucmTitle"></h3>' +
          '<p class="ucm-message" id="ucmMessage"></p>' +
          '<div class="ucm-actions">' +
            '<button class="ucm-btn ucm-btn-cancel" id="ucmCancelBtn">CANCEL</button>' +
            '<button class="ucm-btn ucm-btn-confirm" id="ucmConfirmBtn">DELETE</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    _modal = div.firstChild
    document.body.appendChild(_modal)

    // Event listeners
    document.getElementById('ucmCancelBtn').addEventListener('click', function() { _close(false) })
    document.getElementById('ucmConfirmBtn').addEventListener('click', function() { _close(true) })
    _modal.addEventListener('click', function(e) {
      if (e.target === _modal) _close(false)
    })
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && _modal && _modal.classList.contains('ucm-visible')) {
        e.stopPropagation()
        _close(false)
      }
    })
  }

  // Pending close of the singleton modal, so a confirm opened during the 180ms
  // hide animation can finish it first instead of being hidden by it.
  var _hideTimer = null, _finishHide = null

  function _close(result) {
    if (!_modal || !_resolveRef) return
    var dialog = document.getElementById('ucmDialog')
    var fn = _resolveRef
    _resolveRef = null
    _modal.classList.add('ucm-hiding')
    dialog.classList.add('ucm-dialog-hiding')
    _finishHide = function() {
      _hideTimer = null
      _finishHide = null
      _modal.classList.remove('ucm-visible', 'ucm-hiding', 'ucm-permanent', 'ucm-e2e-warn', 'ucm-no-e2e', 'ucm-warn')
      dialog.classList.remove('ucm-dialog-hiding')
      fn(result)
    }
    _hideTimer = setTimeout(_finishHide, 180)
  }

  window.showConfirm = function(title, message, confirmText, icon, variant) {
    confirmText = confirmText || 'DELETE'
    icon = icon || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
    variant = variant || null

    _ensureDOM()

    // A confirm still animating closed: finish it now, or its delayed cleanup
    // would hide this one and leave its promise unresolved.
    if (_hideTimer) {
      clearTimeout(_hideTimer)
      _finishHide()
    }

    // If a previous confirm is open, resolve it as false
    if (_resolveRef) {
      var old = _resolveRef
      _resolveRef = null
      old(false)
    }

    return new Promise(function(resolve) {
      _resolveRef = resolve

      // Icon
      var iconWrap = document.getElementById('ucmIconWrap')
      if (icon.startsWith('<')) {
        iconWrap.innerHTML = icon
      } else {
        iconWrap.innerHTML = ''
        iconWrap.textContent = icon
      }

      // Title — render filename with extension coloring
      var titleEl = document.getElementById('ucmTitle')
      var parts = _splitNameExt(title)
      if (parts.ext && !title.startsWith('.')) {
        titleEl.innerHTML = '<span class="ucm-name-base">' + _esc(parts.base) + '</span><span class="ucm-name-ext">' + _esc(parts.ext) + '</span>'
      } else {
        titleEl.textContent = title
      }

      // Message — the two rich variants keep their <span>/<br> styling markup,
      // but only through the F10 sanitizer; everything else is textContent.
      var msgEl = document.getElementById('ucmMessage')
      if (variant === 'confirm-e2e-warn' || variant === 'confirm-no-e2e') {
        _sanitizeRichInto(msgEl, message)
      } else {
        msgEl.textContent = message
      }

      // Confirm button text
      document.getElementById('ucmConfirmBtn').textContent = confirmText

      // Variant classes
      _modal.classList.remove('ucm-permanent', 'ucm-e2e-warn', 'ucm-no-e2e', 'ucm-warn')
      if (variant === 'confirm-permanent') _modal.classList.add('ucm-permanent')
      else if (variant === 'confirm-e2e-warn') _modal.classList.add('ucm-e2e-warn')
      else if (variant === 'confirm-no-e2e') _modal.classList.add('ucm-no-e2e')
      else if (variant === 'confirm-warn') _modal.classList.add('ucm-warn')

      // Show
      _modal.classList.add('ucm-visible')
    })
  }
})()
