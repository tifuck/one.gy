package remote

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/account"
	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/fakeserver"
	"github.com/tifuck/one.gy/desktop/engine/internal/keystore"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
	"github.com/zalando/go-keyring"
	"onegy/e2ee"
)

func setup(t *testing.T) (*Tree, *fakeserver.Server, *state.DB) {
	t.Helper()
	keyring.MockInit()
	dir := t.TempDir()
	db, err := state.Open(filepath.Join(dir, "engine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	srv := fakeserver.New(t, "bob", "pw")
	m := account.New(db, keystore.New(dir, false), api.Options{Version: "0.1.0", Transport: srv.Client().Transport})
	if err := m.Authorize(context.Background(), account.AuthorizeParams{Server: srv.URL, Username: "bob", Password: "pw", DeviceName: "T"}); err != nil {
		t.Fatal(err)
	}
	return New(db, m), srv, db
}

func names(l []map[string]any) []string {
	var out []string
	for _, v := range l {
		out = append(out, v["name"].(string))
	}
	return out
}

func TestSnapshotChangesAndList(t *testing.T) {
	ctx := context.Background()
	tree, srv, db := setup(t)
	work := srv.AddFolder(nil, "Work")
	srv.AddFolder(nil, "archive")
	sub := srv.AddFolder(&work, "Sub")
	plain := make([]byte, 1000)
	fid := srv.AddFile(&work, "report.pdf", plain)
	gone := srv.AddFile(&work, "old.txt", []byte("x"))

	root, err := tree.List(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(root.Folders); len(got) != 2 || got[0] != "archive" || got[1] != "Work" {
		t.Fatalf("root folders %v", got)
	}
	l, err := tree.List(ctx, &work)
	if err != nil || l.Folder["name"] != "Work" || len(l.Folders) != 1 || len(l.Files) != 2 {
		t.Fatalf("work listing %+v %v", l, err)
	}
	if l.Files[1]["name"] != "report.pdf" || l.Files[1]["size_plain"] != int64(1000) {
		t.Fatalf("file view %+v", l.Files[1])
	}
	if p, _ := tree.Path(ctx, &sub); p != "/Work/Sub" {
		t.Fatalf("path %q", p)
	}

	// Incremental: trash one file, hard-delete another, add a folder.
	srv.Trash("file", fid)
	srv.Delete("file", gone)
	srv.AddFolder(&work, "New")
	if changed, err := tree.Sync(ctx); err != nil || !changed {
		t.Fatal(changed, err)
	}
	l, _ = tree.List(ctx, &work)
	if len(l.Files) != 0 || len(names(l.Folders)) != 2 {
		t.Fatalf("after changes %v %v", names(l.Folders), names(l.Files))
	}
	if n, _ := db.GetNode(ctx, "file", fid); n == nil || !n.IsTrashed {
		t.Fatal("trashed file should stay cached as trashed")
	}
	if n, _ := db.GetNode(ctx, "file", gone); n != nil {
		t.Fatal("tombstoned file still cached")
	}

	// Expired cursor: resnapshot (trashed nodes leave the cache).
	srv.AddFolder(nil, "Late")
	srv.ExpireCursors()
	srv.AddFolder(nil, "Later")
	if _, err := tree.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	root, _ = tree.List(ctx, nil)
	if len(root.Folders) != 4 {
		t.Fatalf("after resnapshot %v", names(root.Folders))
	}
	if n, _ := db.GetNode(ctx, "file", fid); n != nil {
		t.Fatal("snapshot should not contain trashed nodes")
	}
	fresh := srv.AddFolder(nil, "Fresh") // not polled yet: a miss pulls the feed
	if l, err := tree.List(ctx, &fresh); err != nil || l.Folder["name"] != "Fresh" {
		t.Fatalf("fresh folder %v %v", l, err)
	}
	if _, err := tree.List(ctx, ptr(9999)); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestCreateFolder(t *testing.T) {
	ctx := context.Background()
	tree, srv, _ := setup(t)
	parent := srv.AddFolder(nil, "Photos")
	v, err := tree.CreateFolder(ctx, &parent, "2026 – summer", true)
	if err != nil {
		t.Fatal(err)
	}
	if v["name"] != "2026 – summer" || v["is_e2e"] != true || *(v["parent_id"].(*int64)) != parent {
		t.Fatalf("view %+v", v)
	}
	// The server only ever saw ciphertext, decryptable with the master key.
	tree.ResetKeys()
	l, _ := tree.List(ctx, &parent)
	if len(l.Folders) != 1 || l.Folders[0]["name"] != "2026 – summer" {
		t.Fatalf("listing %+v", l.Folders)
	}
	for _, bad := range []string{"", "  ", "a/b", "..", string(make([]byte, 300))} {
		if _, err := tree.CreateFolder(ctx, nil, bad, true); err == nil {
			t.Errorf("accepted name %q", bad)
		}
	}
	if _, err := tree.CreateFolder(ctx, ptr(9999), "x", true); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	std, err := tree.CreateFolder(ctx, nil, "Plain", false)
	if err != nil || std["is_e2e"] != false || std["name"] != "Plain" {
		t.Fatal(std, err)
	}
}

func TestPlainSize(t *testing.T) {
	for _, n := range []int{0, 1, e2ee.ChunkSize, e2ee.ChunkSize + 1, 3*e2ee.ChunkSize + 5} {
		chunks := (n + e2ee.ChunkSize - 1) / e2ee.ChunkSize
		if chunks == 0 {
			chunks = 1
		}
		cipher := int64(e2ee.HeaderSize + n + 20*chunks)
		if got := PlainSize(cipher); got != int64(n) {
			t.Errorf("PlainSize(%d) = %d, want %d", cipher, got, n)
		}
	}
}

func TestPollerAppliesAndNudges(t *testing.T) {
	tree, srv, _ := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	applied := make(chan struct{}, 10)
	p := NewPoller(tree)
	p.OnApplied = func() { applied <- struct{}{} }
	go p.Run(ctx)
	wait := func() {
		select {
		case <-applied:
		case <-time.After(5 * time.Second):
			t.Fatal("poller did not apply changes")
		}
	}
	wait() // first snapshot
	srv.AddFolder(nil, "Fresh")
	p.Nudge()
	wait()
	if got := interval(0); got != 5*time.Second || interval(10*time.Minute) != 30*time.Second || interval(time.Hour) != 120*time.Second {
		t.Fatal("cadence")
	}
	for i := 0; i < 100; i++ {
		if d := jitter(10 * time.Second); d < 8*time.Second || d > 12*time.Second {
			t.Fatal("jitter out of range", d)
		}
	}
}

func ptr(v int64) *int64 { return &v }
