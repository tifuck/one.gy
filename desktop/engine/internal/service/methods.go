package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"runtime"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/account"
	"github.com/tifuck/one.gy/desktop/engine/internal/config"
	"github.com/tifuck/one.gy/desktop/engine/internal/ipc"
	"github.com/tifuck/one.gy/desktop/engine/internal/remote"
	"onegy/e2ee"
)

// register fills the IPC method table (engine-ipc.md "Methods").
func (s *Service) register() {
	h := func(name string, fn ipc.Handler) {
		s.rpc.Handle(name, func(ctx context.Context, p json.RawMessage) (any, error) {
			res, err := fn(ctx, p)
			return res, rpcError(err)
		})
	}

	h("engine.info", func(context.Context, json.RawMessage) (any, error) {
		return map[string]any{"version": config.Version, "protocol": config.Protocol, "state_dir": s.opts.StateDir, "platform": runtime.GOOS}, nil
	})
	h("engine.shutdown", func(context.Context, json.RawMessage) (any, error) {
		slog.Info("shutdown requested over IPC")
		time.AfterFunc(100*time.Millisecond, s.Shutdown) // let the reply go out first
		return struct{}{}, nil
	})
	h("engine.nudge", func(context.Context, json.RawMessage) (any, error) {
		s.poller.Nudge()
		return struct{}{}, nil
	})
	h("engine.environment", s.engineEnvironment)
	h("engine.clearCaches", s.engineClearCaches)

	h("account.status", func(ctx context.Context, _ json.RawMessage) (any, error) { return s.acct.Status(ctx), nil })
	h("account.authorize", func(ctx context.Context, p json.RawMessage) (any, error) {
		var in account.AuthorizeParams
		if err := ipc.Params(p, &in); err != nil {
			return nil, err
		}
		if err := s.acct.Authorize(ctx, in); err != nil {
			return nil, err
		}
		s.poller.Nudge()
		return s.acct.Status(ctx), nil
	})
	h("account.unlock", func(ctx context.Context, p json.RawMessage) (any, error) {
		var in struct {
			Password string `json:"password"`
		}
		if err := ipc.Params(p, &in); err != nil {
			return nil, err
		}
		if err := s.acct.Unlock(ctx, in.Password); err != nil {
			return nil, err
		}
		s.poller.Nudge()
		return s.acct.Status(ctx), nil
	})
	h("account.signOut", func(ctx context.Context, p json.RawMessage) (any, error) {
		in := struct {
			Revoke bool `json:"revoke"`
		}{Revoke: true}
		if err := ipc.Params(p, &in); err != nil {
			return nil, err
		}
		if err := s.setPaused(ctx, "", true); err != nil {
			return nil, err
		}
		err := s.acct.SignOut(ctx, in.Revoke)
		s.tree.ResetKeys()
		return struct{}{}, err
	})
	h("account.webUnlockKey", func(context.Context, json.RawMessage) (any, error) {
		if !s.settings().WebUnlock {
			return nil, ipc.Errorf("locked", "website unlock with this device's key is turned off")
		}
		key, err := s.acct.MasterKey()
		if err != nil {
			return nil, err
		}
		defer clear(key)
		return map[string]string{"master_key_b64": e2ee.EncodeBase64(key)}, nil
	})

	h("remote.list", func(ctx context.Context, p json.RawMessage) (any, error) {
		var in struct {
			FolderID *int64 `json:"folder_id"`
		}
		if err := ipc.Params(p, &in); err != nil {
			return nil, err
		}
		return s.tree.List(ctx, zeroIsRoot(in.FolderID))
	})
	h("remote.createFolder", func(ctx context.Context, p json.RawMessage) (any, error) {
		in := struct {
			ParentID *int64 `json:"parent_id"`
			Name     string `json:"name"`
			E2EE     bool   `json:"e2ee"`
		}{E2EE: true}
		if err := ipc.Params(p, &in); err != nil {
			return nil, err
		}
		if err := remote.ValidateName(in.Name); err != nil {
			return nil, validationFailed([]problem{{Code: "invalid_name", Field: "name", Message: err.Error()}})
		}
		return s.tree.CreateFolder(ctx, zeroIsRoot(in.ParentID), in.Name, in.E2EE)
	})

	h("settings.get", func(context.Context, json.RawMessage) (any, error) { return s.settings(), nil })
	h("settings.set", s.settingsSet)

	h("syncs.list", s.syncsList)
	h("syncs.validate", s.syncsValidate)
	h("syncs.create", s.syncsCreate)
	h("syncs.update", s.syncsUpdate)
	h("syncs.remove", s.syncsRemove)
	h("syncs.pause", func(ctx context.Context, p json.RawMessage) (any, error) { return s.pauseResume(ctx, p, true) })
	h("syncs.resume", func(ctx context.Context, p json.RawMessage) (any, error) { return s.pauseResume(ctx, p, false) })

	h("syncs.preview", s.syncsPreview)
	h("syncs.syncNow", s.syncsSyncNow)
	h("syncs.verify", s.syncsVerify)
	h("syncs.ignoreRules", s.syncsIgnoreRules)
	h("syncs.setIgnoreRules", s.syncsSetIgnoreRules)
	h("syncs.backupTarget", s.syncsBackupTarget)
	h("syncs.clearDebris", s.syncsClearDebris)

	h("versions.list", s.versionsList)
	h("versions.restore", s.versionsRestore)

	h("transfers.list", s.transfersList)
	h("transfers.pause", func(_ context.Context, p json.RawMessage) (any, error) { return s.transfersPause(p, true) })
	h("transfers.resume", func(_ context.Context, p json.RawMessage) (any, error) { return s.transfersPause(p, false) })
	h("transfers.cancel", s.transfersCancel)
	h("transfers.clearCompleted", func(context.Context, json.RawMessage) (any, error) {
		s.pool.ClearCompleted()
		return struct{}{}, nil
	})

	h("issues.list", s.issuesList)
	h("issues.resolve", s.issuesResolve)
	h("issues.resolveAll", s.issuesResolveAll)

	h("manual.upload", s.manualUpload)
	h("manual.download", s.manualDownload)
	h("activity.recent", s.activityRecent)
	h("diagnostics.export", s.diagnosticsExport)
}

// zeroIsRoot treats folder id 0 like null (drive root), as /sync/tree does.
func zeroIsRoot(id *int64) *int64 {
	if id != nil && *id == 0 {
		return nil
	}
	return id
}
