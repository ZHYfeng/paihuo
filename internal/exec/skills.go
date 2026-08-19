package exec

// 本文件把角色配置中的技能目录变成一次任务真正可见的技能。
//
// 每个角色在 <sessionsRoot>/.roles/<roleID>/ 下
// 拥有一个只读技能视图：.agents/skills/<name> 默认是到技能库目录的 symlink
// （frontmatter 不合规的技能回退为副本+改写 name），claude 用 skills/ 镜像 +
// .claude-plugin/plugin.json，omp 用 overlay.yml，opencode 用 OPENCODE_CONFIG_CONTENT。
// 角色目录位于所有 worktree / 用户项目目录之外，结构性消灭 git 提交污染与
// 目录污染；EnsureRoleSkills 幂等对账，崩溃/重启后自动重建。
//
// codex 无法从命令行加载任意技能目录（官方仅 REPO/USER scope），因此任务级
// 把 <roleDir>/.agents/skills/<name> 以 symlink 挂到 $HOME/.agents/skills/paihuo-*，
// 清单放在任务 tmux 运行目录，任务结算时删除（与旧副本机制同一套 manifest）。
//
// 角色工作台使用隔离的临时 workspace；正式任务统一使用角色级挂载视图。

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

const roleSkillsManifestVersion = 1

// roleMountManifestVersion 是角色级技能挂载清单（<roleDir>/manifest.json）的版本。
const roleMountManifestVersion = 1

const roleMountManifestName = "manifest.json"

// RoleSkillMount 描述一个角色的技能挂载视图，适配器据此选择各 CLI 的
// 原生挂载方式（pi --skill 逐目录 / omp overlay / opencode env / claude
// plugin-dir / codex $HOME 任务级 symlink）。
type RoleSkillMount struct {
	RoleDir        string             // <sessionsRoot>/.roles/<roleID>
	SkillNames     []string           // 挂载的技能名（即目录名）
	SkillPaths     []string           // .agents/skills/<name> 完整路径（pi --skill 用）
	SkillsRoot     string             // .agents/skills 目录（omp/opencode 用）
	ClaudePlugin   string             // claude --plugin-dir 用（RoleDir 本身）
	OmpOverlay     string             // overlay.yml 路径（omp --config 用）
	OpencodeConfig string             // OPENCODE_CONFIG_CONTENT JSON 串
	Bindings       []roleSkillBinding // system prompt 展示用
	Warnings       []string           // 对账发现的非致命问题（缺技能/断裂/回退）
}

// roleMountEntry 是角色挂载清单中的一条技能。
type roleMountEntry struct {
	Name   string `json:"name"`             // 挂载目录名（slug，冲突时 -2 递增）
	Target string `json:"target"`           // 源技能目录（绝对路径）
	Kind   string `json:"kind"`             // symlink | copy
	Broken bool   `json:"broken,omitempty"` // 源目录已失效，从挂载集合剔除
}

// roleMountManifest 记录角色目录当前挂载的技能集合，供幂等对账。
type roleMountManifest struct {
	Version int              `json:"version"`
	RoleID  int64            `json:"role_id"`
	Entries []roleMountEntry `json:"entries"`
}

type roleSkillBinding struct {
	OriginalName string
	NativeName   string
	Dir          string
}

type preparedRoleSkills struct {
	Bindings   []roleSkillBinding
	SkillDirs  []string
	SkillNames []string
}

type roleSkillsManifest struct {
	Version int      `json:"version"`
	TaskID  int64    `json:"task_id"`
	Paths   []string `json:"paths"`
	Roots   []string `json:"roots"`
}

// PrepareRoleSkillsForWorkspace 供角色创建工作台等短生命周期执行场景复用
// 正式任务的技能物化逻辑。调用方负责提供位于 workspace 内的清单路径，
// 返回的 cleanup 应在命令结束后调用；它不会触碰 workspace 外的源技能目录。
func PrepareRoleSkillsForWorkspace(workspaceDir, cli, manifestPath string, taskID int64, selected []string) (skillDirs, skillNames []string, cleanup func(), err error) {
	prepared, err := prepareRoleSkills(taskID, workspaceDir, cli, manifestPath, selected)
	if err != nil {
		return nil, nil, func() {}, err
	}
	return prepared.SkillDirs, prepared.SkillNames, func() { _ = cleanupRoleSkills(manifestPath) }, nil
}

// prepareRoleSkills 将选中的技能复制到 CLI 原生的项目技能目录。每个任务
// 使用带 task id 的唯一目录名，避免并发任务互相覆盖；SKILL.md 的 name
// 同步改成该目录名，以满足 OpenCode 的目录/name 一致性要求。
func prepareRoleSkills(taskID int64, workspaceDir, cli, manifestPath string, selected []string) (preparedRoleSkills, error) {
	selected = uniqueNonEmpty(selected)
	if len(selected) == 0 {
		return preparedRoleSkills{}, nil
	}
	rootRel, ok := nativeSkillRoot(cli)
	if !ok {
		return preparedRoleSkills{}, fmt.Errorf("CLI %s 没有可用的原生技能目录", cli)
	}
	if workspaceDir == "" {
		return preparedRoleSkills{}, fmt.Errorf("技能工作空间为空")
	}

	root := filepath.Join(workspaceDir, filepath.FromSlash(rootRel))
	if hasSymlinkComponent(root, workspaceDir) {
		return preparedRoleSkills{}, fmt.Errorf("CLI 原生技能目录包含软链接，拒绝写入工作空间之外: %s", root)
	}
	rootExisted := false
	if fi, err := os.Stat(root); err == nil {
		if !fi.IsDir() {
			return preparedRoleSkills{}, fmt.Errorf("技能目录不是文件夹: %s", root)
		}
		rootExisted = true
	} else if !os.IsNotExist(err) {
		return preparedRoleSkills{}, fmt.Errorf("读取技能目录失败: %w", err)
	}
	newRoots := newlyCreatedParents(root, workspaceDir)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return preparedRoleSkills{}, fmt.Errorf("创建技能目录失败: %w", err)
	}

	manifest := roleSkillsManifest{Version: roleSkillsManifestVersion, TaskID: taskID}
	if !rootExisted {
		manifest.Roots = append(manifest.Roots, newRoots...)
	}
	prepared := preparedRoleSkills{}
	cleanupOnError := func() {
		_ = cleanupRoleSkillsManifest(manifestPath, manifest)
	}

	for i, raw := range selected {
		src, err := resolveSkillSource(raw)
		if err != nil {
			cleanupOnError()
			return preparedRoleSkills{}, fmt.Errorf("技能 %q 无法加载: %w", raw, err)
		}
		originalName := skillName(filepath.Join(src, "SKILL.md"))
		if originalName == "" {
			originalName = filepath.Base(src)
		}
		nativeName := generatedSkillName(taskID, i, originalName)
		dst := filepath.Join(root, nativeName)
		if _, err := os.Stat(dst); err == nil {
			cleanupOnError()
			return preparedRoleSkills{}, fmt.Errorf("技能目录冲突: %s", dst)
		} else if !os.IsNotExist(err) {
			cleanupOnError()
			return preparedRoleSkills{}, fmt.Errorf("检查技能目录失败: %w", err)
		}
		// 先把目标路径写入清单，再复制内容。这样即使服务在复制中途
		// 退出，恢复流程也能删除不完整的副本。
		manifest.Paths = append(manifest.Paths, dst)
		if err := writeRoleSkillsManifest(manifestPath, manifest); err != nil {
			cleanupOnError()
			return preparedRoleSkills{}, err
		}
		if err := copySkillDir(src, dst, nativeName); err != nil {
			cleanupOnError()
			return preparedRoleSkills{}, fmt.Errorf("复制技能 %q 失败: %w", originalName, err)
		}
		binding := roleSkillBinding{OriginalName: originalName, NativeName: nativeName, Dir: dst}
		prepared.Bindings = append(prepared.Bindings, binding)
		prepared.SkillDirs = append(prepared.SkillDirs, dst)
		prepared.SkillNames = append(prepared.SkillNames, nativeName)
	}

	return prepared, nil
}

func newlyCreatedParents(path, workspaceDir string) []string {
	workspaceDir = filepath.Clean(workspaceDir)
	path = filepath.Clean(path)
	var missing []string
	for current := path; current != workspaceDir && current != "." && current != string(filepath.Separator); current = filepath.Dir(current) {
		if _, err := os.Stat(current); err == nil {
			break
		} else if !os.IsNotExist(err) {
			break
		}
		missing = append(missing, current)
	}
	return missing
}

func hasSymlinkComponent(path, workspaceDir string) bool {
	workspaceDir = filepath.Clean(workspaceDir)
	path = filepath.Clean(path)
	rel, err := filepath.Rel(workspaceDir, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	current := workspaceDir
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return false
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return true
		}
	}
	return false
}

func nativeSkillRoot(cli string) (string, bool) {
	switch cli {
	case "omp", "codex", "pi", "dsh":
		// .agents/skills 是 Role Skills/Codex/OMP/DSH 共同支持的项目根目录。
		return ".agents/skills", true
	case "claude":
		return ".claude/skills", true
	case "opencode":
		return ".opencode/skills", true
	default:
		return "", false
	}
}

func resolveSkillSource(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("目录路径为空")
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	// 拒绝包含 ".." 的路径：规范化后的绝对路径里出现 ".." 只能来自目录名
	// 伪装，阻断路径穿越（同时是 code-scanning path-injection 的净化点）。
	if strings.Contains(abs, "..") {
		return "", fmt.Errorf("非法技能路径（不允许包含 ..）: %s", abs)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !fi.IsDir() {
		return "", fmt.Errorf("不是目录")
	}
	skillmd := filepath.Join(resolved, "SKILL.md")
	info, err := os.Stat(skillmd)
	if err != nil {
		return "", fmt.Errorf("缺少 SKILL.md")
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("SKILL.md 不是普通文件")
	}
	return filepath.Clean(resolved), nil
}

func copySkillDir(src, dst, nativeName string) error {
	return filepath.WalkDir(src, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("不允许技能目录内包含软链接: %s", path)
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("不支持特殊文件: %s", path)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if rel == "SKILL.md" {
			content = rewriteSkillName(content, nativeName)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, content, info.Mode().Perm())
	})
}

func writeRoleSkillsManifest(path string, manifest roleSkillsManifest) error {
	if path == "" {
		return fmt.Errorf("技能清单路径为空")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("创建技能清单目录失败: %w", err)
	}
	b, err := json.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("编码技能清单失败: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return fmt.Errorf("写入技能清单失败: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("保存技能清单失败: %w", err)
	}
	return nil
}

// cleanupRoleSkills 删除本次任务准备的技能副本。manifestPath 不存在时视为
// 没有技能；清理失败只返回错误，不会阻止任务结算。
func cleanupRoleSkills(manifestPath string) error {
	data, err := os.ReadFile(manifestPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var manifest roleSkillsManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return fmt.Errorf("解析技能清单失败: %w", err)
	}
	return cleanupRoleSkillsManifest(manifestPath, manifest)
}

func cleanupRoleSkillsManifest(manifestPath string, manifest roleSkillsManifest) error {
	var firstErr error
	for i := len(manifest.Paths) - 1; i >= 0; i-- {
		if !strings.HasPrefix(filepath.Base(manifest.Paths[i]), "paihuo-") {
			if firstErr == nil {
				firstErr = fmt.Errorf("技能清单包含非 PaiHuo 路径: %s", manifest.Paths[i])
			}
			continue
		}
		if err := os.RemoveAll(manifest.Paths[i]); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	// 只删除由本次任务新建且已变空的根目录，不碰项目原有技能目录。
	roots := append([]string(nil), manifest.Roots...)
	sort.Slice(roots, func(i, j int) bool { return len(roots[i]) > len(roots[j]) })
	for _, root := range roots {
		base := filepath.Base(root)
		parent := filepath.Base(filepath.Dir(root))
		validNativeRoot := base == "skills" && (parent == ".agents" || parent == ".claude" || parent == ".opencode")
		validNativeParent := base == ".agents" || base == ".claude" || base == ".opencode"
		if !validNativeRoot && !validNativeParent {
			if firstErr == nil {
				firstErr = fmt.Errorf("技能清单包含非原生目录: %s", root)
			}
			continue
		}
		entries, err := os.ReadDir(root)
		if err == nil && len(entries) == 0 {
			if err := os.Remove(root); err != nil && !os.IsNotExist(err) && firstErr == nil {
				firstErr = err
			}
		} else if err != nil && !os.IsNotExist(err) && firstErr == nil {
			firstErr = err
		}
	}
	if err := os.Remove(manifestPath); err != nil && !os.IsNotExist(err) && firstErr == nil {
		firstErr = err
	}
	_ = os.Remove(manifestPath + ".tmp")
	return firstErr
}

// ---------------------------------------------------------------------------
// 角色级技能挂载（新机制）

// EnsureRoleSkills 幂等地构建/对账一个角色的技能挂载目录。selected 是角色
// 配置中的源技能目录绝对路径列表（RoleConfig.Skills）。返回的 RoleSkillMount
// 供适配器使用；损坏/失效的技能会被剔除并在 Warnings 中说明，不阻断任务。
// 角色目录位于 <roleDir>（sessionsRoot/.roles/<roleID>），永远不在
// git worktree 或用户项目目录内。
func EnsureRoleSkills(roleID int64, roleName string, selected []string, roleDir string) (*RoleSkillMount, error) {
	mount := &RoleSkillMount{RoleDir: roleDir}
	if roleDir == "" {
		return nil, fmt.Errorf("角色技能目录为空")
	}
	selected = uniqueNonEmpty(selected)
	if len(selected) == 0 {
		// 角色没有技能：只清理历史残留，不创建目录结构，不写空 overlay。
		if err := reconcileRoleMountEntries(roleID, roleDir, nil, mount); err != nil {
			return nil, err
		}
		return mount, nil
	}
	roleSkills := filepath.Join(roleDir, ".agents", "skills")
	claudeSkills := filepath.Join(roleDir, "skills")
	pluginDir := filepath.Join(roleDir, ".claude-plugin")
	for _, dir := range []string{roleSkills, claudeSkills, pluginDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("创建角色技能目录失败: %w", err)
		}
	}

	if err := reconcileRoleMountEntries(roleID, roleDir, selected, mount); err != nil {
		return nil, err
	}
	if len(mount.SkillPaths) == 0 {
		// 角色当前没有可挂载技能：清掉旧的 overlay/插件包装，避免空配置残留。
		_ = os.Remove(filepath.Join(roleDir, "overlay.yml"))
		_ = os.RemoveAll(filepath.Join(roleDir, ".claude-plugin"))
		_ = os.RemoveAll(filepath.Join(roleDir, "skills"))
		return mount, nil
	}

	overlayPath := filepath.Join(roleDir, "overlay.yml")
	if err := writeOmpOverlay(overlayPath, ompOverlayDirs(roleDir)); err != nil {
		return nil, fmt.Errorf("生成 omp overlay 失败: %w", err)
	}
	mount.OmpOverlay = overlayPath

	cfg, err := opencodeSkillsConfigJSON(mount.SkillPaths)
	if err != nil {
		return nil, fmt.Errorf("生成 opencode 技能配置失败: %w", err)
	}
	mount.OpencodeConfig = cfg

	pluginPath := filepath.Join(pluginDir, "plugin.json")
	if err := writeClaudePluginJSON(pluginPath, fmt.Sprintf("paihuo-role-%d", roleID), roleName); err != nil {
		return nil, fmt.Errorf("生成 claude 插件清单失败: %w", err)
	}
	mount.ClaudePlugin = roleDir
	mount.SkillsRoot = roleSkills
	return mount, nil
}

// reconcileRoleMountEntries 把角色目录的磁盘状态与 selected 对齐：
// 新增 → 挂 symlink（或回退副本）；移除 → 删除条目与 claude 镜像；
// 已存在且目标一致 → 跳过（保留 mtime）；symlink 目标失效 → 标记 broken
// 并从挂载集合剔除（源恢复后自动重新挂载）。
func reconcileRoleMountEntries(roleID int64, roleDir string, selected []string, mount *RoleSkillMount) error {
	roleSkills := filepath.Join(roleDir, ".agents", "skills")
	manifestPath := filepath.Join(roleDir, roleMountManifestName)
	manifest, manifestExists, err := loadRoleMountManifest(manifestPath)
	if err != nil {
		return err
	}

	// 期望集合：先校验源，再定名（slug + 冲突递增），再定形态。
	var desired []roleMountEntry
	used := make(map[string]bool, len(selected))
	for _, raw := range selected {
		src, err := resolveSkillSource(raw)
		if err != nil {
			mount.Warnings = append(mount.Warnings, fmt.Sprintf("技能 %q 无法加载，已跳过: %v", raw, err))
			continue
		}
		name := uniqueSkillSlug(slugSkillName(filepath.Base(src)), used)
		used[name] = true
		kind := "symlink"
		if ok, reason := validateSkillFrontmatter(src, name); !ok {
			kind = "copy"
			mount.Warnings = append(mount.Warnings, fmt.Sprintf("技能 %q 的 SKILL.md %s；已回退为副本并改写 name", name, reason))
		}
		if _, desc, _ := parseSkillFrontmatter(filepath.Join(src, "SKILL.md")); strings.TrimSpace(desc) == "" {
			mount.Warnings = append(mount.Warnings, fmt.Sprintf("技能 %q 缺少 frontmatter description，omp 下不可见；请在技能库补充", name))
		}
		desired = append(desired, roleMountEntry{Name: name, Target: src, Kind: kind})
	}

	existing := make(map[string]roleMountEntry, len(manifest.Entries))
	for _, e := range manifest.Entries {
		existing[e.Name] = e
	}
	want := make(map[string]bool, len(desired))
	for _, d := range desired {
		want[d.Name] = true
	}

	changed := !manifestExists
	for name := range existing {
		if !want[name] {
			removeRoleMountEntry(roleDir, name)
			delete(existing, name)
			changed = true
		}
	}

	for _, d := range desired {
		p := filepath.Join(roleSkills, d.Name)
		prev, had := existing[d.Name]
		if had && prev.Target == d.Target && prev.Kind == d.Kind {
			// 已挂载且目标一致：校验 symlink 完整性后直接复用。
			if d.Kind == "symlink" {
				if _, err := os.Stat(p); err != nil {
					// 角色目录内的链接缺失/断裂（源本身仍可用）：重建。
					_ = os.Remove(p)
					if serr := os.Symlink(d.Target, p); serr != nil {
						return fmt.Errorf("重建技能 %q 链接失败: %w", d.Name, serr)
					}
					if prev.Broken {
						prev.Broken = false
						changed = true
					}
				} else if prev.Broken {
					prev.Broken = false
					changed = true
				}
				existing[d.Name] = prev
			}
			mount.addEntry(prev, roleDir)
			continue
		}
		// 新建或形态/目标变化：删除旧的再重建。
		if had {
			removeRoleMountEntry(roleDir, d.Name)
		}
		switch d.Kind {
		case "symlink":
			if err := os.Symlink(d.Target, p); err != nil {
				return fmt.Errorf("挂载技能 %q 失败: %w", d.Name, err)
			}
		default:
			if err := copySkillDir(d.Target, p, d.Name); err != nil {
				return fmt.Errorf("复制技能 %q 失败: %w", d.Name, err)
			}
		}
		mirror := filepath.Join(roleDir, "skills", d.Name)
		_ = os.Remove(mirror)
		// 相对目标从 skills/ 解析：../.agents/skills/<name>
		if err := os.Symlink(filepath.Join("..", ".agents", "skills", d.Name), mirror); err != nil {
			return fmt.Errorf("创建 claude 技能镜像失败: %w", err)
		}
		mount.addEntry(d, roleDir)
		changed = true
	}

	if changed {
		manifest = roleMountManifest{Version: roleMountManifestVersion, RoleID: roleID, Entries: make([]roleMountEntry, 0, len(desired))}
		for _, d := range desired {
			entry := d
			if prev, ok := existing[d.Name]; ok {
				entry.Broken = prev.Broken
			}
			manifest.Entries = append(manifest.Entries, entry)
		}
		if err := writeJSONAtomic(manifestPath, manifest); err != nil {
			return fmt.Errorf("保存角色技能清单失败: %w", err)
		}
	}
	return nil
}

func (m *RoleSkillMount) addEntry(e roleMountEntry, roleDir string) {
	// 提示词显示挂载 slug：与所有 CLI 的可见名一致。
	// - symlink 形态：frontmatter name 合规即 == slug（codex 按 frontmatter 显示）；
	// - copy 形态：SKILL.md name 已被改写为 slug，各 CLI（含 codex）都显示 slug。
	m.SkillNames = append(m.SkillNames, e.Name)
	m.SkillPaths = append(m.SkillPaths, filepath.Join(roleDir, ".agents", "skills", e.Name))
	m.Bindings = append(m.Bindings, roleSkillBinding{
		OriginalName: e.Name, NativeName: e.Name, Dir: filepath.Join(roleDir, ".agents", "skills", e.Name),
	})
}

func loadRoleMountManifest(path string) (roleMountManifest, bool, error) {
	var manifest roleMountManifest
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return manifest, false, nil
	}
	if err != nil {
		return manifest, false, fmt.Errorf("读取角色技能清单失败: %w", err)
	}
	if err := json.Unmarshal(b, &manifest); err != nil {
		return manifest, false, fmt.Errorf("解析角色技能清单失败: %w", err)
	}
	if manifest.Version != roleMountManifestVersion {
		return manifest, false, fmt.Errorf("角色技能清单版本 %d 不受支持", manifest.Version)
	}
	return manifest, true, nil
}

func removeRoleMountEntry(roleDir, name string) {
	for _, root := range []string{filepath.Join(roleDir, ".agents", "skills"), filepath.Join(roleDir, "skills")} {
		_ = os.RemoveAll(filepath.Join(root, name))
	}
}

// validateSkillFrontmatter 预检技能 frontmatter name 是否与挂载目录名一致且
// 合法（kebab-case、≤64 字符）。opencode 要求目录名=name，不满足时调用方
// 回退为副本并改写 name。
func validateSkillFrontmatter(dir, mountName string) (ok bool, reason string) {
	name, _, _ := parseSkillFrontmatter(filepath.Join(dir, "SKILL.md"))
	if name == "" {
		return false, "缺少 frontmatter name"
	}
	if name != mountName {
		return false, fmt.Sprintf("frontmatter name %q 与挂载目录名 %q 不一致", name, mountName)
	}
	if len(name) > 64 || slugSkillName(name) != name {
		return false, "frontmatter name 不是合法 kebab-case（≤64 字符）"
	}
	return true, ""
}

// uniqueSkillSlug 保证同一角色内目录名唯一：同名冲突时按 -2、-3 递增。
func uniqueSkillSlug(slug string, used map[string]bool) string {
	if slug == "" {
		slug = "skill"
	}
	name := slug
	for i := 2; used[name]; i++ {
		name = fmt.Sprintf("%s-%d", slug, i)
	}
	return name
}

// writeOmpOverlay 生成 omp --config overlay：skills.customDirectories 限定为
// 角色技能目录（customDirs 已含 global 合并结果，global 在前、角色目录在后）。
// omp 的数组键是整体替换语义，因此必须在生成时合并用户全局配置。
func writeOmpOverlay(path string, customDirs []string) error {
	var b strings.Builder
	b.WriteString("skills:\n  customDirectories:\n")
	for _, dir := range customDirs {
		fmt.Fprintf(&b, "    - %s\n", yamlQuote(dir))
	}
	return writeJSONAtomic(path, []byte(b.String()))
}

// ompOverlayDirs 读取用户全局 ~/.omp/agent/config.yml 的 skills.customDirectories
// 并与角色技能目录合并（global 在前）。解析失败降级为只含角色目录。
func ompOverlayDirs(roleDir string) []string {
	dirs := []string{}
	home, err := os.UserHomeDir()
	if err == nil {
		globalPath := filepath.Join(home, ".omp", "agent", "config.yml")
		if global, gerr := readOmpCustomDirectories(globalPath); gerr == nil && len(global) > 0 {
			dirs = append(dirs, global...)
		} else if gerr != nil && !os.IsNotExist(gerr) {
			log.Printf("⚠ 读取 omp 全局技能目录失败（overlay 将只含角色技能）: %v", gerr)
		}
	}
	return uniqueNonEmpty(append(dirs, filepath.Join(roleDir, ".agents", "skills")))
}

// readOmpCustomDirectories 用最简解析读取 YAML 里的
// skills:
//
//	customDirectories:
//	  - /path
//
// 结构（含内联列表）。解析失败返回错误，调用方降级处理。
func readOmpCustomDirectories(path string) ([]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	var out []string
	inBlock := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		key, rest, has := strings.Cut(trimmed, ":")
		if has && strings.TrimSpace(key) == "customDirectories" {
			rest = strings.TrimSpace(rest)
			if rest != "" {
				out = append(out, parseYAMLInlineList(rest)...)
			} else {
				inBlock = true
			}
			continue
		}
		if inBlock {
			if !strings.HasPrefix(trimmed, "-") {
				inBlock = false
				continue
			}
			item := strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
			item = strings.Trim(item, `"'`)
			if item != "" {
				out = append(out, item)
			}
		}
	}
	return out, nil
}

func parseYAMLInlineList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		raw = strings.TrimSpace(raw[1 : len(raw)-1])
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		item := strings.Trim(strings.TrimSpace(part), `"'`)
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

func yamlQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// opencodeSkillsConfigJSON 生成 OPENCODE_CONFIG_CONTENT 的 JSON：
// {"skills":{"paths":[...]}}。
func opencodeSkillsConfigJSON(paths []string) (string, error) {
	v := map[string]any{"skills": map[string]any{"paths": paths}}
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func writeClaudePluginJSON(path, pluginName, description string) error {
	v := map[string]string{
		"name":        pluginName,
		"version":     "1.0.0",
		"description": description,
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return writeJSONAtomic(path, append(b, '\n'))
}

// writeJSONAtomic 原子写一个 JSON（或文本）文件。
func writeJSONAtomic(path string, v any) error {
	var b []byte
	var err error
	switch t := v.(type) {
	case []byte:
		b = t
	default:
		b, err = json.Marshal(v)
		if err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// codexSkillsRoot 返回 codex 的 USER scope 技能目录，按优先级：
//  1. $CODEX_HOME/skills（显式设置时）；
//  2. ~/.codex/skills（codex 的 CODEX_HOME 默认配置目录）；
//  3. $HOME/.agents/skills（官方文档 USER scope 兜底）。
//
// 前两个位置只被 codex 扫描，不会混入 pi/omp 等其它 CLI 的上下文。
func codexSkillsRoot() (string, error) {
	if home := strings.TrimSpace(os.Getenv("CODEX_HOME")); home != "" {
		return filepath.Join(home, "skills"), nil
	}
	userHome, err := os.UserHomeDir()
	if err != nil || userHome == "" {
		return "", fmt.Errorf("无法确定用户主目录（%v），不能挂载 codex 技能", err)
	}
	codexHome := filepath.Join(userHome, ".codex")
	if fi, err := os.Stat(codexHome); err == nil && fi.IsDir() {
		return filepath.Join(codexHome, "skills"), nil
	}
	return filepath.Join(userHome, ".agents", "skills"), nil
}

// MountCodexSkills 把角色技能视图以 symlink 挂到 codex 的 USER scope 技能
// 目录（$CODEX_HOME/skills，回退 $HOME/.agents/skills；官方支持 symlink），
// 供 codex 原生发现。挂载名 paihuo-<taskID>-<n>-<slug> 与旧副本命名一致；
// 清单先写后建链，任务结算时由 cleanupRoleSkills 按清单删除。
func MountCodexSkills(taskID int64, mount *RoleSkillMount, manifestPath string) error {
	if mount == nil || len(mount.SkillPaths) == 0 {
		return nil
	}
	userRoot, err := codexSkillsRoot()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(userRoot, 0o755); err != nil {
		return fmt.Errorf("创建 codex 技能挂载目录 %s 失败（请确认 CODEX_HOME/HOME 可写）: %w", userRoot, err)
	}
	manifest := roleSkillsManifest{Version: roleSkillsManifestVersion, TaskID: taskID}
	for i, path := range mount.SkillPaths {
		if _, err := resolveSkillSource(path); err != nil {
			return fmt.Errorf("技能 %q 无法加载: %w", path, err)
		}
		name := generatedSkillName(taskID, i, filepath.Base(path))
		dst := filepath.Join(userRoot, name)
		manifest.Paths = append(manifest.Paths, dst)
		if err := writeRoleSkillsManifest(manifestPath, manifest); err != nil {
			return err
		}
		_ = os.Remove(dst) // 续跑/崩溃残留的旧链
		if err := os.Symlink(path, dst); err != nil {
			return fmt.Errorf("挂载 codex 技能 %q 失败: %w", name, err)
		}
	}
	return nil
}

// PrepareRoleSkillsStandalone 供角色工作台等短生命周期场景使用：在临时目录内
// 按各 CLI 语义准备技能（symlink/副本回退 + frontmatter 预检与正式任务一致），
// 不建角色目录。返回的 mount 直接传给 adapter.Build，cleanup 在命令结束后调用。
func PrepareRoleSkillsStandalone(workdir, cli string, selected []string) (*RoleSkillMount, func(), error) {
	mount := &RoleSkillMount{RoleDir: workdir}
	noop := func() {}
	selected = uniqueNonEmpty(selected)
	if len(selected) == 0 {
		return mount, noop, nil
	}
	roleSkills := filepath.Join(workdir, ".agents", "skills")
	if err := os.MkdirAll(roleSkills, 0o755); err != nil {
		return nil, noop, fmt.Errorf("创建技能目录失败: %w", err)
	}
	cleanup := func() {
		for _, p := range []string{
			filepath.Join(workdir, ".agents"), filepath.Join(workdir, "skills"),
			filepath.Join(workdir, ".claude-plugin"), filepath.Join(workdir, "overlay.yml"),
		} {
			_ = os.RemoveAll(p)
		}
	}
	used := make(map[string]bool, len(selected))
	for _, raw := range selected {
		src, err := resolveSkillSource(raw)
		if err != nil {
			cleanup()
			return nil, noop, fmt.Errorf("技能 %q 无法加载: %w", raw, err)
		}
		name := uniqueSkillSlug(slugSkillName(filepath.Base(src)), used)
		used[name] = true
		p := filepath.Join(roleSkills, name)
		if ok, _ := validateSkillFrontmatter(src, name); ok {
			if err := os.Symlink(src, p); err != nil {
				cleanup()
				return nil, noop, fmt.Errorf("挂载技能 %q 失败: %w", name, err)
			}
		} else if err := copySkillDir(src, p, name); err != nil {
			cleanup()
			return nil, noop, fmt.Errorf("复制技能 %q 失败: %w", name, err)
		}
		mount.SkillNames = append(mount.SkillNames, name)
		mount.SkillPaths = append(mount.SkillPaths, p)
		mount.Bindings = append(mount.Bindings, roleSkillBinding{OriginalName: name, NativeName: name, Dir: p})
	}
	mount.SkillsRoot = roleSkills
	switch cli {
	case "omp":
		overlay := filepath.Join(workdir, "overlay.yml")
		if err := writeOmpOverlay(overlay, []string{roleSkills}); err != nil {
			cleanup()
			return nil, noop, fmt.Errorf("生成 omp overlay 失败: %w", err)
		}
		mount.OmpOverlay = overlay
	case "opencode":
		cfg, err := opencodeSkillsConfigJSON(mount.SkillPaths)
		if err != nil {
			cleanup()
			return nil, noop, fmt.Errorf("生成 opencode 技能配置失败: %w", err)
		}
		mount.OpencodeConfig = cfg
	case "claude":
		pluginDir := filepath.Join(workdir, ".claude-plugin")
		if err := os.MkdirAll(pluginDir, 0o755); err != nil {
			cleanup()
			return nil, noop, fmt.Errorf("创建 claude 插件目录失败: %w", err)
		}
		if err := writeClaudePluginJSON(filepath.Join(pluginDir, "plugin.json"), "paihuo-role-studio", "role-studio"); err != nil {
			cleanup()
			return nil, noop, fmt.Errorf("生成 claude 插件清单失败: %w", err)
		}
		claudeSkills := filepath.Join(workdir, "skills")
		if err := os.MkdirAll(claudeSkills, 0o755); err != nil {
			cleanup()
			return nil, noop, fmt.Errorf("创建 claude 技能目录失败: %w", err)
		}
		for _, name := range mount.SkillNames {
			// 相对目标从 workdir/skills/ 解析：../.agents/skills/<name>
			if err := os.Symlink(filepath.Join("..", ".agents", "skills", name), filepath.Join(claudeSkills, name)); err != nil {
				cleanup()
				return nil, noop, fmt.Errorf("创建 claude 技能镜像失败: %w", err)
			}
		}
		mount.ClaudePlugin = workdir
	}
	return mount, cleanup, nil
}

func buildRoleSkillsPrompt(bindings []roleSkillBinding) string {
	if len(bindings) == 0 {
		return ""
	}
	names := make([]string, 0, len(bindings))
	for _, binding := range bindings {
		name := strings.TrimSpace(binding.OriginalName)
		if name == "" {
			name = strings.TrimSpace(binding.NativeName)
		}
		names = append(names, name)
	}
	names = uniqueNonEmpty(names)
	if len(names) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("当前角色拥有以下技能：")
	for _, name := range names {
		fmt.Fprintf(&b, "\n- %s", name)
	}
	return b.String()
}

func skillBasenames(paths []string) []string {
	out := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		name := strings.TrimSpace(filepath.Base(filepath.Clean(path)))
		if name == "" || name == "." || name == string(filepath.Separator) {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}

func uniqueNonEmpty(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func skillName(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return ""
	}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			break
		}
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok || strings.TrimSpace(key) != "name" {
			continue
		}
		return strings.Trim(strings.TrimSpace(value), `"'`)
	}
	return ""
}

// parseSkillFrontmatter 解析 SKILL.md 头部 YAML frontmatter 的 name / description。
// 解析失败或没有 frontmatter 时返回空，由调用方用目录名兜底。
func parseSkillFrontmatter(path string) (name, desc string, tags []string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	text := string(b)
	if !strings.HasPrefix(text, "---") {
		return
	}
	rest := text[3:]
	end := strings.Index(rest, "---")
	if end < 0 {
		return
	}
	frontmatter := strings.Split(rest[:end], "\n")
	readingTags := false
	for _, line := range frontmatter {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			if readingTags && strings.HasPrefix(strings.TrimSpace(line), "-") {
				tags = append(tags, strings.Trim(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "-")), `"'`))
			}
			continue
		}
		readingTags = false
		switch strings.TrimSpace(k) {
		case "name":
			name = strings.Trim(strings.TrimSpace(v), `"'`)
		case "description":
			desc = strings.Trim(strings.TrimSpace(v), `"'`)
		case "tags":
			tags = parseSkillTagsValue(v)
			readingTags = strings.TrimSpace(v) == ""
		}
	}
	return
}

func parseSkillTagsValue(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "[]" {
		return []string{}
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		raw = strings.TrimSpace(raw[1 : len(raw)-1])
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '，' })
	if len(parts) == 0 {
		parts = []string{raw}
	}
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), `"'`)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func generatedSkillName(taskID int64, index int, original string) string {
	slug := slugSkillName(original)
	prefix := fmt.Sprintf("paihuo-%d-%d-", taskID, index+1)
	maxSlug := 64 - len(prefix)
	if maxSlug < 1 {
		maxSlug = 1
	}
	if len(slug) > maxSlug {
		slug = strings.Trim(slug[:maxSlug], "-")
	}
	if slug == "" {
		slug = "skill"
	}
	return prefix + slug
}

func slugSkillName(raw string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(raw) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			// Native Role Skills names are ASCII kebab-case. Non-ASCII names
			// use a stable generic slug rather than producing invalid metadata.
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
			continue
		}
		if b.Len() > 0 && !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func rewriteSkillName(content []byte, name string) []byte {
	text := strings.ReplaceAll(string(content), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		end := -1
		for i := 1; i < len(lines); i++ {
			if strings.TrimSpace(lines[i]) == "---" {
				end = i
				break
			}
		}
		if end >= 0 {
			for i := 1; i < end; i++ {
				key, _, ok := strings.Cut(strings.TrimSpace(lines[i]), ":")
				if ok && strings.TrimSpace(key) == "name" {
					indent := lines[i][:len(lines[i])-len(strings.TrimLeft(lines[i], " \t"))]
					lines[i] = indent + "name: " + name
					return []byte(strings.Join(lines, "\n"))
				}
			}
			out := make([]string, 0, len(lines)+1)
			out = append(out, lines[0], "name: "+name)
			out = append(out, lines[1:]...)
			return []byte(strings.Join(out, "\n"))
		}
	}
	return []byte("---\nname: " + name + "\ndescription: PaiHuo role-selected skill\n---\n\n" + text)
}
