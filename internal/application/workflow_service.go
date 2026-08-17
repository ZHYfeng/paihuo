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

// WorkflowService 管理工作流任务（type=workflow）：创建/查询/编辑/删除
// （增删查改）+ 启动 Run 时绑定具体项目实例化节点任务。定义创建即完成
// 确定性策略校验（adopted），之后可整体替换（重新校验 + spec_hash，受
// revision 保护）或删除；Proposal/Plan 概念已折叠。
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

// WorkflowValidationError 携带策略校验违规列表，供 API 返回 422 + 明细。
type WorkflowValidationError struct {
	Violations []workflow.Violation
}

func (e *WorkflowValidationError) Error() string {
	if len(e.Violations) == 0 {
		return "Workflow 策略校验失败"
	}
	return "Workflow 策略校验失败: " + e.Violations[0].Message
}

// prepareSpec 应用默认值并完成策略校验与定时项目绑定检查；校验失败返回
// WorkflowValidationError。创建与编辑共用同一套校验，保证定义永远合法。
func (s *WorkflowService) prepareSpec(spec workflow.Spec, cron string, projectID *int64) (workflow.Spec, error) {
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
	if violations := s.policy.Validate(spec); len(violations) > 0 {
		return spec, &WorkflowValidationError{Violations: violations}
	}
	if cron != "" && projectID == nil {
		return spec, fmt.Errorf("定时工作流必须绑定目标项目")
	}
	if projectID != nil {
		project, err := s.store.GetProject(*projectID)
		if err != nil {
			return spec, fmt.Errorf("项目不存在")
		}
		if project.Status != "active" {
			return spec, fmt.Errorf("项目不可用")
		}
	}
	return spec, nil
}

// CreateWorkflow 创建工作流任务（status=adopted + spec_hash）。
// spec 不绑定项目；定时工作流（cron 非空）必须绑定目标项目，供定时触发
// 启动 Run 时使用。策略校验失败返回 WorkflowValidationError，不落库。
func (s *WorkflowService) CreateWorkflow(spec workflow.Spec, cron string, enabled bool, projectID *int64) (*store.Task, error) {
	spec, err := s.prepareSpec(spec, cron, projectID)
	if err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(canonical)
	id, err := s.store.CreateWorkflowTask(spec, cron, enabled, projectID, hex.EncodeToString(hash[:]))
	if err != nil {
		return nil, err
	}
	created, err := s.store.GetWorkflowTask(id)
	if err == nil {
		s.events.Publish(events.Event{Type: "workflow.created", Payload: created})
	}
	return created, err
}

// UpdateWorkflow 整体替换工作流定义：重新策略校验后重写 spec/spec_hash 与
// 定时属性并 bump revision。revision 不符返回 ErrRevisionConflict；已实例化
// 的 Run 及其节点任务不受影响。校验失败返回 WorkflowValidationError，不落库。
func (s *WorkflowService) UpdateWorkflow(id, expectedRevision int64, spec workflow.Spec, cron string, enabled bool, projectID *int64) (*store.Task, error) {
	tk, err := s.store.GetWorkflowTask(id)
	if err != nil {
		return nil, err
	}
	if tk == nil || tk.Type != store.TaskTypeWorkflow {
		return nil, sql.ErrNoRows
	}
	if tk.Revision != expectedRevision {
		return nil, store.ErrRevisionConflict
	}
	spec, err = s.prepareSpec(spec, cron, projectID)
	if err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(canonical)
	updated, err := s.store.UpdateWorkflowTask(id, expectedRevision, spec, cron, enabled, projectID, hex.EncodeToString(hash[:]))
	if err != nil {
		return nil, err
	}
	s.events.Publish(events.Event{Type: "workflow.updated", Payload: updated})
	return updated, nil
}

// DeleteWorkflow 删除工作流定义及其 Run 书签；节点任务解除 Run 关联后保留
// 为任务历史。有进行中的 Run 时返回 ErrWorkflowRunsActive。
func (s *WorkflowService) DeleteWorkflow(id, expectedRevision int64) error {
	tk, err := s.store.GetWorkflowTask(id)
	if err != nil {
		return err
	}
	if tk == nil || tk.Type != store.TaskTypeWorkflow {
		return sql.ErrNoRows
	}
	if tk.Revision != expectedRevision {
		return store.ErrRevisionConflict
	}
	if err := s.store.DeleteWorkflowTask(id, expectedRevision); err != nil {
		return err
	}
	s.events.Publish(events.Event{Type: "workflow.deleted", Payload: map[string]any{"id": id}})
	return nil
}

// StartPlan 从工作流定义原子实例化一次 Run，绑定 projectID 项目。
func (s *WorkflowService) StartPlan(id, expectedRevision, projectID int64) (*workflow.Run, error) {
	if projectID < 1 {
		return nil, fmt.Errorf("启动 Run 必须指定项目")
	}
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
	if tk.Status != workflow.WorkflowStatusAdopted {
		return nil, fmt.Errorf("工作流定义不可用，无法启动")
	}
	spec, err := specOf(tk)
	if err != nil {
		return nil, err
	}
	if violations := s.policy.Validate(spec); len(violations) > 0 {
		return nil, fmt.Errorf("Workflow 当前不可运行: %s", violations[0].Message)
	}
	run, err := s.store.InstantiateWorkflow(*tk, projectID)
	if err != nil {
		return nil, err
	}
	if s.executor != nil {
		s.executor.Wake()
	}
	s.events.Publish(events.Event{Type: "workflow.run.started", Payload: run})
	return run, nil
}

// ListWorkflows 返回全部工作流任务（新→旧）。
func (s *WorkflowService) ListWorkflows() ([]store.Task, error) {
	return s.store.ListWorkflowTasks()
}

func (s *WorkflowService) GetWorkflow(id int64) (*store.Task, error) {
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
