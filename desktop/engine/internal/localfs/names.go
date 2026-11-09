package localfs

import (
	"runtime"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

// Names maps one.gy names to local names and back (plan 7.7 "Name not
// allowed locally"). Characters the local file system rejects become %XX
// (uppercase hex): on Windows rules <>:"/\|?*, control characters, a trailing
// dot or space and the first character of a reserved name (CON, NUL.txt,
// ...); otherwise / and NUL. A literal % is escaped only where it would
// otherwise read as one of those escapes, so ordinary names such as
// "100% done" or "my%20file.pdf" stay as they are. ToRemote(ToLocal(r)) == r
// for every r.
type Names struct{ Windows bool }

// NamesFor picks the rules for a sync: Windows rules on Windows and on
// FAT/exFAT/NTFS volumes mounted elsewhere.
func NamesFor(fsKind string) Names {
	switch fsKind {
	case "vfat", "fat32", "exfat", "ntfs":
		return Names{Windows: true}
	}
	return Names{Windows: runtime.GOOS == "windows"}
}

var reservedNames = map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM\u00b9": true, "COM\u00b2": true, "COM\u00b3": true, "LPT\u00b9": true, "LPT\u00b2": true, "LPT\u00b3": true}

func init() {
	for _, d := range "123456789" {
		reservedNames["COM"+string(d)] = true
		reservedNames["LPT"+string(d)] = true
	}
}

func (n Names) invalid(c byte) bool {
	if n.Windows {
		return c < 32 || strings.IndexByte(`<>:"/\|?*`, c) >= 0
	}
	return c == '/' || c == 0
}

func (n Names) reserved(name string) bool {
	if !n.Windows {
		return false
	}
	base, _, _ := strings.Cut(name, ".")
	return reservedNames[strings.ToUpper(strings.TrimRight(base, " "))]
}

func hexPair(s string) (byte, bool) {
	if len(s) < 2 {
		return 0, false
	}
	v := func(c byte) int {
		switch {
		case c >= '0' && c <= '9':
			return int(c - '0')
		case c >= 'A' && c <= 'F':
			return int(c-'A') + 10
		}
		return -1
	}
	hi, lo := v(s[0]), v(s[1])
	if hi < 0 || lo < 0 {
		return 0, false
	}
	return byte(hi<<4 | lo), true
}

// special reports whether an escape of byte b, at the start of the name or
// not, followed by the (unescaped) rest of the name, is one ToLocal emits.
func (n Names) special(b byte, start bool, rest string) bool {
	switch {
	case n.invalid(b):
		return true
	case n.Windows && (b == '.' || b == ' ') && rest == "":
		return true
	case start && n.reserved(string(b)+rest):
		return true
	case b == '%':
		h, ok := hexPair(rest)
		return ok && n.special(h, start, rest[2:])
	}
	return false
}

const hexDigits = "0123456789ABCDEF"

// ToLocal returns the local name for a one.gy name.
func (n Names) ToLocal(remote string) string {
	var b strings.Builder
	for i := 0; i < len(remote); i++ {
		c, rest := remote[i], remote[i+1:]
		esc := n.invalid(c) || (n.Windows && (c == '.' || c == ' ') && rest == "") || (i == 0 && n.reserved(remote))
		if !esc && c == '%' {
			h, ok := hexPair(rest)
			esc = ok && n.special(h, i == 0, rest[2:])
		}
		if esc {
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&15])
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// ToRemote returns the one.gy name for a local name. ok is false when the
// local name is not one ToLocal can produce (the caller raises invalid_name).
func (n Names) ToRemote(local string) (remote string, ok bool) {
	// Right to left: whether %XX is an escape depends on the decoded rest.
	suffix := make([]string, len(local)+1)
	for i := len(local) - 1; i >= 0; i-- {
		if local[i] == '%' && i+3 <= len(local) {
			if h, ok := hexPair(local[i+1 : i+3]); ok && n.special(h, i == 0, suffix[i+3]) {
				suffix[i] = string(h) + suffix[i+3]
				continue
			}
		}
		suffix[i] = local[i:i+1] + suffix[i+1]
	}
	remote = suffix[0]
	return remote, n.ToLocal(remote) == local
}

// TooLong reports a name over the file system limit (255 UTF-16 units with
// Windows rules, else 255 bytes).
func (n Names) TooLong(local string) bool {
	if n.Windows {
		return len(utf16.Encode([]rune(local))) > 255
	}
	return len(local) > 255
}

// NFC returns s in Unicode normalization form C.
func NFC(s string) string { return norm.NFC.String(s) }

// Key is the comparison key of a name or path: NFC, case-folded on
// case-insensitive file systems. The original bytes are kept elsewhere.
func Key(s string, caseSensitive bool) string {
	s = NFC(s)
	if !caseSensitive {
		s = strings.ToLower(s)
	}
	return s
}
