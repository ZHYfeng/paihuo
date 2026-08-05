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
	id, err := s.CreateAgent(Agent{Name: name, CLI: "pi", Enabled: enabled, DefaultPerm: "full"})
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
	for _, col := range []string{"resume_of", "worktree_branch", "base_commit"} {
		if _, err := s.db.Exec("ALTER TABLE tasks DROP COLUMN " + col); err != nil {
			s.Close()
			t.Fatalf("drop %s: %v", col, err)
		}
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
	for _, want := range []string{"resume_of", "worktree_branch", "base_commit", "project_dir"} {
		if !cols[want] {
			t.Fatalf("迁移后缺少列 %s（现有列: %v）", want, cols)
		}
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
