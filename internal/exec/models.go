// 模型候选探测：从本机各 CLI 实例的实际配置/目录里枚举可用模型，
// 而不是硬编码「常用模型」。结果带 60s 内存缓存，磁盘/命令探测失败时优雅降级为空。
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

var modelsCache struct {
	sync.Mutex
	at    time.Time
	items map[string][]string
}

// cachedModels 按适配器 id 缓存探测结果（60s TTL）。
func cachedModels(id string, probe func() []string) []string {
	modelsCache.Lock()
	defer modelsCache.Unlock()
	if modelsCache.items == nil || time.Since(modelsCache.at) > 60*time.Second {
		modelsCache.items = map[string][]string{}
		modelsCache.at = time.Now()
	}
	if v, ok := modelsCache.items[id]; ok {
		return v
	}
	v := probe()
	modelsCache.items[id] = v
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

// ---------------------------------------------------------------------------
// pi：~/.pi/agent/settings.json（defaultProvider/defaultModel）+ models-store.json
// （provider → models[].id）。默认 provider 的模型给裸 id，其余给 provider/id。

func (a *piAdapter) Models() []string {
	return cachedModels("pi", func() []string {
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, ".pi", "agent")
		var st struct {
			DefaultProvider string `json:"defaultProvider"`
			DefaultModel    string `json:"defaultModel"`
		}
		readJSONFile(filepath.Join(dir, "settings.json"), &st)

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
		provs := make([]string, 0, len(provMap))
		for p := range provMap {
			provs = append(provs, p)
		}
		sort.Strings(provs)
		for _, prov := range provs {
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
// omp：~/.omp/agent/config.yml（modelRoles 的 provider/model 值）+ models.db
// （model_cache 表的 JSON 模型列表：provider + id）。

func (a *ompAdapter) Models() []string {
	return cachedModels("omp", func() []string {
		home, _ := os.UserHomeDir()
		agentDir := filepath.Join(home, ".omp", "agent")
		var out []string
		seen := map[string]bool{}
		add := func(s string) {
			if s != "" && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}

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

		// models.db：model_cache 表，逐单元格尝试解析为模型 JSON 数组
		if db, err := sql.Open("sqlite", filepath.Join(agentDir, "models.db")); err == nil {
			defer db.Close()
			if rows, err := db.Query("SELECT * FROM model_cache"); err == nil {
				defer rows.Close()
				if cols, err := rows.Columns(); err == nil {
					vals := make([]any, len(cols))
					ptrs := make([]any, len(cols))
					for i := range vals {
						ptrs[i] = &vals[i]
					}
					for rows.Next() {
						if rows.Scan(ptrs...) != nil {
							continue
						}
						for _, v := range vals {
							var b []byte
							switch t := v.(type) {
							case []byte:
								b = t
							case string:
								b = []byte(t)
							default:
								continue
							}
							if len(b) < 2 || b[0] != '[' {
								continue
							}
							var ms []struct {
								Provider string `json:"provider"`
								ID       string `json:"id"`
							}
							if json.Unmarshal(b, &ms) == nil && len(ms) > 0 {
								for _, m := range ms {
									if m.ID != "" {
										add(m.Provider + "/" + m.ID)
									}
								}
								break
							}
						}
					}
				}
			}
		}
		return capModels(out, 80)
	})
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
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		if b, err := osexec.CommandContext(ctx, "opencode", "models").Output(); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
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
