/* ============================================================================
   files.js — Frost Files view logic (from scratch).
   Fetches the existing JSON APIs (/files/list, /search, /trash/*, /upload,
   /folder/create, …) and calls window.OneGyCrypto for all E2EE work — names,
   thumbnails, upload encryption, download decryption. The crypto is never
   re-implemented here; this file is UI + orchestration only.
   ========================================================================== */
(function () {
  'use strict'

  // ---- State ---------------------------------------------------------------
  var S = {
    folderId: null,          // current folder (null = root)
    rootName: (window.__FX_ROOT_NAME__ || 'FILES'),
    folders: [], files: [],  // current listing (names decrypted in place)
    breadcrumbs: [],
    sidebar: [],             // flat folder tree
    view: 'grid',
    sort: 'name',
    sel: new Set(),          // "f<id>" files, "d<id>" folders
    multi: false,            // true when built via checkbox / Ctrl / Shift / Ctrl+A
    lastFocus: null,         // keyboard + range endpoint
    anchor: null,            // shift-range anchor (set on non-shift select)
    trashMode: false,
    loadFailed: false,       // last listing load errored (empty !== "nothing there")
    treeOpen: new Set(['root']) // expanded sidebar folder ids
  }

  var $ = function (id) { return document.getElementById(id) }
  var el = { view: null }
  var mobileViewMedia = window.matchMedia('(max-width:620px)')

  // Monotonic listing token. Fast tree clicks and the 260 ms search debounce
  // can overlap, and a slower earlier response used to win — leaving S.folderId
  // disagreeing with what is rendered, so the next upload / New folder targeted
  // a folder that was not on screen. Every load takes a token and abandons its
  // result after each await once a newer load has started.
  var loadSeq = 0
  function newLoad () { return ++loadSeq }
  function stale (seq) { return seq !== loadSeq }

  // ---- Small helpers -------------------------------------------------------
  function csrf () {
    var m = document.querySelector('meta[name="csrf-token"]')
    return m ? m.getAttribute('content') : ''
  }
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function keyOf (item, isFolder) { return (isFolder ? 'd' : 'f') + item.id }
  function haveKeys () { return typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys && OneGyCrypto.hasSessionKeys() }
  function toast (m, c) { if (window.showToast) window.showToast(m, c) }
  // Pull the server's own error string off a failed response so the toast says
  // what actually went wrong instead of a generic message.
  async function errText (r) {
    var d = null
    try { d = await r.json() } catch (e) {}
    return String((d && d.error) || ('HTTP ' + r.status)).toUpperCase()
  }

  var ICON = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 20V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
  }
  var IMG_EXT = { jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, bmp: 1, svg: 1 }
  var AUDIO_EXT = { mp3: 1, wav: 1, ogg: 1, m4a: 1, aac: 1, flac: 1 }
  var THUMB_EXT = {
    jpg: 1, jpeg: 1, png: 1, gif: 1, bmp: 1, webp: 1,
    txt: 1, md: 1, log: 1, csv: 1, json: 1, xml: 1, yaml: 1, yml: 1, py: 1, js: 1,
    html: 1, css: 1, sh: 1, bat: 1, ini: 1, cfg: 1, conf: 1, c: 1, cpp: 1, h: 1,
    hpp: 1, lua: 1, rb: 1, rs: 1, go: 1, java: 1, ts: 1, tsx: 1, jsx: 1, toml: 1,
    ps1: 1, sql: 1, r: 1, swift: 1, kt: 1, php: 1, pl: 1, diff: 1, makefile: 1, env: 1,
    mp4: 1, webm: 1, ogg: 1, mov: 1, mkv: 1, avi: 1, wmv: 1, flv: 1, m4v: 1, '3gp': 1
  }
  function extOf (name, ext) {
    if (ext) return ext.replace(/^\./, '').toLowerCase()
    var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''
  }
  function isDotenvName (name) {
    var base = String(name || '').split(/[/\\]/).pop().toLowerCase()
    return base === '.env' || base.indexOf('.env.') === 0
  }
  // E2EE thumbs cannot be generated server-side. Fernet image/text/video tiles
  // always expose data-thumb so /file/<id>/thumbnail can fill a missing render
  // on first view (upload-time daemon may have skipped the semaphore).
  function canThumb (item) {
    if (!item) return false
    if (item.has_thumbnail) return true
    if (item.is_e2e) return false
    if (item.thumbnailable) return true
    var ext = extOf(item.name, item.extension)
    return THUMB_EXT[ext] === 1 || isDotenvName(item.name)
  }

  // ---- Crypto: decrypt listing names (reuse OneGyCrypto) -------------------
  async function decryptNames (files, folders) {
    if (!haveKeys()) return
    var masterKey
    try { masterKey = await OneGyCrypto.getMasterKeyFromSession() } catch (e) { return }
    if (!masterKey) return

    var fJobs = (files || []).filter(function (f) { return f.encrypted_name && f.name_nonce && f.encrypted_file_key }).map(async function (f) {
      try {
        var fk = await OneGyCrypto.unwrapFileKeyWithMasterKey(f.encrypted_file_key, f.file_key_nonce, masterKey)
        if (!fk) return
        var n = await OneGyCrypto.decryptFileName(f.encrypted_name, f.name_nonce, fk)
        if (n) { f.name = n; f._dec = true; f._fileKey = fk }
      } catch (e) {}
    })
    var dJobs = (folders || []).filter(function (d) { return d.encrypted_name && d.name_nonce && d.encrypted_name_key && d.name_key_nonce }).map(async function (d) {
      try {
        var nk = await OneGyCrypto.unwrapFolderNameKey(d.encrypted_name_key, d.name_key_nonce, masterKey)
        var n = await OneGyCrypto.decryptFolderName(d.encrypted_name, d.name_nonce, nk)
        if (n) { d.name = n; d._dec = true }
      } catch (e) {}
    })
    await Promise.all(fJobs.concat(dJobs))
  }
  // Some folder/file names come through as the literal placeholder "encrypted".
  function displayName (item, isFolder) {
    if (item._dec) return item.name
    if (item.is_e2e && (item.name === 'encrypted' || !item.name)) return isFolder ? 'Encrypted folder' : 'Encrypted file'
    return item.name || (isFolder ? 'Folder' : 'File')
  }

  // ---- E2EE unlock (logged in, but keys not yet in this browser session) ---
  // Mirrors the old dashboard's unlock banner: fetch the encrypted key material
  // for the current session, derive the wrapping key from the password, unwrap
  // the master key, and cache it. No re-implementation of the crypto itself.
  function hasE2EContent () {
    return S.files.some(function (f) { return f.is_e2e }) || S.folders.some(function (f) { return f.is_e2e })
  }
  function updateLockBar () {
    var lb = $('fxLockBar'); if (!lb) return
    lb.hidden = !(hasE2EContent() && !haveKeys())
  }
  async function unlockKeys (pw) {
    var r = await fetch('/api/keys', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!r.ok) throw new Error('keys')
    var kd = await r.json()
    if (!kd.has_e2ee_keys) { toast('THIS ACCOUNT HAS NO ENCRYPTION KEYS', 'error'); return false }
    var wrap = pw
    if (kd.split_key_version >= 1 && kd.auth_token_salt) {
      var sk = await OneGyCrypto.deriveAuthAndWrappingKeys(pw, kd.auth_token_salt)
      wrap = sk.wrappingKey
    }
    var res = await OneGyCrypto.unlockUserKeys(wrap, {
      encryptedMasterKey: kd.encrypted_master_key, masterKeyNonce: kd.master_key_nonce, masterKeySalt: kd.master_key_salt,
      encryptedPrivateKey: kd.encrypted_private_key, privateKeyNonce: kd.private_key_nonce
    })
    await OneGyCrypto.storeMasterKeyInSession(res.masterKey)
    if (res.privateKey && OneGyCrypto.storePrivateKeyInSession) { try { await OneGyCrypto.storePrivateKeyInSession(res.privateKey) } catch (e) {} }
    return true
  }

  // ---- Sorting -------------------------------------------------------------
  function sortItems (arr, isFolder) {
    var s = S.sort
    var a = arr.slice()
    a.sort(function (x, y) {
      var nx = displayName(x, isFolder).toLowerCase(), ny = displayName(y, isFolder).toLowerCase()
      switch (s) {
        case 'name-desc': return ny < nx ? -1 : ny > nx ? 1 : 0
        case 'size': return (y.size || 0) - (x.size || 0)
        case 'size-asc': return (x.size || 0) - (y.size || 0)
        case 'date': return (y.updated_at_iso || y.upload_date_iso || '') < (x.updated_at_iso || x.upload_date_iso || '') ? -1 : 1
        case 'date-asc': return (x.updated_at_iso || x.upload_date_iso || '') < (y.updated_at_iso || y.upload_date_iso || '') ? -1 : 1
        default: return nx < ny ? -1 : nx > ny ? 1 : 0
      }
    })
    return a
  }

  // ---- Data load -----------------------------------------------------------
  async function loadFolder (id, opts) {
    opts = opts || {}
    var previousFolderId = S.folderId
    var seq = newLoad()
    searchIndex = null
    S.trashMode = false
    var restoreAllBtn = $('restoreAllBtn'); if (restoreAllBtn) restoreAllBtn.hidden = true
    $('fxNewFolder').hidden = false; $('fxUploadBtn').hidden = false
    if (!opts.keepSel) resetSelState()
    skeleton()
    var url = (id == null) ? '/files/list' : '/files/list/' + id
    try {
      var r = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (stale(seq)) return
      if (!r.ok) {
        if (opts.fallbackRoot && r.status === 404 && id != null) return loadFolder(null)
        throw new Error('HTTP ' + r.status)
      }
      var d = await r.json()
      if (stale(seq)) return
      S.loadFailed = false
      S.folderId = d.current_folder_id != null ? d.current_folder_id : null
      S.folders = d.folders || []
      S.files = d.files || []
      S.breadcrumbs = d.breadcrumbs || []
      S.sidebar = d.sidebar_folders || []
      if (d.root_folder_name) S.rootName = d.root_folder_name
      await decryptNames(S.files, S.folders)
      await decryptNames(null, S.sidebar)
      await decryptNames(null, S.breadcrumbs)
      if (stale(seq)) return
      openActiveTreePath()
      renderStorage(d)
      renderTrashCount(d.trash_count || 0)
      renderSidebar(!S._sbAnimated); S._sbAnimated = true
      renderBreadcrumb()
      render()
      if (window.MusicPlayer && MusicPlayer.onFolderChanged) MusicPlayer.onFolderChanged()
      updateSelbar()
      if (!opts.noPush && String(previousFolderId) !== String(S.folderId)) {
        var path = S.folderId == null ? '/files' : '/files/folder/' + S.folderId
        history.pushState({ fx: true, folderId: S.folderId }, '', path)
      }
    } catch (e) {
      if (stale(seq)) return
      S.loadFailed = true
      el.view.innerHTML = errorState('Could not load this folder.')
    }
  }

  async function loadTrash () {
    var seq = newLoad()
    searchIndex = null
    S.trashMode = true; resetSelState(); skeleton()
    $('fxNewFolder').hidden = true; $('fxUploadBtn').hidden = true
    try {
      var r = await fetch('/trash/list', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (stale(seq)) return
      // A JSON error body used to be parsed as an empty listing, which renders
      // "Trash is empty" — telling the user their deleted data is already gone
      // when the request merely failed.
      if (!r.ok) throw new Error('HTTP ' + r.status)
      var d = await r.json()
      if (stale(seq)) return
      S.loadFailed = false
      S.folderId = null
      S.folders = d.folders || []
      S.files = d.files || []
      S.sidebar = d.sidebar_folders || []
      await decryptNames(S.files, S.folders)
      await decryptNames(null, S.sidebar)
      if (stale(seq)) return
      S.breadcrumbs = []
      renderStorage(d)
      renderTrashCount(d.trash_count || 0)
      renderSidebar(!S._sbAnimated); S._sbAnimated = true
      renderBreadcrumb()
      render()
      var restoreAllBtn = $('restoreAllBtn')
      if (restoreAllBtn) restoreAllBtn.hidden = !(S.files.length || S.folders.length)
      updateSelbar()
    } catch (e) {
      if (stale(seq)) return
      S.loadFailed = true
      S.folders = []; S.files = []; S.breadcrumbs = []
      var restoreAllBtn = $('restoreAllBtn'); if (restoreAllBtn) restoreAllBtn.hidden = true
      el.view.innerHTML = errorState('Could not load the trash. Nothing has been deleted — reload to try again.')
    }
    document.querySelectorAll('.fx-tree-row').forEach(function (r) { r.classList.remove('is-active') })
    $('fxTrashBtn').classList.add('is-active')
  }

  // ---- Rendering: chrome ---------------------------------------------------
  function fmtBytes (b) { if (!b) return '0 B'; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024))); return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i] }
  function renderStorage (d) {
    // Exact bytes: storage_used_gb is rounded to 0.01 GB, which showed "0 / 25 GB" for anything under ~5 MB
    var used = d.storage_used_bytes, lim = d.storage_limit_gb
    if (used == null) return
    $('fxStorageTxt').textContent = fmtBytes(used) + ' / ' + lim + ' GB'
    var pct = lim > 0 ? Math.min(100, (used / (lim * 1073741824)) * 100) : 0
    var f = $('fxMeter'); f.style.width = pct + '%'
    f.classList.toggle('is-warn', pct >= 75 && pct < 90)
    f.classList.toggle('is-bad', pct >= 90)
  }
  function renderTrashCount (n) {
    var b = $('fxTrashCount'); b.textContent = n; b.hidden = !(n > 0)
  }
  var prevCrumbKeys = []
  function renderBreadcrumb () {
    var bc = $('fxBcrumb'); bc.innerHTML = ''
    // Segments that were not in the previous path (plus the new current one)
    // get a quick slide-in; unchanged ancestors stay put.
    var keys = ['root']
    if (S.trashMode) keys.push('trash')
    else S.breadcrumbs.forEach(function (b) { keys.push(String(b.id)) })
    var changed = keys.join('/') !== prevCrumbKeys.join('/')
    function isNew (i) { return prevCrumbKeys[i] !== keys[i] || (changed && i === keys.length - 1) }
    var home = document.createElement('button')
    home.className = 'fx-bc-item' + ((S.folderId == null && !S.trashMode) ? ' is-current' : '') + (isNew(0) ? ' fx-bc-in' : '')
    home.innerHTML = '<svg class="fx-bc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>' + esc(S.rootName)
    home.onclick = function () { loadFolder(null) }
    bc.appendChild(home)
    if (S.trashMode) {
      bc.appendChild(sep(isNew(1))); var t = document.createElement('span'); t.className = 'fx-bc-item is-current' + (isNew(1) ? ' fx-bc-in' : ''); t.textContent = 'Trash'; bc.appendChild(t); prevCrumbKeys = keys; tail(); return
    }
    S.breadcrumbs.forEach(function (b, i) {
      var anim = isNew(i + 1)
      bc.appendChild(sep(anim))
      var isLast = i === S.breadcrumbs.length - 1
      var btn = document.createElement('button')
      btn.className = 'fx-bc-item' + (isLast ? ' is-current' : '') + (anim ? ' fx-bc-in' : '')
      btn.textContent = displayName(b, true)
      if (!isLast) btn.onclick = function () { loadFolder(b.id) }
      bc.appendChild(btn)
    })
    prevCrumbKeys = keys
    tail()
    function sep (anim) { var s = document.createElement('span'); s.className = 'fx-bc-sep' + (anim ? ' fx-bc-in' : ''); s.textContent = '/'; return s }
    // The bar is a single row now — keep the current folder in view when the path is long
    function tail () { requestAnimationFrame(function () { bc.scrollLeft = bc.scrollWidth }) }
  }

  function renderSidebar (animate) {
    // Animate only on fresh folder loads; open/close toggles rebuild the tree
    // and must not replay the entrance (it would flicker on every toggle).
    // A just-toggled-open branch (S.treeReveal) gets its own quick reveal.
    var tree = $('fxTree'); tree.classList.toggle('is-anim', !!animate); tree.innerHTML = ''
    var byParent = {}
    S.sidebar.forEach(function (f) { var p = f.parent_id || 'root'; (byParent[p] = byParent[p] || []).push(f) })
    var revealKey = S.treeReveal; S.treeReveal = null
    var revealIdx = 0
    // Root row
    var rootOpen = S.treeOpen.has('root')
    var rootRow = mkTreeRow({ id: null, name: S.rootName, is_e2e: true }, 0, rootOpen, byParent['root'] && byParent['root'].length)
    tree.appendChild(rootRow.el)
    function walk (parentKey, depth, reveal) {
      var kids = byParent[parentKey]; if (!kids) return
      kids.sort(function (a, b) { return displayName(a, true).toLowerCase() < displayName(b, true).toLowerCase() ? -1 : 1 })
      kids.forEach(function (f) {
        var hasKids = byParent[f.id] && byParent[f.id].length
        var open = S.treeOpen.has(String(f.id))
        var row = mkTreeRow(f, depth, open, hasKids)
        if (reveal) { row.el.classList.add('is-reveal'); row.el.style.setProperty('--ti', revealIdx++) }
        tree.appendChild(row.el)
        if (open) walk(f.id, depth + 1, reveal || String(f.id) === revealKey)
      })
    }
    if (!S.trashMode && S.folderId == null) rootRow.el.classList.add('is-active')
    if (rootOpen) walk('root', 1, revealKey === 'root')
    if (animate) for (var i = 0; i < tree.children.length; i++) tree.children[i].style.setProperty('--i', i)
  }
  // Collapse a branch: fade its descendant rows out first, then rebuild the
  // tree (the rebuild is what actually removes them — the animation is cosmetic).
  function collapseTreeChildren (rowEl) {
    var depth = parseInt(rowEl.getAttribute('data-depth') || '0', 10)
    rowEl.classList.remove('is-open')
    var doomed = [], n = rowEl.nextElementSibling
    while (n && parseInt(n.getAttribute('data-depth') || '0', 10) > depth) { doomed.push(n); n = n.nextElementSibling }
    if (!doomed.length) { renderSidebar(); return }
    doomed.forEach(function (d) { d.classList.add('is-closing') })
    setTimeout(renderSidebar, 120)
  }
  function openActiveTreePath () {
    S.treeOpen.add('root')
    if (S.folderId == null) return
    var byId = {}
    S.sidebar.forEach(function (f) { byId[String(f.id)] = f })
    var current = byId[String(S.folderId)]
    while (current) {
      if (current.parent_id != null) S.treeOpen.add(String(current.parent_id))
      current = current.parent_id == null ? null : byId[String(current.parent_id)]
    }
  }
  function revealTreeBranch (id) {
    S.treeOpen.add('root')
    if (id == null) return
    var byId = {}
    S.sidebar.forEach(function (f) { byId[String(f.id)] = f })
    var current = byId[String(id)]
    while (current) {
      S.treeOpen.add(String(current.id))
      current = current.parent_id == null ? null : byId[String(current.parent_id)]
    }
  }
  function mkTreeRow (f, depth, open, hasKids) {
    var row = document.createElement('div')
    row.className = 'fx-tree-row rd-side-row' + (open ? ' is-open' : '') + (f.id === S.folderId && !S.trashMode ? ' is-active' : '')
    row.setAttribute('data-fid', f.id == null ? '' : f.id)
    row.setAttribute('data-depth', depth)
    row.style.paddingLeft = (depth * 0.85) + 'rem'
    var name = f.id == null ? f.name : displayName(f, true)
    row.innerHTML =
      (hasKids ? '<button type="button" class="fx-tree-toggle" title="TOGGLE FOLDER" aria-label="TOGGLE ' + esc(name) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></button>' : '<span class="fx-tree-spacer"></span>') +
      '<button type="button" class="fx-tree-link"><span class="fx-ico fx-tree-ico">' + ICON.folder + '</span><span class="fx-tree-name">' + esc(name) + '</span></button>' +
      '<span class="fx-tree-actions"><button type="button" class="fx-tree-action" data-tree-action="new" title="NEW SUBFOLDER" aria-label="NEW SUBFOLDER"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>' +
      (f.id == null ? '' : '<button type="button" class="fx-tree-action is-danger" data-tree-action="delete" title="MOVE TO TRASH" aria-label="MOVE FOLDER TO TRASH"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>') + '</span>'
    row.querySelector('.fx-tree-toggle') && (row.querySelector('.fx-tree-toggle').onclick = function (e) {
      e.stopPropagation()
      var key = f.id == null ? 'root' : String(f.id)
      if (S.treeOpen.has(key)) { S.treeOpen.delete(key); collapseTreeChildren(row) }
      else { S.treeOpen.add(key); S.treeReveal = key; renderSidebar() }
    })
    row.querySelector('.fx-tree-link').onclick = function () {
      $('fxTrashBtn').classList.remove('is-active')
      loadFolder(f.id)
      closeSide()
    }
    row.querySelector('[data-tree-action="new"]').onclick = function (e) { e.stopPropagation(); newFolder(f.id, true) }
    var deleteButton = row.querySelector('[data-tree-action="delete"]')
    if (deleteButton) deleteButton.onclick = function (e) { e.stopPropagation(); deleteItems([{ item: f, isFolder: true }]) }
    return { el: row }
  }

  // ---- Rendering: listing --------------------------------------------------
  function skeleton () {
    el.view.innerHTML = '<div class="fx-skel">' + Array(8).join('<div class="fx-skel-card"></div>') + '</div>'
  }
  function errorState (msg) {
    return '<div class="fx-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg><h3>Something went wrong</h3><p>' + esc(msg) + '</p></div>'
  }
  function emptyState () {
    if (S.trashMode) return '<div class="fx-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg><h3>Trash is empty</h3><p>Deleted files and folders will appear here.</p></div>'
    return '<div class="fx-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 20V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z"/></svg><h3>This folder is empty</h3><p>Drag files here or use Upload. Everything is end-to-end encrypted before it leaves your device.</p></div>'
  }

  function render () {
    updateLockBar()
    el.view.setAttribute('data-view', S.view)
    var folders = sortItems(S.folders, true)
    var files = sortItems(S.files, false)
    if (!folders.length && !files.length) { el.view.innerHTML = emptyState(); return }
    var fn = { grid: renderGrid, list: renderList, gallery: renderGallery, columns: renderColumns }[S.view] || renderGrid
    fn(folders, files)
    staggerEntrance()
    observeThumbs()
  }

  // Entrance stagger: --i feeds the animation-delay in files.css (capped there
  // via min(), so long listings don't wait — items past the cap pop together).
  function staggerEntrance () {
    var items = el.view.querySelectorAll('.fx-item, .fx-row, .fx-gal-item')
    for (var i = 0; i < items.length; i++) items[i].style.setProperty('--i', i)
  }

  function badges (item, isFolder) {
    var b = ''
    if (item.is_e2e) b += '<span class="fx-badge is-e2e">E2E</span>'
    else if (item.is_public) b += '<span class="fx-badge is-public">Public</span>'
    if (item.expires) b += '<span class="fx-badge is-exp">' + item.expires.value + item.expires.unit + '</span>'
    return b
  }

  // GRID
  function renderGrid (folders, files) {
    var h = ''
    if (folders.length) { h += '<div class="fx-section-label">Folders · ' + folders.length + '</div><div class="fx-grid">'; folders.forEach(function (f, i) { h += gridCard(f, true, i) }); h += '</div>' }
    if (files.length) { h += '<div class="fx-section-label">Files · ' + files.length + '</div><div class="fx-grid">'; files.forEach(function (f, i) { h += gridCard(f, false, i) }); h += '</div>' }
    el.view.innerHTML = h
  }
  function gridCard (item, isFolder, i) {
    var k = keyOf(item, isFolder)
    var nm = displayName(item, isFolder)
    var thumb = isFolder
      ? '<div class="fx-thumb"><span class="fx-ext-ico fx-ico">' + ICON.folder + '</span></div>'
      : fileThumb(item)
    var meta = isFolder
      ? (item.file_count || 0) + ' item' + ((item.file_count === 1) ? '' : 's')
      : (item.size_formatted || '')
    return '<div class="fx-item' + (isFolder ? ' is-folder' : '') + selClass(k) + '" data-k="' + k + '" data-id="' + item.id + '" data-folder="' + isFolder + '" draggable="true" style="animation-delay:' + Math.min(i * 18, 260) + 'ms">' +
      '<span class="fx-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' +
      thumb +
      '<div class="fx-item-body"><div class="fx-item-top">' +
      '<span class="fx-item-name" title="' + esc(nm) + '">' + esc(nm) + '</span>' +
      '<button class="rd-icon-btn fx-item-kebab" data-kebab aria-label="More options"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button></div>' +
      '<div class="fx-item-sub"><span class="fx-meta">' + esc(meta) + '</span>' + badges(item, isFolder) + '</div>' +
      '</div></div>'
  }
  function fileThumb (item) {
    var ext = extOf(item.name, item.extension)
    var ph = '<span class="fx-ext-ico fx-ico">' + ICON.file + '</span>'
    // Never emit <img src> here. Native loading=lazy still inserts a src for
    // every tile at render, and Chrome's lazy margin is thousands of pixels —
    // a flick-scroll of a large grid opens a burst of GETs. That burst 429s
    // at the Cloudflare/NPM edge (Flask-Limiter on this route is 20000/min
    // and does not log those 429s). All thumbs go through the IO + rate-capped
    // queue in observeThumbs().
    if (canThumb(item)) {
      return '<div class="fx-thumb" data-thumb="' + item.id + '">' + ph + '</div>'
    }
    return '<div class="fx-thumb">' + ph + (ext ? '<span class="fx-ext-tag">' + esc(ext) + '</span>' : '') + '</div>'
  }

  // LIST
  function renderList (folders, files) {
    var h = '<div class="fx-list"><div class="fx-list-head">' +
      '<button data-sortcol="name">Name</button>' +
      '<button data-sortcol="type">Type</button>' +
      '<button data-sortcol="size">Size</button>' +
      '<button data-sortcol="date">Modified</button><span></span></div>'
    folders.forEach(function (f) { h += listRow(f, true) })
    files.forEach(function (f) { h += listRow(f, false) })
    h += '</div>'
    el.view.innerHTML = h
  }
  function listRow (item, isFolder) {
    var k = keyOf(item, isFolder), nm = displayName(item, isFolder)
    var type = isFolder ? 'Folder' : (extOf(item.name, item.extension) || 'file').toUpperCase()
    var size = isFolder ? ((item.file_count || 0) + ' items') : (item.size_formatted || '—')
    var date = isFolder ? (item.updated_at || '') : (item.upload_date || '')
    var rowIco = isFolder
      ? '<span class="fx-ico fx-row-ico" style="color:var(--accent)">' + ICON.folder + '</span>'
      : (canThumb(item)
        ? '<span class="fx-row-thumb" data-thumb="' + item.id + '"><span class="fx-ico fx-row-ico">' + ICON.file + '</span></span>'
        : '<span class="fx-ico fx-row-ico" style="color:var(--accent)">' + ICON.file + '</span>')
    return '<div class="fx-row' + selClass(k) + '" data-k="' + k + '" data-id="' + item.id + '" data-folder="' + isFolder + '" draggable="true">' +
      '<span class="fx-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' +
      '<div class="fx-row-name">' + rowIco +
      '<span class="fx-name">' + esc(nm) + '</span></div>' +
      '<span class="fx-meta fx-list-type">' + esc(type) + '</span>' +
      '<span class="fx-meta fx-list-size">' + esc(size) + '</span>' +
      '<span class="fx-meta fx-list-date">' + esc(date) + '</span>' +
      '<button class="rd-icon-btn fx-row-kebab" data-kebab aria-label="More"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>' +
      '</div>'
  }

  // GALLERY
  function renderGallery (folders, files) {
    var h = ''
    if (folders.length) { h += '<div class="fx-section-label">Folders</div><div class="fx-grid">'; folders.forEach(function (f, i) { h += gridCard(f, true, i) }); h += '</div><div class="fx-section-label">Files</div>' }
    h += '<div class="fx-gallery">'
    files.forEach(function (f, i) {
      var k = keyOf(f, false), nm = displayName(f, false)
      var inner = canThumb(f)
        ? '<div class="fx-gal-thumb" data-thumb="' + f.id + '"><div class="fx-gal-ph">' + ICON.file + '</div></div>'
        : '<div class="fx-gal-ph">' + ICON.file + '</div>'
      h += '<a class="fx-gal-item' + selClass(k) + '" data-k="' + k + '" data-id="' + f.id + '" data-folder="false" draggable="true" style="animation-delay:' + Math.min(i * 16, 240) + 'ms">' +
        '<span class="fx-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' +
        inner +
        '<span class="fx-gal-cap"><span class="fx-name" title="' + esc(nm) + '">' + esc(nm) + '</span></span></a>'
    })
    h += '</div>'
    el.view.innerHTML = h
  }

  // COLUMNS (Miller) — renders current folder as a single column with a preview pane.
  function renderColumns (folders, files) {
    var h = '<div class="fx-cols"><div class="fx-col">'
    folders.forEach(function (f) {
      h += '<button class="fx-col-row' + selClass(keyOf(f, true)) + '" data-k="' + keyOf(f, true) + '" data-id="' + f.id + '" data-folder="true" draggable="true"><span class="fx-ico fx-col-ico">' + ICON.folder + '</span><span class="fx-col-name" title="' + esc(displayName(f, true)) + '">' + esc(displayName(f, true)) + '</span><span class="fx-col-chev">›</span></button>'
    })
    files.forEach(function (f) {
      h += '<button class="fx-col-row' + selClass(keyOf(f, false)) + '" data-k="' + keyOf(f, false) + '" data-id="' + f.id + '" data-folder="false" draggable="true"><span class="fx-ico fx-col-ico">' + ICON.file + '</span><span class="fx-col-name" title="' + esc(displayName(f, false)) + '">' + esc(displayName(f, false)) + '</span></button>'
    })
    h += '</div><div class="fx-col fx-col-preview" id="fxColPreview"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--text-dim)" stroke-width="1.4" stroke-linejoin="round" style="opacity:.4"><path d="M14 3v5h5"/><path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2z"/></svg><p class="fx-meta">Select an item</p></div></div>'
    el.view.innerHTML = h
  }
  function columnPreview (item, isFolder) {
    var p = $('fxColPreview'); if (!p) return
    var nm = displayName(item, isFolder)
    var thumbAttr = (!isFolder && canThumb(item)) ? ' data-thumb="' + item.id + '"' : ''
    p.innerHTML = '<div class="fx-cp-thumb"' + thumbAttr + '>' + (isFolder ? ICON.folder : ICON.file) + '</div><h4>' + esc(nm) + '</h4>' +
      '<div class="fx-meta">' + (isFolder ? (item.file_count || 0) + ' items' : (item.size_formatted || '')) + '</div>' +
      badges(item, isFolder) +
      (!isFolder ? '<button class="rd-btn rd-btn-primary" data-open-details="1" style="margin-top:.6rem">Details</button>' : '')
    p.querySelector('[data-open-details]') && (p.querySelector('[data-open-details]').onclick = function () { openDetails(item, isFolder) })
    if (thumbAttr) loadThumb(p.querySelector('[data-thumb]'))
  }

  // ---- Thumbnails (lazy, E2E-aware) ---------------------------------------
  var thumbObs = null
  var thumbQueue = []
  var thumbQueued = new Set()
  var thumbInFlight = 0
  var THUMB_CONCURRENCY = 32
  var e2eThumbCache = new Map()
  var E2E_THUMB_CACHE_MAX = 500
  var thumbRetries = new Map()
  function observeThumbs () {
    if (thumbObs) thumbObs.disconnect()
    thumbQueue = []
    thumbQueued = new Set()
    var nodes = el.view.querySelectorAll('[data-thumb]')
    if (!nodes.length) return
    if (!('IntersectionObserver' in window)) {
      nodes.forEach(function (n) { enqueueThumb(n) })
      return
    }
    thumbObs = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (!en.isIntersecting) return
        thumbObs.unobserve(en.target)
        enqueueThumb(en.target)
      })
    }, { root: el.view, rootMargin: '280px' })
    nodes.forEach(function (n) { thumbObs.observe(n) })
  }
  function enqueueThumb (node) {
    var id = node.getAttribute('data-thumb')
    if (!id || thumbQueued.has(id)) return
    thumbQueued.add(id)
    thumbQueue.push(node)
    pumpThumbs()
  }
  function scheduleThumbRetry (node) {
    var id = node.getAttribute('data-thumb')
    var n = (thumbRetries.get(id) || 0) + 1
    if (n > 8) return
    thumbRetries.set(id, n)
    setTimeout(function () {
      if (!id || !node.isConnected) return
      thumbQueued.delete(id)
      enqueueThumb(node)
    }, Math.min(8000, 700 * n))
  }
  function pumpThumbs () {
    while (thumbInFlight < THUMB_CONCURRENCY && thumbQueue.length) {
      var node = thumbQueue.shift()
      thumbInFlight++
      Promise.resolve(loadThumb(node)).then(function () {}, function () {}).then(function () {
        thumbInFlight--
        pumpThumbs()
      })
    }
  }
  function rememberE2eThumb (id, url) {
    if (e2eThumbCache.has(id)) {
      var prev = e2eThumbCache.get(id)
      if (prev && prev !== url) { try { URL.revokeObjectURL(prev) } catch (e) {} }
    }
    e2eThumbCache.set(id, url)
    while (e2eThumbCache.size > E2E_THUMB_CACHE_MAX) {
      var oldest = e2eThumbCache.keys().next().value
      var oldUrl = e2eThumbCache.get(oldest)
      e2eThumbCache.delete(oldest)
      try { URL.revokeObjectURL(oldUrl) } catch (e) {}
    }
  }
  function paintThumb (node, blobUrl, file) {
    return new Promise(function (resolve) {
      var img = new Image(); img.alt = ''
      img.onload = function () {
        node.innerHTML = ''
        node.appendChild(img)
        if (file) file.has_thumbnail = true
        resolve()
      }
      img.onerror = function () { resolve() }
      img.src = blobUrl
    })
  }
  async function loadThumb (node) {
    var id = node.getAttribute('data-thumb')
    var f = S.files.filter(function (x) { return String(x.id) === String(id) })[0]
    if (!f) return
    try {
      var blobUrl
      if (f.is_e2e) {
        if (!haveKeys() || !f.enc_thumb_nonce) return
        if (e2eThumbCache.has(id)) {
          blobUrl = e2eThumbCache.get(id)
        } else {
          var fk = f._fileKey || (await OneGyCrypto.unwrapFileKeyWithMasterKey(f.encrypted_file_key, f.file_key_nonce, await OneGyCrypto.getMasterKeyFromSession()))
          if (!fk) return
          var er = await fetch('/file/' + encodeURIComponent(id) + '/e2e-thumbnail')
          if (er.status === 429) { scheduleThumbRetry(node); return }
          if (!er.ok) return
          var enc = await er.arrayBuffer()
          if (!enc || enc.byteLength < 16) return
          var dec = await OneGyCrypto.decryptThumbnail(enc, f.enc_thumb_nonce, fk)
          blobUrl = URL.createObjectURL(new Blob([dec], { type: 'image/jpeg' }))
          rememberE2eThumb(id, blobUrl)
        }
      } else {
        await new Promise(function (resolve) {
          var img = new Image(); img.alt = ''
          img.onload = function () {
            node.innerHTML = ''
            node.appendChild(img)
            f.has_thumbnail = true
            resolve()
          }
          img.onerror = function () { scheduleThumbRetry(node); resolve() }
          img.src = '/file/' + encodeURIComponent(id) + '/thumbnail'
        })
        return
      }
      await paintThumb(node, blobUrl, f)
    } catch (e) {}
  }

  // ---- Selection -----------------------------------------------------------
  // Click = replace-select (highlight, no selbar). Double-click = open.
  // Checkbox / Ctrl / Shift / Ctrl+A = multi-select (filled ticks + selbar).
  function selClass (k) {
    var c = ''
    if (S.sel.has(k)) c += ' is-sel'
    if (S.sel.has(k) && S.multi) c += ' is-checked'
    if (S.lastFocus === k) c += ' is-focus'
    return c
  }
  function resetSelState () {
    S.sel.clear()
    S.multi = false
    S.lastFocus = null
    S.anchor = null
  }
  function listedKeys () {
    var keys = []
    sortItems(S.folders, true).forEach(function (f) { keys.push(keyOf(f, true)) })
    sortItems(S.files, false).forEach(function (f) { keys.push(keyOf(f, false)) })
    return keys
  }
  function infoFromKey (k) {
    if (!k) return null
    var isFolder = k[0] === 'd', id = k.slice(1)
    var src = isFolder ? S.folders : S.files
    var it = src.filter(function (x) { return String(x.id) === String(id) })[0]
    return it ? { item: it, isFolder: isFolder } : null
  }
  function markSel () {
    if (!el.view) return
    el.view.querySelectorAll('[data-k]').forEach(function (n) {
      var k = n.getAttribute('data-k')
      var on = S.sel.has(k)
      n.classList.toggle('is-sel', on)
      n.classList.toggle('is-checked', on && S.multi)
      n.classList.toggle('is-focus', k === S.lastFocus)
    })
  }
  function updateSelbar () {
    var bar = $('fxSelbar'), n = S.sel.size
    if (!bar) return
    $('fxSelCount').textContent = n
    bar.classList.toggle('is-open', !!(S.multi && n > 0))
  }
  function selectOnly (k) {
    if (!k) return
    S.sel = new Set([k])
    S.multi = false
    S.lastFocus = k
    S.anchor = k
    markSel(); updateSelbar()
  }
  function toggleSel (k, viaCheckbox) {
    if (!k) return
    if (viaCheckbox && S.sel.has(k) && !S.multi) {
      S.multi = true
    } else if (S.sel.has(k)) {
      S.sel.delete(k)
      if (!S.sel.size) S.multi = false
    } else {
      S.sel.add(k)
      S.multi = true
    }
    S.lastFocus = k
    S.anchor = k
    markSel(); updateSelbar()
  }
  function selectRange (from, to) {
    var keys = listedKeys()
    var i = keys.indexOf(from), j = keys.indexOf(to)
    if (j < 0) { selectOnly(to); return }
    if (i < 0) i = j
    if (i > j) { var t = i; i = j; j = t }
    S.sel = new Set(keys.slice(i, j + 1))
    S.multi = S.sel.size > 0
    S.lastFocus = to
    markSel(); updateSelbar()
  }
  function clearSel () {
    resetSelState()
    markSel(); updateSelbar()
  }
  function selectedItems () {
    var out = []
    S.sel.forEach(function (k) {
      var info = infoFromKey(k)
      if (info) out.push(info)
    })
    return out
  }
  function openItem (info) {
    if (!info || !info.item) return
    if (info.isFolder) loadFolder(info.item.id)
    else openPreview(info.item)
  }
  function isCoarsePointer () {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) } catch (e) { return false }
  }

  async function moveSidebarItem (raw, targetId) {
    var parts = raw.split(':'), type = parts.shift(), id = parts.join(':')
    if (!id || (type === 'folder' && targetId != null && String(id) === String(targetId))) return
    try {
      var response
      if (type === 'folder') {
        response = await fetch('/folder/' + encodeURIComponent(id) + '/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ target_folder_id: targetId == null ? null : parseInt(targetId, 10) })
        })
      } else {
        var fd = new FormData(); fd.append('folder_id', targetId == null ? '' : targetId); fd.append('csrf_token', csrf())
        response = await fetch('/file/' + encodeURIComponent(id) + '/move', { method: 'POST', body: fd, headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      }
      var data = await response.json().catch(function () { return {} })
      if (!response.ok) throw new Error(data.error || 'MOVE FAILED')
      // The move itself succeeded, but a file dropped into a link-shared folder
      // is undecryptable for recipients until its key is wrapped for the link.
      // genLinkKeys swallows per-file errors, so its result is the only signal.
      var linkRes = null
      if (type === 'folder' && data.needs_link_keys && data.ancestor_share_token && data.file_ids) linkRes = await genLinkKeys(data.file_ids, 'folder', data.ancestor_share_token)
      if (type === 'file' && data.needs_link_key && data.ancestor_share_token && data.file_id) linkRes = await genLinkKeys([data.file_id], 'folder', data.ancestor_share_token)
      if (linkRes && !linkRes.success) {
        var missed = Math.max((linkRes.total || 0) - (linkRes.keyed || 0), 1)
        toast('MOVED, BUT SHARE-LINK KEYS FAILED FOR ' + missed + ' OF ' + (linkRes.total || missed) + ' FILE(S) — RECIPIENTS CANNOT DECRYPT THEM' + (linkRes.error ? ' (' + linkRes.error + ')' : ''), 'error')
      } else toast('MOVED', 'success')
      if (type === 'folder') revealTreeBranch(targetId)
      loadFolder(S.folderId)
    } catch (e) { toast(e.message || 'MOVE FAILED', 'error') }
  }

  // ---- Move picker ---------------------------------------------------------
  var moveItemsPending = []
  var moveTarget = undefined
  function closeMoveModal () {
    var modal = $('bulkMoveModal')
    if (modal) { modal.classList.remove('rd-open'); modal.setAttribute('aria-hidden', 'true') }
    moveItemsPending = []; moveTarget = undefined
    var confirm = $('confirmMoveBtn'); if (confirm) confirm.disabled = true
  }
  function openMoveModal (items) {
    if (!items || !items.length) return
    moveItemsPending = items.slice(); moveTarget = undefined
    var selectedFolders = new Set(items.filter(function (it) { return it.isFolder }).map(function (it) { return String(it.item.id) }))
    var rows = '<button type="button" class="fx-move-row folder-tree-item" data-folder-id="root" role="option">' + ICON.folder + '<span>' + esc(S.rootName) + '</span></button>'
    sortItems(S.sidebar || [], true).forEach(function (folder) {
      var disabled = selectedFolders.has(String(folder.id))
      rows += '<button type="button" class="fx-move-row folder-tree-item" data-folder-id="' + folder.id + '" role="option"' + (disabled ? ' disabled' : '') + '>' + ICON.folder + '<span>' + esc(displayName(folder, true)) + '</span></button>'
    })
    $('moveFolderTree').innerHTML = rows
    var modal = $('bulkMoveModal'); modal.classList.add('rd-open'); modal.setAttribute('aria-hidden', 'false')
  }
  async function submitMove () {
    if (!moveItemsPending.length || moveTarget === undefined) return
    var files = [], folders = []
    moveItemsPending.forEach(function (it) { (it.isFolder ? folders : files).push(it.item.id) })
    var expected = files.length + folders.length
    var button = $('confirmMoveBtn'); button.disabled = true
    try {
      var response = await fetch('/bulk/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ file_ids: files, folder_ids: folders, target_folder_id: moveTarget })
      })
      var data = await response.json().catch(function () { return {} })
      if (!response.ok) throw new Error(data.error || 'MOVE FAILED')
      if (folders.length) revealTreeBranch(moveTarget)
      // Key whatever the server DID move before reporting a partial move: those
      // files already lost their previous folder-link keys.
      var linkRes = null
      if (data.needs_link_keys && data.ancestor_share_token && data.file_ids) linkRes = await genLinkKeys(data.file_ids, 'folder', data.ancestor_share_token)
      if (Number(data.moved) !== expected) throw new Error('ONLY ' + Number(data.moved || 0) + ' OF ' + expected + ' ITEMS MOVED')
      closeMoveModal(); clearSel()
      if (linkRes && !linkRes.success) {
        var missed = Math.max((linkRes.total || 0) - (linkRes.keyed || 0), 1)
        toast('MOVED, BUT SHARE-LINK KEYS FAILED FOR ' + missed + ' OF ' + (linkRes.total || missed) + ' FILE(S) — RECIPIENTS CANNOT DECRYPT THEM' + (linkRes.error ? ': ' + linkRes.error : ''), 'error')
      }
      else toast(expected === 1 ? 'MOVED' : ('MOVED ' + expected + ' ITEMS'), 'success')
      loadFolder(S.folderId)
    } catch (e) {
      button.disabled = false
      toast(String(e.message || 'MOVE FAILED').toUpperCase(), 'error')
      loadFolder(S.folderId, { keepSel: true })
    }
  }

  // ---- Details drawer ------------------------------------------------------
  function openDetails (item, isFolder) {
    var nm = displayName(item, isFolder)
    var body = $('fxDrawerBody')
    var prev = '<div class="fx-dpreview">' + (isFolder ? ICON.folder : ICON.file) + '</div>'
    if (!isFolder && canThumb(item)) prev = '<div class="fx-dpreview" data-thumb="' + item.id + '">' + ICON.file + '</div>'
    var rows = ''
    function row (k, v) { if (v == null || v === '') return; rows += '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>' }
    row('Type', isFolder ? 'Folder' : (extOf(item.name, item.extension) || 'file').toUpperCase())
    row('Size', isFolder ? ((item.file_count || 0) + ' items · ' + (item.size_formatted || '0 B')) : item.size_formatted)
    row('Modified', isFolder ? item.updated_at : item.upload_date)
    row('Encryption', item.is_e2e ? 'End-to-end' : (item.is_public ? 'Public link' : 'Private'))
    if (item.expires) row('Expires', item.expires.value + item.expires.unit)
    body.innerHTML = prev +
      '<div class="fx-dtitle">' + esc(nm) + '</div>' +
      '<dl class="fx-dl">' + rows + '</dl>' +
      '<div class="fx-drawer-actions">' +
      (isFolder ? '' : '<button class="rd-btn rd-btn-primary" data-act="download">Download</button>') +
      '<button class="rd-btn rd-btn-ghost" data-act="rename">Rename</button>' +
      '<button class="rd-btn rd-btn-ghost" data-act="delete" style="color:var(--bad)">Move to trash</button>' +
      '</div>'
    body.querySelectorAll('[data-act]').forEach(function (b) {
      b.onclick = function () { doAction(b.getAttribute('data-act'), item, isFolder) }
    })
    var drawer = $('fxDrawer'); drawer.classList.add('is-open'); drawer.setAttribute('aria-hidden', 'false')
    observeDrawerThumb(item)
  }
  function observeDrawerThumb (item) {
    var n = $('fxDrawerBody').querySelector('[data-thumb]'); if (n) loadThumb(n)
  }
  function closeDrawer () { var d = $('fxDrawer'); d.classList.remove('is-open'); d.setAttribute('aria-hidden', 'true') }

  // ---- Actions -------------------------------------------------------------
  function doAction (act, item, isFolder) {
    switch (act) {
      case 'open': isFolder ? loadFolder(item.id) : openDetails(item, false); break
      case 'download': isFolder ? toast('FOLDER DOWNLOAD COMING SOON', 'error') : download(item); break
      case 'details': openDetails(item, isFolder); break
      case 'rename': renameItem(item, isFolder); break
      case 'delete': deleteItems([{ item: item, isFolder: isFolder }]); break
    }
  }

  async function download (f) {
    var nm = displayName(f, false)
    if (!f.is_e2e) { triggerDownload('/f/' + f.id + '/' + encodeURIComponent(nm), nm); return }
    if (!haveKeys()) { toast('UNLOCK YOUR KEYS TO DOWNLOAD', 'error'); return }
    var t = toast('DECRYPTING ' + nm.toUpperCase(), 'info')
    try {
      var masterKey = await OneGyCrypto.getMasterKeyFromSession()
      var r = await fetch('/f/' + f.id + '/encrypted')
      if (!r.ok) throw new Error('fetch')
      var enc = await r.arrayBuffer()
      var dec = await OneGyCrypto.decryptFileForDownload(enc, f.encrypted_file_key, f.file_key_nonce, masterKey)
      var url = URL.createObjectURL(new Blob([dec], { type: 'application/octet-stream' }))
      triggerDownload(url, nm); setTimeout(function () { URL.revokeObjectURL(url) }, 4000)
    } catch (e) { toast('DOWNLOAD FAILED', 'error') }
  }
  function triggerDownload (url, name) {
    if (typeof url === 'string' && url.charAt(0) === '/') { window.location.href = url; return }
    var a = document.createElement('a'); a.href = url; a.download = name || 'file'; document.body.appendChild(a); a.click(); a.remove()
  }

  // Delete → trash (in the trash view this becomes a permanent delete)
  function deleteItems (list) {
    if (!list.length) return
    if (S.trashMode) { deleteForeverItems(list); return }
    var msg = list.length === 1 ? ('Move "' + displayName(list[0].item, list[0].isFolder) + '" to trash?') : ('Move ' + list.length + ' items to trash?')
    confirmThen('Move to trash', msg, 'Move to trash', async function () {
      // Every request is status-checked: reporting "MOVED TO TRASH" for items
      // still sitting in the folder is a lie the user acts on.
      var failed = 0, firstErr = ''
      for (var i = 0; i < list.length; i++) {
        var it = list[i]
        var url = it.isFolder ? ('/folder/' + it.item.id + '/delete') : ('/file/' + it.item.id + '/delete')
        try {
          var r = await fetch(url, { method: 'POST', headers: { 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' } })
          if (!r.ok) { failed++; if (!firstErr) firstErr = await errText(r) }
        } catch (e) { failed++; if (!firstErr) firstErr = 'NETWORK ERROR' }
      }
      closeDrawer()
      if (!failed) toast(list.length > 1 ? ('MOVED ' + list.length + ' ITEMS TO TRASH') : 'MOVED TO TRASH', 'success')
      else if (failed < list.length) toast('MOVED ' + (list.length - failed) + ' OF ' + list.length + ' ITEMS TO TRASH — ' + failed + ' FAILED' + (firstErr ? ': ' + firstErr : ''), 'error')
      else toast((list.length > 1 ? 'COULD NOT MOVE ITEMS TO TRASH' : 'COULD NOT MOVE TO TRASH') + (firstErr ? ': ' + firstErr : ''), 'error')
      S.trashMode ? loadTrash() : loadFolder(S.folderId, { fallbackRoot: true })
    })
  }

  // ---- Trash view actions (mirrors the notes trash menu) -------------------
  async function restoreItem (item, isFolder) {
    var url = isFolder ? ('/trash/restore-folder/' + item.id) : ('/trash/restore/' + item.id)
    try {
      var r = await fetch(url, { method: 'POST', headers: { 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' } })
      var d = await r.json()
      if (d && d.success) toast('RESTORED', 'success')
      else toast(((d && d.error) || 'RESTORE FAILED').toUpperCase(), 'error')
    } catch (e) { toast('RESTORE FAILED', 'error') }
    closeDrawer(); loadTrash()
  }
  function deleteForeverItems (list) {
    if (!list.length) return
    var msg = list.length === 1 ? ('Delete "' + displayName(list[0].item, list[0].isFolder) + '" forever? This cannot be undone.') : ('Delete ' + list.length + ' items forever? This cannot be undone.')
    confirmThen('Delete forever', msg, 'Delete forever', async function () {
      var fileIds = [], folderIds = []
      list.forEach(function (it) { (it.isFolder ? folderIds : fileIds).push(it.item.id) })
      try {
        // Claiming permanent destruction that did not happen (or staying silent
        // about one that did) is unacceptable in both directions — status-check.
        var r = await fetch('/trash/bulk-delete', {
          method: 'POST',
          headers: { 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_ids: fileIds, folder_ids: folderIds })
        })
        if (!r.ok) throw new Error(await errText(r))
        var d = null
        try { d = await r.json() } catch (e2) {}
        if (!d || d.success !== true) throw new Error(String((d && d.error) || 'DELETE FAILED').toUpperCase())
        toast(list.length > 1 ? ('DELETED ' + list.length + ' ITEMS FOREVER') : 'DELETED FOREVER', 'success')
      } catch (e) { toast('DELETE FAILED: ' + String(e.message || 'UNKNOWN ERROR').toUpperCase(), 'error') }
      S.sel.clear(); closeDrawer(); loadTrash()
    })
  }
  function emptyTrash () {
    // The listing failed to load: an empty S.files here means "unknown", not
    // "nothing to delete", so refuse instead of silently doing nothing.
    if (S.loadFailed) { toast('TRASH COULD NOT BE LOADED — RELOAD BEFORE EMPTYING IT', 'error'); return }
    if (!S.files.length && !S.folders.length) return
    confirmThen('Empty trash', 'Permanently delete everything in the trash? This cannot be undone.', 'Empty trash', async function () {
      try {
        var r = await fetch('/trash/empty', { method: 'POST', headers: { 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' } })
        if (!r.ok) throw new Error(await errText(r))
        var d = null
        try { d = await r.json() } catch (e2) {}
        if (!d || d.success !== true) throw new Error(String((d && d.error) || 'UNKNOWN ERROR').toUpperCase())
        toast('TRASH EMPTIED', 'success')
      } catch (e) { toast('COULD NOT EMPTY TRASH: ' + String(e.message || 'UNKNOWN ERROR').toUpperCase(), 'error') }
      S.sel.clear(); loadTrash()
    })
  }
  function restoreAll () {
    if (S.loadFailed) { toast('TRASH COULD NOT BE LOADED — RELOAD BEFORE RESTORING IT', 'error'); return }
    if (!S.files.length && !S.folders.length) return
    confirmThen('Restore all', 'Restore every item in the trash?', 'Restore all', async function () {
      try {
        var r = await fetch('/trash/restore-all', { method: 'POST', headers: { 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' } })
        if (!r.ok) throw new Error(await errText(r))
        var d = await r.json()
        if (!d || d.success !== true) throw new Error(String((d && d.error) || 'RESTORE FAILED').toUpperCase())
        toast('RESTORED ' + Number(d.restored || 0) + ' ITEMS', 'success')
        loadTrash()
      } catch (e) { toast('RESTORE FAILED: ' + String(e.message || 'UNKNOWN ERROR').toUpperCase(), 'error') }
    })
  }

  // Rename (E2E-aware)
  function renameItem (item, isFolder) {
    var cur = displayName(item, isFolder)
    openNameModal(isFolder ? 'Rename folder' : 'Rename file', cur, 'Save', async function (newName) {
      // Zero-knowledge invariant: sending a plaintext `name` for an E2EE item
      // leaks the filename to the server AND leaves the stale encrypted_name in
      // place, so the listing keeps showing the old name. Refuse instead.
      if (item.is_e2e && !haveKeys()) { toast('UNLOCK YOUR KEYS TO RENAME THIS ENCRYPTED ITEM', 'error'); return }
      try {
        var fd = new FormData(); fd.append('csrf_token', csrf())
        if (item.is_e2e) {
          var masterKey = await OneGyCrypto.getMasterKeyFromSession()
          if (isFolder) {
            var nk = await OneGyCrypto.unwrapFolderNameKey(item.encrypted_name_key, item.name_key_nonce, masterKey)
            var en = await OneGyCrypto.encryptFolderName(newName, nk)
            fd.append('name', 'encrypted'); fd.append('encrypted_name', en.encryptedName); fd.append('name_nonce', en.nameNonce)
          } else {
            var fk = item._fileKey || await OneGyCrypto.unwrapFileKeyWithMasterKey(item.encrypted_file_key, item.file_key_nonce, masterKey)
            var enf = await OneGyCrypto.encryptFileName(newName, fk)
            fd.append('name', 'encrypted'); fd.append('encrypted_name', enf.encryptedName); fd.append('name_nonce', enf.nameNonce)
            fd.append('stored_extension', OneGyCrypto.extractExtension(newName))
          }
        } else { fd.append('name', newName) }
        var url = isFolder ? ('/folder/' + item.id + '/rename') : ('/file/' + item.id + '/rename')
        var r = await fetch(url, { method: 'POST', body: fd, headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        if (!r.ok) throw new Error(await errText(r))
        toast('RENAMED', 'success'); closeDrawer(); loadFolder(S.folderId)
      } catch (e) { toast('RENAME FAILED' + (e && e.message ? ': ' + e.message : ''), 'error') }
    })
  }

  // New folder (E2E-aware)
  function newFolder (parentId, explicitParent) {
    var parent = explicitParent ? parentId : ((parentId != null) ? parentId : S.folderId)
    openNameModal('New folder', '', 'Create', async function (name) {
      try {
        var fd = new FormData(); fd.append('csrf_token', csrf())
        fd.append('parent_id', parent == null ? 'null' : parent)
        if (haveKeys()) {
          var masterKey = await OneGyCrypto.getMasterKeyFromSession()
          var nameKey = await OneGyCrypto.generateFolderNameKey()
          var enc = await OneGyCrypto.encryptFolderName(name, nameKey)
          var wrapped = await OneGyCrypto.wrapFolderNameKey(nameKey, masterKey)
          fd.append('name', 'encrypted')
          fd.append('encrypted_name', enc.encryptedName); fd.append('name_nonce', enc.nameNonce)
          fd.append('encrypted_name_key', wrapped.encryptedNameKey); fd.append('name_key_nonce', wrapped.nonce)
        } else { fd.append('name', name) }
        var r = await fetch('/folder/create', { method: 'POST', body: fd })
        if (!r.ok) throw new Error()
        revealTreeBranch(parent)
        toast('FOLDER CREATED', 'success'); loadFolder(S.folderId)
      } catch (e) { toast('COULD NOT CREATE FOLDER', 'error') }
    })
  }

  // ---- Upload (E2E, reuses OneGyCrypto) ------------------------------------
  var upQueue = []
  var upInFlight = 0
  var UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024
  var UPLOAD_MAX_LABEL = '2 GB'
  var UPLOAD_MAX_RETRIES = 3
  async function uploadFiles (fileList) {
    var files = Array.prototype.slice.call(fileList || [])
    if (!files.length) return
    // MUST return: without session keys uploadOne would fall through and POST
    // the plaintext File, which the server stores under server-side Fernet —
    // while the drop overlay promises end-to-end encryption.
    if (!haveKeys()) {
      // Reveal the unlock bar too — it is hidden when the folder holds no E2E
      // content, which would otherwise leave the user with no way to act.
      var lb = $('fxLockBar'); if (lb) lb.hidden = false
      toast('UNLOCK YOUR KEYS TO UPLOAD', 'error'); return
    }
    // Capture the destination ONCE. Encrypting a multi-GB file easily outlives
    // a folder navigation, and reading S.folderId at send time filed the upload
    // into whatever folder happened to be on screen when it finished.
    var destFolderId = S.folderId
    var tray = $('fxUptray')
    tray.classList.add('is-open')
    var list = $('fxUpList')
    var ok = 0, failed = 0, firstErr = ''
    upInFlight++
    updateUnloadGuard()
    try {
      for (var i = 0; i < files.length; i++) {
        var file = files[i]
        var rowId = 'up' + Date.now() + '_' + i
        var row = document.createElement('div'); row.className = 'fx-up-row'; row.id = rowId
        row.innerHTML = '<div class="fx-up-row-top"><span class="fx-name">' + esc(file.name) + '</span><span class="fx-up-pct">0%</span></div><div class="fx-up-bar"><div class="fx-up-bar-fill"></div></div>'
        list.insertBefore(row, list.firstChild)
        try { await uploadOne(file, row, destFolderId); ok++ } catch (e) { failed++; failRow(row, e && e.message); if (!firstErr) firstErr = String((e && e.message) || 'UPLOAD FAILED').toUpperCase() }
      }
    } finally {
      upInFlight = Math.max(0, upInFlight - 1)
      updateUnloadGuard()
    }
    if (!upInFlight) setSpin(false)   // another batch may still be running
    if (!failed) toast('UPLOAD COMPLETE', 'success')
    else {
      // The tray is collapsible — force it back open so the FAILED rows (and
      // their per-row reason) are actually on screen next to the toast.
      tray.classList.add('is-open')
      if (ok) toast('UPLOADED ' + ok + ' OF ' + files.length + ' FILES — ' + failed + ' FAILED' + (firstErr ? ': ' + firstErr : ''), 'error')
      else toast((files.length > 1 ? 'ALL ' + files.length + ' UPLOADS FAILED' : 'UPLOAD FAILED') + (firstErr ? ': ' + firstErr : ''), 'error')
    }
    // Only refresh if the user is still looking at the folder we uploaded into.
    if (!S.trashMode && String(S.folderId) === String(destFolderId)) loadFolder(destFolderId)
  }
  function setPct (row, p) { row.querySelector('.fx-up-bar-fill').style.width = p + '%'; row.querySelector('.fx-up-pct').textContent = Math.round(p) + '%' }
  function failRow (row, reason) {
    row.classList.add('is-err')
    row.querySelector('.fx-up-pct').textContent = 'FAILED'
    if (reason) row.title = String(reason)
  }
  function setSpin (on) { $('fxUpSpin').style.display = on ? '' : 'none'; $('fxUpTitle').textContent = on ? 'Uploading' : 'Done' }

  // A multi-GB transfer is silently aborted by a stray navigation otherwise.
  var unloadGuard = null
  function updateUnloadGuard () {
    if (upInFlight > 0 && !unloadGuard) {
      unloadGuard = function (e) { e.preventDefault(); e.returnValue = ''; return '' }
      window.addEventListener('beforeunload', unloadGuard)
    } else if (upInFlight <= 0 && unloadGuard) {
      window.removeEventListener('beforeunload', unloadGuard)
      unloadGuard = null
    }
  }

  async function uploadOne (file, row, destFolderId) {
    setSpin(true)
    // Never silently downgrade encryption: a file we cannot end-to-end encrypt
    // is rejected outright, never uploaded in the clear.
    if (!haveKeys()) throw new Error('ENCRYPTION KEYS ARE LOCKED')
    if (file.size > UPLOAD_MAX_BYTES) throw new Error('LARGER THAN THE ' + UPLOAD_MAX_LABEL + ' ENCRYPTED UPLOAD LIMIT')
    var uid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random())
    var masterKey = await OneGyCrypto.getMasterKeyFromSession()
    var fileKey = await OneGyCrypto.generateFileKey()
    // NOTE (memory): the whole plaintext plus its ciphertext are held in RAM
    // here (up to 2 x the file size). Streaming would change the chunk framing
    // that crypto.js / crypto-worker.js / cli_E2EE_binary/crypto.go all
    // implement byte-for-byte, so the buffering strategy is left alone.
    var buf = await file.arrayBuffer()
    var encData = await OneGyCrypto.encryptFileData(buf, fileKey, function (pct) { setPct(row, pct * 0.6) })
    var wrapped = await OneGyCrypto.wrapFileKeyWithMasterKey(fileKey, masterKey)
    var nameRes = await OneGyCrypto.encryptFileName(file.name, fileKey)
    var encFile = new File([encData], 'encrypted.bin', { type: 'application/octet-stream' })
    var thumb = null
    try {
      var tb = await OneGyCrypto.generateThumbnail(file)
      if (tb) { var td = await tb.arrayBuffer(); var et = await OneGyCrypto.encryptThumbnail(td, fileKey); thumb = { blob: new Blob([et.data], { type: 'application/octet-stream' }), nonce: et.nonce } }
    } catch (e) {}
    // A FormData cannot be re-sent once an XHR consumed it, so each attempt
    // gets a fresh one built from the SAME ciphertext. The file key is minted
    // once above and never partially consumed, so no retry re-encrypts with
    // half-used key material. Reusing upload_id keeps retries idempotent
    // server-side (_find_existing_upload_by_key).
    function buildForm () {
      var fd = new FormData()
      fd.append('e2e', 'true')
      fd.append('encrypted_file_key', wrapped.encryptedFileKey); fd.append('file_key_nonce', wrapped.nonce)
      fd.append('encrypted_name', nameRes.encryptedName); fd.append('name_nonce', nameRes.nameNonce)
      fd.append('stored_extension', OneGyCrypto.extractExtension(file.name))
      if (thumb) { fd.append('encrypted_thumbnail', thumb.blob, 'thumb.enc.jpg'); fd.append('thumbnail_nonce', thumb.nonce) }
      fd.append('files', encFile); fd.append('csrf_token', csrf())
      fd.append('file_id', uid); fd.append('upload_id', uid); fd.append('is_temp', 'false')
      if (destFolderId != null) fd.append('folder_id', destFolderId)
      return fd
    }
    // Bounded retry with exponential backoff, mirroring static/script.js.
    // 4xx is a client error (quota, validation) and is never retried.
    for (var attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
      try { await sendUpload(buildForm(), row); return } catch (err) {
        var retryable = !!(err && (err.retryable || (err.status && err.status >= 500)))
        if (!retryable || attempt === UPLOAD_MAX_RETRIES) throw err
        row.querySelector('.fx-up-pct').textContent = 'RETRY ' + attempt
        await new Promise(function (r) { setTimeout(r, Math.pow(2, attempt) * 1000) })
        setPct(row, 0)
      }
    }
  }

  function sendUpload (fd, row) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest()
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) setPct(row, 60 + (e.loaded / e.total) * 40) }
      xhr.onload = function () {
        if (xhr.status === 200) { setPct(row, 100); row.classList.add('is-done'); resolve(); return }
        var msg = 'UPLOAD FAILED (HTTP ' + xhr.status + ')'
        try { var d = JSON.parse(xhr.responseText); if (d && d.error) msg = String(d.error).toUpperCase() } catch (e) {}
        var err = new Error(msg); err.status = xhr.status; reject(err)
      }
      xhr.onerror = function () { var err = new Error('NETWORK ERROR DURING UPLOAD'); err.retryable = true; reject(err) }
      xhr.ontimeout = function () { var err = new Error('UPLOAD TIMED OUT'); err.retryable = true; reject(err) }
      // Header copy of upload_id: lets the server return an already-committed
      // upload on retry before the body is checked against remaining quota.
      xhr.open('POST', '/upload'); xhr.setRequestHeader('X-Upload-Id', fd.get('upload_id')); xhr.send(fd)
    })
  }

  // ---- File preview (image / text editor / media) --------------------------
  function openPreview (item) {
    var extension = extOf(item.name, item.extension)
    if (AUDIO_EXT[extension] && window.MusicPlayer && MusicPlayer.open) {
      MusicPlayer.open(String(item.id), displayName(item, false), extension, item.is_e2e === true, {
        folderId: S.folderId,
        tracks: S.files.map(function (file) {
          return {
            id: String(file.id), name: displayName(file, false),
            extension: extOf(file.name, file.extension), isE2E: file.is_e2e === true
          }
        })
      })
      return
    }
    if (window.FxPreview && FxPreview.open) FxPreview.open(item)
    else openDetails(item, false)
  }

  // ---- Right-click context menus (shared RdMenu component) -----------------
  var CI = {
    open: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="9" y1="14" x2="15" y2="14"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    manage: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    rename: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    restore: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    newfolder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
    upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>'
  }
  function fileMenu (f) {
    return [
      { label: 'Open', icon: CI.open, action: function () { openPreview(f) } },
      { sep: true },
      { label: 'Download', icon: CI.download, action: function () { download(f) } },
      { label: 'Copy link', icon: CI.link, action: function () { copyLink(f, false) } },
      { label: 'Manage', icon: CI.manage, action: function () { openManage(f, false, true) } },
      { label: 'Rename', icon: CI.rename, action: function () { renameItem(f, false) } },
      { sep: true },
      { label: 'Move to trash', icon: CI.trash, danger: true, action: function () { deleteItems([{ item: f, isFolder: false }]) } }
    ]
  }
  function folderMenu (f) {
    return [
      { label: 'Open', icon: CI.open, action: function () { loadFolder(f.id) } },
      { label: 'New subfolder', icon: CI.newfolder, action: function () { newFolder(f.id, true) } },
      { sep: true },
      { label: 'Copy link', icon: CI.link, action: function () { copyLink(f, true) } },
      { label: 'Manage', icon: CI.manage, action: function () { openManage(f, true, true) } },
      { label: 'Rename', icon: CI.rename, action: function () { renameItem(f, true) } },
      { sep: true },
      { label: 'Move to trash', icon: CI.trash, danger: true, action: function () { deleteItems([{ item: f, isFolder: true }]) } }
    ]
  }
  function emptyMenu () {
    return [
      { header: 'Create' },
      { label: 'New folder', icon: CI.newfolder, action: function () { newFolder() } },
      { label: 'Upload files', icon: CI.upload, action: function () { $('fxFileInput').click() } }
    ]
  }
  // Trash view menus — same shape as the notes trash menus
  function trashItemMenu (item, isFolder) {
    return [
      { label: 'Restore', icon: CI.restore, action: function () { restoreItem(item, isFolder) } },
      { sep: true },
      { label: 'Delete forever', icon: CI.trash, danger: true, action: function () { deleteForeverItems([{ item: item, isFolder: isFolder }]) } }
    ]
  }
  function trashEmptyMenu () {
    return [
      { header: 'Trash' },
      { label: 'Empty trash', icon: CI.trash, danger: true, disabled: !(S.files.length || S.folders.length), action: function () { emptyTrash() } }
    ]
  }
  function bulkMenu () {
    var items = selectedItems()
    var n = items.length
    if (S.trashMode) {
      return [
        { header: n + ' items' },
        { label: 'Restore', icon: CI.restore, action: function () {
          ;(async function () {
            var restored = 0, failures = []
            for (var i = 0; i < items.length; i++) {
              var it = items[i]
              var url = it.isFolder ? ('/trash/restore-folder/' + it.item.id) : ('/trash/restore/' + it.item.id)
              try {
                var r = await fetch(url, { method: 'POST', headers: { 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' } })
                var d = await r.json().catch(function () { return {} })
                if (!r.ok || d.success !== true) failures.push(displayName(it.item, it.isFolder) + ': ' + String(d.error || ('HTTP ' + r.status)).toUpperCase())
                else restored++
              } catch (e) {
                failures.push(displayName(it.item, it.isFolder) + ': NETWORK ERROR')
              }
            }
            if (!failures.length) toast('RESTORED ' + restored + ' ITEMS', 'success')
            else if (restored) toast('RESTORED ' + restored + ' OF ' + items.length + ' — FAILED: ' + failures.join('; '), 'error')
            else toast('RESTORE FAILED FOR ALL ' + items.length + ' ITEMS: ' + failures.join('; '), 'error')
            S.sel.clear()
            loadTrash()
          })()
        } },
        { sep: true },
        { label: 'Delete forever', icon: CI.trash, danger: true, action: function () { deleteForeverItems(items) } }
      ]
    }
    var hasFile = items.some(function (s) { return !s.isFolder })
    var menu = [{ header: n + ' items' }]
    if (hasFile) menu.push({ label: 'Download', icon: CI.download, action: function () { items.forEach(function (s) { if (!s.isFolder) download(s.item) }) } })
    menu.push({ sep: true })
    menu.push({ label: 'Move to trash', icon: CI.trash, danger: true, action: function () { deleteItems(items) } })
    return menu
  }
  function ctxOpen (x, y, info) {
    if (typeof RdMenu === 'undefined') { openManage(info.item, info.isFolder, true); return }
    var menu = S.trashMode
      ? trashItemMenu(info.item, info.isFolder)
      : (info.isFolder ? folderMenu(info.item) : fileMenu(info.item))
    RdMenu.open(x, y, menu)
  }
  function ctxOpenAt (x, y, info) {
    if (info && S.sel.size > 1 && S.sel.has(keyOf(info.item, info.isFolder))) {
      if (typeof RdMenu !== 'undefined') RdMenu.open(x, y, bulkMenu())
      return
    }
    ctxOpen(x, y, info)
  }
  async function copyLink (item, isFolder) {
    try {
      var url = isFolder ? ('/folder/' + item.id + '/manage-data') : ('/file/' + item.id + '/manage-data')
      var response = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (!response.ok) throw new Error('SHARE DETAILS UNAVAILABLE')
      var d = await response.json()
      var shared = isFolder ? (d.is_browsable || d.is_link_shared || d.inherited_browsable) : (d.is_public || d.is_link_shared || d.parent_is_browsable)
      if (!shared) { toast('ENABLE SHARING IN MANAGE TO GET A LINK', 'error'); return }
      if (d.is_e2e || d.is_e2e_encrypted || item.is_e2e) {
        toast('COPY THE COMPLETE ENCRYPTED LINK FROM MANAGE', 'error')
        return
      }
      var link = d.share_url || d.public_url || d.link || d.url || ''
      if (!link && d.share_token) link = window.location.origin + '/f/' + d.share_token
      if (!link) { toast('ENABLE SHARING IN MANAGE TO GET A LINK', 'error'); return }
      await navigator.clipboard.writeText(link); toast('LINK COPIED', 'success')
    } catch (e) { toast('COULD NOT COPY LINK', 'error') }
  }

  // ---- Manage / preview modal (reuse ManageModal engine) -------------------
  // Click = select, double-click = open (folder navigate / file preview),
  // right-click / kebab = manage (Settings).
  async function openManage (item, isFolder, manageTab) {
    if (typeof ManageModal === 'undefined' || !ManageModal.openFile) { openDetails(item, isFolder); return }
    try {
      if (isFolder) await ManageModal.openFolder(item.id); else await ManageModal.openFile(item.id)
      if (manageTab) { var t = document.querySelector('.manage-modal-tab[data-tab="settings"]'); if (t) t.click() }
    } catch (e) { openDetails(item, isFolder) }
  }
  function initManageModal () {
    if (typeof ManageModal === 'undefined' || !ManageModal.init) return
    ManageModal.init({
      showToast: window.showToast,
      showConfirm: window.showConfirm,
      getCSRFToken: csrf,
      domain: window.location.host,
      generateLinkKeysForFiles: genLinkKeys,
      onAfterSave: function () { loadFolder(S.folderId, { keepSel: true }) },
      onFileIdChanged: function () { loadFolder(S.folderId, { keepSel: true }) },
      onDelete: async function (type, data) {
        var ok = window.showConfirm
          ? await window.showConfirm((data && data.name ? data.name : 'THIS ITEM'), 'This will be moved to trash and auto-deleted after 48 hours.', 'DELETE')
          : window.confirm('Move to trash?')
        if (!ok) return
        ManageModal.close()
        var url = type === 'folder' ? ('/folder/' + data.id + '/delete') : ('/file/' + data.id + '/delete')
        try {
          var r = await fetch(url, { method: 'POST', headers: { 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' } })
          if (!r.ok) throw new Error(await errText(r))
          toast('MOVED TO TRASH', 'success')
        } catch (e) { toast('DELETE FAILED' + (e && e.message ? ': ' + e.message : ''), 'error') }
        loadFolder(S.folderId, { fallbackRoot: true })
      },
      onDownload: function (type, data) {
        ManageModal.close()
        if (type === 'folder') { toast('FOLDER DOWNLOAD COMING SOON', 'info'); return }
        var f = S.files.filter(function (x) { return String(x.id) === String(data.id) })[0] || data
        download(f)
      }
    })
  }
  // E2E share-link key generation (ported from dashboard.js so sharing E2E
  // content via the manage modal keeps working). Reuses OneGyCrypto only.
  async function genLinkKeys (fileIds, resourceType, resourceId) {
    if (!fileIds || !fileIds.length || !resourceId) return { success: true, keyed: 0, total: 0 }
    if (!haveKeys()) return { success: false, keyed: 0, total: fileIds.length, error: 'E2E KEYS NOT AVAILABLE' }
    try {
      var masterKey = await OneGyCrypto.getMasterKeyFromSession()
      if (!masterKey) return { success: false, keyed: 0, total: fileIds.length, error: 'E2E KEYS NOT AVAILABLE' }
      var ls = await OneGyCrypto.deriveLinkSecret(masterKey, resourceType, resourceId)
      var linkKey = ls.linkKey
      var token = csrf(), keyed = 0, keyMap = {}, firstError = ''
      try {
        var br = await fetch('/f/batch-key-info', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': token }, body: JSON.stringify({ file_ids: fileIds }) })
        if (br.ok) { keyMap = (await br.json()).keys || {} }
        else firstError = 'BATCH KEY LOAD HTTP ' + br.status
      } catch (e) { firstError = 'BATCH KEY LOAD FAILED' }
      for (var i = 0; i < fileIds.length; i++) {
        var fileId = fileIds[i]
        try {
          var keyInfo = keyMap[fileId]
          if (!keyInfo) {
            var kr = await fetch('/f/' + fileId + '/key-info')
            if (!kr.ok) { if (!firstError) firstError = 'FILE ' + fileId + ' KEY LOAD HTTP ' + kr.status; continue }
            keyInfo = await kr.json()
          }
          if (!keyInfo.encrypted_file_key) { if (!firstError) firstError = 'FILE ' + fileId + ' KEY NOT FOUND'; continue }
          var fileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey)
          var linkData = await OneGyCrypto.wrapFileKeyForLink(fileKey, linkKey)
          var sr = await fetch('/f/' + fileId + '/link-key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': token }, body: JSON.stringify({ encrypted_file_key: linkData.encryptedFileKey, file_key_nonce: linkData.nonce, scope: resourceType === 'folder' ? 'folder' : 'file' }) })
          if (sr.ok) keyed++
          else if (!firstError) firstError = 'FILE ' + fileId + ' LINK KEY HTTP ' + sr.status
        } catch (e) { if (!firstError) firstError = 'FILE ' + fileId + ' LINK KEY FAILED' }
      }
      return { success: keyed === fileIds.length, keyed: keyed, total: fileIds.length, error: firstError }
    } catch (e) { return { success: false, keyed: 0, total: fileIds.length, error: 'LINK KEY GENERATION FAILED' } }
  }

  // ---- Modals / confirm ----------------------------------------------------
  // (All right-click / kebab menus go through the shared RdMenu component —
  // the old page-local #fxMenu was removed so there is exactly one menu look.)
  var nameCb = null
  function openNameModal (title, val, btn, cb) {
    $('fxNameTitle').textContent = title
    var inp = $('fxNameInput'); inp.value = val || ''
    $('fxNameSave').textContent = btn || 'Save'
    nameCb = cb
    var mo = $('fxNameModal'); mo.classList.add('rd-open'); mo.setAttribute('aria-hidden', 'false')
    setTimeout(function () { inp.focus(); inp.select() }, 30)
  }
  function closeNameModal () { var mo = $('fxNameModal'); mo.classList.remove('rd-open'); mo.setAttribute('aria-hidden', 'true'); nameCb = null }
  function confirmThen (title, msg, okText, cb) {
    if (window.showConfirm) {
      var r = window.showConfirm(title, msg, okText)
      if (r && r.then) { r.then(function (ok) { if (ok) cb() }); return }
    }
    if (window.confirm(msg)) cb()
  }

  // ---- Event wiring --------------------------------------------------------
  function itemFrom (node) {
    // File ids are strings, folder ids are ints — always compare as strings.
    var isFolder = node.getAttribute('data-folder') === 'true', id = node.getAttribute('data-id')
    var src = isFolder ? S.folders : S.files
    return { item: src.filter(function (x) { return String(x.id) === String(id) })[0], isFolder: isFolder }
  }
  function wire () {
    el.view = $('fxView')

    // View region — click selects, double-click opens (folder / preview).
    // Checkbox, Ctrl/Cmd+click and Shift+click build a multi-selection.
    // Right-click / kebab = context menu (selects the target first).
    el.view.addEventListener('click', function (e) {
      if (e.target.closest('[data-sortcol]')) { var c = e.target.closest('[data-sortcol]').getAttribute('data-sortcol'); cycleSort(c); return }
      if (e.target.closest('[data-kebab]')) {
        var kb = e.target.closest('[data-kebab]')
        var cardK = kb.closest('[data-k]')
        if (!cardK) return
        var it = itemFrom(cardK)
        var kk = cardK.getAttribute('data-k')
        if (it.item && !S.sel.has(kk)) selectOnly(kk)
        var r = kb.getBoundingClientRect()
        ctxOpenAt(r.right, r.bottom, it)
        e.stopPropagation()
        return
      }
      if (e.target.closest('.fx-check')) {
        var n = e.target.closest('[data-k]')
        toggleSel(n.getAttribute('data-k'), true)
        return
      }
      var card = e.target.closest('[data-k]')
      if (!card) { if (S.sel.size) clearSel(); return }
      if (e.detail > 1) return
      var info = itemFrom(card)
      if (!info.item) return
      var k = card.getAttribute('data-k')
      if (isCoarsePointer()) { openItem(info); return }
      if (e.shiftKey) { selectRange(S.anchor || S.lastFocus || k, k); return }
      if (e.ctrlKey || e.metaKey) { toggleSel(k, false); return }
      selectOnly(k)
      if (S.view === 'columns') columnPreview(info.item, info.isFolder)
    })
    el.view.addEventListener('dblclick', function (e) {
      if (e.target.closest('.fx-check') || e.target.closest('[data-kebab]') || e.target.closest('[data-sortcol]')) return
      if (isCoarsePointer()) return
      var card = e.target.closest('[data-k]'); if (!card) return
      var info = itemFrom(card)
      if (info.item) openItem(info)
    })
    el.view.addEventListener('contextmenu', function (e) {
      if (e.target.closest('[data-sortcol]') || e.target.closest('.fx-list-head')) return
      e.preventDefault()
      var card = e.target.closest('[data-k]')
      if (card) {
        var info = itemFrom(card)
        if (!info.item) return
        var ck = card.getAttribute('data-k')
        if (!S.sel.has(ck)) selectOnly(ck)
        ctxOpenAt(e.clientX, e.clientY, info)
      } else if (typeof RdMenu !== 'undefined') { RdMenu.open(e.clientX, e.clientY, S.trashMode ? trashEmptyMenu() : emptyMenu()) }
    })
    el.view.addEventListener('dragstart', function (e) {
      var card = e.target.closest('[data-k]'); if (!card || !e.dataTransfer) return
      var info = itemFrom(card); if (!info.item) return
      var dk = card.getAttribute('data-k')
      if (!S.sel.has(dk)) selectOnly(dk)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', (info.isFolder ? 'folder:' : 'file:') + info.item.id)
      card.classList.add('is-dragging')
    })
    el.view.addEventListener('dragend', function (e) {
      var card = e.target.closest('[data-k]'); if (card) card.classList.remove('is-dragging')
      document.querySelectorAll('.fx-tree-row.is-drop-target').forEach(function (row) { row.classList.remove('is-drop-target') })
    })
    // Right-click a folder in the sidebar tree.
    $('fxTree').addEventListener('contextmenu', function (e) {
      var row = e.target.closest('.fx-tree-row'); if (!row) return
      e.preventDefault()
      var fid = row.getAttribute('data-fid')
      if (!fid) { if (typeof RdMenu !== 'undefined') RdMenu.open(e.clientX, e.clientY, emptyMenu()); return }
      var f = S.sidebar.filter(function (x) { return String(x.id) === String(fid) })[0]
      if (f && typeof RdMenu !== 'undefined') RdMenu.open(e.clientX, e.clientY, folderMenu(f))
    })
    $('fxTree').addEventListener('dragover', function (e) {
      var row = e.target.closest('.fx-tree-row'); if (!row || !e.dataTransfer) return
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'
      document.querySelectorAll('.fx-tree-row.is-drop-target').forEach(function (item) { if (item !== row) item.classList.remove('is-drop-target') })
      row.classList.add('is-drop-target')
    })
    $('fxTree').addEventListener('dragleave', function (e) {
      var row = e.target.closest('.fx-tree-row'); if (row && !row.contains(e.relatedTarget)) row.classList.remove('is-drop-target')
    })
    $('fxTree').addEventListener('drop', function (e) {
      var row = e.target.closest('.fx-tree-row'); if (!row || !e.dataTransfer) return
      e.preventDefault(); row.classList.remove('is-drop-target')
      var raw = e.dataTransfer.getData('text/plain'); if (!/^(file|folder):/.test(raw)) return
      var targetId = row.getAttribute('data-fid') || null
      moveSidebarItem(raw, targetId)
    })

    // Toolbar
    $('fxViewSeg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-view]'); if (!b) return
      S.view = b.getAttribute('data-view')
      try { localStorage.setItem('onegy_files_view', S.view) } catch (e2) {}
      $('fxViewSeg').querySelectorAll('.fx-seg-btn').forEach(function (x) { x.classList.toggle('is-active', x === b) })
      render()
    })
    $('fxSort').addEventListener('change', function () { S.sort = this.value; render() })
    // Must wrap: assigning newFolder directly passes the click PointerEvent as
    // `parentId`, which is non-null, so it is sent as parent_id and the server
    // rejects the request with 400 "Invalid parent folder". Call it with no
    // arguments so it falls back to S.folderId, matching the context-menu path.
    $('fxNewFolder').onclick = function () { newFolder() }
    $('fxUploadBtn').onclick = function () { $('fxFileInput').click() }
    $('fxFileInput').onchange = function () { uploadFiles(this.files); this.value = '' }

    // Search — collapsed icon that expands into a live field on click
    var to = null
    var sBox = $('fxSearchBox'), sInput = $('fxSearch'), sToggle = $('fxSearchToggle'), sClear = $('fxSearchClear')
    function openSearch () {
      sBox.classList.add('is-open')
      sToggle.setAttribute('aria-expanded', 'true')
      sInput.tabIndex = 0
      setTimeout(function () { sInput.focus() }, 30)
    }
    function closeSearch (reload) {
      sBox.classList.remove('is-open')
      sToggle.setAttribute('aria-expanded', 'false')
      sInput.tabIndex = -1
      var had = sInput.value.trim()
      sInput.value = ''
      sClear.hidden = true
      clearTimeout(to)
      if (had && reload !== false) loadFolder(S.folderId)
    }
    // Keep the input from blurring first when the icon is used to collapse it
    sToggle.addEventListener('mousedown', function (e) { if (sBox.classList.contains('is-open')) e.preventDefault() })
    sToggle.onclick = function () { sBox.classList.contains('is-open') ? closeSearch() : openSearch() }
    sClear.onclick = function () { sInput.value = ''; sClear.hidden = true; clearTimeout(to); loadFolder(S.folderId); sInput.focus() }
    sInput.addEventListener('input', function () {
      var q = this.value.trim(); clearTimeout(to)
      sClear.hidden = !q
      to = setTimeout(function () { q ? doSearch(q) : loadFolder(S.folderId) }, 260)
    })
    sInput.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); sToggle.focus() } })
    sInput.addEventListener('blur', function () { if (!sInput.value.trim()) closeSearch(false) })

    // Sidebar / trash
    $('fxTrashBtn').onclick = function () { closeSide(); loadTrash() }
    $('fxSideToggle').onclick = function () {
      var open = $('fxSide').classList.toggle('is-open')
      $('fxSideScrim').classList.toggle('is-open', open)
      this.setAttribute('aria-expanded', open ? 'true' : 'false')
    }
    $('fxSideScrim').onclick = closeSide
    mobileViewMedia.addEventListener('change', normalizeMobileView)

    // Selection bar
    $('fxSelClear').onclick = function () { clearSel() }
    $('fxSelDelete').onclick = function () { deleteItems(selectedItems()) }
    $('fxSelDownload').onclick = function () { selectedItems().forEach(function (s) { if (!s.isFolder) download(s.item) }) }
    $('fxSelMove').onclick = function () { openMoveModal(selectedItems()) }
    $('moveFolderTree').addEventListener('click', function (e) {
      var row = e.target.closest('[data-folder-id]'); if (!row || row.disabled) return
      var raw = row.getAttribute('data-folder-id')
      moveTarget = raw === 'root' ? null : parseInt(raw, 10)
      this.querySelectorAll('.fx-move-row').forEach(function (item) { item.classList.toggle('is-selected', item === row); item.setAttribute('aria-selected', item === row ? 'true' : 'false') })
      $('confirmMoveBtn').disabled = false
    })
    $('confirmMoveBtn').onclick = submitMove
    document.querySelectorAll('#bulkMoveModal [data-move-close]').forEach(function (item) { item.onclick = closeMoveModal })
    $('restoreAllBtn').onclick = restoreAll

    // Drawer
    $('fxDrawerClose').onclick = closeDrawer

    // E2EE unlock
    $('fxUnlockForm').addEventListener('submit', async function (e) {
      e.preventDefault()
      var pw = $('fxUnlockPw').value; if (!pw) return
      var btn = this.querySelector('button'); btn.disabled = true
      var ok = false
      try { ok = await unlockKeys(pw) } catch (err) { ok = false }
      btn.disabled = false
      if (ok) { $('fxUnlockPw').value = ''; $('fxLockBar').hidden = true; toast('ENCRYPTION KEYS UNLOCKED', 'success'); loadFolder(S.folderId) }
      else toast('INCORRECT PASSWORD', 'error')
    })

    // Name modal
    $('fxNameSave').onclick = function () { var v = $('fxNameInput').value.trim(); if (!v) return; var cb = nameCb; closeNameModal(); if (cb) cb(v) }
    $('fxNameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('fxNameSave').click() })
    document.querySelectorAll('#fxNameModal [data-rd-modal-close]').forEach(function (b) { b.onclick = closeNameModal })
    $('fxUpClose').onclick = function () { $('fxUptray').classList.remove('is-open') }

    // Global: ESC (RdMenu dismisses itself), arrows, Enter, Space, Delete, Ctrl+A
    document.addEventListener('keydown', function (e) {
      if (filesKeysBlocked(e)) return
      if (e.key === 'Escape') { closeSide(); closeDrawer(); if (S.sel.size) clearSel(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!S.sel.size) return
        e.preventDefault()
        deleteItems(selectedItems())
        return
      }
      if (e.key === 'Enter') {
        var info = infoFromKey(S.lastFocus)
        if (!info && S.sel.size === 1) info = selectedItems()[0]
        if (info) { e.preventDefault(); openItem(info) }
        return
      }
      if (e.key === ' ') {
        if (!S.lastFocus) return
        e.preventDefault()
        toggleSel(S.lastFocus, true)
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        moveFocus(e)
      }
    })

    // Drag & drop upload
    var dropOverlay = $('fxDrop'), dragDepth = 0
    window.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { dragDepth++; dropOverlay.classList.add('is-active'); $('fxDropDest').textContent = 'to ' + (currentFolderLabel()) + ' — end-to-end encrypted' } })
    window.addEventListener('dragover', function (e) { if (dropOverlay.classList.contains('is-active')) e.preventDefault() })
    window.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOverlay.classList.remove('is-active') })
    window.addEventListener('drop', function (e) {
      if (dropOverlay.classList.contains('is-active')) { e.preventDefault(); dragDepth = 0; dropOverlay.classList.remove('is-active'); if (e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files) }
    })
  }
  function currentFolderLabel () { return S.folderId == null ? S.rootName : (S.breadcrumbs.length ? displayName(S.breadcrumbs[S.breadcrumbs.length - 1], true) : 'this folder') }
  function closeSide () { $('fxSide').classList.remove('is-open'); $('fxSideScrim').classList.remove('is-open'); $('fxSideToggle').setAttribute('aria-expanded', 'false') }
  function normalizeMobileView () {
    if (!mobileViewMedia.matches || (S.view !== 'gallery' && S.view !== 'columns')) return
    S.view = 'grid'
    $('fxViewSeg').querySelectorAll('.fx-seg-btn').forEach(function (x) { x.classList.toggle('is-active', x.getAttribute('data-view') === S.view) })
    render()
  }
  function filesKeysBlocked (e) {
    var t = e.target
    if (t && (t.isContentEditable || /input|textarea|select/i.test(t.tagName))) return true
    if (document.querySelector('#previewModal.preview-visible')) return true
    if (document.querySelector('.manage-modal-visible')) return true
    if (document.querySelector('.rd-cmenu.is-open')) return true
    if (document.querySelector('#ucmOverlay.ucm-visible')) return true
    var nm = $('fxNameModal'); if (nm && nm.classList.contains('rd-open')) return true
    var lock = $('fxLockBar'); if (lock && !lock.hidden) return true
    return false
  }
  function gridColCount () {
    var g = el.view && el.view.querySelector('.fx-grid')
    if (!g || !g.children.length) return 1
    var top = g.children[0].offsetTop, n = 1
    for (var i = 1; i < g.children.length; i++) {
      if (g.children[i].offsetTop !== top) break
      n++
    }
    return Math.max(1, n)
  }
  function moveFocus (e) {
    var keys = listedKeys()
    if (!keys.length) return
    var idx = S.lastFocus ? keys.indexOf(S.lastFocus) : -1
    if (idx < 0) idx = 0
    else {
      var step = 1
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && S.view === 'grid') step = gridColCount()
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') idx -= step
      else idx += step
      if (idx < 0) idx = 0
      if (idx >= keys.length) idx = keys.length - 1
    }
    var k = keys[idx]
    if (e.shiftKey) selectRange(S.anchor || S.lastFocus || k, k)
    else if (e.ctrlKey || e.metaKey) { S.lastFocus = k; markSel() }
    else selectOnly(k)
    var node = el.view && el.view.querySelector('[data-k="' + k + '"]')
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' })
    if (S.view === 'columns') {
      var inf = infoFromKey(k)
      if (inf) columnPreview(inf.item, inf.isFolder)
    }
  }
  function selectAll () {
    S.sel = new Set()
    S.folders.forEach(function (f) { S.sel.add('d' + f.id) })
    S.files.forEach(function (f) { S.sel.add('f' + f.id) })
    S.multi = S.sel.size > 0
    var keys = listedKeys()
    S.lastFocus = keys[0] || null
    S.anchor = S.lastFocus
    markSel(); updateSelbar()
  }
  function cycleSort (col) {
    var map = { name: ['name', 'name-desc'], size: ['size', 'size-asc'], date: ['date', 'date-asc'] }
    if (!map[col]) return
    S.sort = (S.sort === map[col][0]) ? map[col][1] : map[col][0]
    $('fxSort').value = S.sort; render()
  }

  // Search runs in the browser: E2EE names only exist encrypted on the server,
  // so /search could never match them. The index (every live file + folder) is
  // fetched and decrypted once per search session; loadFolder/loadTrash drop it,
  // and every mutation reloads through one of those.
  var searchIndex = null
  function loadSearchIndex () {
    if (searchIndex) return searchIndex
    var p = searchIndex = (async function () {
      var r = await fetch('/search/index', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      // An unchecked error body would render as "No matches" — a failed search
      // must never look like a search that found nothing.
      if (!r.ok) throw new Error('HTTP ' + r.status)
      var d = await r.json()
      var files = d.files || [], folders = d.folders || []
      await decryptNames(files, folders)
      // Folder tiles show recursive item counts, as /files/list does.
      var byId = {}
      folders.forEach(function (f) { f.file_count = 0; f.size = 0; byId[f.id] = f })
      files.forEach(function (f) {
        for (var anc = byId[f.folder_id], depth = 0; anc && depth < 64; anc = byId[anc.parent_id], depth++) { anc.file_count++; anc.size += f.size || 0 }
      })
      return { files: files, folders: folders }
    })()
    p.catch(function () { if (searchIndex === p) searchIndex = null })
    return p
  }

  async function doSearch (q) {
    var seq = newLoad()
    // The index holds live items only, so leave trash mode (as loadFolder does):
    // trash-only actions such as Delete forever must not be offered on them.
    if (S.trashMode) {
      S.trashMode = false; resetSelState()
      var restoreAllBtn = $('restoreAllBtn'); if (restoreAllBtn) restoreAllBtn.hidden = true
      $('fxNewFolder').hidden = false; $('fxUploadBtn').hidden = false
    }
    skeleton()
    try {
      var idx = await loadSearchIndex()
      if (stale(seq)) return
      var needle = q.toLowerCase()
      // An E2EE name that did not decrypt is a server placeholder — never match it.
      var hit = function (item, isFolder) { return (!item.is_e2e || item._dec) && displayName(item, isFolder).toLowerCase().indexOf(needle) >= 0 }
      S.loadFailed = false
      S.folders = idx.folders.filter(function (f) { return hit(f, true) })
      S.files = idx.files.filter(function (f) { return hit(f, false) })
      S.breadcrumbs = []
      renderBreadcrumb()
      el.view.setAttribute('data-view', S.view)
      if (!S.folders.length && !S.files.length) { el.view.innerHTML = '<div class="fx-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><h3>No matches</h3><p>Nothing found for “' + esc(q) + '”.</p></div>'; return }
      render()
    } catch (e) {
      if (stale(seq)) return
      S.loadFailed = true
      S.folders = []; S.files = []
      el.view.innerHTML = errorState('Search failed — this is not an empty result. Try again.')
    }
  }

  // ---- Mock hook (headless screenshots only) -------------------------------
  window.__fxMock = function (data) {
    el.view = $('fxView')
    S.folders = data.folders || []; S.files = data.files || []
    S.breadcrumbs = data.breadcrumbs || []; S.sidebar = data.sidebar_folders || []
    S.rootName = data.root_folder_name || 'FILES'
    if (data.view) { S.view = data.view; $('fxViewSeg').querySelectorAll('.fx-seg-btn').forEach(function (x) { x.classList.toggle('is-active', x.getAttribute('data-view') === S.view) }) }
    renderStorage(data); renderTrashCount(data.trash_count || 0)
    renderSidebar(); renderBreadcrumb(); render()
    if (data.selected) {
      data.selected.forEach(function (k) { S.sel.add(k) })
      S.multi = S.sel.size > 1
      S.lastFocus = data.selected[0] || null
      S.anchor = S.lastFocus
      markSel(); updateSelbar()
    }
  }

  // ---- Cleanup hook --------------------------------------------------------
  // Single exported hook so an SPA re-mount of this IIFE tears the previous
  // instance's window-level listeners down (the beforeunload upload guard and
  // the thumbnail observer) instead of stacking them.
  function onPopState (e) {
    if (e.state && e.state.fx) loadFolder(e.state.folderId, { noPush: true })
  }
  function cleanup () {
    upInFlight = 0
    updateUnloadGuard()
    if (thumbObs) { try { thumbObs.disconnect() } catch (e) {} thumbObs = null }
    thumbQueue = []
    thumbQueued = new Set()
    thumbInFlight = 0
    mobileViewMedia.removeEventListener('change', normalizeMobileView)
    window.removeEventListener('popstate', onPopState)
  }
  if (window.FxFiles && window.FxFiles.cleanup) { try { window.FxFiles.cleanup() } catch (e) {} }
  window.FxFiles = { cleanup: cleanup }
  window.addEventListener('popstate', onPopState)

  // ---- Boot ----------------------------------------------------------------
  function boot () {
    el.view = $('fxView')
    try {
      var v = localStorage.getItem('onegy_files_view')
      if (v) S.view = v
      if (mobileViewMedia.matches && (S.view === 'gallery' || S.view === 'columns')) S.view = 'grid'
      $('fxViewSeg').querySelectorAll('.fx-seg-btn').forEach(function (x) { x.classList.toggle('is-active', x.getAttribute('data-view') === S.view) })
    } catch (e) {}
    wire()
    initManageModal()
    if (window.MusicPlayer && MusicPlayer.init) MusicPlayer.init('dashboard')
    if (window.FxPreview) FxPreview._onSaved = function () { loadFolder(S.folderId, { keepSel: true }) }
    if (!window.__FX_NO_AUTOLOAD__) {
      // /trash renders this same page and asks for the trash view up front, so
      // the legacy dashboard.html trash screen is no longer needed.
      if (window.__FX_INITIAL_TRASH__) { loadTrash(); return }
      var init = window.__FX_INITIAL_FOLDER__
      history.replaceState({ fx: true, folderId: init != null ? init : null }, '')
      loadFolder(init != null ? init : null, { noPush: true })
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
