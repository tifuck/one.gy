package reconcile

import "testing"

func TestTypeChangeBySyncType(t *testing.T) {
	for typ, want := range map[string][]string{
		"mirror":  {"delete_local a"},
		"backup":  {"trash_remote a"},
		"archive": {"forget a"},
	} {
		w := newWorld().bf("a", "u1", "L1", "h", 1).ld("a", "D9").rf("u1", "root", "a", "h", 1, 1)
		w.cfg.Type = typ
		eq(t, typ, summary(w.plan(t)), want...)
	}
	w := newWorld().lf("d", "L1", "x").rd("f1", "root", "d", 5)
	w.cfg.Type = "mirror"
	eq(t, "new pair mirror", summary(w.plan(t)), "delete_local d")
	w.cfg.Type = "backup"
	eq(t, "new pair backup", issueKinds(w.plan(t)), "conflict d")
}

func TestRestoreFolderAndReadOnlyDeletes(t *testing.T) {
	w := newWorld().bd("d", "f1", "D1").rd("f1", "root", "e", 2)
	eq(t, "deleted here, moved there", summary(w.plan(t)), "create_local_dir e")

	w = newWorld().rd("f1", "root", "bk", 1).bd("bk", "f1", "D1").ld("bk", "D1").bf("bk/a", "u1", "L1", "h", 1).rf("u1", "f1", "a", "h", 1, 1)
	w.remote[0].ReadOnly = true
	p := w.plan(t)
	eq(t, "read-only delete", summary(p))
	eq(t, "read-only issue", issueKinds(p), "read_only bk/a")
}

func TestNonCanonicalLocalName(t *testing.T) {
	w := newWorld().lf("trailing ", "L1", "x") // possible on an NTFS volume mounted on Linux
	w.cfg.FSKind = "ntfs"
	p := w.plan(t)
	eq(t, "non-canonical", summary(p))
	eq(t, "issue", issueKinds(p), "invalid_name trailing ")
}

// one.gy names "." and ".." must never become path components that leave
// the folder (or the sync root); an empty name is skipped.
func TestDotAndEmptyRemoteNames(t *testing.T) {
	w := newWorld().rd("10", "root", "..", 1).rd("11", "10", ".config", 2).rf("f1", "11", "evil.desktop", "abc", 1, 3).
		rd("20", "root", ".", 4).rf("f2", "20", "x", "def", 1, 5).rf("f3", "root", "", "ghi", 1, 6)
	p := w.plan(t)
	eq(t, "dot names", summary(p), "create_local_dir %2E", "create_local_dir %2E.", "create_local_dir %2E./.config",
		"download %2E./.config/evil.desktop", "download %2E/x")
	eq(t, "empty name", issueKinds(p), "invalid_name ")
}
