/* ============================================================================
   admin-music.js — Music tab of the admin console.
   A seven-view dashboard (Overview, Discovery, Rules, Priorities, Downloads,
   Connections, Limits) built from /admin/api/music, laid out like the Monitoring tab
   (.mon-* panels). admin.js (tabMusic) loads the data, polls it and wires the
   controls (data-music-* attributes); this file owns the markup and the view
   tabs.
   ========================================================================== */
(function () {
  'use strict'
  var H

  var BUCKETS = [[0, 'Requests'], [1, 'New releases and charts'], [2, 'Top 10s'], [3, 'Full discographies'],
    [4, 'Essentials'], [5, 'Other'], [6, 'Re-checks']]
  // Why a song is queued (MusicJob payload reason), for Up next.
  var REASONS = { 0: 'Request', 2: 'Top 10', 3: 'Discography', 4: 'Essentials', 5: 'Other' }
  var PROBLEMS = {
    no_ytm_track: 'Not found on YouTube Music',
    fp_mismatch: 'Audio did not match the song',
    duration_mismatch: 'Wrong length',
    download_failed: 'Download failed',
    removed: 'Removed from YouTube',
    region_locked: 'Blocked in this region',
    no_preview: 'No preview to check against',
    no_card: 'No longer on Deezer',
    no_audio_stream: 'No audio-only stream',
    decode_failed: 'Audio could not be read',
    upload_rejected: 'Not an audio-only file',
    source_error: 'A source did not answer',
    internal: 'Worker error',
    rate_limited: 'Waiting for a rate limit',
    lease_expired: 'Interrupted'
  }
  var VIEWS = [['overview', 'Overview'], ['discovery', 'Discovery'], ['rules', 'Rules'], ['priorities', 'Priorities'],
    ['downloads', 'Downloads'], ['connections', 'Connections'], ['limits', 'Limits']]
  // Follow modes, widest first: [value, label, colour in the roster bar]
  var MODES = [['everything', 'Everything', 'var(--kind-code)'], ['discography', 'Full discography', 'var(--accent)'],
    ['essentials', 'Essentials', 'var(--kind-media)'], ['top_tracks', 'Top tracks', 'var(--kind-image)'],
    ['new_only', 'New releases only', 'var(--kind-doc)'], ['off', 'Not followed', 'var(--line-strong)'],
    ['blocked', 'Blocked', 'var(--bad)']]
  var WEIGHTS = [[0.5, 'Low ×0.5'], [1, 'Normal'], [1.5, 'High ×1.5'], [2, 'Higher ×2'], [3, 'Very high ×3'], [5, 'Max ×5']]
  // Lowest follow mode whose new releases are queued whole (music_fresh_full_mode).
  var FRESH_MODES = [['top_tracks', 'Every followed artist'], ['essentials', 'Essentials and up'], ['discography', 'Full discography only']]
  // Download-order presets, sent as is to /admin/api/music/priorities. Balanced
  // matches the defaults in _SETTING_DEFAULTS.
  var PRESETS = [
    ['balanced', 'Balanced', 'Chart songs and big new releases first, then every artist\'s hits, then full catalogues.',
      { music_boost_chart: 3, music_boost_fresh: 2, music_weight_top10: 1.5, music_weight_essentials: 1, music_weight_discography: 0.6, music_fresh_days: 14, music_fresh_full_mode: 'essentials' }],
    ['new', 'New music first', 'New releases from every followed artist jump the queue and count as new for three weeks.',
      { music_boost_chart: 4, music_boost_fresh: 4, music_weight_top10: 1.2, music_weight_essentials: 0.8, music_weight_discography: 0.4, music_fresh_days: 21, music_fresh_full_mode: 'top_tracks' }],
    ['hits', 'Hits first', 'The most played songs of every era first; new releases get a small lift for a week.',
      { music_boost_chart: 2, music_boost_fresh: 1.3, music_weight_top10: 2.5, music_weight_essentials: 1.2, music_weight_discography: 0.4, music_fresh_days: 7, music_fresh_full_mode: 'discography' }],
    ['complete', 'Complete catalogues', 'Deep cuts weigh as much as hits, so whole discographies fill in sooner.',
      { music_boost_chart: 2, music_boost_fresh: 1.5, music_weight_top10: 1.2, music_weight_essentials: 1, music_weight_discography: 1, music_fresh_days: 14, music_fresh_full_mode: 'essentials' }]
  ]
  var view = (function () { try { return sessionStorage.getItem('adm-mu-view') || 'overview' } catch (e) { return 'overview' } })()

  function modeLabel (m) { var x = MODES.filter(function (r) { return r[0] === m })[0]; return x ? x[1] : (m || 'Not followed') }
  function ago (seconds) {
    if (seconds == null) return 'never'
    if (seconds < 60) return 'just now'
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago'
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago'
    return Math.floor(seconds / 86400) + ' d ago'
  }
  function sinceIso (iso) {
    var t = Date.parse(iso || '')
    return isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 1000))
  }
  function sw (attrs, on, label, disabled) {
    return '<input type="checkbox" class="rd-switch" role="switch" ' + attrs + (on ? ' checked' : '') + (disabled ? ' disabled' : '') +
      ' aria-label="' + H.esc(label) + '">'
  }
  function sum (arr) { return arr.reduce(function (a, b) { return a + (b || 0) }, 0) }

  // Each connection (this server, each proxy that is on) has its own daily limit.
  function dailyLimit (d) {
    var conns = (d.direct ? 1 : 0) + d.proxies.filter(function (p) { return p.enabled }).length
    return d.limits.daily * conns
  }

  // ---- Building blocks (same markup as admin-monitor.js) ----------------------
  // o: { note (after the title), meta (html, right), tip (hover text), cls, flush }
  function panel (title, body, o) {
    o = o || {}
    return '<section class="rd-panel mon-p' + (o.cls ? ' ' + o.cls : '') + '">' +
      '<header class="mon-p-head"' + (o.tip ? ' title="' + H.esc(o.tip) + '"' : '') + '><h3>' + H.esc(title) + (o.note ? ' <small>' + H.esc(o.note) + '</small>' : '') + '</h3>' +
      (o.meta ? '<span class="mon-p-meta">' + o.meta + '</span>' : '') + '</header>' +
      '<div class="mon-p-body' + (o.flush ? ' is-flush' : '') + '">' + body + '</div></section>'
  }
  function stackBar (segments) {
    var total = sum(segments.map(function (x) { return x.value }))
    var bar = segments.map(function (x) {
      return x.value && total ? '<span style="flex-grow:' + x.value + ';background:' + x.color + '" title="' + H.esc(x.label + ': ' + H.num(x.value)) + '"></span>' : ''
    }).join('')
    var legend = segments.map(function (x) {
      return x.value ? '<span class="mon-legend-item"><i style="background:' + x.color + '"></i>' + H.esc(x.label) + ' <b>' + H.num(x.value) + '</b></span>' : ''
    }).join('')
    return '<div class="mon-stack" role="img" aria-label="' + H.esc(segments.map(function (x) { return x.label + ' ' + x.value }).join(', ')) + '">' +
      (bar || '<span style="flex-grow:1;background:var(--press)"></span>') + '</div><div class="mon-legend">' + legend + '</div>'
  }
  function row (label, value, tone) {
    return '<div class="mon-row"><span>' + label + '</span><b' + (tone ? ' class="is-' + tone + '"' : '') + '>' + value + '</b></div>'
  }
  function table (head, rows) {
    return '<div class="rd-table-wrap"><table class="rd-table is-stack mon-table mu-adm-table"><thead><tr>' +
      head.map(function (h) { return '<th' + (h[1] ? ' class="is-num"' : '') + '>' + H.esc(h[0]) + '</th>' }).join('') +
      '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'
  }

  // ---- Status ------------------------------------------------------------------
  function headline (d) {
    var online = d.workers.filter(function (w) { return w.online })
    var s = d.switches
    if (!online.length) return { tone: 'bad', text: 'No music worker is running' }
    if (!s.discovery && !s.downloads) return { tone: 'warn', text: 'Paused' }
    var downloaders = online.filter(function (w) { return w.download_enabled })
    if (s.downloads && !downloaders.length) return { tone: 'warn', text: 'No worker is set to download' }
    if (s.downloads && downloaders.some(function (w) { return /^Downloading/.test(w.download_status || '') })) return { tone: 'good', text: 'Adding songs' }
    if (!s.downloads) return { tone: 'good', text: 'Discovering only' }
    if (!s.discovery) return { tone: 'good', text: 'Downloading only' }
    return { tone: 'good', text: 'Up to date' }
  }

  function leaderOf (d) { return d.workers.filter(function (w) { return w.runs_discovery })[0] }
  function downloaderOf (d) {
    return d.workers.filter(function (w) { return w.online && w.download_enabled && /^Downloading/.test(w.download_status || '') })[0] ||
      d.workers.filter(function (w) { return w.online && w.download_enabled })[0]
  }
  function discoveryLine (d) {
    var leader = leaderOf(d)
    return d.switches.discovery ? (leader ? leader.discover_status || 'Starting' : 'No worker is set to discover') : 'Off'
  }
  function downloadLine (d) {
    var dl = downloaderOf(d)
    return d.switches.downloads ? (dl ? dl.download_status || 'Starting' : 'No worker is set to download') : 'Off'
  }
  function attention (d) { return sum(d.problems.map(function (p) { return p.count })) }
  function capBytes (d) { return d.limits.size_gb * Math.pow(1024, 3) }

  // [id, label, value, tone, view]; tone: good | warn | bad | idle
  function checks (d) {
    var online = d.workers.filter(function (w) { return w.online }).length
    var on = d.proxies.filter(function (p) { return p.enabled })
    var failing = on.filter(function (p) { return p.status === 'failing' }).length
    var conns = (d.direct ? 1 : 0) + on.length
    var fill = capBytes(d) ? d.library.bytes / capBytes(d) : 0
    var att = attention(d)
    return [
      ['workers', 'Workers', online + ' of ' + d.workers.length + ' online', online ? 'good' : 'bad', 'connections'],
      ['discovery', 'Discovery', d.switches.discovery ? (leaderOf(d) ? 'On' : 'No worker') : 'Off',
        !d.switches.discovery ? 'idle' : leaderOf(d) ? 'good' : 'warn', 'discovery'],
      ['downloads', 'Downloads', d.switches.downloads ? (downloaderOf(d) ? 'On' : 'No worker') : 'Off',
        !d.switches.downloads ? 'idle' : downloaderOf(d) ? 'good' : 'warn', 'downloads'],
      ['roster', 'Artists', H.num(d.roster.monitored) + ' followed', d.roster.monitored ? 'good' : 'idle', 'discovery'],
      ['failing', 'Failures', att ? H.num(att) + ' retrying' : 'None', att ? 'warn' : 'good', 'downloads'],
      ['size', 'Library size', Math.round(fill * 100) + '% of limit', fill >= 1 ? 'bad' : fill >= 0.9 ? 'warn' : 'good', 'limits'],
      ['connections', 'Connections', conns ? conns + (failing ? ', ' + failing + ' failing' : ' in use') : 'None',
        !conns ? 'bad' : failing ? 'warn' : 'good', 'connections']
    ]
  }

  function control (key, title, sub, on, lines, suffix) {
    var id = 'muSw_' + key + (suffix || '')
    return '<label class="mu-adm-control" for="' + id + '">' +
      '<span class="mu-adm-control-text"><span class="mu-adm-control-title">' + H.esc(title) + '</span>' +
      '<span class="mu-adm-control-sub">' + H.esc(sub) + '</span>' +
      lines.map(function (l) { return '<span class="mu-adm-control-line">' + l + '</span>' }).join('') + '</span>' +
      sw('id="' + id + '" data-music-switch="' + key + '"', on, title) + '</label>'
  }
  function discoveryControl (d, suffix) {
    var built = sinceIso(d.roster.built_at)
    return control('music_discovery_enabled', 'Discovery', 'Finds popular artists, their catalogues and new releases.', d.switches.discovery,
      [H.esc(discoveryLine(d)), '<span class="mu-adm-faint">' + H.num(d.roster.monitored) + ' artists followed' + (built != null ? ' · ranked ' + ago(built) : '') + '</span>'], suffix)
  }
  function downloadControl (d, suffix) {
    return control('music_downloads_enabled', 'Downloads', 'Downloads, checks and publishes the songs discovery queues.', d.switches.downloads,
      [H.esc(downloadLine(d)), '<span class="mu-adm-faint">' + H.num(d.library.added_today) + ' added today · limit ' + H.num(dailyLimit(d)) + ' a day</span>'], suffix)
  }

  function statusStrip (d, rows) {
    var h = headline(d)
    var passing = rows.filter(function (r) { return r[3] === 'good' }).length
    var cells = rows.map(function (r) {
      return '<button type="button" class="mon-check is-' + r[3] + '" id="mu-check-' + r[0] + '" data-music-view="' + r[4] + '">' +
        '<span class="mon-check-label"><span class="mon-dot" aria-hidden="true"></span>' + H.esc(r[1]) + '</span>' +
        '<span class="mon-check-val">' + H.esc(r[2]) + '</span></button>'
    }).join('')
    return '<section class="rd-panel mon-status is-' + h.tone + '" aria-label="Music pipeline status">' +
      '<div class="mon-status-head"><span class="mon-status-mark" aria-hidden="true"></span><h2>' + H.esc(h.text) + '</h2>' +
      '<span class="mon-p-meta">' + passing + ' of ' + rows.length + ' checks passing</span></div>' +
      '<div class="mon-checks">' + cells + '</div>' +
      '<div class="mu-adm-controls">' + discoveryControl(d) + downloadControl(d) + '</div></section>'
  }

  function stats (d) {
    var att = attention(d), cap = capBytes(d)
    function stat (id, label, value, sub, target, tone) {
      return '<button type="button" class="mon-stat mu-adm-stat' + (tone ? ' is-' + tone : '') + '" id="mu-stat-' + id + '" data-music-view="' + target + '">' +
        '<span class="mon-stat-label">' + H.esc(label) + '</span>' +
        '<span class="mon-stat-top"><span class="mon-stat-val">' + H.esc(value) + '</span></span><span class="mon-stat-sub">' + sub + '</span></button>'
    }
    return '<div class="mon-stats">' +
      stat('songs', 'Songs', H.num(d.library.songs), H.num(d.library.artists) + ' artists · ' + H.num(d.library.albums) + ' albums', 'downloads') +
      stat('size', 'Library size', H.fmtBytes(d.library.bytes), 'of ' + H.fmtBytes(cap) + ' limit', 'limits', d.library.bytes >= cap ? 'bad' : '') +
      stat('followed', 'Artists followed', H.num(d.roster.monitored), H.num(d.roster.artists) + ' ranked · ' + H.num(d.roster.due) + ' scans due', 'discovery') +
      stat('queued', 'Queued', H.num(d.queue.total), H.num(d.queue.working) + ' in progress', 'downloads') +
      stat('today', 'Added today', H.num(d.library.added_today), 'of ' + H.num(dailyLimit(d)) + ' a day', 'limits') +
      stat('attention', 'Need attention', H.num(att), att ? 'Retried automatically' : 'Nothing failing', 'downloads', att ? 'warn' : '') +
      '</div>'
  }

  function activity (d) {
    var built = sinceIso(d.roster.built_at), charts = sinceIso(d.roster.charts_at)
    var workerRows = d.workers.filter(function (w) { return w.online }).map(function (w) {
      return '<div class="mon-block"><div class="mon-row"><span><b class="mu-adm-strong">' + H.esc(w.name) + '</b>' + (w.runs_discovery ? ' <small>runs discovery</small>' : '') + '</span>' +
        '<b>' + H.num(w.added_today) + ' today</b></div>' +
        '<span class="mon-sub">Discover: ' + H.esc(w.discover_enabled ? w.discover_status || '' : 'Off on this worker') + '</span>' +
        '<span class="mon-sub">Download: ' + H.esc(w.download_enabled ? w.download_status || '' : 'Off on this worker') + '</span></div>'
    }).join('')
    var body = (workerRows || '<p class="mon-sub">No worker is online.</p>') +
      '<div class="mon-block">' + row('Artists ranked', ago(built)) + row('Charts checked', ago(charts)) + row('Artist scans due', H.num(d.roster.due)) + '</div>'
    return panel('Activity', body, { tip: 'What each online worker is doing now, and when discovery last ran its schedules.' })
  }

  function queue (d) {
    var counts = BUCKETS.map(function (b) { return [b[1], d.queue.buckets[b[0]] || 0] }).filter(function (r) { return r[1] })
    var max = counts.reduce(function (m, r) { return Math.max(m, r[1]) }, 0)
    var body = counts.length ? counts.map(function (r) {
      return '<div class="mon-block">' + row(H.esc(r[0]), H.num(r[1])) +
        '<div class="adm-meter"><div class="adm-meter-fill" style="width:' + Math.max(2, Math.round(r[1] / max * 100)) + '%"></div></div></div>'
    }).join('') : '<p class="mon-sub">' + (d.switches.discovery ? 'Nothing queued. Discovery adds songs as it finds them.' : 'Nothing queued. Turn on discovery to find songs.') + '</p>'
    return panel('Queue', body, { meta: H.num(d.queue.total) + ' songs', tip: 'Why songs are queued. Downloads go by score across all groups: set the order under Priorities.' })
  }

  // ---- Discovery -------------------------------------------------------------------
  function roster (d) {
    var segs = MODES.map(function (m) { return { label: m[1], value: d.roster.modes[m[0]] || 0, color: m[2] } })
    var body = stackBar(segs) +
      '<div class="mon-block">' + row('Artists ranked', H.num(d.roster.artists)) + row('Followed', H.num(d.roster.monitored)) +
      row('Scans due now', H.num(d.roster.due)) + row('Last ranking', ago(sinceIso(d.roster.built_at))) +
      row('Charts checked', ago(sinceIso(d.roster.charts_at))) + '</div>'
    return panel('Roster', body, { meta: H.num(d.roster.artists) + ' artists', tip: 'Every artist discovery knows, by how much of their music it follows.' })
  }

  function howItWorks (d) {
    // Mirrors roster_tiers(), ROSTER_EVERY, CHARTS_EVERY, CHART_FLOOR_DAYS and the floors in src/music_worker/080_discovery.py.
    var p = d.priorities
    var tiers = [[p.music_tier_discography, 'Full discography.'], [p.music_tier_essentials, 'Essentials: top 25 songs and their albums.'],
      [p.music_tier_top_tracks, 'Top 10 songs.']]
    var from = 1, steps = [['Weekly ranking', 'Top 1,000 artists on ListenBrainz (all time and this year), the Deezer chart and boosted genres, scored by listens and Deezer fans, times your weights.']]
    tiers.forEach(function (t) {
      if (t[0] >= from) steps.push(['Ranks ' + H.num(from) + '–' + H.num(t[0]), t[1]])
      from = Math.max(from, t[0] + 1)
    })
    var full = FRESH_MODES.filter(function (m) { return m[0] === p.music_fresh_full_mode })[0]
    steps.push(['Floors', 'Artists of liked or playlisted songs get at least Essentials; artists with a chart song in the last 90 days at least Top tracks.'],
      ['Every 6 h', 'Chart songs (Deezer and Apple, US, GB, CA, AU) are queued and boosted.'],
      ['New releases', 'Checked daily for active artists. Whole releases: ' + (full ? full[1].toLowerCase() : 'essentials and up') + '; other artists once a new song reaches their top tracks.'],
      ['Download order', 'One score per song: popularity × why it is wanted × artist and genre weight × boosts. Set it under Priorities.'],
      ['Rules', 'An artist rule replaces the mode discovery picked. A weight multiplies the score of all their songs.'])
    return panel('How discovery picks songs', '<dl class="mu-adm-steps">' + steps.map(function (s) {
      return '<div><dt>' + H.esc(s[0]) + '</dt><dd>' + H.esc(s[1]) + '</dd></div>'
    }).join('') + '</dl>')
  }

  function modeCell (a) {
    return '<span class="mu-adm-mode">' + H.esc(modeLabel(a.mode)) + (a.rule_mode ? ' ' + H.pill('Rule', 'accent') : '') +
      (a.rule_weight !== 1 ? ' ' + H.pill('×' + a.rule_weight, a.rule_weight > 1 ? 'accent' : '') : '') + '</span>'
  }
  function artistName (a) {
    return '<span class="mon-node"><b>' + H.esc(a.name) + '</b><span>' + H.esc((a.genres || '').split(',').filter(Boolean).join(', ') || (a.seeds ? 'From ' + a.seeds.replace(/,/g, ', ') : '')) + '</span></span>'
  }

  function topArtists (d) {
    var rows = d.roster.top.map(function (a, i) {
      return '<tr><td class="is-num" data-label="Rank">' + (i + 1) + '</td><td data-label="Artist">' + artistName(a) + '</td>' +
        '<td data-label="Follows">' + modeCell(a) + '</td>' +
        '<td class="is-num" data-label="Score">' + a.score.toFixed(2) + '</td>' +
        '<td class="is-num" data-label="Have">' + H.num(a.have) + '</td><td class="is-num" data-label="Queued">' + H.num(a.wanted) + '</td>' +
        '<td class="is-num" data-label="Scanned">' + ago(sinceIso(a.scanned_at)) + '</td>' +
        '<td data-label=""><button type="button" class="rd-btn rd-btn-sm rd-btn-ghost" data-music-rule-for="' + H.esc(a.name) + '">Set rule</button></td></tr>'
    })
    var body = rows.length
      ? table([['#', 1], ['Artist'], ['Follows'], ['Score', 1], ['Have', 1], ['Queued', 1], ['Scanned', 1], ['']], rows)
      : '<p class="mon-sub mon-foot">No artists ranked yet. Turn on discovery: the first ranking takes about 10 minutes.</p>'
    return panel('Top artists', body, { flush: true, meta: 'Top ' + d.roster.top.length + ' by score',
      tip: 'Score = popularity (listens, fans, charts) times the artist and genre weights. Have = songs in the library.' })
  }

  // ---- Rules -----------------------------------------------------------------------
  function select (attrs, options, value, label) {
    var known = options.some(function (o) { return String(o[0]) === String(value) })
    if (!known) options = options.concat([[value, '×' + value]])
    return '<select class="form-input mu-adm-select" ' + attrs + ' aria-label="' + H.esc(label) + '">' + options.map(function (o) {
      return '<option value="' + H.esc(o[0]) + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + H.esc(o[1]) + '</option>'
    }).join('') + '</select>'
  }
  function ruleRow (a) {
    var modes = [['', 'Auto (' + modeLabel(a.rule_mode ? null : a.mode) + ')']].concat(MODES.map(function (m) { return [m[0], m[1]] }))
    if (a.rule_mode) modes[0][1] = 'Auto (discovery decides)'
    return '<tr><td data-label="Artist">' + artistName(a) + '</td>' +
      '<td data-label="Mode">' + select('data-music-artist="' + a.id + '" data-music-field="mode"', modes, a.rule_mode || '', 'Mode for ' + a.name) + '</td>' +
      '<td data-label="Weight">' + select('data-music-artist="' + a.id + '" data-music-field="weight"', WEIGHTS, a.rule_weight, 'Weight for ' + a.name) + '</td>' +
      '<td class="is-num" data-label="Have">' + H.num(a.have) + '</td>' +
      '<td data-label="">' + (a.rule_mode || a.rule_weight !== 1
        ? '<button type="button" class="rd-icon-btn adm-icon-btn adm-icon-danger" data-music-artist-clear="' + a.id + '" title="Remove rule" aria-label="Remove rule for ' + H.esc(a.name) + '">' + H.trash + '</button>' : '') + '</td></tr>'
  }
  var RULE_HEAD = [['Artist'], ['Mode'], ['Weight'], ['Have', 1], ['']]

  function artistRules (d) {
    var r = d.rules
    var search = H.searchBox('muArtistSearch', 'Search artists', 'Search ranked artists, e.g. Drake', H.q || '')
    var found = ''
    if (r.search) {
      found = r.search.length
        ? table(RULE_HEAD, r.search.map(ruleRow))
        : '<p class="mon-sub mon-foot">No ranked artist matches "' + H.esc(H.q) + '". Only artists discovery has ranked can get a rule here.</p>'
    }
    var list = r.artists.length
      ? '<h4 class="mu-adm-sub">Artists with a rule</h4>' + table(RULE_HEAD, r.artists.map(ruleRow))
      : '<p class="mon-sub mon-foot">No artist rules yet. Search for an artist to boost, limit or block them.</p>'
    return panel('Artist rules', '<div class="mu-adm-pad">' + search + '</div>' + found + list,
      { flush: true, meta: H.num(r.artists.length) + ' rules', tip: 'A mode replaces what discovery picked for the artist. The weight multiplies their ranking score and the download score of all their songs. Any rule lifts the per-artist song limit. Applies on the artist\'s next scan, which starts at once.' })
  }

  function genreRules (d) {
    var r = d.rules
    var opts = [[0, 'Blocked']].concat(WEIGHTS)
    var rows = r.genres.map(function (g) {
      return '<tr><td data-label="Genre"><b class="mu-adm-strong">' + H.esc(g.genre) + '</b></td>' +
        '<td data-label="Weight">' + select('data-music-genre="' + H.esc(g.genre) + '"', opts, g.weight, 'Weight for ' + g.genre) + '</td>' +
        '<td data-label=""><button type="button" class="rd-icon-btn adm-icon-btn adm-icon-danger" data-music-genre-remove="' + g.id + '" data-name="' + H.esc(g.genre) + '" title="Remove" aria-label="Remove ' + H.esc(g.genre) + '">' + H.trash + '</button></td></tr>'
    })
    var add = '<div class="mu-adm-pad mu-adm-genre-add">' +
      '<label class="sr-only" for="muGenreName">Genre</label><input class="form-input" id="muGenreName" list="muGenreHints" placeholder="Genre, e.g. Rap/Hip Hop" autocomplete="off" maxlength="64">' +
      '<datalist id="muGenreHints">' + r.genre_hints.map(function (g) { return '<option value="' + H.esc(g) + '">' }).join('') + '</datalist>' +
      select('id="muGenreWeight"', opts, 1.5, 'Weight') +
      '<button type="button" class="rd-btn rd-btn-sm rd-btn-primary" data-music-genre-add>Add</button></div>'
    var body = add + (rows.length ? table([['Genre'], ['Weight'], ['']], rows)
      : '<p class="mon-sub mon-foot">No genre rules. High and Max also add the genre\'s top Deezer artists to the ranking.</p>')
    return panel('Genre rules', body, { flush: true, meta: H.num(r.genres.length) + ' rules',
      tip: 'Deezer genre names. Blocked stops discovery of artists in the genre (an artist rule still wins). Applies at the next weekly ranking.' })
  }

  // ---- Priorities ----------------------------------------------------------------------
  function presetOf (p) {
    var hit = PRESETS.filter(function (x) {
      return Object.keys(x[3]).every(function (k) { return String(p[k]) === String(x[3][k]) })
    })[0]
    return hit || null
  }
  function fieldRow (key, label, hint, control) {
    return '<div class="rd-field-row"><div class="rd-field-text"><label class="rd-field-label" for="muPrio_' + key + '">' + H.esc(label) + '</label>' +
      '<p class="rd-field-hint">' + H.esc(hint) + '</p></div><div class="adm-inline">' + control + '</div></div>'
  }
  function prioField (p, key, label, hint, min, max, step, unit) {
    var input = '<input class="form-input adm-num-input" type="number" id="muPrio_' + key + '" min="' + min + '" max="' + max + '" step="' + step + '"' +
      ' data-music-prio="' + key + '" value="' + H.esc(p[key]) + '">'
    return fieldRow(key, label, hint, unit === '×' ? '<span class="adm-unit">×</span>' + input : input + '<span class="adm-unit">' + H.esc(unit) + '</span>')
  }

  function presets (d) {
    var active = presetOf(d.priorities)
    var buttons = PRESETS.map(function (x) {
      var on = active && active[0] === x[0]
      return '<button type="button" class="rd-btn rd-btn-sm ' + (on ? 'rd-btn-primary' : 'rd-btn-ghost') + '" data-music-preset="' + x[0] + '" aria-pressed="' + !!on + '">' + H.esc(x[1]) + '</button>'
    }).join('')
    var body = '<div class="mu-adm-pad mu-adm-stack"><div class="mu-adm-presets" role="group" aria-label="Presets">' + buttons + '</div>' +
      '<p class="mon-sub">' + H.esc(active ? active[2] : 'Custom: your own mix of the values below.') + '</p>' +
      '<p class="mon-sub">Every queued song gets one score: how popular it is on Deezer × why it is wanted × the artist and genre weights × any boost. ' +
      'The highest score downloads first, so a hit from any artist beats a deep cut, and a new single from a big artist beats one from an unknown.</p></div>'
    return panel('Download order', body, { meta: active ? active[1] : 'Custom', tip: 'Changes apply to the whole queue within a minute.' })
  }

  function upNext (d) {
    var rows = d.up_next.map(function (s, i) {
      var tags = (s.chart ? H.pill('Chart', 'accent') : '') + (s.fresh ? H.pill('New', 'accent') : '') + H.pill(REASONS[s.reason] || 'Other')
      return '<li class="mu-adm-song"><span class="mu-adm-rank">' + (i + 1) + '</span>' +
        '<span class="mu-adm-song-text"><b>' + H.esc(s.title || '') + '</b><span>' + H.esc(s.artist || '') + (s.album ? ' · ' + H.esc(s.album) : '') + '</span></span>' +
        '<span class="mu-adm-tags">' + tags + '</span><span class="mu-adm-faint" title="Score">' + H.num(s.score) + '</span></li>'
    }).join('')
    return panel('Up next', rows ? '<ol class="mu-adm-songs">' + rows + '</ol>'
      : '<p class="mon-sub mon-foot">Nothing is waiting. Songs waiting for a retry or a rate limit are not listed.</p>',
    { flush: true, meta: 'Next ' + d.up_next.length, tip: 'The songs downloaded next, highest score first. New and Chart mark a running boost.' })
  }

  function priorities (d) {
    var p = d.priorities
    var modes = FRESH_MODES.map(function (m) {
      return '<option value="' + m[0] + '"' + (m[0] === p.music_fresh_full_mode ? ' selected' : '') + '>' + H.esc(m[1]) + '</option>'
    }).join('')
    var boosts = prioField(p, 'music_boost_chart', 'Chart songs', 'Songs on the Deezer or Apple charts, until the day after they leave.', 1, 10, 0.1, '×') +
      prioField(p, 'music_boost_fresh', 'New releases', 'Until Deezer has play counts, a new song also counts as popular as the artist\'s usual hit.', 1, 10, 0.1, '×') +
      prioField(p, 'music_fresh_days', 'Counts as new for', 'Days after the release date.', 1, 90, 1, 'days') +
      fieldRow('music_fresh_full_mode', 'Whole new releases from', 'Below this, a new song is queued once it reaches the artist\'s top tracks.',
        '<select class="form-input mu-adm-select" id="muPrio_music_fresh_full_mode" data-music-prio="music_fresh_full_mode">' + modes + '</select>')
    var reasons = prioField(p, 'music_weight_top10', 'Top 10 songs', 'Each followed artist\'s ten most played songs.', 0.1, 10, 0.1, '×') +
      prioField(p, 'music_weight_essentials', 'Essentials', 'Songs 11 to 25 and the albums behind an artist\'s hits.', 0.1, 10, 0.1, '×') +
      prioField(p, 'music_weight_discography', 'Full discographies', 'Every other album, EP and single of the top-ranked artists.', 0.1, 10, 0.1, '×')
    var follow = prioField(p, 'music_tier_discography', 'Full discography', 'Artists ranked up to here follow their whole catalogue.', 0, 100000, 1, 'artists') +
      prioField(p, 'music_tier_essentials', 'Essentials', 'Ranked up to here: essentials.', 0, 100000, 1, 'artists') +
      prioField(p, 'music_tier_top_tracks', 'Top tracks', 'Ranked up to here: top 10 songs.', 0, 100000, 1, 'artists') +
      prioField(p, 'music_artist_song_cap', 'Songs per artist', 'Held plus queued; 0 means no limit. An artist rule lifts it.', 0, 100000, 1, 'songs')
    return presets(d) +
      '<div class="mon-cols is-2">' + panel('Boosts', boosts, { meta: 'Saved as you change a value' }) +
      panel('Why a song is wanted', reasons, { meta: 'Saved as you change a value', tip: 'Each multiplies the popularity of songs queued for that reason.' }) + '</div>' +
      '<div class="mon-cols is-2">' + upNext(d) +
      panel('Who is followed', follow, { meta: H.num(d.roster.artists) + ' ranked', tip: 'Follow modes by rank in the weekly ranking. Applies at the next ranking, which starts within a minute.' }) + '</div>'
  }

  // ---- Downloads -----------------------------------------------------------------------
  function problems (d) {
    var body = d.problems.length ? d.problems.map(function (p) { return row(H.esc(PROBLEMS[p.code] || p.code), H.num(p.count), 'warn') }).join('')
      : '<p class="mon-sub">Nothing needs attention. Songs that fail are retried automatically.</p>'
    var foot = d.queue.retrying ? '<div class="mon-block mu-adm-row-end"><span class="mon-sub">' + H.num(d.queue.retrying) + ' songs wait for their next try.</span>' +
      '<button class="rd-btn rd-btn-sm rd-btn-ghost" data-music-retry>' + H.refresh + 'Retry now</button></div>' : ''
    return panel('Needs attention', body + foot, { meta: H.num(attention(d)) + ' songs', tip: 'Songs that could not be added yet, by reason.' })
  }

  function recent (d) {
    var rows = d.library.recent.map(function (s) {
      var m = /^covers\/([\w-]+)\.jpg$/.exec(s.cover_path || '')
      var cover = m ? '<img class="mu-adm-cover" src="/music/cover/' + encodeURIComponent(m[1]) + '" alt="" loading="lazy">' : '<span class="mu-adm-cover"></span>'
      return '<li class="mu-adm-song">' + cover + '<span class="mu-adm-song-text"><b>' + H.esc(s.title) + '</b><span>' + H.esc(s.artist || '') + '</span></span>' +
        '<span class="mu-adm-faint">' + ago(sinceIso(s.added)) + '</span></li>'
    }).join('')
    return panel('Recently added', rows ? '<ul class="mu-adm-songs">' + rows + '</ul>' : '<p class="mon-sub mon-foot">No songs yet. New songs appear here as they are published.</p>',
      { flush: true, meta: H.num(d.library.added_today) + ' today' })
  }

  function sources (d) {
    var rows = d.sources.map(function (s) {
      var paused = !!s.paused_until
      return '<tr><td data-label="Source"><b class="mu-adm-strong">' + H.esc(s.source) + '</b></td>' +
        '<td class="is-num" data-label="Requests">' + H.num(s.used) + '</td>' +
        '<td class="is-num' + (s.errors ? ' is-warn' : ' is-zero') + '" data-label="Errors">' + H.num(s.errors) + '</td>' +
        '<td class="is-num" data-label="Speed">' + (s.slow > 1 ? '×' + (1 / s.slow).toFixed(2) : 'Full') + '</td>' +
        '<td data-label="Status">' + (paused ? H.pill('Paused until ' + new Date(s.paused_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 'warn', true) : H.pill('OK', 'good', true)) + '</td></tr>'
    })
    return panel('Sources today', rows.length ? table([['Source'], ['Requests', 1], ['Errors', 1], ['Speed', 1], ['Status']], rows)
      : '<p class="mon-sub mon-foot">No requests today.</p>', { flush: true, tip: 'Requests to each metadata and download source today, summed over every connection. Speed drops after rate-limit answers and recovers by itself.' })
  }

  // ---- Connections -------------------------------------------------------------------
  function proxyRow (p) {
    var tone = !p.enabled ? 'idle' : p.status === 'ok' ? 'good' : p.status === 'failing' ? 'bad' : 'idle'
    var detail = !p.enabled ? 'Off'
      : p.status === 'failing' ? 'Not connecting' + (p.last_error ? ': ' + p.last_error : '') + (p.paused_until ? ' · retries ' + new Date(p.paused_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
        : p.status === 'new' ? 'Not used yet'
          : H.num(p.downloads_today) + ' songs · ' + H.num(p.requests_today) + ' lookups today'
    return '<div class="mu-adm-proxy is-' + tone + '"><span class="mon-dot" aria-hidden="true"></span>' +
      '<span class="mu-adm-proxy-text"><span class="mu-adm-proxy-label">' + H.esc(p.label) + '</span><span class="mu-adm-job-state">' + H.esc(detail) + '</span></span>' +
      sw('data-music-proxy="' + p.id + '"', p.enabled, 'Use ' + p.label) +
      '<button class="rd-icon-btn adm-icon-btn adm-icon-danger" data-music-proxy-remove="' + p.id + '" data-name="' + H.esc(p.label) + '" title="Remove" aria-label="Remove ' + H.esc(p.label) + '">' + H.trash + '</button></div>'
  }

  function proxies (d) {
    var on = d.proxies.filter(function (p) { return p.enabled })
    var failing = on.filter(function (p) { return p.status === 'failing' }).length
    var direct = '<label class="mu-adm-job" for="muSw_music_proxy_direct"><span><span class="mu-adm-job-title">This server\'s own connection</span>' +
      '<span class="mu-adm-job-state">' + (d.direct ? 'Used alongside the proxies' : 'Not used: all traffic goes through proxies') + '</span></span>' +
      sw('id="muSw_music_proxy_direct" data-music-switch="music_proxy_direct"', d.direct, 'Use this server\'s own connection') + '</label>'
    var list = d.proxies.length ? '<div class="mu-adm-proxies">' + d.proxies.map(proxyRow).join('') + '</div>' : ''
    var add = '<div class="mu-adm-proxy-add"><label class="rd-field-label" for="muProxyText">Add proxies</label>' +
      '<textarea class="form-input mu-adm-proxy-input" id="muProxyText" rows="3" spellcheck="false" autocomplete="off" placeholder="socks5://user:pass@host:port&#10;host:port&#10;host:port:user:pass">' + H.esc(H.proxyDraft || '') + '</textarea>' +
      '<div class="mu-adm-proxy-foot"><p class="rd-field-hint">One per line. SOCKS5, SOCKS4 or HTTP. No type means SOCKS5. Passwords are stored encrypted.</p>' +
      '<button class="rd-btn rd-btn-sm rd-btn-primary" data-music-proxy-add>Add</button></div></div>'
    var meta = d.proxies.length ? on.length + ' of ' + d.proxies.length + ' on' + (failing ? ', ' + failing + ' not connecting' : '') : 'None'
    return panel('Proxies', '<div class="mu-adm-stack">' + direct + list + add + '</div>', { meta: meta,
      tip: 'Downloads and lookups are spread across every connection; each gets its own YouTube limit.' })
  }

  function workers (d) {
    if (!d.workers.length) {
      return panel('Workers', '<p class="mon-sub">No workers yet. Start the music worker service (music_worker.py run). It appears here within a few seconds.</p>')
    }
    var rows = d.workers.map(function (w) {
      var state = w.online ? (w.runs_discovery ? H.pill('Runs discovery', 'accent') : '') : H.pill('Offline')
      var meta = (w.version ? 'v' + H.esc(w.version) + ' · ' : '') + (w.online ? 'seen ' + ago(w.seen_ago) : 'last seen ' + ago(w.seen_ago))
      return '<div class="mu-adm-worker' + (w.online ? '' : ' is-offline') + '">' +
        '<div class="mu-adm-worker-head"><span class="mon-dot' + (w.online ? '' : ' is-off') + '" aria-hidden="true"></span>' +
        '<b class="mu-adm-worker-name">' + H.esc(w.name) + '</b>' + state + '<span class="mu-adm-faint">' + meta + '</span>' +
        (w.online ? '' : '<button class="rd-icon-btn adm-icon-btn adm-icon-danger mu-adm-remove" data-music-remove="' + w.id + '" data-name="' + H.esc(w.name) + '" title="Remove" aria-label="Remove ' + H.esc(w.name) + '">' + H.trash + '</button>') +
        '</div>' +
        '<div class="mu-adm-worker-jobs">' +
        '<label class="mu-adm-job"><span><span class="mu-adm-job-title">Discover</span><span class="mu-adm-job-state">' + H.esc(w.online ? w.discover_status || '' : 'Offline') + '</span></span>' +
        sw('data-music-worker="' + w.id + '" data-music-flag="discover_enabled"', w.discover_enabled, 'Discover on ' + w.name) + '</label>' +
        '<label class="mu-adm-job"><span><span class="mu-adm-job-title">Download</span><span class="mu-adm-job-state">' + H.esc(w.online ? w.download_status || '' : 'Offline') +
        (w.added_today ? ' · ' + H.num(w.added_today) + ' today' : '') + '</span></span>' +
        sw('data-music-worker="' + w.id + '" data-music-flag="download_enabled"', w.download_enabled, 'Download on ' + w.name) + '</label>' +
        '</div></div>'
    }).join('')
    return panel('Workers', rows, { flush: true, meta: d.workers.filter(function (w) { return w.online }).length + ' of ' + d.workers.length + ' online',
      tip: 'Each worker can discover, download, or both. Discovery runs on one worker at a time.' })
  }

  // ---- Limits ----------------------------------------------------------------------------
  function limits (d) {
    function field (key, label, hint, value, min, max, unit) {
      return '<div class="rd-field-row"><div class="rd-field-text"><label class="rd-field-label" for="muLim_' + key + '">' + H.esc(label) + '</label><p class="rd-field-hint">' + H.esc(hint) + '</p></div>' +
        '<div class="adm-inline"><input class="form-input adm-num-input" type="number" id="muLim_' + key + '" min="' + min + '" max="' + max + '" step="1" data-music-limit="' + key + '" value="' + H.esc(value) + '"><span class="adm-unit">' + H.esc(unit) + '</span></div></div>'
    }
    var cap = capBytes(d), fill = cap ? d.library.bytes / cap : 0
    return '<div class="mon-cols is-2">' +
      panel('Limits',
        field('music_dl_daily_cap', 'Daily downloads', 'Per connection: this server and each proxy. YouTube allows each IP address about 300 an hour.', d.limits.daily, 0, 20000, 'songs') +
        field('music_library_cap_gb', 'Library size', 'Downloads pause at this size, or when the disk is under 20% free.', d.limits.size_gb, 1, 100000, 'GB'),
        { meta: 'Saved as you change a value' }) +
      panel('Usage',
        '<div class="mon-block">' + row('Library', H.fmtBytes(d.library.bytes) + ' of ' + H.fmtBytes(cap), fill >= 1 ? 'bad' : fill >= 0.9 ? 'warn' : '') +
        '<div class="adm-meter"><div class="adm-meter-fill' + (fill >= 0.9 ? ' is-warn' : '') + '" style="width:' + Math.min(100, fill * 100).toFixed(1) + '%"></div></div></div>' +
        '<div class="mon-block">' + row('Added today', H.num(d.library.added_today) + ' of ' + H.num(dailyLimit(d))) +
        '<div class="adm-meter"><div class="adm-meter-fill" style="width:' + Math.min(100, dailyLimit(d) ? d.library.added_today / dailyLimit(d) * 100 : 0).toFixed(1) + '%"></div></div></div>') +
      '</div>'
  }

  // ---- Public API ------------------------------------------------------------------------
  function render (d, helpers) {
    H = helpers
    if (!VIEWS.some(function (v) { return v[0] === view })) view = 'overview'
    var rows = checks(d)
    var rank = { bad: 3, warn: 2, idle: 1, good: 0 }, worst = {}
    rows.forEach(function (r) { if (!worst[r[4]] || rank[r[3]] > rank[worst[r[4]]]) worst[r[4]] = r[3] })
    var tabs = '<div class="rd-tabs mon-tabs" role="tablist" aria-label="Music views">' + VIEWS.map(function (v) {
      var on = v[0] === view, tone = v[0] === 'overview' ? '' : worst[v[0]]
      return '<button type="button" class="rd-tab' + (on ? ' is-active' : '') + '" role="tab" id="mu-tab-' + v[0] + '" aria-controls="mu-view-' + v[0] + '" aria-selected="' + on + '" data-music-view="' + v[0] + '">' +
        H.esc(v[1]) + (tone === 'bad' || tone === 'warn' ? '<span class="mon-tab-dot is-' + tone + '" aria-label="needs attention"></span>' : '') + '</button>'
    }).join('') + '</div>'
    function pane (id, html) {
      return '<div class="mon-view" role="tabpanel" id="mu-view-' + id + '" aria-labelledby="mu-tab-' + id + '"' + (id === view ? '' : ' hidden') + '>' + html + '</div>'
    }
    return '<div class="mon mu-adm">' +
      '<header class="mon-bar"><h1 class="rd-page-title">Music</h1>' + tabs + '<span class="mon-bar-end"><span class="mon-live"><i aria-hidden="true"></i>Live</span></span></header>' +
      pane('overview', statusStrip(d, rows) + stats(d) + '<div class="mon-cols is-split">' + activity(d) + queue(d) + '</div>') +
      pane('discovery', '<section class="rd-panel mon-p mu-adm-solo">' + discoveryControl(d, '_v') + '</section>' +
        '<div class="mon-cols is-2">' + roster(d) + howItWorks(d) + '</div>' + topArtists(d)) +
      pane('rules', '<div class="mon-cols is-split">' + artistRules(d) + genreRules(d) + '</div>') +
      pane('priorities', priorities(d)) +
      pane('downloads', '<section class="rd-panel mon-p mu-adm-solo">' + downloadControl(d, '_v') + '</section>' +
        '<div class="mon-cols is-2">' + queue(d) + problems(d) + '</div>' +
        '<div class="mon-cols is-2">' + recent(d) + sources(d) + '</div>') +
      pane('connections', '<div class="mon-cols is-2">' + workers(d) + proxies(d) + '</div>') +
      pane('limits', limits(d)) +
      '</div>'
  }

  function setView (panelEl, v) {
    if (!VIEWS.some(function (x) { return x[0] === v })) return
    view = v
    try { sessionStorage.setItem('adm-mu-view', v) } catch (e) {}
    panelEl.querySelectorAll('.mon-tabs [data-music-view]').forEach(function (b) {
      var on = b.getAttribute('data-music-view') === v
      b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on))
    })
    panelEl.querySelectorAll('.mu-adm > .mon-view').forEach(function (x) { x.hidden = x.id !== 'mu-view-' + v })
  }

  function preset (name) {
    var hit = PRESETS.filter(function (x) { return x[0] === name })[0]
    return hit ? hit[3] : null
  }

  window.AdmMusic = { render: render, setView: setView, preset: preset }
})()
