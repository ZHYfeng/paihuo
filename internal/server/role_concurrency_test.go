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

func TestRoleMaxConcurrencyDefaultsValidatesAndUpdates(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	executor := exec.NewForTest(st, hub, t.TempDir(), "server-agent-concurrency-test.db", "server-agent-concurrency-test")
	sess := session.New(st, hub, executor, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	sc := sched.New(st, hub, executor, sess, wf)
	s := New(st, hub, executor, sc, sess, wf, "", t.TempDir())

	create := func(body string) (*httptest.ResponseRecorder, store.Role) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/roles", strings.NewReader(body))
		resp := httptest.NewRecorder()
		s.createRole(resp, req)
		var a store.Role
		if resp.Code == http.StatusCreated {
			if err := json.Unmarshal(resp.Body.Bytes(), &a); err != nil {
				t.Fatal(err)
			}
		}
		return resp, a
	}

	resp, defaultAgent := create(`{"name":"default-pool","runtime_id":"pi"}`)
	if resp.Code != http.StatusCreated || defaultAgent.MaxConcurrency != 1 {
		t.Fatalf("新角色应默认单并发: code=%d agent=%+v body=%s", resp.Code, defaultAgent, resp.Body.String())
	}
	resp, pool := create(`{"name":"parallel-pool","runtime_id":"pi","max_concurrency":3}`)
	if resp.Code != http.StatusCreated || pool.MaxConcurrency != 3 {
		t.Fatalf("创建并发池失败: code=%d agent=%+v body=%s", resp.Code, pool, resp.Body.String())
	}

	for _, body := range []string{`{"max_concurrency":0}`, `{"max_concurrency":1.5}`, `{"max_concurrency":null}`} {
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/roles/"+itoa(pool.ID), strings.NewReader(body))
		req.SetPathValue("id", itoa(pool.ID))
		setRoleRevision(t, st, pool.ID, req)
		resp := httptest.NewRecorder()
		s.patchRole(resp, req)
		if resp.Code != http.StatusBadRequest {
			t.Fatalf("非法并发值应被拒绝: body=%s code=%d response=%s", body, resp.Code, resp.Body.String())
		}
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/roles/"+itoa(pool.ID), strings.NewReader(`{"max_concurrency":4}`))
	req.SetPathValue("id", itoa(pool.ID))
	setRoleRevision(t, st, pool.ID, req)
	resp = httptest.NewRecorder()
	s.patchRole(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("更新最大并发失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	var updated store.Role
	if err := json.Unmarshal(resp.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.MaxConcurrency != 4 {
		t.Fatalf("更新响应应返回新并发数，得到 %+v", updated)
	}
}
