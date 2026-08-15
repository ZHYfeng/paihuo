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

func (s *WorkflowService) CreateProposal(spec workflow.Spec) (*workflow.Proposal, error) {
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
	id, err := s.store.CreateWorkflowProposal(spec)
	if err != nil {
		return nil, err
	}
	proposal, err := s.store.GetWorkflowProposal(id)
	if err == nil {
		s.events.Publish(events.Event{Type: "workflow.proposal.created", Payload: proposal})
	}
	return proposal, err
}

func (s *WorkflowService) ValidateProposal(id, expectedRevision int64) (*workflow.Proposal, error) {
	proposal, err := s.store.GetWorkflowProposal(id)
	if err != nil {
		return nil, err
	}
	if proposal.Revision != expectedRevision {
		return nil, store.ErrRevisionConflict
	}
	violations := s.policy.Validate(proposal.Spec)
	if _, err := s.store.GetProject(proposal.Spec.ProjectID); err != nil {
		violations = append(violations, workflow.Violation{Code: "project_unavailable", Message: "Project 不存在"})
	}
	if err := s.store.RecordWorkflowValidation(id, expectedRevision, violations); err != nil {
		return nil, err
	}
	validated, err := s.store.GetWorkflowProposal(id)
	if err == nil {
		s.events.Publish(events.Event{Type: "workflow.proposal.validated", Payload: validated})
	}
	return validated, err
}

func (s *WorkflowService) AdoptProposal(id, expectedRevision int64) (*workflow.Plan, error) {
	proposal, err := s.ValidateProposal(id, expectedRevision)
	if err != nil {
		return nil, err
	}
	if len(proposal.Violations) > 0 {
		return nil, fmt.Errorf("Workflow Proposal 未通过策略校验")
	}
	canonical, err := json.Marshal(proposal.Spec)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(canonical)
	plan, err := s.store.AdoptWorkflowProposal(id, proposal.Revision, hex.EncodeToString(hash[:]))
	if err == nil {
		s.events.Publish(events.Event{Type: "workflow.plan.frozen", Payload: plan})
	}
	return plan, err
}

func (s *WorkflowService) StartPlan(id, expectedRevision int64) (*workflow.Run, error) {
	plan, err := s.store.GetWorkflowPlan(id)
	if err != nil {
		return nil, err
	}
	if plan.Revision != expectedRevision {
		return nil, store.ErrRevisionConflict
	}
	if violations := s.policy.Validate(plan.Spec); len(violations) > 0 {
		return nil, fmt.Errorf("Workflow Plan 当前不可运行: %s", violations[0].Message)
	}
	run, err := s.store.InstantiateWorkflow(*plan)
	if err != nil {
		return nil, err
	}
	if s.executor != nil {
		s.executor.Wake()
	}
	s.events.Publish(events.Event{Type: "workflow.run.started", Payload: run})
	return run, nil
}

func (s *WorkflowService) ListProposals() ([]workflow.Proposal, error) {
	return s.store.ListWorkflowProposals()
}

func (s *WorkflowService) GetProposal(id int64) (*workflow.Proposal, error) {
	return s.store.GetWorkflowProposal(id)
}

func (s *WorkflowService) ListPlans() ([]workflow.Plan, error) {
	return s.store.ListWorkflowPlans()
}

func (s *WorkflowService) GetPlan(id int64) (*workflow.Plan, error) {
	return s.store.GetWorkflowPlan(id)
}

func (s *WorkflowService) GetRun(id int64) (*workflow.Run, error) {
	return s.store.GetWorkflowRun(id)
}

// ListRunsByPlan 返回某个 Plan 的全部 Run（新→旧），供 Plan 页恢复并
// 展示最近一次启动的聚合状态。
func (s *WorkflowService) ListRunsByPlan(planID int64) ([]workflow.Run, error) {
	return s.store.ListWorkflowRunsByPlan(planID)
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
