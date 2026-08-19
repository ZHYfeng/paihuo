package orchestrator

import (
	"context"
	"strings"
	"testing"
	"time"

	"paihuo/internal/artifact"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/store"
)

func newTestService(t *testing.T, delegationEnabled bool, maxPerm string) (*Service, *store.Store, int64) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	executor := exec.NewForTest(st, hub, t.TempDir(), "orch-test.db", "orch-test")
	svc := New(st, executor.RuntimeService(), executor, "test-secret", nil)

	orchRoleID, err := st.CreateRole(store.Role{Name: "orchestrator", RuntimeID: "pi", Enabled: true, DelegationEnabled: delegationEnabled, DelegationMaxPerm: maxPerm})
	if err != nil {
		t.Fatal(err)
	}
	workerRoleID, err := st.CreateRole(store.Role{Name: "worker", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	sessionID, err := st.CreateSessionTask(store.Task{RoleID: &orchRoleID, Title: "orchestrator-session", Status: store.SessionStatusActive})
	if err != nil {
		t.Fatal(err)
	}
	if maxPerm == "" {
		maxPerm = store.PermReview
	}
	t.Setenv("_", "")
	_ = workerRoleID
	return svc, st, sessionID
}

func TestTokenRoundTrip(t *testing.T) {
	svc, _, sessionID := newTestService(t, true, store.PermFull)
	token := svc.SignToken(sessionID)
	got, err := svc.VerifyToken(token)
	if err != nil || got != sessionID {
		t.Fatalf("VerifyToken(%q) = %d, %v; want %d", token, got, err, sessionID)
	}
	if _, err := svc.VerifyToken(token + "x"); err == nil {
		t.Fatal("篡改令牌应被拒绝")
	}
	if _, err := svc.VerifyToken(TokenPrefix + "999.deadbeef"); err == nil {
		t.Fatal("伪造签名应被拒绝")
	}
}

func TestSpawnRequiresDelegation(t *testing.T) {
	svc, _, sessionID := newTestService(t, false, "")
	_, err := svc.Spawn(context.Background(), sessionID, spawnArgs{RoleID: 1, Title: "x"})
	if err == nil || !strings.Contains(err.Error(), "delegation") {
		t.Fatalf("非委托会话应被拒绝，got: %v", err)
	}
}

func TestSpawnEnforcesPermCap(t *testing.T) {
	svc, st, sessionID := newTestService(t, true, store.PermReview) // 上限=review
	workerRoleID, _ := st.CreateRole(store.Role{Name: "worker2", RuntimeID: "pi", Enabled: true})

	// full 子任务超过上限 → 拒绝
	if _, err := svc.Spawn(context.Background(), sessionID, spawnArgs{RoleID: workerRoleID, Title: "full", Perm: store.PermFull}); err == nil {
		t.Fatal("full 子任务超过 review 上限应被拒绝")
	}
	// review 子任务 → 允许
	rc, err := svc.Spawn(context.Background(), sessionID, spawnArgs{RoleID: workerRoleID, Title: "review-child", Perm: store.PermReview})
	if err != nil {
		t.Fatalf("review 子任务应被允许: %v", err)
	}
	if rc.ParentSessionID != sessionID || rc.ParentTaskID != sessionID {
		t.Fatalf("子任务应挂到会话下: %+v", rc)
	}
	child, err := st.GetTask(rc.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentSessionID == nil || *child.ParentSessionID != sessionID {
		t.Fatalf("子任务 parent_session_id 应指向会话")
	}
	if child.Perm != store.PermReview {
		t.Fatalf("子任务权限应为 review，got %s", child.Perm)
	}
}

func TestSpawnRejectsDisabledChildRole(t *testing.T) {
	svc, st, sessionID := newTestService(t, true, store.PermFull)
	roleID, _ := st.CreateRole(store.Role{Name: "off", RuntimeID: "pi", Enabled: false})
	if _, err := svc.Spawn(context.Background(), sessionID, spawnArgs{RoleID: roleID, Title: "x"}); err == nil {
		t.Fatal("未启用角色不应被用于子任务")
	}
}

func TestAwaitStopsOnTerminalOrReviewAndTimeout(t *testing.T) {
	svc, st, sessionID := newTestService(t, true, store.PermFull)
	roleID, _ := st.CreateRole(store.Role{Name: "w3", RuntimeID: "pi", Enabled: true})
	// 直接建子任务（挂到会话下）
	childID, err := st.CreateTask(store.Task{Type: store.TaskTypeTask, Title: "c1", Status: store.StatusQueued, RoleID: &roleID, ParentSessionID: &sessionID, ParentTaskID: &sessionID})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTask(childID, map[string]any{"status": store.StatusSucceeded}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	out, timedOut, err := svc.Await(ctx, sessionID, awaitArgs{TaskIDs: []int64{childID}, TimeoutSeconds: 2})
	if err != nil {
		t.Fatal(err)
	}
	if timedOut || out[childID].Pending {
		t.Fatalf("终态任务应立刻返回，timedOut=%v pending=%v", timedOut, out[childID].Pending)
	}
	if out[childID].Result.Status != store.StatusSucceeded {
		t.Fatalf("结果状态错误: %s", out[childID].Result.Status)
	}

	// awaiting_review 也是停止点（审批在人类手里）
	childID2, _ := st.CreateTask(store.Task{Type: store.TaskTypeTask, Title: "c2", Status: store.StatusQueued, RoleID: &roleID, ParentSessionID: &sessionID, ParentTaskID: &sessionID})
	_ = st.UpdateTask(childID2, map[string]any{"status": store.StatusAwaitingReview})
	out2, timedOut2, err := svc.Await(ctx, sessionID, awaitArgs{TaskIDs: []int64{childID2}, TimeoutSeconds: 2})
	if err != nil {
		t.Fatal(err)
	}
	if timedOut2 || out2[childID2].Pending {
		t.Fatalf("待审任务应作为停止点返回，timedOut=%v pending=%v", timedOut2, out2[childID2].Pending)
	}

	// 一直运行 → 超时返回当前进度
	childID3, _ := st.CreateTask(store.Task{Type: store.TaskTypeTask, Title: "c3", Status: store.StatusQueued, RoleID: &roleID, ParentSessionID: &sessionID, ParentTaskID: &sessionID})
	out3, timedOut3, err := svc.Await(ctx, sessionID, awaitArgs{TaskIDs: []int64{childID3}, TimeoutSeconds: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !timedOut3 || !out3[childID3].Pending {
		t.Fatalf("未完成任务应超时并报告 pending，timedOut=%v pending=%v", timedOut3, out3[childID3].Pending)
	}
}

func TestAwaitAndReadsEnforceSubtree(t *testing.T) {
	svc, st, sessionID := newTestService(t, true, store.PermFull)
	roleID, _ := st.CreateRole(store.Role{Name: "w4", RuntimeID: "pi", Enabled: true})
	// 会话外的外国任务
	foreign, err := st.CreateTask(store.Task{Type: store.TaskTypeTask, Title: "foreign", Status: store.StatusQueued, RoleID: &roleID})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Await(context.Background(), sessionID, awaitArgs{TaskIDs: []int64{foreign}, TimeoutSeconds: 2}); err == nil {
		t.Fatal("await 树外任务应被拒绝")
	}
	if _, err := svc.GetResult(context.Background(), sessionID, getResultArgs{TaskID: foreign}); err == nil {
		t.Fatal("get_task_result 树外任务应被拒绝")
	}
	// 树内读取
	childID, _ := st.CreateTask(store.Task{Type: store.TaskTypeTask, Title: "mine", Status: store.StatusQueued, RoleID: &roleID, ParentSessionID: &sessionID, ParentTaskID: &sessionID})
	res, err := svc.GetResult(context.Background(), sessionID, getResultArgs{TaskID: childID})
	if err != nil {
		t.Fatal(err)
	}
	if res.TaskID != childID {
		t.Fatalf("结果 id 错误: %d", res.TaskID)
	}
	children, err := svc.ListChildren(context.Background(), sessionID, listChildrenArgs{})
	if err != nil {
		t.Fatal(err)
	}
	if len(children) != 1 {
		t.Fatalf("树内子任务数应为 1，got %d", len(children))
	}
	// 只能查自己
	if _, err := svc.ListChildren(context.Background(), sessionID, listChildrenArgs{SessionID: &foreign}); err == nil {
		t.Fatal("查询别的会话应被拒绝")
	}
}

func TestFetchArtifactEnforcesSubtree(t *testing.T) {
	svc, st, sessionID := newTestService(t, true, store.PermFull)
	roleID, _ := st.CreateRole(store.Role{Name: "w5", RuntimeID: "pi", Enabled: true})
	foreign, _ := st.CreateTask(store.Task{Type: store.TaskTypeTask, Title: "foreign", Status: store.StatusQueued, RoleID: &roleID})
	foreignArt, err := st.CreateArtifact(artifact.Metadata{
		TaskID: &foreign, Name: "f.bin", MediaType: "application/octet-stream",
		ContentHash: "x", Size: 4, Locator: "sha256/ab/nope", CreatedBy: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.FetchArtifact(context.Background(), sessionID, fetchArtifactArgs{ArtifactID: foreignArt.ID}); err == nil {
		t.Fatal("树外 artifact 应被拒绝")
	}
}

var _ = time.Now // keep time import for Await duration semantics

// SpawnSync 同步派活：创建子任务后阻塞到停止点并返回结果，无需轮询。
func TestSpawnSyncWaitsForTerminal(t *testing.T) {
	svc, st, sessionID := newTestService(t, true, store.PermFull)
	workerID, err := st.CreateRole(store.Role{Name: "wsync", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	type out = spawnSyncOutcome
	ch := make(chan struct {
		out out
		err error
	}, 1)
	ctx := context.Background()
	go func() {
		o, err := svc.SpawnSync(ctx, sessionID, spawnArgs{RoleID: workerID, Title: "sync-child", Sync: true, SyncTimeoutSeconds: 8})
		ch <- struct {
			out out
			err error
		}{o, err}
	}()
	// 等创建完成，再把子任务置为 succeeded，模拟执行器收尾
	deadline := time.Now().Add(3 * time.Second)
	var childID int64
	for time.Now().Before(deadline) {
		children, _ := st.ListChildrenBySession(sessionID)
		if len(children) == 1 {
			childID = children[0].ID
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if childID == 0 {
		t.Fatal("同步 spawn 应已创建子任务")
	}
	time.Sleep(100 * time.Millisecond) // 确保 spawn 已进入等待
	if err := st.UpdateTask(childID, map[string]any{"status": store.StatusSucceeded}); err != nil {
		t.Fatal(err)
	}
	res := <-ch
	if res.err != nil {
		t.Fatalf("SpawnSync 失败: %v", res.err)
	}
	if res.out.TimedOut {
		t.Fatal("子任务已终态，不应超时")
	}
	if res.out.Result == nil || res.out.Result.TaskID != childID || res.out.Result.Status != store.StatusSucceeded {
		t.Fatalf("SpawnSync 应返回子任务结果: %+v", res.out.Result)
	}
	if res.out.Receipt.TaskID != childID {
		t.Fatalf("回执应指向子任务: %+v", res.out.Receipt)
	}
}

// SpawnSync 遇到待审停止点返回（不是错误），编排者据此知道要等人类审批。
func TestSpawnSyncStopsOnAwaitingReview(t *testing.T) {
	svc, st, sessionID := newTestService(t, true, store.PermFull)
	workerID, err := st.CreateRole(store.Role{Name: "wsync2", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	type out = spawnSyncOutcome
	ch := make(chan struct {
		out out
		err error
	}, 1)
	ctx := context.Background()
	go func() {
		o, err := svc.SpawnSync(ctx, sessionID, spawnArgs{RoleID: workerID, Title: "review-child", Perm: store.PermReview, Sync: true, SyncTimeoutSeconds: 8})
		ch <- struct {
			out out
			err error
		}{o, err}
	}()
	deadline := time.Now().Add(3 * time.Second)
	var childID int64
	for time.Now().Before(deadline) {
		children, _ := st.ListChildrenBySession(sessionID)
		if len(children) == 1 {
			childID = children[0].ID
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if childID == 0 {
		t.Fatal("同步 spawn 应已创建子任务")
	}
	time.Sleep(100 * time.Millisecond)
	if err := st.UpdateTask(childID, map[string]any{"status": store.StatusAwaitingReview}); err != nil {
		t.Fatal(err)
	}
	res := <-ch
	if res.err != nil {
		t.Fatalf("待审批是停止点，不应报错: %v", res.err)
	}
	if res.out.TimedOut {
		t.Fatal("待审停止点不应判超时")
	}
	if res.out.Result == nil || res.out.Result.Status != store.StatusAwaitingReview {
		t.Fatalf("应返回 awaitint_review 结果: %+v", res.out.Result)
	}
}
