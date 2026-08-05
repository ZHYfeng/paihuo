package exec

import (
	"context"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

const tmuxExecutorTestCLI = "tmux-executor-test"
const tmuxConcurrencyTestCLI = "tmux-concurrency-test"
const tmuxAutoMergeTestCLI = "tmux-auto-merge-test"
const tmuxReviewMergeTestCLI = "tmux-review-merge-test"

type tmuxExecutorTestAdapter struct{}

func (tmuxExecutorTestAdapter) ID() string   { return tmuxExecutorTestCLI }
func (tmuxExecutorTestAdapter) Name() string { return "tmux executor test" }
func (tmuxExecutorTestAdapter) Detect() (string, error) {
	return osexec.LookPath("sh")
}
func (tmuxExecutorTestAdapter) Build(RunOptions) (string, []string, []string, error) {
	sh, err := osexec.LookPath("sh")
	if err != nil {
		return "", nil, nil, err
	}
	return sh, []string{"-c", "printf 'before\\n'; sleep 1; printf 'after\\n'"}, os.Environ(), nil
}
func (tmuxExecutorTestAdapter) Warnings(RunOptions) []string { return nil }
func (tmuxExecutorTestAdapter) Schema() []Field              { return nil }
func (tmuxExecutorTestAdapter) Models() []string             { return nil }
func (tmuxExecutorTestAdapter) Docs() string                 { return "" }

// 长时间运行的适配器让测试可以稳定观测同一角色的多个并发 task window。
type tmuxConcurrencyTestAdapter struct{}

func (tmuxConcurrencyTestAdapter) ID() string   { return tmuxConcurrencyTestCLI }
func (tmuxConcurrencyTestAdapter) Name() string { return "tmux concurrency test" }
func (tmuxConcurrencyTestAdapter) Detect() (string, error) {
	return osexec.LookPath("sh")
}
func (tmuxConcurrencyTestAdapter) Build(RunOptions) (string, []string, []string, error) {
	sh, err := osexec.LookPath("sh")
	if err != nil {
		return "", nil, nil, err
	}
	return sh, []string{"-c", "sleep 20"}, os.Environ(), nil
}
func (tmuxConcurrencyTestAdapter) Warnings(RunOptions) []string { return nil }
func (tmuxConcurrencyTestAdapter) Schema() []Field              { return nil }
func (tmuxConcurrencyTestAdapter) Models() []string             { return nil }
func (tmuxConcurrencyTestAdapter) Docs() string                 { return "" }

type tmuxAutoMergeTestAdapter struct{}

func (tmuxAutoMergeTestAdapter) ID() string   { return tmuxAutoMergeTestCLI }
func (tmuxAutoMergeTestAdapter) Name() string { return "tmux auto merge test" }
func (tmuxAutoMergeTestAdapter) Detect() (string, error) {
	return osexec.LookPath("sh")
}
func (tmuxAutoMergeTestAdapter) Build(RunOptions) (string, []string, []string, error) {
	sh, err := osexec.LookPath("sh")
	if err != nil {
		return "", nil, nil, err
	}
	return sh, []string{"-c", "printf 'merged\\n' > auto-merged.txt"}, os.Environ(), nil
}
func (tmuxAutoMergeTestAdapter) Warnings(RunOptions) []string { return nil }
func (tmuxAutoMergeTestAdapter) Schema() []Field              { return nil }
func (tmuxAutoMergeTestAdapter) Models() []string             { return nil }
func (tmuxAutoMergeTestAdapter) Docs() string                 { return "" }

type tmuxReviewMergeTestAdapter struct{}

func (tmuxReviewMergeTestAdapter) ID() string   { return tmuxReviewMergeTestCLI }
func (tmuxReviewMergeTestAdapter) Name() string { return "tmux review merge test" }
func (tmuxReviewMergeTestAdapter) Detect() (string, error) {
	return osexec.LookPath("sh")
}
func (tmuxReviewMergeTestAdapter) Build(RunOptions) (string, []string, []string, error) {
	sh, err := osexec.LookPath("sh")
	if err != nil {
		return "", nil, nil, err
	}
	return sh, []string{"-c", "test \"$(cat approved.txt)\" = approved && printf 'verified\\n' > merge-verified.txt"}, os.Environ(), nil
}
func (tmuxReviewMergeTestAdapter) Warnings(RunOptions) []string { return nil }
func (tmuxReviewMergeTestAdapter) Schema() []Field              { return nil }
func (tmuxReviewMergeTestAdapter) Models() []string             { return nil }
func (tmuxReviewMergeTestAdapter) Docs() string                 { return "" }

func TestExecutorAutoMergesSuccessfulFullTask(t *testing.T) {
	if _, err := osexec.LookPath("tmux"); err != nil {
		t.Skip("tmux 未安装")
	}
	registry[tmuxAutoMergeTestCLI] = tmuxAutoMergeTestAdapter{}
	t.Cleanup(func() { delete(registry, tmuxAutoMergeTestCLI) })

	projectDir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "test"},
	} {
		cmd := osexec.Command("git", args...)
		cmd.Dir = projectDir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(projectDir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-qm", "init"}} {
		cmd := osexec.Command("git", args...)
		cmd.Dir = projectDir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	agentID, err := st.CreateAgent(store.Agent{Name: "auto", CLI: tmuxAutoMergeTestCLI, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projectDir, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{
		Title: "auto merge", Status: store.StatusQueued, Perm: store.PermFull,
		AgentID: &agentID, ProjectID: &projectID, ProjectDir: projectDir,
	})
	if err != nil {
		t.Fatal(err)
	}

	sessionsRoot := t.TempDir()
	socket := fmt.Sprintf("paihuo-auto-merge-test-%d", os.Getpid())
	e := New(st, events.NewHub(), sessionsRoot, "auto-merge-test.db")
	e.runner = newTmuxRunnerAt(sessionsRoot, socket)
	cleanupRunner := newTmuxRunnerAt(sessionsRoot, socket)
	t.Cleanup(func() { _ = cleanupRunner.command("kill-server") })
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	e.Start(ctx)
	e.Wake()

	waitTaskStatus(t, st, taskID, store.StatusSucceeded, 5*time.Second)
	got, err := os.ReadFile(filepath.Join(projectDir, "auto-merged.txt"))
	if err != nil || string(got) != "merged\n" {
		t.Fatalf("自动任务产出未进入主分支: %q err=%v", got, err)
	}
}

func TestExecutorPreparesAndAutoMergesReviewMergeTask(t *testing.T) {
	if _, err := osexec.LookPath("tmux"); err != nil {
		t.Skip("tmux 未安装")
	}
	registry[tmuxReviewMergeTestCLI] = tmuxReviewMergeTestAdapter{}
	t.Cleanup(func() { delete(registry, tmuxReviewMergeTestCLI) })
	projectDir := initExecutorGitProject(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	agentID, err := st.CreateAgent(store.Agent{Name: "merge-agent", CLI: tmuxReviewMergeTestCLI, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projectDir, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sessionsRoot := t.TempDir()
	sourceID, err := st.CreateTask(store.Task{
		Title: "approved source", Status: store.StatusSucceeded, Perm: store.PermReview,
		AgentID: &agentID, ProjectID: &projectID, ProjectDir: projectDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := st.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	sourceDir, sourceBranch, sourceBase, err := workspace.Ensure(*source, sessionsRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "approved.txt"), []byte("approved\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTask(sourceID, map[string]any{"worktree_branch": sourceBranch, "base_commit": sourceBase}); err != nil {
		t.Fatal(err)
	}
	source.WorktreeBranch, source.BaseCommit = sourceBranch, sourceBase
	if _, err := workspace.Snapshot(*source, sessionsRoot); err != nil {
		t.Fatal(err)
	}
	mergeID, err := st.CreateTask(store.Task{
		Title: "merge approved source", Status: store.StatusQueued, Perm: store.PermFull,
		AgentID: &agentID, ProjectID: &projectID, ProjectDir: projectDir,
		ParentID: &sourceID, MergeOf: &sourceID,
	})
	if err != nil {
		t.Fatal(err)
	}

	socket := fmt.Sprintf("paihuo-review-merge-test-%d", os.Getpid())
	e := New(st, events.NewHub(), sessionsRoot, "review-merge-test.db")
	e.runner = newTmuxRunnerAt(sessionsRoot, socket)
	cleanupRunner := newTmuxRunnerAt(sessionsRoot, socket)
	t.Cleanup(func() { _ = cleanupRunner.command("kill-server") })
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	e.Start(ctx)
	e.Wake()

	waitTaskStatus(t, st, mergeID, store.StatusSucceeded, 5*time.Second)
	for name, want := range map[string]string{"approved.txt": "approved\n", "merge-verified.txt": "verified\n"} {
		got, err := os.ReadFile(filepath.Join(projectDir, name))
		if err != nil || string(got) != want {
			t.Fatalf("合并任务产出 %s 未进入主分支: %q err=%v", name, got, err)
		}
	}
}

func initExecutorGitProject(t *testing.T) string {
	t.Helper()
	projectDir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "test"},
	} {
		cmd := osexec.Command("git", args...)
		cmd.Dir = projectDir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(projectDir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-qm", "init"}} {
		cmd := osexec.Command("git", args...)
		cmd.Dir = projectDir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	return projectDir
}

func TestExecutorRecoversRunningTmuxTaskAfterServiceRestart(t *testing.T) {
	if _, err := osexec.LookPath("tmux"); err != nil {
		t.Skip("tmux 未安装")
	}
	registry[tmuxExecutorTestCLI] = tmuxExecutorTestAdapter{}
	t.Cleanup(func() { delete(registry, tmuxExecutorTestCLI) })

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	workDir := t.TempDir()
	agentID, err := st.CreateAgent(store.Agent{Name: "runner", CLI: tmuxExecutorTestCLI, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{
		Title: "tmux recovery", Status: store.StatusQueued, Perm: store.PermFull,
		AgentID: &agentID, ProjectDir: workDir,
	})
	if err != nil {
		t.Fatal(err)
	}

	sessionsRoot := t.TempDir()
	socket := fmt.Sprintf("paihuo-executor-test-%d", os.Getpid())
	newExecutor := func() *Executor {
		e := New(st, events.NewHub(), sessionsRoot, "test.db")
		e.runner = newTmuxRunnerAt(sessionsRoot, socket)
		return e
	}
	cleanupRunner := newTmuxRunnerAt(sessionsRoot, socket)
	t.Cleanup(func() { _ = cleanupRunner.command("kill-server") })

	ctx1, stop1 := context.WithCancel(context.Background())
	e1 := newExecutor()
	e1.Start(ctx1)
	if !e1.runner.hasSession() {
		t.Fatal("执行器启动时应建立唯一的专用 tmux session")
	}
	e1.Wake()
	waitRunningWindow(t, st, e1.runner, taskID, 3*time.Second)

	// 模拟 paihuo 本身重启：不取消任务级 context，因此 window 必须继续运行。
	stop1()
	time.Sleep(150 * time.Millisecond)
	if !e1.runner.hasWindow(taskID) {
		t.Fatal("服务停止不应杀掉专用 tmux window")
	}
	tk, err := st.GetTask(taskID)
	if err != nil || tk.Status != store.StatusRunning {
		t.Fatalf("服务停止后任务应保持 running: task=%+v err=%v", tk, err)
	}

	ctx2, stop2 := context.WithCancel(context.Background())
	defer stop2()
	e2 := newExecutor()
	e2.Start(ctx2)
	waitTaskStatus(t, st, taskID, store.StatusSucceeded, 5*time.Second)
	logs, err := st.ListLogs(taskID)
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, l := range logs {
		all.WriteString(l.Content)
		all.WriteByte('\n')
	}
	if got := all.String(); !strings.Contains(got, "before") || !strings.Contains(got, "after") {
		t.Fatalf("恢复后日志不完整: %q", got)
	}
	waitWindowGone(t, e2.runner, taskID, time.Second)
}

func TestExecutorDispatchesSameRoleUpToConfiguredConcurrency(t *testing.T) {
	if _, err := osexec.LookPath("tmux"); err != nil {
		t.Skip("tmux 未安装")
	}
	registry[tmuxConcurrencyTestCLI] = tmuxConcurrencyTestAdapter{}
	t.Cleanup(func() { delete(registry, tmuxConcurrencyTestCLI) })

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	workDir := t.TempDir()
	agentID, err := st.CreateAgent(store.Agent{
		Name: "parallel runner", CLI: tmuxConcurrencyTestCLI, Enabled: true, MaxConcurrency: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]int64, 0, 3)
	for i := 0; i < 3; i++ {
		id, err := st.CreateTask(store.Task{
			Title: fmt.Sprintf("parallel %d", i), Status: store.StatusQueued, Perm: store.PermFull,
			AgentID: &agentID, ProjectDir: workDir,
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}

	sessionsRoot := t.TempDir()
	socket := fmt.Sprintf("paihuo-concurrency-test-%d", os.Getpid())
	e := New(st, events.NewHub(), sessionsRoot, "concurrency-test.db")
	e.runner = newTmuxRunnerAt(sessionsRoot, socket)
	cleanupRunner := newTmuxRunnerAt(sessionsRoot, socket)
	t.Cleanup(func() { _ = cleanupRunner.command("kill-server") })
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	e.Start(ctx)
	e.Wake()

	waitTaskStatusCounts(t, st, 2, 1, 4*time.Second)
	// 先取消未启动的任务，避免释放槽位后它被下一轮调度接走。
	tasks, err := st.ListTasks()
	if err != nil {
		t.Fatal(err)
	}
	for _, tk := range tasks {
		if tk.Status == store.StatusQueued {
			if err := st.UpdateTask(tk.ID, map[string]any{"status": store.StatusCancelled}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, id := range ids {
		e.CancelTask(id)
	}
	for _, id := range ids {
		waitTaskStatus(t, st, id, store.StatusCancelled, 3*time.Second)
	}
}

func waitTaskStatusCounts(t *testing.T, st *store.Store, running, queued int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tasks, err := st.ListTasks()
		if err != nil {
			t.Fatal(err)
		}
		gotRunning, gotQueued := 0, 0
		for _, tk := range tasks {
			switch tk.Status {
			case store.StatusRunning:
				gotRunning++
			case store.StatusQueued:
				gotQueued++
			}
		}
		if gotRunning == running && gotQueued == queued {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	tasks, err := st.ListTasks()
	t.Fatalf("等待运行=%d 排队=%d 超时，得到 tasks=%+v err=%v", running, queued, tasks, err)
}

func waitTaskStatus(t *testing.T, st *store.Store, taskID int64, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tk, err := st.GetTask(taskID)
		if err != nil {
			t.Fatal(err)
		}
		if tk.Status == want {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	tk, err := st.GetTask(taskID)
	t.Fatalf("等待任务进入 %s 超时，得到 task=%+v err=%v", want, tk, err)
}

func waitRunningWindow(t *testing.T, st *store.Store, r *tmuxRunner, taskID int64, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tk, err := st.GetTask(taskID)
		if err != nil {
			t.Fatal(err)
		}
		if tk.Status == store.StatusRunning && r.hasWindow(taskID) {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	tk, err := st.GetTask(taskID)
	t.Fatalf("等待运行中的 tmux window 超时，得到 task=%+v err=%v", tk, err)
}

func waitWindowGone(t *testing.T, r *tmuxRunner, taskID int64, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !r.hasWindow(taskID) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("任务结算后应清理 tmux window task-%d", taskID)
}
