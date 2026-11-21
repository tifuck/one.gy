package exec

import (
	"context"
	"testing"

	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/reconcile"
)

// AUDIT FIX (F5): a new version of a synced file that came without meta is
// not vouched for with a backfilled meta; a file never synced still is.
func TestNoBackfillForUnprovenVersion(t *testing.T) {
	f := setup(t, "e2ee")
	ctx := context.Background()
	id := f.srv.AddFile(&f.rootID, "a.txt", []byte("v1")) // browser upload: no meta
	f.sync()
	n, _ := f.db.GetNode(ctx, "file", id)
	op := reconcile.Op{Kind: reconcile.Download, Path: "a.txt", EntryKind: localfs.KindFile, RemoteID: id, RemoteName: "a.txt",
		ContentVersion: n.ContentVersion, PayloadChecksum: n.PayloadChecksum, Local: &reconcile.Expect{Absent: true}}
	if err := f.exec("e2ee").Execute(ctx, op); err != nil {
		t.Fatal(err)
	}
	f.sync()
	if n, _ := f.db.GetNode(ctx, "file", id); n.EncryptedMeta == "" {
		t.Fatal("first download of a meta-less file was not backfilled")
	}
	base := f.row("a.txt")

	f.srv.EditFile(id, []byte("v0-older")) // content_version moves, meta cleared
	f.sync()
	n, _ = f.db.GetNode(ctx, "file", id)
	in, _ := localfs.Lstat(f.root + "/a.txt")
	op = reconcile.Op{Kind: reconcile.Download, Path: "a.txt", EntryKind: localfs.KindFile, RemoteID: id, RemoteName: "a.txt",
		ContentVersion: n.ContentVersion, PayloadChecksum: n.PayloadChecksum, Base: base,
		Local: &reconcile.Expect{Kind: localfs.KindFile, ID: in.ID, Size: in.Size, MtimeNs: in.MtimeNs}}
	if err := f.exec("e2ee").Execute(ctx, op); err != nil {
		t.Fatal(err)
	}
	f.sync()
	if n, _ := f.db.GetNode(ctx, "file", id); n.EncryptedMeta != "" {
		t.Fatal("meta backfilled for a version that came without it")
	}
}
