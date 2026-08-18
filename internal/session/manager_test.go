package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
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
	_, err = st.CreateRole(store.Role{
		Name: "pi-role", RuntimeID: "pi", Enabled: true,
		MaxConcurrency: 2,
		RoleConfig:     store.RoleConfig{Model: ""},
	})
	if err != nil {
		t.Fatalf("create agent: %v", err)
	}
	projID := pid
	hub := events.NewEventStream()
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
		{store.SessionStatusDelivered, store.SessionStatusSuspended, false}, // 交付即终态：不再解冻（防反复交付）
		{store.SessionStatusDelivered, store.SessionStatusDeleted, true},    // 任务删除联动清理 / 手动丢弃归档
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
	agents, _ := st.ListRoles()
	ss, err := m.Create(&proj[0].ID, agents[0].ID, "full")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if ss.Status != store.SessionStatusCreated {
		t.Errorf("status=%s", ss.Status)
	}
	if ss.Title != agents[0].Name {
		t.Errorf("title=%q, want agent name %q", ss.Title, agents[0].Name)
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

// 只有声明结构化 Session capability 的 Runtime 可以创建会话。
func TestCreateSessionRejectsNonPiOmpAgents(t *testing.T) {
	m, st, _, _ := newTestEnv(t)
	for _, cli := range []string{"pi", "omp", "opencode", "claude", "codex"} {
		id, err := st.CreateRole(store.Role{Name: cli + "-sess", RuntimeID: cli, Enabled: true})
		if err != nil {
			t.Fatal(err)
		}
		_, err = m.Create(nil, id, "full")
		if cli == "pi" || cli == "omp" {
			if err != nil {
				t.Fatalf("%s 创建会话应成功: %v", cli, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), "不提供结构化会话能力") {
			t.Fatalf("%s 创建会话应被 capability 拒绝，得到: %v", cli, err)
		}
	}
}

// 绕过创建校验落库的无 Session capability Runtime 也必须在启动时拒绝。
func TestStartRejectsLegacyNonPiOmpSession(t *testing.T) {
	m, st, _, _ := newTestEnv(t)
	cxID, err := st.CreateRole(store.Role{Name: "codex-sess", RuntimeID: "codex", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	// 绕过创建校验直接落库（Runtime 能力由角色 runtime_id 决定，启动时校验）。
	id, err := st.CreateSessionTask(store.Task{
		RoleID: &cxID, Title: "遗留", Status: store.SessionStatusCreated,
	})
	if err != nil {
		t.Fatal(err)
	}
	err = m.Start(context.Background(), id)
	if err == nil || !strings.Contains(err.Error(), "不提供结构化会话能力") {
		t.Fatalf("遗留 codex 会话启动应被拒绝: %v", err)
	}
	got, _ := m.Get(id)
	if got.Status != store.SessionStatusCreated {
		t.Fatalf("启动失败不应改变状态，得到 %s", got.Status)
	}
}

// TestDeliverReusesWorktree 交付 → 任务复用会话 worktree（Ensure 直接命中）。
func TestDeliverReusesWorktree(t *testing.T) {
	if !havePi() {
		t.Skip("本机未安装 pi，跳过交付冒烟测试")
	}
	m, st, _, _ := newTestEnv(t)
	proj, _ := st.ListProjects()
	agents, _ := st.ListRoles()
	ss, err := m.Create(&proj[0].ID, agents[0].ID, "full")
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
	// 交付 = 收编：任务直接完成（跳过执行），并自动创建代码合并任务。
	if tk.Status != store.StatusSucceeded {
		t.Errorf("交付任务应直接完成，status=%s", tk.Status)
	}
	if tk.Body == "" || !strings.Contains(tk.Body, "会话 #") {
		t.Errorf("交付任务 body 应预填会话摘要: %q", tk.Body)
	}
	kids, err := st.ListChildren(tk.ID)
	if err != nil {
		t.Fatalf("children: %v", err)
	}
	if len(kids) != 1 || kids[0].MergeOf == nil || *kids[0].MergeOf != tk.ID {
		t.Fatalf("交付任务应自动创建一个合并子任务: %+v", kids)
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
	// 会话已冻结；收编任务回链会话（tasks.session_id 指向会话 id）。
	got, _ := m.Get(ss.ID)
	if got.Status != store.SessionStatusDelivered {
		t.Errorf("status=%s", got.Status)
	}
	delivered, err := st.GetTask(tk.ID)
	if err != nil {
		t.Fatalf("get delivered task: %v", err)
	}
	if delivered.SessionID == nil || *delivered.SessionID != ss.ID {
		t.Errorf("delivered task session_id=%v, want %d", delivered.SessionID, ss.ID)
	}
}

// TestDeliverReviewSkipsExecution 交付 review → 任务直接 awaiting_review（跳过
// 执行），无合并子任务；会话冻结。created 会话直接置 suspended 绕过启动（无 pi）。
func TestDeliverReviewSkipsExecution(t *testing.T) {
	m, st, _, _ := newTestEnv(t)
	proj, _ := st.ListProjects()
	agents, _ := st.ListRoles()
	ss, err := m.Create(&proj[0].ID, agents[0].ID, "full")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := st.UpdateTask(ss.ID, map[string]any{"status": store.SessionStatusSuspended}); err != nil {
		t.Fatalf("suspend via store: %v", err)
	}
	tk, err := m.Deliver(context.Background(), ss.ID, "交付审查", "", store.PermReview)
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if tk.Status != store.StatusAwaitingReview {
		t.Fatalf("review 交付应直接待审批，status=%s", tk.Status)
	}
	if tk.ReviewRounds != 1 {
		t.Fatalf("review_rounds=%d want 1", tk.ReviewRounds)
	}
	if tk.FinishedAt == nil || tk.ExitCode == nil || *tk.ExitCode != 0 {
		t.Fatalf("交付任务应带完成时间与 exit 0: %+v", tk)
	}
	// 无合并子任务（审批通过后才创建）。
	kids, err := st.ListChildren(tk.ID)
	if err != nil {
		t.Fatalf("children: %v", err)
	}
	if len(kids) != 0 {
		t.Fatalf("review 交付不应有合并子任务: %+v", kids)
	}
	// 会话冻结；收编任务回链会话。
	got, _ := m.Get(ss.ID)
	if got.Status != store.SessionStatusDelivered {
		t.Fatalf("会话未冻结: %+v", got)
	}
	delivered, err := st.GetTask(tk.ID)
	if err != nil || delivered.SessionID == nil || *delivered.SessionID != ss.ID {
		t.Fatalf("收编任务未回链会话: %+v err=%v", delivered, err)
	}
}

// TestDeliverFullNonGitCompletesWithoutMerge 交付 full + 非 git 项目 → 任务直接
// succeeded（无 worktree 合并环节），不创建合并子任务。
func TestDeliverFullNonGitCompletesWithoutMerge(t *testing.T) {
	m, st, _, root := newTestEnv(t)
	plainDir := filepath.Join(root, "plain")
	if err := os.MkdirAll(plainDir, 0o755); err != nil {
		t.Fatal(err)
	}
	pid, err := st.CreateProject(store.Project{Name: "plain", ProjectDir: plainDir})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	agents, _ := st.ListRoles()
	ss, err := m.Create(&pid, agents[0].ID, "full")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if ss.WorktreeBranch != "" {
		t.Fatalf("非 git 会话不应有分支: %q", ss.WorktreeBranch)
	}
	if err := st.UpdateTask(ss.ID, map[string]any{"status": store.SessionStatusSuspended}); err != nil {
		t.Fatalf("suspend via store: %v", err)
	}
	tk, err := m.Deliver(context.Background(), ss.ID, "交付普通", "", store.PermFull)
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if tk.Status != store.StatusSucceeded {
		t.Fatalf("非 git 交付应直接完成，status=%s", tk.Status)
	}
	kids, err := st.ListChildren(tk.ID)
	if err != nil {
		t.Fatalf("children: %v", err)
	}
	if len(kids) != 0 {
		t.Fatalf("非 git 交付不应有合并子任务: %+v", kids)
	}
}

// TestLifecycleWithRealPi 冒烟：真实 pi RPC 进程的 start → prompt → suspend →
// resume（switch_session 恢复）→ deliver。需要本机安装 pi。
func TestLifecycleWithRealPi(t *testing.T) {
	if os.Getenv("PAIHUO_REAL_RUNTIME_TESTS") != "1" {
		t.Skip("设置 PAIHUO_REAL_RUNTIME_TESTS=1 后运行真实 Pi 冒烟")
	}
	if !havePi() {
		t.Skip("本机未安装 pi，跳过冒烟测试")
	}
	m, st, ex, _ := newTestEnv(t)
	proj, _ := st.ListProjects()
	agents, _ := st.ListRoles()
	ss, err := m.Create(&proj[0].ID, agents[0].ID, "full")
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
	// 交付（收编：跳过执行，直接完成 + 自动合并任务）。
	tk, err := m.Deliver(ctx, ss.ID, "冒烟交付", "", store.PermFull)
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if tk.SessionID == nil || *tk.SessionID != ss.ID {
		t.Fatalf("task.session_id=%v", tk.SessionID)
	}
	if tk.Status != store.StatusSucceeded {
		t.Fatalf("交付任务应直接完成，status=%s", tk.Status)
	}
	// transcript 可读（挂起后从文件解析）。
	entries, total, err := m.Transcript(ctx, ss.ID, 0, "")
	if err != nil || len(entries) == 0 || total == 0 {
		t.Fatalf("transcript: %v len=%d", err, len(entries))
	}
	// 崩溃恢复：再开一个会话，主动杀进程 → 自动 suspended。
	ss2, err := m.Create(&proj[0].ID, agents[0].ID, "full")
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
	// 该测试角色是 pi：通道底层是 RPC 子进程，直接杀进程模拟崩溃。
	if rpc, ok := proc.(*rpcProc); ok {
		_ = rpc.cmd.Process.Kill()
	} else {
		t.Fatalf("期望 pi RPC 进程通道，得到 %T", proc)
	}
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
	m.ex.ReleaseRoleSlot(agents[0].ID)
	m.ex.ReleaseRoleSlot(agents[0].ID)
	_ = ex
}

// TestTranscriptPagination before 游标语义：返回该 entry 之前的 limit 条
// （不含游标，即上一页）；不足一页贴到文件开头；游标找不到返回空页。
// 会话页「向上滚动自动加载更早消息」依赖此语义做分页合并。
func TestTranscriptPagination(t *testing.T) {
	m, st, _, root := newTestEnv(t)
	dir := filepath.Join(root, "sessions", "tx-sess")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for i := 0; i < 60; i++ {
		b, _ := json.Marshal(map[string]any{
			"type":    "message",
			"id":      fmt.Sprintf("e%03d", i),
			"message": map[string]any{"role": "user", "content": []any{}},
		})
		lines = append(lines, string(b))
	}
	if err := os.WriteFile(filepath.Join(dir, "2026-01-01T00-00-00-000Z_test.jsonl"),
		[]byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	roleID := int64(1) // newTestEnv 创建的最小角色
	sid, err := st.CreateSessionTask(store.Task{
		RoleID: &roleID, Title: "pagination", Status: store.SessionStatusDelivered,
		SessionDir: dir, CreatedAt: store.Now(), UpdatedAt: store.Now(),
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	ctx := context.Background()
	firstID := func(es []map[string]any) any {
		if len(es) == 0 {
			return nil
		}
		return es[0]["id"]
	}

	// 不传游标：尾部 limit 条。
	entries, total, err := m.Transcript(ctx, sid, 10, "")
	if err != nil || total != 60 || len(entries) != 10 || firstID(entries) != "e050" {
		t.Fatalf("tail: err=%v total=%d n=%d first=%v", err, total, len(entries), firstID(entries))
	}
	// before 游标：返回该条之前的 limit 条（不含游标）。
	entries, total, err = m.Transcript(ctx, sid, 10, "e050")
	if err != nil || total != 60 || len(entries) != 10 || firstID(entries) != "e040" {
		t.Fatalf("prev: err=%v n=%d first=%v", err, len(entries), firstID(entries))
	}
	if last := entries[len(entries)-1]["id"]; last != "e049" {
		t.Fatalf("prev 末条=%v，应 e049（不含游标）", last)
	}
	// 跨页向前翻。
	entries, _, _ = m.Transcript(ctx, sid, 10, "e015")
	if len(entries) != 10 || firstID(entries) != "e005" {
		t.Fatalf("prev2: n=%d first=%v", len(entries), firstID(entries))
	}
	// 不足一页：贴到文件开头。
	entries, _, _ = m.Transcript(ctx, sid, 10, "e003")
	if len(entries) != 3 || firstID(entries) != "e000" {
		t.Fatalf("short: n=%d first=%v", len(entries), firstID(entries))
	}
	// 游标找不到：返回空页（total 仍为全量）。
	entries, total, _ = m.Transcript(ctx, sid, 10, "missing")
	if len(entries) != 0 || total != 60 {
		t.Fatalf("missing cursor: n=%d total=%d", len(entries), total)
	}
}
