/* ============================================================================
   account.js — Account page behavior. Theme buttons are wired by
   theme-switch.js via [data-set-theme].

   AUDIT FIXES H5 / H6 / H7:
     * 2FA setup/confirm/disable now send the credential proof the server
       requires (previously disable posted an EMPTY body and could never work).
     * Delete account now sends JSON with password/auth_token + captcha — it
       used to post FormData, which request.get_json() rejects with a 415 under
       Flask 3, so "delete my account" silently failed for every user.
     * A real password-change flow exists: full split-key re-derivation +
       master-key re-wrap using the SAME crypto.js primitives login.html uses
       (deriveAuthAndWrappingKeys / wrapMasterKey). No new crypto path.
   ========================================================================== */
;(function () {
  'use strict'
  function csrf () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.content : '' }
  function jpost (url, body, method) {
    return fetch(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrf() }, body: body ? JSON.stringify(body) : undefined })
  }
  async function parse (r, valid) {
    var contentType = r.headers.get('content-type') || ''
    if (contentType.indexOf('application/json') === -1) throw new Error(r.ok ? 'INVALID SERVER RESPONSE' : 'REQUEST FAILED')
    var data
    try { data = await r.json() } catch (e) { throw new Error('INVALID SERVER RESPONSE') }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('INVALID SERVER RESPONSE')
    if (!r.ok) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'REQUEST FAILED')
    if (valid && !valid(data)) throw new Error('INVALID SERVER RESPONSE')
    return data
  }
  function succeeded (d) { return d.success === true }
  var toast = window.showToast || function () {}

  var hasCrypto = !!(window.crypto && window.crypto.subtle)

  // ---- Credential proof helpers -----------------------------------------
  // The server only accepts a split-key auth_token, derived from the password
  // with the account's salt from /api/keys — exactly like login.html does.
  var _keyInfo = null
  async function keyInfo (force) {
    if (_keyInfo && !force) return _keyInfo
    var r = await fetch('/api/keys', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    _keyInfo = await parse(r, function (d) {
      return typeof d.has_e2ee_keys === 'boolean' && Number.isInteger(d.split_key_version) && d.split_key_version >= 1 &&
        typeof d.auth_token_salt === 'string' && !!d.auth_token_salt
    })
    return _keyInfo
  }

  /* Build the credential-proof payload ({ auth_token }) for the given password. */
  async function credentialProof (password) {
    var info = await keyInfo()
    if (!hasCrypto || !window.OneGyCrypto) throw new Error('THIS BROWSER CANNOT VERIFY YOUR PASSWORD SECURELY')
    var split = await OneGyCrypto.deriveAuthAndWrappingKeys(password, info.auth_token_salt)
    return { auth_token: split.authToken, _split: split }
  }
  function proofBody (proof, extra) {
    var body = extra || {}
    if (proof.auth_token) body.auth_token = proof.auth_token
    return body
  }

  // ---- Section nav: scroll-spy + smooth scroll ---------------------------
  // A clicked section stays active until the user scrolls again: a short last
  // section can never reach the top, so the spy alone would mark its neighbour.
  var links = [].slice.call(document.querySelectorAll('.acc-nav-link'))
  var nav = document.querySelector('.acc-nav')
  var secs = links.map(function (l) { return document.getElementById(l.dataset.sec) }).filter(Boolean)
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches
  var curSec = '', spyLocked = false, spyFrame = 0
  function markSec (id) {
    if (id === curSec) return
    curSec = id
    links.forEach(function (l) {
      var on = l.dataset.sec === id
      l.classList.toggle('is-active', on)
      if (on) l.setAttribute('aria-current', 'true'); else l.removeAttribute('aria-current')
      // Mobile: the nav is a sideways strip; keep the active tab in view.
      if (on && nav && nav.scrollWidth > nav.clientWidth &&
          (l.offsetLeft < nav.scrollLeft || l.offsetLeft + l.offsetWidth > nav.scrollLeft + nav.clientWidth)) {
        nav.scrollTo({ left: l.offsetLeft - 12, behavior: reduceMotion ? 'auto' : 'smooth' })
      }
    })
  }
  function spy () {
    spyFrame = 0
    if (spyLocked || !secs.length) return
    var cur = secs[0]
    secs.forEach(function (s) { if (s.getBoundingClientRect().top <= 180) cur = s })
    var sc = document.querySelector('.rd-scroll')
    var el = sc && sc.scrollHeight > sc.clientHeight ? sc : document.documentElement
    if (el.clientHeight + el.scrollTop >= el.scrollHeight - 4) cur = secs[secs.length - 1]
    markSec(cur.id)
  }
  links.forEach(function (l) { l.addEventListener('click', function (e) {
    var t = document.getElementById(l.dataset.sec); if (!t) return
    e.preventDefault()
    spyLocked = true
    markSec(l.dataset.sec)
    t.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  }) })
  ;['wheel', 'touchmove', 'keydown'].forEach(function (t) { window.addEventListener(t, function () { spyLocked = false }, { passive: true }) })
  document.addEventListener('scroll', function () { if (!spyFrame) spyFrame = requestAnimationFrame(spy) }, { passive: true, capture: true })
  spy()

  // ---- Default Files layout preference (localStorage) --------------------
  var LKEY = 'onegy_files_layout', LDEF = 'grid'
  var segBtns = [].slice.call(document.querySelectorAll('#layoutSeg .acc-seg-btn'))
  function curLayout () { try { return localStorage.getItem(LKEY) || LDEF } catch (e) { return LDEF } }
  function markLayout () { var c = curLayout(); segBtns.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.layout === c ? 'true' : 'false') }) }
  segBtns.forEach(function (b) { b.addEventListener('click', function () { try { localStorage.setItem(LKEY, b.dataset.layout) } catch (e) {} markLayout() }) })
  markLayout()

  // ---- Simple modal open/close (reuse .rd-modal styling) -----------------
  var modalOpener = null
  function openModal (id) {
    var m = document.getElementById(id); if (!m) return
    m.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid') })
    modalOpener = document.activeElement
    m.classList.add('rd-open'); m.setAttribute('aria-hidden', 'false'); document.documentElement.style.overflow = 'hidden'
  }
  function closeModal (m) {
    if (!m) return; m.classList.remove('rd-open'); m.setAttribute('aria-hidden', 'true'); document.documentElement.style.overflow = ''
    if (modalOpener && modalOpener.focus && document.contains(modalOpener)) modalOpener.focus({ preventScroll: true })
    modalOpener = null
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-rd-modal-close]') || e.target.classList.contains('rd-modal-overlay')) closeModal(e.target.closest('.rd-modal'))
  })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var o = document.querySelector('.rd-modal.rd-open'); if (o) closeModal(o) } })
  // Dialog forms exist for Enter-to-submit: the submit button's click handler
  // does the work, so the native submission itself is always cancelled.
  document.addEventListener('submit', function (e) { if (e.target.closest('.acc-dialog')) e.preventDefault() })
  // Client-side validation: flag the field, focus it, explain in a toast.
  function need (el, msg) { if (el) { el.setAttribute('aria-invalid', 'true'); el.focus() } toast(msg, 'error') }
  document.addEventListener('input', function (e) { if (e.target.removeAttribute) e.target.removeAttribute('aria-invalid') })

  // ---- Two-factor --------------------------------------------------------
  // AUDIT FIX H5: /account/2fa/setup and /account/2fa/confirm now require proof
  // of the CURRENT credentials (a session hijacker must not be able to bind
  // their own TOTP secret), and /account/2fa/disable has always required
  // password + a current code — but this page sent NO payload at all, so 2FA
  // could never be turned off through the UI.
  var tfaEnable = document.getElementById('tfaEnableBtn'), tfaDisable = document.getElementById('tfaDisableBtn'),
      tfaStatus = document.getElementById('tfaStatus'), tfaModal = document.getElementById('tfaModal')
  // The enrolment password proof is held only for the setup -> confirm hop.
  var tfaPendingProof = null
  function setTfa (on) {
    if (tfaStatus) {
      tfaStatus.dataset.on = on ? 'true' : 'false'; tfaStatus.textContent = on ? 'On' : 'Off'
      tfaStatus.classList.toggle('is-good', on); tfaStatus.classList.toggle('is-dot', on)
    }
    if (tfaEnable) tfaEnable.hidden = on
    if (tfaDisable) tfaDisable.hidden = !on
    // API-key creation requires an authenticator code exactly when 2FA is on.
    var keyTotp = document.getElementById('keyTotp')
    var keyTotpLabel = document.getElementById('keyTotpLabel')
    var keyTotpField = document.getElementById('keyTotpField')
    if (keyTotp) { keyTotp.hidden = !on; keyTotp.value = '' }
    if (keyTotpLabel) keyTotpLabel.hidden = !on
    if (keyTotpField) keyTotpField.hidden = !on
  }

  if (tfaEnable) tfaEnable.addEventListener('click', function () {
    var pw = document.getElementById('tfaStartPw'); if (pw) pw.value = ''
    openModal('tfaStartModal'); if (pw) setTimeout(function () { pw.focus() }, 60)
  })

  var tfaStart = document.getElementById('tfaStartBtn')
  if (tfaStart) tfaStart.addEventListener('click', async function () {
    var pwEl = document.getElementById('tfaStartPw')
    var pw = pwEl ? pwEl.value : ''
    if (!pw) { need(pwEl, 'ENTER YOUR PASSWORD'); return }
    tfaStart.disabled = true
    try {
      var proof = await credentialProof(pw)
      var d = await parse(await jpost('/account/2fa/setup', proofBody(proof)), function (v) { return typeof v.secret === 'string' && !!v.secret && typeof v.qr_code === 'string' && !!v.qr_code })
      // Keep the proof for the confirm call, then discard it.
      tfaPendingProof = { auth_token: proof.auth_token }
      if (pwEl) pwEl.value = ''
      closeModal(document.getElementById('tfaStartModal'))
      var qr = document.getElementById('tfaQr'); if (qr && d.qr_code) qr.src = d.qr_code.indexOf('data:') === 0 ? d.qr_code : ('data:image/png;base64,' + d.qr_code)
      var sec = document.getElementById('tfaSecret'); if (sec) sec.textContent = d.secret || ''
      var code = document.getElementById('tfaCode'); if (code) code.value = ''
      openModal('tfaModal'); if (code) setTimeout(function () { code.focus() }, 60)
    } catch (e) {
      console.error('[ACCOUNT] 2FA setup failed:', e)
      toast(e && e.message ? e.message : 'COULD NOT START 2FA SETUP', 'error')
    } finally { tfaStart.disabled = false }
  })

  var tfaConfirm = document.getElementById('tfaConfirmBtn')
  if (tfaConfirm) tfaConfirm.addEventListener('click', async function () {
    var codeEl = document.getElementById('tfaCode')
    var code = (codeEl.value || '').trim()
    if (!code) { need(codeEl, 'ENTER YOUR 6-DIGIT CODE'); return }
    if (!tfaPendingProof) { toast('SETUP EXPIRED. START AGAIN', 'error'); closeModal(tfaModal); return }
    tfaConfirm.disabled = true
    try {
      await parse(await jpost('/account/2fa/confirm', proofBody(tfaPendingProof, { totp_code: code })), succeeded)
      tfaPendingProof = null
      closeModal(tfaModal); setTfa(true); toast('TWO-FACTOR ENABLED', 'success')
    } catch (e) {
      // The server burns the pending secret on a failed confirm, so restart.
      tfaPendingProof = null
      closeModal(tfaModal)
      toast(e && e.message ? e.message : 'COULD NOT ENABLE TWO-FACTOR', 'error')
    } finally {
      tfaConfirm.disabled = false
    }
  })

  if (tfaDisable) tfaDisable.addEventListener('click', function () {
    var pw = document.getElementById('tfaDisablePw'); if (pw) pw.value = ''
    var code = document.getElementById('tfaDisableCode'); if (code) code.value = ''
    openModal('tfaDisableModal'); if (pw) setTimeout(function () { pw.focus() }, 60)
  })

  var tfaDisableConfirm = document.getElementById('tfaDisableConfirmBtn')
  if (tfaDisableConfirm) tfaDisableConfirm.addEventListener('click', async function () {
    var pwEl = document.getElementById('tfaDisablePw'), codeEl = document.getElementById('tfaDisableCode')
    var pw = pwEl ? pwEl.value : '', code = codeEl ? (codeEl.value || '').trim() : ''
    if (!pw) { need(pwEl, 'ENTER YOUR PASSWORD'); return }
    if (!code) { need(codeEl, 'ENTER YOUR 6-DIGIT CODE'); return }
    tfaDisableConfirm.disabled = true
    try {
      var proof = await credentialProof(pw)
      await parse(await jpost('/account/2fa/disable', proofBody(proof, { totp_code: code })), succeeded)
      if (pwEl) pwEl.value = ''
      if (codeEl) codeEl.value = ''
      closeModal(document.getElementById('tfaDisableModal'))
      setTfa(false); toast('TWO-FACTOR DISABLED', 'success')
    } catch (e) {
      console.error('[ACCOUNT] 2FA disable failed:', e)
      toast(e && e.message ? e.message : 'COULD NOT DISABLE TWO-FACTOR', 'error')
    } finally { tfaDisableConfirm.disabled = false }
  })

  // ---- Change password ---------------------------------------------------
  // AUDIT FIX H7: there was no password-change UI at all, which also made
  // session_epoch rotation (the only "sign out other devices" mechanism)
  // unreachable. This performs the FULL client-side split-key re-derivation and
  // master-key re-wrap using crypto.js's existing primitives —
  // deriveAuthAndWrappingKeys() + wrapMasterKey(). No new crypto path is invented.
  //
  // The server enforces the matching invariant (AUDIT FIX C3): if the account
  // has E2EE keys, encrypted_master_key + master_key_nonce + master_key_salt
  // are MANDATORY whenever credentials rotate. This code must therefore never
  // send new credentials without the re-wrapped master key.
  var pwChangeBtn = document.getElementById('pwChangeBtn')
  if (pwChangeBtn) pwChangeBtn.addEventListener('click', function () {
    ;['pwCurrent', 'pwNew', 'pwConfirm'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = '' })
    openModal('pwModal')
    var el = document.getElementById('pwCurrent'); if (el) setTimeout(function () { el.focus() }, 60)
  })

  var pwSave = document.getElementById('pwSaveBtn')
  if (pwSave) pwSave.addEventListener('click', async function () {
    var curEl = document.getElementById('pwCurrent'), newEl = document.getElementById('pwNew'), confEl = document.getElementById('pwConfirm')
    var current = curEl ? curEl.value : '', next = newEl ? newEl.value : '', confirmPw = confEl ? confEl.value : ''

    if (!current || !next || !confirmPw) { need(!current ? curEl : !next ? newEl : confEl, 'ALL FIELDS ARE REQUIRED'); return }
    if (next !== confirmPw) { need(confEl, 'NEW PASSWORDS DO NOT MATCH'); return }
    // Client-side policy, kept identical to register + recovery. The server can
    // only sanity-check the asserted length (zero-knowledge: it never sees the
    // password), so this is the authoritative check for honest clients.
    if (next.length < 6) { need(newEl, 'PASSWORD MUST BE AT LEAST 6 CHARACTERS'); return }
    if (next.length > 1024) { need(newEl, 'PASSWORD MUST BE 1024 CHARACTERS OR LESS'); return }
    if (next === current) { need(newEl, 'NEW PASSWORD MUST BE DIFFERENT'); return }
    if (!hasCrypto || !window.OneGyCrypto) { toast('THIS BROWSER CANNOT CHANGE YOUR PASSWORD SECURELY', 'error'); return }

    pwSave.disabled = true
    try {
      var info = await keyInfo(true)

      // 1) Prove the CURRENT credentials, and get the current wrapping key.
      var payload = { new_password_length: next.length }
      var currentSplit = await OneGyCrypto.deriveAuthAndWrappingKeys(current, info.auth_token_salt)
      payload.current_auth_token = currentSplit.authToken

      // 2) Derive the NEW split-key credentials (fresh salt, 600K PBKDF2 + HKDF).
      var newSplit = await OneGyCrypto.deriveAuthAndWrappingKeys(next)
      payload.new_auth_token = newSplit.authToken
      payload.new_auth_salt = newSplit.salt
      // ZERO-KNOWLEDGE INVARIANT: the NEW password is never transmitted. The
      // server takes the split-key branch (new_auth_token + new_auth_salt) and
      // only ever sees SHA-256(auth_token) plus the asserted length. Do not add
      // new_password here — for a v1 account that would leak the plaintext.

      // 3) Re-wrap the master key under the NEW wrapping key. MANDATORY when
      //    the account has E2EE keys — omitting it would permanently brick the
      //    vault (and the server now rejects the request outright).
      if (info.has_e2ee_keys) {
        var masterKey = await OneGyCrypto.getMasterKeyFromSession()
        if (!masterKey) {
          // Session keys not loaded (e.g. fresh tab) — unlock from the server blobs.
          var unlocked = await OneGyCrypto.unlockUserKeys(currentSplit.wrappingKey, {
            encryptedMasterKey: info.encrypted_master_key,
            masterKeyNonce: info.master_key_nonce,
            masterKeySalt: info.master_key_salt,
            encryptedPrivateKey: info.encrypted_private_key,
            privateKeyNonce: info.private_key_nonce
          })
          masterKey = unlocked.masterKey
        }
        if (!masterKey) throw new Error('COULD NOT UNLOCK YOUR ENCRYPTION KEYS. CHECK YOUR CURRENT PASSWORD')
        var rewrapped = await OneGyCrypto.wrapMasterKey(masterKey, newSplit.wrappingKey, newSplit.salt)
        payload.encrypted_master_key = rewrapped.encryptedMasterKey
        payload.master_key_nonce = rewrapped.nonce
        payload.master_key_salt = rewrapped.salt
      }

      await parse(await jpost('/change-password', payload), succeeded)

      // Re-key the in-browser session cache so this tab keeps working.
      if (info.has_e2ee_keys && masterKey) {
        try { await OneGyCrypto.storeMasterKeyInSession(masterKey) } catch (e) {}
      }
      _keyInfo = null
      ;[curEl, newEl, confEl].forEach(function (el) { if (el) el.value = '' })
      closeModal(document.getElementById('pwModal'))
      toast('PASSWORD CHANGED. OTHER DEVICES SIGNED OUT', 'success')
    } catch (e) {
      console.error('[ACCOUNT] Password change failed:', e)
      toast(e && e.message ? e.message : 'PASSWORD CHANGE FAILED', 'error')
    } finally { pwSave.disabled = false }
  })

  // ---- Sign out other devices -------------------------------------------
  var signOutAll = document.getElementById('signOutAllBtn')
  if (signOutAll) signOutAll.addEventListener('click', function () {
    var pw = document.getElementById('signOutAllPw'); if (pw) pw.value = ''
    var dev = document.getElementById('signOutAllDevices'); if (dev) dev.checked = true
    openModal('signOutAllModal'); if (pw) setTimeout(function () { pw.focus() }, 60)
  })
  var signOutAllConfirm = document.getElementById('signOutAllConfirmBtn')
  if (signOutAllConfirm) signOutAllConfirm.addEventListener('click', async function () {
    var pwEl = document.getElementById('signOutAllPw')
    var pw = pwEl ? pwEl.value : ''
    if (!pw) { need(pwEl, 'ENTER YOUR PASSWORD'); return }
    signOutAllConfirm.disabled = true
    try {
      var proof = await credentialProof(pw)
      var devEl = document.getElementById('signOutAllDevices')
      await parse(await jpost('/account/sign-out-all', proofBody(proof, { revoke_devices: !devEl || devEl.checked })), succeeded)
      if (pwEl) pwEl.value = ''
      closeModal(document.getElementById('signOutAllModal'))
      toast('SIGNED OUT ON ALL OTHER DEVICES', 'success')
    } catch (e) {
      console.error('[ACCOUNT] Sign-out-all failed:', e)
      toast(e && e.message ? e.message : 'COULD NOT SIGN OUT OTHER DEVICES', 'error')
    } finally { signOutAllConfirm.disabled = false }
  })

  // ---- API keys ----------------------------------------------------------
  var keyList = document.getElementById('keyList')
  // AUDIT FIX F11: ids are API-controlled. Integers are the normal case; a
  // string id must still be URL/HTML-safe — anything else fails validation
  // (fail closed) instead of reaching markup or the request path.
  function validKeyId (id) { return Number.isInteger(id) || (typeof id === 'string' && /^[A-Za-z0-9._-]{1,62}$/.test(id)) }
  var PERM_LABELS = { read: 'Read', download: 'Download', write: 'Write', delete: 'Delete', restore: 'Restore', manage_keys: 'Manage keys' }
  function permStr (p) {
    if (!p) return 'No permissions'
    return Object.keys(p).filter(function (k) { return p[k] }).map(function (k) { return PERM_LABELS[k] || k }).join(' · ') || 'No permissions'
  }
  function keyWhen (k) {
    function day (s) {
      var t = typeof s === 'string' ? new Date(s) : null
      return t && !isNaN(t) ? t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
    }
    var made = day(k.created_at), used = day(k.last_used_at)
    return (made ? 'Created ' + made + ' · ' : '') + (used ? 'Last used ' + used : 'Never used')
  }
  async function loadKeys () {
    if (!keyList) return
    try {
      var d = await parse(await fetch('/account/api-keys', { headers: { 'X-Requested-With': 'XMLHttpRequest' } }), function (v) {
        return Array.isArray(v.keys) && v.keys.every(function (k) {
          return k && typeof k === 'object' && validKeyId(k.id) &&
            (k.label === null || typeof k.label === 'string') && k.permissions && typeof k.permissions === 'object' && !Array.isArray(k.permissions)
        })
      })
      var keys = d.keys
    } catch (e) {
      keyList.innerHTML = '<div class="acc-empty">Could not load API keys</div>'
      toast(e && e.message ? e.message : 'COULD NOT LOAD API KEYS', 'error')
      return
    }
    if (!keys.length) { keyList.innerHTML = '<div class="acc-empty"><b>No API keys yet</b>Create one to script uploads and downloads.</div>'; return }
    // AUDIT FIX F11: the row template interpolates NOTHING from the API.
    // The id goes in via dataset (attribute assignment — never HTML-parsed)
    // and the label/permission text via textContent, so a malformed API
    // response (id with quotes, permission keys with markup) cannot inject.
    keyList.innerHTML = keys.map(function () {
      return '<div class="acc-keyrow"><span class="acc-keyicon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M16 7l3 3M14 9l2 2"/></svg></span>' +
        '<div class="acc-keytext"><div class="k-label"></div><div class="k-meta"></div><div class="k-when"></div></div>' +
        '<button type="button" class="rd-btn rd-btn-sm rd-btn-ghost k-revoke">Revoke</button></div>'
    }).join('')
    var rows = keyList.querySelectorAll('.acc-keyrow')
    keys.forEach(function (k, i) {
      var row = rows[i]
      if (!row) return
      row.dataset.id = String(k.id)
      row.querySelector('.k-label').textContent = k.label || 'API key'
      row.querySelector('.k-meta').textContent = permStr(k.permissions)
      row.querySelector('.k-when').textContent = keyWhen(k)
    })
  }
  if (keyList) {
    loadKeys()
    keyList.addEventListener('click', async function (e) {
      var rev = e.target.closest('.k-revoke'); if (!rev) return
      var row = rev.closest('.acc-keyrow'), id = row.dataset.id
      var ok = window.showConfirm ? await showConfirm('Revoke key', 'Anything using this key stops working immediately.', 'Revoke') : confirm('Revoke key?')
      if (!ok) return
      try {
        // encodeURIComponent: even with validKeyId's charset check, keep the
        // path construction injection-proof by construction (F11).
        await parse(await jpost('/account/api-keys/' + encodeURIComponent(String(id)), null, 'DELETE'), succeeded)
        row.remove(); toast('KEY REVOKED', 'success'); if (!keyList.querySelector('.acc-keyrow')) loadKeys()
      } catch (e) { toast(e && e.message ? e.message : 'COULD NOT REVOKE KEY', 'error') }
    })
    var keyCreate = document.getElementById('keyCreateBtn'), keySave = document.getElementById('keySaveBtn')
    if (keyCreate) keyCreate.addEventListener('click', function () {
      ;['keyLabel', 'keyPw', 'keyTotp'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = '' })
      document.querySelectorAll('#keyModal [data-perm]').forEach(function (c) { c.checked = c.dataset.perm === 'read' })
      var rev = document.getElementById('keyReveal'); if (rev) rev.hidden = true
      var val = document.getElementById('keyValue'); if (val) val.textContent = ''
      openModal('keyModal')
      var lab = document.getElementById('keyLabel'); if (lab) setTimeout(function () { lab.focus() }, 60)
    })
    if (keySave) keySave.addEventListener('click', async function () {
      var label = (document.getElementById('keyLabel').value || '').trim() || 'API key'
      var perms = {}; document.querySelectorAll('#keyModal [data-perm]').forEach(function (c) { perms[c.dataset.perm] = c.checked })
      var pwEl = document.getElementById('keyPw')
      var pw = pwEl ? pwEl.value : ''
      if (!pw) { need(pwEl, 'ENTER YOUR PASSWORD'); return }
      var totpEl = document.getElementById('keyTotp')
      var totp = totpEl && !totpEl.hidden ? (totpEl.value || '').trim() : ''
      keySave.disabled = true
      var d
      try {
        var proof = await credentialProof(pw)
        var payload = proofBody(proof, { label: label, permissions: perms })
        if (totp) payload.totp_code = totp
        d = await parse(await jpost('/account/api-keys', payload), function (v) { return validKeyId(v.id) && typeof v.key === 'string' && !!v.key })
      } catch (e) {
        toast(e && e.message ? e.message : 'COULD NOT CREATE KEY', 'error')
        return
      } finally { keySave.disabled = false }
      var full = d.key || d.api_key || d.full_key || d.plaintext_key || d.secret || ''
      var rev = document.getElementById('keyReveal'), val = document.getElementById('keyValue')
      if (!full || !rev || !val) { toast('INVALID SERVER RESPONSE', 'error'); return }
      val.textContent = full; rev.hidden = false
      if (pwEl) pwEl.value = ''
      if (totpEl) totpEl.value = ''
      toast('KEY CREATED', 'success'); loadKeys()
    })
    var keyCopy = document.getElementById('keyCopy')
    if (keyCopy) keyCopy.addEventListener('click', function () {
      var v = document.getElementById('keyValue').textContent
      navigator.clipboard && navigator.clipboard.writeText(v).then(function () { toast('COPIED', 'success') })
    })
  }

  // ---- Danger zone -------------------------------------------------------
  // AUDIT FIX H6 (same defect as delete-account): /delete-all-files also calls
  // request.get_json() and also mandates password + captcha, so the old
  // FormData-with-no-credentials POST could never succeed.
  function reloadDelAllCaptcha () {
    var img = document.getElementById('delAllCaptchaImg')
    if (img) img.src = '/captcha?t=' + Date.now()
  }
  var delAllCaptchaReload = document.getElementById('delAllCaptchaReload')
  if (delAllCaptchaReload) delAllCaptchaReload.addEventListener('click', reloadDelAllCaptcha)

  var delAll = document.getElementById('delAllBtn')
  if (delAll) delAll.addEventListener('click', async function () {
    var ok = window.showConfirm ? await showConfirm('Delete all files', 'Every file and folder will be permanently deleted. This cannot be undone.', 'Continue') : confirm('Delete all files?')
    if (!ok) return
    ;['delAllPw', 'delAllCaptcha'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = '' })
    reloadDelAllCaptcha()
    openModal('delAllModal')
    var el = document.getElementById('delAllPw'); if (el) setTimeout(function () { el.focus() }, 60)
  })

  var delAllConfirm = document.getElementById('delAllConfirmBtn')
  if (delAllConfirm) delAllConfirm.addEventListener('click', async function () {
    var pwEl = document.getElementById('delAllPw'), capEl = document.getElementById('delAllCaptcha')
    var pw = pwEl ? pwEl.value : '', cap = capEl ? (capEl.value || '').trim() : ''
    if (!pw) { need(pwEl, 'ENTER YOUR PASSWORD'); return }
    if (!cap) { need(capEl, 'SOLVE THE CAPTCHA'); return }
    delAllConfirm.disabled = true
    try {
      var proof = await credentialProof(pw)
      await parse(await jpost('/delete-all-files', proofBody(proof, { captcha: cap })), succeeded)
      if (pwEl) pwEl.value = ''
      if (capEl) capEl.value = ''
      closeModal(document.getElementById('delAllModal'))
      toast('ALL FILES DELETED', 'success')
    } catch (e) {
      console.error('[ACCOUNT] Delete all files failed:', e)
      toast(e && e.message ? e.message : 'COULD NOT DELETE FILES', 'error')
      reloadDelAllCaptcha()
    } finally { delAllConfirm.disabled = false }
  })
  // AUDIT FIX H6: this used to POST a FormData body while setting
  // X-Requested-With: XMLHttpRequest. The handler calls request.get_json(),
  // which raises 415 on a multipart content type under Flask 3 — and the body
  // carried neither the captcha nor the password the server mandates. Account
  // deletion silently failed for every user. Send JSON with both proofs.
  function reloadDelAcctCaptcha () {
    var img = document.getElementById('delAcctCaptchaImg')
    if (img) img.src = '/captcha?t=' + Date.now()
  }
  var delAcctCaptchaReload = document.getElementById('delAcctCaptchaReload')
  if (delAcctCaptchaReload) delAcctCaptchaReload.addEventListener('click', reloadDelAcctCaptcha)

  var delAcct = document.getElementById('delAcctBtn')
  if (delAcct) delAcct.addEventListener('click', async function () {
    var ok = window.showConfirm ? await showConfirm('Delete account', 'Your account and all its data will be permanently removed.', 'Continue') : confirm('Delete account?')
    if (!ok) return
    ;['delAcctPw', 'delAcctCaptcha'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = '' })
    reloadDelAcctCaptcha()
    openModal('delAcctModal')
    var el = document.getElementById('delAcctPw'); if (el) setTimeout(function () { el.focus() }, 60)
  })

  var delAcctConfirm = document.getElementById('delAcctConfirmBtn')
  if (delAcctConfirm) delAcctConfirm.addEventListener('click', async function () {
    var pwEl = document.getElementById('delAcctPw'), capEl = document.getElementById('delAcctCaptcha')
    var pw = pwEl ? pwEl.value : '', cap = capEl ? (capEl.value || '').trim() : ''
    if (!pw) { need(pwEl, 'ENTER YOUR PASSWORD'); return }
    if (!cap) { need(capEl, 'SOLVE THE CAPTCHA'); return }
    delAcctConfirm.disabled = true
    try {
      var proof = await credentialProof(pw)
      var d = await parse(await jpost('/delete-account', proofBody(proof, { captcha: cap })), function (v) { return v.success === true && typeof v.redirect === 'string' })
      try { if (window.OneGyCrypto && OneGyCrypto.clearSessionKeys) OneGyCrypto.clearSessionKeys() } catch (e) {}
      window.location.href = d.redirect || '/'
    } catch (e) {
      console.error('[ACCOUNT] Account deletion failed:', e)
      toast(e && e.message ? e.message : 'COULD NOT DELETE ACCOUNT', 'error')
      reloadDelAcctCaptcha()
    } finally { delAcctConfirm.disabled = false }
  })
})();
