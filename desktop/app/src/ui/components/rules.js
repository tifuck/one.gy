// "What to sync" as .onegyignore text (grammar: engine/internal/ignore). The
// choices the app manages live in one block at the end of the file, after
// MARK; every other line is the user's own and stays as written. Exact paths
// are -pR:/+pR: rules with the path RE2-quoted, the same form the engine's
// "Ignore this path" issue action appends. Later rules win, so the block's
// exact paths override any pattern above them.

export const MARK = '# What to sync, chosen in ONE.GY Desktop. The app rewrites the lines below.';
const HEADER = "# Rules for this sync. Same grammar as MEGA's .megaignore.";

export const PRESETS = {
  // = ignore.DefaultRules() in the engine, so existing syncs show it as on.
  junk: ['-:desktop.ini', '-:Thumbs.db', '-:.DS_Store', '-:~$*', '-:.~lock.*#', '-:*.tmp', '-:*.swp', '-:*.part',
    '-:*.crdownload', '-:.Trash-*', '-:$RECYCLE.BIN', '-:System Volume Information', '-d:.snapshots', '-d:.zfs'],
  dev: ['-d:node_modules', '-d:__pycache__', '-d:.venv', '-d:.pytest_cache', '-d:.mypy_cache', '-d:.next', '-d:.gradle', '-d:.terraform'],
};

const UNITS = { '': 1, k: 1024, m: 1048576, g: 1073741824 };
const SIZE = /^exclude-larger:(\d+)([kmg]?)$/i;

// regexp.QuoteMeta
export const quote = (p) => p.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&');
function unquote(q) {
  const p = q.replace(/\\(.)/g, '$1');
  return p && quote(p) === q ? p : null;
}
function exactRule(line) {
  const m = /^([-+])pR:(.+)$/.exec(line);
  const p = m && unquote(m[2]);
  return p ? { skip: m[1] === '-', path: p } : null;
}

// "*.log" -> -:*.log, "build/" -> -d:build (folders only).
export function patternRule(pattern) {
  const p = String(pattern || '').trim();
  if (!p || /[\r\n]/.test(p)) return null;
  if (p.endsWith('/')) return p.length > 1 ? `-d:${p.replace(/\/+$/, '')}` : null;
  return `-:${p}`;
}
function rulePattern(line) {
  const m = /^-(d?):(.+)$/.exec(line);
  return m ? `${m[2]}${m[1] ? '/' : ''}` : null;
}

function scan(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.indexOf(MARK);
  const presets = {};
  const presetLines = new Set();
  for (const [k, rules] of Object.entries(PRESETS)) {
    presets[k] = rules.every((r) => lines.includes(r));
    if (presets[k]) rules.forEach((r) => presetLines.add(r));
  }
  const inBlock = (i) => at >= 0 && i > at;
  const managed = (line, i) => line === MARK || presetLines.has(line) || exactRule(line) || SIZE.test(line)
    || (inBlock(i) && rulePattern(line));
  return { lines, presets, presetLines, inBlock, managed };
}

// Text -> {presets: {junk, dev}, patterns: [...], maxMB, skip: [paths], keep: [paths]}.
export function parseRules(text) {
  const { lines, presets, presetLines, inBlock } = scan(text);
  const st = { presets, patterns: [], maxMB: 0, skip: [], keep: [] };
  lines.forEach((line, i) => {
    const exact = exactRule(line);
    const size = SIZE.exec(line);
    if (exact) (exact.skip ? st.skip : st.keep).push(exact.path);
    else if (size) st.maxMB = Math.max(1, Math.round((Number(size[1]) * UNITS[size[2].toLowerCase()]) / UNITS.m));
    else if (inBlock(i) && !presetLines.has(line) && rulePattern(line)) st.patterns.push(rulePattern(line));
  });
  return st;
}

// The text with the app's block rewritten from st (parseRules shape).
export function buildRules(text, st) {
  const { lines, managed } = scan(text);
  const kept = lines.filter((line, i) => !managed(line, i));
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const block = [];
  for (const [k, rules] of Object.entries(PRESETS)) if (st.presets[k]) block.push(...rules);
  for (const p of st.patterns) block.push(patternRule(p));
  if (st.maxMB > 0) block.push(`exclude-larger:${Math.round(st.maxMB)}M`);
  for (const p of st.skip) block.push(`-pR:${quote(p)}`);
  for (const p of st.keep) block.push(`+pR:${quote(p)}`);
  const body = [...new Set(block.filter(Boolean))];
  const out = body.length ? [...kept, ...(kept.length ? [''] : []), MARK, ...body] : kept;
  return out.length ? `${out.join('\n')}\n` : '';
}

// A new sync: the system-file filter only.
export function newRules() {
  return buildRules(HEADER, { presets: { junk: true }, patterns: [], maxMB: 0, skip: [], keep: [] });
}

// How many choices st holds beyond the system-file filter (for summaries).
export function describeRules(st) {
  const parts = [];
  if (st.skip.length) parts.push(`${st.skip.length} skipped item${st.skip.length === 1 ? '' : 's'}`);
  const filters = (st.presets.dev ? 1 : 0) + (st.maxMB ? 1 : 0) + st.patterns.length;
  if (filters) parts.push(`${filters} filter${filters === 1 ? '' : 's'}`);
  return parts.length ? `Everything except ${parts.join(' and ')}` : 'Everything';
}
