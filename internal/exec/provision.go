// ProvisionStatus：探测本机各 coding agent CLI 的安装/版本/登录状态。
// 结果带 60s 缓存（版本探测需要拉起子进程，Dashboard 每次加载 + SSE 事件都会读取）。
package exec

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	osexec "os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ProvisionInfo 是单个 CLI 的安装/登录状态。
type ProvisionInfo struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Docs      string           `json:"docs"`
	Installed bool             `json:"installed"`
	Version   string           `json:"version"`
	Login     bool             `json:"login"`
	Auth      CredentialStatus `json:"auth"`
	// InstallCmd 官方安装命令（Web 一键执行）；LoginHint 登录引导说明。
	InstallCmd string `json:"install_cmd"`
	LoginHint  string `json:"login_hint"`
}

// InstallCommands 各 CLI 官方安装命令（实施时按官方文档核实）。
var InstallCommands = map[string]string{
	"claude": "curl -fsSL https://claude.ai/install.sh | bash",
	"codex":  "npm install -g @openai/codex",
	"pi":     "curl -fsSL https://pi.dev/install.sh | sh",
	"dsh":    "npm install -g @deepseek-ai/dsh",
}

// LoginHints 各 CLI 登录引导（手动登录可接受，能自动化的尽量自动化）。
var LoginHints = map[string]string{
	"claude": "在服务器终端执行 claude 并完成登录（或访问 console.anthropic.com 获取凭据）",
	"codex":  "在服务器终端执行 codex login（浏览器授权一次即可）",
	"pi":     "运行 pi 后用 /login 选择提供商（订阅登录或 API key）；也可 export ANTHROPIC_API_KEY=... 后直接使用",
	"dsh":    "凭据存于 $DSH_HOME/.credentials.yaml（如 DEEPSEEK_API_KEY）；provider/model 在 dsh profile 配置或 TUI 内切换",
}

var provisionCache struct {
	sync.Mutex
	at   time.Time
	info []ProvisionInfo
	key  [32]byte
}

// ProvisionStatus 返回默认 Runtime 目录的安装/版本/登录状态。
func ProvisionStatus() []ProvisionInfo {
	provisionCache.Lock()
	defer provisionCache.Unlock()
	env := os.Environ()
	sort.Strings(env)
	cwd, _ := os.Getwd()
	key := sha256.Sum256([]byte(cwd + "\x00" + strings.Join(env, "\x00")))
	if provisionCache.info != nil && provisionCache.key == key && time.Since(provisionCache.at) < 60*time.Second {
		return provisionCache.info
	}
	adapters := commandAdapters()
	out := make([]ProvisionInfo, len(adapters))
	var wg sync.WaitGroup
	for i, a := range adapters {
		wg.Add(1)
		go func() {
			defer wg.Done()
			info := ProvisionInfo{ID: a.ID(), Name: a.Name(), Docs: a.Docs(),
				InstallCmd: InstallCommands[a.ID()], LoginHint: LoginHints[a.ID()]}
			if _, err := osexec.LookPath(a.ID()); err == nil {
				info.Installed = true
				info.Version = cliVersion(a.ID())
			}
			info.Auth = inspectCredentials(a.ID())
			info.Login = info.Auth.Status == "authenticated" || info.Auth.Status == "configured"
			out[i] = info
		}()
	}
	wg.Wait()
	provisionCache.info = out
	provisionCache.at = time.Now()
	provisionCache.key = key
	return out
}

// RefreshProvisionStatus 使安装和凭据变化立即可见，而不是等待缓存过期。
func RefreshProvisionStatus() {
	provisionCache.Lock()
	provisionCache.info = nil
	provisionCache.Unlock()
}

// CredentialStatus 只包含检测结论，不包含凭据或 CLI 原始输出。
// authenticated 表示 CLI 已识别登录；configured 仅表示发现本地凭据配置，
// 两者均不代表已经通过远端推理请求验证。
type CredentialStatus struct {
	Status  string `json:"status"`
	Source  string `json:"source,omitempty"`
	Method  string `json:"method,omitempty"`
	Message string `json:"message,omitempty"`
}

func inspectCredentials(id string) CredentialStatus {
	if id == "codex" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := osexec.CommandContext(ctx, "codex", "login", "status")
		cmd.WaitDelay = 100 * time.Millisecond
		raw, err := cmd.CombinedOutput()
		output := strings.TrimSpace(string(raw))
		if err == nil && strings.HasPrefix(output, "Logged in using ") {
			return CredentialStatus{Status: "authenticated", Source: "CLI", Message: "CLI 已识别登录；未发起远端验证"}
		}
		if strings.EqualFold(output, "Not logged in") {
			return CredentialStatus{Status: "missing", Source: "CLI", Message: "CLI 未识别登录"}
		}
	}
	if id == "claude" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := osexec.CommandContext(ctx, "claude", "auth", "status", "--json")
		cmd.WaitDelay = 100 * time.Millisecond
		raw, _ := cmd.Output()
		var status struct {
			LoggedIn *bool `json:"loggedIn"`
		}
		if json.Unmarshal(raw, &status) == nil && status.LoggedIn != nil {
			if *status.LoggedIn {
				return CredentialStatus{Status: "authenticated", Source: "CLI", Message: "CLI 已识别登录；未发起远端验证"}
			}
			return CredentialStatus{Status: "missing", Source: "CLI", Message: "CLI 未识别登录"}
		}
	}
	status := inspectFileCredentials(id)
	if status.Status == "missing" && (id == "claude" || id == "codex") {
		if _, err := osexec.LookPath(id); err == nil {
			return CredentialStatus{Status: "unknown", Source: "CLI", Message: "CLI 凭据检测失败，未能确认登录状态"}
		}
	}
	return status
}

func runtimeConfigDir(envKey, defaultDir string) string {
	home, _ := os.UserHomeDir()
	if dir := strings.TrimSpace(os.Getenv(envKey)); dir != "" {
		if strings.HasPrefix(dir, "~/") {
			dir = filepath.Join(home, dir[2:])
		}
		return filepath.Clean(dir)
	}
	return filepath.Join(home, defaultDir)
}

func inspectProvision(a commandAdapter) ProvisionInfo {
	for _, info := range ProvisionStatus() {
		if info.ID == a.ID() {
			return info
		}
	}
	return ProvisionInfo{ID: a.ID(), Name: a.Name(), Docs: a.Docs(),
		InstallCmd: InstallCommands[a.ID()], LoginHint: LoginHints[a.ID()]}
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
