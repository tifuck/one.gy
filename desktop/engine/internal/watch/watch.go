// Package watch owns local change hints (plan 7.2): a recursive watcher per
// sync root that emits debounced batches of changed paths, Rescan when the
// OS dropped events, and WatchLimit when Linux ran out of inotify watches.
// Hints only: the scanner is always the truth. Native backends are
// watch_inotify.go (fsnotify, Linux) and watch_windows.go
// (ReadDirectoryChangesW on the whole subtree); Options.Poll selects the
// poll-only mode for network shares and FAT.
package watch

import (
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Hints is one debounced batch. Paths are relative to the root,
// '/'-separated ("" = the root itself).
type Hints struct {
	Paths      []string
	Rescan     bool // events were lost (or poll tick): scan everything
	WatchLimit bool // Linux max_user_watches reached: raise watch_limit, scan periodically
}

// Options: Poll > 0 means no native events, just a Rescan every Poll.
// Debounce (default 500 ms) is how long events are collected per batch.
type Options struct {
	Poll     time.Duration
	Debounce time.Duration
}

// maxPaths caps a batch; beyond it the batch becomes a Rescan.
const maxPaths = 10000

type raw struct {
	rel           string
	rescan, limit bool
}

// Watcher delivers Hints on C until Close.
type Watcher struct {
	C <-chan Hints

	root       string
	opts       Options
	raw        chan raw
	done       chan struct{}
	once       sync.Once
	stopNative func()
}

// New starts watching root.
func New(root string, o Options) (*Watcher, error) {
	if o.Debounce <= 0 {
		o.Debounce = 500 * time.Millisecond
	}
	c := make(chan Hints)
	w := &Watcher{C: c, root: filepath.Clean(root), opts: o, raw: make(chan raw, 1024), done: make(chan struct{}), stopNative: func() {}}
	if o.Poll > 0 {
		go w.poll()
	} else if err := w.startNative(); err != nil {
		return nil, err
	}
	go w.loop(c)
	return w, nil
}

// Close stops the watcher and closes C.
func (w *Watcher) Close() error {
	w.once.Do(func() {
		close(w.done)
		w.stopNative()
	})
	return nil
}

func (w *Watcher) poll() {
	t := time.NewTicker(w.opts.Poll)
	defer t.Stop()
	for {
		select {
		case <-w.done:
			return
		case <-t.C:
			w.send(raw{rescan: true})
		}
	}
}

// send never blocks a backend: a full queue becomes a Rescan.
func (w *Watcher) send(r raw) {
	select {
	case w.raw <- r:
	default:
		select {
		case w.raw <- raw{rescan: true}:
		default: // queue already full; the Rescan below the flood will cover it
		}
	}
}

// emit reports an absolute path from a backend; .onegy is skipped.
func (w *Watcher) emit(abs string) {
	rel, err := filepath.Rel(w.root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return
	}
	w.emitRel(filepath.ToSlash(rel))
}

func (w *Watcher) emitRel(rel string) {
	if rel == "." {
		rel = ""
	}
	if rel == ".onegy" || strings.HasPrefix(rel, ".onegy/") {
		return
	}
	w.send(raw{rel: rel})
}

func (w *Watcher) overflow() { w.send(raw{rescan: true}) }

func (w *Watcher) loop(c chan<- Hints) {
	defer close(c)
	var (
		paths = map[string]bool{}
		pend  Hints
		have  bool
		timer <-chan time.Time
		out   chan<- Hints
		batch Hints
	)
	for {
		select {
		case <-w.done:
			return
		case r := <-w.raw:
			have = true
			pend.Rescan = pend.Rescan || r.rescan
			pend.WatchLimit = pend.WatchLimit || r.limit
			if !r.rescan && !r.limit {
				paths[r.rel] = true
			}
			if timer == nil && out == nil {
				timer = time.After(w.opts.Debounce)
			}
		case <-timer:
			timer = nil
			if pend.Rescan || len(paths) > maxPaths {
				pend.Rescan, paths = true, map[string]bool{}
			}
			for p := range paths {
				pend.Paths = append(pend.Paths, p)
			}
			batch, out = pend, c
			pend, have, paths = Hints{}, false, map[string]bool{}
		case out <- batch:
			out = nil
			if have {
				timer = time.After(w.opts.Debounce)
			}
		}
	}
}
