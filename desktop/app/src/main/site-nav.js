// Values the website view hands the main process about its navigation
// (desktop/docs/site-bridge.md): paths to open, the width of its rail and the
// height of its music bar.
'use strict';

const MAX_RAIL_PX = 400;
// While the app is locked the server keeps the site's session for the pages
// that need no keys (music, so it keeps playing) and sends every other page
// to LOCKED_PATH, which the lock screen covers.
const LOCKED_PATH = '/desktop/locked';
const LOCK_FREE_PATHS = new Set(['/music']);
const isLockFreePath = (p) => LOCK_FREE_PATHS.has(p);

// A path on the configured server: "/x...", never "//host" or with spaces/backslashes.
const isSitePath = (v) => typeof v === 'string' && v.length <= 2048 && /^\/(?!\/)[^\s\\]*$/.test(v);

// The rail's right edge (or the music bar's height) in CSS px as
// site-preload.js measured it, or null.
function cleanInset(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_RAIL_PX ? Math.round(v) : null;
}

module.exports = {
  isSitePath, cleanInset, isLockFreePath, LOCKED_PATH,
};
