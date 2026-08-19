package store

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// 存量库（旧 schema，无编排列）打开时自动幂等补列：tasks.parent_session_id /
// parent_task_id、roles.delegation_* 存在且可读。
func TestOpenMigratesDelegationColumns(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "old.db")

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	// 旧 schema 最小子集（当时的 tasks/roles 必须覆盖新代码的列查询）。
	_, err = db.Exec(`
CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', runtime_id TEXT NOT NULL,
  role_config TEXT NOT NULL DEFAULT '{}', max_concurrency INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', project_dir TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'task', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', perm TEXT NOT NULL DEFAULT 'full', run_mode TEXT NOT NULL DEFAULT 'batch',
  concurrent INTEGER NOT NULL DEFAULT 0, role_id INTEGER, project_id INTEGER, project_dir TEXT NOT NULL DEFAULT '',
  parent_id INTEGER, depends_on INTEGER, dependency_mode TEXT NOT NULL DEFAULT 'none',
  block_on_failure INTEGER NOT NULL DEFAULT 0, schedule_id INTEGER, error TEXT NOT NULL DEFAULT '',
  exit_code INTEGER, review_note TEXT NOT NULL DEFAULT '', review_rounds INTEGER NOT NULL DEFAULT 0,
  tmux_log_offset INTEGER NOT NULL DEFAULT 0, worktree_branch TEXT NOT NULL DEFAULT '', base_commit TEXT NOT NULL DEFAULT '',
  resume_of INTEGER, merge_of INTEGER, sort_order INTEGER NOT NULL DEFAULT 0,
  terminal_cols INTEGER NOT NULL DEFAULT 0, terminal_rows INTEGER NOT NULL DEFAULT 0,
  session_id INTEGER, workflow_run_id INTEGER, cron TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, next_run_at TEXT,
  worktree_path TEXT NOT NULL DEFAULT '', session_dir TEXT NOT NULL DEFAULT '',
  last_message_at TEXT NOT NULL DEFAULT '', message_count INTEGER NOT NULL DEFAULT 0,
  suspended_at TEXT, delivered_at TEXT, spec TEXT NOT NULL DEFAULT '', violations TEXT NOT NULL DEFAULT '[]',
  spec_hash TEXT NOT NULL DEFAULT '', external_key TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL);
CREATE TABLE task_dependencies (task_id INTEGER NOT NULL, depends_on INTEGER NOT NULL, on_failure TEXT NOT NULL DEFAULT 'block', PRIMARY KEY(task_id, depends_on));
CREATE TABLE task_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, seq INTEGER NOT NULL, stream TEXT NOT NULL DEFAULT 'out', content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workflow_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER NOT NULL, project_id INTEGER NOT NULL, task TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'created', task_ids TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', role_id INTEGER, created_at TEXT NOT NULL);
CREATE TABLE skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', dir TEXT NOT NULL UNIQUE, source_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE event_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, task_id INTEGER, role_id INTEGER, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE idempotency_records (key TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status_code INTEGER NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(key, method, path));
CREATE TABLE artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, run_id INTEGER, name TEXT NOT NULL, media_type TEXT NOT NULL, content_hash TEXT NOT NULL, size INTEGER NOT NULL, locator TEXT NOT NULL, created_by TEXT NOT NULL, retention TEXT NOT NULL DEFAULT 'default', created_at TEXT NOT NULL, CHECK ((task_id IS NOT NULL) <> (run_id IS NOT NULL)));
PRAGMA user_version=1;
`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	st, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open 存量库应自动补列，而不是拒绝: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	roleID, err := st.CreateRole(Role{Name: "orch", RuntimeID: "pi", Enabled: true, DelegationEnabled: true, DelegationMaxPerm: PermFull})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := st.GetRole(roleID); !got.DelegationEnabled || got.DelegationMaxPerm != PermFull {
		t.Fatalf("迁移后委托列应可写: %+v", got)
	}
}
