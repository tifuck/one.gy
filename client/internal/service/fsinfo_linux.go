//go:build linux

package service

import "golang.org/x/sys/unix"

// Filesystem magic numbers (statfs f_type) for the kinds plan 6.3 cares about.
var fsMagic = map[int64]string{
	0xEF53: "ext4", 0x9123683E: "btrfs", 0x58465342: "xfs", 0x2FC12FC1: "zfs", 0xF2F52010: "f2fs",
	0x01021994: "tmpfs", 0x794c7630: "overlay", 0x4d44: "vfat", 0x2011BAB0: "exfat",
	0x7366746e: "ntfs", 0x5346544e: "ntfs", 0x65735546: "fuse",
	0x6969: "nfs", 0xFF534D42: "smb", 0xFE534D42: "smb", 0x517B: "smb", 0x00c36400: "ceph",
}

func detectFS(path string) fsInfo {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return fsInfo{Kind: "unknown", CaseSensitive: true}
	}
	kind, ok := fsMagic[int64(st.Type)]
	if !ok {
		kind = "unknown"
	}
	return fsInfo{Kind: kind, CaseSensitive: true, FreeBytes: int64(st.Bavail) * int64(st.Bsize),
		network: kind == "nfs" || kind == "smb" || kind == "ceph"}
}
