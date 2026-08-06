package exec

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

// Executor 轮询领取 queued 任务并执行。角色是一个可配置大小的执行池：
// 每个任务独立拥有 tmux window、agent 会话目录和（Git 项目时）worktree，
// 因而同一角色可以并行；MaxConcurrency 只负责控制资源与上游配额占用。
//
// 项目级并发门禁：任务默认不并发——未勾选「并发执行」的任务要求所在项目
// 当前没有任何活跃任务才允许启动（同一项目同时只执行一个任务）；勾选了
// 并发的任务跳过门禁，只受角色并发上限约束。
type Executor struct {
	st           *store.Store
	hub          *events.Hub
	sessionsRoot string // 任务工作空间根目录（<db目录>/sessions）
	taskSessions *taskSessionStore
	runner       *tmuxRunner
	mu           sync.Mutex
	active       map[int64]int // 每个 agent 当前已占用的执行槽位数
	activeProj   map[int64]int // 每个项目当前活跃的任务数（非并发任务的串行门禁）
	// cancels 是任务级取消句柄
	cancels map[int64]context.CancelFunc
	wake    chan struct{}
}

var errExecutorStopping = errors.New("paihuo 正在停止")
var errTmuxWindowLost = errors.New("专用 tmux window 已消失，且未留下退出码")

type tmuxWindowLostError struct {
	taskID int64
}

func (e tmuxWindowLostError) Error() string {
	return fmt.Sprintf("专用 tmux window task-%d 已消失，且未留下退出码", e.taskID)
}

func (e tmuxWindowLostError) Is(target error) bool {
	return target == errTmuxWindowLost
}

// New 创建执行器。instanceID 必须稳定标识当前派活数据库，用于把 agent
// CLI 的会话文件和同机其他 paihuo 实例隔离开。
func New(st *store.Store, hub *events.Hub, sessionsRoot, instanceID string) *Executor {
	return &Executor{
		st:           st,
		hub:          hub,
		sessionsRoot: sessionsRoot,
		taskSessions: newTaskSessionStore(sessionsRoot, instanceID),
		runner:       newTmuxRunner(sessionsRoot),
		active:       make(map[int64]int),
		activeProj:   make(map[int64]int),
		cancels:      make(map[int64]context.CancelFunc),
		wake:         make(chan struct{}, 1),
	}
}

func (e *Executor) Start(ctx context.Context) {
	// 启动时就建立唯一的专用 session。即使暂时没有任务，运维也可直接
	// attach 观察；实际任务只会增减各自的 task-<id> window。
	if err := e.runner.ensureSession(); err != nil {
		log.Printf("⚠ 专用 tmux 执行器未就绪: %v", err)
	}
	e.recoverLostCompletions()
	e.recoverInterrupted(ctx)
	go e.loop(ctx)
}

// recoverLostCompletions 修复旧执行器留下的一个非常窄的收尾竞态：pane 已
// 消失，agent wrapper 稍后才写入成功退出码，任务却已被记为 failed/-1。只接受
// 任务自身 failure-* 归档中的 agent-exit-code=0，绝不根据模型最终文本或猜测
// 反推成功；恢复 Git 任务时仍通过原子方法创建唯一的合并子任务。
func (e *Executor) recoverLostCompletions() {
	tasks, err := e.st.ListTasksFiltered(store.TaskFilter{Status: store.StatusFailed})
	if err != nil {
		log.Printf("⚠ 扫描可恢复 tmux 任务失败: %v", err)
		return
	}
	for _, tk := range tasks {
		if !isRecoverablePaneLoss(tk) {
			continue
		}
		code, found, err := e.runner.archivedAgentExitCode(tk.ID)
		if err != nil {
			e.log(tk.ID, "sys", "⚠ 读取故障归档退出码失败: "+err.Error())
			continue
		}
		if !found || code != 0 {
			continue
		}

		if tk.Perm == store.PermReview {
			changed, err := e.st.RecoverLostTask(tk.ID, store.StatusAwaitingReview)
			if err != nil || !changed {
				msg := "状态已变化"
				if err != nil {
					msg = err.Error()
				}
				e.log(tk.ID, "sys", "⚠ 恢复待审批任务失败: "+msg)
				continue
			}
			e.log(tk.ID, "sys", "↻ 已从归档确认 agent 成功退出，恢复为待审批")
			e.publishTask(tk.ID)
			continue
		}

		if tk.WorktreeBranch == "" {
			changed, err := e.st.RecoverLostTask(tk.ID, store.StatusSucceeded)
			if err != nil || !changed {
				msg := "状态已变化"
				if err != nil {
					msg = err.Error()
				}
				e.log(tk.ID, "sys", "⚠ 恢复任务失败: "+msg)
				continue
			}
			e.log(tk.ID, "sys", "↻ 已从归档确认 agent 成功退出，恢复为完成")
			e.publishTask(tk.ID)
			continue
		}

		if _, err := workspace.Snapshot(tk, e.sessionsRoot); err != nil {
			e.log(tk.ID, "sys", "⚠ 恢复前保存任务工作区失败: "+err.Error())
			continue
		}
		mergeID, err := e.st.RecoverLostTaskAndCreateMerge(tk.ID, store.NewMergeTask(tk))
		if err != nil {
			e.log(tk.ID, "sys", "⚠ 恢复任务并创建代码合并任务失败: "+err.Error())
			continue
		}
		e.log(tk.ID, "sys", fmt.Sprintf("↻ 已从归档确认 agent 成功退出，恢复任务并创建代码合并任务 #%d", mergeID))
		e.log(mergeID, "sys", fmt.Sprintf("⇄ 由恢复的任务 #%d 自动创建，等待整合代码", tk.ID))
		e.publishTask(tk.ID)
		e.publishTask(mergeID)
		e.Wake()
	}
}

func isRecoverablePaneLoss(tk store.Task) bool {
	if tk.Status != store.StatusFailed || tk.ExitCode == nil || *tk.ExitCode != -1 {
		return false
	}
	return strings.HasPrefix(tk.Error, "专用 tmux window task-") &&
		strings.HasSuffix(tk.Error, "已消失，且未留下退出码")
}

// recoverInterrupted 服务重启时重新接管仍存在的专用 tmux window；只有找不到
// window 且没有退出码的任务才判定为中断。这样 Web/调度器重启不会杀掉长任务。
func (e *Executor) recoverInterrupted(ctx context.Context) {
	tasks, err := e.st.ListRunningTasks()
	if err != nil {
		return
	}
	for _, tk := range tasks {
		obs, err := e.runner.Poll(tk.ID, tk.TmuxLogOffset)
		if err != nil {
			e.markInterrupted(tk, "服务重启，未找到可恢复的 tmux 任务")
			continue
		}
		if err := e.syncTmuxOutput(&tk, obs); err != nil {
			e.markInterrupted(tk, "服务重启，恢复 tmux 日志失败: "+err.Error())
			continue
		}
		if obs.Done {
			e.log(tk.ID, "sys", "↻ 服务恢复：tmux 任务已退出，补收日志后结算")
			e.finishRun(tk, obs.ExitCode, exitError(obs.ExitCode), false)
			continue
		}
		if !obs.Alive {
			e.markInterrupted(tk, "服务重启，未找到可恢复的 tmux window")
			continue
		}
		if tk.AgentID == nil {
			e.markInterrupted(tk, "服务重启，任务未指派角色")
			continue
		}
		e.restoreAgentSlot(*tk.AgentID)
		e.restoreProjectSlot(tk)
		e.log(tk.ID, "sys", "↻ 服务恢复：重新接管专用 tmux window")
		go e.monitorRecovered(ctx, tk)
	}
}

func (e *Executor) markInterrupted(tk store.Task, msg string) {
	e.preserveTmuxFailureArtifacts(tk.ID, msg)
	_ = e.st.UpdateTask(tk.ID, map[string]any{
		"status": store.StatusFailed, "finished_at": store.Now(), "error": msg,
	})
	e.log(tk.ID, "sys", "✗ "+msg)
	e.publishTask(tk.ID)
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
	// 任务可能正处于服务刚恢复、尚未来得及登记 cancel 的窗口；直接终止其
	// 专用 tmux window 作为兜底。
	_ = e.runner.StopWithReason(id, "task_cancel")
}

// RemoveTask 在删除任务前停止 tmux window 并清理其运行时文件。
func (e *Executor) RemoveTask(id int64) {
	e.CancelTask(id)
	e.runner.Cleanup(id)
	_ = e.taskSessions.Remove(id)
}

// ResetTaskSession 让驳回重做等全新执行不复用旧会话。
func (e *Executor) ResetTaskSession(id int64) {
	_ = e.taskSessions.Remove(id)
}

// CleanupOrphanTaskSessions 清理当前 paihuo 实例自己的孤儿 agent 会话；
// 不会读取或删除其他数据库/实例的目录。
func (e *Executor) CleanupOrphanTaskSessions() (int, error) {
	return e.taskSessions.CleanupOrphans(e.st.HasTask)
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
	limits := make(map[int64]int)
	for _, tk := range tasks {
		if tk.AgentID == nil {
			continue
		}
		agentID := *tk.AgentID
		limit, ok := limits[agentID]
		if !ok {
			agent, err := e.st.GetAgent(agentID)
			if err != nil || !agent.Enabled {
				continue
			}
			limit = agent.ConcurrencyLimit()
			limits[agentID] = limit
		}
		if !e.reserveAgentSlot(agentID, limit) {
			continue
		}
		// 项目级串行门禁：非并发任务要求项目当前没有任何活跃任务。
		// 先占槽再领取，领取失败要回滚两个槽位。
		if !e.reserveProjectSlot(tk) {
			e.releaseAgentSlot(agentID)
			continue
		}
		claimed, err := e.st.ClaimTask(tk.ID)
		if err != nil || !claimed {
			e.releaseAgentSlot(agentID)
			e.releaseProjectSlot(tk)
			continue
		}
		go e.runTask(ctx, tk)
	}
}

// reserveAgentSlot 原子地尝试占用一个角色槽位。角色上限在调度时读取，
// 因此提高上限会在下一次 Wake/轮询立即生效；下调上限不会中断已有任务，
// 只会阻止新的任务继续进入直到占用数回落。
func (e *Executor) reserveAgentSlot(agentID int64, limit int) bool {
	if limit < 1 {
		limit = 1
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.active[agentID] >= limit {
		return false
	}
	e.active[agentID]++
	return true
}

// restoreAgentSlot 在服务重启后接管尚存 tmux window 时恢复其槽位。即使
// 配置已被下调，也必须先接管所有存量任务；它们结束后新上限自然生效。
func (e *Executor) restoreAgentSlot(agentID int64) {
	e.mu.Lock()
	e.active[agentID]++
	e.mu.Unlock()
}

func (e *Executor) releaseAgentSlot(agentID int64) {
	e.mu.Lock()
	if e.active[agentID] <= 1 {
		delete(e.active, agentID)
	} else {
		e.active[agentID]--
	}
	e.mu.Unlock()
}

// reserveProjectSlot 登记任务在项目中的占用，并执行非并发任务的串行门禁：
// 未勾选「并发执行」的任务要求该项目当前没有任何活跃任务（无论并发与否）
// 才允许启动，保证它不与同项目的任何任务重叠；显式勾选并发的任务不受门禁
// 约束，但同样登记占用，让后续非并发任务等它结束。没有项目的任务不受
// 项目级约束。
func (e *Executor) reserveProjectSlot(tk store.Task) bool {
	if tk.ProjectID == nil {
		return true
	}
	pid := *tk.ProjectID
	e.mu.Lock()
	defer e.mu.Unlock()
	if !tk.Concurrent && e.activeProj[pid] > 0 {
		return false
	}
	e.activeProj[pid]++
	return true
}

// releaseProjectSlot 任务结束（或领取失败）时释放其项目占用。
func (e *Executor) releaseProjectSlot(tk store.Task) {
	if tk.ProjectID == nil {
		return
	}
	pid := *tk.ProjectID
	e.mu.Lock()
	if e.activeProj[pid] <= 1 {
		delete(e.activeProj, pid)
	} else {
		e.activeProj[pid]--
	}
	e.mu.Unlock()
}

// restoreProjectSlot 服务重启后接管尚存 tmux window 时恢复其项目占用，
// 保证串行门禁不会在重启后错误放行同项目的新任务。
func (e *Executor) restoreProjectSlot(tk store.Task) {
	if tk.ProjectID == nil {
		return
	}
	e.mu.Lock()
	e.activeProj[*tk.ProjectID]++
	e.mu.Unlock()
}

func (e *Executor) runTask(ctx context.Context, tk store.Task) {
	agentID := *tk.AgentID
	defer func() {
		e.releaseAgentSlot(agentID)
		e.releaseProjectSlot(tk)
		e.Wake()
	}()

	// 原子开跑：若领取后任务已被取消/删除（cancel 与派发存在竞态），
	// 此处返回 false，不能把终态覆盖回 running。
	started, err := e.st.StartTask(tk.ID)
	if err != nil {
		e.log(tk.ID, "sys", "✗ 任务状态更新失败: "+err.Error())
		return
	}
	if !started {
		e.log(tk.ID, "sys", "■ 已取消")
		return
	}
	e.publishTask(tk.ID)

	fail := func(msg string) {
		e.runner.Cleanup(tk.ID)
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

	// 任务取消上下文独立于服务生命周期：服务重启时 tmux 任务继续运行，
	// 下次启动再重新接管；只有用户取消才会终止 task window。
	rctx, release := e.taskContext(tk.ID)
	defer release()

	e.log(tk.ID, "sys", fmt.Sprintf("▶ 开始执行：角色=%s CLI=%s 权限=%s", agent.Name, agent.CLI, tk.Perm))
	// 任务隔离工作空间：git worktree（独立分支+目录）；非 git 项目直接执行
	isGitProject := workspace.IsGitRepo(tk.ProjectDir)
	dir, branch, baseCommit, werr := workspace.Ensure(tk, e.sessionsRoot)
	if werr != nil {
		if isGitProject {
			fail("创建隔离代码工作空间失败: " + werr.Error())
			return
		}
		e.log(tk.ID, "sys", "⚠ "+werr.Error())
	}
	if isGitProject && branch == "" {
		fail("Git 项目未能创建隔离代码工作空间，已拒绝在主工作区执行")
		return
	}
	if branch != "" {
		_ = e.st.UpdateTask(tk.ID, map[string]any{"worktree_branch": branch, "base_commit": baseCommit})
		tk.WorktreeBranch = branch
		tk.BaseCommit = baseCommit
		e.log(tk.ID, "sys", fmt.Sprintf("🌿 独立工作空间: %s（分支 %s）", dir, branch))
	} else {
		e.log(tk.ID, "sys", "📁 在项目目录直接执行（非 git 仓库，无隔离）")
	}
	if tk.MergeOf != nil {
		source, err := e.st.GetTask(*tk.MergeOf)
		if err != nil {
			fail(fmt.Sprintf("读取待合并源任务 #%d 失败: %v", *tk.MergeOf, err))
			return
		}
		result, err := workspace.Integrate(*source, tk, e.sessionsRoot)
		if err != nil {
			fail(fmt.Sprintf("准备合并任务失败: %v", err))
			return
		}
		switch {
		case len(result.Conflicts) > 0:
			e.log(tk.ID, "sys", "⚠ 已导入源任务分支，以下冲突交给 agent 处理: "+strings.Join(result.Conflicts, "、"))
		case result.Skipped:
			e.log(tk.ID, "sys", "↻ 合并内容已准备或项目未启用 Git 隔离，交给 agent 检查")
		default:
			e.log(tk.ID, "sys", fmt.Sprintf("⇄ 已将源任务 #%d 的分支导入当前工作空间", *tk.MergeOf))
		}
	}

	if tk.RunMode == store.RunModeInteractive && agent.CLI != "pi" {
		fail("交互式任务目前只支持 Pi 角色")
		return
	}
	ro := RunOptions{Dir: dir, Prompt: taskPrompt(tk), Role: agent.RoleConfig, Perm: tk.Perm, RunMode: tk.RunMode}
	// instructions：任务指令模板，追加在提示词之前（适配器可按 CLI 映射为官方参数）
	if instr := strings.TrimSpace(agent.RoleConfig.Instructions); instr != "" {
		ro.Prompt = instr + "\n\n" + ro.Prompt
	}
	// 任务专属会话目录：会话隔离（同角色多任务互不干扰）；续跑任务复用原任务会话
	sessID := tk.ID
	if tk.ResumeOf != nil {
		sessID = *tk.ResumeOf
		e.log(tk.ID, "sys", fmt.Sprintf("↻ 续跑任务 #%d 的会话（attach 回上次对话）", sessID))
	}
	sessDir, sessErr := e.taskSessions.Ensure(sessID)
	if sessErr == nil {
		ro.SessionDir = sessDir
	} else {
		e.log(tk.ID, "sys", "⚠ 会话目录创建失败，任务会话可能互相干扰: "+sessErr.Error())
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
	if err := e.st.UpdateTmuxLogOffset(tk.ID, 0); err != nil {
		fail("重置 tmux 日志位置失败: " + err.Error())
		return
	}
	tk.TmuxLogOffset = 0
	e.log(tk.ID, "sys", fmt.Sprintf("▣ 专用 tmux：server=paihuo window=task-%d", tk.ID))
	batch := tk.RunMode != store.RunModeInteractive
	options := tmuxStartOptions{
		IsolateProcessGroup: batch,
		DetachTerminal:      batch && agent.CLI == "codex",
		IsolateCgroup:       batch && agent.CLI == "codex",
	}
	if err := e.runner.Start(tk.ID, dir, bin, args, env, options); err != nil {
		fail(err.Error())
		return
	}
	code, runErr := e.waitTmux(ctx, rctx, &tk)
	e.finishRun(tk, code, runErr, rctx.Err() != nil)
}

func (e *Executor) monitorRecovered(ctx context.Context, tk store.Task) {
	if tk.AgentID == nil {
		return
	}
	defer func() {
		e.releaseAgentSlot(*tk.AgentID)
		e.releaseProjectSlot(tk)
		e.Wake()
	}()
	rctx, release := e.taskContext(tk.ID)
	defer release()
	code, runErr := e.waitTmux(ctx, rctx, &tk)
	e.finishRun(tk, code, runErr, rctx.Err() != nil)
}

func (e *Executor) taskContext(taskID int64) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancels[taskID] = cancel
	e.mu.Unlock()
	return ctx, func() {
		e.mu.Lock()
		delete(e.cancels, taskID)
		e.mu.Unlock()
		cancel()
	}
}

const maxInteractiveInputBytes = 16 * 1024

// SendInput 将一条人工消息送入正在运行的 Pi 交互式任务。输入必须是单行，
// 以保证它在 Pi TUI 中是一条原子消息；复杂的初始指令仍由任务内容承载。
func (e *Executor) SendInput(taskID int64, text string) error {
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("消息不能为空")
	}
	if strings.ContainsAny(text, "\x00\r\n") {
		return fmt.Errorf("交互消息暂不支持换行")
	}
	if len(text) > maxInteractiveInputBytes {
		return fmt.Errorf("交互消息不能超过 %d KB", maxInteractiveInputBytes/1024)
	}
	tk, err := e.st.GetTask(taskID)
	if err != nil {
		return fmt.Errorf("读取任务失败: %w", err)
	}
	if tk.Status != store.StatusRunning {
		return fmt.Errorf("任务当前不是运行状态")
	}
	if tk.RunMode != store.RunModeInteractive {
		return fmt.Errorf("任务不是交互式 Pi 会话")
	}
	if tk.AgentID == nil {
		return fmt.Errorf("任务未指派角色")
	}
	agent, err := e.st.GetAgent(*tk.AgentID)
	if err != nil {
		return fmt.Errorf("读取角色失败: %w", err)
	}
	if agent.CLI != "pi" {
		return fmt.Errorf("交互式任务目前只支持 Pi 角色")
	}
	if err := e.runner.SendText(taskID, text); err != nil {
		return err
	}
	e.log(taskID, "in", text)
	return nil
}

// detachedResultSettleTimeout 是日志 pane 已结束、独立 Codex service 也已收尾
// 但 agent-exit-code 尚未写入时的最大结算时间。该文件由同一 agent wrapper
// 在退出前原子写入；短暂等待可覆盖 systemd --collect 与文件落盘的竞态，同时
// 仍能让真正丢失的任务在有限时间内失败。
const detachedResultSettleTimeout = 3 * time.Second

// waitTmux 将 tmux pipe-pane 文件增量同步到 SQLite，并等待 window 内命令退出。
// serviceCtx 取消表示 paihuo 自身退出，此时保留 task window；taskCtx 取消才终止任务。
func (e *Executor) waitTmux(serviceCtx, taskCtx context.Context, tk *store.Task) (int, error) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	var awaitingResultSince time.Time
	for {
		if err := taskCtx.Err(); err != nil {
			_ = e.runner.StopWithReason(tk.ID, "task_context_cancel")
			if obs, pollErr := e.runner.Poll(tk.ID, tk.TmuxLogOffset); pollErr == nil {
				_ = e.syncTmuxOutput(tk, obs)
			}
			return -1, err
		}
		if serviceCtx.Err() != nil {
			if obs, pollErr := e.runner.Poll(tk.ID, tk.TmuxLogOffset); pollErr == nil {
				_ = e.syncTmuxOutput(tk, obs)
			}
			return -1, errExecutorStopping
		}
		obs, err := e.runner.Poll(tk.ID, tk.TmuxLogOffset)
		if err != nil {
			return -1, err
		}
		if err := e.syncTmuxOutput(tk, obs); err != nil {
			return -1, err
		}
		if obs.Done {
			return obs.ExitCode, exitError(obs.ExitCode)
		}
		if obs.AwaitingAgentResult {
			if awaitingResultSince.IsZero() {
				awaitingResultSince = time.Now()
				e.log(tk.ID, "sys", "⏳ 日志 pane 已结束，等待独立 agent 写回退出结果")
			}
			if time.Since(awaitingResultSince) < detachedResultSettleTimeout {
				select {
				case <-serviceCtx.Done():
				case <-taskCtx.Done():
				case <-ticker.C:
				}
				continue
			}
			return -1, tmuxWindowLostError{taskID: tk.ID}
		}
		awaitingResultSince = time.Time{}
		if !obs.Alive {
			return -1, tmuxWindowLostError{taskID: tk.ID}
		}
		select {
		case <-serviceCtx.Done():
		case <-taskCtx.Done():
		case <-ticker.C:
		}
	}
}

func (e *Executor) syncTmuxOutput(tk *store.Task, obs tmuxObservation) error {
	for _, line := range obs.Lines {
		l, err := e.st.AppendLog(store.TaskLog{TaskID: tk.ID, Stream: "out", Content: line})
		if err != nil {
			return err
		}
		e.hub.Publish(events.Event{Type: "log", TaskID: tk.ID, Payload: l})
	}
	if obs.Offset != tk.TmuxLogOffset {
		if err := e.st.UpdateTmuxLogOffset(tk.ID, obs.Offset); err != nil {
			return err
		}
		tk.TmuxLogOffset = obs.Offset
	}
	return nil
}

func exitError(code int) error {
	if code == 0 {
		return nil
	}
	return fmt.Errorf("tmux 中的命令退出，exit=%d", code)
}

// finishRun 统一结算正常执行与服务重启后重新接管的 tmux 任务。
func (e *Executor) finishRun(tk store.Task, code int, runErr error, canceled bool) {
	if errors.Is(runErr, errExecutorStopping) {
		e.log(tk.ID, "sys", "⏸ paihuo 正在停止，专用 tmux 任务将继续运行并在下次启动后接管")
		return
	}
	if errors.Is(runErr, errTmuxWindowLost) {
		e.preserveTmuxFailureArtifacts(tk.ID, runErr.Error())
	} else {
		defer e.runner.Cleanup(tk.ID)
	}
	cur, _ := e.st.GetTask(tk.ID)
	if cur != nil && cur.Status == store.StatusCancelled {
		e.log(tk.ID, "sys", "■ 已取消")
		return
	}
	if runErr != nil {
		if canceled || errors.Is(runErr, context.Canceled) {
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
	if tk.MergeOf == nil && tk.Perm == store.PermReview {
		rounds := tk.ReviewRounds + 1
		_ = e.st.UpdateTask(tk.ID, map[string]any{
			"status": store.StatusAwaitingReview, "finished_at": store.Now(), "exit_code": 0, "review_rounds": rounds,
		})
		e.log(tk.ID, "sys", fmt.Sprintf("⏸ 第 %d 轮完成，等待审批", rounds))
		e.publishTask(tk.ID)
		return
	}
	// 普通 Git 任务不会直接改主分支：先固化源分支，再派发一个专属的
	// MergeOf 子任务。只有子任务完成时才真正 squash 合并，避免递归派发。
	if tk.MergeOf == nil && tk.WorktreeBranch != "" {
		if _, err := workspace.Snapshot(tk, e.sessionsRoot); err != nil {
			msg := "准备代码合并任务失败: " + err.Error()
			_ = e.st.UpdateTask(tk.ID, map[string]any{
				"status": store.StatusFailed, "finished_at": store.Now(), "exit_code": code, "error": msg,
			})
			e.log(tk.ID, "sys", "✗ "+msg)
			e.publishTask(tk.ID)
			return
		}
		mergeID, err := e.st.CompleteTaskAndCreateMerge(tk.ID, store.NewMergeTask(tk))
		if err != nil {
			if cur, getErr := e.st.GetTask(tk.ID); getErr == nil && cur.Status == store.StatusCancelled {
				e.log(tk.ID, "sys", "■ 已取消")
				return
			}
			msg := "创建代码合并任务失败: " + err.Error()
			_ = e.st.UpdateTask(tk.ID, map[string]any{
				"status": store.StatusFailed, "finished_at": store.Now(), "exit_code": code, "error": msg,
			})
			e.log(tk.ID, "sys", "✗ "+msg)
			e.publishTask(tk.ID)
			return
		}
		e.log(tk.ID, "sys", fmt.Sprintf("✓ 任务完成，已自动创建代码合并任务 #%d", mergeID))
		e.log(mergeID, "sys", fmt.Sprintf("⇄ 由任务 #%d 完成后自动创建，等待整合代码", tk.ID))
		e.publishTask(tk.ID)
		e.publishTask(mergeID)
		e.Wake()
		return
	}
	if tk.MergeOf != nil && tk.WorktreeBranch != "" {
		hash, err := workspace.Merge(tk, e.sessionsRoot)
		if err != nil {
			msg := "代码合并任务失败: " + err.Error()
			_ = e.st.UpdateTask(tk.ID, map[string]any{
				"status": store.StatusFailed, "finished_at": store.Now(), "exit_code": code, "error": msg,
			})
			e.log(tk.ID, "sys", "✗ "+msg)
			e.publishTask(tk.ID)
			return
		}
		if hash == "" {
			e.log(tk.ID, "sys", "✓ 代码合并完成（主分支无需新增提交）")
		} else {
			e.log(tk.ID, "sys", "✓ 已合并到主分支: "+hash)
		}
	}
	_ = e.st.UpdateTask(tk.ID, map[string]any{
		"status": store.StatusSucceeded, "finished_at": store.Now(), "exit_code": 0,
	})
	if tk.MergeOf == nil && tk.WorktreeBranch == "" {
		e.log(tk.ID, "sys", "✓ 完成（非 Git 项目，无需代码合并）")
	} else {
		e.log(tk.ID, "sys", "✓ 完成")
	}
	e.publishTask(tk.ID)
}

// preserveTmuxFailureArtifacts 在 tmux window 非正常消失时留下 run.sh、终端输出
// 和原因文件；任务续跑会建立新的运行文件，删除任务才会一并删除这些归档。
func (e *Executor) preserveTmuxFailureArtifacts(taskID int64, reason string) {
	// 如果异常发生在 Poll 失败而非窗口已消失的边界，先停止残留 window，避免一个
	// 已标记失败的 task 继续在后台执行。
	_ = e.runner.StopWithReason(taskID, "failure_archive")
	archive, err := e.runner.ArchiveFailureArtifacts(taskID, reason)
	if err != nil {
		e.log(taskID, "sys", "⚠ 保留 tmux 异常运行证据失败: "+err.Error())
		return
	}
	if archive != "" {
		e.log(taskID, "sys", "⚠ 专用 tmux 异常退出，运行证据已归档；删除任务时会一并清理")
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
