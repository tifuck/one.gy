package fakeserver

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tifuck/one.gy/client/e2ee"
	"github.com/tifuck/one.gy/client/internal/api"
)

// Device security (sync-api.md "Device security"): signed requests, the
// unlock share, PIN, grants, scope and web-session tickets. The scope is
// stored, not enforced (the real server's enforcement is tested in testsv2).

type devSec struct {
	pop      *ecdsa.PublicKey
	share    string
	mshare   string
	pinProof string
	failures int
	strict   bool
	lock     bool
	grant    string
	Scope    json.RawMessage
}

func (s *Server) devSec(tokenHash string) *devSec {
	if s.sec == nil {
		s.sec = map[string]*devSec{}
	}
	d := s.sec[tokenHash]
	if d == nil {
		b, _ := e2ee.RandomBytes(32)
		m, _ := e2ee.RandomBytes(32)
		d = &devSec{share: e2ee.EncodeBase64(b), mshare: e2ee.EncodeBase64(m)}
		s.sec[tokenHash] = d
	}
	return d
}

// DeviceScope returns the last scope a device sent (raw JSON, nil if none).
func (s *Server) DeviceScope() json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, d := range s.sec {
		if d.Scope != nil {
			return d.Scope
		}
	}
	return nil
}

// SignedDevices counts devices that enrolled a signing key.
func (s *Server) SignedDevices() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, d := range s.sec {
		if d.pop != nil {
			n++
		}
	}
	return n
}

func parsePop(b64 string) *ecdsa.PublicKey {
	der, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil
	}
	pub, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil
	}
	k, _ := pub.(*ecdsa.PublicKey)
	return k
}

func signatureOK(r *http.Request, k *ecdsa.PublicKey) bool {
	ts, err := strconv.ParseInt(r.Header.Get("X-Onegy-Pop-Ts"), 10, 64)
	if err != nil || time.Since(time.Unix(ts, 0)).Abs() > 5*time.Minute {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Onegy-Pop-Sig"))
	if err != nil {
		return false
	}
	path := r.URL.Path
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d\n%s\n%s", ts, r.Method, path)))
	return ecdsa.VerifyASN1(k, sum[:], sig)
}

func (d *devSec) json() map[string]any {
	return map[string]any{"lock_enabled": d.lock, "pin_set": d.pinProof != "", "pin_strict": d.strict,
		"pin_attempts_left": 5 - d.failures, "signed_requests": d.pop != nil}
}

// securityRoute serves /apiv1/devices/self/* security routes; false = not one.
func (s *Server) securityRoute(w http.ResponseWriter, r *http.Request, d *devSec) bool {
	p := r.URL.Path
	if !strings.HasPrefix(p, "/apiv1/devices/self/") {
		return false
	}
	var in map[string]any
	json.NewDecoder(r.Body).Decode(&in)
	str := func(k string) string { v, _ := in[k].(string); return v }
	hasGrant := d.grant != "" && r.Header.Get("X-Onegy-Grant") == d.grant
	newGrant := func() string {
		b, _ := e2ee.RandomBytes(16)
		d.grant = "dgr_" + e2ee.EncodeBase64(b)
		return d.grant
	}
	switch {
	case p == "/apiv1/devices/self/pop-key" && r.Method == "POST":
		if d.pop != nil {
			fail(w, 409, "conflict")
			return true
		}
		d.pop = parsePop(str("public_key"))
		writeJSON(w, 200, d.json())
	case p == "/apiv1/devices/self/unlock" && r.Method == "POST":
		switch {
		case str("auth_token") != "":
			if str("auth_token") != s.authToken {
				fail(w, 401, "invalid_credentials")
				return true
			}
			d.lock = true
		case str("pin_proof") != "":
			if d.pinProof == "" {
				fail(w, 409, "pin_locked")
				return true
			}
			if str("pin_proof") != d.pinProof {
				d.failures++
				if d.failures >= 5 {
					d.pinProof, d.grant = "", ""
					fail(w, 409, "pin_locked")
					return true
				}
				writeJSON(w, 401, map[string]any{"error": "Wrong PIN", "code": "invalid_pin", "attempts_left": 5 - d.failures})
				return true
			}
		default:
			if d.strict {
				fail(w, 401, "pin_required")
				return true
			}
			out := d.json()
			out["unlock_share"] = d.share
			writeJSON(w, 200, out)
			return true
		}
		d.failures = 0
		out := d.json()
		out["unlock_share"], out["master_share"], out["grant"] = d.share, d.mshare, newGrant()
		writeJSON(w, 200, out)
	case p == "/apiv1/devices/self/grant" && r.Method == "DELETE":
		d.grant = ""
		w.WriteHeader(204)
	case !hasGrant:
		fail(w, 403, "grant_required")
	case p == "/apiv1/devices/self/grant" && r.Method == "POST":
		writeJSON(w, 200, map[string]any{"grant_expires_at": "2099-01-01T00:00:00Z"})
	case p == "/apiv1/devices/self/pin" && r.Method == "PUT":
		d.pinProof, d.failures, d.lock = str("pin_proof"), 0, true
		d.strict, _ = in["strict"].(bool)
		writeJSON(w, 200, d.json())
	case p == "/apiv1/devices/self/pin" && r.Method == "DELETE":
		d.pinProof, d.failures, d.strict = "", 0, false
		writeJSON(w, 200, d.json())
	case p == "/apiv1/devices/self/scope" && r.Method == "PUT":
		d.Scope, _ = json.Marshal(in)
		writeJSON(w, 200, in)
	case p == "/apiv1/devices/self/web-session" && r.Method == "POST":
		writeJSON(w, 200, map[string]any{"ticket": "wst_test", "expires_in": 60})
	default:
		fail(w, 404, "not_found")
	}
	return true
}

// treeKeys serves POST /apiv1/sync/tree-keys (folder keys compare-and-set).
func (s *Server) treeKeys(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Folders []struct {
			ID        int64   `json:"id"`
			Wrap      *string `json:"tree_key_wrap"`
			Nonce     string  `json:"tree_key_nonce"`
			Parent    *int64  `json:"tree_key_parent_id"`
			If        *string `json:"if_tree_key_wrap"`
			NameWrap  *string `json:"tree_name_key_wrap"`
			NameNonce string  `json:"tree_name_key_nonce"`
		} `json:"folders"`
		Files []struct {
			ID     string `json:"id"`
			Wrap   string `json:"tree_file_key_wrap"`
			Nonce  string `json:"tree_file_key_nonce"`
			Folder int64  `json:"tree_key_folder_id"`
		} `json:"files"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil {
		fail(w, 400, "bad_request")
		return
	}
	out := map[string]any{"folders": []*api.Node{}, "files": []*api.Node{}, "conflicts": []int64{}}
	seq := s.nextSeq()
	for _, f := range in.Folders {
		n := s.folders[f.ID]
		if n == nil {
			fail(w, 404, "not_found")
			return
		}
		cur := ""
		if f.If != nil {
			cur = *f.If
		}
		if f.Wrap != nil {
			if cur != n.TreeKeyWrap {
				out["conflicts"] = append(out["conflicts"].([]int64), f.ID)
				out["folders"] = append(out["folders"].([]*api.Node), n)
				continue
			}
			n.TreeKeyWrap, n.TreeKeyNonce, n.TreeKeyParentID = *f.Wrap, f.Nonce, f.Parent
		}
		if f.NameWrap != nil {
			n.TreeNameKeyWrap, n.TreeNameKeyNonce = *f.NameWrap, f.NameNonce
		}
		n.Seq = seq
		out["folders"] = append(out["folders"].([]*api.Node), n)
	}
	for _, f := range in.Files {
		n := s.files[f.ID]
		if n == nil {
			fail(w, 404, "not_found")
			return
		}
		folder := f.Folder
		n.TreeFileKeyWrap, n.TreeFileKeyNonce, n.TreeKeyFolderID, n.Seq = f.Wrap, f.Nonce, &folder, seq
		out["files"] = append(out["files"].([]*api.Node), n)
	}
	writeJSON(w, 200, out)
}

// TreeWraps counts folders and files that carry key-tree wraps.
func (s *Server) TreeWraps() (folders, files int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, n := range s.folders {
		if n.TreeKeyWrap != "" {
			folders++
		}
	}
	for _, n := range s.files {
		if n.TreeFileKeyWrap != "" {
			files++
		}
	}
	return folders, files
}
