package ignore

import (
	"testing"

	"github.com/tifuck/one.gy/client/internal/localfs"
)

const (
	F = localfs.KindFile
	D = localfs.KindDir
	S = localfs.KindSymlink
)

func set(t *testing.T, files map[string]string) *Set {
	t.Helper()
	s := NewSet()
	for dir, text := range files {
		r, errs := Parse(text)
		if errs != nil {
			t.Fatalf("parse %q: %v", dir, errs)
		}
		s.Add(dir, r)
	}
	return s
}

type want struct {
	rel  string
	kind localfs.Kind
	size int64
	res  Result
}

func check(t *testing.T, s *Set, cases []want) {
	t.Helper()
	for _, c := range cases {
		if got := s.MatchPath(c.rel, c.kind, c.size); got != c.res {
			t.Errorf("%s (%v, %d): got %v want %v", c.rel, c.kind, c.size, got, c.res)
		}
	}
}

// The examples of https://help.mega.io/desktop-app/desktop-setup/megaignore.
func TestMegaDocNameExamples(t *testing.T) {
	s := set(t, map[string]string{"": `# This is a comment.
-f:*.txt
+fg:work*.txt
-fn:*.jpg
+fng:family*.jpg
-N:*.avi
-fp:video/*.avi
+fpg:video/family/*.avi
-nr:.*foo.*
-d:private
`})
	check(t, s, []want{
		{"a.txt", F, 1, Excluded},
		{"sub/deep/a.TXT", F, 1, Excluded}, // g is case-insensitive, n applies below
		{"work1.txt", F, 1, Included},
		{"sub/work-notes.txt", F, 1, Included},
		{"a.txt", D, 0, Included}, // f target: folders unaffected
		{"x.jpg", F, 1, Excluded},
		{"pics/family2.jpg", F, 1, Included},
		{"clip.avi", F, 1, Excluded},
		{"other/clip.avi", F, 1, Included}, // N: only directly in this folder
		{"video/clip.avi", F, 1, Excluded},
		{"video/family/clip.avi", F, 1, Included},
		{"has_foo_inside", F, 1, Excluded},
		{"bar", F, 1, Included},
		{"private", D, 0, Excluded},
		{"private/anything.doc", F, 1, Excluded}, // excluded folder hides its subtree
		{"x/private", D, 0, Excluded},
		{"private", F, 1, Included},
		{"#not-a-comment", F, 1, Included},
	})
}

func TestExcludeEverythingAndDeeperRulesWin(t *testing.T) {
	s := set(t, map[string]string{
		"":     "-:*.log\n",
		"keep": "+:*.log\n",
		"none": "-:*\n",
	})
	check(t, s, []want{
		{"a.log", F, 1, Excluded},
		{"keep/a.log", F, 1, Included},
		{"keep/sub/a.log", F, 1, Included},
		{"none/a", F, 1, Excluded},
		{"none/d", D, 0, Excluded},
		{"none", D, 0, Included},
		{".onegy", D, 0, Excluded},
		{"sub/.onegy", D, 0, Included}, // only the root marker is special
	})
}

func TestCaseSensitivityAndRegex(t *testing.T) {
	s := set(t, map[string]string{"": "-G:*.TMP\n-R:^Cache[0-9]+$\n-r:back.*\n"})
	check(t, s, []want{
		{"a.TMP", F, 1, Excluded},
		{"a.tmp", F, 1, Included},
		{"Cache12", D, 0, Excluded},
		{"cache12", D, 0, Included},
		{"BACKUP", F, 1, Excluded},
		{"link", S, 0, Included},
	})
	s = set(t, map[string]string{"": "-s:*\n"})
	check(t, s, []want{{"link", S, 0, Excluded}, {"file", F, 1, Included}})
}

func TestSizeFilters(t *testing.T) {
	s := set(t, map[string]string{"": "exclude-smaller:4k\nexclude-larger:8M\n", "big": "exclude-larger:1G\n"})
	check(t, s, []want{
		{"tiny", F, 4095, SizeExcluded},
		{"ok", F, 4096, Included},
		{"huge", F, 8<<20 + 1, SizeExcluded},
		{"big/huge", F, 8<<20 + 1, Included},
		{"big/tiny", F, 10, SizeExcluded}, // inherited lower bound
		{"dir", D, 0, Included},
	})
	for _, bad := range []string{"exclude-smaller:8M\nexclude-larger:4k\n", "exclude-larger:-1\n", "exclude-larger:4T\n"} {
		if _, errs := Parse(bad); errs == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestSyncFileAndDefaults(t *testing.T) {
	s := set(t, map[string]string{"": DefaultRules(), "shared": "+sync:.onegyignore\n"})
	check(t, s, []want{
		{FileName, F, 10, Excluded},
		{"shared/" + FileName, F, 10, Included},
		{"Thumbs.db", F, 1, Excluded},
		{"sub/thumbs.db", F, 1, Excluded},
		{"~$report.docx", F, 1, Excluded},
		{".~lock.report.odt#", F, 1, Excluded},
		{"$RECYCLE.BIN", D, 0, Excluded},
		{"System Volume Information", D, 0, Excluded},
		{"movie.part", F, 1, Excluded},
		{"report.docx", F, 1, Included},
		{".snapshots", D, 0, Excluded},
	})
}

func TestParseErrorsAreLineNumbered(t *testing.T) {
	_, errs := Parse("-:ok\n\n-r:(a)\\1\n*bad\n-x:y\n-:\n-sync:other\n+fff:x\n   # not a comment\n")
	lines := []int{}
	for _, e := range errs {
		lines = append(lines, e.Line)
	}
	want := []int{3, 4, 5, 6, 7, 8, 9}
	if len(lines) != len(want) {
		t.Fatalf("errors %v", errs)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Fatalf("errors %v", errs)
		}
	}
}

func TestEngineDirCase(t *testing.T) {
	s := NewSet()
	if s.Match(".ONEGY", localfs.KindDir, 0) != Excluded || s.Match(".onegy", localfs.KindDir, 0) != Excluded {
		t.Fatal("case-insensitive: .ONEGY is the engine folder")
	}
	s.CaseSensitive = true
	if s.Match(".ONEGY", localfs.KindDir, 0) != Included || s.Match(".onegy", localfs.KindDir, 0) != Excluded {
		t.Fatal("case-sensitive: only .onegy is the engine folder")
	}
}
