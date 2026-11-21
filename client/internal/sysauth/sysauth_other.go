//go:build !windows && !linux

package sysauth

import "context"

type none struct{}

// Default returns this computer's system check (none on this platform).
func Default() Authenticator { return none{} }

func (none) Kind() string                   { return "" }
func (none) Available(context.Context) bool { return false }
func (none) Enroll(context.Context, string, uint64) ([]byte, error) {
	return nil, ErrUnavailable
}
func (none) Prove(context.Context, string, []byte, uint64) ([]byte, error) {
	return nil, ErrUnavailable
}
func (none) Remove(string) {}
