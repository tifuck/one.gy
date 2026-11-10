// App-owned settings (window, autostart, theme, server, zoom, updates,
// notifications) in a small JSON file in userData. Engine settings live in the
// engine. Every value from a renderer is validated here; unknown keys are
// dropped. `theme` follows the website's own theme switch (site-preload).
'use strict';

const fs = require('fs');
const path = require('path');
const { ZOOM_LEVELS } = require('./shortcuts');

const DEFAULT_SERVER = 'https://one.gy';
const NOTIFY_KINDS = ['conflict', 'issue', 'mass_delete', 'transfer', 'revoked', 'info'];

const DEFAULTS = Object.freeze({
  server_url: DEFAULT_SERVER,
  launch_at_login: true,
  start_minimized: false,
  close_to_tray: true,
  theme: 'frost-dark',
  site_zoom: 1,
  update_channel: 'stable',
  auto_update: true,
  prevent_sleep: true,
  lock_after_minutes: 30, // app lock after this much system idle time (0 = only on start, sleep and screen lock)
  default_upload_folder: null, // {id, path}: one.gy folder for tray Upload…
  default_download_dir: '', // local folder for manual downloads ('' = ask)
  notify: Object.freeze(Object.fromEntries(NOTIFY_KINDS.map((k) => [k, true]))),
});

const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? v : undefined);

// Returns the origin of an https URL (no path, no credentials), or undefined.
function normalizeServerUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let url;
  try { url = new URL(value.trim()); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  return url.origin;
}

const VALIDATORS = {
  server_url: normalizeServerUrl,
  launch_at_login: bool,
  start_minimized: bool,
  close_to_tray: bool,
  theme: oneOf('frost', 'frost-dark'),
  site_zoom: oneOf(...ZOOM_LEVELS),
  update_channel: oneOf('stable', 'beta'),
  auto_update: bool,
  prevent_sleep: bool,
  lock_after_minutes: oneOf(0, 5, 15, 30, 60, 240),
  default_upload_folder: (v) => {
    if (v === null) return null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const idOk = v.id === null || (Number.isSafeInteger(v.id) && v.id > 0);
    const pathOk = typeof v.path === 'string' && v.path.startsWith('/') && v.path.length <= 4096;
    return idOk && pathOk ? { id: v.id, path: v.path } : undefined;
  },
  default_download_dir: (v) => (v === '' || (typeof v === 'string' && v.length <= 4096 && path.isAbsolute(v)) ? v : undefined),
  notify: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out = {};
    for (const k of NOTIFY_KINDS) if (typeof v[k] === 'boolean') out[k] = v[k];
    return out;
  },
};

// Applies the valid keys of `patch` on top of `base`; returns { value, errors }.
function applyPatch(base, patch) {
  const value = { ...base, notify: { ...base.notify } };
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { value, errors: ['patch must be an object'] };
  }
  for (const [key, raw] of Object.entries(patch)) {
    const validate = VALIDATORS[key];
    const clean = validate ? validate(raw) : undefined;
    if (clean === undefined) { errors.push(`invalid ${key}`); continue; }
    value[key] = key === 'notify' ? { ...value.notify, ...clean } : clean;
  }
  return { value, errors };
}

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.listeners = new Set();
    this.data = this.load();
  }

  load() {
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[SETTINGS] unreadable ${this.file}, using defaults: ${err.message}`);
    }
    return applyPatch(DEFAULTS, stored).value;
  }

  get() {
    return { ...this.data, notify: { ...this.data.notify } };
  }

  // Validates and persists; returns { settings, errors }.
  set(patch) {
    const { value, errors } = applyPatch(this.data, patch);
    const before = this.data;
    this.data = value;
    this.save();
    for (const fn of this.listeners) fn(this.get(), before);
    return { settings: this.get(), errors };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Atomic write: temp file in the same directory, then rename.
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { SettingsStore, DEFAULTS, DEFAULT_SERVER, NOTIFY_KINDS, normalizeServerUrl, applyPatch };
