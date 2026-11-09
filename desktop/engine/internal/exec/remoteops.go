package exec

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/tifuck/one.gy/desktop/engine/internal/account"
	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/remote"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
	"onegy/e2ee"
)

// Remote mutations: folder create (client_dedupe_token), move/rename and
// trash with if_seq. A 412 is answered by looking at the current node the
// server sent: when it already is in the desired state the op commits,
// otherwise it is superseded (convergent ops).

func (x *Executor) createRemoteDir(ctx context.Context, j *job) error {
	o := j.rec.Op
	if j.row.State == state.OpPlanned {
		if ok, err := x.matches(o.Path, o.Local); err != nil || !ok {
			return orSuperseded(err)
		}
		parent, err := x.remoteParent(ctx, o.ParentPath, o.ParentRemoteID)
		if err != nil {
			return err
		}
		req, err := x.folderRequest(parent, o.RemoteName)
		if err != nil {
			return err
		}
		j.rec.Folder = req
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		c, err := x.client()
		if err != nil {
			return err
		}
		n, err := c.CreateFolder(ctx, *j.rec.Folder)
		switch {
		case api.IsCode(err, "not_found"):
			return ErrSuperseded
		case api.IsCode(err, "conflict"):
			return issuef("name_clash", o.Path, "one.gy already has a folder with this name here.", "rename", "ignore")
		case err != nil:
			return apiIssue(err, o.Path)
		}
		j.rec.Node = n
		if err := j.set(ctx, state.OpRemoteDone); err != nil {
			return err
		}
	}
	row, err := x.localRow(o.Path, "folder")
	if err != nil {
		return err
	}
	row.RemoteID, row.RemoteName, row.RemoteChangeSeq = j.rec.Node.IDString(), o.RemoteName, j.rec.Node.Seq
	return j.commit(ctx, func(tx *sql.Tx) error {
		if err := storeNode(tx, j.rec.Node); err != nil {
			return err
		}
		return x.putRow(tx, o.Base, row)
	})
}

// folderRequest builds a folder create; E2EE folders get a fresh name key
// wrapped with the master key.
func (x *Executor) folderRequest(parent *int64, name string) (*api.CreateFolderRequest, error) {
	req := &api.CreateFolderRequest{Name: name, ParentID: parent, ClientDedupeToken: "desktop-" + token()}
	if x.s.Encryption != "e2ee" {
		return req, nil
	}
	mk, err := x.env.Acct.MasterKey()
	if err != nil {
		return nil, err
	}
	defer clear(mk)
	nameKey, err := e2ee.RandomBytes(e2ee.KeySize)
	if err != nil {
		return nil, err
	}
	encName, nameNonce, err := e2ee.EncryptName(name, nameKey)
	if err != nil {
		return nil, err
	}
	wrapped, wrapNonce, err := e2ee.WrapKey(nameKey, mk)
	if err != nil {
		return nil, err
	}
	req.Name = "encrypted"
	req.EncryptedName, req.NameNonce = e2ee.EncodeBase64(encName), e2ee.EncodeBase64(nameNonce)
	req.EncryptedNameKey, req.NameKeyNonce = e2ee.EncodeBase64(wrapped), e2ee.EncodeBase64(wrapNonce)
	return req, nil
}

func (x *Executor) moveRemote(ctx context.Context, j *job) error {
	o := j.rec.Op
	if j.row.State == state.OpPlanned {
		j.rec.Seq = o.RemoteSeq
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		parent, err := x.remoteParent(ctx, o.ParentPath, o.ParentRemoteID)
		if err != nil {
			return err
		}
		if err := x.moveSteps(ctx, j, parent); err != nil {
			return err
		}
		if err := j.set(ctx, state.OpRemoteDone); err != nil {
			return err
		}
	}
	if err := x.linkMoved(ctx, j); err != nil {
		return err
	}
	return j.commit(ctx, func(tx *sql.Tx) error {
		if err := storeNode(tx, j.rec.Node); err != nil {
			return err
		}
		r, err := x.baseRow(tx, o.Base)
		if err != nil || r == nil {
			return err // folder merges have no row
		}
		if err := state.MoveSynced(tx, x.s.ID, r.RelPath, o.Path); err != nil {
			return err
		}
		r.RelPath, r.RemoteName = o.Path, o.RemoteName
		if j.rec.Node != nil {
			r.RemoteChangeSeq = j.rec.Node.Seq
		}
		return state.PutSynced(tx, r)
	})
}

// moveSteps moves and/or renames the node until it sits under parent with
// the desired name. Each step's answer is cached and journaled at once.
func (x *Executor) moveSteps(ctx context.Context, j *job, parent *int64) error {
	o := j.rec.Op
	c, err := x.client()
	if err != nil {
		return err
	}
	for step := 0; step < 3; step++ {
		n, err := x.node(ctx, o.EntryKind, o.RemoteID)
		if err != nil {
			return err
		}
		if n == nil || n.IsTrashed {
			return ErrSuperseded
		}
		name, ok := x.env.Tree.DisplayName(n)
		if !ok {
			return issuef("integrity", o.Path, "The one.gy name of this item cannot be decrypted.", "ignore")
		}
		var res *api.Node
		seq := &j.rec.Seq
		if j.rec.Seq == 0 {
			seq = nil
		}
		switch {
		case !sameParent(n.ParentID, parent):
			if o.EntryKind == localfs.KindDir {
				id, _ := strconv.ParseInt(o.RemoteID, 10, 64)
				if cyc, cerr := x.insideFolder(ctx, parent, id); cerr != nil || cyc {
					return orErr(cerr, ErrRemoteCycle)
				}
				res, err = c.MoveFolder(ctx, id, parent, seq)
			} else {
				res, err = c.MoveFile(ctx, o.RemoteID, parent, seq)
			}
		case name != o.RemoteName:
			req, rerr := x.renameRequest(n, o.RemoteName)
			if rerr != nil {
				return rerr
			}
			req.IfSeq = seq
			if o.EntryKind == localfs.KindDir {
				id, _ := strconv.ParseInt(o.RemoteID, 10, 64)
				res, err = c.RenameFolder(ctx, id, req)
			} else {
				res, err = c.RenameFile(ctx, o.RemoteID, req)
			}
		default:
			return nil
		}
		if api.IsCode(err, "precondition_failed") {
			cur := currentNode(err)
			if cur != nil && sameParent(cur.Parent(), parent) {
				if cname, ok := x.env.Tree.DisplayName(remote.ToState(cur)); ok && cname == o.RemoteName {
					j.rec.Node = cur
					return nil
				}
			}
			return ErrSuperseded
		}
		if api.IsCode(err, "not_found") {
			return ErrSuperseded
		}
		if api.IsCode(err, "conflict") {
			return issuef("name_clash", o.Path, "one.gy already has an item with this name there.", "rename", "ignore")
		}
		if err != nil {
			return apiIssue(err, o.Path)
		}
		j.rec.Node, j.rec.Seq = res, res.Seq
		if err := x.storeNodeNow(ctx, res); err != nil {
			return err
		}
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	return ErrSuperseded
}

// ErrRemoteCycle: the folder would move into its own subtree on one.gy
// (it was moved the other way round there). The caller lets the one.gy
// location win.
var ErrRemoteCycle = errors.New("folder moves cross on this computer and one.gy")

// insideFolder reports whether folder id is target or one of its ancestors.
func (x *Executor) insideFolder(ctx context.Context, target *int64, id int64) (bool, error) {
	for depth := 0; target != nil && depth < 1000; depth++ {
		if *target == id {
			return true, nil
		}
		n, err := x.env.DB.GetNode(ctx, "folder", strconv.FormatInt(*target, 10))
		if err != nil || n == nil {
			return false, err
		}
		target = n.ParentID
	}
	return false, nil
}

func orErr(err, fallback error) error {
	if err != nil {
		return err
	}
	return fallback
}

func sameParent(a, b *int64) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// currentNode extracts the node a 409/412 answer carries.
func currentNode(err error) *api.Node {
	var e *api.Error
	if !errors.As(err, &e) || len(e.Current) == 0 {
		return nil
	}
	var n api.Node
	if json.Unmarshal(e.Current, &n) != nil || n.Type == "" {
		return nil
	}
	return &n
}

// renameRequest encrypts the new name with the node's own key (file key or
// folder name key); standard nodes send the plain name.
func (x *Executor) renameRequest(n *state.RemoteNode, name string) (api.RenameRequest, error) {
	if !n.IsE2E {
		return api.RenameRequest{Name: name}, nil
	}
	k, err := x.env.Tree.Key(n)
	if err != nil {
		return api.RenameRequest{}, keyIssue(err)
	}
	enc, nonce, err := e2ee.EncryptName(name, k)
	if err != nil {
		return api.RenameRequest{}, err
	}
	req := api.RenameRequest{EncryptedName: e2ee.EncodeBase64(enc), NameNonce: e2ee.EncodeBase64(nonce)}
	if n.Kind == "file" {
		ext := ""
		if !x.s.HideExtensions {
			ext = e2ee.ExtractExtension(name)
		}
		req.StoredExtension = &ext
	}
	return req, nil
}

func (x *Executor) trashRemote(ctx context.Context, j *job) error {
	o := j.rec.Op
	if j.row.State == state.OpPlanned {
		if o.Base != nil { // driven by a local delete: has the item come back?
			if in, ok, err := x.stat(o.Path); err != nil {
				return err
			} else if ok && in.Kind == o.EntryKind {
				return ErrSuperseded
			}
		}
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		c, err := x.client()
		if err != nil {
			return err
		}
		seq := &o.RemoteSeq
		if o.RemoteSeq == 0 {
			seq = nil
		}
		var n *api.Node
		if o.EntryKind == localfs.KindDir {
			id, _ := strconv.ParseInt(o.RemoteID, 10, 64)
			n, err = c.TrashFolder(ctx, id, seq)
		} else {
			n, err = c.TrashFile(ctx, o.RemoteID, seq)
		}
		switch {
		case api.IsCode(err, "precondition_failed"):
			cur := currentNode(err)
			if cur == nil || !cur.IsTrashed {
				return ErrSuperseded
			}
			n = cur
		case api.IsCode(err, "not_found"):
			n = nil // already gone
		case err != nil:
			return apiIssue(err, o.Path)
		}
		j.rec.Node = n
		if err := j.set(ctx, state.OpRemoteDone); err != nil {
			return err
		}
	}
	return j.commit(ctx, func(tx *sql.Tx) error {
		if err := storeNode(tx, j.rec.Node); err != nil {
			return err
		}
		if j.rec.Node == nil {
			kind := "file"
			if o.EntryKind == localfs.KindDir {
				kind = "folder"
			}
			if err := state.DeleteNode(tx, kind, o.RemoteID); err != nil {
				return err
			}
		}
		r, err := state.SyncedByRemote(tx, x.s.ID, o.RemoteID)
		if err != nil || r == nil {
			return err
		}
		return state.DeleteSynced(tx, x.s.ID, r.RelPath, true)
	})
}

// keyIssue: a key that no longer unwraps means the master key changed.
func keyIssue(err error) error {
	if errors.Is(err, account.ErrLocked) || errors.Is(err, account.ErrNotSignedIn) {
		return err
	}
	return issuef("integrity", "", "A one.gy key cannot be unwrapped on this computer ("+err.Error()+"); re-authorize this device.", "retry")
}
