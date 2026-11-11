package main

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unicode"

	"onegy/e2ee"
)

// ─── Download ───────────────────────────────────────────────────────────────

type keyInfoResponse struct {
	IsE2E                  bool   `json:"is_e2e"`
	HasFileKey             bool   `json:"has_file_key"`
	EncryptedFileKey       string `json:"encrypted_file_key"`
	FileKeyNonce           string `json:"file_key_nonce"`
	FileKeySalt            string `json:"file_key_salt"`
	HasLinkKey             bool   `json:"has_link_key"`
	LinkEncFileKey         string `json:"link_encrypted_file_key"`
	LinkFileKeyNonce       string `json:"link_file_key_nonce"`
	HasFolderLinkKey       bool   `json:"has_folder_link_key"`
	FolderLinkEncFileKey   string `json:"folder_link_encrypted_file_key"`
	FolderLinkFileKeyNonce string `json:"folder_link_file_key_nonce"`
	HasLegacy              bool   `json:"has_legacy_passphrase"`
	EncryptedName          string `json:"encrypted_name"`
	NameNonce              string `json:"name_nonce"`
}

func cmdDownload(rawURL string, insecure bool) error {
	parsed, fragmentBytes, err := parseDownloadURL(rawURL)
	if err != nil {
		return err
	}

	client := httpClient(insecure)
	fileID, origName, err := resolveDownloadTarget(client, parsed)
	if err != nil {
		return err
	}
	baseReqURL := baseURL() + "/f/" + url.PathEscape(fileID)

	// 1. Fetch key info
	keyInfo, err := fetchKeyInfo(client, baseReqURL)
	if err != nil {
		return err
	}

	// 2. Download raw encrypted data
	encResp, origName, err := openEncryptedDownload(client, baseReqURL, origName)
	if err != nil {
		return err
	}
	defer encResp.Body.Close()

	// 3. Unwrap the file key using the appropriate method.
	// Crypto path is determined by server metadata (file_key_salt), NOT by URL format.
	fmt.Fprintf(os.Stderr, "Decrypting... ")

	var fileKey []byte
	if keyInfo.FileKeySalt != "" {
		fileKey, err = unwrapPassphraseFileKey(keyInfo, fragmentBytes)
	} else {
		fileKey, err = unwrapLinkSecretFileKey(keyInfo, fragmentBytes)
	}
	if err != nil {
		return err
	}

	// 4. Try to decrypt the real filename from encrypted_name + name_nonce
	if keyInfo.EncryptedName != "" && keyInfo.NameNonce != "" {
		realName, err := e2ee.DecryptName(keyInfo.EncryptedName, keyInfo.NameNonce, fileKey)
		if err != nil {
			// Non-critical: fall back to URL/header filename
			fmt.Fprintf(os.Stderr, "\nWarning: could not decrypt filename: %v\n", err)
			fmt.Fprintf(os.Stderr, "Decrypting... ")
		} else if realName != "" {
			origName = realName
		}
	}

	// 5. Write decrypted stream to disk (handle filename conflicts)
	// Security: strip directory components to prevent path traversal attacks
	// (origName may come from server response, URL path, or decrypted filename)
	outputPath := safePath(filepath.Base(origName))
	written, err := writeDecryptedFile(encResp.Body, fileKey, outputPath)
	if err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "done\n")
	fmt.Fprintf(os.Stderr, "Saved: %s (%s)\n", outputPath, formatSize(written))
	return nil
}

// parseDownloadURL returns the parsed URL and the base64-decoded key fragment.
func parseDownloadURL(rawURL string) (*url.URL, []byte, error) {
	// Parse URL to extract file ID and decryption key from fragment.
	// Unified URL format: #passphrase=<base64>
	// Old format (#<base64> without prefix) is also supported for backward compatibility.
	// The actual crypto path (PBKDF2 passphrase vs raw link secret) is determined by
	// server-side key-info metadata, NOT by the URL format.
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid URL: %w", err)
	}

	fragment := parsed.Fragment
	if fragment == "" {
		return nil, nil, fmt.Errorf("no encryption key in URL — link is incomplete.\nE2EE download URLs must contain a # fragment with the decryption key")
	}

	// Strip "passphrase=" prefix if present (unified format); otherwise use raw fragment
	// for backward compatibility with old link-secret URLs.
	fragmentValue := fragment
	if strings.HasPrefix(fragment, "passphrase=") {
		fragmentValue = strings.TrimPrefix(fragment, "passphrase=")
	}

	// Base64-decode the fragment value. The actual interpretation (passphrase string
	// vs raw 32-byte key) is deferred until we have key-info from the server.
	fragmentBytes, err := e2ee.DecodeBase64(fragmentValue)
	if err != nil {
		return nil, nil, fmt.Errorf("could not decode encryption key from URL: %w", err)
	}
	return parsed, fragmentBytes, nil
}

// resolveDownloadTarget returns the file ID and the name hinted by the URL
// (empty when it has none).
func resolveDownloadTarget(client *http.Client, parsed *url.URL) (fileID, origName string, err error) {
	// Extract file ID from path: /f/<file_id>/... or /s/<short_code>
	pathParts := strings.Split(strings.Trim(parsed.Path, "/"), "/")

	if len(pathParts) >= 2 && pathParts[0] == "s" {
		// Short URL: resolve /s/<code> to the real file ID via server
		shortCode := pathParts[1]
		if !validPathID(shortCode) {
			return "", "", fmt.Errorf("invalid short link code in URL")
		}
		fmt.Fprintf(os.Stderr, "Resolving short link %s... ", shortCode)
		resolveURL := baseURL() + "/s/" + url.PathEscape(shortCode) + "/resolve"
		rResp, err := client.Get(resolveURL)
		if err != nil {
			return "", "", fmt.Errorf("could not resolve short link: %w", err)
		}
		defer rResp.Body.Close()
		if rResp.StatusCode != 200 {
			return "", "", fmt.Errorf("short link not found (HTTP %d)", rResp.StatusCode)
		}
		var resolveData struct {
			FileID   string `json:"file_id"`
			OrigName string `json:"orig_name"`
		}
		resolveBody, err := readBoundedResponse(rResp.Body)
		if err != nil {
			return "", "", fmt.Errorf("could not read resolve response: %w", err)
		}
		if err := json.Unmarshal(resolveBody, &resolveData); err != nil {
			return "", "", fmt.Errorf("could not parse resolve response: %w", err)
		}
		fileID = resolveData.FileID
		origName = resolveData.OrigName
		fmt.Fprintf(os.Stderr, "OK\n")
	} else if len(pathParts) >= 2 && pathParts[0] == "f" {
		// Long URL: /f/<file_id> or /f/<file_id>/<filename>
		fileID = pathParts[1]
		if len(pathParts) >= 3 {
			// parsed.Path is already percent-decoded; decoding again turned a
			// literal "%20" in the name into a space.
			origName = pathParts[2]
		}
	} else {
		return "", "", fmt.Errorf("invalid download URL path: %s\nExpected format: /f/<file_id>/... or /s/<short_code>", parsed.Path)
	}
	if !validPathID(fileID) {
		return "", "", fmt.Errorf("invalid file ID")
	}
	return fileID, origName, nil
}

func fetchKeyInfo(client *http.Client, baseReqURL string) (keyInfoResponse, error) {
	var keyInfo keyInfoResponse
	fmt.Fprintf(os.Stderr, "Fetching file info... ")
	keyInfoURL := baseReqURL + "/key-info"
	kiResp, err := client.Get(keyInfoURL)
	if err != nil {
		return keyInfo, fmt.Errorf("could not fetch key info: %w", err)
	}
	defer kiResp.Body.Close()

	if kiResp.StatusCode == 404 {
		return keyInfo, fmt.Errorf("file not found or expired")
	}
	if kiResp.StatusCode != 200 {
		body, _ := readBoundedResponse(kiResp.Body)
		return keyInfo, fmt.Errorf("key-info request failed (HTTP %d): %s", kiResp.StatusCode, sanitizeTerminalText(string(body)))
	}

	keyInfoBody, err := readBoundedResponse(kiResp.Body)
	if err != nil {
		return keyInfo, fmt.Errorf("could not read key info: %w", err)
	}
	if err := json.Unmarshal(keyInfoBody, &keyInfo); err != nil {
		return keyInfo, fmt.Errorf("could not parse key info: %w", err)
	}

	if !keyInfo.IsE2E {
		return keyInfo, fmt.Errorf("this file is not end-to-end encrypted")
	}
	if !keyInfo.HasFileKey && !keyInfo.HasLinkKey && !keyInfo.HasFolderLinkKey {
		return keyInfo, fmt.Errorf("this file has no downloadable E2EE key metadata")
	}

	fmt.Fprintf(os.Stderr, "done\n")
	return keyInfo, nil
}

// openEncryptedDownload starts the ciphertext download and returns the open
// response (the caller closes its body) plus the output name, falling back to
// Content-Disposition and then "downloaded_file" when origName is empty.
func openEncryptedDownload(client *http.Client, baseReqURL, origName string) (*http.Response, string, error) {
	fmt.Fprintf(os.Stderr, "Downloading encrypted file... ")
	encURL := baseReqURL + "/encrypted"
	encResp, err := client.Get(encURL)
	if err != nil {
		return nil, "", fmt.Errorf("could not download encrypted file: %w", err)
	}

	if encResp.StatusCode == 404 {
		encResp.Body.Close()
		return nil, "", fmt.Errorf("file not found or expired")
	}
	if encResp.StatusCode != 200 {
		body, _ := readBoundedResponse(encResp.Body)
		encResp.Body.Close()
		return nil, "", fmt.Errorf("download failed (HTTP %d): %s", encResp.StatusCode, sanitizeTerminalText(string(body)))
	}

	// Try to get filename from Content-Disposition header if not in URL
	if origName == "" {
		if cd := encResp.Header.Get("Content-Disposition"); cd != "" {
			if _, params, err := mime.ParseMediaType(cd); err == nil {
				if fn, ok := params["filename"]; ok {
					origName = fn
				}
			}
		}
	}
	if origName == "" {
		origName = "downloaded_file"
	}

	if encResp.ContentLength >= 0 {
		fmt.Fprintf(os.Stderr, "done (%s)\n", formatSize(encResp.ContentLength))
	} else {
		fmt.Fprintf(os.Stderr, "done\n")
	}
	return encResp, origName, nil
}

func unwrapPassphraseFileKey(keyInfo keyInfoResponse, fragmentBytes []byte) ([]byte, error) {
	if keyInfo.EncryptedFileKey == "" || keyInfo.FileKeyNonce == "" {
		return nil, fmt.Errorf("passphrase-wrapped file key metadata is incomplete")
	}
	// Passphrase-based: the fragment is a UTF-8 passphrase string.
	// Derive wrapping key via PBKDF2 (210K iterations), then unwrap file key.
	passphrase := string(fragmentBytes)

	salt, err := e2ee.DecodeBase64(keyInfo.FileKeySalt)
	if err != nil {
		return nil, fmt.Errorf("could not decode file key salt: %w", err)
	}

	wrappingKey := e2ee.DerivePassphraseKey(passphrase, salt)

	encFileKey, err := e2ee.DecodeBase64(keyInfo.EncryptedFileKey)
	if err != nil {
		return nil, fmt.Errorf("could not decode encrypted file key: %w", err)
	}

	keyNonce, err := e2ee.DecodeBase64(keyInfo.FileKeyNonce)
	if err != nil {
		return nil, fmt.Errorf("could not decode file key nonce: %w", err)
	}

	fileKey, err := e2ee.UnwrapKey(encFileKey, keyNonce, wrappingKey)
	if err != nil {
		return nil, fmt.Errorf("decryption failed — share link may be corrupted: %w", err)
	}
	return fileKey, nil
}

func unwrapLinkSecretFileKey(keyInfo keyInfoResponse, fragmentBytes []byte) ([]byte, error) {
	// Link-secret-based: the fragment is a raw 32-byte AES-256 key.
	// Use it directly to unwrap the file key (no PBKDF2 derivation).
	// The file key is stored in link_encrypted_file_key / link_file_key_nonce,
	// falling back to encrypted_file_key / file_key_nonce.
	// This matches e2e_download.html:decryptWithLinkKey exactly.
	linkSecret := fragmentBytes
	if len(linkSecret) != e2ee.KeySize {
		return nil, fmt.Errorf("invalid link secret in share URL: got %d bytes, expected %d.\n"+
			"This usually means the share link is incomplete or was copied incorrectly.\n"+
			"Ask the file owner for a fresh share link", len(linkSecret), e2ee.KeySize)
	}

	candidates := [][2]string{
		{keyInfo.LinkEncFileKey, keyInfo.LinkFileKeyNonce},
		{keyInfo.FolderLinkEncFileKey, keyInfo.FolderLinkFileKeyNonce},
		{keyInfo.EncryptedFileKey, keyInfo.FileKeyNonce},
	}
	var lastUnwrap error
	for _, cand := range candidates {
		if cand[0] == "" || cand[1] == "" {
			continue
		}
		encFileKey, decErr := e2ee.DecodeBase64(cand[0])
		if decErr != nil {
			lastUnwrap = decErr
			continue
		}
		keyNonce, decErr := e2ee.DecodeBase64(cand[1])
		if decErr != nil {
			lastUnwrap = decErr
			continue
		}
		fk, unwrapErr := e2ee.UnwrapKey(encFileKey, keyNonce, linkSecret)
		if unwrapErr != nil {
			lastUnwrap = unwrapErr
			continue
		}
		return fk, nil
	}
	if lastUnwrap != nil {
		return nil, fmt.Errorf("decryption failed — share link may be corrupted: %w", lastUnwrap)
	}
	return nil, fmt.Errorf("no encrypted file key available for this file")
}

// writeDecryptedFile decrypts src into a private temp file next to outputPath
// and publishes it there without clobbering; returns the plaintext size.
func writeDecryptedFile(src io.Reader, fileKey []byte, outputPath string) (int64, error) {
	interrupted := make(chan os.Signal, 1)
	signal.Notify(interrupted, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(interrupted)
	out, err := os.CreateTemp(filepath.Dir(outputPath), ".onegy-download-*")
	if err != nil {
		return 0, fmt.Errorf("could not create temporary output file: %w", err)
	}
	tmpOutputPath := out.Name()
	defer os.Remove(tmpOutputPath)
	go func() {
		<-interrupted
		os.Remove(tmpOutputPath)
		fmt.Fprintf(os.Stderr, "\nInterrupted; partial download removed\n")
		os.Exit(1)
	}()
	if err := out.Chmod(0600); err != nil {
		out.Close()
		return 0, fmt.Errorf("could not secure temporary output file: %w", err)
	}
	written, decErr := e2ee.DecryptStream(src, out, fileKey)
	if decErr != nil {
		out.Close()
		if cleanupErr := os.Remove(tmpOutputPath); cleanupErr != nil {
			return 0, fmt.Errorf("file decryption failed: %w; additionally, could not remove partial plaintext %s: %v", decErr, tmpOutputPath, cleanupErr)
		}
		return 0, fmt.Errorf("file decryption failed: %w", decErr)
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return 0, fmt.Errorf("could not sync decrypted file: %w", err)
	}
	closeErr := out.Close()
	if closeErr != nil {
		if cleanupErr := os.Remove(tmpOutputPath); cleanupErr != nil {
			return 0, fmt.Errorf("could not write file: %w; additionally, could not remove partial plaintext %s: %v", closeErr, tmpOutputPath, cleanupErr)
		}
		return 0, fmt.Errorf("could not write file: %w", closeErr)
	}
	outputMode := os.FileMode(0600)
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
		mask := syscall.Umask(0)
		syscall.Umask(mask)
		outputMode = os.FileMode(0666 &^ mask)
	}
	if err := os.Chmod(tmpOutputPath, outputMode); err != nil {
		return 0, fmt.Errorf("could not set output permissions: %w", err)
	}
	// The hard link is an atomic no-clobber publication because the temporary
	// file and destination are on the same filesystem.
	if err := os.Link(tmpOutputPath, outputPath); err != nil {
		return 0, fmt.Errorf("could not publish decrypted file: %w", err)
	}
	if err := os.Remove(tmpOutputPath); err != nil {
		return 0, fmt.Errorf("file was saved as %s, but temporary file cleanup failed: %w", outputPath, err)
	}
	return written, nil
}

// safePath returns a path that doesn't conflict with existing files.
// If "file.pdf" exists, tries "file (1).pdf", "file (2).pdf", etc.
func sanitizeDownloadName(name string) string {
	name = strings.ReplaceAll(name, "\\", "_")
	name = strings.ReplaceAll(name, "/", "_")
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || name == "." || name == ".." {
		return "download"
	}
	var b strings.Builder
	for _, r := range name {
		if r < 32 || r == 127 || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	out = strings.TrimLeft(out, ".")
	if out == "" {
		return "download"
	}
	return out
}

func validPathID(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' && r != '-' {
			return false
		}
	}
	return true
}

func safePath(name string) string {
	name = sanitizeDownloadName(name)
	if _, err := os.Stat(name); os.IsNotExist(err) {
		return name
	}

	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)

	for i := 1; i < 1000; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}

	// Fallback: use a random suffix
	return fmt.Sprintf("%s_download%s", base, ext)
}
