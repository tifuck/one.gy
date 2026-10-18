// CSRF token helper function
function getCSRFToken() {
  const tokenInput = document.querySelector('input[name="csrf_token"]');
  if (tokenInput) {
    return tokenInput.value;
  }
  // Fallback: get from meta tag if exists
  const tokenMeta = document.querySelector('meta[name="csrf-token"]');
  if (tokenMeta) {
    return tokenMeta.content;
  }
  return '';
}

// Generate a random 16-character passphrase for E2EE guest uploads
function _generatePassphrase() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let result = '';
  const maxUnbiased = Math.floor(256 / chars.length) * chars.length;
  while (result.length < 16) {
    const randomValues = crypto.getRandomValues(new Uint8Array(16));
    for (let i = 0; i < randomValues.length && result.length < 16; i++) {
      if (randomValues[i] >= maxUnbiased) continue;
      result += chars.charAt(randomValues[i] % chars.length);
    }
  }
  return result;
}

// In-memory (never persisted) store for client-generated thumbnails of E2E
// files. A thumbnail rendered from plaintext must not go to sessionStorage:
// unlike TempKeychain it would not be wrapped by the cookie-derived AES key,
// so a readable preview of E2E content would live outside the encryption
// boundary. manage-modal.js reads this same Map. The server-side ENCRYPTED
// thumbnail still covers the after-reload case.
function _getMemThumbStore() {
  if (!window.__onegyMemThumbs) window.__onegyMemThumbs = new Map();
  return window.__onegyMemThumbs;
}

// TempKeychain previously returned silently when the onegy_manager cookie was
// missing (AUDIT FIX F5 switched its key to a client-only secret, so the
// cookie is no longer required), but a write can still fail on storage quota
// errors — and this passphrase is the ONLY thing that can decrypt the upload,
// so a resolving store() proves nothing on its own. Read the value back and
// verify it landed before treating the passphrase as persisted.
async function _storePassphraseVerified(fileId, passphrase) {
  if (typeof TempKeychain === 'undefined' || !fileId || !passphrase) return false;
  try {
    await TempKeychain.store(fileId, passphrase);
    const readBack = await TempKeychain.get(fileId);
    return readBack === passphrase;
  } catch (e) {
    return false;
  }
}

// Blocking hand-off shown when the passphrase could NOT be persisted. The
// secret exists only in this page's memory, so this panel has no backdrop, no
// escape key and no close button — the user must copy the link or explicitly
// acknowledge. A beforeunload guard catches an accidental navigation.
function _showUnsavedShareLinkPanel(shareUrl, alreadyCopied) {
  return new Promise((resolve) => {
    const dropZone = document.getElementById('dropZone');
    if (!dropZone) { resolve(); return; }

    const guardUnload = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', guardUnload);

    dropZone.classList.add('uploading');
    // Release the locked progress-card height so the warning can size itself
    dropZone.style.height = '';
    dropZone.innerHTML = `
      <div class="upload-progress-card">
        <div class="upload-card-header">
          <span class="upload-card-title">SAVE THIS LINK NOW</span>
        </div>
        <div class="upload-card-body">
          <div class="upload-card-stats">
            <div class="upload-card-stat">
              <span class="upload-card-stat-label">KEYCHAIN</span>
              <span class="upload-card-stat-value">NOT SAVED</span>
            </div>
            <div class="upload-card-stat">
              <span class="upload-card-stat-label">RECOVERY</span>
              <span class="upload-card-stat-value">THIS LINK ONLY</span>
            </div>
          </div>
          <p class="upload-card-filename">THIS LINK HOLDS THE ONLY COPY OF THE DECRYPTION SECRET AND COULD NOT BE STORED IN THIS BROWSER. IT WILL NOT BE IN THE MANAGE PANEL. IF YOU LEAVE WITHOUT SAVING IT, NOBODY CAN EVER DECRYPT THIS FILE.</p>
          <input type="text" id="unsavedShareLink" readonly style="width:100%;padding:.6rem;border:2px solid var(--border);background:var(--surface-2);color:var(--text);font-family:var(--font-mono);font-size:.72rem">
          <div style="display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center">
            <button type="button" id="unsavedShareCopy" class="rd-btn rd-btn-primary">COPY LINK</button>
            <button type="button" id="unsavedShareAck" class="rd-btn rd-btn-ghost">I HAVE SAVED IT</button>
          </div>
        </div>
      </div>
    `;

    const linkInput = document.getElementById('unsavedShareLink');
    const copyBtn = document.getElementById('unsavedShareCopy');
    const ackBtn = document.getElementById('unsavedShareAck');
    // Assign via property so the URL is never parsed as markup
    if (linkInput) linkInput.value = shareUrl;

    let acknowledged = alreadyCopied === true;
    // Guard against a stray click landing on the acknowledge button: it only
    // becomes usable once the link has been copied, or after a short delay.
    if (ackBtn) {
      ackBtn.disabled = !acknowledged;
      if (!acknowledged) {
        setTimeout(() => { if (ackBtn) ackBtn.disabled = false; }, 3000);
      }
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        let ok = false;
        try {
          await navigator.clipboard.writeText(shareUrl);
          ok = true;
        } catch (e) {
          if (linkInput) {
            linkInput.select();
            try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
          }
        }
        if (ok) {
          copyBtn.textContent = 'COPIED';
          acknowledged = true;
          if (ackBtn) ackBtn.disabled = false;
          showToast('SHARE LINK COPIED — STORE IT SOMEWHERE SAFE', 'success');
        } else {
          if (linkInput) linkInput.select();
          showToast('COPY FAILED — SELECT THE LINK AND COPY IT MANUALLY', 'error');
          if (ackBtn) ackBtn.disabled = false;
        }
      });
    }

    if (ackBtn) {
      ackBtn.addEventListener('click', () => {
        window.removeEventListener('beforeunload', guardUnload);
        resolve();
      });
    } else {
      window.removeEventListener('beforeunload', guardUnload);
      resolve();
    }
  });
}

function formatBytes(bytes) {
  for (let unit of ['B', 'KB', 'MB', 'GB']) {
    if (bytes < 1024) {
      return bytes + ' ' + unit;
    }
    bytes /= 1024;
    if (Math.floor(bytes) === 0 || !isFinite(bytes)) {
      return '0 B';
    }
  }
  return bytes.toFixed(2) + ' TB';
}

async function traverseDirectory(directory, files, path = '') {
  const dirReader = directory.createReader();
  // readEntries() returns results in batches (~100 entries at a time)
  // Must call repeatedly until it returns an empty array
  let entries;
  do {
    entries = await new Promise((resolve, reject) => dirReader.readEntries(resolve, reject));
    for (let entry of entries) {
      if (entry.isDirectory) {
        await traverseDirectory(entry, files, path + directory.name + '/');
      } else {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        // Store the full path in the file object
        const fullPath = path + directory.name + '/' + file.name;
        Object.defineProperty(file, 'fullPath', {
          value: fullPath,
          writable: false
        });
        files.push(file);
      }
    }
  } while (entries.length > 0);
}

// Initialize drop zone upload handlers. Called on page load and also from SPA
// navigation to /share (since script.js is loaded once and skipped on re-nav,
// the drop zone element is new but has no handlers attached).
window.initShareUpload = function() {
  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;

  // Prevent double-init: mark the element after first setup
  if (dropZone._uploadInitialized) return;
  dropZone._uploadInitialized = true;

  let fileInput = document.getElementById('fileInput');
  if (!fileInput) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'fileInput';
    input.style.display = 'none';
    document.body.appendChild(input);
    fileInput = input;

    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      uploadFiles(files);
    });
  }

  // Always bind click on the (possibly new) drop zone to trigger the file dialog
  // But NOT when clicking on toggles (checkboxes/sliders/labels)
  dropZone.addEventListener('click', (e) => {
    if (e.target.closest('.drop-zone-toggles')) return;
    fileInput.value = '';
    fileInput.click();
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function highlight() {
    dropZone.classList.add('dragover');
  }

  function unhighlight() {
    dropZone.classList.remove('dragover');
  }

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(type => {
    dropZone.addEventListener(type, preventDefaults, false);
  });

  ['dragenter', 'dragover'].forEach(type => {
    dropZone.addEventListener(type, highlight, false);
  });

  ['dragleave', 'drop'].forEach(type => {
    dropZone.addEventListener(type, unhighlight, false);
  });

  dropZone.addEventListener('drop', async (e) => {
    const files = [];
    const items = e.dataTransfer.items;

    if (items && items.length > 0) {
      for (let item of items) {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          if (entry.isFile) {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            Object.defineProperty(file, 'fullPath', {
              value: file.name,
              writable: false
            });
            files.push(file);
          } else if (entry.isDirectory) {
            await traverseDirectory(entry, files, '');
          }
        } else {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }
    } else {
      const fileList = e.dataTransfer.files;
      for (let file of fileList) {
        files.push(file);
      }
    }

    uploadFiles(files);
  });
};

// Auto-initialize on page load (non-SPA path)
initShareUpload();

async function uploadFiles(files) {
  if (files.length === 0) {
    showToast('NO FILES TO UPLOAD', 'error');
    return;
  }

  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;
  const maxGb = typeof MAX_GB !== 'undefined' ? MAX_GB : 1.0;
  const maxBytes = maxGb * 1024 * 1024 * 1024;
  const maxGbDisplay = maxGb === Math.floor(maxGb) ? maxGb.toFixed(0) : maxGb.toFixed(1);
  // Capture toggle states before replacing HTML so we can restore them
  const _shortChecked = document.getElementById('shortToggle')?.checked ?? false;
  const _e2eChecked = document.getElementById('e2eToggle')?.checked ?? true;
  const originalHTML = `<div class="drop-zone-body">
  <div class="drop-zone-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="56" height="56"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
  <h2 class="drop-zone-title">DROP FILES HERE</h2>
  <p class="drop-zone-text">OR CLICK TO BROWSE</p>
</div>
<div class="drop-zone-toggles">
  <span class="drop-zone-limit">MAX ${maxGbDisplay} GB</span>
  <div class="drop-zone-toggle"><div class="toggle-switch"><input type="checkbox" id="shortToggle" class="toggle-checkbox"${_shortChecked ? ' checked' : ''}><span class="toggle-slider"></span></div><span class="drop-zone-toggle-label">SHORT URL</span></div>
  <div class="drop-zone-toggle"><div class="toggle-switch"><input type="checkbox" id="e2eToggle" class="toggle-checkbox"${_e2eChecked ? ' checked' : ''}><span class="toggle-slider"></span></div><span class="drop-zone-toggle-label">E2E ENCRYPT</span></div>
</div>`;

  // Check file sizes before upload
  let totalSize = 0;
  for (let file of files) {
    if (file.size > maxBytes) {
      showToast(`FILE "${file.name.toUpperCase()}" (${formatBytes(file.size)}) EXCEEDS MAXIMUM SIZE OF ${maxGb} GB`, 'error');
      return;
    }
    totalSize += file.size;
  }
  
  // Warn about memory limits for client-side ZIP/E2E operations
  const MAX_BROWSER_ZIP_SIZE = 512 * 1024 * 1024; // 512MB
  const isE2EChecked = document.getElementById('e2eToggle').checked;
  if ((files.length > 1 || isE2EChecked) && totalSize > MAX_BROWSER_ZIP_SIZE) {
    const msg = isE2EChecked
      ? `E2E encryption requires loading all files into browser memory. Total size ${formatBytes(totalSize)} may cause browser issues. For large files, consider uploading without E2E encryption. Continue anyway?`
      : `Creating a ZIP of ${files.length} files (${formatBytes(totalSize)}) requires loading them into browser memory. This may cause browser issues with very large uploads. Continue anyway?`;
    if (!confirm(msg)) return;
  }

  // Lock the drop zone height so the progress card matches the idle panel exactly
  const dropZoneHeight = dropZone.offsetHeight;
  dropZone.style.height = dropZoneHeight + 'px';

  const isE2E = document.getElementById('e2eToggle').checked;

  // Warn user if uploading without E2E encryption
  if (!isE2E && typeof showConfirm === 'function') {
    const shieldIcon = '🔓';
    const fileCount = files.length;
    const fileLabel = fileCount === 1 ? 'FILE' : 'FILES';
    const confirmed = await showConfirm(
      'NO END-TO-END ENCRYPTION',
      `YOUR ${fileLabel} WILL BE UPLOADED WITH SERVER-SIDE ENCRYPTION ONLY. FOR MAXIMUM PRIVACY, ENABLE THE E2E ENCRYPTION TOGGLE.`,
      'UPLOAD ANYWAY',
      shieldIcon
    );
    if (!confirmed) {
      dropZone.style.height = '';
      return;
    }
  }

  let encryptedFiles = files;
  
  // Check if any file has folder structure (fullPath property)
  const hasFolderStructure = files.some(file => file.fullPath && file.fullPath !== file.name);
  
  // For non-E2E uploads with folder structure or multiple files, create zip first
  // This preserves folder structure in the zip
  if (!isE2E && (files.length > 1 || hasFolderStructure)) {
    const fileText = files.length === 1 ? 'FILE' : 'FILES';
    dropZone.classList.add('uploading');
    dropZone.innerHTML = `
      <div class="upload-progress-card">
        <div class="upload-card-header">
          <span class="upload-card-title">PREPARING ${files.length} ${fileText}</span>
        </div>
        <div class="upload-card-body">
          <div class="upload-card-bar">
            <div class="upload-card-fill" id="progressFill"></div>
          </div>
          <div class="upload-card-stats">
            <div class="upload-card-stat">
              <span class="upload-card-stat-label">STATUS</span>
              <span class="upload-card-stat-value" id="progressStatus">PREPARING...</span>
            </div>
            <div class="upload-card-stat">
              <span class="upload-card-stat-label">PROGRESS</span>
              <span class="upload-card-stat-value" id="progressPercent">0%</span>
            </div>
            <div class="upload-card-stat">
              <span class="upload-card-stat-label">SPEED</span>
              <span class="upload-card-stat-value" id="progressSpeed">--</span>
            </div>
          </div>
        </div>
      </div>
    `;
    
    try {
      // Create zip with folder structure preserved
      const zipBlob = await createZip(files);
      // Use original folder name if this was a folder upload, otherwise generic name
      let zipName = `files_${files.length}.zip`;
      if (hasFolderStructure) {
        const firstPath = files.find(f => f.fullPath && f.fullPath.includes('/'));
        if (firstPath) {
          const folderName = firstPath.fullPath.split('/')[0];
          if (folderName) zipName = folderName + '.zip';
        }
      }
      encryptedFiles = [new File([zipBlob], zipName, { type: 'application/zip' })];
    } catch (error) {
      showToast('FAILED TO PREPARE FILES: ' + error.message, 'error');
      dropZone.classList.remove('uploading');
      dropZone.innerHTML = originalHTML;
      dropZone.style.height = '';
      return;
    }
  }

  // Generate client-side thumbnail before encryption (while plaintext is available)
  let pendingThumbnailDataUrl = null;
  let pendingThumbnailBlob = null;
  if (isE2E && files.length === 1 && typeof OneGyCrypto !== 'undefined') {
    try {
      const thumbBlob = await OneGyCrypto.generateThumbnail(files[0]);
      if (thumbBlob) {
        pendingThumbnailBlob = thumbBlob;
        pendingThumbnailDataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(thumbBlob);
        });
      }
    } catch (e) {
      // Thumbnail generation is non-critical
    }
  }

  // E2EE key metadata for upload
  let e2eEncryptedFileKey, e2eFileKeyNonce, e2eFileKeySalt;
  let e2eEncryptedThumbBlob = null, e2eEncryptedThumbNonce = null;
  let e2eEncryptedName = null, e2eNameNonce = null, e2eStoredExtension = null;
  let e2eGuestPassphrase = null;  // Store passphrase for post-upload keychain persistence
  
  if (isE2E) {
    // Temp uploads always use passphrase wrapping (even for logged-in users)
    // so recipients can decrypt with just the passphrase — no account needed
    // Passphrase is auto-generated silently — share link contains it in the URL fragment
    const passphrase = _generatePassphrase();
    e2eGuestPassphrase = passphrase;
    
    const fileText = files.length === 1 ? 'FILE' : 'FILES';
    dropZone.classList.add('uploading');
    dropZone.innerHTML = `
      <div class="upload-progress-card">
        <div class="upload-card-header">
          <span class="upload-card-title">ENCRYPTING ${files.length} ${fileText}</span>
        </div>
        <div class="upload-card-body">
          <div class="upload-card-bar">
            <div class="upload-card-fill" id="progressFill"></div>
          </div>
          <div class="upload-card-stats">
            <div class="upload-card-stat">
              <span class="upload-card-stat-label">STATUS</span>
              <span class="upload-card-stat-value" id="progressStatus">ENCRYPTING...</span>
            </div>
            <div class="upload-card-stat">
              <span class="upload-card-stat-label">PROGRESS</span>
              <span class="upload-card-stat-value" id="progressPercent">0%</span>
            </div>
            <div class="upload-card-stat">
              <span class="upload-card-stat-label">SPEED</span>
              <span class="upload-card-stat-value" id="progressSpeed">--</span>
            </div>
          </div>
        </div>
      </div>
    `;
    try {
      const fillEl = document.getElementById('progressFill');
      const percentEl = document.getElementById('progressPercent');
      const statusEl = document.getElementById('progressStatus');
      
      // Step 1: Prepare file data
      // For single files (no folder structure): encrypt the raw file directly (no ZIP wrapper)
      // For multiple files or folder uploads: ZIP first, then encrypt the ZIP
      // AUDIT FIX F4: pass the File/zip Blob itself instead of materializing a
      // full ArrayBuffer — crypto.js streams Blob input in 64MB slices inside
      // the worker, so the plaintext never fully lands in main-thread memory
      // (the old `await files[0].arrayBuffer()` held the whole file, then
      // crypto.js made ANOTHER full copy to hand it to the worker).
      let dataToEncrypt;
      let uploadFileName;
      const e2eHasFolderStructure = files.some(f => f.fullPath && f.fullPath !== f.name);
      
      if (files.length === 1 && !e2eHasFolderStructure) {
        statusEl.textContent = 'PREPARING FILE...';
        dataToEncrypt = files[0];
        uploadFileName = files[0].name;
      } else {
        statusEl.textContent = 'PREPARING FILES...';
        dataToEncrypt = await createZip(files);
        // Use original folder name if this was a folder upload
        uploadFileName = `files_${files.length}.zip`;
        if (e2eHasFolderStructure) {
          const firstPath = files.find(f => f.fullPath && f.fullPath.includes('/'));
          if (firstPath) {
            const folderName = firstPath.fullPath.split('/')[0];
            if (folderName) uploadFileName = folderName + '.zip';
          }
        }
      }
      
      statusEl.textContent = 'ENCRYPTING...';
      if (fillEl) fillEl.style.width = '10%';
      if (percentEl) percentEl.textContent = '10%';
      
      // Step 2: Encrypt with per-file key using OneGyCrypto
      // Temp uploads always use passphrase wrapping for shareability
      let result;
      result = await OneGyCrypto.encryptFileForGuestUpload(dataToEncrypt, passphrase, function(pct) {
        if (fillEl) fillEl.style.width = (10 + pct * 0.85) + '%';
        if (percentEl) percentEl.textContent = Math.round(10 + pct * 0.85) + '%';
      });
      e2eEncryptedFileKey = result.encryptedFileKey;
      e2eFileKeyNonce = result.fileKeyNonce;
      e2eFileKeySalt = result.fileKeySalt;
      
      // Encrypt thumbnail with the file key (so it can be stored server-side and decrypted later)
      if (pendingThumbnailBlob && result.fileKey) {
        try {
          // Reading our own data: URL with fetch() is blocked by the site's
          // connect-src CSP. Keep the generated Blob and read it directly.
          const thumbArrayBuf = await pendingThumbnailBlob.arrayBuffer();
          const encThumb = await OneGyCrypto.encryptThumbnail(thumbArrayBuf, result.fileKey);
          e2eEncryptedThumbBlob = new Blob([encThumb.data], { type: 'application/octet-stream' });
          e2eEncryptedThumbNonce = encThumb.nonce;
        } catch (e) {
          // Thumbnail encryption is non-critical
        }
      }
      
      if (fillEl) fillEl.style.width = '100%';
      if (percentEl) percentEl.textContent = '100%';
      statusEl.textContent = 'ENCRYPTION COMPLETE';
      
      // Encrypt filename (zero-knowledge: server never sees real name)
      try {
        const nameResult = await OneGyCrypto.encryptFileName(uploadFileName, result.fileKey);
        e2eEncryptedName = nameResult.encryptedName;
        e2eNameNonce = nameResult.nameNonce;
        e2eStoredExtension = OneGyCrypto.extractExtension(uploadFileName);
      } catch (nameErr) {
        console.error('[E2E NAME ENCRYPT]', nameErr);
        throw new Error('FILENAME ENCRYPTION FAILED');
      }
      
      // Use generic filename in multipart -- real name is in encrypted_name field (zero-knowledge)
      encryptedFiles = [new File([result.encryptedBlob], 'encrypted.bin', { type: 'application/octet-stream' })];
      
    } catch (error) {
      showToast('ENCRYPTION FAILED: ' + error.message, 'error');
      dropZone.classList.remove('uploading');
      dropZone.innerHTML = originalHTML;
      dropZone.style.height = '';
      return;
    }
  }

  const MAX_RETRIES = 3;
  const fileText = files.length === 1 ? 'FILE' : 'FILES';
  const totalUploadSize = encryptedFiles.reduce((sum, file) => sum + file.size, 0);
  
  // Collect form settings once (before innerHTML replacement)
  const expires = document.getElementById('expires')?.value;
  const maxDownloads = document.getElementById('maxDownloads')?.value;
  const password = document.getElementById('password')?.value;
  const isPublic = document.getElementById('isPublic')?.checked;
  // #shortToggle lives in the drop zone, which preparation has already
  // replaced by now; use the state captured before that rebuild.
  const isShortUrl = _shortChecked;
  const csrfToken = getCSRFToken();
  
  let cancelled = false;
  let activeXhr = null;
  // True once the request body has been fully sent — from that moment the
  // server is in its finalizing/saving phase and may already have committed
  // the file, so an abort would orphan it (and lose the E2E passphrase).
  let bodyFullySent = false;
  
  dropZone.classList.add('uploading');
  dropZone.innerHTML = `
    <div class="upload-progress-card">
      <div class="upload-card-header">
        <span class="upload-card-title">UPLOADING ${files.length} ${fileText}</span>
        <button id="progressCancel" class="upload-card-close" title="CANCEL UPLOAD">&times;</button>
      </div>
      <div class="upload-card-body">
        <div class="upload-card-bar">
          <div class="upload-card-fill" id="progressFill"></div>
        </div>
        <div class="upload-card-stats">
          <div class="upload-card-stat">
            <span class="upload-card-stat-label">STATUS</span>
            <span class="upload-card-stat-value" id="progressStatus">UPLOADING...</span>
          </div>
          <div class="upload-card-stat">
            <span class="upload-card-stat-label">PROGRESS</span>
            <span class="upload-card-stat-value" id="progressPercent">0%</span>
          </div>
          <div class="upload-card-stat">
            <span class="upload-card-stat-label" id="progressSpeedLabel">SPEED</span>
            <span class="upload-card-stat-value" id="progressSpeed">--</span>
          </div>
        </div>
        <div class="upload-card-filename" id="progressEta"></div>
      </div>
    </div>
  `;
  
  // Wire up cancel button
  document.getElementById('progressCancel').addEventListener('click', () => {
    // Refuse to abort once the body is fully sent: the server is already
    // finalizing and may have committed the file. Aborting would leave a
    // committed upload whose passphrase was never persisted — unrecoverable.
    if (bodyFullySent) {
      showToast('UPLOAD ALREADY SENT — THE SERVER IS SAVING IT AND IT CAN NO LONGER BE CANCELLED', 'error');
      return;
    }
    cancelled = true;
    if (activeXhr) activeXhr.abort();
  });
  
  // Build formData helper (needed for retries — FormData can't be reused after send)
  function buildFormData(fileId) {
    const fd = new FormData();
    for (let file of encryptedFiles) {
      fd.append('files', file);
    }
    fd.append('file_id', fileId);
    fd.append('upload_id', fileId);
    // Be explicit: this widget is the temp/quick-share uploader, so it always
    // wants an expiring public link. The server no longer defaults is_temp to
    // true for an authenticated user (an omitted flag used to give logged-in
    // users a public file that self-destructed in 24h), so the intent has to
    // be stated here rather than inferred.
    fd.append('is_temp', 'true');
    if (isE2E) {
      fd.append('e2e', 'true');
      // MEGA-style: per-file wrapped key metadata
      if (e2eEncryptedFileKey) fd.append('encrypted_file_key', e2eEncryptedFileKey);
      if (e2eFileKeyNonce) fd.append('file_key_nonce', e2eFileKeyNonce);
      if (e2eFileKeySalt) fd.append('file_key_salt', e2eFileKeySalt);
      // E2EE encrypted filename
      if (e2eEncryptedName) {
        fd.append('encrypted_name', e2eEncryptedName);
        fd.append('name_nonce', e2eNameNonce);
        fd.append('stored_extension', e2eStoredExtension);
      }
      // Encrypted thumbnail (stored server-side, decrypted client-side on page load)
      if (e2eEncryptedThumbBlob && e2eEncryptedThumbNonce) {
        fd.append('encrypted_thumbnail', e2eEncryptedThumbBlob, 'thumb.enc.jpg');
        fd.append('thumbnail_nonce', e2eEncryptedThumbNonce);
      }
    }
    if (csrfToken) fd.append('csrf_token', csrfToken);
    if (expires) fd.append('expires', expires);
    if (maxDownloads) fd.append('max_downloads', maxDownloads);
    if (password) fd.append('password', password);
    if (isPublic) fd.append('is_public', 'true');
    if (isShortUrl) fd.append('short_url', 'true');
    return fd;
  }

  // AUDIT FIX F6: upload idempotency key. randomUUID() when available,
  // otherwise a CSPRNG-built UUIDv4 — the old Math.random() fallback made the
  // server-side dedupe key guessable/collision-prone (Math.random() is not a
  // CSPRNG). getRandomValues is present in every browser that can run the
  // WebCrypto E2EE path this uploader already requires.
  function _secureUploadId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    const b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // UUIDv4 version bits
    b[8] = (b[8] & 0x3f) | 0x80; // UUIDv4 variant bits
    const h = [];
    for (let i = 0; i < 16; i++) h.push(b[i].toString(16).padStart(2, '0'));
    const s = h.join('');
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
  }
  const uploadFileId = _secureUploadId();
  
  // Retry loop
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (cancelled) {
      dropZone.classList.remove('uploading');
      dropZone.innerHTML = originalHTML;
      dropZone.style.height = '';
      return;
    }
    
    if (attempt > 1) {
      const delay = Math.pow(2, attempt) * 1000;
      document.getElementById('progressStatus').textContent = `RETRYING (${attempt}/${MAX_RETRIES})...`;
      document.getElementById('progressSpeed').textContent = `Wait ${delay / 1000}s...`;
      const speedLabel = document.getElementById('progressSpeedLabel');
      if (speedLabel) speedLabel.textContent = 'SPEED';
      await new Promise(r => setTimeout(r, delay));
      if (cancelled) { dropZone.classList.remove('uploading'); dropZone.innerHTML = originalHTML; dropZone.style.height = ''; return; }
      document.getElementById('progressStatus').textContent = 'UPLOADING...';
      document.getElementById('progressFill').style.width = '0%';
      document.getElementById('progressPercent').textContent = '0%';
      document.getElementById('progressSpeed').textContent = '--';
      document.getElementById('progressEta').textContent = '';
    }
    
    const formData = buildFormData(uploadFileId);
    
    const baseTimeout = 600000; // 10 minutes base
    const transferTimeout = Math.ceil(totalUploadSize / (1024 * 1024)) * 1000;
    const processingTimeout = Math.ceil(totalUploadSize / (1024 * 1024)) * 500;
    
    let startTime = performance.now();
    let uploadFinished = false;
    let progressPollInterval = null;
    let lastDisplayedPercent = 0;
    // A retry re-opens the cancel window: nothing of this attempt is sent yet.
    bodyFullySent = false;
    const _retryCancelBtn = document.getElementById('progressCancel');
    if (_retryCancelBtn) {
      _retryCancelBtn.style.opacity = '';
      _retryCancelBtn.title = 'CANCEL UPLOAD';
    }
    
    function startProgressPolling() {
      progressPollInterval = setInterval(async () => {
        try {
          const resp = await fetch(`/upload/progress/${uploadFileId}`);
          if (!resp.ok) return;
          const data = await resp.json();
          
          const statusEl = document.getElementById('progressStatus');
          const speedEl = document.getElementById('progressSpeed');
          const speedLabel = document.getElementById('progressSpeedLabel');
          const percentEl = document.getElementById('progressPercent');
          const fillEl = document.getElementById('progressFill');
          const etaEl = document.getElementById('progressEta');
          const etaLabel = document.getElementById('progressEtaLabel');
          if (!statusEl) return;
          
          if (data.phase === 'encrypting') {
            statusEl.textContent = 'ENCRYPTING...';
            if (data.percent >= lastDisplayedPercent) {
              lastDisplayedPercent = data.percent;
              percentEl.textContent = data.percent + '%';
              fillEl.style.width = data.percent + '%';
            }
            if (speedLabel) speedLabel.textContent = 'SPEED';
            speedEl.textContent = data.speed ? data.speed + ' MB/s' : '--';
            if (etaEl) etaEl.textContent = '';
          } else if (data.phase === 'zipping') {
            statusEl.textContent = 'ZIPPING...';
            if (data.percent >= lastDisplayedPercent) {
              lastDisplayedPercent = data.percent;
              percentEl.textContent = data.percent + '%';
              fillEl.style.width = data.percent + '%';
            }
            if (speedLabel) speedLabel.textContent = 'SPEED';
            speedEl.textContent = '--';
            if (etaEl) etaEl.textContent = '';
          } else if (data.phase === 'finalizing') {
            statusEl.textContent = 'SAVING...';
            percentEl.textContent = '100%';
            fillEl.style.width = '100%';
            if (speedLabel) speedLabel.textContent = 'SPEED';
            speedEl.textContent = '--';
            if (etaEl) etaEl.textContent = '';
          } else if (data.phase === 'saving') {
            statusEl.textContent = 'PROCESSING...';
            if (speedLabel) speedLabel.textContent = 'SPEED';
            speedEl.textContent = '--';
            if (etaEl) etaEl.textContent = '';
          }
        } catch (e) {
          // Polling errors are non-critical
        }
      }, 1000);
    }
    
    function stopProgressPolling() {
      if (progressPollInterval) {
        clearInterval(progressPollInterval);
        progressPollInterval = null;
        const speedLabel = document.getElementById('progressSpeedLabel');
        if (speedLabel) speedLabel.textContent = 'SPEED';
      }
    }
    
    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeXhr = xhr;
        xhr.open('POST', '/upload');
        // Header copy of upload_id: lets the server return an already-committed
        // upload on retry before the body is checked against remaining quota.
        xhr.setRequestHeader('X-Upload-Id', uploadFileId);
        xhr.timeout = Math.max(baseTimeout, transferTimeout + processingTimeout);
        
        xhr.upload.addEventListener('progress', function(e) {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            if (percent >= lastDisplayedPercent) {
              lastDisplayedPercent = percent;
              document.getElementById('progressFill').style.width = percent + '%';
              document.getElementById('progressPercent').textContent = percent + '%';
            }
            
            const elapsed = (performance.now() - startTime) / 1000;
            if (elapsed > 0) {
              const speed = (e.loaded / (elapsed * 1024 * 1024)).toFixed(1);
              const remaining = e.total - e.loaded;
              const secondsRemaining = (remaining / (e.loaded / elapsed)).toFixed(0);
              const timeStr = secondsRemaining < 60 ? `${secondsRemaining}s` : `${Math.ceil(secondsRemaining / 60)}m`;
              document.getElementById('progressSpeed').textContent = speed + ' MB/s';
              const etaEl = document.getElementById('progressEta');
              if (etaEl) etaEl.textContent = timeStr + ' REMAINING';
            }
            
            if (e.loaded === e.total && !uploadFinished) {
              uploadFinished = true;
              // Body is committed to the wire — close the cancel window.
              bodyFullySent = true;
              const cancelNowBtn = document.getElementById('progressCancel');
              if (cancelNowBtn) {
                cancelNowBtn.style.opacity = '.45';
                cancelNowBtn.title = 'UPLOAD ALREADY SENT — CANNOT BE CANCELLED WHILE THE SERVER SAVES IT';
              }
              lastDisplayedPercent = 0;
              document.getElementById('progressStatus').textContent = 'PROCESSING...';
              document.getElementById('progressSpeed').textContent = '--';
              const etaEl = document.getElementById('progressEta');
              if (etaEl) etaEl.textContent = '';
              startProgressPolling();
            }
          }
        });
        
        // Settle exactly once. A throw inside an xhr event handler happens
        // OUTSIDE the executor's synchronous scope, so without this the promise
        // could hang forever and the retry loop would never advance.
        let settled = false;
        function _settle(fn, arg) {
          if (settled) return;
          settled = true;
          stopProgressPolling();
          activeXhr = null;
          fn(arg);
        }
        
        xhr.onload = function() {
          if (xhr.status === 200) {
            let parsed;
            try {
              parsed = JSON.parse(xhr.responseText);
            } catch (parseErr) {
              // 200 with a non-JSON body (proxy interstitial, truncated
              // response). The upload very likely committed server-side, so
              // retry: /upload is idempotent on upload_id and a retry returns
              // the existing record — which is the only way to recover file_id
              // and persist the E2E passphrase.
              const err = new Error('Server returned an unreadable response; retrying to recover the upload');
              err.retryable = true;
              _settle(reject, err);
              return;
            }
            _settle(resolve, { success: true, response: parsed });
          } else {
            let errorMessage = 'Upload failed';
            let statusCode = xhr.status;
            try {
              const data = JSON.parse(xhr.responseText);
              errorMessage = data.error || errorMessage;
            } catch {}
            const err = new Error(errorMessage);
            err.statusCode = statusCode;
            _settle(reject, err);
          }
        };
        
        xhr.onerror = function() {
          const err = new Error('Network error during upload');
          err.retryable = true;
          _settle(reject, err);
        };
        
        xhr.ontimeout = function() {
          const timeoutMinutes = Math.round(xhr.timeout / 60000);
          const err = new Error(`Upload timed out after ${timeoutMinutes} minutes`);
          err.retryable = true;
          _settle(reject, err);
        };
        
        xhr.onabort = function() {
          const err = new Error('Upload cancelled');
          err.cancelled = true;
          _settle(reject, err);
        };
        
        // Safety net: loadend always fires after load/error/timeout/abort, so
        // the promise settles even if one of those handlers threw first.
        xhr.addEventListener('loadend', function() {
          if (settled) return;
          const err = new Error('Upload ended without a usable server response');
          err.retryable = true;
          _settle(reject, err);
        });
        
        xhr.send(formData);
      });
      
      // Success — handle response and exit
      if (typeof _pendingUploadRefresh !== 'undefined') _pendingUploadRefresh = true;
      document.getElementById('progressStatus').textContent = 'COMPLETE!';
      document.getElementById('progressFill').style.width = '100%';
      document.getElementById('progressPercent').textContent = '100%';
      const speedDone = document.getElementById('progressSpeed');
      if (speedDone) speedDone.textContent = 'DONE';
      const etaDone = document.getElementById('progressEta');
      if (etaDone) etaDone.textContent = '';
      // Hide cancel button on success
      const cancelBtn = document.getElementById('progressCancel');
      if (cancelBtn) cancelBtn.style.display = 'none';
      // Keep the client-side thumbnail in memory only — it is a plaintext
      // render of a file we just end-to-end encrypted (see _getMemThumbStore)
      if (pendingThumbnailDataUrl && result.response.file_id) {
        _getMemThumbStore().set(result.response.file_id, pendingThumbnailDataUrl);
      }
      if (result.response.management_token) {
        // E2EE guest upload: persist passphrase to the per-file keychain only
        if (e2eGuestPassphrase) {
          const downloadUrl = result.response.download_url || '';
          const fullShareUrl = downloadUrl ? (downloadUrl.startsWith('http') ? downloadUrl : window.location.origin + downloadUrl) + '#passphrase=' + btoa(unescape(encodeURIComponent(e2eGuestPassphrase))) : '';
          // Persist for the current browser session and VERIFY it landed —
          // the keychain write is silently a no-op without the onegy_manager
          // cookie, and this passphrase is the only way to decrypt the upload.
          const persisted = await _storePassphraseVerified(result.response.file_id, e2eGuestPassphrase);

          let copied = false;
          if (fullShareUrl && typeof showConfirm === 'function') {
            const lockIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
            const shouldCopy = await showConfirm(
              'COPY SHARE LINK?',
              'THIS LINK CONTAINS THE DECRYPTION SECRET. COPYING IT MAY EXPOSE THE SECRET IN CLIPBOARD HISTORY.',
              'COPY LINK',
              lockIcon,
              'confirm-warn'
            );
            if (shouldCopy) {
              try {
                await navigator.clipboard.writeText(fullShareUrl);
                copied = true;
                showToast('SHARE LINK COPIED TO CLIPBOARD', 'success');
              } catch (e) {
                showToast('COPY FAILED - SAVE THE LINK SHOWN BELOW', 'error');
              }
            }
          }

          if (!persisted && fullShareUrl) {
            // The manage panel rebuilds the link from this same keychain, so it
            // will NOT have the passphrase. Never promise a link that will not
            // exist — block here until the user has actually saved it, and keep
            // the passphrase in memory in the meantime.
            console.error(`[UPLOAD] Passphrase could not be persisted for ${result.response.file_id} — forcing manual save`);
            await _showUnsavedShareLinkPanel(fullShareUrl, copied);
            e2eGuestPassphrase = null;
            dropZone.classList.remove('uploading');
            dropZone.innerHTML = originalHTML;
            dropZone.style.height = '';
            showToast('UPLOAD COMPLETE — THE LINK YOU SAVED IS THE ONLY WAY TO DECRYPT IT', 'success');
            return;
          }

          if (!persisted) {
            // No share link could even be built — say so plainly.
            showToast('UPLOADED, BUT THE DECRYPTION SECRET COULD NOT BE SAVED — THIS FILE MAY NOT BE RECOVERABLE', 'error');
          } else if (!copied) {
            showToast('SHARE LINK READY IN THE MANAGE PANEL', 'success');
          }
          e2eGuestPassphrase = null;
        }
        // The landing page has no manage-modal markup. Once its upload secret
        // is safely persisted, continue on the dedicated quick-share page.
        if (window.location.pathname !== '/share') {
          window.location.assign('/share');
          return;
        }
        // Reset drop zone then open manage overlay
        dropZone.classList.remove('uploading');
        dropZone.innerHTML = originalHTML;
        dropZone.style.height = '';
        if (typeof ManageModal !== 'undefined') {
          ManageModal.openFileByToken(result.response.management_token);
        } else if (result.response.redirect) {
          window.location.href = result.response.redirect;
        }
      } else {
        dropZone.classList.remove('uploading');
        dropZone.innerHTML = originalHTML;
        dropZone.style.height = '';
      }
      return;
      
    } catch (err) {
      if (err.cancelled || cancelled) {
        dropZone.classList.remove('uploading');
        dropZone.innerHTML = originalHTML;
        dropZone.style.height = '';
        return;
      }
      
      // Don't retry client errors (4xx)
      const isRetryable = err.retryable || (err.statusCode && err.statusCode >= 500);
      if (!isRetryable || attempt === MAX_RETRIES) {
        // Final failure
        const fileSizeGB = (totalUploadSize / (1024 * 1024 * 1024)).toFixed(1);
        let errorMsg = err.message;
        if (err.retryable && totalUploadSize > 1024 * 1024 * 1024) {
          errorMsg += `\n\nLarge file (${fileSizeGB}GB): Try uploading from the Files dashboard, or try a wired connection.`;
        }
        showToast(errorMsg, 'error');
        dropZone.classList.remove('uploading');
        dropZone.innerHTML = originalHTML;
        dropZone.style.height = '';
        return;
      }
      
      console.log(`[UPLOAD RETRY] Attempt ${attempt} failed: ${err.message}. Retrying...`);
    }
  }
}

// encryptFiles() — removed, now handled inline via OneGyCrypto module
// See uploadFiles() E2E section above which uses:
//   OneGyCrypto.encryptFileForUpload() for registered users (master key wrapping)
//   OneGyCrypto.encryptFileForGuestUpload() for guests (passphrase wrapping)

async function createZip(files) {
  const zipParts = [];
  const ZIP32_MAX = 0xFFFFFFFF; // 4,294,967,295 bytes (~4.29 GB)
  // ZIP32 stores the entry count in 16 bits; more would silently wrap.
  if (files.length > 0xFFFF) throw new Error('TOO MANY FILES FOR ONE ARCHIVE (MAX 65535)');
  
  // Local file header template
  function writeLocalFileHeader(filename, compressedSize, uncompressedSize, crc32) {
    const filenameBytes = new TextEncoder().encode(filename);
    const header = new DataView(new ArrayBuffer(30 + filenameBytes.length));
    header.setUint32(0, 0x04034b50, true); // Local file header signature
    header.setUint16(4, 20, true); // Version needed to extract
    header.setUint16(6, 0x0800, true); // General purpose bit flag (bit 11 = UTF-8 filenames)
    header.setUint16(8, 0, true); // Compression method (0 = store)
    header.setUint16(10, 0, true); // Last mod time
    header.setUint16(12, 0, true); // Last mod date
    header.setUint32(14, crc32, true); // CRC-32
    header.setUint32(18, compressedSize, true); // Compressed size
    header.setUint32(22, uncompressedSize, true); // Uncompressed size
    header.setUint16(26, filenameBytes.length, true); // Filename length (UTF-8 byte length)
    header.setUint16(28, 0, true); // Extra field length
    
    for (let i = 0; i < filenameBytes.length; i++) {
      header.setUint8(30 + i, filenameBytes[i]);
    }
    
    return header.buffer;
  }

  // Central directory header template
  function writeCentralDirectoryHeader(filename, compressedSize, uncompressedSize, crc32, localHeaderOffset) {
    const filenameBytes = new TextEncoder().encode(filename);
    const header = new DataView(new ArrayBuffer(46 + filenameBytes.length));
    header.setUint32(0, 0x02014b50, true); // Central directory file header signature
    header.setUint16(4, 20, true); // Version made by
    header.setUint16(6, 20, true); // Version needed to extract
    header.setUint16(8, 0x0800, true); // General purpose bit flag (bit 11 = UTF-8 filenames)
    header.setUint16(10, 0, true); // Compression method (0 = store)
    header.setUint16(12, 0, true); // Last mod time
    header.setUint16(14, 0, true); // Last mod date
    header.setUint32(16, crc32, true); // CRC-32
    header.setUint32(20, compressedSize, true); // Compressed size
    header.setUint32(24, uncompressedSize, true); // Uncompressed size
    header.setUint16(28, filenameBytes.length, true); // Filename length (UTF-8 byte length)
    header.setUint16(30, 0, true); // Extra field length
    header.setUint16(32, 0, true); // File comment length
    header.setUint16(34, 0, true); // Disk number start
    header.setUint16(36, 0, true); // Internal file attributes
    header.setUint32(38, 0, true); // External file attributes
    header.setUint32(42, localHeaderOffset, true); // Relative offset of local header
    
    for (let i = 0; i < filenameBytes.length; i++) {
      header.setUint8(46 + i, filenameBytes[i]);
    }
    
    return header.buffer;
  }

  // End of central directory record
  function writeEndOfCentralDirectory(centralDirOffset, centralDirSize, totalEntries) {
    const record = new DataView(new ArrayBuffer(22));
    record.setUint32(0, 0x06054b50, true); // End of central dir signature
    record.setUint16(4, 0, true); // Number of this disk
    record.setUint16(6, 0, true); // Disk with start of central directory
    record.setUint16(8, totalEntries, true); // Entries on this disk
    record.setUint16(10, totalEntries, true); // Total entries
    record.setUint32(12, centralDirSize, true); // Size of central directory
    record.setUint32(16, centralDirOffset, true); // Offset of central directory
    record.setUint16(20, 0, true); // Comment length
    return record.buffer;
  }

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const centralDirEntries = [];
  let currentOffset = 0;

  // Two dropped files can share a name; identical member paths make extraction
  // keep only one. Case-insensitive, like the server's ZIP naming.
  const usedNames = new Set();
  function uniqueName(name) {
    if (!usedNames.has(name.toLowerCase())) { usedNames.add(name.toLowerCase()); return name; }
    const slash = name.lastIndexOf('/');
    const dir = name.slice(0, slash + 1), base = name.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : '';
    for (let n = 1; ; n++) {
      const candidate = `${dir}${stem} (${n})${ext}`;
      if (!usedNames.has(candidate.toLowerCase())) { usedNames.add(candidate.toLowerCase()); return candidate; }
    }
  }

  for (const file of files) {
    // Use fullPath if available (from folder uploads), otherwise use file.name
    const filename = uniqueName(file.fullPath || file.name);
    if (file.size > ZIP32_MAX) {
      throw new Error(
        `File "${file.name}" (${(file.size / (1024 * 1024 * 1024)).toFixed(1)}GB) exceeds the 4GB ZIP format limit. ` +
        `Please upload it individually instead of in a batch.`
      );
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const compressedSize = data.length;
    const uncompressedSize = data.length;
    const crc = crc32(data);

    // Local file header
    const localHeader = writeLocalFileHeader(filename, compressedSize, uncompressedSize, crc);
    zipParts.push(localHeader);
    currentOffset += localHeader.byteLength;
    if (currentOffset > ZIP32_MAX) {
      throw new Error('BATCH ZIP EXCEEDS THE 4GB ZIP FORMAT LIMIT. PLEASE UPLOAD FEWER FILES AT ONCE.')
    }

    // File data (stored, not compressed)
    zipParts.push(data);
    currentOffset += compressedSize;
    if (currentOffset > ZIP32_MAX) {
      throw new Error('BATCH ZIP EXCEEDS THE 4GB ZIP FORMAT LIMIT. PLEASE UPLOAD FEWER FILES AT ONCE.')
    }

    // Central directory entry
    const centralDirEntry = writeCentralDirectoryHeader(
      filename,
      compressedSize,
      uncompressedSize,
      crc,
      currentOffset - compressedSize - localHeader.byteLength
    );
    centralDirEntries.push(centralDirEntry);
  }

  const centralDirOffset = currentOffset;
  let centralDirSize = 0;

  for (const entry of centralDirEntries) {
    zipParts.push(entry);
    centralDirSize += entry.byteLength;
    currentOffset += entry.byteLength;
  }
  if (centralDirOffset > ZIP32_MAX || centralDirSize > ZIP32_MAX || currentOffset > ZIP32_MAX) {
    throw new Error('BATCH ZIP EXCEEDS THE 4GB ZIP FORMAT LIMIT. PLEASE UPLOAD FEWER FILES AT ONCE.')
  }

  // End of central directory
  const endOfCentralDir = writeEndOfCentralDirectory(
    centralDirOffset,
    centralDirSize,
    centralDirEntries.length
  );
  zipParts.push(endOfCentralDir);

  return new Blob(zipParts, { type: 'application/zip' });
}

// deriveKey() — removed, now handled by OneGyCrypto.deriveWrappingKey()

function autoDismissFlash() {
  const flashMessage = document.querySelector('.flash-message');
  if (flashMessage) {
    setTimeout(() => {
      flashMessage.style.opacity = '0';
      flashMessage.style.transition = 'opacity 0.5s ease';
      setTimeout(() => {
        flashMessage.remove();
      }, 500);
    }, 3500);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoDismissFlash);
} else {
  autoDismissFlash();
}
