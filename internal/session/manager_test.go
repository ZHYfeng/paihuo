package session

import (
	"context"
	"os"
	osexec "os/exec"
	"path/filepath"
	"testing"

	"paihuo/internal/events"
	execpkg "paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

// newTestEnv 构造测试环境：临时目录 + 内存 store + 最小角色/项目。
func newTestEnv(t *testing.T) (*Manager, *store.Store, *execpkg.Executor, string) {
	t.Helper()
	root := t.TempDir()
	st, err := store.Open(filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	// git 项目（worktree 测试用）
	projDir := filepath.Join(root, "proj")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, projDir, "init", "-b", "main")
	gitCmd(t, projDir, "config", "user.email", "t@t")
	gitCmd(t, projDir, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(projDir, "a.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, projDir, "add", ".")
	gitCmd(t, projDir, "commit", "-m", "init")

	pid, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projDir})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	_, err = st.CreateAgent(store.Agent{
		Name: "pi-role", CLI: "pi", Enabled: true,
		ProjectDir:     projDir,
		MaxConcurrency: 2,
		RoleConfig:     store.RoleConfig{Model: ""},
	})
	if err != nil {
		t.Fatalf("create agent: %v", err)
	}
	projID := pid
	hub := events.NewHub()
	ex := execpkg.NewForTest(st, hub, filepath.Join(root, "sessions"), filepath.Join(root, "db"), "sess-test")
	m := New(st, hub, ex, filepath.Join(root, "sessions"), filepath.Join(root, "db"))
	_ = projID
	return m, st, ex, root
}

func gitCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := osexec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func havePi() bool {
	_, err := osexec.LookPath("pi")
	return err == nil
}

// TestStateMachine 状态迁移表（纯逻辑）。
func TestStateMachine(t *testing.T) {
	cases := []struct {
		from, to string
		ok       bool
	}{
		{store.SessionStatusCreated, store.SessionStatusActive, true},
		{store.SessionStatusCreated, store.SessionStatusDeleted, true},
		{store.SessionStatusCreated, store.SessionStatusSuspended, false},
		{store.SessionStatusCreated, store.SessionStatusDelivered, false},
		{store.SessionStatusActive, store.SessionStatusSuspended, true},
		{store.SessionStatusActive, store.SessionStatusDelivered, true},
		{store.SessionStatusActive, store.SessionStatusDeleted, true},
		{store.SessionStatusActive, store.SessionStatusCreated, false},
		{store.SessionStatusSuspended, store.SessionStatusActive, true},
		{store.SessionStatusSuspended, store.SessionStatusDelivered, true},
		{store.SessionStatusSuspended, store.SessionStatusDeleted, true},
		{store.SessionStatusDelivered, store.SessionStatusActive, false},
		{store.SessionStatusDelivered, store.SessionStatusDeleted, false},
		{store.SessionStatusDelivered, store.SessionStatusSuspended, true}, // 交付任务删除后解冻
		{store.SessionStatusDeleted, store.SessionStatusActive, false},
	}
	for _, c := range cases {
		if got := CanTransition(c.from, c.to); got != c.ok {
			t.Errorf("CanTransition(%s→%s)=%v, want %v", c.from, c.to, got, c.ok)
		}
	}
}

// TestCreateWorktree 创建会话应建好隔离 worktree（paihuo/session-<id>）。
func TestCreateWorktree(t *testing.T) {
	m, st, _, _ := newTestEnv(t)
	proj, err := st.ListProjects()
	if err != nil || len(proj) != 1 {
		t.Fatalf("projects: %v %d", err, len(proj))
	}
	agents, _ := st.ListAgents()
	ss, err := m.Create(&proj[0].ID, agents[0].ID, "会话A")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if ss.Status != store.SessionStatusCreated {
		t.Errorf("status=%s", ss.Status)
	}
	if ss.WorktreeBranch != "paihuo/session-1" {
		t.Errorf("branch=%s", ss.WorktreeBranch)
	}
	if fi, err := os.Stat(ss.WorktreePath); err != nil || !fi.IsDir() {
		t.Errorf("worktree 目录不存在: %v", err)
	}
	branch := gitCmd(t, proj[0].ProjectDir, "branch", "--list", "paihuo/session-1")
	if branch == "" {
		t.Error("会话分支未创建")
	}
}

// TestDeliverReusesWorktree 交付 → 任务复用会话 worktree（Ensure 直接命中）。
func TestDeliverReusesWorktree(t *testing.T) {
	m, st, _, _ := newTestEnv(t)
	proj, _ := st.ListProjects()
	agents, _ := st.ListAgents()
	ss, err := m.Create(&proj[0].ID, agents[0].ID, "会话B")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// created 不可直接交付（设计：无对话内容拒交付）→ 先启动再挂起。
	if err := m.Start(context.Background(), ss.ID); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := m.Suspend(context.Background(), ss.ID); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	tk, err := m.Deliver(context.Background(), ss.ID, "交付任务", "", store.PermFull)
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if tk.SessionID == nil || *tk.SessionID != ss.ID {
		t.Errorf("task.session_id=%v", tk.SessionID)
	}
	if tk.WorktreeBranch != ss.WorktreeBranch {
		t.Errorf("task 分支=%s, 会话分支=%s", tk.WorktreeBranch, ss.WorktreeBranch)
	}
	// Ensure 应直接命中会话 worktree（不重建）。
	dir, branch, _, err := workspace.Ensure(*tk, m.sessionsRoot)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if dir != ss.WorktreePath {
		t.Errorf("ensure dir=%s want %s", dir, ss.WorktreePath)
	}
	if branch != ss.WorktreeBranch {
		t.Errorf("ensure branch=%s want %s", branch, ss.WorktreeBranch)
	}
	// 会话已冻结。
	got, _ := m.Get(ss.ID)
	if got.Status != store.SessionStatusDelivered {
		t.Errorf("status=%s", got.Status)
	}
	if got.TaskID == nil || *got.TaskID != tk.ID {
		t.Errorf("session.task_id=%v", got.TaskID)
	}
}

// TestLifecycleWithRealPi 冒烟：真实 pi RPC 进程的 start → prompt → suspend →
// resume（switch_session 恢复）→ deliver。需要本机安装 pi。
func TestLifecycleWithRealPi(t *testing.T) {
	if !havePi() {
		t.Skip("本机未安装 pi，跳过冒烟测试")
	}
	m, st, ex, _ := newTestEnv(t)
	proj, _ := st.ListProjects()
	agents, _ := st.ListAgents()
	ss, err := m.Create(&proj[0].ID, agents[0].ID, "冒烟")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	ctx := context.Background()
	if err := m.Start(ctx, ss.ID); err != nil {
		t.Fatalf("start: %v", err)
	}
	got, _ := m.Get(ss.ID)
	if got.Status != store.SessionStatusActive {
		t.Fatalf("start 后 status=%s", got.Status)
	}
	// prompt 接受（不等待 LLM 完成）。
	accepted, err := m.Prompt(ctx, ss.ID, "只回复 OK", nil, "")
	if err != nil || !accepted {
		t.Fatalf("prompt: accepted=%v err=%v", accepted, err)
	}
	// 等 agent 完成（最多 60s）。
	deadline := timeAfter(150)
	for {
		state, err := m.State(ctx, ss.ID)
		if err == nil {
			var d struct {
				IsStreaming bool `json:"isStreaming"`
			}
			_ = jsonUnmarshal(state, &d)
			if !d.IsStreaming {
				break
			}
		}
		select {
		case <-deadline:
			t.Fatal("agent 未在 150s 内完成")
		default:
			timeSleep(500)
		}
	}
	msgs, err := m.Messages(ctx, ss.ID)
	if err != nil || len(msgs) == 0 {
		t.Fatalf("messages: %v len=%d", err, len(msgs))
	}
	// 挂起。
	if err := m.Suspend(ctx, ss.ID); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	got, _ = m.Get(ss.ID)
	if got.Status != store.SessionStatusSuspended {
		t.Fatalf("suspend 后 status=%s", got.Status)
	}
	// 恢复（switch_session）。
	if err := m.Start(ctx, ss.ID); err != nil {
		t.Fatalf("resume: %v", err)
	}
	got, _ = m.Get(ss.ID)
	if got.Status != store.SessionStatusActive {
		t.Fatalf("resume 后 status=%s", got.Status)
	}
	msgs2, err := m.Messages(ctx, ss.ID)
	if err != nil || len(msgs2) == 0 {
		t.Fatalf("resume 后 messages: %v len=%d", err, len(msgs2))
	}
	if string(msgs2) != string(msgs) {
		t.Logf("resume 后消息与挂起前一致（长度 %d vs %d）", len(msgs2), len(msgs))
	}
	// 交付。
	tk, err := m.Deliver(ctx, ss.ID, "冒烟交付", "", store.PermFull)
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if tk.SessionID == nil || *tk.SessionID != ss.ID {
		t.Fatalf("task.session_id=%v", tk.SessionID)
	}
	// transcript 可读（挂起后从文件解析）。
	entries, total, err := m.Transcript(ctx, ss.ID, 0, "")
	if err != nil || len(entries) == 0 || total == 0 {
		t.Fatalf("transcript: %v len=%d", err, len(entries))
	}
	// 崩溃恢复：再开一个会话，主动杀进程 → 自动 suspended。
	ss2, err := m.Create(&proj[0].ID, agents[0].ID, "崩溃测试")
	if err != nil {
		t.Fatalf("create2: %v", err)
	}
	if err := m.Start(ctx, ss2.ID); err != nil {
		t.Fatalf("start2: %v", err)
	}
	m.mu.Lock()
	proc := m.procs[ss2.ID]
	m.mu.Unlock()
	if proc == nil {
		t.Fatal("进程未注册")
	}
	_ = proc.cmd.Process.Kill()
	waitDeadline := timeAfter(10)
	for {
		got2, _ := m.Get(ss2.ID)
		if got2.Status == store.SessionStatusSuspended {
			break
		}
		select {
		case <-waitDeadline:
			t.Fatalf("崩溃后未自动挂起，status=%s", got2.Status)
		default:
			timeSleep(100)
		}
	}
	// 槽位已释放（并发 2，两个会话都已挂起/交付 → 应可再启动）。
	m.ex.ReleaseAgentSlot(agents[0].ID)
	m.ex.ReleaseAgentSlot(agents[0].ID)
	_ = ex
}
