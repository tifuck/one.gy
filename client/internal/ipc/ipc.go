// Package ipc is the engine's JSON-RPC 2.0 server (desktop/docs/engine-ipc.md):
// newline-delimited frames over a private Unix socket or named pipe, a method
// registry, and event broadcast to subscribed connections.
package ipc

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"sync"
)

const (
	maxFrame   = 16 << 20
	eventQueue = 256

	CodeParse          = -32700
	CodeInvalidRequest = -32600
	CodeNoMethod       = -32601
	CodeInvalidParams  = -32602
	CodeInternal       = -32603
	CodeApp            = -32000 // every application error; data.code says which
)

// Error is a JSON-RPC error. Data.Code is the contract's string code.
type Error struct {
	Code    int       `json:"code"`
	Message string    `json:"message"`
	Data    ErrorData `json:"data"`
}

type ErrorData struct {
	Code   string `json:"code"`
	Errors any    `json:"errors,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// Errorf builds an application error with a contract string code.
func Errorf(code, message string) *Error {
	return &Error{Code: CodeApp, Message: message, Data: ErrorData{Code: code}}
}

// Handler serves one method. Returned errors that are not *Error become
// {code: internal}.
type Handler func(ctx context.Context, params json.RawMessage) (any, error)

// Server dispatches requests to registered handlers.
type Server struct {
	methods map[string]Handler

	// OnSubscribe, when set, gives the event sent to a connection right
	// after its engine.subscribe reply (engine-ipc.md: one status event).
	OnSubscribe func() (typ string, data any)

	// Secret, when set (--ipc-secret-stdin), must be presented with ipc.hello
	// before a connection may call anything but ipc.hello, engine.info and
	// engine.shutdown: only the app that spawned the engine knows it, so other
	// programs of the same user cannot ask for keys or website tickets.
	Secret string

	mu    sync.Mutex
	conns map[*conn]bool
	ln    net.Listener
	wg    sync.WaitGroup
}

func NewServer() *Server {
	return &Server{methods: map[string]Handler{}, conns: map[*conn]bool{}}
}

// HelloProof is the engine's answer to ipc.hello {nonce}: hex
// HMAC-SHA256(secret, "onegy-engine-hello:" + nonce).
func HelloProof(secret, nonce string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("onegy-engine-hello:" + nonce))
	return hex.EncodeToString(m.Sum(nil))
}

// Handle registers a method (before Serve).
func (s *Server) Handle(method string, h Handler) { s.methods[method] = h }

type conn struct {
	nc         net.Conn
	out        chan []byte
	subscribed bool // guarded by Server.mu
	trusted    bool // guarded by Server.mu: presented Secret
	done       chan struct{}
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

// Serve accepts connections until ctx ends or the listener closes.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()
	go func() { <-ctx.Done(); ln.Close() }()
	for {
		nc, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		if err := checkPeer(nc); err != nil {
			slog.Warn("ipc: rejected connection", "err", err)
			nc.Close()
			continue
		}
		c := &conn{nc: nc, out: make(chan []byte, eventQueue), done: make(chan struct{})}
		s.mu.Lock()
		s.conns[c] = true
		s.mu.Unlock()
		s.wg.Add(1)
		go s.serveConn(ctx, c)
	}
}

// Close closes the listener and every connection, then waits for them.
func (s *Server) Close() {
	s.mu.Lock()
	if s.ln != nil {
		s.ln.Close()
	}
	for c := range s.conns {
		c.nc.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *Server) serveConn(ctx context.Context, c *conn) {
	defer s.wg.Done()
	go func() {
		for {
			select {
			case b := <-c.out:
				if _, err := c.nc.Write(b); err != nil {
					c.nc.Close()
					return
				}
			case <-c.done:
				return
			}
		}
	}()
	var calls sync.WaitGroup
	sc := bufio.NewScanner(c.nc)
	sc.Buffer(make([]byte, 64<<10), maxFrame)
	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		if len(line) == 0 {
			continue
		}
		calls.Add(1)
		go func() {
			defer calls.Done()
			b, after := s.dispatch(ctx, c, line)
			for _, f := range [][]byte{b, after} {
				if f == nil {
					continue
				}
				select {
				case c.out <- f:
				case <-c.done:
				}
			}
		}()
	}
	c.nc.Close()
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
	close(c.done)
	calls.Wait()
}

// dispatch handles one frame and returns the encoded response (nil for
// notifications) and an event frame to send right after it (or nil).
func (s *Server) dispatch(ctx context.Context, c *conn, line []byte) (resp, after []byte) {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		return encode(response{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &Error{Code: CodeParse, Message: "parse error", Data: ErrorData{Code: "validation_failed"}}}), nil
	}
	if req.JSONRPC != "2.0" || req.Method == "" {
		return encode(response{JSONRPC: "2.0", ID: idOrNull(req.ID), Error: &Error{Code: CodeInvalidRequest, Message: "invalid request", Data: ErrorData{Code: "validation_failed"}}}), nil
	}
	var result any
	var err error
	s.mu.Lock()
	trusted := c.trusted || s.Secret == ""
	s.mu.Unlock()
	if req.Method == "ipc.hello" {
		var in struct {
			Secret string `json:"secret"`
			Nonce  string `json:"nonce"`
		}
		if err = Params(req.Params, &in); err == nil {
			if in.Secret == "" && in.Nonce != "" {
				// The engine proves it holds the secret before the app sends
				// it (or a password): a program squatting the pipe cannot.
				res := map[string]string{}
				if s.Secret != "" {
					res["proof"] = HelloProof(s.Secret, in.Nonce)
				}
				result = res
			} else if s.Secret == "" || subtle.ConstantTimeCompare([]byte(in.Secret), []byte(s.Secret)) == 1 {
				s.mu.Lock()
				c.trusted = true
				s.mu.Unlock()
				result = struct{}{}
			} else {
				err = Errorf("forbidden", "wrong IPC secret")
			}
		}
	} else if !trusted && req.Method != "engine.info" && req.Method != "engine.shutdown" {
		err = Errorf("forbidden", "call ipc.hello first")
	} else if req.Method == "engine.subscribe" {
		s.mu.Lock()
		c.subscribed = true
		s.mu.Unlock()
		result = struct{}{}
		if s.OnSubscribe != nil {
			typ, data := s.OnSubscribe()
			after = encode(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": typ, "data": data}})
		}
	} else if h, ok := s.methods[req.Method]; !ok {
		err = &Error{Code: CodeNoMethod, Message: "unknown method " + req.Method, Data: ErrorData{Code: "not_found"}}
	} else {
		result, err = s.call(ctx, h, req)
	}
	if req.ID == nil {
		return nil, after
	}
	r := response{JSONRPC: "2.0", ID: req.ID, Result: result}
	if err != nil {
		var rpcErr *Error
		if !errors.As(err, &rpcErr) {
			slog.Error("ipc: method failed", "method", req.Method, "err", err)
			rpcErr = Errorf("internal", err.Error())
		}
		r.Result, r.Error = nil, rpcErr
	} else if result == nil {
		r.Result = struct{}{}
	}
	return encode(r), after
}

func (s *Server) call(ctx context.Context, h Handler, req request) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("ipc: handler panic", "method", req.Method, "panic", r)
			err = Errorf("internal", "internal error")
		}
	}()
	return h(ctx, req.Params)
}

func idOrNull(id json.RawMessage) json.RawMessage {
	if id == nil {
		return json.RawMessage("null")
	}
	return id
}

func encode(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		b, _ = json.Marshal(response{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: Errorf("internal", "unencodable result")})
	}
	return append(b, '\n')
}

// Broadcast sends an event to every subscribed connection. A connection whose
// queue is full misses the event (the app re-reads state on reconnect).
func (s *Server) Broadcast(typ string, data any) {
	b := encode(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": typ, "data": data}})
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		if !c.subscribed {
			continue
		}
		select {
		case c.out <- b:
		default:
			slog.Warn("ipc: event queue full, event dropped", "type", typ)
		}
	}
}

// Params decodes params strictly into v; null/absent params leave v as is.
func Params(raw json.RawMessage, v any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return &Error{Code: CodeInvalidParams, Message: "invalid params: " + err.Error(), Data: ErrorData{Code: "validation_failed"}}
	}
	return nil
}
