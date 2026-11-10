// Values the website view hands the main process about its navigation
// (desktop/docs/site-bridge.md): paths to open and the width of its rail.
'use strict';

const MAX_RAIL_PX = 400;

// A path on the configured server: "/x...", never "//host" or with spaces/backslashes.
const isSitePath = (v) => typeof v === 'string' && v.length <= 2048 && /^\/(?!\/)[^\s\\]*$/.test(v);

// The rail's right edge in CSS px as site-preload.js measured it, or null.
function cleanInset(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_RAIL_PX ? Math.round(v) : null;
}

module.exports = { isSitePath, cleanInset };
