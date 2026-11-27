// ─── ONE.GY Music Player: Devices buttons and panel toggle (the list: music-player-devices-panel.js, loaded on first open) ───
;(function(mp) {
  'use strict'

  function _syncUpdateDevicesButton() {
    var hasRemoteActive = mp._syncPhantomMode || !!mp._syncRemoteTarget || (mp._syncDevices.length > 1 && mp._syncDevices.some(function(d) { return d.is_active && !d.is_self }))
    if (mp.devicesBtn) mp.devicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp.miniDevicesBtn) mp.miniDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp.fsDevicesBtn) mp.fsDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp.pageDevicesBtn) mp.pageDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp._renderDevicesPanel && mp.devicesPanel && mp.devicesPanel.classList.contains('mp-devices-visible')) mp._renderDevicesPanel(true)
  }

  function _syncShowDevicesButtons() {
    if (mp.devicesBtn) mp.devicesBtn.style.display = ''
    if (mp.miniDevicesBtn) mp.miniDevicesBtn.style.display = ''
    if (mp.fsDevicesBtn) mp.fsDevicesBtn.style.display = ''
  }

  // ─── Devices Panel UI ──────────────────────────────────────────

  function _toggleDevicesPanel() {
    if (!mp.devicesPanel) return
    var isVis = mp.devicesPanel.classList.contains('mp-devices-visible')
    if (isVis) {
      mp.devicesPanel.classList.remove('mp-devices-visible')
    } else {
      // Close playlist panel if open
      if (mp.playlistPanel) mp.playlistPanel.classList.remove('mp-playlist-visible')
      if (mp.playlistBtn) mp.playlistBtn.classList.remove('mp-btn-active')
      var fsPl = document.getElementById('mpFsPlaylistBtn')
      if (fsPl) fsPl.classList.remove('mp-btn-active')
      mp.devicesPanel.classList.add('mp-devices-visible')
      // Loaded once (then cached): later opens render before the next paint
      mp._loadPart('devices').then(function() {
        if (mp.devicesPanel.classList.contains('mp-devices-visible')) mp._renderDevicesPanel()
      }).catch(function(err) { console.warn('[MUSIC PLAYER]', err.message) })
      mp._syncKick()  // idle polling is slow: refresh the device list now
    }
  }

  // Close devices panel when clicking outside
  document.addEventListener('click', function(e) {
    if (mp.devicesPanel && mp.devicesPanel.classList.contains('mp-devices-visible')) {
      if (!mp.devicesPanel.contains(e.target) && !(e.target.closest && e.target.closest('#mpDevicesBtn, #mpMiniDevices, #mpFsDevicesBtn, #muDevicesBtn'))) {
        mp.devicesPanel.classList.remove('mp-devices-visible')
      }
    }
  })

  Object.assign(mp, {
    _syncUpdateDevicesButton,
    _syncShowDevicesButtons,
    _toggleDevicesPanel,
  })
})(window._mpCore)
