package store

import (
	"database/sql"
	"errors"
)

func (s *Store) CompleteTaskAndCreateMerge(sourceID int64, merge Task) (int64, error) {
	prepareMergeTask(sourceID, &merge)
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	now := Now()
	res, err := tx.Exec(`UPDATE tasks
		SET status='succeeded', finished_at=?, exit_code=0, error='', updated_at=?, revision=revision+1
		WHERE id=? AND status IN ('claimed','running') AND perm='full' AND merge_of IS NULL`, now, now, sourceID)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return 0, errors.New("任务已完成、已取消，或已创建代码合并任务")
	}
	if err := inheritMergeFailurePolicy(tx, sourceID, &merge); err != nil {
		return 0, err
	}
	mergeID, err := insertMergeTask(tx, merge)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return mergeID, nil
}

// DeliverTaskAndCreateMerge 原子地把会话交付任务标记为完成并创建唯一的代码
// 合并子任务。与 CompleteTaskAndCreateMerge 不同，交付任务从未进入
// claimed/running（会话工作已完成，跳过 agent 执行），状态从 queued 直接到
// succeeded；session_id 非空保证只有交付桥接入口能走此路径。条件更新确保
// 重复交付或并发请求不会派发重复合并任务。
func (s *Store) DeliverTaskAndCreateMerge(sourceID int64, merge Task) (int64, error) {
	prepareMergeTask(sourceID, &merge)
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	now := Now()
	res, err := tx.Exec(`UPDATE tasks
		SET status='succeeded', finished_at=?, exit_code=0, error='', updated_at=?, revision=revision+1
		WHERE id=? AND status='queued' AND perm='full' AND merge_of IS NULL AND session_id IS NOT NULL`, now, now, sourceID)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return 0, errors.New("任务已交付、已取消，或已创建代码合并任务")
	}
	if err := inheritMergeFailurePolicy(tx, sourceID, &merge); err != nil {
		return 0, err
	}
	mergeID, err := insertMergeTask(tx, merge)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return mergeID, nil
}

// ApproveTaskAndCreateMerge 原子完成 review 审批并创建唯一的合并任务。
// 条件更新保证重复点击或并发请求不会生成两个合并任务。
func (s *Store) ApproveTaskAndCreateMerge(sourceID int64, merge Task) (int64, error) {
	prepareMergeTask(sourceID, &merge)
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	now := Now()
	res, err := tx.Exec(`UPDATE tasks
		SET status='succeeded', finished_at=COALESCE(finished_at, ?), exit_code=COALESCE(exit_code, 0), updated_at=?, revision=revision+1
		WHERE id=? AND status='awaiting_review' AND perm='review'`, now, now, sourceID)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return 0, errors.New("任务已审批或当前不在待审批状态")
	}
	if err := inheritMergeFailurePolicy(tx, sourceID, &merge); err != nil {
		return 0, err
	}
	id, err := insertMergeTask(tx, merge)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

// ApproveTaskDeliver 审批通过但该任务判定无改动（merge_skipped=1）：不创建
// 合并任务，直接把源任务落成 succeeded 终态。审批闸口原样保留，只跳过合并
// ——「审批」与「合并」是两个独立的事。
func (s *Store) ApproveTaskDeliver(sourceID int64) error {
	now := Now()
	res, err := s.db.Exec(`UPDATE tasks
		SET status='succeeded', merge_skipped=1, finished_at=COALESCE(finished_at, ?), exit_code=COALESCE(exit_code, 0), updated_at=?, revision=revision+1
		WHERE id=? AND status='awaiting_review'`, now, now, sourceID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("任务已审批或当前不在待审批状态")
	}
	return nil
}

func prepareMergeTask(sourceID int64, merge *Task) {
	// 合并任务是系统内部状态机的一部分：固定关联到源任务、串行 batch
	// 执行、完整权限。这样即使未来新增调用方，也不会创建会再次审批或
	// 失去来源关系的任务。
	merge.ParentID = &sourceID
	merge.MergeOf = &sourceID
	merge.Status = StatusQueued
	merge.Perm = PermFull
	merge.RunMode = RunModeBatch
	merge.Concurrent = false
	merge.DependsOn = nil
	merge.DependencyMode = DependencyNone
	merge.ScheduleID = nil
	merge.ResumeOf = nil
	if merge.CreatedAt == "" {
		merge.CreatedAt = Now()
	}
	if merge.UpdatedAt == "" {
		merge.UpdatedAt = merge.CreatedAt
	}
}

// inheritMergeFailurePolicy 让合并子任务从数据库中的源任务继承失败阻塞
// 策略。不能只信任调用方传入的 Task 快照：用户可能恰好在源任务完成与创建
// 合并任务之间修改了该开关，而后续弱依赖应始终以源任务的最终策略为准。
func inheritMergeFailurePolicy(tx *sql.Tx, sourceID int64, merge *Task) error {
	var block int64
	if err := tx.QueryRow("SELECT block_on_failure FROM tasks WHERE id=?", sourceID).Scan(&block); err != nil {
		return err
	}
	merge.BlockOnFailure = block != 0
	return nil
}

func insertMergeTask(tx *sql.Tx, merge Task) (int64, error) {
	res, err := tx.Exec(`INSERT INTO tasks
		(title, body, status, perm, run_mode, concurrent, role_id, project_id, project_dir, parent_id, depends_on, dependency_mode, block_on_failure, schedule_id, resume_of, merge_of, session_id, workflow_run_id, sort_order, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		merge.Title, merge.Body, merge.Status, merge.Perm, merge.RunMode, boolInt(merge.Concurrent), nullInt64(merge.RoleID), nullInt64(merge.ProjectID), merge.ProjectDir,
		nullInt64(merge.ParentID), nullInt64(merge.DependsOn), merge.DependencyMode, boolInt(merge.BlockOnFailure), nullInt64(merge.ScheduleID), nullInt64(merge.ResumeOf), nullInt64(merge.MergeOf), nullInt64(merge.SessionID), nullInt64(merge.WorkflowRunID), merge.SortOrder, merge.CreatedAt, merge.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}
