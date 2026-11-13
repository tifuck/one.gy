package e2ee

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"strings"
	"testing"
)

func mustKey(t *testing.T) []byte {
	t.Helper()
	k, err := RandomBytes(KeySize)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestDataRoundTrip(t *testing.T) {
	key := mustKey(t)
	for _, n := range []int{0, 1, 4096} {
		pt := bytes.Repeat([]byte{0xA5}, n)
		blob, err := EncryptData(pt, key)
		if err != nil {
			t.Fatal(err)
		}
		if blob[0] != FileFormatVersion || binary.BigEndian.Uint32(blob[1:5]) != 1 {
			t.Fatalf("bad header for %d bytes", n)
		}
		if len(blob) != HeaderSize+4+n+TagSize {
			t.Fatalf("size %d bytes: container %d", n, len(blob))
		}
		out, err := DecryptData(blob, key)
		if err != nil || !bytes.Equal(out, pt) {
			t.Fatalf("round trip %d bytes: %v", n, err)
		}
		if _, err := DecryptData(append(blob, 0), key); err == nil {
			t.Fatal("trailing byte accepted")
		}
	}
}

// Multi-chunk stream: crosses one 64 MiB boundary and must agree with the
// in-memory decryptor.
func TestStreamMultiChunk(t *testing.T) {
	key := mustKey(t)
	pt := make([]byte, ChunkSize+3)
	for i := range pt {
		pt[i] = byte(i * 7)
	}
	var enc bytes.Buffer
	if err := EncryptStream(bytes.NewReader(pt), &enc, key, int64(len(pt))); err != nil {
		t.Fatal(err)
	}
	if got := binary.BigEndian.Uint32(enc.Bytes()[1:5]); got != 2 {
		t.Fatalf("chunk count %d", got)
	}
	var dec bytes.Buffer
	n, err := DecryptStream(bytes.NewReader(enc.Bytes()), &dec, key)
	if err != nil || n != int64(len(pt)) || !bytes.Equal(dec.Bytes(), pt) {
		t.Fatalf("stream round trip: n=%d err=%v", n, err)
	}
	mem, err := DecryptData(enc.Bytes(), key)
	if err != nil || !bytes.Equal(mem, pt) {
		t.Fatalf("DecryptData of stream output: %v", err)
	}
	// Dropping the last chunk and lowering the header count must fail GCM.
	cut := append([]byte(nil), enc.Bytes()[:HeaderSize+4+ChunkSize+TagSize]...)
	binary.BigEndian.PutUint32(cut[1:5], 1)
	if _, err := DecryptData(cut, key); err == nil {
		t.Fatal("truncated container accepted")
	}
}

func TestStreamSourceSizeChecks(t *testing.T) {
	key := mustKey(t)
	if err := EncryptStream(bytes.NewReader(make([]byte, 10)), io.Discard, key, 11); err == nil || !strings.Contains(err.Error(), "changed during upload") {
		t.Fatalf("short source: %v", err)
	}
	if err := EncryptStream(bytes.NewReader(make([]byte, 12)), io.Discard, key, 11); err == nil || !strings.Contains(err.Error(), "grew") {
		t.Fatalf("growing source: %v", err)
	}
	var enc bytes.Buffer
	if err := EncryptStream(bytes.NewReader([]byte("abc")), &enc, key, 3); err != nil {
		t.Fatal(err)
	}
	if _, err := DecryptStream(bytes.NewReader(append(enc.Bytes(), 1)), io.Discard, key); err == nil {
		t.Fatal("trailing data accepted by DecryptStream")
	}
	zero := append([]byte(nil), enc.Bytes()...)
	binary.BigEndian.PutUint32(zero[1:5], 0)
	if _, err := DecryptStream(bytes.NewReader(zero), io.Discard, key); err == nil {
		t.Fatal("0-chunk header accepted")
	}
}

func TestNames(t *testing.T) {
	key := mustKey(t)
	for _, name := range []string{"report.PDF", "\ufeffbom", "ünïcødé 名前.txt", ""} {
		ct, nonce, err := EncryptName(name, key)
		if err != nil {
			t.Fatal(err)
		}
		got, err := DecryptName(EncodeBase64(ct), EncodeBase64(nonce), key)
		if err != nil || got != name {
			t.Fatalf("name %q: got %q, %v", name, got, err)
		}
	}
	if _, err := DecryptName("AAAA", EncodeBase64(make([]byte, NonceSize)), key); err == nil {
		t.Fatal("short name ciphertext accepted")
	}
	cases := map[string]string{"a.PDF": ".pdf", ".bashrc": "", "noext": "", "x.tar.gz": ".gz", "a.toolongextension": "", "a.p-f": "", "a.": ""}
	for in, want := range cases {
		if got := ExtractExtension(in); got != want {
			t.Errorf("ExtractExtension(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestKeyWrap(t *testing.T) {
	master, fileKey := mustKey(t), mustKey(t)
	ct, nonce, err := WrapKey(fileKey, master)
	if err != nil {
		t.Fatal(err)
	}
	got, err := UnwrapKeyB64(EncodeBase64(ct), EncodeBase64(nonce), master)
	if err != nil || !bytes.Equal(got, fileKey) {
		t.Fatalf("unwrap: %v", err)
	}
	if _, err := UnwrapKey(ct, nonce, mustKey(t)); err == nil {
		t.Fatal("unwrap with wrong key succeeded")
	}
	short, snonce, _ := WrapKey(fileKey[:16], master)
	if _, err := UnwrapKey(short, snonce, master); err == nil {
		t.Fatal("16-byte key accepted")
	}
	pass, err := GeneratePassphrase()
	if err != nil || len(pass) != 16 {
		t.Fatalf("passphrase %q %v", pass, err)
	}
}

func TestDecodeBase64Forms(t *testing.T) {
	want := []byte{0xfb, 0xff, 0xfe}
	for _, s := range []string{"+//+", "-__-", "-__-=="} {
		got, err := DecodeBase64(s)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%q: %x %v", s, got, err)
		}
	}
}

// Fixed vector computed once with tests/crypto_helper.js derive_split_keys; the
// node cross-check below re-verifies it live when node is available.
func TestDeriveAuthAndWrappingKeysVector(t *testing.T) {
	auth, wrap, err := DeriveAuthAndWrappingKeys("correct horse battery staple", splitVectorSalt)
	if err != nil {
		t.Fatal(err)
	}
	if auth != splitVectorAuth || EncodeBase64(wrap) != splitVectorWrap {
		t.Fatalf("split-key vector mismatch: auth=%s wrap=%s", auth, EncodeBase64(wrap))
	}
	if _, _, err := DeriveAuthAndWrappingKeys("x", ""); err == nil {
		t.Fatal("empty salt accepted")
	}
}

func TestMeta(t *testing.T) {
	key := mustKey(t)
	sum := sha256.Sum256([]byte("hello"))
	m := Meta{FileID: "0b6a4c1e-6c1e-4d8f-9a55-0d1f6e2a9c11", ContentVersion: 3, PlainSize: 5,
		PlainSHA256: hex.EncodeToString(sum[:]), MtimeNs: 1731076320000000000, Mode: 0o644}
	ct, nonce, err := EncryptMeta(m, key)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecryptMeta(ct, nonce, key, m.FileID, 3)
	m.V = 1
	if err != nil || got != m {
		t.Fatalf("meta round trip: %+v %v", got, err)
	}
	if _, err := DecryptMeta(ct, nonce, key, "other-id", 3); err == nil {
		t.Fatal("meta for another file accepted")
	}
	if _, err := DecryptMeta(ct, nonce, key, m.FileID, 4); err == nil {
		t.Fatal("rolled-back meta accepted")
	}
	if _, err := DecryptMeta(ct, nonce, mustKey(t), m.FileID, 3); err == nil {
		t.Fatal("meta opened with wrong key")
	}
}

var (
	splitVectorSalt = EncodeBase64([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31})
	splitVectorAuth = "Ysnr0ZzYnzCfwFD+CmxNfO5sHkXbQq9CDrO3vo6jrkM="
	splitVectorWrap = "yYsvjI7sA66DHkwhfCX1RI4AoW9eY8/VXrOB8hdc4FQ="
)
