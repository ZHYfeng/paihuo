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

	"paihuo/internal/application"
	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/session"
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
	hub := events.NewEventStream()
	sess := session.New(st, hub, nil, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, exec.NewDefaultRuntimeService(), nil, hub)
	sc := sched.New(st, hub, nil, sess, wf)
	s := New(st, hub, nil, sc, sess, wf, "", filepath.Join(t.TempDir(), "managed-skills"))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/skills/"+strconv.FormatInt(id, 10), nil)
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

func TestSkillImportReadsTagsAndPatchUpdatesThem(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "reviewer")
	writeTestSkill(t, source, "---\nname: reviewer\ndescription: review code\ntags:\n  - coding\n  - review\n---\n")

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	sess := session.New(st, hub, nil, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, exec.NewDefaultRuntimeService(), nil, hub)
	sc := sched.New(st, hub, nil, sess, wf)
	s := New(st, hub, nil, sc, sess, wf, "", filepath.Join(root, "managed-skills"))

	body, err := json.Marshal(map[string]any{"source_path": source, "tags": []string{"team-a", "coding"}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/skills", bytes.NewReader(body))
	resp := httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("导入技能状态应为 201，得到 %d: %s", resp.Code, resp.Body.String())
	}
	var imported store.Skill
	if err := json.Unmarshal(resp.Body.Bytes(), &imported); err != nil {
		t.Fatal(err)
	}
	if len(imported.Tags) != 3 || imported.Tags[0] != "coding" || imported.Tags[1] != "review" || imported.Tags[2] != "team-a" {
		t.Fatalf("导入标签错误: %+v", imported.Tags)
	}

	body, err = json.Marshal(map[string]any{"tags": []string{"production", "production"}})
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/skills/"+strconv.FormatInt(imported.ID, 10), bytes.NewReader(body))
	resp = httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("更新技能标签状态应为 200，得到 %d: %s", resp.Code, resp.Body.String())
	}
	var updated store.Skill
	if err := json.Unmarshal(resp.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if len(updated.Tags) != 1 || updated.Tags[0] != "production" {
		t.Fatalf("更新后的标签错误: %+v", updated.Tags)
	}
}

// 分类（文件夹）：frontmatter category 优先，否则从源目录父文件夹名推断；
// 单个 PATCH 可改分类；批量 PATCH 按请求字段整体替换标签/设置分类。
func TestSkillCategoryInferenceAndBatchUpdate(t *testing.T) {
	root := t.TempDir()
	// 嵌套目录结构：catalog/coding/reviewer → 分类 "coding"（frontmatter 无 category）
	withCategory := filepath.Join(root, "catalog", "writing", "prose")
	writeTestSkill(t, withCategory, "---\nname: prose\ndescription: write well\ncategory: writing\n---\n")
	withoutCategory := filepath.Join(root, "catalog", "coding", "reviewer")
	writeTestSkill(t, withoutCategory, "---\nname: reviewer\ndescription: review code\n---\n")

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hub := events.NewEventStream()
	sess := session.New(st, hub, nil, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, exec.NewDefaultRuntimeService(), nil, hub)
	sc := sched.New(st, hub, nil, sess, wf)
	s := New(st, hub, nil, sc, sess, wf, "", filepath.Join(root, "managed-skills"))

	importSkill := func(source string) store.Skill {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"source_path": source})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/skills", bytes.NewReader(body))
		resp := httptest.NewRecorder()
		s.Handler().ServeHTTP(resp, req)
		if resp.Code != http.StatusCreated {
			t.Fatalf("导入 %s 应为 201，得到 %d: %s", source, resp.Code, resp.Body.String())
		}
		var sk store.Skill
		if err := json.Unmarshal(resp.Body.Bytes(), &sk); err != nil {
			t.Fatal(err)
		}
		return sk
	}

	// 1. frontmatter category 优先；缺失时从源目录父文件夹名推断。
	prose := importSkill(withCategory)
	if prose.Category != "writing" {
		t.Fatalf("frontmatter category 未生效: %q", prose.Category)
	}
	reviewer := importSkill(withoutCategory)
	if reviewer.Category != "coding" {
		t.Fatalf("应从源父文件夹推断分类: %q", reviewer.Category)
	}

	// 2. 单个 PATCH 只改分类，标签不受影响。
	body, _ := json.Marshal(map[string]any{"category": "engineering"})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/skills/"+strconv.FormatInt(reviewer.ID, 10), bytes.NewReader(body))
	resp := httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("PATCH 分类应为 200，得到 %d: %s", resp.Code, resp.Body.String())
	}
	var patched store.Skill
	if err := json.Unmarshal(resp.Body.Bytes(), &patched); err != nil {
		t.Fatal(err)
	}
	if patched.Category != "engineering" {
		t.Fatalf("分类未更新: %q", patched.Category)
	}

	// 3. 批量 PATCH：整体替换标签 + 设置分类。
	body, _ = json.Marshal(map[string]any{"ids": []int64{prose.ID, reviewer.ID}, "tags": []string{"shared"}, "category": "core"})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/skills", bytes.NewReader(body))
	resp = httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("批量 PATCH 应为 200，得到 %d: %s", resp.Code, resp.Body.String())
	}
	var updated []store.Skill
	if err := json.Unmarshal(resp.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if len(updated) != 2 {
		t.Fatalf("批量返回应含 2 个技能，得到 %d", len(updated))
	}
	for _, sk := range updated {
		if sk.Category != "core" || len(sk.Tags) != 1 || sk.Tags[0] != "shared" {
			t.Fatalf("批量更新结果错误: %+v", sk)
		}
	}

	// 4. 批量 PATCH 只带 ids+tags：分类保持不变。
	body, _ = json.Marshal(map[string]any{"ids": []int64{prose.ID}, "tags": []string{"only-tag"}})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/skills", bytes.NewReader(body))
	resp = httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("批量 PATCH 标签应为 200，得到 %d: %s", resp.Code, resp.Body.String())
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if len(updated) != 1 || updated[0].Category != "core" || len(updated[0].Tags) != 1 || updated[0].Tags[0] != "only-tag" {
		t.Fatalf("只改标签时分类必须保留: %+v", updated)
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
	hub := events.NewEventStream()
	sess := session.New(st, hub, nil, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, exec.NewDefaultRuntimeService(), nil, hub)
	sc := sched.New(st, hub, nil, sess, wf)
	s := New(st, hub, nil, sc, sess, wf, "", managedDir)

	scan := func() (*httptest.ResponseRecorder, skillScanResult) {
		t.Helper()
		body, err := json.Marshal(map[string]string{"source_path": root})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/skills/scan", bytes.NewReader(body))
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
	hub := events.NewEventStream()
	sess := session.New(st, hub, nil, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, exec.NewDefaultRuntimeService(), nil, hub)
	sc := sched.New(st, hub, nil, sess, wf)
	s := New(st, hub, nil, sc, sess, wf, "", filepath.Join(t.TempDir(), "managed-skills"))

	body, err := json.Marshal(map[string]string{"source_path": root})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/skills/scan", bytes.NewReader(body))
	resp := httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("没有 SKILL.md 的目录应被拒绝，得到 %d: %s", resp.Code, resp.Body.String())
	}
}

func TestDeleteSkillsBatchDeletesRecordsAndCopies(t *testing.T) {
	root := t.TempDir()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	paths := []string{filepath.Join(root, "one"), filepath.Join(root, "two")}
	ids := make([]int64, 0, len(paths))
	for i, dir := range paths {
		writeTestSkill(t, dir, "# Skill\n")
		id, err := st.CreateSkill(store.Skill{
			Name: filepath.Base(dir), Dir: dir, SourcePath: filepath.Join(root, "source", filepath.Base(dir)),
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		if i == 0 {
			// 让重复 id 也经过批量接口的去重逻辑。
			ids = append(ids, id)
		}
	}

	hub := events.NewEventStream()
	sess := session.New(st, hub, nil, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, exec.NewDefaultRuntimeService(), nil, hub)
	sc := sched.New(st, hub, nil, sess, wf)
	s := New(st, hub, nil, sc, sess, wf, "", filepath.Join(root, "managed-skills"))
	body, err := json.Marshal(map[string]any{"ids": ids})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/skills", bytes.NewReader(body))
	resp := httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("批量删除状态应为 200，得到 %d: %s", resp.Code, resp.Body.String())
	}
	var result struct {
		Deleted []int64 `json:"deleted"`
		Count   int     `json:"count"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Count != 2 || len(result.Deleted) != 2 {
		t.Fatalf("批量删除返回错误: %+v", result)
	}
	all, err := st.ListSkills()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 0 {
		t.Fatalf("批量删除后仍有技能记录: %+v", all)
	}
	for _, dir := range paths {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("技能副本没有清理: %s, err=%v", dir, err)
		}
	}
}

func TestDeleteSkillsBatchMissingIDDoesNotPartiallyDelete(t *testing.T) {
	root := t.TempDir()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	id, err := st.CreateSkill(store.Skill{Name: "one", Dir: filepath.Join(root, "one")})
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewEventStream()
	sess := session.New(st, hub, nil, t.TempDir(), t.TempDir())
	wf := application.NewWorkflowService(st, exec.NewDefaultRuntimeService(), nil, hub)
	sc := sched.New(st, hub, nil, sess, wf)
	s := New(st, hub, nil, sc, sess, wf, "", filepath.Join(root, "managed-skills"))
	body, err := json.Marshal(map[string]any{"ids": []int64{id, id + 999}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/skills", bytes.NewReader(body))
	resp := httptest.NewRecorder()
	s.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusNotFound {
		t.Fatalf("不存在技能应返回 404，得到 %d: %s", resp.Code, resp.Body.String())
	}
	all, err := st.ListSkills()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0].ID != id {
		t.Fatalf("批量删除校验失败时不应部分删除: %+v", all)
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
