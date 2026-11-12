/* ============================================================================
   preview.js — Frost file preview + text editor for the Files page.
   Double-click a file → this modal. Renders images / video / audio / PDF and
   an editable text/code editor. All E2EE decrypt + re-encrypt reuse
   window.OneGyCrypto (never re-implemented). Save mirrors the legacy
   /file/<id>/save-content flow (E2E: new file key + re-encrypted name +
   re-wrapped link key; plain: raw bytes).
   Text opens full screen (or windowed; the choice is saved per browser).
   Images opened with opts.list get prev/next and a filmstrip of that list.
   Exposes window.FxPreview = { open(fileItem, opts), close() }, where
   opts = { list: [image items in view order], thumb: fn(node with data-thumb) }.
   ========================================================================== */
(function () {
  'use strict'

  var EDITOR_MAX = 5 * 1024 * 1024
  // Syntax colouring re-highlights the whole buffer: per keystroke up to
  // HL_SYNC_MAX chars, debounced up to HL_MAX, plain text above that.
  var HL_SYNC_MAX = 30000
  var HL_MAX = 300000
  // Anything decrypted or read into page memory is refused above this size.
  var PREVIEW_MAX = 512 * 1024 * 1024
  // /file/<id>/preview answers a Range request for audio over 50 MB with 403.
  var AUDIO_RANGE_MAX = 50 * 1024 * 1024
  var IMG = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']
  var TXT = ['txt', 'md', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'py', 'js', 'mjs', 'cjs', 'html', 'htm', 'css', 'scss', 'less', 'sh', 'bash', 'zsh', 'ini', 'cfg', 'conf', 'env', 'c', 'cpp', 'h', 'hpp', 'cs', 'lua', 'rb', 'rs', 'go', 'java', 'ts', 'tsx', 'jsx', 'toml', 'bat', 'ps1', 'sql', 'r', 'swift', 'kt', 'php', 'pl', 'diff', 'patch', 'makefile']
  var VID = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv']
  var AUD = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']
  var PDF = ['pdf']

  var _blobUrl = null
  var _dlBlobUrl = null
  var _zoomCleanup = null
  var _editorDirty = false
  var _saving = false  // a save-content request is in flight
  var _openGeneration = 0
  var _previewAbort = null
  var _historyOpen = false
  var LS_LAYOUT = 'onegy_preview_layout'  // 'full' (default) | 'window'
  var LS_WRAP = 'onegy_preview_wrap'      // '1' | '0'; default on for phones
  var LS_STRIP = 'onegy_preview_strip'    // '1' (default) | '0'
  // Wrapped rows are measured per line in a hidden div; above this many lines
  // the gutter keeps one number per row and can drift on wrapped lines.
  var WRAP_MEASURE_MAX = 20000
  var _gallery = null  // { list, thumb } while an image is browsed in a list
  var _current = null
  var _zoomed = false
  var _stripObs = null
  var _vpMeta = null
  var IOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  var SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  var ICON = {
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    wrap: '<path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>',
    full: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    window: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
    strip: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M3 20h4M10 20h4M17 20h4"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    more: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    indent: '<path d="M3 12h12"/><path d="m11 8 4 4-4 4"/><path d="M21 5v14"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'
  }
  function $ (id) { return document.getElementById(id) }
  function pref (k, def) { try { var v = localStorage.getItem(k); return v == null ? def : v } catch (e) { return def } }
  function setPref (k, v) { try { localStorage.setItem(k, v) } catch (e) {} }
  function iconBtn (label, icon) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'pv-btn'
    b.title = label; b.setAttribute('aria-label', label); b.innerHTML = SVG + ICON[icon] + '</svg>'
    return b
  }
  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function csrf () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : (document.querySelector('input[name="csrf_token"]') || {}).value || '' }
  function toast (m, c) { if (window.showToast) window.showToast(m, c) }
  function haveKeys () { return typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys && OneGyCrypto.hasSessionKeys() }
  function extOf (item) { var e = item.extension || ''; e = String(e).replace(/^\./, '').toLowerCase(); if (e) return e; var m = /\.([a-z0-9]+)$/i.exec(item.name || ''); return m ? m[1].toLowerCase() : '' }
  function revoke () {
    if (_blobUrl) { try { URL.revokeObjectURL(_blobUrl) } catch (e) {} _blobUrl = null }
    if (_dlBlobUrl) { try { URL.revokeObjectURL(_dlBlobUrl) } catch (e) {} _dlBlobUrl = null }
  }
  // A video/audio preview autoplays: stop the music player instead of mixing the
  // two (phantom mode only loops a silent keepalive and is left alone).
  function pauseMusic () {
    var mp = window.MusicPlayer
    if (!mp || !mp.getAudioElement || (mp.isPhantomMode && mp.isPhantomMode())) return
    var a = mp.getAudioElement()
    if (a && !a.paused) a.pause()
  }
  function detachZoom () { if (_zoomCleanup) { _zoomCleanup(); _zoomCleanup = null } }
  function isCurrent (generation) { return generation === _openGeneration }
  function beginOpen () {
    _openGeneration++
    if (_previewAbort) _previewAbort.abort()
    _previewAbort = new AbortController()
    return { generation: _openGeneration, signal: _previewAbort.signal }
  }
  function cancelOpen () {
    _openGeneration++
    if (_previewAbort) _previewAbort.abort()
    _previewAbort = null
  }

  function open (item, opts) {
    if (!$('previewModal') || !item) return
    _gallery = opts && opts.list && opts.list.length > 1 && IMG.indexOf(extOf(item)) >= 0 ? opts : null
    buildStrip()
    show(item, false)
  }

  function show (item, nav) {
    var modal = $('previewModal'); if (!modal || !item) return
    if (!modal.classList.contains('preview-visible')) {
      history.pushState(Object.assign({}, history.state || {}, { fxPreview: true }), '', window.location.href)
      _historyOpen = true
    }
    var opening = beginOpen()
    var body = $('previewBody'), nameEl = $('previewFileName'), dl = $('previewDownloadBtn'), resEl = $('previewResolution')
    _current = item
    _editorDirty = false
    revoke()
    detachZoom()
    if (body.__fxWheel) { body.removeEventListener('wheel', body.__fxWheel); body.__fxWheel = null }
    if (nameEl) nameEl.textContent = item.name || 'Preview'
    if (resEl) { resEl.textContent = ''; resEl.classList.remove('visible') }
    if (dl) { dl.removeAttribute('href'); dl.removeAttribute('download') }
    $('previewActions').innerHTML = ''
    modal.classList.remove('pv-text', 'pv-window')
    if (TXT.indexOf(extOf(item)) >= 0) setTextMode(modal); else lockZoom(false)
    syncGallery(item)
    // Stepping through images keeps the previous one (dimmed) until the next
    // has loaded, instead of flashing an empty stage.
    var old = nav && body.firstElementChild
    if (old && old.classList.contains('preview-image')) old.classList.add('is-stale')
    else body.innerHTML = '<div class="preview-loading">' + (item.is_e2e ? 'Decrypting preview…' : 'Loading preview…') + '</div>'
    modal.classList.add('preview-visible')
    document.documentElement.style.overflow = 'hidden'
    render(item, body, dl, resEl, opening.generation, opening.signal)
  }

  function setTextMode (modal) {
    modal.classList.add('pv-text')
    modal.classList.toggle('pv-window', pref(LS_LAYOUT, 'full') === 'window')
    lockZoom(true)
    fitViewport()
  }
  // iOS zooms the page into any focused field under 16px and never zooms back;
  // maximum-scale stops that (iOS still allows pinch zoom).
  function lockZoom (on) {
    var m = IOS && document.querySelector('meta[name="viewport"]'); if (!m) return
    if (on && _vpMeta == null) { _vpMeta = m.content; m.content = _vpMeta + ', maximum-scale=1' }
    if (!on && _vpMeta != null) { m.content = _vpMeta; _vpMeta = null }
  }
  // With the on-screen keyboard up the editor shrinks to the visible area, so
  // the caret line and the status bar stay above the keyboard.
  function fitViewport () {
    var modal = $('previewModal'), vv = window.visualViewport; if (!modal) return
    var on = !!vv && modal.classList.contains('preview-visible') && modal.classList.contains('pv-text') && vv.scale < 1.05 && vv.height < window.innerHeight - 1
    modal.style.top = on ? vv.offsetTop + 'px' : ''
    modal.style.height = on ? vv.height + 'px' : ''
    modal.style.bottom = on ? 'auto' : ''
  }

  // ---- Image gallery (prev/next + filmstrip) -------------------------------
  function galleryIndex (item) {
    if (!_gallery || !item) return -1
    for (var i = 0; i < _gallery.list.length; i++) if (String(_gallery.list[i].id) === String(item.id)) return i
    return -1
  }
  function syncGallery (item) {
    var modal = $('previewModal'), prev = $('previewPrev'), next = $('previewNext'), count = $('previewCount')
    var idx = galleryIndex(item), n = _gallery ? _gallery.list.length : 0
    modal.classList.toggle('pv-gallery', idx >= 0)
    prev.hidden = next.hidden = idx < 0
    prev.disabled = idx <= 0; next.disabled = idx < 0 || idx >= n - 1
    count.textContent = idx >= 0 ? (idx + 1) + ' of ' + n : ''
    if (idx >= 0) {
      var tb = iconBtn('Thumbnails', 'strip'); tb.setAttribute('data-strip', '')
      tb.addEventListener('click', function () { setPref(LS_STRIP, pref(LS_STRIP, '1') === '1' ? '0' : '1'); syncStrip() })
      $('previewActions').appendChild(tb)
    }
    syncStrip()
  }
  function syncStrip () {
    var modal = $('previewModal'), strip = $('previewStrip')
    var idx = galleryIndex(_current), on = idx >= 0 && pref(LS_STRIP, '1') === '1'
    strip.hidden = !on
    modal.classList.toggle('pv-has-strip', on)
    var tb = $('previewActions').querySelector('[data-strip]'); if (tb) tb.setAttribute('aria-pressed', String(on))
    for (var i = 0; i < strip.children.length; i++) {
      strip.children[i].classList.toggle('is-active', i === idx)
      if (i === idx) strip.children[i].setAttribute('aria-current', 'true'); else strip.children[i].removeAttribute('aria-current')
    }
    var cur = on && strip.children[idx]
    if (cur) {
      var smooth = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)
      strip.scrollTo({ left: cur.offsetLeft - (strip.clientWidth - cur.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' })
    }
  }
  function buildStrip () {
    var strip = $('previewStrip'); if (!strip) return
    if (_stripObs) { _stripObs.disconnect(); _stripObs = null }
    strip.innerHTML = ''
    if (!_gallery) return
    var gallery = _gallery
    function load (node) { if (gallery.thumb) gallery.thumb(node) }
    if ('IntersectionObserver' in window) {
      _stripObs = new IntersectionObserver(function (ents) {
        ents.forEach(function (en) { if (en.isIntersecting) { _stripObs.unobserve(en.target); load(en.target) } })
      }, { root: strip, rootMargin: '0px 320px' })
    }
    gallery.list.forEach(function (f) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'pv-thumb'
      b.title = f.name || ''; b.setAttribute('aria-label', f.name || 'Image')
      var t = document.createElement('span'); t.className = 'pv-thumb-img'; t.setAttribute('data-thumb', f.id)
      b.appendChild(t)
      b.addEventListener('click', function () { go(f) })
      strip.appendChild(b)
      if (_stripObs) _stripObs.observe(t); else load(t)
    })
  }
  function go (f) { if (f && (!_current || String(f.id) !== String(_current.id))) show(f, true) }
  function step (d) { var i = galleryIndex(_current); if (i >= 0) go(_gallery.list[i + d]) }

  function close (fromHistory) {
    if (_historyOpen && !fromHistory) { history.back(); return }
    cancelOpen()
    var modal = $('previewModal'); if (!modal) return
    modal.classList.remove('preview-visible', 'pv-text', 'pv-window', 'pv-gallery', 'pv-has-strip')
    document.documentElement.style.overflow = ''
    _editorDirty = false
    revoke()
    detachZoom()
    var body = $('previewBody'); if (body) { if (body.__fxWheel) { body.removeEventListener('wheel', body.__fxWheel); body.__fxWheel = null } body.innerHTML = '' }
    var badge = $('previewZoomBadge'); if (badge) { badge.textContent = ''; badge.classList.remove('visible') }
    $('previewActions').innerHTML = ''
    $('previewCount').textContent = ''
    $('previewPrev').hidden = $('previewNext').hidden = true
    _gallery = null
    _current = null
    buildStrip()
    $('previewStrip').hidden = true
    lockZoom(false)
    fitViewport()
    _historyOpen = false
  }
  // Close on X / Esc / click-outside — but guard unsaved editor changes. While
  // a save is in flight the old prompt said "discard" although the save went on.
  function requestClose () {
    if (_saving) { toast('SAVING. WAIT FOR THE SAVE TO FINISH', 'info'); return }
    if (_editorDirty && !window.confirm('Discard unsaved changes to this file?')) return
    _editorDirty = false
    close()
  }
  function onPopState (e) {
    if (!_historyOpen) return
    e.stopImmediatePropagation()
    if (_saving) toast('SAVING. WAIT FOR THE SAVE TO FINISH', 'info')
    if (_saving || (_editorDirty && !window.confirm('Discard unsaved changes to this file?'))) {
      history.pushState(Object.assign({}, history.state || {}, { fxPreview: true }), '', window.location.href)
      return
    }
    close(true)
  }

  // ---- Text encoding detection ---------------------------------------------
  // Windows writes many text files (BitLocker recovery keys, Notepad "Unicode")
  // as UTF-16 with a BOM. Decoding those as hard-coded UTF-8 renders the BOM as
  // replacement chars and a NUL "box" between every character, which looks like
  // corruption even though the stored bytes are pristine. Detect the BOM (plus
  // a conservative BOM-less UTF-16 heuristic) and decode accordingly. The
  // editor re-encodes with the SAME encoding + BOM on save, so opening and
  // saving a UTF-16 file never silently converts it to UTF-8.
  function decodeTextBytes (bytes) {
    var u8 = new Uint8Array(bytes)
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), enc: 'utf-16le', bom: true }
    if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), enc: 'utf-16be', bom: true }
    if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return { text: new TextDecoder('utf-8').decode(u8), enc: 'utf-8', bom: true }
    // BOM-less UTF-16 heuristic: real text never contains NUL bytes, so a high
    // share of NULs on one side of every byte pair means UTF-16.
    if (u8.length >= 4) {
      var n = Math.min(u8.length - (u8.length % 2), 1024), even = 0, odd = 0
      for (var i = 0; i + 1 < n; i += 2) { if (u8[i] === 0) even++; if (u8[i + 1] === 0) odd++ }
      var pairs = n / 2
      if (pairs > 0 && odd / pairs > 0.7 && even / pairs < 0.1) return { text: new TextDecoder('utf-16le').decode(u8), enc: 'utf-16le', bom: false }
      if (pairs > 0 && even / pairs > 0.7 && odd / pairs < 0.1) return { text: new TextDecoder('utf-16be').decode(u8), enc: 'utf-16be', bom: false }
    }
    return { text: new TextDecoder('utf-8').decode(u8), enc: 'utf-8', bom: false }
  }
  // Unlisted or extension-less files (Makefile, README, .gitignore, ...) still
  // open in the editor when their bytes are text: UTF-16 with a BOM, or
  // NUL-free valid UTF-8.
  function looksLikeText (bytes) {
    var u8 = new Uint8Array(bytes).subarray(0, 8192)
    if (u8.length >= 2 && ((u8[0] === 0xFF && u8[1] === 0xFE) || (u8[0] === 0xFE && u8[1] === 0xFF))) return true
    if (u8.indexOf(0) >= 0) return false
    try { new TextDecoder('utf-8', { fatal: true }).decode(u8, { stream: true }); return true } catch (e) { return false }
  }

  // Fills `codeEl` with highlighted HTML when highlight.js knows the language.
  // `source` is the text or a function returning it, read once highlight.js has
  // loaded so edits made meanwhile are not lost. Resolves to the language name,
  // or null (codeEl left untouched).
  function highlightInto (codeEl, source, ext, generation) {
    if (typeof OneGyCrypto === 'undefined' || !OneGyCrypto.loadHighlighter) return Promise.resolve(null)
    return OneGyCrypto.loadHighlighter().then(function (h) {
      var lang = h && OneGyCrypto.highlightLanguage(ext)
      var text = typeof source === 'function' ? source() : source
      if (!lang || !h.getLanguage(lang) || !isCurrent(generation) || text.length > HL_MAX) return null
      try { codeEl.innerHTML = h.highlight(text, { language: lang, ignoreIllegals: true }).value } catch (e) { return null }
      return h.getLanguage(lang).name || lang
    })
  }

  function detectEol (text) {
    if (text.indexOf('\r\n') >= 0) return '\r\n'
    if (text.indexOf('\r') >= 0) return '\r'
    return '\n'
  }
  function encodeTextBytes (str, encInfo) {
    if (encInfo && encInfo.eol && encInfo.eol !== '\n') str = String(str).split('\n').join(encInfo.eol)
    var enc = encInfo && encInfo.enc
    if (enc === 'utf-16le' || enc === 'utf-16be') {
      var le = enc === 'utf-16le'
      var bom = encInfo.bom ? 2 : 0
      var out = new Uint8Array(bom + str.length * 2)
      if (bom) { out[0] = le ? 0xFF : 0xFE; out[1] = le ? 0xFE : 0xFF }
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i)
        out[bom + i * 2 + (le ? 0 : 1)] = c & 0xFF
        out[bom + i * 2 + (le ? 1 : 0)] = (c >> 8) & 0xFF
      }
      return out
    }
    var utf8 = new TextEncoder().encode(str)
    if (encInfo && encInfo.bom && enc === 'utf-8') {
      var withBom = new Uint8Array(3 + utf8.length)
      withBom[0] = 0xEF; withBom[1] = 0xBB; withBom[2] = 0xBF
      withBom.set(utf8, 3)
      return withBom
    }
    return utf8
  }

  // An HTTP error body must never be treated as file content (it would land in
  // the editor and could be saved over the file).
  async function okFetch (url, signal) {
    var r = await fetch(url, { signal: signal })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return r
  }

  async function getBytes (item, signal) {
    if (item.is_e2e) {
      if (!haveKeys()) throw new Error('KEYS LOCKED')
      var masterKey = await OneGyCrypto.getMasterKeyFromSession()
      if (!masterKey) throw new Error('KEYS LOCKED')
      var efk = item.encrypted_file_key, fkn = item.file_key_nonce
      if (!efk) { var ki = await (await okFetch('/f/' + item.id + '/key-info', signal)).json(); efk = ki.encrypted_file_key; fkn = ki.file_key_nonce }
      var enc = await (await okFetch('/f/' + item.id + '/encrypted?preview=1', signal)).arrayBuffer()
      return await OneGyCrypto.decryptFileForDownload(enc, efk, fkn, masterKey)
    }
    return await (await okFetch('/file/' + item.id + '/preview', signal)).arrayBuffer()
  }

  async function render (item, body, dl, resEl, generation, signal) {
    var ext = extOf(item)
    var known = IMG.indexOf(ext) >= 0 || TXT.indexOf(ext) >= 0 || VID.indexOf(ext) >= 0 || AUD.indexOf(ext) >= 0 || PDF.indexOf(ext) >= 0
    // Plain files stream straight from the server into the media element /
    // download link; only E2EE content, text and SVG (served as an attachment)
    // have to be read into memory first.
    // Small unlisted files are read so a text one can still open in the editor.
    var direct = !item.is_e2e && ((!known && (item.size || 0) > EDITOR_MAX) || VID.indexOf(ext) >= 0 || PDF.indexOf(ext) >= 0 ||
      (IMG.indexOf(ext) >= 0 && ext !== 'svg') || (AUD.indexOf(ext) >= 0 && (item.size || 0) <= AUDIO_RANGE_MAX))
    var directUrl = '/file/' + encodeURIComponent(item.id) + '/preview'
    if (!direct && (item.size || 0) > PREVIEW_MAX) {
      body.innerHTML = '<div class="preview-none preview-error"><h3>Too large to preview</h3><p>Files over 512 MB are not opened in the browser. Download it to open it on your device.</p>' +
        (item.is_e2e ? '' : '<a class="rd-btn rd-btn-primary" href="' + directUrl + '" download="' + esc(item.name || 'file') + '">Download</a>') + '</div>'
      if (dl && !item.is_e2e) { dl.href = directUrl; dl.download = item.name || 'file' }
      return
    }
    try {
      var bytes = direct ? null : await getBytes(item, signal)
      if (!isCurrent(generation)) return
      var blob = function (mime) {
        if (direct) { if (dl) { dl.href = directUrl; dl.download = item.name || 'file' } return directUrl }
        var b = new Blob([bytes], { type: mime }); _blobUrl = URL.createObjectURL(b)
        // A decrypted SVG opened from the download link would render as a
        // same-origin document, so that link gets an opaque copy instead.
        if (mime === 'image/svg+xml') _dlBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
        if (dl) { dl.href = _dlBlobUrl || _blobUrl; dl.download = item.name || 'file' }
        return _blobUrl
      }
      if (IMG.indexOf(ext) >= 0) {
        var mimeI = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'image/jpeg'
        var url = blob(mimeI)
        var img = new Image(); img.className = 'preview-image'; img.alt = item.name || ''
        img.onload = function () { if (!isCurrent(generation)) return; body.innerHTML = ''; body.appendChild(img); if (resEl) { resEl.textContent = img.naturalWidth + ' × ' + img.naturalHeight; resEl.classList.add('visible') } attachZoom(img, body, generation) }
        img.onerror = function () { if (isCurrent(generation)) body.innerHTML = '<div class="preview-error">Could not display this image</div>' }
        img.src = url
      } else if (TXT.indexOf(ext) >= 0 || (!known && bytes && looksLikeText(bytes))) {
        blob('text/plain')
        var decoded = decodeTextBytes(bytes)
        decoded.eol = detectEol(decoded.text)
        var text = decoded.text
        body.innerHTML = ''
        setTextMode($('previewModal'))
        if ((bytes.byteLength || 0) > EDITOR_MAX) {
          var ro = document.createElement('div'); ro.className = 'preview-ro'
          var pre = document.createElement('pre'); pre.className = 'preview-text'; pre.textContent = text.slice(0, 50000)
          var foot = document.createElement('div'); foot.className = 'preview-ed-foot'
          foot.innerHTML = '<span class="preview-ed-status preview-ro-note">Too large to edit. Showing the first 50,000 characters, read-only.</span>'
          ro.appendChild(pre); ro.appendChild(foot); body.appendChild(ro)
          highlightInto(pre, pre.textContent, ext, generation)
        } else {
          body.appendChild(buildEditor(text, ext, item, decoded, generation))
        }
      } else if (VID.indexOf(ext) >= 0) {
        var mimeV = { mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/quicktime', m4v: 'video/x-m4v', mkv: 'video/x-matroska' }[ext] || 'video/mp4'
        pauseMusic()
        var v = document.createElement('video'); v.className = 'preview-video'; v.controls = true; v.autoplay = true; v.src = blob(mimeV)
        body.innerHTML = ''; body.appendChild(v)
      } else if (AUD.indexOf(ext) >= 0) {
        var mimeA = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' }[ext] || 'audio/mpeg'
        var wrap = document.createElement('div'); wrap.className = 'preview-audio-wrap'
        wrap.innerHTML = '<div class="preview-audio-ico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg></div>'
        pauseMusic()
        var a = document.createElement('audio'); a.controls = true; a.autoplay = true; a.src = blob(mimeA); a.className = 'preview-audio'
        wrap.appendChild(a); body.innerHTML = ''; body.appendChild(wrap)
      } else if (PDF.indexOf(ext) >= 0) {
        var f = document.createElement('iframe'); f.className = 'preview-pdf'; f.src = blob('application/pdf')
        body.innerHTML = ''; body.appendChild(f)
      } else {
        var fileUrl = blob('application/octet-stream')
        body.innerHTML = '<div class="preview-none preview-error"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2z"/></svg>' +
          '<h3>No preview for ' + (ext ? '.' + esc(ext) + ' files' : 'this file') + '</h3><p>Download it to open it on your device.</p>' +
          '<a class="rd-btn rd-btn-primary" href="' + fileUrl + '" download="' + esc(item.name || 'file') + '">Download</a></div>'
      }
    } catch (e) {
      if (isCurrent(generation) && (!e || e.name !== 'AbortError')) body.innerHTML = '<div class="preview-error">' + (String(e.message).indexOf('KEYS') >= 0 ? 'Unlock your keys to preview this file' : 'Preview failed. Download the file to open it.') + '</div>'
    }
  }

  // ---- Image zoom (scroll wheel to zoom, drag to pan) ----------------------
  function attachZoom (img, stage, generation) {
    var scale = 1, tx = 0, ty = 0, dragging = false, sx = 0, sy = 0
    var badge = $('previewZoomBadge')
    function apply () {
      if (!isCurrent(generation)) return
      img.style.transformOrigin = 'center center'
      img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'
      img.style.cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default'
      _zoomed = scale > 1
      if (badge) { badge.textContent = Math.round(scale * 100) + '%'; badge.classList.toggle('visible', scale !== 1) }
    }
    if (stage.__fxWheel) stage.removeEventListener('wheel', stage.__fxWheel)
    stage.__fxWheel = function (e) {
      if (!isCurrent(generation) || !img.parentNode) return
      e.preventDefault()
      var prev = scale
      scale = Math.min(8, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      if (scale === prev) return
      if (scale === 1) { tx = 0; ty = 0 } else {
        // keep the point under the cursor roughly stable (zoom toward cursor)
        var r = img.getBoundingClientRect()
        var ox = e.clientX - (r.left + r.width / 2), oy = e.clientY - (r.top + r.height / 2)
        var k = scale / prev
        tx = (tx - ox) * k + ox; ty = (ty - oy) * k + oy
      }
      apply()
    }
    stage.addEventListener('wheel', stage.__fxWheel, { passive: false })
    img.addEventListener('mousedown', function (e) { if (!isCurrent(generation) || scale <= 1) return; e.preventDefault(); dragging = true; sx = e.clientX - tx; sy = e.clientY - ty; apply() })
    function onMove (e) { if (!isCurrent(generation) || !dragging) return; tx = e.clientX - sx; ty = e.clientY - sy; apply() }
    function onUp () { if (isCurrent(generation) && dragging) { dragging = false; apply() } }
    detachZoom()
    _zoomed = false
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    _zoomCleanup = function () { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    img.addEventListener('dblclick', function (e) { if (!isCurrent(generation)) return; e.stopPropagation(); scale = 1; tx = 0; ty = 0; apply() })
  }

  // ---- Text editor ---------------------------------------------------------
  function buildEditor (text, ext, item, encInfo, generation) {
    var modal = $('previewModal')
    var wrap = document.createElement('div'); wrap.className = 'preview-ed'
    var enc = (encInfo.enc === 'utf-16le' ? 'UTF-16 LE' : encInfo.enc === 'utf-16be' ? 'UTF-16 BE' : 'UTF-8') + (encInfo.bom ? ' with BOM' : '')
    var eol = encInfo.eol === '\r\n' ? 'CRLF' : encInfo.eol === '\r' ? 'CR' : 'LF'
    wrap.innerHTML =
      '<div class="preview-ed-body"><div class="preview-ed-gutter" data-gutter aria-hidden="true"></div>' +
      '<div class="preview-ed-code"><pre class="preview-ed-hl" aria-hidden="true"><code></code></pre>' +
      '<textarea class="preview-ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="File contents"></textarea>' +
      '<div class="preview-ed-measure" aria-hidden="true"></div></div></div>' +
      '<div class="preview-ed-foot"><span class="preview-ed-status" data-status role="status"></span>' +
      '<span data-lang>' + esc(['txt', 'log', ''].indexOf(ext) >= 0 ? 'Plain text' : ext.toUpperCase()) + '</span>' +
      '<span class="pv-foot-wide">' + enc + '</span><span class="pv-foot-wide">' + eol + '</span>' +
      '<span class="preview-ed-pos" data-pos></span></div>'
    var ta = wrap.querySelector('.preview-ed-ta')
    var codeBox = wrap.querySelector('.preview-ed-code')
    var hl = wrap.querySelector('.preview-ed-hl')
    var hlCode = hl.firstChild
    var measure = wrap.querySelector('.preview-ed-measure')
    var gutter = wrap.querySelector('[data-gutter]')
    var status = wrap.querySelector('[data-status]')
    var langEl = wrap.querySelector('[data-lang]')
    var posEl = wrap.querySelector('[data-pos]')

    // Bar actions. Save keeps one label and width in every state; the state
    // itself is shown in the status bar, so nothing in the bar moves.
    var wrapBtn = iconBtn('Wrap lines', 'wrap'); wrapBtn.classList.add('pv-only-wide')
    var layoutBtn = iconBtn('Windowed view', 'window'); layoutBtn.classList.add('pv-only-wide')
    // Narrow screens: wrap and download move into a labelled menu (no hover
    // tooltips on touch, and the filename keeps its room).
    var moreBtn = iconBtn('More options', 'more'); moreBtn.classList.add('pv-only-narrow')
    var saveBtn = document.createElement('button'); saveBtn.type = 'button'; saveBtn.className = 'preview-ed-save'
    saveBtn.disabled = true; saveBtn.title = 'Save (Ctrl+S)'; saveBtn.innerHTML = SVG + ICON.save + '</svg>Save'
    var actions = $('previewActions')
    actions.appendChild(wrapBtn); actions.appendChild(layoutBtn); actions.appendChild(moreBtn); actions.appendChild(saveBtn)

    // Touch: open read-only so a tap while reading does not raise the
    // keyboard. Edit (in Save's slot) unlocks it and shows the key bar.
    var touch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches)
    var editBtn = null
    if (touch) {
      wrap.classList.add('is-touch')
      ta.readOnly = true
      saveBtn.hidden = true
      editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.className = 'preview-ed-save pv-ed-edit'
      editBtn.innerHTML = SVG + ICON.edit + '</svg>Edit'
      actions.appendChild(editBtn)
      var keys = document.createElement('span'); keys.className = 'pv-keys'
      ;[['Undo', 'undo'], ['Redo', 'redo'], ['Indent', 'indent']].forEach(function (k) {
        var b = iconBtn(k[0], k[1])
        // Keep focus (and the keyboard) in the textarea while tapping keys.
        b.addEventListener('pointerdown', function (e) { e.preventDefault() })
        b.addEventListener('mousedown', function (e) { e.preventDefault() })
        b.addEventListener('click', function () {
          if (document.activeElement !== ta) ta.focus({ preventScroll: true })
          if (k[1] === 'indent') insertIndent(); else document.execCommand(k[1])
        })
        keys.appendChild(b)
      })
      wrap.querySelector('.preview-ed-foot').insertBefore(keys, status)
    }

    ta.value = text
    ta.setSelectionRange(0, 0)
    var clean = text  // what the server holds; dirty = the textarea differs
    var savedOnce = false
    var dirty = false
    var editRevision = 0
    var saving = false
    var hlOn = false
    var hlTimer = null
    var gutterTimer = null
    var posFrame = 0
    var narrow = !!(window.matchMedia && matchMedia('(max-width: 640px)').matches)
    var wrapOn = pref(LS_WRAP, narrow ? '1' : '0') === '1'

    function updGutter () {
      gutterTimer = null
      if (!isCurrent(generation)) return
      var lines = ta.value.split('\n'), n = lines.length, s = '', i
      wrap.style.setProperty('--pv-digits', String(String(n).length))
      if (wrapOn && n <= WRAP_MEASURE_MAX && ta.clientWidth) {
        // One number per visual row: measure each line wrapped at the
        // textarea's width, pad the gutter with blank rows to match.
        measure.style.width = ta.clientWidth + 'px'
        var h = ''
        for (i = 0; i < n; i++) h += '<div>' + esc(lines[i]) + '</div>'
        measure.innerHTML = h
        var lh = parseFloat(getComputedStyle(ta).lineHeight) || 20
        for (i = 0; i < n; i++) s += (i + 1) + '\n'.repeat(Math.max(1, Math.round(measure.children[i].offsetHeight / lh)))
        measure.innerHTML = ''
      } else {
        for (i = 1; i <= n; i++) s += i + '\n'
      }
      gutter.textContent = s
      syncScroll()
    }
    function scheduleGutter () {
      clearTimeout(gutterTimer)
      if (ta.value.length <= HL_SYNC_MAX) updGutter(); else gutterTimer = setTimeout(updGutter, 150)
    }
    function syncScroll () { gutter.scrollTop = ta.scrollTop; hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft }
    function updPos () {
      posFrame = 0
      var v = ta.value, p = ta.selectionStart, ln = 1, i = -1
      while ((i = v.indexOf('\n', i + 1)) !== -1 && i < p) ln++
      var col = p - (p > 0 ? v.lastIndexOf('\n', p - 1) : -1)
      posEl.innerHTML = '<span class="pv-foot-wide">Ln </span>' + ln + '<span class="pv-foot-wide">, Col </span><span class="pv-foot-narrow">:</span>' + col
    }
    function schedPos () { if (!posFrame) posFrame = requestAnimationFrame(updPos) }
    // The transparent textarea sits on top of the highlighted <pre>. A trailing
    // newline is a real (empty) last line in a textarea but not in a <pre>.
    function hlSource () { var v = ta.value; return v.slice(-1) === '\n' ? v + ' ' : v }
    function paintHl () {
      hlTimer = null
      highlightInto(hlCode, hlSource, ext, generation).then(function (lang) {
        hlOn = !!lang
        if (lang) langEl.textContent = lang
        codeBox.classList.toggle('is-hl', hlOn)
        syncScroll()
      })
    }
    function repaintHl () {
      if (!hlOn) return
      clearTimeout(hlTimer)
      if (ta.value.length <= HL_SYNC_MAX) { paintHl(); return }
      hlCode.textContent = hlSource()
      hlTimer = setTimeout(paintHl, 200)
    }
    function setStatus (cls, msg) { status.textContent = msg; status.className = 'preview-ed-status' + (cls ? ' ' + cls : '') }
    // Undoing back to the saved text is not an unsaved change.
    function mark () {
      if (!isCurrent(generation)) return
      editRevision++
      dirty = ta.value !== clean; _editorDirty = dirty
      if (!saving) saveBtn.disabled = !dirty
      if (saving) return
      if (dirty) setStatus('is-mod', 'Unsaved changes'); else setStatus(savedOnce ? 'is-saved' : '', savedOnce ? 'Saved' : '')
    }
    function insertIndent () {
      // insertText keeps the browser's undo stack; setRangeText is the fallback.
      if (!document.execCommand || !document.execCommand('insertText', false, '  ')) {
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end')
        ta.dispatchEvent(new Event('input'))
      }
    }
    function startEditing () {
      if (!editBtn) return
      // Put the caret on the first line in view, so focusing does not jump
      // the scroll back to the top of the file.
      var lh = parseFloat(getComputedStyle(ta).lineHeight) || 20
      var rows = gutter.textContent.split('\n'), row = Math.min(rows.length - 1, Math.max(0, Math.ceil(ta.scrollTop / lh)))
      while (row > 0 && !rows[row]) row--
      var line = parseInt(rows[row], 10) || 1, at = 0
      for (var i = 1; i < line && at !== -1; i++) at = ta.value.indexOf('\n', at) + 1 || -1
      ta.readOnly = false
      editBtn.remove(); editBtn = null
      saveBtn.hidden = false
      wrap.classList.add('is-editing')
      var top = ta.scrollTop
      ta.focus({ preventScroll: true })
      ta.setSelectionRange(Math.max(0, at), Math.max(0, at))
      ta.scrollTop = top
      schedPos()
    }
    if (editBtn) editBtn.addEventListener('click', startEditing)
    moreBtn.addEventListener('click', function () {
      if (!window.RdMenu) return
      var r = moreBtn.getBoundingClientRect(), dl = $('previewDownloadBtn')
      RdMenu.open(r.right, r.bottom + 6, [
        { label: 'Wrap long lines', icon: ICON.wrap, hint: wrapOn ? 'On' : 'Off', action: function () { wrapBtn.click() } },
        { label: 'Download', icon: ICON.download, disabled: !dl || !dl.getAttribute('href'), action: function () { dl.click() } }
      ])
    })
    function paintWrap () {
      wrap.classList.toggle('is-wrap', wrapOn)
      ta.setAttribute('wrap', wrapOn ? 'soft' : 'off')
      wrapBtn.setAttribute('aria-pressed', String(wrapOn))
      scheduleGutter()
    }
    function paintLayout () {
      var win = modal.classList.contains('pv-window'), label = win ? 'Full screen' : 'Windowed view'
      layoutBtn.innerHTML = SVG + ICON[win ? 'full' : 'window'] + '</svg>'
      layoutBtn.title = label; layoutBtn.setAttribute('aria-label', label)
    }
    wrapBtn.addEventListener('click', function () { wrapOn = !wrapOn; setPref(LS_WRAP, wrapOn ? '1' : '0'); paintWrap() })
    layoutBtn.addEventListener('click', function () {
      var win = !modal.classList.contains('pv-window')
      setPref(LS_LAYOUT, win ? 'window' : 'full')
      modal.classList.toggle('pv-window', win)
      paintLayout()
    })
    ta.addEventListener('input', function () { scheduleGutter(); repaintHl(); mark() })
    ta.addEventListener('scroll', syncScroll)
    ;['keyup', 'mouseup', 'touchend', 'focus', 'input', 'select'].forEach(function (ev) { ta.addEventListener(ev, schedPos) })
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !ta.readOnly) { e.preventDefault(); insertIndent() }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!editBtn) doSave() }
    })
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { if (!isCurrent(generation)) { ro.disconnect(); return } if (wrapOn) scheduleGutter() })
      ro.observe(codeBox)
    }
    async function doSave () {
      if (!dirty || saving || !isCurrent(generation)) return
      saving = true; _saving = true
      var submittedText = ta.value
      var submittedRevision = editRevision
      saveBtn.disabled = true; setStatus('is-saving', 'Saving…')
      try {
        var res = item.is_e2e ? await saveE2E(item, submittedText, ext, encInfo) : await savePlain(item, submittedText, encInfo)
        // The server returns {'error': ...} with a 4xx/5xx and NO success key on
        // every failure path, so `res.success === false` never fired and every
        // rejection rendered "Saved" — silently dropping the edit. Only an
        // explicit success counts; anything else keeps `dirty` set so the
        // unsaved-changes guard still protects the text in the textarea.
        if (!res || res.success !== true) throw new Error((res && res.error) || 'SAVE FAILED')
        // The file changed server-side whatever happens to this preview now.
        if (window.FxPreview && window.FxPreview._onSaved) window.FxPreview._onSaved(item)
        if (!isCurrent(generation)) return
        // The download button must hand out what was just saved, not the
        // bytes the preview opened with.
        var dl = $('previewDownloadBtn')
        if (_blobUrl) { try { URL.revokeObjectURL(_blobUrl) } catch (e) {} }
        _blobUrl = URL.createObjectURL(new Blob([encodeTextBytes(submittedText, encInfo)], { type: 'text/plain' }))
        if (dl) dl.href = _blobUrl
        clean = submittedText; savedOnce = true
        dirty = ta.value !== clean; _editorDirty = dirty
        if (dirty) { setStatus('is-mod', 'Unsaved changes'); saveBtn.disabled = false } else setStatus('is-saved', 'Saved')
      } catch (e) {
        if (!isCurrent(generation)) return
        setStatus('is-err', 'Save failed'); saveBtn.disabled = false; toast('COULD NOT SAVE FILE: ' + String((e && e.message) || 'UNKNOWN ERROR').toUpperCase(), 'error')
      } finally {
        saving = false; _saving = false
      }
    }
    saveBtn.addEventListener('click', doSave)
    paintLayout()
    updPos()
    paintHl()
    // Measuring wrapped rows needs the editor in the DOM.
    requestAnimationFrame(paintWrap)
    updGutter()
    if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) requestAnimationFrame(function () { if (isCurrent(generation)) { ta.focus({ preventScroll: true }); ta.setSelectionRange(0, 0) } })
    return wrap
  }

  // Every save-content failure path answers with a 4xx/5xx + {'error': ...} and
  // no success key, so the HTTP status is the only trustworthy signal. An
  // unparseable body is treated as a failure too — better a false "save failed"
  // (the text is still in the textarea, still guarded) than a false "Saved".
  async function saveResult (r) {
    var out = null
    try { out = await r.json() } catch (e) {}
    if (!r.ok) return { success: false, error: (out && out.error) || ('SAVE FAILED (HTTP ' + r.status + ')') }
    if (!out || out.success !== true) return { success: false, error: (out && out.error) || 'SAVE FAILED: UNEXPECTED SERVER RESPONSE' }
    return out
  }

  async function savePlain (item, content, encInfo) {
    var r = await fetch('/file/' + item.id + '/save-content', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrf() }, body: encodeTextBytes(content, encInfo) })
    return saveResult(r)
  }

  async function saveE2E (item, content, ext, encInfo) {
    if (!haveKeys()) return { success: false, error: 'E2E KEYS NOT AVAILABLE' }
    var masterKey = await OneGyCrypto.getMasterKeyFromSession()

    // ---- Everything that can fail happens BEFORE any new key material is
    // minted. encryptFileForUpload() rotates the file key, so a re-wrap or a
    // filename recovery that fails after that point either locks every existing
    // share-link recipient out for good or overwrites the real filename's
    // ciphertext with a placeholder. Both are irrecoverable.
    var md = null
    try {
      var mr = await fetch('/file/' + item.id + '/manage-data', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (!mr.ok) return { success: false, error: 'COULD NOT CHECK SHARE STATUS (HTTP ' + mr.status + '). NOT SAVING' }
      md = await mr.json()
    } catch (e) { return { success: false, error: 'COULD NOT CHECK SHARE STATUS. NOT SAVING' } }

    var needFileLink = !!(md && (md.has_file_link_key || (md.is_link_shared && !md.ancestor_share_token && !md.has_folder_link_key)))
    var needFolderLink = !!(md && (md.has_folder_link_key || md.ancestor_share_token))
    var fileLinkKey = null
    var folderLinkKey = null
    if (needFileLink) {
      try {
        var fls = await OneGyCrypto.deriveLinkSecret(masterKey, 'file', item.id)
        fileLinkKey = fls && fls.linkKey
      } catch (e) { fileLinkKey = null }
      if (!fileLinkKey) return { success: false, error: 'COULD NOT DERIVE THE SHARE-LINK KEY. NOT SAVING' }
    }
    if (needFolderLink) {
      try {
        var gls = await OneGyCrypto.deriveLinkSecret(masterKey, 'folder', md.ancestor_share_token)
        folderLinkKey = gls && gls.linkKey
      } catch (e) { folderLinkKey = null }
      if (!folderLinkKey) return { success: false, error: 'COULD NOT DERIVE THE FOLDER SHARE-LINK KEY. NOT SAVING' }
    }

    // Recover the real filename. `encrypted_<id>.<ext>` is the server-side
    // PLACEHOLDER, never the real name — persisting it as the new encrypted_name
    // would destroy the only copy of the real one.
    var name = item.name
    if (!name || String(name).slice(0, 9) === 'encrypted') {
      name = null
      try {
        var kr = await fetch('/f/' + item.id + '/key-info')
        if (kr.ok) {
          var ki = await kr.json()
          if (ki && ki.encrypted_name && ki.encrypted_file_key) {
            var oldKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(ki.encrypted_file_key, ki.file_key_nonce, masterKey)
            name = await OneGyCrypto.decryptFileName(ki.encrypted_name, ki.name_nonce, oldKey)
          } else if (ki && !ki.encrypted_name) {
            // This file has no encrypted filename server-side, so item.name is
            // the real (plaintext) name even though it looks like a placeholder.
            name = item.name
          }
        }
      } catch (e) { name = null }
      if (!name) return { success: false, error: 'COULD NOT RECOVER THE ENCRYPTED FILENAME. NOT SAVING' }
    }

    // ---- Past this point the file key rotates.
    var plain = encodeTextBytes(content, encInfo)
    var up = await OneGyCrypto.encryptFileForUpload(plain, masterKey) // {encryptedBlob, encryptedFileKey, fileKeyNonce}
    var newKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(up.encryptedFileKey, up.fileKeyNonce, masterKey)
    var fd = new FormData()
    fd.append('file', up.encryptedBlob)
    fd.append('encrypted_file_key', up.encryptedFileKey)
    fd.append('file_key_nonce', up.fileKeyNonce)
    fd.append('original_size', String(plain.byteLength))

    // Re-encrypt the filename with the new key (the file key changed on save).
    var nameRes = await OneGyCrypto.encryptFileName(name, newKey)
    fd.append('encrypted_name', nameRes.encryptedName)
    fd.append('name_nonce', nameRes.nameNonce)

    if (fileLinkKey) {
      try {
        var lw = await OneGyCrypto.wrapFileKeyForLink(newKey, fileLinkKey)
        fd.append('link_encrypted_file_key', lw.encryptedFileKey)
        fd.append('link_file_key_nonce', lw.nonce)
      } catch (e) { return { success: false, error: 'COULD NOT RE-WRAP THE SHARE-LINK KEY. NOT SAVING' } }
    }
    if (folderLinkKey) {
      try {
        var fw = await OneGyCrypto.wrapFileKeyForLink(newKey, folderLinkKey)
        fd.append('folder_link_encrypted_file_key', fw.encryptedFileKey)
        fd.append('folder_link_file_key_nonce', fw.nonce)
      } catch (e) { return { success: false, error: 'COULD NOT RE-WRAP THE FOLDER SHARE-LINK KEY. NOT SAVING' } }
    }

    // File key rotated — the previous E2EE thumbnail is undecryptable. The
    // server deletes it unless a replacement arrives, so mint one from the
    // plaintext we already hold (mirrors the old dashboard save path).
    try {
      if (typeof OneGyCrypto.generateThumbnail === 'function') {
        var thumbSrc = new File([plain], name || ('file.' + (ext || 'txt')))
        var tb = await OneGyCrypto.generateThumbnail(thumbSrc)
        if (tb) {
          var td = await tb.arrayBuffer()
          var et = await OneGyCrypto.encryptThumbnail(td, newKey)
          fd.append('encrypted_thumbnail', new Blob([et.data], { type: 'application/octet-stream' }), 'thumb.enc.jpg')
          fd.append('thumbnail_nonce', et.nonce)
        }
      }
    } catch (e) {}

    var r = await fetch('/file/' + item.id + '/save-content', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrf() }, body: fd })
    var out = await saveResult(r)
    // Rotate the in-memory key ONLY once the server confirms it stored the new
    // ciphertext — otherwise every later preview/download/thumbnail decrypt in
    // this session would use a key nothing was ever encrypted with.
    if (out.success === true) { item.encrypted_file_key = up.encryptedFileKey; item.file_key_nonce = up.fileKeyNonce; item._fileKey = newKey }
    return out
  }

  // ---- Wire close ----------------------------------------------------------
  function wire () {
    var modal = $('previewModal'); if (!modal) return
    var closeBtn = $('closePreviewModal'); if (closeBtn) closeBtn.addEventListener('click', requestClose)
    // Click outside the image / editor / media (the stage padding or backdrop) closes.
    var stage = $('previewBody')
    modal.addEventListener('click', function (e) { if (e.target === modal || e.target === stage) requestClose() })
    $('previewPrev').addEventListener('click', function () { step(-1) })
    $('previewNext').addEventListener('click', function () { step(1) })
    document.addEventListener('keydown', function (e) {
      if (!modal.classList.contains('preview-visible')) return
      if (e.key === 'Escape') requestClose()
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey && galleryIndex(_current) >= 0) {
        e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1)
      }
    })
    // Horizontal swipe steps through images (not while zoomed in, pinching or
    // with the page itself pinch-zoomed).
    var sx = null, sy = 0
    stage.addEventListener('touchstart', function (e) {
      var pinched = window.visualViewport && visualViewport.scale > 1.05
      sx = e.touches.length === 1 && !_zoomed && !pinched && galleryIndex(_current) >= 0 ? e.touches[0].clientX : null
      sy = e.touches[0].clientY
    }, { passive: true })
    stage.addEventListener('touchend', function (e) {
      if (sx == null) return
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy
      sx = null
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1)
    }, { passive: true })
    if (window.visualViewport) { visualViewport.addEventListener('resize', fitViewport); visualViewport.addEventListener('scroll', fitViewport) }
    window.addEventListener('beforeunload', function (e) { if (_editorDirty || _saving) { e.preventDefault(); e.returnValue = '' } })
  }
  window.addEventListener('popstate', onPopState)
  // A UI update reload (core.js) reopens what was open (files.js boot).
  window.addEventListener('onegy:update', function (e) { if (_current) e.detail.preview = String(_current.id) })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire()

  window.FxPreview = { open: open, close: close, _onSaved: null }
})()
