package exec

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	_ "modernc.org/sqlite"
	"paihuo/internal/store"
)

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
// ---------------------------------------------------------------------------
// omp：`omp models --json`（权威：按凭据只列实际可用模型，selector 即
// provider/model）；失败回退 config.yml（modelRoles）+ models.yml +
// models.db（model_cache 只取权威行）。

func (a *ompAdapter) Models() []string {
	return capModels(ModelIDs(a.ModelCatalog()), 80)
}

func (a *ompAdapter) ModelCatalog() []ModelInfo {
	return cachedModelCatalog("omp", func() []ModelInfo {
		home, _ := os.UserHomeDir()
		return ompModelCatalogProbe(home)
	})
}

// parseOmpModelsJSON 解析 `omp models --json` 的模型能力目录。OMP 的
// `thinking` 是每个模型真实支持的档位，不能用 reasoning=true 猜测出一组
// 全局选项；例如某个模型可能只声明 ["high", "max"]。
func parseOmpModelsJSON(raw string) []ModelInfo {
	var payload struct {
		Models []struct {
			Selector string   `json:"selector"`
			Provider string   `json:"provider"`
			ID       string   `json:"id"`
			Thinking []string `json:"thinking"`
		} `json:"models"`
	}
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return nil
	}
	out := make([]ModelInfo, 0, len(payload.Models))
	pos := make(map[string]int, len(payload.Models))
	for _, md := range payload.Models {
		id := strings.TrimSpace(md.Selector)
		if id == "" && md.Provider != "" && md.ID != "" {
			id = strings.TrimSpace(md.Provider) + "/" + strings.TrimSpace(md.ID)
		}
		addModelInfo(&out, pos, ModelInfo{ID: id, ThinkingLevels: md.Thinking})
	}
	return out
}

func ompModelCatalogProbe(home string) []ModelInfo {
	// 权威来源：omp models --json 按实际凭据过滤，并直接提供逐模型 thinking。
	if raw, ok := cliOutput(probeTimeout, "omp", "models", "--json"); ok {
		out := parseOmpModelsJSON(raw)
		if len(out) > 0 {
			ids := ModelIDs(out)
			saveModelsDisk("omp", ids)
			return capModelInfo(out, 80)
		}
	}
	// 命令超时/失败：磁盘缓存只保留模型 ID，不伪造 thinking 能力。
	if disk := loadModelsDisk("omp"); disk != nil {
		return capModelInfo(modelInfosFromIDs(disk), 80)
	}
	return capModelInfo(ompModelsFallbackCatalog(home), 80)
}

// ompModelsFallback 是 omp 探测的命令失败/超时时的配置回退：
// config.yml（modelRoles）+ models.yml + models.db（model_cache 只取
// 权威行，且再按凭据仍然有效的 provider 过滤）。
func ompModelsFallback(home string) []string {
	return capModels(ModelIDs(ompModelsFallbackCatalog(home)), 80)
}

func ompModelsFallbackCatalog(home string) []ModelInfo {
	var out []ModelInfo
	pos := map[string]int{}
	add := func(s string) { addModelInfo(&out, pos, ModelInfo{ID: s}) }
	addInfo := func(m ModelInfo) { addModelInfo(&out, pos, m) }

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
				thinking := ""
				if i := strings.LastIndex(v, ":"); i > 0 && !strings.Contains(v[i:], "/") {
					thinking = strings.TrimSpace(v[i+1:])
					v = v[:i] // 去掉 :thinking 后缀
				}
				// 这是用户配置中明确使用过的档位，不是根据模型名猜测；
				// 命令探测失败时至少保留这条已验证的能力信息。
				addInfo(ModelInfo{ID: v, ThinkingLevels: []string{thinking}})
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
					Provider string   `json:"provider"`
					ID       string   `json:"id"`
					Thinking []string `json:"thinking"`
				}
				if json.Unmarshal(b, &ms) == nil {
					for _, m := range ms {
						if m.ID != "" && (cred == nil || cred[m.Provider]) {
							addInfo(ModelInfo{ID: m.Provider + "/" + m.ID, ThinkingLevels: m.Thinking})
						}
					}
				}
			}
		}
	}
	return out
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
