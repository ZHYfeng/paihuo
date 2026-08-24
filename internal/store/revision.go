package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ---------------------------------------------------------------------------
// 通用更新

func updateOne(db *sql.DB, table string, id int64, set map[string]any) error {
	return updateOneExecer(db, table, id, set)
}

func updateOneExecer(execer sqlExecer, table string, id int64, set map[string]any) error {
	if len(set) == 0 {
		return nil
	}
	cols := make([]string, 0, len(set))
	// cap 只取 len(set)：更新语句还会追加 updated_at / id 两个参数，若直接写
	// len(set)+1 会在极端长度下存在整数溢出风险，多出的元素交给 append 扩容。
	vals := make([]any, 0, len(set))
	for k, v := range set {
		cols = append(cols, k+"=?")
		vals = append(vals, v)
	}
	vals = append(vals, Now(), id)
	q := fmt.Sprintf("UPDATE %s SET %s, updated_at=?, revision=revision+1 WHERE id=?", table, strings.Join(cols, ", "))
	_, err := execer.Exec(q, vals...)
	return err
}

var ErrRevisionConflict = errors.New("资源已被其他操作修改")

// UpdateAtRevision is the browser/application mutation seam. Internal state
// machines may use their stronger status predicates; user edits must match the
// resource revision they read and can never silently overwrite newer state.
func (s *Store) UpdateAtRevision(resource string, id, expected int64, set map[string]any) error {
	table, hasUpdatedAt := revisionTable(resource)
	if table == "" || expected < 1 || len(set) == 0 {
		return ErrRevisionConflict
	}
	if resource == "role" {
		if config, ok := set["role_config"]; ok {
			encoded, err := json.Marshal(config)
			if err != nil {
				return err
			}
			set["role_config"] = string(encoded)
		}
	}
	setLen := len(set)
	cols := make([]string, 0, setLen)
	// cap 只取 len(set)：后续 updated_at / revision / id / expected 均由 append
	// 追加，避免 len(set)+N 的加法在极端长度下整数溢出（code-scanning #36）。
	vals := make([]any, 0, setLen)
	for key, value := range set {
		cols = append(cols, key+"=?")
		vals = append(vals, value)
	}
	if hasUpdatedAt {
		cols = append(cols, "updated_at=?")
		vals = append(vals, Now())
	}
	cols = append(cols, "revision=revision+1")
	vals = append(vals, id, expected)
	res, err := s.db.Exec(fmt.Sprintf("UPDATE %s SET %s WHERE id=? AND revision=?", table, strings.Join(cols, ", ")), vals...)
	if err != nil {
		return err
	}
	changed, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return ErrRevisionConflict
	}
	return nil
}

// TaskDependencyUpdateError is returned when a user edit would violate the
// ordinary-task dependency invariants. It lets the HTTP layer report a useful
// 400 instead of treating a bad dependency selection as a storage failure.
func (s *Store) AssertRevision(resource string, id, expected int64) error {
	table, _ := revisionTable(resource)
	if table == "" || expected < 1 {
		return ErrRevisionConflict
	}
	var actual int64
	if err := s.db.QueryRow("SELECT revision FROM "+table+" WHERE id=?", id).Scan(&actual); err != nil {
		return err
	}
	if actual != expected {
		return ErrRevisionConflict
	}
	return nil
}

func revisionTable(resource string) (string, bool) {
	switch resource {
	case "role":
		return "roles", true
	case "task":
		return "tasks", true
	case "project":
		return "projects", true
	default:
		return "", false
	}
}

func nullInt64(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullStrPtr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullIntPtr(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func strPtr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

// scanner 抽象 *sql.Row 与 *sql.Rows 的共同读取接口。
type scanner interface {
	Scan(dest ...any) error
}

// ---------------------------------------------------------------------------
type sqlExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}
