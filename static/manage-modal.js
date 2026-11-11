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
      cfg.showToast('SHARE LINK REGENERATION STILL RUNNING. WAIT FOR IT TO FINISH', 'error')
      return true
    }
    if (!conversionInFlight) return false
    const label = String(conversionInFlight.name || conversionInFlight.id || '').toUpperCase()
    cfg.showToast(`ENCRYPTION CONVERSION STILL RUNNING FOR "${label}". WAIT FOR IT TO FINISH`, 'error')
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
  // Page glyph tinted by file kind (same --kind-* tokens as the Files page).
  // Emoji icons rendered as empty boxes on systems without an emoji font.
  const _KIND_BY_EXT = {}
  ;[['image', 'jpg jpeg png gif bmp svg webp ico heic avif tif tiff'], ['pdf', 'pdf'],
    ['archive', 'zip rar 7z tar gz bz2 xz zst tar.gz tar.bz2 tar.xz tar.zst iso dmg'], ['sheet', 'xls xlsx csv tsv ods numbers'],
    ['doc', 'doc docx txt rtf odt md ppt pptx odp key pages'], ['media', 'mp4 avi mkv mov wmv flv webm m4v'],
    ['code', 'py js ts java cpp c h cs php rb go rs swift kt html css xml json yaml yml toml sh sql']
  ].forEach(function (g) { g[1].split(' ').forEach(function (e) { _KIND_BY_EXT[e] = g[0] }) })
  function getFileIcon(name) {
    const ext = _getCompoundExt(name)
    if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'].indexOf(ext) >= 0) return _SVG_AUDIO
    const kind = _KIND_BY_EXT[ext] || _KIND_BY_EXT[ext.split('.').pop()] || 'file'
    return '<svg viewBox="0 0 40 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" style="color:var(--kind-' + kind + ',var(--accent))"><path d="M7 1.5h18.5L37.5 13.5V42A4.5 4.5 0 0 1 33 46.5H7A4.5 4.5 0 0 1 2.5 42V6A4.5 4.5 0 0 1 7 1.5z"/><path d="M25.5 1.5v8.5a3.5 3.5 0 0 0 3.5 3.5h8.5"/></svg>'
  }

  // Track current thumbnail blob URL for cleanup on modal close
  let _modalThumbBlobUrl = null

  // ─── Open / Close ──────────────────────────────────────────
  function openManageModal() {
    // Retargeting an open modal must not stack another history entry or
    // re-read the scroll position (0 while the page is scroll-locked).
    const alreadyOpen = manageModal.classList.contains('manage-modal-visible') && !manageModal.classList.contains('manage-modal-hiding')
    manageModal.classList.remove('manage-modal-hiding')
    manageModal.classList.add('manage-modal-visible')
    if (alreadyOpen) return
    window._manageScrollY = window.scrollY
    document.documentElement.classList.add('preview-scroll-lock')
    document.documentElement.style.top = `-${window._manageScrollY}px`
    history.pushState({ manageModal: true }, '')
  }

  // Back (browser button, mobile gesture) pops the entry the modal pushed, so
  // it closes the modal instead of leaving it open over a changed page.
  function _handleManageModalPopState() {
    if (!manageModal || !manageModal.classList.contains('manage-modal-visible') || manageModal.classList.contains('manage-modal-hiding')) return
    if (history.state && history.state.manageModal) return
    _closeManageModalInternal()
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
    modalScroll.innerHTML = '<div class="manage-modal-loading">Loading</div>'
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

  // ─── Expiry dropdown helpers ──────────────────────────────────
  const expiryLabels = { '30m': '30 minutes', '6h': '6 hours', '1d': '1 day', '3d': '3 days', '7d': '7 days', 'never': 'Never' }

  // Temp uploads: max 7 days, hide "never", relabel 7d as max
  function filterExpiryForTemp(isTemp) {
    if (!refs.expiryMenu) return
    refs.expiryMenu.querySelectorAll('.manage-expiry-item').forEach(function(el) {
      if (el.dataset.value === 'never') {
        el.style.display = isTemp ? 'none' : ''
      }
      if (el.dataset.value === '7d') {
        el.textContent = isTemp ? '7 days (max)' : '7 days'
      }
    })
  }

  function setExpiryDropdownValue(value) {
    if (!refs.expirySelected || !refs.expiryMenu) return
    refs.expirySelected.textContent = expiryLabels[value] || 'Never'
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
    const result = await resp.json()
    // Turning folder sharing off rotates share_token server-side.
    if (type === 'folder' && result && result.share_token) data.share_token = result.share_token
    return result
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

      // Batch-fetch file keys instead of N individual /key-info calls. The
      // server answers at most 200 ids per request, so send them in chunks.
      if (e2eFiles.length) {
        const fileIds = e2eFiles.map(f => f.id)
        const batchKeys = {}
        for (let i = 0; i < fileIds.length; i += 200) {
          try {
            const batchResp = await fetch('/f/batch-key-info', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrfToken },
              body: JSON.stringify({ file_ids: fileIds.slice(i, i + 200) })
            })
            if (batchResp.ok) {
              const batchData = await batchResp.json()
              Object.assign(batchKeys, batchData.keys || {})
            }
          } catch (err) {
            console.error('[MANAGE MODAL] Batch key-info fetch failed:', err)
          }
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
    refs.regenerateBtn.innerHTML = '<span class="toggle-spinner"></span>Regenerating…'
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
              throw new Error('SHARE LINK KEY UPLOAD FAILED. SHARING WAS DISABLED')
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
            throw new Error('FOLDER SHARE LINK KEYS FAILED. SHARING WAS DISABLED')
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
      refs.regenerateBtn.textContent = 'Link regenerated'
      refs.regenerateBtn.classList.remove('manage-modal-regenerate-working')
      refs.regenerateBtn.classList.add('manage-modal-regenerate-success')
      updateWgetVisibility()
      updateCliVisibility()
      console.log(`[MANAGE MODAL] Regenerated share link for ${type}: ${data.name}`)

      setTimeout(function() {
        if (refs.regenerateBtn) {
          refs.regenerateBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Regenerate share link'
          refs.regenerateBtn.disabled = false
          refs.regenerateBtn.classList.remove('manage-modal-regenerate-success')
        }
      }, 2000)
    } catch (err) {
      regenerateInFlight = null
      console.error('[MANAGE MODAL] Regenerate link failed:', err)
      refs.regenerateBtn.textContent = 'Failed, try again'
      refs.regenerateBtn.classList.remove('manage-modal-regenerate-working')
      refs.regenerateBtn.disabled = false

      setTimeout(function() {
        if (refs.regenerateBtn) {
          refs.regenerateBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Regenerate share link'
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

  // Text thumbnails are rendered as a dark code panel; light themes invert
  // them in CSS (same rule as the Files grid), keyed off data-text.
  function _markTextThumb(name) {
    const e = _getCompoundExt(name || '')
    const media = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v', '3gp', 'pdf']
    refs.icon.toggleAttribute('data-text', !!e && !media.includes(e))
  }

  // ─── Populate file modal ────────────────────────────────────
  function populateFileModal(data, isActive) {
    currentManageData = data
    isActive = isActive || function() { return currentManageData === data }

    // Async: decrypt E2EE filename and update modal display + share URL
    if (data.is_e2e && data.encrypted_name) {
      _decryptFileNameIntoModal(data, isActive)
    }

    _markTextThumb(data.name)
    _populateFileIcon(data, isActive)

    refs.name.title = data.name
    const _mp = _splitNameExt(data.name)
    if (_mp.ext) {
      refs.name.innerHTML = '<span class="file-name-base">' + _esc(_mp.base) + '</span><span class="file-name-ext">' + _esc(_mp.ext) + '</span>'
    } else {
      refs.name.innerHTML = '<span class="file-name-base">' + _esc(data.name) + '</span>'
    }

    updateModalBadges()

    refs.details.innerHTML = _fileDetailsHtml(data)

    filterExpiryForTemp(!!data.is_temp)
    setExpiryDropdownValue(data.selected_expire || (data.is_temp ? '1d' : 'never'))

    refs.shareableLabel.textContent = 'Shareable'
    const isShareable = data.is_public || data.parent_is_browsable
    refs.shareableToggle.checked = isShareable
    if (data.parent_is_browsable) {
      refs.shareableSwitch.classList.add('toggle-switch-locked')
      refs.shareableToggle.disabled = true
      refs.shareableHint.textContent = 'Inherited from parent folder'
    } else {
      refs.shareableSwitch.classList.remove('toggle-switch-locked')
      refs.shareableToggle.disabled = false
      refs.shareableHint.textContent = isShareable ? 'Anyone with the link can access' : 'Only you can access'
    }

    // E2E toggle
    if (refs.e2eRow) {
      refs.e2eRow.style.display = ''
      refs.e2eToggle.checked = data.is_e2e
      refs.e2eSwitch.classList.remove('toggle-switch-locked')
      refs.e2eToggle.disabled = false
      refs.e2eHint.textContent = data.is_e2e ? 'Only you can decrypt this file' : 'The server can read this file'
    }

    // Share section
    if (isShareable) {
      refs.shareSection.style.display = ''
      _populateFileShareLink(data, isActive)
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

  function _decryptFileNameIntoModal(data, isActive) {
    _tryDecryptFileName(data).then(decryptedName => {
      if (!isActive()) return
      if (decryptedName) {
        data.name = decryptedName
        data._name_decrypted = true
        _updateModalFileName(decryptedName)
        _markTextThumb(decryptedName)
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

  function _populateFileIcon(data, isActive) {
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
  }

  function _fileDetailsHtml(data) {
    return `
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Size</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.size_formatted)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Uploaded</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.uploaded)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Downloads</strong></span>
        <span class="manage-modal-detail-value"><span class="manage-modal-detail-hint">Includes owner views</span><span>${_esc(data.download_count || 0)}</span></span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Expiration</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.expires)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Encryption</strong></span>
        <span class="manage-modal-detail-value manage-modal-encryption-value ${data.is_e2e ? 'manage-modal-encryption-e2e' : 'manage-modal-encryption-server'}" id="manageEncryptionValue">${data.is_e2e ? 'End-to-end' : 'Server-side'}</span>
      </div>
    `
  }

  function _populateFileShareLink(data, isActive) {
    if (!data.is_e2e) {
      hideShareLinkSpinner()
      refs.shareLink.value = data.share_url
      return
    }
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

    refs.details.innerHTML = _folderDetailsHtml(data)

    filterExpiryForTemp(false)
    setExpiryDropdownValue(data.selected_expire || 'never')

    refs.shareableLabel.textContent = 'Shareable'
    const isShareable = data.is_browsable || data.inherited_browsable
    refs.shareableToggle.checked = isShareable
    if (data.inherited_browsable) {
      refs.shareableSwitch.classList.add('toggle-switch-locked')
      refs.shareableToggle.disabled = true
      refs.shareableHint.textContent = 'Inherited from parent folder'
    } else {
      refs.shareableSwitch.classList.remove('toggle-switch-locked')
      refs.shareableToggle.disabled = false
      refs.shareableHint.textContent = isShareable ? 'Anyone with the link can access' : 'Only you can access'
    }

    if (refs.e2eRow) {
      refs.e2eRow.style.display = ''
      refs.e2eToggle.checked = data.is_e2e
      refs.e2eSwitch.classList.remove('toggle-switch-locked')
      refs.e2eToggle.disabled = false
      refs.e2eHint.textContent = data.is_e2e ? 'All files are end-to-end encrypted' : 'Files use server-side encryption'
    }

    if (isShareable) {
      refs.shareSection.style.display = ''
      _populateFolderShareLink(data, isActive)
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

  function _folderDetailsHtml(data) {
    let encText = 'No files'
    let encClass = ''
    if ((data.e2e_count > 0 && data.e2e_count < data.file_count) || data.has_mixed_e2e) {
      encText = 'Mixed'
      encClass = 'manage-modal-encryption-mixed'
    } else if (data.e2e_count === data.file_count && data.file_count > 0) {
      encText = 'End-to-end'
      encClass = 'manage-modal-encryption-e2e'
    } else if (data.file_count > 0) {
      encText = 'Server-side'
      encClass = 'manage-modal-encryption-server'
    }

    return `
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Files</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.file_count)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Size</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.folder_size_formatted)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Downloads</strong></span>
        <span class="manage-modal-detail-value"><span class="manage-modal-detail-hint">Includes owner views</span><span>${_esc(data.download_count || 0)}</span></span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Created</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.created_at)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Expiration</strong></span>
        <span class="manage-modal-detail-value">${_esc(data.expires_display)}</span>
      </div>
      <div class="manage-modal-detail">
        <span class="manage-modal-detail-label"><strong>Encryption</strong></span>
        <span class="manage-modal-detail-value manage-modal-encryption-value ${encClass}" id="manageEncryptionValue">${encText}</span>
      </div>
    `
  }

  function _populateFolderShareLink(data, isActive) {
    const ancestor = data.browsable_ancestor
    const hasE2E = _folderHasE2EContent(data)
    if (hasE2E && (data.is_link_shared || (ancestor && ancestor.is_link_shared))) {
      // Folder (or ancestor) is already link-shared — derive secret via HKDF
      showShareLinkSpinner()
      _deriveFolderShareLink(data, ancestor, isActive)
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
  }

  async function _deriveFolderShareLink(data, ancestor, isActive) {
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
  }

  // ─── Update modal badges ────────────────────────────────────
  function updateModalBadges() {
    if (!refs.badges || !currentManageData) return
    let badgesHtml = ''
    if (currentManageType === 'file') {
      const isPublic = currentManageData.is_public || currentManageData.parent_is_browsable
      if (isPublic) {
        badgesHtml += '<span class="file-badge file-badge-public">Public</span>'
      }
    } else {
      const isPublic = currentManageData.is_browsable || currentManageData.inherited_browsable
      if (isPublic) {
        badgesHtml += '<span class="file-badge file-badge-public">Public</span>'
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
        el.textContent = 'End-to-end'
        el.classList.add('manage-modal-encryption-e2e')
      } else {
        el.textContent = 'Server-side'
        el.classList.add('manage-modal-encryption-server')
      }
    } else {
      const d = currentManageData
      if ((d.e2e_count > 0 && d.e2e_count < d.file_count) || d.has_mixed_e2e) {
        el.textContent = 'Mixed'
        el.classList.add('manage-modal-encryption-mixed')
      } else if (d.e2e_count === d.file_count && d.file_count > 0) {
        el.textContent = 'End-to-end'
        el.classList.add('manage-modal-encryption-e2e')
      } else if (d.file_count > 0) {
        el.textContent = 'Server-side'
        el.classList.add('manage-modal-encryption-server')
      } else {
        el.textContent = 'No files'
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
    refs.shareableHint.innerHTML = '<span class="toggle-spinner"></span>Updating visibility…'
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
          refs.shareableHint.textContent = 'Anyone with the link can access'
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
                throw new Error('E2E LINK KEY PROVISIONING FAILED AND SHARING MAY STILL BE ENABLED. RETRY DISABLING VISIBILITY')
              }
              targetData.is_public = false
              refs.shareableToggle.checked = false
              refs.shareSection.style.display = 'none'
              refs.shareableHint.textContent = 'Only you can access'
              if (refs.regenerateBtn) refs.regenerateBtn.style.display = 'none'
              throw new Error('SHARING WAS NOT ENABLED BECAUSE THE E2E LINK KEY COULD NOT BE PROVISIONED')
            }
          } else {
            hideShareLinkSpinner()
            refs.shareLink.value = targetData.share_url
          }
        } else {
          refs.shareSection.style.display = 'none'
          refs.shareableHint.textContent = 'Only you can access'
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
          // Turning sharing off rotates the token; re-enabling must use the new one.
          if (result.share_token) targetData.share_token = result.share_token
          targetData.is_browsable = checked
          if (checked) {
            const newUrl = `https://${window.location.host}/f/${targetData.share_token}`
            refs.shareSection.style.display = ''
            targetData.share_url = newUrl
            refs.shareableHint.textContent = 'Anyone with the link can access'
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
                  throw new Error('E2E LINK KEY PROVISIONING FAILED AND SHARING MAY STILL BE ENABLED. RETRY DISABLING VISIBILITY')
                }
                targetData.is_browsable = false
                refs.shareableToggle.checked = false
                refs.shareSection.style.display = 'none'
                refs.shareableHint.textContent = 'Only you can access'
                if (refs.regenerateBtn) refs.regenerateBtn.style.display = 'none'
                throw new Error('SHARING WAS NOT ENABLED BECAUSE ALL E2E LINK KEYS COULD NOT BE PROVISIONED')
              }
            } else {
              hideShareLinkSpinner()
              refs.shareLink.value = newUrl
            }
          } else {
            refs.shareSection.style.display = 'none'
            refs.shareableHint.textContent = 'Only you can access'
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
  // The conversion itself lives in manage-e2e.js (ManageModalE2E).
  let _e2eConversion = null
  function _conversion() {
    if (!_e2eConversion) {
      _e2eConversion = window.ManageModalE2E({
        cfg: function() { return cfg },
        refs: refs,
        current: function() {
          return { data: currentManageData, type: currentManageType, id: currentManageId }
        },
        setCurrent: function(data, type, id) {
          currentManageData = data
          currentManageType = type
          currentManageId = id
        },
        beginConversion: _beginConversion,
        endConversion: _endConversion,
        closeInternal: _closeManageModalInternal,
        close: closeManageModal,
        saveManageSetting: saveManageSetting,
        generateE2EShareLink: generateE2EShareLink,
        tryDecryptFolderName: _tryDecryptFolderName,
        updateModalBadges: updateModalBadges,
        updateEncryptionStatus: updateEncryptionStatus,
        updateE2EHint: updateE2EHint
      })
    }
    return _e2eConversion
  }

  async function handleE2EToggle(checked) {
    if (savingE2E || !currentManageData) return

    if (currentManageType === 'file') {
      await _conversion().handleFileE2EToggle(checked)
    } else {
      await _conversion().handleFolderE2EToggle(checked)
    }
  }

  // ─── Update E2E hint text ───────────────────────────────────
  function updateE2EHint() {
    if (!refs.e2eHint || !currentManageData) return
    if (currentManageType === 'file') {
      refs.e2eHint.textContent = currentManageData.is_e2e ? 'Only you can decrypt this file' : 'The server can read this file'
    } else {
      refs.e2eHint.textContent = currentManageData.is_e2e ? 'All files are end-to-end encrypted' : 'Files use server-side encryption'
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
      window.addEventListener('popstate', _handleManageModalPopState)

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
