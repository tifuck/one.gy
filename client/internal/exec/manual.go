package exec

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/logx"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/state"
)

// Manual transfers (manual.upload / manual.download): one-off uploads and
// downloads outside any sync, through the same pipelines and pool. They are
// not journaled: an interrupted manual transfer is simply started again.

// ManualUpload starts uploading the local files srcs into folderID (nil =
// drive root) as new E2EE files and returns the transfer ids. Every source
// is checked first: one that is not a file starts nothing. ctx must outlive
// the IPC call.
func ManualUpload(ctx context.Context, env *Env, stateDir string, srcs []string, folderID *int64) ([]string, error) {
	sizes := make([]int64, len(srcs))
	for i, src := range srcs {
		in, err := localfs.Lstat(src)
		if err != nil {
			return nil, err
		}
		if in.Kind != localfs.KindFile {
			return nil, fmt.Errorf("%s is not a file", filepath.Base(src))
		}
		sizes[i] = in.Size
	}
	x := New(env, Sync{Root: stateDir, RootID: folderID, Encryption: "e2ee", Thumbnails: true, KeepExecBit: true})
	ids := []string{}
	for i, src := range srcs {
		ids = append(ids, x.startManualUpload(ctx, src, sizes[i]))
	}
	return ids, nil
}

func (x *Executor) startManualUpload(ctx context.Context, src string, size int64) string {
	name := filepath.Base(src)
	t, tctx := x.env.Pool.Begin(ctx, "", Up, name, size, true, nil)
	go func() {
		var err error
		defer func() { t.Finish(err) }()
		defer logx.Recover(&err, "manual upload")
		if err = t.Start(tctx); err == nil {
			err = x.manualUpload(tctx, t, src, name)
		}
	}()
	return t.ID()
}

func (x *Executor) manualUpload(ctx context.Context, t *Transfer, src, name string) error {
	rec := &record{Op: reconcile.Op{Kind: reconcile.Upload, Path: name, RemoteName: name}, UploadID: "op-" + token(), FileID: uuid4()}
	dir := filepath.Join(x.s.Root, "spool", "m-"+rec.UploadID)
	defer os.RemoveAll(dir)
	ctx = t.Observe(ctx)
	for attempt := 0; ; attempt++ {
		up, err := x.prepareUpload(ctx, rec, sourceFile{abs: src}, dir, t)
		if errors.Is(err, ErrSuperseded) {
			return fmt.Errorf("the file changed while it was read; try again")
		}
		if err != nil {
			return err
		}
		node, err := x.send(ctx, 0, rec.UploadID, up, dir, t)
		if errors.Is(err, errRestart) && attempt == 0 {
			continue
		}
		if err != nil {
			return err
		}
		return x.storeNodeNow(ctx, node)
	}
}

// ManualDownload starts downloading remote files fileIDs into localDir (a
// free name is picked; nothing is overwritten) and returns the transfer
// ids. Every file is checked first: one that cannot be found or named
// starts nothing.
func ManualDownload(ctx context.Context, env *Env, fileIDs []string, localDir string) ([]string, error) {
	nodes := make([]*state.RemoteNode, len(fileIDs))
	locals := make([]string, len(fileIDs))
	for i, fileID := range fileIDs {
		n, err := env.DB.GetNode(ctx, "file", fileID)
		if err != nil {
			return nil, err
		}
		if n == nil || n.IsTrashed {
			return nil, fmt.Errorf("one.gy file %s not found", fileID)
		}
		name, ok := env.Tree.DisplayName(n)
		if !ok {
			return nil, fmt.Errorf("the name of one.gy file %s cannot be decrypted", fileID)
		}
		nodes[i], locals[i] = n, localfs.NamesFor("").ToLocal(name)
	}
	x := New(env, Sync{Root: localDir, KeepExecBit: true})
	ids := []string{}
	for i, n := range nodes {
		ids = append(ids, x.startManualDownload(ctx, n, localDir, locals[i]))
	}
	return ids, nil
}

func (x *Executor) startManualDownload(ctx context.Context, n *state.RemoteNode, localDir, local string) string {
	t, tctx := x.env.Pool.Begin(ctx, "", Down, local, n.PlainSize, true, nil)
	go func() {
		var err error
		defer func() { t.Finish(err) }()
		defer logx.Recover(&err, "manual download")
		if err = t.Start(tctx); err == nil {
			tmp := filepath.Join(localDir, ".onegy-download-"+token())
			defer os.Remove(tmp + ".enc")
			defer os.Remove(tmp + ".plain")
			var got *fetched
			if got, err = x.fetch(t.Observe(tctx), n, tmp+".enc", tmp+".plain", t, true); err == nil {
				x.finishPlain(tmp+".plain", got.meta)
				err = placeFree(tmp+".plain", localDir, local)
			}
		}
	}()
	return t.ID()
}

// placeFree renames src to dir/name, or "name (2)", "name (3)", ... when taken.
func placeFree(src, dir, name string) error {
	for i := 1; i < 10000; i++ {
		cand := name
		if i > 1 {
			cand = localfs.InsertSuffix(name, " ("+strconv.Itoa(i)+")")
		}
		err := localfs.RenameNoReplace(src, filepath.Join(dir, cand))
		if !errors.Is(err, os.ErrExist) {
			return err
		}
	}
	return fmt.Errorf("no free name for %s", name)
}
