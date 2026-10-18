package main

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

	"golang.org/x/crypto/pbkdf2"
)

// PBKDF2 parameters matching crypto.js exactly
const (
	PBKDF2Iterations = 210000
)

// Passphrase alphabet matching script.js:_generatePassphrase()
const passphraseChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*"
const passphraseLength = 16

// generatePassphrase generates a 16-character random passphrase from the same
// character set used in script.js:_generatePassphrase().
//
// script.js uses: crypto.getRandomValues(new Uint32Array(16)) then % chars.length
// We use crypto/rand with uniform distribution via big.Int to avoid modulo bias.
func generatePassphrase() (string, error) {
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

// deriveWrappingKey derives an AES-256 key from a passphrase + salt using PBKDF2.
// Matches crypto.js:deriveWrappingKey / derivePassphraseKey.
// Returns the 32-byte derived key.
func deriveWrappingKey(passphrase string, salt []byte) []byte {
	return pbkdf2.Key([]byte(passphrase), salt, PBKDF2Iterations, KeySize, sha256.New)
}

// wrapFileKey encrypts a raw 32-byte file key using AES-256-GCM with the wrapping key.
// Matches crypto.js:wrapFileKeyWithPassphrase (the wrapKey('raw', ...) call).
// Returns: (encryptedFileKey, nonce, error)
//
// Web Crypto's wrapKey('raw', ...) with AES-GCM is equivalent to:
//  1. Export the key as raw bytes
//  2. Encrypt those raw bytes with AES-GCM
//
// So we just AES-GCM encrypt the raw 32-byte file key.
func wrapFileKey(fileKey []byte, wrappingKey []byte) (encryptedFileKey []byte, nonce []byte, err error) {
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

// unwrapFileKey decrypts a wrapped file key using AES-256-GCM with the wrapping key.
// Matches crypto.js:unwrapFileKeyWithPassphrase (the unwrapKey('raw', ...) call).
// Returns the raw 32-byte file key.
func unwrapFileKey(encryptedFileKey []byte, nonce []byte, wrappingKey []byte) ([]byte, error) {
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

// encodeBase64 encodes bytes to standard base64 (matching JavaScript's btoa).
func encodeBase64(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

// decodeBase64 decodes standard or URL-safe base64 (matching crypto.js:fromBase64
// which normalizes URL-safe chars before decoding).
func decodeBase64(s string) ([]byte, error) {
	// Same normalization as crypto.js: URL-safe -> standard alphabet, padding
	// optional, so padded/unpadded standard and URL-safe forms all decode.
	s = strings.NewReplacer("-", "+", "_", "/").Replace(strings.TrimRight(s, "="))
	data, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("failed to decode base64: %w", err)
	}
	return data, nil
}
