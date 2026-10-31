package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type piSkillSettings struct {
	Skills   []string          `json:"skills"`
	Packages []json.RawMessage `json:"packages"`
}

func (c *skillCollector) piSkills(cwd string, project bool) {
	agent := runtimeConfigDir("PI_CODING_AGENT_DIR", ".pi/agent")
	home, _ := os.UserHomeDir()
	if project {
		c.piScope(filepath.Join(cwd, ".pi"), "project")
		for _, dir := range projectAncestors(cwd) {
			c.root(filepath.Join(dir, ".agents", "skills"), "project", "项目共享技能", boolPointer(true))
		}
	}
	c.piScope(agent, "user")
	c.root(filepath.Join(home, ".agents", "skills"), "user", "用户共享技能", boolPointer(true))
}

func (c *skillCollector) piScope(base, scope string) {
	var settings piSkillSettings
	if raw, err := os.ReadFile(filepath.Join(base, "settings.json")); err == nil {
		if json.Unmarshal(raw, &settings) != nil {
			c.warn("Pi 技能设置格式无效：" + filepath.Join(base, "settings.json"))
		}
	}
	start := len(c.inventory.Skills)
	c.root(filepath.Join(base, "skills"), scope, "Pi 技能目录", boolPointer(true))
	for _, entry := range settings.Skills {
		if strings.HasPrefix(entry, "!") || strings.HasPrefix(entry, "-") {
			continue
		}
		entry = strings.TrimPrefix(entry, "+")
		path := resolvePiSettingsSource(base, entry, true)
		matches, err := filepath.Glob(path)
		if err != nil {
			c.warn("Pi 技能路径模式无效")
			continue
		}
		for _, match := range matches {
			c.skillPath(match, scope, "Pi 自定义技能", boolPointer(true))
		}
	}
	for i := start; i < len(c.inventory.Skills); i++ {
		for _, entry := range settings.Skills {
			if !strings.HasPrefix(entry, "!") && !strings.HasPrefix(entry, "-") {
				continue
			}
			pattern := resolvePiSettingsSource(base, entry[1:], true)
			if skillPatternMatches(pattern, c.inventory.Skills[i].Path) {
				c.inventory.Skills[i].Enabled = boolPointer(false)
			}
		}
	}
	for _, raw := range settings.Packages {
		var pkg struct {
			Source   string   `json:"source"`
			Skills   []string `json:"skills"`
			Autoload *bool    `json:"autoload"`
		}
		var source string
		if json.Unmarshal(raw, &source) == nil {
			pkg.Source = source
		} else if json.Unmarshal(raw, &pkg) != nil {
			c.warn("Pi 包设置格式无效")
			continue
		}
		if strings.TrimSpace(pkg.Source) == "" {
			c.warn("Pi 包设置缺少来源")
			continue
		}
		root := piInstalledPackage(base, pkg.Source, scope)
		if root == "" {
			c.warn("Pi 配置的包尚未找到本地安装目录")
			continue
		}
		var manifest struct {
			Pi *struct {
				Skills []string `json:"skills"`
			} `json:"pi"`
		}
		readJSONFile(filepath.Join(root, "package.json"), &manifest)
		packageStart := len(c.inventory.Skills)
		if manifest.Pi != nil {
			for _, path := range manifest.Pi.Skills {
				if strings.Contains(path, "**") {
					c.warn("部分 Pi 包的未加载技能可能未完整列出")
				}
				matches, _ := filepath.Glob(filepath.Join(root, path))
				for _, match := range matches {
					c.skillPath(match, scope, "Pi 包技能", boolPointer(true))
				}
			}
		} else {
			c.root(filepath.Join(root, "skills"), scope, "Pi 包技能", boolPointer(true))
		}
		if pkg.Skills != nil || pkg.Autoload != nil && !*pkg.Autoload {
			for i := packageStart; i < len(c.inventory.Skills); i++ {
				selected := false
				for _, pattern := range pkg.Skills {
					include := !strings.HasPrefix(pattern, "!") && !strings.HasPrefix(pattern, "-")
					pattern = strings.TrimLeft(pattern, "!+-")
					if skillPatternMatches(filepath.Join(root, pattern), c.inventory.Skills[i].Path) {
						selected = include
					}
				}
				c.inventory.Skills[i].Enabled = boolPointer(selected)
			}
		}
	}
}

func (c *skillCollector) skillPath(path, scope, source string, enabled *bool) {
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	if info.IsDir() {
		c.root(path, scope, source, enabled)
	} else {
		c.file(path, scope, source, enabled)
	}
}

func piInstalledPackage(base, source, scope string) string {
	var candidates []string
	switch {
	case strings.HasPrefix(source, "npm:"):
		name := strings.TrimPrefix(source, "npm:")
		if i := strings.LastIndex(name, "@"); i > 0 {
			name = name[:i]
		}
		candidates = append(candidates, filepath.Join(base, "npm", "node_modules", name))
		if scope == "user" {
			if root, ok := cliOutput(2*time.Second, "npm", "root", "-g"); ok {
				candidates = append(candidates, filepath.Join(strings.TrimSpace(root), name))
			}
		}
	case strings.HasPrefix(source, "git:") || strings.Contains(source, "://"):
		path := strings.TrimPrefix(source, "git:")
		path = strings.TrimPrefix(strings.TrimPrefix(path, "https://"), "http://")
		if i := strings.LastIndex(path, "@"); i > strings.LastIndex(path, "/") {
			path = path[:i]
		}
		path = strings.TrimSuffix(path, ".git")
		candidates = append(candidates, filepath.Join(base, "git", path))
	default:
		candidates = append(candidates, resolvePiSettingsSource(base, source, true))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

func skillPatternMatches(pattern, path string) bool {
	for _, candidate := range []string{path, filepath.Dir(path)} {
		if pattern == candidate {
			return true
		}
		if matchSkillGlob(strings.Split(filepath.ToSlash(pattern), "/"), strings.Split(filepath.ToSlash(candidate), "/")) {
			return true
		}
	}
	return false
}

func matchSkillGlob(pattern, path []string) bool {
	if len(pattern) == 0 {
		return len(path) == 0
	}
	if pattern[0] == "**" {
		return matchSkillGlob(pattern[1:], path) || len(path) > 0 && matchSkillGlob(pattern, path[1:])
	}
	if len(path) == 0 {
		return false
	}
	match, _ := filepath.Match(pattern[0], path[0])
	return match && matchSkillGlob(pattern[1:], path[1:])
}

func boolPointer(value bool) *bool { return &value }
