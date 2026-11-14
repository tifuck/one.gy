package reconcile

import (
	"strings"
	"testing"
)

func TestNameClashSmartAndAdvanced(t *testing.T) {
	w := newWorld().rf("u1", "root", "a.txt", "one", 1, 1).rf("u2", "root", "a.txt", "two", 1, 2)
	p := w.plan(t)
	eq(t, "different content", summary(p), "download a (2).txt", "download a.txt")
	for _, o := range p.Ops {
		if o.RemoteName != "a.txt" {
			t.Errorf("the one.gy name stays a.txt, got %q", o.RemoteName)
		}
		if o.Path == "a.txt" && o.RemoteID != "u1" {
			t.Error("the oldest keeps the name")
		}
	}
	w = newWorld().rf("u1", "root", "a.txt", "same", 1, 1).rf("u2", "root", "a.txt", "same", 1, 2)
	eq(t, "identical", summary(w.plan(t)), "download a.txt", "trash_remote a.txt")
	w.cfg.Type = "mirror" // download-only never writes to one.gy: map instead
	eq(t, "identical, mirror", summary(w.plan(t)), "download a (2).txt", "download a.txt")

	w = newWorld().rf("u1", "root", "a.txt", "one", 1, 1).rf("u2", "root", "a.txt", "two", 1, 2).lf("a.txt", "L1", "loc")
	w.cfg.IssueMode = "advanced"
	p = w.plan(t)
	eq(t, "advanced", summary(p))
	eq(t, "advanced issues", issueKinds(p), "name_clash a.txt", "name_clash a.txt")

	// A recorded mapping is kept on later passes.
	w = newWorld().rf("u1", "root", "a.txt", "one", 1, 1).rf("u2", "root", "a.txt", "two", 1, 2).
		bf("a.txt", "u1", "L1", "one", 1).lf("a.txt", "L1", "one").bf("a (2).txt", "u2", "L2", "two", 1).lf("a (2).txt", "L2", "two")
	w.base[1].RemoteName = "a.txt"
	eq(t, "mapping kept", summary(w.plan(t)))
}

func TestCaseClash(t *testing.T) {
	w := newWorld().rf("u1", "root", "A.txt", "one", 1, 1).rf("u2", "root", "a.txt", "two", 1, 2)
	w.cfg.CaseSensitive = false
	eq(t, "case clash", summary(w.plan(t)), "download A.txt", "download a (case 2).txt")
	w.cfg.CaseSensitive = true
	eq(t, "case sensitive: no clash", summary(w.plan(t)), "download A.txt", "download a.txt")
	w.cfg.CaseSensitive, w.cfg.IssueMode = false, "advanced"
	eq(t, "advanced", issueKinds(w.plan(t)), "case_clash A.txt", "case_clash a.txt")
}

func TestDuplicateFoldersMerge(t *testing.T) {
	w := newWorld().rd("f1", "root", "docs", 1).rf("u1", "f1", "x.txt", "x", 1, 1).
		rd("f2", "root", "docs", 2).rf("u2", "f2", "x.txt", "x", 1, 2).rf("u3", "f2", "y.txt", "y", 1, 2).rf("u4", "f2", "z.txt", "z", 1, 2).
		rf("u5", "f1", "y.txt", "other", 1, 1)
	p := w.plan(t)
	// Main is f2 (3 files vs 2): f1's identical x.txt is trashed, its
	// different y.txt moves in as "y (2).txt", then f1 is trashed. Nothing
	// inside the duplicates is downloaded until the next pass.
	eq(t, "merge", summary(p), "move_remote docs/y (2).txt", "create_local_dir docs", "download docs/x.txt", "download docs/y.txt", "download docs/z.txt",
		"trash_remote docs", "trash_remote docs/x.txt")
	for _, o := range p.Ops {
		if o.Kind == MoveRemote && (o.ParentRemoteID != "f2" || o.RemoteID != "u5" || o.RemoteName != "y (2).txt") {
			t.Errorf("merge move %+v", o)
		}
		if o.Kind == TrashRemote && o.Path == "docs" && o.RemoteID != "f1" {
			t.Errorf("trashed the wrong folder %+v", o)
		}
	}
	w.cfg.IssueMode = "advanced"
	eq(t, "advanced", issueKinds(w.plan(t)), "name_clash docs", "name_clash docs")
}

func TestInvalidLocalNames(t *testing.T) {
	w := newWorld().rf("u1", "root", "a:b?.txt", "x", 1, 1).rf("u2", "root", "CON", "y", 1, 1)
	w.cfg.FSKind = "ntfs"
	p := w.plan(t)
	eq(t, "escaped", summary(p), "download %43ON", "download a%3Ab%3F.txt")
	if p.Ops[1].RemoteName != "a:b?.txt" {
		t.Errorf("remote name %q", p.Ops[1].RemoteName)
	}
	w.cfg.IssueMode = "advanced"
	p = w.plan(t)
	eq(t, "advanced", summary(p))
	eq(t, "advanced issues", issueKinds(p), "invalid_name %43ON", "invalid_name a%3Ab%3F.txt")

	// A local escaped name uploads under the decoded one.gy name.
	w = newWorld().lf("a%3Ab.txt", "L1", "x")
	w.cfg.FSKind = "ntfs"
	if o := opOf(t, w.plan(t), Upload); o.RemoteName != "a:b.txt" {
		t.Errorf("upload name %q", o.RemoteName)
	}
	w = newWorld().rf("u1", "root", strings.Repeat("x", 300), "x", 1, 1)
	eq(t, "too long", issueKinds(w.plan(t)), "invalid_name "+strings.Repeat("x", 300))
}

func TestLocalUnicodeClash(t *testing.T) {
	w := newWorld().lf("e\u0301.txt", "L1", "a").lf("\u00e9.txt", "L2", "b")
	p := w.plan(t)
	eq(t, "nfc clash", summary(p))
	if len(p.Issues) != 2 || p.Issues[0].Kind != "name_clash" {
		t.Fatalf("issues %v", issueKinds(p))
	}
	// One local NFD name matching a one.gy NFC name is the same item.
	w = newWorld().lf("e\u0301.txt", "L1", "a").rf("u1", "root", "\u00e9.txt", "a", 1, 1)
	p = w.plan(t)
	if o := opOf(t, p, Link); o.Path != "e\u0301.txt" || o.RemoteName != "\u00e9.txt" {
		t.Errorf("link %+v", o)
	}
}

func TestReadOnlyIntegrityAndLimits(t *testing.T) {
	w := newWorld().rd("f1", "root", "backup", 1).bd("backup", "f1", "D1").ld("backup", "D1").lf("backup/new.txt", "L1", "n")
	w.remote[0].ReadOnly = true
	p := w.plan(t)
	eq(t, "read-only", summary(p))
	eq(t, "read-only issue", issueKinds(p), "read_only backup/new.txt")

	w = newWorld().bf("a", "u1", "L1", "h", 5).lf("a", "L1", "h").rf("u1", "root", "a", "old", 3, 9)
	eq(t, "rollback", issueKinds(w.plan(t)), "integrity a")

	w = newWorld().rf("u1", "root", "", "x", 1, 1)
	w.remote[0].NameOK = false
	eq(t, "undecryptable", issueKinds(w.plan(t)), "integrity ")

	w = newWorld().rf("u1", "root", "big.iso", "x", 1, 1)
	w.remote[0].Size = 5 << 30
	w.cfg.FSKind = "vfat"
	eq(t, "fat32 limit", issueKinds(w.plan(t)), "too_large big.iso")

	// A new one.gy file where a synced local item stays: mapped beside it.
	w = newWorld().bf("a.txt", "u1", "L1", "h", 1).lf("a.txt", "L1", "h").rf("u1", "root", "a.txt", "h", 1, 1).
		lf("b.txt", "L2", "x").bf("b.txt", "u3", "L2", "x", 1).rf("u3", "root", "b.txt", "x", 1, 1).rf("u2", "root", "b.txt", "z", 1, 2)
	eq(t, "occupied", summary(w.plan(t)), "download b (2).txt")
}

// A file synced end-to-end encrypted whose node one.gy now lists as standard
// moves in neither direction. A different (standard) node at its path is a
// replacement: the local edit is kept as a conflict copy, never uploaded into it.
func TestE2EEDowngradeStalls(t *testing.T) {
	e2ee := func(w *world) *world {
		for _, b := range w.base {
			b.E2EE = true
		}
		for i := range w.remote {
			w.remote[i].E2EE = true
		}
		return w
	}
	w := e2ee(newWorld().bf("a", "u1", "L1", "h", 1).lf("a", "L1", "h2").rf("u1", "root", "a", "h", 1, 1))
	eq(t, "e2ee edit", summary(w.plan(t)), "upload a @u1")

	w.remote[0].E2EE = false
	p := w.plan(t)
	eq(t, "edit over standard", summary(p))
	eq(t, "edit over standard issue", issueKinds(p), "integrity a")
	if p.Issues[0].Message != DowngradeMessage || strings.Join(p.Issues[0].Actions, ",") != "keep_remote,ignore" {
		t.Errorf("issue %+v", p.Issues[0])
	}

	w = e2ee(newWorld().bf("a", "u1", "L1", "h", 1).lf("a", "L1", "h").rf("u1", "root", "a", "evil", 2, 2))
	w.remote[0].E2EE = false
	p = w.plan(t)
	eq(t, "standard download", summary(p))
	eq(t, "standard download issue", issueKinds(p), "integrity a")

	w = e2ee(newWorld().bf("a", "u1", "L1", "h", 1).lf("a", "L1", "h2")).rf("u2", "root", "a", "evil", 1, 3)
	p = w.plan(t)
	eq(t, "replaced by standard", summary(p), "conflict a>a (conflict from DEV 2026-11-08 1432)")
	eq(t, "replaced by standard issue", issueKinds(p))
}
