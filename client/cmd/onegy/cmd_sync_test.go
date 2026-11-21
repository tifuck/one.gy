//go:build linux

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/config"
	"github.com/tifuck/one.gy/client/internal/fakeserver"
	"github.com/tifuck/one.gy/client/internal/ipc"
	"github.com/tifuck/one.gy/client/internal/service"
	"github.com/zalando/go-keyring"
)

// startEngine runs an engine on stateDir like `onegy daemon` does; the
// returned func stops it.
func startEngine(t *testing.T, srv *fakeserver.Server, stateDir, sock string, secretsFile bool) func() {
	t.Helper()
	opts := service.Options{StateDir: stateDir, API: api.Options{Version: "0.1.0", Transport: srv.Client().Transport}}
	if secretsFile {
		opts.SecretsFile = filepath.Join(stateDir, "secrets.json")
	}
	svc, err := service.New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	svc.SetIPCHelloKey("key-" + stateDir)
	ln, err := ipc.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.WriteEngineInfo(stateDir, sock, "key-"+stateDir); err != nil {
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
	return stop
}

func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(30 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func uploaded(srv *fakeserver.Server, path, plain string) bool {
	for _, e := range srv.Snapshot(nil) {
		if e.Path == path && string(e.Plain) == plain && !e.Trashed {
			return true
		}
	}
	return false
}

func oldFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Minute) // past the quiet period
	os.Chtimes(path, old, old)
}

// TestHeadlessSync is a server without a key store: sign in, add a sync and
// keep syncing across an engine restart, all through the CLI commands.
func TestHeadlessSync(t *testing.T) {
	keyring.MockInitWithError(errors.New("no secret service")) // no D-Bus / keyring
	srv := fakeserver.New(t, "carol", "pw")
	stateDir := t.TempDir()
	sock := filepath.Join(t.TempDir(), "engine.sock")
	stop := startEngine(t, srv, stateDir, sock, true)
	run := func(input, cmd string, args ...string) error {
		stdin = bufio.NewReader(strings.NewReader(input))
		return syncCommand(cmd, append(args, "--state-dir", stateDir))
	}

	if err := run("bad\n", "login", "--user", "carol", "--server", srv.URL); errCode(err) != "invalid_credentials" {
		t.Fatalf("bad password: %v", err)
	}
	if err := run("pw\n", "login", "--user", "carol", "--server", srv.URL, "--device", "srv1"); err != nil {
		t.Fatal(err)
	}
	local := t.TempDir()
	oldFile(t, filepath.Join(local, "a.txt"), "one")
	if err := run("", "sync", "add", local, "/Work/Inbox", "--yes"); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "first upload", func() bool { return uploaded(srv, "Work/Inbox/a.txt", "one") })
	if err := run("", "sync", "add", t.TempDir(), "/Work/Inbox", "--yes"); err == nil {
		t.Fatal("overlapping sync accepted")
	}
	if err := run("", "lock"); err != nil {
		t.Fatal(err)
	}

	// Restart (reboot, service restart): the secrets file brings the device
	// back and the server share opens the sync keys without a password.
	stop()
	startEngine(t, srv, stateDir, sock, true)
	oldFile(t, filepath.Join(local, "b.txt"), "two")
	waitUntil(t, "upload after restart", func() bool { return uploaded(srv, "Work/Inbox/b.txt", "two") })
	var st accountStatus
	if err := (engine{sock, config.HelloKey(stateDir)}).call("account.status", nil, &st); err != nil || !st.SignedIn || st.Locked {
		t.Fatalf("status after restart: %+v %v", st, err)
	}
	for _, cmd := range [][]string{{"status"}, {"sync", "list"}, {"issues"}, {"sync", "pause"}, {"sync", "resume"}} {
		if err := run("", cmd[0], cmd[1:]...); err != nil {
			t.Fatalf("%v: %v", cmd, err)
		}
	}
	if err := run("", "sync", "bogus"); err == nil {
		t.Fatal("unknown subcommand accepted")
	}
	if fi, err := os.Stat(filepath.Join(stateDir, "secrets.json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("secrets file: %v %v", fi, err)
	}
}

// Without --secrets-file and without a key store the device comes back
// closed after a restart and needs the password (the reason for the flag).
func TestHeadlessRestartWithoutSecretsFile(t *testing.T) {
	keyring.MockInitWithError(errors.New("no secret service"))
	srv := fakeserver.New(t, "carol", "pw")
	stateDir := t.TempDir()
	sock := filepath.Join(t.TempDir(), "engine.sock")
	stop := startEngine(t, srv, stateDir, sock, false)
	stdin = bufio.NewReader(strings.NewReader("pw\n"))
	if err := syncCommand("login", []string{"--user", "carol", "--server", srv.URL, "--state-dir", stateDir}); err != nil {
		t.Fatal(err)
	}
	stop()
	startEngine(t, srv, stateDir, sock, false)
	var st accountStatus
	if err := (engine{sock, config.HelloKey(stateDir)}).call("account.status", nil, &st); err != nil || !st.Locked {
		t.Fatalf("expected closed keys: %+v %v", st, err)
	}
	stdin = bufio.NewReader(strings.NewReader("pw\n"))
	if err := syncCommand("unlock", []string{"--state-dir", stateDir}); err != nil {
		t.Fatal(err)
	}
	if err := (engine{sock, config.HelloKey(stateDir)}).call("account.status", nil, &st); err != nil || st.Locked {
		t.Fatalf("unlock: %+v %v", st, err)
	}
}

func TestParseArgs(t *testing.T) {
	a, err := parseArgs([]string{"add", "/x", "--type", "backup", "/Y", "--yes", "--name=Z"}, []string{"type", "name"}, []string{"yes"})
	if err != nil || strings.Join(a.pos, ",") != "add,/x,/Y" || a.flags["type"] != "backup" || a.flags["yes"] != "1" || a.flags["name"] != "Z" {
		t.Fatalf("%+v %v", a, err)
	}
	if _, err := parseArgs([]string{"--nope"}, nil, nil); err == nil {
		t.Fatal("unknown flag accepted")
	}
	if _, err := parseArgs([]string{"--type"}, []string{"type"}, nil); err == nil {
		t.Fatal("missing value accepted")
	}
}

// AUDIT FIX (F4): a program at the engine's socket that cannot prove the key
// of engine.json never receives the password.
func TestCLIRefusesUnprovenEngine(t *testing.T) {
	stateDir := t.TempDir()
	sock := filepath.Join(t.TempDir(), "engine.sock")
	got := make(chan string, 1)
	fake := ipc.NewServer() // no HelloKey: answers ipc.hello without key_proof
	fake.Handle("account.unlock", func(_ context.Context, p json.RawMessage) (any, error) {
		got <- string(p)
		return map[string]any{}, nil
	})
	ln, err := ipc.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fake.Serve(ctx, ln)
	defer fake.Close()
	if err := config.WriteEngineInfo(stateDir, sock, "the-real-key"); err != nil {
		t.Fatal(err)
	}
	stdin = bufio.NewReader(strings.NewReader("pw\n"))
	if err := syncCommand("unlock", []string{"--state-dir", stateDir}); err == nil || !strings.Contains(err.Error(), "did not prove") {
		t.Fatalf("unproven engine accepted: %v", err)
	}
	fake.HelloKey = "another-key"
	stdin = bufio.NewReader(strings.NewReader("pw\n"))
	if err := syncCommand("unlock", []string{"--state-dir", stateDir}); err == nil {
		t.Fatal("engine with the wrong key accepted")
	}
	select {
	case p := <-got:
		t.Fatalf("password sent to an unproven engine: %s", p)
	default:
	}
	fake.HelloKey = "the-real-key"
	stdin = bufio.NewReader(strings.NewReader("pw\n"))
	if err := syncCommand("unlock", []string{"--state-dir", stateDir}); err != nil {
		t.Fatalf("proven engine refused: %v", err)
	}
}
