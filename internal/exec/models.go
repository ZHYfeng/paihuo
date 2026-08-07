// 模型候选探测：从本机各 CLI 实例的实际配置/目录里枚举可用模型，
// 而不是硬编码「常用模型」。结果带内存缓存，磁盘/命令探测失败时优雅降级为空。
//
// 权威来源是各 CLI 自带的模型列表命令（pi --list-models / omp models --json /
// opencode models --verbose）：它们只列出本实例「实际可用」的模型（按凭据过滤），
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
// 5~6s，但偶发走目录刷新/网络路径会拖到 15~20s，甚至超过 30s（实测 2025：
// opencode models 5.5~20.8s、omp models 4.5~15.3s、pi --list-models 2.4~9.2s）。
// 超时太短会触发配置回退，列出 agent 实际**不可用**的模型：opencode
// 回退只剩 opencode.json 的 small_model；omp 回退 models.db 会带出
// 无凭据/凭据已删除的 provider 目录（如 zenmux）。探测带 1h 缓存且
// 后台并行加载，宽松超时几乎零成本——留 30s 保证权威命令总能跑完；
// 仍超时时回退优先复用磁盘上最近一次成功结果（见 loadModelsDisk）。
const probeTimeout = 30 * time.Second

// ---------------------------------------------------------------------------
// 探测结果磁盘缓存：权威命令偶发走网络目录刷新（opencode models 实测
// 20~30s+，可能超过 probeTimeout），此时若直接回退到配置文件，候选会
// 缩水到 1~2 个已配置模型。每次探测成功把候选列表落盘，命令超时/失败时
// 优先复用 24h 内最近一次成功结果——既保证候选完整，又不含不可用模型。

const modelsDiskTTL = 24 * time.Hour

func modelsDiskPath(id string) string {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "paihuo", "models-"+id+".txt")
}

// saveModelsDisk 探测成功后保存候选列表（每行一个）。失败静默忽略（探测容错）。
func saveModelsDisk(id string, models []string) {
	if len(models) == 0 {
		return
	}
	path := modelsDiskPath(id)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(path, []byte(strings.Join(models, "\n")), 0o600)
}

// loadModelsDisk 返回 24h 内最近一次成功的候选；缺失/过期返回 nil。
func loadModelsDisk(id string) []string {
	path := modelsDiskPath(id)
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	if fi, err := os.Stat(path); err == nil && time.Since(fi.ModTime()) > modelsDiskTTL {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

var modelsCache struct {
	sync.Mutex
	at          time.Time
	items       map[string][]string
	catalog     map[string][]ModelInfo
	busy        map[string]chan struct{} // 进行中的探测：并发请求合并为一次，共享结果
	catalogBusy map[string]chan struct{}
}

// modelsProbeGate 让“强制刷新”和普通读取不会相互覆盖缓存：普通探测持有读锁，
// 刷新先等待已有探测结束，再清空缓存并发起一轮新的主机探测。这样手动刷新或
// 定期刷新不会被刷新前尚未结束的 CLI 子进程写回旧结果。
var modelsProbeGate sync.RWMutex

// modelsRefreshMu 串行化并发刷新请求（例如两个浏览器同时点刷新）。
var modelsRefreshMu sync.Mutex

// ModelInfo 是从 Linux 主机上的各 CLI 配置/目录发现的模型信息。它不是角色
// 配置，也不写入 paihuo.db；数据库只保存角色选择了哪个模型及其覆盖项。
// ThinkingLevels 仅在主机来源明确声明了“该模型支持哪些档位”时才填写。
type ModelInfo struct {
	ID             string   `json:"id"`
	ThinkingLevels []string `json:"thinking_levels,omitempty"`
}

// modelCataloger 是可额外提供逐模型能力的适配器。保留 Adapter.Models 接口，
// 使现有/第三方适配器仍可只返回模型候选。
type modelCataloger interface {
	ModelCatalog() []ModelInfo
}

// ModelCatalog 返回一个适配器在本机发现的模型及已知能力。没有能力目录的 CLI
// 仍返回模型列表；此时 ThinkingLevels 留空，前端不会虚构可用档位。
func ModelCatalog(a Adapter) []ModelInfo {
	if c, ok := a.(modelCataloger); ok {
		return c.ModelCatalog()
	}
	ids := a.Models()
	out := make([]ModelInfo, 0, len(ids))
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" {
			out = append(out, ModelInfo{ID: id})
		}
	}
	return out
}

// ModelIDs 取能力目录中的有序模型 ID，供原有 datalist 候选复用。
func ModelIDs(in []ModelInfo) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, m := range in {
		id := strings.TrimSpace(m.ID)
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// ModelThinkingOptions 将已知的逐模型档位转换成 schema 可直接使用的映射。
// 空字符串键是“留空使用 CLI 默认模型”时的保守并集；选定具体模型后，前端
// 会优先使用该模型的精确档位。
func ModelThinkingOptions(in []ModelInfo) map[string][]string {
	out := map[string][]string{}
	var all []string
	for _, m := range in {
		id := strings.TrimSpace(m.ID)
		if id == "" {
			continue
		}
		levels := uniqueModelStrings(m.ThinkingLevels)
		if len(levels) == 0 {
			// 目录中明确存在该模型，但来源没有声明 thinking/variants；
			// 记录空数组，前端才能区分“该模型无已知档位”和“模型不在
			// 能力目录中”，避免错误回退到其它模型的并集。
			if _, ok := out[id]; !ok {
				out[id] = []string{}
			}
			continue
		}
		out[id] = levels
		all = append(all, levels...)
	}
	if len(all) == 0 {
		return nil
	}
	out[""] = uniqueModelStrings(all)
	return out
}

func uniqueModelStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// addModelInfo 去重模型目录，同时允许后面的配置/缓存来源补充前一个来源
// 没有声明的能力。模型 ID 是唯一键；能力档位不做猜测，只接受来源明确
// 报告的值。
func addModelInfo(out *[]ModelInfo, pos map[string]int, m ModelInfo) {
	m.ID = strings.TrimSpace(m.ID)
	m.ThinkingLevels = uniqueModelStrings(m.ThinkingLevels)
	if m.ID == "" {
		return
	}
	if i, ok := pos[m.ID]; ok {
		if len(m.ThinkingLevels) > 0 {
			// 同一模型可能从多个明确来源出现（例如 OMP 配置中多个
			// modelRole 使用不同后缀）；保留这些来源报告的能力并集。
			(*out)[i].ThinkingLevels = uniqueModelStrings(append((*out)[i].ThinkingLevels, m.ThinkingLevels...))
		}
		return
	}
	pos[m.ID] = len(*out)
	*out = append(*out, m)
}

func modelInfosFromIDs(ids []string) []ModelInfo {
	out := make([]ModelInfo, 0, len(ids))
	pos := make(map[string]int, len(ids))
	for _, id := range ids {
		addModelInfo(&out, pos, ModelInfo{ID: id})
	}
	return out
}

// orderThinkingLevels 让 OpenCode 的 variants（JSON 对象无顺序）在 UI 中
// 保持用户熟悉的思考强度顺序；自定义 variant 放在标准档位之后并按名称排。
func orderThinkingLevels(in []string) []string {
	levels := uniqueModelStrings(in)
	preferred := map[string]int{
		"off": 0, "none": 1, "minimal": 2, "low": 3, "medium": 4,
		"high": 5, "xhigh": 6, "max": 7, "ultra": 8, "auto": 9,
	}
	sort.SliceStable(levels, func(i, j int) bool {
		ai, aok := preferred[strings.ToLower(levels[i])]
		aj, bok := preferred[strings.ToLower(levels[j])]
		if aok && bok {
			return ai < aj
		}
		if aok != bok {
			return aok
		}
		return levels[i] < levels[j]
	})
	return levels
}

// cachedModels 按适配器 id 缓存探测结果（TTL 内复用）。
// 同一 id 的并发探测合并：后来的请求等先发者完成，避免重复跑 CLI。
func cachedModels(id string, probe func() []string) []string {
	modelsProbeGate.RLock()
	defer modelsProbeGate.RUnlock()

	modelsCache.Lock()
	if modelsCache.items == nil || time.Since(modelsCache.at) > modelsCacheTTL {
		modelsCache.items = map[string][]string{}
		modelsCache.catalog = map[string][]ModelInfo{}
		modelsCache.busy = map[string]chan struct{}{}
		modelsCache.catalogBusy = map[string]chan struct{}{}
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

// cachedModelCatalog 是带逐模型能力的模型目录缓存。模型 ID 和能力必须
// 共用一次 CLI 探测，否则打开 schema 时会先跑一遍 `models`，再跑一遍
// `models --verbose/--json`，并且刷新按钮还可能把两次结果互相覆盖。
func cachedModelCatalog(id string, probe func() []ModelInfo) []ModelInfo {
	modelsProbeGate.RLock()
	defer modelsProbeGate.RUnlock()

	modelsCache.Lock()
	if modelsCache.catalog == nil || time.Since(modelsCache.at) > modelsCacheTTL {
		modelsCache.items = map[string][]string{}
		modelsCache.catalog = map[string][]ModelInfo{}
		modelsCache.busy = map[string]chan struct{}{}
		modelsCache.catalogBusy = map[string]chan struct{}{}
		modelsCache.at = time.Now()
	}
	if v, ok := modelsCache.catalog[id]; ok {
		modelsCache.Unlock()
		return v
	}
	if ch, ok := modelsCache.catalogBusy[id]; ok {
		modelsCache.Unlock()
		<-ch
		modelsCache.Lock()
		v := modelsCache.catalog[id]
		modelsCache.Unlock()
		return v
	}
	ch := make(chan struct{})
	modelsCache.catalogBusy[id] = ch
	modelsCache.Unlock()

	v := probe()

	modelsCache.Lock()
	modelsCache.catalog[id] = v
	modelsCache.items[id] = ModelIDs(v)
	delete(modelsCache.catalogBusy, id)
	close(ch)
	modelsCache.Unlock()
	return v
}

// RefreshModelCatalogs 强制重新从 Linux 主机探测全部已注册 CLI。它用于：
// 服务每次启动（重新部署）、角色页的“刷新主机能力”按钮，以及 7 天周期任务。
// 刷新只失效发现缓存，绝不会写入或覆盖 agents.role_config。
func RefreshModelCatalogs() {
	modelsRefreshMu.Lock()
	defer modelsRefreshMu.Unlock()

	// 等现有探测完成后再清空，防止旧探测在清空后覆盖新结果。
	modelsProbeGate.Lock()
	modelsCache.Lock()
	modelsCache.at = time.Time{}
	modelsCache.items = nil
	modelsCache.catalog = nil
	modelsCache.busy = nil
	modelsCache.catalogBusy = nil
	modelsCache.Unlock()
	modelsProbeGate.Unlock()

	adapters := Adapters()
	var wg sync.WaitGroup
	for _, a := range adapters {
		wg.Add(1)
		go func(a Adapter) {
			defer wg.Done()
			a.Models()
		}(a)
	}
	wg.Wait()
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

// ---------------------------------------------------------------------------
// opencode：`opencode models --verbose` 输出每个 provider/model 的元数据，
// 其中 variants 是该模型当前可用的逐模型思考档位。普通 `opencode models`
// 只有 ID，不能用于推断 variant；命令失败时回退配置/磁盘缓存，但不猜测
// 思考能力。

func (a *openCodeAdapter) Models() []string {
	return capModels(ModelIDs(a.ModelCatalog()), 60)
}

func (a *openCodeAdapter) ModelCatalog() []ModelInfo {
	return cachedModelCatalog("opencode", func() []ModelInfo {
		home, _ := os.UserHomeDir()
		return opencodeModelCatalogProbe(home)
	})
}

// parseOpenCodeVariantNames 支持当前 CLI 输出的 object 形式，也兼容文档
// 中的数组形式。disabled variant 不属于可选档位。
func parseOpenCodeVariantNames(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) == nil {
		out := make([]string, 0, len(object))
		for name, value := range object {
			var cfg struct {
				Disabled bool `json:"disabled"`
			}
			if json.Unmarshal(value, &cfg) == nil && cfg.Disabled {
				continue
			}
			out = append(out, name)
		}
		return orderThinkingLevels(out)
	}
	var names []string
	if json.Unmarshal(raw, &names) == nil {
		return orderThinkingLevels(names)
	}
	var list []struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Disabled bool   `json:"disabled"`
	}
	if json.Unmarshal(raw, &list) != nil {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if item.Disabled {
			continue
		}
		name := item.ID
		if name == "" {
			name = item.Name
		}
		if name != "" {
			out = append(out, name)
		}
	}
	return orderThinkingLevels(out)
}

// parseOpenCodeVerboseModels 从带标题行的 verbose 输出中提取 JSON 对象。
// `opencode models --verbose` 目前不是一个整体 JSON 文档，而是“模型 ID
// 标题 + pretty JSON”重复输出；使用 Decoder 逐对象读取，避免依赖固定行号。
func parseOpenCodeVerboseModels(raw string) []ModelInfo {
	var out []ModelInfo
	pos := map[string]int{}
	for cursor := 0; cursor < len(raw); {
		rel := strings.IndexByte(raw[cursor:], '{')
		if rel < 0 {
			break
		}
		start := cursor + rel
		var model struct {
			ID         string          `json:"id"`
			ProviderID string          `json:"providerID"`
			Provider   string          `json:"provider"`
			Variants   json.RawMessage `json:"variants"`
		}
		decoder := json.NewDecoder(strings.NewReader(raw[start:]))
		if err := decoder.Decode(&model); err != nil {
			cursor = start + 1
			continue
		}
		consumed := int(decoder.InputOffset())
		if consumed <= 0 {
			cursor = start + 1
		} else {
			cursor = start + consumed
		}
		provider := strings.TrimSpace(model.ProviderID)
		if provider == "" {
			provider = strings.TrimSpace(model.Provider)
		}
		if provider == "" || strings.TrimSpace(model.ID) == "" {
			continue
		}
		addModelInfo(&out, pos, ModelInfo{
			ID:             provider + "/" + strings.TrimSpace(model.ID),
			ThinkingLevels: parseOpenCodeVariantNames(model.Variants),
		})
	}
	return out
}

func opencodeModelCatalogProbe(home string) []ModelInfo {
	if raw, ok := cliOutput(probeTimeout, "opencode", "models", "--verbose"); ok {
		out := parseOpenCodeVerboseModels(raw)
		if len(out) > 0 {
			ids := ModelIDs(out)
			saveModelsDisk("opencode", ids)
			return capModelInfo(out, 60)
		}
	}
	// opencode models 偶发走目录刷新超时：磁盘缓存只复用模型 ID，不能
	// 把旧的/未知 variant 当成当前模型能力。
	if disk := loadModelsDisk("opencode"); disk != nil {
		return capModelInfo(modelInfosFromIDs(disk), 60)
	}
	var cfg struct {
		Model      string `json:"model"`
		SmallModel string `json:"small_model"`
	}
	readJSONFile(filepath.Join(home, ".config", "opencode", "opencode.json"), &cfg)
	return modelInfosFromIDs([]string{cfg.Model, cfg.SmallModel})
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

// ---------------------------------------------------------------------------
// claude：Claude Code 没有公开的模型列表命令，模型候选来自它实际会读取的
// 配置和缓存：用户/项目/托管 settings、模型环境变量，以及 ~/.claude.json
// 中的自定义模型选项和最近使用过的真实模型 ID。
//
// 不要把 `[1m]` 后缀拆掉：这是 Claude Code 合法的扩展上下文模型写法；同样
// 不要把 opus/sonnet 等别名改成猜测出来的版本号，别名会由 Claude Code 按
// 当前账号、provider 和 availableModels 自己解析。

func (a *claudeAdapter) Models() []string {
	return cachedModels("claude", func() []string {
		home, _ := os.UserHomeDir()
		cwd, _ := os.Getwd()
		return claudeModelsProbeAt(home, cwd)
	})
}

// claudeSettingsModelKeys 是 Claude Code 会影响模型选择的环境变量。这里既
// 读取当前 paihuo 进程环境，也读取 settings.json 里的 env 对象；后者是
// Claude Code 官方支持的配置方式。
var claudeSettingsModelKeys = []string{
	"ANTHROPIC_MODEL",
	"ANTHROPIC_CUSTOM_MODEL_OPTION",
	"ANTHROPIC_DEFAULT_FABLE_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"CLAUDE_CODE_SUBAGENT_MODEL",
	// 旧版 Claude Code 仍可能通过这个变量指定后台小模型。
	"ANTHROPIC_SMALL_FAST_MODEL",
}

// claudeModelAliasesForEnv 表示 family default 环境变量同时改变了哪个
// Claude Code 别名的解析。把别名也放进候选，用户可以直接选择别名或已 pin
// 的 provider/model；两者都由 CLI 原样解释。
var claudeModelAliasesForEnv = map[string]string{
	"ANTHROPIC_DEFAULT_FABLE_MODEL":  "fable",
	"ANTHROPIC_DEFAULT_OPUS_MODEL":   "opus",
	"ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "haiku",
}

// claudeModelsProbeAt 是 Claude 模型发现的可测试实现。home 与 cwd 分开注入，
// 这样测试可以模拟用户目录和项目级 settings，而不会改动真实主机配置。
func claudeModelsProbeAt(home, cwd string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		// inherit 是 CLAUDE_CODE_SUBAGENT_MODEL 的控制值，不是可传给
		// --model 的模型；这些占位值也不应污染模型候选。
		if s == "" || s == "inherit" || s == "default" || s == "<synthetic>" {
			return
		}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}

	addClaudeModelEnv(add)

	// 托管 settings 具有最高优先级。Linux/WSL 的文件位置由 Claude Code
	// 官方约定为 /etc/claude-code；drop-in 按文件名排序，和 CLI 的读取顺序
	// 保持一致。即使当前机器没有这些文件，读取也会静默失败。
	for _, path := range claudeManagedSettingsPaths() {
		readClaudeSettings(path, add)
	}

	// 当前项目的 local 设置覆盖 project 和 user 设置，因此先收集它们。
	for _, path := range claudeProjectSettingsPaths(cwd, home) {
		readClaudeSettings(path, add)
	}

	// 用户 settings 是所有项目的最后一级默认值。保留 settings*.json 的兼容
	// 读取，因为旧版 Claude Code/用户可能仍在 ~/.claude/settings.local.json
	// 保存过模型设置。
	for _, path := range claudeUserSettingsPaths(home) {
		readClaudeSettings(path, add)
	}

	// ~/.claude.json 保存 Claude Code 的模型选项缓存、组织默认值、每个项目
	// 最近实际使用的 modelUsage，以及自定义缓存槽。它是发现完整模型 ID 的
	// 关键来源；例如 settings 里是 opus[1m] 时，lastModelUsage 可能记录
	// claude-opus-4-8[1m]。
	readClaudeState(filepath.Join(home, ".claude.json"), add)

	return capModels(out, 80)
}

func addClaudeModelEnv(add func(string)) {
	for _, key := range claudeSettingsModelKeys {
		value := os.Getenv(key)
		if value == "" {
			continue
		}
		add(value)
		if alias := claudeModelAliasesForEnv[key]; alias != "" {
			add(alias)
		}
	}
}

func claudeManagedSettingsPaths() []string {
	const dir = "/etc/claude-code"
	paths := []string{filepath.Join(dir, "managed-settings.json")}
	if matches, err := filepath.Glob(filepath.Join(dir, "managed-settings.d", "*.json")); err == nil {
		sort.Strings(matches)
		paths = append(paths, matches...)
	}
	return paths
}

func claudeUserSettingsPaths(home string) []string {
	pattern := filepath.Join(home, ".claude", "settings*.json")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return []string{filepath.Join(home, ".claude", "settings.json")}
	}
	sort.Strings(matches)
	return matches
}

// claudeProjectSettingsPaths 从当前目录向上查找项目 settings。Claude Code
// 新版通常把 settings.local.json 放在仓库根目录，旧版也可能留在启动目录，
// 所以沿父目录检查两种文件名；home 仅用于避免把用户目录下的同一文件重复
// 当作项目设置。
func claudeProjectSettingsPaths(cwd, home string) []string {
	if cwd == "" {
		return nil
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return nil
	}
	homeAbs, _ := filepath.Abs(home)
	var paths []string
	for dir := abs; ; dir = filepath.Dir(dir) {
		if dir != homeAbs {
			// local 覆盖 project，优先读取 local。
			paths = append(paths,
				filepath.Join(dir, ".claude", "settings.local.json"),
				filepath.Join(dir, ".claude", "settings.json"))
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	return paths
}

type claudeSettingsFile struct {
	Model          string            `json:"model"`
	Available      []string          `json:"availableModels"`
	ModelOverrides map[string]string `json:"modelOverrides"`
	Env            map[string]string `json:"env"`
}

func readClaudeSettings(path string, add func(string)) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var cfg claudeSettingsFile
	if json.Unmarshal(b, &cfg) != nil {
		return
	}
	add(cfg.Model)
	for _, model := range cfg.Available {
		add(model)
	}
	if len(cfg.ModelOverrides) > 0 {
		keys := make([]string, 0, len(cfg.ModelOverrides))
		for source := range cfg.ModelOverrides {
			keys = append(keys, source)
		}
		sort.Strings(keys)
		for _, source := range keys {
			add(source)
			add(cfg.ModelOverrides[source])
		}
	}
	for _, key := range claudeSettingsModelKeys {
		if value := cfg.Env[key]; value != "" {
			add(value)
			if alias := claudeModelAliasesForEnv[key]; alias != "" {
				add(alias)
			}
		}
	}
}

type claudeStateProject struct {
	LastModelUsage map[string]json.RawMessage `json:"lastModelUsage"`
}

type claudeStateFile struct {
	Model                  string `json:"model"`
	AdditionalModelOptions []struct {
		Value string `json:"value"`
	} `json:"additionalModelOptionsCache"`
	ModelAccessCache     json.RawMessage `json:"modelAccessCache"`
	OrgModelDefaultCache json.RawMessage `json:"orgModelDefaultCache"`
	ClientDataCacheSlots map[string]struct {
		Model string `json:"model"`
	} `json:"clientDataCacheSlots"`
	Projects map[string]claudeStateProject `json:"projects"`
}

func readClaudeState(path string, add func(string)) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var state claudeStateFile
	if json.Unmarshal(b, &state) != nil {
		return
	}
	add(state.Model)
	for _, option := range state.AdditionalModelOptions {
		add(option.Value)
	}
	addClaudeJSONModelValues(state.ModelAccessCache, add)
	addClaudeJSONModelValues(state.OrgModelDefaultCache, add)
	if len(state.ClientDataCacheSlots) > 0 {
		keys := make([]string, 0, len(state.ClientDataCacheSlots))
		for key := range state.ClientDataCacheSlots {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			add(state.ClientDataCacheSlots[key].Model)
		}
	}
	projectKeys := make([]string, 0, len(state.Projects))
	for key := range state.Projects {
		projectKeys = append(projectKeys, key)
	}
	sort.Strings(projectKeys)
	for _, projectKey := range projectKeys {
		// lastModelUsage 的键就是 Claude Code result message 里的真实 model
		// ID；值只是 token/cost 统计，不需要读取。
		project := state.Projects[projectKey]
		models := make([]string, 0, len(project.LastModelUsage))
		for model := range project.LastModelUsage {
			models = append(models, model)
		}
		sort.Strings(models)
		for _, model := range models {
			add(model)
		}
	}
}

// addClaudeJSONModelValues 兼容 modelAccessCache/orgModelDefaultCache 在不同
// Claude Code 版本中的 string、array、或带 model/value/id 字段的 object 形状。
// 这里只解析一层已知字段，不递归整个 ~/.claude.json，避免把实验开关里的
// 任意字符串错误地当成模型。
func addClaudeJSONModelValues(raw json.RawMessage, add func(string)) {
	if len(raw) == 0 || string(raw) == "null" {
		return
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		add(value)
		return
	}
	var values []json.RawMessage
	if json.Unmarshal(raw, &values) == nil {
		for _, item := range values {
			addClaudeJSONModelValues(item, add)
		}
		return
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return
	}
	for _, key := range []string{"model", "modelId", "model_id", "value", "id"} {
		if item, ok := object[key]; ok {
			var model string
			if json.Unmarshal(item, &model) == nil {
				add(model)
			}
		}
	}
}
