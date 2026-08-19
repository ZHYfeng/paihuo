package store

import "testing"

// 编排归属列：spawn 的子任务是否完整持久化了 parent_session_id / parent_task_id，
// 以及按会话/父任务查询是否返回正确的树。
func TestTaskParentColumnsRoundTrip(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	roleID, err := st.CreateRole(Role{Name: "r", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	sessionID, err := st.CreateSessionTask(Task{RoleID: &roleID, Title: "s", Status: SessionStatusActive})
	if err != nil {
		t.Fatal(err)
	}
	child, err := st.CreateTask(Task{Type: TaskTypeTask, Title: "c", Status: StatusQueued, RoleID: &roleID,
		ParentSessionID: &sessionID, ParentTaskID: &sessionID})
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.GetTask(child)
	if err != nil {
		t.Fatal(err)
	}
	if got.ParentSessionID == nil || *got.ParentSessionID != sessionID {
		t.Fatalf("parent_session_id 应持久化: %+v", got.ParentSessionID)
	}
	if got.ParentTaskID == nil || *got.ParentTaskID != sessionID {
		t.Fatalf("parent_task_id 应持久化: %+v", got.ParentTaskID)
	}

	children, err := st.ListChildrenBySession(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(children) != 1 || children[0].ID != child {
		t.Fatalf("按会话查子树应有 1 个: %+v", children)
	}
	byParent, err := st.ListChildrenByParentTask(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(byParent) != 1 || byParent[0].ID != child {
		t.Fatalf("按父任务查子任务应有 1 个: %+v", byParent)
	}

	// 删除会话应连带删除子树（parent_session_id / parent_task_id 都算孩子）
	deletion, err := st.ListTaskDeletionOrder(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, tk := range deletion {
		if tk.ID != child && tk.ID != sessionID {
			t.Fatalf("删除序包含无关任务: %+v", tk)
		}
	}
}

// 角色委托列：开关 + 上限持久化，且上限判定的无提权语义正确。
func TestRoleDelegationColumns(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	id, err := st.CreateRole(Role{Name: "orch", RuntimeID: "pi", Enabled: true, DelegationEnabled: true, DelegationMaxPerm: "review"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.GetRole(id)
	if err != nil {
		t.Fatal(err)
	}
	if !got.DelegationEnabled || got.DelegationMaxPerm != PermReview {
		t.Fatalf("角色委托列应持久化: %+v", got)
	}
	if got.DelegationPermAllowed(PermFull) {
		t.Fatal("review 上限不应允许 full 子任务")
	}
	if !got.DelegationPermAllowed(PermReview) {
		t.Fatal("review 上限应允许 review 子任务")
	}
	// 关闭委托 → 一律不允许
	off := Role{DelegationEnabled: false}
	if off.DelegationPermAllowed(PermReview) {
		t.Fatal("未开启委托不允许派子任务")
	}
	// full 上限 → 两者都允许
	full := Role{DelegationEnabled: true, DelegationMaxPerm: PermFull}
	if !full.DelegationPermAllowed(PermFull) || !full.DelegationPermAllowed(PermReview) {
		t.Fatal("full 上限应允许 full 与 review 子任务")
	}
}
