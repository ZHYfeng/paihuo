// 模型候选探测：从本机各 CLI 实例的实际配置/目录里枚举可用模型，
// 而不是硬编码「常用模型」。结果带 60s 内存缓存，磁盘/命令探测失败时优雅降级为空。
//
// 权威来源是各 CLI 自带的模型列表命令（pi --list-models / omp models --json /
// opencode models）：它们只列出本实例「实际可用」的模型（按凭据过滤），
// 而配置缓存文件（models-store.json / models.db）会包含无凭据 provider 的
// 全量目录，直接解析会列出不可用的模型。
package exec

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	osexec "os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// modelsCacheTTL：模型候选缓存时长。探测要跑各 CLI 的命令（秒级），
// 而模型列表变化极低频（装新 provider / 改配置才变），60s TTL 会让
// 每次打开页面（距上次超过 1 分钟）都重复付一遍探测开销，直接拖慢
// /api/agents/schema，进而卡住前端首屏。调成 1 小时。
const modelsCacheTTL = time.Hour

// probeTimeout：模型列表命令的超时。这些命令（pi --list-models /
// omp models --json / opencode models）冷启动要拉起 Node 进程，正常
// 5~6s，但偶发走目录刷新/网络路径会拖到 15~20s（实测 2025：opencode
// models 5.5~20.8s、omp models 4.5~15.3s、pi --list-models 2.4~9.2s）。
// 超时太短会触发配置回退，列出 agent 实际**不可用**的模型：opencode
// 回退只剩 opencode.json 的 small_model；omp 回退 models.db 会带出
// 无凭据/凭据已删除的 provider 目录（如 zenmux）。探测带 1h 缓存且
// 后台并行加载，宽松超时几乎零成本——留 30s 保证权威命令总能跑完。
const probeTimeout = 30 * time.Second

var modelsCache struct {
	sync.Mutex
	at    time.Time
	items map[string][]string
	busy  map[string]chan struct{} // 进行中的探测：并发请求合并为一次，共享结果
}

// cachedModels 按适配器 id 缓存探测结果（TTL 内复用）。
// 同一 id 的并发探测合并：后来的请求等先发者完成，避免重复跑 CLI。
func cachedModels(id string, probe func() []string) []string {
	modelsCache.Lock()
	if modelsCache.items == nil || time.Since(modelsCache.at) > modelsCacheTTL {
		modelsCache.items = map[string][]string{}
		modelsCache.busy = map[string]chan struct{}{}
		modelsCache.at = time.Now()
	}
	if v, ok := modelsCache.items[id]; ok {
		modelsCache.Unlock()
		return v
	}
	if ch, ok := modelsCache.busy[id]; ok {
		// 已有请求在探测：等它完成，直接复用结果。
		// 注意：探测期间不持有全局锁，各 CLI 探测可并行。
		modelsCache.Unlock()
		<-ch
		modelsCache.Lock()
		v := modelsCache.items[id]
		modelsCache.Unlock()
		return v
	}
	ch := make(chan struct{})
	modelsCache.busy[id] = ch
	modelsCache.Unlock()

	v := probe()

	modelsCache.Lock()
	modelsCache.items[id] = v
	delete(modelsCache.busy, id)
	close(ch)
	modelsCache.Unlock()
	return v
}

func capModels(in []string, n int) []string {
	if len(in) > n {
		in = in[:n]
	}
	return in
}

// readJSONFile 读 JSON 文件到 v；失败静默忽略（探测容错）。
func readJSONFile(path string, v any) {
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, v)
	}
}

// cliOutput 运行 CLI 命令并返回 stdout；超时/失败时 ok=false。
func cliOutput(timeout time.Duration, name string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	b, err := osexec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return "", false
	}
	return string(b), true
}

// ---------------------------------------------------------------------------
// pi：`pi --list-models`（权威：按 auth.json 凭据只列实际可用模型，表格式
// provider model ...）；失败回退 settings.json（defaultProvider/defaultModel）
// + models-store.json（只取有凭据的 provider）。

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
		add(st.DefaultModel)
		add(st.DefaultProvider + "/" + st.DefaultModel)

		// 权威来源：pi --list-models 按实际凭据过滤（无凭据的 provider 不会出现）。
		if raw, ok := cliOutput(probeTimeout, "pi", "--list-models"); ok {
			for _, line := range strings.Split(raw, "\n") {
				fs := strings.Fields(line)
				if len(fs) < 2 || fs[0] == "provider" && fs[1] == "model" {
					continue // 表头行
				}
				prov, model := fs[0], fs[1]
				if prov == st.DefaultProvider {
					add(model) // 默认 provider：裸 id 即可
				}
				add(prov + "/" + model)
			}
			if len(out) > 0 {
				return capModels(out, 60)
			}
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
		sort.Strings(provs)
		for _, prov := range provs {
			if !cred[prov] {
				continue
			}
			for _, id := range provMap[prov] {
				if prov == st.DefaultProvider {
					add(id) // 默认 provider：裸 id 即可
				}
				add(prov + "/" + id)
			}
		}
		return capModels(out, 60)
	})
}

// ---------------------------------------------------------------------------
// omp：`omp models --json`（权威：按凭据只列实际可用模型，selector 即
// provider/model）；失败回退 config.yml（modelRoles）+ models.yml +
// models.db（model_cache 只取权威行）。

func (a *ompAdapter) Models() []string {
	return cachedModels("omp", func() []string {
		home, _ := os.UserHomeDir()
		return ompModelsProbe(home)
	})
}

// ompModelsProbe 是 omp 的模型候选探测（home 可注入，便于测试）。
// 权威来源 `omp models --json` 按实际凭据过滤；失败时才回退解析配置
// 文件，且回退只保留凭据仍然有效的 provider（见 ompActiveProviders），
// 避免列出 agent 实际不可用的模型。
func ompModelsProbe(home string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}

	// 权威来源：omp models --json 按实际凭据过滤。
	if raw, ok := cliOutput(probeTimeout, "omp", "models", "--json"); ok {
		var m struct {
			Models []struct {
				Selector string `json:"selector"`
				Provider string `json:"provider"`
				ID       string `json:"id"`
			} `json:"models"`
		}
		if json.Unmarshal([]byte(raw), &m) == nil {
			for _, md := range m.Models {
				if md.Selector != "" {
					add(md.Selector)
				} else if md.Provider != "" && md.ID != "" {
					add(md.Provider + "/" + md.ID)
				}
			}
		}
		if len(out) > 0 {
			return capModels(out, 80)
		}
	}
	return ompModelsFallback(home)
}

// ompModelsFallback 是 omp 探测的命令失败/超时时的配置回退：
// config.yml（modelRoles）+ models.yml + models.db（model_cache 只取
// 权威行，且再按凭据仍然有效的 provider 过滤）。
func ompModelsFallback(home string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}

	agentDir := filepath.Join(home, ".omp", "agent")

	// config.yml：modelRoles 的形如 "deepseek/deepseek-v4-flash:max"
	if b, err := os.ReadFile(filepath.Join(agentDir, "config.yml")); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			k, v, ok := strings.Cut(line, ":")
			if !ok || k == "" || v == "" {
				continue
			}
			v = strings.TrimSpace(v)
			if strings.Contains(v, "/") {
				if i := strings.LastIndex(v, ":"); i > 0 && !strings.Contains(v[i:], "/") {
					v = v[:i] // 去掉 :thinking 后缀
				}
				add(v)
			}
		}
	}

	// models.yml：providers: 块（官方新格式，README "Custom OpenAI-compatible providers"）
	// 用户显式定义（自带 baseUrl/密钥），不做凭据过滤。
	if b, err := os.ReadFile(filepath.Join(agentDir, "models.yml")); err == nil {
		cur := ""
		idRe := regexp.MustCompile(`^-\s*id:\s*(\S+)`)
		for _, line := range strings.Split(string(b), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			// 2 空格缩进且以冒号结尾 = provider 名；6 空格缩进 "- id: xxx" = 模型
			if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "    ") && strings.HasSuffix(trimmed, ":") {
				cur = strings.TrimSuffix(trimmed, ":")
			} else if m := idRe.FindStringSubmatch(trimmed); m != nil && strings.HasPrefix(line, "      ") && cur != "" {
				add(cur + "/" + m[1])
			}
		}
	}

	// models.db：model_cache 表，只取 authoritative=1 的行（其余是
	// 无凭据/离线缓存的全量目录，列为候选会误导）。
	// 即使 authoritative=1，目录也可能已过期（凭据被删/停用，如本机
	// opencode-go 行凭据标记 deleted by user、zenmux 从无凭据），
	// 因此再按 auth_credentials 里凭据仍然有效的 provider 过滤。
	cred := ompActiveProviders(home)
	if db, err := sql.Open("sqlite", filepath.Join(agentDir, "models.db")); err == nil {
		defer db.Close()
		rows, err := db.Query("SELECT models FROM model_cache WHERE authoritative = 1")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var b []byte
				if rows.Scan(&b) != nil {
					continue
				}
				var ms []struct {
					Provider string `json:"provider"`
					ID       string `json:"id"`
				}
				if json.Unmarshal(b, &ms) == nil {
					for _, m := range ms {
						if m.ID != "" && (cred == nil || cred[m.Provider]) {
							add(m.Provider + "/" + m.ID)
						}
					}
				}
			}
		}
	}
	return capModels(out, 80)
}

// ompActiveProviders 返回 omp 实例中凭据仍然有效的提供商集合
// （agent.db auth_credentials，disabled_cause 为空 = 可用；为
// "deleted by user" 等 = 已停用）。读库失败返回 nil——调用方对 nil
// 不过滤（探测容错，保持旧行为）。
func ompActiveProviders(home string) map[string]bool {
	db, err := sql.Open("sqlite", filepath.Join(home, ".omp", "agent", "agent.db"))
	if err != nil {
		return nil
	}
	defer db.Close()
	rows, err := db.Query("SELECT DISTINCT provider FROM auth_credentials WHERE disabled_cause IS NULL")
	if err != nil {
		return nil
	}
	defer rows.Close()
	provs := map[string]bool{}
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil && p != "" {
			provs[p] = true
		}
	}
	return provs
}

// ---------------------------------------------------------------------------
// opencode：`opencode models` 命令输出（provider/model 每行一个）；
// 失败时回退 ~/.config/opencode/opencode.json 的 model / small_model。

func (a *openCodeAdapter) Models() []string {
	return cachedModels("opencode", func() []string {
		var out []string
		seen := map[string]bool{}
		add := func(s string) {
			if s != "" && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
		if raw, ok := cliOutput(probeTimeout, "opencode", "models"); ok {
			for _, line := range strings.Split(raw, "\n") {
				add(strings.TrimSpace(line))
			}
			if len(out) > 0 {
				return capModels(out, 60)
			}
		}
		home, _ := os.UserHomeDir()
		var cfg struct {
			Model      string `json:"model"`
			SmallModel string `json:"small_model"`
		}
		readJSONFile(filepath.Join(home, ".config", "opencode", "opencode.json"), &cfg)
		add(cfg.Model)
		add(cfg.SmallModel)
		return out
	})
}

// ---------------------------------------------------------------------------
// codex：~/.codex/models_cache.json（models[].slug）+ config.toml 的 model=。
// （codex 无公开的模型列表命令；按实例实际配置枚举。）

var codexModelRe = regexp.MustCompile(`(?m)^\s*model\s*=\s*"([^"]+)"`)

func (a *codexAdapter) Models() []string {
	return cachedModels("codex", func() []string {
		home, _ := os.UserHomeDir()
		var out []string
		seen := map[string]bool{}
		add := func(s string) {
			if s != "" && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
		var cache struct {
			Models []struct {
				Slug string `json:"slug"`
			} `json:"models"`
		}
		readJSONFile(filepath.Join(home, ".codex", "models_cache.json"), &cache)
		for _, m := range cache.Models {
			add(m.Slug)
		}
		if b, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml")); err == nil {
			for _, m := range codexModelRe.FindAllStringSubmatch(string(b), -1) {
				add(m[1])
			}
		}
		return capModels(out, 60)
	})
}

// ---------------------------------------------------------------------------
// claude：~/.claude/settings.json / settings.local.json / ~/.claude.json 的 model 字段。
// （claude 无公开的模型列表命令；按实例实际配置枚举。）

func (a *claudeAdapter) Models() []string {
	return cachedModels("claude", func() []string {
		home, _ := os.UserHomeDir()
		var out []string
		seen := map[string]bool{}
		add := func(s string) {
			if s != "" && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
		for _, f := range []string{".claude/settings.json", ".claude/settings.local.json"} {
			var cfg struct {
				Model string `json:"model"`
			}
			readJSONFile(filepath.Join(home, f), &cfg)
			add(cfg.Model)
		}
		var cfg2 struct {
			Model string `json:"model"`
		}
		readJSONFile(filepath.Join(home, ".claude.json"), &cfg2)
		add(cfg2.Model)
		return out
	})
}
