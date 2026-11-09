// Popover menu anchored to a button (row menus). Arrow keys move, Escape closes.
import { h, icon } from './dom.js';

let open = null;

function closeMenu() {
  if (!open) return;
  open.el.remove();
  document.removeEventListener('pointerdown', open.outside, true);
  const { anchor } = open;
  open = null;
  anchor.setAttribute('aria-expanded', 'false');
  anchor.focus();
}

// items: [{label, icon, run, danger, disabled}] or 'sep'
export function openMenu(anchor, items) {
  closeMenu();
  const buttons = [];
  const el = h('div', { class: 'rd-cmenu', role: 'menu' },
    items.map((item) => {
      if (item === 'sep') return h('div', { class: 'rd-cmenu-sep', role: 'separator' });
      const b = h('button', {
        type: 'button',
        role: 'menuitem',
        class: `rd-cmenu-item${item.danger ? ' rd-cmenu-danger' : ''}`,
        disabled: item.disabled,
        onclick: () => { closeMenu(); item.run(); },
      }, item.icon ? icon(item.icon) : null, item.label);
      if (!item.disabled) buttons.push(b);
      return b;
    }));
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
  });
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + ht + 12 > window.innerHeight ? Math.max(8, r.top - ht - 4) : r.bottom + 4}px`;
  const outside = (e) => { if (!el.contains(e.target) && e.target !== anchor) closeMenu(); };
  document.addEventListener('pointerdown', outside, true);
  open = { el, anchor, outside };
  anchor.setAttribute('aria-expanded', 'true');
  const first = buttons.find((b) => !b.disabled);
  if (first) first.focus();
}

export { closeMenu };
