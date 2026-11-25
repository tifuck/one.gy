/* ============================================================================
   admin-music.js — Music tab of the admin console.
   Renders /admin/api/music: the two pipeline switches, the workers with their
   own Discover / Download toggles, the queue, songs that need attention and
   recent additions. admin.js (tabMusic) loads the data, polls it and wires
   the controls (data-music-* attributes).
   ========================================================================== */
(function () {
  'use strict'
  var H

  var BUCKETS = [[0, 'Requests'], [1, 'New releases and charts'], [2, 'Top hits'], [3, 'Full discographies'],
    [4, 'Essentials'], [5, 'Top tracks'], [6, 'Re-checks']]
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

  // Each connection (this server, each proxy that is on) has its own daily limit.
  function dailyLimit (d) {
    var conns = (d.direct ? 1 : 0) + d.proxies.filter(function (p) { return p.enabled }).length
    return d.limits.daily * conns
  }

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

  function control (key, title, sub, on, lines) {
    return '<label class="mu-adm-control" for="muSw_' + key + '">' +
      '<span class="mu-adm-control-text"><span class="mu-adm-control-title">' + H.esc(title) + '</span>' +
      '<span class="mu-adm-control-sub">' + H.esc(sub) + '</span>' +
      lines.map(function (l) { return '<span class="mu-adm-control-line">' + l + '</span>' }).join('') + '</span>' +
      sw('id="muSw_' + key + '" data-music-switch="' + key + '"', on, title) + '</label>'
  }

  function overview (d) {
    var h = headline(d)
    var online = d.workers.filter(function (w) { return w.online }).length
    var leader = d.workers.filter(function (w) { return w.runs_discovery })[0]
    var downloader = d.workers.filter(function (w) { return w.online && w.download_enabled && /^Downloading/.test(w.download_status || '') })[0] ||
      d.workers.filter(function (w) { return w.online && w.download_enabled })[0]
    var built = sinceIso(d.roster.built_at)
    var discLines = [
      H.esc(d.switches.discovery ? (leader ? leader.discover_status || 'Starting' : 'No worker is set to discover') : 'Off'),
      '<span class="mu-adm-faint">' + H.num(d.roster.monitored) + ' artists followed' + (built != null ? ' · ranked ' + ago(built) : '') + '</span>'
    ]
    var dlLines = [
      H.esc(d.switches.downloads ? (downloader ? downloader.download_status || 'Starting' : 'No worker is set to download') : 'Off'),
      '<span class="mu-adm-faint">' + H.num(d.library.added_today) + ' added today · limit ' + H.num(dailyLimit(d)) + ' a day</span>'
    ]
    return '<section class="rd-panel mon-status is-' + h.tone + '" aria-label="Music pipeline status">' +
      '<div class="mon-status-head"><span class="mon-status-mark" aria-hidden="true"></span><h2>' + H.esc(h.text) + '</h2>' +
      '<span class="mon-p-meta">' + online + ' of ' + d.workers.length + ' workers online</span></div>' +
      '<div class="mu-adm-controls">' +
      control('music_discovery_enabled', 'Discovery', 'Finds popular artists, their catalogues and new releases.', d.switches.discovery, discLines) +
      control('music_downloads_enabled', 'Downloads', 'Downloads, checks and publishes the songs discovery queues.', d.switches.downloads, dlLines) +
      '</div></section>'
  }

  function stats (d) {
    var attention = d.problems.reduce(function (n, p) { return n + p.count }, 0)
    function stat (label, value, sub, tone) {
      return '<div class="mon-stat mu-adm-stat' + (tone ? ' is-' + tone : '') + '"><span class="mon-stat-label">' + H.esc(label) + '</span>' +
        '<span class="mon-stat-top"><span class="mon-stat-val">' + H.esc(value) + '</span></span><span class="mon-stat-sub">' + sub + '</span></div>'
    }
    return '<div class="mu-adm-stats">' +
      stat('In the library', H.num(d.library.songs), H.fmtBytes(d.library.bytes) + ' · ' + H.num(d.library.artists) + ' artists') +
      stat('Queued', H.num(d.queue.total), H.num(d.queue.working) + ' in progress') +
      stat('Added today', H.num(d.library.added_today), 'of ' + H.num(dailyLimit(d)) + ' a day') +
      stat('Need attention', H.num(attention), attention ? 'Retried automatically' : 'Nothing failing', attention ? 'warn' : '') +
      '</div>'
  }

  function proxyRow (p) {
    var tone = !p.enabled ? 'idle' : p.status === 'ok' ? 'good' : p.status === 'failing' ? 'bad' : 'idle'
    var detail = !p.enabled ? 'Off'
      : p.status === 'failing' ? 'Not connecting' + (p.last_error ? ': ' + p.last_error : '') + (p.paused_until ? ' · retries ' + H.esc(new Date(p.paused_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '')
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
    var sub = d.proxies.length
      ? on.length + ' of ' + d.proxies.length + ' on' + (failing ? ' · ' + failing + ' not connecting' : '') + '. Downloads and lookups are spread across every connection; each gets its own YouTube limit.'
      : 'Spread downloads and lookups across more IP addresses. Each connection gets its own YouTube limit.'
    return H.card('Proxies', direct + list + add, { sub: sub })
  }

  function workers (d) {
    if (!d.workers.length) {
      return H.card('Workers', H.emptyState(H.icon, 'No workers yet', 'Start the music worker service (music_worker.py run). It appears here within a few seconds.'))
    }
    var rows = d.workers.map(function (w) {
      var state = w.online ? (w.runs_discovery ? '<span class="rd-pill is-accent">Runs discovery</span>' : '')
        : '<span class="rd-pill">Offline</span>'
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
    return H.card('Workers', '<div class="mu-adm-workers">' + rows + '</div>',
      { sub: 'Each worker can discover, download, or both. Discovery runs on one worker at a time.', flush: true })
  }

  function queue (d) {
    var counts = BUCKETS.map(function (b) { return [b[1], d.queue.buckets[b[0]] || 0] }).filter(function (r) { return r[1] })
    var max = counts.reduce(function (m, r) { return Math.max(m, r[1]) }, 0)
    var body = counts.length ? counts.map(function (r) {
      return '<div class="mon-block"><div class="mon-row"><span>' + H.esc(r[0]) + '</span><b>' + H.num(r[1]) + '</b></div>' +
        '<div class="adm-meter"><div class="adm-meter-fill" style="width:' + Math.max(2, Math.round(r[1] / max * 100)) + '%"></div></div></div>'
    }).join('') : H.emptyState(H.icon, 'Nothing queued', d.switches.discovery ? 'Discovery adds songs as it finds them.' : 'Turn on discovery to find songs.')
    return H.card('Queue', body, { sub: 'Downloaded in this order, most popular first within each group.' })
  }

  function problems (d) {
    var body = d.problems.length ? d.problems.map(function (p) {
      return '<div class="mon-row"><span>' + H.esc(PROBLEMS[p.code] || p.code) + '</span><b class="is-warn">' + H.num(p.count) + '</b></div>'
    }).join('') : H.emptyState(H.icon, 'Nothing needs attention', 'Songs that fail are retried automatically.')
    var extra = d.queue.retrying ? '<button class="rd-btn rd-btn-sm rd-btn-ghost" data-music-retry>' + H.refresh + 'Retry now</button>' : ''
    return H.card('Needs attention', body, { sub: d.queue.retrying ? H.num(d.queue.retrying) + ' songs wait for their next try.' : 'Songs that could not be added yet.', extra: extra })
  }

  function recent (d) {
    var rows = d.library.recent.map(function (s) {
      var m = /^covers\/([\w-]+)\.jpg$/.exec(s.cover_path || '')
      var cover = m ? '<img class="mu-adm-cover" src="/music/cover/' + encodeURIComponent(m[1]) + '" alt="" loading="lazy">' : '<span class="mu-adm-cover"></span>'
      return '<li class="mu-adm-song">' + cover + '<span class="mu-adm-song-text"><b>' + H.esc(s.title) + '</b><span>' + H.esc(s.artist || '') + '</span></span>' +
        '<span class="mu-adm-faint">' + ago(sinceIso(s.added)) + '</span></li>'
    }).join('')
    return H.card('Recently added', rows ? '<ul class="mu-adm-songs">' + rows + '</ul>' : H.emptyState(H.icon, 'No songs yet', 'New songs appear here as they are published.'), { flush: !!rows })
  }

  function limits (d) {
    function row (key, label, hint, value, min, max, unit) {
      return '<div class="rd-field-row"><div class="rd-field-text"><label class="rd-field-label" for="muLim_' + key + '">' + H.esc(label) + '</label><p class="rd-field-hint">' + H.esc(hint) + '</p></div>' +
        '<div class="adm-inline"><input class="form-input adm-num-input" type="number" id="muLim_' + key + '" min="' + min + '" max="' + max + '" step="1" data-music-limit="' + key + '" value="' + H.esc(value) + '"><span class="adm-unit">' + H.esc(unit) + '</span></div></div>'
    }
    return H.card('Limits',
      row('music_dl_daily_cap', 'Daily downloads', 'Per connection: this server and each proxy. YouTube allows each IP address about 300 an hour.', d.limits.daily, 0, 20000, 'songs') +
      row('music_library_cap_gb', 'Library size', 'Downloads pause at this size, or when the disk is under 20% free.', d.limits.size_gb, 1, 100000, 'GB'),
      { sub: 'Saved as soon as you change a value.' })
  }

  function render (d, helpers) {
    H = helpers
    return '<div class="mu-adm">' +
      H.head('Music', 'Discovery finds the songs to add. Downloads fetch, check and publish them.', '<span class="mon-live"><i></i>Live</span>') +
      '<div class="adm-stack">' + overview(d) + stats(d) + proxies(d) + workers(d) +
      '<div class="mon-cols is-2">' + queue(d) + problems(d) + '</div>' +
      '<div class="mon-cols is-2">' + recent(d) + limits(d) + '</div>' +
      '</div></div>'
  }

  window.AdmMusic = { render: render }
})()
