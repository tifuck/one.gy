package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"strings"
)

// Constants matching crypto.js exactly
const (
	// AUDIT FIX H3: v2 binds chunk metadata into each chunk's GCM AAD (see
	// chunkAAD). New encryptions use v2; v1 (no AAD) is still accepted on
	// decrypt for backward compatibility with previously-uploaded files.
	FileFormatVersion = 2
	ChunkSize         = 64 * 1024 * 1024  // 64 MB per AES-GCM chunk
	NonceSize         = 12                // 96-bit nonce for AES-GCM
	KeySize           = 32                // 256-bit keys
	TagSize           = 16                // 128-bit GCM authentication tag
	HeaderSize        = 1 + 4 + NonceSize // 17 bytes: [version][chunk_count BE][base_nonce]
)

// chunkAAD binds chunk metadata into the GCM authentication tag (AUDIT FIX H3).
// Byte-identical to crypto.js / crypto-worker.js chunkAAD:
//
//	version(1) || chunkCount(4 BE) || chunkIndex(4 BE) || isLast(1)
//
// Returns nil for v1 (legacy, no AAD). Without this binding each chunk was an
// independent GCM token with empty AAD, so an active attacker could silently
// truncate a file by dropping trailing chunks and lowering the header
// chunkCount; binding chunkCount + index makes such tampering fail GCM auth.
func chunkAAD(version byte, chunkCount, chunkIndex uint32) []byte {
	if version < 2 {
		return nil
	}
	aad := make([]byte, 10)
	aad[0] = version
	binary.BigEndian.PutUint32(aad[1:5], chunkCount)
	binary.BigEndian.PutUint32(aad[5:9], chunkIndex)
	if chunkIndex == chunkCount-1 {
		aad[9] = 1
	} else {
		aad[9] = 0
	}
	return aad
}

// isSupportedFileFormatVersion reports whether the decryptor understands a
// given on-disk format version.
func isSupportedFileFormatVersion(version byte) bool {
	return version == 1 || version == 2
}

// randomBytes generates n cryptographically random bytes.
func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return nil, fmt.Errorf("failed to generate random bytes: %w", err)
	}
	return b, nil
}

// deriveChunkNonce derives a unique nonce for a specific chunk from a base nonce.
// XOR the chunk index (as 4 big-endian bytes) into the last 4 bytes of the nonce.
// This matches crypto.js:deriveChunkNonce exactly.
func deriveChunkNonce(baseNonce []byte, chunkIndex uint32) []byte {
	derived := make([]byte, NonceSize)
	copy(derived, baseNonce)

	offset := NonceSize - 4 // byte 8
	existing := binary.BigEndian.Uint32(derived[offset:])
	binary.BigEndian.PutUint32(derived[offset:], existing^chunkIndex)

	return derived
}

// encryptFileData encrypts plaintext using chunked AES-256-GCM.
// Returns the encrypted file bytes with header, matching crypto.js:encryptFileData.
//
// File format:
//
//	[1 byte version][4 bytes chunk_count BE][12 bytes base_nonce]
//	For each chunk:
//	  [4 bytes encrypted_chunk_length BE][encrypted_chunk_data + 16-byte GCM tag]
func encryptFileData(plaintext []byte, fileKey []byte) ([]byte, error) {
	block, err := aes.NewCipher(fileKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM: %w", err)
	}

	totalSize := len(plaintext)
	chunkCount := (totalSize + ChunkSize - 1) / ChunkSize
	if chunkCount == 0 {
		chunkCount = 1 // empty files produce 1 chunk, matching Math.ceil(0/CHUNK_SIZE) || 1
	}

	baseNonce, err := randomBytes(NonceSize)
	if err != nil {
		return nil, err
	}

	// Pre-calculate output size for efficient allocation
	// header + per chunk (4 byte len prefix + plaintext chunk size + GCM tag)
	estimatedSize := HeaderSize
	for i := 0; i < chunkCount; i++ {
		start := i * ChunkSize
		end := start + ChunkSize
		if end > totalSize {
			end = totalSize
		}
		chunkLen := end - start
		estimatedSize += 4 + chunkLen + TagSize
	}

	output := make([]byte, 0, estimatedSize)

	// Write header
	header := make([]byte, HeaderSize)
	header[0] = FileFormatVersion
	binary.BigEndian.PutUint32(header[1:5], uint32(chunkCount))
	copy(header[5:], baseNonce)
	output = append(output, header...)

	// Encrypt each chunk
	for i := 0; i < chunkCount; i++ {
		start := i * ChunkSize
		end := start + ChunkSize
		if end > totalSize {
			end = totalSize
		}
		chunk := plaintext[start:end]

		chunkNonce := deriveChunkNonce(baseNonce, uint32(i))

		// GCM Seal appends the tag to the ciphertext, matching Web Crypto API behavior.
		// AUDIT FIX H3: bind chunk metadata into the tag via AAD.
		encrypted := gcm.Seal(nil, chunkNonce, chunk, chunkAAD(FileFormatVersion, uint32(chunkCount), uint32(i)))

		// Write 4-byte big-endian length of encrypted data (ciphertext + tag)
		lenBuf := make([]byte, 4)
		binary.BigEndian.PutUint32(lenBuf, uint32(len(encrypted)))
		output = append(output, lenBuf...)
		output = append(output, encrypted...)
	}

	return output, nil
}

// errSourceSizeMismatch is the loud failure for a source file that did not
// deliver exactly the byte count the caller declared.
func errSourceSizeMismatch(expected, actual int64) error {
	return fmt.Errorf("source file changed during upload: expected %d bytes, read %d bytes — "+
		"the file was truncated or is still being written; upload aborted to avoid a silently truncated file",
		expected, actual)
}

// encryptFileStream encrypts plaintext from r to w without buffering the full file.
//
// totalSize is the caller's declared plaintext length (an os.Stat / fstat taken
// before the read started) and it is BINDING: the header commits to a chunk
// count derived from it, so r MUST deliver exactly totalSize bytes.
//
// DEFECT FIXED: this loop used to treat BOTH io.ErrUnexpectedEOF and io.EOF as
// "expected last partial chunk" and never compared the bytes actually read
// against totalSize. A file that shrank between the caller's Stat and the read
// (or one still being appended to) was therefore sealed as a short chunk
// followed by empty chunks under a header claiming the full chunkCount,
// uploaded, and handed out as a share URL that decrypted to a SILENTLY
// TRUNCATED file — no error on either side. Both a short read and a source that
// still has data left after totalSize are now hard errors.
func encryptFileStream(r io.Reader, w io.Writer, fileKey []byte, totalSize int64) error {
	if totalSize < 0 {
		return fmt.Errorf("invalid source size: %d bytes", totalSize)
	}

	block, err := aes.NewCipher(fileKey)
	if err != nil {
		return fmt.Errorf("failed to create AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return fmt.Errorf("failed to create GCM: %w", err)
	}

	chunkCount := int((totalSize + ChunkSize - 1) / ChunkSize)
	if chunkCount == 0 {
		chunkCount = 1
	}

	baseNonce, err := randomBytes(NonceSize)
	if err != nil {
		return err
	}

	header := make([]byte, HeaderSize)
	header[0] = FileFormatVersion
	binary.BigEndian.PutUint32(header[1:5], uint32(chunkCount))
	copy(header[5:], baseNonce)
	if _, err := w.Write(header); err != nil {
		return fmt.Errorf("failed to write encrypted header: %w", err)
	}

	buf := make([]byte, ChunkSize)
	var readTotal int64
	for i := 0; i < chunkCount; i++ {
		// Read EXACTLY as many bytes as the declared size still owes us for this
		// chunk. Deriving `want` from totalSize (instead of always asking for a
		// full ChunkSize and tolerating a short read) is what separates a
		// genuine final partial chunk from an unexpected early end: a legitimate
		// last chunk is a complete read of `want` bytes, so io.EOF /
		// io.ErrUnexpectedEOF below can only mean the source ended early.
		want := int64(ChunkSize)
		if remaining := totalSize - readTotal; remaining < want {
			want = remaining
		}

		n, readErr := io.ReadFull(r, buf[:int(want)])
		readTotal += int64(n)
		if readErr != nil {
			if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
				return errSourceSizeMismatch(totalSize, readTotal)
			}
			return fmt.Errorf("failed to read chunk %d: %w", i, readErr)
		}

		// AUDIT FIX H3: bind chunk metadata into the tag via AAD.
		encrypted := gcm.Seal(nil, deriveChunkNonce(baseNonce, uint32(i)), buf[:n], chunkAAD(FileFormatVersion, uint32(chunkCount), uint32(i)))
		lenBuf := make([]byte, 4)
		binary.BigEndian.PutUint32(lenBuf, uint32(len(encrypted)))
		if _, err := w.Write(lenBuf); err != nil {
			return fmt.Errorf("failed to write chunk %d length: %w", i, err)
		}
		if _, err := w.Write(encrypted); err != nil {
			return fmt.Errorf("failed to write encrypted chunk %d: %w", i, err)
		}
	}

	// Explicit end-of-stream assertion. Unreachable given the exact-length reads
	// above, but the invariant the whole fix rests on deserves to be stated.
	if readTotal != totalSize {
		return errSourceSizeMismatch(totalSize, readTotal)
	}

	// The declared size is fully consumed. Anything still readable means the
	// file GREW while we were reading it (an active log, an in-progress
	// download), so the ciphertext we just produced is missing its tail — the
	// same silent truncation, just from the other direction.
	var probe [1]byte
	if n, probeErr := io.ReadFull(r, probe[:]); n > 0 {
		return fmt.Errorf("source file changed during upload: expected %d bytes but the file still has more data "+
			"(it grew while it was being read); upload aborted to avoid a silently truncated file", totalSize)
	} else if probeErr != nil && probeErr != io.EOF && probeErr != io.ErrUnexpectedEOF {
		return fmt.Errorf("failed to confirm end of source file: %w", probeErr)
	}

	return nil
}

// encryptFileName encrypts a UTF-8 filename using the file key.
// Matches crypto.js:encryptFileName — single AES-GCM operation (not chunked).
func encryptFileName(filename string, fileKey []byte) (encryptedName []byte, nonce []byte, err error) {
	block, err := aes.NewCipher(fileKey)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create AES cipher for filename: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create GCM for filename: %w", err)
	}
	nonce, err = randomBytes(NonceSize)
	if err != nil {
		return nil, nil, err
	}
	return gcm.Seal(nil, nonce, []byte(filename), nil), nonce, nil
}

// extractExtension mirrors crypto.js:extractExtension, including compound .tar.* names.
func extractExtension(filename string) string {
	parts := strings.Split(filename, ".")
	if len(parts) < 2 {
		return ""
	}
	if len(parts) >= 3 && strings.EqualFold(parts[len(parts)-2], "tar") {
		return "." + parts[len(parts)-2] + "." + parts[len(parts)-1]
	}
	return "." + parts[len(parts)-1]
}

// decryptFileName decrypts an AES-256-GCM encrypted filename using the file key.
// Matches crypto.js:decryptFileName — single AES-GCM operation (not chunked).
func decryptFileName(encryptedNameB64, nameNonceB64 string, fileKey []byte) (string, error) {
	ciphertext, err := decodeBase64(encryptedNameB64)
	if err != nil {
		return "", fmt.Errorf("could not decode encrypted name: %w", err)
	}
	nonce, err := decodeBase64(nameNonceB64)
	if err != nil {
		return "", fmt.Errorf("could not decode name nonce: %w", err)
	}

	block, err := aes.NewCipher(fileKey)
	if err != nil {
		return "", fmt.Errorf("failed to create AES cipher for filename: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM for filename: %w", err)
	}
	if len(nonce) != gcm.NonceSize() {
		return "", fmt.Errorf("invalid filename nonce size: %d (expected %d)", len(nonce), gcm.NonceSize())
	}
	if len(ciphertext) < gcm.Overhead() {
		return "", fmt.Errorf("encrypted filename is too short: %d bytes", len(ciphertext))
	}

	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("failed to decrypt filename: %w", err)
	}

	return string(plaintext), nil
}

// decryptFileData decrypts chunked AES-256-GCM encrypted data.
// Input is the full encrypted file bytes with header, matching crypto.js:decryptFileData.
func decryptFileData(encryptedData []byte, fileKey []byte) ([]byte, error) {
	if len(encryptedData) < HeaderSize {
		return nil, fmt.Errorf("encrypted data too short for header (%d bytes)", len(encryptedData))
	}

	// Read header
	version := encryptedData[0]
	if !isSupportedFileFormatVersion(version) {
		return nil, fmt.Errorf("unsupported encrypted file format version: %d", version)
	}

	chunkCount := binary.BigEndian.Uint32(encryptedData[1:5])
	baseNonce := encryptedData[5 : 5+NonceSize]

	// The encryptors emit Math.ceil(size/CHUNK_SIZE) || 1 — never 0. A header
	// claiming 0 chunks is a truncated or tampered container that would
	// otherwise fall straight through the loop and return an EMPTY plaintext
	// with no error: the mirror image of the encrypt-side truncation bug.
	if chunkCount == 0 {
		return nil, fmt.Errorf("invalid encrypted container: header declares 0 chunks")
	}

	block, err := aes.NewCipher(fileKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM: %w", err)
	}

	var decrypted []byte
	offset := HeaderSize

	for i := uint32(0); i < chunkCount; i++ {
		if offset+4 > len(encryptedData) {
			return nil, fmt.Errorf("unexpected end of data at chunk %d (reading length)", i)
		}

		chunkLen := binary.BigEndian.Uint32(encryptedData[offset : offset+4])
		offset += 4
		if chunkLen < uint32(gcm.Overhead()) || chunkLen > uint32(ChunkSize+gcm.Overhead()) {
			return nil, fmt.Errorf("invalid encrypted chunk length at chunk %d: %d", i, chunkLen)
		}

		if int64(offset)+int64(chunkLen) > int64(len(encryptedData)) {
			return nil, fmt.Errorf("unexpected end of data at chunk %d (reading data, need %d bytes, have %d)",
				i, chunkLen, len(encryptedData)-offset)
		}

		chunkData := encryptedData[offset : offset+int(chunkLen)]
		offset += int(chunkLen)

		chunkNonce := deriveChunkNonce(baseNonce, i)

		// AUDIT FIX H3: v2 binds chunk metadata into AAD; v1 (legacy) uses nil.
		plaintext, err := gcm.Open(nil, chunkNonce, chunkData, chunkAAD(version, chunkCount, i))
		if err != nil {
			return nil, fmt.Errorf("decryption failed at chunk %d: %w", i, err)
		}

		decrypted = append(decrypted, plaintext...)
	}

	// Every byte the encryptor produced is accounted for by the header's chunk
	// count. Leftover bytes mean the container is not the one we were handed a
	// chunk count for.
	if offset != len(encryptedData) {
		return nil, fmt.Errorf("encrypted container has %d trailing byte(s) after the last declared chunk",
			len(encryptedData)-offset)
	}

	return decrypted, nil
}

// decryptFileStream decrypts chunked AES-256-GCM data from r to w.
func decryptFileStream(r io.Reader, w io.Writer, fileKey []byte) (int64, error) {
	header := make([]byte, HeaderSize)
	if _, err := io.ReadFull(r, header); err != nil {
		return 0, fmt.Errorf("encrypted data too short for header: %w", err)
	}

	version := header[0]
	if !isSupportedFileFormatVersion(version) {
		return 0, fmt.Errorf("unsupported encrypted file format version: %d", version)
	}

	chunkCount := binary.BigEndian.Uint32(header[1:5])
	baseNonce := header[5 : 5+NonceSize]

	// See decryptFileData: a 0-chunk header would decrypt to an empty file with
	// no error at all. Refuse it loudly instead of writing a 0-byte "download".
	if chunkCount == 0 {
		return 0, fmt.Errorf("invalid encrypted container: header declares 0 chunks")
	}

	block, err := aes.NewCipher(fileKey)
	if err != nil {
		return 0, fmt.Errorf("failed to create AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return 0, fmt.Errorf("failed to create GCM: %w", err)
	}

	var written int64
	lenBuf := make([]byte, 4)
	for i := uint32(0); i < chunkCount; i++ {
		if _, err := io.ReadFull(r, lenBuf); err != nil {
			return written, fmt.Errorf("unexpected end of data at chunk %d length: %w", i, err)
		}
		chunkLen := binary.BigEndian.Uint32(lenBuf)
		if chunkLen < TagSize || chunkLen > ChunkSize+TagSize {
			return written, fmt.Errorf("invalid encrypted chunk length at chunk %d: %d", i, chunkLen)
		}
		chunkData := make([]byte, int(chunkLen))
		if _, err := io.ReadFull(r, chunkData); err != nil {
			return written, fmt.Errorf("unexpected end of data at chunk %d data: %w", i, err)
		}
		// AUDIT FIX H3: v2 binds chunk metadata into AAD; v1 (legacy) uses nil.
		plaintext, err := gcm.Open(nil, deriveChunkNonce(baseNonce, i), chunkData, chunkAAD(version, chunkCount, i))
		if err != nil {
			return written, fmt.Errorf("decryption failed at chunk %d: %w", i, err)
		}
		n, err := w.Write(plaintext)
		written += int64(n)
		if err != nil {
			return written, fmt.Errorf("failed to write decrypted chunk %d: %w", i, err)
		}
		if n != len(plaintext) {
			return written, fmt.Errorf("short write at chunk %d", i)
		}
	}

	// Mirror of the encrypt-side growth probe: the header's chunk count accounts
	// for the whole container, so a reader that still has bytes left is not the
	// container this header describes.
	var probe [1]byte
	if n, probeErr := io.ReadFull(r, probe[:]); n > 0 {
		return written, fmt.Errorf("encrypted container has trailing data after the last declared chunk (%d chunks)", chunkCount)
	} else if probeErr != nil && probeErr != io.EOF && probeErr != io.ErrUnexpectedEOF {
		return written, fmt.Errorf("failed to confirm end of encrypted container: %w", probeErr)
	}

	return written, nil
}
