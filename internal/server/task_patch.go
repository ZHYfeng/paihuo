package server

import (
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

var validPerms = map[string]bool{
	store.PermFull: true, store.PermReview: true,
}

var validRunModes = map[string]bool{
	store.RunModeBatch: true, store.RunModeInteractive: true,
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
	set, ok := patchMap(w, r, "title", "body", "role_id", "perm", "status", "review_note", "parent_id", "project_id", "concurrent", "block_on_failure", "dependency_mode", "depends_on", "cron", "enabled")
	if !ok {
		return
	}
	dependencyChanged := false
	if v, ok := set["dependency_mode"]; ok {
		mode, isString := v.(string)
		if !isString || (mode != store.DependencyNone && mode != store.DependencyWeak && mode != store.DependencyStrong) {
			writeErr(w, http.StatusBadRequest, "非法依赖模式")
			return
		}
		set["dependency_mode"] = mode
		dependencyChanged = true
	}
	if v, ok := set["depends_on"]; ok {
		target, valid := optionalTaskID(v)
		if !valid {
			writeErr(w, http.StatusBadRequest, "前置任务 ID 非法")
			return
		}
		set["depends_on"] = target
		dependencyChanged = true
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
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("交互式任务要求 Runtime 支持交互模式（%s 不支持）", a.RuntimeID))
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
			set["project_dir"] = ""
		} else if pid, isNum := v.(float64); isNum && pid > 0 {
			project, err := s.st.GetProject(int64(pid))
			if err != nil || project == nil {
				writeErr(w, http.StatusBadRequest, "项目不存在")
				return
			}
			set["project_id"] = int64(pid)
			set["project_dir"] = project.ProjectDir
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

	var updateErr error
	if dependencyChanged {
		updateErr = s.st.UpdateTaskAtRevision(id, revision, set)
	} else {
		updateErr = s.st.UpdateAtRevision("task", id, revision, set)
	}
	if updateErr != nil {
		var dependencyErr *store.TaskDependencyUpdateError
		switch {
		case errors.Is(updateErr, store.ErrRevisionConflict):
			writeErr(w, http.StatusConflict, updateErr.Error())
		case errors.As(updateErr, &dependencyErr):
			writeErr(w, http.StatusBadRequest, updateErr.Error())
		default:
			writeErr(w, http.StatusInternalServerError, updateErr.Error())
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
	if dependencyChanged {
		// 修改前置交付后，等待中的任务应立即重新判定。
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

// optionalTaskID 将 PATCH 中的 depends_on 收敛为可存储的整数或 nil。
// JSON 数字先解码为 float64；任务 ID 不应超过 JavaScript 的安全整数范围。
func optionalTaskID(v any) (any, bool) {
	if v == nil {
		return nil, true
	}
	n, ok := v.(float64)
	if !ok || n < 1 || math.Trunc(n) != n || n > 9007199254740991 {
		return nil, false
	}
	id := int64(n)
	return id, id > 0
}
