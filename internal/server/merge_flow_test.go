package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"

	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/sched"
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
	hub := events.NewHub()
	sessionsRoot := filepath.Join(base, "sessions")
	executor := paiexec.New(st, hub, sessionsRoot, "review-merge-test.db")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", filepath.Join(base, "skills"))
	agentID, err := st.CreateAgent(store.Agent{Name: "pi", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "proj", ProjectDir: projectDir, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{
		Title: "reviewed feature", Status: store.StatusAwaitingReview, Perm: store.PermReview,
		RunMode: store.RunModeBatch, AgentID: &agentID, ProjectID: &projectID, ProjectDir: projectDir,
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

	req := httptest.NewRequest(http.MethodPatch, "/api/tasks/"+itoa(taskID), strings.NewReader(`{"status":"succeeded"}`))
	req.SetPathValue("id", itoa(taskID))
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
	if merge.MergeOf == nil || *merge.MergeOf != taskID || merge.Perm != store.PermFull || merge.AgentID == nil || *merge.AgentID != agentID {
		t.Fatalf("合并任务配置错误: %+v", merge)
	}
	if out, err := runGit(dir, "status", "--porcelain"); err != nil || strings.TrimSpace(out) != "" {
		t.Fatalf("审批时应提交源 worktree 快照: %q err=%v", out, err)
	}
}

func runGit(dir string, args ...string) (string, error) {
	cmd := osexec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}
