package main

import "github.com/tifuck/one.gy/client/internal/localfs"

func renameNoReplace(src, dst string) error { return localfs.RenameNoReplace(src, dst) }
