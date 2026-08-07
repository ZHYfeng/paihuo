package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"paihuo/internal/store"
)

// gitInitTest 创建临时 git 仓库。
func gitInitTest(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "t@test"},
		{"config", "user.name", "test"},
	} {
		if _, err := git(dir, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello\n"), 0o644)
	if _, err := git(dir, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, err := git(dir, "commit", "-qm", "init"); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestEnsureMergeDiscard(t *testing.T) {
	proj := gitInitTest(t)
	sess := t.TempDir()
	tk := store.Task{ID: 7, ProjectDir: proj, ProjectName: "proj", Title: "add feature"}

	dir, branch, base, err := Ensure(tk, sess)
	if err != nil {
		t.Fatal(err)
	}
	if branch != "paihuo/task-7" {
		t.Fatalf("branch = %q", branch)
	}
	if base == "" {
		t.Fatal("base commit 为空")
	}
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); err != nil {
		t.Fatalf("worktree 缺文件: %v", err)
	}
	if !isGitRepo(dir) {
		t.Fatal("worktree 不是 git 仓库")
	}

	// 模拟 agent 产出：新文件 + 未提交改动
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("new\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello world\n"), 0o644)

	st := Status(tk, sess)
	if !st.IsWorktree || !st.Dirty {
		t.Fatalf("status = %+v", st)
	}

	// 合并
	if _, err := Merge(tk, sess); err != nil {
		t.Fatalf("merge: %v", err)
	}
	if _, err := os.Stat(filepath.Join(proj, "b.txt")); err != nil {
		t.Fatal("合并后主分支缺 b.txt")
	}
	if out, _ := os.ReadFile(filepath.Join(proj, "a.txt")); string(out) != "hello world\n" {
		t.Fatalf("a.txt 未更新: %q", out)
	}

	// 丢弃
	if err := Discard(tk, sess); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("worktree 未删除")
	}
	if out, err := git(proj, "branch", "--list", "paihuo/task-7"); err != nil || out != "" {
		t.Fatalf("任务分支未删除: %q %v", out, err)
	}
}

func TestNonGitFallback(t *testing.T) {
	proj := t.TempDir() // 非 git 目录
	sess := t.TempDir()
	tk := store.Task{ID: 1, ProjectDir: proj, ProjectName: "nongit"}
	dir, branch, _, err := Ensure(tk, sess)
	if err != nil {
		t.Fatal(err)
	}
	if dir != proj || branch != "" {
		t.Fatalf("非 git 应回退项目目录: dir=%q branch=%q", dir, branch)
	}
}

func TestEnsureRejectsGitProjectWithoutInitialCommit(t *testing.T) {
	proj := t.TempDir()
	if _, err := git(proj, "init", "-q", "-b", "main"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := Ensure(store.Task{ID: 2, ProjectDir: proj, ProjectName: "empty"}, t.TempDir()); err == nil {
		t.Fatal("没有初始提交的 Git 项目不应退回主工作区执行")
	}
}

func TestConflictAborts(t *testing.T) {
	proj := gitInitTest(t)
	sess := t.TempDir()
	tk := store.Task{ID: 8, ProjectDir: proj, ProjectName: "proj", Title: "conflict"}
	dir, _, _, err := Ensure(tk, sess)
	if err != nil {
		t.Fatal(err)
	}
	// worktree 创建后，主分支又提交了对同一文件的修改 → 合并必然冲突
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("branch change\n"), 0o644)
	os.WriteFile(filepath.Join(proj, "a.txt"), []byte("mainline\n"), 0o644)
	if _, err := git(proj, "commit", "-am", "main change"); err != nil {
		t.Fatal(err)
	}
	if _, err := Merge(tk, sess); err == nil {
		t.Fatal("预期合并冲突")
	} else {
		t.Logf("冲突正确报错: %v", err)
	}
	// 冲突后主分支应保持干净（abort 生效）
	if out, _ := git(proj, "status", "--porcelain"); out != "" {
		t.Fatalf("abort 后主分支应干净, got: %q", out)
	}
	Discard(tk, sess)
}

func TestSnapshotIntegrateAndMergeApprovedTask(t *testing.T) {
	proj := gitInitTest(t)
	sess := t.TempDir()
	source := store.Task{ID: 20, ProjectDir: proj, ProjectName: "proj", Title: "reviewed change"}
	sourceDir, sourceBranch, sourceBase, err := Ensure(source, sess)
	if err != nil {
		t.Fatal(err)
	}
	source.WorktreeBranch = sourceBranch
	source.BaseCommit = sourceBase
	if err := os.WriteFile(filepath.Join(sourceDir, "approved.txt"), []byte("approved\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Snapshot(source, sess); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if out, _ := git(sourceDir, "status", "--porcelain"); out != "" {
		t.Fatalf("审批分支快照后应干净，得到 %q", out)
	}

	target := store.Task{ID: 21, ProjectDir: proj, ProjectName: "proj", Title: "merge reviewed change"}
	targetDir, targetBranch, targetBase, err := Ensure(target, sess)
	if err != nil {
		t.Fatal(err)
	}
	target.WorktreeBranch = targetBranch
	target.BaseCommit = targetBase
	result, err := Integrate(source, target, sess)
	if err != nil {
		t.Fatalf("integrate: %v", err)
	}
	if len(result.Conflicts) != 0 || result.Skipped {
		t.Fatalf("无冲突整合结果异常: %+v", result)
	}
	if got, err := os.ReadFile(filepath.Join(targetDir, "approved.txt")); err != nil || string(got) != "approved\n" {
		t.Fatalf("合并任务未获得审批改动: %q err=%v", got, err)
	}
	if _, err := Merge(target, sess); err != nil {
		t.Fatalf("merge target: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(proj, "approved.txt")); err != nil || string(got) != "approved\n" {
		t.Fatalf("主分支未获得审批改动: %q err=%v", got, err)
	}
}

func TestMergeRejectsDirtyMainWithoutDestroyingChanges(t *testing.T) {
	proj := gitInitTest(t)
	sess := t.TempDir()
	tk := store.Task{ID: 22, ProjectDir: proj, ProjectName: "proj", Title: "safe merge"}
	dir, branch, base, err := Ensure(tk, sess)
	if err != nil {
		t.Fatal(err)
	}
	tk.WorktreeBranch = branch
	tk.BaseCommit = base
	if err := os.WriteFile(filepath.Join(dir, "agent.txt"), []byte("agent\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, "local.txt"), []byte("keep me\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Merge(tk, sess); err == nil || !strings.Contains(err.Error(), "未提交改动") {
		t.Fatalf("脏主工作区应拒绝自动合并，得到 %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(proj, "local.txt")); err != nil || string(got) != "keep me\n" {
		t.Fatalf("主工作区本地改动被破坏: %q err=%v", got, err)
	}
	if out, _ := git(proj, "log", "-1", "--pretty=%s"); strings.TrimSpace(out) != "init" {
		t.Fatalf("拒绝合并时不应产生主分支提交，得到 %q", out)
	}
}

func TestCleanup(t *testing.T) {
	proj := gitInitTest(t)
	sess := t.TempDir()
	tk := store.Task{ID: 9, ProjectDir: proj, ProjectName: "proj", Title: "old"}
	if _, _, _, err := Ensure(tk, sess); err != nil {
		t.Fatal(err)
	}
	fin := "2000-01-01T00:00:00Z" // 25 年前
	old := tk
	old.Status = store.StatusSucceeded
	old.FinishedAt = &fin
	n := Cleanup(sess, 7, []store.Task{old})
	if n != 1 {
		t.Fatalf("cleanup removed = %d, want 1", n)
	}
	if _, err := os.Stat(WorktreePath(sess, "proj", 9)); !os.IsNotExist(err) {
		t.Fatal("worktree 未被清理")
	}
	// 分支也应删除
	if out, _ := git(proj, "branch", "--list", "paihuo/task-9"); out != "" {
		t.Fatal("任务分支未被清理")
	}
}
