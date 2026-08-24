package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
)

const (
	minimumSchemaVersion = 1
	currentSchemaVersion = 9
)

type migration struct {
	version                int
	name                   string
	up                     func(migrationDB) error
	requiresForeignKeysOff bool
}

var migrationRegistry = []migration{
	{version: 2, name: "workflow_runs.project_id", up: migrateWorkflowRunsProjectColumn},
	{version: 3, name: "workflow_runs.task", up: migrateWorkflowRunsTaskColumn},
	{version: 4, name: "skills.category", up: migrateSkillsCategoryColumn},
	{version: 5, name: "projects GitHub columns", up: migrateProjectGitHubColumns},
	{version: 6, name: "tasks.external_key", up: migrateTaskExternalKeyColumn},
	{version: 7, name: "tasks parent columns", up: migrateTaskParentColumns},
	{version: 8, name: "roles delegation columns", up: migrateRoleDelegationColumns},
	{version: 9, name: "tasks.merge_skipped", up: migrateTaskMergeSkippedColumn},
}

type unsupportedSchemaVersionError struct {
	Version int
	Minimum int
	Latest  int
}

func (e *unsupportedSchemaVersionError) Error() string {
	return fmt.Sprintf("不支持数据库 schema 版本 v%d；当前 binary 支持 v%d–v%d", e.Version, e.Minimum, e.Latest)
}

type schemaShapeError struct {
	Version int
	Err     error
}

func (e *schemaShapeError) Error() string {
	return fmt.Sprintf("数据库 schema v%d 结构损坏: %v", e.Version, e.Err)
}

func (e *schemaShapeError) Unwrap() error { return e.Err }

func readSchemaVersion(db *sql.DB) (int, error) {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return 0, fmt.Errorf("读取数据库 schema 版本失败: %w", err)
	}
	return version, nil
}

func migrateToCurrent(db *sql.DB) error {
	return migrateDatabase(db, migrationRegistry, minimumSchemaVersion, currentSchemaVersion)
}

// migrateDatabase applies every pending numbered migration in one transaction.
// A migration's DDL/data changes and its user_version update therefore cannot
// be observed separately, and a later failure rolls back the whole pending path.
func migrateDatabase(db *sql.DB, registry []migration, minimum, latest int) error {
	version, err := readSchemaVersion(db)
	if err != nil {
		return err
	}
	if version < minimum || version > latest {
		return &unsupportedSchemaVersionError{Version: version, Minimum: minimum, Latest: latest}
	}
	if version == latest {
		return nil
	}

	pending := make([]migration, 0, latest-version)
	for next := version + 1; next <= latest; next++ {
		item, ok := migrationAt(registry, next)
		if !ok {
			return fmt.Errorf("数据库迁移注册表缺少 v%d", next)
		}
		pending = append(pending, item)
	}

	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("获取数据库迁移连接失败: %w", err)
	}
	defer conn.Close()

	foreignKeysWereEnabled, err := connectionForeignKeysEnabled(ctx, conn)
	if err != nil {
		return err
	}
	mustDisableForeignKeys := false
	for _, item := range pending {
		mustDisableForeignKeys = mustDisableForeignKeys || item.requiresForeignKeysOff
	}
	foreignKeysDisabled := mustDisableForeignKeys && foreignKeysWereEnabled
	if foreignKeysDisabled {
		if err := setConnectionForeignKeys(ctx, conn, false); err != nil {
			return err
		}
	}

	migrationErr := applyPendingMigrations(ctx, conn, pending)
	if foreignKeysDisabled {
		restoreErr := setConnectionForeignKeys(ctx, conn, true)
		if migrationErr != nil && restoreErr != nil {
			return errors.Join(migrationErr, restoreErr)
		}
		if restoreErr != nil {
			return restoreErr
		}
	}
	return migrationErr
}

func migrationAt(registry []migration, version int) (migration, bool) {
	for _, item := range registry {
		if item.version == version {
			return item, true
		}
	}
	return migration{}, false
}

func applyPendingMigrations(ctx context.Context, conn *sql.Conn, pending []migration) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始数据库迁移事务失败: %w", err)
	}
	defer tx.Rollback()
	for _, item := range pending {
		if err := item.up(tx); err != nil {
			return fmt.Errorf("数据库迁移 v%d（%s）失败: %w", item.version, item.name, err)
		}
		if _, err := tx.Exec("PRAGMA user_version=" + strconv.Itoa(item.version)); err != nil {
			return fmt.Errorf("推进数据库 schema 版本到 v%d 失败: %w", item.version, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交数据库迁移失败: %w", err)
	}
	return nil
}

func connectionForeignKeysEnabled(ctx context.Context, conn *sql.Conn) (bool, error) {
	var enabled int
	if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&enabled); err != nil {
		return false, fmt.Errorf("检查数据库外键配置失败: %w", err)
	}
	return enabled == 1, nil
}

func setConnectionForeignKeys(ctx context.Context, conn *sql.Conn, enabled bool) error {
	value := "OFF"
	want := 0
	if enabled {
		value = "ON"
		want = 1
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys="+value); err != nil {
		return fmt.Errorf("设置数据库 foreign_keys=%s 失败: %w", value, err)
	}
	var got int
	if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&got); err != nil {
		return fmt.Errorf("验证数据库 foreign_keys=%s 失败: %w", value, err)
	}
	if got != want {
		return fmt.Errorf("设置数据库 foreign_keys=%s 未生效", value)
	}
	return nil
}
