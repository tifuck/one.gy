package reconcile

import "testing"

// base: d/ (f1, D1) with d/x.txt (u1, L1) and d/y.txt (u2, L2)
func folderWorld() *world {
	return newWorld().bd("d", "f1", "D1").bf("d/x.txt", "u1", "L1", "hx", 1).bf("d/y.txt", "u2", "L2", "hy", 1)
}

func TestFolderRenameMovesOnlyTheFolder(t *testing.T) {
	w := folderWorld().ld("d", "D1").lf("d/x.txt", "L1", "hx").lf("d/y.txt", "L2", "hy").
		rd("f1", "root", "e", 2).rf("u1", "f1", "x.txt", "hx", 1, 1).rf("u2", "f1", "y.txt", "hy", 1, 1)
	eq(t, "remote rename", summary(w.plan(t)), "move_local d>e")

	w = folderWorld().ld("e", "D1").lf("e/x.txt", "L1", "hx").lf("e/y.txt", "L2", "hy").
		rd("f1", "root", "d", 1).rf("u1", "f1", "x.txt", "hx", 1, 1).rf("u2", "f1", "y.txt", "hy", 1, 1)
	eq(t, "local rename", summary(w.plan(t)), "move_remote d>e")

	// Renamed on both sides differently, a child edited locally: one.gy wins
	// the location, the edit is uploaded at the final path.
	w = folderWorld().ld("e", "D1").lf("e/x.txt", "L1", "hx2").lf("e/y.txt", "L2", "hy").
		rd("f1", "root", "g", 2).rf("u1", "f1", "x.txt", "hx", 1, 1).rf("u2", "f1", "y.txt", "hy", 1, 1)
	eq(t, "both renamed", summary(w.plan(t)), "move_local e>g", "upload g/x.txt @u1")
}

func TestFolderDeletedWithNewContentIsRecreated(t *testing.T) {
	// Deleted locally; one.gy has a new file inside and an edited one: the
	// folder is re-created here with only those, the unchanged child trashed.
	w := folderWorld().rd("f1", "root", "d", 1).rf("u1", "f1", "x.txt", "hx2", 2, 2).rf("u2", "f1", "y.txt", "hy", 1, 1).
		rf("u3", "f1", "new.txt", "n", 1, 3)
	eq(t, "local delete", summary(w.plan(t)), "create_local_dir d", "download d/new.txt", "download d/x.txt", "trash_remote d/y.txt")

	// Without new content the folder goes as a whole (children implied).
	w = folderWorld().rd("f1", "root", "d", 1).rf("u1", "f1", "x.txt", "hx", 1, 1).rf("u2", "f1", "y.txt", "hy", 1, 1)
	eq(t, "local delete whole", summary(w.plan(t)), "trash_remote d")

	// Deleted on one.gy; a new local file inside: re-created there.
	w = folderWorld().ld("d", "D1").lf("d/x.txt", "L1", "hx").lf("d/y.txt", "L2", "hy").lf("d/new.txt", "L3", "n")
	eq(t, "remote delete", summary(w.plan(t)), "create_remote_dir d", "upload d/new.txt", "delete_local d/x.txt", "delete_local d/y.txt")

	w = folderWorld().ld("d", "D1").lf("d/x.txt", "L1", "hx").lf("d/y.txt", "L2", "hy")
	eq(t, "remote delete whole", summary(w.plan(t)), "delete_local d")

	// A stalled child (unreadable) keeps the folder: never delete what we cannot judge.
	w = folderWorld().ld("d", "D1").lf("d/x.txt", "L1", "hx")
	w.stall = map[string]string{"d/y.txt": "permission"}
	eq(t, "stalled child", summary(w.plan(t)), "create_remote_dir d", "delete_local d/x.txt")
}

func TestTypeChangeIsConflict(t *testing.T) {
	w := newWorld().bf("a", "u1", "L1", "h", 1).ld("a", "D9").rf("u1", "root", "a", "h", 1, 1)
	eq(t, "local file -> folder", summary(w.plan(t)), "conflict a>a (conflict from DEV 2026-11-08 1432)")
	// Replaced by a folder on one.gy (file trashed, folder created).
	w = newWorld().bf("a", "u1", "L1", "h", 1).lf("a", "L1", "h").rd("f9", "root", "a", 2)
	eq(t, "remote file -> folder", summary(w.plan(t)), "conflict a>a (conflict from DEV 2026-11-08 1432)")
	// Deleted and re-uploaded on the website (same kind): a plain download.
	w = newWorld().bf("a", "u1", "L1", "h", 1).lf("a", "L1", "h").rf("u9", "root", "a", "h2", 1, 2)
	p := w.plan(t)
	eq(t, "replaced on one.gy", summary(p), "download a")
	if o := opOf(t, p, Download); o.RemoteID != "u9" || o.Base == nil || o.Local.Absent {
		t.Errorf("replace download %+v", o)
	}
}

func TestOrdering(t *testing.T) {
	// New local tree: folders before their children, small files first.
	w := newWorld().ld("n", "D1").ld("n/m", "D2").lf("n/m/big", "L1", "0123456789").lf("n/small", "L2", "1").lf("z", "L3", "12345")
	eq(t, "new tree", summary(w.plan(t)), "create_remote_dir n", "create_remote_dir n/m", "upload n/small", "upload z", "upload n/m/big")

	// A remote folder rename plus a new remote folder inside it: the move
	// comes first, even though the create was planned later.
	w = folderWorld().ld("d", "D1").lf("d/x.txt", "L1", "hx").lf("d/y.txt", "L2", "hy").
		rd("f1", "root", "e", 2).rf("u1", "f1", "x.txt", "hx", 1, 1).rf("u2", "f1", "y.txt", "hy", 1, 1).
		rd("f2", "f1", "sub", 3).bd("a", "f3", "D3").ld("a", "D3").rd("f3", "root", "a", 1)
	eq(t, "move before create inside", summary(w.plan(t)), "move_local d>e", "create_local_dir e/sub")

	// Local move into a new folder: create the folder remotely, then move.
	w = newWorld().bf("a.txt", "u1", "L1", "h", 1).lf("new/a.txt", "L1", "h").ld("new", "D1").rf("u1", "root", "a.txt", "h", 1, 1)
	eq(t, "move into new folder", summary(w.plan(t)), "create_remote_dir new", "move_remote a.txt>new/a.txt")

	// A conflict copy vacates the name before a one.gy item moves into it.
	w = newWorld().bf("a.txt", "u1", "L1", "h", 1).lf("a.txt", "L1", "h").rf("u1", "root", "b.txt", "h", 1, 2).lf("b.txt", "L5", "new")
	eq(t, "vacate before move", summary(w.plan(t)), "conflict b.txt>b (conflict from DEV 2026-11-08 1432).txt", "move_local a.txt>b.txt")
}

func TestExcludedAndStalledBaseRows(t *testing.T) {
	w := newWorld().bf("a.tmp", "u1", "L1", "h", 1).rf("u1", "root", "a.tmp", "h", 1, 1)
	w.rules = "-:*.tmp\n"
	eq(t, "newly excluded", summary(w.plan(t)), "forget a.tmp")

	w = newWorld().bf("a.txt", "u1", "L1", "h", 1).rf("u1", "root", "a.txt", "h", 1, 1)
	w.stall = map[string]string{"a.txt": "permission"}
	eq(t, "stalled", summary(w.plan(t)))

	// Remote items excluded locally, or size-excluded, are not downloaded.
	w = newWorld().rf("u1", "root", "a.tmp", "h", 1, 1).rf("u2", "root", "big", "0123456789", 1, 1)
	w.rules = "-:*.tmp\nexclude-larger:5\n"
	eq(t, "remote excluded", summary(w.plan(t)))
}

func TestFATMovesByHash(t *testing.T) {
	w := newWorld().bf("a.txt", "u1", "", "h1", 1).lf("b.txt", "", "h1").rf("u1", "root", "a.txt", "h1", 1, 1)
	w.cfg.FSKind = "exfat"
	eq(t, "fat move", summary(w.plan(t)), "move_remote a.txt>b.txt")
	w.cfg.FSKind = "ext4" // with ids, an id-less match is not a move
	eq(t, "no id", summary(w.plan(t)), "upload b.txt", "trash_remote a.txt")
}

func TestCaseOnlyRename(t *testing.T) {
	w := newWorld().bf("a.txt", "u1", "L1", "h", 1).lf("A.txt", "L1", "h").rf("u1", "root", "a.txt", "h", 1, 1)
	w.cfg.CaseSensitive = false
	eq(t, "local case rename", summary(w.plan(t)), "move_remote a.txt>A.txt")
}
