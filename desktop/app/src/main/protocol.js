// The privileged app:// scheme: serves src/ui (native screens) with a strict
// CSP. Only app://ui/<file> under src/ui resolves; everything else is 404.
'use strict';

const path = require('path');
const fs = require('fs/promises');
const { protocol } = require('electron');

const SCHEME = 'app';
const HOST = 'ui';
const UI_ROOT = path.join(__dirname, '..', 'ui');
const UI_URL = `${SCHEME}://${HOST}/index.html`;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

// Must run before app 'ready'.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    // ES module scripts are fetched in CORS mode, even from the same origin.
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }]);
}

// Node's URL gives non-special schemes the origin "null", so compare parts.
function isUiUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === `${SCHEME}:` && url.host === HOST;
  } catch {
    return false;
  }
}

// Maps app://ui/<path> to a file under UI_ROOT, or null.
function resolveUiPath(requestUrl) {
  if (!isUiUrl(requestUrl)) return null;
  const url = new URL(requestUrl);
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return null; }
  const file = path.normalize(path.join(UI_ROOT, rel));
  if (!file.startsWith(UI_ROOT + path.sep)) return null;
  return TYPES[path.extname(file)] ? file : null;
}

function handleScheme(session) {
  session.protocol.handle(SCHEME, async (request) => {
    const file = resolveUiPath(request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.readFile(file);
      return new Response(body, {
        headers: {
          'Content-Type': TYPES[path.extname(file)],
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

module.exports = { registerScheme, handleScheme, resolveUiPath, isUiUrl, UI_URL };
