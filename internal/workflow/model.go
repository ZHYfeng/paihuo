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

// Spec is immutable after adoption. Edges are expressed only as dependency
// IDs and never contain executable code.
type Spec struct {
	Version        int64  `json:"version"`
	Goal           string `json:"goal"`
	ProjectID      int64  `json:"project_id"`
	CreatedBy      string `json:"created_by"`
	AdoptionPolicy string `json:"adoption_policy"`
	Limits         Limits `json:"limits"`
	Nodes          []Node `json:"nodes"`
}

type Violation struct {
	Code    string `json:"code"`
	NodeID  string `json:"node_id,omitempty"`
	Message string `json:"message"`
}

// Run 是一次冻结工作流任务的执行实例（实例书签，非实体）：
// 原子实例化节点子任务，task_ids 是节点 ID → 任务 ID 的稳定映射。
type Run struct {
	ID         int64            `json:"id"`
	WorkflowID int64            `json:"workflow_id"`
	Status     string           `json:"status"`
	TaskIDs    map[string]int64 `json:"task_ids"`
	Revision   int64            `json:"revision"`
	CreatedAt  string           `json:"created_at"`
	StartedAt  *string          `json:"started_at,omitempty"`
	FinishedAt *string          `json:"finished_at,omitempty"`
	UpdatedAt  string           `json:"updated_at"`
}

const (
	// 工作流任务（type=workflow）的状态：提案门禁。
	ProposalStatusProposed  = "proposed"
	ProposalStatusValidated = "validated"
	ProposalStatusRejected  = "rejected"
	ProposalStatusAdopted   = "adopted" // 冻结：spec_hash 写入，之后不可变，可被多次 run
	RunStatusCreated        = "created"
	RunStatusRunning        = "running"
	RunStatusSucceeded      = "succeeded"
	RunStatusFailed         = "failed"
	RunStatusCancelled      = "cancelled"
)
