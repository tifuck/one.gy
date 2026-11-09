package fakeserver

import (
	"fmt"
	"net/http"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"onegy/e2ee"
)

// Link-shared folders (sync-api.md "Link-shared folders"): ShareFolder plays
// the website sharing a folder; nodes then carry folder_link_share_token and
// needs_folder_link_key, and POST /files/<id>/folder-link-key stores a wrap.
// The nearest shared ancestor governs (the server also prefers a browsable
// one further up; the fake has no browsable flag).

type linkWrap struct{ token, key, nonce string }

// ShareFolder marks a folder as link-shared and returns its share token.
func (s *Server) ShareFolder(id int64) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	tok := fmt.Sprintf("share-%d", id)
	s.shares[id] = tok
	return tok
}

// FolderLinkFileKey returns a file's key as a visitor of its folder link
// unwraps it (nil: no wrap, or a wrap for another token).
func (s *Server) FolderLinkFileKey(fileID string) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, w := s.files[fileID], s.wraps[fileID]
	if n == nil || w.token == "" || w.token != s.linkToken(n.FolderID) {
		return nil
	}
	_, lk, _ := e2ee.DeriveLinkSecret(s.masterKey, "folder", w.token)
	k, err := e2ee.UnwrapKeyB64(w.key, w.nonce, lk)
	if err != nil {
		return nil
	}
	return k
}

// linkToken is the share token governing files placed in folder ("" = none).
func (s *Server) linkToken(folder *int64) string {
	for q, depth := folder, 0; q != nil && depth < 1000; depth++ {
		f := s.folders[*q]
		if f == nil || f.IsTrashed {
			return ""
		}
		if tok := s.shares[*q]; tok != "" {
			return tok
		}
		q = f.ParentID
	}
	return ""
}

// refreshLinks recomputes the link fields of every node before an answer.
func (s *Server) refreshLinks() {
	if len(s.shares) == 0 {
		return
	}
	ptr := func(tok string) *string {
		if tok == "" {
			return nil
		}
		return &tok
	}
	for id, f := range s.folders {
		fid := id
		f.FolderLinkShareToken = ptr(s.linkToken(&fid))
	}
	for id, f := range s.files {
		tok := s.linkToken(f.FolderID)
		f.FolderLinkShareToken = ptr(tok)
		f.NeedsFolderLinkKey = f.IsE2E && tok != "" && s.wraps[id].token != tok
	}
}

func (s *Server) setFolderLinkKey(w http.ResponseWriter, in map[string]any, n *api.Node) {
	str := func(k string) string { v, _ := in[k].(string); return v }
	tok, key, nonce := str("folder_link_share_token"), str("folder_link_encrypted_file_key"), str("folder_link_file_key_nonce")
	if tok == "" || key == "" || nonce == "" || !n.IsE2E {
		fail(w, 400, "bad_request")
		return
	}
	if tok != s.linkToken(n.FolderID) {
		s.refreshLinks()
		failCurrent(w, 409, "conflict", n)
		return
	}
	s.wraps[n.IDString()] = linkWrap{tok, key, nonce}
	s.refreshLinks()
	writeJSON(w, 200, n)
}
