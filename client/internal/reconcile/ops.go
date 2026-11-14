// Package reconcile owns the sync decision logic (plan 6.1, 7.7, 7.8): pure
// functions, no I/O, no clocks (Config.Now is only used to name conflict
// copies). Reconcile compares the local tree, the remote subtree and the
// synced base three-way and returns an ordered Plan of Ops plus Issues.
//
// A Plan is one step toward convergence: the sync loop executes it, rescans
// and reconciles again until the plan is empty. Conflict and folder-merge ops
// are completed by the following pass (the renamed local copy is then a new
// upload, the remote version a new download).
//
// # Ops and preconditions (the executor contract)
//
// Paths are local, relative to the sync root, '/'-separated. Before the side
// effect of an op the executor checks its preconditions; if one fails the op
// is superseded (dropped, and the next pass re-plans). Local checks: Local is
// the expected state of the entry at From (moves, conflicts) or else Path;
// Target is the expected state at Path for moves and new local items.
// Expect{Absent: true} means nothing may exist there; otherwise kind, size,
// mtime (at the file system's precision) and, when non-empty, the file id
// must match. Remote checks: RemoteSeq > 0 is sent as if_seq; ContentVersion
// is base_content_version for a replace and the expected version for a
// download (with PayloadChecksum as If-Match). Base is the synced row the op
// was planned against (nil = none); look it up by Base.RemoteID, because
// earlier moves in the same plan may have rewritten its path. Every
// committed op writes the synced row(s) in the same transaction as the
// journal commit (plan 7.6); "row" below means the synced row for the item,
// with RemoteName recorded as given.
//
//   - CreateLocalDir   mkdir Path (Target absent). RemoteID = the folder. Row at Path.
//   - CreateRemoteDir  create folder RemoteName under ParentPath (Local = the
//     local dir). Base, if set, belonged to a folder that is gone remotely: replace it. Row at Path.
//   - MoveLocal        rename From to Path (Local at From, Target absent;
//     on case-insensitive file systems Path may name From itself). Moves the
//     whole subtree: rewrite the rows at and below From to Path (state.MoveSynced).
//   - MoveRemote       move/rename RemoteID to RemoteName under ParentPath
//     (ParentRemoteID when set), if_seq RemoteSeq. Rows as MoveLocal when Base
//     is set (From = Base path); folder merges have no Base and write no row.
//   - Conflict         rename the local item at From to Path (a conflict
//     copy name, Target absent) and delete the Base row and the rows below it.
//     The next pass uploads the copy and downloads the one.gy version.
//   - Upload           RemoteID == "": new file RemoteName under ParentPath;
//     else replace RemoteID with base_content_version ContentVersion (the file
//     key is kept). Local = the scanned file; SHA256/Size/Mode as scanned.
//     Snapshot rules of plan 7.5 apply. Row at Path (deleting Base's row if it
//     was at another path).
//   - Download         fetch RemoteID (ContentVersion, PayloadChecksum,
//     SHA256 when known) into Path. Local = what may be replaced (it goes to
//     debris first) or Absent. Row at Path. A Base synced end-to-end
//     encrypted is only replaced by a standard file with Downgrade.
//   - Link             no transfer: both sides already agree (same hash, or
//     folders). Row at Path for RemoteID; if Base was at another path, move
//     the rows below it too.
//   - VerifyLink       Local and remote have the same size but the remote
//     hash is unknown: download RemoteID to tmp, record its plaintext hash
//     (meta backfill / remote_node.plain_sha256) and Link when it equals the
//     local SHA256. Otherwise leave it: the next pass sees the hash and plans
//     a conflict.
//   - RestoreRemote    restore RemoteID from the one.gy trash instead of
//     creating it again (Base = its row, which stays; RemoteSeq refreshed).
//     Not found in the trash (already restored, or deleted) = superseded.
//   - SetModeRemote    executable bit changed here, content unchanged: write
//     the encrypted meta of RemoteID again with Mode (SHA256, Size as
//     scanned), if_content_version ContentVersion; no content upload.
//     Standard files have no meta: only the row changes. Row Mode = Mode.
//   - SetModeLocal     executable bit changed on one.gy, content unchanged:
//     chmod Path to Mode (Local = the scanned state). Row Mode = Mode.
//   - DeleteLocal      move Path (and its subtree) to debris (Local = the
//     scanned state). Delete the rows at and below Path.
//   - TrashRemote      trash RemoteID, if_seq RemoteSeq. Delete the rows at
//     and below Path.
//   - Forget           delete the Base row and the rows below it (no I/O).
//
// A file synced end-to-end encrypted (Base.E2EE) is never uploaded in
// standard mode: a replace whose node is no longer E2EE is an integrity issue.
//
// Ordering: structural ops (creates, moves, conflicts, folder links) first,
// each after the ops that create its parent or vacate its target; then
// content ops, small files first; deletes last.
package reconcile

import (
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/state"
)

// OpKind names an op.
type OpKind string

const (
	CreateLocalDir  OpKind = "create_local_dir"
	CreateRemoteDir OpKind = "create_remote_dir"
	MoveLocal       OpKind = "move_local"
	MoveRemote      OpKind = "move_remote"
	Conflict        OpKind = "conflict"
	Upload          OpKind = "upload"
	Download        OpKind = "download"
	Link            OpKind = "link"
	VerifyLink      OpKind = "verify_link"
	DeleteLocal     OpKind = "delete_local"
	TrashRemote     OpKind = "trash_remote"
	Forget          OpKind = "forget"
	RestoreRemote   OpKind = "restore_remote"
	SetModeRemote   OpKind = "set_mode_remote"
	SetModeLocal    OpKind = "set_mode_local"
)

// Expect is a local precondition.
type Expect struct {
	Absent  bool
	Kind    localfs.Kind
	ID      localfs.FileID
	Size    int64
	MtimeNs int64
}

// Op is one planned step; see the package doc for each kind's fields.
type Op struct {
	Kind            OpKind
	Path            string
	From            string
	EntryKind       localfs.Kind // KindFile or KindDir
	RemoteID        string
	ParentPath      string
	ParentRemoteID  string
	RemoteName      string
	Size            int64
	SHA256          string
	Mode            uint32
	Local           *Expect
	Target          *Expect
	RemoteSeq       int64
	ContentVersion  int64
	PayloadChecksum string
	RemoteSize      int64 // Conflict: size of the one.gy version (preview)
	Downgrade       bool  // Download: the user chose the one.gy version even if it is no longer end-to-end encrypted
	Base            *state.SyncedRow
	Reason          string
}

// Issue stops work on Path and its subtree (IPC "Issue": kind, path,
// message, actions). Detail carries kind-specific data (mass_delete: side,
// count).
type Issue struct {
	Kind    string         `json:"kind"`
	Path    string         `json:"path"`
	Message string         `json:"message"`
	Actions []string       `json:"actions"`
	Detail  map[string]any `json:"detail,omitempty"`
}

// Plan is the result of one reconcile pass.
type Plan struct {
	Ops    []Op
	Issues []Issue
}

// Count is a number of items and their bytes.
type Count struct {
	Count int   `json:"count"`
	Bytes int64 `json:"bytes"`
}

// PreviewItem is one line of the syncs.preview list.
type PreviewItem struct {
	Action string `json:"action"`
	Path   string `json:"path"`
	Size   int64  `json:"size"`
}

// Preview is the syncs.preview result (engine-ipc.md).
type Preview struct {
	Uploads   Count         `json:"uploads"`
	Downloads Count         `json:"downloads"`
	Conflicts int           `json:"conflicts"`
	Deletions int           `json:"deletions"`
	Items     []PreviewItem `json:"items"`
}

// Preview summarises the plan. A file conflict counts the upload of the
// local copy and the download of the one.gy version it leads to (with its
// bytes).
func (p *Plan) Preview() Preview {
	pv := Preview{Items: []PreviewItem{}}
	add := func(action, path string, size int64) {
		if len(pv.Items) < 200 {
			pv.Items = append(pv.Items, PreviewItem{action, path, size})
		}
	}
	for _, o := range p.Ops {
		switch o.Kind {
		case Upload:
			pv.Uploads.Count++
			pv.Uploads.Bytes += o.Size
			add("upload", o.Path, o.Size)
		case Download, VerifyLink:
			pv.Downloads.Count++
			pv.Downloads.Bytes += o.Size
			add("download", o.Path, o.Size)
		case Conflict:
			pv.Conflicts++
			if o.EntryKind == localfs.KindFile {
				pv.Uploads.Count++
				pv.Uploads.Bytes += o.Size
				pv.Downloads.Count++
				pv.Downloads.Bytes += o.RemoteSize
			}
			add("conflict", o.From, o.Size)
		case DeleteLocal:
			pv.Deletions++
			add("delete_local", o.Path, o.Size)
		case TrashRemote:
			pv.Deletions++
			add("delete_remote", o.Path, o.Size)
		case MoveLocal, MoveRemote:
			add(string(o.Kind), o.Path, 0)
		case CreateLocalDir, CreateRemoteDir, RestoreRemote:
			add(string(o.Kind), o.Path, 0)
		}
	}
	for _, is := range p.Issues {
		if is.Kind == "conflict" {
			pv.Conflicts++
		}
	}
	return pv
}
