package store

import (
	"database/sql"

	"paihuo/internal/artifact"
)

func (s *Store) CreateArtifact(item artifact.Metadata) (*artifact.Metadata, error) {
	created := Now()
	if item.Retention == "" {
		item.Retention = "default"
	}
	result, err := s.db.Exec(`INSERT INTO artifacts
		(task_id, run_id, name, media_type, content_hash, size, locator, created_by, retention, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, item.TaskID, item.RunID, item.Name, item.MediaType, item.ContentHash, item.Size, item.Locator, item.CreatedBy, item.Retention, created)
	if err != nil {
		return nil, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	return s.GetArtifact(id)
}

func (s *Store) GetArtifact(id int64) (*artifact.Metadata, error) {
	var item artifact.Metadata
	err := s.db.QueryRow(`SELECT id, task_id, run_id, name, media_type, content_hash, size, locator, created_by, retention, created_at FROM artifacts WHERE id=?`, id).Scan(
		&item.ID, &item.TaskID, &item.RunID, &item.Name, &item.MediaType, &item.ContentHash, &item.Size, &item.Locator, &item.CreatedBy, &item.Retention, &item.CreatedAt)
	return &item, err
}

func (s *Store) ListArtifacts(taskID, runID *int64) ([]artifact.Metadata, error) {
	query := `SELECT id, task_id, run_id, name, media_type, content_hash, size, locator, created_by, retention, created_at FROM artifacts WHERE 1=1`
	args := []any{}
	if taskID != nil {
		query += " AND task_id=?"
		args = append(args, *taskID)
	}
	if runID != nil {
		query += " AND run_id=?"
		args = append(args, *runID)
	}
	query += " ORDER BY id DESC LIMIT 500"
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []artifact.Metadata{}
	for rows.Next() {
		var item artifact.Metadata
		if err := rows.Scan(&item.ID, &item.TaskID, &item.RunID, &item.Name, &item.MediaType, &item.ContentHash, &item.Size, &item.Locator, &item.CreatedBy, &item.Retention, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) DeleteArtifact(id int64) error {
	result, err := s.db.Exec("DELETE FROM artifacts WHERE id=?", id)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) CountArtifactsByLocator(locator string) (int, error) {
	var count int
	err := s.db.QueryRow("SELECT COUNT(*) FROM artifacts WHERE locator=?", locator).Scan(&count)
	return count, err
}
