package main

import "testing"

// AUDIT FIX (F2): self-update installs only strictly newer releases.
func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"0.8.3", "0.8.2", true},
		{"0.10.0", "0.9.9", true},
		{"1.0.0", "0.99.99", true},
		{"0.8.2", "0.8.2", false},
		{"0.8.1", "0.8.2", false},
		{"0.8.2", "0.8.2-rc.1", true},
		{"0.8.2-rc.1", "0.8.2", false},
		{"0.8.2-rc.2", "0.8.2-rc.1", true},
		{"0.8.2-rc.10", "0.8.2-rc.9", true},
		{"0.8.2-rc.1.1", "0.8.2-rc.1", true},
		{"", "0.8.2", false},
		{"0.8", "0.8.2", false},
		{"0.8.x", "0.8.2", false},
		{"01.0.0", "0.8.2", false},
		{"9.9.9", "garbage", false},
	} {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
