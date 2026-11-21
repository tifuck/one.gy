// Package sysauth unlocks the app with the operating system's own check
// (sync-api.md "Device security", system unlock):
//   - Windows: Windows Hello. A key in the Microsoft Passport Key Storage
//     Provider signs only after Hello verifies the user (face, fingerprint or
//     the Windows Hello PIN); the server checks the signature.
//   - Linux: a fingerprint through fprintd. A match releases a random token
//     kept in the OS key store, which the server checks like a PIN proof.
package sysauth

import (
	"context"
	"errors"
)

const (
	KindHello       = "hello"
	KindFingerprint = "fingerprint"
)

var (
	ErrUnavailable = errors.New("system unlock is not available on this computer")
	ErrCancelled   = errors.New("system unlock was cancelled")
	ErrNoMatch     = errors.New("fingerprint not recognized")
)

// Authenticator is this computer's system check. hwnd (Windows) parents the
// Hello dialog to the app window; 0 lets Windows place it.
type Authenticator interface {
	Kind() string // KindHello, KindFingerprint or "" (none)
	Available(ctx context.Context) bool
	// Enroll prepares the check for name: Hello creates its key and returns
	// the SubjectPublicKeyInfo (DER); a fingerprint is checked once (nil).
	Enroll(ctx context.Context, name string, hwnd uint64) ([]byte, error)
	// Prove runs the check: Hello signs msg (RSA PKCS#1 v1.5, SHA-256); a
	// fingerprint returns nil after a match, ErrNoMatch after a wrong finger.
	Prove(ctx context.Context, name string, msg []byte, hwnd uint64) ([]byte, error)
	Remove(name string)
}
