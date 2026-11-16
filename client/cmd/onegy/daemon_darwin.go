package main

import (
	"errors"
	"fmt"
	"os"
)

// ponytail: the engine's localfs/watch packages have no darwin port yet, so
// macOS builds ship file sharing only.
func runDaemon(args []string) error {
	return errors.New("folder sync is not available on macOS yet")
}

const syncUsage = ""

func runSyncCLI(string, []string) int {
	fmt.Fprintln(os.Stderr, "onegy: folder sync is not available on macOS yet")
	return 1
}
