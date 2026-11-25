// Overall sync state for the tray and the website bridge: account.status,
// the engine's status events and the open issue count, mapped to the
// onStatus states of desktop/docs/site-bridge.md. Pure Node (the dev browser
// bridge uses it too).
'use strict';

const { EventEmitter } = require('events');

const PASS_THROUGH = new Set(['up_to_date', 'syncing', 'paused', 'offline', 'issues', 'locked']);

// Usernames are unique regardless of case on the server.
const sameUser = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Whether the website the app shows (`origin`, its server setting) is the
// server this computer's account lives on. The same username on another
// server is another account. No origin given: not a website asking.
function sameServer(account, origin) {
  if (origin === undefined) return true;
  try { return new URL(account.server).origin === origin; } catch { return false; }
}

// { state, pending, issues } for a website page on `origin` signed in as
// `username` (null: page unknown, e.g. the tray).
function bridgeStatus({ engineState, account, status, issueCount }, username, origin) {
  const pending = (status && status.pending) || 0;
  const out = (state) => ({ state, pending, issues: issueCount });
  if (engineState !== 'connected' || !account) return out('offline');
  if (!account.signed_in) return out('not_set_up');
  if ((username && !sameUser(account.username, username)) || !sameServer(account, origin)) return { state: 'other_account', pending: 0, issues: 0 };
  if (account.locked) return out('locked');
  const s = status && status.state;
  if (s === 'signed_out') return out('not_set_up');
  return out(PASS_THROUGH.has(s) ? s : 'syncing');
}

// One sync's state for the website (site-bridge.md onSyncs).
function syncState(s, account) {
  if (account.locked) return 'locked';
  if (s.paused) return 'paused';
  if (s.stats && s.stats.issues > 0) return 'issues';
  if (s.state === 'scanning' || s.state === 'syncing') return 'syncing';
  if (s.state === 'up_to_date' || s.state === 'offline') return s.state;
  return 'error';
}

// This computer's syncs for a website page on `origin` signed in as
// `username`: only the one.gy side (no local paths or names), and none for
// another account.
function bridgeSyncs({ engineState, account, syncs }, username, origin) {
  if (engineState !== 'connected' || !account || !account.signed_in || !sameUser(account.username, username) || !sameServer(account, origin)) return [];
  return [...syncs.values()].map((s) => {
    const st = s.stats || {};
    return {
      id: s.id,
      folder_id: s.remote_folder_id ?? null,
      type: s.type,
      state: syncState(s, account),
      pending: (st.pending_up || 0) + (st.pending_down || 0),
      issues: st.issues || 0,
    };
  });
}

// Whether a website page on `origin` signed in as `username` may get this
// computer's master key: only a page of the account this computer is
// authorized for, on that account's server, so no other server gets the key
// and another account's page never stores (and encrypts with) the wrong one.
const mayUnlock = (account, username, origin) => Boolean(account && account.signed_in && sameUser(account.username, username)
  && typeof origin === 'string' && sameServer(account, origin));

// The app lock (engine-ipc.md account.status): the site view stays closed and
// the lock screen shows until the PIN or password unlocks the app.
const appLocked = (account) => Boolean(account && account.signed_in && account.lock_enabled && account.app_locked);

// Calls fn at most once per `ms`, always with the latest state (trailing).
function throttle(fn, ms) {
  let timer = null;
  let last = 0;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      fn();
    }, Math.max(0, last + ms - Date.now()));
  };
}

// Emits 'change' whenever anything bridgeStatus() reads may have changed.
class SyncStatus extends EventEmitter {
  // engine: EngineSupervisor (or anything with .state, .call() and 'state'/'event').
  // siteOrigin(): the origin of the website the app shows; without it forUser
  // and syncsForUser do not look at the server.
  constructor(engine, siteOrigin = () => undefined) {
    super();
    this.engine = engine;
    this.siteOrigin = siteOrigin;
    this.engineState = engine.state;
    this.account = null;
    this.status = null;
    this.issues = new Set();
    this.syncs = new Map();
    engine.on('state', (s) => {
      this.engineState = s;
      if (s === 'connected') this.refresh();
      this.emit('change');
    });
    engine.on('event', (ev) => this.onEvent(ev));
  }

  get issueCount() {
    return this.issues.size;
  }

  authorized() {
    return Boolean(this.account && this.account.signed_in);
  }

  forUser(username) {
    return bridgeStatus(this, username, this.siteOrigin());
  }

  syncsForUser(username) {
    return bridgeSyncs(this, username, this.siteOrigin());
  }

  async refresh() {
    await Promise.all([this.loadAccount(), this.loadIssues(), this.loadSyncs()]);
  }

  // Also after a sync is removed: the engine sends no event for that.
  async loadSyncs() {
    try {
      const list = await this.engine.call('syncs.list');
      this.syncs = new Map((Array.isArray(list) ? list : []).map((s) => [s.id, s]));
    } catch (err) {
      // Signed out: no syncs. Any other failure keeps the last list (sync events still update it).
      if (err.code === 'not_signed_in') this.syncs = new Map();
      else console.error(`[SYNC] syncs.list failed: ${err.message}`);
    }
    this.emit('change');
  }

  async loadAccount() {
    try {
      this.account = await this.engine.call('account.status');
      this.emit('change');
    } catch (err) {
      console.error(`[SYNC] account.status failed: ${err.message}`);
    }
  }

  async loadIssues() {
    try {
      const list = await this.engine.call('issues.list', {});
      this.issues = new Set((Array.isArray(list) ? list : []).map((i) => i.id));
      this.emit('change');
    } catch (err) {
      if (err.code !== 'not_signed_in') console.error(`[SYNC] issues.list failed: ${err.message}`);
    }
  }

  onEvent(ev) {
    if (!ev || !ev.data) return;
    const d = ev.data;
    if (ev.type === 'status') {
      const was = this.status && this.status.state;
      this.status = d;
      // Sign-in, sign-out, lock and issue changes all show up as state changes.
      if (was !== d.state) this.refresh();
      this.emit('change');
    } else if (ev.type === 'sync' && d.id) {
      this.syncs.set(d.id, d);
      this.emit('change');
    } else if (ev.type === 'account') {
      this.account = d;
      this.emit('change');
    } else if (ev.type === 'issue' && d.id !== undefined) {
      if (d.resolved) this.issues.delete(d.id);
      else this.issues.add(d.id);
      this.emit('change');
    }
  }
}

module.exports = {
  SyncStatus, bridgeStatus, bridgeSyncs, sameUser, mayUnlock, appLocked, throttle,
};
