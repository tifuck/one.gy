//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// reExec re-executes the current binary with the same arguments.
func reExec() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not determine executable path: %w", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return fmt.Errorf("could not resolve executable path: %w", err)
	}

	// syscall.Exec replaces the current process
	if err := syscall.Exec(exePath, os.Args, os.Environ()); err != nil {
		return err
	}
	return nil
}

// outputFileMode is 0666 minus the umask, like a file the shell would create.
func outputFileMode() os.FileMode {
	mask := syscall.Umask(0)
	syscall.Umask(mask)
	return os.FileMode(0666 &^ mask)
}
