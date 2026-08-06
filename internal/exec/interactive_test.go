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

func TestPiAdapterInteractiveOmitsPrintFlag(t *testing.T) {
	a := &piAdapter{baseAdapter{id: "pi", name: "Pi Agent", bin: "pi"}}
	_, args, _, err := a.Build(RunOptions{
		Prompt:     "从这里开始交互",
		SessionDir: "/tmp/pi-session",
		RunMode:    store.RunModeInteractive,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args, "\x00"), "-p") {
		t.Fatalf("交互式 Pi 不应带 -p: %#v", args)
	}
	if got := args[len(args)-1]; got != "从这里开始交互" {
		t.Fatalf("初始消息应作为最后一个位置参数，得到 %#v", args)
	}

	_, batchArgs, _, err := a.Build(RunOptions{Prompt: "批处理"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(batchArgs, "\x00"), "-p") {
		t.Fatalf("默认 Pi 任务应保持 -p: %#v", batchArgs)
	}
}

func TestExecutorSendsLiteralInputToInteractiveTask(t *testing.T) {
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
	t.Cleanup(func() { _ = e.runner.command("kill-server") })
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
	t.Cleanup(func() { _ = e.runner.command("kill-server") })
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
		"#{window_width}x#{window_height}:#{window_size_option}").Output()
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%dx%d:manual", interactiveTerminalColumns, interactiveTerminalRows)
	if got := strings.TrimSpace(string(out)); got != want {
		t.Fatalf("交互终端尺寸不稳定: got %q want %q", got, want)
	}
}
