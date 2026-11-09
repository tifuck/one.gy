// Package account owns the device's sign-in state (plan 5.2-5.3): device
// authorization with the split-key password derivation, master-key unwrap,
// secret storage (OS key store plus a copy sealed under the password-derived
// wrapping key, for memory-only mode), unlock, sign-out and revocation.
package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/tifuck/one.gy/desktop/engine/internal/api"
	"github.com/tifuck/one.gy/desktop/engine/internal/keystore"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
	"onegy/e2ee"
)

var (
	ErrNotSignedIn     = errors.New("this computer is not signed in")
	ErrLocked          = errors.New("enter your password to unlock this computer's keys")
	ErrAlreadySignedIn = errors.New("already signed in; sign out first")
	ErrWrongPassword   = errors.New("wrong password (if you changed it on the website, sign out and sign in again)")
)

const secretsName = "secrets"

// secrets is what the key store holds and what is sealed in the state DB.
type secrets struct {
	DeviceToken string `json:"device_token"`
	MasterKey   string `json:"master_key"`
}

// Status is the account.status IPC result.
type Status struct {
	SignedIn     bool   `json:"signed_in"`
	Locked       bool   `json:"locked"`
	Server       string `json:"server"`
	Username     string `json:"username"`
	DeviceID     string `json:"device_id"`
	DeviceName   string `json:"device_name"`
	StorageUsed  int64  `json:"storage_used"`
	StorageLimit int64  `json:"storage_limit"`
	Versioning   bool   `json:"versioning"` // one.gy keeps previous versions on replace
}

// Manager is safe for concurrent use. Network calls run without the lock.
type Manager struct {
	db   *state.DB
	ks   *keystore.Store
	opts api.Options

	mu        sync.Mutex
	acct      *state.Account
	client    *api.Client
	masterKey []byte
	token     string
	me        *api.Me
	meAt      time.Time

	// OnChange runs (in its own goroutine) after sign-in state changes;
	// OnRevoked after the server reported device_revoked.
	OnChange  func()
	OnRevoked func()
}

func New(db *state.DB, ks *keystore.Store, opts api.Options) *Manager {
	return &Manager{db: db, ks: ks, opts: opts}
}

// Load restores the account at engine start: unlocked when the key store
// still has the secrets, locked otherwise.
func (m *Manager) Load(ctx context.Context) error {
	a, err := m.db.GetAccount(ctx)
	if err != nil || a == nil || !a.SignedIn {
		m.mu.Lock()
		m.acct = a
		m.mu.Unlock()
		return err
	}
	client, err := m.newClient(a.ServerURL)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.acct, m.client = a, client
	if raw, err := m.ks.Get(secretsName); err == nil {
		var s secrets
		if json.Unmarshal([]byte(raw), &s) == nil {
			m.applySecretsLocked(s)
		}
	} else if !errors.Is(err, keystore.ErrNotFound) {
		slog.Warn("key store unavailable, starting locked", "err", err)
	}
	return nil
}

func (m *Manager) newClient(server string) (*api.Client, error) {
	c, err := api.New(server, m.opts)
	if err != nil {
		return nil, err
	}
	c.OnRevoked(m.revoked)
	return c, nil
}

// applySecretsLocked installs secrets whose master key matches key_check.
func (m *Manager) applySecretsLocked(s secrets) bool {
	key, err := e2ee.DecodeBase64(s.MasterKey)
	if err != nil || len(key) != e2ee.KeySize || keyCheck(key) != m.acct.KeyCheck || s.DeviceToken == "" {
		return false
	}
	m.masterKey, m.token = key, s.DeviceToken
	m.client.SetToken(s.DeviceToken)
	return true
}

func keyCheck(key []byte) string {
	sum := sha256.Sum256(key)
	return hex.EncodeToString(sum[:])
}

// AuthorizeParams are the account.authorize IPC params.
type AuthorizeParams struct {
	Server     string `json:"server"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	TOTPCode   string `json:"totp_code"`
	DeviceName string `json:"device_name"`
}

// Authorize runs the device flow of plan 5.2 and stores the secrets.
func (m *Manager) Authorize(ctx context.Context, p AuthorizeParams) error {
	m.mu.Lock()
	signedIn := m.acct != nil && m.acct.SignedIn
	m.mu.Unlock()
	if signedIn {
		return ErrAlreadySignedIn
	}
	p.Username, p.DeviceName = strings.TrimSpace(p.Username), strings.TrimSpace(p.DeviceName)
	if p.Username == "" || p.Password == "" || p.DeviceName == "" || utf8.RuneCountInString(p.DeviceName) > 80 {
		return &FieldError{Message: "username, password and a device name (at most 80 characters) are required"}
	}
	client, err := m.newClient(p.Server)
	if err != nil {
		return &FieldError{Message: err.Error()}
	}
	pre, err := client.PreLogin(ctx, p.Username)
	if err != nil {
		return err
	}
	if pre.SplitKeyVersion < 1 {
		return fmt.Errorf("this account uses an old sign-in format; sign in on the website once, then try again")
	}
	authToken, wrappingKey, err := e2ee.DeriveAuthAndWrappingKeys(p.Password, pre.AuthTokenSalt)
	if err != nil {
		return err
	}
	defer clear(wrappingKey)
	auth, err := client.Authorize(ctx, api.AuthorizeRequest{
		Username: p.Username, AuthToken: authToken, TOTPCode: strings.TrimSpace(p.TOTPCode),
		DeviceName: p.DeviceName, Platform: runtime.GOOS, ClientVersion: m.opts.Version,
	})
	if err != nil {
		return err
	}
	client.SetToken(auth.DeviceToken)
	masterKey, err := m.fetchMasterKey(ctx, client, wrappingKey)
	if err != nil {
		// Do not leave a half-authorized device behind on the account.
		if derr := client.DeleteDevice(context.WithoutCancel(ctx)); derr != nil {
			slog.Warn("could not remove the half-authorized device", "err", derr)
		}
		return err
	}
	s := secrets{DeviceToken: auth.DeviceToken, MasterKey: e2ee.EncodeBase64(masterKey)}
	plainJSON, _ := json.Marshal(s)
	plain := string(plainJSON)
	sealed, nonce, err := e2ee.EncryptName(plain, wrappingKey) // AES-256-GCM, random nonce
	if err != nil {
		return err
	}
	a := &state.Account{
		ServerURL: client.Server(), UserID: auth.User.ID, Username: auth.User.Username, DeviceID: auth.DeviceID,
		DeviceName: p.DeviceName, SignedIn: true, KeyCheck: keyCheck(masterKey), AuthSalt: pre.AuthTokenSalt,
		SealedSecrets: e2ee.EncodeBase64(sealed), SealedNonce: e2ee.EncodeBase64(nonce),
	}
	if a.Username == "" {
		a.Username = p.Username
	}
	if err := m.db.PutAccount(ctx, a); err != nil {
		return err
	}
	persisted := m.ks.Set(secretsName, plain)
	slog.Info("device authorized", "device_id", a.DeviceID, "key_store", persisted)
	m.mu.Lock()
	m.acct, m.client, m.masterKey, m.token, m.me = a, client, masterKey, auth.DeviceToken, nil
	m.mu.Unlock()
	m.changed()
	return nil
}

func (m *Manager) fetchMasterKey(ctx context.Context, client *api.Client, wrappingKey []byte) ([]byte, error) {
	keys, err := client.Keys(ctx)
	if err != nil {
		return nil, err
	}
	if !keys.HasE2EEKeys {
		return nil, fmt.Errorf("this account has no encryption keys yet; sign in on the website once, then try again")
	}
	key, err := e2ee.UnwrapKeyB64(keys.EncryptedMasterKey, keys.MasterKeyNonce, wrappingKey)
	if err != nil {
		return nil, fmt.Errorf("could not unlock the account's master key: %w", err)
	}
	return key, nil
}

// Unlock opens the sealed secrets with the account password (memory-only
// mode, or after the key store lost them). Works offline.
func (m *Manager) Unlock(ctx context.Context, password string) error {
	m.mu.Lock()
	a := m.acct
	m.mu.Unlock()
	if a == nil || !a.SignedIn {
		return ErrNotSignedIn
	}
	_, wrappingKey, err := e2ee.DeriveAuthAndWrappingKeys(password, a.AuthSalt)
	if err != nil {
		return err
	}
	defer clear(wrappingKey)
	plain, err := e2ee.DecryptName(a.SealedSecrets, a.SealedNonce, wrappingKey)
	if err != nil {
		return ErrWrongPassword
	}
	var s secrets
	if err := json.Unmarshal([]byte(plain), &s); err != nil {
		return fmt.Errorf("sealed secrets are corrupt: %w", err)
	}
	m.mu.Lock()
	ok := m.applySecretsLocked(s)
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("sealed secrets do not match this account; sign out and sign in again")
	}
	m.ks.Set(secretsName, plain)
	m.changed()
	return nil
}

// SignOut wipes the keys and the device identity (keeps synced files). With
// revoke the server-side device is deleted first; failing that (offline) the
// local sign-out still happens and the error is returned.
func (m *Manager) SignOut(ctx context.Context, revoke bool) error {
	m.mu.Lock()
	client := m.client
	unlocked := m.masterKey != nil
	m.mu.Unlock()
	var revokeErr error
	if revoke && client != nil && !unlocked {
		revokeErr = fmt.Errorf("signed out on this computer, but the device could not be removed from your account while locked; remove it under Devices on the website")
	}
	if revoke && client != nil && unlocked {
		if err := client.DeleteDevice(ctx); err != nil && !api.IsCode(err, "invalid_token") && !api.IsCode(err, "device_revoked") {
			revokeErr = err
		}
	}
	if err := m.wipe(ctx); err != nil {
		return err
	}
	m.changed()
	return revokeErr
}

func (m *Manager) wipe(ctx context.Context) error {
	m.ks.Delete(secretsName)
	m.mu.Lock()
	clear(m.masterKey)
	m.masterKey, m.token, m.client, m.me = nil, "", nil, nil
	if m.acct != nil {
		m.acct.SignedIn = false
	}
	m.mu.Unlock()
	return m.db.SignOutAccount(ctx)
}

// revoked handles 401 device_revoked from any API call.
func (m *Manager) revoked() {
	m.mu.Lock()
	signedIn := m.acct != nil && m.acct.SignedIn
	m.mu.Unlock()
	if !signedIn {
		return
	}
	slog.Warn("device was revoked on the server; keys wiped")
	if err := m.wipe(context.Background()); err != nil {
		slog.Error("wipe after revoke failed", "err", err)
	}
	if m.OnRevoked != nil {
		go m.OnRevoked()
	}
	m.changed()
}

func (m *Manager) changed() {
	if m.OnChange != nil {
		go m.OnChange()
	}
}

// Status returns account.status; storage numbers are refreshed at most once
// a minute and kept when the server is unreachable.
func (m *Manager) Status(ctx context.Context) Status {
	m.mu.Lock()
	a, client, unlocked, me, meAt := m.acct, m.client, m.masterKey != nil, m.me, m.meAt
	m.mu.Unlock()
	if a == nil || !a.SignedIn {
		st := Status{}
		if a != nil {
			st.Server, st.Username = a.ServerURL, a.Username
		}
		return st
	}
	if unlocked && time.Since(meAt) > time.Minute {
		if fresh, err := client.Me(ctx); err == nil {
			m.mu.Lock()
			m.me, m.meAt, me = fresh, time.Now(), fresh
			m.mu.Unlock()
		}
	}
	st := Status{SignedIn: true, Locked: !unlocked, Server: a.ServerURL, Username: a.Username, DeviceID: a.DeviceID, DeviceName: a.DeviceName}
	if me != nil {
		st.StorageUsed, st.StorageLimit, st.Versioning = me.StorageUsed, me.StorageLimit, me.Versioning
	}
	return st
}

// Client returns the API client of the unlocked account.
func (m *Manager) Client() (*api.Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case m.acct == nil || !m.acct.SignedIn:
		return nil, ErrNotSignedIn
	case m.masterKey == nil:
		return nil, ErrLocked
	}
	return m.client, nil
}

// MasterKey returns a copy of the master key of the unlocked account.
func (m *Manager) MasterKey() ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case m.acct == nil || !m.acct.SignedIn:
		return nil, ErrNotSignedIn
	case m.masterKey == nil:
		return nil, ErrLocked
	}
	return append([]byte(nil), m.masterKey...), nil
}

// Account returns a copy of the account row (nil when none).
func (m *Manager) Account() *state.Account {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.acct == nil {
		return nil
	}
	a := *m.acct
	return &a
}

// PersistSecrets copies the unlocked secrets back into the key store (after
// memory-only mode is turned off).
func (m *Manager) PersistSecrets() {
	m.mu.Lock()
	if m.masterKey == nil {
		m.mu.Unlock()
		return
	}
	b, _ := json.Marshal(secrets{DeviceToken: m.token, MasterKey: e2ee.EncodeBase64(m.masterKey)})
	m.mu.Unlock()
	m.ks.Set(secretsName, string(b))
}

// SetOptions applies new client options (proxy) to the current and future clients.
func (m *Manager) SetOptions(opts api.Options) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.opts = opts
	if m.client == nil {
		return nil
	}
	c, err := api.New(m.client.Server(), opts)
	if err != nil {
		return err
	}
	c.OnRevoked(m.revoked)
	if m.masterKey != nil {
		c.SetToken(m.token)
	}
	m.client = c
	return nil
}

// FieldError is a bad IPC parameter.
type FieldError struct{ Message string }

func (e *FieldError) Error() string { return e.Message }
