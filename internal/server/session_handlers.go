package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"paihuo/internal/session"
	"paihuo/internal/store"
)

// 会话 API（S-1）：CRUD + 状态机 + pi RPC 会话命令。
// 设计：docs/design/03-session-backend.md §6

type sessionIn struct {
	ProjectID *int64 `json:"project_id"`
	AgentID   int64  `json:"agent_id"`
	Title     string `json:"title"`
}

type deliverIn struct {
	TaskTitle string `json:"task_title"`
	TaskBody  string `json:"task_body"`
	Perm      string `json:"perm"`
}

type promptIn struct {
	Message           string           `json:"message"`
	Images            []map[string]any `json:"images"`
	StreamingBehavior string           `json:"streaming_behavior"`
}

type commandIn struct {
	Command string         `json:"command"`
	Fields  map[string]any `json:"fields"`
}

type askIn struct {
	ID        string `json:"id"`
	Value     string `json:"value"`
	Confirmed *bool  `json:"confirmed"`
	Cancelled bool   `json:"cancelled"`
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	f := store.SessionFilter{}
	if v := r.URL.Query().Get("status"); v != "" {
		f.Status = v
	}
	if v := r.URL.Query().Get("project_id"); v != "" {
		id, err := parseID(v)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": "project_id 非法"})
			return
		}
		f.ProjectID = &id
	}
	list, err := s.sess.List(f)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, list)
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var in sessionIn
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]any{"error": "请求体非法: " + err.Error()})
		return
	}
	if in.AgentID <= 0 {
		writeJSON(w, 400, map[string]any{"error": "请选择角色"})
		return
	}
	if trimSpace(in.Title) == "" {
		writeJSON(w, 400, map[string]any{"error": "请填写会话标题"})
		return
	}
	ss, err := s.sess.Create(in.ProjectID, in.AgentID, trimSpace(in.Title))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 201, ss)
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	ss, err := s.sess.Get(id)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if ss == nil {
		writeJSON(w, 404, map[string]any{"error": "会话不存在"})
		return
	}
	writeJSON(w, 200, ss)
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.sess.Start(ctx, id); err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) suspendSession(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.sess.Suspend(ctx, id); err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) resumeSession(w http.ResponseWriter, r *http.Request) {
	s.startSession(w, r) // resume 与 start 同路径语义（状态机区分）
}

func (s *Server) deliverSession(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	var in deliverIn
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]any{"error": "请求体非法: " + err.Error()})
		return
	}
	ss, err := s.sess.Get(id)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if ss == nil {
		writeJSON(w, 404, map[string]any{"error": "会话不存在"})
		return
	}
	title := trimSpace(in.TaskTitle)
	if title == "" {
		title = ss.Title
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	tk, err := s.sess.Deliver(ctx, id, title, in.TaskBody, in.Perm)
	if err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, tk)
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.sess.Delete(ctx, id); err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) sessionPrompt(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	var in promptIn
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]any{"error": "请求体非法: " + err.Error()})
		return
	}
	if trimSpace(in.Message) == "" && len(in.Images) == 0 {
		writeJSON(w, 400, map[string]any{"error": "消息不能为空"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	accepted, err := s.sess.Prompt(ctx, id, in.Message, in.Images, in.StreamingBehavior)
	if err != nil {
		code := 409
		if errors.Is(err, session.ErrSessionNotFound) {
			code = 404
		}
		writeJSON(w, code, map[string]any{"error": err.Error()})
		return
	}
	if !accepted {
		writeJSON(w, 409, map[string]any{"error": "消息被拒绝（agent 运行中请使用 steer/follow_up 或先中止）"})
		return
	}
	writeJSON(w, 200, map[string]any{"accepted": true})
}

func (s *Server) sessionAbort(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := s.sess.Abort(ctx, id); err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// sessionAsk 应答 pi agent 的交互式提问（extension_ui_request →
// extension_ui_response）。select/input/editor 传 value；confirm 传
// confirmed；取消传 cancelled。
func (s *Server) sessionAsk(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	var in askIn
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]any{"error": "请求体非法: " + err.Error()})
		return
	}
	if in.ID == "" {
		writeJSON(w, 400, map[string]any{"error": "ask id 不能为空"})
		return
	}
	if !in.Cancelled && in.Confirmed == nil && trimSpace(in.Value) == "" {
		writeJSON(w, 400, map[string]any{"error": "应答内容不能为空"})
		return
	}
	if err := s.sess.AnswerAsk(id, in.ID, in.Value, in.Confirmed, in.Cancelled); err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) sessionCommand(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	var in commandIn
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]any{"error": "请求体非法: " + err.Error()})
		return
	}
	if in.Command == "" {
		writeJSON(w, 400, map[string]any{"error": "command 不能为空"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	data, err := s.sess.Command(ctx, id, in.Command, in.Fields)
	if err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"data": json.RawMessage(data)})
}

func (s *Server) sessionMessages(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	data, err := s.sess.Messages(ctx, id)
	if err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"data": json.RawMessage(data)})
}

func (s *Server) sessionState(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	data, err := s.sess.State(ctx, id)
	if err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"data": json.RawMessage(data)})
}

func (s *Server) sessionTranscript(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	// 分页：?limit=100&before=<entryId>（before 含该条向后取；不传=取尾部 limit 条）
	limit := 0
	before := r.URL.Query().Get("before")
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := parseID(v); err == nil && n > 0 && n <= 500 {
			limit = int(n)
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	entries, total, err := s.sess.Transcript(ctx, id, limit, before)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"entries": entries, "total": total})
}

// S5：终端式会话（codex/claude）通道。
type termIn struct {
	Text string `json:"text"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	Raw  bool   `json:"raw"` // 原始按键（不追加回车）
}

func (s *Server) sessionTermInput(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	var in termIn
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]any{"error": "请求体非法"})
		return
	}
	if in.Raw {
		err = s.sess.TermInputRaw(id, in.Text)
	} else {
		err = s.sess.TermInput(id, in.Text)
	}
	if err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) sessionTermResize(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	var in termIn
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, 400, map[string]any{"error": "请求体非法"})
		return
	}
	if err := s.sess.TermResize(id, in.Cols, in.Rows); err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) sessionTermOutput(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "会话 id 非法"})
		return
	}
	out, alive, err := s.sess.TermOutput(id)
	if err != nil {
		writeJSON(w, 409, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"output": out, "alive": alive})
}

func (s *Server) sessionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sessions", s.listSessions)
	mux.HandleFunc("POST /api/sessions", s.createSession)
	mux.HandleFunc("GET /api/sessions/{id}", s.getSession)
	mux.HandleFunc("POST /api/sessions/{id}/start", s.startSession)
	mux.HandleFunc("POST /api/sessions/{id}/resume", s.resumeSession)
	mux.HandleFunc("POST /api/sessions/{id}/suspend", s.suspendSession)
	mux.HandleFunc("POST /api/sessions/{id}/deliver", s.deliverSession)
	mux.HandleFunc("DELETE /api/sessions/{id}", s.deleteSession)
	mux.HandleFunc("POST /api/sessions/{id}/prompt", s.sessionPrompt)
	mux.HandleFunc("POST /api/sessions/{id}/ask", s.sessionAsk)
	mux.HandleFunc("POST /api/sessions/{id}/abort", s.sessionAbort)
	mux.HandleFunc("POST /api/sessions/{id}/command", s.sessionCommand)
	mux.HandleFunc("GET /api/sessions/{id}/messages", s.sessionMessages)
	mux.HandleFunc("GET /api/sessions/{id}/state", s.sessionState)
	mux.HandleFunc("GET /api/sessions/{id}/transcript", s.sessionTranscript)
	mux.HandleFunc("POST /api/sessions/{id}/terminal/input", s.sessionTermInput)
	mux.HandleFunc("POST /api/sessions/{id}/terminal/resize", s.sessionTermResize)
	mux.HandleFunc("GET /api/sessions/{id}/terminal/output", s.sessionTermOutput)
}

func parseID(s string) (int64, error) {
	var id int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("非法数字")
		}
		id = id*10 + int64(c-'0')
	}
	if id <= 0 {
		return 0, errors.New("非法数字")
	}
	return id, nil
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

var _ = log.Printf
