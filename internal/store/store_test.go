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

// 迁移完整性：模拟老库（缺新列）→ 重新 Open 后 migrate 应补齐所有新列。
func TestMigrateAddsNewColumns(t *testing.T) {
	path := t.TempDir() + "/mig.db"
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// 模拟老库：删掉新列后再打开，migrate 应补齐
	for _, col := range []string{"resume_of", "merge_of", "worktree_branch", "base_commit", "tmux_log_offset", "run_mode"} {
		if _, err := s.db.Exec("ALTER TABLE tasks DROP COLUMN " + col); err != nil {
			s.Close()
			t.Fatalf("drop %s: %v", col, err)
		}
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
	for _, want := range []string{"resume_of", "merge_of", "worktree_branch", "base_commit", "project_dir", "tmux_log_offset", "run_mode"} {
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
