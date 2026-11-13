package localfs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestRenameFallbackLinux(t *testing.T) {
	dir := t.TempDir()
	a, b, c := filepath.Join(dir, "a"), filepath.Join(dir, "b"), filepath.Join(dir, "c")
	os.WriteFile(a, []byte("a"), 0o644)
	os.WriteFile(b, []byte("b"), 0o644)
	if err := renameNoReplaceFallback(a, b); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("link fallback over existing: %v", err)
	}
	ia, _ := Lstat(a)
	if err := renameNoReplaceFallback(a, c); err != nil {
		t.Fatal(err)
	}
	if ic, _ := Lstat(c); ic.ID != ia.ID {
		t.Fatal("link fallback lost identity")
	}
	if _, err := os.Lstat(a); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("link fallback left the source")
	}
	os.Mkdir(filepath.Join(dir, "d1"), 0o755)
	os.Mkdir(filepath.Join(dir, "d2"), 0o755)
	if err := renameNoReplaceFallback(filepath.Join(dir, "d1"), filepath.Join(dir, "d2")); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("dir fallback over existing: %v", err)
	}
	if err := renameNoReplaceFallback(filepath.Join(dir, "d1"), filepath.Join(dir, "d3")); err != nil {
		t.Fatal(err)
	}
}
