package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"paihuo/internal/store"
)

func TestPatchTaskProjectBackfillsDirectory(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	projectDir := filepath.Join(root, "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sessionsRoot := filepath.Join(root, "sessions")
	env := newTestServer(t,
		withTestStore(st),
		withTestRoot(root),
		withTestExecutor(sessionsRoot, filepath.Join(root, "executor.db"), "project-assignment-test"),
		withTestSession(sessionsRoot, t.TempDir()),
	)
	s := env.server

	roleID, err := st.CreateRole(store.Role{Name: "worker", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	projectID, err := st.CreateProject(store.Project{Name: "project", ProjectDir: projectDir, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	taskID, err := st.CreateTask(store.Task{Title: "assign project", Status: store.StatusQueued, RoleID: &roleID})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(taskID), strings.NewReader(`{"project_id":`+itoa(projectID)+`}`))
	req.SetPathValue("id", itoa(taskID))
	setTaskRevision(t, st, taskID, req)
	resp := httptest.NewRecorder()
	s.patchTask(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("指派项目失败: code=%d body=%s", resp.Code, resp.Body.String())
	}
	var got store.Task
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.ProjectID == nil || *got.ProjectID != projectID || got.ProjectDir != projectDir {
		t.Fatalf("指派项目后目录未同步: %+v", got)
	}

	clearReq := httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+itoa(taskID), strings.NewReader(`{"project_id":null}`))
	clearReq.SetPathValue("id", itoa(taskID))
	setTaskRevision(t, st, taskID, clearReq)
	clearResp := httptest.NewRecorder()
	s.patchTask(clearResp, clearReq)
	if clearResp.Code != http.StatusOK {
		t.Fatalf("清除项目失败: code=%d body=%s", clearResp.Code, clearResp.Body.String())
	}
	if err := json.Unmarshal(clearResp.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != nil || got.ProjectDir != "" {
		t.Fatalf("清除项目后应清除目录: %+v", got)
	}
}
