package store

import (
	"fmt"
	"strings"
	"time"
)

// 任务状态机：
//
//	queued ──claim──> claimed ──start──> running ──完成──> succeeded
//	   │                 │                │  └─失败──> failed
//	   │                 │                ├─暂停(审批)──> awaiting_review ──批准──> running
//	   └──取消──> cancelled（任意非终态均可取消；终态可重试回 queued）
const (
	StatusQueued         = "queued"
	StatusClaimed        = "claimed"
	StatusRunning        = "running"
	StatusAwaitingReview = "awaiting_review"
	StatusSucceeded      = "succeeded"
	StatusFailed         = "failed"
	StatusCancelled      = "cancelled"
)

// 权限模式（每任务单独配置）
const (
	PermFull   = "full"   // 自动：执行成功后派发专属代码合并任务
	PermReview = "review" // 人工审批：通过后创建同角色的代码合并任务
)

// 依赖模式。弱依赖由项目执行顺序自动形成（默认按创建时间）；前置失败且没有要求阻塞时可
// 跳过。强依赖是用户明确指定的前置交付，只有成功交付（Git 项目还要完成
// 合并）才会放行。none 用于无项目或显式独立/并行任务。
const (
	DependencyNone   = "none"
	DependencyWeak   = "weak"
	DependencyStrong = "strong"
)

// 任务执行方式。默认 batch 保持现有的一次性 CLI 语义；interactive 会让
// 手工任务留在 tmux TTY 中，等待用户继续发消息或退出会话。
const (
	RunModeBatch       = "batch"
	RunModeInteractive = "interactive"
)

// 会话状态机：
//
//	created ──start──> active ──suspend──> suspended ──resume──> active
//	   │                  │                                       │
//	   ├──discard─────────┼──deliver──> delivered（冻结，关联 task_id）│
//	   │                  └───────────────┬────────────────────────┘
//	   └──────────────deleted─────────────┘（清理 worktree）
const (
	SessionStatusCreated   = "created"
	SessionStatusActive    = "active"
	SessionStatusSuspended = "suspended"
	SessionStatusDelivered = "delivered"
	SessionStatusDeleted   = "deleted"
)

// Session 是与任务平行的一等公民：复杂问题的常驻交互会话。
// 无执行-结算语义：挂起只释放进程/槽位，transcript 由 pi 会话文件持久化；
// 交付时才创建任务（复用会话 worktree，见 Task.SessionID）走审批→合并流程。
type Session struct {
	ID             int64   `json:"id"`
	ProjectID      *int64  `json:"project_id"`
	ProjectName    string  `json:"project_name,omitempty"`
	RoleID         int64   `json:"role_id"`
	RoleName       string  `json:"role_name,omitempty"`
	Title          string  `json:"title"`
	Status         string  `json:"status"`
	RuntimeID      string  `json:"runtime_id"` // 冗余自角色，前端展示用：pi | omp
	WorktreeBranch string  `json:"worktree_branch"`
	WorktreePath   string  `json:"worktree_path"`
	BaseCommit     string  `json:"base_commit"` // 创建 worktree 时主分支 HEAD
	SessionDir     string  `json:"session_dir"` // pi 会话文件目录
	TaskID         *int64  `json:"task_id"`     // 交付后关联
	LastMessageAt  string  `json:"last_message_at"`
	MessageCount   int     `json:"message_count"`
	Revision       int64   `json:"revision"`
	CreatedAt      string  `json:"created_at"`
	StartedAt      *string `json:"started_at"`
	SuspendedAt    *string `json:"suspended_at"`
	DeliveredAt    *string `json:"delivered_at"`
	UpdatedAt      string  `json:"updated_at"`
}

// SessionFilter 是会话列表过滤条件。
type SessionFilter struct {
	ProjectID      *int64
	Status         string
	RoleID         *int64
	IncludeDeleted bool
}

// RoleConfig 是角色的执行配置，翻译为各 CLI 的原生参数。
// 通用字段 + Custom（CLI 特有参数，schema 由适配器按官方文档声明，
// 前端据此渲染不同角色各自的深度定制表单）。
type RoleConfig struct {
	Model        string            `json:"model"`
	SystemPrompt string            `json:"system_prompt"`
	Instructions string            `json:"instructions"` // 任务指令模板（追加在 system prompt 之后）
	Skills       []string          `json:"skills"`       // 角色选择的原始技能目录（任务启动时物化到 CLI 原生目录）
	Thinking     string            `json:"thinking"`     // "" 或 CLI 模型目录明确声明的档位
	Plugins      []string          `json:"plugins"`      // 插件/配置文件
	ExtraArgs    []string          `json:"extra_args"`
	Env          map[string]string `json:"env"`
	Custom       map[string]string `json:"custom,omitempty"` // CLI 特有参数（如 opencode 的 agent、claude 的 permission_mode）
}

type Role struct {
	ID             int64      `json:"id"`
	Name           string     `json:"name"`
	Description    string     `json:"description"`
	RuntimeID      string     `json:"runtime_id"` // Runtime ID：omp | opencode | pi | claude | codex
	RoleConfig     RoleConfig `json:"role_config"`
	MaxConcurrency int        `json:"max_concurrency"` // 该角色同时运行的任务上限
	Enabled        bool       `json:"enabled"`
	Revision       int64      `json:"revision"`
	CreatedAt      string     `json:"created_at"`
	UpdatedAt      string     `json:"updated_at"`
}

// ConcurrencyLimit 返回可执行的角色并发上限。零值收敛为 1，避免缺失配置
// 意外阻塞整个队列。
func (a Role) ConcurrencyLimit() int {
	if a.MaxConcurrency < 1 {
		return 1
	}
	return a.MaxConcurrency
}

type Task struct {
	ID             int64   `json:"id"`
	Title          string  `json:"title"`
	Body           string  `json:"body"`
	Status         string  `json:"status"`
	Perm           string  `json:"perm"`
	RunMode        string  `json:"run_mode"`
	Concurrent     bool    `json:"concurrent"` // 是否并发执行：默认串行（同一项目同时只执行一个任务）
	RoleID         *int64  `json:"role_id"`
	RoleName       string  `json:"role_name,omitempty"`
	ProjectID      *int64  `json:"project_id"`
	ProjectName    string  `json:"project_name,omitempty"`
	ProjectDir     string  `json:"project_dir"`
	ParentID       *int64  `json:"parent_id"`
	DependsOn      *int64  `json:"depends_on"`       // 前置实现任务（不直接指向合并子任务）
	DependencyMode string  `json:"dependency_mode"`  // none | weak（自动顺序）| strong（明确前置）
	BlockOnFailure bool    `json:"block_on_failure"` // 本交付失败时是否阻塞其弱依赖后项
	ScheduleID     *int64  `json:"schedule_id"`
	Error          string  `json:"error"`
	ExitCode       *int    `json:"exit_code"`
	ReviewNote     string  `json:"review_note"`
	ReviewRounds   int     `json:"review_rounds"`
	TmuxLogOffset  int64   `json:"-"`                       // 已从专用 tmux 原始日志同步到 SQLite 的字节偏移
	WorktreeBranch string  `json:"worktree_branch"`         // 任务隔离 worktree 分支（paihuo/task-<id>）
	BaseCommit     string  `json:"base_commit"`             // 创建 worktree 时主分支 HEAD
	ResumeOf       *int64  `json:"resume_of"`               // 续跑自哪个任务（复用其会话目录）
	MergeOf        *int64  `json:"merge_of"`                // 合并任务整合自哪个源任务
	SessionID      *int64  `json:"session_id"`              // 会话交付创建（复用会话 worktree/分支）
	WorkflowRunID  *int64  `json:"workflow_run_id"`         // Workflow Run 原子实例化的归属
	SortOrder      int64   `json:"sort_order"`              // 项目内执行顺序（合并任务不参与排序）
	TerminalCols   int     `json:"terminal_cols,omitempty"` // 交互终端最近同步尺寸（列）；0=未同步（默认 80）
	TerminalRows   int     `json:"terminal_rows,omitempty"` // 交互终端最近同步尺寸（行）；0=未同步（默认 24）
	Revision       int64   `json:"revision"`
	CreatedAt      string  `json:"created_at"`
	StartedAt      *string `json:"started_at"`
	FinishedAt     *string `json:"finished_at"`
	UpdatedAt      string  `json:"updated_at"`
}

// NewMergeTask 创建用于整合 source 代码的专属子任务。它自身带有 MergeOf，
// 因而执行成功后会写入主分支，而不会再次递归创建新的合并任务。
func NewMergeTask(source Task) Task {
	sourceID := source.ID
	return Task{
		Title: fmt.Sprintf("合并任务 #%d：%s", source.ID, taskFirstLine(source.Title, 80)),
		Body: fmt.Sprintf(`系统在任务 #%d 完成或审批通过后自动创建了本合并任务，源任务改动已导入当前 worktree。

源任务：%s
源分支：%s

请先 git status / diff 确认改动已进入当前工作区；如有冲突，解决冲突并保留双方有效改动；
然后运行与改动相关的测试或构建并修复问题。不要操作主工作区或手工合并 main——
退出后平台会自动 squash 合并本任务分支。`,
			source.ID, source.Title, source.WorktreeBranch),
		Status:         StatusQueued,
		Perm:           PermFull,
		RunMode:        RunModeBatch,
		RoleID:         source.RoleID,
		ProjectID:      source.ProjectID,
		ProjectDir:     source.ProjectDir,
		WorkflowRunID:  source.WorkflowRunID,
		ParentID:       &sourceID,
		MergeOf:        &sourceID,
		DependencyMode: DependencyNone,
		BlockOnFailure: source.BlockOnFailure,
	}
}

func taskFirstLine(s string, max int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len([]rune(s)) > max {
		s = string([]rune(s)[:max])
	}
	return s
}

// Duration 返回任务耗时（秒）：终态且 started/finished 齐全时有效。
func (t *Task) Duration() float64 {
	if t.StartedAt == nil || t.FinishedAt == nil {
		return 0
	}
	st, err1 := time.Parse(time.RFC3339, *t.StartedAt)
	ft, err2 := time.Parse(time.RFC3339, *t.FinishedAt)
	if err1 != nil || err2 != nil || ft.Before(st) {
		return 0
	}
	return ft.Sub(st).Seconds()
}

// Project 是派活的第一维度载体：一个项目聚合一批任务 + 一批角色的产出统计。
type Project struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Status      string `json:"status"` // active | archived
	ProjectDir  string `json:"project_dir"`
	IsGit       bool   `json:"is_git"` // git 仓库（列表时探测，非存储字段）
	Revision    int64  `json:"revision"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// Skill 是注册到 paihuo 工作目录的技能（角色配置时按名称勾选，执行时注入目录）。
type Skill struct {
	ID          int64    `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	Dir         string   `json:"dir"` // 复制后的实际目录（--add-dir 传这个）
	SourcePath  string   `json:"source_path"`
	CreatedAt   string   `json:"created_at"`
}

// ---------------------------------------------------------------------------
// 统计（维度二：任务管理 — 项目进度 + 在项目上工作的 Role 产出）

// StatusCount 某状态下任务数量。
type StatusCount struct {
	Status string `json:"status"`
	Count  int    `json:"count"`
}

// DailyCount 每日完成（succeeded）任务数。
type DailyCount struct {
	Date  string `json:"date"` // YYYY-MM-DD（UTC）
	Count int    `json:"count"`
}

// RoleProjectStat 某个 Role 在某个项目上的产出。
type RoleProjectStat struct {
	RoleID      int64   `json:"role_id"`
	RoleName    string  `json:"role_name"`
	ProjectID   int64   `json:"project_id"`
	ProjectName string  `json:"project_name"`
	Total       int     `json:"total"`
	Succeeded   int     `json:"succeeded"`
	Failed      int     `json:"failed"`
	Reviews     int     `json:"reviews"` // 审批轮次合计
	SuccessRate float64 `json:"success_rate"`
	AvgDuration float64 `json:"avg_duration"` // 秒
}

// RoleStats 单个 Role 的全量统计（概览 + 分项目 + 每日）。
type RoleStats struct {
	RoleID       int64             `json:"role_id"`
	RoleName     string            `json:"role_name"`
	RuntimeID    string            `json:"runtime_id"`
	Total        int               `json:"total"`
	InFlight     int               `json:"in_flight"`
	Succeeded    int               `json:"succeeded"`
	Failed       int               `json:"failed"`
	Cancelled    int               `json:"cancelled"`
	Reviews      int               `json:"reviews"`
	SuccessRate  float64           `json:"success_rate"`
	AvgDuration  float64           `json:"avg_duration"`
	StatusCounts []StatusCount     `json:"status_counts"`
	Projects     []RoleProjectStat `json:"projects"`
	Daily        []DailyCount      `json:"daily"`
}

// ProjectStats 项目进度 + 在项目上工作的 Role 统计。
type ProjectStats struct {
	ProjectID    int64             `json:"project_id"`
	ProjectName  string            `json:"project_name"`
	Total        int               `json:"total"`
	InFlight     int               `json:"in_flight"`
	Succeeded    int               `json:"succeeded"`
	Failed       int               `json:"failed"`
	Reviews      int               `json:"reviews"`
	Progress     float64           `json:"progress"` // 0-100（完成占比）
	StatusCounts []StatusCount     `json:"status_counts"`
	Roles        []RoleProjectStat `json:"roles"`
	Daily        []DailyCount      `json:"daily"`
}

// OverviewStats 全局总览（看板统计条）。
type OverviewStats struct {
	Total        int           `json:"total"`
	InFlight     int           `json:"in_flight"`
	Succeeded    int           `json:"succeeded"`
	Failed       int           `json:"failed"`
	Reviews      int           `json:"reviews"`
	Projects     int           `json:"projects"`
	SuccessRate  float64       `json:"success_rate"`
	AvgDuration  float64       `json:"avg_duration"`
	StatusCounts []StatusCount `json:"status_counts"`
	Daily        []DailyCount  `json:"daily"`
}

type TaskLog struct {
	ID        int64  `json:"id"`
	TaskID    int64  `json:"task_id"`
	Seq       int64  `json:"seq"`
	Stream    string `json:"stream"` // out | err | sys | in
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

// EventRecord is the authoritative append-only event envelope used for SSE
// resume. Payload retains the versioned domain JSON exactly as published.
type EventRecord struct {
	Seq       int64  `json:"seq"`
	Type      string `json:"type"`
	TaskID    int64  `json:"task_id,omitempty"`
	RoleID    int64  `json:"role_id,omitempty"`
	Payload   []byte `json:"-"`
	CreatedAt string `json:"created_at"`
}

type Schedule struct {
	ID             int64   `json:"id"`
	Name           string  `json:"name"`
	Cron           string  `json:"cron"`
	TitleTemplate  string  `json:"title_template"`
	BodyTemplate   string  `json:"body_template"`
	RoleID         int64   `json:"role_id"`
	RoleName       string  `json:"role_name,omitempty"`
	ProjectID      *int64  `json:"project_id"`
	ProjectName    string  `json:"project_name,omitempty"`
	Perm           string  `json:"perm"` // 每次触发时写入新建任务的权限模式
	BlockOnFailure bool    `json:"block_on_failure"`
	Enabled        bool    `json:"enabled"`
	Revision       int64   `json:"revision"`
	LastRunAt      *string `json:"last_run_at"`
	NextRunAt      *string `json:"next_run_at"`
	CreatedAt      string  `json:"created_at"`
}
