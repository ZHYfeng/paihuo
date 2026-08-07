package exec

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func requireTmuxIntegration(t *testing.T) string {
	t.Helper()
	if os.Getenv(taskNestedTmuxSkipEnv) == "1" {
		t.Skip("派活任务内跳过嵌套 tmux 集成测试；本地与 CI 仍完整执行")
	}
	bin, err := osexec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux 未安装")
	}
	return bin
}

func requireUserSystemdRun(t *testing.T) string {
	t.Helper()
	bin, err := osexec.LookPath("systemd-run")
	if err != nil {
		t.Skip("systemd-run 未安装")
	}
	if err := osexec.Command(bin, "--user", "--quiet", "--wait", "--collect", "/bin/true").Run(); err != nil {
		t.Skipf("当前环境无法创建 user systemd service: %v", err)
	}
	return bin
}

func TestTmuxRunnerPersistsOutputAndExit(t *testing.T) {
	bin := requireTmuxIntegration(t)
	sessionsRoot := t.TempDir()
	r := newTmuxRunnerAt(sessionsRoot, fmt.Sprintf("paihuo-test-%d", os.Getpid()))
	r.binary = bin
	// 测试 socket 仅由当前 Go 测试进程命名；清理不会触碰生产 paihuo socket。
	_ = r.command("kill-server")
	t.Cleanup(func() { _ = r.command("kill-server") })

	const taskID = int64(42)
	if err := r.Start(taskID, t.TempDir(), "/bin/sh", []string{
		"-c", `printf 'first\n'; printf 'arg=%s\n' "$1"; printf 'env=%s\n' "$PAIHUO_TMUX_TEST"; sleep 0.1; printf 'last'`,
		"probe", "quote'\nline",
	}, []string{"PAIHUO_TMUX_TEST=ok"}, tmuxStartOptions{}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// 模拟 paihuo 重启后的新 runner 实例：它能用同一个专用 socket 与日志目录
	// 接续观察，不依赖启动它的 Go 进程仍在。
	recovered := newTmuxRunnerAt(sessionsRoot, r.socket)
	recovered.binary = bin

	var offset int64
	var output []string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		obs, err := recovered.Poll(taskID, offset)
		if err != nil {
			t.Fatalf("Poll: %v", err)
		}
		output = append(output, obs.Lines...)
		offset = obs.Offset
		if obs.Done {
			if obs.ExitCode != 0 {
				t.Fatalf("ExitCode=%d", obs.ExitCode)
			}
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if got := strings.Join(output, "\n"); !strings.Contains(got, "first") || !strings.Contains(got, "arg=quote'") || !strings.Contains(got, "env=ok") || !strings.Contains(got, "last") {
		t.Fatalf("终端输出不完整: %q", got)
	}
	if !recovered.hasWindow(taskID) {
		t.Fatal("remain-on-exit 应保留已退出的 task window，供恢复方结算")
	}
	recovered.Cleanup(taskID)
	if recovered.hasWindow(taskID) {
		t.Fatal("Cleanup 后 task window 应被移除")
	}
}

func TestTmuxRunnerPollInteractiveStreamsInputEchoWithoutNewline(t *testing.T) {
	bin := requireTmuxIntegration(t)
	sessionsRoot := t.TempDir()
	r := newTmuxRunnerAt(sessionsRoot, fmt.Sprintf("paihuo-interactive-stream-test-%d", os.Getpid()))
	r.binary = bin
	_ = r.command("kill-server")
	t.Cleanup(func() { _ = r.command("kill-server") })

	const taskID = int64(43)
	if err := r.Start(taskID, sessionsRoot, "/bin/sh", []string{
		"-c", `printf 'prompt>'; IFS= read -r line; sleep 1`,
	}, nil, tmuxStartOptions{TerminalColumns: 80, TerminalRows: 24}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = r.Stop(taskID) })

	deadline := time.Now().Add(2 * time.Second)
	for {
		content, _ := os.ReadFile(r.logPath(taskID))
		if strings.Contains(string(content), "prompt>") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pane 未输出提示符，terminal.log=%q", content)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := r.SendKeystrokes(taskID, "typed"); err != nil {
		t.Fatalf("SendKeystrokes: %v", err)
	}

	var offset int64
	var output strings.Builder
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		obs, err := r.PollInteractive(taskID, offset)
		if err != nil {
			t.Fatalf("PollInteractive: %v", err)
		}
		for _, chunk := range obs.Lines {
			output.WriteString(chunk)
		}
		offset = obs.Offset
		if strings.Contains(output.String(), "prompt>typed") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(output.String(), "prompt>typed") {
		t.Fatalf("交互输入回显没有换行也应实时返回，got %q offset=%d", output.String(), offset)
	}
}

func TestTmuxRunnerInteractiveOutputKeepsSplitUTF8ForNextPoll(t *testing.T) {
	const taskID = int64(44)
	r := newTmuxRunnerAt(t.TempDir(), "utf8-tail-test")
	if err := os.MkdirAll(r.taskDir(taskID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.logPath(taskID), []byte{'A', 0xe4, 0xb8}, 0o600); err != nil {
		t.Fatal(err)
	}
	chunks, offset, err := r.readOutput(taskID, 0, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(chunks, ""); got != "A" || offset != 1 {
		t.Fatalf("不完整 UTF-8 尾部应留到下一轮: got=%q offset=%d", got, offset)
	}
	f, err := os.OpenFile(r.logPath(taskID), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte{0xad}); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	chunks, offset, err = r.readOutput(taskID, offset, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(chunks, ""); got != "中" || offset != 4 {
		t.Fatalf("补全后的 UTF-8 应原样输出: got=%q offset=%d", got, offset)
	}
}

func TestTmuxRunnerDoesNotPrefixMatchAnotherTaskWindow(t *testing.T) {
	bin := requireTmuxIntegration(t)
	r := newTmuxRunnerAt(t.TempDir(), fmt.Sprintf("paihuo-exact-window-test-%d", os.Getpid()))
	r.binary = bin
	_ = r.command("kill-server")
	t.Cleanup(func() { _ = r.command("kill-server") })

	if err := r.ensureSession(); err != nil {
		t.Fatalf("ensureSession: %v", err)
	}
	if err := r.command("new-window", "-d", "-t", r.session, "-n", r.taskName(133), "--", "sleep", "30"); err != nil {
		t.Fatalf("create task-133 window: %v", err)
	}

	if r.hasWindow(1) {
		t.Fatal("task 1 不存在时，不能把 ph-task-133 的唯一前缀匹配当成 task 1")
	}
	if err := r.Stop(1); err != nil {
		t.Fatalf("Stop(1): %v", err)
	}
	if !r.hasWindow(133) {
		t.Fatal("停止不存在的 task 1 不能删除 task 133 的窗口")
	}
}

// Poll 的第一次退出码读取和随后检查 pane 是否存在之间，run.sh 可能恰好写完
// exit-code 并退出。此处用一个伪 tmux 在 list-panes 时写入退出码，稳定覆盖
// 这一真实时序，避免把已成功完成的短任务误判为 pane 丢失。
func TestTmuxRunnerPollRechecksExitCodeAfterWindowDisappears(t *testing.T) {
	const taskID = int64(42)
	r := newTmuxRunnerAt(t.TempDir(), "poll-exit-race-test")
	if err := os.MkdirAll(r.taskDir(taskID), 0o700); err != nil {
		t.Fatal(err)
	}

	fakeTmux := filepath.Join(t.TempDir(), "tmux")
	script := "#!/bin/sh\n" +
		"for arg in \"$@\"; do\n" +
		"  if [ \"$arg\" = list-panes ]; then\n" +
		"    printf '0\\n' > " + shQuote(r.exitPath(taskID)) + "\n" +
		"    exit 1\n" +
		"  fi\n" +
		"done\n" +
		"exit 1\n"
	if err := os.WriteFile(fakeTmux, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	r.binary = fakeTmux

	obs, err := r.Poll(taskID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !obs.Done || obs.ExitCode != 0 {
		t.Fatalf("pane 消失后新写入的退出码应被本轮轮询接收，obs=%+v", obs)
	}
}

func TestTmuxRunnerIgnoresUserConfig(t *testing.T) {
	bin := requireTmuxIntegration(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, ".tmux.conf"), []byte("set -g @paihuo_config_isolation_test loaded\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	r := newTmuxRunnerAt(t.TempDir(), fmt.Sprintf("paihuo-config-test-%d", os.Getpid()))
	r.binary = bin
	_ = r.command("kill-server")
	t.Cleanup(func() { _ = r.command("kill-server") })
	if err := r.ensureSession(); err != nil {
		t.Fatalf("ensureSession: %v", err)
	}

	out, err := osexec.Command(bin, "-L", r.socket, "show-options", "-gqv", "@paihuo_config_isolation_test").Output()
	if err != nil {
		t.Fatalf("读取专用 tmux 配置: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "" {
		t.Fatalf("专用 tmux 不应加载用户 ~/.tmux.conf，得到 %q", got)
	}
}

func TestTmuxRunnerTaskTmuxWrapperIgnoresUserConfig(t *testing.T) {
	bin := requireTmuxIntegration(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, ".tmux.conf"), []byte("set -g @paihuo_task_wrapper_test loaded\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	r := newTmuxRunnerAt(t.TempDir(), fmt.Sprintf("paihuo-wrapper-parent-test-%d", os.Getpid()))
	r.binary = bin
	_ = r.command("kill-server")
	t.Cleanup(func() { _ = r.command("kill-server") })
	nestedSocket := fmt.Sprintf("paihuo-wrapper-child-test-%d", os.Getpid())
	t.Cleanup(func() {
		_ = osexec.Command(bin, "-f", tmuxConfigFile, "-L", nestedSocket, "kill-server").Run()
	})
	if err := r.Start(42, t.TempDir(), "/bin/bash", []string{
		"-lc",
		`test -z "$TMUX" && test -z "$TMUX_PANE" && tmux -L "$1" new-session -d -s nested -- sleep 2147483647; created=$?; option="$(tmux -L "$1" show-options -gqv @paihuo_task_wrapper_test)"; shown=$?; tmux -L "$1" kill-server; stopped=$?; test "$created" -eq 0 && test "$shown" -eq 0 && test "$stopped" -eq 0 && test -z "$option" && printf 'nested config clean\n'`,
		"wrapper-test", nestedSocket,
	}, os.Environ(), tmuxStartOptions{}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	var offset int64
	var output []string
	finished := false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		obs, err := r.Poll(42, offset)
		if err != nil {
			t.Fatalf("Poll: %v", err)
		}
		output = append(output, obs.Lines...)
		offset = obs.Offset
		if obs.Done {
			if obs.ExitCode != 0 {
				t.Fatalf("ExitCode=%d output=%q", obs.ExitCode, output)
			}
			finished = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !finished || !strings.Contains(strings.Join(output, "\n"), "nested config clean") {
		t.Fatalf("任务内 tmux 包装器未隔离用户配置，output=%q", output)
	}
	if err := osexec.Command(bin, "-f", tmuxConfigFile, "-L", nestedSocket, "has-session", "-t", "nested").Run(); err == nil {
		t.Fatal("任务内 cleanup 应只销毁嵌套 tmux server")
	}
}

func TestTmuxRunnerIsolatesBatchAgentProcessGroup(t *testing.T) {
	bin := requireTmuxIntegration(t)
	if _, err := osexec.LookPath("setsid"); err != nil {
		t.Skip("setsid 未安装")
	}
	r := newTmuxRunnerAt(t.TempDir(), fmt.Sprintf("paihuo-setsid-test-%d", os.Getpid()))
	r.binary = bin
	_ = r.command("kill-server")
	t.Cleanup(func() { _ = r.command("kill-server") })

	// 模拟 agent 错误地杀掉自身所属进程组。未隔离时这会带走 run.sh，导致
	// task window 消失却没有 exit-code；隔离后 setsid 只返回 137 给 run.sh。
	if err := r.Start(42, t.TempDir(), "/bin/sh", []string{
		"-c", "kill -KILL -$$",
	}, os.Environ(), tmuxStartOptions{IsolateProcessGroup: true}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		obs, err := r.Poll(42, 0)
		if err != nil {
			t.Fatalf("Poll: %v", err)
		}
		if !obs.Done {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if obs.ExitCode != 137 {
			t.Fatalf("ExitCode=%d，want 137", obs.ExitCode)
		}
		if !r.hasWindow(42) {
			t.Fatal("隔离后的 run.sh 应写入退出码并保留 task window")
		}
		return
	}
	t.Fatal("等待隔离任务结束超时")
}

func TestTmuxRunnerDetachesCodexBatchTerminal(t *testing.T) {
	bin := requireTmuxIntegration(t)
	if _, err := osexec.LookPath("setsid"); err != nil {
		t.Skip("setsid 未安装")
	}
	if _, err := osexec.LookPath("tail"); err != nil {
		t.Skip("tail 未安装")
	}
	requireUserSystemdRun(t)
	r := newTmuxRunnerAt(t.TempDir(), fmt.Sprintf("paihuo-detach-test-%d", os.Getpid()))
	r.binary = bin
	_ = r.command("kill-server")
	t.Cleanup(func() { _ = r.command("kill-server") })
	workdir := t.TempDir()
	probe := `test ! -t 0 && test ! -t 1 && test ! -t 2 || exit 1
test "$PAIHUO_TMUX_ENV_TEST" = ok || exit 2
test "$` + taskNestedTmuxSkipEnv + `" = 1 || exit 3
test "$BASH_ENV" = ` + shQuote(r.shellInitPath(42)) + ` || exit 4
test "$(command -v tmux)" = ` + shQuote(r.tmuxWrapperPath(42)) + ` || exit 5
test "$PWD" = ` + shQuote(workdir) + ` || exit 6
printf 'detached agent output\n'
printf 'pwd=%s\n' "$PWD"
cat /proc/self/cgroup`

	// 这个断言正好覆盖 Codex 的故障边界：agent 的 stdin/stdout/stderr 都不能
	// 指向 paihuo task pane 的 pty，但输出仍必须实时回到 terminal.log。
	if err := r.Start(42, workdir, "/bin/sh", []string{
		"-c", probe,
	}, []string{"PAIHUO_TMUX_ENV_TEST=ok", "PWD=/wrong-parent-directory"}, tmuxStartOptions{IsolateProcessGroup: true, DetachTerminal: true, IsolateCgroup: true}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	var offset int64
	var output []string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		obs, err := r.Poll(42, offset)
		if err != nil {
			t.Fatalf("Poll: %v", err)
		}
		output = append(output, obs.Lines...)
		offset = obs.Offset
		if !obs.Done {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if obs.ExitCode != 0 {
			t.Fatalf("ExitCode=%d output=%q", obs.ExitCode, output)
		}
		if !strings.Contains(strings.Join(output, "\n"), "detached agent output") {
			t.Fatalf("agent 输出未转发到 terminal.log: %q", output)
		}
		raw, err := os.ReadFile(r.agentOutputPath(42))
		if err != nil || !strings.Contains(string(raw), "detached agent output") {
			t.Fatalf("agent 原始输出不完整: %q err=%v", raw, err)
		}
		if !strings.Contains(string(raw), "pwd="+workdir) {
			t.Fatalf("agent 未在任务工作目录执行: %q", raw)
		}
		envSource, err := os.ReadFile(r.agentEnvPath(42))
		if err != nil {
			t.Fatalf("读取 agent 环境文件: %v", err)
		}
		if strings.Contains(string(envSource), "export PWD=") {
			t.Fatalf("agent 环境不应继承父进程 PWD: %q", envSource)
		}
		outer, err := os.ReadFile(r.runnerCgroupPath(42))
		if err != nil {
			t.Fatalf("读取 pane cgroup: %v", err)
		}
		var agentCgroup string
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "0::") {
				agentCgroup = strings.TrimSpace(line)
				break
			}
		}
		if agentCgroup == "" {
			t.Fatalf("未在 agent 输出中找到 cgroup: %q", raw)
		}
		if agentCgroup == strings.TrimSpace(string(outer)) {
			t.Fatalf("agent 与 pane 不应共享 cgroup: %q", agentCgroup)
		}
		return
	}
	t.Fatal("等待脱离终端的 batch 任务结束超时")
}

func TestTmuxRunnerDetachedAgentSurvivesLostPane(t *testing.T) {
	bin := requireTmuxIntegration(t)
	if _, err := osexec.LookPath("setsid"); err != nil {
		t.Skip("setsid 未安装")
	}
	if _, err := osexec.LookPath("tail"); err != nil {
		t.Skip("tail 未安装")
	}
	requireUserSystemdRun(t)
	r := newTmuxRunnerAt(t.TempDir(), fmt.Sprintf("paihuo-lost-pane-test-%d", os.Getpid()))
	r.binary = bin
	_ = r.command("kill-server")
	t.Cleanup(func() {
		r.Cleanup(42)
		_ = r.command("kill-server")
	})
	if err := r.Start(42, t.TempDir(), "/bin/sh", []string{
		"-c", "sleep 1; printf 'agent finished after pane loss\\n'",
	}, nil, tmuxStartOptions{IsolateProcessGroup: true, DetachTerminal: true, IsolateCgroup: true}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if r.agentServiceAlive(42) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !r.agentServiceAlive(42) {
		t.Fatalf("等待 agent service %s 启动超时", r.agentUnitName(42))
	}
	// 精确模拟最棘手的生产故障：日志 pane 已不在，但独立 agent service
	// 仍在运行。执行器必须继续等待它，而不是立刻 Stop service 并把任务记失败。
	if err := r.command("kill-window", "-t", r.target(42)); err != nil {
		t.Fatalf("kill task pane: %v", err)
	}
	obs, err := r.Poll(42, 0)
	if err != nil {
		t.Fatalf("Poll after pane loss: %v", err)
	}
	if !obs.Alive || obs.Done {
		t.Fatalf("pane 丢失后运行中的 agent 应继续存活，obs=%+v", obs)
	}

	var offset int64
	var output []string
	for time.Now().Before(deadline) {
		obs, err := r.Poll(42, offset)
		if err != nil {
			t.Fatalf("Poll: %v", err)
		}
		output = append(output, obs.Lines...)
		offset = obs.Offset
		if !obs.Done {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if obs.ExitCode != 0 {
			t.Fatalf("ExitCode=%d output=%q", obs.ExitCode, output)
		}
		if !strings.Contains(strings.Join(output, "\n"), "agent finished after pane loss") {
			t.Fatalf("pane 丢失后未从 agent 原始输出收集日志: %q", output)
		}
		if _, err := os.Stat(r.agentExitPath(42)); err != nil {
			t.Fatalf("agent 应写回独立退出码: %v", err)
		}
		return
	}
	t.Fatal("等待 pane 丢失后的 agent 结算超时")
}

func TestTmuxRunnerStopTerminatesIsolatedAgentService(t *testing.T) {
	bin := requireTmuxIntegration(t)
	if _, err := osexec.LookPath("setsid"); err != nil {
		t.Skip("setsid 未安装")
	}
	if _, err := osexec.LookPath("tail"); err != nil {
		t.Skip("tail 未安装")
	}
	requireUserSystemdRun(t)
	systemctl, err := osexec.LookPath("systemctl")
	if err != nil {
		t.Skip("systemctl 未安装")
	}
	r := newTmuxRunnerAt(t.TempDir(), fmt.Sprintf("paihuo-stop-service-test-%d", os.Getpid()))
	r.binary = bin
	_ = r.command("kill-server")
	t.Cleanup(func() {
		r.Cleanup(42)
		_ = r.command("kill-server")
	})
	if err := r.Start(42, t.TempDir(), "/bin/sh", []string{
		"-c", "sleep 2147483647",
	}, nil, tmuxStartOptions{IsolateProcessGroup: true, DetachTerminal: true, IsolateCgroup: true}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if osexec.Command(systemctl, "--user", "is-active", "--quiet", r.agentUnitName(42)).Run() == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if osexec.Command(systemctl, "--user", "is-active", "--quiet", r.agentUnitName(42)).Run() != nil {
		t.Fatalf("等待 agent service %s 启动超时", r.agentUnitName(42))
	}
	if err := r.Stop(42); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if osexec.Command(systemctl, "--user", "is-active", "--quiet", r.agentUnitName(42)).Run() == nil {
		t.Fatalf("Stop 后 agent service %s 仍在运行", r.agentUnitName(42))
	}
}

func TestTmuxRunnerArchivesFailureArtifacts(t *testing.T) {
	r := newTmuxRunnerAt(t.TempDir(), "paihuo-archive-test")
	const taskID = int64(42)
	if err := os.MkdirAll(r.taskDir(taskID), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"terminal.log":     "partial output\n",
		"agent-output.log": "raw agent output\n",
		"agent-exit-code":  "137\n",
		"runner-cgroup":    "0::/test.scope\n",
		"run.sh":           "#!/bin/sh\n",
		"start":            "start\n",
	} {
		if err := os.WriteFile(filepath.Join(r.taskDir(taskID), name), []byte(want), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(r.lifecyclePath(taskID), []byte("started\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive, err := r.ArchiveFailureArtifacts(taskID, "window vanished")
	if err != nil {
		t.Fatalf("ArchiveFailureArtifacts: %v", err)
	}
	for name, want := range map[string]string{
		"terminal.log":     "partial output\n",
		"agent-output.log": "raw agent output\n",
		"agent-exit-code":  "137\n",
		"runner-cgroup":    "0::/test.scope\n",
		"run.sh":           "#!/bin/sh\n",
		"start":            "start\n",
		"reason.txt":       "window vanished\n",
	} {
		got, err := os.ReadFile(filepath.Join(archive, name))
		if err != nil || string(got) != want {
			t.Fatalf("归档文件 %s = %q err=%v，want %q", name, got, err, want)
		}
	}
	events, err := os.ReadFile(filepath.Join(archive, "runner-events.log"))
	if err != nil || !strings.Contains(string(events), "started\n") || !strings.Contains(string(events), "event=failure_archive_started") {
		t.Fatalf("归档缺少生命周期审计: %q err=%v", events, err)
	}
	if _, err := os.Stat(r.logPath(taskID)); !os.IsNotExist(err) {
		t.Fatalf("归档后当前 terminal.log 应不存在，err=%v", err)
	}
	if code, found, err := r.archivedAgentExitCode(taskID); err != nil || !found || code != 137 {
		t.Fatalf("归档 agent 退出码 = (%d, %v, %v), want (137, true, nil)", code, found, err)
	}
	r.Cleanup(taskID)
	if _, err := os.Stat(r.taskDir(taskID)); !os.IsNotExist(err) {
		t.Fatalf("清理任务后归档也应删除，err=%v", err)
	}
}

func TestIsTmuxInternalEnv(t *testing.T) {
	for _, key := range []string{"TMUX", "TMUX_PANE"} {
		if !isTmuxInternalEnv(key) {
			t.Fatalf("%s 应视为 tmux 内部环境变量", key)
		}
	}
	for _, key := range []string{"PATH", "TERM", "PAIHUO_TOKEN"} {
		if isTmuxInternalEnv(key) {
			t.Fatalf("%s 不应被过滤", key)
		}
	}
}
