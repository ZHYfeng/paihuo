package store

import "testing"

// 项目任务默认采用按创建时间连接的弱依赖；用户选择前置任务时则保存为强
// 依赖。后续自动任务仍以前一条“实现任务”为前序，而不是以合并子任务为前序。
func TestCreateProjectTaskDependencies(t *testing.T) {
	s := openTest(t)
	p1, err := s.CreateProject(Project{Name: "p1", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	p2, err := s.CreateProject(Project{Name: "p2", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	firstID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "first", Status: StatusQueued, ProjectID: &p1,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.GetTask(firstID)
	if err != nil {
		t.Fatal(err)
	}
	if first.DependencyMode != DependencyWeak || first.DependsOn != nil {
		t.Fatalf("项目首项应为无前置的弱依赖，得到 %+v", first)
	}
	secondID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "second", Status: StatusQueued, ProjectID: &p1, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.GetTask(secondID)
	if err != nil {
		t.Fatal(err)
	}
	if second.DependencyMode != DependencyWeak || second.DependsOn == nil || *second.DependsOn != firstID {
		t.Fatalf("第二项应弱依赖第一项，得到 %+v", second)
	}
	strongID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "strong", Status: StatusQueued, ProjectID: &p1, DependencyMode: DependencyStrong, DependsOn: &firstID,
	})
	if err != nil {
		t.Fatal(err)
	}
	strong, err := s.GetTask(strongID)
	if err != nil {
		t.Fatal(err)
	}
	if strong.DependencyMode != DependencyStrong || strong.DependsOn == nil || *strong.DependsOn != firstID {
		t.Fatalf("明确前置应保存为强依赖，得到 %+v", strong)
	}
	fourthID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "after strong", Status: StatusQueued, ProjectID: &p1, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	fourth, err := s.GetTask(fourthID)
	if err != nil {
		t.Fatal(err)
	}
	if fourth.DependsOn == nil || *fourth.DependsOn != strongID {
		t.Fatalf("后续自动任务应依赖最近创建的实现任务 #%d，得到 %+v", strongID, fourth)
	}
	if _, err := s.CreateTaskWithProjectDependency(Task{
		Title: "cross project", Status: StatusQueued, ProjectID: &p2, DependencyMode: DependencyStrong, DependsOn: &firstID,
	}); err == nil {
		t.Fatal("跨项目的强依赖应被拒绝")
	}
	if _, err := s.CreateTaskWithProjectDependency(Task{
		Title: "no project", Status: StatusQueued, DependencyMode: DependencyWeak,
	}); err == nil {
		t.Fatal("无项目任务不应允许弱依赖")
	}
}

// 项目内待执行实现任务可以调整顺序；重排会同步弱依赖链，而代码合并
// 任务不参与项目排序，并且在全局队列中仍然优先于实现任务。
func TestReorderProjectQueuedTasks(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "order-agent", true)
	projectID, err := s.CreateProject(Project{Name: "order-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	create := func(title string) int64 {
		t.Helper()
		id, err := s.CreateTaskWithProjectDependency(Task{
			Title: title, Status: StatusQueued, RoleID: &agentID, ProjectID: &projectID,
			DependencyMode: DependencyWeak,
		})
		if err != nil {
			t.Fatalf("创建 %s: %v", title, err)
		}
		return id
	}
	firstID, secondID, thirdID := create("first"), create("second"), create("third")
	first, err := s.GetTask(firstID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := s.CreateTask(NewMergeTask(*first))
	if err != nil {
		t.Fatal(err)
	}

	projectTasks, err := s.ListTasksFiltered(TaskFilter{ProjectID: &projectID})
	if err != nil {
		t.Fatal(err)
	}
	if len(projectTasks) < 4 || projectTasks[0].ID != firstID || projectTasks[1].ID != secondID || projectTasks[2].ID != thirdID || projectTasks[3].ID != mergeID {
		t.Fatalf("默认项目顺序应按创建时间排列，得到 %+v", projectTasks)
	}

	if err := s.ReorderProjectTasks(projectID, []int64{thirdID, firstID, secondID}); err != nil {
		t.Fatalf("重排项目任务失败: %v", err)
	}
	projectTasks, err = s.ListTasksFiltered(TaskFilter{ProjectID: &projectID})
	if err != nil {
		t.Fatal(err)
	}
	if projectTasks[0].ID != thirdID || projectTasks[1].ID != firstID || projectTasks[2].ID != secondID || projectTasks[3].ID != mergeID {
		t.Fatalf("重排后项目顺序异常，得到 %+v", projectTasks)
	}
	first, err = s.GetTask(firstID)
	if err != nil || first.DependsOn == nil || *first.DependsOn != thirdID {
		t.Fatalf("重排后弱依赖链未同步: task=%+v err=%v", first, err)
	}
	second, err := s.GetTask(secondID)
	if err != nil || second.DependsOn == nil || *second.DependsOn != firstID {
		t.Fatalf("重排后末项弱依赖未同步: task=%+v err=%v", second, err)
	}

	queued, err := s.ListQueuedTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) < 4 || queued[0].ID != mergeID || queued[1].ID != thirdID || queued[2].ID != firstID || queued[3].ID != secondID {
		t.Fatalf("合并任务或项目执行顺序异常: %+v", queued)
	}
	if err := s.ReorderProjectTasks(projectID, []int64{thirdID, firstID, secondID, mergeID}); err == nil {
		t.Fatal("合并任务不应进入可调整顺序的实现任务列表")
	}
}

// 合并任务只相对自己项目的实现任务优先；跨项目按「项目最早排队任务」公平
// 竞争，避免一个项目的合并任务抢占其他项目的角色槽位。
func TestListQueuedTasksFairAcrossProjects(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "worker", true)
	projectA, err := s.CreateProject(Project{Name: "proj-a", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	projectB, err := s.CreateProject(Project{Name: "proj-b", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}

	// 时间线：B 项目的实现任务最先排队（T0）；A 项目的源任务完成于 T1，
	// 随后 A 创建合并任务（T2）与新的实现任务（T3）。
	setCreated := func(id int64, at string) {
		if err := s.UpdateTask(id, map[string]any{"created_at": at}); err != nil {
			t.Fatal(err)
		}
	}
	otherID, err := s.CreateTask(Task{Title: "other-project impl", Status: StatusQueued, RoleID: &agentID, ProjectID: &projectB, ProjectDir: "/tmp/b"})
	if err != nil {
		t.Fatal(err)
	}
	setCreated(otherID, "2026-08-14T10:00:00")
	sourceID, err := s.CreateTask(Task{Title: "source", Status: StatusSucceeded, RoleID: &agentID, ProjectID: &projectA, ProjectDir: "/tmp/a", WorktreeBranch: "paihuo/task-source"})
	if err != nil {
		t.Fatal(err)
	}
	setCreated(sourceID, "2026-08-14T10:01:00")
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := s.CreateTask(NewMergeTask(*source))
	if err != nil {
		t.Fatal(err)
	}
	setCreated(mergeID, "2026-08-14T10:02:00")
	nextID, err := s.CreateTask(Task{Title: "same-project next", Status: StatusQueued, RoleID: &agentID, ProjectID: &projectA, ProjectDir: "/tmp/a"})
	if err != nil {
		t.Fatal(err)
	}
	setCreated(nextID, "2026-08-14T10:03:00")

	queued, err := s.ListQueuedTasks()
	if err != nil {
		t.Fatal(err)
	}
	got := make([]int64, 0, len(queued))
	for _, tk := range queued {
		got = append(got, tk.ID)
	}
	// B 项目整体更早排队（T0），先于 A 项目的合并任务（T2）；A 项目内部
	// 合并任务仍排在实现任务之前。
	want := []int64{otherID, mergeID, nextID}
	if len(got) != len(want) {
		t.Fatalf("排队顺序 = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("排队顺序 = %v, want %v", got, want)
		}
	}
}

func TestMovingTaskIntoProjectAppendsItsSortOrder(t *testing.T) {
	s := openTest(t)
	firstProject, err := s.CreateProject(Project{Name: "first-order-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	secondProject, err := s.CreateProject(Project{Name: "second-order-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	firstID, err := s.CreateTask(Task{Title: "first", Status: StatusQueued, ProjectID: &firstProject})
	if err != nil {
		t.Fatal(err)
	}
	movedID, err := s.CreateTask(Task{Title: "moved", Status: StatusQueued})
	if err != nil {
		t.Fatal(err)
	}
	secondID, err := s.CreateTask(Task{Title: "second", Status: StatusQueued, ProjectID: &firstProject})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateTask(movedID, map[string]any{"project_id": firstProject}); err != nil {
		t.Fatal(err)
	}
	projectTasks, err := s.ListTasksFiltered(TaskFilter{ProjectID: &firstProject})
	if err != nil {
		t.Fatal(err)
	}
	if len(projectTasks) != 3 || projectTasks[0].ID != firstID || projectTasks[1].ID != secondID || projectTasks[2].ID != movedID {
		t.Fatalf("移入项目的任务应追加到末尾: %+v", projectTasks)
	}

	if err := s.UpdateTask(movedID, map[string]any{"project_id": secondProject}); err != nil {
		t.Fatal(err)
	}
	moved, err := s.GetTask(movedID)
	if err != nil {
		t.Fatal(err)
	}
	if moved.SortOrder != 1 || moved.ProjectID == nil || *moved.ProjectID != secondProject {
		t.Fatalf("移入新项目应从该项目末尾开始排序: %+v", moved)
	}
}

func TestDeleteTaskRewiresWeakDependents(t *testing.T) {
	s := openTest(t)
	projectID, err := s.CreateProject(Project{Name: "delete-dependency-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	firstID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "first", Status: StatusSucceeded, ProjectID: &projectID,
	})
	if err != nil {
		t.Fatal(err)
	}
	secondID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "second", Status: StatusSucceeded, ProjectID: &projectID, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	thirdID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "third", Status: StatusQueued, ProjectID: &projectID, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	third, err := s.GetTask(thirdID)
	if err != nil || third.DependsOn == nil || *third.DependsOn != secondID {
		t.Fatalf("测试任务应先依赖第二项: task=%+v err=%v", third, err)
	}

	if err := s.DeleteTask(secondID); err != nil {
		t.Fatalf("删除被弱依赖的中间任务失败: %v", err)
	}
	if exists, err := s.HasTask(secondID); err != nil || exists {
		t.Fatalf("中间任务应已删除: exists=%v err=%v", exists, err)
	}
	third, err = s.GetTask(thirdID)
	if err != nil || third.DependsOn == nil || *third.DependsOn != firstID {
		t.Fatalf("删除中间任务后应改接到更早前置: task=%+v err=%v", third, err)
	}
}

// TestListSessionsForTask 交付任务硬删前解除会话引用：
// 被删收编任务关联的交付会话由 ListSessionsForTask 查询——只返回引用该
// 任务的会话，引用其他任务的会话不动。
func TestListSessionsForTask(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "detach-agent", true)
	taskID, err := s.CreateTask(Task{Title: "delivered", RoleID: &agentID})
	if err != nil {
		t.Fatal(err)
	}
	otherID, err := s.CreateTask(Task{Title: "other", RoleID: &agentID})
	if err != nil {
		t.Fatal(err)
	}
	tid := taskID
	sid1, err := s.CreateSessionTask(Task{Title: "s1", RoleID: &agentID, Status: SessionStatusDelivered, SessionID: &tid})
	if err != nil {
		t.Fatal(err)
	}
	sid2, err := s.CreateSessionTask(Task{Title: "s2", RoleID: &agentID, Status: SessionStatusDelivered, SessionID: &tid})
	if err != nil {
		t.Fatal(err)
	}
	oid := otherID
	if _, err := s.CreateSessionTask(Task{Title: "s3", RoleID: &agentID, Status: SessionStatusDelivered, SessionID: &oid}); err != nil {
		t.Fatal(err)
	}

	affected, err := s.ListSessionsForTask(taskID)
	if err != nil {
		t.Fatal(err)
	}
	if len(affected) != 2 || affected[0] != sid1 || affected[1] != sid2 {
		t.Fatalf("应返回引用该任务的两个会话: %v", affected)
	}
	// 引用其他任务的会话不在结果中（不被波及）。
	affected3, err := s.ListSessionsForTask(otherID)
	if err != nil {
		t.Fatal(err)
	}
	if len(affected3) != 1 || affected3[0] != sid2+1 {
		t.Fatalf("应只返回引用 other 任务的会话: %v", affected3)
	}
	// 会话引用的是收编任务（tasks.session_id 回链），与旧 task_id 语义一致。
	ss, err := s.GetSessionTask(sid1)
	if err != nil || ss.SessionID == nil || *ss.SessionID != taskID {
		t.Fatalf("会话 %d 应回链到被删任务: %+v err=%v", sid1, ss, err)
	}
	ss2, err := s.GetSessionTask(sid2)
	if err != nil || ss2.SessionID == nil || *ss2.SessionID != taskID {
		t.Fatalf("会话 %d 应回链到被删任务: %+v err=%v", sid2, ss2, err)
	}
	ss3, err := s.GetSessionTask(sid2 + 1)
	if err != nil || ss3.SessionID == nil || *ss3.SessionID != otherID {
		t.Fatalf("引用其他任务的会话不应被波及: %+v err=%v", ss3, err)
	}
	// 会话引用解除（会话任务先删除）后硬删不应再触发外键约束。
	for _, sid := range []int64{sid1, sid2} {
		if err := s.DeleteTask(sid); err != nil {
			t.Fatalf("删除会话任务 %d 应成功: %v", sid, err)
		}
	}
	if err := s.DeleteTask(taskID); err != nil {
		t.Fatalf("解除引用后删除任务应成功: %v", err)
	}
}

// 弱依赖在非阻塞失败时放行，强依赖始终等待成功交付；Git 任务的交付还包括
// 它专属的代码合并任务。该测试同时覆盖“合并任务优先于后续实现任务”的队列顺序。
func TestTaskDependencyFailureAndMergeDelivery(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "dependency-agent", true)
	projectID, err := s.CreateProject(Project{Name: "dependency-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "source", Status: StatusFailed, RoleID: &agentID, ProjectID: &projectID, BlockOnFailure: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	weakID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "weak", Status: StatusQueued, RoleID: &agentID, ProjectID: &projectID, DependencyMode: DependencyWeak,
	})
	if err != nil {
		t.Fatal(err)
	}
	strongID, err := s.CreateTaskWithProjectDependency(Task{
		Title: "strong", Status: StatusQueued, RoleID: &agentID, ProjectID: &projectID, DependencyMode: DependencyStrong, DependsOn: &sourceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	weak, err := s.GetTask(weakID)
	if err != nil {
		t.Fatal(err)
	}
	check, err := s.CheckTaskDependency(*weak)
	if err != nil || !check.Ready || !check.Skipped {
		t.Fatalf("非阻塞失败应放行弱依赖: check=%+v err=%v", check, err)
	}
	strong, err := s.GetTask(strongID)
	if err != nil {
		t.Fatal(err)
	}
	check, err = s.CheckTaskDependency(*strong)
	if err != nil || check.Ready {
		t.Fatalf("失败的强依赖必须阻塞: check=%+v err=%v", check, err)
	}
	if err := s.UpdateTask(sourceID, map[string]any{"block_on_failure": true}); err != nil {
		t.Fatal(err)
	}
	check, err = s.CheckTaskDependency(*weak)
	if err != nil || check.Ready {
		t.Fatalf("阻塞失败应阻塞弱依赖: check=%+v err=%v", check, err)
	}

	if err := s.UpdateTask(sourceID, map[string]any{
		"status": StatusSucceeded, "block_on_failure": false, "worktree_branch": "paihuo/task-source",
	}); err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := s.CreateTask(NewMergeTask(*source))
	if err != nil {
		t.Fatal(err)
	}
	merge, err := s.GetTask(mergeID)
	if err != nil {
		t.Fatal(err)
	}
	if merge.BlockOnFailure {
		t.Fatal("合并任务应继承源任务当前的非阻塞策略")
	}
	check, err = s.CheckTaskDependency(*weak)
	if err != nil || check.Ready {
		t.Fatalf("源任务成功但合并尚未成功时不应放行: check=%+v err=%v", check, err)
	}
	queued, err := s.ListQueuedTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) == 0 || queued[0].ID != mergeID {
		t.Fatalf("合并任务必须排在后续实现任务之前，得到 %+v", queued)
	}
	if err := s.UpdateTask(mergeID, map[string]any{"status": StatusSucceeded}); err != nil {
		t.Fatal(err)
	}
	check, err = s.CheckTaskDependency(*weak)
	if err != nil || !check.Ready {
		t.Fatalf("合并成功后应放行弱依赖: check=%+v err=%v", check, err)
	}
	check, err = s.CheckTaskDependency(*strong)
	if err != nil || !check.Ready {
		t.Fatalf("合并成功后应放行强依赖: check=%+v err=%v", check, err)
	}
}
