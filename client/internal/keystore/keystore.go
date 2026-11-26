// Package keystore holds the engine's secrets (master key, device token) in
// the OS key store (Windows Credential Manager, Linux Secret Service) via
// go-keyring, with a memory copy. When the key store is unavailable or
// memory-only mode is on, secrets live in memory only. Only a store switched
// to a secrets file (UseFile, `onegy daemon --secrets-file` on computers
// without a key store, e.g. a server) writes them to disk, in a 0600 file.
package keystore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
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
	file       string // set: the secrets file replaces the OS key store
}

// New returns a store whose key-store entries are namespaced by the state dir,
// so engines with different --state-dir values never share secrets.
func New(stateDir string, memoryOnly bool) *Store {
	sum := sha256.Sum256([]byte(stateDir))
	return &Store{prefix: hex.EncodeToString(sum[:6]) + ":", mem: map[string]string{}, memoryOnly: memoryOnly}
}

// UseFile keeps the persisted copies in path (mode 0600) instead of the OS
// key store.
func (s *Store) UseFile(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.file = path
}

// SetMemoryOnly switches modes. Turning it on removes the key-store copies.
func (s *Store) SetMemoryOnly(on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.memoryOnly = on
	if on {
		for name := range s.mem {
			if err := s.remove(name); err != nil {
				slog.Error("keystore: could not remove the stored copy", "name", name, "err", err)
			}
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
	v, err := s.load(name)
	if err != nil {
		return "", err
	}
	s.mem[name] = v
	return v, nil
}

// Set keeps value in memory and, unless memory-only, in the OS key store
// (or the secrets file). An error means only the memory copy holds it.
func (s *Store) Set(name, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mem[name] = value
	if s.memoryOnly {
		return nil
	}
	return s.save(name, value)
}

// Delete removes the memory and key-store copies. An error means a stored
// copy may be left (the caller reports it).
func (s *Store) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.mem, name)
	return s.remove(name)
}

func (s *Store) load(name string) (string, error) {
	if s.file == "" {
		v, err := keyring.Get(service, s.prefix+name)
		if errors.Is(err, keyring.ErrNotFound) {
			return "", ErrNotFound
		}
		return v, err
	}
	all, err := s.readFile()
	if err != nil {
		return "", err
	}
	v, ok := all[name]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

func (s *Store) save(name, value string) error {
	if s.file == "" {
		return keyring.Set(service, s.prefix+name, value)
	}
	all, err := s.readFile()
	if err != nil {
		return err
	}
	all[name] = value
	return s.writeFile(all)
}

func (s *Store) remove(name string) error {
	if s.file == "" {
		if err := keyring.Delete(service, s.prefix+name); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return err
		}
		return nil
	}
	all, err := s.readFile()
	var se *json.SyntaxError
	var te *json.UnmarshalTypeError
	if errors.As(err, &se) || errors.As(err, &te) {
		// AUDIT FIX (F6): a corrupt file cannot be edited; it holds only
		// secrets, so drop it rather than leave the token and keys behind.
		if err := os.Remove(s.file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err != nil {
		return err
	}
	if _, ok := all[name]; !ok {
		return nil
	}
	delete(all, name)
	return s.writeFile(all)
}

func (s *Store) readFile() (map[string]string, error) {
	all := map[string]string{}
	b, err := os.ReadFile(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return all, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &all); err != nil {
		// Never overwritten: it may still hold the only stored copy of the
		// secrets. Delete (sign-out) drops it.
		return nil, fmt.Errorf("the secrets file %s is corrupt; move it away and unlock with your password: %w", s.file, err)
	}
	return all, nil
}

// writeFile replaces the secrets file atomically, created 0600 from the start.
func (s *Store) writeFile(all map[string]string) error {
	b, _ := json.Marshal(all)
	tmp, err := os.CreateTemp(filepath.Dir(s.file), "."+filepath.Base(s.file)+".tmp*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.file)
}
