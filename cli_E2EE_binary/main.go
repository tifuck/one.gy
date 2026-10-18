package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unicode"
)

// Embedded at compile time via -ldflags "-X main.serverDomain=..."
var serverDomain = "one.gy"

func baseURL() string {
	return "https://" + serverDomain
}

func platform() string {
	goOS := runtime.GOOS
	goArch := runtime.GOARCH
	return goOS + "-" + goArch
}

// httpClient returns an HTTP client.
// Pass insecure=true to skip TLS verification (for dev/self-signed certs).
func httpClient(insecure bool) *http.Client {
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ResponseHeaderTimeout: 2 * time.Hour,
		TLSHandshakeTimeout:   15 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}
	if insecure {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &http.Client{
		Transport: transport,
		Timeout:   2 * time.Hour,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}
}

const maxResponseBody = 64 << 10

func readBoundedResponse(body io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, maxResponseBody+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxResponseBody {
		return nil, fmt.Errorf("response exceeds %d bytes", maxResponseBody)
	}
	return data, nil
}

func resolveUpdateURL(downloadURL string) (string, error) {
	if downloadURL == "" {
		return "", fmt.Errorf("empty download url")
	}
	if strings.ContainsAny(downloadURL, "@ \\") || strings.Contains(downloadURL, "//") {
		return "", fmt.Errorf("invalid download url")
	}
	if !strings.HasPrefix(downloadURL, "/static/cli/") || !strings.HasSuffix(downloadURL, "/onegy") {
		return "", fmt.Errorf("invalid download url")
	}
	for _, r := range downloadURL {
		if r < 32 || r == 127 {
			return "", fmt.Errorf("invalid download url")
		}
	}
	return baseURL() + downloadURL, nil
}

// ─── Auto-Update ────────────────────────────────────────────────────────────

// selfHash computes the SHA-256 hash of the running binary.
func selfHash() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("could not determine executable path: %w", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return "", fmt.Errorf("could not resolve executable symlinks: %w", err)
	}

	f, err := os.Open(exePath)
	if err != nil {
		return "", fmt.Errorf("could not open executable: %w", err)
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("could not hash executable: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

type versionResponse struct {
	SHA256      string `json:"sha256"`
	DownloadURL string `json:"download_url"`
}

func fetchVersion(ctx context.Context, client *http.Client) (versionResponse, error) {
	var ver versionResponse
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL()+"/cli/version?platform="+platform(), nil)
	if err != nil {
		return ver, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return ver, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ver, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBody)).Decode(&ver); err != nil {
		return ver, err
	}
	if ver.SHA256 == "" {
		return ver, fmt.Errorf("server returned empty version hash")
	}
	if _, err := resolveUpdateURL(ver.DownloadURL); err != nil {
		return ver, err
	}
	return ver, nil
}

// checkForUpdate queries the server for the latest binary hash and updates if needed.
// Returns true if the binary was updated (caller should re-exec).
// On any error, prints a warning and returns false (never blocks the user).
func checkForUpdate(client *http.Client, insecure bool) bool {
	if insecure {
		fmt.Fprintf(os.Stderr, "Warning: skipping auto-update because --insecure is set\n")
		return false
	}
	currentHash, err := selfHash()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not compute self-hash: %v\n", err)
		return false
	}

	manifestCtx, cancelManifest := context.WithTimeout(context.Background(), 20*time.Second)
	ver, err := fetchVersion(manifestCtx, client)
	cancelManifest()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not check for updates: %v\n", err)
		return false
	}

	if currentHash == ver.SHA256 {
		return false // already up to date
	}

	// Download new binary
	fmt.Fprintf(os.Stderr, "Updating onegy...\n")

	downloadURL, err := resolveUpdateURL(ver.DownloadURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: refusing update download URL: %v\n", err)
		return false
	}
	downloadCtx, cancelDownload := context.WithTimeout(context.Background(), 10*time.Minute)
	downloadReq, err := http.NewRequestWithContext(downloadCtx, http.MethodGet, downloadURL, nil)
	if err != nil {
		cancelDownload()
		fmt.Fprintf(os.Stderr, "Warning: could not create update request: %v\n", err)
		return false
	}
	dlResp, err := client.Do(downloadReq)
	if err != nil {
		cancelDownload()
		fmt.Fprintf(os.Stderr, "Warning: could not download update: %v\n", err)
		return false
	}
	defer cancelDownload()
	defer dlResp.Body.Close()

	if dlResp.StatusCode != 200 {
		fmt.Fprintf(os.Stderr, "Warning: update download returned HTTP %d\n", dlResp.StatusCode)
		return false
	}

	// Read entire binary into memory and verify hash
	if dlResp.ContentLength > 50<<20 {
		fmt.Fprintf(os.Stderr, "Warning: update binary exceeds the 50 MiB limit\n")
		return false
	}
	newBinary, err := io.ReadAll(io.LimitReader(dlResp.Body, (50<<20)+1))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not read update binary: %v\n", err)
		return false
	}
	if len(newBinary) > 50<<20 {
		fmt.Fprintf(os.Stderr, "Warning: update binary exceeds the 50 MiB limit\n")
		return false
	}

	newHash := sha256.Sum256(newBinary)
	newHashStr := hex.EncodeToString(newHash[:])
	if newHashStr != ver.SHA256 {
		fmt.Fprintf(os.Stderr, "Warning: update verification failed (hash mismatch), continuing with current version\n")
		return false
	}

	// Write to temp file, then atomic rename over self
	exePath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not determine executable path for update: %v\n", err)
		return false
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not resolve executable path for update: %v\n", err)
		return false
	}

	tmpFile, err := os.CreateTemp(filepath.Dir(exePath), ".onegy-update-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not create update file: %v\n", err)
		return false
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)
	if _, err := tmpFile.Write(newBinary); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not write update binary: %v\n", err)
		tmpFile.Close()
		return false
	}
	if err := tmpFile.Sync(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not sync update binary: %v\n", err)
		tmpFile.Close()
		return false
	}
	if err := tmpFile.Chmod(0755); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not set update permissions: %v\n", err)
		tmpFile.Close()
		return false
	}
	if err := tmpFile.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not close update binary: %v\n", err)
		return false
	}
	diskHash, err := fileHash(tmpPath)
	if err != nil || diskHash != ver.SHA256 {
		fmt.Fprintf(os.Stderr, "Warning: update file verification failed before replacement\n")
		return false
	}
	finalManifestCtx, cancelFinalManifest := context.WithTimeout(context.Background(), 20*time.Second)
	currentVer, err := fetchVersion(finalManifestCtx, client)
	cancelFinalManifest()
	if err != nil || currentVer.SHA256 != ver.SHA256 || currentVer.DownloadURL != ver.DownloadURL {
		fmt.Fprintf(os.Stderr, "Warning: update generation changed before installation; retry on the next run\n")
		return false
	}

	if err := os.Rename(tmpPath, exePath); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not replace binary: %v\n", err)
		return false
	}

	return true
}

// reExec re-executes the current binary with the same arguments.
func reExec() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not determine executable path: %w", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return fmt.Errorf("could not resolve executable path: %w", err)
	}

	// syscall.Exec replaces the current process
	if err := syscall.Exec(exePath, os.Args, os.Environ()); err != nil {
		return err
	}
	return nil
}

// ─── Upload ─────────────────────────────────────────────────────────────────

type uploadResponse struct {
	DownloadURL string `json:"download_url"`
	FileID      string `json:"file_id"`
	MgmtToken   string `json:"management_token"`
	Error       string `json:"error"`
}

type uploadStreamResult struct {
	err   error
	local bool
}

type uploadPartWriter struct {
	w        io.Writer
	writeErr error
}

func (w *uploadPartWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	if err != nil {
		w.writeErr = err
	}
	return n, err
}

func validateUploadResponse(result uploadResponse) (string, error) {
	if result.DownloadURL == "" || result.MgmtToken == "" {
		return "", fmt.Errorf("response is missing download_url or management_token")
	}
	parsed, err := url.Parse(result.DownloadURL)
	if err != nil {
		return "", fmt.Errorf("invalid download_url: %w", err)
	}
	if parsed.Scheme != "https" || parsed.Host != serverDomain || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("download_url is not a canonical URL for %s", baseURL())
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 2 || parts[0] != "f" || parts[1] == "" || parts[1] == "." || parts[1] == ".." {
		return "", fmt.Errorf("download_url has an invalid file path")
	}
	if result.FileID != "" && result.FileID != parts[1] {
		return "", fmt.Errorf("download_url file ID does not match file_id")
	}
	return baseURL() + parsed.EscapedPath(), nil
}

func cmdUpload(filePath string, insecure bool) error {
	info, err := os.Stat(filePath)
	if err != nil {
		return fmt.Errorf("could not stat file: %w", err)
	}
	if info.IsDir() {
		return fmt.Errorf("cannot upload a directory: %s", filePath)
	}
	origName := filepath.Base(filePath)

	fmt.Fprintf(os.Stderr, "Encrypting %s (%s)... ", origName, formatSize(info.Size()))

	// 1. Generate random file key (32 bytes)
	fileKey, err := randomBytes(KeySize)
	if err != nil {
		return fmt.Errorf("could not generate file key: %w", err)
	}

	// 2. Generate passphrase and derive wrapping key
	passphrase, err := generatePassphrase()
	if err != nil {
		return fmt.Errorf("could not generate passphrase: %w", err)
	}

	salt, err := randomBytes(KeySize) // 32-byte PBKDF2 salt
	if err != nil {
		return fmt.Errorf("could not generate salt: %w", err)
	}

	wrappingKey := deriveWrappingKey(passphrase, salt)

	// 3. Wrap file key with passphrase-derived key
	wrappedKey, keyNonce, err := wrapFileKey(fileKey, wrappingKey)
	if err != nil {
		return fmt.Errorf("could not wrap file key: %w", err)
	}

	encryptedName, nameNonce, err := encryptFileName(origName, fileKey)
	if err != nil {
		return fmt.Errorf("could not encrypt filename: %w", err)
	}
	storedExtension := extractExtension(origName)
	uploadIDBytes, err := randomBytes(32)
	if err != nil {
		return fmt.Errorf("could not generate upload idempotency key: %w", err)
	}
	uploadID := hex.EncodeToString(uploadIDBytes)

	fmt.Fprintf(os.Stderr, "done\nUploading... ")

	// 4. Stream encrypted data into a multipart upload body. Transport and
	// response-read ambiguity gets one retry with the same idempotency key and
	// crypto metadata; each attempt must recreate its one-shot stream.
	//
	// A failure inside encryptFileStream (e.g. the source file shrank or grew
	// mid-read) must abort the whole upload, not finish a well-formed but short
	// body. The error is therefore reported two ways: the pipe is closed WITH
	// the error (so the transport tears the connection down instead of sending a
	// valid terminating chunk) and the request context is cancelled. The real
	// cause is handed back over streamDone so the user sees the truncation
	// message rather than a generic transport error, and the share URL below is
	// only reached on an HTTP 200 with a clean stream.
	//
	// Server side: the file part is written FIRST, so an aborted body means its
	// closing multipart boundary never arrives. Werkzeug only materialises a
	// part once that boundary has been seen, so /upload observes zero files and
	// returns 400 without writing a payload or committing a File row — no
	// partial upload can be left behind.
	client := httpClient(insecure)
	var result uploadResponse
	jar, err := cookiejar.New(nil)
	if err != nil {
		return fmt.Errorf("could not create upload cookie jar: %w", err)
	}
	client.Jar = jar

	const maxUploadAttempts = 2
	for attempt := 1; attempt <= maxUploadAttempts; attempt++ {
		uploadCtx, cancelUpload := context.WithCancel(context.Background())
		pipeReader, pipeWriter := io.Pipe()
		writer := multipart.NewWriter(pipeWriter)
		streamDone := make(chan uploadStreamResult, 1)

		go func() {
			result := uploadStreamResult{}
			defer func() {
				if result.err != nil {
					cancelUpload()
					pipeWriter.CloseWithError(result.err)
				} else {
					pipeWriter.Close()
				}
				streamDone <- result
			}()

			in, err := os.Open(filePath)
			if err != nil {
				result = uploadStreamResult{fmt.Errorf("could not open file: %w", err), true}
				return
			}
			defer in.Close()

			// Re-stat the open descriptor so each attempt encrypts exactly the
			// inode and size it opened, and detects mutation while reading it.
			st, err := in.Stat()
			if err != nil {
				result = uploadStreamResult{fmt.Errorf("could not stat open file: %w", err), true}
				return
			}
			if !st.Mode().IsRegular() {
				result = uploadStreamResult{fmt.Errorf("not a regular file: %s", filePath), true}
				return
			}
			if !os.SameFile(info, st) || st.Size() != info.Size() || !st.ModTime().Equal(info.ModTime()) {
				result = uploadStreamResult{fmt.Errorf("source file changed before upload attempt %d; upload aborted", attempt), true}
				return
			}

			part, err := writer.CreateFormFile("file", "encrypted.bin")
			if err != nil {
				result.err = fmt.Errorf("could not create form file: %w", err)
				return
			}
			trackedPart := &uploadPartWriter{w: part}
			if err := encryptFileStream(in, trackedPart, fileKey, st.Size()); err != nil {
				result = uploadStreamResult{fmt.Errorf("encryption failed: %w", err), trackedPart.writeErr == nil}
				return
			}

			fields := [][2]string{
				{"e2e", "true"},
				{"encrypted_file_key", encodeBase64(wrappedKey)},
				{"file_key_nonce", encodeBase64(keyNonce)},
				{"file_key_salt", encodeBase64(salt)},
				{"encrypted_name", encodeBase64(encryptedName)},
				{"name_nonce", encodeBase64(nameNonce)},
				{"stored_extension", storedExtension},
				{"is_temp", "true"},
				{"upload_id", uploadID},
				{"user_id", uploadID},
			}
			for _, field := range fields {
				if err := writer.WriteField(field[0], field[1]); err != nil {
					result.err = fmt.Errorf("could not write form field %s: %w", field[0], err)
					return
				}
			}

			if err := writer.Close(); err != nil {
				result.err = fmt.Errorf("could not finalize form: %w", err)
			}
		}()

		req, err := http.NewRequestWithContext(uploadCtx, "POST", baseURL()+"/upload", pipeReader)
		if err != nil {
			cancelUpload()
			pipeReader.Close()
			<-streamDone
			return fmt.Errorf("could not create upload request: %w", err)
		}
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		req.Header.Set("Referer", baseURL()+"/")

		resp, requestErr := client.Do(req)
		if requestErr != nil {
			cancelUpload()
			pipeReader.Close()
			streamResult := <-streamDone
			if streamResult.err != nil && streamResult.local {
				return streamResult.err
			}
			if attempt < maxUploadAttempts {
				time.Sleep(500 * time.Millisecond)
				continue
			}
			return fmt.Errorf("upload request failed: %w; the server response was ambiguous and the upload may have completed (upload ID %s)", requestErr, uploadID)
		}

		respBody, readErr := readBoundedResponse(resp.Body)
		resp.Body.Close()
		cancelUpload()
		pipeReader.Close()
		streamResult := <-streamDone
		if streamResult.err != nil && streamResult.local {
			return streamResult.err
		}

		if readErr != nil {
			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("could not read upload response: %w", readErr)
			}
			if strings.HasPrefix(readErr.Error(), "response exceeds ") {
				return fmt.Errorf("server returned HTTP 200 but its response was invalid: %w", readErr)
			}
			if attempt < maxUploadAttempts {
				time.Sleep(500 * time.Millisecond)
				continue
			}
			return fmt.Errorf("server returned HTTP 200 but its response could not be read: %w; the upload may have completed (upload ID %s)", readErr, uploadID)
		}

		if resp.StatusCode != http.StatusOK {
			var errResp uploadResponse
			if json.Unmarshal(respBody, &errResp) == nil && errResp.Error != "" {
				return fmt.Errorf("upload failed: %s", errResp.Error)
			}
			return fmt.Errorf("upload failed with HTTP %d: %s", resp.StatusCode, string(respBody))
		}

		if err := json.Unmarshal(respBody, &result); err != nil {
			return fmt.Errorf("server returned HTTP 200 but its response was invalid: %w; the upload may have completed (upload ID %s)", err, uploadID)
		}
		break
	}

	canonicalDownloadURL, err := validateUploadResponse(result)
	if err != nil {
		return fmt.Errorf("server returned HTTP 200 with an invalid upload response: %w; the upload may have completed (upload ID %s)", err, uploadID)
	}

	fmt.Fprintf(os.Stderr, "done\n\n")

	// 7. Construct share URL with passphrase in fragment
	// Passphrase encoding: base64(utf8(passphrase))
	// Since our passphrase is ASCII-only, this is just base64(passphrase)
	passphraseB64 := encodeBase64([]byte(passphrase))
	shareURL := canonicalDownloadURL + "#passphrase=" + passphraseB64

	fmt.Printf("SHARE URL (EXPIRES IN 24H):\n%s\n\n", shareURL)
	fmt.Fprintf(os.Stderr, "Anyone with this URL can decrypt and download the file.\n")
	fmt.Fprintf(os.Stderr, "The server never sees your encryption key.\n")

	return nil
}

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
	// Parse URL to extract file ID and decryption key from fragment.
	// Unified URL format: #passphrase=<base64>
	// Old format (#<base64> without prefix) is also supported for backward compatibility.
	// The actual crypto path (PBKDF2 passphrase vs raw link secret) is determined by
	// server-side key-info metadata, NOT by the URL format.
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	fragment := parsed.Fragment
	if fragment == "" {
		return fmt.Errorf("no encryption key in URL — link is incomplete.\nE2EE download URLs must contain a # fragment with the decryption key")
	}

	// Strip "passphrase=" prefix if present (unified format); otherwise use raw fragment
	// for backward compatibility with old link-secret URLs.
	fragmentValue := fragment
	if strings.HasPrefix(fragment, "passphrase=") {
		fragmentValue = strings.TrimPrefix(fragment, "passphrase=")
	}

	// Base64-decode the fragment value. The actual interpretation (passphrase string
	// vs raw 32-byte key) is deferred until we have key-info from the server.
	fragmentBytes, err := decodeBase64(fragmentValue)
	if err != nil {
		return fmt.Errorf("could not decode encryption key from URL: %w", err)
	}

	// Extract file ID from path: /f/<file_id>/... or /s/<short_code>
	pathParts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	client := httpClient(insecure)

	var fileID, origName string

	if len(pathParts) >= 2 && pathParts[0] == "s" {
		// Short URL: resolve /s/<code> to the real file ID via server
		shortCode := pathParts[1]
		fmt.Fprintf(os.Stderr, "Resolving short link %s... ", shortCode)
		resolveURL := baseURL() + "/s/" + shortCode + "/resolve"
		rResp, err := client.Get(resolveURL)
		if err != nil {
			return fmt.Errorf("could not resolve short link: %w", err)
		}
		defer rResp.Body.Close()
		if rResp.StatusCode != 200 {
			return fmt.Errorf("short link not found (HTTP %d)", rResp.StatusCode)
		}
		var resolveData struct {
			FileID   string `json:"file_id"`
			OrigName string `json:"orig_name"`
		}
		resolveBody, err := readBoundedResponse(rResp.Body)
		if err != nil {
			return fmt.Errorf("could not read resolve response: %w", err)
		}
		if err := json.Unmarshal(resolveBody, &resolveData); err != nil {
			return fmt.Errorf("could not parse resolve response: %w", err)
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
		return fmt.Errorf("invalid download URL path: %s\nExpected format: /f/<file_id>/... or /s/<short_code>", parsed.Path)
	}
	baseReqURL := baseURL() + "/f/" + fileID

	// 1. Fetch key info
	fmt.Fprintf(os.Stderr, "Fetching file info... ")
	keyInfoURL := baseReqURL + "/key-info"
	kiResp, err := client.Get(keyInfoURL)
	if err != nil {
		return fmt.Errorf("could not fetch key info: %w", err)
	}
	defer kiResp.Body.Close()

	if kiResp.StatusCode == 404 {
		return fmt.Errorf("file not found or expired")
	}
	if kiResp.StatusCode != 200 {
		body, _ := readBoundedResponse(kiResp.Body)
		return fmt.Errorf("key-info request failed (HTTP %d): %s", kiResp.StatusCode, string(body))
	}

	var keyInfo keyInfoResponse
	keyInfoBody, err := readBoundedResponse(kiResp.Body)
	if err != nil {
		return fmt.Errorf("could not read key info: %w", err)
	}
	if err := json.Unmarshal(keyInfoBody, &keyInfo); err != nil {
		return fmt.Errorf("could not parse key info: %w", err)
	}

	if !keyInfo.IsE2E {
		return fmt.Errorf("this file is not end-to-end encrypted")
	}
	if !keyInfo.HasFileKey && !keyInfo.HasLinkKey && !keyInfo.HasFolderLinkKey {
		return fmt.Errorf("this file has no downloadable E2EE key metadata")
	}

	fmt.Fprintf(os.Stderr, "done\n")

	// 2. Download raw encrypted data
	fmt.Fprintf(os.Stderr, "Downloading encrypted file... ")
	encURL := baseReqURL + "/encrypted"
	encResp, err := client.Get(encURL)
	if err != nil {
		return fmt.Errorf("could not download encrypted file: %w", err)
	}
	defer encResp.Body.Close()

	if encResp.StatusCode == 404 {
		return fmt.Errorf("file not found or expired")
	}
	if encResp.StatusCode != 200 {
		body, _ := readBoundedResponse(encResp.Body)
		return fmt.Errorf("download failed (HTTP %d): %s", encResp.StatusCode, string(body))
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

	// 3. Unwrap the file key using the appropriate method.
	// Crypto path is determined by server metadata (file_key_salt), NOT by URL format.
	fmt.Fprintf(os.Stderr, "Decrypting... ")

	var fileKey []byte

	if keyInfo.FileKeySalt != "" {
		if keyInfo.EncryptedFileKey == "" || keyInfo.FileKeyNonce == "" {
			return fmt.Errorf("passphrase-wrapped file key metadata is incomplete")
		}
		// Passphrase-based: the fragment is a UTF-8 passphrase string.
		// Derive wrapping key via PBKDF2 (210K iterations), then unwrap file key.
		passphrase := string(fragmentBytes)

		salt, err := decodeBase64(keyInfo.FileKeySalt)
		if err != nil {
			return fmt.Errorf("could not decode file key salt: %w", err)
		}

		wrappingKey := deriveWrappingKey(passphrase, salt)

		encFileKey, err := decodeBase64(keyInfo.EncryptedFileKey)
		if err != nil {
			return fmt.Errorf("could not decode encrypted file key: %w", err)
		}

		keyNonce, err := decodeBase64(keyInfo.FileKeyNonce)
		if err != nil {
			return fmt.Errorf("could not decode file key nonce: %w", err)
		}

		fileKey, err = unwrapFileKey(encFileKey, keyNonce, wrappingKey)
		if err != nil {
			return fmt.Errorf("decryption failed — share link may be corrupted: %w", err)
		}
	} else {
		// Link-secret-based: the fragment is a raw 32-byte AES-256 key.
		// Use it directly to unwrap the file key (no PBKDF2 derivation).
		// The file key is stored in link_encrypted_file_key / link_file_key_nonce,
		// falling back to encrypted_file_key / file_key_nonce.
		// This matches e2e_download.html:decryptWithLinkKey exactly.
		linkSecret := fragmentBytes
		if len(linkSecret) != KeySize {
			return fmt.Errorf("invalid link secret in share URL: got %d bytes, expected %d.\n"+
				"This usually means the share link is incomplete or was copied incorrectly.\n"+
				"Ask the file owner for a fresh share link", len(linkSecret), KeySize)
		}

		candidates := [][2]string{
			{keyInfo.LinkEncFileKey, keyInfo.LinkFileKeyNonce},
			{keyInfo.FolderLinkEncFileKey, keyInfo.FolderLinkFileKeyNonce},
			{keyInfo.EncryptedFileKey, keyInfo.FileKeyNonce},
		}
		var lastUnwrap error
		unwrapped := false
		for _, cand := range candidates {
			if cand[0] == "" || cand[1] == "" {
				continue
			}
			encFileKey, decErr := decodeBase64(cand[0])
			if decErr != nil {
				lastUnwrap = decErr
				continue
			}
			keyNonce, decErr := decodeBase64(cand[1])
			if decErr != nil {
				lastUnwrap = decErr
				continue
			}
			fk, unwrapErr := unwrapFileKey(encFileKey, keyNonce, linkSecret)
			if unwrapErr != nil {
				lastUnwrap = unwrapErr
				continue
			}
			fileKey = fk
			unwrapped = true
			break
		}
		if !unwrapped {
			if lastUnwrap != nil {
				return fmt.Errorf("decryption failed — share link may be corrupted: %w", lastUnwrap)
			}
			return fmt.Errorf("no encrypted file key available for this file")
		}
	}

	// 4. Try to decrypt the real filename from encrypted_name + name_nonce
	if keyInfo.EncryptedName != "" && keyInfo.NameNonce != "" {
		realName, err := decryptFileName(keyInfo.EncryptedName, keyInfo.NameNonce, fileKey)
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
	out, err := os.CreateTemp(filepath.Dir(outputPath), ".onegy-download-*")
	if err != nil {
		return fmt.Errorf("could not create temporary output file: %w", err)
	}
	tmpOutputPath := out.Name()
	defer os.Remove(tmpOutputPath)
	if err := out.Chmod(0600); err != nil {
		out.Close()
		return fmt.Errorf("could not secure temporary output file: %w", err)
	}
	written, decErr := decryptFileStream(encResp.Body, out, fileKey)
	if decErr != nil {
		out.Close()
		if cleanupErr := os.Remove(tmpOutputPath); cleanupErr != nil {
			return fmt.Errorf("file decryption failed: %w; additionally, could not remove partial plaintext %s: %v", decErr, tmpOutputPath, cleanupErr)
		}
		return fmt.Errorf("file decryption failed: %w", decErr)
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return fmt.Errorf("could not sync decrypted file: %w", err)
	}
	closeErr := out.Close()
	if closeErr != nil {
		if cleanupErr := os.Remove(tmpOutputPath); cleanupErr != nil {
			return fmt.Errorf("could not write file: %w; additionally, could not remove partial plaintext %s: %v", closeErr, tmpOutputPath, cleanupErr)
		}
		return fmt.Errorf("could not write file: %w", closeErr)
	}
	outputMode := os.FileMode(0600)
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
		mask := syscall.Umask(0)
		syscall.Umask(mask)
		outputMode = os.FileMode(0666 &^ mask)
	}
	if err := os.Chmod(tmpOutputPath, outputMode); err != nil {
		return fmt.Errorf("could not set output permissions: %w", err)
	}
	// The hard link is an atomic no-clobber publication because the temporary
	// file and destination are on the same filesystem.
	if err := os.Link(tmpOutputPath, outputPath); err != nil {
		return fmt.Errorf("could not publish decrypted file: %w", err)
	}
	if err := os.Remove(tmpOutputPath); err != nil {
		return fmt.Errorf("file was saved as %s, but temporary file cleanup failed: %w", outputPath, err)
	}

	fmt.Fprintf(os.Stderr, "done\n")
	fmt.Fprintf(os.Stderr, "Saved: %s (%s)\n", outputPath, formatSize(written))
	return nil
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
		if r < 32 || r == 127 || unicode.IsControl(r) {
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

// ─── Utilities ──────────────────────────────────────────────────────────────

func formatSize(bytes int64) string {
	const (
		KB = 1024
		MB = 1024 * KB
		GB = 1024 * MB
	)
	switch {
	case bytes >= GB:
		return fmt.Sprintf("%.1f GB", float64(bytes)/float64(GB))
	case bytes >= MB:
		return fmt.Sprintf("%.1f MB", float64(bytes)/float64(MB))
	case bytes >= KB:
		return fmt.Sprintf("%.1f KB", float64(bytes)/float64(KB))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `onegy — End-to-end encrypted file sharing from the terminal

Usage:
  onegy upload <file>              Encrypt and upload a file
  onegy download <url>             Download and decrypt from a share URL
  onegy version                    Print version info

Flags:
  --insecure                       Skip TLS certificate verification

Examples:
  onegy upload secret-doc.pdf
  onegy download "https://%s/f/abc123/file.pdf#passphrase=..."
  onegy download "https://%s/f/abc123/file.pdf#Ekfv1NU5di..."

Supported share URL formats:
  #passphrase=<base64>             Temp upload (CLI or browser)
  #<link_secret>                   Shared file/folder link

The server never sees your encryption key. All encryption
and decryption happens locally on your machine.
`, serverDomain, serverDomain)
}

// ─── Main ───────────────────────────────────────────────────────────────────

func main() {
	args := os.Args[1:]

	// Parse flags
	insecure := false
	skipUpdate := false
	filtered := make([]string, 0, len(args))
	for _, arg := range args {
		switch arg {
		case "--insecure", "-k":
			insecure = true
		case "--skip-update":
			skipUpdate = true
		default:
			filtered = append(filtered, arg)
		}
	}
	args = filtered

	if len(args) == 0 {
		printUsage()
		os.Exit(1)
	}

	command := args[0]

	// Version command doesn't need update check
	if command == "version" {
		hash, _ := selfHash()
		fmt.Printf("onegy CLI for %s\n", serverDomain)
		fmt.Printf("Platform:  %s\n", platform())
		if hash != "" {
			fmt.Printf("SHA-256:   %s\n", hash)
		}
		return
	}

	// Auto-update check (non-blocking on failure)
	if !skipUpdate {
		client := httpClient(insecure)
		if checkForUpdate(client, insecure) {
			// Binary was replaced — re-exec with --skip-update to avoid loop
			// Insert --skip-update right after the binary name
			newArgs := make([]string, 0, len(os.Args)+1)
			newArgs = append(newArgs, os.Args[0], "--skip-update")
			newArgs = append(newArgs, os.Args[1:]...)
			os.Args = newArgs
			fmt.Fprintf(os.Stderr, "Update installed; restarting with the new binary...\n")
			if err := reExec(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: update is installed but restart failed: %v; continuing this command with the currently running version\n", err)
			}
		}
	}

	fmt.Fprintf(os.Stderr, "onegy — %s\n", baseURL())

	switch command {
	case "upload":
		if len(args) < 2 {
			fmt.Fprintf(os.Stderr, "Error: missing file path\nUsage: onegy upload <file>\n")
			os.Exit(1)
		}
		filePath := args[1]
		if err := cmdUpload(filePath, insecure); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

	case "download":
		if len(args) < 2 {
			fmt.Fprintf(os.Stderr, "Error: missing URL\nUsage: onegy download <url>\n")
			os.Exit(1)
		}
		rawURL := args[1]
		if err := cmdDownload(rawURL, insecure); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", command)
		printUsage()
		os.Exit(1)
	}
}
