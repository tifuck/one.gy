package remote

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"strconv"

	"github.com/tifuck/one.gy/client/e2ee"
	"github.com/tifuck/one.gy/client/internal/account"
	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/state"
	"golang.org/x/crypto/hkdf"
)

// The key tree (sync-api.md "Key tree") lets a locked engine reach the keys
// of its sync folders without the master key. Every folder has a random
// folder key, wrapped under the folder key of TreeParent (0 = the root key,
// HKDF of the master key); a folder's name key and a file's key are wrapped
// under folder keys too. While locked the engine holds only the folder keys
// of its sync roots (account.TreeKey), so nothing outside them decrypts.
//
// The tree is an index derived from the master-key wraps, which stay the
// source of truth: anything missing or stale (the website never writes tree
// wraps) is rebuilt by Backfill while the app is unlocked, and until then the
// node waits (account.ErrNeedsUnlock) instead of failing.

const maxTreeDepth = 1000

// RootKey derives the root folder key from the master key.
func RootKey(mk []byte) []byte {
	k := make([]byte, e2ee.KeySize)
	io.ReadFull(hkdf.New(sha256.New, mk, nil, []byte("onegy-tree-root-v1")), k)
	return k
}

// NewKey returns a fresh key with its master-key wrap (pooled while locked)
// and remembers it, so the node it goes to is readable at once.
func (t *Tree) NewKey(ctx context.Context) (*account.NewKey, error) {
	k, err := t.acct.NewKey(ctx)
	if err == nil {
		t.keys.put(k.Wrap, k.Key)
	}
	return k, err
}

// FolderKey returns the folder key of folder id (0 = root).
func (t *Tree) FolderKey(ctx context.Context, id int64) ([]byte, error) {
	return t.folderKey(ctx, id, 0)
}

// With the master key in memory every folder key is derived from the
// server's wraps (the source of truth, so Backfill never builds on a stale
// key); only a locked engine starts from the scope keys it holds.
func (t *Tree) folderKey(ctx context.Context, id int64, depth int) ([]byte, error) {
	mk, err := t.acct.MasterKey()
	full := err == nil
	if !full {
		if k, ok := t.acct.TreeKey(id); ok {
			return k, nil
		}
	}
	if id == 0 {
		if !full {
			return nil, err
		}
		defer clear(mk)
		return RootKey(mk), nil
	}
	clear(mk)
	if depth > maxTreeDepth {
		return nil, fmt.Errorf("key tree too deep at folder %d", id)
	}
	n, err := t.db.GetNode(ctx, "folder", strconv.FormatInt(id, 10))
	if err != nil {
		return nil, err
	}
	if n == nil || n.TreeWrap == "" {
		return nil, account.ErrNeedsUnlock
	}
	cacheKey := "fk:" + n.ID + ":" + n.TreeWrap
	if k, ok := t.keys.get(cacheKey); ok {
		return k, nil
	}
	pk, err := t.folderKey(ctx, treeParent(n.TreeParent), depth+1)
	if err != nil {
		return nil, err
	}
	k, err := e2ee.UnwrapKeyB64(n.TreeWrap, n.TreeNonce, pk)
	if err != nil {
		return nil, account.ErrNeedsUnlock // stale: rebuilt by Backfill
	}
	t.keys.put(cacheKey, k)
	return k, nil
}

func treeParent(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// treeNodeKey is Key without the master key.
func (t *Tree) treeNodeKey(n *state.RemoteNode) ([]byte, error) {
	ctx := context.Background()
	wrap, nonce, under := n.TreeWrap, n.TreeNonce, treeParent(n.TreeParent)
	if n.Kind == "folder" {
		id, _ := strconv.ParseInt(n.ID, 10, 64)
		wrap, nonce, under = n.TreeNameWrap, n.TreeNameNonce, id
		if n.TreeWrap == "" {
			return nil, account.ErrNeedsUnlock
		}
	}
	if wrap == "" {
		return nil, account.ErrNeedsUnlock
	}
	fk, err := t.FolderKey(ctx, under)
	if err != nil {
		return nil, err
	}
	k, err := e2ee.UnwrapKeyB64(wrap, nonce, fk)
	if err != nil {
		return nil, account.ErrNeedsUnlock
	}
	return k, nil
}

func wrapB64(key, under []byte) (string, string, error) {
	w, n, err := e2ee.WrapKey(key, under)
	if err != nil {
		return "", "", err
	}
	return e2ee.EncodeBase64(w), e2ee.EncodeBase64(n), nil
}

// WrapNew adds a node this engine just created to the key tree (key = the
// file key, or the folder's name key, nil for standard folders), so it stays
// reachable while locked. Best effort: on any failure the node is returned as
// it was and Backfill adds it later.
func (t *Tree) WrapNew(ctx context.Context, n *api.Node, key []byte) *api.Node {
	if n == nil {
		return n
	}
	under := treeParent(n.Parent())
	pk, err := t.FolderKey(ctx, under)
	if err != nil {
		return n
	}
	c, err := t.acct.Client()
	if err != nil {
		return n
	}
	var res *api.TreeKeysResponse
	if n.Type == "folder" {
		id, _ := strconv.ParseInt(n.IDString(), 10, 64)
		item, err := folderKeys(id, under, pk, n.TreeKeyWrap, nil, key)
		if err != nil {
			return n
		}
		res, err = c.SetTreeKeys(ctx, []api.TreeFolderKeys{item}, nil)
		if err == nil && len(res.Folders) == 1 {
			return &res.Folders[0]
		}
	} else if n.IsE2E && key != nil {
		w, nonce, err := wrapB64(key, pk)
		if err != nil {
			return n
		}
		res, err = c.SetTreeKeys(ctx, nil, []api.TreeFileKeys{{ID: n.IDString(), Wrap: w, Nonce: nonce, Folder: under}})
		if err == nil && len(res.Files) == 1 {
			return &res.Files[0]
		}
	}
	if err != nil {
		slog.Debug("key tree wrap not stored", "node", n.IDString(), "err", err)
	}
	return n
}

// folderKeys builds a folder's wraps: its folder key fk (a new random one
// when nil) under the parent key pk, and its name key (when it has one).
// current is the wrap the server has, the compare-and-set guard.
func folderKeys(id, under int64, pk []byte, current string, fk, nameKey []byte) (api.TreeFolderKeys, error) {
	item := api.TreeFolderKeys{ID: id, Parent: &under, IfTreeKeyWrap: &current}
	if current == "" {
		item.IfTreeKeyWrap = nil
	}
	if fk == nil {
		var err error
		if fk, err = e2ee.RandomBytes(e2ee.KeySize); err != nil {
			return item, err
		}
	}
	var err error
	if item.Wrap, item.Nonce, err = wrapB64(fk, pk); err != nil {
		return item, err
	}
	if nameKey != nil {
		if item.NameWrap, item.NameNonce, err = wrapB64(nameKey, fk); err != nil {
			return item, err
		}
	}
	return item, nil
}

// Backfill makes the key tree complete and current for the given sync roots
// (nil entry = the whole drive), their ancestors and everything below them.
// Needs the master key and an unlocked app (writes outside the scope). Folders
// go parents first, one level per request, so children are wrapped under the
// folder key the server kept. Returns how many wraps it stored.
func (t *Tree) Backfill(ctx context.Context, roots []*int64) (int, error) {
	mk, err := t.acct.MasterKey()
	if err != nil {
		return 0, err
	}
	clear(mk)
	c, err := t.acct.Client()
	if err != nil {
		return 0, err
	}
	folders, files, err := t.backfillSet(ctx, roots)
	if err != nil {
		return 0, err
	}
	stored := 0
	send := func(fs []api.TreeFolderKeys, fl []api.TreeFileKeys) error {
		for len(fs)+len(fl) > 0 {
			nf, nl := min(len(fs), 500), min(len(fl), 500-min(len(fs), 500))
			res, err := c.SetTreeKeys(ctx, fs[:nf], fl[:nl])
			if err != nil {
				return err
			}
			for i := range res.Folders {
				if _, err := t.Store(ctx, &res.Folders[i]); err != nil {
					return err
				}
			}
			for i := range res.Files {
				if _, err := t.Store(ctx, &res.Files[i]); err != nil {
					return err
				}
			}
			stored += nf + nl - len(res.Conflicts)
			fs, fl = fs[nf:], fl[nl:]
		}
		return nil
	}
	// Folders by depth (backfillSet orders them parents first).
	depthOf := map[int64]int{}
	var level []api.TreeFolderKeys
	lastDepth := -1
	for _, f := range folders {
		id, _ := strconv.ParseInt(f.ID, 10, 64)
		d := depthOf[treeParent(f.ParentID)] + 1
		depthOf[id] = d
		if d != lastDepth && len(level) > 0 {
			if err := send(level, nil); err != nil {
				return stored, err
			}
			level = nil
		}
		lastDepth = d
		fresh, err := t.db.GetNode(ctx, "folder", f.ID)
		if err != nil || fresh == nil {
			continue
		}
		item, ok, err := t.folderFix(ctx, id, fresh)
		if err != nil {
			return stored, err
		}
		if ok {
			level = append(level, item)
		}
	}
	if err := send(level, nil); err != nil {
		return stored, err
	}
	var fl []api.TreeFileKeys
	for _, f := range files {
		if !f.IsE2E || f.EncryptedKey == "" {
			continue
		}
		under := treeParent(f.ParentID)
		pk, err := t.FolderKey(ctx, under)
		if err != nil {
			continue
		}
		if f.TreeWrap != "" && treeParent(f.TreeParent) == under {
			if _, err := e2ee.UnwrapKeyB64(f.TreeWrap, f.TreeNonce, pk); err == nil {
				continue
			}
		}
		key, err := t.masterUnwrap(f.EncryptedKey, f.KeyNonce)
		if err != nil {
			continue // a broken master-key wrap is the sync's integrity issue, not ours
		}
		w, nonce, err := wrapB64(key, pk)
		if err != nil {
			return stored, err
		}
		fl = append(fl, api.TreeFileKeys{ID: f.ID, Wrap: w, Nonce: nonce, Folder: under})
	}
	return stored, send(nil, fl)
}

// folderFix returns the wraps folder n needs (ok false: it is current): a
// folder key under its current parent (the old one kept when it still
// opens, else a new one) and its name key under the folder key.
func (t *Tree) folderFix(ctx context.Context, id int64, n *state.RemoteNode) (api.TreeFolderKeys, bool, error) {
	under := treeParent(n.ParentID)
	pk, err := t.FolderKey(ctx, under)
	if err != nil {
		return api.TreeFolderKeys{}, false, err
	}
	fk, fkErr := t.FolderKey(ctx, id)
	current := fkErr == nil && treeParent(n.TreeParent) == under
	var nameKey []byte
	if n.IsE2E && n.EncryptedKey != "" {
		if nameKey, err = t.masterUnwrap(n.EncryptedKey, n.KeyNonce); err != nil {
			nameKey = nil
		}
	}
	nameOK := nameKey == nil
	if !nameOK && fkErr == nil && n.TreeNameWrap != "" {
		_, err := e2ee.UnwrapKeyB64(n.TreeNameWrap, n.TreeNameNonce, fk)
		nameOK = err == nil
	}
	if current && nameOK {
		return api.TreeFolderKeys{}, false, nil
	}
	if current {
		item := api.TreeFolderKeys{ID: id}
		item.NameWrap, item.NameNonce, err = wrapB64(nameKey, fk)
		return item, true, err
	}
	if fkErr != nil {
		fk = nil // unreachable: start a new folder key; its children follow
	}
	item, err := folderKeys(id, under, pk, n.TreeWrap, fk, nameKey)
	return item, true, err
}

func (t *Tree) masterUnwrap(wrap, nonce string) ([]byte, error) {
	if k, ok := t.keys.get(wrap); ok {
		return k, nil
	}
	mk, err := t.acct.MasterKey()
	if err != nil {
		return nil, err
	}
	defer clear(mk)
	k, err := e2ee.UnwrapKeyB64(wrap, nonce, mk)
	if err == nil {
		t.keys.put(wrap, k)
	}
	return k, err
}

// backfillSet lists the folders (parents first) and files Backfill covers.
func (t *Tree) backfillSet(ctx context.Context, roots []*int64) ([]*state.RemoteNode, []*state.RemoteNode, error) {
	seen := map[string]bool{}
	var folders, files []*state.RemoteNode
	addFolder := func(n *state.RemoteNode) {
		if !seen["d"+n.ID] {
			seen["d"+n.ID] = true
			folders = append(folders, n)
		}
	}
	for _, r := range roots {
		if r != nil {
			// Ancestors (top first), so the root's own key is reachable.
			var chain []*state.RemoteNode
			for id, depth := r, 0; id != nil && depth < maxTreeDepth; depth++ {
				n, err := t.Folder(ctx, id)
				if err != nil {
					return nil, nil, err
				}
				chain = append([]*state.RemoteNode{n}, chain...)
				id = n.ParentID
			}
			for _, n := range chain {
				addFolder(n)
			}
		}
		fs, fl, err := t.db.Subtree(ctx, r)
		if err != nil {
			return nil, nil, err
		}
		for _, n := range fs {
			addFolder(n)
		}
		for _, n := range fl {
			if !seen["f"+n.ID] {
				seen["f"+n.ID] = true
				files = append(files, n)
			}
		}
	}
	// Parents first across roots as well: a stable order by depth.
	depth := map[string]int{}
	var d func(n *state.RemoteNode, guard int) int
	byID := map[string]*state.RemoteNode{}
	for _, n := range folders {
		byID[n.ID] = n
	}
	d = func(n *state.RemoteNode, guard int) int {
		if v, ok := depth[n.ID]; ok {
			return v
		}
		v := 1
		if n.ParentID != nil && guard < maxTreeDepth {
			if p := byID[strconv.FormatInt(*n.ParentID, 10)]; p != nil {
				v = d(p, guard+1) + 1
			}
		}
		depth[n.ID] = v
		return v
	}
	sort.SliceStable(folders, func(i, j int) bool { return d(folders[i], 0) < d(folders[j], 0) })
	return folders, files, nil
}

// ScopeKeys returns the folder keys a locked engine keeps: one per sync root
// (0 = the whole drive). Roots whose key is not reachable yet are left out
// (their syncs wait for the next unlock).
func (t *Tree) ScopeKeys(ctx context.Context, roots []*int64) map[int64][]byte {
	out := map[int64][]byte{}
	for _, r := range roots {
		id := treeParent(r)
		k, err := t.FolderKey(ctx, id)
		if err != nil {
			if !errors.Is(err, account.ErrNeedsUnlock) {
				slog.Warn("sync root key not reachable", "folder", id, "err", err)
			}
			continue
		}
		out[id] = append([]byte(nil), k...)
	}
	return out
}
