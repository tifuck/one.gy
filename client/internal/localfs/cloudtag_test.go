package localfs

import "testing"

func TestCloudPlaceholderKind(t *testing.T) {
	for _, tag := range []uint32{0x9000001A, 0x9000101A, 0x9000F01A} {
		if !IsCloudTag(tag) {
			t.Errorf("%#x is a cloud tag", tag)
		}
	}
	for _, tag := range []uint32{0xA000000C, 0xA0000003, 0x80000013, 0x8000001B, 0x9000001B, 0x9001001A} {
		if IsCloudTag(tag) {
			t.Errorf("%#x is not a cloud tag", tag)
		}
	}
	const archive, pinned = 0x20, 0x80000
	cases := []struct {
		attrs uint32
		want  Kind
	}{
		{archive, KindFile},
		{archive | pinned, KindFile},
		{attrDirectory, KindDir},
		{attrDirectory | attrRecallOnOpen, KindDir}, // listing it is the provider's business
		{archive | attrRecallOnDataAccess, KindSpecial},
		{archive | attrOffline | attrRecallOnDataAccess, KindSpecial},
		{attrRecallOnOpen, KindSpecial},
	}
	for _, c := range cases {
		if got := cloudKind(c.attrs); got != c.want {
			t.Errorf("cloudKind(%#x) = %v, want %v", c.attrs, got, c.want)
		}
	}
}
