package exec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareRoleSkillsUsesNativeRootsAndCleansUp(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source", "design")
	if err := os.MkdirAll(filepath.Join(source, "references"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("---\nname: design\ndescription: design workflow\n---\n\nFollow the design workflow.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "references", "tokens.md"), []byte("tokens"), 0o644); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(t.TempDir(), "runtime", "role-skills.json")
	workspace := filepath.Join(t.TempDir(), "workspace")

	prepared, err := prepareRoleSkills(42, workspace, "opencode", manifest, []string{source, source})
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared.Bindings) != 1 {
		t.Fatalf("duplicate skill should be staged once, got %d", len(prepared.Bindings))
	}
	binding := prepared.Bindings[0]
	if !strings.HasPrefix(binding.NativeName, "paihuo-42-1-design") {
		t.Fatalf("unexpected native name: %q", binding.NativeName)
	}
	if got := filepath.Base(filepath.Dir(binding.Dir)); got != "skills" {
		t.Fatalf("skill parent=%q, want skills", got)
	}
	content, err := os.ReadFile(filepath.Join(binding.Dir, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "name: "+binding.NativeName) {
		t.Fatalf("staged SKILL.md name not rewritten: %s", content)
	}
	if got, err := os.ReadFile(filepath.Join(binding.Dir, "references", "tokens.md")); err != nil || string(got) != "tokens" {
		t.Fatalf("staged reference missing: %q %v", got, err)
	}
	prompt := buildRoleSkillsPrompt(prepared.Bindings)
	if want := "当前角色拥有以下技能：\n- design"; prompt != want {
		t.Fatalf("skill prompt=%q, want %q", prompt, want)
	}
	for _, unwanted := range []string{"PaiHuo", "SKILL.md", binding.Dir, "必须阅读", "工作流程", "references", "不要修改或提交"} {
		if strings.Contains(prompt, unwanted) {
			t.Fatalf("skill prompt should not contain %q: %s", unwanted, prompt)
		}
	}
	if _, err := os.Stat(manifest); err != nil {
		t.Fatalf("skill manifest missing: %v", err)
	}
	if err := cleanupRoleSkills(manifest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(binding.Dir); !os.IsNotExist(err) {
		t.Fatalf("staged skill should be removed, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(workspace, ".opencode")); !os.IsNotExist(err) {
		t.Fatalf("new native parents should be removed, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(source, "SKILL.md")); err != nil {
		t.Fatalf("source skill must remain intact: %v", err)
	}
}

func TestPrepareRoleSkillsMapsAllSupportedCLIs(t *testing.T) {
	source := filepath.Join(t.TempDir(), "skill")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("---\nname: test-skill\ndescription: test\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, cli := range []string{"omp", "codex", "pi", "claude", "opencode"} {
		t.Run(cli, func(t *testing.T) {
			workspace := filepath.Join(t.TempDir(), "workspace")
			manifest := filepath.Join(t.TempDir(), "manifest.json")
			prepared, err := prepareRoleSkills(7, workspace, cli, manifest, []string{source})
			if err != nil {
				t.Fatal(err)
			}
			root, ok := nativeSkillRoot(cli)
			if !ok || len(prepared.SkillDirs) != 1 || len(prepared.SkillNames) != 1 {
				t.Fatalf("unexpected preparation: root=%q ok=%v prepared=%+v", root, ok, prepared)
			}
			wantDir := filepath.Join(workspace, filepath.FromSlash(root), prepared.SkillNames[0])
			if prepared.SkillDirs[0] != wantDir {
				t.Fatalf("skill dir=%q, want %q", prepared.SkillDirs[0], wantDir)
			}
			if err := cleanupRoleSkills(manifest); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPrepareRoleSkillsRejectsInvalidSource(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	manifest := filepath.Join(t.TempDir(), "manifest.json")
	if _, err := prepareRoleSkills(1, workspace, "codex", manifest, []string{filepath.Join(t.TempDir(), "missing")}); err == nil {
		t.Fatal("missing skill source should fail")
	}
}
