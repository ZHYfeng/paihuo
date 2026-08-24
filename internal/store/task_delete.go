package store

import "database/sql"

func (s *Store) DeleteTask(id int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	deleting := make(map[int64]bool)
	if err := collectTaskTreeIDs(tx, id, deleting); err != nil {
		return err
	}
	if len(deleting) == 0 {
		return sql.ErrNoRows
	}
	if err := unlinkTaskDependencies(tx, deleting); err != nil {
		return err
	}
	if err := unlinkTaskSessionReferences(tx, deleting); err != nil {
		return err
	}
	if err := deleteTaskTree(tx, id); err != nil {
		return err
	}
	return tx.Commit()
}

// collectTaskTreeIDs 收集级联删除的任务树。依赖关系不是父子关系，只有
// parent_id/merge_of 指向的任务才会随根任务一起删除。
func collectTaskTreeIDs(tx *sql.Tx, id int64, seen map[int64]bool) error {
	if seen[id] {
		return nil
	}
	var exists int
	if err := tx.QueryRow("SELECT 1 FROM tasks WHERE id=?", id).Scan(&exists); err == sql.ErrNoRows {
		return nil
	} else if err != nil {
		return err
	}
	seen[id] = true
	rows, err := tx.Query("SELECT id FROM tasks WHERE parent_id=? OR merge_of=? ORDER BY id", id, id)
	if err != nil {
		return err
	}
	children := make([]int64, 0)
	for rows.Next() {
		var childID int64
		if err := rows.Scan(&childID); err != nil {
			return err
		}
		children = append(children, childID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, childID := range children {
		if err := collectTaskTreeIDs(tx, childID, seen); err != nil {
			return err
		}
	}
	return nil
}

// unlinkTaskSessionReferences 先解除交付 Session 对删除树的回链。Application
// 已在事务前保存受影响 Session id，提交后仍可把它们清理为 deleted；这里负责
// 保证删除 Task 与解除外键引用属于同一个持久化事务。
func unlinkTaskSessionReferences(tx *sql.Tx, deleting map[int64]bool) error {
	now := Now()
	for taskID := range deleting {
		if _, err := tx.Exec(`UPDATE tasks
			SET session_id=NULL, updated_at=?, revision=revision+1
			WHERE session_id=?`, now, taskID); err != nil {
			return err
		}
	}
	return nil
}

// dependencyReplacement 找到 sourceID 被删除后仍可保留的最近前置任务。
// 这样删除链中间的任务时，后续弱依赖仍会等待更早的任务，而不是被
// 意外变成可立即执行的独立任务。
func dependencyReplacement(tx *sql.Tx, sourceID int64, deleting map[int64]bool) (*int64, error) {
	seen := make(map[int64]bool)
	current := sourceID
	for {
		if seen[current] {
			return nil, nil
		}
		seen[current] = true
		var dependsOn sql.NullInt64
		var mode string
		err := tx.QueryRow("SELECT depends_on, dependency_mode FROM tasks WHERE id=?", current).Scan(&dependsOn, &mode)
		if err == sql.ErrNoRows {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if !dependsOn.Valid || mode == DependencyNone || mode == "" {
			return nil, nil
		}
		candidate := dependsOn.Int64
		if !deleting[candidate] {
			return &candidate, nil
		}
		current = candidate
	}
}

// unlinkTaskDependencies 在删除事务内解除外部任务对删除树的引用。弱依赖
// 可以安全跳过已删除前置；强依赖必须先由调用方处理。
func unlinkTaskDependencies(tx *sql.Tx, deleting map[int64]bool) error {
	now := Now()
	for sourceID := range deleting {
		rows, err := tx.Query("SELECT id, dependency_mode FROM tasks WHERE depends_on=?", sourceID)
		if err != nil {
			return err
		}
		dependents := make([]struct {
			id   int64
			mode string
		}, 0)
		for rows.Next() {
			var dependent struct {
				id   int64
				mode string
			}
			if err := rows.Scan(&dependent.id, &dependent.mode); err != nil {
				rows.Close()
				return err
			}
			dependents = append(dependents, dependent)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for _, dependent := range dependents {
			if deleting[dependent.id] {
				continue
			}
			if dependent.mode == DependencyStrong {
				return &TaskDependencyError{DependentID: dependent.id, SourceID: sourceID}
			}
			replacement, err := dependencyReplacement(tx, sourceID, deleting)
			if err != nil {
				return err
			}
			var value any
			if replacement != nil {
				value = *replacement
			}
			if _, err := tx.Exec("UPDATE tasks SET depends_on=?, updated_at=?, revision=revision+1 WHERE id=?", value, now, dependent.id); err != nil {
				return err
			}
		}
	}
	return nil
}

// ListTaskDeletionOrder 返回删除 root 时须一并清理的任务，按叶子到根的
// 顺序排列。merge_of 是自动合并任务的显式父子关系，也参与级联清理。
func (s *Store) ListTaskDeletionOrder(rootID int64) ([]Task, error) {
	root, err := s.GetTask(rootID)
	if err == sql.ErrNoRows {
		return []Task{}, nil
	}
	if err != nil {
		return nil, err
	}
	seen := make(map[int64]bool)
	out := make([]Task, 0, 1)
	var visit func(Task) error
	visit = func(tk Task) error {
		if seen[tk.ID] {
			return nil
		}
		seen[tk.ID] = true
		children, err := s.listTaskDeletionChildren(tk.ID)
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := visit(child); err != nil {
				return err
			}
		}
		out = append(out, tk)
		return nil
	}
	if err := visit(*root); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) listTaskDeletionChildren(parentID int64) ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskCols+taskFrom+" WHERE t.parent_id=? OR t.merge_of=? OR t.parent_session_id=? OR t.parent_task_id=? ORDER BY t.created_at, t.id", parentID, parentID, parentID, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	children := make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		children = append(children, tk)
	}
	return children, rows.Err()
}

func deleteTaskTree(tx *sql.Tx, id int64) error {
	rows, err := tx.Query("SELECT id FROM tasks WHERE parent_id=? OR merge_of=? OR parent_session_id=? OR parent_task_id=? ORDER BY id", id, id, id, id)
	if err != nil {
		return err
	}
	children := make([]int64, 0)
	for rows.Next() {
		var childID int64
		if err := rows.Scan(&childID); err != nil {
			rows.Close()
			return err
		}
		children = append(children, childID)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, childID := range children {
		if err := deleteTaskTree(tx, childID); err != nil {
			return err
		}
	}
	res, err := tx.Exec("DELETE FROM tasks WHERE id=?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return sql.ErrNoRows
	}
	return nil
}
