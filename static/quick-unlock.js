/* ============================================================================
   quick-unlock.js — sign in and unlock this browser's E2EE keys with a
   fingerprint or face (a passkey's PRF output) or a PIN instead of the
   password, like the desktop app's PIN. Server side: src/app/226_quick_unlock.py.

   The passkey's PRF output or the PIN, with a salt kept only here, gives two
   values: a wrapping secret and a proof. The master key is kept in localStorage,
   AES-GCM wrapped under HKDF(wrapping secret || server share). The server hands
   the share out (and signs this browser in, if its session ended) only for the
   right proof, and erases it after five wrong ones. So neither this browser's
   storage nor the server can open the key alone. Unlocking stores the key in the
   tab session exactly like a password unlock (OneGyCrypto.storeMasterKeyInSession).
   ========================================================================== */
;(function () {
  'use strict'
  var LS_KEY = 'onegy_quick_unlock'
  var LS_SKIP = 'onegy_quick_unlock_skip' // "Not now": stop offering it after a password
  var enc = new TextEncoder()
  var INFO = enc.encode('onegy-quick-unlock-v1')
  var PASSKEY_INFO = enc.encode('onegy-quick-unlock-passkey-v1')
  var PIN_ITERATIONS = 200000
  var PIN_RE = /^\d{6,64}$/
  // ONE.GY Desktop has its own PIN lock.
  var inDesktopApp = /ONEGY-Desktop\//.test(navigator.userAgent)
  var BIO = /Android|iPhone|iPad/.test(navigator.userAgent) ? 'fingerprint or face' : 'passkey'

  function noop () {}
  function csrf () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.content : '' }
  function req (url, method, body) {
    return fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrf() }, body: body ? JSON.stringify(body) : undefined })
  }
  async function json (r) {
    var d = {}
    try { d = await r.json() } catch (e) {}
    if (!r.ok) { var err = new Error(d.error || 'REQUEST FAILED'); err.status = r.status; throw err }
    return d
  }
  function b64 (buf) { var s = '', a = new Uint8Array(buf); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s) }
  function unb64 (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0) }) }
  function rand (n) { return crypto.getRandomValues(new Uint8Array(n)) }
  function url (id, tail) { return '/account/quick-unlock/' + encodeURIComponent(id) + (tail || '') }
  function toast (message, kind) { (window.showToast || noop)(message, kind || 'error') }
  function failed (e, fallback) { toast(e && e.name === 'NotAllowedError' ? 'CANCELLED' : (e && e.message) || fallback) }
  function pinInput (placeholder) {
    // A text field masked in CSS: a password field would have the password
    // manager fill the account password in, or offer to save the PIN over it.
    return '<input type="text" class="form-input qu-pin-input" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="64" placeholder="' + placeholder + '" aria-label="PIN">'
  }

  function local () { try { var r = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); return r && r.id ? r : null } catch (e) { return null } }
  // Tell the password manager a passkey is dead, so it does not linger there.
  function dropPasskey (credId) {
    try {
      if (credId && window.PublicKeyCredential && PublicKeyCredential.signalUnknownCredential) {
        PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: credId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }).catch(noop)
      }
    } catch (e) {}
  }
  function forget () {
    var rec = local()
    try { localStorage.removeItem(LS_KEY) } catch (e) {}
    if (rec) dropPasskey(rec.credId)
  }

  // A fingerprint, face or screen lock built into this device.
  function passkeyAvailable () {
    if (!window.PublicKeyCredential || !navigator.credentials || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return Promise.resolve(false)
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(function () { return false })
  }

  // 64 derived bytes: the wrapping secret, then the proof the server checks.
  function halves (bits) { bits = new Uint8Array(bits); return { secret: bits.slice(0, 32), proof: b64(bits.slice(32)) } }
  async function pinKeys (pin, salt) {
    var base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
    return halves(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: PIN_ITERATIONS }, base, 512))
  }
  async function passkeyKeys (prf, salt) {
    var base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveBits'])
    return halves(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: PASSKEY_INFO }, base, 512))
  }
  async function wrapKey (secret, share, salt) {
    var s = unb64(share), ikm = new Uint8Array(secret.length + s.length)
    ikm.set(secret); ikm.set(s, secret.length)
    var base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: INFO }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  }
  function prfResult (cred) {
    var ext = cred && cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    return ext.prf && ext.prf.results && ext.prf.results.first ? new Uint8Array(ext.prf.results.first) : null
  }
  function assertPasskey (rec) {
    return navigator.credentials.get({ publicKey: {
      challenge: rand(32), allowCredentials: [{ type: 'public-key', id: unb64(rec.credId) }],
      userVerification: 'required', timeout: 60000,
      extensions: { prf: { eval: { first: unb64(rec.prfSalt) } } }
    } })
  }
  function unsupported () { return new Error('THIS DEVICE CANNOT UNLOCK WITH A FINGERPRINT HERE. SET A PIN INSTEAD') }

  /* o = { method: 'passkey'|'pin', authToken, masterKey, username, pin?, beforePrompt?(kind) }.
     beforePrompt('create'|'confirm') resolves on the user's next tap: Safari opens
     a passkey prompt only straight from a tap, so a caller that worked since the
     last tap (or a second prompt) waits for one. */
  async function enroll (o) {
    var old = local(), salt = rand(32), row = null
    var rec = { method: o.method, salt: b64(salt), user: o.username || '' }
    var wait = o.beforePrompt || function () { return Promise.resolve() }
    try {
      var keys
      if (o.method === 'pin') keys = await pinKeys(o.pin, salt)
      else {
        var prfSalt = rand(32), name = o.username || 'ONE.GY'
        rec.prfSalt = b64(prfSalt)
        await wait('create')
        var cred = await navigator.credentials.create({ publicKey: {
          rp: { name: 'ONE.GY' },
          // A new handle per setup: passkey managers keep one passkey per handle, so a
          // shared one would let a second phone's setup replace this phone's passkey.
          user: { id: rand(16), name: name, displayName: name },
          challenge: rand(32),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
          timeout: 60000,
          extensions: { prf: { eval: { first: prfSalt } } }
        } })
        rec.credId = b64(cred.rawId)
        var ext = cred.getClientExtensionResults(), prf = prfResult(cred)
        if (!prf && ext.prf && ext.prf.enabled) {
          await wait('confirm')
          prf = prfResult(await assertPasskey(rec))
        }
        if (!prf) throw unsupported()
        keys = await passkeyKeys(prf, salt)
      }
      row = await json(await req('/account/quick-unlock', 'POST', { method: o.method, auth_token: o.authToken, proof: keys.proof }))
      var iv = rand(12), raw = await crypto.subtle.exportKey('raw', o.masterKey)
      rec.id = row.id; rec.iv = b64(iv)
      rec.wrapped = b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(row.id) }, await wrapKey(keys.secret, row.share, salt), raw))
      new Uint8Array(raw).fill(0)
      localStorage.setItem(LS_KEY, JSON.stringify(rec))
    } catch (e) {
      if (row) req(url(row.id), 'DELETE').catch(noop)
      dropPasskey(rec.credId)
      throw e
    }
    if (old) {
      req(url(old.id), 'DELETE').catch(noop)
      if (old.credId !== rec.credId) dropPasskey(old.credId)
    }
    try { localStorage.removeItem(LS_SKIP) } catch (e) {}
    return rec
  }

  // The local record if the server still knows it; a stale one is dropped.
  // Signed out (the sign-in page), the server cannot say: the record stands.
  async function status () {
    var rec = local(); if (!rec) return null
    try {
      var r = await req(url(rec.id))
      if (r.status === 404) { forget(); return null }
    } catch (e) {}
    return rec
  }

  // Opens the keys; resolves with the server's answer ({ signed_in, redirect }).
  async function unlock (pin) {
    var rec = local(); if (!rec) throw new Error('QUICK UNLOCK IS OFF ON THIS DEVICE. USE YOUR PASSWORD')
    var keys
    if (rec.method === 'pin') keys = await pinKeys(pin, unb64(rec.salt))
    else {
      var prf = prfResult(await assertPasskey(rec))
      if (!prf) throw unsupported()
      keys = await passkeyKeys(prf, unb64(rec.salt))
    }
    var r = await req(url(rec.id, '/unlock'), 'POST', { proof: keys.proof })
    if (r.status === 404) forget()
    var d = await json(r)
    var raw
    try {
      raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: enc.encode(rec.id) },
        await wrapKey(keys.secret, d.share, unb64(rec.salt)), unb64(rec.wrapped)))
    } catch (e) { throw new Error('QUICK UNLOCK FAILED. USE YOUR PASSWORD') }
    var master = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'])
    raw.fill(0)
    await OneGyCrypto.storeMasterKeyInSession(master)
    return d
  }

  async function disable () {
    var rec = local(); forget()
    if (rec) await req(url(rec.id), 'DELETE')
  }

  /* The sign-in page and the lock cards (Files, Notes): put the quick unlock in
     place of the password form while one is set up here, with a way back to the
     password. onUnlocked gets the server's answer. */
  function mount (form, onUnlocked) {
    if (inDesktopApp || !form || !window.OneGyCrypto || !local()) return
    status().then(function (rec) {
      if (!rec) return
      var box = document.createElement('div'); box.className = 'qu-box'
      box.innerHTML = (rec.method === 'pin'
        ? '<form class="qu-pin">' + pinInput('PIN') + '<button type="submit" class="rd-btn rd-btn-primary">Unlock</button></form>'
        : '<button type="button" class="rd-btn rd-btn-primary qu-bio">Unlock with ' + BIO + '</button>') +
        '<button type="button" class="qu-switch">Use password instead</button>'
      if (rec.user) { var who = document.createElement('p'); who.className = 'qu-user'; who.textContent = rec.user; box.insertBefore(who, box.firstChild) }
      var sub = form.parentNode.querySelector('p'), subText = sub && sub.textContent
      if (sub) sub.textContent = subText.replace('Enter your password', rec.method === 'pin' ? 'Enter your PIN' : 'Use your ' + BIO)
      form.hidden = true
      form.parentNode.insertBefore(box, form)
      function close () { box.remove(); form.hidden = false; if (sub) sub.textContent = subText }
      function usePassword () { close(); var field = form.querySelector('input:not([type="hidden"])'); if (field) field.focus() }
      async function run (btn, pin) {
        btn.disabled = true
        try { var d = await unlock(pin); close(); onUnlocked(d) } catch (e) {
          failed(e, 'QUICK UNLOCK FAILED')
          if (!local()) usePassword()
        } finally { btn.disabled = false }
      }
      box.querySelector('.qu-switch').onclick = usePassword
      var bio = box.querySelector('.qu-bio'); if (bio) bio.onclick = function () { run(bio) }
      var pinForm = box.querySelector('.qu-pin')
      if (pinForm) {
        var input = pinForm.querySelector('input')
        pinForm.onsubmit = function (e) { e.preventDefault(); if (input.value) run(pinForm.querySelector('button'), input.value).then(function () { input.value = '' }) }
        input.focus()
      }
    })
  }

  /* After a password was entered on a phone or tablet: offer to use a fingerprint,
     face or PIN from now on, like the desktop app does. Shown inside host (the
     sign-in box or a lock card) in place of its content; resolves when the user
     has set one up or said "Not now". o = { authToken, masterKey, username,
     leave? } — leave: the caller navigates away, so host is not put back. */
  function offer (host, o) {
    return new Promise(function (resolve) {
      var skipped = true
      try { skipped = !!localStorage.getItem(LS_SKIP) } catch (e) {}
      var touch = window.matchMedia && matchMedia('(pointer:coarse)').matches
      if (inDesktopApp || !touch || skipped || local() || !host || !o || !o.authToken || !o.masterKey) { resolve(); return }
      passkeyAvailable().then(function (bio) {
        var kids = [].filter.call(host.children, function (el) { return !el.hidden })
        var box = document.createElement('div'); box.className = 'qu-offer'
        box.innerHTML = '<div class="qu-offer-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.7"/></svg></div>' +
          '<h2 class="qu-offer-title">Unlock faster next time</h2>' +
          '<p class="qu-offer-sub">Use ' + (bio ? 'your ' + BIO + ' or a PIN' : 'a PIN') + ' instead of your password on this device.</p>' +
          (bio ? '<button type="button" class="rd-btn rd-btn-primary qu-offer-bio">Use ' + BIO + '</button>' +
                 '<button type="button" class="rd-btn rd-btn-ghost qu-offer-pin">Set a PIN</button>' : '') +
          '<form class="qu-pin"' + (bio ? ' hidden' : '') + '>' + pinInput('PIN, at least 6 digits') + '<button type="submit" class="rd-btn rd-btn-primary">Save PIN</button></form>' +
          '<button type="button" class="qu-switch qu-offer-skip">Not now</button>'
        kids.forEach(function (el) { el.hidden = true })
        host.appendChild(box)
        var bioBtn = box.querySelector('.qu-offer-bio'), pinBtn = box.querySelector('.qu-offer-pin')
        var pinForm = box.querySelector('.qu-pin'), pin = pinForm.querySelector('input')
        var waiting = null // resolves the passkey's second prompt on the next tap
        function finish () {
          if (o.leave) [].forEach.call(box.querySelectorAll('button, input'), function (el) { el.disabled = true })
          else { box.remove(); kids.forEach(function (el) { el.hidden = false }) }
          resolve()
        }
        async function run (btn, method) {
          btn.disabled = true
          try {
            await enroll({
              method: method, authToken: o.authToken, masterKey: o.masterKey, username: o.username, pin: pin.value,
              beforePrompt: function (kind) {
                if (kind === 'create') return Promise.resolve()
                return new Promise(function (go) { waiting = go; bioBtn.textContent = 'Confirm ' + BIO; bioBtn.disabled = false })
              }
            })
            toast('QUICK UNLOCK IS ON', 'success')
            finish()
          } catch (e) {
            failed(e, 'COULD NOT SET UP QUICK UNLOCK')
            waiting = null; btn.disabled = false
            if (bioBtn) bioBtn.textContent = 'Use ' + BIO
          }
        }
        if (bioBtn) bioBtn.onclick = function () {
          if (waiting) { var go = waiting; waiting = null; bioBtn.disabled = true; go(); return }
          run(bioBtn, 'passkey')
        }
        if (pinBtn) pinBtn.onclick = function () { bioBtn.hidden = true; pinBtn.hidden = true; pinForm.hidden = false; pin.focus() }
        pinForm.onsubmit = function (e) {
          e.preventDefault()
          if (!PIN_RE.test(pin.value)) { toast('THE PIN MUST BE AT LEAST 6 DIGITS'); pin.focus(); return }
          run(pinForm.querySelector('button'), 'pin')
        }
        box.querySelector('.qu-offer-skip').onclick = function () {
          try { localStorage.setItem(LS_SKIP, '1') } catch (e) {}
          finish()
        }
      })
    })
  }

  window.OneGyQuickUnlock = { PIN_RE: PIN_RE, passkeyAvailable: passkeyAvailable, local: local, status: status, enroll: enroll, unlock: unlock, disable: disable, mount: mount, offer: offer }
})()
