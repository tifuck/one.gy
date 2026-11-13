package state

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMigrateReopenAndSyncUpsertKeepsChildren(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "engine.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	db.QueryRow(`PRAGMA journal_mode`).Scan(&mode)
	var fk, syncMode int
	db.QueryRow(`PRAGMA foreign_keys`).Scan(&fk)
	db.QueryRow(`PRAGMA synchronous`).Scan(&syncMode)
	if mode != "wal" || fk != 1 || syncMode != 2 {
		t.Fatalf("pragmas: journal=%s fk=%d synchronous=%d", mode, fk, syncMode)
	}
	r := &SyncRow{ID: "s_1", Name: "A", LocalRoot: "/x", Type: "two_way", Encryption: "e2ee", Config: "{}", State: "scanning", CreatedAt: "t"}
	if err := db.PutSync(ctx, r); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO synced (sync_id, rel_path, kind) VALUES ('s_1', 'a.txt', 'file')`); err != nil {
		t.Fatal(err)
	}
	r.Paused = true
	if err := db.PutSync(ctx, r); err != nil {
		t.Fatal(err)
	}
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM synced`).Scan(&n)
	if n != 1 {
		t.Fatal("updating a sync wiped its base state")
	}
	db.Close()

	db, err = Open(path) // migrations are idempotent
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	got, _ := db.GetSync(ctx, "s_1")
	if got == nil || !got.Paused {
		t.Fatalf("sync after reopen %+v", got)
	}
	if err := db.DeleteSync(ctx, "s_1"); err != nil {
		t.Fatal(err)
	}
	db.QueryRow(`SELECT COUNT(*) FROM synced`).Scan(&n)
	if n != 0 {
		t.Fatal("delete did not cascade")
	}
}
