package watch

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// collect gathers hints until every wanted path was seen or the deadline.
func collect(t *testing.T, w *Watcher, want ...string) Hints {
	t.Helper()
	var all Hints
	seen := map[string]bool{}
	deadline := time.After(5 * time.Second)
	for {
		missing := 0
		for _, p := range want {
			if !seen[p] {
				missing++
			}
		}
		if missing == 0 {
			return all
		}
		select {
		case h := <-w.C:
			all.Rescan = all.Rescan || h.Rescan
			all.WatchLimit = all.WatchLimit || h.WatchLimit
			for _, p := range h.Paths {
				seen[p] = true
				all.Paths = append(all.Paths, p)
			}
		case <-deadline:
			t.Fatalf("missing hints for %v; got %+v", want, all)
		}
	}
}

func TestWatcherSmoke(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, ".onegy"), 0o700)
	w, err := New(root, Options{Debounce: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644)
	collect(t, w, "a.txt")
	os.Rename(filepath.Join(root, "a.txt"), filepath.Join(root, "b.txt"))
	collect(t, w, "a.txt", "b.txt")
	os.Mkdir(filepath.Join(root, "dir"), 0o755)
	collect(t, w, "dir")
	time.Sleep(100 * time.Millisecond) // the new watch is added from the Create event
	os.WriteFile(filepath.Join(root, "dir", "inner"), []byte("x"), 0o644)
	collect(t, w, "dir/inner")
	os.Rename(filepath.Join(root, "dir"), filepath.Join(root, "moved"))
	collect(t, w, "dir", "moved")
	time.Sleep(100 * time.Millisecond)
	os.WriteFile(filepath.Join(root, "moved", "after"), []byte("x"), 0o644)
	collect(t, w, "moved/after")
	os.Remove(filepath.Join(root, "b.txt"))
	h := collect(t, w, "b.txt")
	os.WriteFile(filepath.Join(root, ".onegy", "tmp"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(root, "z"), []byte("x"), 0o644)
	h = collect(t, w, "z")
	for _, p := range h.Paths {
		if p == ".onegy/tmp" || p == ".onegy" {
			t.Fatal(".onegy must not produce hints")
		}
	}
}

func TestOverflowAndWatchLimitBecomeRescan(t *testing.T) {
	// The flood below must land in one debounce window (slow under -race).
	w, err := New(t.TempDir(), Options{Debounce: 500 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	w.overflow()
	if h := <-w.C; !h.Rescan || h.WatchLimit {
		t.Fatalf("overflow %+v", h)
	}
	if !w.addFailed(fmt.Errorf("inotify_add_watch: %w", syscall.ENOSPC)) || w.addFailed(syscall.ENOENT) {
		t.Fatal("ENOSPC detection")
	}
	if h := <-w.C; !h.Rescan || !h.WatchLimit {
		t.Fatalf("limit %+v", h)
	}
	for i := 0; i < maxPaths+5; i++ {
		w.emitRel(fmt.Sprint("f", i))
	}
	got := Hints{}
	for !got.Rescan {
		got = <-w.C
	}
	if len(got.Paths) != 0 {
		t.Fatal("a flood must collapse into a Rescan")
	}
}

func TestPollMode(t *testing.T) {
	w, err := New(t.TempDir(), Options{Poll: 30 * time.Millisecond, Debounce: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if h := <-w.C; !h.Rescan {
		t.Fatal("poll tick")
	}
	w.Close()
	for range w.C {
	}
}
