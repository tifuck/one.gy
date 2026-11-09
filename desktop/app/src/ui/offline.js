// Offline page, shown in the site view when the website fails to load
// (window.js showOffline). Query: url (the page to retry, on the server),
// reason (Chromium's error text), theme. Retry, or going back online,
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
if (target) {
  document.title = `Can't reach ${target.host} · ONE.GY`;
  document.getElementById('title').textContent = `Can't reach ${target.host}`;
}
document.getElementById('detail').textContent = `Check your connection, then try again.${reason ? ` (${reason})` : ''}`;
document.getElementById('icon').innerHTML = ICONS.cloud;

const retry = document.getElementById('retry');
const go = () => { if (target) location.replace(target.href); };
retry.disabled = !target;
retry.addEventListener('click', go);
window.addEventListener('online', go);
retry.focus();
