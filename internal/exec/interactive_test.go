package exec

import (
	"fmt"
	"os"
	osexec "os/exec"
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
	if _, err := osexec.LookPath("tmux"); err != nil {
		t.Skip("tmux 未安装")
	}
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
