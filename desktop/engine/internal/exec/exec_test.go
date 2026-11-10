package exec

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/account"
	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/fakeserver"
	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/reconcile"
	"github.com/tifuck/one.gy/desktop/engine/internal/remote"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
	"onegy/e2ee"
)

type acct struct {
	c  *api.Client
	mk []byte
}

func (a *acct) Client() (*api.Client, error) { return a.c, nil }
func (a *acct) MasterKey() ([]byte, error)   { return append([]byte(nil), a.mk...), nil }

func (a *acct) TreeKey(int64) ([]byte, bool) { return nil, false }
func (a *acct) NewKey(context.Context) (*account.NewKey, error) {
	k, _ := e2ee.RandomBytes(e2ee.KeySize)
	w, n, err := e2ee.WrapKey(k, a.mk)
	return &account.NewKey{Key: k, Wrap: e2ee.EncodeBase64(w), Nonce: e2ee.EncodeBase64(n)}, err
}

type fixture struct {
	t      *testing.T
	srv    *fakeserver.Server
	db     *state.DB
	env    *Env
	root   string
	rootID int64
}

func setup(t *testing.T, enc string) *fixture {
	t.Helper()
	if fi, err := os.Stat("/dev/shm"); err == nil && fi.IsDir() { // fsync is slow on some test disks
		d, _ := os.MkdirTemp("/dev/shm", "onegy-exec-")
		t.Cleanup(func() { os.RemoveAll(d) })
		t.Setenv("TMPDIR", d)
	}
	srv := fakeserver.New(t, "u", "pw")
	dir := t.TempDir()
	db, err := state.Open(filepath.Join(dir, "engine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	db.PutAccount(ctx, &state.Account{ServerURL: srv.URL, Username: "u", SignedIn: true})
	c, _ := api.New(srv.URL, api.Options{Version: "0.1.0", Transport: srv.Client().Transport, MaxRetries: -1})
	c.SetToken(srv.DeviceToken())
	a := &acct{c: c, mk: srv.MasterKey()}
	f := &fixture{t: t, srv: srv, db: db, root: filepath.Join(dir, "root")}
	os.MkdirAll(filepath.Join(f.root, ".onegy"), 0o700)
	f.rootID = srv.AddFolder(nil, "Root")
	f.env = &Env{DB: db, Tree: remote.New(db, a), Acct: a, Pool: NewPool(),
		Caps: func(ctx context.Context) (*api.Capabilities, error) { return c.Capabilities(ctx) }}
	db.PutSync(ctx, &state.SyncRow{ID: "s1", Name: "s", LocalRoot: f.root, RemoteRootID: &f.rootID, Type: "two_way", Encryption: enc,
		Config: "{}", FSKind: "ext4", CaseSensitive: true, CreatedAt: "x"})
	f.sync()
	return f
}

func (f *fixture) sync() {
	if _, err := f.env.Tree.Sync(context.Background()); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) exec(enc string) *Executor {
	return New(f.env, Sync{ID: "s1", Root: f.root, RootID: &f.rootID, Encryption: enc, FSKind: "ext4", KeepExecBit: true})
}

func (f *fixture) write(rel string, data []byte) *reconcile.Expect {
	p := filepath.Join(f.root, rel)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		f.t.Fatal(err)
	}
	in, _ := localfs.Lstat(p)
	return &reconcile.Expect{Kind: localfs.KindFile, ID: in.ID, Size: in.Size, MtimeNs: in.MtimeNs}
}

func sum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func (f *fixture) uploadOp(rel string, data []byte) reconcile.Op {
	e := f.write(rel, data)
	return reconcile.Op{Kind: reconcile.Upload, Path: rel, EntryKind: localfs.KindFile, RemoteName: filepath.Base(rel), Size: e.Size,
		SHA256: sum(data), Local: e}
}

// remoteFile returns the live remote file at name (decrypted).
func (f *fixture) remoteFile(name string) []byte {
	for _, e := range f.srv.Snapshot(&f.rootID) {
		if e.Path == name && !e.Trashed && e.Kind == "file" {
			return e.Plain
		}
	}
	return nil
}

func (f *fixture) row(rel string) *state.SyncedRow {
	var r *state.SyncedRow
	f.db.Tx(context.Background(), func(tx *sql.Tx) (err error) {
		r, err = state.SyncedAt(tx, "s1", rel)
		return err
	})
	return r
}

func TestUploadSessionResumesFromSpool(t *testing.T) {
	f := setup(t, "standard")
	f.srv.SmallUploadMax, f.srv.ChunkSize = 1000, 1000 // 5 parts of plaintext
	data := bytes.Repeat([]byte("0123456789"), 450)
	op := f.uploadOp("big.bin", data)
	x := f.exec("standard")
	var mu sync.Mutex
	f.srv.Fault = func(method, path string) (int, bool) {
		mu.Lock()
		defer mu.Unlock()
		if method == "PUT" && strings.HasSuffix(path, "/parts/2") && f.srv.Requests[method+" "+path] == 1 {
			return -1, false // network drops while part 2 is sent
		}
		return 0, false
	}
	err := x.Execute(context.Background(), op)
	if !errors.Is(err, api.ErrOffline) {
		t.Fatalf("want offline, got %v", err)
	}
	f.srv.Fault = nil
	if err := x.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := f.remoteFile("big.bin"); !bytes.Equal(got, data) {
		t.Fatalf("remote content %d bytes", len(got))
	}
	for i, want := range []int{1, 1, 2, 1, 1} { // parts 0,1 were not resent
		if n := f.srv.Requests["PUT /apiv1/sync/uploads/sess-1/parts/"+string(rune('0'+i))]; n != want {
			t.Fatalf("part %d sent %d times, want %d", i, n, want)
		}
	}
	if r := f.row("big.bin"); r == nil || r.PlainSHA256 != sum(data) {
		t.Fatalf("synced row %+v", r)
	}
	if _, err := os.Stat(x.spoolDir(1)); !os.IsNotExist(err) {
		t.Fatal("spool left behind")
	}
}

func TestNonceRuleLostSpoolRestarts(t *testing.T) {
	f := setup(t, "e2ee")
	f.srv.SmallUploadMax = 100
	data := bytes.Repeat([]byte("x"), 5000)
	op := f.uploadOp("a.bin", data)
	x := f.exec("e2ee")
	f.srv.Fault = func(method, path string) (int, bool) {
		if strings.HasSuffix(path, "/complete") {
			return -1, false
		}
		return 0, false
	}
	if err := x.Execute(context.Background(), op); !errors.Is(err, api.ErrOffline) {
		t.Fatalf("want offline, got %v", err)
	}
	f.srv.Fault = nil
	os.Remove(filepath.Join(x.spoolDir(1), "0")) // the spool lost its only part
	if err := x.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := f.remoteFile("a.bin"); !bytes.Equal(got, data) {
		t.Fatalf("remote content %d bytes", len(got))
	}
	if f.srv.Requests["DELETE /apiv1/sync/uploads/sess-1"] != 1 {
		t.Fatalf("old session not aborted: %v", f.srv.Requests)
	}
	if v := f.srv.NonceViolations(); len(v) > 0 {
		t.Fatal(v)
	}
}

func TestUploadRefusesChangedFile(t *testing.T) {
	f := setup(t, "e2ee")
	op := f.uploadOp("a.txt", []byte("one"))
	time.Sleep(10 * time.Millisecond)
	f.write("a.txt", []byte("two!")) // changed after the scan
	err := f.exec("e2ee").Execute(context.Background(), op)
	if !errors.Is(err, ErrSuperseded) || f.remoteFile("a.txt") != nil {
		t.Fatalf("err %v", err)
	}
}

func TestDownloadReplacesIntoDebrisAndRecovers(t *testing.T) {
	f := setup(t, "e2ee")
	id := f.srv.AddFile(&f.rootID, "doc.txt", []byte("remote version"))
	f.sync()
	n, _ := f.db.GetNode(context.Background(), "file", id)
	local := f.write("doc.txt", []byte("old local"))
	op := reconcile.Op{Kind: reconcile.Download, Path: "doc.txt", EntryKind: localfs.KindFile, RemoteID: id, RemoteName: "doc.txt",
		ContentVersion: n.ContentVersion, PayloadChecksum: n.PayloadChecksum, Local: local}
	x := f.exec("e2ee")
	x.Crash = func(point string, _ reconcile.OpKind) bool { return point == "pre-local_done" } // renamed, not journaled
	if err := x.Execute(context.Background(), op); !errors.Is(err, ErrCrashed) {
		t.Fatalf("want crash, got %v", err)
	}
	x.Crash = nil
	if err := x.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.root, "doc.txt")); string(b) != "remote version" {
		t.Fatalf("target %q", b)
	}
	debris, _ := filepath.Glob(filepath.Join(f.root, ".onegy", "debris", "*", "doc.txt"))
	if len(debris) != 1 {
		t.Fatalf("debris %v", debris)
	}
	if b, _ := os.ReadFile(debris[0]); string(b) != "old local" {
		t.Fatalf("debris holds %q", b)
	}
	if r := f.row("doc.txt"); r == nil || r.RemoteID != id {
		t.Fatalf("row %+v", r)
	}
}

func TestDownloadChecks(t *testing.T) {
	f := setup(t, "e2ee")
	f.srv.WithMeta = true
	id := f.srv.AddFile(&f.rootID, "a.txt", []byte("hello"))
	f.sync()
	n, _ := f.db.GetNode(context.Background(), "file", id)
	op := reconcile.Op{Kind: reconcile.Download, Path: "a.txt", EntryKind: localfs.KindFile, RemoteID: id, RemoteName: "a.txt",
		ContentVersion: n.ContentVersion, PayloadChecksum: n.PayloadChecksum, Local: &reconcile.Expect{Absent: true}}

	// Disk full: nothing is written.
	f.env.FreeSpace = func(string) (int64, error) { return 1 << 20, nil }
	var ie *IssueError
	if err := f.exec("e2ee").Execute(context.Background(), op); !errors.As(err, &ie) || ie.Kind != "disk_full" {
		t.Fatalf("want disk_full, got %v", err)
	}
	f.env.FreeSpace = nil

	// Meta naming another file: integrity issue, nothing applied.
	other := f.srv.AddFile(&f.rootID, "b.txt", []byte("other"))
	f.sync()
	o, _ := f.db.GetNode(context.Background(), "file", other)
	key, _ := e2ee.UnwrapKeyB64(n.EncryptedKey, n.KeyNonce, f.srv.MasterKey())
	meta, nonce, _ := e2ee.EncryptMeta(e2ee.Meta{FileID: other, ContentVersion: 1, PlainSize: 5, PlainSHA256: sum([]byte("hello"))}, key)
	n.EncryptedMeta, n.MetaNonce = meta, nonce
	f.db.Tx(context.Background(), func(tx *sql.Tx) error { return state.UpsertNode(tx, "remote_node", n) })
	if err := f.exec("e2ee").Execute(context.Background(), op); !errors.As(err, &ie) || ie.Kind != "integrity" {
		t.Fatalf("want integrity, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.root, "a.txt")); !os.IsNotExist(err) {
		t.Fatal("unverified content reached the target")
	}
	_ = o
}

func TestPool(t *testing.T) {
	p := NewPool()
	p.SetLimits(1, 1, 0, 0)
	ctx := context.Background()
	big, _ := p.Begin(ctx, "", Up, "big", 100, false, nil)
	small, _ := p.Begin(ctx, "", Up, "small", 1, true, nil)
	first, _ := p.Begin(ctx, "", Up, "first", 50, false, nil)
	if err := first.Start(ctx); err != nil {
		t.Fatal(err)
	}
	order := make(chan string, 2)
	for _, tr := range []*Transfer{big, small} {
		go func(tr *Transfer) {
			if tr.Start(ctx) == nil {
				order <- tr.path
				tr.Finish(nil)
			}
		}(tr)
	}
	time.Sleep(50 * time.Millisecond)
	if len(order) != 0 {
		t.Fatal("limit 1 exceeded")
	}
	first.Finish(nil)
	if a, b := <-order, <-order; a != "small" || b != "big" {
		t.Fatalf("order %s %s, want small first", a, b)
	}

	// Pause blocks Wait; cancel stops manual transfers only.
	tr, tctx := p.Begin(ctx, "", Down, "x", 10, true, nil)
	tr.Start(tctx)
	p.SetPaused("", Down, true)
	done := make(chan error, 1)
	go func() { done <- tr.Wait(tctx, 1) }()
	select {
	case <-done:
		t.Fatal("Wait returned while paused")
	case <-time.After(50 * time.Millisecond):
	}
	if p.Cancel(big.id) {
		t.Fatal("sync transfer cancelled")
	}
	if !p.Cancel(tr.id) || <-done == nil {
		t.Fatal("manual transfer not cancelled")
	}
	tr.Finish(tctx.Err())
	if v := p.List(TCancelled); len(v) != 1 {
		t.Fatalf("cancelled list %v", v)
	}

	// Bucket: 10 KiB/s from empty, 20 KiB take about two seconds.
	b := NewBucket(10)
	start := time.Now()
	b.Wait(ctx, 10<<10)
	b.Wait(ctx, 10<<10)
	if d := time.Since(start); d < 1600*time.Millisecond || d > 3*time.Second {
		t.Fatalf("bucket took %v", d)
	}
}
