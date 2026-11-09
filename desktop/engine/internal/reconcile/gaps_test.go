package reconcile

import (
	"testing"

	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
)

func TestRemoteMoveOntoUnsyncedName(t *testing.T) {
	// a.txt renamed to b.txt here while the website created another b.txt.
	moved := func(remoteSHA string) *world {
		return newWorld().bf("a.txt", "u1", "L1", "h", 1).lf("b.txt", "L1", "h").rf("u1", "root", "a.txt", "h", 1, 1).
			rf("u2", "root", "b.txt", remoteSHA, 1, 2)
	}
	p := moved("z").plan(t)
	eq(t, "different", summary(p), "move_local b.txt>b (2).txt", "move_remote a.txt>b (2).txt", "download b.txt")
	if o := opOf(t, p, MoveRemote); o.RemoteName != "b (2).txt" || o.RemoteID != "u1" {
		t.Errorf("move %+v", o)
	}
	if o := opOf(t, p, Download); o.RemoteID != "u2" {
		t.Errorf("download %+v", o)
	}
	eq(t, "identical", summary(moved("h").plan(t)), "move_remote a.txt>b.txt", "trash_remote b.txt")
	w := moved("z")
	w.cfg.ConflictPolicy = "ask"
	p = w.plan(t)
	eq(t, "ask", summary(p))
	eq(t, "ask issue", issueKinds(p), "name_clash b.txt")

	// Upload-only syncs resolve the same way.
	w = moved("z")
	w.cfg.Type = "backup"
	eq(t, "backup", summary(w.plan(t)), "move_local b.txt>b (2).txt", "move_remote a.txt>b (2).txt")
}

func TestRestoreFromTrash(t *testing.T) {
	// d was trashed on one.gy (with a.txt); this computer added new.txt inside.
	w := newWorld().bd("d", "f1", "D1").ld("d", "D1").bf("d/a.txt", "u1", "L1", "a", 1).lf("d/a.txt", "L1", "a").lf("d/new.txt", "L2", "n")
	eq(t, "not in trash", summary(w.plan(t)), "create_remote_dir d", "upload d/new.txt", "delete_local d/a.txt")
	w.trashed = map[string]int64{"f1": 0, "u1": 1}
	p := w.plan(t)
	eq(t, "restored", summary(p), "restore_remote d", "upload d/new.txt")
	if o := opOf(t, p, RestoreRemote); o.RemoteID != "f1" || o.EntryKind != localfs.KindDir || o.Base == nil {
		t.Errorf("restore %+v", o)
	}
	// Something synced inside was deleted here: restoring would bring it back.
	w.bf("d/b.txt", "u2", "L3", "b", 1)
	w.trashed["u2"] = 1
	eq(t, "deleted inside", summary(w.plan(t)), "create_remote_dir d", "upload d/new.txt", "delete_local d/a.txt", "forget d/b.txt")

	// "Restore" answer to a remote mass delete: files come back from the trash
	// when it holds the synced version, else they are uploaded again.
	w = newWorld().bf("a.txt", "u1", "L1", "a", 1).lf("a.txt", "L1", "a").bf("b.txt", "u2", "L2", "b", 1).lf("b.txt", "L2", "b")
	w.cfg.MassDeleteRemote = "restore"
	w.trashed = map[string]int64{"u1": 1, "u2": 3}
	eq(t, "mass restore", summary(w.plan(t)), "restore_remote a.txt", "upload b.txt")
	w.cfg.Type = "mirror" // download-only syncs never write to one.gy
	w.cfg.MassDeleteRemote = ""
	eq(t, "mirror", summary(w.plan(t)), "delete_local a.txt", "delete_local b.txt")
}

func TestModeOnlyChanges(t *testing.T) {
	base := func() *world {
		w := newWorld().bf("run.sh", "u1", "L1", "s", 1).lf("run.sh", "L1", "s").rf("u1", "root", "run.sh", "s", 1, 1)
		w.cfg.KeepExecBit = true
		w.base[0].Mode = 0o644
		return w
	}
	w := base()
	w.local["run.sh"].Mode = 0o755
	p := w.plan(t)
	eq(t, "chmod here", summary(p), "set_mode_remote run.sh")
	if o := opOf(t, p, SetModeRemote); o.Mode != 0o755 || o.ContentVersion != 1 || o.SHA256 != "s" || o.RemoteID != "u1" {
		t.Errorf("op %+v", o)
	}
	w.cfg.FSKind = "ntfs"
	eq(t, "ntfs", summary(w.plan(t)))
	w.cfg.FSKind, w.cfg.KeepExecBit = "ext4", false
	eq(t, "off", summary(w.plan(t)))

	w = base()
	w.remote[0].Mode = 0o755
	p = w.plan(t)
	eq(t, "chmod on one.gy", summary(p), "set_mode_local run.sh")
	if o := opOf(t, p, SetModeLocal); o.Mode != 0o755 {
		t.Errorf("mode %o", o.Mode)
	}
	w.cfg.Type = "backup" // this computer is the truth
	eq(t, "backup ignores one.gy", summary(w.plan(t)))

	w = base()
	w.local["run.sh"].Mode = 0o755
	w.local["run.sh"].SHA256 = "changed"
	eq(t, "content change carries the mode", summary(w.plan(t)), "upload run.sh @u1")
}

func TestPreviewListsRestores(t *testing.T) {
	w := newWorld().bf("a.txt", "u1", "L1", "a", 1).lf("a.txt", "L1", "a")
	w.cfg.MassDeleteRemote = "restore"
	w.trashed = map[string]int64{"u1": 1}
	pv := w.plan(t).Preview()
	if len(pv.Items) != 1 || pv.Items[0].Action != "restore_remote" || pv.Uploads.Count != 0 {
		t.Fatalf("preview %+v", pv)
	}
}

func TestHiddenSystemItemsAreExcluded(t *testing.T) {
	// The scan hides Windows hidden/system items (scan.Options.IncludeHiddenSystem off).
	w := newWorld().bf("desktop.ini", "u1", "L1", "x", 1).rf("u1", "root", "desktop.ini", "x", 1, 1).
		rf("u2", "root", "Thumbs.db", "t", 1, 2).lf("new.txt", "L2", "n")
	tree := w.tree()
	tree.Rules.Hide("desktop.ini")
	tree.Rules.Hide("Thumbs.db")
	p := Reconcile(&Input{Config: w.cfg, Local: tree, Remote: Remote{RootID: "root", Nodes: w.remote}, Base: w.base})
	eq(t, "hidden", summary(p), "upload new.txt", "forget desktop.ini")
}
