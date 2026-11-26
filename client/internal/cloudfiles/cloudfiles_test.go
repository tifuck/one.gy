package cloudfiles

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/state"
)

func TestStructLayout(t *testing.T) {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		t.Skip("cfapi.h sizes are checked for 64-bit Windows")
	}
	var reg cfSyncRegistration
	var pol cfSyncPolicies
	for _, c := range []struct {
		name      string
		got, want uintptr
	}{
		{"CF_SYNC_REGISTRATION", unsafe.Sizeof(reg), 72},
		{"CF_SYNC_REGISTRATION.ProviderName", unsafe.Offsetof(reg.ProviderName), 8},
		{"CF_SYNC_REGISTRATION.SyncRootIdentityLength", unsafe.Offsetof(reg.SyncRootIdentityLength), 32},
		{"CF_SYNC_REGISTRATION.FileIdentity", unsafe.Offsetof(reg.FileIdentity), 40},
		{"CF_SYNC_REGISTRATION.FileIdentityLength", unsafe.Offsetof(reg.FileIdentityLength), 48},
		{"CF_SYNC_REGISTRATION.ProviderId", unsafe.Offsetof(reg.ProviderID), 52},
		{"CF_SYNC_POLICIES", unsafe.Sizeof(pol), 24},
		{"CF_SYNC_POLICIES.InSync", unsafe.Offsetof(pol.InSync), 12},
		{"CF_SYNC_POLICIES.PlaceholderManagement", unsafe.Offsetof(pol.PlaceholderManagement), 20},
		{"CF_PLATFORM_INFO", unsafe.Sizeof(cfPlatformInfo{}), 12},
		{"CF_SYNC_ROOT_PROVIDER_INFO", unsafe.Sizeof(cfSyncRootProviderInfo{}), 1028},
		{"GUID", unsafe.Sizeof(guid{}), 16},
	} {
		if c.got != c.want {
			t.Errorf("%s: %d, want %d", c.name, c.got, c.want)
		}
	}
}

// fake is a backend that keeps placeholder states in memory: "in" or "out".
type fake struct {
	mu          sync.Mutex
	state       map[string]string
	registered  map[string]bool
	unregisters int
}

func (f *fake) platform() error { return nil }
func (f *fake) register(r Root) (error, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.registered[r.Path] = true
	return nil, nil
}
func (f *fake) owned(p string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.registered[p]
}
func (f *fake) mark(p string, ok func(localfs.Info) bool) error {
	in, err := localfs.Lstat(p)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case ok(in):
		f.state[p] = "in"
	case f.state[p] != "":
		f.state[p] = "out"
	}
	return nil
}
func (f *fake) revert(p string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.state, p)
	return nil
}
func (f *fake) unregister(r Root) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.registered, r.Path)
	delete(f.state, r.Path)
	f.unregisters++
	return nil
}

func (f *fake) snapshot() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	for k, v := range f.state {
		out[k] = v
	}
	return out
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); !cond(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for " + what)
		}
	}
}

func TestManager(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := state.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	root := filepath.Join(dir, "root")
	write := func(rel, body string) localfs.Info {
		p := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		in, _ := localfs.Lstat(p)
		return in
	}
	write(".onegy/sync.json", `{"sync_id":"s_1"}`)
	a, b, c := write("a.txt", "aaa"), write("b.txt", "bbb"), write("d/c.txt", "c")
	write("new.txt", "not synced yet")
	row := &state.SyncRow{ID: "s_1", Name: "root", LocalRoot: root, Type: "two_way", Config: "{}", FSKind: "ntfs", State: "idle"}
	other := &state.SyncRow{ID: "s_2", Name: "fat", LocalRoot: filepath.Join(dir, "fat"), Type: "two_way", Config: "{}", FSKind: "exfat", State: "idle"}
	for _, r := range []*state.SyncRow{row, other} {
		if err := db.PutSync(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		for _, r := range []*state.SyncedRow{
			{SyncID: "s_1", RelPath: "a.txt", Kind: "file", Size: a.Size, MtimeNs: a.MtimeNs},
			{SyncID: "s_1", RelPath: "b.txt", Kind: "file", Size: b.Size + 1, MtimeNs: b.MtimeNs}, // changed here since
			{SyncID: "s_1", RelPath: "d", Kind: "folder"},
			{SyncID: "s_1", RelPath: "d/c.txt", Kind: "file", Size: c.Size, MtimeNs: c.MtimeNs},
			{SyncID: "s_1", RelPath: "gone.txt", Kind: "file", Size: 1, MtimeNs: 1},
		} {
			if err := state.PutSynced(tx, r); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	f := &fake{state: map[string]string{}, registered: map[string]bool{}}
	m := newManager(db, f)
	defer m.Close()
	abs := func(rel string) string { return filepath.Join(root, filepath.FromSlash(rel)) }
	m.SetEnabled(true)
	want := map[string]string{root: "in", abs("a.txt"): "in", abs("d"): "in", abs("d/c.txt"): "in"}
	waitFor(t, "the first pass", func() bool { return len(f.snapshot()) == len(want) })
	for p, st := range want {
		if got := f.snapshot()[p]; got != st {
			t.Errorf("%s: %q, want %q", p, got, st)
		}
	}
	if f.owned(other.LocalRoot) {
		t.Error("a non-NTFS sync was registered")
	}
	m.Start(row) // again: nothing new

	// An edit clears in-sync once its op is done and the row says otherwise.
	write("a.txt", "edited")
	m.Done("s_1", "a.txt")
	waitFor(t, "a.txt not in sync", func() bool { return f.snapshot()[abs("a.txt")] == "out" })
	// The op commits the new row: in sync again.
	in, _ := localfs.Lstat(abs("a.txt"))
	db.Tx(ctx, func(tx *sql.Tx) error {
		return state.PutSynced(tx, &state.SyncedRow{SyncID: "s_1", RelPath: "a.txt", Kind: "file", Size: in.Size, MtimeNs: in.MtimeNs})
	})
	m.Done("s_1", "a.txt")
	waitFor(t, "a.txt in sync", func() bool { return f.snapshot()[abs("a.txt")] == "in" })
	m.Done("s_1", ".onegy/sync.json") // never touched
	m.Done("nope", "a.txt")

	// Off: every placeholder reverted, the root unregistered.
	m.SetEnabled(false)
	waitFor(t, "the revert", func() bool { return len(f.snapshot()) == 0 && !f.owned(root) })
	m.Done("s_1", "a.txt")
	time.Sleep(20 * time.Millisecond)
	if len(f.snapshot()) != 0 {
		t.Fatal("marked while off")
	}

	// On again, then the sync is removed: Remove returns once all is undone.
	m.SetEnabled(true)
	waitFor(t, "the second pass", func() bool { return len(f.snapshot()) == len(want) })
	m.Remove(row)
	if len(f.snapshot()) != 0 || f.owned(root) {
		t.Fatalf("after remove: %v", f.snapshot())
	}
	m.Remove(row) // not registered: nothing to do
	if f.unregisters != 2 {
		t.Fatalf("%d unregisters", f.unregisters)
	}
}

func TestMarkerMismatchNotRegistered(t *testing.T) {
	dir := t.TempDir()
	db, err := state.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	root := filepath.Join(dir, "root")
	os.MkdirAll(filepath.Join(root, ".onegy"), 0o755)
	os.WriteFile(filepath.Join(root, ".onegy", "sync.json"), []byte(`{"sync_id":"s_other"}`), 0o644)
	row := &state.SyncRow{ID: "s_1", Name: "root", LocalRoot: root, Type: "two_way", Config: "{}", FSKind: "ntfs", State: "idle"}
	db.PutSync(context.Background(), row)
	f := &fake{state: map[string]string{}, registered: map[string]bool{}}
	m := newManager(db, f)
	m.SetEnabled(true)
	m.stop("s_1") // waits for the worker
	if f.owned(root) || len(f.snapshot()) != 0 {
		t.Fatal("a folder that is not the sync's was registered")
	}
}

func TestMatches(t *testing.T) {
	file := &state.SyncedRow{Kind: "file", Size: 3, MtimeNs: 1000}
	for _, c := range []struct {
		rel  string
		base *state.SyncedRow
		in   localfs.Info
		want bool
	}{
		{"", nil, localfs.Info{Kind: localfs.KindDir}, true},
		{"x", nil, localfs.Info{Kind: localfs.KindFile}, false},
		{"x", &state.SyncedRow{Kind: "folder"}, localfs.Info{Kind: localfs.KindDir}, true},
		{"x", &state.SyncedRow{Kind: "folder"}, localfs.Info{Kind: localfs.KindFile}, false},
		{"x", file, localfs.Info{Kind: localfs.KindFile, Size: 3, MtimeNs: 1050}, true}, // NTFS: 100 ns
		{"x", file, localfs.Info{Kind: localfs.KindFile, Size: 3, MtimeNs: 1200}, false},
		{"x", file, localfs.Info{Kind: localfs.KindFile, Size: 4, MtimeNs: 1000}, false},
		{"x", file, localfs.Info{Kind: localfs.KindSymlink, Size: 3, MtimeNs: 1000}, false},
	} {
		if got := matches(c.rel, c.base, c.in, "ntfs"); got != c.want {
			t.Errorf("%+v: %v", c, got)
		}
	}
}
