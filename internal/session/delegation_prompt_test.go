package session

import (
	"strings"
	"testing"

	"paihuo/internal/orchestrator"
	"paihuo/internal/store"
)

func TestSessionRoleConfigAppendsDelegationPrompt(t *testing.T) {
	m := &Manager{mcpBaseURL: "http://127.0.0.1:8080"}
	got := m.sessionRoleConfig(store.Role{
		DelegationEnabled: true,
		RoleConfig:        store.RoleConfig{SystemPrompt: "原有角色职责"},
	})
	if !strings.HasPrefix(got.SystemPrompt, "原有角色职责\n\n") {
		t.Fatalf("应保留原有 system prompt，得到 %q", got.SystemPrompt)
	}
	if !strings.Contains(got.SystemPrompt, "没有明确指定的可选设置，一律省略") {
		t.Fatalf("委托规则未注入: %q", got.SystemPrompt)
	}
	if !strings.Contains(got.SystemPrompt, "让平台使用默认值") {
		t.Fatalf("委托规则缺少默认值约束: %q", got.SystemPrompt)
	}
	if !strings.Contains(got.SystemPrompt, "自动创建隔离 worktree") || !strings.Contains(got.SystemPrompt, "自动处理交付/合并") {
		t.Fatalf("委托规则缺少平台 worktree/合并说明: %q", got.SystemPrompt)
	}
	if !strings.Contains(got.SystemPrompt, "不要调用 spawn_task") || !strings.Contains(got.SystemPrompt, "自动继承该项目") {
		t.Fatalf("委托规则缺少空任务/项目继承说明: %q", got.SystemPrompt)
	}
}

func TestSessionRoleConfigDoesNotInjectWithoutDelegationTools(t *testing.T) {
	for _, tt := range []struct {
		name string
		role store.Role
		url  string
	}{
		{name: "not delegating", role: store.Role{DelegationEnabled: false}, url: "http://127.0.0.1:8080"},
		{name: "no endpoint", role: store.Role{DelegationEnabled: true}, url: ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			m := &Manager{mcpBaseURL: tt.url}
			got := m.sessionRoleConfig(tt.role)
			if strings.Contains(got.SystemPrompt, orchestrator.DelegationSystemPrompt) {
				t.Fatalf("不应注入委托 prompt: %q", got.SystemPrompt)
			}
		})
	}
}
