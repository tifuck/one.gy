package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// renameNoReplace: localfs has no darwin port; renamex_np(RENAME_EXCL) fails
// with EEXIST instead of replacing dst.
func renameNoReplace(src, dst string) error {
	if err := unix.RenamexNp(src, dst, unix.RENAME_EXCL); err != nil {
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: err}
	}
	return nil
}
