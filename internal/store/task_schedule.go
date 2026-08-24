package store

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 定时定义（定时属性已并入 tasks 表：cron 非空 = 定时定义）

// ListScheduledTasks 返回全部定时定义任务（调度器重载用）。
func (s *Store) ListScheduledTasks() ([]Task, error) {
	rows, err := s.db.Query("SELECT " + taskColsBrief + taskFrom + " WHERE t.cron<>'' ORDER BY t.id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tk)
	}
	return out, rows.Err()
}
