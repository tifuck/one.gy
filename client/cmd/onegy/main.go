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
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/config"
)

// Embedded at compile time via -ldflags "-X main.serverDomain=..."
var serverDomain = "one.gy"

// Set to "1" (-X main.bundled=1) in the desktop app's build: that copy is
// updated with the app and must never replace itself.
var bundled = ""

// Hex Ed25519 public key of this server's CLI releases, embedded by build.sh
// (-X main.updatePublicKey=...). Empty: self-update is off (release_sign.go).
var updatePublicKey = ""

func baseURL() string {
	return "https://" + serverDomain
}

func platform() string {
	goOS := runtime.GOOS
	goArch := runtime.GOARCH
	return goOS + "-" + goArch
}

// httpClient returns an HTTP client.
// insecure skips TLS verification (dev/self-signed certs; devtls builds only).
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
	if insecure && api.DevTLS {
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

// updateClient is client restricted to redirects within the origin of the
// first request: update manifests and binaries come from this server only.
func updateClient(client *http.Client) *http.Client {
	c := *client
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return fmt.Errorf("too many redirects")
		}
		if req.URL.Scheme != via[0].URL.Scheme || !strings.EqualFold(req.URL.Host, via[0].URL.Host) {
			return fmt.Errorf("refusing update redirect to another origin")
		}
		return nil
	}
	return &c
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
	Version     string `json:"version"`
	Signature   string `json:"signature"`
}

// parseVersion reads MAJOR.MINOR.PATCH[-pre] (client/VERSION's format).
func parseVersion(s string) (nums [3]int, pre string, ok bool) {
	s, pre, _ = strings.Cut(s, "-")
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return nums, "", false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || p == "" || (len(p) > 1 && p[0] == '0') {
			return nums, "", false
		}
		nums[i] = n
	}
	return nums, pre, true
}

// newerVersion reports whether a is a strictly later release than b (semver
// precedence; a pre-release sorts before its release).
func newerVersion(a, b string) bool {
	an, ap, aok := parseVersion(a)
	bn, bp, bok := parseVersion(b)
	if !aok || !bok {
		return false
	}
	for i := range an {
		if an[i] != bn[i] {
			return an[i] > bn[i]
		}
	}
	switch {
	case ap == bp:
		return false
	case ap == "":
		return true
	case bp == "":
		return false
	}
	as, bs := strings.Split(ap, "."), strings.Split(bp, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		if as[i] == bs[i] {
			continue
		}
		x, xerr := strconv.Atoi(as[i])
		y, yerr := strconv.Atoi(bs[i])
		switch {
		case xerr == nil && yerr == nil:
			return x > y
		case xerr == nil: // numeric identifiers sort first
			return false
		case yerr == nil:
			return true
		}
		return as[i] > bs[i]
	}
	return len(as) > len(bs)
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
	pub, err := releasePublicKey()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: auto-update disabled: %v\n", err)
		return false
	}
	if pub == nil {
		return false
	}
	client = updateClient(client)
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
	// AUDIT FIX (F2): a different hash alone is no update; never install an
	// older or equal release (downgrade to a vulnerable build).
	if !newerVersion(ver.Version, config.Version) {
		return false
	}
	if err := verifyUpdateSignature(pub, ver); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: refusing update %s: %v; continuing with the current version\n", sanitizeTerminalText(ver.Version), err)
		return false
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
	if err != nil || currentVer.SHA256 != ver.SHA256 || currentVer.DownloadURL != ver.DownloadURL || currentVer.Version != ver.Version || currentVer.Signature != ver.Signature {
		fmt.Fprintf(os.Stderr, "Warning: update generation changed before installation; retry on the next run\n")
		return false
	}

	if err := os.Rename(tmpPath, exePath); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not replace binary: %v\n", err)
		return false
	}

	return true
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
  onegy daemon [flags]             Run the sync engine (ONE.GY Desktop, or a service;
                                   --secrets-file on a server without a key store)
  onegy ipc call <method> [json]   Call the running sync engine (any IPC method)
  onegy ipc watch                  Print sync engine events

%s
Flags:
  --insecure                       Skip TLS certificate verification (devtls builds only)
  --allow-legacy-v1                download: accept the legacy v1 file format, which
                                   cannot detect a server cutting off the end of the file

Examples:
  onegy upload secret-doc.pdf
  onegy download "https://%s/f/abc123/file.pdf#passphrase=..."
  onegy download "https://%s/f/abc123/file.pdf#Ekfv1NU5di..."

Supported share URL formats:
  #passphrase=<base64>             Temp upload (CLI or browser)
  #<link_secret>                   Shared file/folder link

The server never sees your encryption key. All encryption
and decryption happens locally on your machine.
`, syncUsage, serverDomain, serverDomain)
}

// ─── Main ───────────────────────────────────────────────────────────────────

func main() {
	args := os.Args[1:]

	// The engine subcommands have their own flags and never self-update.
	if len(args) > 0 {
		switch args[0] {
		case "daemon":
			if err := runDaemon(args[1:]); err != nil {
				fmt.Fprintln(os.Stderr, "onegy daemon:", err)
				os.Exit(1)
			}
			return
		case "ipc":
			os.Exit(runIPC(args[1:]))
		case "release-sign":
			os.Exit(runReleaseSign(args[1:]))
		case "login", "unlock", "lock", "logout", "status", "sync", "issues":
			os.Exit(runSyncCLI(args[0], args[1:]))
		}
	}

	// Parse flags
	insecure := false
	skipUpdate := false
	allowLegacyV1 := false
	filtered := make([]string, 0, len(args))
	for _, arg := range args {
		switch arg {
		case "--insecure", "-k":
			insecure = true
		case "--skip-update":
			skipUpdate = true
		case "--allow-legacy-v1":
			allowLegacyV1 = true
		default:
			filtered = append(filtered, arg)
		}
	}
	args = filtered
	// AUDIT FIX (F7): like the engine, release builds always verify certificates.
	if insecure && !api.DevTLS {
		fmt.Fprintf(os.Stderr, "Error: --insecure only works in devtls builds\n")
		os.Exit(1)
	}

	if len(args) == 0 {
		printUsage()
		os.Exit(1)
	}

	command := args[0]

	// Version command doesn't need update check
	if command == "version" {
		hash, _ := selfHash()
		fmt.Printf("onegy %s for %s\n", config.Version, serverDomain)
		fmt.Printf("Platform:  %s\n", platform())
		if hash != "" {
			fmt.Printf("SHA-256:   %s\n", hash)
		}
		return
	}

	// Auto-update check (non-blocking on failure)
	if !skipUpdate && bundled == "" {
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
		if err := cmdDownload(rawURL, insecure, allowLegacyV1); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", command)
		printUsage()
		os.Exit(1)
	}
}
