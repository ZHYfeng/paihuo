package application

import (
	"testing"

	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/workflow"
)

func TestWorkflowProposalFreezesAndInstantiatesDependencyGraph(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	projectID, err := st.CreateProject(store.Project{Name: "workflow", ProjectDir: t.TempDir()})
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
	proposal, err := service.CreateProposal(workflow.Spec{
		Goal: "构建并验证", ProjectID: projectID, CreatedBy: "test",
		Limits: workflow.Limits{Budget: 100, MaxNodes: 4, MaxDepth: 3, MaxConcurrency: 2},
		Nodes: []workflow.Node{
			{ID: "build", Intent: "构建", Role: workflow.RoleSelector{RoleID: roleID}, Permission: store.PermFull, TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 40},
			{ID: "verify", Intent: "验证", Role: workflow.RoleSelector{RoleID: roleID}, DependsOn: []string{"build"}, Permission: store.PermReview, TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 20},
		},
	}, "", true)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := service.AdoptProposal(proposal.ID, proposal.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if plan.SpecHash == "" || plan.Status != workflow.ProposalStatusAdopted {
		t.Fatalf("plan not frozen: %+v", plan)
	}
	run, err := service.StartPlan(plan.ID, plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if run.WorkflowID != plan.ID {
		t.Fatalf("run.WorkflowID=%d, want plan id %d", run.WorkflowID, plan.ID)
	}
	// 采纳后工作流任务保持 adopted（冻结态），run 不应再改动其状态，可多次 run。
	if tk, err := st.GetWorkflowTask(plan.ID); err != nil || tk == nil || tk.Status != workflow.ProposalStatusAdopted {
		t.Fatalf("工作流任务采纳后应保持 adopted: %+v %v", tk, err)
	}
	build, _ := st.GetTask(run.TaskIDs["build"])
	verify, _ := st.GetTask(run.TaskIDs["verify"])
	if build.WorkflowRunID == nil || *build.WorkflowRunID != run.ID || verify.WorkflowRunID == nil || *verify.WorkflowRunID != run.ID {
		t.Fatalf("all Workflow tasks must retain run ownership: build=%+v verify=%+v", build.WorkflowRunID, verify.WorkflowRunID)
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
	if err != nil || len(history) < 3 {
		t.Fatalf("workflow events were not persisted: %d %v", len(history), err)
	}
}
