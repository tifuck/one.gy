// Transfers (plan 10.4): tabs Active / Queued / Completed / Failed, per-item
// pause/resume and cancel (manual transfers only), global pause and clear.
import {
  h, icon, clear, append, fill, pageHead,
} from '../components/dom.js';
import { toastError } from '../components/toast.js';
import { openMenu } from '../components/menu.js';
import { manualUpload, manualDownload } from '../components/manual.js';
import {
  bytes, percent, basename, ago, transferStatus, transferWaits,
} from '../components/format.js';
import { rpc, store, on, loadTransfers } from '../store.js';

const TABS = [
  { id: 'active', label: 'Active', empty: 'No active transfers', match: (t) => t.state === 'active' || t.state === 'paused' },
  { id: 'queued', label: 'Queued', empty: 'Nothing queued', match: (t) => t.state === 'queued' },
  { id: 'done', label: 'Completed', empty: 'No completed transfers', match: (t) => t.state === 'done' },
  { id: 'failed', label: 'Failed', empty: 'No failed transfers', match: (t) => t.state === 'failed' || t.state === 'cancelled' },
];
const SORTS = {
  recent: (a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')),
  name: (a, b) => a.path.localeCompare(b.path),
  size: (a, b) => (b.size || 0) - (a.size || 0),
};

const act = (method, params) => rpc(method, params).catch(toastError);

function transferRow(t) {
  const sync = t.sync_id ? store.syncs.get(t.sync_id) : null;
  const pct = percent(t.done, t.size);
  const fill = h('div', { class: 'rd-meter-fill' });
  fill.style.width = `${pct}%`;
  const live = t.state === 'active' || t.state === 'paused';
  const detail = t.state === 'failed'
    ? h('span', { class: 'dk-tr-error' }, t.error || 'Failed')
    : t.state === 'done'
      ? `${bytes(t.size)} · ${ago(t.finished_at)}`
      : t.state === 'cancelled'
        // A sync transfer stops when the sync is paused or its plan changes; the sync plans it again.
        ? `${t.manual ? 'Cancelled' : 'Stopped, the sync will retry'} · ${bytes(t.size)}`
        : h('span', { class: transferWaits(t) ? 'dk-tr-warn' : null }, transferStatus(t));
  const actions = [];
  if (t.state === 'active' || t.state === 'queued') actions.push(h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': `Pause ${basename(t.path)}`, onclick: () => act('transfers.pause', { id: t.id }) }, icon('pause')));
  if (t.state === 'paused') actions.push(h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': `Resume ${basename(t.path)}`, onclick: () => act('transfers.resume', { id: t.id }) }, icon('play')));
  if (t.manual && ['active', 'queued', 'paused'].includes(t.state)) actions.push(h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': `Cancel ${basename(t.path)}`, onclick: () => act('transfers.cancel', { id: t.id }) }, icon('x')));
  return h('tr', null,
    h('td', { class: 'is-trunc' },
      h('div', { class: 'dk-tr-name' }, icon(t.direction === 'up' ? 'upload' : 'download', `dk-tr-dir is-${t.direction}`),
        h('span', { title: t.path }, basename(t.path))),
      h('div', { class: 'dk-tr-sub' }, sync ? sync.name : 'Started by you', ' · ', t.path),
      live ? h('div', { class: 'rd-meter dk-tr-meter' }, fill) : null),
    h('td', { class: 'dk-tr-detail' }, detail),
    h('td', { class: 'is-actions' }, h('div', { class: 'dk-tr-actions' }, actions)));
}

export function mount(container, params = {}) {
  let tab = params.tab || 'active';
  let query = '';
  let sort = 'recent';
  const tabs = h('div', { class: 'rd-tabs', role: 'tablist', 'aria-label': 'Transfer lists' });
  const body = h('tbody');
  const emptyTitle = h('h2', { class: 'rd-empty-title' });
  const empty = h('div', { class: 'rd-empty', hidden: true },
    h('span', { class: 'rd-empty-icon' }, icon('transfers')),
    emptyTitle,
    h('p', { class: 'rd-empty-text' }, 'Uploads and downloads show up here while they run.'));
  const table = h('section', { class: 'rd-panel' }, h('div', { class: 'rd-table-wrap' }, h('table', { class: 'rd-table dk-tr-table' },
    h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', { class: 'dk-tr-status' }, 'Status'), h('th', { class: 'is-actions' }, h('span', { class: 'sr-only' }, 'Actions')))),
    body)));
  const allPaused = () => [...store.transfers.values()].some((t) => t.state === 'paused');

  // Pause and resume for everything at once: one button, the directions in its menu.
  const globalBar = h('div', { class: 'dk-btn-row' });
  function renderGlobal() {
    fill(globalBar,
      tab === 'done' ? h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => act('transfers.clearCompleted').then(loadTransfers) }, 'Clear completed') : null,
      allPaused()
        ? h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => act('transfers.resume', {}) }, icon('play'), 'Resume all')
        : h('button', {
          type: 'button', class: 'rd-btn rd-btn-ghost', 'aria-haspopup': 'menu',
          onclick: (e) => openMenu(e.currentTarget, [
            { label: 'Pause all', icon: 'pause', run: () => act('transfers.pause', {}) },
            { label: 'Pause uploads', icon: 'upload', run: () => act('transfers.pause', { direction: 'up' }) },
            { label: 'Pause downloads', icon: 'download', run: () => act('transfers.pause', { direction: 'down' }) },
          ]),
        }, icon('pause'), 'Pause', icon('chevronDown', 'dk-caret')));
  }

  const toolbar = h('div', { class: 'dk-toolbar' },
    tabs,
    h('div', { class: 'dk-toolbar-right' },
      h('input', {
        type: 'search', class: 'form-input dk-search', placeholder: 'Search transfers', 'aria-label': 'Search transfers',
        oninput: (e) => { query = e.target.value.trim().toLowerCase(); render(); },
      }),
      h('select', { class: 'form-input dk-sort', 'aria-label': 'Sort', onchange: (e) => { sort = e.target.value; render(); } },
        h('option', { value: 'recent' }, 'Newest first'), h('option', { value: 'name' }, 'Name'), h('option', { value: 'size' }, 'Largest first')),
      globalBar));

  function render() {
    const all = [...store.transfers.values()];
    clear(tabs);
    for (const t of TABS) {
      const n = all.filter(t.match).length;
      append(tabs, h('button', {
        type: 'button', role: 'tab', class: 'rd-tab', 'aria-selected': String(tab === t.id),
        onclick: () => { tab = t.id; render(); },
      }, t.label, n ? h('span', { class: 'rd-count' }, String(n)) : null));
    }
    const current = TABS.find((t) => t.id === tab);
    const rows = all.filter(current.match)
      .filter((t) => !query || t.path.toLowerCase().includes(query))
      .sort(SORTS[sort]);
    clear(body);
    for (const t of rows.slice(0, 500)) append(body, transferRow(t));
    emptyTitle.textContent = query ? 'No matching transfers' : current.empty;
    empty.hidden = rows.length > 0;
    table.hidden = rows.length === 0;
    renderGlobal();
  }

  append(container,
    pageHead('Transfers', 'Uploads and downloads on this computer.',
      h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => manualDownload() }, icon('download'), 'Download…'),
      h('button', { type: 'button', class: 'rd-btn rd-btn-primary', onclick: () => manualUpload() }, icon('upload'), 'Upload…')),
    toolbar, table, empty);

  render();
  loadTransfers().catch(toastError);
  // Events can be missed (the engine drops them when its queue is full): while
  // anything runs, read the list again so no row stays behind.
  const resync = setInterval(() => {
    if ([...store.transfers.values()].some((t) => !t.finished_at)) loadTransfers().catch(() => {});
  }, 5000);
  let pending = false;
  const off = on('transfers', () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  });
  return () => { clearInterval(resync); off(); };
}
