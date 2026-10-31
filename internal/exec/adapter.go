// Package exec implements Runtime selection, command translation, and task execution.
package exec

import (
	"fmt"
	"os"
	"os/exec"
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

// ExitCommand 默认 /exit（claude/codex 的交互退出命令）。
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
func MergeEnv(extra map[string]string) []string { return mergeEnv(extra) }

// ReserveRoleSlot / ReleaseRoleSlot 是 Executor 角色并发槽位的导出入口，
// 供会话管理器（internal/session）与批处理任务共用同一并发池。
func (e *Executor) ReserveRoleSlot(roleID int64, limit int) bool {
	return e.reserveRoleSlot(roleID, limit)
}
func (e *Executor) ReleaseRoleSlot(roleID int64) { e.releaseRoleSlot(roleID) }
