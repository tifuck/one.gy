// The app's sign-in (main.js "plain" mode, opened when this computer is
// signed out): one sign-in for the app, the website and sync. It authorizes
// this computer (account.authorize, as the setup wizard does); the main
// process then signs the site in with a device ticket and the wizard goes on
// with the PIN and what to sync (onboarding). No way around it except
// "Continue without sync" when the server cannot do desktop sign-in.
import { h, icon, append, field } from '../components/dom.js';
import { toast, toastError } from '../components/toast.js';
import {
  rpc, bridge, appSettings, store, on, navigate, loadAccount,
} from '../store.js';
import { AUTH_ERRORS } from './wizard.js';

const DEFAULT_SERVER = 'https://one.gy';
const GRANT_WAIT_MS = 10000;

// Signed in, the engine reports the app locked until its first unlock grant
// arrives. Resolves once it has (or after GRANT_WAIT_MS: a real lock then
// shows the lock screen).
function unlocked() {
  return new Promise((resolve) => {
    if (!store.account || !store.account.app_locked) return resolve();
    let off = null;
    const done = () => { off(); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, GRANT_WAIT_MS);
    off = on('account', () => { if (!store.account || !store.account.app_locked) done(); });
    return undefined;
  });
}

export function mount(container) {
  const server = () => (store.app && store.app.server_url) || DEFAULT_SERVER;
  let showTotp = false;

  const username = h('input', {
    class: 'form-input', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 80,
  });
  const password = h('input', { class: 'form-input', type: 'password', autocomplete: 'current-password', id: 'dkSigninPassword' });
  const totp = h('input', { class: 'form-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8 });
  const totpField = field('Two-factor code', totp, 'From your authenticator app.');
  totpField.hidden = true;
  const serverInput = h('input', { class: 'form-input', type: 'url', value: server(), spellcheck: 'false' });
  const device = h('input', { class: 'form-input', value: (store.version && store.version.hostname) || '', maxlength: 80 });
  const more = h('details', { class: 'dk-details dk-signin-more' },
    h('summary', null, 'Server and computer name'),
    h('div', { class: 'dk-details-body' },
      field('Server', serverInput, 'Only change this for a self-hosted ONE.GY.'),
      field('Computer name', device, 'Shown in Devices on the website.')));
  const error = h('p', { class: 'rd-field-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'rd-btn rd-btn-primary rd-btn-lg dk-signin-submit' }, 'Sign in');
  const external = (label, p) => h('button', {
    type: 'button', class: 'dk-signin-link', onclick: () => bridge('openExternal', server() + p).catch(toastError),
  }, label);
  const fallback = h('p', { hidden: true },
    h('button', { type: 'button', class: 'dk-signin-link', onclick: () => navigate('close', { force: true }) }, 'Continue without sync'));

  async function run() {
    error.textContent = '';
    if (!username.value.trim() || !password.value) {
      error.textContent = 'Enter your username and password.';
      return;
    }
    if (!device.value.trim()) {
      more.open = true;
      error.textContent = 'Give this computer a name.';
      return;
    }
    submit.disabled = true;
    try {
      const url = serverInput.value.trim();
      if (url && url !== server()) store.app = await appSettings.set({ server_url: url });
      const req = {
        server: server(), username: username.value.trim(), password: password.value, device_name: device.value.trim(),
      };
      if (showTotp && totp.value.trim()) req.totp_code = totp.value.trim();
      store.account = await rpc('account.authorize', req);
    } catch (err) {
      submit.disabled = false;
      if (err.code === 'totp_required') {
        showTotp = true;
        totpField.hidden = false;
        totp.focus();
        error.textContent = 'Enter the code from your authenticator app.';
        return;
      }
      error.textContent = AUTH_ERRORS[err.code] || err.message;
      fallback.hidden = err.code !== 'server_error';
      return;
    }
    password.value = '';
    await loadAccount().catch(() => {});
    await unlocked();
    toast(`Signed in as ${store.account.username}`, 'success');
    navigate('wizard', { onboarding: true });
  }

  append(container, h('section', { class: 'dk-signin', 'aria-labelledby': 'dkSigninTitle' },
    h('span', { class: 'dk-signin-mark' }, icon('lock')),
    h('h1', { class: 'dk-signin-title', id: 'dkSigninTitle' }, 'Sign in to ONE.GY'),
    h('p', { class: 'dk-signin-sub' }, 'One sign-in for your files, notes and sync on this computer.'),
    h('form', { class: 'dk-signin-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); run(); } },
      field('Username', username),
      h('div', { class: 'rd-field' },
        h('div', { class: 'dk-signin-row' },
          h('label', { class: 'rd-field-label', for: password.id }, 'Password'),
          external('Forgot your password?', '/login')),
        password),
      totpField, more, error, submit),
    h('div', { class: 'dk-signin-foot' },
      h('p', null, 'New to ONE.GY? ', external('Create an account', '/register')),
      fallback)));
  username.focus();
}
