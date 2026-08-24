package server

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"paihuo/internal/events"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

// approveReviewTask 固化已审批分支，并原子创建一个同角色的代码合并任务。
// 合并任务会在自己的 worktree 中处理冲突、验证结果，成功后写入主分支。
// 判定无改动（Snapshot 后任务分支与主 HEAD 一致）时**保留人工审批**，但
// 不创建合并任务，直接把源任务落成已交付终态——「审批」与「合并」独立。
func (s *Server) approveReviewTask(w http.ResponseWriter, source store.Task) {
	if source.RoleID == nil {
		writeErr(w, http.StatusBadRequest, "原任务未指派角色，无法创建合并任务")
		return
	}
	if strings.TrimSpace(source.ProjectDir) == "" {
		writeErr(w, http.StatusBadRequest, "原任务未绑定项目，无法创建合并任务")
		return
	}
	if source.WorktreeBranch != "" {
		if _, err := workspace.Snapshot(source, s.sessionsRoot); err != nil {
			writeErr(w, http.StatusConflict, "保存审批改动失败: "+err.Error())
			return
		}
	}
	changed, derr := workspace.HasTaskBranchChanges(source.ProjectDir, source)
	if derr == nil && !changed {
		if err := s.st.ApproveTaskDeliver(source.ID); err != nil {
			writeErr(w, http.StatusConflict, err.Error())
			return
		}
		if s.ex != nil {
			if err := s.ex.CleanupTaskResources(source); err != nil {
				log.Printf("⚠ 任务 %d 审批通过后清理资源失败: %v", source.ID, err)
			}
		}
		if l, err := s.st.AppendLog(store.TaskLog{
			TaskID: source.ID, Stream: "sys", Content: "✓ 审批通过（无改动，跳过合并任务）",
		}); err == nil {
			s.hub.Publish(events.Event{Type: "log", TaskID: source.ID, Payload: l})
		}
		approved, err := s.st.GetTask(source.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.hub.Publish(events.Event{Type: "task", TaskID: approved.ID, Payload: approved})
		s.ex.Wake()
		writeJSON(w, http.StatusOK, approved)
		return
	}
	merge := store.NewMergeTask(source) // 自动创建的合并任务默认串行（未勾选并发）
	mergeID, err := s.st.ApproveTaskAndCreateMerge(source.ID, merge)
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	if l, err := s.st.AppendLog(store.TaskLog{
		TaskID: source.ID, Stream: "sys", Content: fmt.Sprintf("✓ 审批通过，已创建代码合并任务 #%d", mergeID),
	}); err == nil {
		s.hub.Publish(events.Event{Type: "log", TaskID: source.ID, Payload: l})
	}
	approved, err := s.st.GetTask(source.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	mergeTask, err := s.st.GetTask(mergeID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.Publish(events.Event{Type: "task", TaskID: approved.ID, Payload: approved})
	s.hub.Publish(events.Event{Type: "task", TaskID: mergeTask.ID, Payload: mergeTask})
	s.ex.Wake()
	writeJSON(w, http.StatusOK, approved)
}
