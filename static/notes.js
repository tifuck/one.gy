/* ============================================================================
   notes.js — Frost Notes controller (from scratch).
   Reuses the existing /notes/api/* endpoints and window.OneGyCrypto for all
   E2EE (per-note keys; title via encryptFileName, body via encryptFileData).
   The crypto is never re-implemented here. Mirrors the proven create/save
   payloads from the legacy notes.js.
   ========================================================================== */
(function () {
  'use strict'

  var S = {
    notebooks: [], notes: [], view: 'all', noteId: null,
    noteKey: null, meta: null, ver: null, titles: {}, dirty: false, saveTimer: null,
    currentType: null, canvas: null, isSaving: false, saveAgain: false,
    editRevision: 0, openSeq: 0, pendingOpenId: null, saveFailures: 0,
    trashCount: 0, storage: null, editorReady: false, saveBlocked: false
  }
  var $ = function (id) { return document.getElementById(id) }
  var listEl, editorEl
  var longPress = null, lpFired = false
  function cancelLongPress () { if (longPress) { clearTimeout(longPress.timer); longPress = null } }

  // ---- Size budgets (mirror the server, app.py /notes/api/*) ---------------
  // NOTES_NOTE_CONTENT_MAX_BYTES in app.py: anything larger comes back as a
  // 413 that no amount of retrying will ever clear, so we refuse locally.
  var NOTES_CONTENT_MAX_BYTES = 100 * 1024 * 1024
  // encrypted_content is base64 of the AES-GCM blob, so the raw ciphertext
  // budget is 3/4 of the base64 budget. crypto.js prepends a 17-byte header
  // and adds a 16-byte tag per 64MB chunk; 2MB of headroom covers those plus
  // multi-byte UTF-8 characters (we measure plaintext in UTF-16 units).
  var NOTES_CIPHERTEXT_MAX_BYTES = Math.floor(NOTES_CONTENT_MAX_BYTES / 4) * 3
  var NOTES_BODY_MAX_BYTES = NOTES_CIPHERTEXT_MAX_BYTES - (2 * 1024 * 1024)
  // ONE aggregate write-side budget for everything that ends up inline in a
  // note body — canvas block text/paths/image data URLs and document images
  // alike. Per-item caps alone let a note grow past the server limit one image
  // at a time, and every save after that is a hard, permanent 413.
  var NOTES_INLINE_BUDGET_BYTES = NOTES_BODY_MAX_BYTES
  var NOTES_IMAGE_MAX_BYTES = 10 * 1024 * 1024
  var NOTES_IMAGE_SRC_MAX_BYTES = 16 * 1024 * 1024
  function mbLabel (bytes) { return Math.round(bytes / (1024 * 1024)) + 'MB' }

  var NOTE_TAGS = { a: 1, abbr: 1, b: 1, blockquote: 1, br: 1, caption: 1, code: 1, col: 1, colgroup: 1, dd: 1, del: 1, div: 1, dl: 1, dt: 1, em: 1, figcaption: 1, figure: 1, font: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, hr: 1, i: 1, img: 1, input: 1, ins: 1, kbd: 1, li: 1, mark: 1, ol: 1, p: 1, pre: 1, q: 1, s: 1, samp: 1, small: 1, span: 1, strike: 1, strong: 1, sub: 1, sup: 1, table: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, tr: 1, u: 1, ul: 1, var: 1, wbr: 1 }
  var DANGEROUS_TAGS = { script: 1, style: 1, iframe: 1, object: 1, embed: 1, applet: 1, form: 1, link: 1, meta: 1, base: 1, frame: 1, frameset: 1, noscript: 1, template: 1, svg: 1, math: 1, title: 1, button: 1, textarea: 1, select: 1, option: 1 }
  var GLOBAL_ATTRS = { style: 1, class: 1, align: 1, title: 1, dir: 1, lang: 1, spellcheck: 1 }
  var TAG_ATTRS = { a: { href: 1, target: 1, rel: 1 }, img: { src: 1, alt: 1, width: 1, height: 1 }, td: { colspan: 1, rowspan: 1, headers: 1, scope: 1 }, th: { colspan: 1, rowspan: 1, headers: 1, scope: 1 }, col: { span: 1, width: 1 }, colgroup: { span: 1, width: 1 }, font: { color: 1, face: 1, size: 1 }, ol: { start: 1, type: 1 }, ul: { type: 1 } }
  var SAFE_NOTE_CLASSES = { 'notes-checklist-item': 1, 'notes-code-block': 1, 'notes-code-header': 1, 'notes-code-lang': 1, 'notes-code-copy': 1, 'notes-code-delete': 1, 'notes-attachment-chip': 1, 'notes-attachment-icon': 1, 'notes-attachment-name': 1, 'notes-attachment-size': 1 }
  var SAFE_NOTE_DATA_ATTRS = { 'data-file-id': 1, 'data-file-name': 1, 'data-file-ext': 1, 'data-file-e2e': 1, 'data-file-previewable': 1 }

  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  // The server only accepts strict #RRGGBB; mirror that before it reaches a
  // style attribute so a bad value can never be injected into the markup.
  function normColor (v) { return (typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v.trim())) ? v.trim().toUpperCase() : null }
  var NOTE_COLORS = [
    { color: null, label: 'No colour' },
    { color: '#DE1833', label: 'Red' },
    { color: '#E67E22', label: 'Orange' },
    { color: '#F1C40F', label: 'Yellow' },
    { color: '#27AE60', label: 'Green' },
    { color: '#3498DB', label: 'Blue' },
    { color: '#9B59B6', label: 'Purple' },
    { color: '#E91E8F', label: 'Pink' }
  ]
  function csrf () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : '' }
  function toast (m, c) { if (window.showToast) window.showToast(m, c) }
  function safeUrl (raw, image) {
    if (typeof raw !== 'string') return ''
    var value = raw.trim().replace(/[\u0000-\u001f\u007f\s]+/g, '')
    if (!value) return ''
    if (image && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(value)) return value
    try { var parsed = new URL(value, window.location.origin); if (!image && (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:')) return parsed.href } catch (e) {}
    return ''
  }
  function sanitizeNodeTree (root) {
    function clean (node) {
      if (node.nodeType === Node.COMMENT_NODE) { node.remove(); return }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      var tag = node.tagName.toLowerCase()
      if (DANGEROUS_TAGS[tag]) { node.remove(); return }
      if (tag === 'input' && String(node.getAttribute('type') || '').toLowerCase() !== 'checkbox') { node.remove(); return }
      Array.prototype.slice.call(node.childNodes).forEach(clean)
      if (!NOTE_TAGS[tag]) { var parent = node.parentNode; if (parent) { while (node.firstChild) parent.insertBefore(node.firstChild, node); node.remove() }; return }
      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase(), value = attr.value.trim()
        if (tag === 'input') {
          if (name === 'type') node.setAttribute('type', 'checkbox')
          else if (name !== 'checked' && name !== 'disabled') node.removeAttribute(attr.name)
        } else if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'id' || name === 'name' || name === 'contenteditable') node.removeAttribute(attr.name)
        else if (name === 'href') { var href = safeUrl(value, false); if (!href) node.removeAttribute(attr.name); else { node.setAttribute('href', href); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer') } }
        else if (name === 'src') { var src = tag === 'img' && safeUrl(value, true); if (src) node.setAttribute('src', src); else node.removeAttribute(attr.name) }
        else if (name === 'target') node.setAttribute('target', '_blank')
        else if (name === 'rel') node.setAttribute('rel', 'noopener noreferrer')
        else if (name === 'class') { var classes = value.split(/\s+/).filter(function (className) { return SAFE_NOTE_CLASSES[className] }); if (classes.length) node.className = classes.join(' '); else node.removeAttribute('class') }
        else if (name === 'style') {
          var safe = value.split(';').map(function (part) { var pair = part.split(':'); if (pair.length < 2) return ''; var prop = pair.shift().trim().toLowerCase(), val = pair.join(':').trim(); if (!/^(color|background-color|font-weight|font-style|text-align)$/.test(prop) || /url\s*\(|expression\s*\(|javascript\s*:/i.test(val)) return ''; return prop + ':' + val }).filter(Boolean).join(';')
          if (safe) node.setAttribute('style', safe); else node.removeAttribute('style')
        } else if ((name.indexOf('data-') === 0 && !SAFE_NOTE_DATA_ATTRS[name]) || (name.indexOf('data-') !== 0 && !GLOBAL_ATTRS[name] && !(TAG_ATTRS[tag] && TAG_ATTRS[tag][name]))) node.removeAttribute(attr.name)
      })
    }
    Array.prototype.slice.call(root.childNodes).forEach(clean)
  }
  function sanitizeToFragment (html) {
    var template = document.createElement('template'); template.innerHTML = String(html || '')
    sanitizeNodeTree(template.content)
    return template.content
  }
  function sanitizeHtml (html) {
    var wrap = document.createElement('div')
    wrap.appendChild(sanitizeToFragment(html))
    return wrap.innerHTML
  }
  function validateCanvasData (data) {
    var types = { text: 1, image: 1, todo: 1, table: 1, code: 1, draw: 1, line: 1, attachment: 1 }
    if (!data || typeof data !== 'object' || !Array.isArray(data.blocks) || data.blocks.length > 1000) return null
    var ids = {}, totalCells = 0, totalItems = 0, totalPaths = 0, totalPoints = 0, totalText = 0
    for (var i = 0; i < data.blocks.length; i++) {
      var block = data.blocks[i]
      if (!block || typeof block !== 'object' || !types[block.type || 'text']) return null
      var blockId = String(block.id == null ? '' : block.id)
      if (!blockId || blockId.length > 120 || ids[blockId]) return null
      ids[blockId] = true
      var invalidGeometry = false
      ;['x', 'y', 'w', 'h', 'rotation', 'zIndex'].forEach(function (key) { if (block[key] != null && !Number.isFinite(Number(block[key]))) invalidGeometry = true })
      if (invalidGeometry || Number(block.w || 1) > 100000 || Number(block.h || 1) > 100000) return null
      if (block.type === 'table') {
        var rows = Number(block.rows), cols = Number(block.cols)
        if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || rows > 100 || cols < 1 || cols > 30) return null
        totalCells += rows * cols
      }
      if (typeof block.content === 'string') { if (block.content.length > 2 * 1024 * 1024) return null; totalText += block.content.length }
      if (typeof block.code === 'string') { if (block.code.length > 2 * 1024 * 1024) return null; totalText += block.code.length }
      if (typeof block.pathData === 'string') { if (block.pathData.length > 5 * 1024 * 1024) return null; totalText += block.pathData.length }
      if (Array.isArray(block.items)) { if (block.items.length > 2000) return null; totalItems += block.items.length; block.items.forEach(function (item) { totalText += String(item && item.text || '').length }) }
      if (Array.isArray(block.cells) && block.cells.length > 100) return null
      if (Array.isArray(block.cells)) block.cells.forEach(function (row) { if (Array.isArray(row)) row.forEach(function (cell) { totalText += String(cell || '').length }) })
      if (Array.isArray(block.paths)) { totalPaths += block.paths.length; block.paths.forEach(function (path) { totalText += String(path && path.d || '').length }) }
      if (Array.isArray(block.points)) { if (block.points.length > 100000) return null; totalPoints += block.points.length }
      // Image data URLs must count towards the SAME accumulator as everything
      // else: checking block.src per block let 1000 image blocks through
      // untotalled. The aggregate ceiling here is the SERVER limit, not the
      // tighter write-side NOTES_INLINE_BUDGET_BYTES — this function also runs
      // on load, and rejecting a canvas the server happily stored would lock
      // the owner out of their own note.
      if (typeof block.src === 'string') { if (block.src.length > NOTES_IMAGE_SRC_MAX_BYTES) return null; totalText += block.src.length }
      if (totalCells > 20000 || totalItems > 20000 || totalPaths > 20000 || totalPoints > 200000 || totalText > NOTES_CONTENT_MAX_BYTES) return null
    }
    return data
  }
  function haveKeys () { return typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys && OneGyCrypto.hasSessionKeys() }
  function headers () { return { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' } }
  async function apiGet (u) { var r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }); if (!r.ok) throw new Error(u); return r.json() }
  async function apiSend (m, u, b) {
    var r = await fetch(u, { method: m, headers: headers(), body: b ? JSON.stringify(b) : undefined })
    if (!r.ok) {
      var body = {}; try { body = await r.json() } catch (x) {}
      var err = new Error(body.error || ('HTTP ' + r.status)); err.status = r.status; err.body = body
      throw err
    }
    return r.json().catch(function () { return {} })
  }

  async function masterKey () { try { return await OneGyCrypto.getMasterKeyFromSession() } catch (e) { return null } }

  // ---- Crypto (reuse) ------------------------------------------------------
  async function decTitle (n, mk) {
    try {
      var nk = await OneGyCrypto.unwrapFileKeyWithMasterKey(n.encrypted_note_key, n.note_key_nonce, mk)
      var t = await OneGyCrypto.decryptFileName(n.encrypted_title, n.title_nonce, nk)
      return t
    } catch (e) { return null }
  }
  async function decNotebookName (nb, mk) {
    if (!nb.encrypted_name) return nb.name || 'Notebook'
    try { var k = await OneGyCrypto.unwrapFolderNameKey(nb.encrypted_name_key, nb.name_key_nonce, mk); return (await OneGyCrypto.decryptFolderName(nb.encrypted_name, nb.name_nonce, k)) || 'Notebook' } catch (e) { return 'Notebook' }
  }
  async function encContent (str, nk) {
    var data = new TextEncoder().encode(str)
    var enc = await OneGyCrypto.encryptFileData(data, nk)
    var bytes = new Uint8Array(enc), bin = ''
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }
  async function decContent (b64, nk) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    var dec = await OneGyCrypto.decryptFileData(bytes.buffer, nk)
    return new TextDecoder().decode(dec)
  }
  // The server requires encrypted_content and content_nonce as a pair (app.py
  // _notes_validate_content_field). The base nonce already lives in the blob
  // header (crypto.js: 1 version byte + 4 chunkCount + 12 baseNonce), so ship
  // a copy from bytes 5..17; the server stores it as metadata and never uses
  // it to decrypt.
  function contentNonceOf (b64) {
    var bin = atob(b64)
    if (bin.length < 17) throw new Error('BAD ENCRYPTED CONTENT HEADER')
    return btoa(bin.slice(5, 17))
  }

  // ---- Load / render -------------------------------------------------------
  async function loadAll () {
    if (!haveKeys()) { showLock(true); return }
    showLock(false)
    var mk = await masterKey(); if (!mk) { showLock(true); return }
    try {
      var nbData = await apiGet('/notes/api/notebooks')
      S.notebooks = nbData.notebooks || []
      await Promise.all(S.notebooks.map(async function (nb) { nb._name = await decNotebookName(nb, mk) }))
      S.trashCount = nbData.trash_count || 0
      if (nbData.storage_used_bytes != null) S.storage = { used: nbData.storage_used_bytes, limit: nbData.storage_limit_gb }
      renderRail(true)
      await loadNotes()
    } catch (e) { listEl.innerHTML = errState('Could not load notebooks.') }
  }

  var loadNotesSeq = 0
  async function loadNotes () {
    var seq = ++loadNotesSeq  // a later view switch supersedes this response
    var mk = await masterKey(); if (!mk || seq !== loadNotesSeq) return
    var url = '/notes/api/notes'
    if (S.view === 'trash') url += '?trash=true'
    else if (S.view === 'unfiled') url += '?notebook_id=unfiled'
    else if (S.view !== 'all') url += '?notebook_id=' + S.view
    listEl.innerHTML = '<div class="nt-skel-list" aria-hidden="true">' + new Array(7).join('<div class="rd-skel nt-skel-item"></div>') + '</div>'
    try {
      var d = await apiGet(url)
      if (seq !== loadNotesSeq) return
      var notes = d.notes || []
      await Promise.all(notes.map(async function (n) { if (n.encrypted_title) { var t = await decTitle(n, mk); S.titles[n.id] = t || 'Untitled'; n._title = S.titles[n.id] } else n._title = n.title || 'Untitled' }))
      if (seq !== loadNotesSeq) return
      S.notes = notes
      renderList(null, true)
    } catch (e) { if (seq === loadNotesSeq) listEl.innerHTML = errState('Could not load notes.') }
  }

  function renderRail (animate) {
    // Entrance only on the initial load — view switches re-render the rail for
    // the active state and must not replay it
    var rail = $('ntRail'); if (!rail) return
    rail.classList.toggle('is-anim', !!animate)
    var sys = '<button type="button" class="nt-rail-item rd-side-row' + (S.view === 'all' ? ' is-active' : '') + '" data-view="all"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg><span class="nt-nb-name">All notes</span></button>' +
      '<button type="button" class="nt-rail-item rd-side-row' + (S.view === 'unfiled' ? ' is-active' : '') + '" data-view="unfiled"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2z"/></svg><span class="nt-nb-name">Unfiled</span></button>'
    var nbs = S.notebooks.filter(function (n) { return !n.is_trashed }).map(function (nb) {
      return '<button type="button" class="nt-rail-item rd-side-row nt-nb' + (String(S.view) === String(nb.id) ? ' is-active' : '') + '" data-view="' + nb.id + '"><span class="nt-nb-dot" style="background:' + esc(nb.color || 'var(--accent)') + '"></span><span class="nt-nb-name">' + esc(nb._name) + '</span><span class="nt-nb-count">' + (nb.note_count || 0) + '</span></button>'
    }).join('')
    var trash = '<button type="button" class="rd-side-trash' + (S.view === 'trash' ? ' is-active' : '') + '" data-view="trash"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>Trash<span class="rd-side-trash-count" id="ntTrashCount"' + (S.trashCount > 0 ? '' : ' hidden') + '>' + (S.trashCount || 0) + '</span></button>'
    rail.innerHTML = '<div class="rd-side-inner">' +
      '<div class="rd-side-head">Library</div>' +
      '<nav class="nt-rail-scroll rd-side-scroll" aria-label="Notebooks">' + sys +
        '<div class="rd-side-subhead"><span>Notebooks</span><button type="button" id="ntNewNb" title="New notebook" aria-label="New notebook"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></div>' +
        (nbs || '<div class="rd-side-hint">No notebooks</div>') +
      '</nav>' +
      '<div class="rd-side-foot">' + trash +
        '<div class="rd-side-storage"><span>Storage</span><b id="ntStorageTxt">— / —</b></div>' +
        '<div class="rd-meter"><div class="rd-meter-fill" id="ntMeter" style="width:0%"></div></div>' +
      '</div></div>'
    if (animate) {
      var kids = rail.querySelectorAll('.rd-side-scroll > *, .rd-side-foot > *')
      for (var i = 0; i < kids.length; i++) kids[i].style.setProperty('--i', i)
    }
    renderStorage()
  }

  function fmtBytes (b) { if (!b) return '0 B'; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024))); return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i] }
  function renderStorage () {
    if (!S.storage || S.storage.used == null) return
    var used = S.storage.used, lim = S.storage.limit
    var txt = $('ntStorageTxt'); if (txt) txt.textContent = fmtBytes(used) + ' / ' + lim + ' GB'
    var pct = lim > 0 ? Math.min(100, (used / (lim * 1073741824)) * 100) : 0
    var f = $('ntMeter'); if (!f) return
    f.style.width = pct + '%'
    f.classList.toggle('is-warn', pct >= 75 && pct < 90)
    f.classList.toggle('is-bad', pct >= 90)
  }

  function renderList (query, animate) {
    // Entrance only on fresh data loads — note clicks / search re-renders
    // rebuild the list for highlight state and must not replay it
    listEl.classList.toggle('is-anim', !!animate)
    var head = '<div class="nt-list-head"><button class="nt-rail-toggle" id="ntRailToggle" aria-label="Notebooks"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button><h2 class="nt-list-title">' + esc(viewTitle()) + '</h2>' +
      (S.view !== 'trash' ? '<span class="nt-newgroup"><button class="nt-newnote" id="ntNewCanvas" title="New canvas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button><button class="nt-newnote" id="ntNewNote" title="New note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button></span>' : '') + '</div>' +
      '<div class="nt-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input type="search" id="ntSearch" placeholder="Search notes…" autocomplete="off"></div>'
    var notes = S.notes.slice()
    var searchValue = query == null ? (($('ntSearch') && $('ntSearch').value) || '') : query
    var q = searchValue.toLowerCase()
    if (q) notes = notes.filter(function (n) { return (n._title || '').toLowerCase().indexOf(q) >= 0 })
    notes.sort(function (a, b) { return (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0) || ((b.updated_at || '') < (a.updated_at || '') ? -1 : 1) })
    var items = notes.map(function (n) {
      var col = normColor(n.color)
      return '<button class="nt-item' + (col ? ' has-color' : '') + (n.id === S.noteId ? ' is-active' : '') + '" data-note="' + esc(n.id) + '"' +
        (col ? ' style="--nt-color:' + col + '"' : '') + '>' +
        (col ? '<span class="nt-item-bar"></span>' : '') +
        '<span class="nt-item-row"><span class="nt-item-title">' + (n.is_pinned ? '<svg class="nt-pin" viewBox="0 0 24 24" fill="currentColor"><path d="M14 4v6l3 3v2H7v-2l3-3V4z"/></svg>' : '') + '<span class="nt-item-name">' + esc(n._title || 'Untitled') + '</span></span>' +
        (n.note_type === 'canvas' ? '<span class="nt-badge">Canvas</span>' : '') + '</span>' +
        '<span class="nt-item-meta">' + esc(fmtDate(n.updated_at)) + (n.received_from ? ' · from ' + esc(n.received_from) : '') + '</span></button>'
    }).join('')
    listEl.innerHTML = head + '<div class="nt-items">' + (items || '<div class="nt-empty-sm">No notes here yet.</div>') + '</div>'
    if (animate) { var its = listEl.querySelectorAll('.nt-item'); for (var ii = 0; ii < its.length; ii++) its[ii].style.setProperty('--i', ii) }
    if (searchValue && $('ntSearch')) { $('ntSearch').value = searchValue; $('ntSearch').focus(); $('ntSearch').setSelectionRange(searchValue.length, searchValue.length) }
  }
  function viewTitle () {
    if (S.view === 'all') return 'All notes'; if (S.view === 'unfiled') return 'Unfiled'; if (S.view === 'trash') return 'Trash'
    var nb = S.notebooks.filter(function (n) { return String(n.id) === String(S.view) })[0]; return nb ? nb._name : 'Notes'
  }

  // ---- Editor --------------------------------------------------------------
  // Every path that leaves or abandons an open note MUST go through this.
  // Leaving the previous note's #ntBody (and its markDirty listener) mounted
  // while S.noteId already pointed at the next note is what let a keystroke
  // encrypt note A's body under A's key and PUT it over note B — permanently
  // bricking B. Unmounting the DOM drops the listeners with it, and clearing
  // the key material means saveNote() can no longer pass its preconditions.
  function resetOpenState (html) {
    clearTimeout(S.saveTimer); S.saveTimer = null
    S.saveAgain = false; S.saveBlocked = false
    S.editRevision++
    S.dirty = false
    destroyCanvas()
    S.noteKey = null; S.meta = null; S.ver = null; S.currentType = null; S.editorReady = false
    if (editorEl) editorEl.innerHTML = html == null ? '' : html
  }

  async function openNote (id) {
    // Monotonic open token, taken at ENTRY: every await below re-checks it so
    // a superseded open can never write its note into the current editor.
    var seq = ++S.openSeq
    S.pendingOpenId = id
    if (S.canvas && S.canvas.flush) S.canvas.flush()
    if (S.dirty) await saveNote()
    if (seq !== S.openSeq) return
    if (S.dirty) {
      // A save is still in flight or a retry is queued — saveNote's finally
      // re-opens S.pendingOpenId for us. Only a save that can NEVER succeed
      // (413 / other non-retryable 4xx / 409) is allowed to prompt, so one
      // unsaveable note can no longer wedge the whole app.
      if (!S.saveBlocked || S.isSaving) return
      if (!(await confirmAbandonUnsaved())) return
      if (seq !== S.openSeq) return
    }
    if (S.pendingOpenId !== id) { openNote(S.pendingOpenId); return }
    resetOpenState()
    S.noteId = id
    renderList()
    // Seamless switch: dim the outgoing note and hold the spinner back so
    // fast opens (cache/local) swap directly without a loading flash
    editorEl.classList.add('nt-ed-busy')
    var spinT = setTimeout(function () { if (seq === S.openSeq) editorEl.innerHTML = '<div class="nt-ed-loading"><span class="nt-spin"></span></div>' }, 180)
    var endBusy = function () { clearTimeout(spinT); editorEl.classList.remove('nt-ed-busy') }
    var fail = function (msg) { endBusy(); resetOpenState(errState(msg)) }
    var mk = await masterKey()
    if (seq !== S.openSeq) return
    if (!mk) { fail('Your encryption keys are locked. Unlock them and open the note again.'); return }
    var n = S.notes.filter(function (x) { return x.id === id })[0]
    if (!n) { fail('That note is no longer in this list.'); return }
    try {
      var noteKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(n.encrypted_note_key, n.note_key_nonce, mk)
      if (seq !== S.openSeq) return
      var d = await apiGet('/notes/api/notes/' + encodeURIComponent(id))
      if (seq !== S.openSeq) return
      // The list entry may be stale (another tab renamed or re-keyed the note);
      // the title must come from the same fetch as the version we will save over.
      if (d.encrypted_note_key && d.encrypted_note_key !== n.encrypted_note_key) {
        noteKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(d.encrypted_note_key, d.note_key_nonce, mk)
        if (seq !== S.openSeq) return
      }
      if (d.encrypted_title) {
        var freshTitle = null
        try { freshTitle = await OneGyCrypto.decryptFileName(d.encrypted_title, d.title_nonce, noteKey) } catch (e) {}
        if (seq !== S.openSeq) return
        if (freshTitle) { S.titles[id] = freshTitle; n._title = freshTitle }
      }
      var content = ''
      if (d.encrypted_content) content = await decContent(d.encrypted_content, noteKey)
      if (seq !== S.openSeq || S.pendingOpenId !== id) return
      S.noteKey = noteKey; S.meta = d; S.ver = d.content_version || 1
      if (d.note_type === 'canvas') {
        var canvasData
        try { canvasData = validateCanvasData(JSON.parse(content || '{"blocks":[]}')) } catch (e) { canvasData = null }
        if (!canvasData) { fail('Canvas data is invalid. This note was not changed.'); return }
        endBusy()
        renderCanvasNote(n._title || S.titles[id] || 'Untitled', canvasData, S.view === 'trash'); return
      }
      endBusy()
      renderEditor(n._title || S.titles[id] || 'Untitled', content, S.view === 'trash')
    } catch (e) { if (seq === S.openSeq) fail('Could not decrypt this note. It was not changed.') }
  }
  function renderEditor (title, html, readonly) {
    S.currentType = 'document'
    var tools = readonly ? '' :
      '<div class="nt-toolbar" role="toolbar" aria-label="NOTE FORMATTING">' +
      tbtn('undo', '↶', 'UNDO') + tbtn('redo', '↷', 'REDO') + '<span class="nt-tb-sep"></span>' +
      tbtn('bold', 'B', 'BOLD', 'font-weight:800') + tbtn('italic', 'I', 'ITALIC', 'font-style:italic') + tbtn('underline', 'U', 'UNDERLINE', 'text-decoration:underline') + tbtn('strikeThrough', 'S', 'STRIKETHROUGH', 'text-decoration:line-through') +
      '<span class="nt-tb-sep"></span>' +
      tbtn2('formatBlock', 'H1', 'HEADING 1', '<h1>') + tbtn2('formatBlock', 'H2', 'HEADING 2', '<h2>') + tbtn2('formatBlock', 'H3', 'HEADING 3', '<h3>') + tbtn2('formatBlock', '❝', 'QUOTE', '<blockquote>') + tbtn2('formatBlock', '&lt;/&gt;', 'CODE BLOCK', '<pre>') +
      '<span class="nt-tb-sep"></span>' +
      tbtn('insertUnorderedList', '•', 'BULLET LIST') + tbtn('insertOrderedList', '1.', 'NUMBERED LIST') +
      '<span class="nt-tb-sep"></span>' +
      '<button class="nt-tb-btn" data-link title="INSERT LINK">LINK</button><button class="nt-tb-btn" data-image title="INSERT IMAGE">IMAGE</button>' +
      '<label class="nt-tb-color" title="TEXT COLOR"><span>A</span><input type="color" data-color="foreColor" value="#0f1720"></label><label class="nt-tb-color" title="HIGHLIGHT"><span>▰</span><input type="color" data-color="hiliteColor" value="#faef5a"></label>' +
      '<button class="nt-tb-btn" data-cmd="removeFormat" title="CLEAR FORMATTING">⌫</button>' +
      '<input type="file" id="ntImageInput" accept="image/*" hidden>' +
      '</div>'
    editorEl.innerHTML =
      '<div class="nt-ed-head">' +
        '<button class="nt-back" id="ntBackBtn" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>' +
        '<input class="nt-ed-title" id="ntTitle" value="' + esc(title) + '" placeholder="Untitled"' + (readonly ? ' readonly' : '') + '>' +
        '<div class="nt-ed-actions">' +
          '<span class="nt-savestate" id="ntSaveState"></span>' +
          (readonly ? '<button class="rd-btn rd-btn-ghost" data-restore>Restore</button><button class="rd-btn acc-btn-danger" data-delete-perm style="color:var(--bad)">Delete forever</button>' :
            '<button class="rd-icon-btn" data-pin title="Pin"><svg viewBox="0 0 24 24" width="17" height="17" fill="' + (S.meta && S.meta.is_pinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2"><path d="M14 4v6l3 3v2H7v-2l3-3V4z"/></svg></button>' +
            '<button class="rd-icon-btn" data-delete title="Move to trash"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>') +
        '</div>' +
      '</div>' + tools +
      '<div class="nt-ed-body" id="ntBody" ' + (readonly ? '' : 'contenteditable="true"') + ' spellcheck="true"></div>'
    var body = $('ntBody')
    if (body) { body.appendChild(sanitizeToFragment(html)); inkHighlights(body) }
    wireEditor(readonly)
  }
  function renderCanvasNote (title, data, readonly) {
    S.currentType = 'canvas'
    editorEl.innerHTML =
      '<div class="nt-ed-head">' +
        '<button class="nt-back" id="ntBackBtn" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>' +
        '<input class="nt-ed-title" id="ntTitle" value="' + esc(title) + '" placeholder="Untitled canvas"' + (readonly ? ' readonly' : '') + '>' +
        '<div class="nt-ed-actions"><span class="nt-savestate" id="ntSaveState"></span>' +
        (readonly ? '<button class="rd-btn rd-btn-ghost" data-restore>Restore</button><button class="rd-btn acc-btn-danger" data-delete-perm style="color:var(--bad)">Delete forever</button>' :
          '<button class="rd-icon-btn" data-pin title="Pin"><svg viewBox="0 0 24 24" width="17" height="17" fill="' + (S.meta && S.meta.is_pinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2"><path d="M14 4v6l3 3v2H7v-2l3-3V4z"/></svg></button>' +
          '<button class="rd-icon-btn" data-delete title="Move to trash"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>') +
        '</div>' +
      '</div>' +
      '<div class="nt-canvas-mount" id="ntCanvas"></div>'
    S.editorReady = false
    if (typeof FxCanvas !== 'undefined') {
      try { S.canvas = FxCanvas.mount($('ntCanvas'), { data: data, readonly: readonly, onDirty: function () { if (!readonly) markDirty() } }) } catch (e) { S.canvas = null }
    }
    var pin = editorEl.querySelector('[data-pin]'); if (pin) pin.onclick = togglePin
    var del = editorEl.querySelector('[data-delete]'); if (del) del.onclick = function () { deleteNote(false) }
    var rb = editorEl.querySelector('[data-restore]'); if (rb) rb.onclick = restoreNote
    var dp = editorEl.querySelector('[data-delete-perm]'); if (dp) dp.onclick = function () { deleteNote(true) }
    // If the canvas engine never mounted there is no #ntBody either, so a save
    // would serialise this note as an empty body. Do NOT arm markDirty on the
    // title in that state — one keystroke used to be enough to wipe the note.
    if (!S.canvas) {
      $('ntCanvas').innerHTML = errState('Canvas engine failed to load. Reload the page — this note was not changed.')
      setSaveState('Read-only')
      return
    }
    if (!readonly && $('ntTitle')) { $('ntTitle').addEventListener('input', markDirty); S.editorReady = true }
  }
  function tbtn (cmd, label, title, style) { return '<button class="nt-tb-btn" data-cmd="' + cmd + '" title="' + title + '"' + (style ? ' style="' + style + '"' : '') + '>' + label + '</button>' }
  function tbtn2 (cmd, label, title, arg) { return '<button class="nt-tb-btn" data-cmd="' + cmd + '" data-arg="' + esc(arg) + '" title="' + title + '">' + label + '</button>' }

  function wireEditor (readonly) {
    if (readonly) {
      var rb = editorEl.querySelector('[data-restore]'); if (rb) rb.onclick = restoreNote
      var dp = editorEl.querySelector('[data-delete-perm]'); if (dp) dp.onclick = function () { deleteNote(true) }
      return
    }
    editorEl.querySelectorAll('.nt-tb-btn').forEach(function (b) {
      b.onmousedown = function (e) { e.preventDefault() }
      if (b.hasAttribute('data-image')) b.onclick = function () { $('ntImageInput').click() }
      else if (b.hasAttribute('data-link')) b.onclick = function () { var url = window.prompt('ENTER LINK URL'); url = safeUrl(url, false); if (url) { document.execCommand('createLink', false, url); markDirty() } }
      else b.onclick = function () { var cmd = b.getAttribute('data-cmd'), arg = b.getAttribute('data-arg'); document.execCommand(cmd, false, arg || null); markDirty() }
    })
    editorEl.querySelectorAll('[data-color]').forEach(function (input) { input.oninput = function () { document.execCommand(input.dataset.color, false, input.value); inkHighlights($('ntBody')); markDirty() } })
    $('ntTitle').addEventListener('input', markDirty)
    $('ntBody').addEventListener('input', markDirty)
    $('ntBody').addEventListener('change', function (event) {
      var checkbox = event.target.closest && event.target.closest('input[type="checkbox"]')
      if (!checkbox) return
      if (checkbox.checked) checkbox.setAttribute('checked', '')
      else checkbox.removeAttribute('checked')
      markDirty()
    })
    $('ntBody').addEventListener('paste', documentPaste)
    $('ntBody').addEventListener('dragover', function (event) { event.preventDefault() })
    $('ntBody').addEventListener('drop', documentDrop)
    $('ntImageInput').onchange = function () { var file = firstImageFile(this.files); if (file) insertDocumentImage(file); this.value = '' }
    var pin = editorEl.querySelector('[data-pin]'); if (pin) pin.onclick = togglePin
    var del = editorEl.querySelector('[data-delete]'); if (del) del.onclick = function () { deleteNote(false) }
    S.editorReady = true
  }
  function markDirty () {
    // Never arm a save against an editor that is not fully mounted — the body
    // would serialise as '' and overwrite the note.
    if (!S.editorReady) return
    S.editRevision++; S.dirty = true; setSaveState('Unsaved')
    if (S.isSaving) { S.saveAgain = true; return }
    clearTimeout(S.saveTimer); S.saveTimer = setTimeout(saveNote, 1100)
  }
  function setSaveState (t) { var e = $('ntSaveState'); if (e) e.textContent = t }
  function firstImageFile (files) { return Array.prototype.slice.call(files || []).filter(function (file) { return file && /^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.type) })[0] || null }
  function hasImageFile (files) { return !!firstImageFile(files) }
  function documentInlineSize () { var el = $('ntBody'); return el ? (el.innerHTML || '').length : 0 }
  function budgetToast () { toast('NOTE IS FULL (LIMIT ' + mbLabel(NOTES_INLINE_BUDGET_BYTES) + ') — REMOVE AN IMAGE FIRST', 'error') }
  function insertDocumentImage (file) {
    if (!file || file.size > NOTES_IMAGE_MAX_BYTES) { toast('IMAGE TOO LARGE (MAX ' + mbLabel(NOTES_IMAGE_MAX_BYTES) + ')', 'error'); return }
    // A per-image cap with no total budget lets a note grow past the server
    // limit one image at a time, and every save after that is a hard 413.
    // base64 costs 4 bytes per 3, plus the data: URL prefix.
    if (documentInlineSize() + Math.ceil(file.size / 3) * 4 + 64 > NOTES_INLINE_BUDGET_BYTES) { budgetToast(); return }
    var reader = new FileReader(), sourceId = S.noteId, sourceSeq = S.openSeq, sourceBody = $('ntBody')
    reader.onload = function () {
      if (S.noteId !== sourceId || S.openSeq !== sourceSeq || !sourceBody || !sourceBody.isConnected || sourceBody !== $('ntBody')) return
      var dataUrl = String(reader.result || '')
      if (!dataUrl || documentInlineSize() + dataUrl.length > NOTES_INLINE_BUDGET_BYTES) { budgetToast(); return }
      var img = document.createElement('img'); img.src = dataUrl; img.alt = file.name || 'NOTE IMAGE'; img.style.maxWidth = '100%'; img.style.height = 'auto'; var selection = window.getSelection(); if (selection && selection.rangeCount && sourceBody.contains(selection.anchorNode)) { var range = selection.getRangeAt(0); range.deleteContents(); range.insertNode(img); range.setStartAfter(img); range.collapse(true); selection.removeAllRanges(); selection.addRange(range) } else sourceBody.appendChild(img); markDirty()
    }
    reader.onerror = function () { if (S.noteId === sourceId) toast('COULD NOT READ IMAGE', 'error') }
    reader.readAsDataURL(file)
  }
  function insertSanitizedHtml (html, text) {
    var frag = sanitizeToFragment(html || '')
    if (!frag.childNodes.length) {
      document.execCommand('insertText', false, text || '')
      return
    }
    var sel = window.getSelection()
    var body = $('ntBody')
    if (sel && sel.rangeCount && body && body.contains(sel.anchorNode)) {
      var range = sel.getRangeAt(0)
      range.deleteContents()
      range.insertNode(frag)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    } else if (body) body.appendChild(frag)
  }
  function documentPaste (event) {
    var file = firstImageFile(event.clipboardData && event.clipboardData.files)
    if (file) { event.preventDefault(); insertDocumentImage(file); return }
    event.preventDefault(); insertSanitizedHtml(event.clipboardData && event.clipboardData.getData('text/html'), event.clipboardData && event.clipboardData.getData('text/plain')); markDirty()
  }
  function documentDrop (event) {
    event.preventDefault()
    var file = firstImageFile(event.dataTransfer && event.dataTransfer.files)
    if (file) { insertDocumentImage(file); return }
    insertSanitizedHtml(event.dataTransfer && event.dataTransfer.getData('text/html'), event.dataTransfer && event.dataTransfer.getData('text/plain'))
    markDirty()
  }
  // ---- Unsaved-work rescue -------------------------------------------------
  // ZERO-KNOWLEDGE CONSTRAINT: the unsaved body is PLAINTEXT note content, so
  // it must never be parked in localStorage/IndexedDB as a "draft" — that
  // leaves cleartext notes on disk for anyone with the device, which is the
  // exact threat the E2EE model exists to remove, and nothing in this app ever
  // cleans it up. So the escape hatch is transient and user-directed instead:
  // the content is copied to the clipboard AND offered as a one-shot Blob
  // download (object URL, revoked straight after). Both are in-memory,
  // user-initiated, and land wherever the USER chooses. Only after that do we
  // ask for the second, explicit confirmation to discard.
  function rescuePayload () {
    var body = readEditorBody(S.currentType)
    if (body == null) return null
    var titleEl = $('ntTitle')
    var title = String((titleEl && titleEl.value) || S.titles[S.noteId] || 'Untitled').trim() || 'Untitled'
    var isCanvas = S.currentType === 'canvas'
    var stem = title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'note'
    return {
      text: isCanvas ? body : '<!doctype html>\n<meta charset="utf-8">\n<title>' + esc(title) + '</title>\n' + body,
      name: 'onegy-unsaved-' + stem + '-' + Date.now() + (isCanvas ? '.json' : '.html')
    }
  }
  function downloadRescue (payload) {
    try {
      var url = URL.createObjectURL(new Blob([payload.text], { type: 'text/plain;charset=utf-8' }))
      var a = document.createElement('a')
      a.href = url; a.download = payload.name; a.rel = 'noopener'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(function () { try { URL.revokeObjectURL(url) } catch (e) {} }, 30000)
      return true
    } catch (e) { return false }
  }
  async function rescueUnsaved () {
    var payload = rescuePayload()
    if (!payload) { toast('NOTHING TO EXPORT — THE EDITOR IS NOT MOUNTED', 'error'); return false }
    var copied = false
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(payload.text); copied = true } } catch (e) { copied = false }
    var saved = downloadRescue(payload)
    if (copied && saved) toast('UNSAVED NOTE COPIED TO THE CLIPBOARD AND DOWNLOADED', 'success')
    else if (saved) toast('UNSAVED NOTE DOWNLOADED', 'success')
    else if (copied) toast('UNSAVED NOTE COPIED TO THE CLIPBOARD', 'success')
    else { toast('COULD NOT EXPORT THE UNSAVED NOTE', 'error'); return false }
    return true
  }
  function clearDirtyAfterRescue () {
    S.dirty = false; S.saveAgain = false; S.saveBlocked = false; S.editRevision++
    clearTimeout(S.saveTimer); S.saveTimer = null
  }
  // Offer the export, then require a SECOND explicit confirmation before the
  // edit is dropped. Returns true only when the user chose to move on.
  async function confirmAbandonUnsaved (headline) {
    var exported = false
    if (window.confirm((headline || 'THIS NOTE HAS UNSAVED CHANGES THAT COULD NOT BE SAVED.') +
      '\n\nOK: EXPORT A COPY NOW (CLIPBOARD + DOWNLOAD).\nCANCEL: SKIP THE EXPORT.')) exported = await rescueUnsaved()
    if (!window.confirm((exported ? 'A COPY WAS EXPORTED. ' : 'NO COPY WAS EXPORTED. ') +
      'DISCARD THE UNSAVED CHANGES AND CONTINUE?')) return false
    clearDirtyAfterRescue()
    return true
  }
  function showConflictState () {
    var state = $('ntSaveState'); if (!state) return
    state.innerHTML = '<button type="button" class="nt-conflict-btn">Conflict — reopen</button>'
    state.title = 'This note was changed in another tab.'
    state.querySelector('button').onclick = async function () {
      if (!(await confirmAbandonUnsaved('THIS NOTE WAS CHANGED IN ANOTHER TAB, SO YOUR VERSION CANNOT BE SAVED OVER IT.'))) return
      openNote(S.pendingOpenId || S.noteId)
    }
  }
  function showBlockedState (message) {
    var state = $('ntSaveState'); if (!state) return
    state.innerHTML = '<button type="button" class="nt-conflict-btn">Not saved — export</button>'
    state.title = message || 'This note could not be saved.'
    state.querySelector('button').onclick = function () { rescueUnsaved() }
  }

  // Reads the body for the CURRENT note type, or null when the editor root for
  // that type is not mounted. Returning null instead of '' is the whole point:
  // a canvas note with S.canvas === null used to serialise as an empty string
  // and silently overwrite the note while the UI reported "Saved".
  function readEditorBody (type) {
    if (type === 'canvas') {
      if (!S.canvas || typeof S.canvas.getData !== 'function') return null
      var data
      try { data = S.canvas.getData() } catch (e) { return null }
      if (!data || !Array.isArray(data.blocks)) return null
      return JSON.stringify(data)
    }
    if (type !== 'document') return null
    var el = $('ntBody')
    if (!el || !el.isConnected) return null
    return sanitizeHtml(el.innerHTML || '')
  }
  // One consistent snapshot of everything a write depends on.
  function saveSnapshot () { return { id: S.noteId, key: S.noteKey, ver: S.ver, type: S.currentType } }
  function snapshotIsCurrent (snap) {
    return !!snap && snap.id === S.noteId && snap.key === S.noteKey && snap.ver === S.ver && snap.type === S.currentType
  }

  async function saveNote () {
    if (!S.dirty) return
    if (S.isSaving) { S.saveAgain = true; return }
    // Fail closed: one snapshot, taken together, and every element must be
    // present. A missing key/version/type means the editor is mid-swap, and
    // writing then is what encrypted note A's body under A's key into note B.
    var snap = saveSnapshot()
    // saveBlocked so a wedged state can still be escaped through openNote's
    // explicit prompt rather than silently blocking every future open.
    if (!snap.id || !snap.key || !snap.ver || !snap.type || !S.editorReady) { S.saveBlocked = true; setSaveState('Unsaved'); return }
    clearTimeout(S.saveTimer); S.saveTimer = null
    if (S.canvas && S.canvas.flush) S.canvas.flush(false)
    var titleEl = $('ntTitle')
    var body = readEditorBody(snap.type)
    if (!titleEl || !titleEl.isConnected || body == null) {
      // The editor root for this note type is absent. Abort and KEEP S.dirty
      // so nothing is reported as saved and nothing empty is sent.
      setSaveState('Save failed')
      S.saveBlocked = true
      showBlockedState('The editor is not mounted, so this note was not saved.')
      toast('EDITOR IS NOT READY — NOTE NOT SAVED', 'error')
      return
    }
    if (snap.type === 'canvas' && !validateCanvasData(JSON.parse(body))) {
      // Saving would store a canvas openNote() refuses to load, locking the note.
      setSaveState('Save failed')
      toast('CANVAS IS OVER ITS SIZE LIMITS — NOTE NOT SAVED', 'error')
      return
    }
    var title = titleEl.value.trim() || 'Untitled'
    S.isSaving = true; S.saveAgain = false
    var saveRevision = S.editRevision
    setSaveState('Saving…')
    try {
      var titleEnc = await OneGyCrypto.encryptFileName(title, snap.key)
      var contentEnc = await encContent(body, snap.key)
      // Preflight against the REAL server limit (app.py
      // NOTES_NOTE_CONTENT_MAX_BYTES) instead of firing a doomed request.
      if (contentEnc.length > NOTES_CONTENT_MAX_BYTES) {
        var big = new Error('NOTE TOO LARGE'); big.status = 413; big.oversize = true; throw big
      }
      // Re-verify the snapshot AFTER the awaits and BEFORE the PUT. The old
      // check ran after the request had already been sent, so it prevented
      // nothing.
      if (!snapshotIsCurrent(snap)) { S.saveAgain = true; setSaveState('Unsaved'); return }
      var resp = await apiSend('PUT', '/notes/api/notes/' + encodeURIComponent(snap.id), {
        encrypted_title: titleEnc.encryptedName, title_nonce: titleEnc.nameNonce,
        encrypted_content: contentEnc, content_nonce: contentNonceOf(contentEnc), expected_content_version: snap.ver
      })
      var savedVer = resp.content_version || (snap.ver + 1)
      var n = S.notes.filter(function (x) { return x.id === snap.id })[0]
      // The list copy feeds noteVersion() for list-menu actions once the note is closed.
      if (n) n.content_version = savedVer
      if (S.noteId !== snap.id) return
      S.saveFailures = 0
      S.saveBlocked = false
      S.ver = savedVer
      S.titles[snap.id] = title
      if (n) { n._title = title; n.updated_at = resp.updated_at || new Date().toISOString() }
      if (S.editRevision === saveRevision) { S.dirty = false; setSaveState('Saved'); setTimeout(function () { if (!S.dirty) setSaveState('') }, 1400) }
      else { S.dirty = true; S.saveAgain = true; setSaveState('Unsaved') }
      renderList()
    } catch (e) {
      var status = e && e.status
      var msg = 'COULD NOT SAVE NOTE'
      S.saveAgain = false; saveRevision = S.editRevision
      if (status === 409) {
        S.saveBlocked = true
        msg = 'NOTE CHANGED IN ANOTHER TAB — REOPEN IT BEFORE SAVING'
        showConflictState()
      } else if (status >= 400 && status < 500) {
        // Non-retryable. Retrying byte-identical content forever would pin
        // S.dirty and block opening ANY note, so mark it blocked instead: the
        // content stays in the editor and openNote can now ask to move on.
        clearTimeout(S.saveTimer); S.saveTimer = null
        S.saveBlocked = true
        if (e.oversize || status === 413) {
          msg = (e.body && e.body.error === 'STORAGE LIMIT EXCEEDED')
            ? 'STORAGE LIMIT REACHED — FREE UP SPACE, THIS NOTE WAS NOT SAVED'
            : 'NOTE IS TOO LARGE TO SAVE (LIMIT ' + mbLabel(NOTES_CONTENT_MAX_BYTES) + ' ENCRYPTED) — REMOVE SOME IMAGES'
        } else if (e.body && e.body.error) msg = String(e.body.error)
        setSaveState('Save failed')
        showBlockedState(msg)
      } else {
        setSaveState('Save failed')
        S.saveFailures++; clearTimeout(S.saveTimer); S.saveTimer = setTimeout(saveNote, Math.min(30000, 2000 * Math.pow(2, S.saveFailures - 1)))
      }
      toast(msg, 'error')
    } finally {
      S.isSaving = false
      if (S.noteId === snap.id && S.dirty && !S.saveBlocked && (S.saveAgain || S.editRevision > saveRevision)) {
        S.saveAgain = false; clearTimeout(S.saveTimer); S.saveTimer = setTimeout(saveNote, 0)
      } else if (!S.dirty && S.pendingOpenId && S.pendingOpenId !== S.noteId) {
        setTimeout(function () { openNote(S.pendingOpenId) }, 0)
      }
    }
  }

  async function createNote (type) {
    type = type === 'canvas' ? 'canvas' : 'document'
    var mk = await masterKey(); if (!mk) { toast('UNLOCK YOUR KEYS FIRST', 'error'); return }
    showEditorMobile()
    try {
      var noteKey = await OneGyCrypto.generateFileKey()
      var wrapped = await OneGyCrypto.wrapFileKeyWithMasterKey(noteKey, mk)
      var titleEnc = await OneGyCrypto.encryptFileName(type === 'canvas' ? 'Untitled canvas' : 'Untitled note', noteKey)
      var notebookId = (S.view !== 'all' && S.view !== 'unfiled' && S.view !== 'trash') ? parseInt(S.view) : null
      var payload = {
        notebook_id: isNaN(notebookId) ? null : notebookId, note_type: type,
        encrypted_title: titleEnc.encryptedName, title_nonce: titleEnc.nameNonce,
        encrypted_note_key: wrapped.encryptedFileKey, note_key_nonce: wrapped.nonce
      }
      if (type === 'canvas') {
        var canvasEnc = await encContent('{"blocks":[]}', noteKey)
        payload.encrypted_content = canvasEnc
        payload.content_nonce = contentNonceOf(canvasEnc)
      }
      var resp = await apiSend('POST', '/notes/api/notes', payload)
      await loadAll(); await loadNotes(); openNote(resp.id)
    } catch (e) { toast('COULD NOT CREATE NOTE', 'error') }
  }

  async function createNotebook (name) {
    var mk = await masterKey(); if (!mk) { toast('UNLOCK YOUR KEYS FIRST', 'error'); return }
    try {
      var nameKey = await OneGyCrypto.generateFolderNameKey()
      var enc = await OneGyCrypto.encryptFolderName(name, nameKey)
      var wrapped = await OneGyCrypto.wrapFolderNameKey(nameKey, mk)
      await apiSend('POST', '/notes/api/notebooks', {
        encrypted_name: enc.encryptedName, name_nonce: enc.nameNonce,
        encrypted_name_key: wrapped.encryptedNameKey, name_key_nonce: wrapped.nonce
      })
      toast('NOTEBOOK CREATED', 'success'); loadAll()
    } catch (e) { toast('COULD NOT CREATE NOTEBOOK', 'error') }
  }

  async function togglePin () {
    // By id, captured now: the reply must update THIS note even if another
    // note was opened while the request was in flight.
    if (S.noteId) return togglePinById(S.noteId)
  }
  async function deleteNote (perm) {
    if (!S.noteId) return
    if (perm && !window.confirm('DELETE THIS NOTE FOREVER? THIS CANNOT BE UNDONE.')) return
    if (!perm && S.dirty) { if (S.canvas && S.canvas.flush) S.canvas.flush(); await saveNote(); if (S.dirty) { toast('SAVE THE NOTE BEFORE MOVING IT TO TRASH', 'error'); return } }
    try {
      await apiSend('DELETE', '/notes/api/notes/' + encodeURIComponent(S.noteId) + (perm ? '?permanent=true' : ''), null)
      toast(perm ? 'NOTE DELETED' : 'MOVED TO TRASH', 'success')
      resetOpenState(emptyEditor()); S.noteId = null
      await loadAll(); loadNotes()
    } catch (e) { toast('COULD NOT DELETE NOTE', 'error') }
  }
  async function restoreNote () {
    if (!S.noteId) return
    try { await apiSend('POST', '/notes/api/notes/' + encodeURIComponent(S.noteId) + '/restore', {}); toast('NOTE RESTORED', 'success'); resetOpenState(emptyEditor()); S.noteId = null; await loadAll(); loadNotes() } catch (e) { toast('COULD NOT RESTORE', 'error') }
  }

  // ---- Per-note actions (context menu) -------------------------------------
  // The editor-header actions above all operate on S.noteId. These variants
  // take an explicit id so the list context menu can act on any note without
  // opening it first.
  function noteById (id) { return S.notes.filter(function (x) { return x.id === id })[0] || null }

  function noteVersion (id) {
    if (S.noteId === id && S.ver) return S.ver
    var n = noteById(id)
    return (n && n.content_version) || 1
  }

  function metadataPayload (id, payload) {
    payload.expected_content_version = noteVersion(id)
    return payload
  }

  function applyMetadataVersion (id, response) {
    if (!response || !response.content_version) return
    var n = noteById(id)
    if (n) n.content_version = response.content_version
    if (S.noteId === id) S.ver = response.content_version
    if (S.meta && S.meta.id === id) S.meta.content_version = response.content_version
  }

  function clearEditorIfOpen (id) {
    if (S.noteId !== id) return
    resetOpenState(emptyEditor())
    S.noteId = null
  }

  // Trashing the open note while it has unsaved edits would silently lose them.
  async function flushIfOpen (id) {
    if (S.noteId !== id || !S.dirty) return true
    if (S.canvas && S.canvas.flush) S.canvas.flush()
    await saveNote()
    return !S.dirty
  }

  async function setNoteColorById (id, color) {
    var n = noteById(id); if (!n) return
    var safe = normColor(color)
    try {
      var resp = await apiSend('PUT', '/notes/api/notes/' + encodeURIComponent(id), metadataPayload(id, { color: safe }))
      applyMetadataVersion(id, resp)
      n.color = safe
      if (S.meta && S.meta.id === id) S.meta.color = safe
      renderList()
    } catch (e) { toast('COULD NOT UPDATE COLOUR', 'error') }
  }

  async function togglePinById (id) {
    var n = noteById(id); if (!n) return
    var np = !n.is_pinned
    try {
      var resp = await apiSend('PUT', '/notes/api/notes/' + encodeURIComponent(id), metadataPayload(id, { is_pinned: np }))
      applyMetadataVersion(id, resp)
      n.is_pinned = np
      if (S.meta && S.meta.id === id) S.meta.is_pinned = np
      renderList()
      if (S.noteId === id) { var pb = editorEl.querySelector('[data-pin] svg'); if (pb) pb.setAttribute('fill', np ? 'currentColor' : 'none') }
    } catch (e) { toast('COULD NOT UPDATE PIN', 'error') }
  }

  async function renameNoteById (id) {
    var n = noteById(id); if (!n) return
    var mk = await masterKey(); if (!mk) { toast('UNLOCK YOUR KEYS FIRST', 'error'); return }
    var current = n._title || S.titles[id] || ''
    var next = await openPrompt('Rename note', 'Note title', current)
    if (next == null) return
    next = next.trim()
    if (!next || next === current) return
    try {
      var nk = await OneGyCrypto.unwrapFileKeyWithMasterKey(n.encrypted_note_key, n.note_key_nonce, mk)
      var enc = await OneGyCrypto.encryptFileName(next, nk)
      var resp = await apiSend('PUT', '/notes/api/notes/' + encodeURIComponent(id), metadataPayload(id, { encrypted_title: enc.encryptedName, title_nonce: enc.nameNonce }))
      applyMetadataVersion(id, resp)
      n._title = next; S.titles[id] = next
      // Keep the open editor in sync or the next autosave writes the old title back.
      if (S.noteId === id && $('ntTitle')) $('ntTitle').value = next
      renderList()
      toast('NOTE RENAMED', 'success')
    } catch (e) { toast('COULD NOT RENAME NOTE', 'error') }
  }

  async function duplicateNoteById (id) {
    var mk = await masterKey(); if (!mk) { toast('UNLOCK YOUR KEYS FIRST', 'error'); return }
    try {
      if (!(await flushIfOpen(id))) { toast('SAVE THE NOTE BEFORE DUPLICATING IT', 'error'); return }
      var full = await apiGet('/notes/api/notes/' + encodeURIComponent(id))
      var srcKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(full.encrypted_note_key, full.note_key_nonce, mk)
      // Never swallow a decrypt failure here. Silently substituting 'Untitled'
      // and an empty body produced a confidently-reported empty copy of a note
      // the user was duplicating precisely BECAUSE it looked broken — and they
      // might then trash the original, destroying the only recoverable
      // ciphertext. Any failure aborts the whole operation instead.
      var title = 'Untitled'
      if (full.encrypted_title && full.title_nonce) {
        title = (await OneGyCrypto.decryptFileName(full.encrypted_title, full.title_nonce, srcKey)) || ''
        if (!title) throw new Error('TITLE DECRYPT FAILED')
      }
      var body = ''
      if (full.encrypted_content) {
        body = await decContent(full.encrypted_content, srcKey)
        if (typeof body !== 'string') throw new Error('CONTENT DECRYPT FAILED')
      }

      // The copy gets a brand new note key — never reuse the source note's key.
      var noteKey = await OneGyCrypto.generateFileKey()
      var wrapped = await OneGyCrypto.wrapFileKeyWithMasterKey(noteKey, mk)
      var titleEnc = await OneGyCrypto.encryptFileName(title + ' (copy)', noteKey)
      var type = full.note_type === 'canvas' ? 'canvas' : 'document'
      // Canvas notes must always carry a parseable document, same as createNote().
      // Only reachable when the SOURCE genuinely had no stored content — a
      // failed decrypt has already thrown above, so this can no longer stand in
      // for content we could not read.
      if (type === 'canvas' && !body) body = '{"blocks":[]}'
      var payload = {
        notebook_id: full.notebook_id == null ? null : full.notebook_id,
        note_type: type, color: normColor(full.color),
        encrypted_title: titleEnc.encryptedName, title_nonce: titleEnc.nameNonce,
        encrypted_note_key: wrapped.encryptedFileKey, note_key_nonce: wrapped.nonce
      }
      if (body) {
        var copyEnc = await encContent(body, noteKey)
        payload.encrypted_content = copyEnc
        payload.content_nonce = contentNonceOf(copyEnc)
      }
      await apiSend('POST', '/notes/api/notes', payload)
      toast('NOTE DUPLICATED', 'success')
      await loadAll(); await loadNotes()
    } catch (e) { toast('COULD NOT CONFIRM NOTE DUPLICATION — REFRESH TO CHECK', 'error') }
  }

  async function moveNoteById (id, notebookId) {
    var n = noteById(id); if (!n) return
    try {
      var resp = await apiSend('PUT', '/notes/api/notes/' + encodeURIComponent(id), metadataPayload(id, { notebook_id: notebookId }))
      applyMetadataVersion(id, resp)
      n.notebook_id = notebookId
      if (S.meta && S.meta.id === id) S.meta.notebook_id = notebookId
      toast('NOTE MOVED', 'success')
      await loadAll(); await loadNotes()
    } catch (e) { toast('COULD NOT MOVE NOTE', 'error') }
  }

  async function trashNoteById (id) {
    if (!noteById(id)) return
    if (!(await flushIfOpen(id))) { toast('SAVE THE NOTE BEFORE MOVING IT TO TRASH', 'error'); return }
    try {
      await apiSend('DELETE', '/notes/api/notes/' + encodeURIComponent(id), null)
      toast('MOVED TO TRASH', 'success')
      clearEditorIfOpen(id)
      await loadAll(); loadNotes()
    } catch (e) { toast('COULD NOT DELETE NOTE', 'error') }
  }

  async function deleteForeverById (id) {
    if (!window.confirm('DELETE THIS NOTE FOREVER? THIS CANNOT BE UNDONE.')) return
    try {
      await apiSend('DELETE', '/notes/api/notes/' + encodeURIComponent(id) + '?permanent=true', null)
      toast('NOTE DELETED', 'success')
      clearEditorIfOpen(id)
      await loadAll(); loadNotes()
    } catch (e) { toast('COULD NOT DELETE NOTE', 'error') }
  }

  async function restoreNoteById (id) {
    try {
      await apiSend('POST', '/notes/api/notes/' + encodeURIComponent(id) + '/restore', {})
      toast('NOTE RESTORED', 'success')
      clearEditorIfOpen(id)
      await loadAll(); loadNotes()
    } catch (e) { toast('COULD NOT RESTORE', 'error') }
  }

  async function emptyTrash () {
    if (!window.confirm('PERMANENTLY DELETE EVERYTHING IN THE TRASH? THIS CANNOT BE UNDONE.')) return
    try {
      await apiSend('DELETE', '/notes/api/trash', null)
      toast('TRASH EMPTIED', 'success')
      resetOpenState(emptyEditor()); S.noteId = null
      await loadAll(); loadNotes()
    } catch (e) { toast('COULD NOT EMPTY TRASH', 'error') }
  }

  // ---- Context menus -------------------------------------------------------
  var NI = {
    open: '<path d="M14 3v5h5"/><path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2z"/>',
    rename: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    duplicate: '<rect x="9" y="9" width="12" height="12" rx="1"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    pin: '<path d="M14 4v6l3 3v2H7v-2l3-3V4z"/><path d="M12 15v5"/><path d="M9 4h6"/>',
    move: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    restore: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    note: '<path d="M12 5v14M5 12h14"/>',
    canvas: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    notebook: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'
  }
  function hasMenu () { return typeof window.RdMenu !== 'undefined' }

  function colorRow (n) {
    var current = normColor(n.color)
    return {
      swatches: NOTE_COLORS.map(function (c) { return { color: c.color, label: c.label, active: normColor(c.color) === current } }),
      onPick: function (c) { setNoteColorById(n.id, c) }
    }
  }

  function noteMenu (n) {
    return [
      { label: 'Open', icon: NI.open, action: function () { openNote(n.id); showEditorMobile() } },
      { label: 'Rename', icon: NI.rename, action: function () { renameNoteById(n.id) } },
      { label: 'Duplicate', icon: NI.duplicate, action: function () { duplicateNoteById(n.id) } },
      { sep: true },
      { label: n.is_pinned ? 'Unpin' : 'Pin to top', icon: NI.pin, action: function () { togglePinById(n.id) } },
      { label: 'Move to notebook…', icon: NI.move, action: function () { openMoveMenu(S.menuX, S.menuY, n) } },
      { header: 'Colour' },
      colorRow(n),
      { sep: true },
      { label: 'Move to trash', icon: NI.trash, danger: true, action: function () { trashNoteById(n.id) } }
    ]
  }
  function trashNoteMenu (n) {
    return [
      { label: 'Restore', icon: NI.restore, action: function () { restoreNoteById(n.id) } },
      { sep: true },
      { label: 'Delete forever', icon: NI.trash, danger: true, action: function () { deleteForeverById(n.id) } }
    ]
  }
  function listMenu () {
    if (S.view === 'trash') {
      return [
        { header: 'Trash' },
        { label: 'Empty trash', icon: NI.trash, danger: true, disabled: !S.notes.length, action: function () { emptyTrash() } }
      ]
    }
    return [
      { header: 'Create' },
      { label: 'New note', icon: NI.note, action: function () { createNote('document') } },
      { label: 'New canvas', icon: NI.canvas, action: function () { createNote('canvas') } },
      { sep: true },
      { label: 'New notebook', icon: NI.notebook, action: function () { openNbModal() } }
    ]
  }
  // RdMenu has no nested submenus, so "Move to…" swaps the menu contents in
  // place and offers a way back.
  function openMoveMenu (x, y, n) {
    var items = [{ label: 'Back', icon: NI.back, action: function () { RdMenu.open(x, y, noteMenu(n)) } }, { header: 'Move to' }]
    items.push({ label: 'Unfiled', icon: NI.move, disabled: n.notebook_id == null, action: function () { moveNoteById(n.id, null) } })
    S.notebooks.filter(function (nb) { return !nb.is_trashed }).forEach(function (nb) {
      items.push({ label: nb._name || 'Notebook', icon: NI.notebook, disabled: String(nb.id) === String(n.notebook_id), action: function () { moveNoteById(n.id, nb.id) } })
    })
    RdMenu.open(x, y, items)
  }

  function openNoteMenu (x, y, id) {
    if (!hasMenu()) return
    var n = noteById(id); if (!n) return
    S.menuX = x; S.menuY = y
    RdMenu.open(x, y, S.view === 'trash' ? trashNoteMenu(n) : noteMenu(n))
  }

  // ---- Prompt modal --------------------------------------------------------
  var promptResolve = null
  function openPrompt (title, placeholder, value) {
    return new Promise(function (resolve) {
      var m = $('ntPromptModal')
      if (!m) { resolve(window.prompt(title, value || '')); return }
      promptResolve = resolve
      $('ntPromptTitle').textContent = title
      var inp = $('ntPromptInput')
      inp.placeholder = placeholder || ''
      inp.value = value || ''
      m.classList.add('rd-open'); m.setAttribute('aria-hidden', 'false')
      setTimeout(function () { inp.focus(); inp.select() }, 30)
    })
  }
  function closePrompt (value) {
    var m = $('ntPromptModal')
    if (m) { m.classList.remove('rd-open'); m.setAttribute('aria-hidden', 'true') }
    var r = promptResolve; promptResolve = null
    if (r) r(value == null ? null : value)
  }

  // ---- Misc UI -------------------------------------------------------------
  function fmtDate (iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; var now = new Date(); var sameDay = d.toDateString() === now.toDateString(); return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) }
  function errState (m) { return '<div class="nt-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg><p>' + esc(m) + '</p></div>' }
  function emptyEditor () { return '<div class="nt-empty nt-empty-editor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2z"/></svg><h3>Select a note</h3><p>Choose a note from the list, or create a new one. Everything is end-to-end encrypted.</p></div>' }

  function showLock (on) {
    var lb = $('ntLock'); if (!lb) return
    lb.hidden = !on
    $('ntPanes') && ($('ntPanes').style.display = on ? 'none' : '')
  }
  async function unlockKeys (pw) {
    var kd = await apiGet('/api/keys')
    if (!kd.has_e2ee_keys) { toast('THIS ACCOUNT HAS NO ENCRYPTION KEYS', 'error'); return false }
    var wrap = pw
    if (kd.split_key_version >= 1 && kd.auth_token_salt) { var sk = await OneGyCrypto.deriveAuthAndWrappingKeys(pw, kd.auth_token_salt); wrap = sk.wrappingKey }
    var res = await OneGyCrypto.unlockUserKeys(wrap, { encryptedMasterKey: kd.encrypted_master_key, masterKeyNonce: kd.master_key_nonce, masterKeySalt: kd.master_key_salt, encryptedPrivateKey: kd.encrypted_private_key, privateKeyNonce: kd.private_key_nonce })
    await OneGyCrypto.storeMasterKeyInSession(res.masterKey)
    if (res.privateKey && OneGyCrypto.storePrivateKeyInSession) { try { await OneGyCrypto.storePrivateKeyInSession(res.privateKey) } catch (e) {} }
    return true
  }

  // ---- Wiring --------------------------------------------------------------
  function wire () {
    $('ntRail').addEventListener('click', function (e) {
      var v = e.target.closest('[data-view]'); if (v) { S.view = v.getAttribute('data-view'); renderRail(); loadNotes(); closeRail(); return }
      if (e.target.closest('#ntNewNb')) { openNbModal(); return }
    })
    listEl.addEventListener('click', function (e) {
      // A long-press already opened the menu; swallow the click it trails.
      if (lpFired) { lpFired = false; e.preventDefault(); e.stopPropagation(); return }
      if (e.target.closest('#ntNewCanvas')) { createNote('canvas'); return }
      if (e.target.closest('#ntNewNote')) { createNote('document'); return }
      var it = e.target.closest('[data-note]'); if (it) { openNote(it.getAttribute('data-note')); showEditorMobile(); return }
    })
    // Right-click: note card menu, or the create menu on empty list space.
    listEl.addEventListener('contextmenu', function (e) {
      if (!hasMenu()) return
      if (e.target.closest('#ntSearch') || e.target.closest('.nt-list-head')) return
      var it = e.target.closest('[data-note]')
      e.preventDefault()
      if (it) openNoteMenu(e.clientX, e.clientY, it.getAttribute('data-note'))
      else RdMenu.open(e.clientX, e.clientY, listMenu())
    })
    // Touch long-press stands in for right-click.
    listEl.addEventListener('pointerdown', function (e) {
      lpFired = false
      if (e.pointerType === 'mouse') return
      var card = e.target.closest('[data-note]'); if (!card) return
      cancelLongPress()
      longPress = { x: e.clientX, y: e.clientY, id: card.getAttribute('data-note') }
      longPress.timer = setTimeout(function () {
        if (!longPress) return
        lpFired = true
        openNoteMenu(longPress.x, longPress.y, longPress.id)
        longPress = null
      }, 500)
    })
    listEl.addEventListener('pointermove', function (e) {
      if (!longPress) return
      if (Math.abs(e.clientX - longPress.x) > 10 || Math.abs(e.clientY - longPress.y) > 10) cancelLongPress()
    })
    listEl.addEventListener('pointerup', cancelLongPress)
    listEl.addEventListener('pointercancel', cancelLongPress)
    listEl.addEventListener('input', function (e) { if (e.target.id === 'ntSearch') renderList(e.target.value) })
    $('ntRailScrim') && ($('ntRailScrim').onclick = closeRail)
    document.addEventListener('click', function (e) { if (e.target.closest('#ntRailToggle')) openRail(); if (e.target.closest('#ntBackBtn')) hideEditorMobile() })
    // Notebook modal
    $('ntNbSave') && ($('ntNbSave').onclick = function () { var n = $('ntNbName').value.trim(); if (!n) return; closeNbModal(); createNotebook(n) })
    document.querySelectorAll('#ntNbModal [data-rd-modal-close]').forEach(function (b) { b.onclick = closeNbModal })
    // Prompt modal (rename)
    $('ntPromptSave') && ($('ntPromptSave').onclick = function () { closePrompt($('ntPromptInput').value) })
    $('ntPromptInput') && $('ntPromptInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); closePrompt(this.value) }
      else if (e.key === 'Escape') { e.preventDefault(); closePrompt(null) }
    })
    document.querySelectorAll('#ntPromptModal [data-rd-modal-close]').forEach(function (b) { b.onclick = function () { closePrompt(null) } })
    // Unlock
    $('ntUnlockForm') && $('ntUnlockForm').addEventListener('submit', async function (e) {
      e.preventDefault(); var pw = $('ntUnlockPw').value; if (!pw) return
      var btn = this.querySelector('button'); btn.disabled = true
      var ok = false; try { ok = await unlockKeys(pw) } catch (err) { ok = false }
      btn.disabled = false
      if (ok) { $('ntUnlockPw').value = ''; toast('ENCRYPTION KEYS UNLOCKED', 'success'); loadAll() } else toast('INCORRECT PASSWORD', 'error')
    })
    window.addEventListener('beforeunload', function (e) { if (S.dirty) { e.preventDefault(); e.returnValue = '' } })
  }
  function openRail () { $('ntRail').classList.add('is-open'); $('ntRailScrim').classList.add('is-open') }
  function closeRail () { var r = $('ntRail'); if (r) r.classList.remove('is-open'); var s = $('ntRailScrim'); if (s) s.classList.remove('is-open') }
  function showEditorMobile () { document.getElementById('ntPanes') && document.getElementById('ntPanes').classList.add('nt-show-editor') }
  function hideEditorMobile () { document.getElementById('ntPanes') && document.getElementById('ntPanes').classList.remove('nt-show-editor') }
  function openNbModal () { var m = $('ntNbModal'); m.classList.add('rd-open'); m.setAttribute('aria-hidden', 'false'); $('ntNbName').value = ''; setTimeout(function () { $('ntNbName').focus() }, 30) }
  function closeNbModal () { var m = $('ntNbModal'); m.classList.remove('rd-open'); m.setAttribute('aria-hidden', 'true') }
  function inkHighlights (root) { if (root && window.FxCanvas && FxCanvas.inkHighlights) FxCanvas.inkHighlights(root) }
  function destroyCanvas () { if (S.canvas) { try { S.canvas.destroy() } catch (e) {} S.canvas = null } }

  // ---- Mock hook (headless screenshots) ------------------------------------
  window.__ntMock = function (data) {
    S.notebooks = (data.notebooks || []).map(function (n) { n._name = n.name; return n })
    S.notes = (data.notes || []).map(function (n) { n._title = n.title; return n })
    S.view = data.view || 'all'
    showLock(false); renderRail(); renderList()
    if (data.openNote) { var n = S.notes.filter(function (x) { return x.id === data.openNote })[0]; S.noteId = data.openNote; if (n) { renderList(); renderEditor(n._title, data.noteHtml || '', false) } }
    else editorEl.innerHTML = emptyEditor()
  }

  // ---- Boot ----------------------------------------------------------------
  function boot () {
    listEl = $('ntList'); editorEl = $('ntEditor')
    if (!listEl) return
    wire(); editorEl.innerHTML = emptyEditor()
    if (!window.__NT_NO_AUTOLOAD__) loadAll()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
