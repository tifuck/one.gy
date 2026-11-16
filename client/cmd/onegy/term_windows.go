package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// readSecret reads a line without echo from the console (prompt on stderr);
// from a pipe it reads the next line, so scripts can pass it on stdin.
func readSecret(prompt string) (string, error) {
	h := windows.Handle(os.Stdin.Fd())
	var mode uint32
	if windows.GetConsoleMode(h, &mode) != nil {
		return readLine("")
	}
	if err := windows.SetConsoleMode(h, mode&^windows.ENABLE_ECHO_INPUT); err != nil {
		return "", err
	}
	defer func() { windows.SetConsoleMode(h, mode); fmt.Fprintln(os.Stderr) }()
	return readLine(prompt)
}
