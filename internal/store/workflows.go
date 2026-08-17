package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"paihuo/internal/workflow"
)

// ---------------------------------------------------------------------------
// 工作流任务（type=workflow）：status=adopted（已通过策略校验、可启动 Run
// 的就绪定义），spec/spec_hash 承载定义载荷；定义可编辑（UpdateWorkflowTask）
// 或删除（DeleteWorkflowTask），均受 revision 保护。spec 不绑定项目，启动
// Run 时按项目实例化节点任务。

var ErrWorkflowRunsActive = errors.New("工作流仍有进行中的 Run，无法删除")

// CreateWorkflowTask 创建工作流任务（type=workflow, status=adopted），
// 写入 spec_hash。projectID 仅定时工作流（cron 非空）必填：定时触发
// 启动 Run 时需要确定目标项目；普通工作流由启动 Run 时选择项目。
func (s *Store) CreateWorkflowTask(spec workflow.Spec, cron string, enabled bool, projectID *int64, specHash string) (int64, error) {
	data, err := json.Marshal(spec)
	if err != nil {
		return 0, err
	}
	tk := Task{
		Type:      TaskTypeWorkflow,
		Title:     spec.Goal,
		Body:      spec.Goal,
		Status:    workflow.WorkflowStatusAdopted,
		ProjectID: projectID,
		Spec:      string(data),
		SpecHash:  specHash,
		Cron:      cron,
		Enabled:   enabled,
	}
	return s.CreateTask(tk)
}

// GetWorkflowTask 返回工作流任务；不存在时返回 (nil, nil)。
func (s *Store) GetWorkflowTask(id int64) (*Task, error) {
	tk, err := s.GetTask(id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return tk, nil
}

// ListWorkflowTasks 返回全部工作流任务（新→旧）。
func (s *Store) ListWorkflowTasks() ([]Task, error) {
	return s.ListTasksFiltered(TaskFilter{Type: TaskTypeWorkflow})
}

// UpdateWorkflowTask 整体替换工作流定义：调用方已完成策略校验，这里原子地
// 重写 spec/spec_hash 与定时属性并 bump revision。记录不存在、非工作流或
// revision 不符一律返回 ErrRevisionConflict。已实例化的 Run 不受影响。
func (s *Store) UpdateWorkflowTask(id, expectedRevision int64, spec workflow.Spec, cron string, enabled bool, projectID *int64, specHash string) (*Task, error) {
	data, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	res, err := s.db.Exec(`UPDATE tasks
		SET title=?, body=?, spec=?, spec_hash=?, cron=?, enabled=?, project_id=?, updated_at=?, revision=revision+1
		WHERE id=? AND revision=? AND type=?`,
		spec.Goal, spec.Goal, string(data), specHash, cron, boolInt(enabled), projectID, Now(), id, expectedRevision, TaskTypeWorkflow)
	if err != nil {
		return nil, err
	}
	if changed, _ := res.RowsAffected(); changed != 1 {
		return nil, ErrRevisionConflict
	}
	return s.GetWorkflowTask(id)
}

// DeleteWorkflowTask 删除工作流定义及其 Run 书签：先解除节点任务（含合并
// 子任务）的 workflow_run_id 关联以保留任务历史，再删除 Run 书签与定义。
// 有进行中的 Run（created/running）时返回 ErrWorkflowRunsActive，避免
// 定义消失后 run 聚合失去依据。
func (s *Store) DeleteWorkflowTask(id, expectedRevision int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var revision int64
	if err := tx.QueryRow(`SELECT revision FROM tasks WHERE id=? AND type=?`, id, TaskTypeWorkflow).Scan(&revision); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return sql.ErrNoRows
		}
		return err
	}
	if revision != expectedRevision {
		return ErrRevisionConflict
	}
	var active int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM workflow_runs WHERE workflow_id=? AND status IN (?, ?)`,
		id, workflow.RunStatusCreated, workflow.RunStatusRunning).Scan(&active); err != nil {
		return err
	}
	if active > 0 {
		return ErrWorkflowRunsActive
	}
	if _, err := tx.Exec(`UPDATE tasks SET workflow_run_id=NULL, updated_at=?
		WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_id=?)`, Now(), id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM workflow_runs WHERE workflow_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM tasks WHERE id=? AND revision=? AND type=?`, id, expectedRevision, TaskTypeWorkflow); err != nil {
		return err
	}
	return tx.Commit()
}

// InstantiateWorkflow is one transaction from an adopted workflow task to
// persisted Run and Tasks. Every dependency edge is stored before any Task can
// be claimed. 工作流定义保持 adopted 可被多次 run；每次 Run 绑定调用方指定的
// projectID，节点任务创建在该项目下，
func (s *Store) InstantiateWorkflow(tk Task, projectID int64) (*workflow.Run, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var status string
	var revision int64
	if err := tx.QueryRow("SELECT status, revision FROM tasks WHERE id=?", tk.ID).Scan(&status, &revision); err != nil {
		return nil, err
	}
	if status != workflow.WorkflowStatusAdopted || revision != tk.Revision {
		return nil, ErrRevisionConflict
	}
	var spec workflow.Spec
	if err := json.Unmarshal([]byte(tk.Spec), &spec); err != nil {
		return nil, err
	}
	var projectDir string
	if err := tx.QueryRow("SELECT project_dir FROM projects WHERE id=? AND status='active'", projectID).Scan(&projectDir); err != nil {
		return nil, fmt.Errorf("Workflow Project 不可用: %w", err)
	}
	now := Now()
	emptyTaskIDs, _ := json.Marshal(map[string]int64{})
	res, err := tx.Exec(`INSERT INTO workflow_runs(workflow_id, project_id, status, task_ids, created_at, started_at, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?)`, tk.ID, projectID, workflow.RunStatusRunning, emptyTaskIDs, now, now, now)
	if err != nil {
		return nil, err
	}
	runID, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	nodes := append([]workflow.Node(nil), spec.Nodes...)
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	taskIDs := make(map[string]int64, len(nodes))
	for _, node := range nodes {
		roleID := node.Role.RoleID
		task := Task{
			Title: node.Intent, Body: node.Intent, Status: StatusQueued, Perm: node.Permission,
			RunMode: RunModeBatch, Concurrent: spec.Limits.MaxConcurrency > 1,
			RoleID: &roleID, ProjectID: &projectID, ProjectDir: projectDir,
			WorkflowRunID:  &runID,
			DependencyMode: DependencyNone, BlockOnFailure: node.FailurePolicy == "stop",
		}
		prepareTaskForInsert(&task)
		if err := assignNextTaskSortOrder(tx, &task); err != nil {
			return nil, err
		}
		id, err := insertTask(tx, task)
		if err != nil {
			return nil, err
		}
		taskIDs[node.ID] = id
	}
	for _, node := range nodes {
		for _, dependency := range node.DependsOn {
			sourceID, ok := taskIDs[dependency]
			if !ok {
				return nil, fmt.Errorf("Workflow 依赖节点不存在: %s", dependency)
			}
			onFailure := "block"
			if node.FailurePolicy == "continue" {
				onFailure = "continue"
			}
			if _, err := tx.Exec(`INSERT INTO task_dependencies(task_id, depends_on, on_failure) VALUES(?, ?, ?)`,
				taskIDs[node.ID], sourceID, onFailure); err != nil {
				return nil, err
			}
		}
	}
	taskData, err := json.Marshal(taskIDs)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec("UPDATE workflow_runs SET task_ids=? WHERE id=?", taskData, runID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	started := now
	return &workflow.Run{ID: runID, WorkflowID: tk.ID, ProjectID: projectID, Status: workflow.RunStatusRunning,
		TaskIDs: taskIDs, Revision: 1, CreatedAt: now, StartedAt: &started, UpdatedAt: now}, nil
}

// WorkflowRunConcurrencyLimit returns the spec limit governing a Run's
// dispatch. The executor uses it as a gate shared by all Roles in the Run;
// 定义被编辑后，进行中的 Run 的并发门禁随定义当前 spec 变化。
func (s *Store) WorkflowRunConcurrencyLimit(runID int64) (int, error) {
	var data []byte
	if err := s.db.QueryRow(`SELECT t.spec FROM workflow_runs r
		JOIN tasks t ON t.id=r.workflow_id WHERE r.id=?`, runID).Scan(&data); err != nil {
		return 0, err
	}
	var spec workflow.Spec
	if err := json.Unmarshal(data, &spec); err != nil {
		return 0, err
	}
	if spec.Limits.MaxConcurrency < 1 {
		return 1, nil
	}
	return spec.Limits.MaxConcurrency, nil
}

func scanWorkflowRun(row scanner) (workflow.Run, error) {
	var item workflow.Run
	var taskIDs []byte
	var started, finished sql.NullString
	var projectID sql.NullInt64 // 迁移后的存量 Run 可能无项目（0）
	err := row.Scan(&item.ID, &item.WorkflowID, &projectID, &item.Status, &taskIDs, &item.Revision,
		&item.CreatedAt, &started, &finished, &item.UpdatedAt)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(taskIDs, &item.TaskIDs); err != nil {
		return item, err
	}
	item.ProjectID = projectID.Int64
	item.StartedAt = strPtr(started)
	item.FinishedAt = strPtr(finished)
	return item, nil
}

func (s *Store) GetWorkflowRun(id int64) (*workflow.Run, error) {
	item, err := scanWorkflowRun(s.db.QueryRow(`SELECT id, workflow_id, project_id, status, task_ids, revision,
		created_at, started_at, finished_at, updated_at FROM workflow_runs WHERE id=?`, id))
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *Store) ListActiveWorkflowRuns() ([]workflow.Run, error) {
	rows, err := s.db.Query(`SELECT id, workflow_id, project_id, status, task_ids, revision,
		created_at, started_at, finished_at, updated_at FROM workflow_runs WHERE status=? ORDER BY id`, workflow.RunStatusRunning)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]workflow.Run, 0)
	for rows.Next() {
		item, err := scanWorkflowRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// ListWorkflowRunsByWorkflow 返回某个工作流任务的全部 Run（新→旧）。工作流
// 页用它恢复最近一次启动的 Run：刷新页面后也能继续看到聚合状态与节点任务。
func (s *Store) ListWorkflowRunsByWorkflow(workflowID int64) ([]workflow.Run, error) {
	rows, err := s.db.Query(`SELECT id, workflow_id, project_id, status, task_ids, revision,
		created_at, started_at, finished_at, updated_at FROM workflow_runs WHERE workflow_id=? ORDER BY id DESC`, workflowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]workflow.Run, 0)
	for rows.Next() {
		item, err := scanWorkflowRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) FinishWorkflowRun(runID, expected int64, status string) error {
	if status != workflow.RunStatusSucceeded && status != workflow.RunStatusFailed && status != workflow.RunStatusCancelled {
		return errors.New("非法 Workflow Run 终态")
	}
	res, err := s.db.Exec(`UPDATE workflow_runs SET status=?, finished_at=?, updated_at=?, revision=revision+1
		WHERE id=? AND revision=? AND status=?`, status, Now(), Now(), runID, expected, workflow.RunStatusRunning)
	if err != nil {
		return err
	}
	if changed, _ := res.RowsAffected(); changed != 1 {
		return ErrRevisionConflict
	}
	return nil
}

type workflowDependency struct {
	TaskID    int64
	OnFailure string
}

func (s *Store) workflowDependencies(taskID int64) ([]workflowDependency, error) {
	rows, err := s.db.Query(`SELECT depends_on, on_failure FROM task_dependencies WHERE task_id=? ORDER BY depends_on`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]workflowDependency, 0)
	for rows.Next() {
		var item workflowDependency
		if err := rows.Scan(&item.TaskID, &item.OnFailure); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
