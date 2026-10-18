/* ============================================================================
   music.js — Frost Music browse controller (from scratch).
   Fetches the existing /music/api/* endpoints and renders a fresh frost UI.
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

  function coverUrl (p) { if (!p) return ''; var id = String(p).replace('covers/', '').replace('artists/', '').replace('.jpg', ''); return '/music/cover/' + encodeURIComponent(id) }
  function cover (p, cls) {
    if (p) return '<img class="' + (cls || '') + '" src="' + esc(coverUrl(p)) + '" alt="" loading="lazy">'
    return '<div class="mu-art-ph ' + (cls || '') + '"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>'
  }
  function artistNames (arts, feat) {
    var a = (arts || []).map(function (x) { return x.name })
    if (feat && feat.length) a = a.concat(feat.map(function (x) { return x.name }))
    return a.join(', ')
  }
  function fmtDur (ms) { if (!ms) return '0:00'; var s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) }

  // ---- Playback ------------------------------------------------------------
  function toPlayable (t, albumName) {
    return { id: t.id, title: t.title || t.name, artists: (t.artists || []), album_name: t.album_name || albumName || '', cover_path: t.cover_path || null, duration_ms: t.duration_ms || 0 }
  }
  function playList (tracks, index, albumName) {
    if (typeof MusicPlayer === 'undefined' || !MusicPlayer.playMusicLibrary) { toast('PLAYER NOT READY', 'error'); return }
    var playable = tracks.filter(function (t) { return t.available !== false }).map(function (t) { return toPlayable(t, albumName) })
    if (!playable.length) { toast('NO PLAYABLE TRACKS', 'error'); return }
    // Re-map index to the filtered array
    var startId = tracks[index] && tracks[index].id
    var start = Math.max(0, playable.findIndex(function (t) { return t.id === startId }))
    MusicPlayer.playMusicLibrary(playable, start)
    syncHearts()
  }

  // ---- Likes ---------------------------------------------------------------
  async function loadLikes () {
    try {
      var d = await jget('/music/api/likes')
      var ids = Array.isArray(d) ? d : (d.liked_ids || d.likes || d.songs || [])
      S.likes = new Set(ids.map(function (x) { return typeof x === 'object' ? x.id : x }))
    } catch (e) {}
  }
  function toggleLike (id) {
    var previous = likeMutations[id] || likesReady
    var mutation = previous.then(async function () {
      try {
        var r = await fetch('/music/api/likes/' + encodeURIComponent(id), { method: 'POST', headers: { 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' } })
        if (!r.ok) throw new Error('like')
        var res = await r.json()
        var liked = res.liked
        if (liked) S.likes.add(id); else S.likes.delete(id)
        syncHearts()
        if (MusicPlayer.getCurrentTrackId && MusicPlayer.getCurrentTrackId() === id) { if (MusicPlayer.setBarHeartState) MusicPlayer.setBarHeartState(liked); if (MusicPlayer.setFsHeartState) MusicPlayer.setFsHeartState(liked) }
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
    window.RdMenu.open(rect.left, rect.bottom, [{ header: 'ADD TO PLAYLIST' }].concat(S.playlists.map(function (p) {
      return { label: p.name, action: function () { addSongTo(p.id, songId) } }
    })))
  }
  function syncHearts () { view.querySelectorAll('[data-like]').forEach(function (b) { b.classList.toggle('is-liked', S.likes.has(b.getAttribute('data-like'))) }) }

  // ---- Rendering: shared bits ---------------------------------------------
  function loading () { view.innerHTML = '<div class="mu-loading"><span class="mu-spin"></span></div>' }
  function startView () { current = { tracks: [], albumName: '' }; loading(); return ++viewEpoch }
  function isCurrentView (epoch) { return epoch === viewEpoch }
  function sectionTitle (t, sub) { return '<div class="mu-sec-head"><h2 class="mu-h2">' + esc(t) + '</h2>' + (sub ? '<span class="mu-sec-sub">' + esc(sub) + '</span>' : '') + '</div>' }
  function albumCard (a) {
    return '<button class="mu-card" data-album="' + esc(a.id) + '">' +
      '<span class="mu-card-art">' + cover(a.cover_path) + '<span class="mu-card-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg></span></span>' +
      '<span class="mu-card-name">' + esc(a.name) + '</span>' +
      '<span class="mu-card-sub">' + esc([a.year, (a.album_type || '').toUpperCase()].filter(Boolean).join(' · ')) + '</span></button>'
  }
  function artistCard (a) {
    return '<button class="mu-card mu-card-artist" data-artist="' + esc(a.id) + '">' +
      '<span class="mu-card-art mu-round">' + cover(a.cover_path) + '</span>' +
      '<span class="mu-card-name">' + esc(a.name) + '</span>' +
      '<span class="mu-card-sub">' + (a.song_count || 0) + ' songs</span></button>'
  }
  function trackRow (t, i, albumName, showArt) {
    var liked = S.likes.has(t.id)
    var unavailable = t.available === false
    return '<div class="mu-track' + (unavailable ? ' is-unavail' : '') + '" data-track-index="' + i + '" data-song-id="' + esc(t.id) + '">' +
      '<span class="mu-track-num">' + (t.track_number || (i + 1)) + '<svg class="mu-track-play" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg></span>' +
      (showArt ? '<span class="mu-track-art">' + cover(t.cover_path) + '</span>' : '') +
      '<span class="mu-track-main"><span class="mu-track-title">' + esc(t.title || t.name) + '</span><span class="mu-track-artist">' + esc(artistNames(t.artists, t.featured_artists)) + '</span></span>' +
      '<button class="mu-track-like' + (liked ? ' is-liked' : '') + '" data-like="' + esc(t.id) + '" aria-label="Like"><svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></button>' +
      '<span class="mu-track-dur">' + fmtDur(t.duration_ms) + '</span></div>'
  }
  function empty (msg) { return '<div class="mu-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M9 15c.8-.8 2-1.3 3-1.3s2.2.5 3 1.3"/></svg><p>' + esc(msg) + '</p></div>' }

  // ---- Views ---------------------------------------------------------------
  var current = { tracks: [], albumName: '' }

  async function viewHome () {
    setActive('home'); var epoch = startView()
    try {
      var d = await jget('/music/api/home')
      if (!isCurrentView(epoch)) return
      var h = ''
      if ((d.recently_added || []).length) h += sectionTitle('Recently added') + '<div class="mu-grid">' + d.recently_added.map(albumCard).join('') + '</div>'
      if ((d.top_artists || []).length) h += sectionTitle('Top artists') + '<div class="mu-grid">' + d.top_artists.map(artistCard).join('') + '</div>'
      if ((d.all_albums || []).length) h += sectionTitle('All albums') + '<div class="mu-grid">' + d.all_albums.map(albumCard).join('') + '</div>'
      view.innerHTML = h || empty('No music in the library yet.')
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load the library.') }
  }
  async function viewAlbums () {
    setActive('albums'); var epoch = startView()
    try { var d = await jget('/music/api/albums'); var arr = Array.isArray(d) ? d : (d.albums || [])
      if (!isCurrentView(epoch)) return
      view.innerHTML = sectionTitle('Albums', arr.length + ' total') + '<div class="mu-grid">' + arr.map(albumCard).join('') + '</div>'
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load albums.') }
  }
  async function viewArtists () {
    setActive('artists'); var epoch = startView()
    try { var d = await jget('/music/api/artists'); var arr = Array.isArray(d) ? d : (d.artists || [])
      if (!isCurrentView(epoch)) return
      view.innerHTML = sectionTitle('Artists', arr.length + ' total') + '<div class="mu-grid">' + arr.map(artistCard).join('') + '</div>'
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load artists.') }
  }
  async function viewAlbum (id) {
    var epoch = startView()
    try {
      var r = await jget('/music/api/album/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (r.error) { view.innerHTML = empty(r.error); return }
      var a = r.album || r, tracks = r.tracks || a.tracks || []   // response is { album, tracks }
      current = { tracks: tracks, albumName: a.name }
      var meta = [a.year, (a.album_type || '').toUpperCase(), tracks.length + ' tracks'].filter(Boolean).join(' · ')
      var h = '<div class="mu-detail-head">' +
        '<div class="mu-detail-art">' + cover(a.cover_path) + '</div>' +
        '<div class="mu-detail-meta"><span class="mu-eyebrow">Album</span><h1 class="mu-detail-title">' + esc(a.name) + '</h1>' +
        '<div class="mu-detail-sub">' + esc((a.artists || []).map(function (x) { return x.name }).join(', ')) + '</div>' +
        '<div class="mu-detail-facts">' + esc(meta) + '</div>' +
        '<div class="mu-detail-actions"><button class="rd-btn rd-btn-primary" data-play-all><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg> Play</button></div></div></div>'
      h += '<div class="mu-tracks">' + tracks.map(function (t, i) { return trackRow(t, i, a.name, false) }).join('') + '</div>'
      view.innerHTML = h
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this album.') }
  }
  async function viewArtist (id) {
    var epoch = startView()
    try {
      var r = await jget('/music/api/artist/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (r.error) { view.innerHTML = empty(r.error); return }
      var a = r.artist || r                                        // response is { artist, songs, albums }
      a.albums = r.albums || a.albums || []
      var h = '<div class="mu-detail-head">' +
        '<div class="mu-detail-art mu-round">' + cover(a.cover_path) + '</div>' +
        '<div class="mu-detail-meta"><span class="mu-eyebrow">Artist</span><h1 class="mu-detail-title">' + esc(a.name) + '</h1>' +
        '<div class="mu-detail-facts">' + (a.albums.length) + ' albums</div></div></div>'
      var top = r.top_songs || r.songs || []
      if (top.length) { current = { tracks: top, albumName: '' }; h += sectionTitle('Popular') + '<div class="mu-tracks">' + top.slice(0, 10).map(function (t, i) { return trackRow(t, i, '', true) }).join('') + '</div>' }
      if ((a.albums || []).length) h += sectionTitle('Albums') + '<div class="mu-grid">' + a.albums.map(albumCard).join('') + '</div>'
      view.innerHTML = h
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this artist.') }
  }
  async function viewLiked () {
    setActive('liked'); var epoch = startView()
    try {
      var arr = await jget('/music/api/liked-songs')
      if (!isCurrentView(epoch)) return
      arr = Array.isArray(arr) ? arr : (arr.songs || [])
      current = { tracks: arr, albumName: '' }
      var h = '<div class="mu-detail-head mu-liked-head"><div class="mu-detail-art mu-liked-art"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>' +
        '<div class="mu-detail-meta"><span class="mu-eyebrow">Playlist</span><h1 class="mu-detail-title">Liked Songs</h1><div class="mu-detail-facts">' + arr.length + ' songs</div>' +
        (arr.length ? '<div class="mu-detail-actions"><button class="rd-btn rd-btn-primary" data-play-all><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg> Play</button></div>' : '') + '</div></div>'
      h += arr.length ? ('<div class="mu-tracks">' + arr.map(function (t, i) { return trackRow(t, i, '', true) }).join('') + '</div>') : empty('No liked songs yet. Tap the heart on any track.')
      view.innerHTML = h
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load liked songs.') }
  }
  async function viewPlaylist (id) {
    var epoch = startView()
    try {
      var p = await jget('/music/api/playlist/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (p.error) { view.innerHTML = empty(p.error); return }
      var tracks = p.songs || p.tracks || []
      current = { tracks: tracks, albumName: '' }
      var h = '<div class="mu-detail-head"><div class="mu-detail-art">' + (p.cover_path ? cover(p.cover_path) : '<div class="mu-art-ph"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg></div>') + '</div>' +
        '<div class="mu-detail-meta"><span class="mu-eyebrow">Playlist</span><h1 class="mu-detail-title">' + esc(p.name) + '</h1>' +
        (p.description ? '<div class="mu-detail-sub">' + esc(p.description) + '</div>' : '') +
        '<div class="mu-detail-facts">' + tracks.length + ' songs</div>' +
        (tracks.length ? '<div class="mu-detail-actions"><button class="rd-btn rd-btn-primary" data-play-all><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg> Play</button></div>' : '') + '</div></div>'
      h += tracks.length ? ('<div class="mu-tracks">' + tracks.map(function (t, i) { return trackRow(t, i, '', true) }).join('') + '</div>') : empty('This playlist is empty.')
      view.innerHTML = h
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this playlist.') }
  }
  async function viewSearch (q) {
    var epoch = startView()
    try {
      var d = await jget('/music/api/search?q=' + encodeURIComponent(q))
      if (!isCurrentView(epoch)) return
      var h = ''
      if ((d.songs || []).length) { current = { tracks: d.songs, albumName: '' }; h += sectionTitle('Songs') + '<div class="mu-tracks">' + d.songs.map(function (t, i) { return trackRow(t, i, '', true) }).join('') + '</div>' }
      if ((d.albums || []).length) h += sectionTitle('Albums') + '<div class="mu-grid">' + d.albums.map(albumCard).join('') + '</div>'
      if ((d.artists || []).length) h += sectionTitle('Artists') + '<div class="mu-grid">' + d.artists.map(artistCard).join('') + '</div>'
      view.innerHTML = h || empty('No results for “' + esc(q) + '”.')
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Search failed.') }
  }

  // ---- Playlists in rail ---------------------------------------------------
  async function loadPlaylists () {
    try {
      var d = await jget('/music/api/playlists'); S.playlists = Array.isArray(d) ? d : (d.playlists || [])
      var list = $('muRailPlaylists'); if (!list) return
      list.innerHTML = S.playlists.map(function (p) {
        return '<button class="mu-rail-pl rd-side-row" data-playlist="' + esc(p.id) + '">' + (p.cover_path ? cover(p.cover_path, 'mu-rail-pl-art') : '<span class="mu-rail-pl-art mu-art-ph"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg></span>') + '<span class="mu-rail-pl-name">' + esc(p.name) + '</span></button>'
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
  function setActive (v) { S.view = v; railEl.querySelectorAll('[data-view]').forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-view') === v) }) }
  function go (v) {
    if (v === 'home') viewHome(); else if (v === 'albums') viewAlbums(); else if (v === 'artists') viewArtists(); else if (v === 'liked') viewLiked()
  }

  // ---- Wiring --------------------------------------------------------------
  function wire () {
    railEl.addEventListener('click', function (e) {
      var v = e.target.closest('[data-view]'); if (v) { go(v.getAttribute('data-view')); closeRail(); return }
      var pl = e.target.closest('[data-playlist]'); if (pl) { railEl.querySelectorAll('[data-view]').forEach(function (b) { b.classList.remove('is-active') }); viewPlaylist(pl.getAttribute('data-playlist')); closeRail(); return }
    })
    view.addEventListener('click', function (e) {
      var like = e.target.closest('[data-like]'); if (like) { e.stopPropagation(); toggleLike(like.getAttribute('data-like')); return }
      var alb = e.target.closest('[data-album]'); if (alb) { viewAlbum(alb.getAttribute('data-album')); return }
      var art = e.target.closest('[data-artist]'); if (art) { viewArtist(art.getAttribute('data-artist')); return }
      if (e.target.closest('[data-play-all]')) { playList(current.tracks, 0, current.albumName); return }
      var tr = e.target.closest('[data-track-index]'); if (tr) { playList(current.tracks, +tr.getAttribute('data-track-index'), current.albumName); return }
    })

    // Player-bar likes (API call done by music-player.js) and the fullscreen
    // like/add buttons only dispatch these events; music.js owns the state.
    document.addEventListener('musicplayer:likechanged', function (e) {
      var d = e.detail; if (!d || !d.id) return
      if (d.liked) S.likes.add(d.id); else S.likes.delete(d.id)
      syncHearts(); updateLikedCount()
    })
    document.addEventListener('musicplayer:fslike', function (e) { if (e.detail && e.detail.id) toggleLike(e.detail.id) })
    document.addEventListener('musicplayer:fsadd', function (e) { if (e.detail && e.detail.id) addToPlaylistMenu(e.detail.id, e.detail.button) })

    var si = $('muSearch'), to = null
    if (si) si.addEventListener('input', function () { var q = this.value.trim(), epoch = ++viewEpoch; clearTimeout(to); to = setTimeout(function () { if (isCurrentView(epoch)) { q ? viewSearch(q) : viewHome() } }, 260) })

    var st = $('muRailToggle'); if (st) st.onclick = openRail
    var sc = $('muRailScrim'); if (sc) sc.onclick = closeRail

    // Create playlist modal
    var cpb = $('muCreatePl'); if (cpb) cpb.onclick = function () { openModal() }
    var mc = $('muPlSave'); if (mc) mc.onclick = function () { var n = $('muPlName').value.trim(); if (!n) return; closeModal(); createPlaylist(n, $('muPlDesc').value.trim()) }
    document.querySelectorAll('#muPlModal [data-rd-modal-close]').forEach(function (b) { b.onclick = closeModal })
  }
  function openRail () { $('muRail').classList.add('is-open'); $('muRailScrim').classList.add('is-open') }
  function closeRail () { var r = $('muRail'); if (r) r.classList.remove('is-open'); var s = $('muRailScrim'); if (s) s.classList.remove('is-open') }
  function openModal () { var m = $('muPlModal'); m.classList.add('rd-open'); m.setAttribute('aria-hidden', 'false'); $('muPlName').value = ''; $('muPlDesc').value = ''; setTimeout(function () { $('muPlName').focus() }, 30) }
  function closeModal () { var m = $('muPlModal'); m.classList.remove('rd-open'); m.setAttribute('aria-hidden', 'true') }

  // ---- Boot ----------------------------------------------------------------
  function boot () {
    if (window.MUSIC_DISABLED) return
    view = $('muView'); railEl = $('muRail')
    if (!view || !railEl) return
    // Entrance stagger: every view swap replaces #muView's children; set --i
    // per card/track before first paint so music.css can stagger the delays
    // (indices reset per grid so each home section starts its own cascade)
    new MutationObserver(function () {
      var i
      view.querySelectorAll('.mu-grid').forEach(function (g) {
        for (i = 0; i < g.children.length; i++) g.children[i].style.setProperty('--i', i)
      })
      var tracks = view.querySelectorAll('.mu-track')
      for (i = 0; i < tracks.length; i++) tracks[i].style.setProperty('--i', i)
    }).observe(view, { childList: true })
    wire()
    if (typeof MusicPlayer !== 'undefined' && MusicPlayer.init) { try { MusicPlayer.init('music-library') } catch (e) {} }
    likesReady = loadLikes()
    likesReady.then(updateLikedCount)
    loadPlaylists()
    viewHome()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
