package exec

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"paihuo/internal/store"
)

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
// codex：~/.codex/models_cache.json（models[].slug）+ config.toml 的 model=。
// models_cache 同时含 visibility 与 supported_reasoning_levels；前者为 hide
// 的是 CLI 内部路由别名（如 sol-wm），不应出现在角色可选模型中。
// （codex 无公开的模型列表命令；按实例实际配置枚举。）

var codexModelRe = regexp.MustCompile(`(?m)^\s*model\s*=\s*"([^"]+)"`)

func (a *codexAdapter) Models() []string {
	return cachedModels("codex", func() []string {
		return capModels(ModelIDs(a.ModelCatalog()), 60)
	})
}

// ModelCatalog 返回 Codex 本机模型缓存中明确声明的能力。这里直接读本机文件
// （无网络/子进程开销）；Models 仍有缓存，避免影响其它仅需候选列表的路径。
func (a *codexAdapter) ModelCatalog() []ModelInfo {
	home, _ := os.UserHomeDir()
	return capModelInfo(codexModelsProbe(home), 60)
}

// codexModelsProbe 是 Codex 本机目录解析，home 可注入以便测试。
func codexModelsProbe(home string) []ModelInfo {
	var out []ModelInfo
	pos := map[string]int{}
	hidden := map[string]bool{}
	add := func(m ModelInfo) {
		m.ID = strings.TrimSpace(m.ID)
		m.ThinkingLevels = uniqueModelStrings(m.ThinkingLevels)
		if m.ID == "" {
			return
		}
		if i, ok := pos[m.ID]; ok {
			// 配置文件里的同名 model 只能补充候选，不能抹掉缓存已知能力。
			if len(out[i].ThinkingLevels) == 0 && len(m.ThinkingLevels) > 0 {
				out[i].ThinkingLevels = m.ThinkingLevels
			}
			return
		}
		pos[m.ID] = len(out)
		out = append(out, m)
	}

	var cache struct {
		Models []struct {
			Slug       string `json:"slug"`
			Visibility string `json:"visibility"`
			Reasoning  []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	readJSONFile(filepath.Join(home, ".codex", "models_cache.json"), &cache)
	for _, m := range cache.Models {
		if strings.TrimSpace(m.Visibility) == "hide" {
			hidden[m.Slug] = true
			continue
		}
		levels := make([]string, 0, len(m.Reasoning))
		for _, r := range m.Reasoning {
			levels = append(levels, r.Effort)
		}
		add(ModelInfo{ID: m.Slug, ThinkingLevels: levels})
	}
	if b, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml")); err == nil {
		for _, m := range codexModelRe.FindAllStringSubmatch(string(b), -1) {
			// 不因为当前配置恰好写了内部隐藏别名就把它重新暴露到 UI。
			if !hidden[m[1]] {
				add(ModelInfo{ID: m[1]})
			}
		}
	}
	return out
}

func capModelInfo(in []ModelInfo, n int) []ModelInfo {
	if len(in) > n {
		return in[:n]
	}
	return in
}
