/* ============================================================================
   FROST BROWSE — shared-folder browse SPA (/f/<share_token>)

   Replaces the ~4,000 lines of inline JS that lived in the legacy
   browse_folder.html. Everything here talks to the SAME already-tested server
   endpoints the legacy page used, so no backend change was needed:

     GET  /f/<t>/browse-data?folder=<id>     listing + tree + breadcrumbs
     GET  /f/<t>/search?q=                   recursive search
     GET  /f/<t>/file/<id>/<name>            server-side-encrypted download
     GET  /f/<t>/folder/<id>/<name>.zip      subfolder ZIP
     GET  /f/<t>/download-all                whole-share ZIP
     POST /f/<t>/download-selected           multi-select ZIP (form, csrf-exempt)
     POST /f/<t>/track-folder-download       download counter for client-side ZIPs
     GET  /f/<t>/thumb/<id> · /e2e-thumb/<id>
     GET  /f/<id>/key-info · /f/<id>/encrypted   E2EE material + ciphertext

   E2EE MODEL (do not "simplify" this):
   The link secret lives ONLY in the URL fragment — `#passphrase=<b64>` (new)
   or a bare `#<b64>` (legacy links). It is never sent to the server. File keys
   and folder-name keys are unwrapped with the link secret when present, and
   otherwise with the visitor's session master key (owner viewing their own
   share). If neither works the item stays under its server-side placeholder
   name, which is the correct zero-knowledge failure mode.
   ========================================================================== */
;(function () {
  'use strict'

  var root = document.getElementById('bwShell')
  if (!root) return

  var TOKEN = root.dataset.token

  // ── Link secret from the fragment (never leaves the browser) ──────────────
  var _frag = window.location.hash.substring(1)
  var LINK_SECRET = _frag.indexOf('passphrase=') === 0 ? _frag.substring('passphrase='.length) : _frag
  var hasLink = function () { return !!LINK_SECRET && LINK_SECRET.length >= 10 }
  var hasKeys = function () { return typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys() }

  // ── State ────────────────────────────────────────────────────────────────
  var S = {
    folderId: null,
    rootId: null,
    rootName: '',
    files: [],
    folders: [],
    tree: [],
    crumbs: [],
    sel: Object.create(null),
    view: 'grid',
    sort: 'name',
    open: Object.create(null),   // expanded tree nodes
    totalFiles: 0,
    e2e: false                   // share holds E2EE names: search must stay client-side
  }
  var requestEpoch = 0
  function nextRequestEpoch () { requestEpoch += 1; return requestEpoch }
  function hasRequestAuthority (epoch) { return epoch === requestEpoch }

  var el = function (id) { return document.getElementById(id) }
  var toast = function (m, c) { if (typeof showToast === 'function') showToast(m, c) }
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function fmtBytes (n) {
    n = Number(n) || 0
    if (n < 1024) return n + ' B'
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1
    do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i]
  }

  // ── Persisted prefs (shared with the Files page where sensible) ──────────
  try {
    var v = localStorage.getItem('onegy_bw_view'); if (v === 'grid' || v === 'list') S.view = v
    var so = localStorage.getItem('onegy_bw_sort'); if (so) S.sort = so
  } catch (e) {}

  // ═══ ICONS ═══════════════════════════════════════════════════════════════
  // Same glyph language as the Files page: two-tone folder, kind-tinted page.
  var ICO = {
    folder: '<svg class="bw-fold" viewBox="0 0 24 24" aria-hidden="true"><path class="bw-fold-back" d="M2.5 6.2A2.2 2.2 0 0 1 4.7 4h4.1c.55 0 1.08.2 1.48.58L11.8 6h7.5a2.2 2.2 0 0 1 2.2 2.2v9.6a2.2 2.2 0 0 1-2.2 2.2H4.7a2.2 2.2 0 0 1-2.2-2.2z"/><path class="bw-fold-front" d="M2.5 9.4A1.4 1.4 0 0 1 3.9 8h16.2a1.4 1.4 0 0 1 1.4 1.4v8.4a2.2 2.2 0 0 1-2.2 2.2H4.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>',
    folderLine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z"/></svg>',
    page: '<svg class="bw-page" viewBox="0 0 40 48" aria-hidden="true"><path class="bw-page-body" d="M7 1.5h18.5L37.5 13.5V42A4.5 4.5 0 0 1 33 46.5H7A4.5 4.5 0 0 1 2.5 42V6A4.5 4.5 0 0 1 7 1.5z"/><path class="bw-page-fold" d="M25.5 1.5v8.5a3.5 3.5 0 0 0 3.5 3.5h8.5z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>'
  }
  // File kinds drive the glyph tint (data-kind -> --k in browse.css)
  var KIND = {}
  ;[['image', 'jpg jpeg png gif webp bmp svg heic heif tif tiff avif ico'], ['pdf', 'pdf'],
    ['archive', 'zip rar 7z tar gz tgz bz2 xz zst iso dmg'], ['sheet', 'csv tsv xls xlsx ods numbers'],
    ['doc', 'doc docx odt rtf txt md pages ppt pptx odp key'],
    ['code', 'js ts tsx jsx py go rs c cpp h hpp java rb php sh bash html css scss json xml yaml yml toml sql lua swift kt ini cfg conf env bat ps1 r pl diff makefile log'],
    ['media', 'mp3 wav ogg m4a aac flac opus wma mp4 webm mov mkv avi wmv flv m4v 3gp']
  ].forEach(function (g) { g[1].split(' ').forEach(function (e) { KIND[e] = g[0] }) })
  var TEXT_KIND = { doc: 1, code: 1 }
  function extOf (name) {
    var n = String(name || ''), dot = n.lastIndexOf('.')
    return dot > 0 ? n.slice(dot + 1).toLowerCase() : ''
  }
  function docIcon (name) {
    var ext = extOf(name)
    return '<span class="bw-doc" data-kind="' + (KIND[ext] || 'file') + '">' + ICO.page +
      (ext ? '<span class="bw-doc-ext">' + esc(ext.slice(0, 4).toUpperCase()) + '</span>' : '') + '</span>'
  }

  // ═══ E2EE HELPERS ════════════════════════════════════════════════════════

  // Unwrap a file key: link secret first (any visitor), then the owner's
  // session master key. Returns null when neither path is available.
  async function fileKeyFor (o) {
    if (typeof OneGyCrypto === 'undefined') return null
    if (hasLink()) {
      var wraps = [
        [o.link_encrypted_file_key, o.link_file_key_nonce],
        [o.folder_link_encrypted_file_key, o.folder_link_file_key_nonce]
      ]
      for (var wi = 0; wi < wraps.length; wi++) {
        if (!wraps[wi][0] || !wraps[wi][1]) continue
        try {
          return await OneGyCrypto.unwrapFileKeyFromLink(wraps[wi][0], wraps[wi][1], LINK_SECRET)
        } catch (e) { /* try the other wrap, then master key */ }
      }
    }
    if (o.encrypted_file_key && o.file_key_nonce && hasKeys()) {
      try {
        var mk = await OneGyCrypto.getMasterKeyFromSession()
        if (mk) return await OneGyCrypto.unwrapFileKeyWithMasterKey(o.encrypted_file_key, o.file_key_nonce, mk)
      } catch (e) {}
    }
    return null
  }

  async function folderNameKeyFor (o) {
    if (typeof OneGyCrypto === 'undefined') return null
    if (o.link_encrypted_name_key && o.link_name_key_nonce && hasLink()) {
      try {
        return await OneGyCrypto.unwrapFolderNameKeyFromLink(o.link_encrypted_name_key, o.link_name_key_nonce, LINK_SECRET)
      } catch (e) {}
    }
    if (o.encrypted_name_key && o.name_key_nonce && hasKeys()) {
      try {
        var mk = await OneGyCrypto.getMasterKeyFromSession()
        if (mk) return await OneGyCrypto.unwrapFolderNameKey(o.encrypted_name_key, o.name_key_nonce, mk)
      } catch (e) {}
    }
    return null
  }

  // Decrypt display names in place. Failures are silent by design: the item
  // keeps its server-side placeholder rather than blocking the whole listing.
  async function decryptFileNames (files, epoch) {
    if (typeof OneGyCrypto === 'undefined') return
    await Promise.all(files.map(async function (f) {
      if (!f.is_e2e || !f.encrypted_name || !f.name_nonce) return
      try {
        var k = await fileKeyFor(f)
        if (epoch != null && !hasRequestAuthority(epoch)) return
        if (!k) return
        var n = await OneGyCrypto.decryptFileName(f.encrypted_name, f.name_nonce, k)
        if (epoch != null && !hasRequestAuthority(epoch)) return
        if (n) { f.name = n; f._dec = true; f.extension = (n.split('.').pop() || '').toLowerCase() }
      } catch (e) {}
    }))
  }

  async function decryptFolderNames (folders, epoch) {
    if (typeof OneGyCrypto === 'undefined') return
    await Promise.all(folders.map(async function (fd) {
      // Breadcrumb entries carry the ciphertext but no is_e2e flag.
      if (!fd.encrypted_name || !fd.name_nonce) return
      try {
        var k = await folderNameKeyFor(fd)
        if (epoch != null && !hasRequestAuthority(epoch)) return
        if (!k) return
        var n = await OneGyCrypto.decryptFolderName(fd.encrypted_name, fd.name_nonce, k)
        if (epoch != null && !hasRequestAuthority(epoch)) return
        if (n) { fd.name = n; fd._dec = true }
      } catch (e) {}
    }))
  }

  // ═══ DATA ════════════════════════════════════════════════════════════════
  async function load (folderId, opts) {
    opts = opts || {}
    var epoch = opts.epoch == null ? nextRequestEpoch() : opts.epoch
    if (!hasRequestAuthority(epoch)) return
    searchIndex = null
    if (!opts.silent) renderSkeleton()
    var url = '/f/' + encodeURIComponent(TOKEN) + '/browse-data' + (folderId ? '?folder=' + encodeURIComponent(folderId) : '')
    var d
    try {
      var r = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (!hasRequestAuthority(epoch)) return
      if (!r.ok) throw new Error('HTTP ' + r.status)
      d = await r.json()
      if (!hasRequestAuthority(epoch)) return
      if (d.error) throw new Error(d.error)
    } catch (e) {
      if (!hasRequestAuthority(epoch)) return
      renderError(e.message || 'FAILED TO LOAD FOLDER')
      return
    }

    var files = d.files || []
    var folders = d.folders || []
    var tree = d.sidebar_folders || []
    var crumbs = d.breadcrumbs || []

    // Root name may itself be encrypted.
    var rootName = d.root_folder_name || 'SHARED'
    if (d.root_folder_encrypted) {
      var rootObj = { is_e2e: true }
      for (var k in d.root_folder_encrypted) rootObj[k] = d.root_folder_encrypted[k]
      await decryptFolderNames([rootObj], epoch)
      if (!hasRequestAuthority(epoch)) return
      if (rootObj.name) rootName = rootObj.name
    }

    await Promise.all([
      decryptFileNames(files, epoch),
      decryptFolderNames(folders, epoch),
      decryptFolderNames(tree, epoch),
      decryptFolderNames(crumbs, epoch)
    ])
    if (!hasRequestAuthority(epoch)) return

    S.folderId = d.current_folder_id
    S.rootId = d.root_folder_id
    S.files = files
    S.folders = folders
    S.tree = tree
    S.crumbs = crumbs
    S.totalFiles = d.total_file_count || 0
    S.sel = Object.create(null)
    // Navigating away from search results leaves search mode and its query.
    if (S.searching && !opts.noPush) el('bwSearch').value = ''
    S.searching = false
    S.rootName = rootName
    S.e2e = !!(d.is_e2e_folder || d.root_folder_encrypted || tree.some(function (f) { return f.is_e2e }))
    el('bwDownloadAll').disabled = false

    render()
    hydrateThumbs()

    if (opts.replace) history.replaceState({ bw: true, folderId: S.folderId }, '')
    else if (!opts.noPush) {
      var q = (folderId && folderId !== S.rootId) ? ('?folder=' + folderId) : ''
      history.pushState({ bw: true, folderId: S.folderId },
        '', window.location.pathname + q + window.location.hash)
    }
  }

  // ═══ RENDER ══════════════════════════════════════════════════════════════
  function renderSkeleton () {
    el('bwView').innerHTML = '<div class="bw-skel" aria-hidden="true">' +
      new Array(9).join('<div class="bw-skel-card"></div>') + '</div>'
  }
  function emptyState (icon, title, text) {
    return '<div class="rd-empty bw-empty"><span class="rd-empty-icon">' + icon + '</span>' +
      '<h3 class="rd-empty-title">' + esc(title) + '</h3><p class="rd-empty-text">' + esc(text) + '</p></div>'
  }
  function renderError (msg) {
    el('bwView').innerHTML = emptyState(ICO.alert, 'This share is unavailable',
      'It may have expired or been revoked. (' + msg + ')')
    el('bwTree').innerHTML = ''
    el('bwStatFiles').textContent = el('bwStatHere').textContent = '\u2013'
    el('bwDownloadAll').disabled = true
  }

  function render () {
    renderCrumbs()
    renderTree()
    renderItems()
    renderStats()
    syncSelbar()
  }

  function renderStats () {
    el('bwStatFiles').textContent = S.totalFiles
    el('bwStatHere').textContent = (S.folders.length + S.files.length)
    el('bwE2e').hidden = !S.e2e
  }

  function renderCrumbs () {
    var out = ['<button type="button" class="bw-bcrumb-item' + (S.folderId === S.rootId ? ' is-current' : '') +
      '" data-folder-id="' + S.rootId + '" title="' + esc(S.rootName) + '">' + esc(S.rootName) + '</button>']
    S.crumbs.forEach(function (c, i) {
      var last = i === S.crumbs.length - 1
      out.push('<span class="bw-bcrumb-sep">' + ICO.chev + '</span>')
      out.push('<button type="button" class="bw-bcrumb-item' + (last ? ' is-current' : '') +
        '" data-folder-id="' + c.id + '" title="' + esc(c.name) + '">' + esc(c.name) + '</button>')
    })
    el('bwBcrumb').innerHTML = out.join('')
  }

  function renderTree () {
    var kids = Object.create(null)
    S.tree.forEach(function (f) { (kids[f.parent_id] = kids[f.parent_id] || []).push(f) })

    function row (f, depth, hasKids, isOpen, inner) {
      var twist = hasKids
        ? '<span class="bw-tree-twist" data-twist="' + f.id + '">' + ICO.chev + '</span>'
        : '<span class="bw-tree-twist"></span>'
      return '<div class="bw-tree-row' + (isOpen ? ' is-open' : '') + '" style="--d:' + depth + '">' +
        '<button type="button" class="bw-tree-link folder-tree-link' + (String(f.id) === String(S.folderId) ? ' is-active' : '') +
          '" data-folder-id="' + f.id + '" title="' + esc(f.name) + '">' +
          twist + '<span class="bw-tree-ico">' + ICO.folderLine + '</span><span class="bw-tree-name">' + esc(f.name) + '</span>' +
        '</button>' + inner +
      '</div>'
    }
    function branch (parentId, depth) {
      var list = kids[parentId] || []
      if (!list.length) return ''
      list.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)) })
      return list.map(function (f) {
        var hasKids = !!(kids[f.id] && kids[f.id].length)
        // An explicit toggle wins; untouched branches auto-open down to the
        // current folder (forcing that open made ancestors uncollapsible).
        var isOpen = S.open[f.id] != null ? S.open[f.id] : isAncestorOf(f.id, S.folderId, kids)
        return row(f, depth, hasKids, isOpen, hasKids && isOpen ? '<div class="bw-tree-kids">' + branch(f.id, depth + 1) + '</div>' : '')
      }).join('')
    }

    el('bwTree').innerHTML = row({ id: S.rootId, name: S.rootName }, 0, false, true,
      '<div class="bw-tree-kids">' + branch(S.rootId, 1) + '</div>')
  }

  function isAncestorOf (candidateId, folderId, kids) {
    // Auto-expand the path down to the folder currently being viewed.
    var stack = (kids[candidateId] || []).slice()
    while (stack.length) {
      var n = stack.pop()
      if (n.id === folderId) return true
      ;(kids[n.id] || []).forEach(function (c) { stack.push(c) })
    }
    return false
  }

  function sortItems (arr, isFile) {
    var s = S.sort
    var by = {
      name: function (a, b) { return String(a.name).localeCompare(String(b.name), undefined, { numeric: true }) },
      'name-desc': function (a, b) { return String(b.name).localeCompare(String(a.name), undefined, { numeric: true }) },
      size: function (a, b) { return (b.size || 0) - (a.size || 0) },
      'size-asc': function (a, b) { return (a.size || 0) - (b.size || 0) },
      date: function (a, b) { return String(b[isFile ? 'upload_date_iso' : 'updated_at_iso'] || '').localeCompare(String(a[isFile ? 'upload_date_iso' : 'updated_at_iso'] || '')) },
      'date-asc': function (a, b) { return String(a[isFile ? 'upload_date_iso' : 'updated_at_iso'] || '').localeCompare(String(b[isFile ? 'upload_date_iso' : 'updated_at_iso'] || '')) }
    }
    return arr.slice().sort(by[s] || by.name)
  }

  function check (kind, id) {
    return '<input type="checkbox" class="bw-check ' + kind + '-checkbox" data-' + kind + '-id="' + esc(id) + '" aria-label="Select ' + kind + '">'
  }
  function act (cls, data, title, icon) {
    return '<button type="button" class="bw-act ' + cls + '" ' + data + ' title="' + title + '" aria-label="' + title + '">' + icon + '</button>'
  }
  var E2E_BADGE = '<span class="bw-badge bw-badge-e2e" title="End-to-end encrypted">' + ICO.lock + '</span>'

  function folderCard (f) {
    var badges = f.is_e2e ? E2E_BADGE : (f.has_mixed_e2e ? '<span class="bw-badge bw-badge-mixed" title="Some files are not end-to-end encrypted">Mixed</span>' : '')
    var count = (f.file_count || 0) + (f.file_count === 1 ? ' file' : ' files')
    return '<div class="bw-item is-folder folder-row folder-tile" data-folder-id="' + f.id + '" data-folder-name="' + esc(f.name) + '"' +
        (f.is_e2e ? ' data-is-e2e-folder="true"' : '') + '>' +
      check('folder', f.id) +
      '<span class="bw-item-thumb">' + ICO.folder + '</span>' +
      '<span class="bw-item-name folder-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
      '<span class="bw-item-meta">' + badges + '</span>' +
      '<span class="bw-item-size">' + count + (f.size_formatted ? ' \u00b7 ' + esc(f.size_formatted) : '') + '</span>' +
      '<span class="bw-item-date">' + esc(f.updated_at || '') + '</span>' +
      '<span class="bw-item-actions">' +
        (f.download_url ? act('action-btn action-download', 'data-dl-folder="' + f.id + '"', 'Download ZIP', ICO.dl) : '') +
        act('copy-link-btn', 'data-copy-folder="' + f.id + '"', 'Copy link', ICO.link) +
      '</span>' +
    '</div>'
  }

  function fileCard (f) {
    var kind = KIND[extOf(f.name)] || 'file'
    return '<div class="bw-item is-file file-row file-tile" data-file-id="' + esc(f.id) + '" data-file-name="' + esc(f.name) + '"' +
        ' data-e2e="' + (f.is_e2e ? 'true' : 'false') + '">' +
      check('file', f.id) +
      '<span class="bw-item-thumb" data-thumb-for="' + esc(f.id) + '"' + (TEXT_KIND[kind] ? ' data-text' : '') + '>' + docIcon(f.name) + '</span>' +
      '<span class="bw-item-name file-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
      '<span class="bw-item-meta">' + (f.is_e2e ? E2E_BADGE : '') + '</span>' +
      '<span class="bw-item-size">' + esc(f.size_formatted || fmtBytes(f.size)) + '</span>' +
      '<span class="bw-item-date">' + esc(f.upload_date || '') + '</span>' +
      '<span class="bw-item-actions">' +
        act('action-btn action-download' + (f.is_e2e ? ' e2e-download-btn' : ''), 'data-dl-file="' + esc(f.id) + '" data-file-id="' + esc(f.id) + '"', 'Download', ICO.dl) +
        act('copy-link-btn', 'data-copy-file="' + esc(f.id) + '"', 'Copy link', ICO.link) +
      '</span>' +
    '</div>'
  }

  function section (label, count, items, cls) {
    return '<section class="bw-sec"><h2 class="bw-sec-head">' + label + ' <span class="bw-sec-count">' + count + '</span></h2>' +
      '<div class="bw-items' + (cls ? ' ' + cls : '') + '">' + items + '</div></section>'
  }
  // Column labels for the list view (one sticky head above every section)
  var LIST_HEAD = '<div class="bw-list-head" aria-hidden="true"><span></span><span>Name</span><span></span><span class="is-num">Size</span><span>Modified</span><span></span></div>'

  function renderItems () {
    var view = el('bwView')
    view.dataset.view = S.view

    if (!S.folders.length && !S.files.length) {
      view.innerHTML = emptyState(ICO.folderLine, 'This folder is empty', 'Nothing has been shared here yet.')
      return
    }

    var html = S.view === 'list' ? LIST_HEAD : ''
    // Zero-knowledge failure mode: without the link secret names stay placeholders
    if (S.files.concat(S.folders).some(function (o) { return o.encrypted_name && !o._dec })) {
      html += '<div class="rd-callout is-warn bw-locked">' + ICO.lock + '<div>Some names could not be decrypted. ' +
        'Open the full share link, including the part after #, to see them.</div></div>'
    }
    if (S.folders.length) html += section('Folders', S.folders.length, sortItems(S.folders, false).map(folderCard).join(''), 'has-folders')
    if (S.files.length) html += section('Files', S.files.length, sortItems(S.files, true).map(fileCard).join(''))
    view.innerHTML = html
  }

  // ── Thumbnails: lazy, plain via server URL, E2EE decrypted in-browser ─────
  var thumbObs = null
  var thumbQueue = []
  var thumbQueued = new Set()
  var thumbInFlight = 0
  var THUMB_CONCURRENCY = 32
  // Decrypted E2EE thumbnails, by file id: re-renders (sort/view) reuse them and
  // a replaced or evicted object URL is revoked.
  var e2eThumbCache = new Map()
  var E2E_THUMB_CACHE_MAX = 500
  function rememberE2eThumb (id, url) {
    var prev = e2eThumbCache.get(id)
    if (prev && prev !== url) { try { URL.revokeObjectURL(prev) } catch (e) {} }
    e2eThumbCache.delete(id)
    e2eThumbCache.set(id, url)
    while (e2eThumbCache.size > E2E_THUMB_CACHE_MAX) {
      var oldest = e2eThumbCache.keys().next().value
      try { URL.revokeObjectURL(e2eThumbCache.get(oldest)) } catch (e) {}
      e2eThumbCache.delete(oldest)
    }
  }
  function paintThumb (slot, url, revoke) {
    return new Promise(function (resolve) {
      var im = new Image(); im.alt = ''
      im.onload = function () { slot.innerHTML = ''; slot.appendChild(im); if (revoke) URL.revokeObjectURL(url); resolve() }
      im.onerror = function () { if (revoke) URL.revokeObjectURL(url); resolve() }
      im.src = url
    })
  }
  function hydrateThumbs () {
    if (thumbObs) { try { thumbObs.disconnect() } catch (e) {} thumbObs = null }
    thumbQueue = []
    thumbQueued = new Set()
    var slots = document.querySelectorAll('[data-thumb-for]')
    if (!slots.length) return
    var scroller = el('bwView')
    function enqueue (slot) {
      var id = slot.getAttribute('data-thumb-for')
      if (!id || thumbQueued.has(id)) return
      thumbQueued.add(id)
      thumbQueue.push(slot)
      pump()
    }
    function pump () {
      while (thumbInFlight < THUMB_CONCURRENCY && thumbQueue.length) {
        var slot = thumbQueue.shift()
        thumbInFlight++
        Promise.resolve(load(slot)).then(function () {}, function () {}).then(function () {
          thumbInFlight--
          pump()
        })
      }
    }
    var thumbRetries = new Map()
    function scheduleRetry (slot) {
      var id = slot.getAttribute('data-thumb-for')
      var n = (thumbRetries.get(id) || 0) + 1
      if (n > 8) return
      thumbRetries.set(id, n)
      setTimeout(function () {
        if (!id || !slot.isConnected) return
        thumbQueued.delete(id)
        enqueue(slot)
      }, Math.min(8000, 700 * n))
    }
    function canThumb (f) {
      if (!f) return false
      if (f.has_thumbnail) return true
      if (f.is_e2e) return false
      if (f.thumbnailable) return true
      var ext = String(f.extension || '').replace(/^\./, '').toLowerCase()
      var text = { txt:1, md:1, log:1, csv:1, json:1, xml:1, yaml:1, yml:1, py:1, js:1, html:1, css:1, sh:1, bat:1, ini:1, cfg:1, conf:1, c:1, cpp:1, h:1, hpp:1, lua:1, rb:1, rs:1, go:1, java:1, ts:1, tsx:1, jsx:1, toml:1, ps1:1, sql:1, r:1, swift:1, kt:1, php:1, pl:1, diff:1, makefile:1, env:1 }
      var video = { mp4:1, webm:1, ogg:1, mov:1, mkv:1, avi:1, wmv:1, flv:1, m4v:1, '3gp':1 }
      var image = { jpg:1, jpeg:1, png:1, gif:1, bmp:1, webp:1 }
      var base = String(f.name || '').split(/[/\\]/).pop().toLowerCase()
      return !!(image[ext] || text[ext] || video[ext] || base === '.env' || base.indexOf('.env.') === 0)
    }
    function load (slot) {
      var id = slot.getAttribute('data-thumb-for')
      var f = S.files.filter(function (x) { return String(x.id) === String(id) })[0]
      if (!f) return
      if (!f.is_e2e) {
        if (!canThumb(f)) return
        return (async function () {
          try {
            var tr = await fetch('/f/' + encodeURIComponent(TOKEN) + '/thumb/' + encodeURIComponent(f.id))
            // 404 is almost always permanent: one retry still picks up the
            // server's on-demand fill, more only for 429 / transient errors.
            if (!tr.ok) { if (tr.status !== 404 || !thumbRetries.has(id)) scheduleRetry(slot); return }
            await paintThumb(slot, URL.createObjectURL(await tr.blob()), true)
          } catch (e) { scheduleRetry(slot) }
        })()
      }
      if (!f.enc_thumb_nonce || typeof OneGyCrypto === 'undefined') return
      return (async function () {
        try {
          var url = e2eThumbCache.get(id)
          if (!url) {
            var key = await fileKeyFor(f)
            if (!key) return
            var r = await fetch('/f/' + encodeURIComponent(TOKEN) + '/e2e-thumb/' + encodeURIComponent(f.id))
            if (r.status === 429) { scheduleRetry(slot); return }
            if (!r.ok) return
            var buf = await r.arrayBuffer()
            if (!buf || buf.byteLength < 16) return
            var plain = await OneGyCrypto.decryptThumbnail(buf, f.enc_thumb_nonce, key)
            url = URL.createObjectURL(new Blob([plain]))
            rememberE2eThumb(id, url)
          }
          await paintThumb(slot, url, false)
        } catch (e) {}
      })()
    }
    if (!('IntersectionObserver' in window)) {
      slots.forEach(enqueue)
      return
    }
    thumbObs = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (!en.isIntersecting) return
        thumbObs.unobserve(en.target)
        enqueue(en.target)
      })
    }, { root: scroller || null, rootMargin: '280px' })
    slots.forEach(function (n) { thumbObs.observe(n) })
  }

  // ═══ DOWNLOADS ═══════════════════════════════════════════════════════════
  function saveBlob (buf, name) {
    var url = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }))
    var a = document.createElement('a')
    a.href = url; a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
  }

  var progHideTimer = null
  var prog = {
    open: function (name) {
      // A previous download's delayed hide must not close this one's panel.
      clearTimeout(progHideTimer)
      el('bwProgName').textContent = name
      el('bwProgFill').className = 'bw-prog-fill'
      el('bwProgFill').style.width = '0%'
      el('bwProgStatus').textContent = 'Starting…'
      el('bwProg').classList.add('is-open')
    },
    set: function (pct, text) {
      el('bwProgFill').style.width = Math.max(0, Math.min(100, Math.round(pct))) + '%'
      if (text) el('bwProgStatus').textContent = text
    },
    done: function () {
      el('bwProgFill').classList.add('is-done')
      el('bwProgFill').style.width = '100%'
      el('bwProgStatus').textContent = 'Complete'
      progHideTimer = setTimeout(function () { el('bwProg').classList.remove('is-open') }, 1800)
    },
    fail: function (m) {
      el('bwProgFill').classList.add('is-error')
      el('bwProgFill').style.width = '100%'
      el('bwProgStatus').textContent = m || 'Failed'
    },
    close: function () { el('bwProg').classList.remove('is-open') }
  }

  function xhrArrayBuffer (url, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest()
      xhr.open('GET', url, true)
      xhr.responseType = 'arraybuffer'
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
      xhr.onprogress = function (e) {
        if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100, e.loaded, e.total)
      }
      xhr.onload = function () { xhr.status === 200 ? resolve(xhr.response) : reject(new Error('HTTP ' + xhr.status)) }
      xhr.onerror = function () { reject(new Error('NETWORK ERROR')) }
      xhr.send()
    })
  }

  async function downloadFile (f) {
    if (!f.is_e2e) {
      // Server decrypts; a plain navigation keeps the download-count bookkeeping
      // and streaming behaviour identical to the legacy page.
      window.location.href = f.download_url
      return
    }
    if (typeof OneGyCrypto === 'undefined') { toast('CRYPTO UNAVAILABLE', 'error'); return }
    prog.open(f.name)
    try {
      prog.set(0, 'Unwrapping key…')
      var key = await fileKeyFor(f)
      if (!key) {
        prog.fail('No key for this file')
        toast('NO DECRYPTION KEY. THE SHARE LINK MAY BE INCOMPLETE', 'error')
        return
      }
      var buf = await xhrArrayBuffer('/f/' + encodeURIComponent(f.id) + '/encrypted', function (pct, l, t) {
        prog.set(pct * 0.6, 'Downloading ' + fmtBytes(l) + ' / ' + fmtBytes(t))
      })
      prog.set(60, 'Decrypting…')
      var plain = await OneGyCrypto.decryptFileData(buf, key, function (p) { prog.set(60 + p * 0.4, 'Decrypting ' + p + '%') })
      saveBlob(plain, f.name)
      prog.done()
    } catch (e) {
      console.error('[BROWSE] download failed', e)
      prog.fail(e.message || 'Failed')
      toast('DOWNLOAD FAILED', 'error')
    }
  }

  function shareLinkFor (kind, id) {
    var base = window.location.origin
    var url
    if (kind === 'folder') url = base + '/f/' + TOKEN + '?folder=' + id
    else {
      var f = S.files.filter(function (x) { return String(x.id) === String(id) })[0]
      if (f && !f.is_e2e) return base + f.download_url
      url = base + '/f/' + id
    }
    if (hasLink()) url += '#passphrase=' + LINK_SECRET
    return url
  }

  async function copy (text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text)
      else {
        var ta = document.createElement('textarea')
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove()
      }
      toast('LINK COPIED', 'success')
    } catch (e) { toast('FAILED TO COPY LINK', 'error') }
  }

  // ═══ SELECTION ═══════════════════════════════════════════════════════════
  function selCount () { return Object.keys(S.sel).length }
  function syncSelbar () {
    var n = selCount()
    el('bwSelCount').textContent = n
    el('bwSelbar').classList.toggle('is-open', n > 0)
  }
  function toggleSel (kind, id, on) {
    var k = kind + ':' + id
    if (on) S.sel[k] = true; else delete S.sel[k]
    var sel = kind === 'file'
      ? document.querySelector('.bw-item[data-file-id="' + CSS.escape(String(id)) + '"]')
      : document.querySelector('.bw-item[data-folder-id="' + CSS.escape(String(id)) + '"]')
    if (sel) sel.classList.toggle('is-selected', !!on)
    syncSelbar()
  }

  var _CRC_TABLE = (function () {
    var t = new Uint32Array(256)
    for (var n = 0; n < 256; n++) {
      var c = n
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      t[n] = c >>> 0
    }
    return t
  })()
  function crc32 (u8) {
    var c = 0xFFFFFFFF
    for (var i = 0; i < u8.length; i++) c = _CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }
  function u16 (n) { return new Uint8Array([n & 255, (n >>> 8) & 255]) }
  function u32 (n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]) }
  function concatBytes (parts) {
    var len = 0, i
    for (i = 0; i < parts.length; i++) len += parts[i].length
    var out = new Uint8Array(len), o = 0
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length }
    return out
  }
  var ZIP32_MAX = 0xFFFFFFFF
  function uniqueZipName (name, used) {
    var candidate = String(name || 'unnamed')
    var key = candidate.toLowerCase()
    if (!used[key]) { used[key] = true; return candidate }
    var slash = candidate.lastIndexOf('/')
    var dir = slash >= 0 ? candidate.slice(0, slash + 1) : ''
    var base = slash >= 0 ? candidate.slice(slash + 1) : candidate
    var stem, dot, ext
    if (!base || (base.charAt(0) === '.' && base.indexOf('.', 1) < 0)) {
      stem = base; dot = ''; ext = ''
    } else {
      var d = base.indexOf('.')
      if (d > 0) { stem = base.slice(0, d); dot = '.'; ext = base.slice(d + 1) }
      else { stem = base; dot = ''; ext = '' }
    }
    for (var n = 1; n <= 100000; n++) {
      var next = dir + stem + ' (' + n + ')' + dot + ext
      key = next.toLowerCase()
      if (!used[key]) { used[key] = true; return next }
    }
    next = dir + stem + ' (' + Date.now() + ')' + dot + ext
    used[next.toLowerCase()] = true
    return next
  }
  function storeZip (entries) {
    var locals = [], centrals = [], offset = 0
    var enc = new TextEncoder()
    // ZIP32 stores the entry count in 16 bits; more would silently wrap.
    if (entries.length > 0xFFFF) throw new Error('TOO MANY FILES FOR ONE ARCHIVE')
    for (var i = 0; i < entries.length; i++) {
      var name = enc.encode(String(entries[i].name || 'file').replace(/\\/g, '/'))
      var data = entries[i].data instanceof Uint8Array ? entries[i].data : new Uint8Array(entries[i].data)
      if (data.length > ZIP32_MAX || offset > ZIP32_MAX) throw new Error('ARCHIVE TOO LARGE')
      var crc = crc32(data)
      var local = concatBytes([
        new Uint8Array([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name
      ])
      if (offset + local.length + data.length > ZIP32_MAX) throw new Error('ARCHIVE TOO LARGE')
      centrals.push(concatBytes([
        new Uint8Array([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset), name
      ]))
      locals.push(local, data)
      offset += local.length + data.length
    }
    var cd = concatBytes(centrals)
    if (offset > ZIP32_MAX || cd.length > ZIP32_MAX) throw new Error('ARCHIVE TOO LARGE')
    return concatBytes(locals.concat([
      cd,
      concatBytes([
        new Uint8Array([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0),
        u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)
      ])
    ]))
  }
  async function resolveZipPath (file, folderNames) {
    var parts = String(file.name == null ? '' : file.name).split('/')
    var out = []
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i]
      if (i === parts.length - 1) {
        if (file.is_e2e && file.encrypted_name && file._zipKey) {
          try { seg = await OneGyCrypto.decryptFileName(file.encrypted_name, file.name_nonce, file._zipKey) } catch (e) {}
        }
      } else if (folderNames) {
        var meta = null
        for (var j = 0; j < folderNames.length; j++) {
          if (folderNames[j].placeholder === seg) { meta = folderNames[j]; break }
        }
        if (meta) {
          var nk = await folderNameKeyFor(meta)
          if (nk) {
            try { seg = await OneGyCrypto.decryptFileName(meta.encrypted_name, meta.name_nonce, nk) } catch (e) {}
          }
        }
      }
      seg = String(seg == null ? '' : seg).replace(/[\\/]+/g, '_').replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/^[a-z]:/i, '_').replace(/[. ]+$/g, '')
      out.push(seg || '_')
    }
    return out.join('/')
  }
  async function clientZip (files, zipName, ticket, subfolderId, folderNames) {
    if (!files.length) { toast('NO DOWNLOADABLE FILES', 'error'); return }
    prog.open(zipName || 'download.zip')
    var entries = []
    var skipped = []
    var usedNames = {}
    var zipOffset = 0
    try {
      for (var i = 0; i < files.length; i++) {
        var f = files[i]
        prog.set((i / files.length) * 90, 'File ' + (i + 1) + '/' + files.length)
        // The file key also decrypts the member's name, so fetch it first.
        if (f.is_e2e && !f._zipKey) {
          try { f._zipKey = await fileKeyFor(f) } catch (e) {}
        }
        var zipPath = uniqueZipName(await resolveZipPath(f, folderNames), usedNames)
        var bytes
        try {
          if (f.is_e2e) {
            var key = f._zipKey || await fileKeyFor(f)
            if (!key) { skipped.push(zipPath + '  [NO DECRYPTION KEY]'); continue }
            f._zipKey = key
            var buf = await xhrArrayBuffer('/f/' + encodeURIComponent(f.id) + '/encrypted')
            bytes = new Uint8Array(await OneGyCrypto.decryptFileData(buf, key))
          } else {
            bytes = new Uint8Array(await xhrArrayBuffer(f.download_url || ('/f/' + TOKEN + '/file/' + f.id)))
          }
        } catch (memberErr) {
          skipped.push(zipPath + '  [DECRYPTION OR DOWNLOAD FAILED]')
          continue
        }
        if (bytes.length > ZIP32_MAX) {
          skipped.push(zipPath + '  [FILE TOO LARGE FOR ZIP: DOWNLOAD INDIVIDUALLY]')
          continue
        }
        var nameLen = new TextEncoder().encode(String(zipPath).replace(/\\/g, '/')).length
        if (zipOffset + 30 + nameLen + bytes.length > ZIP32_MAX) {
          skipped.push(zipPath + '  [ARCHIVE TOO LARGE: DOWNLOAD INDIVIDUALLY]')
          continue
        }
        zipOffset += 30 + nameLen + bytes.length
        entries.push({ name: zipPath, data: bytes })
      }
      if (skipped.length) {
        var manifestName = uniqueZipName('_DOWNLOAD_ERRORS.txt', usedNames)
        var manifest = 'THE FOLLOWING FILES COULD NOT BE INCLUDED AND ARE MISSING FROM THIS ARCHIVE:\n\n' + skipped.join('\n') + '\n'
        entries.push({ name: manifestName, data: new TextEncoder().encode(manifest) })
      }
      if (!entries.length || (skipped.length && entries.length === 1)) {
        prog.fail('No files could be decrypted'); toast('NO DECRYPTABLE FILES', 'error'); return
      }
      prog.set(95, 'Building archive…')
      saveBlob(storeZip(entries), (zipName || 'download') + '.zip')
      if (skipped.length) toast('ARCHIVE INCOMPLETE: SEE _DOWNLOAD_ERRORS.TXT', 'error')
      prog.done()
      // One ticket per enumerated folder, each redeemed for its own folder id.
      var tickets = Array.isArray(ticket) ? ticket : (ticket ? [{ ticket: ticket, subfolderId: subfolderId }] : [])
      for (var t = 0; t < tickets.length; t++) {
        try {
          await fetch('/f/' + encodeURIComponent(TOKEN) + '/track-folder-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ download_ticket: tickets[t].ticket, subfolder_id: tickets[t].subfolderId || undefined })
          })
        } catch (e) {}
      }
    } catch (e) {
      console.error('[BROWSE] client zip failed', e)
      prog.fail(e.message || 'Failed')
      toast('DOWNLOAD FAILED', 'error')
    }
  }
  function postServerZip (fileIds, folderIds) {
    var form = document.createElement('form')
    form.method = 'POST'
    form.action = '/f/' + encodeURIComponent(TOKEN) + '/download-selected'
    form.style.display = 'none'
    function add (name, value) {
      var i = document.createElement('input')
      i.type = 'hidden'; i.name = name; i.value = value
      form.appendChild(i)
    }
    fileIds.forEach(function (id) { add('file_ids', id) })
    folderIds.forEach(function (id) { add('folder_ids', id) })
    document.body.appendChild(form)
    form.submit()
    setTimeout(function () { form.remove() }, 2000)
  }
  async function downloadSelected () {
    if (!selCount()) return
    var fileIds = [], folderIds = []
    Object.keys(S.sel).forEach(function (k) {
      var parts = k.split(':')
      if (parts[0] === 'file') fileIds.push(parts.slice(1).join(':'))
      else folderIds.push(parts.slice(1).join(':'))
    })
    var selectedFiles = S.files.filter(function (f) { return fileIds.indexOf(String(f.id)) >= 0 })
    var hasE2e = selectedFiles.some(function (f) { return f.is_e2e })
    var listings = []
    var listFailed = false
    for (var i = 0; i < folderIds.length; i++) {
      try {
        var lr = await fetch('/f/' + encodeURIComponent(TOKEN) + '/folder/' + encodeURIComponent(folderIds[i]) + '/files', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        if (!lr.ok) { listFailed = true; continue }
        var ld = await lr.json()
        ld._folderId = parseInt(folderIds[i], 10)
        listings.push(ld)
        if ((ld.files || []).some(function (f) { return f.is_e2e })) hasE2e = true
      } catch (e) { listFailed = true }
    }
    if (!hasE2e) { postServerZip(fileIds, folderIds); return }
    // The client-side ZIP only contains what was listed: a folder that could not
    // be listed would be missing from an archive reported as complete.
    if (listFailed) { toast('COULD NOT LIST A SELECTED FOLDER. DOWNLOAD CANCELLED', 'error'); return }
    var files = selectedFiles.slice()
    var folderNames = []
    var tickets = []
    listings.forEach(function (ld) {
      files = files.concat(ld.files || [])
      if (ld.folder_names) folderNames = folderNames.concat(ld.folder_names)
      if (ld.download_ticket) tickets.push({ ticket: ld.download_ticket, subfolderId: ld._folderId })
    })
    await clientZip(files, 'selected', tickets, null, folderNames)
  }
  async function downloadAll () {
    try {
      var r = await fetch('/f/' + encodeURIComponent(TOKEN) + '/all-files', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (!r.ok) throw new Error('list')
      var data = await r.json()
      var files = data.files || []
      if (!files.some(function (f) { return f.is_e2e })) {
        window.location.href = '/f/' + encodeURIComponent(TOKEN) + '/download-all'
        return
      }
      await clientZip(files, data.folder_name || 'folder', data.download_ticket, null, data.folder_names || [])
    } catch (e) {
      toast('DOWNLOAD FAILED', 'error')
    }
  }

  // ═══ SEARCH ══════════════════════════════════════════════════════════════
  // A share with E2EE names is searched in the browser: the server only holds
  // placeholders, and sending the query would tell it what the visitor looks
  // for. The whole share (/all-files, the same listing Download all uses) is
  // fetched and decrypted once per search session; load() drops it.
  var searchTimer = null
  var searchIndex = null
  var searchResults = []
  function loadSearchIndex () {
    if (searchIndex) return searchIndex
    var p = searchIndex = (async function () {
      var r = await fetch('/f/' + encodeURIComponent(TOKEN) + '/all-files', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      var d = await r.json()
      var placeholders = Object.create(null)
      ;(d.folder_names || []).forEach(function (fn) { placeholders[fn.placeholder] = fn.id })
      var files = d.files || []
      files.forEach(function (f) {
        // name is "<folder>/.../<file>"; E2EE folder segments are unique placeholders.
        var parts = String(f.name == null ? '' : f.name).split('/')
        f.name = parts.pop()
        f._dirs = parts.map(function (seg) { return placeholders[seg] != null ? placeholders[seg] : seg })
      })
      await decryptFileNames(files)
      return files
    })()
    p.catch(function () { if (searchIndex === p) searchIndex = null })
    return p
  }
  function treeFolder (id) { return S.tree.filter(function (x) { return String(x.id) === String(id) })[0] || null }
  function searchFolderName (id) {
    var fd = treeFolder(id)
    return fd && (fd._dec || !fd.encrypted_name) ? fd.name : 'Encrypted folder'
  }
  function searchFilePath (f) {
    return [S.rootName].concat(f._dirs.map(function (seg) { return typeof seg === 'number' ? searchFolderName(seg) : seg })).join(' / ')
  }
  function searchFolderPath (fd) {
    var parts = []
    for (var pid = fd.parent_id, depth = 0; pid != null && String(pid) !== String(S.rootId) && depth < 64; depth++) {
      parts.unshift(searchFolderName(pid))
      var parent = treeFolder(pid)
      pid = parent ? parent.parent_id : null
    }
    return [S.rootName].concat(parts).join(' / ')
  }
  // The request token is taken only when a search actually runs: taking it on
  // every keystroke cancelled an in-flight folder load, and a short query
  // refetched the folder (wiping the selection) even when no results were up.
  var searchEpoch = null
  async function runSearch (q) {
    if (!q || q.trim().length < 2) {
      // Results on screen, or a search still in flight that would land them.
      if (S.searching || hasRequestAuthority(searchEpoch)) load(S.folderId, { noPush: true })
      return
    }
    var epoch = searchEpoch = nextRequestEpoch()
    try {
      var files, folders
      if (S.e2e) {
        var needle = q.trim().toLowerCase()
        // A name that did not decrypt is a server placeholder: never match it.
        var hit = function (o) { return (!o.encrypted_name || o._dec) && String(o.name).toLowerCase().indexOf(needle) >= 0 }
        var all = await loadSearchIndex()
        if (!hasRequestAuthority(epoch)) return
        files = all.filter(hit)
        folders = S.tree.filter(hit)
      } else {
        var r = await fetch('/f/' + encodeURIComponent(TOKEN) + '/search?q=' + encodeURIComponent(q.trim()),
          { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        if (!hasRequestAuthority(epoch)) return
        if (!r.ok) throw new Error('HTTP ' + r.status)
        var d = await r.json()
        if (!hasRequestAuthority(epoch)) return
        files = d.files || []
        folders = d.folders || []
        files.forEach(function (f) { if (!f.download_url) f.download_url = '/f/' + encodeURIComponent(TOKEN) + '/file/' + encodeURIComponent(f.id) })
      }
      searchResults = files
      // The selection belongs to the folder listing, which is no longer shown.
      S.searching = true
      S.sel = Object.create(null)
      syncSelbar()

      // Results are always rows: the location column says where each hit lives.
      var view = el('bwView')
      view.dataset.view = 'list'
      if (!files.length && !folders.length) {
        view.innerHTML = emptyState(ICO.search, 'No matches', 'Nothing in this share matches \u201c' + q.trim() + '\u201d.')
        return
      }
      var rows = folders.map(function (fd) {
        return '<div class="bw-item is-folder folder-row" data-folder-id="' + fd.id + '" data-folder-name="' + esc(fd.name) + '">' +
          '<span class="bw-item-thumb">' + ICO.folder + '</span>' +
          '<span class="bw-item-name folder-name" title="' + esc(fd.name) + '">' + esc(fd.name) + '</span>' +
          '<span class="bw-item-meta"></span><span class="bw-item-size"></span>' +
          '<span class="bw-item-date">' + esc(fd.path != null ? fd.path : searchFolderPath(fd)) + '</span>' +
          '<span class="bw-item-actions"></span></div>'
      }).join('') + files.map(function (f) {
        return '<div class="bw-item is-file file-row" data-file-id="' + esc(f.id) + '" data-file-name="' + esc(f.name) + '" data-search-file="' + esc(f.id) + '">' +
          '<span class="bw-item-thumb">' + docIcon(f.name) + '</span>' +
          '<span class="bw-item-name file-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
          '<span class="bw-item-meta">' + (f.is_e2e ? E2E_BADGE : '') + '</span>' +
          '<span class="bw-item-size">' + esc(typeof f.size === 'number' ? fmtBytes(f.size) : (f.size || '')) + '</span>' +
          '<span class="bw-item-date">' + esc(f._dirs ? searchFilePath(f) : (f.folder_path || '')) + '</span>' +
          '<span class="bw-item-actions"></span></div>'
      }).join('')
      view.innerHTML = LIST_HEAD.replace('Modified', 'Location') + section('Results', files.length + folders.length, rows)
    } catch (e) {
      if (!hasRequestAuthority(epoch)) return
      toast('SEARCH FAILED', 'error')
    }
  }

  // ═══ EVENTS ══════════════════════════════════════════════════════════════
  document.addEventListener('click', function (e) {
    // Tree expand/collapse
    var twist = e.target.closest('[data-twist]')
    if (twist) {
      e.stopPropagation()
      var tid = twist.dataset.twist
      S.open[tid] = !twist.closest('.bw-tree-row').classList.contains('is-open')
      renderTree()
      return
    }
    // Tree / breadcrumb navigation
    var nav = e.target.closest('.bw-tree-link, .bw-bcrumb-item')
    if (nav && !nav.classList.contains('is-current')) {
      var fid = nav.dataset.folderId
      load(fid === String(S.rootId) ? null : fid)
      closeDrawer()
      return
    }

    var dlF = e.target.closest('[data-dl-file]')
    if (dlF) {
      e.stopPropagation()
      var f = S.files.filter(function (x) { return String(x.id) === dlF.dataset.dlFile })[0]
      if (f) downloadFile(f)
      return
    }
    var dlFolder = e.target.closest('[data-dl-folder]')
    if (dlFolder) {
      e.stopPropagation()
      var fd = S.folders.filter(function (x) { return String(x.id) === dlFolder.dataset.dlFolder })[0]
      if (fd && fd.download_url) window.location.href = fd.download_url
      return
    }
    var cpF = e.target.closest('[data-copy-file]')
    if (cpF) { e.stopPropagation(); copy(shareLinkFor('file', cpF.dataset.copyFile)); return }
    var cpD = e.target.closest('[data-copy-folder]')
    if (cpD) { e.stopPropagation(); copy(shareLinkFor('folder', cpD.dataset.copyFolder)); return }

    // Checkboxes handle their own change event; ignore them here.
    if (e.target.closest('.bw-check')) return

    // Open a folder / download a file by clicking the row
    var item = e.target.closest('.bw-item')
    if (item) {
      if (item.dataset.folderId) { load(item.dataset.folderId); return }
      if (item.dataset.searchFile) {
        // Results carry their own key material, so they open wherever they live.
        var hitFile = searchResults.filter(function (x) { return String(x.id) === item.dataset.searchFile })[0]
        if (hitFile) downloadFile(hitFile)
        return
      }
      var file = S.files.filter(function (x) { return String(x.id) === item.dataset.fileId })[0]
      if (file) downloadFile(file)
    }
  })

  document.addEventListener('change', function (e) {
    var cb = e.target.closest('.bw-check')
    if (!cb) return
    if (cb.dataset.fileId) toggleSel('file', cb.dataset.fileId, cb.checked)
    else if (cb.dataset.folderId) toggleSel('folder', cb.dataset.folderId, cb.checked)
  })

  // View / sort
  el('bwViewSeg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-view]')
    if (!b) return
    S.view = b.dataset.view
    try { localStorage.setItem('onegy_bw_view', S.view) } catch (err) {}
    Array.prototype.forEach.call(this.querySelectorAll('[data-view]'), function (x) {
      x.classList.toggle('is-active', x === b)
    })
    renderItems(); hydrateThumbs(); reapplySelection()
  })
  el('bwSort').addEventListener('change', function () {
    S.sort = this.value
    try { localStorage.setItem('onegy_bw_sort', S.sort) } catch (e) {}
    renderItems(); hydrateThumbs(); reapplySelection()
  })
  function reapplySelection () {
    Object.keys(S.sel).forEach(function (k) {
      var parts = k.split(':'), kind = parts[0], id = parts.slice(1).join(':')
      var sel = kind === 'file'
        ? document.querySelector('.bw-item[data-file-id="' + CSS.escape(id) + '"]')
        : document.querySelector('.bw-item[data-folder-id="' + CSS.escape(id) + '"]')
      if (sel) {
        sel.classList.add('is-selected')
        var cb = sel.querySelector('.bw-check')
        if (cb) cb.checked = true
      }
    })
    syncSelbar()
  }

  // Search box
  el('bwSearch').addEventListener('input', function () {
    var q = this.value
    clearTimeout(searchTimer)
    searchTimer = setTimeout(function () { runSearch(q) }, 300)
  })
  el('bwSearchClear').addEventListener('click', function () {
    el('bwSearch').value = ''
    clearTimeout(searchTimer)
    runSearch('')
  })

  // Bulk bar
  el('bwSelDownload').addEventListener('click', downloadSelected)
  el('bwSelClear').addEventListener('click', function () {
    S.sel = Object.create(null)
    Array.prototype.forEach.call(document.querySelectorAll('.bw-check'), function (c) { c.checked = false })
    Array.prototype.forEach.call(document.querySelectorAll('.bw-item.is-selected'), function (c) { c.classList.remove('is-selected') })
    syncSelbar()
  })

  // Download-all: a plain navigation so the server streams the ZIP.
  el('bwDownloadAll').addEventListener('click', function () { downloadAll() })

  el('bwProgClose').addEventListener('click', prog.close)

  // Mobile drawer
  function openDrawer () { el('bwSide').classList.add('is-open'); el('bwScrim').classList.add('is-open') }
  function closeDrawer () { el('bwSide').classList.remove('is-open'); el('bwScrim').classList.remove('is-open') }
  el('bwSideToggle').addEventListener('click', function () {
    el('bwSide').classList.contains('is-open') ? closeDrawer() : openDrawer()
  })
  el('bwScrim').addEventListener('click', closeDrawer)

  // Back/forward through SPA folder navigation
  window.addEventListener('popstate', function (e) {
    var fid = (e.state && e.state.bw) ? e.state.folderId : null
    load(fid && fid !== S.rootId ? fid : null, { noPush: true })
  })

  // ── Boot ─────────────────────────────────────────────────────────────────
  el('bwSort').value = S.sort
  Array.prototype.forEach.call(el('bwViewSeg').querySelectorAll('[data-view]'), function (x) {
    x.classList.toggle('is-active', x.dataset.view === S.view)
  })
  var initial = new URLSearchParams(window.location.search).get('folder')
  load(initial || null, { replace: true })
})()
