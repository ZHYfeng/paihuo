// Package exec 实现 CLI 适配器层与任务执行器。
// 适配器把「角色配置 + 任务」翻译为各 CLI 的原生批处理或交互命令。
package exec

import (
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"

	"paihuo/internal/store"
)

// RunOptions 是一次执行的完整输入。
type RunOptions struct {
	Dir        string // 项目目录
	Prompt     string // 任务提示词（已含权限模式修饰）
	Role       store.RoleConfig
	Perm       string // 任务权限模式：full | review
	RunMode    string // batch | interactive
	SessionDir string // 任务专属会话目录（会话隔离，互不干扰）
	// SkillDirs 是执行器为本次任务准备的技能副本目录。它们位于任务
	// 工作空间内，避免 CLI 因沙箱/工作目录限制读不到角色选择的源目录。
	// 为空时适配器回退到 Role.Skills，便于单元测试和兼容旧调用方。
	SkillDirs []string
	// SkillNames 是本次任务实际启用的技能名。OMP 的 --skills 参数是
	// 名称 glob 过滤器，不是目录加载器，因此不能直接传 Role.Skills 路径。
	SkillNames []string
}

// Adapter 是 agent CLI 的适配器。
type Adapter interface {
	ID() string
	Name() string
	// Detect 返回 CLI 可执行文件路径；未安装则报错。
	Detect() (string, error)
	// Build 把执行输入翻译为命令。env 是完整环境（含角色 env 覆盖）。
	Build(o RunOptions) (bin string, args []string, env []string, err error)
	// Warnings 返回无法映射到该 CLI 的配置项提示（如不支持的字段）。
	Warnings(o RunOptions) []string
	// Schema 返回该 CLI 支持配置的字段定义（源自官方文档）；前端按 schema
	// 渲染每个角色的深度定制表单，而非统一的固定字段。
	Schema() []Field
	// Models 返回该 CLI 实例实际配置/可用的模型候选（探测本机配置，带缓存）。
	Models() []string
	// Docs 返回该 CLI 官方文档链接。
	Docs() string
}

var registry = map[string]Adapter{}

func register(a Adapter) { registry[a.ID()] = a }

func GetAdapter(id string) (Adapter, bool) {
	a, ok := registry[id]
	return a, ok
}

func Adapters() []Adapter {
	out := make([]Adapter, 0, len(registry))
	for _, a := range registry {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID() < out[j].ID() })
	return out
}

func init() {
	register(&ompAdapter{baseAdapter{id: "omp", name: "OMP（Oh My Pi）", bin: "omp"}})
	register(&openCodeAdapter{baseAdapter{id: "opencode", name: "OpenCode", bin: "opencode"}})
	register(&piAdapter{baseAdapter{id: "pi", name: "Pi Agent", bin: "pi"}})
	register(&claudeAdapter{baseAdapter{id: "claude", name: "Claude Code", bin: "claude"}})
	register(&codexAdapter{baseAdapter{id: "codex", name: "Codex", bin: "codex"}})
}

type baseAdapter struct {
	id   string
	name string
	bin  string
}

func (a *baseAdapter) ID() string       { return a.id }
func (a *baseAdapter) Name() string     { return a.name }
func (a *baseAdapter) Models() []string { return nil }

func (a *baseAdapter) Detect() (string, error) {
	p, err := exec.LookPath(a.bin)
	if err != nil {
		return "", fmt.Errorf("未找到 CLI「%s」，请先安装 %s", a.bin, a.name)
	}
	return p, nil
}

// mergeEnv 把角色环境变量合并进系统环境。
// 重复 KEY 必须原地覆盖：exec 环境里同名变量多数 CLI 取第一个，
// 直接 append 会让角色的覆盖静默失效。
func mergeEnv(extra map[string]string) []string {
	env := os.Environ()
	idx := make(map[string]int, len(env)+len(extra))
	for i, kv := range env {
		if k, _, ok := strings.Cut(kv, "="); ok {
			idx[k] = i
		}
	}
	for k, v := range extra {
		if i, ok := idx[k]; ok {
			env[i] = k + "=" + v
		} else {
			idx[k] = len(env)
			env = append(env, k+"="+v)
		}
	}
	return env
}

// shellJoin 仅用于日志展示。
func shellJoin(parts []string) string {
	quoted := make([]string, len(parts))
	for i, p := range parts {
		if strings.ContainsAny(p, " \t\"'") {
			quoted[i] = "'" + strings.ReplaceAll(p, "'", `'\''`) + "'"
		} else {
			quoted[i] = p
		}
	}
	return strings.Join(quoted, " ")
}

// ---------------------------------------------------------------------------
// omp（Oh My Pi）：omp -p "提示词"
// 角色映射：model→--model；system_prompt→--append-system-prompt；
// skills→项目 .agents/skills + --skills 名称过滤；thinking→--thinking；
// plugins→--config。

type ompAdapter struct{ baseAdapter }

func (a *ompAdapter) Build(o RunOptions) (string, []string, []string, error) {
	interactive := o.RunMode == store.RunModeInteractive
	args := []string{}
	if !interactive {
		args = append(args, "-p", o.Prompt, "--no-pty")
	}
	if o.SessionDir != "" {
		args = append(args, "--session-dir", o.SessionDir)
	}
	if m := o.Role.Model; m != "" {
		args = append(args, "--model", m)
	}
	if s := o.Role.SystemPrompt; s != "" {
		args = append(args, "--append-system-prompt", s)
	}
	skillNames := o.SkillNames
	if len(skillNames) == 0 {
		// 兼容直接调用 Adapter.Build 的旧代码；正式任务由执行器填充
		// SkillNames，传入原始目录只会取其 basename 作为过滤名。
		skillNames = skillBasenames(o.Role.Skills)
	}
	if len(skillNames) > 0 {
		args = append(args, "--skills", strings.Join(skillNames, ","))
	}
	if thinking := strings.TrimSpace(o.Role.Thinking); thinking != "" {
		// --smol/--slow 选择的是 OMP 的模型角色，不是思考级别；思考档位
		// 必须原样传给 --thinking（如 high、xhigh、max、auto）。
		args = append(args, "--thinking", thinking)
	}
	for _, p := range o.Role.Plugins {
		args = append(args, "--config", p)
	}
	// omp 专属参数（官方 docs/flag-tables）：工具白名单 / 执行时限 / 配置档位 / 提供商
	if v := o.Role.Custom["tools"]; v != "" {
		args = append(args, "--tools", v)
	}
	if v := o.Role.Custom["max_time"]; v != "" {
		args = append(args, "--max-time", v)
	}
	if v := o.Role.Custom["profile"]; v != "" {
		args = append(args, "--profile", v)
	}
	if v := o.Role.Custom["provider"]; v != "" {
		args = append(args, "--provider", v)
	}
	// 全权模式：官方 --auto-approve（除危险操作外自动批准），避免非交互执行中途挂起
	if o.Perm == "full" {
		args = append(args, "--auto-approve")
	}
	args = append(args, o.Role.ExtraArgs...)
	if interactive {
		// OMP 与 Pi 一样用位置参数接收交互会话的初始消息。
		args = append(args, o.Prompt)
	}
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *ompAdapter) Warnings(o RunOptions) []string { return nil }

// omp 全部通用字段均支持；无 CLI 特有字段。
func (a *ompAdapter) Schema() []Field {
	fs := commonFields()
	if f := byKey(fs, "thinking"); f != nil {
		f.Options = []string{""}
		f.Help = "按所选模型从 omp models --json 读取 thinking 档位，并原样传给 --thinking；模型未声明时不猜测"
	}
	if f := byKey(fs, "skills"); f != nil {
		f.Help = "执行器把所选技能复制到任务 .agents/skills，并用官方 --skills 按名称过滤；任务提示会明确要求读取并遵循"
	}
	fs = append(fs,
		Field{Key: "tools", Label: "工具白名单", Type: "list", Group: "执行",
			Placeholder: "read,edit,bash",
			Help:        "官方 --tools：只启用列出的内置工具（共 31 个）；留空=全部。未知工具名会直接报错"},
		Field{Key: "max_time", Label: "执行时限", Type: "text", Group: "执行",
			Placeholder: "1800（秒），支持 30m / 2h",
			Help:        "官方 --max-time：单次执行的超时上限"},
		Field{Key: "profile", Label: "配置档位", Type: "text", Group: "执行",
			Placeholder: "work / personal",
			Help:        "官方 --profile：加载 ~/.omp/agent 下的命名配置档位"},
		Field{Key: "provider", Label: "提供商", Type: "text", Group: "模型与指令",
			Placeholder: "留空用默认（60+ 提供商自动探测）",
			Help:        "官方 --provider：强制使用 models.yml 中定义的提供商（如 spark / claude / gemini），模型字段建议同步指定"},
	)
	return fs
}

func (a *ompAdapter) Docs() string { return "https://omp.sh/docs" }

// ---------------------------------------------------------------------------
// opencode：opencode run --dir <dir> "提示词"
// 角色映射：model→--model；thinking→--variant（模型实际声明的 variant）；
// custom.agent→--agent、custom.config→--config；系统提示词请用 opencode agent 定义。

type openCodeAdapter struct{ baseAdapter }

func (a *openCodeAdapter) Build(o RunOptions) (string, []string, []string, error) {
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
	if cfg := o.Role.Custom["config"]; cfg != "" {
		args = append(args, "--config", cfg)
	}
	args = append(args, o.Role.ExtraArgs...)
	args = append(args, o.Prompt)
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *openCodeAdapter) Warnings(o RunOptions) []string {
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
// 原生目录；特有字段：agent（opencode agent 定义）、config（配置文件）。
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
		{Key: "agent", Label: "Agent 定义", Type: "text", Group: "模型与指令",
			Suggestions: []string{"build", "plan", "architect", "debug", "test", "code-review"},
			Placeholder: "如 build / planner（可输入自定义）",
			Help:        "opencode agent 名称（--agent），项目 .opencode/agent/*.md 定义的角色；从候选中选择或直接输入"},
		{Key: "config", Label: "配置文件", Type: "text", Group: "执行",
			Placeholder: "/path/to/opencode.json",
			Help:        "--config 叠加指定配置文件（默认读项目 opencode.json / .opencode/opencode.json）"},
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
// pi：pi -p "提示词"
// 角色映射：model→--model；system_prompt→--append-system-prompt；其余走 ExtraArgs。

type piAdapter struct{ baseAdapter }

func (a *piAdapter) Build(o RunOptions) (string, []string, []string, error) {
	interactive := o.RunMode == store.RunModeInteractive
	args := []string{}
	if !interactive {
		// 保持已有批处理 argv 形状，避免影响已验证的 Pi 调用方式。
		args = append(args, "-p", o.Prompt)
	}
	if o.SessionDir != "" {
		args = append(args, "--session-dir", o.SessionDir)
	}
	if m := o.Role.Model; m != "" {
		args = append(args, "--model", m)
	}
	if s := o.Role.SystemPrompt; s != "" {
		args = append(args, "--append-system-prompt", s)
	}
	if v := o.Role.Custom["provider"]; v != "" {
		args = append(args, "--provider", v)
	}
	if v := o.Role.Custom["tools"]; v != "" {
		args = append(args, "--tools", v)
	}
	if v := o.Role.Custom["exclude_tools"]; v != "" {
		args = append(args, "--exclude-tools", v)
	}
	if v := o.Role.Custom["models_cycle"]; v != "" {
		args = append(args, "--models", v)
	}
	if o.Role.Thinking != "" {
		args = append(args, "--thinking", o.Role.Thinking)
	}
	skillDirs := o.SkillDirs
	if len(skillDirs) == 0 {
		skillDirs = o.Role.Skills
	}
	for _, s := range skillDirs {
		args = append(args, "--skill", s)
	}
	args = append(args, o.Role.ExtraArgs...)
	if interactive {
		// Pi 的交互模式把初始消息作为位置参数；随后会留在 TTY 等待下一轮输入。
		args = append(args, o.Prompt)
	}
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *piAdapter) Warnings(o RunOptions) []string {
	var ws []string
	if len(o.Role.Plugins) > 0 {
		ws = append(ws, "pi 插件/扩展通过 pi install 全局管理（Skills 页扩展 tab），角色 plugins 字段不生效")
	}
	return ws
}

func (a *piAdapter) Schema() []Field {
	fs := commonFields()
	if f := byKey(fs, "thinking"); f != nil {
		// pi 的 Linux 本机模型目录只报告 reasoning=true/false，或列表中的
		// thinking yes/no；无法逐模型识别具体档位时，保留完整的通用选项，
		// 让不同 provider/model 的 thinking 值仍可直接传给 --thinking。
		f.Options = []string{"", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
		f.Help = "无法从本机模型目录识别逐模型思考档位时，保留通用选项：off / minimal / low / medium / high / xhigh / max / ultra；默认使用 Pi/模型默认。"
	}
	if f := byKey(fs, "skills"); f != nil {
		f.Help = "执行器把所选技能复制到任务工作空间，并用官方 --skill 逐目录加载（可多个）"
	}
	// pi 无 plugins 字段：扩展用 pi install 全局管理（见 Skills 页扩展 tab）
	out := fs[:0]
	for _, f := range fs {
		if f.Key != "plugins" {
			out = append(out, f)
		}
	}
	fs = out
	fs = append(fs,
		Field{Key: "provider", Label: "提供商", Type: "text", Group: "模型与指令",
			Placeholder: "留空用默认（pi 默认 google，支持 anthropic/openai/gemini 等）",
			Help:        "官方 --provider：强制指定提供商；登录见 pi 内 /login（凭据存 ~/.pi/agent/auth.json）"},
		Field{Key: "tools", Label: "工具白名单", Type: "list", Group: "执行",
			Placeholder: "read,write,bash,edit",
			Help:        "官方 --tools：逗号分隔的启用白名单（内置/扩展/自定义工具均适用）；留空=全部"},
		Field{Key: "exclude_tools", Label: "工具黑名单", Type: "list", Group: "执行",
			Placeholder: "browser,tts",
			Help:        "官方 --exclude-tools：逗号分隔的禁用名单"},
		Field{Key: "models_cycle", Label: "模型循环候选", Type: "text", Group: "模型与指令",
			Placeholder: "anthropic/*,*sonnet*",
			Help:        "官方 --models：Ctrl+P 循环切换的模型 patterns（支持通配符与模糊匹配）"},
	)
	return fs
}

func (a *piAdapter) Docs() string { return "https://pi.dev/docs" }

// ---------------------------------------------------------------------------
// claude：claude -p "提示词"
// 角色映射：model→--model；system_prompt→--append-system-prompt；
// skills→项目 .claude/skills 原生 discovery。

type claudeAdapter struct{ baseAdapter }

func (a *claudeAdapter) Build(o RunOptions) (string, []string, []string, error) {
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
	args = append(args, o.Role.ExtraArgs...)
	if interactive {
		// Claude Code 不带 -p 时启动交互 REPL，位置参数作为初始消息。
		args = append(args, o.Prompt)
	}
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *claudeAdapter) Warnings(o RunOptions) []string {
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
// codex：codex exec "提示词"
// 角色映射：model→-c model="..."；system_prompt→-c system_prompt="..."；
// thinking→-c reasoning_effort="..."；skills→项目 .agents/skills 原生 discovery。

type codexAdapter struct{ baseAdapter }

func (a *codexAdapter) Build(o RunOptions) (string, []string, []string, error) {
	interactive := o.RunMode == store.RunModeInteractive
	// 本机 Codex 0.146 的 code-mode-host 在工具命令非零退出时会错误终止外层
	// task pane。关闭它会回退到 CLI 自身稳定的执行路径；批处理使用 exec，
	// 交互任务则不带子命令启动官方 TUI。
	args := []string{}
	if !interactive {
		args = append(args, "exec")
	}
	args = append(args, "--disable", "code_mode_host")
	// YOLO 对应本机 Codex CLI 的完整绕过模式：不等待批准、不启用 sandbox，
	// 并允许在非 Git 目录执行。它必须由角色配置显式开启，普通 Codex 仍保留
	// 官方默认保护。
	if o.Role.Custom["execution_mode"] == "yolo" {
		args = append(args, "--dangerously-bypass-approvals-and-sandbox")
		if !interactive {
			// --skip-git-repo-check 是 exec 子命令参数；交互 TUI 不接受它。
			args = append(args, "--skip-git-repo-check")
		}
	}
	if m := o.Role.Model; m != "" {
		args = append(args, "-c", "model="+tomlQuote(m))
	}
	if s := o.Role.SystemPrompt; s != "" {
		args = append(args, "-c", "system_prompt="+tomlQuote(s))
	}
	if thinking := strings.TrimSpace(o.Role.Thinking); thinking != "" {
		// Codex 的可用值由 ~/.codex/models_cache.json 按模型声明。不要把
		// UI 的旧 low/high 抽象映射成其它值，否则 xhigh/max/ultra 无法生效。
		args = append(args, "-c", "reasoning_effort="+tomlQuote(thinking))
	}
	if t := o.Role.Custom["temperature"]; t != "" {
		args = append(args, "-c", "temperature="+tomlQuote(t))
	}
	if m := o.Role.Custom["mcp_config_file"]; m != "" {
		args = append(args, "-c", "mcp_config_file="+tomlQuote(m))
	}
	args = append(args, o.Role.ExtraArgs...)
	args = append(args, o.Prompt)
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *codexAdapter) Warnings(o RunOptions) []string {
	var ws []string
	if len(o.Role.Plugins) > 0 {
		ws = append(ws, "codex 插件通过 MCP/全局配置管理，角色 plugins 字段不生效")
	}
	return ws
}

// codex 特有字段：执行模式、temperature、mcp_config_file（写入 codex 配置 TOML）。
func (a *codexAdapter) Schema() []Field {
	fs := commonFields()
	if f := byKey(fs, "thinking"); f != nil {
		f.Options = []string{""}
		f.Help = "按所选模型从本机 ~/.codex/models_cache.json 读取，映射为 codex reasoning_effort；模型未声明时不展示猜测档位。"
	}
	return append(fs,
		Field{Key: "execution_mode", Label: "执行模式", Type: "select", Group: "执行",
			Options: []string{"safe", "yolo"}, Default: "safe",
			Help: "yolo 会跳过 Codex 的批准、sandbox 与 Git 目录检查；仅用于你明确授权的本机任务。"},
		Field{Key: "temperature", Label: "Temperature", Type: "select", Group: "模型与指令",
			Options: []string{"", "0.0", "0.2", "0.4", "0.6", "0.8", "1.0"},
			Help:    "codex 配置 temperature（默认 0.2），越高越发散"},
		Field{Key: "mcp_config_file", Label: "MCP 配置文件", Type: "text", Group: "技能", Source: "files",
			Pattern:     "~/.codex/*.json",
			Placeholder: "/path/to/mcp.json",
			Help:        "codex 配置 mcp_config_file，挂载外部工具（MCP 服务器）；候选来自 ~/.codex"},
	)
}

func (a *codexAdapter) Docs() string { return "https://developers.openai.com/codex/" }

// tomlQuote 把字符串转成 TOML 基本字符串字面量（用于 -c key=value）。
func tomlQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\r`)
	s = strings.ReplaceAll(s, "\t", `\t`)
	return `"` + s + `"`
}
