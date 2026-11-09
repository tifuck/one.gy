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
- `openSync` opens the native panel (a second view over the site). It
  verifies the sender frame's origin in the main process before acting. The
  panel looks like a page of the site: the site's nav on top (see "Nav data")
  with Sync active, then the admin console layout (sidebar Syncs / Transfers /
  Issues / Settings, page head, panels), drawn with the site's own CSS that
  the app vendors from `static/` at build time (`desktop/app/scripts/vendor-site.js`).
  It shows "Set up sync on this computer" (username locked to the page's)
  when not authorized, a "This computer syncs <other>'s files" guard with
  "Sign out of sync on this computer" for `other_account`, else the sections.
  Clicking any other nav link (or Esc) closes it; the window title is
  "Sync · ONE.GY" while it is open. It becomes visible only after it has
  rendered the requested screen in the site's current theme (no flash).
- Once this computer is authorized, Ctrl+Shift+S and the tray's "Sync…" also
  open the panel.
- The tray offers "Open ONE.GY" and "Quit" always, and the status line,
  "Sync…", Pause / Resume and "Upload…" only once this computer is authorized.
- The panel follows the site's theme: the preload reports `html[data-theme]`
  (`frost` | `frost-dark`) on load and on every change (MutationObserver), and
  the panel's `<html data-theme>` follows it live. The panel's theme menu does
  not set the theme itself: the app asks the preload to click the site's own
  `[data-set-theme="<id>"]` option (so `theme-switch.js` persists it as on the
  website) and the panel then follows the reported theme. With no site page
  loaded (offline page) the app sets it directly.
- The panel's "Log out" asks the preload to submit the site's own
  `form.js-logout-form` (`requestSubmit`, so the site's submit hooks run),
  then closes the panel.

## Nav data (site preload -> app, no website change needed)

The panel never renders site markup. On every page load, and whenever the
site nav changes afterwards (notes badge, sync status), the preload reads
`header.rd-nav` from the live DOM and sends plain values (`site:nav`); the
main process validates them (`desktop/app/src/main/site-nav.js`) before the
panel gets them, and the panel renders them with text nodes and attribute
setters into the same markup as `templates/_nav.html`:

```js
{
  links: [{ label, href, active, badge }],   // .rd-nav-mid a.rd-nav-link; badge = visible .rd-badge count
  username, role,                            // .rd-menu-user b / span
  account: { label, short, href },           // avatar menu link; short = the drawer's label for it
  avatar,                                    // .rd-avatar-btn img src
}
```

- `href` and `avatar` are same-origin paths only (`/x`, never `//host`,
  no spaces or backslashes); labels are short plain text without control
  characters. Anything else is dropped.
- The app fetches the avatar with the site's session and hands the panel a
  `data:` URL (images only, at most 256 KB); the panel's CSP loads no remote
  content.
- The panel's Sync entry shows the same status dot and note as the site's
  (the app sends it the same `onStatus` value). The panel ignores `active`
  (Sync is the active entry there); the logo opens `/files`.
- The selectors above, `[data-set-theme]` and `form.js-logout-form` are part of
  this contract: renaming them in `_nav.html` needs the same change in the
  site preload (and `desktop/app/src/ui/nav.js` mirrors `_nav.html`'s markup).
- Syncs keep running when the user signs out of the website (the device stays
  authorized until removed in Settings or on `/account/devices`).
