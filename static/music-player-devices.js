// ─── ONE.GY Music Player: Devices panel UI ───
;(function(mp) {
  'use strict'

  const { _jsonHeaders, _lsSet } = mp

  function _syncUpdateDevicesButton() {
    var hasRemoteActive = mp._syncPhantomMode || (mp._syncDevices.length > 1 && mp._syncDevices.some(function(d) { return d.is_active && !d.is_self }))
    if (mp.devicesBtn) mp.devicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp.miniDevicesBtn) mp.miniDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
    if (mp.fsDevicesBtn) mp.fsDevicesBtn.classList.toggle('mp-sync-active', hasRemoteActive)
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

  function _renderDevicesPanel() {
    if (!mp.devicesList) return
    var devices = mp._syncDevices.length ? mp._syncDevices : [{ device_id: mp._syncDeviceId, device_name: mp._syncDeviceName, is_self: true, is_active: mp._syncIsActive }]
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
        badge = '<span class="mp-device-badge mp-device-badge-active">Playing</span>'
      } else if (isSelf && mp._syncPhantomMode) {
        badge = '<span class="mp-device-badge mp-device-badge-transfer">Tap to play here</span>'
      } else if (isSelf) {
        badge = '<span class="mp-device-badge">This device</span>'
      } else if (!isSelf && mp._syncIsActive) {
        badge = '<span class="mp-device-badge mp-device-badge-transfer">Tap to transfer</span>'
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

        if (devId === mp._syncDeviceId) {
          // Clicked on self — "play on this device" (pull from remote)
          if (mp._syncPhantomMode) {
            mp._syncRequestTransfer()
            mp.devicesPanel.classList.remove('mp-devices-visible')
          }
        } else {
          // Clicked on a remote device — push playback to it
          mp._syncTransferToDevice(devId)
          mp.devicesPanel.classList.remove('mp-devices-visible')
        }
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
      if (!mp.devicesPanel.contains(e.target) && e.target !== mp.devicesBtn && (!mp.devicesBtn || !mp.devicesBtn.contains(e.target))) {
        mp.devicesPanel.classList.remove('mp-devices-visible')
      }
    }
  })

  Object.assign(mp, {
    _syncUpdateDevicesButton,
    _toggleDevicesPanel,
  })
})(window._mpCore)
