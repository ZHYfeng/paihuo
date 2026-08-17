package application

import (
	"database/sql"
	"errors"
	"testing"

	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/workflow"
)

func TestWorkflowCreateAdoptsAndInstantiatesDependencyGraph(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	projectID, err := st.CreateProject(store.Project{Name: "workflow", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	runtime := &paiexec.FakeRuntime{RuntimeDescriptor: paiexec.RuntimeDescriptor{
		ID: "fake", Name: "Fake", Healthy: true, Capabilities: []paiexec.RuntimeCapability{paiexec.CapabilityBatch},
	}}
	runtimes := paiexec.NewRuntimeService(runtime)
	roleID, err := st.CreateRole(store.Role{Name: "builder", RuntimeID: "fake", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	stream := events.NewEventStream(st)
	service := NewWorkflowService(st, runtimes, nil, stream)
	wf, err := service.CreateWorkflow(workflow.Spec{
		Goal: "构建并验证", CreatedBy: "test",
		Limits: workflow.Limits{Budget: 100, MaxNodes: 4, MaxDepth: 3, MaxConcurrency: 2},
		Nodes: []workflow.Node{
			{ID: "build", Intent: "构建", Role: workflow.RoleSelector{RoleID: roleID}, Permission: store.PermFull, TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 40},
			{ID: "verify", Intent: "验证", Role: workflow.RoleSelector{RoleID: roleID}, DependsOn: []string{"build"}, Permission: store.PermReview, TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 20},
		},
	}, "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if wf.SpecHash == "" || wf.Status != workflow.WorkflowStatusAdopted {
		t.Fatalf("workflow not adopted on create: %+v", wf)
	}
	// spec 不绑定项目：工作流任务记录无项目。
	if wf.ProjectID != nil {
		t.Fatalf("workflow definition must not bind a project: %+v", wf.ProjectID)
	}
	run, err := service.StartPlan(wf.ID, wf.Revision, projectID)
	if err != nil {
		t.Fatal(err)
	}
	if run.WorkflowID != wf.ID {
		t.Fatalf("run.WorkflowID=%d, want workflow id %d", run.WorkflowID, wf.ID)
	}
	if run.ProjectID != projectID {
		t.Fatalf("run.ProjectID=%d, want %d", run.ProjectID, projectID)
	}
	// 定义创建后保持 adopted，run 不应改动其状态，可多次 run。
	if tk, err := st.GetWorkflowTask(wf.ID); err != nil || tk == nil || tk.Status != workflow.WorkflowStatusAdopted {
		t.Fatalf("工作流任务创建后应保持 adopted: %+v %v", tk, err)
	}
	build, _ := st.GetTask(run.TaskIDs["build"])
	verify, _ := st.GetTask(run.TaskIDs["verify"])
	if build.WorkflowRunID == nil || *build.WorkflowRunID != run.ID || verify.WorkflowRunID == nil || *verify.WorkflowRunID != run.ID {
		t.Fatalf("all Workflow tasks must retain run ownership: build=%+v verify=%+v", build.WorkflowRunID, verify.WorkflowRunID)
	}
	// 节点任务绑定 Run 指定的项目。
	if build.ProjectID == nil || *build.ProjectID != projectID {
		t.Fatalf("node task must bind run project: %+v", build.ProjectID)
	}
	if limit, err := st.WorkflowRunConcurrencyLimit(run.ID); err != nil || limit != 2 {
		t.Fatalf("run concurrency limit=(%d, %v), want (2, nil)", limit, err)
	}
	if check, err := st.CheckTaskDependency(*build); err != nil || !check.Ready {
		t.Fatalf("root should be ready: %+v %v", check, err)
	}
	if check, err := st.CheckTaskDependency(*verify); err != nil || check.Ready {
		t.Fatalf("dependent should wait: %+v %v", check, err)
	}
	if err := st.UpdateTask(build.ID, map[string]any{"status": store.StatusSucceeded, "finished_at": store.Now()}); err != nil {
		t.Fatal(err)
	}
	if check, err := st.CheckTaskDependency(*verify); err != nil || !check.Ready {
		t.Fatalf("dependent should be released: %+v %v", check, err)
	}
	history, err := stream.History(0, 20)
	if err != nil || len(history) < 2 {
		t.Fatalf("workflow events were not persisted: %d %v", len(history), err)
	}
}

func TestCreateWorkflowRejectsPolicyViolation(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	runtime := &paiexec.FakeRuntime{RuntimeDescriptor: paiexec.RuntimeDescriptor{
		ID: "fake", Name: "Fake", Healthy: true, Capabilities: []paiexec.RuntimeCapability{paiexec.CapabilityBatch},
	}}
	runtimes := paiexec.NewRuntimeService(runtime)
	roleID, err := st.CreateRole(store.Role{Name: "builder", RuntimeID: "fake", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	service := NewWorkflowService(st, runtimes, nil, events.NewEventStream(st))
	// 环 + 危险动作未声明审批：创建必须被策略拒绝且不落库。
	_, err = service.CreateWorkflow(workflow.Spec{
		Goal: "非法工作流", CreatedBy: "test",
		Limits: workflow.Limits{Budget: 100, MaxNodes: 4, MaxDepth: 3, MaxConcurrency: 2},
		Nodes: []workflow.Node{
			{ID: "a", Intent: "A", Role: workflow.RoleSelector{RoleID: roleID}, Permission: store.PermFull, TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 20, AllowedActions: []string{"delete_workspace"}},
			{ID: "b", Intent: "B", Role: workflow.RoleSelector{RoleID: roleID}, DependsOn: []string{"a"}, Permission: store.PermFull, TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 20},
		},
	}, "", false, nil)
	var validation *WorkflowValidationError
	if err == nil {
		t.Fatal("policy-violating workflow must not be created")
	} else if !errors.As(err, &validation) || len(validation.Violations) == 0 {
		t.Fatalf("want WorkflowValidationError with violations, got %v", err)
	}
	all, err := st.ListWorkflowTasks()
	if err != nil || len(all) != 0 {
		t.Fatalf("rejected workflow must not be persisted: %d %v", len(all), err)
	}
}

func TestCreateWorkflowRequiresProjectForScheduled(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	runtime := &paiexec.FakeRuntime{RuntimeDescriptor: paiexec.RuntimeDescriptor{
		ID: "fake", Name: "Fake", Healthy: true, Capabilities: []paiexec.RuntimeCapability{paiexec.CapabilityBatch},
	}}
	runtimes := paiexec.NewRuntimeService(runtime)
	roleID, err := st.CreateRole(store.Role{Name: "builder", RuntimeID: "fake", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	service := NewWorkflowService(st, runtimes, nil, events.NewEventStream(st))
	spec := workflow.Spec{
		Goal: "定时工作流", CreatedBy: "test",
		Limits: workflow.Limits{Budget: 100, MaxNodes: 4, MaxDepth: 3, MaxConcurrency: 2},
		Nodes: []workflow.Node{
			{ID: "build", Intent: "构建", Role: workflow.RoleSelector{RoleID: roleID}, Permission: store.PermFull, TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 20},
		},
	}
	if _, err := service.CreateWorkflow(spec, "0 0 * * * *", true, nil); err == nil {
		t.Fatal("scheduled workflow without project must be rejected")
	}
}

func singleNodeSpec(roleID int64, goal string) workflow.Spec {
	return workflow.Spec{
		Goal: goal, CreatedBy: "test",
		Limits: workflow.Limits{Budget: 100, MaxNodes: 4, MaxDepth: 3, MaxConcurrency: 2},
		Nodes: []workflow.Node{
			{ID: "build", Intent: "构建", Role: workflow.RoleSelector{RoleID: roleID}, Permission: store.PermFull, TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 20},
		},
	}
}

func newWorkflowTestService(t *testing.T) (*store.Store, *WorkflowService, int64, int64) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	projectID, err := st.CreateProject(store.Project{Name: "workflow", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	runtime := &paiexec.FakeRuntime{RuntimeDescriptor: paiexec.RuntimeDescriptor{
		ID: "fake", Name: "Fake", Healthy: true, Capabilities: []paiexec.RuntimeCapability{paiexec.CapabilityBatch},
	}}
	runtimes := paiexec.NewRuntimeService(runtime)
	roleID, err := st.CreateRole(store.Role{Name: "builder", RuntimeID: "fake", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	return st, NewWorkflowService(st, runtimes, nil, events.NewEventStream(st)), projectID, roleID
}

func TestUpdateWorkflowReplacesDefinitionAndGuardsRevision(t *testing.T) {
	st, service, projectID, roleID := newWorkflowTestService(t)
	wf, err := service.CreateWorkflow(singleNodeSpec(roleID, "构建并验证"), "", false, nil)
	if err != nil {
		t.Fatal(err)
	}

	// 1. 整体替换：goal/spec_hash 变化、revision+1、状态保持 adopted。
	updated, err := service.UpdateWorkflow(wf.ID, wf.Revision, singleNodeSpec(roleID, "构建并发布"), "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != wf.Revision+1 {
		t.Fatalf("revision=%d, want %d", updated.Revision, wf.Revision+1)
	}
	if updated.SpecHash == wf.SpecHash {
		t.Fatalf("spec_hash must change after edit: %s", updated.SpecHash)
	}
	if updated.Status != workflow.WorkflowStatusAdopted {
		t.Fatalf("status=%s, want adopted after edit", updated.Status)
	}
	spec, err := specOf(updated)
	if err != nil || spec.Goal != "构建并发布" {
		t.Fatalf("spec not replaced: %+v %v", spec, err)
	}

	// 2. 陈旧 revision → 冲突，不落库。
	if _, err := service.UpdateWorkflow(wf.ID, wf.Revision, singleNodeSpec(roleID, "不应生效"), "", false, nil); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("stale revision must conflict, got %v", err)
	}

	// 3. 策略违规 → 422 明细且定义不变。
	bad := workflow.Spec{
		Goal: "非法", CreatedBy: "test",
		Limits: workflow.Limits{Budget: 100, MaxNodes: 4, MaxDepth: 3, MaxConcurrency: 2},
		Nodes: []workflow.Node{
			{ID: "a", Intent: "A", Role: workflow.RoleSelector{RoleID: roleID}, Permission: store.PermFull, TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 20, AllowedActions: []string{"delete_workspace"}},
		},
	}
	_, err = service.UpdateWorkflow(wf.ID, updated.Revision, bad, "", false, nil)
	var validation *WorkflowValidationError
	if !errors.As(err, &validation) || len(validation.Violations) == 0 {
		t.Fatalf("policy-violating update must be rejected with violations, got %v", err)
	}
	unchanged, _ := st.GetWorkflowTask(wf.ID)
	if spec, err := specOf(unchanged); err != nil || spec.Goal != "构建并发布" {
		t.Fatalf("rejected update must not persist: %+v %v", spec, err)
	}

	// 4. 编辑为定时必须绑定目标项目；绑定后成功。
	if _, err := service.UpdateWorkflow(wf.ID, updated.Revision, singleNodeSpec(roleID, "构建并发布"), "0 0 * * * *", true, nil); err == nil {
		t.Fatal("scheduled update without project must be rejected")
	}
	scheduled, err := service.UpdateWorkflow(wf.ID, updated.Revision, singleNodeSpec(roleID, "构建并发布"), "0 0 * * * *", true, &projectID)
	if err != nil {
		t.Fatal(err)
	}
	if scheduled.Cron != "0 0 * * * *" || scheduled.ProjectID == nil || *scheduled.ProjectID != projectID {
		t.Fatalf("scheduled fields not updated: %+v", scheduled)
	}

	// 5. 不存在的定义 → sql.ErrNoRows。
	if _, err := service.UpdateWorkflow(9999, 1, singleNodeSpec(roleID, "x"), "", false, nil); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing workflow must be sql.ErrNoRows, got %v", err)
	}
}

func TestDeleteWorkflowBlocksActiveRunsAndKeepsNodeTasks(t *testing.T) {
	st, service, projectID, roleID := newWorkflowTestService(t)
	wf, err := service.CreateWorkflow(singleNodeSpec(roleID, "构建并验证"), "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	run, err := service.StartPlan(wf.ID, wf.Revision, projectID)
	if err != nil {
		t.Fatal(err)
	}

	// 1. 进行中的 Run → 拒绝删除。
	if err := service.DeleteWorkflow(wf.ID, wf.Revision); !errors.Is(err, store.ErrWorkflowRunsActive) {
		t.Fatalf("delete with active run must be rejected, got %v", err)
	}
	// 陈旧 revision → 冲突。
	if err := service.DeleteWorkflow(wf.ID, wf.Revision-1); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("stale revision must conflict, got %v", err)
	}

	// 2. Run 结束后删除成功：定义消失、Run 书签删除、节点任务保留且解除关联。
	if err := st.FinishWorkflowRun(run.ID, run.Revision, workflow.RunStatusSucceeded); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteWorkflow(wf.ID, wf.Revision); err != nil {
		t.Fatal(err)
	}
	if tk, err := st.GetWorkflowTask(wf.ID); err != nil || tk != nil {
		t.Fatalf("workflow definition must be gone: %+v %v", tk, err)
	}
	runs, err := st.ListWorkflowRunsByWorkflow(wf.ID)
	if err != nil || len(runs) != 0 {
		t.Fatalf("run bookmarks must be deleted: %d %v", len(runs), err)
	}
	build, err := st.GetTask(run.TaskIDs["build"])
	if err != nil {
		t.Fatalf("node task must survive deletion: %v", err)
	}
	if build.WorkflowRunID != nil {
		t.Fatalf("node task must be unlinked from deleted run: %+v", build.WorkflowRunID)
	}

	// 3. 重复删除 → sql.ErrNoRows。
	if err := service.DeleteWorkflow(wf.ID, wf.Revision); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("second delete must be sql.ErrNoRows, got %v", err)
	}
}
