package reconcile

import (
	"fmt"
	"testing"
)

// A "restore" answer to a mass-delete question never lets the held-back
// deletes run, in one-direction syncs too.
func TestMassDeleteRestoreOneWay(t *testing.T) {
	kinds := func(p *Plan) map[OpKind]int {
		out := map[OpKind]int{}
		for _, o := range p.Ops {
			out[o.Kind]++
		}
		return out
	}
	cases := []struct {
		typ, side string
		gone      func(w *world, p string) // the item p is deleted on that side
		del, back OpKind                   // the delete held back, the op restoring it (none: held)
	}{
		{"backup", "local", func(w *world, p string) { w.rf("u"+p, "root", p, "h", 1, 1) }, TrashRemote, Download},
		{"mirror", "remote", func(w *world, p string) { w.lf(p, "L"+p, "h") }, DeleteLocal, ""},
	}
	for _, c := range cases {
		w := newWorld()
		w.cfg.Type = c.typ
		for i := 0; i < 100; i++ {
			p := fmt.Sprintf("f%02d", i)
			w.bf(p, "u"+p, "L"+p, "h", 1)
			if i < 40 {
				w.lf(p, "L"+p, "h").rf("u"+p, "root", p, "h", 1, 1)
			} else {
				c.gone(w, p)
			}
		}
		p := w.plan(t)
		if len(p.Issues) != 1 || p.Issues[0].Kind != "mass_delete" || p.Issues[0].Detail["side"] != c.side || p.Issues[0].Detail["count"] != 60 {
			t.Fatalf("%s: issues %+v", c.typ, p.Issues)
		}
		if c.side == "local" {
			w.cfg.MassDeleteLocal = "apply"
		} else {
			w.cfg.MassDeleteRemote = "apply"
		}
		if n := kinds(w.plan(t))[c.del]; n != 60 {
			t.Fatalf("%s apply: %d %s", c.typ, n, c.del)
		}
		if c.side == "local" {
			w.cfg.MassDeleteLocal = "restore"
		} else {
			w.cfg.MassDeleteRemote = "restore"
		}
		p = w.plan(t)
		k := kinds(p)
		if k[c.del] != 0 || len(p.Issues) != 0 {
			t.Fatalf("%s restore still deletes: %q %+v", c.typ, summary(p), p.Issues)
		}
		if c.back != "" && (k[c.back] != 60 || len(p.Ops) != 60) {
			t.Fatalf("%s restore: %q", c.typ, summary(p))
		}
		if c.back == "" && len(p.Ops) != 0 {
			t.Fatalf("%s restore: %q", c.typ, summary(p))
		}
	}
}

// a.txt renamed here to b.txt while one.gy deleted a.txt and got an
// unrelated b.txt: not a replacement of a.txt, so b.txt is not overwritten.
func TestMovedItemNotPairedAsReplaced(t *testing.T) {
	w := newWorld().bf("a.txt", "u1", "L1", "h", 1).lf("b.txt", "L1", "h").rf("u2", "root", "b.txt", "z", 1, 2)
	p := w.plan(t)
	for _, o := range p.Ops {
		if o.Kind == Download && o.Path == "b.txt" && (o.Local == nil || !o.Local.Absent) {
			t.Fatalf("local b.txt overwritten: %q", summary(p))
		}
	}
	// Same path (or only a case/Unicode-form change): still a replacement.
	w = newWorld().bf("a.txt", "u1", "L1", "h", 1).lf("a.txt", "L1", "h").rf("u2", "root", "a.txt", "z", 1, 2)
	eq(t, "replaced", summary(w.plan(t)), "download a.txt")
}
