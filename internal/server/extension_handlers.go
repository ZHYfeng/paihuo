package server

import (
	"context"
	"net/http"
	"os"
	osexec "os/exec"
	"strings"
	"time"
)

func (s *Server) registerExtensionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/extensions", s.listExtensions)
	mux.HandleFunc("POST /api/v1/extensions/install", s.installExtension)
	mux.HandleFunc("DELETE /api/v1/extensions/{name}", s.removeExtension)
}

func runPi(timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := osexec.CommandContext(ctx, "pi", args...)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (s *Server) listExtensions(w http.ResponseWriter, r *http.Request) {
	raw, err := runPi(15*time.Second, "list")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"raw": strings.TrimSpace(raw), "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"raw": strings.TrimSpace(raw)})
}

func (s *Server) installExtension(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Source string `json:"source"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	in.Source = strings.TrimSpace(in.Source)
	if in.Source == "" {
		writeErr(w, http.StatusBadRequest, "需要 extension 来源（路径或包名）")
		return
	}
	raw, err := runPi(120*time.Second, "install", in.Source)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "pi install 失败: "+strings.TrimSpace(raw))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"raw": strings.TrimSpace(raw)})
}

func (s *Server) removeExtension(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		writeErr(w, http.StatusBadRequest, "需要 extension 名称")
		return
	}
	raw, err := runPi(60*time.Second, "remove", name)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "pi remove 失败: "+strings.TrimSpace(raw))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"raw": strings.TrimSpace(raw)})
}
