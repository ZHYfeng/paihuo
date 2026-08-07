package exec

import (
	"bufio"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// tmuxRunner 把 tmux 的 server、window、pipe-pane、退出码文件和日志偏移
// 收敛在一个模块中。执行器只需启动、轮询和停止任务，不需要了解 tmux 命令细节。
//
// 所有任务共用一个专用 server/socket（tmux -f /dev/null -L paihuo）与一个 paihuo
// session；每个活动任务占用一个名为 task-<id> 的 window。不会接管用户的默认
// tmux server，也绝不能读取用户 ~/.tmux.conf 中的恢复插件或 hook。
type tmuxRunner struct {
	mu            sync.Mutex
	lifecycleMu   sync.Mutex
	lifecycleSeen map[int64]map[string]struct{}
	binary        string
	socket        string
	session       string
	root          string
}

// tmuxConfigFile 让专用 server 不加载用户全局配置。paihuo 任务 window 的生命周期
// 必须只由执行器管理，不能受 tmux-resurrect、tmux-continuum 等用户插件影响。
const tmuxConfigFile = "/dev/null"

// taskNestedTmuxSkipEnv 仅在派活任务进程内设置。tmux 集成测试会再创建多个
// tmux server/pane；在任务本身已运行于 tmux pane 时，systemd scope 会相互竞争。
// 常规本地与 CI 测试不设置它，仍完整覆盖这些集成场景。
const taskNestedTmuxSkipEnv = "PAIHUO_SKIP_NESTED_TMUX_TESTS"

// tmuxStartOptions 描述任务命令与承载它的 tmux pane 之间的隔离边界。
// 只有 Codex 的 batch 模式会脱离 pane TTY：其 unified exec 在收尾工具进程时
// 会操作 stdio 所属的进程组，不能让它看到 paihuo 的 pane 终端。
type tmuxStartOptions struct {
	IsolateProcessGroup bool
	DetachTerminal      bool
	IsolateCgroup       bool
	TerminalColumns     int
	TerminalRows        int
}

const (
	// 交互式 TUI 会把光标位置和分隔线写入输出流。固定 pane 画布后，浏览器可按
	// 同一尺寸重放控制序列；否则 tmux attach 或浏览器宽度变化会破坏画面。
	interactiveTerminalColumns = 80
	interactiveTerminalRows    = 24
)

type tmuxObservation struct {
	Lines               []string
	Offset              int64
	Alive               bool
	Done                bool
	ExitCode            int
	DetachedAgent       bool
	AgentState          agentServiceState
	AgentOutputSize     int64
	AwaitingAgentResult bool
}

// agentServiceState 描述独立 Codex agent transient service 的生命周期。tmux
// pane 只是日志转发与等待层，agent service 才是实际代码执行者；尤其在
// deactivating 阶段，agent wrapper 仍可能正在原子写入 agent-exit-code。
type agentServiceState string

const (
	agentServiceUnknown      agentServiceState = "unknown"
	agentServiceActivating   agentServiceState = "activating"
	agentServiceActive       agentServiceState = "active"
	agentServiceDeactivating agentServiceState = "deactivating"
	agentServiceInactive     agentServiceState = "inactive"
)

func (s agentServiceState) isExecutingOrFinalizing() bool {
	return s == agentServiceActivating || s == agentServiceActive || s == agentServiceDeactivating
}

func newTmuxRunner(sessionsRoot string) *tmuxRunner {
	return newTmuxRunnerAt(sessionsRoot, "paihuo")
}

// newTmuxRunnerAt 供测试创建独立 socket；生产仅使用固定 paihuo socket。
func newTmuxRunnerAt(sessionsRoot, socket string) *tmuxRunner {
	return &tmuxRunner{
		binary:        "tmux",
		socket:        socket,
		session:       "paihuo",
		root:          filepath.Join(sessionsRoot, ".tmux"),
		lifecycleSeen: make(map[int64]map[string]struct{}),
	}
}

func (r *tmuxRunner) taskName(taskID int64) string {
	// 带 ph- 前缀：tmux 对窗口名做唯一前缀匹配，外部命令（如
	// `kill-window -t paihuo:task-1`）会因 task-1 是 task-116 的前缀而误杀
	// 任务窗口；加前缀后这类输入不再匹配任何任务窗口（只会报错或命中
	// 无害的 control 回退）。
	return fmt.Sprintf("ph-task-%d", taskID)
}

func (r *tmuxRunner) target(taskID int64) string {
	return r.session + ":" + r.taskName(taskID)
}

func (r *tmuxRunner) taskDir(taskID int64) string {
	// 运行目录保持 task-<ID>：与历史任务目录/归档兼容（删除任务时按此清理）。
	return filepath.Join(r.root, fmt.Sprintf("task-%d", taskID))
}

// skillManifestPath 保存角色技能副本的清单。它位于任务运行目录而不是
// Git worktree，服务重启后仍可据此在最终结算时清理临时技能文件。
func (r *tmuxRunner) skillManifestPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "role-skills.json")
}

func (r *tmuxRunner) logPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "terminal.log")
}

func (r *tmuxRunner) exitPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "exit-code")
}

// agentExitPath 是从 tmux pane 迁出的 Codex agent 自己写回的退出码。它和
// run.sh 的 exit-code 分开保存：即使 pane 被异常关闭，独立 systemd service
// 仍能把实际结果交回执行器，不能把一个已完成的任务误判为 window 丢失。
func (r *tmuxRunner) agentExitPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "agent-exit-code")
}

func (r *tmuxRunner) gatePath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "start")
}

func (r *tmuxRunner) scriptPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "run.sh")
}

func (r *tmuxRunner) agentOutputPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "agent-output.log")
}

func (r *tmuxRunner) runnerCgroupPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "runner-cgroup")
}

// lifecyclePath 是 task 专属的执行器审计轨迹。它只记录 tmux/service 生命周期
// 与派活自身发起的停止动作，不记录角色环境或命令参数，避免把密钥写入诊断文件。
func (r *tmuxRunner) lifecyclePath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "runner-events.log")
}

func (r *tmuxRunner) agentUnitPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "agent-unit")
}

func (r *tmuxRunner) agentEnvPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "agent.env")
}

func (r *tmuxRunner) agentLaunchPath(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "agent-launch.sh")
}

// agentUnitName 是按运行根目录和 task ID 推导的稳定 unit 名。稳定名称让取消、
// 重试与服务恢复都能精确停止对应的 transient service，又避免不同 paihuo 实例
// 的 task ID 相撞。
func (r *tmuxRunner) agentUnitName(taskID int64) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(r.root))
	return fmt.Sprintf("paihuo-%08x-task-%d-agent", h.Sum32(), taskID)
}

func (r *tmuxRunner) taskBinDir(taskID int64) string {
	return filepath.Join(r.taskDir(taskID), "bin")
}

func (r *tmuxRunner) tmuxWrapperPath(taskID int64) string {
	return filepath.Join(r.taskBinDir(taskID), "tmux")
}

func (r *tmuxRunner) shellInitPath(taskID int64) string {
	return filepath.Join(r.taskBinDir(taskID), "shell-init.sh")
}

func (r *tmuxRunner) resetLifecycle(taskID int64) {
	r.lifecycleMu.Lock()
	delete(r.lifecycleSeen, taskID)
	r.lifecycleMu.Unlock()
}

func (r *tmuxRunner) recordLifecycle(taskID int64, event, detail string) {
	if strings.ContainsAny(event, "\r\n") {
		return
	}
	detail = strings.NewReplacer("\r", " ", "\n", " ").Replace(strings.TrimSpace(detail))
	f, err := os.OpenFile(r.lifecyclePath(taskID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return // 审计不能反过来阻止任务执行或故障归档。
	}
	defer f.Close()
	_, _ = fmt.Fprintf(f, "%s event=%s %s\n", time.Now().UTC().Format(time.RFC3339Nano), event, detail)
}

func (r *tmuxRunner) recordLifecycleOnce(taskID int64, event, detail string) {
	r.lifecycleMu.Lock()
	seen := r.lifecycleSeen[taskID]
	if seen == nil {
		seen = make(map[string]struct{})
		r.lifecycleSeen[taskID] = seen
	}
	if _, ok := seen[event]; ok {
		r.lifecycleMu.Unlock()
		return
	}
	seen[event] = struct{}{}
	r.lifecycleMu.Unlock()
	r.recordLifecycle(taskID, event, detail)
}

func (r *tmuxRunner) sessionWindowSnapshot() string {
	out, err := osexec.Command(r.binary, r.commandArgs("list-windows", "-t", r.session, "-F", "#{window_id}:#{window_name}:panes=#{window_panes}:dead=#{pane_dead}")...).Output()
	if err != nil {
		return "unavailable"
	}
	text := strings.ReplaceAll(strings.TrimSpace(string(out)), "\n", ";")
	if len(text) > 768 {
		return text[:768]
	}
	return text
}

func (r *tmuxRunner) ensureSession() error {
	if _, err := osexec.LookPath(r.binary); err != nil {
		return fmt.Errorf("未找到 tmux；专用任务执行器需要安装 tmux: %w", err)
	}
	if !r.hasSession() {
		if err := os.MkdirAll(r.root, 0o700); err != nil {
			return fmt.Errorf("创建 tmux 运行目录失败: %w", err)
		}
		if err := os.Chmod(r.root, 0o700); err != nil {
			return fmt.Errorf("设置 tmux 运行目录权限失败: %w", err)
		}
		// control window 是该专用 session 的唯一常驻 pane。活动任务 window 会在
		// 结束后删除，control window 保证 server/session 不会因为暂时没有任务而消失。
		if err := r.command("new-session", "-d", "-s", r.session, "-n", "control", "-c", r.root, "--", "sleep", "2147483647"); err != nil {
			return err
		}
	}
	// 专用 server 明确不读取用户 tmux.conf，因此 TUI 需要的扩展按键能力必须
	// 由 PaiHuo 自己开启；否则每个交互会话都会显示警告，组合键也可能失效。
	return r.command("set-option", "-s", "extended-keys", "on")
}

func (r *tmuxRunner) hasSession() bool {
	cmd := osexec.Command(r.binary, r.commandArgs("has-session", "-t", r.session)...)
	return cmd.Run() == nil
}

func (r *tmuxRunner) hasWindow(taskID int64) bool {
	cmd := osexec.Command(r.binary, r.commandArgs("list-panes", "-t", r.target(taskID), "-F", "#{pane_id}")...)
	return cmd.Run() == nil
}

func (r *tmuxRunner) paneDead(taskID int64) (bool, error) {
	cmd := osexec.Command(r.binary, r.commandArgs("display-message", "-p", "-t", r.target(taskID), "#{pane_dead}")...)
	out, err := cmd.Output()
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(out)) == "1", nil
}

// Start 创建一个暂停在 gate 文件前的 task window，先接好 pipe-pane 再放行，
// 从而不会遗漏启动瞬间的终端输出。
//
// batch 任务可把 agent 放到独立 session。若 CLI 在结束工具子进程时向其进程组
// 发送信号，run.sh 仍能写入 exit-code；交互式任务则保留原进程组，以维持终端
// 会话语义。Codex 另会按选项脱离 pane TTY，避免它的工具收尾误操作 pane。
func (r *tmuxRunner) Start(taskID int64, dir, bin string, args, env []string, options tmuxStartOptions) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ensureSession(); err != nil {
		return err
	}
	if err := r.stopLocked(taskID, "start_reset"); err != nil {
		return err
	}

	taskDir := r.taskDir(taskID)
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		return fmt.Errorf("创建任务 tmux 目录失败: %w", err)
	}
	if err := os.Chmod(taskDir, 0o700); err != nil {
		return fmt.Errorf("设置任务 tmux 目录权限失败: %w", err)
	}
	r.resetLifecycle(taskID)
	for _, path := range []string{r.exitPath(taskID), r.agentExitPath(taskID), r.gatePath(taskID), r.agentOutputPath(taskID), r.runnerCgroupPath(taskID), r.lifecyclePath(taskID), r.agentUnitPath(taskID), r.agentEnvPath(taskID), r.agentLaunchPath(taskID)} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("重置 tmux 任务状态失败: %w", err)
		}
	}
	r.recordLifecycle(taskID, "start_prepare", "target="+r.target(taskID))
	if err := os.WriteFile(r.logPath(taskID), nil, 0o600); err != nil {
		return fmt.Errorf("创建 tmux 终端日志失败: %w", err)
	}
	if options.DetachTerminal {
		if err := os.WriteFile(r.agentOutputPath(taskID), nil, 0o600); err != nil {
			return fmt.Errorf("创建 agent 原始输出日志失败: %w", err)
		}
	}
	if _, err := r.writeTmuxWrapper(taskID); err != nil {
		return err
	}
	taskEnv := r.taskShellEnvironment(taskID, env)
	if err := r.writeScript(taskID, dir, bin, args, taskEnv, options); err != nil {
		return err
	}
	if options.IsolateCgroup {
		if err := os.WriteFile(r.agentUnitPath(taskID), []byte(r.agentUnitName(taskID)+"\n"), 0o600); err != nil {
			return fmt.Errorf("记录 Codex agent service 失败: %w", err)
		}
	}
	// tmux 的 -e 给 window 注入角色执行环境，避免把密钥写入 run.sh。
	cmdArgs := []string{"new-window", "-d", "-t", r.session, "-n", r.taskName(taskID), "-c", dir}
	for _, item := range taskEnv {
		if key, _, ok := strings.Cut(item, "="); ok && key != "" && !isTmuxInternalEnv(key) {
			cmdArgs = append(cmdArgs, "-e", item)
		}
	}
	cmdArgs = append(cmdArgs, "--", r.scriptPath(taskID))
	if err := r.command(cmdArgs...); err != nil {
		return err
	}
	// 任务窗口创建后立即切回 control：tmux 对不存在的 target（如外部误用
	// `kill-window -t paihuo:task-1`）会回退到「会话当前窗口」，不能让任务
	// 窗口成为回退目标而被误杀。paihuo 自身的命令都带显式 target，不受影响。
	_ = r.command("select-window", "-t", r.session+":control")
	r.recordLifecycle(taskID, "window_created", "target="+r.target(taskID))
	if options.TerminalColumns > 0 && options.TerminalRows > 0 {
		if err := r.command("set-window-option", "-t", r.target(taskID), "window-size", "manual"); err != nil {
			_ = r.stopLocked(taskID, "start_failed")
			return fmt.Errorf("固定交互终端尺寸失败: %w", err)
		}
		if err := r.command("resize-window", "-t", r.target(taskID), "-x", strconv.Itoa(options.TerminalColumns), "-y", strconv.Itoa(options.TerminalRows)); err != nil {
			_ = r.stopLocked(taskID, "start_failed")
			return fmt.Errorf("调整交互终端尺寸失败: %w", err)
		}
	}
	if err := r.command("set-window-option", "-t", r.target(taskID), "remain-on-exit", "on"); err != nil {
		_ = r.stopLocked(taskID, "start_failed")
		return err
	}
	// pipe-pane 由 tmux 托管；即使 paihuo 进程崩溃，输出仍会进入磁盘文件，
	// 下次启动时可按数据库偏移继续补收。
	pipeCmd := "cat >> " + shQuote(r.logPath(taskID))
	if err := r.command("pipe-pane", "-o", "-t", r.target(taskID), pipeCmd); err != nil {
		_ = r.stopLocked(taskID, "start_failed")
		return err
	}
	r.recordLifecycle(taskID, "output_pipe_ready", "source=agent-output.log")
	if err := os.WriteFile(r.gatePath(taskID), []byte("start\n"), 0o600); err != nil {
		_ = r.stopLocked(taskID, "start_failed")
		return fmt.Errorf("启动 tmux 任务失败: %w", err)
	}
	r.recordLifecycle(taskID, "start_released", "gate=start")
	return nil
}

// taskShellEnvironment 让 Codex 等 agent 通过 `bash -lc` 执行工具时也保留
// task bin。login shell 会重置 PATH，因此仅在 run.sh 中 export PATH 不够；
// BASH_ENV 在非交互 bash（包括 bash -lc）读取 profile 后执行。
func (r *tmuxRunner) taskShellEnvironment(taskID int64, env []string) []string {
	taskEnv := make([]string, 0, len(env)+1)
	for _, item := range env {
		key, _, ok := strings.Cut(item, "=")
		if ok && (key == "BASH_ENV" || key == taskNestedTmuxSkipEnv) {
			continue
		}
		taskEnv = append(taskEnv, item)
	}
	return append(taskEnv,
		"BASH_ENV="+r.shellInitPath(taskID),
		taskNestedTmuxSkipEnv+"=1",
	)
}

func (r *tmuxRunner) writeTmuxWrapper(taskID int64) (string, error) {
	realBinary, err := osexec.LookPath(r.binary)
	if err != nil {
		return "", fmt.Errorf("定位 tmux 可执行文件失败: %w", err)
	}
	wrapperDir := r.taskBinDir(taskID)
	if err := os.MkdirAll(wrapperDir, 0o700); err != nil {
		return "", fmt.Errorf("创建任务 tmux 包装目录失败: %w", err)
	}
	if err := os.Chmod(wrapperDir, 0o700); err != nil {
		return "", fmt.Errorf("设置任务 tmux 包装目录权限失败: %w", err)
	}
	// 使用真实二进制的绝对路径，避免包装器通过 PATH 再次解析到自身。PATH
	// 由 run.sh 和 BASH_ENV 显式导出；tmux 的 new-window -e 不会可靠地覆盖 PATH。
	script := "#!/bin/sh\nexec " + shQuote(realBinary) + " -f " + shQuote(tmuxConfigFile) + " \"$@\"\n"
	if err := os.WriteFile(r.tmuxWrapperPath(taskID), []byte(script), 0o700); err != nil {
		return "", fmt.Errorf("写入任务 tmux 包装器失败: %w", err)
	}
	shellInit := "export PATH=" + shQuote(wrapperDir) + ":\"$PATH\"\n"
	if err := os.WriteFile(r.shellInitPath(taskID), []byte(shellInit), 0o600); err != nil {
		return "", fmt.Errorf("写入任务 shell 初始化文件失败: %w", err)
	}
	return wrapperDir, nil
}

// isTmuxInternalEnv 排除父 tmux 注入的连接信息。paihuo 可能本身在用户的
// tmux 中启动，但专用 server 的 pane 必须使用自己的 TMUX/TMUX_PANE，不能继承
// 父会话的 socket 或 pane ID。
func isTmuxInternalEnv(key string) bool {
	return key == "TMUX" || key == "TMUX_PANE"
}

func isShellEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i := 0; i < len(key); i++ {
		ch := key[i]
		if ch == '_' || ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || i > 0 && ch >= '0' && ch <= '9' {
			continue
		}
		return false
	}
	return true
}

// isTaskDerivedEnvKey 是由父 shell / systemd 注入、不能跨执行边界复用的变量。
// 尤其 PWD 必须由 tmux -c 和 systemd-run --working-directory 各自重建，不能
// 让 paihuo 服务自身的工作目录覆盖 agent 的真实 task worktree。
func isTaskDerivedEnvKey(key string) bool {
	switch key {
	case "PWD", "OLDPWD", "SHLVL", "_", "MANAGERPID", "INVOCATION_ID", "JOURNAL_STREAM", "MEMORY_PRESSURE_WATCH", "MEMORY_PRESSURE_WRITE", "SYSTEMD_EXEC_PID":
		return true
	default:
		return false
	}
}

// writeAgentLaunchFiles 把 task 专属环境放在 0600 文件中，而不是 systemd-run
// 的 argv。后者会暴露在同用户的进程列表里，不能承载角色配置中的密钥。
func (r *tmuxRunner) writeAgentLaunchFiles(taskID int64, invocation string, env []string) error {
	var source strings.Builder
	source.WriteString("# 仅供本 task 的 systemd agent service 读取。\n")
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if !ok || isTmuxInternalEnv(key) || isTaskDerivedEnvKey(key) {
			continue
		}
		if !isShellEnvKey(key) {
			return fmt.Errorf("环境变量名无法安全传给 Codex service: %q", key)
		}
		source.WriteString("export ")
		source.WriteString(key)
		source.WriteString("=")
		source.WriteString(shQuote(value))
		source.WriteString("\n")
	}
	// systemd service 不继承 tmux pane 的 PATH/TMUX。这里重建 task wrapper
	// PATH，令 Codex 的 bash -lc 继续使用 BASH_ENV 中的干净 tmux 包装器。
	source.WriteString("unset TMUX TMUX_PANE\n")
	source.WriteString("export PATH=")
	source.WriteString(shQuote(r.taskBinDir(taskID)))
	source.WriteString(":\"$PATH\"\n")
	if err := os.WriteFile(r.agentEnvPath(taskID), []byte(source.String()), 0o600); err != nil {
		return fmt.Errorf("写入 Codex agent 环境失败: %w", err)
	}
	// 不能 exec setsid：它虽能隔离 Codex 的进程组，却会让唯一能写回退出码的
	// shell 也消失。保留一层很小的 service wrapper，在 Codex 自然退出或收到
	// 可捕获的终止信号后原子写入 agent-exit-code；tmux pane 即使先丢失，任务
	// 仍可由这个结果正确结算。
	launch := "#!/bin/sh\n. " + shQuote(r.agentEnvPath(taskID)) + "\n" +
		"agent_exit=" + shQuote(r.agentExitPath(taskID)) + "\n" +
		"write_agent_exit() { tmp=\"$agent_exit.tmp.$$\"; printf '%s\\n' \"$1\" > \"$tmp\" && mv -f \"$tmp\" \"$agent_exit\"; }\n" +
		"trap 'write_agent_exit 129; exit 129' HUP\n" +
		"trap 'write_agent_exit 130; exit 130' INT\n" +
		"trap 'write_agent_exit 143; exit 143' TERM\n" +
		invocation + "\n" +
		"status=$?\n" +
		"write_agent_exit \"$status\"\n" +
		"exit \"$status\"\n"
	if err := os.WriteFile(r.agentLaunchPath(taskID), []byte(launch), 0o700); err != nil {
		_ = os.Remove(r.agentEnvPath(taskID))
		return fmt.Errorf("写入 Codex agent 启动脚本失败: %w", err)
	}
	return nil
}

func (r *tmuxRunner) writeScript(taskID int64, dir, bin string, args, taskEnv []string, options tmuxStartOptions) error {
	if options.IsolateCgroup && !options.DetachTerminal {
		return errors.New("cgroup 隔离需要同时脱离终端，以便可靠保存 agent 输出")
	}
	command := append([]string{bin}, args...)
	quoted := make([]string, 0, len(command))
	for _, arg := range command {
		quoted = append(quoted, shQuote(arg))
	}
	invocation := strings.Join(quoted, " ")
	if options.IsolateProcessGroup {
		setsid, err := osexec.LookPath("setsid")
		if err != nil {
			return fmt.Errorf("未找到 setsid；batch 任务需要独立进程组以保留退出码: %w", err)
		}
		// --wait 让 setsid 返回 agent 的真实退出状态；否则 run.sh 会过早写出
		// 成功，-- 则避免 agent 可执行文件被解释为 setsid 的选项。
		invocation = shQuote(setsid) + " --wait -- " + invocation
	}
	if options.IsolateCgroup {
		systemdRun, err := osexec.LookPath("systemd-run")
		if err != nil {
			return fmt.Errorf("未找到 systemd-run；Codex batch 任务需要独立 cgroup: %w", err)
		}
		if err := r.writeAgentLaunchFiles(taskID, invocation, taskEnv); err != nil {
			return err
		}
		output := r.agentOutputPath(taskID)
		// systemd-run service 是 tmux pane scope 的同级 cgroup。即使 Codex 的
		// unified exec 终止自己的 cgroup，run.sh 和 pipe-pane 也不会被波及。
		// 标准流由 user manager 直接追加到文件；外层 tail 再将其转发给终端。
		invocation = shQuote(systemdRun) + " --user --quiet --wait --collect" +
			" --unit=" + shQuote(r.agentUnitName(taskID)) +
			" --working-directory=" + shQuote(dir) +
			" --property=" + shQuote("StandardInput=null") +
			" --property=" + shQuote("StandardOutput=append:"+output) +
			" --property=" + shQuote("StandardError=append:"+output) +
			" -- " + shQuote(r.agentLaunchPath(taskID))
	}
	execution := invocation + "\n" +
		"status=$?\n"
	if options.DetachTerminal {
		tail, err := osexec.LookPath("tail")
		if err != nil {
			return fmt.Errorf("未找到 tail；Codex batch 任务无法安全转发终端输出: %w", err)
		}
		// Codex 的 unified exec 会在工具退出时终止 stdio 所属进程组。setsid
		// 只隔离 session，若仍继承 tmux pty，stdio 仍可能指向 pane 的前台组。
		// 把三路标准流改为普通文件，外层 tail 负责转发到 pane，既保留实时日志
		// 又让 Codex 的工具清理永远看不到 paihuo 的终端。
		execution = "cat /proc/self/cgroup > " + shQuote(r.runnerCgroupPath(taskID)) + "\n" +
			"agent_output=" + shQuote(r.agentOutputPath(taskID)) + "\n" +
			": > \"$agent_output\"\n" +
			invocation + " </dev/null >\"$agent_output\" 2>&1 &\n" +
			"agent_pid=$!\n" +
			shQuote(tail) + " --pid=\"$agent_pid\" -n +1 -f -s 0.1 \"$agent_output\" &\n" +
			"tail_pid=$!\n" +
			"wait \"$agent_pid\"\n" +
			"status=$?\n" +
			"wait \"$tail_pid\" 2>/dev/null || true\n"
	}
	// POSIX sh 只负责等待 gate、执行精确 argv、写退出码；实际参数均由安全
	// 单引号编码，支持空格、引号和换行，不依赖用户 shell 的历史或配置。
	src := "#!/bin/sh\n" +
		// tmux 会向 pane 注入自身的 TMUX/TMUX_PANE。任务里的测试可能另起
		// `tmux -L <socket>` 并在 cleanup 时 kill-server；不能让它们继承父
		// paihuo socket，否则可能误操作父 task window 或 server。
		"unset TMUX TMUX_PANE\n" +
		"export PATH=" + shQuote(r.taskBinDir(taskID)) + ":\"$PATH\"\n" +
		"while [ ! -f " + shQuote(r.gatePath(taskID)) + " ]; do sleep 0.05; done\n" +
		execution +
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
	windowExists := r.hasWindow(taskID)
	paneEnded := !windowExists
	if windowExists {
		dead, err := r.paneDead(taskID)
		if err != nil {
			// pane 在 list-panes 与 display-message 之间被移除是正常竞态；
			// 重新确认后按 pane 已丢失处理，而不是把 tmux 查询错误误记为任务失败。
			if r.hasWindow(taskID) {
				return tmuxObservation{}, fmt.Errorf("读取 tmux pane 状态失败: %w", err)
			}
			windowExists = false
			paneEnded = true
		} else {
			paneEnded = dead
		}
	}
	// run.sh 在写入 exit-code 后立刻退出。若第一次读取发生在写入前、而
	// hasWindow 恰好发生在退出后，会看到“window 已消失但没有退出码”的
	// 短暂组合。pane 已结束时重新读取一次，避免把正常完成的短任务误判为
	// window 丢失。
	if paneEnded && !done {
		code, done, err = r.exitCode(taskID)
		if err != nil {
			return tmuxObservation{}, err
		}
	}

	agentOutputSize, detached, err := r.detachedAgentOutputSize(taskID)
	if err != nil {
		return tmuxObservation{}, err
	}
	agentState := agentServiceUnknown
	if !done && detached && paneEnded {
		agentState = r.agentServiceState(taskID)
	}
	if paneEnded {
		event := "pane_dead"
		if !windowExists {
			event = "window_missing"
		}
		detail := "detached=" + strconv.FormatBool(detached) + " agent_service=" + string(agentState) + " session_windows=" + r.sessionWindowSnapshot()
		r.recordLifecycleOnce(taskID, event, detail)
	}
	// agent-exit-code 是独立 Codex service 的持久结果；一旦出现即可直接
	// 结算，不必等待日志 pane/tail 退出。原始输出文件已是同步来源，避免
	// pane 收尾异常重新制造一次“没有退出码”的窗口。
	if done && detached {
		windowExists = false
		paneEnded = true
	}

	alive := windowExists && !paneEnded
	awaitingAgentResult := false
	// Codex batch 的实际 agent 在独立 systemd service 中运行。pane 意外
	// 消失（或已死）时，只有确认 service 已进入收尾或结束状态才开始等待
	// 持久退出码。查询不到 service 是观测失败，不是 agent 已退出的证据；
	// 它交由执行器结合原始输出心跳继续观察，不能误走短结算超时。
	if !done && detached && paneEnded {
		switch agentState {
		case agentServiceActivating, agentServiceActive:
			alive = true
		case agentServiceDeactivating, agentServiceInactive:
			alive = true
			awaitingAgentResult = true
			r.recordLifecycleOnce(taskID, "awaiting_agent_result", "agent_service="+string(agentState))
		case agentServiceUnknown:
			alive = true
			r.recordLifecycleOnce(taskID, "agent_service_unknown", "pane 已结束；继续观察 agent-output.log 与退出码")
		}
	}
	lines, next, err := r.readLines(taskID, offset, done)
	if err != nil {
		return tmuxObservation{}, err
	}
	obs := tmuxObservation{
		Lines:               lines,
		Offset:              next,
		Done:                done,
		ExitCode:            code,
		Alive:               alive,
		DetachedAgent:       detached,
		AgentState:          agentState,
		AgentOutputSize:     agentOutputSize,
		AwaitingAgentResult: awaitingAgentResult,
	}
	if done {
		return obs, nil
	}
	return obs, nil
}

func (r *tmuxRunner) exitCode(taskID int64) (int, bool, error) {
	// Detached Codex service 的结果优先于 pane wrapper 的结果。前者由
	// service 自己原子写入，能跨越 task pane 异常关闭的边界。
	for _, path := range []string{r.agentExitPath(taskID), r.exitPath(taskID)} {
		code, found, err := readExitCode(path)
		if err != nil {
			return 0, false, err
		}
		if found {
			return code, true, nil
		}
	}
	return 0, false, nil
}

func readExitCode(path string) (int, bool, error) {
	b, err := os.ReadFile(path)
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

// archivedAgentExitCode 读取最新一次 pane 丢失归档中的持久 agent 退出码。
// 它只用于恢复已经被旧版本误判为 failed/-1 的终态任务；正常运行仍由
// exitCode 读取当前运行目录，避免把旧一轮结果带入续跑。
func (r *tmuxRunner) archivedAgentExitCode(taskID int64) (int, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entries, err := os.ReadDir(r.taskDir(taskID))
	if errors.Is(err, os.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("读取 tmux 故障归档失败: %w", err)
	}
	// ReadDir 按文件名字典序返回；failure-<UTC timestamp> 因而末尾是最新归档。
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "failure-") {
			continue
		}
		code, found, err := readExitCode(filepath.Join(r.taskDir(taskID), entry.Name(), "agent-exit-code"))
		if err != nil {
			return 0, false, fmt.Errorf("读取 tmux 故障归档 %s 失败: %w", entry.Name(), err)
		}
		if found {
			return code, true, nil
		}
	}
	return 0, false, nil
}

// hasDetachedAgent 以 agent 原始输出文件作为一次 Codex cgroup 启动的可靠
// 标记。该文件只会在 DetachTerminal 模式下由 Start 创建。
func (r *tmuxRunner) hasDetachedAgent(taskID int64) bool {
	_, err := os.Stat(r.agentOutputPath(taskID))
	return err == nil
}

// detachedAgentOutputSize 返回 detached agent 原始输出的当前字节数。该文件
// 单调追加；大小增长因而是 pane 丢失后 agent 仍在工作的独立心跳，哪怕当前
// 输出还没有换行、无法作为普通终端日志同步。
func (r *tmuxRunner) detachedAgentOutputSize(taskID int64) (int64, bool, error) {
	info, err := os.Stat(r.agentOutputPath(taskID))
	if errors.Is(err, os.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("读取 agent 原始输出状态失败: %w", err)
	}
	return info.Size(), true, nil
}

// agentServiceAlive 查询独立 Codex agent service，而不是只依赖 tmux pane。
// unknown 在这个便捷谓词中返回 false，但它仅表示“当前无法确认活跃”，不能
// 作为执行器将 pane 丢失任务结算为失败的依据。
func (r *tmuxRunner) agentServiceAlive(taskID int64) bool {
	return r.agentServiceState(taskID).isExecutingOrFinalizing()
}

func (r *tmuxRunner) agentServiceState(taskID int64) agentServiceState {
	b, err := os.ReadFile(r.agentUnitPath(taskID))
	if err != nil {
		return agentServiceUnknown
	}
	unit := strings.TrimSpace(string(b))
	if unit == "" || unit != r.agentUnitName(taskID) {
		return agentServiceUnknown
	}
	systemctl, err := osexec.LookPath("systemctl")
	if err != nil {
		return agentServiceUnknown
	}
	out, err := osexec.Command(systemctl, "--user", "show", unit, "--property=ActiveState", "--value").Output()
	if err != nil {
		return agentServiceUnknown
	}
	switch strings.TrimSpace(string(out)) {
	case string(agentServiceActivating):
		return agentServiceActivating
	case string(agentServiceActive):
		return agentServiceActive
	case string(agentServiceDeactivating):
		return agentServiceDeactivating
	case string(agentServiceInactive), "failed":
		return agentServiceInactive
	default:
		return agentServiceUnknown
	}
}

func (r *tmuxRunner) readLines(taskID, offset int64, flushTail bool) ([]string, int64, error) {
	// Detached agent 的输出文件独立于 tmux pipe-pane，pane 丢失后仍会持续
	// 追加。正常情况下 tail 会把同样内容转发到 terminal.log 供人工 attach，
	// 但持久化日志只读这一份原始流以避免双份重复。
	path := r.logPath(taskID)
	if r.hasDetachedAgent(taskID) {
		path = r.agentOutputPath(taskID)
	}
	f, err := os.Open(path)
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
	return r.StopWithReason(taskID, "external_request")
}

// StopWithReason 是所有由派活发起的窗口停止操作的唯一入口。原因写入任务
// 专属审计轨迹，使 pane 后续丢失时可以区分系统主动清理与外部生命周期事件。
func (r *tmuxRunner) StopWithReason(taskID int64, reason string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stopLocked(taskID, reason)
}

// stopLocked 与 Start/SendText 共用同一把锁，避免取消恰好发生在 new-window
// 与 pipe-pane 建立之间时相互抢占。调用方必须已持有 r.mu。
func (r *tmuxRunner) stopLocked(taskID int64, reason string) error {
	r.recordLifecycle(taskID, "stop_requested", "reason="+reason)
	if err := r.stopAgentService(taskID, reason); err != nil {
		r.recordLifecycle(taskID, "agent_service_stop_failed", "reason="+reason)
		return err
	}
	if !r.hasWindow(taskID) {
		r.recordLifecycle(taskID, "stop_window_absent", "reason="+reason)
		return nil
	}
	r.recordLifecycle(taskID, "kill_window_requested", "reason="+reason+" target="+r.target(taskID))
	err := r.command("kill-window", "-t", r.target(taskID))
	// window 可能在 hasWindow 与 kill-window 之间被正常结算清理；对停止
	// 语义而言它已经达到目标，不应把一次取消记作任务启动失败。
	if err != nil && strings.Contains(err.Error(), "can't find window") {
		r.recordLifecycle(taskID, "kill_window_raced", "reason="+reason)
		return nil
	}
	if err != nil {
		r.recordLifecycle(taskID, "kill_window_failed", "reason="+reason)
	} else {
		r.recordLifecycle(taskID, "kill_window_completed", "reason="+reason)
	}
	return err
}

// stopAgentService 处理 Codex batch 从 tmux pane 迁出的 transient service。
// tmux kill-window 只会结束 pane scope，不能保证结束同级 systemd service；因此
// 这里必须先按 task 的稳定 unit 名停止 agent，避免取消或异常后留下孤儿进程。
func (r *tmuxRunner) stopAgentService(taskID int64, reason string) error {
	b, err := os.ReadFile(r.agentUnitPath(taskID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取 Codex agent service 记录失败: %w", err)
	}
	unit := strings.TrimSpace(string(b))
	if unit != r.agentUnitName(taskID) {
		return fmt.Errorf("codex agent service 记录非法: %q", unit)
	}
	r.recordLifecycle(taskID, "agent_service_stop_requested", "reason="+reason+" unit="+unit)
	systemctl, err := osexec.LookPath("systemctl")
	if err != nil {
		return fmt.Errorf("未找到 systemctl，无法停止 Codex agent service: %w", err)
	}
	cmd := osexec.Command(systemctl, "--user", "stop", unit)
	out, stopErr := cmd.CombinedOutput()
	if stopErr != nil {
		msg := strings.TrimSpace(string(out))
		if !strings.Contains(msg, "not loaded") && !strings.Contains(msg, "not found") {
			return fmt.Errorf("停止 Codex agent service %s 失败: %w: %s", unit, stopErr, msg)
		}
	}
	r.recordLifecycle(taskID, "agent_service_stop_completed", "reason="+reason+" unit="+unit)
	for _, path := range []string{r.agentUnitPath(taskID), r.agentEnvPath(taskID), r.agentLaunchPath(taskID)} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("清理 Codex agent 运行文件失败: %w", err)
		}
	}
	return nil
}

// SendText 向仍在运行的 task pane 注入一条字面消息并确认。它从不经 shell
// 解释；-l 保证空格、引号和元字符均作为 Pi 的普通输入，而不是 tmux key 名或
// shell 语法。调用方负责校验消息格式与任务是否允许交互。
func (r *tmuxRunner) SendText(taskID int64, text string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.hasWindow(taskID) {
		return fmt.Errorf("交互终端 task-%d 不存在", taskID)
	}
	dead, err := r.paneDead(taskID)
	if err != nil {
		return fmt.Errorf("读取交互终端状态失败: %w", err)
	}
	if dead {
		return fmt.Errorf("交互终端 task-%d 已退出", taskID)
	}
	if err := r.command("send-keys", "-t", r.target(taskID), "-l", "--", text); err != nil {
		return fmt.Errorf("发送交互消息失败: %w", err)
	}
	if err := r.command("send-keys", "-t", r.target(taskID), "Enter"); err != nil {
		return fmt.Errorf("确认交互消息失败: %w", err)
	}
	return nil
}

// SendKeystrokes 向 task pane 原样写入 xterm 产生的按键序列，不追加 Enter。
// tmux 的 -l 令 Tab、方向键和控制字符作为终端输入传给 Pi，而不是被当作
// tmux 的按键名称或 shell 语法解释。
func (r *tmuxRunner) SendKeystrokes(taskID int64, keys string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.hasWindow(taskID) {
		return fmt.Errorf("交互终端 task-%d 不存在", taskID)
	}
	dead, err := r.paneDead(taskID)
	if err != nil {
		return fmt.Errorf("读取交互终端状态失败: %w", err)
	}
	if dead {
		return fmt.Errorf("交互终端 task-%d 已退出", taskID)
	}
	if err := r.command("send-keys", "-t", r.target(taskID), "-l", "--", keys); err != nil {
		return fmt.Errorf("发送终端按键失败: %w", err)
	}
	return nil
}

// Resize 把浏览器 xterm 的当前尺寸同步到运行中的交互任务窗口。tmux 在
// manual 模式下只认 resize-window，调整后 pane 内的 agent 收到 SIGWINCH
// 并按新画布重绘 TUI；持久化日志按原始字节流继续追加，重放不受影响。
func (r *tmuxRunner) Resize(taskID int64, cols, rows int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.hasWindow(taskID) {
		return fmt.Errorf("交互终端 task-%d 不存在", taskID)
	}
	dead, err := r.paneDead(taskID)
	if err != nil {
		return fmt.Errorf("读取交互终端状态失败: %w", err)
	}
	if dead {
		return fmt.Errorf("交互终端 task-%d 已退出", taskID)
	}
	if err := r.command("resize-window", "-t", r.target(taskID), "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows)); err != nil {
		return fmt.Errorf("调整交互终端尺寸失败: %w", err)
	}
	return nil
}

// ArchiveFailureArtifacts 将异常中断前留下的运行文件移入当前任务目录中的独立
// failure-* 子目录。下一次续跑同一任务时可以安全地创建新的 terminal.log/run.sh，
// 而这份证据会保留到任务被删除为止。
func (r *tmuxRunner) ArchiveFailureArtifacts(taskID int64, reason string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	taskDir := r.taskDir(taskID)
	if _, err := os.Stat(taskDir); errors.Is(err, os.ErrNotExist) {
		return "", nil
	} else if err != nil {
		return "", fmt.Errorf("读取 tmux 任务目录失败: %w", err)
	}
	archiveDir := filepath.Join(taskDir, "failure-"+time.Now().UTC().Format("20060102T150405.000000000Z"))
	if err := os.Mkdir(archiveDir, 0o700); err != nil {
		return "", fmt.Errorf("创建 tmux 故障归档失败: %w", err)
	}
	r.recordLifecycle(taskID, "failure_archive_started", "")
	for _, name := range []string{"terminal.log", "agent-output.log", "runner-cgroup", "runner-events.log", "run.sh", "exit-code", "agent-exit-code", "start"} {
		from := filepath.Join(taskDir, name)
		to := filepath.Join(archiveDir, name)
		if err := os.Rename(from, to); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return "", fmt.Errorf("归档 tmux 运行文件 %s 失败: %w", name, err)
		}
	}
	if reason = strings.TrimSpace(reason); reason != "" {
		if err := os.WriteFile(filepath.Join(archiveDir, "reason.txt"), []byte(reason+"\n"), 0o600); err != nil {
			return "", fmt.Errorf("写入 tmux 故障原因失败: %w", err)
		}
	}
	return archiveDir, nil
}

// Cleanup 只清理该任务的 window 与运行时文件（包括 failure-* 归档）；control
// window / 专用 server 会保留。调用它意味着任务已被正常结算或显式删除。
func (r *tmuxRunner) Cleanup(taskID int64) {
	_ = r.StopWithReason(taskID, "cleanup")
	_ = os.RemoveAll(r.taskDir(taskID))
	r.resetLifecycle(taskID)
}

func (r *tmuxRunner) command(args ...string) error {
	cmd := osexec.Command(r.binary, r.commandArgs(args...)...)
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

func (r *tmuxRunner) commandArgs(args ...string) []string {
	cmdArgs := make([]string, 0, len(args)+4)
	cmdArgs = append(cmdArgs, "-f", tmuxConfigFile, "-L", r.socket)
	return append(cmdArgs, args...)
}

// shQuote 返回可嵌入 POSIX sh 脚本的单个精确参数；NUL 本就不能存在于 argv。
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}
