// ─── ONE.GY Music Player: E2E encrypted track loading ───
;(function(mp) {
  'use strict'

  const { AUDIO_MIME, _ssGet, audio } = mp

  let _prefetched = null   // {id, promise, taken}: the next E2E track, decrypted ahead (music-player-playback.js)

  // A failure shown after the title, e.g. "(fetch failed)"
  function _e2eError(label) {
    var err = new Error(label)
    err.e2eLabel = label
    return err
  }

  async function _loadE2ETrack(track, loadSeq) {
    mp._setTitle(track.name + ' (decrypting…)')
    var ahead = null
    if (_prefetched && _prefetched.id === track.id) {
      ahead = _prefetched
      ahead.taken = true
      _prefetched = null
    } else {
      _dropPrefetch()
    }
    var blobUrl
    try {
      if (ahead) blobUrl = await ahead.promise.catch(function() { return null })
      if (loadSeq !== mp._loadSeq) { if (blobUrl) URL.revokeObjectURL(blobUrl); return }
      if (!blobUrl) blobUrl = await _decryptE2E(track, function() { return loadSeq !== mp._loadSeq })
    } catch (err) {
      if (loadSeq !== mp._loadSeq) return
      if (!err.e2eLabel) console.error('[MUSIC PLAYER] E2E decrypt error:', err)
      mp._setTitle(track.name + ' (' + (err.e2eLabel || 'decrypt failed') + ')')
      return
    }
    if (!blobUrl) return
    if (loadSeq !== mp._loadSeq) {
      URL.revokeObjectURL(blobUrl)
      return
    }
    mp._currentBlobUrl = blobUrl
    audio.src = mp._currentBlobUrl
    mp._setTitle(track.name)
    audio.play().catch(err => console.warn('[MUSIC PLAYER] E2E play failed:', err.message))
  }

  // Decrypt the next track while the current one plays out, so it starts
  // without a silent gap. One at a time; an unused one is dropped.
  function _prefetchE2E(track) {
    if (!track || !track.isE2E || (_prefetched && _prefetched.id === track.id)) return
    _dropPrefetch()
    var entry = { id: track.id, promise: null, taken: false }
    entry.promise = _decryptE2E(track, function() { return _prefetched !== entry && !entry.taken })
    entry.promise.catch(function() {})
    _prefetched = entry
  }

  function _dropPrefetch() {
    var entry = _prefetched
    _prefetched = null
    if (entry) entry.promise.then(function(url) { if (url) URL.revokeObjectURL(url) }, function() {})
  }

  // Resolves to a blob URL of the decrypted track (null once cancelled()
  // says nobody wants it any more); fails with an e2eLabel for the title.
  async function _decryptE2E(track, cancelled) {
    var decrypted
    if (mp._context === 'dashboard') decrypted = await _decryptE2EDashboard(track, cancelled)
    else if (mp._context === 'temp') decrypted = await _decryptE2ETemp(track, cancelled)
    else if (mp._context === 'browse') decrypted = await _decryptE2EBrowse(track, cancelled)
    if (!decrypted || cancelled()) return null
    return URL.createObjectURL(new Blob([decrypted], { type: AUDIO_MIME[track.extension] || 'audio/mpeg' }))
  }

  async function _fetchEncrypted(track, cancelled) {
    const encResp = await fetch(`/f/${track.id}/encrypted?preview=1`)
    if (cancelled()) return null
    if (!encResp.ok) throw _e2eError('fetch failed')
    return encResp.arrayBuffer()
  }

  async function _decryptE2EDashboard(track, cancelled) {
    if (typeof OneGyCrypto === 'undefined' || !OneGyCrypto.hasSessionKeys()) throw _e2eError('E2E keys unavailable')
    const masterKey = await OneGyCrypto.getMasterKeyFromSession()
    if (cancelled()) return null
    if (!masterKey) throw _e2eError('master key unavailable')
    const keyResp = await fetch(`/f/${track.id}/key-info`)
    if (cancelled()) return null
    const keyInfo = await keyResp.json()
    if (cancelled()) return null
    if (!keyInfo.encrypted_file_key) throw _e2eError('file key not found')
    const encData = await _fetchEncrypted(track, cancelled)
    if (!encData || cancelled()) return null
    return OneGyCrypto.decryptFileForDownload(
      encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
    )
  }

  // Temp upload page E2E: supports both passphrase and master-key wrapped files
  async function _decryptE2ETemp(track, cancelled) {
    if (typeof OneGyCrypto === 'undefined') throw _e2eError('crypto unavailable')
    var keyResp = await fetch('/f/' + track.id + '/key-info')
    if (cancelled()) return null
    var keyInfo = await keyResp.json()
    if (cancelled()) return null
    if (!keyInfo.encrypted_file_key) throw _e2eError('file key not found')
    var encData = await _fetchEncrypted(track, cancelled)
    if (!encData || cancelled()) return null
    if (keyInfo.file_key_salt) {
      // Passphrase-wrapped: try per-file keychain first, then global sessionStorage
      var passphrase = null
      if (typeof TempKeychain !== 'undefined') {
        try { passphrase = await TempKeychain.get(track.id) } catch (e) {}
        if (cancelled()) return null
      }
      if (!passphrase) passphrase = _ssGet('e2e_passphrase')
      if (!passphrase) throw _e2eError('passphrase unavailable')
      return OneGyCrypto.decryptFileForGuestDownload(
        encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, keyInfo.file_key_salt, passphrase
      )
    }
    if (!OneGyCrypto.hasSessionKeys()) throw _e2eError('keys unavailable')
    // Master-key-wrapped
    var masterKey = await OneGyCrypto.getMasterKeyFromSession()
    if (cancelled()) return null
    return OneGyCrypto.decryptFileForDownload(
      encData, keyInfo.encrypted_file_key, keyInfo.file_key_nonce, masterKey
    )
  }

  // Browse page E2E uses link secret
  async function _decryptE2EBrowse(track, cancelled) {
    if (typeof OneGyCrypto === 'undefined') throw _e2eError('crypto unavailable')
    const linkSecret = window._mpLinkSecret || ''
    if (!linkSecret || linkSecret.length < 10) throw _e2eError('link key unavailable')
    const keyResp = await fetch(`/f/${track.id}/key-info`)
    if (cancelled()) return null
    const keyInfo = await keyResp.json()
    if (cancelled()) return null
    const encKey = keyInfo.link_encrypted_file_key || keyInfo.encrypted_file_key
    const encNonce = keyInfo.link_file_key_nonce || keyInfo.file_key_nonce
    if (!encKey) throw _e2eError('file key not found')
    const encData = await _fetchEncrypted(track, cancelled)
    if (!encData || cancelled()) return null
    return OneGyCrypto.decryptFileFromLink(encData, encKey, encNonce, linkSecret)
  }

  Object.assign(mp, {
    _loadE2ETrack,
    _prefetchE2E,
  })
})(window._mpCore)
