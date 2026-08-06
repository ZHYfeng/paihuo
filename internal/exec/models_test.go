package exec

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// omp 回退解析（命令超时/失败时）：models.db 的 authoritative 目录必须再按
// auth_credentials 中凭据仍然有效的 provider 过滤——否则会把无凭据（zenmux）
// 或凭据已删除（opencode-go）的模型列进角色表单候选，用户选了就跑不起来。
func TestOmpModelsFallbackFiltersDeadCreds(t *testing.T) {
	home := t.TempDir()
	agentDir := filepath.Join(home, ".omp", "agent")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// models.db：deepseek（有效凭据）与 zenmux（无凭据）都有 authoritative 目录。
	md, err := sql.Open("sqlite", filepath.Join(agentDir, "models.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer md.Close()
	if _, err := md.Exec(`CREATE TABLE model_cache (provider_id TEXT, authoritative INTEGER, models TEXT)`); err != nil {
		t.Fatal(err)
	}
	insert := func(prov, models string) {
		if _, err := md.Exec(`INSERT INTO model_cache (provider_id, authoritative, models) VALUES (?, 1, ?)`,
			prov, `[{"provider":"`+prov+`","id":"`+models+`"}]`); err != nil {
			t.Fatal(err)
		}
	}
	insert("deepseek", "deepseek-v4-flash")
	insert("zenmux", "anthropic/claude-opus-5")

	// agent.db：deepseek 凭据有效；zenmux 从未登录（无行）。
	ad, err := sql.Open("sqlite", filepath.Join(agentDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ad.Close()
	if _, err := ad.Exec(`CREATE TABLE auth_credentials (
		id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT,
		disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if _, err := ad.Exec(`INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('deepseek', 'api_key', '{}')`); err != nil {
		t.Fatal(err)
	}

	// 命令探测在测试环境不可用（omp 未安装/超时），必然走回退路径。
	got := ompModelsFallback(home)
	joined := strings.Join(got, " ")
	if !strings.Contains(joined, "deepseek/deepseek-v4-flash") {
		t.Fatalf("应包含凭据有效的 deepseek 模型，得到: %v", got)
	}
	for _, m := range got {
		if strings.HasPrefix(m, "zenmux/") {
			t.Fatalf("无凭据的 zenmux 模型不应出现在候选中: %v", got)
		}
	}
}

// 凭据被停用（disabled_cause 非空，如 "deleted by user"）的 provider
// 同样要过滤——对应本机 opencode-go 凭据被删但 models.db 仍留目录的场景。
func TestOmpActiveProvidersSkipsDisabled(t *testing.T) {
	home := t.TempDir()
	agentDir := filepath.Join(home, ".omp", "agent")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ad, err := sql.Open("sqlite", filepath.Join(agentDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ad.Close()
	if _, err := ad.Exec(`CREATE TABLE auth_credentials (
		id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT,
		disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range []string{
		`('deepseek', 'api_key', '{}', NULL)`,
		`('opencode-go', 'api_key', '{}', 'deleted by user')`,
	} {
		if _, err := ad.Exec(`INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES ` + row); err != nil {
			t.Fatal(err)
		}
	}
	provs := ompActiveProviders(home)
	if !provs["deepseek"] {
		t.Fatal("deepseek 凭据有效，应被列为可用 provider")
	}
	if provs["opencode-go"] {
		t.Fatal("opencode-go 凭据已删除，不应被列为可用 provider")
	}
}

func TestOmpFallbackPreservesConfiguredThinkingSuffix(t *testing.T) {
	home := t.TempDir()
	agentDir := filepath.Join(home, ".omp", "agent")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}
	config := "modelRoles:\n  default: deepseek/deepseek-v4-flash:max\n  smol: deepseek/deepseek-v4-flash:off\n"
	if err := os.WriteFile(filepath.Join(agentDir, "config.yml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ompModelsFallbackCatalog(home)
	byID := map[string]ModelInfo{}
	for _, model := range got {
		byID[model.ID] = model
	}
	if levels := strings.Join(byID["deepseek/deepseek-v4-flash"].ThinkingLevels, ","); levels != "max,off" {
		t.Fatalf("OMP 回退应保留配置中明确的 thinking 后缀，得到 %q（%v）", levels, got)
	}
}

// pi 模型候选必须全部是 provider/model 限定形式。裸 id（如 deepseek-v4-flash、
// glm-5.1）在多个 provider 存在同名模型时是歧义的（本机 deepseek 与
// opencode-go 都有 deepseek-v4-flash / deepseek-v4-pro）：pi 对 --model 裸 id
// 的解析取决于其模型文件里的 provider 顺序，用户从候选里选出来的模型可能与
// 实际解析到的 provider 不一致——即「模型选择不对」。
func TestPiModelCandidatesQualifiedOnly(t *testing.T) {
	rows := piListModelsRows(`provider     model              context  max-out  thinking  images
deepseek     deepseek-v4-flash  1M       384K     yes       no
deepseek     deepseek-v4-pro    1M       384K     yes       no
opencode-go  deepseek-v4-flash  1M       384K     yes       no
opencode-go  deepseek-v4-pro    1M       384K     yes       no
opencode-go  glm-5.1            202.8K   32.8K    yes       no`)
	if len(rows) != 5 {
		t.Fatalf("应解析出 5 行（跳过表头行），得到 %d: %v", len(rows), rows)
	}

	got := piModelCandidates("opencode-go", "deepseek-v4-flash", rows)
	// 不允许出现裸 id：每个候选都必须是 provider/model
	for _, m := range got {
		if !strings.Contains(m, "/") {
			t.Fatalf("候选不应出现裸 id: %q（全部候选 %v）", m, got)
		}
	}
	// 默认 provider 排最前，默认模型是第一条候选
	if len(got) == 0 || got[0] != "opencode-go/deepseek-v4-flash" {
		t.Fatalf("第一条候选应为默认模型的限定形式，得到 %v", got)
	}
	// 无重复
	seen := map[string]bool{}
	for _, m := range got {
		if seen[m] {
			t.Fatalf("候选重复: %q", m)
		}
		seen[m] = true
	}
	// 同名模型在不同 provider 下各自保留（deepseek 与 opencode-go 的 deepseek-v4-flash）
	joined := strings.Join(got, " ")
	for _, want := range []string{"deepseek/deepseek-v4-flash", "opencode-go/deepseek-v4-flash"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("应包含 %s，得到 %v", want, got)
		}
	}
}

func TestOmpModelsJSONPreservesPerModelThinkingLevels(t *testing.T) {
	raw := `{"models":[
  {"provider":"deepseek","id":"deepseek-v4-flash","selector":"deepseek/deepseek-v4-flash","reasoning":true,"thinking":["high","max"]},
  {"provider":"zai","id":"glm-5.1","selector":"zai/glm-5.1","reasoning":true,"thinking":["low","medium","high"]},
  {"provider":"plain","id":"chat","selector":"plain/chat","reasoning":false}
]}`
	got := parseOmpModelsJSON(raw)
	if len(got) != 3 {
		t.Fatalf("应解析出 3 个模型，得到 %v", got)
	}
	if strings.Join(got[0].ThinkingLevels, ",") != "high,max" {
		t.Fatalf("OMP 第一模型的 thinking 档位错误: %v", got)
	}
	if len(got[2].ThinkingLevels) != 0 {
		t.Fatalf("未声明 thinking 的模型不应猜测档位: %v", got[2])
	}
	opts := ModelThinkingOptions(got)
	if strings.Join(opts[got[0].ID], ",") != "high,max" {
		t.Fatalf("OMP schema 未保留逐模型档位: %v", opts)
	}
	if levels, ok := opts[got[2].ID]; !ok || len(levels) != 0 {
		t.Fatalf("OMP 未声明档位的模型应记录为空能力集合: %v", opts)
	}
}

func TestOpenCodeVerboseModelsPreservesVariants(t *testing.T) {
	raw := `opencode/deepseek-v4-flash-free
{
  "id": "deepseek-v4-flash-free",
  "providerID": "opencode",
  "variants": {
    "max": {"reasoningEffort": "max"},
    "disabled": {"disabled": true},
    "low": {"reasoningEffort": "low"},
    "high": {"reasoningEffort": "high"}
  }
}
opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "variants": {}
}`
	got := parseOpenCodeVerboseModels(raw)
	if len(got) != 2 {
		t.Fatalf("应解析出 2 个 OpenCode 模型，得到 %v", got)
	}
	if got[0].ID != "opencode/deepseek-v4-flash-free" {
		t.Fatalf("模型 selector 错误: %v", got)
	}
	if strings.Join(got[0].ThinkingLevels, ",") != "low,high,max" {
		t.Fatalf("OpenCode variants 解析/排序错误: %v", got[0])
	}
	if len(got[1].ThinkingLevels) != 0 {
		t.Fatalf("空 variants 不应猜测档位: %v", got[1])
	}
}

func TestOpenCodeVariantNamesSupportsArrayForms(t *testing.T) {
	if got := parseOpenCodeVariantNames(json.RawMessage(`["max", "low", "max"]`)); strings.Join(got, ",") != "low,max" {
		t.Fatalf("OpenCode 字符串数组 variants 解析/排序错误: %v", got)
	}
	got := parseOpenCodeVariantNames(json.RawMessage(`[
  {"name":"high"},
  {"id":"disabled","disabled":true},
  {"id":"low"}
]`))
	if strings.Join(got, ",") != "low,high" {
		t.Fatalf("OpenCode 对象数组 variants 解析错误: %v", got)
	}
}

// 磁盘缓存回退：权威命令偶发超时（opencode 目录刷新 20~30s+）时，
// 回退应复用最近一次成功结果而不是缩水到配置文件里的 1~2 个模型。
func TestModelsDiskCacheRoundTrip(t *testing.T) {
	cacheDir := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cacheDir) // os.UserCacheDir 在 Linux 上尊重 XDG_CACHE_HOME
	if got := loadModelsDisk("pi"); got != nil {
		t.Fatalf("空缓存应返回 nil，得到: %v", got)
	}
	want := []string{"deepseek-v4-flash", "opencode-go/deepseek-v4-flash"}
	saveModelsDisk("pi", want)
	got := loadModelsDisk("pi")
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("磁盘缓存往返不一致: want %v got %v", want, got)
	}
	// 空列表不落盘
	saveModelsDisk("pi", nil)
	if got := loadModelsDisk("pi"); len(got) != 2 {
		t.Fatalf("空列表不应覆盖已有缓存: %v", got)
	}
}

// Codex 的 models_cache 是唯一会明确给出逐模型 reasoning 档位的本机目录。
// visibility=hide 的内部路由别名（如 sol-wm）不能因 config.toml 再次出现而
// 泄漏到角色模型候选中。
func TestCodexModelsProbeUsesHostCapabilitiesAndHidesAliases(t *testing.T) {
	home := t.TempDir()
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cache := `{"models":[
  {"slug":"gpt-visible","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"xhigh"},{"effort":"max"}]},
  {"slug":"gpt-hidden-wm","visibility":"hide","supported_reasoning_levels":[{"effort":"max"}]}
]}`
	if err := os.WriteFile(filepath.Join(codexDir, "models_cache.json"), []byte(cache), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte("model = \"gpt-visible\"\nmodel = \"gpt-hidden-wm\"\nmodel = \"local-custom\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := codexModelsProbe(home)
	byID := map[string]ModelInfo{}
	for _, m := range got {
		byID[m.ID] = m
	}
	if _, ok := byID["gpt-hidden-wm"]; ok {
		t.Fatalf("隐藏路由别名不应出现在候选: %v", got)
	}
	visible, ok := byID["gpt-visible"]
	if !ok || strings.Join(visible.ThinkingLevels, ",") != "low,xhigh,max" {
		t.Fatalf("可见模型的真实能力未保留: %v", got)
	}
	if custom, ok := byID["local-custom"]; !ok || len(custom.ThinkingLevels) != 0 {
		t.Fatalf("仅在 config.toml 的自定义模型应保留但不猜测能力: %v", got)
	}

	opts := ModelThinkingOptions(got)
	if strings.Join(opts["gpt-visible"], ",") != "low,xhigh,max" || strings.Join(opts[""], ",") != "low,xhigh,max" {
		t.Fatalf("schema 思考档位映射不正确: %v", opts)
	}
}

func TestClaudeModelsProbeReadsEffectiveSettingsAndEnvironment(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "repo", "nested")
	if err := os.MkdirAll(filepath.Join(home, "repo", ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(project, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{
  "model": "opus[1m]",
  "availableModels": ["sonnet", "claude-haiku-4-5"],
  "modelOverrides": {"claude-opus-5": "gateway/opus-5"},
  "env": {"ANTHROPIC_DEFAULT_OPUS_MODEL": "gateway/opus-default"}
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "repo", ".claude", "settings.json"), []byte(`{"model":"project-opus"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".claude", "settings.local.json"), []byte(`{"model":"local-sonnet"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, key := range claudeSettingsModelKeys {
		t.Setenv(key, "")
	}
	t.Setenv("ANTHROPIC_MODEL", "env/claude-model")

	got := claudeModelsProbeAt(home, project)
	if len(got) == 0 || got[0] != "env/claude-model" {
		t.Fatalf("直接环境变量应优先成为第一候选，得到 %v", got)
	}
	for _, want := range []string{
		"local-sonnet", "project-opus", "opus[1m]", "sonnet", "claude-haiku-4-5",
		"claude-opus-5", "gateway/opus-5", "gateway/opus-default", "opus",
	} {
		if !containsModel(got, want) {
			t.Fatalf("Claude 模型候选缺少 %q，得到 %v", want, got)
		}
	}
}

func TestClaudeModelsProbeReadsStateModelIDs(t *testing.T) {
	home := t.TempDir()
	state := `{
  "additionalModelOptionsCache": [{"value":"custom/fable"}],
  "modelAccessCache": [{"model":"access/sonnet"}],
  "orgModelDefaultCache": {"model":"org/opus"},
  "clientDataCacheSlots": {"slot-a":{"model":"slot/haiku"}},
  "projects": {
    "/repo": {"lastModelUsage": {
      "claude-opus-4-8[1m]": {"inputTokens": 1},
      "<synthetic>": {"inputTokens": 2}
    }}
  }
}`
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, key := range claudeSettingsModelKeys {
		t.Setenv(key, "")
	}
	got := claudeModelsProbeAt(home, filepath.Join(home, "repo"))
	for _, want := range []string{"custom/fable", "access/sonnet", "org/opus", "slot/haiku", "claude-opus-4-8[1m]"} {
		if !containsModel(got, want) {
			t.Fatalf("Claude 状态缓存缺少真实模型 %q，得到 %v", want, got)
		}
	}
	if containsModel(got, "<synthetic>") {
		t.Fatalf("合成模型占位符不应成为候选: %v", got)
	}
}

func containsModel(models []string, want string) bool {
	for _, model := range models {
		if model == want {
			return true
		}
	}
	return false
}
