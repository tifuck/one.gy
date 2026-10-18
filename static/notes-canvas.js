/* Frost canvas editor. Persists the established ONE.GY canvas schema. */
(function () {
  'use strict'

  var TOOLS = [
    ['select', 'SELECT / MOVE (V)', '<path d="M4 3l7 17 2.5-6.5L20 11z"/>'],
    ['text', 'TEXT (T)', '<path d="M4 6V4h16v2M12 4v16M8 20h8"/>'],
    ['image', 'IMAGE (I)', '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'],
    ['todo', 'TO-DO (O)', '<rect x="4" y="4" width="6" height="6"/><path d="M14 7h6M4 17l2 2 4-5M14 17h6"/>'],
    ['table', 'TABLE (B)', '<rect x="3" y="3" width="18" height="18"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>'],
    ['code', 'CODE (C)', '<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/>'],
    ['pen', 'DRAW (P)', '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'],
    ['line', 'LINE / ARROW (L)', '<path d="M5 19L19 5M19 5h-6M19 5v6"/>']
  ]
  var COLORS = ['#0f1720', '#0e8fd6', '#1f9d57', '#e5940a', '#d8231b', '#8a63d2', '#ffffff']
  var CANVAS_MAX_Y = 100000
  var PAGE_WIDTH = 960
  /* Each preset must read clearly different at a glance:
     default = full grid | slim = horizontal rules only | rounded = card with shaded header
     striped = zebra rows | accent = solid accent header | none = invisible (layout) */
  var TABLE_STYLES = {
    default: { borderMode: 'all', borderStyle: 'solid', borderColor: '#64717d', borderWidth: '1', borderRadius: '0', headerBg: '', headerFg: '', headerBold: false, stripedBg: '' },
    slim: { borderMode: 'rows', borderStyle: 'solid', borderColor: 'rgba(100,113,125,.6)', borderWidth: '1', borderRadius: '0', headerBg: '', headerFg: '', headerBold: false, stripedBg: '' },
    rounded: { borderMode: 'all', borderStyle: 'solid', borderColor: '#64717d', borderWidth: '1', borderRadius: '12', headerBg: 'rgba(100,113,125,.18)', headerFg: '', headerBold: true, stripedBg: '' },
    striped: { borderMode: 'rows', borderStyle: 'solid', borderColor: 'rgba(100,113,125,.35)', borderWidth: '1', borderRadius: '0', headerBg: '', headerFg: '', headerBold: true, stripedBg: 'rgba(100,113,125,.14)' },
    accent: { borderMode: 'all', borderStyle: 'solid', borderColor: '#0e8fd6', borderWidth: '1', borderRadius: '0', headerBg: '#0e8fd6', headerFg: '#ffffff', headerBold: true, stripedBg: 'rgba(14,143,214,.08)' },
    none: { borderMode: 'none', borderStyle: 'none', borderColor: 'transparent', borderWidth: '0', borderRadius: '0', headerBg: '', headerFg: '', headerBold: false, stripedBg: '' }
  }
  var NOTE_TAGS = { a: 1, abbr: 1, b: 1, blockquote: 1, br: 1, caption: 1, code: 1, col: 1, colgroup: 1, dd: 1, del: 1, div: 1, dl: 1, dt: 1, em: 1, figcaption: 1, figure: 1, font: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, hr: 1, i: 1, img: 1, ins: 1, kbd: 1, li: 1, mark: 1, ol: 1, p: 1, pre: 1, q: 1, s: 1, samp: 1, small: 1, span: 1, strike: 1, strong: 1, sub: 1, sup: 1, table: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, tr: 1, u: 1, ul: 1, var: 1, wbr: 1 }
  var DANGEROUS_TAGS = { script: 1, style: 1, iframe: 1, object: 1, embed: 1, applet: 1, form: 1, link: 1, meta: 1, base: 1, frame: 1, frameset: 1, noscript: 1, template: 1, svg: 1, math: 1, title: 1, button: 1, input: 1, textarea: 1, select: 1, option: 1 }
  var GLOBAL_ATTRS = { style: 1, align: 1, title: 1, dir: 1, lang: 1 }
  var TAG_ATTRS = { a: { href: 1, target: 1, rel: 1 }, img: { src: 1, alt: 1, width: 1, height: 1 }, td: { colspan: 1, rowspan: 1, headers: 1, scope: 1 }, th: { colspan: 1, rowspan: 1, headers: 1, scope: 1 }, col: { span: 1, width: 1 }, colgroup: { span: 1, width: 1 }, font: { color: 1, face: 1, size: 1 }, ol: { start: 1, type: 1 }, ul: { type: 1 } }
  var SHARED_BLOCK_CLIPBOARD = null

  function el (tag, cls, html) { var node = document.createElement(tag); if (cls) node.className = cls; if (html != null) node.innerHTML = html; return node }
  function clone (value) { return JSON.parse(JSON.stringify(value)) }
  function id () { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }
  function esc (value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function formatBytes (value) { var size = +value || 0; if (!size) return '0 B'; var units = ['B', 'KB', 'MB', 'GB'], index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024))); return (size / Math.pow(1024, index)).toFixed(index ? 1 : 0) + ' ' + units[index] }
  function safeUrl (raw, image) { if (typeof raw !== 'string') return ''; var value = raw.trim().replace(/[\u0000-\u001f\u007f]+/g, ''); if (!value) return ''; if (image && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(value)) return value; try { var parsed = new URL(value, window.location.origin), protocol = parsed.protocol.toLowerCase(); if (image && parsed.origin === window.location.origin && (protocol === 'http:' || protocol === 'https:')) return parsed.href; if (!image && (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:')) return parsed.href } catch (e) {}; return '' }
  function safeColor (value, fallback) { value = typeof value === 'string' ? value.trim() : ''; if (!value || /url\s*\(|expression\s*\(|javascript\s*:/i.test(value) || !window.CSS || !CSS.supports('color', value)) return fallback || ''; return value }
  // Text on a solid fill (swatch or highlight) must stay readable in either theme: palette ink on light fills, white on dark ones.
  function inkOn (fill) {
    var value = String(fill || '').trim(), hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value), rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(value)
    if (hex) rgb = (hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1]).match(/../g).map(function (part) { return parseInt(part, 16) })
    else if (rgb && !(rgb[4] != null && +rgb[4] === 0)) rgb = rgb.slice(1, 4).map(Number)
    else return ''
    var lum = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
    return 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2] > 0.179 ? COLORS[0] : COLORS[COLORS.length - 1]
  }
  // Highlights carry their own ink (a yellow highlight under the dark theme's light text was unreadable). Only text still
  // showing its container's colour is inked, so a text colour the user picked wins; innermost first for nested highlights.
  function inkHighlights (root) {
    var base = getComputedStyle(root).color
    Array.prototype.slice.call(root.querySelectorAll('[style*="background"]')).reverse().forEach(function (node) { var ink = getComputedStyle(node).color === base && inkOn(getComputedStyle(node).backgroundColor); if (ink) node.style.color = ink })
  }
  function sanitizeCanvasTree (root) {
    function clean (node) {
      if (node.nodeType === Node.COMMENT_NODE) { node.remove(); return }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      var tag = node.tagName.toLowerCase()
      if (DANGEROUS_TAGS[tag]) { node.remove(); return }
      Array.prototype.slice.call(node.childNodes).forEach(clean)
      if (!NOTE_TAGS[tag]) { var parent = node.parentNode; if (parent) { while (node.firstChild) parent.insertBefore(node.firstChild, node); node.remove() }; return }
      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase(), value = attr.value.trim()
        if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'id' || name === 'name' || name === 'contenteditable') node.removeAttribute(attr.name)
        else if (name === 'href') { var href = safeUrl(value, false); if (!href) node.removeAttribute(attr.name); else { node.setAttribute('href', href); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer') } }
        else if (name === 'src') { var src = tag === 'img' && safeUrl(value, true); if (src) node.setAttribute('src', src); else node.removeAttribute(attr.name) }
        else if (name === 'style') {
          var safe = value.split(';').map(function (part) {
            var pair = part.split(':'); if (pair.length < 2) return ''
            var prop = pair.shift().trim().toLowerCase(), val = pair.join(':').trim()
            if (!/^(color|background-color|font-weight|font-style|text-align)$/.test(prop)) return ''
            if (/url\s*\(|expression\s*\(|javascript\s*:/i.test(val)) return ''
            return prop + ':' + val
          }).filter(Boolean).join(';')
          if (safe) node.setAttribute('style', safe); else node.removeAttribute('style')
        } else if (!GLOBAL_ATTRS[name] && !(TAG_ATTRS[tag] && TAG_ATTRS[tag][name])) node.removeAttribute(attr.name)
      })
    }
    Array.prototype.slice.call(root.childNodes).forEach(clean)
  }
  function sanitizeToFragment (html) {
    var template = document.createElement('template'); template.innerHTML = String(html || '')
    sanitizeCanvasTree(template.content)
    return template.content
  }
  function safeHtml (html) {
    var wrap = document.createElement('div')
    wrap.appendChild(sanitizeToFragment(html))
    return wrap.innerHTML
  }

  function mount (container, opts) {
    opts = opts || {}
    var source = opts.data && typeof opts.data === 'object' ? clone(opts.data) : { blocks: [] }
    var readonly = !!opts.readonly
    var onChange = opts.onChange || function () {}
    var onDirty = opts.onDirty || function () {}
    var blocks = Array.isArray(source.blocks) ? source.blocks.map(normalize) : []
    var maxZ = Math.max(+source.maxZ || 0, blocks.reduce(function (m, b) { return Math.max(m, +b.zIndex || 0) }, 0))
    var nextId = source.nextId || 1
    var zoom = +source.zoom || 1
    var tool = 'select', color = '#0e8fd6', stroke = 3
    var selected = null, selectedIds = [], gesture = null, draw = null, spaceHeld = false
    var pointers = {}, pinch = null, undo = [], redo = [], changeTimer = null, editSnapshotTimer = null, destroyed = false
    var popover = null, savedRange = null, imageInsertPoint = null, longPress = null
    var provisionalText = {}, blockClipboard = SHARED_BLOCK_CLIPBOARD, imageReplaceId = null, dirtyPending = false
    var ac = new AbortController(), signal = ac.signal

    function normalize (block) {
      var b = block && typeof block === 'object' ? clone(block) : {}
      b.id = String(b.id == null ? id() : b.id)
      b.type = b.type || 'text'
      b.x = isFinite(+b.x) ? Math.max(0, +b.x) : 0
      b.w = isFinite(+b.w) && +b.w > 0 ? +b.w : 180; b.h = isFinite(+b.h) && +b.h > 0 ? +b.h : 60
      b.y = isFinite(+b.y) ? Math.max(0, Math.min(Math.max(0, CANVAS_MAX_Y - b.h), +b.y)) : 0
      b.rotation = isFinite(+b.rotation) ? +b.rotation : 0; b.zIndex = isFinite(+b.zIndex) ? +b.zIndex : 0
      if (typeof b.content === 'string') b.content = safeHtml(b.content)
      if (Array.isArray(b.cells)) b.cells = b.cells.map(function (row) { return Array.isArray(row) ? row.map(function (cell) { return typeof cell === 'string' ? safeHtml(cell) : '' }) : [] })
      if (b.type === 'image' && typeof b.src === 'string') b.src = safeUrl(b.src, true)
      if (b.style && typeof b.style === 'object') b.style.bgColor = safeColor(b.style.bgColor, 'transparent')
      ;['borderColor', 'headerBg', 'headerFg', 'stripedBg'].forEach(function (key) { if (b[key] != null) b[key] = safeColor(b[key], '') })
      if (Array.isArray(b.items)) b.items.forEach(function (item) { if (item && item.checked == null && item.done != null) item.checked = !!item.done })
      if ((b.type === 'draw' || b.type === 'line') && b.strokeColor == null && b.color) b.strokeColor = b.color
      if ((b.type === 'draw' || b.type === 'line') && b.strokeWidth == null && b.stroke != null) b.strokeWidth = +b.stroke
      if (b.type === 'line' && !b.arrowMode && b.arrow) b.arrowMode = 'end'
      if (b.type === 'line' && Array.isArray(b.points) && b.points.length > 1 && Array.isArray(b.points[0])) { b.lx1 = b.points[0][0] - b.x; b.ly1 = b.points[0][1] - b.y; b.lx2 = b.points[1][0] - b.x; b.ly2 = b.points[1][1] - b.y; delete b.points }
      if (b.type === 'draw' && !b.pathData && Array.isArray(b.points) && b.points.length && Array.isArray(b.points[0])) { b.pathData = b.points.map(function (point, index) { return (index ? 'L' : 'M') + (point[0] - b.x) + ',' + (point[1] - b.y) }).join(' '); delete b.points }
      return b
    }

    container.innerHTML = ''
    var root = el('div', 'fxc-root'), bar = el('div', 'fxc-bar'), vp = el('div', 'fxc-vp')
    var page = el('div', 'fxc-page'), world = el('div', 'fxc-world'), overlay = el('div', 'fxc-overlay')
    var imageInput = document.createElement('input'); imageInput.type = 'file'; imageInput.accept = 'image/*'; imageInput.hidden = true
    vp.tabIndex = 0; vp.setAttribute('role', 'application'); vp.setAttribute('aria-label', 'NOTE PAGE'); page.appendChild(world); page.appendChild(overlay); vp.appendChild(page)
    if (!readonly) { bar.appendChild(toolGroup()); bar.appendChild(colorGroup()); bar.appendChild(actionGroup()) }
    var hint = el('div', 'fxc-hint', 'CLICK ANYWHERE AND START TYPING')
    imageInput.onchange = addSelectedImage
    vp.appendChild(hint); if (!readonly) root.appendChild(bar); root.appendChild(vp); root.appendChild(imageInput); container.appendChild(root)

    function toolGroup () {
      var group = el('div', 'fxc-tools')
      TOOLS.forEach(function (item) {
        var button = el('button', 'fxc-tool' + (item[0] === tool ? ' is-active' : ''))
        button.type = 'button'; button.title = item[1]; button.setAttribute('aria-label', item[1]); button.setAttribute('aria-pressed', item[0] === tool ? 'true' : 'false'); button.dataset.tool = item[0]
        button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + item[2] + '</svg>'
        button.onclick = function () { setTool(item[0]) }; group.appendChild(button)
      })
      return group
    }
    function colorGroup () {
      var group = el('div', 'fxc-colors')
      COLORS.forEach(function (value) {
        var button = el('button', 'fxc-swatch' + (value === color ? ' is-active' : ''))
        button.type = 'button'; button.style.background = value; button.dataset.color = value; button.title = value
        button.onclick = function () {
          color = value; group.querySelectorAll('.fxc-swatch').forEach(function (swatch) { swatch.classList.toggle('is-active', swatch.dataset.color === value) })
          var targets = selectedBlocks().filter(function (block) { return block.type !== 'code' && block.type !== 'image' }); if (!targets.length) return // neither shows a fill
          snapshot(); targets.forEach(function (block) { if (block.type === 'draw' || block.type === 'line') { block.strokeColor = value; if (Array.isArray(block.paths)) block.paths.forEach(function (part) { if (part) part.strokeColor = value }) } else { block.style = block.style || {}; block.style.bgColor = value } })
          render(); commit()
        }
        group.appendChild(button)
      })
      return group
    }
    function actionGroup () {
      var group = el('div', 'fxc-actions')
      group.appendChild(iconButton('UNDO', '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>', doUndo))
      group.appendChild(iconButton('REDO', '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h1"/>', doRedo))
      group.appendChild(iconButton('DELETE', '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>', removeSelected, 'fxc-danger'))
      group.appendChild(el('span', 'fxc-sep'))
      group.appendChild(iconButton('ZOOM OUT', '<circle cx="11" cy="11" r="7"/><path d="M8 11h6M21 21l-4.3-4.3"/>', function () { zoomBy(1 / 1.2) }, 'fxc-zoomctl'))
      var level = el('button', 'fxc-zoom', '100%'); level.type = 'button'; level.id = 'fxcZoom'; level.title = 'RESET ZOOM'; level.setAttribute('aria-label', 'RESET ZOOM')
      level.onclick = function () { zoom = 1; render(); vp.scrollLeft = 0; vp.scrollTop = 0; commit() }; group.appendChild(level)
      group.appendChild(iconButton('ZOOM IN', '<circle cx="11" cy="11" r="7"/><path d="M11 8v6M8 11h6M21 21l-4.3-4.3"/>', function () { zoomBy(1.2) }, 'fxc-zoomctl'))
      return group
    }
    function iconButton (title, svg, fn, cls) {
      var button = el('button', 'fxc-abtn' + (cls ? ' ' + cls : '')); button.type = 'button'; button.title = title; button.setAttribute('aria-label', title)
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + svg + '</svg>'
      button.onclick = fn; return button
    }

    function byId (blockId) { return blocks.filter(function (b) { return b.id === String(blockId) })[0] || null }
    function isSelected (blockId) { return selectedIds.indexOf(String(blockId)) >= 0 }
    function selectedBlocks () { return selectedIds.map(byId).filter(Boolean) }
    function toWorld (clientX, clientY) { var rect = page.getBoundingClientRect(); return { x: Math.max(0, (clientX - rect.left) / zoom), y: Math.max(0, Math.min(CANVAS_MAX_Y, (clientY - rect.top) / zoom)) } }
    function clampBlockY (block) { if (!block) return; block.x = Math.max(0, +block.x || 0); block.y = Math.max(0, Math.min(Math.max(0, CANVAS_MAX_Y - (+block.h || 0)), +block.y || 0)) }
    // A cropped picture shows only part of its box (clip-path); selection and resizing follow that visible part.
    function cropInsets (block) {
      var e = (block.type === 'image' && block.effects) || {}, pct = function (value) { return Math.max(0, Math.min(45, +value || 0)) / 100 }, c = { l: pct(e.cropLeft), r: pct(e.cropRight), t: pct(e.cropTop), b: pct(e.cropBottom) }, swap
      if (e.flipH) { swap = c.l; c.l = c.r; c.r = swap }
      if (e.flipV) { swap = c.t; c.t = c.b; c.b = swap }
      return c
    }
    function visibleRect (block) {
      if (block.type === 'draw' || block.type === 'line') { // the stroke (and arrowheads: 6x stroke markers) reach past the path's bounds
        var parts = [block].concat(Array.isArray(block.paths) ? block.paths.filter(Boolean) : []), stroke = Math.max.apply(null, parts.map(function (part) { return +part.strokeWidth || 3 }))
        var pad = stroke * (parts.some(function (part) { return part.arrowMode === 'end' || part.arrowMode === 'both' }) ? 3 : 0.5)
        return { x: block.x - pad, y: block.y - pad, w: block.w + 2 * pad, h: block.h + 2 * pad }
      }
      var c = cropInsets(block); return { x: block.x + block.w * c.l, y: block.y + block.h * c.t, w: block.w * (1 - c.l - c.r), h: block.h * (1 - c.t - c.b) }
    }
    function contentExtents () { var maxX = 0, maxY = 0; blocks.forEach(function (block) { maxX = Math.max(maxX, (+block.x || 0) + (+block.w || 0)); maxY = Math.max(maxY, (+block.y || 0) + (+block.h || 0)) }); return { x: maxX, y: maxY } }
    function pageWidth () { var avail = Math.max(320, Math.floor((vp.clientWidth || PAGE_WIDTH) / zoom)); return Math.max(avail, Math.ceil(contentExtents().x + 40)) }
    function pageHeight () { var minH = Math.max(480, Math.ceil((vp.clientHeight || 600) / zoom)); return Math.min(CANVAS_MAX_Y, Math.max(minH, Math.ceil(contentExtents().y + 300))) }
    function updatePageSize () {
      if (gesture || draw) return // page stays fixed during drags so pointer math is stable; grows on release
      var pw = pageWidth(), ph = pageHeight()
      world.style.width = pw + 'px'; world.style.height = ph + 'px'
      page.style.width = (pw * zoom) + 'px'; page.style.height = (ph * zoom) + 'px'
    }
    function setTool (next) {
      if (next === 'image') { imageInput.value = ''; imageInput.click(); return }
      tool = next; bar.querySelectorAll('.fxc-tool').forEach(function (button) { var active = button.dataset.tool === next; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', active ? 'true' : 'false') })
      vp.dataset.tool = next; if (next !== 'select') selectBlock(null)
    }
    function zoomBy (factor, clientX, clientY) {
      var rect = vp.getBoundingClientRect(), cx = clientX == null ? rect.left + rect.width / 2 : clientX, cy = clientY == null ? rect.top + rect.height / 2 : clientY
      var anchor = toWorld(cx, cy), previous = zoom
      zoom = Math.max(.2, Math.min(4, zoom * factor)); if (zoom === previous) return
      render()
      var pageRect = page.getBoundingClientRect()
      vp.scrollLeft += (pageRect.left + anchor.x * zoom) - cx
      vp.scrollTop += (pageRect.top + anchor.y * zoom) - cy
      scheduleCommit()
    }
    function snapshotTyping () { if (!editSnapshotTimer) snapshot(); clearTimeout(editSnapshotTimer); editSnapshotTimer = setTimeout(function () { editSnapshotTimer = null }, 800) }

    function render () {
      if (destroyed) return
      world.style.transform = 'scale(' + zoom + ')'
      world.innerHTML = ''
      blocks.slice().sort(function (a, b) { return a.zIndex - b.zIndex }).forEach(function (block) { world.appendChild(renderBlock(block)) })
      world.querySelectorAll('.fxc-text-content, .fxc-table-card td').forEach(function (node) { inkHighlights(node) })
      syncAutoHeights(); renderOverlay(); hint.hidden = readonly || blocks.length > 0
      var level = document.getElementById('fxcZoom'); if (level) level.textContent = Math.round(zoom * 100) + '%'
    }
    function isAutoHeight (block) { return block && (block.type === 'text' || block.type === 'todo' || block.type === 'table' || block.type === 'code') }
    function syncBlockHeight (block, node) {
      if (!isAutoHeight(block) || !node) return
      var area = block.type === 'code' && node.querySelector('textarea')
      if (area) { area.style.height = 'auto'; area.style.height = area.scrollHeight + 'px' } // code grows with its content instead of scrolling in a fixed box
      node.style.height = 'auto'; block.h = Math.max(block.type === 'text' ? 40 : 36, Math.ceil(node.offsetHeight)); clampBlockY(block)
    }
    function syncAutoHeights () { blocks.forEach(function (block) { if (isAutoHeight(block)) syncBlockHeight(block, world.querySelector('[data-id="' + block.id + '"]')) }) }
    function renderBlock (block) {
      var node
      if (block.type === 'draw' || block.type === 'line') node = renderSvg(block)
      else if (block.type === 'image') {
        node = el('img', 'fxc-block fxc-img' + (isSelected(block.id) ? ' is-sel' : '') + (block.isBackground ? ' is-background' : '')); node.src = block.src || ''; node.alt = block.alt || ''; node.draggable = false
        if (block.effects) { node.style.opacity = block.effects.opacity == null ? 1 : block.effects.opacity / 100; node.style.borderRadius = (+block.effects.radius || 0) + 'px'; node.style.clipPath = 'inset(' + (+block.effects.cropTop || 0) + '% ' + (+block.effects.cropRight || 0) + '% ' + (+block.effects.cropBottom || 0) + '% ' + (+block.effects.cropLeft || 0) + '%)' }
      } else if (block.type === 'todo') node = renderTodo(block)
      else if (block.type === 'code') node = renderCode(block)
      else if (block.type === 'table') node = renderTable(block)
      else if (block.type === 'attachment') node = renderAttachment(block)
      else node = renderText(block)
      node.dataset.id = block.id; node.style.left = block.x + 'px'; node.style.top = block.y + 'px'; node.style.width = block.w + 'px'
      if (block.style && block.style.bgColor && block.style.bgColor !== 'transparent' && block.type !== 'image' && block.type !== 'code') { node.style.background = block.style.bgColor; var ink = inkOn(block.style.bgColor); if (ink) { node.style.color = ink; node.style.setProperty('--text', ink) } }
      if (!readonly) { node.tabIndex = 0; node.setAttribute('aria-label', (block.type || 'block').toUpperCase() + ' BLOCK'); node.setAttribute('aria-selected', isSelected(block.id) ? 'true' : 'false') }
      if (!isAutoHeight(block)) node.style.height = block.h + 'px'
      node.style.zIndex = block.zIndex == null ? 1 : block.zIndex
      var transform = 'rotate(' + (block.rotation || 0) + 'deg)'
      if (block.type === 'image' && block.effects) { if (block.effects.flipH) transform += ' scaleX(-1)'; if (block.effects.flipV) transform += ' scaleY(-1)' }
      node.style.transform = transform
      if (!readonly && block.type !== 'draw' && block.type !== 'line' && block.type !== 'image') {
        var grip = el('button', 'fxc-grip', '<span></span><span></span><span></span>'); grip.type = 'button'; grip.title = 'MOVE BLOCK'
        grip.addEventListener('pointerdown', function (event) { beginMove(event, block) }); node.appendChild(grip)
      }
      if (!readonly) node.addEventListener('pointerdown', function (event) { blockPointerDown(event, block) })
      if (!readonly) node.addEventListener('contextmenu', function (event) {
        event.preventDefault(); event.stopPropagation()
        var content = event.target.closest('.fxc-text-content,td')
        if (content && selectedRangeIn(content)) { maybeShowTextTools(content, block); return }
        var cell = event.target.closest('td'); if (block.type === 'table' && cell) showTableMenu(block, cell, event.clientX, event.clientY)
        else showBlockMenu(block, event.clientX, event.clientY)
      })
      return node
    }
    function isEmptyTextContent (html) { return !String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() }
    function renderText (block) {
      // A fresh, still-empty container shows only the caret — the outline/chrome appears once it has content.
      var node = el('div', 'fxc-block fxc-text' + (isSelected(block.id) ? ' is-sel' : '') + (isEmptyTextContent(block.content) ? ' is-empty' : ''))
      var content = el('div', 'fxc-text-content'); content.contentEditable = readonly ? 'false' : 'true'; content.spellcheck = false; content.appendChild(sanitizeToFragment(block.content))
      if (block.style && block.style.bgColor && block.style.bgColor !== 'transparent') node.style.background = block.style.bgColor
      content.addEventListener('pointerdown', function (event) { if (readonly) return; if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.stopPropagation(); selectBlock(block.id, true); vp.focus() } else selectBlock(block.id) })
      content.addEventListener('beforeinput', snapshotTyping)
      content.addEventListener('input', function () { block.content = content.innerHTML; var empty = !content.textContent.replace(/\u00a0/g, ' ').trim(); provisionalText[block.id] = empty; node.classList.toggle('is-empty', empty); syncBlockHeight(block, node); renderOverlay(); scheduleCommit() })
      content.addEventListener('paste', pasteEditable)
      bindRichDrop(content)
      content.addEventListener('keydown', function (event) {
        if (readonly || event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || content.innerText.indexOf('\n') >= 0) return
        event.preventDefault(); snapshot(); delete provisionalText[block.id]
        block.type = 'table'; block.rows = 1; block.cols = 2; block.cells = [[content.innerHTML, '']]; block.colWidths = [50, 50]; delete block.content
        render(); commit(); focusTableCell(block.id, 0, 1)
      })
      node.appendChild(content)
      return node
    }
    function renderTodo (block) {
      var node = el('div', 'fxc-block fxc-card fxc-todo' + (isSelected(block.id) ? ' is-sel' : ''))
      block.items = Array.isArray(block.items) && block.items.length ? block.items : [{ id: id(), text: '', checked: false }]
      block.items.forEach(function (item, index) {
        var row = el('div', 'fxc-todo-row'), check = document.createElement('input'), input = el('div', 'fxc-todo-input')
        check.type = 'checkbox'; check.checked = !!item.checked; check.disabled = readonly; input.contentEditable = readonly ? 'false' : 'true'; input.spellcheck = true; input.dataset.placeholder = 'TO-DO'; input.textContent = item.text || ''
        check.onchange = function () { snapshot(); item.checked = check.checked; scheduleCommit() }
        input.addEventListener('beforeinput', snapshotTyping)
        input.addEventListener('paste', pasteEditable)
        bindRichDrop(input)
        input.oninput = function () { item.text = input.innerText.replace(/\n$/, ''); syncBlockHeight(block, node); renderOverlay(); scheduleCommit() }
        input.onkeydown = function (event) {
          if (readonly || event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          snapshot()
          if (!input.textContent.trim()) { exitTodo(block, index); return }
          block.items.splice(index + 1, 0, { id: id(), text: '', checked: false }); render(); commit(); focusTodoItem(block.id, index + 1)
        }
        row.appendChild(check); row.appendChild(input); node.appendChild(row)
      })
      node.addEventListener('keydown', function (event) {
        if (readonly || !(event.ctrlKey || event.metaKey) || event.key !== '1') return
        event.preventDefault(); var current = document.activeElement && document.activeElement.closest('.fxc-todo-row'), checkbox = current && current.querySelector('input[type="checkbox"]'); if (checkbox) { checkbox.checked = !checkbox.checked; checkbox.dispatchEvent(new Event('change', { bubbles: true })) }
      })
      return node
    }
    function focusTodoItem (blockId, index, atEnd) {
      setTimeout(function () { var inputs = world.querySelectorAll('[data-id="' + blockId + '"] .fxc-todo-input'), input = inputs[index]; if (!input) return; input.focus(); if (atEnd) { var range = document.createRange(), selection = window.getSelection(); range.selectNodeContents(input); range.collapse(false); selection.removeAllRanges(); selection.addRange(range) } }, 0)
    }
    function exitTodo (block, index) {
      block.items.splice(index, 1)
      if (!block.items.length) { block.type = 'text'; block.content = ''; delete block.items; provisionalText[block.id] = true; render(); commit(); focusBlock(block.id); return }
      var text = addBlock({ type: 'text', x: block.x, y: block.y + block.h + 8, w: block.w, h: 40, content: '', style: { bgColor: 'transparent' } }); provisionalText[text.id] = true
      render(); selectBlock(text.id); commit(); focusBlock(text.id)
    }
    function renderCode (block) {
      var node = el('div', 'fxc-block fxc-card fxc-code' + (isSelected(block.id) ? ' is-sel' : ''))
      var header = el('div', 'fxc-code-head'), language = document.createElement('select'), copy = el('button', 'fxc-code-copy', 'COPY')
      ;[['PLAIN', ''], ['BASH', 'bash'], ['PYTHON', 'python'], ['JAVASCRIPT', 'javascript'], ['TYPESCRIPT', 'typescript'], ['GO', 'go'], ['RUST', 'rust'], ['C', 'c'], ['C++', 'cpp'], ['JAVA', 'java'], ['HTML', 'html'], ['CSS', 'css'], ['SQL', 'sql'], ['JSON', 'json'], ['YAML', 'yaml']].forEach(function (choice) { var option = document.createElement('option'); option.textContent = choice[0]; option.value = choice[1]; option.selected = block.lang === choice[1]; language.appendChild(option) })
      language.disabled = readonly; language.onchange = function () { snapshot(); block.lang = language.value; commit() }; copy.type = 'button'; copy.onclick = function () { navigator.clipboard.writeText(block.code || '').then(function () { copy.textContent = 'COPIED'; setTimeout(function () { copy.textContent = 'COPY' }, 1200) }) }
      header.appendChild(language); header.appendChild(copy); node.appendChild(header)
      var area = document.createElement('textarea'); area.value = block.code || block.content || ''; area.readOnly = readonly; area.spellcheck = false
      area.addEventListener('beforeinput', snapshotTyping); area.oninput = function () { block.code = area.value; syncBlockHeight(block, node); renderOverlay(); scheduleCommit() }; area.onkeydown = function (event) { if (event.key === 'Tab' && !readonly) { event.preventDefault(); snapshotTyping(); var start = area.selectionStart; area.setRangeText('  ', start, area.selectionEnd, 'end'); area.oninput() } }; node.appendChild(area); return node
    }
    function colWidthsPct (block) {
      var cols = Math.max(1, +block.cols || 1)
      if (Array.isArray(block.colWidths) && block.colWidths.length === cols) {
        var total = block.colWidths.reduce(function (sum, width) { return sum + (+width || 0) }, 0)
        if (total > 0) return block.colWidths.map(function (width) { return (+width || 0) / total * 100 })
      }
      var equal = []; for (var i = 0; i < cols; i++) equal.push(100 / cols); return equal
    }
    function tableCellKeydown (event, block, rr, cc) {
      if (readonly) return
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        var flat = rr * block.cols + cc, next = flat + (event.shiftKey ? -1 : 1)
        if (next < 0) return
        event.preventDefault()
        if (next >= block.rows * block.cols) {
          // OneNote: Tab past the end of a single-row table adds a column; otherwise a new row.
          if (block.rows === 1) { tableColumn(block, block.cols, false); focusTableCell(block.id, 0, block.cols - 1) } else { tableRow(block, block.rows, false); focusTableCell(block.id, block.rows - 1, 0) }
          return
        }
        focusTableCell(block.id, Math.floor(next / block.cols), next % block.cols)
        return
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); tableRow(block, rr + 1, false); focusTableCell(block.id, rr + 1, cc); return }
      // OneNote: Enter in the last cell appends a new row. Shift/Alt+Enter keeps a line break in the cell.
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && rr === block.rows - 1 && cc === block.cols - 1) { event.preventDefault(); tableRow(block, block.rows, false); focusTableCell(block.id, block.rows - 1, 0) }
    }
    function styleTableCell (td, preset, row, rowCount) {
      var mode = preset.borderMode || 'all', edge = (+preset.borderWidth || 0) + 'px ' + (preset.borderStyle || 'solid') + ' ' + (preset.borderColor || 'transparent')
      if (mode === 'none' || preset.borderStyle === 'none') td.style.border = '0'
      else if (mode === 'rows') { td.style.border = '0'; if (row < rowCount - 1) td.style.borderBottom = edge }
      else td.style.border = edge
      if (row === 0 && (preset.headerBg || preset.headerBold)) {
        if (preset.headerBg) td.style.background = preset.headerBg
        if (preset.headerFg) td.style.color = preset.headerFg
        if (preset.headerBold) td.style.fontWeight = '700'
      } else if (row % 2 && preset.stripedBg) td.style.background = preset.stripedBg
    }
    function renderTable (block) {
      var node = el('div', 'fxc-block fxc-card fxc-table-card' + (isSelected(block.id) ? ' is-sel' : '')), table = document.createElement('table')
      block.rows = +block.rows || 2; block.cols = +block.cols || 2; block.cells = Array.isArray(block.cells) ? block.cells : []
      var preset = TABLE_STYLES[block.tableStyle] || { borderMode: block.borderMode || 'all', borderStyle: block.borderStyle || 'solid', borderColor: block.borderColor || '#64717d', borderWidth: block.borderWidth || '1', borderRadius: block.borderRadius || '0', headerBg: block.headerBg || '', headerFg: block.headerFg || '', headerBold: !!block.headerBold, stripedBg: block.stripedBg || '' }
      node.style.borderRadius = (+preset.borderRadius || 0) + 'px'
      if (+preset.borderRadius) {
        // Clip the cells to the corners (the card itself can't clip: its grips sit outside it), then stroke the curve they lose.
        table.style.clipPath = 'inset(0 round ' + (+preset.borderRadius) + 'px)'
        if ((preset.borderMode || 'all') === 'all' && preset.borderStyle !== 'none') node.style.setProperty('--fxc-round-edge', (+preset.borderWidth || 0) + 'px ' + (preset.borderStyle || 'solid') + ' ' + (preset.borderColor || 'transparent'))
      }
      var widths = colWidthsPct(block)
      var colgroup = document.createElement('colgroup'); widths.forEach(function (width) { var col = document.createElement('col'); col.style.width = width + '%'; colgroup.appendChild(col) }); table.appendChild(colgroup)
      for (var r = 0; r < block.rows; r++) { var tr = document.createElement('tr'); block.cells[r] = block.cells[r] || []; for (var c = 0; c < block.cols; c++) { var td = document.createElement('td');         td.contentEditable = readonly ? 'false' : 'true'; td.dataset.row = r; td.dataset.col = c; td.appendChild(sanitizeToFragment(block.cells[r][c])); styleTableCell(td, preset, r, block.rows); (function (rr, cc, cell) { cell.addEventListener('beforeinput', snapshotTyping); cell.addEventListener('paste', pasteEditable); bindRichDrop(cell); cell.oninput = function () { block.cells[rr][cc] = cell.innerHTML; syncBlockHeight(block, node); renderOverlay(); scheduleCommit() }; cell.onkeydown = function (event) { tableCellKeydown(event, block, rr, cc) } })(r, c, td); tr.appendChild(td) } table.appendChild(tr) }
      node.appendChild(table)
      if (!readonly) {
        // OneNote-style draggable column borders (last grip resizes the final column / table width).
        var acc = 0
        widths.forEach(function (width, index) {
          acc += width
          var grip = el('div', 'fxc-colgrip'); grip.style.left = 'calc(' + acc + '% - 4px)'; grip.dataset.col = index; grip.title = 'RESIZE COLUMN'
          grip.addEventListener('pointerdown', function (event) { startColResize(event, block, index) })
          node.appendChild(grip)
        })
      }
      return node
    }
    function focusTableCell (blockId, row, col) { setTimeout(function () { var cell = world.querySelector('[data-id="' + blockId + '"] td[data-row="' + row + '"][data-col="' + col + '"]'); if (cell) cell.focus() }, 0) }
    function insertSanitizedAtCaret (html, text) {
      var frag = sanitizeToFragment(html || '')
      if (!frag.childNodes.length) {
        document.execCommand('insertText', false, text || '')
        return
      }
      var sel = window.getSelection()
      if (sel && sel.rangeCount) {
        snapshot()
        var range = sel.getRangeAt(0)
        range.deleteContents()
        range.insertNode(frag)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
        // Range edits emit no input event; fire one so the block/cell handlers
        // copy the DOM into the model and schedule a save.
        var target = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentNode
        if (target) target.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
    function pasteEditable (event) {
      var dt = event.clipboardData || event.dataTransfer
      var html = dt && dt.getData('text/html'), text = dt && dt.getData('text/plain')
      event.preventDefault(); insertSanitizedAtCaret(html, text)
    }
    function bindRichDrop (el) {
      if (readonly) return
      el.addEventListener('dragover', function (event) { event.preventDefault() })
      el.addEventListener('drop', function (event) {
        event.preventDefault()
        event.stopPropagation()
        pasteEditable(event)
      })
    }
    function renderAttachment (block) {
      var node = el('div', 'fxc-block fxc-card fxc-attachment' + (isSelected(block.id) ? ' is-sel' : ''))
      node.innerHTML = '<span class="fxc-file-icon">↗</span><span><b>' + esc(block.fileName || 'FILE') + '</b><small>' + esc(block.fileExt || '') + (block.fileSize ? ' · ' + esc(formatBytes(block.fileSize)) : '') + '</small></span>'
      node.title = block.fileName || ''; if (block.fileId) node.ondblclick = function () { openAttachment(block) }; return node
    }
    function renderSvg (block) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.setAttribute('class', 'fxc-block fxc-svg' + (isSelected(block.id) ? ' is-sel' : ''))
      node.setAttribute('viewBox', '0 0 ' + block.w + ' ' + block.h); node.setAttribute('width', block.w); node.setAttribute('height', block.h)
      if (block.type === 'draw' && Array.isArray(block.paths) && block.paths.length) {
        block.paths.forEach(function (part, index) {
          if (!part) return
          if (part.lineData) {
            var line = document.createElementNS('http://www.w3.org/2000/svg', 'line'), markerBlock = { id: block.id + '-' + index, strokeColor: part.strokeColor }
            line.setAttribute('x1', part.lineData.x1); line.setAttribute('y1', part.lineData.y1); line.setAttribute('x2', part.lineData.x2); line.setAttribute('y2', part.lineData.y2); line.setAttribute('stroke', part.strokeColor || '#0e8fd6'); line.setAttribute('stroke-width', +part.strokeWidth || 3); line.setAttribute('stroke-linecap', 'round')
            if (part.arrowMode === 'end' || part.arrowMode === 'both') { node.appendChild(arrowMarker(markerBlock, 'end')); line.setAttribute('marker-end', 'url(#fxc-arrow-end-' + markerBlock.id + ')') }
            if (part.arrowMode === 'both') { node.appendChild(arrowMarker(markerBlock, 'start')); line.setAttribute('marker-start', 'url(#fxc-arrow-start-' + markerBlock.id + ')') }
            node.appendChild(line)
          } else if (part.d) {
            var partPath = document.createElementNS('http://www.w3.org/2000/svg', 'path'); partPath.setAttribute('d', part.d); partPath.setAttribute('fill', 'none'); partPath.setAttribute('stroke', part.strokeColor || '#0e8fd6'); partPath.setAttribute('stroke-width', +part.strokeWidth || 3); partPath.setAttribute('stroke-linecap', 'round'); partPath.setAttribute('stroke-linejoin', 'round'); node.appendChild(partPath)
          }
        })
        return node
      }
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path'), pathData
      if (block.type === 'draw') pathData = block.pathData || pointsPath(block)
      else pathData = 'M' + (+block.lx1 || 0) + ' ' + (+block.ly1 || 0) + ' L' + (block.lx2 == null ? block.w : +block.lx2) + ' ' + (block.ly2 == null ? block.h : +block.ly2)
      path.setAttribute('d', pathData); path.setAttribute('fill', 'none'); path.setAttribute('stroke', block.strokeColor || '#0e8fd6'); path.setAttribute('stroke-width', +block.strokeWidth || 3); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round')
      if (block.type === 'line' && (block.arrowMode === 'end' || block.arrowMode === 'both')) { var marker = arrowMarker(block, 'end'); node.appendChild(marker); path.setAttribute('marker-end', 'url(#fxc-arrow-end-' + block.id + ')') }
      if (block.type === 'line' && block.arrowMode === 'both') { var startMarker = arrowMarker(block, 'start'); node.appendChild(startMarker); path.setAttribute('marker-start', 'url(#fxc-arrow-start-' + block.id + ')') }
      node.appendChild(path); return node
    }
    function pointsPath (block) { var points = Array.isArray(block.points) ? block.points : []; if (!points.length) return ''; return points.map(function (point, index) { return (index ? 'L' : 'M') + (point[0] - block.x) + ' ' + (point[1] - block.y) }).join(' ') }
    function arrowMarker (block, side) { var marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker'); marker.id = 'fxc-arrow-' + side + '-' + block.id; marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', side === 'start' ? '2' : '8'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6'); marker.setAttribute('orient', 'auto'); var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', side === 'start' ? 'M10 0L0 5L10 10z' : 'M0 0L10 5L0 10z'); p.setAttribute('fill', block.strokeColor || '#0e8fd6'); marker.appendChild(p); return marker }

    function renderOverlay () {
      overlay.innerHTML = ''
      updatePageSize()
      if (gesture && gesture.type === 'marquee' && gesture.moved) {
        var marquee = el('div', 'fxc-marquee'), area = marqueeArea(gesture)
        marquee.style.left = (area.x * zoom) + 'px'; marquee.style.top = (area.y * zoom) + 'px'; marquee.style.width = (area.w * zoom) + 'px'; marquee.style.height = (area.h * zoom) + 'px'; overlay.appendChild(marquee)
      }
      if (!selectedIds.length || readonly) return
      selectedBlocks().forEach(function (block) {
        if (provisionalText[block.id]) return // untyped text containers get no selection box or handles
        var v = visibleRect(block), box = el('div', 'fxc-selbox' + (selectedIds.length > 1 ? ' is-multi' : '')); box.dataset.selectionId = block.id; box.style.left = (v.x * zoom) + 'px'; box.style.top = (v.y * zoom) + 'px'; box.style.width = (v.w * zoom) + 'px'; box.style.height = (v.h * zoom) + 'px'
        // Rotate about the block's own centre, which sits off-centre in a cropped picture's box.
        box.style.transform = 'rotate(' + (block.rotation || 0) + 'deg)'; box.style.transformOrigin = ((block.x + block.w / 2 - v.x) * zoom) + 'px ' + ((block.y + block.h / 2 - v.y) * zoom) + 'px'
        if (selectedIds.length === 1 && block.type !== 'draw' && block.type !== 'line') {
          var handles = isAutoHeight(block) || block.type === 'attachment' ? ['e'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
          handles.forEach(function (name) { var handle = el('div', 'fxc-handle fxc-h-' + name); handle.dataset.handle = name; handle.setAttribute('role', 'button'); handle.setAttribute('aria-label', 'RESIZE ' + name.toUpperCase()); handle.addEventListener('pointerdown', function (event) { event.stopPropagation(); event.preventDefault(); startResize(event, block, name) }); box.appendChild(handle) })
        }
        overlay.appendChild(box)
      })
    }

    function addBlock (block) { block.id = String(block.id || id()); block.zIndex = ++maxZ; block = normalize(block); clampBlockY(block); blocks.push(block); nextId = Math.max(+nextId || 1, blocks.length + 1); return blocks[blocks.length - 1] }
    function removeBlock (blockId) { if (!byId(blockId)) return; snapshot(); blocks = blocks.filter(function (block) { return block.id !== String(blockId) }); selectedIds = selectedIds.filter(function (idValue) { return idValue !== String(blockId) }); selected = selectedIds[selectedIds.length - 1] || null; render(); commit() }
    function removeSelected () { if (!selectedIds.length) return; snapshot(); var removing = selectedIds.slice(); blocks = blocks.filter(function (block) { return removing.indexOf(block.id) < 0 }); selectedIds = []; selected = null; render(); commit() }
    function selectBlock (blockId, additive) {
      var next = blockId == null ? null : String(blockId), previous = selected
      if (previous && previous !== next && provisionalText[previous]) { var empty = byId(previous); if (empty) { blocks = blocks.filter(function (block) { return block.id !== previous }); delete provisionalText[previous]; var oldNode = world.querySelector('[data-id="' + previous + '"]'); if (oldNode) oldNode.remove() } }
      if (!next) selectedIds = []
      else if (additive) { var index = selectedIds.indexOf(next); if (index >= 0) selectedIds.splice(index, 1); else selectedIds.push(next) }
      else if (!isSelected(next) || selectedIds.length !== 1) selectedIds = [next]
      selected = selectedIds[selectedIds.length - 1] || null
      renderOverlay(); world.querySelectorAll('.fxc-block').forEach(function (node) { var active = isSelected(node.dataset.id); node.classList.toggle('is-sel', active); node.setAttribute('aria-selected', active ? 'true' : 'false') })
    }
    function focusBlock (blockId) { setTimeout(function () { var node = world.querySelector('[data-id="' + blockId + '"]'); if (!node) return; var target = node.querySelector('[contenteditable="true"],input[type="text"],textarea,td') || node; target.focus() }, 20) }
    // A text block is positioned by its top-left corner, but the caret sits inside the border +
    // content padding and spans a whole line box. Placing the corner on the click point therefore
    // renders the caret down-right of the pointer. Measure that inset from live CSS (so it tracks
    // theme/font changes instead of hardcoded numbers) and subtract it when creating by click, so
    // the caret's left edge and vertical middle land exactly where the user clicked.
    function textCaretInset () {
      var fallback = { x: 11, y: 19 }
      if (!world) return fallback
      try {
        var probe = el('div', 'fxc-block fxc-text is-empty'), content = el('div', 'fxc-text-content')
        content.textContent = 'X'; probe.appendChild(content)
        probe.style.cssText = 'left:0;top:0;width:260px;visibility:hidden;pointer-events:none'
        world.appendChild(probe)
        var outer = probe.getBoundingClientRect(), inner = content.getBoundingClientRect(), styles = window.getComputedStyle(content)
        var scale = zoom || 1
        var padLeft = parseFloat(styles.paddingLeft) || 0, padTop = parseFloat(styles.paddingTop) || 0
        var lineHeight = parseFloat(styles.lineHeight) || (parseFloat(styles.fontSize) || 15) * 1.45
        var inset = { x: (inner.left - outer.left) / scale + padLeft, y: (inner.top - outer.top) / scale + padTop + lineHeight / 2 }
        probe.remove()
        return isFinite(inset.x) && isFinite(inset.y) ? inset : fallback
      } catch (err) { return fallback }
    }
    function createAt (kind, point, alignCaret) {
      snapshot(); var block
      var fit = function (width) { return Math.max(0, Math.min(point.x, pageWidth() - width - 12)) }
      if (kind === 'todo') block = addBlock({ type: 'todo', x: fit(240), y: point.y, w: 240, h: 40, items: [{ id: id(), text: '', checked: false }], style: { bgColor: 'transparent' } })
      else if (kind === 'table') block = addBlock({ type: 'table', x: fit(360), y: point.y, w: 360, h: 150, rows: 3, cols: 3, cells: [['', '', ''], ['', '', ''], ['', '', '']], style: { bgColor: 'transparent' } })
      else if (kind === 'code') block = addBlock({ type: 'code', x: fit(320), y: point.y, w: 320, h: 160, code: '', lang: 'text', style: { bgColor: '#0f1720' } })
      else {
        var inset = alignCaret ? textCaretInset() : { x: 0, y: 0 }
        point = { x: Math.max(0, point.x - inset.x), y: Math.max(0, point.y - inset.y) }
        block = addBlock({ type: 'text', x: fit(260), y: point.y, w: 260, h: 40, content: '', style: { bgColor: 'transparent' } })
      }
      if (kind === 'text') provisionalText[block.id] = true
      render(); selectBlock(block.id); if (kind !== 'text') commit(); setTool('select'); focusBlock(block.id)
    }
    function addSelectedImage () {
      var file = imageInput.files && imageInput.files[0]; if (!file) return
      insertImageFile(file, imageInsertPoint, imageReplaceId)
      imageInsertPoint = null; imageReplaceId = null
    }
    function insertImageFile (file, point, replaceId) {
      if (!file || !/^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.type || '')) { window.showToast && window.showToast('UNSUPPORTED IMAGE TYPE', 'error'); return }
      if (file.size > 10 * 1024 * 1024) { window.showToast && window.showToast('IMAGE TOO LARGE (MAX 10MB)', 'error'); return }
      var reader = new FileReader()
      reader.onload = function () {
        if (destroyed) return
        var image = new Image()
        image.onload = function () {
          if (destroyed) return
          var width = Math.min(420, image.naturalWidth || 320), height = Math.max(80, Math.round((image.naturalHeight || 220) * width / (image.naturalWidth || 320)))
          var rect = vp.getBoundingClientRect(), insertPoint = point || toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
          snapshot(); var block = byId(replaceId)
          if (block && block.type === 'image') { block.src = reader.result; block.alt = file.name || block.alt || ''; if (!block.w || !block.h) { block.w = width; block.h = height } }
          else block = addBlock({ type: 'image', x: insertPoint.x - width / 2, y: insertPoint.y - height / 2, w: width, h: height, src: reader.result, alt: file.name || '', effects: { opacity: 100, radius: 0, flipH: false, flipV: false } })
          render(); selectBlock(block.id); commit(); setTool('select')
        }
        image.src = reader.result
      }
      reader.readAsDataURL(file)
    }

    function menuItem (label, action, hint, danger) { return { label: label, action: action, hint: hint || '', danger: !!danger } }
    function closePopover () { if (popover) popover.remove(); popover = null; savedRange = null }
    function positionPopover (node, x, y) {
      node.style.left = Math.max(8, x) + 'px'; node.style.top = Math.max(8, y) + 'px'
      var rect = node.getBoundingClientRect(), left = x, top = y
      if (rect.right > window.innerWidth - 8) left = window.innerWidth - rect.width - 8
      if (rect.bottom > window.innerHeight - 8) top = window.innerHeight - rect.height - 8
      node.style.left = Math.max(8, left) + 'px'; node.style.top = Math.max(8, top) + 'px'
    }
    function openMenu (x, y, title, items) {
      closePopover(); popover = el('div', 'fxc-popover rd-cmenu is-open'); popover.setAttribute('role', 'menu')
      if (title) popover.appendChild(el('div', 'rd-cmenu-header', esc(title)))
      items.forEach(function (item) {
        if (!item) { popover.appendChild(el('div', 'rd-cmenu-sep')); return }
        if (item.node) { popover.appendChild(item.node); return }
        var button = el('button', 'rd-cmenu-item' + (item.danger ? ' rd-cmenu-danger' : '')); button.type = 'button'; button.setAttribute('role', 'menuitem')
        button.innerHTML = '<span class="rd-cmenu-label">' + esc(item.label) + '</span>' + (item.hint ? '<span class="rd-cmenu-hint">' + esc(item.hint) + '</span>' : '')
        button.addEventListener('click', function () { closePopover(); item.action() }); popover.appendChild(button)
      })
      document.body.appendChild(popover); positionPopover(popover, x, y)
      var first = popover.querySelector('button'); if (first) first.focus({ preventScroll: true })
      popover.addEventListener('keydown', function (event) {
        if (event.target.matches('input,select,textarea')) return
        var buttons = Array.prototype.slice.call(popover.querySelectorAll('button:not([disabled])')), index = buttons.indexOf(document.activeElement)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus() }
        else if (event.key === 'Home' && buttons.length) { event.preventDefault(); buttons[0].focus() }
        else if (event.key === 'End' && buttons.length) { event.preventDefault(); buttons[buttons.length - 1].focus() }
      })
    }
    function fieldRow (label, input) { var row = el('label', 'fxc-pop-row'); row.appendChild(el('span', '', esc(label))); row.appendChild(input); return row }
    function applyBlockChange (block, mutate) { snapshot(); mutate(); render(); selectBlock(block.id); commit() }
    function duplicateBlocks (targets) {
      targets = targets && targets.length ? targets : selectedBlocks(); if (!targets.length) return
      snapshot(); selectedIds = targets.map(function (block) { var copy = clone(block); copy.id = id(); copy.x += 20; copy.y += 20; copy.zIndex = ++maxZ; blocks.push(normalize(copy)); return copy.id }); selected = selectedIds[selectedIds.length - 1]; nextId = Math.max(+nextId || 1, blocks.length + 1); render(); commit()
    }
    function showBlockMenu (block, x, y) {
      if (!isSelected(block.id)) selectBlock(block.id)
      if (selectedIds.length > 1) { showMultiMenu(x, y); return }
      var items = []
      if (block.type === 'image') items.push({ node: imageControls(block) }, null)
      else if (block.type === 'draw' || block.type === 'line') items.push({ node: strokeControls(block) }, null)
      else if (block.type === 'todo') {
        items.push(menuItem('ADD TO-DO ITEM', function () { applyBlockChange(block, function () { block.items = block.items || []; block.items.push({ id: id(), text: '', checked: false }) }); focusTodoItem(block.id, block.items.length - 1) }))
        items.push(menuItem('CLEAR COMPLETED', function () { applyBlockChange(block, function () { block.items = (block.items || []).filter(function (item) { return !item.checked }); if (!block.items.length) block.items.push({ id: id(), text: '', checked: false }) }) }))
        items.push(null)
      } else if (block.type === 'attachment' && block.fileId) {
        items.push(menuItem('OPEN FILE', function () { openAttachment(block) })); items.push(null)
      }
      items.push({ node: layerControls(block) })
      if (block.type === 'image') {
        items.push(null)
        items.push(menuItem('CROP PICTURE', function () { var node = world.querySelector('[data-id="' + block.id + '"]'), rect = node.getBoundingClientRect(); showImageCropMenu(block, rect.right + 8, rect.top) }))
        items.push(menuItem(block.isBackground ? 'UNLOCK BACKGROUND' : 'SET PICTURE AS BACKGROUND', function () { applyBlockChange(block, function () { block.isBackground = !block.isBackground; if (block.isBackground) block.zIndex = -1 }) }))
        items.push(menuItem('REPLACE PICTURE', function () { imageReplaceId = block.id; imageInput.value = ''; imageInput.click() }))
        items.push(menuItem('EDIT ALT TEXT', function () { var value = window.prompt('ENTER ALT TEXT', block.alt || ''); if (value != null) applyBlockChange(block, function () { block.alt = String(value).slice(0, 500) }) }))
      }
      items.push(null)
      items.push(menuItem('CUT', function () { cutBlock(block) }, 'CTRL+X'))
      items.push(menuItem('COPY', function () { copyBlock(block) }, 'CTRL+C'))
      if (blockClipboard) items.push(menuItem('PASTE', function () { pasteBlock({ x: block.x + 20, y: block.y + 20 }) }, 'CTRL+V'))
      items.push(menuItem('DUPLICATE', function () { duplicateBlocks([block]) }, 'CTRL+D'))
      // Only free-floating visuals rotate — text/todo/table/code containers stay upright like OneNote.
      if (block.type === 'draw' || block.type === 'line') {
        items.push(menuItem('ROTATE 90 DEG CW', function () { applyBlockChange(block, function () { block.rotation = ((block.rotation || 0) + 90) % 360 }) }))
        items.push(menuItem('ROTATE 90 DEG CCW', function () { applyBlockChange(block, function () { block.rotation = ((block.rotation || 0) - 90) % 360 }) }))
      }
      items.push(null); items.push(menuItem('DELETE', function () { removeBlock(block.id) }, 'DEL', true))
      openMenu(x, y, (block.type || 'BLOCK').toUpperCase(), items)
    }
    function layerControls (block) {
      var panel = el('div', 'fxc-pop-controls fxc-layer-panel')
      panel.appendChild(el('div', 'fxc-pop-label', 'LAYER'))
      var row = el('div', 'fxc-pop-buttons')
      ;[['TO FRONT', 'front'], ['UP', 'forward'], ['DOWN', 'backward'], ['TO BACK', 'back']].forEach(function (spec) {
        row.appendChild(controlButton(spec[0], function () { changeBlockLayer(block, spec[1]) }))
      })
      panel.appendChild(row)
      return panel
    }
    function showMultiMenu (x, y) {
      openMenu(x, y, selectedIds.length + ' ITEMS SELECTED', [
        menuItem('CUT', function () { cutBlocks(selectedBlocks()) }, 'CTRL+X'), menuItem('COPY', function () { copyBlocks(selectedBlocks()) }, 'CTRL+C'), menuItem('DUPLICATE', function () { duplicateBlocks(selectedBlocks()) }, 'CTRL+D'), null,
        menuItem('BRING TO FRONT', function () { changeSelectedZ(true) }), menuItem('SEND TO BACK', function () { changeSelectedZ(false) }), null,
        menuItem('DELETE', removeSelected, 'DEL', true)
      ])
    }
    function imageControls (block) {
      var panel = el('div', 'fxc-pop-controls'), effects = block.effects || (block.effects = { opacity: 100, radius: 0, flipH: false, flipV: false })
      var opacity = document.createElement('input'); opacity.type = 'range'; opacity.min = 10; opacity.max = 100; opacity.value = effects.opacity == null ? 100 : effects.opacity
      var radius = document.createElement('input'); radius.type = 'range'; radius.min = 0; radius.max = 50; radius.value = effects.radius || 0
      var opacitySnap = false, radiusSnap = false
      opacity.onpointerdown = opacity.onfocus = function () { if (!opacitySnap) { snapshot(); opacitySnap = true } }; radius.onpointerdown = radius.onfocus = function () { if (!radiusSnap) { snapshot(); radiusSnap = true } }
      opacity.oninput = function () { effects.opacity = +opacity.value; render(); scheduleCommit() }; radius.oninput = function () { effects.radius = +radius.value; render(); scheduleCommit() }
      panel.appendChild(fieldRow('OPACITY', opacity)); panel.appendChild(fieldRow('CORNERS', radius))
      var toggles = el('div', 'fxc-pop-buttons')
      toggles.appendChild(controlButton('FLIP H', function () { snapshot(); effects.flipH = !effects.flipH; render(); commit() }))
      toggles.appendChild(controlButton('FLIP V', function () { snapshot(); effects.flipV = !effects.flipV; render(); commit() }))
      toggles.appendChild(controlButton('ROTATE ⟳', function () { snapshot(); block.rotation = ((block.rotation || 0) + 90) % 360; render(); commit() }))
      toggles.appendChild(controlButton('ROTATE ⟲', function () { snapshot(); block.rotation = ((block.rotation || 0) - 90) % 360; render(); commit() }))
      panel.appendChild(toggles); return panel
    }
    function imageCropControls (block) {
      var panel = el('div', 'fxc-pop-controls'), effects = block.effects || (block.effects = {})
      ;[['TOP', 'cropTop'], ['RIGHT', 'cropRight'], ['BOTTOM', 'cropBottom'], ['LEFT', 'cropLeft']].forEach(function (spec) { var input = document.createElement('input'), snapped = false; input.type = 'range'; input.min = 0; input.max = 45; input.value = +effects[spec[1]] || 0; input.onpointerdown = input.onfocus = function () { if (!snapped) { snapshot(); snapped = true } }; input.oninput = function () { effects[spec[1]] = +input.value; render(); scheduleCommit() }; panel.appendChild(fieldRow(spec[0], input)) })
      var reset = controlButton('RESET CROP', function () { snapshot(); effects.cropTop = effects.cropRight = effects.cropBottom = effects.cropLeft = 0; render(); commit() }); panel.appendChild(reset); return panel
    }
    function showImageCropMenu (block, x, y) { openMenu(x, y, 'CROP PICTURE', [{ node: imageCropControls(block) }]) }
    function strokeControls (block) {
      var panel = el('div', 'fxc-pop-controls'), width = document.createElement('input'), picker = document.createElement('input')
      width.type = 'range'; width.min = 1; width.max = 20; width.value = +block.strokeWidth || 3; picker.type = 'color'; picker.value = block.strokeColor || '#0e8fd6'
      var widthSnap = false, colorSnap = false
      width.onpointerdown = width.onfocus = function () { if (!widthSnap) { snapshot(); widthSnap = true } }; picker.onpointerdown = picker.onfocus = function () { if (!colorSnap) { snapshot(); colorSnap = true } }
      width.oninput = function () { block.strokeWidth = +width.value; if (Array.isArray(block.paths)) block.paths.forEach(function (part) { if (part) part.strokeWidth = +width.value }); render(); scheduleCommit() }; picker.oninput = function () { block.strokeColor = picker.value; if (Array.isArray(block.paths)) block.paths.forEach(function (part) { if (part) part.strokeColor = picker.value }); render(); scheduleCommit() }
      panel.appendChild(fieldRow('STROKE', width)); panel.appendChild(fieldRow('COLOR', picker))
      if (block.type === 'line') { panel.appendChild(el('div', 'fxc-pop-label', 'ARROWHEADS')); var arrows = el('div', 'fxc-pop-buttons'); [['NONE', 'none'], ['END', 'end'], ['BOTH', 'both']].forEach(function (choice) { arrows.appendChild(controlButton(choice[0], function () { snapshot(); block.arrowMode = choice[1]; render(); commit() }, block.arrowMode === choice[1])) }); panel.appendChild(arrows) }
      return panel
    }
    function controlButton (label, action, active) { var button = el('button', 'fxc-mini' + (active ? ' is-active' : ''), esc(label)); button.type = 'button'; button.onclick = action; return button }
    function copyBlocks (targets) { if (targets && targets.length) { blockClipboard = clone(targets); SHARED_BLOCK_CLIPBOARD = clone(targets) } }
    function copyBlock (block) { if (block) copyBlocks([block]) }
    function cutBlocks (targets) { if (!targets || !targets.length) return; copyBlocks(targets); removeSelected() }
    function cutBlock (block) { if (!block) return; selectBlock(block.id); cutBlocks([block]) }
    function pasteBlock (point) {
      if (!blockClipboard) return
      snapshot(); var copies = Array.isArray(blockClipboard) ? clone(blockClipboard) : [clone(blockClipboard)], minX = Math.min.apply(null, copies.map(function (block) { return block.x })), minY = Math.min.apply(null, copies.map(function (block) { return block.y }))
      selectedIds = copies.map(function (copy) { copy.id = id(); copy.x = point ? point.x + copy.x - minX : copy.x + 20; copy.y = point ? point.y + copy.y - minY : copy.y + 20; copy.zIndex = ++maxZ; blocks.push(normalize(copy)); return copy.id }); selected = selectedIds[selectedIds.length - 1]; render(); commit()
    }
    function changeSelectedZ (front) { var targets = selectedBlocks(); if (!targets.length) return; snapshot(); targets.forEach(function (block) { block.zIndex = front ? ++maxZ : 0 }); render(); commit() }
    function changeBlockLayer (block, direction) {
      snapshot()
      var ordered = blocks.slice().sort(function (a, b) { return (+a.zIndex || 0) - (+b.zIndex || 0) }), index = ordered.indexOf(block)
      if (direction === 'front') { ordered.splice(index, 1); ordered.push(block) }
      else if (direction === 'back') { ordered.splice(index, 1); ordered.unshift(block) }
      else if (direction === 'forward' && index < ordered.length - 1) { var above = ordered[index + 1]; ordered[index + 1] = block; ordered[index] = above }
      else if (direction === 'backward' && index > 0) { var below = ordered[index - 1]; ordered[index - 1] = block; ordered[index] = below }
      ordered.forEach(function (item, order) { item.zIndex = order + 1 }); maxZ = ordered.length
      render(); selectBlock(block.id); commit()
    }
    function openAttachment (block) {
      var ext = (block.fileExt || '').toLowerCase(), previewable = block.isPreviewable || ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'txt', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'py', 'js', 'html', 'css', 'sh', 'ini', 'cfg', 'conf', 'c', 'cpp', 'h', 'hpp', 'lua', 'rb', 'rs', 'go', 'java', 'ts', 'tsx', 'jsx', 'toml', 'bat', 'ps1', 'sql', 'r', 'swift', 'kt', 'php', 'pl', 'diff', 'makefile', 'pdf'].indexOf(ext) >= 0
      window.open(previewable && !block.isE2E ? '/file/' + encodeURIComponent(block.fileId) + '/preview' : '/f/' + encodeURIComponent(block.fileId), '_blank', 'noopener,noreferrer')
    }
    function showInsertMenu (x, y) {
      var point = toWorld(x, y)
      openMenu(x, y, 'INSERT AT CURSOR', [
        menuItem('TEXT', function () { createAt('text', { x: point.x - 100, y: point.y - 30 }) }, 'T'),
        menuItem('IMAGE', function () { imageInsertPoint = { x: point.x, y: point.y }; imageInput.value = ''; imageInput.click() }, 'I'),
        menuItem('TO-DO LIST', function () { createAt('todo', { x: point.x - 120, y: point.y - 50 }) }, 'O'),
        menuItem('TABLE', function () { createAt('table', { x: point.x - 180, y: point.y - 75 }) }, 'B'),
        menuItem('CODE BLOCK', function () { createAt('code', { x: point.x - 160, y: point.y - 80 }) }, 'C'), null,
        menuItem('FREE DRAW', function () { setTool('pen') }, 'P'), menuItem('LINE / ARROW', function () { setTool('line') }, 'L')
      ])
    }
    function tableStyleSwatch (name, active, action) {
      var button = el('button', 'fxc-style-swatch' + (active ? ' is-active' : '')); button.type = 'button'; button.title = name.toUpperCase()
      var preset = TABLE_STYLES[name], preview = el('span', 'fxc-style-mini')
      for (var r = 0; r < 3; r++) { var prow = el('span', 'fxc-style-mini-row'); for (var c = 0; c < 3; c++) { var pcell = el('span', 'fxc-style-mini-cell'); styleTableCell(pcell, preset, r, 3); prow.appendChild(pcell) } preview.appendChild(prow) }
      if (+preset.borderRadius) preview.style.borderRadius = '4px'
      button.appendChild(preview); button.appendChild(el('span', 'fxc-style-name', esc(name.toUpperCase())))
      button.onclick = action; return button
    }
    function showTableMenu (block, cell, x, y) {
      selectBlock(block.id); var row = +cell.dataset.row || 0, col = +cell.dataset.col || 0
      var styles = el('div', 'fxc-table-styles'); styles.appendChild(el('div', 'fxc-pop-label', 'TABLE STYLE'))
      var styleButtons = el('div', 'fxc-style-grid')
      Object.keys(TABLE_STYLES).forEach(function (name) { styleButtons.appendChild(tableStyleSwatch(name, block.tableStyle === name, function () { closePopover(); applyBlockChange(block, function () { var preset = TABLE_STYLES[name]; block.tableStyle = name; Object.keys(preset).forEach(function (key) { block[key] = preset[key] }) }) })) }); styles.appendChild(styleButtons)
      openMenu(x, y, 'TABLE CELL', [
        menuItem('INSERT ROW ABOVE', function () { tableRow(block, row, false) }), menuItem('INSERT ROW BELOW', function () { tableRow(block, row + 1, false) }), null,
        menuItem('INSERT COLUMN LEFT', function () { tableColumn(block, col, false) }), menuItem('INSERT COLUMN RIGHT', function () { tableColumn(block, col + 1, false) }), null,
        menuItem('DELETE ROW', function () { tableRow(block, row, true) }, '', true), menuItem('DELETE COLUMN', function () { tableColumn(block, col, true) }, '', true), null,
        menuItem('DISTRIBUTE COLUMNS EVENLY', function () { applyBlockChange(block, function () { var equal = []; for (var i = 0; i < block.cols; i++) equal.push(100 / block.cols); block.colWidths = equal }) }),
        { node: styles }, null, menuItem('DELETE TABLE', function () { removeBlock(block.id) }, '', true)
      ])
    }
    // Insert caps mirror notes.js validateCanvasData (rows <= 100, cols <= 30);
    // past them the saved canvas would no longer open.
    function tableRow (block, index, remove) {
      if (!remove && block.rows >= 100) return
      applyBlockChange(block, function () {
        block.cells = block.cells || []
        if (remove) { if (block.rows <= 1) return; block.cells.splice(index, 1); block.rows-- } else { block.cells.splice(index, 0, Array(+block.cols || 1).fill('')); block.rows++ }
      })
    }
    function tableColumn (block, index, remove) {
      if (!remove && block.cols >= 30) return
      applyBlockChange(block, function () {
        if (remove && block.cols <= 1) return
        var widths = colWidthsPct(block).map(function (percent) { return percent * block.w / 100 })
        block.cells.forEach(function (row) { if (remove) row.splice(index, 1); else row.splice(index, 0, '') }); block.cols += remove ? -1 : 1
        if (remove) widths.splice(index, 1)
        else widths.splice(index, 0, Math.max(60, Math.min(160, Math.round(block.w / (block.cols - 1)) || 120)))
        block.w = Math.max(60, widths.reduce(function (sum, width) { return sum + width }, 0))
        block.colWidths = widths.map(function (width) { return width / block.w * 100 })
      })
    }
    function selectedRangeIn (node) { var selection = window.getSelection(); if (!selection || selection.isCollapsed || !selection.rangeCount) return null; var range = selection.getRangeAt(0); return node.contains(range.commonAncestorContainer) ? range : null }
    function maybeShowTextTools (content, block) {
      setTimeout(function () {
        var range = selectedRangeIn(content); if (!range) return
        savedRange = range.cloneRange(); var rect = range.getBoundingClientRect(); showTextTools(block, content, rect.left + rect.width / 2, rect.top - 8)
      }, 0)
    }
    function showTextTools (block, content, x, y) {
      var range = savedRange
      function command (cmd, value) {
        snapshot(); var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand(cmd, false, value || null); inkHighlights(content)
        if (content.matches('td')) { var row = +content.dataset.row || 0, col = +content.dataset.col || 0; block.cells[row][col] = content.innerHTML } else block.content = content.innerHTML
        syncBlockHeight(block, content.closest('.fxc-block')); renderOverlay(); commit(); range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : range; savedRange = range
      }
      closePopover(); savedRange = range; popover = el('div', 'fxc-popover fxc-text-tools'); popover.setAttribute('role', 'toolbar'); popover.setAttribute('aria-label', 'TEXT FORMATTING')
      function toolButton (label, title, cmd, arg, style) { var button = controlButton(label, function () { command(cmd, arg) }); button.title = title; if (style) button.style.cssText = style; button.addEventListener('pointerdown', function (event) { event.preventDefault() }); popover.appendChild(button) }
      function toolSep () { popover.appendChild(el('span', 'fxc-tt-sep')) }
      function colorControl (glyph, title, initial, cmd) {
        var wrap = el('label', 'fxc-tt-color'); wrap.title = title
        wrap.appendChild(el('span', 'fxc-tt-color-glyph', glyph))
        var input = document.createElement('input'); input.type = 'color'; input.value = initial
        input.addEventListener('pointerdown', function (event) { event.stopPropagation() })
        input.oninput = function () { command(cmd, input.value) }
        wrap.appendChild(input); popover.appendChild(wrap)
      }
      toolButton('B', 'BOLD', 'bold', null, 'font-weight:900'); toolButton('I', 'ITALIC', 'italic', null, 'font-style:italic'); toolButton('U', 'UNDERLINE', 'underline', null, 'text-decoration:underline'); toolButton('S', 'STRIKETHROUGH', 'strikeThrough', null, 'text-decoration:line-through')
      toolSep()
      toolButton('H1', 'HEADING 1', 'formatBlock', 'h1'); toolButton('H2', 'HEADING 2', 'formatBlock', 'h2'); toolButton('H3', 'HEADING 3', 'formatBlock', 'h3')
      toolSep()
      toolButton('• LIST', 'BULLET LIST', 'insertUnorderedList'); toolButton('1. LIST', 'NUMBERED LIST', 'insertOrderedList'); toolButton('❝', 'QUOTE', 'formatBlock', 'blockquote')
      toolSep()
      var link = controlButton('LINK', function () { var url = safeUrl(window.prompt('ENTER LINK URL'), false); if (url) command('createLink', url) }); link.title = 'INSERT LINK'; link.addEventListener('pointerdown', function (event) { event.preventDefault() }); popover.appendChild(link)
      colorControl('A', 'TEXT COLOR', '#0f1720', 'foreColor')
      colorControl('▰', 'HIGHLIGHT COLOR', '#faef5a', 'hiliteColor')
      toolSep()
      var clear = controlButton('CLEAR', function () { command('removeFormat') }); clear.title = 'CLEAR FORMATTING'; clear.addEventListener('pointerdown', function (event) { event.preventDefault() }); popover.appendChild(clear)
      document.body.appendChild(popover)
      // Prefer above the selection; flip below it when it would cover the toolbar / leave the window.
      var top = y - popover.offsetHeight
      var vpTop = vp.getBoundingClientRect().top
      if (top < Math.max(8, vpTop + 4)) { var rect = range && range.getBoundingClientRect ? range.getBoundingClientRect() : null; top = (rect ? rect.bottom : y) + 10 }
      positionPopover(popover, x - popover.offsetWidth / 2, top)
    }

    function blockPointerDown (event, block) {
      if (readonly || tool !== 'select' || event.button !== 0) return
      var interactive = event.target.closest('input,textarea,button,[contenteditable="true"]')
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.stopPropagation(); selectBlock(block.id, true); return }
      if (!isSelected(block.id)) selectBlock(block.id); if (interactive) return
      if ((block.type === 'image' && !block.isBackground) || block.type === 'draw' || block.type === 'line') beginMove(event, block)
    }
    function beginMove (event, block) {
      event.preventDefault(); event.stopPropagation(); if (!isSelected(block.id)) selectBlock(block.id); snapshot(); vp.setPointerCapture(event.pointerId)
      var point = toWorld(event.clientX, event.clientY)
      gesture = { type: 'move', pointerId: event.pointerId, id: block.id, sx: point.x, sy: point.y, before: JSON.stringify(blocks), originals: selectedBlocks().map(function (target) { return { id: target.id, x: target.x, y: target.y } }) }
    }
    function startResize (event, block, handle) {
      snapshot(); vp.setPointerCapture(event.pointerId); var point = toWorld(event.clientX, event.clientY), v = visibleRect(block)
      gesture = { type: 'resize', pointerId: event.pointerId, id: block.id, handle: handle, sx: point.x, sy: point.y, before: JSON.stringify(blocks), x: v.x, y: v.y, w: v.w, h: v.h }
    }
    function startScrollDrag (event) { vp.setPointerCapture(event.pointerId); gesture = { type: 'scrollpan', pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, scrollLeft: vp.scrollLeft, scrollTop: vp.scrollTop } }
    function startMarquee (event, point) { vp.setPointerCapture(event.pointerId); gesture = { type: 'marquee', pointerId: event.pointerId, sx: point.x, sy: point.y, x: point.x, y: point.y, moved: false, additive: !!(event.ctrlKey || event.metaKey || event.shiftKey), originalSelection: selectedIds.slice() } }
    function startColResize (event, block, col) {
      event.preventDefault(); event.stopPropagation(); if (!isSelected(block.id)) selectBlock(block.id)
      snapshot(); vp.setPointerCapture(event.pointerId)
      var widths = colWidthsPct(block).map(function (percent) { return percent * block.w / 100 })
      gesture = { type: 'colresize', pointerId: event.pointerId, id: block.id, col: col, sx: toWorld(event.clientX, event.clientY).x, sy: 0, widths: widths, before: JSON.stringify(blocks) }
    }
    function marqueeArea (state) { return { x: Math.min(state.sx, state.x), y: Math.min(state.sy, state.y), w: Math.abs(state.x - state.sx), h: Math.abs(state.y - state.sy) } }
    function startDraw (event, point) {
      vp.setPointerCapture(event.pointerId); snapshot()
      draw = { pointerId: event.pointerId, type: tool === 'pen' ? 'draw' : 'line', points: [[point.x, point.y], [point.x, point.y]], strokeColor: color, strokeWidth: stroke }
    }

    function beginLongPress (event) {
      if (!readonly && event.pointerType === 'touch' && Object.keys(pointers).length === 1) {
        if (event.target.closest('input,textarea,[contenteditable="true"]')) return
        var pressTarget = event.target.closest('.fxc-block'), pressCell = event.target.closest('td')
        longPress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, target: pressTarget, cell: pressCell }
        longPress.timer = setTimeout(function () {
          if (!longPress || longPress.pointerId !== event.pointerId) return
          var block = pressTarget && byId(pressTarget.dataset.id)
          if (block && pressCell && block.type === 'table') showTableMenu(block, pressCell, longPress.x, longPress.y)
          else if (block) showBlockMenu(block, longPress.x, longPress.y)
          else { selectBlock(null); showInsertMenu(longPress.x, longPress.y) }
          longPress.fired = true; gesture = null; draw = null
          if (navigator.vibrate) navigator.vibrate(20)
        }, 550)
      }
    }
    vp.addEventListener('pointerdown', function (event) {
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY }
      if (Object.keys(pointers).length > 1 && longPress) { clearTimeout(longPress.timer); longPress = null }
      beginLongPress(event)
    }, { capture: true })
    vp.addEventListener('pointerdown', function (event) {
      if (popover && !popover.contains(event.target)) closePopover()
      if (Object.keys(pointers).length === 2) { var values = Object.keys(pointers).map(function (key) { return pointers[key] }); pinch = { distance: distance(values[0], values[1]), zoom: zoom, changed: false }; gesture = null; draw = null; return }
      if (readonly) return // native scroll + text selection
      if (event.button === 1 || spaceHeld) { event.preventDefault(); startScrollDrag(event); return }
      if (event.target.closest('.fxc-block,.fxc-handle,.fxc-colgrip')) return
      var point = toWorld(event.clientX, event.clientY)
      if (tool === 'select') {
        if (event.button !== 0) return
        var additive = !!(event.ctrlKey || event.metaKey || event.shiftKey)
        if (!additive) selectBlock(null)
        // Touch pans natively; a stationary tap on empty page creates a text container.
        if (event.pointerType === 'touch') { gesture = { type: 'tap', pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, create: !additive } ; return }
        startMarquee(event, point); gesture.clickCreate = !additive
        return
      }
      if (tool === 'text' || tool === 'todo' || tool === 'table' || tool === 'code') { event.preventDefault(); createAt(tool, point); return }
      if (tool === 'pen' || tool === 'line') { event.preventDefault(); startDraw(event, point) }
    })
    vp.addEventListener('pointermove', function (event) {
      if (pointers[event.pointerId]) { pointers[event.pointerId].x = event.clientX; pointers[event.pointerId].y = event.clientY }
      if (longPress && longPress.pointerId === event.pointerId && distance({ x: event.clientX, y: event.clientY }, longPress) > 10) { clearTimeout(longPress.timer); longPress = null }
      if (pinch && Object.keys(pointers).length === 2) { var values = Object.keys(pointers).map(function (key) { return pointers[key] }), d = distance(values[0], values[1]); zoom = Math.max(.2, Math.min(4, pinch.zoom * d / pinch.distance)); pinch.changed = pinch.changed || zoom !== pinch.zoom; render(); return }
      if (draw && draw.pointerId === event.pointerId) { var drawPoint = toWorld(event.clientX, event.clientY); if (draw.type === 'draw') draw.points.push([drawPoint.x, drawPoint.y]); else draw.points[1] = [drawPoint.x, drawPoint.y]; drawLive(); return }
      if (!gesture || gesture.pointerId !== event.pointerId) return
      if (gesture.type === 'tap') return
      if (gesture.type === 'scrollpan') { vp.scrollLeft = gesture.scrollLeft - (event.clientX - gesture.clientX); vp.scrollTop = gesture.scrollTop - (event.clientY - gesture.clientY); return }
      if (gesture.type === 'marquee') { var marqueePoint = toWorld(event.clientX, event.clientY); gesture.x = marqueePoint.x; gesture.y = marqueePoint.y; gesture.moved = gesture.moved || Math.hypot(gesture.x - gesture.sx, gesture.y - gesture.sy) >= 4; if (gesture.moved) { var area = marqueeArea(gesture), hits = blocks.filter(function (item) { return item.x < area.x + area.w && item.x + item.w > area.x && item.y < area.y + area.h && item.y + item.h > area.y }).map(function (item) { return item.id }); selectedIds = gesture.additive ? gesture.originalSelection.concat(hits.filter(function (item) { return gesture.originalSelection.indexOf(item) < 0 })) : hits; selected = selectedIds[selectedIds.length - 1] || null; render() }; return }
      var point = toWorld(event.clientX, event.clientY), block = byId(gesture.id); if (!block) return
      var dx = point.x - gesture.sx, dy = point.y - gesture.sy
      if (gesture.type === 'colresize') {
        var widths = gesture.widths.slice()
        if (gesture.col < widths.length - 1) {
          // Interior border: shift space between the two adjacent columns; table width stays fixed.
          var shift = Math.max(-(gesture.widths[gesture.col] - 36), Math.min(gesture.widths[gesture.col + 1] - 36, dx))
          widths[gesture.col] = gesture.widths[gesture.col] + shift
          widths[gesture.col + 1] = gesture.widths[gesture.col + 1] - shift
        } else {
          // Last border: resize the final column, which changes the table width.
          widths[gesture.col] = Math.max(36, gesture.widths[gesture.col] + dx)
        }
        block.w = widths.reduce(function (sum, width) { return sum + width }, 0)
        block.colWidths = widths.map(function (width) { return width / block.w * 100 })
      } else if (gesture.type === 'move') { gesture.originals.forEach(function (original) { var target = byId(original.id); if (!target || target.isBackground) return; target.x = original.x + dx; target.y = original.y + dy; clampBlockY(target) }) }
      else { resizeBlock(block, gesture, dx, dy) }
      render()
    })
    function endPointer (event) {
      if (longPress && longPress.pointerId === event.pointerId) { var fired = longPress.fired; clearTimeout(longPress.timer); longPress = null; if (fired) { delete pointers[event.pointerId]; return } }
      delete pointers[event.pointerId]; if (pinch && Object.keys(pointers).length < 2) { var pinchChanged = pinch.changed; pinch = null; if (pinchChanged) commit() }
      if (draw && draw.pointerId === event.pointerId) { finishDraw(); return }
      if (!gesture || gesture.pointerId !== event.pointerId) return
      var finished = gesture; gesture = null
      if (finished.type === 'tap') { if (finished.create && !readonly && Math.hypot(event.clientX - finished.clientX, event.clientY - finished.clientY) < 8) createAt('text', toWorld(event.clientX, event.clientY), true); return }
      if (finished.type === 'marquee') {
        if (!finished.moved && finished.clickCreate && !readonly) { createAt('text', toWorld(event.clientX, event.clientY), true); return }
        render(); return
      }
      if (finished.type === 'scrollpan') return
      render(); commit() // re-render with gesture cleared so the page grows to fit moved/resized content
    }
    vp.addEventListener('pointerup', endPointer)
    vp.addEventListener('pointercancel', function (event) {
      if (longPress) { clearTimeout(longPress.timer); longPress = null }
      delete pointers[event.pointerId]; pinch = null
      if (gesture && gesture.pointerId === event.pointerId && gesture.before) { blocks = JSON.parse(gesture.before).map(normalize); if (undo.length) undo.pop() }
      if (draw && draw.pointerId === event.pointerId && undo.length) undo.pop()
      gesture = null; draw = null; render()
    })
    vp.addEventListener('wheel', function (event) {
      // Plain wheel = native page scroll (OneNote-style). Ctrl/Cmd+wheel = zoom.
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.08 : 1 / 1.08, event.clientX, event.clientY) }
    }, { passive: false })
    vp.addEventListener('contextmenu', function (event) { if (readonly || event.target.closest('.fxc-block')) return; event.preventDefault(); selectBlock(null); showInsertMenu(event.clientX, event.clientY) })
    vp.addEventListener('mouseup', function (event) {
      if (readonly || event.button !== 0) return
      var content = event.target.closest('.fxc-text-content,td'), blockNode = event.target.closest('.fxc-block'), block = blockNode && byId(blockNode.dataset.id)
      if (content && block && selectedRangeIn(content)) maybeShowTextTools(content, block)
    })
    vp.addEventListener('dragover', function (event) { if (!readonly && firstImageFile(event.dataTransfer && event.dataTransfer.files)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } })
    vp.addEventListener('drop', function (event) { var file = firstImageFile(event.dataTransfer && event.dataTransfer.files); if (!file || readonly) return; event.preventDefault(); insertImageFile(file, toWorld(event.clientX, event.clientY)) })
    vp.addEventListener('paste', function (event) { var file = firstImageFile(event.clipboardData && event.clipboardData.files); if (!file || readonly || event.target.closest('input,textarea,[contenteditable="true"]')) return; event.preventDefault(); var rect = vp.getBoundingClientRect(); insertImageFile(file, toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)) })
    function firstImageFile (files) { return Array.prototype.slice.call(files || []).filter(function (file) { return file && /^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.type || '') })[0] || null }

    function resizeBlock (block, state, dx, dy) {
      var minW = 60, minH = 36, image = block.type === 'image'
      if (image) { block.x = state.x; block.y = state.y; block.w = state.w; block.h = state.h } // resize the visible (cropped) rect, then map it back to the full box below
      if (image && state.handle.length === 2) {
        var ratio = state.w / state.h, widthDelta = state.handle.indexOf('w') >= 0 ? -dx : dx, heightDelta = state.handle.indexOf('n') >= 0 ? -dy : dy
        var width = Math.max(minW, Math.abs(widthDelta) >= Math.abs(heightDelta * ratio) ? state.w + widthDelta : (state.h + heightDelta) * ratio), height = width / ratio
        block.w = width; block.h = height
        if (state.handle.indexOf('w') >= 0) block.x = state.x + state.w - width
        if (state.handle.indexOf('n') >= 0) block.y = state.y + state.h - height
      } else {
        if (state.handle.indexOf('e') >= 0) block.w = Math.max(minW, state.w + dx)
        if (state.handle.indexOf('s') >= 0) block.h = Math.max(minH, state.h + dy)
        if (state.handle.indexOf('w') >= 0) { block.w = Math.max(minW, state.w - dx); block.x = state.x + state.w - block.w }
        if (state.handle.indexOf('n') >= 0) { block.h = Math.max(minH, state.h - dy); block.y = state.y + state.h - block.h }
      }
      if (image) { var c = cropInsets(block); block.w /= 1 - c.l - c.r; block.h /= 1 - c.t - c.b; block.x -= block.w * c.l; block.y -= block.h * c.t }
      clampBlockY(block)
    }
    function distance (a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }
    function drawLive () {
      overlay.innerHTML = ''; var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'fxc-live'); svg.style.left = '0px'; svg.style.top = '0px'
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path'), d = draw.points.map(function (p, index) { return (index ? 'L' : 'M') + p[0] * zoom + ' ' + p[1] * zoom }).join(' ')
      path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', draw.strokeColor); path.setAttribute('stroke-width', draw.strokeWidth * zoom); path.setAttribute('stroke-linecap', 'round'); svg.appendChild(path); overlay.appendChild(svg)
    }
    function finishDraw () {
      var current = draw; draw = null; overlay.innerHTML = ''; if (!current || current.points.length < 2) { render(); return }
      var xs = current.points.map(function (p) { return p[0] }), ys = current.points.map(function (p) { return p[1] }), minX = Math.min.apply(null, xs), minY = Math.min.apply(null, ys), maxX = Math.max.apply(null, xs), maxY = Math.max.apply(null, ys)
      var block
      minY = Math.max(0, minY); maxY = Math.min(CANVAS_MAX_Y, maxY)
      if (current.type === 'draw') { var pathData = current.points.map(function (p, index) { return (index ? 'L' : 'M') + (p[0] - minX) + ',' + (Math.max(0, Math.min(CANVAS_MAX_Y, p[1])) - minY) }).join(' '); block = addBlock({ type: 'draw', x: minX, y: minY, w: Math.max(4, maxX - minX), h: Math.max(4, maxY - minY), pathData: pathData, strokeColor: current.strokeColor, strokeWidth: current.strokeWidth }) }
      else block = addBlock({ type: 'line', x: minX, y: minY, w: Math.max(4, maxX - minX), h: Math.max(4, maxY - minY), lx1: current.points[0][0] - minX, ly1: Math.max(0, Math.min(CANVAS_MAX_Y, current.points[0][1])) - minY, lx2: current.points[1][0] - minX, ly2: Math.max(0, Math.min(CANVAS_MAX_Y, current.points[1][1])) - minY, strokeColor: current.strokeColor, strokeWidth: current.strokeWidth, arrowMode: 'end' })
      render(); selectBlock(block.id); commit(); if (current.type === 'line') setTool('select')
    }

    function snapshot () { undo.push(JSON.stringify(blocks)); if (undo.length > 80) undo.shift(); redo = [] }
    function rebuildProvisionals () { provisionalText = {}; blocks.forEach(function (block) { if (block.type === 'text' && !String(block.content || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim()) provisionalText[block.id] = true }) }
    function doUndo () { if (!undo.length) return; redo.push(JSON.stringify(blocks)); blocks = JSON.parse(undo.pop()).map(normalize); rebuildProvisionals(); selectedIds = []; selected = null; render(); commit() }
    function doRedo () { if (!redo.length) return; undo.push(JSON.stringify(blocks)); blocks = JSON.parse(redo.pop()).map(normalize); rebuildProvisionals(); selectedIds = []; selected = null; render(); commit() }
    function scheduleCommit () { if (!dirtyPending) { dirtyPending = true; onDirty() }; clearTimeout(changeTimer); changeTimer = setTimeout(commit, 350) }
    function commit () { clearTimeout(changeTimer); changeTimer = null; if (destroyed) { dirtyPending = false; return }; if (!dirtyPending) onDirty(); dirtyPending = false; onChange(getData()) }
    function flush (notify) { if (!changeTimer && !dirtyPending) return; clearTimeout(changeTimer); changeTimer = null; dirtyPending = false; if (notify !== false && !destroyed) onChange(getData()) }
    function getData () { var result = clone(source); result.blocks = clone(blocks.filter(function (block) { return !provisionalText[block.id] })); result.nextId = nextId; result.maxZ = maxZ; result.zoom = zoom; result.panX = 0; result.panY = 0; return result }

    function onKeyDown (event) {
      if (readonly) return
      var editing = document.activeElement && document.activeElement.closest && document.activeElement.closest('input,textarea,[contenteditable="true"]')
      if (event.key === 'Escape' && popover) { event.preventDefault(); closePopover(); vp.focus(); return }
      if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault(); var active = document.activeElement, node = active && active.closest && active.closest('.fxc-block'), block = node && byId(node.dataset.id)
        if (block) { var cell = active.closest('td'), textTarget = active.closest('.fxc-text-content,td'), range = textTarget && selectedRangeIn(textTarget), rect = (range && range.getBoundingClientRect()) || (cell || node).getBoundingClientRect(); if (range) { savedRange = range.cloneRange(); showTextTools(block, textTarget, rect.left + rect.width / 2, rect.top - 8) } else if (cell && block.type === 'table') showTableMenu(block, cell, rect.left + 16, rect.top + 16); else showBlockMenu(block, rect.left + 16, rect.top + 16) }
        else { var vpRect = vp.getBoundingClientRect(); showInsertMenu(vpRect.left + vpRect.width / 2, vpRect.top + vpRect.height / 2) }
        return
      }
      if (event.code === 'Space' && !editing) { event.preventDefault(); spaceHeld = true; vp.classList.add('is-pan-ready') }
      if (editing) return
      if (event.key === 'Escape') { event.preventDefault(); if (tool !== 'select') setTool('select'); selectBlock(null); vp.focus(); return }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length) { event.preventDefault(); removeSelected() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? doRedo() : doUndo() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); doRedo() }
      if ((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')) { event.preventDefault(); zoomBy(1.2); return }
      if ((event.ctrlKey || event.metaKey) && event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selectedIds = blocks.filter(function (block) { return !provisionalText[block.id] }).map(function (block) { return block.id }); selected = selectedIds[selectedIds.length - 1] || null; render(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selectedIds.length) { event.preventDefault(); copyBlocks(selectedBlocks()) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x' && selectedIds.length) { event.preventDefault(); cutBlocks(selectedBlocks()) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && blockClipboard) { event.preventDefault(); pasteBlock() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && selectedIds.length) { event.preventDefault(); duplicateBlocks(selectedBlocks()) }
      if (selectedIds.length && /^Arrow(Left|Right|Up|Down)$/.test(event.key)) { event.preventDefault(); snapshot(); var amount = event.shiftKey ? 10 : 1, dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0; selectedBlocks().forEach(function (block) { block.x += dx; block.y += dy; clampBlockY(block) }); render(); commit(); return }
      var keys = { v: 'select', t: 'text', i: 'image', o: 'todo', b: 'table', c: 'code', p: 'pen', l: 'line' }; if (keys[event.key] && !event.ctrlKey && !event.metaKey) setTool(keys[event.key])
    }
    function onKeyUp (event) { if (event.code === 'Space') { spaceHeld = false; vp.classList.remove('is-pan-ready') } }
    document.addEventListener('keydown', onKeyDown, { signal: signal }); document.addEventListener('keyup', onKeyUp, { signal: signal })
    document.addEventListener('pointerdown', function (event) { if (popover && !popover.contains(event.target) && !vp.contains(event.target)) closePopover() }, { signal: signal })
    window.addEventListener('blur', closePopover, { signal: signal }); window.addEventListener('resize', function () { closePopover(); render() }, { signal: signal })

    setTool('select'); render()
    return { getData: getData, flush: flush, destroy: function () { flush(false); destroyed = true; closePopover(); if (longPress) clearTimeout(longPress.timer); ac.abort(); clearTimeout(changeTimer); clearTimeout(editSnapshotTimer); container.innerHTML = '' } }
  }

  window.FxCanvas = { mount: mount, inkHighlights: inkHighlights }
})()
