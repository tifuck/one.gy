// Command onegyctl is a developer CLI for the engine's JSON-RPC interface:
//
//	onegyctl [--socket p | --state-dir d] call <method> [json params]
//	onegyctl [--socket p | --state-dir d] watch
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/tifuck/one.gy/desktop/engine/internal/config"
	"github.com/tifuck/one.gy/desktop/engine/internal/ipc"
)

func main() {
	socket := flag.String("socket", "", "engine socket or pipe (default: per-OS location)")
	stateDir := flag.String("state-dir", "", "engine state dir, used to find the default socket")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: onegyctl [--socket p] call <method> [json] | watch")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *socket == "" {
		if *stateDir == "" {
			d, err := config.DefaultStateDir()
			if err != nil {
				fail(err)
			}
			*stateDir = d
		}
		*socket = config.DefaultSocket(*stateDir)
	}
	args := flag.Args()
	switch {
	case len(args) >= 2 && args[0] == "call" && len(args) <= 3:
		params := "null"
		if len(args) == 3 {
			params = args[2]
		}
		os.Exit(call(*socket, args[1], params))
	case len(args) == 1 && args[0] == "watch":
		watch(*socket)
	default:
		flag.Usage()
		os.Exit(2)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "onegyctl:", err)
	os.Exit(1)
}

func send(socket, method, params string, id int) (*bufio.Reader, func()) {
	if !json.Valid([]byte(params)) {
		fail(fmt.Errorf("params are not valid JSON"))
	}
	c, err := ipc.Dial(socket)
	if err != nil {
		fail(err)
	}
	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": json.RawMessage(params)})
	if _, err := c.Write(append(req, '\n')); err != nil {
		fail(err)
	}
	return bufio.NewReaderSize(c, 1<<20), func() { c.Close() }
}

// call prints the result (exit 0) or the error (exit 1) as indented JSON.
func call(socket, method, params string) int {
	r, done := send(socket, method, params, 1)
	defer done()
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			fail(err)
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

// watch subscribes and prints one event per line until the engine goes away.
func watch(socket string) {
	r, done := send(socket, "engine.subscribe", "null", 1)
	defer done()
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			fail(err)
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
