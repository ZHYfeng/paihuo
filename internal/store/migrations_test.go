package store

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// 旧版 schema（workflow_runs 无 project_id/task 列）必须被幂等迁移：
// 补 project_id 并用节点任务的 project_id 回填存量 Run；补 task（默认空 =
// 无自定义任务）。
func TestMigrateWorkflowRunsProjectColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	legacy := strings.Replace(schema,
		`CREATE TABLE IF NOT EXISTS workflow_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES tasks(id), -- adopted 的工作流定义（type=workflow）
  project_id  INTEGER NOT NULL REFERENCES projects(id), -- 本次 Run 绑定的具体项目
  task        TEXT NOT NULL DEFAULT '', -- 本次 Run 的自定义任务（{{.task}} 渲染进节点意图；留空 = 纯模板执行）
  status      TEXT NOT NULL DEFAULT 'created',
  task_ids    TEXT NOT NULL DEFAULT '{}',
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  updated_at  TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS workflow_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES tasks(id),
  status      TEXT NOT NULL DEFAULT 'created',
  task_ids    TEXT NOT NULL DEFAULT '{}',
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  updated_at  TEXT NOT NULL
);`, 1)
	legacy = strings.Replace(legacy, "CREATE INDEX IF NOT EXISTS idx_workflow_runs_project ON workflow_runs(project_id);\n", "", 1)
	legacy = strings.Replace(legacy, "PRAGMA user_version=9;", "PRAGMA user_version=1;", 1)
	if _, err := db.Exec(legacy); err != nil {
		t.Fatal(err)
	}
	now := Now()
	if _, err := db.Exec(`INSERT INTO projects (name, description, status, project_dir, revision, created_at, updated_at)
		VALUES ('legacy', '', 'active', '/tmp/legacy', 1, ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO tasks (type, title, body, status, perm, run_mode, concurrent, dependency_mode, block_on_failure, spec, revision, created_at, updated_at)
		VALUES ('workflow', 'legacy-wf', 'legacy-wf', 'adopted', 'full', 'batch', 0, 'none', 0, '{}', 1, ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO workflow_runs (workflow_id, status, task_ids, revision, created_at, updated_at)
		VALUES (1, 'running', '{"a":2}', 1, ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO tasks (type, title, body, status, project_id, workflow_run_id, spec, revision, created_at, updated_at)
		VALUES ('task', 'node', 'node', 'queued', 1, 1, '', 1, ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	run, err := s.GetWorkflowRun(1)
	if err != nil {
		t.Fatal(err)
	}
	if run.ProjectID != 1 {
		t.Fatalf("migrated run must backfill project from node task: %+v", run)
	}
	if run.Task != "" {
		t.Fatalf("migrated run must have empty custom task: %+v", run)
	}
	// 幂等：再次打开不应报错。
	if _, err := Open(path); err != nil {
		t.Fatalf("reopen after migration must succeed: %v", err)
	}
}

// 旧版 schema（skills 无 category 列）必须被幂等迁移：补列后存量技能
// 默认为未分类，且不丢数据。
func TestMigrateSkillsCategoryColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	legacy := strings.Replace(schema,
		`CREATE TABLE IF NOT EXISTS skills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '', -- 分类（文件夹）：导入时从源目录父文件夹推断，可批量调整
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON array of labels
  dir         TEXT NOT NULL UNIQUE,      -- 复制到 paihuo 工作目录后的技能目录（绝对路径）
  source_path TEXT NOT NULL DEFAULT '',  -- 添加时的来源路径
  created_at  TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS skills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  dir         TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);`, 1)
	legacy = strings.Replace(legacy, "PRAGMA user_version=9;", "PRAGMA user_version=3;", 1)
	if _, err := db.Exec(legacy); err != nil {
		t.Fatal(err)
	}
	now := Now()
	if _, err := db.Exec(`INSERT INTO skills (name, description, tags, dir, source_path, created_at)
		VALUES ('legacy-skill', 'legacy', '["a"]', '/tmp/legacy-skill', '/src/legacy-skill', ?)`, now); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	sk, err := s.GetSkill(1)
	if err != nil {
		t.Fatalf("迁移后读取技能失败: %v", err)
	}
	if sk.Name != "legacy-skill" || sk.Category != "" || len(sk.Tags) != 1 || sk.Tags[0] != "a" {
		t.Fatalf("迁移后技能数据错误: %+v", sk)
	}
	// 幂等：再次打开不应报错。
	if _, err := Open(path); err != nil {
		t.Fatalf("reopen after migration must succeed: %v", err)
	}
}
