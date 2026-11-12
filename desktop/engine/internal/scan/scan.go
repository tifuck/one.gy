// Package scan owns the full walk of a sync root (plan 7.2): it builds the
// LocalTree the reconciler compares, honouring .onegyignore files (loaded
// top-down), staying on one mount, skipping .onegy/, and hashing a file only
// when its size, mtime or identity differ from local_cache. Problems
// (symlinks, bad names, permissions, bad rules) become issues and stalled
// paths instead of errors; Run fails only when the root itself is unusable.
package scan

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"time"
	"unicode/utf8"

	"github.com/tifuck/one.gy/desktop/engine/internal/ignore"
	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
)

// Entry is one local file or folder. ID is empty on file systems without
// stable ids. SHA256 is the plaintext hash (files only).
type Entry struct {
	Kind         localfs.Kind
	Size         int64
	MtimeNs      int64
	ID           localfs.FileID
	Mode         uint32
	SHA256       string
	SizeExcluded bool // only a size filter excludes it: sync it only if already synced
}

// Issue is a problem found while scanning; Kind uses the IPC issue kinds
// (symlink, invalid_name, permission, ignore_parse).
type Issue struct {
	Kind    string
	Path    string
	Message string
	Errors  []ignore.ParseError // ignore_parse only
}

// Stall reasons. A stalled path (and its subtree) is unknown this pass: the
// reconciler plans nothing there, so it is never mistaken for a delete.
const (
	StallIgnoreParse = "ignore_parse"
	StallPermission  = "permission"
	StallSymlink     = "symlink"
	StallMount       = "mount_point"
	StallInvalidName = "invalid_name"
	StallLocked      = "locked" // Windows sharing violation: retry later
	StallBusy        = "busy"   // changed while being hashed: retry later
)

// Tree is the result of one scan. Paths are relative to the root and
// '/'-separated; the root itself is not an entry.
type Tree struct {
	Entries map[string]*Entry
	Stalled map[string]string
	Issues  []Issue
	Rules   *ignore.Set
}

// IsStalled reports whether rel or one of its ancestors is stalled.
func (t *Tree) IsStalled(rel string) bool {
	if _, ok := t.Stalled[""]; ok {
		return true
	}
	for p := rel; p != "." && p != ""; p = path.Dir(p) {
		if _, ok := t.Stalled[p]; ok {
			return true
		}
	}
	return false
}

// Options for Run. RootRules, when set, replaces the root .onegyignore (the
// preview of a sync that does not exist yet). DB/SyncID enable the hash
// cache; without them every file is hashed. Windows hidden/system items are
// excluded (Rules.Hide) unless IncludeHiddenSystem. Progress, when set,
// hears how many files were looked at and how many bytes of new or changed
// ones were read so far (a first scan reads everything).
type Options struct {
	Root                string
	FSKind              string
	RootRules           *string
	DB                  *state.DB
	SyncID              string
	IncludeHiddenSystem bool
	Progress            func(files int, read int64)
}

type scanner struct {
	Options
	ctx     context.Context
	t       *Tree
	dev     uint64
	stable  bool
	cache   map[string]*state.LocalCacheRow
	byFID   map[localfs.FileID]*state.LocalCacheRow
	upserts []*state.LocalCacheRow
	buf     []byte
	files   int
	read    int64
}

func (s *scanner) progress() {
	if s.Progress != nil {
		s.Progress(s.files, s.read)
	}
}

// Run walks the root.
func Run(ctx context.Context, o Options) (*Tree, error) {
	ri, err := localfs.Lstat(o.Root)
	if err != nil {
		return nil, err
	}
	if ri.Kind != localfs.KindDir {
		return nil, fmt.Errorf("sync root is not a folder")
	}
	s := &scanner{Options: o, ctx: ctx, dev: ri.Dev, stable: localfs.IdentityStable(o.FSKind),
		t:     &Tree{Entries: map[string]*Entry{}, Stalled: map[string]string{}, Rules: ignore.NewSet()},
		cache: map[string]*state.LocalCacheRow{}, byFID: map[localfs.FileID]*state.LocalCacheRow{}, buf: make([]byte, 1<<20)}
	if o.DB != nil {
		if s.cache, err = o.DB.LoadLocalCache(ctx, o.SyncID); err != nil {
			return nil, err
		}
		for _, c := range s.cache {
			if c.LocalFID != "" {
				s.byFID[localfs.FileID(c.LocalFID)] = c
			}
		}
	}
	if err := s.dir(""); err != nil {
		return nil, err
	}
	if o.DB != nil {
		var gone []string
		for p := range s.cache {
			if e := s.t.Entries[p]; (e == nil || e.Kind != localfs.KindFile) && !s.t.IsStalled(p) {
				gone = append(gone, p)
			}
		}
		if err := o.DB.SaveLocalCache(ctx, o.SyncID, s.upserts, gone); err != nil {
			return nil, err
		}
	}
	return s.t, nil
}

func (s *scanner) abs(rel string) string { return filepath.Join(s.Root, filepath.FromSlash(rel)) }

func (s *scanner) stall(rel, reason, kind, msg string) {
	s.t.Stalled[rel] = reason
	if kind != "" {
		s.t.Issues = append(s.t.Issues, Issue{Kind: kind, Path: rel, Message: msg})
	}
}

func (s *scanner) loadRules(rel string) bool {
	var text string
	if rel == "" && s.RootRules != nil {
		text = *s.RootRules
	} else {
		p := path.Join(rel, ignore.FileName)
		in, err := localfs.Lstat(s.abs(p))
		if errors.Is(err, fs.ErrNotExist) || (err == nil && in.Kind != localfs.KindFile) {
			return true
		}
		var b []byte
		if err == nil {
			b, err = os.ReadFile(s.abs(p))
		}
		if err != nil {
			s.stall(rel, StallPermission, "permission", "Could not read "+ignore.FileName+": "+err.Error())
			return false
		}
		text = string(b)
	}
	r, errs := ignore.Parse(text)
	if errs != nil {
		s.t.Stalled[rel] = StallIgnoreParse
		s.t.Issues = append(s.t.Issues, Issue{Kind: "ignore_parse", Path: rel, Errors: errs,
			Message: ignore.FileName + " has errors; this folder is not synced until they are fixed."})
		return false
	}
	s.t.Rules.Add(rel, r)
	return true
}

func (s *scanner) dir(rel string) error {
	if err := s.ctx.Err(); err != nil {
		return err
	}
	if !s.loadRules(rel) {
		return nil
	}
	ents, err := os.ReadDir(s.abs(rel))
	if err != nil {
		s.stall(rel, StallPermission, "permission", "Could not list this folder: "+err.Error())
		return nil
	}
	for _, de := range ents {
		name := de.Name()
		child := path.Join(rel, name)
		if !utf8.ValidString(name) {
			s.stall(child, StallInvalidName, "invalid_name", "The name is not valid UTF-8 and is skipped.")
			continue
		}
		in, err := localfs.Lstat(s.abs(child))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			s.stall(child, StallPermission, "permission", err.Error())
			continue
		}
		if in.Hidden && !s.IncludeHiddenSystem {
			s.t.Rules.Hide(child)
			continue
		}
		res := s.t.Rules.Match(child, in.Kind, in.Size)
		if res == ignore.Excluded {
			continue
		}
		switch {
		case in.Kind == localfs.KindSymlink || in.Kind == localfs.KindSpecial:
			s.stall(child, StallSymlink, "symlink", "Symlinks, junctions, devices, FIFOs and sockets are not synced.")
			continue
		case in.Kind == localfs.KindDir && s.dev != 0 && in.Dev != s.dev:
			s.stall(child, StallMount, "symlink", "Another drive is mounted here; it is not synced.")
			continue
		}
		if !s.stable {
			in.ID = ""
		}
		e := &Entry{Kind: in.Kind, Size: in.Size, MtimeNs: in.MtimeNs, ID: in.ID, Mode: in.Mode, SizeExcluded: res == ignore.SizeExcluded}
		if in.Kind == localfs.KindDir {
			e.Size = 0
			s.t.Entries[child] = e
			if err := s.dir(child); err != nil {
				return err
			}
			continue
		}
		if err := s.hash(child, e, in); err != nil {
			return err
		}
	}
	return nil
}

// hash fills e.SHA256 from the cache or by reading the file. Only a context
// cancellation is returned as an error.
func (s *scanner) hash(rel string, e *Entry, in localfs.Info) error {
	s.files++
	s.progress()
	same := func(c *state.LocalCacheRow) bool {
		return c != nil && c.Size == e.Size && c.MtimeNs == e.MtimeNs && c.LocalFID == string(e.ID) && c.PlainSHA256 != ""
	}
	if c := s.cache[rel]; same(c) {
		e.SHA256 = c.PlainSHA256
		s.t.Entries[rel] = e
		return nil
	}
	if c := s.byFID[e.ID]; e.ID != "" && same(c) { // moved since the last scan
		e.SHA256 = c.PlainSHA256
	} else {
		sum, err := s.readHash(rel, in)
		if err := s.ctx.Err(); err != nil {
			return err
		}
		switch {
		case err == nil:
			e.SHA256 = sum
		case localfs.IsLocked(err):
			s.stall(rel, StallLocked, "", "")
			return nil
		case errors.Is(err, errChanged):
			s.stall(rel, StallBusy, "", "")
			return nil
		default:
			s.stall(rel, StallPermission, "permission", "Could not read this file: "+err.Error())
			return nil
		}
	}
	s.t.Entries[rel] = e
	s.upserts = append(s.upserts, &state.LocalCacheRow{RelPath: rel, LocalFID: string(e.ID), Size: e.Size, MtimeNs: e.MtimeNs,
		CtimeNs: in.CtimeNs, PlainSHA256: e.SHA256, HashedAt: time.Now().UTC().Format(time.RFC3339)})
	return nil
}

var errChanged = errors.New("file changed while being read")

var openFile = localfs.Open // replaced in tests

func (s *scanner) readHash(rel string, in localfs.Info) (string, error) {
	f, err := openFile(s.abs(rel))
	if err != nil {
		return "", err
	}
	defer f.Close()
	before, err := localfs.Fstat(f)
	if err != nil {
		return "", err
	}
	if before.Size != in.Size || before.MtimeNs != in.MtimeNs || (in.ID != "" && before.ID != in.ID) {
		return "", errChanged
	}
	h := sha256.New()
	var n int64
	for {
		if err := s.ctx.Err(); err != nil {
			return "", err
		}
		k, err := f.Read(s.buf)
		h.Write(s.buf[:k])
		n += int64(k)
		s.read += int64(k)
		s.progress()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	after, err := localfs.Fstat(f)
	if err != nil {
		return "", err
	}
	if n != in.Size || after.Size != in.Size || after.MtimeNs != in.MtimeNs {
		return "", errChanged
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
