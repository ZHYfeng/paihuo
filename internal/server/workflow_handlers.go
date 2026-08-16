package server

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"paihuo/internal/store"
	"paihuo/internal/workflow"
)

func (s *Server) workflowRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/workflow-proposals", s.listWorkflowProposals)
	mux.HandleFunc("POST /api/v1/workflow-proposals", s.createWorkflowProposal)
	mux.HandleFunc("GET /api/v1/workflow-proposals/{id}", s.getWorkflowProposal)
	mux.HandleFunc("POST /api/v1/workflow-proposals/{id}/validate", s.validateWorkflowProposal)
	mux.HandleFunc("POST /api/v1/workflow-proposals/{id}/adopt", s.adoptWorkflowProposal)
	mux.HandleFunc("GET /api/v1/workflows", s.listWorkflows)
	mux.HandleFunc("GET /api/v1/workflows/{id}", s.getWorkflow)
	mux.HandleFunc("GET /api/v1/workflows/{id}/runs", s.listWorkflowRuns)
	mux.HandleFunc("POST /api/v1/workflows/{id}/runs", s.startWorkflow)
	mux.HandleFunc("GET /api/v1/workflow-runs/{id}", s.getWorkflowRun)
}

func (s *Server) createWorkflowProposal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Spec    workflow.Spec `json:"spec"`
		Cron    string        `json:"cron"`
		Enabled bool          `json:"enabled"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	item, err := s.workflows.CreateProposal(in.Spec, in.Cron, in.Enabled)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.Cron != "" {
		s.sched.Reload()
	}
	writeResource(w, http.StatusCreated, item.Revision, item)
}

func (s *Server) listWorkflowProposals(w http.ResponseWriter, r *http.Request) {
	items, err := s.workflows.ListProposals()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) getWorkflowProposal(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	item, err := s.workflows.GetProposal(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Workflow Proposal 不存在")
		return
	}
	writeResource(w, http.StatusOK, item.Revision, item)
}

func (s *Server) validateWorkflowProposal(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	item, err := s.workflows.ValidateProposal(id, revision)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	writeResource(w, http.StatusOK, item.Revision, item)
}

func (s *Server) adoptWorkflowProposal(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	item, err := s.workflows.AdoptProposal(id, revision)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	writeResource(w, http.StatusCreated, item.Revision, item)
}

func (s *Server) listWorkflows(w http.ResponseWriter, r *http.Request) {
	items, err := s.workflows.ListPlans()
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
	item, err := s.workflows.GetPlan(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Workflow 不存在")
		return
	}
	writeResource(w, http.StatusOK, item.Revision, item)
}

func (s *Server) startWorkflow(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	item, err := s.workflows.StartPlan(id, revision)
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

func writeWorkflowError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrRevisionConflict) {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	writeErr(w, http.StatusUnprocessableEntity, err.Error())
}
