package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"paihuo/internal/events"
	"paihuo/internal/store"
)

func TestGetSkillReturnsMarkdownDetail(t *testing.T) {
	dir := t.TempDir()
	content := "---\nname: reviewer\ndescription: review code\n---\n\n# Review\n\nCheck the diff carefully.\n"
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	id, err := st.CreateSkill(store.Skill{
		Name: "reviewer", Description: "review code", Dir: dir, SourcePath: "/source/reviewer",
	})
	if err != nil {
		t.Fatal(err)
	}
	s := New(st, events.NewHub(), nil, nil, "", filepath.Join(t.TempDir(), "managed-skills"))
	req := httptest.NewRequest(http.MethodGet, "/api/skills/"+strconv.FormatInt(id, 10), nil)
	resp := httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("技能详情状态应为 200，得到 %d: %s", resp.Code, resp.Body.String())
	}
	var detail struct {
		Name     string `json:"name"`
		Content  string `json:"content"`
		FileName string `json:"file_name"`
		Size     int64  `json:"size_bytes"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Name != "reviewer" || detail.Content != content || detail.FileName != "SKILL.md" || detail.Size != int64(len(content)) {
		t.Fatalf("技能详情内容错误: %+v", detail)
	}
}

func TestScanSkillsDiscoversRootAndNestedSkillsWithoutReimportingManagedCopies(t *testing.T) {
	root := t.TempDir()
	writeTestSkill(t, root, "---\nname: root-skill\ndescription: root description\n---\n")
	writing := filepath.Join(root, "catalog", "writing")
	writeTestSkill(t, writing, "---\nname: writing\ndescription: write better\n---\n")
	review := filepath.Join(root, "catalog", "engineering", "review")
	// 没有 frontmatter 时，名称应回退到目录名。
	writeTestSkill(t, review, "# Review skill\n")

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	managedDir := filepath.Join(root, "paihuo-managed-skills")
	s := New(st, events.NewHub(), nil, nil, "", managedDir)

	scan := func() (*httptest.ResponseRecorder, skillScanResult) {
		t.Helper()
		body, err := json.Marshal(map[string]string{"source_path": root})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/skills/scan", bytes.NewReader(body))
		resp := httptest.NewRecorder()
		s.Handler().ServeHTTP(resp, req)
		var result skillScanResult
		if resp.Code == http.StatusCreated || resp.Code == http.StatusOK || resp.Code == http.StatusMultiStatus {
			if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
				t.Fatalf("解析扫描结果: %v; body=%s", err, resp.Body.String())
			}
		}
		return resp, result
	}

	resp, first := scan()
	if resp.Code != http.StatusCreated {
		t.Fatalf("首次扫描状态应为 201，得到 %d: %s", resp.Code, resp.Body.String())
	}
	if first.Found != 3 || len(first.Imported) != 3 || len(first.Skipped) != 0 || len(first.Errors) != 0 {
		t.Fatalf("首次扫描结果错误: %+v", first)
	}
	byName := map[string]store.Skill{}
	for _, sk := range first.Imported {
		byName[sk.Name] = sk
		if !isPathWithin(sk.Dir, managedDir) {
			t.Errorf("技能副本没有写进管理目录: %+v", sk)
		}
		if _, err := os.Stat(filepath.Join(sk.Dir, "SKILL.md")); err != nil {
			t.Errorf("技能副本缺少 SKILL.md: %v", err)
		}
	}
	if _, ok := byName["root-skill"]; !ok {
		t.Errorf("没有导入根目录技能: %+v", first.Imported)
	}
	if _, ok := byName["writing"]; !ok {
		t.Errorf("没有导入嵌套 writing 技能: %+v", first.Imported)
	}
	if _, ok := byName["review"]; !ok {
		t.Errorf("没有按目录名导入无 frontmatter 的技能: %+v", first.Imported)
	}

	// 管理目录本身就在扫描根目录下。第二次扫描仍应只发现三个源技能，
	// 而不是把刚复制的副本再次当作新技能导入。
	resp, second := scan()
	if resp.Code != http.StatusOK {
		t.Fatalf("重复扫描状态应为 200，得到 %d: %s", resp.Code, resp.Body.String())
	}
	if second.Found != 3 || len(second.Imported) != 0 || len(second.Skipped) != 3 || len(second.Errors) != 0 {
		t.Fatalf("重复扫描应只跳过已导入技能，得到 %+v", second)
	}
	all, err := st.ListSkills()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("重复扫描不应产生重复记录，得到 %d 条: %+v", len(all), all)
	}
}

func TestScanSkillsRejectsDirectoryWithoutSkillFiles(t *testing.T) {
	root := t.TempDir()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	s := New(st, events.NewHub(), nil, nil, "", filepath.Join(t.TempDir(), "managed-skills"))

	body, err := json.Marshal(map[string]string{"source_path": root})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/skills/scan", bytes.NewReader(body))
	resp := httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("没有 SKILL.md 的目录应被拒绝，得到 %d: %s", resp.Code, resp.Body.String())
	}
}

func writeTestSkill(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
