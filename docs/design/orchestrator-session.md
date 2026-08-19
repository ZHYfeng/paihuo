# 编排者会话（Orchestrator Session）

> 状态：v1 已实现（后端 + 平台工具面 + Pi 适配扩展 + 树状视图）。
> 术语遵循 `CONTEXT.md` 领域语言。
> 本设计回答：如何让一个 agent 承担「拆分 → 创建 → 跟进 → 按结果动态派活」的
> 编排职责，同时保留 PaiHuo 的隔离执行、板上可见性与自动 worktree/合并机制。

## 1. 目标与问题

现状：PaiHuo 的使用者是**人**。拆分任务、创建任务、跟进、验收、按完成情况动态
创建新任务——整条编排都由人手工完成；平台只负责隔离执行、日志、审批与合并。

目标：让一个 **agent 顶替人的编排角色**，完成更大更复杂的事。拆分的主要动机是
**隔离上下文、节省 token**（每个子任务独立上下文）。

agent 内部 subagent 也能隔离上下文与省 token，但有两条硬伤，本设计要同时解决：

| 痛点 | 解法 |
|---|---|
| 人看不到 subagent 的进展 | 派生子任务是板上真实任务：状态、SSE 日志、worktree、审批闸口全部在 PaiHuo 呈现 |
| 每次要人交代 worktree / 合并等工程琐事 | 平台自动处理：子任务落到目标项目 worktree，交付 → 审批 → 自动合并链照旧，编排者只陈述目标 |

## 2. 形态定位

```
人 ──创建──► 编排者会话(Session, Role 带 delegation) ──MCP spawn──► 真任务(子任务)
                 ▲   ▲                                            │
                 │   └── await_tasks / get_task_result(摘要) ◄─────┘
                 └─ 结果摘要作为新一轮输入 → 再拆分/修复/收尾 ──► 动态派发更多子任务
```

- **编排者会话**：`type=session`，多轮常驻进程，用 Pi 的 RPC 通道驱动，可挂起/恢复。
- **编排者 Role = 新建专用角色**（职责是规划而非干活，便于单独约束其权限并打开
  `delegation`）；**子任务一律复用已有 Role** 执行具体工作。
- **树状视图 = v1 必做**（是第 1 条核心价值「进度可见」的载体）：把编排者会话与其
  自任务树聚合，一张图看整棵任务树与状态。
- **派生子任务**：通过平台工具创建的真实任务，可跨项目、跨角色，复用现有全部机制
  （worktree 隔离、独立上下文、SSE 日志、终态、交付/审批/合并）。
- **委托是 Role 约束**：`delegation`（开关 + 子任务最大 perm）挂在 Role 上，不是
  Runtime 能力——与「Role 表达责任与执行约束」一致。只有声明了 delegation 的会话
  角色才允许派活。

## 3. 工具面（PaiHuo 内置 MCP server）

平台暴露一组任务管理工具，供运行中的编排者 agent 调用。**工具面是协议无关的
平台服务，一次实现，各 Runtime 用自己的适配器接入。**

实现现状：工具面以 **MCP over HTTP**（JSON-RPC 2.0，`POST /api/v1/mcp`，
Bearer 令牌）提供服务，工具语义即本文档表格。Pi/omp 会话是 v1 唯一的编排者
宿主；**Pi 0.84 无原生 MCP**（官方明确「No MCP」），因此 Pi 侧适配器是官方
扩展机制（`extensions/paihuo-orchestrator`）：注册同样的 5 个工具、把每次调用
转发到该端点。扩展是**薄传输层**——权限面、子树隔离等安全不变量全在平台侧，
任何 MCP 能力的 Runtime（codex/dsh）可直接把 mcp config 指向该端点接入。

| 工具 | 语义 |
|---|---|
| `spawn_task(..., sync=false, sync_timeout_seconds?)` | 创建真任务，复用目标的 Role、落入项目 worktree、上板可见、走既有交付/审批/合并链。**异步（默认）**立即返回 task_id + 回执，可并行扇出，之后 `await_tasks` 轮询；**同步（sync=true）**创建后阻塞到停止点（终态或待人工审批）并直接返回结果摘要——任务完成后控制权自动交回编排者，无需轮询 |
| `await_tasks(ids, timeout)` | 阻塞到指定任务全部到达停止点（终态或待人工审批），返回每个的结果摘要；超时返回当前进度 + `timed_out` |
| `list_children(parent_id?, session_id?)` | 列出自任务树与状态 |
| `get_task_result(task_id)` | 单个结果摘要（终态、交付状态、artifact 引用、简短 summary） |
| `fetch_artifact(artifact_id)` | 按需拉 artifact 内容（受控注入，默认只回摘要/引用；默认 256KB、上限 1MB） |
| `spawn_workflow_run(workflow_id, project, task)`（v2） | 派发一个 Workflow Run，原子实例化节点任务 |

## 4. 执行模型：异步并行 + 结果反馈环（同步/异步两种派活）

编排者的主循环有两种派活方式，由 `spawn_task(sync)` 决定：

- **同步（sync=true）**：创建子任务后平台**阻塞到停止点**，把结果摘要直接返回给
  编排者——任务完成/合并即自动交回控制权（无需轮询），编排者在本轮收到的就是最终
  结果，继续下一步。适合「等我结果再决定」的串行步骤。超时返回当前进度 + `timed_out`，
  编排者可再 `await_tasks` 续等。
- **异步（sync=false，默认）**：立即返回回执，子任务并行跑；编排者用 `await_tasks`
  主动轮询。适合并行扇出。异步任务**不做后台推送**——完成后是否继续全凭编排者主动
  轮询，避免静默打断其当前回合。

同步 / 异步是**每任务调用时的选择**，同一批可混用。上下文控制不变量：**只向编排者
注入摘要与 artifact 引用，不灌原始日志**；编排者按需 `fetch_artifact`。这是"隔离"
收益的核心，防止编排者上下文被撑爆。

**await_tasks / 同步等待的停止点语义**：终态（succeeded/failed/cancelled）**或
待人工审批**（`awaiting_review`）都算停止点并返回——审批闸口永远握在人类手里，
拒绝让编排者无谓地阻塞或自我审批；待审任务作为状态返回，编排者据此决定继续等或
派别的活。超时返回当前进度 + `timed_out=true`。

## 5. 权限、审批与交付（不变量）

- **缺省无审批**：full 上限的编排者，spawn 缺省 `perm=full` → 普通子任务免审批、
  完成后自动合并/交付；只有显式 `perm=review`（或编排者上限为 review 时）才走人工审批。
- **无提权**：每个子任务的 perm ≤ 编排者 Role 的 `delegation.max_perm`（在平台
  侧 spawn 时强制，调用方无法伪造）。
- **无改动 = 跳过合并任务，审批仍保留**：判定子任务分支与主 HEAD 无差异时，不再
  创建空合并任务节点——但 `review` 任务**仍走人工审批**（审批与合并是两个独立的事）。
  命中时置 `merge_skipped=1`：交付直接终态、自动补建合并任务的对账集合也排除它。
- **机密读取面 = 会话子树**：get_task_result / await_tasks / fetch_artifact 只允许
  读取本会话名下（`parent_session_id` 指向自己）的任务与 artifact；树外不可见。
- **审批门禁不绕过**：含危险动作（`full_permission` / `install_runtime` /
  `arbitrary_host_path` / `merge_workspace` / `delete_workspace`）的子任务只进待审批
  面，**人工批准后才执行/合并**；编排者不能审批自己的子任务。危险活的闸口永远握在
  人手里，普通活可全自动。
- 编排者 Role 若要派 full 子任务，必须自身声明相应能力；子任务仍受上述人工审批。

## 6. 进度可见性

- 子任务 = 板上真实任务，状态/日志/worktree/审批在原任务面全部可见；
- 编排者会话在会话页可见、可挂起/恢复/交付；
- **编排者视图（v1 必做）**：把父会话与其子树聚合，按父子关系展示整棵任务树与各节点状态。

## 7. Schema 变更

`tasks` 增加可空列：

```sql
parent_session_id INTEGER REFERENCES tasks(id), -- 指向编排者会话任务 id（type=session，树的根）
parent_task_id     INTEGER REFERENCES tasks(id), -- 指向派生子任务（子任务再派活的链）
```

索引：`idx_tasks_parent_session` / `idx_tasks_parent_task`。对新库直接建列；存量库走
幂等 `ALTER TABLE ADD COLUMN`（与 `external_key` 同机制），存量任务为 NULL。
`roles` 增加 `delegation_enabled`（默认 0）与 `delegation_max_perm`（默认 `review`）；
`tasks` 另含 `merge_skipped`（默认 0，判定无改动后跳过合并任务）。
按项目既有策略**无历史迁移**：schema 变化时重建数据库（保留 token.env 与 skills/）。

v1 语义：只有编排者会话调用平台工具，因此派生子任务的 **两个父列都指向会话**
（树的根）。`parent_task_id` 列保留「子任务再派活的链」能力（未来的委托子任务
把它设为自己的 id），当前恒等于会话 id。合并子任务自动继承父链（见
`NewMergeTask`），保证树上完整。

## 8. 为什么不用 LangGraph

概念上，编排者 = LangGraph 擅长的"父级监督 + 条件派发 + 状态传递"模式。但**不引入**，
理由与既有决策「自研薄 DAG 而非 LangGraph/Argo/Temporal」「LLM 动态路由放 Session 内」
一致：

- 编排是自由多轮会话，图是**涌现的**（由结果在运行时决定），不是代码预定义的图；
  LangGraph 的价值（确定性、可测试、checkpoint 图）与这个需求冲突。
- **可信状态 = PaiHuo 任务树**（SQLite 持久、板上审计、带审批）。LangGraph checkpoint
  是另一套旁路状态，落在 PaiHuo 审计/审批模型之外。
- LangGraph 是独立运行时，要宿主编排者、桥接 PaiHuo API、处理 tmux/进程，与
  单 Go 二进制 + 平台驱动进程的架构对抗。
- 分工：**Workflow = 静态层**（确定性多智能体，创建时声明）；**编排者会话 = 动态层**
  （涌现多智能体，运行时决定）。两层都是平台自研，各司其职。
- 借用 LangGraph 的概念做设计词汇（父级监督、条件派发、状态传递），不当依赖。

## 8.5 落地要点（v1 操作手册）

1. **安装 Pi 适配扩展一次**：`pi install <repo>/extensions/paihuo-orchestrator`
   （或 Web 管理页 → 扩展 tab）。
2. **创建编排者 Role**：Runtime=pi，把 `delegation` 打开，选子任务最大权限
   （默认 `review` 最保守；`full` 时普通活全自动、危险活仍人工审批）；在角色
   的扩展字段里勾上 paihuo-orchestrator。职责与拆活规则写进 `system_prompt`。
3. **建会话**选该角色即可：spawn 的子任务是板上真实任务（worktree、SSE 日志、
   终态、交付/审批/合并链全部照旧），会话详情页出现**编排者树状视图**，会话
   列表对该角色+启用委托的会话打「编排者」标。
4. v1 只支持 pi/omp 会话做编排者（我们控制其进程环境，可注入工具面端点与令牌）；
   dsh 会话的 agent 进程不由平台派生，委托注入列入 v2。
5. 子任务 v1 只支持 batch（交互式无终端归属，直接拒绝而非静默改写）。

## 9. 阶段

1. **v1 最小端到端 ✅（已实现）**：新建编排者 Role（带 `delegation`）→ 平台工具面
   MCP over HTTP（spawn/await/list/result + fetch_artifact）→ Pi 适配扩展 → 一个 Pi
   编排者会话 → 子任务复用已有 Role、上板、危险活人工审批 → 同步/并行 await →
   结果反馈再派发 → **编排者树状视图**（会话详情页）。整条「拆分 → 执行 → 验收 →
   动态派活」链路已端到端跑通。
2. **v2**：dsh 会话委托注入、`spawn_workflow_run`、信任白名单（项目 × 角色两级，
   白名单内免人工审批）、多编排者、任务完成事件推送（省轮询）、fetch_artifact
   二进制/流式增强。

## 10. 已定决策

- 编排者 = **新建专用 Role**（带 `delegation`，职责是规划）；子任务复用已有 Role。
- 树状视图 = v1 必做（进度可见性的载体）。
- **工具面协议 = MCP over HTTP（JSON-RPC 2.0, Bearer），平台一次实现、Runtime 各配适配器**。
  Pi 0.84 实测无原生 MCP，Pi 侧用官方扩展注册同样 5 个工具并转发到端点（薄传输层，
  安全不变量全在平台侧）；任何 MCP 能力 Runtime 可直接接入同一端点。
- **delegation 双字段**：`delegation_enabled` + `delegation_max_perm`（full/review，
  缺省 review），放 Role 表而非 role_config，也不作为 Runtime 能力声明——与「Role
  表达责任与执行约束」一致。关闭委托 = 零注入、零工具。
- **令牌无状态**：`HMAC(secret, "session:<id>")`，secret 常驻 `settings.mcp_auth_secret`
  （首次解析写库，跨重启稳定）；只在委托会话进程注入
  `PAIHUO_MCP_URL` / `PAIHUO_MCP_TOKEN` / `PAIHUO_SESSION_ID`。
- **同步 / 异步派活**：`spawn_task(sync)` 每任务可选。默认异步=返回回执+`await_tasks`
  轮询；同步=平台阻塞到停止点、把结果直接返回（任务完成即自动交回控制权，无需轮询）。
  异步**不做后台推送**（避免静默打断编排者当前回合），要结果必须主动轮询。
  同步解决了「编排者在收到完成/合并后不再继续」的体感——停止点是决定，不是失控。
- **缺省无审批**：full 上限编排者的 spawn 缺省 `perm=full`，普通子任务免审批自动合
  并/交付；只有显式 review（或上限为 review）才人工审批。
- **无改动 = 跳过合并任务，审批仍保留**：`merge_skipped=1` 时直接交付终态、排除在
  自动补建合并集合外；`review` 任务仍走人工审批——「审批」与「合并」是两个独立的事。
- **await 停止点**：终态或 `awaiting_review` 即返回；超时返回进度 + `timed_out`。
- **子任务 v1 只批处理**：interactive 直接拒绝（不静默改写），避免编排者误判。
- **无提权在平台侧强制**：spawn 时检验 perm ≤ delegation 上限；读面收口到会话子树。
- **MCP 端点在鉴权链上豁免浏览器 cookie**（自带 Bearer），无访问令牌部署也须出示
  Bearer，不裸奔。
- 交付状态 = `TaskDeliveryResult`（git 项目含合并落盘）进结果摘要；artifact 只回
  引用，`fetch_artifact` 按需拉且限量（256KB 默认 / 1MB 上限）。
