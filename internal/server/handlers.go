package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
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
	store.PermFull: true, store.PermReview: true,
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.TaskFilter{}
	if v := q.Get("agent_id"); v != "" {
		if id, err := strconv.ParseInt(v, 10, 64); err == nil && id > 0 {
			f.AgentID = &id
		}
	}
	if v := q.Get("project_id"); v != "" {
		if id, err := strconv.ParseInt(v, 10, 64); err == nil && id > 0 {
			f.ProjectID = &id
		}
	}
	f.Status = q.Get("status")
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
	var in struct {
		Title     string `json:"title"`
		Body      string `json:"body"`
		AgentID   *int64 `json:"agent_id"`
		ProjectID *int64 `json:"project_id"`
		Perm      string `json:"perm"`
		ParentID  *int64 `json:"parent_id"`
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
	// 工作目录属于项目：快照项目目录（历史记录不随配置漂移）；
	// 老数据兼容：项目未设目录时回退角色的旧 project_dir。
	if in.ProjectID != nil {
		p, err := s.st.GetProject(*in.ProjectID)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "项目不存在")
			return
		}
		tk.ProjectID = in.ProjectID
		tk.ProjectDir = p.ProjectDir
	}
	if tk.ProjectDir == "" && in.AgentID != nil {
		a, err := s.st.GetAgent(*in.AgentID)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "角色不存在")
			return
		}
		tk.ProjectDir = a.ProjectDir // 兼容旧数据：角色级目录
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
	set, ok := patchMap(w, r, "title", "body", "agent_id", "perm", "status", "review_note", "parent_id", "project_id")
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
			_ = os.RemoveAll(filepath.Join(os.TempDir(), "paihuo-sessions", fmt.Sprintf("task-%d", id)))
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
	if v, ok := set["project_id"]; ok {
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
	// 先取消还在运行的子任务进程，再删库（否则进程继续在项目目录里跑）
	if kids, err := s.st.ListChildren(id); err == nil {
		for _, k := range kids {
			s.ex.CancelTask(k.ID)
		}
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
	// 项目目录属于项目，不再属于角色（老数据保留兼容，创建任务时优先用项目目录）
	if in.ProjectDir != "" {
		if fi, err := os.Stat(in.ProjectDir); err != nil || !fi.IsDir() {
			return errMsg("项目目录不存在: " + in.ProjectDir)
		}
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

// ---------------------------------------------------------------------------
// 项目（维度二：任务管理的项目载体）

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.st.ListProjects()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
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
	if err := s.st.UpdateProject(id, set); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	p, err := s.st.GetProject(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
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

func (s *Server) listAgentSchemas(w http.ResponseWriter, r *http.Request) {
	var out []map[string]any
	for _, a := range exec.Adapters() {
		fields := exec.Enrich(a.Schema())
		// 模型候选：探测该 CLI 在本机实例的实际配置，而非硬编码常用模型
		for i := range fields {
			if fields[i].Key == "model" {
				fields[i].Suggestions = a.Models()
			}
		}
		out = append(out, map[string]any{
			"id": a.ID(), "name": a.Name(), "docs": a.Docs(), "fields": fields,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// 技能库（注册到 paihuo 工作目录；角色配置按名称勾选，执行注入实际目录）

func (s *Server) listSkills(w http.ResponseWriter, r *http.Request) {
	skills, err := s.st.ListSkills()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, skills)
}

// createSkill 定向添加：把源目录（含 SKILL.md）复制到 paihuo 工作目录并登记。
func (s *Server) createSkill(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SourcePath string `json:"source_path"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	src, err := filepath.Abs(strings.TrimSpace(in.SourcePath))
	if err != nil || src == "" {
		writeErr(w, http.StatusBadRequest, "需要技能目录路径")
		return
	}
	fi, err := os.Stat(src)
	if err != nil || !fi.IsDir() {
		writeErr(w, http.StatusBadRequest, "目录不存在")
		return
	}
	skillmd := filepath.Join(src, "SKILL.md")
	if _, err := os.Stat(skillmd); err != nil {
		writeErr(w, http.StatusBadRequest, "该目录没有 SKILL.md，不是技能")
		return
	}
	name, desc := parseSkillFrontmatter(skillmd)
	if name == "" {
		name = filepath.Base(src)
	}
	if err := os.MkdirAll(s.skillsDir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 目标目录：slug 化名称，冲突则追加序号
	slug := skillSlug(name)
	dst := filepath.Join(s.skillsDir, slug)
	for n := 2; ; n++ {
		if _, err := os.Stat(dst); os.IsNotExist(err) {
			break
		}
		dst = filepath.Join(s.skillsDir, fmt.Sprintf("%s-%d", slug, n))
	}
	if err := copyDir(src, dst); err != nil {
		writeErr(w, http.StatusInternalServerError, "复制技能目录失败: "+err.Error())
		return
	}
	id, err := s.st.CreateSkill(store.Skill{
		Name: name, Description: desc, Dir: dst, SourcePath: src,
	})
	if err != nil {
		os.RemoveAll(dst)
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	sk, _ := s.st.GetSkill(id)
	writeJSON(w, http.StatusCreated, sk)
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

// parseSkillFrontmatter 解析 SKILL.md 头部 YAML frontmatter 的 name / description。
// 解析失败或没有 frontmatter 时返回空，由调用方用目录名兜底。
func parseSkillFrontmatter(path string) (name, desc string) {
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
	for _, line := range strings.Split(rest[:end], "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "name":
			name = strings.Trim(strings.TrimSpace(v), `"'`)
		case "description":
			desc = strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return
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

// copyDir 递归复制目录（技能可能含子文件/脚本）。
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
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
	var dirs []string
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Path) == "" {
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

func (s *Server) agentStats(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	st, err := s.st.AgentStatsOf(id)
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
