package service

import (
	"runtime"
	"testing"
)

func TestSystemPathAllowsRemovableDrives(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix paths")
	}
	for p, want := range map[string]bool{"/run/media/alice/USB": false, "/run/media/alice": false, "/run": true, "/run/user/1000": true,
		"/run/media": true, "/etc/x": true} {
		if got := systemPath(p); got != want {
			t.Errorf("systemPath(%q) = %v, want %v", p, got, want)
		}
	}
}
