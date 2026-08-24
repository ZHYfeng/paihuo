package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"paihuo/internal/store"
)

func TestProjectStatsUsesPluralResourcePath(t *testing.T) {
	env := newTestServer(t)
	projectID, err := env.store.CreateProject(store.Project{Name: "stats-project", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}

	current := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(current, httptest.NewRequest(http.MethodGet, "/api/v1/stats/projects/"+itoa(projectID), nil))
	if current.Code != http.StatusOK {
		t.Fatalf("复数项目统计路径失败: code=%d body=%s", current.Code, current.Body.String())
	}

	legacy := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(legacy, httptest.NewRequest(http.MethodGet, "/api/v1/stats/project/"+itoa(projectID), nil))
	if legacy.Code != http.StatusNotFound {
		t.Fatalf("单数项目统计路径应被删除: code=%d body=%s", legacy.Code, legacy.Body.String())
	}
}
