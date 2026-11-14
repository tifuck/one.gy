// Removing a sync from the app. The engine never deletes local files; when
// the user also wants the local folder gone, it goes to the system trash, and
// only while <folder>/.onegy/sync.json still names this sync (checked before
// anything changes). Pure Node: the trash function is passed in.
'use strict';

const fs = require('fs/promises');
const path = require('path');

const fail = (code, message) => Object.assign(new Error(message), { code });

async function markerMatches(root, id) {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(root, '.onegy', 'sync.json'), 'utf8'));
    return Boolean(marker) && marker.sync_id === id;
  } catch (err) {
    // Missing or not JSON: not this sync's folder. Anything else (no access)
    // is the real reason nothing was changed.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err instanceof SyntaxError) return false;
    throw fail('marker_unreadable', `The sync marker in the local folder could not be read (${err.message}). Nothing was changed.`);
  }
}

// deps: { engine (call), trash(absPath) }; opts: { deleteLocal, releaseBackup }
async function removeSync({ engine, trash }, id, opts = {}) {
  if (typeof id !== 'string' || !id) throw fail('validation_failed', 'Unknown sync');
  const sync = ((await engine.call('syncs.list')) || []).find((s) => s.id === id);
  if (!sync) throw fail('not_found', 'This sync no longer exists.');
  const deleteLocal = opts.deleteLocal === true;
  if (deleteLocal && !(path.isAbsolute(sync.local_path) && await markerMatches(sync.local_path, id))) {
    throw fail('marker_mismatch', 'The local folder is missing or belongs to another sync. Nothing was changed.');
  }
  await engine.call('syncs.remove', { id, release_backup: opts.releaseBackup === true });
  if (deleteLocal) {
    try {
      await trash(sync.local_path);
    } catch (err) {
      throw fail('trash_failed', `The sync was removed, but the folder could not be moved to the trash: ${err.message}`);
    }
  }
  return { trashed: deleteLocal };
}

module.exports = { removeSync, markerMatches };
