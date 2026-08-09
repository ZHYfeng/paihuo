package exec

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPiExtensionSourcesFromSettings(t *testing.T) {
	agentDir := t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", agentDir)
	settings := `{
  "packages": [
    "npm:pi-web-access",
    {"source":"git:github.com/acme/pi-tools","extensions":["extensions/*.ts"]},
	"./packages/local-ext",
    {"extensions":[]},
    "npm:pi-web-access"
  ],
  "extensions": ["/opt/pi/local.ts", " extensions/local.ts ", "!extensions/disabled.ts", ""]
}`
	if err := os.WriteFile(filepath.Join(agentDir, "settings.json"), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"npm:pi-web-access",
		"git:github.com/acme/pi-tools",
		filepath.Join(agentDir, "packages", "local-ext"),
		"/opt/pi/local.ts",
		filepath.Join(agentDir, "extensions", "local.ts"),
	}
	if got := piExtensionSources(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Pi 扩展候选=%v，期望 %v", got, want)
	}

	fields := Enrich([]Field{{Key: "extensions", Type: "list", Source: "extensions"}})
	if len(fields) != 1 || fields[0].Builtin || !reflect.DeepEqual(fields[0].Suggestions, want) || fields[0].Default == "" {
		t.Fatalf("extensions schema enrich 异常: %+v", fields)
	}
}

func TestPiExtensionSourcesInvalidSettings(t *testing.T) {
	agentDir := t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", agentDir)
	if err := os.WriteFile(filepath.Join(agentDir, "settings.json"), []byte(`{"packages":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := piExtensionSources(); got != nil {
		t.Fatalf("损坏设置应安全降级为空候选，得到 %v", got)
	}
}
