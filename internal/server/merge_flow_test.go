package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"

	"paihuo/internal/application"
	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/session"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

func TestApproveReviewTaskSnapshotsChangesAndQueuesMergeAgent(t *testing.T) {
	base := t.TempDir()
	projectDir := filepath.Join(base, "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "test"},
	} {
		if out, err := runGit(projectDir, args...); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(projectDir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := runGit(projectDir, "add", "-A"); err != nil {
		t.Fatalf("git add: %v: %s", err, out)
	}
	if out, err := runGit(projectDir, "commit", "-qm", "init"); err != nil {
		t.Fatalf("git commit: %v: %s", err, out)
	}

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	sessionsRoot := filepath.Join(base, "sessions")
	executor := paiexec.NewForTest(st, hub, sessionsRoot, "review-merge-test.db", "review-merge-test")
	sess := session.New(st, hub, executor, sessionsRoot, t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	sc := sched.New(st, hub, executor, sess, wf)
	s := New(st, hub, executor, sc, sess, wf, "", filepath.Join(base, "skills"))
	agentID, err := st.CreateRole(store.Role{Name: "pi", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projectDir, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{
		Title: "reviewed feature", Status: store.StatusAwaitingReview, Perm: store.PermReview,
		RunMode: store.RunModeBatch, RoleID: &agentID, ProjectID: &projectID, ProjectDir: projectDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	tk, err := st.GetTask(taskID)
	if err != nil {
		t.Fatal(err)
	}
	dir, branch, baseCommit, err := workspace.Ensure(*tk, sessionsRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTask(taskID, map[string]any{"worktree_branch": branch, "base_commit": baseCommit}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "approved.txt"), []byte("approved\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(taskID), strings.NewReader(`{"status":"succeeded"}`))
	req.SetPathValue("id", itoa(taskID))
	setTaskRevision(t, st, taskID, req)
	resp := httptest.NewRecorder()
	s.patchTask(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("审批失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	var approved store.Task
	if err := json.Unmarshal(resp.Body.Bytes(), &approved); err != nil {
		t.Fatal(err)
	}
	if approved.Status != store.StatusSucceeded {
		t.Fatalf("原任务未进入成功态: %+v", approved)
	}
	children, err := st.ListChildren(taskID)
	if err != nil || len(children) != 1 {
		t.Fatalf("审批后应创建一个合并任务: %+v err=%v", children, err)
	}
	merge := children[0]
	if merge.MergeOf == nil || *merge.MergeOf != taskID || merge.Perm != store.PermFull || merge.RoleID == nil || *merge.RoleID != agentID {
		t.Fatalf("合并任务配置错误: %+v", merge)
	}
	if out, err := runGit(dir, "status", "--porcelain"); err != nil || strings.TrimSpace(out) != "" {
		t.Fatalf("审批时应提交源 worktree 快照: %q err=%v", out, err)
	}
}

func TestDeleteTaskRemovesTaskTreeWorktrees(t *testing.T) {
	base := t.TempDir()
	projectDir := filepath.Join(base, "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "test"},
		{"commit", "--allow-empty", "-qm", "init"},
	} {
		if out, err := runGit(projectDir, args...); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	sessionsRoot := filepath.Join(base, "sessions")
	executor := paiexec.NewForTest(st, hub, sessionsRoot, "delete-worktree-test.db", "delete-worktree-test")
	sess := session.New(st, hub, executor, sessionsRoot, t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	sc := sched.New(st, hub, executor, sess, wf)
	s := New(st, hub, executor, sc, sess, wf, "", filepath.Join(base, "skills"))
	agentID, err := st.CreateRole(store.Role{Name: "pi", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projectDir, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := st.CreateTask(store.Task{
		Title: "source", Status: store.StatusSucceeded, Perm: store.PermFull,
		RoleID: &agentID, ProjectID: &projectID, ProjectDir: projectDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := st.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	sourceDir, sourceBranch, sourceBase, err := workspace.Ensure(*source, sessionsRoot)
	if err != nil {
		t.Fatal(err)
	}
	source.WorktreeBranch, source.BaseCommit = sourceBranch, sourceBase
	if err := st.UpdateTask(sourceID, map[string]any{"worktree_branch": sourceBranch, "base_commit": sourceBase}); err != nil {
		t.Fatal(err)
	}
	mergeID, err := st.CreateTask(store.NewMergeTask(*source))
	if err != nil {
		t.Fatal(err)
	}
	merge, err := st.GetTask(mergeID)
	if err != nil {
		t.Fatal(err)
	}
	mergeDir, mergeBranch, mergeBase, err := workspace.Ensure(*merge, sessionsRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTask(mergeID, map[string]any{"worktree_branch": mergeBranch, "base_commit": mergeBase}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/tasks/"+itoa(sourceID), nil)
	req.SetPathValue("id", itoa(sourceID))
	setTaskRevision(t, st, sourceID, req)
	resp := httptest.NewRecorder()
	s.deleteTask(resp, req)
	if resp.Code != http.StatusNoContent {
		t.Fatalf("删除任务失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	for _, taskID := range []int64{sourceID, mergeID} {
		if exists, err := st.HasTask(taskID); err != nil || exists {
			t.Fatalf("任务 #%d 应已删除: exists=%v err=%v", taskID, exists, err)
		}
	}
	for _, dir := range []string{sourceDir, mergeDir} {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("worktree 应已删除: %s, err=%v", dir, err)
		}
	}
	for _, branch := range []string{sourceBranch, mergeBranch} {
		if out, err := runGit(projectDir, "branch", "--list", branch); err != nil || strings.TrimSpace(out) != "" {
			t.Fatalf("任务分支应已删除: branch=%s out=%q err=%v", branch, out, err)
		}
	}
}

// 合并不再提供手工端点（已由合并任务成功时自动执行），测试其余护栏：
// 丢弃保护、源任务重试保护、合并任务重试/删除保护。
func TestWorkspaceMergeGuards(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	executor := paiexec.NewForTest(st, hub, t.TempDir(), "workspace-merge-guard-test.db", "workspace-merge-guard-test")
	sess := session.New(st, hub, executor, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	sc := sched.New(st, hub, executor, sess, wf)
	s := New(st, hub, executor, sc, sess, wf, "", t.TempDir())
	taskID, err := st.CreateTask(store.Task{Title: "ordinary", Status: store.StatusSucceeded, Perm: store.PermFull})
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := st.CreateTask(store.NewMergeTask(store.Task{ID: taskID, Title: "ordinary"}))
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workspace/"+itoa(taskID)+"/discard", nil)
	req.SetPathValue("id", itoa(taskID))
	setTaskRevision(t, st, taskID, req)
	resp := httptest.NewRecorder()
	s.workspaceDiscard(resp, req)
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "代码合并任务尚未成功") {
		t.Fatalf("有待处理合并任务的源任务不应丢弃 worktree: code=%d body=%s", resp.Code, resp.Body.String())
	}
	children, err := st.ListChildren(taskID)
	if err != nil || len(children) != 1 {
		t.Fatalf("读取代码合并任务失败: children=%+v err=%v", children, err)
	}
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(taskID), strings.NewReader(`{"status":"queued"}`))
	req.SetPathValue("id", itoa(taskID))
	setTaskRevision(t, st, taskID, req)
	resp = httptest.NewRecorder()
	s.patchTask(resp, req)
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "源任务代码已完成") {
		t.Fatalf("源任务不应绕过既有合并任务直接重试: code=%d body=%s", resp.Code, resp.Body.String())
	}
	req = httptest.NewRequest(http.MethodPost, "/api/v1/workspace/"+itoa(children[0].ID)+"/discard", nil)
	req.SetPathValue("id", itoa(children[0].ID))
	resp = httptest.NewRecorder()
	s.workspaceDiscard(resp, req)
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "代码合并任务尚未成功") {
		t.Fatalf("未成功的代码合并任务不应丢弃 worktree: code=%d body=%s", resp.Code, resp.Body.String())
	}

	// 成功的合并任务已写入主分支，不能被通用重试入口再次排队。
	if err := st.UpdateTask(mergeID, map[string]any{"status": store.StatusSucceeded}); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(mergeID), strings.NewReader(`{"status":"queued"}`))
	req.SetPathValue("id", itoa(mergeID))
	setTaskRevision(t, st, mergeID, req)
	resp = httptest.NewRecorder()
	s.patchTask(resp, req)
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "代码合并任务已成功") {
		t.Fatalf("成功的代码合并任务不能重试: code=%d body=%s", resp.Code, resp.Body.String())
	}
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/tasks/"+itoa(mergeID), nil)
	req.SetPathValue("id", itoa(mergeID))
	setTaskRevision(t, st, mergeID, req)
	resp = httptest.NewRecorder()
	s.deleteTask(resp, req)
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "代码合并任务不能单独删除") {
		t.Fatalf("代码合并任务不能单独删除: code=%d body=%s", resp.Code, resp.Body.String())
	}
}

// 合并任务继承源任务角色；源角色被禁用时合并任务会永远排队并堵住项目
// 交付链。允许为排队中的合并任务更换角色是解卡手段；运行中/终态任务与
// 其他字段仍受系统管理保护。
func TestPatchMergeTaskRoleGuards(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	executor := paiexec.NewForTest(st, hub, t.TempDir(), "merge-role-guard-test.db", "merge-role-guard-test")
	sess := session.New(st, hub, executor, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, executor.RuntimeService(), executor, hub)
	sc := sched.New(st, hub, executor, sess, wf)
	s := New(st, hub, executor, sc, sess, wf, "", t.TempDir())
	agentA, err := st.CreateRole(store.Role{Name: "a", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	agentB, err := st.CreateRole(store.Role{Name: "b", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{Title: "ordinary", Status: store.StatusSucceeded, Perm: store.PermFull})
	if err != nil {
		t.Fatal(err)
	}
	mergeID, err := st.CreateTask(store.NewMergeTask(store.Task{ID: taskID, Title: "ordinary"}))
	if err != nil {
		t.Fatal(err)
	}

	patch := func(id int64, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(id), strings.NewReader(body))
		req.SetPathValue("id", itoa(id))
		setTaskRevision(t, st, id, req)
		resp := httptest.NewRecorder()
		s.patchTask(resp, req)
		return resp
	}

	// 排队中的合并任务可以更换角色（源角色被禁用时的解卡路径）。
	resp := patch(mergeID, fmt.Sprintf(`{"role_id":%d}`, agentB))
	if resp.Code != http.StatusOK {
		t.Fatalf("排队合并任务更换角色应成功: code=%d body=%s", resp.Code, resp.Body.String())
	}
	merge, err := st.GetTask(mergeID)
	if err != nil || merge.RoleID == nil || *merge.RoleID != agentB {
		t.Fatalf("合并任务角色未更新: %+v err=%v", merge, err)
	}

	// 排队中的合并任务不能清空角色。
	resp = patch(mergeID, `{"role_id":null}`)
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "必须指派角色") {
		t.Fatalf("合并任务不能清空角色: code=%d body=%s", resp.Code, resp.Body.String())
	}

	// 运行中的合并任务不能更换角色。
	if err := st.UpdateTask(mergeID, map[string]any{"status": store.StatusRunning}); err != nil {
		t.Fatal(err)
	}
	resp = patch(mergeID, fmt.Sprintf(`{"role_id":%d}`, agentA))
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "只能为排队中") {
		t.Fatalf("运行中合并任务不能更换角色: code=%d body=%s", resp.Code, resp.Body.String())
	}

	// 合并任务的其他字段仍受系统管理保护。
	resp = patch(mergeID, `{"title":"改标题"}`)
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "系统管理") {
		t.Fatalf("合并任务标题不能被修改: code=%d body=%s", resp.Code, resp.Body.String())
	}
}

func runGit(dir string, args ...string) (string, error) {
	cmd := osexec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}
