//go:build !windows

package service

import (
	"os"
	"path/filepath"
	"testing"
)

// TestBackupSync: the default target Backups/<device>/<folder> is created
// once (repeats reuse it), syncs.create marks it as this device's backup,
// another device's backup is refused as a two-way target, and remove can
// release the backup. Also clearDebris and clearCaches.
func TestBackupSync(t *testing.T) {
	rc, srv, _ := start(t)
	rc.ok("account.authorize", map[string]any{"server": srv.URL, "username": "carol", "password": "pw", "device_name": "PC/1"})
	local := filepath.Join(t.TempDir(), "Photos")
	os.Mkdir(local, 0o755)

	if tg := rc.ok("syncs.backupTarget", map[string]any{"local_path": local}); tg["exists"] != false || tg["path"] != "/Backups/PC-1/Photos" {
		t.Fatalf("lookup %v", tg)
	}
	a := rc.ok("syncs.backupTarget", map[string]any{"local_path": local, "create": true})
	b := rc.ok("syncs.backupTarget", map[string]any{"local_path": local, "create": true})
	if a["folder_id"] == nil || a["folder_id"] != b["folder_id"] || b["exists"] != true {
		t.Fatalf("not idempotent: %v %v", a, b)
	}
	if n := len(rc.ok("remote.list", nil)["folders"].([]any)); n != 1 {
		t.Fatalf("drive root has %d folders, want only Backups", n)
	}

	s := rc.ok("syncs.create", map[string]any{"config": map[string]any{"type": "backup", "local_path": local}})
	if s["remote_folder_id"] != a["folder_id"] || s["remote_path"] != "/Backups/PC-1/Photos" {
		t.Fatalf("create used %v %v", s["remote_folder_id"], s["remote_path"])
	}
	id := int64(a["folder_id"].(float64))
	if f := srv.Folder(id); !f.IsBackup || f.BackupDeviceID == nil {
		t.Fatalf("not marked: %+v", f)
	}

	// Another device's backup is read-only for a two-way sync.
	other := filepath.Join(t.TempDir(), "x")
	os.Mkdir(other, 0o755)
	theirs := srv.AddFolder(nil, "Theirs")
	srv.MarkBackup(theirs, "d999")
	rc.ok("engine.clearCaches", nil)
	v := rc.ok("syncs.validate", map[string]any{"local_path": other, "remote_folder_id": theirs, "type": "two_way"})
	if v["ok"] != false || v["errors"].([]any)[0].(map[string]any)["code"] != "remote_read_only" {
		t.Fatalf("validate %v", v)
	}

	debris := filepath.Join(local, ".onegy", "debris", "2026-11-09")
	os.MkdirAll(debris, 0o700)
	os.WriteFile(filepath.Join(debris, "old.txt"), []byte("x"), 0o600)
	rc.ok("syncs.clearDebris", map[string]any{"id": s["id"]})
	if _, err := os.Stat(filepath.Join(local, ".onegy", "debris")); !os.IsNotExist(err) {
		t.Fatalf("debris left: %v", err)
	}

	rc.ok("syncs.remove", map[string]any{"id": s["id"], "release_backup": true})
	if f := srv.Folder(id); f.IsBackup {
		t.Fatalf("still a backup: %+v", f)
	}
	if _, e := rc.call("versions.list", map[string]any{"sync_id": s["id"], "path": "nope.txt"}); errCode(e) != "not_found" {
		t.Fatalf("versions.list on a missing file: %v", e)
	}
}
