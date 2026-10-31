package exec

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
	"paihuo/internal/skillfs"
)

// RuntimeSkill is a native skill observation, independent of PaiHuo's imported
// skill library and a Role's selected mounts. Enabled is unknown when a runtime
// cannot expose its effective loading policy without starting an agent.
type RuntimeSkill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Scope       string `json:"scope"`
	Source      string `json:"source"`
	Enabled     *bool  `json:"enabled"`
}

type RuntimeSkillInventory struct {
	RuntimeID string         `json:"runtime_id"`
	Cwd       string         `json:"cwd"`
	Skills    []RuntimeSkill `json:"skills"`
	Complete  bool           `json:"complete"`
	Warnings  []string       `json:"warnings"`
}

func (s *RuntimeService) Skills(ctx context.Context, id, cwd string) (RuntimeSkillInventory, error) {
	if !s.Has(id) {
		return RuntimeSkillInventory{}, fmt.Errorf("未知 Runtime: %s", id)
	}
	project := cwd != ""
	if !project {
		cwd, _ = os.UserHomeDir()
	}
	cwd, err := filepath.Abs(cwd)
	if err != nil {
		return RuntimeSkillInventory{}, fmt.Errorf("无法确定项目目录")
	}
	collector := skillCollector{ctx: ctx, seen: map[string]bool{}, inventory: RuntimeSkillInventory{
		RuntimeID: id, Cwd: cwd, Skills: []RuntimeSkill{}, Warnings: []string{}, Complete: true,
	}}
	switch id {
	case "claude":
		collector.claudeSkills(cwd, project)
	case "codex":
		if skills, complete, err := codexSkillCatalog(ctx, cwd); err == nil {
			collector.inventory.Skills = skills
			if !complete {
				collector.warn("Codex 原生目录报告部分技能读取失败")
			}
		} else {
			collector.warn("Codex 原生目录不可用，显示本地文件；启用状态未知")
			if project {
				for _, dir := range projectAncestors(cwd) {
					collector.root(filepath.Join(dir, ".agents", "skills"), "project", "项目技能", nil)
				}
			}
			collector.root(filepath.Join(runtimeConfigDir("CODEX_HOME", ".codex"), "skills"), "user", "Codex 用户技能", nil)
			home, _ := os.UserHomeDir()
			collector.root(filepath.Join(home, ".agents", "skills"), "user", "共享用户技能", nil)
			collector.root("/etc/codex/skills", "admin", "管理员技能", nil)
		}
	case "pi":
		collector.piSkills(cwd, project)
		if skills, err := piSkillCatalog(ctx, cwd); err == nil {
			byPath := map[string]int{}
			for i := range collector.inventory.Skills {
				byPath[collector.inventory.Skills[i].Path] = i
				collector.inventory.Skills[i].Enabled = boolPointer(false)
			}
			for _, skill := range skills {
				if canonical, err := filepath.EvalSymlinks(skill.Path); err == nil {
					skill.Path = canonical
				}
				if i, ok := byPath[skill.Path]; ok {
					collector.inventory.Skills[i] = skill
				} else {
					byPath[skill.Path] = len(collector.inventory.Skills)
					collector.inventory.Skills = append(collector.inventory.Skills, skill)
				}
			}
		} else {
			collector.warn("Pi 原生目录不可用，按本地设置盘点；加载状态未经 CLI 确认")
		}
	case "dsh":
		collector.dshSkills(cwd, project)
	default:
		collector.warn("该 Runtime 尚未提供技能目录检测")
	}
	sort.Slice(collector.inventory.Skills, func(i, j int) bool {
		a, b := collector.inventory.Skills[i], collector.inventory.Skills[j]
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.Path < b.Path
	})
	return collector.inventory, nil
}

type skillCollector struct {
	ctx       context.Context
	seen      map[string]bool
	inventory RuntimeSkillInventory
}

func (c *skillCollector) warn(message string) {
	c.inventory.Complete = false
	c.inventory.Warnings = append(c.inventory.Warnings, message)
}

func (c *skillCollector) root(root, scope, source string, enabled *bool) {
	flat := c.inventory.RuntimeID == "pi" || c.inventory.RuntimeID == "dsh"
	sharedPi := c.inventory.RuntimeID == "pi" && filepath.Base(filepath.Dir(root)) == ".agents"
	files, err := skillfs.Discover(c.ctx, root, skillfs.Options{RootMarkdown: flat && !sharedPi, NestedMarkdown: sharedPi, StopAtSkill: true})
	if err != nil {
		c.warn("部分技能目录无法完整读取：" + root)
	}
	for _, path := range files {
		c.file(path, scope, source, enabled)
	}
}

func (c *skillCollector) file(path, scope, source string, enabled *bool) {
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		c.warn("技能文件无法读取：" + path)
		return
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil || c.seen[canonical] {
		return
	}
	raw, err := os.ReadFile(canonical)
	if err != nil {
		c.warn("技能文件无法读取：" + path)
		return
	}
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	var metadata struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if strings.HasPrefix(text, "---\n") {
		end := strings.Index("\n"+text[4:], "\n---")
		if end < 0 || yaml.Unmarshal([]byte(text[4:4+end]), &metadata) != nil {
			c.warn("技能元数据格式无效：" + path)
			return
		}
	}
	if metadata.Name == "" {
		metadata.Name = filepath.Base(filepath.Dir(canonical))
		if filepath.Base(canonical) != "SKILL.md" {
			metadata.Name = strings.TrimSuffix(filepath.Base(canonical), filepath.Ext(canonical))
		}
	}
	c.seen[canonical] = true
	c.inventory.Skills = append(c.inventory.Skills, RuntimeSkill{Name: metadata.Name, Description: metadata.Description,
		Path: canonical, Scope: scope, Source: source, Enabled: enabled})
}

// Projects may have nested skill roots; stop at their repository boundary.
func projectAncestors(cwd string) []string {
	var out []string
	for dir := cwd; ; dir = filepath.Dir(dir) {
		out = append(out, dir)
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			break
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	return out
}
