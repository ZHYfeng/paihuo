package session

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/store"
)

// rpcProc 封装一个 pi --mode rpc 子进程：stdin 收命令 JSONL，stdout 事件
// JSONL，全双工。命令带 id 关联：写命令后同步等待对应 response（带超时）；
// 其余 stdout 行按事件类型分发（消息流、状态、bash 输出）。
//
// 关键事实（已实测 pi 0.84.1）：
//   - stdin EOF 会中断进行中的 LLM 处理并退出进程 → 必须保持 stdin 打开
//   - 每次启动创建新会话文件；恢复历史需显式 switch_session
//   - 空会话文件在退出时被清理（无害）
type rpcProc struct {
	sessionID int64
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stderrLog *os.File // stderr 重定向到日志文件（调试）

	mu        sync.Mutex
	writeMu   sync.Mutex // stdin 写入串行化
	pending   map[string]chan rpcResponse
	exited    chan struct{}
	exitOnce  sync.Once
	exitErr   error
	closed    bool // 进程已终止（挂起/崩溃）
	lastEvent time.Time
	onEvent   func(rpcEvent) // Manager 注入的事件处理器（Hub 转发 + 落库）
	onExit    func()        // Manager 注入的退出回调（崩溃 → suspended）
}

type rpcResponse struct {
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
}

// rpcEvent 是 stdout 事件行的通用形态。
// assistantMessageEvent 是 message_update 的增量载荷（text_delta 等）：
// 之前漏掉该字段，增量事件在 JSON 解析边界被丢弃，流式输出只能在
// message_end 一次性出现。必须透传给前端按 contentIndex 累积。
// extension_ui_request 的交互字段（method/title/options/…）都在事件顶层，
// 之前同样在 JSON 解析边界被丢弃，前端只能拿到空壳；必须透传，
// 否则 pi agent 的交互式提问（ask_user → select/confirm/input/editor）
// 在会话视图里无法显示也无法应答。
type rpcEvent struct {
	Type                  string          `json:"type"`
	ID                    string          `json:"id,omitempty"`
	Command               string          `json:"command,omitempty"`
	Success               *bool           `json:"success,omitempty"`
	Data                  json.RawMessage `json:"data,omitempty"`
	Message               json.RawMessage `json:"message,omitempty"`
	AssistantMessageEvent json.RawMessage `json:"assistantMessageEvent,omitempty"`
	Error                 string          `json:"error,omitempty"`
	// extension_ui_request 顶层字段（confirm 的正文走上面的 message）。
	Method          string   `json:"method,omitempty"`
	Title           string   `json:"title,omitempty"`
	Options         []string `json:"options,omitempty"`
	Placeholder     string   `json:"placeholder,omitempty"`
	NotifyType      string   `json:"notifyType,omitempty"`
	StatusKey       string   `json:"statusKey,omitempty"`
	StatusText      string   `json:"statusText,omitempty"`
	WidgetKey       string   `json:"widgetKey,omitempty"`
	WidgetLines     []string `json:"widgetLines,omitempty"`
	WidgetPlacement string   `json:"widgetPlacement,omitempty"`
	Text            string   `json:"text,omitempty"`
}

// newRPCProc 启动 pi RPC 进程。
//   - cwd：会话 worktree（agent 在隔离分支里干活）
//   - args：BuildPiRPCSessionArgs 构造的启动参数
//   - sessionDir：pi 会话文件目录
//   - stderrPath：stderr 日志文件
// newRPCProc 启动 pi RPC 进程。注意：进程生命周期独立于任何请求 ctx
// （exec.CommandContext 会在 ctx 取消时向进程发 SIGINT，导致挂起的请求
// 结束时误杀会话进程）；崩溃/退出检测走 p.exited 通道。
func newRPCProc(sessionID int64, bin string, args []string, env []string, cwd, sessionDir, stderrPath string) (*rpcProc, error) {
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建会话目录失败: %w", err)
	}
	var stderrLog *os.File
	if stderrPath != "" {
		f, err := os.OpenFile(stderrPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			return nil, fmt.Errorf("打开会话 stderr 日志失败: %w", err)
		}
		stderrLog = f
	}

	cmd := exec.Command(bin, args...)
	cmd.Dir = cwd
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("创建 stdin 管道失败: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("创建 stdout 管道失败: %w", err)
	}
	cmd.Stderr = stderrLog

	p := &rpcProc{
		sessionID: sessionID,
		cmd:       cmd,
		stdin:     stdin,
		stderrLog: stderrLog,
		pending:   make(map[string]chan rpcResponse),
		exited:    make(chan struct{}),
	}
	if err := cmd.Start(); err != nil {
		if stderrLog != nil {
			stderrLog.Close()
		}
		return nil, fmt.Errorf("启动 pi RPC 进程失败: %w", err)
	}
	go p.readLoop(stdout)
	go p.waitExit()
	return p, nil
}

// readLoop 逐行解析 stdout JSONL 并分发。
func (p *rpcProc) readLoop(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var ev rpcEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue // 非 JSON 行（防御）：忽略
		}
		p.mu.Lock()
		p.lastEvent = time.Now()
		p.mu.Unlock()
		if ev.Type == "response" {
			p.dispatchResponse(ev)
			continue
		}
		if p.onEvent != nil {
			p.onEvent(ev)
		}
	}
	p.exitOnce.Do(func() {
		p.exitErr = scanner.Err()
		close(p.exited)
	})
}

// onEvent 由 Manager 注入（见 manager.go：转发 Hub + 更新 last_message_at）。

// dispatchResponse 匹配 pending 通道。
func (p *rpcProc) dispatchResponse(ev rpcEvent) {
	if ev.ID == "" {
		return
	}
	p.mu.Lock()
	ch, ok := p.pending[ev.ID]
	if ok {
		delete(p.pending, ev.ID)
	}
	p.mu.Unlock()
	if !ok {
		return
	}
	success := false
	if ev.Success != nil {
		success = *ev.Success
	}
	ch <- rpcResponse{ID: ev.ID, Command: ev.Command, Success: success, Data: ev.Data, Error: ev.Error}
}

// send 写一条命令并等待对应 response（超时 cmdTimeout）。
// 命令必须携带 id；进程已退出时立即返回错误。
func (p *rpcProc) send(ctx context.Context, cmd map[string]any, timeout time.Duration) (rpcResponse, error) {
	id, _ := cmd["id"].(string)
	if id == "" {
		return rpcResponse{}, errors.New("RPC 命令缺少 id")
	}
	p.mu.Lock()
	select {
	case <-p.exited:
		p.mu.Unlock()
		return rpcResponse{}, fmt.Errorf("会话进程已退出: %v", p.exitErr)
	default:
	}
	ch := make(chan rpcResponse, 1)
	p.pending[id] = ch
	p.mu.Unlock()

	payload, err := json.Marshal(cmd)
	if err != nil {
		p.dropPending(id, ch)
		return rpcResponse{}, err
	}
	p.writeMu.Lock()
	_, err = p.stdin.Write(append(payload, '\n'))
	p.writeMu.Unlock()
	if err != nil {
		p.dropPending(id, ch)
		return rpcResponse{}, fmt.Errorf("写入命令失败: %w", err)
	}

	select {
	case resp := <-ch:
		return resp, nil
	case <-time.After(timeout):
		p.dropPending(id, ch)
		return rpcResponse{}, fmt.Errorf("命令 %s 响应超时（%v）", cmd["type"], timeout)
	case <-ctx.Done():
		p.dropPending(id, ch)
		return rpcResponse{}, ctx.Err()
	case <-p.exited:
		p.dropPending(id, ch)
		return rpcResponse{}, fmt.Errorf("会话进程已退出: %v", p.exitErr)
	}
}

func (p *rpcProc) dropPending(id string, ch chan rpcResponse) {
	p.mu.Lock()
	if cur, ok := p.pending[id]; ok && cur == ch {
		delete(p.pending, id)
	}
	p.mu.Unlock()
}

// waitExit 等待进程退出并通知外部（Manager 据此处理崩溃→suspended）。
func (p *rpcProc) waitExit() {
	err := p.cmd.Wait()
	p.exitOnce.Do(func() {
		if err != nil {
			p.exitErr = err
		}
		close(p.exited)
	})
	if p.stderrLog != nil {
		p.stderrLog.Close()
	}
	if p.onExit != nil {
		p.onExit()
	}
}

// terminate 优雅终止：SIGTERM → 5s 超时 SIGKILL。会话文件由 pi 持久化。
func (p *rpcProc) terminate() {
	select {
	case <-p.exited:
		return // 已退出
	default:
	}
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Signal(os.Interrupt)
	}
	select {
	case <-p.exited:
		return
	case <-time.After(5 * time.Second):
	}
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	<-p.exited
}

// sendLine 向 stdin 写入一行 JSONL 但不等待 response。
// 用于 pi 在输入层拦截、不会回 response 的命令（extension_ui_response：
// handleInputLine 直接 resolve 挂起的提问，不产生 stdout 响应）。
func (p *rpcProc) sendLine(cmd map[string]any) error {
	p.mu.Lock()
	select {
	case <-p.exited:
		p.mu.Unlock()
		return fmt.Errorf("会话进程已退出: %v", p.exitErr)
	default:
	}
	p.mu.Unlock()
	payload, err := json.Marshal(cmd)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	_, err = p.stdin.Write(append(payload, '\n'))
	p.writeMu.Unlock()
	return err
}

// runCommand 发送任意 RPC 命令并返回 response。
func (p *rpcProc) runCommand(ctx context.Context, cmdType string, fields map[string]any, timeout time.Duration) (rpcResponse, error) {
	cmd := map[string]any{"type": cmdType, "id": cmdID()}
	for k, v := range fields {
		cmd[k] = v
	}
	return p.send(ctx, cmd, timeout)
}

// 默认命令超时：prompt 接受判定给宽裕时间（LLM 排队/steer 判定）。
const (
	cmdTimeout       = 5 * time.Second
	promptCmdTimeout = 15 * time.Second
)

var cmdSeq int64

func cmdID() string {
	cmdSeq++
	return fmt.Sprintf("ph-%d-%d", time.Now().UnixNano(), cmdSeq)
}

// Manager 是会话的生命周期管理器（见 manager.go），rpcProc 通过
// setEventHandler 回接事件。为避免包级循环引用，事件处理函数在
// manager.go 定义并注入。
func (p *rpcProc) setEventHandler(fn func(ev rpcEvent)) { p.onEvent = fn }

// broadcastEvent 把事件转发到 Hub（session.message / session.updated）。
func broadcastEvent(hub *events.Hub, typ string, payload any) {
	hub.Publish(events.Event{Type: typ, Payload: payload})
}

// touchSession 更新会话的 last_message_at（消息事件时）。
func touchSession(st *store.Store, id int64, ts string) {
	_ = st.UpdateSession(id, map[string]any{"last_message_at": ts, "updated_at": ts})
}
