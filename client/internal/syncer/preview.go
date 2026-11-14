package syncer

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/tifuck/one.gy/client/internal/exec"
	"github.com/tifuck/one.gy/client/internal/ignore"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/scan"
)

// PreviewParams describes a sync that does not exist yet (syncs.preview).
type PreviewParams struct {
	Root             string
	FSKind           string
	CaseSensitive    bool
	RootID           *int64
	Type             string
	ConflictPolicy   string
	IssueMode        string
	PropagateDeletes bool
	Initial          string
	IgnoreRules      *string // nil = the root's .onegyignore, or the defaults syncs.create writes

	IncludeHiddenSystem bool
}

// Preview plans the first pass of a sync without executing anything.
func Preview(ctx context.Context, env *Env, p PreviewParams) (reconcile.Preview, error) {
	rules := p.IgnoreRules
	if rules == nil {
		if _, err := os.Lstat(filepath.Join(p.Root, ignore.FileName)); errors.Is(err, fs.ErrNotExist) {
			d := ignore.DefaultRules()
			rules = &d
		}
	}
	tree, err := scan.Run(ctx, scan.Options{Root: p.Root, FSKind: p.FSKind, CaseSensitive: p.CaseSensitive, RootRules: rules, IncludeHiddenSystem: p.IncludeHiddenSystem})
	if err != nil {
		return reconcile.Preview{}, err
	}
	if _, err := env.Exec.Tree.Sync(ctx); err != nil {
		return reconcile.Preview{}, err
	}
	id, name := env.Device()
	rem, err := RemoteInput(ctx, env.Exec, id, p.RootID)
	if err != nil {
		return reconcile.Preview{}, err
	}
	caps, err := env.Exec.Caps(ctx)
	if err != nil {
		return reconcile.Preview{}, err
	}
	set := env.Settings()
	plan := reconcile.Reconcile(&reconcile.Input{Config: reconcile.Config{Type: p.Type, ConflictPolicy: p.ConflictPolicy, IssueMode: p.IssueMode,
		PropagateDeletes: p.PropagateDeletes, Versioning: caps.Versioning, MassDeleteCount: set.MassDeleteCount, MassDeletePercent: set.MassDeletePercent,
		CaseSensitive: p.CaseSensitive, FSKind: p.FSKind, Device: name, Now: time.Now(), Initial: p.Initial}, Local: tree, Remote: *rem})
	return plan.Preview(), nil
}

// VerifyResult is the syncs.verify result.
type VerifyResult struct {
	Matches int `json:"matches"`
	Differs int `json:"differs"`
	Missing int `json:"missing"`
}

// Verify re-hashes every synced file and compares it with the plaintext
// hash one.gy has for it (encrypted meta, or the hash this device verified).
// Differences become integrity issues offering re-download or re-upload.
func (r *Runner) Verify(ctx context.Context, progress func(done, total int)) (VerifyResult, error) {
	var res VerifyResult
	db := r.env.Exec.DB
	row, err := db.GetSync(ctx, r.ID)
	if err != nil || row == nil {
		return res, orGone(err)
	}
	if _, err := r.env.Exec.Tree.Sync(ctx); err != nil {
		return res, err
	}
	rem, err := RemoteInput(ctx, r.env.Exec, r.deviceID(), row.RemoteRootID)
	if err != nil {
		return res, err
	}
	byID := map[string]*reconcile.RemoteNode{}
	for i := range rem.Nodes {
		byID[rem.Nodes[i].ID] = &rem.Nodes[i]
	}
	rows, err := db.ListSynced(ctx, r.ID)
	if err != nil {
		return res, err
	}
	var files []int
	for i, b := range rows {
		if b.Kind == "file" {
			files = append(files, i)
		}
	}
	last := time.Time{}
	for k, i := range files {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		b := rows[i]
		n := byID[b.RemoteID]
		sum, err := exec.HashFile(filepath.Join(row.LocalRoot, filepath.FromSlash(b.RelPath)))
		switch {
		case err != nil || n == nil:
			res.Missing++
		default:
			want := n.SHA256
			if want == "" && n.ContentVersion == b.RemoteContentVersion {
				want = b.PlainSHA256
			}
			if sum == want {
				res.Matches++
				break
			}
			res.Differs++
			r.addSticky(reconcile.Issue{Kind: "integrity", Path: b.RelPath, Message: "This file differs from the copy on one.gy (found by Verify).",
				Actions: []string{"keep_remote", "keep_local", "ignore"}})
		}
		if progress != nil && (time.Since(last) > time.Second || k == len(files)-1) {
			last = time.Now()
			progress(k+1, len(files))
		}
	}
	r.Wake()
	return res, nil
}
