package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tifuck/one.gy/client/e2ee"
	"github.com/tifuck/one.gy/client/internal/config"
)

func setGlobal[T any](t *testing.T, p *T, v T) {
	old := *p
	*p = v
	t.Cleanup(func() { *p = old })
}

// signedEntry runs the real build-side signer over a one-platform manifest.
func signedEntry(t *testing.T, key ed25519.PrivateKey, domain, plat, version, sha string) versionResponse {
	t.Helper()
	path := filepath.Join(t.TempDir(), "manifest.json")
	manifest := map[string]map[string]any{plat: {
		"sha256": sha, "download_url": "/static/cli/" + plat + "/onegy", "size": 12345678, "version": version,
	}}
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := signManifest(key, domain, path); err != nil {
		t.Fatalf("signManifest: %v", err)
	}
	data, _ = os.ReadFile(path)
	if !bytes.Contains(data, []byte(`"size": 12345678`)) {
		t.Fatalf("signManifest changed other fields: %s", data)
	}
	var signed map[string]versionResponse
	if err := json.Unmarshal(data, &signed); err != nil {
		t.Fatal(err)
	}
	return signed[plat]
}

func newKey(t *testing.T) ed25519.PrivateKey {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestVerifyUpdateSignature(t *testing.T) {
	setGlobal(t, &serverDomain, "files.example")
	key := newKey(t)
	pub := key.Public().(ed25519.PublicKey)
	sha := strings.Repeat("ab", 32)
	good := signedEntry(t, key, "files.example", platform(), "1.2.3", sha)
	if err := verifyUpdateSignature(pub, good); err != nil {
		t.Fatalf("valid signature refused: %v", err)
	}

	tamperedHash := good
	tamperedHash.SHA256 = strings.Repeat("cd", 32)
	tamperedVersion := good
	tamperedVersion.Version = "1.2.4"
	missing := good
	missing.Signature = ""
	otherDomain := signedEntry(t, key, "other.example", platform(), "1.2.3", sha)
	otherPlatform := signedEntry(t, key, "files.example", "plan9-386", "1.2.3", sha)
	for name, c := range map[string]struct {
		pub ed25519.PublicKey
		ver versionResponse
	}{
		"tampered hash":    {pub, tamperedHash},
		"tampered version": {pub, tamperedVersion},
		"missing":          {pub, missing},
		"wrong key":        {newKey(t).Public().(ed25519.PublicKey), good},
		"other domain":     {pub, otherDomain},
		"other platform":   {pub, otherPlatform},
	} {
		if err := verifyUpdateSignature(c.pub, c.ver); err == nil {
			t.Errorf("%s: signature accepted", name)
		}
	}
}

func TestReleaseSigningKeyFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no POSIX file modes on Windows")
	}
	path := filepath.Join(t.TempDir(), "sub", "cli-signing.key")
	key, err := loadOrCreateSigningKey(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode = %v, %v", info.Mode().Perm(), err)
	}
	again, err := loadOrCreateSigningKey(path)
	if err != nil || !key.Equal(again) {
		t.Fatalf("existing key not reused: %v", err)
	}
	os.Chmod(path, 0o644)
	if _, err := loadSigningKey(path); err == nil {
		t.Fatal("group/world-readable key accepted")
	}
}

func TestReleasePublicKey(t *testing.T) {
	setGlobal(t, &updatePublicKey, "")
	if pub, err := releasePublicKey(); pub != nil || err != nil {
		t.Fatalf("unset key: %v, %v", pub, err)
	}
	setGlobal(t, &updatePublicKey, "abcd")
	if _, err := releasePublicKey(); err == nil {
		t.Fatal("malformed key accepted")
	}
}

func TestUpdateClientRedirects(t *testing.T) {
	var otherHits atomic.Int32
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherHits.Add(1)
	}))
	defer other.Close()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/same":
			http.Redirect(w, r, "/target", http.StatusFound)
		case "/cross":
			http.Redirect(w, r, other.URL+"/target", http.StatusFound)
		case "/target":
			w.Write([]byte("ok"))
		}
	}))
	defer srv.Close()
	client := updateClient(srv.Client())
	resp, err := client.Get(srv.URL + "/same")
	if err != nil {
		t.Fatalf("same-origin redirect refused: %v", err)
	}
	resp.Body.Close()
	if _, err := client.Get(srv.URL + "/cross"); err == nil || otherHits.Load() != 0 {
		t.Fatalf("cross-origin redirect followed (err=%v, hits=%d)", err, otherHits.Load())
	}
}

// updateServer serves *entry (read per request: it is signed for the server's
// own address) at /cli/version and binary at the download URL; redirect, when
// set, sends the binary request elsewhere instead.
func updateServer(t *testing.T, entry *versionResponse, binary []byte, redirect string) (*httptest.Server, *atomic.Int32) {
	var downloads atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cli/version":
			json.NewEncoder(w).Encode(*entry)
		case "/static/cli/" + platform() + "/onegy":
			downloads.Add(1)
			if redirect != "" {
				http.Redirect(w, r, redirect, http.StatusFound)
				return
			}
			w.Write(binary)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &downloads
}

// TestCheckForUpdateRefuses drives the real update path against a test server;
// every case must stop before anything is installed.
func TestCheckForUpdateRefuses(t *testing.T) {
	setGlobal(t, &config.Version, "1.0.0")
	key := newKey(t)
	setGlobal(t, &updatePublicKey, hex.EncodeToString(key.Public().(ed25519.PublicKey)))
	binary := []byte("not really a binary")
	sum := sha256.Sum256(binary)
	sha := hex.EncodeToString(sum[:])

	var otherHits atomic.Int32
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherHits.Add(1)
		w.Write(binary)
	}))
	defer other.Close()

	for _, c := range []struct {
		name, version, signedSHA, redirect string
		signer                             ed25519.PrivateKey
		unsigned, control                  bool
	}{
		// Control: a valid signature gets as far as the download, whose body
		// then fails the hash check, so nothing is installed.
		{name: "valid signature (control)", version: "2.0.0", signedSHA: sha, signer: key, control: true},
		{name: "unsigned", version: "2.0.0", signedSHA: sha, signer: key, unsigned: true},
		{name: "tampered hash", version: "2.0.0", signedSHA: strings.Repeat("00", 32), signer: key},
		{name: "wrong key", version: "2.0.0", signedSHA: sha, signer: newKey(t)},
		{name: "downgrade", version: "0.9.0", signedSHA: sha, signer: key},
		{name: "cross-host redirect", version: "2.0.0", signedSHA: sha, signer: key, redirect: other.URL + "/onegy"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var entry versionResponse
			served := binary
			if c.control {
				served = []byte("a different binary")
			}
			srv, downloads := updateServer(t, &entry, served, c.redirect)
			domain := strings.TrimPrefix(srv.URL, "https://")
			setGlobal(t, &serverDomain, domain)
			entry = signedEntry(t, c.signer, domain, platform(), c.version, c.signedSHA)
			entry.SHA256 = sha
			if c.unsigned {
				entry.Signature = ""
			}
			if checkForUpdate(srv.Client(), false) {
				t.Fatal("update installed")
			}
			if want := c.control || c.redirect != ""; (downloads.Load() != 0) != want {
				t.Fatalf("binary requested %d times, want requested=%v", downloads.Load(), want)
			}
			if otherHits.Load() != 0 {
				t.Fatal("redirect to another host was followed")
			}
		})
	}
}

func TestCheckForUpdateOffWithoutKey(t *testing.T) {
	setGlobal(t, &updatePublicKey, "")
	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer srv.Close()
	setGlobal(t, &serverDomain, strings.TrimPrefix(srv.URL, "https://"))
	if checkForUpdate(srv.Client(), false) || hits.Load() != 0 {
		t.Fatalf("update check ran without an embedded key (%d requests)", hits.Load())
	}
}

func TestCheckContainerVersion(t *testing.T) {
	key, _ := e2ee.RandomBytes(e2ee.KeySize)
	v2, err := e2ee.EncryptData([]byte("current format"), key)
	if err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(bytes.NewReader(v2))
	if err := checkContainerVersion(r, false); err != nil {
		t.Fatalf("v2 refused: %v", err)
	}
	var out bytes.Buffer
	if _, err := e2ee.DecryptStream(r, &out, key); err != nil || out.String() != "current format" {
		t.Fatalf("v2 stream after the check: %q, %v", out.String(), err)
	}

	v1 := append([]byte{1}, make([]byte, e2ee.HeaderSize)...)
	if err := checkContainerVersion(bufio.NewReader(bytes.NewReader(v1)), false); err == nil || !strings.Contains(err.Error(), "--allow-legacy-v1") {
		t.Fatalf("v1 accepted without --allow-legacy-v1: %v", err)
	}
	r = bufio.NewReader(bytes.NewReader(v1))
	if err := checkContainerVersion(r, true); err != nil {
		t.Fatalf("v1 refused despite --allow-legacy-v1: %v", err)
	}
	if b, _ := r.ReadByte(); b != 1 {
		t.Fatal("check consumed the header")
	}
}
