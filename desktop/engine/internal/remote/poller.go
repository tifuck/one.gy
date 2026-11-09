package remote

import (
	"context"
	"errors"
	"log/slog"
	"math/rand"
	"sync"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/account"
	"github.com/tifuck/one.gy/desktop/engine/internal/api"
)

// Poller keeps the tree fresh (plan 7.4): GET /sync/cursor (ETag, so an idle
// account costs a 304) every 5 s while active, 30 s when idle, 120 s after
// 30 min idle, each ±20% jitter. Activity = a nudge or an applied change.
type Poller struct {
	tree *Tree

	// Floor returns the minimum interval (settings poll_floor_seconds).
	Floor func() time.Duration
	// OnApplied runs after remote changes were applied to the cache.
	OnApplied func()
	// OnOnline runs when reachability changes.
	OnOnline func(online bool)

	nudge chan struct{}

	mu           sync.Mutex
	lastActivity time.Time
	etag         string
	online       bool
	serverMin    time.Duration
}

func NewPoller(tree *Tree) *Poller {
	return &Poller{tree: tree, nudge: make(chan struct{}, 1), lastActivity: time.Now(), online: true}
}

// Nudge polls now and counts as activity.
func (p *Poller) Nudge() {
	p.mu.Lock()
	p.lastActivity = time.Now()
	p.mu.Unlock()
	select {
	case p.nudge <- struct{}{}:
	default:
	}
}

// Online reports whether the last poll reached the server.
func (p *Poller) Online() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.online
}

// interval picks the cadence for the time since the last activity.
func interval(idle time.Duration) time.Duration {
	switch {
	case idle < 2*time.Minute:
		return 5 * time.Second
	case idle < 30*time.Minute:
		return 30 * time.Second
	}
	return 120 * time.Second
}

func jitter(d time.Duration) time.Duration {
	return time.Duration(float64(d) * (0.8 + 0.4*rand.Float64()))
}

func (p *Poller) next() time.Duration {
	p.mu.Lock()
	d := max(interval(time.Since(p.lastActivity)), p.serverMin)
	p.mu.Unlock()
	if p.Floor != nil {
		d = max(d, p.Floor())
	}
	return jitter(d)
}

// Run polls until ctx ends.
func (p *Poller) Run(ctx context.Context) {
	t := time.NewTimer(0)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-p.nudge:
		}
		p.poll(ctx)
		if !t.Stop() {
			select {
			case <-t.C:
			default:
			}
		}
		t.Reset(p.next())
	}
}

func (p *Poller) poll(ctx context.Context) {
	c, err := p.tree.acct.Client()
	if err != nil {
		return // signed out or locked: nothing to poll
	}
	p.mu.Lock()
	etag, needCaps := p.etag, p.serverMin == 0
	p.mu.Unlock()
	if needCaps {
		if caps, err := c.Capabilities(ctx); err == nil && caps.PollMinSeconds > 0 {
			p.mu.Lock()
			p.serverMin = time.Duration(caps.PollMinSeconds) * time.Second
			p.mu.Unlock()
		}
	}
	cur, _ := p.tree.Cursor(ctx)
	seq, newETag, changedOnServer, err := c.Cursor(ctx, etag)
	if err == nil && (cur == nil || (changedOnServer && seq != *cur)) {
		var applied bool
		applied, err = p.tree.Sync(ctx)
		if err == nil && applied {
			p.mu.Lock()
			p.lastActivity = time.Now()
			p.mu.Unlock()
			if p.OnApplied != nil {
				p.OnApplied()
			}
		}
	}
	if err == nil {
		p.mu.Lock()
		p.etag = newETag
		p.mu.Unlock()
	}
	switch {
	case ctx.Err() != nil:
		return
	case err == nil, errors.Is(err, account.ErrLocked), errors.Is(err, account.ErrNotSignedIn):
		p.setOnline(true)
	case errors.Is(err, api.ErrOffline):
		p.setOnline(false)
	default:
		var apiErr *api.Error
		p.setOnline(errors.As(err, &apiErr) && apiErr.Status < 500)
		slog.Warn("remote poll failed", "err", err)
	}
}

func (p *Poller) setOnline(on bool) {
	p.mu.Lock()
	changed := p.online != on
	p.online = on
	p.mu.Unlock()
	if changed && p.OnOnline != nil {
		p.OnOnline(on)
	}
}
