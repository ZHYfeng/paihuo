package exec

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// tmuxRunner 把 tmux 的 server、window、pipe-pane、退出码文件和日志偏移
// 收敛在一个模块中。执行器只需启动、轮询和停止任务，不需要了解 tmux 命令细节。
//
// 所有任务共用一个专用 server/socket（tmux -L paihuo）与一个 paihuo session；
// 每个活动任务占用一个名为 task-<id> 的 window。不会接管用户的默认 tmux server。
type tmuxRunner struct {
	mu      sync.Mutex
	binary  string
	socket  string
	session string
	root    string
}

type tmuxObservation struct {
	Lines    []string
	Offset   int64
	Alive    bool
	Done     bool
	ExitCode int
}

func newTmuxRunner(sessionsRoot string) *tmuxRunner {
	return newTmuxRunnerAt(sessionsRoot, "paihuo")
}

// newTmuxRunnerAt 供测试创建独立 socket；生产仅使用固定 paihuo socket。
func newTmuxRunnerAt(sessionsRoot, socket string) *tmuxRunner {
	return &tmuxRunner{
		binary:  "tmux",
		socket:  socket,
		session: "paihuo",
		root:    filepath.Join(sessionsRoot, ".tmux"),
	}
}

func (r *tmuxRunner) taskName(taskID int64) string {
	return fmt.Sprintf("task-%d", taskID)
}

func (r *tmuxRunner) target(taskID int64) string {
	return r.session + ":" + r.taskName(taskID)
}

func (r *tmuxRunner) taskDir(taskID int64) string {
	return filepath.Join(r.root, r.taskName(taskID))
}

func (r *tmuxRunner) logPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "terminal.log")
}

func (r *tmuxRunner) exitPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "exit-code")
}

func (r *tmuxRunner) gatePath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "start")
}

func (r *tmuxRunner) scriptPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "run.sh")
}

func (r *tmuxRunner) ensureSession() error {
	if _, err := osexec.LookPath(r.binary); err != nil {
		return fmt.Errorf("未找到 tmux；专用任务执行器需要安装 tmux: %w", err)
	}
	if r.hasSession() {
		return nil
	}
	if err := os.MkdirAll(r.root, 0o700); err != nil {
		return fmt.Errorf("创建 tmux 运行目录失败: %w", err)
	}
	if err := os.Chmod(r.root, 0o700); err != nil {
		return fmt.Errorf("设置 tmux 运行目录权限失败: %w", err)
	}
	// control window 是该专用 session 的唯一常驻 pane。活动任务 window 会在
	// 结束后删除，control window 保证 server/session 不会因为暂时没有任务而消失。
	return r.command("new-session", "-d", "-s", r.session, "-n", "control", "-c", r.root, "--", "sleep", "2147483647")
}

func (r *tmuxRunner) hasSession() bool {
	cmd := osexec.Command(r.binary, "-L", r.socket, "has-session", "-t", r.session)
	return cmd.Run() == nil
}

func (r *tmuxRunner) hasWindow(taskID int64) bool {
	cmd := osexec.Command(r.binary, "-L", r.socket, "list-panes", "-t", r.target(taskID), "-F", "#{pane_id}")
	return cmd.Run() == nil
}

func (r *tmuxRunner) paneDead(taskID int64) (bool, error) {
	cmd := osexec.Command(r.binary, "-L", r.socket, "display-message", "-p", "-t", r.target(taskID), "#{pane_dead}")
	out, err := cmd.Output()
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(out)) == "1", nil
}

// Start 创建一个暂停在 gate 文件前的 task window，先接好 pipe-pane 再放行，
// 从而不会遗漏启动瞬间的终端输出。
func (r *tmuxRunner) Start(taskID int64, dir, bin string, args, env []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ensureSession(); err != nil {
		return err
	}
	if err := r.Stop(taskID); err != nil {
		return err
	}

	taskDir := r.taskDir(taskID)
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		return fmt.Errorf("创建任务 tmux 目录失败: %w", err)
	}
	if err := os.Chmod(taskDir, 0o700); err != nil {
		return fmt.Errorf("设置任务 tmux 目录权限失败: %w", err)
	}
	for _, path := range []string{r.exitPath(taskID), r.gatePath(taskID)} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("重置 tmux 任务状态失败: %w", err)
		}
	}
	if err := os.WriteFile(r.logPath(taskID), nil, 0o600); err != nil {
		return fmt.Errorf("创建 tmux 终端日志失败: %w", err)
	}
	if err := r.writeScript(taskID, bin, args); err != nil {
		return err
	}

	// tmux 的 -e 给 window 注入角色执行环境，避免把密钥写入 run.sh。
	cmdArgs := []string{"new-window", "-d", "-t", r.session, "-n", r.taskName(taskID), "-c", dir}
	for _, item := range env {
		if key, _, ok := strings.Cut(item, "="); ok && key != "" && !isTmuxInternalEnv(key) {
			cmdArgs = append(cmdArgs, "-e", item)
		}
	}
	cmdArgs = append(cmdArgs, "--", r.scriptPath(taskID))
	if err := r.command(cmdArgs...); err != nil {
		return err
	}
	if err := r.command("set-window-option", "-t", r.target(taskID), "remain-on-exit", "on"); err != nil {
		_ = r.Stop(taskID)
		return err
	}
	// pipe-pane 由 tmux 托管；即使 paihuo 进程崩溃，输出仍会进入磁盘文件，
	// 下次启动时可按数据库偏移继续补收。
	pipeCmd := "cat >> " + shQuote(r.logPath(taskID))
	if err := r.command("pipe-pane", "-o", "-t", r.target(taskID), pipeCmd); err != nil {
		_ = r.Stop(taskID)
		return err
	}
	if err := os.WriteFile(r.gatePath(taskID), []byte("start\n"), 0o600); err != nil {
		_ = r.Stop(taskID)
		return fmt.Errorf("启动 tmux 任务失败: %w", err)
	}
	return nil
}

// isTmuxInternalEnv 排除父 tmux 注入的连接信息。paihuo 可能本身在用户的
// tmux 中启动，但专用 server 的 pane 必须使用自己的 TMUX/TMUX_PANE，不能继承
// 父会话的 socket 或 pane ID。
func isTmuxInternalEnv(key string) bool {
	return key == "TMUX" || key == "TMUX_PANE"
}

func (r *tmuxRunner) writeScript(taskID int64, bin string, args []string) error {
	command := append([]string{bin}, args...)
	quoted := make([]string, 0, len(command))
	for _, arg := range command {
		quoted = append(quoted, shQuote(arg))
	}
	// POSIX sh 只负责等待 gate、执行精确 argv、写退出码；实际参数均由安全
	// 单引号编码，支持空格、引号和换行，不依赖用户 shell 的历史或配置。
	src := "#!/bin/sh\n" +
		"while [ ! -f " + shQuote(r.gatePath(taskID)) + " ]; do sleep 0.05; done\n" +
		strings.Join(quoted, " ") + "\n" +
		"status=$?\n" +
		"printf '%s\\n' \"$status\" > " + shQuote(r.exitPath(taskID)) + "\n" +
		"exit \"$status\"\n"
	if err := os.WriteFile(r.scriptPath(taskID), []byte(src), 0o700); err != nil {
		return fmt.Errorf("写入 tmux 任务脚本失败: %w", err)
	}
	return nil
}

// Poll 返回自 offset 之后已完整写入的终端行、下一个安全偏移及任务结束状态。
// 未换行的尾部会等到下一次轮询，避免在持久化日志中产生重复或截断行。
func (r *tmuxRunner) Poll(taskID, offset int64) (tmuxObservation, error) {
	code, done, err := r.exitCode(taskID)
	if err != nil {
		return tmuxObservation{}, err
	}
	alive := r.hasWindow(taskID)
	if done && alive {
		dead, err := r.paneDead(taskID)
		if err != nil {
			return tmuxObservation{}, fmt.Errorf("读取 tmux pane 状态失败: %w", err)
		}
		done = dead
	}
	lines, next, err := r.readLines(taskID, offset, done)
	if err != nil {
		return tmuxObservation{}, err
	}
	obs := tmuxObservation{Lines: lines, Offset: next, Done: done, ExitCode: code, Alive: alive}
	if done {
		return obs, nil
	}
	return obs, nil
}

func (r *tmuxRunner) exitCode(taskID int64) (int, bool, error) {
	b, err := os.ReadFile(r.exitPath(taskID))
	if errors.Is(err, os.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("读取 tmux 退出码失败: %w", err)
	}
	code, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0, false, fmt.Errorf("tmux 退出码非法: %w", err)
	}
	return code, true, nil
}

func (r *tmuxRunner) readLines(taskID, offset int64, flushTail bool) ([]string, int64, error) {
	f, err := os.Open(r.logPath(taskID))
	if errors.Is(err, os.ErrNotExist) {
		return nil, offset, nil
	}
	if err != nil {
		return nil, offset, fmt.Errorf("读取 tmux 终端日志失败: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, offset, err
	}
	if offset > info.Size() {
		// 新一轮重试在同一 task ID 下会截断日志；调用方已经把 offset 复位，
		// 这里仍防御崩溃恰好发生在截断与写库之间的窗口。
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, offset, err
	}

	reader := bufio.NewReaderSize(f, 64*1024)
	next := offset
	var lines []string
	for {
		line, readErr := reader.ReadString('\n')
		if len(line) > 0 && (readErr == nil || flushTail) {
			next += int64(len(line))
			line = strings.TrimSuffix(line, "\n")
			line = strings.TrimSuffix(line, "\r")
			lines = append(lines, line)
		}
		if readErr == nil {
			continue
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		return nil, offset, fmt.Errorf("读取 tmux 终端日志失败: %w", readErr)
	}
	return lines, next, nil
}

func (r *tmuxRunner) Stop(taskID int64) error {
	if !r.hasWindow(taskID) {
		return nil
	}
	return r.command("kill-window", "-t", r.target(taskID))
}

// Cleanup 只清理该任务的 window 与运行时文件；control window / 专用 server 会保留。
func (r *tmuxRunner) Cleanup(taskID int64) {
	_ = r.Stop(taskID)
	_ = os.RemoveAll(r.taskDir(taskID))
}

func (r *tmuxRunner) command(args ...string) error {
	cmd := osexec.Command(r.binary, append([]string{"-L", r.socket}, args...)...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	msg := strings.TrimSpace(string(out))
	if msg == "" {
		return fmt.Errorf("tmux 操作失败: %w", err)
	}
	return fmt.Errorf("tmux 操作失败: %w: %s", err, msg)
}

// shQuote 返回可嵌入 POSIX sh 脚本的单个精确参数；NUL 本就不能存在于 argv。
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}
