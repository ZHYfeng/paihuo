package store

import (
	"encoding/json"
	"errors"
)

// Role

const roleCols = `a.id, a.name, a.description, a.runtime_id, a.role_config,
	a.max_concurrency, a.delegation_enabled, a.delegation_max_perm, a.enabled, a.revision, a.created_at, a.updated_at`

func scanRole(rows scanner) (Role, error) {
	var a Role
	var rc string
	var delegationEnabled int64
	err := rows.Scan(&a.ID, &a.Name, &a.Description, &a.RuntimeID, &rc,
		&a.MaxConcurrency, &delegationEnabled, &a.DelegationMaxPerm, &a.Enabled, &a.Revision, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return a, err
	}
	a.DelegationEnabled = delegationEnabled != 0
	if a.DelegationMaxPerm == "" {
		a.DelegationMaxPerm = PermReview
	}
	if rc != "" {
		_ = json.Unmarshal([]byte(rc), &a.RoleConfig)
	}
	a.MaxConcurrency = a.ConcurrencyLimit()
	return a, nil
}

func (s *Store) ListRoles() ([]Role, error) {
	rows, err := s.db.Query("SELECT " + roleCols + " FROM roles a ORDER BY a.id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Role, 0)
	for rows.Next() {
		a, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) GetRole(id int64) (*Role, error) {
	row := s.db.QueryRow("SELECT "+roleCols+" FROM roles a WHERE a.id=?", id)
	a, err := scanRole(row)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) CreateRole(a Role) (int64, error) {
	if a.CreatedAt == "" {
		a.CreatedAt = Now()
	}
	if a.UpdatedAt == "" {
		a.UpdatedAt = a.CreatedAt
	}
	a.MaxConcurrency = a.ConcurrencyLimit()
	rc, err := json.Marshal(a.RoleConfig)
	if err != nil {
		return 0, err
	}
	res, err := s.db.Exec(`INSERT INTO roles (name, description, runtime_id, role_config, max_concurrency, delegation_enabled, delegation_max_perm, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.Name, a.Description, a.RuntimeID, string(rc), a.MaxConcurrency, a.DelegationEnabled, a.DelegationMaxPerm, a.Enabled, a.CreatedAt, a.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateRole(id int64, set map[string]any) error {
	if rc, ok := set["role_config"]; ok {
		b, err := json.Marshal(rc)
		if err != nil {
			return err
		}
		set["role_config"] = string(b)
	}
	return updateOne(s.db, "roles", id, set)
}

func (s *Store) DeleteRole(id int64) error {
	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE role_id=? AND status IN ('queued','claimed','running','awaiting_review')", id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return errors.New("该角色仍有未完成任务，无法删除")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// 历史任务与模板解除指派（保留记录），定时定义任务随角色一并删除
	// （定时定义必须绑定角色，与旧 schedules 表语义一致）。
	if _, err := tx.Exec("UPDATE tasks SET role_id=NULL, updated_at=?, revision=revision+1 WHERE role_id=? AND cron=''", Now(), id); err != nil {
		return err
	}
	if _, err := tx.Exec("UPDATE templates SET role_id=NULL WHERE role_id=?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM tasks WHERE role_id=? AND cron<>''", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM roles WHERE id=?", id); err != nil {
		return err
	}
	return tx.Commit()
}
