package exec

import (
	"paihuo/internal/store"
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

// omp 官方文档参数映射（omp.sh/docs / flag-tables）：skills→--skills、
// 全权→--auto-approve、自定义字段→--tools/--max-time/--profile/--provider。
func TestOmpAdapterBuild(t *testing.T) {
	a := &ompAdapter{baseAdapter{id: "omp", name: "omp", bin: "omp"}}
	o := RunOptions{
		Prompt:     "hi",
		SessionDir: "/s/x",
		Perm:       "full",
		Role: store.RoleConfig{
			Model:        "claude/claude-sonnet-4",
			SystemPrompt: "sys",
			Thinking:     "high",
			Skills:       []string{"/sk/a", "/sk/b"},
			Plugins:      []string{"/p.toml"},
			ExtraArgs:    []string{"--no-lsp"},
			Custom: map[string]string{
				"tools":    "read,edit,bash",
				"max_time": "30m",
				"profile":  "work",
				"provider": "claude",
			},
		},
	}
	bin, args, _, err := a.Build(o)
	if err != nil {
		t.Fatal(err)
	}
	if bin != "omp" {
		t.Fatalf("bin=%q", bin)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-p hi", "--no-pty", "--session-dir /s/x", "--model claude/claude-sonnet-4",
		"--append-system-prompt sys", "--slow", "--skills /sk/a,/sk/b",
		"--config /p.toml", "--tools read,edit,bash", "--max-time 30m",
		"--profile work", "--provider claude", "--auto-approve", "--no-lsp",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("缺少参数 %q（完整: %s）", want, joined)
		}
	}
	if strings.Contains(joined, "--add-dir") {
		t.Fatalf("旧参数 --add-dir 不应再出现: %s", joined)
	}
}

// omp schema 含官方新增选项；review 权限不传 --auto-approve。
func TestOmpSchemaAndPerm(t *testing.T) {
	a := &ompAdapter{baseAdapter{id: "omp", name: "omp", bin: "omp"}}
	keys := map[string]bool{}
	for _, f := range a.Schema() {
		keys[f.Key] = true
	}
	for _, want := range []string{"tools", "max_time", "profile", "provider"} {
		if !keys[want] {
			t.Fatalf("schema 缺少 %s", want)
		}
	}
	if got := a.Docs(); got != "https://omp.sh/docs" {
		t.Fatalf("Docs=%q", got)
	}
	_, args, _, err := a.Build(RunOptions{Prompt: "p", Perm: "review", Role: store.RoleConfig{}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args, " "), "--auto-approve") {
		t.Fatal("review 权限不应带 --auto-approve")
	}
}

// pi（pi.dev 官方文档 0.83+）：thinking→--thinking、skills→--skill 逐目录、
// provider/tools/exclude_tools/models_cycle→官方参数。
func TestPiAdapterBuild(t *testing.T) {
	a := &piAdapter{baseAdapter{id: "pi", name: "Pi Agent", bin: "pi"}}
	o := RunOptions{
		Prompt:     "hi",
		SessionDir: "/s/x",
		Role: store.RoleConfig{
			Model:        "anthropic/claude-sonnet-4",
			SystemPrompt: "sys",
			Thinking:     "high",
			Skills:       []string{"/sk/a", "/sk/b"},
			ExtraArgs:    []string{"--offline"},
			Custom: map[string]string{
				"provider":      "anthropic",
				"tools":         "read,write,bash",
				"exclude_tools": "browser",
				"models_cycle":  "anthropic/*,*sonnet*",
			},
		},
	}
	_, args, _, err := a.Build(o)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-p hi", "--session-dir /s/x", "--model anthropic/claude-sonnet-4",
		"--append-system-prompt sys", "--provider anthropic", "--tools read,write,bash",
		"--exclude-tools browser", "--models anthropic/*,*sonnet*",
		"--thinking high", "--skill /sk/a", "--skill /sk/b", "--offline",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("缺少参数 %q（完整: %s）", want, joined)
		}
	}
}

// pi schema：thinking 8 档官方选项、skills 保留、plugins 移除、新增 4 字段。
func TestPiSchema(t *testing.T) {
	a := &piAdapter{baseAdapter{id: "pi", name: "Pi Agent", bin: "pi"}}
	fs := a.Schema()
	keys := map[string]*Field{}
	for i := range fs {
		keys[fs[i].Key] = &fs[i]
	}
	for _, want := range []string{"model", "system_prompt", "instructions", "thinking", "skills", "provider", "tools", "exclude_tools", "models_cycle", "extra_args", "env"} {
		if keys[want] == nil {
			t.Fatalf("schema 缺少 %s", want)
		}
	}
	if keys["plugins"] != nil {
		t.Fatal("pi schema 不应有 plugins")
	}
	if got := keys["thinking"].Options; len(got) != 8 || got[1] != "off" || got[7] != "max" {
		t.Fatalf("thinking 选项应为 8 档官方值，得到 %v", got)
	}
	if got := a.Docs(); got != "https://pi.dev/docs" {
		t.Fatalf("Docs=%q", got)
	}
	// Warnings：skills/thinking 不再告警（已支持），plugins 仍告警
	if ws := a.Warnings(RunOptions{Role: store.RoleConfig{Skills: []string{"/s"}}}); len(ws) != 0 {
		t.Fatalf("skills 应受支持，不应有警告: %v", ws)
	}
	if ws := a.Warnings(RunOptions{Role: store.RoleConfig{Plugins: []string{"/p"}}}); len(ws) != 1 {
		t.Fatalf("plugins 应有一条警告，得到 %v", ws)
	}
}
