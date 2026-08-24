package store

import "testing"

// 重启重置只应命中 running/claimed，awaiting_review（执行已完成、等审批）要保留。
func TestListRunningTasksExcludesAwaitingReview(t *testing.T) {
	s := openTest(t)
	a := mustRole(t, s, "a", true)
	mustTask(t, s, "run", &a, StatusRunning, "")
	mustTask(t, s, "claim", &a, StatusClaimed, "")
	mustTask(t, s, "review", &a, StatusAwaitingReview, "")
	mustTask(t, s, "done", &a, StatusSucceeded, "")

	tasks, err := s.ListRunningTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 2 {
		t.Fatalf("期望 2 个运行态任务，得到 %d", len(tasks))
	}
}

// ClaimTask/StartTask 是原子状态机：领取后取消的任务不能被 StartTask 覆盖回 running。
func TestStartTaskAtomic(t *testing.T) {
	s := openTest(t)
	a := mustRole(t, s, "a", true)
	id := mustTask(t, s, "t", &a, StatusQueued, "")

	ok, err := s.ClaimTask(id)
	if err != nil || !ok {
		t.Fatalf("ClaimTask: ok=%v err=%v", ok, err)
	}
	ok, err = s.StartTask(id)
	if err != nil || !ok {
		t.Fatalf("StartTask 应成功: ok=%v err=%v", ok, err)
	}
	ok, _ = s.StartTask(id)
	if ok {
		t.Fatal("第二次 StartTask 应失败（状态已非 claimed）")
	}

	// 取消竞态：claimed 状态下被取消，StartTask 不得覆盖终态
	id2 := mustTask(t, s, "t2", &a, StatusQueued, "")
	if ok, _ = s.ClaimTask(id2); !ok {
		t.Fatal("ClaimTask t2 失败")
	}
	if err := s.UpdateTask(id2, map[string]any{"status": StatusCancelled}); err != nil {
		t.Fatal(err)
	}
	if ok, _ = s.StartTask(id2); ok {
		t.Fatal("已取消的任务不应被 StartTask 置为 running")
	}
	tk, err := s.GetTask(id2)
	if err != nil || tk.Status != StatusCancelled {
		t.Fatalf("任务终态被覆盖: %+v err=%v", tk, err)
	}
}

func TestResumeTaskRequiresExpectedRevision(t *testing.T) {
	s := openTest(t)
	id := mustTask(t, s, "resume", nil, StatusFailed, "")
	if resumed, err := s.ResumeTask(id, 99); err != nil || resumed {
		t.Fatalf("stale ResumeTask = (%v, %v), want false, nil", resumed, err)
	}
	task, err := s.GetTask(id)
	if err != nil || task.Status != StatusFailed {
		t.Fatalf("stale ResumeTask changed task: %+v err=%v", task, err)
	}
	if resumed, err := s.ResumeTask(id, task.Revision); err != nil || !resumed {
		t.Fatalf("current ResumeTask = (%v, %v), want true, nil", resumed, err)
	}
}

// 未显式选择执行方式的任务使用批处理；手工选择的交互式方式完整往返保存。
func TestTaskRunModeDefaultsBatchAndRoundTripsInteractive(t *testing.T) {
	s := openTest(t)
	batchID, err := s.CreateTask(Task{Title: "batch", Status: StatusQueued})
	if err != nil {
		t.Fatal(err)
	}
	batch, err := s.GetTask(batchID)
	if err != nil {
		t.Fatal(err)
	}
	if batch.RunMode != RunModeBatch {
		t.Fatalf("未指定执行方式应为 batch，得到 %q", batch.RunMode)
	}

	interactiveID, err := s.CreateTask(Task{
		Title: "interactive", Status: StatusQueued, RunMode: RunModeInteractive,
	})
	if err != nil {
		t.Fatal(err)
	}
	interactive, err := s.GetTask(interactiveID)
	if err != nil {
		t.Fatal(err)
	}
	if interactive.RunMode != RunModeInteractive {
		t.Fatalf("交互式执行方式未保存，得到 %q", interactive.RunMode)
	}
}

func TestTaskDeliveryResultWaitsForMergeChild(t *testing.T) {
	s := openTest(t)
	sourceID, err := s.CreateTask(Task{Title: "source", Status: StatusSucceeded, Perm: PermFull, WorktreeBranch: "paihuo/task-source"})
	if err != nil {
		t.Fatal(err)
	}
	if terminal, succeeded, err := s.TaskDeliveryResult(sourceID); err != nil || terminal || succeeded {
		t.Fatalf("source without merge=(%v,%v,%v), want pending", terminal, succeeded, err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := s.CreateTask(NewMergeTask(*source))
	if err != nil {
		t.Fatal(err)
	}
	if terminal, succeeded, err := s.TaskDeliveryResult(sourceID); err != nil || terminal || succeeded {
		t.Fatalf("source with queued merge=(%v,%v,%v), want pending", terminal, succeeded, err)
	}
	if err := s.UpdateTask(mergeID, map[string]any{"status": StatusSucceeded, "finished_at": Now()}); err != nil {
		t.Fatal(err)
	}
	if terminal, succeeded, err := s.TaskDeliveryResult(sourceID); err != nil || !terminal || !succeeded {
		t.Fatalf("source with completed merge=(%v,%v,%v), want succeeded", terminal, succeeded, err)
	}
}

// 交互终端尺寸随 resize 同步持久化；任务结束后前端按此尺寸重放画面。
func TestTaskTerminalSizePersistsAndRoundTrips(t *testing.T) {
	s := openTest(t)
	id, err := s.CreateTask(Task{Title: "term", Status: StatusRunning, RunMode: RunModeInteractive})
	if err != nil {
		t.Fatal(err)
	}
	tk, err := s.GetTask(id)
	if err != nil {
		t.Fatal(err)
	}
	if tk.TerminalCols != 0 || tk.TerminalRows != 0 {
		t.Fatalf("新任务不应有终端尺寸，得到 %dx%d", tk.TerminalCols, tk.TerminalRows)
	}
	if err := s.UpdateTerminalSize(id, 132, 42); err != nil {
		t.Fatal(err)
	}
	tk, err = s.GetTask(id)
	if err != nil {
		t.Fatal(err)
	}
	if tk.TerminalCols != 132 || tk.TerminalRows != 42 {
		t.Fatalf("终端尺寸未持久化，得到 %dx%d", tk.TerminalCols, tk.TerminalRows)
	}
	// 批处理任务也可安全调用（前端只对交互任务上报，防御性清零）。
	if err := s.UpdateTerminalSize(id, 0, 0); err != nil {
		t.Fatal(err)
	}
}

// 并发开关：默认不并发（串行），显式勾选则完整往返保存。
func TestTaskConcurrentDefaultsFalseAndRoundTrips(t *testing.T) {
	s := openTest(t)
	defaultID, err := s.CreateTask(Task{Title: "serial", Status: StatusQueued})
	if err != nil {
		t.Fatal(err)
	}
	def, err := s.GetTask(defaultID)
	if err != nil {
		t.Fatal(err)
	}
	if def.Concurrent {
		t.Fatal("新任务默认不应并发")
	}

	concurrentID, err := s.CreateTask(Task{Title: "parallel", Status: StatusQueued, Concurrent: true})
	if err != nil {
		t.Fatal(err)
	}
	conc, err := s.GetTask(concurrentID)
	if err != nil {
		t.Fatal(err)
	}
	if !conc.Concurrent {
		t.Fatal("显式勾选并发的任务应保存为并发")
	}
	// 列表接口同样返回并发标记（最新在前，按标题定位）
	tasks, err := s.ListTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 2 {
		t.Fatalf("应有 2 个任务，得到 %d", len(tasks))
	}
	marks := map[string]bool{}
	for _, tk := range tasks {
		marks[tk.Title] = tk.Concurrent
	}
	if marks["serial"] || !marks["parallel"] {
		t.Fatalf("列表并发标记异常: %+v", tasks)
	}
}
func TestScheduleProjectAndFailurePolicyRoundTrip(t *testing.T) {
	s := openTest(t)
	roleID := mustRole(t, s, "schedule-role", true)
	projectID, err := s.CreateProject(Project{Name: "schedule-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	id, err := s.CreateTask(Task{
		Title: "project schedule", Cron: "0 0 * * * *", Body: "tick", RoleID: &roleID,
		ProjectID: &projectID, BlockOnFailure: true, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	sc, err := s.GetTask(id)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Cron != "0 0 * * * *" || !sc.Enabled || sc.ProjectID == nil || *sc.ProjectID != projectID || !sc.BlockOnFailure || sc.ProjectName != "schedule-project" {
		t.Fatalf("项目定时定义任务字段未完整往返: %+v", sc)
	}
}
func TestTaskExternalKeyDedupe(t *testing.T) {
	s := openTest(t)
	key := "github:issue:owner/repo:42"
	id, err := s.CreateTask(Task{Title: "issue", ExternalKey: key})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	exists, err := s.TaskExistsByExternalKey(key)
	if err != nil {
		t.Fatalf("TaskExistsByExternalKey: %v", err)
	}
	if !exists {
		t.Fatalf("expected external key task to exist")
	}
	if _, err := s.CreateTask(Task{Title: "duplicate", ExternalKey: key}); err == nil {
		t.Fatalf("expected unique external_key to reject duplicate")
	}
	_ = id
}
