package store

import "testing"

func TestApproveReviewTaskCreatesOneMergeTaskAtomically(t *testing.T) {
	s := openTest(t)
	a := mustRole(t, s, "reviewer", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "review me", Status: StatusAwaitingReview, Perm: PermReview,
		RoleID: &a, ProjectID: &projectID, ProjectDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	merge := Task{
		Title: "merge reviewed task", Body: "integrate", Status: StatusQueued,
		Perm: PermFull, RunMode: RunModeBatch, RoleID: &a, ProjectID: &projectID,
		ProjectDir: t.TempDir(), ParentID: &sourceID, MergeOf: &sourceID,
	}
	if _, err := s.ApproveTaskAndCreateMerge(sourceID, 99, merge); err == nil {
		t.Fatal("陈旧 revision 不应审批或创建合并任务")
	}
	mergeID, err := s.ApproveTaskAndCreateMerge(sourceID, 1, merge)
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil || source.Status != StatusSucceeded {
		t.Fatalf("审批后原任务状态异常: %+v err=%v", source, err)
	}
	created, err := s.GetTask(mergeID)
	if err != nil {
		t.Fatal(err)
	}
	if created.MergeOf == nil || *created.MergeOf != sourceID || created.ParentID == nil || *created.ParentID != sourceID {
		t.Fatalf("合并任务来源关系未保存: %+v", created)
	}
	if created.Perm != PermFull || created.Status != StatusQueued || created.RoleID == nil || *created.RoleID != a {
		t.Fatalf("合并任务执行配置异常: %+v", created)
	}
	if _, err := s.ApproveTaskAndCreateMerge(sourceID, 1, merge); err == nil {
		t.Fatal("重复审批不应再创建合并任务")
	}
	children, err := s.ListChildren(sourceID)
	if err != nil || len(children) != 1 {
		t.Fatalf("重复审批后应仍只有一个合并任务: %+v err=%v", children, err)
	}
}

func TestCompleteTaskCreatesOneMergeTaskAtomically(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "merger", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "finish me", Status: StatusRunning, Perm: PermFull,
		RoleID: &agentID, ProjectID: &projectID, ProjectDir: t.TempDir(), BlockOnFailure: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeInput := NewMergeTask(*source)
	mergeInput.BlockOnFailure = false // 模拟调用方持有了过期快照
	mergeID, err := s.CompleteTaskAndCreateMerge(sourceID, mergeInput)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := s.GetTask(sourceID)
	if err != nil || completed.Status != StatusSucceeded {
		t.Fatalf("完成后源任务状态异常: %+v err=%v", completed, err)
	}
	merge, err := s.GetTask(mergeID)
	if err != nil {
		t.Fatal(err)
	}
	if merge.MergeOf == nil || *merge.MergeOf != sourceID || merge.ParentID == nil || *merge.ParentID != sourceID {
		t.Fatalf("合并任务来源关系未保存: %+v", merge)
	}
	if merge.Status != StatusQueued || merge.Perm != PermFull || merge.Concurrent || !merge.BlockOnFailure {
		t.Fatalf("自动合并任务执行配置异常: %+v", merge)
	}
	if _, err := s.CompleteTaskAndCreateMerge(sourceID, NewMergeTask(*source)); err == nil {
		t.Fatal("重复完成不应创建第二个合并任务")
	}
	if _, err := s.CreateTask(NewMergeTask(*source)); err == nil {
		t.Fatal("数据库约束不应允许同一源任务创建第二个合并任务")
	}
	children, err := s.ListChildren(sourceID)
	if err != nil || len(children) != 1 {
		t.Fatalf("应只创建一个合并任务: %+v err=%v", children, err)
	}
}

func TestMergeReconciliationCreatesExactlyOneChildForCompletedGitTask(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "reconciler", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "finish despite handoff failure", Status: StatusRunning, Perm: PermFull,
		RoleID: &agentID, ProjectID: &projectID, ProjectDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateTask(sourceID, map[string]any{"worktree_branch": "paihuo/task-reconcile"}); err != nil {
		t.Fatal(err)
	}

	changed, err := s.MarkTaskSucceededAwaitingMerge(sourceID)
	if err != nil || !changed {
		t.Fatalf("应把已完成源任务留给合并对账: changed=%v err=%v", changed, err)
	}
	pending, err := s.ListCompletedGitTasksWithoutMerge()
	if err != nil || len(pending) != 1 || pending[0].ID != sourceID {
		t.Fatalf("应找到唯一待补建合并任务的源任务: %+v err=%v", pending, err)
	}

	mergeID, created, err := s.EnsureMergeTask(pending[0])
	if err != nil || !created {
		t.Fatalf("首次对账应创建合并任务: id=%d created=%v err=%v", mergeID, created, err)
	}
	merge, err := s.GetTask(mergeID)
	if err != nil || merge.MergeOf == nil || *merge.MergeOf != sourceID || merge.Status != StatusQueued {
		t.Fatalf("补建的合并任务不正确: %+v err=%v", merge, err)
	}

	// 对账可重复执行，不会创建第二个合并任务。
	mergeID2, created, err := s.EnsureMergeTask(pending[0])
	if err != nil || created || mergeID2 != mergeID {
		t.Fatalf("重复对账应返回已有合并任务: id=%d created=%v err=%v", mergeID2, created, err)
	}
	pending, err = s.ListCompletedGitTasksWithoutMerge()
	if err != nil || len(pending) != 0 {
		t.Fatalf("已有合并任务后不应再出现在对账队列: %+v err=%v", pending, err)
	}
}

// 会话交付任务的收编路径：queued → succeeded + 唯一合并子任务（原子）。
func TestDeliverTaskAndCreateMerge(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "deliver", true)
	projectID, err := s.CreateProject(Project{Name: "proj", ProjectDir: t.TempDir(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sid, err := s.CreateSessionTask(Task{Title: "s", RoleID: &agentID, Status: SessionStatusDelivered})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := s.CreateTask(Task{
		Title: "delivered", Status: StatusQueued, Perm: PermFull, RunMode: RunModeBatch,
		RoleID: &agentID, ProjectID: &projectID, ProjectDir: t.TempDir(),
		SessionID: &sid, WorktreeBranch: "paihuo/session-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := s.DeliverTaskAndCreateMerge(sourceID, NewMergeTask(*source))
	if err != nil {
		t.Fatal(err)
	}
	delivered, err := s.GetTask(sourceID)
	if err != nil || delivered.Status != StatusSucceeded || delivered.ExitCode == nil || *delivered.ExitCode != 0 || delivered.Error != "" {
		t.Fatalf("交付后源任务状态异常: %+v err=%v", delivered, err)
	}
	merge, err := s.GetTask(mergeID)
	if err != nil || merge.MergeOf == nil || *merge.MergeOf != sourceID {
		t.Fatalf("交付创建的合并任务异常: %+v err=%v", merge, err)
	}
	// 重复交付不产生第二个合并任务。
	if _, err := s.DeliverTaskAndCreateMerge(sourceID, NewMergeTask(*source)); err == nil {
		t.Fatal("重复交付不应创建第二个合并任务")
	}
}

// 非会话任务不能走交付收编路径（session_id 守卫）。
func TestDeliverTaskAndCreateMergeRejectsNonSessionTask(t *testing.T) {
	s := openTest(t)
	agentID := mustRole(t, s, "deliver2", true)
	sourceID, err := s.CreateTask(Task{
		Title: "plain", Status: StatusQueued, Perm: PermFull,
		RoleID: &agentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeliverTaskAndCreateMerge(sourceID, NewMergeTask(*source)); err == nil {
		t.Fatal("非会话任务不应走交付收编路径")
	}
	if got, _ := s.GetTask(sourceID); got.Status != StatusQueued {
		t.Fatalf("拒绝后任务状态不应变化: %s", got.Status)
	}
}
