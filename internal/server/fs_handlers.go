package server

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func (s *Server) registerFSRoutes(mux *routeRegistrar) {
	mux.HandleFunc("GET /api/v1/fs/dirs", s.fsDirs)
	mux.HandleFunc("POST /api/v1/fs/mkdir", s.fsMkdir)
}

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
	// 拒绝目录穿越成分：filepath.Clean 之后仍含 ".." 的输入不予受理。
	if strings.Contains(abs, "..") {
		writeErr(w, http.StatusBadRequest, "非法路径（不允许包含 ..）")
		return
	}
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
	dirs := make([]string, 0)
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
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Path) == "" {
		writeErr(w, http.StatusBadRequest, "需要 path")
		return
	}
	abs, err := filepath.Abs(strings.TrimSpace(req.Path))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "无效路径")
		return
	}
	abs = filepath.Clean(abs)
	// 拒绝目录穿越成分：在 mkdir 前校验规范化后的路径不含 ".."。
	if strings.Contains(abs, "..") {
		writeErr(w, http.StatusBadRequest, "非法路径（不允许包含 ..）")
		return
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": abs})
}
