// Package cloudfiles shows the sync state of ONE.GY's syncs in Windows File
// Explorer (engine setting windows_explorer_status, off by default). Each
// sync root on NTFS is registered as a Cloud Files sync root (with the shell
// through StorageProviderSyncRootManager when Windows allows it, and always
// with the cloud filter through CfRegisterSyncRoot), and every synced item is
// converted to a full placeholder marked in sync, so Explorer's Status column
// shows its own icons. Both policies are "always full": nothing can be
// dehydrated, file content is never touched, and no provider has to run
// (the root is registered but never connected). Turning the setting off or
// removing the sync reverts every placeholder and unregisters the root.
//
// The icons are cosmetic: every error is logged once per sync and never
// reaches a sync op. Other platforms build a no-op backend.
package cloudfiles

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"

	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/state"
	"github.com/tifuck/one.gy/client/internal/syncer"
)

// providerName is the Cloud Files provider name of every ONE.GY sync root;
// a root registered under another name is never touched.
const providerName = "ONE.GY"

var errUnsupported = errors.New("the Cloud Files API is not available")

// Root is one sync as the platform sees it.
type Root struct {
	ID   string // sync id
	Path string // local root
	Name string // sync name (Explorer's navigation pane)
}

// backend is the platform half (cfapi_windows.go, other.go).
type backend interface {
	// platform reports whether the Cloud Files API works here.
	platform() error
	// register registers r with the cloud filter (err) and, best effort,
	// with Explorer (shell: nil when the shell registration worked).
	register(r Root) (shell, err error)
	// owned reports whether p lies in a sync root registered by ONE.GY.
	owned(p string) bool
	// mark sets p in sync when ok(its info) holds, converting it to a full
	// placeholder if needed, and clears an existing placeholder's in-sync
	// state otherwise. Anything but a file or folder is left alone.
	mark(p string, ok func(localfs.Info) bool) error
	// revert turns the placeholder p back into a normal item (no-op for
	// anything else).
	revert(p string) error
	unregister(r Root) error
}

// Manager keeps the placeholders of the syncs in step with the engine.
type Manager struct {
	db *state.DB
	b  backend

	mu     sync.Mutex
	on     bool
	set    bool // SetEnabled ran once
	roots  map[string]*root
	logged map[string]bool

	opMu sync.Mutex // registrations and reverts run one at a time
}

type root struct {
	row    *state.SyncRow
	cancel context.CancelFunc
	done   chan struct{}
	wake   chan struct{}
	ready  bool            // registered; ops finished before are covered by the first pass
	queue  map[string]bool // paths finished by the sync since the worker last looked
}

// New returns the manager of the platform.
func New(db *state.DB) *Manager { return newManager(db, platformBackend{}) }

func newManager(db *state.DB, b backend) *Manager {
	return &Manager{db: db, b: b, roots: map[string]*root{}, logged: map[string]bool{}}
}

// SetEnabled applies the setting: on registers every NTFS sync, off reverts
// every sync root ONE.GY registered (also ones left by an earlier run).
// Repeating the current value does nothing.
func (m *Manager) SetEnabled(on bool) {
	m.mu.Lock()
	if m.set && m.on == on {
		m.mu.Unlock()
		return
	}
	m.set, m.on = true, on
	m.mu.Unlock()
	if err := m.b.platform(); err != nil {
		if on {
			m.logOnce("", err)
		}
		return
	}
	rows, err := m.db.ListSyncs(context.Background())
	if err != nil {
		m.logOnce("", err)
		return
	}
	if on {
		for _, row := range rows {
			m.Start(row)
		}
		return
	}
	go func() {
		for _, row := range rows {
			m.stop(row.ID)
			m.opMu.Lock()
			if !m.enabled() { // turned on again meanwhile: Start owns the root now
				m.revertAll(row)
			}
			m.opMu.Unlock()
		}
	}()
}

func (m *Manager) enabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.on
}

// Start registers a sync's root and converts its synced items in the
// background (setting on, NTFS only). Starting a started sync does nothing.
func (m *Manager) Start(row *state.SyncRow) {
	if row.FSKind != "ntfs" {
		return
	}
	m.mu.Lock()
	if !m.on || m.roots[row.ID] != nil {
		m.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	rt := &root{row: row, cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1), queue: map[string]bool{}}
	m.roots[row.ID] = rt
	m.mu.Unlock()
	go m.run(ctx, rt)
}

// Done tells the manager that an op on rel ('/'-separated) finished and its
// synced row is committed. It never blocks.
func (m *Manager) Done(syncID, rel string) {
	m.mu.Lock()
	rt := m.roots[syncID]
	if rt != nil && !rt.ready {
		rt = nil
	}
	if rt != nil {
		rt.queue[rel] = true
	}
	m.mu.Unlock()
	if rt != nil {
		select {
		case rt.wake <- struct{}{}:
		default:
		}
	}
}

// Remove reverts and unregisters a removed sync's root (whatever the
// setting: an earlier run may have left it registered). It returns when the
// folder holds no placeholder of ONE.GY any more.
func (m *Manager) Remove(row *state.SyncRow) {
	m.stop(row.ID)
	if m.b.platform() != nil {
		return
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.revertAll(row)
}

// Close stops every worker (engine shutdown); registrations stay.
func (m *Manager) Close() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.roots))
	for id := range m.roots {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.stop(id)
	}
}

// stop ends a sync's worker and waits for it.
func (m *Manager) stop(id string) {
	m.mu.Lock()
	rt := m.roots[id]
	delete(m.roots, id)
	m.mu.Unlock()
	if rt != nil {
		rt.cancel()
		<-rt.done
	}
}

func (m *Manager) run(ctx context.Context, rt *root) {
	defer close(rt.done)
	if !m.register(ctx, rt.row) {
		return
	}
	m.mu.Lock()
	rt.ready = true
	m.mu.Unlock()
	m.pass(ctx, rt)
	for {
		select {
		case <-ctx.Done():
			return
		case <-rt.wake:
		}
		m.mu.Lock()
		q := rt.queue
		rt.queue = map[string]bool{}
		m.mu.Unlock()
		for rel := range q {
			if ctx.Err() != nil {
				return
			}
			base, err := m.db.SyncedByPath(ctx, rt.row.ID, rel)
			if err != nil {
				continue
			}
			m.item(rt.row, rel, base)
		}
	}
}

func (m *Manager) register(ctx context.Context, row *state.SyncRow) bool {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if ctx.Err() != nil || !m.enabled() {
		return false
	}
	if !syncer.MarkerMatches(row.LocalRoot, row.ID) {
		m.logOnce(row.ID, errors.New("the local folder is missing or not this sync's"))
		return false
	}
	shell, err := m.b.register(Root{ID: row.ID, Path: row.LocalRoot, Name: row.Name})
	if err != nil {
		m.logOnce(row.ID, err)
		return false
	}
	if shell != nil {
		slog.Warn("explorer status: no shell registration, Explorer may not show the icons", "sync_id", row.ID, "err", shell)
	}
	return true
}

// pass marks the root and every synced item (folders before their
// contents): in sync when it still matches its synced row, not in sync
// otherwise.
func (m *Manager) pass(ctx context.Context, rt *root) {
	rows, err := m.db.ListSynced(ctx, rt.row.ID)
	if err != nil {
		m.logOnce(rt.row.ID, err)
		return
	}
	m.item(rt.row, "", nil)
	for _, r := range rows {
		if ctx.Err() != nil {
			return
		}
		m.item(rt.row, r.RelPath, r)
	}
	slog.Info("explorer status on", "sync_id", rt.row.ID, "items", len(rows))
}

// item marks root/rel against its synced row (nil: none; the root itself
// is always in sync). .onegy is never touched.
func (m *Manager) item(row *state.SyncRow, rel string, base *state.SyncedRow) {
	if rel == ".onegy" || strings.HasPrefix(rel, ".onegy/") {
		return
	}
	ok := func(in localfs.Info) bool { return matches(rel, base, in, row.FSKind) }
	if err := m.b.mark(filepath.Join(row.LocalRoot, filepath.FromSlash(rel)), ok); err != nil && !errors.Is(err, fs.ErrNotExist) {
		m.logOnce(row.ID, err)
	}
}

// matches reports whether a local item is exactly as last synced.
func matches(rel string, base *state.SyncedRow, in localfs.Info, fsKind string) bool {
	switch {
	case rel == "":
		return in.Kind == localfs.KindDir
	case base == nil:
		return false
	case base.Kind == "folder":
		return in.Kind == localfs.KindDir
	}
	return in.Kind == localfs.KindFile && in.Size == base.Size && localfs.SameMtime(in.MtimeNs, base.MtimeNs, fsKind)
}

// revertAll turns every placeholder under a root ONE.GY registered back
// into a normal item, deepest first, then unregisters the root (which also
// ends the root's own placeholder state). Callers hold opMu.
func (m *Manager) revertAll(row *state.SyncRow) {
	if !m.b.owned(row.LocalRoot) {
		return
	}
	var paths []string
	filepath.WalkDir(row.LocalRoot, func(p string, d fs.DirEntry, err error) error {
		if err == nil && p != row.LocalRoot {
			paths = append(paths, p)
		}
		return nil
	})
	for i := len(paths) - 1; i >= 0; i-- {
		if err := m.b.revert(paths[i]); err != nil && !errors.Is(err, fs.ErrNotExist) {
			m.logOnce(row.ID, err)
		}
	}
	if err := m.b.unregister(Root{ID: row.ID, Path: row.LocalRoot, Name: row.Name}); err != nil {
		m.logOnce(row.ID, err)
		return
	}
	slog.Info("explorer status off", "sync_id", row.ID, "items", len(paths))
}

// logOnce logs an error once per sync and message (errors never name a
// file).
func (m *Manager) logOnce(syncID string, err error) {
	k := syncID + "|" + err.Error()
	m.mu.Lock()
	seen := m.logged[k]
	m.logged[k] = true
	m.mu.Unlock()
	if !seen {
		slog.Warn("explorer status", "sync_id", syncID, "err", err)
	}
}
