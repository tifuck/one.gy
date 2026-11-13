//go:build !windows

package config

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// Lock takes the single-instance lock <state>/engine.lock. The OS drops it
// when the process dies, so a crash never leaves a stale lock.
func Lock(stateDir string) (release func(), err error) {
	f, err := os.OpenFile(filepath.Join(stateDir, "engine.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("another engine is already running for %s", stateDir)
	}
	return func() { f.Close() }, nil
}
