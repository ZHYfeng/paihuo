package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"paihuo/internal/store"
)

// fsDirs 必须把 dirs 序列化为 JSON 数组（空目录为 [] 而非 null），
// 否则前端 DirectoryPicker 的 listing.dirs.map 会崩溃。
func TestFsDirsEmptyDirReturnsEmptyArray(t *testing.T) {
	empty := t.TempDir()
	withDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(withDir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t,
		withTestStore(st),
		withTestSkillsDir(filepath.Join(t.TempDir(), "managed-skills")),
	)
	s := env.server

	for _, dir := range []string{empty, withDir} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/fs/dirs?path="+dir, nil)
		resp := httptest.NewRecorder()
		s.Handler().ServeHTTP(resp, req)
		if resp.Code != http.StatusOK {
			t.Fatalf("fs/dirs %s 状态应为 200，得到 %d: %s", dir, resp.Code, resp.Body.String())
		}
		var listing struct {
			Path   string   `json:"path"`
			Parent string   `json:"parent"`
			Dirs   []string `json:"dirs"`
		}
		if err := json.Unmarshal(resp.Body.Bytes(), &listing); err != nil {
			t.Fatalf("fs/dirs 响应解析失败: %v", err)
		}
		if listing.Dirs == nil {
			t.Fatalf("fs/dirs %s 的 dirs 必须是非 null 数组，得到: %s", dir, resp.Body.String())
		}
	}
}
