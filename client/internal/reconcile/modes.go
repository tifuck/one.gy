package reconcile

import "github.com/tifuck/one.gy/client/internal/localfs"

// The executable bit (Config.KeepExecBit) travels in the encrypted meta
// ("mode"). A change of the bit alone rewrites the meta or chmods the local
// file; content changes carry it with the upload or download instead.

// execBits: modes are tracked on this file system (not on FAT/NTFS/SMB,
// whose permission bits are synthetic).
func (r *run) execBits() bool {
	switch r.cfg.FSKind {
	case "vfat", "fat32", "exfat", "ntfs", "refs", "smb":
		return false
	}
	return r.cfg.KeepExecBit
}

func withExec(mode uint32, on bool) uint32 {
	if on {
		return mode | (mode&0o444)>>2 // x wherever r is set
	}
	return mode &^ 0o111
}

// modes plans a mode-only change of a synced file at p whose content is the
// same on both sides.
func (r *run) modes(it *item, p string) {
	e, b, n := it.l, it.b, it.rn
	if it.kind != localfs.KindFile || !r.execBits() || e.Mode == 0 || b.Mode == 0 {
		return
	}
	lx, bx, rx := e.Mode&0o100 != 0, b.Mode&0o100 != 0, b.Mode&0o100 != 0
	if n.Mode != 0 {
		rx = n.Mode&0o100 != 0
	}
	switch {
	case lx != bx && r.k.up:
		r.add(Op{Kind: SetModeRemote, Path: p, EntryKind: localfs.KindFile, RemoteID: n.ID, ContentVersion: n.ContentVersion,
			Size: e.Size, SHA256: e.SHA256, Mode: e.Mode, Local: expect(e), Base: b, Reason: "executable bit changed on this computer"})
	case rx != lx && r.k.down:
		r.add(Op{Kind: SetModeLocal, Path: p, EntryKind: localfs.KindFile, RemoteID: n.ID, Mode: withExec(e.Mode, rx),
			Local: expect(e), Base: b, Reason: "executable bit changed on one.gy"})
	}
}
