package application

import (
	"fmt"
	"strings"

	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

type WorkspaceService struct {
	store        *store.Store
	sessionsRoot string
}

func NewWorkspaceService(st *store.Store, sessionsRoot string) *WorkspaceService {
	return &WorkspaceService{store: st, sessionsRoot: sessionsRoot}
}

func (s *WorkspaceService) Status(taskID int64) (workspace.Info, error) {
	task, err := s.store.GetTask(taskID)
	if err != nil {
		return workspace.Info{}, err
	}
	return workspace.Status(*task, s.sessionsRoot), nil
}

func (s *WorkspaceService) Discard(taskID int64) error {
	task, err := s.store.GetTask(taskID)
	if err != nil {
		return err
	}
	if task.MergeOf != nil && task.Status != store.StatusSucceeded {
		return fmt.Errorf("代码合并任务尚未成功；如需放弃代码，请删除源任务")
	}
	if task.Status != store.StatusSucceeded && task.Status != store.StatusFailed && task.Status != store.StatusCancelled {
		return fmt.Errorf("任务尚未结束，不能丢弃工作空间")
	}
	if task.MergeOf == nil && task.Status == store.StatusSucceeded {
		hasMerge, err := s.store.HasMergeTaskForSource(task.ID)
		if err != nil {
			return err
		}
		if task.WorktreeBranch != "" && !hasMerge {
			return fmt.Errorf("代码合并任务正在创建；如需放弃代码，请删除源任务")
		}
		tasks, err := s.store.ListTaskDeletionOrder(task.ID)
		if err != nil {
			return err
		}
		for _, child := range tasks {
			if child.MergeOf != nil && *child.MergeOf == task.ID && child.Status != store.StatusSucceeded {
				return fmt.Errorf("代码合并任务尚未成功；如需放弃代码，请删除源任务")
			}
		}
	}
	return workspace.Discard(*task, s.sessionsRoot)
}

func (s *WorkspaceService) InitGit(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("需要 path")
	}
	return workspace.GitInit(path)
}
