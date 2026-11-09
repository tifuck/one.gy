package exec

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/reconcile"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
	"onegy/e2ee"
)

// Upload pipeline (plan 7.5): snapshot read -> plaintext SHA-256 while each
// chunk is encrypted once into .onegy/spool/<op>/<i> (fsynced) -> re-stat;
// a file that changed is not uploaded. Containers up to small_upload_max go
// in one request, larger ones through a resumable session whose parts are
// always resent from the spool. Nonce rule: the spool holds the only
// encryption under its base nonce; when a part is lost the session starts
// over with a fresh encryption (new base nonce).

// upState is the journaled state of an upload.
type upState struct {
	Mode         string            `json:"mode"`   // e2ee | standard
	Fields       map[string]string `json:"fields"` // request fields (sync-api.md "Uploads"), upload_id excluded
	Size         int64             `json:"size"`   // snapshot
	MtimeNs      int64             `json:"mtime_ns"`
	FID          string            `json:"fid"`
	FileMode     uint32            `json:"file_mode"`
	SHA256       string            `json:"sha256"` // plaintext
	CipherSize   int64             `json:"cipher_size"`
	CipherSHA256 string            `json:"cipher_sha256"`
	Chunks       int               `json:"chunks"`
	Header       string            `json:"header,omitempty"` // b64 container header (e2ee)
	ThumbNonce   string            `json:"thumb_nonce,omitempty"`
}

var errRestart = errors.New("upload spool lost; starting over")

func (x *Executor) upload(ctx context.Context, j *job) (err error) {
	o := j.rec.Op
	t, tctx := x.env.Pool.Begin(ctx, x.s.ID, Up, o.Path, o.Size, false, x.s.Up)
	defer func() { t.Finish(err) }()
	return x.uploadSteps(tctx, j, t)
}

func (x *Executor) uploadSteps(ctx context.Context, j *job, t *Transfer) error {
	if err := t.Start(ctx); err != nil {
		return err
	}
	o := j.rec.Op
	for restarts := 0; ; restarts++ {
		if j.row.State == state.OpPlanned {
			src := sourceFile{abs: x.abs(o.Path), expect: o.Local, fsKind: x.s.FSKind}
			up, err := x.prepareUpload(ctx, j.rec, src, x.spoolDir(j.row.ID))
			if err != nil {
				return err
			}
			j.rec.Up = up
			if err := j.set(ctx, state.OpStaged); err != nil {
				return err
			}
		}
		if j.row.State != state.OpStaged {
			break
		}
		node, err := x.send(ctx, j.row.ID, j.rec.UploadID, j.rec.Up, x.spoolDir(j.row.ID), t)
		if errors.Is(err, errRestart) && restarts == 0 {
			x.cleanup(j.row.ID)
			j.row.State = state.OpPlanned
			continue
		}
		if err != nil {
			return x.uploadError(err, o.Path)
		}
		want := j.rec.FileID
		if o.RemoteID != "" {
			want = o.RemoteID
		}
		if node.IDString() != want {
			return issuef("integrity", o.Path, "one.gy answered the upload with another file.", "retry")
		}
		j.rec.Node = node
		if err := j.set(ctx, state.OpRemoteDone); err != nil {
			return err
		}
		break
	}
	linked, err := x.linkNode(ctx, j.rec.Node)
	if err != nil {
		return err
	}
	j.rec.Node = linked
	up, n := j.rec.Up, j.rec.Node
	// A repeated upload_id answers with the file as it is now, which may
	// already be newer than this upload: record the version this upload
	// made, so the next pass sees the later change.
	ours := int64(1)
	if o.RemoteID != "" {
		ours = o.ContentVersion + 1
	}
	if n.ContentVersion < ours {
		return issuef("integrity", o.Path, "one.gy reported an older version than the one just uploaded.", "retry")
	}
	row := &state.SyncedRow{RelPath: o.Path, Kind: "file", RemoteID: n.IDString(), LocalFID: up.FID, Size: up.Size, MtimeNs: up.MtimeNs,
		PlainSHA256: up.SHA256, RemoteContentVersion: ours, RemoteChangeSeq: n.Seq, Mode: int64(up.FileMode), RemoteName: o.RemoteName}
	return j.commit(ctx, func(tx *sql.Tx) error {
		if err := storeNode(tx, n); err != nil {
			return err
		}
		if n.ContentVersion == ours {
			if err := state.PutRemoteHash(tx, n.IDString(), n.PayloadChecksum, up.SHA256); err != nil {
				return err
			}
		}
		if o.RemoteID != "" {
			if err := x.keepName(tx, o.Base, row); err != nil {
				return err
			}
		}
		return x.putRow(tx, o.Base, row)
	})
}

func (x *Executor) uploadError(err error, p string) error {
	switch {
	case api.IsCode(err, "conflict"), api.IsCode(err, "not_found"):
		return ErrSuperseded // changed on one.gy (409 replace) or target gone: re-plan
	}
	return apiIssue(err, p)
}

// sourceFile is what gets uploaded: a path and the state it must still have.
type sourceFile struct {
	abs    string
	expect *reconcile.Expect // nil = whatever is there now (manual uploads)
	fsKind string
}

// prepareUpload resolves the target, spools the encrypted snapshot and
// builds the request fields.
func (x *Executor) prepareUpload(ctx context.Context, rec *record, src sourceFile, dir string) (*upState, error) {
	o := rec.Op
	up := &upState{Mode: x.s.Encryption, Fields: map[string]string{}}
	var key []byte
	fileID := rec.FileID
	cv := int64(1)
	if o.RemoteID != "" { // replace: keep the file key and the node's mode
		n, err := x.node(ctx, localfs.KindFile, o.RemoteID)
		if err != nil {
			return nil, err
		}
		if n == nil || n.IsTrashed || n.ContentVersion != o.ContentVersion {
			return nil, ErrSuperseded
		}
		up.Mode, fileID, cv = "standard", o.RemoteID, o.ContentVersion+1
		if n.IsE2E {
			up.Mode = "e2ee"
			if key, err = x.env.Tree.Key(n); err != nil {
				return nil, keyIssue(err)
			}
		}
		up.Fields["replace_file_id"] = o.RemoteID
		up.Fields["base_content_version"] = strconv.FormatInt(o.ContentVersion, 10)
	} else {
		parent, err := x.remoteParent(ctx, o.ParentPath, o.ParentRemoteID)
		if err != nil {
			return nil, err
		}
		if parent != nil {
			up.Fields["folder_id"] = strconv.FormatInt(*parent, 10)
		}
		up.Fields["file_id"] = fileID
		if up.Mode == "e2ee" {
			if key, err = x.newFileFields(up.Fields, o.RemoteName); err != nil {
				return nil, err
			}
		} else {
			up.Fields["name"] = o.RemoteName
		}
	}
	up.Fields["mode"] = up.Mode
	caps, err := x.env.Caps(ctx)
	if err != nil {
		return nil, err
	}
	if err := x.spool(ctx, src, key, caps.ChunkSize, dir, up); err != nil {
		return nil, err
	}
	if up.Mode == "e2ee" {
		meta, nonce, err := e2ee.EncryptMeta(e2ee.Meta{FileID: fileID, ContentVersion: cv, PlainSize: up.Size, PlainSHA256: up.SHA256,
			MtimeNs: up.MtimeNs, Mode: up.FileMode}, key)
		if err != nil {
			return nil, err
		}
		up.Fields["encrypted_meta"], up.Fields["meta_nonce"] = meta, nonce
		if x.s.Thumbnails {
			up.ThumbNonce = writeThumbnail(src.abs, up.Size, key, filepath.Join(dir, "thumb"))
		}
	}
	if up.CipherSize > caps.MaxUpload && caps.MaxUpload > 0 {
		return nil, issuef("too_large", o.Path, "This file is larger than one.gy accepts.", "ignore")
	}
	return up, nil
}

// newFileFields adds the key and name fields of a new E2EE file and returns
// its fresh file key.
func (x *Executor) newFileFields(f map[string]string, name string) ([]byte, error) {
	mk, err := x.env.Acct.MasterKey()
	if err != nil {
		return nil, err
	}
	defer clear(mk)
	key, err := e2ee.RandomBytes(e2ee.KeySize)
	if err != nil {
		return nil, err
	}
	wrapped, wnonce, err := e2ee.WrapKey(key, mk)
	if err != nil {
		return nil, err
	}
	encName, nnonce, err := e2ee.EncryptName(name, key)
	if err != nil {
		return nil, err
	}
	f["encrypted_file_key"], f["file_key_nonce"] = e2ee.EncodeBase64(wrapped), e2ee.EncodeBase64(wnonce)
	f["encrypted_name"], f["name_nonce"] = e2ee.EncodeBase64(encName), e2ee.EncodeBase64(nnonce)
	f["stored_extension"] = ""
	if !x.s.HideExtensions {
		f["stored_extension"] = e2ee.ExtractExtension(name)
	}
	return key, nil
}

// spool writes the snapshot of src into dir: E2EE as header + one framed
// chunk per part, standard as plaintext parts of chunkSize. It fails with
// ErrSuperseded when the file is not (or no longer) the expected one.
func (x *Executor) spool(ctx context.Context, src sourceFile, key []byte, chunkSize int64, dir string, up *upState) error {
	f, err := localfs.OpenForSnapshot(src.abs)
	if err != nil {
		if localfs.IsLocked(err) {
			return ErrSuperseded // retried after the quiet period
		}
		return permIssue(err, filepath.Base(src.abs))
	}
	defer f.Close()
	before, err := localfs.Fstat(f)
	if err != nil {
		return err
	}
	if !localfs.IdentityStable(src.fsKind) {
		before.ID = ""
	}
	if before.Kind != localfs.KindFile || (src.expect != nil && !sameEntry(before, src.expect, src.fsKind)) {
		return ErrSuperseded
	}
	if err := x.checkSpace(before.Size); err != nil {
		return err
	}
	os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	plain := sha256.New()
	sw := &splitWriter{dir: dir, header: up.Mode == "e2ee", h: sha256.New()}
	r := io.TeeReader(&ctxReader{ctx, f}, plain)
	if up.Mode == "e2ee" {
		err = e2ee.EncryptStream(r, sw, key, before.Size)
	} else {
		err = sw.plainParts(r, before.Size, chunkSize)
	}
	if cerr := sw.close(); err == nil {
		err = cerr
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		os.RemoveAll(dir)
		if errors.Is(err, errShort) || bytes.Contains([]byte(err.Error()), []byte("changed during upload")) {
			return ErrSuperseded
		}
		return err
	}
	after, err := localfs.Fstat(f)
	if err != nil {
		return err
	}
	now, err := localfs.Lstat(src.abs)
	if err != nil || after.Size != before.Size || after.MtimeNs != before.MtimeNs || now.Size != before.Size ||
		now.MtimeNs != before.MtimeNs || (localfs.IdentityStable(src.fsKind) && now.ID != after.ID) {
		os.RemoveAll(dir)
		return ErrSuperseded // changed while being read: retried after the quiet period
	}
	if err := localfs.SyncDir(dir); err != nil {
		return err
	}
	up.Size, up.MtimeNs, up.FID, up.FileMode = before.Size, before.MtimeNs, string(before.ID), before.Mode
	up.SHA256 = hex.EncodeToString(plain.Sum(nil))
	up.CipherSize, up.CipherSHA256, up.Chunks = sw.size, hex.EncodeToString(sw.h.Sum(nil)), sw.idx
	if sw.header {
		up.Header = e2ee.EncodeBase64(sw.hdr)
	}
	return nil
}

var errShort = errors.New("source ended early")

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// splitWriter receives an E2EE container (header, then length-prefixed
// chunks) or plaintext parts and writes one fsynced file per part.
type splitWriter struct {
	dir    string
	header bool
	hdr    []byte
	h      hash.Hash
	size   int64
	idx    int
	f      *os.File
	prefix []byte
	need   int64
}

func (w *splitWriter) Write(p []byte) (int, error) {
	n := len(p)
	w.h.Write(p)
	w.size += int64(n)
	for len(p) > 0 {
		switch {
		case w.header && len(w.hdr) < e2ee.HeaderSize:
			k := min(e2ee.HeaderSize-len(w.hdr), len(p))
			w.hdr = append(w.hdr, p[:k]...)
			p = p[k:]
		case w.f == nil:
			k := min(4-len(w.prefix), len(p))
			w.prefix = append(w.prefix, p[:k]...)
			p = p[k:]
			if len(w.prefix) == 4 {
				if err := w.open(); err != nil {
					return 0, err
				}
				if _, err := w.f.Write(w.prefix); err != nil {
					return 0, err
				}
				w.need = int64(binary.BigEndian.Uint32(w.prefix))
				w.prefix = nil
			}
		default:
			k := int(min(w.need, int64(len(p))))
			if _, err := w.f.Write(p[:k]); err != nil {
				return 0, err
			}
			p, w.need = p[k:], w.need-int64(k)
			if w.need == 0 {
				if err := w.closePart(); err != nil {
					return 0, err
				}
			}
		}
	}
	return n, nil
}

func (w *splitWriter) open() error {
	f, err := os.OpenFile(filepath.Join(w.dir, strconv.Itoa(w.idx)), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	w.f = f
	return err
}

func (w *splitWriter) closePart() error {
	err := w.f.Sync()
	if cerr := w.f.Close(); err == nil {
		err = cerr
	}
	w.f = nil
	w.idx++
	return err
}

// plainParts copies exactly size bytes into parts of chunkSize (standard mode).
func (w *splitWriter) plainParts(r io.Reader, size, chunkSize int64) error {
	if chunkSize <= 0 {
		chunkSize = e2ee.ChunkSize
	}
	for left := size; left > 0 || w.idx == 0; {
		n := min(left, chunkSize)
		if err := w.open(); err != nil {
			return err
		}
		k, err := io.CopyN(io.MultiWriter(w.f, w.h), r, n)
		w.size += k
		if err == io.EOF {
			return errShort
		}
		if err != nil {
			return err
		}
		if err := w.closePart(); err != nil {
			return err
		}
		left -= n
	}
	var probe [1]byte
	if k, _ := r.Read(probe[:]); k > 0 {
		return errShort // grew while being read
	}
	return nil
}

func (w *splitWriter) close() error {
	if w.f != nil {
		w.f.Close()
		w.f = nil
		return fmt.Errorf("container ended inside a chunk")
	}
	if w.header {
		if len(w.hdr) != e2ee.HeaderSize {
			return fmt.Errorf("container header missing")
		}
		if err := os.WriteFile(filepath.Join(w.dir, "header"), w.hdr, 0o600); err != nil {
			return err
		}
		return localfs.SyncFile(filepath.Join(w.dir, "header"))
	}
	return nil
}

// part reads spooled part i; a missing part restarts the upload.
func readPart(dir string, i int) ([]byte, error) {
	b, err := os.ReadFile(filepath.Join(dir, strconv.Itoa(i)))
	if errors.Is(err, os.ErrNotExist) {
		return nil, errRestart
	}
	return b, err
}

// send transfers the spool and returns the committed node.
func (x *Executor) send(ctx context.Context, opID int64, uploadID string, up *upState, dir string, t *Transfer) (*api.Node, error) {
	c, err := x.client()
	if err != nil {
		return nil, err
	}
	caps, err := x.env.Caps(ctx)
	if err != nil {
		return nil, err
	}
	var thumb []byte
	if up.ThumbNonce != "" {
		thumb, _ = os.ReadFile(filepath.Join(dir, "thumb"))
	}
	if up.CipherSize <= caps.SmallUploadMax {
		var buf bytes.Buffer
		if up.Mode == "e2ee" {
			hdr, err := e2ee.DecodeBase64(up.Header)
			if err != nil {
				return nil, err
			}
			buf.Write(hdr)
		}
		for i := 0; i < up.Chunks; i++ {
			b, err := readPart(dir, i)
			if err != nil {
				return nil, err
			}
			buf.Write(b)
		}
		if int64(buf.Len()) != up.CipherSize {
			return nil, errRestart
		}
		fields := api.UploadFields{"upload_id": uploadID}
		for k, v := range up.Fields {
			fields[k] = v
		}
		if thumb != nil {
			fields["thumbnail_nonce"] = up.ThumbNonce
		}
		if err := t.Wait(ctx, buf.Len()); err != nil {
			return nil, err
		}
		node, _, err := c.UploadSmall(ctx, fields, buf.Bytes(), thumb)
		if err == nil {
			t.Progress(up.Size)
		}
		return node, err
	}
	return x.sendSession(ctx, c, opID, uploadID, up, dir, thumb, t)
}

func (x *Executor) sendSession(ctx context.Context, c *api.Client, opID int64, uploadID string, up *upState, dir string, thumb []byte, t *Transfer) (*api.Node, error) {
	var sess *state.UploadSession
	if opID > 0 {
		var err error
		if sess, err = x.env.DB.GetUploadSession(ctx, opID); err != nil {
			return nil, err
		}
	}
	var received []int
	if sess != nil && sess.BaseNonce == up.Header {
		st, err := c.SessionStatus(ctx, sess.SessionID)
		switch {
		case api.IsCode(err, "not_found"):
			sess = nil // expired: open again under the same upload_id
		case err != nil:
			return nil, err
		default:
			received = st.PartsReceived
		}
	} else {
		sess = nil
	}
	if sess == nil {
		body := map[string]any{"upload_id": uploadID, "chunk_count": up.Chunks, "cipher_sha256": up.CipherSHA256}
		for k, v := range up.Fields {
			body[k] = v
		}
		if up.Mode == "e2ee" {
			body["cipher_size"], body["header_b64"] = up.CipherSize, up.Header
		} else {
			body["plain_size"] = up.CipherSize
		}
		s, node, err := c.CreateSession(ctx, body)
		if err != nil {
			return nil, err
		}
		if node != nil {
			return node, nil // committed before (lost response)
		}
		sess = &state.UploadSession{OpID: opID, SessionID: s.SessionID, BaseNonce: up.Header, ChunkCount: up.Chunks}
		if opID > 0 {
			if err := x.env.DB.PutUploadSession(ctx, sess); err != nil {
				return nil, err
			}
		}
		received = s.PartsReceived
	}
	have := map[int]bool{}
	var done int64
	for _, i := range received {
		have[i] = true
	}
	for i := 0; i < up.Chunks; i++ {
		b, err := readPart(dir, i)
		if err != nil {
			if errors.Is(err, errRestart) {
				c.AbortSession(ctx, sess.SessionID)
			}
			return nil, err
		}
		if have[i] {
			done += int64(len(b))
			t.SetDone(done)
			continue
		}
		if err := t.Wait(ctx, len(b)); err != nil {
			return nil, err
		}
		if err := c.PutPart(ctx, sess.SessionID, i, b); err != nil {
			if api.IsCode(err, "conflict") { // parts of another encryption: never mix them
				c.AbortSession(ctx, sess.SessionID)
				return nil, errRestart
			}
			return nil, err
		}
		done += int64(len(b))
		t.Progress(int64(len(b)))
	}
	thumbB64 := ""
	if thumb != nil {
		thumbB64 = e2ee.EncodeBase64(thumb)
	}
	node, _, err := c.CompleteSession(ctx, sess.SessionID, thumbB64, up.ThumbNonce)
	if api.IsCode(err, "bad_request") || api.IsCode(err, "not_found") {
		return nil, errRestart // missing parts, or the server aborted the session
	}
	return node, err
}

// checkSpace keeps 256 MiB free besides need bytes (disk_full issue).
func (x *Executor) checkSpace(need int64) error {
	if x.env.FreeSpace == nil {
		return nil
	}
	free, err := x.env.FreeSpace(x.s.Root)
	if err != nil || free >= need+256<<20 {
		return nil
	}
	return issuef("disk_full", "", "The drive is full; syncing waits until space is freed.", "retry")
}
