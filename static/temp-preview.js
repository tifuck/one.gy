// ─── Temp-Upload Page: Download Toast + File Preview ─────────────────
// Provides in-page E2E download with progress toast and file preview
// (image, audio, text) for the temp-upload page, using the guest's
// passphrase from sessionStorage for E2E decryption.

;(function() {
  'use strict'

  // ─── Constants ────────────────────────────────────────────────────
  const EDITOR_MAX_SIZE = 5 * 1024 * 1024  // 5 MB
  const HIGHLIGHT_DEBOUNCE_MS = 80

  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']
  const TEXT_EXTS = ['txt', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'py', 'js', 'html', 'css', 'sh', 'ini', 'cfg', 'conf', 'c', 'cpp', 'h', 'hpp', 'lua', 'rb', 'rs', 'go', 'java', 'ts', 'tsx', 'jsx', 'toml', 'bat', 'ps1', 'sql', 'r', 'swift', 'kt', 'php', 'pl', 'diff', 'makefile']
  const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']
  const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv']
  const PDF_EXTS = ['pdf']

  const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' }
  const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' }
  const VIDEO_MIME = { mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/quicktime', m4v: 'video/x-m4v', mkv: 'video/x-matroska' }

  const _SVG_AUDIO = '<svg class="audio-note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'

  // ─── Passphrase Helper ────────────────────────────────────────────
  function _getPassphrase() {
    try { return sessionStorage.getItem('e2e_passphrase') } catch (e) { return null }
  }

  // ─── Master Key Helper ──────────────────────────────────────────
  // Check if the current user has master key available (logged-in E2EE user)
  function _hasMasterKey() {
    return typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys()
  }

  function getCSRFToken() {
    const input = document.getElementById('csrf_token')
    if (input && input.value) return input.value
    const meta = document.querySelector('meta[name="csrf-token"]')
    return meta ? meta.getAttribute('content') || '' : ''
  }

  // ─── Passphrase Prompt ────────────────────────────────────────────
  // If passphrase is missing from the per-file keychain, prompt the user via unified overlay.
  function _promptPassphrase(signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) { resolve(null); return }
      // Build the unified E2EE prompt overlay dynamically
      var existing = document.getElementById('e2eePassphraseOverlay')
      if (existing) existing.remove()

      var overlay = document.createElement('div')
      overlay.id = 'e2eePassphraseOverlay'
      overlay.className = 'e2ee-prompt-overlay'
      overlay.innerHTML =
        '<div class="e2ee-prompt-backdrop"></div>' +
        '<div class="e2ee-prompt-card">' +
          '<button class="e2ee-prompt-dismiss" id="e2eePassDismiss" title="DISMISS">&times;</button>' +
          '<div class="e2ee-prompt-icon">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1"/></svg>' +
          '</div>' +
          '<div class="e2ee-prompt-divider"></div>' +
          '<div class="e2ee-prompt-title">PASSPHRASE REQUIRED</div>' +
          '<div class="e2ee-prompt-desc">ENTER YOUR E2E ENCRYPTION PASSPHRASE TO DECRYPT THIS FILE</div>' +
          '<div class="e2ee-prompt-form">' +
            '<div class="e2ee-prompt-input-wrap">' +
              '<input type="password" id="passphrasePromptInput" class="e2ee-prompt-input" placeholder="PASSPHRASE" autocomplete="off">' +
            '</div>' +
            '<button id="e2eePassDecryptBtn" class="e2ee-prompt-btn">' +
              '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 5-5 5 5 0 0 1 5 5v4"/></svg> ' +
              'DECRYPT' +
            '</button>' +
          '</div>' +
        '</div>'
      document.body.appendChild(overlay)

      var input = document.getElementById('passphrasePromptInput')
      var okBtn = document.getElementById('e2eePassDecryptBtn')
      var dismissBtn = document.getElementById('e2eePassDismiss')

      var settled = false
      setTimeout(function() { if (!settled && input && input.isConnected) input.focus() }, 100)

      var finish = function(val) {
        if (settled) return
        settled = true
        cleanup()
        overlay.remove()
        resolve(val)
      }

      var handleOk = function() {
        var val = input ? input.value.trim() : ''
        finish(val || null)
      }

      var handleCancel = function() {
        finish(null)
      }

      var handleKeydown = function(e) {
        if (e.key === 'Enter') { e.preventDefault(); handleOk() }
        if (e.key === 'Escape') { e.preventDefault(); handleCancel() }
      }

      var cleanup = function() {
        okBtn.removeEventListener('click', handleOk)
        dismissBtn.removeEventListener('click', handleCancel)
        document.removeEventListener('keydown', handleKeydown)
        if (signal) signal.removeEventListener('abort', handleCancel)
      }

      okBtn.addEventListener('click', handleOk)
      dismissBtn.addEventListener('click', handleCancel)
      document.addEventListener('keydown', handleKeydown)
      if (signal) signal.addEventListener('abort', handleCancel, { once: true })
    })
  }

  // Get passphrase, checking per-file keychain first, then legacy sessionStorage, then prompt.
  async function _ensurePassphrase(fileId, signal) {
    let pp = null
    // 1. Try per-file keychain first (always correct for the specific file)
    if (fileId && typeof TempKeychain !== 'undefined') {
      try {
        pp = await TempKeychain.get(fileId)
        if (pp) return pp
      } catch (e) {}
    }
    // 2. Fall back to legacy sessionStorage and migrate into the per-file keychain.
    pp = _getPassphrase()
    if (pp) {
      try { sessionStorage.removeItem('e2e_passphrase') } catch (e) {}
      return pp
    }
    // 3. Prompt the user
    pp = await _promptPassphrase(signal)
    return pp
  }

  // ─── Unified E2EE Decryption (master-key OR passphrase) ──────────
  // Fetches key info, determines wrapping mode, decrypts file data.
  // Returns decrypted ArrayBuffer or throws on failure.
  function _throwIfAborted(signal) {
    if (signal && signal.aborted) {
      var error = new Error('ABORTED')
      error.name = 'AbortError'
      throw error
    }
  }

  async function _decryptE2EEFile(fileId, encData, onProgress, signal) {
    _throwIfAborted(signal)
    var keyResp = await fetch('/f/' + fileId + '/key-info', signal ? { signal: signal } : undefined)
    if (!keyResp.ok) throw new Error('KEY FETCH FAILED')
    var keyInfo = await keyResp.json()
    _throwIfAborted(signal)
    if (!keyInfo.encrypted_file_key) throw new Error('FILE KEY NOT FOUND')

    if (keyInfo.file_key_salt) {
      // Passphrase-wrapped file key (guest upload)
      var passphrase = await _ensurePassphrase(fileId, signal)
      _throwIfAborted(signal)
      if (!passphrase) throw new Error('PASSPHRASE NOT AVAILABLE')
      try {
        var decrypted = await OneGyCrypto.decryptFileForGuestDownload(
          encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce,
          keyInfo.file_key_salt, passphrase, onProgress
        )
        _throwIfAborted(signal)
        if (fileId && typeof TempKeychain !== 'undefined') {
          TempKeychain.store(fileId, passphrase).catch(function() {})
        }
        return decrypted
      } catch (e) {
        if (fileId && typeof TempKeychain !== 'undefined' && e && e.name === 'OperationError') {
          TempKeychain.remove(fileId).catch(function() {})
        }
        throw e
      }
    } else if (_hasMasterKey()) {
      // Master-key-wrapped file key (logged-in user)
      var masterKey = await OneGyCrypto.getMasterKeyFromSession()
      _throwIfAborted(signal)
      if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')
      var decryptedWithMasterKey = await OneGyCrypto.decryptFileForDownload(
        encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce,
        masterKey, onProgress
      )
      _throwIfAborted(signal)
      return decryptedWithMasterKey
    } else {
      throw new Error('ENCRYPTION KEYS NOT AVAILABLE \u2014 LOG IN AGAIN')
    }
  }

  // ─── Download Toast ───────────────────────────────────────────────
  let _dlToastTimer = null

  function _getDlToastEls() {
    return {
      toast: document.getElementById('downloadProgress'),
      title: document.getElementById('downloadProgressTitle'),
      close: document.getElementById('downloadProgressClose'),
      fill: document.getElementById('downloadProgressFill'),
      status: document.getElementById('downloadProgressStatus'),
      percent: document.getElementById('downloadProgressPercent'),
      speed: document.getElementById('downloadProgressSpeed')
    }
  }

  function _showDownloadToast(titleText) {
    if (_dlToastTimer) { clearTimeout(_dlToastTimer); _dlToastTimer = null }
    const t = _getDlToastEls()
    if (!t.toast) return t
    t.title.textContent = titleText
    t.status.textContent = 'PREPARING...'
    t.percent.textContent = '0%'
    t.speed.textContent = '-'
    t.fill.style.width = '0%'
    t.fill.style.background = ''
    t.close.style.display = 'none'
    t.toast.style.display = 'block'
    return t
  }

  function _updateDownloadToast(t, status, pct, fileName, speed) {
    if (t.status) t.status.textContent = status
    if (t.fill) t.fill.style.width = Math.round(pct) + '%'
    if (t.percent) t.percent.textContent = Math.round(pct) + '%'
    if (fileName !== undefined && t.title) t.title.textContent = fileName
    if (speed !== undefined && t.speed) t.speed.textContent = speed
  }

  function _completeDownloadToast(t) {
    if (!t.toast) return
    t.title.textContent = 'DOWNLOAD COMPLETE'
    t.status.textContent = 'COMPLETE!'
    t.fill.style.width = '100%'
    t.fill.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)'
    t.percent.textContent = '100%'
    t.speed.textContent = 'DONE'
    t.close.style.display = 'block'
    t.close.onclick = () => _hideDownloadToast(t)
    _dlToastTimer = setTimeout(() => _hideDownloadToast(t), 2500)
  }

  function _errorDownloadToast(t, msg) {
    if (!t.toast) return
    t.title.textContent = 'DOWNLOAD FAILED'
    t.status.textContent = msg || 'FAILED'
    t.percent.textContent = 'ERROR'
    t.speed.textContent = '-'
    t.fill.style.width = '100%'
    t.fill.style.background = 'linear-gradient(90deg, #E8304A, #DE1833)'
    t.close.style.display = 'block'
    t.close.onclick = () => _hideDownloadToast(t)
    _dlToastTimer = setTimeout(() => _hideDownloadToast(t), 4000)
  }

  function _hideDownloadToast(t) {
    if (_dlToastTimer) { clearTimeout(_dlToastTimer); _dlToastTimer = null }
    if (!t.toast) return
    t.toast.style.display = 'none'
    t.fill.style.width = '0%'
    t.fill.style.background = ''
  }

  // ─── Blob Download Trigger ────────────────────────────────────────
  function _triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ─── Try decrypt filename from key-info ────────────────────────────
  async function _tryDecryptFileNameFromKeyInfo(fileId, keyInfo) {
    if (!keyInfo || !keyInfo.encrypted_name || !keyInfo.name_nonce) return null
    try {
      let fileKey = null
      if (keyInfo.file_key_salt) {
        const pp = await _ensurePassphrase(fileId)
        if (pp) fileKey = await OneGyCrypto.unwrapFileKeyWithPassphrase(keyInfo.encrypted_file_key, keyInfo.file_key_nonce, keyInfo.file_key_salt, pp)
      } else if (_hasMasterKey()) {
        const mk = await OneGyCrypto.getMasterKeyFromSession()
        if (mk) fileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(keyInfo.encrypted_file_key, keyInfo.file_key_nonce, mk)
      }
      if (fileKey) return await OneGyCrypto.decryptFileName(keyInfo.encrypted_name, keyInfo.name_nonce, fileKey)
    } catch (e) { /* non-critical */ }
    return null
  }

  // Decrypt the filename and thumbnail shown in the quick-share listing. The
  // server intentionally renders an encrypted filename placeholder; only this
  // browser has the passphrase needed to replace it with the real metadata.
  const _rowThumbUrls = []

  async function _hydrateTempUploadRows() {
    if (typeof OneGyCrypto === 'undefined') return

    const rows = document.querySelectorAll('.temp-browser-row[data-e2e="true"]')
    for (const row of rows) {
      const fileId = row.dataset.fileId
      if (!fileId || !row.dataset.encryptedFileKey || !row.dataset.fileKeyNonce) continue

      try {
        let fileKey = null
        if (row.dataset.fileKeySalt) {
          let passphrase = null
          if (typeof TempKeychain !== 'undefined') passphrase = await TempKeychain.get(fileId)
          if (!passphrase) passphrase = _getPassphrase()
          if (!passphrase) continue
          fileKey = await OneGyCrypto.unwrapFileKeyWithPassphrase(
            row.dataset.encryptedFileKey,
            row.dataset.fileKeyNonce,
            row.dataset.fileKeySalt,
            passphrase
          )
        } else if (_hasMasterKey()) {
          const masterKey = await OneGyCrypto.getMasterKeyFromSession()
          if (masterKey) {
            fileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(
              row.dataset.encryptedFileKey,
              row.dataset.fileKeyNonce,
              masterKey
            )
          }
        }
        if (!fileKey) continue

        if (row.dataset.encryptedName && row.dataset.nameNonce) {
          const realName = await OneGyCrypto.decryptFileName(
            row.dataset.encryptedName,
            row.dataset.nameNonce,
            fileKey
          )
          const dot = realName.lastIndexOf('.')
          const base = dot > 0 ? realName.slice(0, dot) : realName
          const suffix = dot > 0 ? realName.slice(dot) : ''
          const extension = suffix ? suffix.slice(1).toLowerCase() : ''
          const nameEl = row.querySelector('.file-name-text')
          if (nameEl) {
            nameEl.textContent = ''
            const baseEl = document.createElement('span')
            baseEl.className = 'file-name-base'
            baseEl.textContent = base
            nameEl.appendChild(baseEl)
            if (suffix) {
              const extEl = document.createElement('span')
              extEl.className = 'file-name-ext'
              extEl.textContent = suffix
              nameEl.appendChild(extEl)
            }
          }
          row.dataset.fileName = realName
          row.dataset.extension = extension
          row.dataset.previewable = [...IMAGE_EXTS, ...TEXT_EXTS, ...AUDIO_EXTS, ...VIDEO_EXTS, ...PDF_EXTS].includes(extension) ? 'true' : 'false'
          const deleteBtn = row.querySelector('.delete-temp-file-btn')
          if (deleteBtn) deleteBtn.dataset.filename = realName
          const downloadBtn = row.querySelector('.action-download')
          if (downloadBtn && !row.dataset.shortCode) {
            // AUDIT FIX F3: NEVER put the decrypted (plaintext) filename into a
            // server URL — /f/<id>/<name> sends the zero-knowledge name to
            // server access logs / proxies / Referer on middle-click, copy-link
            // or direct navigation. The filename path segment is optional
            // server-side (and ignored for file downloads); a normal click is
            // intercepted below by the delegated handler, which decrypts
            // client-side using row.dataset.fileName (DOM-only, never a URL).
            downloadBtn.href = '/f/' + encodeURIComponent(fileId)
          }
        }

        if (row.dataset.encThumbNonce) {
          const response = await fetch('/file/' + encodeURIComponent(fileId) + '/e2e-thumbnail')
          if (response.ok) {
            const decrypted = await OneGyCrypto.decryptThumbnail(
              await response.arrayBuffer(),
              row.dataset.encThumbNonce,
              fileKey
            )
            const url = URL.createObjectURL(new Blob([decrypted], { type: 'image/jpeg' }))
            _rowThumbUrls.push(url)
            const icon = row.querySelector('.file-icon-small')
            if (icon) {
              const img = new Image()
              img.className = 'file-thumbnail'
              img.alt = ''
              img.src = url
              icon.replaceWith(img)
            }
          }
        }
      } catch (e) {
        console.warn('[TEMP LIST] Could not decrypt listing metadata for ' + fileId, e)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _hydrateTempUploadRows, { once: true })
  } else {
    _hydrateTempUploadRows()
  }
  window.addEventListener('pagehide', () => _rowThumbUrls.forEach(URL.revokeObjectURL), { once: true })

  // ─── E2EE Download (master-key OR passphrase) ──────────────────────
  async function _e2eeDownloadFile(fileId, fileName) {
    const t = _showDownloadToast('DOWNLOADING FILE')
    _updateDownloadToast(t, 'LOADING KEY...', 2, fileName)

    try {
      if (typeof OneGyCrypto === 'undefined') {
        _errorDownloadToast(t, 'CRYPTO NOT AVAILABLE')
        return
      }

      // Try to decrypt real filename before download
      try {
        const kiResp = await fetch('/f/' + fileId + '/key-info')
        if (kiResp.ok) {
          const ki = await kiResp.json()
          const realName = await _tryDecryptFileNameFromKeyInfo(fileId, ki)
          if (realName) {
            fileName = realName
            _updateDownloadToast(t, 'LOADING KEY...', 2, fileName)
          }
        }
      } catch (e) { /* non-critical */ }

      _updateDownloadToast(t, 'DOWNLOADING...', 5, fileName, '-')

      // Fetch encrypted file with XHR for download progress
      const encData = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', '/f/' + fileId + '/encrypted', true)
        xhr.responseType = 'arraybuffer'
        let lastTime = Date.now(), lastLoaded = 0
        xhr.onprogress = (e) => {
          if (e.lengthComputable) {
            const dlPct = Math.round(5 + (e.loaded / e.total) * 55)
            const now = Date.now()
            const dt = (now - lastTime) / 1000
            let speedText = '-'
            if (dt > 0.2) {
              const bytesPerSec = (e.loaded - lastLoaded) / dt
              speedText = bytesPerSec >= 1048576
                ? (bytesPerSec / 1048576).toFixed(1) + ' MB/S'
                : Math.round(bytesPerSec / 1024) + ' KB/S'
              lastTime = now
              lastLoaded = e.loaded
            }
            const mb = (e.loaded / 1048576).toFixed(1)
            const totalMb = (e.total / 1048576).toFixed(1)
            _updateDownloadToast(t, 'DOWNLOADING ' + mb + ' / ' + totalMb + ' MB', dlPct, undefined, speedText)
          }
        }
        xhr.onload = () => {
          if (xhr.status === 200) resolve(xhr.response)
          else reject(new Error('HTTP ' + xhr.status))
        }
        xhr.onerror = () => reject(new Error('NETWORK ERROR'))
        xhr.send()
      })

      _updateDownloadToast(t, 'DECRYPTING...', 62, undefined, '-')

      const decrypted = await _decryptE2EEFile(fileId, encData, (pct) => {
        const totalPct = Math.round(62 + (pct / 100) * 36)
        _updateDownloadToast(t, 'DECRYPTING ' + pct + '%', totalPct)
      })

      _updateDownloadToast(t, 'SAVING...', 99)
      const blob = new Blob([decrypted], { type: 'application/octet-stream' })
      _triggerBlobDownload(blob, fileName)

      _completeDownloadToast(t)
    } catch (err) {
      console.error('[TEMP E2EE DOWNLOAD]', err)
      _errorDownloadToast(t, err.message || 'DECRYPTION FAILED')
    }
  }

  // ─── Non-E2EE Download with Progress ──────────────────────────────
  async function _downloadFile(fileId, fileName) {
    const t = _showDownloadToast('DOWNLOADING FILE')
    _updateDownloadToast(t, 'DOWNLOADING...', 2, fileName, '-')

    try {
      const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', `/f/${fileId}/${encodeURIComponent(fileName)}`, true)
        xhr.responseType = 'arraybuffer'
        let lastTime = Date.now(), lastLoaded = 0
        xhr.onprogress = (e) => {
          if (e.lengthComputable) {
            const dlPct = Math.round(2 + (e.loaded / e.total) * 96)
            const now = Date.now()
            const dt = (now - lastTime) / 1000
            let speedText = '-'
            if (dt > 0.2) {
              const bytesPerSec = (e.loaded - lastLoaded) / dt
              speedText = bytesPerSec >= 1048576
                ? (bytesPerSec / 1048576).toFixed(1) + ' MB/S'
                : Math.round(bytesPerSec / 1024) + ' KB/S'
              lastTime = now
              lastLoaded = e.loaded
            }
            const mb = (e.loaded / 1048576).toFixed(1)
            const totalMb = (e.total / 1048576).toFixed(1)
            _updateDownloadToast(t, `DOWNLOADING ${mb} / ${totalMb} MB`, dlPct, undefined, speedText)
          }
        }
        xhr.onload = () => {
          if (xhr.status === 200) resolve(xhr.response)
          else reject(new Error(`HTTP ${xhr.status}`))
        }
        xhr.onerror = () => reject(new Error('NETWORK ERROR'))
        xhr.send()
      })

      _updateDownloadToast(t, 'SAVING...', 99)
      const blob = new Blob([data], { type: 'application/octet-stream' })
      _triggerBlobDownload(blob, fileName)

      _completeDownloadToast(t)
    } catch (err) {
      console.error('[TEMP DOWNLOAD]', err)
      _errorDownloadToast(t, 'DOWNLOAD FAILED')
    }
  }

  // ─── Preview: Open / Close ────────────────────────────────────────
  let _activeEditor = null
  let _previewBlobUrls = []  // Track blob URLs for cleanup
  let _previewGeneration = 0
  let _previewAbort = null
  const previewModal = document.getElementById('previewModal')

  function _isPreviewCurrent(generation) {
    return generation === _previewGeneration && previewModal && previewModal.classList.contains('preview-visible')
  }

  function _clearPreviewBlobUrls() {
    _previewBlobUrls.forEach(u => URL.revokeObjectURL(u))
    _previewBlobUrls = []
  }

  function _beginPreviewWork() {
    _previewGeneration++
    if (_previewAbort) _previewAbort.abort()
    _previewAbort = new AbortController()
    _activeEditor = null
    _clearPreviewBlobUrls()
    return { generation: _previewGeneration, signal: _previewAbort.signal }
  }

  function _cancelPreviewWork() {
    _previewGeneration++
    if (_previewAbort) _previewAbort.abort()
    _previewAbort = null
  }

  /* ── Custom Video Player ── */
  function _attachCustomVideoPlayer(video, previewBody) {
    video.removeAttribute('controls')
    const wrap = document.createElement('div')
    wrap.className = 'preview-video-wrap'
    video.parentNode.insertBefore(wrap, video)
    wrap.appendChild(video)

    const SVG_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
    const SVG_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>'
    const SVG_VOL = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>'
    const SVG_MUTE = '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>'
    const SVG_FS = '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>'
    const SVG_FS_EXIT = '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>'

    const overlay = document.createElement('div')
    overlay.className = 'pvp-play-overlay'
    overlay.innerHTML = SVG_PLAY
    wrap.appendChild(overlay)
    let _overlayTimer = null
    function flashOverlay(playing) {
      overlay.innerHTML = playing ? SVG_PLAY : SVG_PAUSE
      overlay.classList.add('pvp-flash')
      clearTimeout(_overlayTimer)
      _overlayTimer = setTimeout(() => overlay.classList.remove('pvp-flash'), 400)
    }

    const controls = document.createElement('div')
    controls.className = 'pvp-controls'
    controls.innerHTML = `
      <button class="pvp-btn pvp-play-btn" title="PLAY/PAUSE">${SVG_PLAY}</button>
      <div class="pvp-seek-wrap">
        <div class="pvp-seek-track"><div class="pvp-seek-buffer"></div><div class="pvp-seek-fill"></div></div>
        <div class="pvp-seek-thumb"></div>
      </div>
      <span class="pvp-time">0:00 / 0:00</span>
      <div class="pvp-speed-wrap">
        <button class="pvp-speed-btn" title="PLAYBACK SPEED">1\u00d7</button>
        <div class="pvp-speed-menu"></div>
      </div>
      <div class="pvp-vol-wrap">
        <button class="pvp-btn pvp-vol-btn" title="MUTE/UNMUTE">${SVG_VOL}</button>
        <div class="pvp-vol-slider-wrap"><div class="pvp-vol-track"><div class="pvp-vol-fill"></div></div></div>
      </div>
      <button class="pvp-btn pvp-fs-btn" title="FULLSCREEN">${SVG_FS}</button>
    `
    wrap.appendChild(controls)

    const playBtn = controls.querySelector('.pvp-play-btn')
    const seekWrap = controls.querySelector('.pvp-seek-wrap')
    const seekFill = controls.querySelector('.pvp-seek-fill')
    const seekBuffer = controls.querySelector('.pvp-seek-buffer')
    const seekThumb = controls.querySelector('.pvp-seek-thumb')
    const timeLabel = controls.querySelector('.pvp-time')
    const speedBtn = controls.querySelector('.pvp-speed-btn')
    const speedMenu = controls.querySelector('.pvp-speed-menu')
    const volBtn = controls.querySelector('.pvp-vol-btn')
    const volTrack = controls.querySelector('.pvp-vol-track')
    const volFill = controls.querySelector('.pvp-vol-fill')
    const fsBtn = controls.querySelector('.pvp-fs-btn')

    const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
    let _speedIdx = 2
    SPEEDS.forEach((spd, i) => {
      const opt = document.createElement('button')
      opt.className = 'pvp-speed-option' + (i === _speedIdx ? ' pvp-speed-option-active' : '')
      opt.textContent = spd + '\u00d7'
      opt.addEventListener('click', e => {
        e.stopPropagation()
        _speedIdx = i
        video.playbackRate = spd
        speedBtn.textContent = spd + '\u00d7'
        speedBtn.classList.toggle('pvp-speed-active', spd !== 1)
        speedMenu.querySelectorAll('.pvp-speed-option').forEach((el, j) => {
          el.classList.toggle('pvp-speed-option-active', j === i)
        })
        speedMenu.classList.remove('pvp-speed-menu-open')
      })
      speedMenu.appendChild(opt)
    })
    speedBtn.addEventListener('click', e => {
      e.stopPropagation()
      speedMenu.classList.toggle('pvp-speed-menu-open')
    })
    wrap.addEventListener('click', () => speedMenu.classList.remove('pvp-speed-menu-open'))
    wrap.addEventListener('touchstart', e => {
      if (!speedBtn.contains(e.target) && !speedMenu.contains(e.target)) {
        speedMenu.classList.remove('pvp-speed-menu-open')
      }
    }, { passive: true })

    function fmtTime(s) {
      if (!isFinite(s) || s < 0) s = 0
      const m = Math.floor(s / 60)
      const sec = Math.floor(s % 60)
      return m + ':' + (sec < 10 ? '0' : '') + sec
    }

    function togglePlay() { if (video.paused) video.play(); else video.pause() }
    playBtn.addEventListener('click', e => { e.stopPropagation(); togglePlay() })
    video.addEventListener('play', () => { playBtn.innerHTML = SVG_PAUSE })
    video.addEventListener('pause', () => { playBtn.innerHTML = SVG_PLAY })

    function updateSeek() {
      if (!video.duration) return
      const pct = (video.currentTime / video.duration) * 100
      seekFill.style.width = pct + '%'
      seekThumb.style.left = pct + '%'
      timeLabel.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(video.duration)
    }
    video.addEventListener('timeupdate', updateSeek)
    video.addEventListener('loadedmetadata', updateSeek)
    video.addEventListener('durationchange', updateSeek)

    function updateBuffer() {
      if (!video.duration || !video.buffered.length) return
      const end = video.buffered.end(video.buffered.length - 1)
      seekBuffer.style.width = (end / video.duration * 100) + '%'
    }
    video.addEventListener('progress', updateBuffer)

    let _seeking = false
    function seekTo(e) {
      const rect = seekWrap.getBoundingClientRect()
      let pct = (e.clientX - rect.left) / rect.width
      pct = Math.max(0, Math.min(1, pct))
      if (video.duration) video.currentTime = pct * video.duration
      seekFill.style.width = (pct * 100) + '%'
      seekThumb.style.left = (pct * 100) + '%'
    }
    seekWrap.addEventListener('mousedown', e => { e.stopPropagation(); _seeking = true; seekWrap.classList.add('pvp-seeking'); seekTo(e) })
    document.addEventListener('mousemove', e => { if (_seeking) seekTo(e) })
    document.addEventListener('mouseup', () => { if (_seeking) { _seeking = false; seekWrap.classList.remove('pvp-seeking') } })
    seekWrap.addEventListener('touchstart', e => { e.stopPropagation(); _seeking = true; seekWrap.classList.add('pvp-seeking'); seekTo(e.touches[0]) }, { passive: true })
    seekWrap.addEventListener('touchmove', e => { if (_seeking) seekTo(e.touches[0]) }, { passive: true })
    seekWrap.addEventListener('touchend', () => { _seeking = false; seekWrap.classList.remove('pvp-seeking') })

    // Perceptual volume curve with 15% linear baseline for audible low-end
    function pvpVolCurve(x) { return x <= 0 ? 0 : 0.15 * x + 0.85 * x * x }
    let _lastVol = 1       // stores perceptual position (pre-curve)
    let _volPos = 1         // current perceptual position
    volBtn.addEventListener('click', e => {
      e.stopPropagation()
      if (video.muted || video.volume === 0) { video.muted = false; _volPos = _lastVol || 0.5; video.volume = pvpVolCurve(_volPos) }
      else { _lastVol = _volPos; video.muted = true }
      updateVol()
    })
    function updateVol() {
      const v = video.muted ? 0 : _volPos
      volFill.style.width = (v * 100) + '%'
      volBtn.innerHTML = v === 0 ? SVG_MUTE : SVG_VOL
    }
    video.addEventListener('volumechange', updateVol)
    volTrack.addEventListener('click', e => {
      e.stopPropagation()
      const rect = volTrack.getBoundingClientRect()
      _volPos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      video.volume = pvpVolCurve(_volPos); video.muted = _volPos === 0; updateVol()
    })

    fsBtn.addEventListener('click', e => {
      e.stopPropagation()
      if (document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document)
      } else {
        (wrap.requestFullscreen || wrap.webkitRequestFullscreen).call(wrap)
      }
    })
    function onFSChange() {
      const isFS = document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap
      fsBtn.innerHTML = isFS ? SVG_FS_EXIT : SVG_FS
    }
    document.addEventListener('fullscreenchange', onFSChange)
    document.addEventListener('webkitfullscreenchange', onFSChange)

    video.addEventListener('click', e => { e.stopPropagation(); togglePlay(); flashOverlay(video.paused) })
    video.addEventListener('dblclick', e => {
      e.stopPropagation(); e.preventDefault()
      if (document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document)
      } else {
        (wrap.requestFullscreen || wrap.webkitRequestFullscreen).call(wrap)
      }
    })

    let _hideTimer = null
    function showControls() {
      controls.classList.remove('pvp-hidden')
      clearTimeout(_hideTimer)
      if (!video.paused) _hideTimer = setTimeout(() => controls.classList.add('pvp-hidden'), 3000)
    }
    wrap.addEventListener('mousemove', showControls)
    wrap.addEventListener('mouseenter', showControls)
    wrap.addEventListener('touchstart', showControls, { passive: true })
    video.addEventListener('play', () => { _hideTimer = setTimeout(() => controls.classList.add('pvp-hidden'), 3000) })
    video.addEventListener('pause', () => { clearTimeout(_hideTimer); controls.classList.remove('pvp-hidden') })
    controls.addEventListener('click', e => e.stopPropagation())
    controls.addEventListener('dblclick', e => e.stopPropagation())

    wrap.setAttribute('tabindex', '0')
    wrap.style.outline = 'none'
    wrap.addEventListener('keydown', e => {
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); flashOverlay(video.paused); break
        case 'ArrowLeft': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); break
        case 'ArrowRight': e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); break
        case 'ArrowUp': e.preventDefault(); _volPos = Math.min(1, _volPos + 0.1); video.volume = pvpVolCurve(_volPos); video.muted = false; updateVol(); break
        case 'ArrowDown': e.preventDefault(); _volPos = Math.max(0, _volPos - 0.1); video.volume = pvpVolCurve(_volPos); updateVol(); break
        case 'f': e.preventDefault()
          if (document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap) (document.exitFullscreen || document.webkitExitFullscreen).call(document)
          else (wrap.requestFullscreen || wrap.webkitRequestFullscreen).call(wrap)
          break
        case 'm': e.preventDefault(); video.muted = !video.muted; updateVol(); break
      }
    })
    wrap.focus()
    return wrap
  }

  /* ── Image Zoom & Pan ── */
  function _attachImageZoom(img, generation) {
    const stage = document.getElementById('previewBody')
    const zoomBadge = document.getElementById('previewZoomBadge')
    let scale = 1, tx = 0, ty = 0
    const MIN_SCALE = 1, MAX_SCALE = 5
    let _baseOffsetX = 0, _baseOffsetY = 0, _offsetCached = false

    function isCurrent() { return _isPreviewCurrent(generation) && img.isConnected }

    function cacheOffset() {
      if (!isCurrent()) return
      if (_offsetCached) return
      const sRect = stage.getBoundingClientRect()
      const iRect = img.getBoundingClientRect()
      _baseOffsetX = iRect.left - sRect.left
      _baseOffsetY = iRect.top - sRect.top
      _offsetCached = true
    }

    function applyTransform() {
      if (!isCurrent()) return
      img.style.transform = scale <= 1.001 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`
      if (zoomBadge) {
        if (scale > 1.01) { zoomBadge.textContent = scale.toFixed(1) + '\u00d7'; zoomBadge.classList.add('visible') }
        else { zoomBadge.classList.remove('visible') }
      }
      if (scale > 1.01) { img.classList.add('pv-zoomed'); stage.classList.add('pv-zoom-active') }
      else { img.classList.remove('pv-zoomed', 'pv-dragging'); stage.classList.remove('pv-zoom-active') }
    }

    function clampPan() {
      const sW = stage.clientWidth, sH = stage.clientHeight
      const iW = img.offsetWidth * scale, iH = img.offsetHeight * scale
      if (iW <= sW) { tx = (sW - iW) / 2 - _baseOffsetX }
      else { tx = Math.max(sW - iW - _baseOffsetX, Math.min(-_baseOffsetX, tx)) }
      if (iH <= sH) { ty = (sH - iH) / 2 - _baseOffsetY }
      else { ty = Math.max(sH - iH - _baseOffsetY, Math.min(-_baseOffsetY, ty)) }
    }

    function screenToImage(clientX, clientY) {
      const sRect = stage.getBoundingClientRect()
      const ix = (clientX - sRect.left - _baseOffsetX - tx) / scale
      const iy = (clientY - sRect.top - _baseOffsetY - ty) / scale
      return { ix, iy }
    }

    function zoomAt(clientX, clientY, newScale) {
      if (!isCurrent()) return
      cacheOffset()
      const prev = scale
      newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale))
      if (Math.abs(newScale - prev) < 0.001) return
      const { ix, iy } = screenToImage(clientX, clientY)
      scale = newScale
      const sRect = stage.getBoundingClientRect()
      tx = (clientX - sRect.left) - _baseOffsetX - ix * scale
      ty = (clientY - sRect.top) - _baseOffsetY - iy * scale
      clampPan()
      applyTransform()
    }

    function resetZoom() {
      if (!isCurrent()) return
      scale = 1; tx = 0; ty = 0
      img.style.transform = ''
      img.classList.remove('pv-zoomed', 'pv-dragging')
      stage.classList.remove('pv-zoom-active')
      if (zoomBadge) zoomBadge.classList.remove('visible')
      _offsetCached = false
    }

    img.addEventListener('wheel', e => {
      if (!isCurrent()) return
      e.preventDefault(); cacheOffset()
      zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
    }, { passive: false })

    img.addEventListener('dblclick', e => {
      if (!isCurrent()) return
      e.preventDefault(); e.stopPropagation()
      if (scale > 1.05) resetZoom()
      else zoomAt(e.clientX, e.clientY, 2.5)
    })

    let _dragging = false, _dragStartX = 0, _dragStartY = 0, _dragTxStart = 0, _dragTyStart = 0
    img.addEventListener('mousedown', e => {
      if (!isCurrent() || scale <= 1.01) return
      e.preventDefault(); _dragging = true
      _dragStartX = e.clientX; _dragStartY = e.clientY
      _dragTxStart = tx; _dragTyStart = ty
      img.classList.add('pv-dragging')
    })
    document.addEventListener('mousemove', e => {
      if (!isCurrent() || !_dragging) return
      tx = _dragTxStart + (e.clientX - _dragStartX)
      ty = _dragTyStart + (e.clientY - _dragStartY)
      clampPan(); applyTransform()
    })
    document.addEventListener('mouseup', () => { if (isCurrent() && _dragging) { _dragging = false; img.classList.remove('pv-dragging') } })

    let _touches = [], _pinchStartDist = 0, _pinchStartScale = 1
    let _touchDragging = false, _tdStartX = 0, _tdStartY = 0, _tdTxStart = 0, _tdTyStart = 0
    function touchDist(t1, t2) { return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY) }

    img.addEventListener('touchstart', e => {
      if (!isCurrent()) return
      _touches = Array.from(e.touches)
      if (_touches.length === 2) { e.preventDefault(); _pinchStartDist = touchDist(_touches[0], _touches[1]); _pinchStartScale = scale }
      else if (_touches.length === 1 && scale > 1.01) {
        _touchDragging = true; _tdStartX = _touches[0].clientX; _tdStartY = _touches[0].clientY; _tdTxStart = tx; _tdTyStart = ty
        img.classList.add('pv-dragging')
      }
    }, { passive: false })

    img.addEventListener('touchmove', e => {
      if (!isCurrent()) return
      _touches = Array.from(e.touches)
      if (_touches.length === 2) {
        e.preventDefault()
        const dist = touchDist(_touches[0], _touches[1])
        const midX = (_touches[0].clientX + _touches[1].clientX) / 2
        const midY = (_touches[0].clientY + _touches[1].clientY) / 2
        zoomAt(midX, midY, _pinchStartScale * (dist / _pinchStartDist))
      } else if (_touches.length === 1 && _touchDragging) {
        e.preventDefault()
        tx = _tdTxStart + (_touches[0].clientX - _tdStartX)
        ty = _tdTyStart + (_touches[0].clientY - _tdStartY)
        clampPan(); applyTransform()
      }
    }, { passive: false })

    img.addEventListener('touchend', e => {
      if (!isCurrent()) return
      _touches = Array.from(e.touches)
      _touchDragging = false; img.classList.remove('pv-dragging')
      if (e.changedTouches.length === 1 && _touches.length === 0) {
        const now = Date.now()
        if (img._lastTap && now - img._lastTap < 300) {
          e.preventDefault()
          const t = e.changedTouches[0]
          if (scale > 1.05) resetZoom()
          else zoomAt(t.clientX, t.clientY, 2.5)
          img._lastTap = 0
        } else { img._lastTap = now }
      }
    })

    img.addEventListener('click', e => { if (isCurrent() && scale > 1.01) e.stopPropagation() })
    return { resetZoom }
  }

  function openPreview() {
    if (!previewModal) return
    previewModal.classList.remove('preview-hiding')
    previewModal.classList.add('preview-visible')
    window._previewScrollY = window.scrollY
    document.documentElement.classList.add('preview-scroll-lock')
    document.documentElement.style.top = `-${window._previewScrollY}px`
    history.pushState({ preview: true }, '')
  }

  function _closePreviewInternal() {
    if (!previewModal || !previewModal.classList.contains('preview-visible')) return
    _cancelPreviewWork()
    const closeGeneration = _previewGeneration
    const video = previewModal.querySelector('video')
    const audio = previewModal.querySelector('audio')
    if (video) video.pause()
    if (audio) audio.pause()
    const downloadBtn = document.getElementById('previewDownloadBtn')
    if (downloadBtn) downloadBtn.style.display = ''
    _activeEditor = null
    // Reset zoom state
    const zoomBadge = document.getElementById('previewZoomBadge')
    if (zoomBadge) zoomBadge.classList.remove('visible')
    const stage = document.getElementById('previewBody')
    if (stage) stage.classList.remove('pv-zoom-active')
    // Revoke blob URLs from previous preview to free memory
    _clearPreviewBlobUrls()
    document.documentElement.classList.remove('preview-scroll-lock')
    document.documentElement.style.top = ''
    window.scrollTo(0, window._previewScrollY || 0)
    previewModal.classList.add('preview-hiding')
    previewModal.addEventListener('animationend', function handler() {
      if (closeGeneration !== _previewGeneration) return
      previewModal.classList.remove('preview-visible', 'preview-hiding')
      previewModal.removeEventListener('animationend', handler)
    }, { once: true })
  }

  function closePreview() {
    if (!previewModal || !previewModal.classList.contains('preview-visible')) return
    if (_activeEditor && _activeEditor.isModified()) {
      if (!confirm('YOU HAVE UNSAVED CHANGES. CLOSE WITHOUT SAVING?')) return
    }
    _closePreviewInternal()
    if (history.state && history.state.preview) {
      history.back()
    }
  }

  // Handle back button closing preview
  window.addEventListener('popstate', function(e) {
    if (previewModal && previewModal.classList.contains('preview-visible')) {
      _closePreviewInternal()
    }
  })

  // Close button
  document.getElementById('closePreviewModal')?.addEventListener('click', () => {
    closePreview()
  })

  // Click on backdrop / empty stage area / bar gradient closes preview
  if (previewModal) {
    previewModal.addEventListener('click', (e) => {
      if (e.target.closest('.preview-bar-download')) return
      if (e.target === previewModal || e.target.id === 'previewBody'
          || e.target.closest('.preview-bar')) closePreview()
    })
  }

  // Escape key closes preview
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && previewModal && previewModal.classList.contains('preview-visible')) {
      e.preventDefault()
      closePreview()
    }
  })

  // ─── Preview Helpers ──────────────────────────────────────────────
  function _splitNameExt(filename) {
    if (!filename || !filename.includes('.')) return { base: filename || '', ext: '' }
    const parts = filename.split('.')
    const compoundPrefixes = new Set(['tar'])
    if (parts.length >= 3 && compoundPrefixes.has(parts[parts.length - 2].toLowerCase())) {
      const ext = '.' + parts[parts.length - 2] + '.' + parts[parts.length - 1]
      const base = filename.substring(0, filename.length - ext.length)
      return { base, ext }
    }
    const lastDot = filename.lastIndexOf('.')
    return { base: filename.substring(0, lastDot), ext: filename.substring(lastDot) }
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  }

  function _setPreviewFileName(el, fileName) {
    const pp = _splitNameExt(fileName)
    if (pp.ext) {
      el.innerHTML = '<span class="file-name-base">' + _esc(pp.base) + '</span><span class="file-name-ext">' + _esc(pp.ext) + '</span>'
    } else {
      el.textContent = fileName
    }
  }

  function getHighlightLanguage(ext) {
    const map = {
      py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
      json: 'json', xml: 'xml', html: 'xml', css: 'css', yaml: 'yaml', yml: 'yaml',
      sh: 'bash', bash: 'bash', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
      lua: 'lua', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
      kt: 'kotlin', swift: 'swift', php: 'php', pl: 'perl', r: 'r',
      sql: 'sql', md: 'markdown', diff: 'diff', makefile: 'makefile',
      toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
      bat: 'dos', ps1: 'powershell', csv: 'plaintext', log: 'plaintext', txt: 'plaintext'
    }
    return map[ext] || 'plaintext'
  }

  function getLanguageDisplayName(ext) {
    const map = {
      py: 'PYTHON', js: 'JAVASCRIPT', ts: 'TYPESCRIPT', tsx: 'TSX', jsx: 'JSX',
      json: 'JSON', xml: 'XML', html: 'HTML', css: 'CSS', yaml: 'YAML', yml: 'YAML',
      sh: 'BASH', bash: 'BASH', c: 'C', cpp: 'C++', h: 'C HEADER', hpp: 'C++ HEADER',
      lua: 'LUA', rb: 'RUBY', rs: 'RUST', go: 'GO', java: 'JAVA',
      kt: 'KOTLIN', swift: 'SWIFT', php: 'PHP', pl: 'PERL', r: 'R',
      sql: 'SQL', md: 'MARKDOWN', diff: 'DIFF', makefile: 'MAKEFILE',
      toml: 'TOML', ini: 'INI', cfg: 'CONFIG', conf: 'CONFIG',
      bat: 'BATCH', ps1: 'POWERSHELL', csv: 'CSV', log: 'LOG', txt: 'TEXT'
    }
    return map[ext] || ext.toUpperCase()
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1048576).toFixed(2) + ' MB'
  }

  // ─── Text encoding detection (same logic as preview.js) ──
  // Windows writes many text files (BitLocker keys, Notepad "Unicode") as
  // UTF-16 with a BOM. Hard-coded UTF-8 decoding renders those as garbage
  // (BOM -> replacement chars, NUL "boxes" between characters) even though
  // the stored bytes are pristine. Detect and decode properly; saves
  // re-encode with the SAME encoding + BOM so a round trip never silently
  // converts the file's encoding.
  function decodeTextBytes(bytes) {
    const u8 = new Uint8Array(bytes)
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), enc: 'utf-16le', bom: true }
    if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), enc: 'utf-16be', bom: true }
    if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return { text: new TextDecoder('utf-8').decode(u8), enc: 'utf-8', bom: true }
    if (u8.length >= 4) {
      const n = Math.min(u8.length - (u8.length % 2), 1024)
      let even = 0, odd = 0
      for (let i = 0; i + 1 < n; i += 2) { if (u8[i] === 0) even++; if (u8[i + 1] === 0) odd++ }
      const pairs = n / 2
      if (pairs > 0 && odd / pairs > 0.7 && even / pairs < 0.1) return { text: new TextDecoder('utf-16le').decode(u8), enc: 'utf-16le', bom: false }
      if (pairs > 0 && even / pairs > 0.7 && odd / pairs < 0.1) return { text: new TextDecoder('utf-16be').decode(u8), enc: 'utf-16be', bom: false }
    }
    return { text: new TextDecoder('utf-8').decode(u8), enc: 'utf-8', bom: false }
  }
  function detectEol(text) {
    if (text.indexOf('\r\n') >= 0) return '\r\n'
    if (text.indexOf('\r') >= 0) return '\r'
    return '\n'
  }
  function encodeTextBytes(str, encInfo) {
    if (encInfo && encInfo.eol && encInfo.eol !== '\n') str = String(str).split('\n').join(encInfo.eol)
    const enc = encInfo && encInfo.enc
    if (enc === 'utf-16le' || enc === 'utf-16be') {
      const le = enc === 'utf-16le'
      const bom = encInfo.bom ? 2 : 0
      const out = new Uint8Array(bom + str.length * 2)
      if (bom) { out[0] = le ? 0xFF : 0xFE; out[1] = le ? 0xFE : 0xFF }
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i)
        out[bom + i * 2 + (le ? 0 : 1)] = c & 0xFF
        out[bom + i * 2 + (le ? 1 : 0)] = (c >> 8) & 0xFF
      }
      return out
    }
    const utf8 = new TextEncoder().encode(str)
    if (encInfo && encInfo.bom && enc === 'utf-8') {
      const withBom = new Uint8Array(3 + utf8.length)
      withBom[0] = 0xEF; withBom[1] = 0xBB; withBom[2] = 0xBF
      withBom.set(utf8, 3)
      return withBom
    }
    return utf8
  }

  // ─── Save File Content (non-E2E) ─────────────────────────────────
  async function saveFileContent(fileId, content, encInfo) {
    const encoded = encodeTextBytes(content, encInfo)
    const response = await fetch(`/file/${fileId}/save-content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': getCSRFToken()
      },
      body: encoded
    })
    return await response.json()
  }

  // ─── Save E2E File Content (re-encryption, master-key OR passphrase) ──
  async function saveE2EFileContent(fileId, content, fileName, encInfo) {
    if (typeof OneGyCrypto === 'undefined') {
      return { success: false, error: 'CRYPTO NOT AVAILABLE' }
    }

    // Determine wrapping mode from key info
    var keyResp = await fetch('/f/' + fileId + '/key-info')
    if (!keyResp.ok) return { success: false, error: 'KEY FETCH FAILED' }
    var keyInfo = await keyResp.json()

    var plainBytes = encodeTextBytes(content, encInfo)
    var formData = new FormData()
    var fileKey = null
    var masterKey = null

    if (keyInfo.file_key_salt) {
      // Passphrase-wrapped: re-encrypt with passphrase
      var passphrase = await _ensurePassphrase(fileId)
      if (!passphrase) return { success: false, error: 'PASSPHRASE NOT AVAILABLE' }

      var result = await OneGyCrypto.encryptFileForGuestUpload(plainBytes, passphrase)
      formData.append('file', result.encryptedBlob)
      formData.append('encrypted_file_key', result.encryptedFileKey)
      formData.append('file_key_nonce', result.fileKeyNonce)
      formData.append('file_key_salt', result.fileKeySalt)
      fileKey = result.fileKey
    } else if (_hasMasterKey()) {
      // Master-key-wrapped: re-encrypt with master key
      masterKey = await OneGyCrypto.getMasterKeyFromSession()
      if (!masterKey) return { success: false, error: 'MASTER KEY NOT AVAILABLE' }

      var result = await OneGyCrypto.encryptFileForUpload(plainBytes, masterKey)
      formData.append('file', result.encryptedBlob)
      formData.append('encrypted_file_key', result.encryptedFileKey)
      formData.append('file_key_nonce', result.fileKeyNonce)
      fileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(result.encryptedFileKey, result.fileKeyNonce, masterKey)
    } else {
      return { success: false, error: 'ENCRYPTION KEYS NOT AVAILABLE' }
    }

    if (keyInfo.encrypted_name && keyInfo.name_nonce) {
      var realName = fileName
      try {
        if (!realName || realName.indexOf('encrypted_') === 0) {
          var oldFileKey = null
          if (keyInfo.file_key_salt) {
            var oldPassphrase = await _ensurePassphrase(fileId)
            if (oldPassphrase) oldFileKey = await OneGyCrypto.unwrapFileKeyWithPassphrase(keyInfo.encrypted_file_key, keyInfo.file_key_nonce, keyInfo.file_key_salt, oldPassphrase)
          } else if (masterKey) {
            oldFileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey)
          }
          if (oldFileKey) realName = await OneGyCrypto.decryptFileName(keyInfo.encrypted_name, keyInfo.name_nonce, oldFileKey)
        }
        if (!realName || realName.indexOf('encrypted_') === 0) return { success: false, error: 'FILENAME KEY NOT AVAILABLE' }
        var nameResult = await OneGyCrypto.encryptFileName(realName, fileKey)
        formData.append('encrypted_name', nameResult.encryptedName)
        formData.append('name_nonce', nameResult.nameNonce)
      } catch (nameErr) {
        console.error('[TEMP PREVIEW] Filename re-encryption failed:', nameErr)
        return { success: false, error: 'FILENAME ENCRYPTION FAILED' }
      }
    }

    if (masterKey && (keyInfo.link_encrypted_file_key || keyInfo.folder_link_encrypted_file_key || keyInfo.has_folder_link_key)) {
      try {
        var manageResp = await fetch('/file/' + fileId + '/manage-data', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        if (!manageResp.ok) return { success: false, error: 'COULD NOT CHECK SHARE STATUS — NOT SAVING' }
        var manageData = await manageResp.json()
        var needFileLink = !!(manageData.has_file_link_key || keyInfo.link_encrypted_file_key)
        var needFolderLink = !!(manageData.has_folder_link_key || manageData.ancestor_share_token || keyInfo.folder_link_encrypted_file_key)
        if (needFileLink) {
          var fileLinkInfo = await OneGyCrypto.deriveLinkSecret(masterKey, 'file', fileId)
          if (!fileLinkInfo || !fileLinkInfo.linkKey) return { success: false, error: 'COULD NOT DERIVE THE SHARE-LINK KEY — NOT SAVING' }
          var fileWrap = await OneGyCrypto.wrapFileKeyForLink(fileKey, fileLinkInfo.linkKey)
          formData.append('link_encrypted_file_key', fileWrap.encryptedFileKey)
          formData.append('link_file_key_nonce', fileWrap.nonce)
        }
        if (needFolderLink) {
          if (!manageData.ancestor_share_token) return { success: false, error: 'COULD NOT DERIVE THE FOLDER SHARE-LINK KEY — NOT SAVING' }
          var folderLinkInfo = await OneGyCrypto.deriveLinkSecret(masterKey, 'folder', manageData.ancestor_share_token)
          if (!folderLinkInfo || !folderLinkInfo.linkKey) return { success: false, error: 'COULD NOT DERIVE THE FOLDER SHARE-LINK KEY — NOT SAVING' }
          var folderWrap = await OneGyCrypto.wrapFileKeyForLink(fileKey, folderLinkInfo.linkKey)
          formData.append('folder_link_encrypted_file_key', folderWrap.encryptedFileKey)
          formData.append('folder_link_file_key_nonce', folderWrap.nonce)
        }
      } catch (linkErr) {
        console.error('[TEMP PREVIEW] Link key re-wrap failed:', linkErr)
        return { success: false, error: 'LINK KEY ENCRYPTION FAILED' }
      }
    }

    formData.append('original_size', plainBytes.byteLength.toString())

    var response = await fetch('/file/' + fileId + '/save-content', {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': getCSRFToken()
      },
      body: formData
    })
    return await response.json()
  }

  // ─── Text Editor ──────────────────────────────────────────────────
  function buildTextEditor(text, extension, fileId, isE2E, fileName, encInfo, generation) {
    const lang = getHighlightLanguage(extension)
    const langName = getLanguageDisplayName(extension)
    let savedText = text

    const container = document.createElement('div')
    container.className = 'preview-editor-container'

    const toolbar = document.createElement('div')
    toolbar.className = 'preview-editor-toolbar'

    const langLabel = document.createElement('span')
    langLabel.className = 'preview-editor-lang'
    langLabel.textContent = langName

    const status = document.createElement('span')
    status.className = 'preview-editor-status'
    const statusDot = document.createElement('span')
    statusDot.className = 'preview-editor-status-dot'
    const statusText = document.createElement('span')
    statusText.textContent = 'READY'
    status.appendChild(statusDot)
    status.appendChild(statusText)

    const saveBtn = document.createElement('button')
    saveBtn.className = 'preview-editor-save'
    saveBtn.textContent = 'SAVE'
    saveBtn.type = 'button'

    toolbar.appendChild(langLabel)
    toolbar.appendChild(status)
    toolbar.appendChild(saveBtn)

    const wrapper = document.createElement('div')
    wrapper.className = 'preview-editor-wrapper'

    const gutter = document.createElement('div')
    gutter.className = 'preview-editor-gutter'
    const gutterInner = document.createElement('div')
    gutterInner.className = 'preview-editor-gutter-inner'
    gutter.appendChild(gutterInner)

    const scrollArea = document.createElement('div')
    scrollArea.className = 'preview-editor-scroll'

    const codeWrap = document.createElement('pre')
    codeWrap.className = 'preview-editor-code-pre'
    const codeEl = document.createElement('code')
    codeEl.className = 'preview-editor-code hljs'
    codeEl.contentEditable = 'true'
    codeEl.spellcheck = false
    codeEl.setAttribute('autocorrect', 'off')
    codeEl.setAttribute('autocapitalize', 'off')
    codeEl.setAttribute('autocomplete', 'off')
    codeEl.setAttribute('data-gramm', 'false')
    // Trailing sentinel newline, as every highlight path writes it:
    // getEditorText() strips exactly one, so without it the file's own final
    // newline would be dropped on the first highlight and saved that way.
    codeEl.textContent = text + '\n'
    codeWrap.appendChild(codeEl)

    const textarea = document.createElement('textarea')
    textarea.className = 'preview-editor-hidden-textarea'
    textarea.tabIndex = -1
    textarea.setAttribute('aria-hidden', 'true')
    textarea.value = text

    scrollArea.appendChild(codeWrap)
    scrollArea.appendChild(textarea)
    wrapper.appendChild(gutter)
    wrapper.appendChild(scrollArea)

    const footer = document.createElement('div')
    footer.className = 'preview-editor-footer'

    const cursorInfo = document.createElement('span')
    cursorInfo.textContent = 'LN 1, COL 1'

    const encodingInfo = document.createElement('span')
    encodingInfo.textContent = 'UTF-8'

    const sizeInfo = document.createElement('span')
    sizeInfo.textContent = formatFileSize(new TextEncoder().encode(text).byteLength)

    footer.appendChild(cursorInfo)
    footer.appendChild(encodingInfo)
    footer.appendChild(sizeInfo)

    container.appendChild(toolbar)
    container.appendChild(wrapper)
    container.appendChild(footer)

    // ---- Get/set text from contenteditable ----
    function getEditorText() {
      const text = codeEl.innerText
      return text.replace(/\n$/, '')
    }

    function setEditorText(newText) {
      textarea.value = newText
    }

    // ---- Highlighting ----
    let highlightTimer = null
    let _isHighlighting = false

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    function setHighlightedHtml(el, html) {
      var template = document.createElement('template')
      template.innerHTML = String(html || '')
      function clean (node) {
        if (node.nodeType === Node.COMMENT_NODE) { node.remove(); return }
        if (node.nodeType !== Node.ELEMENT_NODE) return
        var tag = node.tagName.toLowerCase()
        if (tag !== 'span') {
          var parent = node.parentNode
          if (parent) { while (node.firstChild) parent.insertBefore(node.firstChild, node); node.remove() }
          return
        }
        Array.prototype.slice.call(node.attributes).forEach(function (attr) {
          var name = attr.name.toLowerCase()
          if (name === 'class') {
            var classes = attr.value.split(/\s+/).filter(function (c) { return /^hljs[-a-z0-9]*$/i.test(c) })
            if (classes.length) node.className = classes.join(' ')
            else node.removeAttribute('class')
          } else node.removeAttribute(attr.name)
        })
        Array.prototype.slice.call(node.childNodes).forEach(clean)
      }
      Array.prototype.slice.call(template.content.childNodes).forEach(clean)
      el.replaceChildren()
      el.appendChild(template.content)
      el.appendChild(document.createTextNode('\n'))
    }

    function doHighlight() {
      if (_isHighlighting) return
      _isHighlighting = true
      const savedSel = saveSelection(codeEl)
      const code = getEditorText()
      textarea.value = code
      try {
        if (typeof hljs !== 'undefined' && lang !== 'plaintext') {
          const result = hljs.highlight(code, { language: lang, ignoreIllegals: true })
          setHighlightedHtml(codeEl, result.value)
        } else {
          codeEl.textContent = code + '\n'
        }
      } catch (e) {
        codeEl.textContent = code + '\n'
      }
      restoreSelection(codeEl, savedSel)
      _isHighlighting = false
    }

    function scheduleHighlight() {
      if (highlightTimer) clearTimeout(highlightTimer)
      highlightTimer = setTimeout(doHighlight, HIGHLIGHT_DEBOUNCE_MS)
    }

    // ---- Cursor save/restore ----
    function saveSelection(containerEl) {
      const sel = window.getSelection()
      if (!sel.rangeCount) return null
      const range = sel.getRangeAt(0)
      const preRange = document.createRange()
      preRange.selectNodeContents(containerEl)
      preRange.setEnd(range.startContainer, range.startOffset)
      const start = preRange.toString().length
      return { start, end: start + range.toString().length }
    }

    function restoreSelection(containerEl, savedSel) {
      if (!savedSel) return
      const sel = window.getSelection()
      const range = document.createRange()
      let charIndex = 0
      let foundStart = false
      let stop = false
      const nodeStack = [containerEl]
      let node, startNode, startOffset, endNode, endOffset

      while (!stop && (node = nodeStack.pop())) {
        if (node.nodeType === 3) {
          const nextCharIndex = charIndex + node.length
          if (!foundStart && savedSel.start >= charIndex && savedSel.start <= nextCharIndex) {
            startNode = node
            startOffset = savedSel.start - charIndex
            foundStart = true
          }
          if (foundStart && savedSel.end >= charIndex && savedSel.end <= nextCharIndex) {
            endNode = node
            endOffset = savedSel.end - charIndex
            stop = true
          }
          charIndex = nextCharIndex
        } else {
          let i = node.childNodes.length
          while (i--) nodeStack.push(node.childNodes[i])
        }
      }

      if (startNode) {
        try {
          range.setStart(startNode, startOffset)
          range.setEnd(endNode || startNode, endOffset !== undefined ? endOffset : startOffset)
          sel.removeAllRanges()
          sel.addRange(range)
        } catch (e) {
          range.selectNodeContents(containerEl)
          range.collapse(false)
          sel.removeAllRanges()
          sel.addRange(range)
        }
      }
    }

    function getCaretOffset(containerEl) {
      const sel = window.getSelection()
      if (!sel.rangeCount) return 0
      const range = sel.getRangeAt(0)
      const preRange = document.createRange()
      preRange.selectNodeContents(containerEl)
      preRange.setEnd(range.startContainer, range.startOffset)
      return preRange.toString().length
    }

    // ---- Line numbers ----
    function updateLineNumbers() {
      const text = getEditorText()
      const lineCount = text.split('\n').length
      let nums = ''
      for (let i = 1; i <= lineCount; i++) {
        nums += i + '\n'
      }
      gutterInner.textContent = nums
    }

    function syncScroll() {
      gutter.scrollTop = scrollArea.scrollTop
    }

    function updateCursorInfo() {
      const pos = getCaretOffset(codeEl)
      const text = getEditorText()
      const textBefore = text.substring(0, pos)
      const line = textBefore.split('\n').length
      const col = pos - textBefore.lastIndexOf('\n')
      cursorInfo.textContent = 'LN ' + line + ', COL ' + col
    }

    // ---- Modified state ----
    let isModified = false
    let editRevision = 0
    let savedRevision = 0
    let saving = false

    function markModified() {
      const current = getEditorText()
      textarea.value = current
      const nowModified = editRevision !== savedRevision
      if (nowModified !== isModified) {
        isModified = nowModified
        if (isModified) {
          statusText.textContent = 'MODIFIED'
          status.className = 'preview-editor-status modified'
          saveBtn.classList.add('active')
        } else {
          statusText.textContent = 'READY'
          status.className = 'preview-editor-status'
          saveBtn.classList.remove('active')
        }
      }
      sizeInfo.textContent = formatFileSize(new TextEncoder().encode(current).byteLength)
    }

    // ---- Tab key handling ----
    codeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        document.execCommand('insertText', false, '  ')
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        markModified()
        if (isModified) saveBtn.click()
      }
    })

    // Auto-indent on Enter
    codeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const pos = getCaretOffset(codeEl)
        const text = getEditorText()
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1
        const currentLine = text.substring(lineStart, pos)
        const indent = currentLine.match(/^(\s*)/)[1]
        if (indent) {
          e.preventDefault()
          document.execCommand('insertText', false, '\n' + indent)
        }
      }
    })

    // Paste handler
    codeEl.addEventListener('paste', (e) => {
      e.preventDefault()
      const text = (e.clipboardData || window.clipboardData).getData('text/plain')
      if (text) {
        document.execCommand('insertText', false, text)
      }
    })

    // Debounced editor helpers to avoid per-keystroke layout/encoding work
    let _lineNumRaf = 0
    function debouncedUpdateLineNumbers() {
      if (!_lineNumRaf) {
        _lineNumRaf = requestAnimationFrame(() => { _lineNumRaf = 0; updateLineNumbers() })
      }
    }
    let _markModTimer = 0
    function debouncedMarkModified() {
      clearTimeout(_markModTimer)
      _markModTimer = setTimeout(markModified, 150)
    }

    // Event listeners
    codeEl.addEventListener('input', () => {
      editRevision++
      scheduleHighlight()
      debouncedUpdateLineNumbers()
      debouncedMarkModified()
    })

    scrollArea.addEventListener('scroll', syncScroll)
    codeEl.addEventListener('click', updateCursorInfo)
    codeEl.addEventListener('keyup', updateCursorInfo)

    const editor = {
      container,
      codeEl,
      getEditorText,
      isModified: () => editRevision !== savedRevision,
      _originalText: savedText
    }

    function editorIsCurrent() {
      return _activeEditor === editor && _isPreviewCurrent(generation) && container.isConnected
    }

    // ---- Save handler ----
    saveBtn.addEventListener('click', async () => {
      markModified()
      if (!isModified || saving || !editorIsCurrent()) return

      saving = true
      const currentText = getEditorText()
      const submittedRevision = editRevision

      statusText.textContent = 'SAVING...'
      status.className = 'preview-editor-status saving'
      saveBtn.classList.remove('active')
      saveBtn.disabled = true

      try {
        let response
        if (isE2E) {
          response = await saveE2EFileContent(fileId, currentText, fileName, encInfo)
        } else {
          response = await saveFileContent(fileId, currentText, encInfo)
        }

        if (response.success) {
          savedText = currentText
          savedRevision = submittedRevision
          editor._originalText = currentText
          if (!editorIsCurrent()) return
          if (editRevision === submittedRevision) {
            isModified = false
            statusText.textContent = 'SAVED'
            status.className = 'preview-editor-status saved'
            saveBtn.classList.remove('active')
          } else {
            isModified = true
            statusText.textContent = 'MODIFIED'
            status.className = 'preview-editor-status modified'
            saveBtn.classList.add('active')
          }

          if (response.new_size_formatted) {
            // Update size in the temp file list
            const row = document.querySelector(`.temp-browser-row[data-file-id="${fileId}"]`)
            if (row) {
              const sizeEl = row.querySelector('.col-size')
              if (sizeEl) sizeEl.textContent = response.new_size_formatted
            }
          }

          setTimeout(() => {
            if (editorIsCurrent() && editRevision === submittedRevision && !isModified) {
              statusText.textContent = 'READY'
              status.className = 'preview-editor-status'
            }
          }, 2000)
        } else {
          if (!editorIsCurrent()) return
          statusText.textContent = response.error || 'SAVE FAILED'
          status.className = 'preview-editor-status error'
          saveBtn.classList.add('active')
        }
      } catch (err) {
        console.error('[TEMP EDITOR] Save failed:', err)
        if (!editorIsCurrent()) return
        statusText.textContent = 'SAVE FAILED'
        status.className = 'preview-editor-status error'
        saveBtn.classList.add('active')
      } finally {
        saving = false
        if (editorIsCurrent()) saveBtn.disabled = false
      }
    })

    // Initial render
    doHighlight()
    updateLineNumbers()
    updateCursorInfo()

    _activeEditor = editor

    return container
  }

  // ─── E2E Preview (passphrase-based decryption) ────────────────────
  async function showE2EPreview(fileId, fileName, extension) {
    // Route audio to music player
    if (AUDIO_EXTS.includes(extension) && typeof window.MusicPlayer !== 'undefined') {
      window.MusicPlayer.open(fileId, fileName, extension, true)
      return
    }

    const previewWork = _beginPreviewWork()
    const generation = previewWork.generation
    const signal = previewWork.signal

    const previewBody = document.getElementById('previewBody')
    const previewFileName = document.getElementById('previewFileName')
    const downloadBtn = document.getElementById('previewDownloadBtn')
    const resEl = document.getElementById('previewResolution')

    _setPreviewFileName(previewFileName, fileName)
    previewBody.innerHTML = '<div class="preview-loading">DECRYPTING PREVIEW...</div>'
    resEl.textContent = ''
    resEl.classList.remove('visible')
    downloadBtn.removeAttribute('href')
    downloadBtn.removeAttribute('download')
    downloadBtn.style.display = ''

    openPreview()

    try {
      if (typeof OneGyCrypto === 'undefined') {
        if (_isPreviewCurrent(generation)) previewBody.innerHTML = '<div class="preview-error">CRYPTO NOT AVAILABLE</div>'
        return
      }

      const encResp = await fetch('/f/' + fileId + '/encrypted', { signal })
      if (!_isPreviewCurrent(generation)) return
      if (!encResp.ok) {
        previewBody.innerHTML = '<div class="preview-error">FAILED TO FETCH ENCRYPTED FILE</div>'
        return
      }
      const encData = await encResp.arrayBuffer()
      if (!_isPreviewCurrent(generation)) return

      previewBody.innerHTML = '<div class="preview-loading">DECRYPTING...</div>'

      const decrypted = await _decryptE2EEFile(fileId, encData, undefined, signal)
      if (!_isPreviewCurrent(generation)) return

      if (IMAGE_EXTS.includes(extension)) {
        const mime = IMAGE_MIME[extension] || 'image/jpeg'
        const blob = new Blob([decrypted], { type: mime })
        const blobUrl = URL.createObjectURL(blob)
        _previewBlobUrls.push(blobUrl)

        downloadBtn.href = blobUrl
        downloadBtn.download = fileName

        const img = document.createElement('img')
        img.src = blobUrl
        img.className = 'preview-image'
        img.alt = fileName
        img.onload = () => {
          if (!_isPreviewCurrent(generation)) return
          previewBody.innerHTML = ''
          previewBody.appendChild(img)
          resEl.textContent = `${img.naturalWidth} \u00D7 ${img.naturalHeight}`
          resEl.classList.add('visible')
          _attachImageZoom(img, generation)
        }
        img.onerror = () => {
          if (_isPreviewCurrent(generation)) previewBody.innerHTML = '<div class="preview-error">FAILED TO DISPLAY DECRYPTED IMAGE</div>'
        }

      } else if (TEXT_EXTS.includes(extension)) {
        const decodedText = decodeTextBytes(decrypted)
        decodedText.eol = detectEol(decodedText.text)
        const text = decodedText.text
        const blob = new Blob([decrypted], { type: 'text/plain' })
        const blobUrl = URL.createObjectURL(blob)
        _previewBlobUrls.push(blobUrl)

        downloadBtn.href = blobUrl
        downloadBtn.download = fileName

        const byteSize = decrypted.byteLength || new TextEncoder().encode(text).byteLength
        previewBody.innerHTML = ''
        if (byteSize > EDITOR_MAX_SIZE) {
          const notice = document.createElement('div')
          notice.className = 'preview-editor-readonly-notice'
          notice.textContent = 'FILE TOO LARGE TO EDIT (READ-ONLY PREVIEW)'
          previewBody.appendChild(notice)
          const pre = document.createElement('pre')
          pre.className = 'preview-text'
          pre.textContent = text.substring(0, 50000)
          previewBody.appendChild(pre)
        } else {
          const editor = buildTextEditor(text, extension, fileId, true, fileName, decodedText, generation)
          previewBody.appendChild(editor)
        }

      } else if (VIDEO_EXTS.includes(extension)) {
        const blob = new Blob([decrypted], { type: VIDEO_MIME[extension] || 'video/mp4' })
        const blobUrl = URL.createObjectURL(blob)
        _previewBlobUrls.push(blobUrl)

        downloadBtn.href = blobUrl
        downloadBtn.download = fileName

        const video = document.createElement('video')
        video.autoplay = true
        video.className = 'preview-video'
        const source = document.createElement('source')
        source.src = blobUrl
        source.type = VIDEO_MIME[extension] || 'video/mp4'
        video.appendChild(source)
        previewBody.innerHTML = ''
        previewBody.appendChild(video)
        _attachCustomVideoPlayer(video, previewBody)

      } else if (AUDIO_EXTS.includes(extension)) {
        const blob = new Blob([decrypted], { type: AUDIO_MIME[extension] || 'audio/mpeg' })
        const blobUrl = URL.createObjectURL(blob)
        _previewBlobUrls.push(blobUrl)

        downloadBtn.href = blobUrl
        downloadBtn.download = fileName

        const container = document.createElement('div')
        container.className = 'preview-audio-container'
        const icon = document.createElement('div')
        icon.className = 'preview-audio-icon'
        icon.innerHTML = _SVG_AUDIO
        const audioEl = document.createElement('audio')
        audioEl.controls = true
        audioEl.autoplay = true
        audioEl.className = 'preview-audio'
        const source = document.createElement('source')
        source.src = blobUrl
        source.type = AUDIO_MIME[extension] || 'audio/mpeg'
        audioEl.appendChild(source)
        container.appendChild(icon)
        container.appendChild(audioEl)
        previewBody.innerHTML = ''
        previewBody.appendChild(container)

      } else if (PDF_EXTS.includes(extension)) {
        const blob = new Blob([decrypted], { type: 'application/pdf' })
        const blobUrl = URL.createObjectURL(blob)
        _previewBlobUrls.push(blobUrl)

        downloadBtn.href = blobUrl
        downloadBtn.download = fileName

        const iframe = document.createElement('iframe')
        iframe.src = blobUrl
        iframe.className = 'preview-pdf'
        iframe.frameBorder = '0'
        previewBody.innerHTML = ''
        previewBody.appendChild(iframe)

      } else {
        previewBody.innerHTML = '<div class="preview-error">PREVIEW NOT AVAILABLE FOR THIS FILE TYPE</div>'
      }
    } catch (err) {
      if (!_isPreviewCurrent(generation) || (err && err.name === 'AbortError')) return
      console.error('[TEMP E2E PREVIEW]', err)
      previewBody.innerHTML = '<div class="preview-error">DECRYPTION FAILED: ' + _esc(err.message || 'UNKNOWN ERROR') + '</div>'
    }
  }

  // ─── Non-E2E File Preview ─────────────────────────────────────────
  function showFilePreview(fileId, fileName, extension) {
    // Route audio to music player
    if (AUDIO_EXTS.includes(extension) && typeof window.MusicPlayer !== 'undefined') {
      window.MusicPlayer.open(fileId, fileName, extension, false)
      return
    }

    const previewWork = _beginPreviewWork()
    const generation = previewWork.generation
    const signal = previewWork.signal

    const previewBody = document.getElementById('previewBody')
    const previewFileName = document.getElementById('previewFileName')
    const downloadBtn = document.getElementById('previewDownloadBtn')
    const resEl = document.getElementById('previewResolution')

    _setPreviewFileName(previewFileName, fileName)
    previewBody.innerHTML = '<div class="preview-loading">LOADING PREVIEW...</div>'
    resEl.textContent = ''
    resEl.classList.remove('visible')

    downloadBtn.style.display = ''
    downloadBtn.href = `/f/${fileId}/${encodeURIComponent(fileName)}`
    downloadBtn.download = fileName

    openPreview()

    const previewUrl = `/file/${fileId}/preview`

    if (IMAGE_EXTS.includes(extension)) {
      const img = document.createElement('img')
      img.src = previewUrl
      img.className = 'preview-image'
      img.alt = fileName
      img.onload = () => {
        if (!_isPreviewCurrent(generation)) return
        previewBody.innerHTML = ''
        previewBody.appendChild(img)
        resEl.textContent = `${img.naturalWidth} \u00D7 ${img.naturalHeight}`
        resEl.classList.add('visible')
        _attachImageZoom(img, generation)
      }
      img.onerror = () => { if (_isPreviewCurrent(generation)) previewBody.innerHTML = '<div class="preview-error">FAILED TO LOAD IMAGE</div>' }
    } else if (VIDEO_EXTS.includes(extension)) {
      const video = document.createElement('video')
      video.autoplay = true
      video.className = 'preview-video'
      const source = document.createElement('source')
      source.src = previewUrl
      source.type = VIDEO_MIME[extension] || 'video/mp4'
      video.appendChild(source)
      previewBody.innerHTML = ''
      previewBody.appendChild(video)
      _attachCustomVideoPlayer(video, previewBody)
    } else if (AUDIO_EXTS.includes(extension)) {
      const container = document.createElement('div')
      container.className = 'preview-audio-container'
      const icon = document.createElement('div')
      icon.className = 'preview-audio-icon'
      icon.innerHTML = _SVG_AUDIO
      const audioEl = document.createElement('audio')
      audioEl.controls = true
      audioEl.autoplay = true
      audioEl.className = 'preview-audio'
      const source = document.createElement('source')
      source.src = previewUrl
      audioEl.appendChild(source)
      container.appendChild(icon)
      container.appendChild(audioEl)
      previewBody.innerHTML = ''
      previewBody.appendChild(container)
      // Track the play as a download (preview endpoint skips Range requests)
      fetch(`/file/${fileId}/track-play`, {
        method: 'POST',
        headers: { 'X-CSRFToken': getCSRFToken() }
      }).catch(() => {})
    } else if (PDF_EXTS.includes(extension)) {
      const iframe = document.createElement('iframe')
      iframe.src = previewUrl
      iframe.className = 'preview-pdf'
      iframe.frameBorder = '0'
      previewBody.innerHTML = ''
      previewBody.appendChild(iframe)
    } else if (TEXT_EXTS.includes(extension)) {
      fetch(previewUrl, { signal })
        .then(r => {
          // An error page must not be decoded into the editable editor.
          if (!r.ok) throw new Error('HTTP ' + r.status)
          const contentLength = parseInt(r.headers.get('Content-Length') || '0', 10)
          return r.arrayBuffer().then(buf => ({ buf, contentLength }))
        })
        .then(({ buf, contentLength }) => {
          if (!_isPreviewCurrent(generation)) return
          const decodedText = decodeTextBytes(buf)
          decodedText.eol = detectEol(decodedText.text)
          const text = decodedText.text
          const byteSize = contentLength || buf.byteLength
          previewBody.innerHTML = ''
          if (byteSize > EDITOR_MAX_SIZE) {
            const notice = document.createElement('div')
            notice.className = 'preview-editor-readonly-notice'
            notice.textContent = 'FILE TOO LARGE TO EDIT (READ-ONLY PREVIEW)'
            previewBody.appendChild(notice)
            const pre = document.createElement('pre')
            pre.className = 'preview-text'
            pre.textContent = text.substring(0, 50000)
            previewBody.appendChild(pre)
          } else {
            const editor = buildTextEditor(text, extension, fileId, false, fileName, decodedText, generation)
            previewBody.appendChild(editor)
          }
        })
        .catch((err) => {
          if (_isPreviewCurrent(generation) && (!err || err.name !== 'AbortError')) previewBody.innerHTML = '<div class="preview-error">FAILED TO LOAD FILE</div>'
        })
    } else {
      previewBody.innerHTML = '<div class="preview-error">PREVIEW NOT AVAILABLE</div>'
    }
  }

  // ─── Click Handlers ───────────────────────────────────────────────

  // Intercept download button clicks on temp file rows
  document.addEventListener('click', (e) => {
    const downloadBtn = e.target.closest('.temp-browser-row .action-download')
    if (!downloadBtn) return

    const row = downloadBtn.closest('.temp-browser-row')
    if (!row) return

    e.preventDefault()
    e.stopPropagation()

    const fileId = row.dataset.fileId
    const fileName = row.dataset.fileName
    const isE2E = row.dataset.e2e === 'true'

    if (isE2E) {
      _e2eeDownloadFile(fileId, fileName)
    } else {
      _downloadFile(fileId, fileName)
    }
  })

  // Intercept thumbnail / file icon clicks for preview
  document.addEventListener('click', (e) => {
    const thumb = e.target.closest('.temp-browser-row .file-thumbnail') || e.target.closest('.temp-browser-row .file-icon-preview')
    if (!thumb) return

    const row = thumb.closest('.temp-browser-row')
    if (!row) return
    if (row.dataset.previewable !== 'true') return

    e.preventDefault()
    e.stopPropagation()

    const fileId = row.dataset.fileId
    const fileName = row.dataset.fileName
    const extension = (row.dataset.extension || '').toLowerCase()
    const isE2E = row.dataset.e2e === 'true'

    if (isE2E) {
      showE2EPreview(fileId, fileName, extension)
    } else {
      showFilePreview(fileId, fileName, extension)
    }
  })

  // Also intercept context menu download action for temp files
  // (The context menu handler in index.html uses window.location.href — we override for E2E)
  const origContextHandler = document.getElementById('contextMenu')
  if (origContextHandler) {
    origContextHandler.addEventListener('click', (e) => {
      const item = e.target.closest('.context-menu-item[data-action="download"]')
      if (!item) return

      const target = window._tempContextMenuTarget
      if (!target) return
      if (!target.classList.contains('temp-browser-row')) return
      if (target.dataset.e2e !== 'true') return

      e.preventDefault()
      e.stopImmediatePropagation()

      const fileId = target.dataset.fileId
      const fileName = target.dataset.fileName
      _e2eeDownloadFile(fileId, fileName)
    }, true) // capture phase to run before the existing handler
  }

})()
