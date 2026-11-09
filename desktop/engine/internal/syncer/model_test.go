//go:build linux

package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math/rand"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/exec"
	"github.com/tifuck/one.gy/desktop/engine/internal/fakeserver"
	"github.com/tifuck/one.gy/desktop/engine/internal/reconcile"
	"github.com/tifuck/one.gy/desktop/engine/internal/remote"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
)

// Model-based test: 2-3 simulated devices and the "website" run random
// operations against one fake server, with crashes injected at journal
// boundaries. Invariants: every version the user did not destroy survives
// somewhere (a device, its debris, one.gy, its trash); no file holds partial
// content; all devices converge with one.gy once operations stop; no (key,
// nonce) pair is reused. MODEL_RUNS (default 200) and MODEL_SEED (one run).

type testAcct struct {
	c  *api.Client
	mk []byte
}

func (a *testAcct) Client() (*api.Client, error) { return a.c, nil }
func (a *testAcct) MasterKey() ([]byte, error)   { return append([]byte(nil), a.mk...), nil }

type device struct {
	t      testing.TB
	name   string
	root   string
	db     *state.DB
	srv    *fakeserver.Server
	token  string
	syncID string
	run    *Runner
	crash  int // crash at the n-th journal boundary of the next pass (0 = none)
}

func newDevice(t testing.TB, srv *fakeserver.Server, name string, rootID int64, cfg map[string]any) *device {
	dir := t.TempDir()
	d := &device{t: t, name: name, root: filepath.Join(dir, "root"), srv: srv, token: srv.DeviceToken(), syncID: "s_" + name}
	os.MkdirAll(filepath.Join(d.root, ".onegy"), 0o700)
	db, err := state.Open(filepath.Join(dir, "engine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	d.db = db
	ctx := context.Background()
	db.PutAccount(ctx, &state.Account{ServerURL: srv.URL, Username: "u", SignedIn: true, DeviceID: name, DeviceName: name})
	c := map[string]any{"conflict_policy": "keep_both", "issue_mode": "smart", "propagate_deletes": true, "debris_days": 30,
		"keep_exec_bit": true, "thumbnails": false, "initial": "merge", "schedule": map[string]any{"mode": "live"}}
	for k, v := range cfg {
		if k != "encryption" {
			c[k] = v
		}
	}
	cj, _ := json.Marshal(c)
	enc := "e2ee"
	if v, ok := cfg["encryption"].(string); ok {
		enc = v
	}
	db.PutSync(ctx, &state.SyncRow{ID: d.syncID, Name: name, LocalRoot: d.root, RemoteRootID: &rootID, Type: "two_way", Encryption: enc,
		Config: string(cj), FSKind: "ext4", CaseSensitive: true, State: "scanning", CreatedAt: time.Now().UTC().Format(time.RFC3339)})
	b, _ := json.Marshal(map[string]any{"sync_id": d.syncID})
	os.WriteFile(filepath.Join(d.root, ".onegy", "sync.json"), b, 0o600)
	d.restart()
	return d
}

// restart rebuilds everything that lives in memory (a process restart).
func (d *device) restart() {
	c, err := api.New(d.srv.URL, api.Options{Version: "0.1.0", Transport: d.srv.Client().Transport, MaxRetries: 1})
	if err != nil {
		d.t.Fatal(err)
	}
	c.SetToken(d.token)
	acct := &testAcct{c: c, mk: d.srv.MasterKey()}
	var caps *api.Capabilities
	ex := &exec.Env{DB: d.db, Tree: remote.New(d.db, acct), Acct: acct, Pool: exec.NewPool(),
		Caps: func(ctx context.Context) (*api.Capabilities, error) {
			if caps != nil {
				return caps, nil
			}
			var err error
			caps, err = c.Capabilities(ctx)
			return caps, err
		}}
	env := &Env{Exec: ex, Settings: func() Settings {
		return Settings{MassDeleteCount: 1 << 30, MassDeletePercent: 100, RescanMinutes: 60, Metered: "continue", Battery: "continue"}
	}, Device: func() (string, string) { return d.name, d.name }}
	d.run = NewRunner(env, d.syncID)
	d.run.Workers = 1
	d.run.QuietPeriod = func(int64) time.Duration { return 0 }
	d.run.Crash = func(string, reconcile.OpKind) bool {
		if d.crash == 0 {
			return false
		}
		d.crash--
		return d.crash == 0
	}
}

func (d *device) pass() error {
	err := d.run.Pass(context.Background())
	slog.Debug("pass done", "dev", d.name, "state", d.run.State(), "err", err)
	if errors.Is(err, exec.ErrCrashed) {
		d.restart()
	}
	return err
}

// tree reads the device's synced files ("<dir>" for folders).
func readTree(root string) map[string]string {
	out := map[string]string{}
	filepath.WalkDir(root, func(p string, de fs.DirEntry, err error) error {
		if err != nil || p == root {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if rel == ".onegy" {
			return filepath.SkipDir
		}
		if de.IsDir() {
			out[rel] = "<dir>"
		} else {
			b, _ := os.ReadFile(p)
			out[rel] = string(b)
		}
		return nil
	})
	return out
}

func allFiles(root string) []string {
	var out []string
	for _, f := range allFilesAt(root) {
		out = append(out, f[1])
	}
	return out
}

// allFilesAt returns [path, content] of every file outside tmp/spool.
func allFilesAt(root string) [][2]string {
	var out [][2]string
	filepath.WalkDir(root, func(p string, de fs.DirEntry, err error) error {
		if err == nil && de.Type().IsRegular() && !strings.Contains(p, "/.onegy/tmp/") && !strings.Contains(p, "/.onegy/spool/") &&
			!strings.HasSuffix(p, "/.onegy/sync.json") {
			b, _ := os.ReadFile(p)
			out = append(out, [2]string{p, string(b)})
		}
		return nil
	})
	return out
}

type model struct {
	t         testing.TB
	rng       *rand.Rand
	srv       *fakeserver.Server
	rootID    int64
	devs      []*device
	written   map[string]bool
	destroyed map[string]bool
	n         int
	log       []string
}

func (m *model) blob() string {
	m.n++
	pad := strings.Repeat("x", m.rng.Intn(3000))
	b := fmt.Sprintf("blob-%d-%s", m.n, pad)
	m.written[b] = true
	m.log = append(m.log, fmt.Sprintf("  (blob-%d)", m.n))
	return b
}

var names = []string{"a", "b", "c", "d.txt", "e.txt"}

func (m *model) pick(list []string) string { return list[m.rng.Intn(len(list))] }

func (m *model) localPaths(d *device, dirs bool) []string {
	var out []string
	for p, v := range readTree(d.root) {
		if (v == "<dir>") == dirs {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

func (m *model) touch(p string) {
	m.n++
	t := time.Unix(1_700_000_000+int64(m.n), 0)
	os.Chtimes(p, t, t)
}

func (m *model) localOp(d *device) {
	dirs := append([]string{""}, m.localPaths(d, true)...)
	files := m.localPaths(d, false)
	abs := func(p string) string { return filepath.Join(d.root, filepath.FromSlash(p)) }
	switch k := m.rng.Intn(10); {
	case k < 3 || len(files) == 0:
		p := path.Join(m.pick(dirs), m.pick(names))
		if _, err := os.Lstat(abs(p)); err == nil {
			return
		}
		os.WriteFile(abs(p), []byte(m.blob()), 0o644)
		m.touch(abs(p))
		m.log = append(m.log, d.name+" create "+p)
	case k < 5:
		p := m.pick(files)
		old, _ := os.ReadFile(abs(p))
		m.destroyed[string(old)] = true
		if m.rng.Intn(2) == 0 {
			os.WriteFile(abs(p), []byte(m.blob()), 0o644)
		} else { // editor safe save
			os.WriteFile(abs(p)+".swp", []byte(m.blob()), 0o644)
			os.Rename(abs(p)+".swp", abs(p))
		}
		m.touch(abs(p))
		m.log = append(m.log, d.name+" edit "+p)
	case k < 6:
		p := m.pick(files)
		old, _ := os.ReadFile(abs(p))
		m.destroyed[string(old)] = true
		os.Remove(abs(p))
		m.log = append(m.log, d.name+" delete "+p)
	case k < 8:
		all := append(files, dirs[1:]...)
		src := m.pick(all)
		dst := path.Join(m.pick(dirs), m.pick(names))
		if dst == src || strings.HasPrefix(dst+"/", src+"/") {
			return
		}
		if _, err := os.Lstat(abs(dst)); err == nil {
			return
		}
		if os.Rename(abs(src), abs(dst)) == nil {
			m.log = append(m.log, d.name+" move "+src+" > "+dst)
		}
	case k < 9:
		p := path.Join(m.pick(dirs), "dir-"+m.pick(names))
		if os.Mkdir(abs(p), 0o755) == nil {
			m.log = append(m.log, d.name+" mkdir "+p)
		}
	default:
		if len(dirs) > 1 {
			p := m.pick(dirs[1:])
			for _, b := range allFiles(abs(p)) {
				m.destroyed[b] = true
			}
			os.RemoveAll(abs(p))
			m.log = append(m.log, d.name+" rmdir "+p)
		}
	}
}

func (m *model) remoteOp() {
	snap := m.srv.Snapshot(&m.rootID)
	live := map[string]fakeserver.Entry{}
	liveDir := map[string]fakeserver.Entry{}
	var files, dirs []fakeserver.Entry
	for _, e := range snap {
		if e.Trashed {
			continue
		}
		live[e.Path] = e
		if e.Kind == "folder" {
			liveDir[e.Path] = e
		}
		if e.Kind == "file" {
			files = append(files, e)
		} else {
			dirs = append(dirs, e)
		}
	}
	parentOf := func(p string) *int64 {
		if d := path.Dir(p); d != "." {
			id, _ := strconv.ParseInt(liveDir[d].ID, 10, 64)
			return &id
		}
		return &m.rootID
	}
	dirPaths := []string{""}
	for _, e := range dirs {
		dirPaths = append(dirPaths, e.Path)
	}
	switch k := m.rng.Intn(9); {
	case k < 3 || len(files) == 0:
		p := path.Join(m.pick(dirPaths), m.pick(names))
		if _, ok := live[p]; ok {
			return
		}
		m.srv.AddFile(parentOf(p), path.Base(p), []byte(m.blob()))
		m.log = append(m.log, "web create "+p)
	case k < 5:
		e := files[m.rng.Intn(len(files))]
		m.destroyed[string(e.Plain)] = true
		m.srv.EditFile(e.ID, []byte(m.blob()))
		m.log = append(m.log, "web edit "+e.Path)
	case k < 6:
		all := append(files, dirs...)
		e := all[m.rng.Intn(len(all))]
		m.srv.Trash(e.Kind, e.ID)
		m.log = append(m.log, "web trash "+e.Path)
	case k < 8:
		all := append(files, dirs...)
		e := all[m.rng.Intn(len(all))]
		dst := path.Join(m.pick(dirPaths), m.pick(names))
		if _, ok := live[dst]; ok || dst == e.Path || strings.HasPrefix(dst+"/", e.Path+"/") {
			return
		}
		if path.Dir(dst) != path.Dir(e.Path) {
			m.srv.Move(e.Kind, e.ID, parentOf(dst))
		}
		if path.Base(dst) != path.Base(e.Path) {
			m.srv.Rename(e.Kind, e.ID, path.Base(dst))
		}
		m.log = append(m.log, "web move "+e.Path+" > "+dst)
	default:
		p := path.Join(m.pick(dirPaths), "dir-"+m.pick(names))
		if _, ok := live[p]; ok {
			return
		}
		m.srv.AddFolder(parentOf(p), path.Base(p))
		m.log = append(m.log, "web mkdir "+p)
	}
}

func (m *model) fail(format string, args ...any) {
	m.t.Helper()
	m.t.Fatalf(format+"\nops:\n  %s", append(args, strings.Join(m.log, "\n  "))...)
}

// check verifies the invariants; converge also requires equal trees.
func (m *model) check(converged bool) {
	m.t.Helper()
	present := map[string]bool{}
	for _, d := range m.devs {
		for _, f := range allFilesAt(d.root) {
			b := f[1]
			if !m.written[b] {
				m.fail("%s holds content nobody wrote at %s (%d bytes): %.40q", d.name, f[0], len(b), b)
			}
			present[b] = true
		}
	}
	for _, e := range m.srv.Snapshot(&m.rootID) {
		if e.Kind == "file" {
			present[string(e.Plain)] = true
		}
	}
	for b := range m.written {
		if !m.destroyed[b] && !present[b] {
			m.fail("a version was lost: %.40q", b)
		}
	}
	if v := m.srv.NonceViolations(); len(v) > 0 {
		m.fail("nonce reuse: %v", v)
	}
	if !converged {
		return
	}
	var want []string
	for _, e := range m.srv.Snapshot(&m.rootID) {
		if e.Trashed {
			continue
		}
		v := "<dir>"
		if e.Kind == "file" {
			v = string(e.Plain)
		}
		want = append(want, canonical(e.Path, v))
	}
	sort.Strings(want)
	for _, d := range m.devs {
		var got []string
		for p, v := range readTree(d.root) {
			got = append(got, canonical(p, v))
		}
		sort.Strings(got)
		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			m.fail("%s did not converge:\n got  %v\n want %v\n issues %v", d.name, short(got), short(want), m.issues(d))
		}
	}
}

// dupSuffix is the name suffix the reconciler gives items that would share a
// name (local mappings of one.gy duplicates, and items moved onto a name an
// unsynced one.gy item uses); devices may assign it to different items and
// stack it (" (2) (2)"), so convergence compares names without any of it.
var dupSuffix = regexp.MustCompile(` \((\d+|case \d+)\)(\.[^.]*)?$`)

func canonical(p, v string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		for t := dupSuffix.ReplaceAllString(s, "$2"); t != s; t = dupSuffix.ReplaceAllString(s, "$2") {
			s = t
		}
		parts[i] = s
	}
	return strings.Join(parts, "/") + "=" + v
}

func short(list []string) []string {
	out := make([]string, len(list))
	for i, s := range list {
		if len(s) > 60 {
			s = s[:60]
		}
		out[i] = s
	}
	return out
}

func (m *model) issues(d *device) []string {
	rows, _ := d.db.OpenIssues(context.Background(), d.syncID)
	var out []string
	for _, r := range rows {
		out = append(out, r.Kind+" "+r.RelPath+" "+r.Detail)
	}
	return out
}

func keys(t map[string]string) []string {
	var out []string
	for k, v := range t {
		if v != "<dir>" && len(v) > 12 {
			v = v[:12]
		}
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func runModel(t testing.TB, seed int64) {
	rng := rand.New(rand.NewSource(seed))
	srv := fakeserver.New(t, "u", "pw")
	srv.SmallUploadMax = 1024 // larger files go through upload sessions
	srv.WithMeta = rng.Intn(2) == 0
	m := &model{t: t, rng: rng, srv: srv, written: map[string]bool{}, destroyed: map[string]bool{}}
	m.rootID = srv.AddFolder(nil, "Root")
	nd := 2 + rng.Intn(2)
	var cfg map[string]any
	if rng.Intn(4) == 0 {
		cfg = map[string]any{"encryption": "standard"} // new files and folders without E2EE
	}
	for i := 0; i < nd; i++ {
		m.devs = append(m.devs, newDevice(t, srv, fmt.Sprintf("D%d", i+1), m.rootID, cfg))
	}
	steps := 15 + rng.Intn(25)
	for i := 0; i < steps; i++ {
		switch k := rng.Intn(10); {
		case k < 4:
			m.localOp(m.devs[rng.Intn(nd)])
		case k < 6:
			m.remoteOp()
		default:
			d := m.devs[rng.Intn(nd)]
			if rng.Intn(3) == 0 {
				d.crash = 1 + rng.Intn(12)
			}
			m.log = append(m.log, fmt.Sprintf("%s pass crash=%d", d.name, d.crash))
			if err := d.pass(); err != nil && !errors.Is(err, exec.ErrCrashed) {
				m.fail("%s pass: %v", d.name, err)
			}
			d.crash = 0
			m.check(false)
		}
	}
	for round := 0; ; round++ {
		before := m.world()
		for _, d := range m.devs {
			d.run.mu.Lock()
			d.run.retries = map[string]*retry{} // time "passes" between rounds
			d.run.mu.Unlock()
			if err := d.pass(); err != nil {
				m.fail("%s pass: %v", d.name, err)
			}
		}
		idle := m.world() == before
		for _, d := range m.devs {
			if d.run.State() != "up_to_date" {
				idle = false
			}
		}
		if idle {
			break
		}
		if round > 8 {
			m.check(true)
			m.fail("no convergence after %d rounds (states %v)", round, states(m.devs))
		}
	}
	m.check(true)
}

// world fingerprints all devices and the server (a round that changes
// nothing means the system is quiescent).
func (m *model) world() string {
	var b strings.Builder
	for _, e := range m.srv.Snapshot(&m.rootID) {
		fmt.Fprintf(&b, "%s|%s|%v|%x;", e.Kind, e.Path, e.Trashed, e.Plain)
	}
	for _, d := range m.devs {
		fmt.Fprint(&b, keys(readTree(d.root)))
	}
	return b.String()
}

func states(ds []*device) []string {
	var out []string
	for _, d := range ds {
		out = append(out, d.name+"="+d.run.State())
	}
	return out
}

// fastTemp puts test files on tmpfs when there is one: the engine fsyncs
// every journal step, which costs ~15 ms per call on some disks.
func fastTemp(t *testing.T) {
	if fi, err := os.Stat("/dev/shm"); err == nil && fi.IsDir() {
		if d, err := os.MkdirTemp("/dev/shm", "onegy-test-"); err == nil {
			t.Cleanup(func() { os.RemoveAll(d) })
			t.Setenv("TMPDIR", d)
		}
	}
}

func TestModel(t *testing.T) {
	fastTemp(t)
	if os.Getenv("MODEL_DEBUG") != "" {
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})))
	}
	if s := os.Getenv("MODEL_SEED"); s != "" {
		seed, _ := strconv.ParseInt(s, 10, 64)
		runModel(t, seed)
		return
	}
	runs := 300
	if s := os.Getenv("MODEL_RUNS"); s != "" {
		runs, _ = strconv.Atoi(s)
	}
	if testing.Short() {
		runs = 20
	}
	from := int64(1000)
	if s := os.Getenv("MODEL_FROM"); s != "" {
		from, _ = strconv.ParseInt(s, 10, 64)
	}
	for i := 0; i < runs; i++ {
		seed := from + int64(i)
		if !t.Run(fmt.Sprintf("seed%d", seed), func(t *testing.T) { runModel(t, seed) }) {
			return
		}
	}
}
