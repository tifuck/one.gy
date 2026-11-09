package state

import (
	"context"
	"database/sql"
	"errors"
)

// Account is the single signed-in (or last signed-in) account row.
// SealedSecrets is AES-GCM ciphertext under the password-derived wrapping key;
// plaintext secrets never touch this table.
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
}

const accountCols = `server_url, user_id, username, device_id, device_name, signed_in, remote_cursor, key_check, auth_salt, sealed_secrets, sealed_nonce`

// GetAccount returns nil, nil when no account row exists.
func (s *DB) GetAccount(ctx context.Context) (*Account, error) {
	var a Account
	var cursor sql.NullInt64
	err := s.QueryRowContext(ctx, `SELECT `+accountCols+` FROM account WHERE id = 1`).Scan(
		&a.ServerURL, &a.UserID, &a.Username, &a.DeviceID, &a.DeviceName, &a.SignedIn, &cursor,
		&a.KeyCheck, &a.AuthSalt, &a.SealedSecrets, &a.SealedNonce)
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
	_, err := s.ExecContext(ctx, `INSERT OR REPLACE INTO account (id, `+accountCols+`) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ServerURL, a.UserID, a.Username, a.DeviceID, a.DeviceName, a.SignedIn, a.RemoteCursor,
		a.KeyCheck, a.AuthSalt, a.SealedSecrets, a.SealedNonce)
	return err
}

// SignOutAccount keeps server and username (to pre-fill the next sign-in) and
// drops everything tied to the device: identity, sealed secrets and the
// remote cache.
func (s *DB) SignOutAccount(ctx context.Context) error {
	return s.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE account SET signed_in = 0, device_id = '', device_name = '', user_id = 0,
			remote_cursor = NULL, key_check = '', auth_salt = '', sealed_secrets = '', sealed_nonce = ''`); err != nil {
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
