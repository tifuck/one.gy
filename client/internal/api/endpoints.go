package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
)

// --- devices ---

// PreLogin returns the split-key salt for username (POST /apiv1/devices/pre-login;
// the website's /auth/pre-login needs a CSRF session).
func (c *Client) PreLogin(ctx context.Context, username string) (*PreLogin, error) {
	var out PreLogin
	_, err := c.jsonCall(ctx, request{method: "POST", path: "/apiv1/devices/pre-login", noAuth: true, idempotent: true},
		map[string]string{"username": username}, &out)
	return &out, err
}

// Authorize registers this device. Not retried after transport errors: a
// lost response would otherwise create a second device.
func (c *Client) Authorize(ctx context.Context, in AuthorizeRequest) (*AuthorizeResponse, error) {
	var out AuthorizeResponse
	_, err := c.jsonCall(ctx, request{method: "POST", path: "/apiv1/devices/authorize", noAuth: true}, in, &out)
	if err == nil && out.DeviceToken == "" {
		err = fmt.Errorf("server returned no device token")
	}
	return &out, err
}

func (c *Client) Keys(ctx context.Context) (*Keys, error) {
	var out Keys
	_, err := c.jsonCall(ctx, request{method: "GET", path: "/apiv1/devices/keys", idempotent: true}, nil, &out)
	return &out, err
}

func (c *Client) Me(ctx context.Context) (*Me, error) {
	var out Me
	_, err := c.jsonCall(ctx, request{method: "GET", path: "/apiv1/me", idempotent: true}, nil, &out)
	return &out, err
}

// UpdateDevice renames the device and/or reports the client version ("" = unchanged).
func (c *Client) UpdateDevice(ctx context.Context, name, clientVersion string) (*Device, error) {
	body := map[string]string{}
	if name != "" {
		body["name"] = name
	}
	if clientVersion != "" {
		body["client_version"] = clientVersion
	}
	var out Device
	_, err := c.jsonCall(ctx, request{method: "PATCH", path: "/apiv1/devices/self", idempotent: true}, body, &out)
	return &out, err
}

// DeleteDevice signs this device out; the token stops working.
func (c *Client) DeleteDevice(ctx context.Context) error {
	_, err := c.jsonCall(ctx, request{method: "DELETE", path: "/apiv1/devices/self", idempotent: true}, nil, nil)
	return err
}

// --- device security (sync-api.md "Device security") ---

// EnrollPopKey registers a signing key for a device authorized without one.
func (c *Client) EnrollPopKey(ctx context.Context, publicKey string) error {
	_, err := c.jsonCall(ctx, request{method: "POST", path: "/apiv1/devices/self/pop-key"}, map[string]string{"public_key": publicKey}, nil)
	return err
}

// Unlock fetches the at-rest unlock share; with a PIN proof or password auth
// token it also returns a grant.
func (c *Client) Unlock(ctx context.Context, in UnlockRequest) (*UnlockResponse, error) {
	var out UnlockResponse
	_, err := c.jsonCall(ctx, request{method: "POST", path: "/apiv1/devices/self/unlock"}, in, &out)
	return &out, err
}

// RefreshGrant slides the grant's expiry.
func (c *Client) RefreshGrant(ctx context.Context) error {
	_, err := c.jsonCall(ctx, request{method: "POST", path: "/apiv1/devices/self/grant", idempotent: true}, struct{}{}, nil)
	return err
}

// DropGrant locks the app server-side (grant and device website sessions end).
func (c *Client) DropGrant(ctx context.Context) error {
	_, err := c.jsonCall(ctx, request{method: "DELETE", path: "/apiv1/devices/self/grant", idempotent: true}, nil, nil)
	return err
}

// SetPin sets the app lock PIN (needs a grant).
func (c *Client) SetPin(ctx context.Context, pinProof string, strict bool) (*Security, error) {
	var out Security
	_, err := c.jsonCall(ctx, request{method: "PUT", path: "/apiv1/devices/self/pin", idempotent: true},
		map[string]any{"pin_proof": pinProof, "strict": strict}, &out)
	return &out, err
}

// RemovePin stops using a PIN (needs a grant); the app lock asks for the password.
func (c *Client) RemovePin(ctx context.Context) (*Security, error) {
	var out Security
	_, err := c.jsonCall(ctx, request{method: "DELETE", path: "/apiv1/devices/self/pin", idempotent: true}, nil, &out)
	return &out, err
}

// SetScope stores what a locked device may reach (needs a grant).
func (c *Client) SetScope(ctx context.Context, s Scope) error {
	if s.Folders == nil {
		s.Folders = []int64{}
	}
	_, err := c.jsonCall(ctx, request{method: "PUT", path: "/apiv1/devices/self/scope", idempotent: true}, s, nil)
	return err
}

// SetTreeKeys stores key-tree wraps (≤500 items; a locked app only inside its scope).
func (c *Client) SetTreeKeys(ctx context.Context, folders []TreeFolderKeys, files []TreeFileKeys) (*TreeKeysResponse, error) {
	if folders == nil {
		folders = []TreeFolderKeys{}
	}
	if files == nil {
		files = []TreeFileKeys{}
	}
	var out TreeKeysResponse
	_, err := c.jsonCall(ctx, request{method: "POST", path: "/apiv1/sync/tree-keys", idempotent: true},
		map[string]any{"folders": folders, "files": files}, &out)
	return &out, err
}

// WebSession returns a one-use ticket for GET /desktop/session (needs a grant).
func (c *Client) WebSession(ctx context.Context) (string, error) {
	var out struct {
		Ticket string `json:"ticket"`
	}
	_, err := c.jsonCall(ctx, request{method: "POST", path: "/apiv1/devices/self/web-session"}, struct{}{}, &out)
	return out.Ticket, err
}

// --- change feed ---

func (c *Client) Capabilities(ctx context.Context) (*Capabilities, error) {
	var out Capabilities
	_, err := c.jsonCall(ctx, request{method: "GET", path: "/apiv1/sync/capabilities", idempotent: true}, nil, &out)
	return &out, err
}

// Cursor returns the user's latest seq. With etag set and unchanged state the
// server answers 304: changed is false and seq is 0.
func (c *Client) Cursor(ctx context.Context, etag string) (seq int64, newETag string, changed bool, err error) {
	h := http.Header{}
	if etag != "" {
		h.Set("If-None-Match", etag)
	}
	resp, err := c.do(ctx, request{method: "GET", path: "/apiv1/sync/cursor", header: h, idempotent: true})
	if err != nil {
		return 0, "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return 0, etag, false, nil
	}
	var out struct {
		Seq int64 `json:"seq"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxErrBody)).Decode(&out); err != nil {
		return 0, "", false, fmt.Errorf("bad cursor response: %w", err)
	}
	return out.Seq, resp.Header.Get("ETag"), true, nil
}

// Changes returns nodes with seq > cursor (410 cursor_expired → resnapshot).
func (c *Client) Changes(ctx context.Context, cursor int64, limit int) (*Changes, error) {
	q := url.Values{"cursor": {strconv.FormatInt(cursor, 10)}}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out Changes
	_, err := c.jsonCall(ctx, request{method: "GET", path: "/apiv1/sync/changes", query: q, idempotent: true}, nil, &out)
	return &out, err
}

// Tree returns one page of the non-trashed subtree under root (0 = drive root).
func (c *Client) Tree(ctx context.Context, root int64, pageToken string, limit int) (*Tree, error) {
	q := url.Values{"root": {strconv.FormatInt(root, 10)}}
	if pageToken != "" {
		q.Set("page_token", pageToken)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out Tree
	_, err := c.jsonCall(ctx, request{method: "GET", path: "/apiv1/sync/tree", query: q, idempotent: true}, nil, &out)
	return &out, err
}

// --- content ---

// Content streams file content into w starting at offset (Range resume) and
// returns the bytes written. ifMatch ("" = none) is the expected
// payload_checksum; a changed file answers 412 precondition_failed. Only the
// request is retried; a body cut short returns the bytes written so far so
// the caller resumes at offset+n.
func (c *Client) Content(ctx context.Context, fileID string, w io.Writer, offset int64, ifMatch string) (int64, error) {
	h := http.Header{}
	if offset > 0 {
		h.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	if ifMatch != "" {
		h.Set("If-Match", strconv.Quote(ifMatch))
	}
	resp, err := c.do(ctx, request{method: "GET", path: "/apiv1/sync/files/" + url.PathEscape(fileID) + "/content", header: h, idempotent: true, slow: true})
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if offset > 0 && resp.StatusCode != http.StatusPartialContent {
		return 0, fmt.Errorf("server ignored the range request (HTTP %d)", resp.StatusCode)
	}
	if offset > 0 {
		var start int64
		if _, err := fmt.Sscanf(resp.Header.Get("Content-Range"), "bytes %d-", &start); err != nil || start != offset {
			return 0, fmt.Errorf("unexpected Content-Range %q", resp.Header.Get("Content-Range"))
		}
	}
	n, err := io.Copy(w, resp.Body)
	if err != nil && ctx.Err() == nil {
		err = fmt.Errorf("%w: %v", ErrOffline, err)
	}
	return n, err
}

// --- mutations ---

func (c *Client) mutate(ctx context.Context, kind, id, action string, body any) (*Node, error) {
	var out Node
	path := "/apiv1/sync/" + kind + "/" + url.PathEscape(id) + "/" + action
	_, err := c.jsonCall(ctx, request{method: "POST", path: path, idempotent: true}, body, &out)
	return &out, err
}

type ifSeqBody struct {
	IfSeq *int64 `json:"if_seq,omitempty"`
}

// MoveFile moves a file into folderID (nil = root). ifSeq nil = unconditional.
func (c *Client) MoveFile(ctx context.Context, id string, folderID, ifSeq *int64) (*Node, error) {
	return c.mutate(ctx, "files", id, "move", map[string]any{"folder_id": folderID, "if_seq": ifSeq})
}

func (c *Client) MoveFolder(ctx context.Context, id int64, parentID, ifSeq *int64) (*Node, error) {
	return c.mutate(ctx, "folders", strconv.FormatInt(id, 10), "move", map[string]any{"parent_id": parentID, "if_seq": ifSeq})
}

func (c *Client) RenameFile(ctx context.Context, id string, in RenameRequest) (*Node, error) {
	return c.mutate(ctx, "files", id, "rename", in)
}

func (c *Client) RenameFolder(ctx context.Context, id int64, in RenameRequest) (*Node, error) {
	in.StoredExtension = nil
	return c.mutate(ctx, "folders", strconv.FormatInt(id, 10), "rename", in)
}

func (c *Client) TrashFile(ctx context.Context, id string, ifSeq *int64) (*Node, error) {
	return c.mutate(ctx, "files", id, "trash", ifSeqBody{ifSeq})
}

func (c *Client) TrashFolder(ctx context.Context, id int64, ifSeq *int64) (*Node, error) {
	return c.mutate(ctx, "folders", strconv.FormatInt(id, 10), "trash", ifSeqBody{ifSeq})
}

func (c *Client) RestoreFile(ctx context.Context, id string) (*Node, error) {
	return c.mutate(ctx, "files", id, "restore", struct{}{})
}

func (c *Client) RestoreFolder(ctx context.Context, id int64) (*Node, error) {
	return c.mutate(ctx, "folders", strconv.FormatInt(id, 10), "restore", struct{}{})
}

// SetMeta backfills encrypted_meta, guarded by the node's content_version.
func (c *Client) SetMeta(ctx context.Context, id, metaB64, nonceB64 string, ifContentVersion int64) (*Node, error) {
	return c.mutate(ctx, "files", id, "meta", map[string]any{
		"encrypted_meta": metaB64, "meta_nonce": nonceB64, "if_content_version": ifContentVersion})
}

// SetBackup marks a folder as this device's backup or turns it back into a
// normal folder (POST /apiv1/sync/folders/<id>/backup; idempotent).
func (c *Client) SetBackup(ctx context.Context, id int64, enabled bool) (*Node, error) {
	return c.mutate(ctx, "folders", strconv.FormatInt(id, 10), "backup", map[string]bool{"enabled": enabled})
}

// --- versions ---

// Versions lists the kept previous versions of a live file, newest first.
func (c *Client) Versions(ctx context.Context, fileID string) (*Versions, error) {
	var out Versions
	_, err := c.jsonCall(ctx, request{method: "GET", path: "/apiv1/sync/files/" + url.PathEscape(fileID) + "/versions", idempotent: true}, nil, &out)
	return &out, err
}

// RestoreVersion replaces the live content with a version (body: see
// sync-api.md "Versions"). Not retried: a lost answer would restore twice.
func (c *Client) RestoreVersion(ctx context.Context, fileID, versionID string, body map[string]any) (*Node, error) {
	var out Node
	path := "/apiv1/sync/files/" + url.PathEscape(fileID) + "/versions/" + url.PathEscape(versionID) + "/restore"
	_, err := c.jsonCall(ctx, request{method: "POST", path: path, slow: true}, body, &out)
	return &out, err
}

// CreateFolder uses POST /apiv1/folders; set ClientDedupeToken so a retried
// request returns the same folder. The answer is completed into a folder Node.
func (c *Client) CreateFolder(ctx context.Context, in CreateFolderRequest) (*Node, error) {
	var out Node
	if _, err := c.jsonCall(ctx, request{method: "POST", path: "/apiv1/folders", idempotent: in.ClientDedupeToken != ""}, in, &out); err != nil {
		return nil, err
	}
	out.Type, out.ParentID, out.IsE2E = "folder", in.ParentID, in.EncryptedName != ""
	return &out, nil
}

// --- uploads ---

// decodeNodeOrExisting accepts either a node or {"existing": true, "node": …}.
func decodeNodeOrExisting(raw []byte) (*Node, bool, error) {
	var env existingEnvelope
	if err := json.Unmarshal(raw, &env); err == nil && env.Existing && env.Node != nil {
		return env.Node, true, nil
	}
	var n Node
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, false, err
	}
	return &n, false, nil
}

func (c *Client) rawCall(ctx context.Context, r request) ([]byte, int, error) {
	resp, err := c.do(ctx, r)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONBody))
	return b, resp.StatusCode, err
}

// UploadSmall is POST /apiv1/sync/files: one container ≤ small_upload_max,
// optional encrypted thumbnail. fields must include upload_id, so retries are
// idempotent. existing is true when the server already had this upload_id.
func (c *Client) UploadSmall(ctx context.Context, fields UploadFields, content, thumbnail []byte) (node *Node, existing bool, err error) {
	if fields["upload_id"] == "" {
		return nil, false, fmt.Errorf("upload_id is required")
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if v != "" {
			mw.WriteField(k, v)
		}
	}
	fw, _ := mw.CreateFormFile("file", "blob")
	fw.Write(content)
	if thumbnail != nil {
		tw, _ := mw.CreateFormFile("encrypted_thumbnail", "thumbnail")
		tw.Write(thumbnail)
	}
	if err := mw.Close(); err != nil {
		return nil, false, err
	}
	raw, _, err := c.rawCall(ctx, request{method: "POST", path: "/apiv1/sync/files", body: buf.Bytes(),
		contentType: mw.FormDataContentType(), idempotent: true, content: true})
	if err != nil {
		return nil, false, err
	}
	return decodeNodeOrExisting(raw)
}

// CreateSession is POST /apiv1/sync/uploads. When the upload_id was already
// committed, session is nil and node is the existing file.
func (c *Client) CreateSession(ctx context.Context, fields map[string]any) (session *Session, node *Node, err error) {
	if s, _ := fields["upload_id"].(string); s == "" {
		return nil, nil, fmt.Errorf("upload_id is required")
	}
	b, err := json.Marshal(fields)
	if err != nil {
		return nil, nil, err
	}
	raw, _, err := c.rawCall(ctx, request{method: "POST", path: "/apiv1/sync/uploads", body: b, contentType: "application/json", idempotent: true})
	if err != nil {
		return nil, nil, err
	}
	var env existingEnvelope
	if json.Unmarshal(raw, &env) == nil && env.Existing && env.Node != nil {
		return nil, env.Node, nil
	}
	var s Session
	if err := json.Unmarshal(raw, &s); err != nil || s.SessionID == "" {
		return nil, nil, fmt.Errorf("bad upload session response")
	}
	return &s, nil, nil
}

// PutPart uploads part i with its SHA-256; re-sending identical bytes is safe.
func (c *Client) PutPart(ctx context.Context, sessionID string, i int, data []byte) error {
	sum := sha256.Sum256(data)
	h := http.Header{"X-Content-Sha256": {hex.EncodeToString(sum[:])}}
	_, err := c.jsonCall(ctx, request{method: "PUT", path: "/apiv1/sync/uploads/" + url.PathEscape(sessionID) + "/parts/" + strconv.Itoa(i),
		body: data, contentType: "application/octet-stream", header: h, idempotent: true, content: true}, nil, nil)
	return err
}

func (c *Client) SessionStatus(ctx context.Context, sessionID string) (*Session, error) {
	var out Session
	_, err := c.jsonCall(ctx, request{method: "GET", path: "/apiv1/sync/uploads/" + url.PathEscape(sessionID), idempotent: true}, nil, &out)
	return &out, err
}

// CompleteSession commits the session; thumbB64/thumbNonce are optional.
func (c *Client) CompleteSession(ctx context.Context, sessionID, thumbB64, thumbNonce string) (node *Node, existing bool, err error) {
	body := map[string]string{}
	if thumbB64 != "" {
		body["encrypted_thumbnail_b64"], body["thumbnail_nonce"] = thumbB64, thumbNonce
	}
	b, _ := json.Marshal(body)
	raw, _, err := c.rawCall(ctx, request{method: "POST", path: "/apiv1/sync/uploads/" + url.PathEscape(sessionID) + "/complete",
		body: b, contentType: "application/json", idempotent: true, slow: true})
	if err != nil {
		return nil, false, err
	}
	return decodeNodeOrExisting(raw)
}

func (c *Client) AbortSession(ctx context.Context, sessionID string) error {
	_, err := c.jsonCall(ctx, request{method: "DELETE", path: "/apiv1/sync/uploads/" + url.PathEscape(sessionID), idempotent: true}, nil, nil)
	return err
}
