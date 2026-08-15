package store

import "database/sql"

type IdempotencyRecord struct {
	Key        string
	Method     string
	Path       string
	StatusCode int
	Body       []byte
	CreatedAt  string
}

// ReserveIdempotency atomically elects one request as owner. A zero status in
// an existing record means that owner is still executing.
func (s *Store) ReserveIdempotency(key, method, path string) (record IdempotencyRecord, owner bool, err error) {
	now := Now()
	res, err := s.db.Exec(`INSERT OR IGNORE INTO idempotency_records(key, method, path, status_code, body, created_at)
		VALUES(?, ?, ?, 0, X'', ?)`, key, method, path, now)
	if err != nil {
		return record, false, err
	}
	inserted, err := res.RowsAffected()
	if err != nil {
		return record, false, err
	}
	if inserted == 1 {
		return IdempotencyRecord{Key: key, Method: method, Path: path, CreatedAt: now}, true, nil
	}
	err = s.db.QueryRow(`SELECT key, method, path, status_code, body, created_at
		FROM idempotency_records WHERE key=? AND method=? AND path=?`, key, method, path).
		Scan(&record.Key, &record.Method, &record.Path, &record.StatusCode, &record.Body, &record.CreatedAt)
	if err == sql.ErrNoRows {
		return record, false, err
	}
	return record, false, err
}

// CompleteIdempotency 记录首次完成的响应。body 以 string 绑定：空 body 的
// 204 响应会得到空切片，[]byte 绑定会被 go-sqlite3 当成 NULL 而违反
// body NOT NULL 约束，string 绑定总是非 NULL。
func (s *Store) CompleteIdempotency(key, method, path string, status int, body []byte) error {
	_, err := s.db.Exec(`UPDATE idempotency_records SET status_code=?, body=?
		WHERE key=? AND method=? AND path=? AND status_code=0`, status, string(body), key, method, path)
	return err
}
