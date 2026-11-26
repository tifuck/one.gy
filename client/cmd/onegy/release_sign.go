package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ─── Release signing ────────────────────────────────────────────────────────
//
// build.sh signs every manifest entry with an Ed25519 key kept outside the
// repo and the served tree (CLI_SIGNING_KEY_FILE) and embeds the public key in
// the binaries it builds (-X main.updatePublicKey=<hex>). Self-update installs
// only an entry whose signature verifies under that key, so a compromised
// server, CDN path or TLS certificate cannot push code. The subcommand
// `onegy release-sign` is the build-host side and is not in the usage text.

// updateSignedMessage is the exact byte string a manifest signature covers:
// everything that decides what gets installed. The domain keeps a key shared
// by two deployments from replaying one's release on the other.
func updateSignedMessage(domain, version, platform, sha256Hex string) []byte {
	return []byte("onegy-cli-update-v1\n" + domain + "\n" + version + "\n" + platform + "\n" + sha256Hex + "\n")
}

// releasePublicKey returns the embedded release key, or nil when the build
// has none (go build, tests, the desktop app's copy): self-update is then off.
func releasePublicKey() (ed25519.PublicKey, error) {
	if updatePublicKey == "" {
		return nil, nil
	}
	key, err := hex.DecodeString(updatePublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("embedded update public key is malformed")
	}
	return ed25519.PublicKey(key), nil
}

func validSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// verifyUpdateSignature checks ver.Signature over (domain, version, platform,
// sha256) for this binary's server and platform.
func verifyUpdateSignature(pub ed25519.PublicKey, ver versionResponse) error {
	if ver.Signature == "" {
		return fmt.Errorf("the update manifest is not signed")
	}
	if !validSHA256Hex(ver.SHA256) {
		return fmt.Errorf("the update manifest has a malformed sha256")
	}
	if _, _, ok := parseVersion(ver.Version); !ok || strings.ContainsAny(ver.Version, "\r\n") {
		return fmt.Errorf("the update manifest has a malformed version")
	}
	sig, err := hex.DecodeString(ver.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("the update signature is malformed")
	}
	if !ed25519.Verify(pub, updateSignedMessage(serverDomain, ver.Version, platform(), ver.SHA256), sig) {
		return fmt.Errorf("the update signature does not verify")
	}
	return nil
}

// runReleaseSign implements
//
//	onegy release-sign keygen <key file>                      prints the hex public key, generating the key if missing
//	onegy release-sign sign <key file> <domain> <manifest.json> adds a "signature" to every manifest entry
func runReleaseSign(args []string) int {
	var err error
	switch {
	case len(args) == 2 && args[0] == "keygen":
		var key ed25519.PrivateKey
		key, err = loadOrCreateSigningKey(args[1])
		if err == nil {
			fmt.Println(hex.EncodeToString(key.Public().(ed25519.PublicKey)))
		}
	case len(args) == 4 && args[0] == "sign":
		var key ed25519.PrivateKey
		key, err = loadSigningKey(args[1])
		if err == nil {
			err = signManifest(key, args[2], args[3])
		}
	default:
		err = fmt.Errorf("usage: onegy release-sign keygen <key file> | sign <key file> <domain> <manifest.json>")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "onegy release-sign:", err)
		return 1
	}
	return 0
}

func loadOrCreateSigningKey(path string) (ed25519.PrivateKey, error) {
	key, err := loadSigningKey(path)
	if !errors.Is(err, fs.ErrNotExist) {
		return key, err
	}
	_, key, err = ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	if err := pem.Encode(f, &pem.Block{Type: "PRIVATE KEY", Bytes: der}); err != nil {
		f.Close()
		os.Remove(path)
		return nil, err
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return nil, err
	}
	fmt.Fprintf(os.Stderr, "Generated a new CLI release signing key at %s; back it up and keep it off the server's served tree\n", path)
	return key, nil
}

func loadSigningKey(path string) (ed25519.PrivateKey, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is accessible by other users (mode %v); chmod 600 it", path, info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%s is not a PEM private key", path)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s is not an Ed25519 key", path)
	}
	return key, nil
}

// signManifest adds "signature" to each platform entry of build.sh's
// manifest.json and keeps every other field's value, so older clients (which
// check only sha256) keep reading it.
func signManifest(key ed25519.PrivateKey, domain, manifestPath string) error {
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return err
	}
	var manifest map[string]map[string]json.RawMessage
	if err := json.Unmarshal(data, &manifest); err != nil {
		return fmt.Errorf("could not parse %s: %w", manifestPath, err)
	}
	if len(manifest) == 0 {
		return fmt.Errorf("%s has no platforms", manifestPath)
	}
	for plat, entry := range manifest {
		var ver versionResponse
		for field, dst := range map[string]*string{"version": &ver.Version, "sha256": &ver.SHA256} {
			if err := json.Unmarshal(entry[field], dst); err != nil {
				return fmt.Errorf("%s: %s: bad %q: %w", manifestPath, plat, field, err)
			}
		}
		if !validSHA256Hex(ver.SHA256) {
			return fmt.Errorf("%s: %s: malformed sha256", manifestPath, plat)
		}
		if _, _, ok := parseVersion(ver.Version); !ok {
			return fmt.Errorf("%s: %s: malformed version", manifestPath, plat)
		}
		msg := updateSignedMessage(domain, ver.Version, plat, ver.SHA256)
		sig := ed25519.Sign(key, msg)
		if !ed25519.Verify(key.Public().(ed25519.PublicKey), msg, sig) {
			return fmt.Errorf("%s: signature self-check failed", plat)
		}
		entry["signature"], _ = json.Marshal(hex.EncodeToString(sig))
	}
	out, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manifestPath, append(out, '\n'), 0o644)
}
