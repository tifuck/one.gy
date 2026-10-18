/* ============================================================================
   preview.js — Frost file preview + text editor for the Files page.
   Double-click a file → this modal. Renders images / video / audio / PDF and
   an editable text/code editor. All E2EE decrypt + re-encrypt reuse
   window.OneGyCrypto (never re-implemented). Save mirrors the legacy
   /file/<id>/save-content flow (E2E: new file key + re-encrypted name +
   re-wrapped link key; plain: raw bytes).
   Exposes window.FxPreview = { open(fileItem), close() }.
   ========================================================================== */
(function () {
  'use strict'

  var EDITOR_MAX = 5 * 1024 * 1024
  var IMG = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']
  var TXT = ['txt', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'py', 'js', 'html', 'css', 'sh', 'ini', 'cfg', 'conf', 'c', 'cpp', 'h', 'hpp', 'lua', 'rb', 'rs', 'go', 'java', 'ts', 'tsx', 'jsx', 'toml', 'bat', 'ps1', 'sql', 'r', 'swift', 'kt', 'php', 'pl', 'diff', 'makefile']
  var VID = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv']
  var AUD = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']
  var PDF = ['pdf']

  var _blobUrl = null
  var _editorDirty = false
  var _openGeneration = 0
  var _previewAbort = null
  var _historyOpen = false
  function $ (id) { return document.getElementById(id) }
  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function csrf () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : (document.querySelector('input[name="csrf_token"]') || {}).value || '' }
  function toast (m, c) { if (window.showToast) window.showToast(m, c) }
  function haveKeys () { return typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys && OneGyCrypto.hasSessionKeys() }
  function extOf (item) { var e = item.extension || ''; e = String(e).replace(/^\./, '').toLowerCase(); if (e) return e; var m = /\.([a-z0-9]+)$/i.exec(item.name || ''); return m ? m[1].toLowerCase() : '' }
  function revoke () { if (_blobUrl) { try { URL.revokeObjectURL(_blobUrl) } catch (e) {} _blobUrl = null } }
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

  function open (item) {
    var modal = $('previewModal'); if (!modal || !item) return
    if (!modal.classList.contains('preview-visible')) {
      history.pushState(Object.assign({}, history.state || {}, { fxPreview: true }), '', window.location.href)
      _historyOpen = true
    }
    var opening = beginOpen()
    var body = $('previewBody'), nameEl = $('previewFileName'), dl = $('previewDownloadBtn'), resEl = $('previewResolution')
    _editorDirty = false
    revoke()
    if (body.__fxWheel) { body.removeEventListener('wheel', body.__fxWheel); body.__fxWheel = null }
    if (nameEl) nameEl.textContent = item.name || 'Preview'
    if (resEl) { resEl.textContent = ''; resEl.classList.remove('visible') }
    if (dl) { dl.removeAttribute('href'); dl.removeAttribute('download') }
    body.innerHTML = '<div class="preview-loading">' + (item.is_e2e ? 'DECRYPTING PREVIEW…' : 'LOADING PREVIEW…') + '</div>'
    modal.classList.add('preview-visible')
    document.documentElement.style.overflow = 'hidden'
    render(item, body, dl, resEl, opening.generation, opening.signal)
  }

  function close (fromHistory) {
    if (_historyOpen && !fromHistory) { history.back(); return }
    cancelOpen()
    var modal = $('previewModal'); if (!modal) return
    modal.classList.remove('preview-visible')
    document.documentElement.style.overflow = ''
    _editorDirty = false
    revoke()
    var body = $('previewBody'); if (body) { if (body.__fxWheel) { body.removeEventListener('wheel', body.__fxWheel); body.__fxWheel = null } body.innerHTML = '' }
    var badge = $('previewZoomBadge'); if (badge) { badge.textContent = ''; badge.classList.remove('visible') }
    _historyOpen = false
  }
  // Close on X / Esc / click-outside — but guard unsaved editor changes.
  function requestClose () {
    if (_editorDirty && !window.confirm('Discard unsaved changes to this file?')) return
    _editorDirty = false
    close()
  }
  function onPopState (e) {
    if (!_historyOpen) return
    e.stopImmediatePropagation()
    if (_editorDirty && !window.confirm('Discard unsaved changes to this file?')) {
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
    try {
      var bytes = await getBytes(item, signal)
      if (!isCurrent(generation)) return
      var blob = function (mime) { var b = new Blob([bytes], { type: mime }); _blobUrl = URL.createObjectURL(b); if (dl) { dl.href = _blobUrl; dl.download = item.name || 'file' } return _blobUrl }
      if (IMG.indexOf(ext) >= 0) {
        var mimeI = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'image/jpeg'
        var url = blob(mimeI)
        var img = new Image(); img.className = 'preview-image'; img.alt = item.name || ''
        img.onload = function () { if (!isCurrent(generation)) return; body.innerHTML = ''; body.appendChild(img); if (resEl) { resEl.textContent = img.naturalWidth + ' × ' + img.naturalHeight; resEl.classList.add('visible') } attachZoom(img, body, generation) }
        img.onerror = function () { if (isCurrent(generation)) body.innerHTML = '<div class="preview-error">COULD NOT DISPLAY IMAGE</div>' }
        img.src = url
      } else if (TXT.indexOf(ext) >= 0) {
        blob('text/plain')
        var decoded = decodeTextBytes(bytes)
        decoded.eol = detectEol(decoded.text)
        var text = decoded.text
        body.innerHTML = ''
        if ((bytes.byteLength || 0) > EDITOR_MAX) {
          var pre = document.createElement('pre'); pre.className = 'preview-text'; pre.textContent = text.slice(0, 50000)
          var note = document.createElement('div'); note.className = 'preview-ro-note'; note.textContent = 'FILE TOO LARGE TO EDIT — READ-ONLY'
          body.appendChild(note); body.appendChild(pre)
        } else {
          body.appendChild(buildEditor(text, ext, item, decoded, generation))
        }
      } else if (VID.indexOf(ext) >= 0) {
        var mimeV = { mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/quicktime', m4v: 'video/x-m4v', mkv: 'video/x-matroska' }[ext] || 'video/mp4'
        var v = document.createElement('video'); v.className = 'preview-video'; v.controls = true; v.autoplay = true; v.src = blob(mimeV)
        body.innerHTML = ''; body.appendChild(v)
      } else if (AUD.indexOf(ext) >= 0) {
        var mimeA = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' }[ext] || 'audio/mpeg'
        var wrap = document.createElement('div'); wrap.className = 'preview-audio-wrap'
        wrap.innerHTML = '<div class="preview-audio-ico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg></div>'
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
      if (isCurrent(generation) && (!e || e.name !== 'AbortError')) body.innerHTML = '<div class="preview-error">' + (String(e.message).indexOf('KEYS') >= 0 ? 'UNLOCK YOUR KEYS TO PREVIEW' : 'PREVIEW FAILED') + '</div>'
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
    window.addEventListener('mousemove', function (e) { if (!isCurrent(generation) || !dragging) return; tx = e.clientX - sx; ty = e.clientY - sy; apply() })
    window.addEventListener('mouseup', function () { if (isCurrent(generation) && dragging) { dragging = false; apply() } })
    img.addEventListener('dblclick', function (e) { if (!isCurrent(generation)) return; e.stopPropagation(); scale = 1; tx = 0; ty = 0; apply() })
  }

  // ---- Text editor ---------------------------------------------------------
  function buildEditor (text, ext, item, encInfo, generation) {
    var wrap = document.createElement('div'); wrap.className = 'preview-ed'
    wrap.innerHTML =
      '<div class="preview-ed-head"><span class="preview-ed-lang">' + esc((ext || 'txt').toUpperCase()) + '</span>' +
      '<span class="preview-ed-status" data-status></span>' +
      '<button class="preview-ed-save" data-save disabled><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>Save</button></div>' +
      '<div class="preview-ed-body"><div class="preview-ed-gutter" data-gutter></div><textarea class="preview-ed-ta" spellcheck="false" wrap="off"></textarea></div>'
    var ta = wrap.querySelector('.preview-ed-ta')
    var gutter = wrap.querySelector('[data-gutter]')
    var saveBtn = wrap.querySelector('[data-save]')
    var status = wrap.querySelector('[data-status]')
    ta.value = text
    var dirty = false
    var editRevision = 0
    var saving = false
    function updGutter () { var n = ta.value.split('\n').length; var s = ''; for (var i = 1; i <= n; i++) s += i + '\n'; gutter.textContent = s }
    function syncScroll () { gutter.scrollTop = ta.scrollTop }
    function mark () { if (!isCurrent(generation)) return; editRevision++; dirty = true; _editorDirty = true; if (!saving) saveBtn.disabled = false; status.textContent = 'Modified'; status.className = 'preview-ed-status is-mod' }
    ta.addEventListener('input', function () { updGutter(); mark() })
    ta.addEventListener('scroll', syncScroll)
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') { e.preventDefault(); var s = ta.selectionStart, en = ta.selectionEnd; ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en); ta.selectionStart = ta.selectionEnd = s + 2; mark() }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave() }
    })
    async function doSave () {
      if (!dirty || saving || !isCurrent(generation)) return
      saving = true
      var submittedText = ta.value
      var submittedRevision = editRevision
      saveBtn.disabled = true; status.textContent = 'Saving…'; status.className = 'preview-ed-status is-saving'
      try {
        var res = item.is_e2e ? await saveE2E(item, submittedText, ext, encInfo) : await savePlain(item, submittedText, encInfo)
        // The server returns {'error': ...} with a 4xx/5xx and NO success key on
        // every failure path, so `res.success === false` never fired and every
        // rejection rendered "Saved" — silently dropping the edit. Only an
        // explicit success counts; anything else keeps `dirty` set so the
        // unsaved-changes guard still protects the text in the textarea.
        if (!res || res.success !== true) throw new Error((res && res.error) || 'SAVE FAILED')
        if (!isCurrent(generation)) return
        if (editRevision === submittedRevision) {
          dirty = false; _editorDirty = false; status.textContent = 'Saved'; status.className = 'preview-ed-status is-saved'
        } else {
          dirty = true; _editorDirty = true; status.textContent = 'Modified'; status.className = 'preview-ed-status is-mod'; saveBtn.disabled = false
        }
        if (window.FxPreview && window.FxPreview._onSaved) window.FxPreview._onSaved(item)
      } catch (e) {
        if (!isCurrent(generation)) return
        status.textContent = 'Save failed'; status.className = 'preview-ed-status is-err'; saveBtn.disabled = false; toast('COULD NOT SAVE FILE: ' + String((e && e.message) || 'UNKNOWN ERROR').toUpperCase(), 'error')
      } finally {
        saving = false
      }
    }
    saveBtn.addEventListener('click', doSave)
    updGutter()
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
    if (!out || out.success !== true) return { success: false, error: (out && out.error) || 'SAVE FAILED — UNEXPECTED SERVER RESPONSE' }
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
      if (!mr.ok) return { success: false, error: 'COULD NOT CHECK SHARE STATUS (HTTP ' + mr.status + ') — NOT SAVING' }
      md = await mr.json()
    } catch (e) { return { success: false, error: 'COULD NOT CHECK SHARE STATUS — NOT SAVING' } }

    var needFileLink = !!(md && (md.has_file_link_key || (md.is_link_shared && !md.ancestor_share_token && !md.has_folder_link_key)))
    var needFolderLink = !!(md && (md.has_folder_link_key || md.ancestor_share_token))
    var fileLinkKey = null
    var folderLinkKey = null
    if (needFileLink) {
      try {
        var fls = await OneGyCrypto.deriveLinkSecret(masterKey, 'file', item.id)
        fileLinkKey = fls && fls.linkKey
      } catch (e) { fileLinkKey = null }
      if (!fileLinkKey) return { success: false, error: 'COULD NOT DERIVE THE SHARE-LINK KEY — NOT SAVING' }
    }
    if (needFolderLink) {
      try {
        var gls = await OneGyCrypto.deriveLinkSecret(masterKey, 'folder', md.ancestor_share_token)
        folderLinkKey = gls && gls.linkKey
      } catch (e) { folderLinkKey = null }
      if (!folderLinkKey) return { success: false, error: 'COULD NOT DERIVE THE FOLDER SHARE-LINK KEY — NOT SAVING' }
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
      if (!name) return { success: false, error: 'COULD NOT RECOVER THE ENCRYPTED FILENAME — NOT SAVING' }
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
      } catch (e) { return { success: false, error: 'COULD NOT RE-WRAP THE SHARE-LINK KEY — NOT SAVING' } }
    }
    if (folderLinkKey) {
      try {
        var fw = await OneGyCrypto.wrapFileKeyForLink(newKey, folderLinkKey)
        fd.append('folder_link_encrypted_file_key', fw.encryptedFileKey)
        fd.append('folder_link_file_key_nonce', fw.nonce)
      } catch (e) { return { success: false, error: 'COULD NOT RE-WRAP THE FOLDER SHARE-LINK KEY — NOT SAVING' } }
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
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal.classList.contains('preview-visible')) requestClose() })
  }
  window.addEventListener('popstate', onPopState)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire()

  window.FxPreview = { open: open, close: close, _onSaved: null }
})()
