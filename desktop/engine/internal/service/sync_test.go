//go:build !windows

package service

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestSyncMethods drives a real sync through the IPC surface: create (with
// default .onegyignore), upload, remote change -> download, rules, transfers,
// activity, verify, preview, manual download, diagnostics, environment.
func TestSyncMethods(t *testing.T) {
	rc, srv, stateDir := start(t)
	rc.ok("engine.subscribe", nil)
	select {
	case ev := <-rc.events:
		if ev["type"] != "status" {
			t.Fatalf("first event after subscribe: %v", ev)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no status event after subscribe")
	}
	rc.ok("account.authorize", map[string]any{"server": srv.URL, "username": "carol", "password": "pw", "device_name": "PC"})
	work := srv.AddFolder(nil, "Work")

	local := t.TempDir()
	old := time.Now().Add(-time.Minute)
	os.WriteFile(filepath.Join(local, "a.txt"), []byte("hello"), 0o644)
	os.Chtimes(filepath.Join(local, "a.txt"), old, old) // past the quiet period

	if v := rc.ok("syncs.validate", map[string]any{"local_path": local}); v["remote"] != nil || v["ok"] != true {
		t.Fatalf("local-only validate %v", v)
	}
	pv := rc.ok("syncs.preview", map[string]any{"config": map[string]any{"local_path": local, "remote_folder_id": work}})
	if pv["uploads"].(map[string]any)["count"] != 1.0 {
		t.Fatalf("preview %v", pv)
	}
	s := rc.ok("syncs.create", map[string]any{"config": map[string]any{"local_path": local, "remote_folder_id": work}})
	id := s["id"].(string)
	rules := rc.ok("syncs.ignoreRules", map[string]any{"id": id})
	if !strings.Contains(rules["text"].(string), "Thumbs.db") {
		t.Fatalf("default rules not written: %v", rules)
	}
	waitFor(t, "upload", func() bool {
		for _, e := range srv.Snapshot(&work) {
			if e.Path == "a.txt" && string(e.Plain) == "hello" {
				return true
			}
		}
		return false
	})

	srv.AddFile(&work, "b.txt", []byte("from the web"))
	rc.ok("engine.nudge", nil)
	waitFor(t, "download", func() bool {
		b, _ := os.ReadFile(filepath.Join(local, "b.txt"))
		return string(b) == "from the web"
	})

	if bad := rc.ok("syncs.setIgnoreRules", map[string]any{"id": id, "text": "-r:(\n"}); bad["ok"] != false {
		t.Fatalf("bad rules accepted: %v", bad)
	}
	if good := rc.ok("syncs.setIgnoreRules", map[string]any{"id": id, "text": "-:*.tmp\n"}); good["ok"] != true {
		t.Fatalf("rules refused: %v", good)
	}
	list, _ := rc.call("transfers.list", nil)
	if len(list.([]any)) < 2 {
		t.Fatalf("transfers %v", list)
	}
	acts, _ := rc.call("activity.recent", map[string]any{"limit": 10})
	if len(acts.([]any)) < 2 {
		t.Fatalf("activity %v", acts)
	}
	if issues, _ := rc.call("issues.list", nil); len(issues.([]any)) != 0 {
		t.Fatalf("issues %v", issues)
	}
	if v := rc.ok("syncs.verify", map[string]any{"id": id}); v["matches"] != 2.0 || v["differs"] != 0.0 {
		t.Fatalf("verify %v", v)
	}

	// Manual download of the web file into another folder.
	dl := t.TempDir()
	l := rc.ok("remote.list", map[string]any{"folder_id": work})
	var bID string
	for _, f := range l["files"].([]any) {
		if f.(map[string]any)["name"] == "b.txt" {
			bID = f.(map[string]any)["id"].(string)
		}
	}
	rc.ok("manual.download", map[string]any{"remote_ids": []string{bID}, "local_dir": dl})
	waitFor(t, "manual download", func() bool {
		b, _ := os.ReadFile(filepath.Join(dl, "b.txt"))
		return string(b) == "from the web"
	})

	// Diagnostics: logs and a summary without names.
	zp := filepath.Join(t.TempDir(), "diag.zip")
	rc.ok("diagnostics.export", map[string]any{"path": zp})
	zr, err := zip.OpenReader(zp)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if f.Name == "summary.json" {
			r, _ := f.Open()
			b, _ := io.ReadAll(r)
			r.Close()
			if strings.Contains(string(b), "a.txt") || strings.Contains(string(b), local) || !strings.Contains(string(b), `"synced_items": 2`) {
				t.Fatalf("summary %s", b)
			}
		}
	}
	zr.Close()

	// Metered network with the default "pause" policy pauses the sync.
	rc.ok("engine.environment", map[string]any{"metered": true, "on_battery": false})
	rc.ok("syncs.syncNow", map[string]any{"id": id})
	waitFor(t, "metered pause", func() bool {
		res, _ := rc.call("syncs.list", nil)
		return res.([]any)[0].(map[string]any)["state"] == "paused"
	})
	_ = stateDir
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
