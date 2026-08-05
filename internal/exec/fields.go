// 深度定制：每个 CLI 适配器按官方文档声明自己的配置字段 schema。
// 前端据此为不同 agent 渲染完全不同的配置表单（而不是统一的几个字段），
// 从而实现「多 agent 多高度自定义角色」。
package exec

// Field 描述某个 CLI 适配器支持的一个配置参数（提炼自该 CLI 的官方文档）。
type Field struct {
	Key         string   `json:"key"` // role_config 内置字段名，或 Custom 中的参数名
	Label       string   `json:"label"`
	Type        string   `json:"type"` // text | textarea | select | list | env
	Options     []string `json:"options,omitempty"`
	Default     string   `json:"default,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	Help        string   `json:"help,omitempty"`
	Group       string   `json:"group"` // 表单分组标题
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
			Placeholder: "留空用 CLI 默认",
			Help:        "覆盖默认模型（如 gpt-5 / claude-sonnet-4-5 / qwen3-coder）"},
		{Key: "system_prompt", Label: "系统提示词", Type: "textarea", Group: "模型与指令",
			Placeholder: "角色定位、行为规范",
			Help:        "追加到 CLI 默认系统提示词之后，用于定义角色身份"},
		{Key: "thinking", Label: "思考级别", Type: "select", Group: "模型与指令",
			Options: []string{"", "low", "medium", "high"},
			Help:    "low 更快更省、high 深度推理；medium 为默认"},
		{Key: "skills", Label: "技能目录", Type: "list", Group: "技能",
			Placeholder: "/path/to/skills1, /path/to/skills2",
			Help:        "逗号分隔的本地技能目录，启动时注入（--add-dir）"},
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
