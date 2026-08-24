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
// ---------------------------------------------------------------------------
// pi：`pi --list-models`（权威：按 auth.json 凭据只列实际可用模型，表格式
// provider model ...）；失败回退 settings.json（defaultProvider/defaultModel）
// + models-store.json（只取有凭据的 provider）。
// 候选一律 provider/model 限定形式：裸 id 在多个 provider 存在同名模型时
// 有歧义（如本机 deepseek 与 opencode-go 都有 deepseek-v4-flash），pi 对
// `--model 裸id` 的解析取决于其模型文件里的 provider 顺序，用户从候选里
// 选出来的模型可能与实际解析到的 provider 不一致。

func (a *piAdapter) Models() []string {
	return cachedModels("pi", func() []string {
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, ".pi", "agent")
		var st struct {
			DefaultProvider string `json:"defaultProvider"`
			DefaultModel    string `json:"defaultModel"`
		}
		readJSONFile(filepath.Join(dir, "settings.json"), &st)

		var out []string
		seen := map[string]bool{}
		add := func(s string) {
			if s != "" && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}

		// 权威来源：pi --list-models 按实际凭据过滤（无凭据的 provider 不会出现）。
		if raw, ok := cliOutput(probeTimeout, "pi", "--list-models"); ok {
			out = piModelCandidates(st.DefaultProvider, st.DefaultModel, piListModelsRows(raw))
			if len(out) > 0 {
				saveModelsDisk("pi", out)
				return capModels(out, 60)
			}
		}
		// 命令超时/失败：优先复用最近一次成功结果，避免候选缩水到配置里的 1~2 个
		if disk := loadModelsDisk("pi"); disk != nil {
			return disk
		}

		// 回退：models-store.json 只取有凭据（auth.json）的 provider，
		// 避免列出无法使用的模型（如未登录的 anthropic/openai-codex 目录）。
		cred := map[string]bool{st.DefaultProvider: true}
		var auth map[string]json.RawMessage
		readJSONFile(filepath.Join(dir, "auth.json"), &auth)
		for k := range auth {
			cred[k] = true
		}

		// models-store.json: {"<provider>": {"models": [{"id": ...}]}}
		provMap := map[string][]string{}
		if raw, err := os.ReadFile(filepath.Join(dir, "models-store.json")); err == nil {
			var m map[string]json.RawMessage
			if json.Unmarshal(raw, &m) == nil {
				for prov, v := range m {
					var pv struct {
						Models []struct {
							ID string `json:"id"`
						} `json:"models"`
					}
					if json.Unmarshal(v, &pv) == nil {
						for _, md := range pv.Models {
							if md.ID != "" {
								provMap[prov] = append(provMap[prov], md.ID)
							}
						}
					}
				}
			}
		}
		provs := make([]string, 0, len(provMap))
		for p := range provMap {
			provs = append(provs, p)
		}
		// 默认 provider 排最前，其余按字母序
		sort.Slice(provs, func(i, j int) bool {
			if provs[i] == st.DefaultProvider {
				return true
			}
			if provs[j] == st.DefaultProvider {
				return false
			}
			return provs[i] < provs[j]
		})
		for _, prov := range provs {
			if !cred[prov] {
				continue
			}
			for _, id := range provMap[prov] {
				add(prov + "/" + id) // 一律限定形式：裸 id 跨 provider 有歧义
			}
		}
		return capModels(out, 60)
	})
}

// piListModelsRows 解析 `pi --list-models` 的表格式输出（跳过表头行），
// 返回 (provider, model) 对。
func piListModelsRows(raw string) [][2]string {
	var rows [][2]string
	for _, line := range strings.Split(raw, "\n") {
		fs := strings.Fields(line)
		if len(fs) < 2 || fs[0] == "provider" && fs[1] == "model" {
			continue // 表头行
		}
		rows = append(rows, [2]string{fs[0], fs[1]})
	}
	return rows
}

// piModelCandidates 从 (provider, model) 行构建 pi 模型候选：
// 全部用 provider/model 限定形式（裸 id 跨 provider 有歧义，见 piAdapter.Models
// 注释）；默认 provider 的模型排最前，默认模型永远是第一条候选。
func piModelCandidates(defaultProvider, defaultModel string, rows [][2]string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	if defaultProvider != "" && defaultModel != "" {
		add(defaultProvider + "/" + defaultModel)
	}
	for _, r := range rows {
		if r[0] == defaultProvider {
			add(r[0] + "/" + r[1])
		}
	}
	for _, r := range rows {
		if r[0] != defaultProvider {
			add(r[0] + "/" + r[1])
		}
	}
	return out
}
