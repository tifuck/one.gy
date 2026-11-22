/* ============================================================================
   admin-monitor.js — Monitoring tab of the admin console (admin.js).
   Renders /admin/api/monitoring: one status board (every check, with its open
   issues listed under it), storage nodes, durability, jobs, trends and backups.
   Issue rules live on the server (_monitor_issues); this file only maps each
   issue code to the check it belongs to and never invents its own alerts.
   Charts are plain SVG drawn at the container's real width (no library);
   admin.js owns fetching and the live refresh timer, this file owns the
   once-a-second "x s ago" ticker.
   ========================================================================== */
(function () {
  'use strict'
  var H = null // markup helpers handed over by admin.js (esc, num, fmtBytes, pill, head, card, kvs)
  var CHARTS = {}
  var observer = null
  var ticker = null
  var skew = 0 // server clock minus browser clock, seconds
  var PALETTE = ['var(--accent)', 'var(--kind-media)', 'var(--kind-code)', 'var(--kind-image)', 'var(--kind-doc)']
  var TONE = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)', muted: 'var(--line-strong)' }
  var RANGES = [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d']]
  // Overview checks: [id, label, view holding the details, issue codes from _monitor_issues]
  var CHECKS = [
    ['durability', 'Durability', 'storage', ['zero_copy', 'aged_single_copy']],
    ['replication', 'Replication', 'storage', ['parked_replicas', 'remote_delete_stalled']],
    ['nodes', 'Storage nodes', 'storage', ['node_down', 'missing_replicas', 'size_only_node']],
    ['verification', 'Verification', 'storage', ['scrub_behind']],
    ['jobs', 'Background jobs', 'storage', ['scheduler_stalled', 'job_overdue']],
    ['backups', 'Backups', 'backups', ['backup_failed', 'backup_offsite_failed', 'backup_stale', 'backup_unrecorded']],
    ['disk', 'Local disk', 'storage', ['disk_full']]
  ]

  // ---- Formatting ------------------------------------------------------------
  function serverNow () { return Math.floor(Date.now() / 1000 + skew) }
  function ago (ts, now) {
    if (!ts) return 'never'
    var s = Math.max(0, now - ts)
    if (s < 60) return s + ' s ago'
    if (s < 3600) return Math.floor(s / 60) + ' min ago'
    if (s < 172800) return Math.floor(s / 3600) + ' h ago'
    return Math.floor(s / 86400) + ' d ago'
  }
  // Text that keeps counting between refreshes (see tick()).
  function liveAgo (ts, now) { return '<span data-ago="' + (ts || 0) + '">' + H.esc(ago(ts, now)) + '</span>' }
  function dur (s) {
    if (s == null) return 'n/a'
    if (s < 90) return Math.round(s) + ' s'
    if (s < 5400) return Math.round(s / 60) + ' min'
    if (s < 172800) return (s / 3600).toFixed(1).replace(/\.0$/, '') + ' h'
    return Math.round(s / 86400) + ' d'
  }
  function rate (v) { return v == null ? 'n/a' : H.fmtBytes(v) + '/s' }
  function fmt (unit, v) {
    if (v == null || isNaN(v)) return 'n/a'
    if (unit === 'bytes') return H.fmtBytes(v)
    if (unit === 'Bps') return rate(v)
    if (unit === 's') return dur(v)
    return H.num(Math.round(v))
  }
  // Never rounds a shortfall up to 100%.
  function pct (part, whole) {
    if (!whole) return '100%'
    var v = part / whole * 100
    return (v >= 100 ? '100' : v >= 99.95 ? '99.9' : v.toFixed(1)) + '%'
  }
  function plural (n, word, many) { return H.num(n) + ' ' + (n === 1 ? word : many || word + 's') }
  function sum (arr) { return arr.reduce(function (a, b) { return a + (b || 0) }, 0) }
  function addArrays () {
    var arrs = Array.prototype.slice.call(arguments)
    return arrs[0].map(function (_, i) { return sum(arrs.map(function (a) { return a[i] })) })
  }
  function clockLabel (ts, span) {
    var d = new Date(ts * 1000)
    if (span <= 172800) return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  function fullTime (ts) {
    return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  function niceMax (v, unit) {
    if (!(v > 0)) return 1
    var base = 1
    if (unit === 'bytes' || unit === 'Bps') { var i = Math.floor(Math.log(v) / Math.log(1024)); base = Math.pow(1024, Math.max(0, i)) }
    var x = v / base, p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p
    var n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
    return n * p * base
  }
  function enabledNodes (st) { return st.nodes.filter(function (n) { return n.enabled }) }
  // Same lateness rules as _monitor_issues: scheduler past the heartbeat
  // threshold, other jobs past 3 intervals + 2 min.
  function jobLimit (job, j, thresholds) { return job === 'scheduler' ? thresholds.heartbeat : 3 * j.interval + 120 }

  // ---- Small inline graphics -----------------------------------------------------
  function meter (fraction, tone) {
    var w = Math.max(0, Math.min(1, fraction || 0)) * 100
    return '<div class="adm-meter"><div class="adm-meter-fill' + (tone && tone !== 'good' ? ' is-' + tone : '') + '" style="width:' + w.toFixed(1) + '%"></div></div>'
  }
  // segments: [{label, value, color}] — one horizontal stacked bar + legend
  function stackBar (segments, total) {
    total = total || sum(segments.map(function (s) { return s.value }))
    var bar = segments.map(function (s) {
      if (!s.value || !total) return ''
      return '<span style="flex-grow:' + s.value + ';background:' + s.color + '" title="' + H.esc(s.label + ': ' + H.num(s.value)) + '"></span>'
    }).join('')
    var legend = segments.map(function (s) {
      return '<span class="mon-legend-item' + (s.value ? '' : ' is-zero') + '"><i style="background:' + s.color + '"></i>' + H.esc(s.label) + ' <b>' + H.num(s.value) + '</b></span>'
    }).join('')
    return '<div class="mon-stack" role="img" aria-label="' + H.esc(segments.map(function (s) { return s.label + ' ' + s.value }).join(', ')) + '">' +
      (bar || '<span style="flex-grow:1;background:var(--press)"></span>') + '</div><div class="mon-legend">' + legend + '</div>'
  }

  // ---- Chart registry (drawn after paint, at real width) ----------------------------
  function chart (key, spec, title, sub) {
    CHARTS[key] = spec
    var legend = spec.series && spec.series.length > 1 ? '<div class="mon-legend">' + spec.series.map(function (s) {
      return '<span class="mon-legend-item"><i style="background:' + s.color + '"></i>' + H.esc(s.name) + '</span>'
    }).join('') + '</div>' : ''
    var empty = !spec.t || spec.t.length < 2
    return '<section class="rd-panel mon-chart-card"><header class="mon-chart-head"><h3>' + H.esc(title) + '</h3>' +
      (sub ? '<p>' + H.esc(sub) + '</p>' : '') + '</header>' +
      (empty ? '<div class="mon-chart-empty">Collecting data. Charts fill in as 5-minute snapshots arrive.</div>'
        : '<div class="mon-chart" data-chart="' + key + '" style="height:' + (spec.height || 120) + 'px" role="img" aria-label="' + H.esc(title) + '"></div>' + legend) +
      '</section>'
  }

  function drawLine (el, spec) {
    var W = el.clientWidth, Hh = el.clientHeight
    if (!W) return
    var padR = 6, padT = 6, padB = 20
    var t = spec.t, n = t.length, t0 = spec.start || t[0], t1 = spec.end || t[n - 1]
    var series = spec.series
    var stacked = spec.stacked ? series.map(function () { return [] }) : null
    if (stacked) {
      for (var i = 0; i < n; i++) {
        var acc = 0
        series.forEach(function (s, k) { acc += s.values[i] || 0; stacked[k][i] = acc })
      }
    }
    var max = 0
    series.forEach(function (s, k) { (stacked ? stacked[k] : s.values).forEach(function (v) { if (v != null && v > max) max = v }) })
    max = niceMax(max, spec.unit)
    if (spec.unit === 'count' && max < 2) max = 2
    if ((spec.unit === 'bytes' || spec.unit === 'Bps') && max < 1024) max = 1024
    // Room for the widest y label (10px tabular figures are about 6 px each).
    var padL = 12 + Math.max.apply(null, [0, 1, 2].map(function (g) { return fmt(spec.unit, max * g / 2).length })) * 6
    var iw = W - padL - padR, ih = Hh - padT - padB
    function x (ts) { return padL + (t1 > t0 ? (ts - t0) / (t1 - t0) : 0) * iw }
    function y (v) { return padT + ih - v / max * ih }
    var out = ''
    for (var g = 0; g <= 2; g++) {
      var gv = max * g / 2, gy = y(gv).toFixed(1)
      out += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy + '" y2="' + gy + '" class="mon-grid"/>' +
        '<text x="' + (padL - 8) + '" y="' + (+gy + 4) + '" text-anchor="end" class="mon-axis">' + H.esc(fmt(spec.unit, gv)) + '</text>'
    }
    var ticks = Math.max(2, Math.min(5, Math.floor(iw / 90)))
    for (var k = 0; k <= ticks; k++) {
      var ts = t0 + (t1 - t0) * k / ticks
      out += '<text x="' + x(ts).toFixed(1) + '" y="' + (Hh - 4) + '" text-anchor="' + (k === 0 ? 'start' : k === ticks ? 'end' : 'middle') + '" class="mon-axis">' + H.esc(clockLabel(ts, t1 - t0)) + '</text>'
    }
    if (spec.bars) {
      var bw = Math.max(2, Math.min(6, iw / Math.max(n, 1) * 0.6))
      series.forEach(function (s) {
        s.values.forEach(function (v, i) {
          if (v == null) return
          out += '<rect x="' + (x(t[i]) - bw / 2).toFixed(1) + '" y="' + y(v).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (padT + ih - y(v)).toFixed(1) + '" rx="1.5" style="fill:' + (s.colors ? s.colors[i] : s.color) + '"/>'
        })
      })
    } else {
      series.slice().reverse().forEach(function (s, rk) {
        var k = series.length - 1 - rk
        var vals = stacked ? stacked[k] : s.values
        var segs = [], cur = []
        vals.forEach(function (v, i) {
          if (v == null || s.values[i] == null) { if (!spec.connect && cur.length) { segs.push(cur); cur = [] } return }
          cur.push([x(t[i]), y(v), i])
        })
        if (cur.length) segs.push(cur)
        segs.forEach(function (seg) {
          var d = seg.map(function (p, j) { return (j ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1) }).join('')
          if (spec.area || stacked) {
            var lower = stacked && k > 0 ? seg.slice().reverse().map(function (p) { return 'L' + p[0].toFixed(1) + ' ' + y(stacked[k - 1][p[2]] || 0).toFixed(1) }).join('')
              : 'L' + seg[seg.length - 1][0].toFixed(1) + ' ' + y(0).toFixed(1) + 'L' + seg[0][0].toFixed(1) + ' ' + y(0).toFixed(1)
            out += '<path d="' + d + lower + 'Z" style="fill:' + s.color + ';opacity:.14"/>'
          }
          out += '<path d="' + d + '" style="fill:none;stroke:' + s.color + ';stroke-width:1.5;stroke-linejoin:round"/>'
        })
      })
    }
    out += '<line class="mon-guide" x1="0" x2="0" y1="' + padT + '" y2="' + (padT + ih) + '" style="display:none"/>'
    el.innerHTML = '<svg width="' + W + '" height="' + Hh + '" viewBox="0 0 ' + W + ' ' + Hh + '">' + out + '</svg><div class="mon-tip" hidden></div>'
    el._geo = { x: x, padL: padL, iw: iw, W: W }
  }

  function drawTimeline (el, spec) {
    var W = el.clientWidth, Hh = el.clientHeight
    if (!W) return
    var padL = 48, padR = 8, laneH = 24, top = 4
    var iw = W - padL - padR, t0 = spec.start, t1 = spec.end
    function x (ts) { return padL + (ts - t0) / (t1 - t0) * iw }
    var out = ''
    spec.lanes.forEach(function (lane, li) {
      var cy = top + li * laneH + laneH / 2
      out += '<text x="' + (padL - 10) + '" y="' + (cy + 4) + '" text-anchor="end" class="mon-axis">' + H.esc(lane.name) + '</text>' +
        '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + cy + '" y2="' + cy + '" class="mon-grid"/>'
      lane.runs.forEach(function (r) {
        out += '<circle cx="' + x(r.t).toFixed(1) + '" cy="' + cy + '" r="4" style="fill:' + TONE[r.tone] + '"/>'
      })
    })
    var ticks = Math.max(2, Math.min(6, Math.floor(iw / 110)))
    for (var k = 0; k <= ticks; k++) {
      var ts = t0 + (t1 - t0) * k / ticks
      out += '<text x="' + x(ts).toFixed(1) + '" y="' + (Hh - 4) + '" text-anchor="' + (k === 0 ? 'start' : k === ticks ? 'end' : 'middle') + '" class="mon-axis">' + H.esc(clockLabel(ts, t1 - t0)) + '</text>'
    }
    el.innerHTML = '<svg width="' + W + '" height="' + Hh + '" viewBox="0 0 ' + W + ' ' + Hh + '">' + out + '</svg><div class="mon-tip" hidden></div>'
    el._geo = { x: x, padL: padL, iw: iw, W: W, laneH: laneH, top: top }
  }

  function drawAll (root) {
    root.querySelectorAll('.mon-chart').forEach(function (el) {
      var spec = CHARTS[el.getAttribute('data-chart')]
      if (!spec) return
      if (spec.timeline) drawTimeline(el, spec); else drawLine(el, spec)
    })
  }

  function onHover (e) {
    var el = e.target.closest && e.target.closest('.mon-chart')
    if (!el || !el._geo) return
    var spec = CHARTS[el.getAttribute('data-chart')], geo = el._geo
    if (!spec) return
    var box = el.getBoundingClientRect(), mx = e.clientX - box.left, my = e.clientY - box.top
    var tip = el.querySelector('.mon-tip'), guide = el.querySelector('.mon-guide')
    var html = ''
    var px = mx
    if (spec.timeline) {
      var lane = spec.lanes[Math.floor((my - geo.top) / geo.laneH)]
      var best = null
      if (lane) lane.runs.forEach(function (r) { var d = Math.abs(geo.x(r.t) - mx); if (d < 12 && (!best || d < best.d)) best = { d: d, r: r } })
      if (!best) { tip.hidden = true; return }
      px = geo.x(best.r.t)
      html = '<b>' + H.esc(lane.name + ', ' + fullTime(best.r.t)) + '</b>' + best.r.lines.map(function (l) { return '<div>' + H.esc(l) + '</div>' }).join('')
    } else {
      var t = spec.t, i = 0, bestD = Infinity
      for (var j = 0; j < t.length; j++) { var dd = Math.abs(geo.x(t[j]) - mx); if (dd < bestD) { bestD = dd; i = j } }
      px = geo.x(t[i])
      if (guide) { guide.setAttribute('x1', px); guide.setAttribute('x2', px); guide.style.display = '' }
      html = '<b>' + H.esc(fullTime(t[i])) + '</b>' + spec.series.map(function (s) {
        return '<div><i style="background:' + s.color + '"></i>' + H.esc(s.name) + '<span>' + H.esc(fmt(spec.unit, s.values[i])) + '</span></div>'
      }).join('')
    }
    tip.innerHTML = html
    tip.hidden = false
    var tw = tip.offsetWidth
    tip.style.left = Math.max(0, Math.min(geo.W - tw, px + 12 + tw > geo.W ? px - tw - 12 : px + 12)) + 'px'
  }
  function onLeave (e) {
    var el = e.target.closest && e.target.closest('.mon-chart')
    if (!el) return
    var tip = el.querySelector('.mon-tip'), guide = el.querySelector('.mon-guide')
    if (tip) tip.hidden = true
    if (guide) guide.style.display = 'none'
  }

  // ---- Derived series ----------------------------------------------------------
  function throughput (node) {
    return node.bytes.map(function (b, i) {
      if (!i) return null
      var dt = node.t[i] - node.t[i - 1]
      return dt > 0 ? Math.max(0, (b - node.bytes[i - 1]) / dt) : null
    })
  }
  // Remote node bytes vs the primary at the same capture time.
  function lagSeries (node, primary) {
    var byT = {}
    primary.t.forEach(function (ts, i) { byT[ts] = primary.bytes[i] })
    return node.t.map(function (ts, i) { return byT[ts] == null ? null : Math.max(0, byT[ts] - node.bytes[i]) })
  }
  // Resample per-node values onto a shared time axis (nodes captured together).
  function onAxis (axis, node, values) {
    var byT = {}
    node.t.forEach(function (ts, i) { byT[ts] = values[i] })
    return axis.map(function (ts) { return byT[ts] == null ? null : byT[ts] })
  }
  // History is a 5-minute snapshot series; end it with the live state so the
  // right edge of every system chart matches the numbers above it.
  function withLive (hs, st) {
    var n = hs.t.length
    if (n && st.at - hs.t[n - 1] < 60) return hs
    var en = enabledNodes(st)
    function errs (k) { return sum(en.map(function (x) { return x.replicas[k].error || 0 })) }
    var now = {
      t: st.at, backlog_file: st.backlog.file, backlog_note: st.backlog.note, backlog_thumbnail: st.backlog.thumbnail,
      errors_file: errs('file'), errors_note: errs('note'), errors_thumbnail: errs('thumbnail'),
      remote_deletes: st.remote_deletes.queued, remote_deletes_stalled: st.remote_deletes.stalled,
      single_copy_file: st.single_copy.file, single_copy_note: st.single_copy.note, single_copy_thumbnail: st.single_copy.thumbnail,
      zero_copy_file: st.zero_copy.file, zero_copy_note: st.zero_copy.note, parked: st.parked, unverified: st.unverified
    }
    var out = {}
    Object.keys(hs).forEach(function (k) { out[k] = hs[k].concat([k in now ? now[k] : null]) })
    return out
  }

  // ---- Status board --------------------------------------------------------------
  // Each returns { value (html), detail (html), tone? } where tone is only 'idle' for
  // "no data / not applicable"; problems come from the server's issues.
  var SUMMARY = {
    durability: function (st) {
      if (!st.multi_node) return { value: 'One node', detail: 'Only one storage node is enabled, so every payload has one copy', tone: 'idle' }
      var zero = st.zero_copy.file + st.zero_copy.note, one = st.single_copy.file + st.single_copy.note
      return {
        value: zero ? H.num(zero) + ' with no copy' : one ? H.num(one) + ' with one copy' : 'All on 2+ nodes',
        detail: plural(st.payloads.file, 'file') + ', ' + plural(st.payloads.note, 'note') + (one && !zero ? ', still replicating' : '')
      }
    },
    replication: function (st) {
      var backlog = st.backlog.file + st.backlog.note + st.backlog.thumbnail, rd = st.remote_deletes
      return {
        value: backlog ? plural(backlog, 'copy', 'copies') + ' queued' : 'In sync',
        detail: (st.errors ? plural(st.errors, 'error') + (st.parked ? ' (' + H.num(st.parked) + ' parked)' : '') : 'No errors') + ', ' +
          (rd.queued ? plural(rd.queued, 'remote delete') + ' queued' : 'no deletes queued')
      }
    },
    nodes: function (st) {
      var en = enabledNodes(st), up = en.filter(function (n) { return n.up }).length, off = st.nodes.length - en.length
      if (!en.length) return { value: 'None enabled', detail: 'Add a storage node in Storage', tone: 'idle' }
      return {
        value: up + ' of ' + en.length + ' online',
        detail: H.esc(en.map(function (n) { return n.name }).join(', ')) + (off ? ', ' + off + ' disabled' : '')
      }
    },
    verification: function (st) {
      var synced = sum(enabledNodes(st).map(function (n) { return n.synced })), unv = st.unverified
      var noHash = st.unverified_no_hash || 0, queued = unv - noHash
      var parts = []
      if (queued) parts.push(H.num(queued) + ' waiting for the scrub')
      if (noHash) parts.push(H.num(noHash) + ' size-checked only')
      return {
        value: pct(synced - unv, synced) + ' confirmed',
        detail: parts.length ? 'By SHA-256; ' + parts.join(', ') : 'Every copy matches its SHA-256'
      }
    },
    jobs: function (st, now, thresholds) {
      var j = st.jobs
      var late = ['scheduler', 'health_check', 'integrity_scrub'].filter(function (k) {
        return (k === 'scheduler' || j[k].interval > 0) && (!j[k].last || now - j[k].last > jobLimit(k, j[k], thresholds))
      })
      return {
        value: late.length ? plural(late.length, 'job') + ' late' : 'On schedule',
        detail: 'Heartbeat ' + liveAgo(j.scheduler.last, now) + ', scrub ' + liveAgo(j.integrity_scrub.last, now)
      }
    },
    backups: function (st, now) {
      var b = st.backups
      if (!b.db.last && !b.full.last) return { value: 'No runs yet', detail: 'Runs appear after the next backup_prod.py run', tone: 'idle' }
      function part (k, label) { return b[k].last_ok ? label + ' ' + liveAgo(b[k].last_ok.finished, now) : label + ' never' }
      var last = [b.db.last, b.full.last].filter(Boolean)
      var offsite = last.every(function (r) { return r.offsite_ok === true }) ? 'offsite copies verified'
        : last.some(function (r) { return r.offsite_ok === false }) ? 'offsite copy incomplete' : 'local only'
      var newest = Math.max(b.db.last_ok ? b.db.last_ok.finished : 0, b.full.last_ok ? b.full.last_ok.finished : 0)
      return { value: newest ? liveAgo(newest, now) : 'Never succeeded', detail: part('db', 'DB') + ', ' + part('full', 'full') + ', ' + offsite }
    },
    disk: function (st) {
      var d = st.disk
      if (!d || !d.total) return { value: 'Unknown', detail: 'Disk usage could not be read', tone: 'idle' }
      return { value: Math.round((d.total - d.free) / d.total * 100) + '% used', detail: H.fmtBytes(d.free) + ' free of ' + H.fmtBytes(d.total) }
    }
  }

  function evaluate (st, now, thresholds) {
    var byCode = {}, mapped = {}
    st.issues.forEach(function (i) { (byCode[i.code] = byCode[i.code] || []).push(i) })
    var rows = CHECKS.map(function (c) {
      c[3].forEach(function (code) { mapped[code] = true })
      var s = SUMMARY[c[0]](st, now, thresholds)
      return { id: c[0], label: c[1], view: c[2], value: s.value, detail: s.detail, tone: s.tone,
        issues: [].concat.apply([], c[3].map(function (code) { return byCode[code] || [] })) }
    })
    var other = st.issues.filter(function (i) { return !mapped[i.code] })
    if (other.length) rows.push({ id: 'other', label: 'Other', view: 'overview', value: H.num(other.length), detail: 'Issues without a dedicated check', issues: other })
    rows.forEach(function (r) {
      var sev = r.issues.map(function (i) { return i.severity })
      r.tone = sev.indexOf('critical') >= 0 ? 'bad' : sev.indexOf('warning') >= 0 ? 'warn' : r.tone || 'good'
    })
    return rows
  }

  function overview (rows, st, now) {
    var crit = 0, warn = 0, list = []
    rows.forEach(function (r) {
      r.issues.forEach(function (i) {
        if (i.severity === 'critical') crit++; else if (i.severity === 'warning') warn++
        list.push({ i: i, r: r })
      })
    })
    var order = { critical: 0, warning: 1, info: 2 }
    list.sort(function (x, y) { return order[x.i.severity] - order[y.i.severity] })
    var tone = crit ? 'bad' : warn ? 'warn' : 'good'
    var headline = crit ? plural(crit, 'critical issue') + (warn ? ' and ' + plural(warn, 'warning') : '')
      : warn ? plural(warn, 'warning') : 'All systems healthy'
    var passing = rows.filter(function (r) { return r.tone === 'good' }).length
    var banner = '<div class="mon-banner is-' + tone + '"><span class="mon-banner-mark" aria-hidden="true"></span>' +
      '<h2>' + H.esc(headline) + '</h2><span class="mon-banner-sub">' + passing + ' of ' + rows.length + ' checks passing</span></div>'
    var tiles = rows.map(function (r) {
      return '<button type="button" class="mon-tile is-' + r.tone + '" data-mon-view="' + r.view + '">' +
        '<span class="mon-tile-label"><span class="mon-dot" aria-hidden="true"></span>' + H.esc(r.label) + '</span>' +
        '<span class="mon-tile-val">' + r.value + '</span>' +
        '<span class="mon-tile-detail">' + r.detail + '</span></button>'
    }).join('')
    var issues = list.length ? list.map(function (x) {
      var t = x.i.severity === 'critical' ? 'bad' : x.i.severity === 'warning' ? 'warn' : 'info'
      return '<li class="is-' + t + '"><span class="mon-dot" aria-hidden="true"></span><span class="mon-issue-text">' + H.esc(x.i.summary) + '</span>' +
        '<button type="button" class="mon-issue-link" data-mon-view="' + x.r.view + '">' + H.esc(x.r.label) + '</button></li>'
    }).join('') : '<li class="is-none">No open issues.</li>'
    return banner + '<div class="mon-tiles">' + tiles + '</div>' +
      '<section class="rd-panel mon-issues"><header class="mon-issues-head"><h3>Open issues</h3><span>' + H.num(list.length) + '</span></header><ul>' + issues + '</ul></section>'
  }

  // ---- Sections ------------------------------------------------------------------
  function nodesCard (st, now) {
    var en = enabledNodes(st), disabled = st.nodes.length - en.length
    var noHash = 0
    var rows = en.map(function (n) {
      var unv = sum(Object.values(n.unverified)), nh = sum(Object.values(n.no_hash || {}))
      noHash += nh
      var va = n.verify_age || {}, recent = (va.d1 || 0) + (va.d7 || 0)
      var check = n.checksum === true ? 'SHA-256' : n.checksum === false ? 'size only' : 'unprobed'
      function cnt (v, tone, label) { return '<td class="is-num' + (v ? ' is-' + tone : ' is-zero') + '" data-label="' + label + '">' + H.num(v) + '</td>' }
      return '<tr>' +
        '<td data-label="Node"><span class="mon-node"><b>' + H.esc(n.name) + '</b><span>' + H.esc(n.type === 's3' ? 'S3' : n.type === 'ssh' ? 'SSH' : 'Local') +
          (n.primary ? ', primary' : '') + ', ' + check + '</span></span></td>' +
        '<td data-label="Status">' + H.pill(n.up ? 'Online' : n.status.charAt(0).toUpperCase() + n.status.slice(1), n.up ? 'good' : 'bad', true) + '</td>' +
        '<td class="is-num" data-label="Stored">' + H.fmtBytes(n.synced_bytes) + '</td>' +
        '<td class="is-num" data-label="Copies">' + H.num(n.synced) + '</td>' +
        cnt(n.pending, 'warn', 'Queued') + cnt(n.errors + n.missing, 'bad', 'Errors') +
        '<td data-label="Hash-confirmed"><span class="mon-pct"><b>' + pct(n.synced - unv, n.synced) + '</b>' + meter(n.synced ? (n.synced - unv) / n.synced : 1) + '</span></td>' +
        '<td data-label="Checked in 7 d"><span class="mon-pct"><b class="' + (va.older ? 'is-warn' : '') + '">' + pct(recent, n.synced) + '</b>' + meter(n.synced ? recent / n.synced : 1, va.older ? 'warn' : '') + '</span></td>' +
        '<td class="is-num" data-label="Last probe">' + liveAgo(n.last_seen, now) + (n.failures ? '<span class="mon-sub is-bad">' + plural(n.failures, 'failed probe') + '</span>' : '') + '</td>' +
        '</tr>'
    }).join('')
    var notes = []
    if (noHash) notes.push(plural(noHash, 'copy', 'copies') + ' never got a hash from their node (for example S3 objects stored without a SHA-256). The scrub checks their size; only a deep verify can confirm their contents.')
    if (disabled) notes.push(plural(disabled, 'disabled node') + ' not shown.')
    var body = rows
      ? '<div class="rd-table-wrap"><table class="rd-table is-stack mon-table"><thead><tr><th>Node</th><th>Status</th><th class="is-num">Stored</th><th class="is-num">Copies</th>' +
        '<th class="is-num">Queued</th><th class="is-num">Errors</th><th>Hash-confirmed</th><th>Checked in 7 d</th><th class="is-num">Last probe</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (notes.length ? '<p class="adm-note mon-foot">' + H.esc(notes.join(' ')) + '</p>' : '')
      : '<p class="adm-note mon-foot">No enabled storage nodes.</p>'
    return H.card('Storage nodes', body, { flush: true, sub: 'Live replica state per enabled node' })
  }

  function durabilityCard (st) {
    function row (label, total, single, zero) {
      var multi = Math.max(0, total - single - zero)
      return '<div class="mon-dur"><div class="mon-row"><span>' + H.esc(label) + '</span><b>' + H.num(total) + '</b></div>' +
        stackBar([{ label: '2+ copies', value: multi, color: TONE.good }, { label: '1 copy', value: single, color: TONE.warn }, { label: 'No copy', value: zero, color: TONE.bad }], total) + '</div>'
    }
    var body = st.multi_node
      ? row('Files', st.payloads.file, st.single_copy.file, st.zero_copy.file) + row('Notes', st.payloads.note, st.single_copy.note, st.zero_copy.note) +
        '<p class="adm-note">Backups do not include payloads, so replicas are their only copies. ' +
        (st.single_copy.thumbnail ? plural(st.single_copy.thumbnail, 'thumbnail') + ' also have a single copy.' : 'Every thumbnail has 2+ copies.') + '</p>'
      : '<p class="adm-note">Only one storage node is enabled, so every payload has exactly one copy.</p>'
    return H.card('Durability', body, { sub: 'Synced copies per payload across enabled nodes' })
  }

  function jobsCard (st, now, thresholds) {
    var j = st.jobs
    function job (key, label, detail) {
      var x = j[key], limit = jobLimit(key, x, thresholds), age = x.last ? now - x.last : null
      var tone = age == null || age > limit ? (key === 'scheduler' ? 'bad' : 'warn') : 'good'
      return '<div class="mon-fresh"><div class="mon-row"><span>' + H.esc(label) + '</span><b class="is-' + tone + '">' + liveAgo(x.last, now) + '</b></div>' +
        meter(age == null ? 1 : age / limit, tone) + '<p class="mon-sub">' + H.esc(detail + ' Late after ' + dur(limit) + '.') + '</p></div>'
    }
    var disk = st.disk, diskRow = ''
    if (disk && disk.total) {
      var used = (disk.total - disk.free) / disk.total
      var tone = used * 100 >= thresholds.disk ? 'warn' : 'good'
      diskRow = '<div class="mon-fresh"><div class="mon-row"><span>Local disk</span><b class="is-' + tone + '">' + Math.round(used * 100) + '% used</b></div>' +
        meter(used, tone) + '<p class="mon-sub">' + H.fmtBytes(disk.free) + ' free of ' + H.fmtBytes(disk.total) + '. Warns at ' + thresholds.disk + '%.</p></div>'
    }
    return H.card('Jobs and disk',
      job('scheduler', 'Scheduler heartbeat', 'Every ' + dur(j.scheduler.interval) + ', drives replication, scrub and deletes.') +
      job('health_check', 'Health check', 'Every ' + dur(j.health_check.interval) + ', probes each storage node.') +
      job('integrity_scrub', 'Integrity scrub', 'Every ' + dur(j.integrity_scrub.interval) + ', re-checks stored copies.') +
      diskRow,
    { sub: 'Bars fill toward the point where a job counts as late' })
  }

  function trends (st, hist, span) {
    var hs = withLive(hist.system, st)
    var primary = null
    st.nodes.forEach(function (n) { if (n.primary && n.enabled) primary = n })
    var nodeHist = hist.nodes.filter(function (n) { return st.nodes.some(function (s) { return s.id === n.id && s.enabled }) })
    var primaryHist = primary ? nodeHist.filter(function (n) { return n.id === primary.id })[0] : null
    var remotes = nodeHist.filter(function (n) { return n.type !== 'local' && (!primary || n.id !== primary.id) })
    var axis = remotes.length ? remotes[0].t : []
    return '<div class="mon-charts">' +
      chart('tp', { t: axis, start: span.start, end: span.end, unit: 'Bps', area: true, series: remotes.map(function (n, i) {
        return { name: n.name, color: PALETTE[i % PALETTE.length], values: onAxis(axis, n, throughput(n)) }
      }) }, 'Replication throughput', 'Net bytes per second landing on remote nodes') +
      (primaryHist ? chart('lag', { t: axis, start: span.start, end: span.end, unit: 'bytes', area: true, series: remotes.map(function (n, i) {
        return { name: n.name, color: PALETTE[i % PALETTE.length], values: onAxis(axis, n, lagSeries(n, primaryHist)) }
      }) }, 'Behind the primary', 'Bytes on ' + primary.name + ' not yet on remote nodes') : '') +
      chart('backlog', { t: hs.t, start: span.start, end: span.end, unit: 'count', stacked: true, series: [
        { name: 'Files', color: PALETTE[0], values: hs.backlog_file },
        { name: 'Notes', color: PALETTE[1], values: hs.backlog_note },
        { name: 'Thumbnails', color: PALETTE[2], values: hs.backlog_thumbnail }
      ] }, 'Replication queue', 'Copies waiting to be written') +
      chart('risk', { t: hs.t, start: span.start, end: span.end, unit: 'count', series: [
        { name: 'One copy', color: TONE.warn, values: addArrays(hs.single_copy_file, hs.single_copy_note) },
        { name: 'No copy', color: TONE.bad, values: addArrays(hs.zero_copy_file, hs.zero_copy_note) }
      ] }, 'Payloads at risk', 'Files and notes below two synced copies') +
      chart('errors', { t: hs.t, start: span.start, end: span.end, unit: 'count', series: [
        { name: 'Errors', color: TONE.warn, values: addArrays(hs.errors_file, hs.errors_note, hs.errors_thumbnail) },
        { name: 'Parked', color: TONE.bad, values: hs.parked },
        { name: 'Stalled deletes', color: PALETTE[2], values: hs.remote_deletes_stalled }
      ] }, 'Problems', 'Replica errors, parked replicas and failing deletes') +
      chart('unverified', { t: hs.t, start: span.start, end: span.end, unit: 'count', area: true, series: [
        { name: 'Unconfirmed', color: PALETTE[0], values: hs.unverified }
      ] }, 'Unconfirmed copies', 'Synced copies not yet hash-confirmed') +
      '</div>'
  }

  function backupsSection (st, hb, thresholds, now) {
    function summary (kind, label, limit, schedule) {
      var b = st.backups[kind], ok = b.last_ok, last = b.last
      if (!last) {
        return '<div class="mon-bk"><div class="mon-row"><span>' + label + '</span>' + H.pill('No runs yet', '') + '</div>' +
          '<p class="mon-sub">Runs appear after the next ' + H.esc(schedule) + ' backup_prod.py run.</p></div>'
      }
      var age = ok ? now - ok.finished : null
      var tone = age == null || age > limit ? 'bad' : 'good'
      var lastTone = last.status !== 'ok' ? 'bad' : last.offsite_ok === false ? 'warn' : 'good'
      var lastLabel = last.status !== 'ok' ? 'Last run failed' : last.offsite_ok === false ? 'Offsite incomplete' : last.offsite_ok ? 'Verified offsite' : 'Local only'
      return '<div class="mon-bk"><div class="mon-row"><span>' + label + '</span>' + H.pill(lastLabel, lastTone, true) + '</div>' +
        '<div class="mon-bk-age is-' + tone + '">' + (ok ? liveAgo(ok.finished, now) : 'Never succeeded') + '</div>' +
        meter(age == null ? 1 : age / limit, tone) +
        '<p class="mon-sub">Runs ' + H.esc(schedule) + ', alerts after ' + dur(limit) + '</p>' +
        H.kvs([['Archive', ok ? H.fmtBytes(ok.bytes) : 'n/a'], ['Duration', dur(last.duration)], ['Last run', fullTime(last.started)]]) +
        (last.status !== 'ok' && last.error ? '<p class="mon-err">' + H.esc(last.error) + '</p>' : '') + '</div>'
    }
    var runs = hb.runs
    function runTone (r) { return r.status !== 'ok' ? 'bad' : r.offsite_ok === false ? 'warn' : 'good' }
    function runLines (r) {
      return [r.status === 'ok' ? 'Succeeded in ' + dur(r.duration) : 'Failed: ' + (r.error || 'unknown error'),
        r.status === 'ok' ? 'Archive ' + H.fmtBytes(r.bytes) : '',
        r.offsite_ok === true ? 'Offsite copy verified' : r.offsite_ok === false ? 'Offsite copy incomplete' : 'No offsite push'].filter(Boolean)
    }
    var lanes = [['db', 'DB'], ['full', 'Full']].map(function (k) {
      return { name: k[1], runs: runs.filter(function (r) { return r.kind === k[0] }).map(function (r) { return { t: r.started, tone: runTone(r), lines: runLines(r) } }) }
    })
    var body = '<div class="mon-bk-grid">' + summary('db', 'Database', thresholds.db_backup, 'every 6 h') + summary('full', 'Full', thresholds.full_backup, 'daily at 03:30 UTC') + '</div>'
    if (runs.length) {
      CHARTS.bkRuns = { timeline: true, lanes: lanes, start: hb.start, end: now, t: [hb.start, now] }
      body += '<div><div class="mon-sub-head">Runs in the last 30 days</div><div class="mon-chart" data-chart="bkRuns" style="height:72px" role="img" aria-label="Backup runs over the last 30 days"></div>' +
        '<div class="mon-legend"><span class="mon-legend-item"><i style="background:var(--good)"></i>Succeeded</span><span class="mon-legend-item"><i style="background:var(--warn)"></i>Offsite incomplete</span><span class="mon-legend-item"><i style="background:var(--bad)"></i>Failed</span></div></div>'
    }
    var out = H.card('Backups', body, { sub: 'Code, config and database archives from backup_prod.py' })
    var ok = runs.filter(function (r) { return r.status === 'ok' })
    if (ok.length > 1) {
      var t = ok.map(function (r) { return r.started })
      out += '<div class="mon-charts is-2">' +
        chart('bkSize', { t: t, start: hb.start, end: now, unit: 'bytes', connect: true, series: [['DB', 'db'], ['Full', 'full']].map(function (s, i) {
          return { name: s[0], color: PALETTE[i], values: ok.map(function (r) { return r.kind === s[1] ? r.bytes : null }) }
        }) }, 'Archive size', 'A sudden drop usually means data missing from the dump') +
        chart('bkDur', { t: runs.map(function (r) { return r.started }), start: hb.start, end: now, unit: 's', bars: true, series: [{
          name: 'Duration', color: 'var(--accent)', values: runs.map(function (r) { return r.duration }),
          colors: runs.map(function (r) { return TONE[runTone(r)] })
        }] }, 'Run duration', 'Bar colour shows the run result') +
        '</div>'
    }
    return '<div class="mon-group">' + out + '</div>'
  }

  // ---- Public API ------------------------------------------------------------------
  var VIEWS = [['overview', 'Overview'], ['storage', 'Storage'], ['trends', 'Trends'], ['backups', 'Backups']]
  var view = (function () { try { return sessionStorage.getItem('adm-mon-view') || 'overview' } catch (e) { return 'overview' } })()
  function render (d, range, helpers) {
    H = helpers
    CHARTS = {}
    skew = d.now - Date.now() / 1000
    var st = d.state, hist = d.history, now = d.now
    var th = d.thresholds
    var width = hist.end - hist.start
    var span = { end: Math.max(hist.end, st.at) }
    span.start = span.end - width
    var rows = evaluate(st, now, th)
    var worst = {}
    rows.forEach(function (r) {
      var rank = { bad: 3, warn: 2, idle: 1, good: 0 }
      if (!worst[r.view] || rank[r.tone] > rank[worst[r.view]]) worst[r.view] = r.tone
    })
    if (!VIEWS.some(function (v) { return v[0] === view })) view = 'overview'

    var tabs = '<div class="rd-tabs mon-tabs" role="tablist" aria-label="Monitoring views">' + VIEWS.map(function (v) {
      var on = v[0] === view, t = v[0] === 'overview' ? '' : worst[v[0]]
      return '<button type="button" class="rd-tab' + (on ? ' is-active' : '') + '" role="tab" id="mon-tab-' + v[0] + '" aria-controls="mon-view-' + v[0] + '" aria-selected="' + on + '" data-mon-view="' + v[0] + '">' +
        H.esc(v[1]) + (t === 'bad' || t === 'warn' ? '<span class="mon-tab-dot is-' + t + '" aria-label="needs attention"></span>' : '') + '</button>'
    }).join('') + '</div>'
    var live = '<span class="mon-live" data-mon-live role="status"><i aria-hidden="true"></i><span class="mon-live-text">Live, updated ' + liveAgo(st.at, now) + '</span></span>'
    var rangeBar = '<div class="mon-view-bar"><span>Snapshots every 5 minutes; the last point is live.</span><div class="rd-tabs mon-range" role="group" aria-label="Chart range">' + RANGES.map(function (r) {
      return '<button type="button" class="rd-tab' + (r[0] === range ? ' is-active' : '') + '" data-mon-range="' + r[0] + '" aria-pressed="' + (r[0] === range) + '">' + r[1] + '</button>'
    }).join('') + '</div></div>'
    function pane (id, html) {
      return '<div class="mon-view" role="tabpanel" id="mon-view-' + id + '" aria-labelledby="mon-tab-' + id + '"' + (id === view ? '' : ' hidden') + '>' + html + '</div>'
    }
    return '<div class="mon">' +
      '<header class="mon-head"><h1 class="rd-page-title">Monitoring</h1>' + live + '</header>' + tabs +
      pane('overview', overview(rows, st, now)) +
      pane('storage', nodesCard(st, now) + '<div class="mon-pair">' + durabilityCard(st) + jobsCard(st, now, th) + '</div>') +
      pane('trends', rangeBar + trends(st, hist, span)) +
      pane('backups', backupsSection(st, hist.backups, th, now)) +
      '</div>'
  }

  function setView (panel, v) {
    view = v
    try { sessionStorage.setItem('adm-mon-view', v) } catch (e) {}
    panel.querySelectorAll('.mon-tabs [data-mon-view]').forEach(function (b) {
      var on = b.getAttribute('data-mon-view') === v
      b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on))
    })
    panel.querySelectorAll('.mon-view').forEach(function (p) { p.hidden = p.id !== 'mon-view-' + v })
    drawAll(panel)
  }

  function tick (panel) {
    var now = serverNow()
    panel.querySelectorAll('[data-ago]').forEach(function (el) {
      var txt = ago(+el.getAttribute('data-ago'), now)
      if (el.textContent !== txt) el.textContent = txt
    })
  }

  function onClick (e) {
    var b = e.target.closest && e.target.closest('[data-mon-view]')
    if (!b) return
    var panel = b.closest('.mon').parentNode
    setView(panel, b.getAttribute('data-mon-view'))
    if (!b.closest('.mon-tabs')) { var tab = panel.querySelector('#mon-tab-' + view); if (tab) tab.focus() }
  }

  function mount (panel) {
    drawAll(panel)
    if (!panel._monWired) {
      panel._monWired = true
      panel.addEventListener('mousemove', onHover)
      panel.addEventListener('mouseout', function (e) { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.mon-chart')) onLeave(e) })
      panel.addEventListener('click', onClick)
    }
    clearInterval(ticker)
    ticker = setInterval(function () { tick(panel) }, 1000)
    if (observer) observer.disconnect()
    if (window.ResizeObserver) {
      var lastW = panel.clientWidth, pending = false
      observer = new ResizeObserver(function () {
        if (pending || panel.clientWidth === lastW) return
        pending = true
        requestAnimationFrame(function () { pending = false; lastW = panel.clientWidth; drawAll(panel) })
      })
      observer.observe(panel)
    }
  }
  function unmount () {
    if (observer) { observer.disconnect(); observer = null }
    clearInterval(ticker); ticker = null
    CHARTS = {}
  }
  // A chart tooltip is open: a repaint now would yank it from under the pointer.
  function busy (panel) { return !!panel.querySelector('.mon-tip:not([hidden])') }
  // ok=true: fresh data just painted; ok=false: the last refresh failed.
  function setLive (panel, ok) {
    var el = panel.querySelector('[data-mon-live]')
    if (!el) return
    el.classList.toggle('is-stale', !ok)
    var txt = el.querySelector('.mon-live-text')
    if (txt && !ok) {
      var ts = el.querySelector('[data-ago]')
      txt.innerHTML = 'Not updating, last data ' + (ts ? ts.outerHTML : '')
    }
    if (ok) { el.classList.remove('is-pulse'); void el.offsetWidth; el.classList.add('is-pulse') }
  }

  window.AdmMonitor = { render: render, mount: mount, unmount: unmount, busy: busy, setLive: setLive }
})()
