// Package syncer owns the per-sync loop (plan 6, 7.2-7.8): for each active
// sync a Runner scans the local root, reads the cached remote subtree,
// reconciles against the synced base, executes the plan through
// internal/exec and repeats until the plan is empty, on watcher hints,
// remote changes, its schedule or syncNow. It keeps the sync's state, stats
// and issues, applies the user's issue decisions, and guards against plans
// that repeat without progress.
package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tifuck/one.gy/client/internal/account"
	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/exec"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/logx"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/scan"
	"github.com/tifuck/one.gy/client/internal/state"
)

// Settings is the part of the engine settings the loop uses.
type Settings struct {
	MassDeleteCount   int
	MassDeletePercent int
	RescanMinutes     int
	Metered           string // pause | continue
	Battery           string
}

// Events receives what the app should hear about (all optional).
type Events struct {
	Sync     func(syncID string)
	Issue    func(v IssueView)
	Activity func(a Activity)
	Notify   func(title, body, kind string)
}

// Env is shared by all runners.
type Env struct {
	Exec     *exec.Env
	Settings func() Settings
	// Device returns this device's id and name (read-only backups, conflict copies).
	Device func() (id, name string)
	Events Events
}

// Config is the part of sync.config_json the loop uses (the service owns
// the full object; keys match engine-ipc.md "Sync").
type Config struct {
	ConflictPolicy   string `json:"conflict_policy"`
	IssueMode        string `json:"issue_mode"`
	PropagateDeletes bool   `json:"propagate_deletes"`
	DebrisDays       int    `json:"debris_days"`
	HideExtensions   bool   `json:"hide_extensions"`
	KeepExecBit      bool   `json:"keep_exec_bit"`
	Thumbnails       bool   `json:"thumbnails"`
	// IncludeHiddenSystem syncs Windows hidden/system items (default: excluded).
	IncludeHiddenSystem bool   `json:"include_hidden_system"`
	Metered             string `json:"metered"`
	Battery             string `json:"battery"`
	Initial             string `json:"initial"`
	Schedule            struct {
		Mode            string `json:"mode"`
		IntervalMinutes int    `json:"interval_minutes"`
		Window          *struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"window"`
	} `json:"schedule"`
	Limits struct {
		UploadKbps   int `json:"upload_kbps"`
		DownloadKbps int `json:"download_kbps"`
	} `json:"limits"`
}

func parseConfig(raw string) Config {
	c := Config{ConflictPolicy: "keep_both", IssueMode: "smart", PropagateDeletes: true, DebrisDays: 30, KeepExecBit: true}
	c.Schedule.Mode = "live"
	json.Unmarshal([]byte(raw), &c)
	return c
}

// Stats is the IPC Sync.stats part the runner knows: what is left (counted
// down as transfers finish) and what this run of work started with, which
// is what is left plus what finished since the sync last had nothing to do.
type Stats struct {
	PendingUp   int   `json:"pending_up"`
	PendingDown int   `json:"pending_down"`
	BytesLeft   int64 `json:"bytes_left"`
	TotalItems  int   `json:"total_items"`
	TotalBytes  int64 `json:"total_bytes"`
}

// Activity is one activity event / activity.recent entry.
type Activity struct {
	At     string `json:"at"`
	SyncID string `json:"sync_id"`
	Action string `json:"action"`
	Path   string `json:"path"`
}

// Runner drives one sync. Pass is not reentrant; Run serialises it.
type Runner struct {
	env *Env
	ID  string

	// Workers bounds concurrent content ops (default 4; tests use 1).
	Workers int
	// Crash is handed to the executor (tests).
	Crash func(point string, kind reconcile.OpKind) bool
	// QuietPeriod is how long a changed file must rest before it is
	// uploaded (default localfs.QuietPeriod; tests use none).
	QuietPeriod func(size int64) time.Duration

	up, down *exec.Bucket
	wake     chan struct{}

	mu         sync.Mutex
	state      string
	stats      Stats
	doneItems  int // transfers finished since the sync last had nothing to do
	doneBytes  int64
	detail     string    // why the sync waits or what it is busy with ("" = nothing to add to the state)
	busy       bool      // detail is progress, not a wait
	retryAt    time.Time // when a waiting sync looks again
	lastFail   string    // why the last op failed
	env2       environment
	retries    map[string]*retry
	sticky     map[string]reconcile.Issue
	actions    []action
	massLocal  string
	massRemote string
	holdUp     time.Time // quota: no uploads until
	holdDown   time.Time // disk full: no downloads until
	nextRun    time.Time // earliest deferred op or retry
	forced     bool      // syncNow: run whatever the schedule says
	dirty      bool      // something changed since the last pass
	lastNotify time.Time
	cancelPass context.CancelFunc
}

type environment struct{ battery, metered bool }

type retry struct {
	n     int
	until time.Time
}

type action struct {
	kind, path, verb string
}

// NewRunner creates the runner of sync id.
func NewRunner(env *Env, id string) *Runner {
	return &Runner{env: env, ID: id, Workers: 4, QuietPeriod: localfs.QuietPeriod, up: exec.NewBucket(0), down: exec.NewBucket(0), wake: make(chan struct{}, 1),
		retries: map[string]*retry{}, sticky: map[string]reconcile.Issue{}}
}

// ErrGone: the sync no longer exists.
var ErrGone = errors.New("sync removed")

// MarkerMatches reports whether <root>/.onegy/sync.json belongs to syncID.
func MarkerMatches(root, syncID string) bool {
	b, err := os.ReadFile(filepath.Join(root, ".onegy", "sync.json"))
	if err != nil {
		return false
	}
	var m struct {
		SyncID string `json:"sync_id"`
	}
	return json.Unmarshal(b, &m) == nil && m.SyncID == syncID
}

// Stats returns the pending work of the last plan.
func (r *Runner) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stats
}

// State is the sync state of the last pass (engine-ipc.md "Sync.state").
func (r *Runner) State() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}

func (r *Runner) setState(ctx context.Context, st string, synced bool) {
	r.mu.Lock()
	changed := r.state != st
	r.state = st
	r.mu.Unlock()
	if !changed && !synced {
		return
	}
	cur, err := r.env.Exec.DB.GetSync(ctx, r.ID)
	if err != nil || cur == nil {
		return
	}
	cur.State = st
	if synced {
		cur.LastSyncedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if err := r.env.Exec.DB.PutSync(ctx, cur); err == nil && r.env.Events.Sync != nil {
		r.env.Events.Sync(r.ID)
	}
}

// Detail says why the sync waits (waiting) or what it is busy with, and
// when a waiting sync tries again (zero = not at a set time).
func (r *Runner) Detail() (detail string, waiting bool, at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.detail, r.detail != "" && !r.busy, r.retryAt
}

// setDetail says why the sync waits ("" = it does not).
func (r *Runner) setDetail(s string) {
	r.mu.Lock()
	r.detail, r.busy, r.retryAt = s, false, time.Time{}
	r.mu.Unlock()
}

// setBusy says what the sync is working on when no transfer shows it.
func (r *Runner) setBusy(s string) {
	r.mu.Lock()
	r.detail, r.busy, r.retryAt = s, true, time.Time{}
	r.mu.Unlock()
}

// pausedBy reports whether the sync must not run now (paused, or the
// metered/battery policy says pause) and, when it was not the user, why.
func (r *Runner) pausedBy(row *state.SyncRow, cfg Config) (bool, string) {
	if row.Paused {
		return true, ""
	}
	set := r.env.Settings()
	r.mu.Lock()
	e := r.env2
	r.mu.Unlock()
	pol := func(own, global string) string {
		if own == "" || own == "inherit" {
			return global
		}
		return own
	}
	switch {
	case e.metered && pol(cfg.Metered, set.Metered) == "pause":
		return true, "Waiting: this connection is metered"
	case e.battery && pol(cfg.Battery, set.Battery) == "pause":
		return true, "Waiting: this computer runs on battery"
	}
	return false, ""
}

// Pass runs the sync to convergence (or until it has to wait).
func (r *Runner) Pass(ctx context.Context) error {
	db := r.env.Exec.DB
	row, err := db.GetSync(ctx, r.ID)
	if err != nil {
		return err
	}
	if row == nil {
		return ErrGone
	}
	cfg := parseConfig(row.Config)
	if paused, why := r.pausedBy(row, cfg); paused {
		r.setDetail(why)
		r.setState(ctx, "paused", false)
		return nil
	}
	// Keys closed (not set up, strict start, offline after a restart): wait.
	// A locked app still syncs with the key tree, so only the client counts.
	if _, err := r.env.Exec.Acct.Client(); err != nil {
		r.setDetail("Waiting for ONE.GY Desktop to be unlocked")
		r.setState(ctx, "paused", false)
		return nil
	}
	r.setDetail("")
	if !MarkerMatches(row.LocalRoot, row.ID) {
		r.setState(ctx, "root_missing", false)
		r.syncIssues(ctx, []reconcile.Issue{{Kind: "root_missing", Message: "The local folder is missing or was replaced. Nothing is synced until it is back.",
			Actions: []string{"retry", "remove_sync"}}})
		return nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	r.mu.Lock()
	r.cancelPass = cancel
	r.mu.Unlock()

	r.setState(ctx, "scanning", false)
	if _, err := r.env.Exec.Tree.Sync(ctx); err != nil {
		return r.offline(ctx, row, err)
	}
	r.up.SetKbps(cfg.Limits.UploadKbps)
	r.down.SetKbps(cfg.Limits.DownloadKbps)
	x := exec.New(r.env.Exec, exec.Sync{ID: row.ID, Root: row.LocalRoot, RootID: row.RemoteRootID, Encryption: row.Encryption,
		HideExtensions: cfg.HideExtensions, KeepExecBit: cfg.KeepExecBit, Thumbnails: cfg.Thumbnails, FSKind: row.FSKind, Up: r.up, Down: r.down})
	x.Crash = r.Crash
	if err := x.Recover(ctx); err != nil {
		return r.offline(ctx, row, err)
	}
	err = r.rounds(ctx, row, cfg, x)
	r.cleanDebris(ctx, row, cfg)
	if err != nil {
		return r.offline(ctx, row, err)
	}
	return nil
}

func (r *Runner) offline(ctx context.Context, row *state.SyncRow, err error) error {
	switch {
	case errors.Is(err, exec.ErrCrashed):
		return err
	case errors.Is(err, api.ErrOffline):
		r.setDetail("Cannot reach one.gy (" + err.Error() + "); trying again within 30 s")
		r.setState(context.Background(), "offline", false)
	case ctx.Err() != nil:
		r.setDetail("") // paused or shutting down
		return ctx.Err()
	default:
		slog.Error("sync pass failed", "sync_id", r.ID, "err", redact(err, row.LocalRoot, ""))
		r.setDetail("Syncing failed (" + err.Error() + "); trying again within 30 s")
		r.setState(context.Background(), "error", false)
	}
	return err
}

const maxRounds = 25

func (r *Runner) rounds(ctx context.Context, row *state.SyncRow, cfg Config, x *exec.Executor) error {
	var lastSig string
	repeats := 0
	for round := 0; round < maxRounds; round++ {
		in, err := r.input(ctx, row, cfg)
		if err != nil {
			return err
		}
		x.Rules = in.Local.Rules
		if err := r.applyActions(ctx, x, in, row, cfg); err != nil {
			return err
		}
		plan := reconcile.Reconcile(in)
		issues := plan.Issues
		for _, is := range in.Local.Issues {
			issues = append(issues, scanIssue(is))
		}
		r.mu.Lock()
		for _, is := range r.sticky {
			issues = append(issues, is)
		}
		r.mu.Unlock()
		r.syncIssues(ctx, issues)
		r.setStats(plan.Ops)
		if slog.Default().Enabled(ctx, slog.LevelDebug) {
			slog.Debug("plan", "sync_id", r.ID, "round", round, "ops", signature(plan.Ops), "issues", len(issues))
		}
		uncross(in, plan.Ops)
		run, waiting := r.runnable(plan.Ops)
		r.mu.Lock()
		r.detail, r.busy, r.retryAt = "", false, time.Time{}
		if len(run) == 0 {
			r.detail, r.retryAt = waiting, r.nextRun
		}
		r.mu.Unlock()
		if len(run) == 0 {
			if len(plan.Ops) == 0 {
				r.clearMassDecisions()
				r.mu.Lock()
				delete(r.sticky, "sync_error|") // nothing left that could be stuck
				r.mu.Unlock()
				r.setState(ctx, r.idleState(plan), true)
			} else {
				r.setState(ctx, "syncing", false) // waiting: quiet period, retry backoff, held uploads/downloads
			}
			return nil
		}
		sig := signature(run)
		if sig == lastSig {
			repeats++
		} else {
			repeats = 0
		}
		lastSig = sig
		if repeats >= 2 {
			r.stall(ctx, issues)
			return nil
		}
		r.setState(ctx, "syncing", false)
		if err := r.execute(ctx, x, run, row.LocalRoot, row.CaseSensitive); err != nil {
			return err
		}
		r.clearMassDecisions()
		if _, err := r.env.Exec.Tree.Sync(ctx); err != nil {
			return err
		}
	}
	r.setState(ctx, "syncing", false)
	r.mu.Lock()
	r.nextRun = time.Now() // more work left: run again soon
	r.mu.Unlock()
	return nil
}

// idleState: up_to_date, or stalled while a remote root issue holds everything.
func (r *Runner) idleState(p *reconcile.Plan) string {
	for _, is := range p.Issues {
		if is.Kind == "remote_root_missing" || is.Kind == "root_missing" {
			if is.Kind == "root_missing" {
				return "root_missing"
			}
			return "stalled"
		}
	}
	return "up_to_date"
}

// stall stops a plan that keeps coming back unchanged (e.g. a name swap the
// executor's preconditions refuse every time) instead of spinning.
func (r *Runner) stall(ctx context.Context, issues []reconcile.Issue) {
	is := reconcile.Issue{Kind: "sync_error", Message: "Some changes keep failing to apply; syncing waits. Retry, or check the items in this folder.",
		Actions: []string{"retry"}}
	r.mu.Lock()
	r.sticky["sync_error|"] = is
	r.detail, r.busy, r.retryAt = "The same changes keep failing to apply; see Issues", false, time.Time{}
	r.mu.Unlock()
	r.syncIssues(ctx, append(issues, is))
	r.setState(ctx, "stalled", false)
}

func signature(ops []reconcile.Op) string {
	var b strings.Builder
	for _, o := range ops {
		fmt.Fprintf(&b, "%s|%s|%s|%s;", o.Kind, o.From, o.Path, o.RemoteID)
	}
	return b.String()
}

func (r *Runner) setStats(ops []reconcile.Op) {
	var st Stats
	for _, o := range ops {
		switch o.Kind {
		case reconcile.Upload:
			st.PendingUp++
			st.BytesLeft += o.Size
		case reconcile.Download, reconcile.VerifyLink:
			st.PendingDown++
			st.BytesLeft += o.Size
		}
	}
	r.mu.Lock()
	if st.PendingUp+st.PendingDown == 0 {
		r.doneItems, r.doneBytes, r.lastFail = 0, 0, ""
	}
	st.TotalItems, st.TotalBytes = r.doneItems+st.PendingUp+st.PendingDown, r.doneBytes+st.BytesLeft
	changed := st != r.stats
	r.stats = st
	r.env.Exec.Pool.Settle(r.ID, -1)
	r.mu.Unlock()
	if changed && r.env.Events.Sync != nil {
		r.env.Events.Sync(r.ID)
	}
}

// transferred counts a finished transfer off what is left (the service
// publishes the new numbers within a second).
func (r *Runner) transferred(o reconcile.Op) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch o.Kind {
	case reconcile.Upload:
		r.stats.PendingUp = max(r.stats.PendingUp-1, 0)
	case reconcile.Download, reconcile.VerifyLink:
		r.stats.PendingDown = max(r.stats.PendingDown-1, 0)
	default:
		return
	}
	r.stats.BytesLeft = max(r.stats.BytesLeft-o.Size, 0)
	r.doneItems++
	r.doneBytes += o.Size
	r.env.Exec.Pool.Settle(r.ID, o.Size)
}

// runnable drops ops that must wait: uploads of files still being written
// (quiet period), paths in retry backoff, uploads while the quota is full and
// downloads while the disk is full. nextRun records when to look again and
// waiting says what the dropped ops wait for.
func (r *Runner) runnable(ops []reconcile.Op) (run []reconcile.Op, waiting string) {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	var next time.Time
	later := func(t time.Time) {
		if next.IsZero() || t.Before(next) {
			next = t
		}
	}
	var out []reconcile.Op
	var retrying, full, noSpace, changing int
	for _, o := range ops {
		if rt := r.retries[retryKey(o)]; rt != nil && now.Before(rt.until) {
			later(rt.until)
			retrying++
			continue
		}
		switch o.Kind {
		case reconcile.Upload, reconcile.CreateRemoteDir:
			if now.Before(r.holdUp) {
				later(r.holdUp)
				full++
				continue
			}
		case reconcile.Download, reconcile.VerifyLink:
			if now.Before(r.holdDown) {
				later(r.holdDown)
				noSpace++
				continue
			}
		}
		if o.Kind == reconcile.Upload && o.Local != nil {
			if ready := time.Unix(0, o.Local.MtimeNs).Add(r.QuietPeriod(o.Size)); now.Before(ready) {
				later(ready)
				changing++
				continue
			}
		}
		out = append(out, o)
	}
	r.nextRun = next
	switch {
	case full > 0:
		waiting = "Your one.gy storage is full; uploads wait"
	case noSpace > 0:
		waiting = "This drive is full; downloads wait"
	case retrying > 0 && r.lastFail != "":
		waiting = fmt.Sprintf("%d of the changes failed and wait for another try: %s", retrying, r.lastFail)
	case retrying > 0:
		waiting = fmt.Sprintf("%d of the changes failed and wait for another try", retrying)
	case changing > 0:
		waiting = fmt.Sprintf("Waiting for %d files to stop changing", changing)
	}
	return out, waiting
}

func retryKey(o reconcile.Op) string { return string(o.Kind) + "|" + o.Path }

// execute runs a plan: structural ops in order, then content ops on a few
// workers (the transfer pool enforces the global limits), then deletes.
func (r *Runner) execute(ctx context.Context, x *exec.Executor, ops []reconcile.Op, root string, caseSensitive bool) error {
	var structural, content, deletes []reconcile.Op
	for _, o := range ops {
		switch {
		case o.Kind == reconcile.Upload || o.Kind == reconcile.Download || o.Kind == reconcile.VerifyLink ||
			(o.Kind == reconcile.Link && o.EntryKind == localfs.KindFile):
			content = append(content, o)
		case o.Kind == reconcile.DeleteLocal || o.Kind == reconcile.TrashRemote || o.Kind == reconcile.Forget:
			deletes = append(deletes, o)
		default:
			structural = append(structural, o)
		}
	}
	breakSwap(structural, root, caseSensitive)
	// These run one after the other with no transfer to watch: say how far they are.
	for i, o := range structural {
		r.setBusy(fmt.Sprintf("Creating and moving folders and files (%d of %d)", i+1, len(structural)))
		if err := r.one(ctx, x, o); err != nil {
			return err
		}
	}
	r.setDetail("")
	if err := r.parallel(ctx, x, content); err != nil {
		return err
	}
	for i, o := range deletes {
		r.setBusy(fmt.Sprintf("Removing deleted items (%d of %d)", i+1, len(deletes)))
		if err := r.one(ctx, x, o); err != nil {
			return err
		}
	}
	r.setDetail("")
	return nil
}

// uncross handles folders moved into each other on the two sides (A into B
// here, B into A on one.gy): the folder move this computer would push to
// one.gy would close a cycle there, so the one.gy location wins and the
// local folder moves back to where one.gy has it (the next round then
// follows the remote move).
func uncross(in *reconcile.Input, ops []reconcile.Op) {
	var paths map[string]*reconcile.RemoteNode
	parent := map[string]string{}
	for _, n := range in.Remote.Nodes {
		parent[n.ID] = n.ParentID
	}
	byFID := map[localfs.FileID]string{}
	for p, e := range in.Local.Entries {
		if e.ID != "" {
			byFID[e.ID] = p
		}
	}
	for i := range ops {
		o := &ops[i]
		if o.Kind != reconcile.MoveRemote || o.EntryKind != localfs.KindDir || o.Base == nil || o.Base.LocalFID == "" {
			continue
		}
		if paths == nil {
			paths = RemotePaths(in)
		}
		target := o.ParentRemoteID
		if target == "" && o.ParentPath != "" {
			if n := paths[o.ParentPath]; n != nil {
				target = n.ID
			}
		}
		cycle := false
		for q, depth := target, 0; q != "" && q != in.Remote.RootID && depth < 1000; q, depth = parent[q], depth+1 {
			cycle = cycle || q == o.RemoteID
		}
		cur, ok := byFID[localfs.FileID(o.Base.LocalFID)]
		if !cycle || !ok || o.From == "" {
			continue
		}
		*o = reconcile.Op{Kind: reconcile.MoveLocal, From: cur, Path: o.From, EntryKind: localfs.KindDir, RemoteID: o.RemoteID,
			RemoteName: o.Base.RemoteName, Local: expectOf(in.Local.Entries[cur]), Target: &reconcile.Expect{Absent: true}, Base: o.Base,
			Reason: "moved on both sides into each other; the one.gy location wins"}
	}
}

// breakSwap resolves local moves that wait for each other (two items
// swapping names, or a longer cycle): the first move of the cycle goes to a
// temporary name next to its source instead, recorded without a one.gy
// name (so it never counts as the item's chosen local name), and the
// following passes move it on to its final place.
func breakSwap(ops []reconcile.Op, root string, caseSensitive bool) {
	vacating := map[string]bool{}
	for _, o := range ops {
		if o.Kind == reconcile.MoveLocal || o.Kind == reconcile.Conflict {
			vacating[localfs.Key(o.From, caseSensitive)] = true
		}
	}
	for i := range ops {
		o := &ops[i]
		if o.Kind != reconcile.MoveLocal || o.Base == nil || !vacating[localfs.Key(o.Path, caseSensitive)] || localfs.Key(o.Path, caseSensitive) == localfs.Key(o.From, caseSensitive) {
			continue
		}
		if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(o.Path))); err != nil {
			continue
		}
		dir, name := filepath.Dir(o.From), filepath.Base(o.From)
		for n := 1; ; n++ {
			tmp := localfs.InsertSuffix(name, fmt.Sprintf(" (moving %d)", n))
			if dir != "." {
				tmp = dir + "/" + tmp
			}
			if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(tmp))); err != nil {
				o.Path, o.RemoteName, o.Reason = tmp, "", "making room for a name swap"
				return
			}
		}
	}
}

func (r *Runner) parallel(ctx context.Context, x *exec.Executor, ops []reconcile.Op) error {
	n := max(r.Workers, 1)
	ch := make(chan reconcile.Op)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first error
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for o := range ch {
				if err := r.one(ctx, x, o); err != nil {
					mu.Lock()
					if first == nil {
						first = err
					}
					mu.Unlock()
					cancel()
				}
			}
		}()
	}
	for _, o := range ops {
		select {
		case ch <- o:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(ch)
	wg.Wait()
	if first != nil {
		return first
	}
	return nil
}

// one executes an op and books its outcome. Only errors that end the pass
// (offline, cancelled, crash) are returned.
func (r *Runner) one(ctx context.Context, x *exec.Executor, o reconcile.Op) error {
	err := x.Execute(ctx, o)
	slog.Debug("op", "sync_id", r.ID, "kind", o.Kind, "path", o.Path, "err", err)
	var ie *exec.IssueError
	switch {
	case err == nil:
		r.transferred(o)
		r.done(o)
	case errors.Is(err, exec.ErrSuperseded):
	case errors.Is(err, account.ErrNeedsUnlock):
		r.failed("ONE.GY Desktop is locked")
		r.backoff(o, false) // waits for the app to be unlocked; not an issue
	case errors.Is(err, exec.ErrRemoteCycle):
		return r.undoLocalMove(ctx, x, o)
	case errors.Is(err, exec.ErrCrashed), errors.Is(err, api.ErrOffline), ctx.Err() != nil:
		return err
	case errors.As(err, &ie):
		path := ie.Path
		if path == "" && ie.Kind != "disk_full" && ie.Kind != "quota" {
			path = o.Path
		}
		r.mu.Lock()
		r.sticky[ie.Kind+"|"+path] = reconcile.Issue{Kind: ie.Kind, Path: path, Message: ie.Message, Actions: ie.Actions}
		switch ie.Kind {
		case "quota":
			r.holdUp = time.Now().Add(15 * time.Minute)
		case "disk_full":
			r.holdDown = time.Now().Add(5 * time.Minute)
		}
		r.lastFail = ie.Message
		r.mu.Unlock()
		r.backoff(o, false)
	default:
		slog.Warn("op failed", "sync_id", r.ID, "kind", o.Kind, "path", logx.Name(o.Path), "err", redact(err, x.Root(), o.Path))
		r.failed(err.Error())
		if r.backoff(o, true) {
			r.mu.Lock()
			r.sticky["sync_error|"+o.Path] = reconcile.Issue{Kind: "sync_error", Path: o.Path, Message: "This keeps failing: " + err.Error(), Actions: []string{"retry", "ignore"}}
			r.mu.Unlock()
		}
	}
	return nil
}

func (r *Runner) failed(why string) {
	r.mu.Lock()
	r.lastFail = why
	r.mu.Unlock()
}

// undoLocalMove answers crossed folder moves (moved into each other on the
// two sides): the one.gy location wins, so the local folder moves back to
// where one.gy has it and the next pass follows the remote move.
func (r *Runner) undoLocalMove(ctx context.Context, x *exec.Executor, o reconcile.Op) error {
	in, err := localfs.Lstat(filepath.Join(x.Root(), filepath.FromSlash(o.Path)))
	if err != nil || in.Kind != localfs.KindDir || o.Base == nil || o.From == "" {
		return nil
	}
	return r.one(ctx, x, reconcile.Op{Kind: reconcile.MoveLocal, From: o.Path, Path: o.From, EntryKind: localfs.KindDir, RemoteID: o.RemoteID,
		RemoteName: o.Base.RemoteName, Local: &reconcile.Expect{Kind: localfs.KindDir}, Target: &reconcile.Expect{Absent: true},
		Base: o.Base, Reason: "moved on both sides into each other; the one.gy location wins"})
}

// backoff schedules the next attempt (1 s doubling, capped at 10 min) and
// reports whether the op failed often enough to tell the user.
func (r *Runner) backoff(o reconcile.Op, count bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	k := retryKey(o)
	rt := r.retries[k]
	if rt == nil {
		rt = &retry{}
		r.retries[k] = rt
	}
	rt.n++
	d := 10 * time.Minute
	if rt.n < 10 {
		d = min(time.Second<<rt.n, d)
	}
	rt.until = time.Now().Add(d)
	return count && rt.n >= 5
}

// done clears retries and op-specific issues, and emits activity.
func (r *Runner) done(o reconcile.Op) {
	r.mu.Lock()
	delete(r.retries, retryKey(o))
	for k, is := range r.sticky {
		if is.Path == o.Path && !(is.Kind == "integrity" && len(is.Actions) > 0 && is.Actions[0] == "keep_remote") { // Verify findings wait for the user
			delete(r.sticky, k)
		}
		if is.Kind == "quota" && o.Kind == reconcile.Upload || is.Kind == "disk_full" && o.Kind == reconcile.Download {
			delete(r.sticky, k)
		}
	}
	notify := o.Kind == reconcile.Conflict && time.Since(r.lastNotify) > 30*time.Second
	if notify {
		r.lastNotify = time.Now()
	}
	r.mu.Unlock()
	if a, ok := activityName[o.Kind]; ok && r.env.Events.Activity != nil {
		p := o.Path
		if o.Kind == reconcile.Conflict {
			p = o.From
		}
		r.env.Events.Activity(Activity{At: time.Now().UTC().Format(time.RFC3339), SyncID: r.ID, Action: a, Path: p})
	}
	if notify && r.env.Events.Notify != nil {
		r.env.Events.Notify("Conflict", "Both versions of "+filepath.Base(o.From)+" were kept.", "conflict")
	}
}

// activityName maps op kinds to activity actions (internal ops are omitted).
var activityName = map[reconcile.OpKind]string{
	reconcile.Upload: "upload", reconcile.Download: "download", reconcile.DeleteLocal: "delete_local",
	reconcile.TrashRemote: "delete_remote", reconcile.MoveLocal: "move_local", reconcile.MoveRemote: "move_remote",
	reconcile.CreateLocalDir: "create_local_dir", reconcile.CreateRemoteDir: "create_remote_dir", reconcile.Conflict: "conflict",
}

// ActivityName is exported for activity.recent (op table kinds).
func ActivityName(kind string) (string, bool) {
	a, ok := activityName[reconcile.OpKind(kind)]
	return a, ok
}

func (r *Runner) clearMassDecisions() {
	r.mu.Lock()
	r.massLocal, r.massRemote = "", ""
	r.mu.Unlock()
}

// input gathers one pass: local scan, remote subtree, base rows.
func (r *Runner) input(ctx context.Context, row *state.SyncRow, cfg Config) (*reconcile.Input, error) {
	db := r.env.Exec.DB
	tree, err := scan.Run(ctx, scan.Options{Root: row.LocalRoot, FSKind: row.FSKind, DB: db, SyncID: row.ID,
		IncludeHiddenSystem: cfg.IncludeHiddenSystem, Progress: r.scanned})
	if err != nil {
		return nil, err
	}
	rem, err := RemoteInput(ctx, r.env.Exec, r.deviceID(), row.RemoteRootID)
	if err != nil {
		return nil, err
	}
	base, err := db.ListSynced(ctx, row.ID)
	if err != nil {
		return nil, err
	}
	if err := trashedBase(ctx, db, rem, base); err != nil {
		return nil, err
	}
	caps, err := r.env.Exec.Caps(ctx)
	if err != nil {
		return nil, err
	}
	set := r.env.Settings()
	_, name := r.env.Device()
	r.mu.Lock()
	ml, mr := r.massLocal, r.massRemote
	r.mu.Unlock()
	return &reconcile.Input{Config: reconcile.Config{Type: row.Type, ConflictPolicy: cfg.ConflictPolicy, IssueMode: cfg.IssueMode,
		PropagateDeletes: cfg.PropagateDeletes, Versioning: caps.Versioning, KeepExecBit: cfg.KeepExecBit, MassDeleteCount: set.MassDeleteCount,
		MassDeletePercent: set.MassDeletePercent, MassDeleteLocal: ml, MassDeleteRemote: mr, CaseSensitive: row.CaseSensitive,
		FSKind: row.FSKind, Device: name, Now: time.Now(), Initial: cfg.Initial}, Local: tree, Remote: *rem, Base: base}, nil
}

// scanned shows how far the scan is: reading every new or changed file
// takes a while on a large folder, and there is no transfer to watch yet.
func (r *Runner) scanned(files int, read int64) {
	s := fmt.Sprintf("Checked %d files", files)
	if read >= 1<<20 {
		s += fmt.Sprintf(", read %.1f GB of new and changed ones", float64(read)/1e9)
		if read < 1e9 {
			s = fmt.Sprintf("Checked %d files, read %d MB of new and changed ones", files, read/1e6)
		}
	}
	r.setBusy(s)
}

func (r *Runner) deviceID() string {
	id, _ := r.env.Device()
	return id
}

// cleanDebris deletes debris older than debris_days (0 = right after the
// delete was synced; the app moved nothing to the OS trash for us).
func (r *Runner) cleanDebris(ctx context.Context, row *state.SyncRow, cfg Config) {
	paths, err := r.env.Exec.DB.TakeDebris(ctx, row.ID, time.Now().Add(-time.Duration(cfg.DebrisDays)*24*time.Hour))
	if err != nil {
		return
	}
	days := map[string]bool{}
	for _, p := range paths {
		if !strings.HasPrefix(p, ".onegy/debris/") || strings.Contains(p, "..") {
			continue
		}
		os.RemoveAll(filepath.Join(row.LocalRoot, filepath.FromSlash(p)))
		days[strings.Join(strings.SplitN(p, "/", 4)[:3], "/")] = true
	}
	var ds []string
	for d := range days {
		ds = append(ds, d)
	}
	sort.Strings(ds)
	for _, d := range ds {
		removeEmptyDirs(filepath.Join(row.LocalRoot, filepath.FromSlash(d)))
	}
}

// removeEmptyDirs removes dir and its subfolders when they hold no files.
func removeEmptyDirs(dir string) bool {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	empty := true
	for _, e := range ents {
		if !e.IsDir() || !removeEmptyDirs(filepath.Join(dir, e.Name())) {
			empty = false
		}
	}
	return empty && os.Remove(dir) == nil
}

// redact keeps file names out of logs below debug level (plan 11.4): the
// root becomes <root> and the op's path its logx.Name form.
func redact(err error, root, rel string) string {
	msg := err.Error()
	if logx.Level.Level() <= slog.LevelDebug || root == "" {
		return msg
	}
	if rel != "" {
		msg = strings.ReplaceAll(msg, filepath.Join(root, filepath.FromSlash(rel)), "<root>/"+logx.Name(rel))
		msg = strings.ReplaceAll(msg, rel, logx.Name(rel))
	}
	return strings.ReplaceAll(msg, root, "<root>")
}

// SetEnvironment records the power/network state (engine.environment).
func (r *Runner) SetEnvironment(battery, metered bool) {
	r.mu.Lock()
	r.env2 = environment{battery, metered}
	r.mu.Unlock()
}

// Interrupt cancels the running pass (pause): in-flight ops stay in the
// journal and continue on the next pass.
func (r *Runner) Interrupt() {
	r.mu.Lock()
	c := r.cancelPass
	r.mu.Unlock()
	if c != nil {
		c()
	}
}
