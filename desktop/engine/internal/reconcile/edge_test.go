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
