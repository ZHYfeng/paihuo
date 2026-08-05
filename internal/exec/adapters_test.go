package exec

import (
	"strings"
	"testing"
)

// 环境变量覆盖必须原地替换：重复 KEY 直接 append 时多数 CLI 取第一个，覆盖会静默失效。
func TestMergeEnvOverridesInPlace(t *testing.T) {
	// 构造一个可控的"系统环境"：直接改 os.Environ 有并发风险，这里用
	// mergeEnv 的输入性质验证：结果中每个 KEY 只出现一次且值为覆盖值。
	extra := map[string]string{"PATH": "/role/path:/bin", "NEW_KEY": "v1"}
	env := mergeEnv(extra)

	seen := map[string]string{}
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if _, dup := seen[k]; dup {
			t.Fatalf("KEY %q 出现多次（覆盖失效）：%v", k, kv)
		}
		seen[k] = v
	}
	if got := seen["PATH"]; got != "/role/path:/bin" {
		t.Fatalf("PATH 应为角色覆盖值，得到 %q", got)
	}
	if got := seen["NEW_KEY"]; got != "v1" {
		t.Fatalf("NEW_KEY 应存在，得到 %q", got)
	}
}
