package server

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"paihuo/internal/application"
	"paihuo/internal/events"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

func (s *Server) registerTaskRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/tasks", s.listTasks)
	mux.HandleFunc("POST /api/v1/tasks", s.createTask)
	mux.HandleFunc("GET /api/v1/tasks/{id}", s.getTask)
	mux.HandleFunc("PATCH /api/v1/tasks/{id}", s.patchTask)
	mux.HandleFunc("DELETE /api/v1/tasks/{id}", s.deleteTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/resume", s.resumeTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/input", s.sendTaskInput)
	mux.HandleFunc("POST /api/v1/tasks/{id}/resize", s.resizeTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/end-session", s.endSession)
	mux.HandleFunc("GET /api/v1/tasks/{id}/logs", s.getTaskLogs)
	mux.HandleFunc("GET /api/v1/tasks/{id}/diff", s.taskDiff)
	mux.HandleFunc("GET /api/v1/tasks/{id}/children", s.getTaskChildren)
	mux.HandleFunc("POST /api/v1/tasks/cleanup", s.cleanupTasks)
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.TaskFilter{}
	if v := q.Get("role_id"); v != "" {
		if id, err := strconv.ParseInt(v, 10, 64); err == nil && id > 0 {
			f.RoleID = &id
		}
	}
	if v := q.Get("project_id"); v != "" {
		if id, err := strconv.ParseInt(v, 10, 64); err == nil && id > 0 {
			f.ProjectID = &id
		}
	}
	f.Status = q.Get("status")
	// 形态过滤：task（默认）/ session / workflow；定时页用 scheduled=1 汇总
	// 所有形态的定时定义（cron 非空），不限制 type。
	switch q.Get("type") {
	case store.TaskTypeSession, store.TaskTypeWorkflow, store.TaskTypeTask:
		f.Type = q.Get("type")
	default:
		if q.Get("scheduled") != "1" {
			f.Type = store.TaskTypeTask
		}
	}
	if q.Get("scheduled") == "1" {
		only := true
		f.Scheduled = &only
	} else {
		exclude := false
		f.Scheduled = &exclude
	}
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			f.Limit = n
		}
	}
	tasks, err := s.st.ListTasksFiltered(f)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	var in application.CreateTaskRequest
	if !readJSON(w, r, &in) {
		return
	}
	task, err := s.tasks.Create(in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.Cron != "" {
		s.sched.Reload()
	}
	writeResource(w, http.StatusCreated, task.Revision, task)
}

// resumeTask 在原任务上续跑。任务 ID 同时绑定 agent 会话目录和 git worktree，
// 因此不能创建新任务；保留上下文，仅清空本轮执行状态后重新入队。
func (s *Server) resumeTask(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	src, err := s.st.GetTask(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "任务不存在")
		return
	}
	if src.RoleID == nil {
		writeErr(w, http.StatusBadRequest, "原任务未指派角色，无法续跑")
		return
	}
	if !isTerminalTaskStatus(src.Status) {
		writeErr(w, http.StatusConflict, "只有已完成、失败或已取消的任务可以继续对话")
		return
	}
	// 成功的 Git 源任务进入的是「必须合并」链路：无论 child 已经存在还是
	// 正在由周期对账补建，都不能回头重跑源任务并覆盖已完成的代码结果。
	if src.Status == store.StatusSucceeded && src.MergeOf == nil {
		obligated, err := s.sourceHasOrNeedsMerge(*src)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if obligated {
			writeErr(w, http.StatusConflict, "源任务代码已完成，系统正在或已经执行代码合并；请查看对应合并任务")
			return
		}
	}
	if src.Status == store.StatusSucceeded && src.MergeOf != nil {
		writeErr(w, http.StatusConflict, "代码合并任务已成功，不能继续对话或重复合并")
		return
	}
	resumed, err := s.st.ResumeTask(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !resumed {
		writeErr(w, http.StatusConflict, "任务状态已变化，无法继续对话")
		return
	}
	if l, err := s.st.AppendLog(store.TaskLog{
		TaskID: id, Stream: "sys", Content: "↻ 在原任务中继续：保留会话、工作空间和历史日志",
	}); err == nil {
		s.hub.Publish(events.Event{Type: "log", TaskID: id, Payload: l})
	}
	tk, err := s.st.GetTask(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.Publish(events.Event{Type: "task", TaskID: id, Payload: tk})
	s.ex.Wake()
	writeJSON(w, http.StatusOK, tk)
}

func isTerminalTaskStatus(status string) bool {
	return status == store.StatusSucceeded || status == store.StatusFailed || status == store.StatusCancelled
}

// sourceHasOrNeedsMerge 覆盖正常 Git 源任务（已有 worktree）与旧数据/竞态
// （child 已存在但源任务未留下 branch）两种情况，避免成功源任务被回退重跑而
// 绕过确定性的合并链路。
func (s *Server) sourceHasOrNeedsMerge(tk store.Task) (bool, error) {
	if tk.MergeOf != nil {
		return false, nil
	}
	if tk.WorktreeBranch != "" {
		return true, nil
	}
	return s.st.HasMergeTaskForSource(tk.ID)
}

// sendTaskInput 把已登录用户的整行消息或 xterm 原始按键送进运行中的 agent
// 交互式 pane；两种模式互斥，避免同一请求被重复提交。
// endSession 向交互式任务发送其 CLI 的退出命令（如 pi 的 /quit）。
func (s *Server) endSession(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := s.st.GetTask(id); err != nil {
		writeErr(w, http.StatusNotFound, "任务不存在")
		return
	}
	cmd, err := s.ex.EndSession(id)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sent": cmd})
}

// resizeTask 把浏览器交互终端的尺寸同步给运行中的任务窗口（tmux resize-window）。
func (s *Server) resizeTask(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := s.st.GetTask(id); err != nil {
		writeErr(w, http.StatusNotFound, "任务不存在")
		return
	}
	var in struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.ex.Resize(id, in.Cols, in.Rows); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"resized": true})
}

func (s *Server) sendTaskInput(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := s.st.GetTask(id); err != nil {
		writeErr(w, http.StatusNotFound, "任务不存在")
		return
	}
	var in struct {
		Message *string `json:"message"`
		Keys    *string `json:"keys"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if (in.Message == nil) == (in.Keys == nil) {
		writeErr(w, http.StatusBadRequest, "message 和 keys 必须且只能提供一个")
		return
	}
	var err error
	if in.Keys != nil {
		err = s.ex.SendKeystrokes(id, *in.Keys)
	} else {
		err = s.ex.SendInput(id, *in.Message)
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"sent": true})
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	tk, err := s.st.GetTask(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "任务不存在")
		return
	}
	writeJSON(w, http.StatusOK, tk)
}
func (s *Server) getTaskLogs(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	// all=1 只供用户主动点击“复制”时使用；普通页面始终走分页接口。
	if r.URL.Query().Get("all") == "1" {
		logs, err := s.st.ListLogs(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, logs)
		return
	}
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	var before int64
	if v := r.URL.Query().Get("before"); v != "" {
		before, _ = strconv.ParseInt(v, 10, 64)
	}
	logs, hasMore, total, err := s.st.ListLogsPage(id, before, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"logs": logs, "has_more": hasMore, "total": total,
	})
}

// getTaskChildren 返回子任务列表（多 agent 协作：拆分大任务并行执行）。
func (s *Server) getTaskChildren(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	children, err := s.st.ListChildren(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, children)
}

// taskDiff 返回任务项目目录的 git 改动（审批时展示）。
func (s *Server) taskDiff(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	tk, err := s.st.GetTask(id)
	if err != nil || tk.ProjectDir == "" {
		writeJSON(w, http.StatusOK, map[string]string{"stat": "", "diff": ""})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// worktree 隔离任务：diff = base_commit 到工作区（含已提交 + 未提交的全部改动）
	info := workspace.Status(*tk, s.sessionsRoot)
	if info.IsWorktree {
		if info.BaseCommit == "" {
			writeJSON(w, http.StatusOK, map[string]string{"stat": "", "diff": "", "note": "缺少基准 commit"})
			return
		}
		stat, err1 := gitOut(ctx, info.Path, "diff", "--stat", info.BaseCommit)
		diff, err2 := gitOut(ctx, info.Path, "diff", info.BaseCommit)
		if err1 != nil || err2 != nil {
			writeJSON(w, http.StatusOK, map[string]string{"stat": "", "diff": "", "note": "读取 worktree 改动失败"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"stat": stat, "diff": diff, "branch": info.Branch})
		return
	}

	// 非 git 项目：沿用旧逻辑（项目目录工作区 diff）
	stat, err1 := gitOut(ctx, tk.ProjectDir, "diff", "--stat")
	diff, err2 := gitOut(ctx, tk.ProjectDir, "diff")
	if err1 != nil || err2 != nil {
		writeJSON(w, http.StatusOK, map[string]string{"stat": "", "diff": "", "note": "不是 git 仓库或读取失败"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"stat": stat, "diff": diff})
}
