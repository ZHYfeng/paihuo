package store

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
type RoleConfig struct {
	Model        string            `json:"model"`
	SystemPrompt string            `json:"system_prompt"`
	Skills       []string          `json:"skills"`   // 技能目录
	Thinking     string            `json:"thinking"` // "" | low | medium | high
	Plugins      []string          `json:"plugins"`  // 插件/配置文件
	ExtraArgs    []string          `json:"extra_args"`
	Env          map[string]string `json:"env"`
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
	ID         int64   `json:"id"`
	Title      string  `json:"title"`
	Body       string  `json:"body"`
	Status     string  `json:"status"`
	Perm       string  `json:"perm"`
	AgentID    *int64  `json:"agent_id"`
	AgentName  string  `json:"agent_name,omitempty"`
	ProjectDir string  `json:"project_dir"`
	ParentID   *int64  `json:"parent_id"`
	ScheduleID *int64  `json:"schedule_id"`
	Error       string  `json:"error"`
	ExitCode    *int    `json:"exit_code"`
	ReviewNote  string  `json:"review_note"`
	ReviewRounds int    `json:"review_rounds"`
	CreatedAt  string  `json:"created_at"`
	StartedAt  *string `json:"started_at"`
	FinishedAt *string `json:"finished_at"`
	UpdatedAt  string  `json:"updated_at"`
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
