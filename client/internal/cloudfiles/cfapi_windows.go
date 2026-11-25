//go:build windows

package cloudfiles

import (
	"errors"
	"fmt"
	"io/fs"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/tifuck/one.gy/client/internal/config"
	"github.com/tifuck/one.gy/client/internal/localfs"
)

// The Cloud Files API (cldapi.dll, Windows 10 1709+), loaded lazily so the
// engine still starts where it is missing.
var (
	cldapi                      = windows.NewLazySystemDLL("cldapi.dll")
	procCfGetPlatformInfo       = cldapi.NewProc("CfGetPlatformInfo")
	procCfRegisterSyncRoot      = cldapi.NewProc("CfRegisterSyncRoot")
	procCfUnregisterSyncRoot    = cldapi.NewProc("CfUnregisterSyncRoot")
	procCfGetSyncRootInfoByPath = cldapi.NewProc("CfGetSyncRootInfoByPath")
	procCfConvertToPlaceholder  = cldapi.NewProc("CfConvertToPlaceholder")
	procCfSetInSyncState        = cldapi.NewProc("CfSetInSyncState")
	procCfRevertPlaceholder     = cldapi.NewProc("CfRevertPlaceholder")
)

type platformBackend struct{}

// hresult turns an HRESULT into an error naming the call (never a path).
func hresult(call string, r uintptr) error {
	hr := uint32(r)
	switch {
	case int32(hr) >= 0:
		return nil
	case hr&0xFFFF0000 == 0x80070000: // FACILITY_WIN32
		return fmt.Errorf("%s: %w", call, windows.Errno(hr&0xFFFF))
	}
	return fmt.Errorf("%s: HRESULT %#08x", call, hr)
}

//go:uintptrescapes
func cf(p *windows.LazyProc, args ...uintptr) error {
	if err := p.Find(); err != nil {
		return errUnsupported
	}
	r, _, _ := p.Call(args...)
	return hresult(p.Name, r)
}

func platformInfo() (cfPlatformInfo, error) {
	var pi cfPlatformInfo
	err := cf(procCfGetPlatformInfo, uintptr(unsafe.Pointer(&pi)))
	return pi, err
}

func (platformBackend) platform() error {
	_, err := platformInfo()
	return err
}

func (b platformBackend) register(r Root) (shell, err error) {
	pi, err := platformInfo()
	if err != nil {
		return nil, err
	}
	path, err := windows.UTF16PtrFromString(r.Path)
	if err != nil {
		return nil, err
	}
	shell = registerShell(r)
	name, _ := windows.UTF16PtrFromString(providerName)
	version, _ := windows.UTF16PtrFromString(config.Version)
	ident := []byte("onegy:" + r.ID)
	reg := cfSyncRegistration{ProviderName: name, ProviderVersion: version, SyncRootIdentity: unsafe.Pointer(&ident[0]),
		SyncRootIdentityLength: uint32(len(ident)), ProviderID: providerID}
	reg.StructSize = uint32(unsafe.Sizeof(reg))
	pol := cfSyncPolicies{Hydration: cfPolicy{Primary: cfHydrationAlwaysFull}, Population: cfPolicy{Primary: cfPopulationAlwaysFull}}
	pol.StructSize = uint32(unsafe.Sizeof(pol))
	if pi.IntegrationNumber < 0x310 {
		pol.StructSize = 20 // before PlaceholderManagement
	}
	// UPDATE also registers a new root, and renames one the shell just
	// registered to our provider name.
	err = cf(procCfRegisterSyncRoot, uintptr(unsafe.Pointer(path)), uintptr(unsafe.Pointer(&reg)), uintptr(unsafe.Pointer(&pol)),
		cfRegisterUpdate|cfRegisterMarkRootSync)
	if err == nil && !b.owned(r.Path) {
		err = errors.New("the folder lies in another provider's sync root")
	}
	if err != nil && shell == nil {
		unregisterShell(r)
	}
	return shell, err
}

func (platformBackend) owned(p string) bool {
	path, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return false
	}
	var info cfSyncRootProviderInfo
	var n uint32
	if cf(procCfGetSyncRootInfoByPath, uintptr(unsafe.Pointer(path)), cfSyncRootInfoProvider, uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info), uintptr(unsafe.Pointer(&n))) != nil {
		return false
	}
	return windows.UTF16ToString(info.ProviderName[:]) == providerName
}

// mark and revert open items for their attributes only (no sharing
// conflicts, no reparse point followed); errors never name the file.
func (platformBackend) mark(p string, ok func(localfs.Info) bool) error {
	file, err := localfs.OpenAttributes(p)
	if err != nil {
		return err
	}
	defer file.Close()
	in, err := localfs.Fstat(file)
	if err != nil {
		var pe *fs.PathError
		if errors.As(err, &pe) {
			err = pe.Err
		}
		return err
	}
	if in.Kind != localfs.KindFile && in.Kind != localfs.KindDir {
		return nil
	}
	_, tag, err := localfs.ReparseTag(file)
	if err != nil {
		return err
	}
	placeholder := localfs.IsCloudTag(tag)
	if tag != 0 && !placeholder {
		return nil // another kind of reparse point (dedup, ...): not ours to change
	}
	h := windows.Handle(file.Fd())
	switch {
	case ok(in) && placeholder:
		return cf(procCfSetInSyncState, uintptr(h), 1, 0, 0) // CF_IN_SYNC_STATE_IN_SYNC
	case ok(in):
		return convert(h, in.Kind == localfs.KindFile)
	case placeholder:
		return cf(procCfSetInSyncState, uintptr(h), 0, 0, 0) // CF_IN_SYNC_STATE_NOT_IN_SYNC
	}
	return nil
}

// convert makes h a full placeholder marked in sync (never dehydrated).
func convert(h windows.Handle, file bool) error {
	if !file {
		return cf(procCfConvertToPlaceholder, uintptr(h), 0, 0, cfConvertMarkInSync, 0, 0)
	}
	err := cf(procCfConvertToPlaceholder, uintptr(h), 0, 0, cfConvertMarkInSync|cfConvertAlwaysFull, 0, 0)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		// A platform without ALWAYS_FULL: the root's always-full hydration
		// policy already refuses any dehydration.
		err = cf(procCfConvertToPlaceholder, uintptr(h), 0, 0, cfConvertMarkInSync, 0, 0)
	}
	return err
}

func (platformBackend) revert(p string) error {
	file, err := localfs.OpenAttributes(p)
	if err != nil {
		return err
	}
	defer file.Close()
	_, tag, err := localfs.ReparseTag(file)
	if err != nil || !localfs.IsCloudTag(tag) {
		return err
	}
	return cf(procCfRevertPlaceholder, file.Fd(), 0, 0) // CF_REVERT_FLAG_NONE
}

func (b platformBackend) unregister(r Root) error {
	unregisterShell(r)
	if !b.owned(r.Path) { // the shell unregistered the filter root too
		return nil
	}
	path, err := windows.UTF16PtrFromString(r.Path)
	if err != nil {
		return err
	}
	return cf(procCfUnregisterSyncRoot, uintptr(unsafe.Pointer(path)))
}
