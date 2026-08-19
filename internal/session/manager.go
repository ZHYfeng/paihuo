package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

// Manager 是会话生命周期管理器：
//   - CRUD + 状态机（created → active ⇄ suspended → delivered / deleted）
//   - pi RPC 进程池（每会话一个进程；挂起杀进程，恢复 switch_session）
//   - 角色并发槽位与批处理任务共用（防资源耗尽）
//   - RPC 事件 → SSE 广播 + last_message_at 落库
//   - 崩溃检测：进程退出且状态 active → 自动置 suspended（transcript 不丢）
type Manager struct {
	st              *store.Store
	hub             *events.EventStream
	ex              *exec.Executor
	runtimes        *exec.RuntimeService
	sessionsRoot    string
	runtimeSessions string // <sessionsRoot>/.runtime-sessions（与任务会话平级，session- 前缀）
	dshHosts        *dshHostPool

	mu    sync.Mutex
	procs map[int64]sessionChannel // pi/omp RPC 进程 / dsh HTTP 会话通道
	// stopping 置位后禁止再启动新进程（服务关闭）
	stopping bool
	stopIdle chan struct{} // 空闲挂起巡检停止信号（Stop 时关闭）
}

// New 创建会话管理器。ex 用于共享角色并发槽位；instanceID 用于隔离
// .runtime-sessions 命名空间（与 Executor 同源）。
func New(st *store.Store, hub *events.EventStream, ex *exec.Executor, sessionsRoot, instanceID string) *Manager {
	_ = instanceID // 会话目录用 session-<id> 前缀天然隔离，不参与实例命名空间
	runtimes := exec.NewDefaultRuntimeService()
	if ex != nil {
		runtimes = ex.RuntimeService()
	}
	runtimeSessions := filepath.Join(sessionsRoot, ".runtime-sessions")
	return &Manager{
		st:              st,
		hub:             hub,
		ex:              ex,
		runtimes:        runtimes,
		sessionsRoot:    sessionsRoot,
		runtimeSessions: runtimeSessions,
		dshHosts:        newDSHHostPool(runtimeSessions),
		procs:           make(map[int64]sessionChannel),
		stopIdle:        make(chan struct{}),
	}
}

// sessionDirOf 返回会话的 pi 会话文件目录。
func (m *Manager) sessionDirOf(id int64) string {
	return filepath.Join(m.runtimeSessions, fmt.Sprintf("session-%d", id))
}

// stderrPathOf 返回会话进程的 stderr 日志路径。
func (m *Manager) stderrPathOf(id int64) string {
	return filepath.Join(m.sessionDirOf(id), "stderr.log")
}

// ---------------------------------------------------------------------------
// CRUD

// Create 创建会话，标题自动使用对应角色名称：git 项目建隔离 worktree
// （sessions/<project>/session-<id>），非 git 项目复制到专属会话目录，无项目时使用独立空目录
// （sessions/session-<id>，不关联任何项目）。perm 决定 dsh 会话路由到哪个宿主
// （full=免审批 / review=沙箱+人工审批）；pi/omp 会话不使用该字段。
func (m *Manager) Create(projectID *int64, roleID int64, perm string) (*store.Task, error) {
	if perm == "" {
		perm = store.PermFull
	}
	if perm != store.PermFull && perm != store.PermReview {
		return nil, fmt.Errorf("非法的权限模式: %s", perm)
	}
	agent, err := m.st.GetRole(roleID)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, fmt.Errorf("角色不存在: %d", roleID)
	}
	var project *store.Project
	if projectID != nil {
		project, err = m.st.GetProject(*projectID)
		if err != nil {
			return nil, err
		}
		if project == nil {
			return nil, fmt.Errorf("项目不存在: %d", *projectID)
		}
	}
	if err := m.validateCreate(*agent); err != nil {
		return nil, err
	}
	// 先建记录拿 id，再建 worktree（路径含会话 id）。
	ss := store.Task{
		ProjectID: projectID,
		RoleID:    &roleID,
		Title:     agent.Name,
		Status:    store.SessionStatusCreated,
		Perm:      perm,
	}
	id, err := m.st.CreateSessionTask(ss)
	if err != nil {
		return nil, fmt.Errorf("创建会话失败: %w", err)
	}
	// 重新读取（CreateSessionTask 内部补齐时间戳，值拷贝不回传）。
	ss2, err := m.st.GetSessionTask(id)
	if err != nil {
		return nil, err
	}
	if ss2 == nil {
		return nil, fmt.Errorf("会话创建后读取失败: %d", id)
	}
	ss = *ss2

	projDir, projName := projectDirOf(project), projectNameOf(project)
	dir, branch, base, err := workspace.EnsureSessionWorktree(projDir, m.sessionsRoot, projName, id)
	if err != nil {
		return nil, fmt.Errorf("创建会话工作区失败: %w", err)
	}
	if err := os.MkdirAll(m.sessionDirOf(id), 0o755); err != nil {
		return nil, fmt.Errorf("创建会话目录失败: %w", err)
	}
	set := map[string]any{
		"worktree_path": dir, "worktree_branch": branch, "base_commit": base,
		"session_dir": m.sessionDirOf(id), "updated_at": store.Now(),
	}
	if err := m.st.UpdateTask(id, set); err != nil {
		return nil, err
	}
	ss.WorktreePath, ss.WorktreeBranch, ss.BaseCommit, ss.SessionDir = dir, branch, base, m.sessionDirOf(id)
	m.publishUpdated(ss)
	return &ss, nil
}

// Get 返回单个会话。
func (m *Manager) Get(id int64) (*store.Task, error) {
	return m.st.GetSessionTask(id)
}

// List 列出会话（默认不含 deleted）。
func (m *Manager) List(f store.SessionFilter) ([]store.Task, error) {
	return m.st.ListSessionTasks(f.ProjectID, f.RoleID, f.Status, f.IncludeDeleted)
}

// ---------------------------------------------------------------------------
// 生命周期

// Start 启动会话进程（created/suspended → active）。resume 时先扫描旧会话
// 文件，spawn 后 switch_session 接续原会话。
func (m *Manager) Start(ctx context.Context, id int64) error {
	_ = ctx // 进程生命周期独立于请求：spawn 不绑定请求 ctx
	ss, err := m.st.GetSessionTask(id)
	if err != nil {
		return err
	}
	if ss == nil {
		return ErrSessionNotFound
	}
	if !CanTransition(ss.Status, store.SessionStatusActive) {
		log.Printf("⚠ DEBUG start(%d): status=%q", id, ss.Status)
		return transitionErr(ss.Status, store.SessionStatusActive)
	}
	agent, err := m.st.GetRole(*ss.RoleID)
	if err != nil {
		return err
	}
	if agent == nil {
		return fmt.Errorf("角色不存在: %d", ss.RoleID)
	}
	if !agent.Enabled {
		return fmt.Errorf("角色「%s」已停用", agent.Name)
	}
	if !m.ex.ReserveRoleSlot(agent.ID, agent.ConcurrencyLimit()) {
		return fmt.Errorf("角色「%s」并发已满（上限 %d），请挂起部分会话或等任务完成", agent.Name, agent.ConcurrencyLimit())
	}

	dir := ss.WorktreePath
	if dir == "" {
		dir = m.projectDir(ss) // 非 git / 无 worktree 回退
	}
	// 结构化会话只支持 pi / omp（RPC 消息流通道）与 dsh（HTTP ApiProxy 会话）。
	if _, ok := m.runtimes.Session(agent.RuntimeID); !ok && agent.RuntimeID != "dsh" {
		m.ex.ReleaseRoleSlot(agent.ID)
		return fmt.Errorf("Runtime %s 不提供结构化会话能力", agent.RuntimeID)
	}
	if err := m.startChannel(ss, *agent, dir); err != nil {
		m.ex.ReleaseRoleSlot(agent.ID)
		return err
	}

	now := store.Now()
	set := map[string]any{"status": store.SessionStatusActive, "started_at": now, "updated_at": now}
	if err := m.st.UpdateTask(id, set); err != nil {
		m.stopChannel(id)
		return err
	}
	m.publishUpdated(*ss)
	return nil
}

// startChannel 按 Runtime 启动会话通道：
//   - pi/omp：spawn RPC 进程，挂起恢复时 switch_session 接续原会话
//   - dsh：在对应权限宿主上 session.create（恢复时原 sessionId 接回）
func (m *Manager) startChannel(ss *store.Task, agent store.Role, dir string) error {
	var ch sessionChannel
	if agent.RuntimeID == "dsh" {
		dc, err := m.spawnDsh(ss, agent, dir)
		if err != nil {
			return err
		}
		ch = dc
	} else {
		proc, err := m.spawn(ss, agent, dir)
		if err != nil {
			return err
		}
		if ss.Status == store.SessionStatusSuspended {
			if f := latestSessionFile(ss.SessionDir); f != "" {
				if _, err := proc.runCommand(context.Background(), "switch_session", map[string]any{"sessionPath": f}, cmdTimeout); err != nil {
					log.Printf("⚠ 会话 %d 恢复 switch_session 失败: %v（降级为新会话）", ss.ID, err)
				}
			}
		}
		ch = proc
	}
	m.mu.Lock()
	m.procs[ss.ID] = ch
	m.mu.Unlock()
	return nil
}

// stopChannel 停止会话的执行通道（RPC 进程或 dsh 会话订阅）。
func (m *Manager) stopChannel(id int64) {
	if proc := m.detach(id); proc != nil {
		proc.terminate()
	}
}

// spawnDsh 在按权限路由的 dsh 宿主上创建/恢复会话通道并订阅事件流。
func (m *Manager) spawnDsh(ss *store.Task, agent store.Role, cwd string) (*dshChannel, error) {
	perm := dshPermOf(ss.Perm)
	addr, err := m.dshHosts.addr(context.Background(), perm)
	if err != nil {
		return nil, err
	}
	resume := ""
	if ss.Status == store.SessionStatusSuspended {
		resume = readDSHSessionID(ss.SessionDir)
	}
	preset := strings.TrimSpace(agent.RoleConfig.Custom["preset"])
	ch, err := newDSHChannel(ss.ID, addr, perm, cwd, preset, resume)
	if err != nil {
		return nil, fmt.Errorf("启动 dsh 会话失败: %w", err)
	}
	persistDSHSessionID(ss.SessionDir, ch.dshSession)
	ch.setEventHandler(func(ev rpcEvent) { m.handleEvent(ss.ID, ev) })
	ch.setExitHandler(func() { m.handleExit(ss.ID) })
	ch.start()
	return ch, nil
}

// spawn 启动 pi/omp RPC 进程并注入事件/退出回调。
func (m *Manager) spawn(ss *store.Task, agent store.Role, cwd string) (*rpcProc, error) {
	driver, ok := m.runtimes.Session(agent.RuntimeID)
	if !ok {
		return nil, fmt.Errorf("Runtime %s 不提供结构化会话能力", agent.RuntimeID)
	}
	// 角色技能挂载（与批处理任务同机制）。
	var mount *exec.RoleSkillMount
	if mnt, err := exec.EnsureRoleSkills(agent.ID, agent.Name, agent.RoleConfig.Skills,
		filepath.Join(m.sessionsRoot, ".roles", fmt.Sprintf("%d", agent.ID))); err == nil {
		mount = mnt
	} else {
		log.Printf("⚠ 会话 %d 技能挂载失败: %v", ss.ID, err)
	}
	spec, err := driver.PrepareSession(exec.SessionRequest{
		Role: agent.RoleConfig, SkillMount: mount, SessionDir: ss.SessionDir,
	})
	if err != nil {
		return nil, err
	}
	proc, err := newRPCProc(ss.ID, spec.Bin, spec.Args, spec.Env, cwd, ss.SessionDir, m.stderrPathOf(ss.ID))
	if err != nil {
		return nil, err
	}
	proc.setEventHandler(func(ev rpcEvent) { m.handleEvent(ss.ID, ev) })
	proc.onExit = func() { m.handleExit(ss.ID) }
	return proc, nil
}

// detach 从进程池移除（内部，状态迁移前调用）。
func (m *Manager) detach(id int64) sessionChannel {
	m.mu.Lock()
	proc := m.procs[id]
	delete(m.procs, id)
	m.mu.Unlock()
	return proc
}

// Suspend 挂起会话：杀进程、释放槽位、状态 → suspended。transcript 由 pi
// 会话文件持久化，随时可恢复。
func (m *Manager) Suspend(ctx context.Context, id int64) error {
	ss, err := m.st.GetSessionTask(id)
	if err != nil {
		return err
	}
	if ss == nil {
		return ErrSessionNotFound
	}
	if !CanTransition(ss.Status, store.SessionStatusSuspended) {
		return transitionErr(ss.Status, store.SessionStatusSuspended)
	}
	m.stopChannel(id)
	if agent, err := m.st.GetRole(*ss.RoleID); err == nil && agent != nil {
		m.ex.ReleaseRoleSlot(agent.ID)
	}
	now := store.Now()
	if err := m.st.UpdateTask(id, map[string]any{
		"status": store.SessionStatusSuspended, "suspended_at": now, "updated_at": now,
	}); err != nil {
		return err
	}
	m.publishUpdated(*ss)
	return nil
}

// Deliver 交付会话为任务：复用会话 worktree，**跳过 agent 执行**，直接把
// 会话已完成的工作收编进现有任务生命周期（审批 → 合并 → 结算）：
//   - perm=review → 任务直接 awaiting_review（人工审批通过后派代码合并任务）
//   - perm=full    → git 项目直接快照会话分支并自动创建代码合并任务；
//     非 git 项目直接 succeeded（无合并环节）
//
// active 时先终止进程并释放槽位。任务 body 在调用方未提供时预填会话摘要。
func (m *Manager) Deliver(ctx context.Context, id int64, taskTitle, taskBody, perm string) (*store.Task, error) {
	ss, err := m.st.GetSessionTask(id)
	if err != nil {
		return nil, err
	}
	if ss == nil {
		return nil, ErrSessionNotFound
	}
	if !CanTransition(ss.Status, store.SessionStatusDelivered) {
		return nil, transitionErr(ss.Status, store.SessionStatusDelivered)
	}
	agent, err := m.st.GetRole(*ss.RoleID)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, fmt.Errorf("角色不存在: %d", ss.RoleID)
	}
	if perm == "" {
		perm = store.PermFull
	}
	if perm != store.PermFull && perm != store.PermReview {
		return nil, fmt.Errorf("非法的权限模式: %s", perm)
	}
	if ss.ProjectID == nil {
		return nil, fmt.Errorf("会话未关联项目，无法交付为任务（任务必须在项目目录中执行）")
	}

	// 终止执行通道（若活跃）并释放槽位。
	m.stopChannel(id)
	m.ex.ReleaseRoleSlot(agent.ID)

	if taskBody == "" {
		taskBody = deliverBody(ss, agent, m.projectName(ss))
	}

	tk := store.Task{
		Title:          taskTitle,
		Body:           taskBody,
		Status:         store.StatusQueued,
		Perm:           perm,
		RunMode:        store.RunModeBatch,
		RoleID:         &agent.ID,
		ProjectID:      ss.ProjectID,
		ProjectDir:     m.projectDir(ss),
		SessionID:      &ss.ID,
		WorktreeBranch: ss.WorktreeBranch,
		BaseCommit:     ss.BaseCommit,
	}
	// 收编状态：不进入 queued 执行队列。
	now := store.Now()
	switch {
	case perm == store.PermReview:
		// 直接待审批（交付即第一轮成果）。
		tk.Status = store.StatusAwaitingReview
		tk.ReviewRounds = 1
		tk.FinishedAt = &now
		zero := 0
		tk.ExitCode = &zero
	case perm == store.PermFull && ss.WorktreeBranch == "":
		// 非 git 项目无 worktree 合并环节，直接完成。
		tk.Status = store.StatusSucceeded
		tk.FinishedAt = &now
	}
	taskID, err := m.st.CreateTask(tk)
	if err != nil {
		return nil, fmt.Errorf("创建任务失败: %w", err)
	}

	// git 项目：快照会话 worktree 到会话分支。交付即终态（会话冻结、分支
	// 不再变化），分支上落定最终成果，后续合并（含审批后的 review 合并）
	// 不依赖会话 worktree 仍然存在。
	if ss.WorktreeBranch != "" {
		created, err := m.st.GetTask(taskID)
		if err != nil {
			return nil, err
		}
		if _, err := workspace.Snapshot(*created, m.sessionsRoot); err != nil {
			_ = m.st.UpdateTask(taskID, map[string]any{
				"status": store.StatusFailed, "finished_at": store.Now(), "error": "准备交付合并失败: " + err.Error(),
			})
			return nil, fmt.Errorf("快照会话工作区失败: %w", err)
		}
		// full：原子地完成源任务并创建代码合并任务（把会话分支整合进主分支，
		// 冲突交给 agent 解决）。
		if perm == store.PermFull {
			mergeID, err := m.st.DeliverTaskAndCreateMerge(taskID, store.NewMergeTask(*created))
			if err != nil {
				_ = m.st.UpdateTask(taskID, map[string]any{
					"status": store.StatusFailed, "finished_at": store.Now(), "error": err.Error(),
				})
				return nil, fmt.Errorf("创建代码合并任务失败: %w", err)
			}
			m.hub.Publish(events.Event{Type: "task.created", Payload: map[string]any{"task_id": mergeID}})
		}
	}

	if err := m.st.UpdateTask(id, map[string]any{
		"status": store.SessionStatusDelivered, "delivered_at": now, "updated_at": now,
	}); err != nil {
		return nil, err
	}
	m.publishUpdated(*ss)
	// 任务创建事件（看板实时刷新）。
	m.hub.Publish(events.Event{Type: "task.created", Payload: map[string]any{"task_id": taskID}})
	created, err := m.st.GetTask(taskID)
	if err != nil {
		return nil, err
	}
	return created, nil
}

// deliverBody 生成交付任务的默认正文：会话摘要（调用方未提供说明时使用）。
func deliverBody(ss *store.Task, agent *store.Role, projectName string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "会话 #%d「%s」的交付成果，已转为任务进入审批/合并流程。\n\n", ss.ID, ss.Title)
	fmt.Fprintf(&b, "- 角色：%s（%s）\n", agent.Name, agent.RuntimeID)
	if projectName != "" {
		fmt.Fprintf(&b, "- 项目：%s\n", projectName)
	}
	if ss.CreatedAt != "" {
		fmt.Fprintf(&b, "- 会话创建：%s\n", ss.CreatedAt)
	}
	if ss.LastMessageAt != "" {
		fmt.Fprintf(&b, "- 最后消息：%s\n", ss.LastMessageAt)
	}
	fmt.Fprintf(&b, "- 消息数：%d\n", ss.MessageCount)
	fmt.Fprintf(&b, "\n完整对话时间线见会话 #%d（本任务详情页可回链查看）。", ss.ID)
	return b.String()
}

// Delete 丢弃会话：终止进程、清理 worktree、状态 → deleted。
// 已交付会话不可删除（worktree 归任务管理）。
func (m *Manager) Delete(ctx context.Context, id int64) error {
	ss, err := m.st.GetSessionTask(id)
	if err != nil {
		return err
	}
	if ss == nil {
		return ErrSessionNotFound
	}
	if !CanTransition(ss.Status, store.SessionStatusDeleted) {
		return transitionErr(ss.Status, store.SessionStatusDeleted)
	}
	m.stopChannel(id)
	if agent, err := m.st.GetRole(*ss.RoleID); err == nil && agent != nil {
		m.ex.ReleaseRoleSlot(agent.ID)
	}
	// 清理 worktree（非 git 或已丢失时静默）。
	if err := workspace.DiscardSessionWorktree(m.projectDir(ss), m.sessionsRoot, m.projectName(ss), id); err != nil {
		log.Printf("⚠ 会话 %d worktree 清理失败: %v", id, err)
	}
	if err := m.st.UpdateTask(id, map[string]any{
		"status": store.SessionStatusDeleted, "updated_at": store.Now(),
	}); err != nil {
		return err
	}
	m.publishUpdated(*ss)
	return nil
}

// ---------------------------------------------------------------------------
// 进程内命令

// Prompt 发送用户消息（prompt 命令）。agent 运行中时必须带 streamingBehavior
// （steer=插入 / followUp=等停止），否则 pi 拒绝。
// 自动恢复：挂起/未启动的会话直接自动启动（pi-web 行为），无需手动点恢复。
func (m *Manager) Prompt(ctx context.Context, id int64, message string, images []map[string]any, streamingBehavior string) (bool, error) {
	proc, err := m.activeProc(id)
	if err != nil {
		if auto := m.autoStart(ctx, id); auto != nil {
			return false, auto
		}
		proc, err = m.activeProc(id)
		if err != nil {
			return false, err
		}
	}
	fields := map[string]any{"message": message}
	if len(images) > 0 {
		fields["images"] = images
	}
	if streamingBehavior != "" {
		fields["streamingBehavior"] = streamingBehavior
	}
	resp, err := proc.runCommand(ctx, "prompt", fields, promptCmdTimeout)
	if err != nil {
		return false, err
	}
	return resp.Success, nil
}

// autoStart 在会话为 created/suspended 时自动启动进程（pi-web 行为：
// 发送消息即恢复）。其他状态返回错误。
func (m *Manager) autoStart(ctx context.Context, id int64) error {
	ss, err := m.st.GetSessionTask(id)
	if err != nil {
		return err
	}
	if ss == nil {
		return ErrSessionNotFound
	}
	if ss.Status == store.SessionStatusActive {
		return fmt.Errorf("会话进程未运行（状态: %s）", ss.Status)
	}
	if ss.Status != store.SessionStatusCreated && ss.Status != store.SessionStatusSuspended {
		return fmt.Errorf("会话已%s，无法发送消息", STATUS_CN[ss.Status])
	}
	if err := m.Start(ctx, id); err != nil {
		return fmt.Errorf("自动恢复会话失败: %w", err)
	}
	log.Printf("↻ 会话 %d 自动恢复（发送消息触发）", id)
	return nil
}

// Abort 中止当前回合。
func (m *Manager) Abort(ctx context.Context, id int64) error {
	proc, err := m.activeProc(id)
	if err != nil {
		return err
	}
	_, err = proc.runCommand(ctx, "abort", nil, cmdTimeout)
	return err
}

// AnswerAsk 应答 agent 的交互式提问（extension_ui_request → extension_ui_response）。
// pi 在 RPC 模式下提问（ask_user 等扩展）后阻塞等待应答：select/input/editor
// 用 value，confirm 用 confirmed，取消用 cancelled。pi 对该命令不回 response
// （stdin 层拦截直接 resolve 挂起中的提问），因此 fire-and-forget 写入。
func (m *Manager) AnswerAsk(id int64, askID, value string, confirmed *bool, cancelled bool) error {
	proc, err := m.activeProc(id)
	if err != nil {
		return err
	}
	if askID == "" {
		return errors.New("ask id 不能为空")
	}
	fields := map[string]any{"type": "extension_ui_response", "id": askID}
	switch {
	case cancelled:
		fields["cancelled"] = true
	case confirmed != nil:
		fields["confirmed"] = *confirmed
	default:
		fields["value"] = value
	}
	return proc.sendLine(fields)
}

// Command 通用命令转发（get_state / get_messages / set_model / set_thinking_level /
// compact / get_commands / switch_session 等）。data 为 response.data 原始 JSON。
func (m *Manager) Command(ctx context.Context, id int64, cmdType string, fields map[string]any) (json.RawMessage, error) {
	proc, err := m.activeProc(id)
	if err != nil {
		return nil, err
	}
	resp, err := proc.runCommand(ctx, cmdType, fields, cmdTimeout)
	if err != nil {
		return nil, err
	}
	if !resp.Success {
		msg := resp.Error
		if msg == "" {
			msg = fmt.Sprintf("命令 %s 被拒绝", cmdType)
		}
		return nil, errors.New(msg)
	}
	return resp.Data, nil
}

// Messages 返回会话全部消息（get_messages 转发）。
func (m *Manager) Messages(ctx context.Context, id int64) (json.RawMessage, error) {
	proc, err := m.activeProc(id)
	if err != nil {
		return nil, err
	}
	resp, err := proc.runCommand(ctx, "get_messages", nil, cmdTimeout)
	if err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, errors.New("读取会话消息失败")
	}
	return resp.Data, nil
}

// State 返回会话状态快照（get_state）。
func (m *Manager) State(ctx context.Context, id int64) (json.RawMessage, error) {
	proc, err := m.activeProc(id)
	if err != nil {
		return nil, err
	}
	resp, err := proc.runCommand(ctx, "get_state", nil, cmdTimeout)
	if err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, errors.New("读取会话状态失败")
	}
	return resp.Data, nil
}

// Transcript 返回会话完整时间线。pi/omp 解析会话 JSONL 文件（含全部 entry
// 类型：message / model_change / compaction / branch_summary 等）；dsh 走宿主
// history API。挂起/交付后仍可读。limit <= 0 表示全量；before 是分页游标
// （返回该 entry 之前的 limit 条，不含该条，即「上一页」）。返回 (entries, total, err)
// ——total 为全部条目数（分页指示用）。
func (m *Manager) Transcript(ctx context.Context, id int64, limit int, before string) ([]map[string]any, int, error) {
	ss, err := m.st.GetSessionTask(id)
	if err != nil {
		return nil, 0, err
	}
	if ss == nil {
		return nil, 0, ErrSessionNotFound
	}
	if m.isDSHSession(ss) {
		return m.dshTranscript(ctx, ss, limit, before)
	}
	file := latestSessionFile(ss.SessionDir)
	if file == "" {
		return []map[string]any{}, 0, nil
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, 0, fmt.Errorf("读取会话文件失败: %w", err)
	}
	defer f.Close()
	var entries []map[string]any
	dec := json.NewDecoder(f)
	for {
		var entry map[string]any
		if err := dec.Decode(&entry); err != nil {
			break // EOF 或坏行：截断
		}
		entries = append(entries, entry)
	}
	total := len(entries)
	// 分页：before 游标 → 返回该 entry 之前的 limit 条（不含该条；上一页）。
	// 游标找不到（会话文件已轮转）→ 保守返回空，避免与当前已加载窗口重叠。
	if before != "" {
		start := -1
		for i, e := range entries {
			if idStr, _ := e["id"].(string); idStr == before {
				start = i
				break
			}
		}
		if start < 0 {
			entries = nil
		} else if limit > 0 {
			begin := start - limit
			if begin < 0 {
				begin = 0
			}
			entries = entries[begin:start]
		}
	} else if limit > 0 && total > limit {
		entries = entries[total-limit:]
	}
	return entries, total, nil
}

// increment 返回会话消息数 +1（并发安全：SQLite 单写者）。
func increment(st *store.Store, id int64) int {
	ss, err := st.GetSessionTask(id)
	if err != nil || ss == nil {
		return 0
	}
	return ss.MessageCount + 1
}

// isDSHSession 判断会话角色是否走 dsh HTTP 会话通道。
func (m *Manager) isDSHSession(ss *store.Task) bool {
	if ss.RoleID == nil {
		return false
	}
	role, err := m.st.GetRole(*ss.RoleID)
	return err == nil && role != nil && role.RuntimeID == "dsh"
}

// dshTranscript 通过宿主 history API 读取并归一化 dsh 会话时间线。
// 挂起/交付后仍可读（宿主侧持久化）；宿主未启动时惰性启动。
func (m *Manager) dshTranscript(ctx context.Context, ss *store.Task, limit int, before string) ([]map[string]any, int, error) {
	dshSess := readDSHSessionID(ss.SessionDir)
	if dshSess == "" {
		return []map[string]any{}, 0, nil
	}
	perm := dshPermOf(ss.Perm)
	addr, err := m.dshHosts.addr(ctx, perm)
	if err != nil {
		return nil, 0, err
	}
	api := newDSHAPI(addr)
	var beforeSeq int64
	// dsh 转录里同一 seq 可能派生出多条条目（think/bash 等），id 形如
	// "<seq>-<n>"；分页游标只取数字前缀。
	if i := strings.IndexByte(before, '-'); i > 0 {
		before = before[:i]
	}
	if n, err := strconv.ParseInt(before, 10, 64); err == nil && n > 0 {
		beforeSeq = n
	}
	events, err := api.history(ctx, dshSess, beforeSeq, limit)
	if err != nil {
		return nil, 0, fmt.Errorf("读取 dsh 会话历史失败: %w", err)
	}
	entries := buildDshTranscriptEntries(events)
	return entries, len(entries), nil
}

func (m *Manager) handleEvent(id int64, ev rpcEvent) {
	payload := map[string]any{"session_id": id, "event": ev}
	m.hub.Publish(events.Event{Type: "session.message", Payload: payload})
	switch ev.Type {
	case "message_end":
		var ts string
		var msg struct {
			Timestamp int64 `json:"timestamp"`
		}
		if json.Unmarshal(ev.Message, &msg) == nil && msg.Timestamp > 0 {
			ts = time.UnixMilli(msg.Timestamp).UTC().Format(time.RFC3339)
		} else {
			ts = store.Now()
		}
		_ = m.st.UpdateTask(id, map[string]any{
			"last_message_at": ts, "message_count": increment(m.st, id), "updated_at": store.Now(),
		})
	case "agent_settled":
		touchSession(m.st, id, store.Now())
	}
}

// handleExit 崩溃检测：通道退出且会话仍 active → 自动置 suspended
// （RPC 进程的 transcript 由会话文件持久化；dsh 会话由宿主持久化），随时
// 可恢复，并释放槽位。
func (m *Manager) handleExit(id int64) {
	m.mu.Lock()
	proc := m.procs[id]
	delete(m.procs, id)
	m.mu.Unlock()
	if proc == nil {
		return
	}
	ss, err := m.st.GetSessionTask(id)
	if err != nil || ss == nil {
		return
	}
	if ss.Status != store.SessionStatusActive {
		return // 主动挂起/交付已处理
	}
	now := store.Now()
	if err := m.st.UpdateTask(id, map[string]any{
		"status": store.SessionStatusSuspended, "suspended_at": now, "updated_at": now,
	}); err != nil {
		log.Printf("⚠ 会话 %d 崩溃状态更新失败: %v", id, err)
		return
	}
	if agent, err := m.st.GetRole(*ss.RoleID); err == nil && agent != nil {
		m.ex.ReleaseRoleSlot(agent.ID)
	}
	m.publishUpdated(*ss)
}

// Recover 服务重启时把遗留的 active 会话置为 suspended（进程已随服务退出
// 丢失，transcript 由会话文件/dsh 宿主持久化，随时可恢复）。启动时调用。
func (m *Manager) Recover() {
	list, err := m.st.ListSessionTasks(nil, nil, store.SessionStatusActive, true)
	if err != nil {
		log.Printf("⚠ 扫描遗留会话失败: %v", err)
		return
	}
	for _, ss := range list {
		now := store.Now()
		if err := m.st.UpdateTask(ss.ID, map[string]any{
			"status": store.SessionStatusSuspended, "suspended_at": now, "updated_at": now,
		}); err != nil {
			log.Printf("⚠ 会话 %d 状态恢复失败: %v", ss.ID, err)
			continue
		}
		m.publishUpdated(ss)
		log.Printf("↻ 服务重启：会话 %d「%s」已挂起（可恢复）", ss.ID, ss.Title)
	}
}

// Stop 关闭所有活跃会话通道（服务退出时调用；dsh 宿主随后停止）。
func (m *Manager) Stop() {
	close(m.stopIdle)
	m.mu.Lock()
	procs := make([]sessionChannel, 0, len(m.procs))
	for _, p := range m.procs {
		procs = append(procs, p)
	}
	m.procs = make(map[int64]sessionChannel)
	m.mu.Unlock()
	for _, p := range procs {
		p.terminate()
	}
	m.dshHosts.StopAll()
}

func (m *Manager) activeProc(id int64) (sessionChannel, error) {
	m.mu.Lock()
	proc := m.procs[id]
	m.mu.Unlock()
	if proc == nil {
		ss, err := m.st.GetSessionTask(id)
		if err != nil {
			return nil, err
		}
		if ss == nil {
			return nil, ErrSessionNotFound
		}
		if ss.Status == store.SessionStatusSuspended {
			return nil, fmt.Errorf("会话已挂起，请先恢复")
		}
		return nil, fmt.Errorf("会话进程未运行（状态: %s）", ss.Status)
	}
	return proc, nil
}

func (m *Manager) publishUpdated(ss store.Task) {
	m.hub.Publish(events.Event{Type: "session.updated", Payload: ss})
}

// ---------------------------------------------------------------------------
// 自动挂起（pi-web 行为）：会话空闲超过 idle 时长后自动杀进程释放槽位，
// 下次发消息时自动恢复。空闲判定基于 RPC 事件流（任何事件都刷新 lastEvent，
// 进行中的回合持续产生事件不会被误挂起）。

// STATUS_CN 状态中文名（错误提示用）。
var STATUS_CN = map[string]string{
	store.SessionStatusCreated:   "未启动",
	store.SessionStatusActive:    "活跃",
	store.SessionStatusSuspended: "挂起",
	store.SessionStatusDelivered: "已交付",
	store.SessionStatusDeleted:   "已删除",
}

// StartIdleMonitor 启动空闲挂起巡检（服务启动时调用一次）。
func (m *Manager) StartIdleMonitor(idle time.Duration) {
	go func() {
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-m.stopIdle:
				return
			case <-tick.C:
				m.mu.Lock()
				now := time.Now()
				var idleIDs []int64
				for id, p := range m.procs {
					if idle := now.Sub(p.lastEventTime()) >= idle; idle {
						idleIDs = append(idleIDs, id)
					}
				}
				m.mu.Unlock()
				for _, id := range idleIDs {
					ss, err := m.st.GetSessionTask(id)
					if err != nil || ss == nil || ss.Status != store.SessionStatusActive {
						continue
					}
					if err := m.Suspend(context.Background(), id); err != nil {
						log.Printf("⚠ 会话 %d 自动挂起失败: %v", id, err)
						continue
					}
					log.Printf("↻ 会话 %d 空闲超过 %v，已自动挂起（发消息自动恢复）", id, idle)
				}
			}
		}
	}()
}

// ---------------------------------------------------------------------------
// 辅助

// latestSessionFile 返回目录中最新的 .jsonl 会话文件（pi 文件名带时间戳，
// 字典序即时间序）。
func latestSessionFile(dir string) string {
	matches, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	sort.Strings(matches)
	return matches[len(matches)-1]
}

func projectDirOf(project *store.Project) string {
	if project == nil {
		return ""
	}
	return project.ProjectDir
}

func projectNameOf(project *store.Project) string {
	if project == nil {
		return ""
	}
	return project.Name
}

// projectDir / projectName 基于会话关联的项目记录（无项目时为空串）。
func (m *Manager) projectDir(ss *store.Task) string {
	if ss.ProjectID == nil {
		return ""
	}
	proj, _ := m.st.GetProject(*ss.ProjectID)
	return projectDirOf(proj)
}

func (m *Manager) projectName(ss *store.Task) string {
	if ss.ProjectID == nil {
		return ""
	}
	proj, _ := m.st.GetProject(*ss.ProjectID)
	return projectNameOf(proj)
}
