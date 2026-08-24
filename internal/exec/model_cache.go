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
	"encoding/json"
	"os"
	osexec "os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// modelsCacheTTL：模型候选缓存时长。探测要跑各 CLI 的命令（秒级），
// 而模型列表变化极低频（装新 provider / 改配置才变），60s TTL 会让
// 每次打开页面（距上次超过 1 分钟）都重复付一遍探测开销，直接拖慢
// /api/v1/runtimes，进而卡住前端首屏。调成 1 小时。
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
func ModelCatalog(a commandAdapter) []ModelInfo {
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

	adapters := commandAdapters()
	var wg sync.WaitGroup
	for _, a := range adapters {
		wg.Add(1)
		go func(a commandAdapter) {
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
