package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"paihuo/internal/workflow"
)

func (s *Store) CreateWorkflowProposal(spec workflow.Spec) (int64, error) {
	data, err := json.Marshal(spec)
	if err != nil {
		return 0, err
	}
	now := Now()
	res, err := s.db.Exec(`INSERT INTO workflow_proposals(spec, status, created_at, updated_at)
		VALUES(?, ?, ?, ?)`, data, workflow.ProposalStatusProposed, now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func scanWorkflowProposal(row scanner) (workflow.Proposal, error) {
	var item workflow.Proposal
	var spec, violations []byte
	err := row.Scan(&item.ID, &spec, &item.Status, &violations, &item.Revision, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(spec, &item.Spec); err != nil {
		return item, err
	}
	if err := json.Unmarshal(violations, &item.Violations); err != nil {
		return item, err
	}
	return item, nil
}

func (s *Store) GetWorkflowProposal(id int64) (*workflow.Proposal, error) {
	item, err := scanWorkflowProposal(s.db.QueryRow(`SELECT id, spec, status, violations, revision, created_at, updated_at
		FROM workflow_proposals WHERE id=?`, id))
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *Store) ListWorkflowProposals() ([]workflow.Proposal, error) {
	rows, err := s.db.Query(`SELECT id, spec, status, violations, revision, created_at, updated_at
		FROM workflow_proposals ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]workflow.Proposal, 0)
	for rows.Next() {
		item, err := scanWorkflowProposal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) RecordWorkflowValidation(id, expected int64, violations []workflow.Violation) error {
	data, err := json.Marshal(violations)
	if err != nil {
		return err
	}
	status := workflow.ProposalStatusValidated
	if len(violations) > 0 {
		status = workflow.ProposalStatusRejected
	}
	res, err := s.db.Exec(`UPDATE workflow_proposals
		SET status=?, violations=?, revision=revision+1, updated_at=?
		WHERE id=? AND revision=? AND status<>?`, status, data, Now(), id, expected, workflow.ProposalStatusAdopted)
	if err != nil {
		return err
	}
	changed, _ := res.RowsAffected()
	if changed != 1 {
		return ErrRevisionConflict
	}
	return nil
}

func (s *Store) AdoptWorkflowProposal(id, expected int64, specHash string) (*workflow.Plan, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	proposal, err := scanWorkflowProposal(tx.QueryRow(`SELECT id, spec, status, violations, revision, created_at, updated_at
		FROM workflow_proposals WHERE id=?`, id))
	if err != nil {
		return nil, err
	}
	if proposal.Revision != expected || proposal.Status != workflow.ProposalStatusValidated || len(proposal.Violations) > 0 {
		return nil, ErrRevisionConflict
	}
	data, err := json.Marshal(proposal.Spec)
	if err != nil {
		return nil, err
	}
	now := Now()
	res, err := tx.Exec(`INSERT INTO workflow_plans(version, spec, spec_hash, status, proposal_id, created_at, updated_at)
		VALUES(1, ?, ?, ?, ?, ?, ?)`, data, specHash, workflow.PlanStatusFrozen, id, now, now)
	if err != nil {
		return nil, err
	}
	planID, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	res, err = tx.Exec(`UPDATE workflow_proposals SET status=?, revision=revision+1, updated_at=?
		WHERE id=? AND revision=?`, workflow.ProposalStatusAdopted, now, id, expected)
	if err != nil {
		return nil, err
	}
	if changed, _ := res.RowsAffected(); changed != 1 {
		return nil, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	proposalID := id
	return &workflow.Plan{ID: planID, Version: 1, Spec: proposal.Spec, SpecHash: specHash,
		Status: workflow.PlanStatusFrozen, ProposalID: &proposalID, Revision: 1, CreatedAt: now, UpdatedAt: now}, nil
}

func scanWorkflowPlan(row scanner) (workflow.Plan, error) {
	var item workflow.Plan
	var spec []byte
	var proposalID sql.NullInt64
	err := row.Scan(&item.ID, &item.Version, &spec, &item.SpecHash, &item.Status, &proposalID,
		&item.Revision, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(spec, &item.Spec); err != nil {
		return item, err
	}
	if proposalID.Valid {
		item.ProposalID = &proposalID.Int64
	}
	return item, nil
}

func (s *Store) GetWorkflowPlan(id int64) (*workflow.Plan, error) {
	item, err := scanWorkflowPlan(s.db.QueryRow(`SELECT id, version, spec, spec_hash, status, proposal_id,
		revision, created_at, updated_at FROM workflow_plans WHERE id=?`, id))
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *Store) ListWorkflowPlans() ([]workflow.Plan, error) {
	rows, err := s.db.Query(`SELECT id, version, spec, spec_hash, status, proposal_id,
		revision, created_at, updated_at FROM workflow_plans ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]workflow.Plan, 0)
	for rows.Next() {
		item, err := scanWorkflowPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// InstantiateWorkflow is one transaction from frozen Plan to persisted Run
// and Tasks. Every dependency edge is stored before any Task can be claimed.
func (s *Store) InstantiateWorkflow(plan workflow.Plan) (*workflow.Run, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var status string
	var revision int64
	if err := tx.QueryRow("SELECT status, revision FROM workflow_plans WHERE id=?", plan.ID).Scan(&status, &revision); err != nil {
		return nil, err
	}
	if status != workflow.PlanStatusFrozen || revision != plan.Revision {
		return nil, ErrRevisionConflict
	}
	var projectDir string
	if err := tx.QueryRow("SELECT project_dir FROM projects WHERE id=? AND status='active'", plan.Spec.ProjectID).Scan(&projectDir); err != nil {
		return nil, fmt.Errorf("Workflow Project 不可用: %w", err)
	}
	now := Now()
	emptyTaskIDs, _ := json.Marshal(map[string]int64{})
	res, err := tx.Exec(`INSERT INTO workflow_runs(plan_id, status, task_ids, created_at, started_at, updated_at)
		VALUES(?, ?, ?, ?, ?, ?)`, plan.ID, workflow.RunStatusRunning, emptyTaskIDs, now, now, now)
	if err != nil {
		return nil, err
	}
	runID, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	nodes := append([]workflow.Node(nil), plan.Spec.Nodes...)
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	taskIDs := make(map[string]int64, len(nodes))
	for _, node := range nodes {
		roleID := node.Role.RoleID
		task := Task{
			Title: node.Intent, Body: node.Intent, Status: StatusQueued, Perm: node.Permission,
			RunMode: RunModeBatch, Concurrent: plan.Spec.Limits.MaxConcurrency > 1,
			RoleID: &roleID, ProjectID: &plan.Spec.ProjectID, ProjectDir: projectDir,
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
	res, err = tx.Exec(`UPDATE workflow_plans SET status=?, revision=revision+1, updated_at=?
		WHERE id=? AND revision=? AND status=?`, workflow.PlanStatusRunning, now, plan.ID, plan.Revision, workflow.PlanStatusFrozen)
	if err != nil {
		return nil, err
	}
	if changed, _ := res.RowsAffected(); changed != 1 {
		return nil, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	started := now
	return &workflow.Run{ID: runID, PlanID: plan.ID, Status: workflow.RunStatusRunning,
		TaskIDs: taskIDs, Revision: 1, CreatedAt: now, StartedAt: &started, UpdatedAt: now}, nil
}

// WorkflowRunConcurrencyLimit returns the immutable Plan limit governing a
// Run. The executor uses it as a dispatch gate shared by all Roles in the Run.
func (s *Store) WorkflowRunConcurrencyLimit(runID int64) (int, error) {
	var data []byte
	if err := s.db.QueryRow(`SELECT p.spec FROM workflow_runs r
		JOIN workflow_plans p ON p.id=r.plan_id WHERE r.id=?`, runID).Scan(&data); err != nil {
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
	err := row.Scan(&item.ID, &item.PlanID, &item.Status, &taskIDs, &item.Revision,
		&item.CreatedAt, &started, &finished, &item.UpdatedAt)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(taskIDs, &item.TaskIDs); err != nil {
		return item, err
	}
	item.StartedAt = strPtr(started)
	item.FinishedAt = strPtr(finished)
	return item, nil
}

func (s *Store) GetWorkflowRun(id int64) (*workflow.Run, error) {
	item, err := scanWorkflowRun(s.db.QueryRow(`SELECT id, plan_id, status, task_ids, revision,
		created_at, started_at, finished_at, updated_at FROM workflow_runs WHERE id=?`, id))
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *Store) ListActiveWorkflowRuns() ([]workflow.Run, error) {
	rows, err := s.db.Query(`SELECT id, plan_id, status, task_ids, revision,
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

// ListWorkflowRunsByPlan 返回某个 Plan 的全部 Run（新→旧）。Plan 页用它
// 恢复最近一次启动的 Run：刷新页面后也能继续看到聚合状态与节点任务。
func (s *Store) ListWorkflowRunsByPlan(planID int64) ([]workflow.Run, error) {
	rows, err := s.db.Query(`SELECT id, plan_id, status, task_ids, revision,
		created_at, started_at, finished_at, updated_at FROM workflow_runs WHERE plan_id=? ORDER BY id DESC`, planID)
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
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var planID int64
	res, err := tx.Exec(`UPDATE workflow_runs SET status=?, finished_at=?, updated_at=?, revision=revision+1
		WHERE id=? AND revision=? AND status=?`, status, Now(), Now(), runID, expected, workflow.RunStatusRunning)
	if err != nil {
		return err
	}
	if changed, _ := res.RowsAffected(); changed != 1 {
		return ErrRevisionConflict
	}
	if err := tx.QueryRow("SELECT plan_id FROM workflow_runs WHERE id=?", runID).Scan(&planID); err != nil {
		return err
	}
	planStatus := workflow.PlanStatusFailed
	if status == workflow.RunStatusSucceeded {
		planStatus = workflow.PlanStatusSucceeded
	} else if status == workflow.RunStatusCancelled {
		planStatus = workflow.PlanStatusCancelled
	}
	if _, err := tx.Exec(`UPDATE workflow_plans SET status=?, updated_at=?, revision=revision+1 WHERE id=?`, planStatus, Now(), planID); err != nil {
		return err
	}
	return tx.Commit()
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
