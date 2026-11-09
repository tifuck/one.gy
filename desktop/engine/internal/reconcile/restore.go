package reconcile

import "strings"

// restorable: the base item's one.gy node is in the trash with the synced
// content (folders: and nothing synced below it is gone here), so restoring
// it brings back exactly the item this computer still has; a re-created one
// would lose its id, versions and share links. Restoring a folder brings back
// what was trashed with it; anything changed here is synced by the next pass.
func (r *run) restorable(b *stateRow) bool {
	cv, ok := r.trashed[b.RemoteID]
	if !ok || !r.k.up || b.RemoteID == "" {
		return false
	}
	if b.Kind == "file" {
		return cv == b.RemoteContentVersion
	}
	for p := range r.goneLocal {
		if strings.HasPrefix(p, b.RelPath+"/") {
			return false
		}
	}
	return true
}
