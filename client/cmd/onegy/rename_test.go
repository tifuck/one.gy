package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// AUDIT FIX (F8): the fallback used where hard links fail never clobbers.
func TestRenameNoReplaceFallback(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "tmp"), filepath.Join(dir, "out")
	os.WriteFile(src, []byte("new"), 0o600)
	os.WriteFile(dst, []byte("old"), 0o600)
	if err := renameNoReplace(src, dst); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("existing target: %v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "old" {
		t.Fatal("target clobbered")
	}
	os.Remove(dst)
	if err := renameNoReplace(src, dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "new" {
		t.Fatal("not published")
	}
}
