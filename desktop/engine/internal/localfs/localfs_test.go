package localfs

import (
	"errors"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNamesKnownMappings(t *testing.T) {
	win, lin := Names{Windows: true}, Names{}
	cases := []struct {
		n             Names
		remote, local string
	}{
		{win, "a:b.txt", "a%3Ab.txt"},
		{win, "what?", "what%3F"},
		{win, "trailing.", "trailing%2E"},
		{win, "space ", "space%20"},
		{win, "CON", "%43ON"},
		{win, "nul.txt", "%6Eul.txt"},
		{win, "COM1.log", "%43OM1.log"},
		{win, "CONSOLE", "CONSOLE"},
		{win, "100% done", "100% done"},
		{win, "my%20file.pdf", "my%20file.pdf"},
		{win, "a%3Ab", "a%253Ab"},
		{win, "%43ON", "%2543ON"},
		{win, "tab\tx", "tab%09x"},
		{lin, "a/b", "a%2Fb"},
		{lin, "a:b?", "a:b?"},
		{lin, "a%2Fb", "a%252Fb"},
		{lin, "x.", "x."},
	}
	for _, c := range cases {
		if got := c.n.ToLocal(c.remote); got != c.local {
			t.Errorf("ToLocal(%q, win=%v) = %q, want %q", c.remote, c.n.Windows, got, c.local)
		}
		if got, ok := c.n.ToRemote(c.local); !ok || got != c.remote {
			t.Errorf("ToRemote(%q, win=%v) = %q,%v, want %q", c.local, c.n.Windows, got, ok, c.remote)
		}
	}
	// User-made local names that no remote name maps to are reported.
	if _, ok := win.ToRemote("a%2525"); !ok {
		t.Error("a%2525 is canonical (literal)")
	}
}

// Property: every remote name round-trips, and the local form never contains
// a character the rules reject.
func TestNamesRoundTripRandom(t *testing.T) {
	alphabet := []string{"a", "B", "c", ".", " ", "%", "2", "5", "3", "A", "E", "F", "0", ":", "/", "\\", "?", "*",
		"\x01", "\x00", "C", "O", "N", "n", "u", "l", "P", "R", "X", "é", "e\u0301", "日", "|", "<", ">", "\"", "1", "L", "T"}
	rng := rand.New(rand.NewSource(1))
	for _, n := range []Names{{Windows: true}, {}} {
		for i := 0; i < 200000; i++ {
			var b strings.Builder
			for j := rng.Intn(9) + 1; j > 0; j-- {
				b.WriteString(alphabet[rng.Intn(len(alphabet))])
			}
			r := b.String()
			l := n.ToLocal(r)
			if back, ok := n.ToRemote(l); !ok || back != r {
				t.Fatalf("win=%v %q -> %q -> %q (%v)", n.Windows, r, l, back, ok)
			}
			for k := 0; k < len(l); k++ {
				if n.invalid(l[k]) {
					t.Fatalf("win=%v %q -> %q keeps an invalid byte", n.Windows, r, l)
				}
			}
			if n.Windows && (strings.HasSuffix(l, ".") || strings.HasSuffix(l, " ") || n.reserved(l)) {
				t.Fatalf("%q -> %q is not a valid Windows name", r, l)
			}
		}
	}
}

func TestKeyAndSuffix(t *testing.T) {
	if Key("e\u0301.txt", true) != Key("é.txt", true) {
		t.Error("NFC key")
	}
	if Key("A.TXT", false) != Key("a.txt", false) || Key("A.TXT", true) == Key("a.txt", true) {
		t.Error("case fold key")
	}
	for in, want := range map[string]string{"a.txt": "a (2).txt", ".bashrc": ".bashrc (2)", "noext": "noext (2)", "x.tar.gz": "x.tar (2).gz"} {
		if got := InsertSuffix(in, " (2)"); got != want {
			t.Errorf("InsertSuffix(%q) = %q", in, got)
		}
	}
	if !(Names{Windows: true}).TooLong(strings.Repeat("日", 256)) || (Names{Windows: true}).TooLong(strings.Repeat("日", 255)) {
		t.Error("windows length")
	}
	if !(Names{}).TooLong(strings.Repeat("日", 86)) {
		t.Error("linux length in bytes")
	}
}

func TestIdentityAndRename(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	os.WriteFile(a, []byte("one"), 0o644)
	ia, err := Lstat(a)
	if err != nil || ia.Kind != KindFile || ia.Size != 3 || ia.ID == "" {
		t.Fatalf("lstat %+v %v", ia, err)
	}
	if err := RenameNoReplace(a, b); err != nil {
		t.Fatal(err)
	}
	ib, _ := Lstat(b)
	if ib.ID != ia.ID {
		t.Fatal("identity changed across rename")
	}
	os.WriteFile(a, []byte("two"), 0o644)
	if err := RenameNoReplace(a, b); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("no-replace over an existing file: %v", err)
	}
	if got, _ := os.ReadFile(b); string(got) != "one" {
		t.Fatal("target overwritten")
	}
	if err := Replace(a, b); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(b); string(got) != "two" {
		t.Fatal("replace")
	}
	if _, err := os.Stat(a); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("source left behind")
	}
	c := filepath.Join(dir, "c")
	if err := RenameNoReplace(b, c); err != nil {
		t.Fatal(err)
	}
	ic, _ := Lstat(c)
	f, _ := OpenForSnapshot(c)
	fi, err := Fstat(f)
	f.Close()
	if err != nil || fi.ID != ic.ID || fi.Size != 3 {
		t.Fatalf("fstat %+v %v", fi, err)
	}
	os.Symlink(c, filepath.Join(dir, "l"))
	if il, _ := Lstat(filepath.Join(dir, "l")); il.Kind != KindSymlink {
		t.Fatal("symlink followed")
	}
	if runtime.GOOS == "linux" {
		if _, err := Open(filepath.Join(dir, "l")); err == nil {
			t.Fatal("Open followed a symlink")
		}
	}
}

func TestDebris(t *testing.T) {
	root := t.TempDir()
	day := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	for i, want := range []string{".onegy/debris/2026-11-09/docs/a.txt", ".onegy/debris/2026-11-09/docs/a (2).txt"} {
		os.MkdirAll(filepath.Join(root, "docs"), 0o755)
		os.WriteFile(filepath.Join(root, "docs", "a.txt"), []byte{byte(i)}, 0o644)
		got, err := MoveToDebris(root, "docs/a.txt", day)
		if err != nil || got != want {
			t.Fatalf("debris %d: %q %v", i, got, err)
		}
		if b, _ := os.ReadFile(filepath.Join(root, got)); len(b) != 1 || b[0] != byte(i) {
			t.Fatal("debris content")
		}
	}
	os.MkdirAll(filepath.Join(root, "dir", "sub"), 0o755)
	if got, err := MoveToDebris(root, "dir", day); err != nil || got != ".onegy/debris/2026-11-09/dir" {
		t.Fatalf("dir debris %q %v", got, err)
	}
}

func TestStabilityAndMtime(t *testing.T) {
	var s Stability
	t0 := time.Unix(1000, 0)
	in := Info{Size: 10, MtimeNs: 5, ID: "1:2"}
	if s.Stable("a", in, t0) || s.Stable("a", in, t0.Add(time.Second)) || !s.Stable("a", in, t0.Add(2*time.Second)) {
		t.Fatal("2 s window")
	}
	in.MtimeNs = 6
	if s.Stable("a", in, t0.Add(3*time.Second)) || !s.Stable("a", in, t0.Add(5*time.Second)) {
		t.Fatal("change restarts the window")
	}
	big := Info{Size: 2 << 30}
	s.Stable("b", big, t0)
	if s.Stable("b", big, t0.Add(9*time.Second)) || !s.Stable("b", big, t0.Add(10*time.Second)) {
		t.Fatal("10 s window for large files")
	}
	if !SameMtime(0, 1999999999, "vfat") || SameMtime(0, 1, "ext4") || !SameMtime(0, 99, "ntfs") {
		t.Fatal("precision")
	}
	if IdentityStable("exfat") || !IdentityStable("ext4") {
		t.Fatal("identity stability")
	}
}
