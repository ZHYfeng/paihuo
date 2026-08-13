package session

import (
	"context"
	"path/filepath"
	"testing"

	"paihuo/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// 回归：会话交付的任务必须计入项目统计（总数/列表），且 in_flight 只统计
// queued/claimed/running/awaiting_review（交付任务直接收编为 succeeded，
// 不应出现在「进行中」里——此前 ProjectStatsOf 把 statusCountsOf 的总数误赋给
// in_flight，交付后项目页「进行中」显示全部任务数）。
func TestDeliveredTaskCountsInProjectStats(t *testing.T) {
	m, st, _, _ := newTestEnv(t)
	proj, _ := st.ListProjects()
	agents, _ := st.ListRoles()
	pid, aid := proj[0].ID, agents[0].ID

	// 对照：普通批处理任务（queued）。
	if _, err := st.CreateTask(store.Task{Title: "普通任务", Status: store.StatusQueued, Perm: store.PermFull, RunMode: store.RunModeBatch, RoleID: &aid, ProjectID: &pid, ProjectDir: proj[0].ProjectDir}); err != nil {
		t.Fatal(err)
	}

	// 会话 → 交付（full + git：任务直接 succeeded + 自动创建合并任务）。
	ss, err := m.Create(&pid, aid)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSession(ss.ID, map[string]any{"status": store.SessionStatusSuspended}); err != nil {
		t.Fatal(err)
	}
	tk, err := m.Deliver(context.Background(), ss.ID, "交付任务", "", store.PermFull)
	if err != nil {
		t.Fatal(err)
	}
	if tk.ProjectID == nil || *tk.ProjectID != pid {
		t.Fatalf("交付任务 project_id=%v, want %d", tk.ProjectID, pid)
	}

	ps, err := st.ProjectStatsOf(pid)
	if err != nil {
		t.Fatal(err)
	}
	// 总数必须包含交付任务（普通 + 交付 + 合并 = 3）。
	if ps.Total != 3 {
		t.Fatalf("项目任务总数=%d, want 3（含会话交付任务）", ps.Total)
	}
	// 进行中 = 普通任务 queued + 合并任务 queued = 2（交付任务 succeeded 不算）。
	if ps.InFlight != 2 {
		t.Fatalf("项目进行中=%d, want 2（交付任务不应计入进行中）", ps.InFlight)
	}
	if ps.Succeeded != 1 {
		t.Fatalf("项目完成数=%d, want 1", ps.Succeeded)
	}

	tasks, err := st.ListTasksFiltered(store.TaskFilter{ProjectID: &pid})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 3 {
		t.Fatalf("项目任务列表 len=%d, want 3", len(tasks))
	}
	var found bool
	for _, x := range tasks {
		if x.ID == tk.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("交付任务 #%d 不在项目任务列表中", tk.ID)
	}
}

// 交付即终态：delivered 会话不可再次交付、可手动丢弃（归档出口），
// 丢弃不影响已创建的任务。
func TestDeliveredSessionDiscardableNotReusable(t *testing.T) {
	m, st, _, _ := newTestEnv(t)
	proj, _ := st.ListProjects()
	agents, _ := st.ListRoles()
	ss, err := m.Create(&proj[0].ID, agents[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSession(ss.ID, map[string]any{"status": store.SessionStatusSuspended}); err != nil {
		t.Fatal(err)
	}
	tk, err := m.Deliver(context.Background(), ss.ID, "交付归档", "", store.PermReview)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := m.Get(ss.ID)
	if got.Status != store.SessionStatusDelivered {
		t.Fatalf("交付后 status=%s", got.Status)
	}
	// 已交付会话不能再次交付（状态机拒绝，不再解冻）。
	if _, err := m.Deliver(context.Background(), ss.ID, "再次交付", "", store.PermFull); err == nil {
		t.Fatal("已交付会话不应允许再次交付")
	}
	// 已交付会话可手动丢弃（不影响任务）。
	if err := m.Delete(context.Background(), ss.ID); err != nil {
		t.Fatalf("丢弃已交付会话失败: %v", err)
	}
	got, _ = m.Get(ss.ID)
	if got.Status != store.SessionStatusDeleted {
		t.Fatalf("丢弃后 status=%s", got.Status)
	}
	tk2, err := st.GetTask(tk.ID)
	if err != nil || tk2.Status != store.StatusAwaitingReview {
		t.Fatalf("丢弃会话不应影响任务: %+v err=%v", tk2, err)
	}
}

// 回归：全局总览 in_flight 同样只统计进行中状态，而不是全部任务数。
func TestOverviewInFlightCountsOnlyActive(t *testing.T) {
	st := openStore(t)
	agentID, err := st.CreateRole(store.Role{Name: "a", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	pid, err := st.CreateProject(store.Project{Name: "p", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sid, err := st.CreateSession(store.Session{Title: "s", RoleID: agentID, Status: store.SessionStatusDelivered})
	if err != nil {
		t.Fatal(err)
	}
	// 一个 queued + 一个已完成的会话交付任务 + 一个 queued 合并任务。
	must := func(tk store.Task) int64 {
		t.Helper()
		id, err := st.CreateTask(tk)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	must(store.Task{Title: "queued", Status: store.StatusQueued, Perm: store.PermFull, RoleID: &agentID})
	must(store.Task{Title: "delivered", Status: store.StatusSucceeded, Perm: store.PermFull, RunMode: store.RunModeBatch, RoleID: &agentID, ProjectID: &pid, ProjectDir: t.TempDir(), SessionID: &sid})
	must(store.Task{Title: "merge", Status: store.StatusQueued, Perm: store.PermFull, RoleID: &agentID, ProjectID: &pid, ProjectDir: t.TempDir()})

	ov, err := st.OverviewStatsOf()
	if err != nil {
		t.Fatal(err)
	}
	if ov.Total != 3 {
		t.Fatalf("总览总数=%d, want 3", ov.Total)
	}
	if ov.InFlight != 2 {
		t.Fatalf("总览进行中=%d, want 2", ov.InFlight)
	}
}
