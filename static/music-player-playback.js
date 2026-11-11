// ─── ONE.GY Music Player: Track loading, transport controls and <audio> event handlers ───
;(function(mp) {
  'use strict'

  const { _csrfToken, _ssRemove, _isIOS, audio, _clearAudioSrc } = mp

  var _autoQueuePrefetchKey = null    // track the end-of-track prefetch already ran for

  function _onAudioPlay() {
    if (mp._syncPhantomMode) return  // silent keepalive — phantom manages its own state
    mp.isPlaying = true
    mp._updatePlayButton()
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    try { document.dispatchEvent(new CustomEvent('musicplayer:playpause', { detail: { playing: true } })) } catch(e) {}
  }

  function _onAudioPause() {
    if (mp._syncPhantomMode) {
      if (mp._syncPhantomKeepaliveActive) {
        audio.play().then(function() {
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = mp.isPlaying ? 'playing' : 'paused'
          }
        }).catch(function() {})
      }
      return
    }
    // (Not when the track simply ended: play() would restart it.)
    if (_isIOS && document.visibilityState === 'hidden' && mp._wasPlayingBeforeBackground && !audio.ended) {
      audio.play().catch(function() {})
      return
    }
    // A pause during the last seconds must stop the incoming track too, or the
    // crossfade timer finishes and resumes playback. A natural end also fires
    // 'pause' (audio.ended) and must let the crossfade complete.
    if (mp._crossfadeActive && !audio.ended) mp._cancelCrossfade()
    mp.isPlaying = false
    mp._updatePlayButton()
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    try { document.dispatchEvent(new CustomEvent('musicplayer:playpause', { detail: { playing: false } })) } catch(e) {}
  }

  function _onGlobalKeydown(e) {
    if (!mp.isVisible) return
    // defaultPrevented: the page already used the key (Space toggles the
    // selection on /files); focused controls keep Space for activation.
    if (e.defaultPrevented) return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
    if (e.target.closest && e.target.closest('button, a[href], select, [role="button"]')) return

    if (e.key === ' ' && !e.target.closest('.preview-modal') && !e.target.closest('.modal') && !e.target.closest('.music-modal-overlay')) {
      e.preventDefault()
      togglePlay()
    }
  }

  // ─── Track Loading ──────────────────────────────────────────────
  async function _loadTrack(index) {
    if (!Number.isInteger(index) || index < 0 || index >= mp.playlist.length) return
    const loadSeq = ++mp._loadSeq

    mp._syncResetForLocalPlayback()

    // Cancel any in-progress crossfade (e.g. user skipped manually)
    if (mp._crossfadeActive) mp._cancelCrossfade()
    mp._crossfadeTriggered = false  // allow crossfade to re-trigger for new tracks

    mp.currentIndex = index
    const track = mp.playlist[index]

    // Update UI immediately
    mp._setTitle(track.name)
    mp._updatePlayButton()
    mp._highlightPlaylistItem()
    if (mp.progressEl) { mp.progressEl.value = 0; mp.progressEl.max = 1000 }
    mp._updateProgressFill()
    if (mp.currentTimeEl) mp.currentTimeEl.textContent = '0:00'
    if (mp.durationEl) mp.durationEl.textContent = '0:00'

    // The previous blob URL may still be the element's source: revoke it only
    // once the element no longer uses it.
    const oldBlobUrl = mp._currentBlobUrl
    mp._currentBlobUrl = null

    mp._resumeAudioContext()

    if (track.isE2E) {
      // Stop the previous track now instead of letting it play on during the
      // fetch + decrypt.
      audio.pause()
      _clearAudioSrc()
      if (oldBlobUrl) URL.revokeObjectURL(oldBlobUrl)
      await mp._loadE2ETrack(track, loadSeq)
      // A newer _loadTrack started while decrypting: it owns the metadata and
      // trackchange events, so this superseded load must not publish them.
      if (loadSeq !== mp._loadSeq) return
    } else {
      if (loadSeq !== mp._loadSeq) return
      // For dashboard/temp context, the preview endpoint skips download counting
      // on Range requests (which the <audio> element always sends).  Fire a
      // lightweight POST so the play is counted as a download.
      if (mp._context === 'dashboard' || mp._context === 'temp') {
        fetch(`/file/${track.id}/track-play`, {
          method: 'POST',
          headers: { 'X-CSRFToken': _csrfToken() }
        }).catch(() => {})
      }
      audio.src = track.sourceUrl
      if (oldBlobUrl) URL.revokeObjectURL(oldBlobUrl)
      audio.play().then(function() {
        console.log('[MUSIC PLAYER] Play started OK for:', track.name)
      }).catch(function(err) {
        console.warn('[MUSIC PLAYER] Play failed:', err.name, err.message)
      })
    }

    // Update player art for music library tracks (including suggested tracks in any context)
    if (mp._context === 'music-library' || track.suggested) {
      mp._updatePlayerArt(track)
    }

    // Update Media Session (lock screen / notification controls)
    mp._updateMediaSession(track)

    // Fire track change event for music-browse.js
    try {
      document.dispatchEvent(new CustomEvent('musicplayer:trackchange', { detail: { id: track.id, name: track.name } }))
    } catch(e) {}
  }
  function _seekToProgress() {
    var dur = mp._syncPhantomMode ? mp._syncPhantomDuration : audio.duration
    if (!(dur > 0) || !isFinite(dur)) return
    var t = (mp.progressEl.value / 1000) * dur
    if (mp._syncPhantomMode) {
      mp._syncSendCommand('seek', { seekTime: t })
      // Optimistic update — reset interpolation origin
      mp._syncPhantomTime = t
      mp._syncPhantomPollTs = Date.now()
    } else {
      audio.currentTime = t
    }
  }

  // ─── Playback Controls ─────────────────────────────────────────
  // Phantom mode (another device is playing): every entry point — buttons,
  // mini bar, Space — sends a remote command instead of driving the local
  // silent keepalive. This used to live only on the buttons' click handlers.
  function togglePlay() {
    if (mp._syncPhantomMode) {
      var play = !mp.isPlaying
      mp._syncSendCommand(play ? 'play' : 'pause')
      // Optimistic UI update
      mp.isPlaying = play
      mp._syncPhantomPlaying = play
      if (play) mp._syncPhantomPollTs = Date.now()
      mp._updatePlayButton()
      return
    }
    mp._resumeAudioContext()
    if (audio.paused) {
      audio.play().catch(function(err) {
        console.warn('[MUSIC PLAYER] togglePlay failed:', err.name, err.message)
      })
    } else {
      // User explicitly paused — don't auto-resume on foreground return
      mp._wasPlayingBeforeBackground = false
      mp._stopIOSBackgroundKeepalive()
      audio.pause()
    }
  }

  function playNext() {
    if (mp._syncPhantomMode) { mp._syncSendCommand('next'); return }
    if (mp.playlist.length === 0) return
    mp._resumeAudioContext()
    if (mp.repeatMode === 'one') {
      audio.currentTime = 0
      audio.play().catch(() => {})
      return
    }

    let nextIdx
    if (mp.shuffleMode) {
      mp.shufflePos++
      if (mp.shufflePos >= mp.shuffleOrder.length) {
        if (mp.repeatMode === 'all') {
          mp._generateShuffleOrder()
          // The new order is anchored on the track that just ended; start the
          // next cycle past it instead of replaying it (as the auto-queue path does).
          mp.shufflePos = (mp.shuffleOrder.length > 1 && mp.shuffleOrder[0] === mp.currentIndex) ? 1 : 0
        } else if (mp._canAutoQueueSuggested()) {
          // Nothing loaded yet: keep the cursor on the last track so Previous
          // still steps back (a successful auto-queue re-anchors it below).
          mp.shufflePos = mp.shuffleOrder.length - 1
          // Auto-queue suggested songs from the music library
          var seqAtQueue = mp._loadSeq
          mp._autoQueueSuggested().then(function(added) {
            // Bail if a newer load started during the fetch (e.g. the user
            // clicked a different track), otherwise we'd clobber their choice.
            if (seqAtQueue !== mp._loadSeq) return
            // _autoQueueSuggested appended a shuffled order of only the new
            // tracks after the current one (indices may have shifted on trim).
            var pos = mp.shuffleOrder.indexOf(mp.currentIndex) + 1
            if (added && pos > 0 && pos < mp.shuffleOrder.length) {
              mp.shufflePos = pos
              _loadTrack(mp.shuffleOrder[mp.shufflePos])
            } else {
              _pauseAtQueueEnd()
            }
          })
          return
        } else {
          mp.shufflePos = mp.shuffleOrder.length - 1
          _pauseAtQueueEnd()
          return
        }
      }
      nextIdx = mp.shuffleOrder[mp.shufflePos]
    } else {
      nextIdx = mp.currentIndex + 1
      if (nextIdx >= mp.playlist.length) {
        if (mp.repeatMode === 'all') {
          nextIdx = 0
        } else if (mp._canAutoQueueSuggested()) {
          // Auto-queue suggested songs from the music library
          var seqAtQueueSeq = mp._loadSeq
          mp._autoQueueSuggested().then(function(added) {
            // Bail if a newer load started during the fetch (e.g. the user
            // clicked a different track), otherwise we'd clobber their choice.
            if (seqAtQueueSeq !== mp._loadSeq) return
            if (added) {
              // Use currentIndex + 1 (not a pre-captured index) because
              // _autoQueueSuggested may trim played tracks from the front,
              // shifting all indices. currentIndex is adjusted during trim.
              _loadTrack(mp.currentIndex + 1)
            } else {
              _pauseAtQueueEnd()
            }
          })
          return
        } else {
          _pauseAtQueueEnd()
          return
        }
      }
    }
    _loadTrack(nextIdx)
  }

  // The queue ran out: this pause is not an interruption to undo when the
  // tab returns to the foreground.
  function _pauseAtQueueEnd() {
    mp._wasPlayingBeforeBackground = false
    mp._stopIOSBackgroundKeepalive()
    audio.pause()
  }

  function playPrevious() {
    if (mp._syncPhantomMode) { mp._syncSendCommand('prev'); return }
    if (mp.playlist.length === 0) return
    // If more than 3 seconds in, restart current track
    if (audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }

    let prevIdx
    if (mp.shuffleMode) {
      mp.shufflePos--
      if (mp.shufflePos < 0) {
        if (mp.repeatMode === 'all') {
          mp.shufflePos = mp.shuffleOrder.length - 1
        } else {
          mp.shufflePos = 0
          audio.currentTime = 0
          return
        }
      }
      prevIdx = mp.shuffleOrder[mp.shufflePos]
    } else {
      prevIdx = mp.currentIndex - 1
      if (prevIdx < 0) {
        if (mp.repeatMode === 'all') {
          prevIdx = mp.playlist.length - 1
        } else {
          audio.currentTime = 0
          return
        }
      }
    }
    _loadTrack(prevIdx)
  }

  // Shuffle/repeat in phantom mode belong to the remote device (no remote
  // command exists); the next poll would silently revert a local toggle.
  function toggleShuffle() {
    if (mp._syncPhantomMode) return
    mp.shuffleMode = !mp.shuffleMode
    if (mp.shuffleBtn) {
      mp.shuffleBtn.classList.toggle('mp-btn-active', mp.shuffleMode)
    }
    if (mp.shuffleMode) {
      mp._generateShuffleOrder()
    }
  }

  function cycleRepeat() {
    if (mp._syncPhantomMode) return
    if (mp.repeatMode === 'none') {
      mp.repeatMode = 'all'
    } else if (mp.repeatMode === 'all') {
      mp.repeatMode = 'one'
      if (mp._crossfadeActive) mp._cancelCrossfade()
    } else {
      mp.repeatMode = 'none'
    }
    mp._updateRepeatButton()
  }

  function closePlayer() {
    mp._loadSeq++  // invalidate any in-flight track load (e.g. a pending decrypt)
    if (mp._isFullscreen) mp._collapseFullscreen(true)
    mp._cancelCrossfade()
    mp._stopIOSBackgroundKeepalive()
    mp._wasPlayingBeforeBackground = false
    audio.loop = false  // clear silent keepalive loop flag if set
    audio.pause()
    _clearAudioSrc()
    if (mp._currentBlobUrl) {
      URL.revokeObjectURL(mp._currentBlobUrl)
      mp._currentBlobUrl = null
    }
    if (mp._chaosMode) mp._stopChaos()
    mp._stopFxLoop()
    // Reset sync state
    mp._syncIsActive = false
    mp._syncStop()
    mp._syncPhantomMode = false
    mp._syncPhantomTrackId = null
    mp._syncPhantomKeepaliveActive = false
    if (mp._syncPhantomRAF) { cancelAnimationFrame(mp._syncPhantomRAF); mp._syncPhantomRAF = null }
    if (mp._syncPhantomPositionTimer) { clearInterval(mp._syncPhantomPositionTimer); mp._syncPhantomPositionTimer = null }
    if (mp.playerEl) mp.playerEl.classList.remove('mp-phantom')
    if (mp.phantomLabel) mp.phantomLabel.textContent = ''
    if (mp.devicesPanel) mp.devicesPanel.classList.remove('mp-devices-visible')
    mp.isVisible = false
    mp.isPlaying = false
    mp.currentIndex = -1
    mp.playlist = []
    _ssRemove('mp_state')
    mp._suggestedStartIndex = -1
    mp._suggestApiUnavailable = false
    mp._autoQueueLoading = false
    mp._autoQueuePromise = null
    mp._autoQueueFailures = 0
    mp._autoQueueRetryAt = 0
    mp._crossfadeTriggered = false
    if (mp.playerEl) {
      mp.playerEl.classList.remove('mp-visible', 'mp-fx-active', 'mp-fx-chaos')
      mp.playerEl.classList.add('mp-hiding')
      mp.playerEl.addEventListener('animationend', function handler() {
        mp.playerEl.classList.remove('mp-hiding')
        mp.playerEl.removeEventListener('animationend', handler)
      }, { once: true })
    }
    // Remove body padding adjustment
    document.body.classList.remove('music-player-active')
  }

  // ─── Audio Event Handlers ──────────────────────────────────────
  function _onTimeUpdate() {
    if (mp._syncPhantomMode) return  // phantom mode drives progress via interpolation, not the silent keepalive
    if (!isNaN(audio.duration) && audio.duration > 0) {
      if (!mp._scrubbing) {
        if (mp.progressEl) mp.progressEl.value = Math.round((audio.currentTime / audio.duration) * 1000)
        if (mp.currentTimeEl) mp.currentTimeEl.textContent = mp._formatTime(audio.currentTime)
        mp._updateProgressFill()
      }

      // Update Media Session position state (throttled to ~every 5s)
      var now = Date.now()
      if (now - mp._lastPositionUpdate > 5000) {
        mp._lastPositionUpdate = now
        mp._updateMediaSessionPositionState()
      }

      // Crossfade: detect when approaching the autoplay boundary (never under
      // repeat-one, which must replay the current track instead of advancing)
      if (mp._canAutoQueueSuggested() && mp.repeatMode !== 'one' && !mp._crossfadeActive && !mp._crossfadeTriggered) {
        var timeRemaining = audio.duration - audio.currentTime
        var isAtSuggestedBoundary = false

        if (mp._suggestedStartIndex > 0 && !mp.shuffleMode) {
          // Non-shuffle: we are at the boundary if currentIndex is one before suggested start
          isAtSuggestedBoundary = (mp.currentIndex === mp._suggestedStartIndex - 1)
        } else if (mp._suggestedStartIndex > 0 && mp.shuffleMode) {
          // In shuffle: check if next shufflePos would enter suggested territory
          var nextShuffleIdx = mp.shufflePos + 1
          if (nextShuffleIdx < mp.shuffleOrder.length) {
            isAtSuggestedBoundary = mp.playlist[mp.shuffleOrder[nextShuffleIdx]] && mp.playlist[mp.shuffleOrder[nextShuffleIdx]].suggested
                                     && mp.playlist[mp.currentIndex] && !mp.playlist[mp.currentIndex].suggested
          }
        } else if (mp.repeatMode !== 'all' && !mp.shuffleMode && mp.currentIndex === mp.playlist.length - 1) {
          // Last track with no suggested tracks yet -- crossfade will happen after auto-queue
          // Pre-fetch suggestions so crossfade can work: once per loaded track
          // (timeupdate fires ~4/s; a failed fetch must not be retried at that rate).
          var prefetchKey = mp._loadSeq + ':' + mp.currentIndex
          if (timeRemaining <= 10 && !mp._autoQueueLoading && _autoQueuePrefetchKey !== prefetchKey) {
            _autoQueuePrefetchKey = prefetchKey
            mp._autoQueueSuggested()
          }
        }

        if (isAtSuggestedBoundary && timeRemaining <= 5 && timeRemaining > 0.5) {
          mp._startCrossfade()
        }
      }
    }
  }

  function _onMetadataLoaded() {
    if (mp._syncPhantomMode) return  // silent keepalive — phantom manages duration display
    if (mp.durationEl && !isNaN(audio.duration)) {
      mp.durationEl.textContent = mp._formatTime(audio.duration)
    }
    if (mp.progressEl) mp.progressEl.max = 1000
    mp._updateMediaSessionPositionState()
  }

  function _onTrackEnded() {
    if (mp._syncPhantomMode) return  // silent keepalive loops — should never fire ended, but guard anyway
    if (mp._crossfadeActive) {
      // Crossfade is in progress -- finalize the transition
      mp._finalizeCrossfade()
      return
    }
    if (mp.repeatMode === 'one') {
      mp._resumeAudioContext()
      audio.currentTime = 0
      audio.play().catch(() => {})
    } else {
      playNext()
    }
  }

  function _onError(e) {
    if (mp._syncPhantomMode) return  // silent keepalive — ignore errors
    // No source (cleared on stop/phantom exit): nothing failed to play, and an
    // auto-skip here would start playback on its own.
    if (!audio.getAttribute('src')) return
    console.error('[MUSIC PLAYER] Audio error:', e)
    var track = mp.playlist[mp.currentIndex]
    if (track) mp._setTitle(track.name + ' (playback error)')

    // Reset playing state so the UI accurately reflects that nothing is playing
    mp.isPlaying = false
    mp._updatePlayButton()

    // Auto-advance to next track after a brief delay, but cap consecutive
    // error-skips to prevent infinite loops (e.g. total connectivity loss)
    mp._errorSkipCount++
    if (mp._errorSkipCount <= 3 && mp.playlist.length > 1) {
      const skipSeq = mp._loadSeq
      setTimeout(function() {
        if (skipSeq === mp._loadSeq) playNext()  // a newer load/close supersedes the skip
      }, 1500)
    } else if (mp._errorSkipCount > 3) {
      console.warn('[MUSIC PLAYER] Too many consecutive errors, stopping auto-advance')
      mp._errorSkipCount = 0
    }
  }

  Object.assign(mp, {
    _onAudioPlay,
    _onAudioPause,
    _onGlobalKeydown,
    _loadTrack,
    _seekToProgress,
    togglePlay,
    playNext,
    playPrevious,
    toggleShuffle,
    cycleRepeat,
    closePlayer,
    _onTimeUpdate,
    _onMetadataLoaded,
    _onTrackEnded,
    _onError,
  })
})(window._mpCore)
