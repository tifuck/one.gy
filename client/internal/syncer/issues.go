package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tifuck/one.gy/client/internal/exec"
	"github.com/tifuck/one.gy/client/internal/ignore"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/scan"
	"github.com/tifuck/one.gy/client/internal/state"
)

// Issues: every pass recomputes the sync's issue set (scan + plan + sticky
// executor failures); new ones are stored and announced, ones that are gone
// are resolved. issues.resolve applies a decision: some at once (retry,
// ignore, rename, mass-delete answers), the ones that need ops at the start
// of the next pass.

// IssueView is the IPC Issue object.
type IssueView struct {
	ID        int64          `json:"id"`
	SyncID    string         `json:"sync_id"`
	Kind      string         `json:"kind"`
	Path      string         `json:"path"`
	Message   string         `json:"message"`
	Local     any            `json:"local,omitempty"`
	Remote    any            `json:"remote,omitempty"`
	Actions   []string       `json:"actions"`
	Detail    map[string]any `json:"detail,omitempty"`
	CreatedAt string         `json:"created_at"`
	Resolved  bool           `json:"resolved,omitempty"`
}

type issueDetail struct {
	Message string         `json:"message"`
	Actions []string       `json:"actions"`
	Detail  map[string]any `json:"detail,omitempty"`
}

// View decodes a stored issue.
func View(r *state.IssueRow) IssueView {
	var d issueDetail
	json.Unmarshal([]byte(r.Detail), &d)
	v := IssueView{ID: r.ID, SyncID: r.SyncID, Kind: r.Kind, Path: r.RelPath, Message: d.Message, Actions: d.Actions, Detail: d.Detail, CreatedAt: r.CreatedAt}
	if v.Actions == nil {
		v.Actions = []string{}
	}
	if d.Detail != nil {
		v.Local, v.Remote = d.Detail["local"], d.Detail["remote"]
	}
	return v
}

var scanActions = map[string][]string{
	"symlink": {"ignore", "open"}, "invalid_name": {"rename", "ignore"}, "permission": {"retry", "open"}, "ignore_parse": {"open", "retry"},
}

func scanIssue(is scan.Issue) reconcile.Issue {
	out := reconcile.Issue{Kind: is.Kind, Path: is.Path, Message: is.Message, Actions: scanActions[is.Kind]}
	if len(is.Errors) > 0 {
		out.Detail = map[string]any{"errors": is.Errors}
		out.Message += " " + is.Errors[0].Error()
	}
	return out
}

// syncIssues makes the stored open issues of the sync equal to list.
func (r *Runner) syncIssues(ctx context.Context, list []reconcile.Issue) {
	db := r.env.Exec.DB
	open, err := db.OpenIssues(ctx, r.ID)
	if err != nil {
		return
	}
	have := map[string]*state.IssueRow{}
	for _, o := range open {
		have[o.Kind+"|"+o.RelPath] = o
	}
	seen := map[string]bool{}
	for _, is := range list {
		k := is.Kind + "|" + is.Path
		if seen[k] {
			continue
		}
		seen[k] = true
		b, _ := json.Marshal(issueDetail{Message: is.Message, Actions: is.Actions, Detail: is.Detail})
		if o := have[k]; o != nil {
			if o.Detail != string(b) {
				db.UpdateIssueDetail(ctx, o.ID, string(b))
			}
			continue
		}
		row := &state.IssueRow{SyncID: r.ID, Kind: is.Kind, RelPath: is.Path, Detail: string(b)}
		if db.AddIssue(ctx, row) == nil {
			r.announce(View(row), false)
		}
	}
	for k, o := range have {
		if !seen[k] && db.ResolveIssue(ctx, o.ID) == nil {
			r.announce(View(o), true)
		}
	}
}

func (r *Runner) announce(v IssueView, resolved bool) {
	v.Resolved = resolved
	if r.env.Events.Issue != nil {
		r.env.Events.Issue(v)
	}
	if resolved || r.env.Events.Notify == nil {
		return
	}
	r.mu.Lock()
	quiet := time.Since(r.lastNotify) < 30*time.Second && v.Kind != "mass_delete"
	if !quiet {
		r.lastNotify = time.Now()
	}
	r.mu.Unlock()
	switch {
	case quiet:
	case v.Kind == "mass_delete":
		r.env.Events.Notify("Many files were deleted", v.Message, "mass_delete")
	case v.Kind == "conflict":
		r.env.Events.Notify("Conflict", "Changed on both sides: "+filepath.Base(v.Path), "conflict")
	default:
		r.env.Events.Notify("Sync needs attention", v.Message, "issue")
	}
}

// ErrBadAction: the action does not apply to the issue.
var ErrBadAction = errors.New("this action does not apply to the issue")

func hasAction(v IssueView, a string) bool {
	for _, x := range v.Actions {
		if x == a {
			return true
		}
	}
	return false
}

// Resolve applies a user decision to an open issue of this sync. remove_sync
// is the caller's (it removes the sync). name is the new name for rename.
func (r *Runner) Resolve(ctx context.Context, row *state.IssueRow, act, name string) error {
	v := View(row)
	alias := act
	if v.Kind == "mass_delete" && (act == "delete_remote" || act == "restore_local") {
		alias = map[string]string{"delete_remote": "keep_local", "restore_local": "keep_remote"}[act]
	}
	if !hasAction(v, alias) && !hasAction(v, act) {
		return ErrBadAction
	}
	sync, err := r.env.Exec.DB.GetSync(ctx, r.ID)
	if err != nil || sync == nil {
		return orGone(err)
	}
	switch {
	case act == "open":
		return nil // the app shows the items
	case v.Kind == "mass_delete":
		side, _ := v.Detail["side"].(string)
		ans := "restore"
		if (side == "local") == (alias == "keep_local") {
			ans = "apply" // that side's state wins: propagate its deletes
		}
		r.mu.Lock()
		if side == "local" {
			r.massLocal = ans
		} else {
			r.massRemote = ans
		}
		r.mu.Unlock()
	case act == "retry":
		r.mu.Lock()
		for k, is := range r.sticky {
			if is.Path == v.Path || v.Path == "" || is.Kind == v.Kind {
				delete(r.sticky, k)
			}
		}
		for k := range r.retries {
			if strings.HasSuffix(k, "|"+v.Path) || v.Path == "" {
				delete(r.retries, k)
			}
		}
		r.holdUp, r.holdDown = time.Time{}, time.Time{}
		r.mu.Unlock()
	case act == "ignore":
		if v.Path == "" {
			return ErrBadAction
		}
		if err := AddIgnoreRule(sync.LocalRoot, v.Path); err != nil {
			return err
		}
		r.dropSticky(v.Path)
	case act == "rename":
		if err := renameLocal(sync.LocalRoot, v.Path, name); err != nil {
			return err
		}
		r.dropSticky(v.Path)
	case act == "restore_remote_root":
		if sync.RemoteRootID == nil {
			return ErrBadAction
		}
		c, err := r.env.Exec.Acct.Client()
		if err != nil {
			return err
		}
		if _, err := c.RestoreFolder(ctx, *sync.RemoteRootID); err != nil {
			return err
		}
		if _, err := r.env.Exec.Tree.Sync(ctx); err != nil {
			return err
		}
	case act == "keep_both" || act == "keep_remote" || act == "keep_local":
		r.mu.Lock()
		r.actions = append(r.actions, action{kind: v.Kind, path: v.Path, verb: act})
		r.mu.Unlock()
		r.dropSticky(v.Path)
	default:
		return ErrBadAction
	}
	r.env.Exec.DB.ResolveIssue(ctx, row.ID)
	r.announce(v, true)
	r.Wake()
	return nil
}

func orGone(err error) error {
	if err != nil {
		return err
	}
	return ErrGone
}

func (r *Runner) dropSticky(p string) {
	r.mu.Lock()
	for k, is := range r.sticky {
		if is.Path == p {
			delete(r.sticky, k)
		}
	}
	r.mu.Unlock()
}

// AddIgnoreRule appends an exact-path exclude for rel to the root .onegyignore.
func AddIgnoreRule(root, rel string) error {
	p := filepath.Join(root, ignore.FileName)
	b, err := os.ReadFile(p)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	text := string(b)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += "-pR:" + regexp.QuoteMeta(rel) + "\n"
	return WriteIgnoreRules(root, text)
}

// WriteIgnoreRules validates and atomically writes the root .onegyignore.
func WriteIgnoreRules(root, text string) error {
	if _, errs := ignore.Parse(text); errs != nil {
		return fmt.Errorf("%s: %v", ignore.FileName, errs[0])
	}
	p := filepath.Join(root, ignore.FileName)
	tmp := filepath.Join(root, ".onegy", "tmp", "onegyignore-"+strconv.FormatInt(time.Now().UnixNano(), 10))
	if err := os.MkdirAll(filepath.Dir(tmp), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	if err := localfs.SyncFile(tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	return localfs.Replace(tmp, p)
}

// renameLocal renames root/rel to name in the same folder (never replacing).
func renameLocal(root, rel, name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return fmt.Errorf("choose a name without / or \\")
	}
	dst := path.Join(path.Dir(rel), name)
	return localfs.RenameNoReplace(filepath.Join(root, filepath.FromSlash(rel)), filepath.Join(root, filepath.FromSlash(dst)))
}

// ResolveAll applies the Smart-mode default to every open issue of the
// sync: conflicts keep both versions, retryable problems retry. Mass-delete
// questions and name decisions stay with the user.
func (r *Runner) ResolveAll(ctx context.Context) (int, error) {
	open, err := r.env.Exec.DB.OpenIssues(ctx, r.ID)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, row := range open {
		v := View(row)
		act := ""
		switch {
		case v.Kind == "mass_delete":
		case hasAction(v, "keep_both"):
			act = "keep_both"
		case hasAction(v, "retry"):
			act = "retry"
		}
		if act != "" && r.Resolve(ctx, row, act, "") == nil {
			n++
		}
	}
	return n, nil
}

// applyActions runs the queued keep_* decisions against the current state.
func (r *Runner) applyActions(ctx context.Context, x *exec.Executor, in *reconcile.Input, row *state.SyncRow, cfg Config) error {
	r.mu.Lock()
	acts := r.actions
	r.actions = nil
	r.mu.Unlock()
	if len(acts) == 0 {
		return nil
	}
	base := map[string]*state.SyncedRow{}
	for _, b := range in.Base {
		base[b.RelPath] = b
	}
	remote := RemotePaths(in)
	taken := map[string]bool{}
	for p := range in.Local.Entries {
		taken[localfs.Key(p, in.Config.CaseSensitive)] = true
	}
	for _, a := range acts {
		e := in.Local.Entries[a.path]
		n := remote[a.path]
		var op reconcile.Op
		switch {
		case a.verb == "keep_both" && e != nil:
			op = reconcile.Op{Kind: reconcile.Conflict, From: a.path, Path: reconcile.ConflictName(in, a.path, taken), EntryKind: e.Kind, Size: e.Size,
				Local: expectOf(e), Target: &reconcile.Expect{Absent: true}, Base: base[a.path], Reason: "keep both (user decision)"}
		case a.verb == "keep_remote" && n != nil && n.Kind == localfs.KindFile:
			op = reconcile.Op{Kind: reconcile.Download, Path: a.path, EntryKind: localfs.KindFile, RemoteID: n.ID, RemoteName: n.Name, Size: n.Size,
				SHA256: n.SHA256, ContentVersion: n.ContentVersion, PayloadChecksum: n.PayloadChecksum, Local: &reconcile.Expect{Absent: true},
				Base: base[a.path], Reason: "keep the one.gy version (user decision)"}
			if e != nil {
				op.Local = expectOf(e)
			}
		case a.verb == "keep_local" && e != nil && e.Kind == localfs.KindFile:
			op = reconcile.Op{Kind: reconcile.Upload, Path: a.path, EntryKind: localfs.KindFile, ParentPath: parentPath(a.path),
				RemoteName: path.Base(a.path), Size: e.Size, SHA256: e.SHA256, Mode: e.Mode, Local: expectOf(e), Base: base[a.path],
				Reason: "keep this computer's version (user decision)"}
			if n != nil && n.Kind == localfs.KindFile {
				op.RemoteID, op.RemoteName, op.ContentVersion = n.ID, n.Name, n.ContentVersion
			}
		default:
			continue // the item changed meanwhile; the plan decides again
		}
		if err := r.one(ctx, x, op); err != nil {
			return err
		}
	}
	// The ops changed local and remote state: rescan.
	nin, err := r.input(ctx, row, cfg)
	if err != nil {
		return err
	}
	*in = *nin
	return nil
}

func expectOf(e *scan.Entry) *reconcile.Expect {
	x := &reconcile.Expect{Kind: e.Kind, ID: e.ID, Size: e.Size, MtimeNs: e.MtimeNs}
	if e.Kind == localfs.KindDir {
		x.Size, x.MtimeNs = 0, 0
	}
	return x
}

func parentPath(p string) string {
	if d := path.Dir(p); d != "." {
		return d
	}
	return ""
}

// RemotePaths maps the remote subtree onto local paths by name (no clash
// handling: used for user decisions on one path and for verify).
func RemotePaths(in *reconcile.Input) map[string]*reconcile.RemoteNode {
	names := localfs.NamesFor(in.Config.FSKind)
	byID := map[string]*reconcile.RemoteNode{}
	for i := range in.Remote.Nodes {
		byID[in.Remote.Nodes[i].ID] = &in.Remote.Nodes[i]
	}
	out := map[string]*reconcile.RemoteNode{}
	for _, n := range byID {
		parts := []string{}
		ok := true
		for c, depth := n, 0; ; depth++ {
			if !c.NameOK || depth > 1000 {
				ok = false
				break
			}
			parts = append([]string{names.ToLocal(c.Name)}, parts...)
			if c.ParentID == in.Remote.RootID {
				break
			}
			if c = byID[c.ParentID]; c == nil {
				ok = false
				break
			}
		}
		if ok {
			out[strings.Join(parts, "/")] = n
		}
	}
	return out
}
