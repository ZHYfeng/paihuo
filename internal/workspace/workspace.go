// Package workspace 提供任务级 git worktree 隔离工作空间：
// 每个任务在项目仓库的独立分支 + 独立目录中执行，互不污染；
// 专属代码合并任务完成后可 squash 合并回主分支，也可丢弃整个任务分支。
// 非 git 项目回退为直接在项目目录执行（任务标注未隔离）。
package workspace

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
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

// mutationMu 串行化共享仓库上的 commit/merge 操作。任务可并行执行，但 Git
// index 与主工作区不能被两个完成中的任务同时改写。
var mutationMu sync.Mutex

type IntegrationResult struct {
	Conflicts []string
	Skipped   bool
}

// WorktreePath 返回任务 worktree 的预期路径（sessions/<project>/task-<id>）。
func WorktreePath(sessionsRoot, projectName string, taskID int64) string {
	return filepath.Join(sessionsRoot, slug(projectName), fmt.Sprintf("task-%d", taskID))
}

// SessionWorktreePath 返回会话 worktree 的预期路径（sessions/<project>/session-<id>）。
// 无项目（projectName 为空）时返回 sessionsRoot/session-<id>：一级独立目录，
// 不与任何项目目录冲突（项目目录均为 sessionsRoot/<slug>/ 两级结构）。
func SessionWorktreePath(sessionsRoot, projectName string, sessionID int64) string {
	if projectName == "" {
		return filepath.Join(sessionsRoot, fmt.Sprintf("session-%d", sessionID))
	}
	return filepath.Join(sessionsRoot, slug(projectName), fmt.Sprintf("session-%d", sessionID))
}

// Branch 返回任务分支名。
func Branch(taskID int64) string { return fmt.Sprintf("paihuo/task-%d", taskID) }

// SessionBranch 返回会话分支名。
func SessionBranch(sessionID int64) string { return fmt.Sprintf("paihuo/session-%d", sessionID) }

// EnsureSessionWorktree 为会话准备隔离工作区：git 项目创建独立 worktree
// （paihuo/session-<id>），已存在直接返回；非 git 项目把项目目录复制到
// sessions/<project>/session-<id>（跳过 .git / node_modules 等重目录），
// 保证会话永远在专门、干净、隔离的目录里工作，绝不在项目原目录上直接干活。
// 返回 (执行目录, 会话分支, baseCommit, error)。非隔离场景 branch 为空串。
func EnsureSessionWorktree(projectDir, sessionsRoot, projectName string, sessionID int64) (dir, branch, baseCommit string, err error) {
	dir = projectDir
	if projectDir == "" {
		// 无项目会话：独立空目录（sessions/session-<id>）。
		wt := SessionWorktreePath(sessionsRoot, projectName, sessionID)
		if err := os.MkdirAll(wt, 0o755); err != nil {
			return "", "", "", fmt.Errorf("创建会话目录失败: %v", err)
		}
		return wt, "", "", nil
	}
	wt := SessionWorktreePath(sessionsRoot, projectName, sessionID)
	if fi, err := os.Stat(wt); err == nil && fi.IsDir() {
		return wt, SessionBranch(sessionID), "", nil // 已存在（恢复）
	}
	if !isGitRepo(projectDir) {
		// 非 git 项目：复制到专属会话目录（干净隔离）。
		if err := copyDirExcluding(projectDir, wt); err != nil {
			return "", "", "", fmt.Errorf("复制项目到会话目录失败: %v", err)
		}
		return wt, "", "", nil
	}
	base, err := git(projectDir, "rev-parse", "HEAD")
	if err != nil {
		return "", "", "", fmt.Errorf("读取 Git 基准提交失败: %v", err)
	}
	baseCommit = strings.TrimSpace(base)
	if err := os.MkdirAll(filepath.Dir(wt), 0o755); err != nil {
		return "", "", "", fmt.Errorf("创建 worktree 目录失败: %v", err)
	}
	if _, err := git(projectDir, "worktree", "add", wt, "-b", SessionBranch(sessionID)); err != nil {
		return "", "", "", fmt.Errorf("创建会话 worktree 失败: %v", err)
	}
	return wt, SessionBranch(sessionID), baseCommit, nil
}

// copySkipDirs 复制会话目录时跳过的子目录（重/无用/危险）。
var copySkipDirs = map[string]bool{
	".git": true, "node_modules": true, ".venv": true, "venv": true,
	"__pycache__": true, ".agent-sessions": true, ".cache": true, "dist": true,
}

// copyDirExcluding 递归复制 src 到 dst（跳过 copySkipDirs 中的目录；
// 符号链接按原样重建，避免复制指向项目原目录的链接内容）。
func copyDirExcluding(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(src, path)
		if rerr != nil {
			return rerr
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			if path != src && copySkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return os.MkdirAll(target, 0o755)
		}
		if d.Type()&os.ModeSymlink != 0 {
			link, lerr := os.Readlink(path)
			if lerr != nil {
				return lerr
			}
			_ = os.Remove(target)
			return os.Symlink(link, target)
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// DiscardSessionWorktree 移除会话 worktree（git 项目时）。非 git 或已不存在
// 时静默成功。会话分支保留（历史可查），仅移除工作目录。
func DiscardSessionWorktree(projectDir, sessionsRoot, projectName string, sessionID int64) error {
	wt := SessionWorktreePath(sessionsRoot, projectName, sessionID)
	if !isGitRepo(projectDir) {
		// 非 git 项目：移除复制的会话目录。
		return os.RemoveAll(wt)
	}
	if _, err := os.Stat(wt); err != nil {
		return nil // 已不存在
	}
	if _, err := git(projectDir, "worktree", "remove", "--force", wt); err != nil {
		return fmt.Errorf("移除会话 worktree 失败: %v", err)
	}
	return nil
}

// Ensure 为任务准备执行目录：
//   - 项目是 git 仓库且 worktree 不存在 → 创建独立 worktree（paihuo/task-<id>）
//   - 已存在 → 直接返回
//   - 非 git → 回退项目目录
//   - git 仓库无法建立隔离工作区 → 返回错误（绝不在主工作区执行）
//
// 会话交付的任务（Task.SessionID 非空）复用会话 worktree（paihuo/session-<id>）：
// 不搬移、不重建，直接挂载使用。
//
// 返回 (执行目录, 任务分支, baseCommit, error)。非隔离场景 branch 为空串。
func Ensure(tk store.Task, sessionsRoot string) (dir, branch, baseCommit string, err error) {
	project := tk.ProjectDir
	dir = project
	if project == "" {
		return "", "", "", fmt.Errorf("任务未绑定项目目录")
	}
	// 会话交付任务：定位到会话 worktree。
	if tk.SessionID != nil {
		wt := SessionWorktreePath(sessionsRoot, tk.ProjectName, *tk.SessionID)
		if fi, err := os.Stat(wt); err == nil && fi.IsDir() {
			return wt, SessionBranch(*tk.SessionID), tk.BaseCommit, nil // 已存在（会话 worktree 仍在）
		}
		// worktree 丢失：按记录分支重新挂载。
		branch := SessionBranch(*tk.SessionID)
		if tk.WorktreeBranch != "" && tk.WorktreeBranch != branch {
			return "", "", "", fmt.Errorf("任务 worktree 分支记录异常: %s", tk.WorktreeBranch)
		}
		if !isGitRepo(project) {
			return project, "", "", nil
		}
		if err := os.MkdirAll(filepath.Dir(wt), 0o755); err != nil {
			return "", "", "", fmt.Errorf("创建 worktree 目录失败: %v", err)
		}
		if _, err := git(project, "worktree", "add", wt, branch); err != nil {
			return "", "", "", fmt.Errorf("恢复会话 worktree 失败: %v", err)
		}
		return wt, branch, tk.BaseCommit, nil
	}
	wt := WorktreePath(sessionsRoot, tk.ProjectName, tk.ID)
	if fi, err := os.Stat(wt); err == nil && fi.IsDir() {
		return wt, Branch(tk.ID), tk.BaseCommit, nil // 已存在（重试/恢复）
	}
	if !isGitRepo(project) {
		return project, "", "", nil // 非 git 项目：直接执行
	}
	if tk.WorktreeBranch != "" {
		if tk.WorktreeBranch != Branch(tk.ID) {
			return "", "", "", fmt.Errorf("任务 worktree 分支记录异常: %s", tk.WorktreeBranch)
		}
		// 重试或清理后恢复时，重新挂载原任务分支，而不是退回主工作区。
		if err := os.MkdirAll(filepath.Dir(wt), 0o755); err != nil {
			return "", "", "", fmt.Errorf("创建 worktree 目录失败: %v", err)
		}
		if _, err := git(project, "worktree", "add", wt, tk.WorktreeBranch); err != nil {
			return "", "", "", fmt.Errorf("恢复 worktree 失败: %v", err)
		}
		return wt, tk.WorktreeBranch, tk.BaseCommit, nil
	}
	base, err := git(project, "rev-parse", "HEAD")
	if err != nil {
		return "", "", "", fmt.Errorf("读取 Git 基准提交失败: %v", err)
	}
	baseCommit = strings.TrimSpace(base)
	if err := os.MkdirAll(filepath.Dir(wt), 0o755); err != nil {
		return "", "", "", fmt.Errorf("创建 worktree 目录失败: %v", err)
	}
	if _, err := git(project, "worktree", "add", wt, "-b", Branch(tk.ID)); err != nil {
		return "", "", "", fmt.Errorf("创建 worktree 失败: %v", err)
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

// Snapshot 把任务 worktree 的全部已审批改动固化到任务分支，供后续合并任务
// 稳定读取。无改动时只返回当前 HEAD。
func Snapshot(tk store.Task, sessionsRoot string) (string, error) {
	mutationMu.Lock()
	defer mutationMu.Unlock()
	return snapshotLocked(tk, sessionsRoot)
}

func snapshotLocked(tk store.Task, sessionsRoot string) (string, error) {
	wt := WorktreePath(sessionsRoot, tk.ProjectName, tk.ID)
	if fi, err := os.Stat(wt); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("worktree 不存在，无法保存任务改动")
	}
	status, err := git(wt, "status", "--porcelain")
	if err != nil {
		return "", fmt.Errorf("读取任务改动失败: %v", err)
	}
	if strings.TrimSpace(status) != "" {
		if _, err := git(wt, "add", "-A"); err != nil {
			return "", fmt.Errorf("暂存任务改动失败: %v", err)
		}
		msg := fmt.Sprintf("paihuo: task #%d %s", tk.ID, firstLine(tk.Title))
		if _, err := git(wt, append(gitIdentity, "commit", "-m", msg)...); err != nil {
			return "", fmt.Errorf("提交任务改动失败: %v", err)
		}
	}
	head, err := git(wt, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "", fmt.Errorf("读取任务提交失败: %v", err)
	}
	return strings.TrimSpace(head), nil
}

// Integrate 把源任务分支 squash 到自动创建的合并任务 worktree。冲突会
// 保留在隔离 worktree 中交给 agent 处理，不会触碰主工作区。
func Integrate(source, target store.Task, sessionsRoot string) (IntegrationResult, error) {
	mutationMu.Lock()
	defer mutationMu.Unlock()
	if source.WorktreeBranch == "" || target.WorktreeBranch == "" {
		return IntegrationResult{Skipped: true}, nil
	}
	if filepath.Clean(source.ProjectDir) != filepath.Clean(target.ProjectDir) {
		return IntegrationResult{}, fmt.Errorf("源任务与合并任务不属于同一项目")
	}
	if _, err := snapshotLocked(source, sessionsRoot); err != nil {
		return IntegrationResult{}, err
	}
	targetDir := WorktreePath(sessionsRoot, target.ProjectName, target.ID)
	if fi, err := os.Stat(targetDir); err != nil || !fi.IsDir() {
		return IntegrationResult{}, fmt.Errorf("合并任务 worktree 不存在")
	}
	// 重试时保留 agent 上一轮已经整合或修复的内容，不重复套用源分支。
	if status, err := git(targetDir, "status", "--porcelain"); err != nil {
		return IntegrationResult{}, fmt.Errorf("读取合并任务状态失败: %v", err)
	} else if strings.TrimSpace(status) != "" {
		return IntegrationResult{Skipped: true}, nil
	}
	if target.BaseCommit != "" {
		head, err := git(targetDir, "rev-parse", "HEAD")
		if err != nil {
			return IntegrationResult{}, fmt.Errorf("读取合并任务 HEAD 失败: %v", err)
		}
		if strings.TrimSpace(head) != target.BaseCommit {
			return IntegrationResult{Skipped: true}, nil
		}
	}
	if _, err := git(targetDir, "merge", "--squash", source.WorktreeBranch); err != nil {
		conflicts := mergeConflicts(targetDir)
		if len(conflicts) > 0 {
			return IntegrationResult{Conflicts: conflicts}, nil
		}
		git(targetDir, "reset", "--hard", "HEAD")
		return IntegrationResult{}, fmt.Errorf("导入源任务分支失败: %v", err)
	}
	return IntegrationResult{}, nil
}

// Merge 把任务分支 squash 合并回主分支：
//  1. worktree 内提交全部改动（未提交部分也并入）
//  2. 主仓库 git merge --squash <branch> 并提交
//  3. 返回主分支新 commit 的短 hash
//
// 冲突时中止合并并返回包含冲突文件列表的错误。
func Merge(tk store.Task, sessionsRoot string) (string, error) {
	mutationMu.Lock()
	defer mutationMu.Unlock()
	wt := WorktreePath(sessionsRoot, tk.ProjectName, tk.ID)
	if fi, err := os.Stat(wt); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("worktree 不存在，无法合并")
	}
	if !isGitRepo(tk.ProjectDir) {
		return "", fmt.Errorf("项目不是 git 仓库")
	}
	// 代码合并任务绝不能覆盖用户或其他任务留在主工作区的未提交内容。
	if status, err := git(tk.ProjectDir, "status", "--porcelain"); err != nil {
		return "", fmt.Errorf("读取主工作区状态失败: %v", err)
	} else if strings.TrimSpace(status) != "" {
		return "", fmt.Errorf("主工作区存在未提交改动，无法合并")
	}
	if _, err := snapshotLocked(tk, sessionsRoot); err != nil {
		return "", err
	}
	differs, err := treesDiffer(tk.ProjectDir, "HEAD", Branch(tk.ID))
	if err != nil {
		return "", fmt.Errorf("比较任务分支失败: %v", err)
	}
	if !differs {
		return "", nil
	}
	msg := fmt.Sprintf("paihuo: task #%d %s", tk.ID, firstLine(tk.Title))
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
	if _, err := git(tk.ProjectDir, append(gitIdentity, "commit", "-m", msg)...); err != nil {
		git(tk.ProjectDir, "reset", "--hard", "HEAD")
		return "", fmt.Errorf("提交代码合并结果失败: %v", err)
	}
	head, err := git(tk.ProjectDir, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "", fmt.Errorf("读取代码合并提交失败: %v", err)
	}
	return strings.TrimSpace(head), nil
}

// Discard 丢弃任务分支：删除 worktree 与分支。已合并的分支一并清理。
func Discard(tk store.Task, sessionsRoot string) error {
	mutationMu.Lock()
	defer mutationMu.Unlock()

	wt := WorktreePath(sessionsRoot, tk.ProjectName, tk.ID)
	if fi, err := os.Stat(wt); err == nil && fi.IsDir() {
		if !isGitRepo(tk.ProjectDir) {
			return fmt.Errorf("任务 worktree 存在，但项目不是 git 仓库")
		}
		if _, err := git(tk.ProjectDir, "worktree", "remove", "--force", wt); err != nil {
			return fmt.Errorf("删除 worktree 失败: %v", err)
		}
	}
	if !isGitRepo(tk.ProjectDir) {
		return nil
	}
	branches, err := git(tk.ProjectDir, "branch", "--list", Branch(tk.ID))
	if err != nil {
		return fmt.Errorf("读取任务分支失败: %v", err)
	}
	if strings.TrimSpace(branches) != "" {
		if _, err := git(tk.ProjectDir, "branch", "-D", Branch(tk.ID)); err != nil {
			return fmt.Errorf("删除任务分支失败: %v", err)
		}
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

func treesDiffer(dir, left, right string) (bool, error) {
	cmd := exec.Command("git", "diff", "--quiet", left, right, "--")
	cmd.Dir = dir
	err := cmd.Run()
	if err == nil {
		return false, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return true, nil
	}
	return false, err
}
