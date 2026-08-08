package session

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

// termProc 是 codex/claude 等非 pi 会话的终端式通道：直接在 paihuo 的
// tmux server（session "paihuo"）里开 session-<id> 窗口，跑 CLI 交互命令。
// 不经过任务 tmuxRunner 的结算机制（会话无执行-结算语义）：
//   - spawn：new-window + 交互命令（初始消息作位置参数）
//   - 输入/尺寸：send-keys / resize-window
//   - 输出：capture-pane 增量读取（前端轮询）
//   - kill：kill-window（挂起/交付/删除）
//
// 设计：docs/design/07-fallback-cli.md
type termProc struct {
	mu     sync.Mutex
	window string // session-<id>
	offset int64  // 已读取输出字节数（窗口重开时重置）
	socket string
}

const termInteractiveCols = 80
const termInteractiveRows = 24

// newTermProc 创建终端通道（不 spawn）。
func newTermProc(socket string) *termProc {
	return &termProc{socket: socket}
}

func (p *termProc) windowName(id int64) string { return fmt.Sprintf("session-%d", id) }

// tmux 基础命令：-L <socket> 指定 server；session paihuo 由 Executor 启动时建立。
func (p *termProc) tmux(args ...string) (string, error) {
	base := []string{"-L", p.socket, "-q"}
	out, err := exec.Command("tmux", append(base, args...)...).CombinedOutput()
	return string(out), err
}

// Spawn 在 tmux 中启动 CLI 交互会话窗口。
// prompt 为初始消息（位置参数）；cwd 为会话 worktree。
func (p *termProc) Spawn(id int64, bin string, args []string, env []string, cwd string, initialMsg string) error {
	win := p.windowName(id)
	p.window = win
	// 清掉同名的历史窗口（恢复场景）。
	_, _ = p.tmux("kill-window", "-t", "paihuo:"+win)

	cmdArgs := append([]string{}, args...)
	if initialMsg != "" {
		cmdArgs = append(cmdArgs, initialMsg)
	}
	quoted := make([]string, 0, len(cmdArgs)+1)
	quoted = append(quoted, bin)
	for _, a := range cmdArgs {
		quoted = append(quoted, shellQuote(a))
	}
	shellCmd := strings.Join(quoted, " ")
	envPrefix := ""
	for _, kv := range env {
		envPrefix += "export " + shellQuote(kv) + "; "
	}
	full := "cd " + shellQuote(cwd) + " && " + envPrefix + shellCmd

	if _, err := p.tmux("new-window", "-t", "paihuo", "-n", win, full); err != nil {
		return fmt.Errorf("创建会话终端窗口失败: %w", err)
	}
	// new-window 无 -x/-y（new-session 才有）；窗口尺寸用 resize-window 设定。
	_, _ = p.tmux("resize-window", "-t", "paihuo:"+win,
		"-x", strconv.Itoa(termInteractiveCols), "-y", strconv.Itoa(termInteractiveRows))
	p.offset = 0
	return nil
}

// Input 发送文本（整行 + 回车）。xterm 原始按键流走 InputRaw。
func (p *termProc) Input(id int64, text string) error {
	if p.window == "" {
		return fmt.Errorf("会话终端未启动")
	}
	_, err := p.tmux("send-keys", "-t", "paihuo:"+p.window, "-l", text)
	if err != nil {
		return fmt.Errorf("发送输入失败: %w", err)
	}
	_, err = p.tmux("send-keys", "-t", "paihuo:"+p.window, "Enter")
	return err
}

// InputRaw 发送原始按键（xterm 粘贴/组合键），不追加回车。
func (p *termProc) InputRaw(id int64, text string) error {
	if p.window == "" {
		return fmt.Errorf("会话终端未启动")
	}
	_, err := p.tmux("send-keys", "-t", "paihuo:"+p.window, "-l", text)
	return err
}

// Resize 同步浏览器终端尺寸到 tmux 窗口。
func (p *termProc) Resize(id int64, cols, rows int) error {
	if p.window == "" {
		return fmt.Errorf("会话终端未启动")
	}
	if cols < 20 || cols > 500 || rows < 5 || rows > 200 {
		return fmt.Errorf("终端尺寸越界: %dx%d", cols, rows)
	}
	_, err := p.tmux("resize-window", "-t", "paihuo:"+p.window, "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
	return err
}

// Output 增量读取终端画面（capture-pane 全量 + offset 截断）。
// 返回 (增量文本, 是否还活着)。
func (p *termProc) Output(id int64) (string, bool, error) {
	if p.window == "" {
		return "", false, fmt.Errorf("会话终端未启动")
	}
	out, err := p.tmux("capture-pane", "-t", "paihuo:"+p.window, "-p", "-J")
	alive := err == nil
	if err != nil {
		// 窗口丢失（进程退出/kill）
		return "", false, nil
	}
	cur := int64(len(out))
	if cur <= p.offset {
		return "", alive, nil
	}
	delta := out[p.offset:]
	p.offset = cur
	return delta, alive, nil
}

// Kill 终止窗口（挂起/交付/删除）。
func (p *termProc) Kill(id int64) error {
	if p.window == "" {
		return nil
	}
	_, err := p.tmux("kill-window", "-t", "paihuo:"+p.window)
	p.window = ""
	return err
}

// Alive 窗口是否仍在。
func (p *termProc) Alive(id int64) bool {
	out, err := p.tmux("has-session", "-t", "paihuo:"+p.windowName(id))
	return err == nil && strings.TrimSpace(out) == ""
}

// shellQuote 单引号转义（bash 语义）。
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

var _ = bytes.Compare
var _ = os.Getenv
