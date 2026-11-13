// Package config owns the engine's on-disk locations (state dir, socket,
// engine.json, logs, DB) and the build version. See desktop/docs/engine-ipc.md.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Version is the client release (CLI, engine and ONE.GY Desktop); builds set it
// with -ldflags "-X github.com/tifuck/one.gy/client/internal/config.Version=<client/VERSION>".
var Version = "0.1.0"

// Protocol is the engine IPC protocol version.
const Protocol = 1

// DefaultStateDir is %APPDATA%\ONE.GY on Windows, $XDG_DATA_HOME/onegy
// (default ~/.local/share/onegy) elsewhere.
func DefaultStateDir() (string, error) {
	if runtime.GOOS == "windows" {
		if d := os.Getenv("APPDATA"); d != "" {
			return filepath.Join(d, "ONE.GY"), nil
		}
		return "", fmt.Errorf("APPDATA is not set")
	}
	if d := os.Getenv("XDG_DATA_HOME"); d != "" && filepath.IsAbs(d) {
		return filepath.Join(d, "onegy"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "onegy"), nil
}

// DefaultSocket is the IPC endpoint for a state dir.
func DefaultSocket(stateDir string) string {
	if runtime.GOOS == "windows" {
		return `\\.\pipe\onegy-engine-` + os.Getenv("USERNAME")
	}
	if d := os.Getenv("XDG_RUNTIME_DIR"); d != "" && filepath.IsAbs(d) {
		return filepath.Join(d, "onegy", "engine.sock")
	}
	return filepath.Join(stateDir, "run", "engine.sock")
}

func DBPath(stateDir string) string   { return filepath.Join(stateDir, "engine.db") }
func LogDir(stateDir string) string   { return filepath.Join(stateDir, "logs") }
func infoPath(stateDir string) string { return filepath.Join(stateDir, "engine.json") }

// EnsureStateDir creates the state dir, private to the current user.
func EnsureStateDir(stateDir string) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	return os.Chmod(stateDir, 0o700)
}

// WriteEngineInfo atomically writes <state>/engine.json once the engine listens.
func WriteEngineInfo(stateDir, socket string) error {
	b, err := json.Marshal(map[string]any{"pid": os.Getpid(), "socket": socket, "version": Version})
	if err != nil {
		return err
	}
	return WriteFileAtomic(infoPath(stateDir), b, 0o600)
}

// RemoveEngineInfo deletes engine.json on clean exit.
func RemoveEngineInfo(stateDir string) { os.Remove(infoPath(stateDir)) }

// WriteFileAtomic writes via a synced temp file + rename in the same dir.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
