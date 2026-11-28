/* ============================================================================
   music.js — Music browse controller (UI v2).
   Fetches the existing /music/api/* endpoints and renders the library views.
   Playback + queue + MediaSession + E2E decrypt are delegated to the existing
   window.MusicPlayer engine (music-player.js) via MusicPlayer.playMusicLibrary.
   ========================================================================== */
(function () {
  'use strict'

  var S = { view: 'home', likes: new Set(), playlists: [], lastCtx: null, hidden: new Set() }
  var viewEpoch = 0, likeMutations = Object.create(null), likesReady = Promise.resolve()
  // The view (S.at) and its scroll for this tab, so coming back from another
  // page opens where the user left off.
  var SS_AT = 'onegy_music_at', SS_SCROLL = 'onegy_music_scroll', restoreScroll = 0
  var $ = function (id) { return document.getElementById(id) }
  var view, railEl

  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function csrf () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : (window.CSRF || '') }
  function toast (m, c) { if (window.showToast) window.showToast(m, c) }
  async function jget (u, signal) { var r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: signal }); if (!r.ok) throw new Error(u); return r.json() }
  // Library data (the same for every user) is kept for a minute, so going back
  // or reopening a view shows it at once instead of fetching it again.
  // shortcut: up to a minute stale after a library change; key on the server's ETag if that matters.
  var CACHE_MS = 60000, cache = new Map()
  function cachePut (u, p) {
    var entry = { at: Date.now(), p: p }
    cache.set(u, entry)
    p.catch(function () { if (cache.get(u) === entry) cache.delete(u) })
    return p
  }
  function jgetCached (u) {
    var hit = cache.get(u)
    return hit && Date.now() - hit.at < CACHE_MS ? hit.p : cachePut(u, jget(u))
  }
  // The page starts the home fetch while the scripts load (music.html)
  if (window.MU_HOME) cachePut('/music/api/home', window.MU_HOME.then(function (r) { if (!r.ok) throw new Error('/music/api/home'); return r.json() }))

  var ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
  var ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6.5h11M4 11.5h11M4 16.5h6"/><circle cx="17.5" cy="16.5" r="2.5"/><path d="M20 16.5V7l2-1"/></svg>'
  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z"/></svg>'
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/></svg>'
  function icon (svg, cls) { return svg.replace('<svg ', '<svg class="' + cls + '" ') }
  // Play + pause stacked; .is-playing on the button crossfades them (music-library.css)
  var ICON_PP = icon(ICON_PLAY, 'mu-pp-play') + icon(ICON_PAUSE, 'mu-pp-pause')
  var ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>'
  // Library row of the list that is playing (music.html has the Liked songs copy)
  var ICON_SPEAKER = '<svg class="mu-lib-playing" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4z" fill="currentColor"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.8 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>'

  // size: 96 | 160 | 320 | 640 serves a small WebP (rows, tiles, cards, hero art); none: the original
  function coverUrl (p, size) { if (!p) return ''; var id = String(p).replace('covers/', '').replace('artists/', '').replace('.jpg', ''); return '/music/cover/' + encodeURIComponent(id) + (size ? '?s=' + size : '') }
  // eager: the page's main image (hero art), fetched first instead of lazily
  function cover (p, cls, size, eager) {
    if (p) return '<img class="' + (cls || '') + '" src="' + esc(coverUrl(p, size)) + '" alt=""' + (eager ? ' fetchpriority="high"' : ' loading="lazy"') + '>'
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
    return { id: t.id, title: t.title || t.name, artists: (t.artists || []), album_id: t.album_id || null, album_name: t.album_name || albumName || '', cover_path: t.cover_path || null, duration_ms: t.duration_ms || 0 }
  }
  // The list the player's queue was started from ({ key, ids }), so that
  // list's play buttons show pause while it plays. Kept per tab like S.at.
  var SS_CTX = 'onegy_music_ctx', playing = null, pendingPlay = 0
  try { playing = JSON.parse(sessionStorage.getItem(SS_CTX) || 'null') } catch (e) {}
  function isPlaying () {
    // Started but still loading counts as playing, so the button flips at once
    if (pendingPlay && Date.now() - pendingPlay < 8000) return true
    return typeof MusicPlayer !== 'undefined' && MusicPlayer.isPlaying ? MusicPlayer.isPlaying() : false
  }
  // key: 'album:<id>', 'playlist:<id>', 'liked', ...; true while the current track came from that list
  function ctxOn (key) {
    var id
    return !!key && !!playing && playing.key === key && !!(id = currentTrackId()) && playing.ids.indexOf(id) >= 0
  }
  function ppClass (key) { return isPlaying() && ctxOn(key) ? ' is-playing' : '' }
  function togglePlay () { if (typeof MusicPlayer !== 'undefined' && MusicPlayer.togglePlay) MusicPlayer.togglePlay() }
  // index < 0: play from the first playable track ("Play" button). key: the list's ctxOn key.
  function playList (tracks, index, albumName, key) {
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
    MusicPlayer.playMusicLibrary(playable, start, { context: key })
    playing = { key: key || null, ids: playable.map(function (t) { return t.id }) }
    try { sessionStorage.setItem(SS_CTX, JSON.stringify(playing)) } catch (e) {}
    pendingPlay = Date.now()
    setTimeout(syncPlaying, 8000)
    syncPlaying()
    syncHearts()
  }
  // Card and quick-tile play buttons: start a list ('album:<id>', 'playlist:<id>', 'liked', 'artist:<id>') without opening it
  async function playCtx (key) {
    if (ctxOn(key)) { togglePlay(); return }
    var i = key.indexOf(':'), kind = i < 0 ? key : key.slice(0, i), id = encodeURIComponent(key.slice(i + 1))
    try {
      if (kind === 'album') { var r = await jgetCached('/music/api/album/' + id), a = r.album || r; playList(r.tracks || a.tracks || [], -1, a.name, key) }
      else if (kind === 'playlist') { var p = await jget('/music/api/playlist/' + id); playList(p.songs || p.tracks || [], -1, '', key) }
      else if (kind === 'liked') { var l = await jget('/music/api/liked-songs'); playList(Array.isArray(l) ? l : (l.songs || []), -1, '', key) }
      else if (kind === 'artist') { var ar = await jgetCached('/music/api/artist/' + id); playList(ar.songs || [], -1, '', key) }
    } catch (e) { toast('COULD NOT START PLAYBACK', 'error') }
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
  function setLiked (id, liked) {
    if (liked) S.likes.add(id); else S.likes.delete(id)
    syncHearts()
    syncPlayerHeart(id)
    updateLikedCount()
  }
  // The heart flips at once; the server's answer (or a failure) settles it
  // unless a later tap on the same song is still on its way.
  function toggleLike (id) {
    var want = !S.likes.has(id)
    setLiked(id, want)
    var previous = likeMutations[id] || likesReady
    var mutation = previous.then(async function () {
      try {
        // Send the wanted state (not a server toggle) so a stale heart cannot flip it the wrong way
        var r = await fetch('/music/api/likes/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ liked: want }) })
        if (!r.ok) throw new Error('like')
        var res = await r.json()
        if (typeof res.liked !== 'boolean') throw new Error('like')
        if (likeMutations[id] === mutation) setLiked(id, res.liked)
      } catch (e) {
        if (likeMutations[id] === mutation) setLiked(id, !want)
        toast('COULD NOT UPDATE LIKE', 'error')
      }
    })
    likeMutations[id] = mutation
    mutation.then(function () { if (likeMutations[id] === mutation) delete likeMutations[id] })
  }
  function updateLikedCount () { var c = $('muLikedCount'); if (c) c.textContent = plural(S.likes.size, 'song') }
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
  // Level meter of the current row (music-library.css), added to that row only
  var EQ = '<span class="mu-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>'
  // Current row, its level meter, and every play button ([data-ctx]) follow the player
  function syncPlaying () {
    if (!view) return
    var id = currentTrackId(), on = isPlaying()
    view.classList.toggle('is-paused', !on)
    view.querySelectorAll('.mu-track').forEach(function (r) {
      var cur = !!id && r.getAttribute('data-song-id') === id
      r.classList.toggle('is-current', cur)
      var num = cur && !r.querySelector('.mu-eq') && r.querySelector('.mu-track-num')
      if (num) num.insertAdjacentHTML('beforeend', EQ)
    })
    view.querySelectorAll('[data-ctx]').forEach(function (b) {
      var p = on && ctxOn(b.getAttribute('data-ctx'))
      b.classList.toggle('is-playing', p)
      if (b.tagName === 'BUTTON') { b.setAttribute('aria-label', p ? 'Pause' : 'Play'); b.title = p ? 'Pause' : 'Play' }
    })
    // Library rows: the list playing from has an accent name, plus a speaker while it plays
    railEl.querySelectorAll('[data-lib-ctx]').forEach(function (r) {
      var c = ctxOn(r.getAttribute('data-lib-ctx'))
      r.classList.toggle('is-current', c)
      r.classList.toggle('is-playing', c && on)
    })
  }

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
  // url: the cover as the page shows it, so sampling it (at 24 x 24) costs no extra download.
  // decode() decodes off the main thread; drawing the decoded image is cheap.
  function tintOf (url) {
    if (!url) return Promise.resolve(null)
    if (!tintCache.has(url)) {
      var img = new Image()
      img.src = url
      var decoded = img.decode ? img.decode() : new Promise(function (ok, no) { img.onload = ok; img.onerror = no })
      tintCache.set(url, decoded.then(function () {
        var c = document.createElement('canvas'); c.width = c.height = 24
        var x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 24, 24)
        return pickTint(x.getImageData(0, 0, 24, 24).data)
      }).catch(function () { return null }))
    }
    return tintCache.get(url)
  }
  // Page wash follows the open view (url: a cover as shown); null falls back to the theme accent.
  // The sticky title bar takes the same colour (--mu-bar on the main panel).
  function wash (url) {
    var el = $('muWash'), token = ++washToken
    if (!el) return
    function set (c) {
      if (c) { el.style.setProperty('--mu-tint', c); el.parentNode.style.setProperty('--mu-bar', c) }
      else { el.style.removeProperty('--mu-tint'); el.parentNode.style.removeProperty('--mu-bar') }
    }
    if (!url) { set(null); return }
    tintOf(url).then(function (c) { if (token === washToken) set(c) })
  }
  var tileObserver = null
  function paintTile (el) {
    tintOf(el.getAttribute('data-tint')).then(function (c) { if (c) el.style.setProperty('--mu-tile', c) })
  }
  // Only tiles near the viewport fetch a cover to sample. A sideways shelf
  // clips its tiles, so it is tinted as a whole once it comes near.
  function paintTiles () {
    if (tileObserver) { tileObserver.disconnect(); tileObserver = null }
    var tiles = view.querySelectorAll('[data-tint]')
    if (!tiles.length) return
    if (typeof IntersectionObserver !== 'function') { tiles.forEach(paintTile); return }
    var groups = new Map()
    tiles.forEach(function (el) {
      var box = el.closest('.mu-shelf') || el
      if (!groups.has(box)) groups.set(box, [])
      groups.get(box).push(el)
    })
    tileObserver = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return
        obs.unobserve(en.target)
        groups.get(en.target).forEach(paintTile)
      })
    }, { root: view, rootMargin: '300px 0px' })
    groups.forEach(function (_, box) { tileObserver.observe(box) })
  }

  // ---- Long lists ----------------------------------------------------------
  // A view goes in with the first CHUNK rows / cards of a long list; the next
  // chunk goes in when the end of the list comes near (an observed marker
  // after the last item), built then (likes and the current track are up to
  // date). Handlers are delegated and rows keep data-track-index, so clicks,
  // the "Show all" collapse (CSS) and sorting work as before.
  var CHUNK = 200, restJobs = [], restSeq = 0, restObserver = null
  // build(item, index) -> HTML; the remainder is marked by an empty .mu-rest
  function chunked (items, build) {
    if (items.length <= CHUNK) return items.map(build).join('')
    var id = ++restSeq
    restJobs.push({ id: id, items: items, build: build, at: CHUNK })
    return items.slice(0, CHUNK).map(build).join('') + '<div class="mu-rest" data-rest="' + id + '" aria-hidden="true"></div>'
  }
  // scrollTo: a scroll position about to be restored; enough goes in now to reach it
  function fillRest (scrollTo) {
    if (restObserver) { restObserver.disconnect(); restObserver = null }
    var jobs = restJobs.filter(function (job) { return (job.el = view.querySelector('[data-rest="' + job.id + '"]')) })
    restJobs = []
    function step (job) {   // true once the list is complete
      var end = Math.min(job.items.length, job.at + CHUNK)
      job.el.insertAdjacentHTML('beforebegin', job.items.slice(job.at, end).map(function (t, k) { return job.build(t, job.at + k) }).join(''))
      job.at = end
      if (end < job.items.length) return false
      job.el.remove(); jobs.splice(jobs.indexOf(job), 1)
      return true
    }
    while (scrollTo && jobs.length && view.scrollHeight < scrollTo + 2 * view.clientHeight) step(jobs[0])
    if (!jobs.length) return
    if (typeof IntersectionObserver !== 'function') { while (jobs.length) step(jobs[0]); return }
    var obs = restObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var job = jobs.filter(function (j) { return j.el === en.target })[0]
        if (!en.isIntersecting || !job) return
        // Observed again, it reports at once if the marker is still in range
        obs.unobserve(job.el)
        if (!step(job)) obs.observe(job.el)
      })
    }, { root: view, rootMargin: '1200px 0px' })
    jobs.forEach(function (job) { obs.observe(job.el) })
  }

  // ---- Rendering: shared bits ---------------------------------------------
  function loading () { view.innerHTML = '<div class="mu-skel" aria-hidden="true">' + new Array(13).join('<span class="rd-skel"></span>') + '</div>' }
  // at: [view, id] of the view being opened, so a UI update reload (core.js) comes back to it.
  // again: opened from history (Back / Forward), so it is not added to it.
  function startView (at, again) {
    if (!again) remember(at)
    abortSearch(); S.searching = false
    if (at[0] !== 'search') setSearchText('')   // the box shows a query only with its results
    S.scrollTo = restoreScroll; restoreScroll = 0
    spotStop()
    setAt(at)
    current = { tracks: [], albumName: '' }; loading(); view.scrollTop = 0
    return ++viewEpoch
  }
  function setAt (at) {
    S.at = at
    if (hist[hpos]) hist[hpos].at = at
    try { sessionStorage.setItem(SS_AT, JSON.stringify(at)) } catch (e) {}
  }
  function isCurrentView (epoch) { return epoch === viewEpoch }
  function render (h) {
    spotStop()
    view.innerHTML = h; paintTiles()
    addStickyBar()
    fillRest(S.scrollTo)
    if (S.scrollTo) { view.scrollTop = S.scrollTo; S.scrollTo = 0 }
    syncStickyBar()
  }

  // ---- History (toolbar Back / Forward) ------------------------------------
  // Every view opened is an entry { at, scroll }; Back / Forward reopen one
  // with again = true and its scroll position.
  var hist = [], hpos = -1, HIST_MAX = 50
  function remember (at) {
    var cur = hist[hpos]
    if (cur && JSON.stringify(cur.at) === JSON.stringify(at)) return   // reopening the same view
    if (cur) cur.scroll = view.scrollTop
    hist = hist.slice(0, hpos + 1).concat([{ at: at }]).slice(-HIST_MAX)
    hpos = hist.length - 1
    renderHist()
  }
  function goHist (d) {
    var e = hist[hpos + d]; if (!e) return
    hist[hpos].scroll = view.scrollTop
    hpos += d; renderHist()
    restoreScroll = e.scroll || 0
    VIEWS[e.at[0]](e.at[1], true)
  }
  function renderHist () {
    var b = $('muBack'), f = $('muFwd')
    if (b) b.disabled = hpos < 1
    if (f) f.disabled = hpos >= hist.length - 1
  }

  // ---- Sticky title bar ----------------------------------------------------
  // Once the page title scrolls under the top of the panel, a bar with the
  // title (and the page's play button) takes its place.
  function addStickyBar () {
    var t = view.querySelector(STICKY_TITLE); if (!t) return
    var play = view.querySelector('[data-play-all]'), p = play ? ppClass(current.key) : ''
    view.insertAdjacentHTML('afterbegin', '<div class="mu-sticky" aria-hidden="true">' +
      (play ? '<button type="button" class="mu-sticky-play' + p + '" data-play-all data-ctx="' + esc(current.key) + '" tabindex="-1">' + ICON_PP + '</button>' : '') +
      '<span class="mu-sticky-title">' + esc(t.textContent) + '</span></div>')
  }
  function syncStickyBar () {
    var bar = view.querySelector('.mu-sticky'); if (!bar) return
    var t = view.querySelector(STICKY_TITLE)
    bar.classList.toggle('is-on', !!t && t.getBoundingClientRect().bottom < view.getBoundingClientRect().top + bar.offsetHeight)
  }
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
      '<span class="mu-card-art">' + cover(a.cover_path, '', 320) + '<span class="mu-card-play' + ppClass('album:' + a.id) + '" data-play-ctx="album:' + esc(a.id) + '" data-ctx="album:' + esc(a.id) + '" aria-hidden="true">' + ICON_PP + '</span></span>' +
      '<span class="mu-card-name">' + esc(a.name) + '</span>' +
      '<span class="mu-card-sub">' + esc(line.filter(Boolean).join(' · ')) + '</span></button>'
  }
  function albumCardType (a) { return albumCard(a, 'type') }
  function artistCard (a) {
    return '<button type="button" class="mu-card mu-card-artist" data-artist="' + esc(a.id) + '" title="' + esc(a.name) + '">' +
      '<span class="mu-card-art mu-round">' + cover(a.cover_path, '', 320) + '</span>' +
      '<span class="mu-card-name">' + esc(a.name) + '</span>' +
      '<span class="mu-card-sub">' + plural(a.song_count || 0, 'song') + '</span></button>'
  }
  function genreTile (g) {
    return '<button type="button" class="mu-genre" data-genre="' + esc(g.name) + '"' + (g.cover_path ? ' data-tint="' + esc(coverUrl(g.cover_path, 160)) + '"' : '') + '>' +
      '<span class="mu-genre-name">' + esc(g.name).replace(/\//g, '/<wbr>') + '</span><span class="mu-genre-sub">' + plural(g.song_count, 'song') + '</span>' +
      (g.cover_path ? '<span class="mu-genre-art">' + cover(g.cover_path, '', 160) + '</span>' : '') + '</button>'
  }
  // opts.art: cover column (lists of mixed albums); opts.album: album column
  function trackRow (t, i, opts) {
    var liked = S.likes.has(t.id)
    var unavailable = t.available === false
    var title = t.title || t.name
    var artists = artistLinks((t.artists || []).concat(t.featured_artists || []))
    return '<div class="mu-track' + (unavailable ? ' is-unavail' : '') + (S.hidden.has(t.id) ? ' is-hidden' : '') + (t.id && t.id === currentTrackId() ? ' is-current' : '') + '" data-track-index="' + i + '" data-song-id="' + esc(t.id) + '"' + (unavailable ? '' : ' tabindex="0"') + '>' +
      '<span class="mu-track-num">' + esc(opts.art ? i + 1 : (t.track_number || (i + 1))) + icon(ICON_PLAY, 'mu-track-play') + icon(ICON_PAUSE, 'mu-track-pause') + (t.id && t.id === currentTrackId() ? EQ : '') + '</span>' +
      (opts.art ? '<span class="mu-track-art">' + cover(t.cover_path, '', 96) + '</span>' : '') +
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
    return '<div class="mu-tracks' + (opts.art ? ' has-art' : '') + (opts.album ? ' has-album' : '') + '">' + head + chunked(tracks, function (t, i) {
      var h = ''
      if (multiDisc && (t.disc_number || 1) !== lastDisc) { lastDisc = t.disc_number || 1; h = '<div class="mu-disc">Disc ' + lastDisc + '</div>' }
      return h + trackRow(t, i, opts)
    }) + '</div>'
  }
  // extra: HTML after the button (album genre chips)
  // The open view's list (current.key)
  function playButton (extra) {
    var p = ppClass(current.key), label = p ? 'Pause' : 'Play'
    return '<div class="mu-actions"><button type="button" class="mu-play-big' + p + '" data-play-all data-ctx="' + esc(current.key) + '" aria-label="' + label + '" title="' + label + '">' + ICON_PP + '</button>' + (extra || '') + '</div>'
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
  // Title of a library view (Albums, Artists, Genres); sub: its count
  function pageHead (title, sub) {
    return '<header class="mu-page-head"><h1 class="mu-page-title">' + esc(title) + '</h1>' + (sub ? '<span class="mu-sec-sub">' + esc(sub) + '</span>' : '') + '</header>'
  }
  // The page titles the sticky bar takes over (not Home's greeting)
  var STICKY_TITLE = '.mu-hero-title, .mu-page-title:not(.mu-greeting)'
  function empty (title, text) {
    return '<div class="rd-empty mu-empty"><span class="rd-empty-icon">' + ICON_NOTE + '</span><h3 class="rd-empty-title">' + esc(title) + '</h3>' +
      (text ? '<p class="rd-empty-text">' + esc(text) + '</p>' : '') + '</div>'
  }

  // ---- For you (Home's personal part) ---------------------------------------
  // /music/api/foryou is kept with its ETag. It is fetched again only when Home
  // opens (or the tab comes back on Home) after its ttl, as a conditional
  // request; a failure waits a minute (or the old ttl) before the next try.
  var FY = { data: null, etag: null, at: 0, p: null }
  function foryouStale () { return Date.now() - FY.at > ((FY.data && FY.data.ttl) || 60) * 1000 }
  function loadForyou () {
    if (FY.p || !foryouStale()) return FY.p || Promise.resolve(FY.data)
    var pre = window.MU_FORYOU, h = { 'X-Requested-With': 'XMLHttpRequest' }
    window.MU_FORYOU = null
    if (FY.etag) h['If-None-Match'] = FY.etag
    FY.p = (pre || fetch('/music/api/foryou', { headers: h })).then(function (r) {
      if (r.status === 304 && FY.data) return FY.data
      if (!r.ok) throw new Error('/music/api/foryou')
      FY.etag = r.headers.get('ETag')
      return r.json()
    }).then(function (d) { FY.data = d; return d }, function () { return FY.data })
      .finally(function () { FY.at = Date.now(); FY.p = null })
    return FY.p
  }
  // Home is open: fills in its personal parts once For you arrives (or changed)
  function refreshForyou () {
    var epoch = viewEpoch
    loadForyou().then(function (f) { if (f && f !== S.homeFy && isCurrentView(epoch) && $('muSpotSlot')) fillForyou(f) })
  }
  function fillForyou (f) {
    var slot = $('muSpotSlot'), had = !!slot.querySelector('.mu-spot')
    S.homeFy = f
    spotStop()
    slot.classList.remove('is-gone')
    slot.innerHTML = spotHtml(f.spotlight)
    // Arriving late, the banner grows in once instead of jumping in
    slot.classList.toggle('is-entering', !had && !!slot.firstChild)
    var q = $('muQuick'); if (q) q.innerHTML = quickTiles(S.home, f)
    var n = $('muNewForYou'); if (n) n.innerHTML = newForYou(f)
    paintTiles()
    spotStart()
  }
  function greeting () { var h = new Date().getHours(); return h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 18 ? 'Good afternoon' : 'Good evening' }
  function newForYou (f) {
    var a = (f && f.new_for_you) || []
    return a.length ? sectionTitle('New from artists you play') + '<div class="mu-shelf">' + a.map(albumCard).join('') + '</div>' : ''
  }

  // ---- Spotlight banner (Home) ------------------------------------------------
  // One slide at a time. The active progress segment's fill is a CSS animation
  // and its animationend advances, so no timer counts: every pause is
  // animation-play-state (music-library.css: hover, keyboard focus, an open
  // menu or dialog, .is-held while the tab is hidden or the banner is
  // off-screen, .is-stopped from the rotation button). Reduced motion: no fill,
  // no advance.
  var spot = { index: 0, stopped: false, el: null, io: null, seenT: 0, onScreen: true, swiped: 0 }
  var spotSent = new Set(), spotQueue = [], spotFlushT = 0, spotTints = Object.create(null)
  var ICON_HIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/></svg>'
  var ICON_PREV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 18-6-6 6-6"/></svg>'
  var ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 18 6-6-6-6"/></svg>'
  function reducedMotion () { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) }
  // The shown slide and the next one get their images; the rest wait (data-src)
  function spotImg (p, size, load) { return '<img ' + (load ? 'src' : 'data-src') + '="' + esc(coverUrl(p, size)) + '" alt="">' }
  function spotHtml (items) {
    items = (items || []).filter(function (s) { return s && s.item && s.album && s.album.id })
    var n = items.length
    if (!n) return ''
    if (spot.index >= n) spot.index = 0
    var at = spot.index, live = spot.stopped || reducedMotion() ? 'polite' : 'off', stopLabel = spot.stopped ? 'Start slide rotation' : 'Stop slide rotation'
    var slides = items.map(function (s, k) {
      var a = s.album, ar = s.artist || {}, on = k === at, load = on || k === (at + 1) % n, len = String(a.name || '').length
      return '<div class="mu-spot-slide' + (on ? ' is-on' : '') + '" role="group" aria-roledescription="slide" aria-label="' + (k + 1) + ' of ' + n + '"' + (on ? '' : ' inert') +
        ' data-spot="' + esc(s.item) + '" data-album-id="' + esc(a.id) + '" data-spot-art="' + esc(a.cover_path ? coverUrl(a.cover_path, 320) : '') + '">' +
        '<span class="mu-spot-art">' + (a.cover_path ? spotImg(a.cover_path, 320, load) : '<span class="mu-art-ph">' + ICON_NOTE + '</span>') + '</span>' +
        '<div class="mu-spot-body">' +
        '<span class="mu-spot-kicker">' + (ar.cover_path ? '<span class="mu-spot-avatar">' + spotImg(ar.cover_path, 96, load) + '</span>' : '') + esc(s.kicker || 'Latest release') + '</span>' +
        '<h2 class="mu-spot-title' + (len > 34 ? ' is-xlong' : len > 18 ? ' is-long' : '') + '" title="' + esc(a.name) + '">' + esc(a.name) + '</h2>' +
        '<span class="mu-spot-meta">' + facts([artistLinks(a.artists), esc(typeLabel(a.album_type)), a.total_tracks ? plural(a.total_tracks, 'song') : '']) + '</span>' +
        (s.reason ? '<span class="mu-spot-reason">' + esc(s.reason) + '</span>' : '') +
        '<span class="mu-spot-actions"><button type="button" class="mu-spot-play' + ppClass('album:' + a.id) + '" data-spot-play data-ctx="album:' + esc(a.id) + '" aria-label="Play" title="Play">' + ICON_PP + '</button>' +
        '<button type="button" class="mu-spot-open" data-spot-open>Open</button>' +
        '<button type="button" class="mu-spot-hide" data-spot-hide aria-label="Not interested" title="Not interested">' + ICON_HIDE + '</button></span>' +
        '</div></div>'
    }).join('')
    // Rotation button first (WAI-ARIA carousel); shown as ‹ segments › (pause)
    var ctrl = n < 2 ? '' : '<div class="mu-spot-ctrl">' +
      '<button type="button" class="mu-spot-btn mu-spot-pause' + (spot.stopped ? '' : ' is-playing') + '" data-spot-pause aria-label="' + stopLabel + '" title="' + stopLabel + '">' + ICON_PP + '</button>' +
      '<button type="button" class="mu-spot-btn mu-spot-arrow mu-spot-prev" data-spot-step="-1" aria-label="Previous slide" title="Previous">' + ICON_PREV + '</button>' +
      '<span class="mu-spot-segs" aria-hidden="true">' + items.map(function (_, k) { return '<span class="mu-spot-seg' + (k === at ? ' is-on' : k < at ? ' is-done' : '') + '"><i></i></span>' }).join('') + '</span>' +
      '<button type="button" class="mu-spot-btn mu-spot-arrow mu-spot-next" data-spot-step="1" aria-label="Next slide" title="Next">' + ICON_NEXT + '</button></div>'
    return '<div class="mu-spot-clip"><section class="mu-spot' + (spot.stopped ? ' is-stopped' : '') + (n < 2 ? ' is-single' : '') + '" role="region" aria-roledescription="carousel" aria-label="Spotlight">' +
      ctrl + '<div class="mu-spot-stage" aria-live="' + live + '">' + slides + '</div></section></div>'
  }
  function spotSlides () { return spot.el ? spot.el.querySelectorAll('.mu-spot-slide:not(.is-gone)') : [] }
  function spotItem () { var s = spot.el && spot.el.querySelector('.mu-spot-slide.is-on'); return s ? s.getAttribute('data-spot') : null }
  function spotStart () {
    spotStop()
    var el = spot.el = view.querySelector('.mu-spot')
    if (!el) return
    spot.onScreen = true
    spotShow(spot.index)
    if (typeof IntersectionObserver !== 'function') return
    spot.io = new IntersectionObserver(function (en) { spot.onScreen = en[en.length - 1].intersectionRatio >= 0.5; spotHold() }, { root: view, threshold: [0, 0.5] })
    spot.io.observe(el)
  }
  function spotStop () {
    if (spot.io) { spot.io.disconnect(); spot.io = null }
    clearTimeout(spot.seenT); spot.seenT = 0
    spot.el = null
  }
  // Held while the tab is hidden or the banner is off-screen; a slide in view
  // for 1 s counts one impression per page view
  function spotHold () {
    var el = spot.el
    if (!el) return
    var shown = spot.onScreen && !document.hidden, item = shown && spotItem()
    el.classList.toggle('is-held', !shown)
    clearTimeout(spot.seenT); spot.seenT = 0
    if (item && !spotSent.has('impression ' + item)) spot.seenT = setTimeout(function () { if (spotItem() === item) spotEvent(item, 'impression') }, 1000)
  }
  function spotShow (i) {
    var el = spot.el, slides = spotSlides(), n = slides.length
    if (!n) return
    i = ((i % n) + n) % n
    var old = el.querySelector('.mu-spot-slide.is-on'), slide = slides[i], focus = document.activeElement
    // Keys pressed on a control of the old slide: focus moves to the same control
    var keep = old && old !== slide && old.contains(focus) && focus.classList[0]
    spot.index = i
    if (old && old !== slide) { old.classList.remove('is-on'); old.inert = true }
    slides.forEach(function (s, k) { var on = k === i; s.classList.toggle('is-on', on); s.inert = !on })
    ;[slide, slides[(i + 1) % n]].forEach(function (s) {
      s.querySelectorAll('img[data-src]').forEach(function (img) { img.src = img.getAttribute('data-src'); img.removeAttribute('data-src') })
    })
    el.querySelectorAll('.mu-spot-seg:not(.is-gone)').forEach(function (s, k) { s.classList.toggle('is-on', k === i); s.classList.toggle('is-done', k < i) })
    if (keep) { var t = slide.querySelector('.' + keep); if (t) t.focus() }
    // Card colour eases to this cover's (css), the page wash follows unless a tile is hovered
    var url = slide.getAttribute('data-spot-art')
    if (spotTints[url]) el.style.setProperty('--mu-spot', spotTints[url])
    else if (url) tintOf(url).then(function (c) { if (c) { spotTints[url] = c; if (spot.el === el && el.querySelector('.mu-spot-slide.is-on') === slide) el.style.setProperty('--mu-spot', c) } })
    S.homeWash = url || S.homeWashBase
    if (!S.tileWash) wash(S.homeWash)
    spotHold()
  }
  function spotToggle () {
    var el = spot.el, b = el && el.querySelector('[data-spot-pause]')
    if (!b) return
    spot.stopped = !spot.stopped
    var label = spot.stopped ? 'Start slide rotation' : 'Stop slide rotation'
    el.classList.toggle('is-stopped', spot.stopped)
    b.classList.toggle('is-playing', !spot.stopped); b.setAttribute('aria-label', label); b.title = label
    el.querySelector('.mu-spot-stage').setAttribute('aria-live', spot.stopped || reducedMotion() ? 'polite' : 'off')
  }
  // "Not interested": the slide goes at once (the next one fades in); the last one folds the banner away
  function spotDismiss (slide) {
    var el = spot.el, item = slide.getAttribute('data-spot'), slides = spotSlides(), k = Array.prototype.indexOf.call(slides, slide)
    spotEvent(item, 'dismiss')
    if (FY.data && FY.data.spotlight) FY.data.spotlight = FY.data.spotlight.filter(function (s) { return s.item !== item })
    if (slides.length < 2) {
      var slot = $('muSpotSlot')
      spotStop()
      slot.classList.add('is-gone')
      S.homeWash = S.homeWashBase; wash(S.homeWash)
      setTimeout(function () { if (slot.classList.contains('is-gone')) { slot.innerHTML = ''; slot.classList.remove('is-gone', 'is-entering') } }, 320)
      return
    }
    var seg = el.querySelectorAll('.mu-spot-seg:not(.is-gone)')[k]
    ;[slide, seg].forEach(function (x) { if (x) x.classList.add('is-gone') })
    setTimeout(function () { slide.remove(); if (seg) seg.remove() }, 320)
    var rest = spotSlides()
    rest.forEach(function (s, j) { s.setAttribute('aria-label', (j + 1) + ' of ' + rest.length) })
    if (rest.length < 2) el.classList.add('is-single')
    spotShow(k)
  }
  function spotClick (e) {
    var t = e.target, step = t.closest('[data-spot-step]'), slide = t.closest('.mu-spot-slide')
    if (step) { spotShow(spot.index + +step.getAttribute('data-spot-step')); return }
    if (t.closest('[data-spot-pause]')) { spotToggle(); return }
    if (!slide || Date.now() - spot.swiped < 400) return
    var item = slide.getAttribute('data-spot'), id = slide.getAttribute('data-album-id')
    if (t.closest('[data-spot-hide]')) { spotDismiss(slide); return }
    var art = t.closest('[data-artist]'); if (art) { viewArtist(art.getAttribute('data-artist')); return }
    spotEvent(item, 'click')
    if (t.closest('[data-spot-play]')) playCtx('album:' + id); else viewAlbum(id)
  }
  // Events go out in batches: one request at most every 10 s, the rest when the page is left
  function spotEvent (item, type) {
    if (type !== 'dismiss') { if (spotSent.has(type + ' ' + item)) return; spotSent.add(type + ' ' + item) }
    spotQueue.push({ item: item, type: type })
    if (!spotFlushT) spotFlushT = setTimeout(spotFlush, 10000)
  }
  function spotFlush (keepalive) {
    clearTimeout(spotFlushT); spotFlushT = 0
    while (spotQueue.length) {
      fetch('/music/api/spotlight/seen', { method: 'POST', keepalive: keepalive === true, headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ events: spotQueue.splice(0, 50) }) }).catch(function () {})
    }
  }

  // ---- Views ---------------------------------------------------------------
  var current = { tracks: [], albumName: '' }

  // ctx: the list its play button starts ('liked', 'playlist:<id>', 'album:<id>'); none for an empty list
  function quickTile (attrs, art, name, tint, ctx) {
    return '<button type="button" class="mu-quick" ' + attrs + (tint ? ' data-wash="' + esc(tint) + '"' : '') + '><span class="mu-quick-art">' + art + '</span><span class="mu-quick-name">' + esc(name) + '</span>' +
      (ctx ? '<span class="mu-quick-play' + ppClass(ctx) + '" data-play-ctx="' + esc(ctx) + '" data-ctx="' + esc(ctx) + '" aria-hidden="true">' + ICON_PP + '</span>' : '') + '</button>'
  }
  // Quick picks (8 tiles): liked songs, what was played lately (For you), playlists, then the newest additions
  function quickTiles (d, f) {
    var seen = new Set(['liked']), tiles = [quickTile('data-go="liked"', '<span class="mu-liked-art">' + ICON_HEART + '</span>', 'Liked songs', '', S.likes.size ? 'liked' : '')]
    function add (key, name, art) {
      if (tiles.length >= 8 || seen.has(key)) return
      seen.add(key)
      var i = key.indexOf(':'), kind = key.slice(0, i), id = key.slice(i + 1)
      if (kind === 'playlist') {
        var p = S.playlists.filter(function (x) { return String(x.id) === id })[0]
        if (p) tiles.push(quickTile('data-playlist="' + esc(id) + '"', p.cover_path ? cover(p.cover_path, '', 160) : '<span class="mu-art-ph">' + ICON_LIST + '</span>', p.name, coverUrl(p.cover_path, 160), p.song_count ? key : ''))
      } else if (kind === 'album' || kind === 'artist') {
        // Album tiles share the album cards' 320 covers (one download each)
        tiles.push(quickTile('data-' + kind + '="' + esc(id) + '"', cover(art, kind === 'artist' ? 'mu-round' : '', 320), name, coverUrl(art, 320), key))
      }
    }
    ;((f && f.recent) || []).forEach(function (r) { if (r && r.context) add(r.context, r.name, r.cover_path) })
    S.playlists.slice(0, 3).forEach(function (p) { add('playlist:' + p.id) })
    ;(d.recently_added || []).forEach(function (a) { add('album:' + a.id, a.name, a.cover_path) })
    return tiles.join('')
  }
  async function viewHome (_, again) {
    setActive('home'); var epoch = startView(['home'], again)
    loadForyou()   // alongside /home; Home does not wait for it
    try {
      var d = await jgetCached('/music/api/home')
      if (!isCurrentView(epoch)) return
      // A For you already here (even past its ttl) goes in now, so nothing shifts
      var f = S.homeFy = FY.data, recent = d.recently_added || [], h = ''
      S.home = d
      if (recent.length) {
        h += '<header class="mu-page-head"><h1 class="mu-page-title mu-greeting">' + esc(greeting()) + '</h1></header><div class="mu-quick-grid" id="muQuick">' + quickTiles(d, f) + '</div>'
        h += '<div class="mu-fy-new" id="muNewForYou">' + newForYou(f) + '</div>'
        h += sectionTitle('Recently added', '', 'albums') + '<div class="mu-shelf">' + recent.map(albumCard).join('') + '</div>'
      }
      if ((d.new_releases || []).length) h += sectionTitle('New releases') + '<div class="mu-shelf">' + d.new_releases.map(albumCard).join('') + '</div>'
      if ((d.genres || []).length) h += sectionTitle('Browse by genre', '', 'genres') + '<div class="mu-shelf mu-shelf-genres">' + d.genres.map(genreTile).join('') + '</div>'
      if ((d.top_artists || []).length) h += sectionTitle('Top artists', '', 'artists') + '<div class="mu-shelf mu-shelf-artists">' + d.top_artists.map(artistCard).join('') + '</div>'
      S.homeWash = S.homeWashBase = recent[0] && coverUrl(recent[0].cover_path, 320)
      S.tileWash = false
      var banner = h && f ? spotHtml(f.spotlight) : ''
      if (!banner) wash(S.homeWash)   // otherwise the shown slide's cover
      render(h ? '<div class="mu-spot-slot" id="muSpotSlot">' + banner + '</div>' + h : empty('Your library is empty', 'Songs added to the music library show up here.'))
      spotStart()
      if (h) refreshForyou()
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
    render(pageHead('Albums', plural(arr.length, albumPrefs.type ? typeLabel(albumPrefs.type).toLowerCase().replace(/s?$/, '') : 'release')) +
      '<div class="mu-filterbar"><div class="mu-chips" role="group" aria-label="Release type">' + chips + '</div>' + sort + '</div>' +
      '<div class="mu-grid">' + chunked(arr, albumCard) + '</div>')
  }
  async function viewAlbums (_, again) {
    setActive('albums'); var epoch = startView(['albums'], again); wash(null)
    try { var d = await jgetCached('/music/api/albums'); var arr = Array.isArray(d) ? d : (d.albums || [])
      if (!isCurrentView(epoch)) return
      S.albums = arr
      if (arr.length) renderAlbums(arr); else render(empty('No albums yet'))
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load albums', 'Check your connection and try again.') }
  }
  async function viewArtists (_, again) {
    setActive('artists'); var epoch = startView(['artists'], again); wash(null)
    try { var d = await jgetCached('/music/api/artists'); var arr = Array.isArray(d) ? d : (d.artists || [])
      if (!isCurrentView(epoch)) return
      render(arr.length ? pageHead('Artists', plural(arr.length, 'artist')) + '<div class="mu-grid mu-grid-artists">' + chunked(arr, artistCard) + '</div>' : empty('No artists yet'))
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load artists', 'Check your connection and try again.') }
  }
  async function viewGenres (_, again) {
    setActive('genres'); var epoch = startView(['genres'], again); wash(null)
    try { var arr = await jgetCached('/music/api/genres')
      if (!isCurrentView(epoch)) return
      render(arr.length ? pageHead('Genres', plural(arr.length, 'genre')) + '<div class="mu-genre-grid">' + arr.map(genreTile).join('') + '</div>'
        : empty('No genres yet', 'Genres appear once songs in the library have been tagged.'))
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load genres', 'Check your connection and try again.') }
  }
  async function viewGenre (name, again) {
    setActive(''); var epoch = startView(['genre', name], again)
    try {
      var r = await jgetCached('/music/api/genre?name=' + encodeURIComponent(name))
      if (!isCurrentView(epoch)) return
      var songs = r.songs || [], albums = r.albums || [], artists = r.artists || []
      current = { tracks: songs, albumName: '', key: 'genre:' + name }
      var art = albums[0] && coverUrl(albums[0].cover_path, 320)   // as its release card shows it
      wash(art)
      var h = hero({ html: '<span class="mu-genre-hero"' + (art ? ' data-tint="' + esc(art) + '"' : '') + '>' + esc(name.charAt(0)) + '</span>' }, 'Genre', name,
        facts([plural(r.genre.song_count, 'song'), plural(albums.length, 'release'), plural(artists.length, 'artist')]))
      if (songs.length) h += playButton() + '<div class="mu-collapsed">' + trackList(songs, { art: true, album: true }) + '</div>' + moreToggle(songs.length)
      if (albums.length) h += sectionTitle('Releases', String(albums.length)) + '<div class="mu-grid">' + chunked(albums, albumCard) + '</div>'
      if (artists.length) h += sectionTitle('Artists', String(artists.length)) + '<div class="mu-shelf mu-shelf-artists">' + artists.map(artistCard).join('') + '</div>'
      render(h)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this genre', 'It may no longer have any songs.') }
  }
  async function viewAlbum (id, again) {
    setActive(''); var epoch = startView(['album', id], again)
    try {
      var r = await jgetCached('/music/api/album/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (r.error) { view.innerHTML = empty(r.error); return }
      var a = r.album || r, tracks = r.tracks || a.tracks || []   // response is { album, tracks }
      current = { tracks: tracks, albumName: a.name, key: 'album:' + id }
      wash(coverUrl(a.cover_path, 640))
      var count = a.total_tracks && a.total_tracks > tracks.length ? tracks.length + ' of ' + plural(a.total_tracks, 'song') : plural(tracks.length, 'song')
      var h = hero({ html: cover(a.cover_path, '', 640, true) }, typeLabel(a.album_type) || 'Album', a.name,
        facts(['<strong>' + artistLinks(a.artists) + '</strong>', esc(year(a)), esc(count), esc(totalDur(tracks))]))
      var tags = (a.genres || []).length ? '<div class="mu-tags">' + a.genres.map(function (g) { return '<button type="button" class="mu-chip" data-genre="' + esc(g) + '">' + esc(g) + '</button>' }).join('') + '</div>' : ''
      if (tracks.length) h += playButton(tags); else h += tags
      h += tracks.length ? trackList(tracks, { discs: true }) : empty('This album has no tracks')
      if (a.release_date || a.label) h += '<footer class="mu-credits">' + (a.release_date ? '<div>' + esc(longDate(a.release_date)) + '</div>' : '') + (a.label ? '<div>' + esc(a.label) + '</div>' : '') + '</footer>'
      // More by the first album artist comes with the album (r.more_by)
      var first = (a.artists || [])[0], more = r.more_by || []
      h += '<div id="muMoreBy">' + (first && more.length ? sectionTitle('More by ' + first.name) + '<div class="mu-shelf">' + more.map(albumCardType).join('') + '</div>' : '') + '</div>'
      render(h)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this album', 'Check your connection and try again.') }
  }
  async function viewArtist (id, again) {
    setActive(''); var epoch = startView(['artist', id], again)
    try {
      var r = await jgetCached('/music/api/artist/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (r.error) { view.innerHTML = empty(r.error); return }
      var a = r.artist || r                                        // response is { artist, songs, albums, featuring_albums }
      var own = r.albums || [], feat = r.featuring_albums || []
      wash(coverUrl(a.cover_path, 640))
      var songs = r.songs || []
      var full = own.filter(function (x) { return x.album_type === 'album' || x.album_type === 'compilation' })
      var short = own.filter(function (x) { return full.indexOf(x) < 0 })
      var h = hero({ html: cover(a.cover_path, '', 640, true), cls: 'mu-round' }, 'Artist', a.name, facts([plural(songs.length, 'song'), own.length ? plural(own.length, 'release') : '']))
      if (songs.length) {
        current = { tracks: songs, albumName: '', key: 'artist:' + id }
        h += playButton() + sectionTitle('Songs', String(songs.length)) + '<div class="mu-collapsed">' + trackList(songs, { art: true, album: true }) + '</div>' + moreToggle(songs.length)
      }
      if (full.length) h += sectionTitle('Albums', String(full.length)) + '<div class="mu-grid">' + full.map(albumCardType).join('') + '</div>'
      if (short.length) h += sectionTitle('Singles and EPs', String(short.length)) + '<div class="mu-grid">' + short.map(albumCardType).join('') + '</div>'
      if (feat.length) h += sectionTitle('Appears on', String(feat.length)) + '<div class="mu-grid">' + feat.map(albumCard).join('') + '</div>'
      render(h)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this artist', 'Check your connection and try again.') }
  }
  async function viewLiked (_, again) {
    setActive('liked'); var epoch = startView(['liked'], again); wash(null)
    try {
      var arr = await jget('/music/api/liked-songs')
      if (!isCurrentView(epoch)) return
      arr = Array.isArray(arr) ? arr : (arr.songs || [])
      current = { tracks: arr, albumName: '', key: 'liked' }
      var h = hero({ html: ICON_HEART, cls: 'mu-liked-art' }, 'Playlist', 'Liked songs', facts([USERNAME ? '<strong>' + esc(USERNAME) + '</strong>' : '', plural(arr.length, 'song'), esc(totalDur(arr))]))
      h += arr.length ? playButton() + trackList(arr, { art: true, album: true }) : empty('No liked songs yet', 'Tap the heart on any track to save it here.')
      render(h)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load liked songs', 'Check your connection and try again.') }
  }
  async function viewPlaylist (id, again) {
    setActive('', id); var epoch = startView(['playlist', id], again)
    try {
      var p = await jget('/music/api/playlist/' + encodeURIComponent(id))
      if (!isCurrentView(epoch)) return
      if (p.error) { view.innerHTML = empty(p.error); return }
      var tracks = p.songs || p.tracks || []
      current = { tracks: tracks, albumName: '', key: 'playlist:' + id, playlist: p }
      // No cover of its own: its first song's, as in the library rail
      var art = p.cover_path || (tracks[0] && tracks[0].cover_path)
      wash(coverUrl(art, 640))
      var h = hero({ html: art ? cover(art, '', 640, true) : '<span class="mu-art-ph">' + ICON_LIST + '</span>' }, 'Playlist', p.name, playlistFacts(p), p.description || '')
      var more = '<button type="button" class="mu-more" data-playlist-menu aria-label="More options for ' + esc(p.name) + '" title="More options">' + ICON_MORE + '</button>'
      h += tracks.length ? playButton(more) + trackList(tracks, { art: true, album: true }) : '<div class="mu-actions">' + more + '</div>' + empty('This playlist is empty', 'Add songs with the + button in the player.')
      render(h)
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Could not load this playlist', 'Check your connection and try again.') }
  }
  // The search request in flight: a newer search or another view cancels it.
  var searchCtl = null, shownQ = null
  function abortSearch () { if (searchCtl) { searchCtl.abort(); searchCtl = null } }
  async function viewSearch (q, again) {
    var epoch
    // Typing on keeps the current results up until the new ones arrive (one history entry)
    if (S.searching) { abortSearch(); epoch = ++viewEpoch; setAt(['search', q]) } else { setActive(''); epoch = startView(['search', q], again); wash(null); S.searching = true }
    setSearchText(q)
    shownQ = q
    var ctl = searchCtl = new AbortController()
    try {
      var d = await jget('/music/api/search?q=' + encodeURIComponent(q), ctl.signal)
      if (!isCurrentView(epoch)) return
      var h = ''
      if ((d.songs || []).length) { current = { tracks: d.songs, albumName: '', key: 'search:' + q }; h += sectionTitle('Songs', String(d.songs.length)) + trackList(d.songs, { art: true, album: true }) }
      if ((d.albums || []).length) h += sectionTitle('Albums', String(d.albums.length)) + '<div class="mu-grid">' + d.albums.map(albumCard).join('') + '</div>'
      if ((d.artists || []).length) h += sectionTitle('Artists', String(d.artists.length)) + '<div class="mu-grid mu-grid-artists">' + d.artists.map(artistCard).join('') + '</div>'
      render(h || empty('No results for “' + q + '”', 'Try a different spelling or a shorter search.'))
      if (!again) view.scrollTop = 0
    } catch (e) { if (isCurrentView(epoch)) view.innerHTML = empty('Search failed', 'Check your connection and try again.') }
  }

  // ---- Playlists in rail ---------------------------------------------------
  async function loadPlaylists () {
    try {
      var d = await jget('/music/api/playlists')
      showPlaylists(Array.isArray(d) ? d : (d.playlists || []))
    } catch (e) {}
  }
  function showPlaylists (playlists) {
    S.playlists = playlists
    var list = $('muRailPlaylists'); if (!list) return
    list.innerHTML = S.playlists.map(function (p) {
      return '<button type="button" class="mu-lib-row' + (S.playlistId === String(p.id) ? ' is-active' : '') + '" data-playlist="' + esc(p.id) + '" data-lib-ctx="playlist:' + esc(p.id) + '" title="' + esc(p.name) + '">' +
        '<span class="mu-lib-art">' + (p.cover_path ? cover(p.cover_path, '', 96) : '<span class="mu-art-ph">' + ICON_LIST + '</span>') + '</span>' +
        '<span class="mu-lib-text"><span class="mu-lib-name">' + esc(p.name) + '</span><span class="mu-lib-sub">Playlist · ' + plural(p.song_count || 0, 'song') + '</span></span>' + ICON_SPEAKER + '</button>'
    }).join('') || '<div class="mu-lib-empty"><strong>Create your first playlist</strong><span>Then add songs with the + in the player.</span><button type="button" class="mu-create mu-create-solid" data-create>Create playlist</button></div>'
    syncPlaying()
  }
  async function createPlaylist (name, desc) {
    try {
      var r = await fetch('/music/api/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ name: name, description: desc || '' }) })
      if (!r.ok) throw new Error()
      toast('PLAYLIST CREATED', 'success'); loadPlaylists()
    } catch (e) { toast('COULD NOT CREATE PLAYLIST', 'error') }
  }

  // ---- Taste controls --------------------------------------------------------
  var ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/></svg>'
  // Menu icons (RdMenu: inner markup of a 24 x 24 stroke svg)
  var MI = {
    add: '<path d="M12 5v14M5 12h14"/>',
    album: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/>',
    artist: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    hide: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>',
    show: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8M12 8v8"/>',
    autoplay: '<path d="M12 12c-2-2.6-3.6-4-5.5-4a4 4 0 0 0 0 8c1.9 0 3.5-1.4 5.5-4s3.6-4 5.5-4a4 4 0 0 1 0 8c-1.9 0-3.5-1.4-5.5-4z"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    clear: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
    exclude: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
    include: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>'
  }
  function jsend (method, u, body) {
    return fetch(u, { method: method, headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), 'X-Requested-With': 'XMLHttpRequest' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { if (!r.ok) throw new Error(u); return r.status === 204 ? null : r.json() })
  }
  function playlistFacts (p) {
    var tracks = p.songs || p.tracks || []
    return facts([plural(tracks.length, 'song'), esc(totalDur(tracks)), p.exclude_taste ? 'Excluded from your taste profile' : ''])
  }
  function playlistMenu (btn) {
    var p = current.playlist, r = btn.getBoundingClientRect()
    if (!p || !window.RdMenu) return
    window.RdMenu.open(r.left, r.bottom + 6, [p.exclude_taste
      ? { label: 'Include in your taste profile', icon: MI.include, action: function () { setExcludeTaste(p, false) } }
      : { label: 'Exclude from your taste profile', icon: MI.exclude, action: function () { setExcludeTaste(p, true) } }])
  }
  function setExcludeTaste (p, on) {
    jsend('PUT', '/music/api/playlist/' + encodeURIComponent(p.id), { exclude_taste: on }).then(function () {
      p.exclude_taste = on
      var f = current.playlist === p && view.querySelector('.mu-hero-facts'); if (f) f.innerHTML = playlistFacts(p)
      toast(on ? 'Excluded from your taste profile' : 'Included in your taste profile', 'success')
    }, function () { toast('Could not update the playlist', 'error') })
  }
  // Track rows: right-click or long-press. at: the pointer ({ x, y })
  function songMenu (row, at) {
    var t = current.tracks[+row.getAttribute('data-track-index')]
    if (!t || !t.id || !window.RdMenu) return
    var album = t.album_id, artist = (t.artists || [])[0], hidden = S.hidden.has(t.id)
    var items = [{ label: 'Add to playlist…', icon: MI.add, action: function () { addToPlaylistMenu(t.id, { getBoundingClientRect: function () { return { left: at.x, bottom: at.y } } }) } }]
    if (album && current.key !== 'album:' + album) items.push({ label: 'Go to album', icon: MI.album, action: function () { viewAlbum(album) } })
    if (artist && artist.id && current.key !== 'artist:' + artist.id) items.push({ label: 'Go to artist', icon: MI.artist, action: function () { viewArtist(artist.id) } })
    items.push({ sep: true }, hidden
      ? { label: 'Show in recommendations', icon: MI.show, action: function () { hideSong(t.id, false) } }
      : { label: 'Not for me', icon: MI.hide, action: function () { hideSong(t.id, true) } })
    window.RdMenu.open(at.x, at.y, items)
  }
  // The row stays playable, only dimmed
  function hideSong (id, hidden) {
    jsend('POST', '/music/api/hide', { kind: 'song', key: id, hidden: hidden }).then(function () {
      if (hidden) S.hidden.add(id); else S.hidden.delete(id)
      view.querySelectorAll('.mu-track').forEach(function (r) { if (r.getAttribute('data-song-id') === id) r.classList.toggle('is-hidden', hidden) })
      toast(hidden ? 'Hidden from your recommendations' : 'Back in your recommendations', 'success')
    }, function () { toast('Could not update your recommendations', 'error') })
  }

  // ---- Listening settings (top row) --------------------------------------------
  // Prefs are fetched on the first open of the menu. private_until is kept in
  // localStorage too, so the top-row indicator shows on the next page.
  // shortcut: a private session started on another device shows here once the menu is opened.
  var LS_PRIVATE = 'onegy_music_private_until', prefsLoaded = false, privateT = 0
  function privateLeft (until) { var ms = until ? Date.parse(until) - Date.now() : 0; return ms > 0 ? ms : 0 }
  function showPrivate (until) {
    var pill = $('muPrivate'), left = privateLeft(until)
    if (pill) pill.hidden = !left
    clearTimeout(privateT)
    if (left) privateT = setTimeout(function () { showPrivate(null) }, left + 500)
  }
  // The player's queue panel switch reads and writes mp_autoplay too, so the menu reads it from there
  function setPrefs (p) {
    try {
      localStorage.setItem('mp_autoplay', p.autoplay === false ? '0' : '1')
      if (p.private_until) localStorage.setItem(LS_PRIVATE, p.private_until); else localStorage.removeItem(LS_PRIVATE)
    } catch (e) {}
    if (typeof MusicPlayer !== 'undefined' && MusicPlayer.setAutoplay) MusicPlayer.setAutoplay(p.autoplay !== false)
    showPrivate(p.private_until)
  }
  function localPrefs () {
    try { return { autoplay: localStorage.getItem('mp_autoplay') !== '0', private_until: localStorage.getItem(LS_PRIVATE) } } catch (e) { return { autoplay: true, private_until: null } }
  }
  function putPrefs (body, done, fail) { jsend('PUT', '/music/api/taste/prefs', body).then(function (p) { setPrefs(p); toast(done, 'success') }, function () { toast(fail, 'error') }) }
  async function listenMenu () {
    var btn = $('muListenBtn')
    if (!window.RdMenu || !btn) return
    if (!prefsLoaded) { try { setPrefs(await jget('/music/api/taste/prefs')); prefsLoaded = true } catch (e) {} }
    var p = localPrefs(), left = privateLeft(p.private_until), r = btn.getBoundingClientRect()
    var until = left && new Date(Date.parse(p.private_until)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    window.RdMenu.open(r.right, r.bottom + 6, [
      { header: 'Listening' },
      { label: p.autoplay ? 'Turn autoplay off' : 'Turn autoplay on', icon: MI.autoplay, action: function () { putPrefs({ autoplay: !p.autoplay }, p.autoplay ? 'Autoplay is off' : 'Autoplay is on', 'Could not change autoplay') } },
      left ? { label: 'End private session', hint: 'Until ' + until, icon: MI.lock, action: function () { putPrefs({ private_minutes: 0 }, 'Private session ended', 'Could not end the private session') } }
        : { label: 'Start private session', hint: '1 hour', icon: MI.lock, action: function () { putPrefs({ private_minutes: 60 }, 'Private session on for 1 hour', 'Could not start a private session') } },
      { sep: true },
      { label: 'Clear listening history…', icon: MI.clear, danger: true, action: function () { openModal('muClearModal') } }
    ])
  }
  function clearHistory () {
    closeModal()
    jsend('POST', '/music/api/taste/clear').then(function () {
      FY.at = 0   // For you is stale now: Home asks again (If-None-Match)
      toast('Listening history cleared', 'success')
      if (S.at && S.at[0] === 'home') refreshForyou()
    }, function () { toast('Could not clear your listening history', 'error') })
  }

  // ---- Nav helpers ---------------------------------------------------------
  // v: rail view name; plId: playlist id (playlist views)
  // Rail, Home and Browse buttons ([data-view]) and rail playlists follow the open view
  function setActive (v, plId) {
    S.view = v; S.playlistId = plId ? String(plId) : null
    document.querySelectorAll('.mu-shell [data-view]').forEach(function (b) {
      var on = b.getAttribute('data-view') === v
      b.classList.toggle('is-active', on)
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current')
    })
    railEl.querySelectorAll('[data-playlist]').forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-playlist') === S.playlistId) })
  }
  var VIEWS = { home: viewHome, albums: viewAlbums, artists: viewArtists, genres: viewGenres, genre: viewGenre, album: viewAlbum, artist: viewArtist, liked: viewLiked, playlist: viewPlaylist, search: viewSearch }
  // Views without an id (rail, Home, Browse, "Show all")
  function go (v) { if (/^(home|albums|artists|genres|liked)$/.test(v)) VIEWS[v]() }
  function setSearchText (q) {
    var si = $('muSearch'); if (!si) return
    if (si.value.trim() !== q) si.value = q
    $('muSearchBox').classList.toggle('has-q', !!si.value)
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
      if (e.target.closest('[data-create]')) openModal()
    })
    view.addEventListener('click', function (e) {
      if (e.target.closest('.mu-spot')) { spotClick(e); return }
      var plm = e.target.closest('[data-playlist-menu]'); if (plm) { playlistMenu(plm); return }
      var like = e.target.closest('[data-like]'); if (like) { e.stopPropagation(); toggleLike(like.getAttribute('data-like')); return }
      var pc = e.target.closest('[data-play-ctx]'); if (pc) { playCtx(pc.getAttribute('data-play-ctx')); return }
      var more = e.target.closest('[data-go]'); if (more) { go(more.getAttribute('data-go')); return }
      var alb = e.target.closest('[data-album]'); if (alb) { viewAlbum(alb.getAttribute('data-album')); return }
      var art = e.target.closest('[data-artist]'); if (art) { viewArtist(art.getAttribute('data-artist')); return }
      var gen = e.target.closest('[data-genre]'); if (gen) { viewGenre(gen.getAttribute('data-genre')); return }
      var pl = e.target.closest('[data-playlist]'); if (pl) { viewPlaylist(pl.getAttribute('data-playlist')); return }
      var at = e.target.closest('[data-album-type]'); if (at) { albumPrefs.type = at.getAttribute('data-album-type'); savePrefs(); renderAlbums(S.albums || []); return }
      var mt = e.target.closest('[data-more-tracks]'); if (mt) { var c = mt.previousElementSibling; if (c) c.classList.remove('mu-collapsed'); mt.remove(); return }
      if (e.target.closest('[data-play-all]')) { if (ctxOn(current.key)) togglePlay(); else playList(current.tracks, -1, current.albumName, current.key); return }
      var tr = e.target.closest('[data-track-index]')
      if (tr) {
        // The current song: its play / pause icon toggles; elsewhere on the row only resumes
        if (tr.getAttribute('data-song-id') === currentTrackId()) { if (!isPlaying() || e.target.closest('.mu-track-num')) togglePlay(); return }
        playList(current.tracks, +tr.getAttribute('data-track-index'), current.albumName, current.key); return
      }
    })
    view.addEventListener('change', function (e) {
      if (e.target.matches('[data-album-sort]')) { albumPrefs.sort = e.target.value; savePrefs(); renderAlbums(S.albums || []) }
    })
    // Home quick tiles tint the page while the pointer is on the tiles
    view.addEventListener('pointerover', function (e) {
      if (S.view !== 'home') return
      var q = e.target.closest('.mu-quick')
      if (q) { if (!q.contains(e.relatedTarget)) { S.tileWash = true; wash(q.getAttribute('data-wash') || null) } return }
      if (S.tileWash && !e.target.closest('.mu-quick-grid')) { S.tileWash = false; wash(S.homeWash) }
    })
    view.addEventListener('pointerleave', function () { if (S.view === 'home') { S.tileWash = false; wash(S.homeWash) } })
    // Track rows are focusable: Enter / Space plays. Spotlight: Left / Right change the slide
    view.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('mu-track')) { e.preventDefault(); e.target.click() }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey && e.target.closest('.mu-spot')) { e.preventDefault(); spotShow(spot.index + (e.key === 'ArrowRight' ? 1 : -1)) }
    })
    view.addEventListener('animationend', function (e) { if (e.animationName === 'muSpotFill' && spot.el && spot.el.contains(e.target)) spotShow(spot.index + 1) })
    // Spotlight on touch: a sideways swipe changes the slide (and opens nothing)
    var swipe = null
    view.addEventListener('touchstart', function (e) { swipe = e.touches.length === 1 && e.target.closest('.mu-spot') ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null }, { passive: true })
    view.addEventListener('touchend', function (e) {
      if (!swipe) return
      var t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y
      swipe = null
      if (Math.abs(dx) > 40 && Math.abs(dx) > 1.5 * Math.abs(dy)) { spot.swiped = Date.now(); spotShow(spot.index + (dx < 0 ? 1 : -1)) }
    }, { passive: true })
    // Song menu: right-click, or a long press on touch (RdMenu eats the click that follows)
    var press = null, pressedAt = 0
    view.addEventListener('pointerdown', function (e) {
      var row = e.pointerType === 'touch' && e.target.closest('.mu-track:not(.is-unavail)')
      if (!row) return
      var at = { x: e.clientX, y: e.clientY }
      clearTimeout(press)
      press = setTimeout(function () { press = null; pressedAt = Date.now(); songMenu(row, at) }, 500)
    })
    // A scroll that starts cancels the pointer, so it ends the press too
    ;['pointerup', 'pointercancel'].forEach(function (t) { view.addEventListener(t, function () { clearTimeout(press); press = null }) })
    view.addEventListener('contextmenu', function (e) {
      var row = e.target.closest('.mu-track:not(.is-unavail)')
      if (!row) return
      e.preventDefault()
      clearTimeout(press); press = null
      if (Date.now() - pressedAt > 800) songMenu(row, { x: e.clientX, y: e.clientY })
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
    document.addEventListener('musicplayer:playpause', function (e) { if (e.detail && e.detail.playing) pendingPlay = 0; syncPlaying() })
    document.addEventListener('musicplayer:fsadd', function (e) { if (e.detail && e.detail.id) addToPlaylistMenu(e.detail.id, e.detail.button) })

    view.addEventListener('scroll', syncStickyBar, { passive: true })

    var si = $('muSearch'), to = null
    si.addEventListener('input', function () {
      var q = this.value.trim()
      $('muSearchBox').classList.toggle('has-q', !!this.value)
      clearTimeout(to)
      if (q === (S.searching ? shownQ : '')) return   // what is on screen already
      var epoch = ++viewEpoch
      to = setTimeout(function () { if (isCurrentView(epoch)) { q ? viewSearch(q) : viewHome() } }, 260)
    })
    si.addEventListener('keydown', function (e) { if (e.key === 'Escape') si.blur() })
    // A click anywhere on the pill types into it
    $('muSearchBox').addEventListener('mousedown', function (e) { if (!e.target.closest('button, input')) { e.preventDefault(); si.focus() } })
    var clear = $('muSearchClear')
    clear.addEventListener('mousedown', function (e) { e.preventDefault() })
    clear.onclick = function () { si.value = ''; si.dispatchEvent(new Event('input')); si.focus() }
    // Phones get the short placeholder; Macs see the Cmd key
    var phLong = si.placeholder, narrow = window.matchMedia('(max-width:620px)')
    function placeholder () { si.placeholder = narrow.matches ? 'Search' : phLong }
    placeholder(); if (narrow.addEventListener) narrow.addEventListener('change', placeholder)
    if (/Mac|iPhone|iPad/.test(navigator.platform || '')) { $('muKbdMod').textContent = '⌘'; si.setAttribute('aria-keyshortcuts', 'Meta+K') }
    // Ctrl / Cmd + K (and / outside a text field) jump to search
    document.addEventListener('keydown', function (e) {
      var k = e.key && e.key.toLowerCase(), typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')
      if ((k === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) || (k === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        if (document.querySelector('.rd-modal.rd-open')) return
        e.preventDefault(); si.focus(); si.select()
      }
    })

    // Top row: Home, Browse, Back / Forward
    document.querySelector('.mu-topbar').addEventListener('click', function (e) {
      var v = e.target.closest('[data-view]'); if (v) go(v.getAttribute('data-view'))
    })
    $('muBack').onclick = function () { goHist(-1) }
    $('muFwd').onclick = function () { goHist(1) }
    $('muListenBtn').onclick = listenMenu
    $('muPrivate').onclick = listenMenu
    // Back on the tab: the banner runs again, and Home asks For you again after its ttl
    document.addEventListener('visibilitychange', function () {
      spotHold()
      if (document.hidden) spotFlush(true)
      else if (S.at && S.at[0] === 'home' && foryouStale()) refreshForyou()
    })
    var st = $('muRailToggle'); if (st) st.onclick = openRail
    var sc = $('muRailScrim'); if (sc) sc.onclick = closeRail

    // Create playlist modal
    var cpb = $('muCreatePl'); if (cpb) cpb.onclick = function () { openModal() }
    var mc = $('muPlSave'); if (mc) mc.onclick = function () { var n = $('muPlName').value.trim(); if (!n) { $('muPlName').focus(); return } closeModal(); createPlaylist(n, $('muPlDesc').value.trim()) }
    ;['muPlName', 'muPlDesc'].forEach(function (id) { var el = $(id); if (el) el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); mc.click() } }) })
    // Clear listening history confirmation
    $('muClearOk').onclick = clearHistory
    document.querySelectorAll('#muPlModal [data-rd-modal-close], #muClearModal [data-rd-modal-close]').forEach(function (b) { b.onclick = closeModal })
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.querySelector('#muPlModal.rd-open, #muClearModal.rd-open')) closeModal() })
  }
  function savePrefs () { try { localStorage.setItem('onegy_music_albums', JSON.stringify(albumPrefs)) } catch (e) {} }
  function openRail () { $('muRail').classList.add('is-open'); $('muRailScrim').classList.add('is-open'); $('muRailToggle').setAttribute('aria-expanded', 'true') }
  function closeRail () { var r = $('muRail'); if (r) r.classList.remove('is-open'); var s = $('muRailScrim'); if (s) s.classList.remove('is-open'); var t = $('muRailToggle'); if (t) t.setAttribute('aria-expanded', 'false') }
  // id: 'muPlModal' (default, new playlist) or 'muClearModal'; [data-autofocus] takes the focus
  function openModal (id) {
    var m = $(id || 'muPlModal'); m.classList.add('rd-open'); m.setAttribute('aria-hidden', 'false')
    if (m.id === 'muPlModal') { $('muPlName').value = ''; $('muPlDesc').value = '' }
    setTimeout(function () { var f = m.querySelector('[data-autofocus]'); if (f) f.focus() }, 30)
  }
  function closeModal () { ['muPlModal', 'muClearModal'].forEach(function (id) { var m = $(id); m.classList.remove('rd-open'); m.setAttribute('aria-hidden', 'true') }) }

  // ---- Boot ----------------------------------------------------------------
  function boot () {
    if (window.MUSIC_DISABLED) return
    view = $('muView'); railEl = $('muRail')
    if (!view || !railEl) return
    wire()
    // The player loads after this script (_app_base.html) and starts itself
    // in the music-library context; nothing plays before it does.
    if (typeof MusicPlayer !== 'undefined' && MusicPlayer.init) { try { MusicPlayer.init('music-library') } catch (e) {} }
    syncPlaying()
    // Likes and playlists come with the page (music_page); fetched otherwise
    var boot = window.MU_BOOT
    if (boot) { S.likes = new Set(boot.likes || []); likesReady = Promise.resolve() } else likesReady = loadLikes()
    likesReady.then(function () {
      updateLikedCount()
      syncPlayerHeart()
      syncHearts()
    })
    if (boot) showPlaylists(boot.playlists || []); else loadPlaylists()
    window.MusicBrowse = { navigate: navigate }
    window.addEventListener('onegy:update', function (e) { e.detail.music = S.at })
    window.addEventListener('pagehide', function () { spotFlush(true); try { sessionStorage.setItem(SS_SCROLL, String(view.scrollTop)) } catch (e) {} })
    try { showPrivate(localStorage.getItem(LS_PRIVATE)) } catch (e) {}
    var at = window.OneGyUpdate && OneGyUpdate.resume && OneGyUpdate.resume.music
    var open = at && VIEWS[at[0]]
    if (open) { open(at[1]); return }
    if (navigateFromHash()) return
    try { at = JSON.parse(sessionStorage.getItem(SS_AT) || 'null') } catch (e) { at = null }
    open = Array.isArray(at) && VIEWS[at[0]]
    if (!open) { viewHome(); return }
    restoreScroll = +sessionStorage.getItem(SS_SCROLL) || 0
    open(at[1])
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
