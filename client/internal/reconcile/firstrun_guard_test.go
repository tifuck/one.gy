package reconcile

import (
	"fmt"
	"testing"
)

// AUDIT FIX (F1): first-run deletes (no base row) go through the mass-delete guard.
func TestFirstRunMassDelete(t *testing.T) {
	countKinds := func(p *Plan, k OpKind) int {
		n := 0
		for _, o := range p.Ops {
			if o.Kind == k {
				n++
			}
		}
		return n
	}
	check := func(label string, w *world, kind OpKind, side string, count int) {
		t.Helper()
		p := w.plan(t)
		if countKinds(p, kind) != 0 {
			t.Fatalf("%s: %d %s ops planned before an answer", label, countKinds(p, kind), kind)
		}
		if len(p.Issues) != 1 || p.Issues[0].Kind != "mass_delete" || p.Issues[0].Detail["side"] != side || p.Issues[0].Detail["count"] != count {
			t.Fatalf("%s: issues %+v", label, p.Issues)
		}
		if side == "local" {
			w.cfg.MassDeleteLocal = "apply"
		} else {
			w.cfg.MassDeleteRemote = "apply"
		}
		if n := countKinds(w.plan(t), kind); n == 0 {
			t.Fatalf("%s: apply planned no %s", label, kind)
		}
		if side == "local" {
			w.cfg.MassDeleteLocal = "restore"
		} else {
			w.cfg.MassDeleteRemote = "restore"
		}
		if p := w.plan(t); countKinds(p, kind) != 0 || len(p.Issues) != 0 {
			t.Fatalf("%s: restore still deletes: %q %+v", label, summary(p), p.Issues)
		}
	}
	localOnly := func() *world {
		w := newWorld().rf("u0", "root", "keep", "k", 1, 1)
		for i := 0; i < 60; i++ {
			w.lf(fmt.Sprintf("l%02d", i), fmt.Sprintf("L%d", i), "x")
		}
		return w
	}
	w := localOnly()
	w.cfg.Type = "mirror"
	check("mirror onto a full folder", w, DeleteLocal, "remote", 60)
	w = localOnly()
	w.cfg.Initial = "remote_source"
	check("remote_source", w, DeleteLocal, "remote", 60)

	w = newWorld().lf("keep", "L0", "k")
	for i := 0; i < 60; i++ {
		w.rf(fmt.Sprintf("u%d", i), "root", fmt.Sprintf("r%02d", i), "y", 1, 1)
	}
	w.cfg.Initial = "local_source"
	check("local_source", w, TrashRemote, "local", 60)

	// A folder counts with everything below it.
	w = newWorld().ld("big", "D")
	for i := 0; i < 60; i++ {
		w.lf(fmt.Sprintf("big/f%02d", i), fmt.Sprintf("L%d", i), "x")
	}
	w.cfg.Type = "mirror"
	check("mirror folder", w, DeleteLocal, "remote", 61)

	// Few items: no question.
	w = newWorld().lf("a", "L1", "x").lf("b", "L2", "x")
	w.cfg.Type = "mirror"
	if p := w.plan(t); countKinds(p, DeleteLocal) != 2 || len(p.Issues) != 0 {
		t.Fatalf("small mirror: %q %+v", summary(p), p.Issues)
	}
}
