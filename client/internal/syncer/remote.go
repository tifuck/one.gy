package syncer

import (
	"context"
	"errors"
	"strconv"

	"github.com/tifuck/one.gy/client/internal/account"

	"github.com/tifuck/one.gy/client/e2ee"
	"github.com/tifuck/one.gy/client/internal/exec"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/state"
)

// RemoteInput builds the reconciler's view of the remote subtree under
// rootID (nil = drive root) from the cache: decrypted names, plaintext hash
// and size from the encrypted meta (or a hash verified by downloading), and
// read-only backup folders of other devices. A node whose meta does not
// verify (other file, older version) is marked undecryptable, so the
// reconciler stalls it with an integrity issue instead of applying it.
func RemoteInput(ctx context.Context, env *exec.Env, deviceID string, rootID *int64) (*reconcile.Remote, error) {
	out := &reconcile.Remote{}
	if rootID != nil {
		out.RootID = strconv.FormatInt(*rootID, 10)
		missing, err := rootMissing(ctx, env.DB, rootID)
		if err != nil {
			return nil, err
		}
		if missing {
			out.RootMissing = true
			return out, nil
		}
	}
	nodes, err := env.DB.SubtreeNodes(ctx, rootID)
	if err != nil {
		return nil, err
	}
	hashes, err := env.DB.RemoteHashes(ctx)
	if err != nil {
		return nil, err
	}
	for _, n := range nodes {
		rn := reconcile.RemoteNode{ID: n.ID, Kind: localfs.KindFile, Seq: n.Seq, ContentVersion: n.ContentVersion,
			PayloadChecksum: n.PayloadChecksum, Size: n.PlainSize}
		if n.ParentID != nil {
			rn.ParentID = strconv.FormatInt(*n.ParentID, 10)
		}
		var nameErr error
		rn.Name, nameErr = env.Tree.Name(n)
		rn.NameOK = nameErr == nil
		rn.NeedsUnlock = errors.Is(nameErr, account.ErrNeedsUnlock)
		if n.Kind == "folder" {
			rn.Kind, rn.Size = localfs.KindDir, 0
			rn.ReadOnly = n.IsBackup && n.BackupDeviceID != deviceID
		} else if n.IsE2E && n.EncryptedMeta != "" && rn.NameOK {
			key, err := env.Tree.Key(n)
			if err == nil {
				var m e2ee.Meta
				if m, err = e2ee.DecryptMeta(n.EncryptedMeta, n.MetaNonce, key, n.ID, n.ContentVersion); err == nil {
					rn.SHA256, rn.Size, rn.Mode = m.PlainSHA256, m.PlainSize, m.Mode
				}
			}
			rn.NameOK = err == nil
			rn.NeedsUnlock = errors.Is(err, account.ErrNeedsUnlock)
		}
		if rn.Kind == localfs.KindFile && rn.SHA256 == "" {
			rn.SHA256 = hashes[[2]string{n.ID, n.PayloadChecksum}]
		}
		out.Nodes = append(out.Nodes, rn)
	}
	return out, nil
}

// trashedBase fills rem.Trashed: the synced items whose node is not in the
// subtree but in the one.gy trash (the reconciler restores those).
func trashedBase(ctx context.Context, db *state.DB, rem *reconcile.Remote, base []*state.SyncedRow) error {
	live := make(map[string]bool, len(rem.Nodes))
	for i := range rem.Nodes {
		live[rem.Nodes[i].ID] = true
	}
	for _, b := range base {
		if b.RemoteID == "" || live[b.RemoteID] {
			continue
		}
		n, err := db.GetNode(ctx, b.Kind, b.RemoteID)
		if err != nil {
			return err
		}
		if n != nil && n.IsTrashed {
			if rem.Trashed == nil {
				rem.Trashed = map[string]int64{}
			}
			rem.Trashed[b.RemoteID] = n.ContentVersion
		}
	}
	return nil
}

// rootMissing: the root folder, or one of its ancestors, is trashed or gone.
func rootMissing(ctx context.Context, db *state.DB, id *int64) (bool, error) {
	for depth := 0; id != nil && depth < 1000; depth++ {
		n, err := db.GetNode(ctx, "folder", strconv.FormatInt(*id, 10))
		if err != nil {
			return false, err
		}
		if n == nil || n.IsTrashed {
			return true, nil
		}
		id = n.ParentID
	}
	return false, nil
}
