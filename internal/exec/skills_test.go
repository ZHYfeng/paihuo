package exec

import (
	"encoding/json"
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
		t.Fatalf("skill system prompt=%q, want %q", prompt, want)
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

// writeSkill 建一个合规技能目录（frontmatter name=目录名），返回其路径。
func writeSkill(t *testing.T, name string, desc string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(filepath.Join(dir, "references"), 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: " + name + "\ndescription: " + desc + "\n---\n\nDo the " + name + " workflow.\n"
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "references", "tokens.md"), []byte("tokens"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestEnsureRoleSkillsBuildsSymlinkMountAndIsIdempotent(t *testing.T) {
	src := writeSkill(t, "design", "design workflow")
	roleDir := filepath.Join(t.TempDir(), ".role-agents", "7")

	mount, err := EnsureRoleSkills(7, "设计师", []string{src}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mount.SkillPaths) != 1 || len(mount.SkillNames) != 1 || mount.SkillNames[0] != "design" {
		t.Fatalf("unexpected mount: %+v", mount)
	}
	link := mount.SkillPaths[0]
	fi, err := os.Lstat(link)
	if err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("合规技能应挂 symlink: %v %v", fi, err)
	}
	got, err := filepath.EvalSymlinks(link)
	if err != nil || filepath.Clean(got) != filepath.Clean(src) {
		t.Fatalf("symlink 应指向技能库: %q %v", got, err)
	}
	if mount.Bindings[0].OriginalName != "design" {
		t.Fatalf("提示词技能名应与挂载 slug 一致（各 CLI 可见名）: %+v", mount.Bindings[0])
	}
	// claude 镜像 + 插件清单 + omp overlay + opencode env
	if _, err := os.Stat(filepath.Join(roleDir, "skills", "design")); err != nil {
		t.Fatalf("claude 镜像缺失: %v", err)
	}
	if _, err := os.Stat(filepath.Join(roleDir, ".claude-plugin", "plugin.json")); err != nil {
		t.Fatalf("claude 插件清单缺失: %v", err)
	}
	if mount.OmpOverlay == "" || mount.ClaudePlugin != roleDir || mount.OpencodeConfig == "" {
		t.Fatalf("CLI 挂载描述缺失: %+v", mount)
	}
	var cfg struct {
		Skills struct {
			Paths []string `json:"paths"`
		} `json:"skills"`
	}
	if err := json.Unmarshal([]byte(mount.OpencodeConfig), &cfg); err != nil || len(cfg.Skills.Paths) != 1 {
		t.Fatalf("opencode env 内容错误: %v %s", err, mount.OpencodeConfig)
	}

	// 幂等：第二次调用不重建，symlink inode 不变（保留 mtime）。
	before, _ := os.Stat(link)
	mount2, err := EnsureRoleSkills(7, "设计师", []string{src}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(mount2.SkillPaths[0])
	if !os.SameFile(before, after) {
		t.Fatal("幂等对账不应重建已一致的技能条目")
	}
	if len(mount2.Warnings) != 0 {
		t.Fatalf("合规技能不应有告警: %v", mount2.Warnings)
	}
}

func TestEnsureRoleSkillsFallbackCopyForNonCompliantFrontmatter(t *testing.T) {
	src := filepath.Join(t.TempDir(), "Design Docs") // 目录名非 slug
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	// frontmatter name 与挂载目录名不一致 → 回退副本 + 改写 name
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("---\nname: other-name\ndescription: x\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	roleDir := filepath.Join(t.TempDir(), ".role-agents", "8")
	mount, err := EnsureRoleSkills(8, "角色", []string{src}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mount.SkillPaths) != 1 {
		t.Fatalf("should mount fallback copy: %+v", mount)
	}
	if fi, _ := os.Lstat(mount.SkillPaths[0]); fi.Mode()&os.ModeSymlink != 0 {
		t.Fatal("不合规技能应为副本而非 symlink")
	}
	content, err := os.ReadFile(filepath.Join(mount.SkillPaths[0], "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "name: design-docs") {
		t.Fatalf("副本 SKILL.md name 未改写: %s", content)
	}
	warned := false
	for _, w := range mount.Warnings {
		if strings.Contains(w, "回退为副本") {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("回退副本应有告警: %v", mount.Warnings)
	}
}

func TestEnsureRoleSkillsRemovesUnselectedAndRepairs(t *testing.T) {
	src := writeSkill(t, "alpha", "a")
	src2 := writeSkill(t, "beta", "b")
	roleDir := filepath.Join(t.TempDir(), ".role-agents", "9")

	mount, err := EnsureRoleSkills(9, "角色", []string{src, src2}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mount.SkillNames) != 2 {
		t.Fatalf("两个技能都应挂载: %+v", mount.SkillNames)
	}

	// 移除一个技能 → 条目被删除
	mount, err = EnsureRoleSkills(9, "角色", []string{src2}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mount.SkillNames) != 1 || mount.SkillNames[0] != "beta" {
		t.Fatalf("未重新对账: %+v", mount.SkillNames)
	}
	if _, err := os.Stat(filepath.Join(roleDir, ".agents", "skills", "alpha")); !os.IsNotExist(err) {
		t.Fatalf("已移除技能应被删除: %v", err)
	}
	if _, err := os.Stat(filepath.Join(roleDir, "skills", "alpha")); !os.IsNotExist(err) {
		t.Fatalf("claude 镜像应被删除: %v", err)
	}

	// 源目录被删 → 剔除 + 告警；恢复 → 重新挂载
	if err := os.RemoveAll(src2); err != nil {
		t.Fatal(err)
	}
	mount, err = EnsureRoleSkills(9, "角色", []string{src2}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mount.SkillPaths) != 0 {
		t.Fatalf("失效技能应从挂载集合剔除: %+v", mount.SkillPaths)
	}
	if len(mount.Warnings) == 0 || !strings.Contains(mount.Warnings[0], "无法加载") {
		t.Fatalf("应有加载失败告警: %v", mount.Warnings)
	}
	if _, err := os.Stat(filepath.Join(roleDir, ".agents", "skills", "beta")); !os.IsNotExist(err) {
		t.Fatalf("失效条目应被移除: %v", err)
	}
	if err := os.MkdirAll(src2, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src2, "SKILL.md"), []byte("---\nname: beta\ndescription: b\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mount, err = EnsureRoleSkills(9, "角色", []string{src2}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mount.SkillPaths) != 1 || mount.SkillNames[0] != "beta" {
		t.Fatalf("源恢复后应重新挂载: %+v", mount)
	}
}

func TestEnsureRoleSkillsRebuildsMissingLinkAndClearsBrokenFlag(t *testing.T) {
	src := writeSkill(t, "gamma", "g")
	roleDir := filepath.Join(t.TempDir(), ".role-agents", "12")
	if _, err := EnsureRoleSkills(12, "角色", []string{src}, roleDir); err != nil {
		t.Fatal(err)
	}
	// 模拟对账把条目标为 broken（源曾被删），随后源恢复：
	// 链接本身也被删除（断裂），EnsureRoleSkills 应重建并清除 broken。
	manifestPath := filepath.Join(roleDir, roleMountManifestName)
	b, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var m roleMountManifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	m.Entries[0].Broken = true
	if err := writeJSONAtomic(manifestPath, m); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(roleDir, ".agents", "skills", "gamma")); err != nil {
		t.Fatal(err)
	}
	mount, err := EnsureRoleSkills(12, "角色", []string{src}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mount.SkillPaths) != 1 {
		t.Fatalf("broken 标志应清除并重新挂载: %+v", mount)
	}
	b, _ = os.ReadFile(manifestPath)
	var after roleMountManifest
	_ = json.Unmarshal(b, &after)
	if after.Entries[0].Broken {
		t.Fatal("broken 标志未清除")
	}
}

func TestEnsureRoleSkillsSlugConflictAndInvalidSource(t *testing.T) {
	// 同名不同目录的两个技能（slug 冲突）→ -2 递增，两个都挂载
	srcA := writeSkill(t, "design", "a")
	srcB := filepath.Join(filepath.Dir(srcA), "design!") // slug 同为 design
	if err := os.MkdirAll(srcB, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcB, "SKILL.md"), []byte("---\nname: design\ndescription: b\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	roleDir := filepath.Join(t.TempDir(), ".role-agents", "10")
	mount, err := EnsureRoleSkills(10, "角色", []string{srcA, srcB}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mount.SkillNames) != 2 || mount.SkillNames[0] != "design" || mount.SkillNames[1] != "design-2" {
		t.Fatalf("冲突技能应递增命名: %+v", mount.SkillNames)
	}

	// 无效源：不阻断，剔除 + 告警
	mount, err = EnsureRoleSkills(10, "角色", []string{srcA, filepath.Join(t.TempDir(), "missing")}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(mount.SkillPaths) != 1 {
		t.Fatalf("无效源应被剔除: %+v", mount.SkillPaths)
	}
	if len(mount.Warnings) == 0 || !strings.Contains(mount.Warnings[0], "无法加载") {
		t.Fatalf("应有加载失败告警: %v", mount.Warnings)
	}
}

func TestMountCodexSkillsAndCleanup(t *testing.T) {
	if os.Getenv("HOME") == "" {
		t.Skip("需要 HOME")
	}
	origHome := os.Getenv("HOME")
	origCodexHome, hadCodexHome := os.LookupEnv("CODEX_HOME")
	defer os.Setenv("HOME", origHome)
	defer func() {
		if hadCodexHome {
			os.Setenv("CODEX_HOME", origCodexHome)
		} else {
			os.Unsetenv("CODEX_HOME")
		}
	}()

	src := writeSkill(t, "alpha", "a")
	roleDir := filepath.Join(t.TempDir(), ".role-agents", "11")
	mount, err := EnsureRoleSkills(11, "角色", []string{src}, roleDir)
	if err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(t.TempDir(), "run", "role-skills.json")

	t.Run("CODEX_HOME 优先", func(t *testing.T) {
		codexHome := t.TempDir()
		t.Setenv("HOME", t.TempDir())
		t.Setenv("CODEX_HOME", codexHome)
		if err := MountCodexSkills(42, mount, manifest); err != nil {
			t.Fatal(err)
		}
		userRoot := filepath.Join(codexHome, "skills")
		entries, err := os.ReadDir(userRoot)
		if err != nil || len(entries) != 1 {
			t.Fatalf("codex 挂载点应落在 $CODEX_HOME/skills: %v %v", entries, err)
		}
		if !strings.HasPrefix(entries[0].Name(), "paihuo-42-1-") {
			t.Fatalf("挂载名应为 paihuo-<taskID>-<n>-<slug>: %s", entries[0].Name())
		}
		link := filepath.Join(userRoot, entries[0].Name())
		if fi, _ := os.Lstat(link); fi.Mode()&os.ModeSymlink == 0 {
			t.Fatal("codex 挂载应为 symlink")
		}
		if got, err := filepath.EvalSymlinks(link); err != nil || filepath.Clean(got) != filepath.Clean(src) {
			t.Fatalf("两级 symlink 应解析到技能库: %q %v", got, err)
		}
		if err := cleanupRoleSkills(manifest); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Lstat(link); !os.IsNotExist(err) {
			t.Fatalf("结算后 codex 挂载点应被删除: %v", err)
		}
	})

	t.Run("无 CODEX_HOME 优先 ~/.codex/skills", func(t *testing.T) {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("HOME", home)
		t.Setenv("CODEX_HOME", "")
		if err := MountCodexSkills(43, mount, manifest); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(home, ".codex", "skills", "paihuo-43-1-alpha")
		if fi, _ := os.Lstat(link); fi.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("应挂到 ~/.codex/skills（codex 默认配置目录）: %v", fi)
		}
		if err := cleanupRoleSkills(manifest); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("无 ~/.codex 兜底 $HOME/.agents/skills", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("CODEX_HOME", "")
		if err := MountCodexSkills(45, mount, manifest); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(home, ".agents", "skills", "paihuo-45-1-alpha")
		if fi, _ := os.Lstat(link); fi.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("应回退到 $HOME/.agents/skills: %v", fi)
		}
		if err := cleanupRoleSkills(manifest); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("不删用户自己的技能", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("CODEX_HOME", "")
		userRoot := filepath.Join(home, ".agents", "skills")
		own := filepath.Join(userRoot, "my-own-skill")
		if err := os.MkdirAll(own, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := MountCodexSkills(44, mount, manifest); err != nil {
			t.Fatal(err)
		}
		if err := cleanupRoleSkills(manifest); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(own); err != nil {
			t.Fatalf("用户自己的技能不能被误删: %v", err)
		}
	})
}

func TestPrepareRoleSkillsStandalone(t *testing.T) {
	src := writeSkill(t, "design", "design workflow")
	workdir := t.TempDir()

	for _, cli := range []string{"pi", "omp", "opencode", "claude", "codex"} {
		t.Run(cli, func(t *testing.T) {
			mount, cleanup, err := PrepareRoleSkillsStandalone(workdir, cli, []string{src})
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			if len(mount.SkillPaths) != 1 || mount.SkillPaths[0] != filepath.Join(workdir, ".agents", "skills", "design") {
				t.Fatalf("standalone 挂载错误: %+v", mount.SkillPaths)
			}
			if fi, _ := os.Lstat(mount.SkillPaths[0]); fi.Mode()&os.ModeSymlink == 0 {
				t.Fatal("合规技能应为 symlink")
			}
			switch cli {
			case "omp":
				if mount.OmpOverlay == "" {
					t.Fatal("omp 需要 overlay")
				}
			case "opencode":
				if mount.OpencodeConfig == "" {
					t.Fatal("opencode 需要 env 配置")
				}
			case "claude":
				if mount.ClaudePlugin != workdir {
					t.Fatal("claude 需要 plugin-dir")
				}
				if _, err := os.Stat(filepath.Join(workdir, ".claude-plugin", "plugin.json")); err != nil {
					t.Fatalf("claude 插件清单缺失: %v", err)
				}
			}
		})
	}
}

func TestCleanupLegacyTaskSkillCopies(t *testing.T) {
	root := t.TempDir()
	wt := filepath.Join(root, "proj", "task-1")
	legacy := filepath.Join(wt, ".agents", "skills", "paihuo-1-1-alpha")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	claude := filepath.Join(wt, ".claude", "skills", "paihuo-1-2-beta")
	if err := os.MkdirAll(claude, 0o755); err != nil {
		t.Fatal(err)
	}
	user := filepath.Join(wt, ".claude", "skills", "my-skill")
	if err := os.MkdirAll(user, 0o755); err != nil {
		t.Fatal(err)
	}
	// 角色目录不应被扫描
	role := filepath.Join(root, ".role-agents", "3", ".agents", "skills", "keep")
	if err := os.MkdirAll(role, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := CleanupLegacyTaskSkillCopies(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("旧副本应被清理: %v", err)
	}
	if _, err := os.Stat(claude); !os.IsNotExist(err) {
		t.Fatalf("claude 旧副本应被清理: %v", err)
	}
	if _, err := os.Stat(user); err != nil {
		t.Fatalf("用户技能不能被误删: %v", err)
	}
	if _, err := os.Stat(role); err != nil {
		t.Fatalf("角色目录不能被扫描清理: %v", err)
	}
	// .agents 全空 → 回收；.claude/skills 还有用户技能 → 保留
	if _, err := os.Stat(filepath.Join(wt, ".agents")); !os.IsNotExist(err) {
		t.Fatal("空的 .agents 应被回收")
	}
	if _, err := os.Stat(filepath.Join(wt, ".claude", "skills")); err != nil {
		t.Fatalf("含用户技能的目录不能被回收: %v", err)
	}
}

func TestMoveRoleAgentDirToStale(t *testing.T) {
	roleRoot := t.TempDir()
	roleDir := filepath.Join(roleRoot, "5")
	if err := os.MkdirAll(filepath.Join(roleDir, ".agents", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(roleRoot, ".stale")
	if err := MoveRoleAgentDirToStale(roleDir, stale); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(roleDir); !os.IsNotExist(err) {
		t.Fatal("原目录应被移走")
	}
	entries, err := os.ReadDir(stale)
	if err != nil || len(entries) != 1 {
		t.Fatalf("暂存区应有一份: %v %v", entries, err)
	}
	if err := MoveRoleAgentDirToStale(roleDir, stale); err != nil {
		t.Fatalf("重复移动应视为成功: %v", err)
	}
	if err := ReapStaleRoleDirs(stale, 0); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(stale); len(entries) != 0 {
		t.Fatalf("retention=0 应全部清理: %v", entries)
	}
}
