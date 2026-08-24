package store

import "testing"

func TestTaskShapeViewsMapOnlyTheirShape(t *testing.T) {
	roleID, projectID := int64(2), int64(3)
	suspended, delivered := "2026-08-24T10:00:00Z", "2026-08-24T11:00:00Z"
	sessionSource := Task{
		ID: 1, Type: TaskTypeSession, Title: "session", Body: "seed", Status: SessionStatusSuspended,
		Perm: PermReview, RoleID: &roleID, ProjectID: &projectID, ProjectDir: "/project",
		WorktreeBranch: "paihuo/session-1", BaseCommit: "abc", Revision: 4,
		CreatedAt: "created", UpdatedAt: "updated", WorktreePath: "/worktree",
		SessionDir: "/sessions/1", LastMessageAt: "last", MessageCount: 7,
		SuspendedAt: &suspended, DeliveredAt: &delivered,
		Spec: "must not escape into SessionTask",
	}
	ss, ok := sessionSource.AsSession()
	if !ok {
		t.Fatal("type=session must convert")
	}
	if ss.ID != sessionSource.ID || ss.RoleID == nil || *ss.RoleID != roleID || ss.WorktreePath != "/worktree" || ss.SessionDir != "/sessions/1" || ss.MessageCount != 7 || ss.SuspendedAt == nil || *ss.SuspendedAt != suspended {
		t.Fatalf("SessionTask mapping mismatch: %+v", ss)
	}

	workflowSource := Task{
		ID: 5, Type: TaskTypeWorkflow, Title: "workflow", Body: "goal", Status: "adopted",
		ProjectID: &projectID, Cron: "0 * * * * *", Enabled: true, Revision: 8,
		CreatedAt: "created", UpdatedAt: "updated", Spec: `{"goal":"workflow"}`,
		Violations: "[]", SpecHash: "hash", SessionDir: "must not escape into WorkflowTask",
	}
	wf, ok := workflowSource.AsWorkflow()
	if !ok {
		t.Fatal("type=workflow must convert")
	}
	if wf.ID != workflowSource.ID || wf.ProjectID == nil || *wf.ProjectID != projectID || wf.Spec != workflowSource.Spec || wf.SpecHash != "hash" || !wf.Enabled {
		t.Fatalf("WorkflowTask mapping mismatch: %+v", wf)
	}
}

func TestTaskShapeViewsRejectOtherAndMissingTypes(t *testing.T) {
	for _, taskType := range []string{"", TaskTypeTask, TaskTypeWorkflow, "unknown"} {
		if _, ok := (Task{Type: taskType}).AsSession(); ok {
			t.Fatalf("AsSession accepted type %q", taskType)
		}
	}
	for _, taskType := range []string{"", TaskTypeTask, TaskTypeSession, "unknown"} {
		if _, ok := (Task{Type: taskType}).AsWorkflow(); ok {
			t.Fatalf("AsWorkflow accepted type %q", taskType)
		}
	}
}

func TestShapeSpecificStoreEntrypointsRejectWrongTaskType(t *testing.T) {
	st := openTest(t)
	ordinaryID, err := st.CreateTask(Task{Type: TaskTypeTask, Title: "ordinary", Status: StatusQueued})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := st.GetSessionTask(ordinaryID); err != nil || got != nil {
		t.Fatalf("GetSessionTask ordinary = %+v, %v; want nil, nil", got, err)
	}
	if got, err := st.GetWorkflowTask(ordinaryID); err != nil || got != nil {
		t.Fatalf("GetWorkflowTask ordinary = %+v, %v; want nil, nil", got, err)
	}
	if _, err := st.CreateSessionTask(Task{Type: TaskTypeWorkflow, Title: "wrong"}); err == nil {
		t.Fatal("CreateSessionTask must reject type=workflow")
	}
}
