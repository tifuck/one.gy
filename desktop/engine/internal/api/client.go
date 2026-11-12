// Package api is the HTTP client for the server sync API
// (desktop/docs/sync-api.md): typed requests and errors, device-token auth,
// and retry with jittered exponential backoff on 429/503/network errors.
package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxBackoff  = 10 * time.Minute
	maxErrBody  = 64 << 10
	maxJSONBody = 64 << 20

	// A request is given up (and retried like a lost connection) when no
	// byte moves for stallAfter, or the answer to a sent request takes
	// longer than that (slowAnswer for requests the server works on long).
	stallAfter = 2 * time.Minute
	slowAnswer = 30 * time.Minute
)

var errStalled = errors.New("the server stopped responding")

// Observer hears how the requests sent with its context are going (the
// engine shows it on the transfer they belong to).
type Observer struct {
	// Sent: sent of total bytes of a file-content body went out in this attempt.
	Sent func(sent, total int64)
	// Retry: the request failed (why) and is sent again after wait;
	// why "" = the wait is over.
	Retry func(why string, wait time.Duration)
}

type observerKey struct{}

// WithObserver attaches o to the requests made with the returned context.
func WithObserver(ctx context.Context, o *Observer) context.Context {
	return context.WithValue(ctx, observerKey{}, o)
}

// Error is a non-2xx answer from the server.
type Error struct {
	Status           int
	Code             string          // sync-api.md error code, e.g. "precondition_failed"
	Message          string          // server "error" text
	Field            string          // bad_request
	Current          json.RawMessage // conflict / precondition_failed: current node
	MinCursor        int64           // cursor_expired
	MinClientVersion string          // client_too_old
	AttemptsLeft     int             // invalid_pin
	RetryAfter       time.Duration
}

func (e *Error) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("server: %s (%d %s)", e.Message, e.Status, e.Code)
	}
	return fmt.Sprintf("server: HTTP %d %s", e.Status, e.Code)
}

// IsCode reports whether err is an *Error with the given code.
func IsCode(err error, code string) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}

// ErrNoToken means a device-auth route was called before authorization.
var ErrNoToken = errors.New("no device token")

// ErrOffline wraps transport failures (DNS, connect, TLS, reset).
var ErrOffline = errors.New("server unreachable")

// Options configures a Client.
type Options struct {
	Version     string // client version for X-Onegy-Client
	InsecureTLS bool   // only honoured in builds with -tags devtls
	ProxyURL    string // "" = system proxy; "direct" = none; else explicit URL
	MaxRetries  int    // retries after the first attempt; default 5

	Transport http.RoundTripper // tests only: replaces the TLS/proxy transport
}

// Client talks to one server. Safe for concurrent use.
type Client struct {
	base       *url.URL
	http       *http.Client
	userAgent  string
	maxRetries int
	stall      time.Duration // stallAfter; shorter in tests

	mu        sync.Mutex
	token     string
	signer    Signer
	grant     string
	onRevoked func()

	sleep func(context.Context, time.Duration) error // replaced in tests
}

// New validates the server URL (https only) and builds a client.
func New(server string, opt Options) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(server), "/"))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return nil, fmt.Errorf("server must be an https:// URL without a path")
	}
	u.Path = ""
	if opt.InsecureTLS && !DevTLS {
		return nil, fmt.Errorf("TLS verification can only be disabled in devtls builds")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: opt.InsecureTLS && DevTLS}
	switch opt.ProxyURL {
	case "":
		tr.Proxy = http.ProxyFromEnvironment
	case "direct":
		tr.Proxy = nil
	default:
		pu, err := url.Parse(opt.ProxyURL)
		if err != nil || pu.Host == "" || (pu.Scheme != "http" && pu.Scheme != "https" && pu.Scheme != "socks5") {
			return nil, fmt.Errorf("invalid proxy URL")
		}
		tr.Proxy = http.ProxyURL(pu)
	}
	retries := opt.MaxRetries
	if retries == 0 {
		retries = 5
	}
	var rt http.RoundTripper = tr
	if opt.Transport != nil {
		rt = opt.Transport
	}
	return &Client{
		base: u,
		// Never follow redirects: a redirected PUT/POST would otherwise end
		// in a 200 for some other page and look like success.
		http:       &http.Client{Transport: rt, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		userAgent:  fmt.Sprintf("onegy-desktop/%s (%s; %s)", opt.Version, runtime.GOOS, runtime.GOARCH),
		maxRetries: retries,
		stall:      stallAfter,
		sleep:      sleepCtx,
	}, nil
}

// Server returns the normalised server URL.
func (c *Client) Server() string { return c.base.String() }

// SetToken sets the device token ("dev_…") used for device-auth routes.
func (c *Client) SetToken(t string) {
	c.mu.Lock()
	c.token = t
	c.mu.Unlock()
}

func (c *Client) tokenValue() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.token
}

// Signer signs "<unix ts>\n<METHOD>\n<path>[?<query>]" (devkey.Key).
type Signer interface {
	Sign(msg []byte) ([]byte, error)
}

// SetSigner makes every device-auth request carry X-Onegy-Pop-Ts/-Sig.
func (c *Client) SetSigner(s Signer) {
	c.mu.Lock()
	c.signer = s
	c.mu.Unlock()
}

// SetGrant sets ("" clears) the unlock grant sent as X-Onegy-Grant.
func (c *Client) SetGrant(g string) {
	c.mu.Lock()
	c.grant = g
	c.mu.Unlock()
}

// Grant returns the current unlock grant ("" = app locked).
func (c *Client) Grant() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.grant
}

// CopyAuth gives other the same token, signer and grant (proxy changes).
func (c *Client) CopyAuth(other *Client) {
	c.mu.Lock()
	token, signer, grant := c.token, c.signer, c.grant
	c.mu.Unlock()
	other.mu.Lock()
	other.token, other.signer, other.grant = token, signer, grant
	other.mu.Unlock()
}

// OnRevoked registers a callback run (once per response) on 401 device_revoked.
func (c *Client) OnRevoked(fn func()) {
	c.mu.Lock()
	c.onRevoked = fn
	c.mu.Unlock()
}

// request describes one API call. body is replayed on every attempt.
type request struct {
	method      string
	path        string
	query       url.Values
	body        []byte
	contentType string
	header      http.Header
	noAuth      bool
	// idempotent requests are also retried after transport errors (the server
	// may have acted on a lost response); others only on 429/503.
	idempotent bool
	content    bool // the body is file content: an Observer hears Sent
	slow       bool // the server may take up to slowAnswer to answer
}

// do sends r with retries and returns the response with a 2xx/304 status
// (caller closes the body), or an error.
func (c *Client) do(ctx context.Context, r request) (*http.Response, error) {
	if !r.noAuth && c.tokenValue() == "" {
		return nil, ErrNoToken
	}
	obs, _ := ctx.Value(observerKey{}).(*Observer)
	for attempt := 0; ; attempt++ {
		resp, err := c.once(ctx, r, obs)
		var wait time.Duration
		var why string
		switch {
		case err != nil && ctx.Err() != nil:
			return nil, ctx.Err()
		case err != nil:
			if !r.idempotent || attempt >= c.maxRetries {
				return nil, fmt.Errorf("%w: %v", ErrOffline, err)
			}
			wait, why = backoff(attempt), "Connection problem"
			if errors.Is(err, errStalled) {
				why = "one.gy stopped responding"
			}
		case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable:
			apiErr := readError(resp)
			if attempt >= c.maxRetries {
				return nil, apiErr
			}
			wait, why = backoff(attempt), "one.gy is busy"
			if resp.StatusCode == http.StatusTooManyRequests {
				why = "one.gy is limiting requests"
			}
			if apiErr.RetryAfter > 0 {
				wait = min(apiErr.RetryAfter, maxBackoff)
			}
		case resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotModified:
			apiErr := readError(resp)
			if apiErr.Code == "device_revoked" {
				c.mu.Lock()
				fn := c.onRevoked
				c.mu.Unlock()
				if fn != nil {
					fn()
				}
			}
			return nil, apiErr
		default:
			return resp, nil
		}
		if obs != nil && obs.Retry != nil {
			obs.Retry(why, wait)
		}
		if err := c.sleep(ctx, wait); err != nil {
			return nil, err
		}
		if obs != nil && obs.Retry != nil {
			obs.Retry("", 0)
		}
	}
}

// sendBody is a request body that keeps the stall watchdog fed while bytes
// leave and reports them: the watchdog runs while the transport writes what
// was read (stall), and for the answer once everything is out.
type sendBody struct {
	r           *bytes.Reader
	total       int64
	dog         *time.Timer
	stall, wait time.Duration
	sent        func(sent, total int64)
}

func (b *sendBody) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	left := int64(b.r.Len())
	if b.sent != nil && n > 0 {
		b.sent(b.total-left, b.total)
	}
	if left == 0 {
		b.dog.Reset(b.wait)
	} else {
		b.dog.Reset(b.stall)
	}
	return n, err
}

func (b *sendBody) Close() error { return nil }

// recvBody is a response body whose reads are watched for stalls (only while
// a read is waiting: the reader may pause between reads).
type recvBody struct {
	io.ReadCloser
	dog   *time.Timer
	stall time.Duration
	done  context.CancelCauseFunc
}

func (b *recvBody) Read(p []byte) (int, error) {
	b.dog.Reset(b.stall)
	n, err := b.ReadCloser.Read(p)
	b.dog.Stop()
	return n, err
}

func (b *recvBody) Close() error {
	b.dog.Stop()
	b.done(nil)
	return b.ReadCloser.Close()
}

func (c *Client) once(parent context.Context, r request, obs *Observer) (*http.Response, error) {
	u := *c.base
	u.Path = r.path
	u.RawQuery = r.query.Encode()
	ctx, cancel := context.WithCancelCause(parent)
	wait := c.stall
	if r.slow {
		wait = max(slowAnswer, c.stall)
	}
	first := wait
	if len(r.body) > 0 {
		first = c.stall
	}
	dog := time.AfterFunc(first, func() { cancel(errStalled) })
	fail := func(err error) (*http.Response, error) {
		dog.Stop()
		if context.Cause(ctx) == errStalled && parent.Err() == nil {
			err = errStalled
		}
		cancel(nil)
		return nil, err
	}
	var body io.Reader
	if r.body != nil {
		body = bytes.NewReader(r.body)
	}
	req, err := http.NewRequestWithContext(ctx, r.method, u.String(), body)
	if err != nil {
		return fail(err)
	}
	if len(r.body) > 0 {
		// ContentLength stays as NewRequest set it; GetBody too, so a request
		// replayed by the transport is watched and reported like the first.
		get := func() (io.ReadCloser, error) {
			b := &sendBody{r: bytes.NewReader(r.body), total: int64(len(r.body)), dog: dog, stall: c.stall, wait: wait}
			if r.content && obs != nil && obs.Sent != nil {
				b.sent = obs.Sent
				b.sent(0, b.total)
			}
			return b, nil
		}
		req.Body, _ = get()
		req.GetBody = get
	}
	for k, v := range r.header {
		req.Header[k] = v
	}
	req.Header.Set("X-Onegy-Client", c.userAgent)
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept", "application/json")
	if r.contentType != "" {
		req.Header.Set("Content-Type", r.contentType)
	}
	if !r.noAuth {
		c.mu.Lock()
		token, signer, grant := c.token, c.signer, c.grant
		c.mu.Unlock()
		req.Header.Set("Authorization", "Bearer "+token)
		if grant != "" {
			req.Header.Set("X-Onegy-Grant", grant)
		}
		if signer != nil {
			ts := strconv.FormatInt(time.Now().Unix(), 10)
			path := u.Path
			if u.RawQuery != "" {
				path += "?" + u.RawQuery
			}
			sig, err := signer.Sign([]byte(ts + "\n" + r.method + "\n" + path))
			if err != nil {
				return fail(fmt.Errorf("sign request: %w", err))
			}
			req.Header.Set("X-Onegy-Pop-Ts", ts)
			req.Header.Set("X-Onegy-Pop-Sig", base64.StdEncoding.EncodeToString(sig))
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fail(err)
	}
	dog.Stop()
	resp.Body = &recvBody{ReadCloser: resp.Body, dog: dog, stall: c.stall, done: cancel}
	return resp, nil
}

func readError(resp *http.Response) *Error {
	defer resp.Body.Close()
	e := &Error{Status: resp.StatusCode}
	if s := resp.Header.Get("Retry-After"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n >= 0 {
			e.RetryAfter = time.Duration(n) * time.Second
		} else if t, err := http.ParseTime(s); err == nil {
			e.RetryAfter = time.Until(t)
		}
	}
	var body struct {
		Error            string          `json:"error"`
		Code             string          `json:"code"`
		Field            string          `json:"field"`
		Current          json.RawMessage `json:"current"`
		MinCursor        int64           `json:"min_cursor"`
		MinClientVersion string          `json:"min_client_version"`
		AttemptsLeft     int             `json:"attempts_left"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrBody))
	if json.Unmarshal(raw, &body) == nil {
		e.Message, e.Code, e.Field, e.Current = body.Error, body.Code, body.Field, body.Current
		e.MinCursor, e.MinClientVersion, e.AttemptsLeft = body.MinCursor, body.MinClientVersion, body.AttemptsLeft
	}
	if e.Code == "" {
		e.Code = fmt.Sprintf("http_%d", resp.StatusCode)
	}
	return e
}

// backoff is 1 s · 2^attempt, capped at 10 min, with ±20% jitter.
func backoff(attempt int) time.Duration {
	d := maxBackoff
	if attempt < 10 {
		d = min(time.Second<<attempt, maxBackoff)
	}
	return time.Duration(float64(d) * (0.8 + 0.4*rand.Float64()))
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// jsonCall sends an optional JSON body and decodes a JSON answer into out.
func (c *Client) jsonCall(ctx context.Context, r request, in, out any) (int, error) {
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return 0, err
		}
		r.body, r.contentType = b, "application/json"
	}
	resp, err := c.do(ctx, r)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotModified {
		if err := json.NewDecoder(io.LimitReader(resp.Body, maxJSONBody)).Decode(out); err != nil {
			return resp.StatusCode, fmt.Errorf("bad response from %s: %w", r.path, err)
		}
	}
	return resp.StatusCode, nil
}
