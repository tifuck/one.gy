//go:build livedev

package syncer

// Live test against a real one.gy server (never run in CI). It builds the
// engine and onegyctl, signs in a throwaway account and checks a two-way
// sync end to end; a second device token plays the website.
//
//	ONEGY_LIVE_SERVER=https://<dev server> ONEGY_LIVE_USER=… ONEGY_LIVE_PASS=… \
//	  go test -tags livedev -run TestLive -v ./internal/syncer/
//
// Add ONEGY_LIVE_DEVTLS=1 for a server with a self-signed certificate (the
// engine is then built with -tags devtls and started with --insecure-tls).

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	osexec "os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"onegy/e2ee"
)

type live struct {
	t      *testing.T
	bin    string
	state  string
	sock   string
	server string
	devtls bool
	eng    *osexec.Cmd
	web    *api.Client
	mk     []byte
}

func (l *live) start() {
	args := []string{"--state-dir", l.state, "--socket", l.sock, "--log-level", "info"}
	if l.devtls {
		args = append(args, "--insecure-tls")
	}
	l.eng = osexec.Command(filepath.Join(l.bin, "onegy-engine"), args...)
	if err := l.eng.Start(); err != nil {
		l.t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(l.sock); err == nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	l.t.Fatal("engine did not start")
}

// call runs onegyctl and decodes the result.
func (l *live) call(method string, params any) any {
	l.t.Helper()
	b, _ := json.Marshal(params)
	out, err := osexec.Command(filepath.Join(l.bin, "onegyctl"), "--socket", l.sock, "call", method, string(b)).Output()
	if err != nil {
		msg := ""
		if ee, ok := err.(*osexec.ExitError); ok {
			msg = string(ee.Stderr)
		}
		l.t.Fatalf("%s: %v %s", method, err, msg)
	}
	var v any
	json.Unmarshal(out, &v)
	return v
}

func (l *live) obj(method string, params any) map[string]any {
	l.t.Helper()
	m, _ := l.call(method, params).(map[string]any)
	return m
}

func waitLive(t *testing.T, what string, limit time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// remoteTree lists the subtree under root with decrypted names and contents.
func (l *live) remoteTree(root int64) map[string]string {
	ctx := context.Background()
	out := map[string]string{}
	paths := map[int64]string{root: ""}
	tok := ""
	var folders, files []api.Node
	for {
		tr, err := l.web.Tree(ctx, root, tok, 2000)
		if err != nil {
			l.t.Fatal(err)
		}
		folders, files = append(folders, tr.Folders...), append(files, tr.Files...)
		if tr.NextPageToken == "" {
			break
		}
		tok = tr.NextPageToken
	}
	for len(folders) > 0 {
		var rest []api.Node
		for _, f := range folders {
			p, ok := paths[*f.ParentID]
			if !ok {
				rest = append(rest, f)
				continue
			}
			id, _ := strconv.ParseInt(f.IDString(), 10, 64)
			paths[id] = path.Join(p, l.name(&f))
			out[paths[id]] = "<dir>"
		}
		if len(rest) == len(folders) {
			break
		}
		folders = rest
	}
	for _, f := range files {
		p, ok := paths[*f.FolderID]
		if !ok {
			continue
		}
		out[path.Join(p, l.name(&f))] = l.content(&f)
	}
	return out
}

func (l *live) key(n *api.Node) []byte {
	enc, nonce := n.EncryptedFileKey, n.FileKeyNonce
	if n.Type == "folder" {
		enc, nonce = n.EncryptedNameKey, n.NameKeyNonce
	}
	k, err := e2ee.UnwrapKeyB64(enc, nonce, l.mk)
	if err != nil {
		l.t.Fatal(err)
	}
	return k
}

func (l *live) name(n *api.Node) string {
	if !n.IsE2E {
		return n.Name
	}
	name, err := e2ee.DecryptName(n.EncryptedName, n.NameNonce, l.key(n))
	if err != nil {
		l.t.Fatal(err)
	}
	return name
}

func (l *live) content(n *api.Node) string {
	var buf bytes.Buffer
	if _, err := l.web.Content(context.Background(), n.IDString(), &buf, 0, ""); err != nil {
		l.t.Fatal(err)
	}
	p, err := e2ee.DecryptData(buf.Bytes(), l.key(n))
	if err != nil {
		l.t.Fatal(err)
	}
	if len(p) > 64 {
		s := sha256.Sum256(p)
		return "sha:" + hex.EncodeToString(s[:])
	}
	return string(p)
}

func (l *live) find(root int64, name string) *api.Node {
	tr, err := l.web.Tree(context.Background(), root, "", 2000)
	if err != nil {
		l.t.Fatal(err)
	}
	for _, list := range [][]api.Node{tr.Folders, tr.Files} {
		for i := range list {
			if l.name(&list[i]) == name {
				return &list[i]
			}
		}
	}
	l.t.Fatalf("remote %s not found", name)
	return nil
}

// webUpload adds or replaces a file like the website (E2EE, own key).
func (l *live) webUpload(folder int64, name string, plain []byte, replace *api.Node) {
	f := api.UploadFields{"upload_id": "live-" + hex.EncodeToString(randBytes(8)), "mode": "e2ee"}
	var key []byte
	if replace != nil {
		key = l.key(replace)
		f["replace_file_id"], f["base_content_version"] = replace.IDString(), strconv.FormatInt(replace.ContentVersion, 10)
	} else {
		key = randBytes(32)
		wk, wn, _ := e2ee.WrapKey(key, l.mk)
		en, nn, _ := e2ee.EncryptName(name, key)
		f["folder_id"] = strconv.FormatInt(folder, 10)
		f["encrypted_file_key"], f["file_key_nonce"] = e2ee.EncodeBase64(wk), e2ee.EncodeBase64(wn)
		f["encrypted_name"], f["name_nonce"], f["stored_extension"] = e2ee.EncodeBase64(en), e2ee.EncodeBase64(nn), e2ee.ExtractExtension(name)
	}
	blob, _ := e2ee.EncryptData(plain, key)
	if _, _, err := l.web.UploadSmall(context.Background(), f, blob, nil); err != nil {
		l.t.Fatal(err)
	}
}

// waitRemoteFile waits until exactly one file called name sits in folder
// with plain's size, then downloads and decrypts it and compares.
func (l *live) waitRemoteFile(folder int64, name string, plain []byte, limit time.Duration) {
	l.t.Helper()
	var found []api.Node
	waitLive(l.t, name+" on one.gy", limit, func() bool {
		tr, err := l.web.Tree(context.Background(), folder, "", 2000)
		if err != nil {
			l.t.Fatal(err)
		}
		found = found[:0]
		for _, f := range tr.Files {
			if (f.FolderID != nil && *f.FolderID == folder) && l.name(&f) == name {
				found = append(found, f)
			}
		}
		return len(found) > 0 && found[0].Size == int64(len(plain))+int64(e2ee.HeaderSize)+20*int64((len(plain)+e2ee.ChunkSize-1)/e2ee.ChunkSize)
	})
	if len(found) != 1 {
		l.t.Fatalf("%s exists %d times on one.gy", name, len(found))
	}
	var buf bytes.Buffer
	if _, err := l.web.Content(context.Background(), found[0].IDString(), &buf, 0, found[0].PayloadChecksum); err != nil {
		l.t.Fatal(err)
	}
	got, err := e2ee.DecryptData(buf.Bytes(), l.key(&found[0]))
	if err != nil || !bytes.Equal(got, plain) {
		l.t.Fatalf("%s does not round-trip (%v, %d of %d bytes)", name, err, len(got), len(plain))
	}
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

func localTree(root string) map[string]string {
	out := map[string]string{}
	filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err != nil || p == root {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if rel == ".onegy" {
			return filepath.SkipDir
		}
		if fi.IsDir() {
			out[rel] = "<dir>"
			return nil
		}
		b, _ := os.ReadFile(p)
		if len(b) > 64 {
			s := sha256.Sum256(b)
			out[rel] = "sha:" + hex.EncodeToString(s[:])
		} else {
			out[rel] = string(b)
		}
		return nil
	})
	return out
}

func writeOld(t *testing.T, p string, data []byte) {
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Minute) // past the quiet period
	os.Chtimes(p, old, old)
}

func TestLive(t *testing.T) {
	server, user, pass := os.Getenv("ONEGY_LIVE_SERVER"), os.Getenv("ONEGY_LIVE_USER"), os.Getenv("ONEGY_LIVE_PASS")
	if server == "" || user == "" || pass == "" {
		t.Skip("set ONEGY_LIVE_SERVER, ONEGY_LIVE_USER and ONEGY_LIVE_PASS")
	}
	work, err := os.MkdirTemp("", "onegy-live-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("work dir %s", work)
	l := &live{t: t, bin: filepath.Join(work, "bin"), state: filepath.Join(work, "state"), sock: filepath.Join(work, "e.sock"),
		server: server, devtls: os.Getenv("ONEGY_LIVE_DEVTLS") == "1"}
	tags := []string{}
	if l.devtls {
		tags = []string{"-tags", "devtls"}
	}
	for _, cmd := range []string{"onegy-engine", "onegyctl"} {
		b := osexec.Command("go", append(append([]string{"build"}, tags...), "-o", filepath.Join(l.bin, cmd), "../../cmd/"+cmd)...)
		if out, err := b.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v %s", cmd, err, out)
		}
	}
	l.start()
	defer func() {
		if l.eng.ProcessState == nil {
			l.eng.Process.Kill()
			l.eng.Wait()
		}
	}()

	// The "website": a second device of the same account.
	ctx := context.Background()
	web, err := api.New(server, api.Options{Version: "0.1.0", InsecureTLS: false})
	if err != nil {
		t.Fatal(err)
	}
	pre, err := web.PreLogin(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	authTok, wrap, err := e2ee.DeriveAuthAndWrappingKeys(pass, pre.AuthTokenSalt)
	if err != nil {
		t.Fatal(err)
	}
	auth, err := web.Authorize(ctx, api.AuthorizeRequest{Username: user, AuthToken: authTok, DeviceName: "LIVE-WEB", Platform: "linux", ClientVersion: "0.1.0"})
	if err != nil {
		t.Fatal(err)
	}
	web.SetToken(auth.DeviceToken)
	defer web.DeleteDevice(ctx)
	keys, err := web.Keys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if l.mk, err = e2ee.UnwrapKeyB64(keys.EncryptedMasterKey, keys.MasterKeyNonce, wrap); err != nil {
		t.Fatal(err)
	}
	l.web = web

	st := l.obj("account.authorize", map[string]any{"server": server, "username": user, "password": pass, "device_name": "LIVE1"})
	if st["signed_in"] != true {
		t.Fatalf("authorize %v", st)
	}
	folder := l.obj("remote.createFolder", map[string]any{"parent_id": nil, "name": "live " + hex.EncodeToString(randBytes(3)), "e2ee": true})
	root := int64(folder["id"].(float64))
	defer web.TrashFolder(ctx, root, nil)

	// (a) local -> one.gy, including a file large enough for an upload session.
	local := filepath.Join(work, "local")
	big := randBytes(9 << 20)
	writeOld(t, filepath.Join(local, "a.txt"), []byte("alpha"))
	writeOld(t, filepath.Join(local, "sub", "b.txt"), []byte("bravo"))
	writeOld(t, filepath.Join(local, "nested", "deep", "c.txt"), []byte("charlie"))
	writeOld(t, filepath.Join(local, "ünï cødé.txt"), []byte("unicode"))
	writeOld(t, filepath.Join(local, "big.bin"), big)
	s := l.obj("syncs.create", map[string]any{"config": map[string]any{"local_path": local, "remote_folder_id": root, "type": "two_way"}})
	sid := s["id"].(string)
	t0 := time.Now()
	waitLive(t, "local files on one.gy", 3*time.Minute, func() bool {
		r := l.remoteTree(root)
		return r["a.txt"] == "alpha" && r["sub/b.txt"] == "bravo" && r["nested/deep/c.txt"] == "charlie" && r["ünï cødé.txt"] == "unicode" &&
			r["big.bin"] == localTree(local)["big.bin"]
	})
	t.Logf("(a) uploaded tree incl. 9 MiB session upload in %v", time.Since(t0).Round(time.Millisecond))

	// (b) website changes -> local mirror.
	l.webUpload(root, "web.txt", []byte("from web"), nil)
	a := l.find(root, "a.txt")
	ak := l.key(a)
	en, nn, _ := e2ee.EncryptName("a-renamed.txt", ak)
	ext := ".txt"
	if _, err := web.RenameFile(ctx, a.IDString(), api.RenameRequest{EncryptedName: e2ee.EncodeBase64(en), NameNonce: e2ee.EncodeBase64(nn), StoredExtension: &ext}); err != nil {
		t.Fatal(err)
	}
	sub := l.find(root, "sub")
	subID, _ := strconv.ParseInt(sub.IDString(), 10, 64)
	b := l.find(subID, "b.txt")
	if _, err := web.MoveFile(ctx, b.IDString(), &root, nil); err != nil {
		t.Fatal(err)
	}
	nested := l.find(root, "nested")
	nestedID, _ := strconv.ParseInt(nested.IDString(), 10, 64)
	if _, err := web.TrashFolder(ctx, nestedID, nil); err != nil {
		t.Fatal(err)
	}
	t0 = time.Now()
	l.call("engine.nudge", nil)
	waitLive(t, "website changes locally", 2*time.Minute, func() bool {
		lt := localTree(local)
		_, oldA := lt["a.txt"]
		_, oldB := lt["sub/b.txt"]
		_, oldN := lt["nested"]
		return lt["web.txt"] == "from web" && lt["a-renamed.txt"] == "alpha" && lt["b.txt"] == "bravo" && !oldA && !oldB && !oldN
	})
	debris, _ := filepath.Glob(filepath.Join(local, ".onegy", "debris", "*", "nested", "deep", "c.txt"))
	if len(debris) != 1 {
		t.Fatalf("trashed folder not in debris: %v", debris)
	}
	t.Logf("(b) web upload, rename, move, folder trash mirrored in %v (trashed folder kept in debris)", time.Since(t0).Round(time.Millisecond))

	// (c) concurrent edit -> conflict copy.
	l.call("syncs.pause", map[string]any{"id": sid})
	writeOld(t, filepath.Join(local, "a-renamed.txt"), []byte("local edit"))
	l.webUpload(root, "", []byte("web edit"), l.find(root, "a-renamed.txt"))
	l.call("syncs.resume", map[string]any{"id": sid})
	l.call("engine.nudge", nil)
	waitLive(t, "conflict copy", 2*time.Minute, func() bool {
		lt, rt := localTree(local), l.remoteTree(root)
		for p, v := range lt {
			if strings.HasPrefix(p, "a-renamed (conflict from LIVE1") && v == "local edit" && rt[p] == "local edit" {
				return lt["a-renamed.txt"] == "web edit" && rt["a-renamed.txt"] == "web edit"
			}
		}
		return false
	})
	t.Log("(c) concurrent edit: one.gy version kept the name, local edit uploaded as a conflict copy")

	// (e) a one-shot upload at the size limit: container == small_upload_max.
	caps, err := web.Capabilities(ctx)
	if err != nil {
		t.Fatal(err)
	}
	oneshot := randBytes(int(caps.SmallUploadMax) - e2ee.HeaderSize - 20)
	writeOld(t, filepath.Join(local, "oneshot.bin"), oneshot)
	l.call("syncs.syncNow", map[string]any{"id": sid})
	l.waitRemoteFile(root, "oneshot.bin", oneshot, 3*time.Minute)
	t.Logf("(e) one-shot upload of %d plaintext bytes (container = small_upload_max %d) round-trips", len(oneshot), caps.SmallUploadMax)

	// (d) kill -9 during a three-part session upload (64 + 64 + 22 MiB),
	// after part 0 was stored; restart resumes from the spool.
	l.obj("settings.set", map[string]any{"patch": map[string]any{"upload_kbps": 8 * 1024}})
	huge := randBytes(150 << 20)
	writeOld(t, filepath.Join(local, "huge.bin"), huge)
	l.call("syncs.syncNow", map[string]any{"id": sid})
	waitLive(t, "part 0 stored", 5*time.Minute, func() bool {
		for _, tr := range l.call("transfers.list", map[string]any{"state": "active"}).([]any) {
			m := tr.(map[string]any)
			if m["path"] == "huge.bin" && m["done"].(float64) >= 64<<20 {
				return true
			}
		}
		return false
	})
	l.eng.Process.Signal(syscall.SIGKILL)
	l.eng.Wait()
	os.Remove(l.sock)
	t.Log("(d) engine killed with SIGKILL after part 0 of huge.bin was stored")
	l.start()
	if l.obj("account.status", nil)["locked"] == true { // no OS key store here: secrets were memory-only
		l.obj("account.unlock", map[string]any{"password": pass})
	}
	l.obj("settings.set", map[string]any{"patch": map[string]any{"upload_kbps": 0}})
	l.waitRemoteFile(root, "huge.bin", huge, 10*time.Minute)
	t.Log("(d) after the restart the journaled upload resumed; huge.bin committed once and round-trips")

	if issues := l.call("issues.list", map[string]any{"sync_id": sid}).([]any); len(issues) != 0 {
		t.Fatalf("open issues: %v", issues)
	}
	l.call("syncs.remove", map[string]any{"id": sid})
	l.call("account.signOut", map[string]any{"revoke": true})
	l.call("engine.shutdown", nil)
	l.eng.Wait()
	fmt.Println("live test done")
}
