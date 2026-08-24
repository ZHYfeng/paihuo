package store

import "database/sql"

// ---------------------------------------------------------------------------
// 会话（Session）

// ---------------------------------------------------------------------------
// 会话（type=session 的任务；生命周期由 internal/session 管理）

// CreateSessionTask 创建会话任务记录。projectID 可为 nil（无项目）。roleID 必须存在。
func (s *Store) CreateSessionTask(ss Task) (int64, error) {
	if ss.Type == "" {
		ss.Type = TaskTypeSession
	}
	if ss.Status == "" {
		ss.Status = SessionStatusCreated
	}
	return s.CreateTask(ss)
}

// ListSessionTasks 列出会话任务实例（默认不含 deleted 与定时定义——定时
// 定义只需在定时页管理；status 空 = 全部非删除）。排序与会话页一致：最近消息优先。
func (s *Store) ListSessionTasks(projectID *int64, roleID *int64, status string, includeDeleted bool) ([]Task, error) {
	q := "SELECT " + taskColsBrief + taskFrom + " WHERE t.type='session' AND t.cron=''"
	args := []any{}
	if projectID != nil {
		q += " AND t.project_id=?"
		args = append(args, *projectID)
	}
	if roleID != nil {
		q += " AND t.role_id=?"
		args = append(args, *roleID)
	}
	if status != "" {
		q += " AND t.status=?"
		args = append(args, status)
	} else if !includeDeleted {
		q += " AND t.status<>'deleted'"
	}
	q += " ORDER BY COALESCE(NULLIF(t.last_message_at,''), t.created_at) DESC, t.id DESC"
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Task, 0) // 空列表返回 [] 而非 null（前端 .length 直接可用）
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tk)
	}
	return out, rows.Err()
}

// GetSessionTask 返回单个会话任务；不存在时返回 (nil, nil)。
func (s *Store) GetSessionTask(id int64) (*Task, error) {
	tk, err := s.GetTask(id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return tk, nil
}

// ListSessionsForTask 返回引用了指定收编任务（tasks.session_id=taskID）的
// 会话任务 id（删除收编任务时联动清理其交付会话）。
func (s *Store) ListSessionsForTask(taskID int64) ([]int64, error) {
	rows, err := s.db.Query("SELECT id FROM tasks WHERE session_id=?", taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
