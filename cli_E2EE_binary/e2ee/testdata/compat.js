#!/usr/bin/env node
// Cross-checks the Go e2ee package against tests/crypto_helper.js (the Node
// mirror of static/crypto.js). Driven by compat_test.go: reads one JSON vector
// on stdin, writes one JSON result on stdout. Names and metadata are not in the
// helper, so they use the same AES-256-GCM construction as crypto.js directly.
'use strict'

const crypto = require('crypto')
const { execFileSync } = require('child_process')

function helper (path, ...args) {
  return JSON.parse(execFileSync(process.execPath, [path, ...args], { encoding: 'utf8' }))
}

function gcmOpen (key, nonceB64, ctB64) {
  const ct = Buffer.from(ctB64, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonceB64, 'base64'))
  d.setAuthTag(ct.subarray(ct.length - 16))
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
}

function gcmSeal (key, plain) {
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
  return { ct: ct.toString('base64'), nonce: nonce.toString('base64') }
}

// crypto.js:deriveLinkSecret, the same Web Crypto calls.
async function deriveLinkSecret (masterKey, type, id) {
  const subtle = crypto.webcrypto.subtle
  const km = await subtle.importKey('raw', masterKey, 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: Buffer.from('onegy-link-secret-v1'),
    info: Buffer.from(type + ':' + id) }, km, 256)
  return Buffer.from(bits).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const v = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const masterKey = Buffer.from(v.master_key_b64, 'base64')
const go = v.go

// (a) split-key derivation
const split = helper(v.helper, 'derive_split_keys', v.password, v.salt)

// (b) Go container (file key wrapped with the master key) decrypted by the helper
const goPlain = helper(v.helper, 'decrypt', go.container_b64, go.encrypted_file_key,
  go.file_key_nonce, v.master_key_b64).plaintext_b64
const fileKey = gcmOpen(masterKey, go.file_key_nonce, go.encrypted_file_key)
const goName = new TextDecoder('utf-8', { ignoreBOM: true }).decode(gcmOpen(fileKey, go.name_nonce, go.encrypted_name))
const goMeta = JSON.parse(gcmOpen(fileKey, go.meta_nonce, go.encrypted_meta).toString('utf8'))
const nameKey = gcmOpen(masterKey, go.name_key_nonce, go.encrypted_name_key)
const goFolder = new TextDecoder('utf-8', { ignoreBOM: true }).decode(gcmOpen(nameKey, go.folder_name_nonce, go.encrypted_folder_name))

// (c) JS container + name + meta for Go to open
const js = helper(v.helper, 'encrypt_with_key', v.plaintext_b64, v.master_key_b64)
const jsFileKey = Buffer.from(js.file_key_b64, 'base64')
const jsName = gcmSeal(jsFileKey, Buffer.from(v.name, 'utf8'))
const jsMeta = gcmSeal(jsFileKey, Buffer.from(JSON.stringify({
  v: 1, file_id: v.meta.file_id, content_version: v.meta.content_version, plain_size: v.meta.plain_size,
  plain_sha256: v.meta.plain_sha256, mtime_ns: v.meta.mtime_ns, mode: v.meta.mode
}), 'utf8'))

// (d) folder share-link key: same secret, wraps open both ways
deriveLinkSecret(masterKey, 'folder', v.share_token).then((linkSecret) => {
  const linkKey = Buffer.from(linkSecret, 'base64url')
  const goLinkKey = gcmOpen(linkKey, go.folder_link_file_key_nonce, go.folder_link_encrypted_file_key)
  const jsLink = gcmSeal(linkKey, jsFileKey)
  process.stdout.write(JSON.stringify({
    link_secret: linkSecret,
    go_link_file_key_b64: goLinkKey.toString('base64'),
    auth_token: split.auth_token,
    wrapping_key_b64: split.wrapping_key_b64,
    go_plaintext_b64: goPlain,
    go_name: goName,
    go_folder_name: goFolder,
    go_meta: goMeta,
    js: {
      container_b64: js.ciphertext_b64,
      encrypted_file_key: js.encrypted_file_key,
      file_key_nonce: js.file_key_nonce,
      encrypted_name: jsName.ct,
      name_nonce: jsName.nonce,
      encrypted_meta: jsMeta.ct,
      meta_nonce: jsMeta.nonce,
      folder_link_encrypted_file_key: jsLink.ct,
      folder_link_file_key_nonce: jsLink.nonce
    }
  }))
}).catch((e) => { console.error(e); process.exit(1) })
