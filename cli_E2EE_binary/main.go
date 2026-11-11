package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
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

// ─── Utilities ──────────────────────────────────────────────────────────────

// sanitizeTerminalText drops control and format (Cf: bidi overrides, zero-width)
// runes so server-supplied text cannot inject terminal escapes or reorder output.
func sanitizeTerminalText(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return ' '
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
}

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
