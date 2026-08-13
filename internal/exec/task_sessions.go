package exec

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// taskSessionStore 管理 agent CLI 的任务会话文件。它的根目录始终位于当前
// paihuo 实例自己的 sessionsRoot 下，不能落在全局 /tmp；否则另一个实例的
// 孤儿清理会误删仍在运行的任务会话。
type taskSessionStore struct {
	root string
}

// newTaskSessionStore 以数据库身份为命名空间。sessionsRoot 通常和数据库
// 同目录，但同一目录可同时存在正式库与 smoke 库，因此不能只按目录隔离。
func newTaskSessionStore(sessionsRoot, instanceID string) *taskSessionStore {
	if absolute, err := filepath.Abs(instanceID); err == nil {
		instanceID = absolute
	}
	sum := sha256.Sum256([]byte(instanceID))
	namespace := hex.EncodeToString(sum[:8])
	return &taskSessionStore{root: filepath.Join(sessionsRoot, ".runtime-sessions", namespace)}
}

func (s *taskSessionStore) dir(taskID int64) string {
	return filepath.Join(s.root, fmt.Sprintf("task-%d", taskID))
}

// Ensure 返回当前实例内任务的会话目录，并保证它存在。
func (s *taskSessionStore) Ensure(taskID int64) (string, error) {
	if taskID <= 0 {
		return "", fmt.Errorf("非法任务会话 ID: %d", taskID)
	}
	dir := s.dir(taskID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建任务会话目录失败: %w", err)
	}
	return dir, nil
}

// Remove 删除当前实例内某任务的会话文件。任务 ID 由数据库产生，正数以外的
// 值不会映射到文件系统路径。
func (s *taskSessionStore) Remove(taskID int64) error {
	if taskID <= 0 {
		return nil
	}
	return os.RemoveAll(s.dir(taskID))
}

// CleanupOrphans 仅扫描本实例的 task-<id> 目录。无法确认归属时宁可保留，
// 绝不因查询错误删除会话。
func (s *taskSessionStore) CleanupOrphans(exists func(int64) (bool, error)) (int, error) {
	entries, err := os.ReadDir(s.root)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("读取任务会话目录失败: %w", err)
	}

	removed := 0
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "task-") {
			continue
		}
		id, err := strconv.ParseInt(strings.TrimPrefix(entry.Name(), "task-"), 10, 64)
		if err != nil || id <= 0 {
			continue
		}
		keep, err := exists(id)
		if err != nil {
			return removed, fmt.Errorf("确认任务会话归属失败: %w", err)
		}
		if keep {
			continue
		}
		if err := os.RemoveAll(filepath.Join(s.root, entry.Name())); err != nil {
			return removed, fmt.Errorf("清理孤儿任务会话失败: %w", err)
		}
		removed++
	}
	return removed, nil
}
