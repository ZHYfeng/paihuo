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
  agent_id    INTEGER REFERENCES agents(id),
  project_id  INTEGER REFERENCES projects(id),
  project_dir TEXT NOT NULL DEFAULT '',
  parent_id   INTEGER REFERENCES tasks(id),
  schedule_id INTEGER,
  error       TEXT NOT NULL DEFAULT '',
  exit_code   INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  review_rounds INTEGER NOT NULL DEFAULT 0,
  worktree_branch TEXT NOT NULL DEFAULT '',
  base_commit   TEXT NOT NULL DEFAULT '',
  resume_of     INTEGER REFERENCES tasks(id),
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
  dir         TEXT NOT NULL UNIQUE,      -- 复制到 paihuo 工作目录后的技能目录（绝对路径）
  source_path TEXT NOT NULL DEFAULT '',  -- 添加时的来源路径
  created_at  TEXT NOT NULL
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
		"ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id)",
		"ALTER TABLE projects ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE tasks ADD COLUMN worktree_branch TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE tasks ADD COLUMN base_commit TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE tasks ADD COLUMN resume_of INTEGER REFERENCES tasks(id)",
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
	// 索引在迁移阶段创建：老库先补列再建索引；新库 schema 建表时列已存在
	for _, stmt := range []string{
		"CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_finished ON tasks(finished_at)",
	} {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	// readonly 权限模式已移除：历史任务按完整权限继续执行
	if _, err := db.Exec("UPDATE tasks SET perm='full' WHERE perm='readonly'"); err != nil {
		return err
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

// taskCols 完整列（详情页用：含完整 body，驳回重做会追加修改意见）。
const taskCols = `t.id, t.title, t.body, t.status, t.perm, t.agent_id, COALESCE(a.name, ''),
	t.project_id, COALESCE(p.name, ''), t.project_dir, t.parent_id, t.schedule_id, t.error, t.exit_code,
	t.review_note, t.review_rounds, t.worktree_branch, t.base_commit, t.resume_of, t.created_at, t.started_at, t.finished_at, t.updated_at`

// taskColsBrief 列表列（看板/历史/项目页用）：body 截断到 400 字符，
// 避免大提示词把列表接口载荷撑爆。列序与 taskCols 完全一致（scanTask 共用）。
const taskColsBrief = `t.id, t.title, substr(t.body,1,400) AS body, t.status, t.perm, t.agent_id, COALESCE(a.name, ''),
	t.project_id, COALESCE(p.name, ''), t.project_dir, t.parent_id, t.schedule_id, t.error, t.exit_code,
	t.review_note, t.review_rounds, t.worktree_branch, t.base_commit, t.resume_of, t.created_at, t.started_at, t.finished_at, t.updated_at`

func scanTask(rows scanner) (Task, error) {
	var tk Task
	var agentID, projectID, parentID, scheduleID, exitCode sql.NullInt64
	var agentName, projectName string
	var started, finished sql.NullString
	var resumeOf sql.NullInt64
	err := rows.Scan(&tk.ID, &tk.Title, &tk.Body, &tk.Status, &tk.Perm, &agentID, &agentName,
		&projectID, &projectName, &tk.ProjectDir, &parentID, &scheduleID, &tk.Error, &exitCode,
		&tk.ReviewNote, &tk.ReviewRounds, &tk.WorktreeBranch, &tk.BaseCommit, &resumeOf, &tk.CreatedAt, &started, &finished, &tk.UpdatedAt)
	if err != nil {
		return tk, err
	}
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
	tk.ProjectName = projectName
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
	q += " ORDER BY t.created_at DESC, t.id DESC"
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
	rows, err := s.db.Query("SELECT " + taskColsBrief + taskFrom + " WHERE t.status='queued' AND t.agent_id IS NOT NULL AND a.enabled=1 ORDER BY t.created_at")
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

func (s *Store) CreateTask(t Task) (int64, error) {
	if t.CreatedAt == "" {
		t.CreatedAt = Now()
	}
	if t.UpdatedAt == "" {
		t.UpdatedAt = t.CreatedAt
	}
	res, err := s.db.Exec(`INSERT INTO tasks (title, body, status, perm, agent_id, project_id, project_dir, parent_id, schedule_id, resume_of, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.Title, t.Body, t.Status, t.Perm, nullInt64(t.AgentID), nullInt64(t.ProjectID), t.ProjectDir,
		nullInt64(t.ParentID), nullInt64(t.ScheduleID), nullInt64(t.ResumeOf), t.CreatedAt, t.UpdatedAt)
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
	// 级联删除子任务（含其日志）
	if _, err := s.db.Exec("DELETE FROM tasks WHERE parent_id=?", id); err != nil {
		return err
	}
	_, err := s.db.Exec("DELETE FROM tasks WHERE id=?", id)
	return err
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
//
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

const terminalStats = `t.status IN ('succeeded','failed','cancelled')`

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

const skillCols = "id, name, description, dir, source_path, created_at"

func scanSkill(rows scanner) (Skill, error) {
	var s Skill
	err := rows.Scan(&s.ID, &s.Name, &s.Description, &s.Dir, &s.SourcePath, &s.CreatedAt)
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
	res, err := s.db.Exec("INSERT INTO skills (name, description, dir, source_path, created_at) VALUES (?, ?, ?, ?, ?)",
		sk.Name, sk.Description, sk.Dir, sk.SourcePath, sk.CreatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) DeleteSkill(id int64) error {
	_, err := s.db.Exec("DELETE FROM skills WHERE id=?", id)
	return err
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
