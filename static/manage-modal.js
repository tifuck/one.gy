// ═══════════════════════════════════════════════════════════════
// Shared Manage Modal — used by dashboard.html and index.html
// ═══════════════════════════════════════════════════════════════
//
// Usage:
//   ManageModal.init({
//     showToast:      function(msg, cat) { ... },
//     showConfirm:    function(title, msg, confirmText, icon, variant) { return Promise<bool> },
//     getCSRFToken:   function() { return '...' },
//     onAfterSave:    function() { ... },          // called after any setting save (optional)
//     onClose:        function() { ... },           // called when modal closes (optional)
//     onDelete:       function(type, data) { ... }, // called to handle delete action
//     onDownload:     function(type, data) { ... }, // called to handle download action (optional)
//     fetchManageDataUrl: function(fileId) { ... }, // optional: override manage-data URL
//   })
//
//   ManageModal.openFile(fileId)
//   ManageModal.openFileByToken(managementToken)
//   ManageModal.openFolder(folderId)
//   ManageModal.close()
//
window.ManageModal = (function() {
  'use strict'

  // ─── Config / callbacks (set via init) ──────────────────────
  let cfg = {}

  // ─── Cached DOM refs ─────────────────────────────────────────
  let manageModal, modalClose, modalScroll
  let originalScrollHTML
  let refs = {}
  let currentManageType = null // 'file' | 'folder'
  let currentManageId = null
  let currentManageData = null
  let savingExpiry = false
  let pendingExpiry = null  // latest choice made while a save was in flight
  let savingShareable = false
  let savingE2E = false
  let listenersBound = false
  let manageRequestGeneration = 0
  // Identity of an encryption conversion that is currently running. A conversion
  // downloads, re-crypts and re-uploads a whole payload, which can take minutes.
  // While this is non-null the modal must NOT be retargeted: openFile/openFolder
  // would reassign currentManageData underneath a flow that is still using it,
  // and file A's ciphertext would be POSTed to file B.
  let conversionInFlight = null
  // Same rule while a share-link regeneration awaits the server: the handler
  // writes the rotated id/URL into currentManageData when it returns.
  let regenerateInFlight = null

  function _beginConversion(type, id, name) {
    conversionInFlight = { type: type, id: id, name: name }
    savingE2E = true
  }

  function _endConversion() {
    conversionInFlight = null
    savingE2E = false
  }

  function _blockedByConversion() {
    if (regenerateInFlight) {
      cfg.showToast('SHARE LINK REGENERATION STILL RUNNING — WAIT FOR IT TO FINISH', 'error')
      return true
    }
    if (!conversionInFlight) return false
    const label = String(conversionInFlight.name || conversionInFlight.id || '').toUpperCase()
    cfg.showToast(`ENCRYPTION CONVERSION STILL RUNNING FOR "${label}" — WAIT FOR IT TO FINISH`, 'error')
    return true
  }

  function _isManageTargetActive(generation, type, id, data) {
    return generation === manageRequestGeneration &&
      currentManageType === type && currentManageId === id && currentManageData === data
  }

  function _handleModalCloseClick() {
    closeManageModal()
  }

  function _handleManageModalBackdropClick(e) {
    if (e.target === manageModal) {
      closeManageModal()
    }
  }

  function _handleManageModalKeydown(e) {
    if (e.key === 'Escape' && manageModal && manageModal.classList.contains('manage-modal-visible')) {
      closeManageModal()
    }
  }

  // ─── Utility: compound extension helpers ─────────────────────
  const _COMPOUND_EXT_PREFIXES = new Set(['tar'])

  function _getCompoundExt(filename) {
    if (!filename || !filename.includes('.')) return ''
    const parts = filename.split('.')
    if (parts.length >= 3 && _COMPOUND_EXT_PREFIXES.has(parts[parts.length - 2].toLowerCase())) {
      return (parts[parts.length - 2] + '.' + parts[parts.length - 1]).toLowerCase()
    }
    return parts[parts.length - 1].toLowerCase()
  }

  function _splitNameExt(filename) {
    if (!filename || !filename.includes('.')) return { base: filename || '', ext: '' }
    const parts = filename.split('.')
    if (parts.length >= 3 && _COMPOUND_EXT_PREFIXES.has(parts[parts.length - 2].toLowerCase())) {
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

  function _highlightCmd(raw) {
    // Tokenize a shell command into highlighted spans
    // Handles: command names, flags, pipe operators, quoted strings, rest
    const tokens = []
    let i = 0
    while (i < raw.length) {
      if (raw[i] === '"') {
        let j = i + 1
        while (j < raw.length && raw[j] !== '"') j++
        tokens.push({ type: 'string', text: raw.substring(i, j + 1) })
        i = j + 1
      } else if (raw[i] === '|') {
        tokens.push({ type: 'pipe', text: '|' })
        i++
      } else if (raw[i] === ' ') {
        let j = i
        while (j < raw.length && raw[j] === ' ') j++
        tokens.push({ type: 'space', text: raw.substring(i, j) })
        i = j
      } else if (raw[i] === '-') {
        let j = i
        while (j < raw.length && raw[j] !== ' ' && raw[j] !== '"' && raw[j] !== '|') j++
        tokens.push({ type: 'flag', text: raw.substring(i, j) })
        i = j
      } else {
        let j = i
        while (j < raw.length && raw[j] !== ' ' && raw[j] !== '"' && raw[j] !== '|') j++
        tokens.push({ type: 'word', text: raw.substring(i, j) })
        i = j
      }
    }
    // Known command names to highlight
    const cmds = new Set(['wget', 'curl', 'bash'])
    let html = ''
    for (const t of tokens) {
      const e = _esc(t.text)
      switch (t.type) {
        case 'string': html += '<span class="cmd-str">' + e + '</span>'; break
        case 'pipe':   html += '<span class="cmd-pipe">' + e + '</span>'; break
        case 'flag':   html += '<span class="cmd-flag">' + e + '</span>'; break
        case 'word':   html += cmds.has(t.text) ? '<span class="cmd-bin">' + e + '</span>' : '<span class="cmd-arg">' + e + '</span>'; break
        default:       html += e; break
      }
    }
    return html
  }

  // ─── SVG constants ──────────────────────────────────────────
  const _SVG_AUDIO = '<svg class="audio-note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
  const _SVG_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  const _SVG_FOLDER = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.3a1 1 0 0 0 .71.29h3.79c.83 0 1.5.67 1.5 1.5V11.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V4.5z" fill="#141414"/></svg>'

  // ─── File icon map ──────────────────────────────────────────
  function getFileIcon(name) {
    const ext = _getCompoundExt(name)
    const map = {
      'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'bmp': '🖼️', 'svg': '🖼️', 'webp': '🖼️', 'ico': '🖼️',
      'exe': '⚙️', 'msi': '⚙️',
      'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦', 'bz2': '📦', 'tar.gz': '📦', 'tar.bz2': '📦', 'tar.xz': '📦', 'tar.zst': '📦',
      'pdf': '📕',
      'doc': '📝', 'docx': '📝', 'txt': '📝', 'rtf': '📝', 'odt': '📝',
      'xls': '📊', 'xlsx': '📊', 'csv': '📊', 'ods': '📊',
      'ppt': '📽️', 'pptx': '📽️', 'odp': '📽️',
      'mp4': '🎬', 'avi': '🎬', 'mkv': '🎬', 'mov': '🎬', 'wmv': '🎬', 'flv': '🎬', 'webm': '🎬',
      'mp3': _SVG_AUDIO, 'wav': _SVG_AUDIO, 'flac': _SVG_AUDIO, 'ogg': _SVG_AUDIO, 'm4a': _SVG_AUDIO, 'aac': _SVG_AUDIO,
      'py': '💻', 'js': '💻', 'java': '💻', 'cpp': '💻', 'c': '💻', 'h': '💻', 'cs': '💻', 'php': '💻', 'rb': '💻', 'go': '💻', 'rs': '💻', 'swift': '💻',
      'html': '🌐', 'css': '🌐', 'xml': '🌐', 'json': '🌐', 'yaml': '🌐', 'yml': '🌐',
      'jar': '📱', 'apk': '📱', 'deb': '📱', 'rpm': '📱', 'dmg': '📱', 'pkg': '📱'
    }
    return map[ext] || '📄'
  }

  // Track current thumbnail blob URL for cleanup on modal close
  let _modalThumbBlobUrl = null

  // ─── Open / Close ──────────────────────────────────────────
  function openManageModal() {
    manageModal.classList.remove('manage-modal-hiding')
    manageModal.classList.add('manage-modal-visible')
    window._manageScrollY = window.scrollY
    document.documentElement.classList.add('preview-scroll-lock')
    document.documentElement.style.top = `-${window._manageScrollY}px`
    history.pushState({ manageModal: true }, '')
  }

  function _closeManageModalInternal() {
    if (!manageModal.classList.contains('manage-modal-visible')) return
    manageRequestGeneration++
    const closeGeneration = manageRequestGeneration
    manageModal.classList.add('manage-modal-hiding')
    manageModal.addEventListener('animationend', function handler() {
      if (closeGeneration === manageRequestGeneration) {
        manageModal.classList.remove('manage-modal-visible', 'manage-modal-hiding')
      }
      manageModal.removeEventListener('animationend', handler)
    }, { once: true })
    document.documentElement.classList.remove('preview-scroll-lock')
    document.documentElement.style.top = ''
    window.scrollTo(0, window._manageScrollY || 0)
    closeExpiryDropdown()
    currentManageType = null
    currentManageId = null
    currentManageData = null
    // Revoke thumbnail blob URL to free memory
    if (_modalThumbBlobUrl) { URL.revokeObjectURL(_modalThumbBlobUrl); _modalThumbBlobUrl = null }
    if (typeof cfg.onClose === 'function') cfg.onClose()
  }

  function closeManageModal() {
    if (!manageModal.classList.contains('manage-modal-visible')) return
    _closeManageModalInternal()
    if (history.state && history.state.manageModal) {
      history.back()
    }
  }

  // ─── Show loading state ─────────────────────────────────────
  function showLoading() {
    modalScroll.innerHTML = '<div class="manage-modal-loading">LOADING</div>'
    openManageModal()
  }

  // ─── Restore scroll content ─────────────────────────────────
  function restoreModalContent() {
    modalScroll.innerHTML = originalScrollHTML
    rebindElements()
  }

  // Since we may destroy DOM with innerHTML, keep references fresh
  function rebindElements() {
    refs.icon = document.getElementById('manageModalIcon')
    refs.name = document.getElementById('manageModalName')
    refs.badges = document.getElementById('manageModalBadges')
    refs.details = document.getElementById('manageModalDetails')
    refs.expiryDropdown = document.getElementById('manageExpiryDropdown')
    refs.expiryBtn = document.getElementById('manageExpiryBtn')
    refs.expirySelected = document.getElementById('manageExpirySelected')
    refs.expiryMenu = document.getElementById('manageExpiryMenu')
    refs.shareableToggle = document.getElementById('manageShareableToggle')
    refs.shareableSwitch = document.getElementById('manageShareableSwitch')
    refs.shareableHint = document.getElementById('manageShareableHint')
    refs.shareableLabel = document.getElementById('manageShareableLabel')
    refs.shareableRow = document.getElementById('manageShareableRow')
    refs.e2eToggle = document.getElementById('manageE2EToggle')
    refs.e2eSwitch = document.getElementById('manageE2ESwitch')
    refs.e2eHint = document.getElementById('manageE2EHint')
    refs.e2eLabel = document.getElementById('manageE2ELabel')
    refs.e2eRow = document.getElementById('manageE2ERow')
    refs.shareSection = document.getElementById('manageShareSection')
    refs.shareLink = document.getElementById('manageShareLink')
    refs.shareSpinner = document.getElementById('manageShareSpinner')
    refs.shareCopy = document.getElementById('manageShareCopy')
    refs.regenerateBtn = document.getElementById('manageRegenerateLink')
    refs.wgetSection = document.getElementById('manageWgetSection')
    refs.wgetCommand = document.getElementById('manageWgetCommand')
    refs.wgetCopy = document.getElementById('manageWgetCopy')
    refs.cliSection = document.getElementById('manageCliSection')
    refs.cliCommand = document.getElementById('manageCliCommand')
    refs.cliCopy = document.getElementById('manageCliCopy')
    refs.downloadBtn = document.getElementById('manageDownloadBtn')
    refs.deleteBtn = document.getElementById('manageDeleteBtn')
    refs.copyNameBtn = document.getElementById('manageModalCopyName')

    // Re-bind click listeners
    if (refs.shareCopy) {
      refs.shareCopy.onclick = function() { copyShareLink() }
    }
    if (refs.wgetCopy) {
      refs.wgetCopy.onclick = function() { copyWgetCommand() }
    }
    if (refs.cliCopy) {
      refs.cliCopy.onclick = function() { copyCliCommand() }
    }
    if (refs.regenerateBtn) {
      refs.regenerateBtn.onclick = function() { handleRegenerateLink() }
    }
    if (refs.deleteBtn) {
      refs.deleteBtn.onclick = function(e) { e.stopPropagation(); handleDelete() }
    }
    if (refs.downloadBtn) {
      refs.downloadBtn.onclick = function(e) { handleDownload(e) }
    }
    if (refs.copyNameBtn) {
      refs.copyNameBtn.onclick = function() { copyFileName() }
    }

    // Bind tab switching
    const tabBtns = modalScroll.querySelectorAll('.manage-modal-tab')
    const tabPanes = modalScroll.querySelectorAll('.manage-modal-tab-content')
    tabBtns.forEach(btn => {
      btn.onclick = function() {
        const target = this.dataset.tab
        tabBtns.forEach(b => b.classList.remove('manage-modal-tab-active'))
        tabPanes.forEach(p => p.classList.remove('manage-modal-tab-active'))
        this.classList.add('manage-modal-tab-active')
        const pane = modalScroll.querySelector('.manage-modal-tab-content[data-tab="' + target + '"]')
        if (pane) pane.classList.add('manage-modal-tab-active')
      }
    })
  }

  // ─── Bind change handlers AFTER populate sets checked state ──
  function bindModalChangeHandlers() {
    if (refs.expiryBtn && refs.expiryMenu) {
      refs.expiryBtn.onclick = function(e) {
        e.stopPropagation()
        const isOpen = refs.expiryMenu.classList.contains('show')
        refs.expiryMenu.classList.toggle('show')
        refs.expiryBtn.classList.toggle('active', !isOpen)
      }
      refs.expiryMenu.querySelectorAll('.manage-expiry-item').forEach(function(item) {
        item.onclick = function(e) {
          e.stopPropagation()
          const value = this.dataset.value
          const label = this.textContent
          refs.expirySelected.textContent = label
          refs.expiryMenu.classList.remove('show')
          refs.expiryBtn.classList.remove('active')
          refs.expiryMenu.querySelectorAll('.manage-expiry-item').forEach(function(el) { el.classList.remove('selected') })
          this.classList.add('selected')
          saveExpiry(value)
        }
      })
    }
    if (refs.shareableToggle) {
      refs.shareableToggle.onchange = function() { saveShareable(this.checked) }
    }
    if (refs.e2eToggle) {
      refs.e2eToggle.onchange = function() { handleE2EToggle(this.checked) }
    }
  }

  // ─── In-memory client thumbnail store (shared with script.js) ─────
  // A thumbnail rendered from the PLAINTEXT of an E2E file must never be
  // persisted: unlike TempKeychain it would not be wrapped by the cookie-derived
  // AES key, so a readable preview of E2E content would sit outside the
  // encryption boundary. It lives in memory for the page lifetime only; after a
  // reload the server-side ENCRYPTED thumbnail path (_decryptEncryptedThumbnail)
  // takes over, so nothing is actually lost.
  function _getMemThumbStore() {
    if (!window.__onegyMemThumbs) window.__onegyMemThumbs = new Map()
    return window.__onegyMemThumbs
  }

  // Earlier builds wrote plaintext thumbnails to sessionStorage as `thumb_<id>`.
  // Drop any that are still lying around from a previous page load.
  function _purgeLegacyPlaintextThumbs() {
    try {
      const stale = []
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)
        if (k && k.indexOf('thumb_') === 0) stale.push(k)
      }
      stale.forEach(k => sessionStorage.removeItem(k))
      if (stale.length) console.log(`[MANAGE MODAL] Purged ${stale.length} legacy plaintext thumbnail(s) from sessionStorage`)
    } catch (e) {
      // sessionStorage unavailable
    }
  }

  // ─── Load client-side E2E thumbnail from the in-memory store ───────
  function loadClientThumbnail(fileId, iconEl) {
    try {
      const dataUrl = _getMemThumbStore().get(fileId)
      if (dataUrl) {
        iconEl.innerHTML = `<img src="${dataUrl}" alt="">`
      }
    } catch (err) {
      // in-memory store unavailable
    }
  }

  // ─── Decrypt server-stored encrypted thumbnail (async fallback) ───
  async function _decryptEncryptedThumbnail(data, iconEl, isActive) {
    function _removeModalSpinner() { var s = iconEl.querySelector('.thumb-spinner'); if (s) s.remove() }
    // Skip if sessionStorage already provided a thumbnail
    if (iconEl.querySelector('img')) { _removeModalSpinner(); return }
    // Need a thumbnail nonce to decrypt
    if (!data.enc_thumb_nonce) { _removeModalSpinner(); return }
    // Need OneGyCrypto
    if (typeof OneGyCrypto === 'undefined') { _removeModalSpinner(); return }

    try {
      // Fetch key-info to get encrypted file key + wrapping info
      const keyResp = await fetch('/f/' + data.id + '/key-info')
      if (!keyResp.ok) { _removeModalSpinner(); return }
      const keyInfo = await keyResp.json()
      if (!keyInfo.encrypted_file_key) { _removeModalSpinner(); return }

      let fileKey = null

      if (keyInfo.file_key_salt) {
        // Passphrase-wrapped file — try per-file keychain first, then global sessionStorage
        let passphrase = null
        if (typeof TempKeychain !== 'undefined') {
          try { passphrase = await TempKeychain.get(data.id) } catch (e) {}
        }
        if (!passphrase) {
          try { passphrase = sessionStorage.getItem('e2e_passphrase') } catch (e) {}
        }
        if (!passphrase) { _removeModalSpinner(); return }
        fileKey = await OneGyCrypto.unwrapFileKeyWithPassphrase(
          keyInfo.encrypted_file_key, keyInfo.file_key_nonce, keyInfo.file_key_salt, passphrase
        )
      } else if (typeof OneGyCrypto.hasSessionKeys === 'function' && OneGyCrypto.hasSessionKeys()) {
        // Master-key-wrapped file
        const masterKey = await OneGyCrypto.getMasterKeyFromSession()
        if (!masterKey) { _removeModalSpinner(); return }
        fileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(
          keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
        )
      } else {
        _removeModalSpinner(); return
      }

      // Get encrypted thumbnail data: from inline API response or fetch from endpoint
      let encData
      if (data.enc_thumb) {
        const rawStr = atob(data.enc_thumb)
        encData = new Uint8Array(rawStr.length)
        for (let i = 0; i < rawStr.length; i++) encData[i] = rawStr.charCodeAt(i)
      } else {
        const thumbResp = await fetch('/file/' + data.id + '/e2e-thumbnail')
        if (!thumbResp.ok) { _removeModalSpinner(); return }
        const ab = await thumbResp.arrayBuffer()
        encData = new Uint8Array(ab)
      }

      // Decrypt
      const decrypted = await OneGyCrypto.decryptThumbnail(encData.buffer, data.enc_thumb_nonce, fileKey)
      if (isActive && !isActive()) return
      const blob = new Blob([decrypted], { type: 'image/jpeg' })
      // Revoke previous thumbnail blob URL before creating a new one
      if (_modalThumbBlobUrl) { URL.revokeObjectURL(_modalThumbBlobUrl); _modalThumbBlobUrl = null }
      const blobUrl = URL.createObjectURL(blob)

      // Only replace if modal is still showing this file
      if (currentManageData && currentManageData.id === data.id) {
        _modalThumbBlobUrl = blobUrl
        iconEl.innerHTML = `<img src="${blobUrl}" alt="">`
      } else {
        URL.revokeObjectURL(blobUrl)
      }
    } catch (err) {
      // Decryption failed — keep emoji icon, fail silently
      _removeModalSpinner()
    }
  }

  // ─── Re-encryption Toast Helpers ────────────────────────────
  function getToastEls() {
    return {
      toast: document.getElementById('reencryptToast'),
      title: document.getElementById('reencryptToastTitle'),
      close: document.getElementById('reencryptToastClose'),
      status: document.getElementById('reencryptStatus'),
      bar: document.getElementById('reencryptBar'),
      percent: document.getElementById('reencryptPercent')
    }
  }

  function showReencryptToast(titleText) {
    const t = getToastEls()
    if (!t.toast) return t
    t.title.textContent = titleText
    t.bar.style.width = '0%'
    t.bar.style.background = ''
    t.percent.textContent = '0%'
    t.close.style.display = 'none'
    t.toast.style.display = 'block'
    return t
  }

  function updateReencryptToast(t, status, pct, fileName) {
    if (t.status) t.status.textContent = status
    if (t.bar) t.bar.style.width = pct + '%'
    if (t.percent) t.percent.textContent = Math.round(pct) + '%'
    if (fileName && t.title) t.title.textContent = fileName
  }

  function hideReencryptToast(t) {
    if (!t.toast) return
    t.toast.style.display = 'none'
    t.bar.style.width = '0%'
    t.bar.style.background = ''
  }

  function showReencryptError(t) {
    if (!t.status) return
    if (t.title) t.title.textContent = 'FAILED'
    t.status.textContent = 'FAILED'
    t.percent.textContent = 'ERROR'
    t.bar.style.background = 'linear-gradient(90deg, #E8304A, #DE1833)'
    t.bar.style.width = '100%'
    t.close.style.display = 'block'
    t.close.onclick = () => { hideReencryptToast(t) }
    setTimeout(() => { hideReencryptToast(t) }, 3000)
  }

  // ─── Expiry dropdown helpers ──────────────────────────────────
  const expiryLabels = { '30m': '30 MINUTES', '6h': '6 HOURS', '1d': '1 DAY', '3d': '3 DAYS', '7d': '7 DAYS', 'never': 'NEVER' }

  // Temp uploads: max 7 days, hide "never", relabel 7d as max
  function filterExpiryForTemp(isTemp) {
    if (!refs.expiryMenu) return
    refs.expiryMenu.querySelectorAll('.manage-expiry-item').forEach(function(el) {
      if (el.dataset.value === 'never') {
        el.style.display = isTemp ? 'none' : ''
      }
      if (el.dataset.value === '7d') {
        el.textContent = isTemp ? '7 DAYS (MAX)' : '7 DAYS'
      }
    })
  }

  function setExpiryDropdownValue(value) {
    if (!refs.expirySelected || !refs.expiryMenu) return
    refs.expirySelected.textContent = expiryLabels[value] || 'NEVER'
    refs.expiryMenu.querySelectorAll('.manage-expiry-item').forEach(function(el) {
      el.classList.toggle('selected', el.dataset.value === value)
    })
  }

  function closeExpiryDropdown() {
    if (refs.expiryMenu) refs.expiryMenu.classList.remove('show')
    if (refs.expiryBtn) refs.expiryBtn.classList.remove('active')
  }

  // ─── Save setting via manage endpoint ────────────────────────
  // targetData/targetType let long-running flows pin the resource they started
  // on instead of re-reading the module-level globals after an await.
  async function saveManageSetting(field, value, targetData, targetType) {
    const data = targetData || currentManageData
    const type = targetType || currentManageType
    const formData = new FormData()
    formData.append('csrf_token', cfg.getCSRFToken())
    if (field === 'public' || field === 'browsable' || field === 'e2e') {
      formData.append(field, value ? 'on' : '')
    } else {
      formData.append(field, value)
    }

    let url
    if (type === 'file') {
      url = `/manage/${data.management_token}`
    } else {
      url = `/folder/${data.id}/manage`
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: formData
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      throw new Error(data.error || 'ERROR SAVING SETTINGS')
    }
    return await resp.json()
  }

  // ─── Share Link Spinner Helpers ──────────────────────────────
  function showShareLinkSpinner() {
    if (refs.shareLink) refs.shareLink.value = ''
    if (refs.shareSpinner) refs.shareSpinner.style.display = ''
    if (refs.shareCopy) refs.shareCopy.disabled = true
  }

  function hideShareLinkSpinner() {
    if (refs.shareSpinner) refs.shareSpinner.style.display = 'none'
    if (refs.shareCopy) refs.shareCopy.disabled = false
  }

  // ─── Passphrase-based Share Link (temp/guest E2EE files) ────
  // Looks up the per-file passphrase from TempKeychain (or sessionStorage)
  // and builds a share URL with #passphrase=<base64>. Returns true if built.
  async function _buildPassphraseShareLink(data, isActive) {
    if (!data || !data.is_e2e) return false
    let passphrase = null
    // Per-file keychain first
    if (typeof TempKeychain !== 'undefined') {
      try { passphrase = await TempKeychain.get(data.id) } catch (e) {}
    }
    // Global sessionStorage fallback
    if (!passphrase) {
      try { passphrase = sessionStorage.getItem('e2e_passphrase') } catch (e) {}
    }
    if (!passphrase) return false
    const encoded = btoa(unescape(encodeURIComponent(passphrase)))
    if (refs.shareLink && (!isActive || isActive())) {
      refs.shareLink.value = data.share_url + '#passphrase=' + encoded
    }
    return true
  }

  // ─── E2E Share Link Generation (file) ───────────────────────
  // Returns true when a usable link was produced, false when the flow failed
  // (caller must NOT present a link), and null when it does not apply.
  async function generateE2EShareLink(targetData, targetType, isActive) {
    const data = targetData || currentManageData
    const type = targetType || currentManageType
    if (!data || !data.is_e2e) return null
    const isShareable = type === 'file'
      ? (data.is_public || data.parent_is_browsable)
      : (data.is_browsable || data.inherited_browsable)
    if (!isShareable) return null
    if (typeof OneGyCrypto === 'undefined' || !OneGyCrypto.hasSessionKeys()) return null

    try {
      const masterKey = await OneGyCrypto.getMasterKeyFromSession()
      if (!masterKey) return null

      // Determine resource for HKDF: if file is in a shared folder, use folder share_token
      let hkdfType, hkdfId
      if (data.is_link_shared && data.ancestor_share_token) {
        hkdfType = 'folder'
        hkdfId = data.ancestor_share_token
      } else {
        hkdfType = 'file'
        hkdfId = data.id
      }
      const { linkSecret: derivedSecret, linkKey } = await OneGyCrypto.deriveLinkSecret(masterKey, hkdfType, hkdfId)

      // File-scoped HKDF needs a file-scoped wrap. is_link_shared can be a
      // leftover from a folder share after unshare/move.
      if (hkdfType === 'file') {
        const keyResp = await fetch(`/f/${data.id}/key-info`)
        if (!keyResp.ok) throw new Error(`FAILED TO LOAD FILE KEY (HTTP ${keyResp.status})`)
        const keyInfo = await keyResp.json()
        if (!keyInfo.encrypted_file_key) throw new Error('FILE KEY NOT FOUND')

        const fileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(
          keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
        )

        const linkData = await OneGyCrypto.wrapFileKeyForLink(fileKey, linkKey)

        const linkKeyResp = await fetch(`/f/${data.id}/link-key`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRFToken': cfg.getCSRFToken()
          },
          body: JSON.stringify({
            encrypted_file_key: linkData.encryptedFileKey,
            file_key_nonce: linkData.nonce
          })
        })
        // Without the stored link key the recipient cannot decrypt anything —
        // never hand out a link that only looks correct.
        if (!linkKeyResp.ok) throw new Error(`FAILED TO STORE SHARE LINK KEY (HTTP ${linkKeyResp.status})`)
      }

      if (refs.shareLink && (!isActive || isActive())) {
        refs.shareLink.value = data.share_url + '#passphrase=' + derivedSecret
      }
      if (!isActive || isActive()) data._derivedLinkSecret = derivedSecret
      return true
    } catch (err) {
      console.error('[MANAGE MODAL] E2E share link generation failed:', err)
      if (!isActive || isActive()) {
        data._derivedLinkSecret = null
        if (refs.shareLink) refs.shareLink.value = ''
        cfg.showToast(err.message || 'FAILED TO GENERATE SHARE LINK', 'error')
      }
      return false
    }
  }

  function _folderHasE2EContent(data) {
    return data.is_e2e || (data.e2e_count > 0) || data.has_mixed_e2e
  }

  // ─── E2E Folder Share Link Generation ───────────────────────
  // Returns true when every E2E file in the folder was keyed for the link,
  // false on a hard failure (caller must NOT present a link), null when N/A.
  async function generateE2EFolderShareLink(targetData, isActive) {
    const data = targetData || currentManageData
    if (!data || !_folderHasE2EContent(data)) return null
    if (typeof OneGyCrypto === 'undefined' || !OneGyCrypto.hasSessionKeys()) return null

    let keyed = 0
    let e2eFileCount = 0

    try {
      const masterKey = await OneGyCrypto.getMasterKeyFromSession()
      if (!masterKey) return null

      const ancestor = data.browsable_ancestor
      const targetFolderId = ancestor ? ancestor.id : data.id
      // Use the ancestor's share_token if available, otherwise this folder's
      const effectiveShareToken = ancestor ? ancestor.share_token : data.share_token

      // Derive link secret deterministically via HKDF (never sent to server)
      const { linkSecret: derivedSecret, linkKey } = await OneGyCrypto.deriveLinkSecret(masterKey, 'folder', effectiveShareToken)

      const listResp = await fetch(`/folder/${targetFolderId}/files`)
      if (!listResp.ok) throw new Error(`FAILED TO LOAD FOLDER FILE LIST (HTTP ${listResp.status})`)
      const listData = await listResp.json()
      if (!listData || !Array.isArray(listData.files)) throw new Error('FOLDER FILE LIST UNAVAILABLE')
      const e2eFiles = listData.files.filter(f => f.is_e2e)
      e2eFileCount = e2eFiles.length

      const csrfToken = cfg.getCSRFToken()

      // Batch-fetch all file keys in one request instead of N individual /key-info calls
      if (e2eFiles.length) {
        const fileIds = e2eFiles.map(f => f.id)
        let batchKeys = {}
        try {
          const batchResp = await fetch('/f/batch-key-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrfToken },
            body: JSON.stringify({ file_ids: fileIds })
          })
          if (batchResp.ok) {
            const batchData = await batchResp.json()
            batchKeys = batchData.keys || {}
          }
        } catch (err) {
          console.error('[MANAGE MODAL] Batch key-info fetch failed:', err)
        }

        for (const fileInfo of e2eFiles) {
          try {
            const keyInfo = batchKeys[fileInfo.id]
            if (!keyInfo || !keyInfo.encrypted_file_key) throw new Error('FILE KEY NOT FOUND')

            const fileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(
              keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
            )

            const linkData = await OneGyCrypto.wrapFileKeyForLink(fileKey, linkKey)

            const lkResp = await fetch(`/f/${fileInfo.id}/link-key`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRFToken': csrfToken
              },
              body: JSON.stringify({
                encrypted_file_key: linkData.encryptedFileKey,
                file_key_nonce: linkData.nonce,
                scope: 'folder'
              })
            })
            if (!lkResp.ok) throw new Error(`LINK KEY UPLOAD FAILED (HTTP ${lkResp.status})`)
            keyed++
          } catch (err) {
            console.error(`[MANAGE MODAL] E2E folder link key failed for ${fileInfo.name}:`, err)
          }
        }
      }

      if (keyed < e2eFileCount) {
        throw new Error(`${keyed} OF ${e2eFileCount} FILE LINK KEYS WERE PROVISIONED`)
      }

      // Wrap folder name keys for link sharing (target folder + subfolders)
      try {
        // Wrap the target folder's own name key if it has one
        const nameKeySource = ancestor || data
        if (nameKeySource.encrypted_name_key && nameKeySource.name_key_nonce) {
          const folderNameKey = await OneGyCrypto.unwrapFolderNameKey(nameKeySource.encrypted_name_key, nameKeySource.name_key_nonce, masterKey)
          if (folderNameKey) {
            const linkNameKeyData = await OneGyCrypto.wrapFolderNameKeyForLink(folderNameKey, linkKey)
            const nameResp = await fetch(`/folder/${targetFolderId}/name-link-key`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrfToken },
              body: JSON.stringify({ encrypted_name_key: linkNameKeyData.encryptedNameKey, nonce: linkNameKeyData.nonce })
            })
            if (!nameResp.ok) throw new Error(`FOLDER NAME LINK KEY UPLOAD FAILED (HTTP ${nameResp.status})`)
          }
        }
        // Also wrap name keys for subfolder names visible in the file listing
        const subFolderResp = await fetch(`/files/list/${targetFolderId}`)
        if (!subFolderResp.ok) throw new Error(`FAILED TO LOAD SUBFOLDERS (HTTP ${subFolderResp.status})`)
        const subData = await subFolderResp.json()
        const allFolders = subData.sidebar_folders || []
        const targetIdStr = String(targetFolderId)
        const childrenByParent = new Map()
        for (const sf of allFolders) {
          const parentKey = sf.parent_id === null || sf.parent_id === undefined ? '' : String(sf.parent_id)
          if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, [])
          childrenByParent.get(parentKey).push(sf)
        }
        const subtreeIds = new Set()
        const stack = (childrenByParent.get(targetIdStr) || []).slice()
        while (stack.length) {
          const child = stack.pop()
          const childId = String(child.id)
          if (subtreeIds.has(childId)) continue
          subtreeIds.add(childId)
          const grandchildren = childrenByParent.get(childId) || []
          for (const grandchild of grandchildren) stack.push(grandchild)
        }
        for (const sf of allFolders) {
          if (!subtreeIds.has(String(sf.id))) continue
          if (sf.encrypted_name_key && sf.name_key_nonce) {
            const sfNameKey = await OneGyCrypto.unwrapFolderNameKey(sf.encrypted_name_key, sf.name_key_nonce, masterKey)
            if (sfNameKey) {
              const sfLinkData = await OneGyCrypto.wrapFolderNameKeyForLink(sfNameKey, linkKey)
              const sfNameResp = await fetch(`/folder/${sf.id}/name-link-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrfToken },
                body: JSON.stringify({ encrypted_name_key: sfLinkData.encryptedNameKey, nonce: sfLinkData.nonce })
              })
              if (!sfNameResp.ok) throw new Error(`SUBFOLDER ${sf.id} NAME LINK KEY UPLOAD FAILED (HTTP ${sfNameResp.status})`)
            }
          }
        }
      } catch (nkErr) {
        throw new Error(nkErr.message || 'FOLDER NAME LINK KEY PROVISIONING FAILED')
      }

      // Make the link resolvable only after all content and name keys exist.
      const secretResp = await fetch(`/folder/${targetFolderId}/link-secret`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken': csrfToken
        },
        body: JSON.stringify({})
      })
      if (!secretResp.ok) throw new Error(`FAILED TO ENABLE FOLDER LINK SHARING (HTTP ${secretResp.status})`)

      if (refs.shareLink && (!isActive || isActive())) {
        if (ancestor) refs.shareLink.value = ancestor.share_url + '?folder=' + data.id + '#passphrase=' + derivedSecret
        else refs.shareLink.value = data.share_url + '#passphrase=' + derivedSecret
      }
      if (!isActive || isActive()) data._derivedLinkSecret = derivedSecret

      console.log(`[MANAGE MODAL] Generated folder link keys for ${keyed}/${e2eFileCount} files (target folder: ${targetFolderId})`)
      return true
    } catch (err) {
      console.error('[MANAGE MODAL] E2E folder share link generation failed:', err)
      if (!isActive || isActive()) {
        data._derivedLinkSecret = null
        if (refs.shareLink) refs.shareLink.value = ''
        cfg.showToast(err.message || 'FAILED TO GENERATE FOLDER SHARE LINK', 'error')
      }
      return false
    }
  }

  // ─── Regenerate Share Link Handler ──────────────────────────
  async function handleRegenerateLink() {
    if (!currentManageData) return
    if (!refs.regenerateBtn) return
    // Captured: closing/reopening the modal must not retarget this request.
    const data = currentManageData
    const type = currentManageType

    refs.regenerateBtn.disabled = true
    refs.regenerateBtn.innerHTML = '<span class="toggle-spinner"></span>REGENERATING...'
    refs.regenerateBtn.classList.add('manage-modal-regenerate-working')
    regenerateInFlight = data

    try {
      const isE2EContent = type === 'folder' ? _folderHasE2EContent(data) : data.is_e2e
      if (isE2EContent) {
        data._derivedLinkSecret = null
        if (type === 'file') {
          // The per-file passphrase is keyed by file id, which the server rotates.
          let keptPassphrase = null
          if (typeof TempKeychain !== 'undefined') {
            try { keptPassphrase = await TempKeychain.get(data.id) } catch (e) {}
          }
          const resp = await fetch(`/file/${data.id}/regenerate-link`, {
            method: 'POST',
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': cfg.getCSRFToken() }
          })
          const result = await resp.json().catch(() => ({}))
          if (!resp.ok || !result.success) throw new Error(result.error || `FAILED TO REGENERATE LINK (HTTP ${resp.status})`)
          // Update file ID — backend rotated the UUID
          const oldFileId = data.id
          if (result.new_id) {
            data.id = result.new_id
            if (keptPassphrase) {
              try { await TempKeychain.store(result.new_id, keptPassphrase) } catch (e) {}
            }
            if (cfg.onFileIdChanged) cfg.onFileIdChanged(oldFileId, result.new_id)
          }
          data.share_url = result.share_url
          const builtPpRegen = await _buildPassphraseShareLink(data)
          if (!builtPpRegen) {
            const regenOk = await generateE2EShareLink(data, 'file')
            if (regenOk !== true) {
              await saveManageSetting('public', false, data, type)
              data.is_public = false
              if (refs.shareableToggle) refs.shareableToggle.checked = false
              throw new Error('SHARE LINK KEY UPLOAD FAILED — SHARING WAS DISABLED')
            }
          }
        } else {
          const resp = await fetch(`/folder/${data.id}/regenerate-link`, {
            method: 'POST',
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': cfg.getCSRFToken() }
          })
          const result = await resp.json().catch(() => ({}))
          if (!resp.ok || !result.success) throw new Error(result.error || `FAILED TO REGENERATE LINK (HTTP ${resp.status})`)
          data.share_url = result.share_url
          data.share_token = result.share_token
          const regenFolderOk = await generateE2EFolderShareLink(data)
          if (regenFolderOk !== true) {
            await saveManageSetting('browsable', false, data, type)
            data.is_browsable = false
            if (refs.shareableToggle) refs.shareableToggle.checked = false
            throw new Error('FOLDER SHARE LINK KEYS FAILED — SHARING WAS DISABLED')
          }
        }
      } else {
        if (type === 'file') {
          const resp = await fetch(`/file/${data.id}/regenerate-link`, {
            method: 'POST',
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': cfg.getCSRFToken() }
          })
          const result = await resp.json()
          if (!result.success) throw new Error(result.error || 'FAILED TO REGENERATE LINK')
          // Update file ID — backend rotated the UUID
          const oldFileId = data.id
          if (result.new_id) {
            data.id = result.new_id
            if (cfg.onFileIdChanged) cfg.onFileIdChanged(oldFileId, result.new_id)
          }
          data.share_url = result.share_url
          if (refs.shareLink) refs.shareLink.value = result.share_url
        } else {
          const resp = await fetch(`/folder/${data.id}/regenerate-link`, {
            method: 'POST',
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': cfg.getCSRFToken() }
          })
          const result = await resp.json()
          if (!result.success) throw new Error(result.error || 'FAILED TO REGENERATE LINK')
          data.share_url = result.share_url
          data.share_token = result.share_token
          if (refs.shareLink) refs.shareLink.value = result.share_url
        }
      }

      regenerateInFlight = null
      refs.regenerateBtn.textContent = 'LINK REGENERATED'
      refs.regenerateBtn.classList.remove('manage-modal-regenerate-working')
      refs.regenerateBtn.classList.add('manage-modal-regenerate-success')
      updateWgetVisibility()
      updateCliVisibility()
      console.log(`[MANAGE MODAL] Regenerated share link for ${type}: ${data.name}`)

      setTimeout(function() {
        if (refs.regenerateBtn) {
          refs.regenerateBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> REGENERATE SHARE LINK'
          refs.regenerateBtn.disabled = false
          refs.regenerateBtn.classList.remove('manage-modal-regenerate-success')
        }
      }, 2000)
    } catch (err) {
      regenerateInFlight = null
      console.error('[MANAGE MODAL] Regenerate link failed:', err)
      refs.regenerateBtn.textContent = 'FAILED - TRY AGAIN'
      refs.regenerateBtn.classList.remove('manage-modal-regenerate-working')
      refs.regenerateBtn.disabled = false

      setTimeout(function() {
        if (refs.regenerateBtn) {
          refs.regenerateBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> REGENERATE SHARE LINK'
        }
      }, 3000)
    }
  }

  // ─── Decrypt E2EE filename if available ──────────────────────
  async function _tryDecryptFileName(data) {
    if (!data.encrypted_name || !data.name_nonce || !data.encrypted_file_key) return null
    try {
      let fileKey = null

      // Try master key first (registered users)
      if (typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys()) {
        const masterKey = await OneGyCrypto.getMasterKeyFromSession()
        if (masterKey) {
          try {
            fileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(
              data.encrypted_file_key, data.file_key_nonce, masterKey
            )
          } catch (e) { /* master key path failed, try passphrase */ }
        }
      }

      // Fall back to passphrase (temp/guest uploads)
      if (!fileKey && data.file_key_salt) {
        let passphrase = null
        if (typeof TempKeychain !== 'undefined') {
          try { passphrase = await TempKeychain.get(data.id) } catch (e) {}
        }
        if (!passphrase) {
          try { passphrase = sessionStorage.getItem('e2e_passphrase') } catch (e) {}
        }
        if (passphrase) {
          fileKey = await OneGyCrypto.unwrapFileKeyWithPassphrase(
            data.encrypted_file_key, data.file_key_nonce, data.file_key_salt, passphrase
          )
        }
      }

      if (!fileKey) return null
      return await OneGyCrypto.decryptFileName(data.encrypted_name, data.name_nonce, fileKey)
    } catch (e) {
      return null
    }
  }

  function _updateModalFileName(name) {
    if (!refs.name) return
    refs.name.title = name
    const _mp = _splitNameExt(name)
    if (_mp.ext) {
      refs.name.innerHTML = '<span class="file-name-base">' + _esc(_mp.base) + '</span><span class="file-name-ext">' + _esc(_mp.ext) + '</span>'
    } else {
      refs.name.innerHTML = '<span class="file-name-base">' + _esc(name) + '</span>'
    }
  }

  // ─── Populate file modal ────────────────────────────────────
  function populateFileModal(data, isActive) {
    currentManageData = data
    isActive = isActive || function() { return currentManageData === data }

    // Async: decrypt E2EE filename and update modal display + share URL
    if (data.is_e2e && data.encrypted_name) {
      _tryDecryptFileName(data).then(decryptedName => {
        if (!isActive()) return
        if (decryptedName) {
          data.name = decryptedName
          data._name_decrypted = true
          _updateModalFileName(decryptedName)
           // Update icon if extension changed — but preserve existing thumbnail
          const _existingThumbImg = refs.icon.querySelector('img')
          if (_existingThumbImg) {
            // Thumbnail already loaded (from sessionStorage or prior decrypt) — keep it
            refs.icon.innerHTML = ''
            refs.icon.appendChild(_existingThumbImg)
          } else {
            // No thumbnail yet — set icon and try async decrypt
            refs.icon.innerHTML = `<div class="thumb-spinner"></div><span>${getFileIcon(decryptedName)}</span>`
            _decryptEncryptedThumbnail(data, refs.icon, isActive)
          }
          // Keep decrypted filenames out of server-facing URLs.
          // Preserve short-code share URLs (/s/...).
          if (data.share_url && !data.share_url.includes('/s/')) {
            const d = cfg.domain || window.location.host
            data.share_url = 'https://' + d + '/f/' + data.id
          }
          data.download_url = '/f/' + data.id
          if (refs.downloadBtn) refs.downloadBtn.href = data.download_url
          // Preserve the share link's decryption fragment.
          if (refs.shareLink && refs.shareLink.value) {
            const hashIdx = refs.shareLink.value.indexOf('#')
            const fragment = hashIdx >= 0 ? refs.shareLink.value.substring(hashIdx) : ''
            refs.shareLink.value = data.share_url + fragment
            updateWgetVisibility()
            updateCliVisibility()
          }
        }
      })
    }

    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico']
    const ext = _getCompoundExt(data.name)

    if (!data.is_e2e && (data.has_thumbnail || data.thumbnailable)) {
      // Build the URL via concatenation so the served JS source contains no
      // literal "/file/<placeholder>/thumbnail" token for crawlers to scrape
      // and request un-interpolated (which previously produced server 500s).
      const _thumbUrl = '/file/' + encodeURIComponent(data.id) + '/thumbnail'
      // Build the <img> programmatically — an inline onload=/onerror= attribute
      // injected via innerHTML is exactly the pattern that forces 'unsafe-inline'
      // in the CSP. Visual result is identical: spinner until the image settles.
      refs.icon.innerHTML = '<div class="thumb-spinner"></div>'
      const _thumbNode = new Image()
      _thumbNode.alt = ''
      const _clearThumbSpinner = () => {
        const parent = _thumbNode.parentElement
        if (!parent) return
        const s = parent.querySelector('.thumb-spinner')
        if (s) s.remove()
      }
      _thumbNode.addEventListener('load', _clearThumbSpinner)
      _thumbNode.addEventListener('error', _clearThumbSpinner)
      _thumbNode.src = _thumbUrl
      refs.icon.appendChild(_thumbNode)
    } else if (data.is_e2e) {
      refs.icon.innerHTML = `<div class="thumb-spinner"></div><span>${getFileIcon(data.name)}</span>`
      loadClientThumbnail(data.id, refs.icon)
      // Async fallback: decrypt server-stored encrypted thumbnail
      _decryptEncryptedThumbnail(data, refs.icon, isActive)
    } else if (!data.is_e2e && imageExts.includes(ext)) {
      // Thumbnail may not be ready yet (generated in background thread after upload).
      // Try loading it anyway — the server generates on-the-fly if the file exists on disk.
      refs.icon.innerHTML = `<div class="thumb-spinner"></div><span>${getFileIcon(data.name)}</span>`
      var thumbImg = new Image()
      thumbImg.src = '/file/' + encodeURIComponent(data.id) + '/thumbnail'
      thumbImg.alt = ''
      thumbImg.onload = function() {
        if (!isActive()) return
        refs.icon.innerHTML = ''
        refs.icon.appendChild(thumbImg)
      }
      thumbImg.onerror = function() {
        if (!isActive()) return
        var s = refs.icon.querySelector('.thumb-spinner')
        if (s) s.remove()
      }
    } else {
      refs.icon.innerHTML = `<span>${getFileIcon(data.name)}</span>`
    }

    refs.name.title = data.name
    const _mp = _splitNameExt(data.name)
    if (_mp.ext) {
      refs.name.innerHTML = '<span class="file-name-base">' + _esc(_mp.base) + '</span><span class="file-name-ext">' + _esc(_mp.ext) + '</span>'
    } else {
      refs.name.innerHTML = '<span class="file-name-base">' + _esc(data.name) + '</span>'
    }

    updateModalBadges()

    refs.details.innerHTML = `
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>SIZE</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.size_formatted)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>UPLOADED</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.uploaded)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>DOWNLOADS</strong></span>
        <span class="manage-modal-detail-value"><span class="manage-modal-detail-hint">INCLUDES OWNER VIEWS</span><span>${_esc(data.download_count || 0)}</span></span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>EXPIRATION</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.expires)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>ENCRYPTED</strong></span>
        <span class="manage-modal-detail-value manage-modal-encryption-value ${data.is_e2e ? 'manage-modal-encryption-e2e' : 'manage-modal-encryption-server'}" id="manageEncryptionValue">${data.is_e2e ? 'END-TO-END' : 'SERVER-SIDE'}</span>
      </div>
    `

    filterExpiryForTemp(!!data.is_temp)
    setExpiryDropdownValue(data.selected_expire || (data.is_temp ? '1d' : 'never'))

    refs.shareableLabel.textContent = 'SHAREABLE'
    const isShareable = data.is_public || data.parent_is_browsable
    refs.shareableToggle.checked = isShareable
    if (data.parent_is_browsable) {
      refs.shareableSwitch.classList.add('toggle-switch-locked')
      refs.shareableToggle.disabled = true
      refs.shareableHint.textContent = 'INHERITED FROM PARENT FOLDER'
    } else {
      refs.shareableSwitch.classList.remove('toggle-switch-locked')
      refs.shareableToggle.disabled = false
      refs.shareableHint.textContent = isShareable ? 'ANYONE WITH THE LINK CAN ACCESS' : 'ONLY YOU CAN ACCESS'
    }

    // E2E toggle
    if (refs.e2eRow) {
      refs.e2eRow.style.display = ''
      refs.e2eToggle.checked = data.is_e2e
      refs.e2eSwitch.classList.remove('toggle-switch-locked')
      refs.e2eToggle.disabled = false
      refs.e2eHint.textContent = data.is_e2e ? 'ONLY YOU CAN DECRYPT THIS FILE' : 'SERVER CAN READ THIS FILE'
    }

    // Share section
    if (isShareable) {
      refs.shareSection.style.display = ''
      if (data.is_e2e) {
        showShareLinkSpinner()
        // file_key_salt indicates passphrase-wrapped key (temp/CLI uploads).
        // Use passphrase path for those, HKDF path for master-key-wrapped files.
        const isPassphraseFile = !!data.file_key_salt
        const hasSessionKeys = typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys()
        const _afterLink = () => {
          if (!isActive()) return
          hideShareLinkSpinner()
          updateCliVisibility()
        }
        if (!isPassphraseFile && hasSessionKeys) {
          generateE2EShareLink(data, 'file', isActive).then((linkOk) => {
            // linkOk === false means the link key never reached the server —
            // do NOT fall back to a bare share_url that cannot decrypt.
            _afterLink()
          })
        } else {
          _buildPassphraseShareLink(data, isActive).then((built) => {
            if (!isActive()) return
            if (!built && refs.shareLink) refs.shareLink.value = ''
            _afterLink()
          })
        }
      } else {
        hideShareLinkSpinner()
        refs.shareLink.value = data.share_url
      }
    } else {
      refs.shareSection.style.display = 'none'
    }

    if (refs.regenerateBtn) {
      refs.regenerateBtn.style.display = isShareable ? '' : 'none'
    }

    updateWgetVisibility()
    updateCliVisibility()

    refs.downloadBtn.href = data.download_url

    bindModalChangeHandlers()
  }

  // ─── Decrypt encrypted folder name ──────────────────────────
  async function _tryDecryptFolderName(data) {
    if (!data.encrypted_name || !data.name_nonce || !data.encrypted_name_key || !data.name_key_nonce) return null
    try {
      if (typeof OneGyCrypto === 'undefined' || !OneGyCrypto.hasSessionKeys()) return null
      const masterKey = await OneGyCrypto.getMasterKeyFromSession()
      if (!masterKey) return null
      const nameKey = await OneGyCrypto.unwrapFolderNameKey(data.encrypted_name_key, data.name_key_nonce, masterKey)
      if (!nameKey) return null
      return await OneGyCrypto.decryptFolderName(data.encrypted_name, data.name_nonce, nameKey)
    } catch (e) {
      return null
    }
  }

  // ─── Populate folder modal ──────────────────────────────────
  function populateFolderModal(data, isActive) {
    currentManageData = data
    isActive = isActive || function() { return currentManageData === data }

    refs.icon.innerHTML = '<span>' + _SVG_FOLDER + '</span>'

    refs.name.title = data.name
    refs.name.innerHTML = '<span class="file-name-base">' + _esc(data.name) + '</span>'

    // Decrypt encrypted folder name if E2EE
    if (data.is_e2e && data.encrypted_name) {
      _tryDecryptFolderName(data).then(decryptedName => {
        if (!isActive()) return
        if (decryptedName) {
          data.name = decryptedName
          data._name_decrypted = true
          refs.name.title = decryptedName
          refs.name.innerHTML = '<span class="file-name-base">' + _esc(decryptedName) + '</span>'
        }
      })
    }

    updateModalBadges()

    let encText = '—'
    let encClass = ''
    if ((data.e2e_count > 0 && data.e2e_count < data.file_count) || data.has_mixed_e2e) {
      encText = 'MIXED'
      encClass = 'manage-modal-encryption-mixed'
    } else if (data.e2e_count === data.file_count && data.file_count > 0) {
      encText = 'END-TO-END'
      encClass = 'manage-modal-encryption-e2e'
    } else if (data.file_count > 0) {
      encText = 'SERVER-SIDE'
      encClass = 'manage-modal-encryption-server'
    }

    refs.details.innerHTML = `
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>FILES</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.file_count)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>SIZE</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.folder_size_formatted)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>DOWNLOADS</strong></span>
        <span class="manage-modal-detail-value"><span class="manage-modal-detail-hint">INCLUDES OWNER VIEWS</span><span>${_esc(data.download_count || 0)}</span></span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>CREATED</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.created_at)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>EXPIRATION</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.expires_display)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>ENCRYPTED</strong></span>
        <span class="manage-modal-detail-value manage-modal-encryption-value ${encClass}" id="manageEncryptionValue">${encText}</span>
      </div>
    `

    filterExpiryForTemp(false)
    setExpiryDropdownValue(data.selected_expire || 'never')

    refs.shareableLabel.textContent = 'SHAREABLE'
    const isShareable = data.is_browsable || data.inherited_browsable
    refs.shareableToggle.checked = isShareable
    if (data.inherited_browsable) {
      refs.shareableSwitch.classList.add('toggle-switch-locked')
      refs.shareableToggle.disabled = true
      refs.shareableHint.textContent = 'INHERITED FROM PARENT FOLDER'
    } else {
      refs.shareableSwitch.classList.remove('toggle-switch-locked')
      refs.shareableToggle.disabled = false
      refs.shareableHint.textContent = isShareable ? 'ANYONE WITH THE LINK CAN ACCESS' : 'ONLY YOU CAN ACCESS'
    }

    if (refs.e2eRow) {
      refs.e2eRow.style.display = ''
      refs.e2eToggle.checked = data.is_e2e
      refs.e2eSwitch.classList.remove('toggle-switch-locked')
      refs.e2eToggle.disabled = false
      refs.e2eHint.textContent = data.is_e2e ? 'ALL FILES ARE END-TO-END ENCRYPTED' : 'FILES USE SERVER-SIDE ENCRYPTION'
    }

    if (isShareable) {
      refs.shareSection.style.display = ''
      const ancestor = data.browsable_ancestor
      const hasE2E = _folderHasE2EContent(data)
      if (hasE2E && (data.is_link_shared || (ancestor && ancestor.is_link_shared))) {
        // Folder (or ancestor) is already link-shared — derive secret via HKDF
        showShareLinkSpinner()
        ;(async () => {
          try {
            if (typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys()) {
              const masterKey = await OneGyCrypto.getMasterKeyFromSession()
              if (!isActive()) return
              if (masterKey) {
                const effectiveToken = ancestor ? ancestor.share_token : data.share_token
                const { linkSecret: derivedSecret } = await OneGyCrypto.deriveLinkSecret(masterKey, 'folder', effectiveToken)
                if (!isActive()) return
                if (refs.shareLink) {
                  if (ancestor) {
                    refs.shareLink.value = ancestor.share_url + '?folder=' + data.id + '#passphrase=' + derivedSecret
                  } else {
                    refs.shareLink.value = data.share_url + '#passphrase=' + derivedSecret
                  }
                }
              }
            }
          } catch (e) {
            if (!isActive()) return
            console.error('[MANAGE MODAL] HKDF folder link derivation failed:', e)
          }
          if (!isActive()) return
          hideShareLinkSpinner()
        })()
      } else if (hasE2E) {
        showShareLinkSpinner()
        generateE2EFolderShareLink(data, isActive).then((linkOk) => {
          if (!isActive()) return
          hideShareLinkSpinner()
        })
      } else if (!hasE2E && ancestor) {
        hideShareLinkSpinner()
        refs.shareLink.value = ancestor.share_url + '?folder=' + data.id
      } else {
        hideShareLinkSpinner()
        refs.shareLink.value = data.share_url
      }
    } else {
      refs.shareSection.style.display = 'none'
    }

    if (refs.regenerateBtn) {
      refs.regenerateBtn.style.display = isShareable ? '' : 'none'
    }

    updateWgetVisibility()
    updateCliVisibility()

    refs.downloadBtn.href = data.share_url
    refs.downloadBtn.onclick = function(e) {
      e.preventDefault()
      if (cfg.onDownload) {
        cfg.onDownload('folder', currentManageData)
      }
      closeManageModal()
    }

    bindModalChangeHandlers()
  }

  // ─── Update modal badges ────────────────────────────────────
  function updateModalBadges() {
    if (!refs.badges || !currentManageData) return
    let badgesHtml = ''
    if (currentManageType === 'file') {
      const isPublic = currentManageData.is_public || currentManageData.parent_is_browsable
      if (isPublic) {
        badgesHtml += '<span class="file-badge file-badge-public">🌐 PUBLIC</span>'
      }
    } else {
      const isPublic = currentManageData.is_browsable || currentManageData.inherited_browsable
      if (isPublic) {
        badgesHtml += '<span class="file-badge file-badge-public">🌐 PUBLIC</span>'
      }
    }
    refs.badges.innerHTML = badgesHtml
  }

  // ─── Update encryption status text in details ───────────────
  function updateEncryptionStatus() {
    const el = document.getElementById('manageEncryptionValue')
    if (!el || !currentManageData) return

    el.classList.remove('manage-modal-encryption-e2e', 'manage-modal-encryption-server', 'manage-modal-encryption-mixed')
    el.classList.add('manage-modal-encryption-value')

    if (currentManageType === 'file') {
      if (currentManageData.is_e2e) {
        el.textContent = 'END-TO-END'
        el.classList.add('manage-modal-encryption-e2e')
      } else {
        el.textContent = 'SERVER-SIDE'
        el.classList.add('manage-modal-encryption-server')
      }
    } else {
      const d = currentManageData
      if ((d.e2e_count > 0 && d.e2e_count < d.file_count) || d.has_mixed_e2e) {
        el.textContent = 'MIXED'
        el.classList.add('manage-modal-encryption-mixed')
      } else if (d.e2e_count === d.file_count && d.file_count > 0) {
        el.textContent = 'END-TO-END'
        el.classList.add('manage-modal-encryption-e2e')
      } else if (d.file_count > 0) {
        el.textContent = 'SERVER-SIDE'
        el.classList.add('manage-modal-encryption-server')
      } else {
        el.textContent = '—'
      }
    }
  }

  // ─── Save expiry ────────────────────────────────────────────
  async function saveExpiry(value, targetData, targetType) {
    const data = targetData || currentManageData
    const type = targetType || currentManageType
    if (!data) return
    if (savingExpiry) {
      pendingExpiry = { value: value, data: data, type: type }
      return
    }
    savingExpiry = true
    try {
      await saveManageSetting('expires', value, data, type)
      cfg.showToast('EXPIRATION UPDATED', 'success')
      if (cfg.onAfterSave) cfg.onAfterSave()
    } catch (err) {
      console.error('[MANAGE MODAL] Expiry save error:', err)
      cfg.showToast(err.message || 'FAILED TO UPDATE EXPIRATION', 'error')
    } finally {
      savingExpiry = false
      if (pendingExpiry) {
        const next = pendingExpiry
        pendingExpiry = null
        saveExpiry(next.value, next.data, next.type)
      }
    }
  }

  // ─── Save shareable ─────────────────────────────────────────
  async function saveShareable(checked) {
    if (savingShareable || !currentManageData) return
    const targetType = currentManageType
    const targetId = currentManageId
    const targetData = currentManageData
    const targetGeneration = manageRequestGeneration
    const isTargetActive = function() {
      return _isManageTargetActive(targetGeneration, targetType, targetId, targetData)
    }
    savingShareable = true
    refs.shareableToggle.disabled = true
    refs.shareableSwitch.classList.add('toggle-switch-locked')
    refs.shareableHint.innerHTML = '<span class="toggle-spinner"></span>UPDATING VISIBILITY...'
    try {
      if (targetType === 'file') {
        if (targetData.parent_is_browsable) {
          refs.shareableToggle.checked = true
          refs.shareableToggle.disabled = true
          cfg.showToast('SHAREABLE STATUS IS INHERITED FROM PARENT FOLDER', 'error')
          return
        }

        await saveManageSetting('public', checked, targetData, targetType)
        if (!isTargetActive()) return
        targetData.is_public = checked

        if (checked) {
          refs.shareSection.style.display = ''
          refs.shareableHint.textContent = 'ANYONE WITH THE LINK CAN ACCESS'
          if (refs.regenerateBtn) refs.regenerateBtn.style.display = ''
          if (targetData.is_e2e) {
            showShareLinkSpinner()
            const isPassphraseFile = !!targetData.file_key_salt
            const hasSessionKeys = typeof OneGyCrypto !== 'undefined' && OneGyCrypto.hasSessionKeys()
            let linkOk = false
            if (!isPassphraseFile && hasSessionKeys) {
              linkOk = await generateE2EShareLink(targetData, targetType, isTargetActive)
            } else {
              linkOk = await _buildPassphraseShareLink(targetData, isTargetActive)
            }
            if (!isTargetActive()) return
            hideShareLinkSpinner()
            if (linkOk !== true) {
              try {
                await saveManageSetting('public', false, targetData, targetType)
                if (!isTargetActive()) return
              } catch (rollbackErr) {
                if (!isTargetActive()) return
                refs.shareableToggle.checked = true
                throw new Error('E2E LINK KEY PROVISIONING FAILED AND SHARING MAY STILL BE ENABLED — RETRY DISABLING VISIBILITY')
              }
              targetData.is_public = false
              refs.shareableToggle.checked = false
              refs.shareSection.style.display = 'none'
              refs.shareableHint.textContent = 'ONLY YOU CAN ACCESS'
              if (refs.regenerateBtn) refs.regenerateBtn.style.display = 'none'
              throw new Error('SHARING WAS NOT ENABLED BECAUSE THE E2E LINK KEY COULD NOT BE PROVISIONED')
            }
          } else {
            hideShareLinkSpinner()
            refs.shareLink.value = targetData.share_url
          }
        } else {
          refs.shareSection.style.display = 'none'
          refs.shareableHint.textContent = 'ONLY YOU CAN ACCESS'
          if (refs.regenerateBtn) refs.regenerateBtn.style.display = 'none'
          if (targetData.is_e2e) {
            targetData._derivedLinkSecret = null
          }
        }
        updateWgetVisibility()
        updateCliVisibility()

        if (cfg.onRowBadgeUpdate) cfg.onRowBadgeUpdate('file', targetData.id, checked)
        updateModalBadges()
        cfg.showToast('VISIBILITY UPDATED', 'success')
        if (cfg.onAfterSave) cfg.onAfterSave()

      } else {
        if (targetData.inherited_browsable) {
          refs.shareableToggle.checked = true
          refs.shareableToggle.disabled = true
          cfg.showToast('SHAREABLE STATUS IS INHERITED FROM PARENT FOLDER', 'error')
          return
        }

        const formData = new FormData()
        formData.append('csrf_token', cfg.getCSRFToken())
        formData.append('browsable', checked ? 'on' : '')
        const resp = await fetch(`/folder/${targetData.id}/manage`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body: formData
        })
        if (!isTargetActive()) return
        const result = await resp.json().catch(() => ({}))
        if (!isTargetActive()) return
        if (!resp.ok) throw new Error(result.error || `FAILED TO UPDATE VISIBILITY (HTTP ${resp.status})`)
        if (result.success) {
          targetData.is_browsable = checked
          if (checked) {
            const newUrl = `https://${window.location.host}/f/${targetData.share_token}`
            refs.shareSection.style.display = ''
            targetData.share_url = newUrl
            refs.shareableHint.textContent = 'ANYONE WITH THE LINK CAN ACCESS'
            if (refs.regenerateBtn) refs.regenerateBtn.style.display = ''
            if (_folderHasE2EContent(targetData)) {
              showShareLinkSpinner()
              const folderLinkOk = await generateE2EFolderShareLink(targetData, isTargetActive)
              if (!isTargetActive()) return
              hideShareLinkSpinner()
              if (folderLinkOk !== true) {
                try {
                  await saveManageSetting('browsable', false, targetData, targetType)
                  if (!isTargetActive()) return
                } catch (rollbackErr) {
                  if (!isTargetActive()) return
                  refs.shareableToggle.checked = true
                  throw new Error('E2E LINK KEY PROVISIONING FAILED AND SHARING MAY STILL BE ENABLED — RETRY DISABLING VISIBILITY')
                }
                targetData.is_browsable = false
                refs.shareableToggle.checked = false
                refs.shareSection.style.display = 'none'
                refs.shareableHint.textContent = 'ONLY YOU CAN ACCESS'
                if (refs.regenerateBtn) refs.regenerateBtn.style.display = 'none'
                throw new Error('SHARING WAS NOT ENABLED BECAUSE ALL E2E LINK KEYS COULD NOT BE PROVISIONED')
              }
            } else {
              hideShareLinkSpinner()
              refs.shareLink.value = newUrl
            }
          } else {
            refs.shareSection.style.display = 'none'
            refs.shareableHint.textContent = 'ONLY YOU CAN ACCESS'
            if (refs.regenerateBtn) refs.regenerateBtn.style.display = 'none'
            if (_folderHasE2EContent(targetData)) {
              targetData._derivedLinkSecret = null
            }
          }
          updateWgetVisibility()
          updateCliVisibility()
          if (cfg.onRowBadgeUpdate) cfg.onRowBadgeUpdate('folder', targetData.id, checked)
          updateModalBadges()
          cfg.showToast('VISIBILITY UPDATED', 'success')
          if (cfg.onAfterSave) cfg.onAfterSave()
        } else {
          refs.shareableToggle.checked = !checked
          cfg.showToast(result.error || 'FAILED TO UPDATE VISIBILITY', 'error')
        }
      }
    } catch (err) {
      if (!isTargetActive()) return
      console.error('[MANAGE MODAL] Shareable save error:', err)
      refs.shareableToggle.checked = targetType === 'file'
        ? !!targetData.is_public
        : !!targetData.is_browsable
      cfg.showToast(err.message || 'FAILED TO UPDATE VISIBILITY', 'error')
    } finally {
      savingShareable = false
      if (isTargetActive()) {
        refs.shareableToggle.disabled = false
        refs.shareableSwitch.classList.remove('toggle-switch-locked')
      }
    }
  }

  // ─── E2E Toggle Handler ─────────────────────────────────────
  async function handleE2EToggle(checked) {
    if (savingE2E || !currentManageData) return

    if (currentManageType === 'file') {
      await handleFileE2EToggle(checked)
    } else {
      await handleFolderE2EToggle(checked)
    }
  }

  // ─── File E2E Toggle (single file re-encryption) ────────────
  async function handleFileE2EToggle(checked) {
    const toggle = refs.e2eToggle
    if (!toggle) return

    if (!window.crypto || !window.crypto.subtle || typeof OneGyCrypto === 'undefined') {
      toggle.checked = !checked
      return
    }

    if (!OneGyCrypto.hasSessionKeys()) {
      cfg.showToast('ENCRYPTION KEYS NOT AVAILABLE — PLEASE LOG IN AGAIN', 'error')
      toggle.checked = !checked
      return
    }

    // Pin the target BEFORE the first await. Everything after this point uses
    // `target` only — never the module-level currentManageData, which the user
    // could otherwise retarget by opening another file mid-conversion.
    const target = currentManageData
    const targetType = currentManageType
    const targetId = currentManageId

    const action = checked ? 'ENABLE E2E ENCRYPTION' : 'DISABLE E2E ENCRYPTION'
    const warning = checked
      ? 'THIS WILL DOWNLOAD THE FILE, ENCRYPT IT END-TO-END, AND RE-UPLOAD IT. ONLY YOU WILL BE ABLE TO DECRYPT IT.'
      : 'THIS WILL DECRYPT THE FILE AND RE-ENCRYPT IT WITH SERVER-SIDE ENCRYPTION. THE FILE WILL BE READABLE BY THE SERVER.'

    const confirmed = await cfg.showConfirm(action, warning, action, checked ? '🔐' : '🔒')
    if (!confirmed) {
      toggle.checked = !checked
      return
    }

    if (history.state && history.state.manageModal) {
      history.replaceState(null, '')
    }
    _closeManageModalInternal()

    _beginConversion('file', target.id, target.name)
    const t = showReencryptToast(checked ? 'ENCRYPTING' : 'DECRYPTING')
    updateReencryptToast(t, 'PREPARING...', 0, target.name)

    currentManageData = target
    currentManageType = targetType
    currentManageId = targetId

    try {
      if (checked) {
        updateReencryptToast(t, 'DOWNLOADING FILE...', 10)

        const masterKey = await OneGyCrypto.getMasterKeyFromSession()
        if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')

        const dlResp = await fetch(`/file/${target.id}/preview`)
        if (!dlResp.ok) throw new Error('FAILED TO DOWNLOAD FILE')
        const plainData = await dlResp.arrayBuffer()

        updateReencryptToast(t, 'ENCRYPTING...', 30)

        const fileKey = await OneGyCrypto.generateFileKey()
        const encryptedData = await OneGyCrypto.encryptFileData(
          plainData, fileKey,
          (p) => { updateReencryptToast(t, 'ENCRYPTING...', 30 + p * 30) }
        )
        const wrappedKey = await OneGyCrypto.wrapFileKeyWithMasterKey(fileKey, masterKey)

        // Generate and encrypt thumbnail from the plaintext data
        let encryptedThumbBlob = null
        let thumbNonce = null
        try {
          const plainFile = new File([plainData], target.name, { type: 'application/octet-stream' })
          const thumbBlob = await OneGyCrypto.generateThumbnail(plainFile)
          if (thumbBlob) {
            const thumbData = await thumbBlob.arrayBuffer()
            const encThumb = await OneGyCrypto.encryptThumbnail(thumbData, fileKey)
            encryptedThumbBlob = new Blob([encThumb.data], { type: 'application/octet-stream' })
            thumbNonce = encThumb.nonce
          }
        } catch (thumbErr) {
          console.error('[MANAGE MODAL] Thumbnail generation failed (non-critical):', thumbErr)
        }

        // Encrypt filename with file key (zero-knowledge)
        let encNameData = null
        try {
          const encName = await OneGyCrypto.encryptFileName(target.name, fileKey)
          encNameData = encName
        } catch (e) {
          console.error('[MANAGE MODAL] Filename encryption failed:', e)
          throw new Error('FILENAME ENCRYPTION FAILED')
        }

        updateReencryptToast(t, 'UPLOADING ENCRYPTED FILE...', 60)

        const formData = new FormData()
        // Use generic filename in multipart -- real name is in encrypted_name (zero-knowledge)
        formData.append('file', new Blob([encryptedData], { type: 'application/octet-stream' }), 'encrypted.bin')
        formData.append('encrypted_file_key', wrappedKey.encryptedFileKey)
        formData.append('file_key_nonce', wrappedKey.nonce)
        formData.append('csrf_token', cfg.getCSRFToken())
        if (encryptedThumbBlob && thumbNonce) {
          formData.append('encrypted_thumbnail', encryptedThumbBlob, 'thumb.enc.jpg')
          formData.append('thumbnail_nonce', thumbNonce)
        }
        if (encNameData) {
          formData.append('encrypted_name', encNameData.encryptedName)
          formData.append('name_nonce', encNameData.nameNonce)
          formData.append('stored_extension', OneGyCrypto.extractExtension(target.name))
        }

        const makeResp = await fetch(`/f/${target.id}/make-private`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body: formData
        })
        if (!makeResp.ok) {
          const err = await makeResp.json()
          throw new Error(err.error || 'FAILED TO ENCRYPT FILE')
        }

        const makeResult = await makeResp.json()
        let inheritedLinkKeyFailure = null
        let shareRestoreFailure = false
        let shareRollbackFailure = false
        if (makeResult.needs_link_key && makeResult.ancestor_share_token) {
          if (!cfg.generateLinkKeysForFiles) inheritedLinkKeyFailure = { total: 1, keyed: 0 }
          else {
            const linkResult = await cfg.generateLinkKeysForFiles([target.id], 'folder', makeResult.ancestor_share_token)
            if (!linkResult || linkResult.success !== true) inheritedLinkKeyFailure = linkResult || { total: 1, keyed: 0 }
          }
        }

        target.is_e2e = true
        target._derivedLinkSecret = null

        // If the file was publicly shared before conversion, restore sharing
        // and auto-generate a new E2E link key so the share URL works immediately
        if (makeResult.was_public) {
          updateReencryptToast(t, 'GENERATING SHARE LINK...', 95)
          try {
            await saveManageSetting('public', true, target, 'file')
            target.is_public = true
            const linkOk = await generateE2EShareLink(target, 'file')
            if (linkOk !== true) throw new Error('SHARE LINK KEY UPLOAD FAILED')
          } catch (linkErr) {
            console.error('[MANAGE MODAL] Auto-restore share link failed:', linkErr)
            shareRestoreFailure = true
            try {
              await saveManageSetting('public', false, target, 'file')
              target.is_public = false
            } catch (rollbackErr) {
              console.error('[MANAGE MODAL] Failed to roll back share visibility:', rollbackErr)
              shareRollbackFailure = true
            }
          }
        }

        updateReencryptToast(t, 'COMPLETE!', 100)
        if (shareRollbackFailure) {
          cfg.showToast('FILE ENCRYPTED, BUT SHARE-LINK KEY PROVISIONING AND VISIBILITY ROLLBACK FAILED — SHARING MAY STILL BE ENABLED', 'error')
        } else if (shareRestoreFailure) {
          cfg.showToast('FILE ENCRYPTED, BUT ITS SHARE LINK COULD NOT BE PROVISIONED — SHARING WAS NOT RESTORED', 'error')
        } else if (inheritedLinkKeyFailure) {
          cfg.showToast('FILE ENCRYPTED, BUT ITS INHERITED SHARE-LINK KEY FAILED — FOLDER RECIPIENTS CANNOT DECRYPT IT', 'error')
        } else {
          cfg.showToast('FILE IS NOW END-TO-END ENCRYPTED', 'success')
        }

      } else {
        updateReencryptToast(t, 'LOADING KEYS...', 10)

        const masterKey = await OneGyCrypto.getMasterKeyFromSession()
        if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')

        const keyResp = await fetch(`/f/${target.id}/key-info`)
        if (!keyResp.ok) throw new Error(`FAILED TO LOAD FILE KEY (HTTP ${keyResp.status})`)
        const keyInfo = await keyResp.json()
        if (!keyInfo.encrypted_file_key) throw new Error('FILE KEY NOT FOUND')

        // Resolve the REAL filename deterministically before touching the file.
        // For an E2EE file `target.name` is the server-side placeholder
        // (encrypted_<id>.<ext>); make-public writes whatever `real_name` we send
        // straight into orig_name and then NULLs encrypted_name/name_nonce, so a
        // placeholder here destroys the only copy of the filename forever.
        // Never rely on populateFileModal's un-awaited background decrypt.
        let realName = target.name
        if (keyInfo.encrypted_name && keyInfo.name_nonce) {
          realName = null
          try {
            const nameFileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(
              keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
            )
            realName = await OneGyCrypto.decryptFileName(keyInfo.encrypted_name, keyInfo.name_nonce, nameFileKey)
          } catch (nameErr) {
            console.error('[MANAGE MODAL] Real filename decryption failed:', nameErr)
          }
          if (!realName) throw new Error('FILENAME COULD NOT BE DECRYPTED — CONVERSION ABORTED TO AVOID LOSING THE FILE NAME')
        }

        updateReencryptToast(t, 'DOWNLOADING ENCRYPTED FILE...', 20, realName)

        const encResp = await fetch(`/f/${target.id}/encrypted`)
        if (!encResp.ok) throw new Error('FAILED TO DOWNLOAD ENCRYPTED FILE')
        const encData = await encResp.arrayBuffer()

        updateReencryptToast(t, 'DECRYPTING...', 40)

        const decrypted = await OneGyCrypto.decryptFileForDownload(
          encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey,
          (p) => { updateReencryptToast(t, 'DECRYPTING...', 40 + p * 20) }
        )

        updateReencryptToast(t, 'RE-ENCRYPTING ON SERVER...', 60)

        const formData = new FormData()
        formData.append('file', new Blob([decrypted], { type: 'application/octet-stream' }), realName)
        formData.append('csrf_token', cfg.getCSRFToken())
        // Send real filename so server can restore orig_name
        formData.append('real_name', realName)

        const makeResp = await fetch(`/f/${target.id}/make-public`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body: formData
        })
        if (!makeResp.ok) {
          const err = await makeResp.json().catch(() => ({}))
          throw new Error(err.error || 'FAILED TO DECRYPT FILE')
        }

        updateReencryptToast(t, 'COMPLETE!', 100)
        target.is_e2e = false
        target.name = realName
        target.encrypted_name = null
        target.name_nonce = null
        cfg.showToast('FILE IS NOW USING SERVER-SIDE ENCRYPTION', 'success')
      }

      if (cfg.onRowE2EBadgeUpdate) cfg.onRowE2EBadgeUpdate(target.id, target.is_e2e)

      let _e2eRefreshed = false
      function _doPostE2ERefresh() {
        if (_e2eRefreshed) return
        _e2eRefreshed = true
        // Invalidate cached E2E thumbnail for this file (encryption mode changed)
        if (typeof _invalidateThumbCache === 'function') _invalidateThumbCache(target.id)
        if (cfg.onAfterSave) cfg.onAfterSave()
      }

      t.close.style.display = 'block'
      t.close.onclick = () => {
        hideReencryptToast(t)
        _endConversion()
        _doPostE2ERefresh()
      }
      setTimeout(() => {
        hideReencryptToast(t)
        _endConversion()
        // Refresh after delay so server thumbnail generation can complete
        _doPostE2ERefresh()
      }, 2000)

    } catch (err) {
      console.error('[MANAGE MODAL] E2E toggle error:', err)
      cfg.showToast(err.message || 'RE-ENCRYPTION FAILED', 'error')
      _endConversion()
      showReencryptError(t)
    }
  }

  // ─── Folder E2E Toggle (batch re-encryption) ────────────────
  async function handleFolderE2EToggle(checked) {
    const toggle = refs.e2eToggle
    if (!toggle) return

    if (!window.crypto || !window.crypto.subtle || typeof OneGyCrypto === 'undefined') {
      toggle.checked = !checked
      return
    }

    if (!OneGyCrypto.hasSessionKeys()) {
      cfg.showToast('ENCRYPTION KEYS NOT AVAILABLE — PLEASE LOG IN AGAIN', 'error')
      toggle.checked = !checked
      return
    }

    // Pin the target BEFORE the first await — see handleFileE2EToggle.
    const target = currentManageData
    const targetType = currentManageType
    const targetId = currentManageId

    if (checked) {
      const nonE2ECount = target.file_count - target.e2e_count

      if (nonE2ECount > 0) {
        const confirmed = await cfg.showConfirm(
          'ENABLE E2E ENCRYPTION',
          `THIS WILL DOWNLOAD ${nonE2ECount} FILE${nonE2ECount > 1 ? 'S' : ''}, ENCRYPT THEM END-TO-END, AND RE-UPLOAD. ALL SUBFOLDERS WILL ALSO BE SET TO E2E. ONLY YOU WILL BE ABLE TO DECRYPT THEM.`,
          'ENABLE E2E ENCRYPTION',
          '🔐'
        )
        if (!confirmed) {
          toggle.checked = false
          return
        }

        if (history.state && history.state.manageModal) {
          history.replaceState(null, '')
        }
        _closeManageModalInternal()

        _beginConversion('folder', target.id, target.name)
        const t = showReencryptToast('ENCRYPTING')

        currentManageData = target
        currentManageType = targetType
        currentManageId = targetId

        // Declared outside the try so the catch can report exactly how many
        // files were already converted (i.e. the folder is in a mixed state).
        let succeeded = 0
        let nonE2ETotal = 0
        let linkKeyFailures = 0

        try {
          updateReencryptToast(t, 'FETCHING FILE LIST...', 5)

          const masterKey = await OneGyCrypto.getMasterKeyFromSession()
          if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')

          const listResp = await fetch(`/folder/${target.id}/files`)
          if (!listResp.ok) throw new Error(`FAILED TO LOAD FOLDER FILE LIST (HTTP ${listResp.status})`)
          const listData = await listResp.json()
          if (!listData || !Array.isArray(listData.files)) throw new Error('FOLDER FILE LIST UNAVAILABLE')
          const allFiles = listData.files
          const nonE2EFiles = allFiles.filter(f => !f.is_e2e)
          nonE2ETotal = nonE2EFiles.length
          // The cached file_count/e2e_count said there was work to do. If the
          // authoritative listing disagrees, only an all-E2E listing with at
          // least one file is a verified "already fully converted" state — an
          // empty listing must never be treated as success.
          const alreadyFullyE2E = allFiles.length > 0 && nonE2EFiles.length === 0
          if (!nonE2EFiles.length && !alreadyFullyE2E) {
            throw new Error('FOLDER FILE LIST IS EMPTY — REFRESH AND TRY AGAIN')
          }

          let completed = 0
          for (const fileInfo of nonE2EFiles) {
            updateReencryptToast(t, `ENCRYPTING ${completed + 1}/${nonE2EFiles.length}`, 5 + (completed / nonE2EFiles.length) * 90, fileInfo.name)

            const dlResp = await fetch(`/file/${fileInfo.id}/preview`)
            if (!dlResp.ok) {
              console.error(`[MANAGE MODAL] Failed to download ${fileInfo.name}`)
              completed++
              continue
            }
            const plainData = await dlResp.arrayBuffer()

            const fileKey = await OneGyCrypto.generateFileKey()
            const encryptedData = await OneGyCrypto.encryptFileData(plainData, fileKey)
            const wrappedKey = await OneGyCrypto.wrapFileKeyWithMasterKey(fileKey, masterKey)

            // Generate and encrypt thumbnail from the plaintext data
            let encThumbBlob = null
            let encThumbNonce = null
            try {
              const plainFile = new File([plainData], fileInfo.name, { type: 'application/octet-stream' })
              const thumbBlob = await OneGyCrypto.generateThumbnail(plainFile)
              if (thumbBlob) {
                const thumbData = await thumbBlob.arrayBuffer()
                const encThumb = await OneGyCrypto.encryptThumbnail(thumbData, fileKey)
                encThumbBlob = new Blob([encThumb.data], { type: 'application/octet-stream' })
                encThumbNonce = encThumb.nonce
              }
            } catch (thumbErr) {
              console.error(`[MANAGE MODAL] Thumbnail generation failed for ${fileInfo.name} (non-critical):`, thumbErr)
            }

            const formData = new FormData()
            // Use generic filename in multipart -- real name is in encrypted_name (zero-knowledge)
            formData.append('file', new Blob([encryptedData], { type: 'application/octet-stream' }), 'encrypted.bin')
            formData.append('encrypted_file_key', wrappedKey.encryptedFileKey)
            formData.append('file_key_nonce', wrappedKey.nonce)
            formData.append('csrf_token', cfg.getCSRFToken())
            if (encThumbBlob && encThumbNonce) {
              formData.append('encrypted_thumbnail', encThumbBlob, 'thumb.enc.jpg')
              formData.append('thumbnail_nonce', encThumbNonce)
            }
            const nameRes = await OneGyCrypto.encryptFileName(fileInfo.name, fileKey)
            formData.append('encrypted_name', nameRes.encryptedName)
            formData.append('name_nonce', nameRes.nameNonce)
            formData.append('stored_extension', OneGyCrypto.extractExtension(fileInfo.name))

            const makeResp = await fetch(`/f/${fileInfo.id}/make-private`, {
              method: 'POST',
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
              body: formData
            })

            if (!makeResp.ok) {
              console.error(`[MANAGE MODAL] make-private failed for ${fileInfo.name}`)
            } else {
              succeeded++
              try {
                const makeData = await makeResp.json()
                if (makeData.needs_link_key && makeData.ancestor_share_token) {
                  if (!cfg.generateLinkKeysForFiles) linkKeyFailures++
                  else {
                    const linkResult = await cfg.generateLinkKeysForFiles([fileInfo.id], 'folder', makeData.ancestor_share_token)
                    if (!linkResult || linkResult.success !== true) linkKeyFailures++
                  }
                }
              } catch (lkErr) {
                console.error(`[MANAGE MODAL] Inline link-key for ${fileInfo.name}:`, lkErr)
                linkKeyFailures++
              }
            }

            completed++
          }

          updateReencryptToast(t, 'COMPLETE!', 100)

          // Only flag the folder E2EE when at least one file was actually
          // converted, or the listing verified every file was already E2EE.
          const fullyConverted = alreadyFullyE2E || (nonE2EFiles.length > 0 && succeeded === nonE2EFiles.length)

          if (fullyConverted) {
            // Encrypt the folder name when enabling E2EE
            if (!target.encrypted_name && target.name && !target.name.startsWith('encrypted_folder_')) {
              const nameKey = await OneGyCrypto.generateFolderNameKey()
              const encName = await OneGyCrypto.encryptFolderName(target.name, nameKey)
              const wrappedKey = await OneGyCrypto.wrapFolderNameKey(nameKey, masterKey)
              const encFormData = new FormData()
              encFormData.append('encrypted_name', encName.encryptedName)
              encFormData.append('name_nonce', encName.nameNonce)
              encFormData.append('encrypted_name_key', wrappedKey.encryptedNameKey)
              encFormData.append('name_key_nonce', wrappedKey.nonce)
              encFormData.append('csrf_token', cfg.getCSRFToken())
              const encResp = await fetch(`/folder/${target.id}/encrypt-name`, {
                method: 'POST',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
                body: encFormData
              })
              if (!encResp.ok) {
                throw new Error('FOLDER NAME ENCRYPTION FAILED')
              }
              console.log(`[MANAGE MODAL] Encrypted folder name for folder ${target.id}`)
            }
            await saveManageSetting('e2e', true, target, 'folder')
            target.is_e2e = true
            target.e2e_count = allFiles.length
            target.file_count = allFiles.length
            target.has_mixed_e2e = false
          } else if (succeeded > 0) {
            target.e2e_count = (target.e2e_count || 0) + succeeded
            target.has_mixed_e2e = true
          }

          if (cfg.onRowE2EBadgeUpdate) cfg.onRowE2EBadgeUpdate(target.id, target.is_e2e)

          if (linkKeyFailures > 0) {
            cfg.showToast(`${succeeded} FILE${succeeded === 1 ? '' : 'S'} ENCRYPTED, BUT ${linkKeyFailures} INHERITED SHARE-LINK KEY${linkKeyFailures === 1 ? '' : 'S'} FAILED`, 'error')
          } else if (alreadyFullyE2E) {
            cfg.showToast('ALL FILES IN THIS FOLDER WERE ALREADY END-TO-END ENCRYPTED', 'success')
          } else if (fullyConverted) {
            cfg.showToast(`${succeeded} FILE${succeeded > 1 ? 'S' : ''} ENCRYPTED END-TO-END`, 'success')
          } else if (succeeded > 0) {
            cfg.showToast(`${succeeded}/${nonE2EFiles.length} FILES ENCRYPTED. ${nonE2EFiles.length - succeeded} FAILED — FOLDER IS IN A MIXED STATE`, 'error')
          } else {
            cfg.showToast('FAILED TO ENCRYPT FILES — CHECK CONSOLE FOR DETAILS', 'error')
          }

          let _batchEncRefreshed = false
          function _doBatchEncRefresh() {
            if (_batchEncRefreshed) return
            _batchEncRefreshed = true
            // Clear entire E2E thumbnail cache (batch conversion changes many files)
            if (typeof _e2eThumbCache !== 'undefined') { _e2eThumbCache.forEach(u => URL.revokeObjectURL(u)); _e2eThumbCache.clear() }
            if (cfg.onAfterSave) cfg.onAfterSave()
          }
          t.close.style.display = 'block'
          t.close.onclick = () => { hideReencryptToast(t); _endConversion(); _doBatchEncRefresh() }
          setTimeout(() => {
            hideReencryptToast(t)
            _endConversion()
            _doBatchEncRefresh()
          }, 2000)

        } catch (err) {
          console.error('[MANAGE MODAL] Folder E2E enable error:', err)
          const baseMsg = err.message || 'RE-ENCRYPTION FAILED'
          // Say exactly how many files were already converted so the user knows
          // the folder is now mixed rather than untouched.
          cfg.showToast(
            succeeded > 0
              ? `${baseMsg} — ${succeeded}/${nonE2ETotal} FILE${succeeded > 1 ? 'S' : ''} ALREADY ENCRYPTED, FOLDER IS IN A MIXED STATE`
              : baseMsg,
            'error'
          )
          if (succeeded > 0) {
            target.e2e_count = (target.e2e_count || 0) + succeeded
            target.has_mixed_e2e = true
            if (cfg.onAfterSave) cfg.onAfterSave()
          }
          _endConversion()
          showReencryptError(t)
        }
        return
      }

      try {
        // Encrypt the folder name when enabling E2EE (no files to re-encrypt path)
        if (!target.encrypted_name && target.name && !target.name.startsWith('encrypted_folder_')) {
          const masterKey = await OneGyCrypto.getMasterKeyFromSession()
          if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')
          const nameKey = await OneGyCrypto.generateFolderNameKey()
          const encName = await OneGyCrypto.encryptFolderName(target.name, nameKey)
          const wrappedKey = await OneGyCrypto.wrapFolderNameKey(nameKey, masterKey)
          const encFormData = new FormData()
          encFormData.append('encrypted_name', encName.encryptedName)
          encFormData.append('name_nonce', encName.nameNonce)
          encFormData.append('encrypted_name_key', wrappedKey.encryptedNameKey)
          encFormData.append('name_key_nonce', wrappedKey.nonce)
          encFormData.append('csrf_token', cfg.getCSRFToken())
          const encResp = await fetch(`/folder/${target.id}/encrypt-name`, {
            method: 'POST',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            body: encFormData
          })
          if (!encResp.ok) {
            throw new Error('FOLDER NAME ENCRYPTION FAILED')
          }
        }
        await saveManageSetting('e2e', true, target, 'folder')
        target.is_e2e = true
        target.has_mixed_e2e = false
        updateModalBadges()
        updateEncryptionStatus()
        updateE2EHint()
        if (cfg.onRowE2EBadgeUpdate) cfg.onRowE2EBadgeUpdate(target.id, true)
        if (cfg.onAfterSave) cfg.onAfterSave()
        closeManageModal()
      } catch (err) {
        cfg.showToast(err.message || 'FAILED TO UPDATE SETTINGS', 'error')
        toggle.checked = false
      }
      return

    } else {
      if (target.e2e_count > 0) {
        const confirmed = await cfg.showConfirm(
          'DISABLE E2E ENCRYPTION',
          `THIS WILL DECRYPT ${target.e2e_count} END-TO-END ENCRYPTED FILE${target.e2e_count > 1 ? 'S' : ''} AND RE-ENCRYPT WITH SERVER-SIDE ENCRYPTION. ALL SUBFOLDERS WILL ALSO BE CHANGED. THE FILES WILL BE READABLE BY THE SERVER.`,
          'DISABLE E2E ENCRYPTION',
          '🔒'
        )
        if (!confirmed) {
          toggle.checked = true
          return
        }

        if (history.state && history.state.manageModal) {
          history.replaceState(null, '')
        }
        _closeManageModalInternal()

        _beginConversion('folder', target.id, target.name)
        const t = showReencryptToast('DECRYPTING')

        currentManageData = target
        currentManageType = targetType
        currentManageId = targetId

        // Declared outside the try so the catch can report exactly how many
        // files were already converted (i.e. the folder is in a mixed state).
        let succeeded = 0
        let e2eTotal = 0

        try {
          updateReencryptToast(t, 'FETCHING FILE LIST...', 5)

          const masterKey = await OneGyCrypto.getMasterKeyFromSession()
          if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')

          const listResp = await fetch(`/folder/${target.id}/files`)
          if (!listResp.ok) throw new Error(`FAILED TO LOAD FOLDER FILE LIST (HTTP ${listResp.status})`)
          const listData = await listResp.json()
          if (!listData || !Array.isArray(listData.files)) throw new Error('FOLDER FILE LIST UNAVAILABLE')
          const allFiles = listData.files
          const e2eFiles = allFiles.filter(f => f.is_e2e)
          e2eTotal = e2eFiles.length
          // Same vacuous-success guard as the enable path: an empty listing is
          // never proof that every file is already server-side encrypted.
          const alreadyFullyPlain = allFiles.length > 0 && e2eFiles.length === 0
          if (!e2eFiles.length && !alreadyFullyPlain) {
            throw new Error('FOLDER FILE LIST IS EMPTY — REFRESH AND TRY AGAIN')
          }

          // Pre-decrypt E2EE filenames for toast display and server restore
          for (const fileInfo of e2eFiles) {
            if (!fileInfo.encrypted_name || !fileInfo.name_nonce || !fileInfo.encrypted_file_key || !fileInfo.file_key_nonce) {
              throw new Error('ENCRYPTED FILENAME METADATA MISSING')
            }
            const fk = await OneGyCrypto.unwrapFileKeyWithMasterKey(fileInfo.encrypted_file_key, fileInfo.file_key_nonce, masterKey)
            const realName = await OneGyCrypto.decryptFileName(fileInfo.encrypted_name, fileInfo.name_nonce, fk)
            if (!realName) throw new Error('FILENAME DECRYPTION FAILED')
            fileInfo.name = realName
          }

          let completed = 0
          for (const fileInfo of e2eFiles) {
            updateReencryptToast(t, `DECRYPTING ${completed + 1}/${e2eFiles.length}`, 5 + (completed / e2eFiles.length) * 90, fileInfo.name)

            const keyResp = await fetch(`/f/${fileInfo.id}/key-info`)
            if (!keyResp.ok) {
              console.error(`[MANAGE MODAL] key-info failed for ${fileInfo.name} (HTTP ${keyResp.status})`)
              completed++
              continue
            }
            const keyInfo = await keyResp.json()
            if (!keyInfo.encrypted_file_key) {
              console.error(`[MANAGE MODAL] No file key for ${fileInfo.name}`)
              completed++
              continue
            }

            const encResp = await fetch(`/f/${fileInfo.id}/encrypted`)
            if (!encResp.ok) {
              console.error(`[MANAGE MODAL] Failed to download ${fileInfo.name}`)
              completed++
              continue
            }
            const encData = await encResp.arrayBuffer()

            const decrypted = await OneGyCrypto.decryptFileForDownload(
              encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
            )

            const formData = new FormData()
            formData.append('file', new Blob([decrypted], { type: 'application/octet-stream' }), fileInfo.name)
            formData.append('csrf_token', cfg.getCSRFToken())
            formData.append('real_name', fileInfo.name)

            const makeResp = await fetch(`/f/${fileInfo.id}/make-public`, {
              method: 'POST',
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
              body: formData
            })

            if (!makeResp.ok) {
              console.error(`[MANAGE MODAL] make-public failed for ${fileInfo.name}`)
            } else {
              succeeded++
            }

            completed++
          }

          updateReencryptToast(t, 'COMPLETE!', 100)

          // Only clear the folder's E2EE flag when at least one file was really
          // converted, or the listing verified none were E2EE to begin with.
          const fullyConverted = alreadyFullyPlain || (e2eFiles.length > 0 && succeeded === e2eFiles.length)

          if (fullyConverted) {
            await saveManageSetting('e2e', false, target, 'folder')
            target.is_e2e = false
            target.e2e_count = 0
            target.has_mixed_e2e = false
            // Restore plaintext folder name when disabling E2EE
            if (target._name_decrypted && target.name) {
              try {
                const renameForm = new FormData()
                renameForm.append('name', target.name)
                renameForm.append('csrf_token', cfg.getCSRFToken())
                await fetch(`/folder/${target.id}/rename`, {
                  method: 'POST',
                  headers: { 'X-Requested-With': 'XMLHttpRequest' },
                  body: renameForm
                })
                console.log(`[MANAGE MODAL] Restored plaintext folder name for folder ${target.id}`)
              } catch (fnErr) {
                console.error('[MANAGE MODAL] Folder name restore failed (non-critical):', fnErr)
              }
            }
          } else if (succeeded > 0) {
            target.e2e_count = e2eFiles.length - succeeded
            target.has_mixed_e2e = true
          }

          if (cfg.onRowE2EBadgeUpdate) cfg.onRowE2EBadgeUpdate(target.id, target.is_e2e)

          if (alreadyFullyPlain) {
            cfg.showToast('NO END-TO-END ENCRYPTED FILES REMAINED IN THIS FOLDER', 'success')
          } else if (fullyConverted) {
            cfg.showToast(`${succeeded} FILE${succeeded > 1 ? 'S' : ''} CONVERTED TO SERVER-SIDE ENCRYPTION`, 'success')
          } else if (succeeded > 0) {
            cfg.showToast(`${succeeded}/${e2eFiles.length} FILES CONVERTED. ${e2eFiles.length - succeeded} FAILED — FOLDER IS IN A MIXED STATE`, 'error')
          } else {
            cfg.showToast('FAILED TO CONVERT FILES — CHECK CONSOLE FOR DETAILS', 'error')
          }

          let _batchDecRefreshed = false
          function _doBatchDecRefresh() {
            if (_batchDecRefreshed) return
            _batchDecRefreshed = true
            // Clear entire E2E thumbnail cache (batch conversion changes many files)
            if (typeof _e2eThumbCache !== 'undefined') { _e2eThumbCache.forEach(u => URL.revokeObjectURL(u)); _e2eThumbCache.clear() }
            if (cfg.onAfterSave) cfg.onAfterSave()
          }
          t.close.style.display = 'block'
          t.close.onclick = () => { hideReencryptToast(t); _endConversion(); _doBatchDecRefresh() }
          setTimeout(() => {
            hideReencryptToast(t)
            _endConversion()
            _doBatchDecRefresh()
          }, 2000)

        } catch (err) {
          console.error('[MANAGE MODAL] Folder E2E disable error:', err)
          const baseMsg = err.message || 'RE-ENCRYPTION FAILED'
          // Say exactly how many files were already converted so the user knows
          // the folder is now mixed rather than untouched.
          cfg.showToast(
            succeeded > 0
              ? `${baseMsg} — ${succeeded}/${e2eTotal} FILE${succeeded > 1 ? 'S' : ''} ALREADY CONVERTED, FOLDER IS IN A MIXED STATE`
              : baseMsg,
            'error'
          )
          if (succeeded > 0) {
            target.e2e_count = Math.max(0, (target.e2e_count || 0) - succeeded)
            target.has_mixed_e2e = true
            if (cfg.onAfterSave) cfg.onAfterSave()
          }
          _endConversion()
          showReencryptError(t)
        }
        return
      }

      try {
        await saveManageSetting('e2e', false, target, 'folder')
        target.is_e2e = false
        target.has_mixed_e2e = false
        updateModalBadges()
        updateEncryptionStatus()
        updateE2EHint()
        if (cfg.onRowE2EBadgeUpdate) cfg.onRowE2EBadgeUpdate(target.id, false)
        if (cfg.onAfterSave) cfg.onAfterSave()
        closeManageModal()
      } catch (err) {
        cfg.showToast(err.message || 'FAILED TO UPDATE SETTINGS', 'error')
        toggle.checked = true
      }
      return
    }
  }

  // ─── Update E2E hint text ───────────────────────────────────
  function updateE2EHint() {
    if (!refs.e2eHint || !currentManageData) return
    if (currentManageType === 'file') {
      refs.e2eHint.textContent = currentManageData.is_e2e ? 'ONLY YOU CAN DECRYPT THIS FILE' : 'SERVER CAN READ THIS FILE'
    } else {
      refs.e2eHint.textContent = currentManageData.is_e2e ? 'ALL FILES ARE END-TO-END ENCRYPTED' : 'FILES USE SERVER-SIDE ENCRYPTION'
    }
  }

  // ─── Copy share link ────────────────────────────────────────
  function copyShareLink() {
    const link = refs.shareLink.value
    if (!link) return
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link).then(() => {
        showCopiedFeedback()
      }).catch(() => {
        fallbackCopy(link)
      })
    } else {
      fallbackCopy(link)
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    showCopiedFeedback()
  }

  function showCopiedFeedback() {
    const btn = refs.shareCopy
    if (!btn) return
    const orig = btn.textContent
    btn.textContent = 'COPIED'
    btn.style.color = '#4ade80'
    btn.style.borderColor = '#4ade80'
    setTimeout(() => {
      btn.textContent = orig
      btn.style.color = ''
      btn.style.borderColor = ''
    }, 1500)
  }

  function copyFileName() {
    if (!currentManageData || !currentManageData.name) return
    const name = currentManageData.name
    const btn = refs.copyNameBtn
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(name).then(() => {
        showCopyNameFeedback(btn)
      }).catch(() => {
        fallbackCopy(name)
        showCopyNameFeedback(btn)
      })
    } else {
      const ta = document.createElement('textarea')
      ta.value = name
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      showCopyNameFeedback(btn)
    }
  }

  function showCopyNameFeedback(btn) {
    if (!btn) return
    btn.classList.add('copied')
    btn.title = 'COPIED!'
    setTimeout(() => {
      btn.classList.remove('copied')
      btn.title = 'COPY FILE NAME'
    }, 1500)
  }

  // ─── Wget command visibility ─────────────────────────────────
  // AUDIT FIX F12: command builder/shell-quoting helpers for the wget + CLI
  // rows. The command is rebuilt from the CURRENT share URL only when one
  // exists, and the stale command is cleared otherwise — the sections used to
  // stay visible with the PREVIOUS file's command (or an empty row) whenever
  // shareLink.value was momentarily empty (the E2E link is generated
  // asynchronously), so the displayed/copied line could disagree with the
  // share link. Shell metacharacters that are legal inside a URL (" \ $ `)
  // are backslash-escaped inside the double-quoted argument so displayed ==
  // copied == shell-safe (a no-op for normal percent-encoded share URLs).
  function _shellQuoteArg(url) {
    return '"' + String(url).replace(/([\\$`"])/g, '\\$1') + '"'
  }

  function _clearWgetCommand() {
    if (refs.wgetCommand) {
      refs.wgetCommand.dataset.cmd = ''
      refs.wgetCommand.innerHTML = ''
    }
  }

  function _clearCliCommand() {
    if (refs.cliCommand) {
      refs.cliCommand.dataset.cmd = ''
      refs.cliCommand.innerHTML = ''
    }
  }

  function updateWgetVisibility() {
    if (!refs.wgetSection || !currentManageData) return
    let isShareable = false
    let isE2E = false
    if (currentManageType === 'file') {
      isShareable = currentManageData.is_public || currentManageData.parent_is_browsable
      isE2E = currentManageData.is_e2e
    } else {
      isShareable = currentManageData.is_browsable || currentManageData.inherited_browsable
      isE2E = currentManageData.is_e2e
    }
    const shareUrl = refs.shareLink ? refs.shareLink.value : ''
    if (isShareable && !isE2E && shareUrl) {
      const raw = 'wget ' + _shellQuoteArg(shareUrl)
      refs.wgetCommand.dataset.cmd = raw
      refs.wgetCommand.innerHTML = _highlightCmd(raw)
      refs.wgetSection.style.display = ''
    } else {
      // No URL (yet), E2E, or not shareable — never show a stale command.
      _clearWgetCommand()
      refs.wgetSection.style.display = 'none'
    }
  }

  function copyWgetCommand() {
    const cmd = refs.wgetCommand ? refs.wgetCommand.dataset.cmd : ''
    if (!cmd) return
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(cmd).then(() => {
        showWgetCopiedFeedback()
      }).catch(() => {
        fallbackCopy(cmd)
        showWgetCopiedFeedback()
      })
    } else {
      fallbackCopy(cmd)
      showWgetCopiedFeedback()
    }
  }

  function showWgetCopiedFeedback() {
    const btn = refs.wgetCopy
    if (!btn) return
    const orig = btn.textContent
    btn.textContent = 'COPIED'
    btn.style.color = '#4ade80'
    btn.style.borderColor = '#4ade80'
    setTimeout(() => {
      btn.textContent = orig
      btn.style.color = ''
      btn.style.borderColor = ''
    }, 1500)
  }

  // ─── CLI bash download command ─────────────────────────────────
  function updateCliVisibility() {
    if (!refs.cliSection || !currentManageData) return
    let isShareable = false
    let isE2E = false
    if (currentManageType === 'file') {
      isShareable = currentManageData.is_public || currentManageData.parent_is_browsable
      isE2E = currentManageData.is_e2e
    } else {
      isShareable = currentManageData.is_browsable || currentManageData.inherited_browsable
      isE2E = currentManageData.is_e2e
    }
    const shareUrl = refs.shareLink ? refs.shareLink.value : ''
    // AUDIT FIX F12: same stale-state fix as the wget row — only show once
    // the E2E share link has actually been built; clear the command otherwise.
    if (isShareable && isE2E && currentManageType === 'file' && shareUrl) {
      const cliDomain = cfg.domain || window.location.host
      const raw = 'curl -fsSL https://' + cliDomain + '/cli.sh | bash -s -- download ' + _shellQuoteArg(shareUrl)
      refs.cliCommand.dataset.cmd = raw
      refs.cliCommand.innerHTML = _highlightCmd(raw)
      refs.cliSection.style.display = ''
    } else {
      _clearCliCommand()
      refs.cliSection.style.display = 'none'
    }
  }

  function copyCliCommand() {
    const cmd = refs.cliCommand ? refs.cliCommand.dataset.cmd : ''
    if (!cmd) return
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(cmd).then(() => {
        showCliCopiedFeedback()
      }).catch(() => {
        fallbackCopy(cmd)
        showCliCopiedFeedback()
      })
    } else {
      fallbackCopy(cmd)
      showCliCopiedFeedback()
    }
  }

  function showCliCopiedFeedback() {
    const btn = refs.cliCopy
    if (!btn) return
    const orig = btn.textContent
    btn.textContent = 'COPIED'
    btn.style.color = '#4ade80'
    btn.style.borderColor = '#4ade80'
    setTimeout(() => {
      btn.textContent = orig
      btn.style.color = ''
      btn.style.borderColor = ''
    }, 1500)
  }

  // ─── Handle delete ──────────────────────────────────────────
  async function handleDelete() {
    if (!currentManageData) return
    if (cfg.onDelete) {
      cfg.onDelete(currentManageType, currentManageData)
    }
  }

  // ─── Handle download ───────────────────────────────────────
  function handleDownload(e) {
    e.preventDefault()
    if (cfg.onDownload) {
      cfg.onDownload(currentManageType, currentManageData)
    } else {
      // Default: navigate to download URL
      if (currentManageData && currentManageData.download_url) {
        window.location.href = currentManageData.download_url
      }
    }
    // Do NOT close the modal here — navigation via window.location.href
    // will leave the page. Calling closeManageModal() would trigger onClose
    // which may reload the page and cancel the pending navigation.
  }

  // ─── Public: open manage for file by ID ─────────────────────
  async function openFile(fileId) {
    // A running conversion still owns currentManageData — retargeting it here
    // would send the in-flight file's ciphertext to this file.
    if (_blockedByConversion()) return
    const generation = ++manageRequestGeneration
    currentManageType = 'file'
    currentManageId = fileId
    showLoading()

    try {
      const url = cfg.fetchManageDataUrl ? cfg.fetchManageDataUrl(fileId) : `/file/${fileId}/manage-data`
      const resp = await fetch(url)
      if (generation !== manageRequestGeneration) return
      if (!resp.ok) {
        cfg.showToast('FAILED TO LOAD FILE SETTINGS', 'error')
        if (generation !== manageRequestGeneration) return
        closeManageModal()
        return
      }
      const data = await resp.json()
      if (generation !== manageRequestGeneration) return
      if (data.error) {
        cfg.showToast(data.error, 'error')
        if (generation !== manageRequestGeneration) return
        closeManageModal()
        return
      }

      currentManageData = data
      restoreModalContent()
      populateFileModal(data, function() {
        return _isManageTargetActive(generation, 'file', fileId, data)
      })
    } catch (err) {
      if (generation !== manageRequestGeneration) return
      console.error('[MANAGE MODAL] Error loading file data:', err)
      cfg.showToast('FAILED TO LOAD FILE SETTINGS', 'error')
      if (generation !== manageRequestGeneration) return
      closeManageModal()
    }
  }

  // ─── Public: open manage for file by management token ───────
  async function openFileByToken(managementToken) {
    if (_blockedByConversion()) return
    const generation = ++manageRequestGeneration
    currentManageType = 'file'
    currentManageId = null
    showLoading()

    try {
      const resp = await fetch(`/file/manage-data-by-token/${managementToken}`)
      if (generation !== manageRequestGeneration) return
      if (!resp.ok) {
        cfg.showToast('FAILED TO LOAD FILE SETTINGS', 'error')
        if (generation !== manageRequestGeneration) return
        closeManageModal()
        return
      }
      const data = await resp.json()
      if (generation !== manageRequestGeneration) return
      if (data.error) {
        cfg.showToast(data.error, 'error')
        if (generation !== manageRequestGeneration) return
        closeManageModal()
        return
      }

      currentManageId = data.id
      currentManageData = data
      restoreModalContent()
      populateFileModal(data, function() {
        return _isManageTargetActive(generation, 'file', data.id, data)
      })
    } catch (err) {
      if (generation !== manageRequestGeneration) return
      console.error('[MANAGE MODAL] Error loading file data by token:', err)
      cfg.showToast('FAILED TO LOAD FILE SETTINGS', 'error')
      if (generation !== manageRequestGeneration) return
      closeManageModal()
    }
  }

  // ─── Public: open manage for folder ─────────────────────────
  async function openFolder(folderId) {
    if (_blockedByConversion()) return
    const generation = ++manageRequestGeneration
    currentManageType = 'folder'
    currentManageId = folderId
    showLoading()

    try {
      const resp = await fetch(`/folder/${folderId}/manage-data`)
      if (generation !== manageRequestGeneration) return
      if (!resp.ok) {
        cfg.showToast('FAILED TO LOAD FOLDER SETTINGS', 'error')
        if (generation !== manageRequestGeneration) return
        closeManageModal()
        return
      }
      const data = await resp.json()
      if (generation !== manageRequestGeneration) return
      if (data.error) {
        cfg.showToast(data.error, 'error')
        if (generation !== manageRequestGeneration) return
        closeManageModal()
        return
      }

      currentManageData = data
      restoreModalContent()
      populateFolderModal(data, function() {
        return _isManageTargetActive(generation, 'folder', folderId, data)
      })
    } catch (err) {
      if (generation !== manageRequestGeneration) return
      console.error('[MANAGE MODAL] Error loading folder data:', err)
      cfg.showToast('FAILED TO LOAD FOLDER SETTINGS', 'error')
      if (generation !== manageRequestGeneration) return
      closeManageModal()
    }
  }

  // ─── Init: bind DOM and event handlers ──────────────────────
  function init(config) {
    cfg = config || {}

    // Required callbacks — provide no-ops as fallbacks
    if (!cfg.showToast) cfg.showToast = function(msg) { console.log('[MANAGE MODAL]', msg) }
    if (!cfg.showConfirm) cfg.showConfirm = function() { return Promise.resolve(false) }
    if (!cfg.getCSRFToken) cfg.getCSRFToken = function() {
      const t = document.querySelector('input[name="csrf_token"]')
      return t ? t.value : ''
    }

    _purgeLegacyPlaintextThumbs()

    manageModal = document.getElementById('manageModal')
    if (!manageModal) {
      console.warn('[MANAGE MODAL] #manageModal not found in DOM — skipping init')
      return
    }

    modalClose = document.getElementById('closeManageModal')
    modalScroll = manageModal.querySelector('.manage-modal-scroll')
    originalScrollHTML = modalScroll.innerHTML

    if (!listenersBound) {
      listenersBound = true

      // Close handlers
      modalClose.addEventListener('click', _handleModalCloseClick)
      manageModal.addEventListener('click', _handleManageModalBackdropClick)
      document.addEventListener('keydown', _handleManageModalKeydown)

      // Close expiry dropdown when clicking outside
      document.addEventListener('click', closeExpiryDropdown)
    }

    // Expose globally for popstate handlers
    window.openFileManageModal = openFile
    window.openFolderManageModal = openFolder
    window.closeManageModal = closeManageModal
    window._closeManageModalInternal = _closeManageModalInternal
  }

  // ─── Public API ─────────────────────────────────────────────
  return {
    init: init,
    openFile: openFile,
    openFileByToken: openFileByToken,
    openFolder: openFolder,
    close: closeManageModal,
    _closeInternal: _closeManageModalInternal,
    // Expose internals for dashboard.js compatibility
    getCurrentData: function() { return currentManageData },
    getCurrentType: function() { return currentManageType },
    getCurrentId: function() { return currentManageId }
  }
})()
