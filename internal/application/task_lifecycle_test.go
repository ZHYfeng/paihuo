package application

import (
	"testing"

	paiexec "paihuo/internal/exec"
	"paihuo/internal/store"
)

func TestTaskLifecycleCreatesTaskWithoutKnowingRuntimeFlags(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	projectID, _ := st.CreateProject(store.Project{Name: "app", ProjectDir: t.TempDir(), Status: "active"})
	fake := &paiexec.FakeRuntime{RuntimeDescriptor: paiexec.RuntimeDescriptor{ID: "fake", Capabilities: []paiexec.RuntimeCapability{paiexec.CapabilityBatch}}}
	runtimes := paiexec.NewRuntimeService(fake)
	roleID, _ := st.CreateRole(store.Role{Name: "builder", RuntimeID: "fake", Enabled: true})
	service := NewTaskLifecycle(st, runtimes, nil)
	task, err := service.Create(CreateTaskRequest{Title: "build", Body: "deliver", RoleID: &roleID, ProjectID: &projectID})
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != store.StatusQueued || task.DependencyMode != store.DependencyWeak || task.RoleID == nil || *task.RoleID != roleID {
		t.Fatalf("unexpected task: %#v", task)
	}
}
