/* ============================================================================
   admin-monitor.js — Monitoring tab of the admin console (admin.js).
   A four-view dashboard (Overview, Storage, Trends, Backups) built from
   /admin/api/monitoring. Each view fits one screen; the toolbar's time range
   applies to every sparkline, timeline and chart.
   Issue rules live on the server (_monitor_issues): this file maps each issue
   code to a check and takes every colour from those issues, never from
   thresholds of its own.
   Charts are plain SVG drawn at the container's real width (no library).
   admin.js owns fetching and the live refresh timer, and loads this file when
   the Monitoring tab first opens; this file owns the once-a-second "x s ago"
   ticker and the view tabs.
   ========================================================================== */
(function () {
  'use strict'
  var H = null // markup helpers handed over by admin.js (esc, num, fmtBytes, pill)
  var CHARTS = {}
  var observer = null
  var ticker = null
  var root = null // the admin panel while mounted
  var keep = { focus: '', scroll: 0 } // carried across a live repaint
  var skew = 0 // server clock minus browser clock, seconds
  var PALETTE = ['var(--accent)', 'var(--kind-media)', 'var(--kind-code)', 'var(--kind-image)', 'var(--kind-doc)']
  var TONE = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)', muted: 'var(--line-strong)' }
  var RANGES = [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d']]
  var VIEWS = [['overview', 'Overview'], ['storage', 'Storage'], ['trends', 'Trends'], ['backups', 'Backups']]
  var view = (function () { try { return sessionStorage.getItem('adm-mon-view') || 'overview' } catch (e) { return 'overview' } })()
  // Overview checks: [id, label, view holding the details, issue codes from _monitor_issues]
  var CHECKS = [
    ['durability', 'Durability', 'storage', ['zero_copy', 'aged_single_copy']],
    ['replication', 'Replication', 'storage', ['parked_replicas', 'remote_delete_stalled']],
    ['nodes', 'Storage nodes', 'storage', ['node_down', 'missing_replicas', 'size_only_node']],
    ['verification', 'Verification', 'storage', ['scrub_behind']],
    ['jobs', 'Jobs', 'storage', ['scheduler_stalled', 'job_overdue']],
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

  // ---- Building blocks ------------------------------------------------------------
  // Compact dashboard panel. o: { note (after the title), meta (html, right), tip (hover text), cls, flush }
  function panel (title, body, o) {
    o = o || {}
    return '<section class="rd-panel mon-p' + (o.cls ? ' ' + o.cls : '') + '">' +
      '<header class="mon-p-head"' + (o.tip ? ' title="' + H.esc(o.tip) + '"' : '') + '><h3>' + H.esc(title) + (o.note ? ' <small>' + H.esc(o.note) + '</small>' : '') + '</h3>' +
      (o.meta ? '<span class="mon-p-meta">' + o.meta + '</span>' : '') + '</header>' +
      '<div class="mon-p-body' + (o.flush ? ' is-flush' : '') + '">' + body + '</div></section>'
  }
  function meter (fraction, tone) {
    var w = Math.max(0, Math.min(1, fraction || 0)) * 100
    return '<div class="adm-meter"><div class="adm-meter-fill' + (tone && tone !== 'good' ? ' is-' + tone : '') + '" style="width:' + w.toFixed(1) + '%"></div></div>'
  }
  // Zero-based area sparkline on the dashboard's time axis.
  function spark (t, values, start, end, color) {
    var pts = []
    ;(t || []).forEach(function (ts, i) { if (values[i] != null) pts.push([ts, values[i]]) })
    if (pts.length < 2) return '<span class="mon-spark is-empty"></span>'
    var max = Math.max.apply(null, pts.map(function (q) { return q[1] })) || 1
    var w = Math.max(1, end - start)
    var xy = pts.map(function (q) { return [((q[0] - start) / w * 100).toFixed(2), (27 - q[1] / max * 24).toFixed(2)] })
    var line = xy.map(function (q) { return q.join(',') }).join(' ')
    return '<svg class="mon-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">' +
      '<polygon points="' + xy[0][0] + ',28 ' + line + ' ' + xy[xy.length - 1][0] + ',28" style="fill:' + color + ';opacity:.13"/>' +
      '<polyline points="' + line + '" style="fill:none;stroke:' + color + '" vector-effect="non-scaling-stroke"/></svg>'
  }
  // segments: [{label, value, color}] — one horizontal stacked bar + legend
  function stackBar (segments, total, hideZero) {
    total = total || sum(segments.map(function (x) { return x.value }))
    var bar = segments.map(function (x) {
      if (!x.value || !total) return ''
      return '<span style="flex-grow:' + x.value + ';background:' + x.color + '" title="' + H.esc(x.label + ': ' + H.num(x.value)) + '"></span>'
    }).join('')
    var legend = segments.map(function (x) {
      if (hideZero && !x.value) return ''
      return '<span class="mon-legend-item' + (x.value ? '' : ' is-zero') + '"><i style="background:' + x.color + '"></i>' + H.esc(x.label) + ' <b>' + H.num(x.value) + '</b></span>'
    }).join('')
    return '<div class="mon-stack" role="img" aria-label="' + H.esc(segments.map(function (x) { return x.label + ' ' + x.value }).join(', ')) + '">' +
      (bar || '<span style="flex-grow:1;background:var(--press)"></span>') + '</div><div class="mon-legend">' + legend + '</div>'
  }

  // ---- Chart registry (drawn after paint, at real width) ----------------------------
  function chart (key, spec, title, tip) {
    CHARTS[key] = spec
    function last (x) { for (var i = x.values.length - 1; i >= 0; i--) if (x.values[i] != null) return x.values[i]; return null }
    var series = spec.series || [], multi = series.length > 1
    var legend = multi ? '<div class="mon-legend">' + series.map(function (x) {
      return '<span class="mon-legend-item"><i style="background:' + x.color + '"></i>' + H.esc(x.name) + ' <b>' + H.esc(fmt(spec.unit, last(x))) + '</b></span>'
    }).join('') + '</div>' : ''
    var empty = !spec.t || spec.t.length < 2
    return panel(title, empty ? '<div class="mon-chart-empty">Collecting data. Charts fill in as 5-minute snapshots arrive.</div>'
      : '<div class="mon-chart" data-chart="' + key + '" style="height:' + (spec.height || 150) + 'px" role="img" aria-label="' + H.esc(title + (tip ? ': ' + tip : '')) + '"></div>' + legend,
    { tip: tip, cls: 'mon-chart-card', meta: !multi && series.length && !empty ? H.esc(fmt(spec.unit, last(series[0]))) : '' })
  }

  function drawLine (el, spec, W, Hh) {
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
    el._geo = { x: x, padL: padL, iw: iw, W: W, Hh: Hh }
  }

  function drawTimeline (el, spec, W, Hh) {
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
    el._geo = { x: x, padL: padL, iw: iw, W: W, Hh: Hh, laneH: laneH, top: top }
  }

  // Visible charts only, all measured before any is drawn (one layout instead
  // of one per chart); a chart already drawn at its size is left as it is.
  function drawAll (root) {
    var todo = []
    root.querySelectorAll('.mon-view:not([hidden]) .mon-chart').forEach(function (el) {
      var spec = CHARTS[el.getAttribute('data-chart')]
      if (spec) todo.push({ el: el, spec: spec })
    })
    todo.forEach(function (c) { c.W = c.el.clientWidth; c.H = c.el.clientHeight })
    todo.forEach(function (c) {
      var g = c.el._geo
      if (!c.W || (c.el._spec === c.spec && g && g.W === c.W && g.Hh === c.H)) return
      if (c.spec.timeline) drawTimeline(c.el, c.spec, c.W, c.H); else drawLine(c.el, c.spec, c.W, c.H)
      c.el._spec = c.spec; c.el._box = null; c.el._tipKey = null
    })
  }

  // Pointer moves are handled once per frame. The chart's box is read once per
  // hover (dropped on scroll, leave and redraw); the tooltip text and the
  // crosshairs change only when the hovered point does; the tooltip moves by
  // transform.
  var hover = null, hoverFrame = 0
  function onHover (e) {
    var el = e.target.closest && e.target.closest('.mon-chart')
    if (!el || !el._geo) return
    hover = { el: el, x: e.clientX, y: e.clientY }
    if (!hoverFrame) hoverFrame = requestAnimationFrame(showHover)
  }
  function showHover () {
    hoverFrame = 0
    var h = hover
    if (!h || !h.el._geo || !h.el.isConnected) return
    var el = h.el, spec = CHARTS[el.getAttribute('data-chart')], geo = el._geo
    if (!spec) return
    var box = el._box || (el._box = el.getBoundingClientRect()), mx = h.x - box.left, my = h.y - box.top
    var tip = el.querySelector('.mon-tip')
    var key, px, html
    if (spec.timeline) {
      var li = Math.floor((my - geo.top) / geo.laneH), lane = spec.lanes[li]
      var best = null
      if (lane) lane.runs.forEach(function (r, k) { var d = Math.abs(geo.x(r.t) - mx); if (d < 12 && (!best || d < best.d)) best = { d: d, r: r, k: k } })
      if (!best) { tip.hidden = true; el._tipKey = null; return }
      key = li + ':' + best.k
      px = geo.x(best.r.t)
      if (key !== el._tipKey) html = '<b>' + H.esc(lane.name + ', ' + fullTime(best.r.t)) + '</b>' + best.r.lines.map(function (l) { return '<div>' + H.esc(l) + '</div>' }).join('')
    } else {
      var t = spec.t, i = 0, bestD = Infinity
      for (var j = 0; j < t.length; j++) { var dd = Math.abs(geo.x(t[j]) - mx); if (dd < bestD) { bestD = dd; i = j } }
      key = i
      px = geo.x(t[i])
      if (key !== el._tipKey) {
        var guide = el.querySelector('.mon-guide')
        if (guide) { guide.setAttribute('x1', px); guide.setAttribute('x2', px); guide.style.display = '' }
        // Shared crosshair: mark the same moment on the other charts of this view.
        el.closest('.mon-view').querySelectorAll('.mon-chart').forEach(function (other) {
          var g = other !== el && other._geo && other.querySelector('.mon-guide'), ox = g ? other._geo.x(t[i]) : 0
          if (!g) return
          g.setAttribute('x1', ox); g.setAttribute('x2', ox)
          g.style.display = ox >= other._geo.padL && ox <= other._geo.W ? '' : 'none'
        })
        html = '<b>' + H.esc(fullTime(t[i])) + '</b>' + spec.series.map(function (s) {
          return '<div><i style="background:' + s.color + '"></i>' + H.esc(s.name) + '<span>' + H.esc(fmt(spec.unit, s.values[i])) + '</span></div>'
        }).join('')
      }
    }
    if (key !== el._tipKey) {
      tip.innerHTML = html
      tip.hidden = false
      el._tipKey = key
      el._tipW = tip.offsetWidth
    }
    var tw = el._tipW
    tip.style.transform = 'translateX(' + Math.max(0, Math.min(geo.W - tw, px + 12 + tw > geo.W ? px - tw - 12 : px + 12)) + 'px)'
  }
  function onLeave (e) {
    var el = e.target.closest && e.target.closest('.mon-chart')
    if (!el) return
    hover = null
    el._box = null; el._tipKey = null
    var tip = el.querySelector('.mon-tip')
    if (tip) tip.hidden = true
    el.closest('.mon-view').querySelectorAll('.mon-guide').forEach(function (g) { g.style.display = 'none' })
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

  // ---- Checks --------------------------------------------------------------------
  // Each returns { value (html), detail (html), tone? }; tone is only 'idle' for
  // "no data / not applicable". Problems come from the server's issues.
  var SUMMARY = {
    durability: function (st) {
      if (!st.multi_node) return { value: 'One node', detail: 'Only one storage node is enabled, so every payload has one copy', tone: 'idle' }
      var zero = st.zero_copy.file + st.zero_copy.note, one = st.single_copy.file + st.single_copy.note
      return {
        value: zero || one ? H.num(zero + one) + ' at risk' : 'All replicated',
        detail: plural(st.payloads.file, 'file') + ' and ' + plural(st.payloads.note, 'note') + ' on 2+ nodes' + (zero || one ? ', except ' + H.num(zero + one) : '')
      }
    },
    replication: function (st) {
      var backlog = st.backlog.file + st.backlog.note + st.backlog.thumbnail, rd = st.remote_deletes
      return {
        value: backlog ? H.num(backlog) + ' queued' : 'In sync',
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
      return { value: pct(synced - unv, synced) + ' verified', detail: unv ? unverifiedText(st) : 'Every copy matches its SHA-256' }
    },
    jobs: function (st, now, thresholds) {
      var j = st.jobs
      var late = ['scheduler', 'health_check', 'integrity_scrub'].filter(function (k) {
        return (k === 'scheduler' || j[k].interval > 0) && (!j[k].last || now - j[k].last > jobLimit(k, j[k], thresholds))
      })
      return {
        value: late.length ? plural(late.length, 'job') + ' late' : 'On schedule',
        detail: 'Heartbeat ' + ago(j.scheduler.last, now) + ', scrub ' + ago(j.integrity_scrub.last, now)
      }
    },
    backups: function (st, now) {
      var bk = st.backups
      if (!bk.db.last && !bk.full.last) return { value: 'No runs yet', detail: 'Runs appear after the next backup_prod.py run', tone: 'idle' }
      function part (k, label) { return bk[k].last_ok ? label + ' ' + ago(bk[k].last_ok.finished, now) : label + ' never' }
      var last = [bk.db.last, bk.full.last].filter(Boolean)
      var offsite = last.every(function (r) { return r.offsite_ok === true }) ? 'offsite copies verified'
        : last.some(function (r) { return r.offsite_ok === false }) ? 'offsite copy incomplete' : 'local only'
      var newest = Math.max(bk.db.last_ok ? bk.db.last_ok.finished : 0, bk.full.last_ok ? bk.full.last_ok.finished : 0)
      return { value: newest ? liveAgo(newest, now) : 'Never succeeded', detail: part('db', 'DB') + ', ' + part('full', 'full') + ', ' + offsite }
    },
    disk: function (st) {
      var d = st.disk
      if (!d || !d.total) return { value: 'Unknown', detail: 'Disk usage could not be read', tone: 'idle' }
      return { value: Math.round((d.total - d.free) / d.total * 100) + '% used', detail: H.fmtBytes(d.free) + ' free of ' + H.fmtBytes(d.total) }
    }
  }
  function unverifiedText (st) {
    var noHash = st.unverified_no_hash || 0, queued = st.unverified - noHash, parts = []
    if (queued) parts.push(H.num(queued) + ' awaiting scrub')
    if (noHash) parts.push(H.num(noHash) + ' size-only')
    return parts.join(', ') || 'All hash-verified'
  }

  function evaluate (st, now, thresholds) {
    var byCode = {}, mapped = {}
    st.issues.forEach(function (i) { (byCode[i.code] = byCode[i.code] || []).push(i) })
    var rows = CHECKS.map(function (c) {
      c[3].forEach(function (code) { mapped[code] = true })
      var x = SUMMARY[c[0]](st, now, thresholds)
      return { id: c[0], label: c[1], view: c[2], value: x.value, detail: x.detail, tone: x.tone,
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
  // Colour for a metric: the worst open issue among the given codes.
  function toneFor (st, codes) {
    var tone = 'neutral'
    st.issues.forEach(function (i) {
      if (codes.indexOf(i.code) < 0) return
      if (i.severity === 'critical') tone = 'bad'
      else if (i.severity === 'warning' && tone !== 'bad') tone = 'warn'
    })
    return tone
  }
  // History, live values and node series shared by the views.
  function derive (st, hist) {
    var primary = null
    st.nodes.forEach(function (n) { if (n.primary && n.enabled) primary = n })
    var nodeHist = hist.nodes.filter(function (n) { return st.nodes.some(function (x) { return x.id === n.id && x.enabled }) })
    return {
      hs: withLive(hist.system, st), primary: primary, nodeHist: nodeHist,
      primaryHist: primary ? nodeHist.filter(function (n) { return n.id === primary.id })[0] : null,
      remotes: nodeHist.filter(function (n) { return n.type !== 'local' && (!primary || n.id !== primary.id) })
    }
  }

  // ---- Overview ------------------------------------------------------------------
  function statusStrip (rows) {
    var crit = 0, warn = 0
    rows.forEach(function (r) { r.issues.forEach(function (i) { if (i.severity === 'critical') crit++; else if (i.severity === 'warning') warn++ }) })
    var tone = crit ? 'bad' : warn ? 'warn' : 'good'
    var headline = crit ? plural(crit, 'critical issue') + (warn ? ' and ' + plural(warn, 'warning') : '')
      : warn ? plural(warn, 'warning') : 'All systems healthy'
    var passing = rows.filter(function (r) { return r.tone === 'good' }).length
    var cells = rows.map(function (r) {
      return '<button type="button" class="mon-check is-' + r.tone + '" id="mon-check-' + r.id + '" data-mon-view="' + r.view + '" title="' + r.detail.replace(/<[^>]+>/g, '') + '">' +
        '<span class="mon-check-label"><span class="mon-dot" aria-hidden="true"></span>' + H.esc(r.label) + '</span>' +
        '<span class="mon-check-val">' + r.value + '</span></button>'
    }).join('')
    return '<section class="rd-panel mon-status is-' + tone + '" aria-label="System status">' +
      '<div class="mon-status-head"><span class="mon-status-mark" aria-hidden="true"></span><h2>' + H.esc(headline) + '</h2>' +
      '<span class="mon-p-meta">' + passing + ' of ' + rows.length + ' checks passing</span></div>' +
      '<div class="mon-checks">' + cells + '</div></section>'
  }

  // o: { t, values, start, end, tone, range, noDelta }; sub is html
  function stat (id, label, value, sub, o) {
    var delta = ''
    var v = (o.values || []).filter(function (x) { return x != null })
    var d = !o.noDelta && v.length > 1 ? v[v.length - 1] - v[0] : 0
    if (d) delta = '<span class="mon-stat-delta" title="Change over the last ' + o.range + '">' + (d > 0 ? '+' : '\u2212') + H.num(Math.abs(d)) + '</span>'
    return '<button type="button" class="mon-stat is-' + o.tone + '" id="mon-stat-' + id + '" data-mon-view="trends">' +
      '<span class="mon-stat-label">' + H.esc(label) + '</span>' +
      '<span class="mon-stat-top"><span class="mon-stat-val">' + H.esc(value) + '</span>' + delta + '</span><span class="mon-stat-sub">' + sub + '</span>' +
      spark(o.t, o.values || [], o.start, o.end, o.tone === 'bad' ? TONE.bad : o.tone === 'warn' ? TONE.warn : 'var(--accent)') + '</button>'
  }

  function statPanels (st, dv, span, rangeText, now) {
    var hs = dv.hs, rd = st.remote_deletes
    function o (values, codes, extra) {
      var x = { t: hs.t, values: values, start: span.start, end: span.end, range: rangeText, tone: toneFor(st, codes) }
      Object.keys(extra || {}).forEach(function (k) { x[k] = extra[k] })
      return x
    }
    var zero = st.zero_copy.file + st.zero_copy.note, one = st.single_copy.file + st.single_copy.note
    var tp = dv.remotes.map(throughput), axis = dv.remotes.length ? dv.remotes[0].t : []
    var tpSum = axis.map(function (_, i) { var any = false, total = 0; tp.forEach(function (x) { if (x[i] != null) { any = true; total += x[i] } }); return any ? total : null })
    var gained = sum(dv.remotes.map(function (n) { return Math.max(0, n.bytes[n.bytes.length - 1] - n.bytes[0]) }))
    var lastRate = null
    tpSum.forEach(function (x) { if (x != null) lastRate = x })
    return '<div class="mon-stats">' +
      stat('queue', 'Replication queue', H.num(st.backlog.file + st.backlog.note + st.backlog.thumbnail),
        H.num(st.backlog.file) + ' files, ' + H.num(st.backlog.note) + ' notes, ' + H.num(st.backlog.thumbnail) + ' thumbnails',
        o(addArrays(hs.backlog_file, hs.backlog_note, hs.backlog_thumbnail), [])) +
      stat('throughput', 'Throughput', dv.remotes.length ? rate(lastRate) : 'n/a',
        dv.remotes.length ? '+' + H.fmtBytes(gained) + ' in ' + rangeText : 'No remote node',
        o(tpSum, [], { t: axis, noDelta: true })) +
      stat('risk', 'Payloads at risk', H.num(zero + one), H.num(zero) + ' with no copy, ' + H.num(one) + ' with one',
        o(addArrays(hs.single_copy_file, hs.single_copy_note, hs.zero_copy_file, hs.zero_copy_note), ['zero_copy', 'aged_single_copy'])) +
      stat('errors', 'Replica errors', H.num(st.errors), H.num(st.parked) + ' parked (no more retries)',
        o(addArrays(hs.errors_file, hs.errors_note, hs.errors_thumbnail), ['parked_replicas'])) +
      stat('unverified', 'Unverified copies', H.num(st.unverified), unverifiedText(st), o(hs.unverified, ['scrub_behind'])) +
      stat('deletes', 'Remote deletes', H.num(rd.queued),
        (rd.oldest ? 'Oldest ' + ago(rd.oldest, now).replace(' ago', '') : 'Queue empty') + (rd.stalled ? ', ' + H.num(rd.stalled) + ' stalled' : ''),
        o(hs.remote_deletes, ['remote_delete_stalled'])) +
      '</div>'
  }

  function issueLog (rows, hist, now, rangeText) {
    var order = { critical: 0, warning: 1, info: 2 }, area = {}, open = []
    rows.forEach(function (r) { r.issues.forEach(function (i) { area[i.code] = r; open.push(i) }) })
    CHECKS.forEach(function (c) { c[3].forEach(function (code) { area[code] = area[code] || { label: c[1], view: c[2] } }) })
    open.sort(function (x, y) { return order[x.severity] - order[y.severity] })
    function chip (code) {
      var r = area[code]
      return r ? '<button type="button" class="mon-chip" data-mon-view="' + r.view + '">' + H.esc(r.label) + '</button>' : '<span></span>'
    }
    var items = open.map(function (i) {
      var tone = i.severity === 'critical' ? 'bad' : i.severity === 'warning' ? 'warn' : 'info'
      return '<li class="is-' + tone + '"><span class="mon-dot" aria-hidden="true"></span><span class="mon-log-text">' + H.esc(i.summary) + '</span>' + chip(i.code) +
        '<span class="mon-log-age">' + (tone === 'info' ? 'Note' : i.since ? 'Opened ' + liveAgo(i.since, now) : 'New') + '</span></li>'
    })
    var resolved = hist.events || []
    resolved.forEach(function (e) {
      items.push('<li class="is-done"><span class="mon-dot" aria-hidden="true"></span><span class="mon-log-text">' + H.esc(e.summary || e.code) + '</span>' + chip(e.code) +
        '<span class="mon-log-age">Resolved ' + liveAgo(e.resolved, now) + ', lasted ' + dur(e.resolved - e.opened) + '</span></li>')
    })
    var active = open.filter(function (i) { return i.severity !== 'info' }).length
    return panel('Issues', '<ul class="mon-log">' + (items.join('') || '<li class="is-none">No open issues, and none resolved in the last ' + rangeText + '.</li>') + '</ul>',
      { flush: true, cls: 'mon-log-panel', meta: active + ' open, ' + resolved.length + ' resolved in ' + rangeText,
        tip: 'Open issues first, then the ones resolved in the selected range. Opened and resolved times come from the 5-minute snapshots.' })
  }

  // State timeline: one strip per enabled node from the 5-minute snapshots.
  function availability (st, dv, span, rangeText) {
    var width = Math.max(1, span.end - span.start)
    var maxGap = Math.max(900, width / 240 * 2.5) // longer than this without a snapshot = no data
    var rows = dv.nodeHist.map(function (n) {
      var segs = [], up = 0, total = 0
      n.t.forEach(function (t, i) {
        var from = Math.max(t, span.start), to = Math.min(i < n.t.length - 1 ? n.t[i + 1] : span.end, t + maxGap, span.end)
        if (to <= from) return
        var last = segs[segs.length - 1]
        if (last && last.up === n.up[i] && from - last.to < 2) last.to = to
        else segs.push({ from: from, to: to, up: n.up[i] })
        total += to - from
        if (n.up[i]) up += to - from
      })
      var cur = st.nodes.filter(function (x) { return x.id === n.id })[0]
      var label = total ? pct(up, total) + ' up' : 'No data'
      return '<div class="mon-av"><div class="mon-row"><span>' + H.esc(n.name) + '</span>' +
        '<b class="' + (cur && !cur.up ? 'is-bad' : '') + '">' + (cur && !cur.up ? 'Down now, ' : '') + label + '</b></div>' +
        '<div class="mon-strip" role="img" aria-label="' + H.esc(n.name + ': ' + label + ' over the last ' + rangeText) + '">' + segs.map(function (x) {
          return '<i class="' + (x.up ? 'is-up' : 'is-down') + '" style="left:' + ((x.from - span.start) / width * 100).toFixed(2) + '%;width:' + ((x.to - x.from) / width * 100).toFixed(2) +
            '%" title="' + H.esc((x.up ? 'Online' : 'Down') + ', ' + fullTime(x.from) + ' to ' + fullTime(x.to)) + '"></i>'
        }).join('') + '</div></div>'
    }).join('')
    var axis = '<div class="mon-strip-axis">' + [0, 0.5, 1].map(function (f) { return '<span>' + H.esc(clockLabel(span.start + width * f, width)) + '</span>' }).join('') + '</div>'
    var legend = '<div class="mon-legend"><span class="mon-legend-item"><i style="background:var(--good)"></i>Online</span>' +
      '<span class="mon-legend-item"><i style="background:var(--bad)"></i>Down</span><span class="mon-legend-item"><i class="is-gap"></i>No data</span></div>'
    return panel('Node availability', rows ? rows + axis + legend : '<p class="mon-sub">Collecting data. The timeline fills in as 5-minute snapshots arrive.</p>',
      { meta: 'Last ' + rangeText, tip: 'Health-probe result at each 5-minute snapshot. Gaps mean no snapshot was taken, for example while the app was restarting.' })
  }

  // ---- Storage -------------------------------------------------------------------
  function nodesTable (st, now) {
    var en = enabledNodes(st), disabled = st.nodes.length - en.length
    var noHash = 0
    var rows = en.map(function (n) {
      var unv = sum(Object.values(n.unverified)), nh = sum(Object.values(n.no_hash || {}))
      noHash += nh
      var check = n.checksum === true ? 'SHA-256' : n.checksum === false ? 'size only' : 'unprobed'
      function cnt (v, tone, label) { return '<td class="is-num' + (v ? ' is-' + tone : ' is-zero') + '" data-label="' + label + '">' + H.num(v) + '</td>' }
      return '<tr>' +
        '<td data-label="Node"><span class="mon-node"><b>' + H.esc(n.name) + '</b><span>' + H.esc(n.type === 's3' ? 'S3' : n.type === 'ssh' ? 'SSH' : 'Local') +
          (n.primary ? ', primary' : '') + ', ' + check + '</span></span></td>' +
        '<td data-label="Status">' + H.pill(n.up ? 'Online' : n.status.charAt(0).toUpperCase() + n.status.slice(1), n.up ? 'good' : 'bad', true) + '</td>' +
        '<td class="is-num" data-label="Stored">' + H.fmtBytes(n.synced_bytes) + '</td>' +
        '<td class="is-num" data-label="Copies">' + H.num(n.synced) + '</td>' +
        cnt(n.pending, 'warn', 'Queued') + cnt(n.errors, 'bad', 'Errors') + cnt(n.missing, 'bad', 'Missing') +
        '<td data-label="Hash-verified"><span class="mon-pct"><b>' + pct(n.synced - unv, n.synced) + '</b>' + meter(n.synced ? (n.synced - unv) / n.synced : 1) + '</span></td>' +
        '<td class="is-num" data-label="Last probe">' + liveAgo(n.last_seen, now) + (n.failures ? '<span class="mon-sub is-bad">' + plural(n.failures, 'failed probe') + '</span>' : '') + '</td>' +
        '</tr>'
    }).join('')
    var note = noHash ? '<p class="mon-sub mon-foot">' + H.esc(plural(noHash, 'copy', 'copies') + ' never got a hash from their node (for example S3 objects stored without a SHA-256). ' +
      'The scrub checks their size; only a deep verify can confirm their contents.') + '</p>' : ''
    var body = rows
      ? '<div class="rd-table-wrap"><table class="rd-table is-stack mon-table"><thead><tr><th>Node</th><th>Status</th><th class="is-num">Stored</th><th class="is-num">Copies</th>' +
        '<th class="is-num">Queued</th><th class="is-num">Errors</th><th class="is-num">Missing</th><th>Hash-verified</th><th class="is-num">Last probe</th></tr></thead><tbody>' + rows + '</tbody></table></div>' + note
      : '<p class="mon-sub mon-foot">No enabled storage nodes.</p>'
    return panel('Storage nodes', body, { flush: true, meta: en.length + ' enabled' + (disabled ? ', ' + disabled + ' disabled' : ''),
      tip: 'Live replica state per enabled node. Hash-verified = synced copies whose SHA-256 was confirmed on the node.' })
  }

  function durabilityCard (st) {
    function row (label, total, single, zero) {
      var multi = Math.max(0, total - single - zero)
      return '<div class="mon-block"><div class="mon-row"><span>' + H.esc(label) + '</span><b>' + H.num(total) + '</b></div>' +
        stackBar([{ label: '2+ copies', value: multi, color: TONE.good }, { label: '1 copy', value: single, color: TONE.warn }, { label: 'No copy', value: zero, color: TONE.bad }], total) + '</div>'
    }
    var body = st.multi_node
      ? row('Files', st.payloads.file, st.single_copy.file, st.zero_copy.file) + row('Notes', st.payloads.note, st.single_copy.note, st.zero_copy.note) +
        '<p class="mon-sub">' + (st.single_copy.thumbnail ? plural(st.single_copy.thumbnail, 'thumbnail') + ' also have a single copy.' : 'Every thumbnail has 2+ copies.') +
        ' Backups do not include payloads.</p>'
      : '<p class="mon-sub">Only one storage node is enabled, so every payload has exactly one copy.</p>'
    return panel('Durability', body, { tip: 'Synced copies per payload across enabled nodes. Replicas are the only copies of payloads.' })
  }

  function verifyAgeCard (st, now) {
    var body = enabledNodes(st).map(function (n) {
      var va = n.verify_age || {}
      return '<div class="mon-block"><div class="mon-row"><span>' + H.esc(n.name) + '</span><b class="mon-quiet">' +
        (n.oldest_verified ? 'oldest ' + liveAgo(n.oldest_verified, now) : 'never checked') + '</b></div>' +
        stackBar([
          { label: 'Under 1 d', value: va.d1 || 0, color: TONE.good },
          { label: '1 to 7 d', value: va.d7 || 0, color: 'color-mix(in srgb,var(--good) 50%,var(--press))' },
          { label: '7 to 30 d', value: va.d30 || 0, color: TONE.warn },
          { label: 'Over 30 d', value: va.older || 0, color: TONE.bad },
          { label: 'Never', value: va.never || 0, color: TONE.muted }
        ], 0, true) + '</div>'
    }).join('')
    return panel('Last integrity check', body || '<p class="mon-sub">No enabled storage nodes.</p>',
      { tip: 'How long ago the scrub last checked each synced copy. The scrub re-checks every copy inside its re-verify window.' })
  }

  function jobsCard (st, now, thresholds) {
    var j = st.jobs
    function job (key, label, what) {
      var x = j[key], limit = jobLimit(key, x, thresholds), age = x.last ? now - x.last : null
      var tone = age == null || age > limit ? (key === 'scheduler' ? 'bad' : 'warn') : 'good'
      return '<div class="mon-block" title="' + H.esc(what + ' Counts as late after ' + dur(limit) + '.') + '"><div class="mon-row"><span>' + H.esc(label) +
        ' <small>every ' + dur(x.interval) + '</small></span><b class="is-' + tone + '">' + liveAgo(x.last, now) + '</b></div>' + meter(age == null ? 1 : age / limit, tone) + '</div>'
    }
    var disk = st.disk, diskRow = ''
    if (disk && disk.total) {
      var used = (disk.total - disk.free) / disk.total
      var tone = used * 100 >= thresholds.disk ? 'warn' : 'good'
      diskRow = '<div class="mon-block" title="Warns at ' + thresholds.disk + '% used."><div class="mon-row"><span>Local disk <small>' + H.fmtBytes(disk.free) + ' free of ' + H.fmtBytes(disk.total) +
        '</small></span><b class="is-' + tone + '">' + Math.round(used * 100) + '% used</b></div>' + meter(used, tone) + '</div>'
    }
    return panel('Jobs and disk',
      job('scheduler', 'Scheduler heartbeat', 'Drives replication, scrub and deletes.') +
      job('health_check', 'Health check', 'Probes each storage node.') +
      job('integrity_scrub', 'Integrity scrub', 'Re-checks stored copies.') + diskRow,
      { tip: 'Time since each job last ran. A bar fills toward the point where the job counts as late.' })
  }

  // ---- Trends --------------------------------------------------------------------
  function trends (dv, span) {
    var hs = dv.hs, remotes = dv.remotes
    var axis = remotes.length ? remotes[0].t : []
    return '<div class="mon-charts">' +
      chart('tp', { t: axis, start: span.start, end: span.end, unit: 'Bps', area: true, series: remotes.map(function (n, i) {
        return { name: n.name, color: PALETTE[i % PALETTE.length], values: onAxis(axis, n, throughput(n)) }
      }) }, 'Replication throughput', 'Net bytes per second landing on remote nodes') +
      (dv.primaryHist ? chart('lag', { t: axis, start: span.start, end: span.end, unit: 'bytes', area: true, series: remotes.map(function (n, i) {
        return { name: n.name, color: PALETTE[i % PALETTE.length], values: onAxis(axis, n, lagSeries(n, dv.primaryHist)) }
      }) }, 'Behind the primary', 'Bytes on ' + dv.primary.name + ' not yet on remote nodes') : '') +
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
        { name: 'Unverified', color: PALETTE[0], values: hs.unverified }
      ] }, 'Unverified copies', 'Synced copies whose SHA-256 has not been confirmed on the node') +
      '</div><p class="mon-sub">One point per 5-minute snapshot, the last one live. In the 7 d and 30 d views each point is the peak of its time slot. Hover a chart to mark the same moment on all of them.</p>'
  }

  // ---- Backups -------------------------------------------------------------------
  function backupsView (st, hb, thresholds, now) {
    function summary (kind, label, limit, schedule) {
      var bk = st.backups[kind], ok = bk.last_ok, last = bk.last
      if (!last) {
        return panel(label, '<p class="mon-sub">No runs recorded yet. They appear after the next backup_prod.py run.</p>', { note: schedule, meta: H.pill('No runs yet', '') })
      }
      var age = ok ? now - ok.finished : null
      var tone = age == null || age > limit ? 'bad' : 'good'
      var lastTone = last.status !== 'ok' ? 'bad' : last.offsite_ok === false ? 'warn' : 'good'
      var lastLabel = last.status !== 'ok' ? 'Last run failed' : last.offsite_ok === false ? 'Offsite incomplete' : last.offsite_ok ? 'Verified offsite' : 'Local only'
      return panel(label,
        '<div class="mon-bk-age is-' + tone + '">' + (ok ? liveAgo(ok.finished, now) : 'Never succeeded') + '</div>' + meter(age == null ? 1 : age / limit, tone) +
        '<dl class="mon-facts"><div><dt>Archive</dt><dd>' + (ok ? H.fmtBytes(ok.bytes) : 'n/a') + '</dd></div><div><dt>Duration</dt><dd>' + dur(last.duration) + '</dd></div>' +
        '<div><dt>Last run</dt><dd>' + H.esc(fullTime(last.started)) + '</dd></div></dl>' +
        (last.status !== 'ok' && last.error ? '<p class="mon-err">' + H.esc(last.error) + '</p>' : ''),
        { note: schedule, meta: H.pill(lastLabel, lastTone, true), tip: 'Time since the last successful run. The bar fills toward the alert limit of ' + dur(limit) + '.' })
    }
    var runs = hb.runs
    function runTone (r) { return r.status !== 'ok' ? 'bad' : r.offsite_ok === false ? 'warn' : 'good' }
    function runLines (r) {
      return [r.status === 'ok' ? 'Succeeded in ' + dur(r.duration) : 'Failed: ' + (r.error || 'unknown error'),
        r.status === 'ok' ? 'Archive ' + H.fmtBytes(r.bytes) : '',
        r.offsite_ok === true ? 'Offsite copy verified' : r.offsite_ok === false ? 'Offsite copy incomplete' : 'No offsite push'].filter(Boolean)
    }
    var out = '<div class="mon-cols is-2">' + summary('db', 'Database backup', thresholds.db_backup, 'every 6 h') + summary('full', 'Full backup', thresholds.full_backup, 'daily at 03:30 UTC') + '</div>'
    if (runs.length) {
      var failed = runs.filter(function (r) { return r.status !== 'ok' }).length
      CHARTS.bkRuns = { timeline: true, start: hb.start, end: now, t: [hb.start, now], lanes: [['db', 'DB'], ['full', 'Full']].map(function (k) {
        return { name: k[1], runs: runs.filter(function (r) { return r.kind === k[0] }).map(function (r) { return { t: r.started, tone: runTone(r), lines: runLines(r) } }) }
      }) }
      out += panel('Runs', '<div class="mon-chart" data-chart="bkRuns" style="height:72px" role="img" aria-label="Backup runs over the last 30 days"></div>' +
        '<div class="mon-legend"><span class="mon-legend-item"><i style="background:var(--good)"></i>Succeeded</span><span class="mon-legend-item"><i style="background:var(--warn)"></i>Offsite incomplete</span>' +
        '<span class="mon-legend-item"><i style="background:var(--bad)"></i>Failed</span></div>',
      { meta: plural(runs.length, 'run') + ' in 30 d, ' + failed + ' failed', tip: 'Every backup_prod.py run in the last 30 days. Hover a dot for details.' })
    }
    var ok = runs.filter(function (r) { return r.status === 'ok' })
    if (ok.length > 1) {
      out += '<div class="mon-cols is-2">' +
        chart('bkSize', { t: ok.map(function (r) { return r.started }), start: hb.start, end: now, unit: 'bytes', connect: true, series: [['DB', 'db'], ['Full', 'full']].map(function (x, i) {
          return { name: x[0], color: PALETTE[i], values: ok.map(function (r) { return r.kind === x[1] ? r.bytes : null }) }
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
  // Only the open view is built; the others are built from ctx when first shown.
  var PANES = {
    overview: function (c) {
      return statusStrip(c.rows) + statPanels(c.st, c.dv, c.span, c.rangeText, c.now) +
        '<div class="mon-cols is-split">' + issueLog(c.rows, c.hist, c.now, c.rangeText) + availability(c.st, c.dv, c.span, c.rangeText) + '</div>'
    },
    storage: function (c) { return nodesTable(c.st, c.now) + '<div class="mon-cols is-3">' + durabilityCard(c.st) + verifyAgeCard(c.st, c.now) + jobsCard(c.st, c.now, c.th) + '</div>' },
    trends: function (c) { return trends(c.dv, c.span) },
    backups: function (c) { return backupsView(c.st, c.hist.backups, c.th, c.now) }
  }
  var ctx = null

  function render (d, range, helpers) {
    H = helpers
    CHARTS = {}
    skew = d.now - Date.now() / 1000
    if (root) {
      var act = document.activeElement, log = root.querySelector('.mon-log')
      keep = { focus: act && act.id && root.contains(act) ? act.id : '', scroll: log ? log.scrollTop : 0 }
    }
    var st = d.state, hist = d.history, now = d.now, th = d.thresholds
    var width = hist.end - hist.start
    var span = { end: Math.max(hist.end, st.at) }
    span.start = span.end - width
    var rangeText = (RANGES.filter(function (r) { return r[0] === range })[0] || RANGES[0])[1]
    var rows = evaluate(st, now, th), dv = derive(st, hist)
    var rank = { bad: 3, warn: 2, idle: 1, good: 0 }, worst = {}
    rows.forEach(function (r) { if (!worst[r.view] || rank[r.tone] > rank[worst[r.view]]) worst[r.view] = r.tone })
    if (!VIEWS.some(function (v) { return v[0] === view })) view = 'overview'

    var tabs = '<div class="rd-tabs mon-tabs" role="tablist" aria-label="Monitoring views">' + VIEWS.map(function (v) {
      var on = v[0] === view, tone = v[0] === 'overview' ? '' : worst[v[0]]
      return '<button type="button" class="rd-tab' + (on ? ' is-active' : '') + '" role="tab" id="mon-tab-' + v[0] + '" aria-controls="mon-view-' + v[0] + '" aria-selected="' + on + '" data-mon-view="' + v[0] + '">' +
        H.esc(v[1]) + (tone === 'bad' || tone === 'warn' ? '<span class="mon-tab-dot is-' + tone + '" aria-label="needs attention"></span>' : '') + '</button>'
    }).join('') + '</div>'
    var live = '<span class="mon-live" data-mon-live role="status"><i aria-hidden="true"></i><span class="mon-live-text">Live, updated ' + liveAgo(st.at, now) + '</span></span>'
    var ranges = '<div class="rd-tabs mon-range" role="group" aria-label="Time range">' + RANGES.map(function (r) {
      return '<button type="button" class="rd-tab' + (r[0] === range ? ' is-active' : '') + '" id="mon-range-' + r[0] + '" data-mon-range="' + r[0] + '" aria-pressed="' + (r[0] === range) + '">' + r[1] + '</button>'
    }).join('') + '</div>'
    ctx = { st: st, hist: hist, now: now, th: th, span: span, rangeText: rangeText, rows: rows, dv: dv }
    function pane (id) {
      var on = id === view
      return '<div class="mon-view" role="tabpanel" id="mon-view-' + id + '" aria-labelledby="mon-tab-' + id + '"' + (on ? '' : ' hidden') + '>' + (on ? PANES[id](ctx) : '') + '</div>'
    }
    return '<div class="mon">' +
      '<header class="mon-bar"><h1 class="rd-page-title">Monitoring</h1>' + tabs + '<span class="mon-bar-end">' + live + ranges + '</span></header>' +
      VIEWS.map(function (v) { return pane(v[0]) }).join('') +
      '</div>'
  }

  function setView (panel, v) {
    view = v
    try { sessionStorage.setItem('adm-mon-view', v) } catch (e) {}
    panel.querySelectorAll('.mon-tabs [data-mon-view]').forEach(function (b) {
      var on = b.getAttribute('data-mon-view') === v
      b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on))
    })
    panel.querySelectorAll('.mon-view').forEach(function (x) {
      var on = x.id === 'mon-view-' + v
      if (on && !x.firstChild && ctx) { x.innerHTML = PANES[v](ctx); tick(x) }
      x.hidden = !on
    })
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
    root = panel
    drawAll(panel)
    var log = panel.querySelector('.mon-log'), focus = keep.focus && document.getElementById(keep.focus)
    if (log) log.scrollTop = keep.scroll
    if (focus && panel.contains(focus)) focus.focus({ preventScroll: true })
    keep = { focus: '', scroll: 0 }
    if (!panel._monWired) {
      panel._monWired = true
      panel.addEventListener('mousemove', onHover)
      panel.addEventListener('mouseout', function (e) { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.mon-chart')) onLeave(e) })
      panel.addEventListener('click', onClick)
      window.addEventListener('scroll', function () { if (hover) hover.el._box = null }, { capture: true, passive: true })
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
    root = null
    ctx = null
    hover = null
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
