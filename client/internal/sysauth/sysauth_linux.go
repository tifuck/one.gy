//go:build linux

package sysauth

import (
	"context"
	"fmt"

	"github.com/godbus/dbus/v5"
)

// fprintd (net.reactivated.Fprint) on the system bus. Its polkit policy lets
// the user of the active session verify their own fingers.
const (
	fprintBus    = "net.reactivated.Fprint"
	fprintDevice = "net.reactivated.Fprint.Device"
)

type fingerprint struct{}

// Default returns this computer's system check: a fingerprint via fprintd.
func Default() Authenticator { return fingerprint{} }

func (fingerprint) Kind() string { return KindFingerprint }

// device opens the default reader; ok only with fingers enrolled for this user.
func device(ctx context.Context) (*dbus.Conn, dbus.BusObject, error) {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return nil, nil, err
	}
	var path dbus.ObjectPath
	if err := conn.Object(fprintBus, "/net/reactivated/Fprint/Manager").CallWithContext(ctx,
		"net.reactivated.Fprint.Manager.GetDefaultDevice", 0).Store(&path); err != nil {
		conn.Close()
		return nil, nil, ErrUnavailable
	}
	dev := conn.Object(fprintBus, path)
	var fingers []string
	if err := dev.CallWithContext(ctx, fprintDevice+".ListEnrolledFingers", 0, "").Store(&fingers); err != nil || len(fingers) == 0 {
		conn.Close()
		return nil, nil, ErrUnavailable
	}
	return conn, dev, nil
}

func (fingerprint) Available(ctx context.Context) bool {
	conn, _, err := device(ctx)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func (f fingerprint) Enroll(ctx context.Context, name string, hwnd uint64) ([]byte, error) {
	_, err := f.Prove(ctx, name, nil, hwnd)
	return nil, err
}

// Prove waits for one finger on the reader (until ctx ends: ErrCancelled).
// Retry prompts (finger too short, not centred) keep waiting.
func (fingerprint) Prove(ctx context.Context, _ string, _ []byte, _ uint64) ([]byte, error) {
	conn, dev, err := device(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if err := conn.AddMatchSignal(dbus.WithMatchObjectPath(dev.Path()), dbus.WithMatchInterface(fprintDevice),
		dbus.WithMatchMember("VerifyStatus")); err != nil {
		return nil, err
	}
	signals := make(chan *dbus.Signal, 16)
	conn.Signal(signals)
	if err := dev.CallWithContext(ctx, fprintDevice+".Claim", 0, "").Err; err != nil {
		return nil, fmt.Errorf("fingerprint reader busy: %w", err)
	}
	defer dev.Call(fprintDevice+".Release", 0)
	if err := dev.CallWithContext(ctx, fprintDevice+".VerifyStart", 0, "any").Err; err != nil {
		return nil, err
	}
	defer dev.Call(fprintDevice+".VerifyStop", 0)
	for {
		select {
		case <-ctx.Done():
			return nil, ErrCancelled
		case s := <-signals:
			if s == nil || s.Name != fprintDevice+".VerifyStatus" || len(s.Body) < 2 {
				continue
			}
			result, _ := s.Body[0].(string)
			done, _ := s.Body[1].(bool)
			switch {
			case result == "verify-match":
				return nil, nil
			case result == "verify-no-match":
				return nil, ErrNoMatch
			case done:
				return nil, fmt.Errorf("fingerprint reader: %s", result)
			}
		}
	}
}

func (fingerprint) Remove(string) {}
