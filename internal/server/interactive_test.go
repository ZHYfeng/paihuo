package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/store"
)

func TestCreateInteractiveTaskRequiresPiAndDefaultsRemainBatch(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := exec.New(st, hub, t.TempDir(), "server-input-test.db")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", t.TempDir())

	codexID, err := st.CreateAgent(store.Agent{Name: "codex", CLI: "codex", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(`{"title":"bad","agent_id":`+itoa(codexID)+`,"run_mode":"interactive"}`))
	resp := httptest.NewRecorder()
	s.createTask(resp, req)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "Pi") {
		t.Fatalf("非 Pi 交互任务应被拒绝: code=%d body=%s", resp.Code, resp.Body.String())
	}

	piID, err := st.CreateAgent(store.Agent{Name: "pi", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(`{"title":"interactive","agent_id":`+itoa(piID)+`,"run_mode":"interactive"}`))
	resp = httptest.NewRecorder()
	s.createTask(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("Pi 交互任务创建失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	var tk store.Task
	if err := json.Unmarshal(resp.Body.Bytes(), &tk); err != nil {
		t.Fatal(err)
	}
	if tk.RunMode != store.RunModeInteractive {
		t.Fatalf("创建响应应保留 interactive，得到 %q", tk.RunMode)
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/tasks/"+itoa(tk.ID), strings.NewReader(`{"agent_id":`+itoa(codexID)+`}`))
	req.SetPathValue("id", itoa(tk.ID))
	resp = httptest.NewRecorder()
	s.patchTask(resp, req)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "Pi") {
		t.Fatalf("交互式任务不应允许改派非 Pi: code=%d body=%s", resp.Code, resp.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(`{"title":"batch","agent_id":`+itoa(piID)+`}`))
	resp = httptest.NewRecorder()
	s.createTask(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("默认批处理任务创建失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &tk); err != nil {
		t.Fatal(err)
	}
	if tk.RunMode != store.RunModeBatch {
		t.Fatalf("未指定 run_mode 应保持 batch，得到 %q", tk.RunMode)
	}
}

func itoa(id int64) string {
	return strconv.FormatInt(id, 10)
}
