/**
 * ONE.GY E2EE Crypto Module — MEGA-style Zero-Knowledge Encryption
 *
 * Key Hierarchy:
 *   Password -> PBKDF2(210k iterations, SHA-256) -> Wrapping Key (AES-256-GCM)
 *   Wrapping Key encrypts -> Master Key (random AES-256, 32 bytes)
 *   Master Key encrypts -> Per-file Keys (random AES-256-GCM, 32 bytes each)
 *   Master Key encrypts -> RSA-OAEP 4096-bit Private Key (for sharing)
 *   RSA Public Key encrypts -> File keys (for account-to-account sharing)
 *   Link Key (from URL fragment) encrypts -> File keys (for link sharing)
 *
 * Primitives:
 *   - AES-256-GCM for all symmetric encryption (file content, key wrapping)
 *   - PBKDF2 with 210,000 iterations for password -> key derivation
 *   - RSA-OAEP 4096-bit for asymmetric sharing
 *   - SHA-256 for integrity / recovery key hashing
 *   - Web Crypto API for all operations (no custom crypto)
 *
 * Chunked Encryption:
 *   Files > 64MB are encrypted in 64MB chunks, each with a unique nonce
 *   derived from a base nonce + chunk index (counter mode on nonce).
 *   This avoids the 2GB AES-GCM browser limit per single operation.
 *
 * Security Notes:
 *   - Server NEVER sees plaintext file content or raw encryption keys
 *   - Master key never leaves the browser unencrypted
 *   - Password is never sent to the server — split-key derivation produces
 *     a separate auth token (sent to server) and wrapping key (kept local)
 *   - Link secrets are derived deterministically from master key + resource ID
 *     via HKDF, never stored on the server
 *   - All nonces are random 12 bytes (96-bit) from CSPRNG
 *   - File keys are 32 bytes from CSPRNG
 */

const OneGyCrypto = (function() {
  'use strict'

  const PBKDF2_ITERATIONS_LEGACY = 210000
  const PBKDF2_ITERATIONS = 600000
  const CHUNK_SIZE = 64 * 1024 * 1024  // 64MB per AES-GCM chunk
  const NONCE_SIZE = 12  // 96-bit nonce for AES-GCM
  const KEY_SIZE = 32    // 256-bit keys
  const RSA_KEY_SIZE = 4096
  const TAG_SIZE = 16    // 128-bit GCM authentication tag

  // ─── Web Worker Bridge ────────────────────────────────────────────
  // Offloads heavy CPU operations (PBKDF2, file encrypt/decrypt) to a
  // background thread so the UI stays responsive.

  let _worker = null
  let _workerMsgId = 0
  const _workerCallbacks = new Map()

  function _failWorker(worker, error) {
    const failure = error instanceof Error ? error : new Error(String(error || 'Worker failed'))
    _workerCallbacks.forEach(function(cb, id) {
      if (cb.worker === worker) {
        _workerCallbacks.delete(id)
        cb.reject(failure)
      }
    })
    try { worker.terminate() } catch (e) {}
    if (_worker === worker) _worker = null
  }

  function _getWorker() {
    if (!_worker) {
      try {
        // The shells give the versioned URL: an unversioned one is cached for a
        // year. Else resolve it relative to crypto.js.
        const meta = document.querySelector('meta[name="onegy-crypto-worker"]')
        const scripts = document.getElementsByTagName('script')
        let basePath = '/static/'
        for (let i = 0; i < scripts.length; i++) {
          const src = scripts[i].src || ''
          if (src.includes('crypto.js')) {
            basePath = src.substring(0, src.lastIndexOf('/') + 1)
            break
          }
        }
        _worker = new Worker(meta ? meta.content : basePath + 'crypto-worker.js')
        const worker = _worker
        worker.onmessage = function(e) {
          const { id, result, error, type, progress } = e.data
          // AUDIT FIX F4: progress frames now carry the request id, so they are
          // routed to the caller's onProgress instead of being dropped (they
          // previously had no id and were discarded here).
          if (type === 'progress') {
            const pcb = _workerCallbacks.get(id)
            if (pcb && pcb.onProgress) {
              try { pcb.onProgress(progress) } catch (_) {}
            }
            return
          }
          const cb = _workerCallbacks.get(id)
          if (cb) {
            _workerCallbacks.delete(id)
            if (error) cb.reject(new Error(error))
            else cb.resolve(result)
          }
        }
        worker.onerror = function(err) {
          console.warn('[CRYPTO] Worker error, falling back to main thread:', err.message)
          _failWorker(worker, new Error(err.message || 'Worker failed'))
        }
        worker.onmessageerror = function() {
          console.warn('[CRYPTO] Worker message error, falling back to main thread')
          _failWorker(worker, new Error('Worker message could not be read'))
        }
      } catch (e) {
        console.warn('[CRYPTO] Web Worker not available, using main thread:', e.message)
        _worker = null
      }
    }
    return _worker
  }

  function _workerCall(op, data, transfer, onProgress) {
    return new Promise(function(resolve, reject) {
      const w = _getWorker()
      if (!w) {
        reject(new Error('Worker unavailable'))
        return
      }
      const id = ++_workerMsgId
      _workerCallbacks.set(id, { resolve, reject, worker: w, onProgress: onProgress || null })
      const msg = Object.assign({ id, op }, data)
      try {
        if (transfer) w.postMessage(msg, transfer)
        else w.postMessage(msg)
      } catch (e) {
        _workerCallbacks.delete(id)
        reject(e)
      }
    })
  }

  // ─── Utility Functions ────────────────────────────────────────────

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  function fromBase64(str) {
    // Normalize URL-safe base64 to standard base64 before decoding
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/')
    const pad = (4 - b64.length % 4) % 4
    b64 += '='.repeat(pad)
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n))
  }

  function randomNonce() {
    return randomBytes(NONCE_SIZE)
  }

  /**
   * Derive a nonce for a specific chunk from a base nonce + chunk index.
   * XOR the chunk index (as 4 big-endian bytes) into the last 4 bytes of the nonce.
   * This ensures unique nonces per chunk without requiring random nonces per chunk.
   */
  function deriveChunkNonce(baseNonce, chunkIndex) {
    const derived = new Uint8Array(baseNonce)
    const view = new DataView(derived.buffer, derived.byteOffset, derived.byteLength)
    // XOR chunk index into last 4 bytes of nonce
    const offset = NONCE_SIZE - 4
    const existing = view.getUint32(offset, false)
    view.setUint32(offset, existing ^ chunkIndex, false)
    return derived
  }

  function concatBuffers(...buffers) {
    let total = 0
    for (const b of buffers) total += b.byteLength
    const result = new Uint8Array(total)
    let offset = 0
    for (const b of buffers) {
      result.set(new Uint8Array(b), offset)
      offset += b.byteLength
    }
    return result
  }

  // ─── Key Derivation ───────────────────────────────────────────────

  /**
   * Derive an AES-256-GCM wrapping key from a password + salt using PBKDF2.
   * This is the LEGACY path (210K iterations) used only when wrapping/unwrapping
   * master keys with a raw password string. The new split-key path uses
   * deriveAuthAndWrappingKeys() with 600K iterations + HKDF instead.
   * Returns { key: CryptoKey, salt: Uint8Array }
   */
  async function _deriveWrappingKeyMainThread(password, salt) {
    if (!salt) salt = randomBytes(32)
    const encoder = new TextEncoder()
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
    )
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS_LEGACY, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    )
    return { key, salt: new Uint8Array(salt) }
  }

  async function deriveWrappingKey(password, salt) {
    try {
      const r = await _workerCall('deriveWrappingKey', {
        password: password,
        salt: salt ? toBase64(salt) : null
      })
      const keyBytes = fromBase64(r.keyRaw)
      const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'AES-GCM' }, false,
        ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
      )
      return { key, salt: fromBase64(r.salt) }
    } catch (_) {
      return _deriveWrappingKeyMainThread(password, salt)
    }
  }

  /**
   * Derive an AES-256-GCM key from a passphrase for guest uploads (file key wrapping).
   * Uses legacy 210K iterations for passphrase-based E2E (temp uploads, CLI).
   */
  async function _derivePassphraseKeyMainThread(passphrase, salt) {
    if (!salt) salt = randomBytes(32)
    const encoder = new TextEncoder()
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    )
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS_LEGACY, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    )
    return { key, salt: new Uint8Array(salt) }
  }

  async function derivePassphraseKey(passphrase, salt) {
    try {
      const r = await _workerCall('derivePassphraseKey', {
        passphrase: passphrase,
        salt: salt ? toBase64(salt) : null
      })
      const keyBytes = fromBase64(r.keyRaw)
      const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'AES-GCM' }, false,
        ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
      )
      return { key, salt: fromBase64(r.salt) }
    } catch (_) {
      return _derivePassphraseKeyMainThread(passphrase, salt)
    }
  }

  /**
   * Split-key password derivation (Finding 2+6).
   * PBKDF2(password, salt, 600K iterations) → 512 bits → HKDF split into:
   *   - authToken (256 bits): sent to server for authentication (server stores SHA-256 hash)
   *   - wrappingKey (AES-256-GCM CryptoKey): kept local, wraps/unwraps master key
   *
   * The server NEVER sees the raw password — only the auth token.
   * Returns { authToken: base64, wrappingKey: CryptoKey, salt: base64 }
   */
  async function _deriveAuthAndWrappingKeysMainThread(password, salt) {
    if (!salt) salt = randomBytes(32)
    else if (typeof salt === 'string') salt = fromBase64(salt)
    const encoder = new TextEncoder()
    // Step 1: PBKDF2 → 512 bits of key material
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
    )
    const derived512 = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial, 512
    )
    // Step 2: HKDF split into auth token (256 bits) and wrapping key (256 bits)
    const hkdfMaterial = await crypto.subtle.importKey(
      'raw', derived512, 'HKDF', false, ['deriveBits', 'deriveKey']
    )
    // Auth token: 256 bits — sent to server
    const authTokenBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('onegy-auth-v1'), info: encoder.encode('auth') },
      hkdfMaterial, 256
    )
    // Wrapping key: AES-256-GCM CryptoKey — kept local
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('onegy-wrap-v1'), info: encoder.encode('wrap') },
      hkdfMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    )
    return {
      authToken: toBase64(authTokenBits),
      wrappingKey,
      salt: toBase64(salt)
    }
  }

  async function deriveAuthAndWrappingKeys(password, salt) {
    // Try Web Worker first (keeps UI responsive during 600K PBKDF2)
    try {
      const r = await _workerCall('deriveAuthAndWrappingKeys', {
        password: password,
        salt: salt ? (typeof salt === 'string' ? salt : toBase64(salt)) : null
      })
      // Re-import wrapping key from raw bytes (CryptoKey can't cross worker boundary)
      const wkBytes = fromBase64(r.wrappingKeyRaw)
      const wrappingKey = await crypto.subtle.importKey(
        'raw', wkBytes, { name: 'AES-GCM' }, false,
        ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
      )
      return { authToken: r.authToken, wrappingKey, salt: r.salt }
    } catch (_) {
      // Fall back to main thread
      return _deriveAuthAndWrappingKeysMainThread(password, salt)
    }
  }

  // ─── Master Key Generation & Management ───────────────────────────

  /**
   * Generate a new random AES-256 master key.
   * Returns raw 32-byte key as CryptoKey (extractable for wrapping).
   */
  async function generateMasterKey() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,  // extractable — needed for export and wrapping
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    )
  }

  /**
   * Encrypt (wrap) a master key with a wrapping key (from split-key derivation).
   * If wrappingKey is a CryptoKey, uses it directly (new split-key path).
   * If wrappingKey is a string, treats it as a password (legacy path — derives key via PBKDF2).
   * Returns { encryptedMasterKey: base64, nonce: base64, salt: base64 }
   */
  async function wrapMasterKey(masterKey, wrappingKeyOrPassword, existingSalt) {
    let wrappingKey, salt
    if (typeof wrappingKeyOrPassword === 'string') {
      // AUDIT FIX M5: LEGACY-ONLY path (210K PBKDF2). New wraps MUST use the
      // 600K split-key wrappingKey (CryptoKey) branch below. Creating a new wrap
      // here downgrades the account's offline-cracking resistance; this branch is
      // retained only for backward compatibility and must not be used for new
      // credentials.
      console.warn('[CRYPTO] wrapMasterKey called with a raw password (legacy 210K path) — ' +
        'this is a security downgrade; new wraps must use the split-key wrappingKey.')
      const derived = await deriveWrappingKey(wrappingKeyOrPassword)
      wrappingKey = derived.key
      salt = derived.salt
    } else {
      // New: CryptoKey from split-key derivation (salt managed externally)
      wrappingKey = wrappingKeyOrPassword
      salt = existingSalt ? (typeof existingSalt === 'string' ? fromBase64(existingSalt) : existingSalt) : new Uint8Array(0)
    }
    const nonce = randomNonce()
    const wrapped = await crypto.subtle.wrapKey('raw', masterKey, wrappingKey, {
      name: 'AES-GCM', iv: nonce
    })
    return {
      encryptedMasterKey: toBase64(wrapped),
      nonce: toBase64(nonce),
      salt: toBase64(salt)
    }
  }

  /**
   * Decrypt (unwrap) a master key using a wrapping key or password.
   * If wrappingKeyOrPassword is a CryptoKey, uses it directly (new split-key path).
   * If wrappingKeyOrPassword is a string, treats it as a password (legacy path).
   * Returns CryptoKey (the master key).
   */
  async function unwrapMasterKey(encryptedMasterKey, nonce, salt, wrappingKeyOrPassword) {
    let wrappingKey
    if (typeof wrappingKeyOrPassword === 'string') {
      // Legacy: password string → derive wrapping key via PBKDF2
      const derived = await deriveWrappingKey(wrappingKeyOrPassword, fromBase64(salt))
      wrappingKey = derived.key
    } else {
      // New: CryptoKey from split-key derivation
      wrappingKey = wrappingKeyOrPassword
    }
    return crypto.subtle.unwrapKey(
      'raw',
      fromBase64(encryptedMasterKey),
      wrappingKey,
      { name: 'AES-GCM', iv: fromBase64(nonce) },
      { name: 'AES-GCM', length: 256 },
      true,  // extractable — needed for recovery key export and re-wrapping
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    )
  }

  /**
   * DEPRECATED / DISABLED (AUDIT FIX M5).
   *
   * This previously did `wrapMasterKey(masterKey, newPassword)` with a *string*
   * password, which routes through the LEGACY 210,000-iteration PBKDF2 path and
   * wraps the master key directly from the password — silently DOWNGRADING an
   * account from the 600K-iteration split-key scheme back to a weaker
   * password-wrapped master key (easier offline cracking). No code path calls
   * it; password changes and recovery all re-wrap with the 600K split-key
   * wrappingKey via wrapMasterKey(masterKey, wrappingKey, salt). It now throws
   * so it can never be used to create a weaker wrap by mistake.
   */
  async function rewrapMasterKey(masterKey, newPassword) {
    throw new Error('rewrapMasterKey is disabled (AUDIT FIX M5): re-wrap with the ' +
      '600K split-key wrapping key via wrapMasterKey(masterKey, wrappingKey, salt) ' +
      'derived from deriveAuthAndWrappingKeys(), not a raw password.')
  }

  /**
   * Export master key as base64 recovery key.
   * This is the raw 32-byte key — the user MUST keep this safe.
   */
  async function exportRecoveryKey(masterKey) {
    const raw = await crypto.subtle.exportKey('raw', masterKey)
    return toBase64(raw)
  }

  /**
   * Import a recovery key (base64) back into a CryptoKey.
   */
  async function importRecoveryKey(recoveryKeyBase64) {
    const raw = fromBase64(recoveryKeyBase64)
    if (raw.length !== KEY_SIZE) throw new Error('Invalid recovery key length')
    return crypto.subtle.importKey(
      'raw', raw, { name: 'AES-GCM', length: 256 }, true,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    )
  }

  /**
   * Hash a master key for recovery verification (SHA-256).
   * Server derives a keyed verifier from this hash; raw recovery key is never sent.
   */
  async function hashMasterKey(masterKey) {
    const raw = await crypto.subtle.exportKey('raw', masterKey)
    const hash = await crypto.subtle.digest('SHA-256', raw)
    return toBase64(hash)
  }

  /**
   * AUDIT FIX M3: generate an INDEPENDENT recovery key and wrap the master key
   * under it. The recovery key is deliberately NOT the master key: file keys and
   * folder/notebook name keys are wrapped directly under the master key, so the
   * master key itself can never be rotated client-side. A decoupled recovery key
   * CAN be rotated (at recovery) without touching any encrypted data — the
   * server stores the wrap returned here and hands it back during recovery.
   * Returns {
   *   recoveryKey: base64 raw recovery key (user MUST save this),
   *   recoveryKeyHash: base64 SHA-256 of the recovery key (server derives its verifier),
   *   recoveryWrappedMasterKey: base64 AES-GCM(master key) under the recovery key,
   *   recoveryKeyNonce: base64 12-byte nonce
   * }
   */
  async function createRecoveryKeyWrap(masterKey) {
    const recoveryKey = await generateMasterKey()
    const nonce = randomNonce()
    const wrapped = await crypto.subtle.wrapKey('raw', masterKey, recoveryKey, {
      name: 'AES-GCM', iv: nonce
    })
    return {
      recoveryKey: await exportRecoveryKey(recoveryKey),
      recoveryKeyHash: await hashMasterKey(recoveryKey),
      recoveryWrappedMasterKey: toBase64(wrapped),
      recoveryKeyNonce: toBase64(nonce)
    }
  }

  /**
   * AUDIT FIX M3: recover the master key from the server-stored recovery wrap
   * (recovery_wrapped_master_key + recovery_key_nonce from
   * /api/keys/recovery/challenge) using the user's recovery key.
   * Returns the master key as a CryptoKey.
   */
  async function unwrapMasterKeyWithRecoveryKey(recoveryKeyBase64, wrappedMasterKeyBase64, nonceBase64) {
    const recoveryKey = await importRecoveryKey(recoveryKeyBase64)
    return crypto.subtle.unwrapKey(
      'raw',
      fromBase64(wrappedMasterKeyBase64),
      recoveryKey,
      { name: 'AES-GCM', iv: fromBase64(nonceBase64) },
      { name: 'AES-GCM', length: 256 },
      true,  // extractable — needed for re-wrapping and recovery export
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    )
  }

  // ─── RSA Keypair Generation & Management ──────────────────────────

  /**
   * Generate an RSA-OAEP 4096-bit keypair for sharing.
   * Returns { publicKey: CryptoKey, privateKey: CryptoKey }
   */
  async function generateRSAKeyPair() {
    return crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: RSA_KEY_SIZE,
        publicExponent: new Uint8Array([1, 0, 1]),  // 65537
        hash: 'SHA-256'
      },
      true,  // extractable
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    )
  }

  /**
   * Export RSA public key as JWK (stored on server in plaintext for other users).
   */
  async function exportPublicKey(publicKey) {
    return JSON.stringify(await crypto.subtle.exportKey('jwk', publicKey))
  }

  /**
   * Import RSA public key from JWK string.
   */
  async function importPublicKey(jwkString) {
    const jwk = JSON.parse(jwkString)
    return crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true,
      ['encrypt', 'wrapKey']
    )
  }

  /**
   * AUDIT FIX C2: compute a stable SHA-256 fingerprint of a recipient's RSA
   * public key (over the DER SPKI encoding). Used for trust-on-first-use
   * pinning + out-of-band verification when sharing to another account.
   * Account-to-account sharing wraps a file/note key to a recipient public key
   * that is fetched from the (untrusted) server; without verification a
   * malicious/compromised server could substitute its OWN key and silently
   * decrypt the "E2EE" share. Comparing this fingerprint against a locally
   * pinned value (or a value the users verify out of band) detects substitution.
   * Accepts a JWK string or an imported CryptoKey. Returns an UPPERCASE hex
   * string grouped in 4-char blocks for readability.
   */
  async function publicKeyFingerprint(publicKeyOrJwk) {
    let key = publicKeyOrJwk
    if (typeof publicKeyOrJwk === 'string') {
      key = await importPublicKey(publicKeyOrJwk)
    } else if (publicKeyOrJwk && publicKeyOrJwk.kty) {
      key = await importPublicKey(JSON.stringify(publicKeyOrJwk))
    }
    const spki = await crypto.subtle.exportKey('spki', key)
    const digest = await crypto.subtle.digest('SHA-256', spki)
    const bytes = new Uint8Array(digest)
    let hex = ''
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
    return hex.toUpperCase().replace(/(.{4})/g, '$1 ').trim()
  }

  /**
   * Encrypt (wrap) the RSA private key with the master key.
   * Returns { encryptedPrivateKey: base64, nonce: base64 }
   */
  async function wrapPrivateKey(privateKey, masterKey) {
    const nonce = randomNonce()
    // Export private key to PKCS8, then encrypt with AES-GCM
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey)
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce }, masterKey, pkcs8
    )
    return {
      encryptedPrivateKey: toBase64(encrypted),
      nonce: toBase64(nonce)
    }
  }

  /**
   * Decrypt (unwrap) the RSA private key with the master key.
   */
  async function unwrapPrivateKey(encryptedPrivateKey, nonce, masterKey) {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(nonce) },
      masterKey,
      fromBase64(encryptedPrivateKey)
    )
     return crypto.subtle.importKey(
       'pkcs8', decrypted,
       { name: 'RSA-OAEP', hash: 'SHA-256' },
       false,
       ['decrypt', 'unwrapKey']
     )
   }

  // ─── Per-File Key Generation & Wrapping ───────────────────────────

  /**
   * Generate a random AES-256-GCM file key.
   */
  async function generateFileKey() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,  // extractable — needed for wrapping
      ['encrypt', 'decrypt']
    )
  }

  /**
   * Wrap a file key with the user's master key (for registered users).
   * Returns { encryptedFileKey: base64, nonce: base64 }
   */
  async function wrapFileKeyWithMasterKey(fileKey, masterKey) {
    const nonce = randomNonce()
    const wrapped = await crypto.subtle.wrapKey('raw', fileKey, masterKey, {
      name: 'AES-GCM', iv: nonce
    })
    return {
      encryptedFileKey: toBase64(wrapped),
      nonce: toBase64(nonce)
    }
  }

  /**
   * Unwrap a file key with the user's master key.
   */
  async function unwrapFileKeyWithMasterKey(encryptedFileKey, nonce, masterKey) {
    return crypto.subtle.unwrapKey(
      'raw',
      fromBase64(encryptedFileKey),
      masterKey,
      { name: 'AES-GCM', iv: fromBase64(nonce) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  }

  /**
   * Wrap a file key with a passphrase-derived key (for guest uploads).
   * Returns { encryptedFileKey: base64, nonce: base64, salt: base64 }
   */
  async function wrapFileKeyWithPassphrase(fileKey, passphrase) {
    const { key: wrappingKey, salt } = await derivePassphraseKey(passphrase)
    const nonce = randomNonce()
    const wrapped = await crypto.subtle.wrapKey('raw', fileKey, wrappingKey, {
      name: 'AES-GCM', iv: nonce
    })
    return {
      encryptedFileKey: toBase64(wrapped),
      nonce: toBase64(nonce),
      salt: toBase64(salt)
    }
  }

  /**
   * Unwrap a file key with a passphrase-derived key (for guest downloads).
   */
  async function unwrapFileKeyWithPassphrase(encryptedFileKey, nonce, salt, passphrase) {
    const { key: wrappingKey } = await derivePassphraseKey(passphrase, fromBase64(salt))
    return crypto.subtle.unwrapKey(
      'raw',
      fromBase64(encryptedFileKey),
      wrappingKey,
      { name: 'AES-GCM', iv: fromBase64(nonce) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  }

  /**
   * Wrap a file key with an RSA public key (for sharing to another user).
   * Returns { encryptedFileKey: base64 }
   */
  async function wrapFileKeyWithRSA(fileKey, recipientPublicKey, opts) {
    opts = opts || {}
    const fp = await publicKeyFingerprint(recipientPublicKey)
    const fpNorm = fp.replace(/\s/g, '').toUpperCase()
    if (opts.expectedFingerprint) {
      const expected = String(opts.expectedFingerprint).replace(/\s/g, '').toUpperCase()
      if (expected !== fpNorm) {
        throw new Error('RECIPIENT PUBLIC KEY FINGERPRINT MISMATCH')
      }
    }
    const pinKey = opts.username ? ('user:' + String(opts.username).toLowerCase()) : ('fp:' + fpNorm)
    let pins = {}
    try { pins = JSON.parse(localStorage.getItem('onegy_rsa_tofu') || '{}') } catch (e) { pins = {} }
    if (opts.username && pins[pinKey] && pins[pinKey] !== fpNorm) {
      throw new Error('RECIPIENT PUBLIC KEY CHANGED (TOFU PIN MISMATCH)')
    }
    pins[pinKey] = fpNorm
    try { localStorage.setItem('onegy_rsa_tofu', JSON.stringify(pins)) } catch (e) {}
    const wrapped = await crypto.subtle.wrapKey('raw', fileKey, recipientPublicKey, {
      name: 'RSA-OAEP'
    })
    return { encryptedFileKey: toBase64(wrapped), fingerprint: fp }
  }

  /**
   * Unwrap a file key with an RSA private key (for receiving shared file).
   */
  async function unwrapFileKeyWithRSA(encryptedFileKey, privateKey) {
    return crypto.subtle.unwrapKey(
      'raw',
      fromBase64(encryptedFileKey),
      privateKey,
      { name: 'RSA-OAEP' },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  }

  /**
   * Derive a deterministic link secret from the master key + resource identifier.
   * Uses HKDF-SHA256 so the server never needs to store the link secret.
   * The owner can always re-derive the same secret from their master key.
   * Returns { linkSecret: base64url, linkKey: CryptoKey }
   */
  async function deriveLinkSecret(masterKey, resourceType, resourceId) {
    const encoder = new TextEncoder()
    const rawMaster = await crypto.subtle.exportKey('raw', masterKey)
    const keyMaterial = await crypto.subtle.importKey(
      'raw', rawMaster, 'HKDF', false, ['deriveKey', 'deriveBits']
    )
    const info = encoder.encode(resourceType + ':' + resourceId)
    const linkSecretBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('onegy-link-secret-v1'), info: info },
      keyMaterial, 256
    )
    const linkSecretBytes = new Uint8Array(linkSecretBits)
    const linkKey = await crypto.subtle.importKey(
      'raw', linkSecretBytes, { name: 'AES-GCM', length: 256 }, false,
      ['wrapKey', 'unwrapKey']
    )
    // base64url encoding for URL fragment safety
    let b64 = toBase64(linkSecretBytes)
    b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return { linkSecret: b64, linkKey }
  }

  /**
   * Wrap a file key for a share link using a provided link key.
   * The link key should come from deriveLinkSecret().
   * Returns { encryptedFileKey: base64, nonce: base64 }
   */
  async function wrapFileKeyForLink(fileKey, linkKey) {
    const nonce = randomNonce()
    const wrapped = await crypto.subtle.wrapKey('raw', fileKey, linkKey, {
      name: 'AES-GCM', iv: nonce
    })
    return {
      encryptedFileKey: toBase64(wrapped),
      nonce: toBase64(nonce)
    }
  }

  /**
   * Unwrap a file key from a share link.
   */
  async function unwrapFileKeyFromLink(encryptedFileKey, nonce, linkSecretBase64) {
    const linkSecretBytes = fromBase64(linkSecretBase64)
    const linkKey = await crypto.subtle.importKey(
      'raw', linkSecretBytes, { name: 'AES-GCM', length: 256 }, false,
      ['wrapKey', 'unwrapKey']
    )
    return crypto.subtle.unwrapKey(
      'raw',
      fromBase64(encryptedFileKey),
      linkKey,
      { name: 'AES-GCM', iv: fromBase64(nonce) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  }

  // ─── File Encryption (Chunked AES-256-GCM) ───────────────────────

  /**
   * Header format for encrypted files:
   * [1 byte: version] [4 bytes: chunk count (big-endian)] [12 bytes: base nonce]
   * Then for each chunk:
   * [4 bytes: encrypted chunk length (big-endian)] [encrypted chunk data (includes GCM tag)]
   */
  // AUDIT FIX H3: v2 binds chunk metadata into each chunk's GCM AAD (see
  // chunkAAD). v1 (no AAD) is still ACCEPTED on decrypt for backward
  // compatibility with already-stored files. New encryptions always use v2.
  const FILE_FORMAT_VERSION = 2
  const SUPPORTED_FILE_FORMAT_VERSIONS = [1, 2]
  const HEADER_SIZE = 1 + 4 + NONCE_SIZE  // 17 bytes

  /**
   * AUDIT FIX H3: per-chunk Additional Authenticated Data. Binds the format
   * version, the TOTAL chunk count, this chunk's index, and a final-chunk flag
   * into every chunk's GCM tag. Previously each chunk was an INDEPENDENT GCM
   * token with EMPTY AAD and nothing authenticated the header (version,
   * chunkCount, base nonce) or a chunk's position, so an active adversary
   * (malicious server / MITM past TLS) could silently TRUNCATE a file by
   * dropping trailing chunks and lowering the header chunkCount — every
   * remaining chunk still verified, yielding a truncated plaintext with no
   * error. Binding chunkCount + index makes any such tampering fail GCM
   * authentication. Returns undefined for v1 (legacy, no AAD).
   * Layout (10 bytes): version(1) || chunkCount(4 BE) || chunkIndex(4 BE) || isLast(1)
   */
  function chunkAAD(version, chunkCount, chunkIndex) {
    if (version < 2) return undefined
    const aad = new Uint8Array(10)
    const dv = new DataView(aad.buffer)
    aad[0] = version & 0xff
    dv.setUint32(1, chunkCount >>> 0, false)
    dv.setUint32(5, chunkIndex >>> 0, false)
    aad[9] = (chunkIndex === chunkCount - 1) ? 1 : 0
    return aad
  }

  // ─── AUDIT FIX F1: legacy (v1) container flag ─────────────────────
  // v1 containers decrypt fine (old stored files must stay readable) but they
  // carry no AAD, so chunk order/truncation/reorder are NOT authenticated —
  // only v2 has that binding. Silent acceptance would hide the difference, so
  // every decrypt records the container version, v1 logs an explicit warning,
  // and wasLastContainerLegacy() lets the UI surface it (e2e_download.html).
  //
  // Authenticated migration (re-encrypting a stored v1 file as v2 on next
  // successful decrypt) is deliberately NOT done: it would require re-uploading
  // ciphertext and rewriting server-side size/integrity/replication metadata
  // (app.py territory, out of scope) — an untested container rewrite risks
  // corrupting stored files. Explicit warning instead, per the audit plan.
  let _lastContainerVersion = null

  function _peekContainerVersion(encryptedData) {
    try {
      let u8 = null
      if (encryptedData instanceof ArrayBuffer) u8 = new Uint8Array(encryptedData, 0, 1)
      else if (ArrayBuffer.isView(encryptedData)) u8 = new Uint8Array(encryptedData.buffer, encryptedData.byteOffset, 1)
      return u8 && u8.length ? u8[0] : null
    } catch (e) {
      return null
    }
  }

  function wasLastContainerLegacy() {
    return _lastContainerVersion === 1
  }

  function _noteContainerVersion(encryptedData) {
    _lastContainerVersion = _peekContainerVersion(encryptedData)
    if (_lastContainerVersion === 1) {
      console.warn('[CRYPTO] Decrypting LEGACY v1 container: chunk order and truncation are ' +
        'NOT authenticated (AUDIT FIX H3 applies to v2 only). Re-upload the file to upgrade.')
    }
  }

  /**
   * Encrypt file data with a file key using chunked AES-256-GCM.
   * Returns an ArrayBuffer containing the encrypted file with header.
   * Supports files of any size via chunking (each chunk < 2GB limit).
   *
   * Tries Web Worker first (keeps UI responsive), falls back to main thread.
   *
   * @param {ArrayBuffer} data - plaintext file data
   * @param {CryptoKey} fileKey - AES-256-GCM file key
   * @param {function} onProgress - optional callback (0-100)
   * @returns {ArrayBuffer} encrypted file with header
   */
  async function encryptFileData(data, fileKey, onProgress) {
    // Try worker first — export fileKey to raw bytes for transfer
    try {
      const rawKey = await crypto.subtle.exportKey('raw', fileKey)
      const fileKeyRaw = toBase64(rawKey)

      // AUDIT FIX F4: Blob/File input (e.g. the temp uploader passes the File
      // itself instead of a full ArrayBuffer) is structured-cloned to the worker
      // as a cheap handle — NOT copied — and read in CHUNK_SIZE slices inside
      // the worker, so the full plaintext is never materialized on the main
      // thread. Output framing is byte-identical to the ArrayBuffer path.
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        const result = await _workerCall('encryptFileBlob', {
          blob: data, fileKeyRaw: fileKeyRaw
        }, undefined, onProgress)
        if (onProgress) onProgress(100)
        return result.encrypted
      }

      // Clone data into a transferable ArrayBuffer for the worker
      const dataCopy = data.slice ? data.slice(0) : new Uint8Array(data).buffer
      const result = await _workerCall('encryptFileData', {
        data: dataCopy, fileKeyRaw: fileKeyRaw
      }, [dataCopy], onProgress)
      if (onProgress) onProgress(100)
      return result.encrypted
    } catch (_) {
      // Fall back to main thread
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return _encryptBlobMainThread(data, fileKey, onProgress)
    }
    return _encryptFileDataMainThread(data, fileKey, onProgress)
  }

  // AUDIT FIX F4: main-thread streaming encrypt for Blob input (worker
  // unavailable). Reads one CHUNK_SIZE slice at a time so plaintext never
  // fully materializes; output buffer is preallocated to its exact size.
  async function _encryptBlobMainThread(blob, fileKey, onProgress) {
    const totalSize = blob.size
    const chunkCount = Math.ceil(totalSize / CHUNK_SIZE) || 1
    const baseNonce = randomNonce()
    const out = _allocEncryptedBuffer(chunkCount, totalSize)
    out[0] = FILE_FORMAT_VERSION
    new DataView(out.buffer).setUint32(1, chunkCount, false)
    out.set(baseNonce, 5)
    let offset = HEADER_SIZE
    let processedBytes = 0
    for (let i = 0; i < chunkCount; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, totalSize)
      const chunk = new Uint8Array(await blob.slice(start, end).arrayBuffer())
      offset = await _sealChunkInto(out, offset, fileKey, chunk, chunkCount, i)
      processedBytes += (end - start)
      if (onProgress) onProgress(Math.round(processedBytes / totalSize * 100))
    }
    if (offset !== out.length) throw new Error('internal: encrypted container size mismatch')
    return out.buffer
  }

  /**
   * AUDIT FIX F4: exact output size for an encryption of totalSize bytes in
   * chunkCount chunks: header + per chunk (4-byte length prefix + data + tag).
   * Preallocating once replaces the old chunks-array + concatBuffers pattern,
   * which held a SECOND full copy of the ciphertext in memory at merge time.
   */
  function _allocEncryptedBuffer(chunkCount, totalSize) {
    let size = HEADER_SIZE
    for (let i = 0; i < chunkCount; i++) {
      const chunkLen = Math.min(CHUNK_SIZE, totalSize - i * CHUNK_SIZE)
      size += 4 + chunkLen + TAG_SIZE
    }
    return new Uint8Array(size)
  }

  // Encrypt one chunk (async WebCrypto) and write [4-byte BE length][ciphertext]
  // at `offset` inside `out`. Returns the offset after the written bytes.
  async function _sealChunkInto(out, offset, fileKey, chunk, chunkCount, i) {
    const chunkNonce = deriveChunkNonce(out.subarray(5, 5 + NONCE_SIZE), i)
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: chunkNonce, tagLength: 128, additionalData: chunkAAD(FILE_FORMAT_VERSION, chunkCount, i) },
      fileKey,
      chunk
    )
    new DataView(out.buffer, out.byteOffset).setUint32(offset, encrypted.byteLength, false)
    offset += 4
    out.set(new Uint8Array(encrypted), offset)
    offset += encrypted.byteLength
    return offset
  }

  async function _encryptFileDataMainThread(data, fileKey, onProgress) {
    const plaintext = new Uint8Array(data)
    const totalSize = plaintext.length
    const chunkCount = Math.ceil(totalSize / CHUNK_SIZE) || 1
    const baseNonce = randomNonce()

    // AUDIT FIX F4: preallocate the exact output size and seal each chunk
    // straight into it (see _allocEncryptedBuffer). The previous
    // chunks-array + concatBuffers merge held a second full copy of the
    // ciphertext in memory — the peak-memory bug this replaced.
    const out = _allocEncryptedBuffer(chunkCount, totalSize)
    out[0] = FILE_FORMAT_VERSION
    new DataView(out.buffer).setUint32(1, chunkCount, false)
    out.set(baseNonce, 5)

    let offset = HEADER_SIZE
    let processedBytes = 0

    for (let i = 0; i < chunkCount; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, totalSize)
      const chunk = plaintext.subarray(start, end) // view, not a copy

      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: deriveChunkNonce(baseNonce, i), tagLength: 128, additionalData: chunkAAD(FILE_FORMAT_VERSION, chunkCount, i) },
        fileKey,
        chunk
      )

      new DataView(out.buffer, out.byteOffset).setUint32(offset, encrypted.byteLength, false)
      offset += 4
      out.set(new Uint8Array(encrypted), offset)
      offset += encrypted.byteLength

      processedBytes += (end - start)
      if (onProgress) onProgress(Math.round(processedBytes / totalSize * 100))
    }

    if (offset !== out.length) throw new Error('internal: encrypted container size mismatch')
    return out.buffer
  }

  /**
   * Decrypt file data with a file key using chunked AES-256-GCM.
   * Input is the encrypted file ArrayBuffer with header.
   *
   * Tries Web Worker first (keeps UI responsive), falls back to main thread.
   *
   * @param {ArrayBuffer} encryptedData - encrypted file with header
   * @param {CryptoKey} fileKey - AES-256-GCM file key
   * @param {function} onProgress - optional callback (0-100)
   * @returns {ArrayBuffer} decrypted plaintext
   */
  async function decryptFileData(encryptedData, fileKey, onProgress) {
    // AUDIT FIX F1: record the container version up-front (v1 => legacy warning
    // + wasLastContainerLegacy() true) before any worker/main-thread work.
    _noteContainerVersion(encryptedData)
    // Try worker first — export fileKey to raw bytes for transfer
    try {
      const rawKey = await crypto.subtle.exportKey('raw', fileKey)
      const fileKeyRaw = toBase64(rawKey)
      // Clone data into a transferable ArrayBuffer for the worker
      const dataCopy = encryptedData.slice ? encryptedData.slice(0) : new Uint8Array(encryptedData).buffer
      const result = await _workerCall('decryptFileData', {
        data: dataCopy, fileKeyRaw: fileKeyRaw
      }, [dataCopy], onProgress)
      if (onProgress) onProgress(100)
      return result.decrypted
    } catch (_) {
      // Fall back to main thread
    }
    return _decryptFileDataMainThread(encryptedData, fileKey, onProgress)
  }

  async function _decryptFileDataMainThread(encryptedData, fileKey, onProgress) {
    const data = new Uint8Array(encryptedData)
    const view = new DataView(encryptedData)

    // Read header
    const version = data[0]
    if (SUPPORTED_FILE_FORMAT_VERSIONS.indexOf(version) === -1) {
      throw new Error(`Unsupported encrypted file format version: ${version}`)
    }
    const chunkCount = view.getUint32(1, false)
    if (chunkCount < 1) {
      throw new Error('invalid encrypted container: header declares 0 chunks')
    }
    const baseNonce = data.slice(5, 5 + NONCE_SIZE)

    // AUDIT FIX F4 + F1: first pass validates every length prefix (bounds,
    // min tag, max chunk) and totals the plaintext size WITHOUT storing the
    // per-chunk lengths, so the plaintext buffer can be allocated exactly
    // once. The old decrypted-chunks array + concatBuffers merge held a
    // second full copy of the plaintext in memory. chunkCount is bounded by
    // the input size here (each chunk costs >= 4 + TAG_SIZE bytes), which
    // also rejects absurd tampered headers before any allocation.
    const MIN_CHUNK_WIRE = 4 + TAG_SIZE
    if (chunkCount > Math.floor((data.length - HEADER_SIZE) / MIN_CHUNK_WIRE)) {
      throw new Error('invalid encrypted container: chunk count exceeds container size')
    }
    let offset = HEADER_SIZE
    let totalPlain = 0
    for (let i = 0; i < chunkCount; i++) {
      if (offset + 4 > data.length) {
        throw new Error('unexpected end of data at chunk ' + i + ' (reading length)')
      }
      const chunkLen = view.getUint32(offset, false)
      offset += 4
      if (chunkLen < TAG_SIZE || chunkLen > CHUNK_SIZE + TAG_SIZE) {
        throw new Error('invalid encrypted chunk length at chunk ' + i + ': ' + chunkLen)
      }
      if (offset + chunkLen > data.length) {
        throw new Error('unexpected end of data at chunk ' + i)
      }
      offset += chunkLen
      totalPlain += chunkLen - TAG_SIZE
    }
    if (offset !== data.length) {
      throw new Error('encrypted container has ' + (data.length - offset) + ' trailing byte(s)')
    }

    const out = new Uint8Array(totalPlain)
    offset = HEADER_SIZE
    let outOff = 0

    for (let i = 0; i < chunkCount; i++) {
      offset += 4 // length prefix — validated above
      const chunkLen = view.getUint32(offset - 4, false)
      const chunkData = data.subarray(offset, offset + chunkLen)
      offset += chunkLen

      const chunkNonce = deriveChunkNonce(new Uint8Array(baseNonce), i)
      // AUDIT FIX H3: v2 binds chunk metadata into AAD; v1 (legacy) uses none.
      const _decParams = { name: 'AES-GCM', iv: chunkNonce, tagLength: 128 }
      const _aad = chunkAAD(version, chunkCount, i)
      if (_aad) _decParams.additionalData = _aad
      const decrypted = await crypto.subtle.decrypt(
        _decParams,
        fileKey,
        chunkData
      )

      out.set(new Uint8Array(decrypted), outOff)
      outOff += decrypted.byteLength
      if (onProgress) onProgress(Math.round((i + 1) / chunkCount * 100))
    }

    if (outOff !== totalPlain) {
      throw new Error('internal: decrypted size mismatch')
    }
    return out.buffer
  }

  // ─── Session Key Storage ──────────────────────────────────────────
  // Unlocked keys are kept strictly per-tab in sessionStorage, which the
  // browser clears automatically when the tab closes. They survive in-tab
  // navigations (e.g. login -> /files) but never persist beyond the tab
  // session. The legacy IndexedDB key database (which DID persist beyond a
  // tab session AND held decrypted keys) is deleted on load and on every
  // store/clear — that is KEY_DB_NAME below and must never be reused.
  //
  // AUDIT FIX F2: sessionStorage no longer holds the RAW master key as
  // extractable base64. The raw bytes are AES-GCM wrapped under a
  // NON-EXTRACTABLE key that lives only in a dedicated IndexedDB "keybox"
  // (onegy_keybox — a different database from the purged legacy one), and the
  // sessionStorage entry is ciphertext prefixed with 'v2:'. A storage dump of
  // sessionStorage alone no longer yields the master key, and the wrapping
  // key can never be exported through any WebCrypto API.
  //
  // Tab-scoped lifetime is preserved: the ciphertext dies with the tab
  // (sessionStorage), so the persistent keybox key is useless without it —
  // closing the tab still discards the unlocked state exactly as before.
  // clearSessionKeys() therefore does NOT delete the keybox key: the IDB is
  // origin-wide and shared by other open tabs whose ciphertexts still need it.
  //
  // Auto-unlock flows that must keep working (all verified):
  //   login  -> storeMasterKeyInSession() wraps + stores 'v2:' entry,
  //   /files -> getMasterKeyFromSession() unwraps via keybox (async, cached),
  //   reload -> same unwrapping path (sessionStorage survives same-tab reload),
  //   logout -> clearSessionKeys() drops the per-tab entry -> lock bar shows,
  //   fallback: if IndexedDB is unavailable/broken, store() falls back to the
  //   legacy raw-base64 entry (with a console warning) so auto-unlock NEVER
  //   regresses below today's behavior; get() migrates any such legacy entry
  //   to wrapped form the next time it is read.
  //
  // The in-memory master CryptoKey stays extractable because deriveLinkSecret()
  // (10+ call sites) and hashMasterKey/exportRecoveryKey export its raw bytes
  // for HKDF — making the session key non-extractable would break every
  // share-link derivation. The non-extractable guarantee applies to the keybox
  // wrapping key, where it is feasible. The RSA private key is imported
  // non-extractable.

  const STORAGE_KEY_MASTER = 'onegy_master_key'
  const STORAGE_KEY_PRIVATE = 'onegy_private_key'
  const STORAGE_KEY_FLAG = 'onegy_keys_present'
  const STORAGE_KEY_SCOPE = 'onegy_key_session_id'
  const KEY_DB_NAME = 'onegy_secure_keys'
  // AUDIT FIX F2: dedicated keybox DB (NOT KEY_DB_NAME — that one is purged).
  const KEYBOX_DB_NAME = 'onegy_keybox'
  const KEYBOX_STORE = 'keys'
  const KEYBOX_RECORD = 'master_wrap_key'
  const SESSION_KEY_WRAPPED_PREFIX = 'v2:'
  // In-memory CryptoKey cache for the current page to avoid re-importing on
  // every call. Lost on full page load; sessionStorage repopulates it.
  let _sessionMasterKey = null
  let _sessionPrivateKey = null
  // Bumped by clearSessionKeys(): an async store/load that started before a
  // clear (e.g. logout) must not repopulate or persist keys after it.
  let _sessionKeyGen = 0
  let _keyboxOpenPromise = null

  function _setKeyPresence(present) {
    try {
      if (present) sessionStorage.setItem(STORAGE_KEY_FLAG, '1')
      else sessionStorage.removeItem(STORAGE_KEY_FLAG)
    } catch (e) {}
    if (!present) {
      _sessionMasterKey = null
      _sessionPrivateKey = null
    }
  }

  // Delete the legacy IndexedDB key database entirely. Older builds stored
  // decrypted keys there, and IndexedDB is NOT cleared when a tab closes, so
  // those records could outlive the tab session. This removes them.
  async function _purgeLegacyKeyDb() {
    if (typeof indexedDB === 'undefined' || !indexedDB.deleteDatabase) return
    try {
      await new Promise((resolve) => {
        let settled = false
        const done = () => { if (!settled) { settled = true; resolve() } }
        const req = indexedDB.deleteDatabase(KEY_DB_NAME)
        req.onsuccess = done
        req.onerror = done
        req.onblocked = done
        // Safety timeout so a blocked delete never hangs the caller.
        setTimeout(done, 2000)
      })
    } catch (e) {}
  }

  // ─── AUDIT FIX F2: keybox (non-extractable wrapping key in IndexedDB) ──
  function _keyboxSupported() {
    return typeof indexedDB !== 'undefined' && !!indexedDB && typeof indexedDB.open === 'function'
  }

  function _openKeybox() {
    if (!_keyboxSupported()) return Promise.resolve(null)
    if (!_keyboxOpenPromise) {
      _keyboxOpenPromise = new Promise((resolve) => {
        let req
        try { req = indexedDB.open(KEYBOX_DB_NAME, 1) } catch (e) { resolve(null); return }
        let settled = false
        const done = (v) => { if (!settled) { settled = true; resolve(v) } }
        req.onupgradeneeded = () => {
          try {
            const db = req.result
            if (db && db.objectStoreNames && !db.objectStoreNames.contains(KEYBOX_STORE)) {
              db.createObjectStore(KEYBOX_STORE)
            }
          } catch (e) { /* surfaced via onerror */ }
        }
        req.onsuccess = () => done(req.result)
        req.onerror = () => done(null)
        req.onblocked = () => done(null)
        // Never hang a login/reload on a stuck open.
        setTimeout(() => done(null), 3000)
      }).then((db) => {
        if (!db) _keyboxOpenPromise = null // allow a later retry to reopen
        return db
      })
    }
    return _keyboxOpenPromise
  }

  function _isUsableKeyboxKey(v) {
    return !!(v && typeof v === 'object' && v.type === 'secret' &&
      v.algorithm && typeof v.algorithm.name === 'string' && Array.isArray(v.usages))
  }

  // Fetch (or create) the non-extractable AES-GCM wrapping key. Returns null
  // when IndexedDB is unavailable so callers can fall back gracefully.
  async function _keyboxGetOrCreateKey(db) {
    // WebCrypto is asynchronous. Generate the candidate BEFORE opening an IDB
    // transaction: awaiting generateKey inside get.onsuccess lets the transaction
    // auto-commit, so store.put throws TransactionInactiveError and login stalls.
    let candidate
    try {
      candidate = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      )
    } catch (e) { return null }
    return new Promise((resolve) => {
      let tx, key = null, settled = false
      const timeout = setTimeout(() => {
        try { if (tx) tx.abort() } catch (_) {}
        done(null)
      }, 5000)
      const done = (value) => {
        if (!settled) { settled = true; clearTimeout(timeout); resolve(value) }
      }
      try {
        tx = db.transaction(KEYBOX_STORE, 'readwrite')
        const store = tx.objectStore(KEYBOX_STORE)
        const getReq = store.get(KEYBOX_RECORD)
        tx.oncomplete = () => done(key)
        tx.onerror = () => done(null)
        tx.onabort = () => done(null)
        getReq.onsuccess = () => {
          try {
            const existing = getReq.result
            key = _isUsableKeyboxKey(existing) ? existing : candidate
            if (!_isUsableKeyboxKey(existing)) store.put(candidate, KEYBOX_RECORD)
          } catch (e) {
            try { tx.abort() } catch (_) { done(null) }
          }
        }
        getReq.onerror = () => done(null)
      } catch (e) { done(null) }
    })
  }

  // Wrap raw key bytes for sessionStorage. Returns 'v2:'+base64(iv||ct) or
  // null when the keybox cannot be used (caller decides on fallback).
  async function _keyboxWrap(rawBytes) {
    try {
      const db = await _openKeybox()
      if (!db) return null
      const wrapKey = await _keyboxGetOrCreateKey(db)
      if (!wrapKey) return null
      const iv = randomNonce()
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, wrapKey, rawBytes)
      const out = new Uint8Array(iv.length + ct.byteLength)
      out.set(iv, 0)
      out.set(new Uint8Array(ct), iv.length)
      return SESSION_KEY_WRAPPED_PREFIX + toBase64(out)
    } catch (e) {
      console.warn('[CRYPTO] Keybox wrap unavailable, falling back to legacy storage:', e)
      return null
    }
  }

  // Unwrap a 'v2:' sessionStorage entry. Returns raw bytes or null.
  async function _keyboxUnwrap(value) {
    try {
      const payload = fromBase64(value.slice(SESSION_KEY_WRAPPED_PREFIX.length))
      if (payload.length <= NONCE_SIZE) return null
      const db = await _openKeybox()
      if (!db) return null
      const getReq = await new Promise((resolve) => {
        let tx
        try { tx = db.transaction(KEYBOX_STORE, 'readonly') } catch (e) { resolve(null); return }
        const r = tx.objectStore(KEYBOX_STORE).get(KEYBOX_RECORD)
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => resolve(null)
      })
      if (!_isUsableKeyboxKey(getReq)) return null
      const raw = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: payload.slice(0, NONCE_SIZE) },
        getReq,
        payload.slice(NONCE_SIZE)
      )
      const bytes = new Uint8Array(raw)
      return bytes.length === KEY_SIZE ? bytes : null
    } catch (e) {
      // Wrong/missing keybox key or corrupted ciphertext.
      return null
    }
  }

  async function _validateSessionMasterKey(masterKey) {
    if (!masterKey) return null

    try {
      await crypto.subtle.exportKey('raw', masterKey)
      return masterKey
    } catch (e) {
      console.warn('[CRYPTO] Session master key is stale or non-exportable, clearing cached keys:', e)
      clearSessionKeys()
      return null
    }
  }

  async function storeMasterKeyInSession(masterKey) {
    const gen = _sessionKeyGen
    const raw = await crypto.subtle.exportKey('raw', masterKey)
    let storageError = null
    // AUDIT FIX F2: persist WRAPPED ciphertext when the keybox is available;
    // only fall back to legacy raw base64 (with a loud warning) when
    // IndexedDB is unavailable — auto-unlock must never regress below the
    // old behavior.
    let value = await _keyboxWrap(raw)
    if (!value) {
      console.warn('[CRYPTO] Keybox unavailable — storing the master key in legacy raw form; ' +
        'a sessionStorage dump would expose it until IndexedDB works again.')
      value = toBase64(raw)
    }
    if (gen !== _sessionKeyGen) {
      try { new Uint8Array(raw).fill(0) } catch (e) {}
      return
    }
    try {
      sessionStorage.setItem(STORAGE_KEY_MASTER, value)
    } catch (e) {
      console.error('[CRYPTO] Failed to persist master key to sessionStorage:', e)
      storageError = e
    }
    // exportKey returns an ArrayBuffer — wrap to zero the backing bytes.
    try { new Uint8Array(raw).fill(0) } catch (e) {}
    _sessionMasterKey = masterKey
    _setKeyPresence(true)
    _purgeLegacyKeyDb()
    if (storageError) throw storageError
  }

  async function getMasterKeyFromSession() {
    if (_sessionMasterKey) return _validateSessionMasterKey(_sessionMasterKey)
    const gen = _sessionKeyGen

    let b64 = null
    try { b64 = sessionStorage.getItem(STORAGE_KEY_MASTER) } catch (e) {}
    if (!b64) return null

    let raw = null
    if (b64.indexOf(SESSION_KEY_WRAPPED_PREFIX) === 0) {
      raw = await _keyboxUnwrap(b64)
      if (!raw) {
        // Unreadable entry (keybox lost/corrupt): drop it so the lock bar
        // appears instead of a phantom hasSessionKeys() with no usable key.
        console.warn('[CRYPTO] Session master key entry unreadable — clearing so the unlock prompt can appear')
        clearSessionKeys()
        return null
      }
    } else {
      // Legacy raw-base64 entry (pre-keybox session or keybox-less fallback).
      try {
        raw = fromBase64(b64)
      } catch (e) { raw = null }
      if (!raw || raw.length !== KEY_SIZE) {
        console.error('[CRYPTO] Corrupt legacy master key entry in sessionStorage')
        clearSessionKeys()
        return null
      }
      // Opportunistic migration: rewrite the entry in wrapped form so the raw
      // base64 stops living in sessionStorage. Failure keeps the legacy entry
      // (never worse than before).
      const migrated = await _keyboxWrap(raw)
      if (migrated && gen === _sessionKeyGen) {
        try { sessionStorage.setItem(STORAGE_KEY_MASTER, migrated) } catch (e) {}
      }
    }
    try {
      const imported = await crypto.subtle.importKey(
        'raw', raw, { name: 'AES-GCM', length: 256 }, true,
        ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
      )
      raw.fill(0)
      if (gen !== _sessionKeyGen) return null
      _sessionMasterKey = imported
      _setKeyPresence(true)
      return _validateSessionMasterKey(imported)
    } catch (e) {
      console.error('[CRYPTO] Failed to load master key from session:', e)
      return null
    }
  }

  async function storePrivateKeyInSession(privateKey) {
    _sessionPrivateKey = privateKey
    _setKeyPresence(true)
    _purgeLegacyKeyDb()
    try { sessionStorage.removeItem(STORAGE_KEY_PRIVATE) } catch (e) {}
  }

  async function getPrivateKeyFromSession() {
    if (_sessionPrivateKey) return _sessionPrivateKey
    const gen = _sessionKeyGen
    try { sessionStorage.removeItem(STORAGE_KEY_PRIVATE) } catch (e) {}
    const masterKey = await getMasterKeyFromSession()
    if (!masterKey) return null
    try {
      const resp = await fetch('/api/keys', { credentials: 'same-origin' })
      if (!resp.ok) return null
      const data = await resp.json()
      if (!data.encrypted_private_key || !data.private_key_nonce) return null
      const imported = await unwrapPrivateKey(data.encrypted_private_key, data.private_key_nonce, masterKey)
      if (gen !== _sessionKeyGen) return null
      _sessionPrivateKey = imported
      _setKeyPresence(true)
      return imported
    } catch (e) {
      console.error('[CRYPTO] Failed to rehydrate private key:', e)
      return null
    }
  }

  function clearSessionKeys() {
    _sessionKeyGen++
    _sessionMasterKey = null
    _sessionPrivateKey = null
    try {
      sessionStorage.removeItem(STORAGE_KEY_MASTER)
      sessionStorage.removeItem(STORAGE_KEY_PRIVATE)
      sessionStorage.removeItem(STORAGE_KEY_SCOPE)
      sessionStorage.removeItem(STORAGE_KEY_FLAG)
    } catch (e) {}
    _purgeLegacyKeyDb()
  }

  function hasSessionKeys() {
    if (_sessionMasterKey) return true
    try {
      return sessionStorage.getItem(STORAGE_KEY_FLAG) === '1' || sessionStorage.getItem(STORAGE_KEY_MASTER) !== null
    } catch (e) {
      return false
    }
  }

  // Purge the legacy IndexedDB key store on load so old persistent records
  // never outlive the tab session.
  _purgeLegacyKeyDb()

  // ONE.GY Desktop: its preload exposes window.onegyDesktop.unlock(), which
  // hands this tab the device's master key so the lock bar never appears.
  // Pages decide locked/unlocked synchronously via hasSessionKeys() at
  // startup, so once the key is stored the page reloads once and starts
  // unlocked. Browsers without the bridge return immediately.
  async function _desktopAutoUnlock() {
    const bridge = typeof window !== 'undefined' ? window.onegyDesktop : null
    if (!bridge || typeof bridge.unlock !== 'function' || hasSessionKeys()) return
    const gen = _sessionKeyGen
    try {
      const buf = await bridge.unlock()
      if (Object.prototype.toString.call(buf) !== '[object ArrayBuffer]' || buf.byteLength !== KEY_SIZE) return
      const raw = new Uint8Array(buf)
      const masterKey = await crypto.subtle.importKey(
        'raw', raw, { name: 'AES-GCM', length: 256 }, true,
        ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
      )
      raw.fill(0)
      if (gen !== _sessionKeyGen || hasSessionKeys()) return
      await storeMasterKeyInSession(masterKey)
      if (gen === _sessionKeyGen && hasSessionKeys()) location.reload()
    } catch (e) {
      console.warn('[CRYPTO] Desktop auto-unlock failed:', e)
    }
  }
  _desktopAutoUnlock()

  // ─── Full Key Setup (Registration) ───────────────────────────────

  /**
   * Generate complete E2EE key set for a new user.
   * Called during registration.
   *
   * @param {string} password - user's password
   * @returns {object} all encrypted keys for server storage + raw master key for session
   */
  async function setupUserKeys(password) {
    // 1. Split-key derivation: password → PBKDF2(600K) → HKDF → auth_token + wrapping_key
    const splitKeys = await deriveAuthAndWrappingKeys(password)

    // 2. Generate random master key
    const masterKey = await generateMasterKey()

    // 3. Wrap master key with the wrapping key (NOT the password)
    const masterKeyWrapped = await wrapMasterKey(masterKey, splitKeys.wrappingKey, splitKeys.salt)

    // 4. Generate RSA-OAEP 4096-bit keypair
    const rsaKeyPair = await generateRSAKeyPair()

    // 5. Export public key as JWK
    const publicKeyJwk = await exportPublicKey(rsaKeyPair.publicKey)

    // 6. Wrap private key with master key
    const privateKeyWrapped = await wrapPrivateKey(rsaKeyPair.privateKey, masterKey)

    // 7. AUDIT FIX M3: independent recovery key wrapping the master key
    //    (rotatable at recovery without re-encrypting any data)
    const recovery = await createRecoveryKeyWrap(masterKey)

    return {
      // For server storage (auth)
      authToken: splitKeys.authToken,
      authSalt: splitKeys.salt,
      // For server storage (encrypted keys)
      encryptedMasterKey: masterKeyWrapped.encryptedMasterKey,
      masterKeyNonce: masterKeyWrapped.nonce,
      masterKeySalt: masterKeyWrapped.salt,
      publicKey: publicKeyJwk,
      encryptedPrivateKey: privateKeyWrapped.encryptedPrivateKey,
      privateKeyNonce: privateKeyWrapped.nonce,
      recoveryKeyHash: recovery.recoveryKeyHash,
      recoveryWrappedMasterKey: recovery.recoveryWrappedMasterKey,
      recoveryKeyNonce: recovery.recoveryKeyNonce,
      // For client session (not sent to server in this form)
      _masterKey: masterKey,
      _privateKey: rsaKeyPair.privateKey,
      // AUDIT FIX M3: the recovery key to SHOW THE USER (display this, not the
      // master key — only this key recovers the account, and it is rotatable)
      recoveryKey: recovery.recoveryKey
    }
  }

  /**
   * Unlock user's keys on login.
   * Fetches encrypted keys from server, decrypts with password.
   *
   * @param {string} password
   * @param {object} serverKeys - { encryptedMasterKey, masterKeyNonce, masterKeySalt, encryptedPrivateKey, privateKeyNonce }
   * @returns {object} { masterKey: CryptoKey, privateKey: CryptoKey }
   */
  async function unlockUserKeys(wrappingKeyOrPassword, serverKeys) {
    // 1. Unwrap master key (accepts CryptoKey from split-key or string password for legacy)
    const masterKey = await unwrapMasterKey(
      serverKeys.encryptedMasterKey,
      serverKeys.masterKeyNonce,
      serverKeys.masterKeySalt,
      wrappingKeyOrPassword
    )

    // 2. Unwrap private key with master key
    const privateKey = await unwrapPrivateKey(
      serverKeys.encryptedPrivateKey,
      serverKeys.privateKeyNonce,
      masterKey
    )

    return { masterKey, privateKey }
  }

  // ─── Convenience: Encrypt File for Upload ─────────────────────────

  /**
   * Full E2EE upload flow for a registered user:
   *  1. Generate random file key
   *  2. Encrypt file data with file key (chunked AES-GCM)
   *  3. Wrap file key with master key
   *  4. Return encrypted blob + wrapped key metadata
   *
   * @param {ArrayBuffer} fileData - raw file content
   * @param {CryptoKey} masterKey - user's decrypted master key
   * @param {function} onProgress - optional progress callback
   * @returns {object} { encryptedBlob, encryptedFileKey, fileKeyNonce }
   */
  async function encryptFileForUpload(fileData, masterKey, onProgress) {
    const fileKey = await generateFileKey()
    const encryptedData = await encryptFileData(fileData, fileKey, onProgress)
    const wrappedKey = await wrapFileKeyWithMasterKey(fileKey, masterKey)
    return {
      encryptedBlob: new Blob([encryptedData], { type: 'application/octet-stream' }),
      encryptedFileKey: wrappedKey.encryptedFileKey,
      fileKeyNonce: wrappedKey.nonce
    }
  }

  /**
   * Full E2EE upload flow for a guest (passphrase-based):
   *  1. Generate random file key
   *  2. Encrypt file data with file key (chunked AES-GCM)
   *  3. Wrap file key with passphrase-derived key
   *  4. Return encrypted blob + wrapped key metadata
   */
  async function encryptFileForGuestUpload(fileData, passphrase, onProgress) {
    const fileKey = await generateFileKey()
    const encryptedData = await encryptFileData(fileData, fileKey, onProgress)
    const wrappedKey = await wrapFileKeyWithPassphrase(fileKey, passphrase)
    return {
      encryptedBlob: new Blob([encryptedData], { type: 'application/octet-stream' }),
      encryptedFileKey: wrappedKey.encryptedFileKey,
      fileKeyNonce: wrappedKey.nonce,
      fileKeySalt: wrappedKey.salt,
      fileKey: fileKey
    }
  }

  /**
   * Full E2EE download flow for a registered user:
   *  1. Fetch encrypted file data + wrapped key from server
   *  2. Unwrap file key with master key
   *  3. Decrypt file data
   */
  async function decryptFileForDownload(encryptedData, encryptedFileKey, fileKeyNonce, masterKey, onProgress) {
    const fileKey = await unwrapFileKeyWithMasterKey(encryptedFileKey, fileKeyNonce, masterKey)
    return decryptFileData(encryptedData, fileKey, onProgress)
  }

  /**
   * Full E2EE download flow for a guest:
   */
  async function decryptFileForGuestDownload(encryptedData, encryptedFileKey, fileKeyNonce, fileKeySalt, passphrase, onProgress) {
    const fileKey = await unwrapFileKeyWithPassphrase(encryptedFileKey, fileKeyNonce, fileKeySalt, passphrase)
    return decryptFileData(encryptedData, fileKey, onProgress)
  }

  /**
   * Decrypt file using a share link secret.
   */
  async function decryptFileFromLink(encryptedData, encryptedFileKey, fileKeyNonce, linkSecret, onProgress) {
    const fileKey = await unwrapFileKeyFromLink(encryptedFileKey, fileKeyNonce, linkSecret)
    return decryptFileData(encryptedData, fileKey, onProgress)
  }

  // ─── Folder Name Key Generation & Wrapping ───────────────────────

  /**
   * Generate a random AES-256-GCM key for encrypting a folder name.
   * Same format as a file key but used exclusively for folder name encryption.
   */
  async function generateFolderNameKey() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,  // extractable — needed for wrapping
      ['encrypt', 'decrypt']
    )
  }

  /**
   * Wrap a folder name key with the user's master key (for owner access).
   * Returns { encryptedNameKey: base64, nonce: base64 }
   */
  async function wrapFolderNameKey(nameKey, masterKey) {
    const nonce = randomNonce()
    const wrapped = await crypto.subtle.wrapKey('raw', nameKey, masterKey, {
      name: 'AES-GCM', iv: nonce
    })
    return {
      encryptedNameKey: toBase64(wrapped),
      nonce: toBase64(nonce)
    }
  }

  /**
   * Unwrap a folder name key with the user's master key.
   */
  async function unwrapFolderNameKey(encryptedNameKey, nonce, masterKey) {
    return crypto.subtle.unwrapKey(
      'raw',
      fromBase64(encryptedNameKey),
      masterKey,
      { name: 'AES-GCM', iv: fromBase64(nonce) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  }

  /**
   * Wrap a folder name key with a link key (for share link visitors).
   * Returns { encryptedNameKey: base64, nonce: base64 }
   */
  async function wrapFolderNameKeyForLink(nameKey, linkKey) {
    const nonce = randomNonce()
    const wrapped = await crypto.subtle.wrapKey('raw', nameKey, linkKey, {
      name: 'AES-GCM', iv: nonce
    })
    return {
      encryptedNameKey: toBase64(wrapped),
      nonce: toBase64(nonce)
    }
  }

  /**
   * Unwrap a folder name key from a link secret (for share link visitors).
   */
  async function unwrapFolderNameKeyFromLink(encryptedNameKey, nonce, linkSecretBase64) {
    const linkSecretBytes = fromBase64(linkSecretBase64)
    const linkKey = await crypto.subtle.importKey(
      'raw', linkSecretBytes, { name: 'AES-GCM', length: 256 }, false,
      ['wrapKey', 'unwrapKey']
    )
    return crypto.subtle.unwrapKey(
      'raw',
      fromBase64(encryptedNameKey),
      linkKey,
      { name: 'AES-GCM', iv: fromBase64(nonce) },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  }

  /**
   * Encrypt a folder name with a folder name key.
   * Returns { encryptedName: base64, nameNonce: base64 }
   */
  async function encryptFolderName(name, nameKey) {
    const nonce = randomNonce()
    const encoded = new TextEncoder().encode(name)
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      nameKey,
      encoded
    )
    return {
      encryptedName: toBase64(new Uint8Array(encrypted)),
      nameNonce: toBase64(nonce)
    }
  }

  /**
   * Decrypt a folder name with a folder name key.
   * Returns the plaintext folder name string.
   */
  async function decryptFolderName(encryptedNameB64, nameNonceB64, nameKey) {
    const nonce = fromBase64(nameNonceB64)
    const ciphertext = fromBase64(encryptedNameB64)
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      nameKey,
      ciphertext
    )
    // ignoreBOM: a leading U+FEFF is part of the name (encryption keeps it, Go keeps it).
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(decrypted)
  }

  // ─── Filename Encryption (simple, non-chunked) ───────────────────

  /**
   * Encrypt a filename with a file key.
   * Uses a single AES-GCM operation (filenames are tiny, < 255 bytes).
   * Returns { encryptedName: base64, nameNonce: base64 }
   */
  async function encryptFileName(name, fileKey) {
    const nonce = randomNonce()
    const encoded = new TextEncoder().encode(name)
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      fileKey,
      encoded
    )
    return {
      encryptedName: toBase64(new Uint8Array(encrypted)),
      nameNonce: toBase64(nonce)
    }
  }

  /**
   * Decrypt a filename with a file key.
   * Returns the plaintext filename string.
   */
  async function decryptFileName(encryptedNameB64, nameNonceB64, fileKey) {
    const nonce = fromBase64(nameNonceB64)
    const ciphertext = fromBase64(encryptedNameB64)
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      fileKey,
      ciphertext
    )
    // ignoreBOM: a leading U+FEFF is part of the name (encryption keeps it, Go keeps it).
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(decrypted)
  }

  /**
   * Extract the plaintext extension sent alongside an encrypted filename.
   * Only a short lowercase alphanumeric suffix is returned (e.g. ".pdf");
   * anything else would leak part of the name, so it yields ''.
   */
  function extractExtension(filename) {
    const dot = filename.lastIndexOf('.')
    if (dot <= 0) return ''
    const ext = filename.slice(dot + 1).toLowerCase()
    return /^[a-z0-9]{1,10}$/.test(ext) ? '.' + ext : ''
  }

  // ─── Syntax highlighting (loaded on demand) ──────────────────────

  // highlight.js is vendored but no page loads it up front: text thumbnails
  // (every upload path goes through generateThumbnail in thumbnail-gen.js) and the text editor in
  // preview.js pull it in here. Languages missing from the vendored build
  // (dos, powershell) fall back to plain text.
  const HLJS_LANG_BY_EXT = {
    py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', xml: 'xml', html: 'xml', htm: 'xml',
    css: 'css', scss: 'scss', less: 'less', yaml: 'yaml', yml: 'yaml',
    sh: 'bash', bash: 'bash', zsh: 'bash', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    lua: 'lua', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    kt: 'kotlin', swift: 'swift', php: 'php', pl: 'perl', r: 'r',
    sql: 'sql', md: 'markdown', diff: 'diff', patch: 'diff', makefile: 'makefile',
    toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
    bat: 'dos', ps1: 'powershell'
  }

  function highlightLanguage (ext) {
    return HLJS_LANG_BY_EXT[String(ext || '').toLowerCase()] || null
  }

  let _hljsReady = null
  function _addScript (src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.onload = resolve
      s.onerror = reject
      document.head.appendChild(s)
    })
  }

  /** Resolves to window.hljs, or null when it cannot be loaded. */
  function loadHighlighter () {
    if (typeof hljs !== 'undefined') return Promise.resolve(hljs)
    if (!_hljsReady) {
      const base = '/static/vendor/highlight/'
      _hljsReady = _addScript(base + 'highlight.min.js')
        .then(() => _addScript(base + 'hljs-enhance.js').catch(() => {}))
        .then(() => (typeof hljs !== 'undefined' ? hljs : null), () => { _hljsReady = null; return null })
    }
    return _hljsReady
  }

  // ─── Thumbnail Encryption (simple, non-chunked) ──────────────────

  /**
   * Encrypt a small blob (thumbnail) with a file key.
   * Uses a single AES-GCM operation (thumbnails are small, < 100KB).
   * Returns { data: ArrayBuffer, nonce: base64 }
   */
  async function encryptThumbnail(data, fileKey) {
    const nonce = randomNonce()
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      fileKey,
      data
    )
    return {
      data: encrypted,
      nonce: toBase64(nonce)
    }
  }

  /**
   * Decrypt a small blob (thumbnail) with a file key.
   */
  async function decryptThumbnail(encryptedData, nonceB64, fileKey) {
    const nonce = fromBase64(nonceB64)
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      fileKey,
      encryptedData
    )
  }

  // ─── Public API ───────────────────────────────────────────────────

  return {
    // Work in the crypto worker right now (core.js holds a UI update reload).
    busy: () => _workerCallbacks.size > 0,

    // Utilities
    toBase64,
    fromBase64,
    randomBytes,

    // Key derivation
    deriveWrappingKey,
    deriveAuthAndWrappingKeys,

    // Master key
    generateMasterKey,
    wrapMasterKey,
    unwrapMasterKey,
    rewrapMasterKey,
    exportRecoveryKey,
    importRecoveryKey,
    hashMasterKey,
    createRecoveryKeyWrap,
    unwrapMasterKeyWithRecoveryKey,

    // RSA keypair
    generateRSAKeyPair,
    exportPublicKey,
    importPublicKey,
    publicKeyFingerprint,
    wrapPrivateKey,
    unwrapPrivateKey,

    // File keys
    generateFileKey,
    wrapFileKeyWithMasterKey,
    unwrapFileKeyWithMasterKey,
    wrapFileKeyWithPassphrase,
    unwrapFileKeyWithPassphrase,
    wrapFileKeyWithRSA,
    unwrapFileKeyWithRSA,
    deriveLinkSecret,
    wrapFileKeyForLink,
    unwrapFileKeyFromLink,

    // File encryption/decryption
    encryptFileData,
    decryptFileData,

    // Session storage
    storeMasterKeyInSession,
    getMasterKeyFromSession,
    storePrivateKeyInSession,
    getPrivateKeyFromSession,
    clearSessionKeys,
    hasSessionKeys,

    // High-level flows
    setupUserKeys,
    unlockUserKeys,
    encryptFileForUpload,
    encryptFileForGuestUpload,
    decryptFileForDownload,
    decryptFileForGuestDownload,
    decryptFileFromLink,

    // Syntax highlighting
    loadHighlighter,
    highlightLanguage,

    // Thumbnail
    encryptThumbnail,
    decryptThumbnail,
    // generateThumbnail is attached by thumbnail-gen.js

    // Folder name keys
    generateFolderNameKey,
    wrapFolderNameKey,
    unwrapFolderNameKey,
    wrapFolderNameKeyForLink,
    unwrapFolderNameKeyFromLink,
    encryptFolderName,
    decryptFolderName,

    // Filename encryption
    encryptFileName,
    decryptFileName,
    extractExtension,

    // Constants
    PBKDF2_ITERATIONS,
    CHUNK_SIZE,
    FILE_FORMAT_VERSION,
    // AUDIT FIX F1: true when the container decrypt()ed last was legacy v1
    // (no AAD binding — truncation/reorder not authenticated). UI surfaces it.
    wasLastContainerLegacy
  }
})()

// AUDIT FIX: publish the namespace on `window` explicitly.
//
// `const OneGyCrypto = ...` at the top level of a CLASSIC script binds into the
// global lexical environment, which is NOT the same thing as a property of
// `window`. The bare identifier resolves fine, but every `window.OneGyCrypto`
// feature-check in the codebase was silently evaluating to `undefined` and
// taking its fallback path. Two of those were real defects:
//
//   * the logout forms in _app_base.html and the boot guards in
//     login.html call clearSessionKeys() behind that check, so the
//     unwrapped master key and RSA private key were NEVER purged from
//     sessionStorage on logout;
//   * account.js fell back to sending a raw password as its credential
//     proof, which the server correctly rejects for split-key accounts, making
//     2FA enable/disable, sign-out-all and account deletion unusable.
//
// Assigning it here fixes every such call site at once and keeps the bare
// identifier working for the code that already uses it.
window.OneGyCrypto = OneGyCrypto
