//go:build !windows

package ipc

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
)

func TestServer(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "run", "engine.sock")
	s := NewServer()
	s.Handle("echo", func(_ context.Context, p json.RawMessage) (any, error) {
		var in struct{ X int }
		if err := Params(p, &in); err != nil {
			return nil, err
		}
		return map[string]int{"x": in.X}, nil
	})
	s.Handle("fail", func(context.Context, json.RawMessage) (any, error) { return nil, Errorf("locked", "locked") })
	s.Handle("boom", func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("disk on fire") })
	s.Handle("panic", func(context.Context, json.RawMessage) (any, error) { panic("x") })
	ln, err := Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Serve(ctx, ln)
	defer s.Close()

	st, _ := os.Stat(sock)
	dst, _ := os.Stat(filepath.Dir(sock))
	if st.Mode().Perm() != 0o600 || dst.Mode().Perm() != 0o700 {
		t.Fatalf("modes %v %v", st.Mode(), dst.Mode())
	}
	if _, err := Listen(sock); err == nil {
		t.Fatal("second listener on a live socket")
	}

	c, err := Dial(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := bufio.NewReader(c)
	call := func(line string) map[string]any {
		t.Helper()
		c.Write([]byte(line + "\n"))
		c.SetReadDeadline(time.Now().Add(5 * time.Second))
		b, err := r.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		json.Unmarshal(b, &m)
		return m
	}
	errCode := func(m map[string]any) (float64, string) {
		e, _ := m["error"].(map[string]any)
		if e == nil {
			return 0, ""
		}
		return e["code"].(float64), e["data"].(map[string]any)["code"].(string)
	}
	if m := call(`{"jsonrpc":"2.0","id":1,"method":"echo","params":{"X":4}}`); m["result"].(map[string]any)["x"] != 4.0 || m["id"] != 1.0 {
		t.Fatalf("echo %v", m)
	}
	cases := map[string][2]any{
		`{"jsonrpc":"2.0","id":2,"method":"echo","params":{"Y":1}}`: {float64(CodeInvalidParams), "validation_failed"},
		`{"jsonrpc":"2.0","id":3,"method":"nope"}`:                  {float64(CodeNoMethod), "not_found"},
		`{"jsonrpc":"2.0","id":4,"method":"fail"}`:                  {float64(CodeApp), "locked"},
		`{"jsonrpc":"2.0","id":5,"method":"boom"}`:                  {float64(CodeApp), "internal"},
		`{"jsonrpc":"2.0","id":6,"method":"panic"}`:                 {float64(CodeApp), "internal"},
		`{not json`:                {float64(CodeParse), "validation_failed"},
		`{"id":7,"method":"echo"}`: {float64(CodeInvalidRequest), "validation_failed"},
	}
	for line, want := range cases {
		code, str := errCode(call(line))
		if code != want[0] || str != want[1] {
			t.Errorf("%s: got %v %v", line, code, str)
		}
	}

	// Notifications get no answer; events reach subscribers only.
	c.Write([]byte(`{"jsonrpc":"2.0","method":"echo","params":{"X":1}}` + "\n"))
	if m := call(`{"jsonrpc":"2.0","id":8,"method":"engine.subscribe"}`); m["id"] != 8.0 {
		t.Fatalf("subscribe answered %v (notification must not be answered)", m)
	}
	other, _ := Dial(sock)
	defer other.Close()
	time.Sleep(50 * time.Millisecond)
	s.Broadcast("status", map[string]string{"state": "up_to_date"})
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	b, err := r.ReadBytes('\n')
	if err != nil || !strings.Contains(string(b), `"method":"event"`) || !strings.Contains(string(b), `"type":"status"`) {
		t.Fatalf("event %s %v", b, err)
	}
	other.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, err := bufio.NewReader(other).ReadBytes('\n'); err == nil {
		t.Fatal("unsubscribed connection got an event")
	}
}

func TestSecretGate(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "run", "engine.sock")
	s := NewServer()
	s.Secret = strings.Repeat("s", 64)
	s.Handle("account.webUnlockKey", func(context.Context, json.RawMessage) (any, error) { return "key", nil })
	s.Handle("engine.info", func(context.Context, json.RawMessage) (any, error) { return "info", nil })
	ln, err := Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Serve(ctx, ln)
	defer s.Close()
	c, err := Dial(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := bufio.NewReader(c)
	call := func(line string) string {
		t.Helper()
		c.Write([]byte(line + "\n"))
		c.SetReadDeadline(time.Now().Add(5 * time.Second))
		b, err := r.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	if got := call(`{"jsonrpc":"2.0","id":1,"method":"account.webUnlockKey"}`); !strings.Contains(got, `"forbidden"`) {
		t.Fatalf("before hello: %s", got)
	}
	if got := call(`{"jsonrpc":"2.0","id":2,"method":"engine.info"}`); !strings.Contains(got, `"info"`) {
		t.Fatalf("engine.info: %s", got)
	}
	if got := call(`{"jsonrpc":"2.0","id":3,"method":"ipc.hello","params":{"secret":"wrong"}}`); !strings.Contains(got, `"forbidden"`) {
		t.Fatalf("wrong secret: %s", got)
	}
	call(`{"jsonrpc":"2.0","id":4,"method":"ipc.hello","params":{"secret":"` + s.Secret + `"}}`)
	if got := call(`{"jsonrpc":"2.0","id":5,"method":"account.webUnlockKey"}`); !strings.Contains(got, `"key"`) {
		t.Fatalf("after hello: %s", got)
	}
}
