// ─── ONE.GY Music Player: Player bar rendering: title, art, buttons, progress, playlist panel ───
;(function(mp) {
  'use strict'

  const { _stripAudioExtension, _coverUrl } = mp

  function _updatePlayerArt(track) {
    var artEl = mp.playerEl ? mp.playerEl.querySelector('.music-player-art') : null
    if (!artEl) return
    var src = track ? _coverUrl(track.coverPath) : ''
    if (src) {
      var img = document.createElement('img')
      img.src = src
      img.alt = ''
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px'
      artEl.textContent = ''
      artEl.appendChild(img)
    } else {
      artEl.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
    }
  }

  function _renderModeButtons() {
    if (mp.shuffleBtn) mp.shuffleBtn.classList.toggle('mp-btn-active', mp.shuffleMode)
    _updateRepeatButton()
  }

  // ─── Progress bar fill ──────────────────────────────────────────
  function _updateProgressFill() {
    if (!mp.progressEl) return
    var pct = (mp.progressEl.value / mp.progressEl.max) * 100
    // Colours come from --mp-fill / --mp-track (music.css sets them per state)
    var cs = getComputedStyle(mp.progressEl)
    var fillColor = cs.getPropertyValue('--mp-fill').trim() || 'rgba(222,24,51,0.85)'
    var trackColor = cs.getPropertyValue('--mp-track').trim() || 'rgba(255,255,255,0.08)'
    mp.progressEl.style.background = 'linear-gradient(to right, ' + fillColor + ' ' + pct + '%, ' + trackColor + ' ' + pct + '%)'
  }

  // ─── UI Helpers ─────────────────────────────────────────────────

  // Toggle heart/+ button visibility based on context.
  // When playing from user's own library (dashboard), hide the like/add buttons
  // since those files are already in the user's library.
  function _updateOwnLibraryState() {
    if (!mp.playerEl) return
    if (mp._context === 'dashboard') {
      mp.playerEl.classList.add('mp-own-library')
    } else {
      mp.playerEl.classList.remove('mp-own-library')
    }
  }

  function _showPlayer() {
    if (mp.isVisible) return
    mp.isVisible = true
    if (mp.playerEl) {
      mp.playerEl.classList.remove('mp-hiding')
      mp.playerEl.classList.add('mp-visible')
      if (mp._fxEnabled) {
        mp._startFx()
      }
    }
    document.body.classList.add('music-player-active')
    _updateOwnLibraryState()
  }

  function _setFsHeartState(liked) {
    if (!mp.fsHeartBtn) return
    mp.fsHeartBtn.classList.toggle('liked', !!liked)
    mp.fsHeartBtn.title = liked ? 'Unlike' : 'Like'
    if (liked) {
      mp.fsHeartBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    } else {
      mp.fsHeartBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    }
  }

  function _setBarHeartState(liked) {
    var btn = document.getElementById('mpBarHeart')
    if (!btn) return
    btn.classList.toggle('liked', !!liked)
    btn.title = liked ? 'Unlike' : 'Like'
    if (liked) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    } else {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    }
  }

  function _setTitle(text) {
    if (!mp.titleEl) return
    // Strip file extension for display (keep status suffixes like "(decrypting…)")
    let display = text
    const statusMatch = display.match(/^(.+?)(\s*\([^)]+\))$/)
    let baseName = statusMatch ? statusMatch[1] : display
    const suffix = statusMatch ? statusMatch[2] : ''
    baseName = _stripAudioExtension(baseName)
    display = baseName + suffix
    mp.titleEl.title = text

    // Update artist subtitle (works for music-library tracks and suggested tracks in any context)
    var track = (mp.currentIndex >= 0 && mp.currentIndex < mp.playlist.length) ? mp.playlist[mp.currentIndex] : null
    if (mp.artistEl) {
      if (track && track.artists && track.artists.length > 0) {
        // Render each artist as a separate clickable link
        var artistHtml = track.artists.map(function(a) {
          return '<span class="mp-artist-link" data-artist-id="' + _escMp(a.id) + '">' + _escMp(a.name == null ? '' : a.name) + '</span>'
        }).join('<span class="mp-artist-sep">, </span>')
        mp.artistEl.innerHTML = artistHtml
        mp.artistEl.style.display = ''
      } else if (track && track.artistName) {
        mp.artistEl.textContent = String(track.artistName)
        mp.artistEl.style.display = ''
      } else {
        mp.artistEl.textContent = ''
        mp.artistEl.style.display = 'none'
      }
    }

    // Make title clickable to album when track has album info
    if (mp.titleEl) {
      if (track && track.albumId) {
        mp.titleEl.classList.add('mp-title-clickable')
        mp.titleEl.dataset.albumId = track.albumId
      } else {
        mp.titleEl.classList.remove('mp-title-clickable')
        delete mp.titleEl.dataset.albumId
      }
    }

    // Always use static ellipsis (no marquee scroll) -- consistent across all pages
    const inner = mp.titleInner || mp.titleEl
    inner.textContent = display
    mp.titleEl.classList.remove('mp-title-scrolling')
  }

  function _updatePlayButton() {
    if (!mp.playBtn) return
    if (mp.isPlaying) {
      mp.playBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
      mp.playBtn.title = 'PAUSE'
    } else {
      mp.playBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      mp.playBtn.title = 'PLAY'
    }
    // Sync mini play button icon
    if (mp.miniPlayBtn) {
      if (mp.isPlaying) {
        mp.miniPlayBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
        mp.miniPlayBtn.title = 'PAUSE'
      } else {
        mp.miniPlayBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
        mp.miniPlayBtn.title = 'PLAY'
      }
    }
  }

  function _updateVolumeIcon() {
    if (!mp.volumeBtn) return
    // Use slider position for icon thresholds (perceptual, not curved)
    const s = mp._volSlider
    if (s === 0) {
      mp.volumeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
    } else if (s < 0.5) {
      mp.volumeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
    } else {
      mp.volumeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
    }
  }

  function _updateRepeatButton() {
    if (!mp.repeatBtn) return
    mp.repeatBtn.classList.remove('mp-btn-active', 'mp-btn-accent')
    if (mp.repeatMode === 'all') {
      mp.repeatBtn.classList.add('mp-btn-active')
      mp.repeatBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>'
      mp.repeatBtn.title = 'Repeat all'
    } else if (mp.repeatMode === 'one') {
      mp.repeatBtn.classList.add('mp-btn-active', 'mp-btn-accent')
      mp.repeatBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="16" text-anchor="middle" fill="currentColor" stroke="none" font-size="8" font-weight="bold">1</text></svg>'
      mp.repeatBtn.title = 'Repeat one'
    } else {
      mp.repeatBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>'
      mp.repeatBtn.title = 'Repeat off'
    }
  }

  function _formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return mins + ':' + (secs < 10 ? '0' : '') + secs
  }

  // ─── Playlist Panel ─────────────────────────────────────────────
  function _renderPlaylist() {
    if (!mp.playlistPanel) return
    const list = mp.playlistPanel.querySelector('.mp-playlist-list')
    if (!list) return

    if (mp.playlist.length === 0) {
      list.innerHTML = '<div class="mp-playlist-empty">No audio files in this folder</div>'
      return
    }

    let html = ''
    let insertedDivider = false
    for (let i = 0; i < mp.playlist.length; i++) {
      const track = mp.playlist[i]
      const isCurrent = i === mp.currentIndex
      const nameparts = _splitTrackName(track.name)
      // Insert an "Up next: suggested" divider before the first suggested track
      if (!insertedDivider && track.suggested) {
        html += '<div class="mp-playlist-divider"><span>Up next: suggested</span></div>'
        insertedDivider = true
      }
      var artistHtml = (track.artistName) ? `<span class="mp-playlist-artist">${_escMp(track.artistName)}</span>` : ''
      html += `<div class="mp-playlist-item${isCurrent ? ' mp-playlist-current' : ''}${track.suggested ? ' mp-playlist-suggested' : ''}" data-index="${i}">
        <span class="mp-playlist-num">${i + 1}</span>
        <span class="mp-playlist-name">${_escMp(nameparts.base)}<span class="mp-playlist-ext">${_escMp(nameparts.ext)}</span>${artistHtml}</span>
        ${track.isE2E ? '<span class="mp-playlist-e2e">E2E</span>' : ''}
      </div>`
    }
    list.innerHTML = html

    // Event delegation for playlist clicks (single listener instead of per-item)
    if (!list._mpDelegated) {
      list._mpDelegated = true
      list.addEventListener('click', (e) => {
        const item = e.target.closest('.mp-playlist-item')
        if (!item) return
        const idx = parseInt(item.dataset.index)
        if (!isNaN(idx)) {
          if (mp.shuffleMode) {
            mp.shufflePos = mp.shuffleOrder.indexOf(idx)
            if (mp.shufflePos === -1) mp.shufflePos = 0
          }
          mp._loadTrack(idx)
        }
      })
    }
  }

  function _highlightPlaylistItem() {
    if (!mp.playlistPanel) return
    mp.playlistPanel.querySelectorAll('.mp-playlist-item').forEach(item => {
      item.classList.toggle('mp-playlist-current', parseInt(item.dataset.index) === mp.currentIndex)
    })
    // Scroll the current track into view within the playlist panel
    var currentEl = mp.playlistPanel.querySelector('.mp-playlist-current')
    if (currentEl) {
      try { currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } catch(e) {}
    }
  }

  function _splitTrackName(name) {
    if (!name || !name.includes('.')) return { base: name || '', ext: '' }
    const lastDot = name.lastIndexOf('.')
    return { base: name.substring(0, lastDot), ext: name.substring(lastDot) }
  }

  function _measureText(text) {
    // Measure text width using a hidden span with same font as title
    const span = document.createElement('span')
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:inherit'
    span.textContent = text
    if (mp.titleEl) mp.titleEl.appendChild(span)
    else document.body.appendChild(span)
    const w = span.offsetWidth
    span.remove()
    return w
  }

  function _escMp(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  }

  // ─── Music Library Navigation (clickable title/artist) ──────────

  function _navigateMusic(type, id) {
    if (!type || !id) return
    if (window.MusicBrowse && typeof window.MusicBrowse.navigate === 'function') {
      // On the music page: open the view in place (fullscreen would hide it)
      if (mp._isFullscreen) mp._collapseFullscreen()
      window.MusicBrowse.navigate(type, id)
    } else {
      // Navigate to the music page with hash for deep-link (read by music.js)
      window.location.href = '/music#' + type + ':' + encodeURIComponent(id)
    }
  }

  Object.assign(mp, {
    _updatePlayerArt,
    _renderModeButtons,
    _updateProgressFill,
    _updateOwnLibraryState,
    _showPlayer,
    _setFsHeartState,
    _setBarHeartState,
    _setTitle,
    _updatePlayButton,
    _updateVolumeIcon,
    _updateRepeatButton,
    _formatTime,
    _renderPlaylist,
    _highlightPlaylistItem,
    _escMp,
    _navigateMusic,
  })
})(window._mpCore)
