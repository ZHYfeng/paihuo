package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"paihuo/internal/store"
)

// ---------------------------------------------------------------------------
// opencode：opencode run --dir <dir> "提示词"
// 角色映射：model→--model；thinking→--variant（模型实际声明的 variant）；
// custom.agent→--agent、custom.config→--config；系统提示词请用 opencode agent 定义。

type openCodeAdapter struct{ baseAdapter }

func (a *openCodeAdapter) Build(o ExecutionRequest) (string, []string, []string, error) {
	args := []string{"run"}
	if o.RunMode == store.RunModeInteractive {
		// run --interactive 保留 run 子命令的 --variant/--dir 等参数，同时
		// 在初始消息完成后继续显示可输入的 split-footer 终端。
		args = append(args, "--interactive")
	}
	args = append(args, "--dir", o.Dir)
	if m := o.Role.Model; m != "" {
		args = append(args, "--model", m)
	}
	if thinking := strings.TrimSpace(o.Role.Thinking); thinking != "" {
		// OpenCode 的 variant 名称是逐模型的，不能把 UI 的 low/high 映射
		// 成另一个固定名称（例如 minimal）；直接传递目录中的真实名称。
		args = append(args, "--variant", thinking)
	}
	if ag := o.Role.Custom["agent"]; ag != "" {
		args = append(args, "--agent", ag)
	}
	args = append(args, o.Role.ExtraArgs...)
	args = append(args, o.Prompt)
	env := mergeEnv(o.Role.Env)
	if o.SkillMount != nil && o.SkillMount.OpencodeConfig != "" {
		// opencode 1.18 无 --config CLI 选项；技能通过内置配置层
		// OPENCODE_CONFIG_CONTENT 注入（绝对路径 skills.paths）。
		env = envWith(env, "OPENCODE_CONFIG_CONTENT", o.SkillMount.OpencodeConfig)
	}
	return a.bin, args, env, nil
}

func (a *openCodeAdapter) Warnings(o ExecutionRequest) []string {
	var ws []string
	if o.Role.SystemPrompt != "" {
		ws = append(ws, "opencode run 不支持 --system-prompt；角色提示词请通过 opencode agent 定义（配置 tab → 额外参数 / agent 字段）")
	}
	if len(o.Role.Plugins) > 0 {
		ws = append(ws, "opencode 插件按项目/全局配置管理，角色 plugins 字段不生效")
	}
	return ws
}

// opencode 的模型/思考字段来自 CLI 文档；skills 走项目内 .opencode/skills
// 原生目录；特有字段 agent 对应 opencode agent 定义。
func (a *openCodeAdapter) Schema() []Field {
	return []Field{
		{Key: "model", Label: "模型", Type: "text", Group: "模型与指令",
			Placeholder: "留空用默认（探测本机实例实际配置）",
			Help:        "--model；候选取自 `opencode models --verbose` 与本机配置"},
		{Key: "thinking", Label: "思考级别", Type: "select", Group: "模型与指令",
			Options: []string{""},
			Help:    "按所选模型从 opencode models --verbose 读取 variants，并原样传给 --variant；模型未声明时不猜测"},
		{Key: "instructions", Label: "指令", Type: "textarea", Group: "模型与指令",
			Placeholder: "任务指令模板：每次执行前固定追加的指示",
			Help:        "每次任务的固定指令前缀，注入到任务提示词之前（opencode 无官方 system prompt 参数，以提示词前缀方式生效）"},
		{Key: "skills", Label: "技能", Type: "list", Group: "技能", Source: "skills",
			Placeholder: "勾选已注册到 paihuo 工作目录的技能",
			Help:        "执行器把所选技能复制到任务 .opencode/skills，由 OpenCode 原生 discovery 加载，并在提示中要求读取"},
		{Key: "agent", Label: "Role 定义", Type: "text", Group: "模型与指令",
			Suggestions: []string{"build", "plan", "architect", "debug", "test", "code-review"},
			Placeholder: "如 build / planner（可输入自定义）",
			Help:        "opencode agent 名称（--agent），项目 .opencode/agent/*.md 定义的角色；从候选中选择或直接输入"},
		{Key: "extra_args", Label: "额外参数", Type: "text", Group: "执行",
			Placeholder: "--no-tools --log-level debug",
			Help:        "原样追加到 opencode run 命令"},
		{Key: "env", Label: "环境变量", Type: "env", Group: "执行",
			Placeholder: "KEY=VALUE（每行一个）",
			Help:        "注入执行环境，如 OPENAI_API_KEY、ANTHROPIC_API_KEY"},
	}
}

func (a *openCodeAdapter) Docs() string { return "https://opencode.ai/docs" }

// ---------------------------------------------------------------------------
// opencode：`opencode models --verbose` 输出每个 provider/model 的元数据，
// 其中 variants 是该模型当前可用的逐模型思考档位。普通 `opencode models`
// 只有 ID，不能用于推断 variant；命令失败时回退配置/磁盘缓存，但不猜测
// 思考能力。

func (a *openCodeAdapter) Models() []string {
	return capModels(ModelIDs(a.ModelCatalog()), 60)
}

func (a *openCodeAdapter) ModelCatalog() []ModelInfo {
	return cachedModelCatalog("opencode", func() []ModelInfo {
		home, _ := os.UserHomeDir()
		return opencodeModelCatalogProbe(home)
	})
}

// parseOpenCodeVariantNames 支持当前 CLI 输出的 object 形式，也兼容文档
// 中的数组形式。disabled variant 不属于可选档位。
func parseOpenCodeVariantNames(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) == nil {
		out := make([]string, 0, len(object))
		for name, value := range object {
			var cfg struct {
				Disabled bool `json:"disabled"`
			}
			if json.Unmarshal(value, &cfg) == nil && cfg.Disabled {
				continue
			}
			out = append(out, name)
		}
		return orderThinkingLevels(out)
	}
	var names []string
	if json.Unmarshal(raw, &names) == nil {
		return orderThinkingLevels(names)
	}
	var list []struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Disabled bool   `json:"disabled"`
	}
	if json.Unmarshal(raw, &list) != nil {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if item.Disabled {
			continue
		}
		name := item.ID
		if name == "" {
			name = item.Name
		}
		if name != "" {
			out = append(out, name)
		}
	}
	return orderThinkingLevels(out)
}

// parseOpenCodeVerboseModels 从带标题行的 verbose 输出中提取 JSON 对象。
// `opencode models --verbose` 目前不是一个整体 JSON 文档，而是“模型 ID
// 标题 + pretty JSON”重复输出；使用 Decoder 逐对象读取，避免依赖固定行号。
func parseOpenCodeVerboseModels(raw string) []ModelInfo {
	var out []ModelInfo
	pos := map[string]int{}
	for cursor := 0; cursor < len(raw); {
		rel := strings.IndexByte(raw[cursor:], '{')
		if rel < 0 {
			break
		}
		start := cursor + rel
		var model struct {
			ID         string          `json:"id"`
			ProviderID string          `json:"providerID"`
			Provider   string          `json:"provider"`
			Variants   json.RawMessage `json:"variants"`
		}
		decoder := json.NewDecoder(strings.NewReader(raw[start:]))
		if err := decoder.Decode(&model); err != nil {
			cursor = start + 1
			continue
		}
		consumed := int(decoder.InputOffset())
		if consumed <= 0 {
			cursor = start + 1
		} else {
			cursor = start + consumed
		}
		provider := strings.TrimSpace(model.ProviderID)
		if provider == "" {
			provider = strings.TrimSpace(model.Provider)
		}
		if provider == "" || strings.TrimSpace(model.ID) == "" {
			continue
		}
		addModelInfo(&out, pos, ModelInfo{
			ID:             provider + "/" + strings.TrimSpace(model.ID),
			ThinkingLevels: parseOpenCodeVariantNames(model.Variants),
		})
	}
	return out
}

func opencodeModelCatalogProbe(home string) []ModelInfo {
	if raw, ok := cliOutput(probeTimeout, "opencode", "models", "--verbose"); ok {
		out := parseOpenCodeVerboseModels(raw)
		if len(out) > 0 {
			ids := ModelIDs(out)
			saveModelsDisk("opencode", ids)
			return capModelInfo(out, 60)
		}
	}
	// opencode models 偶发走目录刷新超时：磁盘缓存只复用模型 ID，不能
	// 把旧的/未知 variant 当成当前模型能力。
	if disk := loadModelsDisk("opencode"); disk != nil {
		return capModelInfo(modelInfosFromIDs(disk), 60)
	}
	var cfg struct {
		Model      string `json:"model"`
		SmallModel string `json:"small_model"`
	}
	readJSONFile(filepath.Join(home, ".config", "opencode", "opencode.json"), &cfg)
	return modelInfosFromIDs([]string{cfg.Model, cfg.SmallModel})
}
