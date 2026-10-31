package exec_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"paihuo/internal/exec"
)

func provisionTestHome(t *testing.T) (string, string) {
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
	for _, key := range []string{"CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "DSH_HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"} {
		t.Setenv(key, "")
	}
	return home, bin
}

func writeProbeCLI(t *testing.T, bin, name, script string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func provisionFor(t *testing.T, id string) exec.ProvisionInfo {
	t.Helper()
	for _, info := range exec.NewDefaultRuntimeService().Provisioning() {
		if info.ID == id {
			return info
		}
	}
	t.Fatalf("missing runtime %s", id)
	return exec.ProvisionInfo{}
}

func TestProvisioningUsesClaudeNativeLoginStatus(t *testing.T) {
	_, bin := provisionTestHome(t)
	writeProbeCLI(t, bin, "claude", `case "$*" in
  --version) printf 'Claude test\n' ;;
  'auth status --json') printf '%s\n' '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}' ;;
  *) exit 1 ;;
esac
`)
	info := provisionFor(t, "claude")
	if !info.Installed || !info.Login {
		t.Fatalf("CLI reports authenticated without a credentials file: %+v", info)
	}
}

func TestProvisioningUsesCodexNativeLoginStatus(t *testing.T) {
	_, bin := provisionTestHome(t)
	writeProbeCLI(t, bin, "codex", `case "$*" in
  --version) printf 'codex test\n' ;;
  'login status') printf 'Logged in using ChatGPT\n' >&2 ;;
  *) exit 1 ;;
esac
`)
	info := provisionFor(t, "codex")
	if !info.Login || info.Auth.Status != "authenticated" {
		t.Fatalf("native status must include OS credential-store logins: %+v", info)
	}
}

func TestProvisioningFindsPiCredentialsInCustomAgentDirectory(t *testing.T) {
	provisionTestHome(t)
	agentDir := t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", agentDir)
	if err := os.WriteFile(filepath.Join(agentDir, "auth.json"), []byte(`{"deepseek":{"type":"api_key","key":"fixture-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	info := provisionFor(t, "pi")
	if !info.Login || info.Auth.Status != "configured" {
		t.Fatalf("custom Pi credentials must be detected without claiming remote validation: %+v", info)
	}
}

func TestProvisioningValidatesCredentialContents(t *testing.T) {
	for _, test := range []struct {
		id, envKey, filename, body, status string
	}{
		{"claude", "CLAUDE_CONFIG_DIR", ".credentials.json", `{}`, "missing"},
		{"codex", "CODEX_HOME", "auth.json", `{}`, "missing"},
		{"pi", "PI_CODING_AGENT_DIR", "auth.json", `{}`, "missing"},
		{"dsh", "DSH_HOME", ".credentials.yaml", "# no credentials\n", "missing"},
		{"claude", "CLAUDE_CONFIG_DIR", ".credentials.json", `{"claudeAiOauth":{"accessToken":"fixture-token"}}`, "configured"},
		{"codex", "CODEX_HOME", "auth.json", `{"OPENAI_API_KEY":"fixture-key"}`, "configured"},
		{"pi", "PI_CODING_AGENT_DIR", "auth.json", `{"deepseek":{"type":"api_key","key":"fixture-key"}}`, "configured"},
		{"dsh", "DSH_HOME", ".credentials.yaml", "version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-key\n", "configured"},
		{"pi", "PI_CODING_AGENT_DIR", "auth.json", `{"deepseek":{"type":"api_key","key":42}}`, "invalid"},
		{"dsh", "DSH_HOME", ".credentials.yaml", "version: 1\nrefs: [invalid\n", "invalid"},
		{"dsh", "DSH_HOME", ".credentials.yaml", "version: 1\nrecords:\n  provider/deepseek:\n    kind: api-key\n    env:\n      DEEPSEEK_API_KEY: 42\n", "invalid"},
		{"dsh", "DSH_HOME", ".credentials.yaml", "version: 1\nrecords:\n  provider/deepseek:\n    kind: api-key\n    key: fixture-key\n    unknown: value\n", "invalid"},
	} {
		t.Run(test.id+"/"+test.status+"/"+test.body, func(t *testing.T) {
			provisionTestHome(t)
			dir := t.TempDir()
			t.Setenv(test.envKey, dir)
			if err := os.WriteFile(filepath.Join(dir, test.filename), []byte(test.body), 0o600); err != nil {
				t.Fatal(err)
			}
			info := provisionFor(t, test.id)
			if info.Auth.Status != test.status || info.Login != (test.status == "configured") {
				t.Fatalf("credential classification: got %+v, want %s", info, test.status)
			}
			encoded, _ := json.Marshal(info)
			if strings.Contains(string(encoded), "fixture-key") || strings.Contains(string(encoded), "fixture-token") {
				t.Fatalf("credential response must never expose values")
			}
		})
	}
}

func TestProvisioningDistinguishesProbeFailureFromSignedOut(t *testing.T) {
	_, bin := provisionTestHome(t)
	writeProbeCLI(t, bin, "codex", `case "$*" in
 --version) printf 'codex test\n' ;;
 *) printf 'keyring temporarily unavailable: private-fixture-value\n' >&2; exit 2 ;;
esac
`)
	info := provisionFor(t, "codex")
	if info.Auth.Status != "unknown" || info.Login {
		t.Fatalf("failed native status must remain unknown: %+v", info)
	}
	raw, _ := json.Marshal(info)
	if strings.Contains(string(raw), "private-fixture-value") {
		t.Fatal("native diagnostic leaked into API")
	}
}

func TestProvisioningFindsEnvironmentCredentialsWithoutFiles(t *testing.T) {
	for _, id := range []string{"claude", "codex", "pi", "dsh"} {
		t.Run(id, func(t *testing.T) {
			provisionTestHome(t)
			key := "DEEPSEEK_API_KEY"
			if id == "claude" {
				key = "ANTHROPIC_API_KEY"
			}
			if id == "codex" {
				key = "OPENAI_API_KEY"
			}
			t.Setenv(key, "environment-fixture-key")
			info := provisionFor(t, id)
			if !info.Login || info.Auth.Status != "configured" {
				t.Fatalf("environment credentials should be observed: %+v", info)
			}
			raw, _ := json.Marshal(info)
			if strings.Contains(string(raw), "environment-fixture-key") {
				t.Fatal("environment credential leaked")
			}
		})
	}
}

func TestProvisioningRejectsDSHFilePermissionsRejectedByRuntime(t *testing.T) {
	provisionTestHome(t)
	home := t.TempDir()
	t.Setenv("DSH_HOME", home)
	path := filepath.Join(home, ".credentials.yaml")
	if err := os.WriteFile(path, []byte("version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-key\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	info := provisionFor(t, "dsh")
	if info.Login || info.Auth.Status != "invalid" {
		t.Fatalf("DSH rejects a credential document readable by other users: %+v", info)
	}
}

func TestProvisioningIgnoresEmptyDSHDotEnvCredentials(t *testing.T) {
	provisionTestHome(t)
	home := t.TempDir()
	t.Setenv("DSH_HOME", home)
	if err := os.WriteFile(filepath.Join(home, ".env"), []byte("DEEPSEEK_API_KEY= # configure later\nOPENAI_API_KEY=\"\" # empty\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	info := provisionFor(t, "dsh")
	if info.Login {
		t.Fatalf("dotenv comments and empty quotes are not credentials: %+v", info)
	}
}
