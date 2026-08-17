package server

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"paihuo/internal/application"
	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

// ---------------------------------------------------------------------------
// 任务

var validPerms = map[string]bool{
	store.PermFull: true, store.PermReview: true,
}

var validRunModes = map[string]bool{
	store.RunModeBatch: true, store.RunModeInteractive: true,
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

func (s *Server) patchTask(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	set, ok := patchMap(w, r, "title", "body", "role_id", "perm", "status", "review_note", "parent_id", "project_id", "concurrent", "block_on_failure", "cron", "enabled")
	if !ok {
		return
	}
	// 定时属性（正交）：cron/enabled 只对定时定义（cron 非空）有意义；
	// 修改后调度器立即重载。cron 非空时任务成为定时定义，永不直接执行。
	scheduleChanged := false
	if v, ok := set["cron"]; ok {
		cron, isString := v.(string)
		if !isString {
			writeErr(w, http.StatusBadRequest, "cron 必须是字符串")
			return
		}
		set["cron"] = cron
		scheduleChanged = true
	}
	if v, ok := set["enabled"]; ok {
		b, isBool := v.(bool)
		if !isBool {
			writeErr(w, http.StatusBadRequest, "enabled 必须是布尔值")
			return
		}
		set["enabled"] = b
		scheduleChanged = true
	}
	cur, err := s.st.GetTask(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "任务不存在")
		return
	}
	if cur.Revision != revision {
		writeErr(w, http.StatusConflict, store.ErrRevisionConflict.Error())
		return
	}
	// 合并子任务是系统状态机的一部分，来源、工作目录、权限和串行策略都
	// 不能在详情页被改坏；用户只需重试失败/取消的合并任务，或取消运行中
	// 的任务。角色例外：合并任务继承源任务角色，源角色被禁用时合并任务会
	// 永远排队并堵住项目交付链；允许为排队中的合并任务重新指派角色是唯一
	// 的解卡手段。
	if cur.MergeOf != nil {
		for key := range set {
			if key != "status" && key != "role_id" {
				writeErr(w, http.StatusConflict, "代码合并任务由系统管理；只能取消运行中任务、重试失败任务，或为排队中的任务更换角色")
				return
			}
		}
		if _, ok := set["role_id"]; ok {
			if cur.Status != store.StatusQueued {
				writeErr(w, http.StatusConflict, "只能为排队中的合并任务更换角色")
				return
			}
			if v, isNum := set["role_id"].(float64); !isNum || int64(v) <= 0 {
				writeErr(w, http.StatusConflict, "合并任务必须指派角色")
				return
			}
		}
	}
	approveReview := false

	// 状态流转校验
	if st, ok := set["status"]; ok {
		to, _ := st.(string)
		if !s.tasks.CanTransition(cur.Status, to) {
			writeErr(w, http.StatusBadRequest, "不允许从 "+cur.Status+" 转为 "+to)
			return
		}
		approveReview = cur.Status == store.StatusAwaitingReview && to == store.StatusSucceeded
		if to == store.StatusQueued && cur.Status == store.StatusSucceeded && cur.MergeOf == nil {
			obligated, err := s.sourceHasOrNeedsMerge(*cur)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
			if obligated {
				writeErr(w, http.StatusConflict, "源任务代码已完成，系统正在或已经执行代码合并；请重试对应合并任务")
				return
			}
		}
		if to == store.StatusQueued && cur.Status == store.StatusSucceeded && cur.MergeOf != nil {
			writeErr(w, http.StatusConflict, "代码合并任务已成功，不能重试或重复合并")
			return
		}
		if to == store.StatusQueued {
			// 重试：清空执行痕迹
			set["started_at"] = nil
			set["finished_at"] = nil
			set["error"] = ""
			set["exit_code"] = nil
		}
		if to == store.StatusQueued && cur.Status == store.StatusAwaitingReview {
			// 驳回重做：追加修改意见到提示词，清空会话目录全新执行
			if note, ok := set["review_note"]; ok {
				n := strings.TrimSpace(fmt.Sprint(note))
				if n != "" {
					body := cur.Body
					if body != "" {
						body += "\n\n"
					}
					body += fmt.Sprintf("【修改意见 第 %d 轮 %s】%s", cur.ReviewRounds, time.Now().Format("2006-01-02 15:04"), n)
					set["body"] = body
				}
			}
			delete(set, "review_note")
			s.ex.ResetTaskSession(id)
		}
		if to == store.StatusCancelled {
			s.ex.CancelTask(id)
		}
	}

	// 指派角色不会改变项目工作目录。
	if v, ok := set["role_id"]; ok {
		if aid, isNum := v.(float64); isNum && aid > 0 {
			a, err := s.st.GetRole(int64(aid))
			if err != nil {
				writeErr(w, http.StatusBadRequest, "角色不存在")
				return
			}
			if cur.RunMode == store.RunModeInteractive && !s.ex.RuntimeService().Supports(a.RuntimeID, exec.CapabilityInteractive) {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("交互式任务只支持 pi / omp 角色（%s 不支持）", a.RuntimeID))
				return
			}
			set["role_id"] = int64(aid)
		} else {
			if cur.RunMode == store.RunModeInteractive {
				writeErr(w, http.StatusBadRequest, "交互式任务必须指派角色")
				return
			}
			set["role_id"] = nil
		}
	}

	if v, ok := set["perm"]; ok {
		p, _ := v.(string)
		if !validPerms[p] {
			writeErr(w, http.StatusBadRequest, "非法权限模式: "+p)
			return
		}
	}
	if v, ok := set["concurrent"]; ok {
		b, isBool := v.(bool)
		if !isBool {
			writeErr(w, http.StatusBadRequest, "concurrent 必须是布尔值")
			return
		}
		set["concurrent"] = b
	}
	if v, ok := set["block_on_failure"]; ok {
		b, isBool := v.(bool)
		if !isBool {
			writeErr(w, http.StatusBadRequest, "block_on_failure 必须是布尔值")
			return
		}
		set["block_on_failure"] = b
	}
	if v, ok := set["project_id"]; ok {
		// 依赖目标必须和任务处于同一项目。为避免把一个已有弱/强依赖
		// 的任务悄悄移到另一条链，要求先在任务创建时选好项目；这也让
		// 历史依赖保持可解释。
		if cur.DependencyMode != store.DependencyNone || cur.DependsOn != nil {
			writeErr(w, http.StatusConflict, "带有前置依赖的任务不能修改项目")
			return
		}
		dependent, err := s.st.FirstTaskDependent(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if dependent != nil {
			writeErr(w, http.StatusConflict, fmt.Sprintf("任务 #%d 以本任务为前置，不能修改项目", dependent.ID))
			return
		}
		if v == nil {
			set["project_id"] = nil
		} else if pid, isNum := v.(float64); isNum && pid > 0 {
			if _, err := s.st.GetProject(int64(pid)); err != nil {
				writeErr(w, http.StatusBadRequest, "项目不存在")
				return
			}
			set["project_id"] = int64(pid)
		} else {
			writeErr(w, http.StatusBadRequest, "project_id 非法")
			return
		}
	}
	if v, ok := set["parent_id"]; ok {
		if v == nil {
			set["parent_id"] = nil
		} else if pid, isNum := v.(float64); isNum {
			set["parent_id"] = int64(pid)
		} else {
			writeErr(w, http.StatusBadRequest, "parent_id 非法")
			return
		}
	}
	if approveReview {
		if len(set) != 1 {
			writeErr(w, http.StatusBadRequest, "审批通过不能同时修改任务其他字段")
			return
		}
		s.approveReviewTask(w, *cur)
		return
	}

	if err := s.st.UpdateAtRevision("task", id, revision, set); err != nil {
		if errors.Is(err, store.ErrRevisionConflict) {
			writeErr(w, http.StatusConflict, err.Error())
		} else {
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	if scheduleChanged {
		s.sched.Reload()
	}
	if v, ok := set["status"]; ok && v == store.StatusQueued {
		s.ex.Wake()
	}
	if _, ok := set["block_on_failure"]; ok {
		// 修改失败阻塞策略后，等待中的弱依赖任务应立即重新判定。
		s.ex.Wake()
	}
	tk, err := s.st.GetTask(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tk)
}

// approveReviewTask 固化已审批分支，并原子创建一个同角色的代码合并任务。
// 合并任务会在自己的 worktree 中处理冲突、验证结果，成功后写入主分支。
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
		s.ex.RemoveTask(tk.ID)
	}
	for _, tk := range tasks {
		if err := workspace.Discard(tk, s.sessionsRoot); err != nil {
			writeErr(w, http.StatusConflict, fmt.Sprintf("清理任务 #%d 的 worktree 失败: %v", tk.ID, err))
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

// ---------------------------------------------------------------------------
// 任务工作空间（git worktree 隔离）

func (s *Server) workspaceStatus(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	info, err := s.workspaces.Status(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "任务不存在")
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) workspaceDiscard(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.workspaces.Discard(id); err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"discarded": true})
}

func (s *Server) workspaceGitInit(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.workspaces.InitGit(in.Path); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"inited": true})
}

func gitOut(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := osexec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s 失败: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// ---------------------------------------------------------------------------
// 角色（agent）

func (s *Server) listRoles(w http.ResponseWriter, r *http.Request) {
	agents, err := s.st.ListRoles()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, agents)
}

type roleIn struct {
	Name           string           `json:"name"`
	Description    string           `json:"description"`
	RuntimeID      string           `json:"runtime_id"`
	RoleConfig     store.RoleConfig `json:"role_config"`
	MaxConcurrency int              `json:"max_concurrency"`
	Enabled        *bool            `json:"enabled"`
}

func (s *Server) createRole(w http.ResponseWriter, r *http.Request) {
	var in roleIn
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.validateRole(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	id, err := s.st.CreateRole(store.Role{
		Name: in.Name, Description: in.Description, RuntimeID: in.RuntimeID,
		RoleConfig:     in.RoleConfig,
		MaxConcurrency: in.MaxConcurrency,
		Enabled:        enabled,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a, err := s.st.GetRole(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, a)
}

func (s *Server) validateRole(in *roleIn) error {
	if in.Name == "" {
		return errMsg("角色名不能为空")
	}
	if !s.ex.RuntimeService().Has(in.RuntimeID) {
		return errMsg("未知 Runtime: " + in.RuntimeID)
	}
	if in.MaxConcurrency == 0 {
		in.MaxConcurrency = 1
	}
	if in.MaxConcurrency < 1 {
		return errMsg("最大并发数必须至少为 1")
	}
	return nil
}

type errMsg string

func (e errMsg) Error() string { return string(e) }

func (s *Server) patchRole(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	set, ok := patchMap(w, r, "name", "description", "runtime_id", "role_config", "max_concurrency", "enabled")
	if !ok {
		return
	}
	if v, ok := set["name"]; ok {
		if n, _ := v.(string); n == "" {
			writeErr(w, http.StatusBadRequest, "角色名不能为空")
			return
		}
	}
	if v, ok := set["runtime_id"]; ok {
		if c, _ := v.(string); c != "" {
			if !s.ex.RuntimeService().Has(c) {
				writeErr(w, http.StatusBadRequest, "未知 Runtime: "+c)
				return
			}
		}
	}
	if v, ok := set["max_concurrency"]; ok {
		n, ok := positiveInt(v)
		if !ok {
			writeErr(w, http.StatusBadRequest, "最大并发数必须是至少为 1 的整数")
			return
		}
		set["max_concurrency"] = n
	}
	if err := s.st.UpdateAtRevision("role", id, revision, set); err != nil {
		if errors.Is(err, store.ErrRevisionConflict) {
			writeErr(w, http.StatusConflict, err.Error())
		} else {
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	a, err := s.st.GetRole(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// role_config 变更（含技能选择）后立即对账角色级技能挂载目录，
	// 不必等下一次任务启动或服务重启才生效。
	if _, ok := set["role_config"]; ok {
		if _, rerr := s.ex.EnsureRoleSkills(id, a.Name, a.RoleConfig.Skills); rerr != nil {
			log.Printf("⚠ 角色 %d 技能目录对账失败: %v", id, rerr)
		}
	}
	// 提高并发数或重新启用角色后，不必等下一次一秒轮询才派发队列。
	s.ex.Wake()
	writeJSON(w, http.StatusOK, a)
}

// positiveInt 将 patchMap 的 JSON number（float64）收敛为数据库可存的正整数。
// 角色并发数没有产品级硬上限，由操作者按机器与模型配额决定；这里只拒绝
// 非整数、零、负数和超出当前平台 int 范围的值。
func positiveInt(v any) (int, bool) {
	n, ok := v.(float64)
	if !ok || n < 1 || math.Trunc(n) != n || n > float64(^uint(0)>>1) {
		return 0, false
	}
	return int(n), true
}

func (s *Server) deleteRole(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	if err := s.st.AssertRevision("role", id, revision); err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	if err := s.st.DeleteRole(id); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// Role 删除后立即移除技能挂载；失败不阻断数据库删除，启动对账会再扫
	// 一次无主目录。
	if err := s.ex.RemoveRoleSkills(id); err != nil {
		log.Printf("⚠ 清理角色 %d 技能目录失败: %v", id, err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// 历史清理与设置

func (s *Server) cleanupTasks(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RoleID *int64 `json:"role_id"`
		Before string `json:"before"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	n, locators, err := s.st.CleanupTasks(in.RoleID, in.Before)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if s.artifacts != nil {
		for _, locator := range locators {
			if count, countErr := s.st.CountArtifactsByLocator(locator); countErr == nil && count == 0 {
				if err := s.artifacts.Delete(r.Context(), locator); err != nil {
					log.Printf("清理无引用 Artifact %s 失败: %v", locator, err)
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n})
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	all, err := s.st.AllSettings()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, all)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var in map[string]string
	if !readJSON(w, r, &in) {
		return
	}
	for k, v := range in {
		if err := s.st.SetSetting(k, v); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	all, err := s.st.AllSettings()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, all)
}

// ---------------------------------------------------------------------------
// 任务模板

func (s *Server) listTemplates(w http.ResponseWriter, r *http.Request) {
	templates, err := s.st.ListTemplates()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, templates)
}

func (s *Server) createTemplate(w http.ResponseWriter, r *http.Request) {
	var in store.Template
	if !readJSON(w, r, &in) {
		return
	}
	if in.Name == "" {
		writeErr(w, http.StatusBadRequest, "模板名不能为空")
		return
	}
	if in.Body == "" {
		writeErr(w, http.StatusBadRequest, "模板内容不能为空")
		return
	}
	id, err := s.st.CreateTemplate(in)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *Server) patchTemplate(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	set, ok := patchMap(w, r, "name", "body", "role_id")
	if !ok {
		return
	}
	if v, ok := set["name"]; ok {
		name, isString := v.(string)
		if !isString || strings.TrimSpace(name) == "" {
			writeErr(w, http.StatusBadRequest, "模板名不能为空")
			return
		}
		set["name"] = strings.TrimSpace(name)
	}
	if v, ok := set["body"]; ok {
		body, isString := v.(string)
		if !isString || strings.TrimSpace(body) == "" {
			writeErr(w, http.StatusBadRequest, "模板内容不能为空")
			return
		}
	}
	if v, ok := set["role_id"]; ok {
		if v == nil {
			set["role_id"] = nil
		} else if aid, isNum := v.(float64); isNum && aid > 0 {
			if _, err := s.st.GetRole(int64(aid)); err != nil {
				writeErr(w, http.StatusBadRequest, "角色不存在")
				return
			}
			set["role_id"] = int64(aid)
		} else {
			writeErr(w, http.StatusBadRequest, "role_id 非法")
			return
		}
	}
	if len(set) == 0 {
		writeErr(w, http.StatusBadRequest, "没有可更新的字段")
		return
	}
	if err := s.st.UpdateTemplate(id, set); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	tpl, err := s.st.GetTemplate(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tpl)
}

func (s *Server) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.st.DeleteTemplate(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 项目（维度二：任务管理的项目载体）

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.st.ListProjects()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// git 识别：标记哪些项目支持 worktree 隔离
	for i := range projects {
		if projects[i].ProjectDir != "" {
			projects[i].IsGit = workspace.IsGitRepo(projects[i].ProjectDir)
		}
	}
	writeJSON(w, http.StatusOK, projects)
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var in store.Project
	if !readJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		writeErr(w, http.StatusBadRequest, "项目名不能为空")
		return
	}
	id, err := s.st.CreateProject(in)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	p, err := s.st.GetProject(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) patchProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	set, ok := patchMap(w, r, "name", "description", "status", "project_dir")
	if !ok {
		return
	}
	if v, ok := set["name"]; ok {
		if strings.TrimSpace(fmt.Sprint(v)) == "" {
			writeErr(w, http.StatusBadRequest, "项目名不能为空")
			return
		}
	}
	if v, ok := set["status"]; ok {
		sv := fmt.Sprint(v)
		if sv != "active" && sv != "archived" {
			writeErr(w, http.StatusBadRequest, "非法项目状态: "+sv)
			return
		}
	}
	if err := s.st.UpdateAtRevision("project", id, revision, set); err != nil {
		if errors.Is(err, store.ErrRevisionConflict) {
			writeErr(w, http.StatusConflict, err.Error())
		} else {
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	p, err := s.st.GetProject(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// reorderProjectTasks persists the order of queued implementation tasks in a
// single project.  Merge tasks never appear in the request: the executor keeps
// them in a separate, always-prioritized queue.
func (s *Server) reorderProjectTasks(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := s.st.GetProject(id); err != nil {
		writeErr(w, http.StatusNotFound, "项目不存在")
		return
	}
	var in struct {
		TaskIDs []int64 `json:"task_ids"`
		Order   []int64 `json:"order"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	orderedIDs := in.TaskIDs
	if len(orderedIDs) == 0 && in.Order != nil {
		orderedIDs = in.Order
	}
	if err := s.st.ReorderProjectTasks(id, orderedIDs); err != nil {
		if strings.Contains(err.Error(), "排序请求") {
			writeErr(w, http.StatusConflict, err.Error())
		} else {
			writeErr(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	if s.ex != nil {
		s.ex.Wake()
	}
	projectID := id
	tasks, err := s.st.ListTasksFiltered(store.TaskFilter{ProjectID: &projectID})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	if err := s.st.AssertRevision("project", id, revision); err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	if err := s.st.DeleteProject(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// 角色配置 schema（深度定制：按 CLI 文档声明可配置字段）

func (s *Server) listRuntimes(w http.ResponseWriter, r *http.Request) {
	items := s.ex.RuntimeService().Catalog()
	for i := range items {
		models := exec.ModelIDs(items[i].Models)
		thinkingByModel := exec.ModelThinkingOptions(items[i].Models)
		for j := range items[i].Fields {
			if items[i].Fields[j].Key == "model" {
				items[i].Fields[j].Suggestions = models
			}
			if items[i].Fields[j].Key == "thinking" && len(thinkingByModel) > 0 {
				items[i].Fields[j].ThinkingOptionsByModel = thinkingByModel
			}
		}
	}
	writeJSON(w, http.StatusOK, items)
}

// refreshRuntimes 强制从 Linux 主机重查各 CLI 的模型目录后返回 schema。
// 角色定义和 role_config 仍在 SQLite；这里仅刷新可选模型与其发现到的能力。
func (s *Server) refreshRuntimes(w http.ResponseWriter, r *http.Request) {
	exec.RefreshModelCatalogs()
	s.listRuntimes(w, r)
}

// ---------------------------------------------------------------------------
// Runtime 安装/登录状态（工作台与 Runtime 页共用）

func (s *Server) provisionStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.ex.RuntimeService().Provisioning())
}

// provisionInstall 按官方命令流式安装 CLI：输出经 SSE（provision 事件）推送，
// 前端内嵌终端实时显示；同一 CLI 并发安装互斥。
func (s *Server) provisionInstall(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RuntimeID string `json:"runtime_id"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	cmd, ok := s.ex.RuntimeService().InstallCommand(in.RuntimeID)
	if !ok {
		writeErr(w, http.StatusBadRequest, "未知 Runtime: "+in.RuntimeID)
		return
	}
	if cmd == "" {
		writeErr(w, http.StatusBadRequest, "该 CLI 暂无内置安装命令，请参考官方文档手动安装")
		return
	}
	if !s.provTryLock(in.RuntimeID) {
		writeErr(w, http.StatusConflict, in.RuntimeID+" 正在安装中")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"started": true, "runtime_id": in.RuntimeID, "cmd": cmd})
	go func() {
		defer s.provUnlock(in.RuntimeID)
		push := func(line string) {
			s.hub.Publish(events.Event{Type: "provision", Payload: map[string]any{"runtime_id": in.RuntimeID, "line": line}})
		}
		push("$ " + cmd)
		c := osexec.Command("bash", "-c", cmd)
		c.Env = os.Environ()
		out, err := c.StdoutPipe()
		if err != nil {
			push("执行失败: " + err.Error())
			return
		}
		c.Stderr = c.Stdout // 合并输出
		if err := c.Start(); err != nil {
			push("启动失败: " + err.Error())
			return
		}
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			push(sc.Text())
		}
		if err := c.Wait(); err != nil {
			push("[install] 退出码非零: " + err.Error())
		} else {
			push("[install] 完成 ✓")
		}
	}()
}

// ---------------------------------------------------------------------------
// 技能库（单个导入或递归扫描；角色配置按名称勾选，执行注入实际目录）

func (s *Server) listSkills(w http.ResponseWriter, r *http.Request) {
	skills, err := s.st.ListSkills()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, skills)
}

type skillDetailResponse struct {
	store.Skill
	Content  string `json:"content"`
	FileName string `json:"file_name"`
	Size     int64  `json:"size_bytes"`
}

func (s *Server) getSkill(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	sk, err := s.st.GetSkill(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "技能不存在")
		return
	}

	path := filepath.Join(sk.Dir, "SKILL.md")
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		writeErr(w, http.StatusNotFound, "技能说明文件不存在")
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "读取技能说明失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, skillDetailResponse{
		Skill:    *sk,
		Content:  string(b),
		FileName: "SKILL.md",
		Size:     fi.Size(),
	})
}

// createSkill 定向添加：把源目录（含 SKILL.md）复制到 paihuo 工作目录并登记。
func (s *Server) createSkill(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SourcePath string   `json:"source_path"`
		Tags       []string `json:"tags"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	src, err := skillSourceDir(in.SourcePath)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if isPathWithin(src, s.skillsDir) {
		writeErr(w, http.StatusBadRequest, "不能导入 paihuo 管理的技能库目录")
		return
	}
	if fi, err := os.Stat(filepath.Join(src, "SKILL.md")); err != nil || fi.IsDir() {
		writeErr(w, http.StatusBadRequest, "该目录没有 SKILL.md，不是技能")
		return
	}
	sk, err := s.importSkillWithTags(src, in.Tags)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, sk)
}

// skillScanResult 是一次递归扫描的结果。扫描会跳过已由 paihuo 管理的
// 技能副本，重复扫描同一个目录不会重复入库。
type skillScanResult struct {
	Found    int              `json:"found"`
	Imported []store.Skill    `json:"imported"`
	Skipped  []string         `json:"skipped"`
	Errors   []skillScanError `json:"errors"`
}

type skillScanError struct {
	SourcePath string `json:"source_path"`
	Error      string `json:"error"`
}

// scanSkills 递归寻找目录树内所有含 SKILL.md 的目录，并逐个导入。
// 单个技能导入失败不会中断其它技能，结果会在 errors 中返回给前端。
func (s *Server) scanSkills(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SourcePath string   `json:"source_path"`
		Tags       []string `json:"tags"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	root, err := skillSourceDir(in.SourcePath)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if isPathWithin(root, s.skillsDir) {
		writeErr(w, http.StatusBadRequest, "不能扫描 paihuo 管理的技能库目录")
		return
	}

	dirs, err := discoverSkillDirs(root, s.skillsDir)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "扫描技能目录失败: "+err.Error())
		return
	}
	if len(dirs) == 0 {
		writeErr(w, http.StatusBadRequest, "目录下未发现 SKILL.md")
		return
	}

	existing, err := s.st.ListSkills()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	knownSources := make(map[string]struct{}, len(existing))
	for _, sk := range existing {
		if src, err := skillSourceDir(sk.SourcePath); err == nil {
			knownSources[src] = struct{}{}
		}
	}

	result := skillScanResult{
		Found:    len(dirs),
		Imported: make([]store.Skill, 0, len(dirs)),
		Skipped:  make([]string, 0),
		Errors:   make([]skillScanError, 0),
	}
	for _, src := range dirs {
		if _, exists := knownSources[src]; exists {
			result.Skipped = append(result.Skipped, src)
			continue
		}
		sk, err := s.importSkillWithTags(src, in.Tags)
		if err != nil {
			result.Errors = append(result.Errors, skillScanError{SourcePath: src, Error: err.Error()})
			continue
		}
		knownSources[src] = struct{}{}
		result.Imported = append(result.Imported, sk)
	}

	status := http.StatusOK
	if len(result.Imported) > 0 {
		status = http.StatusCreated
	}
	if len(result.Errors) > 0 {
		status = http.StatusMultiStatus
	}
	writeJSON(w, status, result)
}

// skillSourceDir 将用户输入标准化为绝对目录，并校验目录存在。解析软链可以
// 保证同一目录从不同软链路径扫描时仍能正确去重。
func skillSourceDir(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("需要技能目录路径")
	}
	src, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(src)
	if err != nil || !fi.IsDir() {
		return "", fmt.Errorf("目录不存在")
	}
	if resolved, err := filepath.EvalSymlinks(src); err == nil {
		src = resolved
	}
	return filepath.Clean(src), nil
}

// discoverSkillDirs 返回 root 下每个直接包含 SKILL.md 的目录。它不会跟随
// 目录软链，既避免循环，也避免意外扫描到根目录之外；s.skillsDir 则永远
// 跳过，防止把 paihuo 已复制的技能再次导入。
func discoverSkillDirs(root, skillsDir string) ([]string, error) {
	dirs := make([]string, 0)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if isPathWithin(path, skillsDir) {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() == "SKILL.md" {
			dirs = append(dirs, filepath.Dir(path))
		}
		return nil
	})
	return dirs, err
}

// isPathWithin 判断 path 是否等于 dir 或位于 dir 之下。调用者可以传入相对
// 路径（默认数据库路径会产生相对的 skillsDir），函数会先按当前工作目录展开。
func isPathWithin(path, dir string) bool {
	if dir == "" {
		return false
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(absDir), filepath.Clean(absPath))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// importSkillWithTags 把 frontmatter 中的标签与本次导入附加的标签合并，
// 这样扫描导入既能保留技能自带的元数据，也能一次给一批技能打上业务标签。
func (s *Server) importSkillWithTags(src string, extraTags []string) (store.Skill, error) {
	if isPathWithin(src, s.skillsDir) {
		return store.Skill{}, fmt.Errorf("不能导入 paihuo 管理的技能库目录")
	}
	skillmd := filepath.Join(src, "SKILL.md")
	fi, err := os.Stat(skillmd)
	if err != nil || fi.IsDir() {
		return store.Skill{}, fmt.Errorf("该目录没有 SKILL.md，不是技能")
	}
	name, desc, tags := parseSkillFrontmatter(skillmd)
	tags = append(tags, extraTags...)
	if name == "" {
		name = filepath.Base(src)
	}
	if err := os.MkdirAll(s.skillsDir, 0o755); err != nil {
		return store.Skill{}, err
	}
	// 目标目录：slug 化名称，冲突则追加序号。
	slug := skillSlug(name)
	dst := filepath.Join(s.skillsDir, slug)
	for n := 2; ; n++ {
		_, err := os.Stat(dst)
		if os.IsNotExist(err) {
			break
		}
		if err != nil {
			return store.Skill{}, err
		}
		dst = filepath.Join(s.skillsDir, fmt.Sprintf("%s-%d", slug, n))
	}
	if err := copyDir(src, dst, s.skillsDir); err != nil {
		return store.Skill{}, fmt.Errorf("复制技能目录失败: %w", err)
	}
	id, err := s.st.CreateSkill(store.Skill{
		Name: name, Description: desc, Tags: tags, Dir: dst, SourcePath: src,
	})
	if err != nil {
		_ = os.RemoveAll(dst)
		return store.Skill{}, err
	}
	sk, err := s.st.GetSkill(id)
	if err != nil {
		return store.Skill{}, err
	}
	return *sk, nil
}

func (s *Server) patchSkill(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := s.st.GetSkill(id); err != nil {
		writeErr(w, http.StatusNotFound, "技能不存在")
		return
	}
	var in struct {
		Tags []string `json:"tags"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.st.UpdateSkillTags(id, in.Tags); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	sk, err := s.st.GetSkill(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sk)
}

func (s *Server) deleteSkill(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	sk, err := s.st.GetSkill(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "技能不存在")
		return
	}
	if err := s.st.DeleteSkill(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	os.RemoveAll(sk.Dir) // 登记删除后清理工作目录副本（角色引用会变成失效路径）
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

// deleteSkills 批量删除技能登记和对应的工作目录副本。
// 先校验全部 id，再一次性提交数据库事务，避免部分删除。
func (s *Server) deleteSkills(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "至少选择一个技能")
		return
	}

	// 去重保持请求顺序，避免同一个技能被重复处理。
	ids := make([]int64, 0, len(in.IDs))
	seen := make(map[int64]struct{}, len(in.IDs))
	skills := make([]store.Skill, 0, len(in.IDs))
	for _, id := range in.IDs {
		if id <= 0 {
			writeErr(w, http.StatusBadRequest, "非法技能 id")
			return
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		sk, err := s.st.GetSkill(id)
		if err != nil {
			writeErr(w, http.StatusNotFound, fmt.Sprintf("技能不存在: %d", id))
			return
		}
		ids = append(ids, id)
		skills = append(skills, *sk)
	}

	if err := s.st.DeleteSkills(ids); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, sk := range skills {
		os.RemoveAll(sk.Dir) // 登记删除后清理工作目录副本
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": ids, "count": len(ids)})
}

// parseSkillFrontmatter 解析 SKILL.md 头部 YAML frontmatter 的 name / description / tags。
// 解析失败或没有 frontmatter 时返回空，由调用方用目录名兜底。
func parseSkillFrontmatter(path string) (name, desc string, tags []string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	text := string(b)
	if !strings.HasPrefix(text, "---") {
		return
	}
	rest := text[3:]
	end := strings.Index(rest, "---")
	if end < 0 {
		return
	}
	frontmatter := strings.Split(rest[:end], "\n")
	readingTags := false
	for _, line := range frontmatter {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			// 兼容最常见的多行 YAML 标签：
			// tags:\n  - coding\n  - review
			if readingTags && strings.HasPrefix(strings.TrimSpace(line), "-") {
				tags = append(tags, strings.Trim(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "-")), `"'`))
			}
			continue
		}
		readingTags = false
		switch strings.TrimSpace(k) {
		case "name":
			name = strings.Trim(strings.TrimSpace(v), `"'`)
		case "description":
			desc = strings.Trim(strings.TrimSpace(v), `"'`)
		case "tags":
			tags = parseSkillTagsValue(v)
			// Inline tags are complete on this line. For a YAML list, the
			// following indented dash items are picked up above.
			readingTags = strings.TrimSpace(v) == ""
		}
	}
	return
}

func parseSkillTagsValue(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "[]" {
		return []string{}
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		raw = strings.TrimSpace(raw[1 : len(raw)-1])
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '，' })
	if len(parts) == 0 {
		parts = []string{raw}
	}
	tags := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), `"'`)
		if part != "" {
			tags = append(tags, part)
		}
	}
	return tags
}

func skillSlug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else if r == ' ' || r == '_' || r == '-' || r == '.' {
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "skill"
	}
	return out
}

// copyDir 递归复制目录（技能可能含子文件/脚本）。skipDirs 内的目录不会
// 被复制；导入的目标技能库位于源目录内时，这能避免递归复制自己。
func copyDir(src, dst string, skipDirs ...string) error {
	return filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.IsDir() {
			for _, skip := range skipDirs {
				if isPathWithin(p, skip) {
					return filepath.SkipDir
				}
			}
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if fi.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, fi.Mode().Perm())
	})
}

// ---------------------------------------------------------------------------
// 文件系统浏览（目录选择器：项目目录 / 技能目录等，仅返回子目录名）

// junkDir 是目录选择器中跳过的常见噪音目录。
var junkDir = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true,
	"build": true, "target": true, ".cache": true, "__pycache__": true,
	".venv": true, "venv": true, "env": true, "Pods": true,
}

func (s *Server) fsDirs(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimSpace(r.URL.Query().Get("path"))
	if p == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			writeErr(w, http.StatusBadRequest, "无法确定家目录")
			return
		}
		p = home
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "无效路径")
		return
	}
	abs = filepath.Clean(abs)
	if !filepath.IsAbs(abs) {
		writeErr(w, http.StatusBadRequest, "需要绝对路径")
		return
	}
	fi, err := os.Stat(abs)
	if err != nil || !fi.IsDir() {
		writeErr(w, http.StatusNotFound, "目录不存在")
		return
	}
	es, err := os.ReadDir(abs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	dirs := make([]string, 0)
	for _, e := range es {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || junkDir[e.Name()] {
			continue
		}
		dirs = append(dirs, e.Name())
	}
	sort.Strings(dirs)
	parent := "/"
	if abs != "/" {
		parent = filepath.Dir(abs)
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": abs, "parent": parent, "dirs": dirs})
}

func (s *Server) fsMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Path) == "" {
		writeErr(w, http.StatusBadRequest, "需要 path")
		return
	}
	abs, err := filepath.Abs(strings.TrimSpace(req.Path))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "无效路径")
		return
	}
	if err := os.MkdirAll(filepath.Clean(abs), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": filepath.Clean(abs)})
}

// ---------------------------------------------------------------------------
// 统计（维度二：项目进度 + agent 产出统计）

func (s *Server) overviewStats(w http.ResponseWriter, r *http.Request) {
	ov, err := s.st.OverviewStatsOf()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

func (s *Server) roleStats(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	st, err := s.st.RoleStatsOf(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "角色不存在")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) projectStats(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	st, err := s.st.ProjectStatsOf(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "项目不存在")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// provTryLock / provUnlock：同一 CLI 并发安装互斥。
func (s *Server) provTryLock(cli string) bool {
	s.provMu.Lock()
	defer s.provMu.Unlock()
	if s.provBusy[cli] {
		return false
	}
	s.provBusy[cli] = true
	return true
}

func (s *Server) provUnlock(cli string) {
	s.provMu.Lock()
	defer s.provMu.Unlock()
	delete(s.provBusy, cli)
}

// ---------------------------------------------------------------------------
// Pi Extensions 管理（包装 pi install/list/remove，Web 可操作）

func runPi(timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := osexec.CommandContext(ctx, "pi", args...)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (s *Server) listExtensions(w http.ResponseWriter, r *http.Request) {
	raw, err := runPi(15*time.Second, "list")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"raw": strings.TrimSpace(raw), "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"raw": strings.TrimSpace(raw)})
}

func (s *Server) installExtension(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Source string `json:"source"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	in.Source = strings.TrimSpace(in.Source)
	if in.Source == "" {
		writeErr(w, http.StatusBadRequest, "需要 extension 来源（路径或包名）")
		return
	}
	raw, err := runPi(120*time.Second, "install", in.Source)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "pi install 失败: "+strings.TrimSpace(raw))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"raw": strings.TrimSpace(raw)})
}

func (s *Server) removeExtension(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		writeErr(w, http.StatusBadRequest, "需要 extension 名称")
		return
	}
	raw, err := runPi(60*time.Second, "remove", name)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "pi remove 失败: "+strings.TrimSpace(raw))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"raw": strings.TrimSpace(raw)})
}
