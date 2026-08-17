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

// Spec 描述一次可复用、可编辑的工作流编排。Edges 只表达依赖 ID，从不包含
// 可执行代码。Spec 不绑定 Project：具体项目在启动 Run 时指定，同一工作流
// 定义可复用于多个项目；定义创建后可通过 UpdateWorkflow 整体替换（重新
// 策略校验 + 重写 spec_hash，受 revision 保护），已实例化的 Run 不受影响。
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

// Run 是一次工作流任务的执行实例（实例书签，非实体）：启动时绑定具体
// Project，原子实例化节点子任务，task_ids 是节点 ID → 任务 ID 的稳定映射。
// Run 在启动瞬间固化节点任务与依赖图，之后编辑工作流定义不影响已开始的 Run。
// Task 是本次 Run 的自定义任务描述（可为空）：固定工作流按它完成具体任务，
// 启动时渲染进节点意图（{{.task}} 占位符），并保留在书签上供审计与展示。
type Run struct {
	ID         int64            `json:"id"`
	WorkflowID int64            `json:"workflow_id"`
	ProjectID  int64            `json:"project_id"`
	Task       string           `json:"task,omitempty"`
	Status     string           `json:"status"`
	TaskIDs    map[string]int64 `json:"task_ids"`
	Revision   int64            `json:"revision"`
	CreatedAt  string           `json:"created_at"`
	StartedAt  *string          `json:"started_at,omitempty"`
	FinishedAt *string          `json:"finished_at,omitempty"`
	UpdatedAt  string           `json:"updated_at"`
}

const (
	// 工作流任务（type=workflow）的状态：adopted = 已通过策略校验、可启动
	// Run 的就绪定义。定义可编辑（重新校验 + 重写 spec_hash）或删除，均受
	// revision 保护；存量库中的 proposed/validated/rejected 是旧版提案门禁
	// 遗留，不可启动。
	WorkflowStatusAdopted = "adopted"
	RunStatusCreated      = "created"
	RunStatusRunning      = "running"
	RunStatusSucceeded    = "succeeded"
	RunStatusFailed       = "failed"
	RunStatusCancelled    = "cancelled"
)
