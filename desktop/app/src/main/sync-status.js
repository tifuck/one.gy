// Overall sync state for the tray and the website bridge: account.status,
// the engine's status events and the open issue count, mapped to the
// onStatus states of desktop/docs/site-bridge.md. Pure Node (the dev browser
// bridge uses it too).
'use strict';

const { EventEmitter } = require('events');

const PASS_THROUGH = new Set(['up_to_date', 'syncing', 'paused', 'offline', 'issues', 'locked']);

// Usernames are unique regardless of case on the server.
const sameUser = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// { state, pending, issues } for a website page signed in as `username`
// (null: page unknown, e.g. the tray).
function bridgeStatus({ engineState, account, status, issueCount }, username) {
  const pending = (status && status.pending) || 0;
  const out = (state) => ({ state, pending, issues: issueCount });
  if (engineState !== 'connected' || !account) return out('offline');
  if (!account.signed_in) return out('not_set_up');
  if (username && !sameUser(account.username, username)) return { state: 'other_account', pending: 0, issues: 0 };
  if (account.locked) return out('locked');
  const s = status && status.state;
  if (s === 'signed_out') return out('not_set_up');
  return out(PASS_THROUGH.has(s) ? s : 'syncing');
}

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
  constructor(engine) {
    super();
    this.engine = engine;
    this.engineState = engine.state;
    this.account = null;
    this.status = null;
    this.issues = new Set();
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
    return bridgeStatus(this, username);
  }

  async refresh() {
    await Promise.all([this.loadAccount(), this.loadIssues()]);
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
    } else if (ev.type === 'issue' && d.id !== undefined) {
      if (d.resolved) this.issues.delete(d.id);
      else this.issues.add(d.id);
      this.emit('change');
    }
  }
}

module.exports = { SyncStatus, bridgeStatus, sameUser, throttle };
