package main

import (
	"errors"
	"os"
)

// reExec is not possible on Windows (no exec, and a running .exe cannot be
// replaced); the update applies on the next run.
func reExec() error {
	return errors.New("restart is not supported on Windows")
}

// outputFileMode: Windows has no umask; 0666 only means "not read-only".
func outputFileMode() os.FileMode {
	return 0666
}
