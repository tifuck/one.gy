package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tifuck/one.gy/client/e2ee"
)

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

// uploadCrypto is the per-upload key material. It is generated once so a
// retried attempt reuses the same idempotency key and crypto metadata.
type uploadCrypto struct {
	fileKey         []byte
	passphrase      string
	salt            []byte
	wrappedKey      []byte
	keyNonce        []byte
	encryptedName   []byte
	nameNonce       []byte
	storedExtension string
	uploadID        string
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

	crypt, err := newUploadCrypto(origName)
	if err != nil {
		return err
	}

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
		attemptResult, retryErr, err := sendUploadAttempt(client, filePath, info, attempt, crypt)
		if err != nil {
			return err
		}
		if retryErr != nil {
			if attempt < maxUploadAttempts {
				time.Sleep(500 * time.Millisecond)
				continue
			}
			return retryErr
		}
		result = attemptResult
		break
	}

	canonicalDownloadURL, err := validateUploadResponse(result)
	if err != nil {
		return fmt.Errorf("server returned HTTP 200 with an invalid upload response: %w; the upload may have completed (upload ID %s)", err, crypt.uploadID)
	}

	fmt.Fprintf(os.Stderr, "done\n\n")

	// 7. Construct share URL with passphrase in fragment
	// Passphrase encoding: base64(utf8(passphrase))
	// Since our passphrase is ASCII-only, this is just base64(passphrase)
	passphraseB64 := e2ee.EncodeBase64([]byte(crypt.passphrase))
	shareURL := canonicalDownloadURL + "#passphrase=" + passphraseB64

	fmt.Printf("SHARE URL (EXPIRES IN 24H):\n%s\n\n", shareURL)
	fmt.Fprintf(os.Stderr, "Anyone with this URL can decrypt and download the file.\n")
	fmt.Fprintf(os.Stderr, "The server never sees your encryption key.\n")

	return nil
}

func newUploadCrypto(origName string) (*uploadCrypto, error) {
	// 1. Generate random file key (32 bytes)
	fileKey, err := e2ee.RandomBytes(e2ee.KeySize)
	if err != nil {
		return nil, fmt.Errorf("could not generate file key: %w", err)
	}

	// 2. Generate passphrase and derive wrapping key
	passphrase, err := e2ee.GeneratePassphrase()
	if err != nil {
		return nil, fmt.Errorf("could not generate passphrase: %w", err)
	}

	salt, err := e2ee.RandomBytes(e2ee.KeySize) // 32-byte PBKDF2 salt
	if err != nil {
		return nil, fmt.Errorf("could not generate salt: %w", err)
	}

	wrappingKey := e2ee.DerivePassphraseKey(passphrase, salt)

	// 3. Wrap file key with passphrase-derived key
	wrappedKey, keyNonce, err := e2ee.WrapKey(fileKey, wrappingKey)
	if err != nil {
		return nil, fmt.Errorf("could not wrap file key: %w", err)
	}

	encryptedName, nameNonce, err := e2ee.EncryptName(origName, fileKey)
	if err != nil {
		return nil, fmt.Errorf("could not encrypt filename: %w", err)
	}
	storedExtension := e2ee.ExtractExtension(origName)
	uploadIDBytes, err := e2ee.RandomBytes(32)
	if err != nil {
		return nil, fmt.Errorf("could not generate upload idempotency key: %w", err)
	}

	return &uploadCrypto{
		fileKey:         fileKey,
		passphrase:      passphrase,
		salt:            salt,
		wrappedKey:      wrappedKey,
		keyNonce:        keyNonce,
		encryptedName:   encryptedName,
		nameNonce:       nameNonce,
		storedExtension: storedExtension,
		uploadID:        hex.EncodeToString(uploadIDBytes),
	}, nil
}

// sendUploadAttempt streams one upload attempt. err is final; retryErr is an
// ambiguous failure the caller may retry, worded for when no retry is left.
func sendUploadAttempt(client *http.Client, filePath string, info os.FileInfo, attempt int, crypt *uploadCrypto) (result uploadResponse, retryErr error, err error) {
	uploadCtx, cancelUpload := context.WithCancel(context.Background())
	pipeReader, pipeWriter := io.Pipe()
	writer := multipart.NewWriter(pipeWriter)
	streamDone := make(chan uploadStreamResult, 1)

	go func() {
		stream := uploadStreamResult{}
		defer func() {
			if stream.err != nil {
				cancelUpload()
				pipeWriter.CloseWithError(stream.err)
			} else {
				pipeWriter.Close()
			}
			streamDone <- stream
		}()
		stream = writeUploadBody(writer, filePath, info, attempt, crypt)
	}()

	req, err := http.NewRequestWithContext(uploadCtx, "POST", baseURL()+"/upload", pipeReader)
	if err != nil {
		cancelUpload()
		pipeReader.Close()
		<-streamDone
		return result, nil, fmt.Errorf("could not create upload request: %w", err)
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
			return result, nil, streamResult.err
		}
		return result, fmt.Errorf("upload request failed: %w; the server response was ambiguous and the upload may have completed (upload ID %s)", requestErr, crypt.uploadID), nil
	}

	respBody, readErr := readBoundedResponse(resp.Body)
	resp.Body.Close()
	cancelUpload()
	pipeReader.Close()
	streamResult := <-streamDone
	if streamResult.err != nil && streamResult.local {
		return result, nil, streamResult.err
	}

	if readErr != nil {
		if resp.StatusCode != http.StatusOK {
			return result, nil, fmt.Errorf("could not read upload response: %w", readErr)
		}
		if strings.HasPrefix(readErr.Error(), "response exceeds ") {
			return result, nil, fmt.Errorf("server returned HTTP 200 but its response was invalid: %w", readErr)
		}
		return result, fmt.Errorf("server returned HTTP 200 but its response could not be read: %w; the upload may have completed (upload ID %s)", readErr, crypt.uploadID), nil
	}

	if resp.StatusCode != http.StatusOK {
		var errResp uploadResponse
		if json.Unmarshal(respBody, &errResp) == nil && errResp.Error != "" {
			return result, nil, fmt.Errorf("upload failed: %s", sanitizeTerminalText(errResp.Error))
		}
		return result, nil, fmt.Errorf("upload failed with HTTP %d: %s", resp.StatusCode, sanitizeTerminalText(string(respBody)))
	}

	if err := json.Unmarshal(respBody, &result); err != nil {
		return result, nil, fmt.Errorf("server returned HTTP 200 but its response was invalid: %w; the upload may have completed (upload ID %s)", err, crypt.uploadID)
	}
	return result, nil, nil
}

// writeUploadBody encrypts the source into the multipart body (file part
// first, then the crypto metadata fields) for one attempt.
func writeUploadBody(writer *multipart.Writer, filePath string, info os.FileInfo, attempt int, crypt *uploadCrypto) uploadStreamResult {
	in, err := os.Open(filePath)
	if err != nil {
		return uploadStreamResult{fmt.Errorf("could not open file: %w", err), true}
	}
	defer in.Close()

	// Re-stat the open descriptor so each attempt encrypts exactly the
	// inode and size it opened, and detects mutation while reading it.
	st, err := in.Stat()
	if err != nil {
		return uploadStreamResult{fmt.Errorf("could not stat open file: %w", err), true}
	}
	if !st.Mode().IsRegular() {
		return uploadStreamResult{fmt.Errorf("not a regular file: %s", filePath), true}
	}
	if !os.SameFile(info, st) || st.Size() != info.Size() || !st.ModTime().Equal(info.ModTime()) {
		return uploadStreamResult{fmt.Errorf("source file changed before upload attempt %d; upload aborted", attempt), true}
	}

	part, err := writer.CreateFormFile("file", "encrypted.bin")
	if err != nil {
		return uploadStreamResult{err: fmt.Errorf("could not create form file: %w", err)}
	}
	trackedPart := &uploadPartWriter{w: part}
	if err := e2ee.EncryptStream(in, trackedPart, crypt.fileKey, st.Size()); err != nil {
		return uploadStreamResult{fmt.Errorf("encryption failed: %w", err), trackedPart.writeErr == nil}
	}

	fields := [][2]string{
		{"e2e", "true"},
		{"encrypted_file_key", e2ee.EncodeBase64(crypt.wrappedKey)},
		{"file_key_nonce", e2ee.EncodeBase64(crypt.keyNonce)},
		{"file_key_salt", e2ee.EncodeBase64(crypt.salt)},
		{"encrypted_name", e2ee.EncodeBase64(crypt.encryptedName)},
		{"name_nonce", e2ee.EncodeBase64(crypt.nameNonce)},
		{"stored_extension", crypt.storedExtension},
		{"is_temp", "true"},
		{"upload_id", crypt.uploadID},
		{"user_id", crypt.uploadID},
	}
	for _, field := range fields {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			return uploadStreamResult{err: fmt.Errorf("could not write form field %s: %w", field[0], err)}
		}
	}

	if err := writer.Close(); err != nil {
		return uploadStreamResult{err: fmt.Errorf("could not finalize form: %w", err)}
	}
	return uploadStreamResult{}
}
