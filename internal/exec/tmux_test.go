package exec

import (
	"fmt"
	"os"
	osexec "os/exec"
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
