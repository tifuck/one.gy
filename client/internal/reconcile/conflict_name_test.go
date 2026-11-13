package reconcile

import (
	"testing"
	"time"

	"github.com/tifuck/one.gy/client/internal/localfs"
)

func TestConflictNameSkipsTakenNames(t *testing.T) {
	in := &Input{Config: Config{Device: "PC", Now: time.Date(2026, 11, 8, 14, 32, 0, 0, time.UTC)}}
	first := "dir/report (conflict from PC 2026-11-08 1432).docx"

	taken := map[string]bool{}
	if got := ConflictName(in, "dir/report.docx", taken); got != first {
		t.Fatalf("first name = %q", got)
	}
	// A second decision in the same batch must not reuse the name.
	if got := ConflictName(in, "dir/report.docx", taken); got != "dir/report (conflict from PC 2026-11-08 1432 2).docx" {
		t.Fatalf("second name = %q", got)
	}
	// Case-insensitive file systems: a differently cased file on disk counts.
	taken = map[string]bool{localfs.Key("dir/REPORT (conflict from PC 2026-11-08 1432).DOCX", false): true}
	if got := ConflictName(in, "dir/report.docx", taken); got == first {
		t.Fatalf("picked %q although its case-folded name is taken", got)
	}
	in.Config.CaseSensitive = true
	taken = map[string]bool{localfs.Key("dir/REPORT (conflict from PC 2026-11-08 1432).DOCX", true): true}
	if got := ConflictName(in, "dir/report.docx", taken); got != first {
		t.Fatalf("case-sensitive name = %q", got)
	}
	// Top-level paths have no directory prefix.
	if got := ConflictName(in, "a.txt", map[string]bool{}); got != "a (conflict from PC 2026-11-08 1432).txt" {
		t.Fatalf("top-level name = %q", got)
	}
}
