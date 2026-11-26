package syncer

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tifuck/one.gy/client/internal/exec"
	"github.com/tifuck/one.gy/client/internal/logx"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/state"
)

func resilienceDB(t *testing.T) (*state.DB, *state.SyncRow) {
	t.Helper()
	db, err := state.Open(filepath.Join(t.TempDir(), "e.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	row := &state.SyncRow{ID: "s1", Name: "S", LocalRoot: t.TempDir(), Type: "two_way", Encryption: "e2ee", Config: "{}", State: "scanning", CreatedAt: "t"}
	if err := db.PutSync(context.Background(), row); err != nil {
		t.Fatal(err)
	}
	return db, row
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(10 * time.Second); !ok(); {
		if time.Now().After(end) {
			t.Fatal("timed out waiting for " + what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// runUntilCancel runs the runner and checks it keeps running until ctx ends.
func runUntilCancel(t *testing.T, r *Runner) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		r.Run(ctx)
		close(done)
	}()
	return func() {
		select {
		case <-done:
			t.Fatal("the runner stopped on its own")
		default:
		}
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("the runner did not stop")
		}
	}
}

// A sync row that cannot be read (SQLite busy, I/O error) does not end the
// runner silently: it shows the error and tries again.
func TestRunnerSurvivesUnreadableSync(t *testing.T) {
	db, _ := resilienceDB(t)
	r := NewRunner(&Env{Exec: &exec.Env{DB: db}, Settings: func() Settings { return Settings{} }}, "s1")
	db.Close()
	stop := runUntilCancel(t, r)
	waitFor(t, "the error state", func() bool { return r.State() == "error" })
	if d, waiting, at := r.Detail(); !waiting || at.IsZero() || !strings.Contains(d, "Cannot read") {
		t.Fatalf("detail %q waiting %v at %v", d, waiting, at)
	}
	stop()
}

// A pass that panics ends only that pass: the sync goes to error with an
// issue and the runner backs off instead of the engine crashing.
func TestRunnerSurvivesPanickingPass(t *testing.T) {
	db, _ := resilienceDB(t)
	// No account: the pass dereferences it and panics.
	r := NewRunner(&Env{Exec: &exec.Env{DB: db}, Settings: func() Settings { return Settings{} }}, "s1")
	stop := runUntilCancel(t, r)
	waitFor(t, "the sync_error issue", func() bool {
		open, _ := db.OpenIssues(context.Background(), "s1")
		return len(open) == 1 && open[0].Kind == "sync_error"
	})
	if r.State() != "error" {
		t.Fatalf("state %q", r.State())
	}
	if _, _, at := r.Detail(); time.Until(at) < 10*time.Second {
		t.Fatalf("no backoff: retry at %v", at)
	}
	stop()
	if err := r.safePass(context.Background()); !errors.Is(err, logx.ErrPanic) {
		t.Fatalf("safePass: %v", err)
	}
}

// Debris whose delete fails keeps its record, so the next pass tries again.
func TestDebrisRetriedAfterFailedDelete(t *testing.T) {
	ctx := context.Background()
	db, row := resilienceDB(t)
	r := NewRunner(&Env{Exec: &exec.Env{DB: db}}, "s1")
	day := filepath.Join(row.LocalRoot, ".onegy", "debris", "2020-01-01")
	os.MkdirAll(day, 0o700)
	blocker := filepath.Join(day, "blocker")
	os.WriteFile(blocker, []byte("x"), 0o600) // a file where the debris path expects a folder: RemoveAll fails
	db.Tx(ctx, func(tx *sql.Tx) error {
		return state.AddDebris(tx, "s1", "a/b", ".onegy/debris/2020-01-01/blocker/b", "deleted")
	})
	cfg := Config{DebrisDays: -1}
	r.cleanDebris(ctx, row, cfg)
	if left, _ := db.OldDebris(ctx, "s1", time.Now().Add(time.Hour)); len(left) != 1 {
		t.Fatalf("record of undeleted debris dropped: %v", left)
	}
	os.Remove(blocker)
	r.cleanDebris(ctx, row, cfg)
	if left, _ := db.OldDebris(ctx, "s1", time.Now().Add(time.Hour)); len(left) != 0 {
		t.Fatalf("record kept after the delete: %v", left)
	}
}

// keep_remote skips the E2EE downgrade guard only when it answers the
// downgrade issue, not for an ordinary conflict.
func TestKeepRemoteDowngradeOnlyForDowngradeIssue(t *testing.T) {
	ctx := context.Background()
	db, _ := resilienceDB(t)
	r := NewRunner(&Env{Exec: &exec.Env{DB: db}}, "s1")
	r.syncIssues(ctx, []reconcile.Issue{
		{Kind: "integrity", Path: "enc.txt", Message: reconcile.DowngradeMessage, Actions: []string{"keep_remote", "ignore"}},
		{Kind: "conflict", Path: "doc.txt", Message: "m", Actions: []string{"keep_both", "keep_remote", "keep_local", "ignore"}},
	})
	open, _ := db.OpenIssues(ctx, "s1")
	for _, o := range open {
		if err := r.Resolve(ctx, o, "keep_remote", ""); err != nil {
			t.Fatal(err)
		}
	}
	got := map[string]bool{}
	for _, a := range r.actions {
		got[a.path] = a.downgrade
	}
	if len(got) != 2 || !got["enc.txt"] || got["doc.txt"] {
		t.Fatalf("downgrade per path %v", got)
	}
}
