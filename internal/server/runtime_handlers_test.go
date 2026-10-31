package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"paihuo/internal/store"
)

func TestRuntimeAPIsExposeOnlySupportedProviders(t *testing.T) {
	// 不依赖宿主机安装或登录状态，也不启动真实 CLI。
	runtimeProbeHome(t)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	env := newTestServer(t, withTestExecutor(t.TempDir(), "runtime-catalog.db", "runtime-catalog-test"))
	handler := env.server.Handler()

	for _, path := range []string{"/api/v1/runtimes", "/api/v1/runtimes/provisioning"} {
		t.Run(path, func(t *testing.T) {
			resp := httptest.NewRecorder()
			handler.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, path, nil))
			if resp.Code != http.StatusOK {
				t.Fatalf("读取 Runtime 列表失败: code=%d body=%s", resp.Code, resp.Body.String())
			}
			var items []struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(resp.Body.Bytes(), &items); err != nil {
				t.Fatal(err)
			}
			var ids []string
			for _, item := range items {
				ids = append(ids, item.ID)
			}
			if got := strings.Join(ids, ","); got != "claude,codex,dsh,pi" {
				t.Fatalf("Runtime 列表应只保留四种提供者，得到 %q", got)
			}
		})
	}

	for _, runtimeID := range []string{"omp", "opencode"} {
		for _, path := range []string{"/api/v1/runtimes/install", "/api/v1/roles"} {
			t.Run(runtimeID+path, func(t *testing.T) {
				resp := httptest.NewRecorder()
				body := `{"runtime_id":"` + runtimeID + `"}`
				if path == "/api/v1/roles" {
					body = `{"runtime_id":"` + runtimeID + `","name":"removed-runtime"}`
				}
				handler.ServeHTTP(resp, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
				if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "未知 Runtime: "+runtimeID) {
					t.Fatalf("已移除的 Runtime 应被拒绝: code=%d body=%s", resp.Code, resp.Body.String())
				}
			})
		}
	}
}

func TestRuntimeSkillsDiscoverUserProjectAndLinkedSkills(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	source := filepath.Join(t.TempDir(), "global-design")
	writeTestSkill(t, source, "---\nname: global-design\ndescription: global skill\n---\n")
	userSkills := filepath.Join(home, ".claude", "skills")
	if err := os.MkdirAll(userSkills, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(source, filepath.Join(userSkills, "design")); err != nil {
		t.Fatal(err)
	}
	project := t.TempDir()
	writeTestSkill(t, filepath.Join(project, ".claude", "skills", "project-review"), "---\nname: project-review\ndescription: project skill\n---\n")
	env := newTestServer(t, withTestExecutor(t.TempDir(), "runtime-skills.db", "runtime-skills-test"))
	projectID, err := env.store.CreateProject(store.Project{Name: "skill-project", ProjectDir: project, Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	resp := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/runtimes/claude/skills?project_id="+itoa(projectID), nil))
	if resp.Code != http.StatusOK {
		t.Fatalf("skill discovery failed: %d %s", resp.Code, resp.Body.String())
	}
	var result struct {
		RuntimeID string                               `json:"runtime_id"`
		Skills    []struct{ Name, Path, Scope string } `json:"skills"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	byName := map[string]string{}
	for _, skill := range result.Skills {
		byName[skill.Name] = skill.Scope
	}
	if result.RuntimeID != "claude" || byName["global-design"] != "user" || byName["project-review"] != "project" {
		t.Fatalf("native roots should include user/project/linked skills: %s", resp.Body.String())
	}
}

func TestRuntimeSkillsUseCodexNativeCatalogIncludingDisabledPlugins(t *testing.T) {
	_, bin := runtimeProbeHome(t)
	program := `#!/bin/sh
while IFS= read -r line; do
case "$line" in
  *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
  *'"method":"skills/list"'*) printf '%s\n' '{"id":2,"result":{"data":[{"skills":[{"name":"plugin-review","description":"review","path":"/plugins/review/SKILL.md","scope":"user","enabled":false,"pluginId":"review-plugin"}],"errors":[]}]}}' ;;
esac
done
`
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(program), 0o755); err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t, withTestExecutor(t.TempDir(), "codex-inventory.db", "codex-inventory"))
	resp := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/runtimes/codex/skills", nil))
	var result struct {
		Skills []struct {
			Name    string
			Enabled *bool
			Source  string
		}
		Complete bool
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if resp.Code != http.StatusOK || !result.Complete || len(result.Skills) != 1 || result.Skills[0].Enabled == nil || *result.Skills[0].Enabled || result.Skills[0].Source != "review-plugin" {
		t.Fatalf("native disabled/plugin metadata must survive discovery: %s", resp.Body.String())
	}
}

func runtimeProbeHome(t *testing.T) (string, string) {
	t.Helper()
	home, bin := t.TempDir(), t.TempDir()
	t.Chdir(t.TempDir())
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin)
	for _, env := range os.Environ() {
		key, _, _ := strings.Cut(env, "=")
		if strings.HasSuffix(key, "_API_KEY") || strings.HasSuffix(key, "_TOKEN") || strings.HasSuffix(key, "_AUTH_TOKEN") {
			t.Setenv(key, "")
		}
	}
	for _, key := range []string{"CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "DSH_HOME", "DSH_AGENTS_HOME", "DSH_BUNDLED_SKILL_DIR"} {
		t.Setenv(key, "")
	}
	return home, bin
}

func TestRuntimeSkillsFindPiPackagesAndHonorDisabledSkills(t *testing.T) {
	_, _ = runtimeProbeHome(t)
	agent := t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", agent)
	writeTestSkill(t, filepath.Join(agent, "skills", "user-skill"), "---\nname: user-skill\ndescription: user\n---\n")
	writeTestSkill(t, filepath.Join(agent, "packages", "tools", "skills", "package-skill"), "---\nname: package-skill\ndescription: package\n---\n")
	if err := os.WriteFile(filepath.Join(agent, "settings.json"), []byte(`{"packages":[{"source":"./packages/tools","skills":[]}],"skills":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t, withTestExecutor(t.TempDir(), "pi-inventory.db", "pi-inventory"))
	resp := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/runtimes/pi/skills", nil))
	var result struct {
		Skills []struct {
			Name, Scope string
			Enabled     *bool
		}
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	found := map[string]*bool{}
	for _, skill := range result.Skills {
		found[skill.Name] = skill.Enabled
	}
	if len(found) != 2 || found["package-skill"] == nil || *found["package-skill"] || found["user-skill"] == nil || !*found["user-skill"] {
		t.Fatalf("Pi package skill installation and filters must be visible: %s", resp.Body.String())
	}
}

func TestRuntimeSkillsFindDSHCustomHomesAndPresets(t *testing.T) {
	runtimeProbeHome(t)
	home, shared := t.TempDir(), t.TempDir()
	t.Setenv("DSH_HOME", home)
	t.Setenv("DSH_AGENTS_HOME", shared)
	writeTestSkill(t, filepath.Join(home, "skills", "dsh-user"), "---\nname: dsh-user\ndescription: user\n---\n")
	writeTestSkill(t, filepath.Join(shared, "skills", "shared"), "---\nname: shared\ndescription: shared\n---\n")
	writeTestSkill(t, filepath.Join(home, ".agent-presets", "custom", "skills", "preset"), "---\nname: preset\ndescription: preset\n---\n")
	env := newTestServer(t, withTestExecutor(t.TempDir(), "dsh-inventory.db", "dsh-inventory"))
	resp := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/runtimes/dsh/skills", nil))
	var result struct {
		Skills []struct {
			Name, Scope string
			Enabled     *bool
		}
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	found := map[string]string{}
	for _, skill := range result.Skills {
		found[skill.Name] = skill.Scope
		if skill.Name == "preset" && skill.Enabled != nil {
			t.Fatal("preset activity depends on selected agent")
		}
	}
	if found["dsh-user"] != "user" || found["shared"] != "user" || found["preset"] != "preset" {
		t.Fatalf("DSH runtime roots were missed: %s", resp.Body.String())
	}
}

func TestRuntimeSkillsIncludeClaudePluginInstallationAndEnablement(t *testing.T) {
	home, _ := runtimeProbeHome(t)
	plugin := t.TempDir()
	writeTestSkill(t, filepath.Join(plugin, "skills", "plugin-skill"), "---\nname: plugin-skill\ndescription: plugin\n---\n")
	dir := filepath.Join(home, ".claude", "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	installed, _ := json.Marshal(map[string]any{"version": 2, "plugins": map[string]any{"tools@example": []map[string]any{{"scope": "user", "installPath": plugin}}}})
	if err := os.WriteFile(filepath.Join(dir, "installed_plugins.json"), installed, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{"enabledPlugins":{"tools@example":false}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t, withTestExecutor(t.TempDir(), "claude-inventory.db", "claude-inventory"))
	resp := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/runtimes/claude/skills", nil))
	var result struct {
		Skills []struct {
			Name, Source string
			Enabled      *bool
		}
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Skills) != 1 || result.Skills[0].Source != "tools@example" || result.Skills[0].Enabled == nil || *result.Skills[0].Enabled {
		t.Fatalf("Claude plugin inventory must distinguish disabled installations: %s", resp.Body.String())
	}
}

func TestRuntimeSkillsUsePiNativeCatalog(t *testing.T) {
	_, bin := runtimeProbeHome(t)
	program := `#!/bin/sh
while IFS= read -r line; do
case "$line" in
 *'"type":"get_commands"'*) printf '%s\n' '{"id":"paihuo-skills","type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"skill:native-pi","description":"native package skill","source":"skill","sourceInfo":{"path":"/pi/packages/native/SKILL.md","source":"npm:example","scope":"user","origin":"package"}}]}}' ;;
esac
done
`
	if err := os.WriteFile(filepath.Join(bin, "pi"), []byte(program), 0o755); err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t, withTestExecutor(t.TempDir(), "pi-native.db", "pi-native"))
	resp := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/runtimes/pi/skills", nil))
	var result struct {
		Skills []struct {
			Name    string
			Enabled *bool
		}
		Complete bool
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Skills) != 1 || result.Skills[0].Name != "native-pi" || result.Skills[0].Enabled == nil || !*result.Skills[0].Enabled || !result.Complete {
		t.Fatalf("native Pi package resolution must be honored: %s", resp.Body.String())
	}
}

func TestRuntimeRefreshRechecksCredentialsImmediately(t *testing.T) {
	home, _ := runtimeProbeHome(t)
	env := newTestServer(t, withTestExecutor(t.TempDir(), "runtime-refresh.db", "runtime-refresh"))
	handler := env.server.Handler()
	readPi := func() bool {
		t.Helper()
		resp := httptest.NewRecorder()
		handler.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/runtimes/provisioning", nil))
		var items []struct {
			ID    string
			Login bool
		}
		if err := json.Unmarshal(resp.Body.Bytes(), &items); err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			if item.ID == "pi" {
				return item.Login
			}
		}
		t.Fatal("Pi missing")
		return false
	}
	if readPi() {
		t.Fatal("empty home must not be authenticated")
	}
	dir := filepath.Join(home, ".pi", "agent")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"deepseek":{"type":"api_key","key":"fixture-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	refresh := httptest.NewRecorder()
	handler.ServeHTTP(refresh, httptest.NewRequest(http.MethodPost, "/api/v1/runtimes/refresh", nil))
	if refresh.Code != http.StatusOK || !readPi() {
		t.Fatalf("manual refresh must discard stale credential state: %d", refresh.Code)
	}
}

func TestRuntimeSkillsMergePiSymlinksWithNativeCatalog(t *testing.T) {
	home, bin := runtimeProbeHome(t)
	source := filepath.Join(t.TempDir(), "real-skill")
	writeTestSkill(t, source, "---\nname: linked\ndescription: skill\n---\n")
	root := filepath.Join(home, ".pi", "agent", "skills")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked")
	if err := os.Symlink(source, link); err != nil {
		t.Fatal(err)
	}
	native, _ := json.Marshal(map[string]any{"id": "paihuo-skills", "success": true, "data": map[string]any{"commands": []map[string]any{{"name": "skill:linked", "source": "skill", "sourceInfo": map[string]string{"path": filepath.Join(link, "SKILL.md"), "scope": "user"}}}}})
	program := "#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' '" + strings.ReplaceAll(string(native), "'", "'\\''") + "'; done\n"
	if err := os.WriteFile(filepath.Join(bin, "pi"), []byte(program), 0o755); err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t, withTestExecutor(t.TempDir(), "pi-linked.db", "pi-linked"))
	resp := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/runtimes/pi/skills", nil))
	var result struct {
		Skills []struct {
			Path    string
			Enabled *bool
		}
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Skills) != 1 || result.Skills[0].Path != filepath.Join(source, "SKILL.md") || result.Skills[0].Enabled == nil || !*result.Skills[0].Enabled {
		t.Fatalf("linked/native observations must produce one active skill: %s", resp.Body.String())
	}
}

func TestRuntimeSkillsRetainDisabledPiMarkdownFiles(t *testing.T) {
	home, bin := runtimeProbeHome(t)
	agent := filepath.Join(home, ".pi", "agent")
	root := filepath.Join(agent, "skills")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "flat.md"), []byte("---\nname: flat\ndescription: standalone skill\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	shared := filepath.Join(home, ".agents", "skills", "group")
	if err := os.MkdirAll(shared, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shared, "nested.md"), []byte("---\nname: nested\ndescription: shared standalone skill\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(agent, "settings.json"), []byte(`{"skills":["!skills/flat.md"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "pi"), []byte("#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' '{\"id\":\"paihuo-skills\",\"success\":true,\"data\":{\"commands\":[]}}'; done\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	env := newTestServer(t, withTestExecutor(t.TempDir(), "pi-flat.db", "pi-flat"))
	resp := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/runtimes/pi/skills", nil))
	var result struct {
		Skills []struct {
			Name    string
			Enabled *bool
		}
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Skills) != 2 {
		t.Fatalf("disabled standalone skill must remain discoverable: %s", resp.Body.String())
	}
	for _, skill := range result.Skills {
		if skill.Enabled == nil || *skill.Enabled {
			t.Fatalf("native-disabled Markdown skill should remain disabled: %s", resp.Body.String())
		}
	}
}
