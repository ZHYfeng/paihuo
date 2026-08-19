// Package orchestrator implements the platform-side tool surface for
// orchestrator sessions: tasks that decompose big work into real child tasks
// (spawn → await → feedback loop) on the PaiHuo board.
//
// The tool surface is a single MCP (Model Context Protocol) endpoint over HTTP
// (JSON-RPC 2.0, Bearer token). Run-times without native MCP — Pi — get a thin
// adapter: a Pi extension that registers the same five tools and forwards each
// call to this endpoint. The endpoint itself is runtime-agnostic by design;
// MCP-capable runtimes (codex, dsh) can point their mcp config at it directly.
package orchestrator

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"paihuo/internal/application"
	"paihuo/internal/exec"
	"paihuo/internal/store"
)

const (
	// TokenPrefix 区分 Bearer 中的平台令牌格式：ph_<session-id>.<b64url mac>。
	TokenPrefix = "ph_"
	// 工具面常量（与 Pi 扩展、前端共用文案）。
	toolSpawnTask     = "spawn_task"
	toolAwaitTasks    = "await_tasks"
	toolListChildren  = "list_children"
	toolGetTaskResult = "get_task_result"
	toolFetchArtifact = "fetch_artifact"

	defaultAwaitTimeout = 10 * time.Minute
	maxAwaitTimeout     = 30 * time.Minute
	defaultArtifactMax  = 256 << 10
	maxArtifactMax      = 1 << 20
)

// Service owns the tools. One instance per server process; it is stateless
// apart from the signing secret and its dependencies, so concurrent MCP calls
// are safe.
//
// artifactOpener 由 server 注入（prod 指向 LocalStore）；nil 时 fetch_artifact
// 只回元数据（测试/无 artifact 存储环境）。
type Service struct {
	st             *store.Store
	ex             *exec.Executor
	task           *application.TaskLifecycle
	sec            secret
	artifactOpener func(locator string) (io.ReadCloser, error)
}

// New builds the orchestrator tool service. secret may be empty; a fresh
// per-process secret is then generated (sessions are respawned on restart, so
// their tokens are renewed as long as the process that spawned them survived).
// ex 可为 nil（仅测试/只读路径）；runtimes 必须非 nil（spawn 需要校验角色）。
func New(st *store.Store, runtimes *exec.RuntimeService, ex *exec.Executor, tokenSecret string, artifactOpener func(locator string) (io.ReadCloser, error)) *Service {
	sec := secret{key: []byte(tokenSecret)}
	if len(sec.key) == 0 {
		buf := make([]byte, 32)
		_, _ = rand.Read(buf)
		sec.key = buf
	}
	return &Service{
		st:             st,
		ex:             ex,
		task:           application.NewTaskLifecycle(st, runtimes, ex),
		sec:            sec,
		artifactOpener: artifactOpener,
	}
}

// ---------------------------------------------------------------------------
// Token（HMAC 绑定会话 id；无状态、无数据库写入）

type secret struct{ key []byte }

// SignToken 为会话签发工具令牌：ph_<id>.<b64url(HMAC)>. secret 为空时用
// 空密钥（仅测试链路）；正式路径由 server/main 提供稳定密钥，令牌跨重启
// 保持有效。
func SignToken(secret string, sessionID int64) string {
	payload := "session:" + strconv.FormatInt(sessionID, 10)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(payload))
	return TokenPrefix + strconv.FormatInt(sessionID, 10) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// SignToken 为会话签发工具令牌：ph_<id>.<b64url(HMAC)>. 仅用于注入……进程
// 环境，不落库。
func (s *Service) SignToken(sessionID int64) string {
	return SignToken(string(s.sec.key), sessionID)
}

// VerifyToken 校验平台工具令牌并解析出会话 id。
func (s *Service) VerifyToken(token string) (int64, error) {
	if !strings.HasPrefix(token, TokenPrefix) {
		return 0, errors.New("非法工具令牌")
	}
	rest := strings.TrimPrefix(token, TokenPrefix)
	dot := strings.LastIndexByte(rest, '.')
	if dot <= 0 {
		return 0, errors.New("非法工具令牌")
	}
	id, err := strconv.ParseInt(rest[:dot], 10, 64)
	if err != nil || id < 1 {
		return 0, errors.New("非法工具令牌")
	}
	sig, err := base64.RawURLEncoding.DecodeString(rest[dot+1:])
	if err != nil {
		return 0, errors.New("非法工具令牌")
	}
	payload := "session:" + strconv.FormatInt(id, 10)
	mac := hmac.New(sha256.New, s.sec.key)
	_, _ = mac.Write([]byte(payload))
	want := mac.Sum(nil)
	if len(sig) != len(want) || hmac.Equal(sig, want) == false {
		return 0, errors.New("工具令牌签名无效")
	}
	return id, nil
}

// ---------------------------------------------------------------------------
// 工具返回值

// TaskResult 是子任务的结果摘要：终态、交付状态、artifact 引用、简短字段。
// 上下文控制不变量：只向编排者注入摘要与引用，不灌原始日志（fetch_artifact
// 按需拉取）。
type TaskResult struct {
	TaskID       int64   `json:"task_id"`
	Type         string  `json:"type"`
	Title        string  `json:"title"`
	Status       string  `json:"status"`
	Perm         string  `json:"perm"`
	RoleID       *int64  `json:"role_id"`
	RoleName     string  `json:"role_name"`
	ProjectID    *int64  `json:"project_id"`
	ProjectName  string  `json:"project_name"`
	ExitCode     *int    `json:"exit_code"`
	Error        string  `json:"error"`
	ReviewNote   string  `json:"review_note"`
	ReviewRounds int     `json:"review_rounds"`
	StartedAt    *string `json:"started_at"`
	FinishedAt   *string `json:"finished_at"`
	UpdatedAt    string  `json:"updated_at"`
	// Delivery 是交付状态（git 项目含合并落盘）：delivery_terminal 为 true
	// 时 delivery_succeeded 才有意义。
	DeliveryTerminal  bool           `json:"delivery_terminal"`
	DeliverySucceeded bool           `json:"delivery_succeeded"`
	Artifacts         []ArtifactMeta `json:"artifacts"`
}

// ArtifactMeta 是 artifact 的引用摘要（内容按需 fetch_artifact）。
type ArtifactMeta struct {
	ID        int64  `json:"id"`
	TaskID    *int64 `json:"task_id,omitempty"`
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Size      int64  `json:"size"`
}

func (s *Service) resultOf(tk store.Task) (TaskResult, error) {
	deliveryTerminal, deliverySucceeded, err := s.st.TaskDeliveryResult(tk.ID)
	if err != nil {
		return TaskResult{}, err
	}
	arts, err := s.listArtifactsForTask(tk.ID)
	if err != nil {
		return TaskResult{}, err
	}
	return TaskResult{
		TaskID:            tk.ID,
		Type:              tk.Type,
		Title:             tk.Title,
		Status:            tk.Status,
		Perm:              tk.Perm,
		RoleID:            tk.RoleID,
		RoleName:          tk.RoleName,
		ProjectID:         tk.ProjectID,
		ProjectName:       tk.ProjectName,
		ExitCode:          tk.ExitCode,
		Error:             tk.Error,
		ReviewNote:        tk.ReviewNote,
		ReviewRounds:      tk.ReviewRounds,
		StartedAt:         tk.StartedAt,
		FinishedAt:        tk.FinishedAt,
		UpdatedAt:         tk.UpdatedAt,
		DeliveryTerminal:  deliveryTerminal,
		DeliverySucceeded: deliverySucceeded,
		Artifacts:         arts,
	}, nil
}

func (s *Service) listArtifactsForTask(taskID int64) ([]ArtifactMeta, error) {
	items, err := s.st.ListArtifacts(&taskID, nil)
	if err != nil {
		return nil, err
	}
	out := make([]ArtifactMeta, 0, len(items))
	for _, a := range items {
		out = append(out, ArtifactMeta{ID: a.ID, TaskID: a.TaskID, Name: a.Name, MediaType: a.MediaType, Size: a.Size})
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// 权限不变量：会话必须存在、是编排者会话（其角色声明了 delegation）、处于
// 活动状态，且子任务权限不超过 delegation 上限。

func (s *Service) sessionContext(ctx context.Context, sessionID int64) (*store.Task, error) {
	ss, err := s.st.GetSessionTask(sessionID)
	if err != nil {
		return nil, err
	}
	if ss == nil {
		return nil, errors.New("编排者会话不存在")
	}
	if ss.Type != store.TaskTypeSession {
		return nil, errors.New("工具令牌只能由会话使用")
	}
	// 令牌只注入执行中的进程：非 active（未启动/已挂起/已交付/已删除）拒绝。
	if ss.Status != store.SessionStatusActive {
		return nil, fmt.Errorf("编排者会话未处于活动状态（%s）", ss.Status)
	}
	agent, err := s.st.GetRole(*ss.RoleID)
	if err != nil || agent == nil {
		return nil, errors.New("编排者角色不存在")
	}
	if !agent.DelegationEnabled {
		return nil, errors.New("会话角色未声明 delegation，不允许派生任务")
	}
	return ss, nil
}

// inSessionSubtree 判断任务是否属于会话名下（parent_session_id 指向该会话）。
// 编排者对子树外任务没有任何读取/spawn 面。
func (s *Service) inSessionSubtree(sessionID, taskID int64) (bool, error) {
	tk, err := s.st.GetTask(taskID)
	if err != nil {
		return false, err
	}
	return tk.ParentSessionID != nil && *tk.ParentSessionID == sessionID, nil
}

// ---------------------------------------------------------------------------
// 工具实现：spawn_task

type spawnArgs struct {
	ProjectID      *int64 `json:"project_id"`
	RoleID         int64  `json:"role_id"`
	Title          string `json:"title"`
	Body           string `json:"body"`
	Perm           string `json:"perm"`
	RunMode        string `json:"run_mode"`
	Concurrent     bool   `json:"concurrent"`
	DependencyMode string `json:"dependency_mode"`
	DependsOn      *int64 `json:"depends_on"`
	BlockOnFailure bool   `json:"block_on_failure"`
	// 同步模式（默认 false=异步）：true 时创建后阻塞到停止点，返回回执 + 结果。
	// 同步=「完成任务后自动通知编排者」：阻塞的工具调用返回即把控制权交回
	// LLM，无需编排者轮询。超时返回进度 + timed_out，编排者可再 await_tasks。
	Sync               bool `json:"sync,omitempty"`
	SyncTimeoutSeconds int  `json:"sync_timeout_seconds,omitempty"`
}

// spawnSyncOutcome 同步 spawn 的回执 + 结果摘要。
type spawnSyncOutcome struct {
	Receipt  spawnReceipt `json:"receipt"`
	Result   *TaskResult  `json:"result,omitempty"`
	TimedOut bool         `json:"timed_out"`
}

type spawnReceipt struct {
	TaskID          int64  `json:"task_id"`
	Title           string `json:"title"`
	Status          string `json:"status"`
	Perm            string `json:"perm"`
	RoleID          *int64 `json:"role_id"`
	RoleName        string `json:"role_name"`
	ProjectID       *int64 `json:"project_id"`
	ProjectName     string `json:"project_name"`
	ParentSessionID int64  `json:"parent_session_id"`
	ParentTaskID    int64  `json:"parent_task_id"`
	CreatedAt       string `json:"created_at"`
}

// Spawn 创建一条真实子任务并挂到编排者会话名下。返回回执（非阻塞，支持并行
// 扇出）。权限不变量在这里强制：子任务 perm ≤ delegation.max_perm。
func (s *Service) Spawn(ctx context.Context, sessionID int64, args spawnArgs) (spawnReceipt, error) {
	return s.spawnCreate(ctx, sessionID, args)
}

// SpawnSync 创建子任务并同步等待到停止点（终态或待人工审批）：一键完成
// 「派活 → 等结果 → 拿结果」，编排者无需轮询。awaiting_review 是停止点而非
// 错误——审批闸口在人类手里。超时返回当前进度 + timed_out（调用方可再 await）。
func (s *Service) SpawnSync(ctx context.Context, sessionID int64, args spawnArgs) (spawnSyncOutcome, error) {
	receipt, err := s.spawnCreate(ctx, sessionID, args)
	if err != nil {
		return spawnSyncOutcome{}, err
	}
	timeout := args.SyncTimeoutSeconds
	if timeout <= 0 {
		timeout = int(defaultAwaitTimeout.Seconds())
	}
	outcomes, timedOut, err := s.Await(ctx, sessionID, awaitArgs{TaskIDs: []int64{receipt.TaskID}, TimeoutSeconds: timeout})
	if err != nil {
		return spawnSyncOutcome{Receipt: receipt}, err
	}
	res := outcomes[receipt.TaskID].Result
	return spawnSyncOutcome{Receipt: receipt, Result: &res, TimedOut: timedOut}, nil
}

func (s *Service) spawnCreate(ctx context.Context, sessionID int64, args spawnArgs) (spawnReceipt, error) {
	ss, err := s.sessionContext(ctx, sessionID)
	if err != nil {
		return spawnReceipt{}, err
	}
	agent, err := s.st.GetRole(*ss.RoleID)
	if err != nil || agent == nil {
		return spawnReceipt{}, errors.New("编排者角色不存在")
	}
	title := strings.TrimSpace(args.Title)
	if title == "" {
		return spawnReceipt{}, errors.New("title 不能为空")
	}
	if args.RoleID < 1 {
		return spawnReceipt{}, errors.New("role_id 必填")
	}
	childRole, err := s.st.GetRole(args.RoleID)
	if err != nil || childRole == nil {
		return spawnReceipt{}, errors.New("子任务角色不存在")
	}
	if !childRole.Enabled {
		return spawnReceipt{}, fmt.Errorf("子任务角色「%s」未启用", childRole.Name)
	}
	perm := args.Perm
	if perm == "" {
		perm = store.PermFull
	}
	if perm != store.PermFull && perm != store.PermReview {
		return spawnReceipt{}, errors.New("非法权限模式（full/review）")
	}
	// 无提权不变量：子任务权限不得超过编排者 delegation 上限。
	if !agent.DelegationPermAllowed(perm) {
		return spawnReceipt{}, fmt.Errorf("子任务权限 %s 超过 delegation 上限（%s）", perm, agent.DelegationMaxPerm)
	}
	runMode := args.RunMode
	if runMode == "" {
		runMode = store.RunModeBatch
	}
	if runMode != store.RunModeBatch {
		// v1 只支持 batch：交互式子任务需要终端归属，编排者会话没有可映射
		// 的 TTY。拒绝而不是静默改写，避免编排者误以为子任务会落地终端。
		return spawnReceipt{}, errors.New("v1 只支持派生 batch 子任务（run_mode=batch）")
	}
	// 工具面默认 none：并行扇出时子任务不被项目串行链隐性排队（weak 需显式声明）。
	dependencyMode := args.DependencyMode
	if dependencyMode == "" {
		dependencyMode = store.DependencyNone
	}
	var projectRef *store.Project
	if args.ProjectID != nil {
		projectRef, err = s.st.GetProject(*args.ProjectID)
		if err != nil || projectRef == nil {
			return spawnReceipt{}, errors.New("子任务项目不存在")
		}
	}
	created, err := s.task.Create(application.CreateTaskRequest{
		Title:           title,
		Body:            args.Body,
		RoleID:          &args.RoleID,
		ProjectID:       args.ProjectID,
		Permission:      perm,
		RunMode:         runMode,
		Concurrent:      args.Concurrent,
		DependencyMode:  dependencyMode,
		DependsOn:       args.DependsOn,
		BlockOnFailure:  args.BlockOnFailure,
		ParentSessionID: &sessionID,
		ParentTaskID:    &sessionID, // v1：只有编排者会话调用工具；链语义见设计决策
	})
	if err != nil {
		return spawnReceipt{}, err
	}
	return spawnReceipt{
		TaskID:          created.ID,
		Title:           created.Title,
		Status:          created.Status,
		Perm:            created.Perm,
		RoleID:          created.RoleID,
		RoleName:        created.RoleName,
		ProjectID:       created.ProjectID,
		ProjectName:     created.ProjectName,
		ParentSessionID: sessionID,
		ParentTaskID:    sessionID,
		CreatedAt:       created.CreatedAt,
	}, nil
}

// ---------------------------------------------------------------------------
// 工具实现：await_tasks（轮询到终态/待审，或超时）

type awaitArgs struct {
	TaskIDs        []int64 `json:"task_ids"`
	TimeoutSeconds int     `json:"timeout_seconds,omitempty"`
}

// awaitOutcome 描述单个任务在 await 视角的状态：完成（终态或等待人工审批）
// 或仍在运行。
type awaitOutcome struct {
	Result  TaskResult `json:"result"`
	Pending bool       `json:"-"` // 仍在进行中（未到终态、也非待审）
}

// Await 阻塞至指定任务全部到达「停止点」（终态或待人工审批），返回每个的
// 结果摘要；超时返回当前进度并置 timed_out。待审任务不是错误——审批闸口
// 永远在人类手里，编排者据此决定继续等还是干别的。
func (s *Service) Await(ctx context.Context, sessionID int64, args awaitArgs) (map[int64]awaitOutcome, bool, error) {
	if len(args.TaskIDs) == 0 {
		return nil, false, errors.New("task_ids 不能为空")
	}
	timeout := defaultAwaitTimeout
	if args.TimeoutSeconds > 0 {
		timeout = time.Duration(args.TimeoutSeconds) * time.Second
	}
	if timeout > maxAwaitTimeout {
		timeout = maxAwaitTimeout
	}
	seen := make(map[int64]bool, len(args.TaskIDs))
	for _, id := range args.TaskIDs {
		if id < 1 {
			return nil, false, errors.New("task_ids 含非法 id")
		}
		if seen[id] {
			return nil, false, fmt.Errorf("task_ids 重复: %d", id)
		}
		seen[id] = true
		ok, err := s.inSessionSubtree(sessionID, id)
		if err != nil {
			return nil, false, err
		}
		if !ok {
			return nil, false, fmt.Errorf("任务 %d 不属于本编排者会话", id)
		}
	}
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var last map[int64]awaitOutcome
	for {
		results := make(map[int64]awaitOutcome, len(args.TaskIDs))
		allDone := true
		for _, id := range args.TaskIDs {
			tk, err := s.st.GetTask(id)
			if err != nil {
				return nil, false, err
			}
			res, err := s.resultOf(*tk)
			if err != nil {
				return nil, false, err
			}
			done := isTerminalStatus(tk.Status) || tk.Status == store.StatusAwaitingReview
			results[id] = awaitOutcome{Result: res, Pending: !done}
			if !done {
				allDone = false
			}
		}
		last = results
		if allDone {
			return results, false, nil
		}
		if time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return nil, false, ctx.Err()
		case <-ticker.C:
		}
	}
	return last, true, nil
}

func isTerminalStatus(status string) bool {
	switch status {
	case store.StatusSucceeded, store.StatusFailed, store.StatusCancelled:
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// 工具实现：list_children / get_task_result / fetch_artifact

type listChildrenArgs struct {
	SessionID *int64 `json:"session_id,omitempty"`
	ParentID  *int64 `json:"parent_id,omitempty"`
}

// ListChildren 返回会话名下的派生子任务。默认查调用者自己；parent_id 给定时
// 返回该任务在会话树内的直接子任务；session_id 必须是调用者自己（v1：一个
// 编排者只能看自己的树）。
func (s *Service) ListChildren(ctx context.Context, sessionID int64, args listChildrenArgs) ([]TaskResult, error) {
	if _, err := s.sessionContext(ctx, sessionID); err != nil {
		return nil, err
	}
	target := sessionID
	if args.SessionID != nil {
		if *args.SessionID != sessionID {
			return nil, errors.New("只能查询自己的会话树")
		}
		target = *args.SessionID
	}
	if args.ParentID != nil {
		tasks, err := s.st.ListChildrenByParentTask(*args.ParentID)
		if err != nil {
			return nil, err
		}
		out := make([]TaskResult, 0, len(tasks))
		for _, tk := range tasks {
			if tk.ParentSessionID == nil || *tk.ParentSessionID != sessionID {
				continue // 树外任务不可见
			}
			res, err := s.resultOf(tk)
			if err != nil {
				return nil, err
			}
			out = append(out, res)
		}
		return out, nil
	}
	tasks, err := s.st.ListChildrenBySession(target)
	if err != nil {
		return nil, err
	}
	out := make([]TaskResult, 0, len(tasks))
	for _, tk := range tasks {
		res, err := s.resultOf(tk)
		if err != nil {
			return nil, err
		}
		out = append(out, res)
	}
	return out, nil
}

type getResultArgs struct {
	TaskID int64 `json:"task_id"`
}

// GetResult 返回单个子任务的结果摘要。
func (s *Service) GetResult(ctx context.Context, sessionID int64, args getResultArgs) (TaskResult, error) {
	if _, err := s.sessionContext(ctx, sessionID); err != nil {
		return TaskResult{}, err
	}
	ok, err := s.inSessionSubtree(sessionID, args.TaskID)
	if err != nil {
		return TaskResult{}, err
	}
	if !ok {
		return TaskResult{}, fmt.Errorf("任务 %d 不属于本编排者会话", args.TaskID)
	}
	tk, err := s.st.GetTask(args.TaskID)
	if err != nil {
		return TaskResult{}, err
	}
	return s.resultOf(*tk)
}

type fetchArtifactArgs struct {
	ArtifactID int64 `json:"artifact_id"`
	MaxBytes   int   `json:"max_bytes,omitempty"`
}

// FetchArtifact 按需拉取会话树内 artifact 的内容（受控注入：默认只回摘要，
// 调用方显式请求才拉内容，且限制体积）。
func (s *Service) FetchArtifact(ctx context.Context, sessionID int64, args fetchArtifactArgs) (map[string]any, error) {
	if _, err := s.sessionContext(ctx, sessionID); err != nil {
		return nil, err
	}
	meta, err := s.st.GetArtifact(args.ArtifactID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errors.New("artifact 不存在")
		}
		return nil, err
	}
	if meta == nil {
		return nil, errors.New("artifact 不存在")
	}
	if meta.TaskID != nil {
		ok, err := s.inSessionSubtree(sessionID, *meta.TaskID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, errors.New("artifact 不属于本编排者会话")
		}
	}
	// Run 级 artifact（workflow run 产物）：v2 才暴露 workflow 树，v1 拒绝。
	if meta.TaskID == nil {
		return nil, errors.New("v1 只支持读取任务级 artifact")
	}
	limit := args.MaxBytes
	if limit <= 0 {
		limit = defaultArtifactMax
	}
	if limit > maxArtifactMax {
		limit = maxArtifactMax
	}
	out := map[string]any{
		"id":         meta.ID,
		"task_id":    meta.TaskID,
		"name":       meta.Name,
		"media_type": meta.MediaType,
		"size":       meta.Size,
	}
	if s.artifactOpener == nil {
		return out, nil // 无 artifact 存储：只回元数据
	}
	rc, err := s.artifactOpener(meta.Locator)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	limited := io.LimitReader(rc, int64(limit)+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	truncated := int64(len(body)) > int64(limit)
	if truncated {
		body = body[:limit]
	}
	out["truncated"] = truncated
	out["content_base64"] = base64.StdEncoding.EncodeToString(body)
	return out, nil
}
