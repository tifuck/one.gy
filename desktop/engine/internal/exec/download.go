package exec

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/reconcile"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
	"onegy/e2ee"
)

// Download pipeline (plan 7.5): GET /content with If-Match and Range resume
// into .onegy/tmp/<op>.enc, ciphertext SHA-256 == payload_checksum, stream
// decrypt into .onegy/tmp/<op>.plain while hashing, compare with the
// encrypted meta (or backfill it), fsync, mtime/mode from the meta, then the
// target precondition, the old target to debris, and an atomic rename.
// Nothing reaches a target path before it is fully verified.

func (x *Executor) download(ctx context.Context, j *job) (err error) {
	o := j.rec.Op
	t, tctx := x.env.Pool.Begin(ctx, x.s.ID, Down, o.Path, o.Size, false, x.s.Down)
	defer func() { t.Finish(err) }()
	return x.downloadSteps(tctx, j, t)
}

func (x *Executor) downloadSteps(ctx context.Context, j *job, t *Transfer) error {
	o := j.rec.Op
	fresh := j.row.State == state.OpPlanned
	if j.row.State == state.OpPlanned {
		if err := t.Start(ctx); err != nil {
			return err
		}
		n, err := x.node(ctx, localfs.KindFile, o.RemoteID)
		if err != nil {
			return err
		}
		if n == nil || n.IsTrashed || n.PayloadChecksum != o.PayloadChecksum || n.ContentVersion != o.ContentVersion {
			return ErrSuperseded
		}
		plain := x.tmpPath(j.row.ID, ".plain")
		if o.Kind == reconcile.VerifyLink {
			plain = ""
		}
		got, err := x.fetch(t.Observe(ctx), n, x.tmpPath(j.row.ID, ".enc"), plain, t)
		if err != nil {
			return err
		}
		if o.Kind == reconcile.VerifyLink {
			return x.verifyLink(ctx, j, n, got)
		}
		if o.SHA256 != "" && got.sha != o.SHA256 {
			return issuef("integrity", o.Path, "The downloaded file does not match its recorded hash; it was not applied.", "retry", "ignore")
		}
		x.finishPlain(plain, got.meta)
		j.rec.SHA256, j.rec.Seq = got.sha, n.Seq
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		if err := x.place(ctx, j); err != nil {
			return err
		}
		if err := j.set(ctx, state.OpLocalDone); err != nil {
			return err
		}
	} else if !fresh {
		if sum, err := HashFile(x.abs(o.Path)); err != nil || sum != j.rec.SHA256 {
			return orSuperseded(err) // changed after it was placed: the next pass decides
		}
	}
	row, err := x.localRow(o.Path, "file")
	if err != nil {
		return err
	}
	row.RemoteID, row.RemoteName, row.PlainSHA256 = o.RemoteID, o.RemoteName, j.rec.SHA256
	row.RemoteContentVersion, row.RemoteChangeSeq = o.ContentVersion, j.rec.Seq
	return j.commit(ctx, func(tx *sql.Tx) error {
		if j.rec.Debris != "" {
			if err := state.AddDebris(tx, x.s.ID, o.Path, j.rec.Debris, "replaced by a download"); err != nil {
				return err
			}
		}
		if err := state.PutRemoteHash(tx, o.RemoteID, o.PayloadChecksum, j.rec.SHA256); err != nil {
			return err
		}
		if err := x.keepName(tx, o.Base, row); err != nil {
			return err
		}
		return x.putRow(tx, o.Base, row)
	})
}

// place moves the verified temp file to the target, the old target to debris.
func (x *Executor) place(ctx context.Context, j *job) error {
	o := j.rec.Op
	plain := x.tmpPath(j.row.ID, ".plain")
	if _, err := os.Lstat(plain); errors.Is(err, os.ErrNotExist) {
		// Renamed before a crash?
		if sum, err := HashFile(x.abs(o.Path)); err == nil && sum == j.rec.SHA256 {
			return nil
		}
		return ErrSuperseded
	}
	in, there, err := x.stat(o.Path)
	if err != nil {
		return err
	}
	if there && (o.Local == nil || o.Local.Absent || !sameEntry(in, o.Local, x.s.FSKind)) {
		return ErrSuperseded // changed here since the plan: the next pass makes a conflict
	}
	if !x.parentDirOK(o.Path) {
		return ErrSuperseded
	}
	if there {
		d, err := localfs.MoveToDebris(x.s.Root, o.Path, time.Now())
		if err != nil {
			return permIssue(err, o.Path)
		}
		j.rec.Debris = d
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	err = localfs.RenameNoReplace(plain, x.abs(o.Path))
	if errors.Is(err, os.ErrExist) {
		return ErrSuperseded
	}
	return permIssue(err, o.Path)
}

// verifyLink records the remote hash and links when it equals the local one.
func (x *Executor) verifyLink(ctx context.Context, j *job, n *state.RemoteNode, got *fetched) error {
	o := j.rec.Op
	equal := got.sha == o.SHA256
	if equal {
		if ok, err := x.matches(o.Path, o.Local); err != nil || !ok {
			equal = false
		}
	}
	return j.commit(ctx, func(tx *sql.Tx) error {
		if err := state.PutRemoteHash(tx, o.RemoteID, o.PayloadChecksum, got.sha); err != nil {
			return err
		}
		if !equal {
			return nil // the next pass sees the hash and plans a conflict
		}
		return x.linkRow(tx, o, n)
	})
}

type fetched struct {
	sha  string
	meta *e2ee.Meta
}

// fetch downloads and verifies node content. plainPath "" only hashes.
func (x *Executor) fetch(ctx context.Context, n *state.RemoteNode, encPath, plainPath string, t *Transfer) (*fetched, error) {
	c, err := x.client()
	if err != nil {
		return nil, err
	}
	var key []byte
	var meta *e2ee.Meta
	if n.IsE2E {
		if key, err = x.env.Tree.Key(n); err != nil {
			return nil, keyIssue(err)
		}
		if n.EncryptedMeta != "" {
			m, err := e2ee.DecryptMeta(n.EncryptedMeta, n.MetaNonce, key, n.ID, n.ContentVersion)
			if err != nil {
				return nil, issuef("integrity", "", "one.gy sent metadata that does not belong to this file version ("+err.Error()+"); it was not applied.", "retry", "ignore")
			}
			meta = &m
		}
	}
	if err := x.checkSpace(2 * n.CipherSize); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(encPath), 0o700); err != nil {
		return nil, err
	}
	h := sha256.New()
	var out io.Writer = h
	var pf *os.File
	if plainPath != "" {
		if pf, err = os.OpenFile(plainPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err != nil {
			return nil, err
		}
		defer pf.Close()
		out = io.MultiWriter(pf, h)
	}
	if n.IsE2E {
		if err := x.fetchCipher(ctx, c, n, encPath, t); err != nil {
			return nil, err
		}
		t.Phase(PFinishing)
		ef, err := os.Open(encPath)
		if err != nil {
			return nil, err
		}
		plainSize, err := e2ee.DecryptStream(ef, out, key)
		ef.Close()
		if err != nil {
			os.Remove(encPath)
			return nil, issuef("integrity", "", "The downloaded file failed decryption ("+err.Error()+"); it was not applied.", "retry", "ignore")
		}
		if meta != nil && plainSize != meta.PlainSize {
			return nil, issuef("integrity", "", "The downloaded file has the wrong size; it was not applied.", "retry", "ignore")
		}
	} else {
		w := &meter{ctx: ctx, w: out, t: t}
		got, err := c.Content(ctx, n.ID, w, 0, n.PayloadChecksum)
		if api.IsCode(err, "precondition_failed") {
			return nil, ErrSuperseded
		}
		if err != nil {
			return nil, err
		}
		if got != n.CipherSize {
			return nil, fmt.Errorf("download incomplete (%d of %d bytes)", got, n.CipherSize)
		}
		t.Phase(PFinishing)
	}
	if pf != nil {
		if err := pf.Sync(); err != nil {
			return nil, err
		}
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if meta != nil && meta.PlainSHA256 != sum {
		return nil, issuef("integrity", "", "The downloaded file does not match its encrypted metadata; it was not applied.", "retry", "ignore")
	}
	if n.IsE2E && meta == nil {
		x.backfillMeta(ctx, c, n, key, sum, plainSizeOf(plainPath, n))
	}
	return &fetched{sha: sum, meta: meta}, nil
}

func plainSizeOf(p string, n *state.RemoteNode) int64 {
	if p != "" {
		if fi, err := os.Stat(p); err == nil {
			return fi.Size()
		}
	}
	return n.PlainSize
}

// fetchCipher downloads the container into encPath, resuming what is
// there, and checks its SHA-256 against payload_checksum.
func (x *Executor) fetchCipher(ctx context.Context, c *api.Client, n *state.RemoteNode, encPath string, t *Transfer) error {
	f, err := os.OpenFile(encPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	off, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	if off > n.CipherSize {
		if err := f.Truncate(0); err != nil {
			return err
		}
		off, _ = f.Seek(0, io.SeekStart)
	}
	t.SetDone(off)
	for stalls := 0; off < n.CipherSize; {
		got, err := c.Content(ctx, n.ID, &meter{ctx: ctx, w: f, t: t}, off, n.PayloadChecksum)
		off += got
		switch {
		case api.IsCode(err, "precondition_failed"):
			os.Remove(encPath)
			return ErrSuperseded
		case err == nil && off < n.CipherSize:
			err = fmt.Errorf("download ended early (%d of %d bytes)", off, n.CipherSize)
		}
		if err == nil {
			break
		}
		if got == 0 {
			stalls++
		}
		if ctx.Err() != nil || stalls >= 3 || !errors.Is(err, api.ErrOffline) {
			return err
		}
	}
	if err := f.Sync(); err != nil {
		return err
	}
	sum, err := hashOpen(f)
	if err != nil {
		return err
	}
	if sum != n.PayloadChecksum {
		f.Close()
		os.Remove(encPath)
		return fmt.Errorf("downloaded content does not match its checksum")
	}
	return nil
}

// backfillMeta stores encrypted meta for a file uploaded without it
// (browser uploads), so other devices learn its plaintext hash. Best effort.
func (x *Executor) backfillMeta(ctx context.Context, c *api.Client, n *state.RemoteNode, key []byte, sum string, size int64) {
	meta, nonce, err := e2ee.EncryptMeta(e2ee.Meta{FileID: n.ID, ContentVersion: n.ContentVersion, PlainSize: size, PlainSHA256: sum,
		MtimeNs: time.Now().UnixNano(), Mode: 0o644}, key)
	if err != nil {
		return
	}
	res, err := c.SetMeta(ctx, n.ID, meta, nonce, n.ContentVersion)
	if err != nil {
		slog.Debug("meta backfill failed", "file", n.ID, "err", err)
		return
	}
	x.storeNodeNow(ctx, res)
}

// finishPlain applies mtime and the executable bit from the meta.
func (x *Executor) finishPlain(p string, m *e2ee.Meta) {
	mode := os.FileMode(0o644)
	if m != nil && x.s.KeepExecBit && m.Mode&0o100 != 0 {
		mode = 0o755
	}
	os.Chmod(p, mode)
	if m != nil && m.MtimeNs > 0 {
		mt := time.Unix(0, m.MtimeNs)
		os.Chtimes(p, mt, mt)
	}
}

// meter throttles and counts bytes written.
type meter struct {
	ctx context.Context
	w   io.Writer
	t   *Transfer
}

func (m *meter) Write(p []byte) (int, error) {
	if err := m.t.Wait(m.ctx, len(p)); err != nil {
		return 0, err
	}
	n, err := m.w.Write(p)
	m.t.Progress(int64(n))
	return n, err
}

// HashFile returns the SHA-256 (hex) of a file.
func HashFile(p string) (string, error) {
	f, err := localfs.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	return hashOpen(f)
}

func hashOpen(f *os.File) (string, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	var h hash.Hash = sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
