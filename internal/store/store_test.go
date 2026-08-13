package store

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenRejectsUnsupportedSchemaWithoutMutatingIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unsupported.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE agents (id INTEGER PRIMARY KEY, cli TEXT); PRAGMA user_version=0;"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	if opened, err := Open(path); err == nil {
		_ = opened.Close()
		t.Fatal("unsupported schema must be rejected")
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='roles'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("schema rejection must not create current tables in an unsupported database")
	}
}

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func mustRole(t *testing.T, s *Store, name string, enabled bool) int64 {
	t.Helper()
	id, err := s.CreateRole(Role{Name: name, RuntimeID: "pi", Enabled: enabled})
	if err != nil {
		t.Fatalf("CreateRole(%s): %v", name, err)
	}
	return id
}

func mustTask(t *testing.T, s *Store, title string, agentID *int64, status string, body string) int64 {
	t.Helper()
	id, err := s.CreateTask(Task{Title: title, Body: body, Status: status, RoleID: agentID})
	if err != nil {
		t.Fatalf("CreateTask(%s): %v", title, err)
	}
	return id
}

// 新库会预置一个通用模板，用于让会话中的 agent 把上下文整理成当前项目任务。
func TestOpenSeedsCreateTasksTemplate(t *testing.T) {
	s := openTest(t)

	templates, err := s.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(templates) != 1 {
		t.Fatalf("默认模板数量 = %d, want 1: %+v", len(templates), templates)
	}
	got := templates[0]
	if got.Name != createTasksTemplateName || got.Body != createTasksTemplateBody || got.RoleID != nil {
		t.Fatalf("默认模板 = %+v, want name=%q body=%q 且不绑定角色", got, createTasksTemplateName, createTasksTemplateBody)
	}
}

// 默认数据只初始化一次：重启不会重复插入，用户主动删除后也不会被恢复。
func TestDefaultTemplateSeedRunsOnce(t *testing.T) {
	path := t.TempDir() + "/seed.db"

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	templates, err := s.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(templates) != 1 {
		t.Fatalf("首次打开默认模板 = %+v, want 1 条", templates)
	}
	defaultID := templates[0].ID
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	templates, err = s.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(templates) != 1 || templates[0].ID != defaultID {
		t.Fatalf("重启后默认模板 = %+v, want 原来的 #%d", templates, defaultID)
	}
	if err := s.DeleteTemplate(defaultID); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	templates, err = s.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(templates) != 0 {
		t.Fatalf("删除后重启不应恢复默认模板: %+v", templates)
	}
}

// 任务模板：创建 → 读取 → 更新 → 删除全链路，Role 关联随更新变化。
func TestTemplateCRUDRoundTrip(t *testing.T) {
	s := openTest(t)
	aid := mustRole(t, s, "tpl-agent", true)

	id, err := s.CreateTemplate(Template{Name: "发布检查", Body: "检查发布清单", RoleID: &aid})
	if err != nil {
		t.Fatal(err)
	}

	got, err := s.GetTemplate(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "发布检查" || got.Body != "检查发布清单" || got.RoleID == nil || *got.RoleID != aid {
		t.Fatalf("GetTemplate = %+v, want 完整字段", got)
	}

	// 更新名称与内容；agent 置空应落库为 NULL
	if err := s.UpdateTemplate(id, map[string]any{"name": "发布检查 v2", "body": "更新后的提示词", "role_id": nil}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetTemplate(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "发布检查 v2" || got.Body != "更新后的提示词" || got.RoleID != nil {
		t.Fatalf("UpdateTemplate 后 GetTemplate = %+v, want 新值且 role_id NULL", got)
	}
	if got.RoleName != "" {
		t.Fatalf("agent 置空后 RoleName = %q, want 空", got.RoleName)
	}

	if err := s.DeleteTemplate(id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetTemplate(id); err == nil {
		t.Fatal("删除后 GetTemplate 应报错")
	}
}

// 停用的角色不应出现在可派发队列里。
func TestListQueuedTasksSkipsDisabledRoles(t *testing.T) {
	s := openTest(t)
	on := mustRole(t, s, "on", true)
	off := mustRole(t, s, "off", false)
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

// 角色是执行池而非单一会话：并发零值收敛为 1，显式配置则完整保存。
func TestRoleMaxConcurrencyDefaultsAndRoundTrips(t *testing.T) {
	s := openTest(t)
	defaultID := mustRole(t, s, "default-pool", true)
	defaultAgent, err := s.GetRole(defaultID)
	if err != nil {
		t.Fatal(err)
	}
	if defaultAgent.MaxConcurrency != 1 || defaultAgent.ConcurrencyLimit() != 1 {
		t.Fatalf("未配置角色应默认单并发，得到 %+v", defaultAgent)
	}

	id, err := s.CreateRole(Role{Name: "parallel-pool", RuntimeID: "pi", Enabled: true, MaxConcurrency: 3})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateRole(id, map[string]any{"max_concurrency": 5}); err != nil {
		t.Fatal(err)
	}
	a, err := s.GetRole(id)
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

// 列表接口 body 截断到 400 字符，详情接口保持完整。
func TestListBodyTruncatedDetailFull(t *testing.T) {
	s := openTest(t)
	a := mustRole(t, s, "a", true)
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

func TestApproveReviewTaskCreatesOneMergeTaskAtomically(t *testing.T) {
	s := openTest(t)
	a := mustRole(t, s, "reviewer", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "review me", Status: StatusAwaitingReview, Perm: PermReview,
		RoleID: &a, ProjectID: &projectID, ProjectDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	merge := Task{
		Title: "merge reviewed task", Body: "integrate", Status: StatusQueued,
		Perm: PermFull, RunMode: RunModeBatch, RoleID: &a, ProjectID: &projectID,
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
	if created.Perm != PermFull || created.Status != StatusQueued || created.RoleID == nil || *created.RoleID != a {
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
	agentID := mustRole(t, s, "merger", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "finish me", Status: StatusRunning, Perm: PermFull,
		RoleID: &agentID, ProjectID: &projectID, ProjectDir: t.TempDir(), BlockOnFailure: true,
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
	agentID := mustRole(t, s, "reconciler", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "finish despite handoff failure", Status: StatusRunning, Perm: PermFull,
		RoleID: &agentID, ProjectID: &projectID, ProjectDir: t.TempDir(),
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

// 会话交付任务的收编路径：queued → succeeded + 唯一合并子任务（原子）。
func TestDeliverTaskAndCreateMerge(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "deliver", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sid, err := s.CreateSession(Session{Title: "s", RoleID: agentID, Status: SessionStatusDelivered})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "delivered", Status: StatusQueued, Perm: PermFull, RunMode: RunModeBatch,
		RoleID: &agentID, ProjectID: &projectID, ProjectDir: t.TempDir(),
		SessionID: &sid, WorktreeBranch: "paihuo/session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := s.DeliverTaskAndCreateMerge(sourceID, NewMergeTask(*source))
	if err != nil {
		t.Fatal(err)
	}
	delivered, err := s.GetTask(sourceID)
	if err != nil || delivered.Status != StatusSucceeded || delivered.ExitCode == nil || *delivered.ExitCode != 0 || delivered.Error != "" {
		t.Fatalf("交付后源任务状态异常: %+v err=%v", delivered, err)
	}
	merge, err := s.GetTask(mergeID)
	if err != nil || merge.MergeOf == nil || *merge.MergeOf != sourceID {
		t.Fatalf("交付创建的合并任务异常: %+v err=%v", merge, err)
	}
	// 重复交付不产生第二个合并任务。
	if _, err := s.DeliverTaskAndCreateMerge(sourceID, NewMergeTask(*source)); err == nil {
		t.Fatal("重复交付不应创建第二个合并任务")
	}
}

// 非会话任务不能走交付收编路径（session_id 守卫）。
func TestDeliverTaskAndCreateMergeRejectsNonSessionTask(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "deliver2", true)
	sourceID, err := s.CreateTask(Task{
		Title: "plain", Status: StatusQueued, Perm: PermFull,
		RoleID: &agentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeliverTaskAndCreateMerge(sourceID, NewMergeTask(*source)); err == nil {
		t.Fatal("非会话任务不应走交付收编路径")
	}
	if got, _ := s.GetTask(sourceID); got.Status != StatusQueued {
		t.Fatalf("拒绝后任务状态不应变化: %s", got.Status)
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

// 项目内待执行实现任务可以调整顺序；重排会同步弱依赖链，而代码合并
// 任务不参与项目排序，并且在全局队列中仍然优先于实现任务。
func TestReorderProjectQueuedTasks(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "order-agent", true)
	projectID, err := s.CreateProject(Project{Name: "order-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	create := func(title string) int64 {
		t.Helper()
		id, err := s.CreateTaskWithProjectDependency(Task{
			Title: title, Status: StatusQueued, RoleID: &agentID, ProjectID: &projectID,
			DependencyMode: DependencyWeak,
		})
		if err != nil {
			t.Fatalf("创建 %s: %v", title, err)
		}
		return id
	}
	firstID, secondID, thirdID := create("first"), create("second"), create("third")
	first, err := s.GetTask(firstID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := s.CreateTask(NewMergeTask(*first))
	if err != nil {
		t.Fatal(err)
	}

	projectTasks, err := s.ListTasksFiltered(TaskFilter{ProjectID: &projectID})
	if err != nil {
		t.Fatal(err)
	}
	if len(projectTasks) < 4 || projectTasks[0].ID != firstID || projectTasks[1].ID != secondID || projectTasks[2].ID != thirdID || projectTasks[3].ID != mergeID {
		t.Fatalf("默认项目顺序应按创建时间排列，得到 %+v", projectTasks)
	}

	if err := s.ReorderProjectTasks(projectID, []int64{thirdID, firstID, secondID}); err != nil {
		t.Fatalf("重排项目任务失败: %v", err)
	}
	projectTasks, err = s.ListTasksFiltered(TaskFilter{ProjectID: &projectID})
	if err != nil {
		t.Fatal(err)
	}
	if projectTasks[0].ID != thirdID || projectTasks[1].ID != firstID || projectTasks[2].ID != secondID || projectTasks[3].ID != mergeID {
		t.Fatalf("重排后项目顺序异常，得到 %+v", projectTasks)
	}
	first, err = s.GetTask(firstID)
	if err != nil || first.DependsOn == nil || *first.DependsOn != thirdID {
		t.Fatalf("重排后弱依赖链未同步: task=%+v err=%v", first, err)
	}
	second, err := s.GetTask(secondID)
	if err != nil || second.DependsOn == nil || *second.DependsOn != firstID {
		t.Fatalf("重排后末项弱依赖未同步: task=%+v err=%v", second, err)
	}

	queued, err := s.ListQueuedTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) < 4 || queued[0].ID != mergeID || queued[1].ID != thirdID || queued[2].ID != firstID || queued[3].ID != secondID {
		t.Fatalf("合并任务或项目执行顺序异常: %+v", queued)
	}
	if err := s.ReorderProjectTasks(projectID, []int64{thirdID, firstID, secondID, mergeID}); err == nil {
		t.Fatal("合并任务不应进入可调整顺序的实现任务列表")
	}
}

func TestMovingTaskIntoProjectAppendsItsSortOrder(t *testing.T) {
	s := openTest(t)
	firstProject, err := s.CreateProject(Project{Name: "first-order-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	secondProject, err := s.CreateProject(Project{Name: "second-order-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	firstID, err := s.CreateTask(Task{Title: "first", Status: StatusQueued, ProjectID: &firstProject})
	if err != nil {
		t.Fatal(err)
	}
	movedID, err := s.CreateTask(Task{Title: "moved", Status: StatusQueued})
	if err != nil {
		t.Fatal(err)
	}
	secondID, err := s.CreateTask(Task{Title: "second", Status: StatusQueued, ProjectID: &firstProject})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateTask(movedID, map[string]any{"project_id": firstProject}); err != nil {
		t.Fatal(err)
	}
	projectTasks, err := s.ListTasksFiltered(TaskFilter{ProjectID: &firstProject})
	if err != nil {
		t.Fatal(err)
	}
	if len(projectTasks) != 3 || projectTasks[0].ID != firstID || projectTasks[1].ID != secondID || projectTasks[2].ID != movedID {
		t.Fatalf("移入项目的任务应追加到末尾: %+v", projectTasks)
	}

	if err := s.UpdateTask(movedID, map[string]any{"project_id": secondProject}); err != nil {
		t.Fatal(err)
	}
	moved, err := s.GetTask(movedID)
	if err != nil {
		t.Fatal(err)
	}
	if moved.SortOrder != 1 || moved.ProjectID == nil || *moved.ProjectID != secondProject {
		t.Fatalf("移入新项目应从该项目末尾开始排序: %+v", moved)
	}
}

func TestDeleteTaskRewiresWeakDependents(t *testing.T) {
	s := openTest(t)
	projectID, err := s.CreateProject(Project{Name: "delete-dependency-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	firstID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "first", Status: StatusSucceeded, ProjectID: &projectID,
	})
	if err != nil {
		t.Fatal(err)
	}
	secondID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "second", Status: StatusSucceeded, ProjectID: &projectID, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	thirdID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "third", Status: StatusQueued, ProjectID: &projectID, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	third, err := s.GetTask(thirdID)
	if err != nil || third.DependsOn == nil || *third.DependsOn != secondID {
		t.Fatalf("测试任务应先依赖第二项: task=%+v err=%v", third, err)
	}

	if err := s.DeleteTask(secondID); err != nil {
		t.Fatalf("删除被弱依赖的中间任务失败: %v", err)
	}
	if exists, err := s.HasTask(secondID); err != nil || exists {
		t.Fatalf("中间任务应已删除: exists=%v err=%v", exists, err)
	}
	third, err = s.GetTask(thirdID)
	if err != nil || third.DependsOn == nil || *third.DependsOn != firstID {
		t.Fatalf("删除中间任务后应改接到更早前置: task=%+v err=%v", third, err)
	}
}

// TestDetachTaskFromSessions 交付任务硬删前解除会话引用：
// task_id 清空、只影响引用该任务的会话、引用其他任务的会话不动。
func TestDetachTaskFromSessions(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "detach-agent", true)
	taskID, err := s.CreateTask(Task{Title: "delivered", RoleID: &agentID})
	if err != nil {
		t.Fatal(err)
	}
	otherID, err := s.CreateTask(Task{Title: "other", RoleID: &agentID})
	if err != nil {
		t.Fatal(err)
	}
	tid := taskID
	sid1, err := s.CreateSession(Session{Title: "s1", RoleID: agentID, Status: SessionStatusDelivered, TaskID: &tid})
	if err != nil {
		t.Fatal(err)
	}
	sid2, err := s.CreateSession(Session{Title: "s2", RoleID: agentID, Status: SessionStatusDelivered, TaskID: &tid})
	if err != nil {
		t.Fatal(err)
	}
	oid := otherID
	if _, err := s.CreateSession(Session{Title: "s3", RoleID: agentID, Status: SessionStatusDelivered, TaskID: &oid}); err != nil {
		t.Fatal(err)
	}

	affected, err := s.DetachTaskFromSessions(taskID)
	if err != nil {
		t.Fatal(err)
	}
	if len(affected) != 2 || affected[0] != sid1 || affected[1] != sid2 {
		t.Fatalf("应返回引用该任务的两个会话: %v", affected)
	}
	for _, sid := range []int64{sid1, sid2} {
		ss, err := s.GetSession(sid)
		if err != nil || ss.TaskID != nil {
			t.Fatalf("会话 %d 的 task_id 应被清空: %+v err=%v", sid, ss, err)
		}
	}
	ss3, err := s.GetSession(sid2 + 1)
	if err != nil || ss3.TaskID == nil || *ss3.TaskID != otherID {
		t.Fatalf("引用其他任务的会话不应被波及: %+v err=%v", ss3, err)
	}
	// 解除引用后硬删不应再触发外键约束。
	if err := s.DeleteTask(taskID); err != nil {
		t.Fatalf("解除引用后删除任务应成功: %v", err)
	}
}

// 弱依赖在非阻塞失败时放行，强依赖始终等待成功交付；Git 任务的交付还包括
// 它专属的代码合并任务。该测试同时覆盖“合并任务优先于后续实现任务”的队列顺序。
func TestTaskDependencyFailureAndMergeDelivery(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "dependency-agent", true)
	projectID, err := s.CreateProject(Project{Name: "dependency-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "source", Status: StatusFailed, RoleID: &agentID, ProjectID: &projectID, BlockOnFailure: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	weakID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "weak", Status: StatusQueued, RoleID: &agentID, ProjectID: &projectID, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	strongID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "strong", Status: StatusQueued, RoleID: &agentID, ProjectID: &projectID, DependencyMode: DependencyStrong, DependsOn: &sourceID,
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
	roleID := mustRole(t, s, "schedule-role", true)
	projectID, err := s.CreateProject(Project{Name: "schedule-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	id, err := s.CreateSchedule(Schedule{
		Name: "project schedule", Cron: "0 0 * * * *", TitleTemplate: "tick", RoleID: roleID,
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
	a := mustRole(t, s, "a", true)
	mustTask(t, s, "done", &a, StatusSucceeded, "")
	mustTask(t, s, "run", &a, StatusRunning, "")
	mustTask(t, s, "queued", &a, StatusQueued, "")

	n, locators, err := s.CleanupTasks(nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("应只删除 1 条终态任务，得到 %d", n)
	}
	if len(locators) != 0 {
		t.Fatalf("无 Artifact 的任务不应返回 locator: %v", locators)
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
