package server

import (
	"embed"
	"net/http"
)

//go:embed openapi.yaml
var apiContract embed.FS

func (s *Server) registerOpenAPIRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/openapi.yaml", s.openAPISpec)
}

func (s *Server) openAPISpec(w http.ResponseWriter, _ *http.Request) {
	body, err := apiContract.ReadFile("openapi.yaml")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "API contract 不可用")
		return
	}
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(body)
}
