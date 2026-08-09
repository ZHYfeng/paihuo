package session

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
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
	mu      sync.Mutex
	window  string // session-<id>
	socket  string
	archive string        // 最后捕获帧的持久化路径（<session_dir>/term.out）
	done    chan struct{} // Kill 时关闭，终止 autoConfirmTrust 等后台协程
}

const termInteractiveCols = 80
const termInteractiveRows = 24

// isCodexTrustPrompt 判断 capture 画面是否为 codex 的目录信任确认
// （codex 专属文案，其它 CLI / codex 其它画面不会出现）。
func isCodexTrustPrompt(out string) bool {
	return strings.Contains(out, "Do you trust the contents of this directory?") &&
		strings.Contains(out, "1. Yes, continue")
}

// autoConfirmTrust 自动确认 codex 的目录信任提示。codex 交互 TUI 对不在
// 信任列表的目录每次新进程都会弹「Do you trust the contents of this
// directory?」并要求回车确认；实测没有可用的跳过开关（--skip-git-repo-check
// 仅 exec 子命令，skip_git_repo_check 配置项与 -c 覆盖对 TUI 均无效，也无
// 环境变量），唯一无侵入途径是自动回车选择「Yes, continue」——会话目录是
// paihuo 管理的隔离 worktree，与批处理任务（exec 自动跳过检查）同权。
// 仅在 spawn 后短暂窗口内轮询，命中后只确认一次；进程/窗口消失即退出。
func (p *termProc) autoConfirmTrust(win string) {
	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-p.done:
			return
		case <-time.After(1 * time.Second):
		}
		out, err := p.tmux("capture-pane", "-t", "paihuo:"+win, "-p")
		if err != nil {
			return // 窗口已消失
		}
		if isCodexTrustPrompt(out) {
			time.Sleep(400 * time.Millisecond) // 等画面稳定（选项渲染完整）
			_, _ = p.tmux("send-keys", "-t", "paihuo:"+win, "Enter")
			log.Printf("↻ 会话 %s 已自动确认 codex 目录信任（等效 exec --skip-git-repo-check）", win)
			return
		}
	}
}

// newTermProc 创建终端通道（不 spawn）。
func newTermProc(socket string) *termProc {
	return &termProc{socket: socket, done: make(chan struct{})}
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
	// codex 首次进入未信任目录会弹信任确认：自动回车确认（等效跳过检查），
	// 避免会话打开就卡在确认画面。非 codex 画面无对应文案，不会误触发。
	go p.autoConfirmTrust(win)
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
// xterm 的 Enter 键在 onData 里是 \r 字面量：send-keys -l 会把它当普通字符
// 输入而不是回车键，TUI（如 codex 的目录信任确认）会卡在等待回车。因此把
// \r 拆出来转成 Enter 键，其余字符原样发送。
func (p *termProc) InputRaw(id int64, text string) error {
	if p.window == "" {
		return fmt.Errorf("会话终端未启动")
	}
	segments := strings.Split(text, "\r")
	for i, seg := range segments {
		if seg != "" {
			if _, err := p.tmux("send-keys", "-t", "paihuo:"+p.window, "-l", seg); err != nil {
				return fmt.Errorf("发送输入失败: %w", err)
			}
		}
		if i < len(segments)-1 {
			// TUI（如 codex）处理完字符流前会丢弃过早到达的回车键：
			// 字符与 Enter 分开两次 tmux 调用仍可能被吞，给足事件循环时间。
			time.Sleep(120 * time.Millisecond)
			if _, err := p.tmux("send-keys", "-t", "paihuo:"+p.window, "Enter"); err != nil {
				return fmt.Errorf("发送回车失败: %w", err)
			}
		}
	}
	return nil
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

// Output 读取终端画面全量（capture-pane）。
// 返回 (全量文本, 是否还活着)。不做增量 diff：TUI 会原地重绘/清屏/随尺寸
// 重排，按字节 offset 截增量必然错位累积垃圾；由前端按帧比较（前缀增量，
// 否则整帧重置）保证显示一致。
func (p *termProc) Output(id int64) (string, bool, error) {
	if p.window == "" {
		return "", false, fmt.Errorf("会话终端未启动")
	}
	out, err := p.tmux("capture-pane", "-t", "paihuo:"+p.window, "-p", "-J")
	if err != nil {
		// 窗口丢失（进程退出/kill）
		return "", false, nil
	}
	// 持久化最后帧：交付/挂起/进程退出后终端窗口消失，前端靠这个文件
	// 回放最后一次画面（delivered 会话不再空白）。
	if p.archive != "" {
		_ = os.WriteFile(p.archive, []byte(out), 0o644)
	}
	return out, true, nil
}

// Kill 终止窗口（挂起/交付/删除）。
func (p *termProc) Kill(id int64) error {
	select {
	case <-p.done:
	default:
		close(p.done)
	}
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
