/**
 * ONE.GY Crypto Web Worker — offloads heavy CPU operations from the main thread.
 *
 * Handles: PBKDF2 key derivation (600K + 210K iterations), file encrypt/decrypt.
 * Uses the same Web Crypto API primitives as crypto.js but runs in a separate thread
 * so the UI stays responsive during long operations.
 *
 * Communication: message-based via postMessage/onmessage.
 * Each request has { id, op, ...params }, response has { id, result } or { id, error }.
 */
'use strict'

const PBKDF2_ITERATIONS_LEGACY = 210000
const PBKDF2_ITERATIONS = 600000
const CHUNK_SIZE = 64 * 1024 * 1024  // 64MB per AES-GCM chunk
const NONCE_SIZE = 12
const KEY_SIZE = 32
const TAG_SIZE = 16
// AUDIT FIX H3: v2 binds chunk metadata into each chunk's GCM AAD. Must stay
// byte-identical with crypto.js / crypto.go / tests/crypto_helper.js. v1 (no
// AAD) still accepted on decrypt for backward compatibility.
const FILE_FORMAT_VERSION = 2
const SUPPORTED_FILE_FORMAT_VERSIONS = [1, 2]

// ─── Utility Functions (duplicated from crypto.js for worker isolation) ───

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function fromBase64(str) {
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

function concatBuffers(...buffers) {
  const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const b of buffers) {
    result.set(new Uint8Array(b), offset)
    offset += b.byteLength
  }
  return result
}

function chunkNonce(baseNonce, chunkIndex) {
  const nonce = new Uint8Array(baseNonce)
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength)
  const last4 = view.getUint32(8)
  view.setUint32(8, last4 ^ chunkIndex)
  return nonce
}

// AUDIT FIX H3: per-chunk AAD binding (version || chunkCount || chunkIndex ||
// isLast). Identical to crypto.js chunkAAD. Returns undefined for v1.
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

// ─── Operations ──────────────────────────────────────────────────────

/**
 * Split-key PBKDF2 derivation (600K iterations + HKDF).
 * Returns { authToken: base64, wrappingKeyRaw: base64, salt: base64 }
 * (wrappingKey exported as raw bytes since CryptoKey can't cross worker boundary)
 */
async function deriveAuthAndWrappingKeys(password, salt) {
  if (!salt) salt = randomBytes(32)
  else if (typeof salt === 'string') salt = fromBase64(salt)
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  )
  const derived512 = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 512
  )
  const hkdfMaterial = await crypto.subtle.importKey(
    'raw', derived512, 'HKDF', false, ['deriveBits', 'deriveKey']
  )
  const authTokenBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('onegy-auth-v1'), info: encoder.encode('auth') },
    hkdfMaterial, 256
  )
  // Export wrapping key as raw bytes (can't send CryptoKey across worker boundary)
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('onegy-wrap-v1'), info: encoder.encode('wrap') },
    hkdfMaterial,
    { name: 'AES-GCM', length: 256 },
    true,  // extractable = true so we can export raw bytes
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  )
  const wrappingKeyRaw = await crypto.subtle.exportKey('raw', wrappingKey)
  return {
    authToken: toBase64(authTokenBits),
    wrappingKeyRaw: toBase64(wrappingKeyRaw),
    salt: toBase64(salt)
  }
}

/**
 * Legacy PBKDF2 derivation (210K iterations) for passphrase-based E2E.
 * Returns { keyRaw: base64, salt: base64 }
 */
async function derivePassphraseKey(passphrase, salt) {
  if (!salt) salt = randomBytes(32)
  else if (typeof salt === 'string') salt = fromBase64(salt)
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  )
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS_LEGACY, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  )
  const keyRaw = await crypto.subtle.exportKey('raw', key)
  return {
    keyRaw: toBase64(keyRaw),
    salt: toBase64(salt)
  }
}

/**
 * Legacy wrapping key derivation (210K iterations) for password-wrapped master key.
 * Returns { keyRaw: base64, salt: base64 }
 */
async function deriveWrappingKey(password, salt) {
  if (!salt) salt = randomBytes(32)
  else if (typeof salt === 'string') salt = fromBase64(salt)
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
  )
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS_LEGACY, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  )
  const keyRaw = await crypto.subtle.exportKey('raw', key)
  return {
    keyRaw: toBase64(keyRaw),
    salt: toBase64(salt)
  }
}

/**
 * AUDIT FIX F4: exact encrypted output size for chunkCount chunks over
 * totalSize plaintext bytes: header + per chunk (4-byte length + data + tag).
 * Preallocated once — replaces the old chunks-array + concatBuffers merge,
 * which held a second full copy of the ciphertext in memory.
 */
function allocEncryptedBuffer(chunkCount, totalSize) {
  const HEADER_SIZE = 1 + 4 + NONCE_SIZE
  let size = HEADER_SIZE
  for (let i = 0; i < chunkCount; i++) {
    const chunkLen = Math.min(CHUNK_SIZE, totalSize - i * CHUNK_SIZE)
    size += 4 + chunkLen + TAG_SIZE
  }
  return new Uint8Array(size)
}

// Encrypt one chunk into `out` at `offset`; returns the next offset.
async function sealChunkInto(out, offset, fileKey, chunk, baseNonce, chunkCount, i) {
  const nonce = chunkNonce(baseNonce, i)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: TAG_SIZE * 8, additionalData: chunkAAD(FILE_FORMAT_VERSION, chunkCount, i) },
    fileKey, chunk
  )
  new DataView(out.buffer, out.byteOffset).setUint32(offset, encrypted.byteLength, false)
  offset += 4
  out.set(new Uint8Array(encrypted), offset)
  return offset + encrypted.byteLength
}

/**
 * Encrypt file data with AES-256-GCM (chunked for large files).
 * Format matches crypto.js main thread exactly:
 *   [1 byte version][4 bytes chunk count BE][12 bytes base nonce]
 *   then per chunk: [4 bytes encrypted chunk length BE][encrypted chunk data (incl. GCM tag)]
 *
 * Input: { data: ArrayBuffer, fileKeyRaw: base64 }
 * Returns: { encrypted: ArrayBuffer }
 */
async function encryptFileData(data, fileKeyRaw, onProgress) {
  const fileKeyBytes = fromBase64(fileKeyRaw)
  const fileKey = await crypto.subtle.importKey(
    'raw', fileKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  )
  const dataBytes = new Uint8Array(data)
  const totalSize = dataBytes.byteLength
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE) || 1
  const baseNonce = randomBytes(NONCE_SIZE)

  // AUDIT FIX F4: single preallocated output buffer, sealed in place.
  const out = allocEncryptedBuffer(chunkCount, totalSize)
  out[0] = FILE_FORMAT_VERSION
  new DataView(out.buffer).setUint32(1, chunkCount, false)
  out.set(baseNonce, 5)

  let offset = 1 + 4 + NONCE_SIZE
  let processedBytes = 0

  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, totalSize)
    const chunk = dataBytes.subarray(start, end) // view, not a copy
    offset = await sealChunkInto(out, offset, fileKey, chunk, baseNonce, chunkCount, i)

    processedBytes += (end - start)
    if (onProgress) onProgress(Math.round(processedBytes / totalSize * 100))
  }

  if (offset !== out.length) throw new Error('internal: encrypted container size mismatch')
  return { encrypted: out.buffer }
}

/**
 * AUDIT FIX F4: streaming encrypt for Blob/File input. The Blob reaches the
 * worker as a cheap structured-clone handle (no byte copy) and is read one
 * CHUNK_SIZE slice at a time, so the full plaintext never exists anywhere.
 * Framing is byte-identical to encryptFileData() (same header, same nonce
 * derivation, same v2 AAD), so Go CLI / crypto_helper.js interop is unchanged.
 * Returns: { encrypted: ArrayBuffer }
 */
async function encryptFileBlob(blob, fileKeyRaw, onProgress) {
  const fileKeyBytes = fromBase64(fileKeyRaw)
  const fileKey = await crypto.subtle.importKey(
    'raw', fileKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  )
  const totalSize = blob.size
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE) || 1
  const baseNonce = randomBytes(NONCE_SIZE)

  const out = allocEncryptedBuffer(chunkCount, totalSize)
  out[0] = FILE_FORMAT_VERSION
  new DataView(out.buffer).setUint32(1, chunkCount, false)
  out.set(baseNonce, 5)

  let offset = 1 + 4 + NONCE_SIZE
  let processedBytes = 0

  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, totalSize)
    const chunk = new Uint8Array(await blob.slice(start, end).arrayBuffer())
    offset = await sealChunkInto(out, offset, fileKey, chunk, baseNonce, chunkCount, i)

    processedBytes += (end - start)
    if (onProgress) onProgress(Math.round(processedBytes / totalSize * 100))
  }

  if (offset !== out.length) throw new Error('internal: encrypted container size mismatch')
  return { encrypted: out.buffer }
}

/**
 * Decrypt file data with AES-256-GCM (chunked for large files).
 * Format matches crypto.js main thread exactly:
 *   [1 byte version][4 bytes chunk count BE][12 bytes base nonce]
 *   then per chunk: [4 bytes encrypted chunk length BE][encrypted chunk data (incl. GCM tag)]
 *
 * Input: { data: ArrayBuffer, fileKeyRaw: base64 }
 * Returns: { decrypted: ArrayBuffer }
 */
async function decryptFileData(data, fileKeyRaw, onProgress) {
  const fileKeyBytes = fromBase64(fileKeyRaw)
  const fileKey = await crypto.subtle.importKey(
    'raw', fileKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']
  )
  const dataBytes = new Uint8Array(data)
  const view = new DataView(data)

  // Read header: [version(1)][chunkCount(4 BE)][baseNonce(12)]
  const HEADER_SIZE = 1 + 4 + NONCE_SIZE
  const version = dataBytes[0]
  if (SUPPORTED_FILE_FORMAT_VERSIONS.indexOf(version) === -1) {
    throw new Error('Unsupported encrypted file format version: ' + version)
  }
  const chunkCount = view.getUint32(1, false)
  if (chunkCount < 1) {
    throw new Error('invalid encrypted container: header declares 0 chunks')
  }
  const baseNonce = dataBytes.slice(5, 5 + NONCE_SIZE)

  // AUDIT FIX F4 + F1: validate all length prefixes and total the plaintext
  // size first (no per-length storage), allocate the plaintext exactly once,
  // then decrypt in place — replaces decrypted-chunks array + concatBuffers
  // (a second full copy of the plaintext). Mirrors crypto.js byte-for-byte,
  // including the chunkCount-vs-container bound that also rejects absurd
  // tampered headers before any allocation.
  const MIN_CHUNK_WIRE = 4 + TAG_SIZE
  if (chunkCount > Math.floor((dataBytes.length - HEADER_SIZE) / MIN_CHUNK_WIRE)) {
    throw new Error('invalid encrypted container: chunk count exceeds container size')
  }
  let offset = HEADER_SIZE
  let totalPlain = 0
  for (let i = 0; i < chunkCount; i++) {
    if (offset + 4 > dataBytes.length) {
      throw new Error('unexpected end of data at chunk ' + i + ' (reading length)')
    }
    const chunkLen = view.getUint32(offset, false)
    offset += 4
    if (chunkLen < TAG_SIZE || chunkLen > CHUNK_SIZE + TAG_SIZE) {
      throw new Error('invalid encrypted chunk length at chunk ' + i + ': ' + chunkLen)
    }
    if (offset + chunkLen > dataBytes.length) {
      throw new Error('unexpected end of data at chunk ' + i)
    }
    offset += chunkLen
    totalPlain += chunkLen - TAG_SIZE
  }
  if (offset !== dataBytes.length) {
    throw new Error('encrypted container has ' + (dataBytes.length - offset) + ' trailing byte(s)')
  }

  const out = new Uint8Array(totalPlain)
  offset = HEADER_SIZE
  let outOff = 0

  for (let i = 0; i < chunkCount; i++) {
    offset += 4 // length prefix — validated above
    const chunkLen = view.getUint32(offset - 4, false)
    const chunkData = dataBytes.subarray(offset, offset + chunkLen)
    offset += chunkLen

    const nonce = chunkNonce(baseNonce, i)
    // AUDIT FIX H3: v2 binds chunk metadata into AAD; v1 (legacy) uses none.
    const _decParams = { name: 'AES-GCM', iv: nonce, tagLength: TAG_SIZE * 8 }
    const _aad = chunkAAD(version, chunkCount, i)
    if (_aad) _decParams.additionalData = _aad
    const decrypted = await crypto.subtle.decrypt(
      _decParams,
      fileKey, chunkData
    )

    out.set(new Uint8Array(decrypted), outOff)
    outOff += decrypted.byteLength
    if (onProgress) onProgress(Math.round((i + 1) / chunkCount * 100))
  }

  if (outOff !== totalPlain) {
    throw new Error('internal: decrypted size mismatch')
  }
  return { decrypted: out.buffer }
}

// ─── Message Handler ─────────────────────────────────────────────────

self.onmessage = async function(e) {
  const { id, op } = e.data
  try {
    let result
    switch (op) {
      case 'deriveAuthAndWrappingKeys':
        result = await deriveAuthAndWrappingKeys(e.data.password, e.data.salt)
        break
      case 'derivePassphraseKey':
        result = await derivePassphraseKey(e.data.passphrase, e.data.salt)
        break
      case 'deriveWrappingKey':
        result = await deriveWrappingKey(e.data.password, e.data.salt)
        break
      case 'encryptFileData':
        result = await encryptFileData(e.data.data, e.data.fileKeyRaw, function(p) {
          self.postMessage({ type: 'progress', id: e.data.id, progress: p })
        })
        // Transfer the ArrayBuffer to avoid copying
        self.postMessage({ id, result }, [result.encrypted])
        return
      case 'encryptFileBlob':
        // AUDIT FIX F4: stream a Blob/File in CHUNK_SIZE slices — the full
        // plaintext never materializes; framing identical to the buffer path.
        result = await encryptFileBlob(e.data.blob, e.data.fileKeyRaw, function(p) {
          self.postMessage({ type: 'progress', id: e.data.id, progress: p })
        })
        self.postMessage({ id, result }, [result.encrypted])
        return
      case 'decryptFileData':
        result = await decryptFileData(e.data.data, e.data.fileKeyRaw, function(p) {
          self.postMessage({ type: 'progress', id: e.data.id, progress: p })
        })
        self.postMessage({ id, result }, [result.decrypted])
        return
      default:
        throw new Error('Unknown worker op: ' + op)
    }
    self.postMessage({ id, result })
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) })
  }
}
