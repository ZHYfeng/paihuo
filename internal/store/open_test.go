package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenRejectsUnsupportedSchemaWithoutMutatingIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unsupported.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE agents (id INTEGER PRIMARY KEY, cli TEXT); PRAGMA user_version=0;"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	if opened, err := Open(path); err == nil {
		_ = opened.Close()
		t.Fatal("unsupported schema must be rejected")
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='roles'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("schema rejection must not create current tables in an unsupported database")
	}
}
