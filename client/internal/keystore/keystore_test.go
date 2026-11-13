package keystore

import (
	"errors"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestStore(t *testing.T) {
	keyring.MockInit()
	a := New("/state/a", false)
	if !a.Set("secrets", "v1") {
		t.Fatal("not persisted")
	}
	if v, err := New("/state/a", false).Get("secrets"); err != nil || v != "v1" {
		t.Fatalf("restart: %q %v", v, err)
	}
	if _, err := New("/state/b", false).Get("secrets"); !errors.Is(err, ErrNotFound) {
		t.Fatal("state dirs share secrets")
	}
	if _, err := New("/state/a", true).Get("secrets"); !errors.Is(err, ErrNotFound) {
		t.Fatal("memory-only store read the key store")
	}
	m := New("/state/c", true)
	if m.Set("secrets", "v2") {
		t.Fatal("memory-only store persisted")
	}
	if v, _ := m.Get("secrets"); v != "v2" {
		t.Fatal("memory copy missing")
	}
	a.SetMemoryOnly(true)
	if _, err := New("/state/a", false).Get("secrets"); !errors.Is(err, ErrNotFound) {
		t.Fatal("memory-only switch left the key-store copy")
	}
	m.Delete("secrets")
	if _, err := m.Get("secrets"); !errors.Is(err, ErrNotFound) {
		t.Fatal("delete")
	}
}
