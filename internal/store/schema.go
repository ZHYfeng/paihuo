package store

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS roles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  runtime_id    TEXT NOT NULL,
  role_config   TEXT NOT NULL DEFAULT '{}',
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency >= 1),
  delegation_enabled INTEGER NOT NULL DEFAULT 0, -- 编排委托开关（可派生子任务）
  delegation_max_perm TEXT NOT NULL DEFAULT 'review', -- 子任务最大权限 full|review
  enabled       INTEGER NOT NULL DEFAULT 1,
  revision      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active', -- active | archived
  project_dir TEXT NOT NULL DEFAULT '',
  github_repo TEXT NOT NULL DEFAULT '',
  github_role_id INTEGER REFERENCES roles(id),
  github_auto_issues INTEGER NOT NULL DEFAULT 0,
  github_auto_prs INTEGER NOT NULL DEFAULT 0,
  github_auto_security INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL DEFAULT 'task', -- task | session | workflow（TaskType*）
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued',
  perm        TEXT NOT NULL DEFAULT 'full',
  run_mode    TEXT NOT NULL DEFAULT 'batch',
  concurrent  INTEGER NOT NULL DEFAULT 0, -- 1=允许并发（默认串行：同一项目同时只执行一个任务）
  role_id    INTEGER REFERENCES roles(id),
  project_id  INTEGER REFERENCES projects(id),
  project_dir TEXT NOT NULL DEFAULT '',
  parent_id   INTEGER REFERENCES tasks(id),
  depends_on  INTEGER REFERENCES tasks(id),
  dependency_mode TEXT NOT NULL DEFAULT 'none',
  block_on_failure INTEGER NOT NULL DEFAULT 0,
  schedule_id INTEGER, -- 定时触发的实例：指向定义任务 id（无 FK，自引用）
  error       TEXT NOT NULL DEFAULT '',
  exit_code   INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  review_rounds INTEGER NOT NULL DEFAULT 0,
  tmux_log_offset INTEGER NOT NULL DEFAULT 0,
  worktree_branch TEXT NOT NULL DEFAULT '',
  base_commit   TEXT NOT NULL DEFAULT '',
  resume_of     INTEGER REFERENCES tasks(id),
  merge_of      INTEGER,
  merge_skipped INTEGER NOT NULL DEFAULT 0, -- 判定无改动：直接视为已交付，不再创建/补建合并任务
  sort_order    INTEGER NOT NULL DEFAULT 0,
  terminal_cols INTEGER NOT NULL DEFAULT 0,
  terminal_rows INTEGER NOT NULL DEFAULT 0,
  session_id    INTEGER REFERENCES tasks(id), -- 会话交付的收编任务回链
  workflow_run_id INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
  parent_session_id INTEGER REFERENCES tasks(id), -- 编排者会话（树的根）
  parent_task_id     INTEGER REFERENCES tasks(id), -- 产生本次 spawn 的任务（再派活链）
  -- 定时属性（正交：任何形态可挂；cron 非空 = 定时定义，永不直接执行）
  cron            TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  next_run_at     TEXT,
  -- 会话字段（type=session）
  worktree_path   TEXT NOT NULL DEFAULT '',
  session_dir     TEXT NOT NULL DEFAULT '',
  last_message_at TEXT NOT NULL DEFAULT '',
  message_count   INTEGER NOT NULL DEFAULT 0,
  suspended_at    TEXT,
  delivered_at    TEXT,
  -- 工作流字段（type=workflow）
  spec            TEXT NOT NULL DEFAULT '',
  violations      TEXT NOT NULL DEFAULT '[]',
  spec_hash       TEXT NOT NULL DEFAULT '',
  -- 外部系统去重键（GitHub 集成等）
  external_key    TEXT NOT NULL DEFAULT '',
  revision      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_role ON tasks(role_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_sort ON tasks(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_tasks_finished ON tasks(finished_at);
CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks(depends_on);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow_run ON tasks(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_session ON tasks(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task ON tasks(parent_task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_merge_of_unique ON tasks(merge_of) WHERE merge_of IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_key_unique ON tasks(external_key) WHERE external_key <> '';

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
	on_failure TEXT NOT NULL DEFAULT 'block',
  PRIMARY KEY(task_id, depends_on),
  CHECK(task_id <> depends_on)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_source ON task_dependencies(depends_on);

CREATE TABLE IF NOT EXISTS task_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  stream     TEXT NOT NULL DEFAULT 'out',
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, seq);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES tasks(id), -- adopted 的工作流定义（type=workflow）
  project_id  INTEGER NOT NULL REFERENCES projects(id), -- 本次 Run 绑定的具体项目
  task        TEXT NOT NULL DEFAULT '', -- 本次 Run 的自定义任务（{{.task}} 渲染进节点意图；留空 = 纯模板执行）
  status      TEXT NOT NULL DEFAULT 'created',
  task_ids    TEXT NOT NULL DEFAULT '{}',
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_plan ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_project ON workflow_runs(project_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  role_id   INTEGER REFERENCES roles(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '', -- 分类（文件夹）：导入时从源目录父文件夹推断，可批量调整
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON array of labels
  dir         TEXT NOT NULL UNIQUE,      -- 复制到 paihuo 工作目录后的技能目录（绝对路径）
  source_path TEXT NOT NULL DEFAULT '',  -- 添加时的来源路径
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  task_id    INTEGER,
  role_id    INTEGER,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  key         TEXT NOT NULL,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  body        BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(key, method, path)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK(size >= 0),
  locator     TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  retention   TEXT NOT NULL DEFAULT 'default',
  created_at  TEXT NOT NULL,
  CHECK ((task_id IS NOT NULL) <> (run_id IS NOT NULL))
);
PRAGMA user_version=1;
`

// 当前没有按版本编号的数据库迁移链。Open 对存量库依次执行 8 个幂等的
// 加列迁移，再由 verifyCurrentSchema 检查当前形态；这些迁移只覆盖各函数
// 明确列出的增量，无法升级的历史 schema 仍需使用全新数据库。
