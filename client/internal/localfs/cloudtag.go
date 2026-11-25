package localfs

// Cloud Files placeholders (OneDrive, and the Explorer status icons of
// ONE.GY's own syncs on Windows) are reparse points tagged
// IO_REPARSE_TAG_CLOUD (0x9000001A) or one of its 0x9000x01A variants. Go
// reports them as irregular files; the engine treats them by what they hold.
const (
	reparseTagCloud     = 0x9000001A
	reparseTagCloudMask = 0xFFFF0FFF

	attrDirectory          = 0x10
	attrOffline            = 0x1000
	attrRecallOnOpen       = 0x40000
	attrRecallOnDataAccess = 0x400000
)

// IsCloudTag reports whether a reparse tag marks a Cloud Files placeholder.
func IsCloudTag(tag uint32) bool { return tag&reparseTagCloudMask == reparseTagCloud }

// cloudKind classifies a Cloud Files placeholder by its attributes: a folder,
// or a file whose data is all on disk. A file its provider still has to
// download (online-only or partly hydrated) stays Special, so it is never
// read, hashed or uploaded.
func cloudKind(attrs uint32) Kind {
	switch {
	case attrs&attrDirectory != 0:
		return KindDir
	case attrs&(attrOffline|attrRecallOnOpen|attrRecallOnDataAccess) != 0:
		return KindSpecial
	}
	return KindFile
}
