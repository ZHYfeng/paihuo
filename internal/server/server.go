package server

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/web"
)

func mustSub(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(err)
	}
	return sub
}

type Server struct {
	st    *store.Store
	hub   *events.Hub
	ex    *exec.Executor
	token string
	pages map[string]*template.Template // 每页一个模板集（base + 页面，避免 content 冲突）
	mux   *http.ServeMux
}

func New(st *store.Store, hub *events.Hub, ex *exec.Executor, token string) *Server {
	s := &Server{
		st:    st,
		hub:   hub,
		ex:    ex,
		token: token,
		pages: map[string]*template.Template{
			"index":    template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/index.html")),
			"settings": template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/settings.html")),
		},
		mux: http.NewServeMux(),
	}

	m := s.mux
	m.HandleFunc("GET /", s.pageIndex)
	m.HandleFunc("GET /settings", s.pageSettings)
	m.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(mustSub(web.FS, "static"))))
	m.HandleFunc("GET /api/events", s.sse)

	m.HandleFunc("GET /api/tasks", s.listTasks)
	m.HandleFunc("POST /api/tasks", s.createTask)
	m.HandleFunc("GET /api/tasks/{id}", s.getTask)
	m.HandleFunc("PATCH /api/tasks/{id}", s.patchTask)
	m.HandleFunc("DELETE /api/tasks/{id}", s.deleteTask)
	m.HandleFunc("GET /api/tasks/{id}/logs", s.getTaskLogs)
	m.HandleFunc("GET /api/tasks/{id}/diff", s.taskDiff)

	m.HandleFunc("GET /api/agents", s.listAgents)
	m.HandleFunc("POST /api/agents", s.createAgent)
	m.HandleFunc("PATCH /api/agents/{id}", s.patchAgent)
	m.HandleFunc("DELETE /api/agents/{id}", s.deleteAgent)

	m.HandleFunc("GET /api/schedules", s.listSchedules)
	m.HandleFunc("POST /api/schedules", s.createSchedule)
	m.HandleFunc("PATCH /api/schedules/{id}", s.patchSchedule)
	m.HandleFunc("DELETE /api/schedules/{id}", s.deleteSchedule)

	return s
}

func (s *Server) Handler() http.Handler {
	if s.token == "" {
		return s.mux
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("Authorization")
		got = strings.TrimPrefix(got, "Bearer ")
		if got == "" {
			got = r.URL.Query().Get("token")
		}
		if got != s.token {
			http.Error(w, "未授权", http.StatusUnauthorized)
			return
		}
		s.mux.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// 页面

type pageData struct {
	Active string
	Token  string
}

func (s *Server) pageIndex(w http.ResponseWriter, r *http.Request) {
	s.render(w, "index", pageData{Active: "board", Token: s.token})
}

func (s *Server) pageSettings(w http.ResponseWriter, r *http.Request) {
	s.render(w, "settings", pageData{Active: "settings", Token: s.token})
}

func (s *Server) render(w http.ResponseWriter, page string, data pageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.pages[page].ExecuteTemplate(w, "base", data); err != nil {
		log.Printf("模板渲染失败: %v", err)
	}
}

// ---------------------------------------------------------------------------
// SSE

func (s *Server) sse(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE 不支持", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fl.Flush()

	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)

	tk := time.NewTicker(15 * time.Second)
	defer tk.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, ev.Marshal())
			fl.Flush()
		case <-tk.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// ---------------------------------------------------------------------------
// 工具

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "读取请求失败: "+err.Error())
		return false
	}
	if err := json.Unmarshal(body, v); err != nil {
		writeErr(w, http.StatusBadRequest, "请求不是合法 JSON: "+err.Error())
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "非法 id")
		return 0, false
	}
	return id, true
}

// patchMap 解析 PATCH 请求体为字段白名单 map。
func patchMap(w http.ResponseWriter, r *http.Request, allowed ...string) (map[string]any, bool) {
	var raw map[string]json.RawMessage
	if !readJSON(w, r, &raw) {
		return nil, false
	}
	allow := map[string]bool{}
	for _, k := range allowed {
		allow[k] = true
	}
	out := map[string]any{}
	for k, v := range raw {
		if !allow[k] {
			writeErr(w, http.StatusBadRequest, "不允许修改字段: "+k)
			return nil, false
		}
		var val any
		if err := json.Unmarshal(v, &val); err != nil {
			writeErr(w, http.StatusBadRequest, "字段 "+k+" 非法")
			return nil, false
		}
		out[k] = val
	}
	return out, true
}

// 供 exec 包避免未使用告警（保留以扩展）
