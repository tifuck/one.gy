package account

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/fakeserver"
	"github.com/tifuck/one.gy/client/internal/keystore"
	"github.com/tifuck/one.gy/client/internal/state"
	"github.com/zalando/go-keyring"
)

const password = "correct horse battery staple"

func setup(t *testing.T, memoryOnly bool) (*Manager, *fakeserver.Server, *state.DB, string) {
	t.Helper()
	keyring.MockInit()
	dir := t.TempDir()
	db, err := state.Open(filepath.Join(dir, "engine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	srv := fakeserver.New(t, "alice", password)
	m := New(db, keystore.New(dir, memoryOnly), api.Options{Version: "0.1.0", Transport: srv.Client().Transport})
	return m, srv, db, dir
}

func TestAuthorizeRestartUnlockSignOut(t *testing.T) {
	ctx := context.Background()
	m, srv, db, dir := setup(t, false)

	err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: "wrong", DeviceName: "LAPTOP"})
	if !api.IsCode(err, "invalid_credentials") {
		t.Fatalf("wrong password: %v", err)
	}
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "LAPTOP"}); err != nil {
		t.Fatal(err)
	}
	key, err := m.MasterKey()
	if err != nil || !bytes.Equal(key, srv.MasterKey()) {
		t.Fatalf("master key: %v", err)
	}
	if st := m.Status(ctx); !st.SignedIn || st.Locked || st.DeviceName != "LAPTOP" || st.StorageLimit != 1000 {
		t.Fatalf("status %+v", st)
	}
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "X"}); !errors.Is(err, ErrAlreadySignedIn) {
		t.Fatal(err)
	}

	// Restart with the key store intact: unlocked as soon as the server's
	// share opens the at-rest key; the key store never holds the master key.
	m2 := New(db, keystore.New(dir, false), api.Options{Version: "0.1.0", Transport: srv.Client().Transport})
	if err := m2.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := m2.Client(); !errors.Is(err, ErrLocked) {
		t.Fatalf("before auto-unlock: %v", err)
	}
	if err := m2.AutoUnlock(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := m2.Client(); err != nil {
		t.Fatalf("restart with key store: %v", err)
	}
	if raw, _ := keystore.New(dir, false).Get(secretsName); strings.Contains(raw, "master_key") {
		t.Fatal("master key in the key store")
	}
	if srv.SignedDevices() != 1 || !m2.Status(ctx).SignedRequests {
		t.Fatal("device does not sign its requests")
	}

	// Restart in memory-only mode: locked until the password is given.
	m3 := New(db, keystore.New(dir, true), api.Options{Version: "0.1.0", Transport: srv.Client().Transport})
	m3.Load(ctx)
	if _, err := m3.MasterKey(); !errors.Is(err, ErrLocked) {
		t.Fatalf("memory-only start: %v", err)
	}
	if err := m3.Unlock(ctx, "nope"); !errors.Is(err, ErrWrongPassword) {
		t.Fatal(err)
	}
	if err := m3.Unlock(ctx, password); err != nil {
		t.Fatal(err)
	}
	if key, _ := m3.MasterKey(); !bytes.Equal(key, srv.MasterKey()) {
		t.Fatal("unlock gave a different key")
	}
	if c, _ := m3.Client(); c == nil {
		t.Fatal("no client after unlock")
	} else if _, err := c.Me(ctx); err != nil {
		t.Fatalf("device token after unlock: %v", err)
	}

	if err := m3.SignOut(ctx, true); err != nil {
		t.Fatal(err)
	}
	if srv.Requests["DELETE /apiv1/devices/self"] != 1 {
		t.Fatal("device not deleted on the server")
	}
	if _, err := m3.Client(); !errors.Is(err, ErrNotSignedIn) {
		t.Fatal(err)
	}
	a, _ := db.GetAccount(ctx)
	if a.SignedIn || a.SealedSecrets != "" || a.Username != "alice" {
		t.Fatalf("account after sign-out %+v", a)
	}
	if _, err := keystore.New(dir, false).Get(secretsName); !errors.Is(err, keystore.ErrNotFound) {
		t.Fatal("key store not wiped")
	}
}

func TestRevokedWipesKeys(t *testing.T) {
	ctx := context.Background()
	m, srv, _, _ := setup(t, false)
	revoked := make(chan struct{}, 1)
	m.OnRevoked = func() { revoked <- struct{}{} }
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "PC"}); err != nil {
		t.Fatal(err)
	}
	c, _ := m.Client()
	srv.RevokeAll()
	if _, err := c.Me(ctx); !api.IsCode(err, "device_revoked") {
		t.Fatal(err)
	}
	select {
	case <-revoked:
	case <-time.After(2 * time.Second):
		t.Fatal("OnRevoked not called")
	}
	if _, err := m.MasterKey(); !errors.Is(err, ErrNotSignedIn) {
		t.Fatal("keys survived revocation")
	}
}
