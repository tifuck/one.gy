// Tiny DOM helpers. Text always goes in as text nodes; only trusted constant
// SVG markup (icons.js, nav.js) is ever parsed as HTML.
import { ICONS } from './icons.js';

// h('button', {class: 'x', onclick: fn, disabled: true}, 'text', node, [nodes])
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

// Like Element.append, but skips null/undefined/false and flattens arrays.
export function append(el, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export const fill = (el, ...children) => append(clear(el), children);

export function icon(name, cls) {
  const span = document.createElement('span');
  span.className = `dk-icon${cls ? ` ${cls}` : ''}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || ICONS.dot;
  return span;
}

// Constant SVG markup as an element (no wrapper), for site markup that styles the svg itself.
export function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstElementChild;
}

// The site's page title row (admin console: .rd-page-head.adm-head).
export function pageHead(title, sub, ...actions) {
  return h('header', { class: 'rd-page-head adm-head' },
    h('h1', { class: 'rd-page-title' }, title),
    sub ? h('p', { class: 'rd-page-sub' }, sub) : null,
    actions.length ? h('div', { class: 'rd-page-actions' }, actions) : null);
}

let uid = 0;
export const nextId = (prefix) => `${prefix}-${++uid}`;

// Labelled control helpers matching the .rd-field / .rd-field-row primitives.
export function field(label, control, hint) {
  const id = control.id || (control.id = nextId('f'));
  return h('div', { class: 'rd-field' },
    h('label', { class: 'rd-field-label', for: id }, label),
    control,
    hint ? h('p', { class: 'rd-field-hint' }, hint) : null,
    h('p', { class: 'rd-field-error', 'aria-live': 'polite' }));
}

export function row(label, hint, control) {
  const id = control.id || (control.id = nextId('r'));
  return h('div', { class: 'rd-field-row' },
    h('div', { class: 'rd-field-text' },
      h('label', { class: 'rd-field-label', for: id }, label),
      hint ? h('p', { class: 'rd-field-hint' }, hint) : null),
    control);
}

export function switchInput(checked, onchange) {
  return h('input', { type: 'checkbox', class: 'rd-switch', role: 'switch', checked, onchange: (e) => onchange(e.target.checked) });
}

export function select(options, value, onchange) {
  return h('select', { class: 'form-input', onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
}

export function callout(kind, iconName, ...content) {
  return h('div', { class: `rd-callout${kind ? ` is-${kind}` : ''}` }, icon(iconName), h('div', null, ...content));
}
