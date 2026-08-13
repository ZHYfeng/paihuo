package workflow

import "testing"

func validSpec() Spec {
	return Spec{
		Version: 1, Goal: "交付功能", ProjectID: 1, CreatedBy: "test", AdoptionPolicy: "manual",
		Limits: Limits{Budget: 100, MaxNodes: 4, MaxDepth: 3, MaxConcurrency: 2},
		Nodes: []Node{
			{ID: "design", Intent: "设计", Role: RoleSelector{RoleID: 1}, Permission: "review", TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 20},
			{ID: "build", Intent: "实现", Role: RoleSelector{RoleID: 1}, DependsOn: []string{"design"}, Permission: "full", TimeoutSeconds: 60, FailurePolicy: "stop", Budget: 40},
		},
	}
}

func testPolicy() Policy {
	return DefaultPolicy(func(int64) RoleCapabilities {
		return RoleCapabilities{Exists: true, Enabled: true, Capabilities: map[string]bool{"batch": true}}
	})
}

func TestPolicyAcceptsDeterministicDAG(t *testing.T) {
	if got := testPolicy().Validate(validSpec()); len(got) != 0 {
		t.Fatalf("valid spec rejected: %+v", got)
	}
}

func TestPolicyRejectsCycleBudgetPathAndDangerousAction(t *testing.T) {
	spec := validSpec()
	spec.Nodes[0].DependsOn = []string{"build"}
	spec.Nodes[1].Budget = 200
	spec.Nodes[1].InputRefs = []string{"../../etc/passwd"}
	spec.Nodes[1].AllowedActions = []string{"delete_workspace"}
	violations := testPolicy().Validate(spec)
	want := map[string]bool{"cycle": false, "budget_exceeded": false, "input_reference": false, "approval_required": false}
	for _, violation := range violations {
		if _, ok := want[violation.Code]; ok {
			want[violation.Code] = true
		}
	}
	for code, found := range want {
		if !found {
			t.Fatalf("missing %s in %+v", code, violations)
		}
	}
}
