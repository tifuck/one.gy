package e2ee

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestNodeCompat runs testdata/compat.js against tests/crypto_helper.js (the
// Node mirror of static/crypto.js). Skipped when node or the helper (not part
// of the public mirror) is missing.
func TestNodeCompat(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	helper, _ := filepath.Abs(filepath.Join("..", "..", "tests", "crypto_helper.js"))
	if _, err := os.Stat(helper); err != nil {
		t.Skip("tests/crypto_helper.js not available")
	}

	master := mustKey(t)
	plain := bytes.Repeat([]byte("ONE.GY compat \x00\xff "), 300)
	name := "Quarterly report – ünïcødé.pdf"
	folder := "Фото 2026"
	sum := sha256.Sum256(plain)
	meta := Meta{FileID: "0b6a4c1e-6c1e-4d8f-9a55-0d1f6e2a9c11", ContentVersion: 2, PlainSize: int64(len(plain)),
		PlainSHA256: hex.EncodeToString(sum[:]), MtimeNs: 1731076320000000000, Mode: 0o755}

	fileKey := mustKey(t)
	container, err := EncryptData(plain, fileKey)
	if err != nil {
		t.Fatal(err)
	}
	wrappedFK, fkNonce, _ := WrapKey(fileKey, master)
	encName, nameNonce, _ := EncryptName(name, fileKey)
	encMeta, metaNonce, _ := EncryptMeta(meta, fileKey)
	nameKey := mustKey(t)
	wrappedNK, nkNonce, _ := WrapKey(nameKey, master)
	encFolder, folderNonce, _ := EncryptName(folder, nameKey)
	shareToken := "5b0f3c2e-9a4d-4e1b-8c7f-2d6a9e1b3c4f"
	linkSecret, linkKey, err := DeriveLinkSecret(master, "folder", shareToken)
	if err != nil {
		t.Fatal(err)
	}
	wrappedLink, linkNonce, _ := WrapKey(fileKey, linkKey)

	in, _ := json.Marshal(map[string]any{
		"helper": helper, "password": "correct horse battery staple", "salt": splitVectorSalt,
		"master_key_b64": EncodeBase64(master), "plaintext_b64": EncodeBase64(plain), "name": name, "meta": meta,
		"share_token": shareToken,
		"go": map[string]string{
			"container_b64": EncodeBase64(container), "encrypted_file_key": EncodeBase64(wrappedFK),
			"file_key_nonce": EncodeBase64(fkNonce), "encrypted_name": EncodeBase64(encName),
			"name_nonce": EncodeBase64(nameNonce), "encrypted_meta": encMeta, "meta_nonce": metaNonce,
			"encrypted_name_key": EncodeBase64(wrappedNK), "name_key_nonce": EncodeBase64(nkNonce),
			"encrypted_folder_name": EncodeBase64(encFolder), "folder_name_nonce": EncodeBase64(folderNonce),
			"folder_link_encrypted_file_key": EncodeBase64(wrappedLink), "folder_link_file_key_nonce": EncodeBase64(linkNonce),
		},
	})
	cmd := exec.Command(node, filepath.Join("testdata", "compat.js"))
	cmd.Stdin = bytes.NewReader(in)
	cmd.Stderr = os.Stderr
	outJSON, err := cmd.Output()
	if err != nil {
		t.Fatalf("compat.js failed: %v", err)
	}
	var out struct {
		LinkSecret     string `json:"link_secret"`
		GoLinkFileKey  string `json:"go_link_file_key_b64"`
		AuthToken      string `json:"auth_token"`
		WrappingKeyB64 string `json:"wrapping_key_b64"`
		GoPlaintextB64 string `json:"go_plaintext_b64"`
		GoName         string `json:"go_name"`
		GoFolderName   string `json:"go_folder_name"`
		GoMeta         Meta   `json:"go_meta"`
		JS             struct {
			ContainerB64     string `json:"container_b64"`
			EncryptedFileKey string `json:"encrypted_file_key"`
			FileKeyNonce     string `json:"file_key_nonce"`
			EncryptedName    string `json:"encrypted_name"`
			NameNonce        string `json:"name_nonce"`
			EncryptedMeta    string `json:"encrypted_meta"`
			MetaNonce        string `json:"meta_nonce"`
			FolderLinkKey    string `json:"folder_link_encrypted_file_key"`
			FolderLinkNonce  string `json:"folder_link_file_key_nonce"`
		} `json:"js"`
	}
	if err := json.Unmarshal(outJSON, &out); err != nil {
		t.Fatal(err)
	}

	// (a) split-key derivation
	auth, wrap, err := DeriveAuthAndWrappingKeys("correct horse battery staple", splitVectorSalt)
	if err != nil || auth != out.AuthToken || EncodeBase64(wrap) != out.WrappingKeyB64 {
		t.Fatalf("split-key mismatch: go=%s/%s js=%s/%s", auth, EncodeBase64(wrap), out.AuthToken, out.WrappingKeyB64)
	}
	// (b) Go -> JS
	if out.GoPlaintextB64 != EncodeBase64(plain) {
		t.Fatal("JS could not decrypt the Go container")
	}
	meta.V = MetaVersion
	if out.GoName != name || out.GoFolderName != folder || out.GoMeta != meta {
		t.Fatalf("JS decrypted name=%q folder=%q meta=%+v", out.GoName, out.GoFolderName, out.GoMeta)
	}
	// (c) JS -> Go
	jsFileKey, err := UnwrapKeyB64(out.JS.EncryptedFileKey, out.JS.FileKeyNonce, master)
	if err != nil {
		t.Fatal(err)
	}
	jsContainer, _ := DecodeBase64(out.JS.ContainerB64)
	got, err := DecryptData(jsContainer, jsFileKey)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("Go could not decrypt the JS container: %v", err)
	}
	var streamed bytes.Buffer
	if _, err := DecryptStream(bytes.NewReader(jsContainer), &streamed, jsFileKey); err != nil || !bytes.Equal(streamed.Bytes(), plain) {
		t.Fatalf("DecryptStream of JS container: %v", err)
	}
	if n, err := DecryptName(out.JS.EncryptedName, out.JS.NameNonce, jsFileKey); err != nil || n != name {
		t.Fatalf("JS name: %q %v", n, err)
	}
	if m, err := DecryptMeta(out.JS.EncryptedMeta, out.JS.MetaNonce, jsFileKey, meta.FileID, meta.ContentVersion); err != nil || m != meta {
		t.Fatalf("JS meta: %+v %v", m, err)
	}
	// (d) folder share-link secret and wraps
	if out.LinkSecret != linkSecret || out.GoLinkFileKey != EncodeBase64(fileKey) {
		t.Fatalf("link secret mismatch: go=%s js=%s (go wrap opened: %v)", linkSecret, out.LinkSecret, out.GoLinkFileKey == EncodeBase64(fileKey))
	}
	if k, err := UnwrapKeyB64(out.JS.FolderLinkKey, out.JS.FolderLinkNonce, linkKey); err != nil || !bytes.Equal(k, jsFileKey) {
		t.Fatalf("JS folder-link wrap: %v", err)
	}
}
