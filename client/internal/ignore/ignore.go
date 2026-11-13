// Package ignore owns .onegyignore (plan 6.5): the parser for the .megaignore
// grammar and the matcher that applies the files of a sync top-down.
//
// Grammar, one rule per line:
//   - "#..." comment (only in column 1); blank lines are skipped.
//   - <CLASS><TARGET><TYPE><STRATEGY>:<PATTERN> name filter. CLASS is - (exclude)
//     or + (include). TARGET a (default: files, folders, symlinks), d, f or s.
//     TYPE N (names directly in this folder), n (names in this folder and
//     below) or p (path relative to this folder, / separated); the default is
//     p when PATTERN contains "/", else n. STRATEGY g (glob: * and ?) or r
//     (RE2 regex, full match); lowercase is case-insensitive, G/R sensitive.
//   - exclude-smaller:<N>[KMG] / exclude-larger:<N>[KMG] size thresholds for
//     files not yet synced (units are 1024-based, case-insensitive).
//   - +sync:.onegyignore / -sync:.onegyignore: sync this file itself (default no).
//
// Rules apply to the folder holding the file and everything below it. Later
// rules win: the last matching rule decides, and rules of a deeper folder come
// after those of its ancestors. An excluded folder excludes its whole subtree.
package ignore

import (
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/tifuck/one.gy/client/internal/localfs"
)

// FileName is the rules file in a sync folder.
const FileName = ".onegyignore"

// DefaultRules is written to a new sync root (plan 6.5 and 9: system, temp
// and snapshot entries).
func DefaultRules() string {
	return `# Rules for this sync. Same grammar as MEGA's .megaignore.
-:desktop.ini
-:Thumbs.db
-:.DS_Store
-:~$*
-:.~lock.*#
-:*.tmp
-:*.swp
-:*.part
-:*.crdownload
-:.Trash-*
-:$RECYCLE.BIN
-:System Volume Information
-d:.snapshots
-d:.zfs
`
}

// ParseError points at a bad line (1-based).
type ParseError struct {
	Line    int    `json:"line"`
	Message string `json:"message"`
}

func (e ParseError) Error() string { return fmt.Sprintf("line %d: %s", e.Line, e.Message) }

type rule struct {
	exclude bool
	target  byte // a d f s
	typ     byte // N n p
	re      *regexp.Regexp
}

// Rules is one parsed .onegyignore.
type Rules struct {
	rules           []rule
	smaller, larger int64 // -1 = not set
	SyncFile        bool  // +sync:.onegyignore
}

// Parse parses a rules file. Any error makes the whole file invalid: the
// caller stalls that folder and its subtree.
func Parse(text string) (*Rules, []ParseError) {
	r := &Rules{smaller: -1, larger: -1}
	var errs []ParseError
	for i, line := range strings.Split(text, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.TrimSpace(line) == "" || line[0] == '#' {
			continue
		}
		if msg := r.parseLine(line); msg != "" {
			errs = append(errs, ParseError{Line: i + 1, Message: msg})
		}
	}
	if r.smaller >= 0 && r.larger >= 0 && r.smaller >= r.larger {
		errs = append(errs, ParseError{Line: 0, Message: "exclude-smaller must be below exclude-larger"})
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return r, nil
}

func (r *Rules) parseLine(line string) string {
	head, pat, ok := strings.Cut(line, ":")
	if !ok {
		return "missing ':'"
	}
	switch head {
	case "+sync", "-sync":
		if pat != FileName {
			return "only " + FileName + " can follow +sync: or -sync:"
		}
		r.SyncFile = head == "+sync"
		return ""
	case "exclude-smaller", "exclude-larger":
		n, err := parseSize(pat)
		if err != "" {
			return err
		}
		if head == "exclude-smaller" {
			r.smaller = n
		} else {
			r.larger = n
		}
		return ""
	}
	if head == "" || (head[0] != '-' && head[0] != '+') {
		return "a rule starts with - (exclude) or + (include)"
	}
	if pat == "" {
		return "empty pattern"
	}
	ru := rule{exclude: head[0] == '-', target: 'a'}
	var strategy byte = 'g'
	seen := map[string]bool{}
	for _, c := range []byte(head[1:]) {
		var cat string
		switch {
		case strings.IndexByte("adfs", c) >= 0:
			cat, ru.target = "target", c
		case strings.IndexByte("Nnp", c) >= 0:
			cat, ru.typ = "type", c
		case strings.IndexByte("gGrR", c) >= 0:
			cat, strategy = "strategy", c
		default:
			return fmt.Sprintf("unknown flag %q", c)
		}
		if seen[cat] {
			return "more than one " + cat
		}
		seen[cat] = true
	}
	if ru.typ == 0 {
		ru.typ = 'n'
		if strings.Contains(pat, "/") {
			ru.typ = 'p'
		}
	}
	expr := pat
	if strategy == 'g' || strategy == 'G' {
		var b strings.Builder
		for _, c := range pat {
			switch c {
			case '*':
				b.WriteString(".*")
			case '?':
				b.WriteString(".")
			default:
				b.WriteString(regexp.QuoteMeta(string(c)))
			}
		}
		expr = b.String()
	}
	flags := "(?s)"
	if strategy == 'g' || strategy == 'r' {
		flags = "(?is)"
	}
	re, err := regexp.Compile(flags + "^(?:" + expr + ")$")
	if err != nil {
		return "bad pattern: " + err.Error()
	}
	ru.re = re
	r.rules = append(r.rules, ru)
	return ""
}

func parseSize(s string) (int64, string) {
	mult := int64(1)
	if s != "" {
		switch s[len(s)-1] {
		case 'k', 'K':
			mult = 1 << 10
		case 'm', 'M':
			mult = 1 << 20
		case 'g', 'G':
			mult = 1 << 30
		}
		if mult > 1 {
			s = s[:len(s)-1]
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 || n > (1<<62)/mult {
		return 0, "size must be a non-negative whole number with an optional K, M or G"
	}
	return n * mult, ""
}

// Result of matching one entry.
type Result uint8

const (
	Included Result = iota
	Excluded
	SizeExcluded // only a size threshold excludes it: skip unless already synced
)

// Set holds the loaded rules files of a sync, by folder ("" = root), and the
// paths the scan excluded by attribute (Windows hidden/system items).
type Set struct {
	dirs   map[string]*Rules
	hidden map[string]bool
}

func NewSet() *Set { return &Set{dirs: map[string]*Rules{}, hidden: map[string]bool{}} }

// Hide excludes rel (and, through MatchPath, everything below it).
func (s *Set) Hide(rel string) { s.hidden[rel] = true }

// Add registers the rules of folder dir (nil removes them).
func (s *Set) Add(dir string, r *Rules) {
	if r == nil {
		delete(s.dirs, dir)
		return
	}
	s.dirs[dir] = r
}

// ancestors returns the folders whose rules apply to rel, deepest first.
func ancestors(rel string) []string {
	var out []string
	for d := path.Dir(rel); ; d = path.Dir(d) {
		if d == "." || d == "/" {
			return append(out, "")
		}
		out = append(out, d)
	}
}

// Match decides one entry, assuming its parent folders are included (the
// scanner walks top-down and skips excluded folders).
func (s *Set) Match(rel string, kind localfs.Kind, size int64) Result {
	name := path.Base(rel)
	if rel == ".onegy" || s.hidden[rel] {
		return Excluded
	}
	parent := path.Dir(rel)
	if parent == "." {
		parent = ""
	}
	if name == FileName && kind == localfs.KindFile {
		if r := s.dirs[parent]; r != nil && r.SyncFile {
			return Included
		}
		return Excluded
	}
	dirs := ancestors(rel)
	for _, d := range dirs {
		r := s.dirs[d]
		if r == nil {
			continue
		}
		for i := len(r.rules) - 1; i >= 0; i-- {
			ru := &r.rules[i]
			if !targets(ru.target, kind) {
				continue
			}
			var subject string
			switch ru.typ {
			case 'N':
				if parent != d {
					continue
				}
				subject = name
			case 'n':
				subject = name
			case 'p':
				subject = rel
				if d != "" {
					subject = rel[len(d)+1:]
				}
			}
			if ru.re.MatchString(subject) {
				if ru.exclude {
					return Excluded
				}
				return Included
			}
		}
	}
	if kind != localfs.KindFile {
		return Included
	}
	smaller, larger := int64(-1), int64(-1)
	for _, d := range dirs {
		if r := s.dirs[d]; r != nil {
			if smaller < 0 {
				smaller = r.smaller
			}
			if larger < 0 {
				larger = r.larger
			}
		}
	}
	if (smaller >= 0 && size < smaller) || (larger >= 0 && size > larger) {
		return SizeExcluded
	}
	return Included
}

// MatchPath is Match with the ancestor folders checked too (remote paths,
// which are not walked top-down).
func (s *Set) MatchPath(rel string, kind localfs.Kind, size int64) Result {
	dirs := ancestors(rel)
	for i := len(dirs) - 2; i >= 0; i-- { // skip "" (the root itself)
		if s.Match(dirs[i], localfs.KindDir, 0) == Excluded {
			return Excluded
		}
	}
	return s.Match(rel, kind, size)
}

func targets(t byte, k localfs.Kind) bool {
	switch t {
	case 'd':
		return k == localfs.KindDir
	case 'f':
		return k == localfs.KindFile
	case 's':
		return k == localfs.KindSymlink
	}
	return true
}
