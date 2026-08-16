package sched

import (
	"testing"

	"paihuo/internal/application"
	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/session"
	"paihuo/internal/store"
)

// 定时任务只负责按时创建普通任务；绑定项目后，新任务必须和手工创建的
// 任务一样进入创建时间弱依赖链，而不是绕过项目代码基线。定时定义任务
// （cron 非空）本身不参与弱依赖链，触发产生的实例（schedule_id 指向定义、
// cron 为空）仍按项目执行顺序排队。
func TestProjectScheduleCreatesWeakDependentTask(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	executor := paiexec.New(st, hub, t.TempDir(), "schedule-dependency-test.db")
	sess := session.New(st, hub, executor, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	s := New(st, hub, executor, sess, wf)
	agentID, err := st.CreateRole(store.Role{Name: "scheduled-agent", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "scheduled-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	firstID, err := st.CreateTaskWithProjectDependency(store.Task{
		Title: "existing", Status: store.StatusQueued, RoleID: &agentID, ProjectID: &projectID,
		DependencyMode: store.DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 定时定义 = cron 非空的任务（永不直接执行，也不参与弱依赖链）。
	scheduleID, err := st.CreateTask(store.Task{
		Title: "project cron", Cron: "0 0 * * * *", Body: "body",
		RoleID: &agentID, ProjectID: &projectID, BlockOnFailure: true, Enabled: true,
		Perm: store.PermFull,
	})
	if err != nil {
		t.Fatal(err)
	}
	sc, err := st.GetTask(scheduleID)
	if err != nil {
		t.Fatal(err)
	}
	(&scheduleJob{s: s, tk: sc}).Run()

	tasks, err := st.ListTasks()
	if err != nil {
		t.Fatal(err)
	}
	var generated *store.Task
	for i := range tasks {
		if tasks[i].ScheduleID != nil && *tasks[i].ScheduleID == scheduleID {
			generated = &tasks[i]
			break
		}
	}
	if generated == nil {
		t.Fatal("项目定时任务未创建任务")
	}
	if generated.ProjectID == nil || *generated.ProjectID != projectID || generated.DependencyMode != store.DependencyWeak || generated.DependsOn == nil || *generated.DependsOn != firstID || !generated.BlockOnFailure {
		t.Fatalf("项目定时任务没有进入正确依赖链: %+v", generated)
	}
}

func TestReloadAcceptsOnlySixFieldCronRules(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	executor := paiexec.New(st, hub, t.TempDir(), "schedule-parser-test.db")
	sess := session.New(st, hub, executor, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	s := New(st, hub, executor, sess, wf)
	agentID, err := st.CreateRole(store.Role{Name: "parser-agent", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ name, expression string }{
		{name: "invalid-five-fields", expression: "0 9 * * *"},
		{name: "valid-six-fields", expression: "0 30 14 * * 3"},
	} {
		if _, err := st.CreateTask(store.Task{
			Title: item.name, Cron: item.expression, RoleID: &agentID, Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	s.Reload()
	if got := len(s.cron.Entries()); got != 1 {
		t.Fatalf("只应加载六段 cron：got %d, want 1", got)
	}
}
