package store

import "time"

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
	PermFull   = "full"   // 完整：直接执行
	PermReview = "review" // 完成后审批：跑完进入待审批，通过才算成功
)

// RoleConfig 是角色的执行配置，翻译为各 CLI 的原生参数。
// 通用字段 + Custom（CLI 特有参数，schema 由适配器按官方文档声明，
// 前端据此渲染不同角色各自的深度定制表单）。
type RoleConfig struct {
	Model        string            `json:"model"`
	SystemPrompt string            `json:"system_prompt"`
	Instructions string            `json:"instructions"` // 任务指令模板（追加在 system prompt 之后）
	Skills       []string          `json:"skills"`   // 技能目录
	Thinking     string            `json:"thinking"` // "" | low | medium | high
	Plugins      []string          `json:"plugins"`  // 插件/配置文件
	ExtraArgs    []string          `json:"extra_args"`
	Env          map[string]string `json:"env"`
	Custom       map[string]string `json:"custom,omitempty"` // CLI 特有参数（如 opencode 的 agent、claude 的 permission_mode）
}

type Agent struct {
	ID          int64      `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	CLI         string     `json:"cli"` // 适配器 id：omp | opencode | pi | claude | codex
	RoleConfig  RoleConfig `json:"role_config"`
	ProjectDir  string     `json:"project_dir"` // 绑定的项目目录
	DefaultPerm string     `json:"default_perm"`
	Enabled     bool       `json:"enabled"`
	CreatedAt   string     `json:"created_at"`
	UpdatedAt   string     `json:"updated_at"`
}

type Task struct {
	ID           int64   `json:"id"`
	Title        string  `json:"title"`
	Body         string  `json:"body"`
	Status       string  `json:"status"`
	Perm         string  `json:"perm"`
	AgentID      *int64  `json:"agent_id"`
	AgentName    string  `json:"agent_name,omitempty"`
	ProjectID    *int64  `json:"project_id"`
	ProjectName  string  `json:"project_name,omitempty"`
	ProjectDir   string  `json:"project_dir"`
	ParentID     *int64  `json:"parent_id"`
	ScheduleID   *int64  `json:"schedule_id"`
	Error        string  `json:"error"`
	ExitCode     *int    `json:"exit_code"`
	ReviewNote   string  `json:"review_note"`
	ReviewRounds int     `json:"review_rounds"`
	WorktreeBranch string `json:"worktree_branch"` // 任务隔离 worktree 分支（paihuo/task-<id>）
	BaseCommit     string `json:"base_commit"`     // 创建 worktree 时主分支 HEAD
	ResumeOf       *int64  `json:"resume_of"`      // 续跑自哪个任务（复用其会话目录）
	CreatedAt    string  `json:"created_at"`
	StartedAt    *string `json:"started_at"`
	FinishedAt   *string `json:"finished_at"`
	UpdatedAt    string  `json:"updated_at"`
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
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// Skill 是注册到 paihuo 工作目录的技能（角色配置时按名称勾选，执行时注入目录）。
type Skill struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Dir         string `json:"dir"` // 复制后的实际目录（--add-dir 传这个）
	SourcePath  string `json:"source_path"`
	CreatedAt   string `json:"created_at"`
}

// ---------------------------------------------------------------------------
// 统计（维度二：任务管理 — 项目进度 + 在项目上工作的 agent 产出）

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

// AgentProjectStat 某 agent 在某个项目上的产出。
type AgentProjectStat struct {
	AgentID     int64   `json:"agent_id"`
	AgentName   string  `json:"agent_name"`
	ProjectID   int64   `json:"project_id"`
	ProjectName string  `json:"project_name"`
	Total       int     `json:"total"`
	Succeeded   int     `json:"succeeded"`
	Failed      int     `json:"failed"`
	Reviews     int     `json:"reviews"` // 审批轮次合计
	SuccessRate float64 `json:"success_rate"`
	AvgDuration float64 `json:"avg_duration"` // 秒
}

// AgentStats 单个 agent 的全量统计（概览 + 分项目 + 每日）。
type AgentStats struct {
	AgentID      int64              `json:"agent_id"`
	AgentName    string             `json:"agent_name"`
	CLI          string             `json:"cli"`
	Total        int                `json:"total"`
	InFlight     int                `json:"in_flight"`
	Succeeded    int                `json:"succeeded"`
	Failed       int                `json:"failed"`
	Cancelled    int                `json:"cancelled"`
	Reviews      int                `json:"reviews"`
	SuccessRate  float64            `json:"success_rate"`
	AvgDuration  float64            `json:"avg_duration"`
	StatusCounts []StatusCount      `json:"status_counts"`
	Projects     []AgentProjectStat `json:"projects"`
	Daily        []DailyCount       `json:"daily"`
}

// ProjectStats 项目进度 + 在项目上工作的 agent 统计。
type ProjectStats struct {
	ProjectID    int64              `json:"project_id"`
	ProjectName  string             `json:"project_name"`
	Total        int                `json:"total"`
	InFlight     int                `json:"in_flight"`
	Succeeded    int                `json:"succeeded"`
	Failed       int                `json:"failed"`
	Reviews      int                `json:"reviews"`
	Progress     float64            `json:"progress"` // 0-100（完成占比）
	StatusCounts []StatusCount      `json:"status_counts"`
	Agents       []AgentProjectStat `json:"agents"`
	Daily        []DailyCount       `json:"daily"`
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
	Stream    string `json:"stream"` // out | err | sys
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

type Schedule struct {
	ID            int64   `json:"id"`
	Name          string  `json:"name"`
	Cron          string  `json:"cron"`
	TitleTemplate string  `json:"title_template"`
	BodyTemplate  string  `json:"body_template"`
	AgentID       int64   `json:"agent_id"`
	AgentName     string  `json:"agent_name,omitempty"`
	Enabled       bool    `json:"enabled"`
	LastRunAt     *string `json:"last_run_at"`
	NextRunAt     *string `json:"next_run_at"`
	CreatedAt     string  `json:"created_at"`
}
