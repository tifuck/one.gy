//go:build !windows

package cloudfiles

import "github.com/tifuck/one.gy/client/internal/localfs"

// platformBackend: the Cloud Files API exists on Windows only.
type platformBackend struct{}

func (platformBackend) platform() error                            { return errUnsupported }
func (platformBackend) register(Root) (error, error)               { return nil, errUnsupported }
func (platformBackend) owned(string) bool                          { return false }
func (platformBackend) mark(string, func(localfs.Info) bool) error { return errUnsupported }
func (platformBackend) revert(string) error                        { return errUnsupported }
func (platformBackend) unregister(Root) error                      { return errUnsupported }
