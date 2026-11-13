package exec

import (
	"bytes"
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/tifuck/one.gy/client/e2ee"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/reconcile"
)

// fileKey is the master-key view of a file's key (what a link visitor must get).
func (f *fixture) fileKey(id string) []byte {
	n, _ := f.db.GetNode(context.Background(), "file", id)
	if n == nil {
		f.t.Fatalf("file %s not cached", id)
	}
	k, _ := e2ee.UnwrapKeyB64(n.EncryptedKey, n.KeyNonce, f.srv.MasterKey())
	return k
}

func (f *fixture) linked(id string) bool {
	f.sync()
	k := f.srv.FolderLinkFileKey(id)
	return k != nil && bytes.Equal(k, f.fileKey(id))
}

func TestUploadIntoLinkSharedFolder(t *testing.T) {
	f := setup(t, "e2ee")
	shared := f.srv.AddFolder(&f.rootID, "shared")
	f.srv.ShareFolder(shared)
	sub := f.srv.AddFolder(&shared, "sub")
	f.sync()
	x := f.exec("e2ee")
	op := f.uploadOp("shared/sub/a.txt", []byte("for the link"))
	op.ParentRemoteID = strconv.FormatInt(sub, 10)
	// Crash after the upload committed on one.gy, before the wrap was sent.
	x.Crash = func(point string, _ reconcile.OpKind) bool { return point == "remote_done" }
	if err := x.Execute(context.Background(), op); !errors.Is(err, ErrCrashed) {
		t.Fatalf("want crash, got %v", err)
	}
	x.Crash = nil
	if err := x.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := f.row("shared/sub/a.txt")
	if r == nil || !f.linked(r.RemoteID) {
		t.Fatalf("not readable through the folder link (row %+v)", r)
	}
	// Outside a shared folder nothing is sent.
	sent := func() (n int) {
		for k, v := range f.srv.Requests {
			if strings.HasSuffix(k, "/folder-link-key") {
				n += v
			}
		}
		return n
	}
	before := sent()
	if err := x.Execute(context.Background(), f.uploadOp("b.txt", []byte("private"))); err != nil {
		t.Fatal(err)
	}
	if sent() != before {
		t.Fatal("folder-link key sent for a file outside shared folders")
	}
}

func TestMovesIntoLinkSharedFolder(t *testing.T) {
	f := setup(t, "e2ee")
	shared := f.srv.AddFolder(&f.rootID, "shared")
	f.srv.ShareFolder(shared)
	file := f.srv.AddFile(&f.rootID, "x.txt", []byte("moved in"))
	dir := f.srv.AddFolder(&f.rootID, "dir")
	inner := f.srv.AddFile(&dir, "y.txt", []byte("moved with its folder"))
	f.sync()
	if f.linked(file) || f.linked(inner) {
		t.Fatal("linked before the moves")
	}
	x := f.exec("e2ee")
	sid := strconv.FormatInt(shared, 10)
	for _, op := range []reconcile.Op{
		{Kind: reconcile.MoveRemote, From: "x.txt", Path: "shared/x.txt", EntryKind: localfs.KindFile, RemoteID: file,
			ParentRemoteID: sid, RemoteName: "x.txt"},
		{Kind: reconcile.MoveRemote, From: "dir", Path: "shared/dir", EntryKind: localfs.KindDir, RemoteID: strconv.FormatInt(dir, 10),
			ParentRemoteID: sid, RemoteName: "dir"},
	} {
		if err := x.Execute(context.Background(), op); err != nil {
			t.Fatalf("%s: %v", op.Path, err)
		}
	}
	if !f.linked(file) || !f.linked(inner) {
		t.Fatalf("not readable through the folder link: file %v, inner %v", f.linked(file), f.linked(inner))
	}
}
