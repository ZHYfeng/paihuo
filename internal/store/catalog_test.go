package store

import (
	"testing"
)

// 新库会预置一个通用模板，用于让会话中的 agent 把上下文整理成当前项目任务。
func TestOpenSeedsCreateTasksTemplate(t *testing.T) {
	s := openTest(t)

	templates, err := s.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(templates) != 1 {
		t.Fatalf("默认模板数量 = %d, want 1: %+v", len(templates), templates)
	}
	got := templates[0]
	if got.Name != createTasksTemplateName || got.Body != createTasksTemplateBody || got.RoleID != nil {
		t.Fatalf("默认模板 = %+v, want name=%q body=%q 且不绑定角色", got, createTasksTemplateName, createTasksTemplateBody)
	}
}

// 默认数据只初始化一次：重启不会重复插入，用户主动删除后也不会被恢复。
func TestDefaultTemplateSeedRunsOnce(t *testing.T) {
	path := t.TempDir() + "/seed.db"

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	templates, err := s.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(templates) != 1 {
		t.Fatalf("首次打开默认模板 = %+v, want 1 条", templates)
	}
	defaultID := templates[0].ID
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	templates, err = s.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(templates) != 1 || templates[0].ID != defaultID {
		t.Fatalf("重启后默认模板 = %+v, want 原来的 #%d", templates, defaultID)
	}
	if err := s.DeleteTemplate(defaultID); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	templates, err = s.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(templates) != 0 {
		t.Fatalf("删除后重启不应恢复默认模板: %+v", templates)
	}
}

// 任务模板：创建 → 读取 → 更新 → 删除全链路，Role 关联随更新变化。
func TestTemplateCRUDRoundTrip(t *testing.T) {
	s := openTest(t)
	aid := mustRole(t, s, "tpl-agent", true)

	id, err := s.CreateTemplate(Template{Name: "发布检查", Body: "检查发布清单", RoleID: &aid})
	if err != nil {
		t.Fatal(err)
	}

	got, err := s.GetTemplate(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "发布检查" || got.Body != "检查发布清单" || got.RoleID == nil || *got.RoleID != aid {
		t.Fatalf("GetTemplate = %+v, want 完整字段", got)
	}

	// 更新名称与内容；agent 置空应落库为 NULL
	if err := s.UpdateTemplate(id, map[string]any{"name": "发布检查 v2", "body": "更新后的提示词", "role_id": nil}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetTemplate(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "发布检查 v2" || got.Body != "更新后的提示词" || got.RoleID != nil {
		t.Fatalf("UpdateTemplate 后 GetTemplate = %+v, want 新值且 role_id NULL", got)
	}
	if got.RoleName != "" {
		t.Fatalf("agent 置空后 RoleName = %q, want 空", got.RoleName)
	}

	if err := s.DeleteTemplate(id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetTemplate(id); err == nil {
		t.Fatal("删除后 GetTemplate 应报错")
	}
}

// 停用的角色不应出现在可派发队列里。
func TestSkillTagsRoundTripAndNormalize(t *testing.T) {
	s := openTest(t)
	id, err := s.CreateSkill(Skill{
		Name: "tagged", Dir: t.TempDir(), Tags: []string{" 编程 ", "文档", "编程", "DOCS"},
	})
	if err != nil {
		t.Fatal(err)
	}
	sk, err := s.GetSkill(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(sk.Tags) != 3 || sk.Tags[0] != "编程" || sk.Tags[1] != "文档" || sk.Tags[2] != "DOCS" {
		t.Fatalf("技能标签未按预期规范化: %+v", sk.Tags)
	}
	if err := s.UpdateSkillTags(id, []string{"审查", "审查", " 文档 "}); err != nil {
		t.Fatal(err)
	}
	sk, err = s.GetSkill(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(sk.Tags) != 2 || sk.Tags[0] != "审查" || sk.Tags[1] != "文档" {
		t.Fatalf("技能标签更新未持久化: %+v", sk.Tags)
	}
}
