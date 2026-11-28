// ─── ONE.GY Music Player: Listening history (one report per play, docs/music-taste.md) ───
// A play begins when a library track starts on this device (mp._listenStart,
// with its start reason) and is sent once, when it ends. Only the device that
// outputs the audio reports: no mirror, no remote-target mode, no silent
// keepalive loop, never own files. Nothing here polls or runs on a timer:
// timeupdate only does arithmetic.
;(function(mp) {
  'use strict'

  const { _jsonHeaders, _ssGet, _ssSet, _ssRemove, audio } = mp

  const _BACKLOG_KEY = 'mp_listen_backlog'  // reports that failed, sent with the next one
  const _BATCH_MAX = 20     // listens per request (server cap)
  const _SEEK_GAP_S = 1.5   // a bigger jump between timeupdates is a seek, not play
  // How the previous play ended, by why the next track starts
  const _END_FOR_START = { pick: 'pick', next: 'next', prev: 'prev', remote: 'remote', auto: 'done', autoplay: 'done', repeat: 'done' }

  var _play = null          // the play in progress
  var _lastPos = -1         // audio.currentTime at the last timeupdate (-1: take the next one as it is)
  var _lastInputAt = Date.now()

  function _reportable() {
    return mp._context === 'music-library' && !mp._syncPhantomMode && !mp._syncRemoteTarget && !audio.loop
  }

  function _muted() {
    return audio.muted || !(mp._desiredVolume > 0)
  }

  function _uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 3 | 8)).toString(16)
    })
  }

  // User input on this device (pointer, keys, media keys, remote commands): idle_ms
  function _listenInput() {
    _lastInputAt = Date.now()
  }

  // A track starts here: the previous play ends (how depends on why this one
  // starts) and a library track begins a new play. heardMs: the part already
  // heard on the crossfade's side element.
  function _listenStart(reason, track, heardMs) {
    _listenEnd(_END_FOR_START[reason] || 'pick')
    _lastPos = -1
    if (!track || !_reportable()) return
    // The queue's suggested part reached without picking it: the algorithm's choice
    if (track.suggested && (reason === 'auto' || reason === 'next')) reason = 'autoplay'
    heardMs = heardMs > 0 ? heardMs : 0
    _play = {
      client_id: _uuid(),
      song_id: String(track.id),
      album_id: track.albumId != null ? String(track.albumId) : null,
      started_at: Date.now() - Math.round(heardMs),
      ms_played: heardMs,
      duration_ms: track.durationMs > 0 ? Math.round(track.durationMs) : 0,
      seek_fwd: 0,
      seek_back: 0,
      muted_ms: _muted() ? heardMs : 0,
      start_reason: reason,
      context: track.suggested ? 'autoplay' : (mp._listenContext || 'queue'),
      sent_ms: 0,  // ms_played of the last checkpoint sent
    }
  }

  // timeupdate (~4 Hz). Positions before the metadata loaded mean nothing yet
  // (a restore or crossfade seeks once it has).
  function _listenTick() {
    if (!_play) return
    if (_lastPos < 0 && audio.readyState < 1) return
    var pos = audio.currentTime
    if (_lastPos >= 0) {
      var d = pos - _lastPos
      if (d > _SEEK_GAP_S) _play.seek_fwd++
      else if (d < 0) _play.seek_back++
      else if (d > 0 && !audio.paused) {
        _play.ms_played += d * 1000
        if (_muted()) _play.muted_ms += d * 1000
      }
    }
    _lastPos = pos
    if (!_play.duration_ms && audio.duration > 0 && isFinite(audio.duration)) _play.duration_ms = Math.round(audio.duration * 1000)
  }

  // A programmatic seek follows (a transfer starting mid-track): not the user's
  function _listenAdopt() {
    _lastPos = -1
  }

  function _listenEnd(endReason) {
    if (!_play) return
    if (!audio.paused) _listenTick()
    var play = _play
    _play = null
    if (play.ms_played >= 1000) _post([_record(play, endReason, true)])
  }

  // The page is left: a checkpoint (the restored player continues this play
  // and sends the final report). Not again for a play that gained less than
  // a second since the last one (paused across pages).
  function _listenCheckpoint() {
    if (!_play) return
    if (!audio.paused) _listenTick()
    var ms = Math.round(_play.ms_played)
    if (ms < 1000 || ms - _play.sent_ms < 1000) return
    _play.sent_ms = ms
    _post([_record(_play, 'unload', false)])
  }

  // Saved with the player state (mp_state)
  function _listenSnapshot() {
    if (_play && !audio.paused) _listenTick()
    return _play
  }

  // The restored player continues the play the previous page saved
  function _listenResume(saved, track) {
    _play = null
    _lastPos = -1
    if (!saved || !track || typeof saved.client_id !== 'string' || saved.song_id !== String(track.id) ||
        typeof saved.ms_played !== 'number' || !_reportable()) return
    _play = saved
  }

  function _record(play, endReason, final) {
    return {
      client_id: play.client_id,
      song_id: play.song_id,
      album_id: play.album_id,
      device_id: mp._syncDeviceId || null,
      started_at: play.started_at,
      ms_played: Math.round(play.ms_played),
      duration_ms: play.duration_ms || null,
      seek_fwd: play.seek_fwd,
      seek_back: play.seek_back,
      muted_ms: Math.round(play.muted_ms),
      idle_ms: Math.max(0, Date.now() - _lastInputAt),
      start_reason: play.start_reason,
      end_reason: endReason,
      context: play.context,
      final: final,
    }
  }

  function _backlog() {
    try {
      var list = JSON.parse(_ssGet(_BACKLOG_KEY) || '[]')
      return Array.isArray(list) ? list : []
    } catch (e) { return [] }
  }

  // One entry per play (the final report beats a checkpoint, then the longer
  // one wins), at most the newest 20 plays
  function _merge(listens) {
    var byId = {}, out = []
    listens.forEach(function(l) {
      var prev = byId[l.client_id]
      if (!prev) { byId[l.client_id] = l; out.push(l); return }
      if (prev.final && !l.final) return
      if (l.final !== prev.final || l.ms_played >= prev.ms_played) out[out.indexOf(prev)] = byId[l.client_id] = l
    })
    return out.slice(-_BATCH_MAX)
  }

  // keepalive: a report sent while the page unloads still arrives. Reports
  // that failed (network, 429, 5xx) ride along with the next one.
  function _post(listens) {
    var batch = _merge(_backlog().concat(listens))
    _ssRemove(_BACKLOG_KEY)
    fetch('/music/api/listen', {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ listens: batch }),
    }).then(function(r) {
      if (r.status === 429 || r.status >= 500) throw new Error('listen report failed: ' + r.status)
    }).catch(function() {
      _ssSet(_BACKLOG_KEY, JSON.stringify(_merge(_backlog().concat(batch))))
    })
  }

  ;['pointerdown', 'keydown', 'touchstart'].forEach(function(type) {
    document.addEventListener(type, _listenInput, { capture: true, passive: true })
  })

  Object.assign(mp, {
    _listenInput,
    _listenStart,
    _listenTick,
    _listenAdopt,
    _listenEnd,
    _listenCheckpoint,
    _listenSnapshot,
    _listenResume,
  })
})(window._mpCore)
