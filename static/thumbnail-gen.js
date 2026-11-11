// Client-side thumbnail rendering (images, video frames, text/code previews).
// Not crypto: it is published as OneGyCrypto.generateThumbnail so callers keep
// one namespace. Load it right after crypto.js.
;(function () {
  'use strict'

  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']
  const TEXT_EXTS = ['txt', 'md', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'py', 'js', 'mjs', 'cjs', 'html', 'htm', 'css', 'scss', 'less', 'sh', 'bash', 'zsh', 'ini', 'cfg', 'conf', 'c', 'cpp', 'h', 'hpp', 'cs', 'lua', 'rb', 'rs', 'go', 'java', 'ts', 'tsx', 'jsx', 'toml', 'bat', 'ps1', 'sql', 'r', 'swift', 'kt', 'php', 'pl', 'diff', 'patch', 'makefile', 'env']
  const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v', '3gp']
  const COMPOUND_PREFIXES = ['tar']

  // GitHub Dark colors — matching github-dark.min.css rules (enhanced)
  const HLJS_COLORS = {
    'hljs-keyword':    '#ff7b72',
    'hljs-doctag':     '#ff7b72',
    'hljs-template-tag':'#ff7b72',
    'hljs-template-variable':'#ff7b72',
    'hljs-type':       '#ff7b72',
    'hljs-title':      '#d2a8ff',
    'hljs-title.class_':'#d2a8ff',
    'hljs-title.function_':'#d2a8ff',
    'hljs-attr':       '#79c0ff',
    'hljs-attribute':  '#79c0ff',
    'hljs-literal':    '#79c0ff',
    'hljs-meta':       '#79c0ff',
    'hljs-number':     '#79c0ff',
    'hljs-operator':   '#79c0ff',
    'hljs-selector-attr':'#79c0ff',
    'hljs-selector-class':'#79c0ff',
    'hljs-selector-id':'#79c0ff',
    'hljs-variable':   '#79c0ff',
    'hljs-property':   '#79c0ff',
    'hljs-string':     '#a5d6ff',
    'hljs-regexp':     '#a5d6ff',
    'hljs-built_in':   '#ffa657',
    'hljs-symbol':     '#ffa657',
    'hljs-comment':    '#8b949e',
    'hljs-code':       '#8b949e',
    'hljs-formula':    '#8b949e',
    'hljs-punctuation':'#8b949e',
    'hljs-name':       '#7ee787',
    'hljs-quote':      '#7ee787',
    'hljs-selector-pseudo':'#7ee787',
    'hljs-selector-tag':'#7ee787',
    'hljs-tag':        '#7ee787',
    'hljs-subst':      '#c9d1d9',
    'hljs-params':     '#c9d1d9',
    'hljs-section':    '#1f6feb',
    'hljs-bullet':     '#f2cc60',
    'hljs-link':       '#a5d6ff',
    'hljs-addition':   '#aff5b4',
    'hljs-deletion':   '#ffdcd7'
  }
  const DEFAULT_COLOR = '#c9d1d9'

  // Text layout of the 200x140 code panel.
  const TEXT_MAX_CHARS = 35
  const TEXT_MAX_LINES = 10
  const TEXT_X = 8
  const TEXT_LINE_HEIGHT = 13

  function _thumbExt(name) {
    const parts = name.split('.')
    if (parts.length >= 3 && COMPOUND_PREFIXES.includes(parts[parts.length - 2].toLowerCase())) {
      return (parts[parts.length - 2] + '.' + parts[parts.length - 1]).toLowerCase()
    }
    return parts[parts.length - 1].toLowerCase()
  }

  function _isDotenv(name, ext) {
    const baseName = (name || '').split(/[/\\]/).pop().toLowerCase()
    return baseName === '.env' || baseName.indexOf('.env.') === 0 || ext === 'env'
  }

  // Draws `source` (an <img> or <video>) scaled to fit maxDim and resolves a JPEG.
  function _drawScaledJpeg(source, w, h, maxDim, done) {
    if (w > maxDim || h > maxDim) {
      const ratio = Math.min(maxDim / w, maxDim / h)
      w = Math.round(w * ratio)
      h = Math.round(h * ratio)
    }
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(source, 0, 0, w, h)
    canvas.toBlob(done, 'image/jpeg', 0.75)
  }

  function _imageThumbnail(file, maxDim, resolve) {
    // Skip very large images (> 50MB) to avoid memory issues
    if (file.size > 50 * 1024 * 1024) {
      resolve(null)
      return
    }
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      _drawScaledJpeg(img, img.naturalWidth, img.naturalHeight, maxDim, (blob) => {
        resolve(blob)
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  }

  // Captures a frame at ~2s using a browser <video> + <canvas>.
  function _videoThumbnail(file, maxDim, resolve) {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    const url = URL.createObjectURL(file)
    let resolved = false

    const cleanup = () => {
      if (!resolved) {
        resolved = true
        URL.revokeObjectURL(url)
        video.removeAttribute('src')
        video.load()
      }
    }

    // Timeout: if metadata/seek takes too long (15s), give up
    const timeout = setTimeout(() => {
      cleanup()
      resolve(null)
    }, 15000)

    video.onloadedmetadata = () => {
      // Seek to 2s or start if video is shorter
      const seekTarget = video.duration > 2 ? 2 : 0
      video.currentTime = seekTarget
    }

    video.onseeked = () => {
      clearTimeout(timeout)
      try {
        const w = video.videoWidth
        const h = video.videoHeight
        if (!w || !h) { cleanup(); resolve(null); return }
        _drawScaledJpeg(video, w, h, maxDim, (blob) => {
          cleanup()
          resolve(blob)
        })
      } catch (e) {
        cleanup()
        resolve(null)
      }
    }

    video.onerror = () => {
      clearTimeout(timeout)
      cleanup()
      resolve(null)
    }

    video.src = url
  }

  // Parse hljs HTML output into [{text, color}] segments
  function _parseHljsHtml(html) {
    const segments = []
    // Match <span class="...">text</span> or plain text between spans
    // hljs output can have nested spans so we track a color stack
    const colorStack = [DEFAULT_COLOR]
    let i = 0
    while (i < html.length) {
      if (html[i] === '<') {
        const closeMatch = html.substring(i).match(/^<\/span>/)
        if (closeMatch) {
          if (colorStack.length > 1) colorStack.pop()
          i += closeMatch[0].length
          continue
        }
        const openMatch = html.substring(i).match(/^<span class="([^"]*)"[^>]*>/)
        if (openMatch) {
          colorStack.push(_spanColor(openMatch[1]) || colorStack[colorStack.length - 1])
          i += openMatch[0].length
          continue
        }
        // Unknown tag, skip it
        const tagEnd = html.indexOf('>', i)
        i = tagEnd >= 0 ? tagEnd + 1 : i + 1
        continue
      }
      // Find next tag or end of string
      let end = html.indexOf('<', i)
      if (end < 0) end = html.length
      const raw = html.substring(i, end)
      // Decode HTML entities
      const decoded = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
      if (decoded) segments.push({ text: decoded, color: colorStack[colorStack.length - 1] })
      i = end
    }
    return segments
  }

  // Color for the most specific class of an hljs span, or null.
  function _spanColor(classAttr) {
    const classes = classAttr.split(/\s+/)
    for (let ci = classes.length - 1; ci >= 0; ci--) {
      if (HLJS_COLORS[classes[ci]]) return HLJS_COLORS[classes[ci]]
    }
    // Try compound class (e.g. "hljs-title class_" -> "hljs-title.class_")
    if (classes.length >= 2) {
      const compound = classes[0] + '.' + classes[1]
      if (HLJS_COLORS[compound]) return HLJS_COLORS[compound]
    }
    return null
  }

  // Syntax-highlighted rendering, one monospace cell per character.
  function _drawHighlighted(ctx, text, lang) {
    const result = hljs.highlight(text, { language: lang, ignoreIllegals: true })
    const segments = _parseHljsHtml(result.value)
    // Measure monospace char width
    const charWidth = ctx.measureText('A').width
    let x = TEXT_X
    let y = 4
    let col = 0
    let lineCount = 0
    for (let si = 0; si < segments.length; si++) {
      if (lineCount >= TEXT_MAX_LINES || y > 130) break
      const seg = segments[si]
      ctx.fillStyle = seg.color
      for (let ci = 0; ci < seg.text.length; ci++) {
        if (lineCount >= TEXT_MAX_LINES || y > 130) break
        const ch = seg.text[ci]
        if (ch === '\n') {
          y += TEXT_LINE_HEIGHT
          x = TEXT_X
          col = 0
          lineCount++
          continue
        }
        if (ch === '\t') {
          const spaces = 4 - (col % 4)
          col += spaces
          x = TEXT_X + col * charWidth
          continue
        }
        if (col >= TEXT_MAX_CHARS) continue
        ctx.fillText(ch, x, y)
        col++
        x = TEXT_X + col * charWidth
      }
    }
  }

  // Monochrome rendering: no highlight.js, or it threw (drawn over whatever
  // the highlighted pass already painted).
  function _drawPlain(ctx, text) {
    ctx.fillStyle = DEFAULT_COLOR
    const lines = text.split('\n').slice(0, TEXT_MAX_LINES)
    let y = 4
    for (let i = 0; i < lines.length; i++) {
      if (y > 130) break
      const line = lines[i].length > TEXT_MAX_CHARS ? lines[i].substring(0, TEXT_MAX_CHARS) : lines[i]
      ctx.fillText(line, TEXT_X, y)
      y += TEXT_LINE_HEIGHT
    }
  }

  // Dark code panel; 200x140 matches the tile aspect ratio (no object-fit crop).
  function _renderTextThumb(text, lang, maxDim, resolve) {
    const thumbW = maxDim
    const thumbH = Math.round(maxDim * 0.7)
    const canvas = document.createElement('canvas')
    canvas.width = thumbW
    canvas.height = thumbH
    const ctx = canvas.getContext('2d')

    // Dark background matching server-side (#1a1a1a)
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, thumbW, thumbH)

    ctx.font = '10px "JetBrains Mono", monospace'
    ctx.textBaseline = 'top'

    const hasHljs = typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)
    if (hasHljs) {
      try {
        _drawHighlighted(ctx, text, lang)
      } catch (e) {
        _drawPlain(ctx, text)
      }
    } else {
      _drawPlain(ctx, text)
    }

    canvas.toBlob((blob) => {
      resolve(blob)
    }, 'image/jpeg', 0.8)
  }

  function _textThumbnail(file, lang, maxDim, resolve) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        _renderTextThumb((reader.result || '').substring(0, 2000), lang, maxDim, resolve)
      } catch (e) {
        resolve(null)
      }
    }
    reader.onerror = () => resolve(null)
    // Read only first 2KB for thumbnail, once highlight.js is available
    // (or known to be unavailable, which renders monochrome).
    OneGyCrypto.loadHighlighter().then(() => reader.readAsText(file.slice(0, 2048)))
  }

  /**
   * Generate a thumbnail from an image, video or text File object using Canvas.
   * Returns a JPEG Blob, or null if the file type has no thumbnail.
   * Max dimension: 200px (preserves aspect ratio).
   */
  function generateThumbnail(file, maxDim = 200) {
    return new Promise((resolve) => {
      const ext = _thumbExt(file.name)
      const isDotenv = _isDotenv(file.name, ext)
      if (IMAGE_EXTS.includes(ext)) {
        _imageThumbnail(file, maxDim, resolve)
      } else if (VIDEO_EXTS.includes(ext)) {
        _videoThumbnail(file, maxDim, resolve)
      } else if (TEXT_EXTS.includes(ext) || isDotenv) {
        _textThumbnail(file, isDotenv ? 'ini' : OneGyCrypto.highlightLanguage(ext), maxDim, resolve)
      } else {
        resolve(null)
      }
    })
  }

  OneGyCrypto.generateThumbnail = generateThumbnail
})()
