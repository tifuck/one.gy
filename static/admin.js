/* ============================================================================
   admin.js — Admin console controller (UI v2).
   Fetches the existing /admin/api/* endpoints and renders the v2 console with
   the shared primitives (.rd-page-head, .rd-panel, .rd-table, .rd-field,
   .rd-pill, .rd-empty). Not E2E. Destructive actions confirm first.

   AUDIT FIX A13: every mutating call now reports the SERVER'S outcome. The
   user delete / toggle-admin routes used to answer with a 302 that fetch()
   followed transparently, so a failed delete still toasted 'USER DELETED'.
   AUDIT FIX A14: the notification trigger options now match the server's
   valid_triggers set exactly ('once' and 'session' were never valid and always
   400'd; four supported triggers had no UI at all).
   AUDIT FIX A15: storage-node management (add / edit / test / set-primary /
   enable / remove / purge-local / retry-errors) and the replication tuning
   endpoints are wired up here instead of requiring hand-crafted curl.

   Class names are a contract with testsv2/pages/admin_page.py (.adm-tiles,
   .adm-tile-label/-val, .adm-card + .adm-h3 + .adm-meter-fill, .adm-table,
   .sn-node-card, .sn-node-count-label text, input[data-setting], the #adm* ids).
   ========================================================================== */
(function () {
  'use strict'
  var S = { tab: 'overview', renderEpoch: 0, stats: null, usersPage: 1, usersQ: '', users: [], selectedUserId: null, drawerEnter: false, focusUser: null, restoreUserSearch: false, settingsDirty: false, tempPage: 1, fbPage: 1, fbQ: '', purgeTimer: null }
  var $ = function (id) { return document.getElementById(id) }
  var panel

  function svg (d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>' }
  var I = {
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'),
    shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>'),
    users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
    hourglass: svg('<path d="M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>'),
    bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    msg: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    db: svg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>')
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  var SKELETON = '<div class="adm-loading" role="status" aria-label="Loading"><span class="rd-skel adm-skel-title"></span><span class="rd-skel adm-skel-sub"></span><span class="rd-skel adm-skel-block"></span><span class="rd-skel adm-skel-block is-short"></span></div>'

  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function csrf () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : '' }
  function toast (m, c) { if (window.showToast) window.showToast(m, c) }
  function failToast (e, fallback) { toast((e && e.message) ? e.message : (fallback || 'FAILED'), 'error') }
  function hdr (json) { var h = { 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' }; if (json) h['Content-Type'] = 'application/json'; return h }
  async function jget (u) {
    var r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!r.ok) { var e = {}; try { e = await r.json() } catch (x) {} throw new Error(e.error || ('HTTP ' + r.status)) }
    return r.json()
  }
  async function jsend (m, u, body, form) {
    var o = { method: m, headers: hdr(!form) }
    if (body) o.body = form ? body : JSON.stringify(body)
    var r = await fetch(u, o)
    var data = {}
    try { data = await r.json() } catch (x) {}
    // The server answers AJAX callers with JSON on EVERY path now, so an error
    // is never mistaken for success (AUDIT FIX A13).
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status))
    if (data && data.error) throw new Error(data.error)
    return data
  }
  // o: { title, ok, icon, safe } — safe confirms use the accent variant
  // instead of the red delete look.
  function confirmThen (msg, cb, o) {
    o = o || {}
    if (window.showConfirm) {
      var p = window.showConfirm(o.title || 'Confirm', msg, o.ok || 'Confirm', o.icon || (o.safe ? I.info : undefined), o.safe ? 'confirm-warn' : undefined)
      if (p && p.then) { p.then(function (ok) { if (ok) cb() }); return }
    }
    if (window.confirm(msg)) cb()
  }
  function fmtBytes (b) { if (!b) return '0 B'; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(b) / Math.log(1024)); return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i] }
  // Formats the server's 'YYYY-MM-DD[ HH:MM]' strings as-is (no timezone shift).
  function fmtDate (s, withTime) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''))
    if (!m) return s ? String(s) : 'Unknown'
    return MONTHS[+m[2] - 1] + ' ' + m[3] + ', ' + m[1] + (withTime && m[4] ? ', ' + m[4] + ':' + m[5] : '')
  }
  function num (v) { return Number(v || 0).toLocaleString() }
  function plural (n, word) { return num(n) + ' ' + word + (Number(n) === 1 ? '' : 's') }
  function cap (s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1) }
  // Server preset labels are upper-case; show them in sentence case.
  function sentence (s) { return cap(String(s || '').toLowerCase()) }

  // ---- Markup helpers (shared v2 primitives) --------------------------------
  function pill (text, tone, dot) { return '<span class="rd-pill' + (tone ? ' is-' + tone : '') + (dot ? ' is-dot' : '') + '">' + esc(text) + '</span>' }
  function head (title, sub, actions) {
    return '<header class="rd-page-head adm-head"><h1 class="rd-page-title">' + esc(title) + '</h1>' +
      (sub ? '<p class="rd-page-sub">' + sub + '</p>' : '') +
      (actions ? '<div class="rd-page-actions">' + actions + '</div>' : '') + '</header>'
  }
  // o: { sub, extra (head-right html), foot (html), flush, cls }
  function card (title, body, o) {
    o = o || {}
    return '<section class="rd-panel adm-card' + (o.cls ? ' ' + o.cls : '') + '">' +
      '<header class="rd-panel-head"><div><h2 class="rd-panel-title adm-h3">' + esc(title) + '</h2>' + (o.sub ? '<p class="rd-panel-sub">' + o.sub + '</p>' : '') + '</div>' + (o.extra || '') + '</header>' +
      '<div class="rd-panel-body' + (o.flush ? ' is-flush' : '') + '">' + body + '</div>' +
      (o.foot ? '<footer class="rd-panel-foot">' + o.foot + '</footer>' : '') + '</section>'
  }
  function kvs (pairs) {
    return '<dl class="adm-kvs">' + pairs.map(function (p) { return '<div class="adm-kv"><dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd></div>' }).join('') + '</dl>'
  }
  function field (id, label, control, hint) {
    return '<div class="rd-field"><label class="rd-field-label" for="' + id + '">' + esc(label) + '</label>' + control + (hint ? '<p class="rd-field-hint">' + esc(hint) + '</p>' : '') + '</div>'
  }
  function searchBox (id, label, placeholder, value) {
    return '<label class="adm-search" for="' + id + '"><span class="sr-only">' + esc(label) + '</span>' + I.search +
      '<input id="' + id + '" type="search" placeholder="' + esc(placeholder) + '" value="' + esc(value) + '" autocomplete="off"></label>'
  }
  function emptyState (icon, title, text) {
    return '<div class="rd-empty adm-empty"><span class="rd-empty-icon">' + icon + '</span><h3 class="rd-empty-title">' + esc(title) + '</h3>' + (text ? '<p class="rd-empty-text">' + esc(text) + '</p>' : '') + '</div>'
  }
  function emptyRow (cols, icon, title, text) { return '<tr class="adm-empty-tr"><td colspan="' + cols + '" class="adm-empty-row">' + emptyState(icon, title, text) + '</td></tr>' }
  // text: optional visible label, shown only where the button sits in a
  // wrapping action row (mobile node cards)
  function iconBtn (attrs, label, text) { return '<button class="rd-icon-btn adm-icon-btn adm-icon-danger" ' + attrs + ' title="' + esc(label) + '" aria-label="' + esc(label) + '">' + I.trash + (text ? '<span class="adm-icon-text" aria-hidden="true">' + esc(text) + '</span>' : '') + '</button>' }

  // Refreshes keep the current content (dimmed, inert) until the new data
  // arrives, so actions do not flash the tab or reset the scroll position. A
  // tab switch starts from a skeleton.
  function loading () {
    panel.setAttribute('aria-busy', 'true')
    if (panel.getAttribute('data-shown') === S.tab) { panel.classList.add('is-busy'); return }
    panel.classList.remove('is-busy')
    panel.innerHTML = SKELETON
  }
  function paint (html) {
    panel.innerHTML = html
    panel.classList.remove('is-busy'); panel.removeAttribute('aria-busy')
    panel.setAttribute('data-shown', S.tab)
  }
  function errState (m) {
    return '<div class="rd-empty adm-empty"><span class="rd-empty-icon">' + I.alert + '</span><h3 class="rd-empty-title">' + esc(m) + '</h3>' +
      '<p class="rd-empty-text">The request failed. Check the server log, then try again.</p><button class="rd-btn rd-btn-ghost" data-retry>Try again</button></div>'
  }
  function clearPurgeTimer () { if (S.purgeTimer) { clearInterval(S.purgeTimer); S.purgeTimer = null } }
  function clearSearchTimers () { clearTimeout(S._ut); clearTimeout(S._ft); S._ut = null; S._ft = null }
  function isCurrentRender (tab, epoch) { return S.tab === tab && S.renderEpoch === epoch }
  function startRender (tab, epoch) {
    if (S.tab !== tab) return null
    if (epoch == null) epoch = ++S.renderEpoch
    return isCurrentRender(tab, epoch) ? epoch : null
  }
  function refreshTab (tab, epoch) {
    if (!isCurrentRender(tab, epoch)) return
    var nextEpoch = ++S.renderEpoch
    ;(TABS[tab] || tabOverview)(nextEpoch)
  }

  // ---- Overview ------------------------------------------------------------
  async function tabOverview (epoch) {
    epoch = startRender('overview', epoch); if (epoch == null) return
    loading()
    try {
      var d = await jget('/admin/api/stats'); if (!isCurrentRender('overview', epoch)) return; S.stats = d
      var o = d.overview || {}, st = d.storage || {}
      var rep = d.replication || {}
      var rc = rep.config || d.replication_config || {}
      var ro = rep.overview || {}
      function tile (label, val, sub) { return '<div class="adm-tile"><div class="adm-tile-label">' + esc(label) + '</div><div class="adm-tile-val">' + esc(val) + '</div>' + (sub ? '<div class="adm-tile-sub">' + esc(sub) + '</div>' : '') + '</div>' }
      var tiles = '<div class="adm-tiles">' +
        tile('Users', num(o.total_users), num(o.admin_users) + ' admin · ' + num(o.regular_users) + ' regular') +
        tile('Files', num(o.total_files), num(o.registered_files) + ' stored · ' + num(o.temp_files) + ' temp') +
        tile('Folders', num(o.total_folders), 'Across all accounts') +
        tile('Downloads', num(o.total_downloads), plural(o.unique_visitors, 'unique visitor')) +
        '</div>'
      var diskPct = st.disk_percent || 0
      var storage = card('Storage',
        '<div class="adm-gauge"><b>' + esc(diskPct) + '%</b><span>of disk used · ' + esc(st.disk_free_gb || 0) + ' GB free of ' + esc(st.disk_total_gb || 0) + ' GB</span></div>' +
        '<div class="adm-meter"><div class="adm-meter-fill' + (diskPct >= 90 ? ' is-bad' : diskPct >= 75 ? ' is-warn' : '') + '" style="width:' + diskPct + '%"></div></div>' +
        kvs([['Stored files', esc(st.total_file_size_gb || 0) + ' GB'], ['Temp payload', esc(st.temp_file_size_gb || 0) + ' GB']]),
        { extra: '<span class="adm-meta">' + esc(st.app_used_gb || 0) + ' GB tracked</span>' })
      var repl = card('Replication',
        kvs([
          ['Nodes', num(ro.nodes) + ' · ' + num(ro.online_nodes) + ' online'],
          ['Pending items', num(ro.pending_items)],
          ['Errored items', num(ro.error_items)],
          ['Speed', esc(sentence(rc.speed || 'None'))],
          ['Source', esc(sentence(String(rc.source || 'None').replace(/_/g, ' ')))],
          ['Workers', esc(rc.workers || 'None')],
          ['Checksum verify', rc.checksum ? 'On' : 'Off']
        ]),
        { extra: pill(ro.fully_synced ? 'In sync' : 'Work pending', ro.fully_synced ? 'good' : 'warn', true),
          foot: '<button class="rd-btn rd-btn-sm rd-btn-ghost" data-goto="storage">Open storage</button>' })
      paint(head('Overview', 'Accounts, content and storage health at a glance.') +
        '<div class="adm-stack">' + tiles + '<div class="adm-grid2">' + storage + repl + '</div></div>')
    } catch (e) { if (isCurrentRender('overview', epoch)) paint(errState('Could not load statistics')) }
  }

  // ---- Users ---------------------------------------------------------------
  function quotaParts (gb) {
    gb = Number(gb) || 0
    if (gb >= 1024) return { amount: Math.round(gb / 1024 * 1000) / 1000, unit: 'TB' }
    if (gb < 1) return { amount: Math.round(gb * 1024 * 1000) / 1000, unit: 'MB' }
    return { amount: Math.round(gb * 1000) / 1000, unit: 'GB' }
  }
  function userTone (u) {
    var pct = Number(u.storage_percent) || 0
    return u.over_quota || pct >= 100 ? ' is-bad' : pct >= 80 ? ' is-warn' : ''
  }
  function securityLabel (u) {
    return (u.two_factor_enabled ? '2FA on' : '2FA off') + ' · ' +
      (u.has_e2ee_keys ? 'E2EE ready' : 'E2EE pending') + ' · ' +
      num(u.active_api_key_count) + ' API key' + (Number(u.active_api_key_count) === 1 ? '' : 's')
  }
  function securityPills (u) {
    var keys = Number(u.active_api_key_count) || 0
    return '<span class="adm-pills" title="' + esc(securityLabel(u)) + '">' +
      (u.two_factor_enabled ? pill('2FA', 'good') : pill('No 2FA')) +
      (u.has_e2ee_keys ? '' : pill('E2EE pending', 'warn')) +
      (keys ? pill(plural(keys, 'key')) : '') + '</span>'
  }
  function avatar (u, big) {
    return '<span class="adm-avatar' + (big ? ' is-lg' : '') + '" style="background:' + esc(u.avatar_color || 'var(--accent)') + '" aria-hidden="true">' + esc(String(u.username || '?').charAt(0).toUpperCase()) + '</span>'
  }
  function quotaMarkup (u, compact) {
    var pct = Math.max(0, Math.min(100, Number(u.storage_percent) || 0))
    var label = u.over_quota ? 'Over quota' : Math.round(Number(u.storage_percent) || 0) + '%'
    return '<div class="adm-quota' + (compact ? ' is-compact' : '') + '">' +
      '<div class="adm-quota-line"><span><b>' + fmtBytes(u.storage_used_bytes) + '</b> of ' + fmtBytes(u.storage_limit_bytes) + '</span><span class="adm-quota-pct' + userTone(u) + '">' + label + '</span></div>' +
      '<div class="adm-meter" role="progressbar" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(Number(u.storage_percent) || 0) + '"><div class="adm-meter-fill' + userTone(u) + '" style="width:' + pct + '%"></div></div></div>'
  }
  function userManager (u) {
    if (!u) return ''
    var q = quotaParts(u.storage_limit_gb)
    function fact (v, label) { return '<div><b>' + num(v) + '</b><span>' + label + '</span></div>' }
    return '<div class="adm-drawer-scrim" data-user-close></div>' +
      '<section class="adm-account-manager adm-drawer' + (S.drawerEnter ? ' is-enter' : '') + '" role="dialog" aria-modal="true" aria-labelledby="admAccountTitle" tabindex="-1">' +
      '<header class="adm-drawer-head">' + avatar(u, true) +
        '<div class="adm-drawer-id"><h2 id="admAccountTitle">' + esc(u.username) + '</h2><p>' + esc(u.email || 'No email address') + ' · #' + u.id + '</p></div>' +
        '<button class="rd-icon-btn adm-icon-btn" data-user-close aria-label="Close account manager" title="Close">' + I.x + '</button></header>' +
      '<div class="adm-drawer-body">' +
        '<div class="adm-facts">' + fact(u.file_count, 'Files') + fact(u.folder_count, 'Folders') + fact(u.note_count, 'Notes') + fact(u.login_count, 'Logins') + '</div>' +
        '<section class="adm-drawer-sec"><div class="adm-drawer-sec-head"><h3>Storage allowance</h3><span class="adm-meta">' + fmtBytes(u.storage_remaining_bytes) + ' available</span></div>' + quotaMarkup(u, false) +
          '<div class="rd-field"><label class="rd-field-label" for="admQuotaAmount">New limit</label><div class="adm-quota-control">' +
            '<input class="form-input" id="admQuotaAmount" type="number" min="0.001" step="0.001" value="' + q.amount + '">' +
            '<select class="form-input" id="admQuotaUnit" aria-label="Storage unit"><option value="MB"' + (q.unit === 'MB' ? ' selected' : '') + '>MB</option><option value="GB"' + (q.unit === 'GB' ? ' selected' : '') + '>GB</option><option value="TB"' + (q.unit === 'TB' ? ' selected' : '') + '>TB</option></select>' +
            '<button class="rd-btn rd-btn-primary" id="admQuotaSave" data-user-id="' + u.id + '">Update</button></div>' +
          '<p class="rd-field-hint" id="admQuotaHint">Limits block new uploads when reached; existing data is never deleted.</p></div></section>' +
        '<section class="adm-drawer-sec"><div class="adm-drawer-sec-head"><h3>Access and security</h3></div>' +
          kvs([
            ['Role', u.is_admin ? pill('Administrator', 'accent') : 'User'],
            ['Member since', esc(fmtDate(u.created_at))],
            ['Two-factor authentication', u.two_factor_enabled ? pill('Enabled', 'good') : 'Not enabled'],
            ['Encryption setup', u.has_e2ee_keys ? pill('Ready', 'good') : pill('Incomplete', 'warn')],
            ['Authentication', Number(u.split_key_version) > 0 ? 'Split-key' : 'Legacy'],
            ['Active API keys', num(u.active_api_key_count)]
          ]) +
          '<div class="adm-drawer-actions"><button class="rd-btn rd-btn-ghost" data-user-admin="' + u.id + '" data-name="' + esc(u.username) + '" data-is-admin="' + (u.is_admin ? '1' : '0') + '">' + (u.is_admin ? 'Remove admin role' : 'Make administrator') + '</button>' +
          '<button class="rd-btn rd-btn-ghost" data-user-revoke="' + u.id + '" data-name="' + esc(u.username) + '">Sign out everywhere</button></div></section>' +
        '<section class="adm-drawer-sec adm-danger"><div><h3>Delete account</h3><p>Destroy this account and all of its files, notes and folders.</p></div>' +
          '<button class="rd-btn rd-btn-danger" data-user-del="' + u.id + '" data-name="' + esc(u.username) + '">Delete account</button></section>' +
      '</div></section>'
  }
  async function tabUsers (epoch) {
    epoch = startRender('users', epoch); if (epoch == null) return
    loading()
    try {
      // NOTE: the server reads ?search= (this used to send ?q=, so the search
      // box silently did nothing).
      var d = await jget('/admin/api/users?page=' + S.usersPage + '&per_page=25' + (S.usersQ ? '&search=' + encodeURIComponent(S.usersQ) : ''))
      if (!isCurrentRender('users', epoch)) return
      S.users = d.users || []
      var selected = S.users.find(function (u) { return String(u.id) === String(S.selectedUserId) })
      if (S.selectedUserId && !selected) S.selectedUserId = null
      var rows = (d.users || []).map(function (u) {
        return '<tr' + (String(u.id) === String(S.selectedUserId) ? ' class="is-selected"' : '') + '>' +
          '<td class="is-trunc"><div class="adm-user">' + avatar(u) + '<div class="adm-user-text"><div class="adm-user-name"><b>' + esc(u.username) + '</b>' + (u.is_admin ? pill('Admin', 'accent') : '') + '</div>' +
            '<div class="adm-user-sub">' + esc(u.email || 'No email') + ' · #' + u.id + '</div></div></div></td>' +
          '<td data-label="Storage">' + quotaMarkup(u, true) + '</td>' +
          '<td data-label="Content" class="adm-hide-sm"><div class="adm-cell-main">' + plural(u.file_count, 'file') + '</div><div class="adm-cell-sub">' + plural(u.folder_count, 'folder') + ' · ' + plural(u.note_count, 'note') + (u.trashed_file_count ? ' · ' + num(u.trashed_file_count) + ' trashed' : '') + '</div></td>' +
          '<td data-label="Security">' + securityPills(u) + '</td>' +
          '<td data-label="Joined" class="adm-nowrap adm-dim adm-hide-sm">' + esc(fmtDate(u.created_at)) + '</td>' +
          '<td class="is-actions"><button class="rd-btn rd-btn-sm rd-btn-ghost adm-manage-btn" data-user-manage="' + u.id + '">Manage</button></td></tr>'
      }).join('')
      var shown = (d.users || []).length
      paint(head('Accounts', 'Review quota use, security posture and account-level controls.', searchBox('admUserSearch', 'Search accounts', 'Search name or email', S.usersQ)) +
        '<section class="rd-panel adm-users"><div class="rd-panel-body is-flush"><div class="rd-table-wrap"><table class="rd-table adm-table is-stack">' +
        '<thead><tr><th>Account</th><th>Storage</th><th>Content</th><th>Security</th><th>Joined</th><th class="is-actions"><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        (rows || emptyRow(6, I.users, 'No matching accounts', S.usersQ ? 'Nothing matches “' + S.usersQ + '”. Try a shorter name or an email address.' : '')) + '</tbody></table></div></div>' +
        '<footer class="rd-panel-foot adm-foot"><span class="adm-meta">' + num(shown) + ' of ' + (S.usersQ ? num(d.total) + (Number(d.total) === 1 ? ' match' : ' matches') : plural(d.total, 'account')) + '</span>' + pager(d.page, d.pages, 'users') + '</footer></section>' +
        userManager(selected))
      if (S.restoreUserSearch) {
        S.restoreUserSearch = false
        var search = $('admUserSearch'); if (search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length) }
      }
      if (selected) {
        S.drawerEnter = false
        var dr = panel.querySelector('.adm-drawer'); if (dr && !dr.contains(document.activeElement)) dr.focus({ preventScroll: true })
      } else if (S.focusUser) {
        var back = panel.querySelector('[data-user-manage="' + S.focusUser + '"]'); S.focusUser = null
        if (back) back.focus({ preventScroll: true })
      }
    } catch (e) { if (isCurrentRender('users', epoch)) paint(errState('Could not load accounts')) }
  }
  function closeManager () { S.focusUser = S.selectedUserId; S.selectedUserId = null; refreshTab('users', S.renderEpoch) }
  function pager (page, pages, kind) {
    if (!pages || pages <= 1) return ''
    return '<div class="adm-pager"><span class="adm-meta">Page ' + page + ' of ' + pages + '</span>' +
      '<button class="rd-btn rd-btn-sm rd-btn-ghost" data-page="' + kind + ':' + Math.max(1, page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button class="rd-btn rd-btn-sm rd-btn-ghost" data-page="' + kind + ':' + Math.min(pages, page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>Next</button></div>'
  }

  // ---- Temp files ----------------------------------------------------------
  async function tabTemp (epoch) {
    epoch = startRender('temp-files', epoch); if (epoch == null) return
    loading()
    try {
      var d = await jget('/admin/api/temp-files?page=' + S.tempPage + '&per_page=25')
      if (!isCurrentRender('temp-files', epoch)) return
      var rows = (d.files || []).map(function (f) {
        var name = f.orig_name || 'Unnamed'
        return '<tr><td class="is-trunc"><div class="adm-cell-flex"><span class="adm-ellipsis" title="' + esc(name) + '">' + esc(name) + '</span>' + (f.has_password ? pill('Password') : '') + '</div></td>' +
          '<td class="is-num" data-label="Size">' + fmtBytes(f.size) + '</td>' +
          '<td data-label="Owner" class="adm-nowrap adm-hide-sm' + (f.user_id ? '' : ' adm-dim') + '">' + esc(f.user_id || 'Anonymous') + '</td>' +
          '<td class="is-num" data-label="Downloads">' + num(f.download_count) + (f.max_downloads ? ' / ' + num(f.max_downloads) : '') + '</td>' +
          '<td data-label="Uploaded" class="adm-nowrap adm-dim">' + esc(fmtDate(f.upload_time, true)) + '</td>' +
          '<td class="is-actions">' + iconBtn('data-temp-del="' + esc(f.id) + '"', 'Delete ' + name) + '</td></tr>'
      }).join('')
      var pg = pager(d.page, d.pages, 'temp')
      paint(head('Temp files', 'Anonymous Quick Share uploads. Cleanup removes the ones that have expired.', '<button class="rd-btn rd-btn-ghost" id="admCleanup">' + I.refresh + 'Run cleanup</button>') +
        '<section class="rd-panel"><div class="rd-panel-body is-flush"><div class="rd-table-wrap"><table class="rd-table adm-table is-stack">' +
        '<thead><tr><th>Filename</th><th class="is-num">Size</th><th>Owner</th><th class="is-num">Downloads</th><th>Uploaded</th><th class="is-actions"><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        (rows || emptyRow(6, I.hourglass, 'No temporary files', 'Quick Share uploads show up here until they expire.')) + '</tbody></table></div></div>' +
        (d.total ? '<footer class="rd-panel-foot adm-foot"><span class="adm-meta">' + plural(d.total, 'file') + '</span>' + pg + '</footer>' : '') + '</section>')
    } catch (e) { if (isCurrentRender('temp-files', epoch)) paint(errState('Could not load temp files')) }
  }

  // ---- Notifications -------------------------------------------------------
  // AUDIT FIX A14: these values are exactly the server's valid_triggers set.
  var TRIGGERS = [
    ['always', 'Always show until dismissed'],
    ['on_register', 'Once, right after registration'],
    ['first_login', 'Once, on the very first login'],
    ['every_login', 'Once per login session'],
    ['once_login', 'Once per login, signed-in users only']
  ]
  function triggerLabel (v) {
    for (var i = 0; i < TRIGGERS.length; i++) { if (TRIGGERS[i][0] === v) return TRIGGERS[i][1] }
    return v || 'always'
  }
  function triggerOptions (selected) {
    return TRIGGERS.map(function (t) {
      return '<option value="' + t[0] + '"' + (t[0] === selected ? ' selected' : '') + '>' + esc(t[1]) + '</option>'
    }).join('')
  }
  async function tabNotifs (epoch) {
    epoch = startRender('notifications', epoch); if (epoch == null) return
    loading()
    try {
      var d = await jget('/admin/api/notifications')
      if (!isCurrentRender('notifications', epoch)) return
      var arr = Array.isArray(d) ? d : (d.notifications || [])
      var rows = arr.map(function (n) {
        return '<li class="adm-notif' + (n.is_active ? '' : ' is-off') + '"><span class="adm-notif-swatch" style="background:' + esc(n.bg_color || 'var(--accent)') + '" aria-hidden="true"></span>' +
          '<div class="adm-notif-main"><div class="adm-notif-title"><b>' + esc(n.title || 'Banner') + '</b>' + (n.is_active ? pill('Active', 'good', true) : pill('Off')) + '</div>' +
          '<p class="adm-notif-msg">' + esc(n.message || '') + '</p>' +
          '<div class="adm-notif-meta">' + esc(triggerLabel(n.display_trigger)) +
          (n.auto_dismiss && n.dismiss_seconds ? ' · auto-dismiss after ' + n.dismiss_seconds + ' s' : '') +
          (n.expires_at ? ' · expires ' + esc(fmtDate(n.expires_at)) : '') + '</div></div>' +
          '<div class="adm-notif-actions"><button class="rd-btn rd-btn-sm rd-btn-ghost" data-notif-toggle="' + n.id + '">' + (n.is_active ? 'Disable' : 'Enable') + '</button>' +
          iconBtn('data-notif-del="' + n.id + '"', 'Delete banner') + '</div></li>'
      }).join('')
      var form = card('New banner',
        '<div class="adm-form-grid">' +
          field('admNotifTitle', 'Title', '<input class="form-input" id="admNotifTitle" placeholder="Optional" maxlength="120">') +
          field('admNotifTrigger', 'Display', '<select class="form-input" id="admNotifTrigger">' + triggerOptions('always') + '</select>') +
        '</div>' +
        field('admNotifMsg', 'Message', '<textarea class="form-input" id="admNotifMsg" placeholder="What should people see?" rows="2" maxlength="500"></textarea>') +
        '<div class="adm-form-grid is-3">' +
          // NOTE: this is banner CONTENT (persisted as Notification.bg_color), not a
          // theme token. It matches the server-side default so the picker and the
          // stored fallback cannot disagree.
          field('admNotifColor', 'Color', '<input type="color" class="adm-color" id="admNotifColor" value="#de1833">') +
          field('admNotifExpires', 'Expires', '<input class="form-input" id="admNotifExpires" type="datetime-local">', 'Optional') +
          '<div class="rd-field"><span class="rd-field-label">Auto-dismiss</span><div class="adm-inline"><label class="rd-check"><input type="checkbox" id="admNotifAuto"> After</label>' +
          '<input class="form-input adm-num-input" id="admNotifSeconds" type="number" min="1" max="3600" value="10" aria-label="Seconds before the banner closes"><span class="adm-unit">seconds</span></div></div>' +
        '</div>',
        { sub: 'Banners overlay the full nav bar on every page.', foot: '<button class="rd-btn rd-btn-primary" id="admNotifCreate">Create banner</button>' })
      var help = '<div class="rd-callout">' + I.info + '<div><b>Always show until dismissed</b> stays until ×, then never again. ' +
        '<b>Once per login session</b> stays until ×, then comes back on the next login. ' +
        'Register and first-login banners show in that window until ×, then never again.</div></div>'
      var list = card('Banners', rows ? '<ul class="adm-notif-list">' + rows + '</ul>' : emptyState(I.bell, 'No banners yet', 'Banners you create show up here.'),
        { flush: true, extra: '<span class="adm-meta">' + plural(arr.length, 'banner') + '</span>' })
      paint(head('Notifications', 'Announcement banners for everyone who visits the site.') + '<div class="adm-stack">' + form + help + list + '</div>')
    } catch (e) { if (isCurrentRender('notifications', epoch)) paint(errState('Could not load notifications')) }
  }

  async function tabFeedback (epoch) {
    epoch = startRender('feedback', epoch); if (epoch == null) return
    loading()
    try {
      var d = await jget('/admin/api/prompt-feedback?page=' + S.fbPage + '&per_page=25' + (S.fbQ ? '&search=' + encodeURIComponent(S.fbQ) : ''))
      if (!isCurrentRender('feedback', epoch)) return
      var rows = (d.items || []).map(function (f) {
        var kind = f.kind === 'prompt' ? 'Prompt' : 'General'
        return '<tr>' +
          '<td data-label="When" class="adm-nowrap adm-dim">' + esc(fmtDate(f.created_at, true)) + '</td>' +
          '<td data-label="Kind">' + pill(kind, f.kind === 'prompt' ? 'accent' : '') + '</td>' +
          '<td data-label="Prompt" class="adm-nowrap' + (f.prompt_id ? '' : ' adm-dim') + '">' + esc(f.prompt_id || 'None') + '</td>' +
          '<td data-label="From" class="adm-nowrap">' + esc(f.username || 'Guest') + '</td>' +
          '<td class="adm-fb-msg" title="' + esc(f.message || '') + '">' + esc(f.message || '') + '</td>' +
          '<td class="is-actions">' + iconBtn('data-fb-del="' + f.id + '"', 'Delete feedback') + '</td>' +
          '</tr>'
      }).join('')
      var pg = pager(d.page, d.pages, 'feedback')
      paint(head('Feedback', plural(d.total || 0, 'submission') + ' · one per IP per minute', searchBox('admFbSearch', 'Search feedback', 'Search feedback', S.fbQ)) +
        '<section class="rd-panel"><div class="rd-panel-body is-flush"><div class="rd-table-wrap"><table class="rd-table adm-table is-stack">' +
        '<thead><tr><th>When</th><th>Kind</th><th>Prompt</th><th>From</th><th>Message</th><th class="is-actions"><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        (rows || emptyRow(6, I.msg, S.fbQ ? 'No matching feedback' : 'No feedback yet', S.fbQ ? 'Try a different search.' : 'Messages sent from the prompts pages show up here.')) + '</tbody></table></div></div>' +
        (pg ? '<footer class="rd-panel-foot">' + pg + '</footer>' : '') + '</section>')
    } catch (e) { if (isCurrentRender('feedback', epoch)) paint(errState('Could not load feedback')) }
  }

  // ---- Settings ------------------------------------------------------------
  async function tabSettings (epoch) {
    epoch = startRender('settings', epoch); if (epoch == null) return
    loading()
    try {
      var s = await jget('/admin/api/settings')
      if (!isCurrentRender('settings', epoch)) return
      function tog (key, label, desc) {
        return '<div class="rd-field-row"><div class="rd-field-text"><label class="rd-field-label" for="admSet_' + key + '">' + esc(label) + '</label><p class="rd-field-hint">' + esc(desc) + '</p></div>' +
          '<input type="checkbox" class="rd-switch" role="switch" id="admSet_' + key + '" data-setting="' + key + '"' + (s[key] ? ' checked' : '') + '></div>'
      }
      // scale: stored units per displayed unit (e.g. 3600 shows a seconds setting in hours)
      function numRow (key, label, desc, min, max, step, unit, scale) {
        scale = scale || 1
        return '<div class="rd-field-row"><div class="rd-field-text"><label class="rd-field-label" for="admSet_' + key + '">' + esc(label) + '</label><p class="rd-field-hint">' + esc(desc) + '</p></div>' +
          '<div class="adm-inline"><input class="form-input adm-num-input" type="number" id="admSet_' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" data-setting-num="' + key + '" data-scale="' + scale + '" value="' + (s[key] != null ? s[key] / scale : '') + '"><span class="adm-unit">' + esc(unit) + '</span></div></div>'
      }
      S.settingsDirty = false
      paint('<div class="adm-narrow">' +
        head('Settings', 'Control account access, public features and automated retention.', '<span class="adm-dirty">Unsaved changes</span><button class="rd-btn rd-btn-primary" id="admSaveSettings" disabled>Save changes</button>') +
        '<div class="adm-stack">' +
        card('Access and features',
          tog('allow_registration', 'Open registration', 'Allow new accounts to sign up.') +
          tog('allow_temp_uploads', 'Quick Share', 'Enable anonymous temporary uploads.') +
          tog('allow_music', 'Music', 'Show the Music section.') +
          tog('allow_api_keys', 'API keys', 'Let users create programmatic API keys.') +
          tog('captcha_enabled', 'Captcha', 'Require captcha on sensitive actions.') +
          tog('welcome_folder_enabled', 'Welcome folder', 'Seed new accounts with a welcome folder.'),
          { sub: 'Applied across the service as soon as you save.' }) +
        card('Limits and retention',
          numRow('temp_max_gb', 'Temporary upload limit', 'Maximum size for one anonymous upload.', 0.01, 1024, 0.01, 'GB') +
          numRow('storage_cache_ttl_minutes', 'Staging cache lifetime', 'How long local staging/cache copies (repl_, .cache_, temp files; in cache mode, fully replicated local payloads) are kept before cleanup. Temp files are never removed before 30 minutes.', 1, 10080, 1, 'minutes') +
          numRow('trash_retention_hours', 'Trash retention', 'Time before trashed content is permanently purged.', 1, 8760, 1, 'hours'),
          { sub: 'Bound temporary content and background housekeeping.' }) +
        card('Desktop sync',
          tog('allow_desktop_sync', 'Desktop sync', 'Let ONE.GY Desktop sign in and sync. Turning it off stops every device.') +
          numRow('max_devices_per_user', 'Devices per account', 'Maximum desktop devices one account can sign in.', 1, 100, 1, 'devices') +
          numRow('sync_tombstone_retention_days', 'Deletion history', 'How long deletions are kept for devices to catch up. A device offline longer re-scans its folders.', 1, 3650, 1, 'days') +
          numRow('sync_upload_session_ttl', 'Unfinished upload lifetime', 'How long an interrupted large upload can resume before its parts are deleted.', 1, 720, 1, 'hours', 3600),
          { sub: 'Applies to the desktop app’s connection to this server.' }) +
        card('File versions',
          numRow('file_version_retention_count', 'Versions per file', 'How many previous versions of a file are kept when its content is replaced. 0 turns versions off and deletes the existing ones.', 0, 100, 1, 'versions') +
          numRow('file_version_retention_days', 'Version lifetime', 'Versions older than this are deleted. 0 keeps them until the per-file limit is reached.', 0, 3650, 1, 'days'),
          { sub: 'Versions count toward each account’s storage. Users can turn them off in Devices.' }) +
        '<div class="rd-callout is-warn">' + I.alert + '<div><b>Permanent deletion.</b> Retention is measured from each item’s trash date. Purged content cannot be recovered.</div></div>' +
        '</div></div>')
    } catch (e) { if (isCurrentRender('settings', epoch)) paint(errState('Could not load settings')) }
  }

  // ---- Storage -------------------------------------------------------------
  var SPEEDS = null, SOURCES = null, WORKERS = null, HEALTH = null
  var TYPE_LABEL = { local: 'Local disk', ssh: 'SSH', s3: 'S3' }

  function nodeState (n) {
    if (n.is_enabled === false) return 'disabled'
    var s = (n.status && (n.status.state || n.status)) || 'unknown'
    s = String(s).toLowerCase()
    if (s === 'healthy' || s === 'ok' || s === 'active') return 'online'
    if (s === 'down') return 'offline'
    return s
  }
  // Pill tone for a node state ('' = neutral)
  function stateTone (s) {
    if (s === 'online') return 'good'
    if (s === 'error' || s === 'offline') return 'bad'
    return ''
  }
  function relTime (iso) {
    if (!iso) return 'never'
    var t = Date.parse(iso)
    if (!t) return String(iso).slice(0, 16).replace('T', ' ')
    var s = Math.round((Date.now() - t) / 1000)
    if (s < 45) return 'just now'
    if (s < 3600) return Math.floor(s / 60) + ' min ago'
    if (s < 86400) return Math.floor(s / 3600) + ' h ago'
    return Math.floor(s / 86400) + ' d ago'
  }
  function nodeWhere (n) {
    var cfg = n.config || {}
    if (n.node_type === 'ssh') return (cfg.username ? cfg.username + '@' : '') + (cfg.hostname || '') + (cfg.remote_path ? ':' + cfg.remote_path : '')
    if (n.node_type === 's3') return (cfg.bucket || '') + (cfg.endpoint_url ? ' · ' + cfg.endpoint_url : '') + (cfg.prefix ? ' /' + cfg.prefix : '')
    return cfg.path || 'Local disk'
  }
  function nodeTypeIcon (t) {
    if (t === 's3') return svg('<path d="M7 18a4 4 0 0 1 .6-7.9A5 5 0 0 1 18 11a3.5 3.5 0 0 1 .2 7H7z"/>')
    if (t === 'ssh') return svg('<rect x="3" y="4" width="18" height="8" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 8h.01M7 17h.01"/>')
    return svg('<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/>')
  }
  function integrityLabel (v) {
    if (v === 'full') return 'Full hash'
    if (v === 'size-only') return 'Size only'
    return 'Unprobed'
  }
  function barRow (label, pct, val, tone) {
    var w = Math.max(0, Math.min(100, Number(pct) || 0))
    return '<div class="adm-st-bar"><span class="adm-st-bar-label">' + esc(label) + '</span>' +
      '<div class="adm-meter"><div class="adm-meter-fill' + (tone || '') + '" style="width:' + w + '%"></div></div>' +
      '<span class="adm-st-bar-val">' + esc(val) + '</span></div>'
  }
  function countCell (label, synced, pending, error, disabled) {
    var sub
    if (disabled) sub = '<div class="adm-st-count-sub">Disabled</div>'
    else if (pending || error) {
      sub = '<div class="adm-st-count-sub">' +
        (pending ? '<span class="is-warn">' + num(pending) + ' pending</span>' : '') +
        (pending && error ? ' · ' : '') +
        (error ? '<span class="is-bad">' + num(error) + ' error</span>' : '') +
        '</div>'
    } else sub = '<div class="adm-st-count-sub">Complete</div>'
    // The label text is a test contract (testsv2 test_admin_storage_tab_labels_synced_counts).
    return '<div class="adm-st-count"><div class="sn-node-count-label">' + label + '</div>' +
      '<div class="adm-st-count-val">' + (disabled ? 'Off' : num(synced)) + '</div>' + sub + '</div>'
  }
  function metricCell (label, val, sub, tone) {
    return '<div class="adm-metric' + (tone ? ' is-' + tone : '') + '"><div class="adm-metric-label">' + esc(label) + '</div>' +
      '<div class="adm-metric-val">' + esc(val) + '</div>' +
      (sub ? '<div class="adm-metric-sub">' + esc(sub) + '</div>' : '') + '</div>'
  }

  function nodeCard (n, stats) {
    var state = nodeState(n)
    var tone = stateTone(state)
    var disabled = state === 'disabled'
    var sync = (!disabled && stats && stats.sync_percent != null) ? Number(stats.sync_percent) : null
    var syncTone = sync == null ? '' : (sync >= 95 ? '' : sync >= 80 ? ' is-warn' : ' is-bad')
    var cls = 'adm-st-node sn-node-card' +
      (n.is_primary ? ' is-primary' : '') +
      (disabled ? ' is-disabled' : '') +
      (tone === 'bad' ? ' is-down' : '')
    var type = String(n.node_type || 'local')
    var where = nodeWhere(n)
    var seen = n.last_seen_at || (stats && stats.last_seen) || ''
    var sf = stats ? (stats.synced_files || 0) : 0
    var sn = stats ? (stats.synced_notes || 0) : 0
    var stn = stats ? (stats.synced_thumbnails || 0) : 0
    var pending = stats ? ((stats.pending_files || 0) + (stats.pending_notes || 0) + (stats.pending_thumbnails || 0)) : 0
    var errors = stats ? ((stats.error_files || 0) + (stats.error_notes || 0) + (stats.error_thumbnails || 0)) : 0
    var missing = stats ? (stats.missing_files || 0) : 0
    var unverified = stats ? (stats.unverified_checksum_replicas || 0) : 0
    function chip (label, v, t) { return pill(label + ' ' + (disabled ? 'off' : num(v)), (!disabled && v) ? t : '') }
    return '<article class="' + cls + '" data-node-id="' + n.id + '">' +
      '<header class="adm-node-head">' +
        '<span class="adm-node-ico" title="' + esc(TYPE_LABEL[type] || type) + '">' + nodeTypeIcon(type) + '</span>' +
        '<div class="adm-node-id"><div class="adm-node-name"><span class="adm-ellipsis">' + esc(n.name || ('Node ' + n.id)) + '</span>' +
          (n.is_primary ? pill('Primary', 'accent') : '') + '</div>' +
          '<div class="adm-node-where" title="' + esc(where) + '">' + esc(TYPE_LABEL[type] || type) + (where ? ' · ' + esc(where) : '') + '</div></div>' +
        pill(cap(state), tone, true) +
      '</header>' +
      '<div class="adm-node-sync">' +
        '<div class="adm-node-sync-top"><span>Replica sync</span><b>' + (sync == null ? 'n/a' : Math.round(sync) + '%') + '</b></div>' +
        '<div class="adm-meter"><div class="adm-meter-fill' + syncTone + '" style="width:' + (sync == null ? 0 : Math.max(0, Math.min(100, sync))) + '%"></div></div>' +
        '<div class="adm-pills">' + chip('Pending', pending, 'warn') + chip('Error', errors, 'bad') + chip('Missing', missing, 'bad') + chip('Unverified', unverified, 'warn') + '</div>' +
      '</div>' +
      '<div class="adm-st-counts">' +
        countCell('Synced files', sf, stats && stats.pending_files, stats && stats.error_files, disabled) +
        countCell('Synced notes', sn, stats && stats.pending_notes, stats && stats.error_notes, disabled) +
        countCell('Synced thumbnails', stn, stats && stats.pending_thumbnails, stats && stats.error_thumbnails, disabled) +
      '</div>' +
      '<div class="adm-st-disk" data-disk-id="' + n.id + '"><div class="adm-st-disk-wait"><span class="rd-skel"></span></div></div>' +
      '<footer class="adm-node-foot">' +
        '<span class="adm-meta" title="' + esc(seen) + '">Seen ' + esc(relTime(seen)) + ' · ' + esc(integrityLabel(n.integrity)) + '</span>' +
        '<div class="adm-st-actions">' +
          '<button class="rd-btn rd-btn-sm rd-btn-ghost" data-node-test="' + n.id + '">Test</button>' +
          (n.is_primary ? '' : '<button class="rd-btn rd-btn-sm rd-btn-ghost" data-node-primary="' + n.id + '">Make primary</button>') +
          '<button class="rd-btn rd-btn-sm rd-btn-ghost" data-node-toggle="' + n.id + '" data-enabled="' + (disabled ? '0' : '1') + '">' + (disabled ? 'Enable' : 'Disable') + '</button>' +
          '<button class="rd-btn rd-btn-sm rd-btn-ghost" data-node-rename="' + n.id + '" data-name="' + esc(n.name || '') + '">Rename</button>' +
          iconBtn('data-node-del="' + n.id + '" data-name="' + esc(n.name || '') + '"', 'Remove node', 'Remove') +
        '</div>' +
      '</footer></article>'
  }

  function fleetKpis (nodes, st) {
    var enabled = nodes.filter(function (n) { return n.is_enabled !== false })
    var online = enabled.filter(function (n) { return nodeState(n) === 'online' }).length
    var down = enabled.length - online
    var pending = (st.pending_files || 0) + (st.pending_notes || 0) + (st.pending_thumbnails || 0)
    var errors = (st.exhausted_error_files || 0) + (st.exhausted_error_notes || 0) + (st.exhausted_error_thumbnails || 0)
    var blocked = (st.blocked_files || 0) + (st.blocked_notes || 0) + (st.blocked_thumbnails || 0)
    var zero = (st.zero_copy_files || 0) + (st.zero_copy_notes || 0)
    var aged = (st.aged_single_copy_files || 0) + (st.aged_single_copy_notes || 0)
    var health = zero > 0 ? 'Data at risk' : aged > 0 ? 'Under-replicated' : 'Healthy'
    var healthTone = zero > 0 ? 'bad' : aged > 0 ? 'warn' : 'good'
    var syncTone = st.fully_synced ? 'good' : 'warn'
    var off = nodes.length - enabled.length
    return '<section class="rd-panel adm-kpis">' +
      metricCell('Nodes online', online + ' / ' + enabled.length, down ? (down + ' down' + (off ? ' · ' + off + ' disabled' : '')) : (off ? off + ' disabled' : 'All online'), down ? 'bad' : 'good') +
      metricCell('Sync', st.fully_synced ? 'In sync' : 'Work pending', (SPEEDS && SPEEDS.speed) ? sentence(SPEEDS.speed) + ' speed' : 'Replication', syncTone) +
      metricCell('Queue', num(pending), num(st.pending_files) + ' files · ' + num(st.pending_notes) + ' notes · ' + num(st.pending_thumbnails) + ' thumbs', pending ? 'warn' : 'good') +
      metricCell('Faults', num(errors + blocked), num(errors) + ' exhausted · ' + num(blocked) + ' blocked', (errors + blocked) ? 'bad' : 'good') +
      metricCell('Residency', health, num(zero) + ' zero-copy · ' + num(aged) + ' aged single', healthTone) +
      '</section>'
  }

  function residencyCard (st) {
    var zero = (st.zero_copy_files || 0) + (st.zero_copy_notes || 0)
    var aged = (st.aged_single_copy_files || 0) + (st.aged_single_copy_notes || 0)
    var single = (st.single_copy_files || 0) + (st.single_copy_notes || 0) + (st.single_copy_thumbnails || 0)
    var alertAfter = st.single_copy_alert_after_seconds || 0
    var tone = zero > 0 ? 'bad' : aged > 0 ? 'warn' : 'good'
    var label = zero > 0 ? 'Data at risk' : aged > 0 ? 'Under-replicated' : 'Healthy'
    return card('Copy residency',
      '<div class="adm-metrics">' +
      metricCell('Zero copies', num(zero), num(st.zero_copy_files) + ' files · ' + num(st.zero_copy_notes) + ' notes', zero ? 'bad' : '') +
      metricCell('Single copy', num(single), num(st.single_copy_files) + ' files · ' + num(st.single_copy_notes) + ' notes · ' + num(st.single_copy_thumbnails) + ' thumbs', (single && !st.single_node_mode) ? 'warn' : '') +
      metricCell('Past alert age', num(aged), num(st.aged_single_copy_files) + ' files · ' + num(st.aged_single_copy_notes) + ' notes', aged ? 'warn' : '') +
      '</div>' +
      kvs([['Alert age', alertAfter ? Math.round(alertAfter / 60) + ' min' : 'Off'], ['Single-node mode', st.single_node_mode ? 'Yes' : 'No']]) +
      '<p class="adm-note">A payload with a single synced copy is one disk failure away from total loss. ' +
      'Zero-copy items have no synced replica anywhere and need immediate attention. ' +
      (single > 0 ? 'Replication is still catching up on ' + num(single) + ' item(s).' : 'Every payload has at least two synced copies.') + '</p>',
      { extra: pill(label, tone, true) })
  }

  function replicationCard (st) {
    var pending = (st.pending_files || 0) + (st.pending_notes || 0) + (st.pending_thumbnails || 0)
    var errors = (st.exhausted_error_files || 0) + (st.exhausted_error_notes || 0) + (st.exhausted_error_thumbnails || 0)
    var blocked = (st.blocked_files || 0) + (st.blocked_notes || 0) + (st.blocked_thumbnails || 0)
    var deletes = st.pending_remote_deletes || 0
    return card('Replication queue',
      '<div class="adm-metrics">' +
      metricCell('Pending', num(pending), num(st.pending_files) + ' / ' + num(st.pending_notes) + ' / ' + num(st.pending_thumbnails), pending ? 'warn' : 'good') +
      metricCell('Exhausted', num(errors), num(st.exhausted_error_files) + ' / ' + num(st.exhausted_error_notes) + ' / ' + num(st.exhausted_error_thumbnails), errors ? 'bad' : '') +
      metricCell('Blocked', num(blocked), num(st.blocked_files) + ' / ' + num(st.blocked_notes) + ' / ' + num(st.blocked_thumbnails), blocked ? 'bad' : '') +
      '</div>' +
      kvs([
        ['Files with no readable replica', num(st.distinct_missing_files)],
        ['Pending remote deletes', num(deletes) + (st.stalled_remote_deletes ? ' (' + num(st.stalled_remote_deletes) + ' stalled)' : '')],
        ['Unverified checksum replicas', num(st.unverified_checksum_replicas)]
      ]) +
      '<p class="adm-note">Counts are files / notes / thumbnails.</p>',
      { extra: '<button class="rd-btn rd-btn-sm rd-btn-ghost" id="admRetryErrors">Retry errors</button>' })
  }

  function selectRow (id, label, options, current, help) {
    var opts = options.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(current) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'
    }).join('')
    return field(id, label, '<select class="form-input" id="' + id + '">' + opts + '</select>', help)
  }

  function tuningCard () {
    var speedOpts = Object.keys(SPEEDS.presets || {}).map(function (k) {
      var p = SPEEDS.presets[k]
      return [k, sentence(k) + ': ' + p.batch + ' per batch, ~' + p.approx_per_min + '/min']
    })
    var sourceOpts = Object.keys(SOURCES.modes || {}).map(function (k) {
      return [k, sentence(k.replace(/_/g, ' ')) + ': ' + (SOURCES.modes[k].description || '')]
    })
    var workerOpts = Object.keys(WORKERS.presets || {}).map(function (k) {
      return [k, sentence(WORKERS.presets[k].label) + ': ' + String(WORKERS.presets[k].desc || '').toLowerCase()]
    })
    var healthOpts = Object.keys(HEALTH.presets || {}).map(function (k) {
      return [k, sentence(HEALTH.presets[k].label) + ': ~' + HEALTH.presets[k].approx_per_day + '/day']
    })
    return card('Replication tuning',
      selectRow('admSpeed', 'Transfer speed', speedOpts, SPEEDS.speed) +
      selectRow('admSource', 'Read source', sourceOpts, SOURCES.mode) +
      selectRow('admWorkers', 'Parallel workers', workerOpts, String(WORKERS.workers)) +
      selectRow('admHealth', 'Node health check interval', healthOpts, HEALTH.preset) +
      '<div class="rd-field-row"><div class="rd-field-text"><label class="rd-field-label" for="admVerify">Verify checksums on transfer</label>' +
      '<p class="rd-field-hint">Re-hash every replica after it is written. Slower, but catches silent corruption.</p></div>' +
      '<input type="checkbox" class="rd-switch" role="switch" id="admVerify"' + (SPEEDS._checksum ? ' checked' : '') + '></div>',
      { cls: 'adm-st-tune', foot: '<button class="rd-btn rd-btn-primary" id="admSaveTuning">Apply</button>' })
  }

  function addNodeCard () {
    return card('Add storage node',
      '<div class="adm-st-fields">' +
      field('admNodeName', 'Name', '<input class="form-input" id="admNodeName" placeholder="Offsite backup" maxlength="100">') +
      field('admNodeType', 'Type', '<select class="form-input" id="admNodeType"><option value="local">Local disk</option><option value="ssh">SSH / SFTP</option><option value="s3">S3 compatible</option></select>') +
      '<div class="adm-st-primary"><label class="rd-check"><input type="checkbox" id="admNodePrimary"> Make primary</label></div></div>' +
      '<div id="admNodeFields" class="adm-st-fields"></div>',
      { cls: 'adm-st-add', sub: 'A new node starts a full backfill.', foot: '<button class="rd-btn rd-btn-primary" id="admNodeCreate">Add node</button>' })
  }

  function nodeFields (type) {
    function cfg (key, label, attrs, span) {
      return '<div class="rd-field' + (span ? ' adm-span' : '') + '"><label class="rd-field-label" for="admCfg_' + key + '">' + label + '</label>' +
        '<input class="form-input" id="admCfg_' + key + '" data-cfg="' + key + '" ' + attrs + '></div>'
    }
    if (type === 'ssh') {
      return cfg('hostname', 'Hostname', 'placeholder="Hostname"') +
        cfg('port', 'Port', 'type="number" placeholder="22" value="22"') +
        cfg('username', 'Username', 'placeholder="Username"') +
        '<div class="rd-field"><label class="rd-field-label" for="admCfg_auth_method">Authentication</label><select class="form-input" id="admCfg_auth_method" data-cfg="auth_method"><option value="password">Password auth</option><option value="key">Key auth</option></select></div>' +
        cfg('password', 'Password', 'type="password" placeholder="Leave blank for key auth" autocomplete="new-password"') +
        cfg('remote_path', 'Remote path', 'placeholder="/opt/onegy-storage" value="/opt/onegy-storage"') +
        cfg('host_key_sha256', 'Pinned host key SHA-256', 'placeholder="Required for password auth"', true) +
        '<p class="rd-field-hint adm-span">Password auth requires a pinned host key fingerprint so the first connection cannot be intercepted.</p>'
    }
    if (type === 's3') {
      return cfg('bucket', 'Bucket', 'placeholder="Bucket"') +
        cfg('region', 'Region', 'placeholder="us-east-1" value="us-east-1"') +
        cfg('prefix', 'Prefix', 'placeholder="Optional"') +
        cfg('endpoint_url', 'Endpoint URL', 'placeholder="https://endpoint (optional)"') +
        cfg('access_key', 'Access key', 'placeholder="Access key" autocomplete="off"') +
        cfg('secret_key', 'Secret key', 'type="password" placeholder="Secret key" autocomplete="new-password"')
    }
    return cfg('path', 'Path', 'placeholder="Absolute path on this host"', true)
  }

  function purgeCard () {
    return card('Local disk reclaim',
      '<div id="admPurgeStatus" class="adm-st-purge"><span class="adm-meta">Idle</span></div>' +
      '<p class="adm-note">Removes local payloads that are already synced to at least one remote node. ' +
      'Anything without a verified remote copy is skipped.</p>',
      { extra: '<button class="rd-btn rd-btn-sm rd-btn-ghost" id="admPurgeLocal">Purge local copies</button>' })
  }

  function diskMarkup (d) {
    var parts = []
    var host = d.host_disk
    var tracked = d.tracked_total_bytes || 0
    var bd = d.tracked_breakdown || {}
    var sub = fmtBytes(bd.registered_bytes) + ' files · ' + fmtBytes(bd.temp_bytes) + ' temp · ' + fmtBytes(bd.note_bytes) + ' notes'
    if (host && host.total_bytes) {
      var pct = host.percent || 0
      var tone = pct >= 90 ? ' is-bad' : pct >= 75 ? ' is-warn' : ''
      parts.push(barRow('Host disk', pct, fmtBytes(host.used_bytes) + ' / ' + fmtBytes(host.total_bytes), tone))
      var tpct = Math.min(100, (tracked / host.total_bytes) * 100)
      parts.push(barRow('Tracked', tpct, fmtBytes(tracked), ''))
    } else {
      parts.push('<div class="adm-st-bar is-plain"><span class="adm-st-bar-label">Tracked</span><span class="adm-st-bar-val">' + fmtBytes(tracked) + '</span></div>')
    }
    parts.push('<div class="adm-st-disk-sub">' + esc(sub) + '</div>')
    return parts.join('')
  }

  function loadNodeDisk (id, epoch) {
    if (!isCurrentRender('storage', epoch)) return
    var el = panel.querySelector('[data-disk-id="' + id + '"]')
    if (!el) return
    jget('/admin/api/storage/nodes/' + id + '/disk-usage').then(function (d) {
      if (!isCurrentRender('storage', epoch)) return
      var box = panel.querySelector('[data-disk-id="' + id + '"]')
      if (!box) return
      box.innerHTML = diskMarkup(d || {})
    }).catch(function () {
      if (!isCurrentRender('storage', epoch)) return
      var box = panel.querySelector('[data-disk-id="' + id + '"]')
      if (box) box.innerHTML = '<div class="adm-st-disk-wait">Disk stats unavailable</div>'
    })
  }

  function sectionHead (title, extra) {
    return '<div class="adm-sec"><h2 class="adm-sec-title">' + esc(title) + '</h2>' + (extra ? '<span class="adm-meta">' + extra + '</span>' : '') + '</div>'
  }

  async function tabStorage (epoch) {
    epoch = startRender('storage', epoch); if (epoch == null) return
    clearPurgeTimer()
    loading()
    try {
      var res = await Promise.all([
        jget('/admin/api/storage/nodes'),
        jget('/admin/api/storage/status'),
        jget('/admin/api/storage/replication-speed'),
        jget('/admin/api/storage/replication-source'),
        jget('/admin/api/storage/replication-workers'),
        jget('/admin/api/storage/health-check-interval'),
        jget('/admin/api/storage/verify-checksum')
      ])
      if (!isCurrentRender('storage', epoch)) return
      var nodes = res[0].nodes || []
      var st = res[1] || {}
      SPEEDS = res[2]; SOURCES = res[3]; WORKERS = res[4]; HEALTH = res[5]
      SPEEDS._checksum = !!(res[6] && res[6].enabled)
      var statsById = {}
      ;(st.per_node || []).forEach(function (p) { statsById[p.node_id] = p })
      var cards = nodes.map(function (n) { return nodeCard(n, statsById[n.id]) }).join('')
      paint(head('Storage', 'Node health, replica coverage and replication tuning.', '<button class="rd-btn rd-btn-ghost" id="admStorageRefresh">' + I.refresh + 'Refresh</button>') +
        '<div class="adm-stack">' + fleetKpis(nodes, st) +
        '<div>' + sectionHead('Nodes', plural(nodes.length, 'node') + ' configured') +
        '<div class="adm-st-nodes" id="storageNodeList">' +
          (cards || emptyState(I.db, 'No storage nodes configured', 'Using local storage. Add a node below to start replicating.')) +
        '</div></div>' +
        '<div>' + sectionHead('Fleet health') + '<div class="adm-grid2">' + residencyCard(st) + replicationCard(st) + '</div></div>' +
        '<div>' + sectionHead('Operations') + '<div class="adm-grid2">' + tuningCard() + purgeCard() + '</div></div>' +
        addNodeCard() + '</div>')
      var fields = $('admNodeFields')
      if (fields) fields.innerHTML = nodeFields('local')
      nodes.forEach(function (n) { loadNodeDisk(n.id, epoch) })
      pollPurge(true, epoch)
    } catch (e) { if (isCurrentRender('storage', epoch)) paint(errState('Could not load storage nodes')) }
  }

  async function pollPurge (once, epoch) {
    if (!isCurrentRender('storage', epoch)) return
    var box = $('admPurgeStatus')
    if (!box) { clearPurgeTimer(); return }
    try {
      var p = await jget('/admin/api/storage/purge-local/progress')
      if (!isCurrentRender('storage', epoch)) return
      box = $('admPurgeStatus')
      if (!box) { clearPurgeTimer(); return }
      if (p.status === 'running') {
        var pct = p.total ? Math.round((p.current || 0) / p.total * 100) : 0
        box.innerHTML = barRow(cap(p.phase || 'Working'), pct, (p.current || 0) + '/' + (p.total || 0) + ' · ' + fmtBytes(p.bytes_freed), '')
        if (!S.purgeTimer) S.purgeTimer = setInterval(function () { pollPurge(false, epoch) }, 2000)
      } else if (p.status === 'completed') {
        box.innerHTML = pill('Completed', 'good', true) +
          '<span class="adm-meta">Freed ' + fmtBytes(p.bytes_freed) + ' · ' +
          num(p.purged_files) + ' files, ' + num(p.purged_notes) + ' notes, ' + num(p.purged_thumbnails) + ' thumbnails</span>'
        clearPurgeTimer()
      } else if (p.status === 'error') {
        box.innerHTML = pill('Error', 'bad', true) + '<span class="adm-meta">' + esc(p.error || 'unknown') + '</span>'
        clearPurgeTimer()
      } else {
        box.innerHTML = '<span class="adm-meta">Idle</span>'
        clearPurgeTimer()
      }
    } catch (e) {
      if (!isCurrentRender('storage', epoch)) return
      if (once && box) box.innerHTML = '<span class="adm-meta">Idle</span>'
      clearPurgeTimer()
    }
  }

  function collectNodeConfig () {
    var cfg = {}
    panel.querySelectorAll('#admNodeFields [data-cfg]').forEach(function (i) {
      var v = i.value != null ? String(i.value).trim() : ''
      if (v !== '') cfg[i.getAttribute('data-cfg')] = v
    })
    if (cfg.port) cfg.port = parseInt(cfg.port, 10) || 22
    return cfg
  }

  function createNode (epoch) {
    var name = ($('admNodeName').value || '').trim()
    if (!name) { toast('NODE NAME REQUIRED', 'error'); return }
    var type = $('admNodeType').value
    jsend('POST', '/admin/api/storage/nodes', {
      name: name, node_type: type, is_primary: $('admNodePrimary').checked, config: collectNodeConfig()
    }).then(function (d) {
      toast(d.message || 'NODE ADDED', 'success'); refreshTab('storage', epoch)
    }).catch(function (e) { failToast(e, 'COULD NOT ADD NODE') })
  }

  function removeNode (id, name, epoch) {
    jget('/admin/api/storage/nodes/' + id + '/check-removal').then(function (info) {
      if (!isCurrentRender('storage', epoch)) return
      var atRisk = (info.exclusive_files || 0) + (info.exclusive_notes || 0) + (info.exclusive_thumbnails || 0)
      if (!atRisk) {
        confirmThen('Remove storage node "' + name + '"? Data already on it is NOT deleted.', function () {
          jsend('DELETE', '/admin/api/storage/nodes/' + id, {})
            .then(function (d) { toast(d.warning || 'NODE REMOVED', 'success'); refreshTab('storage', epoch) })
            .catch(function (e) { failToast(e, 'COULD NOT REMOVE NODE') })
        }, { title: 'Remove storage node?', ok: 'Remove' })
        return
      }
      var typed = window.prompt('This node holds ' + atRisk + ' payload(s) with NO other copy. Removing it makes them unrecoverable.\n\n' +
        'Type the node name "' + name + '" to confirm:')
      if (typed !== name) { toast('REMOVAL CANCELLED', 'error'); return }
      var phrase = window.prompt('Type: REMOVE EXCLUSIVE DATA RISK')
      if (!phrase || phrase.trim().toUpperCase() !== 'REMOVE EXCLUSIVE DATA RISK') { toast('REMOVAL CANCELLED', 'error'); return }
      jsend('DELETE', '/admin/api/storage/nodes/' + id, { force: true, confirm_node_name: name, confirm_phrase: phrase.trim() })
        .then(function (d) { toast(d.warning || 'NODE REMOVED', 'success'); refreshTab('storage', epoch) })
        .catch(function (e) { failToast(e, 'COULD NOT REMOVE NODE') })
    }).catch(function (e) { failToast(e, 'COULD NOT CHECK REMOVAL SAFETY') })
  }

  function saveTuning (epoch) {
    var jobs = [
      jsend('POST', '/admin/api/storage/replication-speed', { speed: $('admSpeed').value }),
      jsend('POST', '/admin/api/storage/replication-source', { mode: $('admSource').value }),
      jsend('POST', '/admin/api/storage/replication-workers', { workers: $('admWorkers').value }),
      jsend('POST', '/admin/api/storage/health-check-interval', { preset: $('admHealth').value }),
      jsend('POST', '/admin/api/storage/verify-checksum', { enabled: $('admVerify').checked })
    ]
    Promise.all(jobs)
      .then(function () { toast('REPLICATION SETTINGS SAVED', 'success'); refreshTab('storage', epoch) })
      .catch(function (e) { failToast(e, 'COULD NOT SAVE REPLICATION SETTINGS') })
  }

  // ---- Statistics ----------------------------------------------------------
  async function tabStats (epoch) {
    epoch = startRender('statistics', epoch); if (epoch == null) return
    loading()
    try {
      var d = await jget('/admin/api/stats'); if (!isCurrentRender('statistics', epoch)) return; S.stats = d
      var o = d.overview || {}, st = d.storage || {}
      var det = d.details || {}
      function val (v) { return v == null ? 'n/a' : (typeof v === 'number' ? num(v) : esc(v)) }
      var groups = [
        ['Accounts', [['Total users', o.total_users], ['Admin users', o.admin_users], ['Regular users', o.regular_users]]],
        ['Content', [['Total files', o.total_files], ['Registered files', o.registered_files], ['Temp files', o.temp_files], ['Total folders', o.total_folders]]],
        ['Traffic', [['Total downloads', o.total_downloads], ['Unique visitors', o.unique_visitors]]],
        ['Disk', [['App storage', (st.app_used_gb || 0) + ' GB'], ['Stored files', (st.total_file_size_gb || 0) + ' GB'], ['Disk used', (st.disk_percent || 0) + '%'], ['Disk free', (st.disk_free_gb || 0) + ' GB']]]
      ]
      var types = det.file_types || []
      var max = types.reduce(function (m, t) { return Math.max(m, Number(t.count) || 0) }, 0) || 1
      var typeRows = types.map(function (t) {
        return '<div class="adm-type"><span class="adm-type-ext">' + esc(t.ext || 'other') + '</span>' +
          '<div class="adm-meter is-dist"><div class="adm-meter-fill" style="width:' + Math.round((Number(t.count) || 0) / max * 100) + '%"></div></div><b>' + num(t.count) + '</b></div>'
      }).join('')
      var snap = d.history && d.history.latest_snapshot_at
      paint(head('Statistics', snap ? 'Snapshot ' + esc(fmtDate(snap, true)) + ' UTC' : 'Live totals across the service.') +
        '<div class="adm-stack"><div class="adm-grid2 is-4">' +
        groups.map(function (g) { return card(g[0], kvs(g[1].map(function (p) { return [p[0], val(p[1])] }))) }).join('') +
        '</div><div class="adm-grid2">' +
        card('File types', typeRows ? '<div class="adm-types">' + typeRows + '</div>' : emptyState(I.db, 'No files yet', 'File type counts appear once people upload.'), { sub: 'Most common extensions' }) +
        card('Music library', '<p class="adm-note">Re-reads the music directory so newly added songs appear and deleted ones stop being listed. ' +
          'This also runs automatically on the cleanup schedule.</p>',
          { extra: '<button class="rd-btn rd-btn-sm rd-btn-ghost" id="admMusicRescan">' + I.refresh + 'Rescan library</button>' }) +
        '</div></div>')
    } catch (e) { if (isCurrentRender('statistics', epoch)) paint(errState('Could not load statistics')) }
  }

  var TABS = { overview: tabOverview, users: tabUsers, 'temp-files': tabTemp, notifications: tabNotifs, feedback: tabFeedback, statistics: tabStats, storage: tabStorage, settings: tabSettings }
  function go (t) {
    if (!Object.prototype.hasOwnProperty.call(TABS, t)) t = 'overview'
    if (S.tab === 'settings' && S.settingsDirty) {
      confirmThen('Discard unsaved settings changes?', function () { S.settingsDirty = false; go(t) }, { title: 'Discard changes?', ok: 'Discard', icon: I.alert })
      return
    }
    clearPurgeTimer()
    clearSearchTimers()
    S.tab = t
    S.selectedUserId = null
    var epoch = ++S.renderEpoch
    var activeTab = null
    document.querySelectorAll('.adm-nav-link').forEach(function (b) {
      var active = b.getAttribute('data-tab') === t
      b.classList.toggle('is-active', active)
      b.setAttribute('aria-selected', active ? 'true' : 'false')
      b.tabIndex = active ? 0 : -1
      if (active) activeTab = b
    })
    if (panel && activeTab) panel.setAttribute('aria-labelledby', activeTab.id)
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#' + t)
    // Mobile: the section strip scrolls sideways; keep the active one in view.
    var nav = $('admNav')
    if (nav && activeTab && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = activeTab.offsetLeft - (nav.clientWidth - activeTab.offsetWidth) / 2
    if (window.scrollY) window.scrollTo(0, 0)
    panel.removeAttribute('data-shown')
    TABS[t](epoch)
  }

  // ---- Actions -------------------------------------------------------------
  function wire () {
    var tabs = Array.from(document.querySelectorAll('.adm-nav-link'))
    tabs.forEach(function (b) {
      b.onclick = function () { go(b.getAttribute('data-tab')) }
      b.onkeydown = function (e) {
        var i = tabs.indexOf(b), next = null
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length]
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(i - 1 + tabs.length) % tabs.length]
        if (e.key === 'Home') next = tabs[0]
        if (e.key === 'End') next = tabs[tabs.length - 1]
        if (next) { e.preventDefault(); next.focus(); go(next.getAttribute('data-tab')) }
      }
    })

    // Account drawer: Escape closes it, Tab stays inside it.
    document.addEventListener('keydown', function (e) {
      var dr = panel.querySelector('.adm-drawer')
      if (!dr || document.querySelector('#ucmOverlay.ucm-visible')) return
      if (e.key === 'Escape') { e.preventDefault(); closeManager(); return }
      if (e.key !== 'Tab') return
      var f = Array.from(dr.querySelectorAll('button:not([disabled]), input, select'))
      if (!f.length) return
      var first = f[0], last = f[f.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dr)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    })

    panel.addEventListener('click', function (e) {
      var t = e.target
      var epoch = S.renderEpoch
      var pg = t.closest('[data-page]'); if (pg) { var parts = pg.getAttribute('data-page').split(':'); if (parts[0] === 'users') { S.usersPage = +parts[1]; refreshTab('users', epoch) } else if (parts[0] === 'feedback') { S.fbPage = +parts[1]; refreshTab('feedback', epoch) } else { S.tempPage = +parts[1]; refreshTab('temp-files', epoch) } return }
      if (t.closest('[data-retry]')) { refreshTab(S.tab, epoch); return }
      var gt = t.closest('[data-goto]'); if (gt) { go(gt.getAttribute('data-goto')); return }

      // --- Users ---
      var manage = t.closest('[data-user-manage]')
      if (manage) { S.selectedUserId = manage.getAttribute('data-user-manage'); S.drawerEnter = true; refreshTab('users', epoch); return }
      if (t.closest('[data-user-close]')) { closeManager(); return }
      if (t.closest('#admQuotaSave')) { saveUserQuota(t.closest('#admQuotaSave'), epoch); return }
      var ta = t.closest('[data-user-admin]')
      if (ta) {
        var willPromote = ta.getAttribute('data-is-admin') !== '1'
        confirmThen((willPromote ? 'Grant administrator access to ' : 'Remove administrator access from ') + (ta.getAttribute('data-name') || 'this account') + '?', function () {
          jsend('POST', '/admin/user/' + ta.getAttribute('data-user-admin') + '/toggle_admin', { expected_current: ta.getAttribute('data-is-admin') === '1' ? 1 : 0 })
            .then(function (d) { toast(d.username ? (d.username + ' IS NOW ' + (d.is_admin ? 'AN ADMIN' : 'A USER')) : 'UPDATED', 'success'); refreshTab('users', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT UPDATE ADMIN STATUS') })
        }, willPromote ? { title: 'Make administrator?', ok: 'Make admin', icon: I.shield, safe: true } : { title: 'Remove admin role?', ok: 'Remove role', icon: I.shield })
        return
      }
      var revoke = t.closest('[data-user-revoke]')
      if (revoke) {
        confirmThen('Sign out ' + revoke.getAttribute('data-name') + ' on every device and revoke all active API keys? Their data and password will not change.', function () {
          jsend('POST', '/admin/user/' + revoke.getAttribute('data-user-revoke') + '/revoke-access', {})
            .then(function (d) { toast('ACCESS REVOKED FOR ' + String(d.username || '').toUpperCase(), 'success'); refreshTab('users', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT REVOKE ACCESS') })
        }, { title: 'Sign out everywhere?', ok: 'Sign out', icon: I.alert })
        return
      }
      var td = t.closest('[data-user-del]')
      if (td) {
        confirmThen('Delete user "' + td.getAttribute('data-name') + '" and all their data? This cannot be undone.', function () {
          jsend('POST', '/admin/user/' + td.getAttribute('data-user-del') + '/delete', {})
            .then(function (d) { toast('DELETED USER ' + String(d.username || '').toUpperCase(), 'success'); refreshTab('users', epoch) })
            .catch(function (err) { failToast(err, 'USER DELETION FAILED') })
        }, { title: 'Delete account?', ok: 'Delete' })
        return
      }

      // --- Temp files ---
      var tmp = t.closest('[data-temp-del]')
      if (tmp) {
        confirmThen('Delete this temporary file?', function () {
          jsend('DELETE', '/admin/api/temp-files/' + encodeURIComponent(tmp.getAttribute('data-temp-del')), null)
            .then(function () { toast('DELETED', 'success'); refreshTab('temp-files', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT DELETE FILE') })
        }, { title: 'Delete file?', ok: 'Delete' })
        return
      }
      if (t.closest('#admCleanup')) {
        confirmThen('Run temp-file cleanup now?', function () {
          jsend('POST', '/admin/api/cleanup', {})
            .then(function () { toast('CLEANUP DONE', 'success'); refreshTab('temp-files', epoch) })
            .catch(function (err) { failToast(err, 'CLEANUP FAILED') })
        }, { title: 'Run cleanup?', ok: 'Run cleanup', icon: I.refresh, safe: true })
        return
      }

      // --- Notifications ---
      var ntog = t.closest('[data-notif-toggle]')
      if (ntog) {
        jsend('POST', '/admin/api/notifications/' + ntog.getAttribute('data-notif-toggle') + '/toggle', {})
          .then(function () { refreshTab('notifications', epoch) })
          .catch(function (err) { failToast(err, 'COULD NOT TOGGLE BANNER') })
        return
      }
      var ndel = t.closest('[data-notif-del]')
      if (ndel) {
        confirmThen('Delete this banner?', function () {
          jsend('DELETE', '/admin/api/notifications/' + ndel.getAttribute('data-notif-del'), null)
            .then(function () { refreshTab('notifications', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT DELETE BANNER') })
        }, { title: 'Delete banner?', ok: 'Delete' })
        return
      }
      var fbdel = t.closest('[data-fb-del]')
      if (fbdel) {
        confirmThen('Delete this feedback?', function () {
          jsend('DELETE', '/admin/api/prompt-feedback/' + fbdel.getAttribute('data-fb-del'), null)
            .then(function () { toast('DELETED', 'success'); refreshTab('feedback', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT DELETE FEEDBACK') })
        }, { title: 'Delete feedback?', ok: 'Delete' })
        return
      }
      if (t.closest('#admNotifCreate')) { createNotif(epoch); return }
      if (t.closest('#admSaveSettings')) { saveSettings(); return }

      // --- Storage ---
      if (t.closest('#admStorageRefresh')) { refreshTab('storage', epoch); return }
      if (t.closest('#admSaveTuning')) { saveTuning(epoch); return }
      if (t.closest('#admNodeCreate')) { createNode(epoch); return }
      if (t.closest('#admRetryErrors')) {
        confirmThen('Reset failed replication state so it can be retried?', function () {
          jsend('POST', '/admin/api/storage/retry-errors', { exhausted_only: false, include_deferred_deletes: true })
            .then(function () { toast('FAILED STATE RESET', 'success'); refreshTab('storage', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT RESET FAILED STATE') })
        }, { title: 'Retry failed items?', ok: 'Retry', icon: I.refresh, safe: true })
        return
      }
      if (t.closest('#admPurgeLocal')) {
        confirmThen('Purge local copies that are already mirrored to a remote node?', function () {
          jsend('POST', '/admin/api/storage/purge-local', {})
            .then(function () { toast('PURGE STARTED', 'success'); pollPurge(false, epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT START PURGE') })
        }, { title: 'Purge local copies?', ok: 'Purge', icon: I.alert })
        return
      }
      var ntest = t.closest('[data-node-test]')
      if (ntest) {
        jsend('POST', '/admin/api/storage/nodes/' + ntest.getAttribute('data-node-test') + '/test', {})
          .then(function (d) { toast(d.message || (d.success ? 'CONNECTION OK' : 'CONNECTION FAILED'), d.success ? 'success' : 'error') })
          .catch(function (err) { failToast(err, 'CONNECTION TEST FAILED') })
        return
      }
      var nprim = t.closest('[data-node-primary]')
      if (nprim) {
        confirmThen('Make this node the primary read node?', function () {
          jsend('POST', '/admin/api/storage/nodes/' + nprim.getAttribute('data-node-primary') + '/set-primary', {})
            .then(function () { toast('PRIMARY NODE UPDATED', 'success'); refreshTab('storage', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT SET PRIMARY NODE') })
        }, { title: 'Change primary node?', ok: 'Make primary', icon: I.db, safe: true })
        return
      }
      var ntoggle = t.closest('[data-node-toggle]')
      if (ntoggle) {
        var enable = ntoggle.getAttribute('data-enabled') === '0'
        confirmThen((enable ? 'Enable' : 'Disable') + ' this storage node?', function () {
          jsend('PUT', '/admin/api/storage/nodes/' + ntoggle.getAttribute('data-node-toggle'), { is_enabled: enable })
            .then(function () { toast(enable ? 'NODE ENABLED' : 'NODE DISABLED', 'success'); refreshTab('storage', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT UPDATE NODE') })
        }, { title: (enable ? 'Enable' : 'Disable') + ' node?', ok: enable ? 'Enable' : 'Disable', icon: I.db, safe: true })
        return
      }
      var nren = t.closest('[data-node-rename]')
      if (nren) {
        var newName = window.prompt('Node name:', nren.getAttribute('data-name'))
        if (newName != null && newName.trim()) {
          jsend('PUT', '/admin/api/storage/nodes/' + nren.getAttribute('data-node-rename'), { name: newName.trim() })
            .then(function () { toast('NODE RENAMED', 'success'); refreshTab('storage', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT RENAME NODE') })
        }
        return
      }
      var ndelete = t.closest('[data-node-del]')
      if (ndelete) { removeNode(ndelete.getAttribute('data-node-del'), ndelete.getAttribute('data-name'), epoch); return }

      // --- Statistics ---
      if (t.closest('#admMusicRescan')) {
        jsend('POST', '/admin/api/music/rescan', {})
          .then(function (d) { toast(num(d.available_songs) + ' SONGS AVAILABLE', 'success') })
          .catch(function (err) { failToast(err, 'MUSIC RESCAN FAILED') })
        return
      }
    })

    panel.addEventListener('change', function (e) {
      if (e.target.id === 'admNodeType') {
        var box = $('admNodeFields'); if (box) box.innerHTML = nodeFields(e.target.value)
      }
      if (e.target.matches('[data-setting], [data-setting-num]')) markSettingsDirty()
      if (e.target.id === 'admQuotaUnit') updateQuotaHint()
    })

    panel.addEventListener('input', function (e) {
      if (e.target.id === 'admUserSearch') { var usersQ = e.target.value.trim(), usersEpoch = S.renderEpoch; clearTimeout(S._ut); S._ut = setTimeout(function () { S._ut = null; if (!isCurrentRender('users', usersEpoch)) return; S.usersQ = usersQ; S.usersPage = 1; S.selectedUserId = null; S.restoreUserSearch = true; refreshTab('users', usersEpoch) }, 300) }
      if (e.target.id === 'admFbSearch') { var fbQ = e.target.value.trim(), fbEpoch = S.renderEpoch; clearTimeout(S._ft); S._ft = setTimeout(function () { S._ft = null; if (!isCurrentRender('feedback', fbEpoch)) return; S.fbQ = fbQ; S.fbPage = 1; refreshTab('feedback', fbEpoch) }, 300) }
      if (e.target.matches('[data-setting], [data-setting-num]')) markSettingsDirty()
      if (e.target.id === 'admQuotaAmount') updateQuotaHint()
    })
  }

  function createNotif (epoch) {
    var msg = $('admNotifMsg').value.trim(); if (!msg) { toast('MESSAGE REQUIRED', 'error'); return }
    var body = {
      message: msg,
      title: $('admNotifTitle').value.trim(),
      bg_color: $('admNotifColor').value,
      display_trigger: $('admNotifTrigger').value,
      auto_dismiss: $('admNotifAuto').checked
    }
    if (body.auto_dismiss) body.dismiss_seconds = parseInt($('admNotifSeconds').value, 10) || 10
    var exp = $('admNotifExpires').value
    if (exp) body.expires_at = new Date(exp).toISOString()
    jsend('POST', '/admin/api/notifications', body)
      .then(function () { toast('BANNER CREATED', 'success'); refreshTab('notifications', epoch) })
      .catch(function (e) { failToast(e, 'COULD NOT CREATE BANNER') })
  }

  function saveSettings () {
    var body = {}
    panel.querySelectorAll('[data-setting]').forEach(function (i) { body[i.getAttribute('data-setting')] = i.checked })
    panel.querySelectorAll('[data-setting-num]').forEach(function (i) { if (i.value !== '') body[i.getAttribute('data-setting-num')] = parseFloat(i.value) * (Number(i.getAttribute('data-scale')) || 1) })
    var button = $('admSaveSettings'); if (button) button.disabled = true
    S.settingsDirty = false
    jsend('POST', '/admin/api/settings', body)
      .then(function () { toast('SETTINGS SAVED', 'success') })
      // Still dirty: keep Save usable so the same values can be retried.
      .catch(function (e) { if (button && button.isConnected) { S.settingsDirty = true; button.disabled = false } failToast(e, 'COULD NOT SAVE SETTINGS') })
  }

  function markSettingsDirty () {
    if (S.tab !== 'settings') return
    S.settingsDirty = true
    var button = $('admSaveSettings'); if (button) button.disabled = false
  }

  function quotaGbFromForm () {
    var amount = Number(($('admQuotaAmount') || {}).value)
    var unit = (($('admQuotaUnit') || {}).value || 'GB')
    var factor = unit === 'TB' ? 1024 : unit === 'MB' ? (1 / 1024) : 1
    return amount * factor
  }

  function updateQuotaHint () {
    var hint = $('admQuotaHint')
    var user = S.users.find(function (u) { return String(u.id) === String(S.selectedUserId) })
    if (!hint || !user) return
    var gb = quotaGbFromForm()
    if (!Number.isFinite(gb) || gb < 0.001 || gb > 1048576) {
      hint.textContent = 'Enter a limit between 1.024 MB and 1 PB.'
      hint.classList.add('is-bad')
      return
    }
    var bytes = gb * Math.pow(1024, 3)
    hint.textContent = bytes < Number(user.storage_used_bytes || 0)
      ? 'This is below current use. New uploads will stop until the account frees space.'
      : 'New allowance: ' + fmtBytes(bytes) + '. Existing data is never deleted.'
    hint.classList.toggle('is-bad', bytes < Number(user.storage_used_bytes || 0))
  }

  function saveUserQuota (button, epoch) {
    var gb = quotaGbFromForm()
    if (!Number.isFinite(gb) || gb < 0.001 || gb > 1048576) { updateQuotaHint(); return }
    button.disabled = true
    var fd = new FormData(); fd.append('storage_limit_gb', String(gb)); fd.append('csrf_token', csrf())
    jsend('POST', '/admin/user/' + button.getAttribute('data-user-id') + '/edit', fd, true)
      .then(function (d) { toast('STORAGE LIMIT UPDATED TO ' + d.storage_limit_gb + ' GB', 'success'); refreshTab('users', epoch) })
      .catch(function (err) { button.disabled = false; failToast(err, 'COULD NOT SAVE STORAGE LIMIT') })
  }

  window.__admMock = function (tab, data) { panel = $('admPanel'); S.stats = data && data.stats; if (data && data._users) { window.__admU = data._users }; go(tab || 'overview') }

  function boot () {
    panel = $('admPanel'); if (!panel) return
    wire(); go(window.location.hash.slice(1))
    // Tab switches already ask before dropping unsaved settings; leaving the page must too.
    window.addEventListener('beforeunload', function (e) { if (S.tab === 'settings' && S.settingsDirty) { e.preventDefault(); e.returnValue = '' } })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
