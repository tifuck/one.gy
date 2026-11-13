package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/tifuck/one.gy/client/e2ee"
	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/ipc"
	"github.com/tifuck/one.gy/client/internal/remote"
	"github.com/tifuck/one.gy/client/internal/state"
)

// versions.list / versions.restore (sync-api.md "Versions") for a synced
// file, addressed like issues: sync id + path relative to the sync root.

type versionParams struct {
	SyncID    string `json:"sync_id"`
	Path      string `json:"path"`
	VersionID string `json:"version_id"`
}

// versionFile returns the live one.gy file synced at path.
func (s *Service) versionFile(ctx context.Context, syncID, path string) (*state.RemoteNode, error) {
	b, err := s.db.SyncedByPath(ctx, syncID, path)
	if err != nil {
		return nil, err
	}
	if b == nil || b.Kind != "file" || b.RemoteID == "" {
		return nil, ipc.Errorf("not_found", "this file is not on one.gy yet")
	}
	n, err := s.db.GetNode(ctx, "file", b.RemoteID)
	if err != nil {
		return nil, err
	}
	if n == nil || n.IsTrashed {
		return nil, ipc.Errorf("not_found", "this file is not on one.gy any more")
	}
	return n, nil
}

func (s *Service) versionsList(ctx context.Context, params json.RawMessage) (any, error) {
	var in versionParams
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	n, err := s.versionFile(ctx, in.SyncID, in.Path)
	if err != nil {
		return nil, err
	}
	c, err := s.acct.Client()
	if err != nil {
		return nil, err
	}
	vs, err := c.Versions(ctx, n.ID)
	if err != nil {
		return nil, err
	}
	list := []map[string]any{}
	for _, v := range vs.Versions {
		size := v.Size
		if n.IsE2E {
			size = remote.PlainSize(v.Size)
		}
		list = append(list, map[string]any{"version_id": v.VersionID, "content_version": v.ContentVersion, "size": size,
			"created_at": v.CreatedAt, "same_key": v.SameKey})
	}
	return map[string]any{"file_id": n.ID, "folder_id": n.ParentID, "content_version": vs.ContentVersion, "versions": list}, nil
}

// versionsRestore makes a version the live content. A version under another
// file key (the website rotated it) also needs the live name re-encrypted
// under that key; link-key re-wraps need the share secret, which only the
// website has, so such files are restored there.
func (s *Service) versionsRestore(ctx context.Context, params json.RawMessage) (any, error) {
	var in versionParams
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	n, err := s.versionFile(ctx, in.SyncID, in.Path)
	if err != nil {
		return nil, err
	}
	c, err := s.acct.Client()
	if err != nil {
		return nil, err
	}
	vs, err := c.Versions(ctx, n.ID)
	if err != nil {
		return nil, err
	}
	var ver *api.Version
	for i := range vs.Versions {
		if vs.Versions[i].VersionID == in.VersionID {
			ver = &vs.Versions[i]
		}
	}
	if ver == nil {
		return nil, ipc.Errorf("not_found", "no such version")
	}
	body := map[string]any{"base_content_version": vs.ContentVersion}
	if n.IsE2E && !ver.SameKey {
		name, ok := s.tree.DisplayName(n)
		if !ok {
			return nil, ipc.Errorf("locked", "the file name cannot be decrypted")
		}
		mk, err := s.acct.MasterKey()
		if err != nil {
			return nil, err
		}
		key, err := e2ee.UnwrapKeyB64(ver.EncryptedFileKey, ver.FileKeyNonce, mk)
		clear(mk)
		if err != nil {
			return nil, err
		}
		ct, nonce, err := e2ee.EncryptName(name, key)
		clear(key)
		if err != nil {
			return nil, err
		}
		body["encrypted_name"], body["name_nonce"] = e2ee.EncodeBase64(ct), e2ee.EncodeBase64(nonce)
	}
	node, err := c.RestoreVersion(ctx, n.ID, ver.VersionID, body)
	var apiErr *api.Error
	if errors.As(err, &apiErr) && apiErr.Code == "bad_request" && strings.Contains(apiErr.Field, "link_") {
		return nil, validationFailed([]problem{{Code: "restore_on_website", Message: "this file has share links; restore this version on the website"}})
	}
	if err != nil {
		return nil, err
	}
	stored, err := s.tree.Store(ctx, node)
	if err != nil {
		return nil, err
	}
	s.poller.Nudge()
	s.mgr.Wake(in.SyncID)
	return s.tree.View(stored), nil
}
