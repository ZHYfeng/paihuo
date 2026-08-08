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

	"paihuo/internal/events"
	execpkg "paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/store"
)

// TestSessionAPI 会话 API 全流程（状态机 + 交付桥接，真实 pi 进程冒烟）。
func TestSessionAPI(t *testing.T) {
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
	aid, err := st.CreateAgent(store.Agent{Name: "pi-role", CLI: "pi", Enabled: true, ProjectDir: projDir, MaxConcurrency: 2})
	if err != nil {
		t.Fatal(err)
	}

	hub := events.NewHub()
	sessionsRoot := filepath.Join(root, "sessions")
	executor := execpkg.NewForTest(st, hub, sessionsRoot, filepath.Join(root, "db"), "sess-api")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", filepath.Join(root, "skills"))
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
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}

	// 创建（created + worktree）
	code, out := do("POST", "/api/sessions", `{"project_id":`+itoa(pid)+`,"agent_id":`+itoa(aid)+`,"title":"会话1"}`)
	if code != 201 {
		t.Fatalf("create: %d %v", code, out)
	}
	sid := int64(out["id"].(float64))
	if out["status"] != store.SessionStatusCreated {
		t.Fatalf("status=%v", out["status"])
	}
	if out["worktree_branch"] != "paihuo/session-1" {
		t.Fatalf("branch=%v", out["worktree_branch"])
	}

	// 启动（spawn pi RPC 进程）
	code, out = do("POST", "/api/sessions/"+itoa(sid)+"/start", "")
	if code != 200 {
		t.Fatalf("start: %d %v", code, out)
	}
	code, out = do("GET", "/api/sessions/"+itoa(sid), "")
	if code != 200 || out["status"] != store.SessionStatusActive {
		t.Fatalf("get: %d %v", code, out)
	}

	// prompt → 消息可读
	code, out = do("POST", "/api/sessions/"+itoa(sid)+"/prompt", `{"message":"只回复 OK"}`)
	if code != 200 {
		b, _ := os.ReadFile(filepath.Join(sessionsRoot, ".agent-sessions", "session-"+itoa(sid), "stderr.log"))
		t.Logf("stderr.log: %s", string(b))
	}
	if code != 200 || out["accepted"] != true {
		t.Fatalf("prompt: %d %v", code, out)
	}
	code, out = do("GET", "/api/sessions/"+itoa(sid)+"/state", "")
	if code != 200 {
		t.Fatalf("state: %d", code)
	}
	// 等 agent 完成（transcript 需消息落盘）
	deadline := time.Now().Add(150 * time.Second)
	for {
		code, st := do("GET", "/api/sessions/"+itoa(sid)+"/state", "")
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
	req := httptest.NewRequest("GET", "/api/sessions/"+itoa(sid)+"/transcript", strings.NewReader(""))
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
	code, out = do("POST", "/api/sessions/"+itoa(sid)+"/suspend", "")
	if code != 200 {
		t.Fatalf("suspend: %d %v", code, out)
	}
	code, out = do("POST", "/api/sessions/"+itoa(sid)+"/resume", "")
	if code != 200 {
		t.Fatalf("resume: %d %v", code, out)
	}

	// 交付 → 任务 created 且复用会话 worktree
	code, out = do("POST", "/api/sessions/"+itoa(sid)+"/deliver", `{"perm":"full"}`)
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

	// 会话冻结；重复交付拒绝
	code, out = do("POST", "/api/sessions/"+itoa(sid)+"/deliver", `{"perm":"full"}`)
	if code != 409 {
		t.Fatalf("重复交付应 409: %d %v", code, out)
	}

	// 列表
	code, out = do("GET", "/api/sessions", "")
	if code != 200 {
		t.Fatalf("list: %d", code)
	}

	// 删除：已交付会话不可删除
	code, out = do("DELETE", "/api/sessions/"+itoa(sid), "")
	if code != 409 {
		t.Fatalf("已交付删除应 409: %d %v", code, out)
	}

	// 第二会话：created 直接删除
	code, out = do("POST", "/api/sessions", `{"project_id":`+itoa(pid)+`,"agent_id":`+itoa(aid)+`,"title":"会话2"}`)
	if code != 201 {
		t.Fatalf("create2: %d %v", code, out)
	}
	sid2 := int64(out["id"].(float64))
	code, out = do("DELETE", "/api/sessions/"+itoa(sid2), "")
	if code != 200 {
		t.Fatalf("delete: %d %v", code, out)
	}
	code, out = do("GET", "/api/sessions/"+itoa(sid2), "")
	if code != 200 || out["status"] != store.SessionStatusDeleted {
		t.Fatalf("删除后 status=%v", out["status"])
	}
	_ = tkID
}
