package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	db.SetMaxOpenConns(1)
	fresh, err := databaseIsEmpty(db)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("检查数据库失败: %w", err)
	}
	if fresh {
		if _, err := db.Exec(schema); err != nil {
			db.Close()
			return nil, fmt.Errorf("初始化数据库失败: %w", err)
		}
	} else {
		// 迁移必须在任何 schema 语句执行前完成，且不留半迁移状态。
		if err := migrateWorkflowRunsProjectColumn(db); err != nil {
			db.Close()
			return nil, err
		}
		if err := migrateWorkflowRunsTaskColumn(db); err != nil {
			db.Close()
			return nil, err
		}
		if err := migrateSkillsCategoryColumn(db); err != nil {
			db.Close()
			return nil, err
		}
		if err := migrateProjectGitHubColumns(db); err != nil {
			db.Close()
			return nil, err
		}
		if err := migrateTaskExternalKeyColumn(db); err != nil {
			db.Close()
			return nil, err
		}
		if err := migrateTaskParentColumns(db); err != nil {
			db.Close()
			return nil, err
		}
		if err := migrateRoleDelegationColumns(db); err != nil {
			db.Close()
			return nil, err
		}
		if err := migrateTaskMergeSkippedColumn(db); err != nil {
			db.Close()
			return nil, err
		}
		// Unsupported databases are inspected before any schema statement runs.
		// Rejection must not leave current-version tables or indexes behind.
		if err := verifyCurrentSchema(db); err != nil {
			db.Close()
			return nil, err
		}
		if _, err := db.Exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;"); err != nil {
			db.Close()
			return nil, fmt.Errorf("配置数据库连接失败: %w", err)
		}
	}
	if fresh {
		if err := seedDefaultTemplate(db); err != nil {
			db.Close()
			return nil, fmt.Errorf("初始化默认模板失败: %w", err)
		}
	}
	return &Store{db: db}, nil
}

func databaseIsEmpty(db *sql.DB) (bool, error) {
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master
		WHERE type='table' AND name NOT LIKE 'sqlite_%'`).Scan(&count)
	return count == 0, err
}

// migrateWorkflowRunsProjectColumn 为存量库补 workflow_runs.project_id 列
// （幂等）：新库由 schema 直接建出该列；旧库先加列，再用节点任务的
// project_id 回填存量 Run（旧版 Run 的节点任务都带 spec.ProjectID）。
func (s *Store) Close() error { return s.db.Close() }

func Now() string { return time.Now().UTC().Format(time.RFC3339) }
