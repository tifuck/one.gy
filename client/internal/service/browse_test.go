//go:build !windows

package service

import (
	"os"
	"path/filepath"
	"testing"
)

// TestSyncsBrowse: the union of both sides with the rules' verdict per item.
func TestSyncsBrowse(t *testing.T) {
	rc, srv, _ := start(t)
	rc.ok("account.authorize", map[string]any{"server": srv.URL, "username": "carol", "password": "pw", "device_name": "PC"})
	work := srv.AddFolder(nil, "Work")
	srv.AddFolder(&work, "docs")
	srv.AddFile(&work, "web.txt", []byte("12345"))

	local := t.TempDir()
	os.MkdirAll(filepath.Join(local, "docs", "old"), 0o755)
	os.MkdirAll(filepath.Join(local, "node_modules"), 0o755)
	os.MkdirAll(filepath.Join(local, ".onegy"), 0o700)
	os.WriteFile(filepath.Join(local, "big.iso"), make([]byte, 3<<10), 0o644)
	os.WriteFile(filepath.Join(local, "docs", "a.txt"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(local, ".onegyignore"), []byte("-:x\n"), 0o644)

	res := rc.ok("syncs.browse", map[string]any{"local_path": local, "remote_folder_id": work,
		"ignore_rules": "-d:node_modules\nexclude-larger:2K\n"})
	got := map[string]map[string]any{}
	var order []string
	for _, it := range res["items"].([]any) {
		m := it.(map[string]any)
		got[m["name"].(string)] = m
		order = append(order, m["name"].(string))
	}
	want := []string{"docs", "node_modules", "big.iso", "web.txt"} // folders first; .onegy and .onegyignore hidden
	if len(order) != len(want) {
		t.Fatalf("items %v", order)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("items %v", order)
		}
	}
	if d := got["docs"]; d["local"] != true || d["remote"] != true || d["remote_id"] == nil || d["excluded"] != false {
		t.Fatalf("docs %v", d)
	}
	if got["node_modules"]["excluded"] != true || got["big.iso"]["size_skipped"] != true {
		t.Fatalf("rules not applied %v", got)
	}
	if w := got["web.txt"]; w["local"] != false || w["remote"] != true || w["size"] != 5.0 {
		t.Fatalf("remote-only file %v", w)
	}

	// A subfolder, local side only, with an exact-path rule; a bad rule is reported.
	res = rc.ok("syncs.browse", map[string]any{"local_path": local, "path": "docs", "ignore_rules": "-pR:docs/old\n"})
	items := res["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["path"] != "docs/old" || items[0].(map[string]any)["excluded"] != true {
		t.Fatalf("docs listing %v", items)
	}
	if res["folder_excluded"] != false {
		t.Fatalf("docs is not excluded: %v", res)
	}
	if out := rc.ok("syncs.browse", map[string]any{"local_path": local, "path": "docs/old", "ignore_rules": "-pR:docs/old\n"}); out["folder_excluded"] != true {
		t.Fatalf("inside an excluded folder: %v", out)
	}
	if bad := rc.ok("syncs.browse", map[string]any{"local_path": local, "ignore_rules": "-r:(\n"}); len(bad["errors"].([]any)) != 1 {
		t.Fatalf("parse errors %v", bad)
	}
	if _, e := rc.call("syncs.browse", map[string]any{"local_path": local, "path": "../etc"}); errCode(e) != "validation_failed" {
		t.Fatalf("escape accepted: %v", e)
	}
}
