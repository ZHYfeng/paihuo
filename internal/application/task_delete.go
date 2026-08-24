package application

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"paihuo/internal/store"
)

func (s *TaskLifecycle) Delete(ctx context.Context, id, expectedRevision int64) error {
	target, err := s.taskAtRevision(id, expectedRevision)
	if err != nil {
		return err
	}
	if target.MergeOf != nil {
		return taskError(TaskErrorConflict, "代码合并任务不能单独删除；请重试它，或删除源任务以放弃整组代码", nil)
	}
	tasks, err := s.store.ListTaskDeletionOrder(id)
	if err != nil {
		return taskError(TaskErrorInternal, err.Error(), err)
	}
	deleting := make(map[int64]bool, len(tasks))
	for _, task := range tasks {
		deleting[task.ID] = true
	}
	if s.executor == nil {
		return taskError(TaskErrorInternal, "Task Executor 不可用", nil)
	}
	for _, task := range tasks {
		dependents, err := s.store.ListTaskDependents(task.ID)
		if err != nil {
			return taskError(TaskErrorInternal, err.Error(), err)
		}
		for _, dependent := range dependents {
			if !deleting[dependent.ID] && dependent.DependencyMode == store.DependencyStrong {
				message := fmt.Sprintf("任务 #%d 仍以前置任务 #%d 为强依赖；请先处理或删除后项", dependent.ID, task.ID)
				return taskError(TaskErrorConflict, message, nil)
			}
		}
	}

	// This is the first side effect and remains revision-conditional. A stale
	// request cannot stop Runtime processes or remove a worktree.
	if err := s.store.UpdateAtRevision("task", id, expectedRevision, map[string]any{
		"status": store.StatusCancelled, "finished_at": store.Now(), "error": "任务已删除",
	}); err != nil {
		return transitionStoreError(err, TaskErrorInternal)
	}
	for _, task := range tasks {
		if task.ID == id {
			continue
		}
		if err := s.store.UpdateTask(task.ID, map[string]any{
			"status": store.StatusCancelled, "finished_at": store.Now(), "error": "父任务已删除",
		}); err != nil {
			return taskError(TaskErrorInternal, err.Error(), err)
		}
	}
	for _, task := range tasks {
		if err := s.executor.CleanupTaskResources(task); err != nil {
			message := fmt.Sprintf("清理任务 #%d 资源失败: %v", task.ID, err)
			return taskError(TaskErrorConflict, message, err)
		}
	}

	deliveredSessions, err := s.store.ListSessionsForTask(id)
	if err != nil {
		return taskError(TaskErrorInternal, err.Error(), err)
	}
	if err := s.store.DeleteTask(id); err != nil {
		var dependencyErr *store.TaskDependencyError
		switch {
		case errors.As(err, &dependencyErr):
			message := fmt.Sprintf("任务 #%d 仍以前置任务 #%d 为强依赖；请先处理或删除后项", dependencyErr.DependentID, dependencyErr.SourceID)
			return taskError(TaskErrorConflict, message, err)
		case errors.Is(err, sql.ErrNoRows):
			return taskError(TaskErrorNotFound, "任务不存在", err)
		default:
			return taskError(TaskErrorInternal, err.Error(), err)
		}
	}
	if len(deliveredSessions) > 0 && s.sessions == nil {
		return taskError(TaskErrorInternal, "Session Manager 不可用", nil)
	}
	for _, sessionID := range deliveredSessions {
		deleteCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := s.sessions.Delete(deleteCtx, sessionID)
		cancel()
		if err != nil {
			return taskError(TaskErrorInternal, err.Error(), err)
		}
	}
	if s.schedules != nil {
		s.schedules.Reload()
	}
	return nil
}
