# 任务系统四形态统一（彻底物理统一）

> 状态：设计定稿。目标：把「任务 / 会话 / 工作流 / 定时」四种形态统一进
> `tasks` 单一实体表，对齐 `CONTEXT.md` 领域语言：Task 是唯一实体，
> 四种形态只是创建方式的差异。

## 1. 目标模型

- **tasks 表是唯一的实体表**。新增 `type` 列：`task` | `session` | `workflow`。
- **定时是正交属性**：任何 type 的任务都可挂 cron（`cron` + `enabled` +
  `last_run_at` / `next_run_at`）。定时任务 = 「基础形态 + cron」，
  不占用 type 维度。
- **四个页面 = 四个形态的汇总视图**：
  - 任务页：`type='task'`；
  - 会话页：`type='session'`；
  - 工作流页：`type='workflow'`；
  - 定时页：`cron != ''`（跨三种形态汇总）。
- **创建统一**：项目内「新建任务」对话框四选一（任务 / 会话 / 工作流 / 定时），
  选「定时」后再选基础形态与 cron。

## 2. 定时触发语义（实例模型）

定时定义任务本身永不执行；到点按 `type` 创建实例，实例携带
`schedule_id = 定义任务 id`（原 schedule_id 列语义不变，现在指向 tasks 表）：

| 定义 type | 触发动作 |
|---|---|
| task | 渲染 title/body 模板（`{{.date}}` 等），创建新任务（type=task，继承 role/project/perm/依赖策略，schedule_id=定义 id） |
| session | 创建会话任务实例（type=session，role/project 继承，body 作为初始指令），自动 Start 并 Prompt(body) |
| workflow | 从定义的 spec（status=adopted）创建 Run（workflow_runs 记录），原子实例化子任务树 |

定义任务在任务系统里可见（任务/会话/工作流页各显示自己的形态 + 定时徽标，
定时页跨形态汇总），但：

- 执行器认领（`ListQueuedTasks`）排除 `cron != ''` 与 `type != 'task'`；
- 统计（`statusCountsOf` 等）排除 `cron != ''`；
- 会话页/工作流页默认列表排除 `cron != ''`（定义只进定时页与项目页的
  定时区块）。

## 3. Schema 变更

`tasks` 表扩展以下列；`sessions`、`schedules`、`workflow_proposals`、
`workflow_plans` 四表删除。`workflow_runs` 保留（实例书签，非实体）。
项目既有策略：无历史迁移，旧库需重建（verifyCurrentSchema 同步更新）。

```sql
-- tasks 新增列
type            TEXT NOT NULL DEFAULT 'task',   -- task | session | workflow
-- 会话字段（type=session）
worktree_path   TEXT NOT NULL DEFAULT '',       -- 会话 worktree（非 git/无项目时）
session_dir     TEXT NOT NULL DEFAULT '',       -- pi 会话文件目录
last_message_at TEXT NOT NULL DEFAULT '',
message_count   INTEGER NOT NULL DEFAULT 0,
suspended_at    TEXT,
delivered_at    TEXT,
-- 定时字段（正交属性，任何 type）
cron            TEXT NOT NULL DEFAULT '',       -- '' = 非定时
enabled         INTEGER NOT NULL DEFAULT 1,     -- 定时启停（cron='' 时忽略）
last_run_at     TEXT,
next_run_at     TEXT,
-- 工作流字段（type=workflow）
spec            TEXT NOT NULL DEFAULT '',       -- workflow.Spec JSON
violations      TEXT NOT NULL DEFAULT '[]',     -- 校验结果 JSON
spec_hash       TEXT NOT NULL DEFAULT ''        -- 创建/编辑时写入（内容寻址版本标记）
```

- `sessions.runtime_id` / `sessions.task_id` 删除：前者可由 Role 推导，后者
  通过 `tasks.session_id` 反查。
- 原 `schedule_id` 列保留（无 FK，语义不变：指向定义任务 id）。
- `workflow_runs.plan_id` 改名 `workflow_id`，引用 `tasks(id)`。

## 4. 状态机（单 status 列，按 type 解释）

| type | 状态 | 说明 |
|---|---|---|
| task | queued → claimed → running → awaiting_review → succeeded/failed/cancelled | 不变；定时定义保持 queued 但被认领过滤排除 |
| session | created → active ⇄ suspended → delivered → deleted | 不变（session 包白名单）；交付仍创建 type=task 的收编任务（session_id 回链） |
| workflow | adopted（定义已就绪，可编辑） | 创建与每次编辑都同步策略校验（spec_hash + revision 保护），可被多次 run；存量 proposed/validated/rejected 为旧版遗留，不可启动 |

`tasks` 状态转换校验按 type 分派：task 走 `TaskLifecycle.CanTransition`，
session 走 `session.CanTransition`，workflow 创建/编辑即校验、启动走
`WorkflowService.StartPlan`。status 列无 DB CHECK。

## 5. API 变更

URL 面尽量保留（前端路由不变），语义全部指向统一 tasks：

| 现有 | 变更 |
|---|---|
| GET/POST /tasks | 支持 `?type=` / `?scheduled=1` 过滤；POST body 支持 type + 形态字段 + cron |
| /sessions/*（start/resume/suspend/prompt/deliver/abort/ask/command/transcript） | 路径保留，读写 type=session 的任务 |
| /workflows（POST 创建；GET 列表）、/workflows/{id}（GET/PUT/DELETE）、/workflows/{id}/runs（GET/POST 启动 Run）、/workflow-runs/{id} | 路径保留，读写 type=workflow 的任务与 Run |
| /schedules/* | **删除**；定时页改走 /tasks?scheduled=1，CRUD 走 /tasks（创建带 cron；PATCH 改 cron/enabled；DELETE 删定义） |

openapi.yaml 同步：Task schema 加 type/定时/会话/工作流字段，
Schedule/Proposal/Plan schema 移除。

## 6. 关键实现点

- **store**：`Task` 结构体加字段；`taskCols`/`scanTask` 扩展；
  `TaskFilter` 加 `Type`/`ExcludeScheduled`；会话查询函数改为
  `ListTasksFiltered(Type=session)`；`CreateSession` →
  `CreateTask(type=session)`；工作流创建/编辑/启动 Run/实例化改为读写 tasks。
- **session manager**：`store.Session` 引用换成 `store.Task`；
  `Create`/`Get`/`List` 走统一查询；状态读写走 `tasks.status`；
  `Deliver` 不变（收编任务 + 合并链）。
- **workflow**：`Proposal`/`Plan` 折叠为任务的 status + spec + violations +
  spec_hash；`Run` 保留（workflow_runs 表）；`InstantiateWorkflow` 从
  adopted 工作流任务创建 run + 子任务（type=task）。
- **sched**：`Scheduler` 读 `tasks WHERE cron != '' AND enabled=1`；
  `scheduleJob.Run` 按 type 分支实例化；需要注入 session manager 与
  workflow service。
- **events**：事件类型区分形态（如 `session.updated` → 任务事件携带
  type），前端按 type 路由刷新。
- **统计**：所有 tasks 计数查询加 `t.cron=''`（定义任务不计入执行统计）。

## 7. 阶段

1. 设计文档 + CONTEXT.md（本文）
2. store 层：schema + Task 模型 + 查询统一
3. session manager 统一
4. workflow service 统一
5. sched 调度器三类型触发
6. server handlers + openapi
7. 前端 types/api + 统一创建对话框 + 四页面 + 详情页分支
8. 测试修复 + go test + 前端 build + 浏览器验证
