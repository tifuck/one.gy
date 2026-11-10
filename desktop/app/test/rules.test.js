'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// src/ui is plain ES modules without a package "type"; rules.js has no imports.
const load = () => import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, '../src/ui/components/rules.js'), 'utf8'))}`);

test('new rules: header plus the system-file filter in the app block', async () => {
  const { newRules, parseRules, MARK, PRESETS } = await load();
  const text = newRules();
  assert.ok(text.startsWith('# Rules for this sync.'));
  assert.ok(text.includes(`${MARK}\n${PRESETS.junk.join('\n')}\n`));
  assert.deepStrictEqual(parseRules(text), { presets: { junk: true, dev: false }, patterns: [], maxMB: 0, skip: [], keep: [] });
});

test('choices round-trip, user lines stay, exact paths are quoted and last', async () => {
  const { parseRules, buildRules, MARK } = await load();
  const user = '# mine\n-:*.bak\n+:keep.bak\n';
  const st = { presets: { junk: false, dev: true }, patterns: ['*.log', 'build/'], maxMB: 500, skip: ['docs/old (1).txt', 'a+b'], keep: ['src/node_modules'] };
  const text = buildRules(user, st);
  assert.ok(text.startsWith(user));
  const lines = text.trim().split('\n');
  assert.strictEqual(lines[lines.indexOf(MARK) - 1], '');
  assert.deepStrictEqual(lines.slice(-3), ['-pR:docs/old \\(1\\)\\.txt', '-pR:a\\+b', '+pR:src/node_modules']);
  assert.ok(lines.includes('-d:build') && lines.includes('-:*.log') && lines.includes('exclude-larger:500M'));
  assert.deepStrictEqual(parseRules(text), st);
  // Rebuilding is stable and turning everything off leaves only the user's lines.
  assert.strictEqual(buildRules(text, parseRules(text)), text);
  assert.strictEqual(buildRules(text, { presets: {}, patterns: [], maxMB: 0, skip: [], keep: [] }), user);
});

test('engine-written files: default rules read as the filter, ignored paths as skipped', async () => {
  const { parseRules, buildRules, PRESETS, MARK } = await load();
  const engine = `# Rules for this sync. Same grammar as MEGA's .megaignore.\n${PRESETS.junk.join('\n')}\n-pR:Old/x\\.iso\nexclude-larger:2G\n`;
  const st = parseRules(engine);
  assert.strictEqual(st.presets.junk, true);
  assert.deepStrictEqual(st.skip, ['Old/x.iso']);
  assert.strictEqual(st.maxMB, 2048);
  st.skip = [];
  const out = buildRules(engine, st);
  assert.ok(!out.includes('x\\.iso') && !out.includes('2G') && out.includes(`${MARK}\n-:desktop.ini`));
  // A hand-written regex that is not an exact path stays the user's.
  assert.deepStrictEqual(parseRules('-pR:.*\\.iso\n').skip, []);
  // A partial preset is not "on" and its lines are not taken over.
  assert.strictEqual(buildRules('-:*.tmp\n', parseRules('-:*.tmp\n')), '-:*.tmp\n');
});

test('patterns', async () => {
  const { patternRule } = await load();
  assert.strictEqual(patternRule(' *.mp4 '), '-:*.mp4');
  assert.strictEqual(patternRule('Old drafts/'), '-d:Old drafts');
  assert.strictEqual(patternRule('/'), null);
  assert.strictEqual(patternRule('a\nb'), null);
});
