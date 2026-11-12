package syncer

import (
	"strings"
	"testing"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/exec"
	"github.com/tifuck/one.gy/desktop/engine/internal/reconcile"
)

// What is left counts down while a plan runs (not only when the next plan is
// made), the total stays, and a sync that only waits says what for.
func TestStatsCountDownAndWaiting(t *testing.T) {
	r := NewRunner(&Env{Exec: &exec.Env{Pool: exec.NewPool()}}, "s1")
	r.QuietPeriod = func(int64) time.Duration { return 0 }
	ops := []reconcile.Op{
		{Kind: reconcile.Upload, Path: "a", Size: 100},
		{Kind: reconcile.Upload, Path: "b", Size: 300},
		{Kind: reconcile.Download, Path: "c", Size: 600},
		{Kind: reconcile.CreateRemoteDir, Path: "d"},
	}
	r.setStats(ops)
	if st := r.Stats(); st != (Stats{PendingUp: 2, PendingDown: 1, BytesLeft: 1000, TotalItems: 3, TotalBytes: 1000}) {
		t.Fatalf("planned: %+v", st)
	}
	r.transferred(ops[1])
	r.transferred(ops[3]) // not a transfer
	if st := r.Stats(); st != (Stats{PendingUp: 1, PendingDown: 1, BytesLeft: 700, TotalItems: 3, TotalBytes: 1000}) {
		t.Fatalf("after one upload: %+v", st)
	}
	// The next plan: one left, and the total still covers what is done.
	r.setStats(ops[:1])
	if st := r.Stats(); st != (Stats{PendingUp: 1, BytesLeft: 100, TotalItems: 2, TotalBytes: 400}) {
		t.Fatalf("replanned: %+v", st)
	}

	r.failed("server: boom (500 http_500)")
	r.backoff(ops[0], true)
	run, waiting := r.runnable(ops[:1])
	if len(run) != 0 || !strings.Contains(waiting, "1 of the changes failed") || !strings.Contains(waiting, "boom") {
		t.Fatalf("waiting = %q, run = %v", waiting, run)
	}

	r.setStats(nil)
	if st := r.Stats(); st != (Stats{}) {
		t.Fatalf("idle: %+v", st)
	}
}
