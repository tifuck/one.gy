package syncer

import (
	"context"
	"errors"
	"log/slog"
	"math/rand"
	"strconv"
	"sync"
	"time"

	"github.com/tifuck/one.gy/client/internal/logx"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/state"
	"github.com/tifuck/one.gy/client/internal/watch"
)

// The runner goroutine: when to run a pass (schedule, watcher hints, remote
// changes, syncNow, retries, the periodic rescan) and the Manager that owns
// one runner per sync.

// Wake asks for a pass (outside the schedule's window or manual mode it
// only counts for syncNow, see trigger).
func (r *Runner) Wake() { r.trigger(false) }

// SyncNow runs a pass whatever the schedule says.
func (r *Runner) SyncNow() { r.trigger(true) }

func (r *Runner) trigger(force bool) {
	r.mu.Lock()
	if force {
		r.forced = true
	}
	r.dirty = true
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// inWindow reports whether hh:mm now lies in [from, to) (wrapping midnight).
func inWindow(now time.Time, from, to string) bool {
	m := func(s string) int {
		h, _ := strconv.Atoi(s[:2])
		mm, _ := strconv.Atoi(s[3:])
		return h*60 + mm
	}
	if len(from) != 5 || len(to) != 5 {
		return true
	}
	cur, f, t := now.Hour()*60+now.Minute(), m(from), m(to)
	if f <= t {
		return cur >= f && cur < t
	}
	return cur >= f || cur < t
}

// due decides whether a pass runs now and when to look again.
func (r *Runner) due(now time.Time, cfg Config, lastPass time.Time) (run bool, next time.Duration) {
	r.mu.Lock()
	forced, dirty, nextRun := r.forced, r.dirty, r.nextRun
	r.mu.Unlock()
	rescan := time.Duration(max(r.env.Settings().RescanMinutes, 5)) * time.Minute
	next = rescan
	if !nextRun.IsZero() {
		next = min(next, max(time.Until(nextRun), 50*time.Millisecond))
	}
	if forced {
		return true, next
	}
	switch cfg.Schedule.Mode {
	case "manual":
		return false, time.Hour
	case "interval":
		iv := time.Duration(max(cfg.Schedule.IntervalMinutes, 1)) * time.Minute
		if lastPass.IsZero() || now.Sub(lastPass) >= iv || (!nextRun.IsZero() && !now.Before(nextRun)) {
			return true, iv
		}
		return false, min(iv-now.Sub(lastPass), next)
	case "window":
		if w := cfg.Schedule.Window; w != nil && !inWindow(now, w.From, w.To) {
			return false, time.Minute
		}
	}
	return dirty || lastPass.IsZero() || now.Sub(lastPass) >= rescan || (!nextRun.IsZero() && !now.Before(nextRun)), next
}

// Run drives the sync until ctx ends or the sync is removed.
func (r *Runner) Run(ctx context.Context) {
	var w *watch.Watcher
	var hints <-chan watch.Hints
	defer func() {
		if w != nil {
			w.Close()
		}
	}()
	var lastPass time.Time
	fails := 0 // internal errors in a row: unreadable sync row, panicked pass
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		row, err := r.env.Exec.DB.GetSync(ctx, r.ID)
		if ctx.Err() != nil || (err == nil && row == nil) {
			return
		}
		if err != nil {
			fails++
			wait := failDelay(fails)
			slog.Error("cannot read the sync from the state database", "sync_id", r.ID, "err", err, "retry_in", wait)
			r.mu.Lock()
			r.detail, r.busy, r.retryAt = "Cannot read this sync's state ("+err.Error()+"); trying again", false, time.Now().Add(wait)
			r.state = "error"
			r.mu.Unlock()
			if r.env.Events.Sync != nil {
				r.env.Events.Sync(r.ID)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			continue
		}
		if w == nil {
			if w, err = watch.New(row.LocalRoot, watch.Options{Poll: pollFor(row.FSKind)}); err == nil {
				hints = w.C
			} else {
				slog.Warn("no file watcher; relying on rescans", "sync_id", r.ID, "err", redact(err, row.LocalRoot, ""))
				w = nil
			}
		}
		cfg := parseConfig(row.Config)
		run, next := r.due(time.Now(), cfg, lastPass)
		r.mu.Lock()
		forced, holdUntil := r.forced, r.failHold
		r.mu.Unlock()
		if wait := time.Until(holdUntil); wait > 0 && !forced {
			run, next = false, wait // backing off after an internal error (syncNow and retry skip the wait)
		}
		if run {
			r.mu.Lock()
			r.forced, r.dirty = false, false
			r.mu.Unlock()
			err := r.safePass(ctx)
			lastPass = time.Now()
			held := errors.Is(err, logx.ErrPanic)
			switch {
			case errors.Is(err, ErrGone), ctx.Err() != nil:
				return
			case held:
				fails++
				next = failDelay(fails)
				r.internalError(ctx, err, time.Now().Add(next))
			case err != nil:
				fails = 0
				next = min(next, 30*time.Second) // offline or failed: try again soon
			default:
				fails = 0
			}
			if !held {
				r.mu.Lock()
				r.failHold = time.Time{}
				r.mu.Unlock()
				_, next2 := r.due(time.Now(), cfg, lastPass)
				next = min(next, next2)
			}
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(next)
		select {
		case <-ctx.Done():
			return
		case <-r.wake:
		case h, ok := <-hints:
			if !ok {
				hints, w = nil, nil
				continue
			}
			if h.WatchLimit {
				r.mu.Lock()
				r.sticky["watch_limit|"] = reconcile.Issue{Kind: "watch_limit", Message: "Linux ran out of file watches (fs.inotify.max_user_watches); changes are picked up by periodic scans instead.",
					Actions: []string{"retry"}}
				r.mu.Unlock()
			}
			r.Wake()
		case <-timer.C:
		}
	}
}

// safePass runs a pass; a panic (e.g. on unexpected server data) ends only
// this pass, as an error wrapping logx.ErrPanic.
func (r *Runner) safePass(ctx context.Context) (err error) {
	defer logx.Recover(&err, "sync pass")
	return r.Pass(ctx)
}

// internalError shows a panicked pass: error state, an issue, and when the
// sync tries again.
func (r *Runner) internalError(ctx context.Context, err error, retry time.Time) {
	r.mu.Lock()
	r.detail, r.busy, r.retryAt, r.failHold = "Syncing stopped on an internal error; trying again", false, retry, retry
	r.mu.Unlock()
	r.setState(ctx, "error", false)
	r.fileIssue(ctx, reconcile.Issue{Kind: "sync_error", Message: "Syncing stopped on an internal error (" + err.Error() + "); it is tried again later. The engine log has the details.",
		Actions: []string{"retry"}})
}

// failDelay backs off after internal errors: 30 s doubling, capped at 10
// min, ±20% so syncs failing together do not retry together.
func failDelay(n int) time.Duration {
	d := min(30*time.Second<<min(max(n-1, 0), 5), 10*time.Minute)
	return time.Duration(float64(d) * (0.8 + 0.4*rand.Float64()))
}

// pollFor: network shares and FAT drives get scans instead of change events.
func pollFor(fsKind string) time.Duration {
	switch fsKind {
	case "nfs", "smb", "smb2", "cifs", "fuse", "sshfs", "vfat", "fat32", "exfat":
		return time.Minute
	}
	return 0
}

// Manager owns one runner per sync.
type Manager struct {
	env *Env

	mu      sync.Mutex
	ctx     context.Context
	runners map[string]*runnerHandle
	envNow  environment
}

type runnerHandle struct {
	r      *Runner
	cancel context.CancelFunc
	done   chan struct{}
}

func NewManager(env *Env) *Manager { return &Manager{env: env, runners: map[string]*runnerHandle{}} }

// Start runs a runner for every configured sync.
func (m *Manager) Start(ctx context.Context) error {
	m.mu.Lock()
	m.ctx = ctx
	m.mu.Unlock()
	rows, err := m.env.Exec.DB.ListSyncs(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		m.Add(row.ID)
	}
	return nil
}

// Add starts the runner of a new sync.
func (m *Manager) Add(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx == nil || m.runners[id] != nil {
		return
	}
	ctx, cancel := context.WithCancel(m.ctx)
	h := &runnerHandle{r: NewRunner(m.env, id), cancel: cancel, done: make(chan struct{})}
	h.r.SetEnvironment(m.envNow.battery, m.envNow.metered)
	m.runners[id] = h
	go func() {
		defer close(h.done)
		h.r.Run(ctx)
	}()
}

// Remove stops a sync's runner and waits for it (before its rows go).
func (m *Manager) Remove(id string) {
	m.mu.Lock()
	h := m.runners[id]
	delete(m.runners, id)
	m.mu.Unlock()
	if h != nil {
		h.cancel()
		<-h.done
	}
}

// Wait blocks until every runner has stopped (after the Start context ended).
func (m *Manager) Wait() {
	m.mu.Lock()
	var hs []*runnerHandle
	for _, h := range m.runners {
		hs = append(hs, h)
	}
	m.mu.Unlock()
	for _, h := range hs {
		<-h.done
	}
}

// Runner returns the runner of a sync (nil when not running).
func (m *Manager) Runner(id string) *Runner {
	m.mu.Lock()
	defer m.mu.Unlock()
	if h := m.runners[id]; h != nil {
		return h.r
	}
	return nil
}

// Each calls fn for every runner.
func (m *Manager) Each(fn func(*Runner)) {
	m.mu.Lock()
	var rs []*Runner
	for _, h := range m.runners {
		rs = append(rs, h.r)
	}
	m.mu.Unlock()
	for _, r := range rs {
		fn(r)
	}
}

// Wake asks every runner (id "") or one runner for a pass.
func (m *Manager) Wake(id string) {
	m.Each(func(r *Runner) {
		if id == "" || r.ID == id {
			r.Wake()
		}
	})
}

// Interrupt cancels the running pass of a sync (id "" = all), e.g. on pause.
func (m *Manager) Interrupt(id string) {
	m.Each(func(r *Runner) {
		if id == "" || r.ID == id {
			r.Interrupt()
		}
	})
}

// SetEnvironment applies engine.environment to every runner.
func (m *Manager) SetEnvironment(battery, metered bool) {
	m.mu.Lock()
	m.envNow = environment{battery, metered}
	m.mu.Unlock()
	m.Each(func(r *Runner) {
		r.SetEnvironment(battery, metered)
		r.Interrupt()
		r.Wake()
	})
}

// Busy sums pending transfers and reports whether any sync is working.
func (m *Manager) Busy() (pending int, syncing bool) {
	m.Each(func(r *Runner) {
		st := r.Stats()
		pending += st.PendingUp + st.PendingDown
		s := r.State()
		syncing = syncing || s == "syncing" || s == "scanning"
	})
	return pending, syncing
}

// ResolveIssue routes a decision to the issue's sync runner.
func (m *Manager) ResolveIssue(ctx context.Context, row *state.IssueRow, act, name string) error {
	r := m.Runner(row.SyncID)
	if r == nil {
		return ErrGone
	}
	return r.Resolve(ctx, row, act, name)
}

// addSticky files an issue that stays until resolved (verify results).
func (r *Runner) addSticky(is reconcile.Issue) {
	r.mu.Lock()
	r.sticky[is.Kind+"|"+is.Path] = is
	r.mu.Unlock()
}
