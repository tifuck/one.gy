package service

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/exec"
	"github.com/tifuck/one.gy/desktop/engine/internal/ignore"
	"github.com/tifuck/one.gy/desktop/engine/internal/ipc"
	"github.com/tifuck/one.gy/desktop/engine/internal/syncer"
)

// IPC methods that act on running syncs and transfers: preview, syncNow,
// verify, ignore rules, transfers.*, issues.*, manual.*, activity.recent and
// engine.environment.

func (s *Service) runner(id string) (*syncer.Runner, error) {
	if r := s.mgr.Runner(id); r != nil {
		return r, nil
	}
	return nil, ipc.Errorf("not_found", "no such sync")
}

type idParam struct {
	ID string `json:"id"`
}

func (s *Service) syncsPreview(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		Config  json.RawMessage `json:"config"`
		Initial string          `json:"initial"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	if in.Initial == "" {
		in.Initial = "merge"
	}
	cfg := syncInput{SyncConfig: s.defaultSyncConfig()}
	if err := applyPatch(cfg.SyncConfig, in.Config, &cfg); err != nil {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "config", Message: err.Error()}})
	}
	c := cfg.SyncConfig
	c.RemoteFolderID = zeroIsRoot(c.RemoteFolderID)
	errs := c.check()
	if !oneOf(in.Initial, "merge", "local_source", "remote_source") {
		errs = append(errs, problem{Code: "invalid", Field: "initial", Message: "initial must be merge, local_source or remote_source"})
	}
	if cfg.IgnoreRules != nil {
		errs = append(errs, checkRules(*cfg.IgnoreRules)...)
	}
	if len(errs) > 0 {
		return nil, validationFailed(errs)
	}
	res, err := s.validateSync(ctx, c.LocalPath, c.RemoteFolderID, c.Type, "", true)
	if err != nil {
		return nil, err
	}
	if !res.OK {
		return nil, validationFailed(res.Errors)
	}
	return syncer.Preview(ctx, s.senv, syncer.PreviewParams{Root: res.localRoot, FSKind: res.FS.Kind, CaseSensitive: res.FS.CaseSensitive,
		RootID: c.RemoteFolderID, Type: c.Type, ConflictPolicy: c.ConflictPolicy, IssueMode: c.IssueMode, PropagateDeletes: c.PropagateDeletes,
		Initial: in.Initial, IgnoreRules: cfg.IgnoreRules, IncludeHiddenSystem: c.IncludeHiddenSystem})
}

func (s *Service) syncsSyncNow(_ context.Context, params json.RawMessage) (any, error) {
	var in idParam
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	r, err := s.runner(in.ID)
	if err != nil {
		return nil, err
	}
	s.poller.Nudge()
	r.SyncNow()
	return struct{}{}, nil
}

func (s *Service) syncsVerify(ctx context.Context, params json.RawMessage) (any, error) {
	var in idParam
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	r, err := s.runner(in.ID)
	if err != nil {
		return nil, err
	}
	return r.Verify(ctx, func(done, total int) {
		s.rpc.Broadcast("verify", map[string]any{"sync_id": in.ID, "done": done, "total": total})
	})
}

func (s *Service) syncRoot(ctx context.Context, id string) (string, error) {
	row, err := s.db.GetSync(ctx, id)
	if err != nil {
		return "", err
	}
	if row == nil {
		return "", ipc.Errorf("not_found", "no such sync")
	}
	return row.LocalRoot, nil
}

func (s *Service) syncsIgnoreRules(ctx context.Context, params json.RawMessage) (any, error) {
	var in idParam
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	root, err := s.syncRoot(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(root, ignore.FileName))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return map[string]string{"text": string(b)}, nil
}

func (s *Service) syncsSetIgnoreRules(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	root, err := s.syncRoot(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	if _, errs := ignore.Parse(in.Text); errs != nil {
		return map[string]any{"ok": false, "errors": errs}, nil
	}
	if err := syncer.WriteIgnoreRules(root, in.Text); err != nil {
		return nil, err
	}
	s.mgr.Wake(in.ID)
	return map[string]any{"ok": true, "errors": []any{}}, nil
}

func (s *Service) transfersList(_ context.Context, params json.RawMessage) (any, error) {
	var in struct {
		State string `json:"state"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	if !oneOf(in.State, "", exec.TActive, exec.TQueued, exec.TDone, exec.TFailed, exec.TPaused, exec.TCancelled) {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "state", Message: "state must be active, queued, done or failed"}})
	}
	return s.pool.List(in.State), nil
}

func (s *Service) transfersPause(params json.RawMessage, pause bool) (any, error) {
	var in struct {
		ID        string `json:"id"`
		Direction string `json:"direction"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	if !oneOf(in.Direction, "", exec.Up, exec.Down) {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "direction", Message: "direction must be up or down"}})
	}
	if !s.pool.SetPaused(in.ID, in.Direction, pause) {
		return nil, ipc.Errorf("not_found", "no such transfer")
	}
	return struct{}{}, nil
}

func (s *Service) transfersCancel(_ context.Context, params json.RawMessage) (any, error) {
	var in idParam
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	if !s.pool.Cancel(in.ID) {
		for _, t := range s.pool.List("") {
			if t.ID == in.ID {
				return nil, validationFailed([]problem{{Code: "not_manual", Message: "only manual transfers can be cancelled; pause the sync instead"}})
			}
		}
		return nil, ipc.Errorf("not_found", "no such transfer")
	}
	return struct{}{}, nil
}

func (s *Service) issuesList(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		SyncID string `json:"sync_id"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	rows, err := s.db.OpenIssues(ctx, in.SyncID)
	if err != nil {
		return nil, err
	}
	out := []syncer.IssueView{}
	for _, r := range rows {
		out = append(out, syncer.View(r))
	}
	return out, nil
}

func (s *Service) issuesResolve(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		ID     int64  `json:"id"`
		Action string `json:"action"`
		Name   string `json:"name"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	row, err := s.db.GetIssue(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ipc.Errorf("not_found", "no such open issue")
	}
	if in.Action == "remove_sync" {
		v := syncer.View(row)
		for _, a := range v.Actions {
			if a == "remove_sync" {
				b, _ := json.Marshal(map[string]any{"id": row.SyncID})
				return s.syncsRemove(ctx, b)
			}
		}
	}
	err = s.mgr.ResolveIssue(ctx, row, in.Action, in.Name)
	if errors.Is(err, syncer.ErrBadAction) {
		return nil, validationFailed([]problem{{Code: "invalid_action", Field: "action", Message: err.Error()}})
	}
	if err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) issuesResolveAll(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		SyncID string `json:"sync_id"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	rows, err := s.db.ListSyncs(ctx)
	if err != nil {
		return nil, err
	}
	n := 0
	for _, row := range rows {
		if in.SyncID != "" && row.ID != in.SyncID {
			continue
		}
		if r := s.mgr.Runner(row.ID); r != nil {
			k, err := r.ResolveAll(ctx)
			if err != nil {
				return nil, err
			}
			n += k
		}
	}
	return map[string]int{"resolved": n}, nil
}

func (s *Service) manualUpload(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		Paths          []string `json:"paths"`
		RemoteFolderID *int64   `json:"remote_folder_id"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	folder := zeroIsRoot(in.RemoteFolderID)
	if err := s.tree.EnsureSynced(ctx); err != nil {
		return nil, err
	}
	if _, err := s.tree.FolderFresh(ctx, folder); err != nil {
		return nil, err
	}
	var errs []problem
	for _, p := range in.Paths {
		if !filepath.IsAbs(p) {
			errs = append(errs, problem{Code: "invalid", Field: "paths", Message: "paths must be absolute"})
		}
	}
	if len(in.Paths) == 0 {
		errs = append(errs, problem{Code: "invalid", Field: "paths", Message: "choose at least one file"})
	}
	if len(errs) > 0 {
		return nil, validationFailed(errs)
	}
	ids := []string{}
	for _, p := range in.Paths {
		id, err := exec.ManualUpload(s.root(), s.xenv, s.opts.StateDir, p, folder)
		if err != nil {
			return nil, validationFailed([]problem{{Code: "invalid", Field: "paths", Message: err.Error()}})
		}
		ids = append(ids, id)
	}
	return map[string]any{"transfer_ids": ids}, nil
}

func (s *Service) manualDownload(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		RemoteIDs []string `json:"remote_ids"`
		LocalDir  string   `json:"local_dir"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	if fi, err := os.Stat(in.LocalDir); !filepath.IsAbs(in.LocalDir) || err != nil || !fi.IsDir() {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "local_dir", Message: "choose an existing folder"}})
	}
	if _, err := s.tree.Sync(ctx); err != nil {
		return nil, err
	}
	ids := []string{}
	for _, id := range in.RemoteIDs {
		tid, err := exec.ManualDownload(s.root(), s.xenv, id, in.LocalDir)
		if err != nil {
			return nil, validationFailed([]problem{{Code: "invalid", Field: "remote_ids", Message: err.Error()}})
		}
		ids = append(ids, tid)
	}
	return map[string]any{"transfer_ids": ids}, nil
}

func (s *Service) activityRecent(ctx context.Context, params json.RawMessage) (any, error) {
	in := struct {
		Limit int `json:"limit"`
	}{Limit: 20}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	in.Limit = min(max(in.Limit, 1), 200)
	ops, err := s.db.RecentOps(ctx, in.Limit*4)
	if err != nil {
		return nil, err
	}
	out := []syncer.Activity{}
	for _, o := range ops {
		a, ok := syncer.ActivityName(o.Kind)
		if !ok {
			continue
		}
		var rec struct {
			Op struct {
				From string
			} `json:"op"`
		}
		json.Unmarshal([]byte(o.Pre), &rec)
		p := o.RelPath
		if a == "conflict" && rec.Op.From != "" {
			p = rec.Op.From
		}
		out = append(out, syncer.Activity{At: o.FinishedAt, SyncID: o.SyncID, Action: a, Path: p})
		if len(out) == in.Limit {
			break
		}
	}
	return out, nil
}

// syncsClearDebris deletes everything in the sync's .onegy/debris now.
func (s *Service) syncsClearDebris(ctx context.Context, params json.RawMessage) (any, error) {
	var in idParam
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	root, err := s.syncRoot(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.TakeDebris(ctx, in.ID, time.Now().Add(time.Minute)); err != nil {
		return nil, err
	}
	// Only a real .onegy folder: never follow a link out of the sync root.
	dir := filepath.Join(root, ".onegy")
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return struct{}{}, nil
	}
	if err := os.RemoveAll(filepath.Join(dir, "debris")); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

// engineClearCaches drops the unwrapped keys, the capabilities and the
// cached remote tree, and takes a new snapshot.
func (s *Service) engineClearCaches(ctx context.Context, _ json.RawMessage) (any, error) {
	s.mu.Lock()
	s.caps = nil
	s.mu.Unlock()
	if err := s.tree.Reset(ctx); err != nil {
		return nil, err
	}
	s.mgr.Wake("")
	return struct{}{}, nil
}

func (s *Service) engineEnvironment(_ context.Context, params json.RawMessage) (any, error) {
	var in struct {
		OnBattery bool `json:"on_battery"`
		Metered   bool `json:"metered"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	s.mgr.SetEnvironment(in.OnBattery, in.Metered)
	return struct{}{}, nil
}
