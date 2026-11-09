// Package localfs owns the per-OS file system primitives of the sync engine
// (plan 7.2, 7.5, 7.7): no-follow stat with file identity, mtime precision per
// file system kind, atomic rename/replace with fsync, debris, snapshot opens,
// the stability window and local name mapping (names.go). Linux and Windows
// only; the OS-specific halves live in localfs_linux.go / localfs_windows.go.
package localfs

import (
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Kind is what a directory entry is. Symlinks and Special entries (device,
// FIFO, socket, junction) are never followed or synced.
type Kind uint8

const (
	KindFile Kind = iota + 1
	KindDir
	KindSymlink
	KindSpecial
)

func (k Kind) String() string {
	switch k {
	case KindFile:
		return "file"
	case KindDir:
		return "folder"
	case KindSymlink:
		return "symlink"
	case KindSpecial:
		return "special"
	}
	return "unknown"
}

// FileID is a stable file identity: "dev:ino" (Linux) or "volume:fileindex"
// (Windows), hex. Empty when the file system has none (FAT/exFAT).
type FileID string

// Info is the metadata the engine compares. Dev is the device (Linux) or the
// volume serial (Windows), used to stay on one mount.
type Info struct {
	Kind    Kind
	Size    int64
	MtimeNs int64
	CtimeNs int64 // Linux only
	Mode    uint32
	ID      FileID
	Dev     uint64
	Hidden  bool // Windows hidden or system attribute
}

// Lstat stats path without following a final symlink.
func Lstat(p string) (Info, error) {
	fi, err := os.Lstat(p)
	if err != nil {
		return Info{}, err
	}
	return infoOf(p, fi)
}

func kindOf(m fs.FileMode) Kind {
	switch {
	case m.IsRegular():
		return KindFile
	case m.IsDir():
		return KindDir
	case m&fs.ModeSymlink != 0:
		return KindSymlink
	}
	return KindSpecial
}

// IdentityStable reports whether file ids survive on this file system kind
// (detectFS kinds). FAT/exFAT ids are synthetic, so moves there are matched
// by size + hash instead.
func IdentityStable(fsKind string) bool {
	switch fsKind {
	case "vfat", "fat32", "exfat":
		return false
	}
	return true
}

// MtimePrecision is the mtime granularity of a file system kind in ns.
func MtimePrecision(fsKind string) int64 {
	switch fsKind {
	case "vfat", "fat32":
		return 2e9
	case "exfat":
		return 1e7
	case "ntfs", "refs", "smb":
		return 100
	}
	return 1
}

// SameMtime compares two mtimes at the file system's precision. mtime is only
// ever a local "maybe changed" hint, never compared across machines.
func SameMtime(a, b int64, fsKind string) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < MtimePrecision(fsKind)
}

// SyncFile fsyncs a file by path.
func SyncFile(p string) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// InsertSuffix puts suffix before the extension: ("a.txt", " (2)") ->
// "a (2).txt". A leading dot is not an extension (".bashrc (2)").
func InsertSuffix(name, suffix string) string {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 {
		return name + suffix
	}
	return name[:i] + suffix + name[i:]
}

// MoveToDebris moves root/rel into root/.onegy/debris/<day>/rel (same volume,
// atomic, never overwriting: a taken name gets " (2)", " (3)", ...; when a
// file already sits where rel needs a folder, the next bucket <day>-2, <day>-3,
// ... is used). It returns the debris path relative to root, '/'-separated.
func MoveToDebris(root, rel string, day time.Time) (string, error) {
	src := filepath.Join(root, filepath.FromSlash(rel))
	for b := 1; b <= 1000; b++ {
		bucket := day.Format("2006-01-02")
		if b > 1 {
			bucket += "-" + strconv.Itoa(b)
		}
		dstRel := path.Join(".onegy", "debris", bucket, rel)
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(path.Dir(dstRel))), 0o700); err != nil {
			if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, fs.ErrExist) {
				continue
			}
			return "", err
		}
		dir, name := path.Split(dstRel)
		for n := 1; n <= 10000; n++ {
			cand := dstRel
			if n > 1 {
				cand = dir + InsertSuffix(name, " ("+strconv.Itoa(n)+")")
			}
			err := RenameNoReplace(src, filepath.Join(root, filepath.FromSlash(cand)))
			if err == nil {
				return cand, nil
			}
			if !errors.Is(err, fs.ErrExist) {
				return "", err
			}
		}
	}
	return "", errors.New("debris: no free name")
}

// QuietPeriod is how long a changed file must stay unchanged before it is
// processed: 2 s, or 10 s above 1 GiB.
func QuietPeriod(size int64) time.Duration {
	if size > 1<<30 {
		return 10 * time.Second
	}
	return 2 * time.Second
}

// Stability tracks when each path last changed (size, mtime or identity).
// Safe for concurrent use.
type Stability struct {
	mu   sync.Mutex
	seen map[string]stamp
}

type stamp struct {
	size, mtime int64
	id          FileID
	since       time.Time
}

// Stable records info for rel and reports whether it has been unchanged for
// at least QuietPeriod as of now.
func (s *Stability) Stable(rel string, info Info, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen == nil {
		s.seen = map[string]stamp{}
	}
	st, ok := s.seen[rel]
	if !ok || st.size != info.Size || st.mtime != info.MtimeNs || st.id != info.ID {
		s.seen[rel] = stamp{info.Size, info.MtimeNs, info.ID, now}
		return false
	}
	return now.Sub(st.since) >= QuietPeriod(info.Size)
}

// Forget drops rel (processed or gone).
func (s *Stability) Forget(rel string) {
	s.mu.Lock()
	delete(s.seen, rel)
	s.mu.Unlock()
}
