package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/config"
	"github.com/tifuck/one.gy/client/internal/ignore"
	"github.com/tifuck/one.gy/client/internal/ipc"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/logx"
	"github.com/tifuck/one.gy/client/internal/state"
	"github.com/tifuck/one.gy/client/internal/syncer"
)

// syncs.* methods: configuration, validation and the root marker. The sync
// work itself runs in the syncer runners (internal/syncer).

var conflictPolicies = []string{"keep_both", "prefer_remote", "prefer_local", "ask"}

// SyncConfig is the user-editable part of a Sync (engine-ipc.md "Sync").
type SyncConfig struct {
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	LocalPath        string   `json:"local_path"`
	RemoteFolderID   *int64   `json:"remote_folder_id"`
	Encryption       string   `json:"encryption"`
	HideExtensions   bool     `json:"hide_extensions"`
	ConflictPolicy   string   `json:"conflict_policy"`
	IssueMode        string   `json:"issue_mode"`
	PropagateDeletes bool     `json:"propagate_deletes"`
	DebrisDays       int      `json:"debris_days"`
	Schedule         Schedule `json:"schedule"`
	Limits           Limits   `json:"limits"`
	Metered          string   `json:"metered"`
	Battery          string   `json:"battery"`
	KeepExecBit      bool     `json:"keep_exec_bit"`
	Thumbnails       bool     `json:"thumbnails"`

	// Windows hidden/system items are not synced unless this is on.
	IncludeHiddenSystem bool `json:"include_hidden_system"`
}

type Schedule struct {
	Mode            string  `json:"mode"`
	IntervalMinutes int     `json:"interval_minutes"`
	Window          *Window `json:"window"`
}

type Window struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type Limits struct {
	UploadKbps   int `json:"upload_kbps"`
	DownloadKbps int `json:"download_kbps"`
}

// syncInput accepts a full Sync object: the read-only fields are ignored.
type syncInput struct {
	SyncConfig
	IgnoreRules *string         `json:"ignore_rules"` // .onegyignore text; written to the root, not stored
	ID          json.RawMessage `json:"id"`
	RemotePath  json.RawMessage `json:"remote_path"`
	State       json.RawMessage `json:"state"`
	Paused      json.RawMessage `json:"paused"`
	Detail      json.RawMessage `json:"detail"`
	Waiting     json.RawMessage `json:"waiting"`
	RetryAt     json.RawMessage `json:"retry_at"`
	Stats       json.RawMessage `json:"stats"`
	CreatedAt   json.RawMessage `json:"created_at"`
}

// Sync is the IPC Sync object.
type Sync struct {
	ID string `json:"id"`
	SyncConfig
	RemotePath string    `json:"remote_path"`
	State      string    `json:"state"`
	Paused     bool      `json:"paused"`
	Detail     string    `json:"detail"`   // why it waits or what it is busy with ("" = nothing to add)
	Waiting    bool      `json:"waiting"`  // not getting on right now; detail says why
	RetryAt    *string   `json:"retry_at"` // when a waiting sync tries again
	Stats      SyncStats `json:"stats"`
	CreatedAt  string    `json:"created_at"`
}

type SyncStats struct {
	syncer.Stats
	Issues       int    `json:"issues"`
	LastSyncedAt string `json:"last_synced_at"`
}

// storedConfig is sync.config_json.
type storedConfig struct {
	SyncConfig
	Initial string `json:"initial"`
}

var hhmm = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

func (s *Service) defaultSyncConfig() SyncConfig {
	d := s.settings().Defaults
	return SyncConfig{Type: d.Type, Encryption: "e2ee", ConflictPolicy: d.ConflictPolicy, IssueMode: d.IssueMode,
		PropagateDeletes: true, DebrisDays: d.DebrisDays, Schedule: Schedule{Mode: "live", IntervalMinutes: 15},
		Metered: "inherit", Battery: "inherit", KeepExecBit: true, Thumbnails: d.Thumbnails}
}

// check validates the option values (not the paths; see validateSync).
func (c *SyncConfig) check() []problem {
	var errs []problem
	bad := func(field, msg string) { errs = append(errs, problem{Code: "invalid", Field: field, Message: msg}) }
	if len([]rune(c.Name)) > 100 {
		bad("name", "name must be at most 100 characters")
	}
	if !oneOf(c.Encryption, "e2ee", "standard") {
		bad("encryption", "encryption must be e2ee or standard")
	}
	if c.HideExtensions && c.Encryption != "e2ee" {
		bad("hide_extensions", "hiding extensions needs end-to-end encryption")
	}
	if !oneOf(c.ConflictPolicy, conflictPolicies...) {
		bad("conflict_policy", "conflict policy must be keep_both, prefer_remote, prefer_local or ask")
	}
	if !oneOf(c.IssueMode, "smart", "advanced") {
		bad("issue_mode", "issue mode must be smart or advanced")
	}
	if c.DebrisDays < 0 || c.DebrisDays > 3650 {
		bad("debris_days", "debris retention must be 0-3650 days")
	}
	switch c.Schedule.Mode {
	case "live", "manual":
	case "interval":
		if c.Schedule.IntervalMinutes < 1 || c.Schedule.IntervalMinutes > 1440 {
			bad("schedule.interval_minutes", "interval must be 1-1440 minutes")
		}
	case "window":
		if w := c.Schedule.Window; w == nil || !hhmm.MatchString(w.From) || !hhmm.MatchString(w.To) {
			bad("schedule.window", "window needs from and to as HH:MM")
		}
	default:
		bad("schedule.mode", "schedule must be live, interval, window or manual")
	}
	if c.Limits.UploadKbps < 0 || c.Limits.DownloadKbps < 0 {
		bad("limits", "bandwidth limits cannot be negative")
	}
	if !oneOf(c.Metered, "inherit", "pause", "continue") || !oneOf(c.Battery, "inherit", "pause", "continue") {
		bad("metered", "metered and battery must be inherit, pause or continue")
	}
	return errs
}

func (s *Service) toSync(ctx context.Context, r *state.SyncRow) Sync {
	var sc storedConfig
	json.Unmarshal([]byte(r.Config), &sc)
	c := sc.SyncConfig
	c.Name, c.Type, c.LocalPath, c.RemoteFolderID, c.Encryption = r.Name, r.Type, r.LocalRoot, r.RemoteRootID, r.Encryption
	issues, _ := s.db.OpenIssueCount(ctx, r.ID)
	st := r.State
	if r.Paused {
		st = "paused"
	}
	out := Sync{ID: r.ID, SyncConfig: c, RemotePath: r.RemotePath, State: st, Paused: r.Paused, CreatedAt: r.CreatedAt,
		Stats: SyncStats{Issues: issues, LastSyncedAt: r.LastSyncedAt}}
	if run := s.mgr.Runner(r.ID); run != nil {
		out.Stats.Stats = run.Stats()
		// Bytes of transfers under way count as soon as they have moved.
		moved, note := s.pool.Flow(r.ID)
		out.Stats.BytesLeft = max(out.Stats.BytesLeft-moved, 0)
		detail, waiting, at := run.Detail()
		if detail == "" {
			detail, waiting = note, note != ""
		}
		out.Detail, out.Waiting = detail, waiting
		if !at.IsZero() {
			t := at.UTC().Format(time.RFC3339)
			out.RetryAt = &t
		}
	}
	return out
}

func (s *Service) syncsList(ctx context.Context, _ json.RawMessage) (any, error) {
	rows, err := s.db.ListSyncs(ctx)
	if err != nil {
		return nil, err
	}
	out := []Sync{}
	for _, r := range rows {
		out = append(out, s.toSync(ctx, r))
	}
	return out, nil
}

func (s *Service) syncsValidate(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		LocalPath      string          `json:"local_path"`
		RemoteFolderID json.RawMessage `json:"remote_folder_id"` // omitted = local checks only; null = drive root
		Type           string          `json:"type"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	if in.Type == "" {
		in.Type = s.settings().Defaults.Type
	}
	var remoteID *int64
	if in.RemoteFolderID != nil {
		if err := json.Unmarshal(in.RemoteFolderID, &remoteID); err != nil {
			return nil, validationFailed([]problem{{Code: "invalid", Field: "remote_folder_id", Message: "remote_folder_id must be a folder id or null"}})
		}
	}
	return s.validateSync(ctx, in.LocalPath, zeroIsRoot(remoteID), in.Type, "", in.RemoteFolderID != nil)
}

func (s *Service) syncsCreate(ctx context.Context, params json.RawMessage) (any, error) {
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
	if c.Type == "backup" && c.RemoteFolderID == nil {
		t, err := s.backupTarget(ctx, c.LocalPath, true)
		if err != nil {
			return nil, err
		}
		id := t["folder_id"].(int64)
		c.RemoteFolderID = &id
	}
	res, err := s.validateSync(ctx, c.LocalPath, c.RemoteFolderID, c.Type, "", true)
	if err != nil {
		return nil, err
	}
	if !res.OK {
		return nil, validationFailed(res.Errors)
	}
	if c.Type == "backup" {
		if err := s.setBackup(ctx, *c.RemoteFolderID, true); err != nil {
			return nil, err
		}
	}
	c.LocalPath = res.localRoot
	if c.Name == "" {
		c.Name = filepath.Base(c.LocalPath)
	}
	remotePath, err := s.tree.Path(ctx, c.RemoteFolderID)
	if err != nil {
		return nil, err
	}
	a := s.acct.Account()
	idb := make([]byte, 4)
	rand.Read(idb)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	row := &state.SyncRow{ID: "s_" + hex.EncodeToString(idb), Name: c.Name, LocalRoot: c.LocalPath, RemoteRootID: c.RemoteFolderID,
		RemotePath: remotePath, Type: c.Type, Encryption: c.Encryption, FSKind: res.FS.Kind, CaseSensitive: res.FS.CaseSensitive,
		State: "scanning", CreatedAt: now}
	b, _ := json.Marshal(storedConfig{SyncConfig: c, Initial: in.Initial})
	row.Config = string(b)
	if err := writeMarker(row, a.UserID, a.ServerURL); err != nil {
		return nil, fmt.Errorf("could not write the sync marker: %w", err)
	}
	if err := writeRules(row.LocalRoot, cfg.IgnoreRules); err != nil {
		return nil, fmt.Errorf("could not write %s: %w", ignore.FileName, err)
	}
	if err := s.db.PutSync(ctx, row); err != nil {
		return nil, err
	}
	s.mgr.Add(row.ID)
	slog.Info("sync created", "sync_id", row.ID, "type", row.Type, "local", logx.Name(row.LocalRoot))
	out := s.toSync(ctx, row)
	s.rpc.Broadcast("sync", out)
	return out, nil
}

// checkRules validates .onegyignore text given with a sync config.
func checkRules(text string) []problem {
	var out []problem
	if _, errs := ignore.Parse(text); errs != nil {
		for _, e := range errs {
			out = append(out, problem{Code: "invalid", Field: "ignore_rules", Message: e.Error()})
		}
	}
	return out
}

// writeRules writes the root .onegyignore: the given text, or the defaults
// when the folder has none yet (an existing file is the user's and stays).
func writeRules(root string, text *string) error {
	if text == nil {
		if _, err := os.Lstat(filepath.Join(root, ignore.FileName)); !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		d := ignore.DefaultRules()
		text = &d
	}
	return syncer.WriteIgnoreRules(root, *text)
}

// writeMarker creates <root>/.onegy/sync.json (plan 6.4).
func writeMarker(r *state.SyncRow, userID int64, server string) error {
	dir := filepath.Join(r.LocalRoot, ".onegy")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := localfs.Hide(dir); err != nil {
		slog.Warn("could not hide .onegy", "err", err)
	}
	b, _ := json.MarshalIndent(map[string]any{"sync_id": r.ID, "account_id": userID, "server": server,
		"remote_root_id": r.RemoteRootID, "created_at": r.CreatedAt}, "", "  ")
	return config.WriteFileAtomic(filepath.Join(dir, "sync.json"), b, 0o600)
}

func (s *Service) syncsUpdate(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		ID    string          `json:"id"`
		Patch json.RawMessage `json:"patch"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	row, err := s.db.GetSync(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ipc.Errorf("not_found", "no such sync")
	}
	cur := s.toSync(ctx, row).SyncConfig
	next := syncInput{SyncConfig: cur}
	if err := applyPatch(cur, in.Patch, &next); err != nil {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "patch", Message: err.Error()}})
	}
	c := next.SyncConfig
	errs := c.check()
	if c.LocalPath != cur.LocalPath || !sameID(zeroIsRoot(c.RemoteFolderID), cur.RemoteFolderID) || c.Encryption != cur.Encryption {
		errs = append(errs, problem{Code: "fixed_field", Message: "local folder, one.gy folder and encryption cannot change; remove and re-add the sync"})
	}
	if len(errs) > 0 {
		return nil, validationFailed(errs)
	}
	if next.IgnoreRules != nil {
		errs = append(errs, checkRules(*next.IgnoreRules)...)
	}
	if len(errs) > 0 {
		return nil, validationFailed(errs)
	}
	if c.Type != cur.Type {
		res, err := s.validateSync(ctx, row.LocalRoot, row.RemoteRootID, c.Type, row.ID, true)
		if err != nil {
			return nil, err
		}
		if !res.OK {
			return nil, validationFailed(res.Errors)
		}
		if c.Type == "backup" {
			if err := s.setBackup(ctx, *row.RemoteRootID, true); err != nil {
				return nil, err
			}
		}
	}
	var sc storedConfig
	json.Unmarshal([]byte(row.Config), &sc)
	sc.SyncConfig = c
	b, _ := json.Marshal(sc)
	row.Config, row.Name, row.Type = string(b), c.Name, c.Type
	if row.Name == "" {
		row.Name = filepath.Base(row.LocalRoot)
	}
	if next.IgnoreRules != nil {
		if err := syncer.WriteIgnoreRules(row.LocalRoot, *next.IgnoreRules); err != nil {
			return nil, err
		}
	}
	if err := s.db.PutSync(ctx, row); err != nil {
		return nil, err
	}
	s.mgr.Wake(row.ID)
	out := s.toSync(ctx, row)
	s.rpc.Broadcast("sync", out)
	return out, nil
}

func sameID(a, b *int64) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

// syncsRemove forgets a sync. The engine's own files in .onegy go (debris is
// kept: it holds the user's earlier versions); local files are never
// deleted here (the app moves the folder to the OS trash when asked).
// release_backup turns a backup sync's one.gy folder into a normal folder.
func (s *Service) syncsRemove(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		ID            string `json:"id"`
		ReleaseBackup bool   `json:"release_backup"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	row, err := s.db.GetSync(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ipc.Errorf("not_found", "no such sync")
	}
	if in.ReleaseBackup && row.Type == "backup" && row.RemoteRootID != nil {
		if err := s.setBackup(ctx, *row.RemoteRootID, false); err != nil && !api.IsCode(err, "not_found") {
			return nil, err
		}
	}
	owned := syncer.MarkerMatches(row.LocalRoot, row.ID)
	s.mgr.Remove(row.ID)
	s.pool.Forget(row.ID)
	if err := s.db.DeleteSync(ctx, row.ID); err != nil {
		return nil, err
	}
	if owned {
		dir := filepath.Join(row.LocalRoot, ".onegy")
		for _, name := range []string{"sync.json", "tmp", "spool"} {
			os.RemoveAll(filepath.Join(dir, name))
		}
		os.Remove(dir) // only succeeds when no debris is left
	}
	slog.Info("sync removed", "sync_id", row.ID, "release_backup", in.ReleaseBackup)
	s.publishStatus()
	return struct{}{}, nil
}

func (s *Service) pauseResume(ctx context.Context, params json.RawMessage, pause bool) (any, error) {
	var in struct {
		ID string `json:"id"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	if err := s.setPaused(ctx, in.ID, pause); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

// setPaused pauses or resumes one sync (id "" = all) and emits sync events.
func (s *Service) setPaused(ctx context.Context, id string, pause bool) error {
	rows, err := s.db.ListSyncs(ctx)
	if err != nil {
		return err
	}
	found := id == ""
	for _, r := range rows {
		if id != "" && r.ID != id {
			continue
		}
		found = true
		if r.Paused == pause {
			continue
		}
		r.Paused = pause
		if !pause {
			r.State = "scanning"
		}
		if err := s.db.PutSync(ctx, r); err != nil {
			return err
		}
		if pause {
			s.mgr.Interrupt(r.ID)
		}
		s.mgr.Wake(r.ID)
		s.rpc.Broadcast("sync", s.toSync(ctx, r))
	}
	if !found {
		return ipc.Errorf("not_found", "no such sync")
	}
	s.publishStatus()
	return nil
}
