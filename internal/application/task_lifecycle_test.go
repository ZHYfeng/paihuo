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
	service := NewTaskLifecycle(TaskLifecycleDeps{Store: st, Runtimes: runtimes})
	task, err := service.Create(CreateTaskRequest{Title: "build", Body: "deliver", RoleID: &roleID, ProjectID: &projectID})
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != store.StatusQueued || task.DependencyMode != store.DependencyWeak || task.RoleID == nil || *task.RoleID != roleID {
		t.Fatalf("unexpected task: %#v", task)
	}
}

func TestTaskLifecycleReloadsScheduleOnScheduledCreate(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	reloader := &recordingScheduleReloader{}
	service := NewTaskLifecycle(TaskLifecycleDeps{Store: st, Runtimes: paiexec.NewDefaultRuntimeService(), Schedules: reloader})
	if _, err := service.Create(CreateTaskRequest{Title: "scheduled", Cron: "0 0 * * * *", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if reloader.reloads != 1 {
		t.Fatalf("scheduled create reloads = %d, want 1", reloader.reloads)
	}
}
