/* ============================================================================
   login.js: the sign-in page (templates/login.html). Split-key sign-in, the
   inline 2FA step, recovery-key reset and quick unlock. The template passes its
   URLs as data-* attributes on this script's tag.
   ========================================================================== */
const LOGIN_URLS = document.currentScript.dataset

document.addEventListener('DOMContentLoaded', function() {
  try {
    if (window.OneGyCrypto && typeof window.OneGyCrypto.clearSessionKeys === 'function') {
      window.OneGyCrypto.clearSessionKeys()
    }
  } catch(e) {}
  // A fingerprint, face or PIN set up in this browser signs in instead of the password.
  if (window.OneGyQuickUnlock) {
    OneGyQuickUnlock.mount(document.getElementById('loginForm'), function (d) {
      clearLoginNotifDismissals()
      window.location.href = (d && d.redirect) || LOGIN_URLS.files
    })
  }
})

// After a password sign-in on a phone: offer a fingerprint, face or PIN for next time.
async function offerQuickUnlock(box, offer, csrfToken) {
  if (!window.OneGyQuickUnlock || !offer) return
  // Signing in started a new session, so the token this page was rendered with is stale.
  if (csrfToken) document.querySelector('meta[name="csrf-token"]').content = csrfToken
  try { await OneGyQuickUnlock.offer(box, Object.assign({ leave: true }, offer)) } catch (e) {}
}

// Clear login-trigger notification dismissals from sessionStorage so they show again on re-login
function clearLoginNotifDismissals() {
  try { sessionStorage.removeItem('onegy_notif_dismissed_session') } catch (e) {}
  var keys = []
  for (var i = 0; i < sessionStorage.length; i++) {
    var k = sessionStorage.key(i)
    if (k && k.indexOf('dismissed_login_notif_') === 0) keys.push(k)
  }
  keys.forEach(function(k) { sessionStorage.removeItem(k) })
}

// Pending 2FA state — holds password/splitKeys in memory across the inline 2FA step
let pending2FA = null

// ─── Ahead of the submit ────────────────────────────────────────────
// The pre-login answer (salt) is fetched when the username field is left,
// keyed on the trimmed name the submit sends. Only on blur, not on typing
// pauses: partial names would spend the endpoint's 15/min per-IP budget. An
// answer serves one submit at most and only while fresh: the salt changes with
// the password, so a retry asks again.
const PRE_LOGIN_MAX_AGE = 120000
const preLoginCache = new Map()

function fetchPreLogin(username) {
  return fetch('/auth/pre-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': document.getElementById('csrf_token').value },
    body: JSON.stringify({ username })
  }).then(function(resp) {
    if (!resp.ok) throw new Error('LOGIN SERVICE TEMPORARILY UNAVAILABLE. REFRESH AND RETRY')
    return resp.json()
  })
}

function prefetchPreLogin() {
  const username = document.getElementById('username').value.trim()
  if (!username || preLoginCache.has(username)) return
  const entry = { at: Date.now(), promise: fetchPreLogin(username) }
  entry.promise.catch(function() { if (preLoginCache.get(username) === entry) preLoginCache.delete(username) })
  preLoginCache.set(username, entry)
}

function takePreLogin(username) {
  const entry = preLoginCache.get(username)
  preLoginCache.delete(username)
  if (!entry || Date.now() - entry.at > PRE_LOGIN_MAX_AGE) return fetchPreLogin(username)
  return entry.promise.catch(function() { return fetchPreLogin(username) })
}

document.getElementById('username').addEventListener('blur', prefetchPreLogin)

// The crypto worker's first start parses crypto.js again: start it while the
// password is typed. crypto.js has no warm-up call, and an empty encryption is
// its cheapest worker round trip. A password manager that fills both fields
// never focuses the password: its fill (input) or the username's blur (the
// click on Sign in) starts it then, alongside the pre-login request.
let cryptoWarmed = false
function warmCrypto() {
  if (cryptoWarmed || !window.OneGyCrypto || !window.crypto || !window.crypto.subtle) return
  cryptoWarmed = true
  OneGyCrypto.generateFileKey()
    .then(function(key) { return OneGyCrypto.encryptFileData(new ArrayBuffer(0), key) })
    .catch(function() {})
}
document.getElementById('password').addEventListener('focus', warmCrypto)
document.getElementById('password').addEventListener('input', warmCrypto)
document.getElementById('username').addEventListener('blur', warmCrypto)

// Helper: safely parse JSON from a fetch response — handles non-JSON errors
// (e.g. Flask-WTF CSRF failure returns HTML, which causes JSON.parse to throw
// a cryptic browser-specific error like "The string did not match the expected pattern")
async function safeParseJSON(response) {
  const ct = response.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    return await response.json()
  }
  // Non-JSON response — extract a meaningful error from the HTML/text body
  const text = await response.text()
  if (text.includes('CSRF')) {
    throw new Error('SESSION EXPIRED. PLEASE REFRESH THE PAGE AND TRY AGAIN')
  }
  throw new Error(response.status === 429 ? 'TOO MANY ATTEMPTS. PLEASE WAIT' : 'REQUEST FAILED. PLEASE REFRESH THE PAGE')
}

// ─── Login Flow ─────────────────────────────────────────────────────
document.getElementById('loginForm').addEventListener('submit', async function(e) {
  e.preventDefault()
  
  const btn = document.getElementById('loginBtn')
  const csrfToken = document.getElementById('csrf_token').value
  
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value
  
  if (!username || !password) return
  
  btn.disabled = true
  btn.textContent = 'Signing in…'
  
  try {
    // Step 0: Pre-login — get auth protocol version + salt.
    // Do not fall back to a raw-password POST: a v1 account would be
    // rejected and the failure counted toward captcha/lockout.
    let authTokenSalt = null
    let splitKeys = null
    let quickOffer = null
    let keyWarning = false
    const preData = await takePreLogin(username)
    if (!preData || preData.split_key_version !== 1) {
      throw new Error('LOGIN SERVICE TEMPORARILY UNAVAILABLE. REFRESH AND RETRY')
    }
    authTokenSalt = preData.auth_token_salt

    // Step 1: Derive auth credentials
    let loginPayload = { username }
    const captchaInput = document.getElementById('loginCaptcha')
    if (captchaInput && captchaInput.value.trim()) loginPayload.captcha = captchaInput.value.trim()
    try {
      if (typeof authTokenSalt !== 'string' || !authTokenSalt.trim() || !atob(authTokenSalt).length) throw new Error('INVALID SALT')
    } catch (saltErr) {
      throw new Error('LOGIN SERVICE TEMPORARILY UNAVAILABLE. REFRESH AND RETRY')
    }
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('SECURE LOGIN REQUIRES A MODERN HTTPS BROWSER WITH WEBCRYPTO ENABLED')
    }
    try {
      // Split-key: derive auth_token + wrapping_key from password (server never sees password)
      splitKeys = await OneGyCrypto.deriveAuthAndWrappingKeys(password, authTokenSalt)
      loginPayload.auth_token = splitKeys.authToken
    } catch (deriveErr) {
      console.warn('[LOGIN] Split-key derivation failed:', deriveErr)
      throw new Error('SECURE LOGIN REQUIRES A MODERN HTTPS BROWSER WITH WEBCRYPTO ENABLED')
    }

    // Step 2: Authenticate and get encrypted key material
    let response = await fetch(LOGIN_URLS.login, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrfToken
      },
      body: JSON.stringify(loginPayload)
    })
    
    let result = await safeParseJSON(response)

    if (!response.ok) {
      if (result.captcha_required) {
        const group = document.getElementById('loginCaptchaGroup')
        const img = document.getElementById('loginCaptchaImg')
        if (group) group.style.display = ''
        if (img) img.src = LOGIN_URLS.captcha + '?t=' + Date.now()
        if (captchaInput) { captchaInput.value = ''; captchaInput.focus() }
        throw new Error(result.error || 'CAPTCHA REQUIRED')
      }
      throw new Error(result.error || 'LOGIN FAILED')
    }

    // Check if 2FA is required — show inline TOTP input (no page redirect)
    if (result.two_factor_required) {
      // Store credentials in closure for use after TOTP verification
      pending2FA = { splitKeys, password }
      document.getElementById('loginBox').style.display = 'none'
      document.getElementById('twoFactorBox').style.display = 'block'
      document.getElementById('totp_code').focus()
      btn.disabled = false
      btn.textContent = 'Sign in'
      return
    }
    
    // Step 3: Unlock or setup E2EE keys
    if (window.crypto && window.crypto.subtle) {
      if (result.has_e2ee_keys) {
        // Existing user with keys — unlock them
        try {
          const { masterKey, privateKey } = await OneGyCrypto.unlockUserKeys(splitKeys.wrappingKey, {
            encryptedMasterKey: result.encrypted_master_key,
            masterKeyNonce: result.master_key_nonce,
            masterKeySalt: result.master_key_salt,
            encryptedPrivateKey: result.encrypted_private_key,
            privateKeyNonce: result.private_key_nonce
          })
          
          // Store keys in sessionStorage for this browser session
          await Promise.all([
            OneGyCrypto.storeMasterKeyInSession(masterKey),
            OneGyCrypto.storePrivateKeyInSession(privateKey)
          ])
          quickOffer = { authToken: splitKeys.authToken, masterKey, username }
          
          showFlash('ENCRYPTION KEYS UNLOCKED', 'success')
        } catch (keyErr) {
          console.error('[LOGIN] Key unlock failed:', keyErr)
          keyWarning = true
          showFlash('KEY UNLOCK FAILED. YOU MAY NEED TO RE-ENTER PASSWORD', 'error')
        }
      } else {
        // Existing user WITHOUT keys — generate and store them now
        let keyData = null
        let keysSaved = false
        try {
          keyData = await OneGyCrypto.setupUserKeys(password)
          
          // Send encrypted key material to server (use new CSRF token from login response)
          const csrfForKeys = result.csrf_token || document.getElementById('csrf_token').value
          const keyResp = await fetch(LOGIN_URLS.updateKeys, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'X-CSRFToken': csrfForKeys
            },
            body: JSON.stringify({
              encrypted_master_key: keyData.encryptedMasterKey,
              master_key_nonce: keyData.masterKeyNonce,
              master_key_salt: keyData.masterKeySalt,
              public_key: keyData.publicKey,
              encrypted_private_key: keyData.encryptedPrivateKey,
              private_key_nonce: keyData.privateKeyNonce,
              recovery_key_hash: keyData.recoveryKeyHash,
              recovery_wrapped_master_key: keyData.recoveryWrappedMasterKey,
              recovery_key_nonce: keyData.recoveryKeyNonce,
              auth_token: keyData.authToken,
              auth_salt: keyData.authSalt,
              current_auth_token: splitKeys.authToken
            })
          })
          
          const keyResult = await safeParseJSON(keyResp)
          if (!keyResp.ok || keyResult.success !== true) throw new Error(keyResult.error || 'FAILED TO SAVE ENCRYPTION KEYS')
          keysSaved = true

          await completeFirstTimeProvisioning(keyData)
          return  // Don't redirect yet — user must acknowledge recovery key
        } catch (keyErr) {
          console.error('[LOGIN] Key setup failed:', keyErr)
          if (keysSaved) {
            showFlash('Encryption keys were saved, but recovery setup is incomplete.', 'error')
            showProvisioningRetry(keyData)
            return
          }
          keyWarning = true
          showFlash('KEY SETUP FAILED. WILL RETRY ON NEXT LOGIN', 'error')
        }
      }
    }
    
    // Step 4: Redirect (after a moment only when a key error toast needs reading)
    await offerQuickUnlock(document.getElementById('loginBox'), quickOffer, result.csrf_token)
    clearLoginNotifDismissals()
    if (keyWarning) await new Promise(function(resolve) { setTimeout(resolve, 500) })
    window.location.href = result.redirect
    
  } catch (err) {
    console.error('[LOGIN]', err)
    showFlash(err.message || 'LOGIN FAILED', 'error')
    btn.disabled = false
    btn.textContent = 'Sign in'
    if (/INVALID/i.test(err.message || '')) {
      document.getElementById('password').setAttribute('aria-invalid', 'true')
      document.getElementById('password').focus()
    }
  }
})

// ─── Inline 2FA Verification ────────────────────────────────────────
document.getElementById('inlineTwoFactorForm').addEventListener('submit', async function(e) {
  e.preventDefault()

  const btn = document.getElementById('verifyBtn')
  const csrfToken = document.getElementById('csrf_token').value
  const totpCode = document.getElementById('totp_code').value.trim()

  if (!totpCode || totpCode.length !== 6) {
    showFlash('PLEASE ENTER A 6-DIGIT CODE', 'error')
    return
  }

  btn.disabled = true
  btn.textContent = 'Verifying…'

  try {
    const response = await fetch(LOGIN_URLS.verify2fa, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrfToken
      },
      body: JSON.stringify({ totp_code: totpCode })
    })

    const result = await safeParseJSON(response)

    if (!response.ok) {
      throw new Error(result.error || 'VERIFICATION FAILED')
    }
    let quickOffer = null
    let keyWarning = false

    // 2FA verified — now unlock E2EE keys using the in-memory wrapping key
    if (window.crypto && window.crypto.subtle && pending2FA) {
      if (result.has_e2ee_keys) {
        try {
          const { masterKey, privateKey } = await OneGyCrypto.unlockUserKeys(pending2FA.splitKeys.wrappingKey, {
            encryptedMasterKey: result.encrypted_master_key,
            masterKeyNonce: result.master_key_nonce,
            masterKeySalt: result.master_key_salt,
            encryptedPrivateKey: result.encrypted_private_key,
            privateKeyNonce: result.private_key_nonce
          })

          await Promise.all([
            OneGyCrypto.storeMasterKeyInSession(masterKey),
            OneGyCrypto.storePrivateKeyInSession(privateKey)
          ])
          quickOffer = { authToken: pending2FA.splitKeys.authToken, masterKey, username: document.getElementById('username').value.trim() }

          showFlash('ENCRYPTION KEYS UNLOCKED', 'success')
        } catch (keyErr) {
          console.error('[LOGIN] Key unlock failed after 2FA:', keyErr)
          keyWarning = true
          showFlash('KEY UNLOCK FAILED. YOU MAY NEED TO RE-ENTER PASSWORD', 'error')
        }
      } else if (!result.has_e2ee_keys) {
        // User without keys — generate and store them now
        let keyData = null
        let keysSaved = false
        try {
          keyData = await OneGyCrypto.setupUserKeys(pending2FA.password)

          const csrfForKeys = result.csrf_token || csrfToken
          const keyResp = await fetch(LOGIN_URLS.updateKeys, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'X-CSRFToken': csrfForKeys
            },
            body: JSON.stringify({
              encrypted_master_key: keyData.encryptedMasterKey,
              master_key_nonce: keyData.masterKeyNonce,
              master_key_salt: keyData.masterKeySalt,
              public_key: keyData.publicKey,
              encrypted_private_key: keyData.encryptedPrivateKey,
              private_key_nonce: keyData.privateKeyNonce,
              recovery_key_hash: keyData.recoveryKeyHash,
              recovery_wrapped_master_key: keyData.recoveryWrappedMasterKey,
              recovery_key_nonce: keyData.recoveryKeyNonce,
              auth_token: keyData.authToken,
              auth_salt: keyData.authSalt,
              current_auth_token: pending2FA.splitKeys.authToken
            })
          })

          const keyResult = await safeParseJSON(keyResp)
          if (!keyResp.ok || keyResult.success !== true) throw new Error(keyResult.error || 'FAILED TO SAVE ENCRYPTION KEYS')
          keysSaved = true

          pending2FA = null
          await completeFirstTimeProvisioning(keyData)
          return  // Don't redirect yet — user must acknowledge recovery key
        } catch (keyErr) {
          console.error('[LOGIN] Key setup failed after 2FA:', keyErr)
          if (keysSaved) {
            pending2FA = null
            showFlash('Encryption keys were saved, but recovery setup is incomplete.', 'error')
            showProvisioningRetry(keyData)
            return
          }
          keyWarning = true
          showFlash('KEY SETUP FAILED. WILL RETRY ON NEXT LOGIN', 'error')
        }
      }
    }

    // Clear sensitive data
    pending2FA = null

    // Redirect to dashboard (after a moment only when a key error toast needs reading)
    await offerQuickUnlock(document.getElementById('twoFactorBox'), quickOffer, result.csrf_token)
    clearLoginNotifDismissals()
    if (keyWarning) await new Promise(function(resolve) { setTimeout(resolve, 500) })
    window.location.href = result.redirect || LOGIN_URLS.files

  } catch (err) {
    console.error('[2FA]', err)
    showFlash(err.message || 'VERIFICATION FAILED', 'error')
    btn.disabled = false
    btn.textContent = 'Verify'
    document.getElementById('totp_code').value = ''
    document.getElementById('totp_code').setAttribute('aria-invalid', 'true')
    document.getElementById('totp_code').focus()
  }
})

// Auto-submit when 6 digits entered
document.getElementById('totp_code').addEventListener('input', function() {
  this.removeAttribute('aria-invalid')
  this.value = this.value.replace(/[^0-9]/g, '')
  if (this.value.length === 6) {
    document.getElementById('verifyBtn').click()
  }
})

// Cancel 2FA — go back to login form
function cancelTwoFactor() {
  pending2FA = null
  document.getElementById('twoFactorBox').style.display = 'none'
  document.getElementById('loginBox').style.display = 'block'
  document.getElementById('totp_code').value = ''
  document.getElementById('password').value = ''
  document.getElementById('username').focus()
}

// ─── Recovery Flow ──────────────────────────────────────────────────
function showRecoveryForm() {
  document.getElementById('loginBox').style.display = 'none'
  document.getElementById('twoFactorBox').style.display = 'none'
  document.getElementById('recoveryForm').style.display = 'block'
  pending2FA = null
}

function showLoginForm() {
  document.getElementById('recoveryForm').style.display = 'none'
  document.getElementById('twoFactorBox').style.display = 'none'
  document.getElementById('loginBox').style.display = 'block'
}

document.getElementById('recoveryFormInner').addEventListener('submit', async function(e) {
  e.preventDefault()
  
  const btn = document.getElementById('recoveryBtn')
  const csrfToken = document.getElementById('csrf_token').value
  
  const username = document.getElementById('rec_username').value.trim()
  const recoveryKeyB64 = document.getElementById('rec_key').value.trim()
  const newPassword = document.getElementById('rec_new_password').value
  const confirmPassword = document.getElementById('rec_confirm_password').value
  
  if (!username || !recoveryKeyB64 || !newPassword) return
  if (newPassword !== confirmPassword) {
    setFieldError('rec_confirm_password', 'Passwords do not match')
    showFlash('PASSWORDS DO NOT MATCH', 'error')
    return
  }
  // AUDIT FIX M10: keep the client-side policy identical across
  // register / change-password / recovery — the server can only sanity-check the
  // ASSERTED length (it never sees the password), so these bounds are the real
  // enforcement for honest clients and must not drift between the three paths.
  if (newPassword.length < 6) {
    showFlash('PASSWORD MUST BE AT LEAST 6 CHARACTERS', 'error')
    return
  }
  if (newPassword.length > 1024) {
    showFlash('PASSWORD MUST BE 1024 CHARACTERS OR LESS', 'error')
    return
  }
  
  btn.disabled = true
  btn.textContent = 'Resetting…'
  
  try {
    // Step 1 (AUDIT FIX M3): prove the CURRENT recovery key and fetch its
    // server-stored wrap of the master key.
    const currentMasterKey = await OneGyCrypto.importRecoveryKey(recoveryKeyB64)
    const currentRecoveryKeyHash = await OneGyCrypto.hashMasterKey(currentMasterKey)
    
    const challengeResp = await fetch(LOGIN_URLS.recoveryChallenge, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrfToken
      },
      body: JSON.stringify({
        username: username,
        recovery_key_hash: currentRecoveryKeyHash
      })
    })
    const challenge = await safeParseJSON(challengeResp)
    if (!challengeResp.ok) {
      throw new Error(challenge.error || 'RECOVERY FAILED')
    }
    
    // Resolve the master key. Legacy accounts (whose recovery key IS the master
    // key) import it directly; decoupled accounts decrypt the server-stored wrap.
    const masterKey = challenge.legacy_recovery_key
      ? currentMasterKey
      : await OneGyCrypto.unwrapMasterKeyWithRecoveryKey(
          recoveryKeyB64,
          challenge.recovery_wrapped_master_key,
          challenge.recovery_key_nonce
        )
    
    // Step 2 (AUDIT FIX M3): generate a FRESH recovery key wrapping the SAME
    // master key. The compromised key stops working the moment this commits.
    const rotated = await OneGyCrypto.createRecoveryKeyWrap(masterKey)
    
    // Step 3: derive split-key credentials from new password and re-wrap
    const newSplitKeys = await OneGyCrypto.deriveAuthAndWrappingKeys(newPassword)
    const rewrapped = await OneGyCrypto.wrapMasterKey(masterKey, newSplitKeys.wrappingKey, newSplitKeys.salt)
    
    const response = await fetch(LOGIN_URLS.recoveryLogin, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrfToken
      },
      body: JSON.stringify({
        username: username,
        recovery_key_hash: currentRecoveryKeyHash,
        new_recovery_key_hash: rotated.recoveryKeyHash,
        new_recovery_wrapped_master_key: rotated.recoveryWrappedMasterKey,
        new_recovery_key_nonce: rotated.recoveryKeyNonce,
        new_password_length: newPassword.length,
        auth_token: newSplitKeys.authToken,
        auth_salt: newSplitKeys.salt,
        encrypted_master_key: rewrapped.encryptedMasterKey,
        master_key_nonce: rewrapped.nonce,
        master_key_salt: rewrapped.salt
      })
    })
    
    const result = await safeParseJSON(response)
    
    if (!response.ok) {
      throw new Error(result.error || 'RECOVERY FAILED')
    }
    
    // AUDIT FIX M3: a NEW recovery key is active now — it must be shown, and the
    // old one (possibly compromised) no longer works.
    showFlash('ACCOUNT RECOVERED! SAVE YOUR NEW RECOVERY KEY, THEN LOGIN WITH YOUR NEW PASSWORD', 'success')
    showRecoveryKeyModal(rotated.recoveryKey, LOGIN_URLS.login)
    
  } catch (err) {
    console.error('[RECOVERY]', err)
    showFlash(err.message || 'RECOVERY FAILED', 'error')
  }
  
  btn.disabled = false
  btn.textContent = 'Reset password'
})

;['username', 'password'].forEach(function(id) {
  document.getElementById(id).addEventListener('input', function() { document.getElementById('password').removeAttribute('aria-invalid') })
})

function setFieldError(id, msg) {
  const input = document.getElementById(id)
  const err = document.getElementById(id + 'Error')
  if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid')
  if (err) err.textContent = msg || ''
}
;['rec_new_password', 'rec_confirm_password'].forEach(function(id) {
  document.getElementById(id).addEventListener('input', function() { setFieldError('rec_confirm_password', '') })
})

// ─── Recovery Key Modal (shown after first-time key setup) ─────────
let pendingRedirect = null

async function completeFirstTimeProvisioning(keyData) {
  // AUDIT FIX M3: show the INDEPENDENT recovery key (only it recovers the
  // account now); fall back for legacy keyData shapes.
  const recoveryKeyB64 = keyData.recoveryKey || await OneGyCrypto.exportRecoveryKey(keyData._masterKey)
  let sessionReady = true
  try {
    await OneGyCrypto.storeMasterKeyInSession(keyData._masterKey)
    await OneGyCrypto.storePrivateKeyInSession(keyData._privateKey)
  } catch (sessionErr) {
    sessionReady = false
    console.warn('[LOGIN] Keys saved but session key storage failed:', sessionErr)
    showFlash('Encryption keys saved. Save the recovery key, then sign in again in this browser.', 'error')
  }
  if (sessionReady) showFlash('ENCRYPTION KEYS READY', 'success')
  showRecoveryKeyModal(recoveryKeyB64)
}

function showProvisioningRetry(keyData) {
  let modal = document.getElementById('provisioningRetryModal')
  if (!modal) {
    modal = document.createElement('div')
    modal.id = 'provisioningRetryModal'
    modal.className = 'auth-dialog'
    modal.innerHTML = '<div class="auth-dialog-panel" role="alertdialog" aria-modal="true" aria-labelledby="provRetryTitle" aria-describedby="provRetryText"><h2 class="auth-dialog-title" id="provRetryTitle">Recovery setup incomplete</h2><p class="auth-dialog-text" id="provRetryText">Your encryption keys are saved, but your recovery key has not been shown yet. Do not leave this page.</p><button type="button" id="retryProvisioningBtn" class="rd-btn rd-btn-primary rd-btn-lg auth-submit">Retry recovery setup</button></div>'
    document.body.appendChild(modal)
  }
  modal.style.display = 'flex'
  document.getElementById('retryProvisioningBtn').onclick = async function() {
    this.disabled = true
    try {
      await completeFirstTimeProvisioning(keyData)
      modal.remove()
    } catch (err) {
      console.error('[LOGIN] Recovery setup retry failed:', err)
      showFlash('Recovery setup is still incomplete. Keep this page open and retry.', 'error')
      this.disabled = false
    }
  }
}

function showRecoveryKeyModal(recoveryKeyB64, redirectUrl) {
  // AUDIT FIX M3: optional redirect for flows that are NOT signed in (account
  // recovery ends at the login page, not the drive).
  pendingRedirect = redirectUrl || LOGIN_URLS.files
  
  // Create modal if it doesn't exist
  let modal = document.getElementById('recoveryKeyModal')
  if (!modal) {
    modal = document.createElement('div')
    modal.id = 'recoveryKeyModal'
    modal.className = 'auth-dialog'
    modal.innerHTML = `
      <div class="auth-dialog-panel" role="alertdialog" aria-modal="true" aria-labelledby="recKeyTitle" aria-describedby="recKeyText">
        <span class="auth-mark is-accent" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg></span>
        <h2 class="auth-dialog-title" id="recKeyTitle">Save your recovery key</h2>
        <p class="auth-dialog-text" id="recKeyText">It is the only way back into your account if you forget your password. Keep it somewhere safe and private.</p>
        <div class="auth-key" id="recoveryKeyDisplay" data-update-hold></div>
        <div class="auth-dialog-row">
          <button type="button" class="rd-btn rd-btn-ghost" id="copyRecKeyBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span>Copy</span></button>
          <button type="button" class="rd-btn rd-btn-ghost" id="downloadRecKeyBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><span>Download</span></button>
        </div>
        <div class="rd-callout is-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg><div>This key will not be shown again.</div></div>
        <button type="button" class="rd-btn rd-btn-primary rd-btn-lg auth-submit" id="dismissRecKeyBtn">I have saved my recovery key</button>
      </div>
    `
    document.body.appendChild(modal)
    bindRecoveryModalButtons()
  }

  document.getElementById('recoveryKeyDisplay').textContent = recoveryKeyB64
  modal.style.display = 'flex'
  document.getElementById('copyRecKeyBtn').focus()
}

function copyRecoveryKey() {
  const key = document.getElementById('recoveryKeyDisplay').textContent
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(key).then(() => {
      const label = document.querySelector('#copyRecKeyBtn span')
      label.textContent = 'Copied'
      setTimeout(() => { label.textContent = 'Copy' }, 2000)
    })
  }
}

function downloadRecoveryKey() {
  const key = document.getElementById('recoveryKeyDisplay').textContent
  const blob = new Blob(['ONE.GY RECOVERY KEY\n\n' + key + '\n\nKEEP THIS FILE SAFE. DO NOT SHARE IT.\n'], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'onegy-recovery-key.txt'
  a.click()
  URL.revokeObjectURL(a.href)
}

function dismissRecoveryKeyModal() {
  const modal = document.getElementById('recoveryKeyModal')
  if (modal) modal.style.display = 'none'
  clearLoginNotifDismissals()
  if (pendingRedirect) window.location.href = pendingRedirect
}

function bindRecoveryModalButtons() {
  var copyBtn = document.getElementById('copyRecKeyBtn')
  var dlBtn = document.getElementById('downloadRecKeyBtn')
  var dismissBtn = document.getElementById('dismissRecKeyBtn')
  if (copyBtn) copyBtn.addEventListener('click', copyRecoveryKey)
  if (dlBtn) dlBtn.addEventListener('click', downloadRecoveryKey)
  if (dismissBtn) dismissBtn.addEventListener('click', dismissRecoveryKeyModal)
}

var _showRec = document.getElementById('showRecoveryLink')
if (_showRec) _showRec.addEventListener('click', function (e) { e.preventDefault(); showRecoveryForm() })
var _cancel2fa = document.getElementById('cancelTwoFactorLink')
if (_cancel2fa) _cancel2fa.addEventListener('click', function (e) { e.preventDefault(); cancelTwoFactor() })
var _showLogin = document.getElementById('showLoginLink')
if (_showLogin) _showLogin.addEventListener('click', function (e) { e.preventDefault(); showLoginForm() })
var _loginCaptchaRefresh = document.getElementById('loginCaptchaRefresh')
if (_loginCaptchaRefresh) _loginCaptchaRefresh.addEventListener('click', function () {
  var img = document.getElementById('loginCaptchaImg')
  if (img) img.src = LOGIN_URLS.captcha + '?t=' + Date.now()
})

// showFlash is inherited from base.html's unified toast system
