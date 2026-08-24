package application

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

type TaskTransitionRequest struct {
	Status            string
	Fields            map[string]any
	DependencyChanged bool
	ScheduleChanged   bool
}

// ValidateTransition lets transports preserve status-error precedence while
// keeping the rule itself in application. Transition repeats these checks
// immediately before side effects so this read-only preflight is not trusted
// as a concurrency guard.
func (s *TaskLifecycle) ValidateTransition(id, expectedRevision int64, target string) error {
	source, err := s.taskAtRevision(id, expectedRevision)
	if err != nil {
		return err
	}
	if !canTransitionTask(source.Status, target) {
		return taskError(TaskErrorInvalid, "不允许从 "+source.Status+" 转为 "+target, nil)
	}
	if target == store.StatusQueued {
		return s.validateRequeue(*source)
	}
	return nil
}

// Transition is the shared status entry for transport callers. It dispatches
// only after loading the current Task at the expected revision; individual
// use-case methods below remain directly reusable by non-HTTP callers.
func (s *TaskLifecycle) Transition(ctx context.Context, id, expectedRevision int64, request TaskTransitionRequest) (*store.Task, error) {
	source, err := s.taskAtRevision(id, expectedRevision)
	if err != nil {
		return nil, err
	}
	if !canTransitionTask(source.Status, request.Status) {
		return nil, taskError(TaskErrorInvalid, "不允许从 "+source.Status+" 转为 "+request.Status, nil)
	}
	switch request.Status {
	case store.StatusSucceeded:
		if len(request.Fields) != 1 {
			return nil, taskError(TaskErrorInvalid, "审批通过不能同时修改任务其他字段", nil)
		}
		return s.approve(ctx, *source, expectedRevision)
	case store.StatusQueued:
		return s.requeue(ctx, *source, expectedRevision, request)
	case store.StatusCancelled:
		return s.cancel(ctx, *source, expectedRevision, request)
	default:
		return nil, taskError(TaskErrorInvalid, "不允许从 "+source.Status+" 转为 "+request.Status, nil)
	}
}

func (s *TaskLifecycle) Approve(ctx context.Context, id, expectedRevision int64) (*store.Task, error) {
	source, err := s.taskAtRevision(id, expectedRevision)
	if err != nil {
		return nil, err
	}
	if !canTransitionTask(source.Status, store.StatusSucceeded) {
		return nil, taskError(TaskErrorInvalid, "不允许从 "+source.Status+" 转为 "+store.StatusSucceeded, nil)
	}
	return s.approve(ctx, *source, expectedRevision)
}

func (s *TaskLifecycle) approve(_ context.Context, source store.Task, expectedRevision int64) (*store.Task, error) {
	if source.RoleID == nil {
		return nil, taskError(TaskErrorInvalid, "原任务未指派角色，无法创建合并任务", nil)
	}
	if strings.TrimSpace(source.ProjectDir) == "" {
		return nil, taskError(TaskErrorInvalid, "原任务未绑定项目，无法创建合并任务", nil)
	}
	if source.WorktreeBranch != "" {
		if _, err := workspace.Snapshot(source, s.sessionsRoot); err != nil {
			return nil, taskError(TaskErrorConflict, "保存审批改动失败: "+err.Error(), err)
		}
	}
	changed, diffErr := workspace.HasTaskBranchChanges(source.ProjectDir, source)
	if diffErr == nil && !changed {
		if err := s.store.ApproveTaskDeliver(source.ID, expectedRevision); err != nil {
			return nil, transitionStoreError(err, TaskErrorConflict)
		}
		if s.executor != nil {
			// Approval has already committed. Cleanup remains best-effort, as it
			// was in the transport implementation, and must not roll back delivery.
			if err := s.executor.CleanupTaskResources(source); err != nil {
				log.Printf("⚠ 任务 %d 审批通过后清理资源失败: %v", source.ID, err)
			}
		}
		s.appendLog(source.ID, "✓ 审批通过（无改动，跳过合并任务）")
		approved, err := s.store.GetTask(source.ID)
		if err != nil {
			return nil, taskError(TaskErrorInternal, err.Error(), err)
		}
		s.publishTask(approved)
		s.wake()
		return approved, nil
	}

	merge := store.NewMergeTask(source)
	mergeID, err := s.store.ApproveTaskAndCreateMerge(source.ID, expectedRevision, merge)
	if err != nil {
		return nil, transitionStoreError(err, TaskErrorConflict)
	}
	s.appendLog(source.ID, fmt.Sprintf("✓ 审批通过，已创建代码合并任务 #%d", mergeID))
	approved, err := s.store.GetTask(source.ID)
	if err != nil {
		return nil, taskError(TaskErrorInternal, err.Error(), err)
	}
	mergeTask, err := s.store.GetTask(mergeID)
	if err != nil {
		return nil, taskError(TaskErrorInternal, err.Error(), err)
	}
	s.publishTask(approved)
	s.publishTask(mergeTask)
	s.wake()
	return approved, nil
}

func (s *TaskLifecycle) Requeue(ctx context.Context, id, expectedRevision int64, request TaskTransitionRequest) (*store.Task, error) {
	source, err := s.taskAtRevision(id, expectedRevision)
	if err != nil {
		return nil, err
	}
	if !canTransitionTask(source.Status, store.StatusQueued) {
		return nil, taskError(TaskErrorInvalid, "不允许从 "+source.Status+" 转为 "+store.StatusQueued, nil)
	}
	request.Status = store.StatusQueued
	return s.requeue(ctx, *source, expectedRevision, request)
}

func (s *TaskLifecycle) requeue(_ context.Context, source store.Task, expectedRevision int64, request TaskTransitionRequest) (*store.Task, error) {
	if err := s.validateRequeue(source); err != nil {
		return nil, err
	}

	set := cloneTaskFields(request.Fields)
	set["status"] = store.StatusQueued
	set["started_at"] = nil
	set["finished_at"] = nil
	set["error"] = ""
	set["exit_code"] = nil
	if source.Status == store.StatusAwaitingReview {
		if note, ok := set["review_note"]; ok {
			trimmed := strings.TrimSpace(fmt.Sprint(note))
			if trimmed != "" {
				body := source.Body
				if body != "" {
					body += "\n\n"
				}
				body += fmt.Sprintf("【修改意见 第 %d 轮 %s】%s", source.ReviewRounds, time.Now().Format("2006-01-02 15:04"), trimmed)
				set["body"] = body
			}
		}
		delete(set, "review_note")
		if s.executor != nil {
			s.executor.ResetTaskSession(source.ID)
		}
	}
	request.Fields = set
	updated, err := s.updateTransition(source.ID, expectedRevision, request)
	if err != nil {
		return nil, err
	}
	s.wake()
	return updated, nil
}

func (s *TaskLifecycle) Cancel(ctx context.Context, id, expectedRevision int64, request TaskTransitionRequest) (*store.Task, error) {
	source, err := s.taskAtRevision(id, expectedRevision)
	if err != nil {
		return nil, err
	}
	if !canTransitionTask(source.Status, store.StatusCancelled) {
		return nil, taskError(TaskErrorInvalid, "不允许从 "+source.Status+" 转为 "+store.StatusCancelled, nil)
	}
	request.Status = store.StatusCancelled
	return s.cancel(ctx, *source, expectedRevision, request)
}

func (s *TaskLifecycle) cancel(_ context.Context, source store.Task, expectedRevision int64, request TaskTransitionRequest) (*store.Task, error) {
	if s.executor != nil {
		s.executor.CancelTask(source.ID)
	}
	set := cloneTaskFields(request.Fields)
	set["status"] = store.StatusCancelled
	request.Fields = set
	return s.updateTransition(source.ID, expectedRevision, request)
}

func (s *TaskLifecycle) Resume(_ context.Context, id, expectedRevision int64) (*store.Task, error) {
	source, err := s.taskAtRevision(id, expectedRevision)
	if err != nil {
		return nil, err
	}
	if source.RoleID == nil {
		return nil, taskError(TaskErrorInvalid, "原任务未指派角色，无法续跑", nil)
	}
	if !terminalTaskStatus(source.Status) {
		return nil, taskError(TaskErrorConflict, "只有已完成、失败或已取消的任务可以继续对话", nil)
	}
	if source.Status == store.StatusSucceeded && source.MergeOf == nil {
		obligated, err := s.sourceHasOrNeedsMerge(*source)
		if err != nil {
			return nil, taskError(TaskErrorInternal, err.Error(), err)
		}
		if obligated {
			return nil, taskError(TaskErrorConflict, "源任务代码已完成，系统正在或已经执行代码合并；请查看对应合并任务", nil)
		}
	}
	if source.Status == store.StatusSucceeded && source.MergeOf != nil {
		return nil, taskError(TaskErrorConflict, "代码合并任务已成功，不能继续对话或重复合并", nil)
	}
	resumed, err := s.store.ResumeTask(id, expectedRevision)
	if err != nil {
		return nil, transitionStoreError(err, TaskErrorInternal)
	}
	if !resumed {
		return nil, taskError(TaskErrorConflict, "任务状态已变化，无法继续对话", nil)
	}
	s.appendLog(id, "↻ 在原任务中继续：保留会话、工作空间和历史日志")
	updated, err := s.store.GetTask(id)
	if err != nil {
		return nil, taskError(TaskErrorInternal, err.Error(), err)
	}
	s.publishTask(updated)
	s.wake()
	return updated, nil
}

func (s *TaskLifecycle) updateTransition(id, expectedRevision int64, request TaskTransitionRequest) (*store.Task, error) {
	var err error
	if request.DependencyChanged {
		err = s.store.UpdateTaskAtRevision(id, expectedRevision, request.Fields)
	} else {
		err = s.store.UpdateAtRevision("task", id, expectedRevision, request.Fields)
	}
	if err != nil {
		return nil, transitionStoreError(err, TaskErrorInternal)
	}
	if request.ScheduleChanged && s.schedules != nil {
		s.schedules.Reload()
	}
	if _, changed := request.Fields["block_on_failure"]; changed {
		s.wake()
	}
	if request.DependencyChanged {
		s.wake()
	}
	updated, err := s.store.GetTask(id)
	if err != nil {
		return nil, taskError(TaskErrorInternal, err.Error(), err)
	}
	return updated, nil
}

func (s *TaskLifecycle) taskAtRevision(id, expectedRevision int64) (*store.Task, error) {
	task, err := s.store.GetTask(id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, taskError(TaskErrorNotFound, "任务不存在", err)
	}
	if err != nil {
		return nil, taskError(TaskErrorInternal, err.Error(), err)
	}
	if task.Revision != expectedRevision {
		return nil, taskError(TaskErrorRevisionConflict, store.ErrRevisionConflict.Error(), store.ErrRevisionConflict)
	}
	return task, nil
}

func transitionStoreError(err error, fallback TaskErrorKind) error {
	if errors.Is(err, store.ErrRevisionConflict) {
		return taskError(TaskErrorRevisionConflict, store.ErrRevisionConflict.Error(), err)
	}
	var dependencyErr *store.TaskDependencyUpdateError
	if errors.As(err, &dependencyErr) {
		return taskError(TaskErrorInvalid, err.Error(), err)
	}
	return taskError(fallback, err.Error(), err)
}

func (s *TaskLifecycle) validateRequeue(source store.Task) error {
	if source.Status == store.StatusSucceeded && source.MergeOf == nil {
		obligated, err := s.sourceHasOrNeedsMerge(source)
		if err != nil {
			return taskError(TaskErrorInternal, err.Error(), err)
		}
		if obligated {
			return taskError(TaskErrorConflict, "源任务代码已完成，系统正在或已经执行代码合并；请重试对应合并任务", nil)
		}
	}
	if source.Status == store.StatusSucceeded && source.MergeOf != nil {
		return taskError(TaskErrorConflict, "代码合并任务已成功，不能重试或重复合并", nil)
	}
	return nil
}

func (s *TaskLifecycle) sourceHasOrNeedsMerge(task store.Task) (bool, error) {
	if task.MergeOf != nil {
		return false, nil
	}
	if task.WorktreeBranch != "" {
		return true, nil
	}
	return s.store.HasMergeTaskForSource(task.ID)
}

func terminalTaskStatus(status string) bool {
	return status == store.StatusSucceeded || status == store.StatusFailed || status == store.StatusCancelled
}

func cloneTaskFields(fields map[string]any) map[string]any {
	cloned := make(map[string]any, len(fields)+5)
	for key, value := range fields {
		cloned[key] = value
	}
	return cloned
}

func (s *TaskLifecycle) appendLog(taskID int64, content string) {
	logEntry, err := s.store.AppendLog(store.TaskLog{TaskID: taskID, Stream: "sys", Content: content})
	if err == nil && s.events != nil {
		s.events.Publish(events.Event{Type: "log", TaskID: taskID, Payload: logEntry})
	}
}

func (s *TaskLifecycle) publishTask(task *store.Task) {
	if task != nil && s.events != nil {
		s.events.Publish(events.Event{Type: "task", TaskID: task.ID, Payload: task})
	}
}

func (s *TaskLifecycle) wake() {
	if s.executor != nil {
		s.executor.Wake()
	}
}
