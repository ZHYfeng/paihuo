package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

func (s *Server) registerProjectRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/projects", s.listProjects)
	mux.HandleFunc("POST /api/v1/projects", s.createProject)
	mux.HandleFunc("PATCH /api/v1/projects/{id}", s.patchProject)
	mux.HandleFunc("PUT /api/v1/projects/{id}/tasks/order", s.reorderProjectTasks)
	mux.HandleFunc("PATCH /api/v1/projects/{id}/tasks/order", s.reorderProjectTasks)
	mux.HandleFunc("DELETE /api/v1/projects/{id}", s.deleteProject)
	mux.HandleFunc("POST /api/v1/projects/{id}/github/sync", s.syncGitHubProjectHandler)
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.st.ListProjects()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// git 识别：标记哪些项目支持 worktree 隔离；GitHub 仓库为空时默认读取 origin remote。
	for i := range projects {
		if projects[i].ProjectDir != "" {
			projects[i].IsGit = workspace.IsGitRepo(projects[i].ProjectDir)
			if projects[i].GitHubRepo == "" && projects[i].IsGit {
				if repo, err := workspace.RemoteRepo(projects[i].ProjectDir); err == nil && repo != "" {
					projects[i].GitHubRepo = repo
				}
			}
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
	if strings.TrimSpace(in.GitHubRepo) == "" && strings.TrimSpace(in.ProjectDir) != "" {
		if repo, err := workspace.RemoteRepo(in.ProjectDir); err == nil && repo != "" {
			in.GitHubRepo = repo
		}
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
	set, ok := patchMap(w, r, "name", "description", "status", "project_dir", "github_repo", "github_role_id", "github_auto_issues", "github_auto_prs", "github_auto_security")
	if !ok {
		return
	}
	if v, ok := set["name"]; ok {
		if strings.TrimSpace(fmt.Sprint(v)) == "" {
			writeErr(w, http.StatusBadRequest, "项目名不能为空")
			return
		}
	}
	// 未显式填写 github_repo 时，默认从本地 git origin remote 自动识别。
	if _, hasRepo := set["github_repo"]; !hasRepo {
		cur, err := s.st.GetProject(id)
		if err != nil {
			writeErr(w, http.StatusNotFound, "项目不存在")
			return
		}
		dir := cur.ProjectDir
		if v, ok := set["project_dir"]; ok {
			dir = fmt.Sprint(v)
		}
		if cur.GitHubRepo == "" && dir != "" {
			if repo, err := workspace.RemoteRepo(dir); err == nil && repo != "" {
				set["github_repo"] = repo
			}
		}
	}
	if v, ok := set["status"]; ok {
		sv := fmt.Sprint(v)
		if sv != "active" && sv != "archived" {
			writeErr(w, http.StatusBadRequest, "非法项目状态: "+sv)
			return
		}
	}
	if v, ok := set["github_role_id"]; ok {
		if v == nil {
			set["github_role_id"] = nil
		} else if idf, ok := v.(float64); ok && idf > 0 {
			set["github_role_id"] = int64(idf)
		} else {
			writeErr(w, http.StatusBadRequest, "github_role_id 必须是正整数或 null")
			return
		}
	}
	for _, key := range []string{"github_auto_issues", "github_auto_prs", "github_auto_security"} {
		if v, ok := set[key]; ok {
			if _, ok := v.(bool); !ok {
				writeErr(w, http.StatusBadRequest, key+" 必须是布尔值")
				return
			}
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
