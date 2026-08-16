package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"paihuo/internal/application"
	"paihuo/internal/artifact"
	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/session"
	"paihuo/internal/store"
)

func TestArtifactAPIStoresListsDownloadsAndDeletesContent(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	taskID, err := st.CreateTask(store.Task{Title: "artifact owner", Status: store.StatusQueued})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	hub := events.NewEventStream(st)
	sess := session.New(st, hub, nil, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, exec.NewDefaultRuntimeService(), nil, hub)
	sc := sched.New(st, hub, nil, sess, wf)
	s := New(st, hub, nil, sc, sess, wf, "", filepath.Join(root, "skills"))

	payload := []byte("immutable result\n")
	requestBody, err := json.Marshal(map[string]any{
		"task_id": taskID, "name": "结果 报告.txt", "media_type": "text/plain; charset=utf-8",
		"content": base64.StdEncoding.EncodeToString(payload), "created_by": "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	create := httptest.NewRequest(http.MethodPost, "/api/v1/artifacts", bytes.NewReader(requestBody))
	create.Header.Set("Content-Type", "application/json")
	created := httptest.NewRecorder()
	s.Handler().ServeHTTP(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var item artifact.Metadata
	if err := json.Unmarshal(created.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if item.TaskID == nil || *item.TaskID != taskID || item.ContentHash == "" || item.Size != int64(len(payload)) {
		t.Fatalf("unexpected metadata: %+v", item)
	}

	list := httptest.NewRecorder()
	s.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/v1/artifacts?task_id="+strconv.FormatInt(taskID, 10), nil))
	if list.Code != http.StatusOK || !bytes.Contains(list.Body.Bytes(), []byte(item.ContentHash)) {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}

	content := httptest.NewRecorder()
	s.Handler().ServeHTTP(content, httptest.NewRequest(http.MethodGet, "/api/v1/artifacts/"+strconv.FormatInt(item.ID, 10)+"/content", nil))
	if content.Code != http.StatusOK || !bytes.Equal(content.Body.Bytes(), payload) {
		t.Fatalf("content status=%d body=%q", content.Code, content.Body.Bytes())
	}
	if got := content.Header().Get("Content-Disposition"); got == "" {
		t.Fatal("download must include a safe Content-Disposition header")
	}

	remove := httptest.NewRecorder()
	s.Handler().ServeHTTP(remove, httptest.NewRequest(http.MethodDelete, "/api/v1/artifacts/"+strconv.FormatInt(item.ID, 10), nil))
	if remove.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", remove.Code, remove.Body.String())
	}
	if _, err := s.artifacts.Open(t.Context(), item.Locator); err == nil {
		t.Fatal("unreferenced artifact content should be deleted")
	}

	createAgain := httptest.NewRequest(http.MethodPost, "/api/v1/artifacts", bytes.NewReader(requestBody))
	createAgain.Header.Set("Content-Type", "application/json")
	createdAgain := httptest.NewRecorder()
	s.Handler().ServeHTTP(createdAgain, createAgain)
	if createdAgain.Code != http.StatusCreated {
		t.Fatalf("create for cleanup status=%d body=%s", createdAgain.Code, createdAgain.Body.String())
	}
	var cleanupItem artifact.Metadata
	if err := json.Unmarshal(createdAgain.Body.Bytes(), &cleanupItem); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTask(taskID, map[string]any{"status": store.StatusSucceeded, "finished_at": store.Now()}); err != nil {
		t.Fatal(err)
	}
	cleanup := httptest.NewRecorder()
	cleanupRequest := httptest.NewRequest(http.MethodPost, "/api/v1/tasks/cleanup", bytes.NewBufferString(`{}`))
	cleanupRequest.Header.Set("Content-Type", "application/json")
	s.Handler().ServeHTTP(cleanup, cleanupRequest)
	if cleanup.Code != http.StatusOK || !bytes.Contains(cleanup.Body.Bytes(), []byte(`"deleted":1`)) {
		t.Fatalf("cleanup status=%d body=%s", cleanup.Code, cleanup.Body.String())
	}
	if _, err := s.artifacts.Open(t.Context(), cleanupItem.Locator); err == nil {
		t.Fatal("task cleanup must remove unreferenced artifact content")
	}
}
