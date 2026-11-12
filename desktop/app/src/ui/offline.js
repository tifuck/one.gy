// Offline page, shown in the site view when the website fails to load
// (window.js showOffline). Query: url (the page to retry, on the server),
// reason (Chromium's error text, or "HTTP 502" / "HTTP 504" from the server's
// proxy), theme, n (offline pages in a row). Retry,
// going back online, or the automatic retry (5 s, doubling up to a minute)
// replaces this page with the website again.
import { ICONS } from './components/icons.js';

const q = new URLSearchParams(location.search);
const theme = q.get('theme');
if (theme === 'frost' || theme === 'frost-dark') document.documentElement.dataset.theme = theme;

let target = null;
try {
  const u = new URL(q.get('url') || '');
  if (u.protocol === 'https:') target = u;
} catch { /* no retry target */ }

const reason = (q.get('reason') || '').slice(0, 200);
// The proxy answered for a server that is down: most often an update.
const gateway = /^HTTP 50[24]$/.test(reason);
const waitS = Math.min(60, 5 * 2 ** Math.min(4, Number(q.get('n')) || 0));
if (target) {
  const head = gateway ? `${target.host} is not responding` : `Can't reach ${target.host}`;
  document.title = `${head} · ONE.GY`;
  document.getElementById('title').textContent = head;
}
document.getElementById('detail').textContent = `${gateway ? 'It may be restarting' : 'Check your connection'}. Trying again in ${waitS} s.${reason ? ` (${reason})` : ''}`;
document.getElementById('icon').innerHTML = ICONS.cloud;

const retry = document.getElementById('retry');
const go = () => { if (target) location.replace(target.href); };
retry.disabled = !target;
retry.addEventListener('click', go);
window.addEventListener('online', go);
setTimeout(go, waitS * 1000);
retry.focus();
