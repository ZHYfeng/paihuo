package session

import (
	"strings"
	"testing"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/store"
)

func TestDelegationEnvInjections(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.SetSetting("mcp_auth_secret", "s3cr3t"); err != nil {
		t.Fatal(err)
	}
	hub := events.NewEventStream()
	ex := exec.NewForTest(st, hub, t.TempDir(), "env-test.db", "env-test")
	m := New(st, hub, ex, t.TempDir(), t.TempDir())
	m.SetDelegationEnv("http://127.0.0.1:9999")

	// 委托角色 → 注入平台工具面环境
	orchestrator := store.Role{ID: 1, DelegationEnabled: true, DelegationMaxPerm: store.PermReview}
	ss := store.Task{ID: 42}
	env := m.delegationEnv(&ss, orchestrator)
	if len(env) != 3 {
		t.Fatalf("应注入 3 个环境变量，got %v", env)
	}
	joined := strings.Join(env, "\n")
	for _, want := range []string{
		"PAIHUO_MCP_URL=http://127.0.0.1:9999/api/v1/mcp",
		"PAIHUO_MCP_TOKEN=ph_42.",
		"PAIHUO_SESSION_ID=42",
	} {
		found := false
		for _, kv := range env {
			if strings.HasPrefix(kv, want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("缺少 %q，got %v", want, env)
		}
	}
	if !strings.Contains(joined, "PAIHUO_MCP_TOKEN=ph_42.") {
		t.Fatalf("令牌应以 ph_<session> 前缀: %s", joined)
	}

	// 非委托角色 → 不注入
	if env := m.delegationEnv(&ss, store.Role{ID: 2}); len(env) != 0 {
		t.Fatalf("非委托角色不应注入环境: %v", env)
	}
	// 未配置端点 → 不注入
	m2 := New(st, hub, ex, t.TempDir(), t.TempDir())
	if env := m2.delegationEnv(&ss, orchestrator); len(env) != 0 {
		t.Fatalf("未配置端点不应注入: %v", env)
	}
}
