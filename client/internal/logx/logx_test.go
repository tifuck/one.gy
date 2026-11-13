package logx

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNameRedactionAndRotation(t *testing.T) {
	Level.Set(slog.LevelInfo)
	if got := Name("/data/x/Secret Plan.PDF"); strings.Contains(got, "Secret") || !strings.HasSuffix(got, ".pdf") {
		t.Fatalf("info-level name %q", got)
	}
	Level.Set(slog.LevelDebug)
	if Name("a.txt") != "a.txt" {
		t.Fatal("debug level must show names")
	}
	Level.Set(slog.LevelInfo)

	dir := t.TempDir()
	f, err := Setup(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	line := []byte(strings.Repeat("x", 1<<20) + "\n")
	for i := 0; i < 12; i++ {
		f.Write(line)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "engine.log*"))
	if len(files) < 2 || len(files) > keepLogs+1 {
		t.Fatalf("log files %v", files)
	}
	if st, _ := os.Stat(filepath.Join(dir, "engine.log")); st.Size() > maxSize {
		t.Fatal("log not rotated")
	}
}
