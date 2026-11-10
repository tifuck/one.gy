package exec

import (
	"context"
	"errors"
	"log/slog"
	"path"
	"strconv"

	"github.com/tifuck/one.gy/desktop/engine/internal/account"
	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/remote"
	"onegy/e2ee"
)

// Link-shared folders (sync-api.md "Link-shared folders"): a file the engine
// uploads or moves under a link-shared folder must have its key wrapped for
// that folder's link, or link visitors cannot open it. The server flags such
// nodes (needs_folder_link_key + folder_link_share_token); the executor
// answers before the op commits, so a crash repeats it on recovery.

// linkNode wraps a flagged file's key for its folder link and returns the
// updated node. Only an offline or cancelled request fails (the op stays
// journaled); other answers (the share changed meanwhile) are logged and the
// server keeps flagging the file.
func (x *Executor) linkNode(ctx context.Context, n *api.Node) (*api.Node, error) {
	if n == nil || n.Type != "file" || !n.IsE2E || !n.NeedsFolderLinkKey || n.FolderLinkShareToken == nil {
		return n, nil
	}
	fileKey, err := x.env.Tree.Key(remote.ToState(n))
	if err != nil {
		return n, keyIssue(err)
	}
	mk, err := x.env.Acct.MasterKey()
	if errors.Is(err, account.ErrNeedsUnlock) {
		return n, nil // locked: the link key needs the master key; the website (or a later unlock) backfills it
	}
	if err != nil {
		return n, err
	}
	_, linkKey, err := e2ee.DeriveLinkSecret(mk, "folder", *n.FolderLinkShareToken)
	clear(mk)
	if err != nil {
		return n, err
	}
	wrapped, nonce, err := e2ee.WrapKey(fileKey, linkKey)
	clear(linkKey)
	if err != nil {
		return n, err
	}
	c, err := x.client()
	if err != nil {
		return n, err
	}
	res, err := c.SetFolderLinkKey(ctx, n.IDString(), api.FolderLinkKey{EncryptedFileKey: e2ee.EncodeBase64(wrapped),
		FileKeyNonce: e2ee.EncodeBase64(nonce), ShareToken: *n.FolderLinkShareToken})
	switch {
	case err == nil:
		return res, nil
	case unfinished(err) || ctx.Err() != nil:
		return n, err
	}
	slog.Warn("folder link key not stored", "file", n.IDString(), "err", err)
	return n, nil
}

// linkMoved answers a MoveRemote: the moved file itself, or the files below
// a folder that changed parents (a rename never changes the governing link).
func (x *Executor) linkMoved(ctx context.Context, j *job) error {
	n, o := j.rec.Node, j.rec.Op
	if n == nil {
		return nil
	}
	if n.Type == "file" {
		linked, err := x.linkNode(ctx, n)
		j.rec.Node = linked
		return err
	}
	if o.Base != nil && path.Dir(o.Base.RelPath) == path.Dir(o.Path) {
		return nil
	}
	return x.linkFolder(ctx, n)
}

// linkFolder backfills the flagged files below a folder that a move took
// into a link-shared tree (the move answer is the folder node only).
func (x *Executor) linkFolder(ctx context.Context, n *api.Node) error {
	if n == nil || n.Type != "folder" || n.FolderLinkShareToken == nil {
		return nil
	}
	id, err := strconv.ParseInt(n.IDString(), 10, 64)
	if err != nil {
		return nil
	}
	c, err := x.client()
	if err != nil {
		return err
	}
	for page := ""; ; {
		t, err := c.Tree(ctx, id, page, 0)
		if err != nil {
			if unfinished(err) || ctx.Err() != nil {
				return err
			}
			slog.Warn("folder link keys not checked", "folder", id, "err", err)
			return nil
		}
		for i := range t.Files {
			if _, err := x.linkNode(ctx, &t.Files[i]); err != nil {
				return err
			}
		}
		if t.NextPageToken == "" {
			return nil
		}
		page = t.NextPageToken
	}
}
