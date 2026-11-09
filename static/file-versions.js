/* File versions tab of the Files manage modal (templates/_manage_modal.html).
   Lists /file/<id>/versions and downloads, restores or deletes one. E2EE
   versions are decrypted here with their own file key. When a website edit
   rotated the key since that version, restore installs the version's key, so
   the current name and share-link wraps are re-encrypted under it first (same
   steps as the editor's save in preview.js). Hooks in without touching
   files.js / manage-modal.js: the tab ships hidden and is shown for files. */
;(function () {
  'use strict'

  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function csrf () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : (document.querySelector('input[name="csrf_token"]') || {}).value || '' }
  function toast (m, c) { if (window.showToast) window.showToast(m, c) }
  function fmtSize (n) { n = Number(n) || 0; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ } return (i ? n.toFixed(1) : n) + ' ' + u[i] }
  function fmtDate (iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString() }
  function modal () { return window.ManageModal }
  function currentFileId () { var m = modal(); return m && m.getCurrentType() === 'file' ? m.getCurrentId() : null }
  function pane () { return document.querySelector('#manageModal .manage-modal-tab-content[data-tab="versions"]') }

  var state = { fileId: null, data: null }

  function syncTab () {
    var tab = document.querySelector('#manageModal .manage-modal-tab[data-tab="versions"]')
    if (tab) tab.hidden = !currentFileId()
  }

  async function api (path, opts) {
    var r = await fetch(path, Object.assign({ headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrf(), 'Content-Type': 'application/json' } }, opts || {}))
    var body = null
    try { body = await r.json() } catch (e) {}
    if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status))
    return body
  }

  function render () {
    var p = pane(); if (!p) return
    var list = (state.data && state.data.versions) || []
    if (!list.length) {
      p.innerHTML = '<div class="manage-modal-details"><div class="manage-modal-detail"><span class="manage-modal-detail-label">No previous versions</span>' +
        '<span class="manage-modal-detail-value">Replacing the content keeps the old one here.</span></div></div>'
      return
    }
    p.innerHTML = '<div class="manage-modal-details">' + list.map(function (v) {
      return '<div class="manage-modal-detail">' +
        '<span class="manage-modal-detail-label"><strong>Version ' + esc(v.content_version) + '</strong><br>' + esc(fmtDate(v.created_at)) + ' · ' + esc(fmtSize(v.size)) + '</span>' +
        '<span class="manage-modal-detail-value">' +
        '<button type="button" class="rd-btn rd-btn-sm rd-btn-ghost" data-fv-act="download" data-fv="' + esc(v.version_id) + '">Download</button> ' +
        '<button type="button" class="rd-btn rd-btn-sm rd-btn-ghost" data-fv-act="restore" data-fv="' + esc(v.version_id) + '">Restore</button> ' +
        '<button type="button" class="rd-btn rd-btn-sm rd-btn-danger" data-fv-act="delete" data-fv="' + esc(v.version_id) + '">Delete</button>' +
        '</span></div>'
    }).join('') + '</div>'
  }

  async function load () {
    var id = currentFileId(), p = pane()
    if (!id || !p) return
    state.fileId = id
    p.innerHTML = '<div class="manage-modal-loading">Loading</div>'
    try {
      var data = await api('/file/' + encodeURIComponent(id) + '/versions')
      if (state.fileId !== id) return
      state.data = data
      render()
    } catch (e) { p.innerHTML = '<div class="manage-modal-loading">' + esc(e.message) + '</div>' }
  }

  function find (vid) { return ((state.data && state.data.versions) || []).filter(function (v) { return v.version_id === vid })[0] }
  function baseName () { var d = modal() && modal().getCurrentData(); return (d && d.name) || 'file' }

  async function masterKey () {
    var k = window.OneGyCrypto && await window.OneGyCrypto.getMasterKeyFromSession()
    if (!k) throw new Error('UNLOCK YOUR KEYS FIRST')
    return k
  }

  async function download (v) {
    var url = '/file/' + encodeURIComponent(state.fileId) + '/versions/' + encodeURIComponent(v.version_id) + '/content'
    var name = 'v' + v.content_version + ' - ' + baseName()
    if (!v.encrypted_file_key) { window.location.href = url; return }
    var r = await fetch(url)
    if (!r.ok) throw new Error('DOWNLOAD FAILED (HTTP ' + r.status + ')')
    var plain = await window.OneGyCrypto.decryptFileForDownload(await r.arrayBuffer(), v.encrypted_file_key, v.file_key_nonce, await masterKey())
    var a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([plain]))
    a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(function () { URL.revokeObjectURL(a.href) }, 30000)
  }

  // The version's key differs from the live one: re-encrypt the live name and
  // link wraps under it (server requires them, see _restore_key_error).
  async function rekeyFields (v) {
    var C = window.OneGyCrypto, mk = await masterKey(), body = {}
    var id = state.fileId
    var ki = await (await fetch('/f/' + encodeURIComponent(id) + '/key-info')).json()
    var md = await api('/file/' + encodeURIComponent(id) + '/manage-data')
    var versionKey = await C.unwrapFileKeyWithMasterKey(v.encrypted_file_key, v.file_key_nonce, mk)
    if (ki && ki.encrypted_name) {
      var liveKey = await C.unwrapFileKeyWithMasterKey(ki.encrypted_file_key, ki.file_key_nonce, mk)
      var name = await C.decryptFileName(ki.encrypted_name, ki.name_nonce, liveKey)
      var en = await C.encryptFileName(name, versionKey)
      body.encrypted_name = en.encryptedName; body.name_nonce = en.nameNonce
    }
    if (md.has_file_link_key || (md.is_link_shared && !md.ancestor_share_token && !md.has_folder_link_key)) {
      var fls = await C.deriveLinkSecret(mk, 'file', id)
      var lw = await C.wrapFileKeyForLink(versionKey, fls.linkKey)
      body.link_encrypted_file_key = lw.encryptedFileKey; body.link_file_key_nonce = lw.nonce
    }
    if (md.has_folder_link_key || md.ancestor_share_token) {
      var gls = await C.deriveLinkSecret(mk, 'folder', md.ancestor_share_token)
      var fw = await C.wrapFileKeyForLink(versionKey, gls.linkKey)
      body.folder_link_encrypted_file_key = fw.encryptedFileKey; body.folder_link_file_key_nonce = fw.nonce
    }
    return body
  }

  async function restore (v) {
    var ok = !window.showConfirm || await window.showConfirm('Restore version ' + v.content_version + '?',
      'It becomes the current content. The current content is kept as a version.', 'Restore', null, 'confirm-warn')
    if (!ok) return
    var body = v.same_key ? {} : await rekeyFields(v)
    body.base_content_version = state.data.content_version
    await api('/file/' + encodeURIComponent(state.fileId) + '/versions/' + encodeURIComponent(v.version_id) + '/restore',
      { method: 'POST', body: JSON.stringify(body) })
    // The page holds the old file key; reload so previews decrypt with the restored one.
    if (!v.same_key) { window.location.reload(); return }
    toast('VERSION RESTORED', 'success')
    await load()
  }

  async function remove (v) {
    var ok = !window.showConfirm || await window.showConfirm('Delete version ' + v.content_version + '?',
      'This version is deleted for good.', 'Delete')
    if (!ok) return
    await api('/file/' + encodeURIComponent(state.fileId) + '/versions/' + encodeURIComponent(v.version_id) + '/delete', { method: 'POST' })
    toast('VERSION DELETED', 'success')
    await load()
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('#manageModal .manage-modal-tab[data-tab="versions"]')) { load(); return }
    var b = e.target.closest('#manageModal [data-fv-act]')
    if (!b) return
    var v = find(b.getAttribute('data-fv'))
    if (!v) return
    var act = b.getAttribute('data-fv-act')
    b.disabled = true
    ;(act === 'download' ? download(v) : act === 'restore' ? restore(v) : remove(v))
      .catch(function (err) { toast(String(err && err.message || err).toUpperCase(), 'error') })
      .finally(function () { b.disabled = false })
  })

  function init () {
    var root = document.getElementById('manageModal')
    if (!root) return
    new MutationObserver(syncTab).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    syncTab()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
