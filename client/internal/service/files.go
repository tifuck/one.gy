package service

import (
	"context"
	"encoding/json"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tifuck/one.gy/client/internal/ipc"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/state"
)

// File manager integration (engine-ipc.md "File manager integration"): the
// sync state of local items for status icons, and "files" events telling
// extensions which sync root to look at again.

const maxStatusPaths = 1000

// filesStatus answers files.status {"paths"}: one state per absolute path,
// synced | syncing | paused | error | none (not in a sync, excluded, or not
// seen yet).
func (s *Service) filesStatus(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		Paths []string `json:"paths"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	if len(in.Paths) > maxStatusPaths {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "paths", Message: "at most 1000 paths"}})
	}
	syncs, err := s.db.ListSyncs(ctx)
	if err != nil {
		return nil, err
	}
	issues := map[string]map[string]bool{} // sync id -> issue paths and their folders, loaded once
	items := make([]map[string]string, 0, len(in.Paths))
	for _, p := range in.Paths {
		st := "none"
		if row, rel, ok := syncOf(syncs, p); ok {
			if issues[row.ID] == nil {
				issues[row.ID] = s.issuePaths(ctx, row.ID)
			}
			st = s.itemState(ctx, row, rel, issues[row.ID])
		}
		items = append(items, map[string]string{"path": p, "state": st})
	}
	return map[string]any{"items": items}, nil
}

// syncOf finds the sync whose local root holds abs; rel is '/'-separated
// ("" = the root itself).
func syncOf(syncs []*state.SyncRow, abs string) (*state.SyncRow, string, bool) {
	if !filepath.IsAbs(abs) {
		return nil, "", false
	}
	abs = filepath.Clean(abs)
	for _, row := range syncs {
		if rel, ok := relIn(row.LocalRoot, abs, row.CaseSensitive); ok {
			return row, rel, true
		}
	}
	return nil, "", false
}

func relIn(root, abs string, caseSensitive bool) (string, bool) {
	root = filepath.Clean(root)
	same := func(a, b string) bool { return a == b || !caseSensitive && strings.EqualFold(a, b) }
	if same(abs, root) {
		return "", true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	if len(abs) <= len(prefix) || !same(abs[:len(prefix)], prefix) {
		return "", false
	}
	return filepath.ToSlash(abs[len(prefix):]), true
}

// issuePaths: the paths of a sync's open issues and every folder above them.
func (s *Service) issuePaths(ctx context.Context, syncID string) map[string]bool {
	out := map[string]bool{}
	rows, err := s.db.OpenIssues(ctx, syncID)
	if err != nil {
		return out
	}
	for _, r := range rows {
		out[""] = true
		for p := r.RelPath; p != "" && p != "." && !out[p]; p = path.Dir(p) {
			out[p] = true
		}
	}
	return out
}

func (s *Service) itemState(ctx context.Context, row *state.SyncRow, rel string, issues map[string]bool) string {
	if rel == ".onegy" || strings.HasPrefix(rel, ".onegy/") {
		return "none"
	}
	if issues[rel] {
		return "error"
	}
	r := s.mgr.Runner(row.ID)
	waiting := "syncing"
	if row.Paused {
		waiting = "paused"
	}
	if r != nil && r.Pending(rel) {
		return waiting
	}
	busy := r != nil && (r.State() == "syncing" || r.State() == "scanning")
	if rel == "" {
		switch {
		case row.Paused:
			return "paused"
		case busy:
			return "syncing"
		case row.State == "error" || row.State == "root_missing" || row.State == "stalled":
			return "error"
		}
		return "synced"
	}
	base, err := s.db.SyncedByPath(ctx, row.ID, rel)
	if err != nil || base == nil {
		if busy || row.Paused {
			return waiting // new and not planned yet, or waiting for the resume
		}
		return "none" // excluded, or not seen yet
	}
	if base.Kind == "folder" {
		return "synced"
	}
	in, err := localfs.Lstat(filepath.Join(row.LocalRoot, filepath.FromSlash(rel)))
	if err != nil || in.Size != base.Size || !localfs.SameMtime(in.MtimeNs, base.MtimeNs, row.FSKind) {
		return waiting // changed here since the last sync
	}
	return "synced"
}

// filesWebPath answers files.webPath {"path"} (the app's "Open on one.gy"):
// the site path of the item's one.gy folder (a file's own folder).
func (s *Service) filesWebPath(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		Path string `json:"path"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	syncs, err := s.db.ListSyncs(ctx)
	if err != nil {
		return nil, err
	}
	row, rel, ok := syncOf(syncs, in.Path)
	if !ok {
		return nil, ipc.Errorf("not_found", "this item is not in a sync folder")
	}
	folder := func(rel string) (any, error) {
		id := row.RemoteRootID
		if rel != "" {
			base, err := s.db.SyncedByPath(ctx, row.ID, rel)
			if err != nil {
				return nil, err
			}
			if base == nil || base.Kind != "folder" {
				return nil, ipc.Errorf("not_found", "this item is not on one.gy yet")
			}
			n, err := strconv.ParseInt(base.RemoteID, 10, 64)
			if err != nil {
				return nil, ipc.Errorf("not_found", "this item is not on one.gy yet")
			}
			id = &n
		}
		if id == nil {
			return map[string]string{"path": "/files"}, nil
		}
		return map[string]string{"path": "/files/folder/" + strconv.FormatInt(*id, 10)}, nil
	}
	if rel == "" {
		return folder("")
	}
	base, err := s.db.SyncedByPath(ctx, row.ID, rel)
	if err != nil {
		return nil, err
	}
	if base == nil {
		return nil, ipc.Errorf("not_found", "this item is not on one.gy yet")
	}
	if base.Kind == "folder" {
		return folder(rel)
	}
	dir := path.Dir(rel)
	if dir == "." {
		dir = ""
	}
	return folder(dir)
}

// filesThrottle sends at most one "files" event per sync and second, and
// always one after the last change.
type filesThrottle struct {
	mu    sync.Mutex
	timer map[string]*time.Timer
	dirty map[string]bool
}

// filesChanged tells subscribed file manager extensions to look at a sync
// root again.
func (s *Service) filesChanged(syncID string) {
	t := &s.files
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.timer == nil {
		t.timer, t.dirty = map[string]*time.Timer{}, map[string]bool{}
	}
	if t.timer[syncID] != nil {
		t.dirty[syncID] = true
		return
	}
	s.sendFiles(syncID)
	var tick func()
	tick = func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		if t.dirty[syncID] {
			delete(t.dirty, syncID)
			s.sendFiles(syncID)
			t.timer[syncID] = time.AfterFunc(time.Second, tick)
			return
		}
		delete(t.timer, syncID)
	}
	t.timer[syncID] = time.AfterFunc(time.Second, tick)
}

func (s *Service) sendFiles(syncID string) {
	if row, err := s.db.GetSync(context.Background(), syncID); err == nil && row != nil {
		s.rpc.Broadcast("files", map[string]string{"sync_id": syncID, "root": row.LocalRoot})
	}
}
