/* ============================================================================
   admin-monitor.js — Monitoring tab of the admin console (admin.js).
   Renders /admin/api/monitoring: open issues, KPIs with sparklines, payload
   durability, node health, background jobs, history charts and backup runs.
   Charts are plain SVG drawn at the container's real width (no library);
   admin.js owns fetching, the refresh timer and tab lifecycle.
   ========================================================================== */
(function () {
  'use strict'
  var H = null // markup helpers handed over by admin.js (esc, num, fmtBytes, pill, head, card, kvs)
  var CHARTS = {}
  var observer = null
  var PALETTE = ['var(--accent)', 'var(--kind-media)', 'var(--kind-code)', 'var(--kind-image)', 'var(--kind-doc)']
  var TONE = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)', muted: 'var(--line-strong)' }
  var RANGES = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']]

  // ---- Formatting ------------------------------------------------------------
  function ago (ts, now) {
    if (!ts) return 'never'
    var s = Math.max(0, now - ts)
    if (s < 60) return s + ' s ago'
    if (s < 3600) return Math.floor(s / 60) + ' min ago'
    if (s < 172800) return Math.floor(s / 3600) + ' h ago'
    return Math.floor(s / 86400) + ' d ago'
  }
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

  // ---- Small inline graphics -----------------------------------------------------
  function sparkline (values, color) {
    var v = (values || []).filter(function (x) { return x != null })
    if (v.length < 2) return '<div class="mon-spark is-empty"></div>'
    var max = Math.max.apply(null, v), min = Math.min.apply(null, v), span = max - min || 1
    var pts = v.map(function (x, i) { return (i / (v.length - 1) * 100).toFixed(2) + ',' + (26 - (x - min) / span * 24).toFixed(2) }).join(' ')
    return '<svg class="mon-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + pts + '" style="fill:none;stroke:' + (color || 'var(--text-dim)') + '" vector-effect="non-scaling-stroke"/></svg>'
  }
  function donut (pct, tone) {
    var r = 15.915, c = Math.max(0, Math.min(100, pct))
    return '<svg class="mon-donut" viewBox="0 0 36 36" role="img" aria-label="' + c.toFixed(1) + '% synced">' +
      '<circle cx="18" cy="18" r="' + r + '" style="fill:none;stroke:var(--press);stroke-width:3.2"/>' +
      '<circle cx="18" cy="18" r="' + r + '" transform="rotate(-90 18 18)" style="fill:none;stroke:' + TONE[tone] +
      ';stroke-width:3.2;stroke-linecap:round" stroke-dasharray="' + c.toFixed(2) + ' 100"/>' +
      '<text x="18" y="20.4" text-anchor="middle">' + (c >= 99.95 ? '100' : c.toFixed(1)) + '%</text></svg>'
  }
  // segments: [{label, value, color}] — one horizontal stacked bar + legend
  function stackBar (segments, total) {
    total = total || sum(segments.map(function (s) { return s.value }))
    var bar = segments.map(function (s) {
      if (!s.value || !total) return ''
      return '<span style="flex-grow:' + s.value + ';background:' + s.color + '" title="' + H.esc(s.label + ': ' + H.num(s.value)) + '"></span>'
    }).join('')
    var legend = segments.map(function (s) {
      return '<span class="mon-legend-item"><i style="background:' + s.color + '"></i>' + H.esc(s.label) + ' <b>' + H.num(s.value) + '</b></span>'
    }).join('')
    return '<div class="mon-stack" role="img" aria-label="' + H.esc(segments.map(function (s) { return s.label + ' ' + s.value }).join(', ')) + '">' +
      (bar || '<span style="flex-grow:1;background:var(--press)"></span>') + '</div><div class="mon-legend">' + legend + '</div>'
  }
  function freshness (label, last, interval, now, detail) {
    var age = last ? now - last : null
    var limit = Math.max(interval, 1) * 3
    var tone = age == null ? 'bad' : age <= interval * 1.5 + 30 ? 'good' : age <= limit + 120 ? 'warn' : 'bad'
    var w = age == null ? 100 : Math.min(100, Math.max(3, age / limit * 100))
    return '<div class="mon-fresh"><div class="mon-fresh-row"><span>' + H.esc(label) + '</span><b class="is-' + tone + '">' + H.esc(ago(last, now)) + '</b></div>' +
      '<div class="adm-meter"><div class="adm-meter-fill' + (tone === 'good' ? '' : ' is-' + tone) + '" style="width:' + w.toFixed(1) + '%"></div></div>' +
      '<p class="mon-fresh-sub">' + H.esc(detail) + '</p></div>'
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
        : '<div class="mon-chart" data-chart="' + key + '" style="height:' + (spec.height || 168) + 'px" role="img" aria-label="' + H.esc(title) + '"></div>' + legend) +
      '</section>'
  }

  function drawLine (el, spec) {
    var W = el.clientWidth, Hh = el.clientHeight
    if (!W) return
    var padL = 56, padR = 8, padT = 8, padB = 22
    var iw = W - padL - padR, ih = Hh - padT - padB
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
    function x (ts) { return padL + (t1 > t0 ? (ts - t0) / (t1 - t0) : 0) * iw }
    function y (v) { return padT + ih - v / max * ih }
    var out = ''
    for (var g = 0; g <= 2; g++) {
      var gv = max * g / 2, gy = y(gv).toFixed(1)
      out += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy + '" y2="' + gy + '" class="mon-grid"/>' +
        '<text x="' + (padL - 8) + '" y="' + (+gy + 4) + '" text-anchor="end" class="mon-axis">' + H.esc(fmt(spec.unit, gv)) + '</text>'
    }
    var ticks = Math.max(2, Math.min(6, Math.floor(iw / 110)))
    for (var k = 0; k <= ticks; k++) {
      var ts = t0 + (t1 - t0) * k / ticks
      out += '<text x="' + x(ts).toFixed(1) + '" y="' + (Hh - 5) + '" text-anchor="' + (k === 0 ? 'start' : k === ticks ? 'end' : 'middle') + '" class="mon-axis">' + H.esc(clockLabel(ts, t1 - t0)) + '</text>'
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
            out += '<path d="' + d + lower + 'Z" style="fill:' + s.color + ';opacity:.16"/>'
          }
          out += '<path d="' + d + '" style="fill:none;stroke:' + s.color + ';stroke-width:1.6;stroke-linejoin:round"/>'
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
    var padL = 56, padR = 10, laneH = 26, top = 6
    var iw = W - padL - padR, t0 = spec.start, t1 = spec.end
    function x (ts) { return padL + (ts - t0) / (t1 - t0) * iw }
    var out = ''
    spec.lanes.forEach(function (lane, li) {
      var cy = top + li * laneH + laneH / 2
      out += '<text x="' + (padL - 10) + '" y="' + (cy + 4) + '" text-anchor="end" class="mon-axis">' + H.esc(lane.name) + '</text>' +
        '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + cy + '" y2="' + cy + '" class="mon-grid"/>'
      lane.runs.forEach(function (r) {
        out += '<circle cx="' + x(r.t).toFixed(1) + '" cy="' + cy + '" r="4.5" style="fill:' + TONE[r.tone] + '"/>'
      })
    })
    var ticks = Math.max(2, Math.min(6, Math.floor(iw / 110)))
    for (var k = 0; k <= ticks; k++) {
      var ts = t0 + (t1 - t0) * k / ticks
      out += '<text x="' + x(ts).toFixed(1) + '" y="' + (Hh - 5) + '" text-anchor="' + (k === 0 ? 'start' : k === ticks ? 'end' : 'middle') + '" class="mon-axis">' + H.esc(clockLabel(ts, t1 - t0)) + '</text>'
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
      html = '<b>' + H.esc(lane.name + ' · ' + fullTime(best.r.t)) + '</b>' + best.r.lines.map(function (l) { return '<div>' + H.esc(l) + '</div>' }).join('')
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

  // ---- Sections ------------------------------------------------------------------
  function statusBlock (issues) {
    var crit = issues.filter(function (i) { return i.severity === 'critical' })
    var warn = issues.filter(function (i) { return i.severity === 'warning' })
    var info = issues.filter(function (i) { return i.severity === 'info' })
    var tone = crit.length ? 'bad' : warn.length ? 'warn' : 'good'
    var headline = crit.length ? H.num(crit.length) + ' critical issue' + (crit.length === 1 ? '' : 's') + (warn.length ? ' and ' + H.num(warn.length) + ' warning' + (warn.length === 1 ? '' : 's') : '')
      : warn.length ? H.num(warn.length) + ' warning' + (warn.length === 1 ? '' : 's') : 'All systems healthy'
    var sub = crit.length ? 'Data durability or availability needs attention now.' : warn.length ? 'Nothing is at risk yet, but something is degrading.' : 'Replication, background jobs and backups are within their limits.'
    var rows = crit.concat(warn).map(function (i) {
      return '<li class="mon-issue is-' + (i.severity === 'critical' ? 'bad' : 'warn') + '"><span class="mon-issue-dot"></span><span>' + H.esc(i.summary) + '</span>' +
        '<span class="mon-issue-sev">' + (i.severity === 'critical' ? 'Critical' : 'Warning') + '</span></li>'
    }).join('')
    var notes = info.length ? '<p class="mon-notes">' + info.map(function (i) { return H.esc(i.summary) }).join(' · ') + '</p>' : ''
    return '<section class="rd-panel mon-status is-' + tone + '"><div class="mon-status-head"><span class="mon-status-mark"></span><div>' +
      '<h2>' + H.esc(headline) + '</h2><p>' + H.esc(sub) + '</p></div></div>' +
      (rows ? '<ul class="mon-issues">' + rows + '</ul>' : '') + notes + '</section>'
  }

  function kpi (label, value, foot, tone, spark, sparkColor) {
    return '<div class="mon-kpi is-' + (tone || 'neutral') + '"><div class="mon-kpi-label">' + H.esc(label) + '</div>' +
      '<div class="mon-kpi-val">' + H.esc(value) + '</div>' + sparkline(spark, sparkColor) +
      '<div class="mon-kpi-foot">' + H.esc(foot) + '</div></div>'
  }

  function kpis (st, hs, remotes, now) {
    var backlog = st.backlog.file + st.backlog.note + st.backlog.thumbnail
    var risk = st.single_copy.file + st.single_copy.note + st.zero_copy.file + st.zero_copy.note
    var rd = st.remote_deletes
    var tp = remotes.map(throughput)
    var tpSum = tp.length ? tp[0].map(function (_, i) { return sum(tp.map(function (a) { return a[i] })) }) : []
    var gained = sum(remotes.map(function (n) { return Math.max(0, n.bytes[n.bytes.length - 1] - n.bytes[0]) }))
    var lastRate = tpSum.length ? tpSum[tpSum.length - 1] : null
    return '<div class="mon-kpis">' +
      kpi('Replication backlog', H.num(backlog), H.num(st.backlog.file) + ' files · ' + H.num(st.backlog.note) + ' notes · ' + H.num(st.backlog.thumbnail) + ' thumbs',
        backlog ? 'warn' : 'good', addArrays(hs.backlog_file, hs.backlog_note, hs.backlog_thumbnail)) +
      kpi('Copied to remote', '+' + H.fmtBytes(gained), lastRate != null ? 'Now ' + rate(lastRate) + ' (net, ' + remotes.length + ' remote)' : 'Net growth in range',
        'neutral', tpSum, 'var(--accent)') +
      kpi('Payloads at risk', H.num(risk), H.num(st.zero_copy.file + st.zero_copy.note) + ' with no copy · ' + H.num(st.single_copy.file + st.single_copy.note) + ' with one',
        (st.zero_copy.file + st.zero_copy.note) ? 'bad' : risk ? 'warn' : 'good', addArrays(hs.single_copy_file, hs.single_copy_note, hs.zero_copy_file, hs.zero_copy_note)) +
      kpi('Replica errors', H.num(st.errors), H.num(st.parked) + ' parked (no more retries)',
        st.parked ? 'bad' : st.errors ? 'warn' : 'good', addArrays(hs.errors_file, hs.errors_note, hs.errors_thumbnail)) +
      kpi('Remote deletes queued', H.num(rd.queued), (rd.oldest ? 'Oldest ' + ago(rd.oldest, now).replace(' ago', '') : 'Queue empty') + (rd.stalled ? ' · ' + H.num(rd.stalled) + ' stalled' : ''),
        rd.stalled ? 'warn' : 'neutral', hs.remote_deletes) +
      kpi('Unconfirmed copies', H.num(st.unverified), 'Synced but not hash-checked on the node', 'neutral', hs.unverified) +
      '</div>'
  }

  function durabilityCard (st) {
    function row (label, total, single, zero) {
      var multi = Math.max(0, total - single - zero)
      return '<div class="mon-dur"><div class="mon-dur-head"><span>' + H.esc(label) + '</span><b>' + H.num(total) + '</b></div>' +
        stackBar([{ label: '2+ copies', value: multi, color: TONE.good }, { label: '1 copy', value: single, color: TONE.warn }, { label: 'No copy', value: zero, color: TONE.bad }], total) + '</div>'
    }
    var body = st.multi_node
      ? row('Files', st.payloads.file, st.single_copy.file, st.zero_copy.file) + row('Notes', st.payloads.note, st.single_copy.note, st.zero_copy.note) +
        '<p class="adm-note">Payloads are not in backup archives: replicas are their only copies. ' +
        (st.single_copy.thumbnail ? H.num(st.single_copy.thumbnail) + ' thumbnails also have a single copy.' : 'Every thumbnail has 2+ copies.') + '</p>'
      : '<p class="adm-note">Only one storage node is enabled, so every payload has exactly one copy.</p>'
    return H.card('Payload durability', body, { sub: 'Synced copies per payload across enabled nodes' })
  }

  function jobsCard (st, now) {
    var j = st.jobs
    var disk = st.disk
    var diskRow = ''
    if (disk && disk.total) {
      var used = (disk.total - disk.free) / disk.total * 100
      var tone = used >= 90 ? 'bad' : used >= 80 ? 'warn' : ''
      diskRow = '<div class="mon-fresh"><div class="mon-fresh-row"><span>Local disk</span><b class="is-' + (tone || 'good') + '">' + used.toFixed(0) + '% used</b></div>' +
        '<div class="adm-meter"><div class="adm-meter-fill' + (tone ? ' is-' + tone : '') + '" style="width:' + used.toFixed(1) + '%"></div></div>' +
        '<p class="mon-fresh-sub">' + H.fmtBytes(disk.free) + ' free of ' + H.fmtBytes(disk.total) + '</p></div>'
    }
    return H.card('Background jobs',
      freshness('Scheduler heartbeat', j.scheduler.last, j.scheduler.interval, now, 'Every ' + dur(j.scheduler.interval) + '. Drives replication, scrub and deletes.') +
      freshness('Health check', j.health_check.last, j.health_check.interval, now, 'Every ' + dur(j.health_check.interval) + '. Probes each storage node.') +
      freshness('Integrity scrub', j.integrity_scrub.last, j.integrity_scrub.interval, now, 'Every ' + dur(j.integrity_scrub.interval) + '. Re-checks stored copies.') +
      diskRow,
      { sub: 'Bars fill as a job gets late; red past 3 intervals' })
  }

  function nodesCard (st, now) {
    var enabled = st.nodes.filter(function (n) { return n.enabled })
    var disabled = st.nodes.length - enabled.length
    var rows = enabled.map(function (n) {
      var tone = !n.up ? 'bad' : n.coverage < 99.9 ? 'warn' : 'good'
      var va = n.verify_age || {}
      var check = n.checksum === true ? 'SHA-256' : n.checksum === false ? 'Size only' : 'Unprobed'
      return '<div class="mon-node">' + donut(n.coverage, tone) +
        '<div class="mon-node-main"><div class="mon-node-title"><b>' + H.esc(n.name) + '</b>' +
        H.pill(n.up ? 'Online' : n.status.charAt(0).toUpperCase() + n.status.slice(1), n.up ? 'good' : 'bad', true) +
        (n.primary ? H.pill('Primary', '') : '') + '<span class="mon-node-type">' + H.esc(n.type === 's3' ? 'S3' : n.type === 'ssh' ? 'SSH' : 'Local') + '</span></div>' +
        '<div class="mon-node-facts">' +
        '<span><b>' + H.fmtBytes(n.synced_bytes) + '</b> stored</span>' +
        '<span><b>' + H.num(n.synced) + '</b> copies</span>' +
        '<span class="' + (n.pending ? 'is-warn' : '') + '"><b>' + H.num(n.pending) + '</b> pending</span>' +
        '<span class="' + (n.errors ? 'is-bad' : '') + '"><b>' + H.num(n.errors) + '</b> errors</span>' +
        (n.missing ? '<span class="is-bad"><b>' + H.num(n.missing) + '</b> missing</span>' : '') +
        '<span>Seen ' + H.esc(ago(n.last_seen, now)) + (n.failures ? ' · ' + H.num(n.failures) + ' failed probes' : '') + '</span>' +
        '<span>' + H.esc(check) + ' · ' + H.num(sum(Object.values(n.unverified))) + ' unconfirmed</span></div>' +
        '<div class="mon-node-verify"><span class="mon-node-verify-label">Last verified</span>' +
        stackBar([
          { label: '< 1 day', value: va.d1 || 0, color: TONE.good },
          { label: '1-7 days', value: va.d7 || 0, color: 'color-mix(in srgb,var(--good) 55%,var(--press))' },
          { label: '7-30 days', value: va.d30 || 0, color: TONE.warn },
          { label: 'Older', value: va.older || 0, color: TONE.bad },
          { label: 'Never', value: va.never || 0, color: TONE.muted }
        ]) + '</div></div></div>'
    }).join('')
    return H.card('Storage nodes', rows || '<p class="adm-note">No enabled storage nodes.</p>',
      { sub: 'Ring: share of copies synced on the node' + (disabled ? ' · ' + disabled + ' disabled node' + (disabled === 1 ? '' : 's') + ' hidden' : '') })
  }

  function backupsSection (st, hb, thresholds, now) {
    function summary (kind, label, limit, schedule) {
      var b = st.backups[kind], ok = b.last_ok, last = b.last
      if (!last) {
        return '<div class="mon-bk"><div class="mon-bk-head"><span>' + label + '</span>' + H.pill('No runs yet', '') + '</div>' +
          '<p class="adm-note">Runs appear after the next ' + H.esc(schedule) + ' backup_prod.py run.</p></div>'
      }
      var age = ok ? now - ok.finished : null
      var tone = age == null ? 'bad' : age <= limit / 2 ? 'good' : age <= limit ? 'warn' : 'bad'
      var lastTone = last.status !== 'ok' ? 'bad' : last.offsite_ok === false ? 'warn' : 'good'
      var lastLabel = last.status !== 'ok' ? 'Last run failed' : last.offsite_ok === false ? 'Offsite incomplete' : last.offsite_ok ? 'Verified offsite' : 'Local only'
      return '<div class="mon-bk"><div class="mon-bk-head"><span>' + label + '</span>' + H.pill(lastLabel, lastTone, true) + '</div>' +
        '<div class="mon-bk-age is-' + tone + '">' + (ok ? H.esc(ago(ok.finished, now)) : 'Never succeeded') + '</div>' +
        '<div class="adm-meter"><div class="adm-meter-fill' + (tone === 'good' ? '' : ' is-' + tone) + '" style="width:' + (age == null ? 100 : Math.min(100, age / limit * 100)).toFixed(1) + '%"></div></div>' +
        '<p class="mon-fresh-sub">Alert after ' + dur(limit) + ' · ' + H.esc(schedule) + '</p>' +
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
    var html = '<div class="mon-bk-grid">' + summary('db', 'Database backup', thresholds.db_backup, 'every 6 h') + summary('full', 'Full backup', thresholds.full_backup, 'daily 03:30 UTC') + '</div>'
    var body = html
    if (runs.length) {
      CHARTS.bkRuns = { timeline: true, lanes: lanes, start: hb.start, end: now, t: [hb.start, now] }
      body += '<div class="mon-sub-head">Runs, last 30 days</div><div class="mon-chart" data-chart="bkRuns" style="height:80px" role="img" aria-label="Backup runs over the last 30 days"></div>' +
        '<div class="mon-legend"><span class="mon-legend-item"><i style="background:var(--good)"></i>Succeeded</span><span class="mon-legend-item"><i style="background:var(--warn)"></i>Offsite incomplete</span><span class="mon-legend-item"><i style="background:var(--bad)"></i>Failed</span></div>'
    }
    var out = H.card('Backups', body, { sub: 'backup_prod.py runs: code, config and database (payloads rely on replicas)' })
    var ok = runs.filter(function (r) { return r.status === 'ok' })
    if (ok.length > 1) {
      var sizeSeries = lanes.map(function (l, i) {
        return { name: l.name, color: PALETTE[i], kind: ['db', 'full'][i] }
      })
      var t = ok.map(function (r) { return r.started })
      out += '<div class="adm-grid2">' +
        chart('bkSize', { t: t, start: hb.start, end: now, unit: 'bytes', connect: true, series: sizeSeries.map(function (s) {
          return { name: s.name, color: s.color, values: ok.map(function (r) { return r.kind === s.kind ? r.bytes : null }) }
        }) }, 'Archive size', 'A sudden drop usually means data missing from the dump') +
        chart('bkDur', { t: runs.map(function (r) { return r.started }), start: hb.start, end: now, unit: 's', bars: true, series: [{
          name: 'Duration', color: 'var(--accent)', values: runs.map(function (r) { return r.duration }),
          colors: runs.map(function (r) { return TONE[runTone(r)] })
        }] }, 'Run duration', 'Bar colour shows the run result') +
        '</div>'
    }
    return out
  }

  // ---- Public API ------------------------------------------------------------------
  function render (d, range, helpers) {
    H = helpers
    CHARTS = {}
    var st = d.state, hist = d.history, hs = hist.system, now = d.now
    var primary = null
    st.nodes.forEach(function (n) { if (n.primary && n.enabled) primary = n })
    var nodeHist = hist.nodes.filter(function (n) { return st.nodes.some(function (s) { return s.id === n.id && s.enabled }) })
    var primaryHist = primary ? nodeHist.filter(function (n) { return n.id === primary.id })[0] : null
    var remotes = nodeHist.filter(function (n) { return n.type !== 'local' && (!primary || n.id !== primary.id) })
    var span = { start: hist.start, end: hist.end }

    var axis = remotes.length ? remotes[0].t : []
    var charts = '<div class="adm-grid2">' +
      chart('tp', { t: axis, start: span.start, end: span.end, unit: 'Bps', series: remotes.map(function (n, i) {
        return { name: n.name, color: PALETTE[i % PALETTE.length], values: onAxis(axis, n, throughput(n)) }
      }), area: true }, 'Replication throughput', 'Net bytes per second landing on each remote node') +
      (primaryHist ? chart('lag', { t: axis, start: span.start, end: span.end, unit: 'bytes', area: true, series: remotes.map(function (n, i) {
        return { name: n.name, color: PALETTE[i % PALETTE.length], values: onAxis(axis, n, lagSeries(n, primaryHist)) }
      }) }, 'Behind the primary', 'Bytes on ' + primary.name + ' not yet on each remote node') : '') +
      chart('backlog', { t: hs.t, start: span.start, end: span.end, unit: 'count', stacked: true, series: [
        { name: 'Files', color: PALETTE[0], values: hs.backlog_file },
        { name: 'Notes', color: PALETTE[1], values: hs.backlog_note },
        { name: 'Thumbnails', color: PALETTE[2], values: hs.backlog_thumbnail }
      ] }, 'Replication backlog', 'Copies waiting to be written, by kind') +
      chart('risk', { t: hs.t, start: span.start, end: span.end, unit: 'count', series: [
        { name: 'One copy', color: TONE.warn, values: addArrays(hs.single_copy_file, hs.single_copy_note) },
        { name: 'No copy', color: TONE.bad, values: addArrays(hs.zero_copy_file, hs.zero_copy_note) }
      ] }, 'Payloads at risk', 'Files and notes below two synced copies') +
      chart('errors', { t: hs.t, start: span.start, end: span.end, unit: 'count', series: [
        { name: 'Errors', color: TONE.warn, values: addArrays(hs.errors_file, hs.errors_note, hs.errors_thumbnail) },
        { name: 'Parked', color: TONE.bad, values: hs.parked }
      ] }, 'Replica errors', 'Parked replicas stopped retrying and need an admin') +
      chart('deletes', { t: hs.t, start: span.start, end: span.end, unit: 'count', area: true, series: [
        { name: 'Queued', color: PALETTE[0], values: hs.remote_deletes },
        { name: 'Stalled', color: TONE.bad, values: hs.remote_deletes_stalled }
      ] }, 'Remote delete queue', 'Objects waiting to be removed from remote nodes') +
      '</div>'

    var rangeBtns = '<div class="mon-range" role="group" aria-label="Time range">' + RANGES.map(function (r) {
      return '<button class="rd-btn rd-btn-sm' + (r[0] === range ? ' is-on' : ' rd-btn-ghost') + '" data-mon-range="' + r[0] + '" aria-pressed="' + (r[0] === range) + '">' + r[1] + '</button>'
    }).join('') + '</div>'

    return H.head('Monitoring', 'Storage replication, durability and backups · updated ' + new Date(now * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ', refreshes every minute', rangeBtns) +
      '<div class="adm-stack mon">' +
      statusBlock(st.issues) +
      kpis(st, hs, remotes, now) +
      '<div class="adm-grid2">' + durabilityCard(st) + jobsCard(st, now) + '</div>' +
      nodesCard(st, now) +
      '<h2 class="mon-section">Trends</h2>' + charts +
      backupsSection(st, hist.backups, d.thresholds, now) +
      '</div>'
  }

  function mount (panel) {
    drawAll(panel)
    if (!panel._monHover) {
      panel._monHover = true
      panel.addEventListener('mousemove', onHover)
      panel.addEventListener('mouseout', function (e) { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.mon-chart')) onLeave(e) })
    }
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
  function unmount () { if (observer) { observer.disconnect(); observer = null } CHARTS = {} }

  window.AdmMonitor = { render: render, mount: mount, unmount: unmount }
})()
