// Package account owns the device's sign-in state (plan 5.2-5.3): device
// authorization with the split-key password derivation, master-key unwrap,
// secret storage, unlock, sign-out and revocation, plus device security
// (sync-api.md "Device security", "Key tree"): the request-signing key, the
// keys sealed at rest under the server's shares (atrest.go), the app lock PIN,
// unlock grants, the sync scope and website sign-in tickets.
//
// Three key states: closed (nothing in memory: sync stops), scope (only the
// folder keys of the sync roots and the key pool: the app is locked, syncing
// goes on inside the sync folders), full (also the master key: the app is
// unlocked). The app lock is the grant; locking drops it and wipes the
// master key.
package account

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
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

	"github.com/tifuck/one.gy/client/e2ee"
	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/devkey"
	"github.com/tifuck/one.gy/client/internal/keystore"
	"github.com/tifuck/one.gy/client/internal/state"
	"github.com/tifuck/one.gy/client/internal/sysauth"
	"golang.org/x/crypto/pbkdf2"
)

var (
	ErrNotSignedIn     = errors.New("this computer is not signed in")
	ErrLocked          = errors.New("unlock ONE.GY Desktop to start syncing")
	ErrAppLocked       = errors.New("ONE.GY Desktop is locked")
	ErrNeedsUnlock     = errors.New("this needs ONE.GY Desktop to be unlocked")
	ErrPasswordNeeded  = errors.New("enter your password to unlock this computer")
	ErrAlreadySignedIn = errors.New("already signed in; sign out first")
	ErrWrongPassword   = errors.New("wrong password (if you changed it on the website, sign out and sign in again)")
	ErrSystemUnlockOff = errors.New("Windows Hello or fingerprint unlock is not turned on for this computer")
)

const (
	secretsName   = "secrets"
	pinIterations = 200_000
	pinMinLength  = 4
	pinMaxLength  = 16

	// Status refreshes /me inside account.status: one try this long, and after
	// one without an answer not again for meRetry.
	meTimeout = 5 * time.Second
	meRetry   = 15 * time.Second
)

// secrets is what the key store holds and what is sealed under the password
// in the state DB. MasterKey is in the key store only for devices set up
// before at-rest sealing (migrated on the next online start); the password
// copy always has it.
type secrets struct {
	DeviceToken string `json:"device_token"`
	MasterKey   string `json:"master_key,omitempty"`
	LocalKey    string `json:"local_key,omitempty"`
	PopKey      string `json:"pop_key,omitempty"`
	SysToken    string `json:"sys_token,omitempty"` // fingerprint unlock: sent after a match
}

// Status is the account.status IPC result.
type Status struct {
	SignedIn        bool    `json:"signed_in"`
	Locked          bool    `json:"locked"`     // no keys at all: sync is stopped
	FullKeys        bool    `json:"full_keys"`  // the master key is in memory
	AppLocked       bool    `json:"app_locked"` // no grant: sync scope only, no website
	LockEnabled     bool    `json:"lock_enabled"`
	PinSet          bool    `json:"pin_set"`
	PinExpiresAt    *string `json:"pin_expires_at"`
	PinStrict       bool    `json:"pin_strict"`
	PinAttemptsLeft int     `json:"pin_attempts_left"`
	PinErasedAt     *string `json:"pin_erased_at"`
	SystemUnlock    string  `json:"system_unlock"`           // on: "hello" or "fingerprint"
	SystemAvailable string  `json:"system_unlock_available"` // what this computer offers ("" = none)
	SignedRequests  bool    `json:"signed_requests"`
	HardwareKey     bool    `json:"hardware_key"`
	Server          string  `json:"server"`
	Username        string  `json:"username"`
	UserID          int64   `json:"user_id"`
	DeviceID        string  `json:"device_id"`
	DeviceName      string  `json:"device_name"`
	StorageUsed     int64   `json:"storage_used"`
	StorageLimit    int64   `json:"storage_limit"`
	Versioning      bool    `json:"versioning"`      // one.gy keeps previous versions on replace
	KeyStoreError   string  `json:"key_store_error"` // the last key store write failed: the secrets are in memory only ("" = saved)
}

// Manager is safe for concurrent use. Network calls run without the lock.
type Manager struct {
	db   *state.DB
	ks   *keystore.Store
	opts api.Options

	mu          sync.Mutex
	acct        *state.Account
	client      *api.Client
	keysOpen    bool             // scope or full
	masterKey   []byte           // full only
	treeKeys    map[int64][]byte // folder keys of the sync roots (0 = root)
	poolKey     []byte           // opens the pre-made keys
	share       []byte           // unlock_share, kept while the keys are open
	masterShare []byte           // master_share, kept while the master key is in memory
	token       string
	localKey    []byte
	popKey      devkey.Key
	sec         api.Security
	me          *api.Me
	meAt        time.Time
	meFailedAt  time.Time // last /me that got no answer: Status waits meRetry before the next
	sys         sysauth.Authenticator
	sysToken    string // fingerprint unlock token (key store)
	sysAvail    string // cached Kind() when Available
	sysAvailAt  time.Time
	failPending int    // failed local unlocks not reported yet (offline)
	ksErr       string // why the key store could not be read or written ("" = fine)

	// OnChange runs (in its own goroutine) after sign-in or lock state changes;
	// OnRevoked after the server reported device_revoked.
	OnChange  func()
	OnRevoked func()
}

func New(db *state.DB, ks *keystore.Store, opts api.Options) *Manager {
	return &Manager{db: db, ks: ks, opts: opts, sys: sysauth.Default()}
}

// Load restores the account at engine start from the key store: device token,
// local key and signing key (and the master key of a not yet migrated
// device). AutoUnlock then opens the scope set with the server's share.
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
		m.ksErr = err.Error()
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

// applySecretsLocked installs the device token, local key and signing key,
// and a master key when present and matching key_check.
func (m *Manager) applySecretsLocked(s secrets) bool {
	if s.DeviceToken == "" {
		return false
	}
	m.token = s.DeviceToken
	m.client.SetToken(s.DeviceToken)
	m.sysToken = s.SysToken
	if k, err := e2ee.DecodeBase64(s.LocalKey); err == nil && len(k) == e2ee.KeySize {
		m.localKey = k
	}
	if s.PopKey != "" {
		if k, err := devkey.Load(s.PopKey); err == nil {
			m.popKey = k
			m.client.SetSigner(k)
		} else {
			slog.Warn("request-signing key unavailable", "err", err)
		}
	}
	if s.MasterKey == "" {
		return true
	}
	key, err := e2ee.DecodeBase64(s.MasterKey)
	if err != nil || len(key) != e2ee.KeySize || keyCheck(key) != m.acct.KeyCheck {
		return false
	}
	m.masterKey, m.keysOpen = key, true
	return true
}

func (m *Manager) secretsLocked(withMaster bool) secrets {
	s := secrets{DeviceToken: m.token, SysToken: m.sysToken}
	if m.localKey != nil {
		s.LocalKey = e2ee.EncodeBase64(m.localKey)
	}
	if m.popKey != nil {
		s.PopKey = m.popKey.Ref()
	}
	if withMaster && m.masterKey != nil {
		s.MasterKey = e2ee.EncodeBase64(m.masterKey)
	}
	return s
}

func keyCheck(key []byte) string {
	sum := sha256.Sum256(key)
	return hex.EncodeToString(sum[:])
}

// pinKeys derives the proof the server verifies (PBKDF2-SHA256 with a
// device-specific salt, then HMAC). Five wrong proofs and it forgets the PIN.
func pinKeys(pin, deviceID string) string {
	pinKey := pbkdf2.Key([]byte(pin), []byte("onegy-pin-v1:"+deviceID), pinIterations, 32, sha256.New)
	defer clear(pinKey)
	mac := hmac.New(sha256.New, pinKey)
	mac.Write([]byte("onegy-pin-proof-v1"))
	return e2ee.EncodeBase64(mac.Sum(nil))
}

// ValidPin checks a new PIN: 4 to 16 ASCII letters or digits. PINs set
// before this rule keep unlocking; only new ones are checked.
func ValidPin(pin string) error {
	ok := len(pin) >= pinMinLength && len(pin) <= pinMaxLength
	for _, c := range pin {
		ok = ok && (c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z')
	}
	if !ok {
		return &FieldError{Message: fmt.Sprintf("the PIN must be %d to %d letters or digits", pinMinLength, pinMaxLength)}
	}
	if weakPin(pin) {
		return &FieldError{Message: "this PIN is too easy to guess: avoid repeats, runs like 1234 or abcd, and common PINs"}
	}
	return nil
}

// Common PINs that repeats and runs do not already catch.
var commonPins = map[string]bool{
	"1004": true, "2000": true, "2001": true, "1122": true, "1313": true, "6969": true, "2580": true, "0852": true,
	"112233": true, "password": true, "passw0rd": true, "qwerty": true, "qwertz": true, "azerty": true,
	"asdf": true, "asdfgh": true, "zxcv": true, "qazwsx": true, "1q2w3e": true, "1q2w3e4r": true,
	"abc123": true, "letmein": true, "welcome": true, "admin": true, "iloveyou": true, "monkey": true, "dragon": true,
}

// weakPin: a common PIN, a block of 1 to 3 characters repeated (1111, 1212,
// 123123) or a run up or down (1234, 9876, abcd), ignoring case. Five tries
// against the most common PINs is the realistic attack.
func weakPin(pin string) bool {
	p := strings.ToLower(pin)
	if commonPins[p] {
		return true
	}
	for n := 1; n <= 3 && 2*n <= len(p); n++ {
		if strings.Repeat(p[:n], len(p)/n+1)[:len(p)] == p {
			return true
		}
	}
	up, down := true, true
	for i := 1; i < len(p); i++ {
		up = up && p[i] == p[i-1]+1
		down = down && p[i] == p[i-1]-1
	}
	return up || down
}

// AuthorizeParams are the account.authorize IPC params.
type AuthorizeParams struct {
	Server     string `json:"server"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	TOTPCode   string `json:"totp_code"`
	DeviceName string `json:"device_name"`
}

// Authorize runs the device flow of plan 5.2 and stores the secrets. The
// password unlock it ends with leaves the app unlocked (a grant) so the user
// can choose a PIN right away.
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
	pop, err := devkey.New(randomHex(8))
	if err != nil {
		return err
	}
	auth, err := client.Authorize(ctx, api.AuthorizeRequest{
		Username: p.Username, AuthToken: authToken, TOTPCode: strings.TrimSpace(p.TOTPCode),
		DeviceName: p.DeviceName, Platform: runtime.GOOS, ClientVersion: m.opts.Version,
		PopPublicKey: e2ee.EncodeBase64(pop.PublicDER()),
	})
	if err != nil {
		devkey.Delete(pop.Ref())
		return err
	}
	client.SetToken(auth.DeviceToken)
	client.SetSigner(pop)
	// Do not leave a half-authorized device behind on the account.
	abandon := func(err error) error {
		if derr := client.DeleteDevice(context.WithoutCancel(ctx)); derr != nil {
			slog.Warn("could not remove the half-authorized device", "err", derr)
		}
		devkey.Delete(pop.Ref())
		return err
	}
	masterKey, err := m.fetchMasterKey(ctx, client, wrappingKey)
	var unlock *api.UnlockResponse
	if err == nil {
		unlock, err = client.Unlock(ctx, api.UnlockRequest{AuthToken: authToken})
	}
	var share, mshare []byte
	if err == nil {
		share, mshare, err = shares(unlock)
	}
	if err == nil && mshare == nil { // a password unlock always carries it (sync-api.md "App lock")
		err = fmt.Errorf("server sent no master share")
	}
	var local, pool []byte
	if err == nil {
		local, err = e2ee.RandomBytes(e2ee.KeySize)
	}
	if err == nil {
		pool, err = e2ee.RandomBytes(e2ee.KeySize)
	}
	if err != nil {
		return abandon(err)
	}
	a := &state.Account{
		ServerURL: client.Server(), UserID: auth.User.ID, Username: auth.User.Username, DeviceID: auth.DeviceID,
		DeviceName: p.DeviceName, SignedIn: true, KeyCheck: keyCheck(masterKey), AuthSalt: pre.AuthTokenSalt,
	}
	if a.Username == "" {
		a.Username = p.Username
	}
	m.mu.Lock()
	m.acct, m.client, m.masterKey, m.keysOpen, m.token, m.me = a, client, masterKey, true, auth.DeviceToken, nil
	m.localKey, m.popKey, m.share, m.masterShare, m.poolKey, m.treeKeys, m.sec = local, pop, share, mshare, pool, map[int64][]byte{}, unlock.Security
	m.mu.Unlock()
	err = m.db.PutAccount(ctx, a)
	if err == nil {
		err = m.sealPassword(ctx, wrappingKey)
	}
	if err == nil {
		err = m.sealScope(ctx)
	}
	if err == nil {
		err = m.sealMaster(ctx)
	}
	if err != nil {
		if werr := m.wipe(context.WithoutCancel(ctx)); werr != nil {
			slog.Warn("could not clear the unfinished sign-in", "err", werr)
		}
		return abandon(err)
	}
	// A key store that cannot be written does not fail the sign-in: the
	// password-sealed copy just written opens the keys after a restart, and
	// persist reports the failure in account.status (key_store_error).
	m.persist()
	client.SetGrant(unlock.Grant)
	slog.Info("device authorized", "device_id", a.DeviceID, "hardware_key", pop.Hardware())
	m.changed()
	return nil
}

func shares(res *api.UnlockResponse) (share, mshare []byte, err error) {
	if share, err = e2ee.DecodeBase64(res.UnlockShare); err != nil || len(share) != 32 {
		return nil, nil, fmt.Errorf("server sent no unlock share")
	}
	if res.MasterShare != "" {
		if mshare, err = e2ee.DecodeBase64(res.MasterShare); err != nil || len(mshare) != 32 {
			return nil, nil, fmt.Errorf("server sent a bad master share")
		}
	}
	return share, mshare, nil
}

// sealPassword writes the password-sealed copy of every secret (the offline
// way back in, e.g. after the OS key store lost its entry); called whenever
// the password is at hand.
func (m *Manager) sealPassword(ctx context.Context, wrappingKey []byte) error {
	m.mu.Lock()
	if m.masterKey == nil || m.acct == nil {
		m.mu.Unlock()
		return nil
	}
	plain, _ := json.Marshal(m.secretsLocked(true))
	m.mu.Unlock()
	sealed, nonce, err := e2ee.EncryptName(string(plain), wrappingKey)
	if err != nil {
		return err
	}
	sealedB64, nonceB64 := e2ee.EncodeBase64(sealed), e2ee.EncodeBase64(nonce)
	if err := m.db.SetSealedSecrets(ctx, sealedB64, nonceB64); err != nil {
		return err
	}
	m.mu.Lock()
	if m.acct != nil {
		m.acct.SealedSecrets, m.acct.SealedNonce = sealedB64, nonceB64
	}
	m.mu.Unlock()
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

// persist writes the key store entry: token, local key, signing key, and the
// master key only while there is no sealed copy of it (not migrated yet). A
// failure leaves them in memory only (after a restart only the password opens
// them): it is logged and shown in account.status until a write succeeds.
func (m *Manager) persist() error {
	sealed := m.hasMasterAtRest(context.Background())
	m.mu.Lock()
	b, _ := json.Marshal(m.secretsLocked(!sealed))
	m.mu.Unlock()
	err := m.ks.Set(secretsName, string(b))
	m.mu.Lock()
	m.ksErr = ""
	if err != nil {
		m.ksErr = err.Error()
	}
	m.mu.Unlock()
	if err != nil {
		slog.Error("device secrets not saved in the key store; after a restart only the password unlocks this computer", "err", err)
	}
	return err
}

// AutoUnlock opens the scope set with the server's share (no PIN unless
// strict), so syncing resumes after a start without the master key, and
// migrates devices set up before. Called by the poller; ErrLocked = the PIN
// or password is needed.
func (m *Manager) AutoUnlock(ctx context.Context) error {
	m.mu.Lock()
	a, client, token, open, full, local, known := m.acct, m.client, m.token, m.keysOpen, m.masterKey != nil, m.localKey, m.sec.SignedRequests
	m.mu.Unlock()
	if a == nil || !a.SignedIn || client == nil || token == "" {
		return ErrNotSignedIn
	}
	if full {
		return m.migrate(ctx)
	}
	if open {
		return nil
	}
	if a.AtRestSealed == "" || local == nil {
		return ErrLocked
	}
	res, err := client.Unlock(ctx, api.UnlockRequest{})
	if api.IsCode(err, "pin_required") {
		// Strict: learn the lock state once (PIN set, expired, tries left)
		// so the lock screen asks for the right thing.
		if !known {
			if me, err := client.Me(ctx); err == nil {
				m.mu.Lock()
				m.sec = me.Device.Security
				m.mu.Unlock()
				m.changed()
			}
		}
		return ErrLocked
	}
	if err != nil {
		return err
	}
	if err := m.openScopeWith(res); err != nil {
		return err
	}
	slog.Info("sync keys unlocked with the server share")
	m.changed()
	return nil
}

// openScopeWith opens the scope set with an unlock answer's share.
func (m *Manager) openScopeWith(res *api.UnlockResponse) error {
	share, mshare, err := shares(res)
	if err != nil {
		return err
	}
	m.mu.Lock()
	a, local := m.acct, m.localKey
	m.mu.Unlock()
	keys, pool, err := openScope(a, share, local)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.treeKeys, m.poolKey, m.share, m.keysOpen, m.sec = keys, pool, share, true, res.Security
	if mshare != nil {
		m.masterShare = mshare
	}
	m.mu.Unlock()
	return nil
}

// migrate brings a device authorized by an older version up to date: a
// request-signing key, then the master key moved out of the key store into
// the sealed copies. Online only; retried on the next call.
func (m *Manager) migrate(ctx context.Context) error {
	m.mu.Lock()
	client, pop, scopeSealed := m.client, m.popKey, m.acct.AtRestSealed != ""
	m.mu.Unlock()
	// Enrolling a signing key needs a grant (password or PIN unlock), even on
	// a device without the app lock; until then it is retried after the next unlock.
	if pop == nil && client.Grant() != "" {
		k, err := devkey.New(randomHex(8))
		if err != nil {
			return err
		}
		client.SetSigner(k) // ignored by the server until the key is enrolled
		if err := client.EnrollPopKey(ctx, e2ee.EncodeBase64(k.PublicDER())); err != nil {
			client.SetSigner(nil)
			devkey.Delete(k.Ref())
			return err
		}
		m.mu.Lock()
		m.popKey = k
		m.mu.Unlock()
		m.persist()
		slog.Info("request-signing key enrolled", "hardware", k.Hardware())
	}
	if scopeSealed {
		return nil
	}
	m.mu.Lock()
	share, local := m.share, m.localKey
	m.mu.Unlock()
	if share == nil {
		res, err := client.Unlock(ctx, api.UnlockRequest{})
		if err != nil {
			return err
		}
		if share, _, err = shares(res); err != nil {
			return err
		}
	}
	if local == nil {
		var err error
		if local, err = e2ee.RandomBytes(e2ee.KeySize); err != nil {
			return err
		}
	}
	pool, err := e2ee.RandomBytes(e2ee.KeySize)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.share, m.localKey, m.poolKey = share, local, pool
	if m.treeKeys == nil {
		m.treeKeys = map[int64][]byte{}
	}
	m.mu.Unlock()
	if err := m.sealScope(ctx); err != nil {
		return err
	}
	m.persist()
	slog.Info("sync keys sealed at rest; the master key follows at the next PIN or password unlock")
	return nil
}

// Unlock opens the password-sealed secrets (works offline: memory-only mode,
// a lost key store, a PIN erased after too many tries), then, when the server
// answers, unlocks the app and refreshes every sealed copy.
func (m *Manager) Unlock(ctx context.Context, password string) error {
	m.mu.Lock()
	a, client := m.acct, m.client
	m.mu.Unlock()
	if a == nil || !a.SignedIn {
		return ErrNotSignedIn
	}
	authToken, wrappingKey, err := e2ee.DeriveAuthAndWrappingKeys(password, a.AuthSalt)
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
	ok := m.applySecretsLocked(s) && m.masterKey != nil
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("sealed secrets do not match this account; sign out and sign in again")
	}
	res, err := client.Unlock(ctx, api.UnlockRequest{AuthToken: authToken})
	if err == nil {
		err = m.unlockedApp(ctx, res)
	}
	if err == nil {
		err = m.migrate(ctx)
	}
	if err != nil {
		slog.Warn("keys unlocked, but the app could not be unlocked online", "err", err)
	}
	if err := m.sealPassword(ctx, wrappingKey); err != nil {
		slog.Warn("password copy of the secrets not refreshed", "err", err)
	}
	m.persist()
	m.changed()
	return nil
}

// unlockedApp installs a credential unlock answer: grant, shares, the scope
// set (opened, or created when there is none or it no longer opens) and the
// sealed master key.
func (m *Manager) unlockedApp(ctx context.Context, res *api.UnlockResponse) error {
	share, mshare, err := shares(res)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.share, m.masterShare, m.sec = share, mshare, res.Security
	a, local, open := m.acct, m.localKey, m.keysOpen && m.poolKey != nil
	client := m.client
	m.mu.Unlock()
	if !open {
		if keys, pool, err := openScope(a, share, local); err == nil {
			m.mu.Lock()
			m.treeKeys, m.poolKey, m.keysOpen = keys, pool, true
			m.mu.Unlock()
		} else if local != nil {
			pool, err := e2ee.RandomBytes(e2ee.KeySize)
			if err != nil {
				return err
			}
			m.mu.Lock()
			m.poolKey, m.treeKeys, m.keysOpen = pool, map[int64][]byte{}, true
			m.mu.Unlock()
			m.db.PoolClear(ctx) // sealed under a pool key that is gone
			if err := m.sealScope(ctx); err != nil {
				return err
			}
		}
	}
	if err := m.sealMaster(ctx); err != nil && !errors.Is(err, ErrNeedsUnlock) {
		return err
	}
	client.SetGrant(res.Grant)
	return nil
}

// AppUnlock unlocks the app with the PIN: a grant, the scope set when the keys
// are closed (strict mode after a start), and the master key from its sealed
// copy. Errors: invalid_pin (attempts left in status), pin_locked,
// pin_expired, pin_not_set, ErrPasswordNeeded.
func (m *Manager) AppUnlock(ctx context.Context, pin string) error {
	m.mu.Lock()
	a, client := m.acct, m.client
	m.mu.Unlock()
	if a == nil || !a.SignedIn || client == nil {
		return ErrNotSignedIn
	}
	return m.appUnlockWith(ctx, api.UnlockRequest{PinProof: pinKeys(pin, a.DeviceID)})
}

// appUnlockWith sends a PIN or system unlock proof, then installs the answer:
// a grant, the scope set when the keys are closed, and the master key from
// its sealed copy. Unreported local failures go first, so none is skipped.
func (m *Manager) appUnlockWith(ctx context.Context, req api.UnlockRequest) error {
	m.mu.Lock()
	a, client, local := m.acct, m.client, m.localKey
	m.mu.Unlock()
	if err := m.flushFailures(ctx); err != nil {
		return err
	}
	res, err := client.Unlock(ctx, req)
	if err != nil {
		m.pinRefused(ctx, err)
		return err
	}
	share, mshare, err := shares(res)
	if err != nil {
		return err
	}
	m.mu.Lock()
	open, full := m.keysOpen && m.poolKey != nil, m.masterKey != nil
	m.mu.Unlock()
	if !open {
		if err := m.openScopeWith(res); err != nil {
			return err
		}
	}
	if !full {
		mk, err := m.openMaster(ctx, a, mshare, local)
		if err != nil {
			return err
		}
		m.mu.Lock()
		m.masterKey = mk
		m.mu.Unlock()
	}
	m.mu.Lock()
	m.share, m.masterShare, m.sec = share, mshare, res.Security
	m.mu.Unlock()
	if full {
		if err := m.sealMaster(ctx); err != nil {
			slog.Warn("master key not sealed", "err", err)
		}
	}
	client.SetGrant(res.Grant)
	m.changed()
	return m.migrate(ctx)
}

// sysName names this device's Windows Hello key.
func sysName(deviceID string) string { return "unlock-" + deviceID }

// systemAvailable is the system check this computer offers ("" = none),
// asked at most once a minute (fprintd answers over D-Bus).
func (m *Manager) systemAvailable(ctx context.Context) string {
	m.mu.Lock()
	avail, at, sys := m.sysAvail, m.sysAvailAt, m.sys
	m.mu.Unlock()
	if time.Since(at) < time.Minute || sys == nil || sys.Kind() == "" {
		return avail
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	avail = ""
	if sys.Available(ctx) {
		avail = sys.Kind()
	}
	m.mu.Lock()
	m.sysAvail, m.sysAvailAt = avail, time.Now()
	m.mu.Unlock()
	return avail
}

// EnableSystemUnlock turns on Windows Hello or fingerprint unlock (app
// unlocked, plus cur like a PIN change). Hello creates its key (Windows asks
// to verify); a fingerprint is checked once and a random token goes to the
// key store and, hashed, to the server.
func (m *Manager) EnableSystemUnlock(ctx context.Context, cur Current, hwnd uint64) error {
	m.mu.Lock()
	a, client, sys := m.acct, m.client, m.sys
	m.mu.Unlock()
	if a == nil || !a.SignedIn || client == nil {
		return ErrNotSignedIn
	}
	if client.Grant() == "" {
		return ErrAppLocked
	}
	if sys.Kind() == "" || !sys.Available(ctx) {
		return sysauth.ErrUnavailable
	}
	cred, err := pinCredential(a, cur)
	if err != nil {
		return err
	}
	pub, err := sys.Enroll(ctx, sysName(a.DeviceID), hwnd)
	if err != nil {
		return err
	}
	var token string
	if sys.Kind() == sysauth.KindFingerprint {
		token = randomHex(32)
	}
	sec, err := client.SetSystemUnlock(ctx, sys.Kind(), e2ee.EncodeBase64(pub), token, cred)
	if err != nil {
		if pub != nil {
			sys.Remove(sysName(a.DeviceID))
		}
		m.pinRefused(ctx, err)
		return err
	}
	m.mu.Lock()
	m.sec, m.sysToken = *sec, token
	m.mu.Unlock()
	m.persist()
	m.changed()
	return nil
}

// DisableSystemUnlock turns it off (app unlocked) and drops the local key or token.
func (m *Manager) DisableSystemUnlock(ctx context.Context) error {
	m.mu.Lock()
	a, client, sys := m.acct, m.client, m.sys
	m.mu.Unlock()
	if a == nil || !a.SignedIn || client == nil {
		return ErrNotSignedIn
	}
	if client.Grant() == "" {
		return ErrAppLocked
	}
	sec, err := client.RemoveSystemUnlock(ctx)
	if err != nil {
		return err
	}
	sys.Remove(sysName(a.DeviceID))
	m.mu.Lock()
	m.sec, m.sysToken = *sec, ""
	m.mu.Unlock()
	m.persist()
	m.changed()
	return nil
}

// SystemUnlock unlocks the app with Windows Hello (a signature over a fresh
// timestamp) or a fingerprint (then the token). A wrong finger counts as a
// failed unlock on the server, like a wrong PIN; a cancelled check does not.
func (m *Manager) SystemUnlock(ctx context.Context, hwnd uint64) error {
	m.mu.Lock()
	a, client, sys, kind, token := m.acct, m.client, m.sys, m.sec.SystemUnlock, m.sysToken
	m.mu.Unlock()
	if a == nil || !a.SignedIn || client == nil {
		return ErrNotSignedIn
	}
	if kind == "" || kind != sys.Kind() || (kind == sysauth.KindFingerprint && token == "") {
		return ErrSystemUnlockOff
	}
	req := api.UnlockRequest{}
	switch kind {
	case sysauth.KindHello:
		ts := time.Now().Unix()
		sig, err := sys.Prove(ctx, sysName(a.DeviceID), []byte(fmt.Sprintf("onegy-system-unlock-v1\n%s\n%d", a.DeviceID, ts)), hwnd)
		if err != nil {
			return err
		}
		req.SystemProof, req.SystemTs = e2ee.EncodeBase64(sig), ts
	default:
		vctx, cancel := context.WithTimeout(ctx, time.Minute)
		_, err := sys.Prove(vctx, sysName(a.DeviceID), nil, hwnd)
		cancel()
		if errors.Is(err, sysauth.ErrNoMatch) {
			m.mu.Lock()
			m.failPending++
			m.mu.Unlock()
			m.flushFailures(ctx)
			return err
		}
		if err != nil {
			return err
		}
		req.SystemProof = token
	}
	return m.appUnlockWith(ctx, req)
}

// flushFailures reports failed local unlocks; a report the server cannot get
// yet (offline) is retried before the next unlock.
// shortcut: the pending count lives in memory, so an engine restart while
// offline drops it; persist it in the state DB if that matters.
func (m *Manager) flushFailures(ctx context.Context) error {
	m.mu.Lock()
	n, client := m.failPending, m.client
	m.mu.Unlock()
	if n == 0 || client == nil {
		return nil
	}
	sec, err := client.UnlockFailed(ctx, min(n, 5))
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.failPending, m.sec = 0, *sec
	m.mu.Unlock()
	if !sec.PinSet && sec.SystemUnlock == "" && client.Grant() != "" {
		m.lockLocal(ctx) // erased with the grant
	}
	m.changed()
	return nil
}

// AppLock drops the grant (server first, best effort; it also expires on its
// own) and wipes the master key; sync goes on inside the scope. A device
// whose master key has no sealed copy yet keeps it (only the password could
// bring it back).
func (m *Manager) AppLock(ctx context.Context) {
	m.mu.Lock()
	client := m.client
	m.mu.Unlock()
	if client == nil {
		return
	}
	m.DropGrant(ctx)
	m.lockLocal(ctx)
}

// DropGrant ends the app's grant on the server (best effort; it also expires
// on its own), and with it this device's website session. AppLock uses it,
// and the engine when it stops: the keys in memory go with the process.
func (m *Manager) DropGrant(ctx context.Context) {
	m.mu.Lock()
	client := m.client
	m.mu.Unlock()
	if client == nil || client.Grant() == "" {
		return
	}
	if err := client.DropGrant(ctx); err != nil {
		slog.Warn("could not drop the grant on the server (it expires on its own)", "err", err)
	}
}

func (m *Manager) lockLocal(ctx context.Context) {
	m.mu.Lock()
	client := m.client
	m.mu.Unlock()
	client.SetGrant("")
	if m.hasMasterAtRest(ctx) {
		m.mu.Lock()
		clear(m.masterKey)
		clear(m.masterShare)
		m.masterKey, m.masterShare = nil, nil
		m.mu.Unlock()
	}
	m.changed()
}

// RefreshGrant keeps an unlocked app unlocked; a grant the server no longer
// accepts locks the app.
func (m *Manager) RefreshGrant(ctx context.Context) {
	m.mu.Lock()
	client := m.client
	m.mu.Unlock()
	if client == nil || client.Grant() == "" {
		return
	}
	err := client.RefreshGrant(ctx)
	if api.IsCode(err, "grant_required") {
		m.lockLocal(ctx)
	}
}

// Current proves who changes or removes the PIN: the current PIN or the
// password. Neither is needed within 10 minutes of a password unlock.
type Current struct {
	Pin      string `json:"current_pin"`
	Password string `json:"password"`
}

func pinCredential(a *state.Account, cur Current) (api.PinCredential, error) {
	switch {
	case cur.Password != "":
		authToken, wrappingKey, err := e2ee.DeriveAuthAndWrappingKeys(cur.Password, a.AuthSalt)
		if err != nil {
			return api.PinCredential{}, err
		}
		clear(wrappingKey)
		return api.PinCredential{AuthToken: authToken}, nil
	case cur.Pin != "":
		return api.PinCredential{CurrentPinProof: pinKeys(cur.Pin, a.DeviceID)}, nil
	}
	return api.PinCredential{}, nil
}

// pinRefused follows a refused PIN: tries left, or a PIN the server erased
// (five wrong in a row) together with the grant, which locks the app.
func (m *Manager) pinRefused(ctx context.Context, err error) {
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		return
	}
	switch apiErr.Code {
	case "invalid_pin", "system_unlock_failed":
		m.mu.Lock()
		m.sec.PinAttemptsLeft = apiErr.AttemptsLeft
		m.mu.Unlock()
	case "pin_locked":
		m.mu.Lock()
		m.sec.PinSet, m.sec.SystemUnlock, m.meAt = false, "", time.Time{} // the next status asks /me (pin_erased_at)
		m.mu.Unlock()
		m.lockLocal(ctx)
	}
}

// SetPin sets or changes the app lock PIN (app unlocked, plus cur). strict: the
// server then gives the unlock share only with the PIN, so after a restart
// syncing waits for it.
func (m *Manager) SetPin(ctx context.Context, pin string, strict bool, cur Current) error {
	if err := ValidPin(pin); err != nil {
		return err
	}
	m.mu.Lock()
	a, client := m.acct, m.client
	m.mu.Unlock()
	if a == nil || !a.SignedIn || client == nil {
		return ErrNotSignedIn
	}
	if client.Grant() == "" {
		return ErrAppLocked
	}
	cred, err := pinCredential(a, cur)
	if err != nil {
		return err
	}
	sec, err := client.SetPin(ctx, pinKeys(pin, a.DeviceID), strict, cred)
	if err != nil {
		m.pinRefused(ctx, err)
		return err
	}
	m.mu.Lock()
	m.sec = *sec
	m.mu.Unlock()
	m.changed()
	return nil
}

// RemovePin stops using a PIN (app unlocked, plus cur): the app lock asks
// for the password again.
func (m *Manager) RemovePin(ctx context.Context, cur Current) error {
	m.mu.Lock()
	a, client := m.acct, m.client
	m.mu.Unlock()
	if a == nil || !a.SignedIn || client == nil {
		return ErrNotSignedIn
	}
	if client.Grant() == "" {
		return ErrAppLocked
	}
	cred, err := pinCredential(a, cur)
	if err != nil {
		return err
	}
	sec, err := client.RemovePin(ctx, cred)
	if err != nil {
		m.pinRefused(ctx, err)
		return err
	}
	m.mu.Lock()
	m.sec = *sec
	m.mu.Unlock()
	m.changed()
	return nil
}

// SetScope tells the server what this device may reach while locked.
func (m *Manager) SetScope(ctx context.Context, scope api.Scope) error {
	c, err := m.Client()
	if err != nil {
		return err
	}
	if c.Grant() == "" {
		return ErrAppLocked
	}
	return c.SetScope(ctx, scope)
}

// WebSession returns a one-use website sign-in ticket (app unlocked).
func (m *Manager) WebSession(ctx context.Context) (string, error) {
	c, err := m.Client()
	if err != nil {
		return "", err
	}
	if c.Grant() == "" {
		return "", ErrAppLocked
	}
	return c.WebSession(ctx)
}

// AppUnlocked reports whether the app holds a grant.
func (m *Manager) AppUnlocked() bool {
	m.mu.Lock()
	client := m.client
	m.mu.Unlock()
	return client != nil && client.Grant() != ""
}

// Restricted reports an app lock in force (lock on, no grant): only the
// syncs already set up may run.
func (m *Manager) Restricted() bool {
	m.mu.Lock()
	a, client, lockOn := m.acct, m.client, m.sec.LockEnabled
	m.mu.Unlock()
	return a != nil && a.SignedIn && client != nil && client.Grant() == "" && (lockOn || a.AtRestSealed != "")
}

// KeysOpen reports whether sync can run (scope or full keys).
func (m *Manager) KeysOpen() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.acct != nil && m.acct.SignedIn && m.keysOpen
}

// SignOut wipes the keys and the device identity (keeps synced files). With
// revoke the server-side device is deleted first; failing that (offline) the
// local sign-out still happens and the error is returned.
func (m *Manager) SignOut(ctx context.Context, revoke bool) error {
	m.mu.Lock()
	client := m.client
	canRevoke := m.token != ""
	m.mu.Unlock()
	var revokeErr error
	if revoke && client != nil && !canRevoke {
		revokeErr = fmt.Errorf("signed out on this computer, but the device could not be removed from your account while locked; remove it under Devices on the website")
	}
	if revoke && client != nil && canRevoke {
		if err := client.DeleteDevice(ctx); err != nil && !api.IsCode(err, "invalid_token") && !api.IsCode(err, "device_revoked") {
			revokeErr = err
		}
	}
	if err := m.wipe(ctx); err != nil {
		m.changed()
		return err
	}
	m.changed()
	return revokeErr
}

func (m *Manager) wipe(ctx context.Context) error {
	ksErr := m.ks.Delete(secretsName)
	m.mu.Lock()
	if m.acct != nil && m.sys != nil {
		m.sys.Remove(sysName(m.acct.DeviceID))
	}
	m.sysToken, m.failPending, m.ksErr = "", 0, ""
	if m.popKey != nil {
		devkey.Delete(m.popKey.Ref())
	}
	for _, k := range [][]byte{m.masterKey, m.localKey, m.share, m.masterShare, m.poolKey} {
		clear(k)
	}
	for _, k := range m.treeKeys {
		clear(k)
	}
	m.masterKey, m.token, m.client, m.me, m.localKey, m.popKey, m.share, m.masterShare, m.sec = nil, "", nil, nil, nil, nil, nil, nil, api.Security{}
	m.poolKey, m.treeKeys, m.keysOpen = nil, nil, false
	if m.acct != nil {
		m.acct.SignedIn = false
		m.acct.AtRestSealed, m.acct.AtRestNonce, m.acct.AtRestPIN = "", "", false
	}
	m.mu.Unlock()
	if err := m.db.SignOutAccount(ctx); err != nil {
		return err
	}
	if ksErr != nil {
		return fmt.Errorf("signed out, but the stored device secrets could not be removed: %w", ksErr)
	}
	return nil
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

// Status returns account.status; storage numbers and the lock state are
// refreshed at most once a minute and kept when the server is unreachable.
// That refresh is one bounded try: account.status answers while offline too.
func (m *Manager) Status(ctx context.Context) Status {
	m.mu.Lock()
	a, client, open, me, meAt, meFailedAt := m.acct, m.client, m.keysOpen, m.me, m.meAt, m.meFailedAt
	m.mu.Unlock()
	if a == nil || !a.SignedIn {
		st := Status{AppLocked: true}
		if a != nil {
			st.Server, st.Username = a.ServerURL, a.Username
		}
		return st
	}
	if open && time.Since(meAt) > time.Minute && time.Since(meFailedAt) > meRetry {
		meCtx, cancel := context.WithTimeout(ctx, meTimeout)
		fresh, err := client.Me(meCtx)
		cancel()
		m.mu.Lock()
		if err == nil {
			m.me, m.meAt, me = fresh, time.Now(), fresh
			m.sec = fresh.Device.Security
		} else {
			m.meFailedAt = time.Now()
		}
		m.mu.Unlock()
	}
	m.mu.Lock()
	sec, hardware, full, ksErr := m.sec, m.popKey != nil && m.popKey.Hardware(), m.masterKey != nil, m.ksErr
	m.mu.Unlock()
	avail := m.systemAvailable(ctx)
	st := Status{SignedIn: true, Locked: !open, FullKeys: full, AppLocked: client.Grant() == "", Server: a.ServerURL, Username: a.Username,
		UserID: a.UserID, DeviceID: a.DeviceID, DeviceName: a.DeviceName,
		// A device sealed at rest has been through a password unlock, which
		// turns the lock on server-side; that holds before /me answers too.
		LockEnabled: sec.LockEnabled || a.AtRestSealed != "", PinSet: sec.PinSet, PinExpiresAt: sec.PinExpiresAt, PinStrict: sec.PinStrict,
		PinAttemptsLeft: sec.PinAttemptsLeft, PinErasedAt: sec.PinErasedAt, SystemUnlock: sec.SystemUnlock, SystemAvailable: avail, SignedRequests: sec.SignedRequests, HardwareKey: hardware,
		KeyStoreError: ksErr}
	if me != nil {
		st.StorageUsed, st.StorageLimit, st.Versioning = me.StorageUsed, me.StorageLimit, me.Versioning
	}
	return st
}

// Client returns the API client while the keys are open (scope or full).
func (m *Manager) Client() (*api.Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case m.acct == nil || !m.acct.SignedIn:
		return nil, ErrNotSignedIn
	case !m.keysOpen:
		return nil, ErrLocked
	}
	return m.client, nil
}

// MasterKey returns a copy of the master key: ErrNeedsUnlock while the app is
// locked (the key tree then serves the sync folders), ErrLocked when closed.
func (m *Manager) MasterKey() ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case m.acct == nil || !m.acct.SignedIn:
		return nil, ErrNotSignedIn
	case !m.keysOpen:
		return nil, ErrLocked
	case m.masterKey == nil:
		return nil, ErrNeedsUnlock
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

// PersistSecrets copies the secrets back into the key store (after
// memory-only mode is turned off).
func (m *Manager) PersistSecrets() error {
	m.mu.Lock()
	has := m.token != ""
	m.mu.Unlock()
	if !has {
		return nil
	}
	err := m.persist()
	m.changed()
	return err
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
	m.client.CopyAuth(c)
	m.client = c
	return nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// FieldError is a bad IPC parameter.
type FieldError struct{ Message string }

func (e *FieldError) Error() string { return e.Message }
