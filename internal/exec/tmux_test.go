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

func TestTmuxRunnerPersistsOutputAndExit(t *testing.T) {
	bin, err := osexec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux 未安装")
	}
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
	}, []string{"PAIHUO_TMUX_TEST=ok"}); err != nil {
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

func TestTmuxRunnerIgnoresUserConfig(t *testing.T) {
	bin, err := osexec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux 未安装")
	}
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
	bin, err := osexec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux 未安装")
	}
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
		`tmux -L "$1" new-session -d -s nested -- sleep 2147483647; created=$?; option="$(tmux -L "$1" show-options -gqv @paihuo_task_wrapper_test)"; shown=$?; tmux -L "$1" kill-server; stopped=$?; test "$created" -eq 0 && test "$shown" -eq 0 && test "$stopped" -eq 0 && test -z "$option" && printf 'nested config clean\n'`,
		"wrapper-test", nestedSocket,
	}, os.Environ()); err != nil {
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
}

func TestTmuxRunnerArchivesFailureArtifacts(t *testing.T) {
	r := newTmuxRunnerAt(t.TempDir(), "paihuo-archive-test")
	const taskID = int64(42)
	if err := os.MkdirAll(r.taskDir(taskID), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"terminal.log": "partial output\n",
		"run.sh":       "#!/bin/sh\n",
		"start":        "start\n",
	} {
		if err := os.WriteFile(filepath.Join(r.taskDir(taskID), name), []byte(want), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	archive, err := r.ArchiveFailureArtifacts(taskID, "window vanished")
	if err != nil {
		t.Fatalf("ArchiveFailureArtifacts: %v", err)
	}
	for name, want := range map[string]string{
		"terminal.log": "partial output\n",
		"run.sh":       "#!/bin/sh\n",
		"start":        "start\n",
		"reason.txt":   "window vanished\n",
	} {
		got, err := os.ReadFile(filepath.Join(archive, name))
		if err != nil || string(got) != want {
			t.Fatalf("归档文件 %s = %q err=%v，want %q", name, got, err, want)
		}
	}
	if _, err := os.Stat(r.logPath(taskID)); !os.IsNotExist(err) {
		t.Fatalf("归档后当前 terminal.log 应不存在，err=%v", err)
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
