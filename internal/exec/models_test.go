package exec

import (
	"database/sql"
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
