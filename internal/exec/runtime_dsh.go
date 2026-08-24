package exec

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"paihuo/internal/store"
)

// ---------------------------------------------------------------------------
// dsh（DeepSeek Harness）：dsh --profile headless "<任务>" 一次性批处理；
// 结构化会话走 dsh web 宿主（dsh --profile web）的 HTTP ApiProxy 通道，
// 由 internal/session 的 dsh 通道实现（无需 CLI 参数翻译）。
// 角色映射：model/system_prompt 无官方标志（配置在 profile 插件栈内），提示词是
// 位置参数（headless 收集全部位置参数作为任务文本）；模式与提示词通过
// DSH_TUI_PRESET / DSH_TUI_PERSONA / DSH_PERMISSION_MODE 环境变量按角色注入。

type dshAdapter struct{ baseAdapter }

// Detect 除 CLI 二进制外还校验 profile：默认批处理依赖 headless，
// 缺失时任务必然无法启动，提前在 Runtime 健康检查暴露。
func (a *dshAdapter) Detect() (string, error) {
	bin, err := exec.LookPath(a.bin)
	if err != nil {
		return "", fmt.Errorf("未找到 CLI「%s」，请先安装（npm install -g @deepseek-ai/dsh）", a.bin)
	}
	if _, ok := os.Stat(filepath.Join(dshHome(), "profiles", "headless")); ok != nil {
		return "", fmt.Errorf("dsh 已安装但未初始化 headless profile（%s/profiles 下缺失）；先运行 dsh --profile headless --help 初始化", dshHome())
	}
	return bin, nil
}

// dshHome 返回 $DSH_HOME（缺省 ~/.dsh）。
func dshHome() string {
	if home := os.Getenv("DSH_HOME"); home != "" {
		return home
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".dsh")
	}
	return ".dsh"
}

func (a *dshAdapter) Build(o ExecutionRequest) (string, []string, []string, error) {
	profile := strings.TrimSpace(o.Role.Custom["profile"])
	if profile == "" {
		profile = "headless"
	}
	// 提示词是位置参数：headless 把它作为一次性任务。
	// extra_args 会并入任务文本——headless 的 commander 只接收位置参数，
	// 传 `--` 开头的标志会直接报错。
	args := append([]string{"--profile", profile}, o.Role.ExtraArgs...)
	args = append(args, o.Prompt)
	env := mergeEnv(o.Role.Env)
	// dsh 原生模式（profile 组合的 cordis 配置直接读这些环境变量）：
	//   - DSH_TUI_PRESET：agent 预设（standard / code / minimal / cordis / 自定义 roster）；空=roster 默认
	//   - DSH_TUI_PERSONA：系统提示词（@deepseek-ai/dsh-system-prompt 的 persona 配置）
	//   - DSH_PERMISSION_MODE：沙箱与审批模式（danger-full-access 免审批无沙箱；
	//     workspace-write 沙箱+人工审批 / read-only 只读），按任务权限映射
	if preset := strings.TrimSpace(o.Role.Custom["preset"]); preset != "" {
		env = envWith(env, "DSH_TUI_PRESET", preset)
	}
	if persona := strings.TrimSpace(o.Role.SystemPrompt); persona != "" {
		env = envWith(env, "DSH_TUI_PERSONA", persona)
	}
	switch o.Perm {
	case store.PermFull:
		env = envWith(env, "DSH_PERMISSION_MODE", "danger-full-access")
	case store.PermReview:
		env = envWith(env, "DSH_PERMISSION_MODE", "workspace-write")
	}
	return a.bin, args, env, nil
}

func (a *dshAdapter) Warnings(o ExecutionRequest) []string {
	var ws []string
	if o.Role.Model != "" || o.Role.Custom["provider"] != "" {
		ws = append(ws, "dsh 批处理不使用 role.model/provider；会话需同时填写 provider+model 才会经 session.selectModel 应用")
	}
	if len(o.Role.Plugins) > 0 {
		ws = append(ws, "dsh 插件在 profile 层管理，角色 plugins 字段不生效")
	}
	return ws
}

// dshPresetCandidates 返回可选的 agent 预设：dsh web 随附的 system preset
// （standard/code/minimal/cordis）+ $DSH_HOME/.agent-presets 下已安装的自定义
// 预设。供 schema 的 preset 字段做下拉候选。
func dshPresetCandidates() []string {
	out := []string{"", "standard", "code", "minimal", "cordis"}
	seen := map[string]bool{"": true, "standard": true, "code": true, "minimal": true, "cordis": true}
	entries, err := os.ReadDir(filepath.Join(dshHome(), ".agent-presets"))
	if err != nil {
		return out
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() && !strings.HasPrefix(name, ".") && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

// dshSettingsLines 读取 $DSH_HOME/settings.yaml（不存在时返回 nil）。
func dshSettingsLines() []string {
	b, err := os.ReadFile(filepath.Join(dshHome(), "settings.yaml"))
	if err != nil {
		return nil
	}
	return strings.Split(string(b), "\n")
}

// dshProviderCandidates 返回 dsh web 可选的 provider 路由：内置
// deepseek-official，加上 settings.yaml 中 llm-pi-ai.providers 下声明的路由，
// 以及 agent-default-model.provider 当前使用的路由。
func dshProviderCandidates() []string {
	seen := map[string]bool{"deepseek-official": true}
	out := []string{"deepseek-official"}
	inProviders := false
	providersIndent := -1
	providerIndent := -1
	for _, line := range dshSettingsLines() {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if strings.HasPrefix(trimmed, "providers:") {
			inProviders = true
			providersIndent = indent
			providerIndent = -1
			continue
		}
		if inProviders {
			if indent <= providersIndent {
				inProviders = false
				providerIndent = -1
			} else if strings.HasSuffix(trimmed, ":") && !strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "-") {
				if providerIndent == -1 {
					providerIndent = indent
				}
				if indent == providerIndent {
					name := strings.TrimSuffix(trimmed, ":")
					if name != "" && !seen[name] {
						seen[name] = true
						out = append(out, name)
					}
				}
			}
		}
		if strings.HasPrefix(trimmed, "provider:") {
			name := strings.TrimSpace(strings.TrimPrefix(trimmed, "provider:"))
			if name != "" && !seen[name] {
				seen[name] = true
				out = append(out, name)
			}
		}
	}
	return out
}

// dshModelCandidates 返回 dsh web 可选的模型 id：settings.yaml 中的模型 id /
// agent-default-model.model，并补充 DeepSeek 官方默认模型。
func dshModelCandidates() []string {
	seen := map[string]bool{}
	var out []string
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name != "" && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	for _, line := range dshSettingsLines() {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "id:") {
			add(strings.TrimPrefix(trimmed, "id:"))
		}
		if strings.HasPrefix(trimmed, "model:") {
			add(strings.TrimPrefix(trimmed, "model:"))
		}
	}
	for _, m := range []string{"deepseek-v4-flash", "deepseek-v4-pro"} {
		add(m)
	}
	return out
}

// dsh schema 对齐 dsh web 的实现：preset 选 agent 组装，provider/model/
// reasoning_effort 构成 ModelSelection（会话创建后经 session.selectModel 应用），
// 同时保留通用角色字段（system_prompt→persona）与批处理 profile 选择。
func (a *dshAdapter) Schema() []Field {
	presets := dshPresetCandidates()
	if len(presets) > 0 {
		presets = presets[1:] // 空值由前端“使用智能体默认值”提供
	}
	return []Field{
		{Key: "model", Label: "模型", Type: "select", Group: "模型与指令",
			Options:     dshModelCandidates(),
			Placeholder: "选择模型",
			Help:        "dsh 会话创建后会结合 provider 通过 session.selectModel 应用；批处理仍由 profile 的 agent-default-model 决定，不直接传 CLI"},
		{Key: "provider", Label: "模型提供商", Type: "select", Group: "模型与指令",
			Options:     dshProviderCandidates(),
			Placeholder: "选择提供商",
			Help:        "dsh web 的 ModelSelection.provider；与 model 一起填写时，会话创建后会调用 session.selectModel"},
		{Key: "reasoning_effort", Label: "推理强度", Type: "select", Group: "模型与指令",
			Options:     []string{"low", "medium", "high", "max"},
			Placeholder: "选择推理强度",
			Help:        "dsh web 的 ModelSelection.reasoningEffort；可选，与 provider/model 一起在会话创建后应用"},
		{Key: "system_prompt", Label: "系统提示词", Type: "textarea", Group: "模型与指令",
			Placeholder: "角色定位、行为规范",
			Help:        "原生映射为 DSH_TUI_PERSONA（dsh-system-prompt 的 persona）：替换默认角色定位；如需保留默认请把默认内容并进这里"},
		{Key: "instructions", Label: "指令", Type: "textarea", Group: "模型与指令",
			Placeholder: "任务指令模板：每次执行前固定追加的指示",
			Help:        "与系统提示词不同：这是每次任务的固定指令前缀，在任务提示词之前注入（dsh 以提示词文本方式生效）"},
		{Key: "skills", Label: "技能", Type: "list", Group: "技能", Source: "skills",
			Placeholder: "勾选已注册到 paihuo 工作目录的技能",
			Help:        "执行器把所选技能挂载到任务/会话的 .agents/skills，由 dsh 的 skill-filesystem 原生发现"},
		{Key: "preset", Label: "Agent 预设（模式）", Type: "select", Group: "执行",
			Options:     presets,
			Placeholder: "选择 Agent 预设",
			Help:        "原生映射为 DSH_TUI_PRESET / session.create 的 agentPreset：按 dsh-agent-presets 的 roster 选择 agent 模式（工具组合/提示词结构），如 standard、code、minimal、cordis 或 $DSH_HOME/.agent-presets 下已安装的自定义预设"},
		{Key: "profile", Label: "dsh profile", Type: "select", Group: "执行",
			Options:     []string{"headless"},
			Placeholder: "选择 dsh profile",
			Help:        "要启动的 dsh profile（$DSH_HOME/profiles 下的插件栈）；此字段仅影响批处理，会话固定使用 web 宿主，因此不需要填 web"},
		{Key: "extra_args", Label: "额外内容", Type: "text", Group: "执行",
			Placeholder: "追加到任务文本的固定说明",
			Help:        "dsh 无独立标志位：这里的内容会并入任务文本（headless 不接受 -- 开头的参数）"},
		{Key: "env", Label: "环境变量", Type: "env", Group: "执行",
			Placeholder: "KEY=VALUE（每行一个）",
			Help:        "注入执行环境，如 DEEPSEEK_API_KEY、DSH_TUI_LANG、DSH_TUI_THEME"},
	}
}

func (a *dshAdapter) Docs() string { return "https://github.com/deepseek-ai/deepseek-harness" }
