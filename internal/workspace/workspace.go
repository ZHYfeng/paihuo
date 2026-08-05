// Package workspace 提供任务级 git worktree 隔离工作空间：
// 每个任务在项目仓库的独立分支 + 独立目录中执行，互不污染；
// 审批通过后可一键 squash 合并回主分支，或丢弃整个任务分支。
// 非 git 项目回退为直接在项目目录执行（任务标注未隔离）。
package workspace

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"paihuo/internal/store"
)

// Info 是任务工作空间的当前状态。
type Info struct {
	Path       string `json:"path"`        // worktree 或项目目录
	IsGit      bool   `json:"is_git"`      // 项目是 git 仓库
	IsWorktree bool   `json:"is_worktree"` // 任务在独立 worktree 中执行
	Branch     string `json:"branch"`      // 任务分支（paihuo/task-<id>）
	BaseCommit string `json:"base_commit"` // 创建时的主分支 HEAD
	Head       string `json:"head"`        // worktree 当前 HEAD
	Dirty      bool   `json:"dirty"`       // 有未提交改动
	Ahead      int    `json:"ahead"`       // 领先 base 的提交数
	Merged     bool   `json:"merged"`      // 已合并回主分支
	Note       string `json:"note,omitempty"`
}

// gitIdentity 合并/丢弃时使用的提交身份（仅覆盖单条命令，不改用户全局配置）。
var gitIdentity = []string{"-c", "user.name=paihuo", "-c", "user.email=paihuo@local"}

// WorktreePath 返回任务 worktree 的预期路径（sessions/<project>/task-<id>）。
func WorktreePath(sessionsRoot, projectName string, taskID int64) string {
	return filepath.Join(sessionsRoot, slug(projectName), fmt.Sprintf("task-%d", taskID))
}

// Branch 返回任务分支名。
func Branch(taskID int64) string { return fmt.Sprintf("paihuo/task-%d", taskID) }

// Ensure 为任务准备执行目录：
//   - 项目是 git 仓库且 worktree 不存在 → 创建独立 worktree（paihuo/task-<id>）
//   - 已存在 → 直接返回
//   - 非 git 或 git 失败 → 回退项目目录（Note 说明原因）
//
// 返回 (执行目录, 任务分支, baseCommit, error)。非隔离场景 branch 为空串。
func Ensure(tk store.Task, sessionsRoot string) (dir, branch, baseCommit string, err error) {
	project := tk.ProjectDir
	dir = project
	if project == "" {
		return "", "", "", fmt.Errorf("任务未绑定项目目录")
	}
	wt := WorktreePath(sessionsRoot, tk.ProjectName, tk.ID)
	if fi, err := os.Stat(wt); err == nil && fi.IsDir() {
		return wt, Branch(tk.ID), tk.BaseCommit, nil // 已存在（重试/恢复）
	}
	if !isGitRepo(project) {
		return project, "", "", nil // 非 git 项目：直接执行
	}
	if tk.WorktreeBranch != "" && Branch(tk.ID) == tk.WorktreeBranch {
		return wt, tk.WorktreeBranch, tk.BaseCommit, nil // DB 已记录但目录被清：回退项目目录
	}
	base, err := git(project, "rev-parse", "HEAD")
	if err != nil {
		return project, "", "", nil
	}
	baseCommit = strings.TrimSpace(base)
	if err := os.MkdirAll(filepath.Dir(wt), 0o755); err != nil {
		return project, "", "", nil
	}
	if _, err := git(project, "worktree", "add", wt, "-b", Branch(tk.ID)); err != nil {
		return project, "", "", fmt.Errorf("创建 worktree 失败: %v", err)
	}
	return wt, Branch(tk.ID), baseCommit, nil
}

// Status 返回任务工作空间状态。
func Status(tk store.Task, sessionsRoot string) Info {
	info := Info{Path: tk.ProjectDir, Note: ""}
	if !isGitRepo(tk.ProjectDir) {
		info.Note = "项目不是 git 仓库，任务直接在项目目录执行"
		return info
	}
	info.IsGit = true
	wt := WorktreePath(sessionsRoot, tk.ProjectName, tk.ID)
	if fi, err := os.Stat(wt); err != nil || !fi.IsDir() {
		info.Path = tk.ProjectDir
		info.Branch = tk.WorktreeBranch
		info.BaseCommit = tk.BaseCommit
		info.Note = "worktree 已清理或不存在"
		return info
	}
	info.Path = wt
	info.IsWorktree = true
	info.Branch = Branch(tk.ID)
	info.BaseCommit = tk.BaseCommit
	if h, err := git(wt, "rev-parse", "--short", "HEAD"); err == nil {
		info.Head = strings.TrimSpace(h)
	}
	if d, err := git(wt, "status", "--porcelain"); err == nil && strings.TrimSpace(d) != "" {
		info.Dirty = true
	}
	if info.BaseCommit != "" {
		if n, err := git(wt, "rev-list", "--count", info.BaseCommit+"..HEAD"); err == nil {
			fmt.Sscanf(strings.TrimSpace(n), "%d", &info.Ahead)
		}
	}
	return info
}

// Merge 把任务分支 squash 合并回主分支：
//  1. worktree 内提交全部改动（未提交部分也并入）
//  2. 主仓库 git merge --squash <branch> 并提交
//  3. 返回主分支新 commit 的短 hash
//
// 冲突时中止合并并返回包含冲突文件列表的错误。
func Merge(tk store.Task, sessionsRoot string) (string, error) {
	wt := WorktreePath(sessionsRoot, tk.ProjectName, tk.ID)
	if fi, err := os.Stat(wt); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("worktree 不存在，无法合并")
	}
	if !isGitRepo(tk.ProjectDir) {
		return "", fmt.Errorf("项目不是 git 仓库")
	}
	msg := fmt.Sprintf("paihuo: task #%d %s", tk.ID, firstLine(tk.Title))
	// 1. 提交 worktree 内全部改动（无改动时 git commit 会失败，忽略）
	git(wt, "add", "-A")
	if _, err := git(wt, append(gitIdentity, "commit", "-m", msg)...); err != nil && !strings.Contains(err.Error(), "nothing to commit") {
		// 无身份/其他错误：忽略（merge --squash 拉的是分支提交，这里只是保险）
	}
	// 2. squash 合并
	if _, err := git(tk.ProjectDir, "merge", "--squash", Branch(tk.ID)); err != nil {
		conflicts := mergeConflicts(tk.ProjectDir)
		git(tk.ProjectDir, "merge", "--abort")
		git(tk.ProjectDir, "reset", "--hard", "HEAD")
		if len(conflicts) > 0 {
			return "", fmt.Errorf("合并冲突，已中止：%s", strings.Join(conflicts, "、"))
		}
		return "", fmt.Errorf("合并失败: %v", err)
	}
	// 3. 提交
	if out, err := git(tk.ProjectDir, append(gitIdentity, "commit", "-m", msg)...); err != nil {
		// 无任何可合并改动（空任务）→ 清理 index
		git(tk.ProjectDir, "reset", "--hard", "HEAD")
		return "", fmt.Errorf("提交失败（可能无改动）: %v", err)
	} else {
		return strings.TrimSpace(out), nil
	}
}

// Discard 丢弃任务分支：删除 worktree 与分支。已合并的分支一并清理。
func Discard(tk store.Task, sessionsRoot string) error {
	wt := WorktreePath(sessionsRoot, tk.ProjectName, tk.ID)
	if fi, err := os.Stat(wt); err == nil && fi.IsDir() {
		git(tk.ProjectDir, "worktree", "remove", "--force", wt)
	}
	if isGitRepo(tk.ProjectDir) {
		git(tk.ProjectDir, "branch", "-D", Branch(tk.ID))
	}
	return nil
}

// Cleanup 清理终态任务的过期 worktree（按保留天数）。
func Cleanup(sessionsRoot string, retentionDays int, tasks []store.Task) (removed int) {
	if retentionDays <= 0 || sessionsRoot == "" {
		return 0
	}
	cutoff := time.Now().AddDate(0, 0, -retentionDays)
	for _, tk := range tasks {
		if !isTerminal(tk.Status) || tk.FinishedAt == nil {
			continue
		}
		fin, err := time.Parse(time.RFC3339, *tk.FinishedAt)
		if err != nil || fin.After(cutoff) {
			continue
		}
		wt := WorktreePath(sessionsRoot, tk.ProjectName, tk.ID)
		if fi, err := os.Stat(wt); err == nil && fi.IsDir() {
			if isGitRepo(tk.ProjectDir) {
				git(tk.ProjectDir, "worktree", "remove", "--force", wt)
				git(tk.ProjectDir, "branch", "-D", Branch(tk.ID))
			} else {
				os.RemoveAll(wt)
			}
			removed++
		}
	}
	return removed
}

// GitInit 在项目目录初始化 git 仓库（非 git 项目可选开启隔离）。
func GitInit(path string) error {
	_, err := git(path, "init")
	return err
}

// ---------------------------------------------------------------------------
// 内部工具

var slugRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func slug(s string) string {
	s = slugRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		return "project"
	}
	return s
}

func isTerminal(status string) bool {
	switch status {
	case store.StatusSucceeded, store.StatusFailed, store.StatusCancelled:
		return true
	}
	return false
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}

// git 执行 git 命令并返回 stdout。
func git(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func isGitRepo(dir string) bool { return IsGitRepo(dir) }

// IsGitRepo 判断目录是否在 git 仓库内（供外部使用）。
func IsGitRepo(dir string) bool {
	out, err := git(dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(out) == "true"
}

func mergeConflicts(dir string) []string {
	out, err := git(dir, "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		return nil
	}
	var res []string
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		if l != "" {
			res = append(res, l)
		}
	}
	return res
}
