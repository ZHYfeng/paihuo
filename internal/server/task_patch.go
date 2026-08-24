package server

import (
	"errors"
	"math"
	"net/http"

	"paihuo/internal/store"
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
	patch, ok := parseTaskPatch(w, r)
	if !ok || !validateTaskPatch(w, &patch) {
		return
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
	if !s.authorizeTaskPatch(w, id, cur, &patch) {
		return
	}
	s.applyTaskPatch(w, id, revision, *cur, patch)
}

// taskPatch keeps the decoded JSON fields as a presence-aware map: a missing
// key is distinct from an explicitly null value, and false, zero, and the
// empty string remain present scalar values.
type taskPatch struct {
	set               map[string]any
	dependencyChanged bool
	scheduleChanged   bool
	approveReview     bool
}

func parseTaskPatch(w http.ResponseWriter, r *http.Request) (taskPatch, bool) {
	set, ok := patchMap(w, r, "title", "body", "role_id", "perm", "status", "review_note", "parent_id", "project_id", "concurrent", "block_on_failure", "dependency_mode", "depends_on", "cron", "enabled")
	return taskPatch{set: set}, ok
}

func validateTaskPatch(w http.ResponseWriter, patch *taskPatch) bool {
	set := patch.set
	patch.dependencyChanged = false
	if v, ok := set["dependency_mode"]; ok {
		mode, isString := v.(string)
		if !isString || (mode != store.DependencyNone && mode != store.DependencyWeak && mode != store.DependencyStrong) {
			writeErr(w, http.StatusBadRequest, "非法依赖模式")
			return false
		}
		set["dependency_mode"] = mode
		patch.dependencyChanged = true
	}
	if v, ok := set["depends_on"]; ok {
		target, valid := optionalTaskID(v)
		if !valid {
			writeErr(w, http.StatusBadRequest, "前置任务 ID 非法")
			return false
		}
		set["depends_on"] = target
		patch.dependencyChanged = true
	}
	// 定时属性（正交）：cron/enabled 只对定时定义（cron 非空）有意义；
	// 修改后调度器立即重载。cron 非空时任务成为定时定义，永不直接执行。
	patch.scheduleChanged = false
	if v, ok := set["cron"]; ok {
		cron, isString := v.(string)
		if !isString {
			writeErr(w, http.StatusBadRequest, "cron 必须是字符串")
			return false
		}
		set["cron"] = cron
		patch.scheduleChanged = true
	}
	if v, ok := set["enabled"]; ok {
		b, isBool := v.(bool)
		if !isBool {
			writeErr(w, http.StatusBadRequest, "enabled 必须是布尔值")
			return false
		}
		set["enabled"] = b
		patch.scheduleChanged = true
	}
	return true
}

func (s *Server) applyTaskPatch(w http.ResponseWriter, id, revision int64, cur store.Task, patch taskPatch) {
	if patch.approveReview {
		s.approveReviewTask(w, cur)
		return
	}
	set := patch.set
	var updateErr error
	if patch.dependencyChanged {
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
	if patch.scheduleChanged {
		s.sched.Reload()
	}
	if v, ok := set["status"]; ok && v == store.StatusQueued {
		s.ex.Wake()
	}
	if _, ok := set["block_on_failure"]; ok {
		// 修改失败阻塞策略后，等待中的弱依赖任务应立即重新判定。
		s.ex.Wake()
	}
	if patch.dependencyChanged {
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
