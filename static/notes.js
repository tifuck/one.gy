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
    editRevision: 0, openSeq: 0, pendingOpenId: null, saveFailures: 0, query: '',
    trashCount: 0, editorReady: false, saveBlocked: false
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
  function validateCanvasData (data, maxTotal) {
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
      if (totalCells > 20000 || totalItems > 20000 || totalPaths > 20000 || totalPoints > 200000 || totalText > (maxTotal || NOTES_CONTENT_MAX_BYTES)) return null
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
      // trash_count also counts trashed notebooks, which the Trash view never lists.
      var loaded = await Promise.all([apiGet('/notes/api/notebooks'), apiGet('/notes/api/notes?trash=true').catch(function () { return null })])
      var nbData = loaded[0]
      S.notebooks = nbData.notebooks || []
      await Promise.all(S.notebooks.map(async function (nb) { nb._name = await decNotebookName(nb, mk) }))
      S.trashCount = loaded[1] ? (loaded[1].notes || []).length : (nbData.trash_count || 0)
      await loadNotes()
    } catch (e) { listEl.innerHTML = errState('Could not load notebooks.') }
  }

  var loadNotesSeq = 0
  var loadedView = null  // entrance animation: only when a view's notes are first shown
  async function loadNotes () {
    var seq = ++loadNotesSeq  // a later view switch supersedes this response
    var mk = await masterKey(); if (!mk || seq !== loadNotesSeq) return
    var url = '/notes/api/notes'
    if (S.view === 'trash') url += '?trash=true'
    else if (S.view === 'unfiled') url += '?notebook_id=unfiled'
    else if (S.view !== 'all') url += '?notebook_id=' + S.view
    var fresh = loadedView !== S.view
    if (fresh) listItemsEl().innerHTML = '<div class="nt-skel-list" aria-hidden="true">' + new Array(7).join('<div class="rd-skel nt-skel-item"></div>') + '</div>'
    try {
      var d = await apiGet(url)
      if (seq !== loadNotesSeq) return
      var notes = d.notes || []
      await Promise.all(notes.map(async function (n) { if (n.encrypted_title) { var t = await decTitle(n, mk); S.titles[n.id] = t || 'Untitled'; n._title = S.titles[n.id] } else n._title = n.title || 'Untitled' }))
      if (seq !== loadNotesSeq) return
      S.notes = notes
      loadedView = S.view
      renderList(null, fresh)
      if (!S.noteId && (!editorEl.firstElementChild || editorEl.querySelector('.nt-empty-editor'))) editorEl.innerHTML = emptyEditor()
    } catch (e) { if (seq === loadNotesSeq) listEl.innerHTML = errState('Could not load notes.') }
  }

  var TRASH_PATH = 'M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3l.8-12.2'

  // The head and search box are patched in place and only .nt-items is
  // replaced: rebuilding the whole pane reset the list's scroll on every
  // open/autosave and destroyed the search input mid-typing (IME, the query).
  var shownHead = null
  function listItemsEl () {
    var head = listHead(), items = listEl.querySelector('.nt-items')
    if (!items || !$('ntSearch')) {
      listEl.innerHTML = head + '<div class="nt-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg><input type="search" id="ntSearch" placeholder="Search notes" aria-label="Search notes" autocomplete="off" spellcheck="false"></div><div class="nt-items"></div>'
      $('ntSearch').value = S.query
      items = listEl.querySelector('.nt-items')
    } else if (head !== shownHead) {
      listEl.querySelector('.nt-list-head').outerHTML = head
    }
    shownHead = head
    return items
  }
  function listHead () {
    var nb = S.notebooks.filter(function (n) { return String(n.id) === String(S.view) })[0], col = nb && normColor(nb.color)
    return '<div class="nt-list-head"><h2 class="nt-list-title"><button type="button" class="nt-switch" id="ntSwitch" title="' + esc(viewTitle()) + '" aria-haspopup="menu">' +
      (col ? '<span class="nt-switch-dot" style="--nb-color:' + col + '"></span>' : '') + '<span class="nt-switch-name">' + esc(viewTitle()) + '</span>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button></h2>' +
      (S.view !== 'trash' ? '<button type="button" class="nt-newnote" id="ntNewNote" title="New note, canvas or notebook" aria-label="New" aria-haspopup="menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg><span>New</span><svg class="nt-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg></button>'
        : S.notes.length ? '<button type="button" class="nt-newnote nt-empty-trash" id="ntEmptyTrash">Empty trash</button>' : '') + '</div>'
  }
  function renderList (query, animate) {
    // Entrance only on fresh data loads — note clicks / search re-renders
    // rebuild the list for highlight state and must not replay it
    listEl.classList.toggle('is-anim', !!animate)
    if (query != null) S.query = query
    var notes = S.notes.slice()
    var q = S.query.toLowerCase()
    if (q) notes = notes.filter(function (n) { return (n._title || '').toLowerCase().indexOf(q) >= 0 })
    notes.sort(function (a, b) { return (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0) || ((b.updated_at || '') < (a.updated_at || '') ? -1 : 1) })
    var pinned = S.view === 'trash' ? 0 : notes.filter(function (n) { return n.is_pinned }).length
    var items = notes.map(function (n, i) {
      var col = normColor(n.color), canvas = n.note_type === 'canvas'
      var label = pinned && (i === 0 || i === pinned) ? sectionLabel(i ? 'Notes' : 'Pinned', i ? notes.length - pinned : pinned) : ''
      return label + '<button type="button" class="nt-item' + (col ? ' has-color' : '') + (n.id === S.noteId ? ' is-active' : '') + '" data-note="' + esc(n.id) + '"' +
        (col ? ' style="--nt-color:' + col + '"' : '') + '>' +
        '<span class="nt-item-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (canvas ? NI.canvas : NI.doc) + '</svg></span>' +
        '<span class="nt-item-main"><span class="nt-item-row"><span class="nt-item-title">' + (n.is_pinned && !pinned ? '<svg class="nt-pin" viewBox="0 0 24 24" fill="currentColor"><path d="M14 4v6l3 3v2H7v-2l3-3V4z"/></svg>' : '') + '<span class="nt-item-name">' + esc(n._title || 'Untitled') + '</span></span></span>' +
        '<span class="nt-item-meta"><span>' + esc(fmtDate(n.updated_at) || 'No date') + (n.received_from ? ' · from ' + esc(n.received_from) : '') + '</span>' + nbTag(n) +
        (canvas ? '<span class="nt-badge">Canvas</span>' : '') + '</span></span></button>'
    }).join('')
    listItemsEl().innerHTML = items || listEmpty(S.query.trim())
    if (animate) { var its = listEl.querySelectorAll('.nt-item'); for (var ii = 0; ii < its.length; ii++) its[ii].style.setProperty('--i', ii) }
  }
  // All notes mixes notebooks, so each row names its own.
  function nbTag (n) {
    var nb = S.view === 'all' && n.notebook_id != null && S.notebooks.filter(function (b) { return String(b.id) === String(n.notebook_id) })[0]
    if (!nb) return ''
    var col = normColor(nb.color)
    return '<span class="nt-item-nb"' + (col ? ' style="--nb-color:' + col + '"' : '') + '>' + esc(nb._name) + '</span>'
  }
  function sectionLabel (label, count) { return '<div class="nt-section">' + label + '<span>' + count + '</span></div>' }
  function listEmpty (q) {
    var copy = q ? ['No matches', 'No note titles contain “' + esc(q) + '”.']
      : S.view === 'trash' ? ['Trash is empty', 'Notes you move to the trash show up here.']
      : S.view === 'all' ? ['No notes yet', 'Notes and canvases you create show up here.']
      : S.view === 'unfiled' ? ['No unfiled notes', 'Notes that are not in a notebook show up here.']
      : ['This notebook is empty', 'Create a note here, or move one in from its menu.']
    var icon = q ? '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>' : S.view === 'trash' ? '<path d="' + TRASH_PATH + '"/>' : NI.doc
    return '<div class="rd-empty"><span class="rd-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg></span>' +
      '<h3 class="rd-empty-title">' + copy[0] + '</h3><p class="rd-empty-text">' + copy[1] + '</p></div>'
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
    if (S.pendingOpenId !== id) { if (S.pendingOpenId !== S.noteId) openNote(S.pendingOpenId); return }
    // Keep an inert copy of the outgoing note on screen (dimmed below) instead
    // of a blank pane; clones carry no listeners, the real DOM goes with the reset.
    var outgoing = Array.prototype.map.call(editorEl.childNodes, function (n) { return n.cloneNode(true) })
    resetOpenState()
    outgoing.forEach(function (n) { editorEl.appendChild(n) })
    editorEl.querySelectorAll('[contenteditable]').forEach(function (n) { n.setAttribute('contenteditable', 'false') })
    editorEl.querySelectorAll('input, textarea, select, button').forEach(function (n) { n.disabled = true })
    S.noteId = id
    renderList()
    // Seamless switch: dim the outgoing note and hold the spinner back so
    // fast opens (cache/local) swap directly without a loading flash
    editorEl.classList.add('nt-ed-busy')
    var spinT = setTimeout(function () { if (seq === S.openSeq) editorEl.innerHTML = '<div class="nt-ed-loading"><span class="nt-spin"></span></div>' }, 180)
    var endBusy = function () { clearTimeout(spinT); editorEl.classList.remove('nt-ed-busy') }
    var fail = function (msg) { endBusy(); resetOpenState('<div class="nt-ed-head nt-ed-head-bare">' + BACK_BTN + '</div>' + errState(msg)) }
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
      '<div class="nt-toolbar" role="toolbar" aria-label="Note formatting">' +
      tbtn('undo', ico(TB.undo), 'Undo') + tbtn('redo', ico(TB.redo), 'Redo') + '<span class="nt-tb-sep"></span>' +
      '<select class="nt-tb-select nt-tb-font" data-cmd="fontName" title="Font" aria-label="Font"><option value="inherit">Default</option>' + FONT_FACES.map(function (face) { return '<option>' + face + '</option>' }).join('') + '</select>' +
      '<select class="nt-tb-select nt-tb-size" data-cmd="fontSize" title="Font size" aria-label="Font size">' + FONT_SIZES.map(function (size, i) { return '<option value="' + (i + 1) + '"' + (i === 2 ? ' selected' : '') + '>' + size + '</option>' }).join('') + '</select>' +
      '<span class="nt-tb-sep"></span>' +
      tbtn('bold', 'B', 'Bold', 'font-weight:700') + tbtn('italic', 'I', 'Italic', 'font-style:italic') + tbtn('underline', 'U', 'Underline', 'text-decoration:underline;text-underline-offset:2px') + tbtn('strikeThrough', 'S', 'Strikethrough', 'text-decoration:line-through') +
      '<span class="nt-tb-sep"></span>' +
      tbtn2('formatBlock', 'H1', 'Heading 1', '<h1>') + tbtn2('formatBlock', 'H2', 'Heading 2', '<h2>') + tbtn2('formatBlock', 'H3', 'Heading 3', '<h3>') + tbtn2('formatBlock', ico(TB.quote), 'Quote', '<blockquote>') + tbtn2('formatBlock', ico(TB.code), 'Code block', '<pre>') +
      '<span class="nt-tb-sep"></span>' +
      tbtn('insertUnorderedList', ico(TB.ul), 'Bulleted list') + tbtn('insertOrderedList', ico(TB.ol), 'Numbered list') +
      '<button type="button" class="nt-tb-btn" data-check title="Checklist (Ctrl+1)" aria-label="Checklist">' + ico(TB.check) + '</button>' +
      '<span class="nt-tb-sep"></span>' +
      Object.keys(ALIGN).map(function (key) { return tbtn(ALIGN[key][0], ico(ALIGN[key][2]), ALIGN[key][1] + ' (Ctrl+Shift+' + key.toUpperCase() + ')') }).join('') +
      '<span class="nt-tb-sep"></span>' +
      '<button type="button" class="nt-tb-btn" data-link title="Insert link (Ctrl+K)" aria-label="Insert link">' + ico(TB.link) + '</button><button type="button" class="nt-tb-btn" data-image title="Insert image" aria-label="Insert image">' + ico(TB.image) + '</button>' +
      '<button type="button" class="nt-tb-btn" data-table title="Table" aria-label="Table" aria-haspopup="menu">' + ico(TB.table) + '</button>' +
      '<label class="nt-tb-color" title="Text colour">' + ico(TB.color) + '<input type="color" data-color="foreColor" value="#d8231b" aria-label="Text colour"></label><label class="nt-tb-color" title="Highlight">' + ico(TB.mark) + '<input type="color" data-color="hiliteColor" value="#faef5a" aria-label="Highlight colour"></label>' +
      tbtn('removeFormat', ico(TB.clear), 'Clear formatting') +
      '<span class="nt-tb-zoom"><button type="button" class="nt-tb-btn" data-zoom="-1" title="Zoom out" aria-label="Zoom out">' + ico(TB.zoomOut) + '</button>' +
      '<button type="button" class="nt-tb-btn nt-tb-zoomlevel" id="ntZoomLevel" data-zoom="0" title="Reset zoom" aria-label="Reset zoom">100%</button>' +
      '<button type="button" class="nt-tb-btn" data-zoom="1" title="Zoom in" aria-label="Zoom in">' + ico(TB.zoomIn) + '</button></span>' +
      '<input type="file" id="ntImageInput" accept="image/*" hidden>' +
      '</div>'
    editorEl.innerHTML = editorHead(title, 'Untitled note', readonly) + tools +
      '<div class="nt-ed-body" id="ntBody" ' + (readonly ? '' : 'contenteditable="true"') + ' spellcheck="true"></div>'
    var body = $('ntBody')
    if (body) {
      body.appendChild(sanitizeToFragment(html)); inkHighlights(body)
      if (readonly) body.querySelectorAll('input').forEach(function (box) { box.disabled = true }) // a tick in the trash would not be saved
      // Ctrl/Cmd + wheel (and a trackpad pinch, which arrives as one) zooms the text, as in Word.
      body.addEventListener('wheel', function (e) { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setDocZoom(docZoom * Math.exp(-e.deltaY * 0.002)) } }, { passive: false })
      body.addEventListener('scroll', placeImageFrame)
    }
    setDocZoom(docZoom)
    wireEditor(readonly)
  }
  function renderCanvasNote (title, data, readonly) {
    S.currentType = 'canvas'
    editorEl.innerHTML = editorHead(title, 'Untitled canvas', readonly) +
      '<div class="nt-canvas-mount" id="ntCanvas"></div>'
    S.editorReady = false
    if (typeof FxCanvas !== 'undefined') {
      try { S.canvas = FxCanvas.mount($('ntCanvas'), { data: data, readonly: readonly, zoom: canvasZoom, onZoom: function (z) { canvasZoom = z }, onDirty: function () { if (!readonly) markDirty() }, validate: function (d) { return !!validateCanvasData(d, NOTES_INLINE_BUDGET_BYTES) } }) } catch (e) { S.canvas = null }
    }
    var pin = editorEl.querySelector('[data-pin]'); if (pin) pin.onclick = togglePin
    var del = editorEl.querySelector('[data-delete]'); if (del) del.onclick = function () { deleteNote(false) }
    var rb = editorEl.querySelector('[data-restore]'); if (rb) rb.onclick = restoreNote
    var dp = editorEl.querySelector('[data-delete-perm]'); if (dp) dp.onclick = function () { deleteNote(true) }
    // If the canvas engine never mounted there is no #ntBody either, so a save
    // would serialise this note as an empty body. Do NOT arm markDirty on the
    // title in that state — one keystroke used to be enough to wipe the note.
    if (!S.canvas) {
      $('ntCanvas').innerHTML = errState('Canvas engine failed to load. Reload the page. This note was not changed.')
      setSaveState('Read-only')
      return
    }
    if (!readonly && $('ntTitle')) { wireTitle(); S.editorReady = true }
  }
  // Zoom is a view setting kept for the session (like OneNote's window zoom); it is never written into a note.
  var docZoom = 1, canvasZoom = 1
  function setDocZoom (z) {
    docZoom = Math.max(.5, Math.min(3, +z || 1))
    var body = $('ntBody'); if (body) body.style.zoom = Math.abs(docZoom - 1) < .005 ? '' : docZoom
    var level = $('ntZoomLevel'); if (level) level.textContent = Math.round(docZoom * 100) + '%'
    placeImageFrame()
  }
  // An untitled note shows its default name as the placeholder, so typing a
  // title never starts with deleting "Untitled note".
  function titleValue (el) { return (el.value || '').trim() || el.getAttribute('placeholder') || 'Untitled' }
  function focusEditorBody () { if (S.canvas && S.canvas.focusStart) S.canvas.focusStart(); else if ($('ntBody')) $('ntBody').focus() }
  function wireTitle () {
    var title = $('ntTitle')
    // OneNote: the page list follows the title as it is typed, not a second after the typing stops.
    title.addEventListener('input', function () { markDirty(); var name = listEl.querySelector('.nt-item.is-active .nt-item-name'); if (name) name.textContent = titleValue(title) })
    // OneNote: Enter (or Down) in the title moves into the page.
    title.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === 'ArrowDown') && !e.isComposing) { e.preventDefault(); focusEditorBody() } })
  }
  // Shared by both note types: back (phones) · title · save state · actions.
  function editorHead (title, placeholder, readonly) {
    var pinned = !!(S.meta && S.meta.is_pinned)
    return '<div class="nt-ed-head">' + BACK_BTN +
        '<input class="nt-ed-title" id="ntTitle" value="' + esc(title === placeholder ? '' : title) + '" placeholder="' + placeholder + '" maxlength="200" enterkeyhint="next" aria-label="Note title" autocomplete="off"' + (readonly ? ' readonly' : '') + '>' +
        '<div class="nt-ed-actions"><span class="nt-savestate" id="ntSaveState" aria-live="polite"></span>' +
        (readonly ? '<button type="button" class="rd-btn rd-btn-ghost rd-btn-sm" data-restore>Restore</button><button type="button" class="rd-btn rd-btn-danger rd-btn-sm" data-delete-perm title="Delete forever">' + ico('<path d="' + TRASH_PATH + '"/>') + '<span class="nt-btn-label">Delete forever</span></button>' :
          '<button type="button" class="rd-icon-btn" data-pin title="' + (pinned ? 'Unpin' : 'Pin to top') + '" aria-label="Pin to top" aria-pressed="' + pinned + '"><svg viewBox="0 0 24 24" width="17" height="17" fill="' + (pinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M14 4v6l3 3v2H7v-2l3-3V4z"/><path d="M12 15v5" stroke-linecap="round"/></svg></button>' +
          '<button type="button" class="rd-icon-btn" data-delete title="Move to trash" aria-label="Move to trash"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + TRASH_PATH + '"/></svg></button>') +
        '</div>' +
      '</div>' +
      (readonly ? '<div class="nt-ro">' + ico('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>') + 'This note is in the trash. Restore it to edit.</div>' : '')
  }
  var BACK_BTN = '<button type="button" class="nt-back" id="ntBackBtn" aria-label="Back to notes" title="Back to notes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>'
  var TB = {
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h1"/>',
    quote: '<path d="M10 7H6.5A1.5 1.5 0 0 0 5 8.5V12h5zm0 5c0 3-1.5 4.5-4 5M19 7h-3.5A1.5 1.5 0 0 0 14 8.5V12h5zm0 5c0 3-1.5 4.5-4 5"/>',
    code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"/>',
    ul: '<path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10"/><circle cx="5" cy="6.5" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="17.5" r="1" fill="currentColor" stroke="none"/>',
    ol: '<path d="M10 6.5h9.5M10 12h9.5M10 17.5h9.5"/><path d="M4.5 5 6 4v5M4 14c.3-.7 1-1 1.6-1 .8 0 1.4.5 1.4 1.2 0 1.2-3 2-3 3.8h3"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3A4 4 0 0 0 11 18.66l1-1"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="m20.5 16-4.8-4.8L7 19.5"/>',
    color: '<path d="m6.5 16 5.5-12 5.5 12M8.6 11.5h6.8"/>',
    mark: '<path d="m14 5 5 5-7 7H7v-5z"/><path d="m11 8 5 5"/>',
    clear: '<path d="M6 6.5V5h11v1.5M11.5 5 9 19M7 19h4M15 14l5 5M20 14l-5 5"/>',
    check: '<rect x="4" y="4.5" width="6" height="6" rx="1.5"/><path d="M14 7.5h6M4.5 17l2 2 3.5-4.5M14 17h6"/>',
    table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.2 4.5v15M14.8 4.5v15"/>',
    zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M8.5 11h5M20 20l-4-4"/>',
    zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M11 8.5v5M8.5 11h5M20 20l-4-4"/>'
  }
  var FONT_FACES = ['Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana']
  // <font size="1".."7">, labelled with the point size each step shows at (notes.css scales them from the note text).
  var FONT_SIZES = [8, 10, 11, 14, 18, 24, 36]
  // Shortcut letter (with Ctrl+Shift, as in Google Docs: Word's Ctrl+L/E/R/J belong to the browser) -> command, label, icon.
  var ALIGN = {
    l: ['justifyLeft', 'Align left', '<path d="M4 6h16M4 10.5h10M4 15h16M4 19.5h10"/>'],
    e: ['justifyCenter', 'Centre', '<path d="M4 6h16M7 10.5h10M4 15h16M7 19.5h10"/>'],
    r: ['justifyRight', 'Align right', '<path d="M4 6h16M10 10.5h10M4 15h16M10 19.5h10"/>'],
    j: ['justifyFull', 'Justify', '<path d="M4 6h16M4 10.5h16M4 15h16M4 19.5h16"/>']
  }
  function ico (paths) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>' }
  function tbtn (cmd, label, title, style) { return '<button type="button" class="nt-tb-btn" data-cmd="' + cmd + '" title="' + title + '" aria-label="' + title + '"' + (style ? ' style="' + style + '"' : '') + '>' + label + '</button>' }
  function tbtn2 (cmd, label, title, arg) { return '<button type="button" class="nt-tb-btn" data-cmd="' + cmd + '" data-arg="' + esc(arg) + '" title="' + title + '" aria-label="' + title + '">' + label + '</button>' }

  function wireEditor (readonly) {
    if (readonly) {
      var rb = editorEl.querySelector('[data-restore]'); if (rb) rb.onclick = restoreNote
      var dp = editorEl.querySelector('[data-delete-perm]'); if (dp) dp.onclick = function () { deleteNote(true) }
      return
    }
    editorEl.querySelectorAll('.nt-tb-btn').forEach(function (b) {
      b.onmousedown = function (e) { e.preventDefault() }
      if (b.hasAttribute('data-image')) b.onclick = function () { $('ntImageInput').click() }
      else if (b.hasAttribute('data-link')) b.onclick = insertLink
      else if (b.hasAttribute('data-check')) b.onclick = toggleChecklist
      else if (b.hasAttribute('data-table')) b.onclick = function () { tableButton(b) }
      else if (b.hasAttribute('data-zoom')) b.onclick = function () { var step = +b.getAttribute('data-zoom'); setDocZoom(step ? (Math.round(docZoom * 10) + step) / 10 : 1) }
      else b.onclick = function () {
        var cmd = b.getAttribute('data-cmd'), arg = b.getAttribute('data-arg'), el = selEl()
        // A block button is a toggle: pressing H1 inside a heading goes back to plain text.
        if (arg && el && el.closest(arg.replace(/[<>]/g, ''))) arg = '<div>'
        document.execCommand(cmd, false, arg || null); markDirty(); syncToolbar()
      }
    })
    editorEl.querySelectorAll('[data-color]').forEach(function (input) {
      input.oninput = function () { document.execCommand(input.dataset.color, false, input.value); inkHighlights($('ntBody')); markDirty() }
      // The picker leaves focus on its input, where typing went nowhere: go back to the text, with the colour armed for what is typed next.
      input.onchange = function () { $('ntBody').focus(); if (window.getSelection().isCollapsed) document.execCommand(input.dataset.color, false, input.value) }
    })
    editorEl.querySelectorAll('.nt-tb-select').forEach(function (select) {
      select.onchange = function () { $('ntBody').focus(); document.execCommand(select.getAttribute('data-cmd'), false, select.value); markDirty(); syncToolbar() }
    })
    wireTitle()
    // Ticking a checkbox must not move focus onto it: typing then went nowhere and Space unticked it again.
    $('ntBody').addEventListener('mousedown', function (e) { if (e.target.nodeName === 'INPUT') e.preventDefault() })
    $('ntBody').addEventListener('keydown', bodyKeydown)
    $('ntBody').addEventListener('pointerdown', function (e) { tapType = e.pointerType })
    $('ntBody').addEventListener('click', bodyClick)
    $('ntBody').addEventListener('input', markDirty)
    $('ntBody').addEventListener('input', placeImageFrame)
    $('ntBody').addEventListener('input', syncToolbar) // an undo changes the alignment or font without moving the caret
    $('ntBody').addEventListener('change', function (event) {
      var checkbox = event.target.closest && event.target.closest('input[type="checkbox"]')
      if (!checkbox) return
      if (checkbox.checked) checkbox.setAttribute('checked', '')
      else checkbox.removeAttribute('checked')
      markDirty()
    })
    $('ntBody').addEventListener('paste', documentPaste)
    $('ntBody').addEventListener('dragstart', function () { ownDrag = true })
    $('ntBody').addEventListener('dragend', function () { ownDrag = false })
    $('ntBody').addEventListener('dragover', function (event) { event.preventDefault() })
    $('ntBody').addEventListener('drop', documentDrop)
    $('ntImageInput').onchange = function () { var file = firstImageFile(this.files); if (file) insertDocumentImage(file); this.value = '' }
    var pin = editorEl.querySelector('[data-pin]'); if (pin) pin.onclick = togglePin
    var del = editorEl.querySelector('[data-delete]'); if (del) del.onclick = function () { deleteNote(false) }
    S.editorReady = true
  }
  // ---- Document editing behaviour ------------------------------------------
  // The element holding the caret, or null when the selection is outside the note body.
  function selEl () {
    var body = $('ntBody'), sel = window.getSelection(), node = sel && sel.rangeCount ? sel.anchorNode : null
    if (node && node.nodeType !== 1) node = node.parentNode
    return node && body && body.contains(node) ? node : null
  }
  // Toolbar buttons show what applies at the caret, as in Word.
  function syncToolbar () {
    var bar = editorEl && editorEl.querySelector('.nt-toolbar'), el = bar && selEl(); if (!el) return
    bar.querySelectorAll('[data-cmd]').forEach(function (b) {
      var cmd = b.getAttribute('data-cmd'), arg = b.getAttribute('data-arg'), on = false
      if (b.tagName === 'SELECT') { var attr = cmd === 'fontName' ? 'face' : 'size', font = el.closest('font[' + attr + ']'); b.value = font ? font.getAttribute(attr) : attr === 'face' ? 'inherit' : '3'; return }
      if (arg) on = !!el.closest(arg.replace(/[<>]/g, ''))
      else if (/^(bold|italic|underline|strikeThrough|insertUnorderedList|insertOrderedList|justify\w+)$/.test(cmd)) { try { on = document.queryCommandState(cmd) } catch (e) {} } else return
      b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on))
    })
  }
  // Text of a code block with its line breaks, whichever way the browser stored them.
  function blockText (node) { var copy = node.cloneNode(true); copy.querySelectorAll('br').forEach(function (br) { br.replaceWith('\n') }); return copy.textContent }
  // Checklists (OneNote's to-do tag): a checkbox at the start of a line.
  var CHECKBOX = '<input type="checkbox">&nbsp;'
  function lineBlock (el) { var body = $('ntBody'); while (el && el !== body && !/^(DIV|P|LI|H[1-6]|BLOCKQUOTE)$/.test(el.tagName)) el = el.parentNode; return el && el !== body ? el : null }
  function leadingCheckbox (block) { var first = block && block.firstChild; while (first && first.nodeType === 3 && !first.nodeValue.trim()) first = first.nextSibling; return first && first.nodeName === 'INPUT' ? first : null }
  function toggleChecklist () {
    var body = $('ntBody'); if (!selEl()) { body.focus(); if (!selEl()) return }
    if (!lineBlock(selEl())) document.execCommand('formatBlock', false, '<div>') // a first line is bare text until it is wrapped
    var box = leadingCheckbox(lineBlock(selEl())), sel = window.getSelection()
    if (box) { if (box.nextSibling && box.nextSibling.nodeType === 3) box.nextSibling.nodeValue = box.nextSibling.nodeValue.replace(/^[\u00a0 ]/, ''); box.remove() } else {
      sel.modify('move', 'backward', 'lineboundary'); document.execCommand('insertHTML', false, CHECKBOX); sel.modify('move', 'forward', 'lineboundary')
    }
    markDirty()
  }
  function bodyKeydown (e) {
    if (e.isComposing) return
    var el = selEl(); if (!el) return
    var mod = e.ctrlKey || e.metaKey
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === '1')) { e.preventDefault(); if (e.key === 'k') insertLink(); else toggleChecklist(); return }
    var align = mod && e.shiftKey && !e.altKey && ALIGN[String(e.key).toLowerCase()]
    if (align) { e.preventDefault(); document.execCommand(align[0]); markDirty(); syncToolbar(); return }
    var cell = el.closest('td,th')
    if (e.key === 'Tab' && !mod && !e.altKey && cell) {
      // Word: Tab walks the cells and adds a row after the last one; Shift+Tab walks back.
      e.preventDefault()
      var cells = Array.prototype.slice.call(cell.closest('table').querySelectorAll('td,th')), next = cells[cells.indexOf(cell) + (e.shiftKey ? -1 : 1)]
      if (next) window.getSelection().selectAllChildren(next)
      else if (!e.shiftKey) tableEdit(cell, 'rowBelow', 0)
      return
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      // Tab indents (a list level, or a gap in text) instead of throwing focus
      // out of the note. Shift+Tab outside a list still leaves the editor.
      var li = el.closest('li')
      if (!li && e.shiftKey) return
      e.preventDefault()
      if (li) document.execCommand(e.shiftKey ? 'outdent' : 'indent')
      else document.execCommand('insertText', false, el.closest('pre') ? '  ' : '\u00a0\u00a0\u00a0\u00a0')
      return
    }
    if (e.key !== 'Enter' || e.shiftKey || mod || e.altKey) return
    var pre = el.closest('pre'), box = pre || el.closest('blockquote')
    if (box) {
      // Enter adds a line to a code block (it used to start a new block per line). Enter on an empty last line leaves
      // the code block or quote: Firefox keeps a quote's lines in one element, so an "empty quote" never came up there.
      var range = window.getSelection().getRangeAt(0)
      var head = range.cloneRange(); head.selectNodeContents(box); head.setEnd(range.startContainer, range.startOffset)
      var tail = range.cloneRange(); tail.selectNodeContents(box); tail.setStart(range.endContainer, range.endOffset)
      var onEmptyLastLine = range.collapsed && /\n$/.test(blockText(head.cloneContents())) && !blockText(tail.cloneContents()).replace(/\n$/, '')
      if (!blockText(box).trim() && !box.querySelector('img')) { e.preventDefault(); document.execCommand('formatBlock', false, '<div>'); return }
      if (onEmptyLastLine) {
        e.preventDefault()
        document.execCommand('delete')
        var after = document.createRange(), sel = window.getSelection(); after.setStartAfter(box); after.collapse(true); sel.removeAllRanges(); sel.addRange(after)
        document.execCommand('insertHTML', false, '<div><br></div>')
        // Firefox leaves the caret behind the new line's <br> and keeps that <br> beside what is typed (a stray blank
        // line above or below the text). With the <br> selected, typing replaces it in every browser.
        var line = box.nextElementSibling; if (line && line.tagName === 'DIV') sel.selectAllChildren(line)
        return
      }
      if (pre) { e.preventDefault(); document.execCommand('insertLineBreak'); return }
    }
    if (leadingCheckbox(lineBlock(el))) {
      // Enter continues a checklist; on an empty item it ends it.
      e.preventDefault()
      var item = lineBlock(el)
      if (item.textContent.replace(/\u00a0/g, ' ').trim()) { document.execCommand('insertParagraph'); document.execCommand('insertHTML', false, CHECKBOX) } else {
        item.innerHTML = '<br>'; var caret = document.createRange(), sel2 = window.getSelection(); caret.setStart(item, 0); caret.collapse(true); sel2.removeAllRanges(); sel2.addRange(caret); markDirty()
      }
    }
  }
  function bodyClick (e) {
    var body = $('ntBody'), link = e.target.closest && e.target.closest('a[href]')
    var url = link && safeUrl(link.getAttribute('href'), false)
    if (url && (e.ctrlKey || e.metaKey)) { window.open(url, '_blank', 'noopener,noreferrer'); return }
    // Touch has no Ctrl+click: a tap on a link offers to open it, as Word does on phones.
    if (url && (e.pointerType || tapType) === 'touch' && hasMenu()) {
      RdMenu.open(e.clientX, e.clientY, [
        { header: url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 34) },
        { label: 'Open link', icon: NI.open, action: function () { window.open(url, '_blank', 'noopener,noreferrer') } },
        { label: 'Edit link', icon: NI.rename, action: insertLink },
        { label: 'Remove link', icon: NI.trash, danger: true, action: function () { if (!link.isConnected) return; window.getSelection().selectAllChildren(link); document.execCommand('unlink'); markDirty() } }
      ])
      return
    }
    frameImage(e.target.nodeName === 'IMG' ? e.target : null)
    // A note ending in a code block, quote, table or list had no way to type
    // below it: a click under the last block starts a fresh line there.
    var last = body.lastElementChild
    while (last && last.tagName === 'DIV' && last.lastElementChild && !(last.lastChild.nodeType === 3 && last.lastChild.nodeValue.trim())) last = last.lastElementChild // the browser nests blocks in wrapper divs
    if (e.target !== body || !last || !/^(PRE|BLOCKQUOTE|TABLE|UL|OL|HR|IMG)$/.test(last.tagName) || e.clientY <= last.getBoundingClientRect().bottom) return
    var line = document.createElement('div'); line.appendChild(document.createElement('br')); body.appendChild(line)
    var sel = window.getSelection(), range = document.createRange(); range.setStart(line, 0); range.collapse(true); sel.removeAllRanges(); sel.addRange(range)
  }
  async function insertLink () {
    var body = $('ntBody'), sel = window.getSelection()
    var range = selEl() ? sel.getRangeAt(0).cloneRange() : null
    // Word: Ctrl+K inside a link edits that link (it used to nest a second link in it); clearing the address removes it.
    var link = selEl() && selEl().closest('a[href]')
    var typed = await openPrompt(link ? 'Edit link' : 'Insert link', 'example.com', link ? link.getAttribute('href') : '')
    if (typed == null || $('ntBody') !== body || (link && !link.isConnected)) return
    typed = typed.trim()
    if (!typed && !link) return
    // A bare "example.com" used to resolve against this site and link to /example.com.
    var safe = safeUrl(/^(https?:\/\/|mailto:)/i.test(typed) ? typed : 'https://' + typed, false)
    if (typed && !safe) { toast('THAT LINK IS NOT VALID', 'error'); return }
    body.focus()
    if (link) sel.selectAllChildren(link)
    else if (range) { sel.removeAllRanges(); sel.addRange(range) }
    if (!typed) document.execCommand('unlink')
    else if (sel.isCollapsed) document.execCommand('insertHTML', false, '<a href="' + esc(safe) + '">' + esc(typed) + '</a>')
    else document.execCommand('createLink', false, safe)
    if (link) sel.collapseToEnd()
    markDirty()
  }

  // ---- Tables and pictures -------------------------------------------------
  // Swaps one element for new markup (or nothing) as a single undo step, and returns the element that took its place.
  function swapNode (node, html) {
    var body = $('ntBody'), sel = window.getSelection(), range = document.createRange()
    range.selectNode(node); sel.removeAllRanges(); sel.addRange(range)
    if (!html) { document.execCommand('delete'); return null }
    body.querySelectorAll('[data-nt-new]').forEach(function (old) { old.removeAttribute('data-nt-new') }) // a redo brings the marker back
    document.execCommand('insertHTML', false, html.replace(/^<\w+/, '$& data-nt-new'))
    var fresh = body.querySelector('[data-nt-new]'); if (fresh) fresh.removeAttribute('data-nt-new')
    return fresh
  }
  // Row and column edits of the table around `cell`; `col` overrides the column the caret lands in.
  // ponytail: counts cells, not grid columns, so a pasted table with merged cells shifts; map colspans if that matters.
  function tableEdit (cell, op, col) {
    var table = cell.closest('table'), r = cell.parentNode.rowIndex, c = col == null ? cell.cellIndex : col
    var copy = table.cloneNode(true), width = copy.rows[r].cells.length
    var eachRow = function (fn) { Array.prototype.forEach.call(copy.rows, fn) }
    var blank = function (row, at) { row.insertCell(Math.min(at, row.cells.length)).innerHTML = '<br>' }
    if (op === 'rowAbove' || op === 'rowBelow') { if (op === 'rowBelow') r++; var added = copy.insertRow(r); for (var i = 0; i < width; i++) blank(added, i) }
    else if (op === 'colLeft' || op === 'colRight') { if (op === 'colRight') c++; eachRow(function (row) { blank(row, c) }) }
    else if (op === 'delRow') { copy.deleteRow(r); r = Math.min(r, copy.rows.length - 1) }
    else if (op === 'delCol') { eachRow(function (row) { if (row.cells[c]) row.deleteCell(c) }); c = Math.min(c, width - 2) }
    var gone = op === 'delTable' || !copy.rows.length || !copy.rows[0].cells.length
    var fresh = swapNode(table, gone ? '' : copy.outerHTML), target = fresh && fresh.rows[r] && (fresh.rows[r].cells[c] || fresh.rows[r].cells[0])
    if (target) window.getSelection().collapse(target, 0)
    markDirty()
  }
  // Outside a table the button inserts one; inside it offers the row and column commands (touch has no Tab key or right-click).
  function tableButton (button) {
    var cell = selEl() && selEl().closest('td,th')
    if (!cell || !hasMenu()) {
      var row = '<tr>' + new Array(4).join('<td><br></td>') + '</tr>'
      insertSanitizedHtml('<table><tbody>' + new Array(4).join(row) + '</tbody></table><div><br></div>')
      var here = selEl(), table = here && (here.closest('table') || (lineBlock(here) || {}).previousElementSibling) // the caret is now in the line after the table
      if (table && table.tagName === 'TABLE') window.getSelection().collapse(table.rows[0].cells[0], 0)
      markDirty(); return
    }
    var rect = button.getBoundingClientRect(), item = function (label, op, danger) { return { label: label, danger: danger, action: function () { if (cell.isConnected) { $('ntBody').focus(); tableEdit(cell, op) } } } }
    RdMenu.open(rect.left, rect.bottom + 4, [
      item('Insert row above', 'rowAbove'), item('Insert row below', 'rowBelow'), item('Insert column left', 'colLeft'), item('Insert column right', 'colRight'), { sep: true },
      item('Delete row', 'delRow', true), item('Delete column', 'delCol', true), item('Delete table', 'delTable', true)
    ])
  }
  // Word: clicking a picture selects it and shows a frame; dragging the frame's corner resizes it in proportion.
  // The frame lives outside the note body (so it is never saved), in a layer clipped to the body's box.
  var imgFrame = null, tapType = ''
  function frameImage (img) {
    if (imgFrame) imgFrame.remove()
    imgFrame = null
    if (!img || !S.editorReady) return
    var range = document.createRange(), sel = window.getSelection(); range.selectNode(img); sel.removeAllRanges(); sel.addRange(range) // Delete, copy and typing act on the picture
    imgFrame = document.createElement('div'); imgFrame.className = 'nt-img-layer'; imgFrame.innerHTML = '<div class="nt-img-frame"><span class="nt-img-handle" title="Drag to resize"></span></div>'
    imgFrame.img = img; editorEl.appendChild(imgFrame); placeImageFrame()
    imgFrame.querySelector('.nt-img-handle').addEventListener('pointerdown', resizeImage)
  }
  function placeImageFrame () {
    if (!imgFrame) return
    var body = $('ntBody'), img = imgFrame.img
    if (!body || !img.isConnected) { frameImage(null); return }
    var host = editorEl.getBoundingClientRect(), clip = body.getBoundingClientRect(), box = img.getBoundingClientRect(), frame = imgFrame.firstChild
    imgFrame.style.cssText = 'left:' + (clip.left - host.left) + 'px;top:' + (clip.top - host.top) + 'px;width:' + body.clientWidth + 'px;height:' + clip.height + 'px'
    frame.style.cssText = 'left:' + (box.left - clip.left) + 'px;top:' + (box.top - clip.top) + 'px;width:' + box.width + 'px;height:' + box.height + 'px'
  }
  function resizeImage (e) {
    e.preventDefault()
    var handle = e.currentTarget, img = imgFrame.img, was = img.getAttribute('width'), start = img.getBoundingClientRect().width, width = 0
    handle.setPointerCapture(e.pointerId)
    handle.onpointermove = function (move) {
      width = Math.max(24, Math.round((start + move.clientX - e.clientX) / docZoom))
      img.removeAttribute('height'); img.setAttribute('width', width); placeImageFrame() // the height follows (notes.css: height auto)
    }
    handle.onpointerup = handle.onpointercancel = function (end) {
      handle.onpointermove = handle.onpointerup = handle.onpointercancel = null
      if (!width || !img.isConnected) return
      // Put the old width back, then make the change as an edit, so that Ctrl+Z undoes the resize.
      if (was == null) img.removeAttribute('width'); else img.setAttribute('width', was)
      if (end.type === 'pointercancel') { placeImageFrame(); return }
      var copy = img.cloneNode(false); copy.removeAttribute('height'); copy.setAttribute('width', width)
      frameImage(swapNode(img, copy.outerHTML)); markDirty()
    }
  }

  function markDirty () {
    // Never arm a save against an editor that is not fully mounted — the body
    // would serialise as '' and overwrite the note.
    if (!S.editorReady) return
    // Editing this note again cancels an open that is waiting on its save: the
    // save's finally would otherwise switch notes under the user's typing.
    S.pendingOpenId = S.noteId
    S.editRevision++; S.dirty = true; setSaveState('Unsaved')
    if (S.isSaving) { S.saveAgain = true; return }
    clearTimeout(S.saveTimer); S.saveTimer = setTimeout(saveNote, 1100)
  }
  function setSaveState (t) { var e = $('ntSaveState'); if (e) e.textContent = t }
  function firstImageFile (files) { return Array.prototype.slice.call(files || []).filter(function (file) { return file && /^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.type) })[0] || null }
  function hasImageFile (files) { return !!firstImageFile(files) }
  function documentInlineSize () { var el = $('ntBody'); return el ? (el.innerHTML || '').length : 0 }
  function budgetToast () { toast('NOTE IS FULL (LIMIT ' + mbLabel(NOTES_INLINE_BUDGET_BYTES) + '). REMOVE AN IMAGE FIRST', 'error') }
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
      insertSanitizedHtml('<img src="' + esc(dataUrl) + '" alt="' + esc(file.name || 'Image') + '">'); markDirty()
    }
    reader.onerror = function () { if (S.noteId === sourceId) toast('COULD NOT READ IMAGE', 'error') }
    reader.readAsDataURL(file)
  }
  // Through execCommand, so a paste or drop is one undo step (direct DOM edits
  // are invisible to the browser's undo stack and corrupt it).
  function insertSanitizedHtml (html, text) {
    var clean = html ? sanitizeHtml(html) : ''
    if (!selEl()) { var body = $('ntBody'); if (!body) return; body.focus(); window.getSelection().selectAllChildren(body); window.getSelection().collapseToEnd() }
    if (clean) document.execCommand('insertHTML', false, clean)
    else document.execCommand('insertText', false, text || '')
  }
  function documentPaste (event) {
    var file = firstImageFile(event.clipboardData && event.clipboardData.files)
    if (file) { event.preventDefault(); insertDocumentImage(file); return }
    event.preventDefault(); insertSanitizedHtml(event.clipboardData && event.clipboardData.getData('text/html'), event.clipboardData && event.clipboardData.getData('text/plain')); markDirty()
  }
  // Dragging the note's own text or picture is the browser's native move. Handling that drop here re-inserted the
  // content without removing it from where it came from.
  var ownDrag = false
  function documentDrop (event) {
    if (ownDrag) return
    event.preventDefault()
    // Insert where it was dropped, not wherever the caret happened to be.
    var at = document.caretRangeFromPoint && document.caretRangeFromPoint(event.clientX, event.clientY)
    var pos = !at && document.caretPositionFromPoint && document.caretPositionFromPoint(event.clientX, event.clientY) // Firefox
    if (pos) { at = document.createRange(); at.setStart(pos.offsetNode, pos.offset); at.collapse(true) }
    if (at) { var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(at) }
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
    var title = titleEl ? titleValue(titleEl) : S.titles[S.noteId] || 'Untitled'
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
    if (!payload) { toast('NOTHING TO EXPORT. THE EDITOR IS NOT MOUNTED', 'error'); return false }
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
    state.innerHTML = '<button type="button" class="nt-conflict-btn">Conflict: reopen</button>'
    state.title = 'This note was changed in another tab.'
    state.querySelector('button').onclick = async function () {
      if (!(await confirmAbandonUnsaved('THIS NOTE WAS CHANGED IN ANOTHER TAB, SO YOUR VERSION CANNOT BE SAVED OVER IT.'))) return
      openNote(S.pendingOpenId || S.noteId)
    }
  }
  function showBlockedState (message) {
    var state = $('ntSaveState'); if (!state) return
    state.innerHTML = '<button type="button" class="nt-conflict-btn">Not saved: export</button>'
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
  // Every note PUT (content save AND pin/colour/rename/move) runs through this
  // one queue. The server bumps content_version on each of them, so two PUTs in
  // flight with the same expected version always 409 one of them.
  var writeQueue = Promise.resolve()
  function queueWrite (fn) {
    var run = writeQueue.then(fn)
    writeQueue = run.catch(function () {})
    return run
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
      toast('EDITOR IS NOT READY. NOTE NOT SAVED', 'error')
      return
    }
    if (snap.type === 'canvas' && !validateCanvasData(JSON.parse(body))) {
      // Saving would store a canvas openNote() refuses to load, locking the note.
      // Blocked (not just failed) so openNote/createNote can offer export + discard.
      setSaveState('Save failed')
      S.saveBlocked = true
      showBlockedState('This canvas is over its size limits, so it was not saved. Remove some content or export it.')
      toast('CANVAS IS OVER ITS SIZE LIMITS. NOTE NOT SAVED', 'error')
      return
    }
    var title = titleValue(titleEl)
    S.isSaving = true; S.saveAgain = false
    var saveRevision = S.editRevision
    setSaveState('Saving…')
    try {
      var contentEnc = await encContent(body, snap.key)
      // Preflight against the REAL server limit (app.py
      // NOTES_NOTE_CONTENT_MAX_BYTES) instead of firing a doomed request.
      if (contentEnc.length > NOTES_CONTENT_MAX_BYTES) {
        var big = new Error('NOTE TOO LARGE'); big.status = 413; big.oversize = true; throw big
      }
      var resp = await queueWrite(async function () {
        // Read the title only now, so a rename that landed while the body was
        // encrypting is not written back over.
        if (titleEl.isConnected) title = titleValue(titleEl)
        var titleEnc = await OneGyCrypto.encryptFileName(title, snap.key)
        // A queued metadata PUT may have bumped the version of this same note.
        if (snap.id === S.noteId && snap.key === S.noteKey && snap.type === S.currentType) snap.ver = S.ver
        // Re-verify the snapshot AFTER the awaits and BEFORE the PUT. The old
        // check ran after the request had already been sent, so it prevented
        // nothing.
        if (!snapshotIsCurrent(snap)) return null
        var r = await apiSend('PUT', '/notes/api/notes/' + encodeURIComponent(snap.id), {
          encrypted_title: titleEnc.encryptedName, title_nonce: titleEnc.nameNonce,
          encrypted_content: contentEnc, content_nonce: contentNonceOf(contentEnc), expected_content_version: snap.ver
        })
        // Inside the queue, so the next queued write already sends this version.
        applyMetadataVersion(snap.id, { content_version: r.content_version || (snap.ver + 1) })
        return r
      })
      if (!resp) { S.saveAgain = true; setSaveState('Unsaved'); return }
      var n = S.notes.filter(function (x) { return x.id === snap.id })[0]
      if (S.noteId !== snap.id) return
      S.saveFailures = 0
      S.saveBlocked = false
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
        msg = 'NOTE CHANGED IN ANOTHER TAB. REOPEN IT BEFORE SAVING'
        showConflictState()
      } else if (status >= 400 && status < 500) {
        // Non-retryable. Retrying byte-identical content forever would pin
        // S.dirty and block opening ANY note, so mark it blocked instead: the
        // content stays in the editor and openNote can now ask to move on.
        clearTimeout(S.saveTimer); S.saveTimer = null
        S.saveBlocked = true
        if (e.oversize || status === 413) {
          msg = (e.body && e.body.error === 'STORAGE LIMIT EXCEEDED')
            ? 'STORAGE LIMIT REACHED. FREE UP SPACE, THIS NOTE WAS NOT SAVED'
            : 'NOTE IS TOO LARGE TO SAVE (LIMIT ' + mbLabel(NOTES_CONTENT_MAX_BYTES) + ' ENCRYPTED). REMOVE SOME IMAGES'
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
      await loadAll(); await openNote(resp.id)
      // OneNote: a new page starts with the caret in its title; Enter moves into the page.
      if (S.noteId === resp.id && S.editorReady && $('ntTitle')) $('ntTitle').focus()
    } catch (e) { toast('COULD NOT CREATE NOTE', 'error'); if (!S.noteId) hideEditorMobile() }
  }

  async function createNotebook (name) {
    var mk = await masterKey(); if (!mk) { toast('UNLOCK YOUR KEYS FIRST', 'error'); return }
    try {
      var nameKey = await OneGyCrypto.generateFolderNameKey()
      var enc = await OneGyCrypto.encryptFolderName(name, nameKey)
      var wrapped = await OneGyCrypto.wrapFolderNameKey(nameKey, mk)
      var made = await apiSend('POST', '/notes/api/notebooks', {
        encrypted_name: enc.encryptedName, name_nonce: enc.nameNonce,
        encrypted_name_key: wrapped.encryptedNameKey, name_key_nonce: wrapped.nonce
      })
      if (made.id != null) S.view = String(made.id)
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
    if (perm && !(await confirmForever())) return
    if (!perm && S.dirty) { if (S.canvas && S.canvas.flush) S.canvas.flush(); await saveNote(); if (S.dirty) { toast('SAVE THE NOTE BEFORE MOVING IT TO TRASH', 'error'); return } }
    try {
      await apiSend('DELETE', '/notes/api/notes/' + encodeURIComponent(S.noteId) + (perm ? '?permanent=true' : ''), null)
      toast(perm ? 'NOTE DELETED' : 'MOVED TO TRASH', 'success')
      closeEditor()
      await loadAll()
    } catch (e) { toast('COULD NOT DELETE NOTE', 'error') }
  }
  async function restoreNote () {
    if (!S.noteId) return
    try { await apiSend('POST', '/notes/api/notes/' + encodeURIComponent(S.noteId) + '/restore', {}); toast('NOTE RESTORED', 'success'); closeEditor(); await loadAll() } catch (e) { toast('COULD NOT RESTORE', 'error') }
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

  // Waits its turn behind any in-flight save and only then reads the version.
  function putMetadata (id, payload) {
    return queueWrite(async function () {
      payload.expected_content_version = noteVersion(id)
      var resp = await apiSend('PUT', '/notes/api/notes/' + encodeURIComponent(id), payload)
      applyMetadataVersion(id, resp)
      return resp
    })
  }

  function applyMetadataVersion (id, response) {
    if (!response || !response.content_version) return
    var n = noteById(id)
    // The server stamps updated_at on pin/colour/rename/move too: follow it, or the list reorders on the next reload.
    if (n && response.updated_at) n.updated_at = response.updated_at
    if (n) n.content_version = response.content_version
    if (S.noteId === id) S.ver = response.content_version
    if (S.meta && S.meta.id === id) S.meta.content_version = response.content_version
  }

  // The empty state has no back button, so a phone must return to the list
  // with it (trashing the open note used to strand the phone on a blank pane).
  function closeEditor () {
    resetOpenState(emptyEditor())
    S.noteId = null
    hideEditorMobile()
  }
  function clearEditorIfOpen (id) { if (S.noteId === id) closeEditor() }

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
      await putMetadata(id, { color: safe })
      n.color = safe
      if (S.meta && S.meta.id === id) S.meta.color = safe
      renderList()
    } catch (e) { toast('COULD NOT UPDATE COLOUR', 'error') }
  }

  async function togglePinById (id) {
    var n = noteById(id); if (!n) return
    var np = !n.is_pinned
    try {
      await putMetadata(id, { is_pinned: np })
      n.is_pinned = np
      if (S.meta && S.meta.id === id) S.meta.is_pinned = np
      renderList()
      var pb = S.noteId === id && editorEl.querySelector('[data-pin]')
      if (pb) { pb.querySelector('svg').setAttribute('fill', np ? 'currentColor' : 'none'); pb.setAttribute('aria-pressed', String(np)); pb.title = np ? 'Unpin' : 'Pin to top' }
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
      await putMetadata(id, { encrypted_title: enc.encryptedName, title_nonce: enc.nameNonce })
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
      await loadAll()
    } catch (e) { toast('COULD NOT CONFIRM NOTE DUPLICATION. REFRESH TO CHECK', 'error') }
  }

  async function moveNoteById (id, notebookId) {
    var n = noteById(id); if (!n) return
    try {
      await putMetadata(id, { notebook_id: notebookId })
      n.notebook_id = notebookId
      if (S.meta && S.meta.id === id) S.meta.notebook_id = notebookId
      toast('NOTE MOVED', 'success')
      await loadAll()
    } catch (e) { toast('COULD NOT MOVE NOTE', 'error') }
  }

  async function trashNoteById (id) {
    if (!noteById(id)) return
    if (!(await flushIfOpen(id))) { toast('SAVE THE NOTE BEFORE MOVING IT TO TRASH', 'error'); return }
    try {
      await apiSend('DELETE', '/notes/api/notes/' + encodeURIComponent(id), null)
      toast('MOVED TO TRASH', 'success')
      clearEditorIfOpen(id)
      await loadAll()
    } catch (e) { toast('COULD NOT DELETE NOTE', 'error') }
  }

  function confirmDanger (title, message, action) {
    if (window.showConfirm) return window.showConfirm(title, message, action)
    return Promise.resolve(window.confirm(title + '\n\n' + message))
  }
  function confirmForever () { return confirmDanger('Delete this note forever?', 'It will be removed permanently. This cannot be undone.', 'Delete forever') }

  async function deleteForeverById (id) {
    if (!(await confirmForever())) return
    try {
      await apiSend('DELETE', '/notes/api/notes/' + encodeURIComponent(id) + '?permanent=true', null)
      toast('NOTE DELETED', 'success')
      clearEditorIfOpen(id)
      await loadAll()
    } catch (e) { toast('COULD NOT DELETE NOTE', 'error') }
  }

  async function restoreNoteById (id) {
    try {
      await apiSend('POST', '/notes/api/notes/' + encodeURIComponent(id) + '/restore', {})
      toast('NOTE RESTORED', 'success')
      clearEditorIfOpen(id)
      await loadAll()
    } catch (e) { toast('COULD NOT RESTORE', 'error') }
  }

  async function emptyTrash () {
    if (!(await confirmDanger('Empty the trash?', 'Everything in the trash will be deleted permanently. This cannot be undone.', 'Empty trash'))) return
    // Only close the editor if it shows one of the deleted notes: a live note
    // left open while browsing the trash may hold unsaved edits.
    var trashed = S.view === 'trash' ? S.notes.map(function (n) { return n.id }) : []
    try {
      await apiSend('DELETE', '/notes/api/trash', null)
      toast('TRASH EMPTIED', 'success')
      trashed.forEach(clearEditorIfOpen)
      await loadAll()
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
    doc: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h4"/>',
    canvas: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
    notebook: '<path d="M5.5 18.5v-13a2 2 0 0 1 2-2h11v13h-11a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h11"/><path d="M9.5 7.5h5"/>',
    back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    all: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
    unfiled: '<path d="M4 13.5V6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>'
  }
  function hasMenu () { return typeof window.RdMenu !== 'undefined' }

  function colorRow (color, onPick) {
    var current = normColor(color)
    return { swatches: NOTE_COLORS.map(function (c) { return { color: c.color, label: c.label, active: normColor(c.color) === current } }), onPick: onPick }
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
      colorRow(n.color, function (c) { setNoteColorById(n.id, c) }),
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
      { label: 'New note', icon: NI.doc, hint: 'Document', action: function () { createNote('document') } },
      { label: 'New canvas', icon: NI.canvas, hint: 'Freeform page', action: function () { createNote('canvas') } },
      { sep: true },
      { label: 'New notebook', icon: NI.notebook, action: function () { openNbModal() } }
    ]
  }
  // The list head's two buttons drop a menu: the title switches notebook,
  // "New" offers the same create menu as a right-click on the list.
  function openNewMenu (btn, focusFirst) {
    var sw = btn.id === 'ntSwitch'
    if (!hasMenu()) { if (!sw) createNote('document'); return }
    var rect = btn.getBoundingClientRect()
    headMenuBtn = btn.id
    RdMenu.open(rect.left, rect.bottom + 4, sw ? switchMenu() : listMenu())
    var first = focusFirst && document.querySelector('.rd-cmenu.is-open .rd-cmenu-item'); if (first) first.focus()
  }

  // ---- Notebooks (the switcher: the list head's title) ----------------------
  function switchMenu () {
    var go = function (v) { return function () { S.view = v; loadNotes() } }
    var items = [
      { label: 'All notes', icon: NI.all, active: S.view === 'all', action: go('all') },
      { label: 'Unfiled', icon: NI.unfiled, active: S.view === 'unfiled', action: go('unfiled') },
      { header: 'Notebooks' }
    ]
    var current = null
    S.notebooks.filter(function (nb) { return !nb.is_trashed }).forEach(function (nb) {
      var col = normColor(nb.color), on = String(S.view) === String(nb.id)
      if (on) current = nb
      items.push({ label: nb._name || 'Notebook', icon: col ? '<g stroke="' + col + '">' + NI.notebook + '</g>' : NI.notebook, hint: String(nb.note_count || 0), active: on, action: go(String(nb.id)) })
    })
    items.push({ label: 'New notebook', icon: NI.note, action: openNbModal })
    // Rename, colour and delete act on the notebook being viewed.
    if (current) items = items.concat([{ sep: true }, { header: current._name }], notebookMenu(current))
    items.push({ sep: true }, { label: 'Trash', icon: NI.trash, hint: S.trashCount ? String(S.trashCount) : '', active: S.view === 'trash', action: go('trash') })
    return items
  }
  function notebookMenu (nb) {
    var items = []
    // The shared inbox is a system notebook: the server refuses to rename or delete it.
    if (!nb.system_key) items.push({ label: 'Rename', icon: NI.rename, action: function () { renameNotebook(nb) } })
    items.push({ header: 'Colour' }, colorRow(nb.color, function (c) { setNotebookColor(nb, c) }))
    if (!nb.system_key) items.push({ sep: true }, { label: 'Delete notebook', icon: NI.trash, danger: true, action: function () { deleteNotebook(nb) } })
    return items
  }
  async function renameNotebook (nb) {
    var mk = await masterKey(); if (!mk) { toast('UNLOCK YOUR KEYS FIRST', 'error'); return }
    var next = ((await openPrompt('Rename notebook', 'Notebook name', nb._name)) || '').trim()
    if (!next || next === nb._name) return
    try {
      var key = await OneGyCrypto.unwrapFolderNameKey(nb.encrypted_name_key, nb.name_key_nonce, mk)
      var enc = await OneGyCrypto.encryptFolderName(next, key)
      await apiSend('PUT', '/notes/api/notebooks/' + nb.id, { encrypted_name: enc.encryptedName, name_nonce: enc.nameNonce })
      nb.encrypted_name = enc.encryptedName; nb.name_nonce = enc.nameNonce; nb._name = next
      renderList()
      toast('NOTEBOOK RENAMED', 'success')
    } catch (e) { toast('COULD NOT RENAME NOTEBOOK', 'error') }
  }
  async function setNotebookColor (nb, color) {
    var safe = normColor(color)
    try { await apiSend('PUT', '/notes/api/notebooks/' + nb.id, { color: safe }); nb.color = safe; renderList() } catch (e) { toast('COULD NOT UPDATE COLOUR', 'error') }
  }
  async function deleteNotebook (nb) {
    var count = nb.note_count || 0
    var message = count ? (count === 1 ? 'Its note moves' : 'Its ' + count + ' notes move') + ' to the trash, where you can still restore ' + (count === 1 ? 'it' : 'them') + '.' : 'This notebook is empty.'
    if (!(await confirmDanger('Delete “' + nb._name + '”?', message, 'Delete notebook'))) return
    // The open note may be about to move to the trash: save it, then close it.
    if (S.noteId && S.meta && String(S.meta.notebook_id) === String(nb.id)) {
      if (!(await flushIfOpen(S.noteId))) { toast('SAVE THE OPEN NOTE BEFORE DELETING ITS NOTEBOOK', 'error'); return }
      closeEditor()
    }
    try {
      await apiSend('DELETE', '/notes/api/notebooks/' + nb.id, null)
      if (String(S.view) === String(nb.id)) S.view = 'all'
      toast('NOTEBOOK DELETED', 'success')
      await loadAll()
    } catch (e) { toast('COULD NOT DELETE NOTEBOOK', 'error') }
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
  function fmtDate (iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; var now = new Date(); var sameDay = d.toDateString() === now.toDateString(); return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }) }
  function errState (m) { return '<div class="rd-empty is-error"><span class="rd-empty-icon">' + ico('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/>') + '</span><p class="rd-empty-text">' + esc(m) + '</p></div>' }
  function emptyEditor () {
    var copy = S.view === 'trash' ? ['Nothing selected', 'Open a note in the trash to restore it or delete it forever.']
      : S.notes.length ? ['Select a note', 'Pick a note from the list or start a new one.']
      : S.view === 'all' ? ['Write your first note', 'Notes and canvases are end-to-end encrypted, so only you can read them.']
      : ['Start a note here', S.view === 'unfiled' ? 'Notes you create here stay outside any notebook.' : 'Notes you create here go into this notebook.']
    return '<div class="rd-empty nt-empty-editor"><span class="rd-empty-icon">' + ico(NI.doc) + '</span><h3 class="rd-empty-title">' + copy[0] + '</h3>' +
      '<p class="rd-empty-text">' + copy[1] + '</p>' + (S.view === 'trash' ? '</div>' :
      '<div class="nt-empty-actions"><button type="button" class="rd-btn rd-btn-primary" data-new="document">' + ico('<path d="M12 5.5v13M5.5 12h13"/>') + 'New note</button>' +
      '<button type="button" class="rd-btn rd-btn-ghost" data-new="canvas">' + ico(NI.canvas) + 'New canvas</button></div></div>')
  }

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
    listEl.addEventListener('click', function (e) {
      // A long-press already opened the menu; swallow the click it trails.
      if (lpFired) { lpFired = false; e.preventDefault(); e.stopPropagation(); return }
      // A second click on the button closes its menu (RdMenu already did, on mousedown).
      var newBtn = e.target.closest('#ntNewNote, #ntSwitch'); if (newBtn) { if (e.detail === 0 || !newMenuWasOpen) openNewMenu(newBtn, e.detail === 0); return } // detail 0 = keyboard: no mousedown ever resets the flag
      if (e.target.closest('#ntEmptyTrash')) { emptyTrash(); return }
      // Clicking the note that is already open just shows it: reloading it threw away the caret and scroll position.
      var it = e.target.closest('[data-note]'); if (it) { if (it.getAttribute('data-note') !== S.noteId || !S.editorReady) openNote(it.getAttribute('data-note')); showEditorMobile(); return }
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
    bindLongPress(listEl, '[data-note]', function (x, y, card) { openNoteMenu(x, y, card.getAttribute('data-note')) })
    document.addEventListener('mousedown', function (e) { newMenuWasOpen = !!(headMenuBtn && e.target.closest && e.target.closest('#' + headMenuBtn) && document.querySelector('.rd-cmenu.is-open')) }, true)
    document.addEventListener('selectionchange', syncToolbar)
    // The picture frame goes when the selection moves off the picture.
    document.addEventListener('selectionchange', function () { if (imgFrame && !window.getSelection().containsNode(imgFrame.img)) frameImage(null) })
    // Ctrl/Cmd+S saves now instead of opening the browser's "save page" dialog.
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || String(e.key).toLowerCase() !== 's' || !S.noteId) return
      e.preventDefault(); saveNow()
    })
    // A phone can freeze or drop a background tab at any moment: do not leave an edit waiting on the autosave timer.
    document.addEventListener('visibilitychange', function () { if (document.hidden) saveNow() })
    // Phones: the browser/system back button returns from the editor to the list.
    window.addEventListener('popstate', function (e) { $('ntPanes') && $('ntPanes').classList.toggle('nt-show-editor', !!(e.state && e.state.ntEditor)) })
    listEl.addEventListener('input', function (e) { if (e.target.id === 'ntSearch') renderList(e.target.value) })
    document.addEventListener('click', function (e) { if (e.target.closest('#ntBackBtn')) hideEditorMobile() })
    // Notebook modal
    editorEl.addEventListener('click', function (e) { var nb = e.target.closest('[data-new]'); if (nb) createNote(nb.getAttribute('data-new')) })
    $('ntNbSave') && ($('ntNbSave').onclick = function () { var n = $('ntNbName').value.trim(); if (!n) return; closeNbModal(); createNotebook(n) })
    $('ntNbName') && $('ntNbName').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('ntNbSave').click() } })
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
  var newMenuWasOpen = false, headMenuBtn = null  // the head button whose menu was opened last
  function saveNow () { if (!S.dirty || S.saveBlocked) return; if (S.canvas && S.canvas.flush) S.canvas.flush(); saveNote() }
  function bindLongPress (root, selector, open) {
    root.addEventListener('pointerdown', function (e) {
      lpFired = false
      if (e.pointerType === 'mouse') return
      var card = e.target.closest(selector); if (!card) return
      cancelLongPress()
      longPress = { x: e.clientX, y: e.clientY }
      longPress.timer = setTimeout(function () {
        if (!longPress) return
        lpFired = true
        open(longPress.x, longPress.y, card)
        longPress = null
      }, 500)
    })
    root.addEventListener('pointermove', function (e) {
      if (!longPress) return
      if (Math.abs(e.clientX - longPress.x) > 10 || Math.abs(e.clientY - longPress.y) > 10) cancelLongPress()
    })
    root.addEventListener('pointerup', cancelLongPress)
    root.addEventListener('pointercancel', cancelLongPress)
  }
  // One pane at a time on phones. Opening the editor adds a history entry there, so Back returns to the list.
  function showEditorMobile () {
    var panes = $('ntPanes'); if (!panes || panes.classList.contains('nt-show-editor')) return
    panes.classList.add('nt-show-editor')
    if (window.matchMedia('(max-width:720px)').matches) history.pushState({ ntEditor: true }, '')
  }
  function hideEditorMobile () {
    if (history.state && history.state.ntEditor) history.back()
    else if ($('ntPanes')) $('ntPanes').classList.remove('nt-show-editor')
  }
  function openNbModal () { var m = $('ntNbModal'); m.classList.add('rd-open'); m.setAttribute('aria-hidden', 'false'); $('ntNbName').value = ''; setTimeout(function () { $('ntNbName').focus() }, 30) }
  function closeNbModal () { var m = $('ntNbModal'); m.classList.remove('rd-open'); m.setAttribute('aria-hidden', 'true') }
  function inkHighlights (root) { if (root && window.FxCanvas && FxCanvas.inkHighlights) FxCanvas.inkHighlights(root) }
  function destroyCanvas () { if (S.canvas) { try { S.canvas.destroy() } catch (e) {} S.canvas = null } }

  // ---- Mock hook (headless screenshots) ------------------------------------
  window.__ntMock = function (data) {
    S.notebooks = (data.notebooks || []).map(function (n) { n._name = n.name; return n })
    S.notes = (data.notes || []).map(function (n) { n._title = n.title; return n })
    S.view = data.view || 'all'
    showLock(false); renderList()
    if (data.openNote) { var n = S.notes.filter(function (x) { return x.id === data.openNote })[0]; S.noteId = data.openNote; if (n) { renderList(); renderEditor(n._title, data.noteHtml || '', false) } }
    else editorEl.innerHTML = emptyEditor()
  }

  // ---- Boot ----------------------------------------------------------------
  function boot () {
    listEl = $('ntList'); editorEl = $('ntEditor')
    if (!listEl) return
    // The empty state waits for the first list load: its copy depends on whether there are notes.
    wire()
    if (!window.__NT_NO_AUTOLOAD__) loadAll()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
