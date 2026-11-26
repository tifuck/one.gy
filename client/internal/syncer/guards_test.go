package syncer

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tifuck/one.gy/client/internal/exec"
	"github.com/tifuck/one.gy/client/internal/fakeserver"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/state"
)

// A file with an mtime in the future (clock skew, exFAT time zone) rests for
// the quiet period from when it was first seen, not until its mtime.
func TestQuietPeriodFutureMtime(t *testing.T) {
	r := NewRunner(&Env{Exec: &exec.Env{Pool: exec.NewPool()}}, "s1")
	r.QuietPeriod = func(int64) time.Duration { return 2 * time.Second }
	ops := []reconcile.Op{{Kind: reconcile.Upload, Path: "a", Size: 1, Local: &reconcile.Expect{MtimeNs: time.Now().Add(time.Hour).UnixNano(), Size: 1}}}
	if run, _ := r.runnable(ops); len(run) != 0 {
		t.Fatal("a file first seen now must rest")
	}
	if r.nextRun.After(time.Now().Add(time.Minute)) {
		t.Fatalf("waits until %v, not the quiet period", r.nextRun)
	}
	for k, v := range r.future {
		r.future[k] = v.Add(-3 * time.Second)
	}
	if run, _ := r.runnable(ops); len(run) != 1 {
		t.Fatal("unchanged for the quiet period: upload")
	}
	ops[0].Local.MtimeNs++ // changed again
	if run, _ := r.runnable(ops); len(run) != 0 {
		t.Fatal("a new version rests again")
	}
}

// Only the mass-delete answer a plan used is cleared after it.
func TestClearMassDecisionsKeepsNewAnswer(t *testing.T) {
	r := NewRunner(&Env{}, "s1")
	r.massLocal, r.massRemote = "apply", "restore"
	r.clearMassDecisions(reconcile.Config{MassDeleteRemote: "restore"})
	if r.massLocal != "apply" || r.massRemote != "" {
		t.Fatalf("local %q remote %q", r.massLocal, r.massRemote)
	}
}

// Both mass-delete questions (no path) are stored when both sides trip.
func TestMassDeleteIssuesPerSide(t *testing.T) {
	ctx := context.Background()
	db, err := state.Open(filepath.Join(t.TempDir(), "e.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.PutSync(ctx, &state.SyncRow{ID: "s1", Name: "S", LocalRoot: t.TempDir(), Type: "two_way", Encryption: "e2ee", Config: "{}", State: "scanning", CreatedAt: "t"})
	r := NewRunner(&Env{Exec: &exec.Env{DB: db}}, "s1")
	mass := func(side string, n int) reconcile.Issue {
		return reconcile.Issue{Kind: "mass_delete", Message: "m", Actions: []string{"keep_local", "keep_remote", "open"},
			Detail: map[string]any{"side": side, "count": n}}
	}
	r.syncIssues(ctx, []reconcile.Issue{mass("local", 60), mass("remote", 70)})
	open, _ := db.OpenIssues(ctx, "s1")
	if len(open) != 2 {
		t.Fatalf("%d open issues", len(open))
	}
	r.syncIssues(ctx, []reconcile.Issue{mass("remote", 71)})
	open, _ = db.OpenIssues(ctx, "s1")
	if len(open) != 1 || View(open[0]).Detail["side"] != "remote" || View(open[0]).Detail["count"] != float64(71) {
		t.Fatalf("open %+v", open)
	}
}

// A sync is bound to the account it was created under: signed in as another
// user (or to another server) it must not run, or a two-way sync would
// delete the folder's contents and an upload sync would copy them into the
// other account.
func TestAccountMismatchStopsSync(t *testing.T) {
	srv := fakeserver.New(t, "u", "pw")
	rootID := srv.AddFolder(nil, "Root")
	d := newDevice(t, srv, "D1", rootID, nil)
	os.WriteFile(filepath.Join(d.root, "a.txt"), []byte("hello"), 0o644)
	if err := d.pass(); err != nil {
		t.Fatal(err)
	}
	if n := len(srv.Snapshot(&rootID)); n != 1 {
		t.Fatalf("first pass uploaded %d items", n)
	}
	srv.Delete("file", srv.Snapshot(&rootID)[0].ID) // the other account has no such file
	ctx := context.Background()
	for _, other := range []state.Account{
		{ServerURL: srv.URL, UserID: 2, Username: "v", SignedIn: true},
		{ServerURL: "https://other.example", UserID: 1, Username: "u", SignedIn: true},
	} {
		d.db.PutAccount(ctx, &other)
		if err := d.pass(); err != nil {
			t.Fatal(err)
		}
		if st := d.run.State(); st != "stalled" {
			t.Fatalf("%s/%d: state %q", other.ServerURL, other.UserID, st)
		}
		if b, err := os.ReadFile(filepath.Join(d.root, "a.txt")); err != nil || string(b) != "hello" {
			t.Fatalf("local file touched: %q %v", b, err)
		}
		is, _ := d.db.OpenIssues(ctx, d.syncID)
		if len(is) != 1 || is[0].Kind != "account_mismatch" {
			t.Fatalf("issues: %+v", is)
		}
	}
}
