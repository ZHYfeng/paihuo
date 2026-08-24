package store

import (
	"database/sql"
	"errors"
	"fmt"
)

func (s *Store) HasMergeTaskForSource(sourceID int64) (bool, error) {
	var exists bool
	if err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM tasks WHERE merge_of=?)`, sourceID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

// GetMergeTaskForSource 读取一个实现任务对应的唯一代码合并子任务。
func (s *Store) GetMergeTaskForSource(sourceID int64) (*Task, error) {
	row := s.db.QueryRow("SELECT "+taskCols+taskFrom+" WHERE t.merge_of=?", sourceID)
	tk, err := scanTask(row)
	if err != nil {
		return nil, err
	}
	return &tk, nil
}

// TaskDependencyError 表示任务仍被明确的强依赖引用。弱依赖在删除时会被
// 自动解除；强依赖则必须由调用方先处理，避免删除前置任务后让后项提前执行。
type TaskDependencyError struct {
	DependentID int64
	SourceID    int64
}

func (e *TaskDependencyError) Error() string {
	return fmt.Sprintf("任务 #%d 仍以前置任务 #%d 为强依赖", e.DependentID, e.SourceID)
}

// FirstTaskDependent 返回直接把 sourceID 作为前置任务的第一条任务。
func (s *Store) FirstTaskDependent(sourceID int64) (*Task, error) {
	row := s.db.QueryRow("SELECT "+taskCols+taskFrom+" WHERE t.depends_on=? ORDER BY t.created_at, t.id LIMIT 1", sourceID)
	tk, err := scanTask(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &tk, nil
}

// ListTaskDependents 返回直接引用 sourceID 的任务。删除流程用它区分可以
// 自动解除的弱依赖和必须显式处理的强依赖。
func (s *Store) ListTaskDependents(sourceID int64) ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskCols+taskFrom+" WHERE t.depends_on=? ORDER BY t.created_at, t.id", sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	dependents := make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		dependents = append(dependents, tk)
	}
	return dependents, rows.Err()
}

type deliveryState int

const (
	deliveryPending deliveryState = iota
	deliverySucceeded
	deliveryFailed
)

// DependencyCheck 是调度器的唯一依赖判定接口。Ready=false 时 Reason 可直接
// 用于日志或界面；Skipped=true 表示弱依赖碰到非阻塞失败，后项可继续执行。
type DependencyCheck struct {
	Ready   bool
	Skipped bool
	Blocked bool
	Reason  string
}

// CheckTaskDependency 判断任务的前置交付是否已经满足。强依赖只接受成功；
// 弱依赖在前置失败且前置未勾选“失败时阻塞”时，把该交付视为已跳过。
func (s *Store) CheckTaskDependency(t Task) (DependencyCheck, error) {
	if t.MergeOf != nil {
		return DependencyCheck{Ready: true}, nil
	}
	workflowDeps, err := s.workflowDependencies(t.ID)
	if err != nil {
		return DependencyCheck{}, err
	}
	if len(workflowDeps) > 0 {
		skipped := false
		for _, edge := range workflowDeps {
			dependency, err := s.GetTask(edge.TaskID)
			if err != nil {
				return DependencyCheck{}, err
			}
			state, reason, err := s.deliveryStateOf(*dependency)
			if err != nil {
				return DependencyCheck{}, err
			}
			switch state {
			case deliverySucceeded:
				continue
			case deliveryFailed:
				if edge.OnFailure == "continue" {
					skipped = true
					continue
				}
				return DependencyCheck{Blocked: true, Reason: "Workflow 前置节点失败：" + reason}, nil
			default:
				return DependencyCheck{Reason: "等待 Workflow 前置节点：" + reason}, nil
			}
		}
		return DependencyCheck{Ready: true, Skipped: skipped}, nil
	}
	if t.DependsOn == nil || t.DependencyMode == DependencyNone || t.DependencyMode == "" {
		return DependencyCheck{Ready: true}, nil
	}
	if t.DependencyMode != DependencyWeak && t.DependencyMode != DependencyStrong {
		return DependencyCheck{Reason: "依赖模式非法"}, nil
	}
	dependency, err := s.GetTask(*t.DependsOn)
	if err == sql.ErrNoRows {
		if t.DependencyMode == DependencyWeak {
			return DependencyCheck{Ready: true, Skipped: true, Reason: fmt.Sprintf("前序任务 #%d 已删除，已跳过", *t.DependsOn)}, nil
		}
		return DependencyCheck{Reason: fmt.Sprintf("明确依赖的任务 #%d 已删除", *t.DependsOn)}, nil
	}
	if err != nil {
		return DependencyCheck{}, err
	}
	state, reason, err := s.deliveryStateOf(*dependency)
	if err != nil {
		return DependencyCheck{}, err
	}
	switch t.DependencyMode {
	case DependencyStrong:
		if state == deliverySucceeded {
			return DependencyCheck{Ready: true}, nil
		}
		return DependencyCheck{Blocked: state == deliveryFailed, Reason: "明确依赖未完成：" + reason}, nil
	case DependencyWeak:
		switch state {
		case deliverySucceeded:
			return DependencyCheck{Ready: true}, nil
		case deliveryFailed:
			if dependency.BlockOnFailure {
				return DependencyCheck{Blocked: true, Reason: "前序阻塞任务未完成：" + reason}, nil
			}
			return DependencyCheck{Ready: true, Skipped: true, Reason: "前序任务失败，已跳过：" + reason}, nil
		default:
			return DependencyCheck{Reason: "等待前序交付：" + reason}, nil
		}
	}
	return DependencyCheck{Reason: "依赖模式非法"}, nil
}

// TaskDeliveryResult reports the delivery state used by dependency scheduling.
// A Git task is not complete until its merge child has reached a terminal state.
func (s *Store) TaskDeliveryResult(taskID int64) (terminal, succeeded bool, err error) {
	task, err := s.GetTask(taskID)
	if err != nil {
		return false, false, err
	}
	state, _, err := s.deliveryStateOf(*task)
	if err != nil {
		return false, false, err
	}
	switch state {
	case deliverySucceeded:
		return true, true, nil
	case deliveryFailed:
		return true, false, nil
	default:
		return false, false, nil
	}
}

func (s *Store) deliveryStateOf(source Task) (deliveryState, string, error) {
	if source.MergeOf != nil {
		return deliveryFailed, fmt.Sprintf("任务 #%d 不是实现任务", source.ID), nil
	}
	switch source.Status {
	case StatusQueued, StatusClaimed, StatusRunning:
		return deliveryPending, fmt.Sprintf("任务 #%d 正在执行", source.ID), nil
	case StatusAwaitingReview:
		return deliveryPending, fmt.Sprintf("任务 #%d 等待审批", source.ID), nil
	case StatusFailed:
		return deliveryFailed, fmt.Sprintf("任务 #%d 执行失败", source.ID), nil
	case StatusCancelled:
		return deliveryFailed, fmt.Sprintf("任务 #%d 已取消", source.ID), nil
	case StatusSucceeded:
		if source.MergeSkipped {
			return deliverySucceeded, fmt.Sprintf("任务 #%d 已完成（无改动，跳过合并）", source.ID), nil
		}
		merge, err := s.GetMergeTaskForSource(source.ID)
		if err == sql.ErrNoRows {
			if source.WorktreeBranch != "" {
				return deliveryPending, fmt.Sprintf("任务 #%d 正在创建代码合并任务", source.ID), nil
			}
			return deliverySucceeded, fmt.Sprintf("任务 #%d 已完成", source.ID), nil
		}
		if err != nil {
			return deliveryPending, "读取代码合并任务失败", err
		}
		switch merge.Status {
		case StatusSucceeded:
			return deliverySucceeded, fmt.Sprintf("合并任务 #%d 已完成", merge.ID), nil
		case StatusFailed:
			return deliveryFailed, fmt.Sprintf("合并任务 #%d 失败", merge.ID), nil
		case StatusCancelled:
			return deliveryFailed, fmt.Sprintf("合并任务 #%d 已取消", merge.ID), nil
		default:
			return deliveryPending, fmt.Sprintf("合并任务 #%d 正在处理", merge.ID), nil
		}
	default:
		return deliveryPending, fmt.Sprintf("任务 #%d 状态未知", source.ID), nil
	}
}

// ListCompletedGitTasksWithoutMerge 返回已经完成、拥有 Git worktree、但还
// 没有代码合并子任务的源任务。它是自动合并链路的持久化对账输入：即使进程
// 在「保存源分支」和「插入合并任务」之间发生异常，下一次执行器启动或周期
// 扫描仍会补上唯一的合并任务。
func (s *Store) ListCompletedGitTasksWithoutMerge() ([]Task, error) {
	rows, err := s.db.Query(`SELECT `+taskCols+taskFrom+`
		WHERE t.status=?
		  AND t.merge_of IS NULL
		  AND t.worktree_branch<>''
		  AND t.merge_skipped=0
		  AND NOT EXISTS (SELECT 1 FROM tasks m WHERE m.merge_of=t.id)
		ORDER BY t.created_at, t.id`, StatusSucceeded)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tk)
	}
	return out, rows.Err()
}

// EnsureMergeTask 为已完成的 Git 源任务创建其唯一的代码合并子任务。若另一
// 条正常结算/恢复路径已经创建过子任务，则返回其 ID 和 created=false；因此该
// 方法可安全地由启动恢复、周期对账和故障兜底重复调用。
func (s *Store) EnsureMergeTask(source Task) (id int64, created bool, err error) {
	if source.ID <= 0 {
		return 0, false, errors.New("源任务 ID 非法")
	}
	merge := NewMergeTask(source)
	prepareMergeTask(source.ID, &merge)

	tx, err := s.db.Begin()
	if err != nil {
		return 0, false, err
	}
	defer tx.Rollback()

	// 先读取已有子任务。merge_of 的唯一索引是最终约束，这里则让对账调用
	// 成为无副作用的幂等操作。
	var existing int64
	err = tx.QueryRow(`SELECT id FROM tasks WHERE merge_of=?`, source.ID).Scan(&existing)
	if err == nil {
		if err := tx.Commit(); err != nil {
			return 0, false, err
		}
		return existing, false, nil
	}
	if err != sql.ErrNoRows {
		return 0, false, err
	}

	// 只允许仍处于「完成的非合并 Git 源任务」状态时补建，避免删除、取消或
	// 状态回退竞态把已放弃的任务重新派发。
	var eligible bool
	if err := tx.QueryRow(`SELECT EXISTS(
		SELECT 1 FROM tasks
		WHERE id=? AND status=? AND merge_of IS NULL AND worktree_branch<>''
	)`, source.ID, StatusSucceeded).Scan(&eligible); err != nil {
		return 0, false, err
	}
	if !eligible {
		return 0, false, errors.New("源任务当前不需要创建代码合并任务")
	}
	if err := inheritMergeFailurePolicy(tx, source.ID, &merge); err != nil {
		return 0, false, err
	}

	id, err = insertMergeTask(tx, merge)
	if err != nil {
		return 0, false, err
	}
	if err := tx.Commit(); err != nil {
		return 0, false, err
	}
	return id, true, nil
}

// MarkTaskSucceededAwaitingMerge 是正常执行已成功、源 worktree 也已快照，
// 但原子完成+创建合并任务事务暂时失败时的持久化兜底。它只留下一个短暂、可
// 被 ListCompletedGitTasksWithoutMerge 对账到的状态，绝不把成功的代码误记为
// 执行失败。
func (s *Store) MarkTaskSucceededAwaitingMerge(sourceID int64) (bool, error) {
	now := Now()
	res, err := s.db.Exec(`UPDATE tasks
		SET status='succeeded', finished_at=COALESCE(finished_at, ?), exit_code=0,
			error='', updated_at=?, revision=revision+1
		WHERE id=? AND status IN ('claimed','running') AND perm='full'
		  AND merge_of IS NULL AND worktree_branch<>''`, now, now, sourceID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// UpdateTmuxLogOffset 记录已同步到 SQLite 的专用 tmux 原始日志位置。
// 不更新 updated_at，避免高频终端输出扰动任务的业务更新时间。
