// meta.go owns the encrypted file metadata (`encrypted_meta`, see
// desktop/docs/sync-api.md "Encrypted metadata"): AES-256-GCM of compact JSON
// under the file key, random 12-byte nonce, no AAD.
package e2ee

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/json"
	"fmt"
	"regexp"
)

// MetaVersion is the only metadata format this package writes or accepts.
const MetaVersion = 1

// Meta is the plaintext of encrypted_meta. Field order is the wire key order.
type Meta struct {
	V              int    `json:"v"`
	FileID         string `json:"file_id"`
	ContentVersion int64  `json:"content_version"`
	PlainSize      int64  `json:"plain_size"`
	PlainSHA256    string `json:"plain_sha256"`
	MtimeNs        int64  `json:"mtime_ns"`
	Mode           uint32 `json:"mode"`
}

var sha256HexRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// EncryptMeta seals m under the file key. V is forced to MetaVersion.
func EncryptMeta(m Meta, fileKey []byte) (metaB64, nonceB64 string, err error) {
	m.V = MetaVersion
	plain, err := json.Marshal(m)
	if err != nil {
		return "", "", fmt.Errorf("failed to encode metadata: %w", err)
	}
	gcm, err := newGCM(fileKey)
	if err != nil {
		return "", "", err
	}
	nonce, err := RandomBytes(NonceSize)
	if err != nil {
		return "", "", err
	}
	return EncodeBase64(gcm.Seal(nil, nonce, plain, nil)), EncodeBase64(nonce), nil
}

// DecryptMeta opens encrypted_meta and enforces the contract: the metadata must
// name this file and must not be older than the node it came with (a server
// rollback or a blob swapped in from another file fails here).
func DecryptMeta(metaB64, nonceB64 string, fileKey []byte, fileID string, contentVersion int64) (Meta, error) {
	var m Meta
	ciphertext, err := DecodeBase64(metaB64)
	if err != nil {
		return m, fmt.Errorf("could not decode metadata: %w", err)
	}
	nonce, err := DecodeBase64(nonceB64)
	if err != nil {
		return m, fmt.Errorf("could not decode metadata nonce: %w", err)
	}
	gcm, err := newGCM(fileKey)
	if err != nil {
		return m, err
	}
	if len(nonce) != NonceSize || len(ciphertext) < TagSize {
		return m, fmt.Errorf("malformed metadata ciphertext")
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return m, fmt.Errorf("failed to decrypt metadata: %w", err)
	}
	if err := json.Unmarshal(plain, &m); err != nil {
		return m, fmt.Errorf("metadata is not valid JSON: %w", err)
	}
	switch {
	case m.V != MetaVersion:
		return m, fmt.Errorf("unsupported metadata version %d", m.V)
	case m.FileID != fileID:
		return m, fmt.Errorf("metadata belongs to another file")
	case m.ContentVersion < contentVersion:
		return m, fmt.Errorf("metadata content_version %d is older than the node's %d", m.ContentVersion, contentVersion)
	case m.PlainSize < 0 || !sha256HexRe.MatchString(m.PlainSHA256):
		return m, fmt.Errorf("metadata has an invalid size or hash")
	}
	return m, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("failed to create AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM: %w", err)
	}
	return gcm, nil
}
