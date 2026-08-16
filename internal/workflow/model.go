// Package workflow defines deterministic Workflow Spec, Policy and Run state.
// Proposal/Plan 物理上折叠为 type=workflow 的任务（spec/violations/spec_hash
// 字段 + 提案状态机）；本包只保留纯逻辑，不含进程、HTTP 或数据库代码。
package workflow

type Limits struct {
	Budget         int64 `json:"budget"`
	MaxNodes       int   `json:"max_nodes"`
	MaxDepth       int   `json:"max_depth"`
	MaxConcurrency int   `json:"max_concurrency"`
}

type RoleSelector struct {
	RoleID               int64    `json:"role_id"`
	RequiredCapabilities []string `json:"required_capabilities,omitempty"`
}

type Node struct {
	ID               string         `json:"id"`
	Intent           string         `json:"intent"`
	Role             RoleSelector   `json:"role"`
	DependsOn        []string       `json:"depends_on,omitempty"`
	Permission       string         `json:"permission"`
	AllowedActions   []string       `json:"allowed_actions,omitempty"`
	ApprovalRequired bool           `json:"approval_required"`
	InputRefs        []string       `json:"input_refs,omitempty"`
	OutputSchema     map[string]any `json:"output_schema,omitempty"`
	TimeoutSeconds   int            `json:"timeout_seconds"`
	FailurePolicy    string         `json:"failure_policy"`
	Budget           int64          `json:"budget"`
}

// Spec 创建时冻结（不可变），描述一次可复用的工作流编排。Edges 只表达依赖
// ID，从不包含可执行代码。Spec 不绑定 Project：具体项目在启动 Run 时指定，
// 同一工作流定义可复用于多个项目。
type Spec struct {
	Version   int64  `json:"version"`
	Goal      string `json:"goal"`
	CreatedBy string `json:"created_by"`
	Limits    Limits `json:"limits"`
	Nodes     []Node `json:"nodes"`
}

type Violation struct {
	Code    string `json:"code"`
	NodeID  string `json:"node_id,omitempty"`
	Message string `json:"message"`
}

// Run 是一次冻结工作流任务的执行实例（实例书签，非实体）：启动时绑定具体
// Project，原子实例化节点子任务，task_ids 是节点 ID → 任务 ID 的稳定映射。
type Run struct {
	ID         int64            `json:"id"`
	WorkflowID int64            `json:"workflow_id"`
	ProjectID  int64            `json:"project_id"`
	Status     string           `json:"status"`
	TaskIDs    map[string]int64 `json:"task_ids"`
	Revision   int64            `json:"revision"`
	CreatedAt  string           `json:"created_at"`
	StartedAt  *string          `json:"started_at,omitempty"`
	FinishedAt *string          `json:"finished_at,omitempty"`
	UpdatedAt  string           `json:"updated_at"`
}

const (
	// 工作流任务（type=workflow）的状态：创建即冻结（adopted），
	// 写入 spec_hash 之后不可变，可被多次 run。存量库中的
	// proposed/validated/rejected 是旧版提案门禁遗留，不可启动。
	WorkflowStatusFrozen = "adopted"
	RunStatusCreated     = "created"
	RunStatusRunning        = "running"
	RunStatusSucceeded      = "succeeded"
	RunStatusFailed         = "failed"
	RunStatusCancelled      = "cancelled"
)
