package exec

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"paihuo/internal/store"
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

// omp 官方文档参数映射（omp.sh/docs / flag-tables）：skills→--skills 名称过滤、
// 全权→--auto-approve、自定义字段→--tools/--max-time/--profile/--provider。
func TestOmpAdapterBuild(t *testing.T) {
	a := &ompAdapter{baseAdapter{id: "omp", name: "omp", bin: "omp"}}
	o := ExecutionRequest{
		Prompt:     "hi",
		SessionDir: "/s/x",
		Perm:       "full",
		Role: store.RoleConfig{
			Model:        "claude/claude-sonnet-4",
			SystemPrompt: "sys",
			Thinking:     "high",
			Plugins:      []string{"/p.toml"},
			ExtraArgs:    []string{"--no-lsp"},
			Custom: map[string]string{
				"tools":    "read,edit,bash",
				"max_time": "30m",
				"profile":  "work",
				"provider": "claude",
			},
		},
		SkillMount: &RoleSkillMount{OmpOverlay: "/runtime/omp-overlay.yml"},
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
		"--append-system-prompt sys", "--thinking high", "--config /runtime/omp-overlay.yml",
		"--config /p.toml", "--tools read,edit,bash", "--max-time 30m",
		"--profile work", "--provider claude", "--auto-approve", "--no-lsp",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("缺少参数 %q（完整: %s）", want, joined)
		}
	}
	if strings.Contains(joined, "--smol") || strings.Contains(joined, "--slow") {
		t.Fatalf("OMP 思考级别不应被误映射为模型角色 --smol/--slow: %s", joined)
	}
	if strings.Contains(joined, "--add-dir") {
		t.Fatalf("旧参数 --add-dir 不应再出现: %s", joined)
	}
}

// omp schema 含官方新增选项；review 权限不传 --auto-approve。
func TestOmpSchemaAndPerm(t *testing.T) {
	a := &ompAdapter{baseAdapter{id: "omp", name: "omp", bin: "omp"}}
	keys := map[string]bool{}
	var thinking *Field
	for _, f := range a.Schema() {
		keys[f.Key] = true
		if f.Key == "thinking" {
			copy := f
			thinking = &copy
		}
	}
	for _, want := range []string{"tools", "max_time", "profile", "provider"} {
		if !keys[want] {
			t.Fatalf("schema 缺少 %s", want)
		}
	}
	if thinking == nil || strings.Join(thinking.Options, ",") != "" {
		t.Fatalf("OMP 未探测到模型能力时只能保留默认思考档位: %+v", thinking)
	}
	if got := a.Docs(); got != "https://omp.sh/docs" {
		t.Fatalf("Docs=%q", got)
	}
	_, args, _, err := a.Build(ExecutionRequest{Prompt: "p", Perm: "review", Role: store.RoleConfig{}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args, " "), "--auto-approve") {
		t.Fatal("review 权限不应带 --auto-approve")
	}
}

// omp RPC 会话参数：--mode rpc 注入、角色参数映射、overlay config 优先于 --skills。
func TestBuildOmpRPCSessionArgs(t *testing.T) {
	role := store.RoleConfig{
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
	}
	args, err := BuildOmpRPCSessionArgs(role, &RoleSkillMount{OmpOverlay: "/ov/overlay.toml"}, "/s/x")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"--mode rpc", "--session-dir /s/x", "--model claude/claude-sonnet-4",
		"--append-system-prompt sys", "--thinking high", "--config /ov/overlay.toml",
		"--config /p.toml", "--tools read,edit,bash", "--max-time 30m",
		"--profile work", "--provider claude", "--no-lsp",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("缺少参数 %q（完整: %s）", want, joined)
		}
	}
	if strings.Contains(joined, "--skills") {
		t.Fatalf("有 overlay 时不应再传 --skills: %s", joined)
	}
	if strings.Contains(joined, "-p ") || strings.Contains(joined, " --no-pty") {
		t.Fatalf("RPC 会话不应带 -p/位置参数或 --no-pty: %s", joined)
	}
	// 无挂载时不允许命令翻译层直接读取 Role 中的技能源目录。
	args2, err := BuildOmpRPCSessionArgs(role, nil, "/s/x")
	if err != nil {
		t.Fatal(err)
	}
	joined2 := strings.Join(args2, " ")
	if strings.Contains(joined2, "--skills") || !strings.Contains(joined2, "--mode rpc") {
		t.Fatalf("无挂载时不应从源目录生成技能参数: %s", joined2)
	}
}

// pi（pi.dev 官方文档 0.83+）：thinking→--thinking、skills→--skill 逐目录、
// provider/tools/exclude_tools/models_cycle→官方参数。
func TestPiAdapterBuild(t *testing.T) {
	a := &piAdapter{baseAdapter{id: "pi", name: "Pi Role", bin: "pi"}}
	o := ExecutionRequest{
		Prompt:     "hi",
		SessionDir: "/s/x",
		Role: store.RoleConfig{
			Model:        "anthropic/claude-sonnet-4",
			SystemPrompt: "sys",
			Thinking:     "high",
			ExtraArgs:    []string{"--offline"},
			Custom: map[string]string{
				"provider":      "anthropic",
				"tools":         "read,write,bash",
				"exclude_tools": "browser",
				"models_cycle":  "anthropic/*,*sonnet*",
				"extensions":    "npm:pi-web-access, git:github.com/acme/pi-ext, npm:pi-web-access",
			},
		},
		SkillMount: &RoleSkillMount{SkillPaths: []string{"/task/.agents/skills/skill-a", "/task/.agents/skills/skill-b"}},
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
		"--thinking high", "--skill /task/.agents/skills/skill-a", "--skill /task/.agents/skills/skill-b", "--offline",
		"--no-extensions", "--extension npm:pi-web-access", "--extension git:github.com/acme/pi-ext",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("缺少参数 %q（完整: %s）", want, joined)
		}
	}
	if got := strings.Count(joined, "--extension npm:pi-web-access"); got != 1 {
		t.Fatalf("重复扩展来源应去重，出现 %d 次: %s", got, joined)
	}
}

// pi schema：模型目录没有逐模型思考档位时保留完整通用选项；skills 和
// 角色级 extensions 保留、plugins 移除，并保留 Pi 官方参数字段。
func TestPiSchema(t *testing.T) {
	a := &piAdapter{baseAdapter{id: "pi", name: "Pi Role", bin: "pi"}}
	fs := a.Schema()
	keys := map[string]*Field{}
	for i := range fs {
		keys[fs[i].Key] = &fs[i]
	}
	for _, want := range []string{"model", "system_prompt", "instructions", "thinking", "skills", "extensions", "provider", "tools", "exclude_tools", "models_cycle", "extra_args", "env"} {
		if keys[want] == nil {
			t.Fatalf("schema 缺少 %s", want)
		}
	}
	if keys["plugins"] != nil {
		t.Fatal("pi schema 不应有 plugins")
	}
	if extensions := keys["extensions"]; extensions.Source != "extensions" || extensions.Builtin {
		t.Fatalf("Pi extensions 应从安装源读取并存入 custom: %+v", extensions)
	}
	wantThinking := []string{"", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
	if got := keys["thinking"].Options; strings.Join(got, ",") != strings.Join(wantThinking, ",") {
		t.Fatalf("没有逐模型能力目录时 thinking 应保留完整通用选项，得到 %v", got)
	}
	if got := a.Docs(); got != "https://pi.dev/docs" {
		t.Fatalf("Docs=%q", got)
	}
	// Warnings：skills/thinking 不再告警（已支持），plugins 仍告警
	if ws := a.Warnings(ExecutionRequest{Role: store.RoleConfig{Skills: []string{"/s"}}}); len(ws) != 0 {
		t.Fatalf("skills 应受支持，不应有警告: %v", ws)
	}
	if ws := a.Warnings(ExecutionRequest{Role: store.RoleConfig{Plugins: []string{"/p"}}}); len(ws) != 1 {
		t.Fatalf("plugins 应有一条警告，得到 %v", ws)
	}
}

func TestPiExtensionSelectionAndRPC(t *testing.T) {
	a := &piAdapter{baseAdapter{id: "pi", name: "Pi Role", bin: "pi"}}
	_, defaultArgs, _, err := a.Build(ExecutionRequest{Prompt: "p", Role: store.RoleConfig{}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(defaultArgs, " "), "--no-extensions") {
		t.Fatalf("未声明扩展集合时应采用 Runtime 默认发现: %v", defaultArgs)
	}

	disabled := store.RoleConfig{Custom: map[string]string{"extensions": ""}}
	_, disabledArgs, _, err := a.Build(ExecutionRequest{Prompt: "p", Role: disabled})
	if err != nil {
		t.Fatal(err)
	}
	joinedDisabled := strings.Join(disabledArgs, " ")
	if !strings.Contains(joinedDisabled, "--no-extensions") || strings.Contains(joinedDisabled, "--extension ") {
		t.Fatalf("显式清空扩展应禁用自动发现且不加载扩展: %s", joinedDisabled)
	}

	role := store.RoleConfig{Custom: map[string]string{"extensions": "npm:pi-subagents,/opt/pi/local.ts"}}
	rpcArgs, err := BuildPiRPCSessionArgs(role, nil, "/sessions/pi")
	if err != nil {
		t.Fatal(err)
	}
	joinedRPC := strings.Join(rpcArgs, " ")
	for _, want := range []string{"--mode rpc", "--session-dir /sessions/pi", "--no-extensions", "--extension npm:pi-subagents", "--extension /opt/pi/local.ts"} {
		if !strings.Contains(joinedRPC, want) {
			t.Fatalf("Pi RPC 缺少参数 %q: %s", want, joinedRPC)
		}
	}
}

// 角色级技能挂载：omp 用 overlay --config（不再 --skills 过滤）、opencode 用
// OPENCODE_CONFIG_CONTENT env（不再 --config）、claude 用 --plugin-dir。
func TestSkillMountWiringAcrossAdapters(t *testing.T) {
	mount := &RoleSkillMount{
		SkillPaths:     []string{"/role/.agents/skills/design", "/role/.agents/skills/review"},
		OmpOverlay:     "/role/overlay.yml",
		OpencodeConfig: `{"skills":{"paths":["/role/.agents/skills/design"]}}`,
		ClaudePlugin:   "/role",
	}

	t.Run("omp", func(t *testing.T) {
		a := &ompAdapter{baseAdapter{id: "omp", name: "omp", bin: "omp"}}
		_, args, _, err := a.Build(ExecutionRequest{
			Prompt: "p", Role: store.RoleConfig{Skills: []string{"/sk/a"}}, SkillMount: mount,
		})
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, "--config /role/overlay.yml") {
			t.Fatalf("omp 应使用 overlay --config: %s", joined)
		}
		if strings.Contains(joined, "--skills") {
			t.Fatalf("有 SkillMount 时 omp 不应再用 --skills: %s", joined)
		}
	})

	t.Run("opencode", func(t *testing.T) {
		a := &openCodeAdapter{baseAdapter{id: "opencode", name: "opencode", bin: "opencode"}}
		_, args, env, err := a.Build(ExecutionRequest{
			Dir: "/repo", Prompt: "p", Role: store.RoleConfig{},
			SkillMount: mount,
		})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.Join(args, " "), "--config") {
			t.Fatalf("opencode 1.18 不应再传 --config: %v", args)
		}
		if !envHas(env, "OPENCODE_CONFIG_CONTENT", mount.OpencodeConfig) {
			t.Fatalf("opencode env 应含 OPENCODE_CONFIG_CONTENT: %v", env)
		}
	})

	t.Run("claude", func(t *testing.T) {
		a := &claudeAdapter{baseAdapter{id: "claude", name: "claude", bin: "claude"}}
		_, args, _, err := a.Build(ExecutionRequest{Prompt: "p", Role: store.RoleConfig{}, SkillMount: mount})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.Join(args, " "), "--plugin-dir /role") {
			t.Fatalf("claude 应使用 --plugin-dir: %v", args)
		}
	})

	t.Run("pi", func(t *testing.T) {
		a := &piAdapter{baseAdapter{id: "pi", name: "Pi Role", bin: "pi"}}
		_, args, _, err := a.Build(ExecutionRequest{Prompt: "p", Role: store.RoleConfig{}, SkillMount: mount})
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(args, " ")
		for _, want := range mount.SkillPaths {
			if !strings.Contains(joined, "--skill "+want) {
				t.Fatalf("pi 应逐目录 --skill: %s", joined)
			}
		}
	})
}

// codex：非 git 项目 safe 模式注入 --skip-git-repo-check；交互 TUI 不注入。
func TestCodexSkipGitRepoCheck(t *testing.T) {
	a := &codexAdapter{baseAdapter{id: "codex", name: "codex", bin: "codex"}}
	_, args, _, err := a.Build(ExecutionRequest{
		Prompt: "p", RunMode: store.RunModeBatch, SkipGitCheck: true, Role: store.RoleConfig{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(args, " "), "--skip-git-repo-check") {
		t.Fatalf("safe 模式非 git 项目应注入 --skip-git-repo-check: %v", args)
	}
	_, args, _, err = a.Build(ExecutionRequest{
		Prompt: "p", RunMode: store.RunModeInteractive, SkipGitCheck: true, Role: store.RoleConfig{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args, " "), "--skip-git-repo-check") {
		t.Fatalf("交互 TUI 不应传 --skip-git-repo-check: %v", args)
	}
}

func envHas(env []string, key, want string) bool {
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			return v == want
		}
	}
	return false
}

func envGet(env []string, key string) (string, bool) {
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			return v, true
		}
	}
	return "", false
}

func TestOpenCodeAdapterPassesVariantNameDirectly(t *testing.T) {
	a := &openCodeAdapter{baseAdapter{id: "opencode", name: "opencode", bin: "opencode"}}
	_, args, _, err := a.Build(ExecutionRequest{
		Dir:    "/repo",
		Prompt: "hi",
		Role:   store.RoleConfig{Model: "opencode/deepseek-v4-flash-free", Thinking: "max"},
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--variant max") {
		t.Fatalf("OpenCode 应原样传递模型声明的 variant: %s", joined)
	}
	if strings.Contains(joined, "--variant minimal") {
		t.Fatalf("OpenCode 不应把 low 猜测映射为 minimal: %s", joined)
	}
}

func TestNativeSkillAdaptersDoNotTreatSkillsAsUnsupported(t *testing.T) {
	claude := &claudeAdapter{baseAdapter{id: "claude", name: "claude", bin: "claude"}}
	_, args, _, err := claude.Build(ExecutionRequest{Prompt: "p", Role: store.RoleConfig{Skills: []string{"/skill"}}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args, " "), "--add-dir") {
		t.Fatalf("claude skills must use native .claude/skills discovery, got %v", args)
	}
	if ws := (&codexAdapter{baseAdapter{id: "codex", name: "codex", bin: "codex"}}).Warnings(ExecutionRequest{Role: store.RoleConfig{Skills: []string{"/skill"}}}); len(ws) != 0 {
		t.Fatalf("codex skills should be supported through native discovery, got %v", ws)
	}
	keys := map[string]bool{}
	for _, field := range (&openCodeAdapter{baseAdapter{id: "opencode", name: "opencode", bin: "opencode"}}).Schema() {
		keys[field.Key] = true
		if field.Key == "thinking" && strings.Join(field.Options, ",") != "" {
			t.Fatalf("OpenCode 未探测到模型能力时只能保留默认思考档位: %+v", field)
		}
	}
	if !keys["skills"] {
		t.Fatal("opencode schema must expose role skills")
	}
}

// 角色创建的选项以 schema 为准：Enrich 从 RoleConfig 结构体反射派生 builtin
// 标记。在 Go 里新增/删除角色创建选项后，前端（创建弹窗与角色页面配置表单）
// 都按这个标记读写，无需再改前端硬编码清单——这里锁住两者的同步性。
func TestSchemaBuiltinMarking(t *testing.T) {
	fs := Enrich([]Field{
		{Key: "model"}, {Key: "skills"}, {Key: "provider"}, {Key: "execution_mode"},
	})
	want := map[string]bool{"model": true, "skills": true, "provider": false, "execution_mode": false}
	for _, f := range fs {
		if f.Builtin != want[f.Key] {
			t.Fatalf("字段 %s builtin=%v，期望 %v", f.Key, f.Builtin, want[f.Key])
		}
	}

	// builtin 集合必须与 RoleConfig 的 JSON 顶层字段一一对应（custom 除外）。
	wantKeys := []string{"env", "extra_args", "instructions", "model", "plugins", "skills", "system_prompt", "thinking"}
	got := make([]string, 0, len(wantKeys))
	for k, v := range builtinKeys {
		if v {
			got = append(got, k)
		}
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(wantKeys, ",") {
		t.Fatalf("builtinKeys 与 RoleConfig 不同步：得到 %v", got)
	}
}

// 每个 CLI 的交互退出命令映射：pi 用 /quit，其余（omp/opencode/claude/
// codex/dsh）用 /exit。按钮「结束会话」据此发送，命令不对 agent 不会退出。
func TestAdapterExitCommands(t *testing.T) {
	want := map[string]string{
		"pi":       "/quit",
		"omp":      "/exit",
		"opencode": "/exit",
		"claude":   "/exit",
		"codex":    "/exit",
		"dsh":      "/exit",
	}
	for _, a := range commandAdapters() {
		if got := a.ExitCommand(); got != want[a.ID()] {
			t.Fatalf("CLI %s 退出命令为 %q，期望 %q", a.ID(), got, want[a.ID()])
		}
	}
}

// dsh：批处理 headless（提示词是位置参数）、custom.profile 覆盖模式、
// 模式/提示词/权限走原生环境变量（DSH_TUI_PRESET / DSH_TUI_PERSONA /
// DSH_PERMISSION_MODE）。结构化会话不经 CLI 参数翻译（走 dsh web HTTP 通道）。
func TestDshAdapterBuild(t *testing.T) {
	a := &dshAdapter{baseAdapter{id: "dsh", name: "DSH（DeepSeek Harness）", bin: "dsh"}}

	// 批处理默认 headless
	_, args, env, err := a.Build(ExecutionRequest{Prompt: "hi", Role: store.RoleConfig{}})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"--profile headless", "hi"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("缺少参数 %q（完整: %s）", want, joined)
		}
	}
	if args[len(args)-1] != "hi" {
		t.Fatalf("提示词应作为最后一个位置参数: %#v", args)
	}
	if _, present := envGet(env, "DSH_TUI_SESSION_ROOT"); present {
		t.Fatalf("headless 不应注入 TUI 会话根（一次性任务）: %v", env)
	}

	// custom.profile 覆盖（支持 dsh 的各种模式）
	_, args, _, err = a.Build(ExecutionRequest{Prompt: "p", Role: store.RoleConfig{Custom: map[string]string{"profile": "web"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(args, " "), "--profile web") {
		t.Fatalf("自定义 profile 应覆盖默认: %v", args)
	}

	// 原生模式 env：preset→DSH_TUI_PRESET、system_prompt→DSH_TUI_PERSONA、
	// 权限映射→DSH_PERMISSION_MODE（full=免审批无沙箱 / review=沙箱+审批）
	_, _, env, err = a.Build(ExecutionRequest{
		Prompt: "p", Perm: store.PermFull,
		Role: store.RoleConfig{
			SystemPrompt: "你是严格的前端评审员",
			Custom:       map[string]string{"preset": "minimal"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !envHas(env, "DSH_TUI_PRESET", "minimal") {
		t.Fatalf("预设应注入 DSH_TUI_PRESET: %v", env)
	}
	if !envHas(env, "DSH_TUI_PERSONA", "你是严格的前端评审员") {
		t.Fatalf("系统提示词应注入 DSH_TUI_PERSONA: %v", env)
	}
	if !envHas(env, "DSH_PERMISSION_MODE", "danger-full-access") {
		t.Fatalf("full 权限应映射为 danger-full-access: %v", env)
	}
	_, _, env, err = a.Build(ExecutionRequest{Prompt: "p", Perm: store.PermReview, Role: store.RoleConfig{}})
	if err != nil {
		t.Fatal(err)
	}
	if !envHas(env, "DSH_PERMISSION_MODE", "workspace-write") {
		t.Fatalf("review 权限应映射为 workspace-write: %v", env)
	}
	_, _, env, err = a.Build(ExecutionRequest{Prompt: "p", Role: store.RoleConfig{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := envGet(env, "DSH_PERMISSION_MODE"); present {
		t.Fatalf("未声明权限（batch 空权限）不应设置 DSH_PERMISSION_MODE: %v", env)
	}
}

// dshPresetCandidates 扫描 $DSH_HOME/.agent-presets 下已安装预设 + 内置候选。
func TestDshPresetCandidates(t *testing.T) {
	home := t.TempDir()
	t.Setenv("DSH_HOME", home)
	for _, dir := range []string{"minimal", "liangshen", ".hidden"} {
		if err := os.MkdirAll(filepath.Join(home, ".agent-presets", dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got := strings.Join(dshPresetCandidates(), ",")
	for _, want := range []string{"", "standard", "minimal", "liangshen"} {
		if !strings.Contains(got, want) {
			t.Fatalf("预设候选应包含 %q: %s", want, got)
		}
	}
	if strings.Contains(got, ".hidden") {
		t.Fatalf("隐藏目录不应作为预设候选: %s", got)
	}
}

// dsh schema：通用角色字段（system_prompt→persona）+ profile/preset 模式选择；
// 支持 skills 挂载到项目 .agents/skills；无 thinking/plugins 字段。
func TestDshSchemaAndWarnings(t *testing.T) {
	a := &dshAdapter{baseAdapter{id: "dsh", name: "DSH", bin: "dsh"}}
	keys := map[string]*Field{}
	for i := range a.Schema() {
		keys[a.Schema()[i].Key] = &a.Schema()[i]
	}
	for _, want := range []string{"model", "provider", "reasoning_effort", "system_prompt", "instructions", "skills", "preset", "profile", "extra_args", "env"} {
		if keys[want] == nil {
			t.Fatalf("schema 缺少 %s", want)
		}
	}
	for _, absent := range []string{"thinking", "plugins"} {
		if keys[absent] != nil {
			t.Fatalf("dsh schema 不应有 %s", absent)
		}
	}
	if keys["profile"].Builtin || keys["preset"].Builtin {
		t.Fatal("profile/preset 应存入 RoleConfig.Custom，而不是顶层字段")
	}
	if got := a.Docs(); got != "https://github.com/deepseek-ai/deepseek-harness" {
		t.Fatalf("Docs=%q", got)
	}

	// system_prompt/skills 已原生支持，不再告警；model/provider 与 plugins 仍告警
	if ws := a.Warnings(ExecutionRequest{Role: store.RoleConfig{
		Model: "deepseek-v4-flash", Skills: []string{"/sk"}, Plugins: []string{"/p"},
	}}); len(ws) != 2 {
		t.Fatalf("model/plugins 各应有一条警告，得到 %v", ws)
	}
	if ws := a.Warnings(ExecutionRequest{Role: store.RoleConfig{SystemPrompt: "sys", Skills: []string{"/sk"}}}); len(ws) != 0 {
		t.Fatalf("system_prompt/skills 应受支持，不应有警告: %v", ws)
	}
	if ws := a.Warnings(ExecutionRequest{Role: store.RoleConfig{}}); len(ws) != 0 {
		t.Fatalf("空角色不应有警告: %v", ws)
	}
}
