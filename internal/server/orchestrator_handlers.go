package server

import "net/http"

func (s *Server) registerOrchestratorRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/mcp", s.orchestrator.HandleHTTP)
}
