//go:build !windows

package devkey

import "errors"

// ponytail: no TPM path on Linux; /dev/tpmrm0 usually needs the tss group, so
// the software key in the key store is used. Add go-tpm when that changes.
func newHardware(string) (Key, error)  { return nil, errors.New("no TPM support on this platform") }
func openHardware(string) (Key, error) { return nil, errors.New("no TPM support on this platform") }
func deleteHardware(string)            {}
