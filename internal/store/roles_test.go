package store

import "testing"

// 角色是执行池而非单一会话：并发零值收敛为 1，显式配置则完整保存。
func TestRoleMaxConcurrencyDefaultsAndRoundTrips(t *testing.T) {
	s := openTest(t)
	defaultID := mustRole(t, s, "default-pool", true)
	defaultAgent, err := s.GetRole(defaultID)
	if err != nil {
		t.Fatal(err)
	}
	if defaultAgent.MaxConcurrency != 1 || defaultAgent.ConcurrencyLimit() != 1 {
		t.Fatalf("未配置角色应默认单并发，得到 %+v", defaultAgent)
	}

	id, err := s.CreateRole(Role{Name: "parallel-pool", RuntimeID: "pi", Enabled: true, MaxConcurrency: 3})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateRole(id, map[string]any{"max_concurrency": 5}); err != nil {
		t.Fatal(err)
	}
	a, err := s.GetRole(id)
	if err != nil {
		t.Fatal(err)
	}
	if a.MaxConcurrency != 5 || a.ConcurrencyLimit() != 5 {
		t.Fatalf("角色并发数未正确往返保存，得到 %+v", a)
	}
}
