package exec

// 本文件把角色配置中的技能目录变成一次任务真正可见的技能：
//   1. 复制到当前 CLI 的原生项目技能目录；
//   2. 用 CLI 支持的参数（OMP/Pi）选择这些副本；
//   3. 在任务提示中简要列出当前角色拥有的技能。
//
// 副本放在任务 worktree 的 CLI 原生目录，清单放在任务 tmux 运行目录，
// 不会把清单写进 Git。任务结算前会删除副本；服务重启时清单保留，恢复
// 接管后再清理。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

const roleSkillsManifestVersion = 1

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
	case "omp", "codex", "pi":
		// .agents/skills 是 Agent Skills/Codex/OMP 共同支持的项目根目录。
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
			// Native Agent Skills names are ASCII kebab-case. Non-ASCII names
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
