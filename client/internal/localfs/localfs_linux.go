//go:build linux

package localfs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

func infoOf(_ string, fi fs.FileInfo) (Info, error) {
	in := Info{Kind: kindOf(fi.Mode()), Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano(), Mode: uint32(fi.Mode().Perm())}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		in.ID = FileID(fmt.Sprintf("%x:%x", st.Dev, st.Ino))
		in.Dev = st.Dev
		in.MtimeNs = st.Mtim.Nano()
		in.CtimeNs = st.Ctim.Nano()
	}
	return in, nil
}

func fillStat(in *Info, st *unix.Stat_t) {
	in.ID = FileID(fmt.Sprintf("%x:%x", st.Dev, st.Ino))
	in.Dev = st.Dev
	in.MtimeNs = st.Mtim.Nano()
	in.CtimeNs = st.Ctim.Nano()
}

// Fstat returns Info of an open file (snapshot checks).
func Fstat(f *os.File) (Info, error) {
	var st unix.Stat_t
	if err := unix.Fstat(int(f.Fd()), &st); err != nil {
		return Info{}, err
	}
	in := Info{Size: st.Size, Mode: st.Mode & 0o777}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFREG:
		in.Kind = KindFile
	case unix.S_IFDIR:
		in.Kind = KindDir
	case unix.S_IFLNK:
		in.Kind = KindSymlink
	default:
		in.Kind = KindSpecial
	}
	fillStat(&in, &st)
	return in, nil
}

// Open opens a file for reading without following a final symlink.
func Open(p string) (*os.File, error) {
	fd, err := unix.Open(p, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: p, Err: err}
	}
	return os.NewFile(uintptr(fd), p), nil
}

// OpenForSnapshot opens a file to read it for upload. Linux has no mandatory
// share modes, so the caller's before/after fstat comparison is the guard.
func OpenForSnapshot(p string) (*os.File, error) { return Open(p) }

// IsLocked reports a sharing violation (Windows only).
func IsLocked(error) bool { return false }

// RenameNoReplace renames src to dst, failing with fs.ErrExist when dst
// exists, then fsyncs the parent directories. Uses renameat2(RENAME_NOREPLACE)
// and falls back to link+unlink (files) or a checked rename (directories) on
// file systems without it.
func RenameNoReplace(src, dst string) error {
	err := unix.Renameat2(unix.AT_FDCWD, src, unix.AT_FDCWD, dst, unix.RENAME_NOREPLACE)
	if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EOPNOTSUPP) {
		err = renameNoReplaceFallback(src, dst)
	}
	if err != nil {
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: err}
	}
	return syncParents(src, dst)
}

func renameNoReplaceFallback(src, dst string) error {
	fi, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		if err := unix.Link(src, dst); err != nil {
			return err
		}
		return unix.Unlink(src)
	}
	// ponytail: check-then-rename races with a concurrent creator of dst;
	// only reached on file systems without RENAME_NOREPLACE.
	if _, err := os.Lstat(dst); err == nil {
		return unix.EEXIST
	}
	return unix.Rename(src, dst)
}

// Replace atomically renames src over dst (dst may exist) and fsyncs the
// parent directories.
func Replace(src, dst string) error {
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	return syncParents(src, dst)
}

func syncParents(src, dst string) error {
	if err := SyncDir(filepath.Dir(dst)); err != nil {
		return err
	}
	if d := filepath.Dir(src); d != filepath.Dir(dst) {
		return SyncDir(d)
	}
	return nil
}

// SyncDir fsyncs a directory so a rename inside it is durable.
func SyncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// Hide is a no-op: the leading dot already hides .onegy.
func Hide(string) error { return nil }
