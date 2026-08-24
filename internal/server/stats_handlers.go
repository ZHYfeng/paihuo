package server

import "net/http"

func (s *Server) registerStatsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/stats/overview", s.overviewStats)
	mux.HandleFunc("GET /api/v1/stats/roles/{id}", s.roleStats)
	mux.HandleFunc("GET /api/v1/stats/projects/{id}", s.projectStats)
}

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
