package exec

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/reconcile"
)

// A file synced end-to-end encrypted that one.gy later lists as standard is
// never uploaded in plain text nor replaced by the standard content, unless
// the user keeps the one.gy version.
func TestE2EEDowngradeRefused(t *testing.T) {
	f := setup(t, "e2ee")
	ctx := context.Background()
	x := f.exec("e2ee")
	if err := x.Execute(ctx, f.uploadOp("a.txt", []byte("secret v1"))); err != nil {
		t.Fatal(err)
	}
	base := f.row("a.txt")
	if base == nil || !base.E2EE {
		t.Fatalf("row %+v", base)
	}
	f.srv.MakeStandard(base.RemoteID, []byte("server text"))
	f.sync()
	n, _ := f.db.GetNode(ctx, "file", base.RemoteID)
	if n.IsE2E {
		t.Fatal("node still E2EE")
	}

	edit := []byte("secret v2")
	local := f.write("a.txt", edit)
	up := reconcile.Op{Kind: reconcile.Upload, Path: "a.txt", EntryKind: localfs.KindFile, RemoteID: base.RemoteID, RemoteName: "a.txt",
		ContentVersion: n.ContentVersion, Size: local.Size, SHA256: sum(edit), Local: local, Base: base}
	var ie *IssueError
	if err := x.Execute(ctx, up); !errors.As(err, &ie) || ie.Kind != "integrity" {
		t.Fatalf("upload: want integrity, got %v", err)
	}
	if got := f.remoteFile("a.txt"); string(got) != "server text" {
		t.Fatalf("one.gy got %q", got)
	}

	down := reconcile.Op{Kind: reconcile.Download, Path: "a.txt", EntryKind: localfs.KindFile, RemoteID: base.RemoteID, RemoteName: "a.txt",
		ContentVersion: n.ContentVersion, PayloadChecksum: n.PayloadChecksum, Local: local, Base: base}
	if err := x.Execute(ctx, down); !errors.As(err, &ie) || ie.Kind != "integrity" {
		t.Fatalf("download: want integrity, got %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.root, "a.txt")); string(b) != "secret v2" {
		t.Fatalf("local %q", b)
	}

	down.Downgrade = true // keep_remote
	if err := x.Execute(ctx, down); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.root, "a.txt")); string(b) != "server text" {
		t.Fatalf("local %q", b)
	}
	if r := f.row("a.txt"); r == nil || r.E2EE {
		t.Fatalf("row %+v", r)
	}

	// Gone on one.gy and created again from a standard sync: stays E2EE.
	op := f.uploadOp("b.txt", []byte("secret b"))
	op.Base = base
	op.Base.RelPath, op.Base.RemoteID = "b.txt", ""
	if err := f.exec("standard").Execute(ctx, op); err != nil {
		t.Fatal(err)
	}
	r := f.row("b.txt")
	if n, _ := f.db.GetNode(ctx, "file", r.RemoteID); n == nil || !n.IsE2E || !r.E2EE {
		t.Fatalf("re-created as %+v, row %+v", n, r)
	}
}
