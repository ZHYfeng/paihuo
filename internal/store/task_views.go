package store

// SessionTask is the shape-specific view of a Task used by Session use cases.
// It deliberately copies only selected common fields and Session fields; it
// does not embed Task or expose Workflow fields.
type SessionTask struct {
	ID             int64
	Title          string
	Body           string
	Status         string
	Perm           string
	RoleID         *int64
	ProjectID      *int64
	ProjectDir     string
	WorktreeBranch string
	BaseCommit     string
	Revision       int64
	CreatedAt      string
	UpdatedAt      string

	WorktreePath  string
	SessionDir    string
	LastMessageAt string
	MessageCount  int
	SuspendedAt   *string
	DeliveredAt   *string
}

// WorkflowTask is the shape-specific view of a Task used by Workflow use
// cases. It deliberately copies only selected common fields and Workflow
// fields; it does not embed Task or expose Session fields.
type WorkflowTask struct {
	ID        int64
	Title     string
	Body      string
	Status    string
	ProjectID *int64
	Cron      string
	Enabled   bool
	Revision  int64
	CreatedAt string
	UpdatedAt string

	Spec       string
	Violations string
	SpecHash   string
}

func (t Task) AsSession() (SessionTask, bool) {
	if t.Type != TaskTypeSession {
		return SessionTask{}, false
	}
	return SessionTask{
		ID:             t.ID,
		Title:          t.Title,
		Body:           t.Body,
		Status:         t.Status,
		Perm:           t.Perm,
		RoleID:         t.RoleID,
		ProjectID:      t.ProjectID,
		ProjectDir:     t.ProjectDir,
		WorktreeBranch: t.WorktreeBranch,
		BaseCommit:     t.BaseCommit,
		Revision:       t.Revision,
		CreatedAt:      t.CreatedAt,
		UpdatedAt:      t.UpdatedAt,
		WorktreePath:   t.WorktreePath,
		SessionDir:     t.SessionDir,
		LastMessageAt:  t.LastMessageAt,
		MessageCount:   t.MessageCount,
		SuspendedAt:    t.SuspendedAt,
		DeliveredAt:    t.DeliveredAt,
	}, true
}

func (t Task) AsWorkflow() (WorkflowTask, bool) {
	if t.Type != TaskTypeWorkflow {
		return WorkflowTask{}, false
	}
	return WorkflowTask{
		ID:         t.ID,
		Title:      t.Title,
		Body:       t.Body,
		Status:     t.Status,
		ProjectID:  t.ProjectID,
		Cron:       t.Cron,
		Enabled:    t.Enabled,
		Revision:   t.Revision,
		CreatedAt:  t.CreatedAt,
		UpdatedAt:  t.UpdatedAt,
		Spec:       t.Spec,
		Violations: t.Violations,
		SpecHash:   t.SpecHash,
	}, true
}
