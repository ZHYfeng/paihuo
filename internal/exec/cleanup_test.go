package exec

import (
	"os"
	"testing"

	"paihuo/internal/events"
	"paihuo/internal/store"
)

func TestCleanupCompletedTaskRuntimeSessions(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	sourceID, err := st.CreateTask(store.Task{
		Title: "source", Status: store.StatusSucceeded, WorktreeBranch: "paihuo/task-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := st.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := st.CreateTask(store.NewMergeTask(*source))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTask(mergeID, map[string]any{
		"status": store.StatusSucceeded, "finished_at": store.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	e := New(st, events.NewEventStream(), t.TempDir(), "cleanup-test.db")
	sourceDir, err := e.taskSessions.Ensure(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeDir, err := e.taskSessions.Ensure(mergeID)
	if err != nil {
		t.Fatal(err)
	}

	tasks, err := st.ListTasksForCleanup()
	if err != nil {
		t.Fatal(err)
	}
	cleaned, err := e.CleanupCompletedTaskRuntimeSessions(tasks)
	if err != nil {
		t.Fatal(err)
	}
	if cleaned != 2 {
		t.Fatalf("应清理源任务和合并任务 Runtime 会话，得到 %d", cleaned)
	}
	for _, dir := range []string{sourceDir, mergeDir} {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("成功交付任务 Runtime 会话应被清理: %s err=%v", dir, err)
		}
	}
}
