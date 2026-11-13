package exec

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/tifuck/one.gy/client/internal/api"
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

// Phases of an active transfer (engine-ipc.md "Transfer").
const (
	PPreparing    = "preparing"    // reading, hashing and encrypting the local file (done counts that)
	PTransferring = "transferring" // bytes are moving
	PFinishing    = "finishing"    // sent: one.gy saves it; received: checked and put in place
	PRetrying     = "retrying"     // waits before another attempt; note says why
)

// An active transfer without a sign of life gets a note after noteAfter and
// counts as stalled after stalledAfter; finished ones beyond keepFinished go.
const (
	noteAfter    = 10 * time.Second
	stalledAfter = 30 * time.Second
	keepFinished = 500
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
	Phase      string  `json:"phase"`
	Note       *string `json:"note"`
	Stalled    bool    `json:"stalled"`
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
	base      int64 // Span: where the request body being sent starts in done
	span      int64
	last      bool
	state     string
	phase     string
	before    string // phase to go back to after retrying
	note      string
	stalled   bool
	held      bool      // sleeping off a bandwidth limit
	alive     time.Time // last sign of life
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
	// settled: bytes of finished transfers a sync has not counted off what it
	// has left yet (Flow keeps counting them, so that number never jumps back).
	settled map[string]int64

	// Notify receives transfer events (throttled to 4/s per transfer, plus
	// every state change). Finished is called once per finished transfer.
	Notify   func(TransferView)
	Finished func(TransferView)
}

// NewPool creates a pool with 2 + 2 slots and no bandwidth limit.
func NewPool() *Pool {
	p := &Pool{limit: map[string]int{Up: 2, Down: 2}, active: map[string]int{}, paused: map[string]bool{},
		global: map[string]*Bucket{Up: NewBucket(0), Down: NewBucket(0)}, all: map[string]*Transfer{}, settled: map[string]int64{}}
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
	t.state, t.started, t.rateAt, t.alive = TActive, time.Now(), time.Now(), time.Now()
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
	t.hold(true)
	defer t.hold(false)
	if err := p.global[t.dir].Wait(ctx, n); err != nil {
		return err
	}
	if t.bucket != nil {
		return t.bucket.Wait(ctx, n)
	}
	return nil
}

func (t *Transfer) hold(on bool) {
	t.pool.mu.Lock()
	t.held, t.alive = on, time.Now()
	t.pool.mu.Unlock()
}

// Progress adds n transferred bytes.
func (t *Transfer) Progress(n int64) { t.move(n, false) }

// At sets the transferred bytes (a request body sent again starts over).
func (t *Transfer) At(n int64) { t.move(n, true) }

func (t *Transfer) move(n int64, abs bool) {
	p := t.pool
	p.mu.Lock()
	if abs {
		n -= t.done
	}
	t.done += n
	if n > 0 {
		t.rateBytes += n
	}
	if el := time.Since(t.rateAt); el >= time.Second {
		t.bps = int64(float64(t.rateBytes) / el.Seconds())
		t.rateAt, t.rateBytes = time.Now(), 0
	}
	force := t.livenLocked(PTransferring)
	p.mu.Unlock()
	p.emit(t, force)
}

// livenLocked records a sign of life in phase and reports whether the view
// changed beyond the byte counts.
func (t *Transfer) livenLocked(phase string) bool {
	changed := t.phase != phase || t.note != "" || t.stalled
	t.phase, t.note, t.stalled, t.alive = phase, "", false, time.Now()
	return changed
}

// Phase starts a phase. Preparing counts its own bytes (Prep), so done
// starts over there and again when the transfer itself begins.
func (t *Transfer) Phase(phase string) {
	p := t.pool
	p.mu.Lock()
	if phase == PPreparing || t.phase == PPreparing {
		t.done = 0
	}
	if phase != PTransferring {
		t.bps = 0
	}
	t.livenLocked(phase)
	p.mu.Unlock()
	p.emit(t, true)
}

// Prep adds n bytes read while preparing (no transfer rate).
func (t *Transfer) Prep(n int) {
	p := t.pool
	p.mu.Lock()
	t.done += int64(n)
	force := t.livenLocked(PPreparing)
	p.mu.Unlock()
	p.emit(t, force)
}

// Span maps the request body sent next onto done: it covers n bytes from
// base; last = the transfer is complete once it is sent.
func (t *Transfer) Span(base, n int64, last bool) {
	t.pool.mu.Lock()
	t.base, t.span, t.last = base, n, last
	t.pool.mu.Unlock()
}

// sent is the api.Observer's Sent: sent of total body bytes went out.
func (t *Transfer) sent(sent, total int64) {
	p := t.pool
	p.mu.Lock()
	base, span, last := t.base, t.span, t.last
	p.mu.Unlock()
	if total <= 0 {
		return
	}
	t.At(base + span*sent/total)
	if last && sent >= total {
		t.Phase(PFinishing)
	}
}

// Retrying shows why the transfer waits before another attempt; "" = the
// wait is over and the request goes out again.
func (t *Transfer) Retrying(note string) {
	p := t.pool
	p.mu.Lock()
	if note == "" {
		t.livenLocked(t.before)
	} else {
		if t.phase != PRetrying {
			t.before = t.phase
		}
		t.livenLocked(PRetrying)
		t.note, t.bps = note, 0
	}
	p.mu.Unlock()
	p.emit(t, true)
}

// Observe makes the API requests sent with the returned context report
// their upload progress and retries on t.
func (t *Transfer) Observe(ctx context.Context) context.Context {
	return api.WithObserver(ctx, &api.Observer{Sent: t.sent, Retry: func(why string, wait time.Duration) {
		if why != "" {
			why = fmt.Sprintf("%s; trying again in %s", why, wait.Round(time.Second))
		}
		t.Retrying(why)
	}})
}

// Tick (once a second) says so on active transfers that show no sign of
// life, and zeroes the speed of ones that stopped moving.
func (p *Pool) Tick() {
	p.mu.Lock()
	var changed []*Transfer
	for _, t := range p.all {
		if t.state != TActive || t.phase == PRetrying {
			continue
		}
		idle := time.Since(t.alive)
		note, bps := "", t.bps
		if idle >= 3*time.Second {
			bps = 0
		}
		if idle >= noteAfter {
			s := idle.Round(time.Second)
			switch {
			case t.held:
				note = "Held back by the speed limit"
			case t.phase == PPreparing:
				note = fmt.Sprintf("Reading the file: no progress for %s", s)
			case t.phase == PFinishing && t.dir == Up:
				note = fmt.Sprintf("Sent; one.gy has not confirmed for %s", s)
			case t.phase == PFinishing: // decrypting and checking a download is local work
			default:
				note = fmt.Sprintf("No data moved for %s", s)
			}
		}
		stalled := note != "" && !t.held && idle >= stalledAfter
		if note != t.note || bps != t.bps || stalled != t.stalled {
			t.note, t.bps, t.stalled = note, bps, stalled
			changed = append(changed, t)
		}
	}
	p.mu.Unlock()
	for _, t := range changed {
		p.emit(t, true)
	}
}

// Flow sums what the active transfers of a sync have moved so far and gives
// the first note among them (why the sync is not getting on).
func (p *Pool) Flow(syncID string) (moved int64, note string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	moved = p.settled[syncID]
	for _, t := range p.all {
		if t.syncID == syncID && t.state == TQueued && p.paused[t.dir] && note == "" {
			note = pausedNote[t.dir] + "; resume them in Transfers"
		}
		if t.syncID != syncID || (t.state != TActive && t.state != TPaused) {
			continue
		}
		if t.phase == PTransferring || t.phase == PFinishing {
			moved += min(t.done, t.size)
		}
		if note == "" && !t.held {
			note = t.note
		}
	}
	return moved, note
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
		if t.syncID != "" {
			p.settled[t.syncID] += t.size
		}
	case t.cancelReq || errors.Is(err, ErrSuperseded) || errors.Is(err, context.Canceled):
		t.state = TCancelled // cancelled, re-planned or interrupted (pause): not a failure
	default:
		t.state, t.err = TFailed, err.Error()
	}
	t.finished, t.bps = time.Now(), 0
	t.phase, t.note, t.stalled = "", "", false
	view := t.viewLocked()
	p.forgetOldLocked()
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

// pausedNote: why a queued transfer does not start (its direction is paused).
var pausedNote = map[string]string{Up: "Uploads are paused", Down: "Downloads are paused"}

// Paused reports which directions are paused (transfers.pause with a direction or all).
func (p *Pool) Paused() (up, down bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.paused[Up], p.paused[Down]
}

// Forget drops the finished transfers of a removed sync (nothing will retry them).
func (p *Pool) Forget(syncID string) {
	p.mu.Lock()
	for id, t := range p.all {
		if t.syncID == syncID && (t.state == TDone || t.state == TFailed || t.state == TCancelled) {
			delete(p.all, id)
		}
	}
	delete(p.settled, syncID)
	p.mu.Unlock()
}

func iso(tm time.Time) *string {
	if tm.IsZero() {
		return nil
	}
	s := tm.UTC().Format(time.RFC3339)
	return &s
}

func (t *Transfer) viewLocked() TransferView {
	v := TransferView{ID: t.id, Direction: t.dir, Path: t.path, Size: t.size, Done: max(min(t.done, t.size), 0), Bps: t.bps, State: t.state,
		Phase: t.phase, Stalled: t.stalled, StartedAt: iso(t.started), FinishedAt: iso(t.finished), Manual: t.manual}
	if t.note != "" {
		n := t.note
		v.Note = &n
	} else if t.state == TQueued && t.pool.paused[t.dir] {
		n := pausedNote[t.dir]
		v.Note = &n
	}
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

// Settle: the sync counted n bytes of a finished transfer off what it has
// left (n < 0: it counted anew, nothing is outstanding).
func (p *Pool) Settle(syncID string, n int64) {
	p.mu.Lock()
	if left := p.settled[syncID] - n; n < 0 || left <= 0 {
		delete(p.settled, syncID)
	} else {
		p.settled[syncID] = left
	}
	p.mu.Unlock()
}

// forgetOldLocked keeps the newest keepFinished finished transfers (a long
// run of small files would otherwise grow the list without end).
func (p *Pool) forgetOldLocked() {
	var fin []*Transfer
	for _, t := range p.all {
		if t.state == TDone || t.state == TFailed || t.state == TCancelled {
			fin = append(fin, t)
		}
	}
	if len(fin) < keepFinished+100 {
		return
	}
	sort.Slice(fin, func(i, j int) bool { return fin[i].seq < fin[j].seq })
	for _, t := range fin[:len(fin)-keepFinished] {
		delete(p.all, t.id)
	}
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
