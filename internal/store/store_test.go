package store

import (
	"fmt"
	"strings"
	"testing"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func mustAgent(t *testing.T, s *Store, name string, enabled bool) int64 {
	t.Helper()
	id, err := s.CreateAgent(Agent{Name: name, CLI: "pi", Enabled: enabled})
	if err != nil {
		t.Fatalf("CreateAgent(%s): %v", name, err)
	}
	return id
}

func mustTask(t *testing.T, s *Store, title string, agentID *int64, status string, body string) int64 {
	t.Helper()
	id, err := s.CreateTask(Task{Title: title, Body: body, Status: status, AgentID: agentID})
	if err != nil {
		t.Fatalf("CreateTask(%s): %v", title, err)
	}
	return id
}

// 停用的角色不应出现在可派发队列里。
func TestListQueuedTasksSkipsDisabledAgents(t *testing.T) {
	s := openTest(t)
	on := mustAgent(t, s, "on", true)
	off := mustAgent(t, s, "off", false)
	mustTask(t, s, "t1", &on, StatusQueued, "")
	mustTask(t, s, "t2", &off, StatusQueued, "")

	tasks, err := s.ListQueuedTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Title != "t1" {
		t.Fatalf("期望只有启用角色的排队任务，得到 %+v", tasks)
	}
}

// 角色是执行池而非单一会话：未配置时维持兼容的单并发，显式配置则完整保存。
func TestAgentMaxConcurrencyDefaultsAndRoundTrips(t *testing.T) {
	s := openTest(t)
	defaultID := mustAgent(t, s, "default-pool", true)
	defaultAgent, err := s.GetAgent(defaultID)
	if err != nil {
		t.Fatal(err)
	}
	if defaultAgent.MaxConcurrency != 1 || defaultAgent.ConcurrencyLimit() != 1 {
		t.Fatalf("未配置角色应默认单并发，得到 %+v", defaultAgent)
	}

	id, err := s.CreateAgent(Agent{Name: "parallel-pool", CLI: "pi", Enabled: true, MaxConcurrency: 3})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateAgent(id, map[string]any{"max_concurrency": 5}); err != nil {
		t.Fatal(err)
	}
	a, err := s.GetAgent(id)
	if err != nil {
		t.Fatal(err)
	}
	if a.MaxConcurrency != 5 || a.ConcurrencyLimit() != 5 {
		t.Fatalf("角色并发数未正确往返保存，得到 %+v", a)
	}
}

// 重启重置只应命中 running/claimed，awaiting_review（执行已完成、等审批）要保留。
func TestListRunningTasksExcludesAwaitingReview(t *testing.T) {
	s := openTest(t)
	a := mustAgent(t, s, "a", true)
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
	a := mustAgent(t, s, "a", true)
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

// 列表接口 body 截断到 400 字符，详情接口保持完整。
func TestListBodyTruncatedDetailFull(t *testing.T) {
	s := openTest(t)
	a := mustAgent(t, s, "a", true)
	body := strings.Repeat("长提示词", 200) // 800 个字符
	id := mustTask(t, s, "t", &a, StatusQueued, body)

	tasks, err := s.ListTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || len([]rune(tasks[0].Body)) != 400 {
		t.Fatalf("列表 body 应截断为 400 字符，得到 %d", len([]rune(tasks[0].Body)))
	}
	tk, err := s.GetTask(id)
	if err != nil || len([]rune(tk.Body)) != len([]rune(body)) {
		t.Fatalf("详情 body 应保持完整: %d err=%v", len([]rune(tk.Body)), err)
	}
}

func TestListLogsPageLoadsNewestWindowAndOlderWindows(t *testing.T) {
	s := openTest(t)
	id := mustTask(t, s, "logs", nil, StatusSucceeded, "")
	for i := 1; i <= 5; i++ {
		if _, err := s.AppendLog(TaskLog{TaskID: id, Stream: "out", Content: fmt.Sprintf("line-%d", i)}); err != nil {
			t.Fatal(err)
		}
	}

	page, more, total, err := s.ListLogsPage(id, 0, 2)
	if err != nil || total != 5 || !more || len(page) != 2 || page[0].Seq != 4 || page[1].Seq != 5 {
		t.Fatalf("最新日志窗口异常: page=%+v more=%v total=%d err=%v", page, more, total, err)
	}
	page, more, _, err = s.ListLogsPage(id, page[0].Seq, 2)
	if err != nil || !more || len(page) != 2 || page[0].Seq != 2 || page[1].Seq != 3 {
		t.Fatalf("向前翻页异常: page=%+v more=%v err=%v", page, more, err)
	}
	page, more, _, err = s.ListLogsPage(id, page[0].Seq, 2)
	if err != nil || more || len(page) != 1 || page[0].Seq != 1 {
		t.Fatalf("最后一页异常: page=%+v more=%v err=%v", page, more, err)
	}
}

// 旧任务和未显式选择执行方式的新任务都必须保持批处理，避免升级后意外进入
// 永不自动退出的交互会话；手工选择的交互式方式则需完整往返保存。
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

func TestApproveReviewTaskCreatesOneMergeTaskAtomically(t *testing.T) {
	s := openTest(t)
	a := mustAgent(t, s, "reviewer", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "review me", Status: StatusAwaitingReview, Perm: PermReview,
		AgentID: &a, ProjectID: &projectID, ProjectDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	merge := Task{
		Title: "merge reviewed task", Body: "integrate", Status: StatusQueued,
		Perm: PermFull, RunMode: RunModeBatch, AgentID: &a, ProjectID: &projectID,
		ProjectDir: t.TempDir(), ParentID: &sourceID, MergeOf: &sourceID,
	}
	mergeID, err := s.ApproveTaskAndCreateMerge(sourceID, merge)
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil || source.Status != StatusSucceeded {
		t.Fatalf("审批后原任务状态异常: %+v err=%v", source, err)
	}
	created, err := s.GetTask(mergeID)
	if err != nil {
		t.Fatal(err)
	}
	if created.MergeOf == nil || *created.MergeOf != sourceID || created.ParentID == nil || *created.ParentID != sourceID {
		t.Fatalf("合并任务来源关系未保存: %+v", created)
	}
	if created.Perm != PermFull || created.Status != StatusQueued || created.AgentID == nil || *created.AgentID != a {
		t.Fatalf("合并任务执行配置异常: %+v", created)
	}
	if _, err := s.ApproveTaskAndCreateMerge(sourceID, merge); err == nil {
		t.Fatal("重复审批不应再创建合并任务")
	}
	children, err := s.ListChildren(sourceID)
	if err != nil || len(children) != 1 {
		t.Fatalf("重复审批后应仍只有一个合并任务: %+v err=%v", children, err)
	}
}

func TestCompleteTaskCreatesOneMergeTaskAtomically(t *testing.T) {
	s := openTest(t)
	agentID := mustAgent(t, s, "merger", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "finish me", Status: StatusRunning, Perm: PermFull,
		AgentID: &agentID, ProjectID: &projectID, ProjectDir: t.TempDir(), BlockOnFailure: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeInput := NewMergeTask(*source)
	mergeInput.BlockOnFailure = false // 模拟调用方持有了过期快照
	mergeID, err := s.CompleteTaskAndCreateMerge(sourceID, mergeInput)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := s.GetTask(sourceID)
	if err != nil || completed.Status != StatusSucceeded {
		t.Fatalf("完成后源任务状态异常: %+v err=%v", completed, err)
	}
	merge, err := s.GetTask(mergeID)
	if err != nil {
		t.Fatal(err)
	}
	if merge.MergeOf == nil || *merge.MergeOf != sourceID || merge.ParentID == nil || *merge.ParentID != sourceID {
		t.Fatalf("合并任务来源关系未保存: %+v", merge)
	}
	if merge.Status != StatusQueued || merge.Perm != PermFull || merge.Concurrent || !merge.BlockOnFailure {
		t.Fatalf("自动合并任务执行配置异常: %+v", merge)
	}
	if _, err := s.CompleteTaskAndCreateMerge(sourceID, NewMergeTask(*source)); err == nil {
		t.Fatal("重复完成不应创建第二个合并任务")
	}
	if _, err := s.CreateTask(NewMergeTask(*source)); err == nil {
		t.Fatal("数据库约束不应允许同一源任务创建第二个合并任务")
	}
	children, err := s.ListChildren(sourceID)
	if err != nil || len(children) != 1 {
		t.Fatalf("应只创建一个合并任务: %+v err=%v", children, err)
	}
}

func TestMergeReconciliationCreatesExactlyOneChildForCompletedGitTask(t *testing.T) {
	s := openTest(t)
	agentID := mustAgent(t, s, "reconciler", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "finish despite handoff failure", Status: StatusRunning, Perm: PermFull,
		AgentID: &agentID, ProjectID: &projectID, ProjectDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateTask(sourceID, map[string]any{"worktree_branch": "paihuo/task-reconcile"}); err != nil {
		t.Fatal(err)
	}

	changed, err := s.MarkTaskSucceededAwaitingMerge(sourceID)
	if err != nil || !changed {
		t.Fatalf("应把已完成源任务留给合并对账: changed=%v err=%v", changed, err)
	}
	pending, err := s.ListCompletedGitTasksWithoutMerge()
	if err != nil || len(pending) != 1 || pending[0].ID != sourceID {
		t.Fatalf("应找到唯一待补建合并任务的源任务: %+v err=%v", pending, err)
	}

	mergeID, created, err := s.EnsureMergeTask(pending[0])
	if err != nil || !created {
		t.Fatalf("首次对账应创建合并任务: id=%d created=%v err=%v", mergeID, created, err)
	}
	merge, err := s.GetTask(mergeID)
	if err != nil || merge.MergeOf == nil || *merge.MergeOf != sourceID || merge.Status != StatusQueued {
		t.Fatalf("补建的合并任务不正确: %+v err=%v", merge, err)
	}

	// 对账可重复执行，不会创建第二个合并任务。
	mergeID2, created, err := s.EnsureMergeTask(pending[0])
	if err != nil || created || mergeID2 != mergeID {
		t.Fatalf("重复对账应返回已有合并任务: id=%d created=%v err=%v", mergeID2, created, err)
	}
	pending, err = s.ListCompletedGitTasksWithoutMerge()
	if err != nil || len(pending) != 0 {
		t.Fatalf("已有合并任务后不应再出现在对账队列: %+v err=%v", pending, err)
	}
}

func TestRecoverLostTaskCreatesOneMergeTaskAtomically(t *testing.T) {
	s := openTest(t)
	agentID := mustAgent(t, s, "recovery", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "lost pane", Status: StatusFailed, Perm: PermFull,
		AgentID: &agentID, ProjectID: &projectID, ProjectDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateTask(sourceID, map[string]any{"exit_code": -1, "error": "专用 tmux window task-1 已消失，且未留下退出码"}); err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := s.RecoverLostTaskAndCreateMerge(sourceID, NewMergeTask(*source))
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := s.GetTask(sourceID)
	if err != nil || recovered.Status != StatusSucceeded || recovered.ExitCode == nil || *recovered.ExitCode != 0 || recovered.Error != "" {
		t.Fatalf("恢复后源任务状态异常: %+v err=%v", recovered, err)
	}
	merge, err := s.GetTask(mergeID)
	if err != nil || merge.MergeOf == nil || *merge.MergeOf != sourceID {
		t.Fatalf("恢复创建的合并任务异常: %+v err=%v", merge, err)
	}
	if _, err := s.RecoverLostTaskAndCreateMerge(sourceID, NewMergeTask(*source)); err == nil {
		t.Fatal("重复恢复不应创建第二个合并任务")
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

// 项目任务默认采用按创建时间连接的弱依赖；用户选择前置任务时则保存为强
// 依赖。后续自动任务仍以前一条“实现任务”为前序，而不是以合并子任务为前序。
func TestCreateProjectTaskDependencies(t *testing.T) {
	s := openTest(t)
	p1, err := s.CreateProject(Project{Name: "p1", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	p2, err := s.CreateProject(Project{Name: "p2", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	firstID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "first", Status: StatusQueued, ProjectID: &p1,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.GetTask(firstID)
	if err != nil {
		t.Fatal(err)
	}
	if first.DependencyMode != DependencyWeak || first.DependsOn != nil {
		t.Fatalf("项目首项应为无前置的弱依赖，得到 %+v", first)
	}
	secondID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "second", Status: StatusQueued, ProjectID: &p1, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.GetTask(secondID)
	if err != nil {
		t.Fatal(err)
	}
	if second.DependencyMode != DependencyWeak || second.DependsOn == nil || *second.DependsOn != firstID {
		t.Fatalf("第二项应弱依赖第一项，得到 %+v", second)
	}
	strongID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "strong", Status: StatusQueued, ProjectID: &p1, DependencyMode: DependencyStrong, DependsOn: &firstID,
	})
	if err != nil {
		t.Fatal(err)
	}
	strong, err := s.GetTask(strongID)
	if err != nil {
		t.Fatal(err)
	}
	if strong.DependencyMode != DependencyStrong || strong.DependsOn == nil || *strong.DependsOn != firstID {
		t.Fatalf("明确前置应保存为强依赖，得到 %+v", strong)
	}
	fourthID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "after strong", Status: StatusQueued, ProjectID: &p1, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	fourth, err := s.GetTask(fourthID)
	if err != nil {
		t.Fatal(err)
	}
	if fourth.DependsOn == nil || *fourth.DependsOn != strongID {
		t.Fatalf("后续自动任务应依赖最近创建的实现任务 #%d，得到 %+v", strongID, fourth)
	}
	if _, err := s.CreateTaskWithProjectDependency(Task{
		Title: "cross project", Status: StatusQueued, ProjectID: &p2, DependencyMode: DependencyStrong, DependsOn: &firstID,
	}); err == nil {
		t.Fatal("跨项目的强依赖应被拒绝")
	}
	if _, err := s.CreateTaskWithProjectDependency(Task{
		Title: "no project", Status: StatusQueued, DependencyMode: DependencyWeak,
	}); err == nil {
		t.Fatal("无项目任务不应允许弱依赖")
	}
}

// 弱依赖在非阻塞失败时放行，强依赖始终等待成功交付；Git 任务的交付还包括
// 它专属的代码合并任务。该测试同时覆盖“合并任务优先于后续实现任务”的队列顺序。
func TestTaskDependencyFailureAndMergeDelivery(t *testing.T) {
	s := openTest(t)
	agentID := mustAgent(t, s, "dependency-agent", true)
	projectID, err := s.CreateProject(Project{Name: "dependency-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "source", Status: StatusFailed, AgentID: &agentID, ProjectID: &projectID, BlockOnFailure: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	weakID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "weak", Status: StatusQueued, AgentID: &agentID, ProjectID: &projectID, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	strongID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "strong", Status: StatusQueued, AgentID: &agentID, ProjectID: &projectID, DependencyMode: DependencyStrong, DependsOn: &sourceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	weak, err := s.GetTask(weakID)
	if err != nil {
		t.Fatal(err)
	}
	check, err := s.CheckTaskDependency(*weak)
	if err != nil || !check.Ready || !check.Skipped {
		t.Fatalf("非阻塞失败应放行弱依赖: check=%+v err=%v", check, err)
	}
	strong, err := s.GetTask(strongID)
	if err != nil {
		t.Fatal(err)
	}
	check, err = s.CheckTaskDependency(*strong)
	if err != nil || check.Ready {
		t.Fatalf("失败的强依赖必须阻塞: check=%+v err=%v", check, err)
	}
	if err := s.UpdateTask(sourceID, map[string]any{"block_on_failure": true}); err != nil {
		t.Fatal(err)
	}
	check, err = s.CheckTaskDependency(*weak)
	if err != nil || check.Ready {
		t.Fatalf("阻塞失败应阻塞弱依赖: check=%+v err=%v", check, err)
	}

	if err := s.UpdateTask(sourceID, map[string]any{
		"status": StatusSucceeded, "block_on_failure": false, "worktree_branch": "paihuo/task-source",
	}); err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := s.CreateTask(NewMergeTask(*source))
	if err != nil {
		t.Fatal(err)
	}
	merge, err := s.GetTask(mergeID)
	if err != nil {
		t.Fatal(err)
	}
	if merge.BlockOnFailure {
		t.Fatal("合并任务应继承源任务当前的非阻塞策略")
	}
	check, err = s.CheckTaskDependency(*weak)
	if err != nil || check.Ready {
		t.Fatalf("源任务成功但合并尚未成功时不应放行: check=%+v err=%v", check, err)
	}
	queued, err := s.ListQueuedTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) == 0 || queued[0].ID != mergeID {
		t.Fatalf("合并任务必须排在后续实现任务之前，得到 %+v", queued)
	}
	if err := s.UpdateTask(mergeID, map[string]any{"status": StatusSucceeded}); err != nil {
		t.Fatal(err)
	}
	check, err = s.CheckTaskDependency(*weak)
	if err != nil || !check.Ready {
		t.Fatalf("合并成功后应放行弱依赖: check=%+v err=%v", check, err)
	}
	check, err = s.CheckTaskDependency(*strong)
	if err != nil || !check.Ready {
		t.Fatalf("合并成功后应放行强依赖: check=%+v err=%v", check, err)
	}
}

func TestScheduleProjectAndFailurePolicyRoundTrip(t *testing.T) {
	s := openTest(t)
	agentID := mustAgent(t, s, "schedule-agent", true)
	projectID, err := s.CreateProject(Project{Name: "schedule-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	id, err := s.CreateSchedule(Schedule{
		Name: "project schedule", Cron: "0 * * * *", TitleTemplate: "tick", AgentID: agentID,
		ProjectID: &projectID, BlockOnFailure: true, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	sc, err := s.GetSchedule(id)
	if err != nil {
		t.Fatal(err)
	}
	if sc.ProjectID == nil || *sc.ProjectID != projectID || !sc.BlockOnFailure || sc.ProjectName != "schedule-project" {
		t.Fatalf("项目定时任务字段未完整往返: %+v", sc)
	}
}

// CleanupTasks 只删终态任务。
func TestCleanupTasksOnlyTerminal(t *testing.T) {
	s := openTest(t)
	a := mustAgent(t, s, "a", true)
	mustTask(t, s, "done", &a, StatusSucceeded, "")
	mustTask(t, s, "run", &a, StatusRunning, "")
	mustTask(t, s, "queued", &a, StatusQueued, "")

	n, err := s.CleanupTasks(nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("应只删除 1 条终态任务，得到 %d", n)
	}
}

func TestSkillTagsRoundTripAndNormalize(t *testing.T) {
	s := openTest(t)
	id, err := s.CreateSkill(Skill{
		Name: "tagged", Dir: t.TempDir(), Tags: []string{" 编程 ", "文档", "编程", "DOCS"},
	})
	if err != nil {
		t.Fatal(err)
	}
	sk, err := s.GetSkill(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(sk.Tags) != 3 || sk.Tags[0] != "编程" || sk.Tags[1] != "文档" || sk.Tags[2] != "DOCS" {
		t.Fatalf("技能标签未按预期规范化: %+v", sk.Tags)
	}
	if err := s.UpdateSkillTags(id, []string{"审查", "审查", " 文档 "}); err != nil {
		t.Fatal(err)
	}
	sk, err = s.GetSkill(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(sk.Tags) != 2 || sk.Tags[0] != "审查" || sk.Tags[1] != "文档" {
		t.Fatalf("技能标签更新未持久化: %+v", sk.Tags)
	}
}

// 迁移完整性：模拟老库（缺新列）→ 重新 Open 后 migrate 应补齐所有新列。
func TestMigrateAddsNewColumns(t *testing.T) {
	path := t.TempDir() + "/mig.db"
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// 模拟老库：删掉新列后再打开，migrate 应补齐
	if _, err := s.db.Exec("DROP INDEX IF EXISTS idx_tasks_merge_of_unique"); err != nil {
		s.Close()
		t.Fatalf("drop merge index: %v", err)
	}
	for _, index := range []string{"idx_tasks_depends_on", "idx_schedules_project"} {
		if _, err := s.db.Exec("DROP INDEX IF EXISTS " + index); err != nil {
			s.Close()
			t.Fatalf("drop %s: %v", index, err)
		}
	}
	for _, col := range []string{"resume_of", "merge_of", "worktree_branch", "base_commit", "tmux_log_offset", "run_mode", "concurrent", "depends_on", "dependency_mode", "block_on_failure"} {
		if _, err := s.db.Exec("ALTER TABLE tasks DROP COLUMN " + col); err != nil {
			s.Close()
			t.Fatalf("drop %s: %v", col, err)
		}
	}
	for _, col := range []string{"project_id", "block_on_failure"} {
		if _, err := s.db.Exec("ALTER TABLE schedules DROP COLUMN " + col); err != nil {
			s.Close()
			t.Fatalf("drop schedules.%s: %v", col, err)
		}
	}
	if _, err := s.db.Exec("ALTER TABLE skills DROP COLUMN tags"); err != nil {
		s.Close()
		t.Fatalf("drop skills.tags: %v", err)
	}
	if _, err := s.db.Exec("ALTER TABLE agents DROP COLUMN max_concurrency"); err != nil {
		s.Close()
		t.Fatalf("drop agents.max_concurrency: %v", err)
	}
	s.Close()

	s2, err := Open(path) // 触发 migrate
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	cols := map[string]bool{}
	for _, r := range mustRows(t, s2, "PRAGMA table_info(tasks)") {
		cols[r[1]] = true
	}
	for _, want := range []string{"resume_of", "merge_of", "worktree_branch", "base_commit", "project_dir", "tmux_log_offset", "run_mode", "concurrent", "depends_on", "dependency_mode", "block_on_failure"} {
		if !cols[want] {
			t.Fatalf("迁移后缺少列 %s（现有列: %v）", want, cols)
		}
	}
	agentCols := map[string]bool{}
	for _, r := range mustRows(t, s2, "PRAGMA table_info(agents)") {
		agentCols[r[1]] = true
	}
	if !agentCols["max_concurrency"] {
		t.Fatalf("迁移后 agents 缺少 max_concurrency（现有列: %v）", agentCols)
	}
	scheduleCols := map[string]bool{}
	for _, r := range mustRows(t, s2, "PRAGMA table_info(schedules)") {
		scheduleCols[r[1]] = true
	}
	for _, want := range []string{"project_id", "block_on_failure"} {
		if !scheduleCols[want] {
			t.Fatalf("迁移后 schedules 缺少列 %s（现有列: %v）", want, scheduleCols)
		}
	}
	skillCols := map[string]bool{}
	for _, r := range mustRows(t, s2, "PRAGMA table_info(skills)") {
		skillCols[r[1]] = true
	}
	if !skillCols["tags"] {
		t.Fatalf("迁移后 skills 缺少 tags 列（现有列: %v）", skillCols)
	}
	// 迁移后应能正常读写
	id, err := s2.CreateTask(Task{Title: "t", Status: StatusQueued})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if _, err := s2.GetTask(id); err != nil {
		t.Fatalf("GetTask: %v", err)
	}
}

// 旧版把默认权限挂在角色上；迁移后应固化到定时任务模板，角色表不再保留该字段。
func TestMigrateMovesRoleDefaultPermToSchedule(t *testing.T) {
	path := t.TempDir() + "/perm-mig.db"
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	aid := mustAgent(t, s, "a", true)
	sid, err := s.CreateSchedule(Schedule{
		Name: "daily", Cron: "0 9 * * *", TitleTemplate: "daily", AgentID: aid, Enabled: true,
	})
	if err != nil {
		s.Close()
		t.Fatalf("CreateSchedule: %v", err)
	}
	// 模拟旧版数据库：权限列仍在 agents，schedules 尚未拥有自己的权限列。
	if _, err := s.db.Exec("ALTER TABLE agents ADD COLUMN default_perm TEXT NOT NULL DEFAULT 'full'"); err != nil {
		s.Close()
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE agents SET default_perm='review' WHERE id=?", aid); err != nil {
		s.Close()
		t.Fatal(err)
	}
	if _, err := s.db.Exec("ALTER TABLE schedules DROP COLUMN perm"); err != nil {
		s.Close()
		t.Fatal(err)
	}
	s.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	sc, err := s2.GetSchedule(sid)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Perm != PermReview {
		t.Fatalf("迁移后定时任务权限应为 review，得到 %q", sc.Perm)
	}
	for _, r := range mustRows(t, s2, "PRAGMA table_info(agents)") {
		if r[1] == "default_perm" {
			t.Fatal("迁移后 agents 不应保留 default_perm")
		}
	}
}

func mustRows(t *testing.T, s *Store, q string) [][]string {
	t.Helper()
	rows, err := s.db.Query(q)
	if err != nil {
		t.Fatalf("query %s: %v", q, err)
	}
	defer rows.Close()
	var out [][]string
	cols, _ := rows.Columns()
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		row := make([]string, len(cols))
		for i, v := range vals {
			row[i] = fmt.Sprint(v)
		}
		out = append(out, row)
	}
	return out
}
