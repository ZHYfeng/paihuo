package store

import "sort"

// ---------------------------------------------------------------------------
// 任务

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
