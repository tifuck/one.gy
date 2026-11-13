//go:build !linux && !windows

package ipc

import "net"

// checkPeer relies on the 0700 socket directory on non-Linux Unix systems.
func checkPeer(net.Conn) error { return nil }
