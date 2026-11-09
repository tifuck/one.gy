package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/ipc"
	"github.com/tifuck/one.gy/desktop/engine/internal/logx"
)

// Settings is the engine-owned settings object (engine-ipc.md "Settings").
type Settings struct {
	UploadKbps             int      `json:"upload_kbps"`
	DownloadKbps           int      `json:"download_kbps"`
	ParallelUp             int      `json:"parallel_up"`
	ParallelDown           int      `json:"parallel_down"`
	Proxy                  Proxy    `json:"proxy"`
	Metered                string   `json:"metered"`
	Battery                string   `json:"battery"`
	PollFloorSeconds       int      `json:"poll_floor_seconds"`
	RescanMinutes          int      `json:"rescan_minutes"`
	LogLevel               string   `json:"log_level"`
	RequirePasswordOnStart bool     `json:"require_password_on_start"`
	WebUnlock              bool     `json:"web_unlock"`
	MassDeleteCount        int      `json:"mass_delete_count"`
	MassDeletePercent      int      `json:"mass_delete_percent"`
	Defaults               Defaults `json:"defaults"`
}

type Proxy struct {
	Mode string `json:"mode"` // system | none | manual
	URL  string `json:"url"`
}

type Defaults struct {
	Type           string `json:"type"`
	ConflictPolicy string `json:"conflict_policy"`
	IssueMode      string `json:"issue_mode"`
	DebrisDays     int    `json:"debris_days"`
	Thumbnails     bool   `json:"thumbnails"`
}

const settingsKey = "engine"

func defaultSettings() Settings {
	return Settings{ParallelUp: 2, ParallelDown: 2, Proxy: Proxy{Mode: "system"}, Metered: "pause", Battery: "continue",
		PollFloorSeconds: 5, RescanMinutes: 60, LogLevel: "info", WebUnlock: true, MassDeleteCount: 50, MassDeletePercent: 20,
		Defaults: Defaults{Type: "two_way", ConflictPolicy: "keep_both", IssueMode: "smart", DebrisDays: 30, Thumbnails: true}}
}

// problem is one validation error or warning.
type problem struct {
	Code    string `json:"code"`
	Field   string `json:"field,omitempty"`
	Message string `json:"message"`
}

func validationFailed(errs []problem) *ipc.Error {
	e := ipc.Errorf("validation_failed", errs[0].Message)
	e.Data.Errors = errs
	return e
}

func oneOf(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

func (st *Settings) validate() []problem {
	var errs []problem
	bad := func(field, msg string) { errs = append(errs, problem{Code: "invalid", Field: field, Message: msg}) }
	if st.UploadKbps < 0 || st.DownloadKbps < 0 {
		bad("upload_kbps", "bandwidth limits cannot be negative")
	}
	if st.ParallelUp < 1 || st.ParallelUp > 8 || st.ParallelDown < 1 || st.ParallelDown > 8 {
		bad("parallel_up", "parallel transfers must be between 1 and 8")
	}
	switch st.Proxy.Mode {
	case "system", "none":
	case "manual":
		u, err := url.Parse(st.Proxy.URL)
		if err != nil || u.Host == "" || !oneOf(u.Scheme, "http", "https", "socks5") {
			bad("proxy.url", "proxy URL must be http://, https:// or socks5://host:port")
		}
	default:
		bad("proxy.mode", "proxy mode must be system, none or manual")
	}
	if !oneOf(st.Metered, "pause", "continue") || !oneOf(st.Battery, "pause", "continue") {
		bad("metered", "metered and battery must be pause or continue")
	}
	if st.PollFloorSeconds < 5 || st.PollFloorSeconds > 3600 {
		bad("poll_floor_seconds", "poll floor must be 5-3600 seconds")
	}
	if st.RescanMinutes < 5 || st.RescanMinutes > 1440 {
		bad("rescan_minutes", "rescan interval must be 5-1440 minutes")
	}
	if _, err := logx.ParseLevel(st.LogLevel); err != nil {
		bad("log_level", "log level must be debug, info, warn or error")
	}
	if st.MassDeleteCount < 1 || st.MassDeletePercent < 1 || st.MassDeletePercent > 100 {
		bad("mass_delete_count", "mass-delete thresholds must be at least 1 (percent at most 100)")
	}
	d := st.Defaults
	if !oneOf(d.Type, "two_way", "backup", "mirror", "archive") {
		bad("defaults.type", "default sync type must be two_way, backup, mirror or archive")
	}
	if !oneOf(d.ConflictPolicy, conflictPolicies...) || !oneOf(d.IssueMode, "smart", "advanced") {
		bad("defaults.conflict_policy", "invalid default conflict policy or issue mode")
	}
	if d.DebrisDays < 0 || d.DebrisDays > 3650 {
		bad("defaults.debris_days", "debris retention must be 0-3650 days")
	}
	return errs
}

// apiOptions maps the proxy setting onto the API client options.
func (st *Settings) apiOptions(base api.Options) api.Options {
	switch st.Proxy.Mode {
	case "none":
		base.ProxyURL = "direct"
	case "manual":
		base.ProxyURL = st.Proxy.URL
	default:
		base.ProxyURL = ""
	}
	return base
}

func (s *Service) loadSettings(ctx context.Context) (Settings, error) {
	st := defaultSettings()
	_, err := s.db.GetJSON(ctx, settingsKey, &st)
	return st, err
}

// settings returns the cached settings.
func (s *Service) settings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

// mergePatch overlays patch onto base (objects merge recursively).
func mergePatch(base, patch map[string]any) {
	for k, v := range patch {
		if pm, ok := v.(map[string]any); ok {
			if bm, ok := base[k].(map[string]any); ok {
				mergePatch(bm, pm)
				continue
			}
		}
		base[k] = v
	}
}

// applyPatch returns cur with a JSON merge patch applied, strictly decoded.
func applyPatch(cur any, patch json.RawMessage, out any) error {
	var base, p map[string]any
	b, _ := json.Marshal(cur)
	json.Unmarshal(b, &base)
	if err := json.Unmarshal(patch, &p); err != nil || p == nil {
		return fmt.Errorf("expected a JSON object")
	}
	mergePatch(base, p)
	merged, _ := json.Marshal(base)
	return ipc.Params(merged, out)
}

func (s *Service) settingsSet(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		Patch json.RawMessage `json:"patch"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	cur := s.settings()
	next := cur
	if err := applyPatch(cur, in.Patch, &next); err != nil {
		return nil, validationFailed([]problem{{Code: "invalid", Message: err.Error()}})
	}
	if errs := next.validate(); len(errs) > 0 {
		return nil, validationFailed(errs)
	}
	if next.Proxy != cur.Proxy {
		if err := s.acct.SetOptions(next.apiOptions(s.opts.API)); err != nil {
			return nil, validationFailed([]problem{{Code: "invalid", Field: "proxy", Message: err.Error()}})
		}
	}
	if err := s.db.PutJSON(ctx, settingsKey, next); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.cfg = next
	s.mu.Unlock()
	s.applySettings(next, cur)
	return next, nil
}

// applySettings performs the side effects of a settings change.
func (s *Service) applySettings(next, prev Settings) {
	s.pool.SetLimits(next.ParallelUp, next.ParallelDown, next.UploadKbps, next.DownloadKbps)
	s.mgr.Wake("")
	if s.opts.LogLevel == "" {
		if lvl, err := logx.ParseLevel(next.LogLevel); err == nil {
			logx.Level.Set(lvl)
		}
	}
	if next.RequirePasswordOnStart != prev.RequirePasswordOnStart {
		s.ks.SetMemoryOnly(next.RequirePasswordOnStart)
		if !next.RequirePasswordOnStart {
			s.acct.PersistSecrets()
		}
	}
}

func (s *Service) pollFloor() time.Duration {
	return time.Duration(s.settings().PollFloorSeconds) * time.Second
}
