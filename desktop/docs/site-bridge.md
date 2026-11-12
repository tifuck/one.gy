# Site bridge (website ↔ desktop app), version 3

How the one.gy website integrates with ONE.GY Desktop when it runs inside the
app. The app draws the window's title bar (drag area, back / forward /
reload, title, native window controls); everything below it is the website in
its **desktop shell**: a vertical rail as the app's navigation, no public
pages, no footer. Native screens (sign-in, lock, sync) open as a panel over
the site's content area, right of the rail.

Owners: `desktop/app/src/preload/site-preload.js` and `desktop/app/src/main/`
(app side); `static/desktop-bridge.js`, `templates/_nav.html`,
`static/desktop-shell.css` and `src/app/225_desktop_pages.py` (website side).
Change both together and bump the version when the JS API changes.

## Desktop shell (User-Agent token)

The app appends `ONEGY-Desktop/<app version>` to its site view's User-Agent.
For that token the server (`_is_desktop_app_request`, template flag
`desktop_app`):

- redirects the public pages (`/`, `/docs`, `/desktop`, `/share`,
  `/temp-upload`, `/prompts`, `/guest-files`) to `/files` when signed in, else
  to `/login`;
- renders `<html class="is-desktop-app">` and loads `desktop-shell.css` (both
  shells, so there is no flash), drops the footer and "Continue as guest";
- renders, in `_nav.html`, the rail `nav.dk-rail[data-desktop-rail]` instead
  of `header.rd-nav` on signed-in pages (Files, Notes, Music when enabled,
  Admin for admins, Sync; theme menu and account menu at the bottom), and no
  nav at all on anonymous pages (the sign-in card alone).

The token only picks the layout. Anyone can send it, so it never decides
access. Older apps without the token keep getting the website layout.
`--nav-h` is 0 in the shell, so pages start at the top of the view; fixed
layers that start at the left edge on the website are moved right of the rail
in `desktop-shell.css`.

## API (exposed by the app's site preload)

Only on top-level frames whose origin equals the configured server origin.
Absent in normal browsers, so every website change must be a no-op without it.

```js
window.onegyDesktop = {
  version: '0.5.0',          // app version
  bridge: 3,                 // this contract's version
  unlock(): Promise<ArrayBuffer | null>,   // master key for crypto.js (v1, unchanged)
  openSync(opts): void,      // open the native sync panel
  openSettings(opts): void,  // open the app's settings (v3)
  onStatus(cb): () => void,  // subscribe to sync status; returns unsubscribe
  onSyncs(cb): () => void,   // subscribe to this computer's syncs (v3); returns unsubscribe
}
```

Version 3 adds `openSettings` and `onSyncs`; feature-test them
(`typeof app.onSyncs === 'function'`), a v2 app has neither.

- `unlock()`: resolves to the master key only on a page signed in as the
  account this computer is authorized for (the page's `data-username`, see
  below, compared case-insensitively, and the server's `GET /desktop/whoami`
  `user_id`, fetched by the main process with the site's session), while the
  app is unlocked (app lock, engine-ipc.md) and the app's *Unlock the website*
  setting is on; otherwise `null` (anonymous pages, other accounts, not set up).
- `openSync({ username, screen })`
  - `username` (required): the signed-in website user (`current_user.username`).
    The app refuses to show sync screens for a different account than the one
    this computer is authorized for, and offers to switch instead.
  - `screen` (optional): `'syncs'` (default) | `'transfers'` | `'issues'` | `'settings'`.
  - If this computer is not authorized yet (the site was signed in without
    the app, see "Sign-in"), the panel starts at "Set up sync on this
    computer" (password + TOTP).
- `openSettings({ username, section })`: opens the panel on the app's own
  settings (sidebar General, Account, Security, Updates, About; `section` picks one, default `'general'`). They work in every state
  but the app lock; for `other_account` Account and Security show the
  switch-account guard. `username` as for `openSync`.
- `onSyncs(cb)`: like `onStatus`, with this computer's syncs: an array of
  `{ id, folder_id, type, state, pending, issues }`. `folder_id` is the
  one.gy folder (`null` = the drive root, type `full`); `type` is `two_way` |
  `backup` | `mirror` | `archive` | `full`; `state` is `up_to_date` |
  `syncing` | `paused` | `issues` | `offline` | `error` | `locked`. No local
  paths or names. Empty unless this computer is signed in as the page's user.
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

## Preload behaviour (no website JS involved)

- Theme: reports `html[data-theme]` (`frost` | `frost-dark`) on load and on
  every change; the title bar, the window controls and the panel follow it.
- Rail width: reports `[data-desktop-rail]`'s right edge in CSS px (0 without
  a rail) on load and on resize (`site:inset`); the panel starts there.
- Panel state: sets `html[data-desktop-panel]` to `sync` or `settings`
  while the panel is open, so the rail shows Sync or App settings as the
  current place (`desktop-shell.css`; v2 apps set it empty, which counts as
  `sync`). A click on a link in the rail while it is open closes the panel
  once the next page is there (`site:leavePanel`); a click on a rail menu
  button (`[data-menu-btn]`, whose popup opens under the panel) closes it at
  once (`site:leavePanel` with `{ now: true }`).
- Sign-out: a submit of `form.js-logout-form` is held (window capture phase,
  before the site's own hooks) and handed to the app (`site:logout`). With
  this computer signed in the app asks "Sign out of ONE.GY on this
  computer?", then ends the site session and revokes the device (syncs stop,
  local files stay) and shows its sign-in; otherwise the form goes through.
- `[data-desktop-rail]`, `[data-set-theme]`, `form.js-logout-form`,
  `[data-desktop-sync][data-username]` and `[data-desktop-settings]` are part
  of this contract: renaming them in `_nav.html` needs the same change in the
  site preload.

## Website side

- Only signed-in pages (the signed-in branches of `_nav.html`) load
  `static/desktop-bridge.js`. Anonymous pages never show sync UI.
- When `window.onegyDesktop?.bridge >= 2`:
  - add `is-desktop-app` to `<html>` (already rendered for the token);
  - reveal the entry marked `[data-desktop-sync]` (hidden by default in CSS)
    labelled "Sync", with a status dot / count driven by `onStatus`; click →
    `openSync({ username })`;
  - hide elements marked `[data-hide-in-desktop]` (e.g. "Download the desktop
    app" links);
  - with `openSettings` (v3): reveal the rail's gear `[data-desktop-settings]`
    (rendered `hidden`), "App settings"; click → `openSettings({ username })`.
- Files page (`files.js`, with `onSyncs`): a folder this computer syncs gets
  a sync mark after its name in the tree and the listing, coloured by
  `state`; the toolbar shows a sync icon after the path, coloured by state,
  in a sync's folder and anywhere below it, which opens the sync panel
  (Issues when the sync has some). Its tooltip and label give the type,
  state and what the type means ("Backup, Up to date. Backup of this
  computer, read-only on one.gy").
- The username is read from a `data-username` attribute rendered by the
  template, never from the URL.
- Updates (every page, `static/core.js`): `window.OneGyUpdate.busy()` is true
  while the page has something an update reload or restart would lose
  (network work in flight, crypto worker jobs, a cancelling `beforeunload`
  guard, playing media, text typed in the last 30 minutes that is still on
  screen, an element marked `data-update-hold`). The page reloads itself into
  a new UI build (`<meta name="onegy-build">` vs `GET /api/build`) when it is
  hidden or idle and not busy; the app needs nothing for that.

## App side

- Window: hidden native title bar with the native minimize / maximize / close
  as the title bar overlay (Windows: snap layouts; Linux: client-side frame),
  coloured from the title bar's own CSS. The title bar view
  (`src/ui/titlebar.html`) is the drag area and has back / forward / reload
  and the page title (the taskbar title adds "· ONE.GY"). Keys and mouse
  buttons too: Alt+←/→, mouse back/forward, Ctrl+R / F5 (hard: Ctrl+Shift+R),
  zoom Ctrl+= / Ctrl+- / Ctrl+0 (remembered). A page that fails to load, or
  a 502 or 504 from the server's proxy (the server restarting for an
  update; 503 is the server's own "busy" page and stays), is replaced by a
  local "Can't reach <server>" / "<server> is not responding" page with
  Retry that also retries by itself (5 s, doubling up to a minute).
- Updates: before an automatic update restart the app runs
  `window.OneGyUpdate.busy()` in the site page and waits while it is true.
  `GET /api/build` `desktop_min` is the oldest app version the server's sync
  API accepts; below it the update is required (checked for and restarted
  into even with automatic updates off, toast not dismissible).
- Sign-in: the app's own sign-in screen ("Sign in to ONE.GY": username,
  password, two-factor code when asked; server and computer name under a
  disclosure) is the only sign-in while this computer is signed out. It
  authorizes this computer (`account.authorize`) and the site follows with a
  one-use device ticket (`GET /desktop/session`, sync-api.md); then a short
  onboarding (PIN, what to sync, all skippable). The site's own sign-in page
  (desktop shell) only shows when there is no engine, or after "Continue
  without sync" when the server cannot do desktop sign-in.
- Device mode: when the site lands on `/login` (session expired or ended
  elsewhere) the app signs it in again with a fresh ticket, at most every
  30 s, and goes on to the page that was asked for.
- App lock: while the app is locked there is no site page at all (the view is
  dropped, its sessionStorage keys with it, and the site's cookies are
  cleared); the panel shows the lock screen. On unlock the app signs the view
  in with a ticket, so a set-up computer never shows the website's login.
  Right after sign-in the engine reports the app locked until its first
  unlock grant arrives; that is not treated as a lock.
- `openSync` opens the native panel over the content area (right of the
  rail, below the title bar). It verifies the sender frame's origin in the
  main process before acting. The panel uses the admin console layout
  (sidebar Syncs / Transfers / Issues / Settings, or for `openSettings` the
  App settings sections; page head, panels), drawn
  with the site's own CSS that the app vendors from `static/` at build time
  (`desktop/app/scripts/vendor-site.js`). Sign-in, lock and message screens
  are centred without the sidebar. It shows "Set up sync on this computer"
  (username locked to the page's) when not authorized, a "This computer
  syncs <other>'s files" guard with "Sign out of sync on this computer" for
  `other_account`, else the sections. Esc or a rail link closes it (never the
  sign-in or the lock screen). It becomes visible only after it has rendered
  the requested screen in the site's current theme (no flash).
- Once this computer is authorized, Ctrl+Shift+S and the tray's "Sync…" also
  open the panel.
- The tray offers "Open ONE.GY" and "Quit" always, and the status line,
  "Status and activity…", "Sync…", Pause / Resume and "Upload…" only once this
  computer is authorized.
- Once this computer is authorized and the app is unlocked, a left click on
  the tray icon (where the desktop reports one) and "Status and activity…"
  open the tray popover by the icon: overall state and speed, storage, each
  sync, transfers running and recently finished, open issues, with Pause /
  Resume, Upload, Open ONE.GY and links into the panel. It reads only
  `account.status`, `syncs.list`, `transfers.list` and `issues.list` and hides
  when it loses focus, on Esc, and when the app locks or signs out. GNOME's
  AppIndicator opens the menu on a single click and activates (the popover)
  on a double click. GNOME on Wayland lets no app place its windows, so the
  app restarts itself under XWayland there (`--ozone-platform=x11`; app
  setting `linux_x11`, an explicit `--ozone-platform` wins) and opens the
  popover under the top bar's right end.
