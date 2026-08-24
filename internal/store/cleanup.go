package store

// ---------------------------------------------------------------------------
// 历史清理

// TaskCleanupResult 是一次历史清理实际删除的任务快照。文件系统资源不在
// SQLite 事务内，因此调用方必须使用 Tasks 在删除后清理 Runtime/worktree；
// 不能只拿删除数量，否则数据库记录消失后就失去定位资源所需的 task id、项目
// 和分支信息。
type TaskCleanupResult struct {
	Deleted  int64
	Locators []string
	Tasks    []Task
}

// CleanupTasks 删除符合条件的任务（级联删除日志）。条件：
//   - roleID 非空：仅该角色的任务
//   - before 非空：仅早于该时间的任务
//
// 只删除终态任务（succeeded/failed/cancelled），进行中的任务不动。返回被删
// 任务快照，供调用方继续清理任务级文件系统资源。
func (s *Store) CleanupTasks(roleID *int64, before string) (TaskCleanupResult, error) {
	// 保留仍被后项引用的记录。否则 SQLite 会拒绝删除，且更重要的是，
	// 清理不能把强依赖悄悄变成“无依赖即可执行”。下次清理会自然处理
	// 已没有后项引用的终态记录。
	selectWhere := "t.status IN ('succeeded','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM tasks d WHERE d.depends_on=t.id)"
	deleteWhere := "status IN ('succeeded','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM tasks d WHERE d.depends_on=tasks.id)"
	args := []any{}
	if roleID != nil {
		selectWhere += " AND t.role_id=?"
		deleteWhere += " AND role_id=?"
		args = append(args, *roleID)
	}
	if before != "" {
		selectWhere += " AND t.created_at < ?"
		deleteWhere += " AND created_at < ?"
		args = append(args, before)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return TaskCleanupResult{}, err
	}
	defer tx.Rollback()

	selectedRows, err := tx.Query("SELECT "+taskColsBrief+taskFrom+" WHERE "+selectWhere+" ORDER BY t.created_at, t.id", args...)
	if err != nil {
		return TaskCleanupResult{}, err
	}
	result := TaskCleanupResult{Tasks: make([]Task, 0)}
	for selectedRows.Next() {
		tk, scanErr := scanTask(selectedRows)
		if scanErr != nil {
			selectedRows.Close()
			return TaskCleanupResult{}, scanErr
		}
		result.Tasks = append(result.Tasks, tk)
	}
	if err := selectedRows.Close(); err != nil {
		return TaskCleanupResult{}, err
	}
	if err := selectedRows.Err(); err != nil {
		return TaskCleanupResult{}, err
	}

	rows, err := tx.Query("SELECT DISTINCT locator FROM artifacts WHERE task_id IN (SELECT t.id FROM tasks t WHERE "+selectWhere+")", args...)
	if err != nil {
		return TaskCleanupResult{}, err
	}
	result.Locators = make([]string, 0)
	for rows.Next() {
		var locator string
		if err := rows.Scan(&locator); err != nil {
			rows.Close()
			return TaskCleanupResult{}, err
		}
		result.Locators = append(result.Locators, locator)
	}
	if err := rows.Close(); err != nil {
		return TaskCleanupResult{}, err
	}
	if err := rows.Err(); err != nil {
		return TaskCleanupResult{}, err
	}

	res, err := tx.Exec("DELETE FROM tasks WHERE "+deleteWhere, args...)
	if err != nil {
		return TaskCleanupResult{}, err
	}
	result.Deleted, _ = res.RowsAffected()
	if err := tx.Commit(); err != nil {
		return TaskCleanupResult{}, err
	}
	return result, nil
}
func (s *Store) ListTasksForCleanup() ([]Task, error) {
	rows, err := s.db.Query("SELECT " + taskColsBrief + taskFrom + " WHERE 1=1")
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
