// Package session 实现会话实体（Session）的生命周期管理与 pi RPC 会话后端。
//
// 会话是与任务平行的一等公民：复杂问题的常驻交互工作区，无执行-结算语义。
// pi 会话 = 每会话一个 `pi --mode rpc` 进程（stdin 命令 JSONL / stdout 事件
// JSONL），挂起即杀进程（transcript 由 pi 会话文件持久化），恢复 = 新进程 +
// switch_session 接续原会话；交付时创建任务并复用会话 worktree。
package session

import (
	"errors"
	"fmt"

	"paihuo/internal/store"
)

// 状态迁移白名单。状态机：created → active ⇄ suspended → delivered / deleted。
var transitions = map[string]map[string]bool{
	store.SessionStatusCreated: {
		store.SessionStatusActive:  true,
		store.SessionStatusDeleted: true,
	},
	store.SessionStatusActive: {
		store.SessionStatusSuspended: true,
		store.SessionStatusDelivered: true,
		store.SessionStatusDeleted:   true,
	},
	store.SessionStatusSuspended: {
		store.SessionStatusActive:    true,
		store.SessionStatusDelivered: true,
		store.SessionStatusDeleted:   true,
	},
	store.SessionStatusDelivered: {
		// 交付即终态：会话冻结为只读归档，不可恢复、不可再次交付。
		// 交付任务被删除时会话联动清理（delivered → deleted）——此前
		// 解冻回 suspended 会让会话被恢复修改后反复交付、反复创建合并任务。
		store.SessionStatusDeleted: true,
	},
	store.SessionStatusDeleted: {},
}

var (
	ErrInvalidTransition = errors.New("非法的会话状态迁移")
	ErrSessionNotFound   = errors.New("会话不存在")
	ErrNotActive         = errors.New("会话不在活跃状态")
	ErrNotRunnable       = errors.New("会话不在可启动状态（created/suspended）")
	ErrAlreadyDelivered  = errors.New("会话已交付")
)

// CanTransition 判断 from → to 是否合法。
func CanTransition(from, to string) bool {
	return transitions[from][to]
}

// validTargets 返回某状态的合法目标（错误提示用）。
func validTargets(from string) []string {
	out := make([]string, 0, len(transitions[from]))
	for k := range transitions[from] {
		out = append(out, k)
	}
	return out
}

// transitionErr 构造带合法目标提示的迁移错误。
func transitionErr(from, to string) error {
	return fmt.Errorf("%w: %s → %s（合法目标: %v）", ErrInvalidTransition, from, to, validTargets(from))
}

// ValidCreate 校验创建参数；agentID 必须指向存在且可用的角色。
// 交互式会话只支持 pi / omp（RPC 消息流通道）；opencode / claude /
// codex 无结构化消息通道，不支持会话。
func (m *Manager) validateCreate(agent store.Role) error {
	if !agent.Enabled {
		return fmt.Errorf("角色「%s」已停用，无法创建会话", agent.Name)
	}
	if _, ok := m.runtimes.Session(agent.RuntimeID); !ok {
		return fmt.Errorf("Runtime %s 不提供结构化会话能力，角色「%s」无法创建会话", agent.RuntimeID, agent.Name)
	}
	return nil
}
