package main

import (
	"fmt"
	"os"
	"os/signal"

	"golang.org/x/sys/unix"
)

// readSecret reads a line without echo from a terminal (prompt on stderr);
// from a pipe it reads the next line, so scripts can pass it on stdin.
func readSecret(prompt string) (string, error) {
	fd := int(os.Stdin.Fd())
	old, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return readLine("")
	}
	noEcho := *old
	noEcho.Lflag &^= unix.ECHO
	if err := unix.IoctlSetTermios(fd, unix.TCSETS, &noEcho); err != nil {
		return "", err
	}
	restore := func() { unix.IoctlSetTermios(fd, unix.TCSETS, old); fmt.Fprintln(os.Stderr) }
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() {
		if _, ok := <-sig; ok {
			restore()
			os.Exit(130)
		}
	}()
	defer func() { signal.Stop(sig); close(sig); restore() }()
	return readLine(prompt)
}
