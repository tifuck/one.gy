//go:build !windows

package service

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/fakeserver"
	"github.com/tifuck/one.gy/desktop/engine/internal/ipc"
	"github.com/zalando/go-keyring"
)

type rpcClient struct {
	t      *testing.T
	c      net.Conn
	mu     sync.Mutex
	id     int
	resps  map[int]chan map[string]any
	events chan map[string]any
}

func dial(t *testing.T, sock string) *rpcClient {
	c, err := ipc.Dial(sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	rc := &rpcClient{t: t, c: c, resps: map[int]chan map[string]any{}, events: make(chan map[string]any, 100)}
	go func() {
		r := bufio.NewReader(c)
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			var m map[string]any
			json.Unmarshal(line, &m)
			if m["method"] == "event" {
				rc.events <- m["params"].(map[string]any)
				continue
			}
			rc.mu.Lock()
			ch := rc.resps[int(m["id"].(float64))]
			rc.mu.Unlock()
			ch <- m
		}
	}()
	return rc
}

// call returns (result, error object).
func (rc *rpcClient) call(method string, params any) (any, map[string]any) {
	rc.t.Helper()
	rc.mu.Lock()
	rc.id++
	id := rc.id
	ch := make(chan map[string]any, 1)
	rc.resps[id] = ch
	rc.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	rc.c.Write(append(b, '\n'))
	select {
	case m := <-ch:
		e, _ := m["error"].(map[string]any)
		return m["result"], e
	case <-time.After(20 * time.Second):
		rc.t.Fatalf("%s: no answer", method)
	}
	return nil, nil
}

func (rc *rpcClient) ok(method string, params any) map[string]any {
	rc.t.Helper()
	res, e := rc.call(method, params)
	if e != nil {
		rc.t.Fatalf("%s: %v", method, e)
	}
	m, _ := res.(map[string]any)
	return m
}

func errCode(e map[string]any) string {
	if e == nil {
		return ""
	}
	return e["data"].(map[string]any)["code"].(string)
}

func errCodes(e map[string]any) []string {
	var out []string
	list, _ := e["data"].(map[string]any)["errors"].([]any)
	for _, p := range list {
		out = append(out, p.(map[string]any)["code"].(string))
	}
	return out
}

func start(t *testing.T) (*rpcClient, *fakeserver.Server, string) {
	t.Helper()
	keyring.MockInit()
	stateDir := t.TempDir()
	srv := fakeserver.New(t, "carol", "pw")
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
	t.Cleanup(func() { cancel(); <-done })
	return dial(t, sock), srv, stateDir
}

func TestEngineFlow(t *testing.T) {
	rc, srv, stateDir := start(t)
	rc.ok("engine.subscribe", nil)

	info := rc.ok("engine.info", nil)
	if info["protocol"] != 1.0 || info["state_dir"] != stateDir {
		t.Fatalf("info %v", info)
	}
	if st := rc.ok("account.status", nil); st["signed_in"] != false {
		t.Fatalf("status %v", st)
	}
	if _, e := rc.call("remote.list", map[string]any{"folder_id": nil}); errCode(e) != "not_signed_in" {
		t.Fatalf("remote.list signed out: %v", e)
	}
	if _, e := rc.call("syncs.preview", map[string]any{"config": map[string]any{"local_path": "relative"}}); errCode(e) != "validation_failed" {
		t.Fatalf("preview without a valid folder: %v", e)
	}

	// Settings persist and validate.
	set := rc.ok("settings.set", map[string]any{"patch": map[string]any{"parallel_up": 3, "defaults": map[string]any{"debris_days": 7}}})
	if set["parallel_up"] != 3.0 || set["defaults"].(map[string]any)["debris_days"] != 7.0 || set["defaults"].(map[string]any)["type"] != "two_way" {
		t.Fatalf("settings %v", set)
	}
	if _, e := rc.call("settings.set", map[string]any{"patch": map[string]any{"log_level": "loud"}}); errCode(e) != "validation_failed" {
		t.Fatalf("bad log level accepted: %v", e)
	}
	if _, e := rc.call("settings.set", map[string]any{"patch": map[string]any{"bogus": 1}}); errCode(e) != "validation_failed" {
		t.Fatalf("unknown key accepted: %v", e)
	}

	// Authorize.
	if _, e := rc.call("account.authorize", map[string]any{"server": srv.URL, "username": "carol", "password": "bad", "device_name": "PC"}); errCode(e) != "invalid_credentials" {
		t.Fatalf("bad password: %v", e)
	}
	st := rc.ok("account.authorize", map[string]any{"server": srv.URL, "username": "carol", "password": "pw", "device_name": "PC"})
	if st["signed_in"] != true || st["locked"] != false || st["device_name"] != "PC" {
		t.Fatalf("authorize %v", st)
	}
	if k := rc.ok("account.webUnlockKey", nil); k["master_key_b64"] == "" {
		t.Fatal("web unlock key")
	}

	// Remote browse + create.
	docs := srv.AddFolder(nil, "Docs")
	other := srv.AddFolder(nil, "Other")
	l := rc.ok("remote.list", map[string]any{"folder_id": nil})
	if len(l["folders"].([]any)) != 2 {
		t.Fatalf("list %v", l)
	}
	f := rc.ok("remote.createFolder", map[string]any{"parent_id": docs, "name": "Inbox", "e2ee": true})
	if f["name"] != "Inbox" || f["is_e2e"] != true {
		t.Fatalf("createFolder %v", f)
	}
	if _, e := rc.call("remote.createFolder", map[string]any{"parent_id": nil, "name": "a/b"}); errCode(e) != "validation_failed" {
		t.Fatalf("bad name: %v", e)
	}

	// Validate rules.
	local := t.TempDir()
	v := rc.ok("syncs.validate", map[string]any{"local_path": local, "remote_folder_id": docs, "type": "two_way"})
	if v["ok"] != true || v["fs"].(map[string]any)["kind"] == "" {
		t.Fatalf("validate %v", v)
	}
	bad := rc.ok("syncs.validate", map[string]any{"local_path": "/etc", "remote_folder_id": 999, "type": "two_way"})
	codes := strings.Join(errCodesFrom(bad), ",")
	if bad["ok"] != false || !strings.Contains(codes, "system_path") || !strings.Contains(codes, "remote_missing") {
		t.Fatalf("validate bad %v", bad)
	}
	if v := rc.ok("syncs.validate", map[string]any{"local_path": stateDir, "remote_folder_id": docs, "type": "two_way"}); !strings.Contains(strings.Join(errCodesFrom(v), ","), "state_dir_overlap") {
		t.Fatalf("state dir overlap %v", v)
	}

	// Create, then overlap checks against it.
	created := rc.ok("syncs.create", map[string]any{"config": map[string]any{"local_path": local, "remote_folder_id": docs, "type": "two_way"}, "initial": "merge"})
	id := created["id"].(string)
	if created["remote_path"] != "/Docs" || created["debris_days"] != 7.0 || created["encryption"] != "e2ee" {
		t.Fatalf("created %v", created)
	}
	marker, err := os.ReadFile(filepath.Join(local, ".onegy", "sync.json"))
	if err != nil || !strings.Contains(string(marker), id) {
		t.Fatalf("marker %s %v", marker, err)
	}
	sub := filepath.Join(local, "sub")
	os.Mkdir(sub, 0o755)
	if _, e := rc.call("syncs.create", map[string]any{"config": map[string]any{"local_path": sub, "remote_folder_id": other}}); !contains(errCodes(e), "local_overlap") {
		t.Fatalf("local overlap %v", e)
	}
	inbox := int64(f["id"].(float64))
	if _, e := rc.call("syncs.create", map[string]any{"config": map[string]any{"local_path": t.TempDir(), "remote_folder_id": inbox}}); !contains(errCodes(e), "remote_overlap") {
		t.Fatalf("remote overlap %v", e)
	}
	mirror := rc.ok("syncs.create", map[string]any{"config": map[string]any{"local_path": t.TempDir(), "remote_folder_id": inbox, "type": "mirror"}})
	if _, e := rc.call("syncs.create", map[string]any{"config": map[string]any{"local_path": t.TempDir(), "type": "full"}}); !contains(errCodes(e), "full_exclusive") {
		t.Fatalf("full exclusive %v", e)
	}

	// Update, pause/resume, list, remove.
	up := rc.ok("syncs.update", map[string]any{"id": id, "patch": map[string]any{"name": "Work", "schedule": map[string]any{"mode": "interval", "interval_minutes": 30}}})
	if up["name"] != "Work" || up["schedule"].(map[string]any)["interval_minutes"] != 30.0 {
		t.Fatalf("update %v", up)
	}
	if _, e := rc.call("syncs.update", map[string]any{"id": id, "patch": map[string]any{"encryption": "standard"}}); !contains(errCodes(e), "fixed_field") {
		t.Fatalf("fixed field %v", e)
	}
	rc.ok("syncs.pause", map[string]any{"id": id})
	listRes, _ := rc.call("syncs.list", nil)
	list := listRes.([]any)
	if len(list) != 2 || list[0].(map[string]any)["state"] != "paused" {
		t.Fatalf("list %v", list)
	}
	rc.ok("syncs.resume", nil)
	rc.ok("syncs.remove", map[string]any{"id": mirror["id"]})
	rc.ok("syncs.remove", map[string]any{"id": id})
	if _, err := os.Stat(filepath.Join(local, ".onegy")); !os.IsNotExist(err) {
		t.Fatal(".onegy left behind")
	}
	if _, err := os.Stat(local); err != nil {
		t.Fatal("local folder must be kept")
	}

	// Events arrived: a sync event and a status event at least.
	seen := map[string]bool{}
	for len(rc.events) > 0 {
		seen[(<-rc.events)["type"].(string)] = true
	}
	if !seen["sync"] || !seen["status"] {
		t.Fatalf("events %v", seen)
	}

	// Revocation: next server call wipes keys and notifies.
	srv.RevokeAll()
	rc.call("remote.createFolder", map[string]any{"parent_id": nil, "name": "x"})
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-rc.events:
			if ev["type"] == "notify" {
				if st := rc.ok("account.status", nil); st["signed_in"] != false {
					t.Fatalf("still signed in after revoke: %v", st)
				}
				return
			}
		case <-deadline:
			t.Fatal("no revoke notification")
		}
	}
}

func errCodesFrom(res map[string]any) []string {
	var out []string
	for _, p := range res["errors"].([]any) {
		out = append(out, p.(map[string]any)["code"].(string))
	}
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
