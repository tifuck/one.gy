package syncer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/tifuck/one.gy/client/internal/fakeserver"
	"github.com/tifuck/one.gy/client/internal/state"
)

// A sync is bound to the account it was created under: signed in as another
// user (or to another server) it must not run, or a two-way sync would
// delete the folder's contents and an upload sync would copy them into the
// other account.
func TestAccountMismatchStopsSync(t *testing.T) {
	srv := fakeserver.New(t, "u", "pw")
	rootID := srv.AddFolder(nil, "Root")
	d := newDevice(t, srv, "D1", rootID, nil)
	os.WriteFile(filepath.Join(d.root, "a.txt"), []byte("hello"), 0o644)
	if err := d.pass(); err != nil {
		t.Fatal(err)
	}
	if n := len(srv.Snapshot(&rootID)); n != 1 {
		t.Fatalf("first pass uploaded %d items", n)
	}
	srv.Delete("file", srv.Snapshot(&rootID)[0].ID) // the other account has no such file
	ctx := context.Background()
	for _, other := range []state.Account{
		{ServerURL: srv.URL, UserID: 2, Username: "v", SignedIn: true},
		{ServerURL: "https://other.example", UserID: 1, Username: "u", SignedIn: true},
	} {
		d.db.PutAccount(ctx, &other)
		if err := d.pass(); err != nil {
			t.Fatal(err)
		}
		if st := d.run.State(); st != "stalled" {
			t.Fatalf("%s/%d: state %q", other.ServerURL, other.UserID, st)
		}
		if b, err := os.ReadFile(filepath.Join(d.root, "a.txt")); err != nil || string(b) != "hello" {
			t.Fatalf("local file touched: %q %v", b, err)
		}
		is, _ := d.db.OpenIssues(ctx, d.syncID)
		if len(is) != 1 || is[0].Kind != "account_mismatch" {
			t.Fatalf("issues: %+v", is)
		}
	}
}
