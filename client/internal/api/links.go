package api

import "context"

// Link-shared folders (sync-api.md "Link-shared folders"): an E2EE file under
// a link-shared folder needs its key wrapped for that folder's link. Nodes say
// so with Node.NeedsFolderLinkKey and carry the share token the wrap is
// derived from (Node.FolderLinkShareToken).

// FolderLinkKey is a file key wrapped with the link key of ShareToken.
type FolderLinkKey struct {
	EncryptedFileKey string `json:"folder_link_encrypted_file_key"`
	FileKeyNonce     string `json:"folder_link_file_key_nonce"`
	ShareToken       string `json:"folder_link_share_token"`
}

// SetFolderLinkKey stores the folder-link wrap of a file. A token that no
// longer governs the file answers 409 conflict with the current node.
func (c *Client) SetFolderLinkKey(ctx context.Context, fileID string, k FolderLinkKey) (*Node, error) {
	return c.mutate(ctx, "files", fileID, "folder-link-key", k)
}
