// The app lock PIN (engine-ipc.md "App lock"): opt-in, it unlocks the app
// instead of the password, but the server only accepts it for a while after
// the password was last entered on this computer, and erases it after five
// wrong tries in a row. Then the password is needed once.
import { h, field, row, switchInput } from './dom.js';
import { openDialog } from './dialog.js';
import { toast } from './toast.js';
import { dateTime } from './format.js';
import { rpc, store, emit, loadAccount } from '../store.js';

export const PIN_MIN = 4;
export const PIN_MAX = 16;
export const PIN_TRIES = 5;

// A PIN the server would still take (set and not past its lifetime).
export function pinUsable(a) {
  return Boolean(a && a.pin_set && (!a.pin_expires_at || Date.parse(a.pin_expires_at) > Date.now()));
}

export function pinRules(a) {
  const until = a && a.pin_set && a.pin_expires_at ? ` Your PIN works until ${dateTime(a.pin_expires_at)}.` : '';
  return `The PIN works for a limited time after you last entered your password here, and ${PIN_TRIES} wrong tries in a row erase it. Either way you enter your password once and keep going.${until}`;
}

// "Caps Lock is on" under the inputs while it is (PINs and passwords are case-sensitive).
export function capsHint(...inputs) {
  const hint = h('p', { class: 'rd-field-hint', role: 'status', hidden: true }, 'Caps Lock is on.');
  const check = (e) => { if (e.getModifierState) hint.hidden = !e.getModifierState('CapsLock'); };
  for (const input of inputs) {
    input.addEventListener('keydown', check);
    input.addEventListener('keyup', check);
  }
  return hint;
}

// Who is changing the PIN: the current PIN while it still works, else (or on
// request) the password. value() throws when empty.
export function currentFields(a) {
  let usePin = pinUsable(a);
  const input = h('input', { class: 'form-input', type: 'password', autocomplete: 'off', maxlength: 1024 });
  const el = h('div', { class: 'dk-form' });
  const render = () => {
    input.value = '';
    input.setAttribute('autocomplete', usePin ? 'off' : 'current-password');
    el.replaceChildren(field(usePin ? 'Current PIN' : 'Your one.gy password', input), capsHint(input),
      pinUsable(a) ? h('button', { type: 'button', class: 'rd-btn rd-btn-ghost rd-btn-sm', onclick: () => { usePin = !usePin; render(); input.focus(); } },
        usePin ? 'Use my password instead' : 'Use my PIN instead') : null);
  };
  render();
  return {
    el,
    focus: () => input.focus(),
    clear: () => { input.value = ''; },
    value() {
      if (!input.value) throw new Error(usePin ? 'Enter your current PIN.' : 'Enter your password.');
      return usePin ? { current_pin: input.value } : { password: input.value };
    },
  };
}

// PIN + confirmation (+ the strict switch); value() throws on a bad entry.
export function pinFields({ strict = false } = {}) {
  const pin = h('input', { class: 'form-input', type: 'password', autocomplete: 'new-password', maxlength: PIN_MAX });
  const again = h('input', { class: 'form-input', type: 'password', autocomplete: 'new-password', maxlength: PIN_MAX });
  let strictOn = strict;
  const el = h('div', { class: 'dk-form' },
    field('New PIN', pin, `${PIN_MIN} to ${PIN_MAX} letters or digits, case-sensitive. Not your account password, and nothing easy like 1234 or 1111.`),
    field('Repeat the PIN', again), capsHint(pin, again),
    row('Also ask for the PIN after a restart', 'Stronger: syncing then waits after every restart until you unlock. Off: syncing starts on its own and the PIN only opens the app.',
      switchInput(strict, (v) => { strictOn = v; })));
  return {
    el,
    focus: () => pin.focus(),
    clear: () => { pin.value = ''; again.value = ''; },
    value() {
      if (!new RegExp(`^[A-Za-z0-9]{${PIN_MIN},${PIN_MAX}}$`).test(pin.value)) throw new Error(`The PIN must be ${PIN_MIN} to ${PIN_MAX} letters or digits.`);
      if (pin.value !== again.value) throw new Error('The two PINs differ.');
      return { pin: pin.value, strict: strictOn };
    },
  };
}

// Set or change the PIN (the app is unlocked; the current PIN or the password
// confirms it). Resolves true when saved.
export function pinDialog({ title = 'Unlock with a PIN', strict = false } = {}) {
  return new Promise((resolve) => {
    const cur = currentFields(store.account);
    const f = pinFields({ strict });
    let saved = false;
    openDialog({
      title,
      body: [h('p', null, 'Use a PIN instead of your password to unlock ONE.GY on this computer.'), h('p', { class: 'rd-field-hint' }, pinRules(null)), cur.el, f.el],
      onClose: () => resolve(saved),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save PIN',
          kind: 'primary',
          run: async () => {
            const who = cur.value();
            const { pin, strict: s } = f.value();
            try {
              store.account = await rpc('account.setPin', { pin, strict: s, ...who });
            } catch (err) {
              cur.clear();
              throw await pinError(err);
            } finally {
              f.clear();
            }
            emit('account');
            saved = true;
            toast('PIN saved. Use it to unlock ONE.GY on this computer.', 'success');
          },
        },
      ],
    });
    cur.focus();
  });
}

// Remove the PIN, confirmed with the current PIN or the password. Resolves true when removed.
export function removePinDialog() {
  return new Promise((resolve) => {
    const cur = currentFields(store.account);
    let removed = false;
    openDialog({
      title: 'Remove the PIN?',
      body: [h('p', null, 'ONE.GY then asks for your password whenever it is locked.'), cur.el],
      onClose: () => resolve(removed),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Remove PIN',
          kind: 'danger',
          run: async () => {
            try {
              store.account = await rpc('account.removePin', cur.value());
            } catch (err) {
              cur.clear();
              throw await pinError(err);
            }
            emit('account');
            removed = true;
            toast('PIN removed', 'success');
          },
        },
      ],
    });
    cur.focus();
  });
}

// A refused current PIN or password, in words (tries left, PIN erased).
async function pinError(err) {
  if (err.code === 'invalid_pin') {
    const left = (await loadAccount().catch(() => store.account || {})).pin_attempts_left;
    return new Error(`Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before it is erased.`);
  }
  if (err.code === 'pin_locked') {
    await loadAccount().catch(() => {});
    return new Error(`${PIN_TRIES} wrong PINs in a row: the PIN was erased and ONE.GY locked.`);
  }
  if (err.code === 'invalid_credentials') return new Error('Wrong password.');
  return err;
}

// When five wrong PINs erased the PIN (and nobody set a new one since), in words.
export function pinErasedNote(a) {
  if (!a || a.pin_set || !a.pin_erased_at) return null;
  return `Your PIN was erased on ${dateTime(a.pin_erased_at)} after ${PIN_TRIES} wrong tries. If that wasn't you, someone tried to unlock this computer: change your one.gy password.`;
}

export function pinSummary(a) {
  if (a && !a.pin_set && a.pin_erased_at) return `Off: erased on ${dateTime(a.pin_erased_at)} after ${PIN_TRIES} wrong tries. Set up a new PIN to use one again.`;
  if (!a || !a.pin_set) return 'Off. ONE.GY asks for your password to unlock.';
  if (!pinUsable(a)) return 'Expired. Enter your password once and the PIN works again.';
  return `On${a.pin_strict ? ', also after a restart' : ''}. Works until ${dateTime(a.pin_expires_at)}.`;
}

// ---- System unlock: Windows Hello (Windows) or a fingerprint (Linux, fprintd) ----
export const SYSTEM_LABEL = { hello: 'Windows Hello', fingerprint: 'your fingerprint' };

// On, and within the same lifetime as the PIN (password entered recently enough).
export function systemUsable(a) {
  return Boolean(a && a.system_unlock && (!a.pin_expires_at || Date.parse(a.pin_expires_at) > Date.now()));
}

export function systemSummary(a) {
  const label = SYSTEM_LABEL[a.system_unlock || a.system_unlock_available];
  if (!a.system_unlock) return `Off. Unlock with ${label} instead of a PIN or password.`;
  if (!systemUsable(a)) return 'Expired. Enter your password once and it works again.';
  return `On. Works until ${dateTime(a.pin_expires_at)}; ${PIN_TRIES} failed unlocks in a row (PIN or ${label}) turn it off.`;
}

// A failed system unlock, in words; null = nothing to say (cancelled).
export async function systemError(err) {
  switch (err.code) {
    case 'cancelled': return null;
    case 'no_match':
    case 'system_unlock_failed': {
      const left = (await loadAccount().catch(() => store.account || {})).pin_attempts_left;
      const what = err.code === 'no_match' ? 'Fingerprint not recognized.' : 'Windows Hello could not be verified.';
      return left > 0 ? `${what} ${left} ${left === 1 ? 'try' : 'tries'} left, then your password is needed.` : what;
    }
    case 'unavailable': return 'This computer has no Windows Hello or enrolled fingerprint right now.';
    default: return err.message;
  }
}

// Turn system unlock on, confirmed with the current PIN or the password.
export function systemUnlockDialog() {
  const a = store.account || {};
  const label = SYSTEM_LABEL[a.system_unlock_available];
  return new Promise((resolve) => {
    const cur = currentFields(a);
    let saved = false;
    openDialog({
      title: `Unlock with ${label}`,
      body: [
        h('p', null, a.system_unlock_available === 'hello'
          ? 'Windows asks you to verify with your face, fingerprint or Windows Hello PIN. one.gy checks the result.'
          : 'Touch the fingerprint reader when asked. A match releases a key kept in this computer\u2019s key store, so programs running as you could read that key.'),
        h('p', { class: 'rd-field-hint' }, `It works for as long as your PIN would, and ${PIN_TRIES} failed unlocks in a row (any mix of PIN and ${label}) turn both off.`),
        cur.el],
      onClose: () => resolve(saved),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Turn on',
          kind: 'primary',
          run: async () => {
            try {
              store.account = await rpc('account.enableSystemUnlock', cur.value());
            } catch (err) {
              cur.clear();
              if (['invalid_pin', 'pin_locked', 'invalid_credentials'].includes(err.code)) throw await pinError(err);
              const msg = await systemError(err);
              if (msg === null) return true;
              throw new Error(msg);
            }
            emit('account');
            saved = true;
            toast(`Unlock with ${label} is on.`, 'success');
          },
        },
      ],
    });
    cur.focus();
  });
}
