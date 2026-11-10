package service

import (
	"context"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/tifuck/one.gy/desktop/engine/internal/ignore"
	"github.com/tifuck/one.gy/desktop/engine/internal/ipc"
	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
)

// browseLimit caps one syncs.browse listing; the rest is counted in "more".
const browseLimit = 2000

type browseItem struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Kind        string `json:"kind"` // folder | file
	Size        int64  `json:"size"`
	Local       bool   `json:"local"`
	Remote      bool   `json:"remote"`
	RemoteID    *int64 `json:"remote_id,omitempty"` // folders on one.gy
	Excluded    bool   `json:"excluded"`
	SizeSkipped bool   `json:"size_skipped"` // only exclude-larger/-smaller applies (new files)
}

// syncsBrowse lists one folder of a sync (or of a sync being set up) as the
// union of the local folder and the one.gy folder, each item marked with
// what the given root .onegyignore text does to it ("What to sync").
func (s *Service) syncsBrowse(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		LocalPath           string          `json:"local_path"`       // sync root; "" = no local side
		RemoteFolderID      json.RawMessage `json:"remote_folder_id"` // the one.gy folder at path; omitted = no remote side, null = drive root
		Path                string          `json:"path"`             // "" = the root
		IgnoreRules         string          `json:"ignore_rules"`
		IncludeHiddenSystem bool            `json:"include_hidden_system"`
	}
	if err := ipc.Params(params, &in); err != nil {
		return nil, err
	}
	rel := in.Path
	if rel != "" && (path.Clean(rel) != rel || path.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, "../") || strings.Contains(rel, "\\")) {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "path", Message: "path must be a relative / path inside the sync"}})
	}
	if in.LocalPath != "" && !filepath.IsAbs(in.LocalPath) {
		return nil, validationFailed([]problem{{Code: "invalid", Field: "local_path", Message: "local_path must be absolute"}})
	}
	rules := ignore.NewSet()
	parseErrs := []ignore.ParseError{}
	if r, errs := ignore.Parse(in.IgnoreRules); errs != nil {
		parseErrs = errs
	} else {
		rules.Add("", r)
	}

	items := map[string]*browseItem{}
	if in.LocalPath != "" {
		dir := filepath.Join(in.LocalPath, filepath.FromSlash(rel))
		ents, _ := os.ReadDir(dir) // a folder that exists only on one.gy lists nothing here
		for _, de := range ents {
			name := de.Name()
			if !utf8.ValidString(name) || (rel == "" && name == ".onegy") || name == ignore.FileName {
				continue
			}
			st, err := localfs.Lstat(filepath.Join(dir, name))
			if err != nil || (st.Kind != localfs.KindFile && st.Kind != localfs.KindDir) || (st.Hidden && !in.IncludeHiddenSystem) {
				continue
			}
			it := &browseItem{Name: name, Kind: st.Kind.String(), Local: true}
			if st.Kind == localfs.KindFile {
				it.Size = st.Size
			}
			items[name] = it
		}
	}
	if in.RemoteFolderID != nil {
		var id *int64
		if err := json.Unmarshal(in.RemoteFolderID, &id); err != nil {
			return nil, validationFailed([]problem{{Code: "invalid", Field: "remote_folder_id", Message: "remote_folder_id must be a folder id or null"}})
		}
		l, err := s.tree.List(ctx, zeroIsRoot(id))
		if err != nil {
			return nil, err
		}
		add := func(n map[string]any, kind string) {
			name, _ := n["name"].(string)
			if name == "" || n["name_error"] == true || n["is_trashed"] == true || (rel == "" && name == ".onegy") || name == ignore.FileName {
				return
			}
			it := items[name]
			if it == nil {
				it = &browseItem{Name: name, Kind: kind}
				items[name] = it
			} else if it.Kind != kind {
				return // a file here and a folder there: the local one is listed
			}
			it.Remote = true
			if kind == "folder" {
				if fid, ok := n["id"].(int64); ok {
					it.RemoteID = &fid
				}
			} else if !it.Local {
				it.Size, _ = n["size_plain"].(int64)
			}
		}
		for _, f := range l.Folders {
			add(f, "folder")
		}
		for _, f := range l.Files {
			add(f, "file")
		}
	}

	out := make([]*browseItem, 0, len(items))
	for _, it := range items {
		it.Path = path.Join(rel, it.Name)
		kind := localfs.KindFile
		if it.Kind == "folder" {
			kind = localfs.KindDir
		}
		switch rules.MatchPath(it.Path, kind, it.Size) {
		case ignore.Excluded:
			it.Excluded = true
		case ignore.SizeExcluded:
			it.SizeSkipped = true
		}
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Kind == "folder") != (out[j].Kind == "folder") {
			return out[i].Kind == "folder"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	more := 0
	if len(out) > browseLimit {
		more, out = len(out)-browseLimit, out[:browseLimit]
	}
	folderOut := rel != "" && rules.MatchPath(rel, localfs.KindDir, 0) == ignore.Excluded
	return map[string]any{"items": out, "errors": parseErrs, "more": more, "folder_excluded": folderOut}, nil
}
