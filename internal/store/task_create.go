package store

import (
	"database/sql"
	"errors"
)

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func validDependencyMode(mode string) bool {
	return mode == DependencyNone || mode == DependencyWeak || mode == DependencyStrong
}

func normalizeDependencyMode(t *Task) {
	if t.DependencyMode == "" {
		if t.DependsOn != nil {
			t.DependencyMode = DependencyStrong
		} else {
			t.DependencyMode = DependencyNone
		}
	}
}
func prepareTaskForInsert(t *Task) {
	if t.CreatedAt == "" {
		t.CreatedAt = Now()
	}
	if t.UpdatedAt == "" {
		t.UpdatedAt = t.CreatedAt
	}
	if t.Type == "" {
		t.Type = TaskTypeTask
	}
	if t.RunMode == "" {
		t.RunMode = RunModeBatch
	}
	// 定时定义任务永不参与执行链：不设前置、不排队。
	if t.Cron != "" {
		t.DependencyMode = DependencyNone
		t.DependsOn = nil
		t.RunMode = RunModeBatch
	}
	normalizeDependencyMode(t)
}

func insertTask(execer sqlExecer, t Task) (int64, error) {
	res, err := execer.Exec(`INSERT INTO tasks (type, title, body, status, perm, run_mode, concurrent, role_id, project_id, project_dir, parent_id, depends_on, dependency_mode, block_on_failure, schedule_id, resume_of, merge_of, merge_skipped, session_id, workflow_run_id, parent_session_id, parent_task_id, worktree_branch, base_commit, review_rounds, finished_at, exit_code, sort_order,
		cron, enabled, last_run_at, next_run_at, worktree_path, session_dir, last_message_at, message_count, suspended_at, delivered_at, spec, violations, spec_hash, external_key,
		created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.Type, t.Title, t.Body, t.Status, t.Perm, t.RunMode, boolInt(t.Concurrent), nullInt64(t.RoleID), nullInt64(t.ProjectID), t.ProjectDir,
		nullInt64(t.ParentID), nullInt64(t.DependsOn), t.DependencyMode, boolInt(t.BlockOnFailure), nullInt64(t.ScheduleID), nullInt64(t.ResumeOf), nullInt64(t.MergeOf), boolInt(t.MergeSkipped), nullInt64(t.SessionID), nullInt64(t.WorkflowRunID), nullInt64(t.ParentSessionID), nullInt64(t.ParentTaskID), t.WorktreeBranch, t.BaseCommit,
		t.ReviewRounds, nullStrPtr(t.FinishedAt), nullIntPtr(t.ExitCode), t.SortOrder,
		t.Cron, boolInt(t.Enabled), nullStrPtr(t.LastRunAt), nullStrPtr(t.NextRunAt), t.WorktreePath, t.SessionDir, t.LastMessageAt, t.MessageCount, nullStrPtr(t.SuspendedAt), nullStrPtr(t.DeliveredAt), t.Spec, t.Violations, t.SpecHash, t.ExternalKey,
		t.CreatedAt, t.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// assignNextTaskSortOrder appends a new implementation task to its project's
// current order.  A zero value is reserved for tasks without a project and
// system-created merge tasks, which are ordered by their separate priority.
func assignNextTaskSortOrder(tx *sql.Tx, t *Task) error {
	if t.ProjectID == nil || t.MergeOf != nil || t.SortOrder > 0 {
		return nil
	}
	var next int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(sort_order), 0) + 1
		FROM tasks WHERE project_id=? AND merge_of IS NULL`, *t.ProjectID).Scan(&next); err != nil {
		return err
	}
	if next < 1 {
		next = 1
	}
	t.SortOrder = next
	return nil
}

func (s *Store) CreateTask(t Task) (int64, error) {
	prepareTaskForInsert(&t)
	if t.ProjectID == nil || t.MergeOf != nil || t.SortOrder > 0 {
		return insertTask(s.db, t)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err := assignNextTaskSortOrder(tx, &t); err != nil {
		return 0, err
	}
	id, err := insertTask(tx, t)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

// CreateTaskWithProjectDependency 创建用户或定时任务，并在同一事务中确定前置
// 交付。weak 会按创建时间选取同项目上一条实现任务；strong 只接受用户指定的
// 前置实现任务；none 表示独立执行。合并子任务永远不进入用户依赖链。
func (s *Store) CreateTaskWithProjectDependency(t Task) (int64, error) {
	// 此入口代表面向调度的“新普通任务”。调用方没有指定模式时，项目
	// 任务必须默认进入创建时间弱依赖链；保留 CreateTask 的原始语义，
	// 以便内部用例和测试按需直接构造记录。
	if t.MergeOf == nil && t.ProjectID != nil && t.DependencyMode == "" && t.DependsOn == nil {
		t.DependencyMode = DependencyWeak
	}
	prepareTaskForInsert(&t)
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err := assignNextTaskSortOrder(tx, &t); err != nil {
		return 0, err
	}
	if err := resolveNewTaskDependency(tx, &t); err != nil {
		return 0, err
	}
	id, err := insertTask(tx, t)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

func resolveNewTaskDependency(tx *sql.Tx, t *Task) error {
	if t.MergeOf != nil {
		t.DependsOn = nil
		t.DependencyMode = DependencyNone
		return nil
	}
	normalizeDependencyMode(t)
	if !validDependencyMode(t.DependencyMode) {
		return errors.New("非法依赖模式")
	}
	if t.ProjectID == nil {
		if t.DependsOn != nil || t.DependencyMode != DependencyNone {
			return errors.New("只有项目任务可以设置前置依赖")
		}
		return nil
	}
	switch t.DependencyMode {
	case DependencyNone:
		t.DependsOn = nil
		return nil
	case DependencyStrong:
		if t.DependsOn == nil {
			return errors.New("明确依赖必须指定前置任务")
		}
		return validateDependencyTarget(tx, *t.ProjectID, *t.DependsOn)
	case DependencyWeak:
		// 弱依赖由系统根据项目执行顺序决定，不能被客户端伪造为任意目标。
		t.DependsOn = nil
		var predecessor int64
		err := tx.QueryRow(`SELECT id FROM tasks
			WHERE project_id=? AND merge_of IS NULL AND cron=''
			ORDER BY sort_order DESC, created_at DESC, id DESC LIMIT 1`, *t.ProjectID).Scan(&predecessor)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		t.DependsOn = &predecessor
		return nil
	}
	return errors.New("非法依赖模式")
}

func validateDependencyTarget(tx *sql.Tx, projectID, dependencyID int64) error {
	if dependencyID <= 0 {
		return errors.New("前置任务 ID 非法")
	}
	var dependencyType, cron string
	var dependencyProject, mergeOf sql.NullInt64
	err := tx.QueryRow("SELECT type, project_id, merge_of, cron FROM tasks WHERE id=?", dependencyID).Scan(&dependencyType, &dependencyProject, &mergeOf, &cron)
	if err == sql.ErrNoRows {
		return errors.New("前置任务不存在")
	}
	if err != nil {
		return err
	}
	if dependencyType != TaskTypeTask {
		return errors.New("前置任务必须是普通实现任务")
	}
	if cron != "" {
		return errors.New("前置任务不能是定时定义")
	}
	if mergeOf.Valid {
		return errors.New("前置任务必须是实现任务，不能直接依赖代码合并任务")
	}
	if !dependencyProject.Valid || dependencyProject.Int64 != projectID {
		return errors.New("前置任务必须属于同一项目")
	}
	return nil
}

// CompleteTaskAndCreateMerge 原子地完成一个普通任务并创建唯一的代码合并
// 子任务。条件更新确保重试、重复回调或已取消任务不会派发重复合并任务。
