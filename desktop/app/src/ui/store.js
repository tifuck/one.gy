// State store for the native sync panel, fed by engine events, plus thin
// wrappers over the preload bridge (window.onegy) that turn error envelopes
// into Errors.

export const api = window.onegy;

export class BridgeError extends Error {
  constructor(error) {
    super(error.message || 'Something went wrong');
    this.code = error.code || 'internal';
    this.data = error.data || null;
  }
}

async function unwrap(promise) {
  const res = await promise;
  if (res && res.ok) return res.result;
  throw new BridgeError((res && res.error) || {});
}

export const rpc = (method, params) => unwrap(api.engine(method, params));
export const bridge = (name, ...args) => unwrap(api[name](...args));
export const appSettings = {
  get: () => unwrap(api.appSettings.get()),
  set: (patch) => unwrap(api.appSettings.set(patch)),
};

export const store = {
  engine: 'connecting',
  status: null,
  account: null,
  syncs: new Map(),
  transfers: new Map(),
  issues: new Map(),
  verify: new Map(), // sync id -> {done, total} while syncs.verify runs
  settings: null,
  app: null,
  version: null,
  panelUser: null, // the website user the panel was opened for
};

// Usernames are unique regardless of case on the server (main/sync-status.js).
export const sameUser = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const subs = new Map();

// topic: engine | status | account | syncs | transfers | issues | verify | settings | app | activity
//        | app:panel | app:action | app:navigate
export function on(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic).delete(fn);
}

export function emit(topic, data) {
  for (const fn of subs.get(topic) || []) {
    try { fn(data); } catch (err) { console.error(err); }
  }
}

// Screens switch screens through the shell (app.js listens), no import cycle.
export const navigate = (screen, params = {}) => emit('app:navigate', { ...params, screen });

const byId = (list) => new Map((Array.isArray(list) ? list : []).map((x) => [x.id, x]));

export async function loadAccount() {
  store.account = await rpc('account.status');
  emit('account');
  return store.account;
}

export async function loadSyncs() {
  store.syncs = byId(await rpc('syncs.list'));
  emit('syncs');
}

export async function loadTransfers() {
  store.transfers = byId(await rpc('transfers.list', {}));
  emit('transfers');
}

export async function loadIssues() {
  store.issues = byId(await rpc('issues.list', {}));
  emit('issues');
}

export async function refreshAll() {
  const results = await Promise.allSettled([loadAccount(), loadSyncs(), loadTransfers(), loadIssues()]);
  for (const r of results) if (r.status === 'rejected') console.error(r.reason);
}

export function handleEvent(ev) {
  if (!ev || typeof ev.type !== 'string') return;
  const d = ev.data;
  switch (ev.type) {
    case 'status': {
      // Sign-in and lock changes arrive as status states; account.status has the details.
      const was = store.status && store.status.state;
      store.status = d;
      // Also after a sync round, for the storage numbers (the engine refreshes them at most once a minute).
      if (d && was !== d.state && ['signed_out', 'locked', 'up_to_date'].some((s) => s === was || s === d.state)) loadAccount().catch(() => {});
      emit('status', d);
      break;
    }
    case 'sync':
      if (d && d.id) {
        store.syncs.set(d.id, d);
        emit('syncs', d);
      }
      break;
    case 'transfer':
      if (d && d.id) {
        store.transfers.set(d.id, d);
        emit('transfers', d);
      }
      break;
    case 'issue':
      if (d && d.id !== undefined) {
        if (d.resolved) store.issues.delete(d.id);
        else store.issues.set(d.id, d);
        emit('issues', d);
      }
      break;
    case 'activity':
      emit('activity', d);
      break;
    case 'verify':
      if (d && d.sync_id) {
        if (d.done >= d.total) store.verify.delete(d.sync_id);
        else store.verify.set(d.sync_id, d);
        emit('verify', d);
      }
      break;
    case 'app:engine':
      store.engine = d.state;
      emit('engine', d.state);
      if (d.state === 'connected') refreshAll();
      break;
    case 'app:settings':
      store.app = d;
      emit('app', d);
      break;
    default:
      emit(ev.type, d);
  }
}

export const issueCount = () => store.issues.size;
export const activeTransferCount = () => [...store.transfers.values()]
  .filter((t) => t.state === 'active' || t.state === 'queued').length;
