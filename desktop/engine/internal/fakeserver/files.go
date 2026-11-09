package fakeserver

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"onegy/e2ee"
)

// File routes of the sync API (content, uploads, sessions, mutations) and
// the website/inspection helpers tests use.

type session struct {
	id, uploadID string
	fields       map[string]string
	chunks       int
	size         int64
	sha          string
	header       []byte
	parts        map[int][]byte
	state        string // open | committed | aborted
	fileID       string
}

func (s *Server) syncRoute(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/apiv1/sync/"), "/")
	switch {
	case parts[0] == "files" && len(parts) == 1 && r.Method == "POST":
		s.uploadSmall(w, r)
	case parts[0] == "files" && len(parts) == 3 && parts[2] == "content":
		s.content(w, r, parts[1])
	case (parts[0] == "files" || parts[0] == "folders") && len(parts) == 3 && r.Method == "POST":
		s.mutate(w, r, strings.TrimSuffix(parts[0], "s"), parts[1], parts[2])
	case parts[0] == "uploads" && len(parts) == 1 && r.Method == "POST":
		s.createSession(w, r)
	case parts[0] == "uploads" && len(parts) >= 2:
		sess := s.sessions[parts[1]]
		if sess == nil || sess.state == "aborted" {
			fail(w, 404, "not_found")
			return
		}
		switch {
		case len(parts) == 2 && r.Method == "GET":
			writeJSON(w, 200, sess.body())
		case len(parts) == 2 && r.Method == "DELETE":
			delete(s.sessions, sess.id)
			w.WriteHeader(204)
		case len(parts) == 4 && parts[2] == "parts" && r.Method == "PUT":
			s.putPart(w, r, sess, parts[3])
		case len(parts) == 3 && parts[2] == "complete" && r.Method == "POST":
			s.complete(w, sess)
		default:
			fail(w, 404, "not_found")
		}
	default:
		fail(w, 404, "not_found")
	}
}

func (sess *session) body() map[string]any {
	got := []int{}
	for i := range sess.parts {
		got = append(got, i)
	}
	sort.Ints(got)
	return map[string]any{"session_id": sess.id, "file_id": sess.fileID, "parts_received": got, "expires_at": "2099-01-01T00:00:00Z"}
}

func (s *Server) content(w http.ResponseWriter, r *http.Request, id string) {
	n := s.files[id]
	if n == nil || n.IsTrashed {
		fail(w, 404, "not_found")
		return
	}
	if im := strings.Trim(r.Header.Get("If-Match"), `"`); im != "" && im != n.PayloadChecksum {
		failCurrent(w, 412, "precondition_failed", n)
		return
	}
	blob := s.blobs[id]
	w.Header().Set("ETag", strconv.Quote(n.PayloadChecksum))
	var start int64
	if rg := r.Header.Get("Range"); rg != "" && n.IsE2E {
		fmt.Sscanf(rg, "bytes=%d-", &start)
		if start >= int64(len(blob)) {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", len(blob)))
			fail(w, 416, "bad_request")
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(blob)-1, len(blob)))
		w.WriteHeader(206)
	}
	w.Write(blob[start:])
}

// spec is a parsed upload request (create or replace).
type spec struct {
	f       map[string]string
	replace *api.Node
	folder  *int64
}

func (s *Server) parseSpec(w http.ResponseWriter, f map[string]string) *spec {
	sp := &spec{f: f}
	if f["upload_id"] == "" || (f["mode"] != "e2ee" && f["mode"] != "standard") {
		fail(w, 400, "bad_request")
		return nil
	}
	if id := f["replace_file_id"]; id != "" {
		n := s.files[id]
		if n == nil || n.IsTrashed {
			fail(w, 404, "not_found")
			return nil
		}
		if n.IsE2E != (f["mode"] == "e2ee") || f["encrypted_file_key"] != "" || f["encrypted_name"] != "" {
			fail(w, 400, "bad_request")
			return nil
		}
		if strconv.FormatInt(n.ContentVersion, 10) != f["base_content_version"] {
			failCurrent(w, 409, "conflict", n)
			return nil
		}
		sp.replace = n
		return sp
	}
	if v := f["folder_id"]; v != "" {
		id, _ := strconv.ParseInt(v, 10, 64)
		if fo := s.folders[id]; fo == nil || fo.IsTrashed {
			fail(w, 404, "not_found")
			return nil
		}
		sp.folder = &id
	}
	if s.files[f["file_id"]] != nil {
		fail(w, 409, "conflict")
		return nil
	}
	if f["mode"] == "e2ee" && (f["encrypted_file_key"] == "" || f["encrypted_name"] == "") || f["mode"] == "standard" && f["name"] == "" {
		fail(w, 400, "bad_request")
		return nil
	}
	return sp
}

// existing answers a repeated upload_id.
func (s *Server) existing(w http.ResponseWriter, uploadID string) bool {
	id, ok := s.uploadIDs[uploadID]
	if !ok || s.files[id] == nil {
		return false
	}
	writeJSON(w, 200, map[string]any{"existing": true, "node": s.files[id]})
	return true
}

func (s *Server) uploadSmall(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		fail(w, 400, "bad_request")
		return
	}
	f := map[string]string{}
	for k, v := range r.MultipartForm.Value {
		f[k] = v[0]
	}
	if s.existing(w, f["upload_id"]) {
		return
	}
	sp := s.parseSpec(w, f)
	if sp == nil {
		return
	}
	fh := r.MultipartForm.File["file"]
	if len(fh) == 0 {
		fail(w, 400, "bad_request")
		return
	}
	rd, _ := fh[0].Open()
	blob, _ := io.ReadAll(rd)
	rd.Close()
	if int64(len(blob)) > s.SmallUploadMax {
		fail(w, 400, "bad_request")
		return
	}
	s.commit(w, sp, blob)
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var in map[string]any
	if json.NewDecoder(r.Body).Decode(&in) != nil {
		fail(w, 400, "bad_request")
		return
	}
	f := map[string]string{}
	for k, v := range in {
		switch v := v.(type) {
		case string:
			f[k] = v
		case float64:
			f[k] = strconv.FormatInt(int64(v), 10)
		}
	}
	if s.existing(w, f["upload_id"]) {
		return
	}
	for _, sess := range s.sessions {
		if sess.uploadID == f["upload_id"] && sess.state == "open" {
			writeJSON(w, 200, sess.body())
			return
		}
	}
	if s.parseSpec(w, f) == nil {
		return
	}
	chunks, _ := strconv.Atoi(f["chunk_count"])
	size, _ := strconv.ParseInt(f["cipher_size"], 10, 64)
	sess := &session{id: fmt.Sprintf("sess-%d", len(s.sessions)+1+len(s.uploadIDs)), uploadID: f["upload_id"], fields: f, chunks: chunks,
		sha: f["cipher_sha256"], parts: map[int][]byte{}, state: "open", fileID: f["file_id"]}
	if f["mode"] == "e2ee" {
		sess.size = size
		sess.header, _ = e2ee.DecodeBase64(f["header_b64"])
		if len(sess.header) != e2ee.HeaderSize || chunks < 1 {
			fail(w, 400, "bad_request")
			return
		}
	} else {
		sess.size, _ = strconv.ParseInt(f["plain_size"], 10, 64)
	}
	if f["replace_file_id"] != "" {
		sess.fileID = f["replace_file_id"]
	}
	s.sessions[sess.id] = sess
	writeJSON(w, 201, sess.body())
}

func (s *Server) putPart(w http.ResponseWriter, r *http.Request, sess *session, idx string) {
	i, err := strconv.Atoi(idx)
	if err != nil || i < 0 || i >= sess.chunks || sess.state != "open" {
		fail(w, 400, "bad_request")
		return
	}
	body, _ := io.ReadAll(r.Body)
	sum := sha256.Sum256(body)
	if hex.EncodeToString(sum[:]) != r.Header.Get("X-Content-Sha256") {
		fail(w, 400, "bad_request")
		return
	}
	if old, ok := sess.parts[i]; ok {
		if !bytes.Equal(old, body) {
			fail(w, 409, "conflict")
			return
		}
	}
	sess.parts[i] = body
	writeJSON(w, 200, sess.body())
}

func (s *Server) complete(w http.ResponseWriter, sess *session) {
	if sess.state == "committed" {
		writeJSON(w, 200, map[string]any{"existing": true, "node": s.files[sess.fileID]})
		return
	}
	if s.existing(w, sess.uploadID) {
		return
	}
	var missing []int
	var blob []byte
	blob = append(blob, sess.header...)
	for i := 0; i < sess.chunks; i++ {
		p, ok := sess.parts[i]
		if !ok {
			missing = append(missing, i)
		}
		blob = append(blob, p...)
	}
	if missing != nil {
		writeJSON(w, 400, map[string]any{"error": "missing", "code": "bad_request", "missing": missing})
		return
	}
	sum := sha256.Sum256(blob)
	if int64(len(blob)) != sess.size || hex.EncodeToString(sum[:]) != sess.sha {
		sess.state = "aborted"
		fail(w, 400, "bad_request")
		return
	}
	sp := s.parseSpec(w, sess.fields)
	if sp == nil {
		return
	}
	if node := s.commit(w, sp, blob); node != nil {
		sess.state, sess.fileID = "committed", node.IDString()
	}
}

// commit validates the payload and creates or replaces the file.
func (s *Server) commit(w http.ResponseWriter, sp *spec, blob []byte) *api.Node {
	f := sp.f
	n := sp.replace
	encKey, keyNonce := f["encrypted_file_key"], f["file_key_nonce"]
	if n != nil {
		encKey, keyNonce = n.EncryptedFileKey, n.FileKeyNonce
	}
	if f["mode"] == "e2ee" {
		key, err := e2ee.UnwrapKeyB64(encKey, keyNonce, s.masterKey)
		if err != nil {
			fail(w, 400, "bad_request")
			return nil
		}
		if _, err := e2ee.DecryptData(blob, key); err != nil {
			fail(w, 400, "bad_request")
			return nil
		}
		s.trackNonce(key, blob)
	}
	sum := sha256.Sum256(blob)
	if f["mode"] == "standard" {
		sum = sha256.Sum256(append([]byte("std:"), blob...))
	}
	var meta, metaNonce *string
	if f["encrypted_meta"] != "" {
		m, mn := f["encrypted_meta"], f["meta_nonce"]
		meta, metaNonce = &m, &mn
	}
	status := 200
	if n == nil {
		status = 201
		id := f["file_id"]
		if id == "" {
			id = fmt.Sprintf("00000000-0000-4000-9000-%012d", len(s.files)+1)
		}
		n = &api.Node{Type: "file", ID: fileID(id), FolderID: sp.folder, IsE2E: f["mode"] == "e2ee", Name: f["name"],
			EncryptedName: f["encrypted_name"], NameNonce: f["name_nonce"], EncryptedFileKey: encKey, FileKeyNonce: keyNonce,
			StoredExtension: f["stored_extension"]}
		if n.IsE2E {
			n.Name = "encrypted"
		}
		s.files[id] = n
	}
	n.ContentVersion++
	n.Size, n.DiskSize, n.PayloadChecksum = int64(len(blob)), int64(len(blob)), hex.EncodeToString(sum[:])
	n.EncryptedMeta, n.MetaNonce, n.Seq = meta, metaNonce, s.nextSeq()
	s.blobs[n.IDString()] = blob
	s.uploadIDs[f["upload_id"]] = n.IDString()
	s.refreshLinks()
	writeJSON(w, status, n)
	return n
}

// trackNonce records (key, base nonce) and flags a reuse with other bytes.
func (s *Server) trackNonce(key, blob []byte) {
	if len(blob) < e2ee.HeaderSize {
		return
	}
	k := hex.EncodeToString(key) + "|" + hex.EncodeToString(blob[5:e2ee.HeaderSize])
	sum := sha256.Sum256(blob)
	if old, ok := s.nonces[k]; ok && old != hex.EncodeToString(sum[:]) {
		s.violations = append(s.violations, "base nonce reused under one file key")
	}
	s.nonces[k] = hex.EncodeToString(sum[:])
}

// NonceViolations lists (key, nonce) reuses seen in committed containers.
func (s *Server) NonceViolations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.violations...)
}

func (s *Server) mutate(w http.ResponseWriter, r *http.Request, kind, id, action string) {
	n := s.node(kind, id)
	if n == nil {
		fail(w, 404, "not_found")
		return
	}
	var in map[string]any
	json.NewDecoder(r.Body).Decode(&in)
	if v, ok := in["if_seq"].(float64); ok && int64(v) != n.Seq {
		failCurrent(w, 412, "precondition_failed", n)
		return
	}
	if action != "restore" && n.IsTrashed && action != "trash" {
		fail(w, 404, "not_found")
		return
	}
	str := func(k string) string { v, _ := in[k].(string); return v }
	switch action {
	case "move":
		key := "folder_id"
		if kind == "folder" {
			key = "parent_id"
		}
		var parent *int64
		if v, ok := in[key].(float64); ok {
			p := int64(v)
			if fo := s.folders[p]; fo == nil || fo.IsTrashed {
				fail(w, 404, "not_found")
				return
			}
			parent = &p
		}
		if kind == "folder" {
			me, _ := strconv.ParseInt(id, 10, 64)
			for q := parent; q != nil; q = s.folders[*q].ParentID {
				if *q == me {
					fail(w, 400, "bad_request")
					return
				}
			}
			n.ParentID = parent
		} else {
			n.FolderID = parent
		}
	case "rename":
		if n.IsE2E {
			n.EncryptedName, n.NameNonce = str("encrypted_name"), str("name_nonce")
			if kind == "file" {
				n.StoredExtension = str("stored_extension")
			}
		} else {
			n.Name = str("name")
		}
	case "trash":
		s.setTrashed(kind, id, true, s.seq+1)
		s.nextSeq()
		s.refreshLinks()
		writeJSON(w, 200, n)
		return
	case "restore":
		if !n.IsTrashed { // like the server: only items in the trash
			fail(w, 404, "not_found")
			return
		}
		s.setTrashed(kind, id, false, s.seq+1)
		s.nextSeq()
		s.refreshLinks()
		writeJSON(w, 200, n)
		return
	case "folder-link-key":
		s.setFolderLinkKey(w, in, n)
		return
	case "meta":
		if v, _ := in["if_content_version"].(float64); int64(v) != n.ContentVersion || !n.IsE2E {
			failCurrent(w, 412, "precondition_failed", n)
			return
		}
		m, mn := str("encrypted_meta"), str("meta_nonce")
		n.EncryptedMeta, n.MetaNonce = &m, &mn
	case "backup":
		// Device ids follow the tokens: dev_N belongs to device dN.
		dev := "d" + strings.TrimPrefix(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "dev_")
		if kind != "folder" || (n.IsBackup && *n.BackupDeviceID != dev) {
			fail(w, 403, "read_only")
			return
		}
		n.IsBackup, n.BackupDeviceID = in["enabled"] == true, nil
		if n.IsBackup {
			n.BackupDeviceID = &dev
		}
	default:
		fail(w, 404, "not_found")
		return
	}
	n.Seq = s.nextSeq()
	s.refreshLinks()
	writeJSON(w, 200, n)
}

// --- website side (test helpers) ---

// Folder returns a copy of a folder node (nil when unknown).
func (s *Server) Folder(id int64) *api.Node {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n := s.folders[id]; n != nil {
		c := *n
		return &c
	}
	return nil
}

// MarkBackup makes a folder the backup of another device.
func (s *Server) MarkBackup(id int64, device string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.folders[id]
	n.IsBackup, n.BackupDeviceID, n.Seq = true, &device, s.nextSeq()
}

func (s *Server) fileKey(n *api.Node) []byte {
	k, _ := e2ee.UnwrapKeyB64(n.EncryptedFileKey, n.FileKeyNonce, s.masterKey)
	return k
}

func (s *Server) setContent(n *api.Node, key, plain []byte) {
	blob, sum := plain, sha256.Sum256(append([]byte("std:"), plain...))
	if n.IsE2E {
		blob, _ = e2ee.EncryptData(plain, key)
		s.trackNonce(key, blob)
		sum = sha256.Sum256(blob)
	}
	n.ContentVersion++
	n.Size, n.DiskSize, n.PayloadChecksum = int64(len(blob)), int64(len(blob)), hex.EncodeToString(sum[:])
	n.EncryptedMeta, n.MetaNonce = nil, nil
	if s.WithMeta && n.IsE2E {
		ps := sha256.Sum256(plain)
		m, mn, _ := e2ee.EncryptMeta(e2ee.Meta{FileID: n.IDString(), ContentVersion: n.ContentVersion, PlainSize: int64(len(plain)),
			PlainSHA256: hex.EncodeToString(ps[:]), Mode: 0o644}, key)
		n.EncryptedMeta, n.MetaNonce = &m, &mn
	}
	n.Seq = s.nextSeq()
	s.blobs[n.IDString()] = blob
}

// AddFile creates an E2EE file with the given plaintext and returns its id.
func (s *Server) AddFile(folder *int64, name string, plain []byte) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := fmt.Sprintf("00000000-0000-4000-8000-%012d", len(s.files)+1)
	for s.files[id] != nil {
		id = fmt.Sprintf("00000000-0000-4000-8000-%012d", len(s.files)+len(id))
	}
	fk, _ := e2ee.RandomBytes(e2ee.KeySize)
	en, nn, _ := e2ee.EncryptName(name, fk)
	wk, wn, _ := e2ee.WrapKey(fk, s.masterKey)
	n := &api.Node{Type: "file", ID: fileID(id), FolderID: folder, IsE2E: true,
		Name: "encrypted", EncryptedName: e2ee.EncodeBase64(en), NameNonce: e2ee.EncodeBase64(nn),
		EncryptedFileKey: e2ee.EncodeBase64(wk), FileKeyNonce: e2ee.EncodeBase64(wn), StoredExtension: e2ee.ExtractExtension(name)}
	s.files[id] = n
	s.setContent(n, fk, plain)
	return id
}

// EditFile replaces a file's content like the website editor (same key).
func (s *Server) EditFile(id string, plain []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n := s.files[id]; n != nil {
		s.setContent(n, s.fileKey(n), plain)
	}
}

// Rename renames a node (E2EE names re-encrypted with its own key).
func (s *Server) Rename(kind, id, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.node(kind, id)
	if n == nil {
		return
	}
	var key []byte
	if kind == "folder" {
		key, _ = e2ee.UnwrapKeyB64(n.EncryptedNameKey, n.NameKeyNonce, s.masterKey)
	} else {
		key = s.fileKey(n)
		n.StoredExtension = e2ee.ExtractExtension(name)
	}
	en, nn, _ := e2ee.EncryptName(name, key)
	n.EncryptedName, n.NameNonce, n.Seq = e2ee.EncodeBase64(en), e2ee.EncodeBase64(nn), s.nextSeq()
}

// Move moves a node into parent (nil = root).
func (s *Server) Move(kind, id string, parent *int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.node(kind, id)
	if n == nil {
		return
	}
	if kind == "folder" {
		n.ParentID = parent
	} else {
		n.FolderID = parent
	}
	n.Seq = s.nextSeq()
}

// Entry is one item of Snapshot.
type Entry struct {
	Kind    string // file | folder
	ID      string
	Path    string // '/'-separated below the snapshot root
	Plain   []byte // files
	Trashed bool
}

func (s *Server) name(n *api.Node) string {
	if !n.IsE2E {
		return n.Name
	}
	var key []byte
	if n.Type == "folder" {
		key, _ = e2ee.UnwrapKeyB64(n.EncryptedNameKey, n.NameKeyNonce, s.masterKey)
	} else {
		key = s.fileKey(n)
	}
	name, err := e2ee.DecryptName(n.EncryptedName, n.NameNonce, key)
	if err != nil {
		return "<undecryptable>"
	}
	return name
}

func (s *Server) plain(n *api.Node) []byte {
	blob := s.blobs[n.IDString()]
	if !n.IsE2E {
		return blob
	}
	p, err := e2ee.DecryptData(blob, s.fileKey(n))
	if err != nil {
		return nil
	}
	return p
}

// Snapshot returns every node below root (nil = drive root) with decrypted
// names and content; trashed ones are included and marked (their paths are
// where they were).
func (s *Server) Snapshot(root *int64) []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Entry
	var walk func(parent *int64, dir string, trashed bool)
	walk = func(parent *int64, dir string, trashed bool) {
		for id, f := range s.folders {
			if sameParent(f.ParentID, parent) {
				p := path.Join(dir, s.name(f))
				out = append(out, Entry{Kind: "folder", ID: strconv.FormatInt(id, 10), Path: p, Trashed: trashed || f.IsTrashed})
				fid := id
				walk(&fid, p, trashed || f.IsTrashed)
			}
		}
		for id, f := range s.files {
			if sameParent(f.FolderID, parent) {
				out = append(out, Entry{Kind: "file", ID: id, Path: path.Join(dir, s.name(f)), Plain: s.plain(f), Trashed: trashed || f.IsTrashed})
			}
		}
	}
	walk(root, "", false)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func sameParent(a, b *int64) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
