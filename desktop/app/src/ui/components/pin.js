// The app lock PIN (engine-ipc.md "App lock"): opt-in, it unlocks the app
// instead of the password, but the server only accepts it for a while after
// the password was last entered on this computer, and erases it after five
// wrong tries in a row. Then the password is needed once.
import { h, field, row, switchInput } from './dom.js';
import { openDialog } from './dialog.js';
import { toast } from './toast.js';
import { dateTime } from './format.js';
import { rpc, store, emit } from '../store.js';

export const PIN_MIN = 6;
export const PIN_TRIES = 5;

// A PIN the server would still take (set and not past its lifetime).
export function pinUsable(a) {
  return Boolean(a && a.pin_set && (!a.pin_expires_at || Date.parse(a.pin_expires_at) > Date.now()));
}

export function pinRules(a) {
  const until = a && a.pin_set && a.pin_expires_at ? ` Your PIN works until ${dateTime(a.pin_expires_at)}.` : '';
  return `The PIN works for a limited time after you last entered your password here, and ${PIN_TRIES} wrong tries in a row erase it. Either way you enter your password once and keep going.${until}`;
}

// PIN + confirmation (+ the strict switch); value() throws on a bad entry.
export function pinFields({ strict = false } = {}) {
  const pin = h('input', { class: 'form-input', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: 64 });
  const again = h('input', { class: 'form-input', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: 64 });
  let strictOn = strict;
  const el = h('div', { class: 'dk-form' },
    field('New PIN', pin, `At least ${PIN_MIN} digits or characters. Not your account password.`),
    field('Repeat the PIN', again),
    row('Also ask for the PIN after a restart', 'Stronger: syncing then waits after every restart until you unlock. Off: syncing starts on its own and the PIN only opens the app.',
      switchInput(strict, (v) => { strictOn = v; })));
  return {
    el,
    focus: () => pin.focus(),
    clear: () => { pin.value = ''; again.value = ''; },
    value() {
      if ([...pin.value].length < PIN_MIN) throw new Error(`The PIN needs at least ${PIN_MIN} characters.`);
      if (pin.value !== again.value) throw new Error('The two PINs differ.');
      return { pin: pin.value, strict: strictOn };
    },
  };
}

// Set or change the PIN (the app is unlocked). Resolves true when saved.
export function pinDialog({ title = 'Unlock with a PIN', strict = false } = {}) {
  return new Promise((resolve) => {
    const f = pinFields({ strict });
    let saved = false;
    openDialog({
      title,
      body: [h('p', null, 'Use a PIN instead of your password to unlock ONE.GY on this computer.'), h('p', { class: 'rd-field-hint' }, pinRules(null)), f.el],
      onClose: () => resolve(saved),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save PIN',
          kind: 'primary',
          run: async () => {
            const { pin, strict: s } = f.value();
            try {
              store.account = await rpc('account.setPin', { pin, strict: s });
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
    f.focus();
  });
}

export function pinSummary(a) {
  if (!a || !a.pin_set) return 'Off. ONE.GY asks for your password to unlock.';
  if (!pinUsable(a)) return 'Expired. Enter your password once and the PIN works again.';
  return `On${a.pin_strict ? ', also after a restart' : ''}. Works until ${dateTime(a.pin_expires_at)}.`;
}
