package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  cli           TEXT NOT NULL,
  role_config   TEXT NOT NULL DEFAULT '{}',
  project_dir   TEXT NOT NULL DEFAULT '',
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency >= 1),
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active', -- active | archived
  project_dir TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued',
  perm        TEXT NOT NULL DEFAULT 'full',
  run_mode    TEXT NOT NULL DEFAULT 'batch',
  concurrent  INTEGER NOT NULL DEFAULT 0, -- 1=允许并发（默认串行：同一项目同时只执行一个任务）
  agent_id    INTEGER REFERENCES agents(id),
  project_id  INTEGER REFERENCES projects(id),
  project_dir TEXT NOT NULL DEFAULT '',
  parent_id   INTEGER REFERENCES tasks(id),
  depends_on  INTEGER REFERENCES tasks(id),
  dependency_mode TEXT NOT NULL DEFAULT 'none',
  block_on_failure INTEGER NOT NULL DEFAULT 0,
  schedule_id INTEGER,
  error       TEXT NOT NULL DEFAULT '',
  exit_code   INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  review_rounds INTEGER NOT NULL DEFAULT 0,
  tmux_log_offset INTEGER NOT NULL DEFAULT 0,
  worktree_branch TEXT NOT NULL DEFAULT '',
  base_commit   TEXT NOT NULL DEFAULT '',
  resume_of     INTEGER REFERENCES tasks(id),
  merge_of      INTEGER,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);

CREATE TABLE IF NOT EXISTS task_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  stream     TEXT NOT NULL DEFAULT 'out',
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, seq);

CREATE TABLE IF NOT EXISTS schedules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  cron           TEXT NOT NULL,
  title_template TEXT NOT NULL,
  body_template  TEXT NOT NULL DEFAULT '',
  agent_id       INTEGER NOT NULL REFERENCES agents(id),
  project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  perm           TEXT NOT NULL DEFAULT 'full',
  block_on_failure INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_run_at    TEXT,
  next_run_at    TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  agent_id   INTEGER REFERENCES agents(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON array of labels
  dir         TEXT NOT NULL UNIQUE,      -- 复制到 paihuo 工作目录后的技能目录（绝对路径）
  source_path TEXT NOT NULL DEFAULT '',  -- 添加时的来源路径
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id),
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'created', -- created|active|suspended|delivered|deleted
  cli         TEXT NOT NULL DEFAULT '',
  worktree_branch TEXT NOT NULL DEFAULT '',
  worktree_path   TEXT NOT NULL DEFAULT '',
  base_commit     TEXT NOT NULL DEFAULT '',
  session_dir     TEXT NOT NULL DEFAULT '',
  task_id     INTEGER REFERENCES tasks(id),
  last_message_at TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  suspended_at TEXT,
  delivered_at TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
`

// migrate 结构迁移：老库升级到新 schema（pre-1.0 阶段直接删旧结构）。
func migrate(db *sql.DB) error {
	// 移除已废弃的设备概念（SSH 通道不再需要：服务直接部署在执行机上）
	// 注意顺序：先删引用列（agents.device_id / tasks.device_id），再删 devices 表
	for _, stmt := range []string{
		"ALTER TABLE agents DROP COLUMN device_id",
		"ALTER TABLE tasks DROP COLUMN device_id",
	} {
		if _, err := db.Exec(stmt); err != nil {
			// 列不存在则忽略（可能已删）
			if !strings.Contains(err.Error(), "no such column") {
				return err
			}
		}
	}
	if have, err := tableExists(db, "devices"); err != nil {
		return err
	} else if have {
		if _, err := db.Exec("DROP TABLE devices"); err != nil {
			return fmt.Errorf("删除 devices 表失败: %w", err)
		}
	}
	for _, stmt := range []string{
		"ALTER TABLE agents ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE skills ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
		"ALTER TABLE tasks ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE tasks ADD COLUMN tmux_log_offset INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE tasks ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'batch'",
		"ALTER TABLE tasks ADD COLUMN concurrent INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id)",
		"ALTER TABLE projects ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE tasks ADD COLUMN worktree_branch TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE tasks ADD COLUMN base_commit TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE tasks ADD COLUMN resume_of INTEGER REFERENCES tasks(id)",
		"ALTER TABLE tasks ADD COLUMN merge_of INTEGER",
		"ALTER TABLE tasks ADD COLUMN depends_on INTEGER REFERENCES tasks(id)",
		"ALTER TABLE tasks ADD COLUMN dependency_mode TEXT NOT NULL DEFAULT 'none'",
		"ALTER TABLE tasks ADD COLUMN block_on_failure INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE tasks ADD COLUMN terminal_cols INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE tasks ADD COLUMN terminal_rows INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE tasks ADD COLUMN session_id INTEGER REFERENCES sessions(id)",
		"ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0",
		"CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_finished ON tasks(finished_at)",
	} {
		if _, err := db.Exec(stmt); err != nil {
			// 列已存在则忽略
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	// 权限属于任务而非角色。旧版定时任务会从角色默认权限继承，这里把
	// 旧值固化到定时任务模板，之后每次触发再写入对应 Task.perm。
	if _, err := db.Exec("ALTER TABLE schedules ADD COLUMN perm TEXT NOT NULL DEFAULT 'full'"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	for _, stmt := range []string{
		"ALTER TABLE schedules ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL",
		"ALTER TABLE schedules ADD COLUMN block_on_failure INTEGER NOT NULL DEFAULT 0",
		"CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks(depends_on)",
		"CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules(project_id)",
	} {
		if _, err := db.Exec(stmt); err != nil {
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	if have, err := columnExists(db, "agents", "default_perm"); err != nil {
		return err
	} else if have {
		if _, err := db.Exec(`UPDATE schedules
			SET perm = COALESCE((
				SELECT CASE WHEN a.default_perm IN ('full', 'review') THEN a.default_perm ELSE 'full' END
				FROM agents a WHERE a.id = schedules.agent_id
			), 'full')`); err != nil {
			return fmt.Errorf("迁移定时任务权限失败: %w", err)
		}
		if _, err := db.Exec("ALTER TABLE agents DROP COLUMN default_perm"); err != nil {
			return fmt.Errorf("移除角色默认权限失败: %w", err)
		}
	}
	// 索引在迁移阶段创建：老库先补列再建索引；新库 schema 建表时列已存在
	for _, stmt := range []string{
		"CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_project_sort ON tasks(project_id, sort_order)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_finished ON tasks(finished_at)",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_merge_of_unique ON tasks(merge_of) WHERE merge_of IS NOT NULL",
	} {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	// readonly 权限模式已移除：历史任务按完整权限继续执行
	if _, err := db.Exec("UPDATE tasks SET perm='full' WHERE perm='readonly'"); err != nil {
		return err
	}
	if err := backfillTaskSortOrder(db); err != nil {
		return err
	}
	return nil
}

func columnExists(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

// backfillTaskSortOrder upgrades project tasks from databases created before
// the explicit order field existed.  Existing rows keep their current order
// when possible; rows without an order fall back to creation time.
func backfillTaskSortOrder(db *sql.DB) error {
	type item struct {
		id        int64
		projectID int64
		order     int64
		createdAt string
	}
	rows, err := db.Query(`SELECT id, project_id, sort_order, created_at
		FROM tasks
		WHERE project_id IS NOT NULL AND merge_of IS NULL
		ORDER BY project_id, created_at, id`)
	if err != nil {
		return err
	}
	items := make([]item, 0)
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.projectID, &it.order, &it.createdAt); err != nil {
			rows.Close()
			return err
		}
		items = append(items, it)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	groups := make(map[int64][]item)
	for _, it := range items {
		groups[it.projectID] = append(groups[it.projectID], it)
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for projectID, group := range groups {
		hasMissing := false
		for _, it := range group {
			if it.order <= 0 {
				hasMissing = true
				break
			}
		}
		if !hasMissing {
			continue
		}
		sort.SliceStable(group, func(i, j int) bool {
			left, right := group[i], group[j]
			if left.order > 0 && right.order > 0 && left.order != right.order {
				return left.order < right.order
			}
			if left.order > 0 && right.order <= 0 {
				return true
			}
			if left.order <= 0 && right.order > 0 {
				return false
			}
			if left.createdAt != right.createdAt {
				return left.createdAt < right.createdAt
			}
			return left.id < right.id
		})
		for i, it := range group {
			if _, err := tx.Exec("UPDATE tasks SET sort_order=? WHERE id=? AND project_id=? AND merge_of IS NULL", i+1, it.id, projectID); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func tableExists(db *sql.DB, table string) (bool, error) {
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// Store 封装 SQLite 访问。SetMaxOpenConns(1) 保证读写顺序一致（WAL 下单写者足够）。
type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化数据库失败: %w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("迁移数据库失败: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func Now() string { return time.Now().UTC().Format(time.RFC3339) }

// ---------------------------------------------------------------------------
// 通用更新

func updateOne(db *sql.DB, table string, id int64, set map[string]any) error {
	return updateOneExecer(db, table, id, set)
}

func updateOneExecer(execer sqlExecer, table string, id int64, set map[string]any) error {
	if len(set) == 0 {
		return nil
	}
	cols := make([]string, 0, len(set))
	vals := make([]any, 0, len(set)+1)
	for k, v := range set {
		cols = append(cols, k+"=?")
		vals = append(vals, v)
	}
	vals = append(vals, Now(), id)
	q := fmt.Sprintf("UPDATE %s SET %s, updated_at=? WHERE id=?", table, strings.Join(cols, ", "))
	_, err := execer.Exec(q, vals...)
	return err
}

func nullInt64(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func strPtr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

// scanner 兼容 *sql.Row 与 *sql.Rows
type scanner interface {
	Scan(dest ...any) error
}

// ---------------------------------------------------------------------------
// 角色（agent）

const agentCols = `a.id, a.name, a.description, a.cli, a.role_config,
	a.project_dir, a.max_concurrency, a.enabled, a.created_at, a.updated_at`

func scanAgent(rows scanner) (Agent, error) {
	var a Agent
	var rc string
	err := rows.Scan(&a.ID, &a.Name, &a.Description, &a.CLI, &rc,
		&a.ProjectDir, &a.MaxConcurrency, &a.Enabled, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return a, err
	}
	if rc != "" {
		_ = json.Unmarshal([]byte(rc), &a.RoleConfig)
	}
	a.MaxConcurrency = a.ConcurrencyLimit()
	return a, nil
}

func (s *Store) ListAgents() ([]Agent, error) {
	rows, err := s.db.Query("SELECT " + agentCols + " FROM agents a ORDER BY a.id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Agent, 0)
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) GetAgent(id int64) (*Agent, error) {
	row := s.db.QueryRow("SELECT "+agentCols+" FROM agents a WHERE a.id=?", id)
	a, err := scanAgent(row)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) CreateAgent(a Agent) (int64, error) {
	if a.CreatedAt == "" {
		a.CreatedAt = Now()
	}
	if a.UpdatedAt == "" {
		a.UpdatedAt = a.CreatedAt
	}
	a.MaxConcurrency = a.ConcurrencyLimit()
	rc, err := json.Marshal(a.RoleConfig)
	if err != nil {
		return 0, err
	}
	res, err := s.db.Exec(`INSERT INTO agents (name, description, cli, role_config, project_dir, max_concurrency, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.Name, a.Description, a.CLI, string(rc), a.ProjectDir, a.MaxConcurrency, a.Enabled, a.CreatedAt, a.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateAgent(id int64, set map[string]any) error {
	if rc, ok := set["role_config"]; ok {
		b, err := json.Marshal(rc)
		if err != nil {
			return err
		}
		set["role_config"] = string(b)
	}
	return updateOne(s.db, "agents", id, set)
}

func (s *Store) DeleteAgent(id int64) error {
	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE agent_id=? AND status IN ('queued','claimed','running','awaiting_review')", id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return errors.New("该角色仍有未完成任务，无法删除")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// 历史任务与模板解除指派（保留记录），定时任务随角色一并删除（agent_id NOT NULL）。
	if _, err := tx.Exec("UPDATE tasks SET agent_id=NULL WHERE agent_id=?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("UPDATE templates SET agent_id=NULL WHERE agent_id=?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM schedules WHERE agent_id=?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM agents WHERE id=?", id); err != nil {
		return err
	}
	return tx.Commit()
}

// ---------------------------------------------------------------------------
// 任务

// taskCols 完整列（详情页用：含完整 body，驳回重做会追加修改意见）。
const taskCols = `t.id, t.title, t.body, t.status, t.perm, t.run_mode, t.concurrent, t.agent_id, COALESCE(a.name, ''),
	t.project_id, COALESCE(p.name, ''), t.project_dir, t.parent_id, t.depends_on, t.dependency_mode, t.block_on_failure, t.schedule_id, t.error, t.exit_code,
	t.review_note, t.review_rounds, t.tmux_log_offset, t.worktree_branch, t.base_commit, t.resume_of, t.merge_of, t.session_id, t.sort_order, t.created_at, t.started_at, t.finished_at, t.updated_at, t.terminal_cols, t.terminal_rows`

// taskColsBrief 列表列（看板/历史/项目页用）：body 截断到 400 字符，
// 避免大提示词把列表接口载荷撑爆。列序与 taskCols 完全一致（scanTask 共用）。
const taskColsBrief = `t.id, t.title, substr(t.body,1,400) AS body, t.status, t.perm, t.run_mode, t.concurrent, t.agent_id, COALESCE(a.name, ''),
	t.project_id, COALESCE(p.name, ''), t.project_dir, t.parent_id, t.depends_on, t.dependency_mode, t.block_on_failure, t.schedule_id, t.error, t.exit_code,
	t.review_note, t.review_rounds, t.tmux_log_offset, t.worktree_branch, t.base_commit, t.resume_of, t.merge_of, t.session_id, t.sort_order, t.created_at, t.started_at, t.finished_at, t.updated_at, t.terminal_cols, t.terminal_rows`

func scanTask(rows scanner) (Task, error) {
	var tk Task
	var agentID, projectID, parentID, dependsOn, scheduleID, exitCode sql.NullInt64
	var agentName, projectName string
	var concurrent, blockOnFailure int64
	var started, finished sql.NullString
	var resumeOf, mergeOf, sessionID sql.NullInt64
	err := rows.Scan(&tk.ID, &tk.Title, &tk.Body, &tk.Status, &tk.Perm, &tk.RunMode, &concurrent, &agentID, &agentName,
		&projectID, &projectName, &tk.ProjectDir, &parentID, &dependsOn, &tk.DependencyMode, &blockOnFailure, &scheduleID, &tk.Error, &exitCode,
		&tk.ReviewNote, &tk.ReviewRounds, &tk.TmuxLogOffset, &tk.WorktreeBranch, &tk.BaseCommit, &resumeOf, &mergeOf, &sessionID, &tk.SortOrder, &tk.CreatedAt, &started, &finished, &tk.UpdatedAt, &tk.TerminalCols, &tk.TerminalRows)
	if err != nil {
		return tk, err
	}
	if tk.RunMode == "" {
		tk.RunMode = RunModeBatch
	}
	if tk.DependencyMode == "" {
		tk.DependencyMode = DependencyNone
	}
	tk.Concurrent = concurrent != 0
	tk.BlockOnFailure = blockOnFailure != 0
	if agentID.Valid {
		tk.AgentID = &agentID.Int64
	}
	tk.AgentName = agentName
	if projectID.Valid {
		tk.ProjectID = &projectID.Int64
	}
	if resumeOf.Valid {
		tk.ResumeOf = &resumeOf.Int64
	}
	if mergeOf.Valid {
		tk.MergeOf = &mergeOf.Int64
	}
	if sessionID.Valid {
		tk.SessionID = &sessionID.Int64
	}
	tk.ProjectName = projectName
	if parentID.Valid {
		tk.ParentID = &parentID.Int64
	}
	if dependsOn.Valid {
		tk.DependsOn = &dependsOn.Int64
	}
	if scheduleID.Valid {
		tk.ScheduleID = &scheduleID.Int64
	}
	if exitCode.Valid {
		code := int(exitCode.Int64)
		tk.ExitCode = &code
	}
	tk.StartedAt = strPtr(started)
	tk.FinishedAt = strPtr(finished)
	return tk, nil
}

const taskFrom = " FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id LEFT JOIN projects p ON p.id=t.project_id"

func (s *Store) ListTasks() ([]Task, error) {
	return s.ListTasksFiltered(TaskFilter{})
}

// TaskFilter 任务列表筛选条件（全部可空 = 不过滤）。
type TaskFilter struct {
	AgentID   *int64
	ProjectID *int64
	Status    string
	Limit     int
}

func (s *Store) ListTasksFiltered(f TaskFilter) ([]Task, error) {
	q := "SELECT " + taskColsBrief + taskFrom + " WHERE 1=1"
	args := []any{}
	if f.AgentID != nil {
		q += " AND t.agent_id=?"
		args = append(args, *f.AgentID)
	}
	if f.ProjectID != nil {
		q += " AND t.project_id=?"
		args = append(args, *f.ProjectID)
	}
	if f.Status != "" {
		q += " AND t.status=?"
		args = append(args, f.Status)
	}
	if f.ProjectID != nil {
		// 项目详情按执行顺序展示；合并任务排在实现任务之后的独立分组中，
		// 但这里仍保持稳定顺序，避免刷新时任务行跳动。
		q += " ORDER BY CASE WHEN t.merge_of IS NOT NULL THEN 1 ELSE 0 END, t.sort_order, t.created_at, t.id"
	} else {
		q += " ORDER BY t.created_at DESC, t.id DESC"
	}
	if f.Limit > 0 {
		q += " LIMIT ?"
		args = append(args, f.Limit)
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tk)
	}
	return out, rows.Err()
}

// ListQueuedTasks 返回可派发的排队任务：已指派角色且角色处于启用状态
// （停用角色不再接收新任务，队列中的任务保持 queued 等待重新启用）。
func (s *Store) ListQueuedTasks() ([]Task, error) {
	// 合并子任务属于其源任务的交付链，必须先于已排队的后续实现任务；否则
	// 后项会从尚未写入源代码的主分支建立 worktree。
	rows, err := s.db.Query("SELECT " + taskColsBrief + taskFrom + " WHERE t.status='queued' AND t.agent_id IS NOT NULL AND a.enabled=1 ORDER BY CASE WHEN t.merge_of IS NOT NULL THEN 0 ELSE 1 END, t.created_at, t.id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tk)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Keep the existing global creation-time order across projects, while
	// honoring a custom order whenever two implementation tasks belong to the
	// same project. Merge tasks are always ahead of every implementation task.
	sort.SliceStable(out, func(i, j int) bool { return queuedTaskLess(out[i], out[j]) })
	return out, nil
}

func queuedTaskLess(a, b Task) bool {
	aMerge := a.MergeOf != nil
	bMerge := b.MergeOf != nil
	if aMerge != bMerge {
		return aMerge
	}
	if a.ProjectID != nil && b.ProjectID != nil && *a.ProjectID == *b.ProjectID {
		if a.SortOrder != b.SortOrder {
			return a.SortOrder < b.SortOrder
		}
	}
	if a.CreatedAt != b.CreatedAt {
		return a.CreatedAt < b.CreatedAt
	}
	return a.ID < b.ID
}

// ListRunningTasks 返回卡在执行态的任务（服务重启时用于重置）。
// 注意：awaiting_review 不在此列——它已执行完、只等审批，重启后仍应保持待审批。
func (s *Store) ListRunningTasks() ([]Task, error) {
	rows, err := s.db.Query("SELECT " + taskColsBrief + taskFrom + " WHERE t.status IN ('running','claimed')")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tk)
	}
	return out, rows.Err()
}

func (s *Store) GetTask(id int64) (*Task, error) {
	row := s.db.QueryRow("SELECT "+taskCols+taskFrom+" WHERE t.id=?", id)
	tk, err := scanTask(row)
	if err != nil {
		return nil, err
	}
	return &tk, nil
}

// boolInt 把任务并发开关收敛为 SQLite 可存整数。
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func validDependencyMode(mode string) bool {
	return mode == DependencyNone || mode == DependencyWeak || mode == DependencyStrong
}

func normalizeDependencyMode(t *Task) {
	if t.DependencyMode == "" {
		if t.DependsOn != nil {
			t.DependencyMode = DependencyStrong
		} else {
			t.DependencyMode = DependencyNone
		}
	}
}

type sqlExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func prepareTaskForInsert(t *Task) {
	if t.CreatedAt == "" {
		t.CreatedAt = Now()
	}
	if t.UpdatedAt == "" {
		t.UpdatedAt = t.CreatedAt
	}
	if t.RunMode == "" {
		t.RunMode = RunModeBatch
	}
	normalizeDependencyMode(t)
}

func insertTask(execer sqlExecer, t Task) (int64, error) {
	res, err := execer.Exec(`INSERT INTO tasks (title, body, status, perm, run_mode, concurrent, agent_id, project_id, project_dir, parent_id, depends_on, dependency_mode, block_on_failure, schedule_id, resume_of, merge_of, session_id, worktree_branch, base_commit, sort_order, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.Title, t.Body, t.Status, t.Perm, t.RunMode, boolInt(t.Concurrent), nullInt64(t.AgentID), nullInt64(t.ProjectID), t.ProjectDir,
		nullInt64(t.ParentID), nullInt64(t.DependsOn), t.DependencyMode, boolInt(t.BlockOnFailure), nullInt64(t.ScheduleID), nullInt64(t.ResumeOf), nullInt64(t.MergeOf), nullInt64(t.SessionID), t.WorktreeBranch, t.BaseCommit, t.SortOrder, t.CreatedAt, t.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// assignNextTaskSortOrder appends a new implementation task to its project's
// current order.  A zero value is reserved for tasks without a project and
// system-created merge tasks, which are ordered by their separate priority.
func assignNextTaskSortOrder(tx *sql.Tx, t *Task) error {
	if t.ProjectID == nil || t.MergeOf != nil || t.SortOrder > 0 {
		return nil
	}
	var next int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(sort_order), 0) + 1
		FROM tasks WHERE project_id=? AND merge_of IS NULL`, *t.ProjectID).Scan(&next); err != nil {
		return err
	}
	if next < 1 {
		next = 1
	}
	t.SortOrder = next
	return nil
}

func (s *Store) CreateTask(t Task) (int64, error) {
	prepareTaskForInsert(&t)
	if t.ProjectID == nil || t.MergeOf != nil || t.SortOrder > 0 {
		return insertTask(s.db, t)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err := assignNextTaskSortOrder(tx, &t); err != nil {
		return 0, err
	}
	id, err := insertTask(tx, t)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

// CreateTaskWithProjectDependency 创建用户或定时任务，并在同一事务中确定前置
// 交付。weak 会按创建时间选取同项目上一条实现任务；strong 只接受用户指定的
// 前置实现任务；none 表示独立执行。合并子任务永远不进入用户依赖链。
func (s *Store) CreateTaskWithProjectDependency(t Task) (int64, error) {
	// 此入口代表面向调度的“新普通任务”。调用方没有指定模式时，项目
	// 任务必须默认进入创建时间弱依赖链；保留 CreateTask 的原始语义，
	// 以便恢复、测试和历史导入能按需直接构造记录。
	if t.MergeOf == nil && t.ProjectID != nil && t.DependencyMode == "" && t.DependsOn == nil {
		t.DependencyMode = DependencyWeak
	}
	prepareTaskForInsert(&t)
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err := assignNextTaskSortOrder(tx, &t); err != nil {
		return 0, err
	}
	if err := resolveNewTaskDependency(tx, &t); err != nil {
		return 0, err
	}
	id, err := insertTask(tx, t)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

func resolveNewTaskDependency(tx *sql.Tx, t *Task) error {
	if t.MergeOf != nil {
		t.DependsOn = nil
		t.DependencyMode = DependencyNone
		return nil
	}
	normalizeDependencyMode(t)
	if !validDependencyMode(t.DependencyMode) {
		return errors.New("非法依赖模式")
	}
	if t.ProjectID == nil {
		if t.DependsOn != nil || t.DependencyMode != DependencyNone {
			return errors.New("只有项目任务可以设置前置依赖")
		}
		return nil
	}
	switch t.DependencyMode {
	case DependencyNone:
		t.DependsOn = nil
		return nil
	case DependencyStrong:
		if t.DependsOn == nil {
			return errors.New("明确依赖必须指定前置任务")
		}
		return validateDependencyTarget(tx, *t.ProjectID, *t.DependsOn)
	case DependencyWeak:
		// 弱依赖由系统根据项目执行顺序决定，不能被客户端伪造为任意目标。
		t.DependsOn = nil
		var predecessor int64
		err := tx.QueryRow(`SELECT id FROM tasks
			WHERE project_id=? AND merge_of IS NULL
			ORDER BY sort_order DESC, created_at DESC, id DESC LIMIT 1`, *t.ProjectID).Scan(&predecessor)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		t.DependsOn = &predecessor
		return nil
	}
	return errors.New("非法依赖模式")
}

func validateDependencyTarget(tx *sql.Tx, projectID, dependencyID int64) error {
	if dependencyID <= 0 {
		return errors.New("前置任务 ID 非法")
	}
	var dependencyProject, mergeOf sql.NullInt64
	err := tx.QueryRow("SELECT project_id, merge_of FROM tasks WHERE id=?", dependencyID).Scan(&dependencyProject, &mergeOf)
	if err == sql.ErrNoRows {
		return errors.New("前置任务不存在")
	}
	if err != nil {
		return err
	}
	if mergeOf.Valid {
		return errors.New("前置任务必须是实现任务，不能直接依赖代码合并任务")
	}
	if !dependencyProject.Valid || dependencyProject.Int64 != projectID {
		return errors.New("前置任务必须属于同一项目")
	}
	return nil
}

// CompleteTaskAndCreateMerge 原子地完成一个普通任务并创建唯一的代码合并
// 子任务。条件更新确保重试、重复回调或已取消任务不会派发重复合并任务。
func (s *Store) CompleteTaskAndCreateMerge(sourceID int64, merge Task) (int64, error) {
	prepareMergeTask(sourceID, &merge)
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	now := Now()
	res, err := tx.Exec(`UPDATE tasks
		SET status='succeeded', finished_at=?, exit_code=0, error='', updated_at=?
		WHERE id=? AND status IN ('claimed','running') AND perm='full' AND merge_of IS NULL`, now, now, sourceID)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return 0, errors.New("任务已完成、已取消，或已创建代码合并任务")
	}
	if err := inheritMergeFailurePolicy(tx, sourceID, &merge); err != nil {
		return 0, err
	}
	mergeID, err := insertMergeTask(tx, merge)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return mergeID, nil
}

// RecoverLostTaskAndCreateMerge 是 CompleteTaskAndCreateMerge 的故障恢复变体。
// 调用方必须已经从该任务自己的运行归档中验证 agent-exit-code=0；这里再以
// failed/-1 条件更新和同一事务内的合并任务创建，确保重复扫描不会产生重复合并。
func (s *Store) RecoverLostTaskAndCreateMerge(sourceID int64, merge Task) (int64, error) {
	prepareMergeTask(sourceID, &merge)
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	now := Now()
	res, err := tx.Exec(`UPDATE tasks
		SET status='succeeded', finished_at=COALESCE(finished_at, ?), exit_code=0, error='', updated_at=?
		WHERE id=? AND status='failed' AND exit_code=-1 AND perm='full' AND merge_of IS NULL`, now, now, sourceID)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return 0, errors.New("任务不再是可恢复的 pane 丢失失败")
	}
	if err := inheritMergeFailurePolicy(tx, sourceID, &merge); err != nil {
		return 0, err
	}
	mergeID, err := insertMergeTask(tx, merge)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return mergeID, nil
}

// RecoverLostTask 恢复已从自身归档验证成功、但被旧执行器记为 failed/-1 的
// 无需合并任务。target 只允许 succeeded 或 awaiting_review，避免它成为绕过
// 正常状态机的通用失败任务修改入口。
func (s *Store) RecoverLostTask(sourceID int64, target string) (bool, error) {
	if target != StatusSucceeded && target != StatusAwaitingReview {
		return false, errors.New("非法恢复目标状态")
	}
	now := Now()
	query := `UPDATE tasks
		SET status=?, finished_at=COALESCE(finished_at, ?), exit_code=0, error='', updated_at=?
		WHERE id=? AND status='failed' AND exit_code=-1 AND merge_of IS NULL`
	args := []any{target, now, now, sourceID}
	if target == StatusAwaitingReview {
		query = `UPDATE tasks
			SET status=?, finished_at=COALESCE(finished_at, ?), exit_code=0, error='',
				review_rounds=review_rounds+1, updated_at=?
			WHERE id=? AND status='failed' AND exit_code=-1 AND perm='review' AND merge_of IS NULL`
	}
	res, err := s.db.Exec(query, args...)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// ApproveTaskAndCreateMerge 原子完成 review 审批并创建唯一的合并任务。
// 条件更新保证重复点击或并发请求不会生成两个合并任务。
func (s *Store) ApproveTaskAndCreateMerge(sourceID int64, merge Task) (int64, error) {
	prepareMergeTask(sourceID, &merge)
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	now := Now()
	res, err := tx.Exec(`UPDATE tasks
		SET status='succeeded', finished_at=COALESCE(finished_at, ?), exit_code=COALESCE(exit_code, 0), updated_at=?
		WHERE id=? AND status='awaiting_review' AND perm='review'`, now, now, sourceID)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return 0, errors.New("任务已审批或当前不在待审批状态")
	}
	if err := inheritMergeFailurePolicy(tx, sourceID, &merge); err != nil {
		return 0, err
	}
	id, err := insertMergeTask(tx, merge)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

func prepareMergeTask(sourceID int64, merge *Task) {
	// 合并任务是系统内部状态机的一部分：固定关联到源任务、串行 batch
	// 执行、完整权限。这样即使未来新增调用方，也不会创建会再次审批或
	// 失去来源关系的任务。
	merge.ParentID = &sourceID
	merge.MergeOf = &sourceID
	merge.Status = StatusQueued
	merge.Perm = PermFull
	merge.RunMode = RunModeBatch
	merge.Concurrent = false
	merge.DependsOn = nil
	merge.DependencyMode = DependencyNone
	merge.ScheduleID = nil
	merge.ResumeOf = nil
	if merge.CreatedAt == "" {
		merge.CreatedAt = Now()
	}
	if merge.UpdatedAt == "" {
		merge.UpdatedAt = merge.CreatedAt
	}
}

// inheritMergeFailurePolicy 让合并子任务从数据库中的源任务继承失败阻塞
// 策略。不能只信任调用方传入的 Task 快照：用户可能恰好在源任务完成与创建
// 合并任务之间修改了该开关，而后续弱依赖应始终以源任务的最终策略为准。
func inheritMergeFailurePolicy(tx *sql.Tx, sourceID int64, merge *Task) error {
	var block int64
	if err := tx.QueryRow("SELECT block_on_failure FROM tasks WHERE id=?", sourceID).Scan(&block); err != nil {
		return err
	}
	merge.BlockOnFailure = block != 0
	return nil
}

func insertMergeTask(tx *sql.Tx, merge Task) (int64, error) {
	res, err := tx.Exec(`INSERT INTO tasks
		(title, body, status, perm, run_mode, concurrent, agent_id, project_id, project_dir, parent_id, depends_on, dependency_mode, block_on_failure, schedule_id, resume_of, merge_of, session_id, sort_order, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		merge.Title, merge.Body, merge.Status, merge.Perm, merge.RunMode, boolInt(merge.Concurrent), nullInt64(merge.AgentID), nullInt64(merge.ProjectID), merge.ProjectDir,
		nullInt64(merge.ParentID), nullInt64(merge.DependsOn), merge.DependencyMode, boolInt(merge.BlockOnFailure), nullInt64(merge.ScheduleID), nullInt64(merge.ResumeOf), nullInt64(merge.MergeOf), nullInt64(merge.SessionID), merge.SortOrder, merge.CreatedAt, merge.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateTask(id int64, set map[string]any) error {
	projectValue, changesProject := set["project_id"]
	if !changesProject {
		return updateOne(s.db, "tasks", id, set)
	}

	var targetProject sql.NullInt64
	switch v := projectValue.(type) {
	case nil:
	case int64:
		if v <= 0 {
			return errors.New("project_id 非法")
		}
		targetProject = sql.NullInt64{Int64: v, Valid: true}
	case int:
		if v <= 0 {
			return errors.New("project_id 非法")
		}
		targetProject = sql.NullInt64{Int64: int64(v), Valid: true}
	default:
		return errors.New("project_id 非法")
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var currentProject, mergeOf sql.NullInt64
	var currentSortOrder int64
	if err := tx.QueryRow("SELECT project_id, merge_of, sort_order FROM tasks WHERE id=?", id).
		Scan(&currentProject, &mergeOf, &currentSortOrder); err != nil {
		return err
	}

	updated := make(map[string]any, len(set)+1)
	for key, value := range set {
		updated[key] = value
	}
	sameProject := currentProject.Valid == targetProject.Valid &&
		(!currentProject.Valid || currentProject.Int64 == targetProject.Int64)
	if !targetProject.Valid || mergeOf.Valid {
		updated["sort_order"] = int64(0)
	} else if !sameProject || currentSortOrder <= 0 {
		var next int64
		if err := tx.QueryRow(`SELECT COALESCE(MAX(sort_order), 0) + 1
			FROM tasks WHERE project_id=? AND merge_of IS NULL`, targetProject.Int64).Scan(&next); err != nil {
			return err
		}
		if next < 1 {
			next = 1
		}
		updated["sort_order"] = next
	}
	if err := updateOneExecer(tx, "tasks", id, updated); err != nil {
		return err
	}
	return tx.Commit()
}

// ReorderProjectTasks changes only queued implementation tasks in one project.
// Their existing order slots are reused so completed/running tasks stay in
// their historical positions.  The caller must provide every currently queued
// implementation task exactly once; this makes stale drag-and-drop requests
// fail safely instead of silently losing a task from the order.
func (s *Store) ReorderProjectTasks(projectID int64, orderedIDs []int64) error {
	if projectID <= 0 {
		return errors.New("项目 ID 非法")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists bool
	if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)", projectID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errors.New("项目不存在")
	}

	type reorderTask struct {
		id             int64
		status         string
		dependencyMode string
		sortOrder      int64
	}
	rows, err := tx.Query(`SELECT id, status, dependency_mode, sort_order
		FROM tasks
		WHERE project_id=? AND merge_of IS NULL
		ORDER BY CASE WHEN sort_order > 0 THEN sort_order ELSE 9223372036854775807 END,
			created_at, id`, projectID)
	if err != nil {
		return err
	}
	all := make([]reorderTask, 0)
	for rows.Next() {
		var tk reorderTask
		if err := rows.Scan(&tk.id, &tk.status, &tk.dependencyMode, &tk.sortOrder); err != nil {
			rows.Close()
			return err
		}
		all = append(all, tk)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}

	eligible := make(map[int64]bool)
	positions := make([]int64, 0)
	for i, tk := range all {
		if tk.status != StatusQueued {
			continue
		}
		eligible[tk.id] = true
		position := tk.sortOrder
		if position <= 0 {
			position = int64(i + 1)
		}
		positions = append(positions, position)
	}
	if len(orderedIDs) != len(eligible) {
		return errors.New("排序请求必须包含项目内全部待执行的实现任务")
	}
	seen := make(map[int64]bool, len(orderedIDs))
	for _, id := range orderedIDs {
		if !eligible[id] || seen[id] {
			return errors.New("排序请求只能包含不重复的待执行实现任务")
		}
		seen[id] = true
	}
	now := Now()
	for i, id := range orderedIDs {
		if _, err := tx.Exec(`UPDATE tasks SET sort_order=?, updated_at=?
			WHERE id=? AND project_id=? AND merge_of IS NULL AND status=?`, positions[i], now, id, projectID, StatusQueued); err != nil {
			return err
		}
	}
	if err := rebuildQueuedWeakDependencies(tx, projectID, now); err != nil {
		return err
	}
	if err := validateProjectDependencyGraph(tx, projectID); err != nil {
		return err
	}
	return tx.Commit()
}

// rebuildQueuedWeakDependencies keeps the persisted weak-dependency chain in
// step with the visible project order. Strong and independent dependencies are
// user choices and are left untouched. Merge tasks are intentionally excluded.
func rebuildQueuedWeakDependencies(tx *sql.Tx, projectID int64, now string) error {
	rows, err := tx.Query(`SELECT id, status, dependency_mode
		FROM tasks
		WHERE project_id=? AND merge_of IS NULL
		ORDER BY CASE WHEN sort_order > 0 THEN sort_order ELSE 9223372036854775807 END,
			created_at, id`, projectID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var predecessor *int64
	for rows.Next() {
		var id int64
		var status, mode string
		if err := rows.Scan(&id, &status, &mode); err != nil {
			return err
		}
		if status == StatusQueued && mode == DependencyWeak {
			var dependsOn any
			if predecessor != nil {
				dependsOn = *predecessor
			}
			if _, err := tx.Exec(`UPDATE tasks SET depends_on=?, updated_at=?
				WHERE id=? AND project_id=? AND merge_of IS NULL AND status=? AND dependency_mode=?`,
				dependsOn, now, id, projectID, StatusQueued, DependencyWeak); err != nil {
				return err
			}
		}
		current := id
		predecessor = &current
	}
	return rows.Err()
}

func validateProjectDependencyGraph(tx *sql.Tx, projectID int64) error {
	rows, err := tx.Query(`SELECT id, depends_on FROM tasks
		WHERE project_id=? AND merge_of IS NULL`, projectID)
	if err != nil {
		return err
	}
	defer rows.Close()
	dependencies := make(map[int64]int64)
	for rows.Next() {
		var id int64
		var dependsOn sql.NullInt64
		if err := rows.Scan(&id, &dependsOn); err != nil {
			return err
		}
		if dependsOn.Valid {
			dependencies[id] = dependsOn.Int64
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	state := make(map[int64]uint8, len(dependencies))
	var visit func(int64) bool
	visit = func(id int64) bool {
		switch state[id] {
		case 1:
			return false
		case 2:
			return true
		}
		state[id] = 1
		if next, ok := dependencies[id]; ok && !visit(next) {
			return false
		}
		state[id] = 2
		return true
	}
	for id := range dependencies {
		if !visit(id) {
			return errors.New("排序请求会形成循环依赖")
		}
	}
	return nil
}

// ResumeTask 原地续跑一个终态任务。任务身份、会话目录和 worktree 都由任务
// ID 绑定，因此不能新建记录；这里只清空本轮执行痕迹并原子地放回队列。
// 返回 false 表示任务已不处于可续跑的终态（例如被另一个请求重新领取）。
func (s *Store) ResumeTask(id int64) (bool, error) {
	now := Now()
	res, err := s.db.Exec(`UPDATE tasks
		SET status='queued', started_at=NULL, finished_at=NULL, error='', exit_code=NULL,
			tmux_log_offset=0, updated_at=?
		WHERE id=? AND status IN ('succeeded','failed','cancelled')`, now, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// HasMergeTaskForSource 返回某个普通任务是否已有系统创建的代码合并任务。
// 合并任务通过 merge_of 直接关联源任务，不依赖普通子任务树。
func (s *Store) HasMergeTaskForSource(sourceID int64) (bool, error) {
	var exists bool
	if err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM tasks WHERE merge_of=?)`, sourceID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

// GetMergeTaskForSource 读取一个实现任务对应的唯一代码合并子任务。
func (s *Store) GetMergeTaskForSource(sourceID int64) (*Task, error) {
	row := s.db.QueryRow("SELECT "+taskCols+taskFrom+" WHERE t.merge_of=?", sourceID)
	tk, err := scanTask(row)
	if err != nil {
		return nil, err
	}
	return &tk, nil
}

// TaskDependencyError 表示任务仍被明确的强依赖引用。弱依赖在删除时会被
// 自动解除；强依赖则必须由调用方先处理，避免删除前置任务后让后项提前执行。
type TaskDependencyError struct {
	DependentID int64
	SourceID    int64
}

func (e *TaskDependencyError) Error() string {
	return fmt.Sprintf("任务 #%d 仍以前置任务 #%d 为强依赖", e.DependentID, e.SourceID)
}

// FirstTaskDependent 返回直接把 sourceID 作为前置任务的第一条任务。
func (s *Store) FirstTaskDependent(sourceID int64) (*Task, error) {
	row := s.db.QueryRow("SELECT "+taskCols+taskFrom+" WHERE t.depends_on=? ORDER BY t.created_at, t.id LIMIT 1", sourceID)
	tk, err := scanTask(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &tk, nil
}

// ListTaskDependents 返回直接引用 sourceID 的任务。删除流程用它区分可以
// 自动解除的弱依赖和必须显式处理的强依赖。
func (s *Store) ListTaskDependents(sourceID int64) ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskCols+taskFrom+" WHERE t.depends_on=? ORDER BY t.created_at, t.id", sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	dependents := make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		dependents = append(dependents, tk)
	}
	return dependents, rows.Err()
}

type deliveryState int

const (
	deliveryPending deliveryState = iota
	deliverySucceeded
	deliveryFailed
)

// DependencyCheck 是调度器的唯一依赖判定接口。Ready=false 时 Reason 可直接
// 用于日志或界面；Skipped=true 表示弱依赖碰到非阻塞失败，后项可继续执行。
type DependencyCheck struct {
	Ready   bool
	Skipped bool
	Reason  string
}

// CheckTaskDependency 判断任务的前置交付是否已经满足。强依赖只接受成功；
// 弱依赖在前置失败且前置未勾选“失败时阻塞”时，把该交付视为已跳过。
func (s *Store) CheckTaskDependency(t Task) (DependencyCheck, error) {
	if t.MergeOf != nil || t.DependsOn == nil || t.DependencyMode == DependencyNone || t.DependencyMode == "" {
		return DependencyCheck{Ready: true}, nil
	}
	if t.DependencyMode != DependencyWeak && t.DependencyMode != DependencyStrong {
		return DependencyCheck{Reason: "依赖模式非法"}, nil
	}
	dependency, err := s.GetTask(*t.DependsOn)
	if err == sql.ErrNoRows {
		if t.DependencyMode == DependencyWeak {
			return DependencyCheck{Ready: true, Skipped: true, Reason: fmt.Sprintf("前序任务 #%d 已删除，已跳过", *t.DependsOn)}, nil
		}
		return DependencyCheck{Reason: fmt.Sprintf("明确依赖的任务 #%d 已删除", *t.DependsOn)}, nil
	}
	if err != nil {
		return DependencyCheck{}, err
	}
	state, reason, err := s.deliveryStateOf(*dependency)
	if err != nil {
		return DependencyCheck{}, err
	}
	switch t.DependencyMode {
	case DependencyStrong:
		if state == deliverySucceeded {
			return DependencyCheck{Ready: true}, nil
		}
		return DependencyCheck{Reason: "明确依赖未完成：" + reason}, nil
	case DependencyWeak:
		switch state {
		case deliverySucceeded:
			return DependencyCheck{Ready: true}, nil
		case deliveryFailed:
			if dependency.BlockOnFailure {
				return DependencyCheck{Reason: "前序阻塞任务未完成：" + reason}, nil
			}
			return DependencyCheck{Ready: true, Skipped: true, Reason: "前序任务失败，已跳过：" + reason}, nil
		default:
			return DependencyCheck{Reason: "等待前序交付：" + reason}, nil
		}
	}
	return DependencyCheck{Reason: "依赖模式非法"}, nil
}

func (s *Store) deliveryStateOf(source Task) (deliveryState, string, error) {
	if source.MergeOf != nil {
		return deliveryFailed, fmt.Sprintf("任务 #%d 不是实现任务", source.ID), nil
	}
	switch source.Status {
	case StatusQueued, StatusClaimed, StatusRunning:
		return deliveryPending, fmt.Sprintf("任务 #%d 正在执行", source.ID), nil
	case StatusAwaitingReview:
		return deliveryPending, fmt.Sprintf("任务 #%d 等待审批", source.ID), nil
	case StatusFailed:
		return deliveryFailed, fmt.Sprintf("任务 #%d 执行失败", source.ID), nil
	case StatusCancelled:
		return deliveryFailed, fmt.Sprintf("任务 #%d 已取消", source.ID), nil
	case StatusSucceeded:
		merge, err := s.GetMergeTaskForSource(source.ID)
		if err == sql.ErrNoRows {
			if source.WorktreeBranch != "" {
				return deliveryPending, fmt.Sprintf("任务 #%d 正在创建代码合并任务", source.ID), nil
			}
			return deliverySucceeded, fmt.Sprintf("任务 #%d 已完成", source.ID), nil
		}
		if err != nil {
			return deliveryPending, "读取代码合并任务失败", err
		}
		switch merge.Status {
		case StatusSucceeded:
			return deliverySucceeded, fmt.Sprintf("合并任务 #%d 已完成", merge.ID), nil
		case StatusFailed:
			return deliveryFailed, fmt.Sprintf("合并任务 #%d 失败", merge.ID), nil
		case StatusCancelled:
			return deliveryFailed, fmt.Sprintf("合并任务 #%d 已取消", merge.ID), nil
		default:
			return deliveryPending, fmt.Sprintf("合并任务 #%d 正在处理", merge.ID), nil
		}
	default:
		return deliveryPending, fmt.Sprintf("任务 #%d 状态未知", source.ID), nil
	}
}

// ListCompletedGitTasksWithoutMerge 返回已经完成、拥有 Git worktree、但还
// 没有代码合并子任务的源任务。它是自动合并链路的持久化对账输入：即使进程
// 在「保存源分支」和「插入合并任务」之间发生异常，下一次执行器启动或周期
// 扫描仍会补上唯一的合并任务。
func (s *Store) ListCompletedGitTasksWithoutMerge() ([]Task, error) {
	rows, err := s.db.Query(`SELECT `+taskCols+taskFrom+`
		WHERE t.status=?
		  AND t.merge_of IS NULL
		  AND t.worktree_branch<>''
		  AND NOT EXISTS (SELECT 1 FROM tasks m WHERE m.merge_of=t.id)
		ORDER BY t.created_at, t.id`, StatusSucceeded)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tk)
	}
	return out, rows.Err()
}

// EnsureMergeTask 为已完成的 Git 源任务创建其唯一的代码合并子任务。若另一
// 条正常结算/恢复路径已经创建过子任务，则返回其 ID 和 created=false；因此该
// 方法可安全地由启动恢复、周期对账和故障兜底重复调用。
func (s *Store) EnsureMergeTask(source Task) (id int64, created bool, err error) {
	if source.ID <= 0 {
		return 0, false, errors.New("源任务 ID 非法")
	}
	merge := NewMergeTask(source)
	prepareMergeTask(source.ID, &merge)

	tx, err := s.db.Begin()
	if err != nil {
		return 0, false, err
	}
	defer tx.Rollback()

	// 先读取已有子任务。merge_of 的唯一索引是最终约束，这里则让对账调用
	// 成为无副作用的幂等操作。
	var existing int64
	err = tx.QueryRow(`SELECT id FROM tasks WHERE merge_of=?`, source.ID).Scan(&existing)
	if err == nil {
		if err := tx.Commit(); err != nil {
			return 0, false, err
		}
		return existing, false, nil
	}
	if err != sql.ErrNoRows {
		return 0, false, err
	}

	// 只允许仍处于「完成的非合并 Git 源任务」状态时补建，避免删除、取消或
	// 状态回退竞态把已放弃的任务重新派发。
	var eligible bool
	if err := tx.QueryRow(`SELECT EXISTS(
		SELECT 1 FROM tasks
		WHERE id=? AND status=? AND merge_of IS NULL AND worktree_branch<>''
	)`, source.ID, StatusSucceeded).Scan(&eligible); err != nil {
		return 0, false, err
	}
	if !eligible {
		return 0, false, errors.New("源任务当前不需要创建代码合并任务")
	}
	if err := inheritMergeFailurePolicy(tx, source.ID, &merge); err != nil {
		return 0, false, err
	}

	id, err = insertMergeTask(tx, merge)
	if err != nil {
		return 0, false, err
	}
	if err := tx.Commit(); err != nil {
		return 0, false, err
	}
	return id, true, nil
}

// MarkTaskSucceededAwaitingMerge 是正常执行已成功、源 worktree 也已快照，
// 但原子完成+创建合并任务事务暂时失败时的持久化兜底。它只留下一个短暂、可
// 被 ListCompletedGitTasksWithoutMerge 对账到的状态，绝不把成功的代码误记为
// 执行失败。
func (s *Store) MarkTaskSucceededAwaitingMerge(sourceID int64) (bool, error) {
	now := Now()
	res, err := s.db.Exec(`UPDATE tasks
		SET status='succeeded', finished_at=COALESCE(finished_at, ?), exit_code=0,
			error='', updated_at=?
		WHERE id=? AND status IN ('claimed','running') AND perm='full'
		  AND merge_of IS NULL AND worktree_branch<>''`, now, now, sourceID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// UpdateTmuxLogOffset 记录已同步到 SQLite 的专用 tmux 原始日志位置。
// 不更新 updated_at，避免高频终端输出扰动任务的业务更新时间。
func (s *Store) UpdateTmuxLogOffset(id int64, offset int64) error {
	_, err := s.db.Exec("UPDATE tasks SET tmux_log_offset=? WHERE id=?", offset, id)
	return err
}

// UpdateTerminalSize 记录交互任务终端最近一次同步到 tmux 窗口的尺寸。
// 任务结束后前端按此尺寸重放最后画面（缩放适配容器），而不是按浏览器
// 容器 fit 重排导致画面错位/大片留白。不更新 updated_at（同日志偏移）。
func (s *Store) UpdateTerminalSize(id int64, cols, rows int) error {
	_, err := s.db.Exec("UPDATE tasks SET terminal_cols=?, terminal_rows=? WHERE id=?", cols, rows, id)
	return err
}

// ClaimTask 原子领取：queued -> claimed，返回是否领取成功。
func (s *Store) ClaimTask(id int64) (bool, error) {
	res, err := s.db.Exec("UPDATE tasks SET status='claimed', started_at=? WHERE id=? AND status='queued'", Now(), id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// StartTask 原子开跑：claimed -> running。若返回 false 说明领取后任务已被
// 取消/删除（与派发存在竞态），调用方应放弃执行而不是覆盖终态。
func (s *Store) StartTask(id int64) (bool, error) {
	res, err := s.db.Exec("UPDATE tasks SET status='running', started_at=? WHERE id=? AND status='claimed'", Now(), id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

func (s *Store) DeleteTask(id int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	deleting := make(map[int64]bool)
	if err := collectTaskTreeIDs(tx, id, deleting); err != nil {
		return err
	}
	if len(deleting) == 0 {
		return sql.ErrNoRows
	}
	if err := unlinkTaskDependencies(tx, deleting); err != nil {
		return err
	}
	if err := deleteTaskTree(tx, id); err != nil {
		return err
	}
	return tx.Commit()
}

// collectTaskTreeIDs 收集级联删除的任务树。依赖关系不是父子关系，只有
// parent_id/merge_of 指向的任务才会随根任务一起删除。
func collectTaskTreeIDs(tx *sql.Tx, id int64, seen map[int64]bool) error {
	if seen[id] {
		return nil
	}
	var exists int
	if err := tx.QueryRow("SELECT 1 FROM tasks WHERE id=?", id).Scan(&exists); err == sql.ErrNoRows {
		return nil
	} else if err != nil {
		return err
	}
	seen[id] = true
	rows, err := tx.Query("SELECT id FROM tasks WHERE parent_id=? OR merge_of=? ORDER BY id", id, id)
	if err != nil {
		return err
	}
	children := make([]int64, 0)
	for rows.Next() {
		var childID int64
		if err := rows.Scan(&childID); err != nil {
			return err
		}
		children = append(children, childID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, childID := range children {
		if err := collectTaskTreeIDs(tx, childID, seen); err != nil {
			return err
		}
	}
	return nil
}

// dependencyReplacement 找到 sourceID 被删除后仍可保留的最近前置任务。
// 这样删除链中间的任务时，后续弱依赖仍会等待更早的任务，而不是被
// 意外变成可立即执行的独立任务。
func dependencyReplacement(tx *sql.Tx, sourceID int64, deleting map[int64]bool) (*int64, error) {
	seen := make(map[int64]bool)
	current := sourceID
	for {
		if seen[current] {
			return nil, nil
		}
		seen[current] = true
		var dependsOn sql.NullInt64
		var mode string
		err := tx.QueryRow("SELECT depends_on, dependency_mode FROM tasks WHERE id=?", current).Scan(&dependsOn, &mode)
		if err == sql.ErrNoRows {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if !dependsOn.Valid || mode == DependencyNone || mode == "" {
			return nil, nil
		}
		candidate := dependsOn.Int64
		if !deleting[candidate] {
			return &candidate, nil
		}
		current = candidate
	}
}

// unlinkTaskDependencies 在删除事务内解除外部任务对删除树的引用。弱依赖
// 可以安全跳过已删除前置；强依赖必须先由调用方处理。
func unlinkTaskDependencies(tx *sql.Tx, deleting map[int64]bool) error {
	now := Now()
	for sourceID := range deleting {
		rows, err := tx.Query("SELECT id, dependency_mode FROM tasks WHERE depends_on=?", sourceID)
		if err != nil {
			return err
		}
		dependents := make([]struct {
			id   int64
			mode string
		}, 0)
		for rows.Next() {
			var dependent struct {
				id   int64
				mode string
			}
			if err := rows.Scan(&dependent.id, &dependent.mode); err != nil {
				rows.Close()
				return err
			}
			dependents = append(dependents, dependent)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for _, dependent := range dependents {
			if deleting[dependent.id] {
				continue
			}
			if dependent.mode == DependencyStrong {
				return &TaskDependencyError{DependentID: dependent.id, SourceID: sourceID}
			}
			replacement, err := dependencyReplacement(tx, sourceID, deleting)
			if err != nil {
				return err
			}
			var value any
			if replacement != nil {
				value = *replacement
			}
			if _, err := tx.Exec("UPDATE tasks SET depends_on=?, updated_at=? WHERE id=?", value, now, dependent.id); err != nil {
				return err
			}
		}
	}
	return nil
}

// ListTaskDeletionOrder 返回删除 root 时须一并清理的任务，按叶子到根的
// 顺序排列。merge_of 也视为父子关系，兼容早期仅保存 merge_of 的数据。
func (s *Store) ListTaskDeletionOrder(rootID int64) ([]Task, error) {
	root, err := s.GetTask(rootID)
	if err == sql.ErrNoRows {
		return []Task{}, nil
	}
	if err != nil {
		return nil, err
	}
	seen := make(map[int64]bool)
	out := make([]Task, 0, 1)
	var visit func(Task) error
	visit = func(tk Task) error {
		if seen[tk.ID] {
			return nil
		}
		seen[tk.ID] = true
		children, err := s.listTaskDeletionChildren(tk.ID)
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := visit(child); err != nil {
				return err
			}
		}
		out = append(out, tk)
		return nil
	}
	if err := visit(*root); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) listTaskDeletionChildren(parentID int64) ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskCols+taskFrom+" WHERE t.parent_id=? OR t.merge_of=? ORDER BY t.created_at, t.id", parentID, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	children := make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		children = append(children, tk)
	}
	return children, rows.Err()
}

func deleteTaskTree(tx *sql.Tx, id int64) error {
	rows, err := tx.Query("SELECT id FROM tasks WHERE parent_id=? OR merge_of=? ORDER BY id", id, id)
	if err != nil {
		return err
	}
	children := make([]int64, 0)
	for rows.Next() {
		var childID int64
		if err := rows.Scan(&childID); err != nil {
			rows.Close()
			return err
		}
		children = append(children, childID)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, childID := range children {
		if err := deleteTaskTree(tx, childID); err != nil {
			return err
		}
	}
	res, err := tx.Exec("DELETE FROM tasks WHERE id=?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) HasTask(id int64) (bool, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE id=?", id).Scan(&n)
	return n > 0, err
}

// ListChildren 返回某任务的全部子任务（旧→新）。
func (s *Store) ListChildren(parentID int64) ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskCols+taskFrom+" WHERE t.parent_id=? ORDER BY t.created_at, t.id", parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tk)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// 任务日志

func (s *Store) AppendLog(l TaskLog) (TaskLog, error) {
	if l.CreatedAt == "" {
		l.CreatedAt = Now()
	}
	err := s.db.QueryRow(
		"SELECT COALESCE(MAX(seq),0)+1 FROM task_logs WHERE task_id=?", l.TaskID).Scan(&l.Seq)
	if err != nil {
		return l, err
	}
	res, err := s.db.Exec(`INSERT INTO task_logs (task_id, seq, stream, content, created_at) VALUES (?, ?, ?, ?, ?)`,
		l.TaskID, l.Seq, l.Stream, l.Content, l.CreatedAt)
	if err != nil {
		return l, err
	}
	l.ID, _ = res.LastInsertId()
	return l, nil
}

func (s *Store) ListLogs(taskID int64) ([]TaskLog, error) {
	rows, err := s.db.Query("SELECT id, task_id, seq, stream, content, created_at FROM task_logs WHERE task_id=? ORDER BY seq", taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]TaskLog, 0)
	for rows.Next() {
		var l TaskLog
		if err := rows.Scan(&l.ID, &l.TaskID, &l.Seq, &l.Stream, &l.Content, &l.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ListLogsPage 返回日志的一个窗口。默认从最新日志向前取，beforeSeq 不为零时
// 只取更早的记录；结果仍按 seq 正序返回，方便前端直接追加到终端顶部。
// 日志内容可能非常大，任务详情页不应为了打开一个任务把整张表读入内存。
func (s *Store) ListLogsPage(taskID, beforeSeq int64, limit int) (logs []TaskLog, hasMore bool, total int, err error) {
	const defaultLimit = 200
	const maxLimit = 500
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}

	if err = s.db.QueryRow("SELECT COUNT(*) FROM task_logs WHERE task_id=?", taskID).Scan(&total); err != nil {
		return nil, false, 0, err
	}

	const cols = "SELECT id, task_id, seq, stream, content, created_at FROM task_logs WHERE task_id=?"
	var rows *sql.Rows
	if beforeSeq > 0 {
		rows, err = s.db.Query(cols+" AND seq<? ORDER BY seq DESC LIMIT ?", taskID, beforeSeq, limit+1)
	} else {
		rows, err = s.db.Query(cols+" ORDER BY seq DESC LIMIT ?", taskID, limit+1)
	}
	if err != nil {
		return nil, false, 0, err
	}
	defer rows.Close()

	logs = make([]TaskLog, 0, limit)
	for rows.Next() {
		var l TaskLog
		if err = rows.Scan(&l.ID, &l.TaskID, &l.Seq, &l.Stream, &l.Content, &l.CreatedAt); err != nil {
			return nil, false, 0, err
		}
		logs = append(logs, l)
	}
	if err = rows.Err(); err != nil {
		return nil, false, 0, err
	}
	if len(logs) > limit {
		hasMore = true
		logs = logs[:limit]
	}
	for i, j := 0, len(logs)-1; i < j; i, j = i+1, j-1 {
		logs[i], logs[j] = logs[j], logs[i]
	}
	return logs, hasMore, total, nil
}

// ---------------------------------------------------------------------------
// 定时任务

const schedCols = `s.id, s.name, s.cron, s.title_template, s.body_template, s.agent_id, s.project_id,
	s.perm, s.block_on_failure, s.enabled, s.last_run_at, s.next_run_at, s.created_at, a.name, COALESCE(p.name, '')`

func (s *Store) ListSchedules() ([]Schedule, error) {
	rows, err := s.db.Query("SELECT " + schedCols + " FROM schedules s JOIN agents a ON a.id=s.agent_id LEFT JOIN projects p ON p.id=s.project_id ORDER BY s.id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Schedule, 0)
	for rows.Next() {
		var sc Schedule
		var projectID sql.NullInt64
		var lastRun, nextRun sql.NullString
		if err := rows.Scan(&sc.ID, &sc.Name, &sc.Cron, &sc.TitleTemplate, &sc.BodyTemplate,
			&sc.AgentID, &projectID, &sc.Perm, &sc.BlockOnFailure, &sc.Enabled, &lastRun, &nextRun, &sc.CreatedAt, &sc.AgentName, &sc.ProjectName); err != nil {
			return nil, err
		}
		if projectID.Valid {
			sc.ProjectID = &projectID.Int64
		}
		sc.LastRunAt = strPtr(lastRun)
		sc.NextRunAt = strPtr(nextRun)
		out = append(out, sc)
	}
	return out, rows.Err()
}

func (s *Store) GetSchedule(id int64) (*Schedule, error) {
	row := s.db.QueryRow("SELECT "+schedCols+" FROM schedules s JOIN agents a ON a.id=s.agent_id LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=?", id)
	var sc Schedule
	var projectID sql.NullInt64
	var lastRun, nextRun sql.NullString
	if err := row.Scan(&sc.ID, &sc.Name, &sc.Cron, &sc.TitleTemplate, &sc.BodyTemplate,
		&sc.AgentID, &projectID, &sc.Perm, &sc.BlockOnFailure, &sc.Enabled, &lastRun, &nextRun, &sc.CreatedAt, &sc.AgentName, &sc.ProjectName); err != nil {
		return nil, err
	}
	if projectID.Valid {
		sc.ProjectID = &projectID.Int64
	}
	sc.LastRunAt = strPtr(lastRun)
	sc.NextRunAt = strPtr(nextRun)
	return &sc, nil
}

func (s *Store) CreateSchedule(sc Schedule) (int64, error) {
	if sc.CreatedAt == "" {
		sc.CreatedAt = Now()
	}
	if sc.Perm == "" {
		sc.Perm = PermFull
	}
	res, err := s.db.Exec(`INSERT INTO schedules (name, cron, title_template, body_template, agent_id, project_id, perm, block_on_failure, enabled, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sc.Name, sc.Cron, sc.TitleTemplate, sc.BodyTemplate, sc.AgentID, nullInt64(sc.ProjectID), sc.Perm, boolInt(sc.BlockOnFailure), sc.Enabled, sc.CreatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateSchedule(id int64, set map[string]any) error {
	if len(set) == 0 {
		return nil
	}
	cols := make([]string, 0, len(set))
	vals := make([]any, 0, len(set)+1)
	for k, v := range set {
		cols = append(cols, k+"=?")
		vals = append(vals, v)
	}
	vals = append(vals, id)
	_, err := s.db.Exec(fmt.Sprintf("UPDATE schedules SET %s WHERE id=?", strings.Join(cols, ", ")), vals...)
	return err
}

func (s *Store) DeleteSchedule(id int64) error {
	_, err := s.db.Exec("DELETE FROM schedules WHERE id=?", id)
	return err
}

// ---------------------------------------------------------------------------
// 历史清理

// CleanupTasks 删除符合条件的任务（级联删除日志）。条件：
//   - agentID 非空：仅该角色的任务
//   - before 非空：仅早于该时间的任务
//
// 只删除终态任务（succeeded/failed/cancelled），进行中的任务不动。
func (s *Store) CleanupTasks(agentID *int64, before string) (int64, error) {
	// 保留仍被后项引用的记录。否则 SQLite 会拒绝删除，且更重要的是，
	// 清理不能把强依赖悄悄变成“无依赖即可执行”。下次清理会自然处理
	// 已没有后项引用的终态记录。
	q := "DELETE FROM tasks WHERE status IN ('succeeded','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM tasks d WHERE d.depends_on=tasks.id)"
	args := []any{}
	if agentID != nil {
		q += " AND agent_id=?"
		args = append(args, *agentID)
	}
	if before != "" {
		q += " AND created_at < ?"
		args = append(args, before)
	}
	res, err := s.db.Exec(q, args...)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ---------------------------------------------------------------------------
// 设置（key-value）

func (s *Store) GetSetting(key string) (string, error) {
	var v string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key=?", key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func (s *Store) AllSettings() (map[string]string, error) {
	rows, err := s.db.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// 任务模板（技能沉淀：从成功任务保存提示词复用）

type Template struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Body      string `json:"body"`
	AgentID   *int64 `json:"agent_id"`
	AgentName string `json:"agent_name,omitempty"`
	CreatedAt string `json:"created_at"`
}

func (s *Store) ListTemplates() ([]Template, error) {
	rows, err := s.db.Query(`SELECT t.id, t.name, t.body, t.agent_id, COALESCE(a.name,''), t.created_at
		FROM templates t LEFT JOIN agents a ON a.id=t.agent_id ORDER BY t.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Template, 0)
	for rows.Next() {
		var tpl Template
		var aid sql.NullInt64
		if err := rows.Scan(&tpl.ID, &tpl.Name, &tpl.Body, &aid, &tpl.AgentName, &tpl.CreatedAt); err != nil {
			return nil, err
		}
		if aid.Valid {
			tpl.AgentID = &aid.Int64
		}
		out = append(out, tpl)
	}
	return out, rows.Err()
}

func (s *Store) CreateTemplate(tpl Template) (int64, error) {
	if tpl.CreatedAt == "" {
		tpl.CreatedAt = Now()
	}
	res, err := s.db.Exec("INSERT INTO templates (name, body, agent_id, created_at) VALUES (?, ?, ?, ?)",
		tpl.Name, tpl.Body, nullInt64(tpl.AgentID), tpl.CreatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) DeleteTemplate(id int64) error {
	_, err := s.db.Exec("DELETE FROM templates WHERE id=?", id)
	return err
}

// ---------------------------------------------------------------------------
// 项目（projects）

const projectCols = "id, name, description, status, project_dir, created_at, updated_at"

func scanProject(rows scanner) (Project, error) {
	var p Project
	err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.Status, &p.ProjectDir, &p.CreatedAt, &p.UpdatedAt)
	return p, err
}

func (s *Store) ListProjects() ([]Project, error) {
	rows, err := s.db.Query("SELECT " + projectCols + " FROM projects ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Project, 0)
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetProject(id int64) (*Project, error) {
	row := s.db.QueryRow("SELECT "+projectCols+" FROM projects WHERE id=?", id)
	p, err := scanProject(row)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) CreateProject(p Project) (int64, error) {
	if p.CreatedAt == "" {
		p.CreatedAt = Now()
	}
	if p.UpdatedAt == "" {
		p.UpdatedAt = p.CreatedAt
	}
	if p.Status == "" {
		p.Status = "active"
	}
	res, err := s.db.Exec("INSERT INTO projects (name, description, status, project_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		p.Name, p.Description, p.Status, p.ProjectDir, p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateProject(id int64, set map[string]any) error {
	return updateOne(s.db, "projects", id, set)
}

// DeleteProject 删除项目；项目下任务改为「无项目」而非级联删除。
func (s *Store) DeleteProject(id int64) error {
	if _, err := s.db.Exec("UPDATE tasks SET project_id=NULL WHERE project_id=?", id); err != nil {
		return err
	}
	_, err := s.db.Exec("DELETE FROM projects WHERE id=?", id)
	return err
}

// ---------------------------------------------------------------------------
// 统计（维度二：项目进度 + agent 产出）

// statusCountsOf 按状态聚合计数。
func (s *Store) statusCountsOf(where string, args ...any) ([]StatusCount, int, error) {
	q := "SELECT status, COUNT(*) FROM tasks t WHERE " + where + " GROUP BY status"
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []StatusCount
	total := 0
	for rows.Next() {
		var sc StatusCount
		if err := rows.Scan(&sc.Status, &sc.Count); err != nil {
			return nil, 0, err
		}
		out = append(out, sc)
		total += sc.Count
	}
	return out, total, rows.Err()
}

// dailySucceeded 最近 n 天每日完成数（succeeded，按 UTC 日期分组）。
func (s *Store) dailySucceeded(where string, days int, args ...any) ([]DailyCount, error) {
	since := time.Now().UTC().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	rows, err := s.db.Query(
		"SELECT substr(t.finished_at,1,10) AS d, COUNT(*) FROM tasks t WHERE "+where+
			" AND t.status='succeeded' AND t.finished_at >= ? GROUP BY d", append(args, since)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DailyCount, 0, days)
	for rows.Next() {
		var d DailyCount
		if err := rows.Scan(&d.Date, &d.Count); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// terminalSummary 终态任务的计数 + 成功率 + 平均耗时（秒）。
func (s *Store) terminalSummary(where string, args ...any) (total, done, fail, reviews int, rate, avgDur float64, err error) {
	q := "SELECT COUNT(*), COALESCE(SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END),0), " +
		"COALESCE(SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END),0), COALESCE(SUM(t.review_rounds),0), " +
		"COALESCE(SUM(CASE WHEN t.status IN ('succeeded','failed') THEN (julianday(t.finished_at)-julianday(t.started_at)) ELSE 0 END),0) " +
		"FROM tasks t WHERE " + where
	row := s.db.QueryRow(q, args...)
	var durDays float64
	if err := row.Scan(&total, &done, &fail, &reviews, &durDays); err != nil {
		return 0, 0, 0, 0, 0, 0, err
	}
	if total > 0 {
		rate = float64(done) / float64(total) * 100
	}
	denom := done + fail
	if denom > 0 {
		avgDur = durDays * 86400 / float64(denom)
	}
	return total, done, fail, reviews, rate, avgDur, nil
}

// AgentStatsOf 汇总某个 agent 的全部产出统计。
func (s *Store) AgentStatsOf(agentID int64) (*AgentStats, error) {
	st := &AgentStats{AgentID: agentID}
	agent, err := s.GetAgent(agentID)
	if err != nil {
		return nil, err
	}
	st.AgentName = agent.Name
	st.CLI = agent.CLI

	total, done, fail, reviews, rate, avgDur, err := s.terminalSummary("t.agent_id=?", agentID)
	if err != nil {
		return nil, err
	}
	st.Total, st.Succeeded, st.Failed, st.Reviews = total, done, fail, reviews
	st.SuccessRate, st.AvgDuration = rate, avgDur

	counts, _, err := s.statusCountsOf("t.agent_id=?", agentID)
	if err != nil {
		return nil, err
	}
	st.StatusCounts = counts
	for _, c := range counts {
		if c.Status == StatusQueued || c.Status == StatusClaimed || c.Status == StatusRunning || c.Status == StatusAwaitingReview {
			st.InFlight += c.Count
		}
		if c.Status == StatusCancelled {
			st.Cancelled = c.Count
		}
	}

	rows, err := s.db.Query(`SELECT t.agent_id, t.project_id, COALESCE(p.name,''), COUNT(*),
		COALESCE(SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(t.review_rounds),0),
		COALESCE(SUM(CASE WHEN t.status IN ('succeeded','failed') THEN (julianday(t.finished_at)-julianday(t.started_at)) ELSE 0 END),0)
		FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
		WHERE t.agent_id=? GROUP BY t.project_id, p.name ORDER BY COUNT(*) DESC`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ps AgentProjectStat
		var dur float64
		var n int
		var aid, pid sql.NullInt64
		if err := rows.Scan(&aid, &pid, &ps.ProjectName, &n, &ps.Succeeded, &ps.Failed, &ps.Reviews, &dur); err != nil {
			return nil, err
		}
		ps.AgentID = agentID
		if pid.Valid {
			ps.ProjectID = pid.Int64
		}
		ps.AgentName = agent.Name
		ps.Total = n
		if n > 0 {
			ps.SuccessRate = float64(ps.Succeeded) / float64(n) * 100
		}
		if denom := ps.Succeeded + ps.Failed; denom > 0 {
			ps.AvgDuration = dur * 86400 / float64(denom)
		}
		st.Projects = append(st.Projects, ps)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	daily, err := s.dailySucceeded("t.agent_id=?", 14, agentID)
	if err != nil {
		return nil, err
	}
	st.Daily = daily
	if st.StatusCounts == nil {
		st.StatusCounts = []StatusCount{}
	}
	if st.Projects == nil {
		st.Projects = []AgentProjectStat{}
	}
	if st.Daily == nil {
		st.Daily = []DailyCount{}
	}
	return st, nil
}

// ProjectStatsOf 汇总项目进度 + 在该项目工作的 agent 产出。
func (s *Store) ProjectStatsOf(projectID int64) (*ProjectStats, error) {
	ps := &ProjectStats{ProjectID: projectID}
	proj, err := s.GetProject(projectID)
	if err != nil {
		return nil, err
	}
	ps.ProjectName = proj.Name

	total, done, fail, reviews, rate, avgDur, err := s.terminalSummary("t.project_id=?", projectID)
	if err != nil {
		return nil, err
	}
	ps.Total, ps.Succeeded, ps.Failed, ps.Reviews = total, done, fail, reviews
	if total > 0 {
		ps.Progress = float64(done) / float64(total) * 100
	}
	_ = rate
	_ = avgDur

	counts, inflight, err := s.statusCountsOf("t.project_id=?", projectID)
	if err != nil {
		return nil, err
	}
	ps.StatusCounts = counts
	ps.InFlight = inflight

	rows, err := s.db.Query(`SELECT t.agent_id, t.project_id, COALESCE(a.name,''), COALESCE(p.name,''), COUNT(*),
		COALESCE(SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(t.review_rounds),0),
		COALESCE(SUM(CASE WHEN t.status IN ('succeeded','failed') THEN (julianday(t.finished_at)-julianday(t.started_at)) ELSE 0 END),0)
		FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id LEFT JOIN projects p ON p.id=t.project_id
		WHERE t.project_id=? GROUP BY t.agent_id, a.name ORDER BY COUNT(*) DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ag AgentProjectStat
		var dur float64
		var n int
		var aid, pid sql.NullInt64
		if err := rows.Scan(&aid, &pid, &ag.AgentName, &ag.ProjectName, &n, &ag.Succeeded, &ag.Failed, &ag.Reviews, &dur); err != nil {
			return nil, err
		}
		if aid.Valid {
			ag.AgentID = aid.Int64
		}
		ag.ProjectID = projectID
		ag.Total = n
		if n > 0 {
			ag.SuccessRate = float64(ag.Succeeded) / float64(n) * 100
		}
		if denom := ag.Succeeded + ag.Failed; denom > 0 {
			ag.AvgDuration = dur * 86400 / float64(denom)
		}
		ps.Agents = append(ps.Agents, ag)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	daily, err := s.dailySucceeded("t.project_id=?", 14, projectID)
	if err != nil {
		return nil, err
	}
	ps.Daily = daily
	if ps.StatusCounts == nil {
		ps.StatusCounts = []StatusCount{}
	}
	if ps.Agents == nil {
		ps.Agents = []AgentProjectStat{}
	}
	if ps.Daily == nil {
		ps.Daily = []DailyCount{}
	}
	return ps, nil
}

// OverviewStatsOf 全局总览。
func (s *Store) OverviewStatsOf() (*OverviewStats, error) {
	ov := &OverviewStats{}
	total, done, fail, reviews, rate, avgDur, err := s.terminalSummary("1=1")
	if err != nil {
		return nil, err
	}
	ov.Total, ov.Succeeded, ov.Failed, ov.Reviews = total, done, fail, reviews
	ov.SuccessRate, ov.AvgDuration = rate, avgDur

	counts, inflight, err := s.statusCountsOf("1=1")
	if err != nil {
		return nil, err
	}
	ov.StatusCounts = counts
	ov.InFlight = inflight

	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM projects").Scan(&n); err != nil {
		return nil, err
	}
	ov.Projects = n

	daily, err := s.dailySucceeded("1=1", 14)
	if err != nil {
		return nil, err
	}
	ov.Daily = daily
	if ov.StatusCounts == nil {
		ov.StatusCounts = []StatusCount{}
	}
	if ov.Daily == nil {
		ov.Daily = []DailyCount{}
	}
	return ov, nil
}

// ---------------------------------------------------------------------------
// 技能库（注册到 paihuo 工作目录，角色配置时按名称勾选）

const skillCols = "id, name, description, tags, dir, source_path, created_at"

func scanSkill(rows scanner) (Skill, error) {
	var s Skill
	var tagsJSON string
	err := rows.Scan(&s.ID, &s.Name, &s.Description, &tagsJSON, &s.Dir, &s.SourcePath, &s.CreatedAt)
	if err != nil {
		return s, err
	}
	s.Tags = decodeSkillTags(tagsJSON)
	return s, err
}

func (s *Store) ListSkills() ([]Skill, error) {
	rows, err := s.db.Query("SELECT " + skillCols + " FROM skills ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Skill, 0)
	for rows.Next() {
		sk, err := scanSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sk)
	}
	return out, rows.Err()
}

func (s *Store) GetSkill(id int64) (*Skill, error) {
	row := s.db.QueryRow("SELECT "+skillCols+" FROM skills WHERE id=?", id)
	sk, err := scanSkill(row)
	if err != nil {
		return nil, err
	}
	return &sk, nil
}

func (s *Store) CreateSkill(sk Skill) (int64, error) {
	if sk.CreatedAt == "" {
		sk.CreatedAt = Now()
	}
	tagsJSON, err := json.Marshal(normalizeSkillTags(sk.Tags))
	if err != nil {
		return 0, err
	}
	res, err := s.db.Exec("INSERT INTO skills (name, description, tags, dir, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		sk.Name, sk.Description, string(tagsJSON), sk.Dir, sk.SourcePath, sk.CreatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateSkillTags replaces the labels attached to a skill. Labels are stored
// as JSON so existing role configurations can continue to reference the same
// skill directory without any schema coupling.
func (s *Store) UpdateSkillTags(id int64, tags []string) error {
	tagsJSON, err := json.Marshal(normalizeSkillTags(tags))
	if err != nil {
		return err
	}
	_, err = s.db.Exec("UPDATE skills SET tags=? WHERE id=?", string(tagsJSON), id)
	return err
}

func normalizeSkillTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, tag)
	}
	return out
}

func decodeSkillTags(raw string) []string {
	var tags []string
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &tags); err == nil {
			return normalizeSkillTags(tags)
		}
	}
	return []string{}
}

func (s *Store) DeleteSkill(id int64) error {
	_, err := s.db.Exec("DELETE FROM skills WHERE id=?", id)
	return err
}

// DeleteSkills 在同一个事务中删除一批技能记录。调用方负责清理技能目录副本。
func (s *Store) DeleteSkills(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare("DELETE FROM skills WHERE id=?")
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, id := range ids {
		if id <= 0 {
			return fmt.Errorf("非法技能 id: %d", id)
		}
		if _, err := stmt.Exec(id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListTasksForCleanup 返回全部任务（worktree 清理用）。
func (s *Store) ListTasksForCleanup() ([]Task, error) {
	rows, err := s.db.Query("SELECT " + taskColsBrief + taskFrom + " WHERE 1=1")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Task, 0)
	for rows.Next() {
		tk, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tk)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// 会话（Session）

const sessionCols = `s.id, s.project_id, COALESCE(p.name, ''), s.agent_id, COALESCE(a.name, ''), a.cli,
	s.title, s.status, s.worktree_branch, s.worktree_path, s.base_commit, s.session_dir, s.task_id, s.last_message_at, s.message_count,
	s.created_at, s.started_at, s.suspended_at, s.delivered_at, s.updated_at`
const sessionFrom = " FROM sessions s LEFT JOIN projects p ON p.id=s.project_id LEFT JOIN agents a ON a.id=s.agent_id"

func scanSession(rows scanner) (Session, error) {
	var ss Session
	var projectID, taskID sql.NullInt64
	var started, suspended, delivered sql.NullString
	err := rows.Scan(&ss.ID, &projectID, &ss.ProjectName, &ss.AgentID, &ss.AgentName, &ss.CLI,
		&ss.Title, &ss.Status, &ss.WorktreeBranch, &ss.WorktreePath, &ss.BaseCommit, &ss.SessionDir, &taskID, &ss.LastMessageAt, &ss.MessageCount,
		&ss.CreatedAt, &started, &suspended, &delivered, &ss.UpdatedAt)
	if err != nil {
		return ss, err
	}
	if projectID.Valid {
		ss.ProjectID = &projectID.Int64
	}
	if taskID.Valid {
		ss.TaskID = &taskID.Int64
	}
	ss.StartedAt = strPtr(started)
	ss.SuspendedAt = strPtr(suspended)
	ss.DeliveredAt = strPtr(delivered)
	return ss, nil
}

// CreateSession 创建会话记录。projectID 可为 nil（无项目）。agentID 必须存在。
func (s *Store) CreateSession(ss Session) (int64, error) {
	if ss.Status == "" {
		ss.Status = SessionStatusCreated
	}
	if ss.CreatedAt == "" {
		ss.CreatedAt = Now()
	}
	if ss.UpdatedAt == "" {
		ss.UpdatedAt = ss.CreatedAt
	}
	res, err := s.db.Exec(`INSERT INTO sessions (project_id, agent_id, title, status, cli, worktree_branch, worktree_path, base_commit, session_dir, task_id, last_message_at, created_at, started_at, suspended_at, delivered_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		nullInt64(ss.ProjectID), ss.AgentID, ss.Title, ss.Status, ss.CLI, ss.WorktreeBranch, ss.WorktreePath, ss.BaseCommit, ss.SessionDir,
		nullInt64(ss.TaskID), ss.LastMessageAt, ss.CreatedAt, nullStrPtr(ss.StartedAt), nullStrPtr(ss.SuspendedAt), nullStrPtr(ss.DeliveredAt), ss.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func nullStrPtr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// GetSession 返回单个会话；不存在时返回 nil。
func (s *Store) GetSession(id int64) (*Session, error) {
	row := s.db.QueryRow("SELECT "+sessionCols+sessionFrom+" WHERE s.id=?", id)
	ss, err := scanSession(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &ss, nil
}

// ListSessions 列出会话（默认不含 deleted；filter.Status 空 = 全部非删除）。
func (s *Store) ListSessions(f SessionFilter) ([]Session, error) {
	q := "SELECT " + sessionCols + sessionFrom + " WHERE 1=1"
	var args []any
	if f.ProjectID != nil {
		q += " AND s.project_id=?"
		args = append(args, *f.ProjectID)
	}
	if f.AgentID != nil {
		q += " AND s.agent_id=?"
		args = append(args, *f.AgentID)
	}
	if f.Status != "" {
		q += " AND s.status=?"
		args = append(args, f.Status)
	} else if !f.IncludeDeleted {
		q += " AND s.status<>'deleted'"
	}
	q += " ORDER BY COALESCE(NULLIF(s.last_message_at,''), s.created_at) DESC, s.id DESC"
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Session, 0) // 空列表返回 [] 而非 null（前端 .length 直接可用）
	for rows.Next() {
		ss, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ss)
	}
	return out, rows.Err()
}

// UpdateSession 按字段更新会话（updateOne 的 set 语义：key=列名）。
func (s *Store) UpdateSession(id int64, set map[string]any) error {
	return updateOne(s.db, "sessions", id, set)
}
