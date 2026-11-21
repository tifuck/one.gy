//go:build windows

package sysauth

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows Hello through CNG (NCrypt) and the Microsoft Passport Key Storage
// Provider, as KeyCredentialManager does: an RSA key that signs only after
// Hello verified the user. NgcCacheType "auth mandatory" asks every time
// instead of reusing a recent Hello check.

const (
	passportProvider   = "Microsoft Passport Key Storage Provider"
	propLength         = "Length"
	propKeyUsage       = "Key Usage"
	propNgcCacheType   = "NgcCacheType"
	propNgcCacheTypeV1 = "NgcCacheTypeProperty" // before Windows 10 1607
	propUseContext     = "Use Context"
	propWindowHandle   = "HWND Handle"
	blobRSAPublic      = "RSAPUBLICBLOB"
	allowSigning       = 0x2
	ngcAuthMandatory   = 0x1
	padPKCS1           = 0x2
	flagOverwriteKey   = 0x80
	magicRSAPublic     = 0x31415352 // BCRYPT_RSAPUBLIC_MAGIC

	nteUserCancelled = 0x80090036
	nteNoKey         = 0x8009000D
	nteBadKeyset     = 0x80090016
	nteNotFound      = 0x80090011
)

var (
	ncrypt            = windows.NewLazySystemDLL("ncrypt.dll")
	cryptngc          = windows.NewLazySystemDLL("cryptngc.dll")
	procOpenProvider  = ncrypt.NewProc("NCryptOpenStorageProvider")
	procCreateKey     = ncrypt.NewProc("NCryptCreatePersistedKey")
	procSetProperty   = ncrypt.NewProc("NCryptSetProperty")
	procFinalizeKey   = ncrypt.NewProc("NCryptFinalizeKey")
	procOpenKey       = ncrypt.NewProc("NCryptOpenKey")
	procExportKey     = ncrypt.NewProc("NCryptExportKey")
	procSignHash      = ncrypt.NewProc("NCryptSignHash")
	procDeleteKey     = ncrypt.NewProc("NCryptDeleteKey")
	procFreeObject    = ncrypt.NewProc("NCryptFreeObject")
	procNgcDefaultKey = cryptngc.NewProc("NgcGetDefaultDecryptionKeyName")
)

type hello struct{}

// Default returns this computer's system check: Windows Hello.
func Default() Authenticator { return hello{} }

func (hello) Kind() string { return KindHello }

func status(r uintptr, what string) error {
	switch uint32(r) {
	case 0:
		return nil
	case nteUserCancelled:
		return ErrCancelled
	case nteNoKey, nteBadKeyset, nteNotFound:
		return ErrUnavailable
	}
	return fmt.Errorf("%s: SECURITY_STATUS 0x%08x", what, uint32(r))
}

func userSID() (string, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

// keyName is a Passport key name: "<user SID>//<domain>/<subdomain>/<name>".
func keyName(name string) (*uint16, error) {
	sid, err := userSID()
	if err != nil {
		return nil, err
	}
	return windows.UTF16PtrFromString(sid + "//ONE.GY/Desktop/" + name)
}

// Available: Windows Hello is set up for this user (it has a default NGC key).
func (hello) Available(context.Context) bool {
	if cryptngc.Load() != nil || procNgcDefaultKey.Find() != nil {
		return false
	}
	sid, err := userSID()
	if err != nil {
		return false
	}
	var out *uint16
	r, _, _ := procNgcDefaultKey.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(sid))), 0, 0, uintptr(unsafe.Pointer(&out)))
	if r != 0 || out == nil {
		return false
	}
	defer windows.CoTaskMemFree(unsafe.Pointer(out))
	return windows.UTF16PtrToString(out) != ""
}

func openProvider() (uintptr, error) {
	if err := ncrypt.Load(); err != nil {
		return 0, ErrUnavailable
	}
	var prov uintptr
	r, _, _ := procOpenProvider.Call(uintptr(unsafe.Pointer(&prov)), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(passportProvider))), 0)
	if err := status(r, "NCryptOpenStorageProvider"); err != nil {
		return 0, err
	}
	return prov, nil
}

func setUint32(key uintptr, prop string, v uint32) uintptr {
	r, _, _ := procSetProperty.Call(key, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(prop))),
		uintptr(unsafe.Pointer(&v)), 4, 0)
	return r
}

// prompt sets the dialog's parent window and its message.
func prompt(key uintptr, hwnd uint64, text string) {
	if hwnd != 0 {
		h := uintptr(hwnd)
		procSetProperty.Call(key, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(propWindowHandle))),
			uintptr(unsafe.Pointer(&h)), unsafe.Sizeof(h), 0)
	}
	s, _ := windows.UTF16FromString(text)
	procSetProperty.Call(key, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(propUseContext))),
		uintptr(unsafe.Pointer(&s[0])), uintptr(len(s)*2), 0)
}

func (hello) Enroll(_ context.Context, name string, hwnd uint64) ([]byte, error) {
	kn, err := keyName(name)
	if err != nil {
		return nil, err
	}
	prov, err := openProvider()
	if err != nil {
		return nil, err
	}
	defer procFreeObject.Call(prov)
	var key uintptr
	r, _, _ := procCreateKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("RSA"))),
		uintptr(unsafe.Pointer(kn)), 0, flagOverwriteKey)
	if err := status(r, "NCryptCreatePersistedKey"); err != nil {
		return nil, err
	}
	defer procFreeObject.Call(key)
	if err := status(setUint32(key, propLength, 2048), "Length"); err != nil {
		return nil, err
	}
	if err := status(setUint32(key, propKeyUsage, allowSigning), "Key Usage"); err != nil {
		return nil, err
	}
	if setUint32(key, propNgcCacheType, ngcAuthMandatory) != 0 {
		if err := status(setUint32(key, propNgcCacheTypeV1, ngcAuthMandatory), "NgcCacheType"); err != nil {
			return nil, err
		}
	}
	prompt(key, hwnd, "Unlock ONE.GY Desktop with Windows Hello")
	r, _, _ = procFinalizeKey.Call(key, 0)
	if err := status(r, "NCryptFinalizeKey"); err != nil {
		return nil, err
	}
	pub, err := exportPublic(key)
	if err != nil {
		procDeleteKey.Call(key, 0)
		return nil, err
	}
	return pub, nil
}

// exportPublic turns a BCRYPT_RSAKEY_BLOB (magic, bits, exponent and modulus
// lengths, then both big-endian) into a SubjectPublicKeyInfo.
func exportPublic(key uintptr) ([]byte, error) {
	blobType := uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(blobRSAPublic)))
	var n uint32
	r, _, _ := procExportKey.Call(key, 0, blobType, 0, 0, 0, uintptr(unsafe.Pointer(&n)), 0)
	if err := status(r, "NCryptExportKey"); err != nil {
		return nil, err
	}
	blob := make([]byte, n)
	r, _, _ = procExportKey.Call(key, 0, blobType, 0, uintptr(unsafe.Pointer(&blob[0])), uintptr(n), uintptr(unsafe.Pointer(&n)), 0)
	if err := status(r, "NCryptExportKey"); err != nil {
		return nil, err
	}
	if n < 24 || binary.LittleEndian.Uint32(blob[0:4]) != magicRSAPublic {
		return nil, errors.New("unexpected Windows Hello public key blob")
	}
	cbExp, cbMod := binary.LittleEndian.Uint32(blob[8:12]), binary.LittleEndian.Uint32(blob[12:16])
	if uint32(len(blob)) < 24+cbExp+cbMod || cbExp > 8 {
		return nil, errors.New("unexpected Windows Hello public key blob")
	}
	e := new(big.Int).SetBytes(blob[24 : 24+cbExp])
	pub := &rsa.PublicKey{E: int(e.Int64()), N: new(big.Int).SetBytes(blob[24+cbExp : 24+cbExp+cbMod])}
	return x509.MarshalPKIXPublicKey(pub)
}

func (hello) Prove(_ context.Context, name string, msg []byte, hwnd uint64) ([]byte, error) {
	kn, err := keyName(name)
	if err != nil {
		return nil, err
	}
	prov, err := openProvider()
	if err != nil {
		return nil, err
	}
	defer procFreeObject.Call(prov)
	var key uintptr
	r, _, _ := procOpenKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(kn)), 0, 0)
	if err := status(r, "NCryptOpenKey"); err != nil {
		return nil, err
	}
	defer procFreeObject.Call(key)
	prompt(key, hwnd, "Unlock ONE.GY Desktop")
	sum := sha256.Sum256(msg)
	pad := struct{ alg *uint16 }{windows.StringToUTF16Ptr("SHA256")} // BCRYPT_PKCS1_PADDING_INFO
	var n uint32
	r, _, _ = procSignHash.Call(key, uintptr(unsafe.Pointer(&pad)), uintptr(unsafe.Pointer(&sum[0])), uintptr(len(sum)),
		0, 0, uintptr(unsafe.Pointer(&n)), padPKCS1)
	if err := status(r, "NCryptSignHash"); err != nil {
		return nil, err
	}
	sig := make([]byte, n)
	r, _, _ = procSignHash.Call(key, uintptr(unsafe.Pointer(&pad)), uintptr(unsafe.Pointer(&sum[0])), uintptr(len(sum)),
		uintptr(unsafe.Pointer(&sig[0])), uintptr(n), uintptr(unsafe.Pointer(&n)), padPKCS1)
	if err := status(r, "NCryptSignHash"); err != nil {
		return nil, err
	}
	return sig[:n], nil
}

func (hello) Remove(name string) {
	kn, err := keyName(name)
	if err != nil {
		return
	}
	prov, err := openProvider()
	if err != nil {
		return
	}
	defer procFreeObject.Call(prov)
	var key uintptr
	if r, _, _ := procOpenKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(kn)), 0, 0); r == 0 {
		procDeleteKey.Call(key, 0) // also frees the handle
	}
}
