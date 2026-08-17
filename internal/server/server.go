package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"paihuo/internal/application"
	"paihuo/internal/artifact"
	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/session"
	"paihuo/internal/store"
	"paihuo/internal/web"
)

type Server struct {
	st           *store.Store
	hub          *events.EventStream
	ex           *exec.Executor
	sess         *session.Manager
	sched        *sched.Scheduler
	workflows    *application.WorkflowService
	tasks        *application.TaskLifecycle
	workspaces   *application.WorkspaceService
	artifacts    artifact.Store
	token        string
	skillsDir    string // 技能库工作目录（<db目录>/skills，导入或扫描发现的技能复制到这里）
	sessionsRoot string // 任务 worktree 根目录（<db目录>/sessions）
	loginPage    *template.Template
	mux          *http.ServeMux
	secureCookie bool            // only set during startup for TLS-terminating reverse proxies
	provMu       sync.Mutex      // 安装互斥锁
	provBusy     map[string]bool // 正在安装的 CLI
}

const (
	sessionCookie = "paihuo_session"
	sessionTTL    = 30 * 24 * time.Hour
	maxJSONBody   = 1 << 20 // 1 MiB
)

// Start reconciles persisted sessions and starts bounded background services.
// It must be called once before serving requests.
func (s *Server) Start(ctx context.Context) {
	s.sess.Recover()
	idle := 5 * time.Minute
	if v := os.Getenv("PAIHUO_SESSION_IDLE"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			idle = d
		}
	}
	log.Printf("会话空闲自动挂起阈值: %v（发消息自动恢复）", idle)
	s.sess.StartIdleMonitor(idle)
	s.workflows.StartMonitor(ctx)
	go func() {
		<-ctx.Done()
		s.sess.Stop()
	}()
}

// sessionValue creates an opaque, stateless session token. The expiry and a
// cryptographically random nonce are HMAC-signed with the configured token,
// so sessions survive restarts but are invalidated when that token changes.
func (s *Server) sessionValue() (string, error) {
	exp := time.Now().Add(sessionTTL).Unix()
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("生成会话随机数: %w", err)
	}
	payload := fmt.Sprintf("%d.%s", exp, base64.RawURLEncoding.EncodeToString(nonce))
	mac := hmac.New(sha256.New, []byte(s.token))
	_, _ = mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (s *Server) setSessionCookie(w http.ResponseWriter) bool {
	value, err := s.sessionValue()
	if err != nil {
		log.Printf("签发会话失败: %v", err)
		http.Error(w, "无法创建会话", http.StatusInternalServerError)
		return false
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: value, Path: "/",
		HttpOnly: true, Secure: s.secureCookie, SameSite: http.SameSiteLaxMode,
		MaxAge: int(sessionTTL.Seconds()),
	})
	return true
}

// SetSecureCookies marks session cookies as Secure. Call it once during
// startup when HTTPS is terminated by a reverse proxy; leave it disabled for
// direct local HTTP development.
func (s *Server) SetSecureCookies(secure bool) { s.secureCookie = secure }

func (s *Server) validSession(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 3 {
		return false
	}
	exp, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	nonce, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(nonce) != 32 {
		return false
	}
	got, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(s.token))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	return subtle.ConstantTimeCompare(got, mac.Sum(nil)) == 1
}

func New(st *store.Store, hub *events.EventStream, ex *exec.Executor, sc *sched.Scheduler, sess *session.Manager, workflows *application.WorkflowService, token, skillsDir string) *Server {
	runtimes := exec.NewDefaultRuntimeService()
	if ex != nil {
		runtimes = ex.RuntimeService()
	}
	s := &Server{
		st:           st,
		hub:          hub,
		ex:           ex,
		sess:         sess,
		sched:        sc,
		workflows:    workflows,
		tasks:        application.NewTaskLifecycle(st, runtimes, ex),
		token:        token,
		skillsDir:    skillsDir,
		sessionsRoot: filepath.Join(filepath.Dir(skillsDir), "sessions"),
		loginPage:    template.Must(template.ParseFS(web.FS, "templates/login.html")),
		mux:          http.NewServeMux(),
		provBusy:     map[string]bool{},
	}
	s.workspaces = application.NewWorkspaceService(st, s.sessionsRoot)
	var artifactErr error
	s.artifacts, artifactErr = artifact.NewLocalStore(filepath.Join(filepath.Dir(skillsDir), "artifacts"))
	if artifactErr != nil {
		log.Printf("ArtifactStore 初始化失败: %v", artifactErr)
	}

	m := s.mux
	m.HandleFunc("GET /login", s.pageLogin)
	m.HandleFunc("POST /login", s.login)
	m.HandleFunc("POST /logout", s.logout)
	m.Handle("GET /static/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := "dist/" + strings.TrimPrefix(r.URL.Path, "/static/")
		if !fs.ValidPath(name) {
			http.NotFound(w, r)
			return
		}
		b, err := fs.ReadFile(web.FS, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		sum := sha256.Sum256(b)
		etag := fmt.Sprintf(`"%x"`, sum[:8])
		w.Header().Set("ETag", etag)
		if strings.HasPrefix(name, "dist/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", mime.TypeByExtension(filepath.Ext(r.URL.Path)))
		w.Write(b)
	}))
	m.HandleFunc("GET /api/v1/events", s.sse)
	s.sessionRoutes(m)
	s.workflowRoutes(m)

	m.HandleFunc("GET /api/v1/tasks", s.listTasks)
	m.HandleFunc("POST /api/v1/tasks", s.createTask)
	m.HandleFunc("GET /api/v1/tasks/{id}", s.getTask)
	m.HandleFunc("PATCH /api/v1/tasks/{id}", s.patchTask)
	m.HandleFunc("DELETE /api/v1/tasks/{id}", s.deleteTask)
	m.HandleFunc("POST /api/v1/tasks/{id}/resume", s.resumeTask)
	m.HandleFunc("POST /api/v1/tasks/{id}/input", s.sendTaskInput)
	m.HandleFunc("POST /api/v1/tasks/{id}/resize", s.resizeTask)
	m.HandleFunc("POST /api/v1/tasks/{id}/end-session", s.endSession)
	m.HandleFunc("GET /api/v1/tasks/{id}/logs", s.getTaskLogs)
	m.HandleFunc("GET /api/v1/tasks/{id}/diff", s.taskDiff)
	m.HandleFunc("GET /api/v1/tasks/{id}/children", s.getTaskChildren)
	m.HandleFunc("POST /api/v1/tasks/cleanup", s.cleanupTasks)

	m.HandleFunc("GET /api/v1/settings", s.getSettings)
	m.HandleFunc("PUT /api/v1/settings", s.putSettings)

	m.HandleFunc("GET /api/v1/templates", s.listTemplates)
	m.HandleFunc("POST /api/v1/templates", s.createTemplate)
	m.HandleFunc("PATCH /api/v1/templates/{id}", s.patchTemplate)
	m.HandleFunc("DELETE /api/v1/templates/{id}", s.deleteTemplate)

	m.HandleFunc("GET /api/v1/roles", s.listRoles)
	m.HandleFunc("POST /api/v1/roles", s.createRole)
	m.HandleFunc("PATCH /api/v1/roles/{id}", s.patchRole)
	m.HandleFunc("DELETE /api/v1/roles/{id}", s.deleteRole)
	m.HandleFunc("GET /api/v1/runtimes", s.listRuntimes)
	m.HandleFunc("POST /api/v1/runtimes/refresh", s.refreshRuntimes)
	m.HandleFunc("POST /api/v1/role-studio/chat", s.roleStudioChat)
	m.HandleFunc("POST /api/v1/role-studio/test", s.roleStudioTest)
	m.HandleFunc("POST /api/v1/runtimes/install", s.provisionInstall)
	m.HandleFunc("GET /api/v1/runtimes/provisioning", s.provisionStatus)
	m.HandleFunc("GET /api/v1/skills", s.listSkills)
	m.HandleFunc("POST /api/v1/skills", s.createSkill)
	m.HandleFunc("PATCH /api/v1/skills", s.patchSkills)
	m.HandleFunc("DELETE /api/v1/skills", s.deleteSkills)
	m.HandleFunc("POST /api/v1/skills/scan", s.scanSkills)
	m.HandleFunc("GET /api/v1/skills/{id}", s.getSkill)
	m.HandleFunc("PATCH /api/v1/skills/{id}", s.patchSkill)
	m.HandleFunc("DELETE /api/v1/skills/{id}", s.deleteSkill)
	m.HandleFunc("GET /api/v1/extensions", s.listExtensions)
	m.HandleFunc("POST /api/v1/extensions/install", s.installExtension)
	m.HandleFunc("DELETE /api/v1/extensions/{name}", s.removeExtension)
	m.HandleFunc("GET /api/v1/workspace/{id}", s.workspaceStatus)
	m.HandleFunc("POST /api/v1/workspace/{id}/discard", s.workspaceDiscard)
	m.HandleFunc("POST /api/v1/workspace/git-init", s.workspaceGitInit)
	m.HandleFunc("GET /api/v1/fs/dirs", s.fsDirs)
	m.HandleFunc("POST /api/v1/fs/mkdir", s.fsMkdir)

	m.HandleFunc("GET /api/v1/projects", s.listProjects)
	m.HandleFunc("POST /api/v1/projects", s.createProject)
	m.HandleFunc("PATCH /api/v1/projects/{id}", s.patchProject)
	m.HandleFunc("PUT /api/v1/projects/{id}/tasks/order", s.reorderProjectTasks)
	m.HandleFunc("PATCH /api/v1/projects/{id}/tasks/order", s.reorderProjectTasks)
	m.HandleFunc("DELETE /api/v1/projects/{id}", s.deleteProject)

	m.HandleFunc("GET /api/v1/stats/overview", s.overviewStats)
	m.HandleFunc("GET /api/v1/stats/roles/{id}", s.roleStats)
	m.HandleFunc("GET /api/v1/stats/project/{id}", s.projectStats)

	m.HandleFunc("GET /api/v1/openapi.yaml", s.openAPISpec)
	s.artifactRoutes(m)

	// All authenticated browser routes share one React root. More-specific API,
	// login and static patterns above always win ServeMux routing.
	m.HandleFunc("GET /", s.pageApp)

	return s
}

// Handler 返回带会话鉴权的处理器。
// 令牌只用于「一次性登录」：POST /login 校验通过后签发 HttpOnly 会话
// cookie，之后所有请求（含 SSE 的 EventSource）凭 cookie 访问，令牌不再
// 出现在 URL / 前端代码里。
func (s *Server) Handler() http.Handler {
	var next http.Handler
	base := s.withIdempotency(s.mux)
	if s.token == "" {
		next = base
	} else {
		next = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := r.URL.Path
			if strings.HasPrefix(p, "/static/") || p == "/login" {
				s.mux.ServeHTTP(w, r)
				return
			}
			if !s.validSession(r) {
				if strings.HasPrefix(p, "/api/v1/") {
					writeErr(w, http.StatusUnauthorized, "未登录")
					return
				}
				http.Redirect(w, r, "/login", http.StatusFound)
				return
			}
			if !s.setSessionCookie(w) {
				return
			}
			base.ServeHTTP(w, r)
		})
	}
	return securityHeaders(next)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'")
		if !strings.HasPrefix(r.URL.Path, "/static/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// 页面

type pageData struct {
	Active     string
	LoginError string
}

func (s *Server) pageApp(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeErr(w, http.StatusNotFound, "API endpoint 不存在")
		return
	}
	b, err := fs.ReadFile(web.FS, "dist/index.html")
	if err != nil {
		http.Error(w, "前端资源未构建", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *Server) pageLogin(w http.ResponseWriter, r *http.Request) {
	s.renderLogin(w, pageData{})
}

// login 一次性验证令牌：正确则签发会话 cookie。
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	got := r.FormValue("token")
	if !s.validToken(got) {
		s.renderLogin(w, pageData{LoginError: "令牌不正确"})
		return
	}
	if !s.setSessionCookie(w) {
		return
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

// validToken compares fixed-size SHA-256 digests so a rejected login does not
// reveal the configured token length through the comparison itself.
func (s *Server) validToken(got string) bool {
	if s.token == "" {
		return false
	}
	wantSum := sha256.Sum256([]byte(s.token))
	gotSum := sha256.Sum256([]byte(got))
	return subtle.ConstantTimeCompare(gotSum[:], wantSum[:]) == 1
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
	})
	http.Redirect(w, r, "/login", http.StatusFound)
}

func (s *Server) renderLogin(w http.ResponseWriter, data pageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.loginPage.ExecuteTemplate(w, "base", data); err != nil {
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
	after := int64(0)
	if raw := r.Header.Get("Last-Event-ID"); raw != "" {
		after, _ = strconv.ParseInt(raw, 10, 64)
	}
	if raw := r.URL.Query().Get("after"); raw != "" {
		if value, err := strconv.ParseInt(raw, 10, 64); err == nil && value > after {
			after = value
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)
	w.WriteHeader(http.StatusOK)
	backlog, err := s.hub.History(after, 1000)
	if err != nil {
		return
	}
	last := after
	for _, event := range backlog {
		if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.Seq, event.Type, event.Marshal()); err != nil {
			return
		}
		last = event.Seq
	}
	fl.Flush()

	tk := time.NewTicker(15 * time.Second)
	defer tk.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.hub.Closed():
			return // 服务停机：断开长连接，让 http.Server.Shutdown 立即完成
		case ev := <-ch:
			if ev.Seq <= last {
				continue
			}
			if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.Seq, ev.Type, ev.Marshal()); err != nil {
				return // 客户端已断开，立即释放连接（写失败不等待下一个周期）
			}
			last = ev.Seq
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
	// Every transport path, including structured-session handlers, uses the
	// same machine-readable error envelope.
	if payload, ok := v.(map[string]any); ok {
		if message, ok := payload["error"].(string); ok {
			v = map[string]any{"error": map[string]any{"code": errorCode(code), "message": message}}
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]any{
		"code": errorCode(code), "message": msg,
	}})
}

func errorCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "bad_request"
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusConflict:
		return "conflict"
	case http.StatusPreconditionRequired:
		return "revision_required"
	case http.StatusUnprocessableEntity:
		return "policy_rejected"
	case http.StatusTooManyRequests:
		return "rate_limited"
	default:
		if status >= 500 {
			return "internal_error"
		}
		return "request_failed"
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return readJSONLimit(w, r, v, maxJSONBody)
}

func readJSONLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var maxErr *http.MaxBytesError
		switch {
		case errors.As(err, &maxErr):
			writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("请求体过大（最大 %d MiB）", limit/(1<<20)))
		case errors.Is(err, io.EOF):
			writeErr(w, http.StatusBadRequest, "请求体不能为空")
		default:
			writeErr(w, http.StatusBadRequest, "请求不是合法 JSON: "+err.Error())
		}
		return false
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeErr(w, http.StatusBadRequest, "请求体只能包含一个 JSON 对象")
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
