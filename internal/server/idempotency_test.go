package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"paihuo/internal/application"
	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/session"
	"paihuo/internal/store"
)

// 204 无响应体的 mutation（DELETE）也必须完成幂等记录，否则记录停留在
// status 0（语义为“执行中”），同键重放永远得到 409 而非原响应。回归：
// 空响应体不得因 []byte 绑定成 NULL 而违反 body NOT NULL 约束。
func TestIdempotencyCompletesForNoContentDelete(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	executor := exec.NewForTest(st, hub, t.TempDir(), "server-idem-test.db", "server-idem-test")
	sess := session.New(st, hub, executor, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	sc := sched.New(st, hub, executor, sess, wf)
	s := New(st, hub, executor, sc, sess, wf, "", t.TempDir())
	agentID, err := st.CreateRole(store.Role{Name: "agent", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}

	create := httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(`{"title":"t","role_id":`+itoa(agentID)+`}`))
	create.Header.Set("Idempotency-Key", "idem-reg-create-01")
	createResp := httptest.NewRecorder()
	s.Handler().ServeHTTP(createResp, create)
	if createResp.Code != http.StatusCreated {
		t.Fatalf("创建任务失败: code=%d body=%s", createResp.Code, createResp.Body.String())
	}
	var task store.Task
	if err := json.Unmarshal(createResp.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}

	const key = "idem-reg-delete-01"
	del := httptest.NewRequest(http.MethodDelete, "/api/v1/tasks/"+itoa(task.ID), nil)
	del.SetPathValue("id", itoa(task.ID))
	del.Header.Set("Idempotency-Key", key)
	del.Header.Set("If-Match", `"1"`)
	delResp := httptest.NewRecorder()
	s.Handler().ServeHTTP(delResp, del)
	if delResp.Code != http.StatusNoContent {
		t.Fatalf("删除任务失败: code=%d body=%s", delResp.Code, delResp.Body.String())
	}

	record, _, err := st.ReserveIdempotency(key, http.MethodDelete, "/api/v1/tasks/"+itoa(task.ID))
	if err != nil {
		t.Fatal(err)
	}
	if record.StatusCode != http.StatusNoContent {
		t.Fatalf("204 删除后幂等记录未完成: status=%d（应为 204），body 空切片被绑定成 NULL 导致完成写入失败", record.StatusCode)
	}

	// 同键重放应返回记录中的 204 而不是“仍在执行”的 409。
	replay := httptest.NewRequest(http.MethodDelete, "/api/v1/tasks/"+itoa(task.ID), nil)
	replay.Header.Set("Idempotency-Key", key)
	replayResp := httptest.NewRecorder()
	s.Handler().ServeHTTP(replayResp, replay)
	if replayResp.Code != http.StatusNoContent {
		t.Fatalf("同键重放应得到记录的 204，得到 %d body=%s", replayResp.Code, replayResp.Body.String())
	}
	if replayResp.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatalf("重放响应缺少 Idempotency-Replayed 头")
	}
}
