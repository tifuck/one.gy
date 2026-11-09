// The website's nav as plain values for the sync panel's copy of it
// (desktop/docs/site-bridge.md, "Nav data"): validates what the site preload
// extracted from the live page, and turns the avatar into a data: URL because
// the panel's CSP loads no remote images. Never markup, only text and paths.
'use strict';

const MAX_LINKS = 12;
const MAX_AVATAR_BYTES = 256 * 1024;
const AVATAR_TYPES = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
// A path on the configured server: "/x...", never "//host" or with spaces/backslashes.
const isSitePath = (v) => typeof v === 'string' && v.length <= 2048 && /^\/(?!\/)[^\s\\]*$/.test(v);

// raw: what site-preload.js sends. Returns the cleaned nav, or null.
function cleanNav(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.links)) return null;
  const links = raw.links.slice(0, MAX_LINKS)
    .filter((l) => isPlainObject(l) && isText(l.label, 40) && isSitePath(l.href))
    .map((l) => ({
      label: l.label,
      href: l.href,
      active: l.active === true,
      badge: Number.isInteger(l.badge) && l.badge > 0 ? Math.min(l.badge, 9999) : 0,
    }));
  const a = raw.account;
  const account = isPlainObject(a) && isText(a.label, 60) && isSitePath(a.href)
    ? { label: a.label, short: isText(a.short, 40) ? a.short : a.label, href: a.href }
    : null;
  return {
    links,
    username: isText(raw.username, 80) ? raw.username : '',
    role: isText(raw.role, 40) ? raw.role : '',
    account,
    avatar: isSitePath(raw.avatar) ? raw.avatar : null,
  };
}

// fetchFn: the site session's fetch (cookies of the website). Resolves to a
// data: URL, or null for anything that is not a small image.
async function avatarDataUrl(fetchFn, url) {
  const res = await fetchFn(url, { redirect: 'error' });
  if (!res.ok) return null;
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!AVATAR_TYPES.has(type)) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.length || body.length > MAX_AVATAR_BYTES) return null;
  return `data:${type};base64,${body.toString('base64')}`;
}

module.exports = { cleanNav, avatarDataUrl, isSitePath };
