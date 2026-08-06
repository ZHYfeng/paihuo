package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/store"
)

func TestAgentMaxConcurrencyDefaultsValidatesAndUpdates(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := exec.New(st, hub, t.TempDir(), "server-agent-concurrency-test.db")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", t.TempDir())

	create := func(body string) (*httptest.ResponseRecorder, store.Agent) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/agents", strings.NewReader(body))
		resp := httptest.NewRecorder()
		s.createAgent(resp, req)
		var a store.Agent
		if resp.Code == http.StatusCreated {
			if err := json.Unmarshal(resp.Body.Bytes(), &a); err != nil {
				t.Fatal(err)
			}
		}
		return resp, a
	}

	resp, defaultAgent := create(`{"name":"default-pool","cli":"pi"}`)
	if resp.Code != http.StatusCreated || defaultAgent.MaxConcurrency != 1 {
		t.Fatalf("新角色应默认单并发: code=%d agent=%+v body=%s", resp.Code, defaultAgent, resp.Body.String())
	}
	resp, pool := create(`{"name":"parallel-pool","cli":"pi","max_concurrency":3}`)
	if resp.Code != http.StatusCreated || pool.MaxConcurrency != 3 {
		t.Fatalf("创建并发池失败: code=%d agent=%+v body=%s", resp.Code, pool, resp.Body.String())
	}

	for _, body := range []string{`{"max_concurrency":0}`, `{"max_concurrency":1.5}`, `{"max_concurrency":null}`} {
		req := httptest.NewRequest(http.MethodPatch, "/api/agents/"+itoa(pool.ID), strings.NewReader(body))
		req.SetPathValue("id", itoa(pool.ID))
		resp := httptest.NewRecorder()
		s.patchAgent(resp, req)
		if resp.Code != http.StatusBadRequest {
			t.Fatalf("非法并发值应被拒绝: body=%s code=%d response=%s", body, resp.Code, resp.Body.String())
		}
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/agents/"+itoa(pool.ID), strings.NewReader(`{"max_concurrency":4}`))
	req.SetPathValue("id", itoa(pool.ID))
	resp = httptest.NewRecorder()
	s.patchAgent(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("更新最大并发失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	var updated store.Agent
	if err := json.Unmarshal(resp.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.MaxConcurrency != 4 {
		t.Fatalf("更新响应应返回新并发数，得到 %+v", updated)
	}
}
