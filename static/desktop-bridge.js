/* desktop-bridge.js — website side of the ONE.GY Desktop site bridge
   (desktop/docs/site-bridge.md, v2+). Loaded by _nav.html on signed-in pages
   only. Inside the app it reveals the [data-desktop-sync] nav entries, drives
   their status indicator, reveals the rail's App settings button (bridge 3)
   and hides [data-hide-in-desktop]; in a normal browser (no
   window.onegyDesktop, or bridge < 2) it does nothing. */
(function () {
  'use strict';
  var app = window.onegyDesktop;
  if (!app || !(app.bridge >= 2)) return;
  document.documentElement.classList.add('is-desktop-app');

  if (typeof app.openSettings === 'function') {
    document.querySelectorAll('[data-desktop-settings]').forEach(function (el) {
      el.hidden = false;
      el.addEventListener('click', function () { app.openSettings({ username: el.getAttribute('data-username') || '' }); });
    });
  }

  var entries = document.querySelectorAll('[data-desktop-sync]');
  if (!entries.length) return;

  function count(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    return n > 99 ? '99+' : String(n);
  }
  function plural(n, one, many) { return count(n) + ' ' + (Number(n) === 1 ? one : many); }

  // state -> [tooltip, note shown next to the label]
  function describe(s) {
    switch (s.state) {
      case 'not_set_up': return ['Set up sync on this computer', 'Set up'];
      case 'syncing': return [s.pending > 0 ? 'Syncing, ' + plural(s.pending, 'transfer', 'transfers') + ' left' : 'Syncing', s.pending > 0 ? count(s.pending) : ''];
      case 'up_to_date': return ['Up to date', ''];
      case 'issues': return [plural(s.issues, 'sync issue needs', 'sync issues need') + ' a look', count(s.issues)];
      case 'paused': return ['Sync is paused', ''];
      case 'offline': return ['Offline. Sync resumes when the connection is back', ''];
      case 'locked': return ['Sync is locked. Enter your password to resume', ''];
      case 'other_account': return ['This computer syncs a different account', ''];
      default: return ['Sync', ''];
    }
  }

  function render(status) {
    var s = status && typeof status === 'object' ? status : {};
    var state = typeof s.state === 'string' ? s.state : '';
    var d = describe({ state: state, pending: Number(s.pending) || 0, issues: Number(s.issues) || 0 });
    entries.forEach(function (el) {
      el.setAttribute('data-sync-state', state);
      el.title = d[0];
      el.setAttribute('aria-label', 'Sync: ' + d[0]);
      var note = el.querySelector('.rd-sync-note');
      if (note) { note.textContent = d[1]; note.hidden = !d[1]; }
    });
  }

  entries.forEach(function (el) {
    el.addEventListener('click', function () {
      if (typeof app.openSync === 'function') app.openSync({ username: el.getAttribute('data-username') || '' });
    });
  });
  render(null);
  if (typeof app.onStatus === 'function') app.onStatus(render);
})();
