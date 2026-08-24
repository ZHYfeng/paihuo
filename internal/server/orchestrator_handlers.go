package server

func (s *Server) registerOrchestratorRoutes(mux *routeRegistrar) {
	mux.HandleFunc("POST /api/v1/mcp", s.orchestrator.HandleHTTP)
}
