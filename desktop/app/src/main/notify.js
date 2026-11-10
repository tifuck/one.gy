// OS notifications from engine `notify` events: per-category opt-out and a
// rate limit per kind. A burst shows the first one, then one summary when the
// window ends. Pure logic; main.js passes the Electron `show` function.
'use strict';

const WINDOW_MS = 10000;

const SUMMARY = {
  conflict: (n) => `${n} more conflicts need a decision`,
  issue: (n) => `${n} more sync issues`,
  mass_delete: (n) => `${n} more syncs are waiting for a delete check`,
  transfer: (n) => `${n} more transfers finished`,
  revoked: () => 'This device was removed',
  info: (n) => `${n} more updates`,
};

// show({title, body, kind}); isEnabled(kind) -> bool.
function createNotifier({ show, isEnabled, windowMs = WINDOW_MS, now = Date.now, setTimer = setTimeout }) {
  const buckets = new Map();

  function flush(kind) {
    const b = buckets.get(kind);
    if (!b) return;
    buckets.delete(kind);
    if (b.suppressed > 0 && isEnabled(kind)) {
      show({ title: 'ONE.GY', body: (SUMMARY[kind] || SUMMARY.info)(b.suppressed), kind });
    }
  }

  return function handle(data) {
    if (!data || typeof data.title !== 'string') return;
    const kind = Object.hasOwn(SUMMARY, data.kind) ? data.kind : 'info';
    if (!isEnabled(kind)) return;
    const b = buckets.get(kind);
    if (b && now() - b.since < windowMs) {
      b.suppressed += 1;
      return;
    }
    buckets.set(kind, { since: now(), suppressed: 0 });
    setTimer(() => flush(kind), windowMs);
    show({ title: data.title.slice(0, 200), body: String(data.body || '').slice(0, 500), kind });
  };
}

module.exports = { createNotifier };
