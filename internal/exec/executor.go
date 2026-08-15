package exec

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
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
// 项目级并发门禁只管理物理执行重叠；代码基线顺序由 Store 的依赖交付判定
// 管理。弱依赖会按项目执行顺序串起任务（默认按创建时间），强依赖只在前置交付成功后放行。
type Executor struct {
	st           *store.Store
	hub          *events.EventStream
	sessionsRoot string // 任务工作空间根目录（<db目录>/sessions）
	taskSessions *taskSessionStore
	runner       *tmuxRunner
	runtimes     *RuntimeService
	mu           sync.Mutex
	active       map[int64]int // 每个 Role 当前已占用的执行槽位数
	activeProj   map[int64]int // 每个 Project 当前活跃的任务数（非并发任务的串行门禁）
	activeRuns   map[int64]int // 每个 Workflow Run 当前活跃的节点数
	// cancels 是任务级取消句柄
	cancels map[int64]context.CancelFunc
	wake    chan struct{}

	// mergeReconcileMu 串行化「已完成源任务必须拥有唯一合并任务」的持久化
	// 对账；errors 仅用于避免不可恢复的 worktree 问题每 30 秒刷一遍日志。
	mergeReconcileMu     sync.Mutex
	mergeReconcileErrors map[int64]string
}

var errExecutorStopping = errors.New("paihuo 正在停止")
var errTmuxWindowLost = errors.New("专用 tmux window 已消失，且未留下退出码")

const mergeReconcileInterval = 30 * time.Second

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
func New(st *store.Store, hub *events.EventStream, sessionsRoot, instanceID string) *Executor {
	return NewWithRuntime(st, hub, sessionsRoot, instanceID, NewDefaultRuntimeService())
}

// NewWithRuntime injects the Runtime seam. Tests can use FakeRuntime without
// registering a fake CLI globally, and production uses the five built-ins.
func NewWithRuntime(st *store.Store, hub *events.EventStream, sessionsRoot, instanceID string, runtimes *RuntimeService) *Executor {
	return &Executor{
		st:                   st,
		hub:                  hub,
		sessionsRoot:         sessionsRoot,
		taskSessions:         newTaskSessionStore(sessionsRoot, instanceID),
		runner:               newTmuxRunner(sessionsRoot),
		runtimes:             runtimes,
		active:               make(map[int64]int),
		activeProj:           make(map[int64]int),
		activeRuns:           make(map[int64]int),
		cancels:              make(map[int64]context.CancelFunc),
		wake:                 make(chan struct{}, 1),
		mergeReconcileErrors: make(map[int64]string),
	}
}

func (e *Executor) RuntimeService() *RuntimeService { return e.runtimes }

// NewForTest 与 New 相同，但 tmux runner 使用独立 socket，避免测试触碰
// 生产 tmux 服务器（New 的 runner 固定使用 -L paihuo 与 session paihuo，
// 与线上实例共用同一 tmux server）。socket 必须是合法的 tmux socket 名。
func NewForTest(st *store.Store, hub *events.EventStream, sessionsRoot, instanceID, socket string) *Executor {
	e := New(st, hub, sessionsRoot, instanceID)
	e.runner = newTmuxRunnerAt(sessionsRoot, socket)
	return e
}

func (e *Executor) Start(ctx context.Context) {
	// 启动时就建立唯一的专用 session。即使暂时没有任务，运维也可直接
	// attach 观察；实际任务只会增减各自的 task-<id> window。
	if err := e.runner.ensureSession(); err != nil {
		log.Printf("⚠ 专用 tmux 执行器未就绪: %v", err)
	}
	e.reconcileMergeTasks()
	e.recoverInterrupted(ctx)
	e.reconcileRoleSkillDirs()
	go e.loop(ctx)
}

// reconcileMergeTasks 对账每一条已完成 Git 源任务的合并义务。正常路径通过
// CompleteTaskAndCreateMerge / ApproveTaskAndCreateMerge 在一个事务中完成，
// 这里覆盖保存源分支后创建子任务暂时失败的窄窗口。Store 的 merge_of
// 唯一索引保证重复扫描不会产生多个合并任务。
func (e *Executor) reconcileMergeTasks() {
	e.mergeReconcileMu.Lock()
	defer e.mergeReconcileMu.Unlock()
	if e.mergeReconcileErrors == nil {
		e.mergeReconcileErrors = make(map[int64]string)
	}

	tasks, err := e.st.ListCompletedGitTasksWithoutMerge()
	if err != nil {
		log.Printf("⚠ 扫描待补建代码合并任务失败: %v", err)
		return
	}
	pending := make(map[int64]bool, len(tasks))
	for _, tk := range tasks {
		pending[tk.ID] = true
		_ = cleanupRoleSkills(e.runner.skillManifestPath(tk.ID))
		if _, err := workspace.Snapshot(tk, e.sessionsRoot); err != nil {
			e.logMergeReconcileProblem(tk.ID, "保存待合并源任务工作区失败: "+err.Error())
			continue
		}
		mergeID, created, err := e.st.EnsureMergeTask(tk)
		if err != nil {
			// 任务可能恰好被删除、取消或由正常路径处理完成；下一轮扫描会
			// 自然消失。其余问题仅在首次（或错误变化时）记录一次。
			e.logMergeReconcileProblem(tk.ID, "补建代码合并任务失败: "+err.Error())
			continue
		}
		delete(e.mergeReconcileErrors, tk.ID)
		if !created {
			continue
		}
		e.log(tk.ID, "sys", fmt.Sprintf("↻ 自动合并对账：已补建代码合并任务 #%d", mergeID))
		e.log(mergeID, "sys", fmt.Sprintf("⇄ 由任务 #%d 的自动合并对账创建，等待整合代码", tk.ID))
		e.publishTask(tk.ID)
		e.publishTask(mergeID)
		e.Wake()
	}
	for id := range e.mergeReconcileErrors {
		if !pending[id] {
			delete(e.mergeReconcileErrors, id)
		}
	}
}

// roleSkillsDir 返回角色技能挂载目录（<sessionsRoot>/.roles/<roleID>）。
// 目录位于所有 worktree / 用户项目目录之外，技能副本/链接永远不会被提交。
func (e *Executor) roleSkillsDir(roleID int64) string {
	return filepath.Join(e.sessionsRoot, ".roles", fmt.Sprintf("%d", roleID))
}

// EnsureRoleSkills 幂等对账某个角色的技能挂载目录（供执行器与 server 钩子调用）。
func (e *Executor) EnsureRoleSkills(roleID int64, roleName string, selected []string) (*RoleSkillMount, error) {
	return EnsureRoleSkills(roleID, roleName, selected, e.roleSkillsDir(roleID))
}

// RemoveRoleSkills 删除角色的技能挂载目录。Role 删除后不保留历史副本。
func (e *Executor) RemoveRoleSkills(roleID int64) error {
	return os.RemoveAll(e.roleSkillsDir(roleID))
}

// reconcileRoleSkillDirs 服务启动时对账全部角色的技能挂载：
//  1. 每个角色执行 EnsureRoleSkills（幂等，新增/删除/断裂自愈）；
//  2. 删除清单存在但 Role 已删除的挂载目录。
func (e *Executor) reconcileRoleSkillDirs() {
	roles, err := e.st.ListRoles()
	if err != nil {
		log.Printf("⚠ 扫描角色技能目录失败: %v", err)
		return
	}
	active := make(map[int64]bool, len(roles))
	for _, a := range roles {
		active[a.ID] = true
		if _, err := e.EnsureRoleSkills(a.ID, a.Name, a.RoleConfig.Skills); err != nil {
			log.Printf("⚠ 对账角色 %d 技能目录失败: %v", a.ID, err)
		}
	}
	roleRoot := filepath.Join(e.sessionsRoot, ".roles")
	if entries, err := os.ReadDir(roleRoot); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			dir := filepath.Join(roleRoot, entry.Name())
			manifest, exists, err := loadRoleMountManifest(filepath.Join(dir, roleMountManifestName))
			if err != nil || !exists {
				continue // 无清单无法确认归属，交给 EnsureRoleSkills 处理
			}
			if active[manifest.RoleID] {
				continue
			}
			if err := os.RemoveAll(dir); err != nil {
				log.Printf("⚠ 删除无主角色技能目录 %s 失败: %v", dir, err)
			}
		}
	}
}

func (e *Executor) logMergeReconcileProblem(taskID int64, msg string) {
	if e.mergeReconcileErrors[taskID] == msg {
		return
	}
	e.mergeReconcileErrors[taskID] = msg
	e.log(taskID, "sys", "⚠ 自动合并对账："+msg)
}

// recoverInterrupted 服务重启时重新接管仍存在的专用 tmux window；只有找不到
// window 且没有退出码的任务才判定为中断。这样 Web/调度器重启不会杀掉长任务。
func (e *Executor) recoverInterrupted(ctx context.Context) {
	tasks, err := e.st.ListRunningTasks()
	if err != nil {
		return
	}
	for _, tk := range tasks {
		obs, err := e.pollTmux(&tk)
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
		if tk.RoleID == nil {
			e.markInterrupted(tk, "服务重启，任务未指派角色")
			continue
		}
		e.restoreRoleSlot(*tk.RoleID)
		e.restoreProjectSlot(tk)
		e.restoreWorkflowSlot(tk)
		e.log(tk.ID, "sys", "↻ 服务恢复：重新接管专用 tmux window")
		go e.monitorRecovered(ctx, tk)
	}
}

func (e *Executor) markInterrupted(tk store.Task, msg string) {
	_ = cleanupRoleSkills(e.runner.skillManifestPath(tk.ID))
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
	_ = cleanupRoleSkills(e.runner.skillManifestPath(id))
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
	lastMergeReconcile := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.wake:
		case <-t.C:
		}
		if time.Since(lastMergeReconcile) >= mergeReconcileInterval {
			e.reconcileMergeTasks()
			lastMergeReconcile = time.Now()
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
	runLimits := make(map[int64]int)
	for _, tk := range tasks {
		if tk.RoleID == nil {
			continue
		}
		// 先在持久化状态机中判断前置交付，避免源任务刚结束、合并子任务尚未
		// 写入主分支时让后续 worktree 从旧 HEAD 分叉。合并子任务没有用户依赖，
		// 且 ListQueuedTasks 已将它们排在实现任务之前。
		dependency, err := e.st.CheckTaskDependency(tk)
		if err != nil || !dependency.Ready {
			continue
		}
		if tk.WorkflowRunID != nil {
			runID := *tk.WorkflowRunID
			limit, ok := runLimits[runID]
			if !ok {
				limit, err = e.st.WorkflowRunConcurrencyLimit(runID)
				if err != nil {
					continue
				}
				runLimits[runID] = limit
			}
			if !e.reserveWorkflowSlot(tk, limit) {
				continue
			}
		}
		roleID := *tk.RoleID
		limit, ok := limits[roleID]
		if !ok {
			agent, err := e.st.GetRole(roleID)
			if err != nil || !agent.Enabled {
				e.releaseWorkflowSlot(tk)
				continue
			}
			limit = agent.ConcurrencyLimit()
			limits[roleID] = limit
		}
		if !e.reserveRoleSlot(roleID, limit) {
			e.releaseWorkflowSlot(tk)
			continue
		}
		// 项目级串行门禁：非并发任务要求项目当前没有任何活跃任务。
		// 先占槽再领取，领取失败要回滚两个槽位。
		if !e.reserveProjectSlot(tk) {
			e.releaseRoleSlot(roleID)
			e.releaseWorkflowSlot(tk)
			continue
		}
		claimed, err := e.st.ClaimTask(tk.ID)
		if err != nil || !claimed {
			e.releaseRoleSlot(roleID)
			e.releaseProjectSlot(tk)
			e.releaseWorkflowSlot(tk)
			continue
		}
		go e.runTask(ctx, tk)
	}
}

// reserveRoleSlot 原子地尝试占用一个角色槽位。角色上限在调度时读取，
// 因此提高上限会在下一次 Wake/轮询立即生效；下调上限不会中断已有任务，
// 只会阻止新的任务继续进入直到占用数回落。
func (e *Executor) reserveRoleSlot(roleID int64, limit int) bool {
	if limit < 1 {
		limit = 1
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.active[roleID] >= limit {
		return false
	}
	e.active[roleID]++
	return true
}

// restoreRoleSlot 在服务重启后接管尚存 tmux window 时恢复其槽位。即使
// 配置已被下调，也必须先接管所有存量任务；它们结束后新上限自然生效。
func (e *Executor) restoreRoleSlot(roleID int64) {
	e.mu.Lock()
	e.active[roleID]++
	e.mu.Unlock()
}

func (e *Executor) releaseRoleSlot(roleID int64) {
	e.mu.Lock()
	if e.active[roleID] <= 1 {
		delete(e.active, roleID)
	} else {
		e.active[roleID]--
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

// reserveWorkflowSlot enforces the frozen Plan's cross-Role concurrency cap.
func (e *Executor) reserveWorkflowSlot(tk store.Task, limit int) bool {
	if tk.WorkflowRunID == nil {
		return true
	}
	if limit < 1 {
		limit = 1
	}
	runID := *tk.WorkflowRunID
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.activeRuns[runID] >= limit {
		return false
	}
	e.activeRuns[runID]++
	return true
}

func (e *Executor) releaseWorkflowSlot(tk store.Task) {
	if tk.WorkflowRunID == nil {
		return
	}
	runID := *tk.WorkflowRunID
	e.mu.Lock()
	if e.activeRuns[runID] <= 1 {
		delete(e.activeRuns, runID)
	} else {
		e.activeRuns[runID]--
	}
	e.mu.Unlock()
}

func (e *Executor) restoreWorkflowSlot(tk store.Task) {
	if tk.WorkflowRunID == nil {
		return
	}
	e.mu.Lock()
	e.activeRuns[*tk.WorkflowRunID]++
	e.mu.Unlock()
}

func (e *Executor) runTask(ctx context.Context, tk store.Task) {
	roleID := *tk.RoleID
	defer func() {
		e.releaseRoleSlot(roleID)
		e.releaseProjectSlot(tk)
		e.releaseWorkflowSlot(tk)
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
		_ = cleanupRoleSkills(e.runner.skillManifestPath(tk.ID))
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

	agent, err := e.st.GetRole(roleID)
	if err != nil {
		fail("角色不存在: " + err.Error())
		return
	}
	if !e.runtimes.Has(agent.RuntimeID) {
		fail("未知 Runtime: " + agent.RuntimeID)
		return
	}

	// 任务取消上下文独立于服务生命周期：服务重启时 tmux 任务继续运行，
	// 下次启动再重新接管；只有用户取消才会终止 task window。
	rctx, release := e.taskContext(tk.ID)
	defer release()

	e.log(tk.ID, "sys", fmt.Sprintf("▶ 开始执行：角色=%s CLI=%s 权限=%s", agent.Name, agent.RuntimeID, tk.Perm))
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
		// 代码合并最终要把任务分支写入主分支；主工作区的未提交改动会阻塞
		// 合并。在 agent 启动前检测，让合并任务立即失败而不是白跑一轮。
		if dirty, err := workspace.MainWorktreeDirty(tk.ProjectDir); err != nil {
			fail("检查主工作区失败: " + err.Error())
			return
		} else if dirty {
			fail("主工作区存在未提交改动，无法执行代码合并；请先提交或暂存主工作区的改动，再重试本合并任务")
			return
		}
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
			// 无冲突：平台直接整合，跳过 agent。合并任务的核心增量只是
			// 「验证 + 跑测试」，无冲突时这一轮 agent 是纯开销；源任务成功
			// 退出即代表其自我验证通过，信任模型与源任务一致。
			e.log(tk.ID, "sys", fmt.Sprintf("⇄ 已将源任务 #%d 的分支导入当前工作空间，无冲突，平台直接整合", *tk.MergeOf))
			hash, err := workspace.Merge(tk, e.sessionsRoot)
			if err != nil {
				msg := "自动合并失败: " + err.Error()
				e.log(tk.ID, "sys", "✗ "+msg)
				_ = e.st.UpdateTask(tk.ID, map[string]any{
					"status": store.StatusFailed, "finished_at": store.Now(), "exit_code": 1, "error": msg,
				})
				e.publishTask(tk.ID)
				return
			}
			if hash == "" {
				e.log(tk.ID, "sys", "✓ 无冲突，平台已自动合并（主分支无需新增提交）")
			} else {
				e.log(tk.ID, "sys", "✓ 无冲突，平台已自动合并到主分支: "+hash)
			}
			_ = e.st.UpdateTask(tk.ID, map[string]any{
				"status": store.StatusSucceeded, "finished_at": store.Now(), "exit_code": 0,
			})
			e.publishTask(tk.ID)
			return
		}
	}

	preparedSkills, err := e.EnsureRoleSkills(roleID, agent.Name, agent.RoleConfig.Skills)
	if err != nil {
		fail("加载角色技能失败: " + err.Error())
		return
	}
	if len(preparedSkills.Bindings) > 0 {
		names := make([]string, 0, len(preparedSkills.Bindings))
		for _, binding := range preparedSkills.Bindings {
			names = append(names, binding.OriginalName)
		}
		e.log(tk.ID, "sys", "🧩 已启用角色技能: "+strings.Join(names, "、"))
	}
	for _, w := range preparedSkills.Warnings {
		e.log(tk.ID, "sys", "⚠ "+w)
	}
	// codex 只能从 $HOME/.agents/skills（USER scope）加载外部技能：任务级
	// symlink 挂载（唯一名 paihuo-<taskID>-...），清单在 tmux 运行目录，
	// 结算时由 cleanupRoleSkills 按清单删除。
	if agent.RuntimeID == "codex" && len(preparedSkills.SkillPaths) > 0 {
		if err := MountCodexSkills(tk.ID, preparedSkills, e.runner.skillManifestPath(tk.ID)); err != nil {
			fail("挂载 codex 角色技能失败: " + err.Error())
			return
		}
	}
	ro := ExecutionRequest{
		Dir:        dir,
		Prompt:     taskPrompt(tk),
		Role:       agent.RoleConfig,
		Perm:       tk.Perm,
		RunMode:    tk.RunMode,
		SkillMount: preparedSkills,
	}
	// 非 git 项目 + codex（safe 模式）：codex 拒绝在非 git 目录执行，
	// 但 --skip-git-repo-check 可单独使用（不依赖 yolo），本次调用注入，
	// 不动角色配置、不 git init 用户目录。
	if !isGitProject && agent.RuntimeID == "codex" && agent.RoleConfig.Custom["execution_mode"] != "yolo" {
		ro.SkipGitCheck = true
	}
	// 技能上下文属于角色 system prompt，不混入用户任务指令。
	if skillPrompt := buildRoleSkillsPrompt(preparedSkills.Bindings); skillPrompt != "" {
		ro.Role.SystemPrompt = AppendSystemPrompt(ro.Role.SystemPrompt, skillPrompt)
	}
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
	spec, err := e.runtimes.Prepare(agent.RuntimeID, ro)
	if err != nil {
		fail(err.Error())
		return
	}
	for _, warning := range spec.Warnings {
		e.log(tk.ID, "sys", "⚠ "+warning)
	}
	e.log(tk.ID, "sys", "$ "+shellJoin(append([]string{spec.Bin}, spec.Args...)))
	if err := e.st.UpdateTmuxLogOffset(tk.ID, 0); err != nil {
		fail("重置 tmux 日志位置失败: " + err.Error())
		return
	}
	tk.TmuxLogOffset = 0
	e.log(tk.ID, "sys", fmt.Sprintf("▣ 专用 tmux：server=paihuo window=task-%d", tk.ID))
	batch := tk.RunMode != store.RunModeInteractive
	options := tmuxStartOptions{
		IsolateProcessGroup: batch,
		DetachTerminal:      batch && agent.RuntimeID == "codex",
		IsolateCgroup:       batch && agent.RuntimeID == "codex",
	}
	if !batch {
		options.TerminalColumns = interactiveTerminalColumns
		options.TerminalRows = interactiveTerminalRows
	}
	if err := e.runner.Start(tk.ID, dir, spec.Bin, spec.Args, spec.Env, options); err != nil {
		fail(err.Error())
		return
	}
	// 记录窗口初始尺寸：任务结束后前端按此重放最后画面。
	if !batch {
		_ = e.st.UpdateTerminalSize(tk.ID, options.TerminalColumns, options.TerminalRows)
	}
	code, runErr := e.waitTmux(ctx, rctx, &tk)
	e.finishRun(tk, code, runErr, rctx.Err() != nil)
}

func (e *Executor) monitorRecovered(ctx context.Context, tk store.Task) {
	if tk.RoleID == nil {
		return
	}
	defer func() {
		e.releaseRoleSlot(*tk.RoleID)
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

func (e *Executor) validateInteractiveInputTarget(taskID int64) error {
	tk, err := e.st.GetTask(taskID)
	if err != nil {
		return fmt.Errorf("读取任务失败: %w", err)
	}
	if tk.Status != store.StatusRunning {
		return fmt.Errorf("任务当前不是运行状态")
	}
	if tk.RunMode != store.RunModeInteractive {
		return fmt.Errorf("任务不是交互式会话")
	}
	if tk.RoleID == nil {
		return fmt.Errorf("任务未指派角色")
	}
	if _, err := e.st.GetRole(*tk.RoleID); err != nil {
		return fmt.Errorf("读取角色失败: %w", err)
	}
	return nil
}

// Resize 同步浏览器 xterm 的尺寸到交互任务窗口。只对运行中的交互式任务
// 生效；任务结束或窗口丢失后由 tmuxRunner.Resize 拒绝。
func (e *Executor) Resize(taskID int64, cols, rows int) error {
	if err := e.validateInteractiveInputTarget(taskID); err != nil {
		return err
	}
	if cols < minInteractiveCols || cols > maxInteractiveCols {
		return fmt.Errorf("终端列数必须在 %d-%d 之间", minInteractiveCols, maxInteractiveCols)
	}
	if rows < minInteractiveRows || rows > maxInteractiveRows {
		return fmt.Errorf("终端行数必须在 %d-%d 之间", minInteractiveRows, maxInteractiveRows)
	}
	if err := e.runner.Resize(taskID, cols, rows); err != nil {
		return err
	}
	// 同步成功后记录尺寸，供任务结束后按原尺寸重放画面。
	return e.st.UpdateTerminalSize(taskID, cols, rows)
}

// EndSession 向运行中的交互式任务发送该 CLI 的退出命令（pi 为 /quit，
// 其余 /exit），让 agent 自行收尾退出；任务按正常退出结果结算，而非
// 被硬性取消。
func (e *Executor) EndSession(taskID int64) (string, error) {
	if err := e.validateInteractiveInputTarget(taskID); err != nil {
		return "", err
	}
	tk, err := e.st.GetTask(taskID)
	if err != nil {
		return "", err
	}
	agent, err := e.st.GetRole(*tk.RoleID)
	if err != nil {
		return "", fmt.Errorf("读取角色失败: %w", err)
	}
	driver, ok := e.runtimes.Session(agent.RuntimeID)
	if !ok {
		return "", fmt.Errorf("Runtime %s 不支持交互会话", agent.RuntimeID)
	}
	cmd := driver.ExitCommand()
	if err := e.runner.SendText(taskID, cmd); err != nil {
		return "", err
	}
	e.log(taskID, "in", cmd)
	return cmd, nil
}

// SendInput 将一条人工消息送入正在运行的交互式任务。输入必须是单行，
// 以保证它在 agent TUI 中是一条原子消息；复杂的初始指令仍由任务内容承载。
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
	if err := e.validateInteractiveInputTarget(taskID); err != nil {
		return err
	}
	if err := e.runner.SendText(taskID, text); err != nil {
		return err
	}
	e.log(taskID, "in", text)
	return nil
}

// SendKeystrokes 把浏览器 xterm 产生的原始按键序列送入 agent TUI。与 SendInput
// 不同，它不会自动补 Enter，也不会逐键写入任务日志；这样 Tab、方向键、Esc
// 和组合键仍由当前 CLI 自己解释，命令补全及选择器可以按原生方式工作。
func (e *Executor) SendKeystrokes(taskID int64, keys string) error {
	if keys == "" {
		return fmt.Errorf("按键内容不能为空")
	}
	if strings.ContainsRune(keys, '\x00') {
		return fmt.Errorf("按键内容不能包含 NUL")
	}
	if len(keys) > maxInteractiveInputBytes {
		return fmt.Errorf("单次按键内容不能超过 %d KB", maxInteractiveInputBytes/1024)
	}
	if err := e.validateInteractiveInputTarget(taskID); err != nil {
		return err
	}
	return e.runner.SendKeystrokes(taskID, keys)
}

const (
	// 交互终端尺寸上下限。浏览器端 xterm fit 后的实际尺寸在此范围内同步到
	// tmux；下限避免 resize-window 拒绝极小窗口，上限防止误传巨值刷爆 pane。
	minInteractiveCols, maxInteractiveCols = 20, 1000
	minInteractiveRows, maxInteractiveRows = 5, 300

	// detachedResultSettleTimeout 只适用于已确认独立 Codex service 正在收尾
	// 或已经结束、但 agent-exit-code 尚未写入的最终结算窗口。该文件由同一
	// agent wrapper 在退出前原子写入；15 秒覆盖 systemd --collect 与文件
	// 落盘竞态，同时仍能让真正丢失的任务在有限时间内失败。
	detachedResultSettleTimeout = 15 * time.Second

	// detachedUnknownQuietTimeout 适用于 pane 已丢、但 systemctl 暂时不能
	// 确认独立 agent 状态的观测故障。原始输出每次增长都会重置此计时；因此
	// agent 仍在工作的任务不会因一次 D-Bus/systemd 查询失败被误判。即使
	// 完全无输出，也保留足以覆盖历史 8 分钟 pane 丢失的长观察窗口。
	detachedUnknownQuietTimeout = 15 * time.Minute
)

// waitTmux 将 tmux pipe-pane 文件增量同步到 SQLite，并等待 window 内命令退出。
// serviceCtx 取消表示 paihuo 自身退出，此时保留 task window；taskCtx 取消才终止任务。
func (e *Executor) pollTmux(tk *store.Task) (tmuxObservation, error) {
	if tk.RunMode == store.RunModeInteractive {
		return e.runner.PollInteractive(tk.ID, tk.TmuxLogOffset)
	}
	return e.runner.Poll(tk.ID, tk.TmuxLogOffset)
}

func (e *Executor) waitTmux(serviceCtx, taskCtx context.Context, tk *store.Task) (int, error) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	var awaitingResultSince time.Time
	var unknownQuietSince time.Time
	var lastAgentOutputSize int64 = -1
	for {
		if err := taskCtx.Err(); err != nil {
			_ = e.runner.StopWithReason(tk.ID, "task_context_cancel")
			if obs, pollErr := e.pollTmux(tk); pollErr == nil {
				_ = e.syncTmuxOutput(tk, obs)
			}
			return -1, err
		}
		if serviceCtx.Err() != nil {
			if obs, pollErr := e.pollTmux(tk); pollErr == nil {
				_ = e.syncTmuxOutput(tk, obs)
			}
			return -1, errExecutorStopping
		}
		obs, err := e.pollTmux(tk)
		if err != nil {
			return -1, err
		}
		if err := e.syncTmuxOutput(tk, obs); err != nil {
			return -1, err
		}
		if obs.Done {
			return obs.ExitCode, exitError(obs.ExitCode)
		}
		now := time.Now()
		outputProgressed := obs.DetachedAgent && obs.AgentOutputSize > lastAgentOutputSize
		if obs.DetachedAgent && obs.AgentOutputSize > lastAgentOutputSize {
			lastAgentOutputSize = obs.AgentOutputSize
		}
		if obs.AwaitingAgentResult {
			if awaitingResultSince.IsZero() {
				awaitingResultSince = now
				e.log(tk.ID, "sys", "⏳ 日志 pane 已结束，独立 agent 已进入收尾，等待写回退出结果")
			} else if outputProgressed {
				// agent-output.log 仍在增长说明真实 agent 仍有活动；把最终
				// 结算窗口从最后一次活动重新开始，而非截断一个仍在运行的任务。
				awaitingResultSince = now
			}
			unknownQuietSince = time.Time{}
			if now.Sub(awaitingResultSince) < detachedResultSettleTimeout {
				select {
				case <-serviceCtx.Done():
				case <-taskCtx.Done():
				case <-ticker.C:
				}
				continue
			}
			return -1, tmuxWindowLostError{taskID: tk.ID}
		}
		if obs.DetachedAgent && obs.AgentState == agentServiceUnknown && obs.Alive {
			awaitingResultSince = time.Time{}
			if unknownQuietSince.IsZero() {
				unknownQuietSince = now
				e.log(tk.ID, "sys", "⏳ 日志 pane 已结束，暂时无法确认独立 agent 状态；继续观察原始输出和退出结果")
			} else if outputProgressed {
				unknownQuietSince = now
			}
			if now.Sub(unknownQuietSince) < detachedUnknownQuietTimeout {
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
		unknownQuietSince = time.Time{}
		if !obs.Alive {
			// 窗口消失时退出码文件可能仍在落盘（run.sh 先写退出码再退出，但
			// 外部 kill-window 可能恰好在写入窗口内发生）。短暂宽限后重读一次：
			// 正常完成的短任务不再被误判为窗口丢失，真异常仍按原路径结算失败。
			select {
			case <-serviceCtx.Done():
			case <-taskCtx.Done():
			case <-time.After(3 * time.Second):
			}
			obs, err = e.pollTmux(tk)
			if err != nil {
				return -1, err
			}
			if err := e.syncTmuxOutput(tk, obs); err != nil {
				return -1, err
			}
			if obs.Done {
				return obs.ExitCode, exitError(obs.ExitCode)
			}
			if obs.Alive {
				continue
			}
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
	stream := "out"
	if tk.RunMode == store.RunModeInteractive {
		// 交互 TUI 是连续字节流，不是逐行日志。term 让前端不插入换行，
		// 从而保留输入回显、光标移动和同步重绘控制序列。
		stream = "term"
	}
	for _, line := range obs.Lines {
		l, err := e.st.AppendLog(store.TaskLog{TaskID: tk.ID, Stream: stream, Content: line})
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
	if err := cleanupRoleSkills(e.runner.skillManifestPath(tk.ID)); err != nil {
		e.log(tk.ID, "sys", "⚠ 清理角色技能副本失败: "+err.Error())
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
			if e.keepCompletedSourceForMergeReconciliation(tk) {
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

// keepCompletedSourceForMergeReconciliation 保留 agent 已经成功完成、且源
// worktree 已快照的代码结果。创建合并子任务的原子事务偶发报错时，不能把
// 源任务误写成 failed；先持久化为 succeeded，再由 reconcileMergeTasks 幂等地
// 补建唯一子任务。返回 true 表示调用方不应继续走失败结算。
func (e *Executor) keepCompletedSourceForMergeReconciliation(tk store.Task) bool {
	cur, err := e.st.GetTask(tk.ID)
	if err == nil {
		if cur.Status == store.StatusCancelled {
			e.log(tk.ID, "sys", "■ 已取消")
			return true
		}
		if cur.Status == store.StatusSucceeded && cur.MergeOf == nil && cur.WorktreeBranch != "" {
			e.log(tk.ID, "sys", "⚠ 代码已完成，正在对账代码合并任务")
			e.publishTask(tk.ID)
			e.reconcileMergeTasks()
			e.Wake()
			return true
		}
	}

	marked, markErr := e.st.MarkTaskSucceededAwaitingMerge(tk.ID)
	if markErr != nil {
		e.log(tk.ID, "sys", "⚠ 保存待对账的代码合并状态失败: "+markErr.Error())
		return false
	}
	if !marked {
		return false
	}
	e.log(tk.ID, "sys", "⚠ 代码已完成，合并任务创建暂未完成；系统将自动补建")
	e.publishTask(tk.ID)
	e.reconcileMergeTasks()
	e.Wake()
	return true
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
