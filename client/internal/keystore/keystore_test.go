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
	if err := a.Set("secrets", "v1"); err != nil {
		t.Fatal(err)
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
	if err := a.Set("secrets", "v1"); err != nil {
		t.Fatal(err)
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
	if err := m.Set("secrets", "v2"); err != nil {
		t.Fatal(err)
	}
	if _, err := New("/state/c", false).Get("secrets"); !errors.Is(err, ErrNotFound) {
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

// A corrupt secrets file makes Set fail (reported, not swallowed) and is
// left as it is rather than overwritten.
func TestSetCorruptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	corrupt := []byte(`{"secrets":"token-and-key"`)
	os.WriteFile(path, corrupt, 0o600)
	s := New("/state/y", false)
	s.UseFile(path)
	if err := s.Set("secrets", "v"); err == nil {
		t.Fatal("save into a corrupt secrets file not reported")
	}
	if b, _ := os.ReadFile(path); string(b) != string(corrupt) {
		t.Fatalf("corrupt secrets file overwritten: %q", b)
	}
	if v, err := s.Get("secrets"); err != nil || v != "v" {
		t.Fatalf("memory copy: %q %v", v, err)
	}
}

// AUDIT FIX (F6): Delete on a corrupt secrets file removes the file and
// reports write failures instead of leaving the secrets behind.
func TestDeleteCorruptAndFailing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secrets.json")
	s := New("/state/x", false)
	s.UseFile(path)
	os.WriteFile(path, []byte(`{"secrets":"token-and-key"`), 0o600) // truncated
	if err := s.Delete("secrets"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("corrupt secrets file left on disk")
	}
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		return // directory permissions do not stop root (or Windows)
	}
	s.Set("secrets", "v")
	os.Chmod(dir, 0o500)
	defer os.Chmod(dir, 0o700)
	if err := s.Delete("secrets"); err == nil {
		t.Fatal("failed delete not reported")
	}
}
