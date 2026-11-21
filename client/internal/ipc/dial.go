package ipc

import (
	"bufio"
	"crypto/hmac"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"time"
)

// DialEngine connects to the engine at socket and, before the caller sends
// anything (a password), checks that it is the engine holding helloKey (from
// engine.json of the state dir): it must answer ipc.hello {nonce} with
// key_proof = HelloProof(helloKey, nonce). A program squatting the socket or
// pipe name cannot. Every CLI front end dials through here.
func DialEngine(socket, helloKey string) (net.Conn, *bufio.Reader, error) {
	if helloKey == "" {
		return nil, nil, fmt.Errorf("no engine key in engine.json: is the engine running (onegy daemon) with this --state-dir?")
	}
	c, err := Dial(socket)
	if err != nil {
		return nil, nil, err
	}
	b := make([]byte, 32)
	rand.Read(b)
	nonce := hex.EncodeToString(b)
	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 0, "method": "ipc.hello", "params": map[string]string{"nonce": nonce}})
	c.SetDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReaderSize(c, 1<<20)
	if _, err := c.Write(append(req, '\n')); err != nil {
		c.Close()
		return nil, nil, err
	}
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			c.Close()
			return nil, nil, fmt.Errorf("the sync engine closed the connection: %w", err)
		}
		var resp struct {
			ID     *int `json:"id"`
			Result struct {
				KeyProof string `json:"key_proof"`
			} `json:"result"`
		}
		if json.Unmarshal(line, &resp) != nil || resp.ID == nil || *resp.ID != 0 {
			continue // an event
		}
		if !hmac.Equal([]byte(resp.Result.KeyProof), []byte(HelloProof(helloKey, nonce))) {
			c.Close()
			return nil, nil, fmt.Errorf("the program at %s did not prove it is this user's sync engine (restart the engine if it was updated)", socket)
		}
		c.SetDeadline(time.Time{})
		return c, r, nil
	}
}
