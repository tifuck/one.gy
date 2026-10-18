/**
 * TempKeychain — sessionStorage keychain for E2E temp file passphrases.
 *
 * Architecture (AUDIT FIX F5):
 *   The keychain blob lives in sessionStorage (`onegy_keychain`) and is
 *   encrypted with AES-256-GCM under a key derived via HKDF from a CLIENT-ONLY
 *   random 256-bit secret (`onegy_kc_secret` in localStorage), minted by this
 *   page with crypto.getRandomValues and never sent to the server.
 *
 * Why not the old cookie-derived key (the audited defect):
 *   The previous design derived the AES key from the `onegy_manager` cookie,
 *   which is MINTED BY THE SERVER and echoed back to it in the Cookie header
 *   of every request (it is the server-side manager credential — see
 *   file.manager_cookie_id checks in app.py). The server therefore held the
 *   keychain encryption key at all times, so the old confidentiality claim
 *   ("the cookie is useless without the blob") was only half true: the blob
 *   never leaves the browser, but anyone who ever obtained a copy of the
 *   sessionStorage blob together with server-side data (request logs, the
 *   cookies table, a compromised server) could decrypt every stored guest
 *   passphrase. A chosen/rotated cookie value also silently re-keyed (broke)
 *   the keychain. With a client-only secret the server never sees any key
 *   material for this blob in any form.
 *
 * Migration:
 *   Legacy blobs are raw base64 (no prefix) and were encrypted under the
 *   cookie-derived key. _loadKeychain() detects them, decrypts with the legacy
 *   cookie key while the cookie is still present, and immediately re-saves the
 *   entries under the client-only key ('v2:' prefix). Existing guest-upload
 *   passphrases therefore keep working across the upgrade; nothing is dropped.
 *   If the cookie is already gone the legacy blob was undecryptable before
 *   this change too (graceful empty keychain — unchanged behavior). The
 *   `onegy_manager` cookie itself is untouched: it remains the server-side
 *   manager credential and is still readable via getManagerCookie().
 *
 * Security properties:
 *   - Passphrases never leave the browser (not in cookies, not on the server)
 *   - The encryption key is client-minted and never leaves the browser
 *   - The sessionStorage blob is useless without the localStorage secret, and
 *     the secret is useless without the blob (neither alone reveals anything)
 *   - Losing either side degrades gracefully to an empty keychain (the share
 *     LINK itself always carries #passphrase= as the recovery path)
 *   - XSS is already game-over for any client-side encryption scheme
 *
 * API (unchanged):
 *   TempKeychain.get(fileId)                -> passphrase string or null
 *   TempKeychain.store(fileId, passphrase)  -> void
 *   TempKeychain.remove(fileId)             -> void
 *   TempKeychain.clear()                    -> void
 *   TempKeychain.getManagerCookie()         -> cookie string or null
 */

const TempKeychain = (function() {
  'use strict'

  const STORAGE_KEY = 'onegy_keychain'
  const SECRET_KEY = 'onegy_kc_secret'
  const COOKIE_NAME = 'onegy_manager'
  const V2_PREFIX = 'v2:'
  const HKDF_SALT = 'onegy-temp-keychain'
  const HKDF_INFO = 'aes-key'

  function _readStoredKeychainBlob() {
    try {
      const current = sessionStorage.getItem(STORAGE_KEY)
      if (current) return current
    } catch (e) {}
    try {
      const legacy = localStorage.getItem(STORAGE_KEY)
      if (!legacy) return null
      sessionStorage.setItem(STORAGE_KEY, legacy)
      localStorage.removeItem(STORAGE_KEY)
      return legacy
    } catch (e) {
      return null
    }
  }

  // ─── Cookie Reader (legacy migration + server manager credential) ────
  function _getCookie() {
    try {
      const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]*)'))
      return match ? decodeURIComponent(match[1]) : null
    } catch (e) {
      return null
    }
  }

  // ─── Hex <-> ArrayBuffer ─────────────────────────────────────────
  function _hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
    }
    return bytes
  }

  function _bytesToHex(bytes) {
    let hex = ''
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
    return hex
  }

  function _bytesToBase64(bytes) {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  function _base64ToBytes(b64) {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  // ─── Client-only secret (AUDIT FIX F5) ───────────────────────────────
  // Minted client-side with a CSPRNG, persisted in localStorage so it survives
  // reloads (the blob lives in sessionStorage and must stay readable across a
  // same-tab reload). localStorage is never sent to the server — unlike the
  // old server-minted cookie, the server cannot know this key. The secret
  // alone is inert (no ciphertext ever lives in localStorage), so a
  // localStorage-only dump reveals nothing.
  let _memorySecret = null // fallback when localStorage is unavailable

  function _getOrCreateSecretBytes() {
    try {
      const stored = localStorage.getItem(SECRET_KEY)
      if (stored && /^[0-9a-f]{64}$/.test(stored)) return _hexToBytes(stored)
    } catch (e) {}
    if (_memorySecret) return _memorySecret
    const secret = new Uint8Array(32)
    crypto.getRandomValues(secret)
    try {
      localStorage.setItem(SECRET_KEY, _bytesToHex(secret))
    } catch (e) {
      // Storage unavailable (private mode/quota): keep it in memory only —
      // entries then live for this page instance instead of the tab session,
      // which is still strictly better than a server-known key.
      console.warn('[KEYCHAIN] localStorage unavailable — keychain secret kept in memory only (lost on reload)')
    }
    _memorySecret = secret
    return secret
  }

  // ─── Key Derivation ───────────────────────────────────────────────
  let _cachedKey = null      // client-key cache
  let _cachedSecretHex = null
  let _mutationChain = Promise.resolve()

  async function _deriveKeyFromBytes(keyBytes) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HKDF' }, false, ['deriveKey']
    )
    const enc = new TextEncoder()
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode(HKDF_SALT),
        info: enc.encode(HKDF_INFO)
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  }

  async function _deriveClientKey() {
    try {
      const secret = _getOrCreateSecretBytes()
      const hex = _bytesToHex(secret)
      if (_cachedKey && _cachedSecretHex === hex) return _cachedKey
      const key = await _deriveKeyFromBytes(secret)
      _cachedKey = key
      _cachedSecretHex = hex
      return key
    } catch (e) {
      console.error('[KEYCHAIN] Client key derivation failed:', e)
      return null
    }
  }

  // LEGACY (AUDIT FIX F5): key derived from the server-minted cookie. Used
  // ONLY to decrypt pre-migration blobs — never for new writes.
  async function _deriveLegacyCookieKey() {
    const cookie = _getCookie()
    if (!cookie) return null
    try {
      return await _deriveKeyFromBytes(_hexToBytes(cookie))
    } catch (e) {
      console.error('[KEYCHAIN] Legacy cookie key derivation failed:', e)
      return null
    }
  }

  // ─── Encrypt / Decrypt Keychain ──────────────────────────────────
  async function _decryptBlob(stored, key) {
    if (!key || !stored) return null
    try {
      // Format: base64(12-byte IV + ciphertext)
      const bytes = _base64ToBytes(stored)
      if (bytes.length <= 12) return null
      const iv = bytes.slice(0, 12)
      const ciphertext = bytes.slice(12)
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        ciphertext
      )
      return JSON.parse(new TextDecoder().decode(decrypted))
    } catch (e) {
      return null
    }
  }

  async function _loadKeychain() {
    const stored = _readStoredKeychainBlob()
    if (!stored) return {}

    if (stored.indexOf(V2_PREFIX) === 0) {
      // Current format: client-only key.
      const key = await _deriveClientKey()
      return (await _decryptBlob(stored.slice(V2_PREFIX.length), key)) || {}
    }

    // Legacy (pre-F5) blob: cookie-derived key.
    const legacyKey = await _deriveLegacyCookieKey()
    const data = await _decryptBlob(stored, legacyKey)
    if (data) {
      // Opportunistic migration: re-encrypt the entries under the client-only
      // key immediately, so guest-upload passphrases survive even after the
      // cookie rotates/expires (the old design lost them exactly then).
      await _saveKeychain(data)
      return data
    }
    // Cookie gone or wrong: same graceful empty result as the old code.
    return {}
  }

  async function _saveKeychain(data) {
    const key = await _deriveClientKey()
    if (!key) return

    try {
      const json = JSON.stringify(data)
      const encoded = new TextEncoder().encode(json)

      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encoded
      )

      // IV || ciphertext, base64, tagged as v2 (client-key format).
      const combined = new Uint8Array(iv.length + ciphertext.byteLength)
      combined.set(iv)
      combined.set(new Uint8Array(ciphertext), iv.length)

      sessionStorage.setItem(STORAGE_KEY, V2_PREFIX + _bytesToBase64(combined))
      try { localStorage.removeItem(STORAGE_KEY) } catch (e) {}
    } catch (e) {
      console.error('[KEYCHAIN] Save failed:', e)
    }
  }

  // ─── Public API ──────────────────────────────────────────────────

  async function get(fileId) {
    if (!fileId) return null
    try {
      const stored = _readStoredKeychainBlob()
      if (stored && stored.indexOf(V2_PREFIX) !== 0) {
        // Loading a legacy blob migrates it (a write), so it must queue behind
        // store/remove or it can overwrite a newer entry with its old snapshot.
        let found = null
        _mutationChain = _mutationChain.then(async function() {
          try { found = (await _loadKeychain())[fileId] || null } catch (e) {}
        })
        await _mutationChain
        return found
      }
      const keychain = await _loadKeychain()
      return keychain[fileId] || null
    } catch (e) {
      return null
    }
  }

  async function store(fileId, passphrase) {
    if (!fileId || !passphrase) return
    _mutationChain = _mutationChain.then(async function() {
      try {
        const keychain = await _loadKeychain()
        keychain[fileId] = passphrase
        await _saveKeychain(keychain)
      } catch (e) {
        console.error('[KEYCHAIN] Store failed:', e)
      }
    }, async function() {
      try {
        const keychain = await _loadKeychain()
        keychain[fileId] = passphrase
        await _saveKeychain(keychain)
      } catch (e) {
        console.error('[KEYCHAIN] Store failed:', e)
      }
    })
    return _mutationChain
  }

  async function remove(fileId) {
    if (!fileId) return
    _mutationChain = _mutationChain.then(async function() {
      try {
        const keychain = await _loadKeychain()
        if (fileId in keychain) {
          delete keychain[fileId]
          await _saveKeychain(keychain)
        }
      } catch (e) {
        console.error('[KEYCHAIN] Remove failed:', e)
      }
    }, async function() {
      try {
        const keychain = await _loadKeychain()
        if (fileId in keychain) {
          delete keychain[fileId]
          await _saveKeychain(keychain)
        }
      } catch (e) {
        console.error('[KEYCHAIN] Remove failed:', e)
      }
    })
    return _mutationChain
  }

  function clear() {
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch (e) {}
    try {
      // Legacy blob location (pre-migration) — clear it too.
      localStorage.removeItem(STORAGE_KEY)
    } catch (e) {}
    // NOTE (AUDIT FIX F5): the client secret is deliberately NOT cleared —
    // it is origin-wide (localStorage) while the blob is per-tab
    // (sessionStorage); deleting it here would orphan OTHER open tabs'
    // still-encrypted blobs. The secret alone decrypts nothing.
    _cachedKey = null
    _cachedSecretHex = null
  }

  function getManagerCookie() {
    return _getCookie()
  }

  return {
    get: get,
    store: store,
    remove: remove,
    clear: clear,
    getManagerCookie: getManagerCookie
  }
})()
