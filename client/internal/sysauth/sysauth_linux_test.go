//go:build linux

package sysauth

import (
	"context"
	"testing"
	"time"
)

// Without fprintd or an enrolled finger (CI, servers) the check is simply
// unavailable, quickly, and proving fails with ErrUnavailable.
func TestFingerprintUnavailableWithoutReader(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if Default().Available(ctx) {
		t.Skip("this machine has a fingerprint reader with enrolled fingers")
	}
	if _, err := Default().Prove(ctx, "x", nil, 0); err != ErrUnavailable {
		t.Fatalf("prove without a reader: %v", err)
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("availability check is slow")
	}
}
