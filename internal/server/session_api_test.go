package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"paihuo/internal/application"
	"paihuo/internal/events"
	execpkg "paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/session"
	"paihuo/internal/store"
)

func TestCreateSessionUsesRoleNameAsTitle(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	aid, err := st.CreateRole(store.Role{Name: "会话角色", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewEventStream()
	sess := session.New(st, hub, nil, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, execpkg.NewDefaultRuntimeService(), nil, hub)
	sc := sched.New(st, hub, nil, sess, wf)
	s := New(st, hub, nil, sc, sess, wf, "", filepath.Join(t.TempDir(), "skills"))
	req := httptest.NewRequest("POST", "/api/v1/sessions", strings.NewReader(`{"role_id":`+itoa(aid)+`}`))
	req.Header.Set("Content-Type", "application/json")
	resp := httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != 201 {
		t.Fatalf("create: %d %s", resp.Code, resp.Body.String())
	}
	var created store.Task
	if err := json.Unmarshal(resp.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Title != "会话角色" {
		t.Fatalf("title=%q, want agent name %q", created.Title, "会话角色")
	}
}

// TestSessionAPI 会话 API 全流程（状态机 + 交付桥接，真实 pi 进程冒烟）。
func TestSessionAPI(t *testing.T) {
	if os.Getenv("PAIHUO_REAL_RUNTIME_TESTS") != "1" {
		t.Skip("设置 PAIHUO_REAL_RUNTIME_TESTS=1 后运行真实 Pi 冒烟")
	}
	if _, err := os.Stat("/usr/local/bin/pi"); err != nil {
		if _, err2 := osexec.LookPath("pi"); err2 != nil {
			t.Skip("本机未安装 pi，跳过会话 API 冒烟")
		}
	}
	root := t.TempDir()
	st, err := store.Open(filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// git 项目（worktree 隔离验证）
	projDir := filepath.Join(root, "proj")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(projDir, "init", "-b", "main")
	runGit(projDir, "config", "user.email", "t@t")
	runGit(projDir, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(projDir, "a.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(projDir, "add", ".")
	runGit(projDir, "commit", "-m", "init")

	pid, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projDir})
	if err != nil {
		t.Fatal(err)
	}
	aid, err := st.CreateRole(store.Role{Name: "pi-role", RuntimeID: "pi", Enabled: true, MaxConcurrency: 2})
	if err != nil {
		t.Fatal(err)
	}

	hub := events.NewEventStream()
	sessionsRoot := filepath.Join(root, "sessions")
	executor := execpkg.NewForTest(st, hub, sessionsRoot, filepath.Join(root, "db"), "sess-api")
	sess := session.New(st, hub, executor, sessionsRoot, t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	sc := sched.New(st, hub, executor, sess, wf)
	s := New(st, hub, executor, sc, sess, wf, "", filepath.Join(root, "skills"))
	mux := s.Handler()

	do := func(method, path, body string) (int, map[string]any) {
		var r *strings.Reader
		if body == "" {
			r = strings.NewReader("")
		} else {
			r = strings.NewReader(body)
		}
		req := httptest.NewRequest(method, path, r)
		req.Header.Set("Content-Type", "application/json")
		if method == "DELETE" && strings.HasPrefix(path, "/api/v1/tasks/") {
			id, err := parseID(strings.TrimPrefix(path, "/api/v1/tasks/"))
			if err != nil {
				t.Fatal(err)
			}
			setTaskRevision(t, st, id, req)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}

	// 创建（created + worktree）
	code, out := do("POST", "/api/v1/sessions", `{"project_id":`+itoa(pid)+`,"role_id":`+itoa(aid)+`}`)
	if code != 201 {
		t.Fatalf("create: %d %v", code, out)
	}
	sid := int64(out["id"].(float64))
	if out["status"] != store.SessionStatusCreated {
		t.Fatalf("status=%v", out["status"])
	}
	if out["title"] != "pi-role" {
		t.Fatalf("title=%v, want agent name pi-role", out["title"])
	}
	if out["worktree_branch"] != "paihuo/session-1" {
		t.Fatalf("branch=%v", out["worktree_branch"])
	}

	// 启动（spawn pi RPC 进程）
	code, out = do("POST", "/api/v1/sessions/"+itoa(sid)+"/start", "")
	if code != 200 {
		t.Fatalf("start: %d %v", code, out)
	}
	code, out = do("GET", "/api/v1/sessions/"+itoa(sid), "")
	if code != 200 || out["status"] != store.SessionStatusActive {
		t.Fatalf("get: %d %v", code, out)
	}

	// prompt → 消息可读
	code, out = do("POST", "/api/v1/sessions/"+itoa(sid)+"/prompt", `{"message":"只回复 OK"}`)
	if code != 200 {
		b, _ := os.ReadFile(filepath.Join(sessionsRoot, ".runtime-sessions", "session-"+itoa(sid), "stderr.log"))
		t.Logf("stderr.log: %s", string(b))
	}
	if code != 200 || out["accepted"] != true {
		t.Fatalf("prompt: %d %v", code, out)
	}
	code, out = do("GET", "/api/v1/sessions/"+itoa(sid)+"/state", "")
	if code != 200 {
		t.Fatalf("state: %d", code)
	}
	// 等 agent 完成（transcript 需消息落盘）
	deadline := time.Now().Add(150 * time.Second)
	for {
		code, st := do("GET", "/api/v1/sessions/"+itoa(sid)+"/state", "")
		if code == 200 {
			if d, ok := st["data"].(map[string]any); ok {
				if streaming, _ := d["isStreaming"].(bool); !streaming {
					break
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("agent 未在 150s 内完成")
		}
		time.Sleep(500 * time.Millisecond)
	}
	// transcript 全量（含 header entry）
	// transcript 全量（数组；直接读 body）
	req := httptest.NewRequest("GET", "/api/v1/sessions/"+itoa(sid)+"/transcript", strings.NewReader(""))
	w2 := httptest.NewRecorder()
	mux.ServeHTTP(w2, req)
	if w2.Code != 200 {
		t.Fatalf("transcript: %d %s", w2.Code, w2.Body.String())
	}
	var tr struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &tr); err != nil || len(tr.Entries) < 2 || tr.Total < 2 {
		t.Fatalf("transcript: err=%v n=%d total=%d body=%s", err, len(tr.Entries), tr.Total, w2.Body.String()[:200])
	}

	// 挂起 → 恢复
	code, out = do("POST", "/api/v1/sessions/"+itoa(sid)+"/suspend", "")
	if code != 200 {
		t.Fatalf("suspend: %d %v", code, out)
	}
	code, out = do("POST", "/api/v1/sessions/"+itoa(sid)+"/resume", "")
	if code != 200 {
		t.Fatalf("resume: %d %v", code, out)
	}

	// 交付 → 任务直接收编（跳过 agent 执行）：full + git → 已完成 + 自动创建合并任务
	code, out = do("POST", "/api/v1/sessions/"+itoa(sid)+"/deliver", `{"perm":"full"}`)
	if code != 200 {
		t.Fatalf("deliver: %d %v", code, out)
	}
	tkID := int64(out["id"].(float64))
	if out["session_id"] == nil || int64(out["session_id"].(float64)) != sid {
		t.Fatalf("task.session_id=%v", out["session_id"])
	}
	if out["worktree_branch"] != "paihuo/session-1" {
		t.Fatalf("task 分支=%v", out["worktree_branch"])
	}
	if out["status"] != store.StatusSucceeded {
		t.Fatalf("交付任务应直接完成（跳过执行），status=%v", out["status"])
	}
	if body, ok := out["body"].(string); !ok || !strings.Contains(body, "会话 #"+itoa(sid)) {
		t.Fatalf("交付任务 body 应预填会话摘要: %v", out["body"])
	}
	// 代码合并任务已自动创建（整合会话分支）
	req = httptest.NewRequest("GET", "/api/v1/tasks/"+itoa(tkID)+"/children", strings.NewReader(""))
	w2 = httptest.NewRecorder()
	mux.ServeHTTP(w2, req)
	if w2.Code != 200 {
		t.Fatalf("children: %d", w2.Code)
	}
	var kids []struct {
		ID      int64  `json:"id"`
		MergeOf *int64 `json:"merge_of"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &kids); err != nil || len(kids) != 1 || kids[0].MergeOf == nil || *kids[0].MergeOf != tkID {
		t.Fatalf("交付任务应有一个合并子任务: err=%v kids=%+v body=%s", err, kids, w2.Body.String())
	}

	// 会话冻结；重复交付拒绝
	code, out = do("POST", "/api/v1/sessions/"+itoa(sid)+"/deliver", `{"perm":"full"}`)
	if code != 409 {
		t.Fatalf("重复交付应 409: %d %v", code, out)
	}

	// 列表
	code, out = do("GET", "/api/v1/sessions", "")
	if code != 200 {
		t.Fatalf("list: %d", code)
	}

	// 交付即终态：删除交付任务 → 会话联动清理（不再解冻可反复交付）
	code, out = do("DELETE", "/api/v1/tasks/"+itoa(tkID), "")
	if code != 204 {
		t.Fatalf("删除交付任务应 204: %d %v", code, out)
	}
	code, out = do("GET", "/api/v1/sessions/"+itoa(sid), "")
	if code != 200 || out["status"] != store.SessionStatusDeleted {
		t.Fatalf("任务删除后会话应联动清理，status=%v", out["status"])
	}

	// 第二会话：created 直接删除
	code, out = do("POST", "/api/v1/sessions", `{"project_id":`+itoa(pid)+`,"role_id":`+itoa(aid)+`}`)
	if code != 201 {
		t.Fatalf("create2: %d %v", code, out)
	}
	sid2 := int64(out["id"].(float64))
	code, out = do("DELETE", "/api/v1/sessions/"+itoa(sid2), "")
	if code != 200 {
		t.Fatalf("delete: %d %v", code, out)
	}
	code, out = do("GET", "/api/v1/sessions/"+itoa(sid2), "")
	if code != 200 || out["status"] != store.SessionStatusDeleted {
		t.Fatalf("删除后 status=%v", out["status"])
	}
}
