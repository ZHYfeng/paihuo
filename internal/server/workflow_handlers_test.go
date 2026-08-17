package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"paihuo/internal/application"
	"paihuo/internal/events"
	execpkg "paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/session"
	"paihuo/internal/store"
	"paihuo/internal/workflow"
)

// 创建工作流即 adopted；启动 Run 绑定具体项目并原子实例化节点任务。
func TestWorkflowCreateAdoptsAndStartBindsProject(t *testing.T) {
	root := t.TempDir()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	executor := execpkg.NewForTest(st, hub, filepath.Join(root, "sessions"), filepath.Join(root, "db"), "workflow-handler")
	sess := session.New(st, hub, executor, filepath.Join(root, "sessions"), t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	sc := sched.New(st, hub, executor, sess, wf)
	s := New(st, hub, executor, sc, sess, wf, "", filepath.Join(root, "skills"))
	mux := s.Handler()

	roleID, err := st.CreateRole(store.Role{Name: "builder", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: filepath.Join(root, "proj"), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}

	do := func(method, path, body string) (int, map[string]any) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}

	// 1. 创建：201 + adopted + spec_hash，且定义本身不绑定项目。
	spec := `{"version":1,"goal":"构建并验证","created_by":"test",
		"limits":{"budget":100,"max_nodes":4,"max_depth":3,"max_concurrency":2},
		"nodes":[
			{"id":"build","intent":"构建","role":{"role_id":` + itoa(roleID) + `},"permission":"full","timeout_seconds":60,"failure_policy":"stop","budget":40},
			{"id":"verify","intent":"验证","role":{"role_id":` + itoa(roleID) + `},"depends_on":["build"],"permission":"review","timeout_seconds":60,"failure_policy":"stop","budget":20}]}`
	code, out := do("POST", "/api/v1/workflows", `{"spec":`+spec+`}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v", code, out)
	}
	if out["status"] != workflow.WorkflowStatusAdopted {
		t.Fatalf("status=%v, want adopted", out["status"])
	}
	if out["spec_hash"] == "" {
		t.Fatalf("spec_hash must be set: %v", out)
	}
	wfID := int64(out["id"].(float64))
	revision := int64(out["revision"].(float64))
	if out["project_id"] != nil {
		t.Fatalf("workflow definition must not bind a project: %v", out["project_id"])
	}

	// 2. 策略违规（环 + 危险动作未声明审批）→ 422 且带 violations 明细。
	badSpec := `{"version":1,"goal":"非法","created_by":"test",
		"limits":{"budget":100,"max_nodes":4,"max_depth":3,"max_concurrency":2},
		"nodes":[
			{"id":"a","intent":"A","role":{"role_id":` + itoa(roleID) + `},"permission":"full","timeout_seconds":60,"failure_policy":"stop","budget":20,"allowed_actions":["delete_workspace"]},
			{"id":"b","intent":"B","role":{"role_id":` + itoa(roleID) + `},"depends_on":["a"],"permission":"full","timeout_seconds":60,"failure_policy":"stop","budget":20}]}`
	code, out = do("POST", "/api/v1/workflows", `{"spec":`+badSpec+`}`)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("bad spec must be 422, got %d %v", code, out)
	}
	errObj, ok := out["error"].(map[string]any)
	if !ok || errObj["code"] != "policy_rejected" {
		t.Fatalf("error envelope missing policy_rejected: %v", out)
	}
	violations, ok := errObj["violations"].([]any)
	if !ok || len(violations) == 0 {
		t.Fatalf("policy violation details missing: %v", out)
	}

	// 3. 启动 Run 绑定项目：201 + run.project_id + 节点任务落在该项目下。
	startBody := `{"project_id":` + itoa(projectID) + `}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/"+itoa(wfID)+"/runs", strings.NewReader(startBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", `"`+itoa(revision)+`"`)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("start: %d %s", w.Code, w.Body.String())
	}
	var run workflow.Run
	if err := json.Unmarshal(w.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	if run.ProjectID != projectID {
		t.Fatalf("run.ProjectID=%d, want %d", run.ProjectID, projectID)
	}
	build, err := st.GetTask(run.TaskIDs["build"])
	if err != nil {
		t.Fatal(err)
	}
	if build.ProjectID == nil || *build.ProjectID != projectID {
		t.Fatalf("node task must bind run project: %+v", build.ProjectID)
	}

	// 3.5 带自定义任务启动：task 记录在 Run 上，{{.task}} 占位符渲染进节点任务。
	req = httptest.NewRequest(http.MethodPost, "/api/v1/workflows/"+itoa(wfID)+"/runs", strings.NewReader(`{"project_id":`+itoa(projectID)+`,"task":"修复登录页 XSS"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", `"`+itoa(revision)+`"`)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("start with custom task: %d %s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	if run.Task != "修复登录页 XSS" {
		t.Fatalf("run.Task=%q, want custom task", run.Task)
	}
	build, err = st.GetTask(run.TaskIDs["build"])
	if err != nil {
		t.Fatal(err)
	}
	if build.Title != "构建\n\n自定义任务：修复登录页 XSS" {
		t.Fatalf("纯文本意图必须附加自定义任务: %q", build.Title)
	}

	// 4. 启动不带项目 → 422。
	req = httptest.NewRequest(http.MethodPost, "/api/v1/workflows/"+itoa(wfID)+"/runs", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", `"`+itoa(revision)+`"`)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("start without project must be 422, got %d %s", w.Code, w.Body.String())
	}

	// 5. 定时工作流创建时必须绑定目标项目。
	code, out = do("POST", "/api/v1/workflows", `{"spec":`+spec+`,"cron":"0 0 * * * *","enabled":true}`)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("scheduled workflow without project must be 422, got %d %v", code, out)
	}
	code, out = do("POST", "/api/v1/workflows", `{"spec":`+spec+`,"cron":"0 0 * * * *","enabled":true,"project_id":`+itoa(projectID)+`}`)
	if code != http.StatusCreated {
		t.Fatalf("scheduled workflow with project must be created, got %d %v", code, out)
	}
	if int64(out["project_id"].(float64)) != projectID {
		t.Fatalf("scheduled workflow must bind project: %v", out["project_id"])
	}
}

// 定义管理 = 增删查改：PUT 整体替换（revision 保护、策略拒绝 422），
// DELETE 删除定义；有进行中的 Run 时删除返回 409。
func TestWorkflowUpdateDeleteHandlers(t *testing.T) {
	root := t.TempDir()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	executor := execpkg.NewForTest(st, hub, filepath.Join(root, "sessions"), filepath.Join(root, "db"), "workflow-handler")
	sess := session.New(st, hub, executor, filepath.Join(root, "sessions"), t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	sc := sched.New(st, hub, executor, sess, wf)
	s := New(st, hub, executor, sc, sess, wf, "", filepath.Join(root, "skills"))
	mux := s.Handler()

	roleID, err := st.CreateRole(store.Role{Name: "builder", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: filepath.Join(root, "proj"), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}

	do := func(method, path, body string, revision int64) (int, map[string]any) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if revision > 0 {
			req.Header.Set("If-Match", `"`+itoa(revision)+`"`)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}

	spec := `{"version":1,"goal":"构建并验证","created_by":"test",
		"limits":{"budget":100,"max_nodes":4,"max_depth":3,"max_concurrency":2},
		"nodes":[
			{"id":"build","intent":"构建","role":{"role_id":` + itoa(roleID) + `},"permission":"full","timeout_seconds":60,"failure_policy":"stop","budget":40}]}`
	newSpec := `{"version":1,"goal":"构建并发布","created_by":"test",
		"limits":{"budget":100,"max_nodes":4,"max_depth":3,"max_concurrency":2},
		"nodes":[
			{"id":"build","intent":"构建并发布","role":{"role_id":` + itoa(roleID) + `},"permission":"full","timeout_seconds":60,"failure_policy":"stop","budget":40},
			{"id":"verify","intent":"验证","role":{"role_id":` + itoa(roleID) + `},"depends_on":["build"],"permission":"review","timeout_seconds":60,"failure_policy":"stop","budget":20}]}`

	// 1. 创建（增）。
	code, out := do("POST", "/api/v1/workflows", `{"spec":`+spec+`}`, 0)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v", code, out)
	}
	wfID := int64(out["id"].(float64))
	revision := int64(out["revision"].(float64))
	oldHash, _ := out["spec_hash"].(string)

	// 2. 编辑（改）：PUT 整体替换 → 200、revision+1、spec_hash 重算。
	code, out = do("PUT", "/api/v1/workflows/"+itoa(wfID), `{"spec":`+newSpec+`}`, revision)
	if code != http.StatusOK {
		t.Fatalf("update: %d %v", code, out)
	}
	newRevision := int64(out["revision"].(float64))
	if newRevision != revision+1 {
		t.Fatalf("revision=%d, want %d", newRevision, revision+1)
	}
	if hash, _ := out["spec_hash"].(string); hash == "" || hash == oldHash {
		t.Fatalf("spec_hash must be recomputed: %s", hash)
	}
	if goal, _ := out["title"].(string); goal != "构建并发布" {
		t.Fatalf("title must follow new spec goal: %v", goal)
	}

	// 3. 陈旧 revision → 409，定义不变。
	code, _ = do("PUT", "/api/v1/workflows/"+itoa(wfID), `{"spec":`+newSpec+`}`, revision)
	if code != http.StatusConflict {
		t.Fatalf("stale revision must be 409, got %d", code)
	}

	// 4. 策略违规（环）→ 422 + violations，定义不变。
	cycleSpec := `{"version":1,"goal":"环","created_by":"test",
		"limits":{"budget":100,"max_nodes":4,"max_depth":3,"max_concurrency":2},
		"nodes":[
			{"id":"a","intent":"A","role":{"role_id":` + itoa(roleID) + `},"depends_on":["b"],"permission":"full","timeout_seconds":60,"failure_policy":"stop","budget":20},
			{"id":"b","intent":"B","role":{"role_id":` + itoa(roleID) + `},"depends_on":["a"],"permission":"full","timeout_seconds":60,"failure_policy":"stop","budget":20}]}`
	code, out = do("PUT", "/api/v1/workflows/"+itoa(wfID), `{"spec":`+cycleSpec+`}`, newRevision)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("policy-violating update must be 422, got %d %v", code, out)
	}
	errObj, ok := out["error"].(map[string]any)
	if !ok || errObj["code"] != "policy_rejected" {
		t.Fatalf("error envelope missing policy_rejected: %v", out)
	}

	// 5. 删除（删）：无 Run → 204，之后 GET 404；陈旧 revision → 409。
	code, _ = do("DELETE", "/api/v1/workflows/"+itoa(wfID), "", revision)
	if code != http.StatusConflict {
		t.Fatalf("stale revision delete must be 409, got %d", code)
	}
	code, _ = do("DELETE", "/api/v1/workflows/"+itoa(wfID), "", newRevision)
	if code != http.StatusNoContent {
		t.Fatalf("delete: %d", code)
	}
	code, _ = do("GET", "/api/v1/workflows/"+itoa(wfID), "", 0)
	if code != http.StatusNotFound {
		t.Fatalf("deleted workflow must 404, got %d", code)
	}

	// 6. 进行中的 Run → 删除 409；Run 结束后可删。
	code, out = do("POST", "/api/v1/workflows", `{"spec":`+spec+`}`, 0)
	if code != http.StatusCreated {
		t.Fatalf("create second: %d %v", code, out)
	}
	wfID2 := int64(out["id"].(float64))
	revision2 := int64(out["revision"].(float64))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/"+itoa(wfID2)+"/runs", strings.NewReader(`{"project_id":`+itoa(projectID)+`}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", `"`+itoa(revision2)+`"`)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("start: %d %s", w.Code, w.Body.String())
	}
	var run workflow.Run
	if err := json.Unmarshal(w.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	code, out = do("DELETE", "/api/v1/workflows/"+itoa(wfID2), "", revision2)
	if code != http.StatusConflict {
		t.Fatalf("delete with active run must be 409, got %d %v", code, out)
	}
	if err := st.FinishWorkflowRun(run.ID, run.Revision, workflow.RunStatusSucceeded); err != nil {
		t.Fatal(err)
	}
	code, _ = do("DELETE", "/api/v1/workflows/"+itoa(wfID2), "", revision2)
	if code != http.StatusNoContent {
		t.Fatalf("delete after run finished: %d", code)
	}
	// 节点任务保留为普通任务历史（解除 run 关联）。
	build, err := st.GetTask(run.TaskIDs["build"])
	if err != nil {
		t.Fatalf("node task must survive: %v", err)
	}
	if build.WorkflowRunID != nil {
		t.Fatalf("node task must be unlinked: %+v", build.WorkflowRunID)
	}
}
