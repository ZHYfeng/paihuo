package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

type TaskDependencyUpdateError struct {
	Message string
}

func (e *TaskDependencyUpdateError) Error() string { return e.Message }

// UpdateTaskAtRevision applies a browser task edit that may also change the
// ordinary task's delivery dependency. Dependency validation and the revision
// check share one transaction so a stale or invalid edit cannot leave a half-
// updated task behind.
func (s *Store) UpdateTaskAtRevision(id, expected int64, set map[string]any) error {
	_, changesDependency := set["dependency_mode"]
	_, changesTarget := set["depends_on"]
	if !changesDependency && !changesTarget {
		return s.UpdateAtRevision("task", id, expected, set)
	}
	if expected < 1 || len(set) == 0 {
		return ErrRevisionConflict
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var taskType, currentMode, cron string
	var currentProject, mergeOf, currentDependsOn sql.NullInt64
	var currentRevision int64
	if err := tx.QueryRow(`SELECT type, project_id, merge_of, dependency_mode,
		depends_on, cron, revision FROM tasks WHERE id=?`, id).Scan(
		&taskType, &currentProject, &mergeOf, &currentMode, &currentDependsOn,
		&cron, &currentRevision); err != nil {
		if err == sql.ErrNoRows {
			return ErrRevisionConflict
		}
		return err
	}
	if currentRevision != expected {
		return ErrRevisionConflict
	}
	if mergeOf.Valid {
		return &TaskDependencyUpdateError{Message: "代码合并任务不能修改前置交付"}
	}
	if taskType != TaskTypeTask {
		return &TaskDependencyUpdateError{Message: "只有普通任务可以修改前置交付"}
	}
	if cron != "" {
		return &TaskDependencyUpdateError{Message: "定时定义不能设置前置交付"}
	}

	projectID := int64(0)
	if currentProject.Valid {
		projectID = currentProject.Int64
	}
	if value, ok := set["project_id"]; ok {
		switch v := value.(type) {
		case nil:
			projectID = 0
		case int64:
			if v <= 0 {
				return &TaskDependencyUpdateError{Message: "project_id 非法"}
			}
			projectID = v
		case int:
			if v <= 0 {
				return &TaskDependencyUpdateError{Message: "project_id 非法"}
			}
			projectID = int64(v)
		default:
			return &TaskDependencyUpdateError{Message: "project_id 非法"}
		}
	}

	mode := currentMode
	if mode == "" {
		if currentDependsOn.Valid {
			mode = DependencyStrong
		} else {
			mode = DependencyNone
		}
	}
	if value, ok := set["dependency_mode"]; ok {
		var valid bool
		mode, valid = value.(string)
		if !valid || !validDependencyMode(mode) {
			return &TaskDependencyUpdateError{Message: "非法依赖模式"}
		}
	}

	var target *int64
	if currentDependsOn.Valid {
		value := currentDependsOn.Int64
		target = &value
	}
	if value, ok := set["depends_on"]; ok {
		switch v := value.(type) {
		case nil:
			target = nil
		case int64:
			if v <= 0 {
				return &TaskDependencyUpdateError{Message: "前置任务 ID 非法"}
			}
			target = &v
		case int:
			if v <= 0 {
				return &TaskDependencyUpdateError{Message: "前置任务 ID 非法"}
			}
			converted := int64(v)
			target = &converted
		default:
			return &TaskDependencyUpdateError{Message: "前置任务 ID 非法"}
		}
	}

	switch mode {
	case DependencyNone:
		target = nil
	case DependencyWeak:
		if projectID == 0 {
			return &TaskDependencyUpdateError{Message: "无项目任务不能使用自动前置依赖"}
		}
		if changesTarget && target != nil {
			return &TaskDependencyUpdateError{Message: "自动顺序不能指定固定前置任务"}
		}
		target, err = previousProjectTask(tx, projectID, id)
		if err != nil {
			return err
		}
	case DependencyStrong:
		if projectID == 0 {
			return &TaskDependencyUpdateError{Message: "明确前置依赖只能用于项目任务"}
		}
		if target == nil {
			return &TaskDependencyUpdateError{Message: "明确依赖必须指定前置任务"}
		}
		if err := validateDependencyTarget(tx, projectID, *target); err != nil {
			return &TaskDependencyUpdateError{Message: err.Error()}
		}
		if *target == id {
			return &TaskDependencyUpdateError{Message: "任务不能以前置任务自身"}
		}
		cycle, err := dependencyReaches(tx, *target, id)
		if err != nil {
			return err
		}
		if cycle {
			return &TaskDependencyUpdateError{Message: "前置依赖会形成循环"}
		}
	}

	updated := make(map[string]any, len(set)+2)
	for key, value := range set {
		updated[key] = value
	}
	updated["dependency_mode"] = mode
	updated["depends_on"] = nullInt64(target)
	cols := make([]string, 0, len(updated)+2)
	values := make([]any, 0, len(updated)+2)
	for key, value := range updated {
		cols = append(cols, key+"=?")
		values = append(values, value)
	}
	values = append(values, Now(), id, expected)
	cols = append(cols, "updated_at=?", "revision=revision+1")
	result, err := tx.Exec(fmt.Sprintf("UPDATE tasks SET %s WHERE id=? AND revision=?", strings.Join(cols, ", ")), values...)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return ErrRevisionConflict
	}
	if projectID > 0 {
		if err := validateProjectDependencyGraph(tx, projectID); err != nil {
			return &TaskDependencyUpdateError{Message: err.Error()}
		}
	}
	return tx.Commit()
}

func previousProjectTask(tx *sql.Tx, projectID, taskID int64) (*int64, error) {
	rows, err := tx.Query(`SELECT id FROM tasks
		WHERE project_id=? AND merge_of IS NULL AND cron='' ORDER BY
		CASE WHEN sort_order > 0 THEN sort_order ELSE 9223372036854775807 END,
		created_at, id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var previous *int64
	for rows.Next() {
		var candidate int64
		if err := rows.Scan(&candidate); err != nil {
			return nil, err
		}
		if candidate == taskID {
			return previous, nil
		}
		value := candidate
		previous = &value
	}
	return previous, rows.Err()
}

func dependencyReaches(tx *sql.Tx, start, wanted int64) (bool, error) {
	seen := map[int64]bool{}
	current := start
	for current > 0 {
		if current == wanted {
			return true, nil
		}
		if seen[current] {
			return false, nil
		}
		seen[current] = true
		var next sql.NullInt64
		err := tx.QueryRow("SELECT depends_on FROM tasks WHERE id=?", current).Scan(&next)
		if err == sql.ErrNoRows {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !next.Valid {
			return false, nil
		}
		current = next.Int64
	}
	return false, nil
}
func (s *Store) UpdateTask(id int64, set map[string]any) error {
	projectValue, changesProject := set["project_id"]
	if !changesProject {
		return updateOne(s.db, "tasks", id, set)
	}

	var targetProject sql.NullInt64
	switch v := projectValue.(type) {
	case nil:
	case int64:
		if v <= 0 {
			return errors.New("project_id 非法")
		}
		targetProject = sql.NullInt64{Int64: v, Valid: true}
	case int:
		if v <= 0 {
			return errors.New("project_id 非法")
		}
		targetProject = sql.NullInt64{Int64: int64(v), Valid: true}
	default:
		return errors.New("project_id 非法")
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var currentProject, mergeOf sql.NullInt64
	var currentSortOrder int64
	if err := tx.QueryRow("SELECT project_id, merge_of, sort_order FROM tasks WHERE id=?", id).
		Scan(&currentProject, &mergeOf, &currentSortOrder); err != nil {
		return err
	}

	updated := make(map[string]any, len(set))
	for key, value := range set {
		updated[key] = value
	}
	sameProject := currentProject.Valid == targetProject.Valid &&
		(!currentProject.Valid || currentProject.Int64 == targetProject.Int64)
	if !targetProject.Valid || mergeOf.Valid {
		updated["sort_order"] = int64(0)
	} else if !sameProject || currentSortOrder <= 0 {
		var next int64
		if err := tx.QueryRow(`SELECT COALESCE(MAX(sort_order), 0) + 1
			FROM tasks WHERE project_id=? AND merge_of IS NULL`, targetProject.Int64).Scan(&next); err != nil {
			return err
		}
		if next < 1 {
			next = 1
		}
		updated["sort_order"] = next
	}
	if err := updateOneExecer(tx, "tasks", id, updated); err != nil {
		return err
	}
	return tx.Commit()
}

// ReorderProjectTasks changes only queued implementation tasks in one project.
// Their existing order slots are reused so completed/running tasks stay in
// their historical positions.  The caller must provide every currently queued
// implementation task exactly once; this makes stale drag-and-drop requests
// fail safely instead of silently losing a task from the order.
func (s *Store) ReorderProjectTasks(projectID int64, orderedIDs []int64) error {
	if projectID <= 0 {
		return errors.New("项目 ID 非法")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists bool
	if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)", projectID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errors.New("项目不存在")
	}

	type reorderTask struct {
		id             int64
		status         string
		dependencyMode string
		sortOrder      int64
	}
	rows, err := tx.Query(`SELECT id, status, dependency_mode, sort_order
		FROM tasks
		WHERE project_id=? AND merge_of IS NULL AND cron=''
		ORDER BY CASE WHEN sort_order > 0 THEN sort_order ELSE 9223372036854775807 END,
			created_at, id`, projectID)
	if err != nil {
		return err
	}
	all := make([]reorderTask, 0)
	for rows.Next() {
		var tk reorderTask
		if err := rows.Scan(&tk.id, &tk.status, &tk.dependencyMode, &tk.sortOrder); err != nil {
			rows.Close()
			return err
		}
		all = append(all, tk)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}

	eligible := make(map[int64]bool)
	positions := make([]int64, 0)
	for i, tk := range all {
		if tk.status != StatusQueued {
			continue
		}
		eligible[tk.id] = true
		position := tk.sortOrder
		if position <= 0 {
			position = int64(i + 1)
		}
		positions = append(positions, position)
	}
	if len(orderedIDs) != len(eligible) {
		return errors.New("排序请求必须包含项目内全部待执行的实现任务")
	}
	seen := make(map[int64]bool, len(orderedIDs))
	for _, id := range orderedIDs {
		if !eligible[id] || seen[id] {
			return errors.New("排序请求只能包含不重复的待执行实现任务")
		}
		seen[id] = true
	}
	now := Now()
	for i, id := range orderedIDs {
		if _, err := tx.Exec(`UPDATE tasks SET sort_order=?, updated_at=?, revision=revision+1
			WHERE id=? AND project_id=? AND merge_of IS NULL AND status=?`, positions[i], now, id, projectID, StatusQueued); err != nil {
			return err
		}
	}
	if err := rebuildQueuedWeakDependencies(tx, projectID, now); err != nil {
		return err
	}
	if err := validateProjectDependencyGraph(tx, projectID); err != nil {
		return err
	}
	return tx.Commit()
}

// rebuildQueuedWeakDependencies keeps the persisted weak-dependency chain in
// step with the visible project order. Strong and independent dependencies are
// user choices and are left untouched. Merge tasks are intentionally excluded.
func rebuildQueuedWeakDependencies(tx *sql.Tx, projectID int64, now string) error {
	rows, err := tx.Query(`SELECT id, status, dependency_mode
		FROM tasks
		WHERE project_id=? AND merge_of IS NULL AND cron=''
		ORDER BY CASE WHEN sort_order > 0 THEN sort_order ELSE 9223372036854775807 END,
			created_at, id`, projectID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var predecessor *int64
	for rows.Next() {
		var id int64
		var status, mode string
		if err := rows.Scan(&id, &status, &mode); err != nil {
			return err
		}
		if status == StatusQueued && mode == DependencyWeak {
			var dependsOn any
			if predecessor != nil {
				dependsOn = *predecessor
			}
			if _, err := tx.Exec(`UPDATE tasks SET depends_on=?, updated_at=?, revision=revision+1
				WHERE id=? AND project_id=? AND merge_of IS NULL AND status=? AND dependency_mode=?`,
				dependsOn, now, id, projectID, StatusQueued, DependencyWeak); err != nil {
				return err
			}
		}
		current := id
		predecessor = &current
	}
	return rows.Err()
}

func validateProjectDependencyGraph(tx *sql.Tx, projectID int64) error {
	rows, err := tx.Query(`SELECT id, depends_on FROM tasks
		WHERE project_id=? AND merge_of IS NULL`, projectID)
	if err != nil {
		return err
	}
	defer rows.Close()
	dependencies := make(map[int64]int64)
	for rows.Next() {
		var id int64
		var dependsOn sql.NullInt64
		if err := rows.Scan(&id, &dependsOn); err != nil {
			return err
		}
		if dependsOn.Valid {
			dependencies[id] = dependsOn.Int64
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	state := make(map[int64]uint8, len(dependencies))
	var visit func(int64) bool
	visit = func(id int64) bool {
		switch state[id] {
		case 1:
			return false
		case 2:
			return true
		}
		state[id] = 1
		if next, ok := dependencies[id]; ok && !visit(next) {
			return false
		}
		state[id] = 2
		return true
	}
	for id := range dependencies {
		if !visit(id) {
			return errors.New("排序请求会形成循环依赖")
		}
	}
	return nil
}

// ResumeTask 原地续跑一个终态任务。任务身份、会话目录和 worktree 都由任务
// ID 绑定，因此不能新建记录；这里只清空本轮执行痕迹并原子地放回队列。
// 返回 false 表示任务已不处于可续跑的终态（例如被另一个请求重新领取）。
func (s *Store) ResumeTask(id int64) (bool, error) {
	now := Now()
	res, err := s.db.Exec(`UPDATE tasks
		SET status='queued', started_at=NULL, finished_at=NULL, error='', exit_code=NULL,
			tmux_log_offset=0, updated_at=?, revision=revision+1
		WHERE id=? AND status IN ('succeeded','failed','cancelled')`, now, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// HasMergeTaskForSource 返回某个普通任务是否已有系统创建的代码合并任务。
// 合并任务通过 merge_of 直接关联源任务，不依赖普通子任务树。
