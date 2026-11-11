// ─── ONE.GY Music Player: E2E encrypted track loading ───
;(function(mp) {
  'use strict'

  const { AUDIO_MIME, _ssGet, audio } = mp

  async function _loadE2ETrack(track, loadSeq) {
    mp._setTitle(track.name + ' (decrypting…)')

    try {
      if (mp._context === 'dashboard') {
        await _loadE2EDashboard(track, loadSeq)
      } else if (mp._context === 'temp') {
        await _loadE2ETemp(track, loadSeq)
      } else if (mp._context === 'browse') {
        await _loadE2EBrowse(track, loadSeq)
      }
    } catch (err) {
      if (loadSeq !== mp._loadSeq) return
      console.error('[MUSIC PLAYER] E2E decrypt error:', err)
      mp._setTitle(track.name + ' (decrypt failed)')
    }
  }

  async function _loadE2EDashboard(track, loadSeq) {
    if (typeof OneGyCrypto === 'undefined' || !OneGyCrypto.hasSessionKeys()) {
      mp._setTitle(track.name + ' (E2E keys unavailable)')
      return
    }
    const masterKey = await OneGyCrypto.getMasterKeyFromSession()
    if (loadSeq !== mp._loadSeq) return
    if (!masterKey) {
      mp._setTitle(track.name + ' (master key unavailable)')
      return
    }
    const keyResp = await fetch(`/f/${track.id}/key-info`)
    if (loadSeq !== mp._loadSeq) return
    const keyInfo = await keyResp.json()
    if (loadSeq !== mp._loadSeq) return
    if (!keyInfo.encrypted_file_key) {
      mp._setTitle(track.name + ' (file key not found)')
      return
    }
    const encResp = await fetch(`/f/${track.id}/encrypted?preview=1`)
    if (loadSeq !== mp._loadSeq) return
    if (!encResp.ok) {
      mp._setTitle(track.name + ' (fetch failed)')
      return
    }
    const encData = await encResp.arrayBuffer()
    if (loadSeq !== mp._loadSeq) return
    const decrypted = await OneGyCrypto.decryptFileForDownload(
      encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
    )
    if (loadSeq !== mp._loadSeq) return
    const blob = new Blob([decrypted], { type: AUDIO_MIME[track.extension] || 'audio/mpeg' })
    const blobUrl = URL.createObjectURL(blob)
    if (loadSeq !== mp._loadSeq) {
      URL.revokeObjectURL(blobUrl)
      return
    }
    mp._currentBlobUrl = blobUrl
    audio.src = mp._currentBlobUrl
    mp._setTitle(track.name)
    audio.play().catch(err => console.warn('[MUSIC PLAYER] E2E play failed:', err.message))
  }

  // Temp upload page E2E: supports both passphrase and master-key wrapped files
  async function _loadE2ETemp(track, loadSeq) {
    if (typeof OneGyCrypto === 'undefined') {
      mp._setTitle(track.name + ' (crypto unavailable)')
      return
    }
    var keyResp = await fetch('/f/' + track.id + '/key-info')
    if (loadSeq !== mp._loadSeq) return
    var keyInfo = await keyResp.json()
    if (loadSeq !== mp._loadSeq) return
    if (!keyInfo.encrypted_file_key) {
      mp._setTitle(track.name + ' (file key not found)')
      return
    }
    var encResp = await fetch('/f/' + track.id + '/encrypted?preview=1')
    if (loadSeq !== mp._loadSeq) return
    if (!encResp.ok) {
      mp._setTitle(track.name + ' (fetch failed)')
      return
    }
    var encData = await encResp.arrayBuffer()
    if (loadSeq !== mp._loadSeq) return
    var decrypted
    if (keyInfo.file_key_salt) {
      // Passphrase-wrapped: try per-file keychain first, then global sessionStorage
      var passphrase = null
      if (typeof TempKeychain !== 'undefined') {
        try { passphrase = await TempKeychain.get(track.id) } catch (e) {}
        if (loadSeq !== mp._loadSeq) return
      }
      if (!passphrase) passphrase = _ssGet('e2e_passphrase')
      if (!passphrase) {
        mp._setTitle(track.name + ' (passphrase unavailable)')
        return
      }
      decrypted = await OneGyCrypto.decryptFileForGuestDownload(
        encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, keyInfo.file_key_salt, passphrase
      )
    } else if (OneGyCrypto.hasSessionKeys()) {
      // Master-key-wrapped
      var masterKey = await OneGyCrypto.getMasterKeyFromSession()
      if (loadSeq !== mp._loadSeq) return
      decrypted = await OneGyCrypto.decryptFileForDownload(
        encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
      )
    } else {
      mp._setTitle(track.name + ' (keys unavailable)')
      return
    }
    if (loadSeq !== mp._loadSeq) return
    var blob = new Blob([decrypted], { type: AUDIO_MIME[track.extension] || 'audio/mpeg' })
    var blobUrl = URL.createObjectURL(blob)
    if (loadSeq !== mp._loadSeq) {
      URL.revokeObjectURL(blobUrl)
      return
    }
    mp._currentBlobUrl = blobUrl
    audio.src = mp._currentBlobUrl
    mp._setTitle(track.name)
    audio.play().catch(function(err) { console.warn('[MUSIC PLAYER] E2E temp play failed:', err.message) })
  }

  // Browse page E2E uses link secret
  async function _loadE2EBrowse(track, loadSeq) {
    if (typeof OneGyCrypto === 'undefined') {
      mp._setTitle(track.name + ' (crypto unavailable)')
      return
    }
    const linkSecret = window._mpLinkSecret || ''
    if (!linkSecret || linkSecret.length < 10) {
      mp._setTitle(track.name + ' (link key unavailable)')
      return
    }
    const keyResp = await fetch(`/f/${track.id}/key-info`)
    if (loadSeq !== mp._loadSeq) return
    const keyInfo = await keyResp.json()
    if (loadSeq !== mp._loadSeq) return
    const encKey = keyInfo.link_encrypted_file_key || keyInfo.encrypted_file_key
    const encNonce = keyInfo.link_file_key_nonce || keyInfo.file_key_nonce
    if (!encKey) {
      mp._setTitle(track.name + ' (file key not found)')
      return
    }
    const encResp = await fetch(`/f/${track.id}/encrypted?preview=1`)
    if (loadSeq !== mp._loadSeq) return
    if (!encResp.ok) {
      mp._setTitle(track.name + ' (fetch failed)')
      return
    }
    const encData = await encResp.arrayBuffer()
    if (loadSeq !== mp._loadSeq) return
    const decrypted = await OneGyCrypto.decryptFileFromLink(encData, encKey, encNonce, linkSecret)
    if (loadSeq !== mp._loadSeq) return
    const blob = new Blob([decrypted], { type: AUDIO_MIME[track.extension] || 'audio/mpeg' })
    const blobUrl = URL.createObjectURL(blob)
    if (loadSeq !== mp._loadSeq) {
      URL.revokeObjectURL(blobUrl)
      return
    }
    mp._currentBlobUrl = blobUrl
    audio.src = mp._currentBlobUrl
    mp._setTitle(track.name)
    audio.play().catch(err => console.warn('[MUSIC PLAYER] E2E browse play failed:', err.message))
  }

  Object.assign(mp, {
    _loadE2ETrack,
  })
})(window._mpCore)
