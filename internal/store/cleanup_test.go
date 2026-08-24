package store

import "testing"

// CleanupTasks 只删终态任务。
func TestCleanupTasksOnlyTerminal(t *testing.T) {
	s := openTest(t)
	a := mustRole(t, s, "a", true)
	mustTask(t, s, "done", &a, StatusSucceeded, "")
	mustTask(t, s, "run", &a, StatusRunning, "")
	mustTask(t, s, "queued", &a, StatusQueued, "")

	result, err := s.CleanupTasks(nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Deleted != 1 {
		t.Fatalf("应只删除 1 条终态任务，得到 %d", result.Deleted)
	}
	if len(result.Locators) != 0 || len(result.Tasks) != 1 {
		t.Fatalf("CleanupTasks 返回结果异常: %+v", result)
	}
}
