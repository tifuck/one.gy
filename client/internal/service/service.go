// Package service wires the engine together: state DB, key store, account,
// remote tree and poller, the transfer pool and the per-sync runners behind
// the IPC method table (engine-ipc.md), plus the overall status events.
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/tifuck/one.gy/client/internal/account"
	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/config"
	"github.com/tifuck/one.gy/client/internal/exec"
	"github.com/tifuck/one.gy/client/internal/ipc"
	"github.com/tifuck/one.gy/client/internal/keystore"
	"github.com/tifuck/one.gy/client/internal/remote"
	"github.com/tifuck/one.gy/client/internal/state"
	"github.com/tifuck/one.gy/client/internal/syncer"
)

// Options are the engine's start-up parameters.
type Options struct {
	StateDir string
	API      api.Options // Version, InsecureTLS (devtls builds); proxy comes from settings
	LogLevel string      // --log-level; overrides the setting when set
}

// Service is the running engine.
type Service struct {
	opts   Options
	db     *state.DB
	ks     *keystore.Store
	acct   *account.Manager
	tree   *remote.Tree
	poller *remote.Poller
	rpc    *ipc.Server
	pool   *exec.Pool
	xenv   *exec.Env
	senv   *syncer.Env
	mgr    *syncer.Manager

	keysMu sync.Mutex // one key-tree maintenance at a time

	mu         sync.Mutex
	cfg        Settings
	lastStatus map[string]any
	lastSync   map[string]string // sync id -> what publishProgress last sent
	stop       context.CancelFunc
	ctx        context.Context
	caps       *api.Capabilities
}

// New opens the state DB and restores the account.
func New(ctx context.Context, opts Options) (*Service, error) {
	db, err := state.Open(config.DBPath(opts.StateDir))
	if err != nil {
		return nil, err
	}
	s := &Service{opts: opts, db: db, rpc: ipc.NewServer(), pool: exec.NewPool(), ctx: ctx, lastSync: map[string]string{}}
	if s.cfg, err = s.loadSettings(ctx); err != nil {
		db.Close()
		return nil, err
	}
	s.ks = keystore.New(opts.StateDir, s.cfg.RequirePasswordOnStart)
	s.acct = account.New(db, s.ks, s.cfg.apiOptions(opts.API))
	s.acct.OnChange = s.onAccountChange
	s.acct.OnRevoked = s.onRevoked
	if err := s.acct.Load(ctx); err != nil {
		db.Close()
		return nil, err
	}
	s.tree = remote.New(db, s.acct)
	s.poller = remote.NewPoller(s.tree)
	s.poller.Floor = s.pollFloor
	s.poller.Unlock = s.acct.AutoUnlock
	s.poller.OnOnline = func(on bool) {
		s.publishStatus()
		if on {
			s.mgr.Wake("")
		}
	}
	s.pool.Notify = func(v exec.TransferView) { s.rpc.Broadcast("transfer", v) }
	s.pool.Finished = s.recordTransfer
	s.xenv = &exec.Env{DB: db, Tree: s.tree, Acct: s.acct, Pool: s.pool, Caps: s.capabilities, FreeSpace: freeSpace}
	s.senv = &syncer.Env{Exec: s.xenv, Settings: s.syncSettings, Device: s.device, Events: syncer.Events{
		Sync:     s.syncChanged,
		Issue:    func(v syncer.IssueView) { s.rpc.Broadcast("issue", v) },
		Activity: func(a syncer.Activity) { s.rpc.Broadcast("activity", a) },
		Notify: func(title, body, kind string) {
			s.rpc.Broadcast("notify", map[string]string{"title": title, "body": body, "kind": kind})
		},
	}}
	s.mgr = syncer.NewManager(s.senv)
	s.poller.OnApplied = func() {
		s.mgr.Wake("")
		go s.maintainKeys(context.Background())
	}
	s.applySettings(s.cfg, Settings{RequirePasswordOnStart: s.cfg.RequirePasswordOnStart})
	s.rpc.OnSubscribe = func() (string, any) { return "status", s.status(context.Background()) }
	s.register()
	return s, nil
}

// Serve runs the poller, the sync runners and the IPC server on ln until
// ctx ends or engine.shutdown is called; then it waits for the runners (in
// flight ops stay journaled) and closes the state DB.
func (s *Service) Serve(ctx context.Context, ln net.Listener) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.mu.Lock()
	s.stop, s.ctx = cancel, ctx
	s.mu.Unlock()
	go s.poller.Run(ctx)
	if err := s.mgr.Start(ctx); err != nil {
		return err
	}
	go s.statusLoop(ctx)
	go s.grantLoop(ctx)
	go s.maintainKeys(ctx)
	err := s.rpc.Serve(ctx, ln)
	cancel()
	s.mgr.Wait()
	s.rpc.Close()
	s.db.Close()
	return err
}

// SetIPCSecret requires ipc.hello with secret on every connection ("" = off).
func (s *Service) SetIPCSecret(secret string) { s.rpc.Secret = secret }

// grantLoop keeps an unlocked app's grant alive (server TTL 15 min).
func (s *Service) grantLoop(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.acct.RefreshGrant(ctx)
			s.maintainKeys(ctx)
		}
	}
}

// syncRoots lists the one.gy roots of this computer's syncs (nil = drive root).
func (s *Service) syncRoots(ctx context.Context) ([]*int64, error) {
	syncs, err := s.db.ListSyncs(ctx)
	if err != nil {
		return nil, err
	}
	roots := make([]*int64, 0, len(syncs))
	for _, r := range syncs {
		roots = append(roots, r.RemoteRootID)
	}
	return roots, nil
}

// pushScope tells the server which folders this device syncs, so a locked
// app keeps syncing them and nothing else, then brings the key tree along.
// Needs an unlocked app; the last pushed scope stays in force otherwise.
func (s *Service) pushScope(ctx context.Context) {
	if !s.acct.AppUnlocked() {
		return
	}
	roots, err := s.syncRoots(ctx)
	if err != nil {
		return
	}
	scope := api.Scope{Folders: []int64{}}
	for _, r := range roots {
		if r == nil {
			scope.Root = true
		} else {
			scope.Folders = append(scope.Folders, *r)
		}
	}
	if err := s.acct.SetScope(ctx, scope); err != nil {
		slog.Warn("sync scope not sent to the server", "err", err)
	}
	s.maintainKeys(ctx)
}

// maintainKeys, while the master key is in memory (app unlocked): completes
// the key tree for the sync roots, refreshes the folder keys a locked app
// keeps, and tops up the key pool. Skipped while another run is going.
func (s *Service) maintainKeys(ctx context.Context) {
	if !s.keysMu.TryLock() {
		return
	}
	defer s.keysMu.Unlock()
	if _, err := s.acct.MasterKey(); err != nil || !s.acct.AppUnlocked() {
		return
	}
	roots, err := s.syncRoots(ctx)
	if err != nil {
		return
	}
	if err := s.tree.EnsureSynced(ctx); err != nil {
		return
	}
	if n, err := s.tree.Backfill(ctx, roots); err != nil {
		slog.Warn("key tree backfill incomplete", "err", err)
	} else if n > 0 {
		slog.Info("key tree backfilled", "wraps", n)
	}
	s.lockKeys(ctx, roots)
	if err := s.acct.FillPool(ctx); err != nil {
		slog.Warn("key pool not filled", "err", err)
	}
}

// lockKeys stores the sync roots' folder keys for the locked app (no network).
func (s *Service) lockKeys(ctx context.Context, roots []*int64) {
	if err := s.acct.SetTreeKeys(ctx, s.tree.ScopeKeys(ctx, roots)); err != nil {
		slog.Warn("sync keys not sealed", "err", err)
	}
}

// appLock keeps what a locked app needs, then locks: the master key leaves memory.
func (s *Service) appLock(ctx context.Context) {
	s.keysMu.Lock()
	if roots, err := s.syncRoots(ctx); err == nil {
		s.lockKeys(ctx, roots)
	}
	s.keysMu.Unlock()
	s.acct.AppLock(ctx)
	s.tree.ResetKeys() // unwrapped keys of the whole account go with the master key
}

// Shutdown makes Serve return (engine.shutdown, signals).
func (s *Service) Shutdown() {
	s.mu.Lock()
	stop := s.stop
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
}

// root is the engine's lifetime context (manual transfers outlive the call).
func (s *Service) root() context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ctx
}

// capabilities caches GET /sync/capabilities per sign-in. Versioning also
// needs the account's own "keep previous versions" (GET /me, refreshed by
// account.Status at most once a minute): only then is a replace undoable.
func (s *Service) capabilities(ctx context.Context) (*api.Capabilities, error) {
	c, err := s.serverCaps(ctx)
	if err != nil {
		return nil, err
	}
	out := *c
	out.Versioning = c.Versioning && s.acct.Status(ctx).Versioning
	return &out, nil
}

func (s *Service) serverCaps(ctx context.Context) (*api.Capabilities, error) {
	s.mu.Lock()
	c := s.caps
	s.mu.Unlock()
	if c != nil {
		return c, nil
	}
	cl, err := s.acct.Client()
	if err != nil {
		return nil, err
	}
	if c, err = cl.Capabilities(ctx); err != nil {
		return nil, err
	}
	if c.Protocol != config.Protocol {
		return nil, fmt.Errorf("the server speaks sync protocol %d, this app %d; update ONE.GY Desktop", c.Protocol, config.Protocol)
	}
	s.mu.Lock()
	s.caps = c
	s.mu.Unlock()
	return c, nil
}

func freeSpace(p string) (int64, error) {
	if f := detectFS(p).FreeBytes; f > 0 {
		return f, nil
	}
	return 0, errors.New("free space unknown")
}

func (s *Service) syncSettings() syncer.Settings {
	st := s.settings()
	return syncer.Settings{MassDeleteCount: st.MassDeleteCount, MassDeletePercent: st.MassDeletePercent, RescanMinutes: st.RescanMinutes,
		Metered: st.Metered, Battery: st.Battery}
}

func (s *Service) device() (string, string) {
	if a := s.acct.Account(); a != nil {
		return a.DeviceID, a.DeviceName
	}
	return "", ""
}

func (s *Service) syncChanged(id string) {
	if r, err := s.db.GetSync(context.Background(), id); err == nil && r != nil {
		s.rpc.Broadcast("sync", s.toSync(context.Background(), r))
	}
}

func (s *Service) recordTransfer(v exec.TransferView) {
	rec := &state.TransferRecord{Direction: v.Direction, RelPath: v.Path, Size: v.Size, State: v.State, Manual: v.Manual}
	if v.SyncID != nil {
		rec.SyncID = *v.SyncID
	}
	if v.Error != nil {
		rec.Error = *v.Error
	}
	if v.StartedAt != nil {
		rec.StartedAt = *v.StartedAt
	}
	if v.FinishedAt != nil {
		rec.FinishedAt = *v.FinishedAt
	}
	if err := s.db.AddTransferHistory(context.Background(), rec); err != nil {
		slog.Warn("transfer history not saved", "err", err)
	}
}

func (s *Service) onAccountChange() {
	if s.mgr == nil { // during New
		return
	}
	s.mu.Lock()
	s.caps = nil
	s.mu.Unlock()
	if _, err := s.acct.MasterKey(); err != nil {
		s.tree.ResetKeys() // locked: drop every key unwrapped with the master key
	}
	s.publishStatus()
	s.rpc.Broadcast("account", s.acct.Status(context.Background()))
	s.pushScope(context.Background())
	s.mgr.Wake("")
}

// overall computes the status event's state.
func (s *Service) overall(ctx context.Context) string {
	a := s.acct.Account()
	if a == nil || !a.SignedIn {
		return "signed_out"
	}
	if !s.acct.KeysOpen() {
		return "locked"
	}
	if !s.poller.Online() {
		return "offline"
	}
	syncs, err := s.db.ListSyncs(ctx)
	if err != nil {
		return "up_to_date"
	}
	paused := len(syncs) > 0
	for _, r := range syncs {
		if n, _ := s.db.OpenIssueCount(ctx, r.ID); n > 0 {
			return "issues"
		}
		paused = paused && r.Paused
	}
	if paused {
		return "paused"
	}
	if _, busy := s.mgr.Busy(); busy || len(s.pool.List(exec.TActive)) > 0 {
		return "syncing"
	}
	return "up_to_date"
}

// status is the status event's data.
func (s *Service) status(ctx context.Context) map[string]any {
	pending, _ := s.mgr.Busy()
	up, down := s.pool.Rates()
	pausedUp, pausedDown := s.pool.Paused()
	return map[string]any{"state": s.overall(ctx), "pending": pending, "bps_up": up, "bps_down": down, "paused_up": pausedUp, "paused_down": pausedDown}
}

// publishStatus broadcasts a status event when anything in it changed.
func (s *Service) publishStatus() {
	st := s.status(context.Background())
	s.mu.Lock()
	changed := fmt.Sprint(st) != fmt.Sprint(s.lastStatus)
	s.lastStatus = st
	s.mu.Unlock()
	if changed {
		s.rpc.Broadcast("status", st)
	}
}

// publishProgress keeps the app's picture of running work live: transfers
// that stopped moving say so, and a sync whose numbers or reason changed
// (items finished, bytes moved, waiting for something) sends a sync event.
func (s *Service) publishProgress() {
	s.pool.Tick()
	s.mgr.Each(func(r *syncer.Runner) {
		moved, note := s.pool.Flow(r.ID)
		detail, _, at := r.Detail()
		now := fmt.Sprint(r.State(), r.Stats(), moved, note, detail, at.Unix())
		s.mu.Lock()
		changed := s.lastSync[r.ID] != now
		s.lastSync[r.ID] = now
		s.mu.Unlock()
		if changed {
			s.syncChanged(r.ID)
		}
	})
}

// statusLoop keeps the status event and the progress of syncs and transfers
// current (at most once a second).
func (s *Service) statusLoop(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.publishProgress()
			s.publishStatus()
		}
	}
}

// onRevoked runs after the server reported device_revoked (keys already wiped).
func (s *Service) onRevoked() {
	s.tree.ResetKeys()
	s.mgr.Interrupt("")
	if err := s.setPaused(context.Background(), "", true); err != nil {
		slog.Error("pausing syncs after revoke failed", "err", err)
	}
	s.rpc.Broadcast("notify", map[string]string{"title": "This device was removed",
		"body": "Syncing stopped and the keys were removed from this computer. Your files are still here.", "kind": "revoked"})
	s.publishStatus()
}

// rpcError maps engine errors onto the contract's error codes.
func rpcError(err error) error {
	if err == nil {
		return nil
	}
	var rpcErr *ipc.Error
	var apiErr *api.Error
	var fieldErr *account.FieldError
	switch {
	case errors.As(err, &rpcErr):
		return rpcErr
	case errors.Is(err, account.ErrNotSignedIn), errors.Is(err, api.ErrNoToken):
		return ipc.Errorf("not_signed_in", err.Error())
	case errors.Is(err, account.ErrLocked):
		return ipc.Errorf("locked", err.Error())
	case errors.Is(err, account.ErrAppLocked), errors.Is(err, account.ErrNeedsUnlock):
		return ipc.Errorf("app_locked", err.Error())
	case errors.Is(err, account.ErrPasswordNeeded):
		return ipc.Errorf("password_required", err.Error())
	case errors.Is(err, account.ErrWrongPassword):
		return ipc.Errorf("invalid_credentials", err.Error())
	case errors.Is(err, account.ErrAlreadySignedIn):
		return validationFailed([]problem{{Code: "already_signed_in", Message: err.Error()}})
	case errors.As(err, &fieldErr):
		return validationFailed([]problem{{Code: "invalid", Message: fieldErr.Message}})
	case errors.Is(err, remote.ErrNotFound), errors.Is(err, syncer.ErrGone):
		return ipc.Errorf("not_found", err.Error())
	case errors.Is(err, api.ErrOffline):
		return ipc.Errorf("offline", "cannot reach the server")
	case errors.As(err, &apiErr):
		switch apiErr.Code {
		case "invalid_credentials", "totp_required", "invalid_totp", "captcha_required", "device_revoked", "not_found",
			"invalid_pin", "pin_locked", "pin_not_set", "pin_required", "pin_expired", "password_required", "rate_limited":
			return ipc.Errorf(apiErr.Code, apiErr.Message)
		case "locked", "grant_required":
			return ipc.Errorf("app_locked", "Unlock ONE.GY Desktop to do this")
		}
		return ipc.Errorf("server_error", apiErr.Error())
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return ipc.Errorf("offline", "request cancelled")
	}
	return err // reported as {code: internal} by ipc
}
