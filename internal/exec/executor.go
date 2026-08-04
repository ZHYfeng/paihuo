package exec

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/store"
)

// Executor 轮询领取 queued 任务并执行。
// 约束：同一角色（agent）同时只跑一个任务，避免项目目录冲突；
// 不同角色可并行（每任务一个 goroutine）。
type Executor struct {
	st   *store.Store
	hub  *events.Hub
	mu   sync.Mutex
	busy map[int64]struct{} // 正在执行任务的 agent id
	// cancels 是任务级取消句柄
	cancels map[int64]context.CancelFunc
	wake    chan struct{}
}

func New(st *store.Store, hub *events.Hub) *Executor {
	return &Executor{
		st:      st,
		hub:     hub,
		busy:    make(map[int64]struct{}),
		cancels: make(map[int64]context.CancelFunc),
		wake:    make(chan struct{}, 1),
	}
}

func (e *Executor) Start(ctx context.Context) {
	e.resetInterrupted()
	go e.loop(ctx)
}

// resetInterrupted 服务重启时，把卡在运行态的任务标记为失败（进程已死）。
func (e *Executor) resetInterrupted() {
	tasks, err := e.st.ListRunningTasks()
	if err != nil {
		return
	}
	for _, tk := range tasks {
		msg := "服务重启，任务中断"
		_ = e.st.UpdateTask(tk.ID, map[string]any{
			"status": store.StatusFailed, "finished_at": store.Now(), "error": msg,
		})
		e.log(tk.ID, "sys", "✗ "+msg)
		e.publishTask(tk.ID)
	}
}

// Wake 触发一次立即派发（创建/重试任务后调用）。
func (e *Executor) Wake() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

// CancelTask 终止正在运行的任务。
func (e *Executor) CancelTask(id int64) {
	e.mu.Lock()
	c, ok := e.cancels[id]
	e.mu.Unlock()
	if ok {
		c()
	}
}

func (e *Executor) loop(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.wake:
		case <-t.C:
		}
		e.dispatch(ctx)
	}
}

func (e *Executor) dispatch(ctx context.Context) {
	tasks, err := e.st.ListQueuedTasks()
	if err != nil {
		return
	}
	for _, tk := range tasks {
		if tk.AgentID == nil {
			continue
		}
		e.mu.Lock()
		_, busy := e.busy[*tk.AgentID]
		e.mu.Unlock()
		if busy {
			continue
		}
		claimed, err := e.st.ClaimTask(tk.ID)
		if err != nil || !claimed {
			continue
		}
		e.mu.Lock()
		e.busy[*tk.AgentID] = struct{}{}
		e.mu.Unlock()
		go e.runTask(ctx, tk)
	}
}

func (e *Executor) runTask(ctx context.Context, tk store.Task) {
	agentID := *tk.AgentID
	defer func() {
		e.mu.Lock()
		delete(e.busy, agentID)
		e.mu.Unlock()
		e.Wake()
	}()

	if err := e.st.UpdateTask(tk.ID, map[string]any{"status": store.StatusRunning, "started_at": store.Now()}); err != nil {
		return
	}
	e.publishTask(tk.ID)

	fail := func(msg string) {
		e.log(tk.ID, "sys", "✗ "+msg)
		_ = e.st.UpdateTask(tk.ID, map[string]any{
			"status": store.StatusFailed, "finished_at": store.Now(), "error": msg,
		})
		e.publishTask(tk.ID)
	}

	if tk.ProjectDir == "" {
		fail("任务未绑定项目目录（请先指派角色）")
		return
	}
	if fi, err := os.Stat(tk.ProjectDir); err != nil || !fi.IsDir() {
		fail("项目目录不存在: " + tk.ProjectDir)
		return
	}

	agent, err := e.st.GetAgent(agentID)
	if err != nil {
		fail("角色不存在: " + err.Error())
		return
	}
	adapter, ok := GetAdapter(agent.CLI)
	if !ok {
		fail("未知 CLI 适配器: " + agent.CLI)
		return
	}
	if _, err := adapter.Detect(); err != nil {
		fail(err.Error())
		return
	}

	// 执行上下文：任务取消或进程退出时终止。
	rctx, cancel := context.WithCancel(ctx)
	e.mu.Lock()
	e.cancels[tk.ID] = cancel
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		delete(e.cancels, tk.ID)
		e.mu.Unlock()
		cancel()
	}()

	e.log(tk.ID, "sys", fmt.Sprintf("▶ 开始执行：角色=%s CLI=%s 权限=%s%s", agent.Name, agent.CLI, tk.Perm, map[bool]string{true: " 续跑轮", false: ""}[tk.ReviewRounds > 0]))
	ro := RunOptions{Dir: tk.ProjectDir, Prompt: buildPrompt(tk), Role: agent.RoleConfig, Perm: tk.Perm, Continue: tk.ReviewRounds > 0}
	// 任务专属会话目录：会话隔离 + 审批续跑无歧义
	sessDir := filepath.Join(os.TempDir(), "paihuo-sessions", fmt.Sprintf("task-%d", tk.ID))
	if err := os.MkdirAll(sessDir, 0o755); err == nil {
		ro.SessionDir = sessDir
	} else {
		e.log(tk.ID, "sys", "⚠ 会话目录创建失败，续跑可能不可用: "+err.Error())
	}
	for _, w := range adapter.Warnings(ro) {
		e.log(tk.ID, "sys", "⚠ "+w)
	}

	bin, args, env, err := adapter.Build(ro)
	if err != nil {
		fail(err.Error())
		return
	}
	e.log(tk.ID, "sys", "$ "+shellJoin(append([]string{bin}, args...)))

	onLine := func(stream, text string) { e.log(tk.ID, stream, text) }
	code, runErr := e.runLocal(rctx, tk, bin, args, env, onLine)

	// 终态判定：取消优先于失败。
	cur, _ := e.st.GetTask(tk.ID)
	if cur != nil && cur.Status == store.StatusCancelled {
		e.log(tk.ID, "sys", "■ 已取消")
		return
	}
	if runErr != nil {
		if rctx.Err() != nil || errors.Is(runErr, context.Canceled) {
			_ = e.st.UpdateTask(tk.ID, map[string]any{
				"status": store.StatusCancelled, "finished_at": store.Now(), "error": "已终止",
			})
			e.log(tk.ID, "sys", "■ 已终止")
			e.publishTask(tk.ID)
			return
		}
		_ = e.st.UpdateTask(tk.ID, map[string]any{
			"status": store.StatusFailed, "finished_at": store.Now(), "exit_code": code, "error": runErr.Error(),
		})
		e.log(tk.ID, "sys", fmt.Sprintf("✗ 执行失败 exit=%d", code))
		e.publishTask(tk.ID)
		return
	}
	if tk.Perm == store.PermReview {
		rounds := tk.ReviewRounds + 1
		_ = e.st.UpdateTask(tk.ID, map[string]any{
			"status": store.StatusAwaitingReview, "finished_at": store.Now(), "exit_code": 0, "review_rounds": rounds,
		})
		e.log(tk.ID, "sys", fmt.Sprintf("⏸ 第 %d 轮完成，等待审批", rounds))
		e.publishTask(tk.ID)
		return
	}
	_ = e.st.UpdateTask(tk.ID, map[string]any{
		"status": store.StatusSucceeded, "finished_at": store.Now(), "exit_code": 0,
	})
	e.log(tk.ID, "sys", "✓ 完成")
	e.publishTask(tk.ID)
}
func buildPrompt(tk store.Task) string {
	body := tk.Body
	switch tk.Perm {
	case store.PermReview:
		if tk.ReviewRounds > 0 {
			return "继续推进任务，完成下一个可检查的进展后停止并汇报。若任务已完成，请明确说明完成情况。\n\n原任务：" + body
		}
		return body + "\n\n[审批模式] 请推进任务，完成一个可检查的进展后停止并汇报，等待人工确认。不要一次性做完所有工作，先做最关键的一步。"
	case store.PermReadonly:
		return body + "\n\n[只读模式] 只允许读取、分析和规划，禁止修改任何文件，禁止执行有副作用的命令。"
	}
	return body
}

// runLocal 在本地执行 CLI；取消时杀掉整个进程组。
func (e *Executor) runLocal(ctx context.Context, tk store.Task, bin string, args []string, env []string, onLine func(stream, line string)) (int, error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = tk.ProjectDir
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // 独立进程组，便于整组终止

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return -1, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return -1, err
	}
	if err := cmd.Start(); err != nil {
		return -1, err
	}

	doneCh := make(chan struct{})
	go func() {
		select {
		case <-doneCh:
		case <-ctx.Done():
			if cmd.Process != nil {
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			}
		}
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	go scanLines(tk.ID, "out", stdout, onLine, &wg)
	go scanLines(tk.ID, "err", stderr, onLine, &wg)
	wg.Wait()
	runErr := cmd.Wait()
	close(doneCh)

	if ctx.Err() != nil {
		return -1, ctx.Err()
	}
	if runErr != nil {
		code := -1
		var ee *exec.ExitError
		if errors.As(runErr, &ee) {
			code = ee.ExitCode()
		}
		return code, runErr
	}
	return 0, nil
}

func scanLines(taskID int64, stream string, r io.Reader, onLine func(stream, line string), wg *sync.WaitGroup) {
	defer wg.Done()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		onLine(stream, sc.Text())
	}
}

func (e *Executor) log(taskID int64, stream, content string) {
	if content == "" {
		return
	}
	l, err := e.st.AppendLog(store.TaskLog{TaskID: taskID, Stream: stream, Content: content})
	if err != nil {
		// 任务可能已被删除（级联删除日志），忽略
		return
	}
	e.hub.Publish(events.Event{Type: "log", TaskID: taskID, Payload: l})
}

func (e *Executor) publishTask(id int64) {
	tk, err := e.st.GetTask(id)
	if err != nil {
		return
	}
	e.hub.Publish(events.Event{Type: "task", TaskID: id, Payload: tk})
}
