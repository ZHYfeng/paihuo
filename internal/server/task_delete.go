package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"paihuo/internal/store"
)

func (s *Server) deleteTask(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	// 先标记根任务取消，阻止它在删除竞态中再派发新的合并子任务。
	target, err := s.st.GetTask(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "任务不存在")
		return
	}
	if target.Revision != revision {
		writeErr(w, http.StatusConflict, store.ErrRevisionConflict.Error())
		return
	}
	if target.MergeOf != nil {
		writeErr(w, http.StatusConflict, "代码合并任务不能单独删除；请重试它，或删除源任务以放弃整组代码")
		return
	}
	tasks, err := s.st.ListTaskDeletionOrder(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	deleting := make(map[int64]bool, len(tasks))
	for _, tk := range tasks {
		deleting[tk.ID] = true
	}
	// 自动生成的弱依赖会在删除事务中解除；只有明确指定的强依赖需要
	// 用户先处理，避免删除前置后让后项绕过原本的业务条件。
	for _, tk := range tasks {
		dependents, err := s.st.ListTaskDependents(tk.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, dependent := range dependents {
			if !deleting[dependent.ID] && dependent.DependencyMode == store.DependencyStrong {
				writeErr(w, http.StatusConflict, fmt.Sprintf("任务 #%d 仍以前置任务 #%d 为强依赖；请先处理或删除后项", dependent.ID, tk.ID))
				return
			}
		}
	}
	if err := s.st.UpdateTask(id, map[string]any{"status": store.StatusCancelled, "finished_at": store.Now(), "error": "任务已删除"}); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 先停止整个任务树，再删 worktree。顺序为叶子到根，合并子任务会先于
	// 源任务清理；任一步失败都保留数据库记录，方便重试。
	for _, tk := range tasks {
		if tk.ID == id {
			continue
		}
		if err := s.st.UpdateTask(tk.ID, map[string]any{"status": store.StatusCancelled, "finished_at": store.Now(), "error": "父任务已删除"}); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	for _, tk := range tasks {
		if err := s.ex.CleanupTaskResources(tk); err != nil {
			writeErr(w, http.StatusConflict, fmt.Sprintf("清理任务 #%d 资源失败: %v", tk.ID, err))
			return
		}
	}
	// 交付即终态：被删任务关联的 delivered 会话不再解冻（否则可恢复修改后
	// 反复交付、反复创建合并任务），直接联动清理（终止进程、清理 worktree、
	// 记录 → deleted）。
	deliveredSessions, err := s.st.ListSessionsForTask(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.st.DeleteTask(id); err != nil {
		var depErr *store.TaskDependencyError
		if errors.As(err, &depErr) {
			writeErr(w, http.StatusConflict, fmt.Sprintf("任务 #%d 仍以前置任务 #%d 为强依赖；请先处理或删除后项", depErr.DependentID, depErr.SourceID))
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, sid := range deliveredSessions {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		err := s.sess.Delete(ctx, sid)
		cancel()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	s.sched.Reload()
	w.WriteHeader(http.StatusNoContent)
}
