package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/keystore"
	"onegy/e2ee"
)

func TestPinLockAndStrictRestart(t *testing.T) {
	ctx := context.Background()
	m, srv, db, dir := setup(t, false)
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "PC"}); err != nil {
		t.Fatal(err)
	}
	if !m.AppUnlocked() {
		t.Fatal("authorize should leave the app unlocked for the PIN step")
	}
	if err := m.SetPin(ctx, "123", false); err == nil {
		t.Fatal("short PIN accepted")
	}
	if err := m.SetPin(ctx, "246810", false); err != nil {
		t.Fatal(err)
	}
	if ticket, err := m.WebSession(ctx); err != nil || ticket == "" {
		t.Fatalf("web session: %q %v", ticket, err)
	}

	m.AppLock(ctx)
	if m.AppUnlocked() {
		t.Fatal("still unlocked after AppLock")
	}
	if _, err := m.MasterKey(); !errors.Is(err, ErrNeedsUnlock) {
		t.Fatalf("app lock must wipe the master key: %v", err)
	}
	if _, err := m.Client(); err != nil || !m.KeysOpen() {
		t.Fatal("app lock must keep the sync keys (sync continues)")
	}
	if _, err := m.WebSession(ctx); !errors.Is(err, ErrAppLocked) {
		t.Fatalf("web session while locked: %v", err)
	}
	if err := m.AppUnlock(ctx, "000000"); !api.IsCode(err, "invalid_pin") || m.Status(ctx).PinAttemptsLeft != 4 {
		t.Fatalf("wrong PIN: %v", err)
	}
	if err := m.AppUnlock(ctx, "246810"); err != nil || !m.AppUnlocked() {
		t.Fatalf("PIN unlock: %v", err)
	}
	if key, err := m.MasterKey(); err != nil || !bytes.Equal(key, srv.MasterKey()) {
		t.Fatalf("PIN unlock must bring the master key back: %v", err)
	}

	// Strict: after a restart the share needs the PIN, and so does the at-rest key.
	if err := m.SetPin(ctx, "246810", true); err != nil {
		t.Fatal(err)
	}
	m2 := New(db, keystore.New(dir, false), api.Options{Version: "0.1.0", Transport: srv.Client().Transport})
	if err := m2.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if err := m2.AutoUnlock(ctx); !errors.Is(err, ErrLocked) {
		t.Fatalf("strict auto-unlock: %v", err)
	}
	if st := m2.Status(ctx); !st.PinSet || !st.LockEnabled || !st.Locked {
		t.Fatalf("the lock screen must know a PIN is set: %+v", st)
	}
	if err := m2.AppUnlock(ctx, "246810"); err != nil {
		t.Fatal(err)
	}
	if key, err := m2.MasterKey(); err != nil || !bytes.Equal(key, srv.MasterKey()) {
		t.Fatalf("strict PIN unlock key: %v", err)
	}
	if st := m2.Status(ctx); st.Locked || st.AppLocked || !st.PinStrict {
		t.Fatalf("status %+v", st)
	}
}

func TestAtRestKeyNeedsTheServerShare(t *testing.T) {
	ctx := context.Background()
	m, srv, db, dir := setup(t, false)
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "PC"}); err != nil {
		t.Fatal(err)
	}
	srv.RevokeAll()
	m2 := New(db, keystore.New(dir, false), api.Options{Version: "0.1.0", Transport: srv.Client().Transport})
	if err := m2.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if err := m2.AutoUnlock(ctx); err == nil {
		t.Fatal("removed device opened its keys")
	}
	if _, err := m2.MasterKey(); err == nil {
		t.Fatal("master key without the server share")
	}
}

func TestLegacyDeviceMigrates(t *testing.T) {
	ctx := context.Background()
	m, srv, db, dir := setup(t, false)
	// A device from before device security: token + master key in the key
	// store, no signing key, no at-rest copy.
	token := srv.DeviceToken()
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "PC"}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetAtRest(ctx, "", "", false); err != nil {
		t.Fatal(err)
	}
	legacy, _ := json.Marshal(secrets{DeviceToken: token, MasterKey: e2ee.EncodeBase64(srv.MasterKey())})
	ks := keystore.New(dir, false)
	ks.Set(secretsName, string(legacy))

	m2 := New(db, ks, api.Options{Version: "0.1.0", Transport: srv.Client().Transport})
	if err := m2.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := m2.MasterKey(); err != nil {
		t.Fatal("legacy key store must still unlock")
	}
	if err := m2.AutoUnlock(ctx); err != nil {
		t.Fatal(err)
	}
	after, _ := db.GetAccount(ctx)
	raw, _ := ks.Get(secretsName)
	var s secrets
	json.Unmarshal([]byte(raw), &s)
	if after.AtRestSealed == "" || s.MasterKey != "" || s.PopKey == "" || s.LocalKey == "" {
		t.Fatalf("not migrated: sealed=%v secrets=%+v", after.AtRestSealed != "", s)
	}
	if srv.SignedDevices() != 2 {
		t.Fatalf("legacy device did not enroll a signing key (%d)", srv.SignedDevices())
	}
}

func TestRemovePinReseals(t *testing.T) {
	ctx := context.Background()
	m, srv, db, dir := setup(t, false)
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "PC"}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetPin(ctx, "246810", true); err != nil {
		t.Fatal(err)
	}
	if err := m.RemovePin(ctx); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(ctx); st.PinSet || !st.LockEnabled {
		t.Fatalf("status %+v", st)
	}
	// Without the PIN the share alone opens the keys again after a restart.
	m2 := New(db, keystore.New(dir, false), api.Options{Version: "0.1.0", Transport: srv.Client().Transport})
	m2.Load(ctx)
	if err := m2.AutoUnlock(ctx); err != nil {
		t.Fatalf("auto-unlock after removing a strict PIN: %v", err)
	}
	if err := m2.AppUnlock(ctx, "246810"); !api.IsCode(err, "pin_locked") && !api.IsCode(err, "pin_not_set") {
		t.Fatalf("removed PIN still works: %v", err)
	}
	if err := m2.Unlock(ctx, password); err != nil || !m2.AppUnlocked() {
		t.Fatalf("password unlock: %v", err)
	}
}

func TestKeyPoolWhileLocked(t *testing.T) {
	ctx := context.Background()
	m, srv, db, _ := setup(t, false)
	if err := m.Authorize(ctx, AuthorizeParams{Server: srv.URL, Username: "alice", Password: password, DeviceName: "PC"}); err != nil {
		t.Fatal(err)
	}
	if err := m.FillPool(ctx); err != nil {
		t.Fatal(err)
	}
	if n, _ := db.PoolCount(ctx); n != poolTarget {
		t.Fatalf("pool %d", n)
	}
	m.AppLock(ctx)
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		k, err := m.NewKey(ctx)
		if err != nil {
			t.Fatal(err)
		}
		// The website opens it with the master key, like any key.
		if got, err := e2ee.UnwrapKeyB64(k.Wrap, k.Nonce, srv.MasterKey()); err != nil || !bytes.Equal(got, k.Key) {
			t.Fatalf("pooled key does not match its master-key wrap: %v", err)
		}
		if seen[string(k.Key)] {
			t.Fatal("a pooled key was handed out twice")
		}
		seen[string(k.Key)] = true
	}
	if n, _ := db.PoolCount(ctx); n != poolTarget-3 {
		t.Fatalf("pool after use %d", n)
	}
	if err := m.FillPool(ctx); err != nil { // locked: no master key, no refill
		t.Fatal(err)
	}
	db.PoolClear(ctx)
	if _, err := m.NewKey(ctx); !errors.Is(err, ErrNeedsUnlock) {
		t.Fatalf("empty pool: %v", err)
	}
}
