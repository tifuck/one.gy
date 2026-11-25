/* ============================================================================
   music.js — Music browse controller (UI v2).
   Fetches the existing /music/api/* endpoints and renders the library views.
   Playback + queue + MediaSession + E2E decrypt are delegated to the existing
   window.MusicPlayer engine (music-player.js) via MusicPlayer.playMusicLibrary.
   ========================================================================== */
(function () {
  'use strict'

  var S = { view: 'home', likes: new Set(), playlists: [], lastCtx: null }
  var viewEpoch = 0, likeMutations = Object.create(null), likesReady = Promise.resolve()
  var $ = function (id) { return document.getElementById(id) }
  var view, railEl

  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function csrf () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : (window.CSRF || '') }
  function toast (m, c) { if (window.showToast) window.showToast(m, c) }
  async function jget (u) { var r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }); if (!r.ok) throw new Error(u); return r.json() }

  var ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
  var ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6.5h11M4 11.5h11M4 16.5h6"/><circle cx="17.5" cy="16.5" r="2.5"/><path d="M20 16.5V7l2-1"/></svg>'
  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z"/></svg>'
  var ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'
  var ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>'

  function coverUrl (p) { if (!p) return ''; var id = String(p).replace('covers/', '').replace('artists/', '').replace('.jpg', ''); return '/music/cover/' + encodeURIComponent(id) }
  function cover (p, cls) {
    if (p) return '<img class="' + (cls || '') + '" src="' + esc(coverUrl(p)) + '" alt="" loading="lazy">'
    return '<span class="mu-art-ph ' + (cls || '') + '">' + ICON_NOTE + '</span>'
  }
  function artistNames (arts, feat) {
    var a = (arts || []).map(function (x) { return x.name })
    if (feat && feat.length) a = a.concat(feat.map(function (x) { return x.name }))
    return a.join(', ')
  }
  function fmtDur (ms) { if (!ms) return '0:00'; var s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) }
  function plural (n, one) { return Number(n || 0).toLocaleString('en-US') + ' ' + one + (n === 1 ? '' : 's') }
  // API album_type is lowercase ('album' | 'single' | 'ep')
  function typeLabel (t) { t = String(t || ''); return t === 'ep' ? 'EP' : t.charAt(0).toUpperCase() + t.slice(1) }

  // ---- Playback ------------------------------------------------------------
  function toPlayable (t, albumName) {
    return { id: t.id, title: t.title || t.name, artists: (t.artists || []), album_name: t.album_name || albumName || '', cover_path: t.cover_path || null, duration_ms: t.duration_ms || 0 }
  }
  // index < 0: play from the first playable track ("Play" button).
  function playList (tracks, index, albumName) {
    if (typeof MusicPlayer === 'undefined' || !MusicPlayer.playMusicLibrary) { toast('PLAYER NOT READY', 'error'); return }
    // Re-map index to the filtered array by position (ids may repeat)
    var playable = [], start = index < 0 ? 0 : -1
    tracks.forEach(function (t, i) {
      if (t.available === false) return
      if (i === index) start = playable.length
      playable.push(toPlayable(t, albumName))
    })
    if (!playable.length) { toast('NO PLAYABLE TRACKS', 'error'); return }
    if (start < 0) { toast('TRACK UNAVAILABLE', 'error'); return }
    MusicPlayer.playMusicLibrary(playable, start)
    syncHearts()
  }
  // Card play button: start an album without opening it
  async function playAlbum (id) {
    try {
      var r = await jget('/music/api/album/' + encodeURIComponent(id))
      var a = r.album || r
      playList(r.tracks || a.tracks || [], -1, a.name)
    } catch (e) { toast('COULD NOT LOAD ALBUM', 'error') }
  }

  // ---- Likes ---------------------------------------------------------------
  async function loadLikes () {
    try {
      var d = await jget('/music/api/likes')
      var ids = Array.isArray(d) ? d : (d.liked_ids || d.likes || d.songs || [])
      S.likes = new Set(ids.map(function (x) { return typeof x === 'object' ? x.id : x }))
    } catch (e) {}
  }
  // The player's bar + fullscreen hearts follow S.likes for the current track
  // (only when `id`, if given, is still that track).
  function syncPlayerHeart (id) {
    if (typeof MusicPlayer === 'undefined' || !MusicPlayer.getCurrentTrackId) return
    var currentId = MusicPlayer.getCurrentTrackId()
    if (!currentId || (id && id !== currentId)) return
    var liked = S.likes.has(currentId)
    if (MusicPlayer.setBarHeartState) MusicPlayer.setBarHeartState(liked)
    if (MusicPlayer.setFsHeartState) MusicPlayer.setFsHeartState(liked)
  }
  function toggleLike (id) {
    var previous = likeMutations[id] || likesReady
    var mutation = previous.then(async function () {
      try {
        // Send the wanted state (not a server toggle) so a stale heart cannot flip it the wrong way
        var r = await fetch('/music/api/likes/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ liked: !S.likes.has(id) }) })
        if (!r.ok) throw new Error('like')
        var res = await r.json()
        if (typeof res.liked !== 'boolean') throw new Error('like')
        if (res.liked) S.likes.add(id); else S.likes.delete(id)
        syncHearts()
        syncPlayerHeart(id)
        updateLikedCount()
      } catch (e) { toast('COULD NOT UPDATE LIKE', 'error') }
    })
    likeMutations[id] = mutation
    mutation.then(function () { if (likeMutations[id] === mutation) delete likeMutations[id] })
  }
  function updateLikedCount () { var c = $('muLikedCount'); if (c) c.textContent = S.likes.size || '' }
  async function addSongTo (playlistId, songId) {
    try {
      var r = await fetch('/music/api/playlist/' + encodeURIComponent(playlistId) + '/songs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ action: 'add', song_id: songId }) })
      if (!r.ok) throw new Error('add')
      toast('ADDED TO PLAYLIST', 'success')
    } catch (e) { toast('COULD NOT ADD TO PLAYLIST', 'error') }
  }
  function addToPlaylistMenu (songId, button) {
    if (!S.playlists.length) { toast('CREATE A PLAYLIST FIRST', 'error'); return }
    if (!window.RdMenu) return
    var rect = button && button.getBoundingClientRect ? button.getBoundingClientRect() : { left: 0, bottom: 0 }
    window.RdMenu.open(rect.left, rect.bottom, [{ header: 'Add to playlist' }].concat(S.playlists.map(function (p) {
      return { label: p.name, action: function () { addSongTo(p.id, songId) } }
    })))
  }
  function syncHearts () {
    view.querySelectorAll('[data-like]').forEach(function (b) {
      var liked = S.likes.has(b.getAttribute('data-like'))
      b.classList.toggle('is-liked', liked)
      b.setAttribute('aria-label', liked ? 'Unlike' : 'Like')
    })
  }

  // ---- Now-playing highlight -------------------------------------------------
  function currentTrackId () { return (typeof MusicPlayer !== 'undefined' && MusicPlayer.getCurrentTrackId) ? MusicPlayer.getCurrentTrackId() : null }
  function syncPlaying () {
    var id = currentTrackId()
    view.querySelectorAll('.mu-track').forEach(function (r) { r.classList.toggle('is-current', !!id && r.getAttribute('data-song-id') === id) })
  }
  function setPaused (paused) { if (view) view.classList.toggle('is-paused', paused) }

  // ---- Cover tint ------------------------------------------------------------
  // One vivid colour per cover (canvas average weighted toward saturated
  // pixels, lightness pinned so white text reads on it). Drives the wash
  // behind the top of the page and the genre tiles.
  var tintCache = new Map(), washToken = 0
  function rgbToHsl (r, g, b) {
    r /= 255; g /= 255; b /= 255
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0, d = mx - mn
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
      h /= 6
    }
    return [h, s, l]
  }
  function hslToRgb (h, s, l) {
    function f (n) { var k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))) }
    return [f(0), f(8), f(4)]
  }
  function pickTint (d) {
    var r = 0, g = 0, b = 0, w = 0
    for (var i = 0; i < d.length; i += 4) {
      var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2])
      var sat = mx ? (mx - mn) / mx : 0, wt = sat * sat * (mx / 255) + 0.02
      r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt
    }
    var hsl = rgbToHsl(r / w, g / w, b / w)
    return 'rgb(' + hslToRgb(hsl[0], Math.min(0.8, Math.max(hsl[1] < 0.08 ? 0 : 0.35, hsl[1])), 0.4).join(' ') + ')'
  }
  function tintOf (p) {
    if (!p) return Promise.resolve(null)
    var url = coverUrl(p)
    if (!tintCache.has(url)) {
      tintCache.set(url, new Promise(function (res) {
        var img = new Image()
        img.onload = function () {
          try {
            var c = document.createElement('canvas'); c.width = c.height = 24
            var x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 24, 24)
            res(pickTint(x.getImageData(0, 0, 24, 24).data))
          } catch (e) { res(null) }
        }
        img.onerror = function () { res(null) }
        img.src = url
      }))
    }
    return tintCache.get(url)
  }
  // Page wash follows the open view; null falls back to the theme accent.
  function wash (p) {
    var main = view && view.parentNode, token = ++washToken
    if (!main) return
    if (!p) { main.style.removeProperty('--mu-tint'); return }
    tintOf(p).then(function (c) { if (token !== washToken) return; if (c) main.style.setProperty('--mu-tint', c); else main.style.removeProperty('--mu-tint') })
  }
  function paintTiles () {
    view.querySelectorAll('[data-tint]').forEach(function (el) {
      tintOf(el.getAttribute('data-tint')).then(function (c) { if (c) el.style.setProperty('--mu-tile', c) })
    })
  }

  // ---- Rendering: shared bits ---------------------------------------------
  function loading () { view.innerHTML = '<div class="mu-skel" aria-hidden="true">' + new Array(13).join('<span class="rd-skel"></span>') + '</div>' }
  // at: [view, id] of the view being opened, so a UI update reload (core.js) comes back to it.
  function startView (at) { S.at = at; current = { tracks: [], albumName: '' }; loading(); view.scrollTop = 0; return ++viewEpoch }
  function isCurrentView (epoch) { return epoch === viewEpoch }
  function render (h) { view.innerHTML = h; paintTiles() }

  // ---- Breadcrumb (toolbar) -------------------------------------------------
  // trail: [{ label, open }]. Rail views start a new trail, album / artist
  // pages push onto it; open(true) re-renders a crumb's view without pushing.
  var trail = []
  function renderCrumbs () {
    var el = $('muCrumbs'); if (!el) return
    el.innerHTML = trail.map(function (c, i) {
      return i < trail.length - 1
        ? '<button type="button" class="mu-bc-item" data-crumb="' + i + '" title="' + esc(c.label) + '">' + esc(c.label) + '</button><span class="mu-bc-sep" aria-hidden="true">' + ICON_CHEV + '</span>'
        : '<span class="mu-bc-item is-current" aria-current="page">' + esc(c.label) + '</span>'
    }).join('')
    var b = $('muBack'); if (b) b.hidden = trail.length < 2
  }
  function crumbRoot (label, open) { trail = [{ label: label, open: open }]; renderCrumbs() }
  function crumbPush (label, open) {
    if (!trail.length) trail = [{ label: 'Home', open: viewHome }]
    trail.push({ label: label, open: open })
    if (trail.length > 4) trail.splice(1, 1)   // root + the last three pages
    renderCrumbs()
  }
  function crumbLabel (label) { if (trail.length) trail[trail.length - 1].label = label; renderCrumbs() }
  function crumbGo (i) { var c = trail[i]; if (!c) return; trail = trail.slice(0, i + 1); renderCrumbs(); c.open(true) }
  // more: a rail view name for a "Show all" link
  function sectionTitle (t, sub, more) {
    return '<div class="mu-sec-head">' + (t ? '<h2 class="mu-h2">' + esc(t) + '</h2>' : '') + (sub ? '<span class="mu-sec-sub">' + esc(sub) + '</span>' : '') +
      (more ? '<button type="button" class="mu-sec-more" data-go="' + esc(more) + '">Show all</button>' : '') + '</div>'
  }
  function artistLinks (arts) {
    return (arts || []).map(function (x) {
      return x.id ? '<button type="button" class="mu-link" data-artist="' + esc(x.id) + '">' + esc(x.name) + '</button>' : esc(x.name)
    }).join(', ')
  }
  function year (a) { return a.year || String(a.release_date || '').slice(0, 4) }
  // sub: 'artist' (default) shows year + album artists, 'type' shows year + release type
  function albumCard (a, sub) {
    var line = sub === 'type' ? [year(a), typeLabel(a.album_type)] : [year(a), (a.artists || []).map(function (x) { return x.name }).join(', ')]
    return '<button type="button" class="mu-card" data-album="' + esc(a.id) + '" title="' + esc(a.name) + '">' +
      '<span class="mu-card-art">' + cover(a.cover_path) + '<span class="mu-card-play" data-play-album="' + esc(a.id) + '" aria-hidden="true">' + ICON_PLAY + '</span></span>' +
      '<span class="mu-card-name">' + esc(a.name) + '</span>' +
      '<span class="mu-card-sub">' + esc(line.filter(Boolean).join(' · ')) + '</span></button>'
  }
  function albumCardType (a) { return albumCard(a, 'type') }
  function artistCard (a) {
    return '<button type="button" class="mu-card mu-card-artist" data-artist="' + esc(a.id) + '" title="' + esc(a.name) + '">' +
      '<span class="mu-card-art mu-round">' + cover(a.cover_path) + '</span>' +
      '<span class="mu-card-name">' + esc(a.name) + '</span>' +
      '<span class="mu-card-sub">' + plural(a.song_count || 0, 'song') + '</span></button>'
  }
  function genreTile (g) {
    return '<button type="button" class="mu-genre" data-genre="' + esc(g.name) + '"' + (g.cover_path ? ' data-tint="' + esc(g.cover_path) + '"' : '') + '>' +
      '<span class="mu-genre-name">' + esc(g.name).replace(/\//g, '/<wbr>') + '</span><span class="mu-genre-sub">' + plural(g.song_count, 'song') + '</span>' +
      (g.cover_path ? '<span class="mu-genre-art">' + cover(g.cover_path) + '</span>' : '') + '</button>'
  }
  // opts.art: cover column (lists of mixed albums); opts.album: album column
  function trackRow (t, i, opts) {
    var liked = S.likes.has(t.id)
    var unavailable = t.available === false
    var title = t.title || t.name
    var artists = artistLinks((t.artists || []).concat(t.featured_artists || []))
    return '<div class="mu-track' + (unavailable ? ' is-unavail' : '') + (t.id && t.id === currentTrackId() ? ' is-current' : '') + '" data-track-index="' + i + '" data-song-id="' + esc(t.id) + '"' + (unavailable ? '' : ' tabindex="0"') + '>' +
      '<span class="mu-track-num">' + esc(opts.art ? i + 1 : (t.track_number || (i + 1))) + '<svg class="mu-track-play" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z"/></svg></span>' +
      (opts.art ? '<span class="mu-track-art">' + cover(t.cover_path) + '</span>' : '') +
      '<span class="mu-track-main"><span class="mu-track-title" title="' + esc(title) + '">' + esc(title) + '</span><span class="mu-track-artist">' + artists + '</span></span>' +
      (opts.album ? '<span class="mu-track-album">' + (t.album_id ? '<button type="button" class="mu-link" data-album="' + esc(t.album_id) + '">' + esc(t.album_name || '') + '</button>' : '') + '</span>' : '') +
      '<button type="button" class="mu-track-like' + (liked ? ' is-liked' : '') + '" data-like="' + esc(t.id) + '" aria-label="' + (liked ? 'Unlike' : 'Like') + '">' + ICON_HEART + '</button>' +
      '<span class="mu-track-dur">' + fmtDur(t.duration_ms) + '</span></div>'
  }
  var ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>'
  // opts: { art, album, discs }. Header row + rows; discs adds a heading per disc.
  function trackList (tracks, opts) {
    opts = opts || {}
    var head = '<div class="mu-thead" aria-hidden="true"><span>#</span>' + (opts.art ? '<span></span>' : '') + '<span>Title</span>' +
      (opts.album ? '<span class="mu-track-album">Album</span>' : '') + '<span></span><span class="mu-track-dur">' + ICON_CLOCK + '</span></div>'
    var multiDisc = opts.discs && tracks.some(function (t) { return (t.disc_number || 1) > 1 })
    var lastDisc = null
    return '<div class="mu-tracks' + (opts.art ? ' has-art' : '') + (opts.album ? ' has-album' : '') + '">' + head + tracks.map(function (t, i) {
      var h = ''
      if (multiDisc && (t.disc_number || 1) !== lastDisc) { lastDisc = t.disc_number || 1; h = '<div class="mu-disc">Disc ' + lastDisc + '</div>' }
      return h + trackRow(t, i, opts)
    }).join('') + '</div>'
  }
  // extra: HTML after the button (album genre chips)
  function playButton (extra) {
    return '<div class="mu-actions"><button type="button" class="mu-play-big" data-play-all aria-label="Play" title="Play">' + ICON_PLAY + '</button>' + (extra || '') + '</div>'
  }
  // art: { html, cls }; kicker: what this page is; meta: HTML (already escaped)
  function hero (art, kicker, title, meta, desc) {
    var len = String(title || '').length
    return '<header class="mu-hero"><div class="mu-hero-art' + (art.cls ? ' ' + art.cls : '') + '">' + art.html + '</div>' +
      '<div class="mu-hero-meta"><span class="mu-hero-kicker">' + esc(kicker) + '</span>' +
      '<h1 class="mu-hero-title' + (len > 40 ? ' is-xlong' : len > 18 ? ' is-long' : '') + '" title="' + esc(title) + '">' + esc(title) + '</h1>' +
      (desc ? '<p class="mu-hero-desc">' + esc(desc) + '</p>' : '') +
      '<div class="mu-hero-facts">' + meta + '</div></div></header>'
  }
  function facts (parts) { return parts.filter(Boolean).map(function (p) { return '<span>' + p + '</span>' }).join('') }
  function totalDur (tracks) {
    var ms = tracks.reduce(function (n, t) { return n + (t.available === false ? 0 : (t.duration_ms || 0)) }, 0)
    var m = Math.round(ms / 60000)
    return m >= 60 ? Math.floor(m / 60) + ' hr ' + (m % 60) + ' min' : (m ? m + ' min' : '')
  }
  function longDate (d) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(d || '')) return d || ''
    return new Date(d.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  }
  // Long track lists show 10 rows and a toggle for the rest.
  function moreToggle (n) { return n > 10 ? '<button type="button" class="mu-sec-more mu-show-more" data-more-tracks>Show all ' + n + '</button>' : '' }
  function empty (title, text) {
    return '<div class="rd-empty mu-empty"><span class="rd-empty-icon">' + ICON_NOTE + '</span><h3 class="rd-empty-title">' + esc(title) + '</h3>' +
      (text ? '<p class="rd-empty-text">' + esc(text) + '</p>' : '') + '</div>'
  }

  // ---- Views ---------------------------------------------------------------
  var current = { tracks: [], albumName: '' }

  function quickTile (attrs, art, name, tint) {
    return '<button type="button" class="mu-quick" ' + attrs + (tint ? ' data-wash="' + esc(tint) + '"' : '') + '><span class="mu-quick-art">' + art + '</span><span class="mu-quick-name">' + esc(name) + '</span></button>'
  }
  async function viewHome () {
    setActive('home'); crumbRoot('Home', viewHome); var epoch = startView(['home'])
    try {
      var d = await jget('/music/api/home')
      if (!isCurrentView(epoch)) return
      var recent = d.recently_added || [], h = ''
      // Quick picks: liked songs, playlists, then the newest additions (8 tiles)
      var quick = [quickTile('data-go="liked"', '<span class="mu-liked-art">' + ICON_HEART + '</span>', 'Liked songs')]
      S.playlists.slice(0, 3).forEach(function (p) { quick.push(quickTile('data-playlist="' + esc(p.id) + '"', p.cover_path ? cover(p.cover_path) : '<span class="mu-art-ph">' + ICON_LIST + '</span>', p.name, p.cover_path)) })
      recent.slice(0, 8 - quick.length).forEach(function (a) { quick.push(quickTile('data-album="' + esc(a.id) + '"', cover(a.cover_path), a.name, a.cover_path)) })
      if (recent.length) h += '<div class="mu-quick-grid">' + quick.join('') + '</div>'
      if (recent.length) h += sectionTitle('Recently added', '', 'albums') + '<div class="mu-shelf">' + recent.map(albumCard).join('') + '</div>'
      if ((d.new_releases || []).length) h += sectionTitle('New releases') + '<div class="mu-shelf">' + d.new_releases.map(albumCard).join('') + '</div>'
      if ((d.genres || []).length) h += sectionTitle('Browse by genre', '', 'genres') + '<div class="mu-shelf mu-shelf-genres">' + d.genres.map(genreTile).join('') + '</div>'
      if ((d.top_artists || []).length) h += sectionTitle('Top artists', '', 'artists') + '<div class="mu-shelf mu-shelf-artists">' + d.top_artists.map(artistCard).join('') + '</div>'
      S.homeWash = recent[0] && recent[0].cover_path
      wash(S.homeWash)
      render(h || empty('Your library is empty', 'Songs added to the music library show up here.'))
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load the library', 'Check your connection and try again.') }
  }

  // Albums: type filter chips + sort, kept for the session.
  var ALBUM_SORTS = [['added', 'Recently added'], ['release', 'Release date'], ['name', 'Name'], ['artist', 'Artist']]
  var ALBUM_TYPES = [['', 'All'], ['album', 'Albums'], ['single', 'Singles'], ['ep', 'EPs']]
  var albumPrefs = { type: '', sort: 'added' }
  try { Object.assign(albumPrefs, JSON.parse(localStorage.getItem('onegy_music_albums') || '{}')) } catch (e) {}
  function sortAlbums (arr, by) {
    var key = {
      added: function (a) { return a.added_at || '' },
      release: function (a) { return a.release_date || a.year || '' },
      name: function (a) { return (a.name || '').toLowerCase() },
      artist: function (a) { return ((a.artists || [])[0] || {}).name ? a.artists[0].name.toLowerCase() : '' }
    }[by] || function () { return '' }
    var desc = by === 'added' || by === 'release'
    return arr.slice().sort(function (x, y) { var a = key(x), b = key(y); return a === b ? 0 : ((a < b) !== desc ? -1 : 1) })
  }
  function renderAlbums (all) {
    var types = {}; all.forEach(function (a) { types[a.album_type] = 1 })
    if (albumPrefs.type && !types[albumPrefs.type]) albumPrefs.type = ''
    var arr = sortAlbums(all.filter(function (a) { return !albumPrefs.type || a.album_type === albumPrefs.type }), albumPrefs.sort)
    var chips = ALBUM_TYPES.filter(function (t) { return !t[0] || types[t[0]] }).map(function (t) {
      return '<button type="button" class="mu-chip' + (albumPrefs.type === t[0] ? ' is-on' : '') + '" data-album-type="' + t[0] + '" aria-pressed="' + (albumPrefs.type === t[0]) + '">' + t[1] + '</button>'
    }).join('')
    var sort = '<label class="mu-sort"><span class="mu-sort-label">Sort</span><select data-album-sort aria-label="Sort albums">' +
      ALBUM_SORTS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === albumPrefs.sort ? ' selected' : '') + '>' + o[1] + '</option>' }).join('') + '</select></label>'
    render('<div class="mu-filterbar"><div class="mu-chips" role="group" aria-label="Release type">' + chips + '</div>' + sort + '</div>' +
      sectionTitle('', plural(arr.length, albumPrefs.type ? typeLabel(albumPrefs.type).toLowerCase().replace(/s?$/, '') : 'release')) +
      '<div class="mu-grid">' + arr.map(albumCard).join('') + '</div>')
  }
  async function viewAlbums () {
    setActive('albums'); crumbRoot('Albums', viewAlbums); var epoch = startView(['albums']); wash(null)
    try { var d = await jget('/music/api/albums'); var arr = Array.isArray(d) ? d : (d.albums || [])
      if (!isCurrentView(epoch)) return
      S.albums = arr
      if (arr.length) renderAlbums(arr); else render(empty('No albums yet'))
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load albums', 'Check your connection and try again.') }
  }
  async function viewArtists () {
    setActive('artists'); crumbRoot('Artists', viewArtists); var epoch = startView(['artists']); wash(null)
    try { var d = await jget('/music/api/artists'); var arr = Array.isArray(d) ? d : (d.artists || [])
      if (!isCurrentView(epoch)) return
      render(arr.length ? sectionTitle('', plural(arr.length, 'artist')) + '<div class="mu-grid mu-grid-artists">' + arr.map(artistCard).join('') + '</div>' : empty('No artists yet'))
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load artists', 'Check your connection and try again.') }
  }
  async function viewGenres () {
    setActive('genres'); crumbRoot('Genres', viewGenres); var epoch = startView(['genres']); wash(null)
    try { var arr = await jget('/music/api/genres')
      if (!isCurrentView(epoch)) return
      render(arr.length ? sectionTitle('', plural(arr.length, 'genre')) + '<div class="mu-genre-grid">' + arr.map(genreTile).join('') + '</div>'
        : empty('No genres yet', 'Genres appear once songs in the library have been tagged.'))
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load genres', 'Check your connection and try again.') }
  }
  async function viewGenre (name, again) {
    if (!again) crumbPush(name, function () { viewGenre(name, true) })
    var epoch = startView(['genre', name])
    try {
      var r = await jget('/music/api/genre?name=' + encodeURIComponent(name))
      if (!isCurrentView(epoch)) return
      var songs = r.songs || [], albums = r.albums || [], artists = r.artists || []
      current = { tracks: songs, albumName: '' }
      var art = albums[0] && albums[0].cover_path
      wash(art)
      var h = hero({ html: '<span class="mu-genre-hero"' + (art ? ' data-tint="' + esc(art) + '"' : '') + '>' + esc(name.charAt(0)) + '</span>' }, 'Genre', name,
        facts([plural(r.genre.song_count, 'song'), plural(albums.length, 'release'), plural(artists.length, 'artist')]))
      if (songs.length) h += playButton() + '<div class="mu-collapsed">' + trackList(songs, { art: true, album: true }) + '</div>' + moreToggle(songs.length)
      if (albums.length) h += sectionTitle('Releases', String(albums.length)) + '<div class="mu-grid">' + albums.map(albumCard).join('') + '</div>'
      if (artists.length) h += sectionTitle('Artists', String(artists.length)) + '<div class="mu-shelf mu-shelf-artists">' + artists.map(artistCard).join('') + '</div>'
      render(h)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this genre', 'It may no longer have any songs.') }
  }
  async function viewAlbum (id, again) {
    if (!again) crumbPush('Album', function () { viewAlbum(id, true) })
    var epoch = startView(['album', id])
    try {
      var r = await jget('/music/api/album/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (r.error) { view.innerHTML = empty(r.error); return }
      var a = r.album || r, tracks = r.tracks || a.tracks || []   // response is { album, tracks }
      current = { tracks: tracks, albumName: a.name }
      crumbLabel(a.name)
      wash(a.cover_path)
      var count = a.total_tracks && a.total_tracks > tracks.length ? tracks.length + ' of ' + plural(a.total_tracks, 'song') : plural(tracks.length, 'song')
      var h = hero({ html: cover(a.cover_path) }, typeLabel(a.album_type) || 'Album', a.name,
        facts(['<strong>' + artistLinks(a.artists) + '</strong>', esc(year(a)), esc(count), esc(totalDur(tracks))]))
      var tags = (a.genres || []).length ? '<div class="mu-tags">' + a.genres.map(function (g) { return '<button type="button" class="mu-chip" data-genre="' + esc(g) + '">' + esc(g) + '</button>' }).join('') + '</div>' : ''
      if (tracks.length) h += playButton(tags); else h += tags
      h += tracks.length ? trackList(tracks, { discs: true }) : empty('This album has no tracks')
      if (a.release_date || a.label) h += '<footer class="mu-credits">' + (a.release_date ? '<div>' + esc(longDate(a.release_date)) + '</div>' : '') + (a.label ? '<div>' + esc(a.label) + '</div>' : '') + '</footer>'
      h += '<div id="muMoreBy"></div>'
      render(h)
      var first = (a.artists || [])[0]
      if (first && first.id) moreBy(first, a.id, epoch)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this album', 'Check your connection and try again.') }
  }
  async function moreBy (artist, albumId, epoch) {
    try {
      var arr = await jget('/music/api/albums?artist_id=' + encodeURIComponent(artist.id))
      var el = $('muMoreBy')
      if (!isCurrentView(epoch) || !el) return
      arr = (Array.isArray(arr) ? arr : []).filter(function (x) { return x.id !== albumId }).slice(0, 12)
      if (arr.length) { el.innerHTML = sectionTitle('More by ' + artist.name) + '<div class="mu-shelf">' + arr.map(albumCardType).join('') + '</div>' }
    } catch (e) {}
  }
  async function viewArtist (id, again) {
    if (!again) crumbPush('Artist', function () { viewArtist(id, true) })
    var epoch = startView(['artist', id])
    try {
      var r = await jget('/music/api/artist/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (r.error) { view.innerHTML = empty(r.error); return }
      var a = r.artist || r                                        // response is { artist, songs, albums, featuring_albums }
      var own = r.albums || [], feat = r.featuring_albums || []
      crumbLabel(a.name)
      wash(a.cover_path)
      var songs = r.songs || []
      var full = own.filter(function (x) { return x.album_type === 'album' || x.album_type === 'compilation' })
      var short = own.filter(function (x) { return full.indexOf(x) < 0 })
      var h = hero({ html: cover(a.cover_path), cls: 'mu-round' }, 'Artist', a.name, facts([plural(songs.length, 'song'), own.length ? plural(own.length, 'release') : '']))
      if (songs.length) {
        current = { tracks: songs, albumName: '' }
        h += playButton() + sectionTitle('Songs', String(songs.length)) + '<div class="mu-collapsed">' + trackList(songs, { art: true, album: true }) + '</div>' + moreToggle(songs.length)
      }
      if (full.length) h += sectionTitle('Albums', String(full.length)) + '<div class="mu-grid">' + full.map(albumCardType).join('') + '</div>'
      if (short.length) h += sectionTitle('Singles and EPs', String(short.length)) + '<div class="mu-grid">' + short.map(albumCardType).join('') + '</div>'
      if (feat.length) h += sectionTitle('Appears on', String(feat.length)) + '<div class="mu-grid">' + feat.map(albumCard).join('') + '</div>'
      render(h)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this artist', 'Check your connection and try again.') }
  }
  async function viewLiked () {
    setActive('liked'); crumbRoot('Liked songs', viewLiked); var epoch = startView(['liked']); wash(null)
    try {
      var arr = await jget('/music/api/liked-songs')
      if (!isCurrentView(epoch)) return
      arr = Array.isArray(arr) ? arr : (arr.songs || [])
      current = { tracks: arr, albumName: '' }
      var h = hero({ html: ICON_HEART, cls: 'mu-liked-art' }, 'Playlist', 'Liked songs', facts([USERNAME ? '<strong>' + esc(USERNAME) + '</strong>' : '', plural(arr.length, 'song'), esc(totalDur(arr))]))
      h += arr.length ? playButton() + trackList(arr, { art: true, album: true }) : empty('No liked songs yet', 'Tap the heart on any track to save it here.')
      render(h)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load liked songs', 'Check your connection and try again.') }
  }
  async function viewPlaylist (id) {
    var known = S.playlists.filter(function (p) { return String(p.id) === String(id) })[0]
    setActive('', id); crumbRoot(known ? known.name : 'Playlist', function () { viewPlaylist(id) }); var epoch = startView(['playlist', id])
    try {
      var p = await jget('/music/api/playlist/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (p.error) { view.innerHTML = empty(p.error); return }
      var tracks = p.songs || p.tracks || []
      current = { tracks: tracks, albumName: '' }
      crumbLabel(p.name)
      wash(p.cover_path)
      var h = hero({ html: p.cover_path ? cover(p.cover_path) : '<span class="mu-art-ph">' + ICON_LIST + '</span>' }, 'Playlist', p.name, facts([plural(tracks.length, 'song'), esc(totalDur(tracks))]), p.description || '')
      h += tracks.length ? playButton() + trackList(tracks, { art: true, album: true }) : empty('This playlist is empty', 'Add songs with the + button in the player.')
      render(h)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this playlist', 'Check your connection and try again.') }
  }
  async function viewSearch (q) {
    setActive(''); crumbRoot('Search', function () { viewSearch(q) }); var epoch = startView(); wash(null)
    try {
      var d = await jget('/music/api/search?q=' + encodeURIComponent(q))
      if (!isCurrentView(epoch)) return
      var h = ''
      if ((d.songs || []).length) { current = { tracks: d.songs, albumName: '' }; h += sectionTitle('Songs', String(d.songs.length)) + trackList(d.songs, { art: true, album: true }) }
      if ((d.albums || []).length) h += sectionTitle('Albums', String(d.albums.length)) + '<div class="mu-grid">' + d.albums.map(albumCard).join('') + '</div>'
      if ((d.artists || []).length) h += sectionTitle('Artists', String(d.artists.length)) + '<div class="mu-grid mu-grid-artists">' + d.artists.map(artistCard).join('') + '</div>'
      render(h || empty('No results for “' + q + '”', 'Try a different spelling or a shorter search.'))
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Search failed', 'Check your connection and try again.') }
  }

  // ---- Playlists in rail ---------------------------------------------------
  async function loadPlaylists () {
    try {
      var d = await jget('/music/api/playlists'); S.playlists = Array.isArray(d) ? d : (d.playlists || [])
      var list = $('muRailPlaylists'); if (!list) return
      list.innerHTML = S.playlists.map(function (p) {
        return '<button type="button" class="mu-rail-pl rd-side-row' + (S.playlistId === String(p.id) ? ' is-active' : '') + '" data-playlist="' + esc(p.id) + '" title="' + esc(p.name) + '">' + (p.cover_path ? cover(p.cover_path, 'mu-rail-pl-art') : '<span class="mu-rail-pl-art mu-art-ph">' + ICON_LIST + '</span>') + '<span class="mu-rail-pl-name">' + esc(p.name) + '</span></button>'
      }).join('') || '<div class="mu-rail-hint">No playlists yet</div>'
    } catch (e) {}
  }
  async function createPlaylist (name, desc) {
    try {
      var r = await fetch('/music/api/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ name: name, description: desc || '' }) })
      if (!r.ok) throw new Error()
      toast('PLAYLIST CREATED', 'success'); loadPlaylists()
    } catch (e) { toast('COULD NOT CREATE PLAYLIST', 'error') }
  }

  // ---- Nav helpers ---------------------------------------------------------
  // v: rail view name; plId: playlist id (playlist views)
  function setActive (v, plId) {
    S.view = v; S.playlistId = plId ? String(plId) : null
    railEl.querySelectorAll('[data-view]').forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-view') === v) })
    railEl.querySelectorAll('[data-playlist]').forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-playlist') === S.playlistId) })
  }
  function go (v) {
    if (v === 'home') viewHome(); else if (v === 'albums') viewAlbums(); else if (v === 'artists') viewArtists(); else if (v === 'genres') viewGenres(); else if (v === 'liked') viewLiked()
  }
  // Player title/artist links (window.MusicBrowse.navigate) and /music#album:<id> deep links
  function navigate (type, id) {
    if (type === 'album') viewAlbum(id); else if (type === 'artist') viewArtist(id); else return false
    return true
  }
  function navigateFromHash () {
    var m = /^#(album|artist):(.+)$/.exec(location.hash)
    if (!m) return false
    var id
    try { id = decodeURIComponent(m[2]) } catch (e) { return false }
    try { history.replaceState(null, '', location.pathname + location.search) } catch (e) {}
    return navigate(m[1], id)
  }

  // ---- Wiring --------------------------------------------------------------
  function wire () {
    railEl.addEventListener('click', function (e) {
      var v = e.target.closest('[data-view]'); if (v) { go(v.getAttribute('data-view')); closeRail(); return }
      var pl = e.target.closest('[data-playlist]'); if (pl) { viewPlaylist(pl.getAttribute('data-playlist')); closeRail(); return }
    })
    view.addEventListener('click', function (e) {
      var like = e.target.closest('[data-like]'); if (like) { e.stopPropagation(); toggleLike(like.getAttribute('data-like')); return }
      var pa = e.target.closest('[data-play-album]'); if (pa) { playAlbum(pa.getAttribute('data-play-album')); return }
      var more = e.target.closest('[data-go]'); if (more) { go(more.getAttribute('data-go')); return }
      var alb = e.target.closest('[data-album]'); if (alb) { viewAlbum(alb.getAttribute('data-album')); return }
      var art = e.target.closest('[data-artist]'); if (art) { viewArtist(art.getAttribute('data-artist')); return }
      var gen = e.target.closest('[data-genre]'); if (gen) { viewGenre(gen.getAttribute('data-genre')); return }
      var pl = e.target.closest('[data-playlist]'); if (pl) { viewPlaylist(pl.getAttribute('data-playlist')); return }
      var at = e.target.closest('[data-album-type]'); if (at) { albumPrefs.type = at.getAttribute('data-album-type'); savePrefs(); renderAlbums(S.albums || []); return }
      var mt = e.target.closest('[data-more-tracks]'); if (mt) { var c = mt.previousElementSibling; if (c) c.classList.remove('mu-collapsed'); mt.remove(); return }
      if (e.target.closest('[data-play-all]')) { playList(current.tracks, -1, current.albumName); return }
      var tr = e.target.closest('[data-track-index]'); if (tr) { playList(current.tracks, +tr.getAttribute('data-track-index'), current.albumName); return }
    })
    view.addEventListener('change', function (e) {
      if (e.target.matches('[data-album-sort]')) { albumPrefs.sort = e.target.value; savePrefs(); renderAlbums(S.albums || []) }
    })
    // Home quick tiles tint the page while hovered
    view.addEventListener('pointerover', function (e) {
      if (S.view !== 'home') return
      var q = e.target.closest('.mu-quick'); if (!q || q.contains(e.relatedTarget)) return
      wash(q.getAttribute('data-wash') || null)
    })
    view.addEventListener('pointerleave', function () { if (S.view === 'home') wash(S.homeWash) })
    // Track rows are focusable: Enter / Space plays
    view.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('mu-track')) { e.preventDefault(); e.target.click() }
    })

    // Player-bar likes (API call done by music-player.js) and the fullscreen
    // like/add buttons only dispatch these events; music.js owns the state.
    document.addEventListener('musicplayer:likechanged', function (e) {
      var d = e.detail; if (!d || !d.id) return
      if (d.liked) S.likes.add(d.id); else S.likes.delete(d.id)
      syncHearts(); updateLikedCount()
    })
    document.addEventListener('musicplayer:fslike', function (e) { if (e.detail && e.detail.id) toggleLike(e.detail.id) })
    document.addEventListener('musicplayer:trackchange', function (e) { if (e.detail && e.detail.id) { syncPlayerHeart(e.detail.id); syncPlaying() } })
    document.addEventListener('musicplayer:playpause', function (e) { setPaused(!(e.detail && e.detail.playing)) })
    document.addEventListener('musicplayer:fsadd', function (e) { if (e.detail && e.detail.id) addToPlaylistMenu(e.detail.id, e.detail.button) })

    var si = $('muSearch'), to = null
    if (si) si.addEventListener('input', function () { var q = this.value.trim(), epoch = ++viewEpoch; clearTimeout(to); to = setTimeout(function () { if (isCurrentView(epoch)) { q ? viewSearch(q) : viewHome() } }, 260) })

    var cr = $('muCrumbs'); if (cr) cr.addEventListener('click', function (e) { var c = e.target.closest('[data-crumb]'); if (c) crumbGo(+c.getAttribute('data-crumb')) })
    var bk = $('muBack'); if (bk) bk.onclick = function () { crumbGo(trail.length - 2) }
    var st = $('muRailToggle'); if (st) st.onclick = openRail
    var sc = $('muRailScrim'); if (sc) sc.onclick = closeRail

    // Create playlist modal
    var cpb = $('muCreatePl'); if (cpb) cpb.onclick = function () { openModal() }
    var mc = $('muPlSave'); if (mc) mc.onclick = function () { var n = $('muPlName').value.trim(); if (!n) { $('muPlName').focus(); return } closeModal(); createPlaylist(n, $('muPlDesc').value.trim()) }
    ;['muPlName', 'muPlDesc'].forEach(function (id) { var el = $(id); if (el) el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); mc.click() } }) })
    document.querySelectorAll('#muPlModal [data-rd-modal-close]').forEach(function (b) { b.onclick = closeModal })
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('muPlModal').classList.contains('rd-open')) closeModal() })
  }
  function savePrefs () { try { localStorage.setItem('onegy_music_albums', JSON.stringify(albumPrefs)) } catch (e) {} }
  function openRail () { $('muRail').classList.add('is-open'); $('muRailScrim').classList.add('is-open'); $('muRailToggle').setAttribute('aria-expanded', 'true') }
  function closeRail () { var r = $('muRail'); if (r) r.classList.remove('is-open'); var s = $('muRailScrim'); if (s) s.classList.remove('is-open'); var t = $('muRailToggle'); if (t) t.setAttribute('aria-expanded', 'false') }
  function openModal () { var m = $('muPlModal'); m.classList.add('rd-open'); m.setAttribute('aria-hidden', 'false'); $('muPlName').value = ''; $('muPlDesc').value = ''; setTimeout(function () { $('muPlName').focus() }, 30) }
  function closeModal () { var m = $('muPlModal'); m.classList.remove('rd-open'); m.setAttribute('aria-hidden', 'true') }

  // ---- Boot ----------------------------------------------------------------
  function boot () {
    if (window.MUSIC_DISABLED) return
    view = $('muView'); railEl = $('muRail')
    if (!view || !railEl) return
    wire()
    if (typeof MusicPlayer !== 'undefined' && MusicPlayer.init) { try { MusicPlayer.init('music-library') } catch (e) {} }
    if (typeof MusicPlayer !== 'undefined' && MusicPlayer.getAudioElement) setPaused(MusicPlayer.getAudioElement().paused)
    likesReady = loadLikes()
    likesReady.then(function () {
      updateLikedCount()
      syncPlayerHeart()
      syncHearts()
    })
    loadPlaylists()
    window.MusicBrowse = { navigate: navigate }
    window.addEventListener('onegy:update', function (e) { e.detail.music = S.at })
    var at = window.OneGyUpdate && OneGyUpdate.resume && OneGyUpdate.resume.music
    var open = at && { home: viewHome, albums: viewAlbums, artists: viewArtists, genres: viewGenres, genre: viewGenre, album: viewAlbum, artist: viewArtist, liked: viewLiked, playlist: viewPlaylist }[at[0]]
    if (open) open(at[1]); else if (!navigateFromHash()) viewHome()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
