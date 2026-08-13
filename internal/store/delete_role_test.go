package store

import "testing"

// 删除角色：已有任务与模板解除指派（保留审计记录），定时任务随角色删除，
// 不应因外键约束而失败。
func TestDeleteRoleWithReferences(t *testing.T) {
	s := openTest(t)
	aid, err := s.CreateRole(Role{Name: "a1", RuntimeID: "pi"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateSchedule(Schedule{Name: "s1", Cron: "0 * * * * *", TitleTemplate: "t", RoleID: aid}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateTemplate(Template{Name: "tpl1", Body: "b", RoleID: &aid}); err != nil {
		t.Fatal(err)
	}
	done := mustTask(t, s, "done", &aid, "succeeded", "x")

	if err := s.DeleteRole(aid); err != nil {
		t.Fatalf("DeleteRole: %v", err)
	}

	// 定时任务已随角色删除
	scs, err := s.ListSchedules()
	if err != nil {
		t.Fatal(err)
	}
	if len(scs) != 0 {
		t.Fatalf("schedules not cascaded: %+v", scs)
	}
	// 已有任务与模板保留但解除指派
	got, err := s.GetTask(done)
	if err != nil {
		t.Fatal(err)
	}
	if got.RoleID != nil {
		t.Fatalf("task role_id = %v, want NULL", *got.RoleID)
	}
	tpls, err := s.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	var referenced *Template
	for i := range tpls {
		if tpls[i].Name == "tpl1" {
			referenced = &tpls[i]
			break
		}
	}
	if referenced == nil || referenced.RoleID != nil {
		t.Fatalf("templates = %+v, want tpl1 with NULL role_id", tpls)
	}
	if _, err := s.GetRole(aid); err == nil {
		t.Fatal("agent still exists after delete")
	}
}

// 删除角色时仍有未完成任务应拒绝，且不得留下半删状态。
func TestDeleteRoleWithActiveTasks(t *testing.T) {
	s := openTest(t)
	aid := mustRole(t, s, "a1", true)
	_ = mustTask(t, s, "running", &aid, "running", "x")

	if err := s.DeleteRole(aid); err == nil {
		t.Fatal("expected error for active tasks")
	}
	// 角色与任务都还在
	if _, err := s.GetRole(aid); err != nil {
		t.Fatalf("agent should remain: %v", err)
	}
	if _, err := s.GetTask(mustTask(t, s, "queued", &aid, "queued", "x")); err != nil {
		t.Fatalf("task should remain: %v", err)
	}
}
