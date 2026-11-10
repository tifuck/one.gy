package state

import (
	"context"
	"database/sql"
	"errors"
)

// Account is the single signed-in (or last signed-in) account row.
// SealedSecrets is AES-GCM ciphertext under the password-derived wrapping key;
// AtRestSealed is the master key under the at-rest key (server share + local
// key [+ PIN key]). Plaintext secrets never touch this table.
type Account struct {
	ServerURL     string
	UserID        int64
	Username      string
	DeviceID      string
	DeviceName    string
	SignedIn      bool
	RemoteCursor  *int64 // nil until the first remote snapshot completes
	KeyCheck      string // hex SHA-256 of the master key
	AuthSalt      string
	SealedSecrets string
	SealedNonce   string
	AtRestSealed  string
	AtRestNonce   string
	AtRestPIN     bool
}

const accountCols = `server_url, user_id, username, device_id, device_name, signed_in, remote_cursor, key_check, auth_salt, sealed_secrets, sealed_nonce, at_rest_sealed, at_rest_nonce, at_rest_pin`

// GetAccount returns nil, nil when no account row exists.
func (s *DB) GetAccount(ctx context.Context) (*Account, error) {
	var a Account
	var cursor sql.NullInt64
	err := s.QueryRowContext(ctx, `SELECT `+accountCols+` FROM account WHERE id = 1`).Scan(
		&a.ServerURL, &a.UserID, &a.Username, &a.DeviceID, &a.DeviceName, &a.SignedIn, &cursor,
		&a.KeyCheck, &a.AuthSalt, &a.SealedSecrets, &a.SealedNonce, &a.AtRestSealed, &a.AtRestNonce, &a.AtRestPIN)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if cursor.Valid {
		a.RemoteCursor = &cursor.Int64
	}
	return &a, nil
}

// PutAccount replaces the account row.
func (s *DB) PutAccount(ctx context.Context, a *Account) error {
	_, err := s.ExecContext(ctx, `INSERT OR REPLACE INTO account (id, `+accountCols+`) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ServerURL, a.UserID, a.Username, a.DeviceID, a.DeviceName, a.SignedIn, a.RemoteCursor,
		a.KeyCheck, a.AuthSalt, a.SealedSecrets, a.SealedNonce, a.AtRestSealed, a.AtRestNonce, a.AtRestPIN)
	return err
}

// SetAtRest stores the at-rest sealed master key.
func (s *DB) SetAtRest(ctx context.Context, sealed, nonce string, pin bool) error {
	_, err := s.ExecContext(ctx, `UPDATE account SET at_rest_sealed = ?, at_rest_nonce = ?, at_rest_pin = ? WHERE id = 1`, sealed, nonce, pin)
	return err
}

// SignOutAccount keeps server and username (to pre-fill the next sign-in) and
// drops everything tied to the device: identity, sealed secrets and the
// remote cache.
func (s *DB) SignOutAccount(ctx context.Context) error {
	return s.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE account SET signed_in = 0, device_id = '', device_name = '', user_id = 0,
			remote_cursor = NULL, key_check = '', auth_salt = '', sealed_secrets = '', sealed_nonce = '',
			at_rest_sealed = '', at_rest_nonce = '', at_rest_pin = 0, at_rest_master = '', at_rest_master_nonce = ''`); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM key_pool`); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM remote_node`)
		return err
	})
}

// SetRemoteCursor records the change-feed position (nil = resnapshot needed).
func SetRemoteCursor(tx *sql.Tx, cursor *int64) error {
	_, err := tx.Exec(`UPDATE account SET remote_cursor = ? WHERE id = 1`, cursor)
	return err
}

// SetAtRestMaster stores the master key sealed under the master share.
func (s *DB) SetAtRestMaster(ctx context.Context, sealed, nonce string) error {
	_, err := s.ExecContext(ctx, `UPDATE account SET at_rest_master = ?, at_rest_master_nonce = ? WHERE id = 1`, sealed, nonce)
	return err
}

// GetAtRestMaster returns the sealed master key ("" when there is none).
func (s *DB) GetAtRestMaster(ctx context.Context) (sealed, nonce string, err error) {
	err = s.QueryRowContext(ctx, `SELECT at_rest_master, at_rest_master_nonce FROM account WHERE id = 1`).Scan(&sealed, &nonce)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return sealed, nonce, err
}

// PoolKey is one pre-made key: sealed for this device, wrapped for the account.
type PoolKey struct {
	ID                      int64
	SealedKey, SealedNonce  string
	MasterWrap, MasterNonce string
}

// PoolCount returns how many pre-made keys are left.
func (s *DB) PoolCount(ctx context.Context) (n int, err error) {
	err = s.QueryRowContext(ctx, `SELECT COUNT(*) FROM key_pool`).Scan(&n)
	return n, err
}

// PoolAdd stores pre-made keys.
func (s *DB) PoolAdd(ctx context.Context, keys []PoolKey) error {
	return s.Tx(ctx, func(tx *sql.Tx) error {
		for _, k := range keys {
			if _, err := tx.Exec(`INSERT INTO key_pool (sealed_key, sealed_nonce, master_wrap, master_nonce) VALUES (?, ?, ?, ?)`,
				k.SealedKey, k.SealedNonce, k.MasterWrap, k.MasterNonce); err != nil {
				return err
			}
		}
		return nil
	})
}

// PoolTake removes and returns one pre-made key (nil when the pool is empty):
// a key is never handed out twice, even across a crash.
func (s *DB) PoolTake(ctx context.Context) (*PoolKey, error) {
	var k *PoolKey
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		var p PoolKey
		err := tx.QueryRow(`SELECT id, sealed_key, sealed_nonce, master_wrap, master_nonce FROM key_pool ORDER BY id LIMIT 1`).
			Scan(&p.ID, &p.SealedKey, &p.SealedNonce, &p.MasterWrap, &p.MasterNonce)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM key_pool WHERE id = ?`, p.ID); err != nil {
			return err
		}
		k = &p
		return nil
	})
	return k, err
}

// PoolClear drops every pre-made key (sign-out, or the device's pool key changed).
func (s *DB) PoolClear(ctx context.Context) error {
	_, err := s.ExecContext(ctx, `DELETE FROM key_pool`)
	return err
}

// SetSealedSecrets stores the password-sealed copy of the secrets.
func (s *DB) SetSealedSecrets(ctx context.Context, sealed, nonce string) error {
	_, err := s.ExecContext(ctx, `UPDATE account SET sealed_secrets = ?, sealed_nonce = ? WHERE id = 1`, sealed, nonce)
	return err
}
