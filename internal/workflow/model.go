// Package workflow defines deterministic Workflow Plan, Proposal, Policy and
// Run state. It contains no process, HTTP or database code.
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

type Proposal struct {
	ID         int64       `json:"id"`
	Spec       Spec        `json:"spec"`
	Status     string      `json:"status"`
	Violations []Violation `json:"violations"`
	Revision   int64       `json:"revision"`
	CreatedAt  string      `json:"created_at"`
	UpdatedAt  string      `json:"updated_at"`
}

type Plan struct {
	ID         int64  `json:"id"`
	Version    int64  `json:"version"`
	Spec       Spec   `json:"spec"`
	SpecHash   string `json:"spec_hash"`
	Status     string `json:"status"`
	ProposalID *int64 `json:"proposal_id,omitempty"`
	Revision   int64  `json:"revision"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

type Run struct {
	ID         int64            `json:"id"`
	PlanID     int64            `json:"plan_id"`
	Status     string           `json:"status"`
	TaskIDs    map[string]int64 `json:"task_ids"`
	Revision   int64            `json:"revision"`
	CreatedAt  string           `json:"created_at"`
	StartedAt  *string          `json:"started_at,omitempty"`
	FinishedAt *string          `json:"finished_at,omitempty"`
	UpdatedAt  string           `json:"updated_at"`
}

const (
	ProposalStatusProposed  = "proposed"
	ProposalStatusValidated = "validated"
	ProposalStatusRejected  = "rejected"
	ProposalStatusAdopted   = "adopted"
	PlanStatusFrozen        = "frozen"
	PlanStatusRunning       = "running"
	PlanStatusSucceeded     = "succeeded"
	PlanStatusFailed        = "failed"
	PlanStatusCancelled     = "cancelled"
	RunStatusCreated        = "created"
	RunStatusRunning        = "running"
	RunStatusSucceeded      = "succeeded"
	RunStatusFailed         = "failed"
	RunStatusCancelled      = "cancelled"
)
