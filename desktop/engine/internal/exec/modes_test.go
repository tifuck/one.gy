package exec

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"

	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/reconcile"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
	"onegy/e2ee"
)

func (f *fixture) putRow(r *state.SyncedRow) *state.SyncedRow {
	r.SyncID = "s1"
	if err := f.db.Tx(context.Background(), func(tx *sql.Tx) error { return state.PutSynced(tx, r) }); err != nil {
		f.t.Fatal(err)
	}
	return r
}

func TestModeOnlyOps(t *testing.T) {
	f := setup(t, "e2ee")
	f.srv.WithMeta = true
	data := []byte("#!/bin/sh\necho hi\n")
	id := f.srv.AddFile(&f.rootID, "run.sh", data)
	f.sync()
	n, _ := f.db.GetNode(context.Background(), "file", id)
	local := f.write("run.sh", data)
	os.Chmod(filepath.Join(f.root, "run.sh"), 0o755)
	base := f.putRow(&state.SyncedRow{RelPath: "run.sh", Kind: "file", RemoteID: id, LocalFID: string(local.ID), Size: local.Size,
		MtimeNs: local.MtimeNs, PlainSHA256: sum(data), RemoteContentVersion: n.ContentVersion, Mode: 0o644, RemoteName: "run.sh"})
	x := f.exec("e2ee")
	uploads := f.srv.Requests["POST /apiv1/sync/files"]
	op := reconcile.Op{Kind: reconcile.SetModeRemote, Path: "run.sh", EntryKind: localfs.KindFile, RemoteID: id,
		ContentVersion: n.ContentVersion, Size: local.Size, SHA256: sum(data), Mode: 0o755, Local: local, Base: base}
	if err := x.Execute(context.Background(), op); err != nil {
		t.Fatal(err)
	}
	f.sync()
	n2, _ := f.db.GetNode(context.Background(), "file", id)
	key, _ := e2ee.UnwrapKeyB64(n2.EncryptedKey, n2.KeyNonce, f.srv.MasterKey())
	m, err := e2ee.DecryptMeta(n2.EncryptedMeta, n2.MetaNonce, key, id, n.ContentVersion)
	if err != nil || m.Mode != 0o755 || m.PlainSHA256 != sum(data) || n2.ContentVersion != n.ContentVersion {
		t.Fatalf("meta %+v err %v (cv %d -> %d)", m, err, n.ContentVersion, n2.ContentVersion)
	}
	if f.srv.Requests["POST /apiv1/sync/files"] != uploads {
		t.Fatal("content was uploaded again")
	}
	if r := f.row("run.sh"); r == nil || r.Mode != 0o755 {
		t.Fatalf("row %+v", r)
	}

	// One.gy says the bit is gone: chmod here.
	op = reconcile.Op{Kind: reconcile.SetModeLocal, Path: "run.sh", EntryKind: localfs.KindFile, RemoteID: id, Mode: 0o644,
		Local: local, Base: f.row("run.sh")}
	if err := x.Execute(context.Background(), op); err != nil {
		t.Fatal(err)
	}
	// Windows has no POSIX permission bits (Go reports rw-rw-rw-); only the row matters there.
	if fi, _ := os.Stat(filepath.Join(f.root, "run.sh")); runtime.GOOS != "windows" && fi.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", fi.Mode())
	}
	if r := f.row("run.sh"); r.Mode != 0o644 {
		t.Fatalf("row mode %o", r.Mode)
	}

	// Content changed on one.gy after the plan: superseded, nothing written.
	f.srv.EditFile(id, []byte("new"))
	f.sync()
	op = reconcile.Op{Kind: reconcile.SetModeRemote, Path: "run.sh", EntryKind: localfs.KindFile, RemoteID: id,
		ContentVersion: n.ContentVersion, Size: local.Size, SHA256: sum(data), Mode: 0o755, Local: local, Base: f.row("run.sh")}
	if err := x.Execute(context.Background(), op); err != ErrSuperseded {
		t.Fatalf("want superseded, got %v", err)
	}
}

func TestRestoreRemoteFolder(t *testing.T) {
	f := setup(t, "e2ee")
	dir := f.srv.AddFolder(&f.rootID, "d")
	inner := f.srv.AddFile(&dir, "a.txt", []byte("kept"))
	did := strconv.FormatInt(dir, 10)
	f.srv.Trash("folder", did)
	f.sync()
	x := f.exec("e2ee")
	base := f.putRow(&state.SyncedRow{RelPath: "d", Kind: "folder", RemoteID: did, RemoteName: "d"})
	op := reconcile.Op{Kind: reconcile.RestoreRemote, Path: "d", EntryKind: localfs.KindDir, RemoteID: did, Base: base}
	if err := x.Execute(context.Background(), op); err != nil {
		t.Fatal(err)
	}
	f.sync()
	if got := f.remoteFile("d/a.txt"); string(got) != "kept" {
		t.Fatalf("restored content %q (file %s)", got, inner)
	}
	if r := f.row("d"); r == nil || r.RemoteChangeSeq == 0 {
		t.Fatalf("row %+v", r)
	}
	// Not in the trash any more: superseded.
	if err := x.Execute(context.Background(), op); err != ErrSuperseded {
		t.Fatalf("want superseded, got %v", err)
	}
}
