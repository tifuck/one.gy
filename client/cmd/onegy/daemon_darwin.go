package main

import "errors"

// ponytail: the engine's localfs/watch packages have no darwin port yet, so
// macOS builds ship file sharing only.
func runDaemon(args []string) error {
	return errors.New("folder sync is not available on macOS yet")
}
