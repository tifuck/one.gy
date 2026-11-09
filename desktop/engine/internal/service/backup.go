package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/tifuck/one.gy/desktop/engine/internal/ipc"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
)

// Backups on the client (sync-api.md "Backups"): the default target
// Backups/<device name>/<folder name>, created idempotently, and marking or
// releasing the backup flag of a sync's one.gy folder.

const backupsFolder = "Backups"

// backupName makes a device or folder name usable as a one.gy folder name.
func backupName(s, fallback string) string {
	s = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ':' || r == 0 {
			return '-'
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	for utf8.RuneCountInString(s) > 255 {
		_, n := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-n]
	}
	if s == "" || strings.Trim(s, "-.") == "" {
		return fallback
	}
	return s
}

// backupTarget resolves Backups/<device>/<folder> for localPath. With create
// the missing folders are made (E2EE); the dedupe token is derived from this
// device, the parent and the name, so a repeat never makes a second copy.
func (s *Service) backupTarget(ctx context.Context, localPath string, create bool) (map[string]any, error) {
	if !filepath.IsAbs(localPath) {
		return nil, validationFailed([]problem{{Code: "local_invalid", Field: "local_path", Message: "choose a full folder path"}})
	}
	a := s.acct.Account()
	if a == nil || !a.SignedIn {
		return nil, ipc.Errorf("not_signed_in", "sign in first")
	}
	names := []string{backupsFolder, backupName(a.DeviceName, "This computer"), backupName(filepath.Base(filepath.Clean(localPath)), "Folder")}
	out := map[string]any{"folder_id": nil, "path": "/" + strings.Join(names, "/"), "exists": false}
	if err := s.tree.EnsureSynced(ctx); err != nil {
		return nil, err
	}
	if create {
		if _, err := s.tree.Sync(ctx); err != nil {
			return nil, err
		}
	}
	var parent *int64
	for _, name := range names {
		var n *state.RemoteNode
		var err error
		if create {
			sum := sha256.Sum256([]byte(a.DeviceID + "\x00" + fmt.Sprint(idOrZero(parent)) + "\x00" + name))
			n, err = s.tree.EnsureFolder(ctx, parent, name, "backup-"+hex.EncodeToString(sum[:20]))
		} else {
			n, err = s.tree.FindFolder(ctx, parent, name)
		}
		if err != nil {
			return nil, err
		}
		if n == nil {
			return out, nil
		}
		id, _ := strconv.ParseInt(n.ID, 10, 64)
		parent = &id
	}
	out["folder_id"], out["exists"] = *parent, true
	return out, nil
}

func idOrZero(id *int64) int64 {
	if id == nil {
		return 0
	}
	return *id
}

func (s *Service) syncsBackupTarget(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		LocalPath string `json:"local_path"`
		Create    bool   `json:"create"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	return s.backupTarget(ctx, in.LocalPath, in.Create)
}

// setBackup marks the folder as this device's backup (or releases it) and
// stores the answer in the cache, so validation and runners see it at once.
func (s *Service) setBackup(ctx context.Context, id int64, enabled bool) error {
	c, err := s.acct.Client()
	if err != nil {
		return err
	}
	n, err := c.SetBackup(ctx, id, enabled)
	if err != nil {
		return err
	}
	_, err = s.tree.Store(ctx, n)
	return err
}

// backupProblems checks the one.gy folder and its ancestors for backups:
// nothing but a mirror may target another device's backup (it is read-only),
// and a backup may not sit inside another backup (the server refuses).
func (s *Service) backupProblems(ctx context.Context, r *validateResult, remoteID *int64, typ string) error {
	device, _ := s.device()
	for depth, id := 0, remoteID; id != nil && depth < 1000; depth++ {
		n, err := s.tree.Folder(ctx, id)
		if err != nil {
			return err
		}
		switch {
		case !n.IsBackup:
		case n.BackupDeviceID != device && typ != "mirror":
			r.fail("remote_read_only", "this one.gy folder is a read-only backup of another device")
			return nil
		case typ == "backup" && depth > 0:
			r.fail("backup_nested", "a backup cannot be inside another backup")
			return nil
		}
		id = n.ParentID
	}
	return nil
}
