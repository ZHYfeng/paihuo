# S1 会话实体设计

> 状态：已确认 · 更新：2026-08-08
> 需求来源：`01-requirements.md` 的 S1。本文定义会话实体的状态机、数据模型与执行通道。

## 1. 状态机

```
                    ┌────────────────────────────────────┐
                    │                                    │
 created ──start──▶ active ──suspend──▶ suspended ──resume▶ active
   │                  │  ▲               │                │
   │                  │  └──(崩溃)────────┘                │
   │                  │                                   │
   ├──discard─────────┼──deliver──▶ delivered (冻结,→task)  │
   │                  │                                   │
   └──────────────────┴───────────────────────────────────┘
```

- **created**：记录 + worktree 已建（git 项目），agent 未启动
- **active**：agent 进程运行中（`streaming`/`working` 是 UI 层细分，不占状态位）
- **suspended**：进程退出（用户挂起 / 崩溃），worktree + transcript 保留，**不占并发槽**
- **delivered**：**交付即终态**——冻结只读，关联 `task_id`；不可恢复、不可再次交付。任务被删除时会话联动清理（delivered → deleted），不再解冻（解冻会让会话被修改后反复交付、反复创建合并任务）
- **deleted**：已丢弃（清理 worktree）

## 2. 状态迁移表

| 迁移 | 触发 | 副作用 |
|---|---|---|
| create | 新建会话（项目+角色，标题自动取角色名） | git 项目建 worktree `sessions/<proj>/session-<id>`，分支 `paihuo/session-<id>` |
| start | 打开会话 | spawn agent 进程；**占角色并发槽**（与批处理任务共用池，防资源耗尽） |
| suspend | 点挂起 / 进程退出 / 崩溃 | 杀进程、释放并发槽；transcript 由 pi 会话文件持久化 |
| resume | 点恢复 | spawn 进程 + `switch_session <session.jsonl>` 接续原会话 |
| deliver | 点交付 | 创建任务并**复用会话 worktree**（不搬移不重建）；git 项目快照会话分支落定成果；会话冻结为终态 |
| discard | 删除会话 | 清理 worktree + 会话数据；delivered 会话也可丢弃（归档出口，不影响任务）；交付任务被删除时会话自动 discard |

## 3. 数据模型（新表 sessions）

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,          -- 角色（决定 cli）
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',  -- created|active|suspended|delivered|deleted
  cli TEXT NOT NULL,                   -- pi|codex|claude（冗余自角色，前端展示用）
  worktree_branch TEXT,                -- paihuo/session-<id>
  worktree_path TEXT,
  session_dir TEXT,                    -- pi 会话文件目录
  task_id INTEGER,                     -- 交付后关联
  created_at TEXT, started_at TEXT, suspended_at TEXT, delivered_at TEXT,
  last_message_at TEXT                 -- 列表排序用
)
```

迁移：`tasks` 表加 `session_id` 列（交付桥接用），迁移版本 +1。

## 4. 会话进程管理（双执行通道）

| | pi 会话 | codex/claude 会话 |
|---|---|---|
| 进程形态 | `pi --mode rpc --session-dir <dir>`，stdin/stdout **JSONL 全双工** | 交互 TTY（**沿用现有 tmux 机制**） |
| 挂起/恢复 | 杀进程 / 新进程 + `switch_session` | tmux 窗口 kill / 重建 |
| 消息数据源 | RPC 事件流 + `get_messages` → **结构化** | 终端捕获 → 行式 |
| 崩溃处理 | 进程退出检测 → 置 suspended + 通知（transcript 不丢，随时可恢复） | 同现有任务窗口丢失逻辑 |

## 5. 交付桥接（关键兼容点）

- 交付 → 创建 Task（标题=会话标题，项目/角色继承），Task 新增 `session_id` 字段
- **worktree 复用**：`workspace.Ensure` 对已存在 worktree 直接返回（现有逻辑兼容）——任务直接使用 `paihuo/session-<id>` 分支，合并任务照常工作
- 后续审批/合并流程零改动

## 6. 关键设计决策（记录）

| 决策 | 选择 | 理由 |
|---|---|---|
| 会话与任务的关系 | 平行实体，交付时桥接 | 交互语义（挂起/恢复）与执行语义（结算）正交 |
| 挂起占不占并发槽 | 不占；active 占 | 挂起只留文件，无资源占用 |
| 会话套不套项目串行门禁 | 不套 | 交互会话是人在场即时操作，worktree 已隔离；资源由角色 MaxConcurrent 兜底 |
| pi 会话用不用 tmux | 不用 | RPC 是 stdio 协议，进程管理比 tmux 窗口干净 |
| 交付时 worktree 搬不搬 | 不搬（任务引用会话工作区） | 避免 worktree move 的复杂性与风险 |
