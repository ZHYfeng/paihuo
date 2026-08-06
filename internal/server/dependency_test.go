package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/store"
)

func TestCreateTaskDefaultsToWeakProjectDependencyAndProtectsReferencedDelete(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := exec.New(st, hub, t.TempDir(), "server-dependency-test.db")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", t.TempDir())
	agentID, err := st.CreateAgent(store.Agent{Name: "agent", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}

	create := func(body string) (int, store.Task, string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(body))
		resp := httptest.NewRecorder()
		s.createTask(resp, req)
		var task store.Task
		if resp.Code == http.StatusCreated {
			if err := json.Unmarshal(resp.Body.Bytes(), &task); err != nil {
				t.Fatal(err)
			}
		}
		return resp.Code, task, resp.Body.String()
	}
	base := fmt.Sprintf(`{"agent_id":%d,"project_id":%d}`, agentID, projectID)
	code, first, body := create(`{"title":"first",` + base[1:])
	if code != http.StatusCreated {
		t.Fatalf("创建第一项失败: code=%d body=%s", code, body)
	}
	if first.DependencyMode != store.DependencyWeak || first.DependsOn != nil {
		t.Fatalf("项目首项应默认弱依赖，得到 %+v", first)
	}
	code, second, body := create(`{"title":"second",` + base[1:])
	if code != http.StatusCreated {
		t.Fatalf("创建第二项失败: code=%d body=%s", code, body)
	}
	if second.DependencyMode != store.DependencyWeak || second.DependsOn == nil || *second.DependsOn != first.ID {
		t.Fatalf("第二项应默认依赖第一项，得到 %+v", second)
	}

	strongBody := fmt.Sprintf(`{"title":"strong","agent_id":%d,"project_id":%d,"dependency_mode":"strong","depends_on":%d,"block_on_failure":true}`, agentID, projectID, first.ID)
	code, strong, body := create(strongBody)
	if code != http.StatusCreated {
		t.Fatalf("创建强依赖失败: code=%d body=%s", code, body)
	}
	if strong.DependencyMode != store.DependencyStrong || strong.DependsOn == nil || *strong.DependsOn != first.ID || !strong.BlockOnFailure {
		t.Fatalf("明确前置/失败阻塞字段未保存: %+v", strong)
	}

	moveReq := httptest.NewRequest(http.MethodPatch, "/api/tasks/"+itoa(first.ID), strings.NewReader(`{"project_id":null}`))
	moveReq.SetPathValue("id", itoa(first.ID))
	moveResp := httptest.NewRecorder()
	s.patchTask(moveResp, moveReq)
	if moveResp.Code != http.StatusConflict || !strings.Contains(moveResp.Body.String(), "前置") {
		t.Fatalf("被后项依赖的任务不应修改项目: code=%d body=%s", moveResp.Code, moveResp.Body.String())
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/tasks/"+itoa(first.ID), nil)
	deleteReq.SetPathValue("id", itoa(first.ID))
	deleteResp := httptest.NewRecorder()
	s.deleteTask(deleteResp, deleteReq)
	if deleteResp.Code != http.StatusConflict || !strings.Contains(deleteResp.Body.String(), "依赖") {
		t.Fatalf("仍被后项依赖的任务不应删除: code=%d body=%s", deleteResp.Code, deleteResp.Body.String())
	}
	unchanged, err := st.GetTask(first.ID)
	if err != nil || unchanged.Status != store.StatusQueued {
		t.Fatalf("删除被拒绝后源任务不应被取消: task=%+v err=%v", unchanged, err)
	}
}
