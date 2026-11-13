//go:build windows

package ipc

import (
	"fmt"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// Listen creates the named pipe with a DACL granting only the current user
// (protected, so nothing is inherited).
func Listen(path string) (net.Listener, error) {
	tok := windows.GetCurrentProcessToken()
	user, err := tok.GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("current user: %w", err)
	}
	sddl := "D:P(A;;GA;;;" + user.User.Sid.String() + ")"
	return winio.ListenPipe(path, &winio.PipeConfig{SecurityDescriptor: sddl, InputBufferSize: 64 << 10, OutputBufferSize: 64 << 10})
}

// Dial connects to an engine pipe.
func Dial(path string) (net.Conn, error) {
	timeout := 5 * time.Second
	return winio.DialPipe(path, &timeout)
}

// checkPeer: the pipe DACL already admits only the current user.
func checkPeer(net.Conn) error { return nil }
