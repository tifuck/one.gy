package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/tifuck/one.gy/client/internal/account"
	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/remote"
	"github.com/tifuck/one.gy/client/internal/state"
)

// Setup rules of plan 6.3, shared by syncs.validate, create and update.

var syncTypes = []string{"two_way", "backup", "mirror", "archive", "full"}

type totals struct {
	Files int64 `json:"files"`
	Bytes int64 `json:"bytes"`
}

type fsInfo struct {
	Kind          string `json:"kind"` // ext4, btrfs, ntfs, fat32, exfat, nfs, smb, … or "unknown"
	CaseSensitive bool   `json:"case_sensitive"`
	FreeBytes     int64  `json:"free_bytes"`
	network       bool
}

type validateResult struct {
	OK       bool      `json:"ok"`
	Errors   []problem `json:"errors"`
	Warnings []problem `json:"warnings"`
	FS       fsInfo    `json:"fs"`
	Local    totals    `json:"local"`
	Remote   *totals   `json:"remote,omitempty"` // only when the one.gy side was checked

	localRoot string // resolved local path
}

func (r *validateResult) fail(code, msg string) {
	r.Errors = append(r.Errors, problem{Code: code, Message: msg})
}
func (r *validateResult) warn(code, msg string) {
	r.Warnings = append(r.Warnings, problem{Code: code, Message: msg})
}

// samePath / within compare cleaned absolute paths (case-insensitively on Windows).
func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func within(child, parent string) bool {
	if runtime.GOOS == "windows" {
		child, parent = strings.ToLower(child), strings.ToLower(parent)
	}
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func overlaps(a, b string) bool { return within(a, b) || within(b, a) }

// systemPath reports paths a sync root may never be.
func systemPath(p string) bool {
	if runtime.GOOS == "windows" {
		drive := os.Getenv("SystemDrive")
		if drive == "" {
			drive = "C:"
		}
		if samePath(p, drive+`\`) {
			return true
		}
		for _, d := range []string{os.Getenv("WINDIR"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramData")} {
			if d != "" && within(p, d) {
				return true
			}
		}
		return false
	}
	if p == "/" {
		return true
	}
	for _, d := range []string{"/etc", "/usr", "/proc", "/sys", "/dev", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/run"} {
		if within(p, d) {
			return true
		}
	}
	return false
}

var cloudDirs = []string{"onedrive", "dropbox", "google drive", "googledrive", "my drive", "mega", "megasync", "icloud drive", "iclouddrive"}

// insideCloudFolder returns the path component that belongs to another sync
// client ("OneDrive - Company" included), or "".
func insideCloudFolder(p string) string {
	for _, part := range strings.Split(filepath.ToSlash(p), "/") {
		l := strings.ToLower(part)
		if oneOf(l, cloudDirs...) || strings.HasPrefix(l, "onedrive -") {
			return part
		}
	}
	return ""
}

// probeCase creates a temp file and looks it up in upper case. It doubles as
// the write-permission check.
func probeCase(dir string) (caseSensitive bool, err error) {
	f, err := os.CreateTemp(dir, ".onegy-probe-*.tmp")
	if err != nil {
		return false, err
	}
	name := f.Name()
	f.Close()
	defer os.Remove(name)
	_, err = os.Stat(filepath.Join(dir, strings.ToUpper(filepath.Base(name))))
	return err != nil, nil
}

// countLocal walks the folder (skipping .onegy) for at most limit time.
func countLocal(root string, limit time.Duration) (t totals, complete bool) {
	deadline := time.Now().Add(limit)
	errStop := errors.New("stop")
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if time.Now().After(deadline) {
			return errStop
		}
		if d.IsDir() && d.Name() == ".onegy" {
			return filepath.SkipDir
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				t.Files++
				t.Bytes += info.Size()
			}
		}
		return nil
	})
	return t, err == nil
}

// remoteAncestors returns the folder and all its ancestors (as ids).
func (s *Service) remoteAncestors(ctx context.Context, id *int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	for depth := 0; id != nil && depth < 1000; depth++ {
		out[*id] = true
		n, err := s.tree.Folder(ctx, id)
		if err != nil {
			return nil, err
		}
		id = n.ParentID
	}
	return out, nil
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// validateSync applies every setup rule. excludeID skips that sync in the
// overlap checks (updates); checkRemote false runs the local checks only.
// An error return means the check itself could not run.
func (s *Service) validateSync(ctx context.Context, localPath string, remoteID *int64, typ, excludeID string, checkRemote bool) (*validateResult, error) {
	r := &validateResult{Errors: []problem{}, Warnings: []problem{}, FS: fsInfo{Kind: "unknown"}}

	if !oneOf(typ, syncTypes...) {
		r.fail("invalid_type", "sync type must be one of two_way, backup, mirror, archive, full")
	}
	if !filepath.IsAbs(localPath) {
		r.fail("local_invalid", "choose a full folder path")
		return r, nil
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(localPath))
	if errors.Is(err, fs.ErrNotExist) {
		r.fail("local_missing", "the folder does not exist")
		return r, nil
	}
	if err != nil {
		r.fail("local_invalid", "cannot open the folder: "+err.Error())
		return r, nil
	}
	if real, err = filepath.Abs(real); err != nil {
		return nil, err
	}
	r.localRoot = real
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		r.fail("local_not_dir", "the path is not a folder")
		return r, nil
	}
	if systemPath(real) {
		r.fail("system_path", "system folders cannot be synced")
	}
	if home, err := os.UserHomeDir(); err == nil && samePath(real, filepath.Clean(home)) {
		r.warn("home_dir", "this syncs your whole home folder, including app settings and caches")
	}
	if within(real, s.opts.StateDir) || within(s.opts.StateDir, real) {
		r.fail("state_dir_overlap", "the folder overlaps the ONE.GY Desktop data folder")
	}
	if c := insideCloudFolder(real); c != "" {
		r.warn("cloud_folder", fmt.Sprintf("the folder is inside %q; two sync apps on one folder fight over changes", c))
	}

	r.FS = detectFS(real)
	cs, err := probeCase(real)
	if err != nil {
		r.fail("local_not_writable", "ONE.GY cannot write to this folder")
	} else {
		r.FS.CaseSensitive = cs
	}
	switch {
	case r.FS.Kind == "fat32" || r.FS.Kind == "exfat" || r.FS.Kind == "vfat":
		r.warn("fat", "FAT/exFAT drives have no stable file IDs and 2-second timestamps; FAT32 cannot store files over 4 GB")
	case r.FS.network:
		r.warn("network_fs", "network drives do not report changes reliably; this folder will be scanned periodically instead")
	}

	syncs, err := s.db.ListSyncs(ctx)
	if err != nil {
		return nil, err
	}
	var others []*state.SyncRow
	for _, o := range syncs {
		if o.ID != excludeID {
			others = append(others, o)
		}
	}
	for _, o := range others {
		if overlaps(real, o.LocalRoot) {
			r.fail("local_overlap", fmt.Sprintf("the folder overlaps the sync %q (%s)", o.Name, o.LocalRoot))
		}
	}

	// Remote side: needs the unlocked account and its cached tree. Without
	// it the local checks still run and the reason is reported as an error.
	switch err := s.tree.EnsureSynced(ctx); {
	case !checkRemote:
	case err == nil:
		if err := s.validateRemote(ctx, r, remoteID, typ, others); err != nil {
			return nil, err
		}
	case errors.Is(err, account.ErrNotSignedIn):
		r.fail("not_signed_in", "sign in to check the one.gy folder")
	case errors.Is(err, account.ErrLocked):
		r.fail("locked", "unlock this computer to check the one.gy folder")
	case errors.Is(err, api.ErrOffline):
		r.fail("offline", "cannot reach one.gy to check the folder")
	default:
		return nil, err
	}

	local, complete := countLocal(real, 10*time.Second)
	r.Local = local
	if !complete {
		r.warn("local_count_partial", "the folder is large; the size shown is a partial count")
	}
	downloads := oneOf(typ, "two_way", "mirror", "full")
	uploads := typ != "mirror"
	if downloads && r.Remote != nil && r.FS.FreeBytes > 0 && r.Remote.Bytes+r.Remote.Bytes/10 > r.FS.FreeBytes {
		r.warn("low_space", fmt.Sprintf("the one.gy folder holds %s but only %s is free here", humanBytes(r.Remote.Bytes), humanBytes(r.FS.FreeBytes)))
	}
	if uploads {
		st := s.acct.Status(ctx)
		if st.StorageLimit > 0 && r.Local.Bytes > st.StorageLimit-st.StorageUsed {
			r.warn("quota", fmt.Sprintf("the folder holds %s but only %s of your one.gy storage is left",
				humanBytes(r.Local.Bytes), humanBytes(max(st.StorageLimit-st.StorageUsed, 0))))
		}
	}
	r.OK = len(r.Errors) == 0
	return r, nil
}

// validateRemote applies the one.gy-side rules (full sync, remote existence
// and overlap) and fills the remote totals.
func (s *Service) validateRemote(ctx context.Context, r *validateResult, remoteID *int64, typ string, others []*state.SyncRow) error {
	if typ == "full" {
		if remoteID != nil {
			r.fail("full_needs_root", "a full sync always uses the whole drive")
		}
		if len(others) > 0 {
			r.fail("full_exclusive", "a full sync cannot run next to other syncs")
		}
	} else {
		if remoteID == nil {
			r.fail("remote_root_needs_full", "choose a one.gy folder (the whole drive needs a full sync)")
		}
		for _, o := range others {
			if o.Type == "full" {
				r.fail("full_exclusive", "a full sync already covers the whole drive")
			}
		}
	}
	if remoteID != nil {
		if _, err := s.tree.FolderFresh(ctx, remoteID); errors.Is(err, remote.ErrNotFound) {
			r.fail("remote_missing", "the one.gy folder does not exist or is in the trash")
		} else if err != nil {
			return err
		} else if err := s.backupProblems(ctx, r, remoteID, typ); err != nil {
			return err
		} else if typ != "mirror" {
			mine, err := s.remoteAncestors(ctx, remoteID)
			if err != nil {
				return err
			}
			for _, o := range others {
				if o.Type == "mirror" || o.RemoteRootID == nil {
					continue
				}
				theirs, err := s.remoteAncestors(ctx, o.RemoteRootID)
				if err != nil {
					continue // their root is gone; that sync reports it
				}
				if mine[*o.RemoteRootID] || theirs[*remoteID] {
					r.fail("remote_overlap", fmt.Sprintf("the one.gy folder overlaps the sync %q", o.Name))
				}
			}
		}
	}
	r.Remote = &totals{}
	if f, b, err := s.db.SubtreeTotals(ctx, remoteID); err == nil {
		r.Remote = &totals{f, b}
	}

	return nil
}
