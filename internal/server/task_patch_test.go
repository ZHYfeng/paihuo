package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"paihuo/internal/store"
)

func TestParseTaskPatchPreservesJSONFieldPresence(t *testing.T) {
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/1", strings.NewReader(`{"title":null,"body":"","enabled":false,"parent_id":0}`))
	resp := httptest.NewRecorder()
	patch, ok := parseTaskPatch(resp, req)
	if !ok {
		t.Fatalf("解析失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	if value, present := patch.set["title"]; !present || value != nil {
		t.Fatalf("显式 null 未保留: present=%v value=%#v", present, value)
	}
	if value, present := patch.set["body"]; !present || value != "" {
		t.Fatalf("空字符串未保留: present=%v value=%#v", present, value)
	}
	if value, present := patch.set["enabled"]; !present || value != false {
		t.Fatalf("false 未保留: present=%v value=%#v", present, value)
	}
	if value, present := patch.set["parent_id"]; !present || value != float64(0) {
		t.Fatalf("零值未保留: present=%v value=%#v", present, value)
	}
	if _, present := patch.set["cron"]; present {
		t.Fatal("缺失字段不应出现在 taskPatch 中")
	}
}

func TestPatchTaskPreservesParsingRevisionAndApprovalErrors(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t,
		withTestStore(st),
		withTestExecutor(t.TempDir(), "task-patch-characterization.db", "task-patch-characterization"),
		withTestSkillsDir(t.TempDir()),
	)
	s := env.server
	roleID, err := st.CreateRole(store.Role{Name: "worker", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}

	newTask := func(status string) int64 {
		t.Helper()
		id, err := st.CreateTask(store.Task{Title: "patch target", Status: status, RoleID: &roleID})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	request := func(id int64, body, revision string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(id), strings.NewReader(body))
		req.SetPathValue("id", itoa(id))
		if revision != "" {
			req.Header.Set("If-Match", revision)
		}
		resp := httptest.NewRecorder()
		s.patchTask(resp, req)
		return resp
	}

	id := newTask(store.StatusQueued)
	for _, tc := range []struct {
		name     string
		body     string
		revision string
		code     int
		message  string
	}{
		{name: "unknown field", body: `{"unknown":true}`, revision: `"1"`, code: http.StatusBadRequest, message: "不允许修改字段: unknown"},
		{name: "wrong field type", body: `{"cron":false}`, revision: `"1"`, code: http.StatusBadRequest, message: "cron 必须是字符串"},
		{name: "missing revision", body: `{"title":"new"}`, code: http.StatusPreconditionRequired, message: "mutation 必须携带有效的 If-Match revision"},
		{name: "stale revision", body: `{"title":"new"}`, revision: `"99"`, code: http.StatusConflict, message: store.ErrRevisionConflict.Error()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := request(id, tc.body, tc.revision)
			if resp.Code != tc.code || !strings.Contains(resp.Body.String(), tc.message) {
				t.Fatalf("code=%d body=%s", resp.Code, resp.Body.String())
			}
		})
	}

	resp := request(id, `{"status":"running","perm":"bogus"}`, `"1"`)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "不允许从 queued 转为 running") {
		t.Fatalf("状态错误应先于普通字段错误: code=%d body=%s", resp.Code, resp.Body.String())
	}

	reviewID := newTask(store.StatusAwaitingReview)
	resp = request(reviewID, `{"status":"succeeded","title":"smuggled"}`, `"1"`)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "审批通过不能同时修改任务其他字段") {
		t.Fatalf("审批夹带字段应被拒绝: code=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestPatchTaskReloadsChangedSchedule(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t,
		withTestStore(st),
		withTestExecutor(t.TempDir(), "task-patch-schedule.db", "task-patch-schedule"),
		withTestSkillsDir(t.TempDir()),
	)
	roleID, err := st.CreateRole(store.Role{Name: "worker", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	id, err := st.CreateTask(store.Task{Title: "scheduled", Body: "run", Status: store.StatusQueued, RoleID: &roleID})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	env.server.sched.Start(ctx)
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(id), strings.NewReader(`{"cron":"* * * * * *","enabled":true}`))
	req.SetPathValue("id", itoa(id))
	setTaskRevision(t, st, id, req)
	resp := httptest.NewRecorder()
	env.server.patchTask(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("修改定时属性失败: code=%d body=%s", resp.Code, resp.Body.String())
	}

	deadline := time.Now().Add(2500 * time.Millisecond)
	for time.Now().Before(deadline) {
		tasks, err := st.ListTasksFiltered(store.TaskFilter{})
		if err != nil {
			t.Fatal(err)
		}
		for _, task := range tasks {
			if task.ScheduleID != nil && *task.ScheduleID == id {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("修改 cron 后调度器未重载，未创建定时实例")
}
