package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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
  default_perm  TEXT NOT NULL DEFAULT 'full',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued',
  perm        TEXT NOT NULL DEFAULT 'full',
  agent_id    INTEGER REFERENCES agents(id),
  project_dir TEXT NOT NULL DEFAULT '',
  parent_id   INTEGER REFERENCES tasks(id),
  schedule_id INTEGER,
  error       TEXT NOT NULL DEFAULT '',
  exit_code   INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  review_rounds INTEGER NOT NULL DEFAULT 0,
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
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_run_at    TEXT,
  next_run_at    TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
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
		"ALTER TABLE tasks ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0",
	} {
		if _, err := db.Exec(stmt); err != nil {
			// 列已存在则忽略
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	return nil
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
	_, err := db.Exec(q, vals...)
	return err
}

func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
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
	a.project_dir, a.default_perm, a.enabled, a.created_at, a.updated_at`

func scanAgent(rows scanner) (Agent, error) {
	var a Agent
	var rc string
	err := rows.Scan(&a.ID, &a.Name, &a.Description, &a.CLI, &rc,
		&a.ProjectDir, &a.DefaultPerm, &a.Enabled, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return a, err
	}
	if rc != "" {
		_ = json.Unmarshal([]byte(rc), &a.RoleConfig)
	}
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
	rc, err := json.Marshal(a.RoleConfig)
	if err != nil {
		return 0, err
	}
	res, err := s.db.Exec(`INSERT INTO agents (name, description, cli, role_config, project_dir, default_perm, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.Name, a.Description, a.CLI, string(rc), a.ProjectDir, a.DefaultPerm, a.Enabled, a.CreatedAt, a.UpdatedAt)
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
	if _, err := s.db.Exec("UPDATE tasks SET agent_id=NULL WHERE agent_id=?", id); err != nil {
		return err
	}
	_, err := s.db.Exec("DELETE FROM agents WHERE id=?", id)
	return err
}

// ---------------------------------------------------------------------------
// 任务

const taskCols = `t.id, t.title, t.body, t.status, t.perm, t.agent_id, COALESCE(a.name, ''),
	t.project_dir, t.parent_id, t.schedule_id, t.error, t.exit_code,
	t.review_note, t.review_rounds, t.created_at, t.started_at, t.finished_at, t.updated_at`

func scanTask(rows scanner) (Task, error) {
	var tk Task
	var agentID, parentID, scheduleID, exitCode sql.NullInt64
	var agentName string
	var started, finished sql.NullString
	err := rows.Scan(&tk.ID, &tk.Title, &tk.Body, &tk.Status, &tk.Perm, &agentID, &agentName,
		&tk.ProjectDir, &parentID, &scheduleID, &tk.Error, &exitCode,
		&tk.ReviewNote, &tk.ReviewRounds, &tk.CreatedAt, &started, &finished, &tk.UpdatedAt)
	if err != nil {
		return tk, err
	}
	if agentID.Valid {
		tk.AgentID = &agentID.Int64
	}
	tk.AgentName = agentName
	if parentID.Valid {
		tk.ParentID = &parentID.Int64
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

func (s *Store) ListTasks() ([]Task, error) {
	rows, err := s.db.Query("SELECT " + taskCols + " FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id ORDER BY t.created_at DESC, t.id DESC")
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

func (s *Store) ListQueuedTasks() ([]Task, error) {
	rows, err := s.db.Query("SELECT " + taskCols + " FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.status='queued' AND t.agent_id IS NOT NULL ORDER BY t.created_at")
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

// ListRunningTasks 返回卡在执行态的任务（服务重启时用于重置）。
func (s *Store) ListRunningTasks() ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskCols+" FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.status IN ('running','claimed','awaiting_review')")
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
	row := s.db.QueryRow("SELECT "+taskCols+" FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.id=?", id)
	tk, err := scanTask(row)
	if err != nil {
		return nil, err
	}
	return &tk, nil
}

func (s *Store) CreateTask(t Task) (int64, error) {
	if t.CreatedAt == "" {
		t.CreatedAt = Now()
	}
	if t.UpdatedAt == "" {
		t.UpdatedAt = t.CreatedAt
	}
	res, err := s.db.Exec(`INSERT INTO tasks (title, body, status, perm, agent_id, project_dir, parent_id, schedule_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.Title, t.Body, t.Status, t.Perm, nullInt64(t.AgentID), t.ProjectDir,
		nullInt64(t.ParentID), nullInt64(t.ScheduleID), t.CreatedAt, t.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateTask(id int64, set map[string]any) error {
	return updateOne(s.db, "tasks", id, set)
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

func (s *Store) DeleteTask(id int64) error {
	_, err := s.db.Exec("DELETE FROM tasks WHERE id=?", id)
	return err
}

func (s *Store) HasTask(id int64) (bool, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE id=?", id).Scan(&n)
	return n > 0, err
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

// ---------------------------------------------------------------------------
// 定时任务

const schedCols = `s.id, s.name, s.cron, s.title_template, s.body_template, s.agent_id,
	s.enabled, s.last_run_at, s.next_run_at, s.created_at, a.name`

func (s *Store) ListSchedules() ([]Schedule, error) {
	rows, err := s.db.Query("SELECT " + schedCols + " FROM schedules s JOIN agents a ON a.id=s.agent_id ORDER BY s.id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Schedule, 0)
	for rows.Next() {
		var sc Schedule
		var lastRun, nextRun sql.NullString
		if err := rows.Scan(&sc.ID, &sc.Name, &sc.Cron, &sc.TitleTemplate, &sc.BodyTemplate,
			&sc.AgentID, &sc.Enabled, &lastRun, &nextRun, &sc.CreatedAt, &sc.AgentName); err != nil {
			return nil, err
		}
		sc.LastRunAt = strPtr(lastRun)
		sc.NextRunAt = strPtr(nextRun)
		out = append(out, sc)
	}
	return out, rows.Err()
}

func (s *Store) GetSchedule(id int64) (*Schedule, error) {
	row := s.db.QueryRow("SELECT "+schedCols+" FROM schedules s JOIN agents a ON a.id=s.agent_id WHERE s.id=?", id)
	var sc Schedule
	var lastRun, nextRun sql.NullString
	if err := row.Scan(&sc.ID, &sc.Name, &sc.Cron, &sc.TitleTemplate, &sc.BodyTemplate,
		&sc.AgentID, &sc.Enabled, &lastRun, &nextRun, &sc.CreatedAt, &sc.AgentName); err != nil {
		return nil, err
	}
	sc.LastRunAt = strPtr(lastRun)
	sc.NextRunAt = strPtr(nextRun)
	return &sc, nil
}

func (s *Store) CreateSchedule(sc Schedule) (int64, error) {
	if sc.CreatedAt == "" {
		sc.CreatedAt = Now()
	}
	res, err := s.db.Exec(`INSERT INTO schedules (name, cron, title_template, body_template, agent_id, enabled, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sc.Name, sc.Cron, sc.TitleTemplate, sc.BodyTemplate, sc.AgentID, sc.Enabled, sc.CreatedAt)
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
// 只删除终态任务（succeeded/failed/cancelled），进行中的任务不动。
func (s *Store) CleanupTasks(agentID *int64, before string) (int64, error) {
	q := "DELETE FROM tasks WHERE status IN ('succeeded','failed','cancelled')"
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
