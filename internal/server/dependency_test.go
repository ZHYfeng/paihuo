package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"paihuo/internal/store"
)

func TestCreateTaskDefaultsToWeakProjectDependencyAndProtectsReferencedDelete(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t,
		withTestStore(st),
		withTestExecutor(t.TempDir(), "server-dependency-test.db", "server-dependency-test"),
		withTestSkillsDir(t.TempDir()),
	)
	s := env.server
	agentID, err := st.CreateRole(store.Role{Name: "agent", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}

	create := func(body string) (int, store.Task, string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(body))
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
	base := fmt.Sprintf(`{"role_id":%d,"project_id":%d}`, agentID, projectID)
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

	strongBody := fmt.Sprintf(`{"title":"strong","role_id":%d,"project_id":%d,"dependency_mode":"strong","depends_on":%d,"block_on_failure":true}`, agentID, projectID, first.ID)
	code, strong, body := create(strongBody)
	if code != http.StatusCreated {
		t.Fatalf("创建强依赖失败: code=%d body=%s", code, body)
	}
	if strong.DependencyMode != store.DependencyStrong || strong.DependsOn == nil || *strong.DependsOn != first.ID || !strong.BlockOnFailure {
		t.Fatalf("明确前置/失败阻塞字段未保存: %+v", strong)
	}

	moveReq := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(first.ID), strings.NewReader(`{"project_id":null}`))
	moveReq.SetPathValue("id", itoa(first.ID))
	setTaskRevision(t, st, first.ID, moveReq)
	moveResp := httptest.NewRecorder()
	s.patchTask(moveResp, moveReq)
	if moveResp.Code != http.StatusConflict || !strings.Contains(moveResp.Body.String(), "前置") {
		t.Fatalf("被后项依赖的任务不应修改项目: code=%d body=%s", moveResp.Code, moveResp.Body.String())
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/v1/tasks/"+itoa(first.ID), nil)
	deleteReq.SetPathValue("id", itoa(first.ID))
	setTaskRevision(t, st, first.ID, deleteReq)
	deleteResp := httptest.NewRecorder()
	s.deleteTask(deleteResp, deleteReq)
	if deleteResp.Code != http.StatusConflict || !strings.Contains(deleteResp.Body.String(), "依赖") {
		t.Fatalf("仍被后项依赖的任务不应删除: code=%d body=%s", deleteResp.Code, deleteResp.Body.String())
	}
	unchanged, err := st.GetTask(first.ID)
	if err != nil || unchanged.Status != store.StatusQueued {
		t.Fatalf("删除被拒绝后源任务不应被取消: task=%+v err=%v", unchanged, err)
	}

	// 删除明确依赖后，自动生成的弱依赖不应继续阻止源任务删除。
	deleteStrongReq := httptest.NewRequest(http.MethodDelete, "/api/v1/tasks/"+itoa(strong.ID), nil)
	deleteStrongReq.SetPathValue("id", itoa(strong.ID))
	setTaskRevision(t, st, strong.ID, deleteStrongReq)
	deleteStrongResp := httptest.NewRecorder()
	s.deleteTask(deleteStrongResp, deleteStrongReq)
	if deleteStrongResp.Code != http.StatusNoContent {
		t.Fatalf("删除强依赖后项失败: code=%d body=%s", deleteStrongResp.Code, deleteStrongResp.Body.String())
	}

	deleteFirstReq := httptest.NewRequest(http.MethodDelete, "/api/v1/tasks/"+itoa(first.ID), nil)
	deleteFirstReq.SetPathValue("id", itoa(first.ID))
	setTaskRevision(t, st, first.ID, deleteFirstReq)
	deleteFirstResp := httptest.NewRecorder()
	s.deleteTask(deleteFirstResp, deleteFirstReq)
	if deleteFirstResp.Code != http.StatusNoContent {
		t.Fatalf("删除被弱依赖的任务失败: code=%d body=%s", deleteFirstResp.Code, deleteFirstResp.Body.String())
	}
	remaining, err := st.GetTask(second.ID)
	if err != nil || remaining.DependsOn != nil || remaining.DependencyMode != store.DependencyWeak {
		t.Fatalf("删除前置后弱依赖应被解除且后项保留: task=%+v err=%v", remaining, err)
	}
}

func TestPatchTaskCanChangePermissionAndDeliveryDependency(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t,
		withTestStore(st),
		withTestExecutor(t.TempDir(), "server-patch-dependency-test.db", "server-patch-dependency-test"),
		withTestSkillsDir(t.TempDir()),
	)
	s := env.server
	roleID, err := st.CreateRole(store.Role{Name: "patch-agent", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "patch-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}

	create := func(title string) store.Task {
		t.Helper()
		body := fmt.Sprintf(`{"title":%q,"role_id":%d,"project_id":%d}`, title, roleID, projectID)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(body))
		resp := httptest.NewRecorder()
		s.createTask(resp, req)
		if resp.Code != http.StatusCreated {
			t.Fatalf("创建任务失败: code=%d body=%s", resp.Code, resp.Body.String())
		}
		var task store.Task
		if err := json.Unmarshal(resp.Body.Bytes(), &task); err != nil {
			t.Fatal(err)
		}
		return task
	}
	first := create("first")
	second := create("second")

	patch := func(taskID int64, body string) store.Task {
		t.Helper()
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(taskID), strings.NewReader(body))
		req.SetPathValue("id", itoa(taskID))
		setTaskRevision(t, st, taskID, req)
		resp := httptest.NewRecorder()
		s.patchTask(resp, req)
		if resp.Code != http.StatusOK {
			t.Fatalf("PATCH 任务失败: code=%d body=%s", resp.Code, resp.Body.String())
		}
		var task store.Task
		if err := json.Unmarshal(resp.Body.Bytes(), &task); err != nil {
			t.Fatal(err)
		}
		return task
	}

	updated := patch(second.ID, fmt.Sprintf(`{"perm":"review","dependency_mode":"strong","depends_on":%d}`, first.ID))
	if updated.Perm != store.PermReview || updated.DependencyMode != store.DependencyStrong || updated.DependsOn == nil || *updated.DependsOn != first.ID {
		t.Fatalf("权限和前置交付未更新: %+v", updated)
	}

	cycleReq := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(first.ID), strings.NewReader(fmt.Sprintf(`{"dependency_mode":"strong","depends_on":%d}`, second.ID)))
	cycleReq.SetPathValue("id", itoa(first.ID))
	setTaskRevision(t, st, first.ID, cycleReq)
	cycleResp := httptest.NewRecorder()
	s.patchTask(cycleResp, cycleReq)
	if cycleResp.Code != http.StatusBadRequest || !strings.Contains(cycleResp.Body.String(), "循环") {
		t.Fatalf("循环前置依赖应被拒绝: code=%d body=%s", cycleResp.Code, cycleResp.Body.String())
	}

	updated = patch(second.ID, `{"perm":"full","dependency_mode":"none","depends_on":null}`)
	if updated.Perm != store.PermFull || updated.DependencyMode != store.DependencyNone || updated.DependsOn != nil {
		t.Fatalf("清除前置交付或恢复权限失败: %+v", updated)
	}
}

func TestReorderProjectTasksEndpoint(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t,
		withTestStore(st),
		withTestExecutor(t.TempDir(), "server-reorder-test.db", "server-reorder-test"),
		withTestSkillsDir(t.TempDir()),
	)
	s := env.server
	agentID, err := st.CreateRole(store.Role{Name: "order-agent", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "order-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	create := func(title string) store.Task {
		t.Helper()
		body := fmt.Sprintf(`{"title":%q,"role_id":%d,"project_id":%d}`, title, agentID, projectID)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(body))
		resp := httptest.NewRecorder()
		s.createTask(resp, req)
		if resp.Code != http.StatusCreated {
			t.Fatalf("创建任务失败: code=%d body=%s", resp.Code, resp.Body.String())
		}
		var task store.Task
		if err := json.Unmarshal(resp.Body.Bytes(), &task); err != nil {
			t.Fatal(err)
		}
		return task
	}
	first, second, third := create("first"), create("second"), create("third")

	orderBody := fmt.Sprintf(`{"task_ids":[%d,%d,%d]}`, third.ID, first.ID, second.ID)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/"+itoa(projectID)+"/tasks/order", strings.NewReader(orderBody))
	req.SetPathValue("id", itoa(projectID))
	resp := httptest.NewRecorder()
	s.reorderProjectTasks(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("重排接口失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	var tasks []store.Task
	if err := json.Unmarshal(resp.Body.Bytes(), &tasks); err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 3 || tasks[0].ID != third.ID || tasks[1].ID != first.ID || tasks[2].ID != second.ID {
		t.Fatalf("接口返回顺序异常: %+v", tasks)
	}
}
