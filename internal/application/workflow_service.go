// Package application coordinates domain modules into product use cases.
// HTTP, MCP and tests call the same services instead of reproducing state
// transitions in transports.
package application

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/workflow"
)

// WorkflowService 管理工作流任务（type=workflow）的提案门禁与 Run 实例化。
// Proposal/Plan 折叠为任务状态与字段：proposed → validated/rejected → adopted。
type WorkflowService struct {
	store    *store.Store
	runtimes *paiexec.RuntimeService
	executor *paiexec.Executor
	events   *events.EventStream
	policy   workflow.Policy
}

func NewWorkflowService(st *store.Store, runtimes *paiexec.RuntimeService, executor *paiexec.Executor, stream *events.EventStream) *WorkflowService {
	service := &WorkflowService{store: st, runtimes: runtimes, executor: executor, events: stream}
	service.policy = workflow.DefaultPolicy(service.resolveRole)
	return service
}

func (s *WorkflowService) resolveRole(roleID int64) workflow.RoleCapabilities {
	role, err := s.store.GetRole(roleID)
	if err != nil {
		return workflow.RoleCapabilities{}
	}
	descriptor := s.runtimes.Descriptor(role.RuntimeID)
	capabilities := make(map[string]bool, len(descriptor.Capabilities))
	for _, capability := range descriptor.Capabilities {
		capabilities[string(capability)] = true
	}
	return workflow.RoleCapabilities{Exists: true, Enabled: role.Enabled, Capabilities: capabilities}
}

// CreateProposal 创建工作流任务（proposed）。cron 非空时是定时工作流定义。
func (s *WorkflowService) CreateProposal(spec workflow.Spec, cron string, enabled bool) (*store.Task, error) {
	if spec.Version == 0 {
		spec.Version = 1
	}
	if spec.Limits.MaxNodes == 0 {
		spec.Limits.MaxNodes = 32
	}
	if spec.Limits.MaxDepth == 0 {
		spec.Limits.MaxDepth = 8
	}
	if spec.Limits.MaxConcurrency == 0 {
		spec.Limits.MaxConcurrency = 2
	}
	if spec.AdoptionPolicy == "" {
		spec.AdoptionPolicy = "manual"
	}
	id, err := s.store.CreateWorkflowTask(spec, cron, enabled)
	if err != nil {
		return nil, err
	}
	proposal, err := s.store.GetWorkflowTask(id)
	if err == nil {
		s.events.Publish(events.Event{Type: "workflow.proposal.created", Payload: proposal})
	}
	return proposal, err
}

// ValidateProposal 运行确定性策略校验并记录结果（validated / rejected）。
func (s *WorkflowService) ValidateProposal(id, expectedRevision int64) (*store.Task, error) {
	proposal, err := s.store.GetWorkflowTask(id)
	if err != nil {
		return nil, err
	}
	if proposal == nil {
		return nil, sql.ErrNoRows
	}
	if proposal.Revision != expectedRevision {
		return nil, store.ErrRevisionConflict
	}
	spec, err := specOf(proposal)
	if err != nil {
		return nil, err
	}
	violations := s.policy.Validate(spec)
	if _, err := s.store.GetProject(spec.ProjectID); err != nil {
		violations = append(violations, workflow.Violation{Code: "project_unavailable", Message: "Project 不存在"})
	}
	if err := s.store.RecordWorkflowValidation(id, expectedRevision, violations); err != nil {
		return nil, err
	}
	validated, err := s.store.GetWorkflowTask(id)
	if err == nil {
		s.events.Publish(events.Event{Type: "workflow.proposal.validated", Payload: validated})
	}
	return validated, err
}

// AdoptProposal 采纳工作流任务：只接受 validated 且零违规，写入 spec_hash 冻结。
func (s *WorkflowService) AdoptProposal(id, expectedRevision int64) (*store.Task, error) {
	proposal, err := s.ValidateProposal(id, expectedRevision)
	if err != nil {
		return nil, err
	}
	spec, err := specOf(proposal)
	if err != nil {
		return nil, err
	}
	var violations []workflow.Violation
	if err := json.Unmarshal([]byte(proposal.Violations), &violations); err == nil && len(violations) > 0 {
		return nil, fmt.Errorf("Workflow Proposal 未通过策略校验")
	}
	canonical, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(canonical)
	adopted, err := s.store.AdoptWorkflowTask(id, proposal.Revision, hex.EncodeToString(hash[:]))
	if err == nil {
		s.events.Publish(events.Event{Type: "workflow.plan.frozen", Payload: adopted})
	}
	return adopted, err
}

// StartPlan 从已采纳（冻结）的工作流任务原子实例化一次 Run。
func (s *WorkflowService) StartPlan(id, expectedRevision int64) (*workflow.Run, error) {
	tk, err := s.store.GetWorkflowTask(id)
	if err != nil {
		return nil, err
	}
	if tk == nil {
		return nil, sql.ErrNoRows
	}
	if tk.Revision != expectedRevision {
		return nil, store.ErrRevisionConflict
	}
	spec, err := specOf(tk)
	if err != nil {
		return nil, err
	}
	if violations := s.policy.Validate(spec); len(violations) > 0 {
		return nil, fmt.Errorf("Workflow Plan 当前不可运行: %s", violations[0].Message)
	}
	run, err := s.store.InstantiateWorkflow(*tk)
	if err != nil {
		return nil, err
	}
	if s.executor != nil {
		s.executor.Wake()
	}
	s.events.Publish(events.Event{Type: "workflow.run.started", Payload: run})
	return run, nil
}

// ListProposals 返回全部工作流任务（新→旧）。
func (s *WorkflowService) ListProposals() ([]store.Task, error) {
	return s.store.ListWorkflowTasks()
}

func (s *WorkflowService) GetProposal(id int64) (*store.Task, error) {
	return s.store.GetWorkflowTask(id)
}

// ListPlans 返回已采纳（冻结）的工作流任务。
func (s *WorkflowService) ListPlans() ([]store.Task, error) {
	all, err := s.store.ListWorkflowTasks()
	if err != nil {
		return nil, err
	}
	out := make([]store.Task, 0, len(all))
	for _, tk := range all {
		if tk.Status == workflow.ProposalStatusAdopted {
			out = append(out, tk)
		}
	}
	return out, nil
}

func (s *WorkflowService) GetPlan(id int64) (*store.Task, error) {
	return s.store.GetWorkflowTask(id)
}

func (s *WorkflowService) GetRun(id int64) (*workflow.Run, error) {
	return s.store.GetWorkflowRun(id)
}

// ListRunsByWorkflow 返回某个工作流任务的全部 Run（新→旧），供工作流页
// 恢复并展示最近一次启动的聚合状态。
func (s *WorkflowService) ListRunsByWorkflow(workflowID int64) ([]workflow.Run, error) {
	return s.store.ListWorkflowRunsByWorkflow(workflowID)
}

func (s *WorkflowService) StartMonitor(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.reconcileRuns()
			}
		}
	}()
}

func (s *WorkflowService) reconcileRuns() {
	runs, err := s.store.ListActiveWorkflowRuns()
	if err != nil {
		return
	}
	for _, run := range runs {
		status, blocked := s.runStatus(run)
		if blocked {
			for _, taskID := range run.TaskIDs {
				task, err := s.store.GetTask(taskID)
				if err == nil && task.Status == store.StatusQueued {
					_ = s.store.UpdateTask(taskID, map[string]any{
						"status": store.StatusCancelled, "finished_at": store.Now(), "error": "Workflow 前置节点失败",
					})
				}
			}
			status = workflow.RunStatusFailed
		}
		if status == "" {
			continue
		}
		if err := s.store.FinishWorkflowRun(run.ID, run.Revision, status); err == nil {
			updated, _ := s.store.GetWorkflowRun(run.ID)
			s.events.Publish(events.Event{Type: "workflow.run.finished", Payload: updated})
		}
	}
}

func (s *WorkflowService) runStatus(run workflow.Run) (status string, blocked bool) {
	ids := make([]int64, 0, len(run.TaskIDs))
	for _, id := range run.TaskIDs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	allTerminal := true
	failed := false
	for _, id := range ids {
		task, err := s.store.GetTask(id)
		if errors.Is(err, sql.ErrNoRows) {
			failed = true
			continue
		}
		if err != nil {
			return "", false
		}
		terminal, succeeded, err := s.store.TaskDeliveryResult(id)
		if err != nil {
			return "", false
		}
		if !terminal {
			allTerminal = false
			if task.Status == store.StatusQueued {
				check, err := s.store.CheckTaskDependency(*task)
				if err == nil && check.Blocked {
					blocked = true
				}
			}
		} else if !succeeded {
			failed = true
		}
	}
	if blocked {
		return workflow.RunStatusFailed, true
	}
	if !allTerminal {
		return "", false
	}
	if failed {
		return workflow.RunStatusFailed, false
	}
	return workflow.RunStatusSucceeded, false
}

// specOf 解析工作流任务的 spec JSON。
func specOf(tk *store.Task) (workflow.Spec, error) {
	var spec workflow.Spec
	if tk == nil || tk.Spec == "" {
		return spec, errors.New("工作流任务缺少 spec")
	}
	if err := json.Unmarshal([]byte(tk.Spec), &spec); err != nil {
		return spec, fmt.Errorf("工作流 spec 解析失败: %w", err)
	}
	return spec, nil
}
