//go:build !windows

package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AUDIT FIX (F1): a non-empty home folder cannot become a mirror or take
// one.gy as the first-run source; other syncs of it only warn.
func TestHomeFolderGuard(t *testing.T) {
	rc, _, _ := start(t)
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, ".bashrc"), []byte("x"), 0o644)
	t.Setenv("HOME", home)
	codes := func(params map[string]any) string {
		v := rc.ok("syncs.validate", params)
		return strings.Join(errCodesFrom(v), ",")
	}
	if c := codes(map[string]any{"local_path": home, "type": "mirror"}); !strings.Contains(c, "home_dir") {
		t.Fatalf("mirror of home: errors %q", c)
	}
	if c := codes(map[string]any{"local_path": home, "type": "two_way", "initial": "remote_source"}); !strings.Contains(c, "home_dir") {
		t.Fatalf("remote_source on home: errors %q", c)
	}
	if c := codes(map[string]any{"local_path": home, "type": "two_way"}); strings.Contains(c, "home_dir") {
		t.Fatalf("two_way merge on home is only a warning: errors %q", c)
	}
}
