package store

import (
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
)

var businessTables = []string{
	"roles", "projects", "tasks", "task_dependencies", "task_logs", "workflow_runs",
	"settings", "templates", "skills", "event_log", "idempotency_records", "artifacts",
}

func TestTaskShapeMigrationPreservesCompleteAssociatedData(t *testing.T) {
	for _, sourceVersion := range []int{1, 9} {
		sourceVersion := sourceVersion
		t.Run(fmt.Sprintf("v%d_to_v10", sourceVersion), func(t *testing.T) {
			path := t.TempDir() + "/fixture.db"
			before := createAssociatedTaskFixture(t, path, sourceVersion)

			st, err := Open(path)
			if err != nil {
				t.Fatalf("Open fixture: %v", err)
			}
			if got := testSchemaVersion(t, st.db); got != 10 {
				t.Fatalf("schema version = %d, want 10", got)
			}
			after := dumpBusinessTables(t, st.db)
			if !reflect.DeepEqual(after, before.rows) {
				t.Fatalf("business rows changed during migration\nbefore=%#v\nafter=%#v", before.rows, after)
			}
			if got := taskSequence(t, st.db); got != before.taskSequence {
				t.Fatalf("tasks sqlite_sequence = %d, want %d", got, before.taskSequence)
			}
			if got := taskSchemaObjects(t, st.db); !reflect.DeepEqual(got, before.schemaObjects) {
				t.Fatalf("tasks indexes/triggers changed\nbefore=%v\nafter=%v", before.schemaObjects, got)
			}
			if got := foreignKeyDefinitions(t, st.db); !reflect.DeepEqual(got, before.foreignKeys) {
				t.Fatalf("foreign keys changed\nbefore=%v\nafter=%v", before.foreignKeys, got)
			}
			assertDatabaseForeignKeys(t, st.db, true)
			assertNoForeignKeyViolations(t, st.db)
			assertIntegrityOK(t, st.db)
			assertTaskShapeConstraintsRejectInvalidWrites(t, st.db)

			// The custom trigger associated with tasks must be reconstructed.
			if _, err := st.db.Exec("UPDATE tasks SET title=title WHERE id=3"); err != nil {
				t.Fatal(err)
			}
			var auditEvents int
			if err := st.db.QueryRow("SELECT COUNT(*) FROM event_log WHERE event_type='task.audit'").Scan(&auditEvents); err != nil {
				t.Fatal(err)
			}
			if auditEvents != 1 {
				t.Fatalf("recreated trigger events = %d, want 1", auditEvents)
			}

			id, err := st.CreateTask(Task{Title: "after migration", Status: StatusQueued})
			if err != nil {
				t.Fatal(err)
			}
			if id <= before.taskSequence {
				t.Fatalf("AUTOINCREMENT id = %d, must exceed preserved sequence %d", id, before.taskSequence)
			}
			if err := st.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(path)
			if err != nil {
				t.Fatalf("second Open: %v", err)
			}
			if got := testSchemaVersion(t, reopened.db); got != 10 {
				t.Fatalf("second Open schema version = %d", got)
			}
			_ = reopened.Close()
		})
	}
}

func TestTaskShapeMigrationPreflightRejectsInvalidRowsBeforeDDL(t *testing.T) {
	path := t.TempDir() + "/invalid.db"
	db := createVersionedDatabase(t, path, 9)
	now := Now()
	if _, err := db.Exec(`INSERT INTO tasks (id, type, title, status, created_at, updated_at)
		VALUES (1, 'mystery', 'bad type', 'queued', ?, ?);
		INSERT INTO tasks (id, type, title, status, spec, created_at, updated_at)
		VALUES (2, 'task', 'workflow fields', 'queued', '{}', ?, ?);
		INSERT INTO tasks (id, type, title, status, session_dir, created_at, updated_at)
		VALUES (3, 'workflow', 'session fields', 'adopted', '/tmp/session', ?, ?)`, now, now, now, now, now, now); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	opened, err := Open(path)
	if opened != nil {
		_ = opened.Close()
	}
	var preflight *taskShapePreflightError
	if !errors.As(err, &preflight) {
		t.Fatalf("Open error = %v, want taskShapePreflightError", err)
	}
	if len(preflight.Violations) != 3 {
		t.Fatalf("preflight violations = %+v, want three issue/type groups", preflight.Violations)
	}
	message := err.Error()
	for _, want := range []string{"invalid_type", `type="mystery"`, "workflow_fields_on_non_workflow", "session_fields_on_non_session", "count=1"} {
		if !strings.Contains(message, want) {
			t.Fatalf("preflight error %q missing %q", message, want)
		}
	}

	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if got := testSchemaVersion(t, db); got != 9 {
		t.Fatalf("preflight failure advanced version to %d", got)
	}
	var replacementTables int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='tasks_new'").Scan(&replacementTables); err != nil {
		t.Fatal(err)
	}
	if replacementTables != 0 {
		t.Fatal("preflight failure created tasks_new")
	}
	var rows int
	if err := db.QueryRow("SELECT COUNT(*) FROM tasks").Scan(&rows); err != nil || rows != 3 {
		t.Fatalf("preflight failure changed tasks: rows=%d err=%v", rows, err)
	}
}

func TestTaskShapeMigrationForeignKeyFailureRollsBackAndRestoresSetting(t *testing.T) {
	path := t.TempDir() + "/foreign-key.db"
	createAssociatedTaskFixture(t, path, 9)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys=OFF; UPDATE tasks SET role_id=9999 WHERE id=3; PRAGMA foreign_keys=ON;"); err != nil {
		t.Fatal(err)
	}
	assertDatabaseForeignKeys(t, db, true)

	err = migrateToCurrent(db)
	if err == nil || !strings.Contains(err.Error(), "foreign_key_check") {
		t.Fatalf("migration error = %v, want foreign_key_check failure", err)
	}
	assertDatabaseForeignKeys(t, db, true)
	if got := testSchemaVersion(t, db); got != 9 {
		t.Fatalf("failed migration advanced version to %d", got)
	}
	var roleID int64
	if err := db.QueryRow("SELECT role_id FROM tasks WHERE id=3").Scan(&roleID); err != nil || roleID != 9999 {
		t.Fatalf("failed migration changed source row: role_id=%d err=%v", roleID, err)
	}
	var tableSQL string
	if err := db.QueryRow("SELECT sql FROM sqlite_schema WHERE type='table' AND name='tasks'").Scan(&tableSQL); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(tableSQL, "type IN ('task', 'session', 'workflow')") {
		t.Fatal("failed migration left v10 CHECK constraints behind")
	}
	_ = db.Close()
}

func TestTaskShapeMigrationRestoresEnabledForeignKeysOnSuccess(t *testing.T) {
	path := t.TempDir() + "/foreign-key-setting.db"
	createAssociatedTaskFixture(t, path, 9)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		t.Fatal(err)
	}
	if err := migrateToCurrent(db); err != nil {
		t.Fatal(err)
	}
	assertDatabaseForeignKeys(t, db, true)
	assertNoForeignKeyViolations(t, db)
}

func TestFreshSchemaRejectsInvalidTaskShapes(t *testing.T) {
	st := openTest(t)
	assertTaskShapeConstraintsRejectInvalidWrites(t, st.db)
}

func TestOpenRejectsV10SchemaWithoutTaskShapeConstraints(t *testing.T) {
	path := t.TempDir() + "/damaged-v10.db"
	db := createVersionedDatabase(t, path, 10)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	opened, err := Open(path)
	if opened != nil {
		_ = opened.Close()
	}
	var shape *schemaShapeError
	if !errors.As(err, &shape) || !strings.Contains(err.Error(), "tasks 缺少形态约束") {
		t.Fatalf("Open error = %v, want missing Task shape constraint", err)
	}
}

type associatedFixtureSnapshot struct {
	rows          map[string][][]any
	taskSequence  int64
	schemaObjects []string
	foreignKeys   []string
}

func createAssociatedTaskFixture(t *testing.T, path string, version int) associatedFixtureSnapshot {
	t.Helper()
	db := createVersionedDatabase(t, path, version)
	now := "2026-08-24T12:00:00Z"
	if _, err := db.Exec(`
INSERT INTO roles (id, name, runtime_id, enabled, created_at, updated_at)
VALUES (1, 'role', 'pi', 1, ?, ?);
INSERT INTO projects (id, name, project_dir, created_at, updated_at)
VALUES (1, 'project', '/tmp/project', ?, ?);
INSERT INTO tasks (id, type, title, body, status, role_id, project_id, spec, violations, spec_hash, created_at, updated_at)
VALUES (1, 'workflow', 'workflow', 'workflow', 'adopted', 1, 1,
       '{"version":1,"goal":"workflow","created_by":"fixture","limits":{"budget":100,"max_nodes":4,"max_depth":3,"max_concurrency":1},"nodes":[{"id":"node","intent":"do","role":{"role_id":1},"permission":"full","approval_required":false,"timeout_seconds":60,"failure_policy":"stop","budget":10}]}',
       '[]', 'hash', ?, ?);
INSERT INTO tasks (id, type, title, body, status, perm, role_id, project_id, worktree_branch, base_commit,
                   worktree_path, session_dir, last_message_at, message_count, suspended_at, created_at, updated_at)
VALUES (2, 'session', 'session', 'seed', 'suspended', 'review', 1, 1, 'paihuo/session-2', 'base',
        '/tmp/session-worktree', '/tmp/session-dir', ?, 4, ?, ?, ?);
INSERT INTO tasks (id, type, title, body, status, role_id, project_id, parent_id, depends_on, dependency_mode,
                   session_id, parent_session_id, parent_task_id, external_key, created_at, updated_at)
VALUES (3, 'task', 'source', 'body', 'succeeded', 1, 1, 2, 2, 'strong', 2, 2, 2, 'fixture:source', ?, ?);
INSERT INTO tasks (id, type, title, status, role_id, project_id, cron, enabled, created_at, updated_at)
VALUES (4, 'task', 'scheduled', 'queued', 1, 1, '0 * * * * *', 1, ?, ?);
INSERT INTO tasks (id, type, title, status, role_id, project_id, parent_id, merge_of, merge_skipped, created_at, updated_at)
VALUES (5, 'task', 'merge', 'succeeded', 1, 1, 3, 3, 1, ?, ?);
INSERT INTO workflow_runs (id, workflow_id, project_id, task, status, task_ids, created_at, started_at, updated_at)
VALUES (1, 1, 1, 'custom task', 'running', '{"node":6}', ?, ?, ?);
INSERT INTO tasks (id, type, title, status, role_id, project_id, workflow_run_id, parent_id, created_at, updated_at)
VALUES (6, 'task', 'workflow node', 'queued', 1, 1, 1, 3, ?, ?);
INSERT INTO tasks (id, type, title, status, role_id, project_id, schedule_id, created_at, updated_at)
VALUES (7, 'task', 'scheduled instance', 'queued', 1, 1, 4, ?, ?);
INSERT INTO task_dependencies (task_id, depends_on, on_failure) VALUES (6, 3, 'block');
INSERT INTO task_logs (id, task_id, seq, stream, content, created_at) VALUES (1, 3, 1, 'out', 'log', ?);
INSERT INTO settings (key, value) VALUES ('fixture', 'value');
INSERT INTO templates (id, name, body, role_id, created_at) VALUES (1, 'template', 'body', 1, ?);
INSERT INTO skills (id, name, category, tags, dir, source_path, created_at)
VALUES (1, 'skill', 'testing', '["tag"]', '/tmp/skill', '/src/skill', ?);
INSERT INTO event_log (seq, event_type, task_id, role_id, payload, created_at)
VALUES (1, 'fixture.event', 3, 1, '{"ok":true}', ?);
INSERT INTO idempotency_records (key, method, path, status_code, body, created_at)
VALUES ('fixture', 'POST', '/fixture', 201, x'0102', ?);
INSERT INTO artifacts (id, task_id, name, media_type, content_hash, size, locator, created_by, created_at)
VALUES (1, 3, 'task.txt', 'text/plain', 'task-hash', 4, 'sha256/task', 'role', ?);
INSERT INTO artifacts (id, run_id, name, media_type, content_hash, size, locator, created_by, created_at)
VALUES (2, 1, 'run.json', 'application/json', 'run-hash', 2, 'sha256/run', 'workflow', ?);
INSERT INTO tasks (id, type, title, status, created_at, updated_at)
VALUES (100, 'task', 'sequence sentinel', 'cancelled', ?, ?);
DELETE FROM tasks WHERE id=100;
CREATE INDEX idx_tasks_fixture_title ON tasks(title);
CREATE TRIGGER trg_tasks_fixture_audit AFTER UPDATE ON tasks
BEGIN
  INSERT INTO event_log(event_type, task_id, payload, created_at)
  VALUES ('task.audit', NEW.id, '{}', NEW.updated_at);
END;
`, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now); err != nil {
		t.Fatal(err)
	}
	assertNoForeignKeyViolations(t, db)
	snapshot := associatedFixtureSnapshot{
		rows:          dumpBusinessTables(t, db),
		taskSequence:  taskSequence(t, db),
		schemaObjects: taskSchemaObjects(t, db),
		foreignKeys:   foreignKeyDefinitions(t, db),
	}
	if snapshot.taskSequence != 100 {
		t.Fatalf("fixture tasks sequence = %d, want 100", snapshot.taskSequence)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func createVersionedDatabase(t *testing.T, path string, version int) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	versionedTail := strings.Replace(schemaAfterTasks, "PRAGMA user_version=10;", fmt.Sprintf("PRAGMA user_version=%d;", version), 1)
	v9Shape := schemaBeforeTasks + taskTableColumnsSchema + "\n);\n" + taskIndexesSchema + versionedTail
	if _, err := db.Exec(v9Shape); err != nil {
		db.Close()
		t.Fatal(err)
	}
	return db
}

func dumpBusinessTables(t *testing.T, db *sql.DB) map[string][][]any {
	t.Helper()
	out := make(map[string][][]any, len(businessTables))
	for _, table := range businessTables {
		rows, err := db.Query("SELECT * FROM " + table + " ORDER BY rowid")
		if err != nil {
			t.Fatalf("dump %s: %v", table, err)
		}
		columns, err := rows.Columns()
		if err != nil {
			rows.Close()
			t.Fatal(err)
		}
		tableRows := make([][]any, 0)
		for rows.Next() {
			values := make([]any, len(columns))
			targets := make([]any, len(columns))
			for i := range values {
				targets[i] = &values[i]
			}
			if err := rows.Scan(targets...); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			for i, value := range values {
				if bytes, ok := value.([]byte); ok {
					values[i] = string(bytes)
				}
			}
			tableRows = append(tableRows, values)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		rows.Close()
		out[table] = tableRows
	}
	return out
}

func taskSequence(t *testing.T, db *sql.DB) int64 {
	t.Helper()
	var sequence int64
	if err := db.QueryRow("SELECT seq FROM sqlite_sequence WHERE name='tasks'").Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	return sequence
}

func taskSchemaObjects(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT type || ':' || name FROM sqlite_schema
		WHERE tbl_name='tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var objects []string
	for rows.Next() {
		var object string
		if err := rows.Scan(&object); err != nil {
			t.Fatal(err)
		}
		objects = append(objects, object)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return objects
}

func foreignKeyDefinitions(t *testing.T, db *sql.DB) []string {
	t.Helper()
	tables := []string{"tasks", "task_dependencies", "task_logs", "workflow_runs", "artifacts"}
	var definitions []string
	for _, table := range tables {
		rows, err := db.Query("PRAGMA foreign_key_list(" + table + ")")
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var id, seq int
			var parent, from, to, onUpdate, onDelete, match string
			if err := rows.Scan(&id, &seq, &parent, &from, &to, &onUpdate, &onDelete, &match); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			definitions = append(definitions, fmt.Sprintf("%s:%s->%s.%s:%s:%s", table, from, parent, to, onUpdate, onDelete))
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		rows.Close()
	}
	sort.Strings(definitions)
	return definitions
}

func assertNoForeignKeyViolations(t *testing.T, db *sql.DB) {
	t.Helper()
	rows, err := db.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		var table, parent string
		var rowID sql.NullInt64
		var id int
		if err := rows.Scan(&table, &rowID, &parent, &id); err != nil {
			t.Fatal(err)
		}
		t.Fatalf("foreign key violation: table=%s row=%v parent=%s fk=%d", table, rowID, parent, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

func assertIntegrityOK(t *testing.T, db *sql.DB) {
	t.Helper()
	var result string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&result); err != nil {
		t.Fatal(err)
	}
	if result != "ok" {
		t.Fatalf("integrity_check = %q", result)
	}
}

func assertTaskShapeConstraintsRejectInvalidWrites(t *testing.T, db *sql.DB) {
	t.Helper()
	now := Now()
	var taskID int64
	if err := db.QueryRow("SELECT id FROM tasks WHERE type='task' LIMIT 1").Scan(&taskID); errors.Is(err, sql.ErrNoRows) {
		result, err := db.Exec(`INSERT INTO tasks (type, title, status, created_at, updated_at)
			VALUES ('task', 'constraint probe', 'queued', ?, ?)`, now, now)
		if err != nil {
			t.Fatal(err)
		}
		taskID, err = result.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
	} else if err != nil {
		t.Fatal(err)
	}
	statements := []struct {
		name string
		sql  string
		args []any
	}{
		{"invalid type", `INSERT INTO tasks (type, title, status, created_at, updated_at) VALUES ('mystery', 'bad', 'queued', ?, ?)`, []any{now, now}},
		{"workflow spec on task", `UPDATE tasks SET spec='{}' WHERE id=?`, []any{taskID}},
		{"workflow hash on task", `UPDATE tasks SET spec_hash='hash' WHERE id=?`, []any{taskID}},
		{"workflow violations on task", `UPDATE tasks SET violations='["bad"]' WHERE id=?`, []any{taskID}},
		{"session fields on task", `UPDATE tasks SET worktree_path='/tmp/worktree', session_dir='/tmp/session', last_message_at='now', message_count=1, suspended_at='now', delivered_at='now' WHERE id=?`, []any{taskID}},
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement.sql, statement.args...); err == nil {
			t.Fatalf("%s must be rejected by Task shape CHECK", statement.name)
		}
	}
}
