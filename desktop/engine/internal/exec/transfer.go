package exec

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"sync"
	"time"
)

// Transfer pool (plan 7.5 "Scheduling"): global parallel_up / parallel_down
// slots handed out smallest-first, token-bucket bandwidth limits (global and
// per sync), pause/resume per transfer, direction or all, cancel for manual
// transfers, and throttled progress events.

// Directions.
const (
	Up   = "up"
	Down = "down"
)

// Transfer states (engine-ipc.md "Transfer").
const (
	TQueued    = "queued"
	TActive    = "active"
	TPaused    = "paused"
	TDone      = "done"
	TFailed    = "failed"
	TCancelled = "cancelled"
)

// TransferView is the IPC Transfer object.
type TransferView struct {
	ID         string  `json:"id"`
	SyncID     *string `json:"sync_id"`
	Direction  string  `json:"direction"`
	Path       string  `json:"path"`
	Size       int64   `json:"size"`
	Done       int64   `json:"done"`
	Bps        int64   `json:"bps"`
	State      string  `json:"state"`
	Error      *string `json:"error"`
	StartedAt  *string `json:"started_at"`
	FinishedAt *string `json:"finished_at"`
	Manual     bool    `json:"manual"`
}

// Transfer is one upload or download moving through the pool.
type Transfer struct {
	pool      *Pool
	id        string
	syncID    string
	dir       string
	path      string
	size      int64
	manual    bool
	bucket    *Bucket // per-sync limit (nil = none)
	cancel    context.CancelFunc
	seq       int
	done      int64
	state     string
	err       string
	paused    bool
	cancelReq bool
	started   time.Time
	finished  time.Time
	lastEmit  time.Time
	rateAt    time.Time
	rateBytes int64
	bps       int64
}

// Pool is safe for concurrent use.
type Pool struct {
	mu      sync.Mutex
	cond    *sync.Cond
	limit   map[string]int
	active  map[string]int
	paused  map[string]bool // direction -> paused
	global  map[string]*Bucket
	all     map[string]*Transfer
	nextID  int
	waiting []*Transfer

	// Notify receives transfer events (throttled to 4/s per transfer, plus
	// every state change). Finished is called once per finished transfer.
	Notify   func(TransferView)
	Finished func(TransferView)
}

// NewPool creates a pool with 2 + 2 slots and no bandwidth limit.
func NewPool() *Pool {
	p := &Pool{limit: map[string]int{Up: 2, Down: 2}, active: map[string]int{}, paused: map[string]bool{},
		global: map[string]*Bucket{Up: NewBucket(0), Down: NewBucket(0)}, all: map[string]*Transfer{}}
	p.cond = sync.NewCond(&p.mu)
	return p
}

// SetLimits applies the parallel_* and *_kbps settings.
func (p *Pool) SetLimits(up, down, upKbps, downKbps int) {
	p.mu.Lock()
	p.limit[Up], p.limit[Down] = max(up, 1), max(down, 1)
	p.mu.Unlock()
	p.global[Up].SetKbps(upKbps)
	p.global[Down].SetKbps(downKbps)
	p.cond.Broadcast()
}

// Begin registers a queued transfer; ctx is cancelled by Cancel (manual
// transfers only). The caller must call Start, then Finish.
func (p *Pool) Begin(ctx context.Context, syncID, dir, path string, size int64, manual bool, bucket *Bucket) (*Transfer, context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	p.mu.Lock()
	p.nextID++
	t := &Transfer{pool: p, id: "t_" + strconv.Itoa(p.nextID), seq: p.nextID, syncID: syncID, dir: dir, path: path, size: size,
		manual: manual, bucket: bucket, cancel: cancel, state: TQueued}
	p.all[t.id] = t
	p.mu.Unlock()
	p.emit(t, true)
	return t, ctx
}

// Start waits for a free slot in the transfer's direction (smallest first)
// while neither it nor its direction is paused.
func (t *Transfer) Start(ctx context.Context) error {
	p := t.pool
	stop := context.AfterFunc(ctx, func() { p.mu.Lock(); p.cond.Broadcast(); p.mu.Unlock() })
	defer stop()
	p.mu.Lock()
	p.waiting = append(p.waiting, t)
	for {
		if ctx.Err() != nil {
			p.dropWaiting(t)
			p.mu.Unlock()
			return ctx.Err()
		}
		if p.active[t.dir] < p.limit[t.dir] && !t.paused && !p.paused[t.dir] && p.first(t) {
			break
		}
		p.cond.Wait()
	}
	p.dropWaiting(t)
	p.active[t.dir]++
	t.state, t.started, t.rateAt = TActive, time.Now(), time.Now()
	p.mu.Unlock()
	p.cond.Broadcast()
	p.emit(t, true)
	return nil
}

// first: t is the smallest runnable waiter of its direction.
func (p *Pool) first(t *Transfer) bool {
	for _, w := range p.waiting {
		if w != t && w.dir == t.dir && !w.paused && (w.size < t.size || (w.size == t.size && w.seq < t.seq)) {
			return false
		}
	}
	return true
}

func (p *Pool) dropWaiting(t *Transfer) {
	for i, w := range p.waiting {
		if w == t {
			p.waiting = append(p.waiting[:i], p.waiting[i+1:]...)
			return
		}
	}
}

// Wait throttles n bytes: it blocks while the transfer is paused, then
// pays the global and per-sync buckets.
func (t *Transfer) Wait(ctx context.Context, n int) error {
	p := t.pool
	stop := context.AfterFunc(ctx, func() { p.mu.Lock(); p.cond.Broadcast(); p.mu.Unlock() })
	p.mu.Lock()
	for (t.paused || p.paused[t.dir]) && ctx.Err() == nil {
		if t.state != TPaused {
			t.state = TPaused
			p.mu.Unlock()
			p.emit(t, true)
			p.mu.Lock()
		}
		p.cond.Wait()
	}
	resumed := t.state == TPaused
	if resumed {
		t.state = TActive
	}
	p.mu.Unlock()
	stop()
	if resumed {
		p.emit(t, true)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := p.global[t.dir].Wait(ctx, n); err != nil {
		return err
	}
	if t.bucket != nil {
		return t.bucket.Wait(ctx, n)
	}
	return nil
}

// Progress adds n transferred bytes.
func (t *Transfer) Progress(n int64) {
	p := t.pool
	p.mu.Lock()
	t.done += n
	t.rateBytes += n
	if el := time.Since(t.rateAt); el >= time.Second {
		t.bps = int64(float64(t.rateBytes) / el.Seconds())
		t.rateAt, t.rateBytes = time.Now(), 0
	}
	p.mu.Unlock()
	p.emit(t, false)
}

// SetDone resets the progress (a resumed transfer starts at its offset).
func (t *Transfer) SetDone(n int64) {
	t.pool.mu.Lock()
	t.done = n
	t.pool.mu.Unlock()
}

// Finish releases the slot and records the outcome (err nil = done).
func (t *Transfer) Finish(err error) {
	p := t.pool
	p.mu.Lock()
	if t.state == TActive || t.state == TPaused {
		p.active[t.dir]--
	}
	p.dropWaiting(t)
	switch {
	case err == nil:
		t.state, t.done = TDone, t.size
	case t.cancelReq || errors.Is(err, ErrSuperseded) || errors.Is(err, context.Canceled):
		t.state = TCancelled // cancelled, re-planned or interrupted (pause): not a failure
	default:
		t.state, t.err = TFailed, err.Error()
	}
	t.finished, t.bps = time.Now(), 0
	view := t.viewLocked()
	p.mu.Unlock()
	t.cancel()
	p.cond.Broadcast()
	p.emit(t, true)
	if p.Finished != nil {
		p.Finished(view)
	}
}

// ID is the transfer id.
func (t *Transfer) ID() string { return t.id }

func iso(tm time.Time) *string {
	if tm.IsZero() {
		return nil
	}
	s := tm.UTC().Format(time.RFC3339)
	return &s
}

func (t *Transfer) viewLocked() TransferView {
	v := TransferView{ID: t.id, Direction: t.dir, Path: t.path, Size: t.size, Done: t.done, Bps: t.bps, State: t.state,
		StartedAt: iso(t.started), FinishedAt: iso(t.finished), Manual: t.manual}
	if t.syncID != "" {
		s := t.syncID
		v.SyncID = &s
	}
	if t.err != "" {
		e := t.err
		v.Error = &e
	}
	return v
}

func (p *Pool) emit(t *Transfer, force bool) {
	p.mu.Lock()
	if !force && time.Since(t.lastEmit) < 250*time.Millisecond {
		p.mu.Unlock()
		return
	}
	t.lastEmit = time.Now()
	v := t.viewLocked()
	p.mu.Unlock()
	if p.Notify != nil {
		p.Notify(v)
	}
}

// List returns the transfers in id order, optionally filtered by state
// (paused transfers count as active).
func (p *Pool) List(state string) []TransferView {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []TransferView{}
	for _, t := range p.all {
		if state == "" || t.state == state || (state == TActive && t.state == TPaused) {
			out = append(out, t.viewLocked())
		}
	}
	sort.Slice(out, func(i, j int) bool { return p.all[out[i].ID].seq < p.all[out[j].ID].seq })
	return out
}

// Rates returns the summed bytes/s per direction.
func (p *Pool) Rates() (up, down int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, t := range p.all {
		if t.state == TActive {
			if t.dir == Up {
				up += t.bps
			} else {
				down += t.bps
			}
		}
	}
	return up, down
}

// SetPaused pauses or resumes one transfer (id), a direction, or everything.
// It reports false when id is unknown.
func (p *Pool) SetPaused(id, dir string, pause bool) bool {
	p.mu.Lock()
	var changed []*Transfer
	switch {
	case id != "":
		t := p.all[id]
		if t == nil {
			p.mu.Unlock()
			return false
		}
		t.paused = pause
		changed = append(changed, t)
	case dir != "":
		p.paused[dir] = pause
	default:
		p.paused[Up], p.paused[Down] = pause, pause
	}
	if id == "" {
		for _, t := range p.all {
			if dir == "" || t.dir == dir {
				if !pause {
					t.paused = false
				}
				changed = append(changed, t)
			}
		}
	}
	for _, t := range changed {
		if t.state == TActive && pause {
			t.state = TPaused
		} else if t.state == TPaused && !pause {
			t.state = TActive
		}
	}
	p.mu.Unlock()
	p.cond.Broadcast()
	for _, t := range changed {
		p.emit(t, true)
	}
	return true
}

// Cancel stops a manual transfer. It reports false for unknown ids and sync
// transfers (those stop by pausing the sync).
func (p *Pool) Cancel(id string) bool {
	p.mu.Lock()
	t := p.all[id]
	ok := t != nil && t.manual
	if ok && t.state != TDone && t.state != TFailed && t.state != TCancelled {
		t.cancelReq = true
	}
	p.mu.Unlock()
	if ok {
		t.cancel()
		p.cond.Broadcast()
	}
	return ok
}

// ClearCompleted forgets finished transfers.
func (p *Pool) ClearCompleted() {
	p.mu.Lock()
	for id, t := range p.all {
		if t.state == TDone || t.state == TFailed || t.state == TCancelled {
			delete(p.all, id)
		}
	}
	p.mu.Unlock()
}

// Bucket is a token bucket in bytes per second (0 = unlimited). A request
// larger than the burst runs into debt that later requests pay off.
type Bucket struct {
	mu     sync.Mutex
	rate   float64
	tokens float64
	last   time.Time
}

func NewBucket(kbps int) *Bucket {
	b := &Bucket{}
	b.SetKbps(kbps)
	return b
}

// SetKbps changes the rate (KiB/s).
func (b *Bucket) SetKbps(kbps int) {
	b.mu.Lock()
	b.rate = float64(kbps) * 1024
	b.tokens = min(b.tokens, b.rate)
	b.last = time.Now()
	b.mu.Unlock()
}

// Wait takes n tokens, sleeping off any debt.
func (b *Bucket) Wait(ctx context.Context, n int) error {
	b.mu.Lock()
	if b.rate <= 0 {
		b.mu.Unlock()
		return nil
	}
	now := time.Now()
	b.tokens = min(b.tokens+now.Sub(b.last).Seconds()*b.rate, b.rate)
	b.last = now
	b.tokens -= float64(n)
	var d time.Duration
	if b.tokens < 0 {
		d = time.Duration(-b.tokens / b.rate * float64(time.Second))
	}
	b.mu.Unlock()
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
