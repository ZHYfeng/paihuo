package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const taskShapePreflightSQL = `
SELECT issue, type, COUNT(*)
FROM (
  SELECT 'invalid_type' AS issue, type
  FROM tasks
  WHERE type NOT IN ('task', 'session', 'workflow')
  UNION ALL
  SELECT 'workflow_fields_on_non_workflow', type
  FROM tasks
  WHERE type <> 'workflow'
    AND (spec <> '' OR spec_hash <> '' OR violations NOT IN ('', '[]'))
  UNION ALL
  SELECT 'session_fields_on_non_session', type
  FROM tasks
  WHERE type <> 'session'
    AND (worktree_path <> '' OR session_dir <> '' OR last_message_at <> '' OR
         message_count <> 0 OR suspended_at IS NOT NULL OR delivered_at IS NOT NULL)
)
GROUP BY issue, type
ORDER BY issue, type`

type taskShapeViolation struct {
	Issue string
	Type  string
	Count int
}

type taskShapePreflightError struct {
	Violations []taskShapeViolation
}

func (e *taskShapePreflightError) Error() string {
	parts := make([]string, 0, len(e.Violations))
	for _, violation := range e.Violations {
		parts = append(parts, fmt.Sprintf("%s(type=%q,count=%d)", violation.Issue, violation.Type, violation.Count))
	}
	return "Task 形态约束预检失败: " + strings.Join(parts, ", ")
}

type taskSchemaObject struct {
	kind string
	name string
	sql  string
}

var standardTaskIndexes = map[string]bool{
	"idx_tasks_status":              true,
	"idx_tasks_role":                true,
	"idx_tasks_project":             true,
	"idx_tasks_project_sort":        true,
	"idx_tasks_finished":            true,
	"idx_tasks_depends_on":          true,
	"idx_tasks_workflow_run":        true,
	"idx_tasks_parent_session":      true,
	"idx_tasks_parent_task":         true,
	"idx_tasks_merge_of_unique":     true,
	"idx_tasks_external_key_unique": true,
}

func migrateTaskShapeConstraints(db migrationDB) error {
	if err := preflightTaskShapes(db); err != nil {
		return err
	}
	objects, err := loadTaskSchemaObjects(db)
	if err != nil {
		return err
	}
	var previousSequence sql.NullInt64
	if err := db.QueryRow("SELECT seq FROM sqlite_sequence WHERE name='tasks'").Scan(&previousSequence); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("读取 tasks AUTOINCREMENT 序列失败: %w", err)
	}

	createReplacement := strings.Replace(tasksTableSchema,
		"CREATE TABLE IF NOT EXISTS tasks", "CREATE TABLE tasks_new", 1)
	createReplacement = strings.ReplaceAll(createReplacement, "REFERENCES tasks(id)", "REFERENCES tasks_new(id)")
	if _, err := db.Exec(createReplacement); err != nil {
		return fmt.Errorf("创建 tasks_new 失败: %w", err)
	}
	columns := taskStorageColumns()
	copySQL := "INSERT INTO tasks_new (" + columns + ") SELECT " + columns + " FROM tasks"
	if _, err := db.Exec(copySQL); err != nil {
		return fmt.Errorf("复制 tasks 数据失败: %w", err)
	}
	if _, err := db.Exec("DROP TABLE tasks"); err != nil {
		return fmt.Errorf("删除旧 tasks 表失败: %w", err)
	}
	if _, err := db.Exec("ALTER TABLE tasks_new RENAME TO tasks"); err != nil {
		return fmt.Errorf("替换 tasks 表失败: %w", err)
	}
	if _, err := db.Exec(taskIndexesSchema); err != nil {
		return fmt.Errorf("重建 tasks 索引失败: %w", err)
	}
	for _, object := range objects {
		if object.kind == "index" && standardTaskIndexes[object.name] {
			continue
		}
		if _, err := db.Exec(object.sql); err != nil {
			return fmt.Errorf("重建 tasks %s %s 失败: %w", object.kind, object.name, err)
		}
	}
	if previousSequence.Valid {
		result, err := db.Exec(`UPDATE sqlite_sequence
			SET seq=CASE WHEN seq < ? THEN ? ELSE seq END WHERE name='tasks'`, previousSequence.Int64, previousSequence.Int64)
		if err != nil {
			return fmt.Errorf("恢复 tasks AUTOINCREMENT 序列失败: %w", err)
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("检查 tasks AUTOINCREMENT 序列失败: %w", err)
		}
		if changed == 0 {
			if _, err := db.Exec("INSERT INTO sqlite_sequence(name, seq) VALUES('tasks', ?)", previousSequence.Int64); err != nil {
				return fmt.Errorf("恢复 tasks AUTOINCREMENT 序列失败: %w", err)
			}
		}
	}
	if err := checkForeignKeys(db); err != nil {
		return err
	}
	return nil
}

func preflightTaskShapes(db migrationDB) error {
	rows, err := db.Query(taskShapePreflightSQL)
	if err != nil {
		return fmt.Errorf("执行 Task 形态约束预检失败: %w", err)
	}
	defer rows.Close()
	violations := make([]taskShapeViolation, 0)
	for rows.Next() {
		var violation taskShapeViolation
		if err := rows.Scan(&violation.Issue, &violation.Type, &violation.Count); err != nil {
			return fmt.Errorf("读取 Task 形态约束预检结果失败: %w", err)
		}
		violations = append(violations, violation)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("读取 Task 形态约束预检结果失败: %w", err)
	}
	if len(violations) > 0 {
		return &taskShapePreflightError{Violations: violations}
	}
	return nil
}

func loadTaskSchemaObjects(db migrationDB) ([]taskSchemaObject, error) {
	rows, err := db.Query(`SELECT type, name, sql FROM sqlite_schema
		WHERE tbl_name='tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL
		ORDER BY type, name`)
	if err != nil {
		return nil, fmt.Errorf("读取 tasks 索引和触发器失败: %w", err)
	}
	defer rows.Close()
	objects := make([]taskSchemaObject, 0)
	for rows.Next() {
		var object taskSchemaObject
		if err := rows.Scan(&object.kind, &object.name, &object.sql); err != nil {
			return nil, fmt.Errorf("读取 tasks schema 对象失败: %w", err)
		}
		objects = append(objects, object)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("读取 tasks schema 对象失败: %w", err)
	}
	return objects, nil
}

func taskStorageColumns() string {
	columns := make([]string, 0, len(taskColumns))
	for _, column := range taskColumns {
		if column.name != "" {
			columns = append(columns, column.name)
		}
	}
	return strings.Join(columns, ", ")
}

func checkForeignKeys(db migrationDB) error {
	rows, err := db.Query("PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("执行 foreign_key_check 失败: %w", err)
	}
	defer rows.Close()
	violations := make([]string, 0)
	for rows.Next() {
		var table, parent string
		var rowID sql.NullInt64
		var foreignKeyID int
		if err := rows.Scan(&table, &rowID, &parent, &foreignKeyID); err != nil {
			return fmt.Errorf("读取 foreign_key_check 结果失败: %w", err)
		}
		row := "NULL"
		if rowID.Valid {
			row = fmt.Sprintf("%d", rowID.Int64)
		}
		violations = append(violations, fmt.Sprintf("%s(rowid=%s)->%s(fk=%d)", table, row, parent, foreignKeyID))
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("读取 foreign_key_check 结果失败: %w", err)
	}
	if len(violations) > 0 {
		return fmt.Errorf("foreign_key_check 失败（%d 项）: %s", len(violations), strings.Join(violations, ", "))
	}
	return nil
}
