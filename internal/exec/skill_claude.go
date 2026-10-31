package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

func (c *skillCollector) claudeSkills(cwd string, project bool) {
	config := runtimeConfigDir("CLAUDE_CONFIG_DIR", ".claude")
	var ancestors []string
	if project {
		ancestors = projectAncestors(cwd)
		for _, dir := range ancestors {
			c.root(filepath.Join(dir, ".claude", "skills"), "project", "项目技能", boolPointer(true))
		}
	}
	c.root(filepath.Join(config, "skills"), "user", "用户技能", boolPointer(true))
	enabled := map[string]bool{}
	readSettings := func(path string) {
		var settings struct {
			Enabled map[string]bool `json:"enabledPlugins"`
		}
		raw, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			return
		}
		if err != nil || json.Unmarshal(raw, &settings) != nil {
			c.warn("Claude 插件启用设置无法读取：" + path)
			return
		}
		for id, value := range settings.Enabled {
			enabled[id] = value
		}
	}
	readSettings(filepath.Join(config, "settings.json"))
	for i := len(ancestors) - 1; i >= 0; i-- {
		for _, name := range []string{"settings.json", "settings.local.json"} {
			readSettings(filepath.Join(ancestors[i], ".claude", name))
		}
	}
	var installed struct {
		Plugins map[string][]struct{ Scope, InstallPath, ProjectPath string } `json:"plugins"`
	}
	path := filepath.Join(config, "plugins", "installed_plugins.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return
	}
	if err != nil || json.Unmarshal(raw, &installed) != nil {
		c.warn("Claude 已安装插件清单无法读取")
		return
	}
	for id, entries := range installed.Plugins {
		for _, entry := range entries {
			if entry.Scope != "user" && entry.Scope != "managed" {
				if !project || entry.ProjectPath == "" || !pathWithin(cwd, entry.ProjectPath) {
					continue
				}
			}
			state, known := enabled[id]
			var active *bool
			if known {
				active = boolPointer(state)
			}
			c.root(filepath.Join(entry.InstallPath, "skills"), "plugin", id, active)
			var manifest struct {
				Skills json.RawMessage `json:"skills"`
			}
			readJSONFile(filepath.Join(entry.InstallPath, ".claude-plugin", "plugin.json"), &manifest)
			var paths []string
			var single string
			if json.Unmarshal(manifest.Skills, &single) == nil {
				paths = []string{single}
			} else {
				_ = json.Unmarshal(manifest.Skills, &paths)
			}
			for _, path := range paths {
				c.root(filepath.Join(entry.InstallPath, path), "plugin", id, active)
			}
		}
	}
}

func pathWithin(path, root string) bool {
	path, _ = filepath.Abs(path)
	root, _ = filepath.Abs(root)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
