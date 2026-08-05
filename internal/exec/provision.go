// ProvisionStatus：探测本机各 coding agent CLI 的安装/版本/登录状态。
// 结果带 60s 缓存（版本探测需要拉起子进程，Dashboard 每次加载 + SSE 事件都会读取）。
package exec

import (
	"context"
	"os"
	"path/filepath"
	osexec "os/exec"
	"strings"
	"sync"
	"time"
)

// ProvisionInfo 是单个 CLI 的安装/登录状态。
type ProvisionInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Docs      string `json:"docs"`
	Installed bool   `json:"installed"`
	Version   string `json:"version"`
	Login     bool   `json:"login"`
	// InstallCmd 官方安装命令（Web 一键执行）；LoginHint 登录引导说明。
	InstallCmd string `json:"install_cmd"`
	LoginHint  string `json:"login_hint"`
}

// InstallCommands 各 CLI 官方安装命令（实施时按官方文档核实）。
var InstallCommands = map[string]string{
	"claude":   "curl -fsSL https://claude.ai/install.sh | bash",
	"codex":    "npm install -g @openai/codex",
	"opencode": "npm install -g opencode-ai",
	"pi":       "npm install -g @earendil-works/pi-coding-agent",
	"omp":      "curl -fsSL https://omp.sh/install | sh",
}

// LoginHints 各 CLI 登录引导（手动登录可接受，能自动化的尽量自动化）。
var LoginHints = map[string]string{
	"claude":   "在服务器终端执行 claude 并完成登录（或访问 console.anthropic.com 获取凭据）",
	"codex":    "在服务器终端执行 codex login（浏览器授权一次即可）",
	"opencode": "在服务器终端执行 opencode auth login（浏览器授权）",
	"pi":       "在服务器终端执行 pi auth login，或运行 pi 后输入 /account",
	"omp":      "运行 omp 后用 /login 选择提供商登录（如 /login claude）；模型切换用 /model，也可先 omp setup 配置默认模型",
}

var provisionCache struct {
	sync.Mutex
	at   time.Time
	info []ProvisionInfo
}

// ProvisionStatus 返回所有适配器 CLI 的安装/版本/登录状态。
func ProvisionStatus() []ProvisionInfo {
	provisionCache.Lock()
	defer provisionCache.Unlock()
	if provisionCache.info != nil && time.Since(provisionCache.at) < 60*time.Second {
		return provisionCache.info
	}
	home, _ := os.UserHomeDir()
	loginPaths := map[string][]string{
		// 各 CLI 的登录凭据文件（存在即视为已登录；手动登录也落在这里）
		"claude":   {filepath.Join(home, ".claude", ".credentials.json")},
		"codex":    {filepath.Join(home, ".codex", "auth.json")},
		"opencode": {filepath.Join(home, ".local", "share", "opencode", "auth.json")},
		"pi":       {filepath.Join(home, ".pi", "agent", "auth.json")},
		"omp":      {filepath.Join(home, ".omp", "agent", "auth.json"), filepath.Join(home, ".pi", "agent", "auth.json")},
	}
	adapters := Adapters()
	out := make([]ProvisionInfo, 0, len(adapters))
	for _, a := range adapters {
		info := ProvisionInfo{ID: a.ID(), Name: a.Name(), Docs: a.Docs(),
			InstallCmd: InstallCommands[a.ID()], LoginHint: LoginHints[a.ID()]}
		if v := cliVersion(a.ID()); v != "" {
			info.Installed = true
			info.Version = v
		}
		for _, p := range loginPaths[a.ID()] {
			if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
				info.Login = true
				break
			}
		}
		out = append(out, info)
	}
	provisionCache.info = out
	provisionCache.at = time.Now()
	return out
}

// cliVersion 执行 <cli> --version（2s 超时），失败返回空串。
func cliVersion(id string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	b, err := osexec.CommandContext(ctx, id, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
