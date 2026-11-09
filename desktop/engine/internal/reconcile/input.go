package reconcile

import (
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/scan"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
)

// Config is the part of a sync's configuration and state the decisions use.
type Config struct {
	Type             string // two_way | backup | mirror | archive | full
	ConflictPolicy   string // keep_both | prefer_remote | prefer_local | ask
	IssueMode        string // smart | advanced
	PropagateDeletes bool
	Versioning       bool // server keeps previous versions: prefer_* allowed, replaces are safe
	KeepExecBit      bool // propagate the executable bit (encrypted meta "mode")

	MassDeleteCount   int // plan 7.8 thresholds (settings)
	MassDeletePercent int
	// The user's answer to a mass_delete issue, per side where the items were
	// deleted: "" = guard, "apply" = propagate the deletes, "restore" = bring
	// the items back from the other side.
	MassDeleteLocal  string
	MassDeleteRemote string

	CaseSensitive bool   // local file system
	FSKind        string // detectFS kind: name rules, FAT size limit
	Device        string // this computer's name, for conflict copies
	Now           time.Time
	Initial       string // merge | local_source | remote_source; used while Base is empty
	RootMissing   bool   // root gone, marker missing/mismatched or volume changed (caller checks)
}

// RemoteNode is one node of the sync's remote subtree with its name and
// metadata decrypted by the caller. ParentID == Remote.RootID for top-level
// items. SHA256 is the plaintext hash from the encrypted meta or a local
// verification ("" = unknown); Size is the plaintext size.
type RemoteNode struct {
	ID              string
	Kind            localfs.Kind // KindFile or KindDir
	ParentID        string
	Name            string
	NameOK          bool // false: the name could not be decrypted
	Seq             int64
	ContentVersion  int64
	PayloadChecksum string
	Size            int64
	SHA256          string
	Mode            uint32 // from the encrypted meta (0 = unknown)
	ReadOnly        bool   // a backup folder of another device (applies to its subtree)
}

// Remote is the sync's remote subtree: non-trashed nodes only; anything
// missing counts as deleted on one.gy. Trashed lists the base items whose
// node is in the one.gy trash (id -> content version, 0 for folders): they
// are restored rather than created again.
type Remote struct {
	RootID      string // "" = drive root
	RootMissing bool   // the remote root folder is trashed or gone
	Nodes       []RemoteNode
	Trashed     map[string]int64
}

// Input is everything one pass compares.
type Input struct {
	Config Config
	Local  *scan.Tree
	Remote Remote
	Base   []*state.SyncedRow
}

type caps struct {
	up, down            bool // local changes go up, remote changes come down
	delRemote, delLocal bool // deletes propagate
}

func capsOf(c *Config) caps {
	k := caps{}
	switch c.Type {
	case "two_way", "full":
		k.up, k.down = true, true
	case "backup", "archive":
		k.up = true
	case "mirror":
		k.down = true
	}
	k.delRemote = k.up && c.PropagateDeletes && c.Type != "archive"
	k.delLocal = k.down && c.PropagateDeletes
	return k
}
