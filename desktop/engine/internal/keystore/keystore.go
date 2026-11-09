// Package keystore holds the engine's secrets (master key, device token) in
// the OS key store (Windows Credential Manager, Linux Secret Service) via
// go-keyring, with a memory copy. When the key store is unavailable or
// memory-only mode is on, secrets live in memory only. Nothing here ever
// writes a secret to disk.
package keystore

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"

	"github.com/zalando/go-keyring"
)

const service = "ONE.GY Desktop"

// ErrNotFound means no secret is stored under the name.
var ErrNotFound = errors.New("secret not found")

// Store is safe for concurrent use.
type Store struct {
	mu         sync.Mutex
	prefix     string
	mem        map[string]string
	memoryOnly bool
}

// New returns a store whose key-store entries are namespaced by the state dir,
// so engines with different --state-dir values never share secrets.
func New(stateDir string, memoryOnly bool) *Store {
	sum := sha256.Sum256([]byte(stateDir))
	return &Store{prefix: hex.EncodeToString(sum[:6]) + ":", mem: map[string]string{}, memoryOnly: memoryOnly}
}

// SetMemoryOnly switches modes. Turning it on removes the key-store copies.
func (s *Store) SetMemoryOnly(on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.memoryOnly = on
	if on {
		for name := range s.mem {
			keyring.Delete(service, s.prefix+name)
		}
	}
}

// Get returns the memory copy, else the key-store copy (unless memory-only).
func (s *Store) Get(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.mem[name]; ok {
		return v, nil
	}
	if s.memoryOnly {
		return "", ErrNotFound
	}
	v, err := keyring.Get(service, s.prefix+name)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	s.mem[name] = v
	return v, nil
}

// Set keeps value in memory and, unless memory-only, in the OS key store.
// persisted reports whether the key-store write happened.
func (s *Store) Set(name, value string) (persisted bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mem[name] = value
	if s.memoryOnly {
		return false
	}
	return keyring.Set(service, s.prefix+name, value) == nil
}

// Delete removes the memory and key-store copies.
func (s *Store) Delete(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.mem, name)
	keyring.Delete(service, s.prefix+name)
}
