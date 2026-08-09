// 深度定制：每个 CLI 适配器按官方文档声明自己的配置字段 schema。
// 前端据此为不同 agent 渲染完全不同的配置表单（而不是统一的几个字段），
// 从而实现「多 agent 多高度自定义角色」。
package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"paihuo/internal/store"
)

// Field 描述某个 CLI 适配器支持的一个配置参数（提炼自该 CLI 的官方文档）。
type Field struct {
	Key         string   `json:"key"` // role_config 内置字段名，或 Custom 中的参数名
	Label       string   `json:"label"`
	Type        string   `json:"type"`                  // text | textarea | select | list | env
	Builtin     bool     `json:"builtin"`               // true=直落 RoleConfig 顶层字段；false=存入 Custom
	Options     []string `json:"options,omitempty"`     // select 的严格选项
	Suggestions []string `json:"suggestions,omitempty"` // 候选列表（可自定义，前端 datalist / 多选）
	// ThinkingOptionsByModel 是主机发现的“模型 ID → 可用思考档位”。只有 CLI
	// 明确报告该能力时才填充，避免把某个 CLI 的全局 flag 枚举伪装成模型能力。
	ThinkingOptionsByModel map[string][]string `json:"thinking_options_by_model,omitempty"`
	Source                 string              `json:"source,omitempty"`  // skills | extensions | files | dirs：服务端扫描后填入 Suggestions
	Pattern                string              `json:"pattern,omitempty"` // Source=files 时的 glob（支持 ~ 展开）
	Default                string              `json:"default,omitempty"`
	Placeholder            string              `json:"placeholder,omitempty"`
	Help                   string              `json:"help,omitempty"`
	Group                  string              `json:"group"` // 表单分组标题
}

// builtinKeys 从 RoleConfig 结构体的 JSON 字段反射派生（custom 除外）：
// schema 中 key 命中该集合的字段直落 role_config 顶层，其余进 Custom。
// 前端按字段的 builtin 标记决定读写位置——在 Go 里新增/删除角色创建选项
// （RoleConfig 字段或适配器 schema 字段）时，创建弹窗与角色页面配置表单
// 自动同步，无需再改前端硬编码清单。
var builtinKeys = func() map[string]bool {
	m := map[string]bool{}
	t := reflect.TypeOf(store.RoleConfig{})
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("json")
		if tag == "" || strings.HasPrefix(tag, "-") {
			continue
		}
		if name := strings.Split(tag, ",")[0]; name != "custom" {
			m[name] = true
		}
	}
	return m
}()

// listFiles 按 glob 展开文件候选（支持 ~ 前缀）。
func listFiles(pattern string) []string {
	if pattern == "" {
		return nil
	}
	if pattern == "~" || strings.HasPrefix(pattern, "~/ ") {
		pattern = pattern[1:]
	}
	if strings.HasPrefix(pattern, "~") {
		home, _ := os.UserHomeDir()
		pattern = filepath.Join(home, pattern[2:])
	}
	ms, err := filepath.Glob(pattern)
	if err != nil {
		return nil
	}
	sort.Strings(ms)
	if len(ms) > 100 {
		ms = ms[:100]
	}
	return ms
}

// Enrich 为带 Source 的字段填充动态 Suggestions（配置文件、Pi 扩展包等），
// 并标记 builtin 归属（RoleConfig 顶层 vs Custom）。技能候选由前端从
// /api/skills（注册到 paihuo 工作目录的技能库）拉取。
func Enrich(fs []Field) []Field {
	for i := range fs {
		f := &fs[i]
		f.Builtin = builtinKeys[f.Key]
		if f.Source == "files" {
			f.Suggestions = listFiles(f.Pattern)
		} else if f.Source == "extensions" {
			f.Suggestions = piExtensionSources()
			// 旧 Pi 角色没有 custom.extensions，运行时仍会自动发现全部
			// 全局扩展。表单默认全选当前安装项，避免仅打开并保存角色就
			// 把既有行为意外改成“禁用全部”。
			f.Default = strings.Join(f.Suggestions, ",")
		}
	}
	return fs
}

// piExtensionSources 读取 pi 官方用户设置中的包来源与直接扩展路径，供角色
// 创建器按包勾选。使用设置文件而不是解析 `pi list` 的人类可读输出，既避免
// 每次打开角色页都启动一个 CLI，也能保留 npm:/git:/本地路径原值，直接传给
// 官方可重复的 --extension 参数。
func piExtensionSources() []string {
	agentDir := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR"))
	if agentDir == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return nil
		}
		agentDir = filepath.Join(home, ".pi", "agent")
	}
	b, err := os.ReadFile(filepath.Join(agentDir, "settings.json"))
	if err != nil {
		return nil
	}
	var settings struct {
		Packages   []json.RawMessage `json:"packages"`
		Extensions []string          `json:"extensions"`
	}
	if err := json.Unmarshal(b, &settings); err != nil {
		return nil
	}
	seen := make(map[string]bool, len(settings.Packages)+len(settings.Extensions))
	out := make([]string, 0, len(settings.Packages)+len(settings.Extensions))
	add := func(source string) {
		source = strings.TrimSpace(source)
		if source == "" || seen[source] {
			return
		}
		seen[source] = true
		out = append(out, source)
	}
	for _, raw := range settings.Packages {
		var source string
		if err := json.Unmarshal(raw, &source); err == nil {
			add(resolvePiSettingsSource(agentDir, source, false))
			continue
		}
		var filtered struct {
			Source string `json:"source"`
		}
		if err := json.Unmarshal(raw, &filtered); err == nil {
			add(resolvePiSettingsSource(agentDir, filtered.Source, false))
		}
	}
	for _, source := range settings.Extensions {
		source = strings.TrimSpace(source)
		if strings.HasPrefix(source, "!") || strings.HasPrefix(source, "-") {
			continue
		}
		source = strings.TrimPrefix(source, "+")
		resolved := resolvePiSettingsSource(agentDir, source, true)
		if strings.ContainsAny(resolved, "*?[") {
			if matches, err := filepath.Glob(resolved); err == nil && len(matches) > 0 {
				for _, match := range matches {
					add(match)
				}
				continue
			}
		}
		add(resolved)
	}
	return out
}

// resolvePiSettingsSource 把 Pi 用户设置中相对 agentDir 的本地路径转为绝对
// 路径；npm:/git:/URL 与 npm 裸包名保持原样，交由 --extension 官方解析器处理。
func resolvePiSettingsSource(agentDir, source string, forcePath bool) string {
	source = strings.TrimSpace(source)
	if source == "" {
		return ""
	}
	if strings.HasPrefix(source, "~/") {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			return filepath.Join(home, source[2:])
		}
	}
	local := forcePath || filepath.IsAbs(source) || source == "." || source == ".." ||
		strings.HasPrefix(source, "./") || strings.HasPrefix(source, "../")
	if local && !filepath.IsAbs(source) {
		return filepath.Clean(filepath.Join(agentDir, source))
	}
	return source
}

// Schema 返回该 CLI 支持的配置字段定义；Docs 返回官方文档链接。
// 两者由 Adapter 接口暴露，前端 /api/agents/schema 一次性拉取。
func (a *baseAdapter) Schema() []Field { return commonFields() }
func (a *baseAdapter) Docs() string    { return "" }

// commonFields 是所有 CLI 通用（内置）字段的默认 schema。
// 各适配器可裁剪不支持的字段、追加自己特有的字段（存于 RoleConfig.Custom）。
func commonFields() []Field {
	return []Field{
		{Key: "model", Label: "模型", Type: "text", Group: "模型与指令",
			Placeholder: "留空用 CLI 默认（探测本机实例实际配置）",
			Help:        "覆盖默认模型；候选取自该 CLI 在本机实例的实际配置，也可直接输入"},
		{Key: "system_prompt", Label: "系统提示词", Type: "textarea", Group: "模型与指令",
			Placeholder: "角色定位、行为规范",
			Help:        "追加到 CLI 默认系统提示词之后，用于定义角色身份"},
		{Key: "instructions", Label: "指令", Type: "textarea", Group: "模型与指令",
			Placeholder: "任务指令模板：每次执行前固定追加的指示",
			Help:        "与系统提示词不同：这是每次任务的固定指令前缀（如代码规范、输出格式、禁止事项），在任务提示词之前注入"},
		{Key: "thinking", Label: "思考级别", Type: "select", Group: "模型与指令",
			Options: []string{"", "low", "medium", "high"},
			Help:    "low 更快更省、high 深度推理；medium 为默认"},
		{Key: "skills", Label: "技能", Type: "list", Group: "技能", Source: "skills",
			Placeholder: "勾选已注册到 paihuo 工作目录的技能",
			Help:        "执行器会把角色选择的技能安全复制到本次任务的 CLI 原生技能目录"},
		{Key: "plugins", Label: "插件 / 配置叠加", Type: "list", Group: "技能",
			Placeholder: "/path/to/plugin, /path/to/config.toml",
			Help:        "逗号分隔的插件或配置叠加文件（--config）"},
		{Key: "extra_args", Label: "额外参数", Type: "text", Group: "执行",
			Placeholder: "--no-lsp --no-session",
			Help:        "原样追加到命令行末尾；此处是逃生舱，schema 未覆盖的官方参数都从这进"},
		{Key: "env", Label: "环境变量", Type: "env", Group: "执行",
			Placeholder: "KEY=VALUE（每行一个）",
			Help:        "注入到该角色的执行环境，覆盖进程已有同名变量"},
	}
}

// byKey 查 schema 中的字段定义。
func byKey(fs []Field, key string) *Field {
	for i := range fs {
		if fs[i].Key == key {
			return &fs[i]
		}
	}
	return nil
}
