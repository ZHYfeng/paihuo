package exec

import (
	"context"
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"testing"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/store"
)

const tmuxExecutorTestCLI = "tmux-executor-test"

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
