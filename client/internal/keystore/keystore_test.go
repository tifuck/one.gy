package keystore

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestFileStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	a := New("/state/f", false)
	a.UseFile(path)
	if !a.Set("secrets", "v1") {
		t.Fatal("not persisted")
	}
	if fi, err := os.Stat(path); err != nil || (runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600) {
		t.Fatalf("secrets file mode: %v %v", fi, err)
	}
	b := New("/state/f", false)
	b.UseFile(path)
	if v, err := b.Get("secrets"); err != nil || v != "v1" {
		t.Fatalf("restart: %q %v", v, err)
	}
	a.SetMemoryOnly(true)
	c := New("/state/f", false)
	c.UseFile(path)
	if _, err := c.Get("secrets"); !errors.Is(err, ErrNotFound) {
		t.Fatal("memory-only switch left the file copy")
	}
	c.Set("secrets", "v2")
	c.Delete("secrets")
	d := New("/state/f", false)
	d.UseFile(path)
	if _, err := d.Get("secrets"); !errors.Is(err, ErrNotFound) {
		t.Fatal("delete left the file copy")
	}
}

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
