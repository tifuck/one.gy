package state

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A query cancelled mid-flight must not keep the database file open after
// Close (modernc.org/sqlite before v1.63 leaked it; Windows then cannot
// delete or replace the file).
func TestCloseAfterCancelledQueryReleasesFile(t *testing.T) {
	for i := 0; i < 50; i++ {
		dir := t.TempDir()
		db, err := Open(filepath.Join(dir, "state.db"))
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			for ctx.Err() == nil {
				db.ListSyncs(ctx)
			}
		}()
		time.Sleep(time.Duration(i%7) * 100 * time.Microsecond)
		cancel()
		<-done
		db.Close()
		ents, _ := os.ReadDir("/proc/self/fd")
		for _, e := range ents {
			if l, _ := os.Readlink("/proc/self/fd/" + e.Name()); strings.HasPrefix(l, dir) {
				t.Fatalf("run %d: %s still open after Close", i, l)
			}
		}
	}
}
