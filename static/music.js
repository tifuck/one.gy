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

  // ---- Rendering: shared bits ---------------------------------------------
  function loading () { view.innerHTML = '<div class="mu-skel" aria-hidden="true">' + new Array(13).join('<span class="rd-skel"></span>') + '</div>' }
  // at: [view, id] of the view being opened, so a UI update reload (core.js) comes back to it.
  function startView (at) { S.at = at; current = { tracks: [], albumName: '' }; loading(); view.scrollTop = 0; return ++viewEpoch }
  function isCurrentView (epoch) { return epoch === viewEpoch }

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
  function albumCard (a) {
    return '<button type="button" class="mu-card" data-album="' + esc(a.id) + '" title="' + esc(a.name) + '">' +
      '<span class="mu-card-art">' + cover(a.cover_path) + '<span class="mu-card-play" data-play-album="' + esc(a.id) + '" aria-hidden="true">' + ICON_PLAY + '</span></span>' +
      '<span class="mu-card-name">' + esc(a.name) + '</span>' +
      '<span class="mu-card-sub">' + esc([a.year, typeLabel(a.album_type)].filter(Boolean).join(' · ')) + '</span></button>'
  }
  function artistCard (a) {
    return '<button type="button" class="mu-card mu-card-artist" data-artist="' + esc(a.id) + '" title="' + esc(a.name) + '">' +
      '<span class="mu-card-art mu-round">' + cover(a.cover_path) + '</span>' +
      '<span class="mu-card-name">' + esc(a.name) + '</span>' +
      '<span class="mu-card-sub">' + plural(a.song_count || 0, 'song') + '</span></button>'
  }
  function trackRow (t, i, albumName, showArt) {
    var liked = S.likes.has(t.id)
    var unavailable = t.available === false
    var title = t.title || t.name, artists = artistNames(t.artists, t.featured_artists)
    return '<div class="mu-track' + (unavailable ? ' is-unavail' : '') + (t.id && t.id === currentTrackId() ? ' is-current' : '') + '" data-track-index="' + i + '" data-song-id="' + esc(t.id) + '"' + (unavailable ? '' : ' tabindex="0"') + '>' +
      '<span class="mu-track-num">' + esc(showArt ? i + 1 : (t.track_number || (i + 1))) + '<svg class="mu-track-play" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z"/></svg></span>' +
      (showArt ? '<span class="mu-track-art">' + cover(t.cover_path) + '</span>' : '') +
      '<span class="mu-track-main"><span class="mu-track-title" title="' + esc(title) + '">' + esc(title) + '</span><span class="mu-track-artist">' + esc(artists) + '</span></span>' +
      '<button type="button" class="mu-track-like' + (liked ? ' is-liked' : '') + '" data-like="' + esc(t.id) + '" aria-label="' + (liked ? 'Unlike' : 'Like') + '">' + ICON_HEART + '</button>' +
      '<span class="mu-track-dur">' + fmtDur(t.duration_ms) + '</span></div>'
  }
  function trackList (tracks, albumName, showArt) {
    return '<div class="mu-tracks">' + tracks.map(function (t, i) { return trackRow(t, i, albumName, showArt) }).join('') + '</div>'
  }
  function playButton () { return '<div class="mu-detail-actions"><button type="button" class="rd-btn rd-btn-primary" data-play-all>' + ICON_PLAY + 'Play</button></div>' }
  function detailHead (art, kicker, title, sub, facts, actions) {
    return '<header class="mu-detail-head"><div class="mu-detail-art' + (art.cls ? ' ' + art.cls : '') + '">' + art.html + '</div>' +
      '<div class="mu-detail-meta"><span class="mu-eyebrow">' + esc(kicker) + '</span><h2 class="mu-detail-title" title="' + esc(title) + '">' + esc(title) + '</h2>' +
      (sub ? '<div class="mu-detail-sub">' + esc(sub) + '</div>' : '') +
      '<div class="mu-detail-facts">' + esc(facts) + '</div>' + (actions || '') + '</div></header>'
  }
  function empty (title, text) {
    return '<div class="rd-empty mu-empty"><span class="rd-empty-icon">' + ICON_NOTE + '</span><h3 class="rd-empty-title">' + esc(title) + '</h3>' +
      (text ? '<p class="rd-empty-text">' + esc(text) + '</p>' : '') + '</div>'
  }

  // ---- Views ---------------------------------------------------------------
  var current = { tracks: [], albumName: '' }

  async function viewHome () {
    setActive('home'); crumbRoot('Home', viewHome); var epoch = startView(['home'])
    try {
      var d = await jget('/music/api/home')
      if (!isCurrentView(epoch)) return
      var h = ''
      if ((d.recently_added || []).length) h += sectionTitle('Recently added', '', 'albums') + '<div class="mu-shelf">' + d.recently_added.map(albumCard).join('') + '</div>'
      if ((d.top_artists || []).length) h += sectionTitle('Top artists', '', 'artists') + '<div class="mu-shelf mu-shelf-artists">' + d.top_artists.map(artistCard).join('') + '</div>'
      if ((d.all_albums || []).length) h += sectionTitle('Albums', String(d.all_albums.length)) + '<div class="mu-grid">' + d.all_albums.map(albumCard).join('') + '</div>'
      view.innerHTML = h || empty('Your library is empty', 'Songs added to the music library show up here.')
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load the library', 'Check your connection and try again.') }
  }
  async function viewAlbums () {
    setActive('albums'); crumbRoot('Albums', viewAlbums); var epoch = startView(['albums'])
    try { var d = await jget('/music/api/albums'); var arr = Array.isArray(d) ? d : (d.albums || [])
      if (!isCurrentView(epoch)) return
      view.innerHTML = arr.length ? sectionTitle('', plural(arr.length, 'album')) + '<div class="mu-grid">' + arr.map(albumCard).join('') + '</div>' : empty('No albums yet')
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load albums', 'Check your connection and try again.') }
  }
  async function viewArtists () {
    setActive('artists'); crumbRoot('Artists', viewArtists); var epoch = startView(['artists'])
    try { var d = await jget('/music/api/artists'); var arr = Array.isArray(d) ? d : (d.artists || [])
      if (!isCurrentView(epoch)) return
      view.innerHTML = arr.length ? sectionTitle('', plural(arr.length, 'artist')) + '<div class="mu-grid mu-grid-artists">' + arr.map(artistCard).join('') + '</div>' : empty('No artists yet')
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load artists', 'Check your connection and try again.') }
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
      var facts = [a.year, typeLabel(a.album_type), plural(tracks.length, 'track')].filter(Boolean).join(' · ')
      var h = detailHead({ html: cover(a.cover_path) }, 'Album', a.name, (a.artists || []).map(function (x) { return x.name }).join(', '), facts, tracks.length ? playButton() : '')
      h += tracks.length ? trackList(tracks, a.name, false) : empty('This album has no tracks')
      view.innerHTML = h
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this album', 'Check your connection and try again.') }
  }
  async function viewArtist (id, again) {
    if (!again) crumbPush('Artist', function () { viewArtist(id, true) })
    var epoch = startView(['artist', id])
    try {
      var r = await jget('/music/api/artist/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (r.error) { view.innerHTML = empty(r.error); return }
      var a = r.artist || r                                        // response is { artist, songs, albums }
      a.albums = r.albums || a.albums || []
      crumbLabel(a.name)
      var top = r.top_songs || r.songs || []
      var h = detailHead({ html: cover(a.cover_path), cls: 'mu-round' }, 'Artist', a.name, '', plural(a.albums.length, 'album'), top.length ? playButton() : '')
      // Queue exactly the rows shown: Play used to continue into hidden songs.
      if (top.length) { top = top.slice(0, 10); current = { tracks: top, albumName: '' }; h += sectionTitle('Popular') + trackList(top, '', true) }
      if (a.albums.length) h += sectionTitle('Albums', String(a.albums.length)) + '<div class="mu-grid">' + a.albums.map(albumCard).join('') + '</div>'
      view.innerHTML = h
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this artist', 'Check your connection and try again.') }
  }
  async function viewLiked () {
    setActive('liked'); crumbRoot('Liked songs', viewLiked); var epoch = startView(['liked'])
    try {
      var arr = await jget('/music/api/liked-songs')
      if (!isCurrentView(epoch)) return
      arr = Array.isArray(arr) ? arr : (arr.songs || [])
      current = { tracks: arr, albumName: '' }
      var h = detailHead({ html: ICON_HEART, cls: 'mu-liked-art' }, 'Playlist', 'Liked songs', '', plural(arr.length, 'song'), arr.length ? playButton() : '')
      h += arr.length ? trackList(arr, '', true) : empty('No liked songs yet', 'Tap the heart on any track to save it here.')
      view.innerHTML = h
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
      var h = detailHead({ html: p.cover_path ? cover(p.cover_path) : '<span class="mu-art-ph">' + ICON_LIST + '</span>' }, 'Playlist', p.name, p.description || '', plural(tracks.length, 'song'), tracks.length ? playButton() : '')
      h += tracks.length ? trackList(tracks, '', true) : empty('This playlist is empty', 'Add songs with the + button in the player.')
      view.innerHTML = h
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this playlist', 'Check your connection and try again.') }
  }
  async function viewSearch (q) {
    setActive(''); crumbRoot('Search', function () { viewSearch(q) }); var epoch = startView()
    try {
      var d = await jget('/music/api/search?q=' + encodeURIComponent(q))
      if (!isCurrentView(epoch)) return
      var h = ''
      if ((d.songs || []).length) { current = { tracks: d.songs, albumName: '' }; h += sectionTitle('Songs', String(d.songs.length)) + trackList(d.songs, '', true) }
      if ((d.albums || []).length) h += sectionTitle('Albums', String(d.albums.length)) + '<div class="mu-grid">' + d.albums.map(albumCard).join('') + '</div>'
      if ((d.artists || []).length) h += sectionTitle('Artists', String(d.artists.length)) + '<div class="mu-grid mu-grid-artists">' + d.artists.map(artistCard).join('') + '</div>'
      view.innerHTML = h || empty('No results for “' + q + '”', 'Try a different spelling or a shorter search.')
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
    if (v === 'home') viewHome(); else if (v === 'albums') viewAlbums(); else if (v === 'artists') viewArtists(); else if (v === 'liked') viewLiked()
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
      if (e.target.closest('[data-play-all]')) { playList(current.tracks, -1, current.albumName); return }
      var tr = e.target.closest('[data-track-index]'); if (tr) { playList(current.tracks, +tr.getAttribute('data-track-index'), current.albumName); return }
    })
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
    var open = at && { home: viewHome, albums: viewAlbums, artists: viewArtists, album: viewAlbum, artist: viewArtist, liked: viewLiked, playlist: viewPlaylist }[at[0]]
    if (open) open(at[1]); else if (!navigateFromHash()) viewHome()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
