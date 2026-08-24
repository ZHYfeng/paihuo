package store

import (
	"database/sql"
	"sort"
)

// ---------------------------------------------------------------------------
// 任务

// taskCols 完整列（详情页用：含完整 body，驳回重做会追加修改意见）。
const taskCols = `t.id, t.type, t.title, t.body, t.status, t.perm, t.run_mode, t.concurrent, t.role_id, COALESCE(a.name, ''),
t.project_id, COALESCE(p.name, ''), t.project_dir, t.parent_id, t.depends_on, t.dependency_mode, t.block_on_failure, t.schedule_id, t.error, t.exit_code,
t.review_note, t.review_rounds, t.tmux_log_offset, t.worktree_branch, t.base_commit, t.resume_of, t.merge_of, t.merge_skipped, t.session_id, t.workflow_run_id, t.parent_session_id, t.parent_task_id, t.sort_order,
t.cron, t.enabled, t.last_run_at, t.next_run_at, t.worktree_path, t.session_dir, t.last_message_at, t.message_count, t.suspended_at, t.delivered_at, t.spec, t.violations, t.spec_hash, t.external_key,
t.created_at, t.started_at, t.finished_at, t.updated_at, t.terminal_cols, t.terminal_rows, t.revision`

// taskColsBrief 列表列（看板/历史/项目页用）：body 截断到 400 字符，
// 避免大提示词把列表接口载荷撑爆。列序与 taskCols 完全一致（scanTask 共用）。
const taskColsBrief = `t.id, t.type, t.title, substr(t.body,1,400) AS body, t.status, t.perm, t.run_mode, t.concurrent, t.role_id, COALESCE(a.name, ''),
t.project_id, COALESCE(p.name, ''), t.project_dir, t.parent_id, t.depends_on, t.dependency_mode, t.block_on_failure, t.schedule_id, t.error, t.exit_code,
t.review_note, t.review_rounds, t.tmux_log_offset, t.worktree_branch, t.base_commit, t.resume_of, t.merge_of, t.merge_skipped, t.session_id, t.workflow_run_id, t.parent_session_id, t.parent_task_id, t.sort_order,
t.cron, t.enabled, t.last_run_at, t.next_run_at, t.worktree_path, t.session_dir, t.last_message_at, t.message_count, t.suspended_at, t.delivered_at, t.spec, t.violations, t.spec_hash, t.external_key,
t.created_at, t.started_at, t.finished_at, t.updated_at, t.terminal_cols, t.terminal_rows, t.revision`

func scanTask(rows scanner) (Task, error) {
	var tk Task
	var roleID, projectID, parentID, dependsOn, scheduleID, exitCode sql.NullInt64
	var roleName, projectName string
	var concurrent, blockOnFailure int64
	var started, finished, lastRun, nextRun, suspendedAt, deliveredAt sql.NullString
	var resumeOf, mergeOf, sessionID, workflowRunID, parentSessionID, parentTaskID sql.NullInt64
	var enabled, messageCount, mergeSkipped int64
	err := rows.Scan(&tk.ID, &tk.Type, &tk.Title, &tk.Body, &tk.Status, &tk.Perm, &tk.RunMode, &concurrent, &roleID, &roleName,
		&projectID, &projectName, &tk.ProjectDir, &parentID, &dependsOn, &tk.DependencyMode, &blockOnFailure, &scheduleID, &tk.Error, &exitCode,
		&tk.ReviewNote, &tk.ReviewRounds, &tk.TmuxLogOffset, &tk.WorktreeBranch, &tk.BaseCommit, &resumeOf, &mergeOf, &mergeSkipped, &sessionID, &workflowRunID, &parentSessionID, &parentTaskID, &tk.SortOrder,
		&tk.Cron, &enabled, &lastRun, &nextRun, &tk.WorktreePath, &tk.SessionDir, &tk.LastMessageAt, &messageCount, &suspendedAt, &deliveredAt, &tk.Spec, &tk.Violations, &tk.SpecHash, &tk.ExternalKey,
		&tk.CreatedAt, &started, &finished, &tk.UpdatedAt, &tk.TerminalCols, &tk.TerminalRows, &tk.Revision)
	if err != nil {
		return tk, err
	}
	if tk.Type == "" {
		tk.Type = TaskTypeTask
	}
	if tk.RunMode == "" {
		tk.RunMode = RunModeBatch
	}
	if tk.DependencyMode == "" {
		tk.DependencyMode = DependencyNone
	}
	tk.Concurrent = concurrent != 0
	tk.BlockOnFailure = blockOnFailure != 0
	tk.Enabled = enabled != 0
	tk.MergeSkipped = mergeSkipped != 0
	tk.MessageCount = int(messageCount)
	if roleID.Valid {
		tk.RoleID = &roleID.Int64
	}
	tk.RoleName = roleName
	if projectID.Valid {
		tk.ProjectID = &projectID.Int64
	}
	if resumeOf.Valid {
		tk.ResumeOf = &resumeOf.Int64
	}
	if mergeOf.Valid {
		tk.MergeOf = &mergeOf.Int64
	}
	if sessionID.Valid {
		tk.SessionID = &sessionID.Int64
	}
	if workflowRunID.Valid {
		tk.WorkflowRunID = &workflowRunID.Int64
	}
	if parentSessionID.Valid {
		tk.ParentSessionID = &parentSessionID.Int64
	}
	if parentTaskID.Valid {
		tk.ParentTaskID = &parentTaskID.Int64
	}
	tk.ProjectName = projectName
	if parentID.Valid {
		tk.ParentID = &parentID.Int64
	}
	if dependsOn.Valid {
		tk.DependsOn = &dependsOn.Int64
	}
	if scheduleID.Valid {
		tk.ScheduleID = &scheduleID.Int64
	}
	if exitCode.Valid {
		code := int(exitCode.Int64)
		tk.ExitCode = &code
	}
	tk.StartedAt = strPtr(started)
	tk.FinishedAt = strPtr(finished)
	tk.LastRunAt = strPtr(lastRun)
	tk.NextRunAt = strPtr(nextRun)
	tk.SuspendedAt = strPtr(suspendedAt)
	tk.DeliveredAt = strPtr(deliveredAt)
	return tk, nil
}

const taskFrom = " FROM tasks t LEFT JOIN roles a ON a.id=t.role_id LEFT JOIN projects p ON p.id=t.project_id"

func (s *Store) ListTasks() ([]Task, error) {
	return s.ListTasksFiltered(TaskFilter{})
}

// TaskFilter 任务列表筛选条件（全部可空 = 不过滤）。
type TaskFilter struct {
	RoleID    *int64
	ProjectID *int64
	Status    string
	Type      string // 形态过滤：task | session | workflow；空 = 不过滤
	Scheduled *bool  // nil=不过滤；true=只返回定时定义（cron 非空）；false=排除定时定义
	Limit     int
}

func (s *Store) ListTasksFiltered(f TaskFilter) ([]Task, error) {
	q := "SELECT " + taskColsBrief + taskFrom + " WHERE 1=1"
	args := []any{}
	if f.RoleID != nil {
		q += " AND t.role_id=?"
		args = append(args, *f.RoleID)
	}
	if f.ProjectID != nil {
		q += " AND t.project_id=?"
		args = append(args, *f.ProjectID)
	}
	if f.Status != "" {
		q += " AND t.status=?"
		args = append(args, f.Status)
	}
	if f.Type != "" {
		q += " AND t.type=?"
		args = append(args, f.Type)
	}
	if f.Scheduled != nil {
		if *f.Scheduled {
			q += " AND t.cron<>''"
		} else {
			q += " AND t.cron=''"
		}
	}
	if f.ProjectID != nil {
		// 项目详情按执行顺序展示；合并任务排在实现任务之后的独立分组中，
		// 但这里仍保持稳定顺序，避免刷新时任务行跳动。
		q += " ORDER BY CASE WHEN t.merge_of IS NOT NULL THEN 1 ELSE 0 END, t.sort_order, t.created_at, t.id"
	} else {
		q += " ORDER BY t.created_at DESC, t.id DESC"
	}
	if f.Limit > 0 {
		q += " LIMIT ?"
		args = append(args, f.Limit)
	}
	rows, err := s.db.Query(q, args...)
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

// ListQueuedTasks 返回可派发的排队任务：已指派角色且角色处于启用状态
// （停用角色不再接收新任务，队列中的任务保持 queued 等待重新启用）。
func (s *Store) ListQueuedTasks() ([]Task, error) {
	// 合并子任务属于其源任务的交付链，必须排在同项目后续实现任务之前；
	// 否则后项会从尚未写入源代码的主分支建立 worktree。跨项目公平性在
	// queuedTaskLess 中处理（按项目最早排队任务竞争，合并任务不插队到
	// 其他项目的实现任务前）。
	rows, err := s.db.Query("SELECT " + taskColsBrief + taskFrom + " WHERE t.status='queued' AND t.type='task' AND t.cron='' AND t.role_id IS NOT NULL AND a.enabled=1 ORDER BY t.created_at, t.id")
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 项目级排序键：该项目所有排队任务的最早创建时间。合并任务只相对
	// 自己项目的实现任务优先；跨项目按「项目整体何时开始排队」公平竞争，
	// 避免一个项目的合并任务抢占其他项目的角色槽位。
	projEarliest := make(map[int64]string, len(out))
	for _, tk := range out {
		if tk.ProjectID != nil {
			if cur, ok := projEarliest[*tk.ProjectID]; !ok || tk.CreatedAt < cur {
				projEarliest[*tk.ProjectID] = tk.CreatedAt
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return queuedTaskLess(out[i], out[j], projEarliest) })
	return out, nil
}

func queuedTaskLess(a, b Task, projEarliest map[int64]string) bool {
	aKey := queueKey(a, projEarliest)
	bKey := queueKey(b, projEarliest)
	if aKey != bKey {
		return aKey < bKey
	}
	aMerge := a.MergeOf != nil
	bMerge := b.MergeOf != nil
	if aMerge != bMerge {
		return aMerge
	}
	if a.ProjectID != nil && b.ProjectID != nil && *a.ProjectID == *b.ProjectID {
		if a.SortOrder != b.SortOrder {
			return a.SortOrder < b.SortOrder
		}
	}
	if a.CreatedAt != b.CreatedAt {
		return a.CreatedAt < b.CreatedAt
	}
	return a.ID < b.ID
}

// queueKey 返回任务在全局排队中的排序键：项目任务按该项目最早排队任务的
// 创建时间（项目整体公平竞争），无项目任务按自身创建时间。ISO 时间字符串
// 可字典序比较。
func queueKey(t Task, projEarliest map[int64]string) string {
	if t.ProjectID != nil {
		if e, ok := projEarliest[*t.ProjectID]; ok {
			return e
		}
	}
	return t.CreatedAt
}

// ListRunningTasks 返回卡在执行态的任务（服务重启时用于重置）。
// 注意：awaiting_review 不在此列——它已执行完、只等审批，重启后仍应保持待审批。
func (s *Store) ListRunningTasks() ([]Task, error) {
	rows, err := s.db.Query("SELECT " + taskColsBrief + taskFrom + " WHERE t.status IN ('running','claimed')")
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

func (s *Store) GetTask(id int64) (*Task, error) {
	row := s.db.QueryRow("SELECT "+taskCols+taskFrom+" WHERE t.id=?", id)
	tk, err := scanTask(row)
	if err != nil {
		return nil, err
	}
	return &tk, nil
}

// TaskExistsByExternalKey 判断是否已为某个外部对象（GitHub issue/PR/告警）创建过任务。
func (s *Store) TaskExistsByExternalKey(key string) (bool, error) {
	if key == "" {
		return false, nil
	}
	var exists int
	err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM tasks WHERE external_key=?)`, key).Scan(&exists)
	return exists != 0, err
}

// boolInt 把任务并发开关收敛为 SQLite 可存整数。
func (s *Store) HasTask(id int64) (bool, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE id=?", id).Scan(&n)
	return n > 0, err
}

// ListChildren 返回某任务的全部子任务（旧→新）。
func (s *Store) ListChildren(parentID int64) ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskCols+taskFrom+" WHERE t.parent_id=? ORDER BY t.created_at, t.id", parentID)
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

// ListChildrenBySession 返回某编排者会话名下的全部派生子任务（扁平，旧→新）。
// 会话树按 parent_session_id 聚合：v1 只有编排者会话调用平台工具派生，
// 因此每个子任务都以会话为根；列被设计为支持子任务再派活的链（parent_task_id）。
func (s *Store) ListChildrenBySession(sessionID int64) ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskCols+taskFrom+" WHERE t.parent_session_id=? ORDER BY t.created_at, t.id", sessionID)
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

// ListChildrenByParentTask 返回某任务的直接派生子任务（parent_task_id 指向它，旧→新）。
func (s *Store) ListChildrenByParentTask(parentTaskID int64) ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskCols+taskFrom+" WHERE t.parent_task_id=? ORDER BY t.created_at, t.id", parentTaskID)
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
