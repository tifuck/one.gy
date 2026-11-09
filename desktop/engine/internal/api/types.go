package api

import "encoding/json"

// Node is a folder or file as sent by the sync API (sync-api.md "Node shapes").
// Folder-only and file-only fields share one struct; Type tells them apart.
type Node struct {
	Type      string          `json:"type"`
	ID        json.RawMessage `json:"id"` // int for folders, UUID string for files
	ParentID  *int64          `json:"parent_id,omitempty"`
	FolderID  *int64          `json:"folder_id,omitempty"`
	Seq       int64           `json:"seq"`
	IsTrashed bool            `json:"is_trashed"`
	IsE2E     bool            `json:"is_e2e"`
	Name      string          `json:"name"`

	EncryptedName string `json:"encrypted_name"`
	NameNonce     string `json:"name_nonce"`

	EncryptedNameKey string  `json:"encrypted_name_key"`
	NameKeyNonce     string  `json:"name_key_nonce"`
	IsBackup         bool    `json:"is_backup"`
	BackupDeviceID   *string `json:"backup_device_id"`
	UpdatedAt        string  `json:"updated_at"`

	EncryptedFileKey  string  `json:"encrypted_file_key"`
	FileKeyNonce      string  `json:"file_key_nonce"`
	StoredExtension   string  `json:"stored_extension"`
	Size              int64   `json:"size"`
	DiskSize          int64   `json:"disk_size"`
	PayloadChecksum   string  `json:"payload_checksum"`
	ContentVersion    int64   `json:"content_version"`
	EncryptedMeta     *string `json:"encrypted_meta"`
	MetaNonce         *string `json:"meta_nonce"`
	UploadedAt        string  `json:"uploaded_at"`
	TrashedByDeviceID *string `json:"trashed_by_device_id"`

	FolderLinkShareToken *string `json:"folder_link_share_token,omitempty"` // links.go
	NeedsFolderLinkKey   bool    `json:"needs_folder_link_key,omitempty"`
}

// IDString returns the id as text: decimal for folders, the UUID for files.
func (n *Node) IDString() string {
	var s string
	if json.Unmarshal(n.ID, &s) == nil {
		return s
	}
	return string(n.ID)
}

// Parent returns parent_id for folders and folder_id for files (nil = root).
func (n *Node) Parent() *int64 {
	if n.Type == "file" {
		return n.FolderID
	}
	return n.ParentID
}

type PreLogin struct {
	SplitKeyVersion int    `json:"split_key_version"`
	AuthTokenSalt   string `json:"auth_token_salt"`
}

type AuthorizeRequest struct {
	Username      string `json:"username"`
	AuthToken     string `json:"auth_token"`
	TOTPCode      string `json:"totp_code,omitempty"`
	DeviceName    string `json:"device_name"`
	Platform      string `json:"platform"`
	ClientVersion string `json:"client_version"`
}

type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

type AuthorizeResponse struct {
	DeviceID    string `json:"device_id"`
	DeviceToken string `json:"device_token"`
	User        User   `json:"user"`
}

// Keys is the body of GET /apiv1/devices/keys (same as session GET /api/keys).
type Keys struct {
	HasE2EEKeys         bool   `json:"has_e2ee_keys"`
	EncryptedMasterKey  string `json:"encrypted_master_key"`
	MasterKeyNonce      string `json:"master_key_nonce"`
	MasterKeySalt       string `json:"master_key_salt"`
	PublicKey           string `json:"public_key"`
	EncryptedPrivateKey string `json:"encrypted_private_key"`
	PrivateKeyNonce     string `json:"private_key_nonce"`
	SplitKeyVersion     int    `json:"split_key_version"`
	AuthTokenSalt       string `json:"auth_token_salt"`
}

type Device struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Platform      string `json:"platform"`
	ClientVersion string `json:"client_version"`
	CreatedAt     string `json:"created_at"`
}

type Me struct {
	UserID       int64  `json:"user_id"`
	Username     string `json:"username"`
	StorageUsed  int64  `json:"storage_used"`
	StorageLimit int64  `json:"storage_limit"`
	HasE2EEKeys  bool   `json:"has_e2ee_keys"`
	Versioning   bool   `json:"versioning"`
	Device       Device `json:"device"`
}

type Capabilities struct {
	Protocol             int    `json:"protocol"`
	ChunkSize            int64  `json:"chunk_size"`
	SmallUploadMax       int64  `json:"small_upload_max"`
	MaxUpload            int64  `json:"max_upload"`
	MaxParallelTransfers int    `json:"max_parallel_transfers"`
	PollMinSeconds       int    `json:"poll_min_seconds"`
	Versioning           bool   `json:"versioning"`
	Backups              bool   `json:"backups"`
	MinClientVersion     string `json:"min_client_version"`
}

type Tombstone struct {
	Type string          `json:"type"`
	ID   json.RawMessage `json:"id"`
	Seq  int64           `json:"seq"`
}

// IDString returns the tombstone id as text, like Node.IDString.
func (t *Tombstone) IDString() string {
	n := Node{ID: t.ID}
	return n.IDString()
}

type Changes struct {
	Changes    []Node      `json:"changes"`
	Tombstones []Tombstone `json:"tombstones"`
	NextCursor int64       `json:"next_cursor"`
	HasMore    bool        `json:"has_more"`
}

type Tree struct {
	AsOfSeq       int64  `json:"as_of_seq"`
	Root          *Node  `json:"root"`
	Folders       []Node `json:"folders"`
	Files         []Node `json:"files"`
	NextPageToken string `json:"next_page_token"`
}

// CreateFolderRequest is the body of POST /apiv1/folders. For E2EE folders
// Name is the placeholder "encrypted" and the four encrypted fields are set.
type CreateFolderRequest struct {
	Name              string `json:"name"`
	ParentID          *int64 `json:"parent_id"`
	EncryptedName     string `json:"encrypted_name,omitempty"`
	NameNonce         string `json:"name_nonce,omitempty"`
	EncryptedNameKey  string `json:"encrypted_name_key,omitempty"`
	NameKeyNonce      string `json:"name_key_nonce,omitempty"`
	ClientDedupeToken string `json:"client_dedupe_token,omitempty"`
}

// RenameRequest is the body of the rename mutations: E2EE nodes set the
// encrypted fields (files also StoredExtension), standard nodes set Name.
type RenameRequest struct {
	Name            string  `json:"name,omitempty"`
	EncryptedName   string  `json:"encrypted_name,omitempty"`
	NameNonce       string  `json:"name_nonce,omitempty"`
	StoredExtension *string `json:"stored_extension,omitempty"`
	IfSeq           *int64  `json:"if_seq,omitempty"`
}

// UploadFields are the multipart form fields of POST /apiv1/sync/files and
// the JSON fields of POST /apiv1/sync/uploads (sync-api.md "Uploads"); empty
// values are omitted.
type UploadFields map[string]string

// Session is an upload session (create or status).
type Session struct {
	SessionID     string `json:"session_id"`
	FileID        string `json:"file_id"`
	PartsReceived []int  `json:"parts_received"`
	ExpiresAt     string `json:"expires_at"`
}

// Versions is GET /apiv1/sync/files/<id>/versions.
type Versions struct {
	FileID         string    `json:"file_id"`
	ContentVersion int64     `json:"content_version"`
	Versions       []Version `json:"versions"`
}

type Version struct {
	VersionID        string `json:"version_id"`
	ContentVersion   int64  `json:"content_version"`
	Size             int64  `json:"size"`
	EncryptedFileKey string `json:"encrypted_file_key"`
	FileKeyNonce     string `json:"file_key_nonce"`
	SameKey          bool   `json:"same_key"`
	CreatedAt        string `json:"created_at"`
}

// existingEnvelope is the idempotent-repeat answer {"existing": true, "node": …}.
type existingEnvelope struct {
	Existing bool  `json:"existing"`
	Node     *Node `json:"node"`
}
