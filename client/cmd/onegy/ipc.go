package main

// `onegy ipc` is a developer tool for the engine's JSON-RPC interface:
//
//	onegy ipc [--socket p | --state-dir d] call <method> [json params]
//	onegy ipc [--socket p | --state-dir d] watch

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/tifuck/one.gy/client/internal/config"
	"github.com/tifuck/one.gy/client/internal/ipc"
)

func runIPC(args []string) int {
	fs := flag.NewFlagSet("onegy ipc", flag.ExitOnError)
	socket := fs.String("socket", "", "engine socket or pipe (default: per-OS location)")
	stateDir := fs.String("state-dir", "", "engine state dir, used to find the default socket")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: onegy ipc [--socket p] call <method> [json] | watch")
		fs.PrintDefaults()
	}
	fs.Parse(args)
	if *socket == "" {
		if *stateDir == "" {
			d, err := config.DefaultStateDir()
			if err != nil {
				ipcFail(err)
			}
			*stateDir = d
		}
		*socket = config.DefaultSocket(*stateDir)
	}
	rest := fs.Args()
	switch {
	case len(rest) >= 2 && rest[0] == "call" && len(rest) <= 3:
		params := "null"
		if len(rest) == 3 {
			params = rest[2]
		}
		return ipcCall(*socket, rest[1], params)
	case len(rest) == 1 && rest[0] == "watch":
		ipcWatch(*socket)
		return 0
	default:
		fs.Usage()
		return 2
	}
}

func ipcFail(err error) {
	fmt.Fprintln(os.Stderr, "onegy ipc:", err)
	os.Exit(1)
}

func ipcSend(socket, method, params string, id int) (*bufio.Reader, func()) {
	if !json.Valid([]byte(params)) {
		ipcFail(fmt.Errorf("params are not valid JSON"))
	}
	c, err := ipc.Dial(socket)
	if err != nil {
		ipcFail(err)
	}
	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": json.RawMessage(params)})
	if _, err := c.Write(append(req, '\n')); err != nil {
		ipcFail(err)
	}
	return bufio.NewReaderSize(c, 1<<20), func() { c.Close() }
}

// ipcCall prints the result (exit 0) or the error (exit 1) as indented JSON.
func ipcCall(socket, method, params string) int {
	r, done := ipcSend(socket, method, params, 1)
	defer done()
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			ipcFail(err)
		}
		var resp struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(line, &resp) != nil || resp.ID == nil {
			continue // an event
		}
		var out bytes.Buffer
		if resp.Error != nil {
			json.Indent(&out, resp.Error, "", "  ")
			fmt.Fprintln(os.Stderr, out.String())
			return 1
		}
		json.Indent(&out, resp.Result, "", "  ")
		fmt.Println(out.String())
		return 0
	}
}

// ipcWatch subscribes and prints one event per line until the engine goes away.
func ipcWatch(socket string) {
	r, done := ipcSend(socket, "engine.subscribe", "null", 1)
	defer done()
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			ipcFail(err)
		}
		var msg struct {
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(line, &msg) == nil && msg.Method == "event" {
			fmt.Println(string(msg.Params))
		}
	}
}
