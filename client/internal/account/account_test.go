package account

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
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

func TestValidPin(t *testing.T) {
	for _, pin := range []string{"k7x2", "Ab3dEf9h", "8r4n2q7w1z", "4f8a1c9e2b7d3x6y"} {
		if ValidPin(pin) != nil {
			t.Errorf("%q refused", pin)
		}
	}
	for _, pin := range []string{"", "123", "0123456789abcdefg", "12 34", "12-34", "pässwort",
		"1234", "4321", "abcd", "DCBA", "0000", "1212", "abab", "123123", "Password", "2580", "1004"} {
		if ValidPin(pin) == nil {
			t.Errorf("%q accepted", pin)
		}
	}
}

// stalled answers no request until it is cancelled, like a server that went quiet.
type stalled struct{ requests int }

func (s *stalled) RoundTrip(r *http.Request) (*http.Response, error) {
	s.requests++
	<-r.Context().Done()
	return nil, r.Context().Err()
}

// account.status must answer while the server does not: one bounded /me, and
// none again right after one that got no answer.
func TestStatusWhileTheServerStalls(t *testing.T) {
	ctx := context.Background()
	m, srv, _, _ := setup(t, false)
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "PC"}); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(ctx); st.StorageLimit != 1000 {
		t.Fatalf("status %+v", st)
	}
	quiet := &stalled{}
	if err := m.SetOptions(api.Options{Version: "0.1.0", Transport: quiet}); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.meAt = time.Time{}
	m.mu.Unlock()

	short, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	if st := m.Status(short); !st.SignedIn || st.StorageLimit != 1000 {
		t.Fatalf("status without an answer must keep the last numbers: %+v", st)
	}
	began := time.Now()
	if st := m.Status(ctx); !st.SignedIn || quiet.requests != 1 || time.Since(began) > time.Second {
		t.Fatalf("status right after a /me without an answer asked again: %d requests in %v", quiet.requests, time.Since(began))
	}
}

// The engine drops its grant when it stops: the server then refuses what the grant allowed.
func TestDropGrant(t *testing.T) {
	ctx := context.Background()
	m, srv, _, _ := setup(t, false)
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "PC"}); err != nil {
		t.Fatal(err)
	}
	if srv.Grants() != 1 {
		t.Fatal("authorize leaves the app unlocked")
	}
	m.DropGrant(ctx)
	if srv.Grants() != 0 {
		t.Fatal("the grant outlived DropGrant")
	}
	if _, err := m.WebSession(ctx); !api.IsCode(err, "grant_required") {
		t.Fatalf("web session after the grant was dropped: %v", err)
	}
}

// A sign-in that fails after the server created the device removes that
// device again and leaves this computer signed out.
func TestAuthorizeFailureAfterDeviceCreated(t *testing.T) {
	ctx := context.Background()
	m, srv, db, _ := setup(t, false)
	db.Close() // the account row cannot be saved
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "LAPTOP"}); err == nil {
		t.Fatal("sign-in succeeded without its account row")
	}
	if srv.Requests["DELETE /apiv1/devices/self"] != 1 {
		t.Fatal("half-authorized device left on the server")
	}
	if _, err := m.Client(); !errors.Is(err, ErrNotSignedIn) {
		t.Fatalf("after a failed sign-in: %v", err)
	}
	if _, err := m.MasterKey(); !errors.Is(err, ErrNotSignedIn) {
		t.Fatalf("master key kept after a failed sign-in: %v", err)
	}
}

// A key store that cannot be written does not fail the sign-in (the
// password-sealed copy opens the keys after a restart) but shows in status.
func TestKeyStoreErrorInStatus(t *testing.T) {
	ctx := context.Background()
	_, srv, db, dir := setup(t, false)
	path := filepath.Join(dir, "secrets.json")
	os.WriteFile(path, []byte(`{"secrets":`), 0o600) // corrupt
	ks := keystore.New(dir, false)
	ks.UseFile(path)
	m := New(db, ks, api.Options{Version: "0.1.0", Transport: srv.Client().Transport})
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "LAPTOP"}); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(ctx); !st.SignedIn || st.KeyStoreError == "" {
		t.Fatalf("key store failure not shown: %+v", st)
	}
	os.Remove(path)
	if err := m.PersistSecrets(); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(ctx); st.KeyStoreError != "" {
		t.Fatalf("key store error kept after a good write: %q", st.KeyStoreError)
	}
}
