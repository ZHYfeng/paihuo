package exec

import (
	"os"
	"path/filepath"
	"testing"
)

// 两个 paihuo 实例可以拥有同号任务；清理 A 的孤儿会话绝不能触及 B。
// 这是 /tmp/paihuo-sessions 共享目录导致 Pi 任务会话被误删的回归场景。
func TestTaskSessionStoreIsolatesInstances(t *testing.T) {
	root := t.TempDir()
	a := newTaskSessionStore(root, "production.db")
	b := newTaskSessionStore(root, "paihuo-smoke.db")

	aDir, err := a.Ensure(3)
	if err != nil {
		t.Fatal(err)
	}
	bDir, err := b.Ensure(3)
	if err != nil {
		t.Fatal(err)
	}
	if aDir == bDir {
		t.Fatalf("不同实例不应共享会话目录: %s", aDir)
	}

	removed, err := a.CleanupOrphans(func(id int64) (bool, error) { return false, nil })
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("应只清理 A 的一个孤儿会话，得到 %d", removed)
	}
	if _, err := os.Stat(aDir); !os.IsNotExist(err) {
		t.Fatalf("A 的孤儿会话应被清理，err=%v", err)
	}
	if _, err := os.Stat(bDir); err != nil {
		t.Fatalf("B 的同号会话不应被 A 清理: %v", err)
	}
}

func TestTaskSessionStoreOnlyCleansTaskDirectories(t *testing.T) {
	s := newTaskSessionStore(t.TempDir(), "production.db")
	if _, err := s.Ensure(7); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(s.root, "notes")
	if err := os.MkdirAll(keep, 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := s.CleanupOrphans(func(id int64) (bool, error) { return false, nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("非任务目录不应被清理: %v", err)
	}
}
