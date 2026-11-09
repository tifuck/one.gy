// Short status messages at the bottom of the window.
import { h } from './dom.js';

let container = null;

export function toast(message, kind = 'info', ms = 3600) {
  if (!container) {
    container = h('div', { class: 'toast-container', role: 'status', 'aria-live': 'polite' });
    document.body.append(container);
  }
  const el = h('div', { class: `toast-message toast-${kind}` }, message);
  container.append(el);
  setTimeout(() => el.remove(), ms);
}

export const toastError = (err) => toast(err && err.message ? err.message : String(err), 'error', 6000);
