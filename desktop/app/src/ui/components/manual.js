// Manual (non-sync) uploads and downloads, started from the tray or the
// Transfers screen. Settings > Folders can preset the one.gy folder for tray
// uploads and the local folder for downloads.
import { pickRemote } from './tree-picker.js';
import { toast, toastError } from './toast.js';
import { rpc, bridge, store } from '../store.js';

// useDefault: take Settings > Folders' upload folder when one is set (tray).
export async function manualUpload(paths, { useDefault = false } = {}) {
  try {
    const files = paths && paths.length ? paths : await bridge('pickFiles');
    if (!files || !files.length) return;
    const preset = useDefault && store.app && store.app.default_upload_folder;
    const target = preset || await pickRemote({ title: `Upload ${files.length === 1 ? '1 file' : `${files.length} files`} to…`, confirmLabel: 'Upload here' });
    if (!target) return;
    const res = await rpc('manual.upload', { paths: files, remote_folder_id: target.id });
    const n = res.transfer_ids.length;
    toast(`${n} upload${n === 1 ? '' : 's'} queued${preset ? ` to one.gy${target.path === '/' ? '' : target.path}` : ''}`, 'success');
  } catch (err) {
    toastError(err);
  }
}

export async function manualDownload() {
  try {
    const picked = await pickRemote({ title: 'Download from one.gy', mode: 'items', confirmLabel: 'Next' });
    if (!picked) return;
    const files = picked.items.filter((it) => it.type === 'file');
    if (!files.length) throw new Error('Folders cannot be downloaded here yet. Tick the files inside them instead.');
    const dir = (store.app && store.app.default_download_dir) || await bridge('pickFolder', { title: 'Save downloads to' });
    if (!dir) return;
    const res = await rpc('manual.download', { remote_ids: files.map((it) => it.id), local_dir: dir });
    const skipped = picked.items.length - files.length;
    const n = res.transfer_ids.length;
    toast(`${n} download${n === 1 ? '' : 's'} queued${skipped ? `; ${skipped} folder${skipped === 1 ? '' : 's'} skipped` : ''}`, 'success');
  } catch (err) {
    toastError(err);
  }
}
