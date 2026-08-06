package sched

import (
	"testing"

	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/store"
)

// 定时任务只负责按时创建普通任务；绑定项目后，新任务必须和手工创建的
// 任务一样进入创建时间弱依赖链，而不是绕过项目代码基线。
func TestProjectScheduleCreatesWeakDependentTask(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := paiexec.New(st, hub, t.TempDir(), "schedule-dependency-test.db")
	s := New(st, hub, executor)
	agentID, err := st.CreateAgent(store.Agent{Name: "scheduled-agent", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "scheduled-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	firstID, err := st.CreateTaskWithProjectDependency(store.Task{
		Title: "existing", Status: store.StatusQueued, AgentID: &agentID, ProjectID: &projectID,
		DependencyMode: store.DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	scheduleID, err := st.CreateSchedule(store.Schedule{
		Name: "project cron", Cron: "0 * * * *", TitleTemplate: "generated", BodyTemplate: "body",
		AgentID: agentID, ProjectID: &projectID, BlockOnFailure: true, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	sc, err := st.GetSchedule(scheduleID)
	if err != nil {
		t.Fatal(err)
	}
	(&scheduleJob{s: s, sc: sc}).Run()

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

func TestReloadAcceptsPickerAndLegacyCronRules(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := paiexec.New(st, hub, t.TempDir(), "schedule-parser-test.db")
	s := New(st, hub, executor)
	agentID, err := st.CreateAgent(store.Agent{Name: "parser-agent", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ name, expression string }{
		{name: "legacy", expression: "0 9 * * *"},
		{name: "picker", expression: "0 30 14 * * 3"},
	} {
		if _, err := st.CreateSchedule(store.Schedule{
			Name: item.name, Cron: item.expression, TitleTemplate: "title", AgentID: agentID, Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	s.Reload()
	if got := len(s.cron.Entries()); got != 2 {
		t.Fatalf("定时任务规则未全部加载：got %d, want 2", got)
	}
}
