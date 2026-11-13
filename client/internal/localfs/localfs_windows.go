//go:build windows

package localfs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// longPath adds the \\?\ prefix Go's os package adds internally, for the
// raw Win32 calls below.
func longPath(p string) string {
	if len(p) < 248 || strings.HasPrefix(p, `\\?\`) || !filepath.IsAbs(p) {
		return p
	}
	if strings.HasPrefix(p, `\\`) {
		return `\\?\UNC\` + p[2:]
	}
	return `\\?\` + p
}

func winPath(p string) (*uint16, error) { return windows.UTF16PtrFromString(longPath(p)) }

func infoOf(p string, fi fs.FileInfo) (Info, error) {
	in := Info{Kind: kindOf(fi.Mode()), Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano()}
	if d, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		in.MtimeNs = d.LastWriteTime.Nanoseconds()
	}
	if in.Kind != KindFile && in.Kind != KindDir {
		return in, nil
	}
	name, err := winPath(p)
	if err != nil {
		return in, err
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return in, &fs.PathError{Op: "open", Path: p, Err: err}
	}
	defer windows.CloseHandle(h)
	return in, fillHandle(&in, h)
}

func fillHandle(in *Info, h windows.Handle) error {
	var d windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &d); err != nil {
		return err
	}
	in.ID = FileID(fmt.Sprintf("%x:%x%08x", d.VolumeSerialNumber, d.FileIndexHigh, d.FileIndexLow))
	in.Dev = uint64(d.VolumeSerialNumber)
	in.Size = int64(d.FileSizeHigh)<<32 | int64(d.FileSizeLow)
	in.MtimeNs = d.LastWriteTime.Nanoseconds()
	in.Hidden = d.FileAttributes&(windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM) != 0
	return nil
}

// Fstat returns Info of an open file (snapshot checks).
func Fstat(f *os.File) (Info, error) {
	fi, err := f.Stat()
	if err != nil {
		return Info{}, err
	}
	in := Info{Kind: kindOf(fi.Mode()), Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano()}
	return in, fillHandle(&in, windows.Handle(f.Fd()))
}

func openShared(p string, share uint32) (*os.File, error) {
	name, err := winPath(p)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, share, nil, windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: p, Err: err}
	}
	return os.NewFile(uintptr(h), p), nil
}

// Open opens a file for reading without following a reparse point; other
// processes may keep reading, writing and deleting.
func Open(p string) (*os.File, error) {
	return openShared(p, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE)
}

// OpenForSnapshot opens with share-read only, so writers are blocked while
// the file is read for upload. A locked file fails with IsLocked(err).
func OpenForSnapshot(p string) (*os.File, error) { return openShared(p, windows.FILE_SHARE_READ) }

// IsLocked reports a sharing or lock violation (Office, PST files).
func IsLocked(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

func move(src, dst string, flags uint32) error {
	s, err := winPath(src)
	if err != nil {
		return err
	}
	d, err := winPath(dst)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(s, d, flags|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: err}
	}
	return nil
}

// RenameNoReplace renames src to dst, failing with fs.ErrExist when dst exists.
func RenameNoReplace(src, dst string) error { return move(src, dst, 0) }

// Replace atomically renames src over dst (dst may exist).
func Replace(src, dst string) error { return move(src, dst, windows.MOVEFILE_REPLACE_EXISTING) }

// SyncDir is a no-op: directories cannot be flushed on Windows, and
// MOVEFILE_WRITE_THROUGH already makes renames durable.
func SyncDir(string) error { return nil }

// Hide sets the hidden attribute (the .onegy folder).
func Hide(p string) error {
	name, err := winPath(p)
	if err != nil {
		return err
	}
	attrs, err := windows.GetFileAttributes(name)
	if err != nil {
		return err
	}
	return windows.SetFileAttributes(name, attrs|windows.FILE_ATTRIBUTE_HIDDEN)
}
