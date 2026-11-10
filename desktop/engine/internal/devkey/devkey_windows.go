//go:build windows

package devkey

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/binary"
	"fmt"
	"math/big"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TPM-backed keys through CNG (NCrypt) and the Microsoft Platform Crypto
// Provider. The private key never leaves the TPM; any process of this user
// can sign with it, but not copy it to another computer.

const (
	platformProvider  = "Microsoft Platform Crypto Provider"
	algECDSAP256      = "ECDSA_P256"
	blobECCPublic     = "ECCPUBLICBLOB"
	flagOverwriteKey  = 0x80
	magicECDSAPublic2 = 0x31534345 // BCRYPT_ECDSA_PUBLIC_P256_MAGIC
)

var (
	ncrypt           = windows.NewLazySystemDLL("ncrypt.dll")
	procOpenProvider = ncrypt.NewProc("NCryptOpenStorageProvider")
	procCreateKey    = ncrypt.NewProc("NCryptCreatePersistedKey")
	procFinalizeKey  = ncrypt.NewProc("NCryptFinalizeKey")
	procOpenKey      = ncrypt.NewProc("NCryptOpenKey")
	procExportKey    = ncrypt.NewProc("NCryptExportKey")
	procSignHash     = ncrypt.NewProc("NCryptSignHash")
	procDeleteKey    = ncrypt.NewProc("NCryptDeleteKey")
	procFreeObject   = ncrypt.NewProc("NCryptFreeObject")
)

type hardware struct {
	name string
	key  uintptr
	pub  []byte
}

func status(r uintptr, what string) error {
	if r != 0 {
		return fmt.Errorf("%s: SECURITY_STATUS 0x%08x", what, uint32(r))
	}
	return nil
}

func openProvider() (uintptr, error) {
	if err := ncrypt.Load(); err != nil {
		return 0, err
	}
	var prov uintptr
	r, _, _ := procOpenProvider.Call(uintptr(unsafe.Pointer(&prov)), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(platformProvider))), 0)
	return prov, status(r, "NCryptOpenStorageProvider")
}

func keyName(name string) *uint16 { return windows.StringToUTF16Ptr("ONE.GY Desktop " + name) }

func newHardware(name string) (Key, error) {
	prov, err := openProvider()
	if err != nil {
		return nil, err
	}
	defer procFreeObject.Call(prov)
	var key uintptr
	r, _, _ := procCreateKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(algECDSAP256))),
		uintptr(unsafe.Pointer(keyName(name))), 0, flagOverwriteKey)
	if err := status(r, "NCryptCreatePersistedKey"); err != nil {
		return nil, err
	}
	if r, _, _ := procFinalizeKey.Call(key, 0); r != 0 {
		procFreeObject.Call(key)
		return nil, status(r, "NCryptFinalizeKey")
	}
	return wrapHardware(name, key)
}

func openHardware(name string) (Key, error) {
	prov, err := openProvider()
	if err != nil {
		return nil, err
	}
	defer procFreeObject.Call(prov)
	var key uintptr
	r, _, _ := procOpenKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(keyName(name))), 0, 0)
	if err := status(r, "NCryptOpenKey"); err != nil {
		return nil, err
	}
	return wrapHardware(name, key)
}

func deleteHardware(name string) {
	prov, err := openProvider()
	if err != nil {
		return
	}
	defer procFreeObject.Call(prov)
	var key uintptr
	if r, _, _ := procOpenKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(keyName(name))), 0, 0); r == 0 {
		procDeleteKey.Call(key, 0) // also frees the handle
	}
}

func wrapHardware(name string, key uintptr) (Key, error) {
	var blob [8 + 64]byte
	var n uint32
	r, _, _ := procExportKey.Call(key, 0, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(blobECCPublic))), 0,
		uintptr(unsafe.Pointer(&blob[0])), uintptr(len(blob)), uintptr(unsafe.Pointer(&n)), 0)
	if err := status(r, "NCryptExportKey"); err != nil {
		procFreeObject.Call(key)
		return nil, err
	}
	if n != uint32(len(blob)) || binary.LittleEndian.Uint32(blob[0:4]) != magicECDSAPublic2 || binary.LittleEndian.Uint32(blob[4:8]) != 32 {
		procFreeObject.Call(key)
		return nil, fmt.Errorf("unexpected public key blob")
	}
	pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(blob[8:40]), Y: new(big.Int).SetBytes(blob[40:72])}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		procFreeObject.Call(key)
		return nil, err
	}
	return &hardware{name: name, key: key, pub: der}, nil
}

func (h *hardware) Sign(msg []byte) ([]byte, error) {
	sum := sha256.Sum256(msg)
	var sig [64]byte
	var n uint32
	r, _, _ := procSignHash.Call(h.key, 0, uintptr(unsafe.Pointer(&sum[0])), uintptr(len(sum)),
		uintptr(unsafe.Pointer(&sig[0])), uintptr(len(sig)), uintptr(unsafe.Pointer(&n)), 0)
	if err := status(r, "NCryptSignHash"); err != nil {
		return nil, err
	}
	if n != 64 {
		return nil, fmt.Errorf("unexpected signature size %d", n)
	}
	// CNG returns r||s; the server expects ASN.1 DER.
	return asn1.Marshal(struct{ R, S *big.Int }{new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])})
}

func (h *hardware) PublicDER() []byte { return h.pub }
func (h *hardware) Hardware() bool    { return true }
func (h *hardware) Ref() string       { return "tpm:" + h.name }
