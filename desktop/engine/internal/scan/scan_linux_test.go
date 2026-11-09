package scan

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
)

func write(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func sum(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func TestScanTree(t *testing.T) {
	root := t.TempDir()
	write(t, root, ".onegyignore", "-:*.tmp\nexclude-larger:10\n")
	write(t, root, "a.txt", "hello")
	write(t, root, "skip.tmp", "x")
	write(t, root, "big.bin", "more than ten bytes")
	write(t, root, "docs/b.md", "bee")
	write(t, root, "bad/.onegyignore", "nope\n")
	write(t, root, "bad/inside.txt", "x")
	write(t, root, ".onegy/sync.json", "{}")
	write(t, root, "deny.txt", "secret")
	os.Symlink("a.txt", filepath.Join(root, "link"))
	syscall.Mkfifo(filepath.Join(root, "fifo"), 0o644)
	os.WriteFile(filepath.Join(root, "bad\xffname"), nil, 0o644)

	openFile = func(p string) (*os.File, error) {
		if strings.HasSuffix(p, "deny.txt") {
			return nil, &os.PathError{Op: "open", Path: p, Err: os.ErrPermission}
		}
		return localfs.Open(p)
	}
	defer func() { openFile = localfs.Open }()

	tr, err := Run(context.Background(), Options{Root: root, FSKind: "ext4"})
	if err != nil {
		t.Fatal(err)
	}
	if e := tr.Entries["a.txt"]; e == nil || e.SHA256 != sum("hello") || e.Size != 5 || e.ID == "" || e.Kind != localfs.KindFile {
		t.Fatalf("a.txt %+v", e)
	}
	if e := tr.Entries["docs"]; e == nil || e.Kind != localfs.KindDir {
		t.Fatal("docs folder")
	}
	if tr.Entries["docs/b.md"] == nil || tr.Entries["big.bin"] == nil || !tr.Entries["big.bin"].SizeExcluded {
		t.Fatal("docs/b.md or size-excluded big.bin")
	}
	for _, p := range []string{"skip.tmp", ".onegyignore", ".onegy", ".onegy/sync.json", "bad/inside.txt", "link", "fifo", "deny.txt"} {
		if tr.Entries[p] != nil {
			t.Errorf("%s should not be an entry", p)
		}
	}
	for p, why := range map[string]string{"bad": StallIgnoreParse, "link": StallSymlink, "fifo": StallSymlink,
		"deny.txt": StallPermission, "bad\xffname": StallInvalidName} {
		if tr.Stalled[p] != why {
			t.Errorf("stalled %q = %q, want %q", p, tr.Stalled[p], why)
		}
	}
	if !tr.IsStalled("bad/inside.txt") || tr.IsStalled("docs/b.md") {
		t.Fatal("IsStalled")
	}
	kinds := map[string]int{}
	for _, is := range tr.Issues {
		kinds[is.Kind]++
		if is.Kind == "ignore_parse" && (len(is.Errors) != 1 || is.Errors[0].Line != 1) {
			t.Errorf("ignore issue %+v", is)
		}
	}
	if kinds["symlink"] != 2 || kinds["ignore_parse"] != 1 || kinds["permission"] != 1 || kinds["invalid_name"] != 1 {
		t.Fatalf("issues %v", kinds)
	}

	rules := "-:*.txt\n"
	tr, _ = Run(context.Background(), Options{Root: root, RootRules: &rules})
	if tr.Entries["a.txt"] != nil || tr.Entries["skip.tmp"] == nil {
		t.Fatal("RootRules override")
	}
	if _, err := Run(context.Background(), Options{Root: filepath.Join(root, "missing")}); err == nil {
		t.Fatal("missing root must fail")
	}
}

func TestScanHashCache(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := state.Open(filepath.Join(t.TempDir(), "e.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.PutSync(ctx, &state.SyncRow{ID: "s", Name: "S", LocalRoot: root, Type: "two_way", Encryption: "e2ee", Config: "{}", State: "scanning", CreatedAt: "t"})
	write(t, root, "a", "one")
	write(t, root, "d/b", "two")
	opened := map[string]int{}
	openFile = func(p string) (*os.File, error) { opened[filepath.Base(p)]++; return localfs.Open(p) }
	defer func() { openFile = localfs.Open }()
	scan := func() *Tree {
		tr, err := Run(ctx, Options{Root: root, FSKind: "ext4", DB: db, SyncID: "s"})
		if err != nil {
			t.Fatal(err)
		}
		return tr
	}
	scan()
	scan()
	if opened["a"] != 1 || opened["b"] != 1 {
		t.Fatalf("unchanged files re-hashed: %v", opened)
	}
	os.Rename(filepath.Join(root, "d", "b"), filepath.Join(root, "c"))
	write(t, root, "a", "changed")
	tr := scan()
	if opened["a"] != 2 || opened["c"] != 0 {
		t.Fatalf("changed file not re-hashed or moved file re-hashed: %v", opened)
	}
	if tr.Entries["c"].SHA256 != sum("two") || tr.Entries["a"].SHA256 != sum("changed") {
		t.Fatal("hashes")
	}
	c, _ := db.LoadLocalCache(ctx, "s")
	if c["d/b"] != nil || c["c"] == nil || len(c) != 2 {
		t.Fatalf("cache rows %v", c)
	}
	// Without stable ids (FAT) the id is dropped.
	tr, _ = Run(ctx, Options{Root: root, FSKind: "vfat"})
	if tr.Entries["a"].ID != "" {
		t.Fatal("FAT entries must have no id")
	}
}
