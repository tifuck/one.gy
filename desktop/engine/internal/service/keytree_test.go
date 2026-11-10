//go:build !windows

package service

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/fakeserver"
	"github.com/tifuck/one.gy/desktop/engine/internal/ipc"
	"github.com/zalando/go-keyring"
)

// TestLockedSyncUsesOnlyTheKeyTree (sync-api.md "Key tree"): a locked app
// keeps syncing its folder without the master key (folder keys + pooled keys),
// cannot decrypt anything outside it, waits quietly on website files that have
// no tree wrap yet, survives a restart, and catches up after the PIN unlock.
func TestLockedSyncUsesOnlyTheKeyTree(t *testing.T) {
	keyring.MockInit()
	srv := fakeserver.New(t, "carol", "pw")
	stateDir := t.TempDir()
	rc, stop := engineOn(t, srv, stateDir)
	rc.ok("account.authorize", map[string]any{"server": srv.URL, "username": "carol", "password": "pw", "device_name": "PC"})
	rc.ok("account.setPin", map[string]any{"pin": "246810", "strict": false})
	work := srv.AddFolder(nil, "Work")
	other := srv.AddFolder(nil, "Private")
	srv.AddFile(&other, "secret.txt", []byte("outside the sync"))
	web1 := srv.AddFile(&work, "web1.txt", []byte("v1"))

	local := t.TempDir()
	rc.ok("syncs.create", map[string]any{"config": map[string]any{"local_path": local, "remote_folder_id": work}})
	waitFor(t, "first download", func() bool { return readFile(local, "web1.txt") == "v1" })
	waitFor(t, "key tree backfilled", func() bool { folders, files := srv.TreeWraps(); return folders >= 1 && files >= 1 })

	st := rc.ok("account.appLock", nil)
	if st["app_locked"] != true || st["full_keys"] != false || st["locked"] != false {
		t.Fatalf("after lock %v", st)
	}

	// Locked: a new local file goes up with a pooled key (readable with the
	// account's master key, as the website reads it) and its own tree wrap.
	writeOld(t, local, "local.txt", "made while locked")
	waitFor(t, "upload while locked", func() bool { return remotePlain(srv, work, "local.txt") == "made while locked" })
	// Locked: a website edit of a file with a tree wrap comes down.
	srv.EditFile(web1, []byte("v2"))
	// Locked: a website upload has no tree wrap yet: it waits, no issue.
	srv.AddFile(&work, "web2.txt", []byte("waits for unlock"))
	rc.ok("engine.nudge", nil)
	waitFor(t, "edit while locked", func() bool { return readFile(local, "web1.txt") == "v2" })
	time.Sleep(2 * time.Second)
	if readFile(local, "web2.txt") != "" {
		t.Fatal("a file without a tree wrap was decrypted while locked")
	}
	if issues, _ := rc.call("issues.list", nil); len(issues.([]any)) != 0 {
		t.Fatalf("waiting for unlock must not be an issue: %v", issues)
	}
	// Locked: nothing outside the sync decrypts.
	l := rc.ok("remote.list", map[string]any{"folder_id": other})
	if len(l["files"].([]any)) != 1 || l["files"].([]any)[0].(map[string]any)["name_error"] != true {
		t.Fatalf("outside file readable while locked: %v", l)
	}

	// Restart while locked: the folder keys come back with the unlock share.
	stop()
	rc, _ = engineOn(t, srv, stateDir)
	waitFor(t, "keys after restart", func() bool { return rc.ok("account.status", nil)["locked"] == false })
	if s := rc.ok("account.status", nil); s["full_keys"] != false || s["app_locked"] != true {
		t.Fatalf("after restart %v", s)
	}
	writeOld(t, local, "after-restart.txt", "still syncing")
	waitFor(t, "upload after restart", func() bool { return remotePlain(srv, work, "after-restart.txt") == "still syncing" })

	// Unlock: the backfill wraps the website file, which then comes down.
	rc.ok("account.appUnlock", map[string]any{"pin": "246810"})
	if s := rc.ok("account.status", nil); s["full_keys"] != true || s["app_locked"] != false {
		t.Fatalf("after unlock %v", s)
	}
	rc.ok("engine.nudge", nil)
	waitFor(t, "download after unlock", func() bool { return readFile(local, "web2.txt") == "waits for unlock" })
}

// engineOn runs an engine on stateDir; stop ends it (as a quit or a crash).
func engineOn(t *testing.T, srv *fakeserver.Server, stateDir string) (*rpcClient, func()) {
	t.Helper()
	svc, err := New(context.Background(), Options{StateDir: stateDir, API: api.Options{Version: "0.1.0", Transport: srv.Client().Transport}})
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(t.TempDir(), "engine.sock")
	ln, err := ipc.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { svc.Serve(ctx, ln); close(done) }()
	stopped := false
	stop := func() {
		if !stopped {
			stopped = true
			cancel()
			<-done
		}
	}
	t.Cleanup(stop)
	return dial(t, sock), stop
}

func readFile(dir, name string) string {
	b, _ := os.ReadFile(filepath.Join(dir, name))
	return string(b)
}

// writeOld writes a file dated past the scanner's quiet period.
func writeOld(t *testing.T, dir, name, body string) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Minute)
	os.Chtimes(p, old, old)
}

// remotePlain decrypts a file below root the way the website does (master key).
func remotePlain(srv *fakeserver.Server, root int64, path string) string {
	for _, e := range srv.Snapshot(&root) {
		if e.Path == path && !e.Trashed {
			return string(e.Plain)
		}
	}
	return ""
}
