package exec

import (
	"os"
	"os/exec"
	"path/filepath"

	"go.yaml.in/yaml/v3"
)

func (c *skillCollector) dshSkills(cwd string, project bool) {
	home := runtimeConfigDir("DSH_HOME", ".dsh")
	agents := runtimeConfigDir("DSH_AGENTS_HOME", ".agents")
	if project {
		dirs := projectAncestors(cwd)
		root := dirs[len(dirs)-1]
		// DSH uses the repository root, or cwd when it is not in a repository.
		if _, err := os.Stat(filepath.Join(root, ".git")); err != nil {
			root = cwd
		}
		c.root(filepath.Join(root, ".dsh", "skills"), "project", "DSH 项目技能", nil)
		c.root(filepath.Join(root, ".agents", "skills"), "project", "项目共享技能", nil)
	}
	c.root(filepath.Join(home, "skills"), "user", "DSH 用户技能", nil)
	c.root(filepath.Join(agents, "skills"), "user", "共享用户技能", nil)
	if bundled := os.Getenv("DSH_BUNDLED_SKILL_DIR"); bundled != "" {
		c.root(bundled, "preset", "当前预设技能", nil)
	}
	c.dshPresets(filepath.Join(home, ".agent-presets"))
	if binary, err := exec.LookPath("dsh"); err == nil {
		if real, err := filepath.EvalSymlinks(binary); err == nil {
			c.dshPresets(filepath.Join(filepath.Dir(filepath.Dir(real)), "config", "agent-presets"))
		}
	}
	configs := []string{filepath.Join(home, "cordis.patch.yml"), filepath.Join(home, "settings.yaml")}
	profiles, _ := filepath.Glob(filepath.Join(home, "profiles", "*", "cordis.patch.yml"))
	configs = append(configs, profiles...)
	for _, path := range configs {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var document any
		if yaml.Unmarshal(raw, &document) != nil {
			c.warn("DSH 配置无法解析：" + path)
			continue
		}
		c.dshCustomRoots(document, cwd)
	}
	c.warn("DSH 列表按本地目录和已安装预设盘点；实际加载取决于会话所选预设和配置")
}

func (c *skillCollector) dshPresets(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		path := filepath.Join(root, entry.Name())
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			c.root(filepath.Join(path, "skills"), "preset", entry.Name(), nil)
		}
	}
}

func (c *skillCollector) dshCustomRoots(document any, cwd string) {
	switch node := document.(type) {
	case map[string]any:
		if roots, ok := node["customSkillDirs"].([]any); ok {
			for _, root := range roots {
				if path, ok := root.(string); ok {
					if !filepath.IsAbs(path) {
						path = filepath.Join(cwd, path)
					}
					c.root(path, "custom", "DSH 自定义目录", nil)
				}
			}
		}
		for _, value := range node {
			c.dshCustomRoots(value, cwd)
		}
	case []any:
		for _, value := range node {
			c.dshCustomRoots(value, cwd)
		}
	}
}
