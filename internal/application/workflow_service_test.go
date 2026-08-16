package application

import (
	"errors"
	"testing"

	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/workflow"
)

func TestWorkflowFreezesOnCreateAndInstantiatesDependencyGraph(t *testing.T) {
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
	if wf.SpecHash == "" || wf.Status != workflow.WorkflowStatusFrozen {
		t.Fatalf("workflow not frozen on create: %+v", wf)
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
	// 创建后工作流任务保持冻结态，run 不应再改动其状态，可多次 run。
	if tk, err := st.GetWorkflowTask(wf.ID); err != nil || tk == nil || tk.Status != workflow.WorkflowStatusFrozen {
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
