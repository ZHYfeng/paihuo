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
	st            *store.Store
	hub           *events.Hub
	ex            *exec.Executor
	sessionsRoot  string
	agentSessions string // <sessionsRoot>/.agent-sessions（与任务会话平级，session- 前缀）

	mu    sync.Mutex
	procs map[int64]*rpcProc  // pi 会话进程（RPC 通道）
	terms map[int64]*termProc // codex/claude 会话终端（tmux 通道，S5）
	// stopping 置位后禁止再启动新进程（服务关闭）
	stopping bool
	stopIdle chan struct{} // 空闲挂起巡检停止信号（Stop 时关闭）
}

// New 创建会话管理器。ex 用于共享角色并发槽位；instanceID 用于隔离
// .agent-sessions 命名空间（与 Executor 同源）。
func New(st *store.Store, hub *events.Hub, ex *exec.Executor, sessionsRoot, instanceID string) *Manager {
	_ = instanceID // 会话目录用 session-<id> 前缀天然隔离，不参与实例命名空间
	return &Manager{
		st:            st,
		hub:           hub,
		ex:            ex,
		sessionsRoot:  sessionsRoot,
		agentSessions: filepath.Join(sessionsRoot, ".agent-sessions"),
		procs:         make(map[int64]*rpcProc),
		terms:         make(map[int64]*termProc),
		stopIdle:      make(chan struct{}),
	}
}

// sessionDirOf 返回会话的 pi 会话文件目录。
func (m *Manager) sessionDirOf(id int64) string {
	return filepath.Join(m.agentSessions, fmt.Sprintf("session-%d", id))
}

// stderrPathOf 返回会话进程的 stderr 日志路径。
func (m *Manager) stderrPathOf(id int64) string {
	return filepath.Join(m.sessionDirOf(id), "stderr.log")
}

// ---------------------------------------------------------------------------
// CRUD

// Create 创建会话：git 项目建隔离 worktree（sessions/<project>/session-<id>），
// 非 git 项目复制到专属会话目录，无项目时使用独立空目录
// （sessions/session-<id>，不关联任何项目）。
func (m *Manager) Create(projectID *int64, agentID int64, title string) (*store.Session, error) {
	agent, err := m.st.GetAgent(agentID)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, fmt.Errorf("角色不存在: %d", agentID)
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
	// 先建记录拿 id，再建 worktree（路径含 session id）。
	ss := store.Session{
		ProjectID: projectID,
		AgentID:   agentID,
		Title:     title,
		Status:    store.SessionStatusCreated,
		CLI:       agent.CLI,
	}
	id, err := m.st.CreateSession(ss)
	if err != nil {
		return nil, fmt.Errorf("创建会话失败: %w", err)
	}
	// 重新读取（CreateSession 内部补齐时间戳，值拷贝不回传）。
	ss2, err := m.st.GetSession(id)
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
	if err := m.st.UpdateSession(id, set); err != nil {
		return nil, err
	}
	ss.WorktreePath, ss.WorktreeBranch, ss.BaseCommit, ss.SessionDir = dir, branch, base, m.sessionDirOf(id)
	m.publishUpdated(ss)
	return &ss, nil
}

// Get 返回单个会话。
func (m *Manager) Get(id int64) (*store.Session, error) {
	return m.st.GetSession(id)
}

// List 列出会话（默认不含 deleted）。
func (m *Manager) List(f store.SessionFilter) ([]store.Session, error) {
	return m.st.ListSessions(f)
}

// ---------------------------------------------------------------------------
// 生命周期

// Start 启动会话进程（created/suspended → active）。resume 时先扫描旧会话
// 文件，spawn 后 switch_session 接续原会话。
func (m *Manager) Start(ctx context.Context, id int64) error {
	_ = ctx // 进程生命周期独立于请求：spawn 不绑定请求 ctx
	ss, err := m.st.GetSession(id)
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
	agent, err := m.st.GetAgent(ss.AgentID)
	if err != nil {
		return err
	}
	if agent == nil {
		return fmt.Errorf("角色不存在: %d", ss.AgentID)
	}
	if !agent.Enabled {
		return fmt.Errorf("角色「%s」已停用", agent.Name)
	}
	if !m.ex.ReserveAgentSlot(agent.ID, agent.ConcurrencyLimit()) {
		return fmt.Errorf("角色「%s」并发已满（上限 %d），请挂起部分会话或等任务完成", agent.Name, agent.ConcurrencyLimit())
	}

	dir := ss.WorktreePath
	if dir == "" {
		dir = m.projectDir(ss) // 非 git / 无 worktree 回退
	}
	if agent.CLI == "pi" || agent.CLI == "omp" {
		// pi/omp 有 RPC 模式（JSONL 事件流 + 命令通道）→ 消息流视图。
		if err := m.startRPC(ss, *agent, dir); err != nil {
			m.ex.ReleaseAgentSlot(agent.ID)
			return err
		}
	} else {
		// S5：codex/claude 降级通道（tmux 终端）。
		if err := m.startTerminal(ss, *agent, dir); err != nil {
			m.ex.ReleaseAgentSlot(agent.ID)
			return err
		}
	}

	now := store.Now()
	set := map[string]any{"status": store.SessionStatusActive, "started_at": now, "updated_at": now}
	if err := m.st.UpdateSession(id, set); err != nil {
		m.stopChannel(id)
		return err
	}
	m.publishUpdated(*ss)
	return nil
}

// startRPC 启动 pi/omp RPC 会话进程（恢复时 switch_session 接续）。
func (m *Manager) startRPC(ss *store.Session, agent store.Agent, dir string) error {
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
	m.mu.Lock()
	m.procs[ss.ID] = proc
	m.mu.Unlock()
	return nil
}

// startTerminal 启动 codex/claude 会话终端窗口（S5）。
func (m *Manager) startTerminal(ss *store.Session, agent store.Agent, dir string) error {
	adapter, ok := exec.GetAdapter(agent.CLI)
	if !ok {
		return fmt.Errorf("未知 CLI: %s", agent.CLI)
	}
	bin, err := adapter.Detect()
	if err != nil {
		return err
	}
	var mount *exec.RoleSkillMount
	if mnt, err := exec.EnsureRoleSkills(agent.ID, agent.Name, agent.RoleConfig.Skills,
		filepath.Join(m.sessionsRoot, ".role-agents", fmt.Sprintf("%d", agent.ID))); err == nil {
		mount = mnt
	}
	// 初始消息：恢复时为空（CLI 交互 TUI 启动后由用户继续）；新建时用会话标题提示。
	initial := ""
	_, args, env, err := exec.BuildInteractiveArgs(agent.CLI, exec.RunOptions{
		Dir: dir, Role: agent.RoleConfig, RunMode: store.RunModeInteractive, SkillMount: mount,
	})
	if err != nil {
		return err
	}
	term := newTermProc(m.termSocket())
	term.archive = filepath.Join(m.sessionDirOf(ss.ID), "term.out")
	if err := term.Spawn(ss.ID, bin, args, env, dir, initial); err != nil {
		return err
	}
	m.mu.Lock()
	m.terms[ss.ID] = term
	m.mu.Unlock()
	return nil
}

// termSocket 与会话终端共享 Executor 的 tmux server（window 前缀隔离）。
func (m *Manager) termSocket() string { return "paihuo" }

// stopChannel 停止会话的执行通道（RPC 进程或终端窗口）。
func (m *Manager) stopChannel(id int64) {
	if proc := m.detach(id); proc != nil {
		proc.terminate()
	}
	m.mu.Lock()
	term := m.terms[id]
	delete(m.terms, id)
	m.mu.Unlock()
	if term != nil {
		_ = term.Kill(id)
	}
}

// TermInput 向终端式会话发送整行输入（S5）。挂起时自动恢复。
func (m *Manager) TermInput(id int64, text string) error {
	term, err := m.activeTerm(id)
	if err != nil {
		if auto := m.autoStart(context.Background(), id); auto != nil {
			return fmt.Errorf("%v", auto)
		}
		term, err = m.activeTerm(id)
		if err != nil {
			return err
		}
	}
	return term.Input(id, text)
}

// TermInputRaw 发送原始按键（S5）。
func (m *Manager) TermInputRaw(id int64, text string) error {
	term, err := m.activeTerm(id)
	if err != nil {
		return err
	}
	return term.InputRaw(id, text)
}

// TermResize 同步终端尺寸（S5）。
func (m *Manager) TermResize(id int64, cols, rows int) error {
	term, err := m.activeTerm(id)
	if err != nil {
		return err
	}
	return term.Resize(id, cols, rows)
}

// TermOutput 增量读取终端输出（S5）。
func (m *Manager) TermOutput(id int64) (string, bool, error) {
	term, err := m.activeTerm(id)
	if err == nil {
		return term.Output(id)
	}
	// 无活跃终端：回退读最后捕获帧。终态会话（delivered/deleted）返回
	// alive=false 供前端停止轮询；可启动会话（created/suspended）保持
	// alive=true 直到自动恢复拉起真实窗口，避免前端过早停轮询显示空白。
	ss, gerr := m.st.GetSession(id)
	if gerr == nil && ss != nil && (ss.CLI == "codex" || ss.CLI == "claude") {
		archive := filepath.Join(m.sessionDirOf(id), "term.out")
		if data, rerr := os.ReadFile(archive); rerr == nil {
			alive := ss.Status == store.SessionStatusCreated || ss.Status == store.SessionStatusSuspended
			return string(data), alive, nil
		}
	}
	return "", false, err
}

func (m *Manager) activeTerm(id int64) (*termProc, error) {
	m.mu.Lock()
	term := m.terms[id]
	m.mu.Unlock()
	if term == nil {
		return nil, fmt.Errorf("会话终端未运行（仅 codex/claude 会话支持）")
	}
	return term, nil
}

// spawn 启动 pi/omp RPC 进程并注入事件/退出回调。
func (m *Manager) spawn(ss *store.Session, agent store.Agent, cwd string) (*rpcProc, error) {
	adapter, ok := exec.GetAdapter(agent.CLI)
	if !ok {
		return nil, fmt.Errorf("CLI 适配器缺失: %s", agent.CLI)
	}
	bin, err := adapter.Detect()
	if err != nil {
		return nil, err
	}
	// 角色技能挂载（与批处理任务同机制）。
	var mount *exec.RoleSkillMount
	if mnt, err := exec.EnsureRoleSkills(agent.ID, agent.Name, agent.RoleConfig.Skills,
		filepath.Join(m.sessionsRoot, ".role-agents", fmt.Sprintf("%d", agent.ID))); err == nil {
		mount = mnt
	} else {
		log.Printf("⚠ 会话 %d 技能挂载失败: %v", ss.ID, err)
	}
	var args []string
	if agent.CLI == "omp" {
		args, err = exec.BuildOmpRPCSessionArgs(agent.RoleConfig, mount, ss.SessionDir)
	} else {
		var skillPaths []string
		if mount != nil {
			skillPaths = mount.SkillPaths
		}
		args, err = exec.BuildPiRPCSessionArgs(agent.RoleConfig, skillPaths, ss.SessionDir)
	}
	if err != nil {
		return nil, err
	}
	env := exec.MergeEnv(agent.RoleConfig.Env)
	proc, err := newRPCProc(ss.ID, bin, args, env, cwd, ss.SessionDir, m.stderrPathOf(ss.ID))
	if err != nil {
		return nil, err
	}
	proc.setEventHandler(func(ev rpcEvent) { m.handleEvent(ss.ID, ev) })
	proc.onExit = func() { m.handleExit(ss.ID) }
	return proc, nil
}

// detach 从进程池移除（内部，状态迁移前调用）。
func (m *Manager) detach(id int64) *rpcProc {
	m.mu.Lock()
	proc := m.procs[id]
	delete(m.procs, id)
	m.mu.Unlock()
	return proc
}

// Suspend 挂起会话：杀进程、释放槽位、状态 → suspended。transcript 由 pi
// 会话文件持久化，随时可恢复。
func (m *Manager) Suspend(ctx context.Context, id int64) error {
	ss, err := m.st.GetSession(id)
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
	if agent, err := m.st.GetAgent(ss.AgentID); err == nil && agent != nil {
		m.ex.ReleaseAgentSlot(agent.ID)
	}
	now := store.Now()
	if err := m.st.UpdateSession(id, map[string]any{
		"status": store.SessionStatusSuspended, "suspended_at": now, "updated_at": now,
	}); err != nil {
		return err
	}
	m.publishUpdated(*ss)
	return nil
}

// Deliver 交付会话为任务：复用会话 worktree，走现有任务生命周期
// （审批 → 合并 → 结算）。active 时先终止进程。
func (m *Manager) Deliver(ctx context.Context, id int64, taskTitle, taskBody, perm string) (*store.Task, error) {
	ss, err := m.st.GetSession(id)
	if err != nil {
		return nil, err
	}
	if ss == nil {
		return nil, ErrSessionNotFound
	}
	if !CanTransition(ss.Status, store.SessionStatusDelivered) {
		return nil, transitionErr(ss.Status, store.SessionStatusDelivered)
	}
	agent, err := m.st.GetAgent(ss.AgentID)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, fmt.Errorf("角色不存在: %d", ss.AgentID)
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
	m.ex.ReleaseAgentSlot(agent.ID)

	tk := store.Task{
		Title:          taskTitle,
		Body:           taskBody,
		Status:         store.StatusQueued,
		Perm:           perm,
		RunMode:        store.RunModeBatch,
		AgentID:        &agent.ID,
		ProjectID:      ss.ProjectID,
		ProjectDir:     m.projectDir(ss),
		SessionID:      &ss.ID,
		WorktreeBranch: ss.WorktreeBranch,
		BaseCommit:     ss.BaseCommit,
	}
	taskID, err := m.st.CreateTask(tk)
	if err != nil {
		return nil, fmt.Errorf("创建任务失败: %w", err)
	}
	now := store.Now()
	if err := m.st.UpdateSession(id, map[string]any{
		"status": store.SessionStatusDelivered, "task_id": taskID,
		"delivered_at": now, "updated_at": now,
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

// Delete 丢弃会话：终止进程、清理 worktree、状态 → deleted。
// 已交付会话不可删除（worktree 归任务管理）。
func (m *Manager) Delete(ctx context.Context, id int64) error {
	ss, err := m.st.GetSession(id)
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
	if agent, err := m.st.GetAgent(ss.AgentID); err == nil && agent != nil {
		m.ex.ReleaseAgentSlot(agent.ID)
	}
	// 清理 worktree（非 git 或已丢失时静默）。
	if err := workspace.DiscardSessionWorktree(m.projectDir(ss), m.sessionsRoot, m.projectName(ss), id); err != nil {
		log.Printf("⚠ 会话 %d worktree 清理失败: %v", id, err)
	}
	if err := m.st.UpdateSession(id, map[string]any{
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
	ss, err := m.st.GetSession(id)
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

// Transcript 返回会话完整时间线（解析 pi 会话 JSONL 文件，含全部 entry 类型：
// message / model_change / compaction / branch_summary 等）。挂起/交付后仍可读。
// limit <= 0 表示全量；before 是分页游标（返回该 entry id 开始的 limit 条）。
// 返回 (entries, total, err)——total 为全部条目数（分页指示用）。
func (m *Manager) Transcript(ctx context.Context, id int64, limit int, before string) ([]map[string]any, int, error) {
	ss, err := m.st.GetSession(id)
	if err != nil {
		return nil, 0, err
	}
	if ss == nil {
		return nil, 0, ErrSessionNotFound
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
	// 分页：before 游标 → 从包含 before 的条目开始（含）向后取 limit 条。
	if before != "" {
		start := 0
		for i, e := range entries {
			if idStr, _ := e["id"].(string); idStr == before {
				start = i
				break
			}
		}
		if start > 0 && limit > 0 {
			end := start + limit
			if end > total {
				end = total
			}
			entries = entries[start:end]
		}
	} else if limit > 0 && total > limit {
		entries = entries[total-limit:]
	}
	return entries, total, nil
}

// increment 返回会话消息数 +1（并发安全：SQLite 单写者）。
func increment(st *store.Store, id int64) int {
	ss, err := st.GetSession(id)
	if err != nil || ss == nil {
		return 0
	}
	return ss.MessageCount + 1
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
		_ = m.st.UpdateSession(id, map[string]any{
			"last_message_at": ts, "message_count": increment(m.st, id), "updated_at": store.Now(),
		})
	case "agent_settled":
		touchSession(m.st, id, store.Now())
	}
}

// handleExit 崩溃检测：进程退出且会话仍 active → 自动置 suspended
// （transcript 不丢，随时可恢复），并释放槽位。
func (m *Manager) handleExit(id int64) {
	m.mu.Lock()
	proc := m.procs[id]
	delete(m.procs, id)
	m.mu.Unlock()
	if proc == nil {
		return
	}
	ss, err := m.st.GetSession(id)
	if err != nil || ss == nil {
		return
	}
	if ss.Status != store.SessionStatusActive {
		return // 主动挂起/交付已处理
	}
	now := store.Now()
	if err := m.st.UpdateSession(id, map[string]any{
		"status": store.SessionStatusSuspended, "suspended_at": now, "updated_at": now,
	}); err != nil {
		log.Printf("⚠ 会话 %d 崩溃状态更新失败: %v", id, err)
		return
	}
	if agent, err := m.st.GetAgent(ss.AgentID); err == nil && agent != nil {
		m.ex.ReleaseAgentSlot(agent.ID)
	}
	m.publishUpdated(*ss)
}

// Recover 服务重启时把遗留的 active 会话置为 suspended（进程已随服务退出
// 丢失，transcript 由 pi 会话文件持久化，随时可恢复）。启动时调用。
func (m *Manager) Recover() {
	list, err := m.st.ListSessions(store.SessionFilter{Status: store.SessionStatusActive})
	if err != nil {
		log.Printf("⚠ 扫描遗留会话失败: %v", err)
		return
	}
	for _, ss := range list {
		now := store.Now()
		if err := m.st.UpdateSession(ss.ID, map[string]any{
			"status": store.SessionStatusSuspended, "suspended_at": now, "updated_at": now,
		}); err != nil {
			log.Printf("⚠ 会话 %d 状态恢复失败: %v", ss.ID, err)
			continue
		}
		m.publishUpdated(ss)
		log.Printf("↻ 服务重启：会话 %d「%s」已挂起（可恢复）", ss.ID, ss.Title)
	}
}

// Stop 关闭所有活跃会话进程（服务退出时调用）。
func (m *Manager) Stop() {
	close(m.stopIdle)
	m.mu.Lock()
	procs := make([]*rpcProc, 0, len(m.procs))
	for _, p := range m.procs {
		procs = append(procs, p)
	}
	m.procs = make(map[int64]*rpcProc)
	m.mu.Unlock()
	for _, p := range procs {
		p.terminate()
	}
}

func (m *Manager) activeProc(id int64) (*rpcProc, error) {
	m.mu.Lock()
	proc := m.procs[id]
	m.mu.Unlock()
	if proc == nil {
		ss, err := m.st.GetSession(id)
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

func (m *Manager) publishUpdated(ss store.Session) {
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
					p.mu.Lock()
					idle := now.Sub(p.lastEvent) >= idle
					p.mu.Unlock()
					if idle {
						idleIDs = append(idleIDs, id)
					}
				}
				m.mu.Unlock()
				for _, id := range idleIDs {
					ss, err := m.st.GetSession(id)
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
func (m *Manager) projectDir(ss *store.Session) string {
	if ss.ProjectID == nil {
		return ""
	}
	proj, _ := m.st.GetProject(*ss.ProjectID)
	return projectDirOf(proj)
}

func (m *Manager) projectName(ss *store.Session) string {
	if ss.ProjectID == nil {
		return ""
	}
	proj, _ := m.st.GetProject(*ss.ProjectID)
	return projectNameOf(proj)
}
