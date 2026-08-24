package store

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestFreshDatabaseStartsAtCurrentSchemaVersion(t *testing.T) {
	st := openTest(t)
	if got := testSchemaVersion(t, st.db); got != currentSchemaVersion {
		t.Fatalf("fresh schema version = %d, want %d", got, currentSchemaVersion)
	}
	assertDatabaseForeignKeys(t, st.db, true)
}

func TestOpenMigratesEverySupportedVersionToCurrent(t *testing.T) {
	for version := minimumSchemaVersion; version <= currentSchemaVersion; version++ {
		version := version
		t.Run(fmt.Sprintf("v%d", version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fixture.db")
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			fixtureSchema := strings.Replace(schema, "PRAGMA user_version=9;", fmt.Sprintf("PRAGMA user_version=%d;", version), 1)
			if _, err := db.Exec(fixtureSchema); err != nil {
				t.Fatal(err)
			}
			now := Now()
			if _, err := db.Exec(`INSERT INTO tasks (id, title, body, status, created_at, updated_at)
				VALUES (41, 'preserved', 'body', 'queued', ?, ?)`, now, now); err != nil {
				t.Fatal(err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}

			st, err := Open(path)
			if err != nil {
				t.Fatalf("Open v%d: %v", version, err)
			}
			defer st.Close()
			if got := testSchemaVersion(t, st.db); got != currentSchemaVersion {
				t.Fatalf("schema version = %d, want %d", got, currentSchemaVersion)
			}
			var title, body string
			if err := st.db.QueryRow("SELECT title, body FROM tasks WHERE id=41").Scan(&title, &body); err != nil {
				t.Fatal(err)
			}
			if title != "preserved" || body != "body" {
				t.Fatalf("task data changed: title=%q body=%q", title, body)
			}
			assertIndexExists(t, st.db, "idx_tasks_external_key_unique")
			assertIndexExists(t, st.db, "idx_tasks_parent_session")
			assertIndexExists(t, st.db, "idx_tasks_parent_task")
			assertForeignKeyExists(t, st.db, "tasks", "parent_session_id", "tasks")
			assertDatabaseForeignKeys(t, st.db, true)
		})
	}
}

func TestOpenRejectsUnsupportedSchemaVersionsWithoutMutation(t *testing.T) {
	for _, version := range []int{-1, 0, currentSchemaVersion + 1} {
		version := version
		t.Run(fmt.Sprintf("v%d", version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "unsupported.db")
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(fmt.Sprintf("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('keep'); PRAGMA user_version=%d;", version)); err != nil {
				t.Fatal(err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}

			opened, err := Open(path)
			if opened != nil {
				_ = opened.Close()
			}
			var unsupported *unsupportedSchemaVersionError
			if !errors.As(err, &unsupported) {
				t.Fatalf("Open error = %v, want unsupportedSchemaVersionError", err)
			}
			if unsupported.Version != version {
				t.Fatalf("reported version = %d, want %d", unsupported.Version, version)
			}

			db, err = sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if got := testSchemaVersion(t, db); got != version {
				t.Fatalf("rejected database version changed to %d", got)
			}
			var value string
			if err := db.QueryRow("SELECT value FROM marker").Scan(&value); err != nil || value != "keep" {
				t.Fatalf("rejected database mutated: value=%q err=%v", value, err)
			}
		})
	}
}

func TestOpenReportsCurrentVersionShapeDamageSeparately(t *testing.T) {
	path := filepath.Join(t.TempDir(), "damaged.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	damaged := strings.Replace(schema, "  merge_skipped INTEGER NOT NULL DEFAULT 0, -- 判定无改动：直接视为已交付，不再创建/补建合并任务\n", "", 1)
	if _, err := db.Exec(damaged); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	opened, err := Open(path)
	if opened != nil {
		_ = opened.Close()
	}
	var shape *schemaShapeError
	if !errors.As(err, &shape) {
		t.Fatalf("Open error = %v, want schemaShapeError", err)
	}
	var unsupported *unsupportedSchemaVersionError
	if errors.As(err, &unsupported) {
		t.Fatalf("shape damage must not be reported as unsupported version: %v", err)
	}
}

func TestMigrationFailureRollsBackSchemaAndVersionTogether(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollback.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("CREATE TABLE sample (id INTEGER PRIMARY KEY); PRAGMA user_version=1;"); err != nil {
		t.Fatal(err)
	}
	registry := []migration{{
		version: 2,
		name:    "injected failure",
		up: func(tx migrationDB) error {
			if _, err := tx.Exec("ALTER TABLE sample ADD COLUMN value TEXT"); err != nil {
				return err
			}
			_, err := tx.Exec("THIS IS NOT SQL")
			return err
		},
	}}
	if err := migrateDatabase(db, registry, 1, 2); err == nil {
		t.Fatal("migration must fail")
	}
	if got := testSchemaVersion(t, db); got != 1 {
		t.Fatalf("failed migration advanced version to %d", got)
	}
	var columns int
	if err := db.QueryRow("SELECT COUNT(*) FROM pragma_table_info('sample') WHERE name='value'").Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 0 {
		t.Fatal("failed migration left its DDL behind")
	}
}

func TestOpenCurrentVersionIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "current.db")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Open(path)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
}

func testSchemaVersion(t *testing.T, db *sql.DB) int {
	t.Helper()
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	return version
}

func assertIndexExists(t *testing.T, db *sql.DB, name string) {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_schema WHERE type='index' AND name=?", name).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("index %s count = %d", name, count)
	}
}

func assertForeignKeyExists(t *testing.T, db *sql.DB, table, column, parent string) {
	t.Helper()
	rows, err := db.Query("PRAGMA foreign_key_list(" + table + ")")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, seq int
		var target, from, to, onUpdate, onDelete, match string
		if err := rows.Scan(&id, &seq, &target, &from, &to, &onUpdate, &onDelete, &match); err != nil {
			t.Fatal(err)
		}
		if from == column && target == parent {
			return
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	t.Fatalf("foreign key %s.%s -> %s not found", table, column, parent)
}

func assertDatabaseForeignKeys(t *testing.T, db *sql.DB, want bool) {
	t.Helper()
	var enabled int
	if err := db.QueryRow("PRAGMA foreign_keys").Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if (enabled == 1) != want {
		t.Fatalf("PRAGMA foreign_keys = %d, want enabled=%v", enabled, want)
	}
}
