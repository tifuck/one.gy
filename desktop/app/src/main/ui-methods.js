// Engine methods the native UI may call (ipc.js; dev/browser-bridge.js uses
// the same list). Not here on purpose: engine.shutdown, engine.subscribe,
// engine.environment (main process), account.webUnlockKey (site bridge only),
// account.webSession (main process: website sign-in tickets),
// diagnostics.export (path comes from a main-process save dialog),
// syncs.remove (app:removeSync, which may also trash the folder).
'use strict';

const UI_METHODS = new Set([
  'engine.info', 'engine.nudge', 'engine.clearCaches',
  'account.status', 'account.authorize', 'account.unlock', 'account.signOut',
  'account.appUnlock', 'account.appLock', 'account.setPin', 'account.removePin',
  'remote.list', 'remote.createFolder',
  'syncs.list', 'syncs.validate', 'syncs.preview', 'syncs.create', 'syncs.update',
  'syncs.pause', 'syncs.resume', 'syncs.syncNow', 'syncs.verify',
  'syncs.ignoreRules', 'syncs.setIgnoreRules', 'syncs.backupTarget', 'syncs.clearDebris',
  'versions.list', 'versions.restore',
  'transfers.list', 'transfers.pause', 'transfers.resume', 'transfers.cancel', 'transfers.clearCompleted',
  'issues.list', 'issues.resolve', 'issues.resolveAll',
  'settings.get', 'settings.set',
  'manual.upload', 'manual.download',
  'activity.recent',
]);

// Methods that may run for minutes (scans, uploads of big plans, snapshots).
const SLOW_METHODS = new Set(['syncs.validate', 'syncs.preview', 'syncs.create', 'syncs.verify', 'account.authorize',
  'account.unlock', 'account.appUnlock', 'account.setPin',
  'syncs.backupTarget', 'engine.clearCaches', 'versions.restore', 'syncs.clearDebris']);
const SLOW_TIMEOUT_MS = 10 * 60 * 1000;

module.exports = { UI_METHODS, SLOW_METHODS, SLOW_TIMEOUT_MS };
