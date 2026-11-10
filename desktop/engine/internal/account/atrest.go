package account

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"strconv"

	"github.com/tifuck/one.gy/desktop/engine/internal/state"
	"golang.org/x/crypto/hkdf"
	"onegy/e2ee"
)

// At rest (sync-api.md "Device security", "Key tree"), nothing on this
// computer opens on its own:
//
//   - the scope set (the folder keys of the sync roots + the pool key) is
//     sealed under HKDF(unlock_share ‖ local_key, "onegy-device-scope-v1"):
//     the server gives unlock_share to the signed device (with the PIN in
//     strict mode), so syncing resumes after a restart;
//   - the master key is sealed under HKDF(master_share ‖ local_key,
//     "onegy-device-master-v1"): master_share only comes with the PIN or the
//     password, so a locked computer never holds the master key;
//   - local_key is in the OS key store, the shares only on the server.

const (
	poolTarget = 2000 // pre-made keys for new files and folders while locked
)

// NewKey is a fresh key with its master-key wrap (base64), as the website
// expects for encrypted_file_key / encrypted_name_key.
type NewKey struct {
	Key   []byte
	Wrap  string
	Nonce string
}

type scopeSet struct {
	TreeKeys map[string]string `json:"tree_keys"` // folder id ("0" = root) -> folder key
	PoolKey  string            `json:"pool_key"`
}

func deriveKey(share, local []byte, info string) ([]byte, error) {
	if len(share) != 32 || len(local) != e2ee.KeySize {
		return nil, fmt.Errorf("at-rest key material missing")
	}
	ikm := append(append([]byte{}, share...), local...)
	out := make([]byte, e2ee.KeySize)
	_, err := io.ReadFull(hkdf.New(sha256.New, ikm, nil, []byte(info)), out)
	clear(ikm)
	return out, err
}

// sealScope stores the scope set (caller holds no lock).
func (m *Manager) sealScope(ctx context.Context) error {
	m.mu.Lock()
	share, local, pool := m.share, m.localKey, m.poolKey
	set := scopeSet{TreeKeys: map[string]string{}, PoolKey: e2ee.EncodeBase64(pool)}
	for id, k := range m.treeKeys {
		set.TreeKeys[strconv.FormatInt(id, 10)] = e2ee.EncodeBase64(k)
	}
	m.mu.Unlock()
	k, err := deriveKey(share, local, "onegy-device-scope-v1")
	if err != nil {
		return err
	}
	defer clear(k)
	plain, _ := json.Marshal(set)
	sealed, nonce, err := e2ee.EncryptName(string(plain), k)
	if err != nil {
		return err
	}
	sealedB64, nonceB64 := e2ee.EncodeBase64(sealed), e2ee.EncodeBase64(nonce)
	if err := m.db.SetAtRest(ctx, sealedB64, nonceB64, false); err != nil {
		return err
	}
	m.mu.Lock()
	if m.acct != nil {
		m.acct.AtRestSealed, m.acct.AtRestNonce = sealedB64, nonceB64
	}
	m.mu.Unlock()
	return nil
}

func openScope(a *state.Account, share, local []byte) (map[int64][]byte, []byte, error) {
	k, err := deriveKey(share, local, "onegy-device-scope-v1")
	if err != nil {
		return nil, nil, err
	}
	defer clear(k)
	plain, err := e2ee.DecryptName(a.AtRestSealed, a.AtRestNonce, k)
	if err != nil {
		return nil, nil, fmt.Errorf("the keys sealed on this computer do not open; sign out and sign in again")
	}
	var set scopeSet
	if err := json.Unmarshal([]byte(plain), &set); err != nil {
		return nil, nil, err
	}
	pool, err := e2ee.DecodeBase64(set.PoolKey)
	if err != nil || len(pool) != e2ee.KeySize {
		return nil, nil, fmt.Errorf("sealed pool key is corrupt")
	}
	keys := map[int64][]byte{}
	for id, b64 := range set.TreeKeys {
		n, err1 := strconv.ParseInt(id, 10, 64)
		k, err2 := e2ee.DecodeBase64(b64)
		if err1 == nil && err2 == nil && len(k) == e2ee.KeySize {
			keys[n] = k
		}
	}
	return keys, pool, nil
}

// sealMaster stores the master key under the master share.
func (m *Manager) sealMaster(ctx context.Context) error {
	m.mu.Lock()
	mshare, local, mk := m.masterShare, m.localKey, append([]byte(nil), m.masterKey...)
	m.mu.Unlock()
	defer clear(mk)
	if len(mk) != e2ee.KeySize {
		return ErrNeedsUnlock
	}
	k, err := deriveKey(mshare, local, "onegy-device-master-v1")
	if err != nil {
		return err
	}
	defer clear(k)
	sealed, nonce, err := e2ee.WrapKey(mk, k)
	if err != nil {
		return err
	}
	return m.db.SetAtRestMaster(ctx, e2ee.EncodeBase64(sealed), e2ee.EncodeBase64(nonce))
}

func (m *Manager) openMaster(ctx context.Context, a *state.Account, mshare, local []byte) ([]byte, error) {
	sealed, nonce, err := m.db.GetAtRestMaster(ctx)
	if err != nil {
		return nil, err
	}
	if sealed == "" {
		return nil, ErrPasswordNeeded
	}
	k, err := deriveKey(mshare, local, "onegy-device-master-v1")
	if err != nil {
		return nil, err
	}
	defer clear(k)
	mk, err := e2ee.UnwrapKeyB64(sealed, nonce, k)
	if err != nil || len(mk) != e2ee.KeySize || keyCheck(mk) != a.KeyCheck {
		return nil, ErrPasswordNeeded
	}
	return mk, nil
}

// hasMasterAtRest reports whether a PIN unlock can bring the master key back
// (only then may a lock wipe it from memory).
func (m *Manager) hasMasterAtRest(ctx context.Context) bool {
	sealed, _, err := m.db.GetAtRestMaster(ctx)
	return err == nil && sealed != ""
}

// TreeKey returns a folder key of the scope set (0 = root).
func (m *Manager) TreeKey(folderID int64) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.treeKeys[folderID]
	return k, ok
}

// SetTreeKeys replaces the scope set's folder keys (computed while unlocked
// from the key tree) and seals it when it changed.
func (m *Manager) SetTreeKeys(ctx context.Context, keys map[int64][]byte) error {
	m.mu.Lock()
	same := len(keys) == len(m.treeKeys)
	for id, k := range keys {
		if old, ok := m.treeKeys[id]; !ok || string(old) != string(k) {
			same = false
		}
	}
	if !same {
		m.treeKeys = keys
	}
	ready := m.share != nil && m.localKey != nil && m.poolKey != nil
	m.mu.Unlock()
	if same || !ready {
		return nil
	}
	return m.sealScope(ctx)
}

// NewKey returns a fresh key wrapped with the master key, or a pre-made one
// from the pool while the app is locked (ErrNeedsUnlock when it ran out).
func (m *Manager) NewKey(ctx context.Context) (*NewKey, error) {
	m.mu.Lock()
	mk, pool, open := append([]byte(nil), m.masterKey...), m.poolKey, m.keysOpen
	m.mu.Unlock()
	defer clear(mk)
	if !open {
		return nil, ErrLocked
	}
	if len(mk) == e2ee.KeySize {
		key, err := e2ee.RandomBytes(e2ee.KeySize)
		if err != nil {
			return nil, err
		}
		w, n, err := e2ee.WrapKey(key, mk)
		if err != nil {
			return nil, err
		}
		return &NewKey{Key: key, Wrap: e2ee.EncodeBase64(w), Nonce: e2ee.EncodeBase64(n)}, nil
	}
	if pool == nil {
		return nil, ErrNeedsUnlock
	}
	p, err := m.db.PoolTake(ctx)
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, ErrNeedsUnlock
	}
	key, err := e2ee.UnwrapKeyB64(p.SealedKey, p.SealedNonce, pool)
	if err != nil {
		return nil, fmt.Errorf("pooled key does not open: %w", err)
	}
	return &NewKey{Key: key, Wrap: p.MasterWrap, Nonce: p.MasterNonce}, nil
}

// FillPool tops the pool up to poolTarget keys (needs the master key).
func (m *Manager) FillPool(ctx context.Context) error {
	m.mu.Lock()
	mk, pool := append([]byte(nil), m.masterKey...), m.poolKey
	m.mu.Unlock()
	defer clear(mk)
	if len(mk) != e2ee.KeySize || pool == nil {
		return nil
	}
	have, err := m.db.PoolCount(ctx)
	if err != nil || have >= poolTarget/2 {
		return err
	}
	batch := make([]state.PoolKey, 0, poolTarget-have)
	for i := have; i < poolTarget; i++ {
		key, err := e2ee.RandomBytes(e2ee.KeySize)
		if err != nil {
			return err
		}
		sk, sn, err := e2ee.WrapKey(key, pool)
		if err != nil {
			return err
		}
		mw, mn, err := e2ee.WrapKey(key, mk)
		clear(key)
		if err != nil {
			return err
		}
		batch = append(batch, state.PoolKey{SealedKey: e2ee.EncodeBase64(sk), SealedNonce: e2ee.EncodeBase64(sn),
			MasterWrap: e2ee.EncodeBase64(mw), MasterNonce: e2ee.EncodeBase64(mn)})
	}
	return m.db.PoolAdd(ctx, batch)
}
