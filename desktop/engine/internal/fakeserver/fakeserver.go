// Package fakeserver is an in-memory stand-in for the one.gy sync API
// (desktop/docs/sync-api.md) used by the engine's tests: devices, change
// feed, tree, folder create (fakeserver.go), content, uploads, sessions and
// mutations (files.go), with real E2EE key material. Test helpers play the
// website (add, edit, rename, move, trash files) and inspect the stored
// state, including a check that no (file key, base nonce) pair is reused.
package fakeserver

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"onegy/e2ee"
)

// Server is safe for concurrent use; tests mutate it through its methods.
type Server struct {
	*httptest.Server
	Username  string
	masterKey []byte

	// Capabilities sent to clients; tests may lower the limits before use.
	SmallUploadMax int64
	ChunkSize      int64
	// WithMeta makes the website helpers (AddFile, EditFile) send encrypted
	// meta like current browsers; off = legacy uploads without it.
	WithMeta bool
	// Fault, when set, may fail a request before it is processed (status
	// != 0; -1 drops the connection) or after (lost=true: processed, then
	// the connection is dropped, as if the answer got lost).
	Fault func(method, path string) (status int, lost bool)

	mu         sync.Mutex
	authToken  string
	salt       string
	keys       api.Keys
	seq        int64
	minCursor  int64
	nextFolder int64
	folders    map[int64]*api.Node
	files      map[string]*api.Node
	blobs      map[string][]byte // file id -> stored payload (container, or plaintext for standard)
	uploadIDs  map[string]string // upload_id -> file id
	sessions   map[string]*session
	nonces     map[string]string // file key + base nonce -> container sha256
	violations []string
	tombstones []api.Tombstone
	devices    map[string]bool // sha256(token) -> active
	dedupe     map[string]int64
	shares     map[int64]string    // link-shared folders (links.go)
	wraps      map[string]linkWrap // file id -> folder-link wrap
	Requests   map[string]int      // "METHOD /path" -> count
}

// New starts a TLS server with one E2EE account.
func New(t testing.TB, username, password string) *Server {
	s := &Server{Username: username, folders: map[int64]*api.Node{}, files: map[string]*api.Node{}, blobs: map[string][]byte{},
		uploadIDs: map[string]string{}, sessions: map[string]*session{}, nonces: map[string]string{},
		devices: map[string]bool{}, dedupe: map[string]int64{}, shares: map[int64]string{}, wraps: map[string]linkWrap{}, Requests: map[string]int{}, nextFolder: 10,
		SmallUploadMax: 8 << 20, ChunkSize: e2ee.ChunkSize}
	s.masterKey, _ = e2ee.RandomBytes(e2ee.KeySize)
	saltBytes, _ := e2ee.RandomBytes(32)
	s.salt = e2ee.EncodeBase64(saltBytes)
	var wrap []byte
	var err error
	s.authToken, wrap, err = e2ee.DeriveAuthAndWrappingKeys(password, s.salt)
	if err != nil {
		t.Fatal(err)
	}
	ct, nonce, _ := e2ee.WrapKey(s.masterKey, wrap)
	s.keys = api.Keys{HasE2EEKeys: true, EncryptedMasterKey: e2ee.EncodeBase64(ct), MasterKeyNonce: e2ee.EncodeBase64(nonce),
		MasterKeySalt: s.salt, SplitKeyVersion: 1, AuthTokenSalt: s.salt}
	s.Server = httptest.NewTLSServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.Close)
	return s
}

// MasterKey returns the account master key.
func (s *Server) MasterKey() []byte { return s.masterKey }

// DeviceToken registers a device without the sign-in flow.
func (s *Server) DeviceToken() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.newDevice()
}

func (s *Server) newDevice() string {
	tok := fmt.Sprintf("dev_%d", len(s.devices)+1)
	sum := sha256.Sum256([]byte(tok))
	s.devices[hex.EncodeToString(sum[:])] = true
	return tok
}

func (s *Server) nextSeq() int64 { s.seq++; return s.seq }

func folderID(id int64) json.RawMessage { return json.RawMessage(strconv.FormatInt(id, 10)) }
func fileID(id string) json.RawMessage  { return json.RawMessage(strconv.Quote(id)) }

// AddFolder creates an E2EE folder (parent nil = root) and returns its id.
func (s *Server) AddFolder(parent *int64, name string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextFolder++
	id := s.nextFolder
	nk, _ := e2ee.RandomBytes(e2ee.KeySize)
	en, nn, _ := e2ee.EncryptName(name, nk)
	wk, wn, _ := e2ee.WrapKey(nk, s.masterKey)
	s.folders[id] = &api.Node{Type: "folder", ID: folderID(id), ParentID: parent, Seq: s.nextSeq(),
		IsE2E: true, Name: "encrypted", EncryptedName: e2ee.EncodeBase64(en), NameNonce: e2ee.EncodeBase64(nn),
		EncryptedNameKey: e2ee.EncodeBase64(wk), NameKeyNonce: e2ee.EncodeBase64(wn)}
	return id
}

// Trash soft-deletes a node (folders with their subtree); Delete hard-deletes it (tombstone).
func (s *Server) Trash(kind, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setTrashed(kind, id, true, s.nextSeq())
}

// Restore undoes Trash.
func (s *Server) Restore(kind, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setTrashed(kind, id, false, s.nextSeq())
}

// setTrashed trashes a node with its subtree; a restore, like the server's,
// brings back only what was trashed with it (same seq).
func (s *Server) setTrashed(kind, id string, on bool, seq int64) {
	n := s.node(kind, id)
	if n == nil {
		return
	}
	trashedAt := n.Seq
	n.IsTrashed, n.Seq = on, seq
	if kind != "folder" {
		return
	}
	with := func(c *api.Node) bool { return on && !c.IsTrashed || !on && c.IsTrashed && c.Seq == trashedAt }
	fid, _ := strconv.ParseInt(id, 10, 64)
	for cid, c := range s.folders {
		if c.ParentID != nil && *c.ParentID == fid && with(c) {
			s.setTrashed("folder", strconv.FormatInt(cid, 10), on, seq)
		}
	}
	for cid, c := range s.files {
		if c.FolderID != nil && *c.FolderID == fid && with(c) {
			s.setTrashed("file", cid, on, seq)
		}
	}
}

func (s *Server) Delete(kind, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if kind == "folder" {
		fid, _ := strconv.ParseInt(id, 10, 64)
		delete(s.folders, fid)
	} else {
		delete(s.files, id)
		delete(s.blobs, id)
	}
	raw := fileID(id)
	if kind == "folder" {
		raw = json.RawMessage(id)
	}
	s.tombstones = append(s.tombstones, api.Tombstone{Type: kind, ID: raw, Seq: s.nextSeq()})
}

// ExpireCursors makes every cursor below the current seq answer 410.
func (s *Server) ExpireCursors() {
	s.mu.Lock()
	s.minCursor = s.seq
	s.mu.Unlock()
}

// RevokeAll deactivates every device token.
func (s *Server) RevokeAll() {
	s.mu.Lock()
	for k := range s.devices {
		s.devices[k] = false
	}
	s.mu.Unlock()
}

func (s *Server) node(kind, id string) *api.Node {
	if kind == "folder" {
		fid, _ := strconv.ParseInt(id, 10, 64)
		return s.folders[fid]
	}
	return s.files[id]
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"error": code, "code": code})
}

func failCurrent(w http.ResponseWriter, status int, code string, cur *api.Node) {
	writeJSON(w, status, map[string]any{"error": code, "code": code, "current": cur})
}

// lostWriter swallows the real answer (the client sees a 503 instead).
type lostWriter struct{ h http.Header }

func (l *lostWriter) Header() http.Header         { return l.h }
func (l *lostWriter) Write(b []byte) (int, error) { return len(b), nil }
func (l *lostWriter) WriteHeader(int)             {}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Requests[r.Method+" "+r.URL.Path]++
	if s.Fault != nil {
		status, lost := s.Fault(r.Method, r.URL.Path)
		switch {
		case status == -1:
			drop(w)
			return
		case status != 0:
			fail(w, status, "busy")
			return
		case lost:
			s.route(&lostWriter{h: http.Header{}}, r)
			drop(w)
			return
		}
	}
	s.route(w, r)
}

// drop closes the connection without an answer (a network failure).
func drop(w http.ResponseWriter) {
	if hj, ok := w.(http.Hijacker); ok {
		if c, _, err := hj.Hijack(); err == nil {
			c.Close()
		}
	}
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/apiv1/devices/pre-login" {
		writeJSON(w, 200, map[string]any{"split_key_version": 1, "auth_token_salt": s.salt})
		return
	}
	if r.URL.Path == "/apiv1/devices/authorize" {
		var in api.AuthorizeRequest
		json.NewDecoder(r.Body).Decode(&in)
		if in.Username != s.Username || in.AuthToken != s.authToken {
			fail(w, 401, "invalid_credentials")
			return
		}
		tok := s.newDevice()
		writeJSON(w, 201, map[string]any{"device_id": fmt.Sprintf("d%d", len(s.devices)), "device_token": tok,
			"user": map[string]any{"id": 1, "username": s.Username}})
		return
	}
	sum := sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
	active, known := s.devices[hex.EncodeToString(sum[:])]
	switch {
	case !known:
		fail(w, 401, "invalid_token")
		return
	case !active:
		fail(w, 401, "device_revoked")
		return
	}
	s.refreshLinks()
	p := r.URL.Path
	switch {
	case p == "/apiv1/devices/keys":
		writeJSON(w, 200, s.keys)
	case p == "/apiv1/me":
		writeJSON(w, 200, map[string]any{"user_id": 1, "username": s.Username, "storage_used": 100, "storage_limit": 1000, "has_e2ee_keys": true})
	case p == "/apiv1/devices/self" && r.Method == "DELETE":
		delete(s.devices, hex.EncodeToString(sum[:]))
		w.WriteHeader(204)
	case p == "/apiv1/sync/capabilities":
		writeJSON(w, 200, api.Capabilities{Protocol: 1, ChunkSize: s.ChunkSize, SmallUploadMax: s.SmallUploadMax, MaxUpload: 10 << 30,
			MaxParallelTransfers: 2, PollMinSeconds: 5, MinClientVersion: "0.1.0"})
	case p == "/apiv1/sync/cursor":
		etag := fmt.Sprintf(`"seq-%d"`, s.seq)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(304)
			return
		}
		w.Header().Set("ETag", etag)
		writeJSON(w, 200, map[string]any{"seq": s.seq})
	case p == "/apiv1/sync/changes":
		s.changes(w, r)
	case p == "/apiv1/sync/tree":
		s.tree(w, r)
	case p == "/apiv1/folders" && r.Method == "POST":
		s.createFolder(w, r)
	case strings.HasPrefix(p, "/apiv1/sync/files") || strings.HasPrefix(p, "/apiv1/sync/folders/") || strings.HasPrefix(p, "/apiv1/sync/uploads"):
		s.syncRoute(w, r)
	default:
		fail(w, 404, "not_found")
	}
}

func (s *Server) all() []*api.Node {
	var out []*api.Node
	for _, n := range s.folders {
		out = append(out, n)
	}
	for _, n := range s.files {
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

func (s *Server) changes(w http.ResponseWriter, r *http.Request) {
	cursor, _ := strconv.ParseInt(r.URL.Query().Get("cursor"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 500
	}
	if cursor < s.minCursor || cursor > s.seq {
		writeJSON(w, 410, map[string]any{"error": "expired", "code": "cursor_expired", "min_cursor": s.minCursor})
		return
	}
	type item struct {
		node *api.Node
		tomb *api.Tombstone
		seq  int64
	}
	var items []item
	for _, n := range s.all() {
		if n.Seq > cursor {
			items = append(items, item{node: n, seq: n.Seq})
		}
	}
	for i := range s.tombstones {
		if t := &s.tombstones[i]; t.Seq > cursor {
			items = append(items, item{tomb: t, seq: t.Seq})
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].seq < items[j].seq })
	out := api.Changes{Changes: []api.Node{}, Tombstones: []api.Tombstone{}, NextCursor: cursor}
	if len(items) > limit { // never split one seq across pages
		cut := limit
		for cut < len(items) && items[cut].seq == items[cut-1].seq {
			cut++
		}
		if cut < len(items) {
			items, out.HasMore = items[:cut], true
		}
	}
	for _, it := range items {
		if it.node != nil {
			out.Changes = append(out.Changes, *it.node)
		} else {
			out.Tombstones = append(out.Tombstones, *it.tomb)
		}
		out.NextCursor = it.seq
	}
	writeJSON(w, 200, out)
}

// tree pages over the non-trashed nodes below root (0 = all), folders first.
func (s *Server) tree(w http.ResponseWriter, r *http.Request) {
	root, _ := strconv.ParseInt(r.URL.Query().Get("root"), 10, 64)
	offset, _ := strconv.Atoi(r.URL.Query().Get("page_token"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 2000
	}
	var nodes []*api.Node
	for _, n := range s.all() {
		if !n.IsTrashed && (root == 0 || s.below(n.Parent(), root)) {
			nodes = append(nodes, n)
		}
	}
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].Type == "folder" && nodes[j].Type != "folder" })
	out := map[string]any{"as_of_seq": s.seq, "root": nil, "folders": []api.Node{}, "files": []api.Node{}, "next_page_token": nil}
	end := min(offset+limit, len(nodes))
	var folders, files []api.Node
	for _, n := range nodes[min(offset, end):end] {
		if n.Type == "folder" {
			folders = append(folders, *n)
		} else {
			files = append(files, *n)
		}
	}
	if folders != nil {
		out["folders"] = folders
	}
	if files != nil {
		out["files"] = files
	}
	if end < len(nodes) {
		out["next_page_token"] = strconv.Itoa(end)
	}
	writeJSON(w, 200, out)
}

// below reports whether parent is root or inside it.
func (s *Server) below(parent *int64, root int64) bool {
	for depth := 0; parent != nil && depth < 1000; depth++ {
		if *parent == root {
			return true
		}
		f := s.folders[*parent]
		if f == nil {
			return false
		}
		parent = f.ParentID
	}
	return false
}

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	var in api.CreateFolderRequest
	json.NewDecoder(r.Body).Decode(&in)
	// Like the server: only a live folder under the same parent is reused.
	if id, ok := s.dedupe[in.ClientDedupeToken]; ok && in.ClientDedupeToken != "" && s.folders[id] != nil &&
		!s.folders[id].IsTrashed && sameParent(s.folders[id].ParentID, in.ParentID) {
		n := s.folders[id]
		writeJSON(w, 200, map[string]any{"id": id, "name": n.Name, "encrypted_name": n.EncryptedName, "name_nonce": n.NameNonce,
			"encrypted_name_key": n.EncryptedNameKey, "name_key_nonce": n.NameKeyNonce, "existing": true, "seq": n.Seq})
		return
	}
	if in.ParentID != nil && (s.folders[*in.ParentID] == nil || s.folders[*in.ParentID].IsTrashed) {
		fail(w, 404, "not_found")
		return
	}
	s.nextFolder++
	id := s.nextFolder
	n := &api.Node{Type: "folder", ID: folderID(id), ParentID: in.ParentID, Seq: s.nextSeq(),
		IsE2E: in.EncryptedName != "", Name: in.Name, EncryptedName: in.EncryptedName, NameNonce: in.NameNonce,
		EncryptedNameKey: in.EncryptedNameKey, NameKeyNonce: in.NameKeyNonce}
	s.folders[id] = n
	if in.ClientDedupeToken != "" {
		s.dedupe[in.ClientDedupeToken] = id
	}
	writeJSON(w, 201, map[string]any{"id": id, "name": n.Name, "encrypted_name": n.EncryptedName, "name_nonce": n.NameNonce,
		"encrypted_name_key": n.EncryptedNameKey, "name_key_nonce": n.NameKeyNonce, "seq": n.Seq})
}
