package server

import (
	"context"
	"fmt"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"time"

	"paihuo/internal/exec"
	"paihuo/internal/store"
)

// ---------------------------------------------------------------------------
// 任务

// 允许的人工状态流转；其余流转由执行器驱动。
var manualTransitions = map[string]map[string]bool{
	store.StatusQueued:         {store.StatusCancelled: true},
	store.StatusClaimed:        {store.StatusCancelled: true},
	store.StatusRunning:        {store.StatusCancelled: true},
	store.StatusAwaitingReview: {store.StatusQueued: true, store.StatusSucceeded: true, store.StatusCancelled: true},
	store.StatusSucceeded:      {store.StatusQueued: true},
	store.StatusFailed:         {store.StatusQueued: true},
	store.StatusCancelled:      {store.StatusQueued: true},
}

var validPerms = map[string]bool{
	store.PermFull: true, store.PermReview: true, store.PermReadonly: true,
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	tasks, err := s.st.ListTasks()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title    string  `json:"title"`
		Body     string  `json:"body"`
		AgentID  *int64  `json:"agent_id"`
		Perm     string  `json:"perm"`
		ParentID *int64  `json:"parent_id"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Title == "" {
		writeErr(w, http.StatusBadRequest, "标题不能为空")
		return
	}
	perm := in.Perm
	if perm == "" {
		perm = store.PermFull
	}
	if !validPerms[perm] {
		writeErr(w, http.StatusBadRequest, "非法权限模式: "+perm)
		return
	}
	tk := store.Task{Title: in.Title, Body: in.Body, Status: store.StatusQueued, Perm: perm, AgentID: in.AgentID, ParentID: in.ParentID}
	// 指派角色时快照项目目录（历史记录不随角色配置漂移）
	if in.AgentID != nil {
		a, err := s.st.GetAgent(*in.AgentID)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "角色不存在")
			return
		}
		tk.ProjectDir = a.ProjectDir
	}
	id, err := s.st.CreateTask(tk)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.ex.Wake()
	tk2, err := s.st.GetTask(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, tk2)
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
	set, ok := patchMap(w, r, "title", "body", "agent_id", "perm", "status", "review_note", "parent_id")
	if !ok {
		return
	}
	cur, err := s.st.GetTask(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "任务不存在")
		return
	}

	// 状态流转校验
	if st, ok := set["status"]; ok {
		to, _ := st.(string)
		if !manualTransitions[cur.Status][to] {
			writeErr(w, http.StatusBadRequest, "不允许从 "+cur.Status+" 转为 "+to)
			return
		}
		if to == store.StatusQueued {
			// 重试：清空执行痕迹
			set["started_at"] = nil
			set["finished_at"] = nil
			set["error"] = ""
			set["exit_code"] = nil
		}
		if to == store.StatusCancelled {
			s.ex.CancelTask(id)
		}
	}

	// 指派角色：快照项目目录
	if v, ok := set["agent_id"]; ok {
		if aid, isNum := v.(float64); isNum && aid > 0 {
			a, err := s.st.GetAgent(int64(aid))
			if err != nil {
				writeErr(w, http.StatusBadRequest, "角色不存在")
				return
			}
			set["agent_id"] = int64(aid)
			set["project_dir"] = a.ProjectDir
		} else {
			set["agent_id"] = nil
			set["project_dir"] = ""
		}
	}

	if v, ok := set["perm"]; ok {
		p, _ := v.(string)
		if !validPerms[p] {
			writeErr(w, http.StatusBadRequest, "非法权限模式: "+p)
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

	if err := s.st.UpdateTask(id, set); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if v, ok := set["status"]; ok && v == store.StatusQueued {
		s.ex.Wake()
	}
	tk, err := s.st.GetTask(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tk)
}

func (s *Server) deleteTask(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	s.ex.CancelTask(id)
	if err := s.st.DeleteTask(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 清理任务专属会话目录（隐私：删除执行痕迹）
	_ = os.RemoveAll(filepath.Join(os.TempDir(), "paihuo-sessions", fmt.Sprintf("task-%d", id)))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getTaskLogs(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	logs, err := s.st.ListLogs(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, logs)
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

	stat, err1 := gitOut(ctx, tk.ProjectDir, "diff", "--stat")
	diff, err2 := gitOut(ctx, tk.ProjectDir, "diff")
	if err1 != nil || err2 != nil {
		writeJSON(w, http.StatusOK, map[string]string{"stat": "", "diff": "", "note": "不是 git 仓库或读取失败"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"stat": stat, "diff": diff})
}

func gitOut(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := osexec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// ---------------------------------------------------------------------------
// 角色（agent）

func (s *Server) listAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.st.ListAgents()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, agents)
}

type agentIn struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	CLI         string           `json:"cli"`
	RoleConfig  store.RoleConfig `json:"role_config"`
	ProjectDir  string           `json:"project_dir"`
	DefaultPerm string           `json:"default_perm"`
	Enabled     *bool            `json:"enabled"`
}

func (s *Server) createAgent(w http.ResponseWriter, r *http.Request) {
	var in agentIn
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.validateAgent(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	id, err := s.st.CreateAgent(store.Agent{
		Name: in.Name, Description: in.Description, CLI: in.CLI,
		RoleConfig: in.RoleConfig, ProjectDir: in.ProjectDir,
		DefaultPerm: in.DefaultPerm, Enabled: enabled,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a, err := s.st.GetAgent(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, a)
}

func (s *Server) validateAgent(in *agentIn) error {
	if in.Name == "" {
		return errMsg("角色名不能为空")
	}
	if _, ok := exec.GetAdapter(in.CLI); !ok {
		return errMsg("未知 CLI: " + in.CLI)
	}
	if in.ProjectDir == "" {
		return errMsg("必须绑定项目目录")
	}
	if fi, err := os.Stat(in.ProjectDir); err != nil || !fi.IsDir() {
		return errMsg("项目目录不存在: " + in.ProjectDir)
	}
	if in.DefaultPerm == "" {
		in.DefaultPerm = store.PermFull
	}
	if !validPerms[in.DefaultPerm] {
		return errMsg("非法权限模式: " + in.DefaultPerm)
	}
	return nil
}

type errMsg string

func (e errMsg) Error() string { return string(e) }

func (s *Server) patchAgent(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	set, ok := patchMap(w, r, "name", "description", "cli", "role_config", "project_dir", "default_perm", "enabled")
	if !ok {
		return
	}
	if v, ok := set["name"]; ok {
		if n, _ := v.(string); n == "" {
			writeErr(w, http.StatusBadRequest, "角色名不能为空")
			return
		}
	}
	if v, ok := set["cli"]; ok {
		if c, _ := v.(string); c != "" {
			if _, ok := exec.GetAdapter(c); !ok {
				writeErr(w, http.StatusBadRequest, "未知 CLI: "+c)
				return
			}
		}
	}
	if v, ok := set["project_dir"]; ok {
		if dir, _ := v.(string); dir != "" {
			if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
				writeErr(w, http.StatusBadRequest, "项目目录不存在: "+dir)
				return
			}
		}
	}
	if err := s.st.UpdateAgent(id, set); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a, err := s.st.GetAgent(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) deleteAgent(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.st.DeleteAgent(id); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// 历史清理与设置

func (s *Server) cleanupTasks(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AgentID *int64 `json:"agent_id"`
		Before  string `json:"before"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	n, err := s.st.CleanupTasks(in.AgentID, in.Before)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
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
// 定时任务（M5：调度器接入）

func (s *Server) listSchedules(w http.ResponseWriter, r *http.Request) {
	schedules, err := s.st.ListSchedules()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, schedules)
}

func (s *Server) createSchedule(w http.ResponseWriter, r *http.Request) {
	var in store.Schedule
	if !readJSON(w, r, &in) {
		return
	}
	if in.Name == "" || in.Cron == "" || in.TitleTemplate == "" {
		writeErr(w, http.StatusBadRequest, "名称、cron 表达式、标题模板不能为空")
		return
	}
	if _, err := s.st.GetAgent(in.AgentID); err != nil {
		writeErr(w, http.StatusBadRequest, "角色不存在")
		return
	}
	id, err := s.st.CreateSchedule(in)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.sched.Reload()
	sc, err := s.st.GetSchedule(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, sc)
}

func (s *Server) patchSchedule(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	set, ok := patchMap(w, r, "name", "cron", "title_template", "body_template", "agent_id", "enabled", "next_run_at", "last_run_at")
	if !ok {
		return
	}
	if v, ok := set["agent_id"]; ok {
		if aid, isNum := v.(float64); isNum && aid > 0 {
			if _, err := s.st.GetAgent(int64(aid)); err != nil {
				writeErr(w, http.StatusBadRequest, "角色不存在")
				return
			}
			set["agent_id"] = int64(aid)
		} else {
			writeErr(w, http.StatusBadRequest, "agent_id 非法")
			return
		}
	}
	if err := s.st.UpdateSchedule(id, set); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.sched.Reload()
	sc, err := s.st.GetSchedule(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sc)
}

func (s *Server) deleteSchedule(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.st.DeleteSchedule(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.sched.Reload()
	w.WriteHeader(http.StatusNoContent)
}
