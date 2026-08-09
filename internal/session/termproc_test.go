package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestEnsureCodexTrust 验证 codex 信任目录预写：追加新目录、幂等、
// 已存在跳过、缺失配置不干预。
func TestEnsureCodexTrust(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cfg := filepath.Join(home, ".codex", "config.toml")
	dir := filepath.Join(home, "work", "session-1")

	// 无配置：静默不干预（不创建文件）。
	ensureCodexTrust(dir)
	if _, err := os.Stat(cfg); err == nil {
		t.Fatal("无配置时不应创建文件")
	}

	// 写入配置后再预信任。
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatal(err)
	}
	base := "model = \"gpt-5.6-sol\"\n"
	if err := os.WriteFile(cfg, []byte(base), 0o644); err != nil {
		t.Fatal(err)
	}
	ensureCodexTrust(dir)
	data, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	want := "[projects." + `"` + dir + `"` + "]\ntrust_level = \"trusted\""
	if !strings.Contains(string(data), want) {
		t.Fatalf("未写入信任条目:\n%s", data)
	}

	// 幂等：再次调用不重复追加。
	before := len(data)
	ensureCodexTrust(dir)
	after, _ := os.ReadFile(cfg)
	if len(after) != before {
		t.Fatalf("重复追加:\n%s", after)
	}

	// 已有条目（codex 自己写入的）跳过。
	existing := "model = \"x\"\n[projects." + `"` + dir + `"` + "]\ntrust_level = \"trusted\"\n"
	if err := os.WriteFile(cfg, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}
	ensureCodexTrust(dir)
	data, _ = os.ReadFile(cfg)
	if strings.Count(string(data), "[projects."+`"`+dir+`"`+"]") != 1 {
		t.Fatalf("已信任目录被重复写入:\n%s", data)
	}
}
