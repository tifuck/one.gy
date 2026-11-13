package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testClient(t *testing.T, h http.HandlerFunc) (*Client, *[]time.Duration) {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	c, err := New(srv.URL, Options{Version: "0.1.0", ProxyURL: "direct", MaxRetries: 3})
	if err != nil {
		t.Fatal(err)
	}
	c.http = srv.Client()
	var waits []time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	c.SetToken("dev_test")
	return c, &waits
}

func TestNewValidatesServer(t *testing.T) {
	for _, s := range []string{"http://x.example", "https://", "https://u:p@x.example", "https://x.example/sub", "ftp://x"} {
		if _, err := New(s, Options{}); err == nil {
			t.Errorf("accepted %q", s)
		}
	}
	if _, err := New("https://x.example/", Options{InsecureTLS: true}); err == nil && !DevTLS {
		t.Error("insecure TLS accepted in a release build")
	}
	c, err := New("https://x.example/", Options{})
	if err != nil || c.Server() != "https://x.example" {
		t.Fatalf("%v %v", c, err)
	}
}

func TestHeadersAndErrors(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("X-Onegy-Client"), "onegy-desktop/0.1.0 (") || r.Header.Get("Authorization") != "Bearer dev_test" {
			t.Errorf("headers: %v", r.Header)
		}
		w.WriteHeader(412)
		w.Write([]byte(`{"error":"changed","code":"precondition_failed","current":{"type":"file","id":"u1","seq":9}}`))
	})
	_, err := c.TrashFile(context.Background(), "u1", ptr(3))
	var e *Error
	if !errors.As(err, &e) || e.Code != "precondition_failed" || !strings.Contains(string(e.Current), `"seq":9`) {
		t.Fatalf("err = %#v", err)
	}
	if !IsCode(err, "precondition_failed") {
		t.Fatal("IsCode")
	}
}

func TestRetryHonoursRetryAfterAndStopsOn4xx(t *testing.T) {
	var calls int32
	c, waits := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch atomic.AddInt32(&calls, 1) {
		case 1:
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(429)
		case 2:
			w.WriteHeader(503)
		default:
			w.Write([]byte(`{"seq": 5}`))
		}
	})
	seq, _, changed, err := c.Cursor(context.Background(), "")
	if err != nil || seq != 5 || !changed || calls != 3 {
		t.Fatalf("seq=%d changed=%v err=%v calls=%d", seq, changed, err, calls)
	}
	if (*waits)[0] != 7*time.Second || (*waits)[1] < 800*time.Millisecond || (*waits)[1] > 2400*time.Millisecond {
		t.Fatalf("waits %v", *waits)
	}

	calls = 0
	c2, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(404)
		w.Write([]byte(`{"error":"gone","code":"not_found"}`))
	})
	if _, err := c2.Me(context.Background()); !IsCode(err, "not_found") || calls != 1 {
		t.Fatalf("4xx retried: calls=%d err=%v", calls, err)
	}
}

func TestRetryCapAndBackoff(t *testing.T) {
	c, waits := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "100000")
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"busy","code":"busy"}`))
	})
	if _, err := c.Me(context.Background()); !IsCode(err, "busy") {
		t.Fatalf("err %v", err)
	}
	if len(*waits) != 3 || (*waits)[0] != maxBackoff {
		t.Fatalf("waits %v", *waits)
	}
	for i := 0; i < 40; i++ {
		if d := backoff(i); d > maxBackoff*12/10 || d <= 0 {
			t.Fatalf("backoff(%d) = %v", i, d)
		}
	}
}

func TestAuthorizeNotRetriedOnTransportError(t *testing.T) {
	var calls int32
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		hj, _ := w.(http.Hijacker)
		conn, _, _ := hj.Hijack()
		conn.Close()
	})
	_, err := c.Authorize(context.Background(), AuthorizeRequest{Username: "a"})
	if !errors.Is(err, ErrOffline) || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	if _, err := c.Keys(context.Background()); !errors.Is(err, ErrOffline) || calls != 5 {
		t.Fatalf("idempotent call not retried: calls=%d err=%v", calls, err)
	}
}

func TestRevokedHookAndNoToken(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"revoked","code":"device_revoked"}`))
	})
	var fired int32
	c.OnRevoked(func() { atomic.AddInt32(&fired, 1) })
	if _, err := c.Me(context.Background()); !IsCode(err, "device_revoked") || fired != 1 {
		t.Fatalf("fired=%d err=%v", fired, err)
	}
	c.SetToken("")
	if _, err := c.Me(context.Background()); !errors.Is(err, ErrNoToken) {
		t.Fatalf("err %v", err)
	}
}

func TestCursorETag(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == `"seq-9"` {
			w.WriteHeader(304)
			return
		}
		w.Header().Set("ETag", `"seq-9"`)
		w.Write([]byte(`{"seq": 9}`))
	})
	seq, etag, changed, err := c.Cursor(context.Background(), "")
	if err != nil || seq != 9 || etag != `"seq-9"` || !changed {
		t.Fatal(seq, etag, changed, err)
	}
	_, etag2, changed, err := c.Cursor(context.Background(), etag)
	if err != nil || changed || etag2 != etag {
		t.Fatal(changed, err)
	}
}

func TestChangesTreeAndNodes(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/sync/changes":
			if r.URL.Query().Get("cursor") == "1" {
				w.WriteHeader(410)
				w.Write([]byte(`{"error":"old","code":"cursor_expired","min_cursor":50}`))
				return
			}
			w.Write([]byte(`{"changes":[{"type":"folder","id":12,"parent_id":null,"seq":81},{"type":"file","id":"u-1","folder_id":12,"seq":82,"size":37}],
				"tombstones":[{"type":"file","id":"u-0","seq":83}],"next_cursor":83,"has_more":false}`))
		case "/apiv1/sync/tree":
			if r.URL.Query().Get("root") != "0" || r.URL.Query().Get("page_token") != "p2" {
				t.Errorf("tree query %v", r.URL.Query())
			}
			w.Write([]byte(`{"as_of_seq":80,"root":null,"folders":[],"files":[],"next_page_token":null}`))
		}
	})
	ch, err := c.Changes(context.Background(), 80, 1000)
	if err != nil || len(ch.Changes) != 2 || ch.NextCursor != 83 {
		t.Fatal(ch, err)
	}
	if ch.Changes[0].IDString() != "12" || ch.Changes[1].IDString() != "u-1" || *ch.Changes[1].Parent() != 12 || ch.Changes[0].Parent() != nil {
		t.Fatal("node ids/parents")
	}
	if ch.Tombstones[0].IDString() != "u-0" {
		t.Fatal("tombstone id")
	}
	var e *Error
	if _, err := c.Changes(context.Background(), 1, 0); !errors.As(err, &e) || e.Code != "cursor_expired" || e.MinCursor != 50 {
		t.Fatal(err)
	}
	tr, err := c.Tree(context.Background(), 0, "p2", 2000)
	if err != nil || tr.AsOfSeq != 80 || tr.NextPageToken != "" {
		t.Fatal(tr, err)
	}
}

func TestContentRangeAndIfMatch(t *testing.T) {
	data := []byte("0123456789")
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-Match") != `"abc"` {
			w.WriteHeader(412)
			w.Write([]byte(`{"code":"precondition_failed"}`))
			return
		}
		if rg := r.Header.Get("Range"); rg == "bytes=4-" {
			w.Header().Set("Content-Range", "bytes 4-9/10")
			w.WriteHeader(206)
			w.Write(data[4:])
			return
		}
		w.Write(data)
	})
	var buf bytes.Buffer
	if n, err := c.Content(context.Background(), "u1", &buf, 0, "abc"); err != nil || n != 10 || buf.String() != string(data) {
		t.Fatal(n, err)
	}
	buf.Reset()
	if n, err := c.Content(context.Background(), "u1", &buf, 4, "abc"); err != nil || n != 6 || buf.String() != "456789" {
		t.Fatal(n, err)
	}
	if _, err := c.Content(context.Background(), "u1", io.Discard, 0, "other"); !IsCode(err, "precondition_failed") {
		t.Fatal(err)
	}
}

func TestMutationsAndCreateFolder(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/apiv1/sync/files/u1/move":
			if body["folder_id"] != nil || body["if_seq"].(float64) != 4 {
				t.Errorf("move body %v", body)
			}
			w.Write([]byte(`{"type":"file","id":"u1","seq":5}`))
		case "/apiv1/sync/folders/7/rename":
			if _, ok := body["stored_extension"]; ok || body["encrypted_name"] != "ZW4=" {
				t.Errorf("rename body %v", body)
			}
			w.Write([]byte(`{"type":"folder","id":7,"seq":6}`))
		case "/apiv1/folders":
			if body["client_dedupe_token"] != "tok" || body["name"] != "encrypted" {
				t.Errorf("folder body %v", body)
			}
			w.WriteHeader(201)
			w.Write([]byte(`{"id":44,"name":"encrypted","encrypted_name":"ZW4=","seq":90}`))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	})
	n, err := c.MoveFile(context.Background(), "u1", nil, ptr(4))
	if err != nil || n.Seq != 5 {
		t.Fatal(n, err)
	}
	ext := ".pdf"
	if n, err := c.RenameFolder(context.Background(), 7, RenameRequest{EncryptedName: "ZW4=", NameNonce: "bm4=", StoredExtension: &ext}); err != nil || n.Seq != 6 {
		t.Fatal(n, err)
	}
	f, err := c.CreateFolder(context.Background(), CreateFolderRequest{Name: "encrypted", ParentID: ptr(3), EncryptedName: "ZW4=", ClientDedupeToken: "tok"})
	if err != nil || f.IDString() != "44" || f.Type != "folder" || *f.ParentID != 3 || !f.IsE2E || f.Seq != 90 {
		t.Fatal(f, err)
	}
}

func TestUploads(t *testing.T) {
	part := []byte("framed-chunk")
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/sync/files":
			if err := r.ParseMultipartForm(1 << 20); err != nil || r.FormValue("upload_id") != "up1" {
				t.Errorf("multipart: %v", err)
			}
			f, _, _ := r.FormFile("file")
			b, _ := io.ReadAll(f)
			if string(b) != "container" {
				t.Errorf("file part %q", b)
			}
			w.Write([]byte(`{"existing":true,"node":{"type":"file","id":"u9","seq":3}}`))
		case r.URL.Path == "/apiv1/sync/uploads" && r.Method == "POST":
			w.WriteHeader(201)
			w.Write([]byte(`{"session_id":"s1","file_id":"u10","parts_received":[],"expires_at":"x"}`))
		case r.URL.Path == "/apiv1/sync/uploads/s1/parts/0":
			b, _ := io.ReadAll(r.Body)
			sum := sha256.Sum256(b)
			if r.Header.Get("X-Content-SHA256") != hex.EncodeToString(sum[:]) || !bytes.Equal(b, part) {
				t.Errorf("part hash")
			}
		case r.URL.Path == "/apiv1/sync/uploads/s1" && r.Method == "GET":
			w.Write([]byte(`{"session_id":"s1","parts_received":[0],"expires_at":"x"}`))
		case r.URL.Path == "/apiv1/sync/uploads/s1/complete":
			w.WriteHeader(201)
			w.Write([]byte(`{"type":"file","id":"u10","seq":4}`))
		case r.URL.Path == "/apiv1/sync/uploads/s1" && r.Method == "DELETE":
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
	ctx := context.Background()
	n, existing, err := c.UploadSmall(ctx, UploadFields{"upload_id": "up1", "mode": "e2ee"}, []byte("container"), nil)
	if err != nil || !existing || n.IDString() != "u9" {
		t.Fatal(n, existing, err)
	}
	if _, _, err := c.UploadSmall(ctx, UploadFields{}, nil, nil); err == nil {
		t.Fatal("upload without upload_id accepted")
	}
	s, node, err := c.CreateSession(ctx, map[string]any{"upload_id": "up2", "chunk_count": 1})
	if err != nil || node != nil || s.SessionID != "s1" || s.FileID != "u10" {
		t.Fatal(s, err)
	}
	if err := c.PutPart(ctx, "s1", 0, part); err != nil {
		t.Fatal(err)
	}
	if st, err := c.SessionStatus(ctx, "s1"); err != nil || len(st.PartsReceived) != 1 {
		t.Fatal(st, err)
	}
	if n, existing, err := c.CompleteSession(ctx, "s1", "", ""); err != nil || existing || n.IDString() != "u10" {
		t.Fatal(n, err)
	}
	if err := c.AbortSession(ctx, "s1"); err != nil {
		t.Fatal(err)
	}
}

func ptr(v int64) *int64 { return &v }

// An upload reports its body as it goes out (with a real Content-Length), and
// a server that stops answering ends the attempt instead of hanging it.
func TestUploadProgressAndStall(t *testing.T) {
	part := bytes.Repeat([]byte("x"), 300<<10)
	hang := make(chan struct{})
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/parts/1") {
			select {
			case <-hang:
			case <-r.Context().Done():
			}
			return
		}
		b, _ := io.ReadAll(r.Body)
		if r.ContentLength != int64(len(part)) || !bytes.Equal(b, part) {
			t.Errorf("part arrived as %d bytes, Content-Length %d", len(b), r.ContentLength)
		}
		w.Write([]byte(`{}`))
	})
	t.Cleanup(func() { close(hang) }) // before the server's Close, which waits for its handlers
	c.stall = 150 * time.Millisecond
	var sent []int64
	var whys []string
	ctx := WithObserver(context.Background(), &Observer{
		Sent:  func(n, total int64) { sent = append(sent, n*100/total) },
		Retry: func(why string, _ time.Duration) { whys = append(whys, why) },
	})
	if err := c.PutPart(ctx, "s1", 0, part); err != nil {
		t.Fatal(err)
	}
	if len(sent) < 3 || sent[0] != 0 || sent[len(sent)-1] != 100 {
		t.Fatalf("progress %v, want 0 .. 100 in steps", sent)
	}
	start := time.Now()
	err := c.PutPart(ctx, "s1", 1, part)
	if !errors.Is(err, ErrOffline) || !strings.Contains(err.Error(), errStalled.Error()) {
		t.Fatalf("stalled request: %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("stall took %v to notice", time.Since(start))
	}
	if len(whys) != 6 || whys[0] != "one.gy stopped responding" || whys[1] != "" {
		t.Fatalf("retry reasons %q", whys)
	}
}
