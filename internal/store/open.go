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
	} else if err := migrateToCurrent(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := verifyCurrentSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := configureDatabase(db); err != nil {
		db.Close()
		return nil, err
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

func configureDatabase(db *sql.DB) error {
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return fmt.Errorf("配置数据库 journal_mode 失败: %w", err)
	}
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		return fmt.Errorf("启用数据库外键失败: %w", err)
	}
	var enabled int
	if err := db.QueryRow("PRAGMA foreign_keys").Scan(&enabled); err != nil {
		return fmt.Errorf("检查数据库外键配置失败: %w", err)
	}
	if enabled != 1 {
		return fmt.Errorf("启用数据库外键失败: PRAGMA foreign_keys=%d", enabled)
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }

func Now() string { return time.Now().UTC().Format(time.RFC3339) }
