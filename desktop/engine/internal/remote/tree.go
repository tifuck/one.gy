// Package remote owns the cached remote tree (plan 7.3-7.4): the initial
// /tree snapshot, incremental /changes (including tombstones and
// cursor_expired resnapshots), name decryption with an LRU of unwrapped keys,
// folder listing and creation, and the adaptive poller.
package remote

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
	"onegy/e2ee"
)

// ErrNotFound means the folder is not in the (non-trashed) remote tree.
var ErrNotFound = errors.New("remote folder not found")

// Keys is the slice of the account the tree needs (account.Manager).
type Keys interface {
	Client() (*api.Client, error)
	MasterKey() ([]byte, error)
}

// Tree is safe for concurrent use; Sync calls are serialised.
type Tree struct {
	db   *state.DB
	acct Keys
	keys *lru

	syncMu sync.Mutex
}

func New(db *state.DB, acct Keys) *Tree {
	return &Tree{db: db, acct: acct, keys: newLRU(4096)}
}

// ResetKeys drops cached unwrapped keys (sign-out, revoke).
func (t *Tree) ResetKeys() { t.keys.clear() }

// Sync brings the cache up to date: a full snapshot when there is no cursor,
// otherwise the change feed. changed reports whether anything was applied.
func (t *Tree) Sync(ctx context.Context) (changed bool, err error) {
	t.syncMu.Lock()
	defer t.syncMu.Unlock()
	c, err := t.acct.Client()
	if err != nil {
		return false, err
	}
	a, err := t.db.GetAccount(ctx)
	if err != nil || a == nil {
		return false, err
	}
	if a.RemoteCursor == nil {
		return true, t.snapshot(ctx, c)
	}
	return t.catchUp(ctx, c, *a.RemoteCursor)
}

// Cursor returns the stored change-feed position (nil before the first snapshot).
func (t *Tree) Cursor(ctx context.Context) (*int64, error) {
	a, err := t.db.GetAccount(ctx)
	if err != nil || a == nil {
		return nil, err
	}
	return a.RemoteCursor, nil
}

func (t *Tree) snapshot(ctx context.Context, c *api.Client) error {
	if err := t.db.ClearSnapshot(ctx); err != nil {
		return err
	}
	var asOf int64
	token := ""
	for page := 0; ; page++ {
		tr, err := c.Tree(ctx, 0, token, 2000)
		if err != nil {
			return err
		}
		if page == 0 {
			asOf = tr.AsOfSeq
		}
		err = t.db.Tx(ctx, func(tx *sql.Tx) error {
			for _, list := range [][]api.Node{tr.Folders, tr.Files} {
				for i := range list {
					if err := state.UpsertNode(tx, "remote_node_snapshot", toState(&list[i])); err != nil {
						return err
					}
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		if tr.NextPageToken == "" {
			break
		}
		if tr.NextPageToken == token {
			return fmt.Errorf("server repeated tree page token")
		}
		token = tr.NextPageToken
	}
	if err := t.db.SwapSnapshot(ctx, asOf); err != nil {
		return err
	}
	slog.Info("remote snapshot complete", "as_of_seq", asOf)
	_, err := t.catchUp(ctx, c, asOf)
	return err
}

func (t *Tree) catchUp(ctx context.Context, c *api.Client, cursor int64) (bool, error) {
	changed := false
	for {
		ch, err := c.Changes(ctx, cursor, 1000)
		if api.IsCode(err, "cursor_expired") {
			slog.Info("change cursor expired, taking a new snapshot", "cursor", cursor)
			return true, t.snapshot(ctx, c)
		}
		if err != nil {
			return changed, err
		}
		if ch.NextCursor < cursor || (ch.HasMore && ch.NextCursor == cursor) {
			return changed, fmt.Errorf("change feed did not advance (cursor %d, next %d)", cursor, ch.NextCursor)
		}
		next := ch.NextCursor
		err = t.db.Tx(ctx, func(tx *sql.Tx) error {
			for i := range ch.Changes {
				if err := state.UpsertNode(tx, "remote_node", toState(&ch.Changes[i])); err != nil {
					return err
				}
			}
			for i := range ch.Tombstones {
				if err := state.DeleteNode(tx, ch.Tombstones[i].Type, ch.Tombstones[i].IDString()); err != nil {
					return err
				}
			}
			return state.SetRemoteCursor(tx, &next)
		})
		if err != nil {
			return changed, err
		}
		changed = changed || len(ch.Changes)+len(ch.Tombstones) > 0
		cursor = next
		if !ch.HasMore {
			return changed, nil
		}
	}
}

// PlainSize derives the plaintext size of an E2EE container from its size:
// header 17 bytes, then per chunk a 4-byte length and a 16-byte tag.
func PlainSize(cipher int64) int64 {
	if cipher < e2ee.HeaderSize+20 {
		return 0
	}
	per := int64(e2ee.ChunkSize + 20)
	chunks := (cipher - e2ee.HeaderSize + per - 1) / per
	return cipher - e2ee.HeaderSize - 20*chunks
}

// ToState converts a node as sent by the server into its cached form (the
// executor stores mutation responses with it).
func ToState(n *api.Node) *state.RemoteNode { return toState(n) }

func toState(n *api.Node) *state.RemoteNode {
	s := &state.RemoteNode{Kind: n.Type, ID: n.IDString(), ParentID: n.Parent(), Seq: n.Seq, IsTrashed: n.IsTrashed,
		IsE2E: n.IsE2E, Name: n.Name, EncryptedName: n.EncryptedName, NameNonce: n.NameNonce, IsBackup: n.IsBackup}
	if n.BackupDeviceID != nil {
		s.BackupDeviceID = *n.BackupDeviceID
	}
	if n.Type == "folder" {
		s.EncryptedKey, s.KeyNonce, s.UpdatedAt = n.EncryptedNameKey, n.NameKeyNonce, n.UpdatedAt
		return s
	}
	s.EncryptedKey, s.KeyNonce, s.StoredExtension = n.EncryptedFileKey, n.FileKeyNonce, n.StoredExtension
	s.CipherSize, s.PlainSize, s.PayloadChecksum, s.ContentVersion, s.UpdatedAt = n.Size, n.Size, n.PayloadChecksum, n.ContentVersion, n.UploadedAt
	if n.IsE2E {
		s.PlainSize = PlainSize(n.Size)
	}
	if n.EncryptedMeta != nil && n.MetaNonce != nil {
		s.EncryptedMeta, s.MetaNonce = *n.EncryptedMeta, *n.MetaNonce
	}
	return s
}

// Key returns the unwrapped name key (folder) or file key (file) of n.
func (t *Tree) Key(n *state.RemoteNode) ([]byte, error) {
	if k, ok := t.keys.get(n.EncryptedKey); ok {
		return k, nil
	}
	mk, err := t.acct.MasterKey()
	if err != nil {
		return nil, err
	}
	k, err := e2ee.UnwrapKeyB64(n.EncryptedKey, n.KeyNonce, mk)
	clear(mk)
	if err != nil {
		return nil, err
	}
	t.keys.put(n.EncryptedKey, k)
	return k, nil
}

// DisplayName returns the plaintext name; ok is false when it cannot be decrypted.
func (t *Tree) DisplayName(n *state.RemoteNode) (name string, ok bool) {
	if !n.IsE2E || n.EncryptedName == "" {
		return n.Name, true
	}
	k, err := t.Key(n)
	if err != nil {
		return "", false
	}
	name, err = e2ee.DecryptName(n.EncryptedName, n.NameNonce, k)
	return name, err == nil
}

// View is the IPC shape of a node: sync-api fields minus key material, with
// the decrypted name and (files) size_plain.
func (t *Tree) View(n *state.RemoteNode) map[string]any {
	name, ok := t.DisplayName(n)
	v := map[string]any{"type": n.Kind, "name": name, "seq": n.Seq, "is_e2e": n.IsE2E, "is_trashed": n.IsTrashed}
	if !ok {
		v["name_error"] = true
	}
	if n.Kind == "folder" {
		id, _ := strconv.ParseInt(n.ID, 10, 64)
		v["id"], v["parent_id"], v["is_backup"], v["updated_at"] = id, n.ParentID, n.IsBackup, n.UpdatedAt
		return v
	}
	v["id"], v["folder_id"], v["size"], v["size_plain"] = n.ID, n.ParentID, n.CipherSize, n.PlainSize
	v["stored_extension"], v["content_version"], v["payload_checksum"], v["uploaded_at"] = n.StoredExtension, n.ContentVersion, n.PayloadChecksum, n.UpdatedAt
	return v
}

// Folder returns a cached, non-trashed folder (nil id = drive root, returns nil, nil).
func (t *Tree) Folder(ctx context.Context, id *int64) (*state.RemoteNode, error) {
	if id == nil {
		return nil, nil
	}
	n, err := t.db.GetNode(ctx, "folder", strconv.FormatInt(*id, 10))
	if err != nil {
		return nil, err
	}
	if n == nil || n.IsTrashed {
		return nil, ErrNotFound
	}
	return n, nil
}

// FolderFresh is Folder, but a miss first pulls the change feed once (the
// folder may have been created since the last poll).
func (t *Tree) FolderFresh(ctx context.Context, id *int64) (*state.RemoteNode, error) {
	n, err := t.Folder(ctx, id)
	if !errors.Is(err, ErrNotFound) {
		return n, err
	}
	if _, err := t.Sync(ctx); err != nil {
		return nil, err
	}
	return t.Folder(ctx, id)
}

// EnsureSynced takes the first snapshot if none exists yet.
func (t *Tree) EnsureSynced(ctx context.Context) error {
	cur, err := t.Cursor(ctx)
	if err != nil || cur != nil {
		return err
	}
	_, err = t.Sync(ctx)
	return err
}

// Listing is the remote.list result.
type Listing struct {
	Folder  map[string]any   `json:"folder"`
	Folders []map[string]any `json:"folders"`
	Files   []map[string]any `json:"files"`
}

// List returns the decrypted children of a folder (nil = drive root).
func (t *Tree) List(ctx context.Context, folderID *int64) (*Listing, error) {
	if err := t.EnsureSynced(ctx); err != nil {
		return nil, err
	}
	folder, err := t.FolderFresh(ctx, folderID)
	if err != nil {
		return nil, err
	}
	kids, err := t.db.Children(ctx, folderID)
	if err != nil {
		return nil, err
	}
	out := &Listing{Folders: []map[string]any{}, Files: []map[string]any{}}
	if folder != nil {
		out.Folder = t.View(folder)
	}
	for _, n := range kids {
		if n.Kind == "folder" {
			out.Folders = append(out.Folders, t.View(n))
		} else {
			out.Files = append(out.Files, t.View(n))
		}
	}
	byName := func(l []map[string]any) {
		sort.SliceStable(l, func(i, j int) bool {
			return strings.ToLower(l[i]["name"].(string)) < strings.ToLower(l[j]["name"].(string))
		})
	}
	byName(out.Folders)
	byName(out.Files)
	return out, nil
}

// Path returns "/A/B" for a folder (nil = "/"), from the cache.
func (t *Tree) Path(ctx context.Context, id *int64) (string, error) {
	var parts []string
	for depth := 0; id != nil; depth++ {
		if depth > 1000 {
			return "", fmt.Errorf("remote folder cycle")
		}
		n, err := t.Folder(ctx, id)
		if err != nil {
			return "", err
		}
		name, _ := t.DisplayName(n)
		parts = append([]string{name}, parts...)
		id = n.ParentID
	}
	return "/" + strings.Join(parts, "/"), nil
}

// ValidateName checks a new folder name; the same rules apply to every OS
// the sync engine maps names to.
func ValidateName(name string) error {
	switch {
	case strings.TrimSpace(name) == "":
		return fmt.Errorf("folder name is empty")
	case !utf8.ValidString(name) || utf8.RuneCountInString(name) > 255:
		return fmt.Errorf("folder name must be valid text of at most 255 characters")
	case strings.ContainsAny(name, "/\\\x00"), name == ".", name == "..":
		return fmt.Errorf("folder name cannot contain / or \\ or be . or ..")
	}
	return nil
}

// CreateFolder creates a folder under parent (nil = root). E2EE folders get a
// fresh name key wrapped with the master key; the request carries a random
// client_dedupe_token so a retry after a lost response returns the same folder.
func (t *Tree) CreateFolder(ctx context.Context, parent *int64, name string, encrypted bool) (map[string]any, error) {
	tok := make([]byte, 16)
	rand.Read(tok)
	n, err := t.createFolder(ctx, parent, name, encrypted, "desktop-"+hex.EncodeToString(tok))
	if err != nil {
		return nil, err
	}
	return t.View(n), nil
}

// FindFolder returns the live child folder of parent (nil = root) whose
// decrypted name is name, or nil.
func (t *Tree) FindFolder(ctx context.Context, parent *int64, name string) (*state.RemoteNode, error) {
	kids, err := t.db.Children(ctx, parent)
	if err != nil {
		return nil, err
	}
	for _, n := range kids {
		if got, ok := t.DisplayName(n); ok && n.Kind == "folder" && got == name {
			return n, nil
		}
	}
	return nil, nil
}

// EnsureFolder returns the E2EE child folder name of parent, creating it
// when missing. token is a stable client_dedupe_token: the server returns the
// live folder an earlier request with it created, so repeats never duplicate.
func (t *Tree) EnsureFolder(ctx context.Context, parent *int64, name, token string) (*state.RemoteNode, error) {
	if err := t.EnsureSynced(ctx); err != nil {
		return nil, err
	}
	if n, err := t.FindFolder(ctx, parent, name); n != nil || err != nil {
		return n, err
	}
	return t.createFolder(ctx, parent, name, true, token)
}

// Reset drops the unwrapped keys and the cached tree, then takes a new
// snapshot (engine.clearCaches).
func (t *Tree) Reset(ctx context.Context) error {
	t.syncMu.Lock()
	defer t.syncMu.Unlock()
	t.keys.clear()
	c, err := t.acct.Client()
	if err != nil {
		return err
	}
	return t.snapshot(ctx, c)
}

func (t *Tree) createFolder(ctx context.Context, parent *int64, name string, encrypted bool, token string) (*state.RemoteNode, error) {
	if err := ValidateName(name); err != nil {
		return nil, err
	}
	c, err := t.acct.Client()
	if err != nil {
		return nil, err
	}
	if err := t.EnsureSynced(ctx); err != nil {
		return nil, err
	}
	if _, err := t.FolderFresh(ctx, parent); err != nil {
		return nil, err
	}
	req := api.CreateFolderRequest{Name: name, ParentID: parent, ClientDedupeToken: token}
	if encrypted {
		mk, err := t.acct.MasterKey()
		if err != nil {
			return nil, err
		}
		nameKey, err := e2ee.RandomBytes(e2ee.KeySize)
		if err != nil {
			return nil, err
		}
		encName, nameNonce, err := e2ee.EncryptName(name, nameKey)
		if err != nil {
			return nil, err
		}
		wrapped, wrapNonce, err := e2ee.WrapKey(nameKey, mk)
		clear(mk)
		if err != nil {
			return nil, err
		}
		req.Name = "encrypted" // placeholder, as the website sends
		req.EncryptedName, req.NameNonce = e2ee.EncodeBase64(encName), e2ee.EncodeBase64(nameNonce)
		req.EncryptedNameKey, req.NameKeyNonce = e2ee.EncodeBase64(wrapped), e2ee.EncodeBase64(wrapNonce)
		t.keys.put(req.EncryptedNameKey, nameKey)
	}
	n, err := c.CreateFolder(ctx, req)
	if err != nil {
		return nil, err
	}
	return t.Store(ctx, n)
}

// Store writes a node the server just returned into the cache.
func (t *Tree) Store(ctx context.Context, n *api.Node) (*state.RemoteNode, error) {
	s := toState(n)
	if err := t.db.Tx(ctx, func(tx *sql.Tx) error { return state.UpsertNode(tx, "remote_node", s) }); err != nil {
		return nil, err
	}
	return s, nil
}
