// Transfers (plan 10.4): tabs Active / Queued / Completed / Failed, per-item
// pause/resume and cancel (manual transfers only), global pause and clear.
// Events arrive many times a second while files move, so the tabs, toolbar
// and rows are built once and updated in place: a node replaced between
// mousedown and mouseup would swallow the click.
import {
  h, icon, append, fill, pageHead,
} from '../components/dom.js';
import { toastError } from '../components/toast.js';
import { openMenu } from '../components/menu.js';
import { manualUpload, manualDownload } from '../components/manual.js';
import {
  bytes, count, percent, basename, ago, transferStatus, transferWaits,
} from '../components/format.js';
import {
  rpc, store, on, loadTransfers, plannedWork,
} from '../store.js';

const PAGE = 50;
const TABS = [
  { id: 'active', label: 'Active', empty: 'No active transfers', match: (t) => t.state === 'active' || t.state === 'paused' },
  { id: 'queued', label: 'Queued', empty: 'Nothing queued', match: (t) => t.state === 'queued' },
  // A cancelled sync transfer was stopped by a pause or a new plan, not a failure; the sync plans it again.
  { id: 'done', label: 'Completed', empty: 'No completed transfers', match: (t) => t.state === 'done' || t.state === 'cancelled' },
  { id: 'failed', label: 'Failed', empty: 'No failed transfers', match: (t) => t.state === 'failed' },
];
// Ties (same second, or not started yet) keep the engine's order, newest first.
const seq = (t) => Number(String(t.id).replace(/\D/g, '')) || 0;
const SORTS = {
  recent: (a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')) || seq(b) - seq(a),
  name: (a, b) => a.path.localeCompare(b.path) || seq(a) - seq(b),
  size: (a, b) => (b.size || 0) - (a.size || 0) || seq(a) - seq(b),
};

const act = (method, params) => rpc(method, params).catch(toastError);

function detailOf(t) {
  if (t.state === 'failed') return h('span', { class: 'dk-tr-error' }, t.error || 'Failed');
  if (t.state === 'done') return `${bytes(t.size)} · ${ago(t.finished_at)}`;
  if (t.state === 'cancelled') return `${t.manual ? 'Cancelled' : 'Stopped, the sync will retry'} · ${bytes(t.size)}`;
  return h('span', { class: transferWaits(t) ? 'dk-tr-warn' : null }, transferStatus(t));
}

function actionsOf(t) {
  const out = [];
  if (t.state === 'active' || t.state === 'queued') out.push(h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': `Pause ${basename(t.path)}`, onclick: () => act('transfers.pause', { id: t.id }) }, icon('pause')));
  if (t.state === 'paused') out.push(h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': `Resume ${basename(t.path)}`, onclick: () => act('transfers.resume', { id: t.id }) }, icon('play')));
  if (t.manual && ['active', 'queued', 'paused'].includes(t.state)) out.push(h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': `Cancel ${basename(t.path)}`, onclick: () => act('transfers.cancel', { id: t.id }) }, icon('x')));
  return out;
}

// A row that updates in place; its buttons are only rebuilt when they change.
function transferRow(t) {
  const bar = h('div', { class: 'rd-meter-fill' });
  const meter = h('div', { class: 'rd-meter dk-tr-meter' }, bar);
  const sub = h('div', { class: 'dk-tr-sub' });
  const detail = h('td', { class: 'dk-tr-detail' });
  const actions = h('div', { class: 'dk-tr-actions' });
  const tr = h('tr', null,
    h('td', { class: 'is-trunc' },
      h('div', { class: 'dk-tr-name' }, icon(t.direction === 'up' ? 'upload' : 'download', `dk-tr-dir is-${t.direction}`),
        h('span', { title: t.path }, basename(t.path))),
      sub, meter),
    detail,
    h('td', { class: 'is-actions' }, actions));
  let actKey = null;
  function update(v) {
    const sync = v.sync_id ? store.syncs.get(v.sync_id) : null;
    sub.textContent = `${sync ? sync.name : v.sync_id ? 'Removed sync' : 'Started by you'} · ${v.path}`;
    meter.hidden = !(v.state === 'active' || v.state === 'paused');
    bar.style.width = `${percent(v.done, v.size)}%`;
    fill(detail, detailOf(v));
    const key = `${v.state}|${v.manual}`;
    if (key !== actKey) {
      actKey = key;
      fill(actions, actionsOf(v));
    }
  }
  update(t);
  return { tr, update };
}

// Files a sync has yet to start (it hands the pool a few at a time).
const plannedRow = (w) => h('tr', null,
  h('td', { class: 'is-trunc' },
    h('div', { class: 'dk-tr-name' }, icon(w.direction === 'up' ? 'upload' : 'download', `dk-tr-dir is-${w.direction}`),
      h('span', null, `${count(w.count)} more file${w.count === 1 ? '' : 's'}`)),
    h('div', { class: 'dk-tr-sub' }, `${w.sync.name} · starts them a few at a time`)),
  h('td', { class: 'dk-tr-detail' }, `Waiting to ${w.direction === 'up' ? 'upload' : 'download'}`),
  h('td', { class: 'is-actions' }));

// Puts rows in order, moving only the nodes that are out of place.
function place(body, trs) {
  trs.forEach((tr, i) => {
    if (body.children[i] !== tr) body.insertBefore(tr, body.children[i] || null);
  });
  while (body.children.length > trs.length) body.lastElementChild.remove();
}

export function mount(container, params = {}) {
  let tab = params.tab || 'active';
  let query = '';
  let sort = 'recent';
  let page = 0;
  const rows = new Map(); // transfer id -> row on the current page
  const tabs = h('div', { class: 'rd-tabs', role: 'tablist', 'aria-label': 'Transfer lists' });
  const tabEls = TABS.map((t) => {
    const n = h('span', { class: 'rd-count', hidden: true });
    const btn = h('button', {
      type: 'button', role: 'tab', class: 'rd-tab',
      onclick: () => { tab = t.id; page = 0; render(); },
    }, t.label, n);
    append(tabs, btn);
    return { t, btn, n };
  });
  const body = h('tbody');
  const emptyTitle = h('h2', { class: 'rd-empty-title' });
  const empty = h('div', { class: 'rd-empty', hidden: true },
    h('span', { class: 'rd-empty-icon' }, icon('transfers')),
    emptyTitle,
    h('p', { class: 'rd-empty-text' }, 'Uploads and downloads show up here while they run.'));
  const table = h('section', { class: 'rd-panel' }, h('div', { class: 'rd-table-wrap' }, h('table', { class: 'rd-table dk-tr-table' },
    h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', { class: 'dk-tr-status' }, 'Status'), h('th', { class: 'is-actions' }, h('span', { class: 'sr-only' }, 'Actions')))),
    body)));
  const pageText = h('span');
  const prev = h('button', { type: 'button', class: 'rd-btn rd-btn-ghost rd-btn-sm', onclick: () => { page--; render(); } }, 'Previous');
  const next = h('button', { type: 'button', class: 'rd-btn rd-btn-ghost rd-btn-sm', onclick: () => { page++; render(); } }, 'Next');
  const pager = h('div', { class: 'dk-pager', hidden: true }, pageText, prev, next);
  // A paused direction holds queued transfers too, which stay "queued".
  const allPaused = () => Boolean(store.status && (store.status.paused_up || store.status.paused_down))
    || [...store.transfers.values()].some((t) => t.state === 'paused');

  // In the page head: the toolbar has no room left for it.
  const clearBtn = h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', hidden: true, onclick: () => act('transfers.clearCompleted').then(loadTransfers) }, 'Clear completed');

  // Pause and resume for everything at once: one button, the directions in its menu.
  const globalBar = h('div', { class: 'dk-btn-row' });
  let globalKey = null;
  function renderGlobal() {
    clearBtn.hidden = tab !== 'done';
    const paused = allPaused();
    const key = String(paused);
    if (key === globalKey) return;
    globalKey = key;
    fill(globalBar,
      paused
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
        type: 'search', class: 'form-input dk-search', placeholder: 'Search', 'aria-label': 'Search transfers',
        oninput: (e) => { query = e.target.value.trim().toLowerCase(); page = 0; render(); },
      }),
      h('select', { class: 'form-input dk-sort', 'aria-label': 'Sort', onchange: (e) => { sort = e.target.value; page = 0; render(); } },
        h('option', { value: 'recent' }, 'Newest first'), h('option', { value: 'name' }, 'Name'), h('option', { value: 'size' }, 'Largest first')),
      globalBar));

  function render() {
    const all = [...store.transfers.values()];
    const planned = plannedWork();
    const plannedN = planned.reduce((n, w) => n + w.count, 0);
    for (const { t, btn, n } of tabEls) {
      const c = all.filter(t.match).length + (t.id === 'queued' ? plannedN : 0);
      btn.setAttribute('aria-selected', String(tab === t.id));
      n.textContent = count(c);
      n.hidden = !c;
    }
    const current = TABS.find((t) => t.id === tab);
    const list = all.filter(current.match)
      .filter((t) => !query || t.path.toLowerCase().includes(query))
      .sort(SORTS[sort]);
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    page = Math.min(Math.max(page, 0), pages - 1);
    const shown = list.slice(page * PAGE, (page + 1) * PAGE);
    const keep = new Set(shown.map((t) => t.id));
    for (const id of rows.keys()) if (!keep.has(id)) rows.delete(id);
    const trs = tab === 'queued' && !query && page === 0 ? planned.map(plannedRow) : [];
    for (const t of shown) {
      let r = rows.get(t.id);
      if (r) r.update(t);
      else rows.set(t.id, r = transferRow(t));
      trs.push(r.tr);
    }
    place(body, trs);
    emptyTitle.textContent = query ? 'No matching transfers' : current.empty;
    empty.hidden = trs.length > 0;
    table.hidden = trs.length === 0;
    pager.hidden = pages < 2;
    pageText.textContent = `${count(page * PAGE + 1)}–${count(page * PAGE + shown.length)} of ${count(list.length)}`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
    renderGlobal();
  }

  append(container,
    pageHead('Transfers', 'Uploads and downloads on this computer.',
      clearBtn,
      h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => manualDownload() }, icon('download'), 'Download…'),
      h('button', { type: 'button', class: 'rd-btn rd-btn-primary', onclick: () => manualUpload() }, icon('upload'), 'Upload…')),
    toolbar, table, pager, empty);

  render();
  loadTransfers().catch(toastError);
  // Events can be missed (the engine drops them when its queue is full): while
  // anything runs, read the list again so no row stays behind.
  const resync = setInterval(() => {
    if ([...store.transfers.values()].some((t) => !t.finished_at)) loadTransfers().catch(() => {});
  }, 5000);
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  };
  const offs = [on('transfers', schedule), on('syncs', schedule), on('status', renderGlobal)];
  return () => { clearInterval(resync); offs.forEach((off) => off()); };
}
