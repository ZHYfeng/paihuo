package store

import (
	"database/sql"
	"fmt"
)

func migrateWorkflowRunsProjectColumn(db *sql.DB) error {
	var has int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('workflow_runs') WHERE name='project_id'`).Scan(&has); err != nil {
		return fmt.Errorf("检查 workflow_runs 结构失败: %w", err)
	}
	if has > 0 {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE workflow_runs ADD COLUMN project_id INTEGER REFERENCES projects(id)`); err != nil {
		return fmt.Errorf("迁移 workflow_runs.project_id 失败: %w", err)
	}
	if _, err := db.Exec(`UPDATE workflow_runs SET project_id = COALESCE(
		(SELECT project_id FROM tasks WHERE workflow_run_id = workflow_runs.id AND project_id IS NOT NULL LIMIT 1), 0)`); err != nil {
		return fmt.Errorf("回填 workflow_runs.project_id 失败: %w", err)
	}
	return nil
}

// migrateWorkflowRunsTaskColumn 为存量库补 workflow_runs.task 列（幂等）：
// 新库由 schema 直接建出该列；旧库 ALTER ADD COLUMN，存量 Run 默认为空
// （无自定义任务，纯模板执行）。
func migrateWorkflowRunsTaskColumn(db *sql.DB) error {
	var has int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('workflow_runs') WHERE name='task'`).Scan(&has); err != nil {
		return fmt.Errorf("检查 workflow_runs 结构失败: %w", err)
	}
	if has > 0 {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE workflow_runs ADD COLUMN task TEXT NOT NULL DEFAULT ''`); err != nil {
		return fmt.Errorf("迁移 workflow_runs.task 失败: %w", err)
	}
	return nil
}

// migrateSkillsCategoryColumn 为存量库补 skills.category 列（幂等）：新库由
// schema 直接建出；旧库 ALTER ADD COLUMN，存量技能默认为未分类。
func migrateSkillsCategoryColumn(db *sql.DB) error {
	var has int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('skills') WHERE name='category'`).Scan(&has); err != nil {
		return fmt.Errorf("检查 skills 结构失败: %w", err)
	}
	if has > 0 {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE skills ADD COLUMN category TEXT NOT NULL DEFAULT ''`); err != nil {
		return fmt.Errorf("迁移 skills.category 失败: %w", err)
	}
	return nil
}

func migrateProjectGitHubColumns(db *sql.DB) error {
	checks := []struct {
		name string
		ddl  string
	}{
		{"github_repo", "ALTER TABLE projects ADD COLUMN github_repo TEXT NOT NULL DEFAULT ''"},
		{"github_role_id", "ALTER TABLE projects ADD COLUMN github_role_id INTEGER REFERENCES roles(id)"},
		{"github_auto_issues", "ALTER TABLE projects ADD COLUMN github_auto_issues INTEGER NOT NULL DEFAULT 0"},
		{"github_auto_prs", "ALTER TABLE projects ADD COLUMN github_auto_prs INTEGER NOT NULL DEFAULT 0"},
		{"github_auto_security", "ALTER TABLE projects ADD COLUMN github_auto_security INTEGER NOT NULL DEFAULT 0"},
	}
	for _, col := range checks {
		var has int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name=?`, col.name).Scan(&has); err != nil {
			return fmt.Errorf("检查 projects.%s 失败: %w", col.name, err)
		}
		if has > 0 {
			continue
		}
		if _, err := db.Exec(col.ddl); err != nil {
			return fmt.Errorf("迁移 projects.%s 失败: %w", col.name, err)
		}
	}
	return nil
}

func migrateTaskExternalKeyColumn(db *sql.DB) error {
	var has int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name='external_key'`).Scan(&has); err != nil {
		return fmt.Errorf("检查 tasks.external_key 失败: %w", err)
	}
	if has > 0 {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE tasks ADD COLUMN external_key TEXT NOT NULL DEFAULT ''`); err != nil {
		return fmt.Errorf("迁移 tasks.external_key 失败: %w", err)
	}
	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_key_unique ON tasks(external_key) WHERE external_key <> ''`); err != nil {
		return fmt.Errorf("创建 tasks.external_key 唯一索引失败: %w", err)
	}
	return nil
}

// migrateTaskParentColumns 为存量库补编排归属列（幂等）：新库由 schema 直接
// 建出；旧库 ALTER ADD COLUMN，存量任务无编排归属（保持 NULL）。
func migrateTaskParentColumns(db *sql.DB) error {
	checks := []struct {
		name string
		ddl  string
	}{
		{"parent_session_id", "ALTER TABLE tasks ADD COLUMN parent_session_id INTEGER REFERENCES tasks(id)"},
		{"parent_task_id", "ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)"},
	}
	for _, col := range checks {
		var has int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name=?`, col.name).Scan(&has); err != nil {
			return fmt.Errorf("检查 tasks.%s 失败: %w", col.name, err)
		}
		if has > 0 {
			continue
		}
		if _, err := db.Exec(col.ddl); err != nil {
			return fmt.Errorf("迁移 tasks.%s 失败: %w", col.name, err)
		}
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent_session ON tasks(parent_session_id)`); err != nil {
		return fmt.Errorf("创建 tasks.parent_session_id 索引失败: %w", err)
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent_task ON tasks(parent_task_id)`); err != nil {
		return fmt.Errorf("创建 tasks.parent_task_id 索引失败: %w", err)
	}
	return nil
}

// migrateRoleDelegationColumns 为存量库补角色委托列（幂等）：新库由 schema
// 直接建出；旧库 ALTER ADD COLUMN，存量角色默认不委托。
func migrateRoleDelegationColumns(db *sql.DB) error {
	checks := []struct {
		name string
		ddl  string
	}{
		{"delegation_enabled", "ALTER TABLE roles ADD COLUMN delegation_enabled INTEGER NOT NULL DEFAULT 0"},
		{"delegation_max_perm", "ALTER TABLE roles ADD COLUMN delegation_max_perm TEXT NOT NULL DEFAULT 'review'"},
	}
	for _, col := range checks {
		var has int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('roles') WHERE name=?`, col.name).Scan(&has); err != nil {
			return fmt.Errorf("检查 roles.%s 失败: %w", col.name, err)
		}
		if has > 0 {
			continue
		}
		if _, err := db.Exec(col.ddl); err != nil {
			return fmt.Errorf("迁移 roles.%s 失败: %w", col.name, err)
		}
	}
	return nil
}

// migrateTaskMergeSkippedColumn 为存量库补 merge_skipped 列（幂等）：新库由
// schema 直接建出；旧库 ALTER ADD COLUMN，存量任务默认不标记（0）。
func migrateTaskMergeSkippedColumn(db *sql.DB) error {
	var has int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name='merge_skipped'`).Scan(&has); err != nil {
		return fmt.Errorf("检查 tasks.merge_skipped 失败: %w", err)
	}
	if has > 0 {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE tasks ADD COLUMN merge_skipped INTEGER NOT NULL DEFAULT 0`); err != nil {
		return fmt.Errorf("迁移 tasks.merge_skipped 失败: %w", err)
	}
	return nil
}

func verifyCurrentSchema(db *sql.DB) error {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 1 {
		return fmt.Errorf("数据库不是当前 schema；本版本不包含历史迁移，请使用全新数据库")
	}
	for _, query := range []string{
		"SELECT revision, runtime_id FROM roles LIMIT 0",
		"SELECT revision, project_dir, github_repo, github_role_id, github_auto_issues, github_auto_prs, github_auto_security FROM projects LIMIT 0",
		"SELECT revision, type, cron, enabled, role_id, project_id, terminal_cols, terminal_rows, session_id, workflow_run_id, spec, spec_hash, external_key, parent_session_id, parent_task_id, merge_skipped FROM tasks LIMIT 0",
		"SELECT task_id, depends_on, on_failure FROM task_dependencies LIMIT 0",
		"SELECT role_id FROM templates LIMIT 0",
		"SELECT seq, event_type, role_id, payload FROM event_log LIMIT 0",
		"SELECT revision, workflow_id, project_id, task, task_ids FROM workflow_runs LIMIT 0",
		"SELECT name, description, category, tags, dir, source_path FROM skills LIMIT 0",
		"SELECT key, method, path, status_code FROM idempotency_records LIMIT 0",
		"SELECT task_id, run_id, content_hash, locator FROM artifacts LIMIT 0",
	} {
		if _, err := db.Exec(query); err != nil {
			return fmt.Errorf("数据库不是当前 schema；本版本不包含历史迁移，请使用全新数据库: %w", err)
		}
	}
	return nil
}
