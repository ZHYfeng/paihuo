package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"paihuo/internal/store"
)

// skillSourceDir 将用户输入标准化为绝对目录，并校验目录存在。解析软链可以
// 保证同一目录从不同软链路径扫描时仍能正确去重。
func skillSourceDir(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("需要技能目录路径")
	}
	src, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	src = filepath.Clean(src)
	// 规范化后的绝对路径仍含 ".." 说明目录名包含伪装的穿越成分，直接拒绝；
	// 该守卫同时是 code-scanning path-injection 的净化点，阻断后续所有
	// 基于 src 的文件系统操作被用户输入污染。
	if strings.Contains(src, "..") {
		return "", fmt.Errorf("非法技能目录路径（不允许包含 ..）")
	}
	fi, err := os.Stat(src)
	if err != nil || !fi.IsDir() {
		return "", fmt.Errorf("目录不存在")
	}
	if resolved, err := filepath.EvalSymlinks(src); err == nil {
		src = resolved
	}
	return filepath.Clean(src), nil
}

// discoverSkillDirs 返回 root 下每个直接包含 SKILL.md 的目录。它不会跟随
// 目录软链，既避免循环，也避免意外扫描到根目录之外；s.skillsDir 则永远
// 跳过，防止把 paihuo 已复制的技能再次导入。
func discoverSkillDirs(root, skillsDir string) ([]string, error) {
	dirs := make([]string, 0)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if isPathWithin(path, skillsDir) {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() == "SKILL.md" {
			dirs = append(dirs, filepath.Dir(path))
		}
		return nil
	})
	return dirs, err
}

// isPathWithin 判断 path 是否等于 dir 或位于 dir 之下。调用者可以传入相对
// 路径（默认数据库路径会产生相对的 skillsDir），函数会先按当前工作目录展开。
func isPathWithin(path, dir string) bool {
	if dir == "" {
		return false
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(absDir), filepath.Clean(absPath))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// importSkillWithTags 把 frontmatter 中的标签与本次导入附加的标签合并，
// 这样扫描导入既能保留技能自带的元数据，也能一次给一批技能打上业务标签。
func (s *Server) importSkillWithTags(src string, extraTags []string) (store.Skill, error) {
	if isPathWithin(src, s.skillsDir) {
		return store.Skill{}, fmt.Errorf("不能导入 paihuo 管理的技能库目录")
	}
	skillmd := filepath.Join(src, "SKILL.md")
	fi, err := os.Stat(skillmd)
	if err != nil || fi.IsDir() {
		return store.Skill{}, fmt.Errorf("该目录没有 SKILL.md，不是技能")
	}
	name, desc, tags, category := parseSkillFrontmatter(skillmd)
	tags = append(tags, extraTags...)
	if name == "" {
		name = filepath.Base(src)
	}
	if category == "" {
		// 从源目录的父文件夹名推断分类：从按目录组织的技能库扫描导入时，
		// 同一父目录下的技能自动归入同一文件夹。
		category = filepath.Base(filepath.Dir(filepath.Clean(src)))
	}
	if err := os.MkdirAll(s.skillsDir, 0o755); err != nil {
		return store.Skill{}, err
	}
	// 目标目录：slug 化名称，冲突则追加序号。
	slug := skillSlug(name)
	dst := filepath.Join(s.skillsDir, slug)
	for n := 2; ; n++ {
		_, err := os.Stat(dst)
		if os.IsNotExist(err) {
			break
		}
		if err != nil {
			return store.Skill{}, err
		}
		dst = filepath.Join(s.skillsDir, fmt.Sprintf("%s-%d", slug, n))
	}
	if err := copyDir(src, dst, s.skillsDir); err != nil {
		return store.Skill{}, fmt.Errorf("复制技能目录失败: %w", err)
	}
	id, err := s.st.CreateSkill(store.Skill{
		Name: name, Description: desc, Category: category, Tags: tags, Dir: dst, SourcePath: src,
	})
	if err != nil {
		_ = os.RemoveAll(dst)
		return store.Skill{}, err
	}
	sk, err := s.st.GetSkill(id)
	if err != nil {
		return store.Skill{}, err
	}
	return *sk, nil
}

// parseSkillFrontmatter 解析 SKILL.md 头部 YAML frontmatter 的 name / description / tags。
// 解析失败或没有 frontmatter 时返回空，由调用方用目录名兜底。
func parseSkillFrontmatter(path string) (name, desc string, tags []string, category string) {
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
			// 兼容最常见的多行 YAML 标签：
			// tags:\n  - coding\n  - review
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
		case "category":
			category = strings.Trim(strings.TrimSpace(v), `"'`)
		case "tags":
			tags = parseSkillTagsValue(v)
			// Inline tags are complete on this line. For a YAML list, the
			// following indented dash items are picked up above.
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
	tags := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), `"'`)
		if part != "" {
			tags = append(tags, part)
		}
	}
	return tags
}

func skillSlug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else if r == ' ' || r == '_' || r == '-' || r == '.' {
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "skill"
	}
	return out
}

// copyDir 递归复制目录（技能可能含子文件/脚本）。skipDirs 内的目录不会
// 被复制；导入的目标技能库位于源目录内时，这能避免递归复制自己。
func copyDir(src, dst string, skipDirs ...string) error {
	return filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.IsDir() {
			for _, skip := range skipDirs {
				if isPathWithin(p, skip) {
					return filepath.SkipDir
				}
			}
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if fi.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, fi.Mode().Perm())
	})
}
