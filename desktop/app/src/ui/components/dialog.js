// Modal dialogs on the native <dialog> element (focus trap + Escape for free).
import { h, icon, field } from './dom.js';

// actions: [{label, kind: 'primary'|'danger'|'ghost', run: async () => keepOpen?}]
// A run() that throws shows the message in the dialog and keeps it open.
export function openDialog({ title, body, actions = [], wide = false, onClose }) {
  const error = h('p', { class: 'rd-field-error', role: 'alert' });
  const buttons = actions.map((a) => h('button', {
    type: 'button',
    class: `rd-btn rd-btn-${a.kind || 'ghost'}`,
    onclick: async () => {
      error.textContent = '';
      setBusy(true);
      try {
        const keepOpen = a.run ? await a.run() : false;
        if (!keepOpen) close();
      } catch (err) {
        error.textContent = err.message || String(err);
      } finally {
        setBusy(false);
      }
    },
  }, a.label));
  const closeBtn = h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': 'Close', onclick: () => close() }, icon('x'));
  const el = h('dialog', { class: `rd-dialog${wide ? ' is-wide' : ''}`, 'aria-label': title },
    h('header', { class: 'rd-dialog-head' }, h('h2', { class: 'rd-dialog-title' }, title), closeBtn),
    h('div', { class: 'rd-dialog-body' }, body, error),
    buttons.length ? h('footer', { class: 'rd-dialog-foot' }, buttons) : null);

  function setBusy(busy) {
    for (const b of buttons) b.disabled = busy;
  }
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    el.close();
    el.remove();
    if (onClose) onClose();
  }
  el.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(el);
  el.showModal();
  return { el, close, setBusy, buttons, error };
}

// Resolves true on confirm. requireText: the user must type it exactly.
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, requireText = null, extra = null }) {
  return new Promise((resolve) => {
    let result = false;
    const input = requireText ? h('input', { class: 'form-input', autocomplete: 'off', spellcheck: 'false' }) : null;
    const body = [
      h('p', null, message),
      extra,
      input ? field(`Type "${requireText}" to confirm`, input) : null,
    ];
    const dlg = openDialog({
      title,
      body,
      onClose: () => resolve(result),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          run: () => {
            if (input && input.value.trim() !== requireText) throw new Error(`Type "${requireText}" exactly to continue.`);
            result = true;
          },
        },
      ],
    });
    if (input) {
      const confirmBtn = dlg.buttons[1];
      confirmBtn.disabled = true;
      input.addEventListener('input', () => { confirmBtn.disabled = input.value.trim() !== requireText; });
      input.focus();
    }
  });
}

// Resolves the entered text, or null.
export function promptDialog({ title, label, value = '', confirmLabel = 'Save', hint }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'form-input', value, spellcheck: 'false' });
    openDialog({
      title,
      body: field(label, input, hint),
      onClose: () => resolve(result),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: confirmLabel,
          kind: 'primary',
          run: () => {
            if (!input.value.trim()) throw new Error('Enter a value.');
            result = input.value.trim();
          },
        },
      ],
    });
    input.focus();
    input.select();
  });
}
