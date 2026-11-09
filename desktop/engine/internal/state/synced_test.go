package state

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestSyncedMoveDeleteAndCache(t *testing.T) {
	ctx := context.Background()
	db, err := Open(filepath.Join(t.TempDir(), "engine.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.PutSync(ctx, &SyncRow{ID: "s", Name: "S", LocalRoot: "/x", Type: "two_way", Encryption: "e2ee", Config: "{}", State: "scanning", CreatedAt: "t"})
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		for _, p := range []string{"A", "A/b", "A/b/c", "AB", "A0", "a/x", "Ä/y"} {
			if err := PutSynced(tx, &SyncedRow{SyncID: "s", RelPath: p, Kind: "file", RemoteName: p}); err != nil {
				return err
			}
		}
		if err := MoveSynced(tx, "s", "A", "Z/Ä"); err != nil {
			return err
		}
		if err := DeleteSynced(tx, "s", "Ä", true); err != nil {
			return err
		}
		if err := PutSynced(tx, &SyncedRow{SyncID: "s", RelPath: "r", Kind: "file", RemoteID: "u9"}); err != nil {
			return err
		}
		if got, err := SyncedByRemote(tx, "s", "u9"); err != nil || got == nil || got.RelPath != "r" {
			t.Errorf("SyncedByRemote %+v %v", got, err)
		}
		if got, _ := SyncedByRemote(tx, "s", ""); got != nil {
			t.Error("empty remote id must not match")
		}
		return DeleteSynced(tx, "s", "r", false)
	})
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := db.ListSynced(ctx, "s")
	var got []string
	for _, r := range rows {
		got = append(got, r.RelPath)
	}
	want := []string{"A0", "AB", "Z/Ä", "Z/Ä/b", "Z/Ä/b/c", "a/x"}
	if len(got) != len(want) {
		t.Fatalf("rows %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("rows %v", got)
		}
	}
	if err := db.SaveLocalCache(ctx, "s", []*LocalCacheRow{{RelPath: "f", Size: 3, PlainSHA256: "h"}}, nil); err != nil {
		t.Fatal(err)
	}
	c, _ := db.LoadLocalCache(ctx, "s")
	if c["f"] == nil || c["f"].PlainSHA256 != "h" {
		t.Fatal("cache")
	}
	db.SaveLocalCache(ctx, "s", nil, []string{"f"})
	if c, _ = db.LoadLocalCache(ctx, "s"); len(c) != 0 {
		t.Fatal("cache delete")
	}
}

func TestSubtreeNodesSkipsTrashed(t *testing.T) {
	ctx := context.Background()
	db, _ := Open(filepath.Join(t.TempDir(), "engine.db"))
	defer db.Close()
	one, two := int64(1), int64(2)
	db.Tx(ctx, func(tx *sql.Tx) error {
		UpsertNode(tx, "remote_node", &RemoteNode{Kind: "folder", ID: "1"})
		UpsertNode(tx, "remote_node", &RemoteNode{Kind: "folder", ID: "2", ParentID: &one, IsTrashed: true})
		UpsertNode(tx, "remote_node", &RemoteNode{Kind: "file", ID: "f1", ParentID: &one})
		UpsertNode(tx, "remote_node", &RemoteNode{Kind: "file", ID: "f2", ParentID: &two})
		return nil
	})
	ns, err := db.SubtreeNodes(ctx, &one)
	if err != nil || len(ns) != 1 || ns[0].ID != "f1" {
		t.Fatalf("subtree %v %v", ns, err)
	}
	if ns, _ = db.SubtreeNodes(ctx, nil); len(ns) != 2 {
		t.Fatalf("drive subtree %d", len(ns))
	}
}
