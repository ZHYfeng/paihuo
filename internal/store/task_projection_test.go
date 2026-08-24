package store

import (
	"reflect"
	"testing"
)

func TestTaskColumnsMatchTasksSchema(t *testing.T) {
	s := openTest(t)
	rows, err := s.db.Query("SELECT name FROM pragma_table_info('tasks') ORDER BY cid")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var schemaColumns []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		schemaColumns = append(schemaColumns, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	projectionColumns := make([]string, 0, len(taskColumns))
	seen := make(map[string]int, len(taskColumns))
	computed := 0
	for index, column := range taskColumns {
		if column.expr == "" {
			t.Fatalf("taskColumns[%d] 缺少完整 SELECT 表达式", index)
		}
		if column.destination == nil {
			t.Fatalf("taskColumns[%d] (%q) 缺少 Scan destination", index, column.name)
		}
		if column.name == "" {
			computed++
			continue
		}
		if previous, exists := seen[column.name]; exists {
			t.Fatalf("Task 真实列重复: %q 位于 %d 和 %d", column.name, previous, index)
		}
		seen[column.name] = index
		projectionColumns = append(projectionColumns, column.name)
	}
	if computed != 2 {
		t.Fatalf("computed/JOIN projection 数量 = %d, want 2", computed)
	}
	if !reflect.DeepEqual(projectionColumns, schemaColumns) {
		missing, extra := projectionDifference(schemaColumns, projectionColumns)
		t.Fatalf("Task projection 与 tasks schema 不一致\nmissing=%v\nextra=%v\nschema=%v\nprojection=%v", missing, extra, schemaColumns, projectionColumns)
	}
	if taskColumns[3].name != "body" || taskColumns[3].briefExpr != "substr(t.body,1,400) AS body" {
		t.Fatalf("body brief projection 被改动: %+v", taskColumns[3])
	}
}

func projectionDifference(want, got []string) (missing, extra []string) {
	wantSet := make(map[string]bool, len(want))
	gotSet := make(map[string]bool, len(got))
	for _, name := range want {
		wantSet[name] = true
	}
	for _, name := range got {
		gotSet[name] = true
	}
	for _, name := range want {
		if !gotSet[name] {
			missing = append(missing, name)
		}
	}
	for _, name := range got {
		if !wantSet[name] {
			extra = append(extra, name)
		}
	}
	return missing, extra
}
