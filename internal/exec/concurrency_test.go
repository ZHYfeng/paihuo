package exec

import "testing"

func TestExecutorAgentSlotsHonorLimitAndRecoveringTasks(t *testing.T) {
	e := &Executor{active: make(map[int64]int)}
	const agentID = int64(17)

	if !e.reserveAgentSlot(agentID, 2) || !e.reserveAgentSlot(agentID, 2) {
		t.Fatal("前两个槽位应可获取")
	}
	if e.reserveAgentSlot(agentID, 2) {
		t.Fatal("达到角色最大并发后不应继续派发")
	}
	// 恢复中的旧任务不应被新配置硬杀；它会占用存量槽位直到自行结束。
	e.restoreAgentSlot(agentID)
	if e.active[agentID] != 3 {
		t.Fatalf("恢复任务应增加占用数，得到 %d", e.active[agentID])
	}
	e.releaseAgentSlot(agentID)
	e.releaseAgentSlot(agentID)
	e.releaseAgentSlot(agentID)
	if _, ok := e.active[agentID]; ok {
		t.Fatalf("所有任务结束后槽位应释放，得到 %v", e.active)
	}
}
