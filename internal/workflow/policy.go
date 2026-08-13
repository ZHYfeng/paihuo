package workflow

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

type RoleCapabilities struct {
	Exists       bool
	Enabled      bool
	Capabilities map[string]bool
}

type RoleResolver func(roleID int64) RoleCapabilities

// Policy contains installation-wide hard ceilings. A Proposal may choose
// lower limits but can never enlarge these.
type Policy struct {
	MaxNodes       int
	MaxDepth       int
	MaxConcurrency int
	MaxBudget      int64
	MaxTimeout     int
	ResolveRole    RoleResolver
}

func DefaultPolicy(resolve RoleResolver) Policy {
	return Policy{MaxNodes: 64, MaxDepth: 12, MaxConcurrency: 8,
		MaxBudget: 1_000_000, MaxTimeout: 24 * 60 * 60, ResolveRole: resolve}
}

var nodeIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

func (p Policy) Validate(spec Spec) []Violation {
	violations := make([]Violation, 0)
	add := func(code, nodeID, message string) {
		violations = append(violations, Violation{Code: code, NodeID: nodeID, Message: message})
	}
	if strings.TrimSpace(spec.Goal) == "" {
		add("goal_required", "", "Workflow goal 不能为空")
	}
	if spec.ProjectID < 1 {
		add("project_required", "", "Workflow 必须绑定 Project")
	}
	if spec.Limits.MaxNodes < 1 || spec.Limits.MaxNodes > p.MaxNodes {
		add("max_nodes", "", fmt.Sprintf("max_nodes 必须在 1-%d 之间", p.MaxNodes))
	}
	if spec.Limits.MaxDepth < 1 || spec.Limits.MaxDepth > p.MaxDepth {
		add("max_depth", "", fmt.Sprintf("max_depth 必须在 1-%d 之间", p.MaxDepth))
	}
	if spec.Limits.MaxConcurrency < 1 || spec.Limits.MaxConcurrency > p.MaxConcurrency {
		add("max_concurrency", "", fmt.Sprintf("max_concurrency 必须在 1-%d 之间", p.MaxConcurrency))
	}
	if spec.Limits.Budget < 0 || spec.Limits.Budget > p.MaxBudget {
		add("budget", "", fmt.Sprintf("budget 必须在 0-%d 之间", p.MaxBudget))
	}
	if len(spec.Nodes) == 0 || len(spec.Nodes) > p.MaxNodes || len(spec.Nodes) > spec.Limits.MaxNodes {
		add("node_count", "", "节点数量超出 Workflow 限制")
	}

	nodes := make(map[string]Node, len(spec.Nodes))
	var totalBudget int64
	for _, node := range spec.Nodes {
		if !nodeIDPattern.MatchString(node.ID) {
			add("node_id", node.ID, "节点 ID 必须是小写字母开头的 slug")
		}
		if _, exists := nodes[node.ID]; exists {
			add("duplicate_node", node.ID, "节点 ID 重复")
		}
		nodes[node.ID] = node
		if strings.TrimSpace(node.Intent) == "" {
			add("intent_required", node.ID, "节点意图不能为空")
		}
		if node.Permission != "full" && node.Permission != "review" {
			add("permission", node.ID, "权限必须是 full 或 review")
		}
		if node.TimeoutSeconds < 1 || node.TimeoutSeconds > p.MaxTimeout {
			add("timeout", node.ID, fmt.Sprintf("超时必须在 1-%d 秒之间", p.MaxTimeout))
		}
		if node.FailurePolicy != "stop" && node.FailurePolicy != "continue" {
			add("failure_policy", node.ID, "失败策略必须是 stop 或 continue")
		}
		if node.Budget < 0 {
			add("node_budget", node.ID, "节点预算不能为负数")
		}
		totalBudget += node.Budget
		if p.ResolveRole != nil {
			role := p.ResolveRole(node.Role.RoleID)
			if !role.Exists || !role.Enabled {
				add("role_unavailable", node.ID, "Role 不存在或未启用")
			} else {
				for _, capability := range append([]string{"batch"}, node.Role.RequiredCapabilities...) {
					if !role.Capabilities[capability] {
						add("runtime_capability", node.ID, "Runtime 缺少 capability: "+capability)
					}
				}
			}
		}
		for _, action := range node.AllowedActions {
			if dangerousAction(action) && !node.ApprovalRequired {
				add("approval_required", node.ID, "危险动作必须声明人工审批: "+action)
			}
		}
		for _, ref := range node.InputRefs {
			if invalidReference(ref) {
				add("input_reference", node.ID, "输入引用不是受控 node:/artifact: 引用: "+ref)
			}
		}
	}
	if totalBudget > spec.Limits.Budget {
		add("budget_exceeded", "", "节点预算总和超过 Workflow budget")
	}

	for _, node := range spec.Nodes {
		seenDependency := map[string]bool{}
		for _, dependency := range node.DependsOn {
			if dependency == node.ID {
				add("self_dependency", node.ID, "节点不能依赖自己")
			} else if _, ok := nodes[dependency]; !ok {
				add("missing_dependency", node.ID, "依赖节点不存在: "+dependency)
			} else if seenDependency[dependency] {
				add("duplicate_dependency", node.ID, "依赖节点重复: "+dependency)
			}
			seenDependency[dependency] = true
		}
	}
	depth, cycle := graphDepth(nodes)
	if cycle {
		add("cycle", "", "Workflow 图包含循环")
	} else if depth > spec.Limits.MaxDepth || depth > p.MaxDepth {
		add("depth", "", fmt.Sprintf("Workflow 深度 %d 超出限制", depth))
	}
	return violations
}

func graphDepth(nodes map[string]Node) (int, bool) {
	state := make(map[string]int, len(nodes))
	memo := make(map[string]int, len(nodes))
	var visit func(string) (int, bool)
	visit = func(id string) (int, bool) {
		if state[id] == 1 {
			return 0, true
		}
		if state[id] == 2 {
			return memo[id], false
		}
		state[id] = 1
		depth := 1
		for _, dependency := range nodes[id].DependsOn {
			if _, ok := nodes[dependency]; !ok {
				continue
			}
			value, cycle := visit(dependency)
			if cycle {
				return 0, true
			}
			if value+1 > depth {
				depth = value + 1
			}
		}
		state[id] = 2
		memo[id] = depth
		return depth, false
	}
	maximum := 0
	for id := range nodes {
		depth, cycle := visit(id)
		if cycle {
			return 0, true
		}
		if depth > maximum {
			maximum = depth
		}
	}
	return maximum, false
}

func dangerousAction(action string) bool {
	switch strings.TrimSpace(action) {
	case "install_runtime", "arbitrary_host_path", "full_permission", "merge_workspace", "delete_workspace":
		return true
	default:
		return false
	}
}

func invalidReference(ref string) bool {
	ref = strings.TrimSpace(ref)
	if strings.HasPrefix(ref, "node:") || strings.HasPrefix(ref, "artifact:") {
		value := strings.TrimSpace(strings.SplitN(ref, ":", 2)[1])
		return value == "" || filepath.IsAbs(value) || strings.Contains(value, "..") || strings.ContainsAny(value, "\\\n\r")
	}
	return true
}
