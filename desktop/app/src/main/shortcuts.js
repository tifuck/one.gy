// Keyboard shortcuts of the app window (there is no visible browser chrome)
// and the site zoom steps. Pure functions over Electron's before-input-event
// `input` object.
'use strict';

const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// Returns 'back' | 'forward' | 'reload' | 'hardReload' | 'zoomIn' | 'zoomOut'
// | 'zoomReset' | 'sync' | 'devtools' | null.
function shortcutFor(input) {
  if (!input || input.type !== 'keyDown') return null;
  const key = typeof input.key === 'string' ? input.key : '';
  const lower = key.toLowerCase();
  const ctrl = Boolean(input.control || input.meta);
  if (input.alt && !ctrl && !input.shift) {
    if (key === 'ArrowLeft') return 'back';
    if (key === 'ArrowRight') return 'forward';
    return null;
  }
  if (key === 'BrowserBack') return 'back';
  if (key === 'BrowserForward') return 'forward';
  if (key === 'F5' && !input.alt) return ctrl || input.shift ? 'hardReload' : 'reload';
  if (key === 'F12' && !ctrl && !input.alt) return 'devtools';
  if (!ctrl || input.alt) return null;
  if (lower === 'r') return input.shift ? 'hardReload' : 'reload';
  if (lower === 's' && input.shift) return 'sync';
  if (lower === 'i' && input.shift) return 'devtools';
  if (input.shift && !['+', '=', '_', '-'].includes(key)) return null;
  if (key === '=' || key === '+' || input.code === 'NumpadAdd') return 'zoomIn';
  if (key === '-' || key === '_' || input.code === 'NumpadSubtract') return 'zoomOut';
  if (key === '0' || input.code === 'Numpad0') return 'zoomReset';
  return null;
}

// Next zoom factor from `current` in direction 1 / -1 (0 resets).
function nextZoom(current, dir) {
  if (!dir) return 1;
  const i = ZOOM_LEVELS.findIndex((z) => z >= current - 0.001);
  const at = i < 0 ? ZOOM_LEVELS.length - 1 : i;
  const exact = Math.abs(ZOOM_LEVELS[at] - current) < 0.001;
  const next = dir > 0 ? (exact ? at + 1 : at) : at - 1;
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, next))];
}

module.exports = { shortcutFor, nextZoom, ZOOM_LEVELS };
