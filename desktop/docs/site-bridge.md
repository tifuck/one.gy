# Site bridge (website ↔ desktop app), version 2

How the one.gy website integrates with ONE.GY Desktop when it runs inside the
app. The website is the app's only UI chrome: there is no native sidebar,
toolbar or address bar. Native sync screens open as a panel over the site,
reached from the website's own navigation.

Owners: `desktop/app/src/preload/site-preload.js` (app side),
`static/desktop-bridge.js` + `templates/_nav.html` (website side).
Change both together and bump the version.

## API (exposed by the app's site preload)

Only on top-level frames whose origin equals the configured server origin.
Absent in normal browsers, so every website change must be a no-op without it.

```js
window.onegyDesktop = {
  version: '0.2.0',          // app version
  bridge: 2,                 // this contract's version
  unlock(): Promise<ArrayBuffer | null>,   // master key for crypto.js (v1, unchanged)
  openSync(opts): void,      // open the native sync panel
  onStatus(cb): () => void,  // subscribe to sync status; returns unsubscribe
}
```

- `openSync({ username, screen })`
  - `username` (required): the signed-in website user (`current_user.username`).
    The app refuses to show sync screens for a different account than the one
    this computer is authorized for, and offers to switch instead.
  - `screen` (optional): `'syncs'` (default) | `'transfers'` | `'issues'` | `'settings'`.
  - If this computer is not authorized yet, the panel starts at "Set up sync on
    this computer" (password + TOTP).
- `onStatus(cb)`: `cb` is called immediately (with the last known status, or
  as soon as the app answers on a fresh page) and on every change, at most
  twice a second, with `{ state, pending, issues }`:
  - `state`: `'not_set_up'` (no device authorized) | `'up_to_date'` | `'syncing'`
    | `'paused'` | `'issues'` | `'offline'` (also: the sync engine is not
    running) | `'locked'` (key needs the password)
    | `'other_account'` (authorized for a different user than the page's).
  - `pending`: number of queued transfers; `issues`: number of open issues
    (both 0 for `other_account`).
  - The page's user for `other_account` is the `data-username` of the first
    `[data-desktop-sync]` element (or the last `openSync` username). Usernames
    compare case-insensitively.

## Website side

- Only signed-in pages (the signed-in branch of `_nav.html`, shared by both page shells) load
  `static/desktop-bridge.js`. Anonymous pages (landing, login, shares) never
  show sync UI.
- When `window.onegyDesktop?.bridge >= 2`:
  - add `is-desktop-app` to `<html>`;
  - reveal the nav entry marked `[data-desktop-sync]` (hidden by default in
    CSS) labelled "Sync", with a small status indicator driven by `onStatus`
    (dot colour / count); click → `openSync({ username })`;
  - hide elements marked `[data-hide-in-desktop]` (e.g. "Download the desktop
    app" links).
- The username is read from a `data-username` attribute rendered by the
  template, never from the URL.

## App side

- The site view fills the whole window; the window title is the page title.
  Back/forward: Alt+←/→, mouse back/forward buttons; reload: Ctrl+R / F5
  (hard: Ctrl+Shift+R); zoom: Ctrl+= / Ctrl+- / Ctrl+0 (remembered); no visible
  browser controls. A page that fails to load is replaced by a local
  "Can't reach <server>" page with Retry.
- `openSync` opens the native panel (a second view over the site, with its own
  close button and Esc; tabs Syncs / Transfers / Issues / Settings). It
  verifies the sender frame's origin in the main process before acting. The
  panel shows "Set up sync on this computer" (username locked to the page's)
  when not authorized, a "This computer syncs <other>'s files" guard with
  "Sign out of sync on this computer" for `other_account`, else the tabs.
- Once this computer is authorized, Ctrl+Shift+S and the tray's "Sync…" also
  open the panel.
- The tray offers "Open ONE.GY" and "Quit" always, and the status line,
  "Sync…", Pause / Resume and "Upload…" only once this computer is authorized.
- The panel follows the site's theme: the preload reports `html[data-theme]`
  (`frost` | `frost-dark`) to the app.
- Syncs keep running when the user signs out of the website (the device stays
  authorized until removed in Settings or on `/account/devices`).
