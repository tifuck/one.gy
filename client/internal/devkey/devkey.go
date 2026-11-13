// Package devkey holds the device's request-signing key (sync-api.md "Device
// security"): ECDSA P-256 over "<unix ts>\n<METHOD>\n<path>[?<query>]". On
// Windows the key is created in the TPM (Microsoft Platform Crypto Provider)
// when one is usable, so it can sign only on this computer; elsewhere, or when
// the TPM fails its self-check, it is a software key kept in the OS key store.
package devkey

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"strings"
)

// Key signs requests. Ref is what the key store keeps to load it again.
type Key interface {
	Sign(msg []byte) ([]byte, error) // ASN.1 DER signature of SHA-256(msg)
	PublicDER() []byte               // SubjectPublicKeyInfo
	Hardware() bool
	Ref() string
}

// New creates a key: the TPM when available (name scopes it per state dir),
// else software.
func New(name string) (Key, error) {
	if k, err := newHardware(name); err == nil {
		if selfCheck(k) == nil {
			return k, nil
		}
		deleteHardware(name)
	}
	return newSoftware()
}

// Load reopens a key from its Ref.
func Load(ref string) (Key, error) {
	switch {
	case strings.HasPrefix(ref, "sw:"):
		der, err := base64.StdEncoding.DecodeString(ref[3:])
		if err != nil {
			return nil, err
		}
		pk, err := x509.ParseECPrivateKey(der)
		if err != nil {
			return nil, err
		}
		return &software{pk}, nil
	case strings.HasPrefix(ref, "tpm:"):
		return openHardware(ref[4:])
	}
	return nil, fmt.Errorf("unknown key reference")
}

// Delete removes a hardware key (software keys live only in their Ref).
func Delete(ref string) {
	if strings.HasPrefix(ref, "tpm:") {
		deleteHardware(ref[4:])
	}
}

// selfCheck signs a probe and verifies it with the exported public key, so a
// platform quirk never leaves the device with signatures the server rejects.
func selfCheck(k Key) error {
	pub, err := x509.ParsePKIXPublicKey(k.PublicDER())
	if err != nil {
		return err
	}
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok || ec.Curve != elliptic.P256() {
		return fmt.Errorf("not a P-256 key")
	}
	msg := []byte("onegy-devkey-self-check")
	sig, err := k.Sign(msg)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(msg)
	if !ecdsa.VerifyASN1(ec, sum[:], sig) {
		return fmt.Errorf("signature self-check failed")
	}
	return nil
}

type software struct{ pk *ecdsa.PrivateKey }

func newSoftware() (Key, error) {
	pk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	return &software{pk}, nil
}

func (s *software) Sign(msg []byte) ([]byte, error) {
	sum := sha256.Sum256(msg)
	return ecdsa.SignASN1(rand.Reader, s.pk, sum[:])
}

func (s *software) PublicDER() []byte {
	der, _ := x509.MarshalPKIXPublicKey(&s.pk.PublicKey)
	return der
}

func (s *software) Hardware() bool { return false }

func (s *software) Ref() string {
	der, _ := x509.MarshalECPrivateKey(s.pk)
	return "sw:" + base64.StdEncoding.EncodeToString(der)
}
