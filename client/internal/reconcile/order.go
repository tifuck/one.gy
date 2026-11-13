package reconcile

import (
	"container/heap"
	"sort"

	"github.com/tifuck/one.gy/client/internal/localfs"
)

// order sorts a plan: structural ops in dependency order, then content ops
// (small files first), then deletes.
func order(ops []Op) []Op {
	var structural, content, deletes []Op
	for _, o := range ops {
		switch o.Kind {
		case CreateLocalDir, CreateRemoteDir, MoveLocal, MoveRemote, Conflict, RestoreRemote:
			structural = append(structural, o)
		case Link:
			if o.EntryKind == localfs.KindDir {
				structural = append(structural, o)
			} else {
				content = append(content, o)
			}
		case Upload, Download, VerifyLink, SetModeRemote, SetModeLocal:
			content = append(content, o)
		default:
			deletes = append(deletes, o)
		}
	}
	sort.SliceStable(content, func(i, j int) bool { return content[i].Size < content[j].Size })
	sort.SliceStable(deletes, func(i, j int) bool { return deletes[i].Path < deletes[j].Path })
	out := topo(structural)
	out = append(out, content...)
	return append(out, deletes...)
}

const (
	sideLocal  = 1
	sideRemote = 2
)

func sideOf(o *Op) int {
	switch o.Kind {
	case CreateLocalDir, MoveLocal, Conflict:
		return sideLocal
	case CreateRemoteDir, MoveRemote, RestoreRemote:
		return sideRemote
	}
	return sideLocal | sideRemote // folder Link: the folder exists on both sides once linked
}

// topo orders structural ops so each runs after the ops (on its side) that
// create or move in its parent folders or its source, and after any op
// that vacates its target. Ties keep plan order; a cycle (e.g. two items
// swapping names) falls back to plan order and the executor's
// preconditions catch it.
func topo(ops []Op) []Op {
	n := len(ops)
	prod := map[int]map[string][]int{sideLocal: {}, sideRemote: {}}
	vac := map[int]map[string][]int{sideLocal: {}, sideRemote: {}}
	for i := range ops {
		for _, s := range []int{sideLocal, sideRemote} {
			if sideOf(&ops[i])&s != 0 {
				prod[s][ops[i].Path] = append(prod[s][ops[i].Path], i)
				if ops[i].From != "" {
					vac[s][ops[i].From] = append(vac[s][ops[i].From], i)
				}
			}
		}
	}
	after := make([][]int, n)
	indeg := make([]int, n)
	for i := range ops {
		o := &ops[i]
		seen := map[int]bool{i: true}
		dep := func(js []int) {
			for _, j := range js {
				if !seen[j] {
					seen[j] = true
					after[j] = append(after[j], i)
					indeg[i]++
				}
			}
		}
		for _, s := range []int{sideLocal, sideRemote} {
			if sideOf(o)&s == 0 {
				continue
			}
			for q := parentOf(o.Path); q != ""; q = parentOf(q) {
				dep(prod[s][q])
			}
			for q := parentOf(o.From); q != ""; q = parentOf(q) {
				dep(prod[s][q])
			}
			// Same exact path: one item's chain (moved, then renamed as a
			// conflict copy) runs producer first; between different items the
			// one moving away goes first.
			for _, j := range prod[s][o.From] {
				if sameItem(o, &ops[j]) {
					dep([]int{j})
				}
			}
			for _, j := range vac[s][o.Path] {
				if !sameItem(o, &ops[j]) {
					dep([]int{j})
				}
			}
		}
	}
	h := &intHeap{}
	for i := 0; i < n; i++ {
		if indeg[i] == 0 {
			heap.Push(h, i)
		}
	}
	out := make([]Op, 0, n)
	done := make([]bool, n)
	for h.Len() > 0 {
		i := heap.Pop(h).(int)
		done[i] = true
		out = append(out, ops[i])
		for _, j := range after[i] {
			if indeg[j]--; indeg[j] == 0 {
				heap.Push(h, j)
			}
		}
	}
	for i := range ops {
		if !done[i] {
			out = append(out, ops[i])
		}
	}
	return out
}

func sameItem(a, b *Op) bool { return a.Base != nil && a.Base == b.Base }

type intHeap []int

func (h intHeap) Len() int           { return len(h) }
func (h intHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h intHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *intHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *intHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}
