// Bridge for the website view (plan 5.4). Exposes only
// window.onegyDesktop = { version, unlock() }, and only on the top-level frame
// of the configured server origin. The main process re-checks the sender
// frame before it asks the engine for the key.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const origin = arg('onegy-origin');
const version = arg('onegy-version') || '';

if (origin && window.location.origin === origin && window.top === window) {
  contextBridge.exposeInMainWorld('onegyDesktop', Object.freeze({
    version,
    // Resolves to the account master key (ArrayBuffer) or null.
    unlock: async () => {
      const b64 = await ipcRenderer.invoke('site:unlock');
      if (typeof b64 !== 'string' || !b64) return null;
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
      } catch {
        return null;
      }
    },
  }));
}
