package application

import (
	"fmt"
	"strings"

	paiexec "paihuo/internal/exec"
	"paihuo/internal/store"
)

type TaskLifecycle struct {
	store    *store.Store
	runtimes *paiexec.RuntimeService
	executor *paiexec.Executor
}

type CreateTaskRequest struct {
	Title          string `json:"title"`
	Body           string `json:"body"`
	RoleID         *int64 `json:"role_id"`
	ProjectID      *int64 `json:"project_id"`
	ExternalKey    string `json:"external_key,omitempty"`
	Permission     string `json:"perm"`
	RunMode        string `json:"run_mode"`
	Concurrent     bool   `json:"concurrent"`
	DependencyMode string `json:"dependency_mode"`
	DependsOn      *int64 `json:"depends_on"`
	BlockOnFailure bool   `json:"block_on_failure"`
	ParentID       *int64 `json:"parent_id"`
	ResumeOf       *int64 `json:"resume_of,omitempty"`
	// 定时属性（正交）：cron 非空时创建定时定义任务，永不直接执行。
	Cron    string `json:"cron"`
	Enabled bool   `json:"enabled"`
}

func NewTaskLifecycle(st *store.Store, runtimes *paiexec.RuntimeService, executor *paiexec.Executor) *TaskLifecycle {
	return &TaskLifecycle{store: st, runtimes: runtimes, executor: executor}
}

func (s *TaskLifecycle) Create(request CreateTaskRequest) (*store.Task, error) {
	request.Title = strings.TrimSpace(request.Title)
	if request.Title == "" {
		return nil, fmt.Errorf("标题不能为空")
	}
	if request.Permission == "" {
		request.Permission = store.PermFull
	}
	if request.Permission != store.PermFull && request.Permission != store.PermReview {
		return nil, fmt.Errorf("非法权限模式: %s", request.Permission)
	}
	if request.RunMode == "" {
		request.RunMode = store.RunModeBatch
	}
	if request.RunMode != store.RunModeBatch && request.RunMode != store.RunModeInteractive {
		return nil, fmt.Errorf("非法执行方式: %s", request.RunMode)
	}
	task := store.Task{Title: request.Title, Body: request.Body, Status: store.StatusQueued, Perm: request.Permission, RunMode: request.RunMode,
		Concurrent: request.Concurrent, RoleID: request.RoleID, ProjectID: request.ProjectID, ParentID: request.ParentID, ResumeOf: request.ResumeOf, ExternalKey: request.ExternalKey,
		DependencyMode: request.DependencyMode, DependsOn: request.DependsOn, BlockOnFailure: request.BlockOnFailure,
		Cron: request.Cron, Enabled: request.Enabled}
	if request.ProjectID != nil {
		project, err := s.store.GetProject(*request.ProjectID)
		if err != nil {
			return nil, fmt.Errorf("项目不存在")
		}
		task.ProjectDir = project.ProjectDir
	}
	if request.RoleID != nil {
		role, err := s.store.GetRole(*request.RoleID)
		if err != nil {
			return nil, fmt.Errorf("角色不存在")
		}
		if !role.Enabled {
			return nil, fmt.Errorf("角色未启用")
		}
		if request.RunMode == store.RunModeInteractive && request.ResumeOf == nil && !s.runtimes.Supports(role.RuntimeID, paiexec.CapabilityInteractive) {
			return nil, fmt.Errorf("Runtime %s 不支持交互式任务", role.RuntimeID)
		}
	} else if request.RunMode == store.RunModeInteractive {
		return nil, fmt.Errorf("交互式任务必须指派角色")
	}
	if err := normalizeDependency(&task); err != nil {
		return nil, err
	}
	id, err := s.store.CreateTaskWithProjectDependency(task)
	if err != nil {
		return nil, err
	}
	if s.executor != nil && task.Cron == "" {
		s.executor.Wake()
	}
	return s.store.GetTask(id)
}

func normalizeDependency(task *store.Task) error {
	if task.DependencyMode == "" {
		if task.ProjectID == nil {
			task.DependencyMode = store.DependencyNone
		} else {
			task.DependencyMode = store.DependencyWeak
		}
	}
	switch task.DependencyMode {
	case store.DependencyNone:
		task.DependsOn = nil
	case store.DependencyWeak:
		if task.ProjectID == nil {
			return fmt.Errorf("无项目任务不能使用自动前置依赖")
		}
		task.DependsOn = nil
	case store.DependencyStrong:
		if task.ProjectID == nil {
			return fmt.Errorf("明确前置依赖只能用于项目任务")
		}
		if task.DependsOn == nil || *task.DependsOn < 1 {
			return fmt.Errorf("明确依赖必须指定前置任务")
		}
	default:
		return fmt.Errorf("非法依赖模式")
	}
	return nil
}

var manualTaskTransitions = map[string]map[string]bool{
	store.StatusQueued: {store.StatusCancelled: true}, store.StatusClaimed: {store.StatusCancelled: true}, store.StatusRunning: {store.StatusCancelled: true},
	store.StatusAwaitingReview: {store.StatusQueued: true, store.StatusSucceeded: true, store.StatusCancelled: true},
	store.StatusSucceeded:      {store.StatusQueued: true}, store.StatusFailed: {store.StatusQueued: true}, store.StatusCancelled: {store.StatusQueued: true},
}

func (s *TaskLifecycle) CanTransition(from, to string) bool { return manualTaskTransitions[from][to] }
