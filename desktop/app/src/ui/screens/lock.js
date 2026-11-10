// Lock screen (engine-ipc.md "App lock"). Shown over an empty site view while
// the app is locked; syncing inside this computer's sync folders goes on.
// The PIN when one is set and still valid, else the password; the password
// form can turn on a PIN for next time (opt-in). The main process closes the
// panel and signs the site in once the app is unlocked.
import { h, icon, clear, append, field, callout } from '../components/dom.js';
import { pinFields, pinUsable, pinRules, PIN_TRIES } from '../components/pin.js';
import { rpc, store, on, loadAccount } from '../store.js';

const ERRORS = {
  invalid_credentials: 'Wrong password.',
  offline: 'Could not reach one.gy. Check your connection and try again.',
  rate_limited: 'Too many attempts. Wait a minute, then try again.',
  app_locked: 'Your keys are unlocked, but one.gy could not be reached to unlock the app. Try again when you are online.',
};

export function mount(container) {
  let mode = pinUsable(store.account) ? 'pin' : 'password';
  let note = null; // why the password is needed
  const a0 = store.account || {};
  if (mode === 'password' && a0.pin_set) note = 'Your PIN has expired. Enter your password once and the PIN works again.';

  const body = h('div', { class: 'rd-panel-body' });
  append(container, h('div', { class: 'adm-narrow' },
    h('section', { class: 'rd-panel dk-lock' },
      h('header', { class: 'rd-panel-head' }, h('div', null,
        h('h2', { class: 'rd-panel-title' }, icon('lock'), ' ONE.GY is locked'),
        h('p', { class: 'rd-panel-sub' }, a0.locked
          ? 'Syncing waits until you unlock.'
          : 'Syncing keeps going in the background. Unlock to open your files, notes and everything else.'))),
      body)));

  let touched = false; // the user started typing: keep the form
  body.addEventListener('input', () => { touched = true; });

  function render() {
    clear(body);
    const a = store.account || {};
    const error = h('p', { class: 'rd-field-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'rd-btn rd-btn-primary' }, 'Unlock');
    const form = h('form', { class: 'dk-form', onsubmit: (e) => { e.preventDefault(); run(); } });
    let run;
    if (mode === 'pin') {
      const pin = h('input', {
        class: 'form-input dk-pin-input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 64, 'aria-label': 'PIN',
      });
      append(form, field('PIN', pin, a.username ? `Signed in as ${a.username}.` : null), error,
        h('div', { class: 'dk-btn-row' }, submit,
          h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => { mode = 'password'; note = null; render(); } }, 'Use my password instead')));
      run = async () => {
        if (!pin.value) return;
        submit.disabled = true;
        try {
          store.account = await rpc('account.appUnlock', { pin: pin.value });
        } catch (err) {
          pin.value = '';
          submit.disabled = false;
          if (err.code === 'invalid_pin') {
            const left = (await loadAccount().catch(() => a)).pin_attempts_left;
            error.textContent = left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left, then your password is needed.` : 'Wrong PIN.';
            pin.focus();
            return;
          }
          if (['pin_locked', 'pin_expired', 'pin_not_set', 'password_required'].includes(err.code)) {
            mode = 'password';
            note = {
              pin_locked: `${PIN_TRIES} wrong PINs in a row: the PIN was erased. Enter your password, then choose a new PIN.`,
              pin_expired: 'Your PIN has expired. Enter your password once and the PIN works again.',
              password_required: 'This computer needs your password once more.',
            }[err.code] || null;
            await loadAccount().catch(() => {});
            render();
            return;
          }
          error.textContent = ERRORS[err.code] || err.message;
        }
      };
      setTimeout(() => pin.focus());
    } else {
      const password = h('input', { class: 'form-input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
      // Opt-in: a PIN for next time, set with this same unlock. Only when the
      // engine knows there is none (with closed keys and no key store it cannot tell).
      const offer = !a.pin_set && !a.locked;
      const wantPin = h('input', { type: 'checkbox', class: 'rd-switch', role: 'switch' });
      const pinForm = pinFields();
      pinForm.el.hidden = true;
      wantPin.addEventListener('change', () => { pinForm.el.hidden = !wantPin.checked; });
      append(form,
        note ? callout('warn', 'lock', note) : null,
        field('Password', password, a.username ? `Your one.gy password for ${a.username}.` : null),
        offer ? h('label', { class: 'rd-field-row' },
          h('div', { class: 'rd-field-text' }, h('span', { class: 'rd-field-label' }, 'Unlock with a PIN from now on'),
            h('p', { class: 'rd-field-hint' }, pinRules(null))), wantPin) : null,
        offer ? pinForm.el : null,
        error, h('div', { class: 'dk-btn-row' }, submit));
      run = async () => {
        error.textContent = '';
        if (!password.value) return;
        const req = { password: password.value };
        try {
          if (offer && wantPin.checked) Object.assign(req, (({ pin, strict }) => ({ new_pin: pin, pin_strict: strict }))(pinForm.value()));
        } catch (err) {
          error.textContent = err.message;
          return;
        }
        submit.disabled = true;
        try {
          store.account = await rpc('account.unlock', req);
          if (store.account.app_locked) throw Object.assign(new Error(ERRORS.app_locked), { code: 'app_locked' });
        } catch (err) {
          submit.disabled = false;
          error.textContent = ERRORS[err.code] || err.message;
        } finally {
          password.value = '';
          pinForm.clear();
        }
      };
      setTimeout(() => password.focus());
    }
    append(body, form);
  }
  render();
  // The engine may learn the PIN state after this mounted (strict start).
  return on('account', () => {
    const want = pinUsable(store.account) ? 'pin' : 'password';
    if (!touched && want !== mode) {
      mode = want;
      note = null;
      render();
    }
  });
}
