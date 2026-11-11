// ─── ONE.GY Music Player: Media Session, iOS background playback and cross-page persistence ───
;(function(mp) {
  'use strict'

  const { _ssGet, _ssRemove, _isIOS, audio, _stripAudioExtension, _coverUrl } = mp

  var _iosBackgroundRetryTimer = null      // retry timer for iOS background resume

  // ─── Media Session API (lock screen / notification controls) ────
  function _updateMediaSession(track) {
    if (!('mediaSession' in navigator) || !track) return
    var title = _stripAudioExtension(track.name || '')
    var artwork = []
    var coverSrc = _coverUrl(track.coverPath)
    if (coverSrc) artwork = [{ src: coverSrc, type: 'image/jpeg' }]
    var artist = ''
    if (track.artists && track.artists.length > 0) {
      artist = track.artists.map(function(a) { return a.name }).join(', ')
    } else if (track.artistName) {
      artist = track.artistName
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title,
      artist: artist,
      artwork: artwork,
    })
    _updateMediaSessionPositionState()
  }

  function _updateMediaSessionPositionState() {
    if (!('mediaSession' in navigator)) return
    if (mp._syncPhantomMode) {
      // Use phantom interpolation data instead of the silent keepalive audio.
      // Always provide a valid duration — iOS won't show next/prev/scrubber
      // controls without one.  Fall back to 180s if the real duration is
      // unknown (e.g. first poll before loadedmetadata fires on remote).
      var dur = mp._syncPhantomDuration > 0 ? mp._syncPhantomDuration : 180
      var elapsed = mp._syncPhantomPlaying ? (Date.now() - mp._syncPhantomPollTs) / 1000 : 0
      var pos = Math.min(mp._syncPhantomTime + elapsed, dur)
      try {
        navigator.mediaSession.setPositionState({
          duration: dur,
          playbackRate: 1,
          position: pos,
        })
      } catch(e) {}
      return
    }
    if (!isNaN(audio.duration) && audio.duration > 0 && isFinite(audio.duration)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(audio.currentTime, audio.duration),
        })
      } catch(e) {}
    }
  }

  function _initMediaSession() {
    if (!('mediaSession' in navigator)) return
    var actions = {
      play: function() {
        if (mp._syncPhantomMode) {
          mp._syncSendCommand('play')
          mp.isPlaying = true; mp._syncPhantomPlaying = true; mp._syncPhantomPollTs = Date.now()
          mp._updatePlayButton()
          navigator.mediaSession.playbackState = 'playing'
          mp._syncPhantomStartInterpolation()
          // Restart the silent keepalive if iOS killed it via native pause
          if (mp._syncPhantomKeepaliveActive && audio.paused) {
            audio.play().catch(function() {})
          }
          return
        }
        mp._resumeAudioContext()
        // On iOS, the Media Session play handler fires from Control Center /
        // lock screen but the AudioContext may still be suspended and the audio
        // element may have been released.  Retry aggressively with fallbacks.
        audio.play().then(function() {
          console.log('[MUSIC PLAYER] Media Session play: OK')
          mp._wasPlayingBeforeBackground = false
        }).catch(function(err) {
          console.warn('[MUSIC PLAYER] Media Session play failed:', err.message, '- retrying')
          // Retry 1: Resume AudioContext first, then play after a tick
          mp._resumeAudioContext()
          setTimeout(function() {
            audio.play().then(function() {
              console.log('[MUSIC PLAYER] Media Session play retry 1: OK')
              mp._wasPlayingBeforeBackground = false
            }).catch(function(err2) {
              console.warn('[MUSIC PLAYER] Media Session play retry 1 failed:', err2.message, '- resetting src')
              // Retry 2: Re-set audio source (iOS may have released the resource)
              var track = mp.playlist[mp.currentIndex]
              if (track) {
                var savedTime = audio.currentTime || 0
                var src = track.blobUrl || mp._currentBlobUrl || track.sourceUrl
                if (src) {
                  audio.src = src
                  audio.currentTime = savedTime
                  mp._resumeAudioContext()
                  audio.play().then(function() {
                    console.log('[MUSIC PLAYER] Media Session play retry 2 (src reset): OK')
                    mp._wasPlayingBeforeBackground = false
                  }).catch(function(err3) {
                    console.warn('[MUSIC PLAYER] Media Session play: all retries failed:', err3.message)
                  })
                }
              }
            })
          }, 100)
        })
      },
      pause: function() {
        if (mp._syncPhantomMode) {
          mp._syncSendCommand('pause')
          mp.isPlaying = false; mp._syncPhantomPlaying = false
          mp._updatePlayButton()
          navigator.mediaSession.playbackState = 'paused'
          // iOS natively pauses the <audio> element when the user taps pause
          // on the lock screen.  After a microtask delay (to let iOS finish
          // its native pause), restart the silent keepalive so the Media
          // Session stays alive and controls remain responsive.
          if (mp._syncPhantomKeepaliveActive) {
            Promise.resolve().then(function() {
              if (mp._syncPhantomMode && audio.paused) {
                audio.play().then(function() {
                  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
                }).catch(function() {})
              }
            })
          }
          return
        }
        // User explicitly paused via Control Center / lock screen
        mp._wasPlayingBeforeBackground = false
        _stopIOSBackgroundKeepalive()
        audio.pause()
      },
      nexttrack: function() {
        if (mp._syncPhantomMode) { mp._syncSendCommand('next'); return }
        mp.playNext()
      },
      previoustrack: function() {
        if (mp._syncPhantomMode) { mp._syncSendCommand('prev'); return }
        mp.playPrevious()
      },
      seekto: function(details) {
        if (mp._syncPhantomMode) {
          if (details.seekTime != null && mp._syncPhantomDuration > 0) {
            var t = Math.min(details.seekTime, mp._syncPhantomDuration)
            mp._syncSendCommand('seek', { seekTime: t })
            mp._syncPhantomTime = t; mp._syncPhantomPollTs = Date.now()
            mp._syncPhantomRenderProgress(t, mp._syncPhantomDuration)
            _updateMediaSessionPositionState()
          }
          return
        }
        if (!isNaN(audio.duration) && details.seekTime != null) {
          audio.currentTime = Math.min(details.seekTime, audio.duration)
          _updateMediaSessionPositionState()
        }
      },
      seekforward: function(details) {
        if (mp._syncPhantomMode) {
          var fwd = details.seekOffset || 10
          var t = Math.min(mp._syncPhantomTime + fwd, mp._syncPhantomDuration || Infinity)
          mp._syncSendCommand('seek', { seekTime: t })
          mp._syncPhantomTime = t; mp._syncPhantomPollTs = Date.now()
          mp._syncPhantomRenderProgress(t, mp._syncPhantomDuration)
          _updateMediaSessionPositionState()
          return
        }
        var offset = details.seekOffset || 10
        audio.currentTime = Math.min(audio.currentTime + offset, audio.duration || Infinity)
        _updateMediaSessionPositionState()
      },
      seekbackward: function(details) {
        if (mp._syncPhantomMode) {
          var bwd = details.seekOffset || 10
          var t = Math.max(mp._syncPhantomTime - bwd, 0)
          mp._syncSendCommand('seek', { seekTime: t })
          mp._syncPhantomTime = t; mp._syncPhantomPollTs = Date.now()
          mp._syncPhantomRenderProgress(t, mp._syncPhantomDuration)
          _updateMediaSessionPositionState()
          return
        }
        var offset = details.seekOffset || 10
        audio.currentTime = Math.max(audio.currentTime - offset, 0)
        _updateMediaSessionPositionState()
      },
    }
    for (var action in actions) {
      try { navigator.mediaSession.setActionHandler(action, actions[action]) } catch(e) {}
    }
  }

  // ─── iOS Background Audio Keepalive ────────────────────────────
  // iOS Safari aggressively suspends audio when the page is backgrounded.
  // This keepalive periodically tries to resume playback in the background.
  // iOS allows limited JS execution via setInterval for ~30s after
  // backgrounding, and the Media Session play action can also trigger it.
  // The keepalive starts when the page goes hidden (if audio was playing)
  // and stops when the page returns to the foreground.
  function _startIOSBackgroundKeepalive() {
    if (_iosBackgroundRetryTimer) return
    if (!_isIOS) return
    var attempts = 0
    var maxAttempts = 15  // ~30s of retries at 2s intervals
    _iosBackgroundRetryTimer = setInterval(function() {
      attempts++
      if (attempts > maxAttempts || !mp._wasPlayingBeforeBackground) {
        _stopIOSBackgroundKeepalive()
        return
      }
      if (audio.paused && mp._wasPlayingBeforeBackground) {
        mp._resumeAudioContext()
        audio.play().catch(function() {})
      }
    }, 2000)
  }

  function _stopIOSBackgroundKeepalive() {
    if (_iosBackgroundRetryTimer) {
      clearInterval(_iosBackgroundRetryTimer)
      _iosBackgroundRetryTimer = null
    }
  }

  // ─── Cross-page playback persistence ────────────────────────────

  /**
   * Save player state to sessionStorage so playback can resume after
   * a full page navigation.  Only music-library and non-E2E dashboard
   * tracks are saveable (E2E tracks need in-memory decryption keys).
   */
  function _saveState() {
    if (!mp.isVisible || mp.currentIndex < 0 || mp.playlist.length === 0) {
      _ssRemove('mp_state')
      return
    }
    // Don't persist phantom mode state (it's remote, not local)
    if (mp._syncPhantomMode) {
      _ssRemove('mp_state')
      return
    }
    // Don't persist E2E playlists (can't restore without keys)
    var hasE2E = mp.playlist.some(function(t) { return t.isE2E })
    if (hasE2E) {
      _ssRemove('mp_state')
      return
    }
    try {
      var state = {
        context: mp._context,
        browseShareToken: mp._browseShareToken,
        playlist: mp.playlist.map(function(t) {
          return {
            id: t.id,
            name: t.name,
            extension: t.extension || 'opus',
            isE2E: false,
            sourceUrl: t.sourceUrl,
            coverPath: t.coverPath || null,
            artistName: t.artistName || '',
            artistIds: t.artistIds || [],
            artists: t.artists || [],
            albumId: t.albumId || null,
            suggested: t.suggested || false,
          }
        }),
        suggestedStartIndex: mp._suggestedStartIndex,
        currentIndex: mp.currentIndex,
        currentTime: audio.currentTime || 0,
        isPlaying: mp.isPlaying,
        shuffleMode: mp.shuffleMode,
        repeatMode: mp.repeatMode,
        shuffleOrder: mp.shuffleOrder,
        shufflePos: mp.shufflePos,
        ts: Date.now(),
      }
      sessionStorage.setItem('mp_state', JSON.stringify(state))
    } catch(e) {
      // sessionStorage full or disabled — ignore
    }
  }

  /**
   * Attempt to restore player state from sessionStorage.
   * Called at the end of init().  If state is found and valid,
   * the player re-appears with the saved playlist and resumes playback.
   */
  function _restoreState() {
    var raw = _ssGet('mp_state')
    if (!raw) return false
    _ssRemove('mp_state')
    try {
      var state = JSON.parse(raw)
      var requestedContext = mp._context || 'dashboard'
      var requestedBrowseShareToken = mp._browseShareToken || ''
      // Discard stale state (>4 hours old)
      if (Date.now() - state.ts > 4 * 60 * 60 * 1000) return false
      if (!state.playlist || !state.playlist.length) return false
      if ((state.context || 'dashboard') !== requestedContext) return false
      if (requestedContext === 'browse' && (state.browseShareToken || '') !== requestedBrowseShareToken) return false

      mp._context = state.context || 'dashboard'
      mp._browseShareToken = state.browseShareToken || ''
      mp.playlist = state.playlist.map(function(t) {
        return {
          id: t.id,
          name: t.name,
          extension: t.extension || 'opus',
          isE2E: false,
          sourceUrl: t.sourceUrl,
          blobUrl: null,
          coverPath: t.coverPath || null,
          artistName: t.artistName || '',
          artistIds: t.artistIds || [],
          artists: t.artists || [],
          albumId: t.albumId || null,
          suggested: t.suggested || false,
        }
      })
      mp._suggestedStartIndex = (typeof state.suggestedStartIndex === 'number' ? state.suggestedStartIndex : -1)
      mp.shuffleMode = !!state.shuffleMode
      mp.repeatMode = state.repeatMode || 'none'
      mp.shuffleOrder = state.shuffleOrder || []
      mp.shufflePos = (typeof state.shufflePos === 'number' ? state.shufflePos : -1)

      // Update shuffle/repeat UI
      if (mp.shuffleBtn) mp.shuffleBtn.classList.toggle('mp-btn-active', mp.shuffleMode)
      mp._updateRepeatButton()

      // Show the player
      mp._showPlayer()

      // Load the track and seek to saved position
      mp.currentIndex = -1  // reset so _loadTrack runs
      var idx = state.currentIndex
      if (idx < 0 || idx >= mp.playlist.length) idx = 0
      var savedTime = state.currentTime || 0
      var shouldPlay = state.isPlaying

      mp.currentIndex = idx
      var track = mp.playlist[idx]
      mp._setTitle(track.name)
      mp._updatePlayButton()
      mp._highlightPlaylistItem()
      mp._renderPlaylist()

      // Update player art for music library or suggested tracks
      if (mp._context === 'music-library' || track.suggested) {
        mp._updatePlayerArt(track)
      }

      // Update Media Session (lock screen / notification controls)
      _updateMediaSession(track)

      // Fire track change event
      try {
        document.dispatchEvent(new CustomEvent('musicplayer:trackchange', { detail: { id: track.id, name: track.name } }))
      } catch(e) {}

      // Set up the audio source and seek (only while this restore is still
      // the latest load: a track clicked before canplay owns the element).
      mp._resumeAudioContext()
      var restoreSeq = ++mp._loadSeq
      audio.src = track.sourceUrl
      var onCanPlay = function() {
        audio.removeEventListener('canplay', onCanPlay)
        if (restoreSeq !== mp._loadSeq) return
        if (savedTime > 0 && !isNaN(audio.duration) && savedTime < audio.duration) {
          audio.currentTime = savedTime
        }
        if (shouldPlay) {
          mp._resumeAudioContext()
          audio.play().catch(function(err) {
            console.warn('[MUSIC PLAYER] Auto-resume blocked:', err.message)
          })
        }
      }
      audio.addEventListener('canplay', onCanPlay)
      // Also handle the case where canplay fires before we attach the listener
      if (audio.readyState >= 3) {
        audio.removeEventListener('canplay', onCanPlay)
        if (savedTime > 0) audio.currentTime = savedTime
        if (shouldPlay) {
          mp._resumeAudioContext()
          audio.play().catch(function() {})
        }
      }

      return true
    } catch(e) {
      console.warn('[MUSIC PLAYER] Failed to restore state:', e)
      return false
    }
  }

  // Save state before page unload (navigation away)
  window.addEventListener('beforeunload', _saveState)

  // Also save on visibility change (tab close, mobile switch)
  // On iOS, this is also where we handle background audio suspension and
  // foreground resume — iOS Safari aggressively suspends audio when the
  // page is backgrounded and the AudioContext + audio element need to be
  // explicitly resumed when the page returns to the foreground.
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') {
      if (mp.isVisible) _saveState()

      // ── Track whether audio was playing when backgrounded ──
      // Used to auto-resume on foreground return.
      if (mp.isPlaying && !mp._syncPhantomMode) {
        mp._wasPlayingBeforeBackground = true
        // On iOS, try to keep audio alive by re-calling play().
        // iOS Safari sometimes allows a brief play() call from the
        // visibilitychange handler (it's technically still in the
        // foreground when 'hidden' fires).
        if (_isIOS) {
          mp._resumeAudioContext()
          audio.play().catch(function() {})
          // Start periodic keepalive retries for iOS background
          _startIOSBackgroundKeepalive()
        }
      }
    } else if (document.visibilityState === 'visible') {
      // Sync slows down or stops while hidden: catch up right away.
      mp._syncKick()
      // ── Foreground resume ──
      _stopIOSBackgroundKeepalive()
      if (mp._wasPlayingBeforeBackground && !mp._syncPhantomMode) {
        mp._wasPlayingBeforeBackground = false
        mp._resumeAudioContext()
        // iOS may have suspended the audio element — re-trigger play.
        // If the audio source was released, re-set it.
        if (audio.paused) {
          audio.play().then(function() {
            console.log('[MUSIC PLAYER] Foreground resume: play OK')
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
          }).catch(function(err) {
            console.warn('[MUSIC PLAYER] Foreground resume failed, retrying with src reset:', err.message)
            // Last resort: re-set the source and retry.  iOS sometimes
            // releases the audio resource after prolonged backgrounding.
            var track = mp.playlist[mp.currentIndex]
            if (track) {
              var savedTime = audio.currentTime || 0
              var src = track.blobUrl || mp._currentBlobUrl || track.sourceUrl
              if (src) {
                audio.src = src
                audio.currentTime = savedTime
                audio.play().then(function() {
                  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
                }).catch(function() {})
              }
            }
          })
        } else {
          // Audio was not paused (sometimes iOS resumes automatically)
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
        }
        _updateMediaSessionPositionState()
      }
    }
  })

  Object.assign(mp, {
    _updateMediaSession,
    _updateMediaSessionPositionState,
    _initMediaSession,
    _stopIOSBackgroundKeepalive,
    _restoreState,
  })
})(window._mpCore)
