// Package exec 实现 Runtime 选择、命令翻译与任务执行。
// 本文件只保存内置命令 Runtime 的具体翻译规则；目录、会话和安装能力
// 由 RuntimeService 在各自的接缝上组合。
package exec

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"paihuo/internal/store"
)

// ExecutionRequest 是 Runtime 接收的稳定执行输入。CLI 参数、配置文件布局和
// 会话目录细节由具体 Runtime 隐藏，调用方只描述本次任务需要什么。
type ExecutionRequest struct {
	Dir        string // 项目目录
	Prompt     string // 任务提示词（已含权限模式修饰）
	Role       store.RoleConfig
	Perm       string // 任务权限模式：full | review
	RunMode    string // batch | interactive
	SessionDir string // 任务专属会话目录（会话隔离，互不干扰）
	// SkillMount 是 Runtime 可直接消费的角色级技能挂载视图。Role.Skills
	// 只保存来源选择，不允许命令翻译层绕过挂载边界读取源目录。
	SkillMount *RoleSkillMount
	// SkipGitCheck 让 codex 在非 git 项目目录执行（--skip-git-repo-check），
	// 仅批处理 exec 有效；不修改角色配置，只注入本次调用。
	SkipGitCheck bool
}

// commandAdapter 是内置 Runtime 的私有实现接口。它刻意不暴露给 server、
// session 或任务生命周期；这些调用方只通过 RuntimeService 工作。
type commandAdapter interface {
	ID() string
	Name() string
	// Detect 返回 CLI 可执行文件路径；未安装则报错。
	Detect() (string, error)
	// Build 把执行输入翻译为命令。env 是完整环境（含角色 env 覆盖）。
	Build(o ExecutionRequest) (bin string, args []string, env []string, err error)
	// Warnings 返回无法映射到该 CLI 的配置项提示（如不支持的字段）。
	Warnings(o ExecutionRequest) []string
	// Schema 返回该 CLI 支持配置的字段定义（源自官方文档）；前端按 schema
	// 渲染每个角色的深度定制表单，而非统一的固定字段。
	Schema() []Field
	// Models 返回该 CLI 实例实际配置/可用的模型候选（探测本机配置，带缓存）。
	Models() []string
	// Docs 返回该 CLI 官方文档链接。
	Docs() string
	// ExitCommand 返回交互模式下优雅退出该 CLI 的命令（不含 Enter）。
	// 「结束会话」按钮据此发送，让 agent 自行收尾后按正常退出结果结算。
	ExitCommand() string
}

var registry = map[string]commandAdapter{}

func register(a commandAdapter) { registry[a.ID()] = a }

func commandAdapters() []commandAdapter {
	out := make([]commandAdapter, 0, len(registry))
	for _, a := range registry {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID() < out[j].ID() })
	return out
}

func init() {
	register(&ompAdapter{baseAdapter{id: "omp", name: "OMP（Oh My Pi）", bin: "omp"}})
	register(&openCodeAdapter{baseAdapter{id: "opencode", name: "OpenCode", bin: "opencode"}})
	register(&piAdapter{baseAdapter{id: "pi", name: "Pi Role", bin: "pi"}})
	register(&claudeAdapter{baseAdapter{id: "claude", name: "Claude Code", bin: "claude"}})
	register(&codexAdapter{baseAdapter{id: "codex", name: "Codex", bin: "codex"}})
	register(&dshAdapter{baseAdapter{id: "dsh", name: "DSH（DeepSeek Harness）", bin: "dsh"}})
}

type baseAdapter struct {
	id   string
	name string
	bin  string
}

func (a *baseAdapter) ID() string       { return a.id }
func (a *baseAdapter) Name() string     { return a.name }
func (a *baseAdapter) Models() []string { return nil }

// ExitCommand 默认 /exit（opencode/claude/codex 的交互退出命令）。
func (a *baseAdapter) ExitCommand() string { return "/exit" }

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

// envWith 在已有环境切片中设置/追加单个 KEY=VALUE（原地覆盖重复项）。
func envWith(env []string, key, value string) []string {
	kv := key + "=" + value
	for i, e := range env {
		if k, _, ok := strings.Cut(e, "="); ok && k == key {
			env[i] = kv
			return env
		}
	}
	return append(env, kv)
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

func (a *ompAdapter) Build(o ExecutionRequest) (string, []string, []string, error) {
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
	if o.SkillMount != nil && o.SkillMount.OmpOverlay != "" {
		// 角色级 overlay 已把 skills.customDirectories 限定为角色技能目录
		// （含 global 合并），无需 --skills 名称过滤。
		args = append(args, "--config", o.SkillMount.OmpOverlay)
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

func (a *ompAdapter) Warnings(o ExecutionRequest) []string { return nil }

// omp 全部通用字段均支持；无 CLI 特有字段。
func (a *ompAdapter) Schema() []Field {
	fs := commonFields()
	if f := byKey(fs, "thinking"); f != nil {
		f.Options = []string{""}
		f.Help = "按所选模型从 omp models --json 读取 thinking 档位，并原样传给 --thinking；模型未声明时不猜测"
	}
	if f := byKey(fs, "skills"); f != nil {
		f.Help = "执行器把所选技能挂载为角色级技能目录（symlink 视图），经 omp --config overlay（含全局 customDirectories 合并）加载；system prompt 会列出已启用技能"
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
// pi：pi -p "提示词"
// 角色映射：model→--model；system_prompt→--append-system-prompt；其余走 ExtraArgs。

type piAdapter struct{ baseAdapter }

// pi 的交互退出命令是 /quit（/exit 不是有效的交互命令）。
func (a *piAdapter) ExitCommand() string { return "/quit" }

func (a *piAdapter) Build(o ExecutionRequest) (string, []string, []string, error) {
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
	var skillDirs []string
	if o.SkillMount != nil {
		skillDirs = o.SkillMount.SkillPaths
	}
	for _, s := range skillDirs {
		args = append(args, "--skill", s)
	}
	args = appendPiExtensionArgs(args, o.Role)
	args = append(args, o.Role.ExtraArgs...)
	if interactive {
		// Pi 的交互模式把初始消息作为位置参数；随后会留在 TTY 等待下一轮输入。
		args = append(args, o.Prompt)
	}
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *piAdapter) Warnings(o ExecutionRequest) []string {
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
		f.Help = "执行器把所选技能挂载为角色级技能目录（symlink 视图），并用官方 --skill 逐目录加载（可多个）"
	}
	// pi 不复用通用 plugins 字段（其语义是 OMP/Claude 的配置路径）；Pi
	// 扩展单独存入 custom.extensions，并使用 --no-extensions + --extension
	// 精确加载。字段缺失表示采用 Runtime 默认发现。
	out := fs[:0]
	for _, f := range fs {
		if f.Key != "plugins" {
			out = append(out, f)
		}
	}
	fs = out
	fs = append(fs,
		Field{Key: "extensions", Label: "Pi 扩展包", Type: "list", Group: "技能", Source: "extensions",
			Placeholder: "npm:package / git:repo / 本地扩展路径",
			Help:        "从 Skills → Pi Extensions 已安装项中勾选；保存后用官方 --no-extensions + --extension 仅加载所选扩展，清空即禁用全部扩展"},
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

// appendPiExtensionArgs 把角色级扩展选择映射到 Pi 官方资源参数。Custom 中
// 不存在 extensions 表示采用 Runtime 默认发现；字段存在（即使值为空）表示
// 角色显式声明了扩展集合，因此关闭自动发现后逐项加载。
func appendPiExtensionArgs(args []string, role store.RoleConfig) []string {
	raw, configured := role.Custom["extensions"]
	if !configured {
		return args
	}
	args = append(args, "--no-extensions")
	seen := map[string]bool{}
	for _, source := range strings.Split(raw, ",") {
		source = strings.TrimSpace(source)
		if source == "" || seen[source] {
			continue
		}
		seen[source] = true
		args = append(args, "--extension", source)
	}
	return args
}

// BuildPiRPCSessionArgs 构造 pi --mode rpc 会话进程的启动参数（会话管理器用）。
// 与 piAdapter.Build 共用角色参数翻译（model/provider/thinking/skills/extra），
// 差异：不传 -p/位置参数（初始消息由前端 prompt 命令发送），并注入 --mode rpc。
// skillDirs 必须来自角色技能挂载视图，不能直接使用角色配置中的源目录。
func BuildPiRPCSessionArgs(role store.RoleConfig, skillDirs []string, sessionDir string) ([]string, error) {
	args := []string{"--mode", "rpc"}
	if sessionDir != "" {
		args = append(args, "--session-dir", sessionDir)
	}
	if m := role.Model; m != "" {
		args = append(args, "--model", m)
	}
	if s := role.SystemPrompt; s != "" {
		args = append(args, "--append-system-prompt", s)
	}
	if v := role.Custom["provider"]; v != "" {
		args = append(args, "--provider", v)
	}
	if v := role.Custom["tools"]; v != "" {
		args = append(args, "--tools", v)
	}
	if v := role.Custom["exclude_tools"]; v != "" {
		args = append(args, "--exclude-tools", v)
	}
	if v := role.Custom["models_cycle"]; v != "" {
		args = append(args, "--models", v)
	}
	if role.Thinking != "" {
		args = append(args, "--thinking", role.Thinking)
	}
	for _, s := range skillDirs {
		args = append(args, "--skill", s)
	}
	args = appendPiExtensionArgs(args, role)
	args = append(args, role.ExtraArgs...)
	return args, nil
}

// BuildOmpRPCSessionArgs 构造 omp --mode rpc 会话进程的启动参数（会话管理器用）。
// 与 ompAdapter.Build 共用角色参数翻译，差异：不传 -p/位置参数（初始消息由
// 前端 prompt 命令发送），并注入 --mode rpc。skillMount 非 nil 且带角色级
// overlay 时用 --config overlay（含角色声明的 customDirectories）。
func BuildOmpRPCSessionArgs(role store.RoleConfig, skillMount *RoleSkillMount, sessionDir string) ([]string, error) {
	args := []string{"--mode", "rpc"}
	if sessionDir != "" {
		args = append(args, "--session-dir", sessionDir)
	}
	if m := role.Model; m != "" {
		args = append(args, "--model", m)
	}
	if s := role.SystemPrompt; s != "" {
		args = append(args, "--append-system-prompt", s)
	}
	if skillMount != nil && skillMount.OmpOverlay != "" {
		args = append(args, "--config", skillMount.OmpOverlay)
	}
	if thinking := strings.TrimSpace(role.Thinking); thinking != "" {
		args = append(args, "--thinking", thinking)
	}
	if v := role.Custom["tools"]; v != "" {
		args = append(args, "--tools", v)
	}
	if v := role.Custom["max_time"]; v != "" {
		args = append(args, "--max-time", v)
	}
	if v := role.Custom["profile"]; v != "" {
		args = append(args, "--profile", v)
	}
	if v := role.Custom["provider"]; v != "" {
		args = append(args, "--provider", v)
	}
	for _, p := range role.Plugins {
		args = append(args, "--config", p)
	}
	args = append(args, role.ExtraArgs...)
	return args, nil
}

// MergeEnv 把角色环境变量合并进系统环境（会话管理器用）。
func MergeEnv(extra map[string]string) []string { return mergeEnv(extra) }

// ReserveRoleSlot / ReleaseRoleSlot 是 Executor 角色并发槽位的导出入口，
// 供会话管理器（internal/session）与批处理任务共用同一并发池。
func (e *Executor) ReserveRoleSlot(roleID int64, limit int) bool {
	return e.reserveRoleSlot(roleID, limit)
}
func (e *Executor) ReleaseRoleSlot(roleID int64) { e.releaseRoleSlot(roleID) }

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
// codex：codex exec "提示词"
// 角色映射：model→-c model="..."；system_prompt→-c system_prompt="..."；
// thinking→-c reasoning_effort="..."；skills→项目 .agents/skills 原生 discovery。

type codexAdapter struct{ baseAdapter }

func (a *codexAdapter) Build(o ExecutionRequest) (string, []string, []string, error) {
	interactive := o.RunMode == store.RunModeInteractive
	// Code Mode 及其 host 的可用性由已安装的 Codex 版本和用户配置决定，适配器
	// 不覆盖功能开关；批处理使用 exec，交互任务则不带子命令启动官方 TUI。
	args := []string{}
	if !interactive {
		args = append(args, "exec")
	}
	// YOLO 对应本机 Codex CLI 的完整绕过模式：不等待批准、不启用 sandbox，
	// 并允许在非 Git 目录执行。它必须由角色配置显式开启，普通 Codex 仍保留
	// 官方默认保护。
	if o.Role.Custom["execution_mode"] == "yolo" {
		args = append(args, "--dangerously-bypass-approvals-and-sandbox")
	}
	if !interactive && (o.SkipGitCheck || o.Role.Custom["execution_mode"] == "yolo") {
		// --skip-git-repo-check 是 exec 子命令参数；交互 TUI 不接受它。
		// 非 git 项目 + safe 模式由执行器注入；yolo 自带该参数。
		args = append(args, "--skip-git-repo-check")
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

func (a *codexAdapter) Warnings(o ExecutionRequest) []string {
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
	if len(o.Role.Skills) > 0 {
		ws = append(ws, "dsh 技能走 profile 插件体系（dsh plugin --profile ... add）与 agent 预设（preset），角色 skills 字段暂不生效")
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

// dsh schema 对齐 dsh web 的实现：preset 选 agent 组装，provider/model/
// reasoning_effort 构成 ModelSelection（会话创建后经 session.selectModel 应用），
// 同时保留通用角色字段（system_prompt→persona）与批处理 profile 选择。
func (a *dshAdapter) Schema() []Field {
	return []Field{
		{Key: "model", Label: "模型", Type: "text", Group: "模型与指令",
			Placeholder: "如 deepseek-chat",
			Help:        "dsh 会话创建后会结合 provider 通过 session.selectModel 应用；批处理仍由 profile 的 agent-default-model 决定，不直接传 CLI"},
		{Key: "provider", Label: "模型提供商", Type: "text", Group: "模型与指令",
			Placeholder: "如 deepseek / pi-ai",
			Help:        "dsh web 的 ModelSelection.provider；与 model 一起填写时，会话创建后会调用 session.selectModel"},
		{Key: "reasoning_effort", Label: "推理强度", Type: "text", Group: "模型与指令",
			Placeholder: "如 low / medium / high",
			Help:        "dsh web 的 ModelSelection.reasoningEffort；可选，与 provider/model 一起在会话创建后应用"},
		{Key: "system_prompt", Label: "系统提示词", Type: "textarea", Group: "模型与指令",
			Placeholder: "角色定位、行为规范",
			Help:        "原生映射为 DSH_TUI_PERSONA（dsh-system-prompt 的 persona）：替换默认角色定位；如需保留默认请把默认内容并进这里"},
		{Key: "instructions", Label: "指令", Type: "textarea", Group: "模型与指令",
			Placeholder: "任务指令模板：每次执行前固定追加的指示",
			Help:        "与系统提示词不同：这是每次任务的固定指令前缀，在任务提示词之前注入（dsh 以提示词文本方式生效）"},
		{Key: "preset", Label: "Agent 预设（模式）", Type: "text", Group: "执行",
			Suggestions: dshPresetCandidates(),
			Placeholder: "留空用 roster 默认；如 standard / code / minimal / cordis",
			Help:        "原生映射为 DSH_TUI_PRESET / session.create 的 agentPreset：按 dsh-agent-presets 的 roster 选择 agent 模式（工具组合/提示词结构），如 standard、code、minimal、cordis 或 $DSH_HOME/.agent-presets 下已安装的自定义预设"},
		{Key: "profile", Label: "dsh profile", Type: "text", Group: "执行",
			Suggestions: []string{"", "headless"},
			Placeholder: "留空用 headless（一次性批处理）",
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
