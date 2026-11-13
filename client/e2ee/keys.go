// keys.go owns key derivation (passphrase and split-key), raw key wrapping and
// the base64 helpers.
package e2ee

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"math/big"
	"strings"

	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/pbkdf2"
)

// PBKDF2 parameters matching crypto.js exactly
const (
	PBKDF2Iterations = 210000 // legacy passphrase path (CLI, guest uploads)

	SplitKeyIterations = 600000 // registered-user split-key path
)

// Passphrase alphabet matching script.js:_generatePassphrase()
const passphraseChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*"
const passphraseLength = 16

// GeneratePassphrase generates a 16-character random passphrase from the same
// character set used in script.js:_generatePassphrase().
//
// script.js uses: crypto.getRandomValues(new Uint32Array(16)) then % chars.length
// We use crypto/rand with uniform distribution via big.Int to avoid modulo bias.
func GeneratePassphrase() (string, error) {
	chars := []byte(passphraseChars)
	charLen := big.NewInt(int64(len(chars)))

	result := make([]byte, passphraseLength)
	for i := 0; i < passphraseLength; i++ {
		idx, err := rand.Int(rand.Reader, charLen)
		if err != nil {
			return "", fmt.Errorf("failed to generate random index: %w", err)
		}
		result[i] = chars[idx.Int64()]
	}
	return string(result), nil
}

// DerivePassphraseKey derives an AES-256 key from a passphrase + salt using PBKDF2.
// Matches crypto.js:deriveWrappingKey / derivePassphraseKey.
// Returns the 32-byte derived key.
func DerivePassphraseKey(passphrase string, salt []byte) []byte {
	return pbkdf2.Key([]byte(passphrase), salt, PBKDF2Iterations, KeySize, sha256.New)
}

// WrapKey encrypts a raw 32-byte key using AES-256-GCM with the wrapping key.
// Matches crypto.js:wrapFileKeyWithPassphrase (the wrapKey('raw', ...) call), and
// equally wrapMasterKey, wrapFileKeyWithMasterKey and wrapFolderNameKey: they
// all AES-GCM the raw 32 key bytes under a random 12-byte nonce, no AAD.
// Returns: (encryptedFileKey, nonce, error)
//
// Web Crypto's wrapKey('raw', ...) with AES-GCM is equivalent to:
//  1. Export the key as raw bytes
//  2. Encrypt those raw bytes with AES-GCM
//
// So we just AES-GCM encrypt the raw 32-byte file key.
func WrapKey(fileKey []byte, wrappingKey []byte) (encryptedFileKey []byte, nonce []byte, err error) {
	block, err := aes.NewCipher(wrappingKey)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create AES cipher for wrapping: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create GCM for wrapping: %w", err)
	}

	nonce = make([]byte, NonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, fmt.Errorf("failed to generate wrapping nonce: %w", err)
	}

	// Seal appends the GCM tag to the ciphertext, matching Web Crypto behavior
	encrypted := gcm.Seal(nil, nonce, fileKey, nil)

	return encrypted, nonce, nil
}

// UnwrapKey decrypts a wrapped key using AES-256-GCM with the wrapping key.
// Matches crypto.js:unwrapFileKeyWithPassphrase (the unwrapKey('raw', ...) call),
// unwrapMasterKey, unwrapFileKeyWithMasterKey and unwrapFolderNameKey.
// Returns the raw 32-byte key.
func UnwrapKey(encryptedFileKey []byte, nonce []byte, wrappingKey []byte) ([]byte, error) {
	block, err := aes.NewCipher(wrappingKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create AES cipher for unwrapping: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM for unwrapping: %w", err)
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, fmt.Errorf("invalid file key nonce size: %d (expected %d)", len(nonce), gcm.NonceSize())
	}
	if len(encryptedFileKey) < gcm.Overhead() {
		return nil, fmt.Errorf("encrypted file key is too short: %d bytes", len(encryptedFileKey))
	}

	fileKey, err := gcm.Open(nil, nonce, encryptedFileKey, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to unwrap file key (wrong passphrase?): %w", err)
	}

	if len(fileKey) != KeySize {
		return nil, fmt.Errorf("unwrapped file key has unexpected size: %d (expected %d)", len(fileKey), KeySize)
	}

	return fileKey, nil
}

// UnwrapKeyB64 is UnwrapKey for the base64 fields the server returns
// (encrypted_master_key/master_key_nonce, encrypted_file_key/file_key_nonce,
// encrypted_name_key/name_key_nonce).
func UnwrapKeyB64(encryptedKeyB64, nonceB64 string, wrappingKey []byte) ([]byte, error) {
	encryptedKey, err := DecodeBase64(encryptedKeyB64)
	if err != nil {
		return nil, fmt.Errorf("could not decode wrapped key: %w", err)
	}
	nonce, err := DecodeBase64(nonceB64)
	if err != nil {
		return nil, fmt.Errorf("could not decode wrapped key nonce: %w", err)
	}
	return UnwrapKey(encryptedKey, nonce, wrappingKey)
}

// DeriveAuthAndWrappingKeys is the split-key password derivation, matching
// crypto.js:_deriveAuthAndWrappingKeysMainThread (page and worker):
//
//	PBKDF2-SHA256(password, salt, 600000) -> 512 bits
//	  -> HKDF-SHA256(salt "onegy-auth-v1", info "auth") -> 256-bit auth token (sent to the server)
//	  -> HKDF-SHA256(salt "onegy-wrap-v1", info "wrap") -> 256-bit AES-GCM wrapping key (kept local)
//
// saltB64 is the account's auth_token_salt from POST /auth/pre-login.
func DeriveAuthAndWrappingKeys(password, saltB64 string) (authTokenB64 string, wrappingKey []byte, err error) {
	salt, err := DecodeBase64(saltB64)
	if err != nil {
		return "", nil, fmt.Errorf("could not decode split-key salt: %w", err)
	}
	if len(salt) == 0 {
		return "", nil, fmt.Errorf("split-key salt is empty")
	}
	derived := pbkdf2.Key([]byte(password), salt, SplitKeyIterations, 64, sha256.New)
	authToken := make([]byte, KeySize)
	if _, err := io.ReadFull(hkdf.New(sha256.New, derived, []byte("onegy-auth-v1"), []byte("auth")), authToken); err != nil {
		return "", nil, fmt.Errorf("auth token derivation failed: %w", err)
	}
	wrappingKey = make([]byte, KeySize)
	if _, err := io.ReadFull(hkdf.New(sha256.New, derived, []byte("onegy-wrap-v1"), []byte("wrap")), wrappingKey); err != nil {
		return "", nil, fmt.Errorf("wrapping key derivation failed: %w", err)
	}
	return EncodeBase64(authToken), wrappingKey, nil
}

// DeriveLinkSecret matches crypto.js:deriveLinkSecret: the share-link secret
// of a resource is HKDF-SHA256(master key, salt "onegy-link-secret-v1", info
// "<resourceType>:<resourceID>"), 32 bytes. resourceType is "file" (id = file
// id) or "folder" (id = the folder's share_token). secret is the unpadded
// base64url form used in share URLs; a file key is wrapped for the link with
// WrapKey(fileKey, linkKey) (crypto.js:wrapFileKeyForLink).
func DeriveLinkSecret(masterKey []byte, resourceType, resourceID string) (secret string, linkKey []byte, err error) {
	if len(masterKey) != KeySize {
		return "", nil, fmt.Errorf("master key must be %d bytes", KeySize)
	}
	linkKey = make([]byte, KeySize)
	r := hkdf.New(sha256.New, masterKey, []byte("onegy-link-secret-v1"), []byte(resourceType+":"+resourceID))
	if _, err := io.ReadFull(r, linkKey); err != nil {
		return "", nil, fmt.Errorf("link secret derivation failed: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(linkKey), linkKey, nil
}

// EncodeBase64 encodes bytes to standard base64 (matching JavaScript's btoa).
func EncodeBase64(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

// DecodeBase64 decodes standard or URL-safe base64 (matching crypto.js:fromBase64
// which normalizes URL-safe chars before decoding).
func DecodeBase64(s string) ([]byte, error) {
	// Same normalization as crypto.js: URL-safe -> standard alphabet, padding
	// optional, so padded/unpadded standard and URL-safe forms all decode.
	s = strings.NewReplacer("-", "+", "_", "/").Replace(strings.TrimRight(s, "="))
	data, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("failed to decode base64: %w", err)
	}
	return data, nil
}
