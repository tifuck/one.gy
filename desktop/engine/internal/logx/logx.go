// Package logx owns engine logging: a size-rotated log file, the runtime log
// level, and redaction of file names (plan 11.4: names and paths are logged
// only at debug level; otherwise a short hash plus the extension).
package logx

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	maxSize  = 5 << 20 // rotate at 5 MiB
	keepLogs = 5       // engine.log.1 … engine.log.5
)

// Level is the live log level; settings.set changes it.
var Level = new(slog.LevelVar)

// ParseLevel maps the settings value to a slog level.
func ParseLevel(s string) (slog.Level, error) {
	switch s {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	}
	return 0, fmt.Errorf("unknown log level %q", s)
}

// Setup sends the default slog logger to <dir>/engine.log.
func Setup(dir string) (*RotatingFile, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f := &RotatingFile{path: filepath.Join(dir, "engine.log")}
	if err := f.open(); err != nil {
		return nil, err
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(f, &slog.HandlerOptions{Level: Level})))
	return f, nil
}

// Name returns a loggable form of a file name or path: the name itself at
// debug level, otherwise "h:<8 hex>" plus the extension.
func Name(name string) string {
	if Level.Level() <= slog.LevelDebug {
		return name
	}
	sum := sha256.Sum256([]byte(name))
	ext := strings.ToLower(filepath.Ext(name))
	if len(ext) > 8 {
		ext = ""
	}
	return "h:" + hex.EncodeToString(sum[:4]) + ext
}

// RotatingFile is an io.Writer that rotates by size.
type RotatingFile struct {
	mu   sync.Mutex
	path string
	f    *os.File
	size int64
}

func (r *RotatingFile) open() error {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f, r.size = f, st.Size()
	return nil
}

func (r *RotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.size+int64(len(p)) > maxSize {
		r.f.Close()
		for i := keepLogs - 1; i >= 1; i-- {
			os.Rename(fmt.Sprintf("%s.%d", r.path, i), fmt.Sprintf("%s.%d", r.path, i+1))
		}
		os.Rename(r.path, r.path+".1")
		if err := r.open(); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

func (r *RotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.f.Close()
}
