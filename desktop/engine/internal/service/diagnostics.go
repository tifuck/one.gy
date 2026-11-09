package service

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/config"
	"github.com/tifuck/one.gy/desktop/engine/internal/ipc"
)

// diagnostics.export: a zip of the rotated engine logs (names are already
// redacted below debug level) and a state summary made of counts, kinds and
// versions only: no file names, paths, keys or tokens.

func (s *Service) diagnosticsExport(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		Path string `json:"path"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(in.Path) || !strings.EqualFold(filepath.Ext(in.Path), ".zip") {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "path", Message: "choose a full path ending in .zip"}})
	}
	if fi, err := os.Stat(filepath.Dir(in.Path)); err != nil || !fi.IsDir() {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "path", Message: "the folder does not exist"}})
	}
	summary, err := s.summary(ctx)
	if err != nil {
		return nil, err
	}
	tmp := in.Path + ".part"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	zw := zip.NewWriter(f)
	w, _ := zw.Create("summary.json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	err = enc.Encode(summary)
	logs, _ := filepath.Glob(filepath.Join(config.LogDir(s.opts.StateDir), "engine.log*"))
	for _, p := range logs {
		if err != nil {
			break
		}
		err = addFile(zw, p, "logs/"+filepath.Base(p))
	}
	if cerr := zw.Close(); err == nil {
		err = cerr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, in.Path)
	}
	if err != nil {
		os.Remove(tmp)
		return nil, err
	}
	return map[string]string{"path": in.Path}, nil
}

func addFile(zw *zip.Writer, src, name string) error {
	f, err := os.Open(src)
	if err != nil {
		return nil // rotated away meanwhile
	}
	defer f.Close()
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, f)
	return err
}

// summary describes the engine state without anything identifying.
func (s *Service) summary(ctx context.Context) (map[string]any, error) {
	count := func(q string, args ...any) map[string]int {
		out := map[string]int{}
		rows, err := s.db.QueryContext(ctx, q, args...)
		if err != nil {
			return out
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			var n int
			if rows.Scan(&k, &n) == nil {
				out[k] = n
			}
		}
		return out
	}
	syncs, err := s.db.ListSyncs(ctx)
	if err != nil {
		return nil, err
	}
	var list []map[string]any
	for _, r := range syncs {
		var items int
		s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM synced WHERE sync_id = ?`, r.ID).Scan(&items)
		v := map[string]any{"id": r.ID, "type": r.Type, "encryption": r.Encryption, "state": r.State, "paused": r.Paused,
			"fs_kind": r.FSKind, "case_sensitive": r.CaseSensitive, "synced_items": items, "last_synced_at": r.LastSyncedAt,
			"open_issues": count(`SELECT kind, COUNT(*) FROM issue WHERE sync_id = ? AND resolved_at IS NULL GROUP BY kind`, r.ID)}
		if run := s.mgr.Runner(r.ID); run != nil {
			v["runner_state"], v["pending"] = run.State(), run.Stats()
		}
		list = append(list, v)
	}
	st := s.acct.Status(ctx)
	set := s.settings()
	if set.Proxy.URL != "" {
		set.Proxy.URL = "(set)" // may carry credentials
	}
	return map[string]any{
		"generated_at": time.Now().UTC().Format(time.RFC3339),
		"version":      config.Version, "protocol": config.Protocol, "os": runtime.GOOS, "arch": runtime.GOARCH, "go": runtime.Version(),
		"signed_in": st.SignedIn, "locked": st.Locked, "online": s.poller.Online(),
		"syncs":            list,
		"journal":          count(`SELECT state, COUNT(*) FROM op GROUP BY state`),
		"journal_kinds":    count(`SELECT kind, COUNT(*) FROM op WHERE state NOT IN ('committed', 'superseded') GROUP BY kind`),
		"transfers":        count(`SELECT direction || ':' || state, COUNT(*) FROM transfer_history GROUP BY direction, state`),
		"remote_nodes":     count(`SELECT kind, COUNT(*) FROM remote_node GROUP BY kind`),
		"settings":         set,
		"active_transfers": len(s.pool.List("active")),
	}, nil
}
