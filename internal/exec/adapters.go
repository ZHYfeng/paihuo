// Package exec 实现 CLI 适配器层与任务执行器。
// 适配器把「角色配置 + 任务」翻译为各 CLI 的原生非交互命令。
package exec

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"paihuo/internal/store"
)

// RunOptions 是一次执行的完整输入。
type RunOptions struct {
	Dir        string // 项目目录
	Prompt     string // 任务提示词（已含权限模式修饰）
	Role       store.RoleConfig
	Perm       string // 任务权限模式：full | review
	SessionDir string // 任务专属会话目录（会话隔离，互不干扰）
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

func (a *baseAdapter) ID() string   { return a.id }
func (a *baseAdapter) Name() string { return a.name }

func (a *baseAdapter) Detect() (string, error) {
	p, err := exec.LookPath(a.bin)
	if err != nil {
		return "", fmt.Errorf("未找到 CLI「%s」，请先安装 %s", a.bin, a.name)
	}
	return p, nil
}

func mergeEnv(extra map[string]string) []string {
	env := os.Environ()
	for k, v := range extra {
		env = append(env, k+"="+v)
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
// skills→--add-dir；thinking low→--smol / high→--slow；plugins→--config。

type ompAdapter struct{ baseAdapter }

func (a *ompAdapter) Build(o RunOptions) (string, []string, []string, error) {
	args := []string{"-p", o.Prompt, "--no-pty"}
	if o.SessionDir != "" {
		args = append(args, "--session-dir", o.SessionDir)
	}
	if m := o.Role.Model; m != "" {
		args = append(args, "--model", m)
	}
	if s := o.Role.SystemPrompt; s != "" {
		args = append(args, "--append-system-prompt", s)
	}
	for _, d := range o.Role.Skills {
		args = append(args, "--add-dir", d)
	}
	switch o.Role.Thinking {
	case "low":
		args = append(args, "--smol")
	case "high":
		args = append(args, "--slow")
	}
	for _, p := range o.Role.Plugins {
		args = append(args, "--config", p)
	}
	args = append(args, o.Role.ExtraArgs...)
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *ompAdapter) Warnings(o RunOptions) []string { return nil }

// ---------------------------------------------------------------------------
// opencode：opencode run --dir <dir> "提示词"
// 角色映射：model→--model；thinking→--variant（minimal/high）；skills→项目内 .opencode/skills 原生支持。

type openCodeAdapter struct{ baseAdapter }

func (a *openCodeAdapter) Build(o RunOptions) (string, []string, []string, error) {
	args := []string{"run", "--dir", o.Dir}
	if m := o.Role.Model; m != "" {
		args = append(args, "--model", m)
	}
	switch o.Role.Thinking {
	case "low":
		args = append(args, "--variant", "minimal")
	case "high":
		args = append(args, "--variant", "high")
	}
	args = append(args, o.Role.ExtraArgs...)
	args = append(args, o.Prompt)
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *openCodeAdapter) Warnings(o RunOptions) []string {
	var ws []string
	if o.Role.SystemPrompt != "" {
		ws = append(ws, "opencode run 不支持 --system-prompt；角色提示词请通过 opencode agent 定义或 ExtraArgs 传入")
	}
	if len(o.Role.Plugins) > 0 {
		ws = append(ws, "opencode 插件按项目/全局配置管理，角色 plugins 字段不生效")
	}
	if len(o.Role.Skills) > 0 {
		ws = append(ws, "opencode 技能读取项目内 .opencode/skills 目录，角色 skills 字段不生效")
	}
	return ws
}

// ---------------------------------------------------------------------------
// pi：pi -p "提示词"
// 角色映射：model→--model；system_prompt→--append-system-prompt；其余走 ExtraArgs。

type piAdapter struct{ baseAdapter }

func (a *piAdapter) Build(o RunOptions) (string, []string, []string, error) {
	args := []string{"-p", o.Prompt}
	if o.SessionDir != "" {
		args = append(args, "--session-dir", o.SessionDir)
	}
	if m := o.Role.Model; m != "" {
		args = append(args, "--model", m)
	}
	if s := o.Role.SystemPrompt; s != "" {
		args = append(args, "--append-system-prompt", s)
	}
	args = append(args, o.Role.ExtraArgs...)
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *piAdapter) Warnings(o RunOptions) []string {
	var ws []string
	if len(o.Role.Skills) > 0 {
		ws = append(ws, "pi 无 --add-dir 参数，skills 字段不生效（可用 ExtraArgs 传入）")
	}
	if len(o.Role.Plugins) > 0 {
		ws = append(ws, "pi 插件通过 pi install 全局管理，角色 plugins 字段不生效")
	}
	if o.Role.Thinking != "" {
		ws = append(ws, "pi 无思考级别参数，thinking 字段不生效（改用 --model 或 ExtraArgs）")
	}
	return ws
}

// ---------------------------------------------------------------------------
// claude：claude -p "提示词"
// 角色映射：model→--model；system_prompt→--append-system-prompt；skills→--add-dir。

type claudeAdapter struct{ baseAdapter }

func (a *claudeAdapter) Build(o RunOptions) (string, []string, []string, error) {
	args := []string{"-p", o.Prompt}
	if m := o.Role.Model; m != "" {
		args = append(args, "--model", m)
	}
	if s := o.Role.SystemPrompt; s != "" {
		args = append(args, "--append-system-prompt", s)
	}
	for _, d := range o.Role.Skills {
		args = append(args, "--add-dir", d)
	}
	args = append(args, "--permission-mode", "acceptEdits")
	args = append(args, o.Role.ExtraArgs...)
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *claudeAdapter) Warnings(o RunOptions) []string {
	if o.Role.Thinking != "" {
		return []string{"claude 无思考级别参数，thinking 字段不生效（改用 --model 或 ExtraArgs）"}
	}
	if len(o.Role.Plugins) > 0 {
		return []string{"claude 插件在 CLI 层管理，角色 plugins 字段不生效"}
	}
	return nil
}

// ---------------------------------------------------------------------------
// codex：codex exec "提示词"
// 角色映射：model→-c model="..."；system_prompt→-c system_prompt="..."；
// thinking→-c reasoning_effort="..."。

type codexAdapter struct{ baseAdapter }

func (a *codexAdapter) Build(o RunOptions) (string, []string, []string, error) {
	args := []string{"exec"}
	if m := o.Role.Model; m != "" {
		args = append(args, "-c", "model="+tomlQuote(m))
	}
	if s := o.Role.SystemPrompt; s != "" {
		args = append(args, "-c", "system_prompt="+tomlQuote(s))
	}
	switch o.Role.Thinking {
	case "low":
		args = append(args, "-c", `reasoning_effort="minimal"`)
	case "high":
		args = append(args, "-c", `reasoning_effort="high"`)
	}
	args = append(args, o.Role.ExtraArgs...)
	args = append(args, o.Prompt)
	return a.bin, args, mergeEnv(o.Role.Env), nil
}

func (a *codexAdapter) Warnings(o RunOptions) []string {
	var ws []string
	if len(o.Role.Skills) > 0 {
		ws = append(ws, "codex 无技能目录参数，skills 字段不生效")
	}
	if len(o.Role.Plugins) > 0 {
		ws = append(ws, "codex 插件通过 MCP/全局配置管理，角色 plugins 字段不生效")
	}
	return ws
}

// tomlQuote 把字符串转成 TOML 基本字符串字面量（用于 -c key=value）。
func tomlQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\r`)
	s = strings.ReplaceAll(s, "\t", `\t`)
	return `"` + s + `"`
}
