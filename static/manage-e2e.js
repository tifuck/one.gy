// ═══════════════════════════════════════════════════════════════
// Manage Modal: encryption conversion (E2EE on/off for a file or folder)
// ═══════════════════════════════════════════════════════════════
//
// A conversion downloads, re-crypts and re-uploads whole payloads. Load this
// file before manage-modal.js, which builds it with ManageModalE2E(m) and
// hands over the modal internals it needs:
//   m.cfg()                         current ManageModal.init config
//   m.refs                          cached DOM refs
//   m.current() / m.setCurrent(data, type, id)
//   m.beginConversion(type, id, name) / m.endConversion()
//   m.closeInternal() / m.close()
//   m.saveManageSetting, m.generateE2EShareLink, m.tryDecryptFolderName
//   m.updateModalBadges, m.updateEncryptionStatus, m.updateE2EHint
//
window.ManageModalE2E = function(m) {
  'use strict'

  function cfg() { return m.cfg() }

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

  // ─── Shared conversion plumbing ─────────────────────────────
  // Web Crypto and unlocked session keys are required; reverts the toggle if not.
  function _cryptoReady(toggle, checked) {
    if (!window.crypto || !window.crypto.subtle || typeof OneGyCrypto === 'undefined') {
      toggle.checked = !checked
      return false
    }
    if (!OneGyCrypto.hasSessionKeys()) {
      cfg().showToast('ENCRYPTION KEYS NOT AVAILABLE. PLEASE LOG IN AGAIN', 'error')
      toggle.checked = !checked
      return false
    }
    return true
  }

  // Closes the modal without leaving a history entry, claims the conversion
  // lock and re-pins the target that closing the modal cleared.
  function _startConversion(pinned, title) {
    if (history.state && history.state.manageModal) {
      history.replaceState(null, '')
    }
    m.closeInternal()

    m.beginConversion(pinned.type, pinned.data.id, pinned.data.name)
    const t = showReencryptToast(title)

    m.setCurrent(pinned.data, pinned.type, pinned.id)
    return t
  }

  // Close button or a 2s timer hides the toast and releases the lock; the
  // refresh runs once, after the delay so server thumbnail generation can complete.
  function _finishConversion(t, refresh) {
    let refreshed = false
    const done = () => {
      hideReencryptToast(t)
      m.endConversion()
      if (refreshed) return
      refreshed = true
      refresh()
    }
    t.close.style.display = 'block'
    t.close.onclick = done
    setTimeout(done, 2000)
  }

  function _refreshAfterBatch() {
    // Clear entire E2E thumbnail cache (batch conversion changes many files)
    if (typeof _e2eThumbCache !== 'undefined') { _e2eThumbCache.forEach(u => URL.revokeObjectURL(u)); _e2eThumbCache.clear() }
    if (cfg().onAfterSave) cfg().onAfterSave()
  }

  // Generate and encrypt a thumbnail from the plaintext data: { blob, nonce } or null.
  async function _encryptedThumbnail(plainData, name, fileKey) {
    const plainFile = new File([plainData], name, { type: 'application/octet-stream' })
    const thumbBlob = await OneGyCrypto.generateThumbnail(plainFile)
    if (!thumbBlob) return null
    const thumbData = await thumbBlob.arrayBuffer()
    const encThumb = await OneGyCrypto.encryptThumbnail(thumbData, fileKey)
    return { blob: new Blob([encThumb.data], { type: 'application/octet-stream' }), nonce: encThumb.nonce }
  }

  function _makePrivateForm(encryptedData, wrappedKey, encThumb, encName, name) {
    const formData = new FormData()
    // Use generic filename in multipart -- real name is in encrypted_name (zero-knowledge)
    formData.append('file', new Blob([encryptedData], { type: 'application/octet-stream' }), 'encrypted.bin')
    formData.append('encrypted_file_key', wrappedKey.encryptedFileKey)
    formData.append('file_key_nonce', wrappedKey.nonce)
    formData.append('csrf_token', cfg().getCSRFToken())
    if (encThumb && encThumb.nonce) {
      formData.append('encrypted_thumbnail', encThumb.blob, 'thumb.enc.jpg')
      formData.append('thumbnail_nonce', encThumb.nonce)
    }
    if (encName) {
      formData.append('encrypted_name', encName.encryptedName)
      formData.append('name_nonce', encName.nameNonce)
      formData.append('stored_extension', OneGyCrypto.extractExtension(name))
    }
    return formData
  }

  function _makePublicForm(decrypted, realName) {
    const formData = new FormData()
    formData.append('file', new Blob([decrypted], { type: 'application/octet-stream' }), realName)
    formData.append('csrf_token', cfg().getCSRFToken())
    // Send real filename so server can restore orig_name
    formData.append('real_name', realName)
    return formData
  }

  function _postForm(url, formData) {
    return fetch(url, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: formData
    })
  }

  // A file converted inside a link-shared folder needs its own link key.
  // Returns true when that key could not be provisioned.
  async function _inheritedLinkKeyFailed(makeResult, fileId) {
    if (!(makeResult.needs_link_key && makeResult.ancestor_share_token)) return false
    if (!cfg().generateLinkKeysForFiles) return true
    const linkResult = await cfg().generateLinkKeysForFiles([fileId], 'folder', makeResult.ancestor_share_token)
    return !linkResult || linkResult.success !== true
  }

  // ─── File E2E Toggle (single file re-encryption) ────────────
  async function handleFileE2EToggle(checked) {
    const toggle = m.refs.e2eToggle
    if (!toggle) return
    if (!_cryptoReady(toggle, checked)) return

    // Pin the target BEFORE the first await. Everything after this point uses
    // `target` only — never the modal's current target, which the user could
    // otherwise retarget by opening another file mid-conversion.
    const pinned = m.current()
    const target = pinned.data

    const action = checked ? 'ENABLE E2E ENCRYPTION' : 'DISABLE E2E ENCRYPTION'
    const warning = checked
      ? 'THIS WILL DOWNLOAD THE FILE, ENCRYPT IT END-TO-END, AND RE-UPLOAD IT. ONLY YOU WILL BE ABLE TO DECRYPT IT.'
      : 'THIS WILL DECRYPT THE FILE AND RE-ENCRYPT IT WITH SERVER-SIDE ENCRYPTION. THE FILE WILL BE READABLE BY THE SERVER.'

    const confirmed = await cfg().showConfirm(action, warning, action, checked ? '🔐' : '🔒')
    if (!confirmed) {
      toggle.checked = !checked
      return
    }

    const t = _startConversion(pinned, checked ? 'ENCRYPTING' : 'DECRYPTING')
    updateReencryptToast(t, 'PREPARING...', 0, target.name)

    try {
      if (checked) {
        await _encryptFileToE2E(target, t)
      } else {
        await _decryptFileToServer(target, t)
      }

      if (cfg().onRowE2EBadgeUpdate) cfg().onRowE2EBadgeUpdate(target.id, target.is_e2e)

      _finishConversion(t, () => {
        // Invalidate cached E2E thumbnail for this file (encryption mode changed)
        if (typeof _invalidateThumbCache === 'function') _invalidateThumbCache(target.id)
        if (cfg().onAfterSave) cfg().onAfterSave()
      })

    } catch (err) {
      console.error('[MANAGE MODAL] E2E toggle error:', err)
      cfg().showToast(err.message || 'RE-ENCRYPTION FAILED', 'error')
      m.endConversion()
      showReencryptError(t)
    }
  }

  async function _encryptFileToE2E(target, t) {
    updateReencryptToast(t, 'DOWNLOADING FILE...', 10)

    const masterKey = await OneGyCrypto.getMasterKeyFromSession()
    if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')

    const dlResp = await fetch(`/file/${target.id}/preview`)
    if (!dlResp.ok) throw new Error('FAILED TO DOWNLOAD FILE')
    // A Blob (not an ArrayBuffer) lets encryptFileData stream it in slices.
    const plainData = await dlResp.blob()

    updateReencryptToast(t, 'ENCRYPTING...', 30)

    const fileKey = await OneGyCrypto.generateFileKey()
    const encryptedData = await OneGyCrypto.encryptFileData(
      plainData, fileKey,
      (p) => { updateReencryptToast(t, 'ENCRYPTING...', 30 + p * 30) }
    )
    const wrappedKey = await OneGyCrypto.wrapFileKeyWithMasterKey(fileKey, masterKey)

    let encThumb = null
    try {
      encThumb = await _encryptedThumbnail(plainData, target.name, fileKey)
    } catch (thumbErr) {
      console.error('[MANAGE MODAL] Thumbnail generation failed (non-critical):', thumbErr)
    }

    // Encrypt filename with file key (zero-knowledge)
    let encNameData = null
    try {
      encNameData = await OneGyCrypto.encryptFileName(target.name, fileKey)
    } catch (e) {
      console.error('[MANAGE MODAL] Filename encryption failed:', e)
      throw new Error('FILENAME ENCRYPTION FAILED')
    }

    updateReencryptToast(t, 'UPLOADING ENCRYPTED FILE...', 60)

    const formData = _makePrivateForm(encryptedData, wrappedKey, encThumb, encNameData, target.name)
    const makeResp = await _postForm(`/f/${target.id}/make-private`, formData)
    if (!makeResp.ok) {
      const err = await makeResp.json()
      throw new Error(err.error || 'FAILED TO ENCRYPT FILE')
    }

    const makeResult = await makeResp.json()
    const inheritedLinkKeyFailure = await _inheritedLinkKeyFailed(makeResult, target.id)

    target.is_e2e = true
    target._derivedLinkSecret = null

    // If the file was publicly shared before conversion, restore sharing
    // and auto-generate a new E2E link key so the share URL works immediately
    let share = { restoreFailed: false, rollbackFailed: false }
    if (makeResult.was_public) {
      updateReencryptToast(t, 'GENERATING SHARE LINK...', 95)
      share = await _restoreFileShareLink(target)
    }

    updateReencryptToast(t, 'COMPLETE!', 100)
    if (share.rollbackFailed) {
      cfg().showToast('FILE ENCRYPTED, BUT SHARE-LINK KEY PROVISIONING AND VISIBILITY ROLLBACK FAILED. SHARING MAY STILL BE ENABLED', 'error')
    } else if (share.restoreFailed) {
      cfg().showToast('FILE ENCRYPTED, BUT ITS SHARE LINK COULD NOT BE PROVISIONED. SHARING WAS NOT RESTORED', 'error')
    } else if (inheritedLinkKeyFailure) {
      cfg().showToast('FILE ENCRYPTED, BUT ITS INHERITED SHARE-LINK KEY FAILED. FOLDER RECIPIENTS CANNOT DECRYPT IT', 'error')
    } else {
      cfg().showToast('FILE IS NOW END-TO-END ENCRYPTED', 'success')
    }
  }

  async function _restoreFileShareLink(target) {
    const share = { restoreFailed: false, rollbackFailed: false }
    try {
      await m.saveManageSetting('public', true, target, 'file')
      target.is_public = true
      const linkOk = await m.generateE2EShareLink(target, 'file')
      if (linkOk !== true) throw new Error('SHARE LINK KEY UPLOAD FAILED')
    } catch (linkErr) {
      console.error('[MANAGE MODAL] Auto-restore share link failed:', linkErr)
      share.restoreFailed = true
      try {
        await m.saveManageSetting('public', false, target, 'file')
        target.is_public = false
      } catch (rollbackErr) {
        console.error('[MANAGE MODAL] Failed to roll back share visibility:', rollbackErr)
        share.rollbackFailed = true
      }
    }
    return share
  }

  async function _decryptFileToServer(target, t) {
    updateReencryptToast(t, 'LOADING KEYS...', 10)

    const masterKey = await OneGyCrypto.getMasterKeyFromSession()
    if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')

    const keyResp = await fetch(`/f/${target.id}/key-info`)
    if (!keyResp.ok) throw new Error(`FAILED TO LOAD FILE KEY (HTTP ${keyResp.status})`)
    const keyInfo = await keyResp.json()
    if (!keyInfo.encrypted_file_key) throw new Error('FILE KEY NOT FOUND')

    const realName = await _resolveRealFileName(target, keyInfo, masterKey)

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

    const makeResp = await _postForm(`/f/${target.id}/make-public`, _makePublicForm(decrypted, realName))
    if (!makeResp.ok) {
      const err = await makeResp.json().catch(() => ({}))
      throw new Error(err.error || 'FAILED TO DECRYPT FILE')
    }

    updateReencryptToast(t, 'COMPLETE!', 100)
    target.is_e2e = false
    target.name = realName
    target.encrypted_name = null
    target.name_nonce = null
    cfg().showToast('FILE IS NOW USING SERVER-SIDE ENCRYPTION', 'success')
  }

  // Resolve the REAL filename deterministically before touching the file.
  // For an E2EE file `target.name` is the server-side placeholder
  // (encrypted_<id>.<ext>); make-public writes whatever `real_name` we send
  // straight into orig_name and then NULLs encrypted_name/name_nonce, so a
  // placeholder here destroys the only copy of the filename forever.
  // Never rely on populateFileModal's un-awaited background decrypt.
  async function _resolveRealFileName(target, keyInfo, masterKey) {
    if (!(keyInfo.encrypted_name && keyInfo.name_nonce)) return target.name
    let realName = null
    try {
      const nameFileKey = await OneGyCrypto.unwrapFileKeyWithMasterKey(
        keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
      )
      realName = await OneGyCrypto.decryptFileName(keyInfo.encrypted_name, keyInfo.name_nonce, nameFileKey)
    } catch (nameErr) {
      console.error('[MANAGE MODAL] Real filename decryption failed:', nameErr)
    }
    if (!realName) throw new Error('FILENAME COULD NOT BE DECRYPTED. CONVERSION ABORTED TO AVOID LOSING THE FILE NAME')
    return realName
  }

  // ─── Plaintext folder name restore (E2EE off) ───────────────
  // Resolved BEFORE anything is converted, and never from populateFolderModal's
  // un-awaited background decrypt. Returns null when the name is not encrypted.
  async function _plainFolderNameForRestore(target) {
    if (!target.encrypted_name) return null
    const name = (target._name_decrypted && target.name) || await m.tryDecryptFolderName(target)
    if (!name) throw new Error('FOLDER NAME COULD NOT BE DECRYPTED. E2E WAS NOT DISABLED')
    return name
  }

  // Must run before saveManageSetting('e2e', false): the server keeps is_e2e
  // set while an encrypted folder name exists.
  async function _restorePlainFolderName(target, name) {
    if (!name) return
    const renameForm = new FormData()
    renameForm.append('name', name)
    renameForm.append('csrf_token', cfg().getCSRFToken())
    const resp = await _postForm(`/folder/${target.id}/rename`, renameForm)
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      throw new Error(err.error || `FOLDER NAME RESTORE FAILED (HTTP ${resp.status})`)
    }
    target.name = name
    target.encrypted_name = null
    target.name_nonce = null
    target.encrypted_name_key = null
    target.name_key_nonce = null
    console.log(`[MANAGE MODAL] Restored plaintext folder name for folder ${target.id}`)
  }

  // ─── Folder name encryption (E2EE on) ───────────────────────
  function _folderNameNeedsEncryption(target) {
    return !target.encrypted_name && target.name && !target.name.startsWith('encrypted_folder_')
  }

  async function _encryptFolderName(target, masterKey) {
    const nameKey = await OneGyCrypto.generateFolderNameKey()
    const encName = await OneGyCrypto.encryptFolderName(target.name, nameKey)
    const wrappedKey = await OneGyCrypto.wrapFolderNameKey(nameKey, masterKey)
    const encFormData = new FormData()
    encFormData.append('encrypted_name', encName.encryptedName)
    encFormData.append('name_nonce', encName.nameNonce)
    encFormData.append('encrypted_name_key', wrappedKey.encryptedNameKey)
    encFormData.append('name_key_nonce', wrappedKey.nonce)
    encFormData.append('csrf_token', cfg().getCSRFToken())
    const encResp = await _postForm(`/folder/${target.id}/encrypt-name`, encFormData)
    if (!encResp.ok) {
      throw new Error('FOLDER NAME ENCRYPTION FAILED')
    }
  }

  async function _fetchFolderFiles(target) {
    const listResp = await fetch(`/folder/${target.id}/files`)
    if (!listResp.ok) throw new Error(`FAILED TO LOAD FOLDER FILE LIST (HTTP ${listResp.status})`)
    const listData = await listResp.json()
    if (!listData || !Array.isArray(listData.files)) throw new Error('FOLDER FILE LIST UNAVAILABLE')
    return listData.files
  }

  // No files need converting: flip the folder flag (and its name) in place.
  async function _setFolderE2EFlag(toggle, target, on) {
    try {
      if (on) {
        // Encrypt the folder name when enabling E2EE (no files to re-encrypt path)
        if (_folderNameNeedsEncryption(target)) {
          const masterKey = await OneGyCrypto.getMasterKeyFromSession()
          if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')
          await _encryptFolderName(target, masterKey)
        }
      } else {
        await _restorePlainFolderName(target, await _plainFolderNameForRestore(target))
      }
      await m.saveManageSetting('e2e', on, target, 'folder')
      target.is_e2e = on
      target.has_mixed_e2e = false
      m.updateModalBadges()
      m.updateEncryptionStatus()
      m.updateE2EHint()
      if (cfg().onRowE2EBadgeUpdate) cfg().onRowE2EBadgeUpdate(target.id, on)
      if (cfg().onAfterSave) cfg().onAfterSave()
      m.close()
    } catch (err) {
      cfg().showToast(err.message || 'FAILED TO UPDATE SETTINGS', 'error')
      toggle.checked = !on
    }
  }

  // Say exactly how many files were already converted so the user knows
  // the folder is now mixed rather than untouched.
  function _folderConversionFailed(err, t, target, progress, enabling) {
    console.error(enabling ? '[MANAGE MODAL] Folder E2E enable error:' : '[MANAGE MODAL] Folder E2E disable error:', err)
    const baseMsg = err.message || 'RE-ENCRYPTION FAILED'
    const succeeded = progress.succeeded
    const done = enabling ? 'ENCRYPTED' : 'CONVERTED'
    cfg().showToast(
      succeeded > 0
        ? `${baseMsg}. ${succeeded}/${progress.total} FILE${succeeded > 1 ? 'S' : ''} ALREADY ${done}, FOLDER IS IN A MIXED STATE`
        : baseMsg,
      'error'
    )
    if (succeeded > 0) {
      target.e2e_count = enabling
        ? (target.e2e_count || 0) + succeeded
        : Math.max(0, (target.e2e_count || 0) - succeeded)
      target.has_mixed_e2e = true
      if (cfg().onAfterSave) cfg().onAfterSave()
    }
    m.endConversion()
    showReencryptError(t)
  }

  // ─── Folder E2E Toggle (batch re-encryption) ────────────────
  async function handleFolderE2EToggle(checked) {
    const toggle = m.refs.e2eToggle
    if (!toggle) return
    if (!_cryptoReady(toggle, checked)) return

    // Pin the target BEFORE the first await — see handleFileE2EToggle.
    const pinned = m.current()

    if (checked) {
      await _enableFolderE2E(toggle, pinned)
    } else {
      await _disableFolderE2E(toggle, pinned)
    }
  }

  async function _enableFolderE2E(toggle, pinned) {
    const target = pinned.data
    const nonE2ECount = target.file_count - target.e2e_count

    if (nonE2ECount > 0) {
      const confirmed = await cfg().showConfirm(
        'ENABLE E2E ENCRYPTION',
        `THIS WILL DOWNLOAD ${nonE2ECount} FILE${nonE2ECount > 1 ? 'S' : ''}, ENCRYPT THEM END-TO-END, AND RE-UPLOAD. ALL SUBFOLDERS WILL ALSO BE SET TO E2E. ONLY YOU WILL BE ABLE TO DECRYPT THEM.`,
        'ENABLE E2E ENCRYPTION',
        '🔐'
      )
      if (!confirmed) {
        toggle.checked = false
        return
      }
      const t = _startConversion(pinned, 'ENCRYPTING')
      await _runFolderEncrypt(target, t)
      return
    }

    await _setFolderE2EFlag(toggle, target, true)
  }

  async function _runFolderEncrypt(target, t) {
    // Kept outside the try so the failure path can report exactly how many
    // files were already converted (i.e. the folder is in a mixed state).
    const progress = { succeeded: 0, total: 0 }
    let linkKeyFailures = 0

    try {
      updateReencryptToast(t, 'FETCHING FILE LIST...', 5)

      const masterKey = await OneGyCrypto.getMasterKeyFromSession()
      if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')

      const allFiles = await _fetchFolderFiles(target)
      const nonE2EFiles = allFiles.filter(f => !f.is_e2e)
      progress.total = nonE2EFiles.length
      // The cached file_count/e2e_count said there was work to do. If the
      // authoritative listing disagrees, only an all-E2E listing with at
      // least one file is a verified "already fully converted" state — an
      // empty listing must never be treated as success.
      const alreadyFullyE2E = allFiles.length > 0 && nonE2EFiles.length === 0
      if (!nonE2EFiles.length && !alreadyFullyE2E) {
        throw new Error('FOLDER FILE LIST IS EMPTY. REFRESH AND TRY AGAIN')
      }

      let completed = 0
      for (const fileInfo of nonE2EFiles) {
        updateReencryptToast(t, `ENCRYPTING ${completed + 1}/${nonE2EFiles.length}`, 5 + (completed / nonE2EFiles.length) * 90, fileInfo.name)
        const r = await _encryptFolderFile(fileInfo, masterKey)
        if (r.ok) progress.succeeded++
        if (r.linkKeyFailed) linkKeyFailures++
        completed++
      }

      updateReencryptToast(t, 'COMPLETE!', 100)

      const succeeded = progress.succeeded
      // Only flag the folder E2EE when at least one file was actually
      // converted, or the listing verified every file was already E2EE.
      const fullyConverted = alreadyFullyE2E || (nonE2EFiles.length > 0 && succeeded === nonE2EFiles.length)

      if (fullyConverted) {
        // Encrypt the folder name when enabling E2EE
        if (_folderNameNeedsEncryption(target)) {
          await _encryptFolderName(target, masterKey)
          console.log(`[MANAGE MODAL] Encrypted folder name for folder ${target.id}`)
        }
        await m.saveManageSetting('e2e', true, target, 'folder')
        target.is_e2e = true
        target.e2e_count = allFiles.length
        target.file_count = allFiles.length
        target.has_mixed_e2e = false
      } else if (succeeded > 0) {
        target.e2e_count = (target.e2e_count || 0) + succeeded
        target.has_mixed_e2e = true
      }

      if (cfg().onRowE2EBadgeUpdate) cfg().onRowE2EBadgeUpdate(target.id, target.is_e2e)

      _folderEncryptToast(succeeded, nonE2EFiles.length, linkKeyFailures, alreadyFullyE2E, fullyConverted)
      _finishConversion(t, _refreshAfterBatch)

    } catch (err) {
      _folderConversionFailed(err, t, target, progress, true)
    }
  }

  function _folderEncryptToast(succeeded, total, linkKeyFailures, alreadyFullyE2E, fullyConverted) {
    if (linkKeyFailures > 0) {
      cfg().showToast(`${succeeded} FILE${succeeded === 1 ? '' : 'S'} ENCRYPTED, BUT ${linkKeyFailures} INHERITED SHARE-LINK KEY${linkKeyFailures === 1 ? '' : 'S'} FAILED`, 'error')
    } else if (alreadyFullyE2E) {
      cfg().showToast('ALL FILES IN THIS FOLDER WERE ALREADY END-TO-END ENCRYPTED', 'success')
    } else if (fullyConverted) {
      cfg().showToast(`${succeeded} FILE${succeeded > 1 ? 'S' : ''} ENCRYPTED END-TO-END`, 'success')
    } else if (succeeded > 0) {
      cfg().showToast(`${succeeded}/${total} FILES ENCRYPTED. ${total - succeeded} FAILED. FOLDER IS IN A MIXED STATE`, 'error')
    } else {
      cfg().showToast('FAILED TO ENCRYPT FILES. CHECK CONSOLE FOR DETAILS', 'error')
    }
  }

  // One file of a folder batch. A failed download or make-private is logged
  // and skipped ({ ok: false }); anything else that throws aborts the batch.
  async function _encryptFolderFile(fileInfo, masterKey) {
    const result = { ok: false, linkKeyFailed: false }
    const dlResp = await fetch(`/file/${fileInfo.id}/preview`)
    if (!dlResp.ok) {
      console.error(`[MANAGE MODAL] Failed to download ${fileInfo.name}`)
      return result
    }
    const plainData = await dlResp.blob()

    const fileKey = await OneGyCrypto.generateFileKey()
    const encryptedData = await OneGyCrypto.encryptFileData(plainData, fileKey)
    const wrappedKey = await OneGyCrypto.wrapFileKeyWithMasterKey(fileKey, masterKey)

    let encThumb = null
    try {
      encThumb = await _encryptedThumbnail(plainData, fileInfo.name, fileKey)
    } catch (thumbErr) {
      console.error(`[MANAGE MODAL] Thumbnail generation failed for ${fileInfo.name} (non-critical):`, thumbErr)
    }

    const nameRes = await OneGyCrypto.encryptFileName(fileInfo.name, fileKey)
    const formData = _makePrivateForm(encryptedData, wrappedKey, encThumb, nameRes, fileInfo.name)
    const makeResp = await _postForm(`/f/${fileInfo.id}/make-private`, formData)

    if (!makeResp.ok) {
      console.error(`[MANAGE MODAL] make-private failed for ${fileInfo.name}`)
      return result
    }
    result.ok = true
    try {
      const makeData = await makeResp.json()
      result.linkKeyFailed = await _inheritedLinkKeyFailed(makeData, fileInfo.id)
    } catch (lkErr) {
      console.error(`[MANAGE MODAL] Inline link-key for ${fileInfo.name}:`, lkErr)
      result.linkKeyFailed = true
    }
    return result
  }

  async function _disableFolderE2E(toggle, pinned) {
    const target = pinned.data

    if (target.e2e_count > 0) {
      const confirmed = await cfg().showConfirm(
        'DISABLE E2E ENCRYPTION',
        `THIS WILL DECRYPT ${target.e2e_count} END-TO-END ENCRYPTED FILE${target.e2e_count > 1 ? 'S' : ''} AND RE-ENCRYPT WITH SERVER-SIDE ENCRYPTION. ALL SUBFOLDERS WILL ALSO BE CHANGED. THE FILES WILL BE READABLE BY THE SERVER.`,
        'DISABLE E2E ENCRYPTION',
        '🔒'
      )
      if (!confirmed) {
        toggle.checked = true
        return
      }
      const t = _startConversion(pinned, 'DECRYPTING')
      await _runFolderDecrypt(target, t)
      return
    }

    await _setFolderE2EFlag(toggle, target, false)
  }

  async function _runFolderDecrypt(target, t) {
    // Kept outside the try so the failure path can report exactly how many
    // files were already converted (i.e. the folder is in a mixed state).
    const progress = { succeeded: 0, total: 0 }

    try {
      updateReencryptToast(t, 'FETCHING FILE LIST...', 5)

      const masterKey = await OneGyCrypto.getMasterKeyFromSession()
      if (!masterKey) throw new Error('MASTER KEY NOT AVAILABLE')
      const plainFolderName = await _plainFolderNameForRestore(target)

      const allFiles = await _fetchFolderFiles(target)
      const e2eFiles = allFiles.filter(f => f.is_e2e)
      progress.total = e2eFiles.length
      // Same vacuous-success guard as the enable path: an empty listing is
      // never proof that every file is already server-side encrypted.
      const alreadyFullyPlain = allFiles.length > 0 && e2eFiles.length === 0
      if (!e2eFiles.length && !alreadyFullyPlain) {
        throw new Error('FOLDER FILE LIST IS EMPTY. REFRESH AND TRY AGAIN')
      }

      await _decryptFolderFileNames(e2eFiles, masterKey)

      let completed = 0
      for (const fileInfo of e2eFiles) {
        updateReencryptToast(t, `DECRYPTING ${completed + 1}/${e2eFiles.length}`, 5 + (completed / e2eFiles.length) * 90, fileInfo.name)
        if (await _decryptFolderFile(fileInfo, masterKey)) progress.succeeded++
        completed++
      }

      updateReencryptToast(t, 'COMPLETE!', 100)

      const succeeded = progress.succeeded
      // Only clear the folder's E2EE flag when at least one file was really
      // converted, or the listing verified none were E2EE to begin with.
      const fullyConverted = alreadyFullyPlain || (e2eFiles.length > 0 && succeeded === e2eFiles.length)

      if (fullyConverted) {
        await _restorePlainFolderName(target, plainFolderName)
        await m.saveManageSetting('e2e', false, target, 'folder')
        target.is_e2e = false
        target.e2e_count = 0
        target.has_mixed_e2e = false
      } else if (succeeded > 0) {
        target.e2e_count = e2eFiles.length - succeeded
        target.has_mixed_e2e = true
      }

      if (cfg().onRowE2EBadgeUpdate) cfg().onRowE2EBadgeUpdate(target.id, target.is_e2e)

      _folderDecryptToast(succeeded, e2eFiles.length, alreadyFullyPlain, fullyConverted)
      _finishConversion(t, _refreshAfterBatch)

    } catch (err) {
      _folderConversionFailed(err, t, target, progress, false)
    }
  }

  function _folderDecryptToast(succeeded, total, alreadyFullyPlain, fullyConverted) {
    if (alreadyFullyPlain) {
      cfg().showToast('NO END-TO-END ENCRYPTED FILES REMAINED IN THIS FOLDER', 'success')
    } else if (fullyConverted) {
      cfg().showToast(`${succeeded} FILE${succeeded > 1 ? 'S' : ''} CONVERTED TO SERVER-SIDE ENCRYPTION`, 'success')
    } else if (succeeded > 0) {
      cfg().showToast(`${succeeded}/${total} FILES CONVERTED. ${total - succeeded} FAILED. FOLDER IS IN A MIXED STATE`, 'error')
    } else {
      cfg().showToast('FAILED TO CONVERT FILES. CHECK CONSOLE FOR DETAILS', 'error')
    }
  }

  // Pre-decrypt E2EE filenames for toast display and server restore
  async function _decryptFolderFileNames(e2eFiles, masterKey) {
    for (const fileInfo of e2eFiles) {
      if (!fileInfo.encrypted_name || !fileInfo.name_nonce || !fileInfo.encrypted_file_key || !fileInfo.file_key_nonce) {
        throw new Error('ENCRYPTED FILENAME METADATA MISSING')
      }
      const fk = await OneGyCrypto.unwrapFileKeyWithMasterKey(fileInfo.encrypted_file_key, fileInfo.file_key_nonce, masterKey)
      const realName = await OneGyCrypto.decryptFileName(fileInfo.encrypted_name, fileInfo.name_nonce, fk)
      if (!realName) throw new Error('FILENAME DECRYPTION FAILED')
      fileInfo.name = realName
    }
  }

  // One file of a folder batch; true when the server accepted the plaintext.
  async function _decryptFolderFile(fileInfo, masterKey) {
    const keyResp = await fetch(`/f/${fileInfo.id}/key-info`)
    if (!keyResp.ok) {
      console.error(`[MANAGE MODAL] key-info failed for ${fileInfo.name} (HTTP ${keyResp.status})`)
      return false
    }
    const keyInfo = await keyResp.json()
    if (!keyInfo.encrypted_file_key) {
      console.error(`[MANAGE MODAL] No file key for ${fileInfo.name}`)
      return false
    }

    const encResp = await fetch(`/f/${fileInfo.id}/encrypted`)
    if (!encResp.ok) {
      console.error(`[MANAGE MODAL] Failed to download ${fileInfo.name}`)
      return false
    }
    const encData = await encResp.arrayBuffer()

    const decrypted = await OneGyCrypto.decryptFileForDownload(
      encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
    )

    const makeResp = await _postForm(`/f/${fileInfo.id}/make-public`, _makePublicForm(decrypted, fileInfo.name))
    if (!makeResp.ok) {
      console.error(`[MANAGE MODAL] make-public failed for ${fileInfo.name}`)
      return false
    }
    return true
  }

  return {
    handleFileE2EToggle: handleFileE2EToggle,
    handleFolderE2EToggle: handleFolderE2EToggle
  }
}
