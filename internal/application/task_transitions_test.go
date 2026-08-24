package application

import (
	"context"
	"errors"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"

	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

type lifecycleTestEnv struct {
	store     *store.Store
	service   *TaskLifecycle
	sessions  *recordingTaskSessions
	schedules *recordingScheduleReloader
}

type recordingTaskSessions struct{ deleted []int64 }

func (s *recordingTaskSessions) Delete(_ context.Context, id int64) error {
	s.deleted = append(s.deleted, id)
	return nil
}

type recordingScheduleReloader struct{ reloads int }

func (r *recordingScheduleReloader) Reload() { r.reloads++ }

func newLifecycleTestEnv(t *testing.T) lifecycleTestEnv {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	t.Cleanup(hub.Close)
	root := t.TempDir()
	executor := paiexec.NewForTest(st, hub, root, "application-lifecycle-test.db", "application-lifecycle-test")
	sessions := &recordingTaskSessions{}
	schedules := &recordingScheduleReloader{}
	service := NewTaskLifecycle(TaskLifecycleDeps{
		Store: st, Runtimes: executor.RuntimeService(), Executor: executor,
		Events: hub, Sessions: sessions, SessionsRoot: root, Schedules: schedules,
	})
	return lifecycleTestEnv{store: st, service: service, sessions: sessions, schedules: schedules}
}

func TestTaskLifecycleApproveCreatesOneMergeAndRejectsStaleOrDuplicateRequests(t *testing.T) {
	env := newLifecycleTestEnv(t)
	roleID, _ := env.store.CreateRole(store.Role{Name: "reviewer", RuntimeID: "pi", Enabled: true})
	projectDir := t.TempDir() // non-Git projects conservatively use the merge path
	projectID, _ := env.store.CreateProject(store.Project{Name: "project", ProjectDir: projectDir, Status: "active"})
	taskID, err := env.store.CreateTask(store.Task{
		Title: "review", Status: store.StatusAwaitingReview, Perm: store.PermReview,
		RoleID: &roleID, ProjectID: &projectID, ProjectDir: projectDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	approved, err := env.service.Approve(context.Background(), taskID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != store.StatusSucceeded {
		t.Fatalf("approved task status = %s", approved.Status)
	}
	children, err := env.store.ListChildren(taskID)
	if err != nil || len(children) != 1 || children[0].MergeOf == nil || *children[0].MergeOf != taskID {
		t.Fatalf("approval must atomically create one merge task: children=%+v err=%v", children, err)
	}
	if _, err := env.service.Approve(context.Background(), taskID, 1); taskErrorKind(err) != TaskErrorRevisionConflict {
		t.Fatalf("duplicate approval must be a revision conflict, got %v", err)
	}
	children, _ = env.store.ListChildren(taskID)
	if len(children) != 1 {
		t.Fatalf("duplicate approval created extra merge tasks: %+v", children)
	}

	staleID, _ := env.store.CreateTask(store.Task{Title: "stale", Status: store.StatusAwaitingReview, Perm: store.PermReview, RoleID: &roleID, ProjectID: &projectID, ProjectDir: projectDir})
	if _, err := env.service.Approve(context.Background(), staleID, 99); taskErrorKind(err) != TaskErrorRevisionConflict {
		t.Fatalf("stale approval kind = %v, err=%v", taskErrorKind(err), err)
	}
	stale, _ := env.store.GetTask(staleID)
	if stale.Status != store.StatusAwaitingReview {
		t.Fatalf("stale approval changed status: %+v", stale)
	}
}

func TestTaskLifecycleApproveSkipsMergeWhenBranchHasNoChanges(t *testing.T) {
	env := newLifecycleTestEnv(t)
	projectDir := initLifecycleGitProject(t)
	roleID, _ := env.store.CreateRole(store.Role{Name: "reviewer", RuntimeID: "pi", Enabled: true})
	projectID, _ := env.store.CreateProject(store.Project{Name: "project", ProjectDir: projectDir, Status: "active"})
	taskID, _ := env.store.CreateTask(store.Task{
		Title: "no changes", Status: store.StatusAwaitingReview, Perm: store.PermReview,
		RoleID: &roleID, ProjectID: &projectID, ProjectDir: projectDir,
	})
	if output, err := runLifecycleGit(projectDir, "branch", workspace.Branch(taskID)); err != nil {
		t.Fatalf("create task branch: %v: %s", err, output)
	}
	approved, err := env.service.Approve(context.Background(), taskID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != store.StatusSucceeded || !approved.MergeSkipped {
		t.Fatalf("no-change approval must be delivered without merge: %+v", approved)
	}
	children, _ := env.store.ListChildren(taskID)
	if len(children) != 0 {
		t.Fatalf("no-change approval created merge tasks: %+v", children)
	}
}

func TestTaskLifecycleRequeueIncludesReviewFeedbackAndClearsExecutionState(t *testing.T) {
	env := newLifecycleTestEnv(t)
	roleID, _ := env.store.CreateRole(store.Role{Name: "worker", RuntimeID: "pi", Enabled: true})
	started, finished := store.Now(), store.Now()
	exitCode := 1
	taskID, _ := env.store.CreateTask(store.Task{
		Title: "redo", Body: "original", Status: store.StatusAwaitingReview, Perm: store.PermReview,
		RoleID: &roleID, ReviewRounds: 2, Error: "failed", ExitCode: &exitCode,
		StartedAt: &started, FinishedAt: &finished,
	})
	updated, err := env.service.Requeue(context.Background(), taskID, 1, TaskTransitionRequest{
		Fields: map[string]any{"status": store.StatusQueued, "review_note": "  fix tests  "},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != store.StatusQueued || updated.Error != "" || updated.ExitCode != nil || updated.StartedAt != nil || updated.FinishedAt != nil {
		t.Fatalf("requeue did not clear execution state: %+v", updated)
	}
	if !strings.Contains(updated.Body, "【修改意见 第 2 轮") || !strings.Contains(updated.Body, "fix tests") {
		t.Fatalf("review feedback missing from body: %q", updated.Body)
	}
	if _, err := env.service.Requeue(context.Background(), taskID, 1, TaskTransitionRequest{}); taskErrorKind(err) != TaskErrorRevisionConflict {
		t.Fatalf("duplicate requeue must fail by revision: %v", err)
	}
}

func TestTaskLifecycleCancelUsesOneRevisionConditionalUpdate(t *testing.T) {
	env := newLifecycleTestEnv(t)
	taskID, _ := env.store.CreateTask(store.Task{Title: "cancel", Status: store.StatusQueued})
	if _, err := env.service.Cancel(context.Background(), taskID, 99, TaskTransitionRequest{}); taskErrorKind(err) != TaskErrorRevisionConflict {
		t.Fatalf("stale cancellation kind = %v, err=%v", taskErrorKind(err), err)
	}
	before := mustLifecycleTask(t, env.store, taskID)
	if before.Status != store.StatusQueued {
		t.Fatalf("stale cancellation changed status: %+v", before)
	}
	updated, err := env.service.Cancel(context.Background(), taskID, 1, TaskTransitionRequest{
		Fields: map[string]any{"status": store.StatusCancelled, "title": "cancelled title"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != store.StatusCancelled || updated.Title != "cancelled title" || updated.Revision != 2 {
		t.Fatalf("cancel did not preserve the combined PATCH: %+v", updated)
	}
	if _, err := env.service.Cancel(context.Background(), taskID, 1, TaskTransitionRequest{}); taskErrorKind(err) != TaskErrorRevisionConflict {
		t.Fatalf("duplicate cancellation kind = %v, err=%v", taskErrorKind(err), err)
	}
}

func TestTaskLifecycleResumePreservesIdentityAndRejectsDuplicateRequest(t *testing.T) {
	env := newLifecycleTestEnv(t)
	roleID, _ := env.store.CreateRole(store.Role{Name: "worker", RuntimeID: "pi", Enabled: true})
	taskID, _ := env.store.CreateTask(store.Task{Title: "resume", Status: store.StatusFailed, RoleID: &roleID, Error: "boom"})
	updated, err := env.service.Resume(context.Background(), taskID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if updated.ID != taskID || updated.Status != store.StatusQueued || updated.Error != "" || updated.Revision != 2 {
		t.Fatalf("unexpected resumed task: %+v", updated)
	}
	logs, err := env.store.ListLogs(taskID)
	if err != nil || len(logs) != 1 || !strings.Contains(logs[0].Content, "保留会话") {
		t.Fatalf("resume log missing: logs=%+v err=%v", logs, err)
	}
	if _, err := env.service.Resume(context.Background(), taskID, 1); taskErrorKind(err) != TaskErrorRevisionConflict {
		t.Fatalf("duplicate resume kind = %v, err=%v", taskErrorKind(err), err)
	}
}

func TestTaskLifecycleDeleteProtectsStrongDependenciesAndCleansDeliveredSession(t *testing.T) {
	env := newLifecycleTestEnv(t)
	rootID, _ := env.store.CreateTask(store.Task{Title: "root", Status: store.StatusFailed})
	root := mustLifecycleTask(t, env.store, rootID)
	dependentID, _ := env.store.CreateTask(store.Task{Title: "dependent", Status: store.StatusQueued, DependsOn: &rootID, DependencyMode: store.DependencyStrong})
	if err := env.service.Delete(context.Background(), rootID, root.Revision); taskErrorKind(err) != TaskErrorConflict {
		t.Fatalf("strong dependency delete kind = %v, err=%v", taskErrorKind(err), err)
	}
	if exists, _ := env.store.HasTask(rootID); !exists {
		t.Fatal("dependency-protected task was deleted")
	}
	if err := env.store.UpdateTask(dependentID, map[string]any{"dependency_mode": store.DependencyNone, "depends_on": nil}); err != nil {
		t.Fatal(err)
	}
	root = mustLifecycleTask(t, env.store, rootID)
	sessionID, _ := env.store.CreateTask(store.Task{Type: store.TaskTypeSession, Title: "delivered session", Status: store.SessionStatusDelivered, SessionID: &rootID})
	if err := env.service.Delete(context.Background(), rootID, root.Revision+1); taskErrorKind(err) != TaskErrorRevisionConflict {
		t.Fatalf("stale delete kind = %v, err=%v", taskErrorKind(err), err)
	}
	if err := env.service.Delete(context.Background(), rootID, root.Revision); err != nil {
		t.Fatal(err)
	}
	if exists, _ := env.store.HasTask(rootID); exists {
		t.Fatal("root task still exists after delete")
	}
	if len(env.sessions.deleted) != 1 || env.sessions.deleted[0] != sessionID {
		t.Fatalf("delivered Session cleanup not delegated: %+v", env.sessions.deleted)
	}
	if err := env.service.Delete(context.Background(), rootID, root.Revision); taskErrorKind(err) != TaskErrorNotFound {
		t.Fatalf("duplicate delete kind = %v, err=%v", taskErrorKind(err), err)
	}
}

func taskErrorKind(err error) TaskErrorKind {
	var lifecycleErr *TaskLifecycleError
	if errors.As(err, &lifecycleErr) {
		return lifecycleErr.Kind
	}
	return ""
}

func mustLifecycleTask(t *testing.T, st *store.Store, id int64) *store.Task {
	t.Helper()
	task, err := st.GetTask(id)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func initLifecycleGitProject(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "test"},
	} {
		if output, err := runLifecycleGit(dir, args...); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if output, err := runLifecycleGit(dir, "add", "-A"); err != nil {
		t.Fatalf("git add: %v: %s", err, output)
	}
	if output, err := runLifecycleGit(dir, "commit", "-qm", "init"); err != nil {
		t.Fatalf("git commit: %v: %s", err, output)
	}
	return dir
}

func runLifecycleGit(dir string, args ...string) (string, error) {
	command := osexec.Command("git", args...)
	command.Dir = dir
	output, err := command.CombinedOutput()
	return string(output), err
}
