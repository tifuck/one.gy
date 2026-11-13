//go:build !windows

package watch

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/fsnotify/fsnotify"
)

// startNative watches every directory with inotify (fsnotify), adding new
// directories as they appear.
func (w *Watcher) startNative() error {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w.stopNative = func() { fw.Close() }
	limited := false
	add := func(dir string) {
		filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || !d.IsDir() {
				return nil
			}
			if p == filepath.Join(w.root, ".onegy") {
				return filepath.SkipDir
			}
			if err := fw.Add(p); err != nil {
				if w.addFailed(err) {
					limited = true
				}
				if limited {
					return filepath.SkipAll
				}
			}
			return nil
		})
	}
	add(w.root)
	go func() {
		for {
			select {
			case ev, ok := <-fw.Events:
				if !ok {
					return
				}
				w.emit(ev.Name)
				if ev.Has(fsnotify.Rename) || ev.Has(fsnotify.Remove) {
					// Watches of a moved directory keep its old path: drop them;
					// the Create at the new name adds fresh ones.
					for _, p := range fw.WatchList() {
						if p == ev.Name || strings.HasPrefix(p, ev.Name+string(filepath.Separator)) {
							fw.Remove(p)
						}
					}
				}
				if ev.Has(fsnotify.Create) && !limited {
					if fi, err := os.Lstat(ev.Name); err == nil && fi.IsDir() {
						add(ev.Name)
						w.emit(ev.Name) // entries created before the watch existed
					}
				}
			case _, ok := <-fw.Errors:
				if !ok {
					return
				}
				w.overflow() // queue overflow or a read error: events may be lost
			}
		}
	}()
	return nil
}

// addFailed handles a failed watch add. Running out of inotify watches
// (ENOSPC) reports WatchLimit plus a Rescan; other failures (a directory
// that vanished or is unreadable) are left to the scanner.
func (w *Watcher) addFailed(err error) bool {
	if errors.Is(err, syscall.ENOSPC) {
		w.send(raw{limit: true, rescan: true})
		return true
	}
	return false
}
