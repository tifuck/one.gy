/* ============================================================================
   admin.js — Frost Admin console controller.
   Fetches the existing /admin/api/* endpoints and renders the frost UI.
   Not E2E. Destructive actions confirm first.

   AUDIT FIX A13: every mutating call now reports the SERVER'S outcome. The
   user delete / toggle-admin routes used to answer with a 302 that fetch()
   followed transparently, so a failed delete still toasted 'USER DELETED'.
   AUDIT FIX A14: the notification trigger options now match the server's
   valid_triggers set exactly ('once' and 'session' were never valid and always
   400'd; four supported triggers had no UI at all).
   AUDIT FIX A15: storage-node management (add / edit / test / set-primary /
   enable / remove / purge-local / retry-errors) and the replication tuning
   endpoints are wired up here instead of requiring hand-crafted curl.
   ========================================================================== */
(function () {
  'use strict'
  var S = { tab: 'overview', renderEpoch: 0, stats: null, usersPage: 1, usersQ: '', users: [], selectedUserId: null, restoreUserSearch: false, settingsDirty: false, tempPage: 1, fbPage: 1, fbQ: '', purgeTimer: null }
  var $ = function (id) { return document.getElementById(id) }
  var panel

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
  function confirmThen (msg, cb) { if (window.showConfirm) { var p = window.showConfirm('Confirm', msg, 'Confirm'); if (p && p.then) { p.then(function (ok) { if (ok) cb() }); return } } if (window.confirm(msg)) cb() }
  function fmtBytes (b) { if (!b) return '0 B'; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(b) / Math.log(1024)); return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i] }
  function loading () { panel.innerHTML = '<div class="adm-loading" role="status"><span class="adm-spin"></span><span class="sr-only">Loading</span></div>' }
  function errState (m) { return '<div class="adm-empty"><p>' + esc(m) + '</p></div>' }
  function num (v) { return Number(v || 0).toLocaleString() }
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
      function tile (label, val, sub) { return '<div class="adm-tile"><div class="adm-tile-val">' + esc(val) + '</div><div class="adm-tile-label">' + esc(label) + '</div>' + (sub ? '<div class="adm-tile-sub">' + esc(sub) + '</div>' : '') + '</div>' }
      var tiles = '<div class="adm-tiles">' +
        tile('Users', num(o.total_users), (o.admin_users || 0) + ' admin · ' + (o.regular_users || 0) + ' user') +
        tile('Files', num(o.total_files), (o.registered_files || 0) + ' stored · ' + (o.temp_files || 0) + ' temp') +
        tile('Folders', num(o.total_folders), '') +
        tile('Downloads', num(o.total_downloads), (o.unique_visitors || 0) + ' unique visitors') +
        '</div>'
      var diskPct = st.disk_percent || 0
      var storage = '<div class="adm-card"><div class="adm-card-head"><h3 class="adm-h3">Storage</h3><span class="adm-mono">' + (st.app_used_gb || 0) + ' GB tracked</span></div>' +
        '<div class="adm-meter"><div class="adm-meter-fill' + (diskPct >= 90 ? ' is-bad' : diskPct >= 75 ? ' is-warn' : '') + '" style="width:' + diskPct + '%"></div></div>' +
        '<div class="adm-kv"><span>Disk used</span><b>' + diskPct + '% · ' + (st.disk_free_gb || 0) + ' GB free of ' + (st.disk_total_gb || 0) + ' GB</b></div>' +
        '<div class="adm-kv"><span>Stored files</span><b>' + (st.total_file_size_gb || 0) + ' GB</b></div>' +
        '<div class="adm-kv"><span>Temp payload</span><b>' + (st.temp_file_size_gb || 0) + ' GB</b></div></div>'
      var repl = '<div class="adm-card"><div class="adm-card-head"><h3 class="adm-h3">Replication</h3>' +
        '<span class="adm-badge' + (ro.fully_synced ? ' adm-badge-on' : '') + '">' + (ro.fully_synced ? 'IN SYNC' : 'WORK PENDING') + '</span></div>' +
        '<div class="adm-kv"><span>Nodes</span><b>' + num(ro.nodes) + ' · ' + num(ro.online_nodes) + ' online</b></div>' +
        '<div class="adm-kv"><span>Pending items</span><b>' + num(ro.pending_items) + '</b></div>' +
        '<div class="adm-kv"><span>Errored items</span><b>' + num(ro.error_items) + '</b></div>' +
        '<div class="adm-kv"><span>Speed</span><b>' + esc(rc.speed || '—') + '</b></div>' +
        '<div class="adm-kv"><span>Source</span><b>' + esc(rc.source || '—') + '</b></div>' +
        '<div class="adm-kv"><span>Workers</span><b>' + esc(rc.workers || '—') + '</b></div>' +
        '<div class="adm-kv"><span>Checksum verify</span><b>' + (rc.checksum ? 'ON' : 'OFF') + '</b></div></div>'
      panel.innerHTML = tiles + '<div class="adm-grid2">' + storage + repl + '</div>'
    } catch (e) { if (isCurrentRender('overview', epoch)) panel.innerHTML = errState('Could not load statistics.') }
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
  function quotaMarkup (u, compact) {
    var pct = Math.max(0, Math.min(100, Number(u.storage_percent) || 0))
    return '<div class="adm-user-quota' + (compact ? ' is-compact' : '') + '">' +
      '<div class="adm-user-quota-line"><b>' + fmtBytes(u.storage_used_bytes) + '</b><span>' + (u.over_quota ? 'Over quota' : Math.round(Number(u.storage_percent) || 0) + '%') + '</span></div>' +
      '<div class="adm-meter" role="progressbar" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(Number(u.storage_percent) || 0) + '"><div class="adm-meter-fill' + userTone(u) + '" style="width:' + pct + '%"></div></div>' +
      '<div class="adm-user-quota-limit">Limit ' + fmtBytes(u.storage_limit_bytes) + '</div></div>'
  }
  function userManager (u) {
    if (!u) return ''
    var q = quotaParts(u.storage_limit_gb)
    return '<section class="adm-account-manager" aria-labelledby="admAccountTitle">' +
      '<header class="adm-account-head"><div class="adm-account-identity"><span class="adm-account-avatar" style="background:' + esc(u.avatar_color || 'var(--accent)') + '">' + esc(String(u.username || '?').charAt(0).toUpperCase()) + '</span>' +
      '<div><div class="adm-account-kicker">Account #' + u.id + '</div><h3 id="admAccountTitle">' + esc(u.username) + (u.is_admin ? ' <span class="adm-badge adm-badge-on">Admin</span>' : '') + '</h3><p>' + esc(u.email || 'No email address') + '</p></div></div>' +
      '<button class="adm-icon" data-user-close aria-label="Close account manager" title="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>' +
      '<div class="adm-account-facts"><div><b>' + num(u.file_count) + '</b><span>Active files</span></div><div><b>' + num(u.folder_count) + '</b><span>Folders</span></div><div><b>' + num(u.note_count) + '</b><span>Notes</span></div><div><b>' + num(u.login_count) + '</b><span>Logins</span></div></div>' +
      '<div class="adm-account-grid"><div class="adm-account-pane"><div class="adm-card-head"><h4>Storage allowance</h4><span class="adm-mono">' + fmtBytes(u.storage_remaining_bytes) + ' available</span></div>' + quotaMarkup(u, false) +
      '<div class="adm-quota-form"><label for="admQuotaAmount">New limit</label><div class="adm-quota-control"><input class="form-input" id="admQuotaAmount" type="number" min="0.001" step="0.001" value="' + q.amount + '"><select class="form-input" id="admQuotaUnit" aria-label="Storage unit"><option value="MB"' + (q.unit === 'MB' ? ' selected' : '') + '>MB</option><option value="GB"' + (q.unit === 'GB' ? ' selected' : '') + '>GB</option><option value="TB"' + (q.unit === 'TB' ? ' selected' : '') + '>TB</option></select><button class="rd-btn rd-btn-primary" id="admQuotaSave" data-user-id="' + u.id + '">Update limit</button></div>' +
      '<p class="adm-note" id="admQuotaHint">Limits block new uploads when reached; existing data is never deleted.</p></div></div>' +
      '<div class="adm-account-pane"><div class="adm-card-head"><h4>Access and security</h4></div><div class="adm-security-list"><div><span>Two-factor authentication</span><b>' + (u.two_factor_enabled ? 'Enabled' : 'Not enabled') + '</b></div><div><span>Encryption setup</span><b>' + (u.has_e2ee_keys ? 'Ready' : 'Incomplete') + '</b></div><div><span>Authentication</span><b>' + (Number(u.split_key_version) > 0 ? 'Split-key' : 'Legacy') + '</b></div><div><span>Active API keys</span><b>' + num(u.active_api_key_count) + '</b></div></div>' +
      '<div class="adm-account-actions"><button class="rd-btn rd-btn-ghost" data-user-admin="' + u.id + '" data-name="' + esc(u.username) + '" data-is-admin="' + (u.is_admin ? '1' : '0') + '">' + (u.is_admin ? 'Remove admin role' : 'Make administrator') + '</button><button class="rd-btn rd-btn-ghost" data-user-revoke="' + u.id + '" data-name="' + esc(u.username) + '">Sign out everywhere</button></div>' +
      '<div class="adm-danger-zone"><div><b>Delete account</b><span>Destroy this account and all of its files, notes and folders.</span></div><button class="rd-btn adm-btn-danger" data-user-del="' + u.id + '" data-name="' + esc(u.username) + '">Delete account</button></div></div></div></section>'
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
        return '<tr class="' + (String(u.id) === String(S.selectedUserId) ? 'is-selected' : '') + '">' +
          '<td data-label="Account"><span class="adm-user"><span class="adm-dot" style="background:' + esc(u.avatar_color || 'var(--accent)') + '"></span><span><b>' + esc(u.username) + '</b>' + (u.is_admin ? ' <span class="adm-badge adm-badge-on">Admin</span>' : '') + '<small>' + esc(u.email || 'No email') + ' · #' + u.id + '</small></span></span></td>' +
          '<td data-label="Quota">' + quotaMarkup(u, true) + '</td>' +
          '<td data-label="Content"><b>' + num(u.file_count) + ' files</b><small class="adm-cell-sub">' + num(u.folder_count) + ' folders · ' + num(u.note_count) + ' notes' + (u.trashed_file_count ? ' · ' + num(u.trashed_file_count) + ' trashed' : '') + '</small></td>' +
          '<td data-label="Security"><span class="adm-security-state' + (u.two_factor_enabled ? ' is-good' : '') + '">' + esc(securityLabel(u)) + '</span></td>' +
          '<td data-label="Joined" class="adm-mono">' + esc((u.created_at || '').slice(0, 10)) + '</td>' +
          '<td data-label="Actions" class="adm-actions-cell"><button class="rd-btn rd-btn-ghost adm-manage-btn" data-user-manage="' + u.id + '">Manage</button></td></tr>'
      }).join('')
      panel.innerHTML =
        '<div class="adm-section-intro"><div><span class="adm-section-kicker">Identity and access</span><h2 class="adm-h2">Accounts</h2><p>Review quota use, security posture and account-level controls.</p></div><div class="adm-section-count"><b>' + num(d.total) + '</b><span>Total accounts</span></div></div>' +
        '<div class="adm-toolbar"><span class="adm-mono">' + num((d.users || []).length) + ' shown</span><label class="adm-search" for="admUserSearch"><span class="sr-only">Search accounts</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="admUserSearch" type="search" placeholder="Search name or email" value="' + esc(S.usersQ) + '"></label></div>' +
        userManager(selected) +
        '<div class="adm-tablewrap adm-users-table"><table class="adm-table"><thead><tr><th>Account</th><th>Quota</th><th>Content</th><th>Security</th><th>Joined</th><th>Actions</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="adm-empty-row">No matching accounts</td></tr>') + '</tbody></table></div>' +
        pager(d.page, d.pages, 'users')
      if (S.restoreUserSearch) {
        S.restoreUserSearch = false
        var search = $('admUserSearch'); if (search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length) }
      }
    } catch (e) { if (isCurrentRender('users', epoch)) panel.innerHTML = errState('Could not load users.') }
  }
  function pager (page, pages, kind) {
    if (!pages || pages <= 1) return ''
    return '<div class="adm-pager"><button class="rd-btn rd-btn-ghost" data-page="' + kind + ':' + Math.max(1, page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>Prev</button>' +
      '<span class="adm-mono">Page ' + page + ' / ' + pages + '</span>' +
      '<button class="rd-btn rd-btn-ghost" data-page="' + kind + ':' + Math.min(pages, page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>Next</button></div>'
  }

  // ---- Temp files ----------------------------------------------------------
  async function tabTemp (epoch) {
    epoch = startRender('temp-files', epoch); if (epoch == null) return
    loading()
    try {
      var d = await jget('/admin/api/temp-files?page=' + S.tempPage + '&per_page=25')
      if (!isCurrentRender('temp-files', epoch)) return
      var rows = (d.files || []).map(function (f) {
        return '<tr><td>' + esc(f.orig_name || '—') + (f.has_password ? ' <span class="adm-badge">LOCKED</span>' : '') + '</td>' +
          '<td class="adm-num">' + fmtBytes(f.size) + '</td>' +
          '<td class="adm-mono">' + esc(f.user_id || '—') + '</td>' +
          '<td class="adm-num">' + (f.download_count || 0) + (f.max_downloads ? ' / ' + f.max_downloads : '') + '</td>' +
          '<td class="adm-mono">' + esc((f.upload_time || '').slice(0, 16).replace('T', ' ')) + '</td>' +
          '<td class="adm-actions-cell"><button class="adm-icon adm-icon-danger" data-temp-del="' + esc(f.management_token || f.short_code || '') + '" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></td></tr>'
      }).join('')
      panel.innerHTML = '<div class="adm-toolbar"><h2 class="adm-h2">Temporary files</h2><button class="rd-btn rd-btn-ghost" id="admCleanup">Run cleanup</button></div>' +
        '<div class="adm-tablewrap"><table class="adm-table"><thead><tr><th>Filename</th><th>Size</th><th>Owner</th><th>Downloads</th><th>Uploaded</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="adm-empty-row">No temporary files</td></tr>') + '</tbody></table></div>' + pager(d.page, d.pages, 'temp')
    } catch (e) { if (isCurrentRender('temp-files', epoch)) panel.innerHTML = errState('Could not load temp files.') }
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
        return '<div class="adm-notif" style="border-left-color:' + esc(n.bg_color || 'var(--accent)') + '">' +
          '<div class="adm-notif-main"><div class="adm-notif-title">' + esc(n.title || 'Banner') + ' ' + (n.is_active ? '<span class="adm-badge adm-badge-on">ACTIVE</span>' : '<span class="adm-badge">OFF</span>') + '</div>' +
          '<div class="adm-notif-msg">' + esc(n.message || '') + '</div>' +
          '<div class="adm-notif-meta adm-mono">' + esc(triggerLabel(n.display_trigger)) +
          (n.auto_dismiss && n.dismiss_seconds ? ' · auto-dismiss ' + n.dismiss_seconds + 's' : '') +
          (n.expires_at ? ' · expires ' + esc((n.expires_at || '').slice(0, 10)) : '') + '</div></div>' +
          '<div class="adm-notif-actions"><button class="rd-btn rd-btn-ghost" data-notif-toggle="' + n.id + '">' + (n.is_active ? 'Disable' : 'Enable') + '</button>' +
          '<button class="adm-icon adm-icon-danger" data-notif-del="' + n.id + '" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></div></div>'
      }).join('')
      panel.innerHTML = '<div class="adm-toolbar"><h2 class="adm-h2">Notification banners</h2></div>' +
        '<div class="adm-card"><div class="adm-card-head"><h3 class="adm-h3">New banner</h3></div>' +
        '<div class="adm-form"><input class="form-input" id="admNotifTitle" placeholder="Title (optional)" maxlength="120">' +
        '<textarea class="form-input" id="admNotifMsg" placeholder="Message" rows="2" maxlength="500"></textarea>' +
        // NOTE: this is banner CONTENT (persisted as Notification.bg_color), not a
        // theme token. It matches the server-side default so the picker and the
        // stored fallback cannot disagree.
        '<div class="adm-form-row"><label class="adm-lbl">Color <input type="color" id="admNotifColor" value="#de1833"></label>' +
        '<select class="form-input" id="admNotifTrigger">' + triggerOptions('always') + '</select>' +
        '<label class="adm-lbl">Expires <input class="form-input" id="admNotifExpires" type="datetime-local"></label>' +
        '<label class="adm-lbl"><input type="checkbox" id="admNotifAuto"> Auto-dismiss after ' +
        '<input class="form-input adm-num-input" id="admNotifSeconds" type="number" min="1" max="3600" value="10"> s</label>' +
        '<button class="rd-btn rd-btn-primary" id="admNotifCreate">Create banner</button></div></div></div>' +
        '<p class="adm-note">Banners overlay the full nav bar on every page. ' +
        '<span class="adm-mono">Always show until dismissed</span> stays until ×, then never again. ' +
        '<span class="adm-mono">Once per login session</span> stays until ×, then comes back on the next login. ' +
        'Register / first-login banners show in that window until ×, then never again.</p>' +
        '<div class="adm-notif-list">' + (rows || '<div class="adm-empty-row">No banners</div>') + '</div>'
    } catch (e) { if (isCurrentRender('notifications', epoch)) panel.innerHTML = errState('Could not load notifications.') }
  }

  async function tabFeedback (epoch) {
    epoch = startRender('feedback', epoch); if (epoch == null) return
    loading()
    try {
      var d = await jget('/admin/api/prompt-feedback?page=' + S.fbPage + '&per_page=25' + (S.fbQ ? '&search=' + encodeURIComponent(S.fbQ) : ''))
      if (!isCurrentRender('feedback', epoch)) return
      var rows = (d.items || []).map(function (f) {
        var when = (f.created_at || '').slice(0, 16).replace('T', ' ')
        var kind = f.kind === 'prompt' ? 'Prompt' : 'General'
        return '<tr>' +
          '<td class="adm-mono">' + esc(when || '—') + '</td>' +
          '<td><span class="adm-badge">' + esc(kind) + '</span></td>' +
          '<td class="adm-mono">' + esc(f.prompt_id || '—') + '</td>' +
          '<td>' + esc(f.username || 'Guest') + '</td>' +
          '<td class="adm-fb-msg" title="' + esc(f.message || '') + '">' + esc(f.message || '') + '</td>' +
          '<td class="adm-actions-cell"><button class="adm-icon adm-icon-danger" data-fb-del="' + f.id + '" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></td>' +
          '</tr>'
      }).join('')
      panel.innerHTML =
        '<div class="adm-toolbar"><h2 class="adm-h2">Prompt feedback</h2><div class="adm-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="admFbSearch" type="search" placeholder="Search feedback…" value="' + esc(S.fbQ) + '"></div></div>' +
        '<p class="adm-note">' + num(d.total || 0) + ' submissions · one per IP per minute</p>' +
        '<div class="adm-tablewrap"><table class="adm-table"><thead><tr><th>When</th><th>Kind</th><th>Prompt</th><th>From</th><th>Message</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="6" class="adm-empty-row">No feedback</td></tr>') + '</tbody></table></div>' +
        pager(d.page, d.pages, 'feedback')
    } catch (e) { if (isCurrentRender('feedback', epoch)) panel.innerHTML = errState('Could not load feedback.') }
  }

  // ---- Settings ------------------------------------------------------------
  async function tabSettings (epoch) {
    epoch = startRender('settings', epoch); if (epoch == null) return
    loading()
    try {
      var s = await jget('/admin/api/settings')
      if (!isCurrentRender('settings', epoch)) return
      function tog (key, label, desc) {
        return '<label class="adm-toggle"><span class="adm-toggle-txt"><b>' + esc(label) + '</b><span>' + esc(desc) + '</span></span>' +
          '<span class="adm-switch"><input type="checkbox" data-setting="' + key + '"' + (s[key] ? ' checked' : '') + '><span class="adm-switch-track"></span></span></label>'
      }
      function numRow (key, label, desc, min, max, step, unit) {
        return '<label class="adm-setting-number"><span><b>' + esc(label) + '</b><small>' + esc(desc) + '</small></span><span class="adm-setting-control"><input class="form-input adm-num-input" type="number" min="' + min + '" max="' + max + '" step="' + step + '" data-setting-num="' + key + '" value="' + (s[key] != null ? s[key] : '') + '"><span>' + esc(unit) + '</span></span></label>'
      }
      S.settingsDirty = false
      panel.innerHTML = '<div class="adm-section-intro"><div><span class="adm-section-kicker">Platform policy</span><h2 class="adm-h2">Settings</h2><p>Control account access, public features and automated retention.</p></div><button class="rd-btn rd-btn-primary" id="admSaveSettings" disabled>Save changes</button></div>' +
        '<div class="adm-settings-grid"><div class="adm-card"><div class="adm-card-head"><div><h3 class="adm-h3">Access and features</h3><p class="adm-card-copy">Changes apply across the service immediately.</p></div></div>' +
        tog('allow_registration', 'Open registration', 'Allow new accounts to sign up.') +
        tog('allow_temp_uploads', 'Quick Share', 'Enable anonymous temporary uploads.') +
        tog('allow_music', 'Music', 'Show the Music section.') +
        tog('allow_api_keys', 'API keys', 'Let users create programmatic API keys.') +
        tog('captcha_enabled', 'Captcha', 'Require captcha on sensitive actions.') +
        tog('welcome_folder_enabled', 'Welcome folder', 'Seed new accounts with a welcome folder.') +
        '</div><div class="adm-card"><div class="adm-card-head"><div><h3 class="adm-h3">Limits and retention</h3><p class="adm-card-copy">Bound temporary content and background housekeeping.</p></div></div>' +
        numRow('temp_max_gb', 'Temporary upload limit', 'Maximum size for one anonymous upload.', 0.01, 1024, 0.01, 'GB') +
        numRow('storage_cache_ttl_minutes', 'Storage cache lifetime', 'How long computed storage totals remain cached.', 1, 10080, 1, 'minutes') +
        numRow('trash_retention_hours', 'Trash retention', 'Time before trashed content is permanently purged.', 1, 8760, 1, 'hours') +
        '<div class="adm-policy-note"><b>Permanent deletion</b><p>Retention is measured from each item’s trash date. Purged content cannot be recovered.</p></div></div></div>'
    } catch (e) { if (isCurrentRender('settings', epoch)) panel.innerHTML = errState('Could not load settings.') }
  }

  // ---- Storage -------------------------------------------------------------
  var SPEEDS = null, SOURCES = null, WORKERS = null, HEALTH = null

  function nodeState (n) {
    if (n.is_enabled === false) return 'disabled'
    var s = (n.status && (n.status.state || n.status)) || 'unknown'
    s = String(s).toLowerCase()
    if (s === 'healthy' || s === 'ok' || s === 'active') return 'online'
    if (s === 'down') return 'offline'
    return s
  }
  function stateTone (s) {
    if (s === 'online') return 'good'
    if (s === 'error' || s === 'offline') return 'bad'
    if (s === 'disabled' || s === 'unknown') return 'dim'
    return 'dim'
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
    if (t === 's3') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4 4 0 0 1 .6-7.9A5 5 0 0 1 18 11a3.5 3.5 0 0 1 .2 7H7z"/></svg>'
    if (t === 'ssh') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="8" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 8h.01M7 17h.01"/></svg>'
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 10h16M9 4v16"/></svg>'
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
    return '<div class="adm-st-count"><div class="sn-node-count-label">' + label + '</div>' +
      '<div class="adm-st-count-val">' + (disabled ? '—' : num(synced)) + '</div>' + sub + '</div>'
  }
  function metricCell (label, val, sub, tone) {
    return '<div class="adm-st-metric' + (tone ? ' is-' + tone : '') + '"><div class="adm-st-metric-val">' + esc(val) + '</div>' +
      '<div class="adm-st-metric-label">' + esc(label) + '</div>' +
      (sub ? '<div class="adm-st-metric-sub">' + esc(sub) + '</div>' : '') + '</div>'
  }
  function stamp (text, tone) {
    return '<span class="adm-st-stamp is-' + (tone || 'dim') + '">' + esc(text) + '</span>'
  }

  function nodeCard (n, stats) {
    var state = nodeState(n)
    var tone = stateTone(state)
    var disabled = state === 'disabled'
    var sync = (!disabled && stats && stats.sync_percent != null) ? Number(stats.sync_percent) : null
    var syncTone = sync == null ? '' : (sync >= 100 ? '' : sync >= 95 ? '' : sync >= 80 ? ' is-warn' : ' is-bad')
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
    return '<article class="' + cls + '" data-node-id="' + n.id + '">' +
      '<header class="adm-st-node-head">' +
        '<span class="adm-st-led is-' + state + '" title="' + esc(state) + '"></span>' +
        '<div class="adm-st-node-id">' +
          '<div class="adm-st-node-name">' + esc(n.name || ('Node ' + n.id)) +
            (n.is_primary ? ' <span class="adm-badge adm-badge-on">Primary</span>' : '') +
            (disabled ? ' <span class="adm-badge">Disabled</span>' : '') +
            ' <span class="adm-badge">' + esc(integrityLabel(n.integrity)) + '</span></div>' +
          '<div class="adm-st-node-where adm-mono" title="' + esc(where) + '">' + esc(where) + '</div>' +
        '</div>' +
        '<div class="adm-st-node-type"><span class="adm-st-type-ico">' + nodeTypeIcon(type) + '</span>' +
          '<span class="adm-st-type-lab">' + esc(type) + '</span>' +
          stamp(state, tone) + '</div>' +
      '</header>' +
      '<div class="adm-st-node-sync">' +
        '<div class="adm-st-sync-num">' + (sync == null ? '—' : Math.round(sync) + '%') + '</div>' +
        '<div class="adm-st-sync-body">' +
          '<div class="adm-st-sync-lab">Replica sync</div>' +
          '<div class="adm-meter"><div class="adm-meter-fill' + syncTone + '" style="width:' + (sync == null ? 0 : Math.max(0, Math.min(100, sync))) + '%"></div></div>' +
          '<div class="adm-st-chips">' +
            '<span class="adm-st-chip' + (pending ? ' is-warn' : '') + '">Pending <b>' + (disabled ? '—' : num(pending)) + '</b></span>' +
            '<span class="adm-st-chip' + (errors ? ' is-bad' : '') + '">Error <b>' + (disabled ? '—' : num(errors)) + '</b></span>' +
            '<span class="adm-st-chip' + (missing ? ' is-bad' : '') + '">Missing <b>' + (disabled ? '—' : num(missing)) + '</b></span>' +
            '<span class="adm-st-chip' + (unverified ? ' is-warn' : '') + '">Unverified <b>' + (disabled ? '—' : num(unverified)) + '</b></span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="adm-st-counts">' +
        countCell('SYNCED FILES', sf, stats && stats.pending_files, stats && stats.error_files, disabled) +
        countCell('SYNCED NOTES', sn, stats && stats.pending_notes, stats && stats.error_notes, disabled) +
        countCell('SYNCED THUMBNAILS', stn, stats && stats.pending_thumbnails, stats && stats.error_thumbnails, disabled) +
      '</div>' +
      '<div class="adm-st-disk" data-disk-id="' + n.id + '"><div class="adm-st-disk-wait adm-mono">Loading disk…</div></div>' +
      '<footer class="adm-st-node-foot">' +
        '<span class="adm-mono" title="' + esc(seen) + '">Seen ' + esc(relTime(seen)) + '</span>' +
        '<div class="adm-st-actions">' +
          '<button class="rd-btn rd-btn-ghost" data-node-test="' + n.id + '">Test</button>' +
          (n.is_primary ? '' : '<button class="rd-btn rd-btn-ghost" data-node-primary="' + n.id + '">Make primary</button>') +
          '<button class="rd-btn rd-btn-ghost" data-node-toggle="' + n.id + '" data-enabled="' + (disabled ? '0' : '1') + '">' + (disabled ? 'Enable' : 'Disable') + '</button>' +
          '<button class="rd-btn rd-btn-ghost" data-node-rename="' + n.id + '" data-name="' + esc(n.name || '') + '">Rename</button>' +
          '<button class="adm-icon adm-icon-danger" data-node-del="' + n.id + '" data-name="' + esc(n.name || '') + '" title="Remove node"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>' +
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
    function kpi (label, val, sub, tone) {
      return '<div class="adm-st-kpi' + (tone ? ' is-' + tone : '') + '"><div class="adm-st-kpi-label">' + esc(label) + '</div>' +
        '<div class="adm-st-kpi-val">' + esc(val) + '</div>' +
        (sub ? '<div class="adm-st-kpi-sub">' + esc(sub) + '</div>' : '') + '</div>'
    }
    return '<div class="adm-st-kpis">' +
      kpi('Nodes', online + ' / ' + enabled.length, down ? (down + ' down' + (nodes.length - enabled.length ? ' · ' + (nodes.length - enabled.length) + ' disabled' : '')) : (nodes.length - enabled.length ? (nodes.length - enabled.length) + ' disabled' : 'All online'), down ? 'bad' : 'good') +
      kpi('Sync', st.fully_synced ? 'In sync' : 'Work pending', (SPEEDS && SPEEDS.speed) ? String(SPEEDS.speed) + ' speed' : 'Replication', syncTone) +
      kpi('Queue', num(pending), num(st.pending_files) + ' files · ' + num(st.pending_notes) + ' notes · ' + num(st.pending_thumbnails) + ' thumbs', pending ? 'warn' : 'good') +
      kpi('Faults', num(errors + blocked), num(errors) + ' exhausted · ' + num(blocked) + ' blocked', (errors + blocked) ? 'bad' : 'good') +
      kpi('Residency', health, num(zero) + ' zero-copy · ' + num(aged) + ' aged single', healthTone) +
      '</div>'
  }

  function residencyCard (st) {
    var zero = (st.zero_copy_files || 0) + (st.zero_copy_notes || 0)
    var aged = (st.aged_single_copy_files || 0) + (st.aged_single_copy_notes || 0)
    var single = (st.single_copy_files || 0) + (st.single_copy_notes || 0) + (st.single_copy_thumbnails || 0)
    var alertAfter = st.single_copy_alert_after_seconds || 0
    var tone = zero > 0 ? 'bad' : aged > 0 ? 'warn' : 'good'
    var label = zero > 0 ? 'Data at risk' : aged > 0 ? 'Under-replicated' : 'Healthy'
    return '<div class="adm-card adm-st-panel"><div class="adm-card-head"><h3 class="adm-h3">Copy residency</h3>' + stamp(label, tone) + '</div>' +
      '<div class="adm-st-metrics">' +
      metricCell('Zero copies', num(zero), num(st.zero_copy_files) + ' files · ' + num(st.zero_copy_notes) + ' notes', zero ? 'bad' : '') +
      metricCell('Single copy', num(single), num(st.single_copy_files) + ' files · ' + num(st.single_copy_notes) + ' notes · ' + num(st.single_copy_thumbnails) + ' thumbs', (single && !st.single_node_mode) ? 'warn' : '') +
      metricCell('Past alert age', num(aged), num(st.aged_single_copy_files) + ' files · ' + num(st.aged_single_copy_notes) + ' notes', aged ? 'warn' : '') +
      '</div>' +
      '<div class="adm-kv"><span>Alert age</span><b>' + (alertAfter ? Math.round(alertAfter / 60) + ' min' : '—') + '</b></div>' +
      '<div class="adm-kv"><span>Single-node mode</span><b>' + (st.single_node_mode ? 'Yes' : 'No') + '</b></div>' +
      '<p class="adm-note">A payload with a single synced copy is one disk failure away from total loss. ' +
      'Zero-copy items have no synced replica anywhere and need immediate attention. ' +
      (single > 0 ? 'Replication is still catching up on ' + num(single) + ' item(s).' : 'Every payload has at least two synced copies.') + '</p></div>'
  }

  function replicationCard (st) {
    var pending = (st.pending_files || 0) + (st.pending_notes || 0) + (st.pending_thumbnails || 0)
    var errors = (st.exhausted_error_files || 0) + (st.exhausted_error_notes || 0) + (st.exhausted_error_thumbnails || 0)
    var blocked = (st.blocked_files || 0) + (st.blocked_notes || 0) + (st.blocked_thumbnails || 0)
    var deletes = st.pending_remote_deletes || 0
    return '<div class="adm-card adm-st-panel"><div class="adm-card-head"><h3 class="adm-h3">Replication queue</h3>' +
      '<button class="rd-btn rd-btn-ghost" id="admRetryErrors">Retry errors</button></div>' +
      '<div class="adm-st-metrics">' +
      metricCell('Pending', num(pending), num(st.pending_files) + ' / ' + num(st.pending_notes) + ' / ' + num(st.pending_thumbnails), pending ? 'warn' : 'good') +
      metricCell('Exhausted', num(errors), num(st.exhausted_error_files) + ' / ' + num(st.exhausted_error_notes) + ' / ' + num(st.exhausted_error_thumbnails), errors ? 'bad' : '') +
      metricCell('Blocked', num(blocked), num(st.blocked_files) + ' / ' + num(st.blocked_notes) + ' / ' + num(st.blocked_thumbnails), blocked ? 'bad' : '') +
      '</div>' +
      '<div class="adm-kv"><span>Files with no readable replica</span><b>' + num(st.distinct_missing_files) + '</b></div>' +
      '<div class="adm-kv"><span>Pending remote deletes</span><b>' + num(deletes) + (st.stalled_remote_deletes ? ' (' + num(st.stalled_remote_deletes) + ' stalled)' : '') + '</b></div>' +
      '<div class="adm-kv"><span>Unverified checksum replicas</span><b>' + num(st.unverified_checksum_replicas) + '</b></div></div>'
  }

  function selectRow (id, label, options, current, help) {
    var opts = options.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(current) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'
    }).join('')
    return '<div class="adm-kv adm-kv-input"><span>' + esc(label) + (help ? '<br><small class="adm-mono">' + esc(help) + '</small>' : '') + '</span>' +
      '<select class="form-input" id="' + id + '">' + opts + '</select></div>'
  }

  function tuningCard () {
    var speedOpts = Object.keys(SPEEDS.presets || {}).map(function (k) {
      var p = SPEEDS.presets[k]
      return [k, k.toUpperCase() + ' — ' + p.batch + ' per batch, ~' + p.approx_per_min + '/min']
    })
    var sourceOpts = Object.keys(SOURCES.modes || {}).map(function (k) {
      return [k, k.replace(/_/g, ' ').toUpperCase() + ' — ' + (SOURCES.modes[k].description || '')]
    })
    var workerOpts = Object.keys(WORKERS.presets || {}).map(function (k) {
      return [k, WORKERS.presets[k].label + ' — ' + WORKERS.presets[k].desc]
    })
    var healthOpts = Object.keys(HEALTH.presets || {}).map(function (k) {
      return [k, HEALTH.presets[k].label + ' — ~' + HEALTH.presets[k].approx_per_day + '/day']
    })
    return '<div class="adm-card adm-st-panel adm-st-tune"><div class="adm-card-head"><h3 class="adm-h3">Replication tuning</h3>' +
      '<button class="rd-btn rd-btn-primary" id="admSaveTuning">Apply</button></div>' +
      selectRow('admSpeed', 'Transfer speed', speedOpts, SPEEDS.speed) +
      selectRow('admSource', 'Read source', sourceOpts, SOURCES.mode) +
      selectRow('admWorkers', 'Parallel workers', workerOpts, String(WORKERS.workers)) +
      selectRow('admHealth', 'Node health check interval', healthOpts, HEALTH.preset) +
      '<label class="adm-toggle"><span class="adm-toggle-txt"><b>Verify checksums on transfer</b>' +
      '<span>Re-hash every replica after it is written. Slower, but catches silent corruption.</span></span>' +
      '<span class="adm-switch"><input type="checkbox" id="admVerify"' + (SPEEDS._checksum ? ' checked' : '') + '><span class="adm-switch-track"></span></span></label></div>'
  }

  function addNodeCard () {
    return '<div class="adm-card adm-st-panel adm-st-add"><div class="adm-card-head"><h3 class="adm-h3">Add storage node</h3>' +
      '<span class="adm-mono">Starts a full backfill</span></div>' +
      '<div class="adm-st-fields">' +
      '<input class="form-input" id="admNodeName" placeholder="Node name" maxlength="100">' +
      '<select class="form-input" id="admNodeType"><option value="local">Local disk</option><option value="ssh">SSH / SFTP</option><option value="s3">S3 compatible</option></select>' +
      '<label class="adm-lbl adm-st-primary"><input type="checkbox" id="admNodePrimary"> Make primary</label></div>' +
      '<div id="admNodeFields" class="adm-st-fields"></div>' +
      '<div class="adm-st-add-foot"><button class="rd-btn rd-btn-primary" id="admNodeCreate">Add node</button></div></div>'
  }

  function nodeFields (type) {
    if (type === 'ssh') {
      return '<input class="form-input" data-cfg="hostname" placeholder="Hostname">' +
        '<input class="form-input" data-cfg="port" type="number" placeholder="22" value="22">' +
        '<input class="form-input" data-cfg="username" placeholder="Username">' +
        '<select class="form-input" data-cfg="auth_method"><option value="password">Password auth</option><option value="key">Key auth</option></select>' +
        '<input class="form-input" data-cfg="password" type="password" placeholder="Password (or leave blank for key auth)" autocomplete="new-password">' +
        '<input class="form-input" data-cfg="remote_path" placeholder="/opt/onegy-storage" value="/opt/onegy-storage">' +
        '<input class="form-input adm-st-span" data-cfg="host_key_sha256" placeholder="Pinned host key SHA-256 (required for password auth)">' +
        '<p class="adm-note adm-st-span">Password auth requires a pinned host key fingerprint so the first connection cannot be intercepted.</p>'
    }
    if (type === 's3') {
      return '<input class="form-input" data-cfg="bucket" placeholder="Bucket">' +
        '<input class="form-input" data-cfg="region" placeholder="us-east-1" value="us-east-1">' +
        '<input class="form-input" data-cfg="prefix" placeholder="Prefix (optional)">' +
        '<input class="form-input" data-cfg="endpoint_url" placeholder="https://endpoint (optional)">' +
        '<input class="form-input" data-cfg="access_key" placeholder="Access key" autocomplete="off">' +
        '<input class="form-input" data-cfg="secret_key" type="password" placeholder="Secret key" autocomplete="new-password">'
    }
    return '<input class="form-input adm-st-span" data-cfg="path" placeholder="Absolute path on this host">'
  }

  function purgeCard () {
    return '<div class="adm-card adm-st-panel"><div class="adm-card-head"><h3 class="adm-h3">Local disk reclaim</h3>' +
      '<button class="rd-btn rd-btn-ghost" id="admPurgeLocal">Purge local copies</button></div>' +
      '<div id="admPurgeStatus" class="adm-st-purge"><span class="adm-mono">Idle</span></div>' +
      '<p class="adm-note">Removes local payloads that are already synced to at least one remote node. ' +
      'Anything without a verified remote copy is skipped.</p></div>'
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
      parts.push('<div class="adm-st-bar adm-st-bar-plain"><span class="adm-st-bar-label">Tracked</span><span class="adm-st-bar-val">' + fmtBytes(tracked) + '</span></div>')
    }
    parts.push('<div class="adm-st-disk-sub adm-mono">' + esc(sub) + '</div>')
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
      if (box) box.innerHTML = '<div class="adm-st-disk-wait adm-mono">Disk stats unavailable</div>'
    })
  }

  function sectionHead (n, title, extra) {
    return '<div class="adm-st-sec"><div><div class="adm-st-kicker">' + n + '</div><h2 class="adm-h2">' + esc(title) + '</h2></div>' +
      (extra ? '<span class="adm-mono">' + extra + '</span>' : '') + '</div>'
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
      panel.innerHTML =
        '<div class="adm-toolbar"><h2 class="adm-h2">Storage<small>FLEET</small></h2>' +
        '<button class="rd-btn rd-btn-ghost" id="admStorageRefresh">Refresh</button></div>' +
        fleetKpis(nodes, st) +
        sectionHead('01', 'Nodes', nodes.length + ' configured') +
        '<div class="adm-st-nodes" id="storageNodeList">' +
          (cards || '<div class="adm-st-empty">No storage nodes configured — using local storage.</div>') +
        '</div>' +
        sectionHead('02', 'Fleet health') +
        '<div class="adm-grid2 adm-st-grid">' + residencyCard(st) + replicationCard(st) + '</div>' +
        sectionHead('03', 'Operations') +
        '<div class="adm-grid2 adm-st-grid">' + tuningCard() + purgeCard() + '</div>' +
        addNodeCard()
      var fields = $('admNodeFields')
      if (fields) fields.innerHTML = nodeFields('local')
      nodes.forEach(function (n) { loadNodeDisk(n.id, epoch) })
      pollPurge(true, epoch)
    } catch (e) { if (isCurrentRender('storage', epoch)) panel.innerHTML = errState('Could not load storage nodes.') }
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
        box.innerHTML = barRow(p.phase || 'Working', pct, (p.current || 0) + '/' + (p.total || 0) + ' · ' + fmtBytes(p.bytes_freed), '')
        if (!S.purgeTimer) S.purgeTimer = setInterval(function () { pollPurge(false, epoch) }, 2000)
      } else if (p.status === 'completed') {
        box.innerHTML = '<span class="adm-st-stamp is-good">Completed</span>' +
          '<span class="adm-mono">Freed ' + fmtBytes(p.bytes_freed) + ' · ' +
          num(p.purged_files) + ' files, ' + num(p.purged_notes) + ' notes, ' + num(p.purged_thumbnails) + ' thumbnails</span>'
        clearPurgeTimer()
      } else if (p.status === 'error') {
        box.innerHTML = '<span class="adm-st-stamp is-bad">Error</span><span class="adm-mono">' + esc(p.error || 'unknown') + '</span>'
        clearPurgeTimer()
      } else {
        box.innerHTML = '<span class="adm-mono">Idle</span>'
        clearPurgeTimer()
      }
    } catch (e) {
      if (!isCurrentRender('storage', epoch)) return
      if (once && box) box.innerHTML = '<span class="adm-mono">Idle</span>'
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
        })
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
      var d = S.stats || await jget('/admin/api/stats'); if (!isCurrentRender('statistics', epoch)) return; S.stats = d
      var o = d.overview || {}, st = d.storage || {}
      var det = d.details || {}
      var pairs = [
        ['Total users', o.total_users], ['Admin users', o.admin_users], ['Regular users', o.regular_users],
        ['Total files', o.total_files], ['Registered files', o.registered_files], ['Temp files', o.temp_files],
        ['Total folders', o.total_folders], ['Total downloads', o.total_downloads], ['Unique visitors', o.unique_visitors],
        ['App storage', (st.app_used_gb || 0) + ' GB'], ['Stored files', (st.total_file_size_gb || 0) + ' GB'],
        ['Disk used', (st.disk_percent || 0) + '%'], ['Disk free', (st.disk_free_gb || 0) + ' GB']
      ]
      var types = (det.file_types || []).map(function (t) {
        return '<div class="adm-kv"><span class="adm-mono">' + esc(t.ext || 'other') + '</span><b>' + num(t.count) + '</b></div>'
      }).join('')
      panel.innerHTML = '<div class="adm-toolbar"><h2 class="adm-h2">System statistics</h2>' + (d.history && d.history.latest_snapshot_at ? '<span class="adm-mono">snapshot ' + esc(d.history.latest_snapshot_at.slice(0, 16).replace('T', ' ')) + '</span>' : '') + '</div>' +
        '<div class="adm-statgrid">' + pairs.map(function (p) { return '<div class="adm-stat"><div class="adm-stat-label">' + esc(p[0]) + '</div><div class="adm-stat-val">' + esc(p[1] != null ? p[1] : '—') + '</div></div>' }).join('') + '</div>' +
        (types ? '<div class="adm-card" style="margin-top:1rem"><div class="adm-card-head"><h3 class="adm-h3">File types</h3></div>' + types + '</div>' : '') +
        '<div class="adm-card"><div class="adm-card-head"><h3 class="adm-h3">Music library</h3>' +
        '<button class="rd-btn rd-btn-ghost" id="admMusicRescan">Rescan library</button></div>' +
        '<p class="adm-note">Re-reads the music directory so newly added songs appear and deleted ones stop being listed. ' +
        'This also runs automatically on the cleanup schedule.</p></div>'
    } catch (e) { if (isCurrentRender('statistics', epoch)) panel.innerHTML = errState('Could not load statistics.') }
  }

  var TABS = { overview: tabOverview, users: tabUsers, 'temp-files': tabTemp, notifications: tabNotifs, feedback: tabFeedback, statistics: tabStats, storage: tabStorage, settings: tabSettings }
  function go (t) {
    clearPurgeTimer()
    clearSearchTimers()
    S.tab = t
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
    var nav = $('admNav'); if (nav) nav.classList.remove('is-open')
    var toggle = $('admNavToggle'); if (toggle) toggle.setAttribute('aria-expanded', 'false')
    ;(TABS[t] || tabOverview)(epoch)
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
    $('admNavToggle') && ($('admNavToggle').onclick = function () { var open = $('admNav').classList.toggle('is-open'); this.setAttribute('aria-expanded', open ? 'true' : 'false') })

    panel.addEventListener('click', function (e) {
      var t = e.target
      var epoch = S.renderEpoch
      var pg = t.closest('[data-page]'); if (pg) { var parts = pg.getAttribute('data-page').split(':'); if (parts[0] === 'users') { S.usersPage = +parts[1]; refreshTab('users', epoch) } else if (parts[0] === 'feedback') { S.fbPage = +parts[1]; refreshTab('feedback', epoch) } else { S.tempPage = +parts[1]; refreshTab('temp-files', epoch) } return }

      // --- Users ---
      var manage = t.closest('[data-user-manage]')
      if (manage) { S.selectedUserId = manage.getAttribute('data-user-manage'); refreshTab('users', epoch); return }
      if (t.closest('[data-user-close]')) { S.selectedUserId = null; refreshTab('users', epoch); return }
      if (t.closest('#admQuotaSave')) { saveUserQuota(t.closest('#admQuotaSave'), epoch); return }
      var ta = t.closest('[data-user-admin]')
      if (ta) {
        var willPromote = ta.getAttribute('data-is-admin') !== '1'
        confirmThen((willPromote ? 'Grant administrator access to ' : 'Remove administrator access from ') + (ta.getAttribute('data-name') || 'this account') + '?', function () {
          jsend('POST', '/admin/user/' + ta.getAttribute('data-user-admin') + '/toggle_admin', { expected_current: ta.getAttribute('data-is-admin') === '1' ? 1 : 0 })
            .then(function (d) { toast(d.username ? (d.username + ' IS NOW ' + (d.is_admin ? 'AN ADMIN' : 'A USER')) : 'UPDATED', 'success'); refreshTab('users', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT UPDATE ADMIN STATUS') })
        })
        return
      }
      var revoke = t.closest('[data-user-revoke]')
      if (revoke) {
        confirmThen('Sign out ' + revoke.getAttribute('data-name') + ' on every device and revoke all active API keys? Their data and password will not change.', function () {
          jsend('POST', '/admin/user/' + revoke.getAttribute('data-user-revoke') + '/revoke-access', {})
            .then(function (d) { toast('ACCESS REVOKED FOR ' + String(d.username || '').toUpperCase(), 'success'); refreshTab('users', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT REVOKE ACCESS') })
        })
        return
      }
      var td = t.closest('[data-user-del]')
      if (td) {
        confirmThen('Delete user "' + td.getAttribute('data-name') + '" and all their data? This cannot be undone.', function () {
          jsend('POST', '/admin/user/' + td.getAttribute('data-user-del') + '/delete', {})
            .then(function (d) { toast('DELETED USER ' + String(d.username || '').toUpperCase(), 'success'); refreshTab('users', epoch) })
            .catch(function (err) { failToast(err, 'USER DELETION FAILED') })
        })
        return
      }

      // --- Temp files ---
      var tmp = t.closest('[data-temp-del]')
      if (tmp) {
        confirmThen('Delete this temporary file?', function () {
          var fd2 = new FormData(); fd2.append('csrf_token', csrf())
          jsend('POST', '/delete/' + tmp.getAttribute('data-temp-del'), fd2, true)
            .then(function () { toast('DELETED', 'success'); refreshTab('temp-files', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT DELETE FILE') })
        })
        return
      }
      if (t.closest('#admCleanup')) {
        confirmThen('Run temp-file cleanup now?', function () {
          jsend('POST', '/admin/api/cleanup', {})
            .then(function () { toast('CLEANUP DONE', 'success'); refreshTab('temp-files', epoch) })
            .catch(function (err) { failToast(err, 'CLEANUP FAILED') })
        })
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
        })
        return
      }
      var fbdel = t.closest('[data-fb-del]')
      if (fbdel) {
        confirmThen('Delete this feedback?', function () {
          jsend('DELETE', '/admin/api/prompt-feedback/' + fbdel.getAttribute('data-fb-del'), null)
            .then(function () { toast('DELETED', 'success'); refreshTab('feedback', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT DELETE FEEDBACK') })
        })
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
        })
        return
      }
      if (t.closest('#admPurgeLocal')) {
        confirmThen('Purge local copies that are already mirrored to a remote node?', function () {
          jsend('POST', '/admin/api/storage/purge-local', {})
            .then(function () { toast('PURGE STARTED', 'success'); pollPurge(false, epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT START PURGE') })
        })
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
        })
        return
      }
      var ntoggle = t.closest('[data-node-toggle]')
      if (ntoggle) {
        var enable = ntoggle.getAttribute('data-enabled') === '0'
        confirmThen((enable ? 'Enable' : 'Disable') + ' this storage node?', function () {
          jsend('PUT', '/admin/api/storage/nodes/' + ntoggle.getAttribute('data-node-toggle'), { is_enabled: enable })
            .then(function () { toast(enable ? 'NODE ENABLED' : 'NODE DISABLED', 'success'); refreshTab('storage', epoch) })
            .catch(function (err) { failToast(err, 'COULD NOT UPDATE NODE') })
        })
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
    panel.querySelectorAll('[data-setting-num]').forEach(function (i) { if (i.value !== '') body[i.getAttribute('data-setting-num')] = parseFloat(i.value) })
    var button = $('admSaveSettings'); if (button) button.disabled = true
    jsend('POST', '/admin/api/settings', body)
      .then(function () { S.settingsDirty = false; toast('SETTINGS SAVED', 'success') })
      // Still dirty: keep Save usable so the same values can be retried.
      .catch(function (e) { if (button) button.disabled = false; failToast(e, 'COULD NOT SAVE SETTINGS') })
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

  function boot () { panel = $('admPanel'); if (!panel) return; wire(); var initial = window.location.hash.slice(1); go(TABS[initial] ? initial : 'overview') }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
