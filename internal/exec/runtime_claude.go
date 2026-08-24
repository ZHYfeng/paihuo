package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"paihuo/internal/store"
)

// ---------------------------------------------------------------------------
// claude：claude -p "提示词"
// 角色映射：model→--model；system_prompt→--append-system-prompt；
// skills→项目 .claude/skills 原生 discovery。

type claudeAdapter struct{ baseAdapter }

func (a *claudeAdapter) Build(o ExecutionRequest) (string, []string, []string, error) {
	interactive := o.RunMode == store.RunModeInteractive
	args := []string{}
	if !interactive {
		args = append(args, "-p", o.Prompt)
	}
	if m := o.Role.Model; m != "" {
		args = append(args, "--model", m)
	}
	if s := o.Role.SystemPrompt; s != "" {
		args = append(args, "--append-system-prompt", s)
	}
	// 权限映射：custom.permission_mode（schema 提供选项），默认 acceptEdits
	pm := o.Role.Custom["permission_mode"]
	if pm == "" {
		pm = "acceptEdits"
	}
	args = append(args, "--permission-mode", pm)
	if settings := o.Role.Custom["settings"]; settings != "" {
		args = append(args, "--settings", settings)
	}
	if o.SkillMount != nil && o.SkillMount.ClaudePlugin != "" {
		// claude 插件布局：插件顶层 skills/ + .claude-plugin/plugin.json。
		args = append(args, "--plugin-dir", o.SkillMount.ClaudePlugin)
	}
	args = append(args, o.Role.ExtraArgs...)
	if interactive {
		// Claude Code 不带 -p 时启动交互 REPL，位置参数作为初始消息。
		args = append(args, o.Prompt)
	}
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *claudeAdapter) Warnings(o ExecutionRequest) []string {
	var ws []string
	if o.Role.Thinking != "" {
		ws = append(ws, "claude 无思考级别参数，thinking 字段不生效（改用 --model 或 ExtraArgs）")
	}
	if len(o.Role.Plugins) > 0 {
		ws = append(ws, "claude 插件在 CLI 层管理，角色 plugins 字段不生效")
	}
	return ws
}

// claude 特有字段：permission_mode（权限映射）、settings（settings.json 叠加）。
func (a *claudeAdapter) Schema() []Field {
	fs := commonFields()
	if f := byKey(fs, "thinking"); f != nil {
		f.Help = "claude 不支持思考级别参数（schema 保留以提示）"
	}
	return append(fs,
		Field{Key: "permission_mode", Label: "权限模式", Type: "select", Group: "执行",
			Options: []string{"default", "acceptEdits", "plan", "bypassPermissions"},
			Default: "acceptEdits",
			Help:    "default 每次询问；acceptEdits 自动接受文件编辑；plan 只读计划；bypassPermissions 全自动（危险）"},
		Field{Key: "settings", Label: "settings.json", Type: "text", Group: "执行", Source: "files",
			Pattern:     "~/.claude/settings*.json",
			Placeholder: "/path/to/settings.json",
			Help:        "--settings 叠加自定义 settings 文件（hooks、permissions、env 等）；候选来自 ~/.claude"},
	)
}

func (a *claudeAdapter) Docs() string {
	return "https://docs.anthropic.com/en/docs/claude-code/overview"
}

// ---------------------------------------------------------------------------
// claude：Claude Code 没有公开的模型列表命令，模型候选来自它实际会读取的
// 配置和缓存：用户/项目/托管 settings、模型环境变量，以及 ~/.claude.json
// 中的自定义模型选项和最近使用过的真实模型 ID。
//
// 不要把 `[1m]` 后缀拆掉：这是 Claude Code 合法的扩展上下文模型写法；同样
// 不要把 opus/sonnet 等别名改成猜测出来的版本号，别名会由 Claude Code 按
// 当前账号、provider 和 availableModels 自己解析。

func (a *claudeAdapter) Models() []string {
	return cachedModels("claude", func() []string {
		home, _ := os.UserHomeDir()
		cwd, _ := os.Getwd()
		return claudeModelsProbeAt(home, cwd)
	})
}

// claudeSettingsModelKeys 是 Claude Code 会影响模型选择的环境变量。这里既
// 读取当前 paihuo 进程环境，也读取 settings.json 里的 env 对象；后者是
// Claude Code 官方支持的配置方式。
var claudeSettingsModelKeys = []string{
	"ANTHROPIC_MODEL",
	"ANTHROPIC_CUSTOM_MODEL_OPTION",
	"ANTHROPIC_DEFAULT_FABLE_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"CLAUDE_CODE_SUBAGENT_MODEL",
}

// claudeModelAliasesForEnv 表示 family default 环境变量同时改变了哪个
// Claude Code 别名的解析。把别名也放进候选，用户可以直接选择别名或已 pin
// 的 provider/model；两者都由 CLI 原样解释。
var claudeModelAliasesForEnv = map[string]string{
	"ANTHROPIC_DEFAULT_FABLE_MODEL":  "fable",
	"ANTHROPIC_DEFAULT_OPUS_MODEL":   "opus",
	"ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "haiku",
}

// claudeModelsProbeAt 是 Claude 模型发现的可测试实现。home 与 cwd 分开注入，
// 这样测试可以模拟用户目录和项目级 settings，而不会改动真实主机配置。
func claudeModelsProbeAt(home, cwd string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		// inherit 是 CLAUDE_CODE_SUBAGENT_MODEL 的控制值，不是可传给
		// --model 的模型；这些占位值也不应污染模型候选。
		if s == "" || s == "inherit" || s == "default" || s == "<synthetic>" {
			return
		}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}

	addClaudeModelEnv(add)

	// 托管 settings 具有最高优先级。Linux/WSL 的文件位置由 Claude Code
	// 官方约定为 /etc/claude-code；drop-in 按文件名排序，和 CLI 的读取顺序
	// 保持一致。即使当前机器没有这些文件，读取也会静默失败。
	for _, path := range claudeManagedSettingsPaths() {
		readClaudeSettings(path, add)
	}

	// 当前项目的 local 设置覆盖 project 和 user 设置，因此先收集它们。
	for _, path := range claudeProjectSettingsPaths(cwd, home) {
		readClaudeSettings(path, add)
	}

	// 用户 settings 是所有项目的最后一级默认值。
	for _, path := range claudeUserSettingsPaths(home) {
		readClaudeSettings(path, add)
	}

	// ~/.claude.json 保存 Claude Code 的模型选项缓存、组织默认值、每个项目
	// 最近实际使用的 modelUsage，以及自定义缓存槽。它是发现完整模型 ID 的
	// 关键来源；例如 settings 里是 opus[1m] 时，lastModelUsage 可能记录
	// claude-opus-4-8[1m]。
	readClaudeState(filepath.Join(home, ".claude.json"), add)

	return capModels(out, 80)
}

func addClaudeModelEnv(add func(string)) {
	for _, key := range claudeSettingsModelKeys {
		value := os.Getenv(key)
		if value == "" {
			continue
		}
		add(value)
		if alias := claudeModelAliasesForEnv[key]; alias != "" {
			add(alias)
		}
	}
}

func claudeManagedSettingsPaths() []string {
	const dir = "/etc/claude-code"
	paths := []string{filepath.Join(dir, "managed-settings.json")}
	if matches, err := filepath.Glob(filepath.Join(dir, "managed-settings.d", "*.json")); err == nil {
		sort.Strings(matches)
		paths = append(paths, matches...)
	}
	return paths
}

func claudeUserSettingsPaths(home string) []string {
	pattern := filepath.Join(home, ".claude", "settings*.json")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return []string{filepath.Join(home, ".claude", "settings.json")}
	}
	sort.Strings(matches)
	return matches
}

// claudeProjectSettingsPaths 从当前目录向上查找项目 settings。每层 local
// 设置覆盖 project 设置；home 仅用于避免把用户配置重复当作项目设置。
func claudeProjectSettingsPaths(cwd, home string) []string {
	if cwd == "" {
		return nil
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return nil
	}
	homeAbs, _ := filepath.Abs(home)
	var paths []string
	for dir := abs; ; dir = filepath.Dir(dir) {
		if dir != homeAbs {
			// local 覆盖 project，优先读取 local。
			paths = append(paths,
				filepath.Join(dir, ".claude", "settings.local.json"),
				filepath.Join(dir, ".claude", "settings.json"))
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	return paths
}

type claudeSettingsFile struct {
	Model          string            `json:"model"`
	Available      []string          `json:"availableModels"`
	ModelOverrides map[string]string `json:"modelOverrides"`
	Env            map[string]string `json:"env"`
}

func readClaudeSettings(path string, add func(string)) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var cfg claudeSettingsFile
	if json.Unmarshal(b, &cfg) != nil {
		return
	}
	add(cfg.Model)
	for _, model := range cfg.Available {
		add(model)
	}
	if len(cfg.ModelOverrides) > 0 {
		keys := make([]string, 0, len(cfg.ModelOverrides))
		for source := range cfg.ModelOverrides {
			keys = append(keys, source)
		}
		sort.Strings(keys)
		for _, source := range keys {
			add(source)
			add(cfg.ModelOverrides[source])
		}
	}
	for _, key := range claudeSettingsModelKeys {
		if value := cfg.Env[key]; value != "" {
			add(value)
			if alias := claudeModelAliasesForEnv[key]; alias != "" {
				add(alias)
			}
		}
	}
}

type claudeStateProject struct {
	LastModelUsage map[string]json.RawMessage `json:"lastModelUsage"`
}

type claudeStateFile struct {
	Model                  string `json:"model"`
	AdditionalModelOptions []struct {
		Value string `json:"value"`
	} `json:"additionalModelOptionsCache"`
	ModelAccessCache     json.RawMessage `json:"modelAccessCache"`
	OrgModelDefaultCache json.RawMessage `json:"orgModelDefaultCache"`
	ClientDataCacheSlots map[string]struct {
		Model string `json:"model"`
	} `json:"clientDataCacheSlots"`
	Projects map[string]claudeStateProject `json:"projects"`
}

func readClaudeState(path string, add func(string)) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var state claudeStateFile
	if json.Unmarshal(b, &state) != nil {
		return
	}
	add(state.Model)
	for _, option := range state.AdditionalModelOptions {
		add(option.Value)
	}
	addClaudeJSONModelValues(state.ModelAccessCache, add)
	addClaudeJSONModelValues(state.OrgModelDefaultCache, add)
	if len(state.ClientDataCacheSlots) > 0 {
		keys := make([]string, 0, len(state.ClientDataCacheSlots))
		for key := range state.ClientDataCacheSlots {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			add(state.ClientDataCacheSlots[key].Model)
		}
	}
	projectKeys := make([]string, 0, len(state.Projects))
	for key := range state.Projects {
		projectKeys = append(projectKeys, key)
	}
	sort.Strings(projectKeys)
	for _, projectKey := range projectKeys {
		// lastModelUsage 的键就是 Claude Code result message 里的真实 model
		// ID；值只是 token/cost 统计，不需要读取。
		project := state.Projects[projectKey]
		models := make([]string, 0, len(project.LastModelUsage))
		for model := range project.LastModelUsage {
			models = append(models, model)
		}
		sort.Strings(models)
		for _, model := range models {
			add(model)
		}
	}
}

// addClaudeJSONModelValues 兼容 modelAccessCache/orgModelDefaultCache 在不同
// Claude Code 版本中的 string、array、或带 model/value/id 字段的 object 形状。
// 这里只解析一层已知字段，不递归整个 ~/.claude.json，避免把实验开关里的
// 任意字符串错误地当成模型。
func addClaudeJSONModelValues(raw json.RawMessage, add func(string)) {
	if len(raw) == 0 || string(raw) == "null" {
		return
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		add(value)
		return
	}
	var values []json.RawMessage
	if json.Unmarshal(raw, &values) == nil {
		for _, item := range values {
			addClaudeJSONModelValues(item, add)
		}
		return
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return
	}
	for _, key := range []string{"model", "modelId", "model_id", "value", "id"} {
		if item, ok := object[key]; ok {
			var model string
			if json.Unmarshal(item, &model) == nil {
				add(model)
			}
		}
	}
}
