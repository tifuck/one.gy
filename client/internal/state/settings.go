package state

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// GetJSON decodes settings[key] into v; found is false when the key is unset.
func (s *DB) GetJSON(ctx context.Context, key string, v any) (found bool, err error) {
	var raw string
	err = s.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal([]byte(raw), v)
}

// PutJSON stores v as settings[key].
func (s *DB) PutJSON(ctx context.Context, key string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = s.ExecContext(ctx, `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, key, string(b))
	return err
}
