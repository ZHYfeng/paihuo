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

func TestExecutorQueuesMergeTaskAfterSuccessfulFullTask(t *testing.T) {
	requireTmuxIntegration(t)
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
	children, err := st.ListChildren(taskID)
	if err != nil || len(children) != 1 {
		t.Fatalf("普通任务完成后应创建一个代码合并任务: %+v err=%v", children, err)
	}
	merge := children[0]
	if merge.MergeOf == nil || *merge.MergeOf != taskID || merge.Perm != store.PermFull {
		t.Fatalf("自动创建的合并任务配置错误: %+v", merge)
	}
	waitTaskStatus(t, st, merge.ID, store.StatusSucceeded, 5*time.Second)
	got, err := os.ReadFile(filepath.Join(projectDir, "auto-merged.txt"))
	if err != nil || string(got) != "merged\n" {
		t.Fatalf("代码合并任务产出未进入主分支: %q err=%v", got, err)
	}
	if nested, err := st.ListChildren(merge.ID); err != nil || len(nested) != 0 {
		t.Fatalf("合并任务不应递归创建合并任务: %+v err=%v", nested, err)
	}
}

func TestExecutorReconcilesCompletedGitTaskWithoutMerge(t *testing.T) {
	projectDir := initExecutorGitProject(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	agentID, err := st.CreateAgent(store.Agent{Name: "reconciler", CLI: tmuxAutoMergeTestCLI, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projectDir, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := st.CreateTask(store.Task{
		Title: "completed before merge handoff", Status: store.StatusSucceeded, Perm: store.PermFull,
		AgentID: &agentID, ProjectID: &projectID, ProjectDir: projectDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	sessionsRoot := t.TempDir()
	source, err := st.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	dir, branch, base, err := workspace.Ensure(*source, sessionsRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTask(sourceID, map[string]any{"worktree_branch": branch, "base_commit": base}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "reconcile.txt"), []byte("reconciled\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	e := New(st, events.NewHub(), sessionsRoot, "reconcile-merge-test.db")
	e.reconcileMergeTasks()
	children, err := st.ListChildren(sourceID)
	if err != nil || len(children) != 1 {
		t.Fatalf("对账后应创建唯一合并任务: %+v err=%v", children, err)
	}
	if children[0].MergeOf == nil || *children[0].MergeOf != sourceID || children[0].Status != store.StatusQueued {
		t.Fatalf("对账创建的合并任务配置错误: %+v", children[0])
	}
	status := osexec.Command("git", "status", "--porcelain")
	status.Dir = dir
	if out, err := status.CombinedOutput(); err != nil || strings.TrimSpace(string(out)) != "" {
		t.Fatalf("对账前应保存源 worktree: out=%q err=%v", out, err)
	}

	// 周期扫描可重复执行，不会再创建一个 child。
	e.reconcileMergeTasks()
	children, err = st.ListChildren(sourceID)
	if err != nil || len(children) != 1 {
		t.Fatalf("重复对账不应创建第二个合并任务: %+v err=%v", children, err)
	}
}

func TestExecutorKeepsCompletedSourceWhenMergeChildAlreadyExists(t *testing.T) {
	projectDir := initExecutorGitProject(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	agentID, err := st.CreateAgent(store.Agent{Name: "handoff", CLI: tmuxAutoMergeTestCLI, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projectDir, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := st.CreateTask(store.Task{
		Title: "already handed off", Status: store.StatusRunning, Perm: store.PermFull,
		AgentID: &agentID, ProjectID: &projectID, ProjectDir: projectDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	sessionsRoot := t.TempDir()
	source, err := st.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	dir, branch, base, err := workspace.Ensure(*source, sessionsRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTask(sourceID, map[string]any{"worktree_branch": branch, "base_commit": base}); err != nil {
		t.Fatal(err)
	}
	source, err = st.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "handoff.txt"), []byte("done\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateTask(store.NewMergeTask(*source)); err != nil {
		t.Fatal(err)
	}

	e := New(st, events.NewHub(), sessionsRoot, "handoff-merge-test.db")
	e.finishRun(*source, 0, nil, false)
	completed, err := st.GetTask(sourceID)
	if err != nil || completed.Status != store.StatusSucceeded {
		t.Fatalf("已有 child 的成功源任务不能被误记失败: %+v err=%v", completed, err)
	}
	children, err := st.ListChildren(sourceID)
	if err != nil || len(children) != 1 {
		t.Fatalf("已有合并任务必须保持唯一: %+v err=%v", children, err)
	}
}

// 生产中曾出现过：tmux 日志 pane 先消失，独立 Codex agent 随后才写入成功
// 退出码。即使 systemd 已确认 agent 进入 inactive，pane 也不是 agent 的
// 结果来源；执行器必须给持久退出码足够的结算窗口。
func TestExecutorWaitsForDelayedDetachedExitCodeAfterConfirmedAgentEnd(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	taskID, err := st.CreateTask(store.Task{Title: "late detached result", Status: store.StatusRunning})
	if err != nil {
		t.Fatal(err)
	}

	sessionsRoot := t.TempDir()
	e := New(st, events.NewHub(), sessionsRoot, "late-detached-result-test.db")
	r := newTmuxRunnerAt(sessionsRoot, fmt.Sprintf("paihuo-missing-pane-%d", os.Getpid()))
	e.runner = r
	if err := os.MkdirAll(r.taskDir(taskID), 0o700); err != nil {
		t.Fatal(err)
	}
	// agent-output.log 是 Codex 已迁入独立 service 的持久标记；这里故意不
	// 创建 tmux window，模拟 pane 已丢失且 systemd 正在收尾的极短窗口。
	if err := os.WriteFile(r.agentOutputPath(taskID), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	fakeBin := t.TempDir()
	if err := os.WriteFile(filepath.Join(fakeBin, "systemctl"), []byte("#!/bin/sh\nprintf 'inactive\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fakeBin+":"+os.Getenv("PATH"))
	if err := os.WriteFile(r.agentUnitPath(taskID), []byte(r.agentUnitName(taskID)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	resultWriteErr := make(chan error, 1)
	go func() {
		time.Sleep(4 * time.Second)
		resultWriteErr <- writeTestAgentExitCode(r.agentExitPath(taskID), 0)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	code, err := e.waitTmux(ctx, ctx, &store.Task{ID: taskID})
	if writeErr := <-resultWriteErr; writeErr != nil {
		t.Fatalf("写入 agent 退出码失败: %v", writeErr)
	}
	if err != nil {
		t.Fatalf("延迟写回 agent 退出码不应被误判为 pane 丢失: %v", err)
	}
	if code != 0 {
		t.Fatalf("code=%d, want 0", code)
	}
}

// systemctl 的一次查询失败不能把仍在输出的独立 agent 当作已经结束。这个场景
// 覆盖 pane 丢失后 service 状态暂时 unknown、但 agent 仍持续运行超过旧 3 秒
// 结算窗口的情况；最终的持久退出码仍必须被正常接收。
func TestExecutorKeepsWatchingUnknownDetachedAgentWithOutputHeartbeat(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	taskID, err := st.CreateTask(store.Task{Title: "unknown detached agent", Status: store.StatusRunning})
	if err != nil {
		t.Fatal(err)
	}

	sessionsRoot := t.TempDir()
	e := New(st, events.NewHub(), sessionsRoot, "unknown-detached-result-test.db")
	r := newTmuxRunnerAt(sessionsRoot, fmt.Sprintf("paihuo-unknown-pane-%d", os.Getpid()))
	e.runner = r
	if err := os.MkdirAll(r.taskDir(taskID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.agentOutputPath(taskID), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	// 使用会失败的 systemctl 模拟 D-Bus/systemd 查询暂不可用，而非伪造
	// agent 尚未启动；agent-unit 本身仍存在，正是生产中的观测失败形态。
	fakeBin := t.TempDir()
	if err := os.WriteFile(filepath.Join(fakeBin, "systemctl"), []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fakeBin+":"+os.Getenv("PATH"))
	if err := os.WriteFile(r.agentUnitPath(taskID), []byte(r.agentUnitName(taskID)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	stopOutput := make(chan struct{})
	writerErr := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopOutput:
				return
			case <-ticker.C:
				f, err := os.OpenFile(r.agentOutputPath(taskID), os.O_WRONLY|os.O_APPEND, 0o600)
				if err != nil {
					writerErr <- err
					return
				}
				_, writeErr := f.WriteString(".")
				closeErr := f.Close()
				if writeErr != nil {
					writerErr <- writeErr
					return
				}
				if closeErr != nil {
					writerErr <- closeErr
					return
				}
			}
		}
	}()
	resultWritten := make(chan struct{})
	resultWriteErr := make(chan error, 1)
	go func() {
		defer close(resultWritten)
		time.Sleep(4 * time.Second)
		resultWriteErr <- writeTestAgentExitCode(r.agentExitPath(taskID), 0)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	code, waitErr := e.waitTmux(ctx, ctx, &store.Task{ID: taskID})
	<-resultWritten
	close(stopOutput)
	if err := <-resultWriteErr; err != nil {
		t.Fatalf("写入 agent 退出码失败: %v", err)
	}
	select {
	case err := <-writerErr:
		t.Fatalf("写入 agent 心跳失败: %v", err)
	default:
	}
	if waitErr != nil {
		t.Fatalf("状态未知但 agent 输出仍在增长时不应在旧结算窗口失败: %v", waitErr)
	}
	if code != 0 {
		t.Fatalf("code=%d, want 0", code)
	}
}

func writeTestAgentExitCode(path string, code int) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(fmt.Sprintf("%d\n", code)), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func TestExecutorRecoversArchivedSuccessfulLostTaskIntoMerge(t *testing.T) {
	projectDir := initExecutorGitProject(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	agentID, err := st.CreateAgent(store.Agent{Name: "recovery", CLI: tmuxAutoMergeTestCLI, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projectDir, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := st.CreateTask(store.Task{
		Title: "archived successful task", Status: store.StatusFailed, Perm: store.PermFull,
		AgentID: &agentID, ProjectID: &projectID, ProjectDir: projectDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := st.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	sessionsRoot := t.TempDir()
	sourceDir, branch, base, err := workspace.Ensure(*source, sessionsRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "recovered.txt"), []byte("recovered\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTask(sourceID, map[string]any{
		"worktree_branch": branch,
		"base_commit":     base,
		"exit_code":       -1,
		"error":           tmuxWindowLostError{taskID: sourceID}.Error(),
	}); err != nil {
		t.Fatal(err)
	}

	e := New(st, events.NewHub(), sessionsRoot, "recover-lost-result-test.db")
	archive := filepath.Join(e.runner.taskDir(sourceID), "failure-20260806T000000.000000000Z")
	if err := os.MkdirAll(archive, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(archive, "agent-exit-code"), []byte("0\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	e.recoverLostCompletions()

	recovered, err := st.GetTask(sourceID)
	if err != nil || recovered.Status != store.StatusSucceeded || recovered.ExitCode == nil || *recovered.ExitCode != 0 || recovered.Error != "" {
		t.Fatalf("归档成功结果应恢复源任务: %+v err=%v", recovered, err)
	}
	children, err := st.ListChildren(sourceID)
	if err != nil || len(children) != 1 {
		t.Fatalf("恢复后应创建唯一合并任务: %+v err=%v", children, err)
	}
	if children[0].MergeOf == nil || *children[0].MergeOf != sourceID || children[0].Status != store.StatusQueued {
		t.Fatalf("恢复创建的合并任务不正确: %+v", children[0])
	}
	if _, err := os.Stat(filepath.Join(sourceDir, "recovered.txt")); err != nil {
		t.Fatalf("恢复不应丢失源任务工作区: %v", err)
	}
}

func TestExecutorPreparesAndAutoMergesReviewMergeTask(t *testing.T) {
	requireTmuxIntegration(t)
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
	requireTmuxIntegration(t)
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
	requireTmuxIntegration(t)
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
