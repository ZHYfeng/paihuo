package server

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"paihuo/internal/application"
	"paihuo/internal/store"
	"paihuo/internal/workflow"
)

func (s *Server) workflowRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/workflows", s.listWorkflows)
	mux.HandleFunc("POST /api/v1/workflows", s.createWorkflow)
	mux.HandleFunc("GET /api/v1/workflows/{id}", s.getWorkflow)
	mux.HandleFunc("PUT /api/v1/workflows/{id}", s.updateWorkflow)
	mux.HandleFunc("DELETE /api/v1/workflows/{id}", s.deleteWorkflow)
	mux.HandleFunc("GET /api/v1/workflows/{id}/runs", s.listWorkflowRuns)
	mux.HandleFunc("POST /api/v1/workflows/{id}/runs", s.startWorkflow)
	mux.HandleFunc("GET /api/v1/workflow-runs/{id}", s.getWorkflowRun)
}

// createWorkflow 创建工作流：提交时同步完成确定性策略校验，不通过返回
// 422 + 违规明细（不落库）；通过则写入 adopted + spec_hash。
func (s *Server) createWorkflow(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Spec    workflow.Spec `json:"spec"`
		Cron    string        `json:"cron"`
		Enabled bool          `json:"enabled"`
		// 定时工作流（cron 非空）必填：定时触发启动 Run 时需要确定目标项目。
		ProjectID *int64 `json:"project_id"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	item, err := s.workflows.CreateWorkflow(in.Spec, in.Cron, in.Enabled, in.ProjectID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	if in.Cron != "" {
		s.sched.Reload()
	}
	writeResource(w, http.StatusCreated, item.Revision, item)
}

// updateWorkflow 整体替换工作流定义：重新策略校验（失败 422 + violations，
// 不落库），成功则重写 spec/spec_hash 与定时属性，revision 不符返回 409。
func (s *Server) updateWorkflow(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	var in struct {
		Spec      workflow.Spec `json:"spec"`
		Cron      string        `json:"cron"`
		Enabled   bool          `json:"enabled"`
		ProjectID *int64        `json:"project_id"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	item, err := s.workflows.UpdateWorkflow(id, revision, in.Spec, in.Cron, in.Enabled, in.ProjectID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	s.sched.Reload()
	writeResource(w, http.StatusOK, item.Revision, item)
}

// deleteWorkflow 删除工作流定义及其 Run 书签（节点任务解除关联后保留）；
// 有进行中的 Run 时返回 409。
func (s *Server) deleteWorkflow(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	if err := s.workflows.DeleteWorkflow(id, revision); err != nil {
		writeWorkflowError(w, err)
		return
	}
	s.sched.Reload()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listWorkflows(w http.ResponseWriter, r *http.Request) {
	items, err := s.workflows.ListWorkflows()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) getWorkflow(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	item, err := s.workflows.GetWorkflow(id)
	if err != nil || item == nil {
		writeErr(w, http.StatusNotFound, "Workflow 不存在")
		return
	}
	writeResource(w, http.StatusOK, item.Revision, item)
}

// startWorkflow 从工作流定义创建一次 Run，绑定调用方指定的具体项目，
// 原子实例化该工作流的节点任务。
func (s *Server) startWorkflow(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	var in struct {
		ProjectID int64 `json:"project_id"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	item, err := s.workflows.StartPlan(id, revision, in.ProjectID)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	writeResource(w, http.StatusCreated, item.Revision, item)
}

func (s *Server) listWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	items, err := s.workflows.ListRunsByWorkflow(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) getWorkflowRun(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	item, err := s.workflows.GetRun(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Workflow Run 不存在")
		return
	}
	writeResource(w, http.StatusOK, item.Revision, item)
}

func requiredRevision(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	raw = strings.TrimPrefix(raw, "W/")
	raw = strings.Trim(raw, `"`)
	revision, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || revision < 1 {
		writeErr(w, http.StatusPreconditionRequired, "mutation 必须携带有效的 If-Match revision")
		return 0, false
	}
	return revision, true
}

func writeResource(w http.ResponseWriter, status int, revision int64, value any) {
	w.Header().Set("ETag", `"`+strconv.FormatInt(revision, 10)+`"`)
	writeJSON(w, status, value)
}

// writeWorkflowError 输出工作流错误：策略违规带明细（violations），
// 其余按类型映射状态码。
func writeWorkflowError(w http.ResponseWriter, err error) {
	var validation *application.WorkflowValidationError
	if errors.As(err, &validation) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{
			"code": "policy_rejected", "message": validation.Error(), "violations": validation.Violations,
		}})
		return
	}
	if errors.Is(err, store.ErrRevisionConflict) {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	if errors.Is(err, store.ErrWorkflowRunsActive) {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "Workflow 不存在")
		return
	}
	writeErr(w, http.StatusUnprocessableEntity, err.Error())
}
