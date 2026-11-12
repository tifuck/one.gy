package exec

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/reconcile"
)

// Manual transfers (manual.upload / manual.download): one-off uploads and
// downloads outside any sync, through the same pipelines and pool. They are
// not journaled: an interrupted manual transfer is simply started again.

// ManualUpload starts uploading the local file src into folderID (nil =
// drive root) as a new E2EE file and returns the transfer id. ctx must
// outlive the IPC call.
func ManualUpload(ctx context.Context, env *Env, stateDir, src string, folderID *int64) (string, error) {
	in, err := localfs.Lstat(src)
	if err != nil {
		return "", err
	}
	if in.Kind != localfs.KindFile {
		return "", fmt.Errorf("%s is not a file", filepath.Base(src))
	}
	name := filepath.Base(src)
	x := New(env, Sync{Root: stateDir, RootID: folderID, Encryption: "e2ee", Thumbnails: true, KeepExecBit: true})
	t, tctx := env.Pool.Begin(ctx, "", Up, name, in.Size, true, nil)
	go func() {
		err := t.Start(tctx)
		if err == nil {
			err = x.manualUpload(tctx, t, src, name)
		}
		t.Finish(err)
	}()
	return t.ID(), nil
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

// ManualDownload starts downloading remote file fileID into localDir (a free
// name is picked; nothing is overwritten) and returns the transfer id.
func ManualDownload(ctx context.Context, env *Env, fileID, localDir string) (string, error) {
	n, err := env.DB.GetNode(ctx, "file", fileID)
	if err != nil {
		return "", err
	}
	if n == nil || n.IsTrashed {
		return "", fmt.Errorf("one.gy file %s not found", fileID)
	}
	name, ok := env.Tree.DisplayName(n)
	if !ok {
		return "", fmt.Errorf("the name of one.gy file %s cannot be decrypted", fileID)
	}
	local := localfs.NamesFor("").ToLocal(name)
	x := New(env, Sync{Root: localDir, KeepExecBit: true})
	t, tctx := env.Pool.Begin(ctx, "", Down, local, n.PlainSize, true, nil)
	go func() {
		err := t.Start(tctx)
		if err == nil {
			tmp := filepath.Join(localDir, ".onegy-download-"+token())
			defer os.Remove(tmp + ".enc")
			defer os.Remove(tmp + ".plain")
			var got *fetched
			if got, err = x.fetch(t.Observe(tctx), n, tmp+".enc", tmp+".plain", t); err == nil {
				x.finishPlain(tmp+".plain", got.meta)
				err = placeFree(tmp+".plain", localDir, local)
			}
		}
		t.Finish(err)
	}()
	return t.ID(), nil
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
