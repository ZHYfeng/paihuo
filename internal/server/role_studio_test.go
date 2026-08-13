package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	paiexec "paihuo/internal/exec"
	"paihuo/internal/store"
)

func TestSplitRoleStudioPatch(t *testing.T) {
	output := "已根据测试结果调整。\n<PAIHUO_ROLE_DRAFT>\n" +
		`{"name":"前端审查员","description":"检查 UI","runtime_id":"codex","max_concurrency":2,"role_config":{"instructions":"先审查再修改"}}` +
		"\n</PAIHUO_ROLE_DRAFT>\n"
	message, draft := splitRoleStudioPatch(output)
	if draft == nil || draft.Name != "前端审查员" || draft.MaxConcurrency != 2 {
		t.Fatalf("未解析完整角色草稿: %#v", draft)
	}
	if message != "已根据测试结果调整。" {
		t.Fatalf("未移除协议区块: %q", message)
	}
}

func TestSplitRoleStudioPatchInvalidJSON(t *testing.T) {
	message, draft := splitRoleStudioPatch("说明\n<PAIHUO_ROLE_DRAFT>坏 JSON</PAIHUO_ROLE_DRAFT>")
	if draft != nil {
		t.Fatalf("非法 JSON 不应作为草稿返回: %#v", draft)
	}
	if !strings.Contains(message, "说明") {
		t.Fatalf("应保留自然语言答复: %q", message)
	}
}

func TestRoleStudioDraftJSONRedactsEnvironment(t *testing.T) {
	draft := roleStudioDraft{RuntimeID: "codex", RoleConfig: store.RoleConfig{Env: map[string]string{"API_KEY": "secret"}}}
	text := roleStudioDraftJSON(draft)
	if strings.Contains(text, "secret") || !strings.Contains(text, `"env": null`) {
		t.Fatalf("角色助手上下文不应包含环境变量值: %s", text)
	}
}

func TestNormalizeRoleStudioDraft(t *testing.T) {
	runtimes := paiexec.NewDefaultRuntimeService()
	draft, err := normalizeRoleStudioDraft(runtimes, roleStudioDraft{RuntimeID: "codex"}, false)
	if err != nil || draft.MaxConcurrency != 1 {
		t.Fatalf("应将并发零值归一化为 1: %#v, %v", draft, err)
	}
	if _, err := normalizeRoleStudioDraft(runtimes, roleStudioDraft{RuntimeID: "missing"}, false); err == nil {
		t.Fatal("未知 CLI 应被拒绝")
	}
	if _, err := normalizeRoleStudioDraft(runtimes, roleStudioDraft{RuntimeID: "codex"}, true); err == nil {
		t.Fatal("要求名称时应拒绝空名称")
	}
}

func TestCleanRoleStudioOutput(t *testing.T) {
	text := "Codex header\n完整用户提示\n答复\ntokens used\n1,234\n最终答复"
	if got := cleanRoleStudioOutput("codex", text); got != "最终答复" {
		t.Fatalf("应只保留 Codex 最终答复，得到 %q", got)
	}
	if got := cleanRoleStudioOutput("pi", "tokens used\n答复"); got != "tokens used\n答复" {
		t.Fatalf("其他 CLI 不应误裁剪输出: %q", got)
	}
}

func TestRoleStudioSkillPromptsAreConcise(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "source-dir")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: brand\ndescription: brand workflow\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	draft := roleStudioDraft{RoleConfig: store.RoleConfig{Skills: []string{dir}}}

	if got, want := roleStudioSkillInstruction(draft), "待创建角色拥有以下技能：\n- brand"; got != want {
		t.Fatalf("draft skill prompt=%q, want %q", got, want)
	}
	got := roleStudioPreparedSkillsPrompt(draft.RoleConfig.Skills)
	if want := "当前角色拥有以下技能：\n- brand"; got != want {
		t.Fatalf("prepared skill prompt=%q, want %q", got, want)
	}
	for _, unwanted := range []string{"PaiHuo", "SKILL.md", dir, "必须阅读", "工作流程", "不要修改或提交"} {
		if strings.Contains(got, unwanted) {
			t.Fatalf("prepared skill prompt should not contain %q: %s", unwanted, got)
		}
	}
}
