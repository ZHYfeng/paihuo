package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/store"
)

func TestCreateInteractiveTaskRequiresPiAndDefaultsRemainBatch(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := exec.New(st, hub, t.TempDir(), "server-input-test.db")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", t.TempDir())

	codexID, err := st.CreateAgent(store.Agent{Name: "codex", CLI: "codex", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(`{"title":"bad","agent_id":`+itoa(codexID)+`,"run_mode":"interactive"}`))
	resp := httptest.NewRecorder()
	s.createTask(resp, req)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "Pi") {
		t.Fatalf("非 Pi 交互任务应被拒绝: code=%d body=%s", resp.Code, resp.Body.String())
	}

	piID, err := st.CreateAgent(store.Agent{Name: "pi", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(`{"title":"interactive","agent_id":`+itoa(piID)+`,"run_mode":"interactive"}`))
	resp = httptest.NewRecorder()
	s.createTask(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("Pi 交互任务创建失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	var tk store.Task
	if err := json.Unmarshal(resp.Body.Bytes(), &tk); err != nil {
		t.Fatal(err)
	}
	if tk.RunMode != store.RunModeInteractive {
		t.Fatalf("创建响应应保留 interactive，得到 %q", tk.RunMode)
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/tasks/"+itoa(tk.ID), strings.NewReader(`{"agent_id":`+itoa(codexID)+`}`))
	req.SetPathValue("id", itoa(tk.ID))
	resp = httptest.NewRecorder()
	s.patchTask(resp, req)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "Pi") {
		t.Fatalf("交互式任务不应允许改派非 Pi: code=%d body=%s", resp.Code, resp.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(`{"title":"batch","agent_id":`+itoa(piID)+`}`))
	resp = httptest.NewRecorder()
	s.createTask(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("默认批处理任务创建失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &tk); err != nil {
		t.Fatal(err)
	}
	if tk.RunMode != store.RunModeBatch {
		t.Fatalf("未指定 run_mode 应保持 batch，得到 %q", tk.RunMode)
	}
}

func TestInteractiveInputRequiresExactlyOnePayloadMode(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := exec.New(st, hub, t.TempDir(), "server-input-payload-test.db")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", t.TempDir())
	agentID, err := st.CreateAgent(store.Agent{Name: "pi", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{
		Title: "interactive", Status: store.StatusRunning, RunMode: store.RunModeInteractive, AgentID: &agentID,
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, body := range []string{`{}`, `{"message":"hello","keys":"h"}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/tasks/"+itoa(taskID)+"/input", strings.NewReader(body))
		req.SetPathValue("id", itoa(taskID))
		resp := httptest.NewRecorder()
		s.sendTaskInput(resp, req)
		if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "必须且只能提供一个") {
			t.Fatalf("输入模式应互斥: body=%s code=%d response=%s", body, resp.Code, resp.Body.String())
		}
	}
}

// 普通任务在创建后仍可改派到另一个角色，详情页的角色下拉框依赖该接口
// 同时返回最新角色信息以便立即刷新界面。
func TestPatchTaskChangesAssignedAgent(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := exec.New(st, hub, t.TempDir(), "server-task-agent-patch-test.db")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", t.TempDir())

	fromID, err := st.CreateAgent(store.Agent{Name: "from", CLI: "pi", Enabled: true, ProjectDir: "/from"})
	if err != nil {
		t.Fatal(err)
	}
	toID, err := st.CreateAgent(store.Agent{Name: "to", CLI: "codex", Enabled: true, ProjectDir: "/to"})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{
		Title: "reassignable", Status: store.StatusQueued, RunMode: store.RunModeBatch,
		AgentID: &fromID, ProjectDir: "/from",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/tasks/"+itoa(taskID), strings.NewReader(`{"agent_id":`+itoa(toID)+`}`))
	req.SetPathValue("id", itoa(taskID))
	resp := httptest.NewRecorder()
	s.patchTask(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("改派角色失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	var patched store.Task
	if err := json.Unmarshal(resp.Body.Bytes(), &patched); err != nil {
		t.Fatal(err)
	}
	if patched.AgentID == nil || *patched.AgentID != toID || patched.AgentName != "to" || patched.ProjectDir != "/to" {
		t.Fatalf("改派响应错误: %+v", patched)
	}

	persisted, err := st.GetTask(taskID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.AgentID == nil || *persisted.AgentID != toID {
		t.Fatalf("改派未持久化: %+v", persisted)
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/tasks/"+itoa(taskID), strings.NewReader(`{"agent_id":null}`))
	req.SetPathValue("id", itoa(taskID))
	resp = httptest.NewRecorder()
	s.patchTask(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("取消指派失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	// agent_name 在未指派时会因 omitempty 缺席；复用上一次的接收对象会把
	// 旧角色名误当成接口返回值，必须清零后再解码。
	patched = store.Task{}
	if err := json.Unmarshal(resp.Body.Bytes(), &patched); err != nil {
		t.Fatal(err)
	}
	if patched.AgentID != nil || patched.AgentName != "" || patched.ProjectDir != "" {
		t.Fatalf("取消指派响应错误: %+v", patched)
	}

	projectID, err := st.CreateProject(store.Project{Name: "project", Status: "active", ProjectDir: "/project"})
	if err != nil {
		t.Fatal(err)
	}
	projectTaskID, err := st.CreateTask(store.Task{
		Title: "project task", Status: store.StatusQueued, RunMode: store.RunModeBatch,
		AgentID: &fromID, ProjectID: &projectID, ProjectDir: "/project",
	})
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPatch, "/api/tasks/"+itoa(projectTaskID), strings.NewReader(`{"agent_id":`+itoa(toID)+`}`))
	req.SetPathValue("id", itoa(projectTaskID))
	resp = httptest.NewRecorder()
	s.patchTask(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("项目任务改派失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	patched = store.Task{}
	if err := json.Unmarshal(resp.Body.Bytes(), &patched); err != nil {
		t.Fatal(err)
	}
	if patched.AgentID == nil || *patched.AgentID != toID || patched.ProjectDir != "/project" {
		t.Fatalf("改派不应覆盖项目目录: %+v", patched)
	}
}

func TestResumeTaskRequeuesOriginalTask(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := exec.New(st, hub, t.TempDir(), "server-resume-test.db")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", t.TempDir())

	agentID, err := st.CreateAgent(store.Agent{Name: "pi", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	const title = "继续原任务"
	const body = "保留原提示词，不创建续跑子任务"
	id, err := st.CreateTask(store.Task{
		Title: title, Body: body, Status: store.StatusFailed, Perm: store.PermFull,
		RunMode: store.RunModeBatch, AgentID: &agentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	exitCode := 1
	if err := st.UpdateTask(id, map[string]any{
		"started_at": store.Now(), "finished_at": store.Now(), "error": "上次失败",
		"exit_code": exitCode, "tmux_log_offset": int64(42),
		"worktree_branch": "paihuo/task-continue", "base_commit": "base-commit",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/tasks/"+itoa(id)+"/resume", nil)
	req.SetPathValue("id", itoa(id))
	resp := httptest.NewRecorder()
	s.resumeTask(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("原任务继续失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	var resumed store.Task
	if err := json.Unmarshal(resp.Body.Bytes(), &resumed); err != nil {
		t.Fatal(err)
	}
	if resumed.ID != id || resumed.Status != store.StatusQueued || resumed.Title != title || resumed.Body != body {
		t.Fatalf("应在原记录上重新入队，得到 %+v", resumed)
	}
	if resumed.StartedAt != nil || resumed.FinishedAt != nil || resumed.Error != "" || resumed.ExitCode != nil || resumed.TmuxLogOffset != 0 {
		t.Fatalf("续跑应清空本轮执行痕迹，得到 %+v", resumed)
	}
	if resumed.WorktreeBranch != "paihuo/task-continue" || resumed.BaseCommit != "base-commit" {
		t.Fatalf("续跑应保留原 worktree 绑定，得到 %+v", resumed)
	}
	tasks, err := st.ListTasks()
	if err != nil || len(tasks) != 1 || tasks[0].ID != id {
		t.Fatalf("续跑不得创建新任务: tasks=%+v err=%v", tasks, err)
	}
	logs, err := st.ListLogs(id)
	if err != nil || len(logs) != 1 || !strings.Contains(logs[0].Content, "在原任务中继续") {
		t.Fatalf("应记录原任务继续事件: logs=%+v err=%v", logs, err)
	}

	// 同一任务已重新排队，重复请求不得覆盖回 queued 或再写一条续跑记录。
	req = httptest.NewRequest(http.MethodPost, "/api/tasks/"+itoa(id)+"/resume", nil)
	req.SetPathValue("id", itoa(id))
	resp = httptest.NewRecorder()
	s.resumeTask(resp, req)
	if resp.Code != http.StatusConflict {
		t.Fatalf("排队中的任务不应重复继续: code=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestResumeTaskDoesNotBypassExistingMergeTask(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewHub()
	executor := exec.New(st, hub, t.TempDir(), "server-resume-merge-test.db")
	s := New(st, hub, executor, sched.New(st, hub, executor), "", t.TempDir())
	agentID, err := st.CreateAgent(store.Agent{Name: "pi", CLI: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := st.CreateTask(store.Task{
		Title: "已完成源任务", Status: store.StatusSucceeded, Perm: store.PermFull,
		RunMode: store.RunModeBatch, AgentID: &agentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := st.GetTask(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateTask(store.NewMergeTask(*source)); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/tasks/"+itoa(sourceID)+"/resume", nil)
	req.SetPathValue("id", itoa(sourceID))
	resp := httptest.NewRecorder()
	s.resumeTask(resp, req)
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "源任务代码已完成") {
		t.Fatalf("不应绕过现有合并任务: code=%d body=%s", resp.Code, resp.Body.String())
	}
	got, err := st.GetTask(sourceID)
	if err != nil || got.Status != store.StatusSucceeded {
		t.Fatalf("被拒绝后源任务状态应保持完成: task=%+v err=%v", got, err)
	}
}

func itoa(id int64) string {
	return strconv.FormatInt(id, 10)
}
