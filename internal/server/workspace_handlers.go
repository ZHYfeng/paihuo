package server

import "net/http"

func (s *Server) registerWorkspaceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/workspace/{id}", s.workspaceStatus)
	mux.HandleFunc("POST /api/v1/workspace/{id}/discard", s.workspaceDiscard)
	mux.HandleFunc("POST /api/v1/workspace/git-init", s.workspaceGitInit)
}

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
