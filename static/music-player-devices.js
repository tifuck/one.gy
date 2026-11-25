// ─── ONE.GY Music Player: Devices panel UI ───
;(function(mp) {
  'use strict'

  const { _jsonHeaders, _lsSet } = mp

  function _syncUpdateDevicesButton() {
    var hasRemoteActive = mp._syncPhantomMode || !!mp._syncRemoteTarget || (mp._syncDevices.length > 1 && mp._syncDevices.some(function(d) { return d.is_active && !d.is_self }))
    if (mp.devicesBtn) mp.devicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp.miniDevicesBtn) mp.miniDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp.fsDevicesBtn) mp.fsDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp.pageDevicesBtn) mp.pageDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp.devicesPanel && mp.devicesPanel.classList.contains('mp-devices-visible')) _renderDevicesPanel(true)
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
      _renderDevicesPanel()
      mp.devicesPanel.classList.add('mp-devices-visible')
      mp._syncKick()  // idle polling is slow: refresh the device list now
    }
  }

  var _panelKey = null  // what the open list shows; polls re-render it only on change

  function _renderDevicesPanel(onlyIfChanged) {
    if (!mp.devicesList) return
    var key = JSON.stringify([mp._syncDevices.map(function(d) { return [d.device_id, d.device_name, d.is_active, d.is_self] }),
      mp._syncPhantomMode, mp._syncRemoteTarget, mp._syncEnabled, mp._syncPushing()])
    if (onlyIfChanged && key === _panelKey) return
    _panelKey = key
    // Not rebuilt under an open rename field (the list refreshes on every poll)
    if (mp.devicesList.querySelector('.mp-device-rename-input')) return
    var devices = mp._syncDevices.length ? mp._syncDevices : [{ device_id: mp._syncDeviceId, device_name: mp._syncDeviceName, is_self: true, is_active: mp._syncIsActive }]
    var target = mp._syncRemoteTarget ? mp._syncRemoteTarget.id : null
    var playingHere = mp._syncPushing()
    var html = ''

    // Sync toggle
    html += '<div class="mp-devices-sync-toggle">'
    html += '<span class="mp-devices-sync-label">Cross-device sync</span>'
    html += '<button class="mp-sync-toggle' + (mp._syncEnabled ? ' mp-sync-on' : '') + '" id="mpSyncToggle" role="switch" aria-checked="' + mp._syncEnabled + '" title="' + (mp._syncEnabled ? 'Disable' : 'Enable') + ' sync"></button>'
    html += '</div>'

    for (var i = 0; i < devices.length; i++) {
      var d = devices[i]
      var isActive = d.is_active
      var isSelf = d.is_self
      html += '<div class="mp-device-item' + (isActive ? ' mp-device-active' : '') + '" data-device-id="' + mp._escMp(d.device_id) + '">'

      // Device icon
      html += '<div class="mp-device-icon">'
      if (/iPhone|Android/.test(d.device_name)) {
        html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'
      } else if (/iPad/.test(d.device_name)) {
        html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'
      } else {
        html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
      }
      html += '</div>'

      // Info
      html += '<div class="mp-device-info">'
      html += '<div class="mp-device-name">' + mp._escMp(d.device_name) + '</div>'
      var badge = ''
      if (isActive && isSelf) {
        badge = '<span class="mp-device-badge mp-device-badge-active">This device &middot; Playing</span>'
      } else if (isActive && !isSelf) {
        badge = '<span class="mp-device-badge mp-device-badge-active">' + (mp._syncPhantomMode ? 'Playing &middot; controlling' : 'Playing &middot; tap to control') + '</span>'
      } else if (isSelf && mp._syncPhantomMode) {
        badge = '<span class="mp-device-badge mp-device-badge-transfer">This device &middot; tap to play here</span>'
      } else if (isSelf && target) {
        badge = '<span class="mp-device-badge mp-device-badge-transfer">This device &middot; tap to disconnect</span>'
      } else if (isSelf) {
        badge = '<span class="mp-device-badge">This device</span>'
      } else if (d.device_id === target) {
        badge = '<span class="mp-device-badge mp-device-badge-active">Connected</span>'
      } else if (playingHere || mp._syncPhantomMode) {
        badge = '<span class="mp-device-badge mp-device-badge-transfer">Tap to move playback here</span>'
      } else {
        badge = '<span class="mp-device-badge mp-device-badge-transfer">Tap to control</span>'
      }
      html += badge
      html += '</div>'

      // Actions
      html += '<div class="mp-device-actions">'
      html += '<button class="mp-device-action-btn" data-action="rename" title="Rename"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>'
      if (!isSelf) {
        html += '<button class="mp-device-action-btn" data-action="remove" title="Remove"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>'
      }
      html += '</div>'
      html += '</div>'
    }

    mp.devicesList.innerHTML = html

    // Bind events
    var syncToggle = document.getElementById('mpSyncToggle')
    if (syncToggle) {
      syncToggle.addEventListener('click', function() {
        mp._syncEnabled = !mp._syncEnabled
        _lsSet('mp_sync_enabled', mp._syncEnabled ? '1' : '0')
        if (mp._syncEnabled) {
          mp._syncStart()
        } else {
          mp._syncStop()
          if (mp._syncPhantomMode) mp._syncExitPhantom()
        }
        _renderDevicesPanel()
      })
    }

    // Click on a device item to transfer playback to/from it
    var deviceItems = mp.devicesList.querySelectorAll('.mp-device-item')
    for (var di = 0; di < deviceItems.length; di++) {
      deviceItems[di].addEventListener('click', function(e) {
        // Don't trigger transfer if clicking action buttons
        if (e.target.closest('.mp-device-action-btn') || e.target.closest('.mp-device-rename-input')) return
        var item = e.currentTarget
        var devId = item.dataset.deviceId
        if (!devId) return
        var dev = devices.filter(function(x) { return x.device_id === devId })[0]
        if (!dev) return

        if (devId === mp._syncDeviceId) {
          if (mp._syncPhantomMode) mp._syncRequestTransfer()  // pull playback here
          else if (mp._syncRemoteTarget) mp._syncClearRemoteTarget()  // stop controlling
          else return
        } else if (dev.is_active && !mp._syncPhantomMode) {
          // Already playing there: mirror and control it (also after closing its bar)
          mp._syncPhantomDismissed = null
          mp._syncKick()
        } else if (dev.is_active || devId === (mp._syncRemoteTarget && mp._syncRemoteTarget.id)) {
          return  // already controlling it
        } else if (playingHere || mp._syncPhantomMode) {
          mp._syncTransferToDevice(devId)  // move the session there
        } else {
          mp._syncSetRemoteTarget(dev)  // idle device: control it, play from here
        }
        mp.devicesPanel.classList.remove('mp-devices-visible')
      })
    }

    // Rename/remove action buttons
    var actionBtns = mp.devicesList.querySelectorAll('.mp-device-action-btn')
    for (var j = 0; j < actionBtns.length; j++) {
      actionBtns[j].addEventListener('click', function(e) {
        e.stopPropagation()
        var btn = e.currentTarget
        var item = btn.closest('.mp-device-item')
        var devId = item ? item.dataset.deviceId : ''
        var action = btn.dataset.action
        if (action === 'rename') {
          _syncRenameDevice(devId, item)
        } else if (action === 'remove') {
          _syncRemoveDevice(devId)
        }
      })
    }
  }

  function _syncRenameDevice(devId, itemEl) {
    if (!itemEl) return
    var nameEl = itemEl.querySelector('.mp-device-name')
    if (!nameEl) return
    var currentName = nameEl.textContent
    nameEl.innerHTML = '<input class="mp-device-rename-input" type="text" value="' + mp._escMp(currentName) + '" maxlength="100">'
    var input = nameEl.querySelector('input')
    if (!input) return
    input.focus()
    input.select()
    var submitted = false
    var submit = function() {
      if (submitted) return
      submitted = true
      var newName = input.value.trim()
      if (!newName || newName === currentName) {
        nameEl.textContent = currentName
        return
      }
      nameEl.textContent = newName
      // Update server
      fetch('/music/api/sync/device', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: _jsonHeaders(),
        body: JSON.stringify({ device_id: devId, name: newName }),
      }).then(function(r) { return r.json() }).then(function(data) {
        if (data.ok && devId === mp._syncDeviceId) {
          mp._syncDeviceName = newName
          _lsSet('mp_device_name', newName)
        }
      }).catch(function() {})
    }
    input.addEventListener('blur', submit)
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); input.blur() }
      if (e.key === 'Escape') { submitted = true; nameEl.textContent = currentName }
    })
  }

  function _syncRemoveDevice(devId) {
    fetch('/music/api/sync/device', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: _jsonHeaders(),
      body: JSON.stringify({ device_id: devId }),
    }).then(function() {
      mp._syncDevices = mp._syncDevices.filter(function(d) { return d.device_id !== devId })
      _renderDevicesPanel()
    }).catch(function() {})
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
