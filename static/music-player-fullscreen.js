// ─── ONE.GY Music Player: Mobile fullscreen "Now Playing" view and swipe gestures ───
;(function(mp) {
  'use strict'

  // ─── Mobile Fullscreen "Now Playing" ─────────────────────────
  let _fsMql = null                // matchMedia listener for mobile breakpoint

  function _initFullscreen() {
    if (!mp.playerEl) return

    // Collapse button in fullscreen header
    var collapseBtn = document.getElementById('mpFsCollapse')
    if (collapseBtn) {
      collapseBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        _collapseFullscreen()
      })
    }

    // Playlist button in fullscreen header
    var fsPlaylistBtn = document.getElementById('mpFsPlaylistBtn')
    if (fsPlaylistBtn) {
      fsPlaylistBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        if (mp.playlistPanel) {
          mp.playlistPanel.classList.toggle('mp-playlist-visible')
          if (mp.playlistBtn) mp.playlistBtn.classList.toggle('mp-btn-active')
          fsPlaylistBtn.classList.toggle('mp-btn-active')
          // Close devices panel when playlist opens
          if (mp.devicesPanel) mp.devicesPanel.classList.remove('mp-devices-visible')
        }
      })
    }

    // Fullscreen: the queue/devices sheet sits over the controls behind a scrim
    // drawn by the player itself (music.css), so a tap on it closes the sheet.
    mp.playerEl.addEventListener('click', function(e) {
      if (!mp._isFullscreen || e.target !== mp.playerEl) return
      if (mp.playlistPanel) mp.playlistPanel.classList.remove('mp-playlist-visible')
      if (mp.devicesPanel) mp.devicesPanel.classList.remove('mp-devices-visible')
      if (mp.playlistBtn) mp.playlistBtn.classList.remove('mp-btn-active')
      if (fsPlaylistBtn) fsPlaylistBtn.classList.remove('mp-btn-active')
    })

    // Tap on mini player bar (art or info area) to expand -- only on mobile
    var artEl = mp.playerEl.querySelector('.music-player-art')
    var infoEl = mp.playerEl.querySelector('.music-player-info')
    var expandTargets = [artEl, infoEl]
    expandTargets.forEach(function(el) {
      if (!el) return
      el.addEventListener('click', function(e) {
        if (mp._isFullscreen) return
        // Only expand on mobile
        if (!window.matchMedia('(max-width: 850px)').matches) return
        // Don't expand if clicking interactive children (buttons only)
        if (e.target.closest('button') || e.target.closest('a')) return
        e.stopPropagation()
        _expandFullscreen()
      })
    })

    // Fullscreen heart button -- dispatch event for music-browse.js to handle
    if (mp.fsHeartBtn) {
      mp.fsHeartBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        var trackId = (mp.currentIndex >= 0 && mp.playlist[mp.currentIndex]) ? mp.playlist[mp.currentIndex].id : null
        if (!trackId) return
        document.dispatchEvent(new CustomEvent('musicplayer:fslike', { detail: { id: trackId, button: mp.fsHeartBtn } }))
      })
    }

    // Fullscreen add-to-playlist button -- dispatch event for music-browse.js to handle
    if (mp.fsAddBtn) {
      mp.fsAddBtn.addEventListener('click', function(e) {
        e.stopPropagation()
        var trackId = (mp.currentIndex >= 0 && mp.playlist[mp.currentIndex]) ? mp.playlist[mp.currentIndex].id : null
        if (!trackId) return
        document.dispatchEvent(new CustomEvent('musicplayer:fsadd', { detail: { id: trackId, button: mp.fsAddBtn } }))
      })
    }

    // Touch tap feedback for fullscreen controls.
    // CSS pseudo-classes (:active/:hover) stick on mobile Chromium after touch.
    // Use inline style.opacity for tap feedback — fully under JS control.
    var _tapBtn = null
    var _tapTimer = null
    function _clearTap() {
      if (_tapBtn) {
        _tapBtn.style.opacity = ''
        _tapBtn.style.transform = ''
        _tapBtn = null
      }
      if (_tapTimer) { clearTimeout(_tapTimer); _tapTimer = null }
    }
    var controlsEl = mp.playerEl.querySelector('.music-player-controls')
    if (controlsEl) {
      controlsEl.addEventListener('touchstart', function(e) {
        _clearTap()
        var btn = e.target.closest('.mp-btn')
        if (btn) {
          _tapBtn = btn
          btn.style.opacity = btn.classList.contains('mp-btn-play') ? '0.7' : '0.4'
          if (btn.classList.contains('mp-btn-play')) btn.style.transform = 'scale(0.95)'
        }
      }, { passive: true })
      controlsEl.addEventListener('touchend', function() {
        var btn = _tapBtn
        if (btn) {
          _tapTimer = setTimeout(function() { _clearTap() }, 120)
        }
      }, { passive: true })
      controlsEl.addEventListener('touchcancel', function() {
        _clearTap()
      }, { passive: true })
    }

    // Back gesture / hardware back button collapses fullscreen instead of navigating away
    window.addEventListener('popstate', function(e) {
      if (mp._isFullscreen) {
        // The history entry we pushed was already popped, so just collapse visually
        window._mpHandledPopstate = true  // signal to music-browse.js to skip this popstate
        _collapseFullscreen(false, true)
      }
    })

    // Listen for viewport crossing the 850px threshold -- auto-collapse if resized to desktop
    _fsMql = window.matchMedia('(max-width: 850px)')
    _fsMql.addEventListener('change', function(e) {
      if (!e.matches && mp._isFullscreen) {
        _collapseFullscreen(true) // instant, no animation
      }
    })
  }

  // Swipe-down-to-dismiss on mobile (mini player: close; fullscreen: collapse with drag)
  // Use touch events with passive:false to prevent browser pull-to-refresh
  function _bindSwipeDismiss() {
    let _touchStartY = 0
    let _touchStartX = 0
    let _touchStarted = false
    let _touchStartTime = 0
    let _fsDragging = false      // true when actively dragging the fullscreen player
    let _fsScrolledAtStart = false  // whether the fullscreen player was scrolled when touch started

    if (!mp.playerEl) return
      
    mp.playerEl.addEventListener('touchstart', (e) => {
      // Don't capture if touching interactive elements
      if (e.target.closest('button, input, a, .music-player-progress, .mp-playlist-panel')) return

      _touchStartY = e.touches[0].clientY
      _touchStartX = e.touches[0].clientX
      _touchStartTime = Date.now()
      _touchStarted = true
      _fsDragging = false

      if (mp._isFullscreen) {
        // Check if the fullscreen player is scrolled (e.g. long playlist visible)
        _fsScrolledAtStart = mp.playerEl.scrollTop > 0
      }
    }, { passive: false })

    mp.playerEl.addEventListener('touchmove', (e) => {
      if (!_touchStarted) return
      const currentY = e.touches[0].clientY
      const currentX = e.touches[0].clientX
      const deltaY = currentY - _touchStartY
      const deltaX = Math.abs(currentX - _touchStartX)

      if (mp._isFullscreen) {
        // When not scrolled and moving downward, ALWAYS preventDefault to block
        // browser pull-to-refresh / native overscroll before it claims the gesture
        if (!_fsScrolledAtStart && deltaY > 0) {
          e.preventDefault()
        }
        // If we're already dragging the fullscreen panel, keep tracking
        if (_fsDragging) {
          var dragY = Math.max(0, deltaY) * 0.85  // resistance factor
          mp.playerEl.style.transform = 'translateY(' + dragY + 'px)'
          // Fade opacity as user drags further (1.0 at 0px, ~0.6 at full screen height)
          var opacity = Math.max(0.4, 1 - (dragY / (window.innerHeight * 0.8)))
          mp.playerEl.style.opacity = opacity
          return
        }
        // Start visual drag after small threshold, mostly vertical
        if (deltaY > 8 && deltaX < deltaY && !_fsScrolledAtStart) {
          _fsDragging = true
          mp.playerEl.classList.add('mp-fs-dragging')
          return
        }
      } else {
        // Mini player: prevent pull-to-refresh when dragging down
        if (currentY > _touchStartY) {
          e.preventDefault()
        }
      }
    }, { passive: false })

    mp.playerEl.addEventListener('touchend', (e) => {
      if (!_touchStarted) return
      _touchStarted = false

      if (mp._isFullscreen && _fsDragging) {
        _fsDragging = false
        var touchEndY = e.changedTouches[0].clientY
        var dragDistance = Math.max(0, (touchEndY - _touchStartY) * 0.85)
        var velocity = (touchEndY - _touchStartY) / Math.max(1, Date.now() - _touchStartTime)
        var threshold = window.innerHeight * 0.2  // 20% of screen height

        // Dismiss if dragged far enough or flicked fast enough
        if (dragDistance > threshold || velocity > 0.5) {
          // Animate out from current position
          mp.playerEl.style.transition = 'transform 0.25s ease-in, opacity 0.25s ease-in'
          mp.playerEl.style.transform = 'translateY(100%)'
          mp.playerEl.style.opacity = '0'
          // After animation, clean up and actually collapse
          setTimeout(function() {
            mp.playerEl.style.transition = ''
            mp.playerEl.style.transform = ''
            mp.playerEl.style.opacity = ''
            mp.playerEl.classList.remove('mp-fs-dragging')
            // Collapse instantly (the visual slide-out already happened)
            _collapseFullscreen(true)
          }, 260)
        } else {
          // Snap back to original position
          mp.playerEl.style.transition = 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
          mp.playerEl.style.transform = 'translateY(0)'
          mp.playerEl.style.opacity = '1'
          setTimeout(function() {
            mp.playerEl.style.transition = ''
            mp.playerEl.style.transform = ''
            mp.playerEl.style.opacity = ''
            mp.playerEl.classList.remove('mp-fs-dragging')
          }, 260)
        }
        return
      }

      if (mp._isFullscreen) return  // fullscreen but wasn't dragging, ignore

      // Mini player: dismiss on downward swipe > 50px
      var touchEndY2 = e.changedTouches[0].clientY
      var touchEndX2 = e.changedTouches[0].clientX
      var dY = touchEndY2 - _touchStartY
      var dX = Math.abs(touchEndX2 - _touchStartX)
      if (dY > 50 && dX < 50) {
        e.preventDefault()
        mp.closePlayer()
      }
    }, { passive: false })
  }

  function _expandFullscreen() {
    if (mp._isFullscreen || !mp.playerEl) return
    mp._isFullscreen = true
    mp.playerEl.classList.remove('mp-fs-closing')
    // mp-fs-open on the player too: ui-v2.css / files.css key off .music-player.mp-fs-open
    mp.playerEl.classList.add('mp-fullscreen', 'mp-fs-open')
    document.body.classList.add('mp-fs-open')
    // Store scroll position before locking
    document.body.dataset.mpScrollY = window.scrollY
    document.body.style.top = '-' + window.scrollY + 'px'
    // Push history state so mobile back gesture collapses instead of navigating away
    history.pushState({ mpFullscreen: true }, '')
    // Repaint progress fill with fullscreen colors
    mp._updateProgressFill()
  }

  function _collapseFullscreen(instant, fromPopstate) {
    if (!mp._isFullscreen || !mp.playerEl) return
    mp._isFullscreen = false

    // Pop the history entry we pushed on expand (unless triggered by popstate -- already popped)
    if (!fromPopstate) {
      history.back()
    }

    // Repaint progress fill with default colors
    mp._updateProgressFill()

    // Close playlist if open
    if (mp.playlistPanel && mp.playlistPanel.classList.contains('mp-playlist-visible')) {
      mp.playlistPanel.classList.remove('mp-playlist-visible')
      if (mp.playlistBtn) mp.playlistBtn.classList.remove('mp-btn-active')
      var fsPlaylistBtn = document.getElementById('mpFsPlaylistBtn')
      if (fsPlaylistBtn) fsPlaylistBtn.classList.remove('mp-btn-active')
    }

    // Close devices panel if open
    if (mp.devicesPanel && mp.devicesPanel.classList.contains('mp-devices-visible')) {
      mp.devicesPanel.classList.remove('mp-devices-visible')
    }

    // Restore scroll
    document.body.classList.remove('mp-fs-open')
    var scrollY = parseInt(document.body.dataset.mpScrollY || '0', 10)
    document.body.style.top = ''
    window.scrollTo(0, scrollY)

    if (instant) {
      mp.playerEl.classList.remove('mp-fullscreen', 'mp-fs-open', 'mp-fs-closing')
      return
    }

    mp.playerEl.classList.add('mp-fs-closing')
    var cleaned = false
    function cleanup() {
      if (cleaned) return
      cleaned = true
      mp.playerEl.classList.remove('mp-fullscreen', 'mp-fs-open', 'mp-fs-closing')
    }
    mp.playerEl.addEventListener('animationend', function handler(e) {
      if (e.target !== mp.playerEl) return // ignore bubbled events from children
      cleanup()
      mp.playerEl.removeEventListener('animationend', handler)
    }, { once: true })
    // Safety fallback in case animationend never fires
    setTimeout(cleanup, 350)
  }

  Object.assign(mp, {
    _initFullscreen,
    _bindSwipeDismiss,
    _collapseFullscreen,
  })
})(window._mpCore)
