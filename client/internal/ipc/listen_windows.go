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

// Dial connects to an engine pipe whose server process runs as the current
// user: another user could create the pipe name first (squatting).
func Dial(path string) (net.Conn, error) {
	timeout := 5 * time.Second
	c, err := winio.DialPipe(path, &timeout)
	if err != nil {
		return nil, err
	}
	if err := checkServerOwner(c); err != nil {
		c.Close()
		return nil, fmt.Errorf("refusing %s: %w", path, err)
	}
	return c, nil
}

func checkServerOwner(c net.Conn) error {
	f, ok := c.(interface{ Fd() uintptr })
	if !ok {
		return fmt.Errorf("not a pipe connection")
	}
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(windows.Handle(f.Fd()), &pid); err != nil {
		return fmt.Errorf("pipe server process: %w", err)
	}
	p, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return fmt.Errorf("pipe server process: %w", err)
	}
	defer windows.CloseHandle(p)
	var tok windows.Token
	if err := windows.OpenProcessToken(p, windows.TOKEN_QUERY, &tok); err != nil {
		return fmt.Errorf("pipe server token: %w", err)
	}
	defer tok.Close()
	owner, err := tok.GetTokenUser()
	if err != nil {
		return err
	}
	me, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	if !windows.EqualSid(owner.User.Sid, me.User.Sid) {
		return fmt.Errorf("the pipe server runs as another user")
	}
	return nil
}

// checkPeer: the pipe DACL already admits only the current user.
func checkPeer(net.Conn) error { return nil }
