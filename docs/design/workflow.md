# PaiHuo 工作流总览（端到端）

> 本文件描述系统全部工作流，从创建到终态。术语遵循 `CONTEXT.md` 领域语言。

## 1. 主线：一条路

整个系统的叙事只有一条路：

```
项目 → 创建任务 → 执行 → 审批
```

- **项目**：工作边界，绑定目录与历史，提供隔离与合并语义。
- **创建任务**：四种形态，见 §2。
- **执行**：由 Agent Runtime 承担，受角色约束，见 §4。
- **审批**：路上的一道闸口，不是第五种任务，见 §5。

所有管理功能都是这条路的**支撑设施**，见 §6。系统没有并列的"任务流"和
"工作流"两套概念——只有一种实体 **Task**。

## 2. 任务的四种形态

| 形态 | 当前实现 | 特征 |
|---|---|---|
| **单任务** | batch Task | 一个 Role 执行一次，后台跑完，日常主力 |
| **复合任务** | Workflow | 带编排 spec（节点 + 依赖边）的 Task，实例化为子任务树，状态聚合 |
| **自由探索任务** | Session（interactive） | 持久多轮协作，可挂起/恢复，产出后交付为 Task |
| **定时任务** | Schedule | cron 触发，渲染模板生成单任务，后续走同一生命周期 |

形态是创建方式的差异；创建之后全部汇入同一条 Task 生命周期（§3）。
review 不是第五种形态，是任何形态执行后都可能经过的审批闸口。

## 3. Task 生命周期（状态机）

```
                     ┌──────────────┐
  创建 ────────────► │   queued     │◄──────────────┐
                     └──────┬───────┘               │
              claim（Executor）│                retry/resume
                     ┌──────▼───────┐               │
                     │   claimed    │──取消──► cancelled
                     └──────┬───────┘               │
                     ┌──────▼───────┐               │
                     │   running    │──取消──► cancelled
                     └──────┬───────┘               │
             ┌──────────────┼──────────────┐        │
             │ perm=full    │ perm=review  │        │
     ┌───────▼──────┐  ┌────▼──────────┐   │        │
     │  succeeded   │  │awaiting_review│───┤        │
     └──────┬───────┘  └──┬─────────┬──┘   │        │
            │             │approve  │reject│        │
            │      ┌──────▼───────┐ │      │        │
            │      │  succeeded   │ │      │        │
            │      └──────┬───────┘ │      │        │
            │             │         ▼      ▼        │
            │             │      cancelled cancelled │
            ▼             ▼                          │
        ──失败──► failed ────────────────────────────┘
```

- 自动转换由 Executor 驱动：`queued → claimed → running → 终态`；
  重启后 `recoverInterrupted` 恢复存活 tmux 窗口并标记中断任务。
- 手动转换（API/人工）：`queued/claimed/running → cancelled`，
  `awaiting_review → queued(打回重做) | succeeded(批准) | cancelled(拒绝)`，
  `succeeded/failed/cancelled → queued`（重试/重跑）。
- 转换全部带 revision 冲突保护与幂等键。

## 4. 执行层

```
Task ──► Role（指令/模型/并发/技能选择）──► Runtime（Pi/OMP/OpenCode/Claude Code/Codex）
           │                                      │
           └── Skills 挂载（sessionsRoot/.roles/） ┘
                      │
                      ▼
  专用 tmux -L paihuo 执行；Git 项目独占 worktree sessions/<project>/task-<id>
  日志 SSE 实时推送并持久化；重启接管存活窗口，丢失窗口标记 interrupted
```

- **Role 与 CLI 解耦**：Role 只声明能力要求，Runtime 按 capability（batch 等）
  匹配，可替换执行提供者。
- **Skills**：角色保存技能选择，执行时平台物化挂载；目录位于 worktree 之外，
  不会提交进项目。
- **依赖**：none / weak（自动前置，失败可跳过）/ strong（失败阻塞）；
  Git 任务的 delivery 延伸到 merge 子任务终态（代码已整合才算交付）。

## 5. 审批闸口

审批是主线上的一道闸口，两类触发点聚合在同一个"待审批"概念下：

| 触发点 | 审批什么 | 动作 |
|---|---|---|
| review 任务执行完毕 | 交付成果可否进入整合 | 批准 → succeeded + 自动建 merge；拒绝 → cancelled；打回 → queued |
| Workflow Proposal 校验通过 | 冻结的 Plan 可否启动 | 采纳 → 冻结；拒绝 → 修改重提 |

危险动作（install_runtime、arbitrary_host_path、full_permission、
merge_workspace、delete_workspace）在 Proposal 校验期强制要求人工审批声明。

## 6. 管理面（支撑设施）

主线的每一步都由对应管理功能支撑：

| 设施 | 页面 | 职责 |
|---|---|---|
| 项目管理 | Projects | 目录绑定、worktree 隔离、历史 |
| 任务管理 | 工作台/任务/历史 | 状态机、依赖、重试、取消、日志 |
| Agent Runtime | Runtimes | 五种 runtime 安装/探测/capability |
| 角色和技能 | Roles / 技能 | Role 指令与约束；SKILL.md 导入与挂载 |
| Pi 扩展 | 技能页 Pi 扩展 tab | 安装/移除 Pi 扩展 |
| 模板 | 模板 | 调度模板 + MCP 任务创建模板 |
| Workflow 管理 | Workflows | Proposal/Plan/Run 全生命周期 |
| 审批 | 工作台待审批聚合 | 所有 awaiting_review 与采纳请求集中出现 |

## 7. 设计决策

- **一条路，一个实体**：Task 是唯一实体，四种形态是创建方式差异；
  Proposal/Plan/Run 是复合任务的采纳门禁与历史，不是另一类实体。
- **路由层保持确定性**：跨角色任务路由（复合任务的依赖图）是平台职责，
  必须可静态校验、可审计、可重放；LLM 动态路由放在自由探索任务内部
  （runtime 职责）。
- **审批是闸口不是形态**：任何任务形态都可能经过审批，统一聚合在待审批面。
- 自研薄 DAG 而非引入编排框架（LangGraph/Argo/Temporal）：当前需求
  （声明式 DAG + 策略门禁 + 原子实例化）只需 ~200 行；引入框架不解决
  Executor/worktree/审批等真正的重活。若未来需要动态分支，优先加"条件边"。
