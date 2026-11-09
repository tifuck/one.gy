'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier } = require('../src/main/notify');

function harness(enabled = () => true) {
  let now = 0;
  const timers = [];
  const shown = [];
  const handle = createNotifier({
    show: (n) => shown.push(n),
    isEnabled: enabled,
    windowMs: 1000,
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, at: now + ms }),
  });
  const advance = (ms) => {
    now += ms;
    for (const t of timers.splice(0)) {
      if (t.at <= now) t.fn(); else timers.push(t);
    }
  };
  return { handle, shown, advance };
}

test('a burst shows the first notification and then one summary', () => {
  const { handle, shown, advance } = harness();
  handle({ title: 'Conflict', body: 'a.txt', kind: 'conflict' });
  handle({ title: 'Conflict', body: 'b.txt', kind: 'conflict' });
  handle({ title: 'Conflict', body: 'c.txt', kind: 'conflict' });
  assert.equal(shown.length, 1);
  advance(1000);
  assert.equal(shown.length, 2);
  assert.match(shown[1].body, /^2 more conflicts/);
  handle({ title: 'Conflict', body: 'd.txt', kind: 'conflict' });
  assert.equal(shown.length, 3);
});

test('kinds are limited separately and unknown kinds count as info', () => {
  const { handle, shown } = harness();
  handle({ title: 'A', kind: 'conflict' });
  handle({ title: 'B', kind: 'transfer' });
  handle({ title: 'C', kind: 'weird' });
  assert.deepEqual(shown.map((n) => n.kind), ['conflict', 'transfer', 'info']);
});

test('disabled categories and malformed events show nothing', () => {
  const { handle, shown, advance } = harness((kind) => kind !== 'transfer');
  handle({ title: 'Done', kind: 'transfer' });
  handle(null);
  handle({ body: 'no title', kind: 'info' });
  advance(5000);
  assert.equal(shown.length, 0);
});
