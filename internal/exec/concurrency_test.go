package exec

import (
	"testing"

	"paihuo/internal/store"
)

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

// 项目级串行门禁：未勾选并发的任务要求项目当前没有任何活跃任务（无论并发
// 与否）才允许启动；勾选并发的任务跳过门禁但同样登记占用。
func TestExecutorProjectGateSerializesNonConcurrentTasks(t *testing.T) {
	e := &Executor{activeProj: make(map[int64]int)}
	pid := int64(5)
	serial := func() store.Task { return store.Task{ProjectID: &pid} }
	parallel := func() store.Task { return store.Task{ProjectID: &pid, Concurrent: true} }

	// 无项目任务不受门禁约束。
	if !e.reserveProjectSlot(store.Task{}) {
		t.Fatal("无项目任务不应受门禁约束")
	}
	e.releaseProjectSlot(store.Task{})

	// 串行任务占住项目后，后续串行任务必须等待。
	if !e.reserveProjectSlot(serial()) {
		t.Fatal("空项目应允许第一个串行任务")
	}
	if e.reserveProjectSlot(serial()) {
		t.Fatal("项目已有活跃任务时，串行任务不应放行")
	}
	// 并发任务无视门禁，但登记占用（让后续串行任务等它结束）。
	if !e.reserveProjectSlot(parallel()) {
		t.Fatal("并发任务应跳过项目串行门禁")
	}
	if e.activeProj[pid] != 2 {
		t.Fatalf("项目活跃计数应为 2，得到 %d", e.activeProj[pid])
	}
	if e.reserveProjectSlot(serial()) {
		t.Fatal("并发任务仍在运行时，串行任务也应等待")
	}

	// 全部释放后串行任务才能再次启动。
	e.releaseProjectSlot(parallel())
	if e.reserveProjectSlot(serial()) {
		t.Fatal("并发任务未结束时门禁不应放行")
	}
	e.releaseProjectSlot(serial())
	if !e.reserveProjectSlot(serial()) {
		t.Fatal("项目空闲后串行任务应放行")
	}
	e.releaseProjectSlot(serial())
	if _, ok := e.activeProj[pid]; ok {
		t.Fatalf("所有任务结束后项目占用应释放，得到 %v", e.activeProj)
	}

	// 服务重启接管存量任务时恢复占用，避免门禁错误放行。
	if !e.reserveProjectSlot(serial()) {
		t.Fatal("空项目应允许任务")
	}
	e.restoreProjectSlot(serial())
	e.restoreProjectSlot(serial())
	if e.activeProj[pid] != 3 {
		t.Fatalf("恢复任务应增加项目占用，得到 %d", e.activeProj[pid])
	}
}
