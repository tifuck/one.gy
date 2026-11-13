//go:build windows

package watch

import (
	"errors"
	"path/filepath"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

const notifyFilter = windows.FILE_NOTIFY_CHANGE_FILE_NAME | windows.FILE_NOTIFY_CHANGE_DIR_NAME |
	windows.FILE_NOTIFY_CHANGE_SIZE | windows.FILE_NOTIFY_CHANGE_LAST_WRITE |
	windows.FILE_NOTIFY_CHANGE_ATTRIBUTES | windows.FILE_NOTIFY_CHANGE_CREATION

// startNative runs ReadDirectoryChangesW on the root with bWatchSubtree=TRUE.
func (w *Watcher) startNative() error {
	p, err := windows.UTF16PtrFromString(w.root)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(p, windows.FILE_LIST_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return err
	}
	var closed atomic.Bool
	w.stopNative = func() {
		closed.Store(true)
		windows.CancelIoEx(h, nil)
		windows.CloseHandle(h)
	}
	go func() {
		buf := make([]uint32, 16<<10) // 64 KiB, DWORD-aligned
		for !closed.Load() {
			var n uint32
			err := windows.ReadDirectoryChanges(h, (*byte)(unsafe.Pointer(&buf[0])), uint32(len(buf)*4), true, notifyFilter, &n, nil, 0)
			switch {
			case closed.Load():
				return
			case errors.Is(err, windows.ERROR_NOTIFY_ENUM_DIR), err == nil && n == 0:
				w.overflow() // the kernel buffer overflowed
				continue
			case err != nil:
				w.overflow() // root gone or unreadable: let the scanner find out
				return
			}
			w.parse(unsafe.Slice((*byte)(unsafe.Pointer(&buf[0])), n))
		}
	}()
	return nil
}

func (w *Watcher) parse(b []byte) {
	for off := 0; off+12 <= len(b); {
		info := (*windows.FileNotifyInformation)(unsafe.Pointer(&b[off]))
		n := int(info.FileNameLength / 2)
		if off+12+n*2 > len(b) {
			return
		}
		name := windows.UTF16ToString(unsafe.Slice(&info.FileName, n))
		w.emit(filepath.Join(w.root, name))
		if info.NextEntryOffset == 0 {
			return
		}
		off += int(info.NextEntryOffset)
	}
}

// addFailed is Linux-only (inotify watch limits).
func (w *Watcher) addFailed(error) bool { return false }
