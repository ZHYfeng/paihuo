package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/store"
	"paihuo/internal/web"
)

type Server struct {
	st           *store.Store
	hub          *events.Hub
	ex           *exec.Executor
	sched        *sched.Scheduler
	token        string
	skillsDir    string                        // 技能库工作目录（<db目录>/skills，定向添加的技能复制到这里）
	sessionsRoot string                        // 任务 worktree 根目录（<db目录>/sessions）
	pages        map[string]*template.Template // 每页一个模板集（base + 页面，避免 content 冲突）
	mux          *http.ServeMux
	provMu       sync.Mutex      // 安装互斥锁
	provBusy     map[string]bool // 正在安装的 CLI
}

const (
	sessionCookie = "paihuo_session"
	sessionTTL    = 30 * 24 * time.Hour
)

// sessionValue 用令牌做 HMAC 签名会话（expiry.sig）：服务重启不失效，改令牌即全体失效。
func (s *Server) sessionValue() string {
	exp := time.Now().Add(sessionTTL).Unix()
	mac := hmac.New(sha256.New, []byte(s.token))
	fmt.Fprintf(mac, "%d", exp)
	return fmt.Sprintf("%d.%x", exp, mac.Sum(nil)[:16])
}

func (s *Server) setSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: s.sessionValue(), Path: "/",
		HttpOnly: true, SameSite: http.SameSiteLaxMode,
		MaxAge: int(sessionTTL.Seconds()),
	})
}

func (s *Server) validSession(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	parts := strings.SplitN(c.Value, ".", 2)
	if len(parts) != 2 {
		return false
	}
	exp, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	mac := hmac.New(sha256.New, []byte(s.token))
	fmt.Fprintf(mac, "%d", exp)
	return subtle.ConstantTimeCompare([]byte(parts[1]), []byte(hex.EncodeToString(mac.Sum(nil)[:16]))) == 1
}

func New(st *store.Store, hub *events.Hub, ex *exec.Executor, sc *sched.Scheduler, token, skillsDir string) *Server {
	s := &Server{
		st:           st,
		hub:          hub,
		ex:           ex,
		sched:        sc,
		token:        token,
		skillsDir:    skillsDir,
		sessionsRoot: filepath.Join(filepath.Dir(skillsDir), "sessions"),
		pages: map[string]*template.Template{
			"index":      template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/index.html")),
			"board":      template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/board.html")),
			"history":    template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/history.html")),
			"agents":     template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/agents.html")),
			"roles":      template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/roles.html")),
			"projects":   template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/projects.html")),
			"autopilots": template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/autopilots.html")),
			"skills":     template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/skills.html")),
			"settings":   template.Must(template.ParseFS(web.FS, "templates/base.html", "templates/settings.html")),
			"login":      template.Must(template.ParseFS(web.FS, "templates/login.html")),
		},
		mux:      http.NewServeMux(),
		provBusy: map[string]bool{},
	}

	m := s.mux
	m.HandleFunc("GET /", s.pageIndex)
	m.HandleFunc("GET /board", s.pageBoard)
	m.HandleFunc("GET /history", s.pageHistory)
	m.HandleFunc("GET /roles", s.pageRoles)
	m.HandleFunc("GET /agents", s.pageAgents)
	m.HandleFunc("GET /projects", s.pageProjects)
	m.HandleFunc("GET /autopilots", s.pageAutopilots)
	m.HandleFunc("GET /skills", s.pageSkills)
	m.HandleFunc("GET /settings", s.pageSettings)
	m.HandleFunc("GET /login", s.pageLogin)
	m.HandleFunc("POST /login", s.login)
	m.HandleFunc("POST /logout", s.logout)
	m.Handle("GET /static/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 内嵌资源随二进制更新：内容 hash 作 ETag，浏览器每次 revalidate。
		// 二进制更新后 hash 变化，客户端必然拿到新版前端（旧实现无 ETag，
		// 浏览器可能长期复用缓存的旧 app.js 导致页面脚本缺失）。
		f, err := web.FS.Open(strings.TrimPrefix(r.URL.Path, "/"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		b, err := io.ReadAll(f)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		sum := sha256.Sum256(b)
		etag := fmt.Sprintf(`"%x"`, sum[:8])
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "no-cache")
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", mime.TypeByExtension(filepath.Ext(r.URL.Path)))
		w.Write(b)
	}))
	m.HandleFunc("GET /api/events", s.sse)

	m.HandleFunc("GET /api/tasks", s.listTasks)
	m.HandleFunc("POST /api/tasks", s.createTask)
	m.HandleFunc("GET /api/tasks/{id}", s.getTask)
	m.HandleFunc("PATCH /api/tasks/{id}", s.patchTask)
	m.HandleFunc("DELETE /api/tasks/{id}", s.deleteTask)
	m.HandleFunc("POST /api/tasks/{id}/resume", s.resumeTask)
	m.HandleFunc("POST /api/tasks/{id}/input", s.sendTaskInput)
	m.HandleFunc("GET /api/tasks/{id}/logs", s.getTaskLogs)
	m.HandleFunc("GET /api/tasks/{id}/diff", s.taskDiff)
	m.HandleFunc("GET /api/tasks/{id}/children", s.getTaskChildren)
	m.HandleFunc("POST /api/tasks/cleanup", s.cleanupTasks)

	m.HandleFunc("GET /api/settings", s.getSettings)
	m.HandleFunc("PUT /api/settings", s.putSettings)

	m.HandleFunc("GET /api/templates", s.listTemplates)
	m.HandleFunc("POST /api/templates", s.createTemplate)
	m.HandleFunc("DELETE /api/templates/{id}", s.deleteTemplate)

	m.HandleFunc("GET /api/agents", s.listAgents)
	m.HandleFunc("POST /api/agents", s.createAgent)
	m.HandleFunc("PATCH /api/agents/{id}", s.patchAgent)
	m.HandleFunc("DELETE /api/agents/{id}", s.deleteAgent)
	m.HandleFunc("GET /api/agents/schema", s.listAgentSchemas)
	m.HandleFunc("POST /api/agents/schema/refresh", s.refreshAgentSchemas)
	m.HandleFunc("POST /api/provision/install", s.provisionInstall)
	m.HandleFunc("GET /api/provision", s.provisionStatus)
	m.HandleFunc("GET /api/skills", s.listSkills)
	m.HandleFunc("POST /api/skills", s.createSkill)
	m.HandleFunc("DELETE /api/skills/{id}", s.deleteSkill)
	m.HandleFunc("GET /api/extensions", s.listExtensions)
	m.HandleFunc("POST /api/extensions/install", s.installExtension)
	m.HandleFunc("DELETE /api/extensions/{name}", s.removeExtension)
	m.HandleFunc("GET /api/workspace/{id}", s.workspaceStatus)
	m.HandleFunc("POST /api/workspace/{id}/merge", s.workspaceMerge)
	m.HandleFunc("POST /api/workspace/{id}/discard", s.workspaceDiscard)
	m.HandleFunc("POST /api/workspace/git-init", s.workspaceGitInit)
	m.HandleFunc("GET /api/fs/dirs", s.fsDirs)
	m.HandleFunc("POST /api/fs/mkdir", s.fsMkdir)

	m.HandleFunc("GET /api/projects", s.listProjects)
	m.HandleFunc("POST /api/projects", s.createProject)
	m.HandleFunc("PATCH /api/projects/{id}", s.patchProject)
	m.HandleFunc("DELETE /api/projects/{id}", s.deleteProject)

	m.HandleFunc("GET /api/stats/overview", s.overviewStats)
	m.HandleFunc("GET /api/stats/agent/{id}", s.agentStats)
	m.HandleFunc("GET /api/stats/project/{id}", s.projectStats)

	m.HandleFunc("GET /api/schedules", s.listSchedules)
	m.HandleFunc("POST /api/schedules", s.createSchedule)
	m.HandleFunc("PATCH /api/schedules/{id}", s.patchSchedule)
	m.HandleFunc("DELETE /api/schedules/{id}", s.deleteSchedule)

	return s
}

// Handler 返回带会话鉴权的处理器。
// 令牌只用于「一次性登录」：POST /login 校验通过后签发 HttpOnly 会话
// cookie，之后所有请求（含 SSE 的 EventSource）凭 cookie 访问，令牌不再
// 出现在 URL / 前端代码里。
func (s *Server) Handler() http.Handler {
	if s.token == "" {
		return s.mux
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/static/") || p == "/login" {
			s.mux.ServeHTTP(w, r)
			return
		}
		if !s.validSession(r) {
			if strings.HasPrefix(p, "/api/") {
				writeErr(w, http.StatusUnauthorized, "未登录")
				return
			}
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		s.setSessionCookie(w) // 滑动续期
		s.mux.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// 页面

type pageData struct {
	Active     string
	LoginError string
}

func (s *Server) pageIndex(w http.ResponseWriter, r *http.Request) {
	s.render(w, "index", pageData{Active: "dashboard"})
}

func (s *Server) pageBoard(w http.ResponseWriter, r *http.Request) {
	s.render(w, "board", pageData{Active: "board"})
}

func (s *Server) pageHistory(w http.ResponseWriter, r *http.Request) {
	s.render(w, "history", pageData{Active: "history"})
}

func (s *Server) pageAgents(w http.ResponseWriter, r *http.Request) {
	s.render(w, "agents", pageData{Active: "agents"})
}

func (s *Server) pageRoles(w http.ResponseWriter, r *http.Request) {
	s.render(w, "roles", pageData{Active: "roles"})
}

func (s *Server) pageProjects(w http.ResponseWriter, r *http.Request) {
	s.render(w, "projects", pageData{Active: "projects"})
}

func (s *Server) pageAutopilots(w http.ResponseWriter, r *http.Request) {
	s.render(w, "autopilots", pageData{Active: "autopilots"})
}

func (s *Server) pageSkills(w http.ResponseWriter, r *http.Request) {
	s.render(w, "skills", pageData{Active: "skills"})
}

func (s *Server) pageSettings(w http.ResponseWriter, r *http.Request) {
	s.render(w, "settings", pageData{Active: "settings"})
}

func (s *Server) pageLogin(w http.ResponseWriter, r *http.Request) {
	s.render(w, "login", pageData{})
}

// login 一次性验证令牌：正确则签发会话 cookie。
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	got := r.FormValue("token")
	if s.token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
		s.render(w, "login", pageData{LoginError: "令牌不正确"})
		return
	}
	s.setSessionCookie(w)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
	})
	http.Redirect(w, r, "/login", http.StatusFound)
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
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, ev.Marshal()); err != nil {
				return // 客户端已断开，立即释放连接（写失败不等待下一个周期）
			}
			fl.Flush()
		case <-tk.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
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
