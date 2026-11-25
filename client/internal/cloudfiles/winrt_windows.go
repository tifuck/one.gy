//go:build windows

package cloudfiles

import (
	"errors"
	"os"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/tifuck/one.gy/client/internal/config"
)

// Explorer shows a sync root (navigation pane entry, Status column) only
// when it is registered with the shell: the WinRT
// StorageProviderSyncRootManager.Register, which writes the
// SyncRootManager registration as a system broker (no elevation) and also
// registers the root with the cloud filter. It is called here without cgo:
// combase activation plus vtable calls. Windows may refuse it for an
// unpackaged app (APPMODEL_ERROR_NO_PACKAGE); the cloud filter
// registration then stands alone.

var (
	combase                    = windows.NewLazySystemDLL("combase.dll")
	procRoInitialize           = combase.NewProc("RoInitialize")
	procRoUninitialize         = combase.NewProc("RoUninitialize")
	procRoActivateInstance     = combase.NewProc("RoActivateInstance")
	procRoGetActivationFactory = combase.NewProc("RoGetActivationFactory")
	procWindowsCreateString    = combase.NewProc("WindowsCreateString")
	procWindowsDeleteString    = combase.NewProc("WindowsDeleteString")
)

// Interface ids (windows.storage.provider.idl, windows.storage.idl,
// asyncinfo.idl).
var (
	iidSyncRootInfo           = windows.GUID{Data1: 0x7c1305c4, Data2: 0x99f9, Data3: 0x41ac, Data4: [8]byte{0x89, 0x04, 0xab, 0x05, 0x5d, 0x65, 0x49, 0x26}}
	iidSyncRootManagerStatics = windows.GUID{Data1: 0x3e99fbbf, Data2: 0x8fe3, Data3: 0x4b40, Data4: [8]byte{0xab, 0xc7, 0xf6, 0xfc, 0x3d, 0x74, 0xc9, 0x8e}}
	iidStorageFolderStatics   = windows.GUID{Data1: 0x08f327ff, Data2: 0x85d5, Data3: 0x48b9, Data4: [8]byte{0xae, 0xe9, 0x28, 0x51, 0x1e, 0x33, 0x9f, 0x9f}}
	iidAsyncInfo              = windows.GUID{Data1: 0x00000036, Data2: 0x0000, Data3: 0x0000, Data4: [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}
)

// Vtable slots: IUnknown 0-2, IInspectable 3-5, then the interface's
// methods in IDL order (a property is get, then put).
const (
	slotQueryInterface = 0
	slotRelease        = 2

	// IStorageProviderSyncRootInfo
	slotPutID                = 7
	slotPutPath              = 11
	slotPutDisplayName       = 13
	slotPutIcon              = 15
	slotPutHydration         = 17
	slotPutHydrationModifier = 19
	slotPutPopulation        = 21
	slotPutInSync            = 23
	slotPutHardlink          = 25
	slotPutVersion           = 29

	// IStorageProviderSyncRootManagerStatics
	slotRegister   = 6
	slotUnregister = 7

	// IStorageFolderStatics
	slotGetFolderFromPathAsync = 6

	// IAsyncInfo / IAsyncOperation<StorageFolder>
	slotAsyncStatus    = 7
	slotAsyncErrorCode = 8
	slotGetResults     = 8
)

// StorageProvider enums (WinRT numbering, not cfapi's).
const (
	spHydrationAlwaysFull  = 3
	spPopulationAlwaysFull = 2
)

// com is a COM/WinRT interface pointer.
type com struct{ vtbl *[64]uintptr }

//go:uintptrescapes
func (c *com) call(slot int, args ...uintptr) error {
	r, _, _ := syscall.SyscallN(c.vtbl[slot], append([]uintptr{uintptr(unsafe.Pointer(c))}, args...)...)
	return hresult("winrt", r)
}

func (c *com) release() {
	if c != nil {
		syscall.SyscallN(c.vtbl[slotRelease], uintptr(unsafe.Pointer(c)))
	}
}

type hstring uintptr

func newHString(s string) (hstring, error) {
	u, err := windows.UTF16FromString(s)
	if err != nil {
		return 0, err
	}
	var h hstring
	r, _, _ := procWindowsCreateString.Call(uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)-1), uintptr(unsafe.Pointer(&h)))
	return h, hresult("WindowsCreateString", r)
}

func (h hstring) free() {
	if h != 0 {
		procWindowsDeleteString.Call(uintptr(h))
	}
}

// winrt runs fn on one OS thread in the multithreaded apartment.
func winrt(fn func() error) error {
	for _, p := range []*windows.LazyProc{procRoInitialize, procRoUninitialize, procRoActivateInstance, procRoGetActivationFactory,
		procWindowsCreateString, procWindowsDeleteString} {
		if err := p.Find(); err != nil {
			return errUnsupported
		}
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	r, _, _ := procRoInitialize.Call(1) // RO_INIT_MULTITHREADED
	switch uint32(r) {
	case 0, 1: // S_OK, S_FALSE
		defer procRoUninitialize.Call()
	case 0x80010106: // RPC_E_CHANGED_MODE: this thread already has an apartment
	default:
		return hresult("RoInitialize", r)
	}
	return fn()
}

func activate(class string, iid *windows.GUID) (*com, error) {
	h, err := newHString(class)
	if err != nil {
		return nil, err
	}
	defer h.free()
	var insp *com
	r, _, _ := procRoActivateInstance.Call(uintptr(h), uintptr(unsafe.Pointer(&insp)))
	if err := hresult("RoActivateInstance", r); err != nil {
		return nil, err
	}
	defer insp.release()
	var out *com
	return out, insp.call(slotQueryInterface, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))
}

func factory(class string, iid *windows.GUID) (*com, error) {
	h, err := newHString(class)
	if err != nil {
		return nil, err
	}
	defer h.free()
	var out *com
	r, _, _ := procRoGetActivationFactory.Call(uintptr(h), uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))
	return out, hresult("RoGetActivationFactory", r)
}

// folderFromPath is StorageFolder.GetFolderFromPathAsync(p), waited for.
func folderFromPath(p string) (*com, error) {
	statics, err := factory("Windows.Storage.StorageFolder", &iidStorageFolderStatics)
	if err != nil {
		return nil, err
	}
	defer statics.release()
	hp, err := newHString(p)
	if err != nil {
		return nil, err
	}
	defer hp.free()
	var op, info *com
	if err := statics.call(slotGetFolderFromPathAsync, uintptr(hp), uintptr(unsafe.Pointer(&op))); err != nil {
		return nil, err
	}
	defer op.release()
	if err := op.call(slotQueryInterface, uintptr(unsafe.Pointer(&iidAsyncInfo)), uintptr(unsafe.Pointer(&info))); err != nil {
		return nil, err
	}
	defer info.release()
	var status int32 // AsyncStatus: 0 started, 1 completed, 2 canceled, 3 error
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if err := info.call(slotAsyncStatus, uintptr(unsafe.Pointer(&status))); err != nil {
			return nil, err
		}
		if status != 0 {
			break
		}
		if time.Now().After(deadline) {
			return nil, errors.New("GetFolderFromPathAsync: timed out")
		}
	}
	if status != 1 {
		var code int32
		info.call(slotAsyncErrorCode, uintptr(unsafe.Pointer(&code)))
		if err := hresult("GetFolderFromPathAsync", uintptr(uint32(code))); err != nil {
			return nil, err
		}
		return nil, errors.New("GetFolderFromPathAsync: canceled")
	}
	var folder *com
	return folder, op.call(slotGetResults, uintptr(unsafe.Pointer(&folder)))
}

// shellID is the sync root id Explorer expects: provider!user SID!account.
func shellID(syncID string) (string, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return "ONEGY!" + u.User.Sid.String() + "!" + syncID, nil
}

func registerShell(r Root) error {
	id, err := shellID(r.ID)
	if err != nil {
		return err
	}
	icon := ""
	if exe, err := os.Executable(); err == nil {
		icon = exe + ",0"
	}
	return winrt(func() error {
		info, err := activate("Windows.Storage.Provider.StorageProviderSyncRootInfo", &iidSyncRootInfo)
		if err != nil {
			return err
		}
		defer info.release()
		folder, err := folderFromPath(r.Path)
		if err != nil {
			return err
		}
		defer folder.release()
		strs := map[int]string{slotPutID: id, slotPutDisplayName: "ONE.GY - " + r.Name, slotPutIcon: icon, slotPutVersion: config.Version}
		for _, slot := range []int{slotPutID, slotPutDisplayName, slotPutIcon, slotPutVersion} {
			h, err := newHString(strs[slot])
			if err == nil {
				err = info.call(slot, uintptr(h))
				h.free()
			}
			if err != nil {
				return err
			}
		}
		for _, s := range [][2]uintptr{{slotPutPath, uintptr(unsafe.Pointer(folder))}, {slotPutHydration, spHydrationAlwaysFull},
			{slotPutHydrationModifier, 0}, {slotPutPopulation, spPopulationAlwaysFull}, {slotPutInSync, 0}, {slotPutHardlink, 0}} {
			if err := info.call(int(s[0]), s[1]); err != nil {
				return err
			}
		}
		mgr, err := factory("Windows.Storage.Provider.StorageProviderSyncRootManager", &iidSyncRootManagerStatics)
		if err != nil {
			return err
		}
		defer mgr.release()
		return mgr.call(slotRegister, uintptr(unsafe.Pointer(info)))
	})
}

func unregisterShell(r Root) error {
	id, err := shellID(r.ID)
	if err != nil {
		return err
	}
	return winrt(func() error {
		mgr, err := factory("Windows.Storage.Provider.StorageProviderSyncRootManager", &iidSyncRootManagerStatics)
		if err != nil {
			return err
		}
		defer mgr.release()
		h, err := newHString(id)
		if err != nil {
			return err
		}
		defer h.free()
		return mgr.call(slotUnregister, uintptr(h))
	})
}
