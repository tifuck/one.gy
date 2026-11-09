//go:build windows

package service

import (
	"strings"

	"golang.org/x/sys/windows"
)

func detectFS(path string) fsInfo {
	info := fsInfo{Kind: "unknown"}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return info
	}
	var free uint64
	if windows.GetDiskFreeSpaceEx(p, &free, nil, nil) == nil {
		info.FreeBytes = int64(free)
	}
	root := make([]uint16, windows.MAX_PATH+1)
	if windows.GetVolumePathName(p, &root[0], uint32(len(root))) != nil {
		return info
	}
	info.network = windows.GetDriveType(&root[0]) == windows.DRIVE_REMOTE
	name := make([]uint16, windows.MAX_PATH+1)
	if windows.GetVolumeInformation(&root[0], nil, 0, nil, nil, nil, &name[0], uint32(len(name))) == nil {
		switch k := strings.ToLower(windows.UTF16ToString(name)); k {
		case "fat", "fat32":
			info.Kind = "fat32"
		case "":
		default:
			info.Kind = k // ntfs, refs, exfat
		}
	}
	return info
}
