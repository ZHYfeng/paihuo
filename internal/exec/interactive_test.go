package exec

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/store"
)

func TestAdaptersBuildNativeInteractiveCommands(t *testing.T) {
	type buildFunc func(RunOptions) (string, []string, []string, error)
	tests := []struct {
		name                 string
		build                buildFunc
		role                 store.RoleConfig
		interactiveRequired  []string
		interactiveForbidden []string
		batchRequired        []string
		batchForbidden       []string
	}{
		{
			name: "omp", build: (&ompAdapter{baseAdapter{id: "omp", name: "OMP", bin: "omp"}}).Build,
			interactiveForbidden: []string{"-p", "--no-pty"},
			batchRequired:        []string{"-p", "--no-pty"},
		},
		{
			name: "opencode", build: (&openCodeAdapter{baseAdapter{id: "opencode", name: "OpenCode", bin: "opencode"}}).Build,
			interactiveRequired: []string{"run", "--interactive", "--dir"},
			batchRequired:       []string{"run", "--dir"},
			batchForbidden:      []string{"--interactive"},
		},
		{
			name: "pi", build: (&piAdapter{baseAdapter{id: "pi", name: "Pi Agent", bin: "pi"}}).Build,
			interactiveForbidden: []string{"-p"},
			batchRequired:        []string{"-p"},
		},
		{
			name: "claude", build: (&claudeAdapter{baseAdapter{id: "claude", name: "Claude Code", bin: "claude"}}).Build,
			interactiveForbidden: []string{"-p"},
			batchRequired:        []string{"-p"},
		},
		{
			name: "codex", build: (&codexAdapter{baseAdapter{id: "codex", name: "Codex", bin: "codex"}}).Build,
			role:                 store.RoleConfig{Custom: map[string]string{"execution_mode": "yolo"}},
			interactiveRequired:  []string{"--dangerously-bypass-approvals-and-sandbox"},
			interactiveForbidden: []string{"exec", "--skip-git-repo-check", "code_mode_host"},
			batchRequired:        []string{"exec", "--skip-git-repo-check"},
			batchForbidden:       []string{"code_mode_host"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			const prompt = "从这里开始交互"
			_, args, _, err := tt.build(RunOptions{
				Dir: "/tmp/project", Prompt: prompt, SessionDir: "/tmp/agent-session",
				RunMode: store.RunModeInteractive, Role: tt.role,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(args) == 0 || args[len(args)-1] != prompt {
				t.Fatalf("交互初始消息应作为最后一个位置参数，得到 %#v", args)
			}
			for _, want := range tt.interactiveRequired {
				if !hasArg(args, want) {
					t.Fatalf("交互命令缺少参数 %q: %#v", want, args)
				}
			}
			for _, unwanted := range tt.interactiveForbidden {
				if hasArg(args, unwanted) {
					t.Fatalf("交互命令不应包含批处理参数 %q: %#v", unwanted, args)
				}
			}

			_, batchArgs, _, err := tt.build(RunOptions{
				Dir: "/tmp/project", Prompt: "批处理", SessionDir: "/tmp/agent-session", Role: tt.role,
			})
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tt.batchRequired {
				if !hasArg(batchArgs, want) {
					t.Fatalf("批处理命令缺少参数 %q: %#v", want, batchArgs)
				}
			}
			for _, unwanted := range tt.batchForbidden {
				if hasArg(batchArgs, unwanted) {
					t.Fatalf("批处理命令不应包含交互参数 %q: %#v", unwanted, batchArgs)
				}
			}
		})
	}
}

func hasArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func TestExecutorSendsLiteralInputToInteractiveTask(t *testing.T) {
	requireTmuxIntegration(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	// 使用非 Pi 角色覆盖通用交互输入校验；pane 本身由下面的测试 shell 提供。
	agentID, err := st.CreateAgent(store.Agent{Name: "codex", CLI: "codex", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{
		Title: "interactive", Status: store.StatusRunning, RunMode: store.RunModeInteractive, AgentID: &agentID,
	})
	if err != nil {
		t.Fatal(err)
	}

	sessionsRoot := t.TempDir()
	socket := fmt.Sprintf("paihuo-input-test-%d", os.Getpid())
	e := New(st, events.NewHub(), sessionsRoot, "input-test.db")
	e.runner = newTmuxRunnerAt(sessionsRoot, socket)
	_ = e.runner.command("kill-server")
	t.Cleanup(func() { stopTmuxServerAndClean(t, e.runner, sessionsRoot) })
	if err := e.runner.ensureSession(); err != nil {
		t.Fatal(err)
	}
	if err := e.runner.command("new-window", "-d", "-t", e.runner.session, "-n", e.runner.taskName(taskID), "--",
		"sh", "-c", `IFS= read -r line; printf 'received:%s\n' "$line"; sleep 1`); err != nil {
		t.Fatal(err)
	}

	input := `literal;$(not-a-command) & "quotes"`
	if err := e.SendInput(taskID, input); err != nil {
		t.Fatalf("SendInput: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	var output string
	for time.Now().Before(deadline) {
		out, err := osexec.Command("tmux", "-L", socket, "capture-pane", "-p", "-t", e.runner.target(taskID), "-S", "-20").Output()
		if err != nil {
			t.Fatal(err)
		}
		output = string(out)
		if strings.Contains(output, "received:"+input) {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !strings.Contains(output, "received:"+input) {
		t.Fatalf("pane 未收到完整字面输入: %q", output)
	}
	logs, err := st.ListLogs(taskID)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 || logs[0].Stream != "in" || logs[0].Content != input {
		t.Fatalf("输入应记录为 in 日志，得到 %+v", logs)
	}
}

func TestExecutorSendsRawKeystrokesToInteractiveTask(t *testing.T) {
	requireTmuxIntegration(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	agentID, err := st.CreateAgent(store.Agent{Name: "pi", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{
		Title: "interactive raw keys", Status: store.StatusRunning, RunMode: store.RunModeInteractive, AgentID: &agentID,
	})
	if err != nil {
		t.Fatal(err)
	}

	sessionsRoot := t.TempDir()
	socket := fmt.Sprintf("paihuo-raw-input-test-%d", os.Getpid())
	e := New(st, events.NewHub(), sessionsRoot, "raw-input-test.db")
	e.runner = newTmuxRunnerAt(sessionsRoot, socket)
	_ = e.runner.command("kill-server")
	t.Cleanup(func() { stopTmuxServerAndClean(t, e.runner, sessionsRoot) })
	if err := e.runner.ensureSession(); err != nil {
		t.Fatal(err)
	}

	expected := "/q\t\x1b[A\r"
	outputPath := filepath.Join(t.TempDir(), "keys.bin")
	readyPath := filepath.Join(t.TempDir(), "ready")
	script := fmt.Sprintf(`stty raw -echo; : > "$2"; dd bs=1 count=%d status=none of="$1"; sleep 1`, len(expected))
	if err := e.runner.command("new-window", "-d", "-t", e.runner.session, "-n", e.runner.taskName(taskID), "--",
		"sh", "-c", script, "sh", outputPath, readyPath); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(readyPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("测试 pane 未进入 raw 模式")
		}
		time.Sleep(25 * time.Millisecond)
	}

	if err := e.SendKeystrokes(taskID, "\x00"); err == nil || !strings.Contains(err.Error(), "NUL") {
		t.Fatalf("NUL 按键应被拒绝，得到 %v", err)
	}
	if err := e.SendKeystrokes(taskID, expected); err != nil {
		t.Fatalf("SendKeystrokes: %v", err)
	}
	deadline = time.Now().Add(2 * time.Second)
	var got []byte
	for time.Now().Before(deadline) {
		got, _ = os.ReadFile(outputPath)
		if len(got) == len(expected) {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if string(got) != expected {
		t.Fatalf("pane 收到的原始按键不符: got %q want %q", got, expected)
	}
	logs, err := st.ListLogs(taskID)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 0 {
		t.Fatalf("逐键输入不应污染任务日志，得到 %+v", logs)
	}
}

func TestInteractiveTmuxUsesStableGeometryAndExtendedKeys(t *testing.T) {
	requireTmuxIntegration(t)
	sessionsRoot := t.TempDir()
	socket := fmt.Sprintf("paihuo-interactive-geometry-test-%d", os.Getpid())
	runner := newTmuxRunnerAt(sessionsRoot, socket)
	_ = runner.command("kill-server")
	t.Cleanup(func() { _ = runner.command("kill-server") })

	if err := runner.ensureSession(); err != nil {
		t.Fatal(err)
	}
	out, err := osexec.Command("tmux", "-L", socket, "show-options", "-s", "-v", "extended-keys").Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(out)); got != "on" {
		t.Fatalf("专用 tmux 应开启 extended-keys，得到 %q", got)
	}

	const taskID = 91
	if err := runner.Start(taskID, sessionsRoot, "sh", []string{"-c", "sleep 5"}, nil, tmuxStartOptions{
		TerminalColumns: interactiveTerminalColumns,
		TerminalRows:    interactiveTerminalRows,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = runner.Stop(taskID)
		runner.Cleanup(taskID)
	})
	out, err = osexec.Command("tmux", "-L", socket, "display-message", "-p", "-t", runner.target(taskID),
		"#{window_width}x#{window_height}:#{window-size}").Output()
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%dx%d:manual", interactiveTerminalColumns, interactiveTerminalRows)
	if got := strings.TrimSpace(string(out)); got != want {
		t.Fatalf("交互终端尺寸不稳定: got %q want %q", got, want)
	}
}

// Resize 把浏览器 xterm 的尺寸同步到运行中的交互窗口；调整后窗口保持
// manual 模式且按新尺寸重绘（agent 收到 SIGWINCH）。
func TestInteractiveTmuxResizeFollowsBrowser(t *testing.T) {
	requireTmuxIntegration(t)
	sessionsRoot := t.TempDir()
	socket := fmt.Sprintf("paihuo-interactive-resize-test-%d", os.Getpid())
	runner := newTmuxRunnerAt(sessionsRoot, socket)
	_ = runner.command("kill-server")
	t.Cleanup(func() { _ = runner.command("kill-server") })

	if err := runner.ensureSession(); err != nil {
		t.Fatal(err)
	}
	const taskID = 92
	if err := runner.Start(taskID, sessionsRoot, "sh", []string{"-c", "sleep 5"}, nil, tmuxStartOptions{
		TerminalColumns: interactiveTerminalColumns,
		TerminalRows:    interactiveTerminalRows,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = runner.Stop(taskID)
		runner.Cleanup(taskID)
	})

	if err := runner.Resize(taskID, 132, 42); err != nil {
		t.Fatalf("Resize 失败: %v", err)
	}
	out, err := osexec.Command("tmux", "-L", socket, "display-message", "-p", "-t", runner.target(taskID),
		"#{window_width}x#{window_height}:#{window-size}").Output()
	if err != nil {
		t.Fatal(err)
	}
	if want := "132x42:manual"; strings.TrimSpace(string(out)) != want {
		t.Fatalf("Resize 后尺寸不正确: got %q want %q", strings.TrimSpace(string(out)), want)
	}
}

func TestExecutorResizeAcceptsObserved4KBrowserGeometry(t *testing.T) {
	requireTmuxIntegration(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	agentID, err := st.CreateAgent(store.Agent{Name: "4k-terminal", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{
		Title: "4k interactive", Status: store.StatusRunning,
		RunMode: store.RunModeInteractive, AgentID: &agentID,
	})
	if err != nil {
		t.Fatal(err)
	}

	sessionsRoot := t.TempDir()
	socket := fmt.Sprintf("paihuo-4k-resize-test-%d", os.Getpid())
	e := NewForTest(st, events.NewHub(), sessionsRoot, "4k-resize-test.db", socket)
	_ = e.runner.command("kill-server")
	t.Cleanup(func() { stopTmuxServerAndClean(t, e.runner, sessionsRoot) })
	if err := e.runner.Start(taskID, sessionsRoot, "/bin/sh", []string{"-c", "sleep 5"}, nil, tmuxStartOptions{
		TerminalColumns: interactiveTerminalColumns,
		TerminalRows:    interactiveTerminalRows,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.runner.Stop(taskID) })

	// 3840×2160 浏览器实测 FitAddon 会报告 435×103；不能因为固定上限而
	// 静默拒绝，否则 xterm 与 tmux 使用不同画布，TUI 就会错行和留白。
	if err := e.Resize(taskID, 435, 103); err != nil {
		t.Fatalf("4K 浏览器终端尺寸应被接受: %v", err)
	}
	tk, err := st.GetTask(taskID)
	if err != nil {
		t.Fatal(err)
	}
	if tk.TerminalCols != 435 || tk.TerminalRows != 103 {
		t.Fatalf("4K 尺寸未持久化: %dx%d", tk.TerminalCols, tk.TerminalRows)
	}
}

func TestExecutorSyncInteractiveOutputUsesRawTerminalStream(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	taskID, err := st.CreateTask(store.Task{
		Title: "raw terminal stream", Status: store.StatusRunning, RunMode: store.RunModeInteractive,
	})
	if err != nil {
		t.Fatal(err)
	}
	tk, err := st.GetTask(taskID)
	if err != nil {
		t.Fatal(err)
	}
	e := NewForTest(st, events.NewHub(), t.TempDir(), "raw-terminal-stream.db", "raw-terminal-stream-test")
	if err := e.syncTmuxOutput(tk, tmuxObservation{
		Lines: []string{"prompt>", "typed"}, Offset: 12, Alive: true,
	}); err != nil {
		t.Fatal(err)
	}
	logs, err := st.ListLogs(taskID)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 2 || logs[0].Stream != "term" || logs[0].Content != "prompt>" ||
		logs[1].Stream != "term" || logs[1].Content != "typed" {
		t.Fatalf("交互输出必须按原始 term 块持久化，得到 %+v", logs)
	}
	updated, err := st.GetTask(taskID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.TmuxLogOffset != 12 {
		t.Fatalf("原始终端 offset 未推进: %d", updated.TmuxLogOffset)
	}
}
