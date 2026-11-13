// Formatting helpers: sizes, speeds, durations, times, labels.

export function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export const speed = (bps) => (bps > 0 ? `${bytes(bps)}/s` : '');

export function count(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '–';
}

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  return `${h} h ${Math.round((seconds % 3600) / 60)} min`;
}

export function eta(t) {
  if (!t || !(t.bps > 0) || !(t.size > t.done)) return '';
  return duration((t.size - t.done) / t.bps);
}

export function ago(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '–';
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
}

export function dateTime(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
}

export const shortHash = (h) => (typeof h === 'string' && h ? `${h.replace(/…$/, '').slice(0, 10)}…` : '–');

export function percent(done, total) {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, (done / total) * 100));
}

// What a transfer that has not finished is doing (engine-ipc.md "Transfer"):
// its phase and numbers, plus the engine's note when it waits or stopped moving.
export function transferStatus(t) {
  if (t.state === 'queued') return `Queued · ${bytes(t.size)}`;
  if (t.state === 'paused') return `Paused · ${bytes(t.done)} of ${bytes(t.size)}`;
  if (t.phase === 'retrying') return t.note || 'Trying again';
  let parts = [`${bytes(t.done)} of ${bytes(t.size)}`, speed(t.bps), eta(t) ? `${eta(t)} left` : ''];
  if (t.phase === 'preparing') parts = [`Preparing · ${bytes(t.done)} of ${bytes(t.size)}`];
  if (t.phase === 'finishing') parts = [t.direction === 'up' ? 'Saving on one.gy' : 'Checking the download'];
  return [...parts, t.note].filter(Boolean).join(' · ');
}

// The transfer waits for another try or shows no sign of life.
export const transferWaits = (t) => Boolean(t.stalled || t.phase === 'retrying');

// How far a sync's current run of work is, 0-100, or null when the engine
// gave no total: by bytes, or by items when the work has no bytes (empty files).
export function syncPercent(s) {
  const st = s.stats || {};
  const left = (st.pending_up || 0) + (st.pending_down || 0);
  if (st.total_bytes > 0) return percent(st.total_bytes - (st.bytes_left || 0), st.total_bytes);
  if (st.total_items > 0) return percent(st.total_items - left, st.total_items);
  return null;
}

export const clockTime = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
};

export const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

export const SYNC_TYPES = {
  two_way: { label: 'Two-way sync', icon: 'sync', short: 'Two-way' },
  backup: { label: 'Backup', icon: 'backup', short: 'Backup' },
  mirror: { label: 'Mirror one.gy here', icon: 'mirror', short: 'Mirror' },
  archive: { label: 'Upload only, no deletes', icon: 'archive', short: 'Archive' },
  full: { label: 'Whole drive', icon: 'drive', short: 'Whole drive' },
};

export const SYNC_STATES = {
  scanning: { label: 'Scanning', tone: 'accent' },
  syncing: { label: 'Syncing', tone: 'accent' },
  up_to_date: { label: 'Up to date', tone: 'good' },
  paused: { label: 'Paused', tone: '' },
  offline: { label: 'Offline', tone: 'warn' },
  error: { label: 'Error', tone: 'bad' },
  root_missing: { label: 'Folder missing', tone: 'bad' },
  stalled: { label: 'Stalled', tone: 'warn' },
};

export const ISSUE_KINDS = {
  conflict: 'Changed on both sides',
  name_clash: 'Name clash',
  case_clash: 'Names differ only by case',
  invalid_name: 'Name not allowed here',
  path_too_long: 'Path too long',
  symlink: 'Symbolic link',
  permission: 'No permission',
  locked: 'File in use',
  quota: 'Storage full on one.gy',
  ignore_parse: 'Error in .onegyignore',
  read_only: 'Read-only on one.gy',
  mass_delete: 'Many deletions',
  root_missing: 'Local folder missing',
  remote_root_missing: 'one.gy folder missing',
  disk_full: 'Disk full',
  integrity: 'Content check failed',
  too_large: 'File too large',
  watch_limit: 'Too many folders to watch',
  sync_error: 'Sync keeps failing',
};

export const ISSUE_ACTIONS = {
  keep_both: 'Keep both',
  keep_remote: 'Keep one.gy',
  keep_local: 'Keep this computer',
  rename: 'Rename',
  retry: 'Retry',
  ignore: 'Ignore this path',
  delete_remote: 'Delete on one.gy',
  restore_local: 'Restore locally',
  restore_remote_root: 'Recreate on one.gy',
  remove_sync: 'Remove sync',
  open: 'Open folder',
};
