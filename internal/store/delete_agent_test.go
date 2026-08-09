package store

import "testing"

// 删除角色：历史任务与模板解除指派（保留记录），定时任务随角色删除，
// 不应因外键约束而失败。
func TestDeleteAgentWithReferences(t *testing.T) {
	s := openTest(t)
	aid, err := s.CreateAgent(Agent{Name: "a1", CLI: "pi"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateSchedule(Schedule{Name: "s1", Cron: "* * * * *", TitleTemplate: "t", AgentID: aid}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateTemplate(Template{Name: "tpl1", Body: "b", AgentID: &aid}); err != nil {
		t.Fatal(err)
	}
	done := mustTask(t, s, "done", &aid, "succeeded", "x")

	if err := s.DeleteAgent(aid); err != nil {
		t.Fatalf("DeleteAgent: %v", err)
	}

	// 定时任务已随角色删除
	scs, err := s.ListSchedules()
	if err != nil {
		t.Fatal(err)
	}
	if len(scs) != 0 {
		t.Fatalf("schedules not cascaded: %+v", scs)
	}
	// 历史任务与模板保留但解除指派
	got, err := s.GetTask(done)
	if err != nil {
		t.Fatal(err)
	}
	if got.AgentID != nil {
		t.Fatalf("task agent_id = %v, want NULL", *got.AgentID)
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
	if referenced == nil || referenced.AgentID != nil {
		t.Fatalf("templates = %+v, want tpl1 with NULL agent_id", tpls)
	}
	if _, err := s.GetAgent(aid); err == nil {
		t.Fatal("agent still exists after delete")
	}
}

// 删除角色时仍有未完成任务应拒绝，且不得留下半删状态。
func TestDeleteAgentWithActiveTasks(t *testing.T) {
	s := openTest(t)
	aid := mustAgent(t, s, "a1", true)
	_ = mustTask(t, s, "running", &aid, "running", "x")

	if err := s.DeleteAgent(aid); err == nil {
		t.Fatal("expected error for active tasks")
	}
	// 角色与任务都还在
	if _, err := s.GetAgent(aid); err != nil {
		t.Fatalf("agent should remain: %v", err)
	}
	if _, err := s.GetTask(mustTask(t, s, "queued", &aid, "queued", "x")); err != nil {
		t.Fatalf("task should remain: %v", err)
	}
}
